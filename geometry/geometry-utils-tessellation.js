/*!
 * @file        geometry/geometry-utils-tessellation.js
 * @description Turns analytic curves into linear segments
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Curve -> point tessellation and the analytic-primitive -> PathPrimitive
 * conversions built on it. Leaf module: nothing here reaches outside the
 * group except CAMConfig, globalCurveRegistry and PathPrimitive, so it
 * carries no back-reference to GeometryUtils.
 *
 * Segment counts are a PIPELINE contract, not a quality preference: the
 * 0.01mm targetLength is what ArcReconstructor needs to recover analytic
 * arcs after Clipper. Display tessellation is a different rule entirely
 * (renderer3d-toolpath.js arcSegmentCount, sagitta-bounded).
 *
 * Envelope is globalThis, and the only dependency that could not be
 * satisfied under importScripts is PathPrimitive, which contourArcsToPath
 * does not touch.
 */

(function () {
    'use strict';

    const ROOT = globalThis;
    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    const GeometryTessellation = {

        // Segment counts

        calculateSegments(radius, targetLength, minSegments, maxSegments) {
            const minSeg = C.geometry.segments.defaultMinSegments;

            // For zero/negative radius, return the minimum valid count.
            if (radius <= 0) return Math.max(minSeg, Math.ceil(minSegments / minSeg) * minSeg);

            // Adjust boundaries to be multiples of 8, ensuring a valid range.
            const min = Math.max(minSeg, Math.ceil(minSegments / minSeg) * minSeg);
            const max = Math.floor(maxSegments / minSeg) * minSeg;

            // If adjusted boundaries are invalid (e.g., min > max), return the minimum.
            if (min > max) return min;

            const circumference = 2 * Math.PI * radius;
            const desiredSegments = circumference / targetLength;

            // Round the ideal segment count to the nearest multiple of 8.
            let calculatedSegments = Math.round(desiredSegments / minSeg) * minSeg;

            // Clamp the result within the adjusted boundaries. The final value will always be a multiple of 8 within the valid range.
            const finalSegments = Math.max(min, Math.min(max, calculatedSegments));
            return finalSegments;
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

            return this.calculateSegments(radius, finalTargetLength, finalMin, finalMax);
        },

        /**
         * Segment count for a partial arc at PIPELINE tolerance: the full-
         * circle count scaled by sweep. Floor of 2 keeps a hairline arc a
         * segment rather than a point.
         */
        arcSegmentsFor(radius,sweep) {
            const full = this.getOptimalSegments(radius, "arc");
            return Math.max(2, Math.ceil(full * Math.abs(sweep) / (2 * Math.PI)))
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
                });
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
                });
            }
            return a;
        },

        tessellateEllipticalArc(p1, p2, rx, ry, phi, fA, fS) {
            // SVG arc-to-centerpoint conversion logic
            const a = Math.sin(phi * Math.PI / 180),
                s = Math.cos(phi * Math.PI / 180),
                e = (p1.x - p2.x) / 2,
                o = (p1.y - p2.y) / 2,
                r = s * e + a * o,
                h = -a * e + s * o;

            rx = Math.abs(rx);
            ry = Math.abs(ry);

            let c = r * r / (rx * rx) + h * h / (ry * ry);
            if (c > 1) {
                rx *= Math.sqrt(c);
                ry *= Math.sqrt(c);
            }

            const l = (rx * rx * ry * ry - rx * rx * h * h - ry * ry * r * r) / (rx * rx * h * h + ry * ry * r * r),
                d = (fA === fS ? -1 : 1) * Math.sqrt(Math.max(0, l)),
                M = d * (rx * h / ry),
                g = d * (-ry * r / rx),
                x = s * M - a * g + (p1.x + p2.x) / 2,
                y = a * M + s * g + (p1.y + p2.y) / 2;

            const I = (t, p) => {
                const i = t[0] * p[1] - t[1] * p[0] < 0 ? -1 : 1;
                const dot = (t[0] * p[0] + t[1] * p[1]) / (Math.sqrt(t[0] * t[0] + t[1] * t[1]) * Math.sqrt(p[0] * p[0] + p[1] * p[1]));
                return i * Math.acos(Math.max(-1, Math.min(1, dot)));
            };

            const u = I([1, 0], [(r - M) / rx, (h - g) / ry]);
            let m = I([(r - M) / rx, (h - g) / ry], [(-r - M) / rx, (-h - g) / ry]);

            if (fS === 0 && m > 0) m -= 2 * Math.PI;
            else if (fS === 1 && m < 0) m += 2 * Math.PI;

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
                });
            }
            return P;
        },

        // Analytic primitive -> PathPrimitive

        // Converts a circle to a PathPrimitive with arc segment metadata.
        circleToPath(primitive) {
            const segments = this.getOptimalSegments(primitive.radius, 'circle');
            const points = [];
            const arcSegments = [];
            const isHole = primitive.properties?.polarity === 'clear';
            const directionMult = isHole ? -1 : 1; // CW for holes (-1), CCW for outers (+1) in Y-up

            // Register circle curve
            let curveId = null;
            if (ROOT.globalCurveRegistry) {
                curveId = ROOT.globalCurveRegistry.register({
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
                const angle = (2 * Math.PI + directionMult * (i / segments) * 2 * Math.PI) % (2 * Math.PI);
                const nextAngle = (2 * Math.PI + directionMult * ((i + 1) % segments / segments) * 2 * Math.PI) % (2 * Math.PI);

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
                isHole: isHole,
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
            const cap1Id = ROOT.globalCurveRegistry?.register({
                type: 'arc', center: cap1Center, radius: r, clockwise: false, source: 'obround_cap1'
            });
            const cap2Id = ROOT.globalCurveRegistry?.register({
                type: 'arc', center: cap2Center, radius: r, clockwise: false, source: 'obround_cap2'
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
                        const angle = Math.PI / 2 - Math.PI * i / capSegs;
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({
                        startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r,
                        startAngle: Math.PI / 2, endAngle: -Math.PI / 2, clockwise: true, curveId: cap2Id
                    });

                    points.push({ x: x + r, y: y });
                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = -Math.PI / 2 - Math.PI * i / capSegs;
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({
                        startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r,
                        startAngle: -Math.PI / 2, endAngle: -3 * Math.PI / 2, clockwise: true, curveId: cap1Id
                    });
                } else {
                    // CCW (Outer)
                    points.push({ x: x + r, y: y });
                    points.push({ x: x + w - r, y: y });
                    const cap2Start = points.length - 1;
                    for (let i = 1; i <= capSegs; i++) {
                        const angle = -Math.PI / 2 + Math.PI * i / capSegs;
                        points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                    }
                    arcSegments.push({
                        startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r,
                        startAngle: -Math.PI / 2, endAngle: Math.PI / 2, clockwise: false, curveId: cap2Id
                    });

                    points.push({ x: x + r, y: y + h });
                    const cap1Start = points.length - 1;
                    for (let i = 1; i < capSegs; i++) {
                        const angle = Math.PI / 2 + Math.PI * i / capSegs;
                        points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                    }
                    arcSegments.push({
                        startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r,
                        startAngle: Math.PI / 2, endAngle: 3 * Math.PI / 2, clockwise: false, curveId: cap1Id
                    });
                }
            } else if (isHole) {
                // CW (Hole)
                points.push({ x: x, y: y + r });
                points.push({ x: x, y: y + h - r });
                const cap2Start = points.length - 1;
                for (let i = 1; i <= capSegs; i++) {
                    const angle = Math.PI - Math.PI * i / capSegs;
                    points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                }
                arcSegments.push({
                    startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r,
                    startAngle: Math.PI, endAngle: 0, clockwise: true, curveId: cap2Id
                });

                points.push({ x: x + w, y: y + r });
                const cap1Start = points.length - 1;
                for (let i = 1; i < capSegs; i++) {
                    const angle = 0 - Math.PI * i / capSegs;
                    points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                }
                arcSegments.push({
                    startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r,
                    startAngle: 0, endAngle: -Math.PI, clockwise: true, curveId: cap1Id
                });
            } else {
                // CCW (Outer)
                points.push({ x: x + w, y: y + r });
                points.push({ x: x + w, y: y + h - r });
                const cap2Start = points.length - 1;
                for (let i = 1; i <= capSegs; i++) {
                    const angle = 0 + Math.PI * i / capSegs;
                    points.push({ x: cap2Center.x + r * Math.cos(angle), y: cap2Center.y + r * Math.sin(angle), curveId: cap2Id });
                }
                arcSegments.push({
                    startIndex: cap2Start, endIndex: points.length - 1, center: cap2Center, radius: r,
                    startAngle: 0, endAngle: Math.PI, clockwise: false, curveId: cap2Id
                });

                points.push({ x: x, y: y + r });
                const cap1Start = points.length - 1;
                for (let i = 1; i < capSegs; i++) {
                    const angle = Math.PI + Math.PI * i / capSegs;
                    points.push({ x: cap1Center.x + r * Math.cos(angle), y: cap1Center.y + r * Math.sin(angle), curveId: cap1Id });
                }
                arcSegments.push({
                    startIndex: cap1Start, endIndex: 0, center: cap1Center, radius: r,
                    startAngle: Math.PI, endAngle: 3 * Math.PI, clockwise: false, curveId: cap1Id
                });
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
            // CW  (Hole):  Bottom-Left -> Top-Left -> Top-Right -> Bottom-Right
            return isHole
                ? [
                    { x: x, y: y },          // Bottom-left
                    { x: x, y: y + h },      // Top-left
                    { x: x + w, y: y + h },  // Top-right
                    { x: x + w, y: y }
                ]
                : [
                    { x: x, y: y },          // Bottom-left
                    { x: x + w, y: y },      // Bottom-right
                    { x: x + w, y: y + h },  // Top-right
                    { x: x, y: y + h }
                ];
        },

        arcToPoints(primitive) {
            const start = primitive.startPoint;
            const end = primitive.endPoint;
            const center = primitive.center;
            const clockwise = primitive.clockwise;

            const radius = Math.sqrt(Math.pow(start.x - center.x, 2) + Math.pow(start.y - center.y, 2));
            const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
            const endAngle = Math.atan2(end.y - center.y, end.x - center.x);

            let angleSpan = endAngle - startAngle;
            if (clockwise) {
                if (angleSpan > 0) angleSpan -= 2 * Math.PI;
            } else if (angleSpan < 0) {
                angleSpan += 2 * Math.PI;
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
            return primitive.points.length === 4
                ? this.tessellateCubicBezier(...primitive.points)
                : primitive.points.length === 3
                    ? this.tessellateQuadraticBezier(...primitive.points)
                    : [];
        },

        ellipticalArcToPoints(primitive) {
            return this.tessellateEllipticalArc(
                primitive.startPoint, primitive.endPoint,
                primitive.rx, primitive.ry, primitive.phi,
                primitive.fA, primitive.fS
            );
        },

        // Contour arc expansion

        /**
         * Expands arc segments in a contour into tessellated polyline points.
         * Returns a new contour with no arc metadata — pure polygon suitable for Clipper2.
         * The original contour is not modified.
         *
         * contour.arcSegments carries TWO encodings and they are not
         * interchangeable - they state different things about contour.points:
         *
         *   SPAN  (obroundToPath, primitiveToPath 'arc', circleToPath):
         *         endIndex is beyond startIndex + 1. points is a COMPLETE
         *         tessellated polygon; arcSegments is analytic annotation on top.
         *         Safe to hand straight to Clipper, computeBounds, canvas fill
         *         and the SVG exporters.
         *   CHORD (parsers, ArcReconstructor.reconstructSingleContour):
         *         endIndex === startIndex + 1, no points between. The
         *         tessellation was DROPPED. points alone is lossy and every
         *         consumer must come through here or read arcSegments itself.
         * 
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
            if (!contour.arcSegments || contour.arcSegments.length === 0) return contour;

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
                    const segments = this.arcSegmentsFor(arc.radius, sweep);

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

        debug(message, data = null) {
            if (!debugState.enabled) return;
            if (data) console.log(`[GeometryTessellation] ${message}`, data);
            else console.log(`[GeometryTessellation] ${message}`);
        }
    };

    ROOT.GeometryTessellation = GeometryTessellation;
})();
