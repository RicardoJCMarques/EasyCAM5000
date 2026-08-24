/*!
 * @file        operations/offset-operation-handler.js
 * @description Shared offset pipeline for all contour-based operations
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const PRECISION = window.CAMConfig.constants.precision.coordinate;
    const maxPasses = 500; // Arbitrary - Change if needed

    /**
     * Owns the full topology-aware offset pipeline (boolean unions,
     * differences, arc reconstruction, simplification).
     * Subclasses override hook methods for operation-specific behavior.
     */
    class OffsetOperationHandler extends BaseOperationHandler {

        // HOOKS (override in subclasses)

        /**
         * Whether offsets grow inward (clearing) or outward (isolation).
         * Base implementation respects settings.cutSide for cutout/drill compatibility.
         */
        isInternalOffset(operation, settings) {
            return settings.cutSide === 'inside';
        }

        /**
         * Whether tool follows the geometry line with zero offset.
         */
        isOnLine(operation, settings) {
            return settings.cutSide === 'on';
        }

        /**
         * Whether to skip a primitive during offset generation.
         * Base skips drill holes/slots in CNC mode (laser processes everything).
         */
        shouldSkipPrimitive(primitive, settings) {
            if (settings.clearStrategy !== undefined) return false;
            return primitive.properties?.role === 'drill_hole' ||
                   primitive.properties?.role === 'drill_slot';
        }

        /**
         * Whether the pre-flight circle-collapse guard should run.
         * The guard prevents internal offsets from collapsing small circular
         * features (e.g. drill pads in EasyTrace copper layers). Pocket
         * operations override to false because internal collapse IS the
         * intended termination condition.
         */
        shouldGuardCircleCollapse() {
            return true;
        }

        /**
         * Whether this operation runs on copper layers, where stroke
         * primitives (traces) must be expanded rather than boundary-offset.
         * Isolation and clearing override to true.
         */
        // REVIEW - This partially broke some kinds of SVG geometry in EasyTrace5000
        isCopperOperation() {
            return false;
        }

        /**
         * Returns the clearance zone for filled/hatch laser strategies.
         * Override in TraceIsolationHandler and TraceClearingHandler.
         */
        async getClearanceZone(operation, settings) {
            return null;
        }

        // ORCHESTRATION

        async orchestrateGeneration(operation, params, core, options = {}) {
            // Stale-run token + structured progress + state reset
            const token = this.beginRun(operation, options, core);

            const resolved = this.resolveSourceTopology(operation, params);
            if (resolved) operation.primitives = resolved;

            // Compile parameters
            const opParams = core.compileOperationParams(operation, params);

            if (opParams.isLaser) {
                operation.clearancePolygon = null;
                await this.generateLaserFills(operation, opParams);
            } else {
                await this.generateGeometry(operation, { ...params, ...opParams });
            }

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation superseded by a newer request', status: 'warning' };
            }

            const total = operation.offsets?.reduce((s, o) => s + (o.primitives?.length || 0), 0) || 0;
            const passCount = operation.offsets?.length || 0;

            if (total === 0) {
                return { success: false, message: 'No geometry generated - tool may be too large for features', status: 'warning' };
            }

            if (opParams.isLaser) {
                const strategy = opParams.clearStrategy || 'offset';

                // CORE handles its own state
                operation.exportReady = true;
                this.stampExportMetadata(operation, strategy);
                
                return { success: true, message: `Generated ${total} laser path(s) [${strategy}]`, status: 'success' };
            }

            return { success: true, message: `Generated ${passCount} offset(s)`, status: 'success' };
        }

        /**
         * Ensures every primitive in the operation has a dense sourceId.
         * EasyShape stamps these upstream (OperationBucket.syncPrimitives).
         * This is the universal fallback for EasyTrace and any pipeline
         * that reaches generateGeometry without pre-stamped identity.
         */
        ensureSourceIds(primitives) {
            if (!primitives || primitives.length === 0) return;

            // Continue from the highest existing id so EasyShape's
            // pre-stamped ids are never overwritten or duplicated.
            let maxId = 0;
            for (const prim of primitives) {
                const id = prim.properties?.sourceId || 0;
                if (id > maxId) maxId = id;
            }

            let stamped = 0;
            for (const prim of primitives) {
                if (prim.properties?.sourceId > 0) continue;
                const id = ++maxId;
                (prim.properties ||= {}).sourceId = id;
                stamped++;
            }

            if (stamped > 0) {
                this.debug(`ensureSourceIds: stamped ${stamped} primitive(s) (ids ${maxId - stamped + 1}..${maxId})`);
            }
        }

        /**
         * Pre-compute a centroid/bounds index from the operation's source
         * primitives. Used by attributeShapeKey for fast spatial lookup.
         */
        buildSourceIndex(primitives) {
            const index = [];
            for (const prim of primitives) {
                const id = prim.properties?.sourceId;
                if (!id || id <= 0) continue;
                const b = prim.getBounds();
                if (!b) continue;
                index.push({
                    id,
                    bounds: b,
                    cx: (b.minX + b.maxX) / 2,
                    cy: (b.minY + b.maxY) / 2
                });
            }
            return index;
        }

        /**
         * Geometric re-attribution: which source shape does this offset
         * polygon belong to? Uses centroid proximity with a bounds-overlap
         * prefilter. Works for internal offsets (output centroid is inside
         * source), external offsets (output centroid is near source centroid),
         * and merged unions (nearest source wins).
         */
        attributeShapeKey(poly, srcIndex) {
            if (!srcIndex || srcIndex.length === 0) return -1;

            // Circle primitives survive offset analytically
            const pb = poly.getBounds ? poly.getBounds() : null;
            if (!pb) return -1;

            const cx = (pb.minX + pb.maxX) / 2;
            const cy = (pb.minY + pb.maxY) / 2;

            let bestId = -1;
            let bestDistSq = Infinity;

            for (const src of srcIndex) {
                // Bounds overlap prefilter - fast reject
                if (pb.maxX < src.bounds.minX || pb.minX > src.bounds.maxX ||
                    pb.maxY < src.bounds.minY || pb.minY > src.bounds.maxY) continue;

                const dx = cx - src.cx;
                const dy = cy - src.cy;
                const distSq = dx * dx + dy * dy;

                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    bestId = src.id;
                }
            }

            return bestId;
        }

        /**
         * Copper handlers keep stroke metadata only on primitives that are
         * ACTUALLY strokes - Gerber traces. An SVG import in the same
         * operation still gets normalized to a filled boundary, otherwise a
         * stroked-but-closed region gets thickened as a centerline instead of
         * offset as a boundary.
         */
        preparePrimitivesForOffset(primitives) {
            if (!this.isCopperOperation()) {
                return super.preparePrimitivesForOffset(primitives);
            }
            const traces = [];
            const filled = [];
            for (const prim of primitives) {
                (this.isStrokePrimitive(prim) ? traces : filled).push(prim);
            }
            if (traces.length === 0) return super.preparePrimitivesForOffset(primitives);
            return [...traces, ...super.preparePrimitivesForOffset(filled)];
        }

        /**
         * One definition of "this is a centerline to thicken", shared by
         * preparePrimitivesForOffset and offsetSinglePrimitive so the two
         * can never disagree about the same primitive.
         */
        isStrokePrimitive(prim) {
            const props = prim.properties || {};
            if (!(props.strokeWidth > 0)) return false;
            return props.isTrace === true || (props.stroke === true && !props.fill);
        }

        async offsetSinglePrimitive(primitive, distance) {
            if (this.isCopperOperation() && this.isStrokePrimitive(primitive)) {
                const combinedWidth = primitive.properties.strokeWidth + distance * 2;
                return this.core.geometryOffsetter.expandStroke(primitive, combinedWidth);
            }
            return super.offsetSinglePrimitive(primitive, distance);
        }

        // MAIN OFFSET PIPELINE

        async generateGeometry(operation, settings) {
            // Clone to prevent mutating shared state
            settings = { ...settings };

            this.debug('=== OFFSET PIPELINE START ===');
            this.debug(`Operation: ${operation.id} (${operation.type})`);

            if (!operation.primitives || operation.primitives.length === 0) {
                return [];
            }

            // Identity: stamp any untagged primitives and build spatial index
            // for geometric shapeKey attribution after offset passes.
            this.ensureSourceIds(operation.primitives);
            const srcIndex = this.buildSourceIndex(operation.primitives);

            // Determine offset direction via hooks
            let isInternal = this.isInternalOffset(operation, settings);
            let isOnLine = this.isOnLine(operation, settings);

            // Offset distance parameters
            let radius, sign, step;

            if (isOnLine) {
                // on-line: single pass at distance 0
            } else {
                radius = settings.toolDiameter / 2;
                sign = isInternal ? -1 : 1;

                // Resolve step distance
                const stepOverPct = settings.stepOver !== undefined ? settings.stepOver : 100;
                step = (settings.stepDistance && settings.stepDistance > 0)
                    ? settings.stepDistance
                    : settings.toolDiameter * (stepOverPct / 100.0);
            }

            // Distance generator: returns null when exhausted.
            const getOffsetDistance = (passIndex) => {
                if (isOnLine) return passIndex === 0 ? 0 : null;

                // Laser: walk outward until targetWidth reached
                if (settings.targetWidth !== null && settings.targetWidth > 0) {
                    if (passIndex >= maxPasses) return null;
                    const currentOffset = radius + (passIndex === 0 ? 0 : passIndex * step);
                    if ((currentOffset + radius) > settings.targetWidth + PRECISION) return null;
                    return sign * currentOffset;
                }

                // CNC: explicit pass count
                const count = Math.min(settings.passes || 1, maxPasses);
                if (passIndex >= count) return null;
                return sign * (radius + (passIndex === 0 ? 0 : passIndex * step)); // REVIEW - Double check if these 0 value safeguard are needed to make sure step values aren't NaN
            };

            // Guard: prevent internal offsets from collapsing small circular features
            let forceOnLine = false;
            if (isInternal && !isOnLine && this.shouldGuardCircleCollapse()) {
                const circles = operation.primitives.filter(p => p.type === 'circle' && p.radius);
                if (circles.length > 0) {
                    const smallestFeature = Math.min(...circles.map(p => p.radius * 2));
                    const firstOffset = Math.abs(getOffsetDistance(0) || 0);
                    if (smallestFeature > 0 && firstOffset >= smallestFeature / 2) {
                        this.debug(`Internal offset ${firstOffset.toFixed(3)}mm would collapse features (smallest: ${smallestFeature.toFixed(3)}mm). Falling back to on-line.`);
                        forceOnLine = true;
                    }
                }
            }

            // PRE-FUSION
            let primitivesToProcess = this.preparePrimitivesForOffset(operation.primitives);

            // TOPOLOGICAL CATEGORIZATION
            const levelBuckets = [];
            const complexRegions = [];
            const simpleGeometry = [];

            primitivesToProcess.forEach(prim => {
                if (this.shouldSkipPrimitive(prim, settings)) return;

                if (prim.properties?.isComposited) {
                    if (prim.contours && prim.contours.length > 0) {
                        prim.contours.forEach(contour => {
                            const lvl = contour.nestingLevel || 0;
                            if (!levelBuckets[lvl]) levelBuckets[lvl] = [];
                            levelBuckets[lvl].push(new PathPrimitive([contour], { ...prim.properties }));
                        });
                    } else {
                        if (!levelBuckets[0]) levelBuckets[0] = [];
                        levelBuckets[0].push(prim);
                    }
                } else {
                    const isTraceOrPad = prim.properties?.isTrace || prim.properties?.isPad ||
                                         prim.properties?.isFlash || prim.properties?.stroke;

                    if (prim.type === 'path' && prim.contours && prim.contours.length > 0 && !isTraceOrPad) {
                        const hasHoles = prim.contours.some(c => c.isHole);
                        if (hasHoles) {
                            complexRegions.push(prim);
                        } else {
                            simpleGeometry.push(prim);
                        }
                    } else {
                        simpleGeometry.push(prim);
                    }
                }
            });

            // PER-PASS OFFSET GENERATION
            operation.offsets = [];
            const passResults = [];

            const processGroup = async (group, dist) => {
                const promises = group.map(p => this.offsetSinglePrimitive(p, dist));
                const results = await Promise.all(promises);
                const out = [];
                for (let gi = 0; gi < results.length; gi++) {
                    const srcId = group[gi].properties?.sourceId ?? 0;   // carry source-shape identity
                    const res = results[gi];
                    const push = (r) => {
                        if (!r) return;
                        (r.properties ||= {}).sourceId = srcId;
                        // Stamp every non-arc point so the Z channel carries identity through Clipper.
                        if (srcId > 0 && r.contours) {
                            for (const c of r.contours) {
                                if (!c.points) continue;
                                for (const pt of c.points) {
                                    if (!pt.curveId || pt.curveId <= 0) pt.sourceId = srcId;
                                }
                            }
                        }
                        out.push(r);
                    };
                    if (Array.isArray(res)) res.forEach(push);
                    else push(res);
                }
                return out;
            };

            // Progress: structured ticks through the operation's callback.
            // The state manager owns the overlay element, the label format
            // and rAF coalescing.
            const onProgress = operation._onProgress || null;
            // Laser targetWidth walks outward until the width is met, so it
            // has no known count → indeterminate (frac null = spinner only).
            const totalPasses = (isOnLine || forceOnLine || settings.targetWidth > 0)
                ? 0 : Math.min(settings.passes || 1, maxPasses);

            let passIndex = 0;
            while (true) {
                const distance = forceOnLine
                    ? (passIndex === 0 ? 0 : null)
                    : getOffsetDistance(passIndex);

                if (distance === null) break;
                if (passIndex >= maxPasses) {
                    console.warn(`[OffsetOperationHandler] Reached safeguard limit of ${maxPasses} passes. Halting.`);
                    break;
                }

                // Tick + macrotask yield so the rAF-coalesced overlay can
                // paint between Clipper-bound passes.
                if (passIndex > 0) {
                    const of = totalPasses > 0 ? `/${totalPasses}` : '';
                    onProgress?.({
                        frac: totalPasses > 0 ? passIndex / totalPasses : null,
                        label: `${operation.type || 'Offset'} pass ${passIndex + 1}${of}`
                    });
                    await new Promise(resolve => {
                        const ch = new MessageChannel();
                        ch.port1.onmessage = () => resolve();
                        ch.port2.postMessage(null);
                    });
                }

                const offsetType = distance >= 0 ? 'external' : 'internal';

                this.debug(`--- PASS ${passIndex + 1}: ${distance.toFixed(3)}mm (${offsetType}) ---`);

                let passGeometry = [];

                if (levelBuckets.length > 0) {
                    // Level-by-Level Recomposition (Like Eagle geometry)
                    const offsetSimpleGeom = await processGroup(simpleGeometry, distance);

                    for (let lvl = 0; lvl < levelBuckets.length; lvl++) {
                        const bucket = levelBuckets[lvl];
                        if (!bucket || bucket.length === 0) continue;

                        const isHoleLevel = lvl % 2 === 1;
                        const dist = isHoleLevel ? -distance : distance;
                        const offsetBucket = await processGroup(bucket, dist);

                        if (offsetBucket.length === 0) continue;

                        if (lvl === 0) {
                            passGeometry = await this.core.geometryProcessor.unionGeometry(offsetBucket);
                        } else if (isHoleLevel) {
                            const holeUnion = await this.core.geometryProcessor.unionGeometry(offsetBucket);
                            if (passGeometry.length > 0) {
                                passGeometry = await this.core.geometryProcessor.difference(passGeometry, holeUnion);
                            }
                        } else {
                            const islandUnion = await this.core.geometryProcessor.unionGeometry(offsetBucket);
                            passGeometry = await this.core.geometryProcessor.unionGeometry(passGeometry.concat(islandUnion));
                        }
                    }

                    if (offsetSimpleGeom.length > 0) {
                        if (passGeometry.length > 0) {
                            passGeometry = await this.core.geometryProcessor.unionGeometry(passGeometry.concat(offsetSimpleGeom));
                        } else {
                            passGeometry = await this.core.geometryProcessor.unionGeometry(offsetSimpleGeom);
                        }
                    }
                } else {
                    // Per-Region Resolution (Like KiCAD geometry)
                    const offsetSimpleGeom = await processGroup(simpleGeometry, distance);
                    const resolvedOffsetRegions = [];

                    for (const regionPrim of complexRegions) {
                        const regionShells = [];
                        const regionHoles = [];

                        regionPrim.contours.forEach(contour => {
                            const simplePrim = new PathPrimitive([contour], { ...regionPrim.properties });
                            if (contour.isHole) regionHoles.push(simplePrim);
                            else regionShells.push(simplePrim);
                        });

                        const offsetShells = await processGroup(regionShells, distance);
                        const offsetHoles = await processGroup(regionHoles, -distance);

                        let regionResult = [];
                        if (offsetShells.length > 0) {
                            const shellUnion = await this.core.geometryProcessor.unionGeometry(offsetShells);
                            if (offsetHoles.length > 0) {
                                const holeUnion = await this.core.geometryProcessor.unionGeometry(offsetHoles);
                                regionResult = await this.core.geometryProcessor.difference(shellUnion, holeUnion);
                            } else {
                                regionResult = shellUnion;
                            }
                        }
                        if (regionResult.length > 0) {
                            resolvedOffsetRegions.push(...regionResult);
                        }
                    }

                    if (resolvedOffsetRegions.length > 0) {
                        if (offsetSimpleGeom.length > 0) {
                            passGeometry = await this.core.geometryProcessor.unionGeometry(resolvedOffsetRegions.concat(offsetSimpleGeom));
                        } else {
                            passGeometry = await this.core.geometryProcessor.unionGeometry(resolvedOffsetRegions);
                        }
                    } else if (offsetSimpleGeom.length > 0) {
                        passGeometry = await this.core.geometryProcessor.unionGeometry(offsetSimpleGeom);
                    }
                }

                // Early termination: geometry collapsed to nothing at this distance
                if (passGeometry.length === 0) {
                    this.debug(`Pass ${passIndex + 1}: geometry collapsed at ${distance.toFixed(3)}mm. Halting.`);
                    break;
                }

                // POST-PROCESSING
                // Runs at distance 0 too. An on-line pass still crosses Clipper
                // (jsPathToClipper tessellates whatever it is handed), so its arcs
                // are already gone by here - skipping reconstruction did not
                // "keep the original arcs", it shipped a 2048-segment polyline.
                if (!settings.skipArcReconstruction) {
                    passGeometry = this.core.geometryProcessor.arcReconstructor.processForReconstruction(passGeometry);
                }

                const thermalGroup = distance < 0 ? 'internal' : 'external';

                const reconstructedGeometry = passGeometry.map(p => {
                    if (!p.properties) p.properties = {};
                    p.properties.isOffset = true;
                    p.properties.pass = passIndex + 1;
                    p.properties.offsetDistance = distance;
                    p.properties.offsetType = offsetType;
                    p.properties.thermalGroup = thermalGroup;
                    p.properties.hasAnalyticArcs = (p.type === 'circle') || (p.contours?.some(c => c.arcSegments?.length > 0));
                    p.properties.shapeKey = this.attributeShapeKey(p, srcIndex);   // identity surviving the boolean union
                    return p;
                });

                passResults.push({
                    distance: distance,
                    actualDistance: distance,
                    pass: passIndex + 1,
                    offsetType: offsetType,
                    thermalGroup: thermalGroup,
                    primitives: reconstructedGeometry,
                    metadata: {
                        sourceCount: primitivesToProcess.length,
                        finalCount: reconstructedGeometry.length,
                        generatedAt: Date.now(),
                        toolDiameter: settings.toolDiameter,
                        targetWidth: settings.targetWidth || null,
                        actualWidth: Math.abs(distance) + (settings.toolDiameter / 2),
                        wasFused: primitivesToProcess !== operation.primitives,
                        thermalGroup: thermalGroup
                    }
                });

                passIndex++;
            }

            // Calculate actual width based on the last successful pass
            const actualWidth = passResults.length > 0
                ? Math.abs(passResults[passResults.length - 1].distance) + (settings.toolDiameter / 2)
                : 0;

            // COMBINE PASSES
            if (settings.combineOffsets && passResults.length > 1) {
                const allPassPrimitives = passResults.flatMap(p => p.primitives);
                operation.offsets = [{
                    id: this.offsetRecordId(operation.id, 'combined'),
                    distance: passResults[0].distance,
                    pass: 1,
                    primitives: allPassPrimitives,
                    type: 'offset',
                    metadata: {
                        sourceCount: primitivesToProcess.length,
                        finalCount: allPassPrimitives.length,
                        generatedAt: Date.now(),
                        toolDiameter: settings.toolDiameter,
                        targetWidth: settings.targetWidth || null,
                        actualWidth: actualWidth,
                        offset: {
                            combined: true,
                            passes: passResults.length,
                            offsetCount: allPassPrimitives.length
                        }
                    },
                    settings: { ...settings }
                }];
            } else {
                operation.offsets = passResults.map((passResult, index) => ({
                    id: this.offsetRecordId(operation.id, index),
                    ...passResult,
                    settings: { ...settings }
                }));
            }

            const totalPrimitives = operation.offsets.reduce((sum, o) => sum + o.primitives.length, 0);
            this.debug(`Generated ${operation.offsets.length} offset group(s), ${totalPrimitives} total primitives.`);
            this.debug(`=== OFFSET PIPELINE COMPLETE ===`);

            return operation.offsets;
        }

        // LASER GEOMETRY

        async generateLaserFills(operation, settings) {
            this.debug(`=== LASER GEOMETRY GENERATION: ${settings.clearStrategy} ===`);

            const strategy = settings.clearStrategy || 'offset';

            if (strategy === 'offset') {
                await this.generateGeometry(operation, settings);
                return operation.offsets;
            }

            // Filled/hatch strategies need a clearance zone
            let clearanceZone = operation.clearancePolygon;

            if (!clearanceZone || clearanceZone.length === 0) {
                clearanceZone = await this.getClearanceZone(operation, settings);
            }

            if (!clearanceZone || clearanceZone.length === 0) {
                this.debug('Clearance zone empty, falling back to offset strategy');
                await this.generateGeometry(operation, settings);
                return operation.offsets;
            }

            switch (strategy) {
                case 'filled': {
                    let filledGeometry = clearanceZone;
                    if (this.core.geometryProcessor?.arcReconstructor) {
                        filledGeometry = this.core.geometryProcessor.arcReconstructor
                            .processForReconstruction(clearanceZone);
                        this.debug(`Filled: reconstructed ${clearanceZone.length} → ${filledGeometry.length} primitives`);
                    }

                    operation.offsets = [{
                        distance: 0,
                        pass: 1,
                        type: 'filled',
                        primitives: filledGeometry,
                        metadata: {
                            strategy: 'filled',
                            isolationWidth: settings.isolationWidth || 0,
                            isBoardClearing: settings.isBoardClearing || false,
                            finalCount: filledGeometry.length
                        }
                    }];
                    break;
                }

                case 'hatch': {
                    if (typeof HatchGenerator !== 'undefined') {
                        operation.offsets = HatchGenerator.generate(clearanceZone, settings);
                        this.debug(`Hatch: generated ${operation.offsets.length} pass(es)`);
                    } else {
                        console.warn('[OffsetOperationHandler] HatchGenerator missing, falling back to offset.');
                        await this.generateGeometry(operation, settings);
                    }
                    break;
                }

                default:
                    this.debug(`Unknown laser strategy: ${strategy}, falling back to offset`);
                    await this.generateGeometry(operation, settings);
                    break;
            }

            return operation.offsets;
        }

        // CLEARANCE POLYGON (shared helper for filled/hatch)
        async generateClearancePolygon(operation, isolationWidth) {
            if (!operation.primitives || operation.primitives.length === 0) return [];

            this.debug(`=== CLEARANCE POLYGON GENERATION: width=${isolationWidth.toFixed(3)}mm ===`);

            const savedOffsets = operation.offsets;

            try {
                await this.generateGeometry(operation, {
                    toolDiameter: isolationWidth * 2,
                    passes: 1,
                    stepOver: 0,
                    combineOffsets: true,
                    skipArcReconstruction: true
                });

                const expanded = operation.offsets.flatMap(o => o.primitives);

                if (expanded.length === 0) {
                    this.debug('Offset expansion produced no geometry');
                    return [];
                }

                const footprint = [];
                for (const prim of operation.primitives) {
                    const standardized = this.core.geometryProcessor.standardizePrimitive(prim, prim.curveIds || []);
                    if (!standardized) continue;
                    if (Array.isArray(standardized)) {
                        footprint.push(...standardized);
                    } else {
                        footprint.push(standardized);
                    }
                }

                if (footprint.length === 0) {
                    this.debug('Fusion produced no copper footprint');
                    return [];
                }

                this.debug(`Expanded boundary: ${expanded.length} primitive(s)`);
                this.debug(`Copper footprint: ${footprint.length} primitive(s)`);

                const clearanceZone = await this.core.geometryProcessor.difference(expanded, footprint);

                this.debug(`Clearance polygon: ${clearanceZone.length} polygon(s)`);
                this.debug(`=== CLEARANCE POLYGON COMPLETE ===`);

                operation.clearancePolygon = clearanceZone;
                return clearanceZone;

            } finally {
                operation.offsets = savedOffsets;
            }
        }
    }

    window.OffsetOperationHandler = OffsetOperationHandler;
})();