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

    const PRECISION = window.CAMConfig.constants.precision.coordinate;

    /**
     * The contract every post-processor descriptor satisfies, whether it
     * extends this class or builds the object by hand (Roland). Consumers
     * read these keys directly, so an absent key is not "default" - it is
     * `undefined` reaching a `!==` test.
     *
     * @typedef {Object} PostCapabilities
     * @property {boolean} supportsToolChange
     * @property {boolean} useM6
     * @property {boolean} emitsInitialTool
     * @property {{modes: string[], default: string}} toolLengthComp
     * @property {boolean} supportsToolLengthComp - derived from toolLengthComp.modes
     * @property {boolean} pauseAfterToolChange
     * @property {boolean} supportsComments
     * @property {boolean} supportsArcCommands
     * @property {boolean} supportsCannedCycles
     * @property {'IJ'|'R'|null} arcFormat
     * @property {{routes: string[], axisWords: string[], inverseTime: boolean,
     *             maxInverseTime: number, indexDwell: number,
     *             continuous: boolean}} rotary - normalizeRotary() shape;
     *            declare it empty rather than omitting it.
     */
    class BasePostProcessor {
        constructor(name, config = {}) {
            // REVIEW - LinuxCNC post-processor has partial initial parameter syntax for rotary operations so Base needs defaults now.

            this.name = name;
            this.config = {
                fileExtension: '.nc',
                supportsToolChange: false,
                supportsArcCommands: true,
                supportsCannedCycles: false,
                useM6: false,
                // Where the Z offset comes from. A boolean could only express
                // "table" vs "nothing"; there are four real behaviours and
                // the operator's machine decides which, not us.
                //
                //   'none'           Nothing emitted. Operator re-zeros Z on
                //                    the new bit. Plain Grbl, Marlin, any
                //                    collet spindle without a setter.
                //   'table'          G43 H<n>. Offsets pre-measured into the
                //                    control's tool table; H names the
                //                    register. Fixed toolholders (TTS, BT30).
                //   'table-implicit' G43 rides the change line and H is taken
                //                    from the active T by the control:
                //                    `T7 M06 G43`, no H word anywhere. Fanuc
                //                    with comp-by-tool-number, Brother, OKK.
                //   'probe'          A controller macro measures the tool at
                //                    change time and owns Z. Emit no G43 at
                //                    all. Makera MTC, sender touch-off macros.
                //
                // Posts declare what they can do; Machine Settings picks.
                toolLengthComp: { modes: ['none'], default: 'none' },
                pauseAfterToolChange: false,
                emitsInitialTool: true,
                initialToolUsesM6: false,
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 0,
                spindleDecimals: 0,
                lineNumbering: false, // To be implemented in the future
                modalCommands: true,
                safetyHeight: 5.0,
                maxSpindleSpeed: 30000,
                ...config
            };

            this.modalState = {
                motionMode: null,
                coordinateMode: 'G90',
                units: 'G21',
                plane: 'G17',
                feedRateMode: 'G94'
            };

            // 'a' starts NULL, not 0: emit() suppresses a word that matches the
            // tracker, and the first index link is a G0 A0 behind a RETRACT that
            // already set modal G0 - so a 0 seed swallowed the line that pins the
            // starting angle. Same reason currentFeed starts null.
            this.currentPosition = { x: 0, y: 0, z: 0, a: null };
            this.currentFeed = null;
            this.currentSpindle = 0;

            this.descriptor = {
                id: name.toLowerCase(),
                label: this.config.label || name,
                fileExtension: this.config.fileExtension || '.nc',
                capabilities: {
                    supportsToolChange: this.config.supportsToolChange || false,
                    useM6: this.config.useM6 || false,
                    toolLengthComp: this.config.toolLengthComp || { modes: ['none'], default: 'none' },
                    supportsToolLengthComp:
                        (this.config.toolLengthComp?.modes || ['none']).some(m => m !== 'none'),
                    pauseAfterToolChange: this.config.pauseAfterToolChange || false,
                    emitsInitialTool: this.config.emitsInitialTool !== false,
                    supportsArcCommands: this.config.supportsArcCommands !== false,
                    supportsCannedCycles: this.config.supportsCannedCycles || false,
                    supportsComments: this.config.supportsComments !== false,
                    arcFormat: this.config.arcFormat || null,
                    // 4th-axis capability. Normalized object.
                    rotary: BasePostProcessor.normalizeRotary(this.config.rotary),
                },
                defaults: this.config.defaults || {
                    startCode: '',
                    endCode: '',
                },
                limits: {
                    maxSpindleSpeed: this.config.maxSpindleSpeed || 30000,
                    maxRapidRate: this.config.maxRapidRate || 1000,
                },
                customParameters: this.config.customParameters || [],

            };
            this.outputScale = 1.0;
            // Hot-path cache: generateRapid/generateLinear consult this per
            // command. Also the single source of truth for whether an A word
            // may be emitted at all.
            this.rotaryCaps = this.descriptor.capabilities.rotary;
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
        }

        /**
         * Normalizes a post's declared 4th-axis capability.
         *
         * routes - export routes this post can emit, in preference order.
         *          Empty/absent = no 4th axis.
         *   'a-word'         A/B in DEGREES, Y dropped. CAM wraps
         *                    (MachineProcessor.convertDevelopedToRotary).
         *   'wrapped-linear' Y KEPT, carrying mm of arc at refRadius. The
         *                    machine's Y motor is the rotary (axis
         *                    replacement, steps/mm calibrated). No CAM math.
         *   'a-linear'       A/B carrying mm of arc, Y dropped. For rotaries
         *                    calibrated in linear units rather than degrees.
         *   'cyl-interp'     RESERVED. Controller-side cylindrical interp
         *                    (G107 / TRACYL / Cycle 27). NOT interchangeable
         *                    with wrapped-linear: it needs an activation
         *                    block carrying the cylinder radius. Unimplemented
         *                    - declaring it will throw at export.
         * axisWords - rotary words the machine physically has. A rotaryAxis:'x'
         *          operation asks for 'A', a 'y' operation asks for 'B'.
         * inverseTime - G93 available. Required for correct feed on mixed
         *          linear/rotary moves; without it feeds are only honest at
         *          the blank surface and run fast at depth.
         * maxInverseTime - controller F ceiling under G93. Microscopic
         *          segments overflow past this and hard-alarm.
         * indexDwell - seconds to hold after an indexed 3+1 A positioning
         *          move before cutting resumes. A property of the ROTARY
         *          HARDWARE, not the part: belt-driven axes need ~0.3s to
         *          settle; geared/servo axes with a brake or exact-stop
         *          need 0. Lives here rather than in operation params for
         *          the same reason pauseAfterToolChange does - it travels
         *          with the machine, not the job.
         * continuous - rotary travel is unlimited. False = indexer with
         *          limited travel; accumulated-A strategies must be refused.
         */
        static normalizeRotary(decl) {
            const none = { routes: [], axisWords: [], inverseTime: false,
                           maxInverseTime: 0, indexDwell: 0, continuous: false };
            if (!decl) return none;
            if (!Array.isArray(decl.routes) || decl.routes.length === 0) return none;
            return {
                routes: decl.routes.slice(),
                axisWords: Array.isArray(decl.axisWords) ? decl.axisWords.slice() : ['A'],
                inverseTime: decl.inverseTime === true,
                maxInverseTime: decl.maxInverseTime ||
                    window.CAMConfig.constants.rotary.maxInverseTime,
                indexDwell: decl.indexDwell || 0,
                // TODO(rotary-indexer) - declared and carried through
                // context.export, but nothing refuses accumulated-A on a
                // non-continuous indexer yet. Not a live check.
                continuous: decl.continuous !== false
            };
        }

        /**
         * Formats a standalone comment line for this processor's dialect.
         * Returns empty string if comments are disabled or text is empty.
         */
        formatComment(text, options) {
            if (!options?.includeComments || !text) return '';
            return this.config.commentStyle === 'semicolon'
                ? `; ${text}`
                : `(${text})`;
        }

        /**
         * Appends an inline comment to an existing G-code line.
         * Returns the line unchanged if comments are disabled.
         */
        appendComment(line, text, options) {
            const comment = this.formatComment(text, options);
            if (!comment) return line;
            return `${line} ${comment}`;
        }

        /**
         * Pushes a standalone comment line to the array.
         * Does nothing if comments are disabled, preventing empty line bloat.
         */
        pushCommentLine(linesArray, text, options) {
            if (!options?.includeComments || !text) return;
            linesArray.push(this.formatComment(text, options));
        }

        // Abstract methods
        generateHeader(options) {
            // Resolve TLC mode once per run across header, footer, retract, and swap
            this.tlcMode = this.resolveTLCMode(options);

            const headerLines = [];
            const c = options.comments || {};

            // Add the formatted comment block IF it exists
            if (options.includeComments && options.commentBlock) {
                options.commentBlock.forEach(line => {
                    headerLines.push(this.formatComment(line, options));
                });
                headerLines.push('');
            }

            // Set unit mode from options (comes from dropdown)
            const isInch = options.units === 'inch' || options.units === 'in';
            this.modalState.units = isInch ? 'G20' : 'G21';
            this.outputScale = isInch ? (1 / 25.4) : 1.0;

            // Output all modal commands based on state
            headerLines.push(this.modalState.coordinateMode);
            headerLines.push(this.modalState.units);
            headerLines.push(this.modalState.plane);
            headerLines.push(this.modalState.feedRateMode);
            // Safe-start cancel. A program that applies tool length must also
            // start from a known-cancelled state - the control may still be
            // holding the last program's offset.
            const headerTLC = this.tlcMode;
            if (headerTLC === 'table' || headerTLC === 'table-implicit') {
                headerLines.push(this.appendComment('G49', c.toolLengthCancel, options));
            }
            headerLines.push('');

            // Get the template from the options, or a default
            let startCode = options.startCode;

            // Replace placeholders
            startCode = startCode.replace(/{toolNumber}/g, options.toolNumber ?? 1); // Every control refuses motion until a T word arrives, changer or not. T1 is a safe default for a single-tool job.

            // Conditionally add coolant/vacuum commands
            if (options.coolant && options.coolant !== 'none' && !startCode.includes('M7') && !startCode.includes('M8')) {
                if (options.coolant === 'mist') {
                    startCode += '\n' + this.appendComment('M7', c.coolantMist, options); // Mist
                } else if (options.coolant === 'flood') {
                    startCode += '\n' + this.appendComment('M8', c.coolantFlood, options); // Flood
                }
            }
            if (options.vacuum && !startCode.includes('M10')) {
                startCode += '\n' + this.appendComment('M10', c.vacuumOn, options); // Vacuum On
            }

            headerLines.push(startCode); // Add the actual start code after the modals
            return headerLines.join('\n');
        }

        generateFooter(options) {
            const c = options.comments || {};
            let endCode = options.endCode || '';

            const safeZ = options.safeZ;
            const travelZ = options.travelZ;

            endCode = endCode.replace(/{safeZ}/g, this.formatCoordinate(safeZ));
            endCode = endCode.replace(/{travelZ}/g, this.formatCoordinate(travelZ));

            // Conditionally add 'off' commands (if not already in template)
            if (options.coolant && options.coolant !== 'none' && !endCode.includes('M9')) {
                endCode = this.appendComment('M9', c.coolantOff, options) + '\n' + endCode; // Coolant Off
            }
            if (options.vacuum && !endCode.includes('M11')) {
                endCode = this.appendComment('M11', c.vacuumOff, options) + '\n' + endCode; // Vacuum Off
            }

            // Leave the control with no tool length applied, for the same
            // reason the header cancels: the next program must not inherit it.
            const footerTLC = this.tlcMode;
            if ((footerTLC === 'table' || footerTLC === 'table-implicit')
                && !endCode.includes('G49')) {
                endCode = this.appendComment('G49', c.toolLengthCancel, options) + '\n' + endCode;
            }

            return endCode;
        }

        /**
         * Generates G-code to set spindle speed, only if it has changed.
         * This is the core of the stateful spindle logic.
         * @param {number} speed - The new target RPM
         * @returns {string} G-code string (e.g., "M5\nM3 S10000") or "" if no change.
         */
        setSpindle(speed, dwell = 0, options = {}) {
            if (speed === this.currentSpindle) {
                return null;
            }

            // Spindle Validation
            let targetSpeed = speed;
            if (targetSpeed > this.config.maxSpindleSpeed) {
                console.warn(`[PostProcessor] Spindle speed ${targetSpeed} exceeds machine maximum of ${this.config.maxSpindleSpeed}. Capping value.`);
                targetSpeed = this.config.maxSpindleSpeed;
            }

            const c = options.comments || {};
            this.currentSpindle = speed;

            const lines = [];

            if (speed > 0) {
                lines.push(this.appendComment(`M3 S${this.formatSpindle(targetSpeed)}`, c.spindleStart, options));
                if (dwell > 0) {
                    lines.push(this.appendComment(`G4 P${this.formatDwell(dwell)}`, c.spindleDwell, options));
                }
            } else {
                lines.push(this.appendComment('M5', c.spindleStop, options));
            }
            
            return lines.join('\n');
        }

        /**
         * Declares the tool in the spindle before any motion. NOT a change.
         *
         * Emitted on every job, tool changes on or off: a control with a
         * changer must be TOLD to load the first tool (latching a tracker
         * and emitting nothing ran the first operation with whatever was
         * already in the spindle and whatever length offset was live), and a
         * control without one still refuses motion until a T word arrives.
         *
         * When the post uses M6 this routes through toolChangeSwap so the
         * first load takes the same audited T/M6 + G43 path as every later
         * change - minus the retract and spindle stop, which have no previous
         * tool to protect at program start.
         */
        generateInitialTool(tool, options = {}) {
            if (this.config.emitsInitialTool === false) return '';

            const assigned = tool?.number ?? options.toolNumber ?? null;
            const n = assigned ?? 1; // Every control refuses motion until a T word arrives, changer or not. T1 is a safe default for a single-tool job.
            this.currentToolNumber = n;

            const lines = [];
            if (assigned == null) {
                this.pushCommentLine(
                    lines,
                    (options.comments?.toolFallback || 'No tool number assigned - defaulting to T{n}').replace('{n}', n),
                    options
                );
            }

            if (this.config.useM6 && this.config.supportsToolChange) {
                lines.push(...this.toolChangeSwap(n, options));
            } else {
                lines.push(this.config.initialToolUsesM6 ? `M6 T${n}` : `T${n}`);
            }
            return lines.join('\n');
        }

        /**
         * The effective tool-length mode for this run: the user's Machine
         * Settings pick when this post declares it, otherwise the post's own
         * default. Never trusts an option this post cannot emit.
         */
        resolveTLCMode(options = {}) {
            const declared = this.config.toolLengthComp?.modes || ['none'];
            const want = options.toolLengthCompMode;
            if (want && declared.includes(want)) return want;
            return this.config.toolLengthComp?.default || declared[0] || 'none';
        }

        /**
         * Retract before a swap. Work-coordinate G0 by default. Overridden by
         * posts whose Z is offset-relative (Fanuc: G91 G28 Z0 is the only
         * retract independent of the active work offset and a live TLO).
         *
         * G49 drops the OUTGOING tool's offset before the swap. Without it a
         * control holds the old tool's length while the new one is loaded -
         * the classic Z crash, and the reason real Fanuc safe-start lines read
         * `G40 G17 G80 G49`.
         * @returns {string[]}
         */
        toolChangeRetract(options) {
            const c = options.comments || {};
            const mode = this.tlcMode;
            const safeZ = options.safeZ ?? this.config.safetyHeight;
            const lines = [this.appendComment(
                `G0 Z${this.formatCoordinate(safeZ)}`, c.retractSafeZ, options)];
            this.currentPosition.z = safeZ;   // NUMBER: currentPosition is
                                              // compared with Math.abs()
            if (mode === 'table' || mode === 'table-implicit') {
                lines.push(this.appendComment('G49', c.toolLengthCancel, options));
            }
            return lines;
        }

        /**
         * The swap itself plus length compensation. Overridden by posts with
         * proprietary sequences (Makera ATC/MTC).
         * @returns {string[]}
         */
        toolChangeSwap(toolNumber, options) {
            const c = options.comments || {};
            const mode = this.tlcMode;
            const lines = [];

            if (this.config.useM6) {
                // 'table-implicit': G43 rides the change block and the control
                // takes H from the active T. Real output looks like
                // `T7 M06 G43` with no H word in the whole program.
                lines.push(mode === 'table-implicit'
                    ? this.appendComment(`T${toolNumber} M06 G43`, c.toolLengthComp, options)
                    : `T${toolNumber} M6`);
            }

            if (mode === 'table') {
                lines.push(this.appendComment(
                    `G43 H${toolNumber}`, c.toolLengthComp, options));
            }
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
            const c = options.comments || {};
            const n = tool?.number ?? options.toolNumber ?? null;
            if (n == null) return ''; // caller gates on number > 0; nothing to emit

            const lines = [''];

            this.pushCommentLine(lines,
                (c.toolChange || 'Tool change: {name}')
                    .replace('{name}', tool?.name || tool?.id || `Tool ${n}`), options);
            this.pushCommentLine(lines,
                (c.toolDiameter || 'Diameter: {diameter}mm')
                    .replace('{diameter}', tool?.diameter ?? '?'), options);

            const stop = this.setSpindle(0, 0, options);
            if (stop) lines.push(stop);
            if (options.coolant && options.coolant !== 'none') {
                lines.push(this.appendComment('M9', c.coolantOff, options));
            }

            lines.push(...this.toolChangeRetract(options));
            lines.push(...this.toolChangeSwap(n, options));

            if (this.config.pauseAfterToolChange) {
                lines.push(this.appendComment('M0', c.toolChangePause, options));
            }

            const rpm = tool?.spindleSpeed || options.spindleSpeed;
            const start = this.setSpindle(rpm, tool?.spindleDwell || 0, options);
            if (start) lines.push(start);

            if (options.coolant === 'mist') {
                lines.push(this.appendComment('M7', c.coolantMist, options));
            } else if (options.coolant === 'flood') {
                lines.push(this.appendComment('M8', c.coolantFlood, options));
            }

            lines.push('');
            this.currentToolNumber = n;
            // Modal cache is a GUESS after a swap. The spindle is re-asserted
            // above, but F is not, and a probe/pause macro (Makera M491, a
            // sender touch-off) runs at its own feed and leaves it modal.
            this.currentFeed = null;
            return lines.join('\n');
        }

        // Base formatter that safely strips trailing zeros and handles -0
        formatNumberSafe(value, precision, scale = 1.0) {
            if (value == null) return ''; // Catches null and undefined

            const scaled = value * scale;
            if (precision === 0) return Math.round(scaled).toString();

            // toFixed clamps precision, parseFloat strips trailing zeros & fixes '-0'
            return parseFloat(scaled.toFixed(precision)).toString();
        }

        formatCoordinate(value) { 
            return this.formatNumberSafe(value, this.config.coordinateDecimals, this.outputScale); 
        }

        /**
         * @param {boolean} [inverseTime] - true when F is a G93 duration
         *        (1/min). Inverse time is dimensionless: G20 must not scale it.
         */
        formatFeed(value, inverseTime = false) {
            return this.formatNumberSafe(value, this.config.feedDecimals,
                inverseTime ? 1.0 : this.outputScale);
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
            return this.formatNumberSafe(
                value, this.config.rotaryDecimals ?? this.config.coordinateDecimals, 1.0);
        }

        formatSpindle(value) { 
            return this.formatNumberSafe(value, this.config.spindleDecimals); 
        }

        /**
         * Formats dwell time for the P parameter.
         */
        formatDwell(seconds) {
            // Standard G-code (GRBL, etc.) expects seconds for G4 P
            return parseFloat(seconds.toFixed(3));
        }

        generateArc(cmd) {
            if (!this.config.supportsArcCommands) {
                return this.generateLinear(cmd);
            }

            const gCommand = cmd.type === 'ARC_CW' ? 'G2' : 'G3';
            const isFullCircle = this.isFullCircle(cmd);

            // Determine if G-code command output is needed 
            const needsGCode = !this.config.modalCommands || 
                            this.modalState.motionMode !== gCommand ||
                            isFullCircle;  // Full circles always need explicit G-code

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
                    coords.push(`Z${this.formatCoordinate(cmd.z)}`);
                    hasMotion = true;
                }
                this.currentPosition.z = cmd.z;
            }

            // Arc parameters - always output if present
            if (this.config.arcFormat === 'IJ') {
                if (cmd.i !== null && cmd.i !== undefined) {
                    coords.push(`I${this.formatCoordinate(cmd.i)}`);
                }
                if (cmd.j !== null && cmd.j !== undefined) {
                    coords.push(`J${this.formatCoordinate(cmd.j)}`);
                }
            } else if (this.config.arcFormat === 'R') {
                const radius = Math.hypot(cmd.i ?? 0, cmd.j ?? 0);
                if (radius > PRECISION) {
                    coords.push(`R${this.formatCoordinate(radius)}`);
                }
            }

            // Feed rate handling
            if (cmd.f !== undefined && cmd.f !== null) {
                // Under inverse time (G93) F is a per-block DURATION, not a
                // modal velocity - the controller faults on an interpolated
                // block without one. Modal suppression must not apply.
                const invTime = this.modalState.feedRateMode === 'G93';
                const feedChanged = invTime || this.currentFeed === null ||
                                Math.abs(cmd.f - this.currentFeed) > PRECISION;
                if (feedChanged) {
                    coords.push(`F${this.formatFeed(cmd.f, invTime)}`);
                    this.currentFeed = cmd.f;
                }
            }

            // Build final command (only output if there's either a mode change or actual motion)
            if (!needsGCode && !hasMotion) {
                return '';
            }

            let code = needsGCode ? gCommand : '';
            if (coords.length > 0) {
                code += (code ? ' ' : '') + coords.join(' ');
            }

            if (needsGCode) {
                this.modalState.motionMode = gCommand;
            }

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
         * shared, including the 4th-axis rules that previously had to be
         * kept in sync by hand in two places.
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
            emit('Z', 'z', cmd.z, coord);

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
            if (!hasMotion) {
                return '';
            }

            let code = needsGCode ? 'G0' : '';
            if (coords.length > 0) {
                code += (code ? ' ' : '') + coords.join(' ');
            }

            if (needsGCode) {
                this.modalState.motionMode = 'G0';
            }

            return code;
        }

        generateLinear(cmd) {
            const needsGCode = !this.config.modalCommands || this.modalState.motionMode !== 'G1';
            const { coords, hasMotion } = this._motionCoords(cmd, needsGCode);

            // Feed rate
            if (cmd.f !== undefined && cmd.f !== null) {
                const feedChanged = this.currentFeed === null ||
                                Math.abs(cmd.f - this.currentFeed) > PRECISION;
                if (feedChanged) {
                    coords.push(`F${this.formatFeed(cmd.f)}`);
                    this.currentFeed = cmd.f;
                }
            }

            // Only output if there's a mode change or actual motion
            if (!needsGCode && !hasMotion) {
                return '';
            }

            let code = needsGCode ? 'G1' : '';
            if (coords.length > 0) {
                code += (code ? ' ' : '') + coords.join(' ');
            }

            if (needsGCode) {
                this.modalState.motionMode = 'G1';
            }

            return code;
        }

        generatePlunge(cmd) {
            return this.generateLinear(cmd);
        }

        generateRetract(cmd) {
            return this.generateRapid(cmd);
        }

        generateDwell(cmd) {
            const duration = cmd.dwell || cmd.duration || 0;
            return `G4 P${this.formatDwell(duration)}`;
        }

        processCommand(cmd) {
            switch (cmd.type) {
                case 'RAPID': return this.generateRapid(cmd);
                case 'LINEAR': return this.generateLinear(cmd);
                case 'ARC_CW':
                case 'ARC_CCW': return this.generateArc(cmd);
                case 'PLUNGE': return this.generatePlunge(cmd);
                case 'RETRACT': return this.generateRetract(cmd);
                case 'DWELL': return this.generateDwell(cmd);
                case 'CANNED_SIMPLE': 
                    if (this.generateSimpleDrill) return this.generateSimpleDrill({x: cmd.x, y: cmd.y}, cmd.z, cmd.retract, cmd.f, cmd.dwell);
                    return '';
                case 'CANNED_PECK':
                    // Route to G73 if requested AND supported by the specific post-processor
                    if (cmd.cycleType === 'G73' && this.generateChipBreakDrill) {
                        return this.generateChipBreakDrill({x: cmd.x, y: cmd.y}, cmd.z, cmd.retract, cmd.peckDepth, cmd.f);
                    } 
                    // Fallback to G83 if G73 isn't available, or if G83 was explicitly requested
                    else if (this.generatePeckDrill) {
                        // Pass cmd.cycleType so it doesn't automatically default to G83
                        return this.generatePeckDrill({x: cmd.x, y: cmd.y}, cmd.z, cmd.retract, cmd.peckDepth, cmd.f, cmd.cycleType);
                    }
                    return '';
                default:
                    return '';
            }
        }

        /**
         * G81 - Simple drilling cycle (no dwell).
         * G82 - Drilling cycle with dwell at bottom.
         * Dwell parameter P is in milliseconds for UCCNC.
         */
        generateSimpleDrill(position, depth, retract, feedRate, dwellTime) {
            let line = '';

            // Emit cycle code only on first hole or if changed
            const cycleCode = dwellTime > 0 ? 'G82' : 'G81';
            if (cycleCode !== this.cannedState.cycleType) {
                line += cycleCode + ' ';
                this.cannedState.cycleType = cycleCode;
            }

            // Always emit XY (position changes every hole)
            line += `X${this.formatCoordinate(position.x)} Y${this.formatCoordinate(position.y)}`;

            // Emit Z, R, F, P only if changed from last canned command
            if (depth !== this.cannedState.z) {
                line += ` Z${this.formatCoordinate(depth)}`;
                this.cannedState.z = depth;
            }
            if (retract !== this.cannedState.r) {
                line += ` R${this.formatCoordinate(retract)}`;
                this.cannedState.r = retract;
            }
            if (feedRate !== this.cannedState.f) {
                line += ` F${this.formatFeed(feedRate)}`;
                this.cannedState.f = feedRate;
            }
            if (dwellTime > 0 && dwellTime !== this.cannedState.dwell) {
                line += ` P${this.formatDwell(dwellTime)}`;
                this.cannedState.dwell = dwellTime;
            }

            return line;
        }

        /**
         * G83 - Peck drilling cycle (full retract between pecks).
         */
        generatePeckDrill(position, depth, retract, peckDepth, feedRate, cycleType = 'G83') {
            let line = '';

            if (cycleType !== this.cannedState.cycleType) {
                line += cycleType + ' ';
                this.cannedState.cycleType = cycleType;
            }

            line += `X${this.formatCoordinate(position.x)} Y${this.formatCoordinate(position.y)}`;

            if (depth !== this.cannedState.z) {
                line += ` Z${this.formatCoordinate(depth)}`;
                this.cannedState.z = depth;
            }
            if (retract !== this.cannedState.r) {
                line += ` R${this.formatCoordinate(retract)}`;
                this.cannedState.r = retract;
            }
            if (peckDepth !== this.cannedState.q) {
                line += ` Q${this.formatCoordinate(peckDepth)}`;
                this.cannedState.q = peckDepth;
            }
            if (feedRate !== this.cannedState.f) {
                line += ` F${this.formatFeed(feedRate)}`;
                this.cannedState.f = feedRate;
            }

            return line;
        }

        /**
         * G73 - Chip-breaking cycle (partial retract between pecks).
         * Faster than G83 for materials that produce stringy chips.
         */
        generateChipBreakDrill(position, depth, retract, peckDepth, feedRate) {
            let line = '';

            if ('G73' !== this.cannedState.cycleType) {
                line += 'G73 ';
                this.cannedState.cycleType = 'G73';
            }

            line += `X${this.formatCoordinate(position.x)} Y${this.formatCoordinate(position.y)}`;

            if (depth !== this.cannedState.z) {
                line += ` Z${this.formatCoordinate(depth)}`;
                this.cannedState.z = depth;
            }
            if (retract !== this.cannedState.r) {
                line += ` R${this.formatCoordinate(retract)}`;
                this.cannedState.r = retract;
            }
            if (peckDepth !== this.cannedState.q) {
                line += ` Q${this.formatCoordinate(peckDepth)}`;
                this.cannedState.q = peckDepth;
            }
            if (feedRate !== this.cannedState.f) {
                line += ` F${this.formatFeed(feedRate)}`;
                this.cannedState.f = feedRate;
            }

            return line;
        }

        cancelCannedCycle(options) {
            // Reset modal tracking so next canned cycle emits full parameters
            this.cannedState = {
                cycleType: null, z: null, r: null,
                q: null, f: null, dwell: null
            };
            return 'G80';
        }

        /**
         * Optional N-word line numbering. Applied ONCE by GCodeGenerator to
         * the finished program, so header, spindle, motion and footer blocks
         * all number off one counter. No-op unless config.lineNumbering.
         *
         * Skipped: blank lines, comment-only lines, and blocks that already
         * own their address - '%' tape marks, O-numbers, an existing N, and
         * '/' block-delete (numbering it would change what the switch skips).
         */
        applyLineNumbers(gcodeText) {
            if (!this.config.lineNumbering) return gcodeText;
            const step  = this.config.lineNumberStep  || 10;
            const start = this.config.lineNumberStart ?? step;
            const max   = this.config.lineNumberMax   || 99999;
            let n = start;

            return gcodeText.split('\n').map(line => {
                const t = line.trim();
                if (!t) return line;
                if (t[0] === '%' || t[0] === '/' || t[0] === '(' || t[0] === ';') return line;
                if (/^[NnOo]\d/.test(t)) return line;
                const num = n;
                n += step;
                // Wrap rather than overflow the control's block-number field.
                if (n > max) n = start;
                return `N${num} ${line}`;
            }).join('\n');
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
            const c = options.comments || {};
            return this.appendComment(mode,
                mode === 'G93' ? (c.inverseTimeOn || 'Inverse time feed mode')
                               : (c.inverseTimeOff || 'Units per minute feed mode'),
                options);
        }

        /** Machine-limit validation, instance-free. Roland does not extend this
         * class but drives the same hardware limits, so the checks live here as a
         * static and both posts pass their own state in.
         * @param {Object} cmd MotionCommand
         * @param {Object} options generator options (maxFeed, maxSafeDepth)
         * @param {Object} ctx { maxRapidRate, inverseTime, maxInverseTime, rotaryAxisWord }
         * @returns {{warnings: string[], errors: string[]}}
         */
        static validateCommandLimits(cmd, options = {}, ctx = {}) {
            const warnings = [];
            const errors = [];

            const maxFeed = options.maxFeed || ctx.maxRapidRate;

            // THREE independent depth limits exist, deliberately:
            //  1. profile-*.json max on the depth parameter - stops the user
            //     typing a value the machine cannot reach.
            //  2. BaseOperationPanel.checkDepthLimits - warns pre-generation
            //     using resolveSurfaceZ, so stock thickness and Z-zero are in
            //     the maths. This is the one the operator actually reads.
            //  3. here - the last gate, per command at emission, and the only
            //     one that sees post-processor and 3D-generator output.
            // (2) is authoritative for user feedback; (3) is authoritative for
            // correctness. (1) can mask (2) if its max is tighter than the
            // machine's - check the profile before suspecting this method.
            // REVIEW - maxSafeDepth needs to be managed per app since valid depths
            // aren't the same. Single source of truth, or 1 warning + 1 validation.
            const maxSafeDepth = options.maxSafeDepth;

            // Feed rate check - UNIT-AWARE. Under G93 F is 1/minutes (the
            // reciprocal of the move's duration), not mm/min:
            // convertDevelopedToRotary emits F = feed / pathLength, so a 0.3mm
            // segment at 1500mm/min is a legitimate F5000. Testing that against
            // maxRapidRate compared a duration to a velocity and warned on nearly
            // every short rotary move. The real G93 ceiling is the post's declared
            // maxInverseTime - which convertDevelopedToRotary already clamps to.
            if (cmd.f !== undefined && cmd.f !== null) {
                const invTime = ctx.inverseTime === true;
                const limit = invTime ? (ctx.maxInverseTime || 9999.99) : maxFeed;
                if (cmd.f > limit) {
                    warnings.push(invTime
                        ? `Inverse-time F${cmd.f.toFixed(2)} exceeds the post's maximum of ${limit}.`
                        : `Feed rate F${cmd.f} exceeds machine maximum of ${maxFeed}.`);
                }
            }

            // Critical Z-Plunge Check. FLAT-STOCK ONLY: a 4th-axis plan's Z is
            // referenced to the rotary centerline or blank/face surface - stock
            // thickness has no meaning there, and a legitimate 'surface'-datum
            // rotary job cuts far past any flat-stock limit. rotaryAxisWord is set
            // per plan by the generator exactly when a plan is 4th-axis.
            if (!ctx.rotaryAxisWord
                && cmd.z !== undefined && cmd.z !== null
                && typeof maxSafeDepth === 'number' && cmd.z < maxSafeDepth) {
                warnings.push(`Commanded Z depth (${cmd.z.toFixed(3)}mm) exceeds the machine's configured max safe depth (${maxSafeDepth}mm). Verify your stock thickness and Z-zero.`);
            }

            return { warnings: warnings, errors: errors };
        }

        validateCommand(cmd, options = {}) {
            return BasePostProcessor.validateCommandLimits(cmd, options, {
                maxRapidRate: this.descriptor.limits.maxRapidRate,
                inverseTime: this.modalState.feedRateMode === 'G93',
                maxInverseTime: this.rotaryCaps?.maxInverseTime,
                rotaryAxisWord: this.rotaryAxisWord
            });
        }

        resetState() {
            this.currentPosition = { x: 0, y: 0, z: 0, a: null };
            this.currentFeed = null;
            this.currentSpindle = 0;
            // null, not 0: 0 is a legal T word on some controls and would
            // suppress the first real selection.
            this.currentToolNumber = null;
            this.rotaryAxisWord = null;
            this.rotaryWordUsed = null;
            this.tlcMode = 'none';
            // Canned cycle modal state - tracks last-emitted parameters
            this.cannedState = {
                cycleType: null,
                z: null,
                r: null,
                q: null,
                f: null,
                dwell: null
            };
            this.modalState = {
                motionMode: null,
                coordinateMode: 'G90',
                units: 'G21',
                plane: 'G17',
                feedRateMode: 'G94'
            };
        }
    }

    window.BasePostProcessor = BasePostProcessor;
})();