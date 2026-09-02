/*!
 * @file        geometry/geometry-utils.js
 * @description Contains general auxiliary functions
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

    const GeometryUtils = {

        /**
         * Single authority for "is this ring a full circle".
         *
         * Provenance (one shared curveId, registry type 'circle') is the primary
         * evidence - the Clipper Z word exists to carry exactly this. The two
         * geometric clauses only have to reject a ring the boolean CLIPPED:
         *   - closedSweep catches a removed wedge whose endpoints stayed coincident
         *   - endGap catches a removed wedge that left a visible chord
         * Both tolerances scale off the tessellation step 2*PI*r/N, never off
         * precision.coordinate - the quantization grid is an order of magnitude
         * finer than the chord, so a coordinate-scaled bound can never be met.
         *
         * Works on an open ring (last point one chord from the first) and on an
         * explicitly closed one (last point duplicating the first).
         */
        analyzeCircleRing(points, opts = {}) {
            const reject = (reason, extra) => ({ isFullCircle: false, reason, ...extra });

            if (!points || points.length < 3) return reject('too-few-points');

            const registry = window.globalCurveRegistry;
            if (!registry) return reject('no-registry');

            let curveId = null;
            for (const pt of points) {
                const id = pt.curveId;
                if (!id || id <= 0) return reject('untagged-point');
                if (curveId === null) curveId = id;
                else if (id !== curveId) return reject('mixed-curve-ids', { curveId });
            }

            const curveData = registry.getCurve(curveId);
            if (!curveData || curveData.type !== 'circle') {
                return reject('not-a-circle', { curveId });
            }

            const cx = curveData.center.x;
            const cy = curveData.center.y;
            const n = points.length;
            const TAU = 2 * Math.PI;

            const fold = (d) => (d > Math.PI ? d - TAU : (d < -Math.PI ? d + TAU : d));

            let openSweep = 0;
            let prevAngle = Math.atan2(points[0].y - cy, points[0].x - cx);
            const firstAngle = prevAngle;
            for (let i = 1; i < n; i++) {
                const a = Math.atan2(points[i].y - cy, points[i].x - cx);
                openSweep += fold(a - prevAngle);
                prevAngle = a;
            }
            const closedSweep = openSweep + fold(firstAngle - prevAngle);

            const chord = (TAU * curveData.radius) / n;
            const endGap = Math.hypot(points[n - 1].x - points[0].x, points[n - 1].y - points[0].y);

            const angleTolerance = opts.angleTolerance ?? (TAU / n) * 1.5;
            const gapTolerance = opts.gapTolerance ?? chord * 1.5;

            const sweepOk = Math.abs(Math.abs(closedSweep) - TAU) <= angleTolerance;
            const gapOk = endGap <= gapTolerance;

            const result = {
                isFullCircle: sweepOk && gapOk,
                reason: sweepOk ? (gapOk ? 'ok' : 'end-gap') : 'sweep',
                curveId,
                curveData,
                center: { x: cx, y: cy },
                radius: curveData.radius,
                clockwise: closedSweep < 0,
                openSweep,
                closedSweep,
                chord,
                endGap
            };
            return result;
        },

        /**
         * AABB of an array of {x,y} points. Returns null for empty input or
         * if any coordinate is non-finite (callers treat null as "no bounds").
         * Main-thread only — worker/field primitives can't reach GeometryUtils.
         */
        boundsOfPoints(points) {
            if (!points || points.length === 0) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const p of points) {
                if (!p) continue;
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }
            return Number.isFinite(minX) && Number.isFinite(maxX) ? { minX, minY, maxX, maxY } : null;
        },

        /**
         * Merges an array of AABB objects ({minX,minY,maxX,maxY}), skipping
         * null/undefined entries. Returns null if nothing merged or the
         * result is non-finite.
         */
        mergeBounds(boundsList) {
            if (!boundsList || boundsList.length === 0) return null;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const b of boundsList) {
                if (!b) continue;
                if (b.minX < minX) minX = b.minX;
                if (b.minY < minY) minY = b.minY;
                if (b.maxX > maxX) maxX = b.maxX;
                if (b.maxY > maxY) maxY = b.maxY;
            }
            return Number.isFinite(minX) && Number.isFinite(maxX)
                ? { minX, minY, maxX, maxY } : null;
        },

        // Calculate winding (signed area)
        calculateWinding(points) {
            if (!points || points.length < 3) return 0;

            let area = 0;
            const len = points.length;
            for (let i = 0; i < len; i++) {
                const j = i === len - 1 ? 0 : i + 1;
                area += points[i].x * points[j].y;
                area -= points[j].x * points[i].y;
            }

            return area / 2;
        },

        // Check if points are clockwise
        isClockwise(points) {
            return this.calculateWinding(points) < 0;
        },

        /**
         * Converts an open trace (polyline) into overlapping stroke polygons.
         * Places a circle at every vertex (handling end-caps and joints) and 
         * a rectangle along every segment.
         * @param {Array} points - Array of {x,y} points forming the trace.
         * @param {number} strokeWidth - The full width of the trace.
         * @returns {Array<PathPrimitive>} Array of overlapping primitives to be unioned.
         */
        traceToPolygon(contour, strokeWidth, props = {}) {
            const boundaryStrokes = [];
            const offsetDist = strokeWidth / 2;
            const points = contour.points || contour; // Fallback if points array is passed directly

            if (!points || points.length < 2) return [];

            // Strip stroke properties
            const cleanProps = { 
                ...props, fill: true, closed: true, wasStroke: true, 
                stroke: false, strokeWidth: 0, isTrace: false  
            };

            // Build an Arc Map
            const arcMap = new Map();
            if (contour.arcSegments) {
                contour.arcSegments.forEach(arc => {
                    arcMap.set(arc.startIndex, arc);
                });
            }

            // Generate End Caps & Joints
            for (let i = 0; i < points.length; i++) {
                const pt = points[i];

                let curveId = null;
                if (window.globalCurveRegistry) {
                    curveId = window.globalCurveRegistry.register({
                        type: 'circle', center: { x: pt.x, y: pt.y },
                        radius: offsetDist, clockwise: cleanProps.polarity === 'clear',
                        source: (i === 0 || i === points.length - 1) ? 'end_cap' : 'trace_joint'
                    });
                }

                const circlePrim = {
                    type: 'circle', center: pt, radius: offsetDist, properties: { ...cleanProps }
                };

                const circlePath = GeometryTessellation.circleToPath(circlePrim);
                if (circlePath) {
                    delete circlePath.properties.stroke;
                    delete circlePath.properties.strokeWidth;
                    delete circlePath.properties.isTrace;

                    if (curveId && circlePath.contours[0]) {
                        circlePath.contours[0].curveIds = [curveId];
                        circlePath.contours[0].points.forEach(p => p.curveId = curveId);
                        circlePath.contours[0].arcSegments.forEach(arc => arc.curveId = curveId);
                    }
                    boundaryStrokes.push(circlePath);
                }
            }

            //Generate Line/Arc Segments
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                const arc = arcMap.get(i);

                if (arc && arc.endIndex !== undefined) {
                    const endPt = points[arc.endIndex]; 

                    const mockArc = {
                        type: 'arc', radius: arc.radius, center: arc.center, clockwise: arc.clockwise,
                        startAngle: arc.startAngle, endAngle: arc.endAngle,
                        startPoint: p1, endPoint: endPt,
                        properties: { polarity: 'dark' }
                    };

                    const arcStroke = this.arcToPolygon(mockArc, strokeWidth);
                    if (arcStroke) boundaryStrokes.push(arcStroke);

                    if (arc.endIndex > i) {
                        i = arc.endIndex - 1; 
                    } else if (arc.endIndex < i) {
                        // Do not break. Fast-forward to the end of the array so the wrapped arc is processed, and the loop naturally finishes.
                        i = points.length - 1;
                    }
                } else {
                    // Standard linear segment logic
                    const dx = p2.x - p1.x;
                    const dy = p2.y - p1.y;
                    const segLen = Math.hypot(dx, dy);

                    // Skip microscopic segments
                    if (segLen < PRECISION * 2) continue;

                    // Generate pure, unshifted rectangle bounds
                    const ux = dx / segLen;
                    const uy = dy / segLen;

                    const nx = (-uy) * offsetDist;
                    const ny = (ux) * offsetDist;

                    const isHole = cleanProps.polarity === 'clear';

                    // Natively assign array order based on winding requirement (CCW for outers, CW for holes in Y-up)
                    const rectPoints = isHole ? [
                        { x: p1.x + nx, y: p1.y + ny },
                        { x: p2.x + nx, y: p2.y + ny },
                        { x: p2.x - nx, y: p2.y - ny },
                        { x: p1.x - nx, y: p1.y - ny }
                    ] : [
                        { x: p1.x - nx, y: p1.y - ny },
                        { x: p2.x - nx, y: p2.y - ny },
                        { x: p2.x + nx, y: p2.y + ny },
                        { x: p1.x + nx, y: p1.y + ny }
                    ];

                    const rectPath = new PathPrimitive([{
                        points: rectPoints, isHole: isHole, nestingLevel: 0,
                        parentId: null, arcSegments: [], curveIds: []
                    }], { ...cleanProps });

                    // Explicit delete for rectangles too
                    delete rectPath.properties.stroke;
                    delete rectPath.properties.strokeWidth;
                    delete rectPath.properties.isTrace;

                    boundaryStrokes.push(rectPath);
                }
            }

            return boundaryStrokes;
        },

        /**
        * polylineToPolygon has been deprecated in favor of traceToPolygon that generates joint geometry that is easier to process. They will remain commented out until analytic offset path development is restarted.
        // Convert polyline to polygon with metadata for end-caps
        polylineToPolygon(points, width, curveIds = []) {
            if (!points || points.length < 2) return [];

            const halfWidth = width / 2;

            // Single segment - use specialized function
            if (points.length === 2) {
                return this.lineToPolygon(
                    {x: points[0].x, y: points[0].y},
                    {x: points[1].x, y: points[1].y},
                    width,
                    curveIds
                );
            }

            // Multi-segment with proper end-cap metadata
            const leftSide = [];
            const rightSide = [];

            // Register end-caps with explicit clockwise=false
            const startCapId = window.globalCurveRegistry?.register({
                type: 'arc',
                center: { x: points[0].x, y: points[0].y },
                radius: halfWidth,
                startAngle: 0,
                endAngle: Math.PI * 2,
                clockwise: false,  // End-caps always CCW
                source: 'end_cap'
            });
            if (startCapId) curveIds.push(startCapId);

            const endCapId = window.globalCurveRegistry?.register({
                type: 'arc',
                center: { x: points[points.length - 1].x, y: points[points.length - 1].y },
                radius: halfWidth,
                startAngle: 0,
                endAngle: Math.PI * 2,
                clockwise: false,  // End-caps always CCW
                source: 'end_cap'
            });
            if (endCapId) curveIds.push(endCapId);

            for (let i = 0; i < points.length - 1; i++) {
                const p0 = i > 0 ? points[i - 1] : null;
                const p1 = points[i];
                const p2 = points[i + 1];

                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const len = Math.sqrt(dx * dx + dy * dy);

                if (len < PRECISION) continue;

                const ux = dx / len;
                const uy = dy / len;
                const nx = -uy * halfWidth;
                const ny = ux * halfWidth;

                if (i === 0) {
                    // Start cap with complete metadata
                    const capPoints = this.generateCompleteRoundedCap(
                        p1, -ux, -uy, halfWidth, true, startCapId
                    );
                    leftSide.push(...capPoints);
                    rightSide.push({ x: p1.x - nx, y: p1.y - ny });
                } else {
                    // Join
                    const joinPoints = this.generateJoin(p0, p1, p2, halfWidth);
                    leftSide.push(joinPoints.left);
                    rightSide.push(joinPoints.right);
                }

                if (i === points.length - 2) {
                    // End cap with complete metadata
                    leftSide.push({ x: p2.x + nx, y: p2.y + ny });
                    const capPoints = this.generateCompleteRoundedCap(
                        p2, ux, uy, halfWidth, false, endCapId
                    );
                    rightSide.push(...capPoints);
                }
            }

            return [...leftSide, ...rightSide.reverse()];
        },
         */

        /**
         * Converts a closed contour into overlapping stroke polygons.
         * Fixes spikes by merging micro-segments, while strictly protecting registered curve points.
         */
        closedContourToStrokePolygons(contour, strokeWidth) {
            const boundaryStrokes = [];
            const offsetDist = strokeWidth / 2;

            // Threshold to absorb micro-segments that cause floating-point normal breakdown. Arbitrary, adjust as necessary.
            const minSegLen = Math.max(PRECISION, offsetDist * 0.02);

            let rawPoints = contour.points;
            if (!rawPoints || rawPoints.length < 2) return [];

            // Clean closing duplicates
            const first = rawPoints[0];
            const last = rawPoints[rawPoints.length - 1];
            let sliced = false;

            const dx = first.x - last.x;
            const dy = first.y - last.y;
            if (rawPoints.length > 2 && (dx * dx + dy * dy) < PRECISION * PRECISION) {
                rawPoints = rawPoints.slice(0, -1);
                sliced = true;
            }

            const lenRaw = rawPoints.length;
            const arcMapRaw = new Map();
            const arcEndIndices = new Set();

            // Wrap indices safely if the duplicate closing point was removed
            if (contour.arcSegments) {
                contour.arcSegments.forEach(arc => {
                    let start = arc.startIndex;
                    let end = arc.endIndex;

                    if (sliced) {
                        if (start >= lenRaw) start = 0;
                        if (end >= lenRaw) end = 0;
                    }

                    if (start < lenRaw && end < lenRaw) {
                        arcMapRaw.set(start, { ...arc, startIndex: start, endIndex: end });
                        arcEndIndices.add(end);
                    }
                });
            }

            const points = [];
            const indexMap = new Array(lenRaw).fill(0);
            let lastKeptIndex = 0;

            points.push(rawPoints[0]);
            indexMap[0] = 0;

            // Point Consolidation Pass
            for (let i = 1; i < lenRaw; i++) {
                const p1 = rawPoints[lastKeptIndex];
                const p2 = rawPoints[i];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // Protect registered curve points AND arc start/end indices
                const isProtected = (p2.curveId && p2.curveId > 0) || 
                                    arcMapRaw.has(lastKeptIndex) || 
                                    arcMapRaw.has(i) ||
                                    arcEndIndices.has(i);

                if (dist >= minSegLen || isProtected) {
                    points.push(p2);
                    indexMap[i] = points.length - 1;
                    lastKeptIndex = i;
                } else {
                    indexMap[i] = points.length - 1;
                }
            }

            const len = points.length;
            if (len < 2) return [];

            // Remap arc indices to the new consolidated points array
            const arcMap = new Map();
            arcMapRaw.forEach((arc, oldStart) => {
                const newStart = indexMap[oldStart];
                const newEnd = indexMap[arc.endIndex];
                if (newStart !== newEnd) {
                    arcMap.set(newStart, { ...arc, startIndex: newStart, endIndex: newEnd });
                }
            });

            // Generate Stroke Geometry
            for (let i = 0; i < len; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % len];

                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const segLen = Math.hypot(dx, dy);

                if (segLen < PRECISION) continue;

                // Add Vertex Joint (Circle)
                const circlePrim = {
                    type: 'circle',
                    center: p1,
                    radius: offsetDist,
                    properties: { polarity: 'dark', fill: true, closed: true }
                };
                const circlePath = GeometryTessellation.circleToPath(circlePrim);
                if (circlePath) {
                    delete circlePath.properties.stroke;
                    delete circlePath.properties.strokeWidth;
                    delete circlePath.properties.isTrace;
                    boundaryStrokes.push(circlePath);
                }

                // Add Segment Body
                const arc = arcMap.get(i);
                if (arc && arc.endIndex !== undefined) {

                    // Safe endpoint fetch
                    const endPt = points[arc.endIndex]; 

                    const mockArc = {
                        type: 'arc', radius: arc.radius, center: arc.center, clockwise: arc.clockwise,
                        startAngle: arc.startAngle, endAngle: arc.endAngle,
                        startPoint: p1, endPoint: endPt,
                        properties: { polarity: 'dark' }
                    };

                    const arcStroke = this.arcToPolygon(mockArc, strokeWidth);
                    if (arcStroke) boundaryStrokes.push(arcStroke);

                    // Advance index safely, handling wraparound
                    if (arc.endIndex > i) {
                        i = arc.endIndex - 1; 
                    } else if (arc.endIndex < i) {
                        break; 
                    }
                } else {
                    const nx = (-dy / segLen) * offsetDist;
                    const ny = (dx / segLen) * offsetDist;

                    const rectPoints = [
                        { x: p1.x - nx, y: p1.y - ny },
                        { x: p2.x - nx, y: p2.y - ny },
                        { x: p2.x + nx, y: p2.y + ny },
                        { x: p1.x + nx, y: p1.y + ny }
                    ];

                    boundaryStrokes.push(new PathPrimitive([{
                        points: rectPoints, isHole: false, nestingLevel: 0,
                        parentId: null, arcSegments: [], curveIds: []
                    }], { polarity: 'dark', fill: true, closed: true }));
                }
            }
            return boundaryStrokes;
        },

        /**
        * polylineToPolygon has been deprecated in favor of traceToPolygon that generates joint geometry that is easier to process. They will remain until commented out until analytic offset path development is restarted.
        * lineToPolygon is only called by polylineToPolygon.
         * Converts a line to a polygon, returning a flat point array.
         * It registers end-caps and tags points with curveId.
        lineToPolygon(from, to, width, curveIds = []) {
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const halfWidth = width / 2;

            // Zero-length line becomes circle with metadata
            if (len < PRECISION) {
                const segments = GeometryTessellation.getOptimalSegments(halfWidth, 'circle');
                const points = [];
                // Register circle end-cap with clockwise=false
                const curveId = window.globalCurveRegistry?.register({
                    type: 'circle',
                    center: { x: from.x, y: from.y },
                    radius: halfWidth,
                    clockwise: false,  // Always CCW
                    source: 'end_cap'
                });

                for (let i = 0; i < segments; i++) {
                    const angle = (i / segments) * 2 * Math.PI;
                    const point = {
                        x: from.x + halfWidth * Math.cos(angle),
                        y: from.y + halfWidth * Math.sin(angle),
                        curveId: curveId,
                        segmentIndex: i,
                        totalSegments: segments,
                        t: i / segments
                    };
                    points.push(point);
                }
                return points;
            }

            const ux = dx / len;
            const uy = dy / len;
            const nx = -uy * halfWidth;
            const ny = ux * halfWidth;

            const points = [];

            // Register end-caps with explicit clockwise=false
            const startCapId = window.globalCurveRegistry?.register({
                type: 'arc',
                center: { x: from.x, y: from.y },
                radius: halfWidth,
                startAngle: 0,
                endAngle: Math.PI * 2,
                clockwise: false,  // Always CCW
                source: 'end_cap'
            });
            if (startCapId) curveIds.push(startCapId);

            const endCapId = window.globalCurveRegistry?.register({
                type: 'arc',
                center: { x: to.x, y: to.y },
                radius: halfWidth,
                startAngle: 0,
                endAngle: Math.PI * 2,
                clockwise: false,  // Always CCW
                source: 'end_cap'
            });
            if (endCapId) curveIds.push(endCapId);

            // Left side of start
            points.push({ x: from.x + nx, y: from.y + ny });

            // Start cap - perpendicular direction is the "radial" for line end caps
            const perpAngle = Math.atan2(ny, nx);
            const startCapPoints = this.generateCompleteRoundedCap(
                from,           // cap center
                perpAngle,      // "radial" direction (perpendicular to line)
                halfWidth,      // cap radius
                false,          // no arc direction for straight lines
                startCapId
            );

            // Add cap points, handling duplicates at connection
            startCapPoints.forEach((point, i) => {
                if (i === 0 && points.length > 0) {
                    const lastPoint = points[points.length - 1];
                    if (Math.abs(point.x - lastPoint.x) < PRECISION &&
                        Math.abs(point.y - lastPoint.y) < PRECISION) {
                        Object.assign(lastPoint, {
                            curveId: point.curveId,
                            segmentIndex: point.segmentIndex,
                            totalSegments: point.totalSegments,
                            t: point.t,
                            isConnectionPoint: true
                        });
                        return;
                    }
                }
                points.push(point);
            });

            // Right side
            points.push({ x: from.x - nx, y: from.y - ny });
            points.push({ x: to.x - nx, y: to.y - ny });

            // End cap with complete metadata - ALL points including first and last
            const endPerpAngle = Math.atan2(-ny, -nx);
            const endCapPoints = this.generateCompleteRoundedCap(
                to,             // cap center
                endPerpAngle,   // "radial" direction (perpendicular to line)
                halfWidth,      // cap radius
                false,          // no arc direction for straight lines
                endCapId
            );

            // Add cap points, handling duplicates at connection
            endCapPoints.forEach((point, i) => {
                if (i === 0 && points.length > 0) {
                    const lastPoint = points[points.length - 1];
                    if (Math.abs(point.x - lastPoint.x) < PRECISION &&
                        Math.abs(point.y - lastPoint.y) < PRECISION) {
                        Object.assign(lastPoint, {
                            curveId: point.curveId,
                            segmentIndex: point.segmentIndex,
                            totalSegments: point.totalSegments,
                            t: point.t,
                            isConnectionPoint: true
                        });
                        return;
                    }
                }
                points.push(point);
            });

            // Left side of end
            points.push({ x: to.x + nx, y: to.y + ny });
            return points;
        },
         */

        /**
         * Converts an arc to a polygon, returning a structured object containing points, arcSegments, and curveIds.
         */
        arcToPolygon(arc, width) {
            this.debug(`arcToPolygon called for Arc ${arc.id}, r=${arc.radius.toFixed(3)}, width=${width.toFixed(3)}`);

            const points = [];
            const halfWidth = width / 2;
            const innerR = Math.max(0, arc.radius - halfWidth);
            const outerR = arc.radius + halfWidth;

            const center = arc.center;
            const clockwise = arc.clockwise;
            const startRad = arc.startAngle;
            const endRad = arc.endAngle;

            // Register main curves
            const outerArcId = window.globalCurveRegistry?.register({
                type: 'arc', center: center, radius: outerR, startAngle: startRad, endAngle: endRad,
                clockwise: clockwise, isOffsetDerived: true, source: 'arc_outer'
            });

            const innerArcId = innerR > C.precision.coordinate ? window.globalCurveRegistry?.register({
                type: 'arc', center: center, radius: innerR, startAngle: startRad, endAngle: endRad,
                clockwise: clockwise, isOffsetDerived: true, source: 'arc_inner'
            }) : null;

            const arcSegmentsCount = GeometryTessellation.getOptimalSegments(arc.radius, 'arc');

            // Calculate angular sweep
            let angleSpan = endRad - startRad;
            if (clockwise) { 
                if (angleSpan > 0) angleSpan -= 2 * Math.PI; 
            } else { 
                if (angleSpan < 0) angleSpan += 2 * Math.PI; 
            }

            const outerPoints = [];
            const innerPoints = [];

            // Tessellate the inner and outer paths
            for (let i = 0; i <= arcSegmentsCount; i++) {
                const t = i / arcSegmentsCount; 
                const angle = startRad + angleSpan * t;

                outerPoints.push({ 
                    x: center.x + outerR * Math.cos(angle), 
                    y: center.y + outerR * Math.sin(angle), 
                    curveId: outerArcId, 
                    segmentIndex: i, 
                    totalSegments: arcSegmentsCount + 1, 
                    t: t 
                });

                innerPoints.push({ 
                    x: center.x + innerR * Math.cos(angle), 
                    y: center.y + innerR * Math.sin(angle), 
                    curveId: innerArcId, 
                    segmentIndex: i, 
                    totalSegments: arcSegmentsCount + 1, 
                    t: t 
                });
            }

            const isHole = arc.properties?.polarity === 'clear';
            const arcSegmentsMetadata = [];

            // Assemble the flat-capped polygon
            // Just the outer arc, followed by the reversed inner arc. 
            // The straight lines connecting them at the ends are implicitly created.
            const innerPointsReversed = innerPoints.slice().reverse();

            points.push(...outerPoints);
            points.push(...innerPointsReversed);

            // Metadata mapping
            arcSegmentsMetadata.push({ 
                startIndex: 0, 
                endIndex: outerPoints.length - 1, 
                center: center, 
                radius: outerR, 
                startAngle: startRad, 
                endAngle: endRad, 
                clockwise: clockwise, 
                curveId: outerArcId 
            });

            if (innerR > C.precision.coordinate) {
                arcSegmentsMetadata.push({ 
                    startIndex: outerPoints.length, 
                    endIndex: points.length - 1, 
                    center: center, 
                    radius: innerR, 
                    startAngle: endRad, 
                    endAngle: startRad, 
                    clockwise: !clockwise, 
                    curveId: innerArcId 
                });
            }

            // Deduplicate closure if it's a full 360 loop touching itself
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.hypot(first.x - last.x, first.y - last.y) < C.precision.coordinate) {
                points.pop();
                arcSegmentsMetadata.forEach(a => {
                    if (a.endIndex === points.length) a.endIndex = 0;
                    if (a.startIndex === points.length) a.startIndex = 0;
                });
            }

            const contour = {
                points: points,
                isHole: isHole,
                nestingLevel: 0,
                parentId: null,
                arcSegments: arcSegmentsMetadata,
                curveIds: [outerArcId, innerArcId].filter(Boolean)
            };

            // Ensure correct geometric winding for Clipper
            const constructedAsCW = clockwise;
            const wantCW = isHole;

            if (constructedAsCW !== wantCW) {
                GeometryTopology.reverseContourWinding(contour);
                this.debug('arcToPolygon: reversed winding to match polarity');
            }

            return new PathPrimitive([contour], {
                ...arc.properties,
                wasStroke: true,
                fill: true,
                stroke: false,
                closed: true
            });
        },

        /**
         * This is the central tessellation point for the GeometryProcessor.
         */
        primitiveToPath(primitive, curveIds = []) {
            if (primitive.type === 'path' && !primitive.properties?.isStroke) {
                return primitive;
            }

            const props = primitive.properties || {};
            const isStroke = (props.stroke && !props.fill) || props.isTrace;

            if (isStroke && props.strokeWidth > 0) {
                if (primitive.type === 'arc') {
                    return this.arcToPolygon(primitive, props.strokeWidth);
                } else if (primitive.type === 'path' && primitive.contours?.[0]) {

                    // --- NEW EXPERIMENTAL TRACE-TO-POLYGON METHOD ---
                    // Returns an array of overlapping shapes (circles & rectangles)
                    return this.traceToPolygon(primitive.contours[0], props.strokeWidth, props);

                    /* --- OLD ANALYTIC METHOD (Commented out for development tracking) ---
                    const generatedCurveIds = curveIds.slice();
                    const points = this.polylineToPolygon(
                        primitive.contours[0].points,
                        props.strokeWidth,
                        generatedCurveIds
                    );
                    if (points.length < 3) return null;

                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: generatedCurveIds
                    }], {
                        ...props,
                        wasStroke: true,
                        fill: true,
                        stroke: false,
                        closed: true
                    });
                    ----------------------------------------------------------- */
                }
            }

            // Use toPath for curve-containing primitives
            switch (primitive.type) {
                case 'circle':
                    return GeometryTessellation.circleToPath(primitive);

                case 'obround':
                    return GeometryTessellation.obroundToPath(primitive);

                case 'rectangle': {
                    const isHole = primitive.properties?.polarity === 'clear';
                    const points = GeometryTessellation.rectangleToPoints(primitive, isHole);
                    if (points.length === 0) return null;
                    return new PathPrimitive([{
                        points: points,
                        isHole: isHole,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    }], {
                        ...primitive.properties,
                        originalType: 'rectangle'
                    });
                }

                case 'arc': {
                    const points = this.arcToPoints(primitive);
                    if (points.length === 0) return null;
                    // Preserve arc segment metadata
                    // TODO [ARC-ENCODING] - SPAN arc over the tessellation.
                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [{
                            startIndex: 0,
                            endIndex: points.length - 1,
                            center: primitive.center,
                            radius: primitive.radius,
                            startAngle: primitive.startAngle,
                            endAngle: primitive.endAngle,
                            clockwise: primitive.clockwise
                        }],
                        curveIds: []
                    }], {
                        ...primitive.properties,
                        originalType: 'arc'
                    });
                }

                case 'elliptical_arc': {
                    const points = GeometryTessellation.ellipticalArcToPoints(primitive);
                    if (points.length === 0) return null;
                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    }], {
                        ...primitive.properties,
                        originalType: 'elliptical_arc'
                    });
                }

                case 'bezier': {
                    const points = GeometryTessellation.bezierToPoints(primitive);
                    if (points.length === 0) return null;
                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    }], {
                        ...primitive.properties,
                        originalType: 'bezier'
                    });
                }

                default:
                    console.warn(`[GeoUtils] primitiveToPath: Unknown type ${primitive.type}`);
                    return null;
            }
        },

        /**
         * Analytic primitive → PathPrimitive for ON-PATH work (engrave now,
         * score/drag-knife later). Three contract differences from
         * primitiveToPath, all load-bearing for a cutter that follows the
         * line instead of a boundary:
         *   - stroke width is ignored; primitiveToPath returns the stroke
         *     OUTLINE for stroked arcs and paths, which is a boundary;
         *   - `closed` is never fabricated, so open shapes stay open;
         *   - arcs stay analytic as CHORD arcs (endIndex === startIndex + 1).
         * Bezier and elliptical arcs have no analytic arc form and come back
         * as open tessellated polylines.
         */
        primitiveToCenterlinePath(primitive) {
            if (!primitive) return null;
            const props = primitive.properties || {};

            switch (primitive.type) {
                case 'path':
                    return primitive;

                case 'circle': {
                    const p = {
                        x: primitive.center.x + primitive.radius,
                        y: primitive.center.y
                    };
                    return new PathPrimitive([{
                        points: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }],
                        isFullCircle: true,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [{
                            startIndex: 0,
                            endIndex: 1,
                            center: { x: primitive.center.x, y: primitive.center.y },
                            radius: primitive.radius,
                            startAngle: 0,
                            endAngle: 0,
                            sweepAngle: 2 * Math.PI,
                            clockwise: false
                        }],
                        curveIds: []
                    }], { ...props, originalType: 'circle', closed: true });
                }

                case 'arc': {
                    const full = this.isPrimitiveClosed(primitive, PRECISION);
                    let sweep = primitive.endAngle - primitive.startAngle;
                    if (full) {
                        sweep = primitive.clockwise ? -2 * Math.PI : 2 * Math.PI;
                    } else if (primitive.clockwise && sweep > 0) {
                        sweep -= 2 * Math.PI;
                    } else if (!primitive.clockwise && sweep < 0) {
                        sweep += 2 * Math.PI;
                    }

                    const contour = {
                        points: [
                            { x: primitive.startPoint.x, y: primitive.startPoint.y },
                            { x: primitive.endPoint.x, y: primitive.endPoint.y }
                        ],
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [{
                            startIndex: 0,
                            endIndex: 1,
                            center: { x: primitive.center.x, y: primitive.center.y },
                            radius: primitive.radius,
                            startAngle: primitive.startAngle,
                            endAngle: primitive.endAngle,
                            sweepAngle: sweep,
                            clockwise: primitive.clockwise
                        }],
                        curveIds: []
                    };
                    if (full) contour.isFullCircle = true;

                    return new PathPrimitive([contour], {
                        ...props, originalType: 'arc', closed: full
                    });
                }

                case 'rectangle': {
                    const points = GeometryTessellation.rectangleToPoints(primitive, false);
                    if (points.length === 0) return null;
                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    }], { ...props, originalType: 'rectangle', closed: true });
                }

                case 'obround':
                    return GeometryTessellation.obroundToPath(primitive);

                case 'bezier':
                case 'elliptical_arc': {
                    const points = (primitive.type === 'bezier')
                        ? GeometryTessellation.bezierToPoints(primitive)
                        : GeometryTessellation.ellipticalArcToPoints(primitive);
                    if (!points || points.length < 2) return null;
                    return new PathPrimitive([{
                        points: points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    }], { ...props, originalType: primitive.type, closed: false });
                }

                default:
                    console.warn(`[GeoUtils] primitiveToCenterlinePath: unsupported type ${primitive.type}`);
                    return null;
            }
        },

        /**
         * Returns a new primitive with all coordinates transformed by an
         * affine matrix { a, b, c, d, e, f }. Preserves circle/obround
         * types under uniform scale or pure translation so drill
         * classification still works. Falls back to PathPrimitive for
         * non-uniform or rotated analytic shapes.
         */
        // REVIEW - Consider if it's worth merging with the transform in the svg parser, replace epsilons and coordinate epsilons with config links like PRECISION
        transformPrimitive(primitive, matrix) {
            if (!primitive || !matrix) return primitive;

            // Identity shortcut
            if (TransformMath.isIdentity(matrix)) {
                return primitive;
            }
            // REVIEW - this is the old version. Is it better or worse to double check identity? It does seem slower but are there any advantages?
            // if (matrix.a === 1 && matrix.b === 0 && matrix.c === 0 &&
            //     matrix.d === 1 && matrix.e === 0 && matrix.f === 0) {
            //     return primitive;
            // }

            const applyPt = (p) => TransformMath.applyToPoint(matrix, p);

            // Detect transform class
            const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
            const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);

            const hasRotation = Math.abs(matrix.b) > 1e-9 || Math.abs(matrix.c) > 1e-9;
            const isTranslationOnly = !hasRotation && Math.abs(scaleX - 1) < 1e-9;

            // Circle: preserve under uniform scale (rotation doesn't matter for circles)
            if (primitive.type === 'circle') {
                return new CirclePrimitive(
                    applyPt(primitive.center),
                    primitive.radius * scaleX,
                    { ...primitive.properties }
                );
            }

            // Obround: preserve under pure translation
            if (primitive.type === 'obround' && isTranslationOnly) {
                return new ObroundPrimitive(
                    applyPt(primitive.position),
                    primitive.width, primitive.height,
                    { ...primitive.properties }
                );
            }

            // Rectangle: preserve under pure translation
            if (primitive.type === 'rectangle' && isTranslationOnly) {
                return new RectanglePrimitive(
                    applyPt(primitive.position),
                    primitive.width, primitive.height,
                    { ...primitive.properties }
                );
            }

            // General case: convert to path, transform all points
            let pathPrim = primitive;
            if (primitive.type !== 'path') {
                pathPrim = this.primitiveToPath(primitive);
                if (!pathPrim) return null;
            }

            const newContours = pathPrim.contours.map(c => {
                const newPoints = c.points.map(p => {
                    const x = matrix.a * p.x + matrix.c * p.y + matrix.e;
                    const y = matrix.b * p.x + matrix.d * p.y + matrix.f;
                    // Single-literal construction keeps every point on ONE
                    // V8 hidden class (no post-hoc property additions).
                    if (p.curveId > 0) {
                        return {
                            x, y,
                            curveId: p.curveId,
                            segmentIndex: p.segmentIndex,
                            totalSegments: p.totalSegments,
                            t: p.t
                        };
                    }
                    return { x, y };
                });

                // Helper: transform an angle through the linear part of the matrix
                const transformAngle = (angle) => {
                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);
                    const newX = matrix.a * cosA + matrix.c * sinA;
                    const newY = matrix.b * cosA + matrix.d * sinA;
                    return Math.atan2(newY, newX);
                };

                const det = matrix.a * matrix.d - matrix.b * matrix.c;

                const newArcs = (c.arcSegments || []).map(a => {
                    const newArc = {
                        ...a,
                        center: applyPt(a.center),
                        radius: a.radius * scaleX, // exact: UI scale is always uniform (sx===sy); elliptical (non-uniform) arcs are intentionally unsupported — see transformPrimitive header
                        startPoint: a.startPoint ? applyPt(a.startPoint) : undefined,
                        endPoint: a.endPoint ? applyPt(a.endPoint) : undefined
                    };

                    // Transform angles through the matrix
                    if (a.startAngle !== undefined) newArc.startAngle = transformAngle(a.startAngle);
                    if (a.endAngle !== undefined) newArc.endAngle = transformAngle(a.endAngle);

                    // Reflections flip arc winding and sweep direction
                    if (det < 0) {
                        newArc.clockwise = !a.clockwise;
                        if (a.sweepAngle !== undefined) newArc.sweepAngle = -a.sweepAngle;
                    }

                    return newArc;
                });

                // Non-uniform or reflective transforms may flip winding
                let isHole = c.isHole;
                if (det < 0) isHole = !isHole; // Reflection flips winding

                return {
                    points: newPoints,
                    isHole: isHole,
                    isFullCircle: c.isFullCircle,
                    nestingLevel: c.nestingLevel || 0,
                    parentId: c.parentId || null,
                    arcSegments: newArcs,
                    curveIds: c.curveIds ? [...c.curveIds] : []
                };
            });

            const result = new PathPrimitive(newContours, {
                ...pathPrim.properties,
                wasTransformed: true
            });

            if (pathPrim.curveIds) result.curveIds = [...pathPrim.curveIds];
            return result;
        },

        /**
         * Squared perpendicular distance from point p to line segment p1→p2.
         * Used by Douglas-Peucker simplification.
         */
        getSqDistToSegment(p, p1, p2) {
            let x = p1.x, y = p1.y;
            let dx = p2.x - x, dy = p2.y - y;

            if (dx !== 0 || dy !== 0) {
                const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
                if (t > 1) {
                    x = p2.x; y = p2.y;
                } else if (t > 0) {
                    x += dx * t; y += dy * t;
                }
            }

            dx = p.x - x;
            dy = p.y - y;
            return dx * dx + dy * dy;
        },

        /**
         * Non-recursive Douglas-Peucker simplification.
         * @param {Array} points - Array of {x,y} points.
         * @param {number} sqTolerance - Squared distance tolerance.
         * @param {Set} [protectedIndices] - Indices that must survive (e.g. arc endpoints).
         * @returns {Object} { points, indexMap } where indexMap[oldIndex] = newIndex or -1.
         */
        simplifyPolyline2D(points, sqTolerance, protectedIndices = null) {
            const len = points.length;
            if (len < 3) return { points: points.slice(), indexMap: points.map((_, i) => i) };

            const markers = new Uint8Array(len);
            markers[0] = 1;
            markers[len - 1] = 1;

            // Mark all protected indices
            if (protectedIndices) {
                for (const idx of protectedIndices) {
                    if (idx >= 0 && idx < len) markers[idx] = 1;
                }
            }

            const stack = [[0, len - 1]];

            while (stack.length > 0) {
                const [first, last] = stack.pop();

                let maxSqDist = 0;
                let index = first;

                for (let i = first + 1; i < last; i++) {
                    const sqDist = this.getSqDistToSegment(points[i], points[first], points[last]);
                    if (sqDist > maxSqDist) {
                        index = i;
                        maxSqDist = sqDist;
                    }
                }

                if (maxSqDist > sqTolerance) {
                    markers[index] = 1;
                    if (index - first > 1) stack.push([first, index]);
                    if (last - index > 1) stack.push([index, last]);
                }
            }

            const newPoints = [];
            const indexMap = new Array(len).fill(-1);

            for (let i = 0; i < len; i++) {
                if (markers[i]) {
                    indexMap[i] = newPoints.length;
                    newPoints.push(points[i]);
                }
            }

            return { points: newPoints, indexMap };
        },
        
        /**
         * Ray-casting point-in-polygon test.
         * Uses the Jordan curve theorem: a ray from the point crosses the boundary an odd number of times iff the point is inside.
         */
        // REVIEW - this sounds very topological? Shouldn't this be in GeometryTopology?
        pointInPolygon(point, polygon) {
            if (!polygon || polygon.length < 3) return false;

            let inside = false;
            const n = polygon.length;

            for (let i = 0, j = n - 1; i < n; j = i++) {
                const xi = polygon[i].x, yi = polygon[i].y;
                const xj = polygon[j].x, yj = polygon[j].y;

                if (((yi > point.y) !== (yj > point.y)) &&
                    (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                }
            }

            return inside;
        },

        /**
         * Returns a representative interior point for a primitive.
         * Uses the geometric centroid of the first contour's vertices.
         * For convex shapes (circles, rectangles, obrounds) the centroid is always interior. For concave shapes the centroid is a practical approximation that works for all standard PCB primitives.
         */
        getRepresentativePoint(primitive) {
            const points = primitive.contours?.[0]?.points;
            if (points && points.length >= 3) {
                let sumX = 0, sumY = 0;
                for (let i = 0; i < points.length; i++) {
                    sumX += points[i].x;
                    sumY += points[i].y;
                }
                return { x: sumX / points.length, y: sumY / points.length };
            }
            // Fallback for analytic primitives that somehow survived without contours
            if (primitive.center) return { ...primitive.center };
            const bounds = primitive.getBounds();
            if (bounds && isFinite(bounds.minX)) {
                return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
            }
            return null;
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GeometryUtils] ${message}`, data)
                 : console.log(`[GeometryUtils] ${message}`);
        }
    };

    window.GeometryUtils = GeometryUtils;
})();