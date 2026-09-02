/*!
 * @file        core/cam-core.js
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
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class CamCore {
        constructor(options = {}) {
            // Operation lifetime and artifact state.
            // Hooks, not a back-reference: the store must not be able to reach
            // parsers, geometry, tools or export through this object.
            this.store = new OperationStore({
                settingsRevision: () => this.settingsRevision,
                machineClassOf: (operation) => this.machineClassOf(operation),
            });

            // Operation + ParameterManager values -> frozen pipeline context.
            // Pipeline stage, so it takes core - same shape as
            // new GeometryTranslator(this) / new MachineProcessor(this).
            this.pipelineContext = new PipelineContextBuilder(this);

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

            // Operation registry - installed by CamController.loadProfile
            this.registry = null;

            // Settings - populated by controller via loadSettings(storageKey)
            this.settings = JSON.parse(JSON.stringify(D));

            // Universal workspace state
            // Scene owns the geometry tree, selection, the global workspace
            // transform (origin/rotation/mirror), spatial queries (pick,
            // marquee, viewport), AND coordinate-space conversions.
            // sceneInteraction is kept as an alias so existing call sites
            // (tools, readouts, buildToolContext) work unchanged.
            this.scene = new Scene();
            this.sceneInteraction = this.scene;

            this.machineClass = 'router';
            this.classByType = null;

            /**
             * Monotonic counter for every GLOBAL input a generated artifact
             * depends on but no per-operation flag watched: machine heights,
             * stock thickness and zero reference, the workspace transform,
             * the post-processor and the tool library. Artifacts stamp it;
             * isArtifactStale compares. One integer beats six invalidation
             * call sites, and an unknown state reads as stale, so the
             * failure mode is a recompute rather than a wrong file.
             */
            this.settingsRevision = 0;

            this.scene.addTransformListener((change) => {
                this.bumpSettingsRevision({ source: 'scene', action: change.action });
                for (const op of this.operations) {
                    this.refreshStaleFlags(op.id, 'Workspace transform changed - recalculate toolpaths before export.');
                }
            });


            // Initialise scene with an empty 100x100 board so the renderer
            // has something to fit on before any geometry loads.
            this.scene.initializeEmptyBoardBounds();

            // Geometry processors
            this.geometryProcessor = null;
            this.ingest = new OperationIngest(this);
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
                this.bumpSettingsRevision();
            }
        }

        /**
         * Installs the operation registry. Replaces the old setFileTypes(),
         * which synthesised a per-type `color` from profiles that never
         * declared one - the renderer resolves colour through
         * options.resolveLayerColor and has never read layer.color.
         */
        setRegistry(registry) {
            this.registry = registry;
            this.store.setRegistry(registry);
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
                return this.initializationPromise || true;
            }

            this.isInitializing = true;
            this.debug('Initializing processors with Clipper2...');

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
            this.geometryOffsetter = new GeometryOffsetter({
                precision: PRECISION,
                miterLimit: D.geometry.offsetting.miterLimit
            });
            // Link processor for union operations
            this.geometryOffsetter.setGeometryProcessor(this.geometryProcessor);
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

        /**
         * Pipeline Component Initialization
         *
         * The core owns the translate → optimize → machine pipeline.
         * Called by the application controller after core construction
         * so that pipeline components exist before any toolpath work.
         */

        initializePipeline() {
            this.geometryTranslator = new GeometryTranslator(this);
            this.toolpathOptimizer = new ToolpathOptimizer();
            this.machineProcessor = new MachineProcessor(this);
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
        registerParser(extension, parser) { return this.ingest.registerParser(extension, parser); }
        getParser(fileName) { return this.ingest.getParser(fileName); }

        /**
         * Sets the session machine class. `classByType` carries per-type
         * overrides; nothing here is authoritative for an operation that
         * already carries its own `machineClass` stamp.
         */
        setMachineClass(machineClass, classByType = null) {
            this.machineClass = machineClass || 'router';
            this.classByType = classByType || null;
            this.debug(`Machine class set: ${this.machineClass}`, classByType);
        }

        /**
         * Class an operation runs on. Stamp first, then override, then session.
         */
        machineClassOf(operation) {
            if (operation?.machineClass) return operation.machineClass;
            const type = operation?.type;
            const preferred = (type && this.classByType?.[type]) || this.machineClass;
            return this.registry?.resolveMachineClass(type, preferred) || preferred;
        }

        isLaserOperation(operation) {
            return this.machineClassOf(operation) === 'laser';
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
                // REVIEW - Possibly useless by now. Or maybe do something when there's an error?
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
         * buildPipelineContext at export - but indexed generation reads the
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

            // Heights, stock, post and laser all feed toolpath translation.
            // 'pipeline' is bookkeeping and cannot move a coordinate.
            if ('pipeline' !== category) this.bumpSettingsRevision({ category }); // REVIEW - This was previously if (category !== 'pipeline') this.bumpSettingsRevision(); does the current version make more sense?

            if (postChanged) this.invalidateIndexedOperations(settings.postProcessor);
        }

        // Operation state (delegated to OperationStore)
        // Kept as forwards so call sites migrate to core.store.* gradually
        get operations() { return this.store.operations; }
        get toolpaths() { return this.store.toolpaths; }
        get stats() { return this.store.stats; }

        createOperation(operationType, source) { return this.store.createOperation(operationType, source); }
        getOperation(id) { return this.store.getOperation(id); }
        indexOperation(operation) { return this.store.indexOperation(operation); }
        unindexOperation(operationId) { return this.store.unindexOperation(operationId); }
        resetOperationState(operationId) { return this.store.resetOperationState(operationId); }
        generateCNCPreview(operationId) { return this.store.generateCNCPreview(operationId); }

        removeOperation(operationId) {
            // updateBoardBounds needs the scene, which the store deliberately
            // cannot reach.
            if (!this.store.removeOperation(operationId)) return false;
            this.updateBoardBounds();
            return true;
        }

        clearAll() {
            this.store.clearAll();
            this.updateBoardBounds();
        }

        bumpOperationRevision(operationId, stage) { return this.store.bumpOperationRevision(operationId, stage); }
        currentStamp(operationId) { return this.store.currentStamp(operationId); }
        stampArtifact(operationId, name) { return this.store.stampArtifact(operationId, name); }
        artifactDependencies(operation, name) { return this.store.artifactDependencies(operation, name); }
        isArtifactStale(operation, name) { return this.store.isArtifactStale(operation, name); }
        refreshStaleFlags(operationId, reason = null) { return this.store.refreshStaleFlags(operationId, reason); }
        invalidateOperationState(operationId) { return this.store.invalidateOperationState(operationId); }
        invalidateIndexedOperations(postProcessor) { return this.store.invalidateIndexedOperations(postProcessor); }
        deleteOperationGeometry(operationId, geometryType) { return this.store.deleteOperationGeometry(operationId, geometryType); }

        getToolpaths(operationId) { return this.store.getToolpaths(operationId); }
        clearToolpaths(operationId) { return this.store.clearToolpaths(operationId); }

        updateStatistics() { return this.store.updateStatistics(); }
        getStats() { return this.store.getStats(); }
        hasValidOperations() { return this.store.hasValidOperations(); }
        isExportReady(op) { return this.store.isExportReady(op); }

        // Revisions & artifact stamps

        /**
         * A global input changed: heights, stock, workspace, post, tools.
         * The event is what lets a view that mirrors settings (the 3D stock box)
         * rebuild without every settings writer knowing it exists.
         */
        bumpSettingsRevision(detail = {}) {
            this.settingsRevision++;
            window.dispatchEvent(new CustomEvent('settingschange', { detail }));
        }

        // Per-operation toolpaths

        /**
         * Machine-ready plans for ONE operation, stopping before G-code.
         *
         * This is the same pipeline the exporter runs, with a single pair
         * and convertRotary off (the preview semantic MachineProcessor
         * already understands as previewMode). Three behaviours in that
         * pipeline are BATCH-stateful, so a per-operation plan is correct
         * WITHIN the operation and has no defined relationship to its
         * neighbours:
         *
         *   - executePipeline threads currentMachinePos across operations;
         *     here it starts at safeZ over the origin.
         *   - MachineProcessor.processPlans backward-fills metadata.tool
         *     over the list it is given, so this run assumes its own tool
         *     is already in the spindle.
         *   - convertDevelopedToRotary runs one cursor per call.
         *
         * The job export recomputes as a batch rather than concatenating
         * these. Do not "optimise" that away.
         */
        // TODO(pipeline-entry) - computeToolpaths (plans, one operation),
        // generateCNCResults (G-code, a batch) and CamController.calculateToolpaths
        // (a forward to the second) are three names for two artifacts. The
        // difference is currentMachinePos, backward-filled metadata.tool and one
        // convertDevelopedToRotary cursor.
        async computeToolpaths(operationId, parameterManager, options = {}) {
            const operation = this.getOperation(operationId);
            if (!operation) throw new Error(`Operation ${operationId} not found`);

            const pairs = this.buildOperationContextPairs(
                [operationId], parameterManager, { warnLabel: 'toolpath' });

            if (pairs.length === 0) {
                throw new Error('Could not build a toolpath context for this operation');
            }

            const { plans, warnings } = await this.executePipeline(pairs, {
                optimize: options.optimize !== false,
                // Preview frame: rotary stays in developed space and
                // insertIndexMoves runs in previewMode.
                convertRotary: false
            });

            const metrics = this.machineProcessor.calculatePathMetrics(plans, pairs[0].context);

            this.store.setToolpaths(operationId, {
                plans,
                warnings: warnings || [],
                metrics,
                generatedAt: Date.now(),
            });
            this.stampArtifact(operationId, 'toolpath');
            this.updateStatistics();

            return { plans, warnings: warnings || [], metrics };
        }

        // Ingest (delegated to OperationIngest)
        // Forwards, so call sites migrate to core.ingest.* gradually rather
        // than in the commit that moved the code.
        parseOperation(operation) { return this.ingest.parseOperation(operation); }
        analyzeGeometricContext(operation, primitives) { return this.ingest.analyzeGeometricContext(operation, primitives); }
        validateAndOptimizePrimitives(primitives) { return this.ingest.validateAndOptimizePrimitives(primitives); }
        compositeByPolarity(primitives) { return this.ingest.compositeByPolarity(primitives); }
        getGeometrySummary(operation) { return this.ingest.getGeometrySummary(operation); }
        recalculateBounds(primitives) { return this.ingest.recalculateBounds(primitives); }

        // PipelineContextBuilder delegators
        // Call sites migrate to core.pipelineContext.* opportunistically, the
        // same way store and ingest did. TODO(context-delegators) - delete
        // once nothing outside this file calls these on CamCore.

        getTransforms() {
            return this.pipelineContext.getTransforms();
        }

        buildPipelineContext(operationId, parameterManager, resolvedTool = null) {
            return this.pipelineContext.buildPipelineContext(operationId, parameterManager, resolvedTool);
        }

        compileOperationParams(operation, params) {
            return this.pipelineContext.compileOperationParams(operation, params);
        }

        resolveSurfaceZ(operation) {
            return this.pipelineContext.resolveSurfaceZ(operation);
        }

        calculateDepthLevels(cutDepth, depthPerPass, multiDepth, surfaceZ = 0) {
            return this.pipelineContext.calculateDepthLevels(cutDepth, depthPerPass, multiDepth, surfaceZ);
        }

        buildDrillDepthLevels(operation, params, depthPerPass, multiDepth, surfaceZ) {
            return this.pipelineContext.buildDrillDepthLevels(operation, params, depthPerPass, multiDepth, surfaceZ);
        }

        resolveToolDescriptor(operation, params, override = null) {
            return this.pipelineContext.resolveToolDescriptor(operation, params, override);
        }

        describeToolSharing(descriptors) {
            return this.pipelineContext.describeToolSharing(descriptors);
        }

        stageToolDescriptors(operationIds, parameterManager, toolIndexMap = {}) {
            return this.pipelineContext.stageToolDescriptors(operationIds, parameterManager, toolIndexMap);
        }

        checkToolAssignment(operationIds, parameterManager, opts = {}) {
            return this.pipelineContext.checkToolAssignment(operationIds, parameterManager, opts);
        }

        flattenDrillMap(descriptor) {
            return this.pipelineContext.flattenDrillMap(descriptor);
        }

        resolveDrillAlias(operation, params, plainKey, drillKey) {
            return this.pipelineContext.resolveDrillAlias(operation, params, plainKey, drillKey);
        }

        /*
         * TO-DO
         * Generates the full-board clearance polygon to remove all unused copper - requires a cutout file for an outer-edge. Implement a dedicated operation handler extension to trace-cutout?
         * async generateUnusedCopperPolygon() {}
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
         * State & Query Methods
         */

        getPreprocessedPrimitives() {
            if (!this.geometryProcessor) return [];
            return this.geometryProcessor.getCachedState('preprocessedGeometry') || [];
        }

        /**
         * Recomputes scene.boardBounds from the aggregate of all operation
         * bounds. Called after every operation parse/removal. EasyShape
         * doesn't populate operations, so it calls
         * scene.recomputeBoardBoundsFromShapes() instead.
         * REVIEW - This may need to go into one of the unique modules then?
         */
        updateBoardBounds() {
            const merged = GeometryUtils.mergeBounds(this.operations.map(op => op.bounds));
            if (merged) {
                this.scene.setBoardBounds(merged);
            } else {
                this.scene.initializeEmptyBoardBounds();
            }
        }

        validateFileType(fileName, operationType) { return this.ingest.validateFileType(fileName, operationType); }
        getFileExtension(fileName) { return this.ingest.getFileExtension(fileName); }

        /**
         * Generates CNC toolpath results (G-code strings + metrics) without downloading.
         *
         * @param {Object} intent
         * @param {string[]} intent.operationIds
         * @param {boolean} [intent.singleFile]
         * @param {string[]} [intent.splitDrillOpIds]
         * @param {boolean} [intent.optimize]
         * @param {boolean} [intent.includeComments]
         * @param {boolean} [intent.toolChanges]
         * @param {ParameterManager} parameterManager
         * @returns {Object} keyed results: { [key]: { gcode, lineCount, planCount, estimatedTime, totalDistance, label } }
         */
        // TODO(pipeline-entry) - computeToolpaths (plans, one operation),
        // generateCNCResults (G-code, a batch) and CamController.calculateToolpaths
        // (a forward to the second) are three names for two artifacts. The
        // difference is currentMachinePos, backward-filled metadata.tool and one
        // convertDevelopedToRotary cursor.
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
                lineNumbers: gcodeConfig.lineNumbers,
                lineNumberStep: gcodeConfig.lineNumberStep,
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

                    if (!this.isExportReady(op)) {
                        this.debug(`Skipping ${op.sourceLabel || op.file?.name || op.id}: not export ready`);
                        continue;
                    }

                    const isDrill = op.type === 'drill';
                    const shouldSplitDrill = isDrill && true === intent.splitDrillOpIds?.includes(opId);

                    if (shouldSplitDrill) {
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

                        // One file per BIT. DrillHandler.splitDrillFiles owns the
                        // decision - the modal's enable gate calls the same
                        // method, so the toggle can never offer a split the
                        // export then declines to make.
                        for (const file of DrillHandler.splitDrillFiles(op)) {
                            await runWithPrimitives(
                                file.primitives,
                                `${opId}_${file.key}`,
                                `${file.label}: ${op.file.name} (${file.primitives.length} features)`
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
         * built: buildPipelineContext ends in Object.freeze, so a descriptor
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
                    const context = this.buildPipelineContext(
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
         * Vector/raster export. The engine supplies the session facts; the
         * exporter owns the mapping and the rendering.
         */
        // REVIEW - what ever calls this can call the graphics-exporter directly no?
        generateLaserExportFiles(operations, parameterManager, exportOverrides = {}) {
            return new GraphicsExporter().exportOperations(operations, {
                laser: this.settings.laser,
                transforms: this.getTransforms(),
                bounds: this.scene.boardBounds,
                appName: this.appProfile.meta.app,
                spotSizeFor: (op) => {
                    try {
                        return this.buildPipelineContext(op.id, parameterManager).laser?.spotSize ?? null;
                    } catch (e) {
                        this.debug(`buildPipelineContext failed for ${op.id}, using global spotSize: ${e.message}`);
                        return null;
                    }
                }
            }, exportOverrides);
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