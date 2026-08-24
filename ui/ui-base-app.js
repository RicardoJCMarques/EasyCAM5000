/*!
 * @file        ui/ui-base-app.js
 * @description Shared base UI core class.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class BaseAppUI {
        constructor(ctrl) {
            this.ctrl = ctrl;
            this.core = ctrl.core;
            this.lang = null;

            this.renderer = null;
            this.input = null;
            this.toolController = null;
            this.canvasReadout = null;

            this.statusManager = null;
            this.controls = null;
            this.machineSettings = null;
            this.canvasExporter = null;

            // Task id for callers that hand a message instead of owning a task
            // (BaseOperationPanel.runGeneration owns its own).
            this._shimTaskId = null; // REVIEW - This looks like a fallback? Couldn't this be guaranteed somewhere else?

            // Resolved custom properties, cleared whenever the theme changes.
            // getComputedStyle forces a style recalc and resolveLayerColor runs
            // once per layer per rebuildLayers.
            this._cssVarCache = new Map();
            window.addEventListener('themechange', () => this._cssVarCache.clear());
        }

        // Shared init sequence

        async initShared() {
            this.initRenderer();
            this.initViewportInteraction();
            this.initStatusManager();
            this.initControls();
            this.initMachineSettings();
            this.initFocusZones();
            this.initResize();
            this.initializeTheme();
            this.initStaticTooltips();
        }

        // Renderer

        initRenderer() {
            this.renderer = new LayerRenderer('preview-canvas', this.core);

            const theme = document.documentElement.getAttribute('data-theme') || 'dark';
            this.renderer.setOptions(this.getDefaultRendererOptions(theme));
            this.renderer.onRenderOverlay = (ctx, core) => this.renderOverlay(ctx, core);

            const parent = this.renderer.canvas.parentElement;
            if (parent) {
                new ResizeObserver(() => {
                    this.renderer.core.resizeCanvas();
                    this.renderer.render();
                }).observe(parent);
            }

            this.renderer.render();
            this.canvasExporter = new CanvasExporter(this.renderer);
        }

        /**
         * Universal renderer options
         */
        getDefaultRendererOptions(theme) {
            return {
                ...window.CAMConfig.defaults.rendering.defaultOptions,
                theme,
                primitiveFilter: (prim, layerType) => this.shouldRenderPrimitive(prim, layerType),
                resolveLayerColor: (layer) => this.resolveLayerColor(layer)
            };
        }

        /** Subclasses override */
        shouldRenderPrimitive(primitive, layerType) { return true; }
        renderOverlay(ctx, core) {}

        // Viewport interaction

        initViewportInteraction() {
            const canvas = document.getElementById('preview-canvas');
            if (!canvas || !this.renderer) return;

            this.canvasReadout = new CanvasReadout(this.renderer.core);
            this.input = new InputManager(canvas, { readout: this.canvasReadout });

            this.toolController = new ToolController(this.buildToolContext(canvas));
            this.toolController.setInputManager(this.input);
            this.toolController.setDefaultTool(this.createDefaultTool());
            this.input.attach(this.toolController);

            canvas.blur();
            document.body.focus();
        }

        /**
         * Subclasses override to provide app-specific tool context.
         * EasyTrace returns a simple pan/zoom context.
         * EasyShape returns a context with scene/selection awareness.
         */
        buildToolContext(canvas) {
            return {
                renderer: this.renderer,
                canvas,
                canvasReadout: this.canvasReadout,
                requestRender: () => this.renderer?.render()
            };
        }

        createDefaultTool() {
            return new PanZoomTool({ allowedButtons: [0, 1, 2] });
        }

        // Status, Controls, Machine, Focus, Theme, Resize
        initStatusManager() {
            this.statusManager = new StatusManager(this);
        }

        initControls() {
            this.controls = new UIControls(this);
            this.controls.init(this.renderer);
        }

        initMachineSettings() {
            this.machineSettings = new MachineSettingsUI(this);
            this.machineSettings.setup();
        }

        // REVIEW - This name is outdated? Rename to something more descriptive?
        initFocusZones() {
            UIControls.setupCollapsibles(document);
            UIControls.setupArrowSidebarNav('#sidebar-right');
        }

        initResize() {
            window.addEventListener('resize', () => {
                if (!this.renderer?.core) return;
                this.renderer.core.resizeCanvas();
                this.renderer.render();
            });
        }

        initializeTheme() {
            const theme = this.ctrl.initializeTheme();
            if (this.renderer) this.renderer.setOptions({ theme });
        }

        // Static Tooltip Scanner

        initStaticTooltips() {
            if (!this.lang || !window.TooltipManager) return;
            const processed = new Set();

            document.querySelectorAll('[data-i18n]').forEach(el => {
                if (processed.has(el)) return;
                processed.add(el);

                const { label, help } = this.lang.entry(el.dataset.i18n);
                if (!help) return;

                window.TooltipManager.attachWithIcon(el,
                    { title: label || el.textContent?.trim() || '', text: help },
                    { showOnFocus: true });
            });
        }

        // Status

        setStatus(message, type, skipLog = false) {
            if (this.statusManager) {
                this.statusManager.updateStatus(message, type || 'normal', skipLog);
            } else {
                console.warn('[UI] StatusManager not available:', message);
            }
        }

        // Zoom helpers

        zoomFit()  { this.renderer?.core?.zoomFit(true); this.renderer?.render(); this.canvasReadout?.updateZoom(); }
        zoomIn()   { this.renderer?.core?.zoomIn(); this.renderer?.render(); this.canvasReadout?.updateZoom(); }
        zoomOut()  { this.renderer?.core?.zoomOut(); this.renderer?.render(); this.canvasReadout?.updateZoom(); }

        // Canvas Spinner

        /**
         * Spinner over the StatusManager task API. Repeated calls relabel the
         * live task instead of stacking.
         */
        showCanvasSpinner(message) {
            const sm = this.statusManager;
            if (sm.isBusy() && this._shimTaskId != null) {
                sm.tick(this._shimTaskId, { label: message });
            } else {
                this._shimTaskId = sm.beginTask(message);
            }
        }

        hideCanvasSpinner() {
            this.statusManager.endTask(this._shimTaskId);
            this._shimTaskId = null;
        }

        // Layer color/z-index resolution

        /**
         * Reads a custom property, memoised until the next 'themechange'.
         * Returns `fallback` when the property is undeclared, so callers can
         * pass null to test for declaration.
         */
        readCSSVar(varName, fallback) {
            let value = this._cssVarCache.get(varName);
            if (value === undefined) {
                value = getComputedStyle(document.documentElement)
                    .getPropertyValue(varName).trim();
                this._cssVarCache.set(varName, value);
            }
            return value || fallback;
        }

       /**
         * Colour for an operation TYPE, from the theme's operation palette.
         * Returns null when the theme has not mapped that type, so callers
         * can fall through to a role colour.
         */
        resolveOperationColor(opType) {
            if (!opType) return null;
            return this.readCSSVar(`--color-operation-${opType}`, null);
        }

        resolveLayerColor(layer) {
            const isBW = this.renderer?.options?.blackAndWhite;
            if (isBW) return this.readCSSVar('--color-bw-white', '#ffffff');

            switch (layer.type) {
                case 'offset':
                    if (layer.offsetType === 'external') return this.readCSSVar('--color-geometry-offset-external', '#a60000');
                    if (layer.offsetType === 'internal') return this.readCSSVar('--color-geometry-offset-internal', '#00a600');
                    if (layer.offsetType === 'on') return this.readCSSVar('--color-geometry-offset-on', '#bcbc02');
                    return '#FF0000';
                case 'preview':
                    return this.readCSSVar('--color-geometry-preview', '#0060dd');
                case 'unassigned':
                    return layer.color || this.readCSSVar('--color-text-secondary', '#a0a0a0');
            }
            return null; // signal subclass to handle
        }

        // REVIEW - Shouldn't this be handled by the renderer modules?
        getLayerZIndex(type, opts = {}) {
            if (opts.operationType === 'stencil' || type === 'stencil') return 250;
            if (opts.isStock || type === 'stock') return 0;
            const isDrill = opts.operationType === 'drill' || type === 'drill';
            switch (type) {
                case 'drill':      return 300;
                case 'fused':      return 400;
                case 'offset':
                    if (opts.isHatch || opts.strategy === 'filled') return 500;
                    return isDrill ? 650 : 600;
                case 'preview':    return isDrill ? 850 : 800;
            }
            return null; // signal subclass to handle
        }

        // Debug

        // REVIEW - debug states need to be centralized
        debug(message, data = null) {
            if (!window.CAMConfig.defaults.debug.enabled) return;
            data ? console.log(`[${this.constructor.name}] ${message}`, data)
                 : console.log(`[${this.constructor.name}] ${message}`);
            if (this.statusManager?.debugLog) {
                let statusMsg = message;
                if (data) {
                    try { statusMsg += ` ${JSON.stringify(data)}`; }
                    catch { statusMsg += ' [Object]'; }
                }
                this.statusManager.debugLog(statusMsg);
            }
        }
    }

    window.BaseAppUI = BaseAppUI;
})();