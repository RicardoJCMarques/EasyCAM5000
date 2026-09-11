/*!
 * @file        geometry/geometry-utils-points.js
 * @description 
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 
 * Point and polyline maths shared by the main thread and the field worker.
 * Stateless geometry queries over plain data: points, rings, and
 * primitive-shaped plain objects. No construction, no curve registry, no
 * transforms - so nothing here has a dependency that would have to cross
 * the worker boundary. GeometryUtils re-exports every method by reference.
 */

(function () {
    'use strict';

    const ROOT = (typeof self !== 'undefined') ? self : window;

    const GeometryPoints = {

        /**
         * AABB of an array of {x,y} points. Returns null for empty input or if
         * any coordinate is non-finite (callers treat null as "no bounds").
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
            return (Number.isFinite(minX) && Number.isFinite(maxX))
                ? { minX, minY, maxX, maxY }
                : null;
        },

        /**
         * Merges an array of AABB objects ({minX,minY,maxX,maxY}), skipping
         * null/undefined entries. Returns null if nothing merged or the result
         * is non-finite.
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
            return (Number.isFinite(minX) && Number.isFinite(maxX))
                ? { minX, minY, maxX, maxY }
                : null;
        },

        /** Signed area of a closed point ring. Y-up: positive = CCW = outer. */
        calculateWinding(points) {
            if (!points || points.length < 3) return 0;
            let area = 0;
            const len = points.length;
            for (let i = 0; i < len; i++) {
                const j = (i === len - 1) ? 0 : i + 1;
                area += points[i].x * points[j].y;
                area -= points[j].x * points[i].y;
            }
            return area / 2;
        },

        isClockwise(points) {
            return this.calculateWinding(points) < 0;
        },

        /** Squared perpendicular distance from point p to line segment p1→p2. */
        getSqDistToSegment(p, p1, p2) {
            let x = p1.x, y = p1.y;
            let dx = p2.x - x, dy = p2.y - y;
            if (dx !== 0 || dy !== 0) {
                const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
                if (t > 1) {
                    x = p2.x;
                    y = p2.y;
                } else if (t > 0) {
                    x += dx * t;
                    y += dy * t;
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
         * Ray-casting point-in-polygon test. Uses the Jordan curve theorem: a ray
         * from the point crosses the boundary an odd number of times iff the point
         * is inside. Expression order is load-bearing - a boundary point can land
         * on either side by one ULP, and v-carve parity tests read the result.
         */
        pointInPolygon(point, polygon) {
            if (!polygon || polygon.length < 3) return false;
            let inside = false;
            const n = polygon.length;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const xi = polygon[i].x, yi = polygon[i].y;
                const xj = polygon[j].x, yj = polygon[j].y;
                if ((yi > point.y) !== (yj > point.y)
                    && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi) {
                    inside = !inside;
                }
            }
            return inside;
        },

        /**
         * Point-inside test for a primitive-shaped plain object. Analytic
         * shapes get their exact test; paths use even-odd across ALL
         * contours, so a hole reads as outside.
         */
        pointInPrimitive(prim, pt) {
            if (prim.type === 'circle') {
                const dx = pt.x - prim.center.x;
                const dy = pt.y - prim.center.y;
                return dx * dx + dy * dy <= prim.radius * prim.radius;
            }
            if (prim.type === 'rectangle') {
                return pt.x >= prim.position.x && pt.x <= prim.position.x + prim.width
                    && pt.y >= prim.position.y && pt.y <= prim.position.y + prim.height;
            }
            if (prim.type === 'obround') {
                const x = prim.position.x, y = prim.position.y;
                const w = prim.width, h = prim.height;
                const r = Math.min(w, h) / 2;
                if (pt.x < x || pt.x > x + w || pt.y < y || pt.y > y + h) return false;
                if (w > h) {
                    if (pt.x >= x + r && pt.x <= x + w - r) return true;
                    const cap = pt.x < x + r ? { x: x + r, y: y + r } : { x: x + w - r, y: y + r };
                    const dx = pt.x - cap.x, dy = pt.y - cap.y;
                    return dx * dx + dy * dy <= r * r;
                }
                if (pt.y >= y + r && pt.y <= y + h - r) return true;
                const cap = pt.y < y + r ? { x: x + r, y: y + r } : { x: x + r, y: y + h - r };
                const dx = pt.x - cap.x, dy = pt.y - cap.y;
                return dx * dx + dy * dy <= r * r;
            }
            if (!prim.contours) return false;
            // XOR across contours, not per contour: an odd number of
            // enclosing rings is inside, which is the even-odd fill rule.
            let inside = false;
            for (const c of prim.contours) {
                if (this.pointInPolygon(pt, c.points)) inside = !inside;
            }
            return inside;
        },

        /**
         * True when pt is within maxDist of the primitive's OUTLINE - the
         * stroke hit-test, and the edge-tolerance pass for filled shapes.
         */
        pointNearPrimitive(prim, pt, maxDist) {
            if (prim.type === 'circle') {
                const dx = pt.x - prim.center.x;
                const dy = pt.y - prim.center.y;
                return Math.abs(Math.sqrt(dx * dx + dy * dy) - prim.radius) <= maxDist;
            }
            if (!prim.contours) return false;
            const maxSq = maxDist * maxDist;
            for (const c of prim.contours) {
                const pts = c.points;
                if (!pts || pts.length < 2) continue;
                for (let i = 0; i < pts.length - 1; i++) {
                    if (this.getSqDistToSegment(pt, pts[i], pts[i + 1]) <= maxSq) return true;
                }
            }
            return false;
        }
    };

    ROOT.GeometryPoints = GeometryPoints;
}());
