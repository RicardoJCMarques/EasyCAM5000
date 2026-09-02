/*!
 * @file        geometry/geometry-utils-hatching.js
 * @description Scanline hatch fill generator for laser operations
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
     * Static hatch fill generator.
     *
     * Algorithm: Rotated scanline with Even-Odd intersection pairing.
     *   1. All contour edges (outer + hole) are rotated into a coordinate space
     *      where the hatch angle becomes horizontal, collected into a single flat
     *      edge pool with precomputed yMin/yMax bounds. Arc segments are tessellated
     *      into dense linear sub-edges for accurate scanline intersection.
     *   2. Horizontal scanlines sweep from bottom to top, intersecting all edges
     *      in one pass per scanline. The yMin/yMax pre-filter implements the
     *      standard vertex-hit crossing rule (count shared vertices exactly once).
     *   3. Sorted X-intersections are paired Even-Odd: [enter, exit], [enter, exit]…
     *      Holes are handled automatically - a hole boundary creates extra enter/exit
     *      pairs that skip the hole interior.
     *   4. Pairs are reordered in zig-zag fashion (alternating scan direction per
     *      scanline) to minimize laser head travel between consecutive lines.
     *   5. All endpoints are rotated back to world coordinates and packaged as
     *      2-point open PathPrimitives in operation.offsets format.
     *   6. Orientation angle is calculated from the origin so that hatch lines can be
     *      optimized before export.
     *
     * Input primitives MUST be boolean-unioned before calling generate().
     * This module performs pure geometry math - no Clipper2 dependency.
     */
    const HatchGenerator = {

        generate(primitives, settings) {
            if (!primitives || primitives.length === 0) {
                this.debug('No primitives to hatch');
                return [];
            }

            const baseAngle = settings.hatchAngle;
            const spacing = settings.stepDistance;
            const toolDiameter = settings.toolDiameter || 0;

            if (!spacing || spacing <= 0) {
                console.error('[HatchGenerator] Invalid step distance:', spacing);
                return [];
            }

            let numPasses = settings.hatchPasses;

            this.debug(`Generating hatch: ${numPasses} pass(es), base ${baseAngle}°, spacing ${spacing.toFixed(4)}mm`);

            const opType = settings.operationType || primitives[0]?.properties?.operationType || 'isolation';

            // Normalize all primitives to PathPrimitive so the edge collector can access contours and arcSegments.
            const normalizedPrimitives = [];
            for (const prim of primitives) {
                if (prim.type === 'path' && prim.contours) {
                    normalizedPrimitives.push(prim);
                } else {
                    const pathPrim = GeometryUtils.primitiveToPath(prim);
                    if (pathPrim && pathPrim.contours && pathPrim.contours.length > 0) {
                        normalizedPrimitives.push(pathPrim);
                    } else {
                        this.debug(`Failed to normalize ${prim.type} (id: ${prim.id}) to path, skipping`);
                    }
                }
            }

            if (normalizedPrimitives.length === 0) {
                this.debug('No valid path geometry after normalization');
                return [];
            }

            if (normalizedPrimitives.length !== primitives.length) {
                this.debug(`Normalized ${primitives.length} → ${normalizedPrimitives.length} path primitives`);
            }

            // Generate N passes, each rotated by 180°/numPasses from the previous.
            // Using 180° (not 360°) because hatch lines are bidirectional - a line at 0° covers the same area as one at 180°. This gives optimal angular separation: 1 pass = 0°, 2 passes = 0°/90°, 3 = 0°/60°/120°, etc.
            const angleStep = 180 / numPasses;
            const passes = [];

            for (let i = 0; i < numPasses; i++) {
                const passAngle = baseAngle + (angleStep * i);

                const lines = this.generatePass(normalizedPrimitives, passAngle, spacing, opType);
                if (lines.length === 0) continue;

                passes.push({
                    distance: 0,
                    pass: i + 1,
                    type: 'hatch',
                    primitives: lines,
                    metadata: {
                        isHatch: true,
                        strategy: 'hatch',
                        hatchPasses: numPasses,
                        angle: passAngle,
                        baseAngle: baseAngle,
                        passIndex: i,
                        lineCount: lines.length,
                        spacing: spacing,
                        toolDiameter: toolDiameter
                    }
                });
            }

            const totalLines = passes.reduce((sum, p) => sum + p.primitives.length, 0);
            this.debug(`Generated ${passes.length} pass(es), ${totalLines} total hatch lines`);

            return passes;
        },

        /**
         * Generates a single pass of parallel hatch lines at the given angle.
         */
        generatePass(primitives, angleDeg, spacing, operationType) {
            const angleRad = angleDeg * Math.PI / 180;

            // Use the global origin as rotation center so all operations hare the same rotated coordinate space. This makes hatch lines from separate operations collinear and mergeable.
            const center = { x: 0, y: 0 };

            // Collect all contour edges, rotate into scanline-aligned space.
            const { edges, minY, maxY } = this.collectAndRotateEdges(primitives, -angleRad, center);

            if (edges.length === 0 || !isFinite(minY) || !isFinite(maxY)) {
                this.debug('No valid edges found after rotation');
                return [];
            }

            this.debug(`Edge pool: ${edges.length} edges, Y range: [${minY.toFixed(3)}, ${maxY.toFixed(3)}]`);

            // Scanline sweep phase-locked to the rotated origin.
            // The origin (0,0) maps to (0,0) in rotated space, so align the grid to Y=0: first scanline at the nearest grid-aligned Y above minY.
            const rawScanlines = this.scanAndPair(edges, minY, maxY, spacing);

            if (rawScanlines.length === 0) {
                this.debug('Scanline sweep produced no intersections');
                return [];
            }

            // Zig-zag reorder for minimal laser travel.
            const zigzagLines = this.applyZigZag(rawScanlines);

            // Rotate back to world coordinates.
            const worldLines = this.rotateBack(zigzagLines, angleRad, center);

            // Package as PathPrimitives.
            return this.packageAsPathPrimitives(worldLines, angleDeg, operationType);
        },

        /**
         * Collects all contour edges from all primitives into a single flat pool, rotates each edge endpoint, and precomputes yMin/yMax for fast scanline rejection. Arc segments are tessellated into dense linear sub-edges so canline intersections follow the true curve, not straight chords.
         */
        collectAndRotateEdges(primitives, angleRad, center) {
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            const edges = [];
            let globalMinY = Infinity;
            let globalMaxY = -Infinity;

            // Shared helper: rotate a world-space point and add a linear edge
            const addLinearEdge = (p1, p2) => {
                const dx1 = p1.x - center.x;
                const dy1 = p1.y - center.y;
                const rx1 = center.x + dx1 * cos - dy1 * sin;
                const ry1 = center.y + dx1 * sin + dy1 * cos;

                const dx2 = p2.x - center.x;
                const dy2 = p2.y - center.y;
                const rx2 = center.x + dx2 * cos - dy2 * sin;
                const ry2 = center.y + dx2 * sin + dy2 * cos;

                // Skip truly degenerate edges (protects against division-by-zero).
                // Use a tight epsilon - SMALLER THAN PRECISION (0.001mm) - so that thin-sliver edges from Clipper boolean artifacts survive into the edge pool.
                // Near-coincident crossings from surviving slivers are handled by intersection deduplication in scanAndPair.
                if (Math.abs(ry1 - ry2) < 1e-10) return;

                const yMin = Math.min(ry1, ry2);
                const yMax = Math.max(ry1, ry2);

                edges.push({ rx1, ry1, rx2, ry2, yMin, yMax });

                if (yMin < globalMinY) globalMinY = yMin;
                if (yMax > globalMaxY) globalMaxY = yMax;
            };

            for (const prim of primitives) {
                if (prim.type !== 'path' || !prim.contours) continue;

                for (const contour of prim.contours) {
                    const pts = contour.points;
                    if (!pts || pts.length < 2) continue;

                    const arcSegs = contour.arcSegments;
                    const len = pts.length;

                    // Fast path: no arc segments on this contour → all straight edges
                    if (!arcSegs || arcSegs.length === 0) {
                        for (let i = 0; i < len; i++) {
                            addLinearEdge(pts[i], pts[(i + 1) % len]);
                        }
                        continue;
                    }

                    // Build arc lookup structures.
                    // arcStartMap: edge index → arc descriptor (for the first edge of each arc)
                    // coveredEdges: edge indices that are INTERIOR to an arc (skip in main loop)
                    const arcStartMap = new Map();
                    const coveredEdges = new Set();

                    for (const arc of arcSegs) {
                        // Validate arc data before using it
                        if (!arc.center || !isFinite(arc.radius) || arc.radius <= 0 ||
                            !isFinite(arc.startAngle) || !isFinite(arc.endAngle)) {
                            continue;
                        }

                        arcStartMap.set(arc.startIndex, arc);

                        // Mark intermediate edges as covered (everything after the first edge up to but not including the edge starting at endIndex)
                        let idx = (arc.startIndex + 1) % len;
                        // Safety: limit iterations to prevent infinite loop on bad data
                        let safety = len;
                        while (idx !== arc.endIndex && safety-- > 0) {
                            coveredEdges.add(idx);
                            idx = (idx + 1) % len;
                        }
                    }

                    // Main edge iteration
                    for (let i = 0; i < len; i++) {
                        const arc = arcStartMap.get(i);

                        if (arc) {
                            // This edge starts an arc. Tessellate the full arc into dense sub-edges using the analytic arc parameters.
                            const arcPts = this.tessellateArcForScanline(
                                arc,
                                pts[arc.startIndex],            // actual start point
                                pts[arc.endIndex % len]         // actual end point
                            );

                            for (let k = 0; k < arcPts.length - 1; k++) {
                                addLinearEdge(arcPts[k], arcPts[k + 1]);
                            }
                            continue;
                        }

                        // Skip edges that fall inside an arc (handled by tessellation above)
                        if (coveredEdges.has(i)) continue;

                        // Straight line segment
                        addLinearEdge(pts[i], pts[(i + 1) % len]);
                    }
                }
            }

            return { edges, minY: globalMinY, maxY: globalMaxY };
        },

        /**
         * Tessellates an arc segment into dense linear sub-edges for the scanline edge pool. Uses the arc's analytic parameters (center, radius, angles) to compute intermediate points. The first and last points are taken from the actual contour to avoid floating-point gaps at arc-line junctions.
         * Doesn't use the existing Util to avoid adding unnecessary arcs to the registry.
         */
        tessellateArcForScanline(arc, startPoint, endPoint) {
            // Determine sweep angle: use stored value if available, compute otherwise
            let sweepAngle = arc.sweepAngle;

            if (sweepAngle === undefined || sweepAngle === null) {
                sweepAngle = arc.endAngle - arc.startAngle;
                if (arc.clockwise) {
                    if (sweepAngle > 0) sweepAngle -= 2 * Math.PI;
                } else {
                    if (sweepAngle < 0) sweepAngle += 2 * Math.PI;
                }
            }

            // Check if a near-zero sweep represents a full circle or a tiny arc
            if (Math.abs(sweepAngle) < PRECISION) {
                // Check if start and end points are the same (full circle)
                const dx = startPoint.x - endPoint.x;
                const dy = startPoint.y - endPoint.y;
                if ((dx * dx + dy * dy) < PRECISION * PRECISION) {
                    sweepAngle = arc.clockwise ? -2 * Math.PI : 2 * Math.PI;
                } else {
                    // Not a circle, just a small arc - return straight edge
                    return [startPoint, endPoint];
                }
            }

            // Calculate segment count: proportional to sweep, with minimum for accuracy.
            // Uses getOptimalSegments for a full circle, then scales by sweep proportion.
            let segCount;
            const fullCircleSegs = GeometryTessellation.getOptimalSegments(arc.radius, 'arc');
            const proportion = Math.abs(sweepAngle) / (2 * Math.PI);
            segCount = Math.max(4, Math.ceil(fullCircleSegs * proportion));

            const points = [];

            // First point: use the actual contour point (avoids gap at junction)
            points.push(startPoint);

            // Intermediate points: analytically computed on the arc
            for (let i = 1; i < segCount; i++) {
                const t = i / segCount;
                const angle = arc.startAngle + sweepAngle * t;
                points.push({
                    x: arc.center.x + arc.radius * Math.cos(angle),
                    y: arc.center.y + arc.radius * Math.sin(angle)
                });
            }

            // Last point: use the actual contour point (avoids gap at junction)
            points.push(endPoint);

            return points;
        },

        /**
         * Sweeps horizontal scanlines through the rotated edge pool.
         * For each scanline Y, edges are tested with: y >= yMin && y < yMax.
         * This implements the standard half-open crossing rule: the bottom vertex s counted, the top vertex is excluded, ensuring shared vertices at polygon corners are counted exactly once.
         * After sorting X-intersections, near-coincident values are deduplicated using XOR-style toggle cancellation. This handles thin slivers from Clipper boolean artifacts: both edges of a sliver produce near-coincident crossings that cancel out, maintaining correct even-odd parity.
         * Remaining intersections are paired Even-Odd: pairs [0,1], [2,3], … represent filled segments. Holes create extra pairs that produce gaps.
         */
        scanAndPair(edges, minY, maxY, spacing) {
            const scanlines = [];
            const edgeCount = edges.length;

            // Merge threshold for near-coincident intersections.
            const mergeThreshold = PRECISION * 2;

            // Phase-lock scanlines to a global grid anchored at Y=0 in rotated space. Since all operations rotate around the same origin, their grids align exactly - enabling line fusion across operations during export.
            const startY = Math.ceil(minY / spacing) * spacing;

            for (let y = startY; y < maxY; y += spacing) {
                const intersections = [];

                for (let e = 0; e < edgeCount; e++) {
                    const edge = edges[e];

                    if (y < edge.yMin || y >= edge.yMax) continue;

                    const x = edge.rx1 + (y - edge.ry1) *
                            (edge.rx2 - edge.rx1) / (edge.ry2 - edge.ry1);
                    intersections.push(x);
                }

                if (intersections.length < 2) continue;

                intersections.sort((a, b) => a - b);

                // Deduplicate near-coincident intersections using XOR-style toggle.
                const deduped = [];
                for (let i = 0; i < intersections.length; i++) {
                    if (deduped.length > 0 &&
                        Math.abs(intersections[i] - deduped[deduped.length - 1]) < mergeThreshold) {
                        deduped.pop();
                    } else {
                        deduped.push(intersections[i]);
                    }
                }

                if (deduped.length < 2) continue;

                const pairs = [];
                for (let i = 0; i + 1 < deduped.length; i += 2) {
                    pairs.push({ x1: deduped[i], x2: deduped[i + 1], y });
                }

                if (pairs.length > 0) {
                    scanlines.push(pairs);
                }
            }

            return scanlines;
        },

        /**
         * Reorders scanline segments for zig-zag laser traversal, minimizing non-cutting travel.
         * Even-indexed scanlines: segments ordered left→right, each drawn L→R.
         * Odd-indexed scanlines:  segments ordered right→left, each drawn R→L.
         */
        applyZigZag(scanlines) {
            const lines = [];

            for (let i = 0; i < scanlines.length; i++) {
                const pairs = scanlines[i];
                const reverse = (i % 2 === 1);

                if (reverse) {
                    // Traverse segments right→left, each segment R→L
                    for (let j = pairs.length - 1; j >= 0; j--) {
                        lines.push({
                            startX: pairs[j].x2, startY: pairs[j].y,
                            endX:   pairs[j].x1, endY:   pairs[j].y
                        });
                    }
                } else {
                    // Traverse segments left→right, each segment L→R
                    for (let j = 0; j < pairs.length; j++) {
                        lines.push({
                            startX: pairs[j].x1, startY: pairs[j].y,
                            endX:   pairs[j].x2, endY:   pairs[j].y
                        });
                    }
                }
            }

            return lines;
        },

        /**
         * Rotates all line endpoints back from scanline-aligned space to world coordinates.
         */
        rotateBack(lines, angleRad, center) {
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);

            return lines.map(line => {
                const dsx = line.startX - center.x;
                const dsy = line.startY - center.y;
                const dex = line.endX - center.x;
                const dey = line.endY - center.y;

                return {
                    start: {
                        x: center.x + dsx * cos - dsy * sin,
                        y: center.y + dsx * sin + dsy * cos
                    },
                    end: {
                        x: center.x + dex * cos - dey * sin,
                        y: center.y + dex * sin + dey * cos
                    }
                };
            });
        },

        /**
         * Packages world-space line segments as 2-point open PathPrimitives.
         * Properties are set to avoid triggering CNC pipeline logic:
         * - isHatch: true    - identifies these as laser hatch lines
         * - closed: false     - prevents path-closing in renderer
         * - stroke/fill: false - prevents stroke-to-polygon conversion in preprocessor
         * These primitives only exist in operation.offsets and never enter the geometry preprocessing pipeline.
         */
        packageAsPathPrimitives(lines, angleDeg, operationType) {
            return lines.map((line, idx) => {
                return new PathPrimitive([{
                    points: [line.start, line.end],
                    isHole: false,
                    nestingLevel: 0,
                    parentId: null,
                    arcSegments: [],
                    curveIds: []
                }], {
                    isHatch: true,
                    hatchAngle: angleDeg,
                    hatchIndex: idx,
                    closed: false,
                    fill: false,
                    stroke: false,
                    polarity: 'dark',
                    operationType: operationType
                });
            });
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[HatchGenerator] ${message}`, data)
                 : console.log(`[HatchGenerator] ${message}`);
        }
    };

    window.HatchGenerator = HatchGenerator;
})();