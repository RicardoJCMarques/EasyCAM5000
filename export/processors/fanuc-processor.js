/*!
 * @file        export/processors/fanuc-processor.js
 * @description Fanuc variant post-processing main logic module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  /**
   * Fanuc Post-Processor
   *
   * Targets Fanuc 0i-MF / 30i-class machining centres and the many
   * controls that clone their dialect.
   *
   * Differences from the GRBL-family posts that drive the overrides below:
   *  DECIMAL POINTS ARE MANDATORY on dimensional words. A value with no
   *   point is read in least-input increments: X1 means 0.001mm, not 1mm.
   *   This is the single most destructive Fanuc formatting trap, and the
   *   base formatters strip trailing zeros ("1"), so every dimensional
   *   formatter is wrapped.
   *  Programs are delimited by '%' and must open with an O-number.
   *  Comments are parenthesised, cannot nest, and reject characters
   *   outside the control's set.
   *  G04 P is MILLISECONDS (integer, no decimal point).
   *  Modal state SURVIVES program end: the safe-start block must clear
   *   comp and cycles (G40 G49 G80) rather than assume a clean control.
   *  Retracts use G91 G28 (machine coordinates): a G90 G0 Z is relative
   *   to the active work offset and can drive into the part.
   *
   * Not implemented (the control supports them; EasyShape5000 has no
   * geometry that produces them yet):
   *  G07.1 / G107 cylindrical interpolation. This is the 'cyl-interp'
   *   route: the post would emit Cartesian X/Y and the CONTROL wraps,
   *   needing an activation block carrying the cylinder radius. It is
   *   deliberately absent from rotary.routes - declaring it would let the
   *   UI select a route that emits no activation block, which moves the
   *   linear axis instead of rotating. Leave it out until it is written.
   *  G43.4 / G43.5 TCPC. Only meaningful once tool-orientation vectors
   *   exist; the rotary pipeline emits tool-tip positions, not vectors.
   *  G12.1 / G13.1 polar interpolation (mill-turn face work).
   *  G41/G42 cutter comp: all offsetting is done in CAM.
   */

  const ROOT = globalThis;

  class FanucPostProcessor extends BasePostProcessor {
    static parameters = [
      {
        name: 'fanucProgramNumber',
        type: 'number',
        category: 'machine',
        default: 1000,
        min: 1,
        max: 9999,
        step: 1
      },
      {
        name: 'fanucProgramName',
        type: 'text',
        category: 'machine',
        default: ''
      },
      {
        name: 'fanucWorkOffset',
        type: 'select',
        category: 'machine',
        options: [
          { value: 'G54' }, { value: 'G55' },
          { value: 'G56' }, { value: 'G57' },
          { value: 'G58' }, { value: 'G59' }
        ],
        default: 'G54',
      },
      {
        name: 'fanucRotaryUnwind',
        type: 'select',
        category: 'machine',
        options: [{ value: 'none' }, { value: 'g92' }, { value: 'g28' }],
        default: 'none',
      },
      ...BasePostProcessor.parameters,
    ];

    constructor(setup) {
      super(setup);
      // Where the next G43 H comes down to: the program's first safe
      // height (generateHeader), then the height before each G28 retract.
      this.changeZ = null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Formatting - the decimal-point rule
    // ────────────────────────────────────────────────────────────────────

    /**
     * Appends a decimal point when the base formatter stripped it.
     * Applied ONLY to dimensional words (X Y Z A B C I J K R Q F).
     * Address words (N O T S M G H D L, and G04's P in ms) must stay
     * integers - 'T01.' and 'S12000.' are syntax errors.
     */
    _pt(text) {
      if (text === '' || text === null || text === undefined) return text;
      return text.indexOf('.') >= 0 ? text : text + '.';
    }

    formatCoordinate(value) {
      return this._pt(super.formatCoordinate(value));
    }

    formatAngle(value) {
      return this._pt(super.formatAngle(value));
    }

    formatFeed(value, inverseTime = false) {
      return this._pt(super.formatFeed(value, inverseTime));
    }

    // ────────────────────────────────────────────────────────────────────
    // Program structure
    // ────────────────────────────────────────────────────────────────────

    generateHeader(options) {
      const lines = [];
      // Tape start + O-number. The control rejects a program that has
      // neither; DNC drip-feed needs the '%' specifically.
      lines.push('%');
      const prog = Math.min(9999, Math.max(1, Math.round(options.fanucProgramNumber)));
      const name = this.sanitizeComment(options.fanucProgramName.toUpperCase());
      lines.push(`O${String(prog).padStart(4, '0')}${name ? ` (${name})` : ''}`);
      if (this.pushCommentBlock(lines, options)) lines.push('');
      this.setUnits(options);
      // G20/G21 in a block of its own, before anything sets coordinates.
      lines.push(this.modalState.units);
      // Safe start. Fanuc keeps modal state ACROSS program ends, so a
      // stale G41/G43/G81 from whatever ran last is live until cleared.
      lines.push(`${this.modalState.coordinateMode} ${this.modalState.plane} G40 G49 G80`);
      lines.push(`${this.modalState.feedRateMode} ${options.fanucWorkOffset}`);
      lines.push('');
      const startCode = this.startBlock(options);
      if (startCode.trim()) lines.push(startCode);
      const vacuum = this.vacuumOn(options, startCode);
      if (vacuum) lines.push(vacuum);
      // The first tool's G43 comes down before anything has moved: to
      // the program's first safe height.
      this.changeZ = options.startZ;
      return lines.join('\n');
    }

    generateFooter(options) {
      const endCode = this.endBlock(options);
      const lines = ['', ...this.peripheralsOff(options, endCode)];
      // Machine-coordinate park. G91 G28 is the only retract that is
      // independent of the active work offset.
      lines.push(this.appendComment('G91 G28 Z0.', 'comments.retractSafeZ', options));
      lines.push('G28 X0. Y0.');
      // Rotary end position. Accumulated A can reach tens of thousands
      // of degrees on a spiral finish, so G28 (which unwinds every one
      // of them) is opt-in, not default. G92 zeroes in place with no
      // motion but shifts the offset for whatever runs next.
      // rotaryWordUsed, not rotaryAxisWord: the latter is per-plan and
      // is null by the time the footer runs (the trailing retract plan
      // carries no rotary metadata).
      const word = this.rotaryWordUsed;
      const unwind = options.fanucRotaryUnwind;
      if (word && unwind !== 'none' && this.currentPosition.a) {
        lines.push(unwind === 'g28'
          ? this.appendComment(`G28 ${word}0.`, 'comments.fanuc.rotaryUnwind', options)
          : this.appendComment(`G92 ${word}0.`, 'comments.fanuc.rotaryZero', options));
        this.currentPosition.a = 0;
      }
      lines.push('G90');
      if (endCode.trim()) lines.push(endCode);
      lines.push(...this.programEnd(endCode), '%');
      return lines.join('\n');
    }

    /**
     * None: M10/M11 are machine-builder codes on Fanuc-class controls,
     * often the 4th-axis brake.
     */
    vacuumWords() {
      return null;
    }

    // G40 G80 cancel comp and any live cycle
    // G91 G28 Z0. retract in MACHINE Z, clear of the part and independent
    // of the active work offset
    // G90 G49 drop the OLD tool's length offset BEFORE the swap - a
    // live H with the wrong tool in the spindle is the
    // classic Z crash
    toolChangeRetract(options) {
      // The swap's G43 comes back down to where the program stood, and
      // never below safe Z.
      this.changeZ = this.above(options.safeZ);
      // G28 parks Z in MACHINE coordinates, which has no work-frame value
      // to record. null forces _motionCoords to re-emit Z on the next
      // move; a stale number silently suppresses it.
      this.currentPosition.z = null;
      return ['G40 G80', this.appendComment('G91 G28 Z0.', 'comments.retractSafeZ', options), 'G90 G49'];
    }

    toolChangeSwap(toolNumber, options) {
      const mode = options.toolLengthCompMode;
      const tn = String(toolNumber).padStart(2, '0');
      const lines = [];
      // 'table-implicit': G43 rides the change block and the control takes
      // H from the active T - no H word anywhere in the program.
      lines.push(mode === 'table-implicit' ? this.appendComment(`T${tn} M06 G43`, 'comments.toolLengthComp', options) : `T${tn} M06`);
      if (mode === 'table') {
        // Apply the NEW offset on the way down. Track the REAL number:
        // currentPosition is compared numerically in generateRapid /
        // generateLinear, and a formatted string makes every Math.abs()
        // NaN, which silently suppresses the next Z word.
        lines.push(this.appendComment(`G43 H${tn} Z${this.formatZ(this.changeZ)}`, 'comments.toolLengthComp', options));
        this.currentPosition.z = this.changeZ;
      }
      return lines;
    }
  }

  ROOT.PostLogic.set('fanuc', FanucPostProcessor);
})();