/*!
 * @file        geometry/geometry-utils-math.js
 * @description Low-level intersection math and shared geometric primitives
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    // WARNING - NOT FULLY UPDATED TO NEW CONFIG STRUCTURE YET
    'use strict';

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

    /**
     * Shared low-level math for the offset pipelines.
     *
     * All intersection routines and the round-joint generator live here so that
     * both the polygon offsetter (GeometryOffsetter) and the analytic offsetter
     * (GeometryAnalyticOffsetter) call a single implementation.
     *
     * Dependencies:
     *   - CAMConfig             (epsilon, minRoundJointSegments)
     *   - GeometryUtils         (getOptimalSegments - must be loaded first)
     *   - globalCurveRegistry   (optional, for round-joint curve registration)
     */
    const GeometryMath = {

        // ==========================================
        // INTERSECTION: LINE ↔ LINE
        // ==========================================

        /**
         * Unbounded line-line intersection.
         * Returns the intersection point or null if the lines are parallel.
         * @param {Object} p1 - First point of line A.
         * @param {Object} p2 - Second point of line A.
         * @param {Object} p3 - First point of line B.
         * @param {Object} p4 - Second point of line B.
         * @returns {Object|null} { x, y } or null.
         */
        lineLineIntersection(p1, p2, p3, p4) {
            const den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
            const epsilon = geomConfig.offsetting?.epsilon || 1e-9; // REVIEW - Double check if such a small epsilon is necessary, link is also broken
            if (Math.abs(den) < epsilon) return null;

            const t_num = (p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x);
            const t = t_num / den;

            return {
                x: p1.x + t * (p2.x - p1.x),
                y: p1.y + t * (p2.y - p1.y)
            };
        },

        // ==========================================
        // INTERSECTION: LINE ↔ CIRCLE
        // ==========================================

        /**
         * Intersects an unbounded line (through p1→p2) with a circle.
         * Returns an array of { point, tLine, angle } objects (0-2 results).
         *
         * When the discriminant is slightly negative (near-miss), the routine
         * snaps to the closest point on the line to the circle center. This
         * provides a fallback joint rather than returning nothing, which would
         * otherwise cause a topology collapse in the analytic offsetter.
         *
         * @param {Object}  p1        - Line start.
         * @param {Object}  p2        - Line end.
         * @param {Object}  center    - Circle center.
         * @param {number}  radius    - Circle radius.
         * @param {number}  precision - Coordinate precision (mm).
         * @returns {Array} Array of intersection descriptors.
         */
        lineCircleIntersect(p1, p2, center, radius, precision) {
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const fx = p1.x - center.x;
            const fy = p1.y - center.y;

            const a = dx * dx + dy * dy;
            if (a < precision * precision) return [];

            const b = 2 * (fx * dx + fy * dy);
            const c = fx * fx + fy * fy - radius * radius;
            let discriminant = b * b - 4 * a * c;

            // Near-miss: snap to closest approach point
            if (discriminant < -(precision * 10)) {
                const tClosest = -b / (2 * a);
                const px = p1.x + tClosest * dx;
                const py = p1.y + tClosest * dy;

                return [{
                    point: { x: px, y: py },
                    tLine: tClosest,
                    angle: Math.atan2(py - center.y, px - center.x)
                }];
            }

            if (discriminant < 0) discriminant = 0;

            const sqrtDisc = Math.sqrt(discriminant);
            const results = [];

            const addResult = (t) => {
                const px = p1.x + t * dx;
                const py = p1.y + t * dy;
                results.push({
                    point: { x: px, y: py },
                    tLine: t,
                    angle: Math.atan2(py - center.y, px - center.x)
                });
            };

            const t1 = (-b - sqrtDisc) / (2 * a);
            const t2 = (-b + sqrtDisc) / (2 * a);

            addResult(t1);
            if (Math.abs(t2 - t1) > 1e-9) addResult(t2);

            return results;
        },

        // ==========================================
        // INTERSECTION: CIRCLE ↔ CIRCLE
        // ==========================================

        /**
         * Intersects two circles.
         * Returns an array of { x, y } points (0-2 results).
         *
         * @param {Object}  c1        - Center of circle 1.
         * @param {number}  r1        - Radius of circle 1.
         * @param {Object}  c2        - Center of circle 2.
         * @param {number}  r2        - Radius of circle 2.
         * @param {number}  precision - Coordinate precision (mm).
         * @returns {Array} Array of intersection points.
         */
        circleCircleIntersect(c1, r1, c2, r2, precision) {
            const dx = c2.x - c1.x;
            const dy = c2.y - c1.y;
            const d = Math.hypot(dx, dy);

            const eps = precision * 10;

            if (d > r1 + r2 + eps) return [];       // Too far apart
            if (d < Math.abs(r1 - r2) - eps) return []; // One inside the other
            if (d < precision) return [];             // Concentric

            const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
            let hSq = r1 * r1 - a * a;

            if (hSq < 0 && hSq > -(eps * eps)) {
                hSq = 0; // Tangent - clamp floating point noise
            } else if (hSq < 0) {
                return [];
            }

            const h = Math.sqrt(hSq);
            const mx = c1.x + a * dx / d;
            const my = c1.y + a * dy / d;

            const px = h * dy / d;
            const py = h * dx / d;

            const p1 = { x: mx + px, y: my - py };
            const p2 = { x: mx - px, y: my + py };

            if (h < precision) return [p1]; // Tangent - single point

            return [p1, p2];
        },

        // ==========================================
        // CANDIDATE SELECTION
        // ==========================================

        /**
         * From a set of intersection candidates, picks the one closest to a
         * reference point (the original un-offset vertex). This guarantees the
         * correct physical corner is selected for both expanding and shrinking
         * offsets, regardless of how far the angles have drifted.
         *
         * @param {Array}  candidates     - Array of points or { point } objects.
         * @param {Object} referencePoint - The original polygon vertex { x, y }.
         * @returns {Object|null} The selected { x, y } point or null.
         */
        pickNearestIntersection(candidates, referencePoint) {
            if (!candidates || candidates.length === 0) return null;

            if (candidates.length === 1) {
                return candidates[0].point || candidates[0];
            }

            let best = null;
            let bestDist = Infinity;

            for (const c of candidates) {
                const pt = c.point || c;
                const dist = Math.hypot(pt.x - referencePoint.x, pt.y - referencePoint.y);

                if (dist < bestDist) {
                    bestDist = dist;
                    best = pt;
                }
            }

            return best;
        },

        // ==========================================
        // ROUND JOINT GENERATION
        // ==========================================

        /**
         * Generates arc points for a round (fillet) joint between two offset
         * segments at a convex corner. Used by both the polygon-only offsetter
         * and the analytic (hybrid) offsetter.
         *
         * Side-effect: registers the joint arc with globalCurveRegistry when
         * available, enabling downstream arc reconstruction.
         *
         * @param {Object} originalCorner - The un-offset polygon vertex.
         * @param {Object} v1_vec         - Direction vector of the outgoing edge of entity 1.
         * @param {Object} v2_vec         - Direction vector of the incoming edge of entity 2.
         * @param {number} normalDirection - +1 or -1, determines offset side.
         * @param {number} offsetDist      - Absolute offset distance.
         * @param {number} distance        - Signed offset distance (for registry metadata).
         * @param {number} precision       - Coordinate precision (mm).
         * @returns {Array} Array of { x, y, curveId, segmentIndex, totalSegments, t } points.
         */
        createRoundJoint(originalCorner, v1_vec, v2_vec, normalDirection, offsetDist, distance, precision) {
            const len1 = Math.hypot(v1_vec.x, v1_vec.y);
            const len2 = Math.hypot(v2_vec.x, v2_vec.y);

            if (len1 < precision || len2 < precision) return [];

            const n1 = { x: normalDirection * (-v1_vec.y / len1), y: normalDirection * (v1_vec.x / len1) };
            const n2 = { x: normalDirection * (-v2_vec.y / len2), y: normalDirection * (v2_vec.x / len2) };

            const angle1 = Math.atan2(n1.y, n1.x);
            const angle2 = Math.atan2(n2.y, n2.x);
            let angleDiff = angle2 - angle1;

            while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
            while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

            const jointIsClockwise = angleDiff < 0;

            // Register joint arc (optional - gracefully skipped if registry absent)
            const jointCurveId = window.globalCurveRegistry?.register({
                type: 'arc',
                center: { x: originalCorner.x, y: originalCorner.y },
                radius: offsetDist,
                startAngle: angle1,
                endAngle: angle2,
                clockwise: jointIsClockwise,
                source: 'offset_joint',
                isOffsetDerived: true,
                offsetDistance: distance
            });

            const fullCircleSegments = GeometryUtils.getOptimalSegments(offsetDist, 'circle');
            const proportionalSegments = fullCircleSegments * (Math.abs(angleDiff) / (2 * Math.PI));
            const minSegments = D.geometry.offsetting.minRoundJointSegments;
            const arcSegments = Math.max(minSegments, Math.ceil(proportionalSegments));

            const arcPoints = [];
            for (let j = 1; j <= arcSegments; j++) {
                const t = j / arcSegments;
                const angle = angle1 + angleDiff * t;
                arcPoints.push({
                    x: originalCorner.x + offsetDist * Math.cos(angle),
                    y: originalCorner.y + offsetDist * Math.sin(angle),
                    curveId: jointCurveId,
                    segmentIndex: j,
                    totalSegments: arcSegments + 1,
                    t: t
                });
            }

            return arcPoints;
        },

        // ==========================================
        // DEBUG
        // ==========================================

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GeometryMath] ${message}`, data)
                 : console.log(`[Geometrymath] ${message}`);
        }
    };

    window.GeometryMath = GeometryMath;
})();