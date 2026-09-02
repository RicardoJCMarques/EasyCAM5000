/*!
 * @file        easytrace5000/ui-core-trace.js
 * @description EasyTrace5000 UI orchestrator. Extends BaseAppUI for shared
 *              renderer, viewport, status, controls, and theme logic.
 *              Adds Trace-specific panels, fusion, board transforms, tooltips.
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

    class EasyTraceUI extends BaseAppUI {
        constructor(ctrl) {
            super(ctrl);

            this.navTreePanel = null;
            this.traceOperationPanel = null;
            this.canvasExporter = null;
            this.scene = null;
            this.sceneInteraction = null;
            this.updatePending = false;
            this.updateQueued = false;
        }

        async init() {
            try {
                // Shorthand refs - used heavily by board transform controls.
                // core.scene is the canonical owner; these avoid ~30 long-form lookups.
                // REVIEW: EasyShape keeps transform setup in its controller; EasyTrace keeps it here.
                // Target convention: transform wiring lives in ui-core-*, controllers own lifecycle only.
                this.scene = this.core.scene;
                this.sceneInteraction = this.core.sceneInteraction;

                await this.initShared();

                this.initializeSceneListeners();
                this.initTreePanel();
                this.initTraceOperationPanel(this.ctrl.parameterManager);
                this.initBoardTransforms();

                this.debug('EasyTraceUI initialized');
                return true;
            } catch (error) {
                console.error('UI initialization failed:', error);
                this.setStatus('Initialization error: ' + error.message, 'error');
                return false;
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // BaseAppUI Overrides
        // ═══════════════════════════════════════════════════════════════

        getDefaultRendererOptions(theme) {
            // REVIEW - EasyShape doesn't need this, why does EasyTrace?
            const ro = D.rendering.defaultOptions;
            return {
                showWireframe: ro.showWireframe,
                showGrid: ro.showGrid,
                showOrigin: ro.showOrigin,
                showRulers: ro.showRulers,
                fuseGeometry: ro.fuseGeometry,
                blackAndWhite: ro.blackAndWhite,
                debugPoints: ro.debugPoints,
                debugArcs: ro.debugArcs,
                theme,
                primitiveFilter: (prim, layerType) => this.shouldRenderPrimitive(prim, layerType),
                resolveLayerColor: (layer) => this.resolveLayerColor(layer)
            };
        }

        resolveLayerColor(layer) {
            // REVIEW - This looks like a bit of a band-aid but it does work.
            // Stencil offset geometry override
            if (layer.operationType === 'stencil') {
                return this.readCSSVar('--color-geometry-source-stencil');
            }

            const base = super.resolveLayerColor(layer);
            if (base !== null) return base;

            const isBW = this.renderer?.options?.blackAndWhite;
            if (isBW) {
                if (layer.type === 'cutout') return this.readCSSVar('--color-bw-black');
                return this.readCSSVar('--color-bw-white');
            }

            switch (layer.type) {
                case 'isolation': return this.readCSSVar('--color-geometry-source-isolation');
                case 'clearing':  return this.readCSSVar('--color-geometry-source-clearing');
                case 'drill':     return this.readCSSVar('--color-geometry-source-drill');
                case 'cutout':    return this.readCSSVar('--color-geometry-source-cutout');
                case 'stencil':   return this.readCSSVar('--color-geometry-source-stencil');
                case 'fused':     return this.readCSSVar('--color-geometry-source-isolation');
            }
            return layer.color || this.readCSSVar('--color-geometry-source-isolation');
        }

        getLayerZIndex(type, opts = {}) {
            const base = super.getLayerZIndex(type, opts);
            if (base !== null) return base;

            switch (type) {
                case 'isolation':
                case 'clearing':   return 200;
                default:           return 220;
            }
        }

        shouldRenderPrimitive(primitive, layerType) {
            if (primitive.properties?.isFused) return true;
            const role = primitive.properties?.role;
            if (role === 'drill_slot' || role === 'drill_milling_path' || role === 'peck_mark') return true;
            const opts = this.renderer.options;
            if (primitive.properties?.isCutout || layerType === 'cutout') return opts.showCutouts;
            if (primitive.properties?.isRegion) return opts.showRegions;
            if (primitive.properties?.isPad || primitive.properties?.isFlash) return opts.showPads;
            if (primitive.properties?.isTrace || primitive.properties?.stroke) return opts.showTraces;
            return true;
        }

        // ═══════════════════════════════════════════════════════════════
        // Scene Listeners
        // ═══════════════════════════════════════════════════════════════

        initializeSceneListeners() {
            if (!this.scene) { console.warn('[cam-ui] core.scene missing'); return; }
            this.scene.addTransformListener((change) => {
                if (this.renderer) this.renderer.render();
                if (debugState.enabled) this.debug(`[scene] transform change: ${change.action}`);
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Panel Initialization
        // ═══════════════════════════════════════════════════════════════

        initTreePanel() {
            if (typeof NavTreePanel === 'undefined') return;
            this.navTreePanel = new NavTreePanel(this);
            this.navTreePanel.init();

            this.navTreePanel.on('categoryClick', (opType) => this.triggerFileInput(opType));
            this.navTreePanel.on('select', ({ kind, operation, stage }) => {
                if (this.handleOperationSelection) this.handleOperationSelection(operation, stage || 'geometry');
            });
            this.navTreePanel.on('action', ({ id, action, artifactKey, layerName, element }) => {
                if (action === 'delete') { this.removeOperation(id); return; }
                if (action === 'visibility' && element) {
                    this.navTreePanel.toggleLayerVisibility(element, artifactKey, layerName);
                }
            });
            this.navTreePanel.on('deleteGeometry', ({ fileId, geometryId }) => {
                const fileData = this.navTreePanel.nodes.get(fileId);
                const geoData = fileData?.geometries.get(geometryId);
                if (fileData && geoData) this.handleDeleteGeometry(fileId, fileData, geometryId, geoData);
            });
        }

        initTraceOperationPanel(parameterManager) {
            if (typeof TraceOperationPanel !== 'undefined') {
                this.traceOperationPanel = new TraceOperationPanel(this);
                this.traceOperationPanel.init(this.ctrl.toolLibrary, parameterManager);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Board Transforms (origin/rotation/mirror)
        // ═══════════════════════════════════════════════════════════════

        initBoardTransforms() {
            this.committedOrigin = this.scene ? { ...this.scene.transform.origin } : { x: 0, y: 0 };
            this.inputTracking = { lastXValue: '0', lastYValue: '0' };
            this.setupOffsetControls();
            this.setupRotationControls();
            this.setupMirrorControls();
            // REVIEW - is this scene check necessary?
            if (this.scene) this.scene.addTransformListener(() => this.updateOffsetInputsWithTracking());
        }

        setupOffsetControls() {
            const xInput = document.getElementById('x-offset');
            const yInput = document.getElementById('y-offset');
            if (!xInput || !yInput) return;
            xInput.removeAttribute('readonly');
            yInput.removeAttribute('readonly');
            this.inputTracking.lastXValue = xInput.value || '0';
            this.inputTracking.lastYValue = yInput.value || '0';

            const applyPreview = () => {
                if (!this.scene) return;
                this.scene.setOrigin(this.committedOrigin.x + (parseFloat(xInput.value) || 0), this.committedOrigin.y + (parseFloat(yInput.value) || 0));
                this.inputTracking.lastXValue = xInput.value;
                this.inputTracking.lastYValue = yInput.value;
            };
            xInput.addEventListener('input', applyPreview);
            yInput.addEventListener('input', applyPreview);
            const handleEnter = (e) => { if (e.key === 'Enter') { applyPreview(); this.applyOffsetAndSetOrigin(); } };
            xInput.addEventListener('keypress', handleEnter);
            yInput.addEventListener('keypress', handleEnter);

            document.getElementById('center-origin-btn')?.addEventListener('click', () => this.centerOrigin());
            document.getElementById('bottom-left-origin-btn')?.addEventListener('click', () => this.bottomLeftOrigin());
            document.getElementById('reset-origin-btn')?.addEventListener('click', () => this.resetOrigin());
            document.getElementById('apply-set-origin-btn')?.addEventListener('click', () => this.applyOffsetAndSetOrigin());
        }

        setupRotationControls() {
            const rotationInput = document.getElementById('rotation-angle');

            const commitRotation = () => {
                if (!this.scene) return;
                this.scene.setRotation(parseFloat(rotationInput?.value) || 0);
                this.updateOriginDisplay();
                const el = document.getElementById('rotation-angle');
                if (el) el.value = (this.scene.transform.rotation || 0).toFixed(1);
                this.setStatus(`Board rotation set to ${this.scene.transform.rotation.toFixed(1)}°`, 'success');
            };

            if (rotationInput) {
                rotationInput.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') { rotationInput.blur(); commitRotation(); }
                });
            }
            document.getElementById('apply-rotation-btn')?.addEventListener('click', commitRotation);
            document.getElementById('reset-rotation-btn')?.addEventListener('click', () => this.resetBoardRotationOnly());

            // Keep the field on the absolute board angle, except while typing.
            const syncRotation = () => {
                const el = document.getElementById('rotation-angle');
                if (el && this.scene && document.activeElement !== el) {
                    el.value = (this.scene.transform.rotation || 0).toFixed(1);
                }
            };
            if (this.scene) this.scene.addTransformListener(syncRotation);
            syncRotation();
        }

        setupMirrorControls() {
            const toggleX = document.getElementById('mirror-x-toggle');
            const toggleY = document.getElementById('mirror-y-toggle');
            if (toggleX) toggleX.addEventListener('change', (e) => { if (this.scene) { this.scene.setMirrorX(e.target.checked); this.updateOriginDisplay(); this.setStatus(`Horizontal mirror ${e.target.checked ? 'enabled' : 'disabled'}`, 'info'); } });
            if (toggleY) toggleY.addEventListener('change', (e) => { if (this.scene) { this.scene.setMirrorY(e.target.checked); this.updateOriginDisplay(); this.setStatus(`Vertical mirror ${e.target.checked ? 'enabled' : 'disabled'}`, 'info'); } });
            this.syncMirrorCheckboxes();
            if (this.scene) this.scene.addTransformListener(() => this.syncMirrorCheckboxes());
        }

        syncMirrorCheckboxes() {
            if (!this.scene) return;
            const t = this.scene.transform;
            const toggleX = document.getElementById('mirror-x-toggle');
            const toggleY = document.getElementById('mirror-y-toggle');
            if (toggleX && toggleX.checked !== t.mirrorX) toggleX.checked = t.mirrorX;
            if (toggleY && toggleY.checked !== t.mirrorY) toggleY.checked = t.mirrorY;
        }

        centerOrigin() {
            if (!this.scene) return;
            const applied = this.scene.centerOriginOnBoard();
            this.updateOriginDisplay();
            this.setStatus(applied ? 'Preview: Origin at board center (not saved)' : 'Cannot center - no board bounds yet', applied ? 'info' : 'error');
        }

        bottomLeftOrigin() {
            if (!this.scene) return;
            const applied = this.scene.setOriginToBottomLeft();
            this.updateOriginDisplay();
            this.setStatus(applied ? 'Preview: Origin at board bottom-left (not saved)' : 'Cannot set bottom-left - no board bounds yet', applied ? 'info' : 'error');
        }

        applyOffsetAndSetOrigin() {
            if (!this.scene) return;
            this.committedOrigin = { ...this.scene.transform.origin };
            this.updateOffsetInputsWithTracking();
            this.updateOriginDisplay();
            this.setStatus('Origin saved at current position', 'success');
        }

        resetOrigin() {
            if (!this.scene) return;
            this.scene.setOrigin(this.committedOrigin.x, this.committedOrigin.y);
            this.updateOriginDisplay();
            this.setStatus('Reset to saved origin', 'success');
        }

        resetBoardRotationOnly() {
            if (!this.scene) return;
            this.scene.resetRotation();
            this.updateOriginDisplay();
            this.setStatus('Board rotation reset (position unchanged)', 'success');
        }

        updateOffsetInputsWithTracking() {
            const xInput = document.getElementById('x-offset');
            const yInput = document.getElementById('y-offset');
            if (!xInput || !yInput || !this.scene) return;
            const o = this.scene.transform.origin;
            const decimals = D.gcode.decimals.coordinates;
            const xs = (o.x - this.committedOrigin.x).toFixed(decimals);
            const ys = (o.y - this.committedOrigin.y).toFixed(decimals);
            xInput.value = xs;
            yInput.value = ys;
            this.inputTracking.lastXValue = xs;
            this.inputTracking.lastYValue = ys;
        }

        // ═══════════════════════════════════════════════════════════════
        // Renderer layer management
        // ═══════════════════════════════════════════════════════════════

        // REVIEW - Any reason this is named differently than in EasyShape5000?
        async updateRendererAsync() {
            if (this.updatePending) { this.updateQueued = true; return; }
            this.updatePending = true;
            try {
                this.renderer.clearLayers();
                if (this.renderer.options.fuseGeometry) await this.performFusion();
                else this.addIndividualLayers();
                this.addOffsetLayers();
                this.renderer.render();
                // The 3D view mirrors these layers, so it goes stale unless it
                // rebuilds from the same funnel.
                this.ctrl.refresh3D?.();
                this.updateOriginDisplay();
                this.updateStatistics();
            } finally {
                this.updatePending = false;
                if (this.updateQueued) {
                    this.updateQueued = false;
                    requestAnimationFrame(() => this.updateRendererAsync());
                }
            }
        }

        onThemeChanged() { super.onThemeChanged(); this.updateRendererAsync(); }

        async performFusion() {
            if (this.core.geometryProcessor) this.core.geometryProcessor.clearCachedStates();
            const fusionOptions = { enableArcReconstruction: this.renderer.options.enableArcReconstruction };
            this.debug('performFusion()', fusionOptions);

            try {
                const fused = [];
                for (const operation of this.core.operations) {
                    if (operation.type !== 'isolation' && operation.type !== 'clearing') continue;
                    if (!operation.primitives?.length) continue;

                    const result = await this.core.geometryProcessor.fuseGeometry(operation.primitives, fusionOptions);
                    for (const p of result) {
                        p.properties ||= {};
                        p.properties.operationType = operation.type;
                        // addFusedLayer buckets on this. Booleans emit new
                        // primitives, so nothing carries it forward for free.
                        p.properties.sourceOperationId = operation.id;
                    }
                    fused.push(...result);
                }

                if (this.renderer.options.showPreprocessed) this.addPreprocessedLayer();
                else this.addFusedLayer(fused);
                this.addNonFusableLayers();
            } catch (error) {
                console.error('Fusion error:', error);
                this.setStatus('Fusion failed: ' + error.message, 'error');
                this.addIndividualLayers();
            }
        }

        addPreprocessedLayer() {
            const allPreprocessed = this.core.getPreprocessedPrimitives();
            if (!allPreprocessed?.length) return;
            const byOperation = new Map();
            allPreprocessed.forEach(p => {
                const opId = p.properties?.operationId || p._originalOperationId;
                if (opId) { if (!byOperation.has(opId)) byOperation.set(opId, []); byOperation.get(opId).push(p); }
            });
            byOperation.forEach((primitives, opId) => {
                const operation = this.core.getOperation(opId);
                if (operation) this.renderer.addLayer(window.LayerNaming.preprocessed(opId), primitives, {
                    type: operation.type,
                    visible: true,
                    color: operation.color,
                    isPreprocessed: true,
                    zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type })
                });
            });
        }

        addFusedLayer(fused) {
            if (!fused?.length) return;
            const byOperation = new Map();
            fused.forEach(p => { const opId = p.properties?.sourceOperationId; if (opId) { if (!byOperation.has(opId)) byOperation.set(opId, []); byOperation.get(opId).push(p); } });
            byOperation.forEach((primitives, opId) => {
                const operation = this.core.getOperation(opId);
                if (operation) {
                    const layerName = window.LayerNaming.fused(opId);
                    this.renderer.addLayer(layerName, primitives, {
                        type: operation.type,
                        visible: this.resolveLayerVisibility(operation, 'source', true),
                        isFused: true,
                        zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type })
                    });
                }
            });
        }

        addNonFusableLayers() {
            this.core.operations.forEach(operation => {
                if ((operation.type === 'drill' || operation.type === 'cutout' || operation.type === 'stencil') && operation.primitives?.length > 0) {
                    const hasVisibleOffsets = operation.offsets?.length > 0 && this.resolveLayerVisibility(operation, 'offsets', true);
                    const defaultVis = operation.type === 'stencil' && hasVisibleOffsets ? false : true;
                    const layerName = window.LayerNaming.source(operation.id);
                    this.renderer.addLayer(layerName, operation.primitives, {
                        type: operation.type,
                        operationType: operation.type,
                        role: 'source',
                        visible: this.resolveLayerVisibility(operation, 'source', defaultVis),
                        zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type })
                    });
                }
            });
        }

        addIndividualLayers() {
            this.core.operations.forEach(operation => {
                if (operation.primitives?.length > 0) {
                    const hasVisibleOffsets = operation.offsets?.length > 0 && this.resolveLayerVisibility(operation, 'offsets', true);
                    const defaultVis = operation.type === 'stencil' && hasVisibleOffsets ? false : true;
                    const layerName = window.LayerNaming.source(operation.id);
                    this.renderer.addLayer(layerName, operation.primitives, {
                        type: operation.type,
                        operationType: operation.type,
                        role: 'source',
                        visible: this.resolveLayerVisibility(operation, 'source', defaultVis),
                        zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type })
                    });
                }
            });
        }


        /**
         * Resolves layer visibility: user override > explicit default > global
         * toggle. Keyed by Artifact (source/offsets/offset_N/preview/toolpath),
         * not by layer name: a layer name embeds the operation id, so the record
         * could not be read by refresh3D or by anything that did not already
         * know which layer it was looking for.
         */
        resolveLayerVisibility(operation, artifactKey, defaultVisible) {
            const v = operation.layerVisibility?.[artifactKey];
            return v !== undefined ? v : defaultVisible;
        }

        addOffsetLayers() {
            this.core.operations.forEach(operation => {
                if (operation.offsets?.length > 0) {
                    const isLaser = this.ctrl.machineClassOf?.(operation) === 'laser';
                    const isCombined = operation.offsets[0]?.metadata?.offset?.combined || isLaser;

                    if (isCombined) {
                        const allPrimitives = operation.offsets.flatMap(o => o.primitives || []);
                        if (allPrimitives.length > 0) {
                            let offsetType = 'external';
                            if (operation.offsets[0].distance < 0) offsetType = 'internal';
                            else if (operation.offsets[0].distance === 0) offsetType = 'on';
                            const isHatch = operation.offsets[0].metadata?.isHatch === true;
                            const layerName = window.LayerNaming.offsetCombined(operation.id);
                            this.renderer.addLayer(layerName, allPrimitives, {
                                type: 'offset', visible: this.resolveLayerVisibility(operation, 'offsets', true),
                                operationId: operation.id, operationType: operation.type, offsetType, pass: 1,
                                distance: operation.offsets[0].distance, combined: true, metadata: operation.offsets[0].metadata, isHatch,
                                zIndex: this.getLayerZIndex('offset', { operationType: operation.type, isHatch, strategy: operation.offsets[0].metadata?.strategy })
                            });
                        }
                    } else {
                        operation.offsets.forEach((offset, passIndex) => {
                            if (offset.primitives?.length > 0) {
                                let offsetType = offset.distance > 0 ? 'external' : offset.distance < 0 ? 'internal' : 'on';
                                const isHatch = offset.metadata?.isHatch === true;
                                const layerName = window.LayerNaming.offsetPass(operation.id, passIndex + 1);
                                const isVisible = this.resolveLayerVisibility(operation, `offset_${passIndex}`, !0) &&
                                                this.resolveLayerVisibility(operation, "offsets", !0);
                                this.renderer.addLayer(layerName, offset.primitives, {
                                    type: "offset", visible: isVisible,
                                    operationId: operation.id, operationType: operation.type, offsetType, pass: offset.pass,
                                    distance: offset.distance, combined: false, metadata: offset.metadata, isHatch,
                                    zIndex: this.getLayerZIndex('offset', { operationType: operation.type, isHatch, strategy: offset.metadata?.strategy })
                                });
                            }
                        });
                    }
                }

                // Preview layer
                if (operation.preview?.primitives?.length > 0) {
                    const layerName = window.LayerNaming.preview(operation.id);
                    this.renderer.addLayer(layerName, operation.preview.primitives, {
                        type: 'preview', visible: this.resolveLayerVisibility(operation, 'preview', true),
                        operationId: operation.id, operationType: operation.type, isPreview: true, metadata: operation.preview.metadata,
                        zIndex: this.getLayerZIndex('preview', { operationType: operation.type })
                    });
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Display updates
        // ═══════════════════════════════════════════════════════════════

        updateOriginDisplay() {
            const sizeElement = document.getElementById('board-size');
            if (sizeElement && this.scene) {
                const b = this.scene.getVisualBounds() || this.scene.getBoardBounds();
                if (b) sizeElement.textContent = b.width.toFixed(1) + ' x ' + b.height.toFixed(1) + ' mm';
            }
            this.updateOffsetInputsWithTracking();
        }

        updateStatistics() {
            const stats = this.core.getStats();
            const filesStat = document.getElementById('stat-files');
            if (filesStat) { const fileSet = new Set(this.core.operations.map(op => op.file.name)); filesStat.textContent = fileSet.size; }
            const opsStat = document.getElementById('stat-operations');
            if (opsStat) opsStat.textContent = stats.operations;
            const primStat = document.getElementById('stat-primitives');
            if (primStat) primStat.textContent = stats.totalPrimitives;
        }

        // ═══════════════════════════════════════════════════════════════
        // Operation management
        // ═══════════════════════════════════════════════════════════════

        removeOperation(operationId) {
            if (this.core.removeOperation(operationId)) {
                this.navTreePanel?.removeFileNode(operationId);
                if (this.traceOperationPanel?.currentOperationId && this.traceOperationPanel.currentOperationId !== operationId) {
                    this.traceOperationPanel.refresh();
                }
                this.updateRendererAsync();
                this.updateStatistics();
                this.setStatus('Operation removed', 'info');
            }
        }

        handleOperationSelection(operation, stage) {
            // Collapse the right sidebar controls to make room
            if (this.controls?.collapseRightSidebar) this.controls.collapseRightSidebar();
            // Tell the TraceOperationPanel to show the properties
            const container = document.getElementById('property-form');
            if (this.traceOperationPanel && container) this.traceOperationPanel.showOperationProperties(container, operation, stage);
        }

        handleDeleteGeometry(fileId, fileData, geometryId, geoData) {
            if (!fileData || !geoData) return;
            // Determine the layer to be deleted
            const operation = fileData.operation;
            let layerName;
            if (geoData.type === 'offsets_combined') layerName = window.LayerNaming.offsetCombined(operation.id);
            else if (geoData.type.startsWith('offset_')) { const passIndex = parseInt(geoData.type.split('_')[1]); layerName = window.LayerNaming.offsetPass(operation.id, passIndex + 1); }
            else if (geoData.type === 'preview') layerName = window.LayerNaming.preview(operation.id);
            else if (geoData.type === 'source') layerName = window.LayerNaming.source(operation.id);
            else layerName = `${geoData.type}_${operation.id}`;

            // Delegate data mutation to Core
            this.core.deleteOperationGeometry(operation.id, geoData.type);

            // Handle UI/renderer restoration after preview deletion
            if (geoData.type === 'preview' && operation.offsets?.length > 0) {
                // Auto-unhide offsets when CNC preview is deleted
                const isLaser = this.ctrl.machineClassOf?.(operation) === 'laser';
                const isCombined = operation.offsets[0]?.metadata?.offset?.combined || isLaser;

                // Unhide the specific offset layer(s) in the Renderer
                if (isCombined) {
                    const oln = window.LayerNaming.offsetCombined(operation.id);
                    if (this.renderer.layers.has(oln)) this.renderer.layers.get(oln).visible = true;
                } else {
                    operation.offsets.forEach((_, pi) => {
                        const oln = window.LayerNaming.offsetPass(operation.id, pi + 1);
                        if (this.renderer.layers.has(oln)) this.renderer.layers.get(oln).visible = true;
                    });
                }
                // Update eye icons in the Nav Tree
                if (this.navTreePanel) {
                    const fn = this.navTreePanel.nodes.get(fileId);
                    if (fn) fn.geometries.forEach((geo) => {
                        if (geo.type.startsWith('offset')) { const vb = geo.element.querySelector('.visibility-btn'); if (vb) vb.classList.remove('is-hidden'); }
                    });
                }
            }

            // Restore stencil source visibility if all offsets are deleted
            if (operation.type === 'stencil' && (!operation.offsets || operation.offsets.length === 0)) {
                const sln = window.LayerNaming.source(operation.id);
                if (this.renderer.layers.has(sln)) this.renderer.layers.get(sln).visible = true;
                if (this.navTreePanel) { const fn = this.navTreePanel.nodes.get(fileId); const vb = fn?.element.querySelector('.file-node-content .visibility-btn'); if (vb) vb.classList.remove('is-hidden'); }
            }

            // Clear the persisted record for the deleted artifact AND for
            // anything this delete just un-hid. Deleting a preview re-shows
            // the offsets in the renderer; leaving their `false` record
            // behind re-hid them on the next rebuild with the icon still
            // reading "shown".
            if (operation.layerVisibility) {
                delete operation.layerVisibility[NavTreePanel.artifactKeyOf(geoData.type)];
                if (geoData.type === 'preview') {
                    delete operation.layerVisibility.offsets;
                    operation.offsets?.forEach((_, pi) => delete operation.layerVisibility[`offset_${pi}`]);
                }
            }
            // Remove renderer layer // REVIEW - Useless code now?
            if (layerName && this.renderer.layers.has(layerName)) this.renderer.layers.delete(layerName);

            // Remove DOM node and re-select parent
            if (this.navTreePanel) {
                this.navTreePanel.removeGeometryNode(fileId, geometryId);
                const updatedFileData = this.navTreePanel.nodes.get(fileId);
                if (updatedFileData) this.navTreePanel.selectFile(fileId, updatedFileData.operation);
            }
            // Re-draw the canvas
            this.ctrl.refresh3D?.(); // refresh3D owns the world→machine map and the stock box; the renderer has neither.
            this.renderer.render();
        }

        triggerFileInput(opType) {
            const fileInput = document.getElementById('file-input-hidden') || document.getElementById('file-input-temp');
            if (!fileInput) { console.warn('No file input element found'); return; }
            fileInput.setAttribute('data-type', opType);
            fileInput.setAttribute('accept', this.ctrl.registry.acceptFor(opType));
            fileInput.onchange = async (e) => {
                const files = e.target.files;
                if (files?.length > 0) {
                    for (const file of files) await this.ctrl.processFile(file, opType);
                    this.zoomFit();
                    this.renderer.render();
                    this.canvasReadout?.updateZoom();
                }
                fileInput.value = '';
            };
            fileInput.click();
        }
    }

    window.EasyTraceUI = EasyTraceUI;
})();