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

    const D = ROOT.CAMConfig.defaults;
    const MP = ROOT.CAMConfig.machineParameters;
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
            this.geometryTranslator = new GeometryTranslator(this);
            this.toolpathOptimizer = new ToolpathOptimizer();
            this.machineProcessor = new MachineProcessor(this);
            this.gcodeGenerator = null;
            this.graphicsExporter = null;

            // Operation registry and app profile - installed by CamController.loadProfile
            this.registry = null;
            this.appProfile = null;
            // Settings - populated by controller via loadSettings(storageKey)
            this.settings = JSON.parse(JSON.stringify(D));
            this.settingsStorageKey = null;

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
            this.initializationPromise = null;

            // Computed export programs, keyed by exportIntentKey. Reuse is a
            // decision, not a view concern - a headless caller of
            // computeExportPrograms gets the same reuse the modal does.
            this.exportPrograms = { key: null, results: null };
        }

        // Read-only view of settings.machine.stock. Writes go through
        // setSetting, which bumps the settings revision.
        get stock() {
            return this.settings?.machine?.stock || null;
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

            this.geometryProcessor = new GeometryProcessor({ clipper2scale: scale });

            this.geometryOffsetter = new GeometryOffsetter(this.geometryProcessor);
            // Wait for Clipper2 WASM
            this.initializationPromise = this.geometryProcessor.initPromise;

            try {
                // initialize() reports a failed WASM load by resolving false.
                this.isInitialized = (await this.initializationPromise) === true;
                if (this.isInitialized) this.debug('Clipper2 initialized');
                return this.isInitialized;
            } catch (error) {
                console.error('Clipper2 initialization failed:', error);
                return false;
            } finally {
                this.isInitializing = false;
            }
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
            if (CamCore.PRESENTATION_SETTINGS.has(path) || category === 'laserSettings') {
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

        /**
         * Setting paths that no pipeline stage reads: the stock rectangle is
         * only drawn, and the laser profile only styles the exported file, as
         * does every laserSettings.* parameter (setSetting checks that prefix).
         * laser.exportFormat is not one of them: PNG switches generation to
         * filled regions.
         */
        static PRESENTATION_SETTINGS = new Set([
            'machine.stock.width',
            'machine.stock.length',
            'machine.stock.margin',
            'laser.activeProfile',
            'laser.exportDPI'
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
                if (optimize) {
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
         * Not delegators: each keeps the aggregate board AABB in step with the
         * store's operation list. Detaching through the store directly leaves
         * the workspace rect on the bounds of geometry that is gone, and every
         * fit-to-content read after it is wrong. A caller that drops the
         * returned token has removed the operation for good.
         */
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
         * How one operation is written: 'gcode', 'png' or 'svg'. A PNG laser job
         * rasterizes only work that does not cut through - a raster cannot cut,
         * so outlines and holes stay vector beside it.
         */
        exportFormatOf(operation) {
            const cls = this.machineClassOf(operation);
            if (cls === 'router') return 'gcode';
            const raster =
                cls === 'laser' &&
                this.settings.laser?.exportFormat === 'png' &&
                !this.registry?.cutsThrough(operation.type);
            return raster ? 'png' : 'svg';
        }

        /**
         * Every file an export intent writes - route, format, the operations in
         * it and its final name - decided without generating anything. The
         * modal lists it, generation follows it and delivery names files from
         * it, so the list the user reads is the list that gets written.
         * Stencils never combine: they are cut from different stock.
         * @param {Object} intent {operations, singleFile, splitDrillOpIds, baseName}
         * @returns {{baseName: string, canCombine: boolean, files: Array<{key: string,
         *  route: string, format: string, filename: string, operationIds: string[],
         *  splitKey?: string, detail?: string}>}}
         */
        planExportFiles(intent) {
            // One filename part: letters and digits in any script plus . _ -.
            // Everything else becomes _, path separators included - a zip entry
            // named "a/b" unpacks into a folder.
            const safe = (text) =>
                String(text ?? '')
                    .trim()
                    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
                    .replace(/^[._]+|_+$/g, '');
            const stemOf = (op) => safe(op.file?.name?.replace(/\.[^.]+$/, '')) || op.id;
            const baseName = safe(intent.baseName) || safe(this.settings.export?.defaultBaseName) || 'export';
            const ops = intent.operations || [];
            const drafts = [];
            const ownFile = (op, route) =>
                drafts.push({
                    key: op.id,
                    route,
                    format: this.exportFormatOf(op),
                    operationIds: [op.id],
                    parts: [op.type, stemOf(op)],
                });
            const sharedFile = (key, route, format, group, parts) =>
                drafts.push({ key, route, format, operationIds: group.map((op) => op.id), parts });

            const router = ops.filter((op) => this.machineClassOf(op) === 'router');
            const board = router.filter((op) => op.type !== 'stencil');
            const splitIds = new Set(intent.splitDrillOpIds || []);
            if (intent.singleFile && board.length > 0) {
                sharedFile('__combined__', 'router', 'gcode', board, []);
            } else {
                for (const op of board) {
                    const splits = splitIds.has(op.id) ? DrillHandler.splitDrillFiles(op) : [];
                    if (splits.length < 2) {
                        ownFile(op, 'router');
                        continue;
                    }
                    for (const split of splits) {
                        drafts.push({
                            key: `${op.id}_${split.key}`,
                            route: 'router',
                            format: 'gcode',
                            operationIds: [op.id],
                            splitKey: split.key,
                            parts: [split.key.replace(/_/g, '-'), stemOf(op)],
                        });
                    }
                }
            }
            for (const op of router) {
                if (op.type === 'stencil') ownFile(op, 'router');
            }

            const laser = ops.filter((op) => this.machineClassOf(op) === 'laser');
            const raster = laser.filter((op) => this.exportFormatOf(op) === 'png');
            const vector = laser.filter((op) => this.exportFormatOf(op) === 'svg');
            if (intent.singleFile) {
                if (raster.length > 0) sharedFile('__laser_png__', 'laser', 'png', raster, []);
                if (vector.length > 0) {
                    sharedFile('__laser_svg__', 'laser', 'svg', vector, raster.length > 0 ? ['vectors'] : []);
                }
            } else {
                for (const op of laser) ownFile(op, 'laser');
            }

            // Knife and drag cutters: plain vector, one file per operation.
            for (const op of ops) {
                const cls = this.machineClassOf(op);
                if (cls !== 'router' && cls !== 'laser') ownFile(op, 'vector');
            }

            const extension = {
                gcode: this.gcodeGenerator?.getProcessorInfo(this.settings.gcode.postProcessor)?.fileExtension || '.nc',
                png: '.png',
                svg: '.svg',
            };
            // Case-insensitive: Windows and macOS filesystems, and most unzippers,
            // treat names that differ only in case as one file.
            const taken = new Set();
            const files = drafts.map(({ parts, ...file }) => {
                const stem = [baseName, ...parts].join('-');
                const ext = extension[file.format];
                let filename = stem + ext;
                for (let n = 2; taken.has(filename.toLowerCase()); n++) filename = `${stem}-${n}${ext}`;
                taken.add(filename.toLowerCase());
                return { ...file, filename };
            });
            return {
                baseName,
                canCombine: board.length > 1 || raster.length > 1 || vector.length > 1,
                files,
            };
        }

        /**
         * G-code for each planned router file, keyed by file key.
         * @param {Array} files planExportFiles entries; other routes are skipped
         * @param {Object} intent {singleFile, optimize, includeComments, toolChanges, groupByTool}
         * @param {parameterStore} parameterStore
         * @returns {Object} keyed results: { [key]: { gcode, lineCount, planCount, estimatedTime, totalDistance, label } }
         */
        async generateGCodeResults(files, intent, parameterStore) {
            if (!this.gcodeGenerator) {
                throw new Error('G-code generator not set');
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
                vacuum: this.settings.machine.vacuum,
            };
            const optimize = intent.optimize !== false;
            const results = {};
            for (const file of files) {
                if (file.route !== 'router') continue;
                let result;
                if (file.splitKey) {
                    const op = this.store.getOperation(file.operationIds[0]);
                    const split = op && DrillHandler.splitDrillFiles(op).find((s) => s.key === file.splitKey);
                    if (!split) continue;
                    // The pipeline reads geometry off the operation, so the subset
                    // is swapped in for this one run and always restored.
                    const savedPreview = op.preview;
                    const savedOffsets = op.offsets;
                    op.preview = { ...savedPreview, primitives: split.primitives, ready: true };
                    op.offsets = [{ ...savedOffsets[0], primitives: split.primitives }];
                    try {
                        result = await this.generateGCode([op.id], optimize, genOptions, parameterStore);
                    } finally {
                        op.preview = savedPreview;
                        op.offsets = savedOffsets;
                    }
                } else {
                    result = await this.generateGCode(file.operationIds, optimize, genOptions, parameterStore);
                }
                if (result?.gcode) {
                    results[file.key] = { ...result, label: file.filename };
                } else {
                    console.warn(`[Core] no G-code produced for ${file.filename} - omitted from the export.`);
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
                ops: ids.map((id) => `${id}:${JSON.stringify(this.store.currentStamp(id))}`),
                singleFile: !!intent.singleFile,
                splitDrillOpIds: [...(intent.splitDrillOpIds || [])].sort(),
                optimize: intent.optimize ?? true,
                includeComments: !!intent.includeComments,
                toolChanges: !!intent.toolChanges,
                groupByTool: !!intent.groupByTool,
            });
        }

        /**
         * Turns an export intent into G-code programs. DOM-free, and the entry a
         * headless caller uses: the modal builds the intent by reading its
         * controls, a script passes one as a literal.
         * The router filter, the readiness gate and the split-drill narrowing
         * live here because they are decisions about the job, not about the panel
         * showing it; which operations share a program is planExportFiles'
         * answer. Rendering the result is the caller's problem, and so is
         * deciding what to say about a refusal - this returns the reason, not a
         * status string.
         * @param {Object} intent {operations, operationIds, singleFile,
         *  splitDrillOpIds, toolChanges, groupByTool, includeComments, ...}
         * @param {ParameterStore} parameterStore
         * @returns {Promise<{ok:boolean, reason:?string, notReady:Array,
         *  intent:?Object, key:?string, results:?Object, files:Array}>}
         */
        async computeExportPrograms(intent, parameterStore) {
            const refuse = (reason, notReady = []) => ({
                ok: false,
                reason,
                notReady,
                intent: null,
                key: null,
                results: null,
                files: [],
            });
            const cncOps = (intent.operations || []).filter((op) => this.machineClassOf(op) === 'router');
            if (cncOps.length === 0) return refuse('no-cnc-operations');
            const notReady = cncOps.filter((op) => !this.store.isExportReady(op));
            if (notReady.length > 0) return refuse('not-ready', notReady);
            const ids = cncOps.map((op) => op.id);
            const cncIntent = {
                ...intent,
                operations: cncOps,
                operationIds: ids,
                splitDrillOpIds: (intent.splitDrillOpIds || []).filter((id) => ids.includes(id)),
            };
            const files = this.planExportFiles(cncIntent).files;
            const key = this.exportIntentKey(cncIntent);
            if (this.exportPrograms.key !== key || !this.exportPrograms.results) {
                const results = await this.generateGCodeResults(files, cncIntent, parameterStore);
                this.exportPrograms = { key, results };
            }
            return {
                ok: true,
                reason: null,
                notReady: [],
                intent: cncIntent,
                key,
                results: this.exportPrograms.results,
                files,
            };
        }

        /**
         * Generates every planned file without delivering it - the headless
         * counterpart of the Export button. A file that fails is reported in
         * `failures` and does not take the rest of the job down with it.
         * @returns {Promise<{plan: Object, files: Array<{filename: string, blob: Blob}>,
         *  failures: Array<{filename: string, reason: string}>}>}
         */
        async buildExportFiles(intent, parameterStore) {
            const plan = this.planExportFiles(intent);
            const planned = (route) => plan.files.filter((file) => file.route === route);
            const blobs = new Map();
            const failures = [];

            const routerFiles = planned('router');
            if (routerFiles.length > 0) {
                const job = await this.computeExportPrograms(intent, parameterStore);
                for (const file of routerFiles) {
                    const gcode = job.ok ? job.results[file.key]?.gcode : null;
                    if (gcode) {
                        blobs.set(file.filename, new Blob([gcode], { type: 'text/plain' }));
                    } else {
                        failures.push({
                            filename: file.filename,
                            reason: job.reason === 'not-ready' ? 'toolpaths not calculated' : 'no G-code produced',
                        });
                    }
                }
            }
            const render = async (files, overrides) => {
                if (files.length === 0) return;
                const result = await this.generateLaserExportFiles(files, {
                    includeComments: intent.includeComments,
                    ...overrides,
                });
                for (const file of result.files) blobs.set(file.filename, file.blob);
                failures.push(...result.failures);
            };
            await render(planned('laser'), { padding: intent.laserPadding });
            // Knife and drag cutters: plain vector, none of the laser profile's styling.
            await render(planned('vector'), {
                layerColors: { stencil: '#000000' },
                padding: intent.stencilPadding ?? 5,
                heatManagement: 'off',
                reverseCutOrder: false,
                svgGrouping: 'layer',
                colorPerPass: false,
            });
            // Plan order, so loose downloads and archive entries read the same way.
            const files = plan.files
                .filter((file) => blobs.has(file.filename))
                .map((file) => ({ filename: file.filename, blob: blobs.get(file.filename) }));
            return { plan, files, failures };
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
            if (warnings.length) {
                // runStages collects these (dropped rotary plans, etc.)
                console.warn(`[Core] Pipeline warnings:\n  ${warnings.join('\n  ')}`);
            }
            // Nothing reached the stages: the caller omits this file and reports it.
            if (pairs.length === 0) return { gcode: null };
            const gcode = this.gcodeGenerator.generate(plans, genOptions);
            const lineCount = typeof gcode === 'string' && gcode.length > 0 ? gcode.trim().split('\n').length : 0;
            return {
                gcode,
                lineCount,
                planCount: plans.length,
                estimatedTime: metrics.estimatedTime,
                totalDistance: metrics.totalDistance,
                toolChanges: this.gcodeGenerator.lastToolChangeCount || 0,
                warnings: [...warnings, ...(this.gcodeGenerator.lastWarnings || [])]
            };
        }

        /**
         * Renders planned laser or plain-vector files. The engine supplies the
         * session facts; the exporter maps operations to layers and renders.
         * @param {Array} files planExportFiles entries of one route
         */
        generateLaserExportFiles(files, exportOverrides = {}) {
            const groups = files.map(file => ({
                filename: file.filename,
                format: file.format,
                operations: file.operationIds.map(id => this.store.getOperation(id)).filter(Boolean)
            }));
            return this.graphicsExporter.exportGroups(
                groups,
                {
                    laser: this.settings.laser,
                    profile: this.graphicsExporter.resolveOptions(this.settings),
                    transforms: this.pipelineContext.getTransforms(),
                    bounds: this.scene.boardBounds,
                    appName: this.appProfile.meta.app
                },
                exportOverrides
            );
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