/*!
 * @file        geometry/geometry-utils-topology.js
 * @description
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * Loop and compound topology for the operation pipeline: closure detection,
 * segment stitching, containment classification and compound assembly.
 *
 * Depends on GeometryUtils for primitive/point math (resolved at call time).
 * Nothing here is worker-loaded.
 */
(function () {
    'use strict';

    const ROOT = globalThis;
    const C = ROOT.CAMConfig.constants;
    const debugState = ROOT.CAMConfig.defaults.debug;
    const PRECISION = C.precision.coordinate;

    /**
     * Connected-component grouping. Sole consumer is extractClosedLoops.
     */
    class UnionFind {
        constructor(size) {
            this.parent = new Array(size);
            this.rank = new Array(size);
            for (let i = 0; i < size; i++) {
                this.parent[i] = i;
                this.rank[i] = 0;
            }
        }

        find(x) {
            while (this.parent[x] !== x) {
                this.parent[x] = this.parent[this.parent[x]];
                x = this.parent[x];
            }
            return x;
        }

        union(a, b) {
            const ra = this.find(a);
            const rb = this.find(b);
            if (ra === rb) return;
            if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
            else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
            else {
                this.parent[rb] = ra;
                this.rank[ra]++;
            }
        }
    }

    const GeometryTopology = {

        // Segment stitching

        /**
         * Converts a collection of unorganized, open segments into a single,
         * ordered closed PathPrimitive. Enforces CCW winding (Y-up standard for
         * outer boundaries) and guarantees curve metadata is mapped correctly.
         */
        mergeSegmentsIntoClosedPath(segments, forceClose = false, customTolerance = null) {
            if (!segments || segments.length < 2) return { success: false };
            this.debug('Merge input:', segments.map((s, i) => `[${i}] ${s.type}`).join(', '));

            // Normalize Endpoints
            const edges = segments.map((seg, i) => {
                let start, end;
                if (seg.type === 'arc') {
                    start = seg.startPoint;
                    end = seg.endPoint;
                } else if (seg.type === 'path') {
                    const pts = seg.contours[0].points;
                    start = pts[0];
                    end = pts[pts.length - 1];
                }
                return { index: i, segment: seg, start, end, used: false };
            }).filter((e) => e.start && e.end);

            if (edges.length === 0) return { success: false };

            // Greedy Chaining (Robust Distance Matching)
            const chain = [];
            edges[0].used = true;
            chain.push({ edge: edges[0], dir: 'forward' });
            let head = edges[0].start;   // Front of the chain
            let tail = edges[0].end;     // End of the chain

            const chainTolerance = customTolerance !== null
                ? customTolerance
                : (forceClose ? 0.5 : PRECISION);
            const chainTolSq = chainTolerance * chainTolerance;

            let added = true;
            let gapCount = 0;
            let maxGap = 0;

            while (added && chain.length < edges.length) {
                added = false;
                let bestMatch = null;
                let bestDistSq = chainTolSq;
                let bestDir = 'forward';

                // Search against TAIL
                for (const e of edges) {
                    if (e.used) continue;
                    const dxStart = e.start.x - tail.x, dyStart = e.start.y - tail.y;
                    const dStartSq = dxStart * dxStart + dyStart * dyStart;
                    const dxEnd = e.end.x - tail.x, dyEnd = e.end.y - tail.y;
                    const dEndSq = dxEnd * dxEnd + dyEnd * dyEnd;
                    if (dStartSq < bestDistSq) { bestDistSq = dStartSq; bestMatch = e; bestDir = 'forward'; }
                    if (dEndSq < bestDistSq) { bestDistSq = dEndSq; bestMatch = e; bestDir = 'reverse'; }
                }

                if (bestMatch) {
                    bestMatch.used = true;
                    chain.push({ edge: bestMatch, dir: bestDir });
                    tail = bestDir === 'forward' ? bestMatch.end : bestMatch.start;
                    const actualDist = Math.sqrt(bestDistSq);
                    if (actualDist > PRECISION) gapCount++;
                    maxGap = Math.max(maxGap, actualDist);
                    added = true;
                    continue;
                }

                bestMatch = null;
                bestDistSq = chainTolSq;
                bestDir = 'forward';

                // Search against HEAD
                for (const e of edges) {
                    if (e.used) continue;
                    const dxEnd = e.end.x - head.x, dyEnd = e.end.y - head.y;
                    const dEndSq = dxEnd * dxEnd + dyEnd * dyEnd;
                    const dxStart = e.start.x - head.x, dyStart = e.start.y - head.y;
                    const dStartSq = dxStart * dxStart + dyStart * dyStart;
                    if (dEndSq < bestDistSq) { bestDistSq = dEndSq; bestMatch = e; bestDir = 'forward'; }
                    if (dStartSq < bestDistSq) { bestDistSq = dStartSq; bestMatch = e; bestDir = 'reverse'; }
                }

                if (bestMatch) {
                    bestMatch.used = true;
                    chain.unshift({ edge: bestMatch, dir: bestDir });
                    head = bestDir === 'forward' ? bestMatch.start : bestMatch.end;
                    const actualDist = Math.sqrt(bestDistSq);
                    if (actualDist > PRECISION) gapCount++;
                    maxGap = Math.max(maxGap, actualDist);
                    added = true;
                }
            }

            // Gap / Chain Analysis
            const unchainedCount = edges.length - chain.length;
            const gapDistance = Math.hypot(head.x - tail.x, head.y - tail.y);
            const isClosed = gapDistance <= chainTolerance;
            const isFullyChained = unchainedCount === 0;
            if (gapDistance > PRECISION) gapCount++;
            maxGap = Math.max(maxGap, gapDistance);

            if (!isClosed || !isFullyChained) {
                if (isFullyChained) {
                    if (!isClosed && !forceClose) {
                        return {
                            success: false, isOpen: true, gapDistance, unchainedCount: 0,
                            totalSegments: edges.length, chainedCount: chain.length, gapCount, maxGap,
                        };
                    }
                } else if (!forceClose) {
                    return {
                        success: false, isOpen: true, gapDistance, unchainedCount,
                        totalSegments: edges.length, chainedCount: chain.length, gapCount, maxGap,
                    };
                }
            }

            // Point Assembly & Metadata Harvesting
            const rawPoints = [];
            const rawArcs = [];

            for (const link of chain) {
                const seg = link.edge.segment;
                const dir = link.dir;

                if (seg.type === 'arc') {
                    let sAngle = seg.startAngle;
                    let eAngle = seg.endAngle;
                    let isCW = seg.clockwise;
                    if (dir === 'reverse') {
                        sAngle = seg.endAngle;
                        eAngle = seg.startAngle;
                        isCW = !seg.clockwise;
                    }
                    const ptStart = dir === 'forward' ? seg.startPoint : seg.endPoint;
                    const ptEnd = dir === 'forward' ? seg.endPoint : seg.startPoint;
                    if (rawPoints.length === 0) rawPoints.push({ x: ptStart.x, y: ptStart.y });
                    const startIdx = rawPoints.length - 1;

                    // Store only the arc endpoint — no tessellation.
                    // The renderer draws arcs analytically from arcSegment metadata.
                    // Tessellation for Clipper2 happens on demand via contourArcsToPath().
                    rawPoints.push({ x: ptEnd.x, y: ptEnd.y });
                    rawArcs.push({
                        startIndex: startIdx,
                        endIndex: rawPoints.length - 1,
                        center: { x: seg.center.x, y: seg.center.y },
                        radius: seg.radius,
                        startAngle: sAngle,
                        endAngle: eAngle,
                        clockwise: isCW,
                    });
                } else if (seg.type === 'path') {
                    const pts = seg.contours[0].points;
                    const iterPts = dir === 'forward' ? pts : pts.slice().reverse();
                    if (rawPoints.length === 0) rawPoints.push({ x: iterPts[0].x, y: iterPts[0].y });
                    for (let i = 1; i < iterPts.length; i++) {
                        rawPoints.push({ x: iterPts[i].x, y: iterPts[i].y });
                    }
                }
            }

            // Cleanup duplicate endpoint
            const lastIdx = rawPoints.length - 1;
            if (lastIdx > 0 && Math.hypot(rawPoints[0].x - rawPoints[lastIdx].x, rawPoints[0].y - rawPoints[lastIdx].y) < PRECISION) {
                rawPoints.pop();
                rawArcs.forEach((arc) => {
                    if (arc.startIndex === lastIdx) arc.startIndex = 0;
                    if (arc.endIndex === lastIdx) arc.endIndex = 0;
                });
            }

            // Winding Enforcement
            const winding = GeometryUtils.calculateWinding(rawPoints);
            if (winding < 0) {
                // CW area -> Reverse array and mirror arcs to make it CCW
                const n = rawPoints.length;
                rawPoints.reverse();
                rawArcs.forEach((arc) => {
                    // Mirror indices to the reversed array
                    let newStart = n - 1 - arc.endIndex;
                    let newEnd = n - 1 - arc.startIndex;
                    if (newStart < 0) newStart += n;
                    if (newEnd < 0) newEnd += n;
                    arc.startIndex = newStart;
                    arc.endIndex = newEnd;

                    // Mirror trajectory
                    const temp = arc.startAngle;
                    arc.startAngle = arc.endAngle;
                    arc.endAngle = temp;
                    arc.clockwise = !arc.clockwise;
                });
                this.debug('Stitched path reversed to enforce CCW winding.');
            }

            // Sweep Calculation, Registration & Tagging
            const finalArcSegments = [];
            for (const arc of rawArcs) {
                let sweep = arc.endAngle - arc.startAngle;
                while (sweep > Math.PI) sweep -= 2 * Math.PI;
                while (sweep < -Math.PI) sweep += 2 * Math.PI;
                if (arc.clockwise && sweep > 0) sweep -= 2 * Math.PI;
                else if (!arc.clockwise && sweep < 0) sweep += 2 * Math.PI;
                arc.sweepAngle = sweep;

                let curveId = null;
                if (ROOT.globalCurveRegistry) {
                    curveId = ROOT.globalCurveRegistry.register({
                        type: 'arc',
                        center: arc.center,
                        radius: arc.radius,
                        startAngle: arc.startAngle,
                        endAngle: arc.endAngle,
                        clockwise: arc.clockwise,
                        source: 'stitched_cutout',
                    });
                }
                if (curveId) {
                    rawPoints[arc.startIndex].curveId = curveId;
                    rawPoints[arc.startIndex].segmentIndex = 0;
                    rawPoints[arc.endIndex].curveId = curveId;
                    rawPoints[arc.endIndex].segmentIndex = 1;
                }
                finalArcSegments.push({ ...arc, curveId });
            }

            this.debug(`Merge complete: ${rawPoints.length} points, ${finalArcSegments.length} arcs.`);

            const primitive = new PathPrimitive([{
                points: rawPoints,
                isHole: false,
                nestingLevel: 0,
                parentId: null,
                arcSegments: finalArcSegments,
                curveIds: finalArcSegments.map((s) => s.curveId).filter(Boolean),
            }], {
                isCutout: true,
                fill: true,
                stroke: false,
                closed: true,
                mergedFromSegments: segments.length,
                polarity: 'dark',
            });

            return {
                success: true,
                primitive,
                isOpen: !isClosed,
                gapDistance,
                unchainedCount,
                wasForceClosed: forceClose && !isClosed,
                totalSegments: edges.length,
                chainedCount: chain.length,
                gapCount,
                maxGap,
            };
        },

        /**
         * Analyzes gaps between endpoints of a set of primitives, generally cutouts.
         * @param {Array} primitives - Array of RenderPrimitives or contours.
         * @param {number} tolerance - Distance below which segments are considered connected.
         * @returns {Array<number>} Sorted array of unique gap distances in mm.
         */
        analyzeSegmentGaps(primitives, tolerance = PRECISION) {
            const endpoints = [];

            // Extract all start/end points from the primitives
            for (let i = 0; i < primitives.length; i++) {
                const prim = primitives[i];
                let start, end;
                if (prim.type === 'arc') {
                    start = prim.startPoint;
                    end = prim.endPoint;
                } else if (prim.contours?.[0]?.points?.length > 1) {
                    const pts = prim.contours[0].points;
                    start = pts[0];
                    end = pts[pts.length - 1];
                }
                if (start && end) {
                    endpoints.push({ pt: start, primIdx: i });
                    endpoints.push({ pt: end, primIdx: i });
                }
            }

            const gaps = [];

            // Find the closest neighbor for every endpoint (excluding its own other end)
            for (let i = 0; i < endpoints.length; i++) {
                let minSq = Infinity;
                for (let j = 0; j < endpoints.length; j++) {
                    // Don't compare a primitive to itself
                    if (endpoints[i].primIdx === endpoints[j].primIdx) continue;
                    const dx = endpoints[i].pt.x - endpoints[j].pt.x;
                    const dy = endpoints[i].pt.y - endpoints[j].pt.y;
                    const sq = dx * dx + dy * dy;
                    if (sq < minSq) minSq = sq;
                }
                if (minSq < Infinity) {
                    const dist = Math.sqrt(minSq);
                    // Filter out joints that are already successfully connected at current PRECISION
                    if (dist > tolerance) gaps.push(dist);
                }
            }

            // Sort and deduplicate the gaps
            gaps.sort((a, b) => a - b);
            const uniqueGaps = [];
            for (const g of gaps) {
                if (uniqueGaps.length === 0 || Math.abs(g - uniqueGaps[uniqueGaps.length - 1]) > 1e-5) {
                    uniqueGaps.push(g);
                }
            }
            return uniqueGaps;
        },

        // Closure predicates

        isPrimitiveClosed(prim, tolerance) {
            // Analytic shapes are closed by definition
            if (prim.type === 'circle' || prim.type === 'rectangle' || prim.type === 'obround') return true;

            // Check if an ArcPrimitive is a full 360 degree circle - REVIEW - double check this isn't redundant towards the new logic around single source of truth for circles post boolean.
            if (prim.type === 'arc') {
                const dx = prim.startPoint.x - prim.endPoint.x;
                const dy = prim.startPoint.y - prim.endPoint.y;
                return dx * dx + dy * dy < tolerance * tolerance;
            }

            // Check standard PathPrimitives
            if (!prim.contours || prim.contours.length === 0) return false;
            const pts = prim.contours[0].points;
            if (!pts || pts.length < 3) return false;
            const dx = pts[0].x - pts[pts.length - 1].x;
            const dy = pts[0].y - pts[pts.length - 1].y;
            return dx * dx + dy * dy < tolerance * tolerance;
        },

        endpointsConnect(edgeA, edgeB, tolerance) {
            const tolSq = tolerance * tolerance;
            const test = (p1, p2) => {
                const dx = p1.x - p2.x, dy = p1.y - p2.y;
                return dx * dx + dy * dy < tolSq;
            };
            return test(edgeA.start, edgeB.start)
                || test(edgeA.start, edgeB.end)
                || test(edgeA.end, edgeB.start)
                || test(edgeA.end, edgeB.end);
        },

        // Winding

        reverseContourWinding(contour) {
            const n = contour.points.length;
            contour.points.reverse();
            const curveIdMap = new Map();

            if (contour.arcSegments && contour.arcSegments.length > 0) {
                contour.arcSegments = contour.arcSegments.map((arc) => {
                    let newCurveId = arc.curveId;
                    if (arc.curveId && ROOT.globalCurveRegistry) {
                        if (!curveIdMap.has(arc.curveId)) {
                            const oldCurve = ROOT.globalCurveRegistry.getCurve(arc.curveId);
                            if (oldCurve) {
                                const flippedCurveId = ROOT.globalCurveRegistry.register({
                                    ...oldCurve,
                                    clockwise: !oldCurve.clockwise,
                                    startAngle: oldCurve.endAngle,
                                    endAngle: oldCurve.startAngle,
                                    sweepAngle: oldCurve.sweepAngle !== undefined ? -oldCurve.sweepAngle : undefined,
                                    source: (oldCurve.source || 'unknown') + '_flipped',
                                });
                                curveIdMap.set(arc.curveId, flippedCurveId);
                            }
                        }
                        newCurveId = curveIdMap.get(arc.curveId) || arc.curveId;
                    }
                    return {
                        ...arc,
                        startIndex: n - 1 - arc.endIndex,
                        endIndex: n - 1 - arc.startIndex,
                        startAngle: arc.endAngle,
                        endAngle: arc.startAngle,
                        clockwise: !arc.clockwise,
                        sweepAngle: arc.sweepAngle !== undefined ? -arc.sweepAngle : undefined,
                        curveId: newCurveId,
                    };
                });
            }

            if (curveIdMap.size > 0) {
                for (const pt of contour.points) {
                    if (pt.curveId && curveIdMap.has(pt.curveId)) pt.curveId = curveIdMap.get(pt.curveId);
                }
                if (contour.curveIds) {
                    contour.curveIds = contour.curveIds.map((id) => (curveIdMap.has(id) ? curveIdMap.get(id) : id));
                }
            }
        },

        // Loop extraction and classification

        /**
         * Groups cutout primitives into connected components by endpoint
         * proximity, then stitches each component into a closed loop
         * independently.
         */
        extractClosedLoops(primitives, tolerance) {
            const precision = tolerance || PRECISION;   // Coordinate epsilon parameter for user input on open polygons
            const closed = [];
            const open = [];
            for (const prim of primitives) {
                if (this.isPrimitiveClosed(prim, precision)) closed.push(prim);
                else open.push(prim);
            }
            this.debug(`extractClosedLoops: ${closed.length} already closed, ${open.length} open segments`);
            if (open.length === 0) return { loops: closed, orphans: [] };

            const edges = [];
            const skipped = [];
            for (let i = 0; i < open.length; i++) {
                const prim = open[i];
                let start, end;
                if (prim.type === 'arc') {
                    start = prim.startPoint;
                    end = prim.endPoint;
                } else {
                    const pts = prim.contours?.[0]?.points;
                    if (!pts || pts.length < 2) { skipped.push(prim); continue; }
                    start = pts[0];
                    end = pts[pts.length - 1];
                }
                if (start && end) edges.push({ index: i, primitive: prim, start, end });
                else skipped.push(prim);
            }

            if (edges.length === 0) {
                return {
                    loops: closed,
                    orphans: [...skipped, ...open.filter((_, i) => !edges.some((e) => e.index === i))],
                };
            }

            const uf = new UnionFind(edges.length);
            for (let i = 0; i < edges.length; i++) {
                for (let j = i + 1; j < edges.length; j++) {
                    if (this.endpointsConnect(edges[i], edges[j], precision)) uf.union(i, j);
                }
            }

            const components = new Map();
            for (let i = 0; i < edges.length; i++) {
                const root = uf.find(i);
                if (!components.has(root)) components.set(root, []);
                components.get(root).push(i);
            }
            this.debug(`extractClosedLoops: ${components.size} connected component(s)`);

            const stitchedLoops = [];
            const orphans = [];
            for (const [, indices] of components) {
                const componentPrims = indices.map((i) => edges[i].primitive);
                if (componentPrims.length === 1 && componentPrims[0].contours?.[0]?.points?.length < 3) {
                    orphans.push(...componentPrims);
                    continue;
                }
                const result = this.mergeSegmentsIntoClosedPath(componentPrims, false, precision);
                if (result.success) {
                    stitchedLoops.push(result.primitive);
                    this.debug(`  Component: ${componentPrims.length} segments → closed loop`);
                } else {
                    orphans.push(...componentPrims);
                    this.debug(`  Component: ${componentPrims.length} segments → orphans`);
                }
            }

            const allOrphans = [...skipped, ...orphans];

            // Analyze gaps across ALL orphan segments so callers get accurate data.
            // Per-component analysis (inside mergeSegmentsIntoClosedPath) can be misleading when segments are split across multiple connected components.
            let orphanGaps = [];
            if (allOrphans.length > 0) {
                orphanGaps = this.analyzeSegmentGaps(allOrphans);
                this.debug(`${allOrphans.length} orphan segment(s), gaps: ${orphanGaps.map((g) => g.toFixed(4) + 'mm').join(', ') || 'none'}`);
            }

            return { loops: [...closed, ...stitchedLoops], orphans: allOrphans, orphanGaps };
        },

        /**
         * Determines nesting hierarchy of closed loops via containment testing.
         * Assigns isHole and enforces correct winding (CCW outer, CW hole).
         */
        classifyCutoutTopology(rawLoops) {
            if (!rawLoops || rawLoops.length === 0) return [];

            // Ensure all loops are PathPrimitives before topology checks
            const loops = rawLoops.map((loop) => (loop.type !== 'path' && GeometryUtils.primitiveToPath(loop)) || loop);

            if (loops.length === 1) {
                const contour = loops[0].contours[0];
                if (GeometryUtils.isClockwise(contour.points)) this.reverseContourWinding(contour);
                contour.isHole = false;
                contour.nestingLevel = 0;
                return [{ loop: loops[0], isHole: false, parentIdx: null, depth: 0, originalIdx: 0 }];
            }

            const entries = loops.map((loop, idx) => {
                const pts = loop.contours[0].points;
                const absArea = Math.abs(GeometryUtils.calculateWinding(pts));
                let rep = GeometryUtils.getRepresentativePoint(loop);

                // Safety: if centroid falls outside a concave polygon, use longest-edge midpoint
                if (rep && !GeometryUtils.pointInPolygon(rep, pts)) {
                    let maxLenSq = 0, mid = rep;
                    for (let i = 0; i < pts.length; i++) {
                        const j = (i + 1) % pts.length;
                        const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
                        const lenSq = dx * dx + dy * dy;
                        if (lenSq > maxLenSq) {
                            maxLenSq = lenSq;
                            mid = { x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 };
                        }
                    }
                    rep = mid;
                }

                // Bounding box for the containment prefilter below.
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of pts) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                }

                return {
                    loop, originalIdx: idx, absArea, rep, parentIdx: null, depth: 0,
                    bb: { minX, minY, maxX, maxY },
                };
            });

            // Sort by area descending — entries[j] (j < i) is always >= entries[i]
            entries.sort((a, b) => b.absArea - a.absArea);

            // Find innermost containing parent for each loop.
            // BBox prefilter: a parent's bbox must contain the child's
            // representative point. For scattered loops (dense text: thousands
            // of glyphs, none nested) this rejects ~every pair with 4 float
            // compares instead of an O(V) pointInPolygon — the difference
            // between milliseconds and a multi-minute main-thread hang.
            for (let i = 1; i < entries.length; i++) {
                const rep = entries[i].rep;
                for (let j = i - 1; j >= 0; j--) {
                    const bb = entries[j].bb;
                    const outside = rep.x < bb.minX || rep.x > bb.maxX || rep.y < bb.minY || rep.y > bb.maxY;
                    if (!outside && GeometryUtils.pointInPolygon(rep, entries[j].loop.contours[0].points)) {
                        entries[i].parentIdx = entries[j].originalIdx;
                        entries[i].depth = entries[j].depth + 1;
                        break;
                    }
                }
            }

            // Classify and enforce winding
            const results = entries.map((entry) => {
                const isHole = entry.depth % 2 !== 0;
                const contour = entry.loop.contours[0];
                const isCW = GeometryUtils.isClockwise(contour.points);
                if ((isHole && !isCW) || (!isHole && isCW)) this.reverseContourWinding(contour);
                contour.isHole = isHole;
                contour.nestingLevel = entry.depth;
                return {
                    loop: entry.loop, isHole, parentIdx: entry.parentIdx,
                    depth: entry.depth, originalIdx: entry.originalIdx,
                };
            });

            this.debug(`classifyCutoutTopology: ${results.filter((r) => !r.isHole).length} outer(s), ${results.filter((r) => r.isHole).length} hole(s)`);
            return results;
        },

        // Compound assembly

        assembleCutoutCompounds(topologyResults) {
            const outers = topologyResults.filter((r) => !r.isHole);
            const holes = topologyResults.filter((r) => r.isHole);
            const compounds = [];

            for (const outer of outers) {
                const children = holes.filter((h) => h.parentIdx === outer.originalIdx);
                const contours = [];

                // Push all the inner holes FIRST
                for (const child of children) {
                    const hc = child.loop.contours[0];
                    contours.push({
                        points: hc.points,
                        isHole: true,
                        nestingLevel: 1,
                        parentId: null,
                        arcSegments: hc.arcSegments || [],
                        curveIds: hc.curveIds || [],
                    });
                }

                // Push the outer boundary LAST
                contours.push({
                    points: outer.loop.contours[0].points,
                    isHole: false,
                    nestingLevel: 0,
                    parentId: null,
                    arcSegments: outer.loop.contours[0].arcSegments || [],
                    curveIds: outer.loop.contours[0].curveIds || [],
                });

                compounds.push(new PathPrimitive(contours, {
                    isCutout: true, fill: true, stroke: false, closed: true, polarity: 'dark',
                }));
                this.debug(`Compound cutout: ${children.length} hole(s) + 1 outer`);
            }
            return compounds;
        },

        /**
         * Re-derives hole assignment for a single compound PathPrimitive
         * using geometric containment instead of winding sign.
         * Explodes contours into individual loops, classifies via
         * classifyCutoutTopology, then reassembles into compound
         * primitive(s) with correct isHole/nestingLevel/winding.
         * @param {PathPrimitive} primitive - A path with ≥2 contours
         * @returns {PathPrimitive[]} One or more correctly-tagged primitives
         */
        resolveCompoundContours(primitive) {
            if (!primitive || primitive.type !== 'path') return [primitive];
            const contours = primitive.contours;
            if (!contours || contours.length < 2) return [primitive];

            // EAGLE-composited primitives carry nestingLevel from the
            // sequential compositing pipeline — don't re-derive.
            if (primitive.properties?.isComposited) return [primitive];

            // Explode each contour into a single-contour PathPrimitive.
            // Reset isHole so classifyCutoutTopology starts from scratch.
            const loops = contours.map((c) => new PathPrimitive([{
                points: c.points,
                arcSegments: c.arcSegments || [],
                curveIds: c.curveIds || [],
                isHole: false,
                nestingLevel: 0,
                parentId: null,
            }], { ...primitive.properties }));

            // Classify by containment (area rank + pointInPolygon)
            const topology = this.classifyCutoutTopology(loops);

            // If no nesting found, return corrected-winding loops
            if (!topology.some((t) => t.isHole)) return loops;

            // Reassemble: group holes under their parent outer
            const outers = topology.filter((t) => !t.isHole);
            const holes = topology.filter((t) => t.isHole);
            const compounds = [];
            for (const outer of outers) {
                const children = holes.filter((h) => h.parentIdx === outer.originalIdx);
                // Outer contour first — classifyCutoutTopology reads contours[0]
                // for any future re-analysis, so outer must be at index 0.
                const newContours = [outer.loop.contours[0]];
                for (const child of children) newContours.push(child.loop.contours[0]);
                compounds.push(new PathPrimitive(newContours, { ...primitive.properties }));
            }

            // Orphan holes with no containing outer — keep as standalone
            for (const hole of holes) {
                if (hole.parentIdx === null) compounds.push(hole.loop);
            }

            return compounds.length > 0 ? compounds : [primitive];
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            if (data) console.log(`[GeometryTopology] ${message}`, data);
            else console.log(`[GeometryTopology] ${message}`);
        },
    };

    ROOT.GeometryTopology = GeometryTopology;
})();