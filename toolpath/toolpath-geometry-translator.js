/*!
 * @file        toolpath/toolpath-geometry-translator.js
 * @description Translates annotated 2D primitives into 3D ToolpathPlans
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
    const debugState = D.debug;

    /**
     * Primitive-driven translation router.
     * No operation-type branching - all dispatch is based on primitive properties (role, tabConfig, type).  Drill macro grouping runs as a pre-scan so the MachineProcessor receives one approach/retract cycle per hole regardless of how many concentric passes it contains.
     *
     * ── COORDINATE CONTRACT (shared by EasyTrace5000 & EasyShape5000) ──
     * Input geometry (operation.offsets[].primitives) is ALWAYS in PIPELINE
     * SPACE: file/workspace coordinates, pre-global-transform, pre-origin.
     * Per-node scene-graph transforms have already been baked upstream
     * (EasyShape: OperationBucket.syncPrimitives; EasyTrace: identity until
     * per-object transforms land - same future code path).
     *
     * This translator is the ONE AND ONLY place geometry crosses into
     * MACHINE SPACE. It applies a single combined matrix:
     *
     *     machineMatrix = T(-origin) ⊗ workspaceMatrix
     *
     * provided by cam-core's buildToolpathContext as ctx.transforms.
     * Everything downstream (ToolpathOptimizer, MachineProcessor,
     * GCodeGenerator) operates in machine coordinates and performs NO
     * further coordinate math. GCodeGenerator's old per-command origin
     * subtraction (transformCommand/originOffset) is deleted.
     *
     * transforms.machineIsIdentity short-circuits applyTransforms so
     * untransformed jobs (typical EasyShape session with origin at 0,0)
     * pay zero matrix cost and zero point allocations.
     */
    class GeometryTranslator {
        constructor(core) {
            this.core = core;
            // Initialize the tab planning module
            if (typeof ToolpathTabPlanner !== 'undefined') {
                this.tabPlanner = new ToolpathTabPlanner(this);
            } else {
                console.error("[GeometryTranslator] ToolpathTabPlanner module missing.");
            }
            // Delegate translator for 3D contours (V-Carve chains, relief
            // rasters): native path3d input, phase ranking, slope-gated
            // plunge feeds. Inline translate3DContour remains as fallback.
            // REVIEW - Is this why EasyTrace5000 needs the 3d translator?
            this.t3d = new Toolpath3DTranslator(this);
        }

        // ────────────────────────────────────────────────────────────
        // Main Router - Primitive-Driven
        // ────────────────────────────────────────────────────────────

        /**
         * Translates a single operation's offset geometry into ToolpathPlans.
         * Phase 1 - Pre-scan:  Groups concentric circle/obround drill milling paths by holeIndex and emits one macro plan per hole.  All other primitives pass through.
         * Phase 2 - Per-primitive dispatch based on properties.role and properties.tabConfig.  No operation-type checks.
         */
        async translateOperation(operation, ctx) {
            const plans = [];
            let featureSeq = 0;

            // Phase 1 - Extract grouped drill milling macros
            const { macroPlans, remainingPrimitives } =
                this.extractDrillMacros(operation, ctx);
            plans.push(...macroPlans);

            // Phase 2 - Role-based dispatch for everything else
            for (const primitive of remainingPrimitives) {
                const props = primitive.properties || {};
                const role = props.role;

                // 3D contours (V-Carve) - points carry their own Z.
                // Bypasses depthLevels entirely (vcarve has no cutDepth).
                if (props.is3DContour) {
                    plans.push(...this.translate3DContour(primitive, ctx));
                    continue;
                }

                // Point-based macros (peck marks)
                if (role === 'peck_mark') {
                    plans.push(this.translatePeckMark(primitive, ctx));
                    continue;
                }

                // Remaining drill milling paths (centerlines, ungrouped fallbacks)
                if (role === 'drill_milling_path') {
                    if (props.isCenterlinePath) {
                        plans.push(...this.translateCenterlinePath(primitive, ctx));
                    } else {
                        plans.push(...this.translateDrillMill(primitive, ctx));
                    }
                    continue;
                }

                // Standard contour routing (isolation, clearing, cutout, stencil)
                let processable = primitive;

                // Ensure primitive is a path
                if (primitive.type !== 'path') {
                    const converted = typeof GeometryUtils !== 'undefined'
                        ? GeometryUtils.primitiveToPath(primitive)
                        : null;
                    if (converted?.contours?.length > 0) {
                        processable = converted;
                    }
                }

                if (!processable.contours?.length) {
                    // Fallback for raw circles/rectangles that couldn't be converted
                    plans.push(...this.processStandardPrimitive(processable, ctx));
                    continue;
                }

                const parentShapeKey = primitive.properties?.shapeKey ?? null;
                const parentPass = primitive.properties?.pass ?? null;
                const featureId = `${ctx.operationId}:sk${parentShapeKey ?? 'x'}:f${featureSeq++}`;

                // Process contours (checking for tab configuration)
                for (const contour of processable.contours) {
                    const isHole = contour.isHole || false;
                    const tabCount = ctx.strategy?.cutout?.tabs || 0;
                    const isTabbedCutout = (ctx.operationType === 'cutout' || ctx.operationType === 'profile') && tabCount > 0;

                    if (isTabbedCutout && this.tabPlanner) {
                        plans.push(...this.processTabbedContour(contour, ctx, isHole, parentShapeKey, featureId, parentPass));
                    } else {
                        plans.push(...this.processStandardContour(contour, processable, ctx, isHole, parentShapeKey, featureId, parentPass));
                    }
                }
            }

            return plans;
        }

        /**
         * Drill Macro Extraction (Pre-Scan)
         */

        /**
         * Groups concentric circle and obround drill milling paths by holeIndex, then emits a single drillMillMacro plan per hole.
         * Returns the macro plans and the list of primitives that were NOT consumed (pecks, centerlines, non-drill geometry).
         */
        extractDrillMacros(operation, ctx) {
            const macroPlans = [];
            const remainingPrimitives = [];
            const { operationId, tool, cutting, strategy, transforms, computed } = ctx;

            const circleMillByHole = new Map();
            const obroundMillByHole = new Map();

            // Scan all offset primitives
            for (const offset of operation.offsets) {
                for (const primitive of offset.primitives) {
                    const props = primitive.properties || {};

                    if (props.role === 'drill_milling_path' && !props.isCenterlinePath) {
                        if (primitive.type === 'circle') {
                            if (!circleMillByHole.has(holeIdxOf(props))) circleMillByHole.set(holeIdxOf(props), []);
                            circleMillByHole.get(holeIdxOf(props)).push(primitive);
                            continue;
                        } else if (primitive.type === 'obround') {
                            if (!obroundMillByHole.has(holeIdxOf(props))) obroundMillByHole.set(holeIdxOf(props), []);
                            obroundMillByHole.get(holeIdxOf(props)).push(primitive);
                            continue;
                        }
                    }
                    remainingPrimitives.push(primitive);
                }
            }

            // Emit circle macro plans
            for (const [holeIdx, holePrimitives] of circleMillByHole) {
                const rings = holePrimitives.map((prim, idx) => {
                    // Clone via transform (or explicit copy on identity) so ring
                    // centers never alias live source-primitive objects.
                    const tc = this.applyTransforms(prim.center, transforms);
                    return {
                        center: (tc === prim.center) ? { x: tc.x, y: tc.y } : tc,
                        radius: prim.radius,
                        pass: idx + 1
                    };
                });

                const innerRing = rings[0];
                const entryX = innerRing.center.x + innerRing.radius;
                const entryY = innerRing.center.y;

                const plan = new ToolpathPlan(operationId);
                plan.metadata.context = ctx;
                plan.metadata.transforms = ctx.transforms;
                plan.metadata.operationId = operationId;
                plan.metadata.operationType = 'drill';
                plan.metadata.isDrillMilling = true;
                plan.metadata.drillMillMacro = true;
                plan.metadata.entryType = strategy.entryType || 'plunge';
                plan.metadata.concentricRings = rings;
                plan.metadata.depthLevels = computed.depthLevels;
                plan.metadata.cutDepth = computed.depthLevels[computed.depthLevels.length - 1];
                plan.metadata.depthPerPass = strategy.depthPerPass;
                plan.metadata.feedRate = cutting.feedRate;
                plan.metadata.plungeRate = cutting.plungeRate;
                plan.metadata.spindleSpeed = cutting.spindleSpeed;
                plan.metadata.spindleDwell = cutting.spindleDwell;
                plan.metadata.toolDiameter = tool.diameter;
                plan.metadata.center = innerRing.center;
                plan.metadata.radius = innerRing.radius;
                plan.metadata.isSimpleCircle = true;
                plan.metadata.isClosedLoop = true;
                plan.metadata.primitiveType = 'circle';
                plan.metadata.entryPoint = { x: entryX, y: entryY };
                plan.metadata.exitPoint = { x: entryX, y: entryY };
                plan.metadata.groupKey = `T:${tool.diameter.toFixed(3)}_OP:${operationId}_TYPE:drill_mill`;
                plan.metadata.optimization = {
                    linkType: 'rapid',
                    optimizedEntryPoint: { ...plan.metadata.entryPoint },
                    entryCommandIndex: 0
                };

                macroPlans.push(plan);
            }

            // Emit obround macro plans
            for (const [holeIdx, holePrimitives] of obroundMillByHole) {
                const rings = holePrimitives.map((prim, idx) => {
                    const oData = this.getObroundData(prim);
                    // getObroundData returns fresh objects, so identity
                    // passthrough from applyTransforms is alias-safe here.
                    oData.startCapCenter = this.applyTransforms(oData.startCapCenter, transforms);
                    oData.endCapCenter = this.applyTransforms(oData.endCapCenter, transforms);
                    oData.pA = this.applyTransforms(oData.pA, transforms);
                    oData.pB = this.applyTransforms(oData.pB, transforms);
                    oData.pC = this.applyTransforms(oData.pC, transforms);
                    oData.pD = this.applyTransforms(oData.pD, transforms);

                    // Normalize the sequence so the macro can remain transform agnostic.
                    // windingFlipped is det-based (matches the matrix), replacing the
                    // old mirrorX XOR mirrorY param check - identical result for
                    // workspace params, but stays correct if the matrix ever carries
                    // a reflection the params don't describe. // REVIEW - remove fallback? Fix consequences?
                    const isFlipped = !!(transforms && transforms.windingFlipped);
                    if (isFlipped) {
                        const tempB = oData.pB; oData.pB = oData.pC; oData.pC = tempB;
                        const tempA = oData.pA; oData.pA = oData.pD; oData.pD = tempA;
                        const tempStart = oData.startCapCenter; oData.startCapCenter = oData.endCapCenter; oData.endCapCenter = tempStart;
                    }
                    return { ...oData, pass: idx + 1 };
                });

                const innerRing = rings[0];
                const entryPoint = innerRing.pB; // Always use pB. It is guaranteed correct.

                const plan = new ToolpathPlan(operationId);
                plan.metadata.context = ctx;
                plan.metadata.transforms = ctx.transforms;
                plan.metadata.operationId = operationId;
                plan.metadata.operationType = 'drill';
                plan.metadata.isDrillMilling = true;
                plan.metadata.drillMillMacro = true;
                plan.metadata.slotMacro = true;
                plan.metadata.entryType = strategy.entryType || 'plunge';
                plan.metadata.obroundRings = rings;
                plan.metadata.depthLevels = computed.depthLevels;
                plan.metadata.cutDepth = computed.depthLevels[computed.depthLevels.length - 1];
                plan.metadata.depthPerPass = strategy.depthPerPass;
                plan.metadata.feedRate = cutting.feedRate;
                plan.metadata.plungeRate = cutting.plungeRate;
                plan.metadata.spindleSpeed = cutting.spindleSpeed;
                plan.metadata.spindleDwell = cutting.spindleDwell;
                plan.metadata.toolDiameter = tool.diameter;
                plan.metadata.isClosedLoop = true;
                plan.metadata.isSimpleCircle = false;
                plan.metadata.primitiveType = 'obround';
                plan.metadata.entryPoint = { x: entryPoint.x, y: entryPoint.y };
                plan.metadata.exitPoint = { x: entryPoint.x, y: entryPoint.y };
                plan.metadata.groupKey = `T:${tool.diameter.toFixed(3)}_OP:${operationId}_TYPE:drill_mill`;
                plan.metadata.optimization = {
                    linkType: 'rapid',
                    optimizedEntryPoint: { ...plan.metadata.entryPoint },
                    entryCommandIndex: 0
                };

                macroPlans.push(plan);
            }

            return { macroPlans, remainingPrimitives };
        }

        /**
         * Specific Translation Macros
         */

        translatePeckMark(primitive, ctx) {
            const { operationId, tool, cutting, strategy, transforms, computed } = ctx;

            const plan = new ToolpathPlan(operationId);
            plan.metadata.context = ctx;
            plan.metadata.transforms = ctx.transforms;
            plan.metadata.tool = tool;
            plan.metadata.cutDepth = computed.depthLevels[computed.depthLevels.length - 1];
            plan.metadata.feedRate = cutting.feedRate;
            plan.metadata.plungeRate = cutting.plungeRate;
            plan.metadata.spindleSpeed = cutting.spindleSpeed;
            plan.metadata.spindleDwell = cutting.spindleDwell;
            plan.metadata.isPeckMark = true;

            const transformedCenter = this.applyTransforms(primitive.center, transforms);
            plan.metadata.entryPoint = { x: transformedCenter.x, y: transformedCenter.y };
            plan.metadata.exitPoint = { x: transformedCenter.x, y: transformedCenter.y };
            plan.metadata.groupKey = `T:${tool.diameter.toFixed(3)}_OP:drill_TYPE:peck`;

            // Pack cycle parameters for the Machine Processor
            plan.metadata.peckCycle = {
                cannedCycle: strategy.drill.cannedCycle || 'none',
                peckDepth: strategy.drill.peckDepth || 0,
                dwellTime: strategy.drill.dwellTime || 0,
                retractHeight: strategy.drill.retractHeight || 0.5
            };

            plan.metadata.peckData = {
                position: (transformedCenter === primitive.center)
                    ? { x: transformedCenter.x, y: transformedCenter.y }
                    : transformedCenter,
                ...primitive.properties
            };

            plan.metadata.optimization = {
                linkType: 'rapid',
                optimizedEntryPoint: { ...plan.metadata.entryPoint },
                entryCommandIndex: 0
            };

            return plan;
        }

        /**
         * Drill milling paths that weren't captured by the macro grouping pre-scan (e.g. path-type geometry).
         */
        translateDrillMill(primitive, ctx) {
            const plans = [];
            const isClosed = primitive.type === 'circle' || primitive.type === 'obround' ||
                             (primitive.contours?.[0]?.points?.length >= 3);

            const drillMillCtx = { ...ctx, isDrillMilling: true };
            const geometryEntity = (primitive.type === 'path' && primitive.contours?.length > 0)
                ? primitive.contours[0]
                : primitive;

            const plan = this.createPurePlan(geometryEntity, drillMillCtx, isClosed, false, true);
            if (plan) {
                plan.metadata.isDrillMilling = true;
                plan.computeBounds();
                if (isClosed) this.enforceClimbMilling(plan, false);
                plans.push(plan);
            }

            return plans;
        }

        /**
         * Specialized translator for Centerline Slot Paths.
         * Generates a single "Macro" plan that the MachineProcessor expands into a Zig-Zag pattern.
         */
        translateCenterlinePath(primitive, ctx) {
            const plans = [];

            // Centerline slots are wrapped in a PathPrimitive, so the points are in the first contour.
            const contour = primitive.contours[0];
            const points = contour?.points;

            if (!points || points.length < 2) return [];

            const startPoint = points[0];
            const endPoint = points[points.length - 1];
            const slotLength = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);

            // Create the plan using the contour points
            const plan = this.createPurePlan(contour, ctx, false, false, false);

            if (plan && plan.metadata.exitPoint) {
                // Only update the Z-depth of the exit point
                plan.metadata.primitiveType = 'centerline_slot';
                plan.metadata.isCenterlinePath = true;
                plan.metadata.isDrillMilling = true;
                plan.metadata.toolDiameter = ctx.tool.diameter;
                plan.metadata.slotLength = slotLength;

                // Instruct Machine Processor to perform zigzag step-downs
                plan.metadata.strategy = {
                    zigzag: true,
                    cutDepth: ctx.strategy.cutDepth,
                    depthPerPass: ctx.strategy.depthPerPass,
                    feedRate: ctx.cutting.feedRate,
                    plungeRate: ctx.cutting.plungeRate
                };

                // Use the transformed exit point for the guide command so MachineProcessor knows where the slot ends in machine coordinates.
                const targetX = plan.metadata.exitPoint.x;
                const targetY = plan.metadata.exitPoint.y;

                plan.commands.push(new MotionCommand(
                    'LINEAR',
                    { x: targetX, y: targetY },
                    { feed: ctx.cutting.feedRate }
                ));

                plan.computeBounds();
                plans.push(plan);
            }

            return plans;
        }

        /**
         * Translates a 3D contour primitive (V-Carve skeleton chain) into
         * one open-path plan per contour. Every point carries its own Z;
         * downstream stages must preserve it (metadata.is3DContour gates
         * the MachineProcessor Z-overwrite and the optimizer's staydown
         * links and 2D collinear simplifier).
         */
        // REVIEW - Why keep this alias? Just connect directly?
        translate3DContour(primitive, ctx) {
            return this.t3d.translate(primitive, ctx);
        }

        /**
         * Standard Multi-Depth Routing & Tabbing
         */

        processStandardContour(contour, primitive, ctx, isHole, parentShapeKey, featureId, parentPass) {
            const shapeKey = parentShapeKey ?? primitive.properties?.shapeKey ?? null;
            const isClosed = primitive.closed ?? true;
            const plan = this.createPurePlan(contour, ctx, isClosed, isHole, true);
            if (plan) {
                plan.metadata.shapeKey = shapeKey;
                plan.metadata.featureId = featureId ?? null;
                plan.metadata.pass = parentPass ?? plan.metadata.pass;
                plan.computeBounds();
                // Climb direction is a boundary-cutting rule. A centerline pass
                // is fully engaged whichever way it runs, so forcing CW only
                // scrambles the source artwork's own ordering.
                if (isClosed && !primitive.properties?.preserveDirection) {
                    this.enforceClimbMilling(plan, isHole);
                }
                return [plan];
            }
            return [];
        }

        processStandardPrimitive(primitive, ctx) {
            const isHole = primitive.properties?.isHole || primitive.properties?.polarity === 'clear';
            const isClosed = primitive.type === 'circle' ||
                             primitive.type === 'obround' ||
                             primitive.type === 'rectangle' ||
                             (primitive.closed !== false);

            const shapeKey = primitive.properties?.shapeKey ?? null;
            const featureId = `${ctx.operationId}:sk${shapeKey ?? 'x'}:prim`;
            const parentPass = primitive.properties?.pass ?? null;

            const plan = this.createPurePlan(primitive, ctx, isClosed, isHole, true);
            if (plan) {
                plan.metadata.featureId = featureId;
                plan.metadata.pass = parentPass ?? plan.metadata.pass;
                plan.computeBounds();
                if (isClosed && !primitive.properties?.preserveDirection) {
                    this.enforceClimbMilling(plan, isHole);
                }
                return [plan];
            }
            return [];
        }

        /**
         * Processes a contour that has tabConfig attached.
         */
        processTabbedContour(contour, ctx, isHole, parentShapeKey, featureId, parentPass) {
            const tabConfig = ctx.strategy.cutout; 

            // Generate the tab-sliced path if tabs are requested
            let commandsToSend = [];
            if (tabConfig.tabs > 0 && this.tabPlanner) {
                commandsToSend = this.tabPlanner.calculateTabPositions(contour, ctx);
            }

            // Fallback to standard generation if tabPlanner is missing or tabs is 0
            // REVIEW - Why is this necessary?!?
            if (!commandsToSend || commandsToSend.length === 0) {
                const tempPlan = new ToolpathPlan(ctx.operationId);
                tempPlan.metadata.context = ctx;
                tempPlan.metadata.transforms = ctx.transforms;
                tempPlan.metadata.isClosed = true;
                this.translatePrimitiveToCutting(tempPlan, contour, ctx.cutting.feedRate);
                commandsToSend = tempPlan.commands;
            }

            const plan = this.createPurePlan(contour, ctx, true, isHole, false);
            if (!plan) return [];

            plan.metadata.shapeKey = parentShapeKey ?? plan.metadata.shapeKey;
            plan.metadata.featureId = featureId ?? null;
            plan.metadata.pass = parentPass ?? plan.metadata.pass;

            // Assign the single source of truth for the optimizer
            plan.commands = commandsToSend;

            // Flag that this plan has tab segments requiring Z-expansion
            plan.metadata.isTabbedPass = tabConfig.tabs > 0;

            // Calculate tab top from the absolute bottom machine depth
            const finalDepth = ctx.computed.depthLevels[ctx.computed.depthLevels.length - 1];
            plan.metadata.tabTopZ = finalDepth + tabConfig.tabHeight;

            // Pass the depth levels array
            plan.metadata.depthLevels = ctx.computed.depthLevels;

            plan.computeBounds();
            this.enforceClimbMilling(plan, isHole);
            
            return [plan];
        }

        /**
         * Core Translation Utilities
         */

        // TODO [METADATA-BLOAT] - plan.metadata.context is now referenced by
        // exactly ONE remaining consumer family: MachineProcessor's
        // determineWinding/planContext (5 sites). metadata.transforms is
        // already stamped alongside; migrate those reads, then delete the 7
        // context stamps. Separately: the big multipliers are MotionCommand
        // (COMMAND-STREAM-MEMORY) and the per-depth-level {...cmd} clones +
        // metadata.standardCommands in MachineProcessor's tab expansion -
        // both resolve together in the packed-stream refactor.
        createPurePlan(primitive, ctx, isClosed, isHole, generateCommands = true) {
            // Get all settings from the context
            const { operationId, operationType, tool, cutting, strategy } = ctx;

            const plan = new ToolpathPlan(operationId);
            plan.metadata.context = ctx; 
            plan.metadata.transforms = ctx.transforms;

            // Set metadata
            plan.metadata.operationId = ctx.operationId;
            plan.metadata.operationType = ctx.operationType;
            plan.metadata.depthLevels = ctx.computed.depthLevels; // Pass depths for MachineProcessor
            plan.metadata.finalDepth = strategy.cutDepth;
            plan.metadata.feedRate = cutting.feedRate;
            plan.metadata.plungeRate = cutting.plungeRate;
            plan.metadata.entryType = strategy.entryType;
            plan.metadata.depthPerPass = strategy.depthPerPass;
            plan.metadata.spindleSpeed = cutting.spindleSpeed;
            plan.metadata.spindleDwell = cutting.spindleDwell;
            plan.metadata.toolDiameter = tool.diameter;
            plan.metadata.stepOver = strategy.stepOver;
            plan.metadata.toolpathPolicy = ctx.computed?.toolpathPolicy ?? null;

            const isDrillMilling = ctx.isDrillMilling || false;
            const typeKey = isDrillMilling ? 'drill_mill' : 'mill';
            plan.metadata.groupKey = `T:${tool.diameter.toFixed(3)}_OP:${ctx.operationId}_TYPE:${typeKey}`;

            plan.metadata.primitiveType = primitive.type || 'path';
            plan.metadata.isClosed = isClosed;
            plan.metadata.isHole = isHole;
            plan.metadata.shapeKey = primitive.properties?.shapeKey ?? null; 
            const passNum = primitive.properties?.pass ?? null;
            plan.metadata.pass = passNum;

            // Analyze primitive sets entry/exit points and metadata
            this.analyzePrimitive(plan, primitive);

            // Apply the machine transform to entry/exit points.
            // Gate on the MATRIX, not on rotation/mirror params - with origin
            // folded into machineMatrix, the matrix is non-identity whenever
            // origin ≠ (0,0), which the old param check missed.
            const transforms = ctx.transforms;
            if (!this.isIdentityTransforms(transforms)) {
                // Transform Entry and Exit
                if (plan.metadata.entryPoint) {
                    const transformed = this.applyTransforms(plan.metadata.entryPoint, transforms);
                    plan.metadata.entryPoint.x = transformed.x;
                    plan.metadata.entryPoint.y = transformed.y;
                }
                if (plan.metadata.exitPoint) {
                    const transformed = this.applyTransforms(plan.metadata.exitPoint, transforms);
                    plan.metadata.exitPoint.x = transformed.x;
                    plan.metadata.exitPoint.y = transformed.y;
                }

                // Transform Geometry Centers
                if (plan.metadata.obroundData) {
                    const od = plan.metadata.obroundData;

                    // Transform centers
                    od.startCapCenter = this.applyTransforms(od.startCapCenter, transforms);
                    od.endCapCenter = this.applyTransforms(od.endCapCenter, transforms);

                    // Transform all corner points
                    if (od.pA) od.pA = this.applyTransforms(od.pA, transforms);
                    if (od.pB) od.pB = this.applyTransforms(od.pB, transforms);
                    if (od.pC) od.pC = this.applyTransforms(od.pC, transforms);
                    if (od.pD) od.pD = this.applyTransforms(od.pD, transforms);

                    // Re-link metadata.center
                    if (plan.metadata.center) {
                        plan.metadata.center = od.startCapCenter;
                    }
                }
                else if (plan.metadata.center) {
                    plan.metadata.center = this.applyTransforms(plan.metadata.center, transforms);
                }
            }

            // Generate commands only if explicitly requested
            if (generateCommands) {
                this.translatePrimitiveToCutting(plan, primitive, cutting.feedRate);
            }


            plan.metadata.optimization = {
                linkType: 'rapid',
                // COPY, never an alias. rotateCircleEntry and rotatePlanCommands
                // REPLACE metadata.entryPoint wholesale, and MachineProcessor's
                // indexed +apothem bump walks entryPoint, exitPoint AND
                // optimizedEntryPoint - a shared object gets shifted twice.
                optimizedEntryPoint: { ...plan.metadata.entryPoint },
                entryCommandIndex: 0
            };

            // Note: Bounds, winding and tab logic must be performed by the caller (translateOperation) after the final command set is chosen.
            return plan;
        }

        /**
         * Analyze geometry to extract entry/exit points and metadata.
         * @param {Object} geometry - The raw geometry object (Contour or Analytic Primitive)
         */
        analyzePrimitive(plan, geometry) {
            const metadata = plan.metadata;

            // Determine type. Contours have no 'type' property, so they default to 'path'.
            const type = geometry.type || 'path';

            if (type === 'circle') {
                metadata.entryPoint = {
                    x: geometry.center.x + geometry.radius,
                    y: geometry.center.y
                };
                metadata.exitPoint = { ...metadata.entryPoint };
                metadata.isClosedLoop = true;
                metadata.isSimpleCircle = true;
                metadata.primitiveType = 'circle';
                metadata.center = geometry.center;
                metadata.radius = geometry.radius;

            } else if (type === 'obround') {
                const isHorizontal = geometry.width > geometry.height;
                const startAngle = isHorizontal ? (Math.PI / 2) : Math.PI;
                const obroundData = this.getObroundData(geometry);

                metadata.obroundData = obroundData;

                metadata.entryPoint = {
                    x: obroundData.startCapCenter.x + obroundData.slotRadius * Math.cos(startAngle),
                    y: obroundData.startCapCenter.y + obroundData.slotRadius * Math.sin(startAngle)
                };

                metadata.exitPoint = { ...metadata.entryPoint };
                metadata.isClosedLoop = true;
                metadata.isSimpleCircle = false;
                metadata.primitiveType = 'obround';
                metadata.obroundData = obroundData;
                metadata.center = obroundData.startCapCenter;
                metadata.radius = obroundData.slotRadius;

            } else if (type === 'arc') {
                metadata.entryPoint = { ...geometry.startPoint }; 
                metadata.exitPoint = { ...geometry.endPoint }; 
                metadata.isClosedLoop = false;
                metadata.primitiveType = 'arc';

            } else if (type === 'path') {
                const points = geometry.points || (geometry.contours && geometry.contours[0]?.points);

                if (points && points.length > 0) {
                    metadata.entryPoint = { ...points[0] };
                    metadata.isClosedLoop = plan.metadata.isClosed;

                    if (metadata.isClosedLoop) {
                        metadata.exitPoint = { ...metadata.entryPoint };
                    } else {
                        metadata.exitPoint = { ...points[points.length - 1] };
                    }

                    metadata.primitiveType = 'path';
                    // Check for arc segments
                    metadata.hasArcs = geometry.arcSegments && geometry.arcSegments.length > 0;

                    // THE decision point. Everything downstream - translatePath,
                    // enforceClimbMilling, computeBounds, samplePlanPoints,
                    // rotateCircleEntry, the MachineProcessor entry move - reads
                    // isSimpleCircle/center/radius and never re-derives.
                    // center is set UNTRANSFORMED; createPurePlan transforms it
                    // right after this call, same contract as the circle and
                    // obround branches above.
                    // The reconstructor's flag is ground truth and needs no
                    // measuring. detectCircularContour is the fallback for the
                    // legacy tessellated shape only.
                    // REVIEW - Trim comment
                    const arc0 = geometry.arcSegments?.[0];
                    const circle = (geometry.isFullCircle && arc0?.center && arc0.radius > 0)
                        ? { center: { x: arc0.center.x, y: arc0.center.y }, radius: arc0.radius }
                        : this.detectCircularContour(points, geometry.arcSegments, metadata.isClosedLoop);

                    if (circle) {
                        metadata.isSimpleCircle = true;
                        metadata.center = circle.center;
                        metadata.radius = circle.radius;
                    }
                }
            }
        }

        /**
         * LEGACY SHAPE ONLY: GeometryUtils.circleToPath output - N points and N
         * micro-arcs, one per edge, all about one centre. This still reaches the
         * translator because translateOperation runs primitiveToPath on analytic
         * primitives before the contour loop (deliberately: the tab planner
         * needs the tessellated ring).
         *
         * Reconstructor output does NOT come through here - it carries an
         * explicit contour.isFullCircle, which analyzePrimitive reads first.
         * Do not add cases to this function; add them to the flag instead.
         *
         * The test is structural, not tolerance-based: arc count === point count
         * means every edge of the closed ring is an arc.
         */
        // REVIEW - This sounds like a legacy safeguard? why not guaranteed circleToPath is processed correctly before reaching this stage?
        detectCircularContour(points, arcSegments, isClosedLoop) {
            if (!isClosedLoop || !points || !arcSegments || arcSegments.length < 3) return null;
            if (arcSegments.length !== points.length) return null;

            const c0 = arcSegments[0];
            if (!c0.center || !(c0.radius > 0)) return null;

            const sameCircle = arcSegments.every(a =>
                a.center &&
                Math.abs(a.center.x - c0.center.x) < PRECISION &&
                Math.abs(a.center.y - c0.center.y) < PRECISION &&
                Math.abs(a.radius - c0.radius) < PRECISION
            );
            if (!sameCircle) return null;

            return { center: { x: c0.center.x, y: c0.center.y }, radius: c0.radius };
        }

        /**
         * Translate primitive to pure cutting commands
         */
        translatePrimitiveToCutting(plan, geometry, feedRate) {
            // Default to 'path' if no type (handles Contours)
            const type = geometry.type || 'path'; 

            if (type === 'circle') {
                this.translateCircle(plan, geometry, feedRate, false);
            } else if (type === 'obround') {
                this.translateObround(plan, geometry, feedRate, false);
            } else if (type === 'arc') {
                this.translateArc(plan, geometry, feedRate);
            } else if (type === 'path') {
                this.translatePath(plan, geometry, feedRate);
            }
        }

        /**
         * Translate circle to cutting commands
         */
        translateCircle(plan, primitive, feedRate, clockwise) {
            const transforms = plan.metadata.transforms;

            // Transform the Center
            const center = this.applyTransforms(primitive.center, transforms);
            const radius = primitive.radius;

            // Determine the Transformed Start Point
            // The primitive "starts" at 3 o'clock (0 radians) in local space.
            // Transform this point so the arc starts exactly where the Entry Point is.
            const rawStart = {
                x: primitive.center.x + primitive.radius,
                y: primitive.center.y
            };
            const transformedStart = this.applyTransforms(rawStart, transforms);

            // Always CW for climb milling (coordinates already transformed)
            const actualClockwise = true;

            // Generate Arc
            const i = center.x - transformedStart.x;
            const j = center.y - transformedStart.y;

            plan.addArc(
                transformedStart.x, 
                transformedStart.y, 
                undefined,
                i, j, 
                actualClockwise, 
                feedRate
            );
        }

        /**
         * Translate obround to cutting commands (2 lines, 2 arcs)
         */
        translateObround(plan, primitive, feedRate, clockwise) {
            const transforms = plan.metadata.transforms;
            const slotRadius = Math.min(primitive.width, primitive.height) / 2;
            const isHorizontal = primitive.width > primitive.height;

            let startCapCenter, endCapCenter;
            if (isHorizontal) {
                const centerY = primitive.position.y + primitive.height / 2;
                startCapCenter = { x: primitive.position.x + slotRadius, y: centerY };
                endCapCenter = { x: primitive.position.x + primitive.width - slotRadius, y: centerY };
            } else {
                const centerX = primitive.position.x + primitive.width / 2;
                startCapCenter = { x: centerX, y: primitive.position.y + slotRadius };
                endCapCenter = { x: centerX, y: primitive.position.y + primitive.height - slotRadius };
            }

            // Transform centers
            startCapCenter = this.applyTransforms(startCapCenter, transforms);
            endCapCenter = this.applyTransforms(endCapCenter, transforms);

            const startAngle1 = isHorizontal ? (Math.PI / 2) : Math.PI;
            const endAngle1 = isHorizontal ? (3 * Math.PI / 2) : (2 * Math.PI);
            const startAngle2 = isHorizontal ? (-Math.PI / 2) : 0;
            const endAngle2 = isHorizontal ? (Math.PI / 2) : Math.PI;

            const pA_x = startCapCenter.x + slotRadius * Math.cos(startAngle1);
            const pA_y = startCapCenter.y + slotRadius * Math.sin(startAngle1);
            const pB_x = startCapCenter.x + slotRadius * Math.cos(endAngle1);
            const pB_y = startCapCenter.y + slotRadius * Math.sin(endAngle1);
            const pC_x = endCapCenter.x + slotRadius * Math.cos(startAngle2);
            const pC_y = endCapCenter.y + slotRadius * Math.sin(startAngle2);
            const pD_x = endCapCenter.x + slotRadius * Math.cos(endAngle2);
            const pD_y = endCapCenter.y + slotRadius * Math.sin(endAngle2);

            const i1 = startCapCenter.x - pA_x;
            const j1 = startCapCenter.y - pA_y;
            const i2 = endCapCenter.x - pC_x;
            const j2 = endCapCenter.y - pC_y;

            // Always CW for climb milling
            const actualClockwise = true;

            if (actualClockwise) {
                plan.addLinear(pD_x, pD_y, undefined, feedRate);
                plan.addArc(pC_x, pC_y, undefined, i2, j2, true, feedRate);
                plan.addLinear(pB_x, pB_y, undefined, feedRate);
                plan.addArc(pA_x, pA_y, undefined, i1, j1, true, feedRate);
            } else {
                plan.addArc(pB_x, pB_y, undefined, i1, j1, false, feedRate);
                plan.addLinear(pC_x, pC_y, undefined, feedRate);
                plan.addArc(pD_x, pD_y, undefined, i2, j2, false, feedRate);
                plan.addLinear(pA_x, pA_y, undefined, feedRate);
            }
        }

        /**
         * Translate arc to cutting commands
         */
        translateArc(plan, primitive, feedRate) {
            // Get Transform Context
            const transforms = plan.metadata.transforms;

            // Transform Absolute Points
            const start = this.applyTransforms(primitive.startPoint, transforms);
            const end = this.applyTransforms(primitive.endPoint, transforms);
            const center = this.applyTransforms(primitive.center, transforms);
            
            // Calculate Relative I/J for G-code
            const i = center.x - start.x;
            const j = center.y - start.y;

            // Handle Winding Direction
            let isClockwise = primitive.clockwise;
            
            // If mirrored, it might be necessary to flip the arc direction
            if (transforms && transforms.windingFlipped) {
                isClockwise = !isClockwise;
            }

            // Add Linear move to Start
            plan.addLinear(start.x, start.y, undefined, feedRate);

            // Check for collapsed arc (Safety)
            const minArcChordLength = 0.01;
            const chordDistance = Math.hypot(end.x - start.x, end.y - start.y);

            // Signed sweep via the shared normalizer.
            const sweep = ToolpathPlan.normalizeArcSweep({
                sweepAngle: primitive.sweepAngle,
                startAngle: primitive.startAngle,
                endAngle: primitive.endAngle,
                clockwise: isClockwise,
                chord: chordDistance,
                radius: primitive.radius
            });
            
            // Only skip if the chord AND the sweep are both tiny
            if (chordDistance < minArcChordLength && Math.abs(sweep) < Math.PI) {
                plan.addLinear(end.x, end.y, undefined, feedRate);
                return;
            }

            // Add Arc Command
            plan.addArc(end.x, end.y, undefined, i, j, isClockwise, feedRate);
        }

        translatePath(plan, contour, feedRate) {
            const points = contour.points;
            if (!points || points.length < 2) return;

            const transforms = plan.metadata.transforms;
            const isClosed = plan.metadata.isClosed;
            const arcSegments = contour.arcSegments || [];
            const minArcChordLength = 0.01;
            const minLinearLength = 0.001;

            // Build arc map
            const arcMap = new Map();
            for (const arc of arcSegments) {
                arcMap.set(arc.startIndex, arc);
            }

            if (plan.metadata.isSimpleCircle &&
                plan.metadata.center && plan.metadata.radius > 0) {
                const start = this.applyTransforms(points[0], transforms);
                const c = plan.metadata.center;
                plan.addArc(start.x, start.y, undefined,
                    c.x - start.x, c.y - start.y, true, feedRate);
                return;
            }

            // Standard segment-by-segment processing
            const isPhysicallyClosed = ToolpathPlan.isClosedPoints(points);
            const numPoints = points.length;
            const segmentsToDraw = (isClosed && !isPhysicallyClosed) ? numPoints : numPoints - 1;

            // Hoist winding flip out of the loop - constant for the whole path
            const windingFlipped = !!(transforms && transforms.windingFlipped);

            let i = 0;
            let segmentsDrawn = 0;
            // Transform the first point ONCE before the loop. Each iteration
            // carries its endPoint into the next iteration's startPoint, so
            // every point is transformed exactly once.
            let startPoint = this.applyTransforms(points[0], transforms);

            while (segmentsDrawn < segmentsToDraw) {
                const arc = arcMap.get(i);

                // An arcSegment spans startIndex..endIndex and REPLACES every
                // point between them. Adjacent indices are the span === 1 case;
                // tessellated spans (obround caps, primitiveToPath's arc) are
                // the rest. Rejecting a span emits its tessellation as chords -
                // correct geometry, silently faceted G-code.
                let arcEnd = -1;
                let arcSpan = 0;
                if (arc && Number.isInteger(arc.endIndex)) {
                    arcEnd = ((arc.endIndex % numPoints) + numPoints) % numPoints;
                    arcSpan = (((arcEnd - i) % numPoints) + numPoints) % numPoints;
                }

                const useArc = arcSpan > 0 &&
                               arcSpan <= (segmentsToDraw - segmentsDrawn) &&
                               arc.center && arc.radius > 0;

                const nextIndex = useArc ? arcEnd : (i + 1) % numPoints;
                const endPoint = this.applyTransforms(points[nextIndex], transforms);

                if (useArc) {
                    const chordDistance = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);

                    // Shared normalizer
                    const sweep = ToolpathPlan.normalizeArcSweep({
                        sweepAngle: arc.sweepAngle,
                        startAngle: arc.startAngle,
                        endAngle: arc.endAngle,
                        clockwise: arc.clockwise,
                        chord: chordDistance,
                        radius: arc.radius
                    });

                    // Allow arcs with a tiny chord IF their sweep angle is massive (e.g., a full circle)
                    if (chordDistance >= minArcChordLength || Math.abs(sweep) >= Math.PI) {
                        const transformedCenter = this.applyTransforms(arc.center, transforms);
                        const i_val = transformedCenter.x - startPoint.x;
                        const j_val = transformedCenter.y - startPoint.y;
                        let clockwise = arc.clockwise;
                        // If mirrored, it might be necessary to flip the arc direction
                        if (windingFlipped) { clockwise = !clockwise; }
                        plan.addArc(endPoint.x, endPoint.y, undefined, i_val, j_val, clockwise, feedRate);
                    } else {
                        // Tiny arc, use line
                        plan.addLinear(endPoint.x, endPoint.y, undefined, feedRate);
                    }
                    segmentsDrawn += arcSpan;
                } else {
                    // Linear segment
                    const dist = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
                    if (dist > minLinearLength) {
                        plan.addLinear(endPoint.x, endPoint.y, undefined, feedRate);
                    }
                    segmentsDrawn++;
                }

                i = nextIndex;
                startPoint = endPoint;
            }
        }

        /**
         * Reverses a toolpath plan in-place.
         * Rebuilds the path from absolute points, correctly flipping arcs.
         */
        reversePlan(plan) {
            if (!plan || !plan.commands || plan.commands.length === 0) return;

            const commands = plan.commands;
            const newCommands = [];

            // Build an absolute point list from the original path
            const points = [{ ...plan.metadata.entryPoint }];
            let currentPos = { ...plan.metadata.entryPoint };

            for (const cmd of commands) {
                const nextPos = {
                    x: cmd.x !== null ? cmd.x : currentPos.x,
                    y: cmd.y !== null ? cmd.y : currentPos.y,
                    z: cmd.z, // Preserve original null state instead of currentPos.z
                    feed: cmd.f,
                    // Store the command info *on the point it leads to*
                    cmdType: cmd.type,
                    i: cmd.i,
                    j: cmd.j,
                    // Capture metadata to preserve 'isTab' flags
                    metadata: cmd.metadata
                };
                points.push(nextPos);
                currentPos = nextPos;
            }

            // Iterate the point list backwards to create new commands
            // Start from the last point (new entry) and move to the first (new exit)
            for (let i = points.length - 1; i > 0; i--) {
                const startPos = points[i]; // The new start point
                const endPos = points[i - 1]; // The new end point

                // The command data is stored on the 'startPos' (original end point)
                const cmdType = startPos.cmdType;
                const feed = startPos.feed;
                const meta = startPos.metadata;
                const zVal = startPos.z; // Keeps null for 2D moves

                let newCmd;

                if (cmdType === 'ARC_CW' || cmdType === 'ARC_CCW') {
                    // This command was an arc. Create its reverse.
                    const newType = cmdType === 'ARC_CW' ? 'ARC_CCW' : 'ARC_CW';
                    // The original 'i, j' was relative to the original start (endPos)
                    // Set the center from that.
                    const centerX = endPos.x + startPos.i;
                    const centerY = endPos.y + startPos.j;

                    // Calculate the new 'i, j' relative to the *new* start (startPos)
                    const new_i = centerX - startPos.x;
                    const new_j = centerY - startPos.y;

                    newCmd = new MotionCommand(
                        newType,
                        { x: endPos.x, y: endPos.y, z: zVal },
                        { i: new_i, j: new_j, feed: feed }
                    );
                } else {
                    // Default to Linear
                    newCmd = new MotionCommand(
                        'LINEAR',
                        { x: endPos.x, y: endPos.y, z: zVal },
                        { feed: feed }
                    );
                }

                // Restore metadata to the new command
                if (meta) {
                    newCmd.metadata = { ...meta };
                }

                newCommands.push(newCmd);
            }

            plan.commands = newCommands;

            // Swap entry/exit points
            const oldEntry = plan.metadata.entryPoint;
            plan.metadata.entryPoint = plan.metadata.exitPoint;
            plan.metadata.exitPoint = oldEntry;
        }

        /**
         * Enforces climb milling direction on generated commands and must be called AFTER commands are generated (post-transform).
         * Climb milling direction:
         * - External contours: CW
         * - Hole contours: CCW
         */
        enforceClimbMilling(plan, isHole = false) {
            if (!plan.commands || plan.commands.length === 0) return false;
            if (!plan.metadata.isClosed && !plan.metadata.isClosedLoop) return false;

            const wantCW = !isHole; // External = CW (climb), Hole = CCW (climb)

            // A circle is ONE arc command, so the endpoint-winding scan below
            // has nothing to measure and used to bail - which left every
            // circular hole cutting conventional. Direction is declarative
            // here: flipping a 2*PI arc keeps the same start point and the same
            // I/J, only the opcode changes. This is also correct under mirror,
            // where the point scan measures post-transform winding but hole-ness
            // is invariant.
            // REVIEW - Trim comment
            if (plan.metadata.isSimpleCircle && plan.commands.length === 1) {
                const cmd = plan.commands[0];
                if (cmd.type !== 'ARC_CW' && cmd.type !== 'ARC_CCW') return false;
                if ((cmd.type === 'ARC_CW') === wantCW) return false;
                cmd.type = wantCW ? 'ARC_CW' : 'ARC_CCW';
                return true;
            }

            // Skip open paths and empty plans
            if (plan.commands.length < 2) return false;

            // Build point list from generated commands
            const commandPoints = [];
            let pos = { ...plan.metadata.entryPoint };

            for (const cmd of plan.commands) {
                if (cmd.x !== null && cmd.x !== undefined) pos.x = cmd.x;
                if (cmd.y !== null && cmd.y !== undefined) pos.y = cmd.y;
                commandPoints.push({ x: pos.x, y: pos.y });
            }

            if (commandPoints.length < 3) return false;

            const isCW = GeometryUtils.isClockwise(commandPoints);

            if (isCW !== wantCW) {
                this.reversePlan(plan);
                return true;
            }
            return false;
        }

        /**
         * Geometry Utilities
         */

        /**
         * Extracts dimensional data from an obround primitive.
         */
        getObroundData(primitive) {
            if (primitive.type !== 'obround') return null;

            const slotRadius = Math.min(primitive.width, primitive.height) / 2;
            const isHorizontal = primitive.width > primitive.height;
            let startCapCenter, endCapCenter;

            // Define points A, B, C, D locally to ensure consistency with entryPoint logic
            let pA, pB, pC, pD;

            if (isHorizontal) {
                const centerY = primitive.position.y + primitive.height / 2;
                startCapCenter = { x: primitive.position.x + slotRadius, y: centerY };
                endCapCenter = { x: primitive.position.x + primitive.width - slotRadius, y: centerY };

                // Horizontal: pA is Top-Left relative to start cap (90 deg)
                pA = { x: startCapCenter.x, y: startCapCenter.y + slotRadius };
                pB = { x: startCapCenter.x, y: startCapCenter.y - slotRadius };
                pC = { x: endCapCenter.x, y: endCapCenter.y - slotRadius };
                pD = { x: endCapCenter.x, y: endCapCenter.y + slotRadius };
            } else {
                const centerX = primitive.position.x + primitive.width / 2;
                startCapCenter = { x: centerX, y: primitive.position.y + slotRadius };
                endCapCenter = { x: centerX, y: primitive.position.y + primitive.height - slotRadius };

                // Vertical: pA is Left-Middle relative to start cap (180 deg)
                pA = { x: startCapCenter.x - slotRadius, y: startCapCenter.y };
                pB = { x: startCapCenter.x + slotRadius, y: startCapCenter.y };
                pC = { x: endCapCenter.x + slotRadius, y: endCapCenter.y };
                pD = { x: endCapCenter.x - slotRadius, y: endCapCenter.y };
            }

            return {
                position: primitive.position,
                width: primitive.width,
                height: primitive.height,
                isHorizontal: isHorizontal,
                slotRadius: slotRadius,
                startCapCenter: startCapCenter,
                endCapCenter: endCapCenter,
                // Pass pre-calculated corners
                pA, pB, pC, pD
            };
        }

        /**
         * True when ctx.transforms carries no machine transform - i.e. the
         * combined machineMatrix (origin + workspace) is identity. Falls
         * back to the legacy param check if the context predates the
         * machineMatrix field (older saved contexts, tests).
         */
        // REVIEW - Remove fallback?
        isIdentityTransforms(transforms) {
            if (!transforms) return true;
            if (transforms.machineIsIdentity !== undefined) {
                return transforms.machineIsIdentity === true;
            }
            // Legacy fallback: param-based gate + origin
            return !transforms.mirrorX && !transforms.mirrorY && !transforms.rotation &&
                   (!transforms.origin || (transforms.origin.x === 0 && transforms.origin.y === 0));
        }

        /**
         * THE single pipeline→machine coordinate mapping.
         * Identity transforms return the input point UNCHANGED (no clone) -
         * callers must treat the result as read-only, or clone explicitly
         * when storing it into mutable metadata (see extractDrillMacros).
         */
        applyTransforms(point, transforms) {
            if (this.isIdentityTransforms(transforms)) return point;
            // machineMatrix = T(-origin) ⊗ workspaceMatrix.
            // Fall back to the workspace-only matrix for legacy contexts
            // (origin then still handled by GCodeGenerator, if present).
            const m = transforms.machineMatrix || transforms.matrix;
            return TransformMath.applyToPoint(m, point);
        }
    }

    // Module-private helper - keeps extractDrillMacros readable without
    // re-evaluating the nullish default inline three times.
    function holeIdxOf(props) {
        return props.holeIndex ?? -1;
    }

    window.GeometryTranslator = GeometryTranslator;
})();