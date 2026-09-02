/*!
 * @file        core/operation-ingest.js
 * @description File to primitives - parse, plot, classify, composite, analyse, bound
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function () {
    'use strict';

    const ROOT = globalThis;
    const debugState = ROOT.CAMConfig.defaults.debug;

    /**
     * Owns the parser registry and the whole path an operation takes between a
     * dropped file and a populated operation.primitives.
     *
     * A pipeline stage, so it takes core - same contract as GeometryTranslator
     * and MachineProcessor. It reads core.handlers, core.registry,
     * core.geometryProcessor and core.store; it writes only to the operation
     * passed in.
     */
    class OperationIngest {
        constructor(core) {
            this.core = core;
            this.parsers = new Map();
        }

        // ════════════════════════════════════════════════════════════════
        // Parser registry
        // ════════════════════════════════════════════════════════════════

        /**
         * @param {string} extension - e.g. '.svg', '.drl', '.gbr'
         * @param {Object} parser - Must have a .parse(content) method
         */
        registerParser(extension, parser) {
            this.parsers.set(extension.toLowerCase(), parser);
            this.debug(`Registered parser for ${extension}: ${parser.constructor.name}`);
        }

        getParser(fileName) {
            return this.parsers.get(this.getFileExtension(fileName)) || null;
        }

        getFileExtension(fileName) {
            const match = fileName.toLowerCase().match(/(\.[^.]+)$/);
            return match ? match[1] : '';
        }

        validateFileType(fileName, operationType) {
            const extension = this.getFileExtension(fileName);
            const registry = this.core.registry;

            if (!registry?.has(operationType)) {
                return { valid: false, message: `Unknown operation type: ${operationType}` };
            }

            const extensions = registry.extensionsFor(operationType);
            if (extensions.includes(extension)) return { valid: true, message: null };

            return {
                valid: false,
                message: `Invalid file type for ${operationType}. Expected: ${extensions.join(', ')}`
            };
        }

        // ════════════════════════════════════════════════════════════════
        // Parsing
        // ════════════════════════════════════════════════════════════════

        /**
         * Parses one operation's file into operation.primitives.
         * Classification is delegated to the operation's handler; polarity
         * compositing runs only for mixed-polarity copper layers.
         *
         * @param {Object} operation
         * @returns {Promise<boolean>} success; operation.error carries the reason
         */
        async parseOperation(operation) {
            try {
                this.debug(`[parseOperation] Parsing ${operation.file.name}...`);

                const parser = this.getParser(operation.file.name);
                if (!parser) {
                    operation.error = `No parser registered for ${operation.file.name}`;
                    return false;
                }

                const parseResult = parser.parse(operation.file.content);
                if (!parseResult.success) {
                    operation.error = parseResult.errors?.join('; ') || 'Parse failed';
                    return false;
                }
                operation.parsed = parseResult;

                const plotter = new ParserPlotter({ markStrokes: true });
                const plotResult = plotter.plot(parseResult);
                if (!plotResult.success) {
                    operation.error = plotResult.error;
                    return false;
                }

                let primitives = plotResult.primitives;

                if (debugState.enabled) {
                    const polarityCounts = primitives.reduce((acc, p) => {
                        const polarity = p.properties?.polarity || 'dark';
                        acc[polarity] = (acc[polarity] || 0) + 1;
                        return acc;
                    }, {});
                    this.debug(`Plotter returned ${primitives.length} primitives. Polarities:`, polarityCounts);
                }

                // Parser warnings belong to the operation so the UI can show them.
                operation.warnings ||= [];
                if (parseResult.warnings?.length > 0) {
                    operation.warnings.push(...parseResult.warnings);
                }

                // Handler pre-validation classification
                const handler = this.core.getHandler(operation.type);
                const classification = handler.classifyPrimitives(operation, primitives);
                primitives = classification.primitives;
                if (classification.warnings?.length > 0) {
                    operation.warnings.push(...classification.warnings);
                }

                for (const primitive of primitives) {
                    primitive.properties ||= {};
                    // Respect the plotter's polarity; only default when absent.
                    primitive.properties.polarity ??= 'dark';
                    this.stampOperationTags(primitive, operation);
                }

                this.analyzeGeometricContext(operation, primitives);
                const validPrimitives = this.validateAndOptimizePrimitives(primitives);

                // Sequential compositing for mixed-polarity layers (Eagle LPD→LPC→LPD).
                let finalPrimitives = validPrimitives;
                const isCopperLayer = operation.type === 'isolation' || operation.type === 'clearing';
                const hasMixedPolarity = validPrimitives.some(p => (p.properties?.polarity || 'dark') === 'clear');

                if (isCopperLayer && hasMixedPolarity && this.core.processorInitialized) {
                    this.debug(`[Compositing] Mixed polarity detected in ${operation.file.name}, running sequential compositing...`);
                    try {
                        const composited = await this.compositeByPolarity(validPrimitives);
                        if (composited && composited.length > 0) {
                            operation.isComposited = true;
                            this.debug(`[Compositing] ${validPrimitives.length} input → ${composited.length} output primitives`);
                            finalPrimitives = composited;
                        } else {
                            this.debug('[Compositing] Compositing returned empty, using original primitives');
                            operation.isComposited = false;
                        }
                    } catch (error) {
                        console.error(`[Compositing] Compositing failed for ${operation.file.name}:`, error);
                        operation.isComposited = false;
                    }
                }

                // Compositing emits NEW primitives, so the tags are re-stamped.
                for (const p of finalPrimitives) this.stampOperationTags(p, operation);

                operation.primitives = finalPrimitives;
                operation.bounds = this.recalculateBounds(finalPrimitives);

                handler.postParsePrimitives(operation);
                this.core.updateStatistics();
                operation.processed = true;

                this.debug(`Parsed ${operation.file.name}: ${operation.primitives.length} primitives`);
                return true;

            } catch (error) {
                operation.error = error.message;
                console.error(`Parse error for ${operation.file.name}:`, error);
                return false;
            }
        }

        stampOperationTags(primitive, operation) {
            primitive.properties ||= {};
            primitive.properties.operationType = operation.type;
            primitive.properties.operationId = operation.id;
            primitive.properties.layerType = operation.type === 'drill' ? 'drill' : operation.type;
        }

        // ════════════════════════════════════════════════════════════════
        // Analysis
        // ════════════════════════════════════════════════════════════════

        analyzeGeometricContext(operation, primitives) {
            let analyticCount = 0;
            let hasArcs = false;
            let hasCircles = false;
            let hasStrokes = false;
            let strokeCount = 0;
            const preservedShapes = [];

            primitives.forEach(primitive => {
                if (primitive.canOffsetAnalytically && primitive.canOffsetAnalytically()) {
                    analyticCount++;
                    preservedShapes.push({
                        type: primitive.type,
                        metadata: primitive.getGeometricMetadata ? primitive.getGeometricMetadata() : {}
                    });
                }

                if (primitive.type === 'circle') hasCircles = true;
                if (primitive.type === 'arc' || primitive.arcSegments?.length > 0) hasArcs = true;

                if (primitive.properties &&
                    ((primitive.properties.stroke && !primitive.properties.fill) || primitive.properties.isTrace)) {
                    hasStrokes = true;
                    strokeCount++;
                }
            });

            operation.geometricContext = {
                hasArcs, hasCircles, analyticCount, preservedShapes, hasStrokes, strokeCount
            };

            this.core.store.recordParseStats(analyticCount, primitives.length - analyticCount, strokeCount);
        }

        /**
         * Builds a structured geometry summary for any operation type.
         * Used by the UI to display source geometry information.
         */
        getGeometrySummary(operation) {
            if (!operation || !operation.primitives) return null;

            const primitives = operation.primitives;
            const summary = {
                totalCount: primitives.length,
                byType: {},
                isDrill: operation.type === 'drill',
                drillSummary: operation.drillSummary || null,
                source: operation.file?.name?.endsWith('.svg') ? 'svg' : 'native'
            };

            for (const prim of primitives) {
                const type = prim.type || 'unknown';
                summary.byType[type] = (summary.byType[type] || 0) + 1;
            }

            if (operation.type === 'drill') {
                summary.byRole = {};
                for (const prim of primitives) {
                    const role = prim.properties?.role || 'unclassified';
                    summary.byRole[role] = (summary.byRole[role] || 0) + 1;
                }
            }

            return summary;
        }

        /** Drops primitives with no getBounds() or non-finite bounds. */
        validateAndOptimizePrimitives(primitives) {
            const validPrimitives = [];

            primitives.forEach((primitive, index) => {
                try {
                    if (typeof primitive.getBounds !== 'function') {
                        this.debug(`Primitive ${index} missing getBounds()`);
                        return;
                    }
                    const bounds = primitive.getBounds();
                    if (!(isFinite(bounds.minX) && isFinite(bounds.minY) &&
                          isFinite(bounds.maxX) && isFinite(bounds.maxY))) {
                        this.debug(`Primitive ${index} invalid bounds:`, bounds);
                        return;
                    }
                    validPrimitives.push(primitive);
                } catch (error) {
                    this.debug(`Primitive ${index} validation failed:`, error);
                }
            });

            if (validPrimitives.length !== primitives.length) {
                console.warn(`Filtered ${primitives.length - validPrimitives.length} invalid primitives`);
            }
            return validPrimitives;
        }

        recalculateBounds(primitives) {
            if (!primitives || primitives.length === 0) {
                return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }
            const merged = GeometryUtils.mergeBounds(primitives.map(p => p.getBounds()));
            return merged || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        // ════════════════════════════════════════════════════════════════
        // Polarity compositing
        // ════════════════════════════════════════════════════════════════

        /**
         * Sequential boolean compositing that respects Gerber rendering order.
         * Groups contiguous same-polarity primitives to minimise WASM calls,
         * then applies union (dark) or difference (clear) in sequence.
         *
         * Dark traces and pads are held out of the accumulator entirely so
         * their analytic arc metadata survives untouched.
         */
        async compositeByPolarity(primitives) {
            if (!primitives || primitives.length === 0) return [];

            this.debug('[Compositing] === SEQUENTIAL COMPOSITING START ===');
            this.debug(`[Compositing] Input: ${primitives.length} primitives`);

            const independentGeometry = [];
            const polarityGroups = [];
            let currentGroup = null;

            for (const prim of primitives) {
                const isTraceOrPad = prim.properties?.isTrace || prim.properties?.isPad ||
                    prim.properties?.isFlash || (prim.properties?.stroke && !prim.properties?.fill);
                const isClear = prim.properties?.polarity === 'clear';

                if (isTraceOrPad && !isClear) {
                    independentGeometry.push(prim);
                    continue;
                }

                const polarity = prim.properties?.polarity || 'dark';
                if (!currentGroup || currentGroup.polarity !== polarity) {
                    currentGroup = { polarity, items: [] };
                    polarityGroups.push(currentGroup);
                }
                currentGroup.items.push(prim);
            }

            this.debug(`[Compositing] Polarity groups: ${polarityGroups.length}`);

            const processor = this.core.geometryProcessor;
            let accumulator = [];

            for (let i = 0; i < polarityGroups.length; i++) {
                const group = polarityGroups[i];
                this.debug(`[Compositing] Processing group ${i}: ${group.polarity} (${group.items.length} items)`);

                // Preprocess: convert strokes (traces, arcs) to filled polygons.
                const standardized = [];
                let strokesConverted = 0;

                for (const prim of group.items) {
                    const result = processor.standardizePrimitive(prim, prim.curveIds || []);
                    if (!result) {
                        this.debug(`[Compositing]   Standardization failed for primitive ${prim.id} (${prim.type}), skipping`);
                        continue;
                    }

                    // standardizePrimitive returns an array when a stroke expands
                    // into several polygons.
                    const produced = Array.isArray(result) ? result : [result];
                    for (const r of produced) {
                        r.properties ||= {};
                        r.properties.polarity = prim.properties?.polarity || 'dark';
                        standardized.push(r);
                    }

                    if ((prim.properties?.stroke && !prim.properties?.fill) || prim.properties?.isTrace) {
                        strokesConverted++;
                    }
                }

                if (strokesConverted > 0) {
                    this.debug(`[Compositing]   Converted ${strokesConverted} stroke(s) to filled polygons`);
                }

                // One WASM call per group.
                let groupGeometry;
                try {
                    groupGeometry = await processor.unionGeometry(standardized);
                } catch (error) {
                    console.error(`[Compositing] Union failed for group ${i}:`, error);
                    continue;
                }

                if (!groupGeometry || groupGeometry.length === 0) {
                    this.debug(`[Compositing]   Group ${i} produced no geometry after union, skipping`);
                    continue;
                }

                this.debug(`[Compositing]   Group ${i} unioned to ${groupGeometry.length} primitive(s)`);

                if (group.polarity === 'dark') {
                    if (accumulator.length === 0) {
                        accumulator = groupGeometry;
                    } else {
                        try {
                            accumulator = await processor.unionGeometry(accumulator.concat(groupGeometry));
                        } catch (error) {
                            console.error(`[Compositing] Accumulator union failed at group ${i}:`, error);
                            // Appending keeps the geometry; it just stays unmerged.
                            accumulator.push(...groupGeometry);
                        }
                    }
                    this.debug(`[Compositing]   Accumulator after dark union: ${accumulator.length} primitive(s)`);
                } else if (accumulator.length > 0) {
                    try {
                        accumulator = await processor.difference(accumulator, groupGeometry);
                    } catch (error) {
                        // Accumulator unchanged on failure.
                        console.error(`[Compositing] Difference failed at group ${i}:`, error);
                    }
                    this.debug(`[Compositing]   Accumulator after clear difference: ${accumulator.length} primitive(s)`);
                } else {
                    this.debug('[Compositing]   Skipping clear subtraction (accumulator empty or no clear geometry)');
                }
            }

            accumulator.forEach(p => {
                p.properties ||= {};
                p.properties.polarity = 'dark';
                p.properties.isComposited = true;
            });

            this.debug('[Compositing] === SEQUENTIAL COMPOSITING COMPLETE ===');

            const finalResult = [...accumulator, ...independentGeometry];
            this.debug(`[Compositing] Result: ${primitives.length} input → ${finalResult.length} output primitives`);
            return finalResult;
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            if (data !== null) console.log(`[Ingest] ${message}`, data);
            else console.log(`[Ingest] ${message}`);
        }
    }

    ROOT.OperationIngest = OperationIngest;
})();