/*!
 * @file        geometry/geometry-processor.js
 * @description Processes geometric boolean operations
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
    const debugState = D.debug;

    class GeometryProcessor {
        constructor(options = {}) {
            this.options = {
                preserveOriginals: options.preserveOriginals !== undefined ? options.preserveOriginals : true,
                ...options
            };

            // Initialize sub-modules
            this.clipper = new ClipperWrapper({ clipper2scale: this.options.clipper2scale });
            this.arcReconstructor = new ArcReconstructor();

            // State caching
            this.cachedStates = {
                originalPrimitives: null,
                preprocessedGeometry: null,
                fusedGeometry: null
            };

            // Statistics
            this.stats = {
                fusionOperations: 0,
                primitivesProcessed: 0,
                primitivesReduced: 0,
                strokesConverted: 0,
                holesDetected: 0,
                curvesRegistered: 0,
                curvesReconstructed: 0,
                unionOperations: 0
            };

            // Initialize promise
            this.initPromise = this.initialize();
        }

        async initialize() {
            try {
                await this.clipper.initialize();

                this.debug('Initialized with arc reconstruction pipeline');
                return true;
            } catch (error) {
                console.error('[GeometryProcessor] Failed to initialize:', error);
                return false;
            }
        }

        // Main fusion pipeline with arc reconstruction
        async fuseGeometry(primitives, options = {}) {
            this.debug('Entered fuseGeometry(). Received options:', options);

            await this.ensureInitialized();

            if (!primitives || primitives.length === 0) return [];

            const fusionOptions = {
                enableArcReconstruction: options.enableArcReconstruction || false,
                ...options
            };

            this.debug(`=== FUSION PIPELINE START ===`);
            this.debug(`Input: ${primitives.length} primitives`);
            this.debug(`Arc reconstruction: ${fusionOptions.enableArcReconstruction ? 'Enabled' : 'Disabled'}`);

            // Cache originals with indices
            primitives.forEach((p, idx) => {
                p._originalIndex = idx;
            });
            this.cachedStates.originalPrimitives = primitives;

            // Count registered curves from global registry
            if (fusionOptions.enableArcReconstruction && window.globalCurveRegistry) {
                const registryStats = window.globalCurveRegistry.getStats();
                this.stats.curvesRegistered = registryStats.registrySize;

                this.debug(`Global registry has ${registryStats.registrySize} curves`);
                this.debug(`  Circles: ${registryStats.circles}`);
                this.debug(`  Arcs: ${registryStats.arcs}`);
                this.debug(`  End caps: ${registryStats.endCaps}`);
            }

            // Preprocess primitives (convert to polygons with metadata)
            const preprocessed = this.preprocessPrimitives(
                this.cachedStates.originalPrimitives
            );

            // REVIEW? Replace - previous preprocessed state is stale once new
            // primitives are fused. Prevents unbounded accumulation.
            this.cachedStates.preprocessedGeometry = preprocessed;

            // Verify metadata propagation
            if (fusionOptions.enableArcReconstruction && debugState.enabled) {
                this.verifyMetadataPropagation(preprocessed, 'After preprocessing');
            }

            // Perform boolean fusion
            let fused = await this.performFusion(preprocessed);

            // Verify metadata survival
            if (fusionOptions.enableArcReconstruction && debugState.enabled) {
            this.verifyMetadataPropagation(fused, 'After fusion');
            }

            // Reconstruct arcs if enabled, otherwise use the fused geometry directly.
            let finalGeometry; // Initialize as undefined.

            this.debug('About to check if (fusionOptions.enableArcReconstruction).');
            if (fusionOptions.enableArcReconstruction) {
                this.debug(`=== RECONSTRUCTION PHASE ===`);
                this.debug('Received options:', options);

                const preReconstructionCount = fused.length;

                // The reconstructor is now the single source of truth for the final geometry.
                finalGeometry = this.arcReconstructor.processForReconstruction(fused);

                const stats = this.arcReconstructor.stats;
                this.stats.curvesReconstructed = stats.reconstructed;

                this.debug(`Reconstruction complete:`);
                this.debug(`  Primitives: ${preReconstructionCount} → ${finalGeometry.length}`);
                this.debug(`  Full circles reconstructed: ${stats.fullCircles}`);
                this.debug(`  Partial arcs found: ${stats.partialArcs}`);
                this.debug(`  Groups with gaps merged: ${stats.wrappedGroups}`);

                if (debugState.enabled) {
                    this.verifyReconstructionResults(finalGeometry);
                }
                this.debug('Exiting arc reconstruction block. Result count:', finalGeometry.length);

            } else {
                // If reconstruction is disabled, the fused geometry is the final geometry.
                this.debug('Arc reconstruction is Disabled, skipping block.');
                finalGeometry = fused;
            }

            this.cachedStates.fusedGeometry = finalGeometry;

            // Update statistics
            this.stats.fusionOperations++;
            this.stats.primitivesProcessed += primitives.length;
            this.stats.primitivesReduced = primitives.length - finalGeometry.length;

            this.debug(`=== FUSION PIPELINE COMPLETE ===`);
            this.debug(`Result: ${primitives.length} → ${finalGeometry.length} primitives`);

            return finalGeometry;
        }

        // Union geometry for offset pass merging
        async unionGeometry(primitives, options = {}) {
            await this.ensureInitialized();

            if (!primitives || primitives.length === 0) return [];

            this.debug(`=== UNION OPERATION START ===`);
            this.debug(`Input: ${primitives.length} primitives`);

            // Ensure all primitives have dark polarity for union
            // NOTE: this mutates the caller's primitives. Every current caller
            // passes derived geometry (offset results, stroke polygons), so
            // nothing source-level is touched - keep it that way, or clone here.
            for (const p of primitives) {
                if (!p.properties) p.properties = {};
                p.properties.polarity = 'dark';
            }

            try {
                // Use Clipper union operation
                const result = await this.clipper.union(primitives);

                // Count holes in result
                let holesFound = 0;
                result.forEach(p => {
                    if (p.contours && p.contours.length > 0) {
                        // Count all contours that are marked as holes
                        holesFound += p.contours.filter(c => c.isHole).length;
                    }
                });

                if (holesFound > 0) {
                    this.debug(`Union preserved ${holesFound} holes`);
                }

                // Update statistics
                this.stats.unionOperations++;

                this.debug(`=== UNION OPERATION COMPLETE ===`);
                this.debug(`Result: ${primitives.length} → ${result.length} primitives`);

                return result;

            } catch (error) {
                console.error('Union operation failed:', error);
                throw error;
            }
        }

        // Difference geometry for hole cutting
        async difference(subjectPrimitives, clipPrimitives) {
            await this.ensureInitialized();

            if (!subjectPrimitives || subjectPrimitives.length === 0) {
                return []; // Nothing to subtract from
            }
            if (!clipPrimitives || clipPrimitives.length === 0) {
                return subjectPrimitives; // Nothing to subtract
            }

            this.debug(`=== DIFFERENCE OPERATION START ===`);
            this.debug(`Input: ${subjectPrimitives.length} subjects, ${clipPrimitives.length} clips`);

            try {
                // Use Clipper difference operation
                const result = await this.clipper.difference(subjectPrimitives, clipPrimitives);

                this.debug(`=== DIFFERENCE OPERATION COMPLETE ===`);
                this.debug(`Result: ${result.length} primitives`);

                return result;

            } catch (error) {
                console.error('Difference operation failed:', error);
                throw error;
            }
        }

        // Verify metadata propagation through pipeline
        verifyMetadataPropagation(primitives, stage) {
            let pointsWithCurveIds = 0;
            let primitivesWithCurveIds = 0;
            let uniqueCurveIds = new Set();

            primitives.forEach(prim => {
                let hasPointCurveIds = false;

                if (prim.curveIds && prim.curveIds.length > 0) {
                    primitivesWithCurveIds++;
                    prim.curveIds.forEach(id => uniqueCurveIds.add(id));
                }

                // Iterate over contours to check points
                if (prim.contours && prim.contours.length > 0) {
                    prim.contours.forEach(contour => {
                        if (contour.points) {
                            const taggedPoints = contour.points.filter(p => p.curveId !== undefined && p.curveId > 0);
                            if (taggedPoints.length > 0) {
                                pointsWithCurveIds += taggedPoints.length;
                                hasPointCurveIds = true;
                                taggedPoints.forEach(p => uniqueCurveIds.add(p.curveId));
                            }
                        }
                    });
                } 
                // Legacy data structure check (should be empty)
                else if (prim.points) {
                     // Warn if it's populated
                     console.warn("[GeometryProcessor] verifyMetadata found primitive.points on ID:", prim.id);
                }

                if (hasPointCurveIds && !prim.curveIds) {
                    primitivesWithCurveIds++; // Count implicit tagging
                }
            });

            this.debug(`${stage}:`);
            this.debug(`  ${primitivesWithCurveIds}/${primitives.length} primitives with curve data`);
            this.debug(`  ${pointsWithCurveIds} points tagged`);
            this.debug(`  ${uniqueCurveIds.size} unique curve IDs`);
        }

        // Verify reconstruction results
        verifyReconstructionResults(primitives) {
            let reconstructedCircles = 0;
            let reconstructedPaths = 0;
            let totalArcSegments = 0;

            primitives.forEach(prim => {
                if (prim.type === 'circle' && prim.properties?.reconstructed) {
                    reconstructedCircles++;
                    // Circles no longer carry a coverage property in the unified pipeline, so just log the radius
                    this.debug(`  Reconstructed circle: r=${prim.radius.toFixed(3)}`);
                } else if (prim.type === 'path' && prim.properties?.hasDetectedArcs) {
                    reconstructedPaths++;
                    prim.contours.forEach(c => {
                        if (c.arcSegments && c.arcSegments.length > 0) {
                            totalArcSegments += c.arcSegments.length;
                        }
                    });
                }
            });

            this.debug(`Reconstruction verification:`);
            this.debug(`  Circles reconstructed: ${reconstructedCircles}`);
            this.debug(`  Paths with arc segments: ${reconstructedPaths}`);
            this.debug(`  Total arc segments: ${totalArcSegments}`);
        }

        // Preprocess primitives with curve ID preservation
        preprocessPrimitives(primitives) {
            const preprocessed = [];
            let strokeCount = 0;

            for (const primitive of primitives) {
                if (!this.validatePrimitive(primitive)) continue;

                const curveIds = primitive.curveIds || [];

                // Track strokes for statistics
                if ((primitive.properties?.stroke && !primitive.properties?.fill) || 
                    primitive.properties?.isTrace) {
                    strokeCount++;
                }

                // primitiveToPath handles everything: strokes, analytics, paths
                const processed = this.standardizePrimitive(primitive, curveIds);

                if (processed) {
                    // Handle arrays returned by traceToPolygon
                    if (Array.isArray(processed)) {
                        processed.forEach(p => {
                            p._originalIndex = primitive._originalIndex;
                            if (curveIds.length > 0) {
                                // Merge inherited curveIds with newly generated ones
                                p.curveIds = p.curveIds ? Array.from(new Set([...p.curveIds, ...curveIds])) : curveIds;
                            }
                            preprocessed.push(p);
                        });
                    } else {
                        // Original handling for single primitives
                        processed._originalIndex = primitive._originalIndex;
                        if (curveIds.length > 0) processed.curveIds = curveIds;
                        preprocessed.push(processed);
                    }
                }
            }

            this.stats.strokesConverted = strokeCount;
            this.debug(`Preprocessing: ${primitives.length} → ${preprocessed.length} (${strokeCount} strokes)`);
            return preprocessed;
        }

        standardizePrimitive(primitive, curveIds) {
            const props = primitive.properties;
            const isStroke = (props.stroke && !props.fill) || props.isTrace;

            // Strokes need conversion to filled polygons regardless of primitive type
            if (isStroke && props.strokeWidth > 0) {
                const converted = GeometryUtils.primitiveToPath(primitive, curveIds || []);
                if (converted) {
                    return converted;
                }
                // Fall through if conversion fails
            }

            // If it's already a path, validate it has contours
            if (primitive.type === 'path') {
                if (!primitive.contours || primitive.contours.length === 0) {
                    console.error(`[GeometryProcessor] Path primitive ${primitive.id} has no contours!`);
                    return null;
                }

                // Tessellate analytic arc segments into dense polylines.
                const hasArcs = primitive.contours.some(
                    c => c.arcSegments && c.arcSegments.length > 0
                );
                if (hasArcs) {
                    const tessellatedContours = primitive.contours.map(c =>
                        (c.arcSegments && c.arcSegments.length > 0)
                            ? GeometryUtils.contourArcsToPath(c)
                            : c
                    );
                    return new PathPrimitive(tessellatedContours, primitive.properties);
                }

                return primitive; // Already valid, no arcs to expand
            }

            const localCurveIds = curveIds || [];

            // For analytic primitives, convert to path
            const pathPrimitive = GeometryUtils.primitiveToPath(primitive, localCurveIds);

            if (pathPrimitive) {
                // Verify contours were created
                if (!pathPrimitive.contours || pathPrimitive.contours.length === 0) {
                    console.error(`[GeometryProcessor] primitiveToPath failed to create contours for ${primitive.type} (ID: ${primitive.id})`);
                    return null;
                }

                if (localCurveIds.length > 0) {
                    pathPrimitive.curveIds = localCurveIds;
                }
                return pathPrimitive;
            } else {
                console.error(`[GeometryProcessor] Tessellation failed for ${primitive.type} (ID: ${primitive.id})`);
                return null;
            }
        }

        // Perform boolean fusion
        async performFusion(primitives) {
            const darkPrimitives = [];
            const clearPrimitives = [];

            primitives.forEach(primitive => {
                if (!primitive) {
                    console.warn('[GeometryProcessor] Skipping null primitive');
                    return;
                }

                // For paths, check contours; for others, trust getBounds()
                if (primitive.type === 'path') {
                    if (!primitive.contours || primitive.contours.length === 0) {
                        console.warn('[GeometryProcessor] Skipping path with no contours:', primitive.id);
                        return;
                    }

                    const hasValidGeometry = primitive.contours.some(c => 
                        c.points && c.points.length >= 3
                    );

                    if (!hasValidGeometry) {
                        console.warn('[GeometryProcessor] Skipping path with invalid contour geometry:', primitive.id);
                        return;
                    }
                }

                if (!primitive.properties) primitive.properties = {};

                const finalPolarity = primitive.properties?.polarity || 'dark';
                if (finalPolarity === 'clear') {
                    clearPrimitives.push(primitive);
                } else {
                    darkPrimitives.push(primitive);
                }
            });

            this.debug(`Received ${primitives.length} total primitives. Separated into: ${darkPrimitives.length} dark (subjects) and ${clearPrimitives.length} clear (clips).`);
            this.debug(`_performFusion Input (Post-Standardization): ${darkPrimitives.length} dark, ${clearPrimitives.length} clear`);

            // Perform Boolean Operation
            const rawResult = await this.clipper.difference(darkPrimitives, clearPrimitives);
            this.debug('Raw Clipper Result Count:', rawResult.length);

            const directHolesCount = rawResult.filter(p => p && p.contours && p.contours.filter(c => c.isHole).length > 0).length;
            this.debug('Primitives with structured hole contours in raw result:', directHolesCount);

            rawResult.forEach(primitive => {
                // Mark as fused. The wrapper already applied properties.
                if (primitive.properties) {
                    primitive.properties.isFused = true;
                } else {
                    primitive.properties = { isFused: true };
                }
            });

            // The raw result IS the final result.
            const finalPrimitives = rawResult;

            const totalFinalHoles = finalPrimitives.reduce((sum, p) => sum + (p.contours ? p.contours.filter(c => c.isHole).length : 0), 0);
            this.debug(`[GeometryProcessor] Mapped ${finalPrimitives.length} final primitives. Total structured hole contours: ${totalFinalHoles}`);

            return finalPrimitives;
        }

        validatePrimitive(primitive) {
            if (!primitive) return false;
            if (!primitive.properties) {
                primitive.properties = {};
            }

            const polarity = primitive.properties.polarity;
            if (polarity !== 'dark' && polarity !== 'clear') {
                primitive.properties.polarity = 'dark';
            }

            return true;
        }

        // REVIEW - Dead code?
        // createPathPrimitive(contours, properties = {}) {
        //     if (typeof PathPrimitive !== 'undefined' && PathPrimitive) {
        //         const primitive = new PathPrimitive(contours, properties);
        // 
        //         if (properties.hasReconstructableCurves) { 
        //             primitive.hasReconstructableCurves = true; 
        //         }
        // 
        //         if (!primitive.contours || primitive.contours.length === 0) {
        //             this.debug(`PathPrimitive created with no contours`);
        //         }
        // 
        //         return primitive;
        //     }
        // }

        // State management
        clearCachedStates() {
            this.cachedStates = {
                originalPrimitives: null,
                preprocessedGeometry: null,
                fusedGeometry: null
            };
        }

        getCachedState(stateName) {
            return this.cachedStates[stateName] || null;
        }

        async ensureInitialized() {
            if (!this.clipper.initialized) {
                await this.initPromise;
            }
            if (!this.clipper.initialized) {
                throw new Error('GeometryProcessor not initialized');
            }
        }

        getStats() {
            return {
                ...this.stats,
                clipper: this.clipper.getCapabilities(),
                arcReconstruction: { ...this.arcReconstructor.stats }
            };
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GeometryProcessor] ${message}`, data)
                 : console.log(`[GeometryProcessor] ${message}`);
        }

    }

    window.GeometryProcessor = GeometryProcessor;
})();