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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;

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
            this.geometricContext = {
                originalType: type,
                isAnalytic: false,
                metadata: {}
            };
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

        canOffsetAnalytically() {
            return this.geometricContext.isAnalytic;
        }

        getGeometricMetadata() {
            return this.geometricContext;
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
            if (!this.contours || this.contours.length === 0) {
                this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                return;
            }

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            this.contours.forEach(contour => {
                // Calculate bounds from outer contours only (skip holes)
                if (!contour.isHole && contour.points) {
                    const b = GeometryUtils.boundsOfPoints(contour.points);
                    if (b) {
                        if (b.minX < minX) minX = b.minX;
                        if (b.minY < minY) minY = b.minY;
                        if (b.maxX > maxX) maxX = b.maxX;
                        if (b.maxY > maxY) maxY = b.maxY;
                    }
                }

                // Expand bounds for arc segments
                if (contour.arcSegments && contour.arcSegments.length > 0) {
                    contour.arcSegments.forEach(seg => {
                        const { center, radius, startAngle, endAngle, clockwise } = seg;
                        const checkCrossing = (angle) => {
                            const normalizedAngle = angle % (2 * Math.PI);
                            let start = startAngle % (2 * Math.PI);
                            let end = endAngle % (2 * Math.PI);

                            if (start < 0) start += 2 * Math.PI;
                            if (end < 0) end += 2 * Math.PI;

                            if (clockwise) {
                                if (start > end) {
                                    return normalizedAngle <= start && normalizedAngle >= end;
                                } else {
                                    return normalizedAngle <= start || normalizedAngle >= end;
                                }
                            } else {
                                if (start < end) {
                                    return normalizedAngle >= start && normalizedAngle <= end;
                                } else {
                                    return normalizedAngle >= start || normalizedAngle <= end;
                                }
                            }
                        };

                        if (checkCrossing(0)) maxX = Math.max(maxX, center.x + radius);
                        if (checkCrossing(Math.PI / 2)) maxY = Math.max(maxY, center.y + radius);
                        if (checkCrossing(Math.PI)) minX = Math.min(minX, center.x - radius);
                        if (checkCrossing(3 * Math.PI / 2)) minY = Math.min(minY, center.y - radius);
                    });
                }
            });

            if (!isFinite(minX)) {
                this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                return;
            }

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
     * CirclePrimitive - analytic circle
     */
    class CirclePrimitive extends RenderPrimitive {
        constructor(center, radius, properties = {}) {
            super('circle', properties);
            this.center = center;
            this.radius = radius;

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = { 
                center: { ...center }, 
                radius: radius 
            };
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

    /**
     * RectanglePrimitive - analytic rectangle
     */
    class RectanglePrimitive extends RenderPrimitive {
        constructor(position, width, height, properties = {}) {
            super('rectangle', properties);
            this.position = position; // Bottom-left corner
            this.width = width;
            this.height = height;

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = { 
                position: { ...position }, 
                width, 
                height 
            };
        }

        calculateBounds() {
            let { x, y } = this.position;
            let w = this.width;
            let h = this.height;

            if (this.properties.strokeWidth && this.properties.stroke) {
                const halfStroke = this.properties.strokeWidth / 2;
                x -= halfStroke;
                y -= halfStroke;
                w += this.properties.strokeWidth;
                h += this.properties.strokeWidth;
            }

            this.bounds = {
                minX: x,
                minY: y,
                maxX: x + w,
                maxY: y + h
            };
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

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = {
                position: { ...position },
                width,
                height,
                isCircular: this.isCircular,
                cornerRadius: Math.min(width, height) / 2
            };
        }

        calculateBounds() {
            let { x, y } = this.position;
            let w = this.width;
            let h = this.height;

            if (this.properties.strokeWidth && this.properties.stroke) {
                const halfStroke = this.properties.strokeWidth / 2;
                x -= halfStroke;
                y -= halfStroke;
                w += this.properties.strokeWidth;
                h += this.properties.strokeWidth;
            }

            this.bounds = {
                minX: x,
                minY: y,
                maxX: x + w,
                maxY: y + h
            };
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

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = {
                center,
                radius,
                startAngle,
                endAngle,
                clockwise
            };

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
            let minX = Math.min(this.startPoint.x, this.endPoint.x);
            let minY = Math.min(this.startPoint.y, this.endPoint.y);
            let maxX = Math.max(this.startPoint.x, this.endPoint.x);
            let maxY = Math.max(this.startPoint.y, this.endPoint.y);

            // Check if arc crosses cardinal directions
            const checkCrossing = (angle) => {
                const normalizedAngle = angle % (2 * Math.PI);
                let start = this.startAngle % (2 * Math.PI);
                let end = this.endAngle % (2 * Math.PI);

                if (start < 0) start += 2 * Math.PI;
                if (end < 0) end += 2 * Math.PI;

                if (this.clockwise) {
                    if (start > end) {
                        return normalizedAngle <= start && normalizedAngle >= end;
                    } else {
                        return normalizedAngle <= start || normalizedAngle >= end;
                    }
                } else {
                    if (start < end) {
                        return normalizedAngle >= start && normalizedAngle <= end;
                    } else {
                        return normalizedAngle >= start || normalizedAngle <= end;
                    }
                }
            };

            if (checkCrossing(0)) maxX = Math.max(maxX, this.center.x + this.radius);
            if (checkCrossing(Math.PI / 2)) maxY = Math.max(maxY, this.center.y + this.radius);
            if (checkCrossing(Math.PI)) minX = Math.min(minX, this.center.x - this.radius);
            if (checkCrossing(3 * Math.PI / 2)) minY = Math.min(minY, this.center.y - this.radius);

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

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = {
                ...params,
                startPoint,
                endPoint
            };
        }

        canOffsetAnalytically() {
            return false;
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

            this.geometricContext.isAnalytic = true;
            this.geometricContext.metadata = {
                points: [...points],
                degree: points.length - 1
            };
        }

        canOffsetAnalytically() {
            return false;
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
     *   [x0,y0,z0, x1,y1,z1, ...]
     *
     * Why packed: a relief finishing pass can carry 10^5..10^6 points.
     * Object points cost ~50-80 bytes each and hammer the GC; triplets
     * cost 12 and the array uploads to the 3D renderer as a
     * BufferGeometry position attribute with zero conversion.
     *
     * Contract:
     *   - type === 'path3d' (routing), properties.is3DContour === true
     *     (kept so all existing property-based dispatch still works).
     *   - Always open, never a hole, no arcSegments - toolpath output,
     *     not boolean-pipeline geometry. canOffsetAnalytically() = false.
     *   - Consumers should read positions directly (translator delegate,
     *     renderers). toContourView() exists as a legacy escape hatch
     *     but materializes object points - avoid it in hot paths.
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

        get pointCount() {
            return (this.positions.length / 3) | 0;
        }

        /** Reads point i. Pass an out-object in loops to avoid allocation. */
        getPoint(i, out) {
            const b = i * 3, p = this.positions;
            if (out) { out.x = p[b]; out.y = p[b + 1]; out.z = p[b + 2]; return out; }
            return { x: p[b], y: p[b + 1], z: p[b + 2] };
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

        getBounds3D() {
            if (!this.bounds3D) this.calculateBounds();
            return this.bounds3D;
        }

        canOffsetAnalytically() {
            return false;
        }

        /**
         * Legacy escape hatch: materializes a contour-shaped object with
         * {x,y,z} points for code that only speaks PathPrimitive contours.
         * O(n) allocation - do NOT call per frame or per generation.
         */
        toContourView() {
            const n = this.pointCount;
            const points = new Array(n);
            for (let i = 0; i < n; i++) points[i] = this.getPoint(i);
            return {
                points, closed: false, isHole: false,
                nestingLevel: 0, parentId: null,
                arcSegments: [], curveIds: []
            };
        }
    }

    window.Polyline3DPrimitive = Polyline3DPrimitive;
    window.RenderPrimitive = RenderPrimitive;
    window.PathPrimitive = PathPrimitive;
    window.CirclePrimitive = CirclePrimitive;
    window.RectanglePrimitive = RectanglePrimitive;
    window.ObroundPrimitive = ObroundPrimitive;
    window.ArcPrimitive = ArcPrimitive;
    window.EllipticalArcPrimitive = EllipticalArcPrimitive;
    window.BezierPrimitive = BezierPrimitive;
})();