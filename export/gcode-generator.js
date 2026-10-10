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
    const ROOT = globalThis;

    const C = ROOT.CAMConfig.constants;

    const EPSILON = C.precision.epsilon;

    class GCodeGenerator {
        constructor(config, core, lang) {
            this.config = config;
            this.core = core;
            this.lang = lang;
            this.processors = new Map();
            this.currentProcessor = null;
            this.lastWarnings = [];
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

        /**
         * Lookup by id. An unknown id is already a supported answer - every
         * caller either guards with `?.` or wants the null from
         * getProcessorInfo - so a missing name returns undefined rather than
         * throwing on .toLowerCase() before any of those guards can run.
         */
        getProcessor(name) {
            return name ? this.processors.get(String(name).toLowerCase()) : undefined;
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
            return [...this.processors.values()].map(p => p.descriptor);
        }
        
        /**
         * Capability gates for profile <option>s. Indexed 3+1 needs a real A/B
         * word; axis replacement repurposes Y as arc length and the two cannot
         * coexist on one machine. Keyed on the PINNED route, not the resolved one -
         * buildPipelineContext promotes '' to 'a-word' for an indexed op, and
         * gating on the resolved route would disable indexed on every post that
         * lists wrapped-linear first.
         */
        getOptionGates(settings) {
            const post = settings.gcode.postProcessor;
            const rotary = this.getProcessorInfo(post).capabilities.rotary;
            const pinned = settings.gcode.rotaryRoute || "";
            const declaresAWord = rotary.routes.includes("a-word") && rotary.axisWords.length > 0;
            const pinnedElsewhere = pinned !== "" && pinned !== "a-word";
            return {
                "rotary.indexed": {
                    ok: declaresAWord && !pinnedElsewhere,
                    reason: declaresAWord
                        ? "Machine rotary route is set to axis replacement, which carries arc length on the Y word."
                        : `'${post}' declares no A/B rotary word - it can only drive a 4th axis by axis replacement.`
                }
            };
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
            this.limitWarnings = new Map();
            this.untransformedPosition = { x: 0, y: 0, z: 0 };

            // Shallow clone
            options = { ...options };

            // Resolve all comment strings from language system once.
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

            // Start/end code: the operator's textarea override, else the post's
            // factory default.
            options.startCode = this.resolveStartCode(processorName, options.userStartCode);
            options.endCode = this.resolveEndCode(processorName, options.userEndCode);

            const output = [];

            // Check for comment compatibility
            const supportsComments =
                this.currentProcessor.descriptor?.capabilities?.supportsComments !== false;
            if (options.includeComments && supportsComments) {
                // Gather data
                // TODO - Add a Verbose toggle to export more operational parameter details in each gcode file.
                const c = options.comments;
                const opIds = [...new Set(toolpathPlans.map(p => p.operationId))];
                const operations = opIds.map(id => this.core.store.getOperation(id)).filter(Boolean);

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
                    // TODO(zzero-workoffset) - emit the apothem as a work offset (G10 L2 or
                    // G92, per-post capability) instead of having the operator dial it into
                    // Z0. Blocked on a guaranteed cancel path and per-post bench tests: both
                    // are modal state, and an abort before the cancel leaves a wrong origin.
                    // Needs nuance to handle machines with absolute Z0 and with the 4th axis
                    // above it.
                    commentBlock.push(c.separator || '---');
                }

                // Add to options object
                options.commentBlock = commentBlock;
            }

            // First operational plan for the header's feed setup. Synthetic
            // plans (init/connection/entry/plunge/retract/final/index) carry no
            // cutting parameters; MachineProcessor stamps metadata.synthetic on each.
            options.firstPlan = toolpathPlans.find(p => p.metadata?.synthetic !== true) || toolpathPlans[0];

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

            // Router operations carry a T word; laser and knife/vector do not.
            // A post that declares emitsInitialTool with nothing resolved means
            // no router operation reached here - the program has no T word and a
            // control that needs one will refuse to move. Rendered by the export
            // modal's warning panel.
            if (this.currentProcessor.config?.emitsInitialTool !== false && !firstTool) {
                this.lastWarnings.push('No tool number resolved for this job - the program contains no T word.');
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
                            // Per command. An unaggregated console.warn here is one line per
                            // move, and a relief pass past the depth limit locks the tab.
                            for (const w of validation.warnings) {
                                this.limitWarnings.set(w, (this.limitWarnings.get(w) || 0) + 1);
                            }
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

            for (const [msg, n] of this.limitWarnings) {
                console.warn(`[GCodeGenerator] ${msg}${n > 1 ? ` (${n} moves)` : ''}`);
            }

            // Final numeric audit. formatNumberSafe stops a non-finite word at
            // the source, but two routes bypass it: a post that formats its own
            // coordinates (Roland), and every {safeZ}/{travelZ}/{toolNumber}
            // token substituted into user start/end code. Both reach the file as
            // text. A dropped word is equally unsafe - the control holds its
            // last value and the move goes somewhere the operator did not ask
            // for - so a non-zero fault count refuses too.
            const faults = this.auditProgram(program);
            if (faults.length > 0) {
                throw new Error(`Export refused - non-numeric value in the program at ${faults.join('; ')}`);
            }
            if (this.currentProcessor.numericFaults > 0) {
                throw new Error(`Export refused - ${this.currentProcessor.numericFaults} coordinate(s) or feed(s) resolved to a non-finite number and were dropped. Regenerate the affected operations.`);
            }

            // Read by runCNCPipeline for the export preview: the operator
            // decides whether the count justifies grouping by tool. The
            // software does not reorder their list to reduce it on its own.
            this.lastToolChangeCount = toolChangeCount;
            return this.currentProcessor.applyLineNumbers(program, options);
        }

        /**
         * Refuses a program containing a bare NaN/Infinity/undefined/null word.
         * Comment stripping is per line, so `(null)` in an operator note is not
         * a fault - which is why this cannot be one regex over the whole string.
         * The whole-string exec is a gate, not the test: a clean 30MB program
         * never allocates the line array.
         */
        auditProgram(program) {
            const BAD = /\b(?:NaN|Infinity|undefined|null)\b/i;
            if (!BAD.test(program)) return [];
            const faults = [];
            const lines = program.split('\n');
            for (let i = 0; i < lines.length && faults.length < 5; i++) {
                const code = lines[i].replace(/\([^)]*\)/g, '').split(';')[0];
                if (BAD.test(code)) faults.push(`line ${i + 1}: "${lines[i].trim()}"`);
            }
            return faults;
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
    }

    ROOT.GCodeGenerator = GCodeGenerator;
})();