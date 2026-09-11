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
    const ROOT = globalThis;

    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const MP = ROOT.CAMConfig.machineParameters;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class CamCore {
        constructor(options = {}) {
            this._emit = options.emit || null;
            // Settings persistence. Injected for the same reason the emitter is:
            // localStorage is the last browser global in this file, and a
            // headless caller supplies its own store or none at all.
            this._storage = options.storage || { getItem: () => null, setItem: () => {} };
            // Operation lifetime and artifact state.
            // Hooks, not a back-reference: the store must not be able to reach
            // parsers, geometry, tools or export through this object.
            this.store = new OperationStore({
                settingsRevision: () => this.settingsRevision,
                machineClassOf: operation => this.machineClassOf(operation),
                machineClassForType: type => this.machineClassForType(type),
            });

            // Operation + parameterStore values -> frozen pipeline context.
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
            this.gcodeGenerator = null;
            this.graphicsExporter = null;

            // Operation registry - installed by CamController.loadProfile
            this.registry = null;

            // Settings - populated by controller via loadSettings(storageKey)
            this.settings = JSON.parse(JSON.stringify(D));

            // Universal workspace state
            // Scene owns the geometry tree, selection, the global workspace
            // transform (origin/rotation/mirror), spatial queries (pick,
            // marquee, viewport), AND coordinate-space conversions.
            this.scene = new Scene();

            this.machineClass = 'router';
            this.classByType = null;

            // Monotonic counter for every GLOBAL input a generated artifact
            // depends on but no per-operation flag watched: machine heights,
            // stock thickness and zero reference, the workspace transform,
            // the post-processor and the tool library. Artifacts stamp it;
            // isArtifactStale compares.
            this.settingsRevision = 0;

            this.scene.addTransformListener((change) => {
                if (change.action === 'setBoardBounds' || change.action === 'boardBoundsCleared') return;
                this.bumpSettingsRevision({ source: 'scene', action: change.action });
                for (const op of this.operations) {
                    this.store.refreshStaleFlags(op.id, 'Workspace transform changed - recalculate toolpaths before export.');
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

            // Computed export programs, keyed by exportIntentKey. Reuse is a
            // decision, not a view concern - a headless caller of
            // computeExportPrograms gets the same reuse the modal does.
            this.exportPrograms = { key: null, results: null };
        }

        // Stock getter/setter - canonical location is settings.machine.stock.
        // Direct property mutations (core.stock.width = 600) work because the
        // getter returns the settings reference. Full replacement (core.stock = {...})
        // goes through the setter.
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
         * Installs the operation registry.
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

        setGraphicsExporter(exporter) {
            this.graphicsExporter=exporter;
            this.debug("Graphics exporter set")
        }

        setToolLibrary(toolLibrary) {
            this.toolLibrary = toolLibrary;
            this.debug('Tool library set');
        }

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

        /** Class an operation runs on. */
        machineClassOf(operation) {
            if (operation?.machineClass) return operation.machineClass;
            return this.machineClassForType(operation?.type);
        }

        /**
         * Same rule with no operation to consult. Callers holding only a type are
         * building a synthetic `{ type }` so the stamp lookup above would miss on
         * it, which reads as an operation that exists.
         */
        machineClassForType(type) {
            const preferred = (type && this.classByType?.[type]) || this.machineClass;
            return this.registry?.resolveMachineClass(type, preferred) || preferred;
        }

        isLaserOperation(operation) {
            return this.machineClassOf(operation) === 'laser';
        }

        // Settings

        /**
         * Base declarations under the app's deltas. `null` removes an entry;
         * anything else is merged INTO the base entry, so a profile that only
         * overrides `default` keeps the type, category, unit and bounds.
         * Both the defaults seed and the settings form read this, so a profile
         * can never render one shape and seed another.
         */
        machineSchema(appProfile) {
            const schema = { ...MP };
            for (const [path, override] of Object.entries(appProfile?.machineParameters || {})) {
                if (override === null) delete schema[path];
                else schema[path] = { ...schema[path], ...override };
            }
            return schema;
        }

        /**
         * The machine schema is the only declaration of the machine, gcode and
         * laser settings: this writes each entry's default at its own key path.
         * An app overrides a default, or drops the setting with null, in its
         * profile.
         */
        buildMachineDefaults(appProfile) {
            const out = {};
            for (const [path, def] of Object.entries(this.machineSchema(appProfile))) {
                const segments = path.split('.');
                let node = out;
                for (const key of segments.slice(0, -1)) node = node[key] ||= {};
                node[segments[segments.length - 1]] = structuredClone(def.default);
            }
            return out;
        }

        loadSettings(storageKey, appProfile = null) {
            this.settingsStorageKey = storageKey;
            const defaults = JSON.parse(JSON.stringify(D));

            mergeDeep(defaults, this.buildMachineDefaults(appProfile));

            // Device settings are namespaced by device id and declared by the
            // device, so nothing here names a post or a laser profile.
            const seed = (root, descriptors) => {
                for (const desc of descriptors) {
                    const branch = root[desc.id] ||= {};
                    for (const p of desc.parameters || []) {
                        if (branch[p.name] === undefined) branch[p.name] = structuredClone(p.default);
                    }
                }
            };
            seed(defaults.processorSettings, this.gcodeGenerator.getAllProcessorDescriptors() || []);
            seed(defaults.laserSettings, this.graphicsExporter.getAllProfileDescriptors() || []);


            try {
                const raw = this._storage.getItem(this.settingsStorageKey);
                if (!raw) return defaults;
                const saved = JSON.parse(raw);
                return mergeDeep({}, defaults, saved);
            } catch (error) {
                console.warn('Error loading settings:', error);
                return defaults;
            }
        }

        saveSettings() {
            try {
                this._storage.setItem(this.settingsStorageKey, JSON.stringify(this.settings));
            } catch (error) {
                console.warn('Error saving settings:', error);
            }
        }

        /**
         * Merges a settings category and persists.
         *
         * Post-processor changes invalidate INDEXED rotary operations only.
         * Nothing else under machine/gcode feeds EasyShape5000 geometry - surfaceZ,
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
            const postChanged = "gcode" === category && void 0 !== settings.postProcessor && settings.postProcessor !== this.settings.gcode.postProcessor;
            Object.assign(this.settings[category], settings);
            this.saveSettings();
            this.exportPrograms = { key: null, results: null };
            "pipeline" !== category && this.bumpSettingsRevision({ category: category });
            postChanged && this.store.invalidateIndexedOperations(settings.postProcessor);
        }

        /**
         * Writes one value at a dot path and runs the same commit tail as
         * updateSettings. Intermediate objects are created rather than assumed:
         * a post declaring a new parameter must not need a config edit to be
         * writable.
         */
        setSetting(path, value) {
            const segments = path.split(".");
            const category = segments[0];
            let node = this.settings[category];
            if (!node) return false;
            for (let i = 1; i < segments.length - 1; i++) {
                if (!node[segments[i]] || typeof node[segments[i]] !== "object") node[segments[i]] = {};
                node = node[segments[i]];
            }
            const leaf = segments[segments.length - 1];
            if (node[leaf] === value) return false;
            const postChanged = "gcode.postProcessor" === path;
            node[leaf] = value;
            this.saveSettings();

            // The renderer still needs the event; only the revision is held
            // back, so nothing is marked stale by a change nothing reads.
            if (CamCore.PRESENTATION_SETTINGS.has(path)) {
                this._emit?.('settingschange', { category, path, presentation: true });
            } else if (category !== 'pipeline') {
                this.bumpSettingsRevision({ category });
            }

            if (postChanged) this.store.invalidateIndexedOperations(value);
            return true;
        }

        // Operation state (delegated to OperationStore)
        // Kept as forwards so call sites migrate to core.store.* gradually
        get operations() { return this.store.operations; }
        get toolpaths() { return this.store.toolpaths; }
        get stats() { return this.store.stats; }

        // Revisions & artifact stamps

        /*Setting paths that no pipeline stage reads.*/
        static PRESENTATION_SETTINGS = new Set([
            'machine.stock.width',
            'machine.stock.length',
            'machine.stock.margin'
        ]);

        /**
         * Announces that a settings revision moved. The emitter is injected in
         * CamController.initCore so the engine can run with no window. Absent
         * one, the event is dropped rather than routed to a global: a caller
         * that wanted the event and did not supply an emitter has a wiring bug,
         * and a silent global dispatch hides it.
         */
        bumpSettingsRevision(detail = {}) {
            this.settingsRevision++;
            this._emit?.('settingschange', { ...detail, revision: this.settingsRevision });
        }

        // Per-operation toolpaths

        /**
         * Context pairs → plans → metrics.
         */
        async computePlans(operationIds, parameterStore, opts = {}) {
            const pairs = this.buildOperationContextPairs(operationIds, parameterStore, { warnLabel: opts.warnLabel });
            if (pairs.length === 0) return { pairs: [], plans: [], warnings: [], metrics: null };

            const { plans, warnings } = await this.runStages(pairs, {
                optimize: opts.optimize !== false,
                convertRotary: opts.convertRotary !== false,
                groupByTool: opts.groupByTool === true
            });
            const metrics = this.machineProcessor.calculatePathMetrics(plans, pairs[0].context);
            return { pairs, plans, warnings: warnings || [], metrics };
        }

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
         *   - runStages threads currentMachinePos across operations;
         *     here it starts at safeZ over the origin.
         *   - MachineProcessor.processPlans backward-fills metadata.tool
         *     over the list it is given, so this run assumes its own tool
         *     is already in the spindle.
         *   - convertDevelopedToRotary runs one cursor per call.
         *
         * The job export recomputes as a batch rather than concatenating
         * these. Do not "optimise" that away.
         */
        async computeToolpaths(operationId, parameterStore, options = {}) {
            const operation = this.store.getOperation(operationId);
            if (!operation) throw new Error(`Operation ${operationId} not found`);

            // Preview frame: rotary stays in developed space and insertIndexMoves
            // runs in previewMode.
            const { plans, warnings, metrics } = await this.computePlans([operationId], parameterStore, {
                optimize: options.optimize,
                convertRotary: false,
                warnLabel: 'toolpath'
            });
            if (!plans.length && !metrics) throw new Error('Could not build a toolpath context for this operation');

            this.store.setToolpaths(operationId, { plans, warnings, metrics, generatedAt: Date.now() });
            this.store.stampArtifact(operationId, 'toolpath'); 
            this.store.updateStatistics();
            return { plans, warnings, metrics };
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
        async runStages(operationContextPairs, options = {}) {
            if (!this.geometryTranslator || !this.machineProcessor) {
                throw new Error('Pipeline components not initialized - call initializePipeline() first');
            }

            const optimize = options.optimize !== false;
            const allMachineReadyPlans = [];

            const pipelineWarnings = [];

            if (!operationContextPairs || operationContextPairs.length === 0) {
                return { plans: allMachineReadyPlans, endPos: { x: 0, y: 0, z: 0 } };
            }

            // Tool batching. The optimizer can never do this - runStages
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
                for (const w of this.machineProcessor.warnings || []) {
                    pipelineWarnings.push(`${operation.type} '${operation.id}': ${w}`);
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
         * Not delegators: each keeps the aggregate board AABB in step with the
         * store's operation list. Calling store.removeOperation directly leaves
         * the workspace rect on the bounds of geometry that is gone, and every
         * fit-to-content read after it is wrong.
         */
        removeOperation(operationId) {
            if (!this.store.removeOperation(operationId)) return false;
            this.updateBoardBounds();
            return true;
        }

        detachOperation(operationId) {
            const token = this.store.detachOperation(operationId);
            if (token) this.updateBoardBounds();
            return token;
        }

        attachOperation(token) {
            if (!this.store.attachOperation(token)) return false;
            this.updateBoardBounds();
            return true;
        }

        clearAll() {
            this.store.clearAll();
            this.updateBoardBounds();
        }

        /**
         * Recomputes scene.boardBounds from the aggregate of all operation
         * bounds.
         */
        updateBoardBounds() {
            const merged = GeometryUtils.mergeBounds(this.operations.map(op => op.bounds));
            if (merged) {
                this.scene.setBoardBounds(merged);
            } else {
                this.scene.initializeEmptyBoardBounds();
            }
        }

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
         * @param {parameterStore} parameterStore
         * @returns {Object} keyed results: { [key]: { gcode, lineCount, planCount, estimatedTime, totalDistance, label } }
         */
        async generateGCodeResults(intent, parameterStore) {
            if (!this.gcodeGenerator) {
                throw new Error('G-code generator not set - call setGCodeGenerator() first');
            }

            const gcodeConfig = this.settings.gcode;

            // The post's own settings, already seeded from its declared parameters
            // and namespaced by post id.
            const postSettings = this.settings.processorSettings?.[gcodeConfig.postProcessor] || {};

            const genOptions = {
                postProcessor: gcodeConfig.postProcessor,
                includeComments: intent.includeComments,
                lineNumbers: gcodeConfig.lineNumbers,
                lineNumberStep: gcodeConfig.lineNumberStep,
                singleFile: intent.singleFile,
                toolChanges: intent.toolChanges,
                groupByTool: intent.groupByTool,
                userStartCode: gcodeConfig.userStartCode,
                userEndCode: gcodeConfig.userEndCode,
                units: gcodeConfig.units,
                toolLengthCompMode: gcodeConfig.toolLengthCompMode,
                ...postSettings,
                safeZ: this.settings.machine.heights.safeZ,
                travelZ: this.settings.machine.heights.travelZ,
                maxSafeDepth: this.settings.machine.heights.maxSafeDepth,
                maxFeed: this.settings.machine.speeds.maxFeed,
                coolant: this.settings.machine.coolant,
                vacuum: this.settings.machine.vacuum
            };

            const results = {};

            if (intent.singleFile) {
                const result = await this.generateGCode(intent.operationIds, intent.optimize !== false, genOptions, parameterStore);
                results['__combined__'] = result;
            } else {
                for (const opId of intent.operationIds) {
                    const op = this.store.getOperation(opId);
                    if (!op) continue;

                    if (!this.store.isExportReady(op)) {
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
                                const result = await this.generateGCode([op.id], intent.optimize !== false, genOptions, parameterStore);
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
                        const result = await this.generateGCode([op.id], intent.optimize !== false, genOptions, parameterStore);
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
         * Everything that changes the emitted files, in one string. currentStamp
         * already folds each operation's per-stage revisions and the global
         * settingsRevision together, so a post-processor change made in machine
         * settings invalidates this key without the export modal knowing machine
         * settings exists.
         */
        exportIntentKey(intent) {
            const ids = intent.operationIds || [];
            return JSON.stringify({
                // Order is meaningful: the drag order is the cut order.
                ops: ids.map(id => `${id}:${JSON.stringify(this.store.currentStamp(id))}`),
                singleFile: !!intent.singleFile,
                splitDrillOpIds: [...(intent.splitDrillOpIds || [])].sort(),
                optimize: intent.optimize ?? true,
                includeComments: !!intent.includeComments,
                toolChanges: !!intent.toolChanges,
                groupByTool: !!intent.groupByTool
            });
        }

        /**
         * Turns an export intent into G-code programs. DOM-free, and the entry a
         * headless caller uses: the modal builds the intent by reading its
         * controls, a script passes one as a literal.
         * The router filter, the readiness gate and the split-drill narrowing
         * live here because they are decisions about the job, not about the panel
         * showing it. Rendering the result is the caller's problem, and so is
         * deciding what to say about a refusal - this returns the reason, not a
         * status string.
         * @param {Object} intent {operations, operationIds, singleFile,
         *         splitDrillOpIds, toolChanges, groupByTool, includeComments, ...}
         * @param {ParameterStore} parameterStore
         * @returns {Promise<{ok:boolean, reason:?string, notReady:Array,
         *         intent:?Object, key:?string, results:?Object}>}
         */
        // REVIEW - Outdated comment?
        async computeExportPrograms(intent, parameterStore) {
            const cncOps = (intent.operations || []).filter(op => "router" === this.machineClassOf(op));
            if (0 === cncOps.length) return { ok: false, reason: "no-cnc-operations", notReady: [], intent: null, key: null, results: null };
            const notReady = cncOps.filter(op => !this.store.isExportReady(op));
            if (notReady.length > 0) return { ok: false, reason: "not-ready", notReady: notReady, intent: null, key: null, results: null };

            const ids = cncOps.map(op => op.id);
            const cncIntent = {
                ...intent,
                operations: cncOps,
                operationIds: ids,
                splitDrillOpIds: (intent.splitDrillOpIds || []).filter(id => ids.includes(id))
            };

            const key = this.exportIntentKey(cncIntent);
            if (this.exportPrograms.key === key && this.exportPrograms.results) {
                return { ok: true, reason: null, notReady: [], intent: cncIntent, key: key, results: this.exportPrograms.results };
            }

            let results = {};
            // Stencils use separate physical material/setup. In single-file mode,
            // combine board operations only; stencils are always generated individually.
            const isStencil = op => "stencil" === op.type;
            const boardOps = cncOps.filter(op => !isStencil(op));
            const stencilOps = cncOps.filter(isStencil);

            if (intent.singleFile && boardOps.length > 0) {
                const boardIntent = {
                    ...cncIntent,
                    operations: boardOps,
                    operationIds: boardOps.map(op => op.id),
                    singleFile: true
                };
                const boardResults = await this.generateGCodeResults(boardIntent, parameterStore);
                Object.assign(results, boardResults);

                if (stencilOps.length > 0) {
                    const stencilIntent = {
                        ...cncIntent,
                        operations: stencilOps,
                        operationIds: stencilOps.map(op => op.id),
                        singleFile: false
                    };
                    const stencilResults = await this.generateGCodeResults(stencilIntent, parameterStore);
                    Object.assign(results, stencilResults);
                }
            } else {
                results = await this.generateGCodeResults(cncIntent, parameterStore);
            }

            this.exportPrograms = { key: key, results: results };
            return { ok: true, reason: null, notReady: [], intent: cncIntent, key: key, results: results };
        }

        /**
         * Assembles { operation, context } pairs for the toolpath pipeline.
         * Tool numbers are resolved for the WHOLE batch before any context is
         * built: buildPipelineContext ends in Object.freeze, so a descriptor
         * assembled per-operation could not see its siblings' claims, and a
         * post-hoc `context.tool = …` would throw under 'use strict'.
         * @param {string[]|null} operationIds null = every export-ready op
         * @param {parameterStore} parameterStore
         * @param {{warnLabel?:string}} [options]
         */
        buildOperationContextPairs(operationIds, parameterStore, options = {}) {
            const label = options.warnLabel || "pipeline";

            // Commit pending edits before staging.
            for (const id of operationIds || []) {
                if (!parameterStore.hasUnsavedChanges(id)) continue;
                const op = this.store.getOperation(id);
                if (op) parameterStore.commitToOperation(op);
            }

            const staged = this.pipelineContext.stageToolDescriptors(operationIds, parameterStore);

            // Build contexts against the resolved descriptors
            const pairs = [];
            for (const entry of staged) {
                try {
                    const context = this.pipelineContext.buildPipelineContext(entry.opId, parameterStore, entry.tool);
                    pairs.push({ operation: entry.operation, context: context });
                } catch (err) {
                    console.warn(`[${label}] skipping operation ${entry.opId}: ${err.message}`);
                }
            }
            return pairs;
        }

        /**
         * Internal: buildContext → computePlans → generate G-code.
         */
        async generateGCode(operationIds, optimize, genOptions, parameterStore) {
            // Reordering is the user's call, not a side effect of asking for
            // tool-change commands: it overrides the drag order they set in the
            // export list.
            const { pairs, plans, warnings, metrics } = await this.computePlans(operationIds, parameterStore, {
                optimize,
                groupByTool: genOptions?.groupByTool === true && genOptions?.singleFile === true,
                warnLabel: 'CNC'
            });
            if (pairs.length === 0) {
                return { gcode: '; No valid operations to process', lineCount: 1, planCount: 0, estimatedTime: 0, totalDistance: 0 };
            }
            if (warnings.length) {
                // runStages collects these (dropped rotary plans, etc.)
                console.warn(`[Core] Pipeline warnings:\n  ${warnings.join('\n  ')}`);
            }

            const gcode = this.gcodeGenerator.generate(plans, genOptions);
            const lineCount = typeof gcode === 'string' && gcode.length > 0 ? gcode.trim().split('\n').length : 0;
            return {
                gcode,
                lineCount,
                planCount: plans.length,
                estimatedTime: metrics.estimatedTime,
                totalDistance: metrics.totalDistance,
                toolChanges: this.gcodeGenerator.lastToolChangeCount || 0,
                warnings: [...warnings, ...this.gcodeGenerator.lastWarnings || []]
            };
        }

        /**
         * Vector/raster export. The engine supplies the session facts; the
         * exporter owns the mapping and the rendering.
         */
        generateLaserExportFiles(operations, parameterStore, exportOverrides = {}) {
            return this.graphicsExporter.exportOperations(operations, {
                laser: this.settings.laser,
                profile: this.graphicsExporter.resolveOptions(this.settings),
                transforms: this.pipelineContext.getTransforms(),
                bounds: this.scene.boardBounds,
                appName: this.appProfile.meta.app,
                spotSizeFor: op => {
                    try {
                        return this.pipelineContext.buildPipelineContext(op.id, parameterStore).laser?.spotSize ?? null;
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

    ROOT.CamCore = CamCore;
})();