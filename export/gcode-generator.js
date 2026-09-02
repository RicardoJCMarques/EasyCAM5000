/*!
 * @file        export/gcode-generator.js
 * @description Complete G-code generation from toolpath plans
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const EPSILON = C.precision.epsilon;

    class GCodeGenerator {
        constructor(config) {
            this.config = config;
            this.processors = new Map();
            this.currentProcessor = null;
            this.lastWarnings = [];
            this.core = null;
            this.untransformedPosition = { x: 0, y: 0, z: 0 };

            this.registerDefaultProcessors();
        }

        setCore(coreInstance) {
            this.core = coreInstance;
        }

        setLanguageManager(langManager) {
            this.lang = langManager;
        }

        registerDefaultProcessors() {
            this.registerProcessor('grbl', new GRBLPostProcessor());
            this.registerProcessor('makera', new MakeraPostProcessor());
            this.registerProcessor('roland', new RolandPostProcessor());
            this.registerProcessor('grblhal', new GrblHALPostProcessor());
            this.registerProcessor('uccnc', new UCCNCPostProcessor());
            this.registerProcessor('marlin', new MarlinPostProcessor());
            this.registerProcessor('mach3', new Mach3PostProcessor());
            this.registerProcessor('linuxcnc', new LinuxCNCPostProcessor());
            this.registerProcessor('fanuc', new FanucPostProcessor());
            this.registerProcessor('winpcnc', new WinPCNCPostProcessor());
        }

        registerProcessor(name, processor) {
            this.processors.set(name.toLowerCase(), processor);
        }

        getProcessor(name) {
            return this.processors.get(name.toLowerCase());
        }

        /**
         * Returns the full descriptor for a registered processor.
         */
        getProcessorInfo(name) {
            const processor = this.getProcessor(name);
            if (!processor) return null;
            return processor.descriptor || null;
        }

        /**
         * Returns descriptors for all registered processors.
         */
        getAllProcessorDescriptors() {
            const result = [];
            for (const [key, processor] of this.processors) {
                result.push({
                    value: key,
                    ...(processor.descriptor || { label: key })
                });
            }
            return result;
        }

        /**
         * Resolves the effective start code for a processor.
         * Priority: userOverride > processor factory default > empty string.
         */
        resolveStartCode(processorName, userOverride) {
            if (userOverride !== undefined && userOverride !== null && userOverride !== '') {
                return userOverride;
            }
            const desc = this.getProcessorInfo(processorName);
            return desc?.defaults?.startCode ?? '';
        }

        /**
         * Resolves the effective end code for a processor.
         * Priority: userOverride > processor factory default > empty string.
         */
        resolveEndCode(processorName, userOverride) {
            if (userOverride !== undefined && userOverride !== null && userOverride !== '') {
                return userOverride;
            }
            const desc = this.getProcessorInfo(processorName);
            return desc?.defaults?.endCode ?? '';
        }

        generate(toolpathPlans, options) {
            if (!toolpathPlans || toolpathPlans.length === 0) {
                return '; No toolpath data available';
            }

            // Rotary developed-space plans: y is an unwound arc, not a machine
            // Y. Reaching here means MachineProcessor neither converted nor
            // dropped them - a routing bug, not a user error.
            if (toolpathPlans.some(p => p.metadata?.developedSpace)) {
                throw new Error('Rotary plans reached the post unconverted - ' +
                    'MachineProcessor did not resolve an export route.');
            }

            // Rotary output is metric-only for now. A words must never be
            // rescaled by G20, and under 'a-linear'/'wrapped-linear' the arc
            // travel rides a word whose unit is a machine-side calibration.
            // Refuse rather than emit a plausible-looking wrong program.
            if (options.units === 'inch' || options.units === 'in') {
                if (toolpathPlans.some(p => p.metadata?.rotaryAxisWord)) {
                    throw new Error('Rotary (4th-axis) export requires metric units. ' +
                        'Switch the G-code units to mm.');
                }
            }

            const processorName = options.postProcessor || 'grbl';
            this.currentProcessor = this.getProcessor(processorName);

            if (!this.currentProcessor) {
                throw new Error(`Post-processor '${processorName}' not found`);
            }

            this.currentProcessor.resetState();
            this.lastWarnings = [];
            this.untransformedPosition = { x: 0, y: 0, z: 0 };

            // Shallow clone
            options = { ...options };

            // Resolve all comment strings from language system once.
            // v2 keys are flat: "comments.header", "comments.makera.mtcRelease".
            // Processors read the LEAF (c.header, c.mtcRelease), so index by
            // leaf and keep the dotted form for anything that wants it.
            const section = this.lang.get('gcode', {}) || {};
            const flat = {};
            for (const [k, v] of Object.entries(section)) {
                if (typeof v !== 'string') continue;
                flat[k] = v;
                const leaf = k.split('.').pop();
                if (!(leaf in flat)) flat[leaf] = v;
            }
            options.comments = flat;

            // Resolve start/end codes from processor defaults with user overrides.
            // Backward-compatible: if caller already set options.startCode (legacy controller path), use it. Once controller is updated to pass userStartCode/userEndCode instead, the resolution kicks in.
            if (options.startCode === undefined || options.startCode === null) {
                options.startCode = this.resolveStartCode(processorName, options.userStartCode);
            }
            if (options.endCode === undefined || options.endCode === null) {
                options.endCode = this.resolveEndCode(processorName, options.userEndCode);
            }

            const output = [];

            // Check for comment compatibility // REVIEW - Incompatible post-processors should have the export modal toggle disabled.
            const supportsComments =
                this.currentProcessor.descriptor?.capabilities?.supportsComments !== false;
            if (options.includeComments && supportsComments) {
                // Gather data
                // REVIEW - Add a Verbose toggle to export more operational parameter details in each gcode file.
                const c = options.comments;
                const opIds = [...new Set(toolpathPlans.map(p => p.operationId))];
                const operations = opIds.map(id => this.core.getOperation(id)).filter(Boolean);

                // Build comment block
                const commentBlock = [];
                const appName = this.core.appProfile.meta.app;
                // Defaults only fire if the language file failed to load; a
                // broken translation must not take the export down with it.
                const t = (key, fallback) => c[key] || fallback;

                commentBlock.push(t('header', 'G-code generated by {app}')
                    .replace('{app}', appName));
                commentBlock.push(t('date', 'Date: {date}')
                    .replace('{date}', new Date().toLocaleString(undefined, { hour12: false })));
                commentBlock.push(t('processor', 'Processor: {processor}')
                    .replace('{processor}', processorName));
                commentBlock.push(t('separator', '---'));
                commentBlock.push(t('operationCount', 'Operations {count}:')
                    .replace('{count}', operations.length));
                operations.forEach(op => {
                    const label = op.sourceLabel || op.file?.name || op.id;
                    commentBlock.push(t('operationEntry', '  - {type}: {file}')
                        .replace('{type}', op.type).replace('{file}', label));
                });
                commentBlock.push(t('separator', '---'));

                // 4th-axis frame disclosure. A wrong Z touch-off on a rotary
                // job cuts the antipode of the part - say the reference out
                // loud in the header.
                const rotPlan = toolpathPlans.find(p => p.metadata?.rotaryAxisWord);
                if (rotPlan) {
                    const rm = rotPlan.metadata;
                    // [INDEXED] rotPlan may be the injected index link (no
                    // indexedA on it), so detect across the batch.
                    const isIndexed = toolpathPlans.some(
                        p => p.metadata?.indexedA != null);
                    if (isIndexed) {
                        const faces = [...new Set(toolpathPlans
                            .map(p => p.metadata?.indexedA)
                            .filter(a => a != null))];
                        const apo = toolpathPlans
                            .map(p => p.metadata?.indexedApothem)
                            .find(v => v != null) || 0;
                        commentBlock.push(`4th axis (indexed 3+1): ` +
                            `${rm.rotaryAxisWord} in absolute degrees - face ` +
                            `positions [${faces.map(a => a.toFixed(1)).join(', ')}]`);
                        commentBlock.push('Z zero: ROTARY CENTERLINE - Z is the ' +
                            'tool-tip radius from the axis; touch off a face top ' +
                            `and lower Z0 by the apothem (face top at ` +
                            `Z${apo.toFixed(3)}). Y zero: ROTARY CENTERLINE`);
                    } else {
                        commentBlock.push(`4th axis: ${rm.rotaryAxisWord} in ` +
                            `${rm.rotaryUnits === 'mm' ? 'mm of arc' : 'degrees'}, ` +
                            `accumulated (no rewind)`);
                        commentBlock.push(`Z zero: ROTARY CENTERLINE - Z is tool ` +
                            `radius; blank surface at Z${(rm.refRadius || 0).toFixed(3)}`);
                    }
                    // TODO(zzero-workoffset) - the operator currently dials the
                    // number above into Z0 by hand. The convenience version is a
                    // work offset - G10 L2 P0 Z-apothem, or G92 with a matching
                    // cancel in the end code - emitted HERE, gated on a per-post
                    // capability (G10 L2 vs G92 vs neither). Deliberately not
                    // built yet: both are MODAL machine state, so an abort
                    // between the shift and its cancel leaves the controller
                    // with a wrong origin and the next program cuts into the
                    // fixture. It needs a guaranteed cancel path and bench
                    // testing per post, and it changes no geometry - so it waits
                    // until the 3D pipeline stops moving. A disabled-by-default
                    // flag would not have reduced that risk, only deferred it to
                    // whoever flipped it.
                    // REVIEW - Outdated comment?
                    commentBlock.push(c.separator || '---');
                }

                // Add to options object
                options.commentBlock = commentBlock;
            }

            // First operational plan for the header's feed setup. Synthetic
            // plans (init/connection/entry/plunge/retract/final/index) carry no
            // cutting parameters. MachineProcessor stamps metadata.synthetic;
            // the operationId fallback covers plans built before that landed.
            const syntheticIds = new Set(['init', 'connection', 'entry',
                'staydown_plunge', 'depth_plunge', 'retract', 'final', 'index']);
            const isSynthetic = (p) =>
                p.metadata?.synthetic === true || syntheticIds.has(p.operationId);
            options.firstPlan = toolpathPlans.find(p => !isSynthetic(p)) || toolpathPlans[0];

            // Tool state. Resolved BEFORE the header so the {toolNumber}
            // placeholder in user start code finally gets a real value
            const enableToolChanges = options.toolChanges === true
                && this.currentProcessor.config?.supportsToolChange === true;
            const firstTool = toolpathPlans.find(p => p.metadata?.tool?.number > 0)
                ?.metadata.tool || null;
            if (options.toolNumber == null && firstTool) {
                options.toolNumber = firstTool.number;
            }
            let toolChangeCount = 0;

            // An operation with no number cannot swap, so whatever is already in
            // the spindle keeps cutting - and that is not arbitrary: the header
            // loads the first NUMBERED plan's tool, which may sit anywhere in the
            // program. Not fatal - the operator may be running one tool
            // deliberately - but it must never be silent. Rendered by the export
            // modal's warning panel.
            if (enableToolChanges) {
                const unnumbered = new Map();
                for (const p of toolpathPlans) {
                    if (p.metadata?.synthetic || !p.metadata?.tool) continue;
                    if (p.metadata.tool.number > 0) continue;
                    const label = p.metadata.tool.name || p.metadata.tool.id || p.operationId;
                    unnumbered.set(label, (unnumbered.get(label) || 0) + 1);
                }
                const loaded = firstTool ? `T${firstTool.number} (${firstTool.name || firstTool.id || 'unnamed'})` : null;
                for (const label of unnumbered.keys()) {
                    this.lastWarnings.push(loaded
                        ? `No tool number assigned for "${label}" - no tool change is emitted for it and it is cut with ${loaded}, the first numbered tool in the program.`
                        : `No tool number assigned for "${label}" - no tool change is emitted for it and it is cut with whatever is already in the spindle.`);
                }
            }

            // Generate header
            output.push(this.currentProcessor.generateHeader(options));

            // Initial tool selection, before any motion. Grbl-family controls
            // refuse to move without one; changer-equipped controls must be
            // told to LOAD the first tool rather than assume it.
            const initialTool = this.currentProcessor.generateInitialTool(firstTool, options);
            if (initialTool) output.push(initialTool);

            // Find init plan and process it first (safety height before spindle)
            const initPlanIndex = toolpathPlans.findIndex(p => p.operationId === 'init');
            if (initPlanIndex !== -1) {
                const initPlan = toolpathPlans[initPlanIndex];
                for (const cmd of initPlan.commands) {
                    const gcode = this.currentProcessor.processCommand(cmd);
                    if (gcode) {
                        output.push(gcode);
                    }

                    // Update untransformed position tracking
                    if (cmd.x !== null && cmd.x !== undefined) this.untransformedPosition.x = cmd.x;
                    if (cmd.y !== null && cmd.y !== undefined) this.untransformedPosition.y = cmd.y;
                    if (cmd.z !== null && cmd.z !== undefined) this.untransformedPosition.z = cmd.z;
                }
            }

            // Handle initial spindle command (after safety height)
            const firstPlanWithSpindle = toolpathPlans.find(p => p.metadata?.spindleSpeed > 0);
            if (firstPlanWithSpindle) {
                const spindle = firstPlanWithSpindle.metadata.spindleSpeed;
                const dwell = firstPlanWithSpindle.metadata.spindleDwell || 0;
                const spindleGcode = this.currentProcessor.setSpindle(spindle, dwell, options);
                if (spindleGcode) {
                    output.push(spindleGcode);
                }
            }

            let inCannedCycle = false;

            // Process remaining plans
            for (let i = 0; i < toolpathPlans.length; i++) {
                // Only skip the specific init plan index processed manually.
                // Do not skip plans by ID, as subsequent operations also have 'init' plans.
                if (i === initPlanIndex) {
                    continue;
                }

                const plan = toolpathPlans[i];
                const metadata = plan.metadata || {};

                // Tool transition. Mirrors the spindle logic directly below.
                // MachineProcessor's backward fill puts the incoming tool on
                // the connection rapid and the entry plunge, so this fires on
                // the approach - not on the cutting plan, which would swap
                // with the machine already at depth holding the old cutter.
                const planTool = metadata.tool;
                if (enableToolChanges && planTool && planTool.number > 0
                    && planTool.number !== this.currentProcessor.currentToolNumber) {
                    // The change block contains motion (retract, and G43 H..
                    // Z.. on table posts). Under a G93 left modal by a
                    // preceding rotary plan those blocks carry no F and fault.
                    const fm = this.currentProcessor.setFeedRateMode('G94', options);
                    if (fm) output.push(fm);
                    const tcGcode = this.currentProcessor.generateToolChange(planTool, options);
                    if (tcGcode) {
                        output.push(tcGcode);
                        toolChangeCount++;
                    }
                }

                // 4th-axis per-plan modal state. Both must be set BEFORE any
                // command of this plan is formatted:
                //   rotaryAxisWord - which word carries cmd.a ('A'|'B'), or
                //     null so a 3-axis plan can't leak one.
                //   feed mode - inverse time (G93) only over plans that carry
                //     converted durations; links and retracts stay G94.
                this.currentProcessor.rotaryAxisWord = metadata.rotaryAxisWord || null;
                const fm = this.currentProcessor.setFeedRateMode(
                    metadata.rotaryInverseTime ? 'G93' : 'G94', options);
                if (fm) output.push(fm);

                // Handle spindle speed changes mid-job
                const spindle = metadata.spindleSpeed;
                if (spindle !== undefined && spindle !== this.currentProcessor.currentSpindle) {
                    const dwell = metadata.spindleDwell || 0;
                    const spindleGcode = this.currentProcessor.setSpindle(spindle, dwell, options);
                    if (spindleGcode) {
                        output.push(spindleGcode);
                    }
                }

                // Process commands
                for (const cmd of plan.commands) {
                    const startPosForTransform = { ...this.untransformedPosition };

                    // Check modal transitions for Canned Cycles
                    const isCannedCmd = (cmd.type === 'CANNED_SIMPLE' || cmd.type === 'CANNED_PECK');

                    if (inCannedCycle && !isCannedCmd) {
                        // Transitioning out of canned cycle, issue G80
                        const cancelCode = this.currentProcessor.cancelCannedCycle(options);
                        if (cancelCode) output.push(cancelCode);
                        inCannedCycle = false;
                    } else if (isCannedCmd) {
                        inCannedCycle = true;
                    }

                    let commandsToProcess = [cmd];

                    // Linearize arcs if processor doesn't support them
                    if ((cmd.type === 'ARC_CW' || cmd.type === 'ARC_CCW') &&
                        !this.currentProcessor.config.supportsArcCommands) {
                        const radius = Math.hypot(cmd.i || 0, cmd.j || 0);
                        const baseResolution = options.arcResolution || 0.1;
                        const adaptiveResolution = radius < 2 ? baseResolution * 0.5 :
                                                radius > 10 ? baseResolution * 2 :
                                                baseResolution;

                        commandsToProcess = this.linearizeArc(cmd, startPosForTransform, adaptiveResolution);
                    }

                    // Process each command/segment
                    for (const commandToProcess of commandsToProcess) {
                        // Final Safety Validation Layer
                        // Pass down machine limits from options
                        const validationOptions = {
                            maxFeed: options.maxFeed,
                            maxSafeDepth: options.maxSafeDepth
                        };

                        const validation = this.currentProcessor.validateCommand(commandToProcess, validationOptions);

                        if (validation.errors && validation.errors.length > 0) {
                            // Hard abort. This bubbles up to your UI try/catch block.
                            throw new Error(`Validation failed: ${validation.errors.join(' | ')}`);
                        }
                        if (validation.warnings && validation.warnings.length > 0) {
                            // For now, just log warnings to the console without breaking the UI
                            console.warn(`[GCodeGenerator] Warning: ${validation.warnings.join(' | ')}`);
                        }

                        const gcode = this.currentProcessor.processCommand(commandToProcess);
                        if (gcode) {
                            output.push(gcode);
                        }

                        // Update untransformed position to end of segment
                        if (commandToProcess.x !== null && commandToProcess.x !== undefined) {
                            this.untransformedPosition.x = commandToProcess.x;
                        }
                        if (commandToProcess.y !== null && commandToProcess.y !== undefined) {
                            this.untransformedPosition.y = commandToProcess.y;
                        }
                        if (commandToProcess.z !== null && commandToProcess.z !== undefined) {
                            this.untransformedPosition.z = commandToProcess.z;
                        }
                    }
                }
            }

            // Cancel canned cycle if it was the last operation before footer
            if (inCannedCycle) {
                const cancelCode = this.currentProcessor.cancelCannedCycle(options);
                if (cancelCode) output.push(cancelCode);
            }

            // Never leave G93 modal into the footer/end code - its G0 X0Y0
            // would be fine, but any later G1 without an F would fault.
            const fm = this.currentProcessor.setFeedRateMode('G94', options);
            if (fm) output.push(fm);

            output.push(this.currentProcessor.generateFooter(options));

            const program = output.join('\n');
            // Read by runCNCPipeline for the export preview: the operator
            // decides whether the count justifies grouping by tool. The
            // software does not reorder their list to reduce it on its own.
            this.lastToolChangeCount = toolChangeCount;

            return this.currentProcessor.applyLineNumbers(program, options);
        }

        linearizeArc(cmd, startPos, resolution = 1.0) {
            const linearizedCmds = [];

            const start = {
                x: startPos.x,
                y: startPos.y,
                z: startPos.z
            };
            const hasZ = cmd.z !== null && cmd.z !== undefined;
            const end = {
                x: (cmd.x !== null && cmd.x !== undefined) ? cmd.x : start.x,
                y: (cmd.y !== null && cmd.y !== undefined) ? cmd.y : start.y,
                z: hasZ ? cmd.z : start.z
            };
            const center = {
                x: start.x + (cmd.i || 0),
                y: start.y + (cmd.j || 0)
            };
            const radius = Math.hypot(cmd.i || 0, cmd.j || 0);

            if (radius < EPSILON) {
                return [new MotionCommand('LINEAR', { x: end.x, y: end.y, z: hasZ ? end.z : null }, { feed: cmd.f })];
            }

            const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
            const endAngle = Math.atan2(end.y - center.y, end.x - center.x);

            const dist = Math.hypot(start.x - end.x, start.y - end.y);

            // Shared normalizer
            const sweep = ToolpathPlan.normalizeArcSweep({
                startAngle,
                endAngle,
                clockwise: cmd.type === 'ARC_CW',
                chord: dist,
                radius,
                eps: EPSILON
            });

            const arcLength = Math.abs(sweep) * radius;
            const segments = Math.max(2, Math.ceil(arcLength / resolution));
            const angleStep = sweep / segments;
            const zStep = hasZ ? (end.z - start.z) / segments : 0;

            for (let i = 1; i <= segments; i++) {
                const angle = startAngle + i * angleStep;

                const nextX = (i === segments) ? end.x : (center.x + radius * Math.cos(angle));
                const nextY = (i === segments) ? end.y : (center.y + radius * Math.sin(angle));
                const nextZ = hasZ ? ((i === segments) ? end.z : (start.z + i * zStep)) : null;

                linearizedCmds.push(new MotionCommand('LINEAR',
                    { x: nextX, y: nextY, z: nextZ },
                    { feed: cmd.f }
                ));
            }

            return linearizedCmds;
        }

        /**
         * Returns keys of all registered processors.
         * For richer data, use getAllProcessorDescriptors().
         */
        getAvailableProcessors() {
            return Array.from(this.processors.keys());
        }
    }

    window.GCodeGenerator = GCodeGenerator;
})();