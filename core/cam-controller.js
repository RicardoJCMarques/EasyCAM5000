/*!
 * @file        core/cam-controller.js
 * @description Shared controller base class.
 *              Owns core initialization, profile loading, pipeline management,
 *              WASM loading, UI boilerplate wiring, export coordination, and
 *              debug utilities. Subclasses override initialize() and call
 *              shared steps in their own order.
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
    const debugState = D.debug;

    class CamController {
        constructor() {
            this.core = null;
            this.ui = null;
            this.parameterStore = null;
            this.inputRenderer = null;
            this.gcodeGenerator = null;
            this.graphicsExporter=null;
            this.appProfile = null;
            this.languageManager = null;
            this.modalManager = null;
            this.shortcutManager = null;

            /**
             * Dimensions this session's workspace can present. EasyShape's 2D
             * workspace has no way to draw a field-generated surface, so the
             * op-type strip must not offer one. null = no restriction.
             */
            this.workspaceDimensions = null;
            this.activeDropdown = null;

            this.initState = {
                coreReady: false,
                uiReady: false,
                wasmReady: false,
                fullyReady: false,
                error: null
            };

            this._refresh3DQueued = false;
            this._hasFitted3DOnce = false;
        }

        // ════════════════════════════════════════════════════════════════
        // Shared Initialization Sequence
        // ════════════════════════════════════════════════════════════════

        async initialize() {
            const appLabel = this.getAppLabel() || 'App';
            this.debug(`${appLabel} initializing...`);

            try {
                // Core
                this.initCore();
                this.onCoreReady();

                // Profile & Data
                const pc = this.getProfileConfig();
                const profileData = await this.loadProfile(pc.embeddedVar, pc.fetchPath);
                this.storageKeys = C.storageKeys.forApp(this.appProfile.meta.app);
                await this.initToolLibrary();
                this.languageManager = new LanguageManager();
                await this.languageManager.load();

                // Pipeline & Storage
                this.initGCodeGenerator(this.languageManager);
                await this.initGraphicsExporter();
                this.core.initializePipeline();
                this.registerHandlers();
                this.core.settings = this.core.loadSettings(this.storageKeys.settings, this.appProfile);

                // Restore the machine class the session was left in before any
                // panel renders against it.
                const saved = this.pipelineState;
                if (saved.machineClass) this.core.setMachineClass(saved.machineClass, saved.classByType);

                // UI
                this.ui = this.createUI();
                this.ui.lang = this.languageManager;
                const uiReady = await this.ui.init();
                this.initState.uiReady = uiReady;
                if (!uiReady) throw new Error('UI initialization failed');
                this.modalManager = new ModalManager(this);
                // One console handle for every app, set as soon as there is
                // something worth inspecting.
                window.cam = this;

                // WASM
                const wasmReady = await this.initializeWASM();
                if (!wasmReady) {
                    console.warn('WASM modules failed - running in fallback mode');
                    this.ui.setStatus(this.appProfile?.ui?.text?.statusWarning || 'Warning: WASM failed', 'warning');
                }
                this.onPostWASM();

                // Events & Shortcuts
                this.shortcutManager = new ShortcutManager();
                this.shortcutManager.setModalManager(this.modalManager);
                this.registerAppShortcuts();
                this.registerSharedShortcuts();
                this.onBindEvents();

                // Finalize
                this.onFinalize();
                this.hideLoadingOverlay();
                this.initState.fullyReady = true;
                this.preload3D();
                this.ui.setStatus(this.appProfile?.ui?.text?.statusReady || "Ready");
                console.log(`${appLabel} Ready!`);
            } catch (err) {
                console.error(`${appLabel} initialization failed:`, err);
                this.initState.error = err.message;
                if (this.ui) this.ui.setStatus('Initialization failed: ' + err.message, 'error');
                this.hideLoadingOverlay();
            }
        }

        // ════════════════════════════════════════════════════════════════
        // Abstract hooks - subclasses MUST override
        // ════════════════════════════════════════════════════════════════

        /** @returns {string} Display name for console */
        getAppLabel() { return 'CamApp'; }

        /** @returns {{ embeddedVar: string, fetchPath: string }} */
        getProfileConfig() { throw new Error('getProfileConfig() not implemented'); }

        /** @returns {BaseAppUI} */
        createUI() { throw new Error('createUI() not implemented'); }

        /** Subclasses register PARSERS here, then call super. */
        registerHandlers() {
            this.registerHandlersFromRegistry();
        }

        /**
         * Instantiates every handler the profile declares, by class name off
         * `window`. `optionalHandler` is declared by six entries across the two
         * profiles - those types ship in only one app, so a missing class is
         * expected and silent.
         */
        registerHandlersFromRegistry() {
            if (!this.registry) return;

            const register = (key, className, optional) => {
                const Ctor = window[className];
                if (typeof Ctor === 'undefined') {
                    if (!optional) {
                        console.error(`[Controller] Handler class '${className}' for '${key}' not loaded`);
                    }
                    return;
                }
                this.core.registerHandler(key, new Ctor(this.core));
            };

            for (const type of this.registry.handlerTypes()) {
                register(type, this.registry.handlerFor(type), this.registry.isHandlerOptional(type));
            }
            for (const [key, className] of Object.entries(this.registry.auxHandlers())) {
                register(key, className, false);
            }
        }

        // ════════════════════════════════════════════════════════════════
        // Optional hooks - subclasses MAY override
        // ════════════════════════════════════════════════════════════════

        /**
         * Ingest one file into one operation type. Apps own their parser and
         * operation wiring; processFiles below only sequences them.
         * @param {File} file
         * @param {string} type
         */
        async processFile(file, type) { throw new Error('processFile() not implemented'); }

        /*Register app-specific keyboard handlers.*/
        registerAppShortcuts() {}

        /** Extra core setup after initCore (scene refs, history, stock) */
        onCoreReady() {}

        /** After WASM loads (e.g. laser visibility) */
        onPostWASM() {}

        /** Wire app-specific DOM events (toolbar, file drops, etc) */
        onBindEvents() {}

        /** Final render pass, show welcome, assign window globals */
        onFinalize() {}

        // ════════════════════════════════════════════════════════════════
        // 3D Viewport
        // ════════════════════════════════════════════════════════════════

        get renderMode() { return this._renderMode || '2d'; }

        async enter3DMode() {
            const container = document.getElementById('viewport-3d');
            const shell = document.querySelector('.canvas-container');
            if (!container || !shell) {
                this.ui.setStatus('3D viewport container missing from page', 'error');
                return;
            }

            // Hiding an element that holds the active element sends focus to
            // <body>, so read it before the swap. Focus only moves when it was
            // already in the viewport being swapped out.
            const canvas = document.getElementById('preview-canvas');
            const hadFocus = !!canvas && document.activeElement === canvas;

            shell.dataset.renderMode = '3d';
            container.hidden = false;
            this._renderMode = '3d';

            try {
                const view = await this.open3DPreview(container);
                view.onResize();
                this.render3D();
                if (!this._hasFitted3DOnce) {
                    view.fitToContent();
                    this._hasFitted3DOnce = true;
                } else {
                    view.requestRender();
                }
                if (hadFocus) container.focus();

                const btn3D = document.getElementById('btn-toggle-3d');
                if (btn3D) {
                    btn3D.classList.add('active');
                    btn3D.querySelector('use')?.setAttribute('href', '#icon-view-2d');
                    this.sync3DToggleAvailability();
                }
                this.ui.setStatus('3D view active. F2 returns to 2D.', 'info');
            } catch (err) {
                console.error('3D preview failed:', err);
                this.ui.setStatus('3D preview failed: ' + err.message, 'error');
                this.exit3DMode();
            }
        }

        exit3DMode() {
            const container = document.getElementById('viewport-3d');
            const hadFocus = !!container && container.contains(document.activeElement);

            this.renderer3D?.simulator?.stop();
            const shell = document.querySelector('.canvas-container');
            if (container) container.hidden = true;
            if (shell) delete shell.dataset.renderMode;
            this._renderMode = '2d';

            const btn3D = document.getElementById('btn-toggle-3d');
            if (btn3D) {
                btn3D.classList.remove('active');
                btn3D.querySelector('use')?.setAttribute('href', '#icon-view-3d');
                this.sync3DToggleAvailability();
            }

            // EasyTrace has no renderAll; its canvas repaints through the renderer.
            if (this.ui.renderAll) this.ui.renderAll();
            else this.ui.renderer?.render();

            if (hadFocus) document.getElementById('preview-canvas')?.focus();
        }

        /**
         * Whether a 2D canvas view is meaningful. A scene of nothing but
         * meshes has no 2D drawing, so offering the swap only produces an
         * empty canvas the user then has to undo.
         */
        has2DContent() { return true; }

        /**
         * Reflects has2DContent on the toolbar button.
         */
        sync3DToggleAvailability() {
            const btn = document.getElementById('btn-toggle-3d');
            if (!btn) return;
            const locked = !this.has2DContent();
            btn.disabled = locked && this.renderMode === '3d';
            btn.title = btn.disabled
                ? '3D only - this scene has no 2D geometry'
                : 'Toggle 2D/3D View (F2)';
        }

        /**
         * Guarded because enter3DMode awaits a dynamic import: a second
         * toggle mid-load would exit while the first entry is still in
         * flight, leaving refresh3D skipped and the status line claiming
         * 3D over a 2D canvas.
         */
        async toggle3DMode() {
            if (this._modeSwitching) return;
            if (this.renderMode === '3d' && !this.has2DContent()) {
                this.ui.setStatus('This scene only contains 3D geometry - there is nothing to show in 2D.', 'info');
                return;
            }
            this._modeSwitching = true;
            try {
                if (this.renderMode === '3d') this.exit3DMode();
                else await this.enter3DMode();
            } finally {
                this._modeSwitching = false;
            }
        }

        /**
         * The viewport follows the SELECTED NODE, in one direction only: a 3D
         * artifact pulls the view into 3D, nothing pushes it back out.
         * Auto-exiting on a 2D node was a transition aid for operators coming
         * from the 2D canvas, and it treated the render mode as a property of
         * the node when it is a property of the session - selecting a profile's
         * offsets while deliberately in 3D is not a request to leave 3D. F2 and
         * has2DContent stay the only ways back.
         * @param {?string} artifact 'offsets' | 'preview' | 'toolpath' | null
         * @param {?Object} operation the operation the node belongs to
         */
        async setViewportForNode(artifact, operation = null) {
            const dimension = operation ? this.registry?.dimensionFor(operation.type, this.core.machineClassOf(operation)) : null;
            const want3D = 'toolpath' === artifact || '3d' === dimension;
            // Keyed on the ARTIFACT, not the resulting mode: a 3D operation's
            // offsets node is also 3D, and treating it as a toolpath node
            // suppresses the geometry mirror on the node that exists to show it.
            this._3dFocus = 'toolpath' === artifact ? 'toolpath' : 'geometry';
            if (want3D) {
                if ('3d' !== this.renderMode) {
                    await this.enter3DMode();
                } else {
                    this.refresh3D();
                }
            } else if ('3d' === this.renderMode) {
                this.refresh3D();
            }
        }

        /**
         * 3D refresh is a SCHEDULER plus one renderer. Generation touches layers,
         * viewport and toolpaths in the same turn, so coalescing is the default;
         * `immediate` exists for callers that read the scene back in the same tick
         * (entering 3D fits the camera to content that would not exist yet).
         */
        refresh3D(immediate = false) {
            if (immediate) {
                this._refresh3DQueued = false;
                this.render3D();
                return;
            }
            if (this._refresh3DQueued) return;
            this._refresh3DQueued = true;
            requestAnimationFrame(() => {
                this._refresh3DQueued = false;
                this.render3D();
            });
        }

        /**
         * App-specific model drawing goes through refresh3DModel.
         */
        render3D() {
            if ("3d" !== this.renderMode || !this.renderer3D) return;
            const view = this.renderer3D;

            // Same matrix GeometryTranslator stamps into every plan.
            const machineMatrix = this.core.pipelineContext.getTransforms().machineMatrix;
            const w2m = p => TransformMath.applyToPoint(machineMatrix, p);
            const box = this.get3DStockBox(w2m);
            const topZ = box && box.topZ || 0;
            const model = this.refresh3DModel({ view: view, w2m: w2m, machineMatrix: machineMatrix, topZ: topZ }) || null;

            // A 4th-axis operation draws its own blank on the axis line. The flat
            // slab and the operation's flat source outline both describe a part
            // that is not there.
            const has4thAxisBlank = !(!model?.developedSpace && !model?.indexedFrame);
            box && !has4thAxisBlank ? view.stock.setStock(box) : view.stock.removeStock();

            const defs = [];
            for (const [name, layer] of this.ui.renderer.layers) {
                if (false === layer.visible || layer.isStock) continue;
                if (!layer.primitives || 0 === layer.primitives.length) continue;

                // A rotary source is hidden beside its own blank: a flat footprint
                // at Z0 with no relationship to the cylinder next to it.
                if ("source" === layer.role && has4thAxisBlank && "rotary" === layer.operationType) continue;

                const solidWidth = "preview" === layer.type && layer.metadata?.toolDiameter || 0;
                const op = layer.operationId
                    ? this.core.store.getOperation(layer.operationId)
                    : (layer.name?.startsWith("source_") ? this.core.store.getOperation(layer.name.slice(7)) : null);
                const hasToolpaths = !!op && this.core.toolpaths.has(op.id);
                // In 3D, use the differenced copper geometry (with drilled holes punched out) if available
                const isCopperLayer = "isolation" === layer.operationType || "clearing" === layer.operationType;
                const isBaseCopper = "source" === layer.role || layer.isFused;
                const primitives3d = (op && op._3dCopperPrimitives && isBaseCopper && isCopperLayer)
                    ? op._3dCopperPrimitives
                    : layer.primitives;

                defs.push({
                    name: name,
                    primitives: primitives3d,
                    transform: layer.transform || null,
                    zIndex: layer.zIndex || 0,
                    solidWidth: solidWidth,
                    isOffset: "offset" === layer.type || true === layer.isOffset,
                    operationType: layer.operationType || layer.type || null,
                    role: layer.role || null,
                    hasToolpaths: hasToolpaths,
                    machineClass: op ? this.core.machineClassOf(op) : this.core.machineClassForType(layer.operationType || layer.type),
                    metadata: layer.metadata || null,
                    color: this.ui.resolveLayerColor(layer)
                });
            }
            view.geometry.setLayers(defs, { baseZ: topZ, worldToMachine: w2m });

            // Every operation with plans that has not been hidden
            const plans = [];
            for (const [opId, entry] of this.core.toolpaths) {
                if (!entry?.plans?.length) continue;
                const vis = this.core.store.getOperation(opId)?.layerVisibility;
                false !== vis?.generated && false !== vis?.toolpath && plans.push(...entry.plans);
            }
            view.setPlans(plans);
        }

        /**
         * @param {function} w2m world → machine point map
         * @returns {?{minX,minY,maxX,maxY,thickness,topZ}}
         */
        get3DStockBox(w2m) { return null; }

        /**
         * App-specific model drawing (meshes, rotary/indexed blanks).
         * @returns {?Object} the generating operation's offsets metadata, or null.
         *     render3D reads `developedSpace` / `indexedFrame` from it to decide
         *     whether a 4th-axis blank replaced the flat stock. Returning nothing
         *     reads as "no blank" and leaves the slab drawn through the part.
         */
        refresh3DModel(ctx) { return null; }

        applyTheme3D() {
            if (!this.renderer3D) return;
            this.renderer3D.setOptions?.(this.buildRenderer3DOptions());
            this.refresh3D();
        }

        // ════════════════════════════════════════════════════════════════
        // Shared Shortcut Registration
        // ════════════════════════════════════════════════════════════════

        registerSharedShortcuts() {
            window.addEventListener("themechange", () => this.applyTheme3D());
            window.addEventListener("settingschange", () => this.refresh3D());
            this.core.scene.addTransformListener(() => this.refresh3D());

            this.shortcutManager.registerActions({
                toggle3D: () => this.toggle3DMode(),
                zoomFit: () => this.ui.zoomFit(),
                zoomIn: () => this.ui.zoomIn(),
                zoomOut: () => this.ui.zoomOut(),
                toggleGrid: () => {
                    if (this.ui.renderer) {
                        const t = document.getElementById("show-grid");
                        if (t) {
                            t.checked = !t.checked;
                            t.dispatchEvent(new Event("change", { bubbles: true }));
                        } else {
                            this.ui.renderer.setOptions({ showGrid: !this.ui.renderer.options.showGrid });
                        }
                    }
                },
                escape: e => this.handleEscapeKey(e),
                showHelp: () => this.modalManager?.showModal("help"),
                toggleVerboseDebug: () => {
                    const t = document.getElementById("debug-log-toggle");
                    if (t) {
                        t.checked = !t.checked;
                        t.dispatchEvent(new Event("change", { bubbles: true }));
                        this.ui.setStatus("Verbose debug " + (t.checked ? "on" : "off"), "info", true);
                    }
                },
                cycleFocusZone: e => this.cycleFocusZone(e.shiftKey ? -1 : 1)
            });

           // Hard reads. defaults.ui.shortcuts is the vocabulary and is not
            // optional - a `?.` here turns a typo in config.js into an app
            // with no keyboard and no error.
            const profileTable = this.appProfile.ui.shortcuts || [];
            const overridden = new Set(profileTable.map(s => s.combo));
            const shared = D.ui.shortcuts.filter(s => !overridden.has(s.combo));
            this.shortcutManager.applyTable([...profileTable, ...shared]);
        }

        // ════════════════════════════════════════════════════════════════
        // Focus Zone Cycling
        // ════════════════════════════════════════════════════════════════

        cycleFocusZone(direction) {
            if (this.modalManager?.activeModal) return;

            // The viewport zone is whichever surface is live. The hidden one
            // cannot take focus, and its _zoneMemory entry must not be picked.
            const viewportId = this.renderMode === '3d' ? 'viewport-3d' : 'preview-canvas';
            const zones = ['cam-toolbar', 'sidebar-left', viewportId, 'sidebar-right'];
            if (!this._zoneMemory) this._zoneMemory = new Map();

            const activeEl = document.activeElement;
            let currentIndex = -1;

            // Dynamically find the current zone and save the specific element focused
            zones.forEach((id, index) => {
                const el = document.getElementById(id);
                if (el && el.contains(activeEl)) {
                    currentIndex = index;
                    if (activeEl !== document.body) {
                        this._zoneMemory.set(id, activeEl);
                    }
                }
            });

            // Calculate the next zone index, defaulting to the start/end if focus was lost
            const nextIndex = currentIndex === -1
                ? (direction > 0 ? 0 : zones.length - 1)
                : (currentIndex + direction + zones.length) % zones.length;

            const nextId = zones[nextIndex];
            const nextZoneEl = document.getElementById(nextId);
            if (!nextZoneEl) return;

            // Restore focus to the remembered element, or grab the first available target
            let landed = null;
            const remembered = this._zoneMemory.get(nextId);

            if (remembered && document.body.contains(remembered) && remembered.offsetParent !== null) {
                remembered.focus();
                landed = remembered;
            } else if (nextZoneEl.hasAttribute('tabindex')) {
                // querySelector below only searches descendants. The viewport
                // zones ARE the zone element and a canvas has no children so
                // without this branch focus never enters them.
                nextZoneEl.focus();
                landed = nextZoneEl;
            } else {
                const target = nextZoneEl.querySelector(
                    '[tabindex="0"], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled])'
                );
                if (target) { target.focus(); landed = target; }
            }

            if (landed) this.announceFocusZone(nextId, nextZoneEl);
        }

        announceFocusZone(zoneId, zoneEl) {
            const fallback = {
                'cam-toolbar': 'Toolbar',
                'sidebar-left': 'Left panel',
                'preview-canvas': 'Canvas',
                'viewport-3d': '3D viewport',
                'sidebar-right': 'Properties'
            };
            const name = zoneEl.getAttribute('aria-label') || fallback[zoneId] || zoneId;
            this.ui?.setStatus?.(`${name} focused`, 'info', true);
        }

        /**
         * Destructive actions with no undo path get a confirmation. EasyShape's
         * shape deletes go through history and deliberately do NOT use this -
         * a dialog in front of an undoable action is friction, not safety.
         */
        confirmDestructive(title, message, onConfirm, confirmText = 'Delete') {
            const returnTo = document.activeElement;
            const restore = () => {
                if (returnTo && document.body.contains(returnTo)) returnTo.focus();
            };
            this.modalManager?.showWarning(title, message, {
                confirmText,
                cancelText: 'Cancel',
                onConfirm: () => { onConfirm(); restore(); },
                onCancel: restore
            });
        }

        /** Subclasses override for escape behavior */
        handleEscapeKey(e) {}

        // ════════════════════════════════════════════════════════════════
        // Core Initialization
        // ════════════════════════════════════════════════════════════════

        initCore() {
            // ParameterStore is built before loadProfile, so registry and
            // toolLibrary are still null here. The getters bind late; a plain
            // value would freeze the nulls and every stage cascade would return
            // empty with no error anywhere. `lang` binds the same way - the
            // LanguageManager is not constructed until after loadProfile.
            const ctrl = this;
            this.core = new CamCore({
                emit: (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail })),
                storage: window.localStorage
            });
            this.parameterStore = new ParameterStore({
                get settings() { return ctrl.core.settings; },
                get registry() { return ctrl.core.registry; },
                get toolLibrary() { return ctrl.core.toolLibrary; },
                get lang() { return ctrl.languageManager; },
                getOperation: id => ctrl.core.store.getOperation(id)
            });
            this.inputRenderer = new InputRenderer(this.parameterStore, this.core);
            this.toolLibrary = new ToolLibrary();
            this.initState.coreReady = true;
        }

        async loadProfile(embeddedVarName, fetchPath) {
            let data;
            if (typeof window[embeddedVarName] !== 'undefined') {
                data = window[embeddedVarName];
            } else {
                try {
                    const resp = await fetch(fetchPath);
                    if (resp.ok) data = await resp.json();
                    else console.error(`Failed to load profile: ${fetchPath} (${resp.status})`);
                } catch (e) {
                    console.error(`Failed to load profile: ${fetchPath}`, e);
                }
            }
            if (!data) return null;

            if (data.parameters) this.parameterStore.setDefinitions(data.parameters);

            this.registry = new OperationRegistry(data);
            // REVIEW - Defensive debug check, worth keeping?
            if (D.debug.enabled) this.registry.validate();
            this.core.setRegistry(this.registry);

            this.appProfile = data;
            this.core.appProfile = data;
            return data;
        }

        initGCodeGenerator(languageManager) {
            this.gcodeGenerator = new GCodeGenerator(D.gcode);
            this.gcodeGenerator.setCore(this.core);
            this.gcodeGenerator.setLanguageManager(languageManager);
            this.core.setGCodeGenerator(this.gcodeGenerator);
        }

        async initGraphicsExporter() {
            this.graphicsExporter = new GraphicsExporter();
            if (typeof EMBEDDED_LASER_PROFILES !== 'undefined') {
                this.graphicsExporter.setProfiles(EMBEDDED_LASER_PROFILES);
                this.core.setGraphicsExporter(this.graphicsExporter);
                return;
            }
            let data = null;
            try {
                const url = '../export/laser-profiles.json';
                const resp = await fetch(url);
                if (resp.ok) {
                    data = await resp.json();
                } else {
                    console.error(`Failed to load laser profiles: ${url} (${resp.status})`);
                }
            } catch (e) {
                console.error(`Failed to load laser profiles: ${e.message}`);
            }
            if (data) this.graphicsExporter.setProfiles(data);
            this.core.setGraphicsExporter(this.graphicsExporter);
        }

        async initToolLibrary() {
            if (!this.toolLibrary) return;
            this.toolLibrary.registry = this.registry;
            await this.toolLibrary.init(this.appProfile);
            if (this.core.setToolLibrary) this.core.setToolLibrary(this.toolLibrary);
        }

        async initializeWASM() {
            try {
                // REVIEW - Are all this defensive checks necessary?
                if (!this.core?.initializeProcessors) {
                    console.warn('Core processor initialization not available');
                    return false;
                }
                this.debug('Loading Clipper2 WASM modules...');
                const result = await this.core.initializeProcessors();
                this.initState.wasmReady = !!result;
                if (result) this.debug('Clipper2 WASM modules loaded successfully');
                return !!result;
            } catch (error) {
                console.error('WASM initialization error:', error);
                this.initState.wasmReady = false;
                return false;
            }
        }

        // ════════════════════════════════════════════════════════════════
        // Pipeline State
        // ════════════════════════════════════════════════════════════════

        get pipelineState() { return this.core.settings.pipeline; }

        /**
         * @param {string} machineClass - 'router' | 'laser'
         * @param {Object} [opts]
         * @param {Object} [opts.classByType] - per-type class overrides
         */
        setMachineClass(machineClass, opts = {}) {
            const state = { machineClass, classByType: opts.classByType || null };
            this.core.updateSettings('pipeline', state);
            this.core.setMachineClass(machineClass, state.classByType);
            this.ui.refreshMachineSettings();
            return state;
        }

        /**
         * The pipeline commit behind the laser-config cards.
         */
        applyPipelineChoice(choice) {
            // Copper goes to the laser, holes and outline to the mill.
            // Per-operation stamps come from this at createOperation.
            if (choice === 'fiber') {
                this.setMachineClass('router', { classByType: { isolation: 'laser', clearing: 'laser' } });
            } else {
                this.setMachineClass('laser');
            }
        }

        /** Batch ingest for the quickstart drop zones. */
        async processFiles(fileByType) {
            for (const [type, file] of Object.entries(fileByType)) {
                if (file) await this.processFile(file, type);
            }
            requestAnimationFrame(() => {
                this.ui.renderer.zoomFit();
                this.ui.renderer.render();
            });
        }

        /** @param {?string[]} dims - null clears the restriction. */
        setWorkspaceDimensions(dims) {
            this.workspaceDimensions = dims ? new Set(dims) : null;
            this.ui?.initOpTypeTabs?.();
        }

        allowsOperationType(type) {
            if (!this.workspaceDimensions) return true;
            const dim = this.registry?.dimensionFor(type, this.core.machineClassForType(type));
            return !dim || this.workspaceDimensions.has(dim);
        }

        // ════════════════════════════════════════════════════════════════
        // Export Coordination
        // ════════════════════════════════════════════════════════════════

        /**
         * Per-operation plans, for the toolpath stage and the 3D view.
         */
        async computeToolpaths(operationId, options = {}) {
            return this.core.computeToolpaths(operationId, this.parameterStore, options);
        }

        async executeExports(intent) {
            const route = ids => {
                const cncOperationIds = [], laserOperationIds = [], vectorOperationIds = [];
                for (const id of ids) {
                    const op = this.core.store.getOperation(id);
                    if (!op) continue;
                    const cls = this.core.machineClassOf(op);
                    if ('laser' === cls) laserOperationIds.push(id);
                    else if ('router' === cls) cncOperationIds.push(id);
                    else vectorOperationIds.push(id);
                }
                return { cncOperationIds, laserOperationIds, vectorOperationIds };
            };

            const stencils = [], board = [];
            for (const id of intent.operationIds) {
                ('stencil' === this.core.store.getOperation(id)?.type ? stencils : board).push(id);
            }

            const messages = [];
            let success = false;

            if (board.length > 0) {
                const r = await this.runExport({ ...intent, ...route(board) });
                success = success || r.success;
                messages.push(r.message);
            }

            for (const id of stencils) {
                const op = this.core.store.getOperation(id);
                const label = (op.file?.name || op.id).replace(/\.[^.]+$/, "");
                const r = await this.runExport({
                    ...intent,
                    singleFile: false,
                    baseName: `${intent.baseName}-stencil-${label}`,
                    gcodeResults: intent.gcodeResults,
                    ...route([id])
                });
                success = success || r.success;
                messages.push(r.message);
            }

            return { success, message: messages.join(' | ') || 'No files generated.' };
        }

        /**
         * Produces every file one routed job asks for, then delivers them.
         * File PRODUCTION is the engine's job and stays pure; file DELIVERY
         * is a browser fact and lives here, which is why this is not on CamCore.
         *
         * @param {Object} intent  routed - carries cnc/laser/vector id lists
         * @returns {Promise<{success: boolean, message: string}>}
         */
        async runExport(intent) {
            const allFiles = [];
            const parts = [];

            // G-code
            const cncOps = (intent.cncOperationIds || []).map(id => this.core.store.getOperation(id)).filter(Boolean);
            if (cncOps.length > 0) {
                const processorInfo = this.core.gcodeGenerator.getProcessorInfo(this.core.settings.gcode.postProcessor);
                const cncExt = processorInfo.fileExtension;

                let gcodeResults = intent.gcodeResults;
                if (!gcodeResults || Object.keys(gcodeResults).length === 0) {
                    gcodeResults = await this.core.generateGCodeResults({
                        operationIds: intent.cncOperationIds,
                        singleFile: intent.singleFile,
                        // Was `splitDrills`, which nothing ever set: pressing
                        // Export without Calculate produced one combined drill
                        // file with no warning.
                        splitDrillOpIds: intent.splitDrillOpIds,
                        optimize: intent.optimize ?? true,
                        includeComments: intent.includeComments,
                        toolChanges: intent.toolChanges,
                        groupByTool: intent.groupByTool
                    }, this.parameterStore);
                }

                if (intent.singleFile) {
                    const combined = gcodeResults.__combined__;
                    if (combined?.gcode) {
                        allFiles.push({
                            blob: new Blob([combined.gcode], { type: 'text/plain' }),
                            filename: `${intent.baseName}${cncExt}`
                        });
                    }
                } else {
                    for (const op of cncOps) {
                        const opCleanName = op.file.name.replace(/\.[^/.]+$/, '');
                        const splitKeys = Object.keys(gcodeResults).filter(k => k.startsWith(`${op.id}_`));

                        if (splitKeys.length > 0) {
                            for (const key of splitKeys) {
                                const result = gcodeResults[key];
                                if (!result?.gcode) continue;
                                const suffix = key.substring(op.id.length + 1).replace(/_/g, '-');
                                allFiles.push({
                                    blob: new Blob([result.gcode], { type: 'text/plain' }),
                                    filename: `${intent.baseName}-${suffix}-${opCleanName}${cncExt}`
                                });
                            }
                        } else {
                            const result = gcodeResults[op.id];
                            if (result?.gcode) {
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
            const laserOps = (intent.laserOperationIds || []).map(id => this.core.store.getOperation(id)).filter(Boolean);
            if (laserOps.length > 0) {
                const unready = laserOps.filter(op => !op.offsets || op.offsets.length === 0);
                if (unready.length > 0) {
                    this.debug(`Laser export blocked: ${unready.map(o => o.file.name).join(', ')} missing paths`);
                } else {
                    const laserSettings = this.core.settings.laser;
                    const result = await this.core.generateLaserExportFiles(laserOps, this.parameterStore, {
                        format: laserSettings.exportFormat,
                        dpi: laserSettings.exportDPI,
                        padding: intent.laserPadding ?? laserSettings.exportPadding,
                        includeComments: intent.includeComments,
                        singleFile: intent.singleFile,
                        baseName: intent.baseName
                    });
                    if (result.success) { allFiles.push(...result.files); parts.push('Laser'); }
                }
            }

            // Plain vector: knife, drag cutter
            const vectorOps = (intent.vectorOperationIds || []).map(id => this.core.store.getOperation(id)).filter(Boolean);
            if (vectorOps.length > 0) {
                const unready = vectorOps.filter(op => !op.offsets || op.offsets.length === 0);
                if (unready.length > 0) {
                    this.debug(`Vector export blocked: ${unready.map(o => o.file.name).join(', ')} missing geometry`);
                } else {
                    const exportBaseName = intent.baseName.includes("stencil") ? intent.baseName : `${intent.baseName}-vector`;
                    const result = await this.core.generateLaserExportFiles(vectorOps, this.parameterStore, {
                        layerColors: { stencil: "#000000" },
                        format: "svg",
                        padding: intent.stencilPadding ?? 5,
                        includeComments: intent.includeComments,
                        singleFile: intent.singleFile,
                        baseName: exportBaseName,
                        heatManagement: "off",
                        reverseCutOrder: false,
                        svgGrouping: "layer",
                        colorPerPass: false
                    });
                    if (result.success) {
                        allFiles.push(...result.files);
                        parts.push('Vector');
                    }
                }
            }

            if (allFiles.length === 0) return { success: false, message: 'No files generated.' };

            await this.deliverFiles(allFiles);
            return { success: true, message: `${parts.join(' + ')} export completed successfully` };
        }

        /**
         * Safari serialises programmatic downloads and drops everything after
         * the first unless they are paced.
         */
        async deliverFiles(files) {
            const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
            for (const file of files) {
                this.triggerDownload(file.blob, file.filename);
                if (isWebKit) await new Promise(res => setTimeout(res, 500));
            }
        }

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

        // ════════════════════════════════════════════════════════════════
        // Example Loading
        // ════════════════════════════════════════════════════════════════

        getExamples() {
            return this.appProfile.examples;
        }

        // ════════════════════════════════════════════════════════════════
        // UI Wiring
        // ════════════════════════════════════════════════════════════════

        hideLoadingOverlay(delay = 300) {
            const overlay = document.getElementById('loading-overlay');
            if (overlay) setTimeout(() => overlay.classList.add('is-hidden'), delay);
        }

        initializeTheme() {
            const key = ROOT.CAMConfig.constants.storageKeys.theme;
            const savedTheme = localStorage.getItem(key) || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            return savedTheme;
        }

        setupToolbarDropdown(btnId, menuId) {
            const btn = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            if (!btn || !menu) return;

            btn.setAttribute("aria-haspopup", "true");
            btn.setAttribute("aria-expanded", "false");
            menu.setAttribute("role", "menu");
            menu.querySelectorAll(".menu-item").forEach(item => {
                item.setAttribute("role", "menuitem");
                item.setAttribute("tabindex", "-1");
            });

            const closeMenu = (restoreFocus = false) => {
                btn.classList.remove("active");
                btn.setAttribute("aria-expanded", "false");
                menu.classList.remove("is-open");
                if (this.activeDropdown?.menu === menu) this.activeDropdown = null;
                restoreFocus && btn.focus();
            };

            const openMenu = () => {
                this.closeDropdown(); // Close any currently open dropdown first
                btn.classList.add("active");
                btn.setAttribute("aria-expanded", "true");
                menu.classList.add("is-open");
                this.activeDropdown = { menu, close: closeMenu };
                menu.querySelector(".menu-item")?.focus();
            };

            btn.addEventListener("click", e => {
                e.stopPropagation();
                menu.classList.contains("is-open") ? closeMenu() : openMenu();
            });

            btn.addEventListener("keydown", e => {
                if ("ArrowDown" === e.key) {
                    e.preventDefault();
                    openMenu();
                }
            });

            menu.addEventListener("keydown", e => {
                const items = Array.from(menu.querySelectorAll(".menu-item:not([disabled])"));
                const idx = items.indexOf(document.activeElement);
                if ("ArrowDown" === e.key) {
                    e.preventDefault();
                    items[(idx + 1) % items.length]?.focus();
                } else if ("ArrowUp" === e.key) {
                    e.preventDefault();
                    items[(idx - 1 + items.length) % items.length]?.focus();
                } else if ("Home" === e.key) {
                    e.preventDefault();
                    items[0]?.focus();
                } else if ("End" === e.key) {
                    e.preventDefault();
                    items[items.length - 1]?.focus();
                } else if ("Escape" === e.key) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMenu(true);
                } else if ("Tab" === e.key) {
                    closeMenu();
                }
            });

            document.addEventListener("click", e => {
                menu.classList.contains("is-open") && !btn.contains(e.target) && !menu.contains(e.target) && closeMenu();
            });

            menu.addEventListener("click", e => {
                if (e.target.closest(".menu-item")) closeMenu();
                else e.stopPropagation();
            });
        }

        closeDropdown() {
            this.activeDropdown?.close();
        }

        setupViewportBarDismiss(barId = 'workspace-viewport-bar', btnId = 'dismiss-viewport-bar') {
            document.getElementById(btnId)?.addEventListener('click', () => {
                document.getElementById(barId)?.classList.add('dismissed');
            });
        }

        setupSharedToolbarButtons() {
            document.getElementById('zoom-fit-btn')?.addEventListener('click', () => this.ui.zoomFit());
            document.getElementById('zoom-in-btn')?.addEventListener('click', () => this.ui.zoomIn());
            document.getElementById('zoom-out-btn')?.addEventListener('click', () => this.ui.zoomOut());
            document.getElementById('btn-help')?.addEventListener('click', () => this.modalManager?.showModal('help'));
        }

        readFileAsText(file) {
            return new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = e => resolve(e.target.result);
                r.onerror = () => reject(new Error('FileReader error'));
                r.readAsText(file);
            });
        }

        // 3d relief map scafolding
        readFileAsArrayBuffer(file) {
            return new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = e => resolve(e.target.result);
                r.onerror = () => reject(new Error('FileReader error'));
                r.readAsArrayBuffer(file);
            });
        }

        preload3D() {
            if ("undefined" === typeof window || window.Renderer3D) return;
            const fetch3D = () => import("../renderer3d/renderer3d-core.js").catch(() => {});
            "requestIdleCallback" in window
                ? window.requestIdleCallback(fetch3D, { timeout: 3000 })
                : setTimeout(fetch3D, 1500);
        }        

        // Lazy 3D mount: nothing loads until requested. Stock, 2D geometry
        // and relief meshes flow in through refresh3D() so the view can
        // never go stale. Machine-ready plans are not mirrored here - the
        // export path owns toolpath generation.
        async open3DPreview(container) {
            window.Renderer3D || await import("../renderer3d/renderer3d-core.js");
            if (!this.renderer3D) {
                this.renderer3D = await window.Renderer3D.mount(container, this.buildRenderer3DOptions());
                await this.renderer3D.attachOrbitTool({
                    onPick: hit => this.on3DPick?.(hit)
                });
            }
            return this.renderer3D;
        }

        // 3D palette from the theme.

        // REVIEW - This needs to be implemented in the same way 2d rendering does it.
        buildRenderer3DOptions() {
            const v = (name, fallback) => this.ui.readCSSVar(name, fallback);
            return {
                background: v('--color-render3d-background'),
                skyColor: v('--color-render3d-sky'),
                groundColor: v('--color-render3d-ground'),
                gridColor: v('--color-render3d-grid'),
                gridCenterColor: v('--color-render3d-grid-center'),
                rapidColor: v('--color-render3d-rapid'),
                cutColorShallow: v('--color-render3d-cut-shallow'),
                cutColorDeep: v('--color-render3d-cut-deep'),
                stockColor: v('--color-render3d-stock'),
                surfaceColor: v('--color-render3d-surface')
            };
        }

        // ════════════════════════════════════════════════════════════════
        // Debug & Stats
        // ════════════════════════════════════════════════════════════════

        debug(message, data = null) {
            if (debugState.enabled) {
                data !== null
                    ? console.log(`[Controller] ${message}`, data)
                    : console.log(`[Controller] ${message}`);
            }
        }

        getStats() {
            return {
                initialization: this.initState,
                core: this.core?.store?.getStats() ?? null,
                renderer: {
                    hasRenderer: !!this.ui?.renderer,
                    layerCount: this.ui?.renderer?.layers?.size || 0
                }
            };
        }

        logState() {
            console.group('CAM State');
            console.log('Initialization:', this.initState);
            console.log('Statistics:', this.getStats());
            console.groupEnd();
        }
    }

    ROOT.CamController = CamController;
})();