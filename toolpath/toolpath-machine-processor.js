/*!
 * @file        toolpath/toolpath-machine-processor.js
 * @description Adds machine operations and defines special cycles (e.g. Helix entry milled holes and slots)
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

    class MachineProcessor {
        constructor(core) {
            this.core = core;
            this.currentPosition = { x: 0, y: 0, z: 0 };
            this.context = null;
        }

        /**
         * Walks the optimizer's ordered plan list and expands each flat
         * 2D plan through its depth levels. Drill macros, peck marks,
         * 3D contours and centerline slots are dispatched to their
         * existing dedicated handlers (unchanged).
         *
         * Standard contour plans carry metadata.depthLevels - an array
         * of Z values from shallowest to deepest. For each depth the
         * processor stamps the commands with that Z and handles tab
         * Z-lifts when the plan carries tab metadata.
         *
         * @param {Object} [runOpts]
         * @param {boolean} [runOpts.convertRotary=true] - false = leave
         *        developed plans in developed space (3D preview path: the
         *        viewer wraps them itself and must not receive A words).
         */
        processPlans(toolpathPlans, context, initialPos, runOpts = {}) {
            if (!toolpathPlans || toolpathPlans.length === 0) {
                return { plans: [], endPos: initialPos };
            }

            if (!context) {
                console.error("[MachineProcessor] Plans are missing toolpath context!");
                return { plans: [], endPos: initialPos };
            }

            // Reset all per-batch transient state
            this.context = context;
            this.FEED_HEIGHT = context.machine.feedHeight;
            this.currentPosition = { ...initialPos };

            // Developed (rotary) plans carry y = unwound arc at refRadius and
            // z = depth below the blank surface. The route decides what that
            // becomes at the machine boundary; 'off' (no rotary-capable post)
            // drops them rather than emit arc-mm as a Cartesian Y.
            const developed = toolpathPlans.filter(p => p.metadata?.developedSpace);
            const rotaryRoute = context.export?.rotaryRoute || 'off';
            if (developed.length > 0 && rotaryRoute === 'off') {
                console.error(`[MachineProcessor] ${developed.length} rotary plan(s) ` +
                    `dropped: post '${context.gcode?.postProcessor}' declares no ` +
                    `4th-axis route.`);
                toolpathPlans = toolpathPlans.filter(p => !p.metadata?.developedSpace);
                if (toolpathPlans.length === 0) {
                    return { plans: [], endPos: initialPos,
                             droppedDeveloped: developed.length };
                }
            }

            const machineReadyPlans = [];
            const plungeRate = context.cutting.plungeRate;

            // [INDEXED] Blank-corner clearance, batch-wide.
            // A is UNKNOWN at program start and after the last cut, so the
            // init positioning and the final retract have to clear the swept
            // corner. Per-face traverses do not (see the 3D branch);
            // insertIndexMoves owns the rotation height.
            // REVIEW - Is this comment appropriate? Outdated or wrong?
            const indexedBatch = toolpathPlans.filter(p => p.metadata?.indexedA != null);
            const indexedCornerZ = indexedBatch.length > 0
                ? Math.max(0, (indexedBatch[0].metadata.indexedClearRadius || 0) -
                              (indexedBatch[0].metadata.indexedApothem || 0))
                : 0;
            const batchSafeZ = this.context.machine.safeZ + indexedCornerZ;

            this.debug(`Starting Batch. Initial Pos: Z${this.currentPosition.z.toFixed(3)}`, this.currentPosition);
            if (indexedCornerZ > 0) {
                this.debug(`Indexed corner clearance +${indexedCornerZ.toFixed(2)}mm ` +
                    `on every travel/safe height (safeZ → ${batchSafeZ.toFixed(2)})`);
            }

            // Initial positioning
            const initPlan = new ToolpathPlan('init');
            initPlan.metadata.synthetic = true;

            // Use '<=' to force an explicit Safety Z retract at the start, even if the internal tracker thinks it's already there
            if (this.currentPosition.z <= batchSafeZ) {
                initPlan.addRapid(null, null, batchSafeZ);
                this.currentPosition.z = batchSafeZ;
            }

            // Move to the Start XY of the first plan while at safe Z
            if (toolpathPlans.length > 0) {
                const firstPlan = toolpathPlans[0];
                // Use optimized point if available, otherwise raw entry
                const startXY = firstPlan.metadata.optimization?.optimizedEntryPoint || firstPlan.metadata.entryPoint;
                if (startXY) {
                    initPlan.addRapid(startXY.x, startXY.y, null); // Move XY, keep Z at Safe
                    this.currentPosition.x = startXY.x;
                    this.currentPosition.y = startXY.y;
                }
            }
            machineReadyPlans.push(initPlan);

            // Main plan loop
            for (let i = 0; i < toolpathPlans.length; i++) {
                const plan = toolpathPlans[i];
                const meta = plan.metadata || {};

                // Special dispatch
                if (meta.isPeckMark) {
                    this.debug(`Processing Peck Mark ${i+1}/${toolpathPlans.length}`);
                    machineReadyPlans.push(this.processPeckMark(plan));

                    // Update the machine position tracker (processPeckMark ends with a retract to travelZ)
                    this.currentPosition = {
                        x: meta.entryPoint.x,
                        y: meta.entryPoint.y,
                        z: this.context.machine.travelZ
                    };
                    continue;
                }

                // Handle drill mill macro (complete hole-clearing sequence)
                if (meta.drillMillMacro) {
                    this.debug(`Processing Drill Mill Macro ${i+1}/${toolpathPlans.length}`);
                    machineReadyPlans.push(this.generateDrillMillMacro(plan));
                    this.currentPosition = {
                        ...(meta.entryPoint || { x: 0, y: 0 }),
                        z: this.context.machine.travelZ
                    };
                    continue;
                }

                // Drill milling (non-peck): helix entry for circles/obrounds
                if (meta.isDrillMilling) {
                    const useHelix = (meta.entryType || 'plunge') === 'helix';
                    if (useHelix && (meta.primitiveType === 'circle' || meta.primitiveType === 'obround')) {
                        this.debug(`Processing Helix Mill ${meta.primitiveType} ${i+1}/${toolpathPlans.length}`);
                        machineReadyPlans.push(this.generateHelicalDrillMilling(plan));
                        this.currentPosition = { ...(meta.exitPoint || {x:0, y:0}), z: this.context.machine.travelZ };
                        continue;
                    }
                }

                // Handle centerline slots
                if (meta.isCenterlinePath && meta.strategy?.zigzag) {
                    this.debug(`Processing Centerline Slot (Macro) ${i + 1}/${toolpathPlans.length}`);
                    const slotPlan = new ToolpathPlan(plan.operationId);
                    Object.assign(slotPlan.metadata, meta);
                    const strategy = meta.strategy;
                    const startXY = meta.entryPoint;
                    const endXY = { x: plan.commands[0].x, y: plan.commands[0].y };

                    // Resolve against the plan's own metadata before giving up.
                    // `strategy` is a copy taken at translation; a drill row can
                    // rewrite metadata.feedRate/plungeRate after it was built, and
                    // every other branch in this switch reads the metadata.
                    const slotFeed = strategy.feedRate ?? meta.feedRate;
                    const slotPlunge = strategy.plungeRate ?? meta.plungeRate;
                    const levels = meta.depthLevels;
                    const finalZ = levels?.length ? levels[levels.length - 1] : null;

                    if (!(slotFeed > 0 && slotPlunge > 0 && finalZ !== null)) {
                        // Dropping here removes a slot from the program with nothing
                        // on screen to show for it. Name the value that is missing.
                        // TODO(processor-warnings) - this belongs on the operation.
                        // MachineProcessor has no warning channel yet, which is why
                        // this failure went unnoticed for a whole release.
                        const missing = [
                            slotFeed > 0 ? null : 'feed rate',
                            slotPlunge > 0 ? null : 'plunge rate',
                            finalZ === null ? 'cut depth' : null
                        ].filter(Boolean).join(', ');
                        console.error(`[MachineProcessor] Centerline slot dropped - no ${missing}.`,
                            { feedRate: strategy.feedRate, plungeRate: strategy.plungeRate, depthPerPass: strategy.depthPerPass, depthLevels: levels });
                        continue;
                    }

                    // Move to Start at Travel Z
                    slotPlan.addRapid(startXY.x, startXY.y, this.context.machine.travelZ);
                    slotPlan.addRapid(null, null, this.FEED_HEIGHT);

                    // Zig-zag down the ladder metadata.depthLevels already holds.
                    let goingForward = true;
                    for (const levelZ of levels) {
                        // Plunge to next depth at current position
                        slotPlan.addLinear(null, null, levelZ, slotPlunge);
                        // Cut to the other side
                        const target = goingForward ? endXY : startXY;
                        slotPlan.addLinear(target.x, target.y, levelZ, slotFeed);
                        // Toggle direction for next pass
                        goingForward = !goingForward;
                    }

                    // Retract
                    slotPlan.addRetract(this.context.machine.travelZ);

                    // Update machine state
                    this.currentPosition = {
                        x: goingForward ? startXY.x : endXY.x,
                        y: goingForward ? startXY.y : endXY.y,
                        z: this.context.machine.travelZ
                    };
                    machineReadyPlans.push(slotPlan);
                    continue;
                }

                // 3D contour (relief / rotary / V-Carve): every command
                // carries its own Z. The standard depth-expansion branch
                // below cannot represent per-command Z (it stamps one flat
                // `depth` per level and resets currentPosition.z to it),
                // which is what zeroed out all cutting. Handle 3D on its own
                // path, but drive the CONNECTION move from the same linkType
                // switch so hops work here exactly as for 2.5D links.
                if (meta.is3DContour) {
                    const linkType3D = meta.optimization?.linkType || 'rapid';
                    const entry3D = meta.optimization?.optimizedEntryPoint || meta.entryPoint;
                    const plungeRate3D = meta.plungeRate || this.context.cutting.plungeRate;

                    // Corner clearance - DEVELOPED ROTARY ONLY. On square
                    // stock roughing starts at the corner radius refR·√2, so
                    // developed z runs 0.414·refR above the blank surface and
                    // travelZ alone puts the retract plane inside the corner.
                    // Indexed does NOT need this: at a fixed A the facet IS
                    // the plane z=0 and the corners sit at (y=±halfWidth,
                    // z=0), laterally offset, not above. The corner only rises
                    // to circumradius-apothem while the part TURNS, which is
                    // why the bump lives in insertIndexMoves' indexZ and in
                    // the batch safe height (A is unknown at program start),
                    // not here. Round stock and plain relief leave it at 0.
                    const cornerZ = (meta.developedSpace && meta.stockStartRadius > 0)
                        ? Math.max(0, meta.stockStartRadius - (meta.refRadius || 0))
                        : 0;
                    const travel3D = this.context.machine.travelZ + cornerZ;
                    const feed3D = this.FEED_HEIGHT + cornerZ;

                    // 3D continuation: the optimizer proved this chain's entry
                    // IS the current tool position in X, Y and Z, so there is
                    // no connection move and no plunge - the chain just carries
                    // on. The preceding plan skipped its retract for the same
                    // reason. Every other link retracts first.
                    const continues3D = (linkType3D === 'staydown');

                    if (!continues3D) {
                        const conn = new ToolpathPlan(plan.operationId);
                        conn.metadata.synthetic = true;
                        if (linkType3D === 'hop') {
                            if (this.currentPosition.z < feed3D) {
                                conn.addRapid(null, null, feed3D);
                                this.currentPosition.z = feed3D;
                            }
                        } else {
                            if (this.currentPosition.z < travel3D) {
                                conn.addRapid(null, null, travel3D);
                                this.currentPosition.z = travel3D;
                            }
                        }
                        const dxTo = entry3D.x - this.currentPosition.x;
                        const dyTo = entry3D.y - this.currentPosition.y;
                        if ((dxTo * dxTo + dyTo * dyTo) > (PRECISION * PRECISION)) {
                            conn.addRapid(entry3D.x, entry3D.y, null);
                        }
                        conn.metadata.type = (linkType3D === 'hop') ? 'hop_link' : 'rapid_link';
                        machineReadyPlans.push(conn);
                        this.currentPosition.x = entry3D.x;
                        this.currentPosition.y = entry3D.y;
                    }

                    // Spindle + plunge to the chain's FIRST Z, then replay the
                    // chain verbatim (native per-point Z), then retract.
                    const macro = new ToolpathPlan(plan.operationId);
                    Object.assign(macro.metadata, meta);
                    macro.metadata.spindleSpeed = this.context.cutting.spindleSpeed;
                    macro.metadata.spindleDwell = this.context.cutting.spindleDwell;

                    if (!continues3D) macro.addLinear(null, null, entry3D.z, plungeRate3D);

                    for (const cmd of plan.commands) {
                        macro.addCommand({ ...cmd });
                        if (cmd.x !== null) this.currentPosition.x = cmd.x;
                        if (cmd.y !== null) this.currentPosition.y = cmd.y;
                        if (cmd.z !== null) this.currentPosition.z = cmd.z;
                    }

                    // Retract: skipped entirely when the next chain continues
                    // from this exact point, feed height when it hops back,
                    // else full travelZ. This is the only place the 3D chain Z
                    // is allowed to unwind.
                    const nextMeta = toolpathPlans[i + 1]?.metadata;
                    const nextLink = nextMeta?.optimization?.linkType;
                    if (!(nextMeta?.is3DContour && nextLink === 'staydown')) {
                        const retract3DZ = (nextLink === 'hop') ? feed3D : travel3D;
                        macro.addRetract(retract3DZ);
                        this.currentPosition.z = retract3DZ;
                    }
                    machineReadyPlans.push(macro);
                    continue;
                }

                // Standard contour with depth expansion
                const linkType = meta.optimization?.linkType || 'rapid';
                const depthLevels = meta.depthLevels || [meta.cutDepth || 0];
                const entryPoint = meta.optimization?.optimizedEntryPoint || meta.entryPoint;

                // Connection move to this plan's entry
                const connectionPlan = new ToolpathPlan('connection');
                connectionPlan.metadata.synthetic = true;

                if (linkType === 'staydown') {
                    this.debug(`Link ${i}: Staydown move`);
                    connectionPlan.addLinear(
                        entryPoint.x, entryPoint.y, this.currentPosition.z,
                        meta.feedRate
                    );
                    connectionPlan.metadata.type = 'staydown_link';
                } else if (linkType === 'hop') {
                    this.debug(`Link ${i}: Hop move`);
                    if (this.currentPosition.z < this.FEED_HEIGHT) {
                        connectionPlan.addRapid(null, null, this.FEED_HEIGHT);
                        this.currentPosition.z = this.FEED_HEIGHT;
                    }
                    const atTargetXY = Math.hypot(
                        entryPoint.x - this.currentPosition.x,
                        entryPoint.y - this.currentPosition.y
                    ) < PRECISION;
                    if (!atTargetXY) {
                        connectionPlan.addRapid(entryPoint.x, entryPoint.y, null);
                    }
                    connectionPlan.metadata.type = 'hop_link';
                } else {
                    this.debug(`Link ${i}: Rapid move`);
                    if (this.currentPosition.z < this.context.machine.travelZ) {
                        connectionPlan.addRapid(null, null, this.context.machine.travelZ);
                        this.currentPosition.z = this.context.machine.travelZ;
                    }

                    // Move XY - only if not already at target position
                    const atTargetXY = Math.hypot(
                        entryPoint.x - this.currentPosition.x,
                        entryPoint.y - this.currentPosition.y
                    ) < PRECISION;
                    if (!atTargetXY) {
                        connectionPlan.addRapid(entryPoint.x, entryPoint.y, null);
                    }
                    connectionPlan.metadata.type = 'rapid_link';
                }
                machineReadyPlans.push(connectionPlan);
                this.currentPosition.x = entryPoint.x;
                this.currentPosition.y = entryPoint.y;

                // Depth expansion: iterate depthLevels
                // Tab data (if present)
                const isTabbedFeature = meta.isTabbedPass === true;

                // Read the tab height setting directly from the machine context 
                const tabTopZ = meta.tabTopZ;

                for (let di = 0; di < depthLevels.length; di++) {
                    const depth = depthLevels[di];
                    const isFirstDepth = (di === 0);

                    const useTabs = isTabbedFeature && tabTopZ !== undefined && depth < (tabTopZ - PRECISION);

                    // The optimizer only rearranges plan.commands. Strictly use this array.
                    const activeCommands = plan.commands;

                    // Prevent plunging through a tab if the entry point lands on one
                    const startsOnTab = useTabs && activeCommands.length > 0 && activeCommands[0].metadata?.isTab === true;
                    const plungeZ = startsOnTab ? tabTopZ : depth;

                    if (isFirstDepth && linkType !== 'staydown') {
                        const entryPlan = new ToolpathPlan('entry');
                        entryPlan.metadata.synthetic = true;
                        entryPlan.metadata.spindleSpeed = this.context.cutting.spindleSpeed;
                        entryPlan.metadata.spindleDwell = this.context.cutting.spindleDwell;
                        const entryType = meta.entryType || 'plunge';

                        // Explicitly use the 3D contour's starting Z if applicable, otherwise use safe plungeZ
                        const targetZ = meta.is3DContour ? meta.entryPoint.z : plungeZ;
                        const entryMeta = { ...meta, entryPoint: { ...entryPoint, z: targetZ } };

                        this.generateEntryMove(entryPlan, entryMeta, entryType);
                        machineReadyPlans.push(entryPlan);
                        this.currentPosition.z = targetZ;
                    } else if (isFirstDepth && linkType === 'staydown') {
                        if (Math.abs(this.currentPosition.z - plungeZ) > PRECISION) {
                            const plungePlan = new ToolpathPlan('staydown_plunge');
                            plungePlan.metadata.synthetic = true;
                            plungePlan.addLinear(null, null, plungeZ, plungeRate);
                            machineReadyPlans.push(plungePlan);
                        }
                        this.currentPosition.z = plungeZ;
                    } else if (meta.perLevelReturn === 'retract') {
                        // A welded chain ends at its innermost ring. Feeding
                        // straight back to the entry at the NEW depth would
                        // cut a slot across the pocket, so lift, rapid over
                        // cleared air and plunge - once per level instead of
                        // once per ring.
                        const returnPlan = new ToolpathPlan('level_return');
                        returnPlan.metadata.synthetic = true;
                        returnPlan.addRetract(this.FEED_HEIGHT);
                        returnPlan.addRapid(entryPoint.x, entryPoint.y, null);
                        returnPlan.addLinear(null, null, plungeZ, plungeRate);
                        machineReadyPlans.push(returnPlan);
                        this.currentPosition.x = entryPoint.x;
                        this.currentPosition.y = entryPoint.y;
                        this.currentPosition.z = plungeZ;
                    } else {
                        const plungePlan = new ToolpathPlan("depth_plunge");
                        plungePlan.metadata.synthetic = true;
                        plungePlan.addLinear(entryPoint.x, entryPoint.y, plungeZ, plungeRate);
                        machineReadyPlans.push(plungePlan);
                        this.currentPosition.z = plungeZ;
                    }

                    const cuttingPlan = new ToolpathPlan(plan.operationId);
                    Object.assign(cuttingPlan.metadata, meta);
                    cuttingPlan.metadata.cutDepth = depth;

                    // Track tab state to keep the tool up during multi-segment tabs
                    let inTab = startsOnTab;

                    for (const cmd of activeCommands) {
                        // If useTabs is false (shallow pass), this safely forces isTabCmd to false
                        const isTabCmd = useTabs && cmd.metadata?.isTab === true;

                        if (isTabCmd && !inTab) {
                            // Entering a tab: Lift to tab height
                            cuttingPlan.addLinear(null, null, tabTopZ, plungeRate);
                            inTab = true;
                        } else if (!isTabCmd && inTab) {
                            // Return to the specific 3D Z, or the flat 2D depth
                            const returnZ = meta.is3DContour ? (cmd.z !== null ? cmd.z : depth) : depth;
                            cuttingPlan.addLinear(null, null, returnZ, plungeRate);
                            inTab = false;
                        }

                        if (meta.is3DContour) {
                            // Preserve native 3D Z coordinate
                            cuttingPlan.addCommand({ ...cmd, z: isTabCmd ? tabTopZ : cmd.z });
                        } else {
                            // 2D moves can be modal. Plunges and tab transitions issue explicit Z moves,
                            // so horizontal XY commands must carry z: null to prevent Z-coordinate spam.
                            cuttingPlan.addCommand({ ...cmd, z: null });
                        }

                        if (cmd.x !== null) this.currentPosition.x = cmd.x;
                        if (cmd.y !== null) this.currentPosition.y = cmd.y;
                        if (meta.is3DContour && cmd.z !== null) this.currentPosition.z = cmd.z;
                    }

                    // Return to standard depth if the path ends while still on a tab
                    if (inTab) {
                        cuttingPlan.addLinear(null, null, depth, plungeRate);
                    }

                    machineReadyPlans.push(cuttingPlan);

                    if (!meta.is3DContour) this.currentPosition.z = depth;
                }

                // Retract logic
                const nextLinkType = toolpathPlans[i + 1]?.metadata?.optimization?.linkType;
                const isStayDownSource = (nextLinkType === 'staydown');
                const isHopSource = (nextLinkType === 'hop');

                if (!isStayDownSource) {
                    const retractPlan = new ToolpathPlan('retract');
                    retractPlan.metadata.synthetic = true;
                    // If the next move is a hop, only retract to FEED_HEIGHT
                    const retractZ = isHopSource ? this.FEED_HEIGHT : this.context.machine.travelZ;

                    retractPlan.addRetract(retractZ);
                    machineReadyPlans.push(retractPlan);
                    this.currentPosition.z = retractZ;
                }
            }

            // Final Retract to Safe Z
            if (this.currentPosition.z < batchSafeZ) {
                const finalPlan = new ToolpathPlan('final');
                finalPlan.metadata.synthetic = true;
                finalPlan.addRetract(batchSafeZ);
                this.currentPosition.z = batchSafeZ;
                machineReadyPlans.push(finalPlan);
            }

            // Tool identity for the whole batch. processPlans runs once per
            // operation, so every synthetic plan here belongs to this
            // operation - but a synthetic plan belongs to the cutting plan
            // that FOLLOWS it, not the one before: the connection rapid and
            // the entry plunge are the new tool's approach. Detecting the
            // change on the cutting plan would emit T/M6 with the machine
            // already at depth in the new location holding the old cutter.
            //
            // Backward fill, so plans that already carry their own tool
            // (drill peck marks, one per hole diameter) are left alone and
            // still hand their tool to the moves that lead into them.
            if (context.tool) {
                let pendingTool = context.tool;
                for (let i = machineReadyPlans.length - 1; i >= 0; i--) {
                    const md = machineReadyPlans[i].metadata;
                    if (md.tool) pendingTool = md.tool;
                    else md.tool = pendingTool;
                }
            }

            // [INDEXED] 3+1 index moves - runs on the fully expanded batch
            // in final order, mirroring the developed conversion below.
            // executePipeline calls processPlans once per operation, so a
            // batch is never mixed: indexed plans never carry
            // developedSpace and vice versa. previewMode reuses the
            // existing convertRotary:false semantics (3D preview path):
            // moves ARE inserted so the viewer can wrap faces, but the
            // post-capability gate is skipped.
            const idx = this.insertIndexMoves(machineReadyPlans, context, {
                previewMode: runOpts.convertRotary === false
            });
            if (idx < 0) {
                // Gate failed - indexed plans dropped with a console.error
                // inside insertIndexMoves (same feedback pattern as the
                // rotary route gates below).
                return { plans: machineReadyPlans.filter(p => p.metadata?.indexedA == null),
                         endPos: this.currentPosition,
                         droppedIndexed: true };
            }

            // Developed → machine conversion. The plans flowed through the
            // 3D-contour machinery above, whose Z/retract logic is already
            // self-consistent in the developed frame (z=0 is the blank
            // surface; travelZ retracts sit radially outside it). Only the
            // XY→(axial, rotary) mapping is left, and it must run on EVERY
            // plan in the batch - the synthetic init/link/retract plans carry
            // developed coordinates too. Safe because executePipeline calls
            // processPlans once per operation, so a batch is never mixed.
            if (developed.length > 0 && rotaryRoute !== 'off' &&
                runOpts.convertRotary !== false) {
                const refR = developed[0].metadata.refRadius || 0;
                const axisKind = developed[0].metadata.rotaryAxisKind || 'x';
                const exp = context.export || {};
                // Sliced frame → machine word: an 'x' job rotates about X (A),
                // a 'y' job about Y (B).
                const wantWord = axisKind === 'y' ? 'B' : 'A';

                if (!(refR > 0)) {
                    console.error('[MachineProcessor] rotary plans have no refRadius - ' +
                        'cannot convert. Regenerate the operation.');
                } else if (rotaryRoute === 'wrapped-linear') {
                    // Axis replacement: the machine's Y driver IS the rotary,
                    // calibrated so N mm of Y = N mm of arc at refRadius. The
                    // developed strip is already exactly that - nothing to do.
                    // Only valid for an A(x) job: the arc must land on Y, so a
                    // B(y) job (whose axial run needs Y) has nowhere to put it.
                    if (axisKind !== 'x') {
                        console.error(`[MachineProcessor] route 'wrapped-linear' needs ` +
                            `the arc on the Y word, but a rotary-axis-'y' operation ` +
                            `needs Y for its axial run. Use 'a-word' or set the ` +
                            `operation's rotary axis to X. Rotary plans dropped.`);
                        return { plans: machineReadyPlans.filter(p => !p.metadata?.developedSpace),
                                 endPos: this.currentPosition,
                                 droppedDeveloped: developed.length };
                    }
                    for (const plan of machineReadyPlans) {
                        if (plan.metadata) plan.metadata.developedSpace = false;
                    }
                } else if (rotaryRoute === 'a-word' || rotaryRoute === 'a-linear') {
                    if ((exp.axisWords || []).indexOf(wantWord) < 0) {
                        console.error(`[MachineProcessor] operation needs a '${wantWord}' ` +
                            `word; post declares [${(exp.axisWords || []).join(', ')}]. ` +
                            `Rotary plans dropped.`);
                        return { plans: machineReadyPlans.filter(p => !p.metadata?.developedSpace),
                                 endPos: this.currentPosition,
                                 droppedDeveloped: developed.length };
                    }
                    // One cursor across the whole batch: px/py/pz must not
                    // reset per plan or the first command of every chain (the
                    // plunge) escapes inverse-time conversion and its mm/min
                    // F gets read as a G93 duration.
                    const cursor = { x: null, y: null, z: null };
                    for (const plan of machineReadyPlans) {
                        this.convertDevelopedToRotary(plan, refR, {
                            route: rotaryRoute,
                            axisKind,
                            axisWord: wantWord,
                            inverseTime: exp.inverseTime === true,
                            maxInverseTime: exp.maxInverseTime ||
                                C.rotary.maxInverseTime
                        }, cursor);
                        if (plan.metadata) plan.metadata.developedSpace = false;
                    }
                } else {
                    console.error(`[MachineProcessor] rotary route '${rotaryRoute}' ` +
                        `is not implemented - plans dropped.`);
                    return { plans: machineReadyPlans.filter(p => !p.metadata?.developedSpace),
                             endPos: this.currentPosition,
                             droppedDeveloped: developed.length };
                }
            }

            return { plans: machineReadyPlans, endPos: this.currentPosition };
        }

        generateEntryMove(plan, planMetadata, entryType) {
            const cutDepth = planMetadata.entryPoint.z;
            const entryPoint = planMetadata.entryPoint;
            const plungeRate = planMetadata.plungeRate;

            // Rapid from Travel Z to FEED_HEIGHT if above it
            if (this.currentPosition.z > this.FEED_HEIGHT) {
                plan.addRapid(null, null, this.FEED_HEIGHT);
            }

            if (entryType === 'helix' && !planMetadata.isSimpleCircle) {
                this.generateHelixEntry(plan, entryPoint, cutDepth, plungeRate, planMetadata.toolDiameter);
            // IGNORE RAMP ENTRY UNTIL PROPERLY DEVELOPED AND TESTED
            // } else if (entryType === 'ramp') { 
            //     this.generateRampEntry(plan, planMetadata, cutDepth, plungeRate);
            } else {
                // Default Plunge from FEED_HEIGHT (1mm) down
                plan.addLinear(
                    entryPoint.x,
                    entryPoint.y,
                    cutDepth, 
                    plungeRate
                );
            }
        }

        generateHelixEntry(plan, entryPoint, targetDepth, plungeRate, toolDiameter = null) {
            const helixConfig = this.context.config.entry.helix;
            if (!helixConfig) {
                plan.addLinear(entryPoint.x, entryPoint.y, targetDepth, plungeRate);
                return;
            }

            // [METADATA-BLOAT] Last ctx dependency in this stage: winding only
            // needs ctx.transforms (+ strategy.direction, already mirrored in
            // metadata). When determineWinding is repointed to
            // plan.metadata.transforms, delete every `metadata.context = ctx`
            // stamp in both translators and the retention problem is closed.
            const arcCW = this.determineWinding(plan.metadata.context);
            const angleDir = arcCW ? -1 : 1;

            // Per-row cutter, not the operation's. In multi-tool drilling the
            // sidebar tool is not what enters this hole, and a helix sized to the
            // wrong diameter either gouges the wall or leaves a ring of stock.
            const cutterDiameter = toolDiameter > 0 ? toolDiameter : this.context.tool.diameter;
            const helixRadius = cutterDiameter * helixConfig.radiusFactor;
            const helixPitch = helixConfig.pitch;
            const revolutions = Math.abs(targetDepth) / helixPitch;
            const steps = Math.ceil(revolutions * helixConfig.segmentsPerRevolution);

            // Feed to set 0 (Top or bottom of stock) to start helix geometry
            const surfaceZ = this.context.machine.surfaceZ || 0;
            plan.addLinear(null, null, surfaceZ, plungeRate);

            for (let i = 1; i <= steps; i++) {
                const angle = (i / steps) * revolutions * 2 * Math.PI * angleDir;
                const z = (i / steps) * targetDepth;
                const x = entryPoint.x + helixRadius * Math.cos(angle);
                const y = entryPoint.y + helixRadius * Math.sin(angle);
                plan.addLinear(x, y, z, plungeRate);
            }

            // Re-center at bottom
            plan.addLinear(entryPoint.x, entryPoint.y, targetDepth, plungeRate);
        }

        /* REVIEW - Ignore Ramp Entry until properly developed and tested
        generateRampEntry(plan, purePlan, targetDepth, plungeRate) {
            // Feed to set 0 (Top or bottom of stock) to start ramping
            const surfaceZ = this.context.machine.surfaceZ || 0;
            plan.addLinear(null, null, surfaceZ, plungeRate);

            const rampAngle = this.context.strategy.entryRampAngle;
            const rampSlope = Math.tan(rampAngle * Math.PI / 180);
            const rampLength = Math.abs(targetDepth) / rampSlope;
            const shallowDepth = targetDepth * 0.1;

            if (purePlan.metadata.primitiveType === 'path' && purePlan.commands && purePlan.commands.length > 2) {
                let accumulatedLength = 0;
                const entryPoint = purePlan.metadata.entryPoint;

                for (let i = 0; i < purePlan.commands.length && accumulatedLength < rampLength; i++) {
                    const cmd = purePlan.commands[i];
                    if (cmd.type === 'LINEAR' && cmd.x !== null && cmd.y !== null) {
                        const prevPos = i === 0 ? entryPoint : {
                            x: purePlan.commands[i - 1].x,
                            y: purePlan.commands[i - 1].y
                        };

                        const segLen = Math.hypot(cmd.x - prevPos.x, cmd.y - prevPos.y);
                        accumulatedLength += segLen;

                        const zAtPoint = shallowDepth - (accumulatedLength / rampLength) * Math.abs(targetDepth - shallowDepth);
                        const finalZ = Math.max(zAtPoint, targetDepth);

                        plan.addLinear(cmd.x, cmd.y, finalZ, plungeRate);

                        if (finalZ === targetDepth) break;
                    }
                }
            } else {
                plan.addLinear(null, null, targetDepth, plungeRate);
            }
        }
        */

        processPeckMark(purePlan) {
            const machinePlan = new ToolpathPlan(purePlan.operationId);
            Object.assign(machinePlan.metadata, purePlan.metadata);
            const planContext = purePlan.metadata.context;
            const peckData = purePlan.metadata.peckData;
            const position = peckData.position;
            const finalDepth = purePlan.metadata.cutDepth;
            const machine = planContext.machine;

            // Per-plan first: one drill operation holds several bits, each with
            // its own cycle and feeds. The operation's values are the fallback
            // for a plan the translator left un-overridden.
            const strategy = { ...planContext.strategy.drill, ...(purePlan.metadata.peckCycle || {}) };
            const cutting = {
                ...planContext.cutting,
                feedRate: purePlan.metadata.feedRate ?? planContext.cutting.feedRate,
                plungeRate: purePlan.metadata.plungeRate ?? planContext.cutting.plungeRate
            };

            // Check if current post-processor supports canned cycles
            const supportsCanned = planContext.gcode.supportsCannedCycles;
            if (this.currentPosition.z < machine.travelZ) {
                machinePlan.addRapid(null, null, machine.travelZ);
                this.currentPosition.z = machine.travelZ;
            }

            // Move to XY
            machinePlan.addRapid(position.x, position.y, null);
            this.currentPosition.x = position.x;
            this.currentPosition.y = position.y;

            // Rapid to Feed Height
            machinePlan.addRapid(null, null, this.FEED_HEIGHT);

            if (supportsCanned && strategy.cannedCycle !== 'none') {
                const retractPlane = strategy.retractHeight + (this.context.machine.surfaceZ || 0);
                // Dispatch to Canned Cycle Primitive, passing the specific cycle type
                if (strategy.cannedCycle === 'G83' || strategy.cannedCycle === 'G73') {
                    machinePlan.addCannedPeck(position.x, position.y, finalDepth, retractPlane, strategy.peckDepth, cutting.plungeRate, strategy.cannedCycle);
                } else {
                    machinePlan.addCannedSimple(position.x, position.y, finalDepth, retractPlane, cutting.plungeRate, strategy.dwellTime);
                }
                this.currentPosition.z = retractPlane;
            } else if (strategy.cannedCycle === 'none' || strategy.peckDepth === 0 || strategy.peckDepth >= Math.abs(finalDepth)) {
                // Standard manual single plunge
                machinePlan.addPlunge(finalDepth, cutting.plungeRate);
                if (strategy.dwellTime > 0) machinePlan.addDwell(strategy.dwellTime);
                machinePlan.addRetract(machine.travelZ);
            } else {
                // Standard manual pecking loop
                const surfaceZ = this.context.machine.surfaceZ || 0;
                let lastCutDepth = surfaceZ;
                const retractPlane = strategy.retractHeight + surfaceZ;
                const rapidDownClearance = this.context.config.drilling.peckRapidClearance;
                while (lastCutDepth > finalDepth) {
                    let targetPeckDepth = lastCutDepth - strategy.peckDepth;
                    if (targetPeckDepth < finalDepth) targetPeckDepth = finalDepth;
                    const rapidDownTo = lastCutDepth === surfaceZ ? this.FEED_HEIGHT : lastCutDepth + rapidDownClearance;
                    machinePlan.addRapid(undefined, undefined, rapidDownTo);
                    machinePlan.addPlunge(targetPeckDepth, cutting.plungeRate);
                    if (strategy.dwellTime > 0) machinePlan.addDwell(strategy.dwellTime);
                    lastCutDepth = targetPeckDepth;
                    if (lastCutDepth > finalDepth) machinePlan.addRetract(retractPlane);
                }
                machinePlan.addRetract(machine.travelZ);
            }
            return machinePlan;
        }

        generateHelicalDrillMilling(purePlan) {
            const machinePlan = new ToolpathPlan(purePlan.operationId);
            Object.assign(machinePlan.metadata, purePlan.metadata);

            const primitiveType = purePlan.metadata.primitiveType;
            const entryPoint = purePlan.metadata.entryPoint;

            // Travel Z
            machinePlan.addRapid(entryPoint.x, entryPoint.y, this.context.machine.travelZ);
            // Feed Height
            machinePlan.addRapid(null, null, this.FEED_HEIGHT);

            const arcCW = this.determineWinding(purePlan.metadata.context);

            if (primitiveType === 'obround') {
                this.generateSlotHelix(machinePlan, purePlan, arcCW);
            } else if (primitiveType === 'circle') {
                this.generateCircleHelix(machinePlan, purePlan, arcCW);
            }

            return machinePlan;
        }

        generateCircleHelix(machinePlan, purePlan, arcCW) {
            const center = purePlan.metadata.center;
            const radius = purePlan.metadata.radius;

            const minHelixDia = this.context.config.drilling.minHelixDiameter;
            const targetDepth = purePlan.metadata.cutDepth;
            const plungeRate = purePlan.metadata.plungeRate;

            if (!center || !radius || (radius * 2) < minHelixDia) {
                if (center) {
                    machinePlan.addRapid(center.x, center.y, null);
                    machinePlan.addLinear(center.x, center.y, targetDepth, plungeRate);
                    machinePlan.addRetract(this.context.machine.travelZ);
                }
                return;
            }

            const toolDiameter = purePlan.metadata.toolDiameter;
            const feedRate = purePlan.metadata.feedRate;
            const startX = purePlan.metadata.entryPoint.x;
            const startY = purePlan.metadata.entryPoint.y;
            const startAngle = Math.atan2(startY - center.y, startX - center.x);

            const surfaceZ = this.context.machine.surfaceZ || 0;
            machinePlan.addRapid(startX, startY, null);
            machinePlan.addLinear(startX, startY, surfaceZ, plungeRate);

            const ring = { center, radius };
            const finalAngle = this.helixDownRing(machinePlan, ring, startAngle, surfaceZ, targetDepth, feedRate, toolDiameter, arcCW);
            this.fullCircleAtDepth(machinePlan, ring, finalAngle, targetDepth, feedRate, arcCW);

            machinePlan.addRetract(this.context.machine.travelZ);
        }

        /**
         * Expands a drill mill macro plan into a complete machine-ready cutting sequence.
         * Both entry types follow the same depth-staged pattern:
         *   For each depth: descend inner ring → cleanup inner → step out → cleanup outer → step back
         */
        generateDrillMillMacro(purePlan) {
            if (purePlan.metadata.slotMacro) {
                return this.generateSlotMillMacro(purePlan);
            }

            const machinePlan = new ToolpathPlan(purePlan.operationId);
            Object.assign(machinePlan.metadata, purePlan.metadata);

            const rings = purePlan.metadata.concentricRings;      // [innermost, ..., outermost]
            const entryType = purePlan.metadata.entryType;
            const depthLevels = purePlan.metadata.depthLevels;     // [-0.05, -0.10, ...] descending
            const feedRate = purePlan.metadata.feedRate;
            const plungeRate = purePlan.metadata.plungeRate;
            const toolDiameter = purePlan.metadata.toolDiameter;

            const innerRing = rings[0];
            const center = innerRing.center;
            const entryPoint = purePlan.metadata.optimization?.optimizedEntryPoint
                || purePlan.metadata.entryPoint;

            // Track the angle dynamically
            let currentAngle = Math.atan2(
                entryPoint.y - center.y,
                entryPoint.x - center.x
            );

            const initialEntryX = center.x + innerRing.radius * Math.cos(currentAngle);
            const initialEntryY = center.y + innerRing.radius * Math.sin(currentAngle);
            const minHelixDia = this.context.config.drilling.minHelixDiameter;
            const useHelix = entryType === 'helix' && (innerRing.radius * 2) >= minHelixDia;

            const arcCW = this.determineWinding(purePlan.metadata.context);

            machinePlan.addRapid(initialEntryX, initialEntryY, this.context.machine.travelZ);
            machinePlan.addRapid(null, null, this.FEED_HEIGHT);

            const surfaceZ = this.context.machine.surfaceZ || 0;
            machinePlan.addLinear(initialEntryX, initialEntryY, surfaceZ, plungeRate);

            let currentZ = surfaceZ;
            const finalDepth = depthLevels[depthLevels.length - 1];
            if (rings.length === 1 && useHelix) {
                // Update currentAngle with wherever the helix stops
                currentAngle = this.helixDownRing(machinePlan, innerRing, currentAngle, surfaceZ, finalDepth, feedRate, toolDiameter, arcCW);
                this.fullCircleAtDepth(machinePlan, innerRing, currentAngle, finalDepth, feedRate, arcCW);

            } else {
                for (let d = 0; d < depthLevels.length; d++) {
                    const targetZ = depthLevels[d];
                    if (useHelix) {
                        // Update currentAngle with wherever the helix stops
                        currentAngle = this.helixDownRing(machinePlan, innerRing, currentAngle, currentZ, targetZ, feedRate, toolDiameter, arcCW);
                    } else {
                        // Dynamically calculate the plunge point based on current angle
                        const plungeX = center.x + innerRing.radius * Math.cos(currentAngle);
                        const plungeY = center.y + innerRing.radius * Math.sin(currentAngle);
                        machinePlan.addLinear(plungeX, plungeY, targetZ, plungeRate);
                    }
                    for (let r = 0; r < rings.length; r++) {
                        const ring = rings[r];

                        if (r > 0) {
                            // Step out to the next ring along the current angle
                            const ringEntryX = ring.center.x + ring.radius * Math.cos(currentAngle);
                            const ringEntryY = ring.center.y + ring.radius * Math.sin(currentAngle);
                            machinePlan.addLinear(ringEntryX, ringEntryY, targetZ, feedRate);
                        }

                        // Run the 360 clear starting exactly from the current angle
                        this.fullCircleAtDepth(machinePlan, ring, currentAngle, targetZ, feedRate, arcCW);
                    }
                    if (rings.length > 1 && d < depthLevels.length - 1) {
                        // Return to the inner ring exactly along the current angle
                        const returnX = center.x + innerRing.radius * Math.cos(currentAngle);
                        const returnY = center.y + innerRing.radius * Math.sin(currentAngle);
                        machinePlan.addLinear(returnX, returnY, targetZ, feedRate);
                    }

                    currentZ = targetZ;
                }
            }
            machinePlan.addRetract(this.context.machine.travelZ);

            this.debug(`Drill Mill Macro: ${machinePlan.commands.length} cmds, ` +
                       `${rings.length} ring(s), ${depthLevels.length} depth(s), ` +
                       `entry=${useHelix ? 'helix' : 'plunge'}`);

            return machinePlan;
        }

        /**
         * Helical descent along a single ring between two Z levels.
         * Called once per depth stage, NOT once for the full hole depth.
         */
        helixDownRing(machinePlan, ring, startAngle, fromZ, toZ, feedRate, toolDiameter, arcCW) {
            const center = ring.center;
            const radius = ring.radius;

            const deltaZ = Math.abs(toZ - fromZ);
            if (deltaZ < 1e-6) return startAngle; // Already at target

            const requestedPitch = Math.abs(this.context.strategy.depthPerPass);
            const maxPitchForTool = toolDiameter * 0.5;
            const helixPitch = Math.min(requestedPitch, maxPitchForTool);
            const revolutions = Math.max(1, Math.ceil(deltaZ / helixPitch));
            const segmentsPerRev = 16;
            const totalSegments = Math.ceil(revolutions * segmentsPerRev);

            const angleSpan = revolutions * 2 * Math.PI * (arcCW ? -1 : 1);

            let lastX = center.x + radius * Math.cos(startAngle);
            let lastY = center.y + radius * Math.sin(startAngle);
            let finalAngle = startAngle;

            for (let i = 1; i <= totalSegments; i++) {
                const ratio = i / totalSegments;
                finalAngle = startAngle + (ratio * angleSpan);
                const z = fromZ + ratio * (toZ - fromZ);
                const x = center.x + radius * Math.cos(finalAngle);
                const y = center.y + radius * Math.sin(finalAngle);
                const i_val = center.x - lastX;
                const j_val = center.y - lastY;

                machinePlan.addArc(x, y, z, i_val, j_val, arcCW, feedRate);
                lastX = x;
                lastY = y;
            }

            // Return the exact angle where the helix finished
            return finalAngle % (2 * Math.PI);
        }

        /**
         * Single full-circle cleanup pass on a ring at a given depth.
         */
        fullCircleAtDepth(machinePlan, ring, startAngle, depth, feedRate, arcCW) {
            const center = ring.center;
            const radius = ring.radius;

            const startX = center.x + radius * Math.cos(startAngle);
            const startY = center.y + radius * Math.sin(startAngle);

            const i_val = center.x - startX;
            const j_val = center.y - startY;

            // Passing null for X and Y to force the post-processor to output a perfect 360° circle (G2 I... J...)
            machinePlan.addArc(null, null, depth, i_val, j_val, arcCW, feedRate);
        }

        /**
         * Expands an obround drill mill macro into a complete machine-ready sequence.
         * Same depth-staged pattern as circle macro:
         *   For each depth: descend inner → cleanup inner → step out → cleanup outer → step back
         */
        generateSlotMillMacro(purePlan) {
            const machinePlan = new ToolpathPlan(purePlan.operationId);
            Object.assign(machinePlan.metadata, purePlan.metadata);

            const rings = purePlan.metadata.obroundRings;      // [innermost, ..., outermost]
            const entryType = purePlan.metadata.entryType;
            const depthLevels = purePlan.metadata.depthLevels;
            const feedRate = purePlan.metadata.feedRate;
            const plungeRate = purePlan.metadata.plungeRate;
            const toolDiameter = purePlan.metadata.toolDiameter;

            const innerRing = rings[0];
            const arcCW = this.determineWinding(purePlan.metadata.context);

            // Plunge exactly where the toolpath begins to avoid flat travel cuts
            const innerEntry = arcCW ? innerRing.pB : innerRing.pC;

            // Helix feasibility: inner ring slot radius must be large enough
            const minHelixDia = this.context.config.drilling.minHelixDiameter;
            const useHelix = entryType === 'helix' && (innerRing.slotRadius * 2) >= minHelixDia;

            // Approach
            machinePlan.addRapid(innerEntry.x, innerEntry.y, this.context.machine.travelZ);
            machinePlan.addRapid(null, null, this.FEED_HEIGHT);

            // Feed to set 0 (top or bottom of stock)
            const surfaceZ = this.context.machine.surfaceZ || 0;
            machinePlan.addLinear(innerEntry.x, innerEntry.y, surfaceZ, plungeRate);

            let currentZ = surfaceZ;
            const finalDepth = depthLevels[depthLevels.length - 1];

            // Single-ring shortcut
            if (rings.length === 1 && useHelix) {
                this.helixDownObround(machinePlan, innerRing, surfaceZ, finalDepth, plungeRate, feedRate, toolDiameter, arcCW);
                this.obroundLoopAtDepth(machinePlan, innerRing, finalDepth, feedRate, arcCW);
            } else {
                // Multi-ring depth-staged loop
                for (let d = 0; d < depthLevels.length; d++) {
                    const targetZ = depthLevels[d];
                    if (useHelix) {
                        this.helixDownObround(machinePlan, innerRing, currentZ, targetZ, plungeRate, feedRate, toolDiameter, arcCW);
                    } else {
                        machinePlan.addLinear(innerEntry.x, innerEntry.y, targetZ, plungeRate);
                    }

                    for (let r = 0; r < rings.length; r++) {
                        const ring = rings[r];
                        if (r > 0) {
                            // Transition to the exit-side point of the next ring to avoid diagonal traverses. CW loops end at pC, CCW loops end at pB.
                            const ringTransition = arcCW ? ring.pC : ring.pB;
                            machinePlan.addLinear(ringTransition.x, ringTransition.y, targetZ, feedRate);
                        }
                        this.obroundLoopAtDepth(machinePlan, ring, targetZ, feedRate, arcCW);
                    }

                    if (rings.length > 1 && d < depthLevels.length - 1) {
                        // All concentric rings have been cut at this depth, so the entire slot interior is clear. Go directly to the next helix/plunge entry point.
                        machinePlan.addLinear(innerEntry.x, innerEntry.y, targetZ, feedRate);
                    }
                    currentZ = targetZ;
                }
            }

            // Retract
            machinePlan.addRetract(this.context.machine.travelZ);
            return machinePlan;
        }

        /**
         * Helical descent along an obround ring between two Z levels.
         * Z change is distributed across the two cap arcs; linear segments stay flat.
         */
        helixDownObround(machinePlan, ring, fromZ, toZ, plungeRate, feedRate, toolDiameter, arcCW) {
            const deltaZ = Math.abs(toZ - fromZ);
            if (deltaZ < 1e-6) return;

            const pA = ring.pA, pB = ring.pB, pC = ring.pC, pD = ring.pD;
            const cStart = ring.startCapCenter, cEnd = ring.endCapCenter;

            const requestedPitch = Math.abs(this.context.strategy.depthPerPass);
            const helixPitch = Math.min(requestedPitch, toolDiameter * 0.5);
            const depthPerHalfLoop = helixPitch * 0.5;

            let currentZ = fromZ;
            while (currentZ > toZ + 1e-9) {
                if (!arcCW) { // CCW Logic
                    // Assume pC because of the entry logic
                    let targetZ = Math.max(currentZ - depthPerHalfLoop, toZ);
                    machinePlan.addArc(pD.x, pD.y, targetZ, cEnd.x - pC.x, cEnd.y - pC.y, false, feedRate);
                    currentZ = targetZ;

                    machinePlan.addLinear(pA.x, pA.y, currentZ, feedRate);
                    targetZ = Math.max(currentZ - depthPerHalfLoop, toZ);
                    machinePlan.addArc(pB.x, pB.y, targetZ, cStart.x - pA.x, cStart.y - pA.y, false, feedRate);
                    currentZ = targetZ;

                    if (currentZ > toZ + 1e-9) {
                        machinePlan.addLinear(pC.x, pC.y, currentZ, feedRate);
                    }
                } else { // CW Logic
                    // Assume pB because of the entry logic
                    let targetZ = Math.max(currentZ - depthPerHalfLoop, toZ);
                    machinePlan.addArc(pA.x, pA.y, targetZ, cStart.x - pB.x, cStart.y - pB.y, true, feedRate);
                    currentZ = targetZ;

                    machinePlan.addLinear(pD.x, pD.y, currentZ, feedRate); 
                    targetZ = Math.max(currentZ - depthPerHalfLoop, toZ);
                    machinePlan.addArc(pC.x, pC.y, targetZ, cEnd.x - pD.x, cEnd.y - pD.y, true, feedRate);
                    currentZ = targetZ;

                    if (currentZ > toZ + 1e-9) {
                        machinePlan.addLinear(pB.x, pB.y, currentZ, feedRate);
                    }
                }
            }
        }

        /**
         * Single full obround cleanup loop at constant depth.
         * CW order: A → D → C(arc) → B → A(arc)
         */
        obroundLoopAtDepth(machinePlan, ring, depth, feedRate, arcCW) {
            const pA = ring.pA, pB = ring.pB, pC = ring.pC, pD = ring.pD;
            const cStart = ring.startCapCenter, cEnd = ring.endCapCenter;

            if (!arcCW) { // CCW
                // Because helix ended at pB, linear traverse to pC to start the loop
                machinePlan.addLinear(pC.x, pC.y, depth, feedRate);
                machinePlan.addArc(pD.x, pD.y, depth, cEnd.x - pC.x, cEnd.y - pC.y, false, feedRate);
                machinePlan.addLinear(pA.x, pA.y, depth, feedRate);
                machinePlan.addArc(pB.x, pB.y, depth, cStart.x - pA.x, cStart.y - pA.y, false, feedRate);
            } else { // CW
                // Because helix ended at pC, linear traverse to pB to start the loop
                machinePlan.addLinear(pB.x, pB.y, depth, feedRate);
                machinePlan.addArc(pA.x, pA.y, depth, cStart.x - pB.x, cStart.y - pB.y, true, feedRate);
                machinePlan.addLinear(pD.x, pD.y, depth, feedRate);
                machinePlan.addArc(pC.x, pC.y, depth, cEnd.x - pD.x, cEnd.y - pD.y, true, feedRate);
            }
        }

        generateSlotHelix(machinePlan, purePlan, arcCW) {
            const od = purePlan.metadata.obroundData;
            const finalDepth = purePlan.metadata.cutDepth;
            const toolDiameter = purePlan.metadata.toolDiameter;
            const feedRate = purePlan.metadata.feedRate;
            const plungeRate = purePlan.metadata.plungeRate;

            const entryPt = arcCW ? od.pB : od.pC;
            const surfaceZ = this.context.machine.surfaceZ || 0;
            machinePlan.addRapid(entryPt.x, entryPt.y, null);
            machinePlan.addLinear(entryPt.x, entryPt.y, surfaceZ, plungeRate);

            this.helixDownObround(machinePlan, od, surfaceZ, finalDepth, plungeRate, feedRate, toolDiameter, arcCW);
            this.obroundLoopAtDepth(machinePlan, od, finalDepth, feedRate, arcCW);

            machinePlan.addRetract(this.context.machine.travelZ);
        }

        determineWinding(ctx) {
            // Drill macros are mirror-agnostic since the geometry translator naturally handles point swapping during mirroring.
            const isClimb = true; // Enforced until UI supports conventional routing
            return isClimb; // Climb milling an internal pocket translates to CW (true)
        }

        calculatePathMetrics(plans, context) {
            let totalTime = 0;
            let totalDistance = 0;
            const machineContext = context?.machine || { safeZ: 5.0, rapidFeedRate: 1000 };
            let lastPos = { x: 0, y: 0, z: machineContext.safeZ, a: 0 };
            const rapidFeed = machineContext.rapidFeedRate;
            // Rotary: A is degrees, so its contribution to tool-tip travel is
            // Δθ·Rtip. Runs AFTER convertDevelopedToRotary (executePipeline →
            // generate → metrics), so plans here already carry A and, under
            // G93, durations instead of velocities in .f.
            const refR = plans.find(p => p.metadata?.refRadius > 0)?.metadata.refRadius || 0;
            const DEG = Math.PI / 180;

            for (const plan of plans) {
                const invTime = plan.metadata?.rotaryInverseTime === true;
                const isDeg = (plan.metadata?.rotaryUnits ?? 'deg') === 'deg';
                for (const cmd of plan.commands) {
                    let nextPos = { ...lastPos };
                    if (cmd.x !== null && cmd.x !== undefined) nextPos.x = cmd.x;
                    if (cmd.y !== null && cmd.y !== undefined) nextPos.y = cmd.y;
                    if (cmd.z !== null && cmd.z !== undefined) nextPos.z = cmd.z;
                    if (cmd.a !== null && cmd.a !== undefined) nextPos.a = cmd.a;

                    const dx = nextPos.x - lastPos.x;
                    const dy = nextPos.y - lastPos.y;
                    const dz = nextPos.z - lastPos.z;
                    // Rotary arc at the tool tip, not at the blank surface.
                    const dA = nextPos.a - lastPos.a;
                    const rTip = Math.max(refR + (lastPos.z + nextPos.z) / 2, 0);
                    const dArc = refR > 0
                        ? (isDeg ? dA * DEG * rTip : dA * (rTip / refR))
                        : 0;
                    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz + dArc * dArc);

                    if (dist > 0) {
                        totalDistance += dist;
                        if (invTime && cmd.f > 0 && cmd.type !== 'RAPID' && cmd.type !== 'RETRACT') {
                            // Under G93 F IS 1/duration: the move takes 1/F min.
                            totalTime += (1 / cmd.f) * 60;
                        } else {
                            let feed = 100;
                            if (cmd.type === 'RAPID' || cmd.type === 'RETRACT') feed = rapidFeed;
                            else if (cmd.f) feed = cmd.f;
                            if (feed > 0) totalTime += (dist / feed) * 60;
                        }
                    }

                    if (cmd.type === 'DWELL') totalTime += cmd.dwell || 0;
                    lastPos = nextPos;
                }
            }
            return { estimatedTime: totalTime, totalDistance: totalDistance };
        }

        /**
         * [INDEXED] Injects "retract → rotate A → (dwell)" link plans at
         * every face boundary and stamps the per-plan rotary-word
         * metadata the G-code stage keys off. In place, on the
         * machine-ready batch, in final order.
         *
         * CONTRACTS
         * - Plans carrying metadata.indexedA are indexed cutting plans
         *   (Toolpath3DTranslator, from props.indexA). Synthetic
         *   init/link/retract plans carry none and pass through - their
         *   commands hold no 'a', so no word can leak.
         * - A is ABSOLUTE degrees, emitted verbatim. Sign calibration
         *   lives in ShapeIndexedHandler.buildFaceSliceOptions - never
         *   "fix" a flipped face here or in the renderer.
         * - Pure G94 job: rotaryInverseTime is ALWAYS false. Index moves
         *   are positioning-only, which is why indexed runs safely on
         *   posts whose G93 is unverified (grblHAL, Makera).
         * - The standard retract-to-travelZ already precedes every face's
         *   first plan (faces are distinct optimizer groups; 3D chains
         *   never staydown/hop across groups). The injected RETRACT
         *   re-asserts it - a zero-cost no-op line when Z is already
         *   there (modal emission skips unchanged coords) - then rotates.
         * - The FIRST indexed plan also gets a link (usually `G0 A0.`):
         *   deliberate - it pins the starting A instead of trusting
         *   whatever the machine was left at.
         *
         * ROUTE GATE (export only; previewMode skips it): indexed needs
         * absolute degrees on the matching word ('A' for x-jobs, 'B' for
         * y-jobs) - the 'a-word' capability. The gate is CAPABILITY-based:
         * if the post declares 'a-word' but auto-resolution preferred
         * another route (grblHAL/Makera list wrapped-linear first), the
         * job proceeds with a warning. 'wrapped-linear' itself is
         * structurally impossible for indexed - it repurposes the Y word
         * as arc length, but indexed Y is real cross-axis position.
         * 'a-linear' (mm-of-arc calibration) is equally wrong for
         * absolute-degree positioning.
         *
         * @returns {number} indexed cutting plans processed; 0 = none in
         *          batch; -1 = gate failed, caller must drop them.
         */
        insertIndexMoves(plans, context, { previewMode = false } = {}) {
            // Testing-phase constants - companions to the IX block in
            // shape-indexed-handler.js. Destination (config vs user-
            // exposed) decided after bench.
            const ANGLE_EPS_DEG = 1e-6;
            const INDEX_CLEAR_MM = C.rotary.indexClearance;;   // gap above the swept corner

            const indexed = plans.filter(p => p.metadata?.indexedA != null);
            if (indexed.length === 0) return 0;

            const axisKind = indexed[0].metadata.rotaryAxisKind || 'x';
            const wantWord = axisKind === 'y' ? 'B' : 'A';
            const exp = context.export || {};

            if (!previewMode) {
                // routes = full declared list (new export field); older
                // contexts fall back to the resolved route alone.
                const declared = exp.routes || [exp.rotaryRoute].filter(Boolean);
                if (declared.indexOf('a-word') < 0) {
                    console.error(`[MachineProcessor] indexed 3+1 needs the ` +
                        `'a-word' route (absolute degrees on ${wantWord}); post ` +
                        `'${context.gcode?.postProcessor}' declares ` +
                        `[${declared.join(', ') || 'none'}]. ` +
                        (declared.indexOf('wrapped-linear') >= 0
                            ? `Axis replacement carries arc-mm on the Y word, but ` +
                              `indexed Y is real cross-axis position - structurally ` +
                              `incompatible. `
                            : '') +
                        `Indexed plans dropped.`);
                    return -1;
                }
                if ((exp.axisWords || []).indexOf(wantWord) < 0) {
                    console.error(`[MachineProcessor] indexed operation needs a ` +
                        `'${wantWord}' word; post declares ` +
                        `[${(exp.axisWords || []).join(', ')}]. Indexed plans dropped.`);
                    return -1;
                }
                // A pinned non-a-word route is the user stating the rotary is
                // wired as axis replacement: there is no A axis to position,
                // and emitting A words moves nothing. The parameter UI gates
                // indexed off this exact combination, so reaching here means
                // that gate broke.
                const pinnedRoute = exp.requestedRoute || '';
                if (pinnedRoute && pinnedRoute !== 'a-word') {
                    console.error(`[MachineProcessor] indexed 3+1 is incompatible with ` +
                        `the machine's rotary route '${pinnedRoute}'. Axis replacement ` +
                        `carries arc-mm on the Y word; indexed Y is real cross-axis ` +
                        `position. Indexed plans dropped - set the rotary route to ` +
                        `'a-word' in Machine Settings.`);
                    return -1;
                }
                if (exp.rotaryRoute !== 'a-word') {
                    console.warn(`[MachineProcessor] indexed 3+1: auto-switching ` +
                        `from resolved route '${exp.rotaryRoute}' to 'a-word' ` +
                        `(the only route indexed can use).`);
                }
            }

            const travelZ = this.context.machine.travelZ;
            // Rotation clearance. Heights stay in the FACE-TOP frame (the
            // +apothem bump below lifts every command uniformly), so a corner
            // at clearRadius sits at clearRadius - apothem here. Must not fall
            // BELOW processPlans' batch travel plane or the link dips back down
            // before rotating.
            const apothem = indexed[0].metadata.indexedApothem || 0;
            const clearR = indexed[0].metadata.indexedClearRadius || 0;
            const cornerZ = Math.max(0, clearR - apothem);
            const indexZ = Math.max(travelZ + cornerZ, clearR + INDEX_CLEAR_MM - apothem);
            if (clearR > 0) {
                this.debug(`Index clearance: Z ${indexZ.toFixed(2)} (face-top frame) ` +
                    `= ${(indexZ + apothem).toFixed(2)} from centerline; ` +
                    `corner R ${clearR.toFixed(2)}mm vs apothem ${apothem.toFixed(2)}mm`);
            } else {
                console.warn('[MachineProcessor] indexed plans carry no ' +
                    'indexedClearRadius - index moves fall back to travelZ, ' +
                    'which does NOT clear a prismatic blank\'s corners. ' +
                    'Regenerate the operation.');
            }

            let currentA = null;
            let links = 0;
            for (let i = 0; i < plans.length; i++) {
                const meta = plans[i].metadata;
                const a = meta?.indexedA;
                if (a == null) continue;

                // EVERY indexed plan carries the word request, not just
                // boundary heads: gcode-generator sets the processor's
                // rotaryAxisWord PER PLAN, and optimizer reversal must
                // never orphan a plan whose commands could carry 'a'.
                meta.rotaryAxisWord = wantWord;
                meta.rotaryInverseTime = false;
                meta.rotaryUnits = 'deg';

                if (currentA === null || Math.abs(a - currentA) > ANGLE_EPS_DEG) {
                    const link = new ToolpathPlan('index');
                    link.metadata.synthetic = true;
                    link.metadata.rotaryAxisWord = wantWord;
                    link.metadata.rotaryInverseTime = false;
                    link.metadata.indexLink = true;
                    // Carry the wrap frame so the preview's walkPlans latches
                    // it even on the pre-face-0 index move (display only).
                    link.metadata.indexedApothem = meta.indexedApothem;
                    link.metadata.rotaryAxisKind = meta.rotaryAxisKind;
                    // insertIndexMoves runs AFTER processPlans' backward fill,
                    // so a spliced link would be the only plan in the batch
                    // with no tool. It belongs to the face it introduces.
                    link.metadata.tool = meta.tool || null;
                    // Re-assert clearance, then rotate. x/y/z null on the
                    // A block → base-processor emits a pure `G0 A{a}`.
                    link.addRetract(indexZ);
                    link.addCommand(new MotionCommand('RAPID',
                        { x: null, y: null, z: null, a }));
                    if (exp.indexDwell > 0) link.addDwell(exp.indexDwell);
                    plans.splice(i, 0, link);
                    i++; // step over the plan just inserted
                    this.currentPosition.z = indexZ;
                    currentA = a;
                    links++;
                }
            }

            // ── Centerline Z reference (export only) ──────────────────
            // The generator emits Z relative to the blank FACE TOP; a 4th-axis
            // viewer or controller rotates the A/B word about the line
            // Y=0, Z=0, so the rotary CENTERLINE must sit at Z=0 or every face
            // pivots about the face-top line and swings onto its antipode (a
            // Z≤0 face flipped 180° lands at Z≥0 - "the top surface renders
            // below the bottom"). Z_centerline = Z_faceTop + apothem, applied
            // to EVERY command so clearance rides up with the cuts. This is
            // the exact counterpart of convertDevelopedToRotary's +refRadius.
            // The header tells the operator to touch off a face top and lower
            // Z0 by the apothem.
            //
            // previewMode stays in the face-top frame: the 3D preview's
            // walkPlans adds apothem itself before rotating each face.
            if (!previewMode && apothem > 0) {
                // Identity-guarded: entryPoint / exitPoint /
                // optimizedEntryPoint are separate objects today, but a single
                // aliased pair silently shifts that point twice.
                const bumped = new Set();
                const bump = (pt) => {
                    if (!pt || bumped.has(pt)) return;
                    bumped.add(pt);
                    pt.z = (pt.z || 0) + apothem;
                };
                for (const plan of plans) {
                    for (const cmd of plan.commands) {
                        if (cmd.z !== null && cmd.z !== undefined) cmd.z += apothem;
                    }
                    const meta = plan.metadata;
                    if (!meta) continue;
                    bump(meta.entryPoint);
                    bump(meta.exitPoint);
                    bump(meta.optimization?.optimizedEntryPoint);
                }
                this.currentPosition.z += apothem;
            }

            this.debug(`insertIndexMoves: ${indexed.length} plan(s), ` +
                `${links} index move(s), word ${wantWord}, ` +
                (previewMode ? 'preview (gate skipped)' : 'export'));
            return indexed.length;
        }

        /**
         * Developed → 4th-axis conversion, in place.
         *
         *   axisKind 'x' (A about X):  X ← devX,  A ← devY·k
         *   axisKind 'y' (B about Y):  Y ← devX,  B ← devY·k
         *
         * Z REFERENCE: always the rotation centerline. Emitted coordinates
         * are the tool-tip radius from the axis.
         * Applies to a-word/a-linear only; wrapped-linear machines behave as
         * 3-axis and keep the surface reference.
         *
         * Feed under G93: F = feed / L with L the true tool-tip length
         * L = √(dAxial² + dz² + (Δθ·Rtip)²),  Rtip = refR + z_dev computed
         * in the DEVELOPED frame. F clamps to maxInverseTime.
         *
         * A accumulates and is never wrapped; optimizer reversal just runs
         * it backwards, which is legal.
         *
         * @param {Object} [cursor] - {x,y,z} DEVELOPED-frame cursor carried
         *        across plans so the first command of each chain (the
         *        plunge) still has a predecessor for the G93 conversion.
         */
        convertDevelopedToRotary(plan, refR, opts = {}, cursor = null) {
            const linear = opts.route === 'a-linear';
            const arcToWord = linear ? 1 : (180 / (Math.PI * refR));
            const swapAxial = opts.axisKind === 'y';
            const useInvTime = opts.inverseTime === true;
            const maxF = opts.maxInverseTime || 9999.99;
            // Developed Z is r - refR; +refR restores the radius from the
            // axis, which is the one datum every route and viewer agrees on.
            const zOff = refR;

            let px = cursor ? cursor.x : null;
            let py = cursor ? cursor.y : null;
            let pz = cursor ? cursor.z : null;
            let converted = false;

            for (const cmd of plan.commands) {
                // Developed-frame position BEFORE any rewriting.
                const cx = cmd.x ?? px;
                const cy = cmd.y ?? py;
                const cz = cmd.z ?? pz;

                if (useInvTime && cmd.f && cmd.type !== 'RAPID' && cmd.type !== 'RETRACT' &&
                    px !== null && py !== null && pz !== null &&
                    cx !== null && cy !== null && cz !== null) {
                    const rTip = Math.max(refR + (pz + cz) / 2, 1e-6);
                    const dArc = (cy - py) * (rTip / refR);
                    const len = Math.hypot(cx - px, dArc, cz - pz);
                    cmd.f = (len > 1e-9) ? Math.min(cmd.f / len, maxF) : maxF;
                    converted = true;
                }

                const hasAxial = cmd.x !== null && cmd.x !== undefined;
                const hasArc   = cmd.y !== null && cmd.y !== undefined;
                if (hasArc) cmd.a = cmd.y * arcToWord;
                if (swapAxial) {
                    cmd.y = hasAxial ? cmd.x : null;   // axial rides the Y word
                    cmd.x = null;
                } else if (hasArc) {
                    cmd.y = null;                      // rotary word replaces Y
                }
                // Z reference shift LAST - the cursor and Rtip above must
                // stay in the developed frame.
                if (cmd.z !== null && cmd.z !== undefined) cmd.z = cmd.z + zOff;

                px = cx; py = cy; pz = cz;
            }

            if (cursor) { cursor.x = px; cursor.y = py; cursor.z = pz; }

            const fixPt = (p) => {
                if (!p) return;
                if (swapAxial) { p.y = p.x; p.x = 0; } else { p.y = 0; }
                p.z = (p.z || 0) + zOff;
            };
            if (plan.metadata) {
                fixPt(plan.metadata.entryPoint);
                fixPt(plan.metadata.exitPoint);
                plan.metadata.rotaryAxisWord = opts.axisWord || 'A';
                plan.metadata.rotaryInverseTime = converted;
                plan.metadata.rotaryUnits = linear ? 'mm' : 'deg';
            }
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[MachineProcessor] ${message}`, data)
                 : console.log(`[MachineProcessor] ${message}`);
        }
    }

    window.MachineProcessor = MachineProcessor;
})();