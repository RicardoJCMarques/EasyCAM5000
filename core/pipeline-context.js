/*!
 * @file        core/pipeline-context.js
 * @description 
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Everything between "an operation plus its ParameterManager values" and
 * "a frozen context the toolpath pipeline can run": workspace transforms,
 * parameter compilation, depth ladders, tool descriptors and tool-number
 * validation.
 *
 * Pipeline stage, so it takes core - the same shape as
 * new GeometryTranslator(this) / new MachineProcessor(this).
 *
 * Core surface consumed (the whole contract - nothing else is read):
 *  core.settings          machine / gcode / laser / processorSettings
 *  core.scene             transform, getWorkspaceMatrix(), windingFlipped()
 *  core.toolLibrary       getTool()
 *  core.gcodeGenerator    getProcessorInfo(), getProcessor()
 *  core.operations        list, for the "all export-ready" default
 *  core.getOperation(id)
 *  core.isExportReady(op)
 *  core.isLaserOperation(op)
 *  core.handlers / core.getHandler(type)   toolpath policy only
 */

(function () {
    'use strict';

    const ROOT = globalThis;
    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const EPSILON = C.precision.epsilon;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class PipelineContextBuilder {
        constructor(core) {
            this.core = core;
        }

        // ═══════════════════════════════════════════════════════════
        // Tooling
        // ═══════════════════════════════════════════════════════════

        /**
         * Resolves the tool descriptor for one operation. Nothing here
         * invents a number: a slot a cutter physically occupies is not
         * derivable from geometry, and a plausible default is one the
         * operator was never prompted to verify. validateToolAssignment() // REVIEW - Does validateToolAssignment still exist? Outdated comment?
         * reports the gaps; the export modal blocks on them.
         * @param {Object} operation
         * @param {Object} params merged ParameterManager values
         * @param {Object} [override] export-modal toolIndexMap entry
         */
        resolveToolDescriptor(operation, params, override = null) {
            const record = this.core.toolLibrary?.getTool?.(params.tool) || null;
            const pick = value => {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 ? n : null;
            };

            const descriptor = {
                number: pick(override?.number) ?? pick(params.toolNumber),
                id: params.tool || null,
                name: override?.name || record?.name || params.tool || null,
                type: record?.type || null,
                diameter: params.toolDiameter,
                spindleSpeed: params.spindleSpeed,
                spindleDwell: params.spindleDwell,
                operationId: operation.id,
                operationLabel: `${operation.type}: ${operation.file?.name || operation.id}`
            };

            // Drill: one physical bit per feature size. The map key is the SAME
            // string DrillHandler.diameterKey produces, so the export table, the
            // split-drill path and the descriptor agree without re-deriving it.
            // Only in multi-tool mode. Single-tool drilling cuts everything with
            // the operation's own number, and a drillMap that repeats that number
            // once per diameter reports itself to describeToolSharing as a
            // collision between a tool and itself.
            if (operation.type === 'drill' && DrillHandler.isMultiTool(params)) {
                const active = Object.values(operation.drillTable?.rows || {}).filter(row => row.strategy !== 'skip');

                // The operation's own tool cuts only the rows that inherit it.
                // With none, it makes no claim on a number and cannot collide
                // with the bits it is not holding.
                descriptor.cutsWithOwnTool = active.some(row => !(row.toolId || row.toolDiameter > 0));

                if (active.length > 0) {
                    descriptor.drillMap = {};
                    for (const row of active) {
                        const assigned = pick(row.toolNumber);
                        const effectiveDiam = row.toolDiameter > 0 ? row.toolDiameter : row.diameter;
                        descriptor.drillMap[row.key] = {
                            number: assigned ?? descriptor.number,
                            inherited: assigned == null,
                            diameter: effectiveDiam,
                            strategy: row.strategy,
                            name: row.toolId || `${row.strategy === 'mill' ? 'Mill' : 'Drill'} ${effectiveDiam}mm`
                        };
                    }
                }
            } else {
                descriptor.cutsWithOwnTool = true;
            }

            return descriptor;
        }

        /**
         * Reports T numbers shared by tools of Different sizes.
         * Identity is the effective diameter, not the library id. A tool id is
         * a naming convenience with no enforcement behind it - `drill_1.0mm`
         * and `em_1.0mm_flat` are different records and very often the same
         * physical cutter in the same collet, especially since millHoles
         * defaults to true and most drill work never touches a drill bit.
         * Comparing ids flagged exactly the case most likely to be correct.
         * Same number + same diameter is silent. Same number + different
         * diameters is the only thing worth saying, and it is a note, not a
         * refusal: the operator knows their spindle, EasyCAM does not.
         * @param {Array} descriptors from resolveToolDescriptor
         * @returns {Array<{number:number, entries:Array<{label:string, diameter:number}>}>}
         */
        describeToolSharing(descriptors) {
            // 0.01mm separates 3.175 from 3.0 without splitting 3.175 from a
            // rounded 3.18. precision.coordinate (0.001) is too tight for a
            // hand-entered diameter.
            const DIAMETER_TOLERANCE = 0.01;
            const byNumber = new Map();

            const record = (label, number, diameter) => {
                if (null == number || !(diameter > 0)) return;
                let entries = byNumber.get(number);
                if (!entries){
                    entries = [];
                    byNumber.set(number, entries)
                }
                entries.some(e => Math.abs(e.diameter - diameter) < DIAMETER_TOLERANCE) || entries.push({
                    label: label,
                    diameter: diameter
                }
            )};

            for (const d of descriptors) {
                if (d.cutsWithOwnTool !== false) {
                    record(d.drillMap ? `${d.operationLabel} (milled holes)` : d.operationLabel, d.number, d.diameter);
                }
                if (d.drillMap) {
                    for (const [key, entry] of Object.entries(d.drillMap)) {
                        record(`${d.operationLabel} — ${key}mm holes`, entry.number, entry.diameter);
                    }
                }
            }

            const shared = [];
            for (const [number, entries] of byNumber) {
                if (entries.length > 1) shared.push({ number: number, entries: entries });
            }
            return shared.sort((a, b) => a.number - b.number);
        }

        /**
         * Resolves tool descriptors for a set of operations without building
         * contexts or running a pipeline. Lets the export modal validate the
         * moment a checkbox flips, instead of only at Calculate.
         */
        // REVIEW - commitToOperation is a WRITE inside what every call site
        // treats as a query (checkToolAssignment runs on each export-modal
        // checkbox flip). Split the commit out to a caller-side step.
        stageToolDescriptors(operationIds, parameterManager, toolIndexMap = {}) {
            const core = this.core;
            const ids = operationIds || core.operations.filter(op => core.isExportReady(op)).map(op => op.id);
            const staged = [];

            for (const opId of ids) {
                try {
                    const operation = core.getOperation(opId);
                    if (!operation) continue;
                    if (parameterManager.hasUnsavedChanges(opId)) parameterManager.commitToOperation(operation);
                    const params = parameterManager.getAllParameters(opId);
                    staged.push({
                        opId: opId,
                        operation: operation,
                        tool: this.resolveToolDescriptor(operation, params, toolIndexMap[opId])
                    });
                } catch (err) {
                    console.warn(`[PipelineContext] tool staging skipped ${opId}: ${err.message}`);
                }
            }
            return staged;
        }

        /**
         * One-call check for the UI. Same staging the pipeline uses, so the
         * modal's note and the emitted G-code can never disagree.
         */
        checkToolAssignment(operationIds, parameterManager, opts = {}) {
            const staged = this.stageToolDescriptors(operationIds, parameterManager, opts.toolIndexMap);
            return this.describeToolSharing(staged.map(s => s.tool));
        }

        /**
         * Flattens a resolved descriptor's drillMap to the plain
         * diameterKey → number lookup the translator wants on the context.
         * Entries stay null when unassigned.
         */
        flattenDrillMap(descriptor) {
            if (!descriptor.drillMap) return null;
            const flat = {};
            for (const [key, entry] of Object.entries(descriptor.drillMap)) flat[key] = entry.number;
            return flat;
        }

        /**
         * Drill-milling parameter aliases. JSON can't carry two keys with the
         * same name and different conditionals, so the profiles prefix the
         * drill variants. One precedence rule for every alias pair: the
         * prefixed key wins on a drill operation, the plain key otherwise.
         */
        resolveDrillAlias(operation, params, plainKey, drillKey) {
            return operation.type === 'drill' && params[drillKey] !== undefined ? params[drillKey] : params[plainKey];
        }

        // ═══════════════════════════════════════════════════════════
        // Parameter compilation and depth
        // ═══════════════════════════════════════════════════════════

        /**
         * Offset Strategy Builder
         * Translates pipeline-specific UI parameters into a pipeline-agnostic
         * strategy object. Called before any handler runs - handlers never
         * need to check pipeline type.
         * @param {Object} operation - The operation with .type and .bounds
         * @param {Object} params - Flat map from parameterManager.getAllParameters()
         * @returns {Object} Strategy object ready for any handler
         */
        compileOperationParams(operation, params) {
            const core = this.core;
            const isLaser = core.isLaserOperation(operation);
            const exportFormat = isLaser ? core.settings.laser.exportFormat : null;
            const isPNG = exportFormat === 'png';
            const resolveDrillAlias = (a, b) => this.resolveDrillAlias(operation, params, a, b);

            // Tool dimension
            const toolDiameter = isLaser ? params.laserSpotSize || core.settings.laser.spotSize : params.toolDiameter;

            // Step distance
            let stepDistance = null;
            let stepOver = null;
            if (isLaser) {
                if (isPNG) {
                    stepDistance = toolDiameter;
                } else {
                    const mode = params.laserSpacingMode;
                    switch (mode) {
                        case 'lpcm':
                            stepDistance = 10 / Math.max(params.laserLinesPerCm, 1);
                            break;
                        case 'lpi':
                            stepDistance = 25.4 / Math.max(params.laserLinesPerInch, 1);
                            break;
                        case 'stepover':
                        default:
                            stepDistance = toolDiameter * (params.laserStepOver / 100);
                            break;
                    }
                }
            } else {
                stepOver = resolveDrillAlias('stepOver', 'drillStepOver');
            }

            // Clear strategy
            let clearStrategy = 'offset';
            if (isLaser) clearStrategy = isPNG ? 'filled' : params.laserClearStrategy;

            // Per-operation-type
            let passes = null;
            let targetWidth = null;
            let cutSide = null;
            let combineOffsets = false;

            switch (operation.type) {
                // Shared operation types
                case 'drill':
                    passes = 1;
                    cutSide = (isLaser && params.laserCutSide) || 'inside';
                    break;

                // EasyTrace5000 operation types
                case 'isolation':
                    if (isLaser) {
                        targetWidth = params.laserIsolationWidth || 0.4;
                    } else {
                        passes = params.passes || 3;
                        combineOffsets = params.combineOffsets !== false;
                    }
                    break;
                case 'clearing':
                    combineOffsets = true;
                    // No targetWidth - handler loop runs until geometry collapses.
                    passes = 500;
                    break;
                case 'cutout':
                    passes = 1;
                    cutSide = isLaser ? params.laserCutSide || 'outside' : params.cutSide || 'outside';
                    break;
                case 'stencil':
                    // Distance comes from stencilOffset and the cutter radius, not
                    // from a pass ladder - see TraceStencilHandler.passDistance.
                    passes = 1;
                    combineOffsets = false;
                    break;

                // EasyShape5000 operation types
                case 'profile':
                    passes = 1;
                    cutSide = params.cutSide || 'outside';
                    break;
                case 'pocket':
                    combineOffsets = true;
                    passes = 500;
                    break;
                case 'engrave':
                    passes = 1;
                    cutSide = 'on';
                    break;
                case 'vcarve':
                case 'relief':
                case 'rotary':
                    // Depth comes from the generated 3D geometry, not pass distances. No cutSide, no stepOver, single logical pass.
                    passes = 1;
                    combineOffsets = false;
                    break;
            }

            return {
                toolDiameter: toolDiameter,
                stepDistance: stepDistance,
                stepOver: stepOver,
                targetWidth: targetWidth,
                passes: passes,
                cutSide: cutSide,
                clearStrategy: clearStrategy,
                combineOffsets: combineOffsets,
                isLaser: isLaser,
                hatchAngle: params.laserHatchAngle,
                hatchPasses: params.laserHatchPasses,
                isolationWidth: isLaser ? params.laserIsolationWidth : null
            };
        }

        /**
         * Z of the material surface in machine coordinates.
         * Rotary owns its own Z0 (centreline or blank face), so stock
         * thickness never applies to it.
         */
        resolveSurfaceZ(operation) {
            const stock = this.core.settings.machine.stock || {};
            const isBedZero = stock.zeroReference && stock.zeroReference !== 'material';
            return (isBedZero && operation.type !== 'rotary' && stock.thickness) || 0;
        }

        /**
         * Calculates the final Z-depth levels for a toolpath.
         */
        calculateDepthLevels(cutDepth, depthPerPass, multiDepth, surfaceZ = 0) {
            const totalCutDist = Math.abs(cutDepth);
            const finalDepth = surfaceZ - totalCutDist;
            const step = Math.abs(depthPerPass);

            if (!multiDepth || step <= 0 || totalCutDist <= step) return [finalDepth]; // Single pass

            const levels = [];
            let currentDepth = surfaceZ;

            // Loop while currentDepth is greater than (less negative than) finalDepth
            while (currentDepth - step > finalDepth - EPSILON) {
                currentDepth -= step;
                levels.push(currentDepth);
            }

            // Ensure the final depth is always included if not already last
            if (levels.length === 0 || levels[levels.length - 1] > finalDepth) levels.push(finalDepth);

            return levels;
        }

        /**
         * Depth ladders for the drill rows that override depth-per-pass or
         * multi-depth. Built here because calculateDepthLevels is the only
         * ladder in the app and a second copy in the translator would drift.
         * Returns null when no row overrides, so the common case allocates
         * nothing.
         */
        buildDrillDepthLevels(operation, params, depthPerPass, multiDepth, surfaceZ) {
            if (!params?.drillMultiTool) return null;
            const rows = operation.drillTable?.rows;
            if (!rows) return null;

            let levels = null;
            for (const [key, row] of Object.entries(rows)) {
                const step = row.mill?.depthPerPass;
                const multi = row.mill?.multiDepth;
                if (step != null || multi != null) {
                    if (!levels) levels = {};
                    levels[key] = this.calculateDepthLevels(params.cutDepth, step ?? depthPerPass, multi ?? multiDepth, surfaceZ);
                }
            }
            return levels;
        }

        // ═══════════════════════════════════════════════════════════
        // Transforms
        // ═══════════════════════════════════════════════════════════

        /**
         * Returns the current workspace transform from the scene.
         */
        getTransforms() {
            const t = this.core.scene.transform;

            // Workspace matrix (rotation + mirror, NO origin) - still published
            // separately because GraphicsExporter composes origin itself.
            const wsMatrix = TransformMath.clone(this.core.scene.getWorkspaceMatrix());

            // The machine matrix: T(-origin) x workspace. The only transform
            // the toolpath pipeline applies, once, in GeometryTranslator.
            // GCodeGenerator no longer subtracts origin.
            const machineMatrix = TransformMath.multiply(
                TransformMath.translation(-t.origin.x, -t.origin.y),
                wsMatrix
            );

            return {
                origin: { ...t.origin },
                rotation: t.rotation,
                rotationCenter: { ...t.rotationCenter },
                mirrorX: t.mirrorX,
                mirrorY: t.mirrorY,
                mirrorCenter: { ...t.mirrorCenter },
                // Derived, cloned so frozen contexts can't share the cache:
                matrix: wsMatrix,
                machineMatrix: machineMatrix,
                machineIsIdentity: TransformMath.isIdentity(machineMatrix),
                windingFlipped: this.core.scene.windingFlipped()
            };
        }

        // ═══════════════════════════════════════════════════════════
        // Context assembly
        // ═══════════════════════════════════════════════════════════

        /**
         * Pipeline Context Builder
         * Assembles all data for a single operation into a
         * self-contained context object. Delegates offset direction
         * to the registered handler so the core never checks
         * operation type names for geometric decisions.
         */
        buildPipelineContext(operationId, parameterManager, resolvedTool = null) {
            const core = this.core;
            const operation = core.getOperation(operationId);
            if (!operation) throw new Error(`Operation ${operationId} not found.`);

            // Get all parameters from manager
            const params = parameterManager.getAllParameters(operationId);
            const resolveDrillAlias = (a, b) => this.resolveDrillAlias(operation, params, a, b);

            // Drill milling aliases - JSON can't have duplicate keys with different
            // conditionals, so both apps' profiles uses prefixed names (drillMultiDepth,
            // drillDepthPerPass, drillEntryType) for operation-specific params that
            // share names. Map them to the standard names the pipeline expects.
            // REVIEW - Check if there's a better approach to this - there's already a new per app/operation input defaults override?
            // More Operations have unique parameter modifiers and defaults now, might as well just review everything for consistency and keep the system but improve implementation?
            const isDrill = operation.type === 'drill';
            const mappedMultiDepth = resolveDrillAlias('multiDepth', 'drillMultiDepth');
            const mappedDepthPerPass = resolveDrillAlias('depthPerPass', 'drillDepthPerPass');
            const mappedEntryType = resolveDrillAlias('entryType', 'drillEntryType');
            const mappedStepOver = resolveDrillAlias('stepOver', 'drillStepOver');

            // Get global settings
            const machine = core.settings.machine;
            const gcode = core.settings.gcode;
            const processorInfo = core.gcodeGenerator?.getProcessorInfo(gcode.postProcessor);

            // Rotary 4th-axis export route. The post declares which routes it
            // can emit (descriptor.capabilities.rotary.routes, preference
            // order); gcode.rotaryRoute is the user's pick from the
            // machine-settings dropdown. '' or an undeclared value = auto
            // (first declared route). No declared routes = 'off', and any
            // developed plan is dropped downstream with a pipeline warning.
            const rotaryCaps = processorInfo?.capabilities?.rotary || { routes: [], axisWords: [], inverseTime: false, maxInverseTime: 0 };

            // Indexed 3+1 needs a REAL rotary word: there is no arc to
            // substitute, so 'wrapped-linear' is not a valid encoding for it.
            // REVIEW - this sounds like an overcomplication?
            const isIndexedOp = operation.offsets?.[0]?.metadata?.indexed === true;
            const preferred = isIndexedOp && rotaryCaps.routes.includes('a-word') ? 'a-word' : rotaryCaps.routes[0] || 'off';
            const wantRoute = gcode.rotaryRoute || '';
            const rotaryRoute = rotaryCaps.routes.includes(wantRoute) ? wantRoute : preferred;
            if (wantRoute && wantRoute !== rotaryRoute) {
                console.warn(`[PipelineContext] Post '${gcode.postProcessor}' does not declare rotary route '${wantRoute}' - using '${rotaryRoute}'.`);
            }

            // Compute derived values
            const offsetDistances = (operation.offsets || []).map(o => o.distance);

            // Transform Values
            const transforms = this.getTransforms();
            const surfaceZ = this.resolveSurfaceZ(operation);
            const depthLevels = this.calculateDepthLevels(params.cutDepth, mappedDepthPerPass, mappedMultiDepth, surfaceZ);

            // Laser context (null for CNC pipeline)
            let laserContext = null;
            if (core.isLaserOperation(operation)) {
                const laserMachine = core.settings.laser;
                const strategy = this.compileOperationParams(operation, params);
                let computedPasses = 0;
                if (strategy.targetWidth > 0 && strategy.stepDistance > 0) {
                    const span = strategy.targetWidth - strategy.toolDiameter;
                    if (span >= 0) computedPasses = Math.floor(span / strategy.stepDistance) + 1;
                }
                // Spread strategy and layer on machine-level fields that compileOperationParams doesn't cover
                laserContext = {
                    ...strategy,
                    spotSize: laserMachine.spotSize,
                    exportFormat: laserMachine.exportFormat,
                    exportDPI: laserMachine.exportDPI,
                    computedPasses: computedPasses
                };
            }

            // Assemble final context
            const context = {
                // Metadata
                operationId: operation.id,
                operationType: operation.type,
                fileName: operation.file.name,

                // Global Settings
                machine: {
                    surfaceZ: surfaceZ,
                    safeZ: machine.heights.safeZ + surfaceZ,
                    travelZ: machine.heights.travelZ + surfaceZ,
                    feedHeight: machine.heights.feedHeight + surfaceZ,
                    rapidFeedRate: machine.speeds.rapidFeed,
                    maxFeedRate: machine.speeds.maxFeed
                },

                // Processor-specific settings (Roland, Makera, etc.)
                gcode: { ...gcode, supportsCannedCycles: processorInfo?.capabilities?.supportsCannedCycles },
                processorSettings: { ...(core.settings.processorSettings || {}) },

                // Operation Parameters
                // `number` is machine-resolved and always >= 1. `drillNumbers`
                // maps originalDiameter.toFixed(3) → tool number for peck
                // groups; null on every non-drill operation.
                tool: (() => {
                    const t = resolvedTool || this.resolveToolDescriptor(operation, params, null);
                    return {
                        number: t.number, // null = unassigned, on purpose
                        id: t.id,
                        name: t.name,
                        type: t.type,
                        diameter: params.toolDiameter,
                        spindleSpeed: params.spindleSpeed,
                        spindleDwell: params.spindleDwell,
                        drillNumbers: this.flattenDrillMap(t),
                        // False when the operation mills nothing of its own, so
                        // tool batching can sort it by the bits it actually calls
                        // rather than by a number no move in it ever uses.
                        cutsWithOwnTool: t.cutsWithOwnTool !== false
                    };
                })(),

                cutting: {
                    feedRate: params.feedRate,
                    plungeRate: params.plungeRate,
                    spindleSpeed: params.spindleSpeed,
                    spindleDwell: params.spindleDwell
                },

                strategy: {
                    cutDepth: params.cutDepth,
                    depthPerPass: mappedDepthPerPass,
                    multiDepth: mappedMultiDepth,
                    passes: params.passes,
                    stepOver: mappedStepOver,
                    entryType: mappedEntryType,
                    drill: {
                        millHoles: params.millHoles,
                        peckDepth: params.peckDepth,
                        dwellTime: params.dwellTime,
                        cannedCycle: params.cannedCycle,
                        retractHeight: params.retractHeight
                    },
                    cutout: {
                        tabs: params.tabs,
                        tabWidth: params.tabWidth,
                        tabHeight: params.tabHeight,
                        cutSide: params.cutSide
                    },
                    vcarve: {
                        vbitAngle: params.vbitAngle,
                        vbitTipDiameter: params.vbitTipDiameter,
                        vcarveMaxDepth: params.vcarveMaxDepth,
                        vcarveStartDepth: params.vcarveStartDepth
                    }
                },

                // Computed Values
                computed: {
                    offsetDistances: offsetDistances,
                    depthLevels: depthLevels,
                    drillDepthLevels: this.buildDrillDepthLevels(operation, params, mappedDepthPerPass, mappedMultiDepth, surfaceZ),
                    toolpathPolicy: core.handlers.has(operation.type) ? core.getHandler(operation.type).getToolpathPolicy() : null
                },

                // Authoritative for everything per-diameter that is NOT baked
                // into geometry - tool number, feeds, peck cycle. The
                // geometry-affecting fields were resolved at generation and are
                // stamped on the primitives themselves. Null in single-tool mode
                // so the translator falls through to the operation's values.
                drillTable: (isDrill && params.drillMultiTool && operation.drillTable) || null,

                // Transform Values
                transforms: transforms,

                // Config References
                // REVIEW - Are these still relevant? Do they still need to be linked like this?
                config: {
                    entry: D.toolpath.generation.entry,
                    drilling: D.toolpath.generation.drilling,
                    tabs: D.toolpath.tabs,
                    optimization: D.gcode.optimization,
                    precision: PRECISION,
                    offsettingEpsilon: EPSILON
                },

                // Laser-specific (only populated in laser/hybrid pipeline)
                laser: laserContext,

                // Rotary 4th-axis export routing.
                export: {
                    rotaryRoute: rotaryRoute,

                    // The user's PINNED machine-settings pick, unresolved.
                    // '' = auto. insertIndexMoves needs to tell "auto landed
                    // on wrapped-linear" (promotable to a-word) from "the user
                    // says this machine IS axis replacement" (not promotable).
                    requestedRoute: wantRoute,

                    // [INDEXED] Full declared list, not just the resolved
                    // pick: indexed 3+1 requires 'a-word' specifically and
                    // auto-switches to it (with a warning) when the post
                    // declares it but auto-resolution preferred another
                    // route. See MachineProcessor.insertIndexMoves.
                    routes: rotaryCaps.routes,
                    axisWords: rotaryCaps.axisWords,
                    inverseTime: rotaryCaps.inverseTime === true,
                    maxInverseTime: rotaryCaps.maxInverseTime,

                    // Machine setting wins; blank falls back to the post's
                    // declared default. This is a property of the rotary
                    // HARDWARE (belt vs geared/servo with a brake), so it
                    // cannot live in the post alone - one controller drives
                    // both kinds.
                    indexDwell: gcode.indexDwell === '' || gcode.indexDwell == null
                        ? rotaryCaps.indexDwell || 0
                        : Math.max(0, Number(gcode.indexDwell) || 0),
                    continuous: rotaryCaps.continuous !== false
                }
            };

            // Posts declare their own machine limits; the core does not
            // know which one is loaded.
            core.gcodeGenerator?.getProcessor(gcode.postProcessor)?.prepareContext?.(context, operation);

            // Prevent accidental mutation by downstream pipeline stages.
            // TODO [METADATA-BLOAT] - Deep-freeze nested objects or replace
            // plan.metadata.context references with explicit field copies.
            // Contract: after translate, ctx may be read ONLY via
            // plan.metadata.transforms (stamped by the translators) and - until
            // migrated - MachineProcessor's determineWinding. No other stage
            // may retain or read ctx. Freeze is the tamper canary for that.
            Object.freeze(context);
            return context;
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            if (data) console.log(`[PipelineContext] ${message}`, data);
            else console.log(`[PipelineContext] ${message}`);
        }
    }

    ROOT.PipelineContextBuilder = PipelineContextBuilder;
})();