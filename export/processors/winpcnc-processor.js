/*!
 * @file        export/processors/winpcnc-processor.js
 * @description WinPC-NC (DIN/ISO interpreter) post-processing module
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
     *   - NO mandatory decimal point. Bare integers are native ("Z15", "X50"),
     *     so the '_pt' wrapper must not be carried over.
     *   - NO G40 / G43 / G49 / G80 / G98 / G99, no G20 / G21 (units are
     *     G70 / G71), no G93 / G94. G98 means "define subprogram" here.
     *   - NO machine-coordinate park. G28 exists but is not Fanuc's
     *     incremental intermediate-point retract; the control's own output
     *     parks with G0 Z<travel> then G0 X0 Y0.
     *
     * Further traps this file guards:
     *   - G04 takes SECONDS on F. P is reserved for the G81/G82 dwell (ms).
     *   - M10/M11 are not vacuum on this control - Autodesk's post maps them
     *     to laser power. Auxiliary outputs are M70..M77 (HIGH) and the
     *     negative form M-70..M-77 (LOW).
     *   - The unit of the F word (mm/min or mm/s) is a WinPC-NC machine
     *     parameter, not a dialect constant.
     *   - Comments reach the control as Latin-1 and cannot nest.
     *
     * Not implemented:
     *   - Inverted Z output. Some installs count Z positive downwards
     *     (Autodesk defaults to it, RhinoCAM hardcodes it) but the reference
     *     program from the target machine is Z+ up. Implementing it needs a
     *     formatZ() seam in BasePostProcessor first - _motionCoords and
     *     generateArc format Z through formatCoordinate, shared with X/Y/I/J -
     *     so the parameter is deliberately absent rather than present and
     *     inert.
     *   - Canned drilling cycles (see supportsCannedCycles below).
     *   - Subprograms (G98 Lx) and cutter compensation (not in the
     *     interpreter).
     *   - Work offsets. G54 with coordinates REDEFINES the offset on this
     *     control; only a bare G54 selects one. Emitting the Fanuc form would
     *     silently move the operator's zero.
     */

    const LATIN1_FOLD = {
        'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue',
        'ß': 'ss', 'é': 'e', 'è': 'e', 'ç': 'c', 'ñ': 'n', 'å': 'a', 'ø': 'o'
    };

    class WinPCNCPostProcessor extends BasePostProcessor {
        constructor() {
            super('WinPCNC', {
                label: 'WinPC-NC (Radioactive)',
                fileExtension: '.nc',
                commentStyle: 'parenthesis',
                // The interpreter refuses to run a program that never selects a
                // tool, changer or not, and M6 is required alongside the T word.
                supportsToolChange: true,
                useM6: true,
                emitsInitialTool: true,
                toolLengthComp: { modes: ['none'], default: 'none' },
                // The control owns its tool-change procedure (prompt or ATC
                // macro, set in its own parameters) - an M0 on top of it would
                // be a second stop the operator has to clear.
                pauseAfterToolChange: false,
                supportsArcCommands: true,
                arcFormat: 'IJ',
                // G81/G82 exist but with inverted retract semantics and no
                // G80/G83/G73 to go with them. MachineProcessor's non-canned
                // branch emits a full peck loop with dwell, so nothing is lost
                // by leaving this off until the cycles are bench-verified.
                supportsCannedCycles: false,
                modalCommands: true,
                coordinateDecimals: 3,
                feedDecimals: 0,
                spindleDecimals: 0,
                lineNumbering: true,
                lineNumberStart: 1,
                lineNumberStep: 1,
                lineNumberMax: 999999,
                maxSpindleSpeed: 30000,
                maxRapidRate: 3000,
                rotary: {
                    routes: ['a-word', 'wrapped-linear'],
                    axisWords: ['A', 'B'],
                    // No G93. Feeds on mixed linear/rotary moves are honest at
                    // the reference radius and run fast below it.
                    inverseTime: false,
                    continuous: true,
                    indexDwell: 0
                },
                defaults: {
                    // generateHeader/generateFooter own the whole start and park
                    // sequence; these are the user's extras.
                    startCode: '',
                    endCode: ''
                },
                customParameters: [
                    {
                        key: 'winpcProgramName',
                        label: 'Program Name (% line)',
                        type: 'text',
                        category: 'machine',
                        default: '1'
                    },
                    {
                        key: 'winpcFeedUnit',
                        label: 'Feed Unit',
                        type: 'select',
                        category: 'machine',
                        options: [
                            { value: 'mmmin', label: 'mm/min' },
                            { value: 'mms', label: 'mm/s' }
                        ],
                        default: 'mmmin'
                    },
                    {
                        key: 'winpcAuxOutput',
                        label: 'Vacuum / Aux Output',
                        type: 'select',
                        category: 'machine',
                        options: [
                            { value: 'none', label: 'Not wired' },
                            { value: '70', label: 'Output 100 (M70 / M-70)' },
                            { value: '71', label: 'Output 101 (M71 / M-71)' },
                            { value: '72', label: 'Output 102 (M72 / M-72)' },
                            { value: '73', label: 'Output 103 (M73 / M-73)' }
                        ],
                        default: 'none'
                    }
                ]
            });

            // Latched in generateHeader, which always runs before any motion.
            this.feedPerSecond = false;
        }

        // ════════════════════════════════════════════════════════════
        // Formatting
        // ════════════════════════════════════════════════════════════

        /**
         * The F word carries mm/min or mm/s depending on a WinPC-NC machine
         * parameter. Two decimals in mm/s: the inherited feedDecimals of 0
         * would round 800 mm/min to F13 instead of F13.33.
         */
        formatFeed(value, inverseTime = false) {
            if (value == null) return '';
            if (!this.feedPerSecond) return super.formatFeed(value, inverseTime);
            return this.formatNumberSafe(value / 60, 2, this.outputScale);
        }

        /**
         * Comments cannot nest and an unbalanced '(' swallows the rest of the
         * block. Files reach the control as Latin-1, and the header block
         * carries user file names - fold the German set rather than deleting
         * the letter, then drop anything still outside printable ASCII.
         */
        sanitizeComment(text) {
            return String(text)
                .replace(/[äöüÄÖÜßéèçñåø]/g, ch => LATIN1_FOLD[ch])
                .replace(/[()]/g, '')
                .replace(/[^\x20-\x7E]/g, '')
                .trim();
        }

        formatComment(text, options) {
            if (!options?.includeComments || !text) return '';
            const clean = this.sanitizeComment(text);
            return clean ? `(${clean})` : '';
        }

        // ════════════════════════════════════════════════════════════
        // Program structure
        // ════════════════════════════════════════════════════════════

        generateHeader(options) {
            const c = options.comments || {};
            const lines = [];
            const isInch = options.units === 'inch' || options.units === 'in';

            this.feedPerSecond = options.winpcFeedUnit === 'mms';
            if (this.feedPerSecond && isInch) {
                throw new Error('[WinPC-NC] A feed unit of mm/s cannot be combined with ' +
                    'inch output. Set the feed unit to mm/min, or switch the G-code ' +
                    'units to mm.');
            }

            // Everything above this line is comment text to the interpreter;
            // the program itself starts at the '%'.
            lines.push(`%${this.resolveProgramName(options)}`);

            if (options.includeComments && options.commentBlock) {
                options.commentBlock.forEach(line => {
                    const cm = this.formatComment(line, options);
                    if (cm) lines.push(cm);
                });
            }
            // Z direction is a per-install WinPC-NC parameter and nothing in the
            // file states which way it counts. Say it out loud.
            this.pushCommentLine(lines, c.winpcZConvention ||
                'Z convention: Z+ up, negative Z into the stock', options);
            lines.push('');

            this.modalState.units = isInch ? 'G70' : 'G71';
            this.outputScale = isInch ? (1 / 25.4) : 1.0;

            lines.push(this.modalState.coordinateMode);
            lines.push(this.modalState.units);
            lines.push(this.modalState.plane);
            lines.push('');

            if (options.coolant === 'mist') {
                lines.push(this.appendComment('M7', c.coolantMist, options));
            } else if (options.coolant === 'flood') {
                lines.push(this.appendComment('M8', c.coolantFlood, options));
            }

            const aux = this.resolveAuxOutput(options);
            if (aux) lines.push(this.appendComment(`M${aux}`, c.vacuumOn, options));

            let startCode = options.startCode || '';
            startCode = startCode.replace(/{toolNumber}/g, options.toolNumber ?? 1);
            if (startCode.trim()) lines.push(startCode);

            return lines.join('\n');
        }

        generateFooter(options) {
            const c = options.comments || {};
            const lines = [''];

            lines.push(this.appendComment('M5', c.spindleStop, options));
            this.currentSpindle = 0;

            if (options.coolant && options.coolant !== 'none') {
                lines.push(this.appendComment('M9', c.coolantOff, options));
            }

            const aux = this.resolveAuxOutput(options);
            // Outputs are cleared with a NEGATIVE M number on this control.
            if (aux) lines.push(this.appendComment(`M-${aux}`, c.vacuumOff, options));

            const parkZ = options.travelZ ?? options.safeZ ?? this.config.safetyHeight;
            lines.push(this.appendComment(
                `G0 Z${this.formatCoordinate(parkZ)}`, c.retractSafeZ, options));
            lines.push('G0 X0 Y0');

            let endCode = options.endCode || '';
            endCode = endCode.replace(/{safeZ}/g, this.formatCoordinate(options.safeZ));
            endCode = endCode.replace(/{travelZ}/g, this.formatCoordinate(options.travelZ));
            if (endCode.trim()) lines.push(endCode);

            lines.push('M30');
            return lines.join('\n');
        }

        // ════════════════════════════════════════════════════════════
        // Tool change
        // ════════════════════════════════════════════════════════════

        /**
         * Work-coordinate retract, at travel height rather than the feed
         * clearance: the control's own change procedure may jog the machine,
         * and there is no offset-independent park to fall back on.
         */
        toolChangeRetract(options) {
            const c = options.comments || {};
            const z = options.travelZ ?? options.safeZ ?? this.config.safetyHeight;
            this.currentPosition.z = z;   // NUMBER: compared with Math.abs()
            return [this.appendComment(
                `G0 Z${this.formatCoordinate(z)}`, c.retractSafeZ, options)];
        }

        /** No G43: tool lengths live in the control's own tool table. */
        toolChangeSwap(toolNumber, options) {
            return [`T${String(toolNumber).padStart(2, '0')} M6`];
        }

        // ════════════════════════════════════════════════════════════
        // Modes, dwell, spindle
        // ════════════════════════════════════════════════════════════

        /** G04 times on F. P belongs to the G81/G82 cycles and is milliseconds. */
        generateDwell(cmd) {
            const duration = cmd.dwell || cmd.duration || 0;
            return `G4 F${this.formatDwell(duration)}`;
        }

        setSpindle(speed, dwell = 0, options = {}) {
            if (speed === this.currentSpindle) {
                return null;
            }

            let targetSpeed = speed;
            if (targetSpeed > this.config.maxSpindleSpeed) {
                console.warn(`[WinPC-NC] Spindle speed ${targetSpeed} exceeds machine ` +
                    `maximum of ${this.config.maxSpindleSpeed}. Capping value.`);
                targetSpeed = this.config.maxSpindleSpeed;
            }

            const c = options.comments || {};
            this.currentSpindle = speed;
            const lines = [];

            if (speed > 0) {
                lines.push(this.appendComment(
                    `M3 S${this.formatSpindle(targetSpeed)}`, c.spindleStart, options));
                if (dwell > 0) {
                    lines.push(this.appendComment(
                        `G4 F${this.formatDwell(dwell)}`, c.spindleDwell, options));
                }
            } else {
                lines.push(this.appendComment('M5', c.spindleStop, options));
            }

            return lines.join('\n');
        }

        /**
         * Neither G93 nor G94 is a word this interpreter knows, so the mode is
         * tracked but never emitted. G93 arriving here means a rotary plan was
         * converted to inverse time against a post that declares it cannot -
         * its F values would be read as feed rates.
         */
        setFeedRateMode(mode, options = {}) {
            if (mode === 'G93') {
                throw new Error('[WinPC-NC] Inverse-time feed (G93) is not supported by ' +
                    'this control, but a plan reached the post asking for it.');
            }
            super.setFeedRateMode(mode, options);
            return '';
        }

        /** No G80. The modal reset still has to happen. */
        cancelCannedCycle(options) {
            super.cancelCannedCycle(options);
            return '';
        }

        // ════════════════════════════════════════════════════════════
        // Helpers
        // ════════════════════════════════════════════════════════════

        /** The '%' line takes a bare identifier - '%1', '%prog2'. */
        resolveProgramName(options) {
            const raw = String(options.winpcProgramName ?? '1');
            return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || '1';
        }

        resolveAuxOutput(options) {
            const out = options.winpcAuxOutput;
            if (!options.vacuum || !out || out === 'none') return null;
            return String(out);
        }
    }

    window.WinPCNCPostProcessor = WinPCNCPostProcessor;
})();