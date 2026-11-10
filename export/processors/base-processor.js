/*!
 * @file        export/processors/base-processor.js
 * @description Base post-processing orchestrator
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

  const PRECISION = ROOT.CAMConfig.constants.precision.coordinate;
  const TRANSLITERATION = ROOT.CAMConfig.constants.commentTransliteration;

  // Whether a block of G-code holds a word: 'M8' finds M8, M08 and m8, never M80.
  const hasWord = (code, word) => {
    const [, letter, number] = /^([A-Z])(-?\d+)$/i.exec(word);
    return new RegExp(`\\b${letter}0*${Number(number)}\\b`, 'i').test(code);
  };

  // Coolant modes and the words that start them; M9 stops either.
  const COOLANT = {
    mist: { word: 'M7', key: 'comments.coolantMist' },
    flood: { word: 'M8', key: 'comments.coolantFlood' }
  };

  /**
   * What a post tells the rest of the app, in one shape for every logic
   * family: BasePostProcessor.describe builds it from a setup and the
   * Roland logic calls it too. Every setup declares every flag, so no key
   * is ever missing and consumers read them directly.
   * @typedef {Object} PostCapabilities
   * @property {boolean} supportsToolChange
   * @property {boolean} emitsInitialTool
   * @property {string[]} toolLengthComp - the modes Machine Settings offers.
   *  'none' emits nothing: the operator re-zeros Z on the new bit.
   *  'table' is G43 H<n> against the control's tool table.
   *  'table-implicit' rides G43 on the change block and the control takes
   *  H from the active T (`T7 M06 G43`, no H word anywhere).
   *  'probe' leaves Z to a controller macro that measures the tool at
   *  change time (Makera MTC, sender touch-off): no G43 at all.
   * @property {boolean} supportsComments
   * @property {boolean} supportsArcCommands
   * @property {boolean} supportsCannedCycles
   * @property {boolean} supportsLineNumbers
   * @property {boolean} supportsUnits
   * @property {boolean} supportsCoolant
   * @property {boolean} supportsAbsoluteZ - the control can run with Z0 fixed on the machine
   * @property {{routes: string[], axisWords: string[], inverseTime: boolean,
   *  maxInverseTime: number, continuous: boolean}} rotary - the 4th axis.
   *  routes - what this post can emit; empty = no 4th axis.
   *   'a-word' A/B in DEGREES, Y dropped. The CAM wraps
   *   (MachineProcessor.convertDevelopedToRotary).
   *   'wrapped-linear' Y KEPT, carrying mm of arc at refRadius: the Y motor
   *   is the rotary (axis replacement, steps/mm calibrated).
   *   'a-linear' A/B carrying mm of arc, Y dropped, for a rotary calibrated
   *   in linear units.
   *   'cyl-interp' is RESERVED (G107 / TRACYL / Cycle 27): it needs an
   *   activation block carrying the cylinder radius, and nothing writes one.
   *  axisWords - the rotary words the machine has: a rotary about X asks
   *  for A, one about Y for B.
   *  inverseTime - G93 exists. Without it mixed linear/rotary feeds are
   *  only honest at the blank surface and run fast at depth.
   *  maxInverseTime - the control's F ceiling under G93. Microscopic
   *  segments overflow past it and hard-alarm.
   *  continuous - unlimited rotary travel. TODO(rotary-indexer) - carried
   *  through context.export, but nothing refuses accumulated A on an
   *  indexer with limited travel yet.
   */
  class BasePostProcessor {
    /**
     * The settings every post owns: the operator's own start and end
     * blocks. They are stored per post, so text written for one control
     * never reaches another's program. A logic with settings of its own
     * lists them before these.
     */
    static parameters = [
      { name: 'startCode', type: 'textarea', rows: 5, category: 'post', default: '' },
      { name: 'endCode', type: 'textarea', rows: 5, category: 'post', default: '' },
    ];

    /** The core/file-validation.json definition a setup for this logic passes. */
    static setupSchema = 'setup-rs274';

    /**
     * @param {Object} setup - an export/processors/*.json file, or a
     *  custom copy, whose logic names this class
     */
    constructor(setup) {
      this.config = setup.flags;
      this.descriptor = BasePostProcessor.describe(setup, this.constructor.parameters);
      // Hot-path cache: generateRapid/generateLinear consult this per
      // command. Also the single source of truth for whether an A word
      // may be emitted at all.
      this.rotaryCaps = this.descriptor.capabilities.rotary;
      this.outputScale = 1.0;
      this.resetState();
    }
    /**
     * The descriptor of a setup: its identity, the capabilities every
     * consumer reads, and what the settings resolver reads - the setup's
     * defaults and locks, and the logic's parameters.
     * @param {Object} setup
     * @param {Object[]} parameters
     * @returns {Object}
     */
    static describe(setup, parameters) {
      const f = setup.flags;
      return {
        id: setup.id,
        label: setup.label,
        logic: setup.logic,
        // A level of devices.maturity.<level> in the language pack, or null once verified.
        maturity: setup.maturity,
        fileExtension: f.fileExtension,
        capabilities: {
          supportsToolChange: f.supportsToolChange,
          emitsInitialTool: f.emitsInitialTool,
          toolLengthComp: f.toolLengthComp,
          supportsComments: f.supportsComments,
          supportsArcCommands: f.supportsArcCommands,
          supportsCannedCycles: f.supportsCannedCycles,
          supportsLineNumbers: f.supportsLineNumbers,
          supportsUnits: f.supportsUnits,
          supportsCoolant: f.supportsCoolant,
          supportsAbsoluteZ: f.supportsAbsoluteZ,
          rotary: f.rotary,
        },
        defaults: setup.defaults,
        locks: setup.locks,
        parameters,
      };
    }

    /**
     * Comment text as a control accepts it: the post's transliterate(),
     * then an NFKD fold to printable ASCII. ! ~ ? are dropped because Grbl
     * reads them as real-time commands even inside a comment, and %
     * because it delimits a tape program. Where comments are
     * parenthesised, ( ) become [ ]: comments cannot nest, and Grbl ends
     * one at the first ')'.
     * @param {string} text
     * @returns {string} '' when nothing printable is left
     */
    sanitizeComment(text) {
      const ascii = this.transliterate(String(text))
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/[!~?%]/g, '');
      const safe = this.config.commentStyle === 'semicolon' ? ascii : ascii.replace(/\(/g, '[').replace(/\)/g, ']');
      return safe.trim();
    }

    /**
     * Spells out what the NFKD fold in sanitizeComment cannot (constants.commentTransliteration):
     * the degree sign, typographic marks, letters such as ß ø ł. Comment text is English
     * (GCodeGenerator.generate), so these arrive in names - a file, an operation, a tool. A post
     * whose control reads more than ASCII overrides it.
     */
    transliterate(text) {
      return Array.from(text, (c) => TRANSLITERATION[c] ?? c).join('');
    }

    /**
     * One worded comment in this processor's dialect, or '' when comments
     * are off or nothing printable is left.
     */
    formatComment(text, options) {
      if (!options.includeComments || !text) return '';
      const clean = this.sanitizeComment(text);
      if (!clean) return '';
      return this.config.commentStyle === 'semicolon' ? `; ${clean}` : `(${clean})`;
    }

    /**
     * Appends the comment for `key` to a G-code line. Keys are read under
     * output.gcode in the language pack ('comments.coolantMist'), through
     * options.text, which GCodeGenerator.generate sets. With comments off
     * the line comes back unchanged.
     * @param {string} line
     * @param {string} key
     * @param {Object} options generator options
     * @param {Object} [values] the key's {tokens}
     */
    appendComment(line, key, options, values = null) {
      if (!options.includeComments) return line;
      const comment = this.formatComment(options.text(key, values), options);
      return comment ? `${line} ${comment}` : line;
    }

    /** Pushes the comment for `key` as a line of its own; nothing with comments off. */
    pushCommentLine(lines, key, options, values = null) {
      if (!options.includeComments) return;
      const comment = this.formatComment(options.text(key, values), options);
      if (comment) lines.push(comment);
    }

    /**
     * Pushes the program's header block (GCodeGenerator.generate words it), one comment per
     * line, leaving out a line that folds to nothing; nothing with comments off.
     * @returns {boolean} whether any line was pushed
     */
    pushCommentBlock(lines, options) {
      if (!options.includeComments || !options.commentBlock) return false;
      const before = lines.length;
      for (const line of options.commentBlock) {
        const comment = this.formatComment(line, options);
        if (comment) lines.push(comment);
      }
      return lines.length > before;
    }

    /**
     * Last chance to clamp a job context to machine limits, called by
     * PipelineContextBuilder.buildPipelineContext just before Object.freeze.
     * The core cannot know which post is loaded, so a `postProcessor === 'x'`
     * test belongs here, never in the core. Mutate ctx in place; the return
     * value is ignored.
     */
    prepareContext(ctx, operation) {}

    generateHeader(options) {
      const headerLines = [];
      if (this.pushCommentBlock(headerLines, options)) headerLines.push('');
      this.setUnits(options);
      // Output all modal commands based on state
      headerLines.push(this.modalState.coordinateMode);
      headerLines.push(this.modalState.units);
      headerLines.push(this.modalState.plane);
      headerLines.push(this.modalState.feedRateMode);
      // Safe-start cancel. A program that applies tool length must also
      // start from a known-cancelled state - the control may still be
      // holding the last program's offset.
      const lengthMode = options.toolLengthCompMode;
      if (lengthMode === 'table' || lengthMode === 'table-implicit') headerLines.push(this.appendComment('G49', 'comments.toolLengthCancel', options));
      headerLines.push('');
      const startCode = this.startBlock(options);
      if (startCode.trim()) headerLines.push(startCode);
      const vacuum = this.vacuumOn(options, startCode);
      if (vacuum) headerLines.push(vacuum);
      return headerLines.join('\n');
    }

    generateFooter(options) {
      const endCode = this.endBlock(options);
      const lines = this.peripheralsOff(options, endCode);
      // Leave the control with no tool length applied, for the same
      // reason the header cancels: the next program must not inherit it.
      const lengthMode = options.toolLengthCompMode;
      if ((lengthMode === 'table' || lengthMode === 'table-implicit') && !hasWord(endCode, 'G49')) lines.push(this.appendComment('G49', 'comments.toolLengthCancel', options));
      lines.push(endCode);
      return lines.join('\n');
    }

    /**
     * Spindle start, stop or speed change, only when the speed changes.
     * The setup's spindle flag names the words: a scaled spindle takes a
     * duty value instead of RPM (Marlin's 0-255 PWM on M106).
     * @param {number} speed - RPM; 0 stops
     * @param {number} [dwell] - seconds to wait after a start
     * @returns {?string} null when nothing changes
     */
    setSpindle(speed, dwell = 0, options = {}) {
      if (speed === this.currentSpindle) return null;
      const { on, off, scale } = this.config.spindle;
      this.currentSpindle = speed;
      if (!(speed > 0)) return this.appendComment(off, 'comments.spindleStop', options);
      let target = speed;
      if (target > this.config.maxSpindleSpeed) {
        // GCodeGenerator reports the highest capped speed once per program.
        this.spindleCapped = Math.max(this.spindleCapped ?? 0, target);
        target = this.config.maxSpindleSpeed;
      }
      const word = scale ? Math.round((target / this.config.maxSpindleSpeed) * scale) : this.formatSpindle(target);
      const lines = [this.appendComment(`${on} S${word}`, 'comments.spindleStart', options)];
      if (dwell > 0) lines.push(this.appendComment(`G4 ${this.config.dwellWord}${this.formatDwell(dwell)}`, 'comments.spindleDwell', options));
      return lines.join('\n');
    }

    /**
     * Declares the tool in the spindle before any motion. NOT a change.
     * Emitted on every job, tool changes on or off: a control with a
     * changer must be TOLD to load the first tool (latching a tracker and
     * emitting nothing ran the first operation with whatever was already in
     * the spindle and whatever length offset was live), and a control
     * without one still refuses motion until a T word arrives.
     * When the post uses M6 this routes through toolChangeSwap so the first
     * load takes the same audited T/M6 + G43 path as every later change -
     * minus the retract and spindle stop, which have no previous tool to
     * protect at program start.
     * A null number means a route that emits no T word - laser and
     * knife/vector never carry one. Router operations always arrive with
     * a number: the profile's `toolNumber` field defaults to 1 and
     * generation is blocked when the operator clears it.
     */
    generateInitialTool(tool, options = {}) {
      // null: no router operation reached the post, so there is no T word.
      if (this.config.emitsInitialTool === false || tool === null) return '';
      const n = tool.number;
      this.currentToolNumber = n;
      const lines = [];
      // A tool without a library record is named by its T word.
      this.pushCommentLine(lines, 'comments.initialTool', options, { name: tool.name ?? `T${n}` });
      this.pushCommentLine(lines, 'comments.toolDiameter', options, { diameter: tool.diameter });
      if (this.config.useM6 && this.config.supportsToolChange) lines.push(...this.toolChangeSwap(n, options));
      else lines.push(this.config.initialToolUsesM6 ? `M6 T${n}` : `T${n}`);
      return lines.join('\n');
    }

    /**
     * Retract before a swap, as a work-coordinate G0. Overridden by posts
     * whose Z is offset-relative (Fanuc: G91 G28 Z0 is the only retract
     * independent of the active work offset and a live TLO).
     * G49 drops the OUTGOING tool's offset before the swap. Without it a
     * control holds the old tool's length while the new one is loaded -
     * the classic Z crash, and the reason real Fanuc safe-start lines read
     * `G40 G17 G80 G49`.
     * @returns {string[]}
     */
    toolChangeRetract(options) {
      const z = this.above(options.safeZ);
      const lines = [this.appendComment(`G0 Z${this.formatZ(z)}`, 'comments.retractSafeZ', options)];
      this.currentPosition.z = z; // NUMBER: currentPosition is compared with Math.abs()
      const lengthMode = options.toolLengthCompMode;
      if (lengthMode === 'table' || lengthMode === 'table-implicit') lines.push(this.appendComment('G49', 'comments.toolLengthCancel', options));
      return lines;
    }

    /**
     * The swap itself plus length compensation. Overridden by posts with
     * proprietary sequences (Makera ATC/MTC).
     * @returns {string[]}
     */
    toolChangeSwap(toolNumber, options) {
      const mode = options.toolLengthCompMode;
      const lines = [];
      if (this.config.useM6) {
        // 'table-implicit': G43 rides the change block and the control
        // takes H from the active T. Real output looks like
        // `T7 M06 G43` with no H word in the whole program.
        lines.push(
          mode === 'table-implicit'
            ? this.appendComment(`T${toolNumber} M06 G43`, 'comments.toolLengthComp', options)
            : `T${toolNumber} M6`,
        );
      }
      if (mode === 'table') lines.push(this.appendComment(`G43 H${toolNumber}`, 'comments.toolLengthComp', options));
      // 'probe' emits nothing here on purpose - the post's macro (Makera
      // M491, a sender touch-off) measures the tool and owns Z. A G43
      // over a probed offset double-applies it.
      return lines;
    }

    /**
     * Full mid-program tool change. Emitted by GCodeGenerator on the FIRST
     * plan of a transition - the connection rapid and the entry plunge
     * carry the incoming tool (MachineProcessor's backward fill), so the
     * swap always precedes any motion with the new cutter.
     */
    generateToolChange(tool, options = {}) {
      if (!this.config.supportsToolChange) return '';
      // GCodeGenerator gates the swap on a number above 0, and null is a route
      // that emits no T word. Symmetric with generateInitialTool.
      const n = tool.number;
      if (n == null) return '';
      const lines = [''];
      this.pushCommentLine(lines, 'comments.toolChange', options, { name: tool.name ?? `T${n}` });
      this.pushCommentLine(lines, 'comments.toolDiameter', options, { diameter: tool.diameter });
      const stop = this.setSpindle(0, 0, options);
      if (stop) lines.push(stop);
      const coolantOff = this.coolantOff(options);
      if (coolantOff) lines.push(coolantOff);
      lines.push(...this.toolChangeRetract(options));
      lines.push(...this.toolChangeSwap(n, options));
      if (this.config.pauseAfterToolChange) lines.push(this.appendComment('M0', 'comments.toolChangePause', options));
      const start = this.setSpindle(tool.spindleSpeed || options.spindleSpeed, tool.spindleDwell || 0, options);
      if (start) lines.push(start);
      const coolantOn = this.coolantOn(options);
      if (coolantOn) lines.push(coolantOn);
      lines.push('');
      this.currentToolNumber = n;
      // Modal cache is a GUESS after a swap. The spindle is re-asserted
      // above, but F is not, and a probe/pause macro (Makera M491, a
      // sender touch-off) runs at its own feed and leaves it modal.
      this.currentFeed = null;
      return lines.join('\n');
    }

    /**
     * Every emitted number passes through here.
     * null/undefined mean the word is absent, which is what an omitted
     * coordinate means everywhere else: the control holds its last value.
     * Non-finite is not that. NaN and Infinity survive every downstream
     * test - `NaN > maxFeed` and `NaN < maxSafeDepth` are both false - and
     * toFixed renders them verbatim, so the word reaches the control as the
     * literal text `NaN`. Drop it and count it; GCodeGenerator refuses the
     * program on a non-zero count, so the drop is never silent.
     */
    formatNumberSafe(value, precision, scale = 1) {
      if (value == null) return '';
      if (!Number.isFinite(value)) {
        this.numericFaults++;
        return '';
      }
      const scaled = value * scale;
      // toFixed clamps precision, parseFloat strips trailing zeros & fixes '-0'
      return precision === 0 ? Math.round(scaled).toString() : parseFloat(scaled.toFixed(precision)).toString();
    }

    formatCoordinate(value) { 
      return this.formatNumberSafe(value, this.config.coordinateDecimals, this.outputScale); 
    }

    /**
     * @param {boolean} [inverseTime] - true when F is a G93 duration
     *        (1/min). Inverse time is dimensionless: G20 must not scale it.
     */
    formatFeed(value, inverseTime = false) {
      return this.formatNumberSafe(value, this.config.feedDecimals, inverseTime ? 1.0 : this.outputScale);
    }

    /**
     * Rotary word formatter. NEVER applies outputScale: an A word is
     * degrees, and G20 must not turn 90° into 3.543. (Under the
     * 'a-linear' route A carries mm of arc, which G20 arguably should
     * scale - but rotary export is gated to metric in
     * GCodeGenerator.generate, so the question doesn't arise. Revisit
     * if inch rotary is ever wired.)
     */
    formatAngle(value) {
      return this.formatNumberSafe(value, this.config.rotaryDecimals, 1.0);
    }

    /**
     * Every Z the program writes, a canned cycle's R plane included. The
     * absolute-Z datum is added here and nowhere else, so currentPosition
     * and every comparison stay in the plan's own frame.
     * TODO(absolute-z) - zDatum is one number per program, set by
     * GCodeGenerator.generate. A program can only mix flat and 4th-axis
     * work on an absolute-Z machine once each plan carries its own frame
     * through the pipeline.
     */
    formatZ(value) {
      return this.formatCoordinate(value + this.zDatum);
    }

    formatSpindle(value) {
      return this.formatNumberSafe(value, this.config.spindleDecimals);
    }

    /** A dwell in the setup's unit: seconds to the millisecond, or whole milliseconds. */
    formatDwell(seconds) {
      return this.config.dwellUnit === 'ms' ? Math.round(seconds * 1000) : parseFloat(seconds.toFixed(3));
    }

    /**
     * Latches the program's units: the modal word and the output scale.
     * @returns {boolean} true for inch
     */
    setUnits(options, inch = 'G20', metric = 'G21') {
      const isInch = options.units === 'inch';
      this.modalState.units = isInch ? inch : metric;
      this.outputScale = isInch ? 1 / 25.4 : 1.0;
      return isInch;
    }

    /**
     * A park height that never takes the tool lower than it stands. The
     * settings measure from the stock top or the bed, but a rotary
     * program's Z is measured from the rotation centerline, where safe Z
     * alone sits inside the blank. A null Z (after a homing move) knows
     * nothing better than z.
     */
    above(z) {
      return Math.max(z, this.currentPosition.z ?? z);
    }

    /** The operator's end block, with {safeZ} and {travelZ} parked through above(). */
    endBlock(options) {
      return options.endCode
        .replace(/{safeZ}/g, this.formatZ(this.above(options.safeZ)))
        .replace(/{travelZ}/g, this.formatZ(this.above(options.travelZ)));
    }

    /** The operator's start block, with {toolNumber} filled in. */
    startBlock(options) {
      return options.startCode.replace(/{toolNumber}/g, options.toolNumber ?? '');
    }

    /**
     * The words that switch the vacuum, or null where the control has none.
     * A post whose control spells them differently overrides.
     * @returns {?{on: string, off: string}}
     */
    vacuumWords(options) {
      return { on: 'M10', off: 'M11' };
    }

    /** Vacuum on at program start, unless the operator's start block switches it. */
    vacuumOn(options, startCode) {
      const vacuum = options.vacuum ? this.vacuumWords(options) : null;
      return vacuum && !hasWord(startCode, vacuum.on) ? this.appendComment(vacuum.on, 'comments.vacuumOn', options) : null;
    }

    /**
     * Coolant on in the setting's mode, after the spindle starts: at program
     * start, where the operator's start block may switch it already, and
     * after every tool change.
     * @param {string} [startCode] - the start block, at program start only
     */
    coolantOn(options, startCode = '') {
      const coolant = COOLANT[options.coolant];
      if (!coolant || hasWord(startCode, 'M7') || hasWord(startCode, 'M8')) return null;
      return this.appendComment(coolant.word, coolant.key, options);
    }

    coolantOff(options) {
      return COOLANT[options.coolant] ? this.appendComment('M9', 'comments.coolantOff', options) : null;
    }

    /**
     * Spindle, coolant and vacuum off at program end, each unless the
     * operator's end block switches it itself.
     * @returns {string[]}
     */
    peripheralsOff(options, endCode) {
      const vacuum = options.vacuum ? this.vacuumWords(options) : null;
      return [
        hasWord(endCode, this.config.spindle.off) ? null : this.setSpindle(0, 0, options),
        hasWord(endCode, 'M9') ? null : this.coolantOff(options),
        vacuum && !hasWord(endCode, vacuum.off) ? this.appendComment(vacuum.off, 'comments.vacuumOff', options) : null
      ].filter(Boolean);
    }

    /*M30, unless the operator's end block already ends the program: a
    second end never runs. For a post whose control needs one; the base
    leaves the end to the end block, since Marlin reads M30 as "delete SD
    file".
    @returns {string[]}*/
    programEnd(endCode) {
      return hasWord(endCode, 'M30') || hasWord(endCode, 'M2') ? [] : ['M30'];
    }

    generateArc(cmd) {
      // GCodeGenerator linearizes arcs for a post without arc support, so one
      // here is a defect: a straight line to its end would cut the chord.
      if (!this.config.supportsArcCommands) throw new Error('[PostProcessor] Arc command reached a post without arc support');
      const gCommand = cmd.type === 'ARC_CW' ? 'G2' : 'G3';
      const isFullCircle = this.isFullCircle(cmd);
      // Determine if G-code command output is needed 
      const needsGCode = !this.config.modalCommands || this.modalState.motionMode !== gCommand || isFullCircle;  // Full circles always need explicit G-code
      // Prepare coordinate outputs
      const coords = [];
      let hasMotion = false;
      // X coordinate
      if (cmd.x !== null && cmd.x !== undefined) {
        const xChanged = Math.abs(cmd.x - this.currentPosition.x) > PRECISION;
        // For full circles or mode changes, always output coordinates
        if (xChanged || needsGCode || isFullCircle) {
          coords.push(`X${this.formatCoordinate(cmd.x)}`);
          hasMotion = true;
        }
        this.currentPosition.x = cmd.x;
      }
      // Y coordinate  
      if (cmd.y !== null && cmd.y !== undefined) {
        const yChanged = Math.abs(cmd.y - this.currentPosition.y) > PRECISION;
        if (yChanged || needsGCode || isFullCircle) {
          coords.push(`Y${this.formatCoordinate(cmd.y)}`);
          hasMotion = true;
        }
        this.currentPosition.y = cmd.y;
      }
      // Z coordinate (helical arcs)
      if (cmd.z !== null && cmd.z !== undefined) {
        const zChanged = Math.abs(cmd.z - this.currentPosition.z) > PRECISION;
        // Always output Z if changed, or new commands, or full circles
        if (zChanged || needsGCode || isFullCircle) {
          coords.push(`Z${this.formatZ(cmd.z)}`);
          hasMotion = true;
        }
        this.currentPosition.z = cmd.z;
      }
      // Arc parameters - always output if present
      if (this.config.arcFormat === 'IJ') {
        if (cmd.i !== null && cmd.i !== undefined) coords.push(`I${this.formatCoordinate(cmd.i)}`);
        if (cmd.j !== null && cmd.j !== undefined) coords.push(`J${this.formatCoordinate(cmd.j)}`);
      } else if (this.config.arcFormat === 'R') {
        const radius = Math.hypot(cmd.i ?? 0, cmd.j ?? 0);
        if (radius > PRECISION) coords.push(`R${this.formatCoordinate(radius)}`);
      }
      // Feed rate handling
      if (cmd.f !== undefined && cmd.f !== null) {
        // Under inverse time (G93) F is a per-block DURATION, not a
        // modal velocity - the controller faults on an interpolated
        // block without one. Modal suppression must not apply.
        const invTime = this.modalState.feedRateMode === 'G93';
        const feedChanged = invTime || this.currentFeed === null || Math.abs(cmd.f - this.currentFeed) > PRECISION;
        if (feedChanged) {
          coords.push(`F${this.formatFeed(cmd.f, invTime)}`);
          this.currentFeed = cmd.f;
        }
      }
      // Build final command (only output if there's either a mode change or actual motion)
      if (!needsGCode && !hasMotion) return '';
      let code = needsGCode ? gCommand : '';
      if (coords.length > 0) code += (code ? ' ' : '') + coords.join(' ');
      if (needsGCode) this.modalState.motionMode = gCommand;
      return code;
    }

    isFullCircle(cmd) {
      if (!cmd.i && !cmd.j) return false;
      const targetX = (cmd.x !== null && cmd.x !== undefined) ? cmd.x : this.currentPosition.x;
      const targetY = (cmd.y !== null && cmd.y !== undefined) ? cmd.y : this.currentPosition.y;
      const xSame = Math.abs(targetX - this.currentPosition.x) < PRECISION;
      const ySame = Math.abs(targetY - this.currentPosition.y) < PRECISION;
      return xSame && ySame;
    }

    /**
     * X/Y/Z/A word list for a motion command, plus whether any of them
     * is real movement. generateRapid and generateLinear differ only in
     * their modal G-word and feed handling; this is everything they
     * share, including the 4th-axis rules.
     *
     * The rotary state key is always 'a' regardless of which WORD the
     * plan asked for - currentPosition tracks one rotary axis, and a
     * B-word job must not open a second, untracked slot.
     */
    _motionCoords(cmd, needsGCode) {
      const coords = [];
      let hasMotion = false;

      const emit = (word, key, value, fmt) => {
        if (value === null || value === undefined) return;
        const prev = this.currentPosition[key];
        const changed = (prev === null || prev === undefined)
          ? true
          : Math.abs(value - prev) > PRECISION;
        if (changed || needsGCode) {
          coords.push(word + fmt(value));
          hasMotion = true;
        }
        this.currentPosition[key] = value;
      };

      const coord = (v) => this.formatCoordinate(v);
      emit('X', 'x', cmd.x, coord);
      emit('Y', 'y', cmd.y, coord);
      emit('Z', 'z', cmd.z, (v) => this.formatZ(v));

      // 4th axis (accumulated - never wrapped). Emitted only when the
      // post declares a rotary route AND the current plan asked for a
      // word, so a stray cmd.a cannot leak onto a 3-axis post.
      // formatAngle, not formatCoordinate: degrees must not be
      // rescaled by G20. Sets hasMotion - a pure-A move (a constant-
      // radius 'around' ring, an index rotation) is real cutting or
      // positioning motion and must not be swallowed as a no-op.
      if (this.rotaryAxisWord && this.rotaryCaps.routes.length > 0) {
        this.rotaryWordUsed = this.rotaryAxisWord;
        emit(this.rotaryAxisWord, 'a', cmd.a, (v) => this.formatAngle(v));
      }

      return { coords, hasMotion };
    }

    generateRapid(cmd) {
      const needsGCode = !this.config.modalCommands || this.modalState.motionMode !== 'G0';
      const { coords, hasMotion } = this._motionCoords(cmd, needsGCode);
      // Only output when something actually moves. A mode change with no
      // words is a bare `G0`/`G1` line: legal, useless, and it makes the
      // index links read as if they did something. motionMode is left
      // alone so the next real move still emits its G-word.
      if (!hasMotion) return '';
      let code = needsGCode ? 'G0' : '';
      if (coords.length > 0) code += (code ? ' ' : '') + coords.join(' ');
      if (needsGCode) this.modalState.motionMode = 'G0';
      return code;
    }

    generateLinear(cmd) {
      const needsGCode = !this.config.modalCommands || this.modalState.motionMode !== 'G1';
      const { coords, hasMotion } = this._motionCoords(cmd, needsGCode);
      // Feed rate
      if (cmd.f !== undefined && cmd.f !== null) {
        // Under inverse time (G93) F is this block's duration: every interpolated block carries one, as in generateArc.
        const invTime = this.modalState.feedRateMode === 'G93';
        const feedChanged = invTime || this.currentFeed === null || Math.abs(cmd.f - this.currentFeed) > PRECISION;
        if (feedChanged) {
          coords.push(`F${this.formatFeed(cmd.f, invTime)}`);
          this.currentFeed = cmd.f;
        }
      }
      // Only output if there's a mode change or actual motion
      if (!needsGCode && !hasMotion) return '';
      let code = needsGCode ? 'G1' : '';
      if (coords.length > 0) code += (code ? ' ' : '') + coords.join(' ');
      if (needsGCode) this.modalState.motionMode = 'G1';
      return code;
    }

    generateDwell(cmd) {
      return `G4 ${this.config.dwellWord}${this.formatDwell(cmd.dwell)}`;
    }

    processCommand(cmd) {
      switch (cmd.type) {
        case 'RAPID': return this.generateRapid(cmd);
        case 'LINEAR': return this.generateLinear(cmd);
        case 'ARC_CW':
        case 'ARC_CCW': return this.generateArc(cmd);
        case 'PLUNGE': return this.generateLinear(cmd);
        case 'RETRACT': return this.generateRapid(cmd);
        case 'DWELL': return this.generateDwell(cmd);
        case 'CANNED_SIMPLE':
          return this.generateSimpleDrill({ x: cmd.x, y: cmd.y }, cmd.z, cmd.retract, cmd.f, cmd.dwell);
        case 'CANNED_PECK':
          // cycleType 'G73' (chip-break) or 'G83' (full retract, the default)
          return this.generatePeckDrill({ x: cmd.x, y: cmd.y }, cmd.z, cmd.retract, cmd.peckDepth, cmd.f, cmd.cycleType);
        default: return '';
      }
    }

    /**
     * G81 - simple drilling cycle; G82 when dwellTime > 0 (dwell at the bottom).
     * P goes through formatDwell, in the setup's dwell unit.
     */
    generateSimpleDrill(position, depth, retract, feedRate, dwellTime) {
      return this.cannedCycleHead(dwellTime > 0 ? 'G82' : 'G81', position)
        + this.modalWord('Z', 'z', depth, this.formatZ)
        + this.modalWord('R', 'r', retract, this.formatZ)
        + this.modalWord('F', 'f', feedRate, this.formatFeed)
        + (dwellTime > 0 ? this.modalWord('P', 'dwell', dwellTime, this.formatDwell) : '');
    }

    /**
     * G83 - peck drilling, full retract between pecks.
     * G73 - chip-breaking, partial retract; faster in stringy materials.
     */
    generatePeckDrill(position, depth, retract, peckDepth, feedRate, cycleType = 'G83') {
      return this.cannedCycleHead(cycleType, position)
        + this.modalWord('Z', 'z', depth, this.formatZ)
        + this.modalWord('R', 'r', retract, this.formatZ)
        + this.modalWord('Q', 'q', peckDepth, this.formatCoordinate)
        + this.modalWord('F', 'f', feedRate, this.formatFeed);
    }

    /** Cycle code is modal; XY changes every hole. */
    cannedCycleHead(cycleType, position) {
      let line = '';
      if (cycleType !== this.cannedState.cycleType) {
        line = cycleType + ' ';
        this.cannedState.cycleType = cycleType;
      }
      return line + `X${this.formatCoordinate(position.x)} Y${this.formatCoordinate(position.y)}`;
    }

    /** Canned-cycle words are modal: emitted only when they differ from the previous cycle. */
    modalWord(letter, key, value, format) {
      if (value === this.cannedState[key]) return '';
      this.cannedState[key] = value;
      return ` ${letter}${format.call(this, value)}`;
    }

    cancelCannedCycle(options) {
      // Reset modal tracking so next canned cycle emits full parameters
      this.cannedState = {cycleType: null, z: null, r: null, q: null, f: null, dwell: null};
      return 'G80';
    }

    /**
     * Optional N-word line numbering, counting from the step. Applied
     * ONCE by GCodeGenerator to the finished program, so header, spindle,
     * motion and footer blocks all number off one counter.
     * Skipped: blank lines, comment-only lines, and blocks that already
     * own their address - '%' tape marks, O-numbers, an existing N, and
     * '/' block-delete (numbering it would change what the switch skips).
     */
    applyLineNumbers(gcodeText, options) {
      if (!options.lineNumbers) return gcodeText;
      // Machine Settings commits numbers unvalidated, and an N word is a positive integer.
      const step = Math.max(1, Math.round(options.lineNumberStep));
      let n = step;
      return gcodeText
        .split('\n')
        .map((line) => {
          const t = line.trim();
          if (!t) return line;
          if (t[0] === '%' || t[0] === '/' || t[0] === '(' || t[0] === ';') return line;
          if (/^[NnOo]\d/.test(t)) return line;
          const num = n;
          n += step; // Wrap rather than overflow the control's block-number field.
          if (n > this.config.lineNumberMax) n = step;
          return `N${num} ${line}`;
        })
        .join('\n');
    }

    /**
     * Emits a feed-rate-mode change, or '' if already in that mode.
     * 'G93' = inverse time (F is 1/minutes, required on EVERY
     * interpolated block). 'G94' = units/minute. Called once per plan by
     * GCodeGenerator from plan.metadata.rotaryInverseTime. Posts whose
     * controller spells these differently override.
     */
    setFeedRateMode(mode, options = {}) {
      if (this.modalState.feedRateMode === mode) return '';
      this.modalState.feedRateMode = mode;
      // F changes meaning across the boundary - force a re-emit.
      this.currentFeed = null;
      return this.appendComment(mode, mode === 'G93' ? 'comments.inverseTimeOn' : 'comments.inverseTimeOff', options);
    }

    /**
     * Machine-limit validation, instance-free. Roland does not extend this
     * class but drives the same hardware limits, so the checks live here as
     * a static and both posts pass their own state in.
     * @param {Object} cmd MotionCommand
     * @param {Object} options generator options (maxFeed, maxSafeDepth)
     * @param {Object} ctx { inverseTime, maxInverseTime, rotaryAxisWord, zDatum, zFloor }
     * @returns {{warnings: Object[], errors: Object[]}} message descriptors
     */
    static validateCommandLimits(cmd, options, ctx) {
      const warnings = [];
      const errors = [];
      // THREE independent depth limits exist, deliberately:
      // 1. profile-*.json max on the depth parameter - stops the user
      //  typing a value the machine cannot reach.
      // 2. BaseOperationPanel.checkDepthLimits - warns pre-generation
      //  using resolveSurfaceZ, so stock thickness and Z-zero are in
      //  the maths. This is the one the operator actually reads.
      // 3. here - the last gate, per command at emission, and the only
      //  one that sees post-processor and 3D-generator output.
      // (2) is authoritative for user feedback; (3) is authoritative for
      // correctness. (1) can mask (2) if its max is tighter than the
      // machine's - check the profile before suspecting this method.
      const maxSafeDepth = options.maxSafeDepth;
      // Non-finite words. `cmd.f > limit` below is NaN-blind - NaN > x is
      // false - so a NaN feed would pass every check and reach the post as
      // the literal "FNaN". An ERROR, not a warning: GCodeGenerator throws
      // on errors, and a file with NaN in it is worse than no file.
      // Number.isFinite per word, because 0 is a valid X, Y, Z, I and J
      // and a truthiness test would reject a legitimate origin move.
      for (const word of ['x', 'y', 'z', 'i', 'j', 'a', 'f']) {
        const v = cmd[word];
        if (v === undefined || v === null) continue;
        if (!Number.isFinite(v)) errors.push({
          key: 'messages.export.nonFiniteWord',
          values: { word: word.toUpperCase(), value: String(v) }
        });
      }
      // A feed move at F0 stalls or faults on every control that does not
      // silently reuse the previous modal feed, which is the worse case.
      if (Number.isFinite(cmd.f) && cmd.f <= 0 && cmd.type !== 'RAPID') errors.push({ key: 'messages.export.zeroFeed' });
      // Feed rate check - UNIT-AWARE. Under G93 F is 1/minutes (the
      // reciprocal of the move's duration), not mm/min:
      // convertDevelopedToRotary emits F = feed / pathLength, so a 0.3mm
      // segment at 1500mm/min is a legitimate F5000. Tested against
      // maxFeed it would compare a duration to a velocity and warn on
      // nearly every short rotary move. The real G93 ceiling is the
      // setup's maxInverseTime - which convertDevelopedToRotary already
      // clamps to.
      if (cmd.f !== undefined && cmd.f !== null) {
        const limit = ctx.inverseTime ? ctx.maxInverseTime : options.maxFeed;
        if (cmd.f > limit) {
          warnings.push(
            ctx.inverseTime
              ? { key: 'messages.export.inverseTimeOverMax', values: { feed: cmd.f.toFixed(2), max: limit } }
              : { key: 'messages.export.feedOverMax', values: { feed: cmd.f, max: limit } },
          );
        }
      }
      // Critical Z-Plunge Check. FLAT-STOCK ONLY: a 4th-axis plan's Z is
      // referenced to the rotary centerline or blank/face surface - stock
      // thickness has no meaning there, and a legitimate 'surface'-datum
      // rotary job cuts far past any flat-stock limit. rotaryAxisWord is set
      // per plan by the generator exactly when a plan is 4th-axis.
      const z = cmd.z;
      if (z !== undefined && z !== null && Number.isFinite(z)) {
        if (!ctx.rotaryAxisWord && typeof maxSafeDepth === 'number' && z < maxSafeDepth) {
          warnings.push({ key: 'messages.export.depthOverMax', values: { z: z.toFixed(3), max: maxSafeDepth } });
        }
        // Absolute Z0. Unlike maxSafeDepth this is not a stock rule and
        // the rotary exemption does not apply: a control whose Z0 is the
        // bed cannot reach below it at all, and the operator cannot fix
        // that by re-zeroing. Checked on the Z the file carries, datum
        // included.
        const written = z + ctx.zDatum;
        if (ctx.zFloor !== null && written < ctx.zFloor) errors.push({ key: 'messages.export.belowFloor', values: { z: written.toFixed(3), floor: String(ctx.zFloor) } });
      }
      return { warnings, errors };
    }

    validateCommand(cmd, options) {
      return BasePostProcessor.validateCommandLimits(cmd, options, {
        inverseTime: this.modalState.feedRateMode === 'G93',
        maxInverseTime: this.rotaryCaps.maxInverseTime,
        rotaryAxisWord: this.rotaryAxisWord,
        zDatum: this.zDatum,
        zFloor: this.zFloor,
      });
    }

    resetState() {
      // 'a' starts NULL, not 0: emit() suppresses a word that matches the
      // tracker, and the first index link is a G0 A0 behind a RETRACT that
      // already set modal G0 - so a 0 seed would swallow the line that
      // pins the starting angle. Same reason currentFeed starts null.
      this.currentPosition = { x: 0, y: 0, z: 0, a: null };
      this.currentFeed = null;
      this.currentSpindle = 0;
      // null, not 0: 0 is a legal T word on some controls and would
      // suppress the first real selection.
      this.currentToolNumber = null;
      // Set per PLAN by GCodeGenerator from plan.metadata.rotaryAxisWord.
      // null = this plan has no rotary motion.
      this.rotaryAxisWord = null;
      // Sticky: which word this PROGRAM used, latched the first time a
      // plan carries one and never cleared until resetState. Footers run
      // AFTER the last plan, and the last plan in any batch is the
      // synthetic 'final' retract with no rotary metadata - so
      // rotaryAxisWord is null there and a footer that reads it can
      // never see that the job was a 4th-axis job at all.
      this.rotaryWordUsed = null;
      // Absolute Z0, set per program by GCodeGenerator.generate: the datum
      // formatZ adds to every Z, and the lowest Z the control can reach
      // (null where Z0 is touched off and anything goes).
      this.zDatum = 0;
      this.zFloor = null;
      // Non-finite values formatNumberSafe refused to emit this run.
      this.numericFaults = 0;
      this.spindleCapped = null; // highest speed setSpindle capped this run
      // Canned cycle modal state - tracks last-emitted parameters
      this.cannedState = { cycleType: null, z: null, r: null, q: null, f: null, dwell: null };
      this.modalState = { motionMode: null, coordinateMode: 'G90', units: 'G21', plane: 'G17', feedRateMode: 'G94' };
    }
  }
  ROOT.BasePostProcessor = BasePostProcessor;
  // Logic families by the id a setup names in `logic`. Each logic module
  // adds its own; GCodeGenerator.register builds a setup with the one it names.
  ROOT.PostLogic = new Map([['rs274', BasePostProcessor]]);
})();