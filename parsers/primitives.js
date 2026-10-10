/*!
 * @file        parsers/primitives.js
 * @description Defines geometric primitive data structures
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';
    const ROOT = globalThis;

    const C = ROOT.CAMConfig.constants;

    let nextPrimitiveId = 1;

    /**
     * Base class for all geometric primitives data objects.
     */
    class RenderPrimitive {
        constructor(type, properties = {}) {
            this.type = type;
            this.properties = properties;
            this.bounds = null;
            this.id = `prim_${nextPrimitiveId++}`;
        }

        getBounds() {
            if (!this.bounds) {
                this.calculateBounds();
            }
            return this.bounds;
        }

        calculateBounds() {
            this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        getCenter() {
            const bounds = this.getBounds();
            return {
                x: (bounds.minX + bounds.maxX) / 2,
                y: (bounds.minY + bounds.maxY) / 2
            };
        }
    }

    /**
     * PathPrimitive - complex shape with optional analytic arcs
     */
    class PathPrimitive extends RenderPrimitive {
        constructor(contours, properties = {}) {
            super('path', properties); // Pass type to super
            this.properties = properties;
            this.closed = properties.closed !== false;
            
            if (Array.isArray(contours) && contours.length > 0) {
                this.contours = contours;
            } else {
                this.contours = [];
            }
        }

        /**
         * POLARITY, WINDING, AND HIERARCHY IN PATHPRIMITIVE
         * 
         * Three distinct but related concepts:
         * 
         * 1. properties.polarity: Gerber/CAM semantic meaning
         *    - 'dark': Copper/material present
         *    - 'clear': Copper/material removed
         *    - Used for: Boolean operations, layer semantics
         * 
         * 2. contour.isHole: Geometric hierarchy
         *    - false: Outer boundary (shell)
         *    - true: Inner boundary (hole within parent)
         *    - Used for: Rendering (with evenodd), nesting relationships
         * 
         * 3. Winding direction: Point traversal order
         *    - CCW (counter-clockwise): Positive area in Y-up
         *    - CW (clockwise): Negative area in Y-up
         *    - Convention: Outer=CCW, Hole=CW (before Y-flip)
         *    - Used for: Boolean ops, determining isHole
         * 
         * Relationship:
         * - A 'dark' primitive can have 'clear' holes (compound path)
         * - isHole is derived from winding during parsing/processing
         * - polarity affects boolean operations but not rendering
         * - Canvas rendering uses winding via 'evenodd' fill rule
         */

        calculateBounds() {
            const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            for (const contour of this.contours || []) {
                // Calculate bounds from outer contours only (skip holes)
                if (contour.isHole) continue;
                const pointBounds = contour.points ? GeometryPoints.boundsOfPoints(contour.points) : null;
                if (pointBounds) {
                    b.minX = Math.min(b.minX, pointBounds.minX);
                    b.minY = Math.min(b.minY, pointBounds.minY);
                    b.maxX = Math.max(b.maxX, pointBounds.maxX);
                    b.maxY = Math.max(b.maxY, pointBounds.maxY);
                }
                // Expand bounds for arc segments
                for (const seg of contour.arcSegments || []) {
                    GeometryPoints.growBoundsByArc(b, seg.center, seg.radius, seg.startAngle, seg.endAngle, seg.clockwise);
                }
            }
            if (!Number.isFinite(b.minX)) {
                this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                return;
            }
            if (this.properties.stroke && this.properties.strokeWidth) {
                const halfStroke = this.properties.strokeWidth / 2;
                b.minX -= halfStroke;
                b.minY -= halfStroke;
                b.maxX += halfStroke;
                b.maxY += halfStroke;
            }
            this.bounds = b;
        }
    }

    /**
     * CirclePrimitive - analytic circle
     */
    class CirclePrimitive extends RenderPrimitive {
        constructor(center, radius, properties = {}) {
            super('circle', properties);
            this.center = center;
            this.radius = radius;
        }

        calculateBounds() {
            let r = this.radius;
            if (this.properties.strokeWidth && this.properties.stroke) {
                r += this.properties.strokeWidth / 2;
            }
            this.bounds = {
                minX: this.center.x - r,
                minY: this.center.y - r,
                maxX: this.center.x + r,
                maxY: this.center.y + r
            };
        }

        getCenter() { 
            return { ...this.center };
        }
    }

    // Bottom-left position + size, grown by half the stroke when stroked.
    function boxBounds(prim) {
        const half = prim.properties.stroke && prim.properties.strokeWidth ? prim.properties.strokeWidth / 2 : 0;
        return {
            minX: prim.position.x - half,
            minY: prim.position.y - half,
            maxX: prim.position.x + prim.width + half,
            maxY: prim.position.y + prim.height + half
        };
    }

    /**
     * RectanglePrimitive - analytic rectangle
     */
    class RectanglePrimitive extends RenderPrimitive {
        constructor(position, width, height, properties = {}) {
            super('rectangle', properties);
            this.position = position; // Bottom-left corner
            this.width = width;
            this.height = height;
        }

        calculateBounds() {
            this.bounds = boxBounds(this);
        }
    }

    /**
     * ObroundPrimitive - analytic obround
     */
    class ObroundPrimitive extends RenderPrimitive {
        constructor(position, width, height, properties = {}) {
            super('obround', properties);
            this.position = position;
            this.width = width;
            this.height = height;

            this.isCircular = Math.abs(width - height) < C.precision.coordinate;
        }

        calculateBounds() {
            this.bounds = boxBounds(this);
        }
    }

    /**
     * ArcPrimitive - analytic circular arc
     */
    class ArcPrimitive extends RenderPrimitive {
        constructor(center, radius, startAngle, endAngle, clockwise, properties = {}) {
            super('arc', properties);
            this.center = center;
            this.radius = radius;
            this.startAngle = startAngle;
            this.endAngle = endAngle;
            this.clockwise = clockwise;
            this.startPoint = {
                x: center.x + radius * Math.cos(startAngle),
                y: center.y + radius * Math.sin(startAngle)
            };
            this.endPoint = {
                x: center.x + radius * Math.cos(endAngle),
                y: center.y + radius * Math.sin(endAngle)
            };
        }

        calculateBounds() {
            const b = {
                minX: Math.min(this.startPoint.x, this.endPoint.x),
                minY: Math.min(this.startPoint.y, this.endPoint.y),
                maxX: Math.max(this.startPoint.x, this.endPoint.x),
                maxY: Math.max(this.startPoint.y, this.endPoint.y)
            };
            GeometryPoints.growBoundsByArc(b, this.center, this.radius, this.startAngle, this.endAngle, this.clockwise);
            // Expand by stroke width if stroked
            if (this.properties.stroke && this.properties.strokeWidth) {
                const halfStroke = this.properties.strokeWidth / 2;
                b.minX -= halfStroke;
                b.minY -= halfStroke;
                b.maxX += halfStroke;
                b.maxY += halfStroke;
            }
            this.bounds = b;
        }
    }

    /**
     * EllipticalArcPrimitive - analytic elliptical arc
     */
    class EllipticalArcPrimitive extends RenderPrimitive {
        constructor(startPoint, endPoint, params, properties = {}) {
            super('elliptical_arc', properties);

            this.startPoint = startPoint;
            this.endPoint = endPoint;
            this.rx = params.rx;
            this.ry = params.ry;
            this.phi = params.phi;
            this.fA = params.fA === 1; // Large arc flag
            this.fS = params.fS === 1; // Sweep flag
        }

        calculateBounds() {
            // Simple bounding box from endpoints
            const minX = Math.min(this.startPoint.x, this.endPoint.x);
            const minY = Math.min(this.startPoint.y, this.endPoint.y);
            const maxX = Math.max(this.startPoint.x, this.endPoint.x);
            const maxY = Math.max(this.startPoint.y, this.endPoint.y);

            // Expand by max radius as conservative estimate
            const maxRadius = Math.max(this.rx, this.ry);

            this.bounds = {
                minX: minX - maxRadius,
                minY: minY - maxRadius,
                maxX: maxX + maxRadius,
                maxY: maxY + maxRadius
            };
        }
    }

    /**
     * BezierPrimitive - analytic Bezier curve
     */
    class BezierPrimitive extends RenderPrimitive {
        constructor(points, properties = {}) {
            super('bezier', properties);
            this.points = points; // [p0, p1, p2] or [p0, p1, p2, p3]
        }

        calculateBounds() {
            // Simple bounding box from control points
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            this.points.forEach(point => {
                minX = Math.min(minX, point.x);
                minY = Math.min(minY, point.y);
                maxX = Math.max(maxX, point.x);
                maxY = Math.max(maxY, point.y);
            });

            // Expand by stroke width if stroked
            if (this.properties.stroke && this.properties.strokeWidth) {
                const halfStroke = this.properties.strokeWidth / 2;
                minX -= halfStroke;
                minY -= halfStroke;
                maxX += halfStroke;
                maxY += halfStroke;
            }

            this.bounds = { minX, minY, maxX, maxY };
        }
    }

    /**
     * Polyline3DPrimitive - packed 3D toolpath chain (V-Carve, Relief).
     *
     * Stores one open polyline as xyz triplets in a single Float32Array:
     *  [x0,y0,z0, x1,y1,z1, ...]
     *
     * Why packed: a relief finishing pass can carry 10^5..10^6 points.
     * Object points cost ~50-80 bytes each and hammer the GC; triplets
     * cost 12 and the array uploads to the 3D renderer as a
     * BufferGeometry position attribute with zero conversion.
     *
     * Contract:
     *  - type === 'path3d' (routing), properties.is3DContour === true
     *     (kept so all existing property-based dispatch still works).
     *  - Always open, never a hole, no arcSegments - toolpath output,
     *     not boolean-pipeline geometry.
     *  - Consumers read positions directly (translator delegate,
     *    renderers).
     */
    class Polyline3DPrimitive extends RenderPrimitive {
        constructor(positions, properties = {}) {
            super('path3d', {
                stroke: true,
                fill: false,
                strokeWidth: 0,
                is3DContour: true,
                ...properties
            });
            this.positions = (positions instanceof Float32Array)
                ? positions
                : new Float32Array(positions || []);
            this.bounds3D = null;
        }

        /** Packs an array of {x, y, z} points. z defaults to 0. */
        static fromPoints(points, properties = {}) {
            const arr = new Float32Array(points.length * 3);
            let badZ = 0;
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                arr[i * 3] = p.x;
                arr[i * 3 + 1] = p.y;
                // Never coerce silently: non-finite Z here means an upstream
                // generator bug (a `p.z || 0` masked the relief NaN pipeline
                // once - flatlined output with zero console evidence).
                if (Number.isFinite(p.z)) {
                    arr[i * 3 + 2] = p.z;
                } else {
                    arr[i * 3 + 2] = 0;
                    badZ++;
                }
            }
            if (badZ > 0) {
                console.warn(`[Polyline3DPrimitive] ${badZ}/${points.length} point(s) had non-finite Z (coerced to 0) - upstream generator bug`);
            }
            return new Polyline3DPrimitive(arr, properties);
        }

        calculateBounds() {
            const p = this.positions;
            if (p.length < 3) {
                this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                this.bounds3D = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
                return;
            }
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let i = 0; i < p.length; i += 3) {
                const x = p[i], y = p[i + 1], z = p[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            this.bounds = { minX, minY, maxX, maxY };
            this.bounds3D = { minX, minY, minZ, maxX, maxY, maxZ };
        }
    }

    ROOT.Polyline3DPrimitive = Polyline3DPrimitive;
    ROOT.RenderPrimitive = RenderPrimitive;
    ROOT.PathPrimitive = PathPrimitive;
    ROOT.CirclePrimitive = CirclePrimitive;
    ROOT.RectanglePrimitive = RectanglePrimitive;
    ROOT.ObroundPrimitive = ObroundPrimitive;
    ROOT.ArcPrimitive = ArcPrimitive;
    ROOT.EllipticalArcPrimitive = EllipticalArcPrimitive;
    ROOT.BezierPrimitive = BezierPrimitive;
})();