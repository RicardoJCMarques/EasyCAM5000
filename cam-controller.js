/*!
 * @file        cam-controller.js
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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

    class CamController {
        constructor() {
            this.core = null;
            this.ui = null;
            this.parameterManager = null;
            this.gcodeGenerator = null;
            this.appProfile = null;
            this.languageManager = null;
            this.modalManager = null;
            this.shortcutManager = null;

            this.pipelineState = { type: 'cnc', laser: null };
            this.activeDropdown = null;

            this.initState = {
                coreReady: false,
                uiReady: false,
                wasmReady: false,
                fullyReady: false,
                error: null
            };
        }

        // ════════════════════════════════════════════════════════════════
        // Shared Initialization Sequence
        // ════════════════════════════════════════════════════════════════

        async initialize() {
            const appLabel = this.getAppLabel?.() || 'App';
            console.log(`${appLabel} initializing...`);

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
                this.initPipelineComponents();
                this.registerHandlers();
                this.core.settings = this.core.loadSettings(this.storageKeys.settings, this.appProfile);
                this.syncPipelineFromSettings();

                // UI
                this.ui = this.createUI();
                this.ui.lang = this.languageManager;
                const uiReady = await this.ui.init();
                this.initState.uiReady = uiReady;
                if (!uiReady) throw new Error('UI initialization failed');
                this.modalManager = new ModalManager(this);

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
                this.registerSharedShortcuts();
                this.registerAppShortcuts();
                this.onBindEvents();

                // Finalize
                this.onFinalize();
                this.hideLoadingOverlay();
                this.initState.fullyReady = true;
                this.ui.setStatus(this.appProfile?.ui?.text?.statusReady || 'Ready');
                console.log(`${appLabel} ready`);

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

        /** Register operation handlers on this.core */
        registerHandlers() {}

        /** Register app-specific keyboard shortcuts */
        registerAppShortcuts() {}

        // ════════════════════════════════════════════════════════════════
        // Optional hooks - subclasses MAY override
        // ════════════════════════════════════════════════════════════════

        /** Extra core setup after initCore (scene refs, history, stock) */
        onCoreReady() {}

        /** After WASM loads (e.g. laser visibility) */
        onPostWASM() {}

        /** Wire app-specific DOM events (toolbar, file drops, etc) */
        onBindEvents() {}

        /** Final render pass, show welcome, assign window globals */
        onFinalize() {}

        // ════════════════════════════════════════════════════════════════
        // Shared Shortcut Registration
        // ════════════════════════════════════════════════════════════════

        registerSharedShortcuts() {
            const sm = this.shortcutManager;

            // View
            sm.register('f',     () => this.ui.zoomFit());
            sm.register('Home',  () => this.ui.zoomFit());
            sm.register('=',     () => this.ui.zoomFit());
            sm.register('+',     () => this.ui.zoomIn());
            sm.register('-',     () => this.ui.zoomOut());

            // Grid
            sm.register('g', () => {
                if (this.ui.renderer) {
                    const t = document.getElementById('show-grid');
                    if (t) { t.checked = !t.checked; t.dispatchEvent(new Event('change', { bubbles: true })); }
                    else this.ui.renderer.setOptions({ showGrid: !this.ui.renderer.options.showGrid });
                }
            });

            // Escape
            sm.register('Escape', (e) => this.handleEscapeKey(e));

            // Help
            sm.register('F1', () => this.modalManager?.showModal('help'));

            // Focus zones
            sm.register('F6', (e) => this.cycleFocusZone(e.shiftKey ? -1 : 1));
        }

        // ════════════════════════════════════════════════════════════════
        // Focus Zone Cycling
        // ════════════════════════════════════════════════════════════════

        cycleFocusZone(direction) {
            if (this.modalManager?.activeModal) return;

            // Define the sequence directly where it's used
            const zones = ['cam-toolbar', 'sidebar-left', 'preview-canvas', 'sidebar-right'];
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
            const remembered = this._zoneMemory.get(nextId);
            if (remembered && document.body.contains(remembered)) {
                remembered.focus();
            } else {
                const target = nextZoneEl.querySelector(
                    '[tabindex="0"]:not(canvas), button:not([disabled]), input:not([disabled]), select:not([disabled])'
                );
                if (target) target.focus();
            }
        }

        /** Subclasses override for escape behavior */
        handleEscapeKey(e) {}

        // ════════════════════════════════════════════════════════════════
        // Core Initialization
        // ════════════════════════════════════════════════════════════════

        initCore() {
            this.core = new CamCore();
            this.parameterManager = new ParameterManager(this.core);
            this.core.setPipelineType(this.pipelineState.type);
            if (typeof ToolLibrary !== 'undefined') {
                this.toolLibrary = new ToolLibrary();
            }
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

            if (data.parameters) this.parameterManager.setDefinitions(data.parameters);
            if (data.fileTypes) this.core.setFileTypes(data.fileTypes);
            this.appProfile = data;
            this.core.appProfile = data;
            return data;
        }

        initGCodeGenerator(languageManager) {
            if (typeof GCodeGenerator === 'undefined') return;
            this.gcodeGenerator = new GCodeGenerator(D.gcode);
            this.gcodeGenerator.setCore(this.core);
            if (languageManager) this.gcodeGenerator.setLanguageManager(languageManager);
            this.core.setGCodeGenerator(this.gcodeGenerator);
        }

        async initToolLibrary() {
            if (!this.toolLibrary) return;
            await this.toolLibrary.init(this.appProfile);
            if (this.core.setToolLibrary) this.core.setToolLibrary(this.toolLibrary);
        }

        initPipelineComponents() { this.core.initializePipeline(); }

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
                if (result) console.log('Clipper2 WASM modules loaded successfully');
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

        setPipeline(type, laserConfig = null) {
            this.pipelineState = { type, laser: laserConfig };
            if (this.core) {
                this.core.setPipelineType(type);
                this.core.updateSettings('pipeline', { type, laser: laserConfig });
            }
            this.debug(`Pipeline set: ${type}`, laserConfig);
            return this.pipelineState;
        }

        syncPipelineFromSettings() {
            const saved = this.core?.settings?.pipeline;
            if (saved && ['cnc', 'laser', 'hybrid'].includes(saved.type)) {
                this.pipelineState = { type: saved.type, laser: saved.laser || null };
                if (this.core) this.core.setPipelineType(saved.type);
                this.debug('Restored pipeline from settings:', this.pipelineState);
            }
        }

        isLaserPipeline() {
            return this.pipelineState.type === 'laser' || this.pipelineState.type === 'hybrid';
        }

        isLaserExportForOperation(operationType) {
            if (operationType === 'stencil') return false;
            if (this.pipelineState.type === 'laser') return true;
            if (this.pipelineState.type === 'hybrid') {
                return operationType === 'isolation' || operationType === 'clearing';
            }
            return false;
        }

        // ════════════════════════════════════════════════════════════════
        // Export Coordination
        // ════════════════════════════════════════════════════════════════

        async calculateToolpaths(intent) {
            return this.core.generateCNCResults(intent, this.parameterManager);
        }

        async executeExports(intent) {
            const cncOperationIds = [];
            const laserOperationIds = [];
            const stencilOperationIds = [];

            for (const id of intent.operationIds) {
                const op = this.core.getOperation(id);
                if (!op) continue;
                if (op.type === 'stencil') stencilOperationIds.push(id);
                else if (this.isLaserExportForOperation(op.type)) laserOperationIds.push(id);
                else cncOperationIds.push(id);
            }

            return this.core.executeExport({
                ...intent,
                cncOperationIds,
                laserOperationIds,
                stencilOperationIds
            }, this.parameterManager);
        }

        // ════════════════════════════════════════════════════════════════
        // Example Loading
        // ════════════════════════════════════════════════════════════════

        getExamples() {
            return this.appProfile?.examples || {};
        }

        // ════════════════════════════════════════════════════════════════
        // UI Wiring
        // ════════════════════════════════════════════════════════════════

        hideLoadingOverlay(delay = 300) {
            const overlay = document.getElementById('loading-overlay');
            if (overlay) setTimeout(() => overlay.classList.add('is-hidden'), delay);
        }

        initializeTheme() {
            const key = window.CAMConfig.constants.storageKeys.theme;
            const savedTheme = localStorage.getItem(key) || 'dark';
            document.documentElement.setAttribute('data-theme', savedTheme);
            return savedTheme;
        }

        setupToolbarDropdown(btnId, menuId) {
            const btn = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            if (!btn || !menu) return { close() {} };

            btn.setAttribute('aria-haspopup', 'true');
            btn.setAttribute('aria-expanded', 'false');
            menu.setAttribute('role', 'menu');
            menu.querySelectorAll('.menu-item').forEach(item => item.setAttribute('role', 'menuitem'));
            const close = () => {
                btn.classList.remove('active');
                btn.setAttribute('aria-expanded', 'false');
                menu.classList.remove('show');
            };

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const expanded = btn.classList.toggle('active');
                btn.setAttribute('aria-expanded', String(expanded));
                menu.classList.toggle('show');
            });

            document.addEventListener('click', (e) => {
                if (!menu.classList.contains('show')) return;
                if (!btn.contains(e.target) && !menu.contains(e.target)) close();
            });

            menu.addEventListener('click', (e) => e.stopPropagation());

            this.activeDropdown = { close };
            return this.activeDropdown;
        }

        closeDropdown() {
            if (this.activeDropdown) this.activeDropdown.close();
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

        /**
         * Builds { operation, context } pairs for the toolpath pipeline.
         * @param {Array<string>} [operationIds] - defaults to every export-ready op
         */
        // REVIEW - this seems redundant? Look for all links to controller buildOperationContextPairs and just point to core buildOperationContextPairs?
        buildOperationContextPairs(operationIds = null) {
            return this.core.buildOperationContextPairs(
                operationIds, this.parameterManager, { warnLabel: '3D preview' });
        }

        // Lazy 3D mount: nothing loads until requested. Data (stock, 2D
        // geometry, relief meshes, machine-ready plans) flows in through
        // refresh3D() / refresh3DPlans() so the view can never go stale.
        async open3DPreview(container) {
            if (!window.Renderer3D) {
                await import('../renderer3d/renderer3d-core.js');
            }
            if (!this.renderer3D) {
                this.renderer3D = await window.Renderer3D.mount(
                    container, this.buildRenderer3DOptions());
                await this.renderer3D.attachOrbitTool({
                    onPick: (hit) => this.on3DPick?.(hit)
                });
            }
            return this.renderer3D;
        }

        /**
         * 3D palette from the theme. Read once at mount - the view has no
         * re-theme path yet, so a toggle while it is open keeps the old colours
         * until it is disposed.
         */
        // REVIEW - This needs to be implemented in the same way 2d rendering does it.
        buildRenderer3DOptions() {
            const v = (name, fallback) => this.ui.readCSSVar(name, fallback);
            return {
                background: v('--color-render3d-background', '#16181c'),
                gridColor: v('--color-render3d-grid', '#2a2e34'),
                gridCenterColor: v('--color-render3d-grid-center', '#3a3f46'),
                rapidColor: v('--color-render3d-rapid', '#565b63'),
                cutColorShallow: v('--color-render3d-cut-shallow', '#4fc3f7'),
                cutColorDeep: v('--color-render3d-cut-deep', '#e07a7a'),
                stockColor: v('--color-render3d-stock', '#8a7a5c'),
                surfaceColor: v('--color-render3d-surface', '#b0a58e')
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

        isReady() { return this.initState.fullyReady; }

        getStats() {
            return {
                initialization: this.initState,
                core: this.core?.getStats?.() || null,
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

        enableDebug() { debugState.enabled = true; console.log('Debug mode enabled'); }
        disableDebug() { debugState.enabled = false; console.log('Debug mode disabled'); }
    }

    window.CamController = CamController;
})();