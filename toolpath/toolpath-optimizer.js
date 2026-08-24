/*!
 * @file        toolpath/toolpath-optimizer.js
 * @description Optimizes toolpath plan objects and movement between them
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
    const EPSILON = C.precision.epsilon;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class ToolpathOptimizer {
        constructor(options = {}) {
            this.options = { ...options };

            this.stats = {
                originalPathCount: 0,
                optimizedPathCount: 0,
                originalTravelDistance: 0,
                optimizedTravelDistance: 0,
                travelDistanceSaved: 0,
                pointsRemoved: 0,
                optimizationTime: 0,
                staydownLinksUsed: 0
            };
        }

        /**
         * Main optimization entry.
         * Plans are flat 2D features - depth is passthrough metadata
         * used exclusively by the MachineProcessor later.
         */
        optimize(pureGeometryPlans, startPos) {

            const startTime = performance.now();
            this.resetStats();
            this.stats.originalPathCount = pureGeometryPlans?.length || 0;

            if (!pureGeometryPlans || pureGeometryPlans.length === 0) {
                return [];
            }

            // Group by tool+operation
            const plansByGroupKey = new Map();
            for (const plan of pureGeometryPlans) {
                const groupKey = plan.metadata.groupKey || 'default';
                if (!plansByGroupKey.has(groupKey)) {
                    plansByGroupKey.set(groupKey, []);
                }
                plansByGroupKey.get(groupKey).push(plan);
            }

            // Machining-phase guarantee: roughing groups must process before
            // finishing regardless of plan insertion order. phaseRank is
            // stamped by Toolpath3DTranslator (roughing=0, finishing=1);
            // 2D plans have no phaseRank and sort as 0 - stable order kept.
            //
            // Unnumbered sorts LAST, matching executePipeline's leadNumber. A
            // seed of 0 put it first, which is the opposite of the cross-operation
            // rule and the only place the two disagreed. 1e6 clears every legal T
            // number and stays exact under the 1e3 multiplier.
            const UNNUMBERED_TOOL_RANK = 1e6;
            const groupRank = new Map();
            for (const [k, g] of plansByGroupKey) {
                let r = Infinity;
                let toolRank = UNNUMBERED_TOOL_RANK;
                for (const p of g) {
                    const m = p.metadata;
                    let pr = m.phaseRank ?? 0;
                    if (m.indexOrder != null && m.indexedFaceOrder !== 'phase') pr = 4 * m.indexOrder + pr;
                    if (pr < r) r = pr;
                    // Groups are tool-homogeneous (_TN: / _D: in groupKey), so
                    // reading any member is exact.
                    if (m.tool?.number > 0) toolRank = m.tool.number;
                }
                const base = r === Infinity ? 0 : r;
                // Tool is the MOST significant term: a tool change costs a
                // physical swap, a phase reorder costs nothing. The 1000
                // multiplier clears indexOrder*4 + phaseRank for any plausible
                // face count; assert rather than silently interleave.
                if (base >= 1e3) console.warn('[Optimizer] group rank overflow - tool ordering may interleave.');
                groupRank.set(k, 1e3 * toolRank + base);
            }
            const groupEntries = [...plansByGroupKey.entries()]
                .sort((a, b) => groupRank.get(a[0]) - groupRank.get(b[0]));
            plansByGroupKey.clear();
            for (const [k, v] of groupEntries) plansByGroupKey.set(k, v);

            this.debug(`Grouped into ${plansByGroupKey.size} groups`);

            let finalOrderedPlans = [];
            let currentMachinePos = { ...startPos };

            // Process each group
            for (const [groupKey, groupPlans] of plansByGroupKey) {
                this.debug(`Optimizing Tool Group: ${groupKey} (${groupPlans.length} plans)`);

                // ── Ordered 3D fast path ─────────────────────────────
                // Field generators (relief/rotary) emit chains in
                // serpentine order: the emission sequence IS the route.
                // Re-deriving it here costs O(N²) clustering + O(N²) NN
                // + O(N³) or-opt and usually DEGRADES the order (scattered
                // serpentines turn stepover hops into long rapids). Keep
                // emission order; the only per-chain decision left is
                // which END to enter from (chains are direction-agnostic
                // - same contract reversePlanCommands already relies on).
                // Plunge count is fixed at one per chain regardless of
                // ordering, so this is also within a small factor of the
                // achievable optimum on travel.
                const ordered3D = groupPlans.length > 1 && groupPlans.every(
                    p => p.metadata.is3DContour && p.metadata.preserveOrder === true);
                if (ordered3D) {
                    let pos = currentMachinePos;
                    let travel = 0;
                    for (let gi = 0; gi < groupPlans.length; gi++) {
                        const plan = groupPlans[gi];
                        const md = plan.metadata;
                        const e = md.entryPoint;
                        const x = md.exitPoint || e;
                        const dxE = e.x - pos.x, dyE = e.y - pos.y;
                        const dxX = x.x - pos.x, dyX = x.y - pos.y;
                        const dE = dxE * dxE + dyE * dyE;   // squared - no sqrt
                        const dX = dxX * dxX + dyX * dyX;
                        // Enter from the cheaper end. reversePlanCommands
                        // rewrites commands, re-derives 3D feeds, and swaps
                        // entry/exit AND optimization.optimizedEntryPoint.
                        if (dX < dE - 1e-12) this.reversePlanCommands(plan);
                        // Stamp the link so MachineProcessor uses a feed-height
                        // hop instead of a full travelZ retract between chains.
                        // First chain of the run has no predecessor to hop from.
                        const canHop = gi > 0 && md.allow3DHop === true;
                        md.optimization = {
                            linkType: canHop ? 'hop' : 'rapid',
                            // COPIES, never aliases: insertIndexMoves bumps
                            // entryPoint AND optimizedEntryPoint by
                            // +apothem independently, so an alias took the
                            // shift twice (metadata-only corruption - macro
                            // commands are cloned - but it feeds the 3D
                            // preview and any later metadata consumer).
                            originalEntryPoint: { ...md.entryPoint },
                            optimizedEntryPoint: { ...md.entryPoint },
                            entryCommandIndex: 0
                        };

                        const leave = md.exitPoint || md.entryPoint;
                        travel += Math.sqrt(Math.min(dE, dX));
                        pos = leave;
                    }
                    // Emission order is both the baseline and the result.
                    this.stats.originalTravelDistance += travel;
                    this.stats.optimizedTravelDistance += travel;
                    finalOrderedPlans.push(...groupPlans);
                    currentMachinePos = { ...pos };
                    this.debug(`Ordered-3D fast path: ${groupPlans.length} chain(s), emission order kept`);
                    continue;
                }

                // ── Unordered 3D (V-Carve) ───────────────────────────
                // 3D chains never staydown (canStaydown is false for
                // is3DContour), so buildRegions' proximity/staydown
                // clustering produces links that can never be used - while
                // costing a pairwise O(N²) pass AND an adjacency graph that
                // approaches O(N²) MEMORY on dense art (thousands of glyph
                // skeletons). That combination is what melts the browser on
                // ~7000-object SVGs. Order the whole group with ONE direct
                // greedy nearest-neighbour pass - exactly the light O(N²)
                // that optimized these well before the staydown machinery
                // was layered on. reversePlanCommands handles per-chain
                // direction inside optimizePathOrder (commandIndex === -2).
                const unordered3D = groupPlans.length > 1 &&
                    groupPlans.every(p => p.metadata.is3DContour);
                if (unordered3D) {
                    let seq = this.optimizePathOrder(groupPlans, currentMachinePos, {
                        allowStaydown: false
                    });
                    // refinePlanOrder self-caps at orOptMaxBlocks: a
                    // 7000-chain group skips it, a small one gets polished.
                    if (seq.length > 3) {
                        seq = this.refinePlanOrder(seq, currentMachinePos);
                    }
                    if (seq.length) {
                        finalOrderedPlans.push(...seq);
                        currentMachinePos = seq[seq.length - 1].metadata.exitPoint;
                    }
                    this.debug(`Unordered-3D NN: ${groupPlans.length} chain(s), no staydown clustering`);
                    continue;
                }

                const policy = groupPlans[0]?.metadata?.toolpathPolicy || {};
                const partition = policy.staydownPartition || 'shape';

                const { regions, allowStaydown } = this.buildRegions(groupPlans, partition);
                const skipShapeGuard = (partition === 'proximity');

                // Wrap regions in proxies for cluster-level sorting
                const clusterProxies = regions.map(regionPlans => ({
                    plans: regionPlans,
                    entryPoint: regionPlans[0].metadata.entryPoint,
                    exitPoint: regionPlans[regionPlans.length - 1].metadata.exitPoint
                }));

                // Sort the clusters globally, starting from currentMachinePos
                let seq = this.optimizePathOrder(clusterProxies, currentMachinePos, {
                    allowStaydown: false, isClusterRun: true
                });

                seq = this.refineRegionOrder(seq, currentMachinePos);

                const groupStartPos = { ...currentMachinePos };
                let groupOrdered = [];

                // Optimize the actual toolpaths WITHIN each sorted cluster
                for (const cluster of seq) {
                    const ordered = this.optimizePathOrder(cluster.plans, currentMachinePos, {
                        allowStaydown, skipShapeGuard
                    });

                    if (ordered.length) {
                        groupOrdered.push(...ordered);
                        currentMachinePos = ordered[ordered.length - 1].metadata.exitPoint;
                    }
                }

                // Look-ahead or-opt, scoped to THIS group. Must stay per-group: its
                // cost model is pure XY distance, so run across groups it would
                // relocate a finishing plan ahead of a roughing plan (groupKey carries the
                // phase rank) and interleaved tool groups. It also relocated
                // plans carrying optimization.linkType === 'staydown', which is
                // a CONTRACT with the immediate predecessor - MachineProcessor
                // then feeds at depth from whatever plan happened to land in
                // front of it, and suppresses the wrong retract.
                if (groupOrdered.length > 3) {
                    groupOrdered = this.refinePlanOrder(groupOrdered, groupStartPos);
                    currentMachinePos = groupOrdered[groupOrdered.length - 1].metadata.exitPoint;
                }

                // Count staydown links AFTER reordering settles
                for (let i = 1; i < groupOrdered.length; i++) {
                    if (groupOrdered[i].metadata.optimization?.linkType === 'staydown') {
                        this.stats.staydownLinksUsed++;
                    }
                }

                finalOrderedPlans.push(...groupOrdered);
            }

            // Segment simplification
            this.debug(`Simplifying ${finalOrderedPlans.length} paths...`);
            // Simplify after ordering to preserve entry/exit points
            let totalPointsRemoved = 0;
            let total3DPointsRemoved = 0;
            for (const plan of finalOrderedPlans) {
                const originalCount = plan.commands.length;
                if (plan.metadata?.is3DContour) {
                    this.simplify3DSegments(plan);
                    total3DPointsRemoved += (originalCount - plan.commands.length);
                } else {
                    this.simplifySegments(plan);
                }
                totalPointsRemoved += (originalCount - plan.commands.length);
            }
            this.stats.pointsRemoved = totalPointsRemoved;
            this.debug(`Removed ${totalPointsRemoved} collinear points (${total3DPointsRemoved} from 3D paths).`);

            this.stats.optimizedPathCount = finalOrderedPlans.length;
            this.stats.optimizationTime = performance.now() - startTime;

            this.debug(`Complete: ${finalOrderedPlans.length} paths ordered`);
            this.debug(`Stats:`, this.getStats());

            return finalOrderedPlans;
        }

        /**
         * Groups plans into staydown clusters using connected components algorithm
         */
        buildStaydownClusters(plans, margin, usePassAdjacency = true) {
            const clusters = [];
            const planIndices = new Set(plans.map((_, i) => i));
            const adjacency = new Map();

            // Pre-calculate Bounding Boxes for all plans
            plans.forEach(plan => {
                if (!plan.metadata.boundingBox) {
                    plan.computeBounds();
                }
            });

            // Two plans are connected if they are spatially close OR (within one
            // shape) they are consecutive offset passes. Pass-adjacency is the
            // generator's connectivity guarantee and is robust on concave shapes
            // where vertex sampling under-reports closeness.
            const adjacentPass = (a, b) => {
                if (!usePassAdjacency) return false;
                const pa = a.metadata.pass, pb = b.metadata.pass;
                if (pa === null || pa === undefined || pb === null || pb === undefined) return false;
                return Math.abs(pa - pb) === 1;
            };

            // Build adjacency list (graph edges)
            for (let i = 0; i < plans.length; i++) {
                for (let j = i + 1; j < plans.length; j++) {
                    if (adjacentPass(plans[i], plans[j]) ||
                        this.arePlansProximate(plans[i], plans[j], margin)) {
                        if (!adjacency.has(i)) adjacency.set(i, []);
                        if (!adjacency.has(j)) adjacency.set(j, []);
                        adjacency.get(i).push(j);
                        adjacency.get(j).push(i);
                    }
                }
            }

            // Find all connected components using DFS
            while (planIndices.size > 0) {
                const cluster = [];
                const startNode = planIndices.values().next().value;
                const stack = [startNode];
                planIndices.delete(startNode);

                while (stack.length > 0) {
                    const currentNode = stack.pop();
                    cluster.push(plans[currentNode]);

                    if (adjacency.has(currentNode)) {
                        for (const neighbor of adjacency.get(currentNode)) {
                            if (planIndices.has(neighbor)) {
                                planIndices.delete(neighbor);
                                stack.push(neighbor);
                            }
                        }
                    }
                }
                clusters.push(cluster);
            }

            return clusters;
        }

        /**
         * Checks if two plans are within a given margin (for staydown clustering)
         */
        arePlansProximate(planA, planB, margin) {
            // Broad Bounding Box Check (fast fail)
            const boxA = planA.metadata.boundingBox;
            const boxB = planB.metadata.boundingBox;

            const inflatedBoxA = {
                minX: boxA.minX - margin, minY: boxA.minY - margin,
                maxX: boxA.maxX + margin, maxY: boxA.maxY + margin
            };

            // Check for intersection
            if (inflatedBoxA.minX > boxB.maxX || inflatedBoxA.maxX < boxB.minX ||
                inflatedBoxA.minY > boxB.maxY || inflatedBoxA.maxY < boxB.minY) {
                return false;
            }

            // Verify actual closest distance is within margin
            const closestDist = this.findClosestDistanceBetweenPlans(planA, planB);
            return closestDist <= margin;
        }

        /**
         * Find actual closest distance between two plans
         */
        findClosestDistanceBetweenPlans(planA, planB) {
            // Sample points on one side, test against the OTHER side's segments, both
            // directions. Catches mid-segment close approaches between near-parallel
            // offset lines that vertex-to-vertex sampling missed (false "too far").
            const ptsA = this.samplePlanPoints(planA, 24);
            const ptsB = this.samplePlanPoints(planB, 24);
            const segA = this.samplePlanPoints(planA, 64);
            const segB = this.samplePlanPoints(planB, 64);

            let minSq = Infinity;
            const scan = (pts, seg) => {
                if (!seg || seg.length === 0) return;
                for (const p of pts) {
                    if (seg.length === 1) {
                        const dx = p.x - seg[0].x;
                        const dy = p.y - seg[0].y;
                        const sq = dx * dx + dy * dy;
                        if (sq < minSq) minSq = sq;
                    } else {
                        for (let i = 1; i < seg.length; i++) {
                            const sq = GeometryUtils.getSqDistToSegment(p, seg[i - 1], seg[i]);
                            if (sq < minSq) minSq = sq;
                        }
                    }
                }
            };
            scan(ptsA, segB);
            scan(ptsB, segA);
            return Math.sqrt(minSq);
        }

        /**
         * Sample representative points from a plan
         */
        samplePlanPoints(plan, maxPoints) {
            // A full circle is emitted as ONE arc command, so command sampling
            // yields a single point and every proximity / closest-distance test
            // collapses (the circle can never join a stay-down cluster). Walk the
            // real circumference instead. analyzePrimitive sets isSimpleCircle
            // for BOTH circle populations - the analytic CirclePrimitive and the
            // arc-reconstructed contour - so this one gate covers everything,
            // and metadata.center/radius are always present when it is true.
            if (plan.metadata?.isSimpleCircle) {
                const arcCmd = plan.commands.find(c => c.type === 'ARC_CW' || c.type === 'ARC_CCW');
                const entryCmd = plan.commands[0];
                const centerX = plan.metadata.center?.x ?? ((arcCmd && entryCmd) ? entryCmd.x + arcCmd.i : undefined);
                const centerY = plan.metadata.center?.y ?? ((arcCmd && entryCmd) ? entryCmd.y + arcCmd.j : undefined);
                const radius  = plan.metadata.radius ?? (arcCmd ? Math.hypot(arcCmd.i, arcCmd.j) : undefined);
                if (centerX !== undefined && centerY !== undefined && radius > 0) {
                    const pts = [];
                    for (let k = 0; k <= maxPoints; k++) {
                        const a = (k / maxPoints) * Math.PI * 2;
                        pts.push({ x: centerX + Math.cos(a) * radius, y: centerY + Math.sin(a) * radius });
                    }
                    return pts;
                }
            }

            const points = plan.commands
                .filter(c => c.x !== null && c.y !== null)
                .map(c => ({ x: c.x, y: c.y }));

            if (points.length <= maxPoints) {
                return points;
            }

            // Sample evenly distributed points
            const sampled = [];
            const step = points.length / maxPoints;
            for (let i = 0; i < maxPoints; i++) {
                sampled.push(points[Math.floor(i * step)]);
            }
            return sampled;
        }

        /**
         * Partition a tool-group's plans into regions, two levels deep.
         *
         * @param {string} partition - 'shape' (hard wall per shapeKey) or
         *   'proximity' (connected-by-stepover clusters, ignores shapeKey).
         *
         * IDENTITY (shapeKey): a hard partition that staydown must
         *   never cross. This is the gouge boundary between separate source
         *   shapes (or separate parts placed close together on the bed).
         *
         * PROXIMITY (within each shape): splits a shape's geometry
         *   into connected sub-clusters. Concentric pocket rings stay together
         *   (each within one stepover of the next, so they form one connected
         *   component and clear layer-by-layer). The outer and inner loops of
         *   an "O" / a holed profile are separated by the wall (> one stepover),
         *   so they split into their own sub-regions and each is cut on its own
         *   terms - all of its Z-passes consecutively - instead of interleaving
         *   outer/inner at every depth.
         *
         * Each resulting sub-region is therefore BOTH same-shape (staydown is
         * safe) AND one connected cluster (correct cut granularity).
         *
         * Falls back to pure proximity with allowStaydown when no shapeKey
         * is present; the caller may also force proximity via the partition arg.
         *
         * @returns {{ regions: Array, allowStaydown: boolean }}
         */
        buildRegions(plans, partition = 'shape') {
            const hasKey = (k) => k !== undefined && k !== null && k !== -1;

            // Helper: split a set of plans into connected staydown sub-clusters.
            // Within a single shape treat consecutive passes as connected
            // (generator guarantee), so concave shapes whose offset vertices
            // sample far apart are not wrongly split. Across shapes this
            // helper isn't given a pass signal, so it degrades to pure proximity.
            const subdivideByProximity = (groupPlans, usePassAdjacency) => {
                if (groupPlans.length <= 1) return [groupPlans];
                const md = groupPlans[0].metadata;
                let margin = md.toolDiameter * (1.0 - (md.stepOver / 100.0));
                return this.buildStaydownClusters(
                    groupPlans, margin + EPSILON, usePassAdjacency
                );
            };

            // PROXIMITY MODE
            // Isolation / clearing: proximity clusters ARE the staydown
            // unit.
            if (partition === 'proximity') {
                const clusters = subdivideByProximity(plans, false);
                this.debug(`buildRegions: proximity mode - ${clusters.length} cluster(s)`);
                return { regions: clusters, allowStaydown: true };
            }

            // SHAPE MODE
            const identity = plans.some(p => hasKey(p.metadata.shapeKey));

            if (identity) {
                // Level 1: hard partition by shapeKey.
                const byKey = new Map();
                let loose = 0;
                for (const p of plans) {
                    const k = hasKey(p.metadata.shapeKey)
                        ? p.metadata.shapeKey
                        : `loose_${loose++}`;
                    if (!byKey.has(k)) byKey.set(k, []);
                    byKey.get(k).push(p);
                }

                // Level 2: proximity sub-clustering inside each shape.
                // Pass-adjacency is enabled here because all plans share one shape.
                const regions = [];
                for (const [, shapePlans] of byKey) {
                    for (const sub of subdivideByProximity(shapePlans, true)) {
                        if (sub.length > 0) regions.push(sub);
                    }
                }

                this.debug(
                    `buildRegions: identity mode - ${byKey.size} shape(s) → ${regions.length} sub-region(s)`
                );
                return { regions, allowStaydown: true };
            }

            // No identity: pure proximity. allowStaydown stays true since
            // unidentified plans default to distance-based safety.
            const clusters = subdivideByProximity(plans, false);
            this.debug(`buildRegions: proximity fallback - ${clusters.length} cluster(s)`);
            return { regions: clusters, allowStaydown: true };
        }

        /**
         * Or-opt refinement over ONE tool/phase group's plan list.
         *
         * Unit of relocation is a BLOCK, not a plan. A plan whose
         * optimization.linkType is 'staydown' has a contract with its
         * immediate predecessor: MachineProcessor emits a feed move at the
         * current cut depth into its entry and suppresses the predecessor's
         * retract (isStayDownSource). Moving either half of that pair drags
         * the tool through uncut stock. Staydown runs are therefore glued
         * into atomic blocks before the search.
         *
         * Direction: a single-plan block that is a 3D open chain (V-Carve,
         * relief) may be entered from either end - the V-cone is symmetric
         * and raster lines are direction-agnostic - so each such block
         * contributes min(dist-to-entry, dist-to-exit) and is flipped when
         * its exit end is the cheaper approach.
         *
         * O(N^2) per pass with a small cap. Ordering is a fraction of total
         * time and the travel savings dwarf it.
         */
        refinePlanOrder(plans, startPos) {
            if (!plans || plans.length < 4) return plans;

            // Hard cap. With no staydown links every plan is its own block,
            // and the relocation search is O(blocks² · routeCost) = O(N³).
            // Ordered field rasters bypass this method entirely (fast path);
            // this guard protects the populations that legitimately reach it
            // (V-Carve skeletons, dense 2D jobs) from pathological sizes.
            // Beyond the cap the greedy NN order stands - correct, just not
            // or-opt-polished.
            // REVIEW - I dislike this safeguard, if it's a huge operation it will never fit. User just needs feedback. And multi-threading.
            const orOptMax = D.gcode.optimization.orOptMaxBlocks;

            // The first plan of a run has no predecessor to stay down from.
            // (optimizePathOrder now guards this too; belt and braces so the
            // block builder and MachineProcessor can never disagree.)
            const firstOpt = plans[0]?.metadata?.optimization;
            if (firstOpt && firstOpt.linkType === 'staydown') firstOpt.linkType = 'rapid';

            const blocks = [];
            for (const p of plans) {
                const linked = p.metadata.optimization?.linkType === 'staydown';
                if (linked && blocks.length) blocks[blocks.length - 1].push(p);
                else blocks.push([p]);
            }
            if (blocks.length < 4 || blocks.length > orOptMax) return plans;

            // Direction is free on a single 3D chain: the V-cone is symmetric
            // and raster lines are direction-agnostic. What decides the end is
            // the approach COST, which charges entry depth as travel - the same
            // model findClosestPointOnPlan uses, and the two have to agree or
            // the NN pass and this one fight over every chain. A glued staydown
            // block is never flipped: its internal links are XYZ-coincident
            // contracts with a specific neighbour.
            const reversible = (b) => b.length === 1 && b[0].metadata?.is3DContour === true;

            const entryOf = (b) => b[0].metadata.entryPoint;
            const exitOf  = (b) => b[b.length - 1].metadata.exitPoint
                                || b[b.length - 1].metadata.entryPoint;
            const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
            const approach = (from, p, is3D) =>
                dist(from, p) + this.entryDepthPenalty(p, is3D);

            // Cost to travel from machine position `from` into block `b`,
            // choosing the cheaper end when the block is reversible. Returns
            // the leave position (the OTHER end).
            const step = (from, b) => {
                const e = entryOf(b), x = exitOf(b);
                if (!reversible(b)) return { cost: approach(from, e, false), leave: x };
                const cE = approach(from, e, true), cX = approach(from, x, true);
                return cX < cE ? { cost: cX, leave: e } : { cost: cE, leave: x };
            };

            const routeCost = (seq) => {
                let pos = startPos, c = 0;
                for (const b of seq) { const s = step(pos, b); c += s.cost; pos = s.leave; }
                return c;
            };

            let best = blocks.slice();
            let bestCost = routeCost(best);
            let improved = true, guard = 0;
            const GUARD_MAX = 8; // REVIEW - Magic number, should it go on config.js?
            const deadline = performance.now() + (D.gcode.optimization.orOptBudgetMs);
            let trials = 0, budgetHit = false;

            while (improved && guard++ < GUARD_MAX && !budgetHit) {
                improved = false;
                for (let i = 0; i < best.length && !improved && !budgetHit; i++) {
                    const without = best.slice();
                    const [moved] = without.splice(i, 1);
                    for (let j = 0; j <= without.length; j++) {
                        if (j === i) continue;
                        // routeCost is O(blocks), so a full pass is O(blocks^3).
                        // The budget is what bounds it; partial polish beats the
                        // all-or-nothing bail a block-count cap gives.
                        if ((++trials & 0xFF) === 0 && performance.now() > deadline) {
                            budgetHit = true;
                            break;
                        }
                        const trial = without.slice();
                        trial.splice(j, 0, moved);
                        const c = routeCost(trial);
                        if (c < bestCost - 1e-6) {
                            best = trial; bestCost = c; improved = true; break;
                        }
                    }
                }
            }
            if (budgetHit) {
                this.debug(`refinePlanOrder: or-opt budget reached after ${trials} trial(s) ` +
                    `over ${blocks.length} block(s) - greedy order kept for the remainder`);
            }

            // Apply the direction decisions from the winning route.
            // reversePlanCommands rewrites commands + entry/exit +
            // optimizedEntryPoint. reversible() guarantees b.length === 1.
            let pos = startPos;
            for (const b of best) {
                if (reversible(b) && dist(pos, exitOf(b)) < dist(pos, entryOf(b)) - 1e-6) {
                    this.reversePlanCommands(b[0]);
                }
                pos = exitOf(b);
            }

            return best.flat();
        }

        /**
         * Or-opt relocate pass over the region sequence (look-ahead seed = greedy NN result).
         * Direction-PRESERVING: it only moves a region to a better slot, never reverses a
         * region's internal path - safe for multi-Z regions whose depth order is fixed.
         * Geometry-neutral: regions are rapid-linked, so reordering changes only travel.
         * This is the extension point: swap this for Or-3 / 2-opt / LK later without
         * touching geometry or stay-down.
         */
        refineRegionOrder(regions, startPos) {
            // REVIEW - I dislike this safeguard, if it's a huge operation it will never fit. User just needs feedback. And multi-threading.
            const orOptMax = D.gcode.optimization.orOptMaxBlocks;
            if (regions.length < 3 || regions.length > orOptMax) return regions;
            const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
            const cost = (seq) => {
                let pos = startPos, c = 0;
                for (const r of seq) { c += d(pos, r.entryPoint); pos = r.exitPoint; }
                return c;
            };

            let best = regions.slice();
            let bestCost = cost(best);
            let improved = true, guard = 0;
            while (improved && guard++ < 6) {            // tiny N; a few passes converge
                improved = false;
                for (let i = 0; i < best.length && !improved; i++) {
                    const without = best.slice();
                    const [moved] = without.splice(i, 1);
                    for (let j = 0; j <= without.length; j++) {
                        if (j === i) continue;
                        const trial = without.slice();
                        trial.splice(j, 0, moved);
                        const c = cost(trial);
                        if (c < bestCost - 1e-6) { best = trial; bestCost = c; improved = true; break; }
                    }
                }
            }
            return best;
        }

        /**
         * Optimize path order using nearest neighbor with link cost analysis
         */
        optimizePathOrder(plans, startPos, options = { allowStaydown: false, isClusterRun: false }) {
            if (plans.length <= 1) return plans;

            const ordered = [];
            const remaining = [...plans];
            let currentPos = { ...startPos };
            // No prior plan at the start of a run → first link can't be staydown anyway.
            this.lastShapeKey = null;
            this.skipShapeGuard = options.skipShapeGuard || false;
            // Each cluster is its own staydown unit. Without this flag the
            // first plan of cluster N+1 could staydown-link to the last plan
            // of cluster N (sameShape defaults to true when lastShapeKey is
            // null), dragging the tool at depth across the gap that defined
            // the cluster boundary in the first place.
            this.isFirstLink = true;

            let totalOriginalTravel = 0;
            let totalOptimizedTravel = 0;

            // exitPoint is what currentPos advances to after every pick, so a
            // plan missing one inherits its entry HERE - not inside the O(N^2)
            // cost call, which used to re-stamp it once per candidate per step.
            for (const item of plans) {
                const md = item.metadata;
                if (md && !md.exitPoint) md.exitPoint = md.entryPoint;
            }

            // Calculate original travel distance
            let pos = { ...startPos };
            for (const item of plans) {
                // Support both ToolpathPlan (metadata.entryPoint) and Cluster (entryPoint) objects
                const entry = item.entryPoint || item.metadata.entryPoint;
                const dx = entry.x - pos.x;
                const dy = entry.y - pos.y;
                totalOriginalTravel += Math.sqrt(dx * dx + dy * dy);
                pos = item.exitPoint || item.metadata.exitPoint;
            }

            // Nearest neighbor with link cost
            while (remaining.length > 0) {
                let bestIdx = 0;
                let bestResult = this.calculatePathLinkCost(currentPos, remaining[0], options.allowStaydown);
                let bestDist = bestResult.cost;

                // Search all remaining plans
                for (let i = 1; i < remaining.length; i++) {
                    const result = this.calculatePathLinkCost(currentPos, remaining[i], options.allowStaydown);
                    if (result.cost < bestDist) {
                        bestDist = result.cost;
                        bestIdx = i;
                        bestResult = result;
                    }
                }

                const chosen = remaining.splice(bestIdx, 1)[0];

                // Handle cluster run differently
                if (options.isClusterRun) {
                    if (chosen.plans && chosen.plans.length > 0) {
                        chosen.plans[0].metadata.optimization = {
                            linkType: bestResult.linkType,
                            originalEntryPoint: { ...chosen.plans[0].metadata.entryPoint },
                            optimizedEntryPoint: { ...bestResult.bestPoint },
                            entryCommandIndex: 0
                        };
                    }

                    ordered.push(chosen);
                    totalOptimizedTravel += bestResult.realDistance;
                    currentPos = { ...chosen.exitPoint };
                    continue;
                }

                // Store optimization decision in plan. COPIES, never aliases:
                // findClosestPointOnPlan returns metadata.entryPoint itself for
                // fixed-entry plans, and MachineProcessor's indexed +apothem
                // bump walks entryPoint, exitPoint and optimizedEntryPoint - a
                // shared object gets shifted twice.
                chosen.metadata.optimization = {
                    linkType: bestResult.linkType,
                    originalEntryPoint: { ...chosen.metadata.entryPoint },
                    optimizedEntryPoint: { ...bestResult.bestPoint },
                    entryCommandIndex: bestResult.commandIndex
                };

                // Rotate or reverse entry point to reduce travel.
                if (!chosen.metadata.isPeckMark && !chosen.metadata.isDrillMilling) {
                    const meta = chosen.metadata;
                    if (meta.isSimpleCircle && bestResult.commandIndex >= 0) {
                        // A full circle has one command, so the vertex scan
                        // cannot propose a better start - slide it instead.
                        this.rotateCircleEntry(chosen, currentPos);
                    } else if (bestResult.commandIndex === -2 && !meta.isClosedLoop) {
                        // Reverses both 2D open engraving paths and 3D contours
                        this.reversePlanCommands(chosen);
                    } else if (bestResult.commandIndex >= 0 && meta.isClosedLoop) {
                        this.rotatePlanCommands(chosen, bestResult.commandIndex);
                    }
                }

                ordered.push(chosen);
                totalOptimizedTravel += bestResult.realDistance;
                currentPos = { ...chosen.metadata.exitPoint };
                this.lastShapeKey = chosen.metadata.shapeKey ?? null;
                this.isFirstLink = false;
            }

            this.stats.originalTravelDistance += totalOriginalTravel;
            this.stats.optimizedTravelDistance += totalOptimizedTravel;
            this.stats.travelDistanceSaved += (totalOriginalTravel - totalOptimizedTravel);

            return ordered;
        }

        /**
         * Calculate cost and link type for traveling between plans.
         */
        calculatePathLinkCost(fromPos, toPlan, allowStaydown = false) {
            // Cluster objects (used when optimizing between clusters/regions)
            if (toPlan.plans && toPlan.entryPoint) {
                const bestPoint = toPlan.entryPoint;
                const dx = bestPoint.x - fromPos.x;
                const dy = bestPoint.y - fromPos.y;
                const closestXYDist = Math.sqrt(dx * dx + dy * dy);
                const rapidCost = this.calculateRapidCost(closestXYDist);
                return {
                    cost: rapidCost,
                    realDistance: closestXYDist,
                    linkType: 'rapid',
                    bestPoint: bestPoint,
                    commandIndex: -1
                };
            }

            const planMetadata = toPlan.metadata || {};

            // ── 3D continuation link ─────────────────────────────
            // This chain's end IS the current tool position in X, Y and Z, so
            // the connection is a zero-length move: nothing traverses material
            // and no cleared-path proof is needed - which is the only reason
            // lateral staydown is barred from 3D. Fires wherever two chains
            // share an endpoint: a medial junction, or a groove fragment
            // meeting the flat-zone spine it was split at. MachineProcessor
            // then drops the retract, the rapid and the plunge.
            if (planMetadata.is3DContour && !this.isFirstLink && Number.isFinite(fromPos.z)) {
                const tol = 2 * PRECISION;
                const meets = (p) => !!p &&
                    Math.abs(p.x - fromPos.x) <= tol &&
                    Math.abs(p.y - fromPos.y) <= tol &&
                    Math.abs((p.z ?? fromPos.z) - fromPos.z) <= tol;
                // Entry first: continuing forward costs no reversal.
                if (meets(planMetadata.entryPoint)) {
                    return {
                        cost: 0, realDistance: 0, linkType: 'staydown',
                        bestPoint: planMetadata.entryPoint, commandIndex: 0
                    };
                }
                if (meets(planMetadata.exitPoint)) {
                    return {
                        cost: 0, realDistance: 0, linkType: 'staydown',
                        bestPoint: planMetadata.exitPoint, commandIndex: -2
                    };
                }
            }

            // Stay-down safety checks.
            // sameShape: prevents the tool from dragging across open material
            // between separate features.
            // Multi-depth plans must NOT stay-down - the tool would traverse
            // at the previous feature's final depth through uncleared material.
            const sameShape = this.skipShapeGuard ? true :
                (planMetadata.shapeKey === undefined ||
                               planMetadata.shapeKey === null ||
                               this.lastShapeKey === undefined ||
                               this.lastShapeKey === null)
                ? true
                : (planMetadata.shapeKey === this.lastShapeKey);

            const isMultiDepth = (planMetadata.depthLevels?.length || 1) > 1;

            // 3D contours NEVER staydown. The link mechanism for 3D is the
            // MachineProcessor's allow3DHop feed-height hop between adjacent
            // same-group plans - not a lateral feed move at depth, which
            // would need a machined-surface proof between arbitrary chains.
            // (A previous contiguous3D check read this.last3DExit, which was
            // never assigned anywhere - the branch was dead code and every
            // 3D link already resolved to 'rapid'. This makes it explicit.)
            const canStaydown = allowStaydown &&
                               !this.isFirstLink &&
                               sameShape &&
                               !isMultiDepth &&
                               !planMetadata.isPeckMark &&
                               !planMetadata.isDrillMilling &&
                               !planMetadata.is3DContour;

            // Find this block:
            if (canStaydown) {
                const dxEntry = planMetadata.entryPoint.x - fromPos.x;
                const dyEntry = planMetadata.entryPoint.y - fromPos.y;
                
                // Calculate the square directly
                const originalEntryDistSq = (dxEntry * dxEntry) + (dyEntry * dyEntry);

                const toolDiameter = planMetadata.toolDiameter;
                const stepOverPercent = planMetadata.stepOver;
                const stepOverRatio = stepOverPercent / 100.0;
                const stepDistance = toolDiameter * (1.0 - stepOverRatio);
                const staydownThreshold = stepDistance + EPSILON;
                
                // Square the threshold
                const staydownThresholdSq = staydownThreshold * staydownThreshold;

                // Compare squares
                if (originalEntryDistSq <= staydownThresholdSq) {
                    return {
                        cost: Math.sqrt(originalEntryDistSq), // Only root when returning cost
                        realDistance: Math.sqrt(originalEntryDistSq),
                        linkType: 'staydown',
                        bestPoint: planMetadata.entryPoint,
                        commandIndex: -1
                    };
                }

                // Step A provides distanceSq here now:
                const { point: closestPoint, distanceSq: closestDistSq, distance: closestDist, commandIndex } =
                    this.findClosestPointOnPlan(fromPos, toPlan);

                // Compare squares again
                if (closestDistSq <= staydownThresholdSq && (commandIndex >= 0 || planMetadata.isSimpleCircle)) {
                    return {
                        cost: closestDist, // Already rooted by findClosestPointOnPlan
                        realDistance: closestDist,
                        linkType: 'staydown',
                        bestPoint: closestPoint,
                        commandIndex: commandIndex
                    };
                }
            }

            // Rapid link
            const { point: bestRapidPoint, distance: closestRapidXYDist,
                    approachCost, commandIndex: rapidCommandIndex } =
                this.findClosestPointOnPlan(fromPos, toPlan);

            const rapidCost = this.calculateRapidCost(approachCost ?? closestRapidXYDist);

            const isHop = planMetadata.is3DContour && planMetadata.allow3DHop;
            const linkType = isHop ? 'hop' : 'rapid';

            return {
                cost: rapidCost,
                realDistance: closestRapidXYDist,
                linkType: linkType,
                bestPoint: bestRapidPoint,
                commandIndex: rapidCommandIndex
            };
        }

        /**
         * Travel-equivalent cost of entering a 3D chain at `p`. Zero for 2D
         * plans and for any point with no Z.
         */
        entryDepthPenalty(p, is3D) {
            if (!is3D || !p || !Number.isFinite(p.z)) return 0;
            const k = D.toolpath.generation.threeD?.entryDepthCost ?? 0;
            return k > 0 ? Math.max(0, -p.z) * k : 0;
        }

        /** Flat surcharge so any staydown or continuation link out-bids a rapid. */
        calculateRapidCost(approachCost) {
            return approachCost + (D.toolpath.generation.rapidCost.baseCost);
        }

        /**
         * Find closest point on a plan
         */
        findClosestPointOnPlan(fromPos, plan) {
            const meta = plan.metadata || {};

            // Skip entry points for protected geometry
            if (meta.isPeckMark || meta.isDrillMilling || meta.isCenterlinePath || meta.isTabbedPass) {
                const entry = meta.entryPoint;
                const dx = entry.x - fromPos.x;
                const dy = entry.y - fromPos.y;
                const distSq = dx * dx + dy * dy;
                return {
                    point: entry,
                    distanceSq: distSq,
                    distance: Math.sqrt(distSq),
                    commandIndex: 0
                };
            }

            // Simple Circles: Entry point is always fixed at 0 index, but projected around circumference
            if (meta.isSimpleCircle) {
                const entry = meta.entryPoint;
                const dx = entry.x - fromPos.x;
                const dy = entry.y - fromPos.y;
                const distSq = dx * dx + dy * dy;
                return {
                    point: entry,
                    distanceSq: distSq,
                    distance: Math.sqrt(distSq),
                    commandIndex: 0
                };
            }

            const canRotate = meta.isClosedLoop ?? false;
            const is3D = meta.is3DContour ?? false;

            // ── Open Path Strategy (2D Engraving & 3D Contours) ──────────
            // Open paths only have 2 valid entry locations: start (entryPoint) or end (exitPoint).
            if (!canRotate) {
                const entry = meta.entryPoint;
                const exit = meta.exitPoint || entry;
                const dxE = entry.x - fromPos.x, dyE = entry.y - fromPos.y;
                const dxX = exit.x - fromPos.x, dyX = exit.y - fromPos.y;
                const distSqE = dxE * dxE + dyE * dyE;
                const distSqX = dxX * dxX + dyX * dyX;

                // Approach cost, not travel: a 3D chain entered at its deep end
                // plunges into stock or climbs out of a junction, so depth is
                // charged as travel and the shallow end wins unless the detour
                // is genuinely long. distance / distanceSq stay pure XY - the
                // staydown thresholds and the travel stats both read them.
                // refinePlanOrder's step() uses this same model; the two have
                // to agree or the two passes fight over direction.
                const distE = Math.sqrt(distSqE);
                const distX = Math.sqrt(distSqX);
                const costE = distE + this.entryDepthPenalty(entry, is3D);
                const costX = distX + this.entryDepthPenalty(exit, is3D);

                // commandIndex -2 signals reversal.
                return (costX < costE - EPSILON)
                    ? { point: exit, distanceSq: distSqX, distance: distX, approachCost: costX, commandIndex: -2 }
                    : { point: entry, distanceSq: distSqE, distance: distE, approachCost: costE, commandIndex: 0 };
            }

            // ── Closed Loop Strategy ──────────
            // Vertex sampling allowed ONLY for closed loops that can rotate start point.
            let bestPoint = meta.entryPoint;
            let bestDistSq = Infinity;
            let bestIndex = -1;

            if (plan.commands && plan.commands.length > 0) {
                for (let i = 0; i < plan.commands.length; i++) {
                    const cmd = plan.commands[i];
                    if (cmd.x === null || cmd.y === null || cmd.x === undefined || cmd.y === undefined) continue;

                    const dx = cmd.x - fromPos.x;
                    const dy = cmd.y - fromPos.y;
                    const distSq = dx * dx + dy * dy;

                    if (distSq < bestDistSq) {
                        bestDistSq = distSq;
                        bestPoint = { x: cmd.x, y: cmd.y };
                        bestIndex = i;
                    }
                }
            }

            if (bestIndex === -1) {
                const entry = meta.entryPoint;
                const dx = entry.x - fromPos.x;
                const dy = entry.y - fromPos.y;
                bestDistSq = dx * dx + dy * dy;
                bestPoint = entry;
                bestIndex = 0;
            }

            return {
                point: bestPoint,
                distanceSq: bestDistSq,
                distance: Math.sqrt(bestDistSq),
                commandIndex: bestIndex
            };
        }

        /**
         * Reverses command sequence and metadata endpoints for any open path plan (2D or 3D).
         * Swaps entryPoint and exitPoint, reverses motion order, flips arc directions (CW <-> CCW),
         * and recalculates relative arc center vectors (I/J).
         */
        reversePlanCommands(plan) {
            if (!plan || !plan.commands || plan.commands.length === 0) return;

            const oldCommands = plan.commands;
            const newCommands = [];

            // Reverse the command sequence array
            const reversed = [...oldCommands].reverse();

            // Compute motion endpoint mapping
            //  In forward order: command[k] moves tool TO command[k].x, y
            //  In reverse order: position before move comes from reversed[k-1] (or original entryPoint)
            for (let i = 0; i < reversed.length; i++) {
                const cmd = reversed[i];
                const nextCmdPos = (i < reversed.length - 1)
                    ? { x: reversed[i + 1].x, y: reversed[i + 1].y, z: reversed[i + 1].z }
                    : { ...plan.metadata.entryPoint };

                // Feed goes in PARAMS, not coords: MotionCommand reads
                // params.feed and ignores coords.f entirely. A dropped f
                // emits no F word, so the chain silently inherits the modal
                // feed - a reversed 3D chain then takes its slope-gated
                // descents at cutting feed instead of plunge. `a` is
                // undefined during optimization today (the rotary word is
                // written later, in convertDevelopedToRotary) but carrying
                // it costs nothing and stops that ordering from being load-
                // bearing.
                if (cmd.type === 'ARC_CW' || cmd.type === 'ARC_CCW') {
                    const newType = (cmd.type === 'ARC_CW') ? 'ARC_CCW' : 'ARC_CW';

                    // Arc center in original command was (currentPos.x + i, currentPos.y + j).
                    // In reverse, start position is cmd.x, cmd.y. Center remains constant:
                    // CenterX = original_end_x + cmd.i = new_start_x + new_i
                    // Therefore: new_i = original_start_x - original_end_x + cmd.i
                    const newI = (nextCmdPos.x - cmd.x) + cmd.i;
                    const newJ = (nextCmdPos.y - cmd.y) + cmd.j;

                    newCommands.push(new MotionCommand(newType, {
                        x: nextCmdPos.x, y: nextCmdPos.y, z: nextCmdPos.z, a: cmd.a
                    }, { feed: cmd.f, i: newI, j: newJ }));
                } else {
                    newCommands.push(new MotionCommand(cmd.type, {
                        x: nextCmdPos.x, y: nextCmdPos.y, z: nextCmdPos.z, a: cmd.a
                    }, { feed: cmd.f }));
                }
            }

            plan.commands = newCommands;

            // 3D chains: feed is a DIRECTION classification, not a value.
            // Each segment keeps its own feed above, which is right for a
            // 2D contour but wrong here - what was a steep ascent at
            // cutting feed is now a steep descent at cutting feed. Re-derive
            // from the same slope gate the translator used.
            if (plan.metadata.is3DContour) {
                const feedRate = plan.metadata.feedRate;
                const plungeRate = plan.metadata.plungeRate ?? feedRate;
                const gate = this.slopeGate();
                let px = plan.metadata.exitPoint?.x, py = plan.metadata.exitPoint?.y,
                    pz = plan.metadata.exitPoint?.z;
                for (const cmd of newCommands) {
                    if (cmd.x !== null && cmd.x !== undefined &&
                        cmd.z !== null && cmd.z !== undefined &&
                        px !== undefined && pz !== undefined) {
                        cmd.f = ToolpathFeeds.feedFor(
                            cmd.z - pz, Math.hypot(cmd.x - px, cmd.y - py),
                            feedRate, plungeRate, gate);
                    }
                    if (cmd.x !== null && cmd.x !== undefined) px = cmd.x;
                    if (cmd.y !== null && cmd.y !== undefined) py = cmd.y;
                    if (cmd.z !== null && cmd.z !== undefined) pz = cmd.z;
                }
            }

            // Swap Entry/Exit metadata
            const oldEntry = { ...plan.metadata.entryPoint };
            const oldExit = plan.metadata.exitPoint ? { ...plan.metadata.exitPoint } : { ...oldEntry };

            plan.metadata.entryPoint = oldExit;
            plan.metadata.exitPoint = oldEntry;

            if (plan.metadata.optimization) {
                plan.metadata.optimization.optimizedEntryPoint = { ...oldExit };
                plan.metadata.optimization.entryCommandIndex = 0;
            }
        }

        /**
         * Rotate plan entry point for closed loops.
         *
         * Arc I/J survive the splice: for a genuinely closed loop every
         * command keeps its predecessor. commands[k+1]'s new predecessor is
         * the plan start, which IS commands[k]'s endpoint; commands[0]'s is
         * commands[N-1], whose endpoint is commands[0]'s original start. The
         * defect was never the I/J - it was leaving metadata.optimization
         * describing the pre-rotation order while MachineProcessor positions
         * from optimizedEntryPoint.
         */
        rotatePlanCommands(plan, newEntryIndex) {
            if (newEntryIndex < 0 || newEntryIndex >= plan.commands.length) return;

            const pivotCmd = plan.commands[newEntryIndex];
            const prePivot = plan.commands.slice(0, newEntryIndex);
            const postPivot = plan.commands.slice(newEntryIndex + 1);

            plan.commands = [...postPivot, ...prePivot, pivotCmd];

            plan.metadata.entryPoint = {
                x: pivotCmd.x,
                y: pivotCmd.y,
                z: pivotCmd.z
            };
            plan.metadata.exitPoint = { ...plan.metadata.entryPoint };

            // MachineProcessor rapids to optimizedEntryPoint and then runs
            // commands[0]. Leaving it at the pre-rotation point positions the
            // tool at one place and starts an arc whose I/J are relative to
            // another - a wrong centre, which is how closed loops came out
            // correct on screen and destroyed in G-code.
            if (plan.metadata.optimization) {
                plan.metadata.optimization.optimizedEntryPoint = { ...plan.metadata.entryPoint };
                plan.metadata.optimization.entryCommandIndex = 0;
            }
        }

        /**
         * Rotate circle entry to the closest point on the circumference.
         *
         * Correct for a full-circle arc: winding is unchanged and the single
         * command's endpoint plus I/J both move with the start. The part that
         * is NOT optional is re-syncing metadata.optimization - MachineProcessor
         * positions the rapid, the entry move and every depth plunge from
         * optimizedEntryPoint, and findClosestPointOnPlan hands back
         * metadata.entryPoint ITSELF for a simple circle, so without this the
         * tool arrives at the pre-rotation point and runs an arc whose I/J
         * describe a different start: start + I/J is no longer the centre.
         */
        rotateCircleEntry(plan, fromPos) {
            const center = plan.metadata.center;
            const radius = plan.metadata.radius;
            if (!center || !radius) return;
            if (!plan.commands || plan.commands.length !== 1) {
                this.debug(`rotateCircleEntry skipped: isSimpleCircle plan has ` +
                    `${plan.commands?.length ?? 0} commands, expected 1`);
                return;
            }

            const dx = fromPos.x - center.x;
            const dy = fromPos.y - center.y;
            const distToCenter = Math.sqrt(dx * dx + dy * dy);

            if (distToCenter < PRECISION) return;

            const newEntryX = center.x + (dx / distToCenter) * radius;
            const newEntryY = center.y + (dy / distToCenter) * radius;

            // Z is carried, not dropped: a multi-depth circle's entry keeps
            // whatever plane it was on.
            const entryZ = plan.metadata.entryPoint?.z;
            plan.metadata.entryPoint = { x: newEntryX, y: newEntryY, z: entryZ };
            plan.metadata.exitPoint = { x: newEntryX, y: newEntryY, z: entryZ };

            if (plan.commands && plan.commands.length > 0) {
                const cmd = plan.commands[0];
                cmd.x = newEntryX;
                cmd.y = newEntryY;
                if (cmd.i !== undefined && cmd.j !== undefined) {
                    cmd.i = center.x - newEntryX;
                    cmd.j = center.y - newEntryY;
                }
            }

            if (plan.metadata.optimization) {
                plan.metadata.optimization.optimizedEntryPoint = { ...plan.metadata.entryPoint };
                plan.metadata.optimization.entryCommandIndex = 0;
            }
        }

        /**
         * tan(descentFeedAngle). One implementation so the feed classification
         * used at generation, at reversal and at simplification is provably the
         * same number.
         */
        slopeGate() {
            return ToolpathFeeds.slopeGate();
        }

        /** Squared 3D distance from p to the CLAMPED segment a→b. */
        deviationSq3D(p, a, b) {
            const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
            const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
            const abLenSq = abx * abx + aby * aby + abz * abz;
            if (abLenSq < 1e-18) return apx * apx + apy * apy + apz * apz;
            let t = (apx * abx + apy * aby + apz * abz) / abLenSq;
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const dx = apx - t * abx, dy = apy - t * aby, dz = apz - t * abz;
            return dx * dx + dy * dy + dz * dz;
        }

        /**
         * 3D simplification for V-Carve and relief plans. Two stages:
         *
         *   1. O(n) pre-pass. Collapses Voronoi micro-segments and
         *      near-collinear runs. A point is dropped only when its incoming
         *      segment is shorter than minSegmentLength3D OR the turn is under
         *      collinearAngle3D, AND the deviation from the bridging chord is
         *      below tolerance3D * preTolFactor. This is where 80-90% of the
         *      medial-axis point count goes, and it costs one pass.
         *
         *   2. 3D Ramer-Douglas-Peucker at tolerance3D over the survivors.
         *
         * Total deviation is bounded by tolerance3D * (1 + preTolFactor).
         *
         * Forced anchors (never removed):
         *  - first / last point. Chains break at every junction, so a junction
         *    and a corner apex are already terminal on the chains that reach
         *    them and need no anchor of their own.
         *  - any non-LINEAR command (arcs, dwells)
         *
         * Feeds are REBUILT from the surviving geometry with the shared slope
         * gate, so a simplified chain and a reversed chain classify identically.
         */
        simplify3DSegments(plan) {
            const cmds = plan.commands;
            if (!cmds || cmds.length < 2 || !plan.metadata.entryPoint) return;

            const s = D.toolpath.generation.simplification;
            const tol       = s.tolerance3D ?? 0.01;
            const tolSq     = tol * tol;
            const preTolSq  = Math.pow(tol * (s.preTolFactor ?? 0.25), 2);
            const minSegSq  = Math.pow(s.minSegmentLength3D ?? 0.02, 2);
            const cosGate   = Math.cos((s.collinearAngle3D ?? 1.0) * Math.PI / 180);
            const gate      = this.slopeGate();

            // ── Resolve the absolute point list [entry, ...commands] ──
            const P   = new Array(cmds.length + 1);
            const T   = new Array(cmds.length + 1);
            const CMD = new Array(cmds.length + 1);

            P[0] = { x: plan.metadata.entryPoint.x, y: plan.metadata.entryPoint.y, z: plan.metadata.entryPoint.z };
            T[0] = 'LINEAR';
            CMD[0] = null;

            let cx = P[0].x, cy = P[0].y, cz = P[0].z;
            for (let i = 0; i < cmds.length; i++) {
                const c = cmds[i];
                if (c.x !== null && c.x !== undefined) cx = c.x;
                if (c.y !== null && c.y !== undefined) cy = c.y;
                if (c.z !== null && c.z !== undefined) cz = c.z;
                P[i + 1] = { x: cx, y: cy, z: cz };
                T[i + 1] = c.type;
                CMD[i + 1] = c;
            }
            const n = P.length;
            if (n < 3) return;

            // Hard anchors
            const forced = new Uint8Array(n);
            forced[0] = 1;
            forced[n - 1] = 1;
            for (let i = 1; i < n; i++) {
                if (T[i] !== 'LINEAR') forced[i] = 1;
            }

            // ── Stage 1: micro-segment + collinearity pre-pass ──
            const anchors = [0];
            let prevIdx = 0;
            for (let i = 1; i < n - 1; i++) {
                if (forced[i]) { anchors.push(i); prevIdx = i; continue; }

                const a = P[prevIdx], b = P[i], c = P[i + 1];
                const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
                const bcx = c.x - b.x, bcy = c.y - b.y, bcz = c.z - b.z;
                const abLenSq = abx * abx + aby * aby + abz * abz;
                const bcLenSq = bcx * bcx + bcy * bcy + bcz * bcz;

                if (abLenSq < 1e-18 || bcLenSq < 1e-18) continue;   // duplicate point → drop

                const cosT = (abx * bcx + aby * bcy + abz * bcz) / Math.sqrt(abLenSq * bcLenSq);
                const collapsible = (abLenSq < minSegSq) || (cosT >= cosGate);

                if (!collapsible || this.deviationSq3D(b, a, c) > preTolSq) {
                    anchors.push(i);
                    prevIdx = i;
                }
            }
            anchors.push(n - 1);

            // ── Stage 2: 3D RDP over the survivors ──
            const m = anchors.length;
            const keepA = new Uint8Array(m);
            keepA[0] = 1;
            keepA[m - 1] = 1;
            for (let a = 1; a < m - 1; a++) if (forced[anchors[a]]) keepA[a] = 1;

            const stack = [];
            let blockStart = 0;
            for (let a = 1; a < m; a++) {
                if (keepA[a]) {
                    if (a - blockStart > 1) stack.push([blockStart, a]);
                    blockStart = a;
                }
            }

            while (stack.length > 0) {
                const [s0, s1] = stack.pop();
                if (s1 - s0 < 2) continue;
                const A = P[anchors[s0]];
                const B = P[anchors[s1]];
                let maxDevSq = 0, maxA = -1;
                for (let a = s0 + 1; a < s1; a++) {
                    const dev = this.deviationSq3D(P[anchors[a]], A, B);
                    if (dev > maxDevSq) { maxDevSq = dev; maxA = a; }
                }
                if (maxDevSq > tolSq && maxA > 0) {
                    keepA[maxA] = 1;
                    stack.push([s0, maxA]);
                    stack.push([maxA, s1]);
                }
            }

            // ── Reconstruction ──
            const feedRate   = plan.metadata.feedRate;
            const plungeRate = plan.metadata.plungeRate ?? feedRate;

            const newCmds = [];
            let prev = P[anchors[0]];
            for (let a = 1; a < m; a++) {
                if (!keepA[a]) continue;
                const i = anchors[a];

                if (T[i] !== 'LINEAR') {
                    newCmds.push(CMD[i]);   // preserve arcs/dwells exactly
                    prev = P[i];
                    continue;
                }

                const b = P[i];
                const dz  = b.z - prev.z;
                const dxy = Math.hypot(b.x - prev.x, b.y - prev.y);
                const feed = (dz < 0 && Math.abs(dz) > dxy * gate) ? plungeRate : feedRate;

                newCmds.push(new MotionCommand('LINEAR', { x: b.x, y: b.y, z: b.z }, { feed }));
                prev = b;
            }

            if (newCmds.length === 0) return;   // never hand the processor an empty plan

            plan.commands = newCmds;
            plan.metadata.entryPoint = { x: P[0].x, y: P[0].y, z: P[0].z };
            plan.metadata.exitPoint  = { x: P[n - 1].x, y: P[n - 1].y, z: P[n - 1].z };

            // process3DContourPlan plunges at optimizedEntryPoint. Leaving it
            // aliased to the pre-simplification object is a live footgun.
            const opt = plan.metadata.optimization;
            if (opt) opt.optimizedEntryPoint = { ...plan.metadata.entryPoint };

            plan.computeBounds();
        }

        /**
         * Simplify path by removing collinear points, aware of arcs.
         */
        simplifySegments(plan) {
            // 3D contours carry per-point Z; the collinearity test below is
            // XY-only, so a straight-in-XY relief scanline (all information
            // in Z) would collapse to its endpoints and flatten the terrain.
            // Output density for 3D plans is controlled at generation time
            // (simplify3D in the relief/vcarve generators).
            if (plan.metadata?.is3DContour) return;
            if (!plan.commands || plan.commands.length < 3) return;

            const simplified = [];
            const commands = plan.commands;
            let i = 0;

            // Track the end position of the last added command
            let currentPos = { x: null, y: null };
            if (plan.metadata.entryPoint) {
                currentPos = { x: plan.metadata.entryPoint.x, y: plan.metadata.entryPoint.y };
            }

            const isIgnorableArcCmd = (c, start, end) => {
                if (c.type !== 'ARC_CW' && c.type !== 'ARC_CCW') return false;
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const iVal = c.i || 0;
                const jVal = c.j || 0;

                return (dx * dx + dy * dy) < PRECISION && (iVal * iVal + jVal * jVal) < PRECISION;
            };

            const precisionSq = PRECISION * PRECISION;

            while (i < commands.length) {
                const cmd = commands[i];

                // If this command is a TAB (Z-move/geometry break), preserve it immediately and break any simplification sequence.
                if (cmd.metadata && cmd.metadata.isTab === true) {
                    simplified.push(cmd);
                    // Update currentPos to this command's end, if it has coords
                    if (cmd.x !== null && cmd.y !== null) {
                        currentPos = { x: cmd.x, y: cmd.y };
                    }
                    i++;
                    continue;
                }

                // Resolve the absolute target position of this command
                const cmdTargetPos = {
                    x: cmd.x !== null ? cmd.x : currentPos.x,
                    y: cmd.y !== null ? cmd.y : currentPos.y
                };

                // If it's a significant non-linear move, add it and continue.
                if (cmd.type !== 'LINEAR' && !isIgnorableArcCmd(cmd, currentPos, cmdTargetPos)) {
                    simplified.push(cmd);
                    currentPos = cmdTargetPos; // Update position
                    i++;
                    continue; // Move to the next command
                }

                // If it Is linear or an ignorable arc, process it as part of a linear sequence.
                // The true start point of this sequence is the `currentPos` from before this command.
                const sequenceStartPoint = { ...currentPos };
                const linearSequenceCmds = [];
                let sequenceEndPoint = cmdTargetPos; // End point of the *first* command

                // It's either LINEAR or an ignorable ARC here
                if (cmd.type !== 'LINEAR') {
                    linearSequenceCmds.push(new MotionCommand('LINEAR', { x: cmd.x, y: cmd.y }, { feed: cmd.f }));
                } else {
                    linearSequenceCmds.push(cmd); // It's the first linear cmd
                }

                // Greedily gather all subsequent linear OR ignorable arc commands
                let j = i + 1;
                while (j < commands.length) {
                    const nextCmd = commands[j];

                    // Stop gathering when hitting a tab command
                    if (nextCmd.metadata && nextCmd.metadata.isTab === true) break;

                    const nextCmdTargetPos = {
                        x: nextCmd.x !== null ? nextCmd.x : sequenceEndPoint.x,
                        y: nextCmd.y !== null ? nextCmd.y : sequenceEndPoint.y
                    };

                    if (nextCmd.type === 'LINEAR' || isIgnorableArcCmd(nextCmd, sequenceEndPoint, nextCmdTargetPos)) {
                        if (nextCmd.type !== 'LINEAR') {
                            linearSequenceCmds.push(new MotionCommand('LINEAR', { x: nextCmd.x, y: nextCmd.y }, { feed: nextCmd.f }));
                        } else {
                            linearSequenceCmds.push(nextCmd);
                        }
                        sequenceEndPoint = nextCmdTargetPos; // Update the end of the sequence
                        j++;
                    } else {
                        // It's a significant arc or other command, stop gathering.
                        break;
                    }
                }

                // Full sequence:
                // Start Point: sequenceStartPoint
                // Commands:    linearSequenceCmds (e.g., [L1, L2, L3])
                // End Point:   sequenceEndPoint

                // Build the full point list for this sequence
                const points = [{ ...sequenceStartPoint, isStart: true, cmd: null }];
                let tempPos = sequenceStartPoint;
                let lastPushedPoint = sequenceStartPoint;

                // Create a point-in-time snapshot for each command
                for (const linearCmd of linearSequenceCmds) {
                    tempPos = {
                        x: linearCmd.x !== null ? linearCmd.x : tempPos.x,
                        y: linearCmd.y !== null ? linearCmd.y : tempPos.y
                    };

                    // Check for zero-length segments / duplicate start point
                    const dx = tempPos.x - lastPushedPoint.x;
                    const dy = tempPos.y - lastPushedPoint.y;
                    const distSq = dx * dx + dy * dy;

                    // Deduplicate microscopic moves before running the heavy collinear simplifier
                    // This prevents NaN errors in angle calculations later
                    if (distSq > precisionSq) {
                        points.push({ ...tempPos, isStart: false, cmd: linearCmd });
                        lastPushedPoint = tempPos;
                    } else if (points.length > 0) {
                        // This is a zero-length move or the duplicate first point.
                        // Do not add the point, but do attach its command (e.g., feed rate) to the previous point. This ensures the command isn't lost. // Review - attaching random feed commands to previous points could be dangerous
                        points[points.length - 1].cmd = linearCmd;
                    }
                }

                // Closed-loop guard: when first ≈ last, the collinearity
                // reference line degenerates to a point and all deviations
                // become absolute distances, over-removing corners on small
                // contours. Strip the duplicate closure point, simplify the
                // open sequence, then re-attach the closure unconditionally.
                let closureCmd = null;
                const isClosed = plan.metadata.isClosedLoop || plan.metadata.isClosed;
                if (isClosed && points.length >= 4) {
                    const fp = points[0];
                    const lp = points[points.length - 1];
                    const cdx = lp.x - fp.x;
                    const cdy = lp.y - fp.y;
                    if (cdx * cdx + cdy * cdy < precisionSq) {
                        closureCmd = points.pop().cmd;
                    }
                }

                const simplifiedPoints = this.mergeCollinearPoints(points);
                for (const pt of simplifiedPoints) {
                    if (pt.cmd) { 
                        simplified.push(pt.cmd);
                    }
                }
                if (closureCmd) {
                    simplified.push(closureCmd);
                }
                currentPos = sequenceEndPoint;
                i = j;
            }

            plan.commands = simplified;
        }

        /**
         * Simplifies a point sequence by removing collinear points based on deviation and angle.
         */
        mergeCollinearPoints(points) {
            if (points.length <= 2) {
                return points; // Not enough points to simplify
            }

            const simplified = [points[0]]; // Always keep the start point

            const simpConfig = D.toolpath.generation.simplification;
            const curveTolerance = simpConfig.curveToleranceFallback;
            const straightTolerance = simpConfig.straightToleranceFallback;
            const sharpCornerTolerance = simpConfig.sharpCornerTolerance;
            const straightAngleThreshold = simpConfig.straightAngleThreshold; 
            const sharpAngleThreshold = simpConfig.sharpAngleThreshold;

            for (let i = 1; i < points.length - 1; i++) {
                const p0 = simplified[simplified.length - 1]; // Last kept point
                const p1 = points[i];
                const p2 = points[i + 1];

                // Calculate deviation distance (how far p1 is from line p0-p2)
                const distSq = this.perpendicularDistanceSq(p1, p0, p2);

                const v1x = p1.x - p0.x;
                const v1y = p1.y - p0.y;
                const v2x = p2.x - p1.x;
                const v2y = p2.y - p1.y;

                // Pre-calculate magnitude squares
                const mag1Sq = v1x * v1x + v1y * v1y;
                const mag2Sq = v2x * v2x + v2y * v2y;
                const tolSq = PRECISION * PRECISION;

                let angle = 0;
                // Only calculate angle if segments are not zero-length
                if (mag1Sq > tolSq && mag2Sq > tolSq) { 
                    const mag1 = Math.sqrt(mag1Sq);
                    const mag2 = Math.sqrt(mag2Sq);

                    const dot = v1x * v2x + v1y * v2y;
                    // Clamp to avoid floating point errors with acos()
                    const cosTheta = Math.max(-1.0, Math.min(1.0, dot / (mag1 * mag2)));
                    angle = Math.acos(cosTheta) * (180 / Math.PI); // Angle 0-180
                }

                // Determine nuanced tolerance based on the angle
                let effectiveTolerance;
                if (angle > sharpAngleThreshold) {
                    // This is a sharp corner. Be extremely strict to preserve it.
                    effectiveTolerance = sharpCornerTolerance;
                } else if (angle < straightAngleThreshold) {
                    // This is a straight line. Be aggressive/loose.
                    effectiveTolerance = straightTolerance;
                } else {
                    // This is a gentle curve. Use the standard curve tolerance.
                    effectiveTolerance = curveTolerance;
                }

                // Keep the point ONLY if it deviates more than the nuanced tolerance
                if (distSq >= (effectiveTolerance * effectiveTolerance)) {
                    simplified.push(p1); 
                }
                // If dist < effectiveTolerance, p1 is dropped.
            }

            simplified.push(points[points.length - 1]); // Always keep the end point

            // A closed loop reduced below 3 points is degenerate geometry
            // that would produce a missing or zero-area cut. Abort and
            // return the original points to preserve the shape.
            if (simplified.length < 3 && points.length >= 3) {
                return points;
            }

            return simplified;
        }

        /**
         * Calculates the squared perpendicular distance from a point to a line segment.
         */
        perpendicularDistanceSq(point, lineStart, lineEnd) {
            const dx = lineEnd.x - lineStart.x;
            const dy = lineEnd.y - lineStart.y;

            const lengthSquared = (dx * dx) + (dy * dy);

            // If the line segment is essentially a single point, return the squared distance to that point
            if (lengthSquared < 1e-12) { 
                const pdx = point.x - lineStart.x;
                const pdy = point.y - lineStart.y;
                return (pdx * pdx) + (pdy * pdy);
            }

            // Project point onto the line segment to find the intersection factor 't'
            let t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared;

            // Clamp t to [0, 1] so the intersection stays within the physical line segment
            t = Math.max(0, Math.min(1, t)); 

            // Calculate the exact intersection coordinates
            const projX = lineStart.x + t * dx;
            const projY = lineStart.y + t * dy;

            // Calculate the delta between our point and the intersection
            const pdx = point.x - projX;
            const pdy = point.y - projY;

            // Return the squared distance
            return (pdx * pdx) + (pdy * pdy);
        }

        getStats() {
            return {
                ...this.stats,
                travelSavedPercent: this.stats.originalTravelDistance > 0
                    ? ((this.stats.travelDistanceSaved / this.stats.originalTravelDistance) * 100).toFixed(1)
                    : 0
            };
        }

        resetStats() {
            this.stats = {
                originalPathCount: 0,
                optimizedPathCount: 0,
                originalTravelDistance: 0,
                optimizedTravelDistance: 0,
                travelDistanceSaved: 0,
                pointsRemoved: 0,
                optimizationTime: 0,
                staydownLinksUsed: 0
            };
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[Optimizer] ${message}`, data)
                 : console.log(`[Optimizer] ${message}`);
        }
    }

    window.ToolpathOptimizer = ToolpathOptimizer;
})();