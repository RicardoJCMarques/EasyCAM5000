/*!
 * @file        export/processors/roland-processor.js
 * @description Roland RML-1 post-processing module
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
     * Roland RML-1 Post-Processor
     * 
     * Implements the same interface as BasePostProcessor for use by GCodeGenerator.
     * Does NOT extend BasePostProcessor - RML is a completely different command language.
     * 
     * TWO COMMAND MODELS:
     * 
     * 3D Mode (MDX-40A+):
     *   All motion via Z x,y,z; command. Speed controlled by !VZ/V.
     *   No PU/PD/VS used.
     * 
     * 2.5D Mode (PU/PD):
     *   PU x,y; - rapid move to (x,y) at !PZ z2 height
     *   PD x,y; - cut move to (x,y) at !PZ z1 depth, speed VS
     *   !PZ z1,z2; - set depth register (z1=PD depth, z2=PU height)
     *   VS speed; - set XY cutting velocity (mm/sec)
     *   !VZ speed; - set Z/plunge velocity (mm/sec)
     * 
     * Common commands:
     *   PA; - Plot Absolute mode
     *   !MC 0|1; - Motor Control off/on
     *   !RC value; - Rotation Control (RPM or index 1-15)
     *   !DW ms; - Dwell in milliseconds
     * 
     * Coordinates are integer "steps" (mm x stepsPerMM).
     */
    class RolandPostProcessor {
        constructor(processorConfig = {}) { // REVIEW - processorConfig isn't used.
            this.name = 'roland';
            this.config = {
                fileExtension: '.rml',
                // RML-1 has no tool-select verb and no unconditional pause.
                // The command set is plotter-derived (PU/PD/Z/!VZ/!PZ/!MC/
                // !RC/!DW/;;^DF) - there is no T word, no M6 equivalent, and
                // !DW is a timed dwell, not an operator wait. The MDX-50 has
                // an automatic tool LENGTH sensor, not a changer.
                //
                // Multi-tool Roland work is one file per tool, which the
                // multi-file and split-drill export paths already produce.
                // Do not flip this true without a machine-verified in-file
                // pause: with it true, the export modal offers the operator a
                // tool-change checkbox that emits nothing.
                supportsToolChange: false,
                supportsArcCommands: false,
                supportsCannedCycles: false,
                supportsLineNumbers: false
            };

            // Machine Profiles
            // Authoritative hardware data for all supported Roland machines.
            this.profiles = {
                'mdx15': {
                    label: 'MDX-15',
                    series: 'legacy',
                    cmdProtocol: 'legacy',
                    stepsPerMM: 40,
                    maxFeedXY: 15,
                    maxFeedZ: 15,
                    spindleMode: 'fixed',
                    spindleFixed: 6500,
                    spindleRange: null,
                    zMode: '3d',
                    initCommand: ';;^IN',
                    endCommand: '!MC0;\nPU0,0;\n;;^IN',
                    supportsRC: false,
                    supportsDwell: false,
                    workArea: { x: 152, y: 101, z: 60.5 },
                    warnings: [
                        'Serial interface requires hardware flow control (RTS/CTS)',
                        'Use FTDI-based USB-to-Serial adapters for reliable handshaking'
                    ]
                },
                'mdx20': {
                    label: 'MDX-20',
                    series: 'legacy',
                    cmdProtocol: 'legacy',
                    stepsPerMM: 40,
                    maxFeedXY: 15,
                    maxFeedZ: 15,
                    spindleMode: 'manual',
                    spindleRange: null,
                    zMode: '3d',
                    initCommand: ';;^IN',
                    endCommand: '!MC0;\nPU0,0;\n;;^IN',
                    supportsRC: false,
                    supportsDwell: false,
                    workArea: { x: 203, y: 152, z: 60.5 },
                    warnings: ['Serial interface requires hardware flow control (RTS/CTS)']
                },
                'imodela': {
                    label: 'iModela (iM-01)',
                    series: 'legacy',
                    cmdProtocol: 'legacy',
                    stepsPerMM: 100,
                    maxFeedXY: 6,
                    maxFeedZ: 6,
                    spindleMode: 'fixed',
                    spindleFixed: null,
                    spindleRange: null,
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: false,
                    supportsDwell: true,
                    workArea: { x: 86, y: 55, z: 26 },
                    warnings: ['Low rigidity - use conservative feed rates for PCB']
                },
                'srm20': {
                    label: 'SRM-20 (monoFab)',
                    series: 'monofab',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 30,
                    maxFeedZ: 30,
                    spindleMode: 'direct',
                    spindleRange: { min: 3000, max: 7000 },
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: true,
                    supportsDwell: true,
                    workArea: { x: 203, y: 152, z: 60.5 },
                    warnings: [
                        'Output must be clean RML - VPanel rejects files with syntax errors',
                        'RML mode has 0.01mm resolution; NC Code mode offers 0.001mm for ultra-fine work'
                    ]
                },
                'mdx40': {
                    label: 'MDX-40A',
                    series: 'pro',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 50,
                    maxFeedZ: 50,
                    spindleMode: 'direct',
                    spindleRange: { min: 4500, max: 15000 },
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: true,
                    supportsDwell: true,
                    workArea: { x: 305, y: 305, z: 105 },
                    warnings: []
                },
                'mdx50': {
                    label: 'MDX-50',
                    series: 'pro',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 60,
                    maxFeedZ: 60,
                    spindleMode: 'direct',
                    spindleRange: { min: 4500, max: 15000 },
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: true,
                    supportsATC: true,
                    supportsDwell: true,
                    workArea: { x: 400, y: 305, z: 135 },
                    warnings: []
                },
                'mdx540': {
                    label: 'MDX-540 / MDX-540S',
                    series: 'pro',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 125,
                    maxFeedZ: 125,
                    spindleMode: 'direct',
                    spindleRange: { min: 3000, max: 12000 },
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: true,
                    supportsATC: true,
                    supportsDwell: true,
                    workArea: { x: 400, y: 305, z: 155 },
                    warnings: []
                },
                'egx350': {
                    label: 'EGX-350',
                    series: 'engraver',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 60,
                    maxFeedZ: 60,
                    spindleMode: 'direct',
                    spindleRange: { min: 8000, max: 20000 },
                    zMode: '3d',
                    initCommand: ';;^DF',
                    endCommand: '!MC0;\nPU0,0;\n;;^DF',
                    supportsRC: true,
                    supportsDwell: true,
                    workArea: { x: 305, y: 216, z: 40 },
                    warnings: ['High spindle speed - excellent for PCB isolation with V-bits']
                },
                'custom': {
                    label: 'Custom Machine',
                    series: 'custom',
                    cmdProtocol: 'modern',
                    stepsPerMM: 100,
                    maxFeedXY: 60,
                    maxFeedZ: 60,
                    spindleMode: 'direct',
                    spindleRange: { min: 0, max: 30000 },
                    zMode: '3d',
                    initCommand: 'PA;PA;',
                    endCommand: '!MC0;PU0,0;',
                    supportsRC: true,
                    supportsDwell: true,
                    workArea: { x: 999, y: 999, z: 999 },
                    warnings: ['Custom configuration - verify all parameters against your machine manual']
                }
            };

            // Public descriptor
            this.descriptor = {
                id: 'roland',
                label: 'Roland (RML) (Experimental)',
                fileExtension: '.rml',
                capabilities: {
                    supportsToolChange: false,
                    supportsLineNumbers: false,
                    useM6: false,
                    emitsInitialTool: false,
                    // RML-1 has no tool-length word. The MDX-50's length sensor
                    // is a machine-side operation, not a file command.
                    toolLengthComp: { modes: ['none'], default: 'none' },
                    supportsToolLengthComp: false,
                    pauseAfterToolChange: false,
                    // RML-1 has no comment syntax - ';' terminates a command.
                    supportsComments: false,
                    supportsArcCommands: false,
                    supportsCannedCycles: false,
                    arcFormat: null,
                    // No rotary word in this command set. Declared empty rather
                    // than absent so consumers read a normalized shape.
                    rotary: { routes: [], axisWords: [], inverseTime: false,
                              maxInverseTime: 0, indexDwell: 0, continuous: false },
                },
                defaults: {
                    startCode: ';;^DF\nPA;',
                    endCode: '!MC0;\n;;^DF',
                },
                limits: {
                    maxSpindleSpeed: 15000,
                    maxRapidRate: 60,
                }
            };

            this.resetState();
        }

        /**
         * Returns a profile by model ID, with fallback to 'custom'.
         */
        getProfile(modelId) {
            return this.profiles[modelId] || this.profiles['custom'];
        }

        /**
         * RML machine limits, applied to the job context before it freezes.
         *
         * 2.5D machines drive Z through the PU/PD depth register, so there is
         * no interpolated entry and no partial-depth tab; a mill in a 2.5D
         * profile must also step down, because the register cannot ramp.
         * Feed clamps are hardware maxima - VS above them is rejected by the
         * controller rather than reduced.
         */
        prepareContext(ctx, operation) {
            const rolandSettings = ctx.processorSettings?.roland || {};
            const profile = this.getProfile(rolandSettings.rolandModel);
            const zMode = rolandSettings.rolandZMode || profile.zMode || '3d';

            if (zMode === '2.5d') {
                ctx.strategy.entryType = 'plunge';

                if (operation.type === 'cutout') {
                    ctx.strategy.cutout.tabs = 0;
                }

                if (operation.type === 'drill' && ctx.strategy.drill.millHoles) {
                    ctx.strategy.multiDepth = true;
                    const maxSafeStep = ctx.tool.diameter * 0.5;
                    if (Math.abs(ctx.strategy.depthPerPass) > maxSafeStep) {
                        ctx.strategy.depthPerPass = maxSafeStep;
                    }
                }
            }

            // Profile feeds are mm/sec; the context carries mm/min.
            const maxCutFeed = profile.maxFeedXY * 60;
            const maxPlungeFeed = profile.maxFeedZ * 60;
            if (ctx.cutting.feedRate > maxCutFeed) ctx.cutting.feedRate = maxCutFeed;
            if (ctx.cutting.plungeRate > maxPlungeFeed) ctx.cutting.plungeRate = maxPlungeFeed;
        }

        // GCodeGenerator calls these on whatever post is active. RML has no
        // feed-rate mode word, no canned cycles and no line numbers, so the
        // honest answer is "nothing to emit" - not "method missing".
        setFeedRateMode() { return ''; }

        cancelCannedCycle() { return ''; }

        // RML is not G-code and has no N word - `N10 PU0,0;` is a syntax
        // error, not a block the sender might tolerate. Unconditional, and
        // not driven by settings.gcode.lineNumbers.
        applyLineNumbers(gcodeText) { return gcodeText; }

        // Machine limits are machine facts, not G-code facts - RML output is
        // bounded by the same maxFeed and maxSafeDepth as every other post.
        // RML has no feed-rate mode word and no rotary word, so F is always a
        // velocity and Z is always flat-stock referenced.
        validateCommand(cmd, options = {}) {
            return BasePostProcessor.validateCommandLimits(cmd, options, {
                maxRapidRate: this.descriptor.limits.maxRapidRate,
                inverseTime: false,
                maxInverseTime: 0,
                rotaryAxisWord: null
            });
        }

        resetState() {
            this.currentPosition = { x: 0, y: 0, z: 0 };
            this.currentSpindle = 0;
            // Not a BasePostProcessor subclass - the generator reads this
            // field on whatever processor is active, so it has to exist here
            // too even though RML can never change a tool.
            this.currentToolNumber = null;
            this.currentFeed = null;    // VS value (mm/min internally, for 2.5D XY)
            this.currentVZ = null;      // !VZ value (mm/min internally)

            // !PZ register tracking (in mm, converted on output)
            this.pzDownMM = 0;
            this.pzUpMM = 5.0;

            // Machine parameters (set from options in generateHeader)
            this.stepsPerMM = 100;
            this.maxFeedXY = 60;        // mm/sec - machine maximum for XY
            this.maxFeedZ = 60;         // mm/sec - machine maximum for Z
            this.zMode = '3d';
            this.spindleMode = 'direct';
            this.travelZ = 3.0;
            this.safeZ = 5.0;
            this.model = 'mdx50';
            this.useLegacyVelocity = false;

            // Active profile reference (set in generateHeader)
            this.profile = null;
        }

        generateHeader(options) {
            // Load profile from internal profiles, fall back to options
            this.model = options.rolandModel || 'mdx50';
            this.profile = this.getProfile(this.model);

            // Read machine parameters - profile values are authoritative, options are overrides
            this.stepsPerMM = options.rolandStepsPerMM || this.profile?.stepsPerMM || 100;
            this.maxFeedXY = this.profile?.maxFeedXY || options.rolandMaxFeed || 60;
            this.maxFeedZ = this.profile?.maxFeedZ || this.maxFeedXY;
            this.zMode = options.rolandZMode || this.profile?.zMode || '3d';
            this.spindleMode = options.rolandSpindleMode || this.profile?.spindleMode || 'direct';
            this.travelZ = options.travelZ || 3.0;
            this.safeZ = options.safeZ || 5.0;
            this.useLegacyVelocity = this.profile?.cmdProtocol === 'legacy';

            const lines = [];

            // User start code (includes machine init ;;^IN/;;^DF + PA; by default)
            // RML has no comment syntax - semicolons are command terminators.
            // Never inject "; text" lines - they produce junk commands / 1025 errors.
            if (options.startCode) {
                lines.push(options.startCode);
            }

            // Velocity setup - differs by Z mode and protocol
            const firstPlan = options.firstPlan;
            const velCmd = this.useLegacyVelocity ? 'V' : '!VZ';

            if (this.zMode === '3d') {
                // 3D mode: Z command uses V/!VZ speed for ALL axes.
                // VS is irrelevant - never set it. Only V/!VZ matters.
                const cutFeed = (firstPlan && firstPlan.metadata) ? firstPlan.metadata.feedRate : 150;
                lines.push(`${velCmd}${this.mmMinToVS(cutFeed)};`);
                this.currentVZ = cutFeed;
            } else {
                // 2.5D mode: VS for XY cutting (PD), V/!VZ for plunge speed
                const cutFeed = (firstPlan && firstPlan.metadata) ? firstPlan.metadata.feedRate : 150;
                lines.push(`VS${this.mmMinToVS(cutFeed)};`);
                this.currentFeed = cutFeed;

                const plungeRate = (firstPlan && firstPlan.metadata && firstPlan.metadata.plungeRate)
                    ? firstPlan.metadata.plungeRate : 60;
                lines.push(`${velCmd}${this.mmMinToVS(plungeRate)};`);
                this.currentVZ = plungeRate;
            }

            // Z parameters - safety registers (used as fallback in both modes)
            this.pzDownMM = 0;
            this.pzUpMM = this.travelZ;
            lines.push(`!PZ${this.fmtCoord(this.pzDownMM)},${this.fmtCoord(this.pzUpMM)};`);

            // Spindle - after all setup params are established
            if (firstPlan && firstPlan.metadata && firstPlan.metadata.spindleSpeed > 0) {
                const speed = firstPlan.metadata.spindleSpeed;

                // Only emit !RC if the machine supports software spindle control
                if (this.spindleMode === 'direct') {
                    lines.push(`!RC${Math.round(speed)};`);
                }
                // 'manual': skip !RC entirely - user controls spindle physically

                lines.push('!MC1;');

                const dwell = firstPlan.metadata.spindleDwell || 0;
                if (dwell > 0 && (this.profile?.supportsDwell !== false)) {
                    lines.push(`!DW${Math.round(dwell * 1000)};`);
                }
                this.currentSpindle = speed;
            }

            return lines.join('\n');
        }

        generateFooter(options) {
            // endCode from settings (defaults to '!MC0;\n;;^DF' or '!MC0;\n;;^IN')
            return options.endCode || '!MC0;';
        }

        /**
         * RML-1 cannot change tools. Kept as an explicit no-op rather than
         * omitted: GCodeGenerator reads the method off whichever processor is
         * active, and supportsToolChange:false already stops it being called.
         * See the config comment for what would have to be verified on real
         * hardware before this becomes real.
         */
        generateToolChange(tool, options) {
            return '';
        }

        generateInitialTool(tool, options) {
            return '';
        }

        setSpindle(speed, dwell = 0, options = {}) {
            const wantOn = speed > 0;
            const wasOn = this.currentSpindle > 0;

            if (wantOn === wasOn && (!wantOn || speed === this.currentSpindle)) {
                return null;
            }

            const lines = [];

            if (wantOn && !wasOn) {
                // Turning on
                if (this.spindleMode === 'direct') {
                    lines.push(`!RC${Math.round(speed)};`);
                }
                lines.push('!MC1;');
                if (dwell > 0 && (this.profile?.supportsDwell !== false)) {
                    lines.push(`!DW${Math.round(dwell * 1000)};`);
                }
                this.currentSpindle = speed;

            } else if (!wantOn && wasOn) {
                // Turning off
                lines.push('!MC0;');
                this.currentSpindle = 0;

            } else if (wantOn && wasOn && speed !== this.currentSpindle) {
                // Speed change while running
                if (this.spindleMode === 'direct') {
                    lines.push(`!RC${Math.round(speed)};`);
                }
                this.currentSpindle = speed;
            }

            return lines.join('\n');
        }

        /**
         * Main dispatch - routes to the correct command model.
         */
        processCommand(cmd) {
            return this.zMode === '3d' ? this.process3D(cmd) : this.process25D(cmd);
        }

        /**
         * 3D Mode: All motion via V/!VZ + Z x,y,z; command.
         * 
         * Modern machines (MDX-40+): !VZ sets speed for Z command (all axes)
         * Legacy machines (MDX-15/20): V sets speed for Z command (all axes)
         * 
         * In both cases:
         *   - Z x,y,z; moves to absolute position at that speed
         *   - VS, PU, PD are NEVER used
         *   - Rapids = Z command at machine max speed
         *   - Cuts = Z command at cutting feed
         *   - Plunges = Z command at plunge feed
         */
        process3D(cmd) {
            const targetX = cmd.x ?? this.currentPosition.x;
            const targetY = cmd.y ?? this.currentPosition.y;
            const targetZ = cmd.z ?? this.currentPosition.z;

            // Quantize to machine steps for accurate change detection
            const stepTargetX = Math.round(targetX * this.stepsPerMM);
            const stepTargetY = Math.round(targetY * this.stepsPerMM);
            const stepTargetZ = Math.round(targetZ * this.stepsPerMM);
            const stepCurrentX = Math.round(this.currentPosition.x * this.stepsPerMM);
            const stepCurrentY = Math.round(this.currentPosition.y * this.stepsPerMM);
            const stepCurrentZ = Math.round(this.currentPosition.z * this.stepsPerMM);

            const xChanged = stepTargetX !== stepCurrentX;
            const yChanged = stepTargetY !== stepCurrentY;
            const zChanged = stepTargetZ !== stepCurrentZ;

            if (!xChanged && !yChanged && !zChanged && cmd.type !== 'DWELL') {
                return '';
            }

            const lines = [];
            const velCmd = this.useLegacyVelocity ? 'V' : '!VZ';

            switch (cmd.type) {
                case 'RAPID':
                case 'RETRACT': {
                    // Set speed to machine maximum for rapid travel
                    const rapidMmSec = Math.min(this.maxFeedXY, this.maxFeedZ);
                    const rapidMmMin = rapidMmSec * 60;
                    if (this.currentVZ === null || Math.abs(rapidMmMin - this.currentVZ) > 0.1) {
                        lines.push(`${velCmd}${this.mmMinToVS(rapidMmMin, 'combined')};`);
                        this.currentVZ = rapidMmMin;
                    }
                    lines.push(`Z${this.fmtCoord(targetX)},${this.fmtCoord(targetY)},${this.fmtCoord(targetZ)};`);
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: stepTargetZ / this.stepsPerMM
                    };
                    break;
                }

                case 'LINEAR':
                case 'PLUNGE': {
                    // Determine dominant axis for feed clamping
                    const isZOnly = !xChanged && !yChanged && zChanged;
                    const isXYOnly = (xChanged || yChanged) && !zChanged;
                    const feedAxis = isZOnly ? 'z' : isXYOnly ? 'xy' : 'combined';

                    if (cmd.f != null) {
                        if (this.currentVZ === null || Math.abs(cmd.f - this.currentVZ) > 0.1) {
                            lines.push(`${velCmd}${this.mmMinToVS(cmd.f, feedAxis)};`);
                            this.currentVZ = cmd.f;
                        }
                    }
                    lines.push(`Z${this.fmtCoord(targetX)},${this.fmtCoord(targetY)},${this.fmtCoord(targetZ)};`);
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: stepTargetZ / this.stepsPerMM
                    };
                    break;
                }

                case 'DWELL': {
                    // Legacy machines (MDX-15/20) don't support !DW
                    if (this.useLegacyVelocity && !this.profile?.supportsDwell) {
                        break; // Skip silently - no dwell capability
                    }
                    const ms = Math.round((cmd.dwell || 0) * 1000);
                    if (ms > 0) {
                        lines.push(`!DW${ms};`);
                    }
                    break;
                }

                case 'ARC_CW':
                case 'ARC_CCW': {
                    console.warn('[RolandProcessor] Arc command reached processor - should have been linearized');
                    if (cmd.f != null) {
                        if (this.currentVZ === null || Math.abs(cmd.f - this.currentVZ) > 0.1) {
                            lines.push(`${velCmd}${this.mmMinToVS(cmd.f)};`);
                            this.currentVZ = cmd.f;
                        }
                    }
                    lines.push(`Z${this.fmtCoord(targetX)},${this.fmtCoord(targetY)},${this.fmtCoord(targetZ)};`);
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: stepTargetZ / this.stepsPerMM
                    };
                    break;
                }

                default:
                    break;
            }

            return lines.join('\n');
        }

        /**
         * 2.5D Mode: PU/PD with !PZ register management.
         * 
         * Command model:
         *   - PU x,y; - pen up, move XY at PU height (z2). Speed is max.
         *   - PD x,y; - pen down to PD depth (z1), then move XY. Speed is VS.
         *   - !PZ z1,z2; - set the depth (z1) and clearance (z2) registers
         *   - VS speed; - set XY cutting speed for PD moves
         *   - !VZ speed; - set plunge speed (Z-axis movement in PD)
         * 
         * Z position is implicit: after PU it's z2, after PD it's z1.
         * No simultaneous XYZ motion is possible.
         */
        process25D(cmd) {
            const targetX = cmd.x ?? this.currentPosition.x;
            const targetY = cmd.y ?? this.currentPosition.y;
            const targetZ = cmd.z ?? this.currentPosition.z;

            // Quantize to machine steps for accurate change detection
            const stepTargetX = Math.round(targetX * this.stepsPerMM);
            const stepTargetY = Math.round(targetY * this.stepsPerMM);
            const stepTargetZ = Math.round(targetZ * this.stepsPerMM);
            const stepCurrentX = Math.round(this.currentPosition.x * this.stepsPerMM);
            const stepCurrentY = Math.round(this.currentPosition.y * this.stepsPerMM);
            const stepCurrentZ = Math.round(this.currentPosition.z * this.stepsPerMM);

            const xChanged = stepTargetX !== stepCurrentX;
            const yChanged = stepTargetY !== stepCurrentY;
            const zChanged = stepTargetZ !== stepCurrentZ;

            if (!xChanged && !yChanged && !zChanged && cmd.type !== 'DWELL') {
                return '';
            }

            const lines = [];

            switch (cmd.type) {
                case 'RAPID':
                case 'RETRACT': {
                    // Update the PU height register (z2) if Z target changed
                    if (zChanged) {
                        const pz = this.emitPZIfChanged(this.pzDownMM, targetZ);
                        if (pz) lines.push(pz);
                    }
                    lines.push(`PU${this.fmtCoord(targetX)},${this.fmtCoord(targetY)};`);
                    // After PU, machine Z is at z2 (up height). Track quantized XY.
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: this.pzUpMM
                    };
                    break;
                }

                case 'LINEAR':
                case 'PLUNGE': {
                    const velCmd = this.useLegacyVelocity ? 'V' : '!VZ';

                    // Feed rate handling
                    if (cmd.f != null) {
                        const isPlungeMove = cmd.type === 'PLUNGE' || (zChanged && !xChanged && !yChanged);
                        const isSimultaneous = zChanged && (xChanged || yChanged);

                        if (isPlungeMove || isSimultaneous) {
                            // Plunge/Z speed via V/!VZ
                            if (this.currentVZ === null || Math.abs(cmd.f - this.currentVZ) > 0.1) {
                                lines.push(`${velCmd}${this.mmMinToVS(cmd.f)};`);
                                this.currentVZ = cmd.f;
                            }
                        }
                        if (!isPlungeMove) {
                            // XY cutting speed via VS
                            if (this.currentFeed === null || Math.abs(cmd.f - this.currentFeed) > 0.1) {
                                lines.push(`VS${this.mmMinToVS(cmd.f)};`);
                                this.currentFeed = cmd.f;
                            }
                        }
                    }

                    // Update the PD depth register (z1) if Z target changed
                    if (zChanged) {
                        const pz = this.emitPZIfChanged(targetZ, this.pzUpMM);
                        if (pz) lines.push(pz);
                    }

                    lines.push(`PD${this.fmtCoord(targetX)},${this.fmtCoord(targetY)};`);
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: this.pzDownMM
                    };
                    break;
                }

                case 'DWELL': {
                    const ms = Math.round((cmd.dwell || 0) * 1000);
                    if (ms > 0) {
                        lines.push(`!DW${ms};`);
                    }
                    break;
                }

                case 'ARC_CW':
                case 'ARC_CCW': {
                    // Should never reach here - fallback to linear
                    console.warn('[RolandProcessor] Arc command reached 2.5D processor - should have been linearized');
                    if (zChanged) {
                        const pz = this.emitPZIfChanged(targetZ, this.pzUpMM);
                        if (pz) lines.push(pz);
                    }
                    lines.push(`PD${this.fmtCoord(targetX)},${this.fmtCoord(targetY)};`);
                    this.currentPosition = {
                        x: stepTargetX / this.stepsPerMM,
                        y: stepTargetY / this.stepsPerMM,
                        z: this.pzDownMM
                    };
                    break;
                }

                default:
                    break;
            }

            return lines.join('\n');
        }

        /**
         * Emits !PZ command only if register values actually changed.
         */
        emitPZIfChanged(newDownMM, newUpMM) {
            const EPSILON = window.CAMConfig.constants.precision.coordinate;
            const downChanged = Math.abs(newDownMM - this.pzDownMM) > EPSILON;
            const upChanged = Math.abs(newUpMM - this.pzUpMM) > EPSILON;

            if (downChanged || upChanged) {
                this.pzDownMM = newDownMM;
                this.pzUpMM = newUpMM;
                return `!PZ${this.fmtCoord(this.pzDownMM)},${this.fmtCoord(this.pzUpMM)};`;
            }
            return '';
        }

        /**
         * Format a mm value as integer steps for RML output.
         */
        fmtCoord(value) {
            if (value === null || value === undefined) return '0';
            return Math.round(value * this.stepsPerMM).toString();
        }

        /**
         * Convert mm/min feed rate to Roland velocity string (mm/sec, clamped to machine max).
         */
        mmMinToVS(mmPerMin, axis = 'combined') {
            const mmPerSec = mmPerMin / 60;
            let maxForAxis;
            switch (axis) {
                case 'xy': maxForAxis = this.maxFeedXY; break;
                case 'z':  maxForAxis = this.maxFeedZ; break;
                default:   maxForAxis = Math.min(this.maxFeedXY, this.maxFeedZ); break;
            }
            const clamped = Math.max(0.1, Math.min(maxForAxis, mmPerSec));
            return parseFloat(clamped.toFixed(1)).toString();
        }
    }

    window.RolandPostProcessor = RolandPostProcessor;
})();