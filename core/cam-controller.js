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
            this.appProfile = null;
            this.languageManager = null;
            this.modalManager = null;
            this.shortcutManager = null;
            this.registry = null;
            this.storageKeys = null;
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
            this.renderer3D = null;
            this._mount3D = null; // in-flight Renderer3D.mount, shared by concurrent callers
            this._zoneMemory = new Map(); // focus zone id → last focused element
            this._renderMode = '2d';
            this._modeSwitching = false;

            // Safari drops back-to-back downloads; deliverFiles spaces them out.
            this.pacesDownloads = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
        }

        // ════════════════════════════════════════════════════════════════
        // Shared Initialization Sequence
        // ════════════════════════════════════════════════════════════════

        async initialize() {
            const appLabel = this.getAppLabel();
            this.debug(`${appLabel} initializing...`);
            try {
                // Core
                this.initCore();
                this.onCoreReady();
                // Profile & Data
                const pc = this.getProfileConfig();
                await this.loadProfile(pc.embeddedVar, pc.fetchPath);
                this.storageKeys = C.storageKeys.forApp(this.appProfile.meta.app);
                // Engine services live on the core; the UI reaches them through it.
                const toolLibrary = new ToolLibrary();
                toolLibrary.registry = this.registry;
                await toolLibrary.init();
                this.core.toolLibrary = toolLibrary;
                this.languageManager = new LanguageManager();
                await this.languageManager.load();
                // Pipeline & Storage
                this.core.gcodeGenerator = new GCodeGenerator(D.gcode, this.core, this.languageManager);
                await this.initGraphicsExporter();
                this.registerHandlers();
                this.core.settings = this.core.loadSettings(this.storageKeys.settings, this.appProfile);
                // Restore the machine class the session was left in before any
                // panel renders against it.
                const saved = this.core.settings.pipeline;
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
                let wasmReady = false;
                try {
                    this.debug('Loading Clipper2 WASM modules...');
                    wasmReady = !!(await this.core.initializeProcessors());
                    if (wasmReady) this.debug('Clipper2 WASM modules loaded successfully');
                } catch (error) {
                    console.error('WASM initialization error:', error);
                }
                this.initState.wasmReady = wasmReady;
                if (!wasmReady) {
                    console.warn('WASM modules failed - running in fallback mode');
                    this.ui.setStatus(this.appProfile?.ui?.text?.statusWarning || 'Warning: WASM failed', 'warning');
                }
                // Events & Shortcuts
                this.shortcutManager = new ShortcutManager(this.modalManager);
                this.registerAppShortcuts();
                this.registerSharedShortcuts();
                this.setupSharedToolbarButtons();
                this.onBindEvents();
                // Finalize
                this.onFinalize();
                this.hideLoadingOverlay();
                this.initState.fullyReady = true;
                // Fetch the 3D module while idle, so the first F2 does not wait on it.
                if (!window.Renderer3D) {
                    const fetch3D = () => import('../renderer3d/renderer3d-core.js').catch(() => {});
                    if ('requestIdleCallback' in window) window.requestIdleCallback(fetch3D, { timeout: 3000 });
                    else setTimeout(fetch3D, 1500);
                }
                this.ui.setStatus(this.appProfile?.ui?.text?.statusReady || 'Ready');
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
         * `window`. `optionalHandler` marks a type whose script the page does
         * not load yet (EasyShape's `pattern` stub), so its missing class is
         * silent; any other missing class is an error.
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

        /** @returns {string[]} operation types the quickstart modal offers drop zones for */
        getQuickstartOpTypes() {
            return [];
        }

        /** Extra core setup after initCore (scene refs, history, stock) */
        onCoreReady() {}

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
            this.ui.renderer.setSuspended(true);

            try {
                this._refresh3DQueued = false;
                const view = await this.open3DPreview(container);
                // The user left 3D while the first mount was in flight.
                if (this._renderMode !== '3d') return;

                // Content, framing, then the loop: the first frame drawn is
                // the finished scene at the container's real size.
                this.render3D();
                if (!this._hasFitted3DOnce) {
                    view.fitToContent();
                    this._hasFitted3DOnce = true;
                }
                view.setActive(true);
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
            this.renderer3D?.simulator?.stop(); // REVIEW - Not implemented yet?
            this.renderer3D?.setActive(false);
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
            this.ui.renderer.setSuspended(false);
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

        /** Hook: a click on the 3D view hit something. */
        on3DPick(hit) {}

        /**
         * Reflects has2DContent on the toolbar button.
         */
        sync3DToggleAvailability() {
            const btn = document.getElementById('btn-toggle-3d');
            if (!btn) return;
            const locked = !this.has2DContent();
            btn.disabled = locked && this.renderMode === '3d';
            btn.title = btn.disabled ? '3D only - this scene has no 2D geometry' : 'Toggle 2D/3D View (F2)';
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
         * artifact pulls the view into 3D, nothing pushes it back out. Render
         * mode belongs to the session, not the node, so F2 and has2DContent
         * stay the only ways back.
         * @param {?string} artifact 'offsets' | 'preview' | 'toolpath' | null
         * @param {?Object} operation the operation the node belongs to
         */
        async setViewportForNode(artifact, operation = null) {
            const dimension = operation ? this.registry?.dimensionFor(operation.type, this.core.machineClassOf(operation)) : null;
            const want3D = 'toolpath' === artifact || '3d' === dimension;
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
            // The model and the 2D mirror sit on the cut surface; the stock box
            // can extend past it by Fit's margin.
            const topZ = box ? box.surfaceZ : 0;
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
                const op = layer.operationId ? this.core.store.getOperation(layer.operationId) : layer.name?.startsWith("source_") ? this.core.store.getOperation(layer.name.slice(7)) : null;
                const primitives3d = this.layerPrimitives3D(layer, op);
                defs.push({
                    name: name,
                    primitives: primitives3d,
                    transform: layer.transform || null,
                    zIndex: layer.zIndex || 0,
                    solidWidth: solidWidth,
                    isOffset: "offset" === layer.type || true === layer.isOffset,
                    operationType: layer.operationType || layer.type || null,
                    role: layer.role || null,
                    machineClass: op ? this.core.machineClassOf(op) : this.core.machineClassForType(layer.operationType || layer.type),
                    metadata: layer.metadata || null,
                    color: this.ui.resolveLayerColor(layer)
                });
            }

            // The 2D renderer's resolved theme colours, so status and drill marks
            // match the canvas.
            const colors = this.ui.renderer.colors;
            view.geometry.setLayers(defs, {
                baseZ: topZ,
                worldToMachine: w2m,
                palette: {
                    good: colors.primitives.peckMarkGood,
                    warn: colors.primitives.peckMarkWarn,
                    error: colors.primitives.peckMarkError,
                    slow: colors.primitives.peckMarkSlow,
                    mark: colors.bw.white
                }
            });

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
         * @returns {?{width, depth, thickness, topZ, surfaceZ, centerX, centerY, matrix}}
         *  topZ and thickness describe the drawn box; surfaceZ is the cut
         *  surface the model and the 2D mirror sit on.
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

        /** Hook: the primitives the 3D mirror draws for one 2D layer. */
        layerPrimitives3D(layer, op) {
            return layer.primitives;
        }

        // ════════════════════════════════════════════════════════════════
        // Shared Shortcut Registration
        // ════════════════════════════════════════════════════════════════

        registerSharedShortcuts() {
            window.addEventListener('themechange', () => {
                if (!this.renderer3D) return; // REVIEW - Is this safety check necessary?
                this.renderer3D.setOptions(this.buildRenderer3DOptions());
                this.refresh3D();
            });
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
                showHelp: () => this.modalManager.showModal("help"),
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
            if (this.modalManager.activeModal) return;

            // The viewport zone is whichever surface is live. The hidden one
            // cannot take focus, and its _zoneMemory entry must not be picked.
            const viewportId = this.renderMode === '3d' ? 'viewport-3d' : 'preview-canvas';
            const zones = ['cam-toolbar', 'sidebar-left', viewportId, 'sidebar-right'];

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

            if (!landed) return;
            // REVIEW - This bit of code looks funky? Is this redundant?
            const fallback = {
                'cam-toolbar': 'Toolbar',
                'sidebar-left': 'Left panel',
                'preview-canvas': 'Canvas',
                'viewport-3d': '3D viewport',
                'sidebar-right': 'Properties'
            };
            const name = nextZoneEl.getAttribute('aria-label') || fallback[nextId] || nextId;
            this.ui.setStatus(`${name} focused`, 'info', true);
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
            this.modalManager.showWarning(title, message, {
                confirmText,
                cancelText: 'Cancel',
                onConfirm: () => { onConfirm(); restore(); },
                onCancel: restore
            });
        }

        /** Subclasses override for escape behavior */
        handleEscapeKey(e) {}

        /** Hook: puts keyboard focus back on the app's tree after a sidebar action or Escape. */
        returnFocusToTree() {}

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
            if (D.debug.enabled) this.registry.validate(); // Keep behind D.debig.enabled to avoid spam
            this.core.setRegistry(this.registry);

            this.appProfile = data;
            this.core.appProfile = data;
            return data;
        }

        async initGraphicsExporter() {
            const exporter = new GraphicsExporter();
            this.core.graphicsExporter = exporter;
            if (typeof EMBEDDED_LASER_PROFILES !== 'undefined') {
                exporter.setProfiles(EMBEDDED_LASER_PROFILES);
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
            if (data) exporter.setProfiles(data);
        }

        // ════════════════════════════════════════════════════════════════
        // Pipeline State
        // ════════════════════════════════════════════════════════════════

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

        // ════════════════════════════════════════════════════════════════
        // Export Coordination
        // ════════════════════════════════════════════════════════════════

        /** The one way into the Export Manager: toolbar and every output stage. */
        openExportManager() {
            const operations = this.core.operations.filter(op => this.core.store.isExportReady(op));
            if (operations.length === 0) {
                this.ui.setStatus('No operations ready for export. Generate each operation up to its output stage first.', 'warning');
                return;
            }
            this.prepareExport(operations);
            this.modalManager.showModal('exportManager', { operations });
        }

        /** Hook: runs before the Export Manager reads the operations' parameters. */
        prepareExport(operations) {}

        /**
         * Per-operation plans, for the toolpath stage and the 3D view.
         */
        async computeToolpaths(operationId, options = {}) {
            return this.core.computeToolpaths(operationId, this.parameterStore, options);
        }

        /**
         * Generates every planned file on the engine, then delivers them - one
         * by one, or as a single .zip when the intent asks for it and there is
         * more than one. Delivery is a browser fact, which is why this half is
         * not on CamCore.
         * @returns {Promise<{success: boolean, message: string,
         *  failures: Array<{filename: string, reason: string}>}>}
         */
        async executeExports(intent) {
            const { plan, files, failures } = await this.core.buildExportFiles(intent, this.parameterStore);
            const skipped = failures.map((f) => `${f.filename} (${f.reason})`).join(', ');
            if (files.length === 0) {
                return {
                    success: false,
                    failures,
                    message: skipped ? `Nothing exported - ${skipped}` : 'No files generated.',
                };
            }
            const archiveName = intent.zip && files.length > 1 ? `${plan.baseName}.zip` : null;
            await this.deliverFiles(files, archiveName);
            const written = archiveName
                ? `${archiveName} (${files.length} files)`
                : files.length === 1
                  ? files[0].filename
                  : `${files.length} files`;
            return {
                success: true,
                failures,
                message: skipped ? `Exported ${written}. Skipped: ${skipped}` : `Exported ${written}.`,
            };
        }

        /**
         * Safari serialises programmatic downloads and drops everything after
         * the first unless they are paced. An archive is one download, so it
         * needs no pacing anywhere.
         */
        async deliverFiles(files, archiveName = null) {
            if (archiveName) {
                this.triggerDownload(await ZipWriter.build(files), archiveName);
                return;
            }
            for (const file of files) {
                this.triggerDownload(file.blob, file.filename);
                if (this.pacesDownloads) await new Promise(res => setTimeout(res, 500));
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

        /**
         * Replaces the workspace with one of the profile's examples. Files are
         * fetched as bytes, so binary formats survive; each app's processFile
         * decodes what it needs.
         */
        async loadExample(exampleId) {
            const example = this.getExamples()?.[exampleId];
            if (!example) {
                this.ui.setStatus(`Example not found: ${exampleId}`, 'error');
                return;
            }
            this.ui.setStatus(`Loading example: ${example.name}...`, 'info');
            this.clearWorkspace();
            for (const [type, filepath] of Object.entries(example.files || {})) {
                const name = filepath.split('/').pop();
                try {
                    const response = await fetch(filepath);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    await this.processFile(new File([await response.arrayBuffer()], name), type);
                } catch (e) {
                    console.error(`Failed to load example file ${filepath}:`, e);
                    this.ui.setStatus(`Failed to load ${name}: ${e.message}`, 'error');
                }
            }
            this._hasFitted3DOnce = false;
            this.ui.setStatus(`Example '${example.name}' loaded successfully.`, 'success');
            await this.ui.rebuildLayers();
            this.ui.zoomFit();
            this.ui.renderer.render();
        }

        /** Hook: empties the workspace before an example loads. */
        clearWorkspace() {}

        // ════════════════════════════════════════════════════════════════
        // UI Wiring
        // ════════════════════════════════════════════════════════════════

        hideLoadingOverlay(delay = 300) {
            const overlay = document.getElementById('loading-overlay');
            if (overlay) setTimeout(() => overlay.classList.add('is-hidden'), delay);
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

        setupSharedToolbarButtons() {
            const onClick = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);
            this.setupToolbarDropdown('quick-actions-btn', 'quick-actions-menu');
            onClick('zoom-fit-btn', () => this.ui.zoomFit());
            onClick('zoom-in-btn', () => this.ui.zoomIn());
            onClick('zoom-out-btn', () => this.ui.zoomOut());
            onClick('btn-help', () => this.modalManager.showModal('help'));
            onClick('btn-toggle-3d', () => this.toggle3DMode());
            onClick('dismiss-viewport-bar', () => {
                document.getElementById('workspace-viewport-bar')?.classList.add('dismissed');
            });
            onClick('toolbar-export-manager', () => {
                this.closeDropdown();
                this.openExportManager();
            });
            onClick('toolbar-export-canvas', () => {
                this.closeDropdown();
                try {
                    const svg = this.ui.canvasExporter.buildCanvasSVG();
                    if (!svg) {
                        this.ui.setStatus('Nothing on the canvas to export', 'warning');
                        return;
                    }
                    this.triggerDownload(new Blob([svg], { type: 'image/svg+xml' }), 'EasyCAM5000-CanvasContents.svg');
                    this.ui.setStatus('Canvas exported successfully', 'success');
                } catch (error) {
                    console.error('Canvas export error:', error);
                    this.ui.setStatus('Canvas export failed: ' + error.message, 'error');
                }
            });
        }

        // Lazy 3D mount: nothing loads until requested. Stock, 2D geometry
        // and relief meshes flow in through refresh3D() so the view can
        // never go stale. Machine-ready plans are not mirrored here - the
        // export path owns toolpath generation.
        // Concurrent callers share one in-flight mount, so a second F2 or a
        // node selection during a slow first mount cannot create a second
        // renderer, GPU device and canvas.
        async open3DPreview(container) {
            if (!this._mount3D) {
                this._mount3D = (async () => {
                    if (!window.Renderer3D) await import("../renderer3d/renderer3d-core.js");
                    const view = await window.Renderer3D.mount(container, {
                        ...this.buildRenderer3DOptions(),
                        // Device loss is raised by the browser or GPU driver (driver
                        // reset, GPU switch, browser bug). Reporting it is the whole
                        // handling.
                        onDeviceLost: (info) => this.ui.setStatus(
                            `3D view lost its GPU device (${info.message}). Reloading the page may or may not restore it.`, 'error')
                    });
                    await view.attachOrbitTool({ onPick: hit => this.on3DPick(hit) });
                    this.renderer3D = view;
                    return view;
                })();
                // A failed mount must not block the next attempt.
                this._mount3D.catch(() => { this._mount3D = null; });
            }
            return this._mount3D;
        }

        // 3D palette from the theme.
        // REVIEW - This needs to be implemented in the same way 2d rendering does it.
        buildRenderer3DOptions() {
            const v = name => this.ui.readCSSVar(name);
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
    }

    ROOT.CamController = CamController;
})();