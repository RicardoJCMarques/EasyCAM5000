/*!
 * @file        cam-core.js
 * @description Core engine - state, parsing, shared infrastructure, pipeline execution
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
    const EPSILON = C.precision.epsilon;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class CamCore {
        constructor(options = {}) {
            // Core data
            this.operations = [];
            this.operationIndex = new Map();
            this.nextOperationId = 1;

            // Toolpath management
            this.toolpaths = new Map();

            // Tool library reference
            this.toolLibrary = null;

            // Initialization control
            this.isInitializing = false;
            this.isInitialized = false;

            // Operation handler registry
            this.handlers = new Map();

            // Pipeline components (engine-owned)
            this.geometryTranslator = null;
            this.toolpathOptimizer = null;
            this.machineProcessor = null;

            // Initialize fileTypes from config
            this.fileTypes = {};

            // Settings - populated by controller via loadSettings(storageKey)
            this.settings = JSON.parse(JSON.stringify(D));

            // Statistics
            this.stats = {
                totalPrimitives: 0,
                operations: 0,
                layers: 0,
                holes: 0,
                holesDetected: 0,
                analyticPrimitives: 0,
                polygonizedPrimitives: 0,
                strokesConverted: 0,
                toolpaths: 0
            };

            // Parser registry - populated by app controllers
            this.parsers = new Map();

            // Universal workspace state
            // Scene owns the geometry tree, selection, the global workspace
            // transform (origin/rotation/mirror), spatial queries (pick,
            // marquee, viewport), AND coordinate-space conversions.
            // sceneInteraction is kept as an alias so existing call sites
            // (tools, readouts, buildToolContext) work unchanged.
            this.scene = (typeof Scene !== 'undefined') ? new Scene() : null;
            this.sceneInteraction = this.scene;

            // Pipeline type: 'cnc' | 'laser' | 'hybrid'
            // Set by the application controller via setPipelineType().
            // Core methods use this instead of reaching to window globals.
            this.pipelineType = 'cnc';

            // Initialise scene with an empty 100x100 board so the renderer
            // has something to fit on before any geometry loads.
            if (this.scene) this.scene.initializeEmptyBoardBounds();

            // Geometry processors
            this.geometryProcessor = null;
            this.geometryOffsetter = null;
            this.processorInitialized = false;
            this.initializationPromise = null;
        }

        // Stock getter/setter - canonical location is settings.machine.stock.
        // Direct property mutations (core.stock.width = 600) work because the
        // getter returns the settings reference. Full replacement (core.stock = {...})
        // goes through the setter. Either way, call saveSettings() to persist.

        get stock() {
            return this.settings?.machine?.stock || null;
        }

        set stock(val) {
            if (this.settings?.machine) {
                this.settings.machine.stock = val;
            }
        }

        /**
         * Sets up allowed file extensions and UI colors based on the App Profile.
         */
        setFileTypes(fileTypesConfig) {
            this.fileTypes = {};
            if (!fileTypesConfig) return;

            Object.keys(fileTypesConfig).forEach(type => {
                const op = fileTypesConfig[type];
                if (op) {
                    this.fileTypes[type] = {
                        extensions: op.extensions || [],
                        description: op.description || `Files for ${type} operation`,
                        icon: op.icon || 'icon-file',
                        color: op.color || '#888888'
                    };
                }
            });
        }

        /**
         * Handler Registry
         */
        registerHandler(type, handler) {
            this.handlers.set(type, handler);
            this.debug(`Registered handler for '${type}': ${handler.constructor.name}`);
        }

        getHandler(type) {
            const handler = this.handlers.get(type);
            if (!handler) {
                throw new Error(`No handler registered for operation type: ${type}`);
            }
            return handler;
        }

        /**
         * Processor Initialization
         */
        async initializeProcessors() {
            if (this.isInitializing || this.isInitialized) {
                console.log('Processors already initializing or initialized');
                return this.initializationPromise || true;
            }

            this.isInitializing = true;
            this.debug('Initializing processors with Clipper2...');

            // Initialize GeometryProcessor
            if (typeof GeometryProcessor !== 'undefined') {
                const scale = this.appProfile.clipper2scale;
                if (!scale || !Number.isFinite(scale)) {
                    console.error(`[Core] clipper2scale is invalid (${scale}). Check that the app profile loaded correctly.`);
                    this.isInitializing = false;
                    return false;
                }

                this.geometryProcessor = new GeometryProcessor({
                    preserveOriginals: true,
                    clipper2scale: scale
                });

                // Initialize GeometryOffsetter
                if (typeof GeometryOffsetter !== 'undefined') {
                    this.geometryOffsetter = new GeometryOffsetter({
                        precision: PRECISION,
                        miterLimit: D.geometry.offsetting.miterLimit
                    });

                    // Link processor for union operations
                    if (this.geometryOffsetter.setGeometryProcessor) {
                        this.geometryOffsetter.setGeometryProcessor(this.geometryProcessor);
                    }
                }

                // Wait for Clipper2 WASM
                this.initializationPromise = this.geometryProcessor.initPromise;

                try {
                    await this.initializationPromise;
                    this.processorInitialized = true;
                    this.isInitialized = true;
                    this.debug('Clipper2 initialized');
                    return true;
                } catch (error) {
                    console.error('Clipper2 initialization failed:', error);
                    this.processorInitialized = false;
                    return false;
                } finally {
                    this.isInitializing = false;
                }
            }

            console.error('GeometryProcessor not available');
            this.isInitializing = false;
            return false;
        }

        /**
         * Pipeline Component Initialization
         *
         * The core owns the translate → optimize → machine pipeline.
         * Called by the application controller after core construction
         * so that pipeline components exist before any toolpath work.
         */

        initializePipeline() {
            if (typeof GeometryTranslator !== 'undefined') {
                this.geometryTranslator = new GeometryTranslator(this);
            } else {
                console.error('[Core] GeometryTranslator module missing');
            }

            if (typeof ToolpathOptimizer !== 'undefined') {
                this.toolpathOptimizer = new ToolpathOptimizer();
            } else {
                console.error('[Core] ToolpathOptimizer module missing');
            }

            if (typeof MachineProcessor !== 'undefined') {
                this.machineProcessor = new MachineProcessor(this);
            } else {
                console.error('[Core] MachineProcessor module missing');
            }

            this.debug('Pipeline components initialized');
        }

        setGCodeGenerator(generator) {
            this.gcodeGenerator = generator;
            this.debug('G-code generator set');
        }

        setToolLibrary(toolLibrary) {
            this.toolLibrary = toolLibrary;
            this.debug('Tool library set');
        }

        /**
         * Registers a parser for a file extension.
         * @param {string} extension - e.g. '.svg', '.drl', '.gbr'
         * @param {Object} parser - Must have a .parse(content) method
         */
        registerParser(extension, parser) {
            this.parsers.set(extension.toLowerCase(), parser);
            this.debug(`Registered parser for ${extension}: ${parser.constructor.name}`);
        }

        getParser(fileName) {
            const ext = this.getFileExtension(fileName);
            return this.parsers.get(ext) || null;
        }

        /**
         * Sets the active pipeline type. Called by the application
         * controller during initialization and pipeline switches.
         * Core methods read this.pipelineType instead of window globals.
         */
        setPipelineType(type) {
            if (!['cnc', 'laser', 'hybrid'].includes(type)) {
                console.warn(`[Core] Invalid pipeline type: ${type}, defaulting to 'cnc'`);
                type = 'cnc';
            }
            this.pipelineType = type;
            this.debug(`Pipeline type set: ${type}`);
        }

        /**
         * Settings
         */

        loadSettings(storageKey, appProfile = null) {
            this.settingsStorageKey = storageKey;
            const defaults = JSON.parse(JSON.stringify(D));

            // Merge app-profile defaults into the factory baseline BEFORE
            // localStorage is applied on top.  Final precedence:
            //   factory D  <  profile machineDefaults/laserDefaults  <  saved localStorage
            if (appProfile?.machineDefaults) {
                mergeDeep(defaults.machine, appProfile.machineDefaults);
            }
            if (appProfile?.laserDefaults) {
                mergeDeep(defaults.laser, appProfile.laserDefaults);
            }

            try {
                const raw = localStorage.getItem(this.settingsStorageKey);
                if (!raw) return defaults;

                const saved = JSON.parse(raw);

                // Intercept Laser Profiles to prevent aggressive caching
                if (saved.laser && saved.laser.profiles) {
                    for (const [profId, savedProf] of Object.entries(saved.laser.profiles)) {
                        if (defaults.laser.profiles[profId] && savedProf.layerColors) {
                            defaults.laser.profiles[profId].layerColors = {
                                ...defaults.laser.profiles[profId].layerColors,
                                ...savedProf.layerColors
                            };
                        }
                    }
                    delete saved.laser.profiles;
                }

                // Migrate: fold legacy separate pipeline key into the settings blob
                // REVIEW - Possibly useless by now. Also do something about the error?
                if (!saved.pipeline) {
                    try {
                        const legacyPipeline = localStorage.getItem(this.settingsStorageKey.replace('_settings', '_pipeline'));
                        if (legacyPipeline) {
                            saved.pipeline = JSON.parse(legacyPipeline);
                        }
                    } catch (e) { /* ignore */ }
                }

                const mergedSettings = mergeDeep({}, defaults, saved);
                return mergedSettings;
            } catch (error) {
                console.warn('Error loading settings from localStorage:', error);
                return defaults;
            }
        }

        saveSettings() {
            try {
                localStorage.setItem(this.settingsStorageKey , JSON.stringify(this.settings));
            } catch (error) {
                console.warn('Error saving settings:', error);
            }
        }

        /**
         * Merges a settings category and persists.
         *
         * Post-processor changes invalidate INDEXED rotary operations only.
         * Nothing else under machine/gcode feeds EasyShape geometry - surfaceZ,
         * depthLevels, feeds and clearances are all re-derived in
         * buildToolpathContext at export - but indexed generation reads the
         * post's rotary capability at GENERATION time (postCapabilityWarning)
         * and MachineProcessor.insertIndexMoves drops the plans outright when
         * the new post declares no 'a-word' route. Invalidating everything
         * instead would force a multi-minute relief re-slice on a stock
         * thickness tweak that cannot move a single coordinate.
         */
        updateSettings(category, settings) {
            if (!this.settings[category]) return;

            const postChanged = category === 'gcode' &&
                settings.postProcessor !== undefined &&
                settings.postProcessor !== this.settings.gcode.postProcessor;

            Object.assign(this.settings[category], settings);
            this.saveSettings();

            if (postChanged) this.invalidateIndexedOperations(settings.postProcessor);
        }

        /** Marks generated indexed 3+1 operations stale after a post change. */
        invalidateIndexedOperations(postProcessor) {
            for (const op of this.operations) {
                if (!op.offsets?.length) continue;
                if (op.offsets[0].metadata?.indexed !== true) continue;
                if (op.isInvalidated) continue;
                this.invalidateOperationState(op.id);
                op.isInvalidated = true;
                op.invalidatedReason =
                    `Post-processor changed to '${postProcessor}'. Indexed 3+1 needs ` +
                    `the a-word route - regenerate to re-check it.`;
            }
        }

        getSetting(category, key) {
            return this.settings[category]?.[key];
        }

        /**
         * Operation CRUD
         */

        /**
         * Creates a new operation.
         * @param {string} operationType - 'isolation', 'clearing', 'profile', 'pocket', etc.
         * @param {Object} source - Either a File object or { label: string }
         * @returns {Object} The created operation, registered in core.operations[]
         */
        createOperation(operationType, source) {
            const fileType = this.fileTypes[operationType];

            // Detect source type: File object vs shape descriptor
            const isFile = source instanceof File || (source && source.size !== undefined && source.lastModified !== undefined);

            const operation = {
                id: `op_${this.nextOperationId++}`,
                type: operationType,
                file: {
                    name: isFile ? source.name : (source?.label || operationType),
                    content: null,
                    size: isFile ? source.size : 0,
                    lastModified: isFile ? source.lastModified : Date.now()
                },
                parsed: null,
                primitives: isFile ? null : [],
                bounds: null,
                error: null,
                warnings: null,
                expanded: false,
                processed: false,
                color: fileType?.color,
                geometricContext: {
                    hasArcs: false,
                    hasCircles: false,
                    analyticCount: 0,
                    preservedShapes: [],
                    hasStrokes: false,
                    strokeCount: 0
                },
                offsets: [],
                layerVisibility: {}
            };

            this.operations.push(operation);
            this.indexOperation(operation);
            return operation;
        }

        removeOperation(operationId) {
            const index = this.operations.findIndex(op => op.id === operationId);
            if (index === -1) return false;

            this.unindexOperation(operationId);
            this.operations.splice(index, 1);
            this.toolpaths.delete(operationId);

            this.updateStatistics();
            this.updateBoardBounds();

            return true;
        }

        resetOperationState(operationId) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;

            operation.offsets = [];
            operation.preview = null;
            operation.exportReady = false;
            delete operation.exportMetadata;
            
            operation.isInvalidated = false;
            operation.invalidatedReason = null;

            return true;
        }

        /**
         * O(1) operation lookup by ID. Returns undefined if not found.
         */
        getOperation(id) {
            return this.operationIndex.get(id);
        }

        /** Call whenever an operation is added to the array. */
        indexOperation(operation) {
            this.operationIndex.set(operation.id, operation);
        }

        /** Call whenever an operation is removed from the array. */
        unindexOperation(operationId) {
            this.operationIndex.delete(operationId);
        }

        /**
         * Generates a CNC toolpath preview from existing offsets.
         * Collects all offset primitives, tags them as preview geometry,
         * and marks the operation export-ready.
         *
         * @param {string} operationId
         * @returns {boolean} success
         */
        generateCNCPreview(operationId) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;

            if (!operation.offsets || operation.offsets.length === 0) {
                this.debug(`generateCNCPreview: no offsets for ${operationId}`);
                return false;
            }

            const firstOffset = operation.offsets[0];
            const toolDiameter = firstOffset.metadata?.toolDiameter;

            if (typeof toolDiameter === 'undefined' || toolDiameter <= 0) {
                this.debug(`generateCNCPreview: invalid tool diameter for ${operationId}`);
                return false;
            }

            const allPrimitives = [];
            operation.offsets.forEach(offset => {
                offset.primitives.forEach(prim => {
                    if (!prim.properties) prim.properties = {};
                    prim.properties.isPreview = true;
                    // Drill primitives carry the diameter of the bit assigned to
                    // THEIR row. preview.primitives alias these objects, so
                    // overwriting this erases the per-row cutter before the
                    // toolpath pass ever reads it.
                    if (prim.properties.toolDiameter === undefined) prim.properties.toolDiameter = toolDiameter;
                    allPrimitives.push(prim);
                });
            });

            operation.preview = {
                primitives: allPrimitives,
                metadata: { generatedAt: Date.now(), sourceOffsets: operation.offsets.length, toolDiameter },
                ready: true
            };
            return true;
        }

        /**
         * Invalidates generated geometry when parameters change.
         * Marks the operation as not-export-ready without deleting data.
         */
        invalidateOperationState(operationId) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;

            operation.exportReady = false;
            if (operation.preview) operation.preview.ready = false;

            return true;
        }

        /**
         * Deletes a specific geometry subgroup from an operation.
         * Called by UI when user clicks a trash icon on an offset/preview node.
         */
        deleteOperationGeometry(operationId, geometryType) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;

            if (geometryType === 'offsets_combined') {
                operation.offsets = [];
            } else if (geometryType.startsWith('offset_')) {
                const passIndex = parseInt(geometryType.split('_')[1]);
                if (operation.offsets) {
                    operation.offsets.splice(passIndex, 1);
                }
            } else if (geometryType === 'preview') {
                operation.preview = null;
            }

            return true;
        }

        /**
         * Parsing - delegates classification to handlers
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

                if (typeof ParserPlotter === 'undefined') {
                    throw new Error('Plotter not available');
                }
                const plotter = new ParserPlotter({
                    markStrokes: true
                });

                const plotResult = plotter.plot(parseResult);

                if (!plotResult.success) {
                    operation.error = plotResult.error;
                    return false;
                }

                let primitives = plotResult.primitives;

                //Debug check
                const polarityCounts = primitives.reduce((acc, p) => {
                    const polarity = p.properties?.polarity || 'dark';
                    acc[polarity] = (acc[polarity] || 0) + 1;
                    return acc;
                }, {});

                this.debug(`Plotter returned ${primitives.length} primitives. Polarities:`, polarityCounts);

                // Transfer parser warnings to the main operation object so the UI can see them
                if (!operation.warnings) operation.warnings = [];
                if (parseResult.warnings && parseResult.warnings.length > 0) {
                    operation.warnings.push(...parseResult.warnings);
                }

                // Handler pre-validation classification
                const handler = this.getHandler(operation.type);
                const classification = handler.classifyPrimitives(operation, primitives);
                primitives = classification.primitives;
                if (classification.warnings?.length > 0) {
                    if (!operation.warnings) operation.warnings = [];
                    operation.warnings.push(...classification.warnings);
                }

                // Tag primitives with operation metadata
                primitives = primitives.map(primitive => {
                    if (!primitive.properties) primitive.properties = {};
                    // Respect the polarity from the plotter, only default to 'dark' if it's not already set.
                    if (primitive.properties.polarity === undefined) {
                        primitive.properties.polarity = 'dark';
                    }
                    primitive.properties.operationType = operation.type;
                    primitive.properties.operationId = operation.id;
                    primitive.properties.layerType = operation.type === 'drill' ? 'drill' : operation.type;
                    return primitive;
                });

                this.analyzeGeometricContext(operation, primitives);
                const validPrimitives = this.validateAndOptimizePrimitives(primitives);

                // Sequential compositing for mixed-polarity layers (Eagle LPD→LPC→LPD pattern).
                let finalPrimitives = validPrimitives;

                const isCopperLayer = (operation.type === 'isolation' || operation.type === 'clearing');
                const hasMixedPolarity = validPrimitives.some(
                    p => (p.properties?.polarity || 'dark') === 'clear'
                );

                // Only run sequential compositing for Eagle files (mixed polarity).
                if (isCopperLayer && hasMixedPolarity && this.processorInitialized) {
                    this.debug(`[Compositing] Mixed polarity detected in ${operation.file.name}, running sequential compositing...`);

                    try {
                        const composited = await this.compositeByPolarity(validPrimitives);

                        if (composited && composited.length > 0) {
                            operation.isComposited = true;
                            this.debug(`[Compositing] ${validPrimitives.length} input → ${composited.length} output primitives`);
                            finalPrimitives = composited;
                        } else {
                            this.debug(`[Compositing] Compositing returned empty, using original primitives`);
                            operation.isComposited = false;
                        }
                    } catch (error) {
                        console.error(`[Compositing] Compositing failed for ${operation.file.name}:`, error);
                        operation.isComposited = false;
                    }
                }

                // Ensure all primitives have correct operation metadata after compositing
                finalPrimitives.forEach(p => {
                    if (!p.properties) p.properties = {};
                    p.properties.operationType = operation.type;
                    p.properties.operationId = operation.id;
                    p.properties.layerType = operation.type === 'drill' ? 'drill' : operation.type;
                });

                operation.primitives = finalPrimitives;
                operation.bounds = this.recalculateBounds(finalPrimitives);

                // Handler post-parse hook
                handler.postParsePrimitives(operation);

                this.updateStatistics();
                operation.processed = true;

                this.debug(`Parsed ${operation.file.name}: ${operation.primitives.length} primitives`);

                return true;

            } catch (error) {
                operation.error = error.message;
                console.error(`Parse error for ${operation.file.name}:`, error);
                return false;
            }
        }

        /**
         * Geometric Analysis
         */

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
                if (primitive.type === 'arc' || (primitive.arcSegments && primitive.arcSegments.length > 0)) hasArcs = true;

                if (primitive.properties) {
                    if ((primitive.properties.stroke && !primitive.properties.fill) || primitive.properties.isTrace) {
                        hasStrokes = true;
                        strokeCount++;
                    }
                }
            });

            operation.geometricContext = {
                hasArcs, hasCircles, analyticCount, preservedShapes, hasStrokes, strokeCount
            };

            this.stats.analyticPrimitives += analyticCount;
            this.stats.polygonizedPrimitives += primitives.length - analyticCount;
            this.stats.strokesConverted += strokeCount;
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

            // Count by primitive type
            for (const prim of primitives) {
                const type = prim.type || 'unknown';
                if (!summary.byType[type]) summary.byType[type] = 0;
                summary.byType[type]++;
            }

            // For drill operations, also count by role
            if (operation.type === 'drill') {
                summary.byRole = {};
                for (const prim of primitives) {
                    const role = prim.properties?.role || 'unclassified';
                    if (!summary.byRole[role]) summary.byRole[role] = 0;
                    summary.byRole[role]++;
                }
            }

            return summary;
        }

        /**
         * Validation & Compositing
         */

        validateAndOptimizePrimitives(primitives) {
            const validPrimitives = [];

            primitives.forEach((primitive, index) => {
                try {
                    if (typeof primitive.getBounds !== 'function') {
                        this.debug(`Primitive ${index} missing getBounds()`);
                        return;
                    }

                    const bounds = primitive.getBounds();
                    if (!isFinite(bounds.minX) || !isFinite(bounds.minY) ||
                        !isFinite(bounds.maxX) || !isFinite(bounds.maxY)) {
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

        /**
         * Sequential boolean compositing that respects Gerber rendering order.
         * Group contiguous same-polarity primitives to minimize WASM calls, then applies union (dark) or difference (clear) sequentially.
         */
        async compositeByPolarity(primitives) {
            if (!primitives || primitives.length === 0) return [];

            this.debug(`[Compositing] === SEQUENTIAL COMPOSITING START ===`);
            this.debug(`[Compositing] Input: ${primitives.length} primitives`);

            // Separate traces/pads from regions/clears
            const independentGeometry = [];
            const polarityGroups = [];
            let currentGroup = null;

            for (const prim of primitives) {
                const isTraceOrPad = prim.properties?.isTrace || prim.properties?.isPad || prim.properties?.isFlash || (prim.properties?.stroke && !prim.properties?.fill);
                const isClear = prim.properties?.polarity === 'clear';

                // Keep dark traces/pads independent to preserve perfect analytic properties
                if (isTraceOrPad && !isClear) {
                    independentGeometry.push(prim);
                    continue;
                }

                const polarity = prim.properties?.polarity || 'dark';
                if (!currentGroup || currentGroup.polarity !== polarity) {
                    currentGroup = { polarity: polarity, items: [] };
                    polarityGroups.push(currentGroup);
                }
                currentGroup.items.push(prim);
            }

            this.debug(`[Compositing] Polarity groups: ${polarityGroups.length}`);

            // Sequential compositing: process groups in order
            let accumulator = [];

            for (let i = 0; i < polarityGroups.length; i++) {
                const group = polarityGroups[i];

                this.debug(`[Compositing] Processing group ${i}: ${group.polarity} (${group.items.length} items)`);

                // Preprocess: convert strokes (traces, arcs) to filled polygons.
                const standardized = [];
                let strokesConverted = 0;

                for (const prim of group.items) {
                    const result = this.geometryProcessor.standardizePrimitive(prim, prim.curveIds || []);
                    if (result) {
                        // Handle arrays returned by traceToPolygon
                        if (Array.isArray(result)) {
                            result.forEach(r => {
                                if (!r.properties) r.properties = {};
                                r.properties.polarity = prim.properties?.polarity || 'dark';
                                standardized.push(r);
                            });
                        } else {
                            if (!result.properties) result.properties = {};
                            result.properties.polarity = prim.properties?.polarity || 'dark';
                            standardized.push(result);
                        }

                        const wasStroke = (prim.properties?.stroke && !prim.properties?.fill) ||
                                          prim.properties?.isTrace;
                        if (wasStroke) strokesConverted++;
                    } else {
                        this.debug(`[Compositing]   Standardization failed for primitive ${prim.id} (${prim.type}), skipping`);
                    }
                }

                if (strokesConverted > 0) {
                    this.debug(`[Compositing]   Converted ${strokesConverted} stroke(s) to filled polygons`);
                }

                // Union everything within this group into a single geometry set (one WASM call per group)
                let groupGeometry;
                try {
                    groupGeometry = await this.geometryProcessor.unionGeometry(standardized);
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
                        // Union the new dark geometry with the accumulator
                        try {
                            accumulator = await this.geometryProcessor.unionGeometry(
                                accumulator.concat(groupGeometry)
                            );
                        } catch (error) {
                            console.error(`[Compositing] Accumulator union failed at group ${i}:`, error);
                            // Fallback: just append
                            accumulator.push(...groupGeometry);
                        }
                    }
                    this.debug(`[Compositing]   Accumulator after dark union: ${accumulator.length} primitive(s)`);
                } else {
                    // Clear: subtract from accumulator
                    if (accumulator.length > 0 && groupGeometry.length > 0) {
                        try {
                            accumulator = await this.geometryProcessor.difference(
                                accumulator, groupGeometry
                            );
                        } catch (error) {
                            console.error(`[Compositing] Difference failed at group ${i}:`, error);
                            // Accumulator unchanged on failure
                        }
                        this.debug(`[Compositing]   Accumulator after clear difference: ${accumulator.length} primitive(s)`);
                    } else {
                        this.debug(`[Compositing]   Skipping clear subtraction (accumulator empty or no clear geometry)`);
                    }
                }
            }

            // Tag all output primitives as dark and composited
            accumulator.forEach(p => {
                if (!p.properties) p.properties = {};
                p.properties.polarity = 'dark';
                p.properties.isComposited = true;
            });

            this.debug(`[Compositing] === SEQUENTIAL COMPOSITING COMPLETE ===`);

            // Re-combine the composited regions with the protected independent geometry
            const finalResult = [...accumulator, ...independentGeometry];
            this.debug(`[Compositing] Result: ${primitives.length} input → ${finalResult.length} output primitives`);

            return finalResult;
        }

        recalculateBounds(primitives) {
            if (!primitives || primitives.length === 0) {
                return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }
            const merged = GeometryUtils.mergeBounds(primitives.map(p => p.getBounds()));
            return merged || { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        /*
         * TO-DO
         * Generates the full-board clearance polygon to remove all unused copper - requires a cutout file for an outer-edge. Implement a dedicated operation handler extension to trace-cutout?
         */
        /*
        async generateUnusedCopperPolygon() {}
        */

        /**
         * Executes the full toolpath pipeline for a set of operation/context
         * pairs.  Returns machine-ready plans and the final machine position.
         *
         * @param {Array<{operation, context}>} operationContextPairs
         * @param {Object} [options]
         * @param {boolean} [options.optimize=true]  Run path optimizer
         * @param {{x,y,z}} [options.startPos]       Override starting position
         * @returns {{ plans: Array, endPos: {x,y,z} }}
         */
        async executePipeline(operationContextPairs, options = {}) {
            if (!this.geometryTranslator || !this.machineProcessor) {
                throw new Error('Pipeline components not initialized - call initializePipeline() first');
            }

            const optimize = options.optimize !== false;
            const allMachineReadyPlans = [];

            const pipelineWarnings = [];

            if (!operationContextPairs || operationContextPairs.length === 0) {
                return { plans: allMachineReadyPlans, endPos: { x: 0, y: 0, z: 0 } };
            }

            // Tool batching. The optimizer can never do this - executePipeline
            // hands it ONE operation at a time, so cross-operation ordering has
            // to happen here, before the loop. Gated: with tool changes off, the
            // export modal's drag order is the user's explicit instruction and
            // silently resorting it would be surprising.
            if (options.groupByTool) {
                // A peck-only drill operation never calls its own number, and a
                // multi-bit one leads with its lowest. Sorting on the operation
                // tool would batch it against a cutter no move in it uses.
                const leadNumber = context => {
                    const tool = context?.tool;
                    if (!tool) return Number.MAX_SAFE_INTEGER;
                    const numbers = [];
                    if (tool.cutsWithOwnTool !== false && tool.number > 0) numbers.push(tool.number);
                    for (const n of Object.values(tool.drillNumbers || {})) if (n > 0) numbers.push(n);
                    return numbers.length > 0 ? Math.min(...numbers) : Number.MAX_SAFE_INTEGER;
                };
                operationContextPairs = operationContextPairs
                    .map((pair, index) => ({ pair, index }))
                    .sort((a, b) => {
                        // Unassigned sorts last: an operation with no number
                        // must not silently lead the program.
                        const ta = leadNumber(a.pair.context);
                        const tb = leadNumber(b.pair.context);
                        return ta !== tb ? ta - tb : a.index - b.index;
                    })
                    .map(entry => entry.pair);
            }

            const firstContext = operationContextPairs[0].context;
            let currentMachinePos = options.startPos || { x: 0, y: 0, z: firstContext.machine.safeZ };

            this.debug(`Executing pipeline: ${operationContextPairs.length} operation(s), optimize=${optimize}`);

            for (const { operation, context } of operationContextPairs) {
                this.debug(`--- Processing Operation: ${operation.type} (${operation.id}) ---`);

                // Translate
                const opPlans = await this.geometryTranslator.translateOperation(operation, context);

                if (!opPlans || opPlans.length === 0) {
                    this.debug(`--- Operation ${operation.type} produced no plans. Skipping. ---`);
                    continue;
                }

                // Optimize
                let plansToProcess = opPlans;
                if (optimize && this.toolpathOptimizer) {
                    this.debug(`Optimizing ${opPlans.length} plans...`);
                    plansToProcess = this.toolpathOptimizer.optimize(opPlans, currentMachinePos);
                }

                if (plansToProcess.length === 0) {
                    this.debug(`--- Operation ${operation.type} empty after optimization. Skipping. ---`);
                    continue;
                }

                // Machine processing
                this.debug('Adding machine operations...');

                const { plans: machineReadyPlans, endPos, droppedDeveloped, droppedIndexed } =
                    this.machineProcessor.processPlans(
                        plansToProcess,
                        context,
                        currentMachinePos,
                        { convertRotary: options.convertRotary !== false }
                    );
                if (droppedDeveloped > 0) {
                    pipelineWarnings.push(`${operation.type} '${operation.id}': ` +
                        `${droppedDeveloped} rotary plan(s) skipped - the selected ` +
                        `post cannot emit this operation's rotary route.`);
                }
                if (droppedIndexed) {
                    pipelineWarnings.push(`${operation.type} '${operation.id}': ` +
                        `indexed 3+1 plans skipped - the selected post declares no ` +
                        `A/B rotary word, or the machine's rotary route is set to ` +
                        `axis replacement, which cannot position a rotary axis. ` +
                        `Choose a compatible post and set the route to 'a-word'.`);
                }

                allMachineReadyPlans.push(...machineReadyPlans);
                currentMachinePos = endPos;

                this.debug(`--- Operation complete. Machine pos: (${endPos.x.toFixed(2)}, ${endPos.y.toFixed(2)}, ${endPos.z.toFixed(2)}) ---`);
            }

            this.debug(`Pipeline complete: ${allMachineReadyPlans.length} machine-ready plans`);
            return { plans: allMachineReadyPlans, endPos: currentMachinePos, warnings: pipelineWarnings };
        }

        /**
         * Shared Math Utilities (called by handlers)
         */

        /**
         * Full tool descriptor for one operation.
         *
         * `number` is null when the user has not assigned one. It STAYS null -
         * nothing in this pipeline invents a tool number. The slot a cutter
         * physically occupies is not derivable from geometry, a wrong T word
         * is a crash, and a plausible auto-assigned default is one the
         * operator was never prompted to verify. checkToolAssignment()
         * reports the gaps; the export modal blocks on them.
         *
         * @param {Object} operation
         * @param {Object} params        merged ParameterManager values
         * @param {Object} [override]    export-modal toolIndexMap entry
         */
        resolveToolDescriptor(operation, params, override = null) {
            const record = this.toolLibrary?.getTool?.(params.tool) || null;
            const pick = (value) => {
                const n = Number(value);
                return Number.isInteger(n) && n > 0 ? n : null;
            };

            const descriptor = {
                number: pick(override?.number) ?? pick(params.toolNumber),
                id: params.tool || null,
                name: override?.name || record?.name || params.tool || null,
                type: record?.type || null,
                diameter: params.toolDiameter,
                spindleSpeed: params.spindleSpeed,
                spindleDwell: params.spindleDwell,
                operationId: operation.id,
                operationLabel: `${operation.type}: ${operation.file?.name || operation.id}`
            };

            // Drill: one physical bit per feature size. The map key is the SAME
            // string DrillHandler.diameterKey produces, so the export table, the
            // split-drill path and the descriptor agree without re-deriving it.
            //
            // Only in multi-tool mode. Single-tool drilling cuts everything with
            // the operation's own number, and a drillMap that repeats that number
            // once per diameter reports itself to describeToolSharing as a
            // collision between a tool and itself.
            if ('drill' === operation.type
                && typeof DrillHandler !== 'undefined'
                && DrillHandler.isMultiTool(params)) {
                const active = Object.values(operation.drillTable?.rows || {})
                    .filter(row => 'skip' !== row.strategy);

                // The operation's own tool cuts only the rows that inherit it.
                // With none, it makes no claim on a number and cannot collide
                // with the bits it is not holding.
                descriptor.cutsWithOwnTool = active.some(row => !row.toolId && !(row.toolDiameter > 0));

                if (active.length > 0) {
                    descriptor.drillMap = {};
                    for (const row of active) {
                        const assigned = pick(row.toolNumber);
                        const effectiveDiam = row.toolDiameter > 0 ? row.toolDiameter : row.diameter;
                        descriptor.drillMap[row.key] = {
                            number: assigned ?? descriptor.number,
                            inherited: null == assigned,
                            diameter: effectiveDiam,
                            strategy: row.strategy,
                            name: row.toolId || `${'mill' === row.strategy ? 'Mill' : 'Drill'} ${effectiveDiam}mm`
                        };
                    }
                }
            } else {
                descriptor.cutsWithOwnTool = true;
            }

            return descriptor;
        }

        /**
         * Reports T numbers shared by tools of DIFFERENT sizes.
         *
         * Identity is the effective diameter, not the library id. A tool id is
         * a naming convenience with no enforcement behind it - `drill_1.0mm`
         * and `em_1.0mm_flat` are different records and very often the same
         * physical cutter in the same collet, especially since millHoles
         * defaults to true and most drill work never touches a drill bit.
         * Comparing ids flagged exactly the case most likely to be correct.
         *
         * Same number + same diameter is silent. Same number + different
         * diameters is the only thing worth saying, and it is a note, not a
         * refusal: the operator knows their spindle, EasyCAM does not.
         *
         * @param {Array} descriptors  from resolveToolDescriptor
         * @returns {Array<{number:number, entries:Array<{label:string, diameter:number}>}>}
         */
        describeToolSharing(descriptors) {
            // 0.01mm separates 3.175 from 3.0 without splitting 3.175 from a
            // rounded 3.18. precision.coordinate (0.001) is too tight for a
            // hand-entered diameter.
            const DIAMETER_TOLERANCE = 0.01;
            const byNumber = new Map();

            const record = (label, number, diameter) => {
                if (number == null || !(diameter > 0)) return;
                if (!byNumber.has(number)) byNumber.set(number, []);
                const entries = byNumber.get(number);
                if (entries.some(e => Math.abs(e.diameter - diameter) < DIAMETER_TOLERANCE)) return;
                entries.push({ label, diameter });
            };

            for (const d of descriptors) {
                if (d.cutsWithOwnTool !== false) {
                    record(d.drillMap ? `${d.operationLabel} (milled holes)` : d.operationLabel,
                           d.number, d.diameter);
                }
                if (!d.drillMap) continue;
                for (const [key, entry] of Object.entries(d.drillMap)) {
                    record(`${d.operationLabel} — ${key}mm holes`, entry.number, entry.diameter);
                }
            }

            const shared = [];
            for (const [number, entries] of byNumber) {
                if (entries.length > 1) shared.push({ number, entries });
            }
            return shared.sort((a, b) => a.number - b.number);
        }

        /**
         * Resolves tool descriptors for a set of operations WITHOUT building
         * contexts or running a pipeline. Lets the export modal validate the
         * moment a checkbox flips, instead of only at Calculate.
         */
        stageToolDescriptors(operationIds, parameterManager, toolIndexMap = {}) {
            const ids = operationIds
                || this.operations.filter(op => this.isExportReady(op)).map(op => op.id);
            const staged = [];
            for (const opId of ids) {
                try {
                    const operation = this.getOperation(opId);
                    if (!operation) continue;
                    if (parameterManager.hasUnsavedChanges(opId)) {
                        parameterManager.commitToOperation(operation);
                    }
                    const params = parameterManager.getAllParameters(opId);
                    staged.push({
                        opId, operation,
                        tool: this.resolveToolDescriptor(operation, params, toolIndexMap[opId])
                    });
                } catch (err) {
                    console.warn(`[Core] tool staging skipped ${opId}: ${err.message}`);
                }
            }
            return staged;
        }

        /**
         * One-call check for the UI. Same staging the pipeline uses, so the
         * modal's note and the emitted G-code can never disagree.
         */
        checkToolAssignment(operationIds, parameterManager, opts = {}) {
            const staged = this.stageToolDescriptors(
                operationIds, parameterManager, opts.toolIndexMap);
            return this.describeToolSharing(staged.map(s => s.tool));
        }

        /**
         * Flattens a resolved descriptor's drillMap to the plain
         * diameterKey → number lookup the translator wants on the context.
         * Entries stay null when unassigned.
         */
        flattenDrillMap(descriptor) {
            if (!descriptor.drillMap) return null;
            const flat = {};
            for (const [key, entry] of Object.entries(descriptor.drillMap)) {
                flat[key] = entry.number;
            }
            return flat;
        }

        /**
         * Drill-milling parameter aliases. JSON can't carry two keys with the
         * same name and different conditionals, so the profiles prefix the
         * drill variants. One precedence rule for every alias pair: the
         * prefixed key wins on a drill operation, the plain key otherwise.
         */
        resolveDrillAlias(operation, params, plainKey, drillKey) {
            if (operation.type === 'drill' && params[drillKey] !== undefined) {
                return params[drillKey];
            }
            return params[plainKey];
        }

        /**
         * Offset Strategy Builder
         *
         * Translates pipeline-specific UI parameters into a pipeline-agnostic
         * strategy object. Called before any handler runs - handlers never
         * need to check pipeline type.
         *
         * @param {Object} operation - The operation with .type and .bounds
         * @param {Object} params - Flat map from parameterManager.getAllParameters()
         * @returns {Object} Strategy object ready for any handler
         */
        compileOperationParams(operation, params) {
            const isLaser = this.pipelineType === 'laser' || this.pipelineType === 'hybrid';
            const exportFormat = isLaser ? this.settings.laser.exportFormat : null;
            const isPNG = exportFormat === 'png';
            const resolveDrillAlias = (a, b) => this.resolveDrillAlias(operation, params, a, b);

            // Tool dimension
            const toolDiameter = isLaser
                ? (params.laserSpotSize || this.settings.laser.spotSize)
                : params.toolDiameter;

            // Step distance
            let stepDistance = null;
            let stepOver = null;

            if (isLaser) {
                if (isPNG) {
                    stepDistance = toolDiameter;
                } else {
                    const mode = params.laserSpacingMode;
                    switch (mode) {
                        case 'lpcm':
                            stepDistance = 10 / Math.max(params.laserLinesPerCm, 1);
                            break;
                        case 'lpi':
                            stepDistance = 25.4 / Math.max(params.laserLinesPerInch, 1);
                            break;
                        case 'stepover':
                        default:
                            stepDistance = toolDiameter * ((params.laserStepOver) / 100);
                            break;
                    }
                }
            } else {
                stepOver = resolveDrillAlias('stepOver', 'drillStepOver');
            }

            // Clear strategy
            let clearStrategy = 'offset';
            if (isLaser) {
                clearStrategy = isPNG ? 'filled' : (params.laserClearStrategy);
            }

            // Per-operation-type
            let passes = null;
            let targetWidth = null;
            let cutSide = null;
            let combineOffsets = false;

            switch (operation.type) {
                // Shared operation types
                case 'drill':
                    passes = 1;
                    cutSide = isLaser ? (params.laserCutSide || 'inside') : 'inside';
                    break;

                // EasyTrace5000 operation types
                case 'isolation':
                    if (isLaser) {
                        targetWidth = params.laserIsolationWidth || 0.4;
                    } else {
                        passes = params.passes || 3;
                        combineOffsets = params.combineOffsets !== false;
                    }
                    break;

                case 'clearing':
                    combineOffsets = true;
                    // No targetWidth - handler loop runs until geometry collapses.
                    passes = 500;
                    break;

                case 'cutout':
                    passes = 1;
                    cutSide = isLaser ? (params.laserCutSide || 'outside') : (params.cutSide || 'outside');
                    break;

                // EasyShape5000 operation types
                case 'profile':
                    passes = 1;
                    cutSide = params.cutSide || 'outside';
                    break;

                case 'pocket':
                    combineOffsets = true;
                    passes = 500;
                    break;

                case 'engrave':
                    passes = 1;
                    cutSide = 'on';
                    break;

                case 'vcarve':
                case 'relief':
                case 'rotary':
                    // Depth comes from the generated 3D geometry, not pass distances. No cutSide, no stepOver, single logical pass.
                    passes = 1;
                    combineOffsets = false;
                    break;
            }

            return {
                toolDiameter,
                stepDistance,
                stepOver,
                targetWidth,
                passes,
                cutSide,
                clearStrategy,
                combineOffsets,
                isLaser,
                hatchAngle: params.laserHatchAngle,
                hatchPasses: params.laserHatchPasses,
                isolationWidth: isLaser ? params.laserIsolationWidth : null
            };
        }

        /**
         * Z of the material surface in machine coordinates.
         * Rotary owns its own Z0 (centreline or blank face), so stock
         * thickness never applies to it.
         */
        resolveSurfaceZ(operation) {
            const stock = this.settings.machine.stock || {};
            const isBedZero = stock.zeroReference && stock.zeroReference !== 'material';
            return (isBedZero && operation.type !== 'rotary') ? (stock.thickness || 0) : 0;
        }

        /**
         * Calculates the final Z-depth levels for a toolpath.
         */
        calculateDepthLevels(cutDepth, depthPerPass, multiDepth, surfaceZ = 0) {
            const totalCutDist = Math.abs(cutDepth);
            const finalDepth = surfaceZ - totalCutDist;
            const step = Math.abs(depthPerPass);

            if (!multiDepth || step <= 0 || totalCutDist <= step) {
                return [finalDepth]; // Single pass
            }

            const levels = [];
            let currentDepth = surfaceZ;

            // Loop while currentDepth is greater than (less negative than) finalDepth
            while (currentDepth - step > finalDepth - EPSILON) {
                currentDepth -= step;
                levels.push(currentDepth);
            }

            // Ensure the final depth is always included if not already last
            if (levels.length === 0 || levels[levels.length - 1] > finalDepth) {
                levels.push(finalDepth);
            }

            return levels;
        }

        /**
         * Depth ladders for the drill rows that override depth-per-pass or
         * multi-depth. Built here because calculateDepthLevels is the only
         * ladder in the app and a second copy in the translator would drift.
         * Returns null when no row overrides, so the common case allocates
         * nothing.
         */
        buildDrillDepthLevels(operation, params, depthPerPass, multiDepth, surfaceZ) {
            if (!params?.drillMultiTool) return null;
            const rows = operation.drillTable?.rows;
            if (!rows) return null;
            let levels = null;
            for (const [key, row] of Object.entries(rows)) {
                const step = row.mill?.depthPerPass;
                const multi = row.mill?.multiDepth;
                if (step == null && multi == null) continue;
                if (!levels) levels = {};
                levels[key] = this.calculateDepthLevels(params.cutDepth, step ?? depthPerPass, multi ?? multiDepth, surfaceZ);
            }
            return levels;
        }

        /**
         * Returns the current workspace transform from the scene.
         */
        getTransforms() {
            if (!this.scene) {
                return {
                    origin: { x: 0, y: 0 }, rotation: 0, rotationCenter: null,
                    mirrorX: false, mirrorY: false, mirrorCenter: { x: 0, y: 0 },
                    matrix: TransformMath.identity(),
                    machineMatrix: TransformMath.identity(),
                    machineIsIdentity: true,
                    windingFlipped: false
                };
            }
            const t = this.scene.transform;

            // Workspace matrix (rotation + mirror, NO origin) - still published
            // separately because GraphicsExporter composes origin itself.
            const wsMatrix = TransformMath.clone(this.scene.getWorkspaceMatrix());

            // The machine matrix: T(-origin) x workspace. The only transform
            // the toolpath pipeline applies, once, in GeometryTranslator.
            // GCodeGenerator no longer subtracts origin.
            const machineMatrix = TransformMath.multiply(
                TransformMath.translation(-t.origin.x, -t.origin.y),
                wsMatrix
            );

            return {
                origin: { ...t.origin },
                rotation: t.rotation,
                rotationCenter: { ...t.rotationCenter },
                mirrorX: t.mirrorX,
                mirrorY: t.mirrorY,
                mirrorCenter: { ...t.mirrorCenter },
                // Derived, cloned so frozen contexts can't share the cache:
                matrix: wsMatrix,
                machineMatrix: machineMatrix,
                machineIsIdentity: TransformMath.isIdentity(machineMatrix),
                windingFlipped: this.scene.windingFlipped()
            };
        }

        /**
         * Toolpath Context Builder
         *
         * Assembles all data for a single operation into a
         * self-contained context object.  Delegates offset direction
         * to the registered handler so the core never checks
         * operation type names for geometric decisions.
         */
        buildToolpathContext(operationId, parameterManager, resolvedTool = null) {
            const operation = this.getOperation(operationId);
            if (!operation) {
                throw new Error(`Operation ${operationId} not found.`);
            }

            // Get all parameters from manager
            const params = parameterManager.getAllParameters(operationId);

            const resolveDrillAlias = (a, b) => this.resolveDrillAlias(operation, params, a, b);

            // Drill milling aliases - JSON can't have duplicate keys with different
            // conditionals, so both apps' profiles uses prefixed names (drillMultiDepth,
            // drillDepthPerPass, drillEntryType) for operation-specific params that
            // share names. Map them to the standard names the pipeline expects.
            // REVIEW - Review if there's a better approach to this - there's already a new per app/operation input defaults override?
            // More Operations have unique parameter modifiers and defaults now, might as well just review everything for consistency and keep the system but improve implementation?
            const isDrill = operation.type === 'drill';
            const mappedMultiDepth   = resolveDrillAlias('multiDepth', 'drillMultiDepth');
            const mappedDepthPerPass = resolveDrillAlias('depthPerPass', 'drillDepthPerPass');
            const mappedEntryType    = resolveDrillAlias('entryType', 'drillEntryType');
            const mappedStepOver     = resolveDrillAlias('stepOver', 'drillStepOver');

            // Get global settings
            const machine = this.settings.machine;
            const gcode = this.settings.gcode;

            const processorInfo = this.gcodeGenerator?.getProcessorInfo(gcode.postProcessor);

            // Rotary 4th-axis export route. The post declares which routes it
            // can emit (descriptor.capabilities.rotary.routes, preference
            // order); gcode.rotaryRoute is the user's pick from the
            // machine-settings dropdown. '' or an undeclared value = auto
            // (first declared route). No declared routes = 'off', and any
            // developed plan is dropped downstream with a pipeline warning.
            const rotaryCaps = processorInfo?.capabilities?.rotary
                || { routes: [], axisWords: [], inverseTime: false, maxInverseTime: 0 };
            // Indexed 3+1 needs a REAL rotary word: there is no arc to
            // substitute, so 'wrapped-linear' is not a valid encoding for it.
            // REVIEW - this sounds like an overcomplication?
            const isIndexedOp = operation.offsets?.[0]?.metadata?.indexed === true;
            const preferred = (isIndexedOp && rotaryCaps.routes.includes('a-word'))
                ? 'a-word'
                : (rotaryCaps.routes[0] || 'off');
            const wantRoute = gcode.rotaryRoute || '';
            const rotaryRoute = rotaryCaps.routes.includes(wantRoute)
                ? wantRoute
                : preferred;
            if (wantRoute && wantRoute !== rotaryRoute) {
                console.warn(`[Core] Post '${gcode.postProcessor}' does not declare ` +
                    `rotary route '${wantRoute}' - using '${rotaryRoute}'.`);
            }

            // Compute derived values
            const offsetDistances = (operation.offsets || []).map(o => o.distance);

            // Transform Values
            const transforms = this.getTransforms();

            const surfaceZ = this.resolveSurfaceZ(operation);

            const depthLevels = this.calculateDepthLevels(
                params.cutDepth, mappedDepthPerPass, mappedMultiDepth, surfaceZ);

            // Laser context (null for CNC pipeline)
            let laserContext = null;
            if (this.pipelineType === 'laser' || this.pipelineType === 'hybrid') {
                const laserMachine = this.settings.laser;
                const strategy = this.compileOperationParams(operation, params);

                let computedPasses = 0;
                if (strategy.targetWidth > 0 && strategy.stepDistance > 0) {
                    const span = strategy.targetWidth - strategy.toolDiameter;
                    if (span >= 0) {
                        computedPasses = Math.floor(span / strategy.stepDistance) + 1;
                    }
                }

                // Spread strategy and layer on machine-level fields that compileOperationParams doesn't cover
                laserContext = {
                    ...strategy,
                    spotSize: laserMachine.spotSize,
                    exportFormat: laserMachine.exportFormat,
                    exportDPI: laserMachine.exportDPI,
                    computedPasses: computedPasses
                };
            }

            // Assemble final context
            const context = {
                // Metadata
                operationId: operation.id,
                operationType: operation.type,
                fileName: operation.file.name,

                // Global Settings
                machine: {
                    surfaceZ: surfaceZ,
                    safeZ: machine.heights.safeZ + surfaceZ,
                    travelZ: machine.heights.travelZ + surfaceZ,
                    feedHeight: machine.heights.feedHeight + surfaceZ,
                    rapidFeedRate: machine.speeds.rapidFeed,
                    maxFeedRate: machine.speeds.maxFeed,
                },
                // Processor-specific settings (Roland, Makera, etc.)
                gcode: { ...gcode,
                    supportsCannedCycles: processorInfo?.capabilities?.supportsCannedCycles
                },

                // Processor-specific settings (Roland, Makera, etc.)
                processorSettings: { ...(this.settings.processorSettings || {}) },

                // Operation Parameters
                //
                // `number` is machine-resolved and always >= 1. `drillNumbers`
                // maps originalDiameter.toFixed(3) → tool number for peck
                // groups; null on every non-drill operation.
                tool: (() => {
                    const t = resolvedTool || this.resolveToolDescriptor(operation, params, null);
                    return {
                        number: t.number,   // null = unassigned, on purpose
                        id: t.id,
                        name: t.name,
                        type: t.type,
                        diameter: params.toolDiameter,
                        spindleSpeed: params.spindleSpeed,
                        spindleDwell: params.spindleDwell,
                        drillNumbers: this.flattenDrillMap(t),
                        // False when the operation mills nothing of its own, so
                        // tool batching can sort it by the bits it actually calls
                        // rather than by a number no move in it ever uses.
                        cutsWithOwnTool: t.cutsWithOwnTool !== false
                    };
                })(),
                cutting: {
                    feedRate: params.feedRate,
                    plungeRate: params.plungeRate,
                    spindleSpeed: params.spindleSpeed,
                    spindleDwell: params.spindleDwell
                },
                strategy: {
                    cutDepth: params.cutDepth,
                    depthPerPass: mappedDepthPerPass,
                    multiDepth: mappedMultiDepth,
                    passes: params.passes,
                    stepOver: mappedStepOver,
                    entryType: mappedEntryType,
                    drill: {
                        millHoles: params.millHoles,
                        peckDepth: params.peckDepth,
                        dwellTime: params.dwellTime,
                        cannedCycle: params.cannedCycle,
                        retractHeight: params.retractHeight
                    },
                    cutout: {
                        tabs: params.tabs,
                        tabWidth: params.tabWidth,
                        tabHeight: params.tabHeight,
                        cutSide: params.cutSide
                    },
                    vcarve: {
                        vbitAngle: params.vbitAngle,
                        vbitTipDiameter: params.vbitTipDiameter,
                        vcarveMaxDepth: params.vcarveMaxDepth,
                        vcarveStartDepth: params.vcarveStartDepth
                    }
                },

                // Computed Values
                computed: {
                    offsetDistances,
                    depthLevels,
                    drillDepthLevels: this.buildDrillDepthLevels(operation, params, mappedDepthPerPass, mappedMultiDepth, surfaceZ),
                    toolpathPolicy: this.handlers.has(operation.type) ? this.getHandler(operation.type).getToolpathPolicy() : null
                },

                // Authoritative for everything per-diameter that is NOT baked
                // into geometry - tool number, feeds, peck cycle. The
                // geometry-affecting fields were resolved at generation and are
                // stamped on the primitives themselves. Null in single-tool mode
                // so the translator falls through to the operation's values.
                drillTable: isDrill && params.drillMultiTool ? (operation.drillTable || null) : null,

                // Transform Values
                transforms: transforms,

                // Config References
                // REVIEW - Are these still relevant? Do they still need to be linked like this?
                config: {
                    entry: D.toolpath.generation.entry,
                    drilling: D.toolpath.generation.drilling,
                    tabs: D.toolpath.tabs,
                    optimization: D.gcode.optimization,
                    precision: PRECISION,
                    offsettingEpsilon: EPSILON
                },

                // Laser-specific (only populated in laser/hybrid pipeline)
                laser: laserContext,

                // Rotary 4th-axis export routing.
                export: {
                    rotaryRoute,
                    // The user's PINNED machine-settings pick, unresolved.
                    // '' = auto. insertIndexMoves needs to tell "auto landed
                    // on wrapped-linear" (promotable to a-word) from "the user
                    // says this machine IS axis replacement" (not promotable).
                    requestedRoute: wantRoute,
                    // [INDEXED] Full declared list, not just the resolved
                    // pick: indexed 3+1 requires 'a-word' specifically and
                    // auto-switches to it (with a warning) when the post
                    // declares it but auto-resolution preferred another
                    // route. See MachineProcessor.insertIndexMoves.
                    routes: rotaryCaps.routes,
                    axisWords: rotaryCaps.axisWords,
                    inverseTime: rotaryCaps.inverseTime === true,
                    maxInverseTime: rotaryCaps.maxInverseTime,
                    // Machine setting wins; blank falls back to the post's
                    // declared default. This is a property of the rotary
                    // HARDWARE (belt vs geared/servo with a brake), so it
                    // cannot live in the post alone - one controller drives
                    // both kinds.
                    indexDwell: (gcode.indexDwell === '' || gcode.indexDwell == null)
                        ? (rotaryCaps.indexDwell || 0)
                        : Math.max(0, Number(gcode.indexDwell) || 0),
                    continuous: rotaryCaps.continuous !== false
                }
            };

            if (this.settings.gcode.postProcessor === 'roland') {
                this.preprocessRolandContext(context, operation);
            }

            // Prevent accidental mutation by downstream pipeline stages.
            // TODO [METADATA-BLOAT] - Deep-freeze nested objects or replace
            // plan.metadata.context references with explicit field copies.
            // Contract: after translate, ctx may be read ONLY via
            // plan.metadata.transforms (stamped by the translators) and - until
            // migrated - MachineProcessor's determineWinding. No other stage
            // may retain or read ctx. Freeze is the tamper canary for that.
            Object.freeze(context);

            return context;
        }

        /**
         * State & Query Methods
         */

        getAllPrimitives() {
            const primitives = [];
            this.operations.forEach(op => {
                if (op.primitives && op.primitives.length > 0) {
                    primitives.push(...op.primitives);
                }
            });
            return primitives;
        }

        getPreprocessedPrimitives() {
            if (!this.geometryProcessor) return [];
            return this.geometryProcessor.getCachedState('preprocessedGeometry') || [];
        }

        getFuseablePrimitives() {
            const primitives = [];
            this.operations.forEach(op => {
                if ((op.type === 'isolation' || op.type === 'clearing') &&
                    op.primitives && op.primitives.length > 0) {
                    primitives.push(...op.primitives);
                }
            });
            return primitives;
        }

        getIsolationPrimitives() {
            const primitives = [];
            this.operations.forEach(op => {
                if (op.type === 'isolation' && op.primitives && op.primitives.length > 0) {
                    primitives.push(...op.primitives);
                }
            });
            return primitives;
        }

        getOperationsByType(type) {
            return this.operations.filter(op => op.type === type);
        }

        updateStatistics() {
            this.stats.operations = this.operations.length;
            this.stats.totalPrimitives = this.operations.reduce((sum, op) =>
                sum + (op.primitives ? op.primitives.length : 0), 0);
            this.stats.layers = this.operations.filter(op => op.primitives && op.primitives.length > 0).length;
            this.stats.holes = this.operations
                .filter(op => op.type === 'drill')
                .reduce((sum, op) => sum + (op.primitives ? op.primitives.length : 0), 0);

            this.stats.toolpaths = Array.from(this.toolpaths.values())
                .reduce((sum, data) => sum + (data.paths?.length || 0), 0);
        }

        /**
         * Recomputes scene.boardBounds from the aggregate of all operation
         * bounds. Called after every operation parse/removal. EasyShape
         * doesn't populate operations, so it calls
         * scene.recomputeBoardBoundsFromShapes() instead.
         * REVIEW - This may need to go into one of the unique modules then?
         */
        updateBoardBounds() {
            if (!this.scene) return;
            const merged = GeometryUtils.mergeBounds(this.operations.map(op => op.bounds));
            if (merged) {
                this.scene.setBoardBounds(merged);
            } else {
                this.scene.initializeEmptyBoardBounds();
            }
        }

        validateFileType(fileName, operationType) {
            const extension = this.getFileExtension(fileName);
            const config = this.fileTypes[operationType];

            if (!config) {
                return { valid: false, message: `Unknown operation type: ${operationType}` };
            }

            if (config.extensions.includes(extension)) {
                return { valid: true, message: null };
            }

            return {
                valid: false,
                message: `Invalid file type for ${operationType}. Expected: ${config.extensions.join(', ')}`
            };
        }

        getFileExtension(fileName) {
            const match = fileName.toLowerCase().match(/(\.[^.]+)$/);
            return match ? match[1] : '';
        }

        getStats() {
            return { ...this.stats };
        }

        hasValidOperations() {
            return this.operations.some(op => op.primitives && op.primitives.length > 0);
        }

        isExportReady(op) {
            if (!op) return false;
            return !!(op.exportReady || op.preview?.ready);
        }

        /**
         * Fusion
         */

        async fuseAllPrimitives(options = {}) {
            this.debug('fuseAllPrimitives() - Entered fuseAllPrimitives. Received options:', options);

            const fusedResults = [];

            for (const operation of this.operations) {
                if ((operation.type === 'isolation' || operation.type === 'clearing') &&
                    operation.primitives && operation.primitives.length > 0) {

                    const fused = await this.geometryProcessor.fuseGeometry(operation.primitives, options);

                    fused.forEach(p => {
                        if (!p.properties) p.properties = {};
                        // p.properties.sourceOperationId = operation.id;
                        p.properties.operationType = operation.type;
                    });

                    fusedResults.push(...fused);
                }
            }

            return fusedResults;
        }

        /**
         * Debug & Stats
         */

        getProcessorStats() {
            const stats = {
                core: this.getStats(),
                hasGeometryProcessor: !!this.geometryProcessor,
                hasGeometryOffsetter: !!this.geometryOffsetter,
                processorInitialized: this.processorInitialized,
                isolationPrimitiveCount: this.getIsolationPrimitives().length,
                fuseablePrimitiveCount: this.getFuseablePrimitives().length,
                analyticPrimitives: this.stats.analyticPrimitives,
                polygonizedPrimitives: this.stats.polygonizedPrimitives,
                strokesConverted: this.stats.strokesConverted,
                toolpathCount: this.stats.toolpaths,
                hasToolLibrary: !!this.toolLibrary,
                registeredHandlers: Array.from(this.handlers.keys())
            };

            if (this.geometryProcessor) {
                stats.geometryProcessor = this.geometryProcessor.getStats();
                stats.cachedStates = {
                    hasPreprocessed: !!this.geometryProcessor.getCachedState('preprocessedGeometry'),
                    hasFused: !!this.geometryProcessor.getCachedState('fusedGeometry')
                };
                stats.arcReconstruction = this.geometryProcessor.getArcReconstructionStats();
            }

            return stats;
        }

        /**
         * Generates CNC toolpath results (G-code strings + metrics) without downloading.
         *
         * @param {Object} intent
         * @param {string[]} intent.operationIds
         * @param {boolean} [intent.singleFile]
         * @param {boolean} [intent.splitDrills]
         * @param {boolean} [intent.optimize]
         * @param {boolean} [intent.includeComments]
         * @param {boolean} [intent.toolChanges]
         * @param {ParameterManager} parameterManager
         * @returns {Object} keyed results: { [key]: { gcode, lineCount, planCount, estimatedTime, totalDistance, label } }
         */
        async generateCNCResults(intent, parameterManager) {
            if (!this.gcodeGenerator) {
                throw new Error('G-code generator not set - call setGCodeGenerator() first');
            }

            const gcodeConfig = this.settings.gcode;
            const processorSettings = this.settings.processorSettings || {};
            const rolandSettings = processorSettings.roland || {};

            // Resolve declared customParameters against the saved settings
            // first, falling back to each parameter's own default.
            const customPostParams = {};
            for (const p of (this.gcodeGenerator
                    .getProcessorInfo(gcodeConfig.postProcessor)?.customParameters || [])) {
                customPostParams[p.key] = gcodeConfig[p.key] ?? p.default;
            }

            const genOptions = {
                postProcessor: gcodeConfig.postProcessor,
                includeComments: intent.includeComments,
                singleFile: intent.singleFile,
                toolChanges: intent.toolChanges,
                groupByTool: intent.groupByTool,
                toolIndexMap: intent.toolIndexMap,
                userStartCode: gcodeConfig.userStartCode,
                userEndCode: gcodeConfig.userEndCode,
                units: gcodeConfig.units,
                toolLengthCompMode: gcodeConfig.toolLengthCompMode,
                ...customPostParams,
                safeZ: this.settings.machine.heights.safeZ,
                travelZ: this.settings.machine.heights.travelZ,
                maxSafeDepth: this.settings.machine.heights.maxSafeDepth,
                maxFeed: this.settings.machine.speeds.maxFeed,
                coolant: this.settings.machine.coolant,
                vacuum: this.settings.machine.vacuum,
                rolandModel: rolandSettings.rolandModel,
                rolandStepsPerMM: rolandSettings.rolandStepsPerMM,
                rolandMaxFeed: rolandSettings.rolandMaxFeed,
                rolandZMode: rolandSettings.rolandZMode,
                rolandSpindleMode: rolandSettings.rolandSpindleMode
            };

            const results = {};

            if (intent.singleFile) {
                const result = await this.runCNCPipeline(intent.operationIds, intent.optimize !== false, genOptions, parameterManager);
                results['__combined__'] = result;
            } else {
                for (const opId of intent.operationIds) {
                    const op = this.getOperation(opId);
                    if (!op) continue;

                    if (!op.preview || !op.preview.ready) {
                        this.debug(`Skipping ${op.sourceLabel || op.file?.name || op.id}: preview not ready`);
                        continue;
                    }

                    const isDrill = op.type === 'drill';
                    const shouldSplitDrill = isDrill && true === intent.splitDrillOpIds?.includes(opId);

                    if (shouldSplitDrill && typeof DrillHandler !== 'undefined') {
                        const { milledGroups, peckGroups } = DrillHandler.groupPrimitivesByDiameter(op);

                        const runWithPrimitives = async (primitives, resultKey, label) => {
                            const savedPreview = op.preview;
                            const savedOffsets = op.offsets;
                            op.preview = { ...savedPreview, primitives, ready: true };
                            op.offsets = [{ ...savedOffsets[0], primitives }];
                            try {
                                const result = await this.runCNCPipeline([op.id], intent.optimize !== false, genOptions, parameterManager);
                                if (result?.gcode) {
                                    results[resultKey] = { ...result, label };
                                } else {
                                    console.warn(`[Core] no G-code produced for ${resultKey} - operation omitted from the export.`);
                                }
                            } finally {
                                op.preview = savedPreview;
                                op.offsets = savedOffsets;
                            }
                        };

                        for (const group of milledGroups) {
                            await runWithPrimitives(
                                group.primitives,
                                `${opId}_milled_${group.diameter}mm`,
                                `drill milled ${group.diameter}mm: ${op.file.name} (${group.primitives.length} paths)`
                            );
                        }
                        for (const group of peckGroups) {
                            await runWithPrimitives(
                                group.primitives,
                                `${opId}_drill_${group.diameter}mm`,
                                `drill ${group.diameter}mm: ${op.file.name} (${group.primitives.length} holes)`
                            );
                        }
                    } else {
                        const result = await this.runCNCPipeline([op.id], intent.optimize !== false, genOptions, parameterManager);
                        if (result?.gcode) {
                            results[opId] = { ...result, label: `${op.type}: ${op.file.name}` };
                        } else {
                            console.warn(`[Core] no G-code produced for ${opId} - operation omitted from the export.`);
                        }
                    }
                }
            }

            return results;
        }

        /**
         * Assembles { operation, context } pairs for the toolpath pipeline.
         *
         * Tool numbers are resolved for the WHOLE batch before any context is
         * built: buildToolpathContext ends in Object.freeze, so a descriptor
         * assembled per-operation could not see its siblings' claims, and a
         * post-hoc `context.tool = …` would throw under 'use strict'.
         *
         * @param {string[]|null} operationIds  null = every export-ready op
         * @param {ParameterManager} parameterManager
         * @param {{warnLabel?:string, toolIndexMap?:Object}} [options]
         */
        buildOperationContextPairs(operationIds, parameterManager, options = {}) {
            const label = options.warnLabel || 'pipeline';

            // Commit params and resolve descriptors
            const staged = this.stageToolDescriptors(
                operationIds, parameterManager, options.toolIndexMap);

            // Build contexts against the resolved descriptors
            const pairs = [];
            for (const entry of staged) {
                try {
                    const context = this.buildToolpathContext(
                        entry.opId, parameterManager, entry.tool);
                    pairs.push({ operation: entry.operation, context });
                } catch (err) {
                    console.warn(`[${label}] skipping operation ${entry.opId}: ${err.message}`);
                }
            }
            return pairs;
        }

        /**
         * Internal: buildContext → executePipeline → generate G-code → metrics.
         */
        async runCNCPipeline(operationIds, optimize, genOptions, parameterManager) {
            const operationContextPairs = this.buildOperationContextPairs(
                operationIds, parameterManager, {
                    warnLabel: 'CNC',
                    toolIndexMap: genOptions?.toolIndexMap
                });

            if (operationContextPairs.length === 0) {
                return { gcode: '; No valid operations to process', lineCount: 1, planCount: 0, estimatedTime: 0, totalDistance: 0 };
            }

            const { plans, warnings } = await this.executePipeline(operationContextPairs, {
                optimize,
                // Reordering is the user's call, not a side effect of asking
                // for tool-change commands: it overrides the drag order they
                // set in the export list.
                groupByTool: genOptions?.groupByTool === true
                    && genOptions?.singleFile === true
            });
            if (warnings?.length) {
                // executePipeline collects these (dropped rotary plans, etc.)
                console.warn(`[Core] Pipeline warnings:\n  ${warnings.join('\n  ')}`);
            }
            const gcode = this.gcodeGenerator.generate(plans, genOptions);
            const firstContext = operationContextPairs[0].context;
            const lineCount = (typeof gcode === 'string' && gcode.length > 0)
                ? gcode.trim().split('\n').length
                : 0;

            const { estimatedTime, totalDistance } = this.machineProcessor.calculatePathMetrics(plans, firstContext);

            return {
                gcode, lineCount, planCount: plans.length,
                estimatedTime, totalDistance,
                toolChanges: this.gcodeGenerator.lastToolChangeCount || 0,
                warnings: [...(warnings || []), ...(this.gcodeGenerator.lastWarnings || [])]
            };
        }

        /**
         * Roland-specific context preprocessing.
         * Enforces machine-safe settings based on the selected Roland profile.
         */
        preprocessRolandContext(ctx, operation) {
            const rolandSettings = ctx.processorSettings?.roland || {};
            const rolandModel = rolandSettings.rolandModel;

            const rolandProcessor = this.gcodeGenerator.getProcessor('roland');
            const rolandProfile = rolandProcessor?.getProfile
                ? rolandProcessor.getProfile(rolandModel)
                : null;

            const rolandZMode = rolandSettings.rolandZMode || rolandProfile?.zMode || '3d';

            if (rolandZMode === '2.5d') {
                ctx.strategy.entryType = 'plunge';
                if (operation.type === 'cutout') {
                    ctx.strategy.cutout.tabs = 0;
                }
                if (operation.type === 'drill' && ctx.strategy.drill.millHoles) {
                    if (!ctx.strategy.multiDepth) ctx.strategy.multiDepth = true;
                    const maxSafeStep = ctx.tool.diameter * 0.5;
                    if (Math.abs(ctx.strategy.depthPerPass) > maxSafeStep) {
                        ctx.strategy.depthPerPass = maxSafeStep;
                    }
                }
            }

            if (rolandProfile) {
                const maxCutFeedMmMin = rolandProfile.maxFeedXY * 60;
                const maxPlungeFeedMmMin = rolandProfile.maxFeedZ * 60;
                if (ctx.cutting.feedRate > maxCutFeedMmMin) {
                    ctx.cutting.feedRate = maxCutFeedMmMin;
                }
                if (ctx.cutting.plungeRate > maxPlungeFeedMmMin) {
                    ctx.cutting.plungeRate = maxPlungeFeedMmMin;
                }
            }
        }

        /**
         * Unified export coordinator. Handles CNC, Laser, and Stencil pipelines,
         * then triggers browser downloads.
         *
         * @param {Object} intent
         * @param {string[]} [intent.cncOperationIds]
         * @param {string[]} [intent.laserOperationIds]
         * @param {string[]} [intent.stencilOperationIds]
         * @param {boolean} intent.singleFile
         * @param {string} intent.baseName
         * @param {string[]} [intent.splitDrillOpIds]
         * @param {boolean} [intent.optimize]
         * @param {boolean} [intent.includeComments]
         * @param {boolean} [intent.toolChanges]
         * @param {number} [intent.laserPadding]
         * @param {number} [intent.stencilPadding]
         * @param {Object} [intent.gcodeResults] - Pre-calculated from preview
         * @param {ParameterManager} parameterManager
         * @returns {{ success: boolean, message: string }}
         */
        async executeExport(intent, parameterManager) {
            const allFiles = [];
            const parts = [];
            const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

            // CNC
            const cncOps = (intent.cncOperationIds || []).map(id => this.getOperation(id)).filter(Boolean);
            if (cncOps.length > 0) {
                const processorInfo = this.gcodeGenerator.getProcessorInfo(this.settings.gcode.postProcessor);
                const cncExt = processorInfo.fileExtension;

                let gcodeResults = intent.gcodeResults;
                if (!gcodeResults || Object.keys(gcodeResults).length === 0) {
                    gcodeResults = await this.generateCNCResults({
                        operationIds: intent.cncOperationIds,
                        singleFile: intent.singleFile,
                        splitDrills: intent.splitDrills,
                        optimize: intent.optimize ?? true,
                        includeComments: intent.includeComments,
                        toolChanges: intent.toolChanges,
                        groupByTool: intent.groupByTool,
                        toolIndexMap: intent.toolIndexMap
                    }, parameterManager);
                }

                if (intent.singleFile) {
                    const combined = gcodeResults['__combined__'];
                    if (combined?.gcode) {
                        allFiles.push({
                            blob: new Blob([combined.gcode], { type: 'text/plain' }),
                            filename: `${intent.baseName}${cncExt}`
                        });
                    }
                } else {
                    for (const op of cncOps) {
                        const splitKeys = Object.keys(gcodeResults).filter(k => k.startsWith(`${op.id}_`));
                        if (splitKeys.length > 0) {
                            for (const key of splitKeys) {
                                const result = gcodeResults[key];
                                if (result?.gcode) {
                                    const opCleanName = op.file.name.replace(/\.[^/.]+$/, '');
                                    const suffix = key.substring(op.id.length + 1).replace(/_/g, '-');
                                    allFiles.push({
                                        blob: new Blob([result.gcode], { type: 'text/plain' }),
                                        filename: `${intent.baseName}-${suffix}-${opCleanName}${cncExt}`
                                    });
                                }
                            }
                        } else {
                            const result = gcodeResults[op.id];
                            if (result?.gcode) {
                                const opCleanName = op.file.name.replace(/\.[^/.]+$/, '');
                                allFiles.push({
                                    blob: new Blob([result.gcode], { type: 'text/plain' }),
                                    filename: `${intent.baseName}-${op.type}-${opCleanName}${cncExt}`
                                });
                            }
                        }
                    }
                }
                if (allFiles.length > 0) parts.push('G-code');
            }

            // Laser
            const laserOps = (intent.laserOperationIds || []).map(id => this.getOperation(id)).filter(Boolean);
            if (laserOps.length > 0) {
                const unready = laserOps.filter(op => !op.offsets || op.offsets.length === 0);
                if (unready.length > 0) {
                    this.debug(`Laser export blocked: ${unready.map(o => o.file.name).join(', ')} missing paths`);
                } else {
                    const laserSettings = this.settings.laser;
                    const activeProfile = laserSettings.profiles?.[laserSettings.activeProfile || 'generic'] || {};

                    const result = await this.generateLaserExportFiles(laserOps, parameterManager, {
                        format: laserSettings.exportFormat,
                        dpi: laserSettings.exportDPI,
                        padding: intent.laserPadding ?? laserSettings.exportPadding,
                        includeComments: intent.includeComments,
                        singleFile: intent.singleFile,
                        baseName: intent.baseName,
                        layerColors: laserSettings.layerColors,
                        heatManagement: laserSettings.heatManagement,
                        reverseCutOrder: laserSettings.reverseCutOrder,
                        svgGrouping: laserSettings.svgGrouping,
                        colorPerPass: laserSettings.colorPerPass,
                        palette: activeProfile.palette,
                        paletteLumping: activeProfile.paletteLumping
                    });

                    if (result.success) {
                        allFiles.push(...result.files);
                        parts.push('Laser');
                    }
                }
            }

            // Stencil
            const stencilOps = (intent.stencilOperationIds || []).map(id => this.getOperation(id)).filter(Boolean);
            if (stencilOps.length > 0) {
                const unready = stencilOps.filter(op => !op.offsets || op.offsets.length === 0);
                if (unready.length > 0) {
                    this.debug(`Stencil export blocked: ${unready.map(o => o.file.name).join(', ')} missing geometry`);
                } else {
                    const result = await this.generateLaserExportFiles(stencilOps, parameterManager, {
                        layerColors: { stencil: '#000000' },
                        format: 'svg',
                        padding: intent.stencilPadding ?? 5.0,
                        includeComments: intent.includeComments,
                        singleFile: intent.singleFile,
                        baseName: intent.baseName + '-stencil',
                        heatManagement: 'off',
                        reverseCutOrder: false,
                        svgGrouping: 'layer',
                        colorPerPass: false
                    });

                    if (result.success) {
                        allFiles.push(...result.files);
                        parts.push('Stencil');
                    }
                }
            }

            // Downloads
            if (allFiles.length > 0) {
                await this.executeDownloads(allFiles, { isWebKit });
                return { success: true, message: `${parts.join(' + ')} export completed successfully` };
            }

            return { success: false, message: 'No files generated.' };
        }

        /**
         * Browser download utility
         */
        triggerDownload(blob, filename) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        }

        /**
         * Downloads an array of files sequentially with WebKit pacing.
         * @param {Array<{blob: Blob, filename: string}>} files
         * @param {Object} [options]
         * @param {boolean} [options.isWebKit] - Add delay between downloads for Safari
         */
        async executeDownloads(files, options = {}) {
            const downloadDelay = () => options.isWebKit
                ? new Promise(res => setTimeout(res, 500))
                : Promise.resolve();

            for (const file of files) {
                this.triggerDownload(file.blob, file.filename);
                await downloadDelay();
            }
        }

        /**
         * Generates laser/stencil export files using the unified context builder.
         * Returns blobs without triggering downloads - caller decides when to download.
         *
         * @param {Array} operations - Operation objects to export
         * @param {ParameterManager} parameterManager - For buildToolpathContext
         * @param {Object} [exportOverrides] - Per-job overrides (padding, baseName, singleFile, etc.)
         * @returns {{ success: boolean, files: Array<{blob: Blob, filename: string}> }}
         */
        async generateLaserExportFiles(operations, parameterManager, exportOverrides = {}) {
            this.debug('generateLaserExportFiles: starting');

            if (!operations || operations.length === 0) {
                return { success: false, files: [] };
            }

            // Base settings from core (single source of truth)
            const laserSettings = this.settings.laser;
            const format = exportOverrides.format || laserSettings.exportFormat;
            const dpi = exportOverrides.dpi || laserSettings.exportDPI;
            const padding = exportOverrides.padding ?? laserSettings.exportPadding ?? D.laser.exportPadding;
            const singleFile = exportOverrides.singleFile !== false;
            const baseName = exportOverrides.baseName || D.export.defaultBaseName;

            // Resolve active profile for structural settings
            const activeProfileKey = laserSettings.activeProfile || 'generic';
            const activeProfile = laserSettings.profiles?.[activeProfileKey] || {};

            // Global transforms from core context builder
            const transforms = this.getTransforms();

            const commonOptions = {
                dpi,
                padding,
                transforms,
                bounds: this.scene?.boardBounds,
                heatManagement: exportOverrides.heatManagement ?? ((laserSettings.heatManagement !== 'off' && format !== 'png') ? laserSettings.heatManagement : 'off'),
                reverseCutOrder: exportOverrides.reverseCutOrder ?? laserSettings.reverseCutOrder ?? false,
                svgGrouping: exportOverrides.svgGrouping ?? laserSettings.svgGrouping ?? 'layer',
                colorPerPass: exportOverrides.colorPerPass ?? laserSettings.colorPerPass ?? false,
                palette: exportOverrides.palette ?? activeProfile.palette ?? null,
                paletteLumping: exportOverrides.paletteLumping ?? activeProfile.paletteLumping ?? false,
                includeComments: exportOverrides.includeComments
            };

            // REVIEW - This should pull comments from the Language file. It should also be moved into the laser export file...
            if (exportOverrides.includeComments) {
                commonOptions.commentBlock = commonOptions.commentBlock || [];
                const appName = this.appProfile.meta.app;
                commonOptions.commentBlock.push(`${appName} SVG Export`);
                commonOptions.commentBlock.push(`Date: ${new Date().toLocaleString()}`);
                commonOptions.commentBlock.push(`Operations ${operations.length}:`);
                operations.forEach(op => {
                    commonOptions.commentBlock.push(`  - ${op.type}: ${op.file.name}`);
                });
            }

            const layerColors = exportOverrides.layerColors || laserSettings.layerColors || {};

            // Build layer from operation using unified context
            const buildLayer = (op) => {
                if (!op.offsets || op.offsets.length === 0) return null;

                // Use context builder for per-operation data
                let strokeWidth = laserSettings.spotSize;
                try {
                    const context = this.buildToolpathContext(op.id, parameterManager);
                    if (context.laser?.spotSize) {
                        strokeWidth = context.laser.spotSize;
                    }
                } catch (e) {
                    this.debug(`buildToolpathContext failed for ${op.id}, using global spotSize: ${e.message}`);
                }

                const color = layerColors[op.type] || '#000000';
                const passes = op.offsets.map((offset, idx) => ({
                    passIndex: idx + 1,
                    type: offset.type || 'offset',
                    primitives: offset.primitives || [],
                    metadata: {
                        ...(offset.metadata || {}),
                        offsetType: offset.offsetType || 'external',
                        thermalGroup: offset.metadata?.thermalGroup || offset.thermalGroup || 'shell',
                        pass: offset.pass || idx + 1,
                        distance: offset.distance
                    }
                }));

                const isStencil = op.type === 'stencil';
                let layerName = op.type;
                if (isStencil) {
                    const cleanName = op.file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
                    layerName = `Stencil_${cleanName}`;
                }

                return {
                    operationId: op.id,
                    operationType: op.type,
                    fileName: op.file.name,
                    baseColor: color,
                    layerName: layerName,
                    strokeWidth: strokeWidth,
                    passes
                };
            };

            // Split into layer groups based on format
            const isPNGFormat = format === 'png';
            const rasterTypes = ['isolation', 'clearing'];
            let layerGroups;

            if (isPNGFormat) {
                const rasterLayers = [];
                const vectorLayers = [];
                for (const op of operations) {
                    const layer = buildLayer(op);
                    if (!layer) continue;
                    if (rasterTypes.includes(op.type)) {
                        rasterLayers.push(layer);
                    } else {
                        vectorLayers.push(layer);
                    }
                }
                layerGroups = [];
                if (rasterLayers.length > 0) layerGroups.push({ layers: rasterLayers, format: 'png', suffix: '' });
                if (vectorLayers.length > 0) layerGroups.push({ layers: vectorLayers, format: 'svg', suffix: '-vectors' });
            } else if (singleFile) {
                const allLayers = operations.map(buildLayer).filter(Boolean);
                layerGroups = allLayers.length > 0 ? [{ layers: allLayers, format: 'svg', suffix: '' }] : [];
            } else {
                layerGroups = [];
                for (const op of operations) {
                    const layer = buildLayer(op);
                    if (!layer) continue;
                    const isRasterOp = isPNGFormat && rasterTypes.includes(op.type);
                    layerGroups.push({
                        layers: [layer],
                        format: isRasterOp ? 'png' : 'svg',
                        suffix: `-${op.type}`
                    });
                }
            }

            if (layerGroups.length === 0) {
                return { success: false, files: [] };
            }

            if (typeof GraphicsExporter === 'undefined') {
                console.error('[Core] GraphicsExporter module not loaded');
                return { success: false, files: [] };
            }

            const exporter = new GraphicsExporter();
            const files = [];

            try {
                for (const group of layerGroups) {
                    const ext = group.format === 'png' ? '.png' : '.svg';
                    const filename = `${baseName}${group.suffix}${ext}`;

                    const result = await exporter.generate(group.layers, {
                        ...commonOptions,
                        format: group.format
                    });

                    if (result && result.blob) {
                        files.push({ blob: result.blob, filename });
                    }
                }
            } catch (error) {
                console.error('[Core] Laser export generation failed:', error);
                return { success: false, files: [] };
            }

            return { success: files.length > 0, files };
        }

        debug(message, data = null) {
            if (debugState.enabled) {
                if (data !== null) {
                    console.log(`[Core] ${message}`, data);
                } else {
                    console.log(`[Core] ${message}`);
                }
            }
        }
    }

    // Internal Utilities

    /**
     * Deep-merges one or more source objects into target.
     * Arrays are replaced, not concatenated. Pure utility - no class dependency.
     */
    function mergeDeep(target, ...sources) {
        for (const source of sources) {
            for (const key of Object.keys(source)) {
                if (
                    source[key] &&
                    typeof source[key] === 'object' &&
                    !Array.isArray(source[key]) &&
                    target[key] &&
                    typeof target[key] === 'object' &&
                    !Array.isArray(target[key])
                ) {
                    mergeDeep(target[key], source[key]);
                } else {
                    target[key] = source[key];
                }
            }
        }
        return target;
    }

    window.CamCore = CamCore;
})();