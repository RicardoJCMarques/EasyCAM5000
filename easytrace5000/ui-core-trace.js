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

    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

    class EasyTraceUI extends BaseAppUI {
        constructor(ctrl) {
            super(ctrl);
            this.navTreePanel = null;
            this.traceOperationPanel = null;
            this.scene = null;
        }

        get operationPanel() {
            return this.traceOperationPanel;
        }

        async init() {
            try {
                // Shorthand refs - used heavily by board transform controls.
                // core.scene is the canonical owner; these avoid ~30 long-form lookups.
                this.scene = this.core.scene;
                await this.initShared();
                this.scene.addTransformListener(change => {
                    this.renderer.render();
                    if (debugState.enabled) this.debug(`[scene] transform change: ${change.action}`);
                });
                this.initTreePanel();
                this.traceOperationPanel = new TraceOperationPanel(this);
                this.traceOperationPanel.initBase({
                    core: this.core,
                    store: this.ctrl.parameterStore,
                    renderer: this.ctrl.inputRenderer,
                    appProfile: this.ctrl.appProfile,
                    lang: this.lang
                });
                // Board transforms: origin offset, rotation, mirror.
                this.bindOriginFields('x-offset', 'y-offset');
                const onClick = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
                onClick('center-origin-btn', () => this.centerOrigin());
                onClick('bottom-left-origin-btn', () => this.bottomLeftOrigin());
                onClick('reset-origin-btn', () => this.revertOrigin());
                onClick('apply-set-origin-btn', () => this.commitOrigin());
                this.setupRotationControls();
                this.setupMirrorControls();
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

        /**
         * Source layers, one theme colour per operation type. The base answers
         * first for everything else: black-and-white mode, stencil, laser
         * fills, offsets and previews.
         */
        resolveLayerColor(layer) {
            const base = super.resolveLayerColor(layer);
            if (base !== null) return base;
            // REVIEW - Why isn't stencil color here?
            switch (layer.type) {
                case 'isolation':
                case 'fused':
                    return this.readCSSVar('--color-geometry-source-isolation');
                case 'clearing':
                    return this.readCSSVar('--color-geometry-source-clearing');
                case 'drill':
                    return this.readCSSVar('--color-geometry-source-drill');
                case 'cutout':
                    return this.readCSSVar('--color-geometry-source-cutout');
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
        // Panel Initialization
        // ═══════════════════════════════════════════════════════════════

        initTreePanel() {
            this.navTreePanel = new NavTreePanel(this);
            this.navTreePanel.init();
            this.navTreePanel.on('categoryClick', (opType) => this.triggerFileInput(opType));
            this.navTreePanel.on('select', ({ operation, stage }) => {
                this.handleOperationSelection(operation, stage || 'geometry');
            });
            this.navTreePanel.on('action', ({ id, action, artifactKey, layerName, element }) => {
                if (action === 'delete') { this.promptRemoveOperation(id); return; }
                if (action === 'visibility' && element) {
                    this.navTreePanel.toggleLayerVisibility(element, artifactKey, layerName);
                }
            });
            this.navTreePanel.on('deleteGeometry', ({ fileId, geometryId }) => {
                const fileData = this.navTreePanel.nodes.get(fileId);
                const geoData = fileData?.geometries.get(geometryId);
                if (geoData) this.handleDeleteGeometry(fileId, fileData.operation, geoData.type);
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Board Transforms (origin/rotation/mirror)
        // ═══════════════════════════════════════════════════════════════
        setupRotationControls() {
            const rotationInput = document.getElementById('rotation-angle');
            const commitRotation = () => {
                this.scene.setRotation(parseFloat(rotationInput?.value) || 0);
                this.updateOriginDisplay();
                const el = document.getElementById('rotation-angle');
                if (el) el.value = (this.scene.transform.rotation || 0).toFixed(1);
                this.setStatus(`Board rotation set to ${this.scene.transform.rotation.toFixed(1)}°`, 'success');
            };
            if (rotationInput) {
                rotationInput.addEventListener('keypress', e => {
                    if (e.key === 'Enter') { rotationInput.blur(); commitRotation(); }
                });
            }
            document.getElementById("apply-rotation-btn")?.addEventListener("click", commitRotation);
            document.getElementById("reset-rotation-btn")?.addEventListener("click", () => {
                this.scene.resetRotation();
                this.updateOriginDisplay();
                this.setStatus("Board rotation reset (position unchanged)", "success");
            });
            // Keep the field on the absolute board angle, except while typing.
            const syncRotation = () => {
                const el = document.getElementById('rotation-angle');
                if (el && document.activeElement !== el) { el.value = (this.scene.transform.rotation || 0).toFixed(1); }
            };
            this.scene.addTransformListener(syncRotation);
            syncRotation();
        }

        setupMirrorControls() {
            const toggleX = document.getElementById('mirror-x-toggle');
            const toggleY = document.getElementById('mirror-y-toggle');
            if (toggleX) toggleX.addEventListener('change', e => {
                this.scene.setMirrorX(e.target.checked);
                this.updateOriginDisplay();
                this.setStatus(`Horizontal mirror ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
            });
            if (toggleY) toggleY.addEventListener('change', e => {
                this.scene.setMirrorY(e.target.checked);
                this.updateOriginDisplay();
                this.setStatus(`Vertical mirror ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
            });
            this.syncMirrorCheckboxes();
            this.scene.addTransformListener(() => this.syncMirrorCheckboxes());
        }

        syncMirrorCheckboxes() {
            const t = this.scene.transform;
            const toggleX = document.getElementById('mirror-x-toggle');
            const toggleY = document.getElementById('mirror-y-toggle');
            if (toggleX && toggleX.checked !== t.mirrorX) toggleX.checked = t.mirrorX;
            if (toggleY && toggleY.checked !== t.mirrorY) toggleY.checked = t.mirrorY;
        }

        centerOrigin() {
            const applied = this.scene.centerOriginOnBoard();
            this.updateOriginDisplay();
            this.setStatus(applied ? 'Preview: Origin at board center (not saved)' : 'Cannot center - no board bounds yet', applied ? 'info' : 'error');
        }

        bottomLeftOrigin() {
            const applied = this.scene.setOriginToBottomLeft();
            this.updateOriginDisplay();
            this.setStatus(applied ? 'Preview: Origin at board bottom-left (not saved)' : 'Cannot set bottom-left - no board bounds yet', applied ? 'info' : 'error');
        }

        // ═══════════════════════════════════════════════════════════════
        // Renderer layer management
        // ═══════════════════════════════════════════════════════════════

        async collectLayers() {
            this.renderer.options.fuseGeometry ? await this.performFusion() : this.addSourceLayers();
            this.addOffsetLayers();
        }

        afterRebuildLayers() {
            this.updateOriginDisplay();
            this.updateStatistics();
        }

        onThemeChanged() { super.onThemeChanged(); this.rebuildLayers(); }

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
                this.addSourceLayers((op) => op.type !== 'isolation' && op.type !== 'clearing');
            } catch (error) {
                console.error('Fusion error:', error);
                this.setStatus('Fusion failed: ' + error.message, 'error');
                this.addSourceLayers();
            }
        }

        addPreprocessedLayer() {
            const allPreprocessed = this.core.geometryProcessor?.cachedStates.preprocessedGeometry;
            if (!allPreprocessed?.length) return;
            const byOperation = new Map();
            allPreprocessed.forEach(p => {
                const opId = p.properties?.operationId || p._originalOperationId;
                if (opId) { if (!byOperation.has(opId)) byOperation.set(opId, []); byOperation.get(opId).push(p); }
            });
            byOperation.forEach((primitives, opId) => {
                const operation = this.core.store.getOperation(opId);
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
                const operation = this.core.store.getOperation(opId);
                if (operation) {
                    const layerName = window.LayerNaming.fused(opId);
                    this.renderer.addLayer(layerName, primitives, {
                        type: operation.type,
                        operationType: operation.type,
                        operationId: operation.id,
                        role: 'source',
                        visible: this.resolveLayerVisibility(operation, 'source', true),
                        isFused: true,
                        zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type })
                    });
                }
            });
        }

        /**
         * Source layers for every operation with primitives that `include`
         * accepts. A stencil's source starts hidden while its offsets show.
         */
        addSourceLayers(include = () => true) {
            for (const operation of this.core.operations) {
                if (!operation.primitives?.length || !include(operation)) continue;
                const hasVisibleOffsets =
                    operation.offsets?.length > 0 && this.resolveLayerVisibility(operation, 'offsets', true);
                const defaultVis = !(operation.type === 'stencil' && hasVisibleOffsets);
                this.renderer.addLayer(window.LayerNaming.source(operation.id), operation.primitives, {
                    type: operation.type,
                    operationType: operation.type,
                    operationId: operation.id,
                    role: 'source',
                    visible: this.resolveLayerVisibility(operation, 'source', defaultVis),
                    zIndex: this.getLayerZIndex(operation.type, { operationType: operation.type }),
                });
            }
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

        addOffsetLayers(operations = this.core.operations) {
            operations.forEach((operation) => {
                if (operation.offsets?.length > 0) {
                    const isLaser = this.core.machineClassOf(operation) === 'laser';
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
                                const isVisible = this.resolveLayerVisibility(operation, `offset_${passIndex}`, true) &&
                                                this.resolveLayerVisibility(operation, "offsets", true);
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
            this.syncOriginFields(true);
        }

        updateStatistics() {
            const stats = this.core.store.getStats()
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

        /**
         * Confirms, then deletes. Named for the prompt, not the action:
         * removeOperation below does the delete.
         */
        promptRemoveOperation(operationId) {
            const op = this.core.store.getOperation(operationId);
            const name = op?.file?.name || 'this operation';
            this.ctrl.confirmDestructive(
                'Delete operation',
                `Remove ${name} and everything generated from it? This can't be undone.`,
                () => this.removeOperation(operationId)
            );
        }

        removeOperation(operationId) {
            if (this.core.detachOperation(operationId)) {
                this.navTreePanel?.removeFileNode(operationId);
                if (this.traceOperationPanel) {
                    if (this.traceOperationPanel.currentOperationId === operationId) {
                        this.traceOperationPanel.clearProperties();
                        const container = document.getElementById("property-form");
                        container && (container.innerHTML = '<div class="property-empty">← Select a File Geometry from the OPERATIONS list to show more.</div>');
                        const titleEl = document.getElementById("inspector-title");
                        titleEl && (titleEl.textContent = "OP. Parameters");
                    } else {
                        this.traceOperationPanel.refresh();
                    }
                }
                this.rebuildLayers();
                this.updateStatistics();
                this.setStatus("Operation removed", "info");
            }
        }

        handleOperationSelection(operation, stage) {
            // Collapse the right sidebar controls to make room
            UIControls.collapseAllIn("#sidebar-right");
            // Tell the TraceOperationPanel to show the properties
            const container = document.getElementById('property-form');
            if (this.traceOperationPanel && container) this.traceOperationPanel.showOperationProperties(container, operation, stage);
        }

        handleDeleteGeometry(fileId, operation, type) {
            const hadPreview = !!operation.preview;
            this.core.store.deleteOperationGeometry(operation.id, type);
            // The record is the truth: a `false` left behind for anything this
            // delete re-shows would re-hide it on the next rebuild.
            const record = (operation.layerVisibility ||= {});
            delete record[NavTreePanel.artifactKeyOf(type)];
            if (hadPreview && !operation.preview) {
                delete record.offsets;
                operation.offsets.forEach((_, pi) => delete record[`offset_${pi}`]);
            }
            if (operation.type === 'stencil' && !operation.offsets.length) {
                delete record.source;
                const source = this.renderer.layers.get(window.LayerNaming.source(operation.id));
                if (source) source.visible = true;
            }
            // Re-lay this operation's offset and preview layers only: source and
            // fused layers stay, so fusion does not re-run.
            for (const [name, layer] of this.renderer.layers) {
                if (layer.operationId === operation.id && (layer.isOffset || layer.isPreview)) {
                    this.renderer.layers.delete(name);
                }
            }
            this.addOffsetLayers([operation]);
            this.navTreePanel.updateFileGeometries(fileId, operation);
            this.navTreePanel.selectFile(fileId, operation);
            // refresh3D owns the world→machine map and the stock box; the renderer has neither.
            this.ctrl.refresh3D();
            this.renderer.render();
        }

        triggerFileInput(opType) {
            const fileInput = document.getElementById('file-input-hidden');
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