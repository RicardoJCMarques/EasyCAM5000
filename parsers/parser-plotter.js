/*!
 * @file        parser/parser-plotter.js
 * @description Converts parsed objects into geometric primitives
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
     * Smart translator from parser analytic objects to primitives.
     * Tessellates only unsupported curve types.
     */
    class ParserPlotter {
        constructor(options = {}) {
            this.options = {
                debug: options.debug,
                markStrokes: options.markStrokes || false,
                ...options
            };
            this.reset();
        }

        plot(parserData) {
            if (parserData.layers) {
                return this.plotGerberData(parserData);
            } else if (parserData.drillData) {
                return this.plotExcellonData(parserData);
            }
            return { success: false, error: 'Invalid parser data format', primitives: [] };
        }

        plotGerberData(gerberData) {
            this.debug('Starting Gerber plotting')
            this.reset();

            this.apertures = new Map();
            if (gerberData.layers.apertures) {
                gerberData.layers.apertures.forEach(ap => this.apertures.set(ap.code, ap));
            }

            gerberData.layers.objects.forEach((obj, index) => {
                try {
                    const primitiveOrPrimitives = this.plotObject(obj);
                    if (primitiveOrPrimitives) {
                        const primArray = Array.isArray(primitiveOrPrimitives) ? 
                            primitiveOrPrimitives : [primitiveOrPrimitives];

                        // Implicit grouping for split shapes
                        // If one parser object (like an "i" or "j" compound path) was topologically 
                        // split into multiple distinct primitives, generate a group.
                        let implicitGroup = null;
                        if (primArray.length > 1) {
                            implicitGroup = {
                                uid: `implicit_g_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                                id: null,
                                label: 'Compound Shape'
                            };
                        }

                        primArray.forEach(prim => {
                            if (this.validatePrimitive(prim)) {
                                if (gerberData.layers.units === 'inch') {
                                    // Late scaling: apply metric conversion just before finalizing the primitive
                                    this.convertToMetric(prim); 
                                }

                                if (!prim.properties) prim.properties = {};

                                // EasyShape5000 groupPath propagation with implicit group injection
                                let currentGroupPath = obj.groupPath ? [...obj.groupPath] : [];

                                if (implicitGroup) {
                                    currentGroupPath.push(implicitGroup);
                                }

                                if (currentGroupPath.length > 0) {
                                    prim.properties.groupPath = currentGroupPath;
                                }

                                this.primitives.push(prim);
                                this.creationStats.primitivesCreated++;
                            }
                        });
                    }
                } catch (error) {
                    console.error(`Error plotting object ${index} (${obj.type}):`, error);
                }
            });

            // Fuse contiguous arcs before bounds calculation
            this.primitives = this.mergeContinuousArcs(this.primitives);

            this.calculateBounds();
            this.logStatistics();

            return {
                success: true,
                primitives: this.primitives,
                bounds: this.bounds,
                units: 'mm',
                creationStats: this.creationStats
            };
        }

        plotExcellonData(excellonData) {
            this.debug('Starting Excellon plotting');
            this.reset();

            const drillData = excellonData.drillData;

            if (drillData.holes) {
                drillData.holes.forEach((item, index) => {
                    let primitive = null;
                    const properties = { 
                        tool: item.tool, 
                        plated: item.plated, 
                        polarity: 'dark',
                        diameter: item.diameter
                    };

                    if (!item.start || !item.end) {
                        item.start = { ...(item.position || { x: 0, y: 0 }) };
                        item.end = { ...(item.position || { x: 0, y: 0 }) };
                    }

                    // Calculate distance between start and end
                    const dx = item.end.x - item.start.x;
                    const dy = item.end.y - item.start.y;
                    const lengthSq = dx * dx + dy * dy;
                    const radius = item.diameter / 2;

                    this.debug(`Plotter Input [${index}]: type=${item.type}, start=(${item.start.x.toFixed(3)}, ${item.start.y.toFixed(3)}), end=(${item.end.x.toFixed(3)}, ${item.end.y.toFixed(3)}), diameter=${item.diameter.toFixed(3)}, calculated length=${length.toFixed(5)}`);

                    if (lengthSq < PRECISION * PRECISION) {
                        // It's a hole
                        properties.role = 'drill_hole';
                        primitive = new CirclePrimitive(
                            item.start, 
                            radius,
                            properties
                        );
                        this.debug(`Plotter Output [${index}]: Creating drill_hole (length < ${PRECISION}mm)`);
                    } else {
                        // It's a slot
                        properties.role = 'drill_slot';
                        properties.originalSlot = { start: item.start, end: item.end };

                        // Calculate Bounding Box for Obround Primitive
                        const minX = Math.min(item.start.x, item.end.x) - radius;
                        const minY = Math.min(item.start.y, item.end.y) - radius;
                        const maxX = Math.max(item.start.x, item.end.x) + radius;
                        const maxY = Math.max(item.start.y, item.end.y) + radius;

                        primitive = new ObroundPrimitive(
                            { x: minX, y: minY }, // Position (bottom-left)
                            maxX - minX,          // Width
                            maxY - minY,          // Height
                            properties
                        );
                        this.debug(`Plotter Output [${index}]: Creating drill_slot (length >= ${PRECISION}mm)`);
                    }

                    if (primitive) {
                        // Late scaling: apply metric conversion just before finalizing the primitive
                        if (drillData.units === 'inch') {
                            this.convertToMetric(primitive);
                        }
                        this.primitives.push(primitive);
                        this.creationStats.primitivesCreated++;
                        this.creationStats.drillsCreated++;
                    }
                });
            }

            // If an excellon with arcs ever shows up, this is where a connection to mergeContinuousArcs should be included.

            this.calculateBounds();
            return {
                success: true,
                primitives: this.primitives,
                bounds: this.bounds,
                units: 'mm', // Units have by now been successfully converted
                creationStats: { drillHolesCreated: this.primitives.length }
            };
        }

        plotObject(obj) {
            switch (obj.type) {
                case 'region':
                    return this.plotRegion(obj);
                case 'trace':
                    return this.plotTrace(obj);
                case 'flash':
                    return this.plotFlash(obj);
                case 'draw':
                    return this.plotDraw(obj);
                default:
                    this.debug(`Unknown object type: ${obj.type}`);
                    return null;
            }
        }

        /**
         * Creates a single PathPrimitive with a full hierarchical contour list.
         * Winding determines polarity.
         */
        plotRegion(region) {
            const analyticSubpaths = region.analyticSubpaths;

            this.debug(`Received region with ${analyticSubpaths ? analyticSubpaths.length : 0} analytic subpaths.`);

            // Fallback for simple Gerber regions (no analytic data)
            if (!analyticSubpaths || analyticSubpaths.length === 0) {
                if (region.points && region.points.length > 0) {

                    // Pull arc metadata from the parser's contour structure if available
                    let arcSegments = region.contours?.[0]?.arcSegments || [];
                    let curveIds = region.contours?.[0]?.curveIds || [];

                    // Outer contours must be CCW (positive winding area)
                    const isCW = GeometryUtils.isClockwise(region.points);
                    if (isCW) {
                        region.points.reverse();

                        // Reverse arc metadata to match the new point order
                        if (arcSegments.length > 0) {
                            const n = region.points.length;
                            arcSegments = arcSegments.map(arc => ({
                                ...arc,
                                startIndex: (n - 1) - arc.endIndex,
                                endIndex: (n - 1) - arc.startIndex,
                                startAngle: arc.endAngle,
                                endAngle: arc.startAngle,
                                clockwise: !arc.clockwise
                            }));
                        }

                        this.debug(`Normalized Gerber fallback region to CCW (outer).`);
                    }

                    const contour = {
                        points: region.points,
                        nestingLevel: 0,
                        isHole: false,
                        parentId: null,
                        arcSegments: arcSegments,
                        curveIds: curveIds
                    };

                    const primitive = new PathPrimitive([contour], {
                        isRegion: true,
                        fill: true,
                        polarity: region.polarity || 'dark',
                        netName: region.netName || null,
                        closed: true
                    });

                    this.creationStats.regionsCreated++;
                    return primitive;
                }
                this.debug('Region object has no points or analytic subpaths', region);
                return null;
            }

            // Main Analytic Subpath Processing
            const contours = []; // This will be the final list of contours

            // Process each analytic subpath (contour)
            analyticSubpaths.forEach((segments, subpathIndex) => {

                const points = [];
                const arcSegments = [];

                // Handle simple point arrays (from polygon/polyline)
                if (segments.length > 0 && segments[0].x !== undefined) {
                    // Determine hole status from winding: in Y-up, CCW = positive area = outer
                    const isCW = GeometryUtils.isClockwise(segments);
                    const isHole = (analyticSubpaths.length > 1) ? isCW : false;

                    // Enforce: outer=CCW, hole=CW
                    if (!isHole && isCW) {
                        segments.reverse();
                    } else if (isHole && !isCW) {
                        segments.reverse();
                    }

                    contours.push({
                        points: segments,
                        isHole: isHole,
                        nestingLevel: isHole ? 1 : 0, // Simple nesting
                        parentId: isHole ? 0 : null,
                        arcSegments: [],
                        curveIds: []
                    });
                    return; // Done with this subpath
                }

                if (segments.length === 0) return;

                // Stitch analytic segments (line, arc, bezier)
                segments.forEach((seg, segIndex) => {
                    if (seg.type === 'move') {
                        if (points.length > 0) {
                            // This case should ideally not happen in a single subpath
                            console.warn("[Plotter] Found 'move' inside a subpath, data may be lost.");
                            points.length = 0;
                            arcSegments.length = 0;
                        }
                        points.push(seg.p);
                        return;
                    }
                    if (seg.type === 'point_array') {
                        if (seg.points && seg.points.length > 0) {
                            if (points.length > 0) {
                                points.push(...seg.points.slice(1));
                            } else {
                                points.push(...seg.points);
                            }
                        }
                        return;
                    }
                    const p0 = points.length > 0 ? points[points.length - 1] : seg.p0;
                    if (points.length === 0) {
                        points.push(p0);
                    }
                    switch (seg.type) {
                        case 'line':
                            points.push(seg.p1);
                            break;
                        case 'arc':
                            if (Math.abs(seg.rx - seg.ry) < PRECISION && Math.abs(seg.phi) < PRECISION) {
                                // This is a circular arc - register it
                                let curveId = null;
                                if (window.globalCurveRegistry) {
                                    curveId = window.globalCurveRegistry.register({
                                        type: 'arc',
                                        center: { x: seg.center.x, y: seg.center.y },
                                        radius: seg.rx,
                                        startAngle: seg.startAngle,
                                        endAngle: seg.endAngle,
                                        clockwise: seg.clockwise,
                                        source: 'svg_parser'
                                    });
                                }

                                // Capture start index before adding endpoint
                                const arcStartIndex = points.length - 1;

                                // Explicitly tag the start point
                                if (curveId) points[arcStartIndex].curveId = curveId;

                                // Add the endpoint
                                const taggedEndpoint = { ...seg.p1 };
                                if (curveId) taggedEndpoint.curveId = curveId;
                                points.push(taggedEndpoint);

                                // Capture end index after adding endpoint
                                const arcEndIndex = points.length - 1;

                                // Create arc segment with both indices
                                arcSegments.push({
                                    startIndex: arcStartIndex,
                                    endIndex: arcEndIndex,
                                    center: seg.center, 
                                    radius: seg.rx,
                                    startAngle: seg.startAngle, 
                                    endAngle: seg.endAngle,
                                    sweepAngle: seg.sweepAngle,
                                    clockwise: seg.clockwise,
                                    curveId: curveId
                                });
                            } else {
                                // This is an elliptical arc, tessellate it
                                const tessellated = GeometryUtils.tessellateEllipticalArc(
                                    p0, seg.p1, seg.rx, seg.ry,
                                    seg.phi, seg.fA, seg.fS
                                );
                                points.push(...tessellated.slice(1));
                            }
                            break;
                        case 'cubic': {
                            if (this.isBezierStraightLine(p0, seg.p1, seg.p2, seg.p3)) {
                                points.push(seg.p3);
                                break;
                            }
                            const cubicArc = this.tryBezierToArc(p0, seg.p1, seg.p2, seg.p3);
                            if (cubicArc) {
                                this.debug(`Converted cubic Bézier to round arc: r=${cubicArc.radius.toFixed(3)}, sweep=${(cubicArc.sweepAngle * 180 / Math.PI).toFixed(1)}°`);
                                this.registerDetectedArc(points, arcSegments, seg.p3, cubicArc, 'bezier_cubic_detect');
                            } else {
                                const tessCubic = GeometryUtils.tessellateCubicBezier(
                                    p0, seg.p1, seg.p2, seg.p3
                                );
                                points.push(...tessCubic.slice(1));
                            }
                            break;
                        }
                        case 'quad': {
                            if (this.isBezierStraightLine(p0, seg.p1, seg.p2)) {
                                points.push(seg.p2);
                                break;
                            }
                            const quadArc = this.tryQuadBezierToArc(p0, seg.p1, seg.p2);
                            if (quadArc) {
                                this.debug(`Converted quadratic Bézier to round arc: r=${quadArc.radius.toFixed(3)}, sweep=${(quadArc.sweepAngle * 180 / Math.PI).toFixed(1)}°`);
                                this.registerDetectedArc(points, arcSegments, seg.p2, quadArc, 'bezier_quad_detect');
                            } else {
                                const tessQuad = GeometryUtils.tessellateQuadraticBezier(
                                    p0, seg.p1, seg.p2
                                );
                                points.push(...tessQuad.slice(1));
                            }
                            break;
                        }
                    }
                });

                if (!debugState && points.length > 0) {
                    let maxCoord = 0;
                    let maxIdx = 0;
                    points.forEach((p, i) => {
                        const m = Math.max(Math.abs(p.x), Math.abs(p.y));
                        if (m > maxCoord) { maxCoord = m; maxIdx = i; }
                    });
                    if (maxCoord > 300) {
                        console.error(`[PARSER-PLOTTER] POSSIBLE CORRUPTION: ${points.length} pts, worst point[${maxIdx}]:`, 
                            points[maxIdx], 'neighbors:', points[maxIdx-1], points[maxIdx+1]);
                    } else {
                        this.debug(`[PARSER-PLOTTER] OK: ${points.length} pts, max coord: ${maxCoord.toFixed(2)}`);
                    }
                }

                if (points.length > 0) {

                    let isCW = GeometryUtils.isClockwise(points);
                    let isHole;

                    if (analyticSubpaths.length > 1) {
                        // Compound path: CW = hole (negative area in Y-up)
                        // TODO: [WINDING-HIERARCHY] This blindly assumes CW = hole. 
                        // Disjoint outer paths (e.g., dot of an 'i') will be falsely flagged as holes here due to Y-flip.
                        // Review replacing this assignment with a spatial/topological check later.
                        isHole = isCW;
                    } else {
                        isHole = false;
                    }

                    const contourObj = {
                        points: points,
                        isHole: isHole,
                        nestingLevel: isHole ? 1 : 0,
                        parentId: isHole ? 0 : null,
                        arcSegments: arcSegments,
                        curveIds: arcSegments.map(a => a.curveId).filter(Boolean)
                    };

                    // Enforce: outer=CCW, hole=CW
                    if (!isHole && isCW) {
                        GeometryUtils.reverseContourWinding(contourObj);
                        isCW = false;
                        this.debug(`Normalized outer contour to CCW.`);
                    } else if (isHole && !isCW) {
                        GeometryUtils.reverseContourWinding(contourObj);
                        isCW = true;
                        this.debug(`Normalized hole contour to CW.`);
                    }

                    this.debug(`Processed subpath #${subpathIndex} (of ${analyticSubpaths.length}): ${contourObj.points.length} pts. Winding: ${isCW ? 'CW' : 'CCW'}. isHole: ${isHole}.`);
                    contours.push(contourObj);
                }
            }); 

            if (contours.length === 0) {
                return null; // No valid contours found
            }

            // Create a single PathPrimitive with the full contours list
            const rawPrimitive = new PathPrimitive(contours, {
                isRegion: region.fill !== false,
                fill: region.fill !== false,
                stroke: region.stroke || false,
                strokeWidth: region.strokeWidth || 0,
                polarity: region.polarity || 'dark',
                netName: region.netName || null,
                closed: region.closed !== false,
            });

            // Topological sorting and compound path splitting
            // Explodes the compound path, sorts by absolute area, builds a true nesting tree,
            // corrects winding, and reassembles distinct shapes into separate PathPrimitives.
            // This safely splits disjoint shapes (like 'i' dots) without destroying true hole topology.
            const resolvedPrimitives = GeometryUtils.resolveCompoundContours(rawPrimitive);

            // Update stats to reflect the actual number of distinct shapes generated
            this.creationStats.regionsCreated += resolvedPrimitives.length;

            return resolvedPrimitives; 
        }

        /**
         * Creates analytic primitives for traces
         */
        plotTrace(trace) {
            // Use strict undefined check instead of logical OR to allow 0-width traces
            const width = trace.width !== undefined ? trace.width : C.formats.gerber.defaultAperture;
            const properties = {
                isTrace: true,
                fill: false,
                stroke: true,
                strokeWidth: width,
                polarity: trace.polarity || 'dark',
                netName: trace.netName || null,
                aperture: trace.aperture,
                interpolation: trace.interpolation || 'linear',
                closed: false
            };
            
            if (this.options.markStrokes && width > 0) {
                properties.isStroke = true;
            }

            const interp = trace.interpolation;

            if (interp === 'bezier_cubic') {
                if (trace.points && trace.points.length === 4) {
                    // Straight line hiding as bezier
                    if (this.isBezierStraightLine(trace.points[0], trace.points[1], trace.points[2], trace.points[3])) {
                        this.creationStats.tracesCreated++;
                        const contour = {
                            points: [trace.points[0], trace.points[3]],
                            isHole: false, nestingLevel: 0, parentId: null,
                            arcSegments: [], curveIds: []
                        };
                        return new PathPrimitive([contour], properties);
                    }
                    const cubicArc = this.tryBezierToArc(trace.points[0], trace.points[1], trace.points[2], trace.points[3]);
                    if (cubicArc) {
                        this.debug('Converted cubic Bézier trace to ArcPrimitive');
                        this.creationStats.tracesCreated++;
                        this.creationStats.arcTraces++;
                        return new ArcPrimitive(
                            cubicArc.center, cubicArc.radius,
                            cubicArc.startAngle, cubicArc.endAngle,
                            cubicArc.clockwise, properties
                        );
                    }
                }
                this.debug('Creating BezierPrimitive (Cubic)');
                this.creationStats.tracesCreated++;
                return new BezierPrimitive(trace.points, properties);

            } else if (interp === 'bezier_quad') {
                if (trace.points && trace.points.length === 3) {
                    // Straight line hiding as bezier
                    if (this.isBezierStraightLine(trace.points[0], trace.points[1], trace.points[2])) {
                        this.creationStats.tracesCreated++;
                        const contour = {
                            points: [trace.points[0], trace.points[2]],
                            isHole: false, nestingLevel: 0, parentId: null,
                            arcSegments: [], curveIds: []
                        };
                        return new PathPrimitive([contour], properties);
                    }
                    const quadArc = this.tryQuadBezierToArc(trace.points[0], trace.points[1], trace.points[2]);
                    if (quadArc) {
                        this.debug('Converted quadratic Bézier trace to ArcPrimitive');
                        this.creationStats.tracesCreated++;
                        this.creationStats.arcTraces++;
                        return new ArcPrimitive(
                            quadArc.center, quadArc.radius,
                            quadArc.startAngle, quadArc.endAngle,
                            quadArc.clockwise, properties
                        );
                    }
                }
                this.debug('Creating BezierPrimitive (Quad)');
                this.creationStats.tracesCreated++;
                return new BezierPrimitive(trace.points, properties);

            } else if (interp === 'elliptical_arc') {
                this.debug('Creating EllipticalArcPrimitive');
                this.creationStats.tracesCreated++;
                this.creationStats.arcTraces++;
                return new EllipticalArcPrimitive(
                    trace.start, trace.end, trace.params, properties
                );

            } else if (interp === 'cw_arc' || interp === 'ccw_arc') {
                try {
                    const center = {
                        x: trace.start.x + trace.arc.i,
                        y: trace.start.y + trace.arc.j
                    };
                    const radius = Math.hypot(trace.arc.i, trace.arc.j);
                    const startAngle = Math.atan2(
                        trace.start.y - center.y,
                        trace.start.x - center.x
                    );
                    const endAngle = Math.atan2(
                        trace.end.y - center.y,
                        trace.end.x - center.x
                    );

                    // Data model is strictly Y-Up (Mathematical Cartesian).
                    // Do NOT pre-invert here. The renderer's matrix handles visual flipping.
                    const clockwise = trace.interpolation === 'cw_arc' || trace.clockwise === true;

                    this.creationStats.arcTraces++;
                    return new ArcPrimitive(
                        center, radius, startAngle, endAngle, clockwise, properties
                    );
                } catch (error) {
                    console.error('[Plotter] Failed to create ArcPrimitive:', error);
                    const contour = {
                        points: [trace.start, trace.end],
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: [],
                        curveIds: []
                    };
                    return new PathPrimitive([contour], properties);
                }

            } else if (interp === 'linear_path') {
                // From polygon/polyline stroke
                this.creationStats.tracesCreated++;
                if (trace.closed === false) properties.closed = false;
                const contour = {
                    points: trace.points,
                    isHole: false,
                    nestingLevel: 0,
                    parentId: null,
                    arcSegments: [],
                    curveIds: []
                };
                return new PathPrimitive([contour], properties);
            } else {
                // Default: linear trace
                this.creationStats.tracesCreated++;
                const contour = {
                    points: [trace.start, trace.end],
                    isHole: false,
                    nestingLevel: 0,
                    parentId: null,
                    arcSegments: [],
                    curveIds: []
                };
                return new PathPrimitive([contour], properties);
            }
        }

        /**
         * Creates analytic primitives for flashes
         */
        plotFlash(flash) {
            const properties = {
                isFlash: true,
                isPad: true,
                fill: flash.fill !== false,
                stroke: flash.stroke || false,
                strokeWidth: flash.strokeWidth,
                polarity: flash.polarity,
                netName: flash.netName || null,
                aperture: flash.aperture,
                shape: flash.shape
            };

            switch (flash.shape) {
                case 'circle':
                    this.creationStats.flashesCreated++;
                    return new CirclePrimitive(flash.position, flash.radius, properties);

                case 'rectangle':
                    this.creationStats.flashesCreated++;
                    return new RectanglePrimitive(
                        { x: flash.position.x - flash.width / 2, y: flash.position.y - flash.height / 2 },
                        flash.width, flash.height, properties
                    );

                case 'obround':
                    if (Math.abs(flash.width - flash.height) < PRECISION) {
                        this.creationStats.circularObrounds++;
                        this.creationStats.flashesCreated++;
                        return new CirclePrimitive(flash.position, flash.width / 2, properties);
                    }
                    this.creationStats.strokedObrounds++;
                    this.creationStats.flashesCreated++;
                    return new ObroundPrimitive(
                        { x: flash.position.x - flash.width / 2, y: flash.position.y - flash.height / 2 },
                        flash.width, flash.height, properties
                    );

                case 'polygon':
                    const contour = {
                        points: flash.points,
                        isHole: false,
                        nestingLevel: 0,
                        parentId: null,
                        arcSegments: flash.arcSegments || [],
                        curveIds: flash.arcSegments ? flash.arcSegments.map(a => a.curveId).filter(Boolean) : []
                    };
                    this.creationStats.flashesCreated++;
                    return new PathPrimitive([contour], { ...properties, closed: true });

                default:
                    console.warn(`Unknown flash shape: ${flash.shape}`);
                    this.creationStats.flashesCreated++;
                    return new CirclePrimitive(flash.position, 0.1, properties);
            }
        }

        plotDraw(draw) {
            if (!draw.aperture) return null;
            const aperture = this.apertures.get(draw.aperture);
            if (!aperture) return null;

            const trace = {
                type: 'trace',
                start: draw.start,
                end: draw.end,
                width: aperture.parameters[0] || 0.1,
                aperture: draw.aperture,
                polarity: draw.polarity,
                interpolation: draw.interpolation
            };

            if (draw.center) {
                trace.arc = {
                    i: draw.center.x - draw.start.x,
                    j: draw.center.y - draw.start.y
                };
                trace.clockwise = draw.interpolation === 'G02';
            }

            return this.plotTrace(trace);
        }

        convertToMetric(prim) {
            const scale = 25.4;

            // Scale core geometric properties
            if (prim.type === 'circle') {
                prim.center.x *= scale;
                prim.center.y *= scale;
                prim.radius *= scale;
            } else if (prim.type === 'arc') {
                prim.center.x *= scale;
                prim.center.y *= scale;
                prim.radius *= scale;
                prim.startPoint.x *= scale;
                prim.startPoint.y *= scale;
                prim.endPoint.x *= scale;
                prim.endPoint.y *= scale;
            } else if (prim.type === 'rectangle' || prim.type === 'obround') {
                if (prim.position) {
                    prim.position.x *= scale;
                    prim.position.y *= scale;
                }
                if (prim.width !== undefined) prim.width *= scale;
                if (prim.height !== undefined) prim.height *= scale;
            } 

            // Scale path contour arrays
            if (prim.contours) {
                prim.contours.forEach(c => {
                    c.points.forEach(p => { p.x *= scale; p.y *= scale; });
                    if (c.arcSegments) {
                        c.arcSegments.forEach(as => {
                            as.center.x *= scale; as.center.y *= scale; as.radius *= scale;
                        });
                    }
                });
            }

            // Scale attached physical properties (This fixes the hatch gap bug!)
            if (prim.properties) {
                if (prim.properties.strokeWidth !== undefined) {
                    prim.properties.strokeWidth *= scale;
                }
                if (prim.properties.diameter !== undefined) {
                    prim.properties.diameter *= scale;
                }
                if (prim.properties.originalDiameter !== undefined) {
                    prim.properties.originalDiameter *= scale;
                }
            }

            // Update bounds after scaling
            prim.calculateBounds();
        }

        validatePrimitive(primitive) {
            try {
                if (typeof primitive.getBounds !== 'function') return false;
                const bounds = primitive.getBounds();
                if (!isFinite(bounds.minX) || !isFinite(bounds.minY) ||
                    !isFinite(bounds.maxX) || !isFinite(bounds.maxY)) {
                    return false;
                }

                if (primitive.type === 'path') {
                    // A path is invalid if:
                    // The contours array itself is missing or empty.
                    if (!primitive.contours || primitive.contours.length === 0) {
                        return false;
                    }

                    // Not a *single* contour in the array has any points.
                    const hasAnyPoints = primitive.contours.some(
                        c => c.points && c.points.length > 0
                    );
                    if (!hasAnyPoints) {
                        return false;
                    }
                }

                if (primitive.type === 'circle' && 
                    (!primitive.center || !isFinite(primitive.radius) || 
                     primitive.radius <= 0)) {
                    return false;
                }

                return true;
            } catch (error) {
                return false;
            }
        }

        mergeContinuousArcs(primitives) {
            const TOL = C.precision.coordinate;
            const result = [];
            const standaloneArcs = [];

            // Separate ArcPrimitives from paths and other geometry
            for (const prim of primitives) {
                if (prim.type === 'arc') {
                    standaloneArcs.push(prim);
                } else if (prim.type === 'path' && prim.contours) {
                    // Process arcSegments embedded inside PathPrimitive contours
                    this.mergePathContourArcs(prim, TOL);
                    result.push(prim);
                } else {
                    result.push(prim);
                }
            }

            if (standaloneArcs.length === 0) return result;

            // Group standalone arcs spatially by Center, Radius, Width, and Polarity
            const buckets = new Map();
            for (const arc of standaloneArcs) {
                const width = arc.properties?.strokeWidth || 0;
                const polarity = arc.properties?.polarity || 'dark';
                const key = `${arc.center.x.toFixed(3)}_${arc.center.y.toFixed(3)}_${arc.radius.toFixed(3)}_${width.toFixed(3)}_${polarity}`;
                
                if (!buckets.has(key)) {
                    buckets.set(key, []);
                }
                buckets.get(key).push(arc);
            }

            // Chain connecting arcs within each bucket
            for (const [key, bucketArcs] of buckets) {
                const visited = new Set();

                for (let i = 0; i < bucketArcs.length; i++) {
                    if (visited.has(i)) continue;

                    let current = bucketArcs[i];
                    visited.add(i);
                    let totalSweep = this.getArcSweep(current);
                    let closedAsCircle = false;

                    let mergedInPass = true;
                    while (mergedInPass) {
                        mergedInPass = false;
                        for (let j = 0; j < bucketArcs.length; j++) {
                            if (visited.has(j)) continue;

                            const next = bucketArcs[j];
                            if (current.clockwise !== next.clockwise) continue;

                            // Distance between current end and next start
                            const distSq = Math.pow(current.endPoint.x - next.startPoint.x, 2) + 
                                        Math.pow(current.endPoint.y - next.startPoint.y, 2);

                            if (distSq < TOL * TOL) {
                                const nextSweep = this.getArcSweep(next);
                                const combinedSweep = Math.abs(totalSweep + nextSweep);

                                // Check if combined sweep completes a 360-degree circle (2 * PI)
                                if (Math.abs(combinedSweep - 2 * Math.PI) < TOL) {
                                    const circleProps = {
                                        ...current.properties,
                                        isTrace: true,
                                        stroke: true,
                                        strokeWidth: current.properties?.strokeWidth || 0
                                    };
                                    result.push(new CirclePrimitive(current.center, current.radius, circleProps));
                                    
                                    visited.add(j);
                                    closedAsCircle = true;
                                    mergedInPass = false;
                                    break;
                                } 
                                // Partial merge (still an open arc)
                                else if (combinedSweep < 2 * Math.PI - TOL) {
                                    current = new ArcPrimitive(
                                        current.center,
                                        current.radius,
                                        current.startAngle,
                                        next.endAngle,
                                        current.clockwise,
                                        current.properties
                                    );
                                    totalSweep += nextSweep;
                                    visited.add(j);
                                    mergedInPass = true;
                                    break;
                                }
                            }
                        }
                    }

                    if (!closedAsCircle) {
                        result.push(current);
                    }
                }
            }

            return result;
        }

        /**
         * Calculates signed sweep angle for an ArcPrimitive
         */
        getArcSweep(arc) {
            let sweep = arc.endAngle - arc.startAngle;
            if (arc.clockwise && sweep > 0) sweep -= 2 * Math.PI;
            if (!arc.clockwise && sweep < 0) sweep += 2 * Math.PI;
            return sweep;
        }

        /**
         * Helper to handle internal arcSegments within PathPrimitives
         */
        mergePathContourArcs(pathPrimitive, TOL) {
            pathPrimitive.contours.forEach(contour => {
                if (!contour.arcSegments || contour.arcSegments.length < 2) return;

                const mergedArcs = [];
                // Sort by start index to ensure perimeter is walked sequentially
                const sortedArcs = contour.arcSegments.slice().sort((a, b) => a.startIndex - b.startIndex);

                for (const arc of sortedArcs) {
                    if (mergedArcs.length === 0) {
                        mergedArcs.push(arc);
                        continue;
                    }

                    const prev = mergedArcs[mergedArcs.length - 1];
                    const sameCenter = Math.abs(prev.center.x - arc.center.x) < TOL &&
                                    Math.abs(prev.center.y - arc.center.y) < TOL;
                    const sameRadius = Math.abs(prev.radius - arc.radius) < TOL;
                    const sameWinding = prev.clockwise === arc.clockwise;
                    const isContiguous = prev.endIndex === arc.startIndex;

                    if (sameCenter && sameRadius && sameWinding && isContiguous) {
                        let sweep1 = prev.sweepAngle !== undefined ? prev.sweepAngle : (prev.endAngle - prev.startAngle);
                        if (prev.clockwise && sweep1 > 0) sweep1 -= 2 * Math.PI;
                        if (!prev.clockwise && sweep1 < 0) sweep1 += 2 * Math.PI;

                        let sweep2 = arc.sweepAngle !== undefined ? arc.sweepAngle : (arc.endAngle - arc.startAngle);
                        if (arc.clockwise && sweep2 > 0) sweep2 -= 2 * Math.PI;
                        if (!arc.clockwise && sweep2 < 0) sweep2 += 2 * Math.PI;

                        const totalSweep = sweep1 + sweep2;

                        if (Math.abs(totalSweep) < 2 * Math.PI - TOL) {
                            prev.endIndex = arc.endIndex;
                            prev.endAngle = arc.endAngle;
                            prev.sweepAngle = totalSweep;

                            // Re-assign Curve ID for All encompassed points
                            for (let pIdx = arc.startIndex; pIdx <= arc.endIndex; pIdx++) {
                                if (contour.points[pIdx]) {
                                    contour.points[pIdx].curveId = prev.curveId;
                                }
                            }

                            // Update Global Curve Registry
                            if (window.globalCurveRegistry && prev.curveId) {
                                const regCurve = window.globalCurveRegistry.getCurve(prev.curveId);
                                if (regCurve) {
                                    regCurve.endAngle = prev.endAngle;
                                    regCurve.sweepAngle = prev.sweepAngle;
                                }
                            }
                            continue;
                        }
                    }
                    mergedArcs.push(arc);
                }
                contour.arcSegments = mergedArcs;
            });
        }

        /**
         * Detects cubic or quadratic Béziers that are actually straight lines.
         * Checks if all control points are collinear with the chord.
         *
         * @param {{x,y}} p0 - Start point
         * @param {{x,y}} p1 - First control point (quad) or first control (cubic)
         * @param {{x,y}} p2 - End point (quad) or second control (cubic)
         * @param {{x,y}} [p3] - End point (cubic only; omit for quadratic)
         * @returns {boolean}
         */
        isBezierStraightLine(p0, p1, p2, p3) {
            const end = p3 || p2;
            const tolSq = PRECISION * PRECISION;
            const d1Sq = GeometryUtils.getSqDistToSegment(p1, p0, end);
            if (d1Sq >= tolSq) return false;
            if (p3) {
                const d2Sq = GeometryUtils.getSqDistToSegment(p2, p0, p3);
                if (d2Sq >= tolSq) return false;
            }
            return true;
        }

        /**
         * Attempts to identify a cubic Bézier as a circular arc.
         * Finds the candidate center from the intersection of perpendicular
         * normals at the two endpoints, then validates by sampling the curve.
         *
         * @param {{x,y}} p0 - Start point
         * @param {{x,y}} p1 - First control point
         * @param {{x,y}} p2 - Second control point
         * @param {{x,y}} p3 - End point
         * @returns {Object|null} Arc parameters or null if not a circular arc
         */
        // REVIEW - May require extra coordinate precision or tighter margins, line test has some artifacts
        tryBezierToArc(p0, p1, p2, p3) {
            // Tangent vectors at endpoints
            let t0x = p1.x - p0.x, t0y = p1.y - p0.y;
            let t1x = p3.x - p2.x, t1y = p3.y - p2.y;

            // Recover tangent from higher-order terms when control point sits on endpoint
            if (t0x * t0x + t0y * t0y < 1e-20) {
                t0x = p2.x - p0.x; t0y = p2.y - p0.y;
            }
            if (t1x * t1x + t1y * t1y < 1e-20) {
                t1x = p3.x - p1.x; t1y = p3.y - p1.y;
            }

            if (t0x * t0x + t0y * t0y < 1e-20 ||
                t1x * t1x + t1y * t1y < 1e-20) return null;

            // Collinearity check - reject if it's effectively a straight line
            const d1Sq = GeometryUtils.getSqDistToSegment(p1, p0, p3);
            const d2Sq = GeometryUtils.getSqDistToSegment(p2, p0, p3);
            if (d1Sq < PRECISION * PRECISION && d2Sq < PRECISION * PRECISION) {
                return null;
            }

            // Normals perpendicular to tangents (rotated 90° CCW)
            const n0x = -t0y, n0y = t0x;
            const n1x = -t1y, n1y = t1x;

            // Intersect normal lines: P0 + s·N0 = P3 + t·N1
            const denom = n0x * n1y - n0y * n1x;

            let center;
            if (Math.abs(denom) < 1e-12) {
                // Tangent normals are parallel - 180° arc.
                // Center lies at the chord midpoint.
                center = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
            } else {
                const dx = p3.x - p0.x, dy = p3.y - p0.y;
                if (dx * dx + dy * dy < PRECISION * PRECISION) return null;
                const s = (dx * n1y - dy * n1x) / denom;
                center = { x: p0.x + s * n0x, y: p0.y + s * n0y };
            }

            // Validate equal radii
            const r0 = Math.hypot(p0.x - center.x, p0.y - center.y);
            const r1 = Math.hypot(p3.x - center.x, p3.y - center.y);
            if (r0 < 1e-9 || r0 > 20000) return null;

            const tol = Math.max(PRECISION, r0 * 0.004); // REVIEW - Changing the 0.004 tolerance can have unpredictable results in round arc bezier translation to arc primitives
            if (Math.abs(r0 - r1) > tol) return null;

            // Refit center onto the perpendicular bisector of the chord so
            // |center-p0| == |center-p3| exactly.
            const midX = (p0.x + p3.x) / 2, midY = (p0.y + p3.y) / 2;
            const chordDx = p3.x - p0.x, chordDy = p3.y - p0.y;
            const chordLenSq = chordDx * chordDx + chordDy * chordDy;
            if (chordLenSq > 1e-18) {
                const chordLen = Math.sqrt(chordLenSq);
                const nx = -chordDy / chordLen, ny = chordDx / chordLen;
                const t = (center.x - midX) * nx + (center.y - midY) * ny;
                center.x = midX + t * nx;
                center.y = midY + t * ny;
            }
            const radius = Math.hypot(p0.x - center.x, p0.y - center.y);

            // Sample the Bézier and verify distance from center
            for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
                const mt = 1 - t;
                const mt2 = mt * mt, mt3 = mt2 * mt;
                const t2 = t * t, t3 = t2 * t;
                const bx = mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x;
                const by = mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y;
                const dist = Math.hypot(bx - center.x, by - center.y);
                if (Math.abs(dist - radius) > tol) return null;
            }

            const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x);
            const endAngle = Math.atan2(p3.y - center.y, p3.x - center.x);

            // Winding: cross product of radial x tangent at start
            const rx = p0.x - center.x, ry = p0.y - center.y;
            const cross = rx * t0y - ry * t0x;
            const clockwise = cross < 0;

            let sweepAngle = endAngle - startAngle;
            if (clockwise && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
            if (!clockwise && sweepAngle < 0) sweepAngle += 2 * Math.PI;

            return { center, radius, startAngle, endAngle, clockwise, sweepAngle };
        }

        /**
         * Attempts to identify a quadratic Bézier as a circular arc.
         * Same normal-intersection + sampling approach as cubic.
         *
         * @param {{x,y}} p0 - Start point
         * @param {{x,y}} p1 - Control point
         * @param {{x,y}} p2 - End point
         * @returns {Object|null} Arc parameters or null
         */
        tryQuadBezierToArc(p0, p1, p2) {
            let t0x = p1.x - p0.x, t0y = p1.y - p0.y;
            let t1x = p2.x - p1.x, t1y = p2.y - p1.y;

            // Recover tangent from chord when control point sits on endpoint
            if (t0x * t0x + t0y * t0y < 1e-20) {
                t0x = p2.x - p0.x; t0y = p2.y - p0.y;
            }
            if (t1x * t1x + t1y * t1y < 1e-20) {
                t1x = p2.x - p0.x; t1y = p2.y - p0.y;
            }

            if (t0x * t0x + t0y * t0y < 1e-20 ||
                t1x * t1x + t1y * t1y < 1e-20) return null;

            // Collinearity check
            const d1Sq = GeometryUtils.getSqDistToSegment(p1, p0, p2);
            if (d1Sq < PRECISION * PRECISION) {
                return null;
            }

            const n0x = -t0y, n0y = t0x;
            const n1x = -t1y, n1y = t1x;

            const denom = n0x * n1y - n0y * n1x;

            let center;
            if (Math.abs(denom) < 1e-12) {
                center = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 };
            } else {
                const dx = p2.x - p0.x, dy = p2.y - p0.y;
                if (dx * dx + dy * dy < PRECISION * PRECISION) return null;
                const s = (dx * n1y - dy * n1x) / denom;
                center = { x: p0.x + s * n0x, y: p0.y + s * n0y };
            }

            const r0 = Math.hypot(p0.x - center.x, p0.y - center.y);
            const r1 = Math.hypot(p2.x - center.x, p2.y - center.y);
            if (r0 < 1e-9 || r0 > 20000) return null;

            const tol = Math.max(PRECISION, r0 * 0.004);
            if (Math.abs(r0 - r1) > tol) return null;

            // Refit center onto perpendicular bisector
            const midX = (p0.x + p2.x) / 2, midY = (p0.y + p2.y) / 2;
            const chordDx = p2.x - p0.x, chordDy = p2.y - p0.y;
            const chordLenSq = chordDx * chordDx + chordDy * chordDy;
            if (chordLenSq > 1e-18) {
                const chordLen = Math.sqrt(chordLenSq);
                const nx = -chordDy / chordLen, ny = chordDx / chordLen;
                const t = (center.x - midX) * nx + (center.y - midY) * ny;
                center.x = midX + t * nx;
                center.y = midY + t * ny;
            }
            const radius = Math.hypot(p0.x - center.x, p0.y - center.y);

            for (const t of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
                const mt = 1 - t;
                const bx = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x;
                const by = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y;
                const dist = Math.hypot(bx - center.x, by - center.y);
                if (Math.abs(dist - radius) > tol) return null;
            }

            const startAngle = Math.atan2(p0.y - center.y, p0.x - center.x);
            const endAngle = Math.atan2(p2.y - center.y, p2.x - center.x);

            const rx = p0.x - center.x, ry = p0.y - center.y;
            const cross = rx * t0y - ry * t0x;
            const clockwise = cross < 0;

            let sweepAngle = endAngle - startAngle;
            if (clockwise && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
            if (!clockwise && sweepAngle < 0) sweepAngle += 2 * Math.PI;

            return { center, radius, startAngle, endAngle, clockwise, sweepAngle };
        }

        /**
         * Registers a detected arc in the contour's points and arcSegments arrays.
         * Shared by native SVG arcs and Bézier-converted arcs in plotRegion.
         *
         * @param {Array} points - Contour point accumulator (last entry is arc start)
         * @param {Array} arcSegments - Arc metadata accumulator
         * @param {{x,y}} endpoint - Arc endpoint to push
         * @param {Object} arc - Result from tryBezierToArc/tryQuadBezierToArc
         * @param {string} source - Curve registry source tag
         */
        registerDetectedArc(points, arcSegments, endpoint, arc, source) {
            let curveId = null;
            if (window.globalCurveRegistry) {
                curveId = window.globalCurveRegistry.register({
                    type: 'arc',
                    center: { x: arc.center.x, y: arc.center.y },
                    radius: arc.radius,
                    startAngle: arc.startAngle,
                    endAngle: arc.endAngle,
                    clockwise: arc.clockwise,
                    source: source
                });
            }

            const arcStartIndex = points.length - 1;
            if (curveId) points[arcStartIndex].curveId = curveId;

            const taggedEndpoint = { ...endpoint };
            if (curveId) taggedEndpoint.curveId = curveId;
            points.push(taggedEndpoint);

            const arcEndIndex = points.length - 1;

            arcSegments.push({
                startIndex: arcStartIndex,
                endIndex: arcEndIndex,
                center: arc.center,
                radius: arc.radius,
                startAngle: arc.startAngle,
                endAngle: arc.endAngle,
                sweepAngle: arc.sweepAngle,
                clockwise: arc.clockwise,
                curveId: curveId
            });
        }

        calculateBounds() {
            if (this.primitives.length === 0) {
                this.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                return;
            }

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            this.primitives.forEach(primitive => {
                const bounds = primitive.getBounds();
                if (!isFinite(bounds.minX)) return;

                minX = Math.min(minX, bounds.minX);
                minY = Math.min(minY, bounds.minY);
                maxX = Math.max(maxX, bounds.maxX);
                maxY = Math.max(maxY, bounds.maxY);
            });

            this.bounds = { minX, minY, maxX, maxY };
        }

        reset() {
            this.primitives = [];
            this.bounds = null;
            this.creationStats = {
                regionsCreated: 0,
                tracesCreated: 0,
                flashesCreated: 0,
                drillsCreated: 0,
                primitivesCreated: 0,
                regionPointCounts: [],
                traceLengths: [],
                circularObrounds: 0,
                strokedObrounds: 0,
                arcTraces: 0
            };
        }

        logStatistics() {
            if (!this.debug) return;

            this.debug('Plotting Statistics:');
            this.debug(`  Regions: ${this.creationStats.regionsCreated}`);
            this.debug(`  Traces: ${this.creationStats.tracesCreated}`);
            this.debug(`    Arc traces: ${this.creationStats.arcTraces}`);
            this.debug(`  Flashes: ${this.creationStats.flashesCreated}`);
            this.debug(`  Drills: ${this.creationStats.drillsCreated}`);
            this.debug(`  Total primitives: ${this.creationStats.primitivesCreated}`);
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[ParserPlotter] ${message}`, data)
                 : console.log(`[ParserPlotter] ${message}`);
        }
    }

    window.ParserPlotter = ParserPlotter;
})();