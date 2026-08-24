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
            const ra = this.find(a), rb = this.find(b);
            if (ra === rb) return;
            if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
            else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
            else { this.parent[rb] = ra; this.rank[ra]++; }
        }
    }

    const GeometryUtils = {
        calculateSegments(radius, targetLength, minSegments, maxSegments) {
            const minSeg = C.geometry.segments.defaultMinSegments;
            // For zero/negative radius, return the minimum valid count.
            if (radius <= 0) {
                return Math.max(minSeg, Math.ceil(minSegments / minSeg) * minSeg);
            }

            // Adjust boundaries to be multiples of 8, ensuring a valid range.
            const min = Math.max(minSeg, Math.ceil(minSegments / minSeg) * minSeg);
            const max = Math.floor(maxSegments / minSeg) * minSeg;

            // If adjusted boundaries are invalid (e.g., min > max), return the minimum.
            if (min > max) {
                return min;
            }

            const circumference = 2 * Math.PI * radius;
            const desiredSegments = circumference / targetLength;

            // Round the ideal segment count to the nearest multiple of 8.
            let calculatedSegments = Math.round(desiredSegments / minSeg) * minSeg;

            // Clamp the result within the adjusted boundaries. The final value will always be a multiple of 8 within the valid range.
            const finalSegments = Math.max(min, Math.min(max, calculatedSegments));

            return finalSegments;
        },

        // Tessellation helpers
        tessellateCubicBezier(p0, p1, p2, p3) {
            const a = [], t = C.geometry.tessellation.bezierSegments ?? 32; // 't' is segment count
            // This loop starts at 0, so it *includes* the start point
            for (let s = 0; s <= t; s++) {
                const e = s / t, o = 1 - e;
                a.push({
                    x: o * o * o * p0.x + 3 * o * o * e * p1.x + 3 * o * e * e * p2.x + e * e * e * p3.x,
                    y: o * o * o * p0.y + 3 * o * o * e * p1.y + 3 * o * e * e * p2.y + e * e * e * p3.y
                })
            }
            return a;
        },

        tessellateQuadraticBezier(p0, p1, p2) {
            const a = [], t = C.geometry.tessellation.bezierSegments ?? 32;
            // This loop starts at 0, so it *includes* the start point
            for (let s = 0; s <= t; s++) {
                const e = s / t, o = 1 - e;
                a.push({
                    x: o * o * p0.x + 2 * o * e * p1.x + e * e * p2.x,
                    y: o * o * p0.y + 2 * o * e * p1.y + e * e * p2.y
                })
            }
            return a;
        },

        tessellateEllipticalArc(p1, p2, rx, ry, phi, fA, fS) {
            // SVG arc-to-centerpoint conversion logic
            const a = Math.sin(phi * Math.PI / 180), s = Math.cos(phi * Math.PI / 180), e = (p1.x - p2.x) / 2, o = (p1.y - p2.y) / 2, r = s * e + a * o, h = -a * e + s * o;
            rx = Math.abs(rx); ry = Math.abs(ry);
            let c = r * r / (rx * rx) + h * h / (ry * ry);
            if (c > 1) { rx *= Math.sqrt(c); ry *= Math.sqrt(c) }
            const l = (rx * rx * ry * ry - rx * rx * h * h - ry * ry * r * r) / (rx * rx * h * h + ry * ry * r * r), d = (fA === fS ? -1 : 1) * Math.sqrt(Math.max(0, l)), M = d * (rx * h / ry), g = d * (-ry * r / rx), x = s * M - a * g + (p1.x + p2.x) / 2, y = a * M + s * g + (p1.y + p2.y) / 2;
            const I = (t, p) => { const i = t[0] * p[1] - t[1] * p[0] < 0 ? -1 : 1; const dot = (t[0] * p[0] + t[1] * p[1]) / (Math.sqrt(t[0] * t[0] + t[1] * t[1]) * Math.sqrt(p[0] * p[0] + p[1] * p[1])); return i * Math.acos(Math.max(-1, Math.min(1, dot)));};
            const u = I([1, 0], [(r - M) / rx, (h - g) / ry]);
            let m = I([(r - M) / rx, (h - g) / ry], [(-r - M) / rx, (-h - g) / ry]);
            0 === fS && m > 0 ? m -= 2 * Math.PI : 1 === fS && m < 0 && (m += 2 * Math.PI);

            const targetLength = C.geometry.segments.targetLength;
            const approxArcLength = Math.abs(m) * ((rx + ry) / 2);
            const minSegs = C.geometry.tessellation.minEllipticalSegments;
            const k = Math.max(minSegs, Math.ceil(approxArcLength / targetLength));

            const P = [];
            // This loop starts at 0, so it *includes* the start point
            for (let t = 0; t <= k; t++) { 
                const i = u + m * t / k, e_cos = Math.cos(i), o_sin = Math.sin(i);
                P.push({
                    x: x + rx * (s * e_cos - a * o_sin),
                    y: y + ry * (a * e_cos + s * o_sin)
                })
            }
            return P;
        },

        // Converts a circle to a PathPrimitive with arc segment metadata.
        circleToPath(primitive) {
            const segments = this.getOptimalSegments(primitive.radius, 'circle');
            const points = [];
            const arcSegments = [];

            const isHole = primitive.properties?.polarity === 'clear';
            const directionMult = isHole ? -1 : 1; // CW for holes (-1), CCW for outers (+1) in Y-up

            // Register circle curve
            let curveId = null;
            if (window.globalCurveRegistry) {
                curveId = window.globalCurveRegistry.register({
                    type: 'circle',
                    center: { x: primitive.center.x, y: primitive.center.y },
                    radius: primitive.radius,
                    clockwise: isHole,
                    source: 'circle_to_path'
                });
            }

            // Generate points natively in correct winding
            for (let i = 0; i < segments; i++) {
                // Base 2*PI prevents negative angle wrap issues
                const angle = (2 * Math.PI + (directionMult * (i / segments) * 2 * Math.PI)) % (2 * Math.PI);
                const nextAngle = (2 * Math.PI + (directionMult * ((i + 1) % segments / segments) * 2 * Math.PI)) % (2 * Math.PI);

                points.push({
                    x: primitive.center.x + primitive.radius * Math.cos(angle),
                    y: primitive.center.y + primitive.radius * Math.sin(angle),
                    curveId: curveId,
                    segmentIndex: i,
                    totalSegments: segments,
                    t: i / segments
                });

                arcSegments.push({
                    startIndex: i,
                    endIndex: (i + 1) % segments,
                    center: { x: primitive.center.x, y: primitive.center.y },
                    radius: primitive.radius,
                    startAngle: angle,
                    endAngle: nextAngle,
                    clockwise: isHole,
                    curveId: curveId
                });
            }

            const contour = {
                points: points,
                isHole: primitive.properties?.polarity === 'clear',
                nestingLevel: 0,
                parentId: null,
                arcSegments: arcSegments,
                curveIds: curveId ? [curveId] : []
            };

            return new PathPrimitive([contour], {
                ...primitive.properties,
                originalType: 'circle',
                closed: true,
                fill: true
            });
        },

        // Converts an obround to a PathPrimitive with arc metadata for the semicircular caps.
        // TODO [ARC-ENCODING] - cap arcs are SPAN arcs over capSegs points.
        obroundToPath(primitive) {
            const { x, y } = primitive.position;
            const w = primitive.width;
            const h = primitive.height;
            const r = Math.min(w, h) / 2;

            if (r <= PRECISION) return null;

            const isHorizontal = w > h;
            const points = [];
            const arcSegments = [];
            const curveIds = [];

            // Determine cap centers
            let cap1Center, cap2Center;
            if (isHorizontal) {
                const cy = y + h / 2;
                cap1Center = { x: x + r, y: cy };
                cap2Center = { x: x + w - r, y: cy };
            } else {
                const cx = x + w / 2;
                cap1Center = { x: cx, y: y + r };
                cap2Center = { x: cx, y: y + h - r };
            }

            // Register caps
            const cap1Id = window.globalCurveRegistry?.register({
                type: 'arc', center: cap1Center, radius: r,
                clockwise: false, source: 'obround_cap1'
            });
            const cap2Id = window.globalCurveRegistry?.register({
                type: 'arc', center: cap2Center, radius: r,
                clockwise: false, source: 'obround_cap2'
            });
            if (cap1Id) curveIds.push(cap1Id);
            if (cap2Id) curveIds.push(cap2Id);

            const capSegs = Math.max(8, Math.floor(this.getOptimalSegments(r, 'arc') / 2));

            const isHole = primitive.properties?.polarity === 'clear';

            if (isHorizontal) {
                if (isHole) {
                    // CW (Hole)
                    points.push({ x: x + r, y: y + h });
                    points.push({ x: x + w - r, y: y + h });

                    const cap2Start = points.length - 1;
                    for (let i = 1; i <= capSegs; i++) {
                        const angle = Math.PI / 2 - (Math.PI * i / capSegs);
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({ startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r, startAngle: Math.PI / 2, endAngle: -Math.PI / 2, clockwise: true, curveId: cap2Id });

                    points.push({ x: x + r, y: y });

                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = -Math.PI / 2 - (Math.PI * i / capSegs);
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({ startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r, startAngle: -Math.PI / 2, endAngle: -3 * Math.PI / 2, clockwise: true, curveId: cap1Id });
                } else {
                    // CCW (Outer)
                    points.push({ x: x + r, y: y });
                    points.push({ x: x + w - r, y: y });

                    const cap2Start = points.length - 1;
                    for (let i = 1; i <= capSegs; i++) {
                        const angle = -Math.PI / 2 + (Math.PI * i / capSegs);
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({ startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, clockwise: false, curveId: cap2Id });

                    points.push({ x: x + r, y: y + h });

                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = Math.PI / 2 + (Math.PI * i / capSegs);
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({ startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r, startAngle: Math.PI / 2, endAngle: 3 * Math.PI / 2, clockwise: false, curveId: cap1Id });
                }
            } else {
                if (isHole) {
                    // CW (Hole)
                    points.push({ x: x, y: y + r });
                    points.push({ x: x, y: y + h - r });

                    const cap2Start = points.length - 1;
                    for (let i = 1; i <= capSegs; i++) {
                        const angle = Math.PI - (Math.PI * i / capSegs);
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({ startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r, startAngle: Math.PI, endAngle: 0, clockwise: true, curveId: cap2Id });

                    points.push({ x: x + w, y: y + r });

                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = 0 - (Math.PI * i / capSegs);
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({ startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r, startAngle: 0, endAngle: -Math.PI, clockwise: true, curveId: cap1Id });
                } else {
                    // CCW (Outer)
                    points.push({ x: x + w, y: y + r });
                    points.push({ x: x + w, y: y + h - r });

                    const cap2Start = points.length - 1;
                    for (let i = 1; i <= capSegs; i++) {
                        const angle = 0 + (Math.PI * i / capSegs);
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({ startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r, startAngle: 0, endAngle: Math.PI, clockwise: false, curveId: cap2Id });

                    points.push({ x: x, y: y + r });

                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = Math.PI + (Math.PI * i / capSegs);
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({ startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r, startAngle: Math.PI, endAngle: 3 * Math.PI, clockwise: false, curveId: cap1Id });
                }
            }

            const contour = {
                points: points,
                isHole: isHole,
                nestingLevel: 0,
                parentId: null,
                arcSegments: arcSegments,
                curveIds: curveIds
            };

            return new PathPrimitive([contour], {
                ...primitive.properties,
                originalType: 'obround',
                closed: true,
                fill: true
            });
        },

        rectangleToPoints(primitive, isHole = false) {
            const { x, y } = primitive.position, w = primitive.width, h = primitive.height;
            // Clipper2 Y-Up Standard:
            // CCW (Outer): Bottom-Left -> Bottom-Right -> Top-Right -> Top-Left
            // CW (Hole): Bottom-Left -> Top-Left -> Top-Right -> Bottom-Right
            if (isHole) {
                return [
                    { x: x, y: y },         // Bottom-left
                    { x: x, y: y + h },     // Top-left
                    { x: x + w, y: y + h }, // Top-right
                    { x: x + w, y: y },     // Bottom-right
                ];
            } else {
                return [
                    { x: x, y: y },         // Bottom-left
                    { x: x + w, y: y },     // Bottom-right
                    { x: x + w, y: y + h }, // Top-right
                    { x: x, y: y + h },     // Top-left
                ];
            }
        },

        arcToPoints(primitive) {
            const start = primitive.startPoint;
            const end = primitive.endPoint;
            const center = primitive.center;
            const clockwise = primitive.clockwise;
            
            const radius = Math.sqrt(
                Math.pow(start.x - center.x, 2) +
                Math.pow(start.y - center.y, 2)
            );
            
            const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
            const endAngle = Math.atan2(end.y - center.y, end.x - center.x);

            let angleSpan = endAngle - startAngle;
            if (clockwise) {
                if (angleSpan > 0) angleSpan -= 2 * Math.PI; // CW = negative sweep in Y-up
            } else {
                if (angleSpan < 0) angleSpan += 2 * Math.PI; // CCW = positive sweep in Y-up
            }

            const segments = this.getOptimalSegments(radius, 'arc');

            const points = [];
            for (let i = 0; i <= segments; i++) {
                const angle = startAngle + angleSpan * (i / segments);
                points.push({
                    x: center.x + radius * Math.cos(angle),
                    y: center.y + radius * Math.sin(angle)
                });
            }

            return points;
        },

        bezierToPoints(primitive) {
            if (primitive.points.length === 4) {
                return this.tessellateCubicBezier(...primitive.points);
            } else if (primitive.points.length === 3) {
                return this.tessellateQuadraticBezier(...primitive.points);
            }
            return [];
        },

        ellipticalArcToPoints(primitive) {
            return this.tessellateEllipticalArc(
                primitive.startPoint,
                primitive.endPoint,
                primitive.rx,
                primitive.ry,
                primitive.phi,
                primitive.fA,
                primitive.fS
            );
        },

        /**
         * PIPELINE tessellation. Feeds Clipper and then ArcReconstructor,
         * which recovers analytic arcs from these points - the 0.01mm
         * targetLength is an input contract for that recovery, not a quality
         * preference. Display tessellation is a different rule entirely:
         * see renderer3d-toolpath.js arcSegmentCount (sagitta-bounded).
         */
        getOptimalSegments(radius, type) {
            const config = C.geometry.segments;
            const finalTargetLength = config.targetLength;

            let finalMin, finalMax;

            if (type === 'circle') {
                finalMin = config.minCircle;
                finalMax = config.maxCircle;
            } else if (type === 'arc') {
                finalMin = config.minArc;
                finalMax = config.maxArc;
            } else if (type === 'end_cap') {
                finalMin = config.minEndCap;
                finalMax = config.maxEndCap;
            } else {
                // Default fallback
                finalMin = config.defaultFallbackSegments.min;
                finalMax = config.defaultFallbackSegments.max;
            }

            return this.calculateSegments(
                radius, 
                finalTargetLength, 
                finalMin,
                finalMax
            );
        },

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

                const circlePath = this.circleToPath(circlePrim);
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
                const circlePath = this.circleToPath(circlePrim);
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
                const segments = this.getOptimalSegments(halfWidth, 'circle');
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

            const arcSegmentsCount = this.getOptimalSegments(arc.radius, 'arc');

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
                this.reverseContourWinding(contour);
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

        /** generateCompleteRoundedCap, generateJoin and rotatePoint are only called by polylineToPolygon which has been deprecated. This can remain a comment until analytic development is restarted, deployment will remove it.
        // Generate complete rounded cap with boundary points tagged.
        // Intermediate points snap to the canonical circle grid (k x 2π/N) so that where a cap overlaps a full circle of the same center+radius, tessellation points coincide exactly — preventing zig-zag intersection artifacts that strip Z metadata in Clipper2 booleans.
        generateCompleteRoundedCap(center, radialAngle, radius, clockwiseArc, curveId) {
            const points = [];

            // Canonical grid: identical to circleToPath's angular spacing
            const fullSegments = this.getOptimalSegments(radius, 'circle');
            const gridStep = (2 * Math.PI) / fullSegments;

            // Cap sweep: π radians in the parent arc's winding direction
            const sweepDir = clockwiseArc ? -1 : 1; // CW = negative angle progression in Y-up
            const capEndAngle = radialAngle + sweepDir * Math.PI;

            // Exact start point (boundary — may not be on grid)
            points.push({
                x: center.x + radius * Math.cos(radialAngle),
                y: center.y + radius * Math.sin(radialAngle),
                curveId: curveId,
                segmentIndex: 0,
                totalSegments: fullSegments,
                t: 0,
                isConnectionPoint: true
            });

            // Collect canonical grid angles strictly inside the cap sweep
            const gridPoints = [];
            const margin = gridStep * 0.01;

            for (let k = 0; k < fullSegments; k++) {
                const gridAngle = k * gridStep;

                // Angular distance from cap start in the sweep direction
                let delta = sweepDir * (gridAngle - radialAngle);
                // Normalize to [0, 2π)
                delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

                // Accept if strictly inside (0, π) — excludes start/end boundaries
                if (delta > margin && delta < Math.PI - margin) {
                    gridPoints.push({ angle: gridAngle, delta: delta });
                }
            }

            // Sort by traversal order along the sweep
            gridPoints.sort((a, b) => a.delta - b.delta);

            // Emit grid-aligned intermediate points
            for (let i = 0; i < gridPoints.length; i++) {
                const ga = gridPoints[i];
                points.push({
                    x: center.x + radius * Math.cos(ga.angle),
                    y: center.y + radius * Math.sin(ga.angle),
                    curveId: curveId,
                    segmentIndex: i + 1,
                    totalSegments: fullSegments,
                    t: ga.delta / Math.PI
                });
            }

            // Exact end point (boundary — may not be on grid)
            points.push({
                x: center.x + radius * Math.cos(capEndAngle),
                y: center.y + radius * Math.sin(capEndAngle),
                curveId: curveId,
                segmentIndex: gridPoints.length + 1,
                totalSegments: fullSegments,
                t: 1.0,
                isConnectionPoint: true
            });

            return points;
        },

        // Generate join between segments
        generateJoin(p0, p1, p2, halfWidth) {
            const dx1 = p1.x - p0.x;
            const dy1 = p1.y - p0.y;
            const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

            const dx2 = p2.x - p1.x;
            const dy2 = p2.y - p1.y;
            const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

            if (len1 < PRECISION || len2 < PRECISION) {
                return {
                    left: { x: p1.x - halfWidth, y: p1.y },
                    right: { x: p1.x + halfWidth, y: p1.y }
                };
            }

            const u1x = dx1 / len1;
            const u1y = dy1 / len1;
            const u2x = dx2 / len2;
            const u2y = dy2 / len2;

            const n1x = -u1y * halfWidth;
            const n1y = u1x * halfWidth;
            const n2x = -u2y * halfWidth;
            const n2y = u2x * halfWidth;

            // Miter join
            const miterX = (n1x + n2x) / 2;
            const miterY = (n1y + n2y) / 2;

            const miterLen = Math.sqrt(miterX * miterX + miterY * miterY);
            const miterLimit = D.geometry.offsetting.miterLimit ;
            const maxMiter = halfWidth * miterLimit;

            if (miterLen > maxMiter) {
                const scale = maxMiter / miterLen;
                return {
                    left: { x: p1.x + miterX * scale, y: p1.y + miterY * scale },
                    right: { x: p1.x - miterX * scale, y: p1.y - miterY * scale }
                };
            }

            return {
                left: { x: p1.x + miterX, y: p1.y + miterY },
                right: { x: p1.x - miterX, y: p1.y - miterY }
            };
        },

        rotatePoint(point, angleRad, origin = { x: 0, y: 0 }) {
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);
            const dx = point.x - origin.x;
            const dy = point.y - origin.y;
            return {
                x: origin.x + (dx * cos - dy * sin),
                y: origin.y + (dx * sin + dy * cos)
            };
        },
        */

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

                    /* --- OLD METHOD (Commented out for development tracking) ---
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
                    return this.circleToPath(primitive);

                case 'obround':
                    return this.obroundToPath(primitive);

                case 'rectangle': {
                    const isHole = primitive.properties?.polarity === 'clear';
                    const points = this.rectangleToPoints(primitive, isHole);
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
                    const points = this.ellipticalArcToPoints(primitive);
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
                    const points = this.bezierToPoints(primitive);
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
                    const points = this.rectangleToPoints(primitive, false);
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
                    return this.obroundToPath(primitive);

                case 'bezier':
                case 'elliptical_arc': {
                    const points = (primitive.type === 'bezier')
                        ? this.bezierToPoints(primitive)
                        : this.ellipticalArcToPoints(primitive);
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

        /**
         * Converts a collection of unorganized, open segments into a single, ordered closed PathPrimitive.
         * Enforces CCW winding (Y-Up standard for outer boundaries) and guarantees curve metadata is mapped correctly.
         */
        mergeSegmentsIntoClosedPath(segments, forceClose = false, customTolerance = null) {
            if (!segments || segments.length < 2) return { success: false };

            this.debug('Merge input:', segments.map((s, i) => `[${i}] ${s.type}`).join(', '));

            // ==========================================
            // NORMALIZE ENDPOINTS
            // ==========================================
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
            }).filter(e => e.start && e.end);

            if (edges.length === 0) return { success: false };

            // ==========================================
            // GREEDY CHAINING (Robust Distance Matching)
            // ==========================================
            const chain = [];
            edges[0].used = true;
            chain.push({ edge: edges[0], dir: 'forward' });

            let head = edges[0].start; // Front of the chain
            let tail = edges[0].end;   // End of the chain

            // Apply the custom tolerance if provided
            const chainTolerance = customTolerance !== null ? customTolerance : (forceClose ? 0.5 : PRECISION);
            const chainTolSq = chainTolerance * chainTolerance;

            let added = true;
            let gapCount = 0;
            let maxGap = 0;

            while (added && chain.length < edges.length) {
                added = false;
                let bestMatch = null;
                let bestDistSq = chainTolSq;
                let bestDir = 'forward';

                // --- Search against TAIL ---
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

                // --- Search against HEAD ---
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

            // ==========================================
            // GAP / CHAIN ANALYSIS
            // ==========================================
            const unchainedCount = edges.length - chain.length;
            const gapDistance = Math.hypot(head.x - tail.x, head.y - tail.y);
            const isClosed = gapDistance <= chainTolerance;
            const isFullyChained = unchainedCount === 0;

            if (gapDistance > PRECISION) gapCount++;
            maxGap = Math.max(maxGap, gapDistance);

            if (!isClosed || !isFullyChained) {
                if (!isFullyChained) {
                    if (!forceClose) {
                        return { success: false, isOpen: true, gapDistance, unchainedCount, totalSegments: edges.length, chainedCount: chain.length, gapCount, maxGap };
                    }
                } else if (!isClosed) {
                    if (!forceClose) {
                        return { success: false, isOpen: true, gapDistance, unchainedCount: 0, totalSegments: edges.length, chainedCount: chain.length, gapCount, maxGap };
                    }
                }
            }

            // ==========================================
            // POINT ASSEMBLY & METADATA HARVESTING
            // ==========================================
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
                        clockwise: isCW
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
                rawArcs.forEach(arc => {
                    if (arc.startIndex === lastIdx) arc.startIndex = 0;
                    if (arc.endIndex === lastIdx) arc.endIndex = 0;
                });
            }

            // ==========================================
            // WINDING ENFORCEMENT
            // ==========================================
            const winding = this.calculateWinding(rawPoints);
            if (winding < 0) { // CW area -> Reverse array and mirror arcs to make it CCW
                const n = rawPoints.length;
                rawPoints.reverse();

                rawArcs.forEach(arc => {
                    // Mirror indices to the reversed array
                    let newStart = (n - 1) - arc.endIndex;
                    let newEnd = (n - 1) - arc.startIndex;
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

            // ==========================================
            // SWEEP CALCULATION, REGISTRATION & TAGGING
            // ==========================================
            const finalArcSegments = [];
            for (const arc of rawArcs) {
                let sweep = arc.endAngle - arc.startAngle;
                while (sweep > Math.PI) sweep -= 2 * Math.PI;
                while (sweep < -Math.PI) sweep += 2 * Math.PI;

                if (arc.clockwise && sweep > 0) sweep -= 2 * Math.PI;
                else if (!arc.clockwise && sweep < 0) sweep += 2 * Math.PI;

                arc.sweepAngle = sweep;

                let curveId = null;
                if (window.globalCurveRegistry) {
                    curveId = window.globalCurveRegistry.register({
                        type: 'arc',
                        center: arc.center,
                        radius: arc.radius,
                        startAngle: arc.startAngle,
                        endAngle: arc.endAngle,
                        clockwise: arc.clockwise,
                        source: 'stitched_cutout'
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
                curveIds: finalArcSegments.map(s => s.curveId).filter(Boolean)
            }], {
                isCutout: true,
                fill: true,
                stroke: false,
                closed: true,
                mergedFromSegments: segments.length,
                polarity: 'dark'
            });

            return {
                success: true,
                primitive: primitive,
                isOpen: !isClosed,
                gapDistance: gapDistance,
                unchainedCount: unchainedCount,
                wasForceClosed: forceClose && !isClosed,
                totalSegments: edges.length,
                chainedCount: chain.length,
                gapCount: gapCount,
                maxGap: maxGap
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
                    if (dist > tolerance) { 
                        gaps.push(dist);
                    }
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

        /**
         * Expands arc segments in a contour into tessellated polyline points.
         * Returns a new contour with no arc metadata — pure polygon suitable for Clipper2.
         * The original contour is not modified.
         *
         * contour.arcSegments carries TWO encodings and they are not
         * interchangeable - they state different things about contour.points:
         *   SPAN  (obroundToPath, primitiveToPath 'arc', circleToPath):
         *         endIndex is beyond startIndex + 1. points is a COMPLETE
         *         tessellated polygon; arcSegments is analytic annotation on top.
         *         Safe to hand straight to Clipper, computeBounds, canvas fill
         *         and the SVG exporters.
         *   CHORD (parsers, ArcReconstructor.reconstructSingleContour):
         *         endIndex === startIndex + 1, no points between. The
         *         tessellation was DROPPED. points alone is lossy and every
         *         consumer must come through here or read arcSegments itself.
         * This function accepts both and re-tessellates either way, so a span's
         * interior points are redundant for this consumer specifically - that is
         * not a licence to emit chord where a raw points reader is downstream.
         */
        // TODO [ARC-ENCODING] - contour.arcSegments has two encodings: CHORD
        // (endIndex === startIndex + 1, no points between) and SPAN (endIndex
        // beyond that, intermediate points are tessellation the arc replaces).
        // This function and both renderers accept either; parsers and the
        // reconstructor emit only chord. Collapse to chord-only once
        // obroundToPath and primitiveToPath's arc case stop emitting spans.
        contourArcsToPath(contour) {
            if (!contour.arcSegments || contour.arcSegments.length === 0) {
                return contour;
            }

            const arcMap = new Map();
            contour.arcSegments.forEach(arc => arcMap.set(arc.startIndex, arc));

            const newPoints = [];
            let i = 0;

            while (i < contour.points.length) {
                const arc = arcMap.get(i);

                if (arc) {
                    // Push the arc start point
                    newPoints.push(contour.points[i]);

                    // Compute sweep from metadata
                    let sweep = arc.sweepAngle;
                    if (sweep === undefined) {
                        sweep = arc.endAngle - arc.startAngle;
                        if (arc.clockwise && sweep > 0) sweep -= 2 * Math.PI;
                        else if (!arc.clockwise && sweep < 0) sweep += 2 * Math.PI;
                    }

                    // Generate intermediate tessellation points
                    const fullCircleSegments = this.getOptimalSegments(arc.radius, 'arc');
                    const sweepProportion = Math.abs(sweep) / (2 * Math.PI);
                    const segments = Math.max(2, Math.ceil(fullCircleSegments * sweepProportion));

                    for (let s = 1; s < segments; s++) {
                        const angle = arc.startAngle + sweep * (s / segments);
                        newPoints.push({
                            x: arc.center.x + arc.radius * Math.cos(angle),
                            y: arc.center.y + arc.radius * Math.sin(angle),
                            curveId: arc.curveId,       // Propagate ID for Z-packing
                            segmentIndex: s,            // Required for ArcReconstructor sorting
                            totalSegments: segments,
                            t: s / segments
                        });
                    }
                    i = arc.endIndex;
                    if (i === 0) break; // Wrapping arc — point[0] already in newPoints
                } else {
                    newPoints.push(contour.points[i]);
                    i++;
                }
            }

            return {
                points: newPoints,
                isHole: contour.isHole,
                nestingLevel: contour.nestingLevel,
                parentId: contour.parentId,
                arcSegments: [],
                curveIds: contour.curveIds || []
            };
        },

        assembleCutoutCompounds(topologyResults) {
            const outers = topologyResults.filter(r => !r.isHole);
            const holes = topologyResults.filter(r => r.isHole);
            const compounds = [];

            for (const outer of outers) {
                const children = holes.filter(h => h.parentIdx === outer.originalIdx);
                const contours = [];

                // Push all the inner holes FIRST
                for (const child of children) {
                    const hc = child.loop.contours[0];
                    contours.push({
                        points: hc.points, isHole: true, nestingLevel: 1,
                        parentId: null,
                        arcSegments: hc.arcSegments || [], curveIds: hc.curveIds || []
                    });
                }

                // Push the outer boundary LAST
                contours.push({
                    points: outer.loop.contours[0].points,
                    isHole: false, nestingLevel: 0, parentId: null,
                    arcSegments: outer.loop.contours[0].arcSegments || [],
                    curveIds: outer.loop.contours[0].curveIds || []
                });

                compounds.push(new PathPrimitive(contours, {
                    isCutout: true, fill: true, stroke: false, closed: true, polarity: 'dark'
                }));

                this.debug(`Compound cutout: ${children.length} hole(s) + 1 outer`);
            }

            return compounds;
        },

        isPrimitiveClosed(prim, tolerance) {
            // Analytic shapes are closed by definition
            if (prim.type === 'circle' || prim.type === 'rectangle' || prim.type === 'obround') return true;

            // Check if an ArcPrimitive is a full 360 degree circle - REVIEW - double check this isn't redundant towards the new logic around single source of truth for circles post boolean.
            if (prim.type === 'arc') {
                const dx = prim.startPoint.x - prim.endPoint.x;
                const dy = prim.startPoint.y - prim.endPoint.y;
                return (dx * dx + dy * dy) < tolerance * tolerance;
            }

            // Check standard PathPrimitives
            if (!prim.contours || prim.contours.length === 0) return false;
            const pts = prim.contours[0].points;
            if (!pts || pts.length < 3) return false;
            const dx = pts[0].x - pts[pts.length - 1].x;
            const dy = pts[0].y - pts[pts.length - 1].y;
            return (dx * dx + dy * dy) < tolerance * tolerance;
        },

        endpointsConnect(edgeA, edgeB, tolerance) {
            const tolSq = tolerance * tolerance;
            const test = (p1, p2) => {
                const dx = p1.x - p2.x, dy = p1.y - p2.y;
                return (dx * dx + dy * dy) < tolSq;
            };
            return test(edgeA.start, edgeB.start) || test(edgeA.start, edgeB.end) ||
                   test(edgeA.end, edgeB.start)   || test(edgeA.end, edgeB.end);
        },

        reverseContourWinding(contour) {
            const n = contour.points.length;
            contour.points.reverse();

            const curveIdMap = new Map();

            if (contour.arcSegments && contour.arcSegments.length > 0) {
                contour.arcSegments = contour.arcSegments.map(arc => {
                    let newCurveId = arc.curveId;

                    if (arc.curveId && window.globalCurveRegistry) {
                        if (!curveIdMap.has(arc.curveId)) {
                            const oldCurve = window.globalCurveRegistry.getCurve(arc.curveId);
                            if (oldCurve) {
                                const flippedCurveId = window.globalCurveRegistry.register({
                                    ...oldCurve,
                                    clockwise: !oldCurve.clockwise,
                                    startAngle: oldCurve.endAngle,
                                    endAngle: oldCurve.startAngle,
                                    sweepAngle: oldCurve.sweepAngle !== undefined ? -oldCurve.sweepAngle : undefined,
                                    source: (oldCurve.source || 'unknown') + '_flipped'
                                });
                                curveIdMap.set(arc.curveId, flippedCurveId);
                            }
                        }
                        newCurveId = curveIdMap.get(arc.curveId) || arc.curveId;
                    }

                    return {
                        ...arc,
                        startIndex: (n - 1) - arc.endIndex,
                        endIndex: (n - 1) - arc.startIndex,
                        startAngle: arc.endAngle,
                        endAngle: arc.startAngle,
                        clockwise: !arc.clockwise,
                        sweepAngle: arc.sweepAngle !== undefined ? -arc.sweepAngle : undefined,
                        curveId: newCurveId
                    };
                });
            }

            if (curveIdMap.size > 0) {
                for (const pt of contour.points) {
                    if (pt.curveId && curveIdMap.has(pt.curveId)) {
                        pt.curveId = curveIdMap.get(pt.curveId);
                    }
                }
                if (contour.curveIds) {
                    contour.curveIds = contour.curveIds.map(id =>
                        curveIdMap.has(id) ? curveIdMap.get(id) : id
                    );
                }
            }
        },

        /**
         * Groups cutout primitives into connected components by endpoint proximity, then stitches each component into a closed loop independently.
         */
        extractClosedLoops(primitives, tolerance) {
            const precision = tolerance || PRECISION; // Coordinate epsilon parameter for user input on open polygons
            const closed = [];
            const open = [];

            for (const prim of primitives) {
                if (this.isPrimitiveClosed(prim, precision)) {
                    closed.push(prim);
                } else {
                    open.push(prim);
                }
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

                if (start && end) {
                    edges.push({ index: i, primitive: prim, start, end });
                } else {
                    skipped.push(prim);
                }
            }

            if (edges.length === 0) return { loops: closed, orphans: [...skipped, ...open.filter((_, i) => !edges.some(e => e.index === i))] };

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
                const componentPrims = indices.map(i => edges[i].primitive);
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
                this.debug(`${allOrphans.length} orphan segment(s), gaps: ${orphanGaps.map(g => g.toFixed(4) + 'mm').join(', ') || 'none'}`);
            }

            return { loops: [...closed, ...stitchedLoops], orphans: allOrphans, orphanGaps };
        },

        /**
         * Re-derives hole assignment for a single compound PathPrimitive
         * using geometric containment instead of winding sign.
         *
         * Explodes contours into individual loops, classifies via
         * classifyCutoutTopology, then reassembles into compound
         * primitive(s) with correct isHole/nestingLevel/winding.
         *
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
            const loops = contours.map(c => new PathPrimitive([{
                points:      c.points,
                arcSegments: c.arcSegments || [],
                curveIds:    c.curveIds    || [],
                isHole: false, nestingLevel: 0, parentId: null
            }], { ...primitive.properties }));

            // Classify by containment (area rank + pointInPolygon)
            const topology = this.classifyCutoutTopology(loops);

            // If no nesting found, return corrected-winding loops
            if (!topology.some(t => t.isHole)) return loops;

            // Reassemble: group holes under their parent outer
            const outers = topology.filter(t => !t.isHole);
            const holes  = topology.filter(t => t.isHole);
            const compounds = [];

            for (const outer of outers) {
                const children = holes.filter(h => h.parentIdx === outer.originalIdx);
                // Outer contour first — classifyCutoutTopology reads contours[0]
                // for any future re-analysis, so outer must be at index 0.
                const newContours = [outer.loop.contours[0]];
                for (const child of children) {
                    newContours.push(child.loop.contours[0]);
                }
                compounds.push(new PathPrimitive(newContours, {
                    ...primitive.properties
                }));
            }

            // Orphan holes with no containing outer — keep as standalone
            for (const hole of holes) {
                if (hole.parentIdx === null) {
                    compounds.push(hole.loop);
                }
            }

            return compounds.length > 0 ? compounds : [primitive];
        },

        /**
         * Determines nesting hierarchy of closed loops via containment testing.
         * Assigns isHole and enforces correct winding (CCW outer, CW hole).
         */
        classifyCutoutTopology(rawLoops) {
            if (!rawLoops || rawLoops.length === 0) return [];

            // Ensure all loops are PathPrimitives before topology checks
            const loops = rawLoops.map(loop => {
                if (loop.type !== 'path') {
                    return this.primitiveToPath(loop) || loop;
                }
                return loop;
            });

            if (loops.length === 1) {
                const contour = loops[0].contours[0];
                if (this.isClockwise(contour.points)) this.reverseContourWinding(contour);
                contour.isHole = false;
                contour.nestingLevel = 0;
                return [{ loop: loops[0], isHole: false, parentIdx: null, depth: 0, originalIdx: 0 }];
            }

            const entries = loops.map((loop, idx) => {
                const pts = loop.contours[0].points;
                const absArea = Math.abs(this.calculateWinding(pts));
                let rep = this.getRepresentativePoint(loop);

                // Safety: if centroid falls outside a concave polygon, use longest-edge midpoint
                if (rep && !this.pointInPolygon(rep, pts)) {
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
                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                }
                return { loop, originalIdx: idx, absArea, rep, parentIdx: null, depth: 0,
                         bb: { minX, minY, maxX, maxY } };
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
                    if (rep.x < bb.minX || rep.x > bb.maxX ||
                        rep.y < bb.minY || rep.y > bb.maxY) continue;
                    if (this.pointInPolygon(rep, entries[j].loop.contours[0].points)) {
                        entries[i].parentIdx = entries[j].originalIdx;
                        entries[i].depth = entries[j].depth + 1;
                        break;
                    }
                }
            }

            // Classify and enforce winding
            const results = entries.map(entry => {
                const isHole = (entry.depth % 2) !== 0;
                const contour = entry.loop.contours[0];
                const isCW = this.isClockwise(contour.points);
                if (isHole && !isCW) this.reverseContourWinding(contour);
                else if (!isHole && isCW) this.reverseContourWinding(contour);
                contour.isHole = isHole;
                contour.nestingLevel = entry.depth;
                return { loop: entry.loop, isHole, parentIdx: entry.parentIdx, depth: entry.depth, originalIdx: entry.originalIdx };
            });

            this.debug(`classifyCutoutTopology: ${results.filter(r => !r.isHole).length} outer(s), ${results.filter(r => r.isHole).length} hole(s)`);
            return results;
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GeometryUtils] ${message}`, data)
                 : console.log(`[GeometryUtils] ${message}`);
        }
    };

    window.GeometryUtils = GeometryUtils;
})();