/*!
 * @file        export/processors/winpcnc-processor.js
 * @description WinPC-NC (DIN/ISO interpreter) post-processing main logic module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';
  const ROOT = globalThis;

  /**
   * WinPC-NC Post-Processor
   *
   * Targets the DIN/ISO command interpreter in Lewetz WinPC-NC (USB /
   * Professional, plus the OEM builds shipped with ISEL, Haase and Stepcraft
   * machines). ISEL's own NCP language (IMF_PBL / FASTABS / MOVEABS /
   * GETTOOL) is a DIFFERENT language and is not what this post emits - an
   * ISEL machine must be running WinPC-NC or Remote, not ProNC in native
   * mode.
   *
   * Structurally this is a Fanuc-family post - '%'-delimited program,
   * mandatory T/M6, non-nesting parenthesised comments, N-numbering - so it
   * overrides the same methods as fanuc-processor.js. The CONTENTS are
   * largely the inverse, and three Fanuc habits are actively wrong here:
   *  NO mandatory decimal point. Bare integers are native ("Z15", "X50"),
   *   so the '_pt' wrapper must not be carried over.
   *  NO G40 / G43 / G49 / G80 / G98 / G99, no G20 / G21 (units are
   *   G70 / G71), no G93 / G94. G98 means "define subprogram" here.
   *  NO machine-coordinate park. G28 exists but is not Fanuc's
   *   incremental intermediate-point retract; the control's own output
   *   parks with G0 Z<travel> then G0 X0 Y0.
   *
   * Further traps this file guards:
   *  G04 takes SECONDS on F. P is reserved for the G81/G82 dwell (ms).
   *  M10/M11 are not vacuum on this control - Autodesk's post maps them
   *   to laser power. Auxiliary outputs are M70..M77 (HIGH) and the
   *   negative form M-70..M-77 (LOW).
   *  The unit of the F word (mm/min or mm/s) is a WinPC-NC machine
   *   parameter, not a dialect constant.
   *  Comments reach the control as Latin-1 and cannot nest.
   *
   * Not implemented:
   *  Inverted Z output. Some installs count Z positive downwards
   *   (Autodesk defaults to it, RhinoCAM hardcodes it) but the reference
   *   program from the target machine is Z+ up. BasePostProcessor.formatZ
   *   is the seam every Z goes through (it carries the absolute-Z datum
   *   too); the parameter stays absent until a machine needs it.
   *  Canned drilling cycles (see supportsCannedCycles below).
   *  Subprograms (G98 Lx) and cutter compensation (not in the
   *   interpreter).
   *  Work offsets. G54 with coordinates REDEFINES the offset on this
   *   control; only a bare G54 selects one. Emitting the Fanuc form would
   *   silently move the operator's zero.
   */

  const LATIN1_FOLD = {
    'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue',
    'ß': 'ss', 'é': 'e', 'è': 'e', 'ç': 'c', 'ñ': 'n', 'å': 'a', 'ø': 'o'
  };

  class WinPCNCPostProcessor extends BasePostProcessor {
    static parameters = [
      {
        name: 'winpcProgramName',
        type: 'text',
        category: 'machine',
        default: '1'
      },
      {
        name: 'winpcFeedUnit',
        type: 'select',
        category: 'machine',
        options: [{ value: 'mmmin' }, { value: 'mms' }],
        default: 'mmmin',
      },
      {
        name: 'winpcAuxOutput',
        type: 'select',
        category: 'machine',
        options: [
          { value: 'none' },
          { value: '70' },
          { value: '71' },
          { value: '72' },
          { value: '73' }
        ],
        default: 'none',
      },
      ...BasePostProcessor.parameters,
    ];
    constructor(setup) {
      super(setup);
      // Latched in generateHeader, which always runs before any motion.
      this.feedPerSecond = false;
    }
    
    // ────────────────────────────────────────────────────────────────────
    // Formatting
    // ────────────────────────────────────────────────────────────────────

    /**
     * The F word carries mm/min or mm/s depending on a WinPC-NC machine
     * parameter. Two decimals in mm/s: the setup's feedDecimals of 0
     * would round 800 mm/min to F13 instead of F13.33.
     */
    formatFeed(value, inverseTime = false) {
      if (value == null) return '';
      if (!this.feedPerSecond) return super.formatFeed(value, inverseTime);
      return this.formatNumberSafe(value / 60, 2, this.outputScale);
    }

    /**
     * Files reach the control as Latin-1, and the header block carries user file names:
     * spell the German set out rather than lose the letter. The shared table and
     * BasePostProcessor.sanitizeComment take the rest.
     */
    transliterate(text) {
      return super.transliterate(text.replace(/[äöüÄÖÜßéèçñåø]/g, (ch) => LATIN1_FOLD[ch]));
    }
    
    // ────────────────────────────────────────────────────────────────────
    // Program structure
    // ────────────────────────────────────────────────────────────────────

    generateHeader(options) {
      const lines = [];
      const isInch = this.setUnits(options, 'G70', 'G71');
      this.feedPerSecond = options.winpcFeedUnit === 'mms';
      if (this.feedPerSecond && isInch) {
        throw Object.assign(
          new Error('[WinPC-NC] A feed unit of mm/s cannot be combined with inch output. Set the feed unit to mm/min, or switch the G-code units to mm.'),
          {i18n: {key: 'messages.export.winpcFeedUnit'}}
        );
      }
      // Everything above this line is comment text to the interpreter;
      // the program itself starts at the '%'.
      lines.push(`%${this.resolveProgramName(options)}`);
      this.pushCommentBlock(lines, options);
      // Z direction is a per-install WinPC-NC parameter and nothing in the
      // file states which way it counts. Say it out loud.
      this.pushCommentLine(lines, 'comments.winpcnc.zConvention', options);
      lines.push('');
      lines.push(this.modalState.coordinateMode);
      lines.push(this.modalState.units);
      lines.push(this.modalState.plane);
      lines.push('');
      const startCode = this.startBlock(options);
      if (startCode.trim()) lines.push(startCode);
      const vacuum = this.vacuumOn(options, startCode);
      if (vacuum) lines.push(vacuum);
      return lines.join('\n');
    }

    generateFooter(options) {
      const endCode = this.endBlock(options);
      const lines = ['', ...this.peripheralsOff(options, endCode)];
      lines.push(this.appendComment(`G0 Z${this.formatZ(this.above(options.travelZ))}`, 'comments.retractSafeZ', options));
      lines.push('G0 X0 Y0');
      if (endCode.trim()) lines.push(endCode);
      lines.push(...this.programEnd(endCode));
      return lines.join('\n');
    }
    
    // ────────────────────────────────────────────────────────────────────
    // Tool change
    // ────────────────────────────────────────────────────────────────────

    /**
     * Work-coordinate retract, at travel height rather than the feed
     * clearance: the control's own change procedure may jog the machine,
     * and there is no offset-independent park to fall back on.
     */
    toolChangeRetract(options) {
      const z = this.above(options.travelZ);
      this.currentPosition.z = z; // NUMBER: compared with Math.abs()
      return [this.appendComment(`G0 Z${this.formatZ(z)}`, 'comments.retractSafeZ', options)];
    }

    /** No G43: tool lengths live in the control's own tool table. */
    toolChangeSwap(toolNumber, options) {
      return [`T${String(toolNumber).padStart(2, '0')} M6`];
    }
    // ────────────────────────────────────────────────────────────────────
    // Modes
    // ────────────────────────────────────────────────────────────────────

    /**
     * Neither G93 nor G94 is a word this interpreter knows, so the mode is
     * tracked but never emitted. G93 arriving here means a rotary plan was
     * converted to inverse time against a post that declares it cannot -
     * its F values would be read as feed rates.
     */
    setFeedRateMode(mode, options = {}) {
      if (mode === 'G93') throw new Error('[WinPC-NC] Inverse-time feed (G93) is not supported by this control, but a plan reached the post asking for it.');
      super.setFeedRateMode(mode, options);
      return '';
    }

    /** No G80. The modal reset still has to happen. */
    cancelCannedCycle(options) {
      super.cancelCannedCycle(options);
      return '';
    }

    /**
     * The vacuum rides an auxiliary output: M7x sets it, the negative M-7x
     * clears it.
     */
    vacuumWords(options) {
      const aux = options.winpcAuxOutput;
      return aux === 'none' ? null : { on: `M${aux}`, off: `M-${aux}` };
    }

    /** The '%' line takes a bare identifier - '%1', '%prog2'. */
    resolveProgramName(options) {
      return String(options.winpcProgramName).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || '1';
    }
  }

  ROOT.PostLogic.set('winpcnc', WinPCNCPostProcessor);
})();