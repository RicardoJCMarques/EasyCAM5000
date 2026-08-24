/*!
 * @file        geometry/geometry-offsetter.js
 * @description Geometry offsetting orchestrator
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

    class GeometryOffsetter {
        constructor(options = {}) {
            this.options = {
                miterLimit: options.miterLimit
            };
            this.initialized = true;
            this.geometryProcessor = null;

            // --- INFLATE/DEFLATE OFFSET TOGGLE ---
            // true  → every path offset routes through Clipper2 booleans
            //         (offsetPathViaBoolean). This is the SHIPPING path, the
            //         only one wired end to end, and the one that keeps arcs
            //         almost lossless via the curve registry.
            // false → arc-free contours would try GeometryAnalyticOffsetter
            //         first. That module EXISTS and is a parked work in
            //         progress: no open defect drives it, because the boolean
            //         pipeline already gives near-exact results. Its call site
            //         in offsetPath is deliberately unwritten - see the throw
            //         there. These references are an unfinished branch, not
            //         dead code to be "cleaned up".
            this.USE_INFLATE_OFFSETTING = true;

            // Analytic strategy (loads gracefully if module is present)
            this.analyticOffsetter = null;
            if (typeof GeometryAnalyticOffsetter !== 'undefined') {
                this.analyticOffsetter = new GeometryAnalyticOffsetter({
                    miterLimit: options.miterLimit
                });
                this.debug('Analytic offsetter module linked');
            }
        }

        setGeometryProcessor(processor) {
            this.geometryProcessor = processor;
        }

        /**
         * Offsets a filled boundary (polygon, circle, rectangle, obround) inward or outward.
         * Operation-agnostic - does not inspect stroke/fill/isTrace/isCutout.
         * Handlers decide what to pass here; the offsetter just does math.
         *
         * @param {Object} primitive - A filled geometric primitive
         * @param {number} distance - Positive = grow outward, negative = shrink inward
         * @returns {Object|Array|null} Offset primitive(s)
         */
        async offsetBoundary(primitive, distance) {
            if (debugState.enabled) {
                console.log('[Offsetter] offsetBoundary:', {
                    type: primitive?.type,
                    id: primitive?.id,
                    distance: distance
                });
            }

            if (!primitive || !primitive.type) return null;
            if (Math.abs(distance) < PRECISION) return primitive;

            // Normalize non-path analytic types that aren't handled below
            if (primitive.type === 'arc' ||
                primitive.type === 'elliptical_arc' ||
                primitive.type === 'bezier') {

                const converted = GeometryUtils.primitiveToPath(primitive);
                if (!converted) {
                    console.warn(`[Offsetter] Failed to convert ${primitive.type} to path`);
                    return null;
                }
                if (!converted.properties) converted.properties = {};
                converted.properties.originalType = primitive.type;
                primitive = converted;
            }

            // Filled shape dispatch
            switch (primitive.type) {
                case 'circle':
                    return this.offsetCircle(primitive, distance);
                case 'rectangle':
                    return this.offsetRectangle(primitive, distance);
                case 'obround':
                    return this.offsetObround(primitive, distance);
                case 'path':
                    return this.offsetPath(primitive, distance);
                default:
                    this.debug(`Unhandled primitive type: ${primitive.type}`);
                    return null;
            }
        }

        /**
         * Expands a centerline stroke (open or closed path, arc) into filled polygon(s).
         * The caller provides the final width - this method does not read strokeWidth
         * from properties or combine it with an offset distance.
         *
         * @param {Object} primitive - A stroke/trace primitive (path or arc)
         * @param {number} width - The total width of the resulting filled polygon
         * @returns {Object|Array|null} Filled polygon primitive(s)
         */
        expandStroke(primitive, width) {
            this.debug(`expandStroke: type=${primitive?.type}, width=${width?.toFixed(4)}`);

            if (!primitive || width < PRECISION) {
                this.debug(`Stroke collapsed or invalid: width=${width?.toFixed(4)}`);
                return null;
            }

            if (primitive.type === 'arc') {
                return GeometryUtils.arcToPolygon(primitive, width);
            }

            if (primitive.type === 'path' && primitive.contours?.[0]) {
                if (primitive.contours.length > 1) {
                    // traceToPolygon is single-contour. A compound path
                    // reaching here would lose every contour past the first.
                    console.warn(`[Offsetter] expandStroke: ${primitive.contours.length}-contour path ` +
                        `(id ${primitive.id}) - expanding each contour separately.`);
                    const out = [];
                    for (const c of primitive.contours) {
                        const poly = GeometryUtils.traceToPolygon(c, width, primitive.properties || {});
                        if (Array.isArray(poly)) out.push(...poly);
                        else if (poly) out.push(poly);
                    }
                    return out.length ? out : null;
                }
                return GeometryUtils.traceToPolygon(
                    primitive.contours[0], width, primitive.properties || {}
                );
            }

            this.debug(`expandStroke: unsupported primitive type ${primitive.type}`);
            return null;
        }

        /**
         * Checks if a path primitive contains any analytic arc segments.
         */
        hasAnalyticArcs(pathPrimitive) {
            if (!pathPrimitive.contours || pathPrimitive.contours.length === 0) {
                return false;
            }
            return pathPrimitive.contours.some(contour => 
                contour.arcSegments && contour.arcSegments.length > 0
            );
        }

        /**
         * Offsets a PathPrimitive. Routes to boolean pipeline or legacy fallback.
         */
        async offsetPath(path, distance) {
            if (!path.contours || path.contours.length === 0) {
                this.debug('offsetPath: no contours');
                return null;
            }

            // Detect circle paths wrapped in PathPrimitive (e.g. from nesting)
            // and redirect to the analytic handler that preserves arc metadata.
            if (path.contours.length === 1) {
                const circleInfo = this.detectCircleContour(path.contours[0]);
                if (circleInfo) {
                    this.debug(`Redirecting circle-path ${path.id} to analytic offsetCircle (r=${circleInfo.radius.toFixed(3)})`);
                    return this.offsetCircle(circleInfo, distance);
                }
            }

            // Centerline paths bypass standard offsetting
            if (path.properties?.isCenterlinePath) {
                return new PathPrimitive(path.contours, {
                    ...path.properties,
                    isOffset: true,
                    offsetDistance: distance,
                    offsetType: 'on',
                    closed: false
                });
            }

            // The Safeguard: Check for complex arc geometry
            const containsArcs = this.hasAnalyticArcs(path);

            // Route to Boolean Inflating if: It has arcs, globally force boolean, or the analytic offset module is missing
            if (containsArcs || this.USE_INFLATE_OFFSETTING || !this.analyticOffsetter) {
                this.debug(`Routing path ${path.id} to Boolean Inflated Offsetter (containsArcs: ${containsArcs})`);
                return await this.offsetPathViaBoolean(path, distance);
            }

            // Loud warning, geometry shouldn't be reaching this stage until Analytic offsetting is finalized.
            throw new Error('[Offsetter] Analytic path offsetting is not implemented; set USE_INFLATE_OFFSETTING = true.');
        }

        /**
         * Boolean offset: builds a stroke-width boundary ring using optimized overlapping shapes, then extracts the outer contour (external offset) or hole contour (internal offset) from the ring.
         */
        async offsetPathViaBoolean(path, distance) {
            if (!this.geometryProcessor) {
                console.warn('[Offsetter] GeometryProcessor required for boolean offsetting');
                return null;
            }

            const offsetDist = Math.abs(distance);
            const strokeWidth = offsetDist * 2;
            const isInternal = distance < 0;

            // Generate boundary strokes from contours
            const boundaryStrokes = [];

            for (const contour of path.contours) {
                // Pass the raw contour directly to the stroke generator.
                const strokes = GeometryUtils.closedContourToStrokePolygons(contour, strokeWidth);
                if (strokes && strokes.length > 0) {
                    boundaryStrokes.push(...strokes);
                }
            }

            if (boundaryStrokes.length === 0) return null;

            // Union all strokes into a thick offset ring
            const ring = await this.geometryProcessor.unionGeometry(boundaryStrokes);
            if (!ring || ring.length === 0) return null;

            // Boolean masking: use the original polygon as a mask.
            // Internal: Original MINUS Ring → shrinks polygon, drops false pockets.
            // External: Original UNION Ring → expands polygon outward.
            // Tessellate arc segments for Clipper2 (works with polygons only).
            const maskContours = path.contours.map(c => {
                const tessellated = GeometryUtils.contourArcsToPath(c);
                let points = tessellated.points;

                // Normalize to CCW - Clipper2 needs positive winding for subject polygons.
                // The isHole flag is already stripped, but CW-wound hole contours that were extracted into standalone primitives retain their original point order, causing winding cancellation during union.
                if (GeometryUtils.isClockwise(points)) {
                    points = points.slice().reverse();
                }

                return {
                    points: points,
                    isHole: false,
                    nestingLevel: 0,
                    parentId: null,
                    arcSegments: [],
                    curveIds: c.curveIds || []
                };
            });

            const originalMask = new PathPrimitive(maskContours, {
                ...path.properties,
                polarity: 'dark'
            });

            let resultPrimitives;

            if (isInternal) {
                resultPrimitives = await this.geometryProcessor.difference([originalMask], ring);
            } else {
                resultPrimitives = await this.geometryProcessor.unionGeometry([originalMask, ...ring]);
            }

            // Post-process (remove slivers)
            if (!resultPrimitives || resultPrimitives.length === 0) return null;

            resultPrimitives = this.postProcessBooleanResult(resultPrimitives, offsetDist);

            if (!resultPrimitives || resultPrimitives.length === 0) {
                this.debug('All results rejected by post-processing');
                return null;
            }

            // Tag results with offset metadata
            resultPrimitives.forEach(p => {
                if (!p.properties) p.properties = {};
                p.properties.isOffset = true;
                p.properties.offsetDistance = distance;
                p.properties.offsetType = isInternal ? 'internal' : 'external';
            });

            this.debug(`Boolean offset result: ${resultPrimitives.length} primitive(s) (${isInternal ? 'internal' : 'external'})`);
            return resultPrimitives;
        }

        /**
         * Post-processes boolean offset results with an area filter to reject slivers.
         */
        postProcessBooleanResult(primitives, offsetDist) {
            if (!primitives || primitives.length === 0) return primitives;

            // Minimum area filter: capped to avoid deleting intended tiny features
            const minArea = Math.min(offsetDist * offsetDist * 0.01, 0.0001);
            const cleaned = [];

            for (const prim of primitives) {
                if (!prim.contours || prim.contours.length === 0) continue;

                // Area filter rejects primitives whose outer contour is too small
                const outerContour = prim.contours.find(c => !c.isHole) || prim.contours[0];
                if (outerContour.points && outerContour.points.length >= 3) {
                    const area = Math.abs(GeometryUtils.calculateWinding(outerContour.points));
                    if (area < minArea) {
                        this.debug(`Post-process: rejected sliver (area ${area.toExponential(2)} < ${minArea.toExponential(2)})`);
                        continue;
                    }
                }

                // If it passed the area check, keep it exactly as Clipper output it
                cleaned.push(prim);
            }

            return cleaned;
        }

        /*
         * ANALYTIC SHAPE OFFSETTERS
         */

        offsetCircle(circle, distance) {
            const newRadius = circle.radius + distance;
            const isInternal = distance < 0;

            if (newRadius < PRECISION) {
                this.debug(`Circle collapsed: r=${newRadius.toFixed(4)}`);
                return null;
            }

            const offsetCirclePrimitive = new CirclePrimitive(circle.center, newRadius, { ...circle.properties });
            const offsetPath = GeometryUtils.primitiveToPath(offsetCirclePrimitive);

            if (!offsetPath || !offsetPath.contours || offsetPath.contours.length === 0) return null;

            offsetPath.properties = {
                ...offsetPath.properties,
                isOffset: true,
                offsetDistance: distance,
                offsetType: isInternal ? 'internal' : 'external',
                sourcePrimitiveId: circle.id,
            };

            // Provenance rides the side map, never the hashed record: generateHash
            // appends '_offset' for isOffsetDerived, so writing it back after
            // register() leaves the record and the hash indexing it disagreeing.
            const contour = offsetPath.contours[0];
            if (window.globalCurveRegistry && contour.curveIds) {
                const sourceCurveId = circle.properties?.originalCurveId
                    || (circle.curveIds ? circle.curveIds[0] : null);
                contour.curveIds.forEach(id => {
                    window.globalCurveRegistry.noteOffsetDerived(id, sourceCurveId, distance);
                });
            }

            return offsetPath;
        }

        offsetRectangle(rectangle, distance) {
            const { x, y } = rectangle.position;
            const w = rectangle.width;
            const h = rectangle.height;

            // Convert the rectangle into a standard closed Counter-Clockwise (CCW) path.
            const rectPoints = [
                { x: x,     y: y },
                { x: x + w, y: y },
                { x: x + w, y: y + h },
                { x: x,     y: y + h },
                { x: x,     y: y } // Explicitly close path
            ];

            const rectAsPath = new PathPrimitive([{
                points: rectPoints,
                isHole: false,
                nestingLevel: 0,
                parentId: null,
                arcSegments: [],
                curveIds: []
            }], {
                ...rectangle.properties,
                fill: true,
                closed: true
            });
            return this.offsetPath(rectAsPath, distance);
        }

        async offsetArc(arc, distance) {
            // Convert to path primitive
            const pathPrimitive = GeometryUtils.primitiveToPath(arc);
            if (!pathPrimitive) return null;

            return this.offsetPath(pathPrimitive, distance);
        }

        /**
         * Adapter over GeometryUtils.analyzeCircleRing: wraps a verified circular
         * contour into the minimal shape offsetCircle() consumes. The closure and
         * sweep clauses matter here - an all-one-curveId contour that the boolean
         * already clipped would otherwise be re-offset as a full circle.
         */
        detectCircleContour(contour) {
            if (!contour.points) return null;

            const ring = GeometryUtils.analyzeCircleRing(contour.points);
            if (!ring.isFullCircle) return null;

            return {
                type: 'circle',
                id: `circle_from_contour_${ring.curveId}`,
                center: { x: ring.center.x, y: ring.center.y },
                radius: ring.radius,
                properties: { polarity: contour.isHole ? 'clear' : 'dark' },
                curveIds: [ring.curveId],
                getBounds() {
                    return {
                        minX: this.center.x - this.radius,
                        minY: this.center.y - this.radius,
                        maxX: this.center.x + this.radius,
                        maxY: this.center.y + this.radius
                    };
                }
            };
        }

        offsetObround(obround, distance) {
            this.debug(`Offsetting obround by ${distance.toFixed(3)}mm.`);

            // Determine if the offset is internal (shrinking) or external (growing).
            const isInternal = distance < 0;

            // Calculate the dimensions and position of the new offset obround.
            const newWidth = obround.width + (distance * 2);
            const newHeight = obround.height + (distance * 2);
            const newPosition = {
                x: obround.position.x - distance,
                y: obround.position.y - distance
            };

            // Handle degenerate cases
            if (newWidth < PRECISION || newHeight < PRECISION) {
                this.debug(`Obround collapsed: ${newWidth.toFixed(3)}x${newHeight.toFixed(3)}`);
                return null;
            }

            // Create a new ObroundPrimitive
            const offsetObroundPrimitive = new ObroundPrimitive(newPosition, newWidth, newHeight, {
                ...obround.properties
            });

             // Convert this new analytic primitive into a PathPrimitive
            const offsetPath = GeometryUtils.primitiveToPath(offsetObroundPrimitive);
            if (!offsetPath || !offsetPath.contours || offsetPath.contours.length === 0) {
                return null;
            }

            // Add the required offset metadata to the final PathPrimitive.
            offsetPath.properties = {
                ...offsetPath.properties,
                isOffset: true,
                offsetDistance: distance,
                offsetType: isInternal ? 'internal' : 'external',
                sourcePrimitiveId: obround.id,
            };

            // Post-process the newly registered curve IDs to mark them as offset-derived.
            const contour = offsetPath.contours[0];
            if (window.globalCurveRegistry && contour.curveIds) {
                const sourceCurveId = obround.curveIds ? obround.curveIds[0] : null;
                contour.curveIds.forEach(id => {
                    window.globalCurveRegistry.noteOffsetDerived(id, sourceCurveId, distance);
                });
            }

            if (debugState.enabled) {
                const pointCount = contour.points.length;
                const curveCount = contour.curveIds?.length || 0;
                console.log(`Successfully created offset obround path with ${pointCount} points and ${curveCount} registered curves.`);
            }

            return offsetPath;
        }

        
        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GeometryOffsetter] ${message}`, data)
                 : console.log(`[GeometryOffsetter] ${message}`);
        }

    }

    window.GeometryOffsetter = GeometryOffsetter;
})();