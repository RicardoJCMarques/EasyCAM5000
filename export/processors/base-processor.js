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
                supportsToolLengthComp: false,
                pauseAfterToolChange: false,
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
                    supportsArcCommands: this.config.supportsArcCommands !== false,
                    supportsCannedCycles: this.config.supportsCannedCycles || false,
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
            headerLines.push('');

            // Get the template from the options, or a default
            let startCode = options.startCode;

            // Replace placeholders
            const toolNum = options.toolNumber ?? 1;
            startCode = startCode.replace(/{toolNumber}/g, toolNum);

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

        // TEST DRAFT - DO NOT CONNECT
        /*
        generateToolChange(tool, options) {
            if (!this.config.supportsToolChange) return '';

            const lines = [];
            const c = options.comments || {};
            const safeZ = options.safeZ || this.config.safetyHeight;
            const toolNumber = tool.number || options.toolNumber || 1;

            lines.push('');
            this.pushCommentLine(lines, (c.toolChange || 'Tool change: {name}').replace('{name}', tool.name || tool.id), options);
            this.pushCommentLine(lines, (c.toolDiameter || 'Diameter: {diameter}mm').replace('{diameter}', tool.diameter), options);

            // Stop Spindle and Coolant
            const stopGcode = this.setSpindle(0, 0, options);
            if (stopGcode) {
                lines.push(stopGcode);
            } else if (this.currentSpindle > 0) {
                lines.push(this.appendComment('M5', c.spindleStop, options));
                this.currentSpindle = 0;
            }

            if (options.coolant && options.coolant !== 'none') {
                lines.push(this.appendComment('M9', c.coolantOff, options));
            }

            // Retract to Safe Z
            lines.push(this.appendComment(`G0 Z${this.formatCoordinate(safeZ)}`, c.retractSafeZ, options));
            this.currentPosition.z = safeZ;

            // Tool Change Command
            if (this.config.useM6) {
                lines.push(`T${toolNumber} M6`);
            }

            // Tool Length Compensation
            if (this.config.supportsToolLengthComp) {
                lines.push(this.appendComment(`G43 H${toolNumber}`, c.toolLengthComp, options));
            }

            // Pause for Manual Change
            if (this.config.pauseAfterToolChange) {
                lines.push(this.appendComment('M0', c.toolChangePause, options));
            }
            lines.push('');

            // Restart Spindle
            const spindleSpeed = tool.spindleSpeed || options.spindleSpeed || 12000;
            const startGcode = this.setSpindle(spindleSpeed, tool.spindleDwell || 0, options);
            if (startGcode) {
                lines.push(startGcode);
            }

            // Restart Coolant
            if (options.coolant && options.coolant !== 'none') {
                if (options.coolant === 'mist') {
                    lines.push(this.appendComment('M7', c.coolantMist, options));
                } else if (options.coolant === 'flood') {
                    lines.push(this.appendComment('M8', c.coolantFlood, options));
                }
            }

            lines.push('');
            return lines.join('\n');
        }
        */

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

        validateCommand(cmd, options = {}) {
            const warnings = [];
            const errors = [];

             // Grab limits from the options context passed by the generator
            const maxFeed = options.maxFeed || this.descriptor.limits.maxRapidRate;
            // REVIEW - double check maxSafeDepth is wired properly, there's a limit on the parameter manager that may not let this trip. It could be made a per app value?
            const maxSafeDepth = options.maxSafeDepth;

            // Feed rate check - UNIT-AWARE. Under G93 F is 1/minutes (the
            // reciprocal of the move's duration), not mm/min:
            // convertDevelopedToRotary emits F = feed / pathLength, so a
            // 0.3mm segment at 1500mm/min is a legitimate F5000. Testing
            // that against maxRapidRate compared a duration to a velocity
            // and warned on nearly every short rotary move. The real G93
            // ceiling is the post's declared maxInverseTime - which
            // convertDevelopedToRotary already clamps to.
            if (cmd.f !== undefined && cmd.f !== null) {
                const invTime = this.modalState.feedRateMode === 'G93';
                const limit = invTime
                    ? (this.rotaryCaps?.maxInverseTime || 9999.99)
                    : maxFeed;
                if (cmd.f > limit) {
                    warnings.push(invTime
                        ? `Inverse-time F${cmd.f.toFixed(2)} exceeds the post's ` +
                          `maximum of ${limit}.`
                        : `Feed rate F${cmd.f} exceeds machine maximum of ${maxFeed}.`);
                }
            }

            // Critical Z-Plunge Check (catch dangerous plunges). FLAT-STOCK
            // ONLY: a 4th-axis plan's Z is referenced to the rotary
            // centerline or blank/face surface - stock thickness has no
            // meaning there, and a legitimate 'surface'-datum rotary job
            // cuts far past any flat-stock limit. rotaryAxisWord is set per
            // plan by the generator exactly when a plan is 4th-axis.
            if (!this.rotaryAxisWord &&
                cmd.z !== undefined && cmd.z !== null) {
                if (typeof maxSafeDepth === 'number' && cmd.z < maxSafeDepth) {
                    warnings.push(`Commanded Z depth (${cmd.z.toFixed(3)}mm) exceeds the machine's configured max safe depth (${maxSafeDepth}mm). Verify your stock thickness and Z-zero.`);
                }
            }

            return { warnings, errors };
        }

        resetState() {
            this.currentPosition = { x: 0, y: 0, z: 0, a: null };
            this.currentFeed = null;
            this.currentSpindle = 0;
            this.rotaryAxisWord = null;
            this.rotaryWordUsed = null;
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