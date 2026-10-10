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

    const decimals = window.CAMConfig.defaults.geometry.decimals.coordinates;

    class BaseAppUI {
        constructor(ctrl) {
            this.ctrl = ctrl;
            this.core = ctrl.core;
            this.lang = null;

            this.renderer = null;
            this._rebuildPending = false;
            this._rebuildQueued = false;
            this.input = null;
            this.toolController = null;
            this.canvasReadout = null;

            this.statusManager = null;
            this.controls = null;
            this.canvasExporter = null;

            // Origin the offset fields measure from; see bindOriginFields.
            this.committedOrigin = { x: 0, y: 0 };
            this.originFields = null;

            // Resolved custom properties, cleared whenever the theme changes.
            // getComputedStyle forces a style recalc and resolveLayerColor runs
            // once per layer per rebuildLayers.
            this._cssVarCache = new Map;
            window.addEventListener('themechange', () => { this._cssVarCache.clear(); this.onThemeChanged(); });
        }

        /**
         * Shared init sequence. The order is the dependency order: the renderer
         * exists before anything reads it, and machine settings render before
         * the panels that gate against them.
         */
        async initShared() {
            this.initRenderer();
            this.initViewportInteraction();

            this.statusManager = new StatusManager(this);
            this.controls = new UIControls(this);
            this.controls.init(this.renderer);

            this.renderMachineSettings();

            UIControls.setupCollapsibles(document);
            UIControls.setupArrowSidebarNav('#sidebar-right');

            this.initStaticTooltips();
            this.watchDecorativeIcons();
        }

        initRenderer() {
            this.renderer = new RendererCore('preview-canvas', this.core);
            this.renderer.setOptions({
                primitiveFilter: (prim, layerType) => this.shouldRenderPrimitive(prim, layerType),
                resolveLayerColor: (layer) => this.resolveLayerColor(layer),
            });
            this.renderer.onRenderOverlay = (ctx, core) => this.renderOverlay(ctx, core);

            const parent = this.renderer.canvas.parentElement;
            if (parent) {
                new ResizeObserver(() => {
                    if (this.renderer.resizeCanvas()) this.renderer.renderNow();
                }).observe(parent);
            }

            // A pixel-ratio change with no CSS size change (window moved to another
            // monitor) reaches no observer. The query only matches the current
            // ratio, so it is re-armed with the new one on every change.
            const watchPixelRatio = () => {
                matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
                    if (this.renderer.resizeCanvas()) this.renderer.renderNow();
                    this.ctrl.renderer3D?.requestRender();
                    watchPixelRatio();
                }, { once: true });
            };
            watchPixelRatio();
            this.renderer.render();
            this.canvasExporter = new CanvasExporter(this.renderer);
        }

        /** Subclasses override */
        shouldRenderPrimitive(primitive, layerType) { return true; }
        renderOverlay(ctx, core) {}

        initViewportInteraction() {
            const canvas = document.getElementById('preview-canvas');

            this.canvasReadout = new CanvasReadout(this.renderer);
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

        /**
         * Where each machine-settings category mounts. An app that gives a
         * category its own panel gets it there; everything else goes to
         * #machine-controls. Read by the render and by the visibility pass.
         */
        machineHosts() {
            const hosts = { default: document.getElementById('machine-controls') };
            const stock = document.getElementById('stock-fields');
            if (stock) hosts.stock = stock;
            return hosts;
        }

        renderMachineSettings() {
            const hosts = this.machineHosts();
            if (!hosts.default) return;
            const ps = this.ctrl.parameterStore;
            const rend = this.ctrl.inputRenderer;
            const gen = this.core.gcodeGenerator;
            const lasers = this.core.graphicsExporter;
            const post = this.core.settings.gcode.postProcessor;
            const postDesc = gen.getProcessorInfo(post);
            // No active profile is legitimate: an app removes every laser.* entry
            // in its profile, and deviceSchema contributes nothing for a null.
            const laserDesc = lasers.getProfileInfo(this.core.settings.laser?.activeProfile);

            // machineSchema applies the app's deltas per entry, so a profile that
            // only overrides `default` keeps the type, category, unit and bounds.
            // A device's own settings are spliced in at the picker that chose it:
            // the Roland model dropdown is a refinement of "which post", and
            // reading it three fields below the start-code textarea makes no sense.
            const schema = {};
            for (const [path, def] of Object.entries(this.core.machineSchema(this.ctrl.appProfile))) {
                schema[path] = def;
                if (path === 'gcode.postProcessor') Object.assign(schema, ps.deviceSchema(postDesc, 'processorSettings', ['router']));
                if (path === 'laser.activeProfile') Object.assign(schema, ps.deviceSchema(laserDesc, 'laserSettings', ['laser']));
            }

            const label = v => this.lang.get(`enums.${v}`, v);
            const sources = {
                processors: gen.getAllProcessorDescriptors().map(d => ({ value: d.id, label: d.label })),
                laserProfiles: lasers.getAllProfileDescriptors().map(d => ({ value: d.id, label: d.label })),
                tlcModes: (postDesc?.capabilities?.toolLengthComp?.modes || []).map(m => ({ value: m, label: label(m) })),
                rotaryRoutes: (postDesc?.capabilities?.rotary?.routes || []).map(r => ({ value: r, label: label(r) }))
            };
            const resolvers = {
                startCode: () => gen.resolveStartCode(post, this.core.settings.gcode.userStartCode),
                endCode: () => gen.resolveEndCode(post, this.core.settings.gcode.userEndCode)
            };
            rend.renderSettingsForm(hosts, schema, {
                sources, resolvers, lang: this.lang,
                categoryTitle: c => this.ctrl.appProfile?.ui?.categories?.[c] || c,
                onChange: (name, value, param) => this.onSettingCascade(name, value, param)
            });
            this.refreshMachineSettings();
        }

        /** The app's operation panel for shared code to refresh; null until the app builds it. */
        get operationPanel() {
            return null;
        }

        /**
         * Visibility and capability gates. Called on all settings edit; that
         * does not change which fields exist, so it never re-renders.
         */
        refreshMachineSettings() {
            const hosts = this.machineHosts();
            if (!hosts.default) return;
            const ps = this.ctrl.parameterStore;
            const rend = this.ctrl.inputRenderer;
            const post = this.core.settings.gcode.postProcessor;

            // The pipeline declaration is the truth, not what happens to be
            // loaded: fiber pins isolation and clearing to the laser while the
            // session class stays 'router', so both blocks must show.
            const classes = new Set([this.core.machineClass, ...Object.values(this.core.classByType || {})]);
            for (const op of this.core.operations) classes.add(this.core.machineClassOf(op));

            const gates = ps.setOptionGates(this.core.gcodeGenerator.getOptionGates(this.core.settings));
            const visibility = {
                caps: this.core.gcodeGenerator.getProcessorInfo(post)?.capabilities || {},
                classes,
                owners: { processorSettings: post, laserSettings: this.core.settings.laser?.activeProfile }
            };
            for (const host of Object.values(hosts)) {
                rend.applyOptionGates(host, gates);
                rend.applyVisibility(host, visibility);
            }
            this.operationPanel?.refresh();
        }

        /**
         * A device may declare that one of its settings implies others. Nothing
         * here names a device: the post or laser profile answers for itself.
         */
        onSettingCascade(name, value, param) {
            if (param.owner) {
                const device =
                    this.core.gcodeGenerator.getProcessor(param.owner) ||
                    this.core.graphicsExporter.getProfileInfo(param.owner);
                const patch = device?.onParameterChange?.(name, value);
                if (patch) {
                    for (const [k, v] of Object.entries(patch)) {
                        this.core.setSetting(`${param.namespace || 'processorSettings'}.${param.owner}.${k}`, v);
                    }
                    this.renderMachineSettings();
                    return;
                }
            } else if ('postProcessor' === name || 'activeProfile' === name) {
                this.renderMachineSettings();
                this.rebuildLayers();
                // A laser profile only styles the exported file; a post changes the program.
                if ('postProcessor' === name) {
                    this.setStatus(
                        `Switched to ${value}. Recalculate toolpaths to apply changes.`,
                        'warning'
                    );
                }
                return;
            }
            this.refreshMachineSettings();
        }

        /**
         * Sprite icons are decorative next to their own text label. Left
         * unmarked, an inline <svg> is exposed as a graphics object by several
         * screen readers, so every button reads its label twice.
         *
         * An observer rather than a call at each render site: icons are
         * injected from tree rows, stage nodes, tabs, the drill grid and the
         * log, and a call list goes stale the first time a panel gains one.
         */
        watchDecorativeIcons() {
            const mark = (root) => {
                if (root.nodeType !== 1) return;
                if (root.matches?.('svg.cam-icon:not([aria-hidden]):not([role="img"])')) {
                    root.setAttribute('aria-hidden', 'true');
                    root.setAttribute('focusable', 'false');
                }
                root.querySelectorAll?.('svg.cam-icon:not([aria-hidden]):not([role="img"])')
                    .forEach(svg => {
                        svg.setAttribute('aria-hidden', 'true');
                        svg.setAttribute('focusable', 'false');
                    });
            };

            mark(document.body);

            new MutationObserver(records => {
                for (const r of records) r.addedNodes.forEach(mark);
            }).observe(document.body, { childList: true, subtree: true });
        }

        // ═══════════════════════════════════════════════════════════════
        // Origin offset fields (both apps)
        // ═══════════════════════════════════════════════════════════════
        /**
         * Binds two inputs to the pending origin offset: they show the offset
         * from the committed origin, typing previews it, Enter commits it.
         */
        bindOriginFields(xId, yId) {
            const x = document.getElementById(xId);
            const y = document.getElementById(yId);
            if (!x || !y) return;
            const scene = this.core.scene;
            this.originFields = { x, y };
            this.committedOrigin = { ...scene.transform.origin };
            const preview = () => {
                scene.setOrigin(
                    this.committedOrigin.x + (parseFloat(x.value) || 0),
                    this.committedOrigin.y + (parseFloat(y.value) || 0)
                );
                this.renderer.render();
            };
            for (const input of [x, y]) {
                input.removeAttribute('readonly');
                input.addEventListener('input', preview);
                input.addEventListener('keypress', e => {
                    if (e.key !== 'Enter') return;
                    preview();
                    this.commitOrigin();
                });
            }
            scene.addTransformListener(() => this.syncOriginFields());
            this.syncOriginFields(true);
        }

        /**
         * Writes the pending offset back into the fields. Skips whichever
         * field has focus unless forced: setOrigin fires this on every
         * keystroke through the transform listener, and reformatting mid-edit
         * moves the caret so a second digit can never be typed. A commit
         * forces it, because the field the user just pressed Enter in has to
         * show 0 again.
         */
        syncOriginFields(force = false) {
            if (!this.originFields) return;
            const { x, y } = this.originFields;
            const o = this.core.scene.transform.origin;
            const active = document.activeElement;
            if (force || active !== x) x.value = (o.x - this.committedOrigin.x).toFixed(decimals);
            if (force || active !== y) y.value = (o.y - this.committedOrigin.y).toFixed(decimals);
        }

        /** Makes the current origin the committed one; a null message commits silently. */
        commitOrigin(message = 'Origin saved at current position') {
            this.committedOrigin = { ...this.core.scene.transform.origin };
            this.syncOriginFields(true);
            if (message) this.setStatus(message, 'success');
        }

        revertOrigin() {
            this.core.scene.setOrigin(this.committedOrigin.x, this.committedOrigin.y);
            this.syncOriginFields(true);
            this.renderer.render();
            this.setStatus('Reset to saved origin', 'info');
        }

        // Status

        setStatus(message, type, skipLog = false) {
            if (this.statusManager) {
                this.statusManager.updateStatus(message, type || 'normal', skipLog);
            } else {
                console.warn('[UI] StatusManager not available:', message);
            }
        }

        /**
         * Viewport controls, shared by the toolbar buttons and the keyboard
         * shortcuts registered in CamController. In 3D the camera owns fit and
         * zoom, so those requests go to the 3D view instead.
         * No optional chaining past `renderer`: RendererCore declares zoomFit,
         * zoomIn, zoomOut and the readout, and a `?.` here spent two sessions
         * turning a dead property into a button that did nothing quietly.
         */
        zoomFit() {
            if (this.ctrl.renderMode === '3d') {
                this.ctrl.renderer3D?.fitToContent();
                return;
            }
            this.renderer.zoomFit(true);
            this.renderer.render();
            this.canvasReadout.updateZoom();
        }

        zoomIn() {
            if (this.ctrl.renderMode === '3d') {
                this.ctrl.renderer3D?.orbitTool.dolly(window.CAMConfig.constants.renderer.zoom.factor);
                return;
            }
            this.renderer.zoomIn();
            this.renderer.render();
            this.canvasReadout.updateZoom();
        }

        zoomOut() {
            if (this.ctrl.renderMode === '3d') {
                this.ctrl.renderer3D?.orbitTool.dolly(1 / window.CAMConfig.constants.renderer.zoom.factor);
                return;
            }
            this.renderer.zoomOut();
            this.renderer.render();
            this.canvasReadout.updateZoom();
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
         * A theme swap invalidates three caches, and only one of them repaints:
         * this memo, RendererCore.colors (its own listener refreshes the values
         * but cannot repaint), and whatever the canvas last painted. Refreshing
         * the renderer palette explicitly rather than relying on its listener
         * keeps this independent of registration order.
         */
        onThemeChanged() {
            this.renderer.updateThemeColors();
            this.renderer.render();
        }

        /**
         * The one render funnel. Both apps clear, rebuild from their own source
         * of truth, mirror into 3D and repaint - only the middle step differs,
         * and that is collectLayers().
         * Coalesced: a rebuild requested during a rebuild runs once more on the
         * next frame instead of stacking. EasyTrace's fusion path is async and
         * several UI events fire together.
         */
        async rebuildLayers() {
            if (this._rebuildPending) { this._rebuildQueued = true; return; }
            this._rebuildPending = true;
            try {
                this.renderer.clearLayers();
                await this.collectLayers();
                this.renderer.render();
                // The 3D view mirrors these layers and goes stale unless it
                // rebuilds from the same funnel.
                this.ctrl.refresh3D();
                this.afterRebuildLayers();
            } finally {
                this._rebuildPending = false;
                if (this._rebuildQueued) {
                    this._rebuildQueued = false;
                    requestAnimationFrame(() => this.rebuildLayers());
                }
            }
        }

        /** Per-app layer population. Overridden in both apps. */
        async collectLayers() {}

        /** Per-app post-rebuild UI sync. EasyTrace refreshes origin and stats. */
        afterRebuildLayers() {}

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
            if (isBW) return this.readCSSVar('--color-bw-white');
            // A stencil's generated geometry is the aperture itself, so it keeps
            // the stencil colour; only its preview reads as a preview.
            if (layer.operationType === 'stencil' || layer.type === 'stencil') {
                if (layer.isPreview || layer.type === 'preview') {
                    return this.readCSSVar('--color-geometry-preview');
                }
                return this.readCSSVar('--color-geometry-source-stencil');
            }
            // Laser fill passes paint the area they burn, not an offset line.
            if (layer.metadata?.strategy === 'filled') {
                return this.readCSSVar('--color-geometry-laser-filled');
            }
            switch (layer.type) {
                case 'offset':
                    if (layer.offsetType === 'external') return this.readCSSVar('--color-geometry-offset-external');
                    if (layer.offsetType === 'internal') return this.readCSSVar('--color-geometry-offset-internal');
                    if (layer.offsetType === 'on') return this.readCSSVar('--color-geometry-offset-on');
                    return '#FF0000';
                case 'preview':
                    return this.readCSSVar('--color-geometry-preview');
                case 'unassigned':
                    return layer.color || this.readCSSVar('--color-text-secondary');
            }
            return null; // signal subclass to handle
        }

        /**
         * Layer rendering order hierarchy across 2D canvas and 3D WebGPU layers
         */
        getLayerZIndex(type, opts = {}) {
            if (opts.isStock || type === 'stock') return 0;

            const isDrill = opts.operationType === 'drill' || type === 'drill';
            const isCutout = opts.operationType === 'cutout' || type === 'cutout';
            const isStencil = opts.operationType === 'stencil' || type === 'stencil';

            // Toolpath Previews (Highest)
            if (opts.isPreview || type === 'preview') return isDrill ? 950 : isCutout ? 920 : 900;

            // Offsets and Generated Toolpaths
            if (opts.isOffset || type === 'offset') {
                if (isDrill) return 850;
                if (isCutout) return 800;
                if (isStencil) return 300;
                if (opts.isHatch || opts.strategy === 'filled') return 450;
                return 500;
            }

            // Source Geometries
            if (isDrill) return 750; // Drills cut through everything
            if (isCutout) return 100; // Cutout source is the board substrate (sits directly on stock, below everything else)
            if (type === 'fused') return 400;
            if (isStencil) return 250;

            return null; // signal subclass to handle (isolation=200, clearing=200, etc.)
        }

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