/*!
 * @file        easyshape5000/ui-core-shape.js
 * @description EasyShape5000 UI orchestrator. Extends BaseAppUI for shared
 *              renderer, viewport, status, controls, and theme logic.
 *              Adds shape-specific panels, layers, overlays, and transforms.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class EasyShapeUI extends BaseAppUI {
        constructor(ctrl) {
            super(ctrl);

            this.shapeOperationPanel = null;
            this.navScenePanel = null;
            this.opsPanel = null;
            this.generating = false;

            this.vizFilters = {
                unassigned: true,
                profile: true,
                pocket: true,
                drill: true,
                engrave: true,
                vcarve: true,
                relief: true,
                rotary: true,
                pattern: true,
                generated: true,
                preview: true
            };
        }

        // ═══════════════════════════════════════════════════════════════
        // Initialization
        // ═══════════════════════════════════════════════════════════════

        async init() {
            try {
                await this.initShared();

                this.initTreePanel();
                this.initOperationsPanel();
                this.initOpTypeTabs();
                this.initShapeOperationPanel();
                this.initVizFilters();
                this.setupTransformFields();

                this.debug('EasyShapeUI initialized');
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
            return {
                showGrid: true,
                showOrigin: true,
                showRulers: true,
                showBounds: false,
                showOffsets: true,
                showPreviews: true,
                fuseGeometry: false,
                blackAndWhite: false,
                theme,
                primitiveFilter: (prim, layerType) => this.shouldRenderPrimitive(prim, layerType),
                resolveLayerColor: (layer) => this.resolveLayerColor(layer)
            };
        }

        buildToolContext(canvas) {
            const ctrl = this.ctrl;
            return {
                scene: ctrl.scene,
                selection: ctrl.selection,
                sceneInteraction: ctrl.sceneInteraction,
                renderer: this.renderer,
                canvas,
                canvasReadout: this.canvasReadout,
                requestRender: () => this.renderer?.render(),
                onCommit: () => this.renderAll(),
                getTopLevelIds: (ids) => ctrl.getTopLevelActionableIds(ids),
                isNodeLocked: (idOrNode) => {
                    const n = typeof idOrNode === 'string' ? ctrl.scene.findNode(idOrNode) : idOrNode;
                    return n ? !ctrl.canMutateNode(n) : false;
                },
                isNodeVisible: (idOrNode) => {
                    const n = typeof idOrNode === 'string' ? ctrl.scene.findNode(idOrNode) : idOrNode;
                    return n ? n.isVisible : false;
                },
                canMutateNode: (idOrNode) => {
                    const n = typeof idOrNode === 'string' ? ctrl.scene.findNode(idOrNode) : idOrNode;
                    return ctrl.canMutateNode(n);
                },
                commitTranslate: (ids, dx, dy) => {
                    if (!ids?.length || (dx === 0 && dy === 0)) return;
                    const topLevel = ctrl.getTopLevelActionableIds(ids);
                    if (topLevel.length === 0) return;
                    ctrl.history.record(new TranslateCommand(topLevel, dx, dy));
                },
                syncInspector: () => this.syncTransformFromSelection?.(),
                createPanZoomTool: () => new PanZoomTool({ allowedButtons: [1, 2], cursor: 'grabbing' })
            };
        }

        createDefaultTool() {
            return new SelectMoveTool();
        }

        // REVIEW - Some consistency is getting lost between EasyShape5000 and EasyTrace5000, double check all these methods maintain some relational predictability to how they work.
        resolveLayerColor(layer) {
            const isBW = this.renderer?.options?.blackAndWhite;
            if (isBW) return this.readCSSVar('--color-bw-white', '#ffffff');

            // Operation type wins for EVERY layer that carries one: EasyShape
            // paints a bucket's offsets and preview in that operation's colour
            // rather than the shared offset/preview roles the base provides.
            const opType = layer.operationType;
            if (opType === 'unassigned') {
                return layer.color || this.readCSSVar('--color-geometry-source-unassigned', '#228b9d');
            }
            const opColor = this.resolveOperationColor(opType);
            if (opColor) return opColor;

            const base = super.resolveLayerColor(layer);
            if (base !== null) return base;

            return layer.color || this.readCSSVar('--color-text-secondary', '#a0a0a0');
        }

        getLayerZIndex(type, opts = {}) {
            const base = super.getLayerZIndex(type, opts);
            if (base !== null) return base;

            switch (type) {
                case 'unassigned': return 100;
                case 'profile':    return 110;
                case 'pocket':     return 120;
                case 'engrave':    return 130;
                case 'vcarve':     return 140;
                case 'relief':     return 150;
                case 'rotary':     return 160;
                case 'pattern':    return 170;
                default:           return 250;
            }
        }

        shouldRenderPrimitive(primitive, layerType) { return true; }

        renderOverlay(ctx, core) {
            this.renderSelectionHighlights(ctx, core);
            if (!this.toolController) return;
            const state = this.toolController.getOverlayState();
            const fc = core.frameCache;
            const uiScale = core.devicePixelRatio || 1;

            const selSize = this.ctrl.selection.size();
            const showAggregateBbox = selSize > 1 || (selSize === 1 && (() => {
                const id = this.ctrl.selection.anchor();
                const n = id ? this.ctrl.scene.findNode(id) : null;
                return n && n.kind === 'group';
            })());

            if (showAggregateBbox) {
                const b = this.ctrl.scene.getSelectionWorldBounds?.();
                if (b) {
                    ctx.save();
                    ctx.strokeStyle = this.readCSSVar('--color-interaction-group-bounds', '#22d3ee');
                    ctx.lineWidth = (1.5 * uiScale) * fc.invScale;
                    ctx.setLineDash([4 * fc.invScale, 4 * fc.invScale]);
                    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
                    ctx.restore();
                }
            }

            if (state?.marqueeRect) {
                const r = state.marqueeRect;
                ctx.save();
                ctx.fillStyle = this.readCSSVar('--color-interaction-marquee-fill', '#112240');
                ctx.strokeStyle = this.readCSSVar('--color-interaction-marquee-stroke', '#3b82f6');
                ctx.lineWidth = (1 * uiScale) * fc.invScale;
                ctx.setLineDash([5 * fc.invScale, 5 * fc.invScale]);
                ctx.globalAlpha = 0.2;
                ctx.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
                ctx.globalAlpha = 1.0;
                ctx.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
                ctx.restore();
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Panel Initialization
        // ═══════════════════════════════════════════════════════════════

        initTreePanel() {
            this.navScenePanel = new NavScenePanel(this);
            this.navScenePanel.init('scene-tree-list');
            this.navScenePanel.bindScene(this.ctrl.scene);

            this.navScenePanel.on('select', ({ id, shiftKey, ctrlKey }) => {
                const sel = this.ctrl.selection;
                if (shiftKey) sel.toggle(id);
                else if (ctrlKey) sel.add(id);
                else sel.replace([id]);
            });

            this.navScenePanel.on('action', ({ id, action }) => {
                switch (action) {
                    case 'lock': this.ctrl.toggleNodeFlag(id, 'locked'); break;
                    case 'visibility': this.ctrl.toggleNodeFlag(id, 'visible'); break;
                    case 'delete': this.ctrl.deleteShapes([id]); break;
                }
            });

            this.navScenePanel.on('warn', (msg) => this.setStatus(msg, 'warning'));

            this.navScenePanel.on('toolbar', (action) => {
                switch (action) {
                    case 'group': this.ctrl.groupSelection(); break;
                    case 'ungroup': this.ctrl.ungroupSelection(); break;
                    case 'lock': this.ctrl.toggleNodeFlag(this.ctrl.selection.toArray()[0], 'locked'); break;
                    case 'visibility': this.ctrl.toggleNodeFlag(this.ctrl.selection.toArray()[0], 'visible'); break;
                    case 'delete': this.ctrl.deleteShapes(this.ctrl.getTopLevelActionableIds()); break;
                }
            });
        }

        initOperationsPanel() {
            this.opsPanel = new NavOperationsPanel();
            this.opsPanel.init('operations-bucket-list');
            this.opsPanel.setSceneResolver(() => this.ctrl.scene);
            this.opsPanel.setStageResolver((opType) =>
                this.ctrl.parameterManager.getStagesForPipeline('cnc', opType));

            this.opsPanel.on('select', ({ bucketId, stage }) => {
                const bucket = this.opsPanel.getBucket(bucketId);
                if (!bucket) return;

                // Load appropriate stage in right panel
                const panel = document.getElementById('right-panel');
                if (panel) panel.dataset.rightPanelState = 'bucket-stage';

                const container = document.getElementById('operation-form-container');
                if (container && this.shapeOperationPanel) {
                    this.shapeOperationPanel.showBucketStage(container, bucket, stage);
                }
            });

            this.opsPanel.on('action', ({ bucketId, action, stage }) => {
                if (action === 'delete') {
                    this.opsPanel.removeBucket(bucketId, this.ctrl.core);
                    this.rebuildLayers();
                } else if (action === 'delete-stage') {
                    this.opsPanel.clearBucketStage(bucketId, stage, this.ctrl.core);

                    // If the bucket has no offsets and no preview objects just delete it
                    const bucket = this.opsPanel.getBucket(bucketId);
                    if (bucket && !bucket.hasOffsets && !bucket.hasPreview) {
                        this.opsPanel.removeBucket(bucketId, this.ctrl.core);
                    } else {
                        const prevStage = stage === 'preview' ? 'offsets' : 'geometry';
                        this.opsPanel.selectStage(bucketId, prevStage);
                    }
                    this.rebuildLayers();
                }
            });

            this.opsPanel.on('stageCleared', () => { this.rebuildLayers(); this.ctrl.refresh3DPlans?.(); });
            this.opsPanel.on('bucketRemoved', () => { this.rebuildLayers(); this.ctrl.refresh3DPlans?.(); });
        }

        initOpTypeTabs() {
            document.querySelectorAll('.op-type-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    if (tab.disabled) return;
                    document.querySelectorAll('.op-type-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const opType = tab.dataset.op;
                    const anchorId = this.ctrl.selection.anchor();
                    const container = document.getElementById('fresh-params-form');
                    if (container && anchorId && this.shapeOperationPanel) {
                        this.shapeOperationPanel.showFreshSelection(
                            document.getElementById('operation-form-container'),
                            anchorId, opType
                        );
                    }
                });
            });
        }

        initShapeOperationPanel() {
            this.shapeOperationPanel = new ShapeOperationPanel(this);
            this.shapeOperationPanel.init(
                this.ctrl.scene,
                this.ctrl.selection,
                this.ctrl.core,
                this.ctrl.parameterManager,
                this.ctrl.appProfile,
                this.lang
            );

            // Operation assignment from palette
            this.shapeOperationPanel.on('assignOp', (opType) => this.ctrl.assignOperationToSelection(opType));
            this.shapeOperationPanel.on('clearOp', () => this.ctrl.clearOperationFromSelection());

            // Export manager
            this.shapeOperationPanel.on('openExportManager', () => this.openExportModal());

            // Stage tab clicks trigger re-render
            this.shapeOperationPanel.on('stageChanged', (newStage) => {
                const container = document.getElementById('operation-form-container');
                const anchorId = this.ctrl.selection.anchor();
                const anchor = anchorId ? this.ctrl.scene.findShape(anchorId) : null;
                if (container && anchor?.operation) {
                    this.shapeOperationPanel.showOperationProperties(container, anchor);
                }
            });

            // Bucket creation
            this.shapeOperationPanel.on('createAndGenerate', async ({ shapeId, opType }) => {
                const node = this.ctrl.scene.findNode(shapeId);
                const label = (node?.label && node.label !== '__root__' && node.label !== 'Shape')
                    ? node.label : opType;

                const rawIds = this.ctrl.selection.size() > 1
                    ? this.ctrl.selection.toArray() : [shapeId];
                const refs = [];
                for (const id of rawIds) {
                    const n = this.ctrl.scene.findNode(id);
                    if (!n) continue;
                    if (n.kind === 'shape') { if (!refs.includes(id)) refs.push(id); }
                    else { for (const sid of this.ctrl.scene.collectShapeIds(n)) { if (!refs.includes(sid)) refs.push(sid); } }
                }
                if (refs.length === 0) { this.setStatus('No shapes in selection', 'warning'); return; }

                await this.runBucketStage('Generation', async () => {
                    const bucketId = this.opsPanel.createBucket(
                        this.ctrl.core, this.ctrl.scene, opType, label, refs
                    );
                    const bucket = this.opsPanel.getBucket(bucketId);
                    const captured = this.shapeOperationPanel.captureFormStateForId(bucketId, opType); // REVIEW - This syntax isn't consistent with the next use of this.shapeOperationPanel.captureFormStateForId(?
                    bucket.settings = { ...bucket.settings, ...captured };

                    const result = await this.shapeOperationPanel.runGeneration(bucketId);
                    this.opsPanel.updateBucketAfterGeneration(bucketId, this.ctrl.core);
                    this.setStatus(result.message, result.status);
                    if (result.success) { this.opsPanel.selectStage(bucketId, 'offsets'); this.rebuildLayers(); }
                });
            })

            // Action on existing bucket stage
            this.shapeOperationPanel.on('bucketAction', async ({ bucketId, stage }) => {
                const bucket = this.opsPanel.getBucket(bucketId);
                if (!bucket) return;
                const captured = this.shapeOperationPanel.captureFormStateForId(
                    bucketId, bucket.type, bucket.shapeRefs);
                bucket.settings = { ...bucket.settings, ...captured };

                if (stage === 'geometry') {
                    // Regenerate offsets. resetOperationState is the handler's -
                    // it runs there AFTER beginGeneration stamps the token, which
                    // is the order the stale gate depends on.
                    await this.runBucketStage('Regeneration', async () => {
                        bucket.syncPrimitives(this.ctrl.core, this.ctrl.scene);

                        const result = await this.shapeOperationPanel.runGeneration(bucketId);
                        this.opsPanel.updateBucketAfterGeneration(bucketId, this.ctrl.core);
                        this.setStatus(result.message, result.status);
                        if (result.success) {
                            this.opsPanel.selectStage(bucketId, 'offsets');
                            this.rebuildLayers();
                        }
                    });
                } else if (stage === 'offsets') {
                    // A 3D operation has no strategy stage: its single node IS
                    // the machine stage and its button opens the exporter.
                    const stages = this.ctrl.parameterManager
                        .getStagesForPipeline('cnc', bucket.type);
                    if (!stages.includes('strategy')) { this.openExportModal(); return; }

                    // Generate preview
                    await this.runBucketStage('Preview', async () => {
                        this.showCanvasSpinner('Generating preview...');
                        // generateCNCPreview blocks the main thread - let the
                        // spinner paint first.
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        try {
                            const result = await this.shapeOperationPanel.runPreview(bucketId);
                            this.opsPanel.updateBucketAfterGeneration(bucketId, this.ctrl.core);
                            this.setStatus(result.message, result.status);
                            if (result.success) {
                                this.opsPanel.selectStage(bucketId, 'preview');
                                this.rebuildLayers();
                            }
                        } finally { this.hideCanvasSpinner(); }
                    });
                } else if (stage === 'preview') {
                    this.openExportModal();
                }
            })
        }

        /**
         * Re-entrancy-guarded bucket stage runner. Spinner/task ownership
         * lives in BaseOperationPanel.runGeneration (StatusManager task);
         * this owns only the guard and the shared success/error plumbing.
         * REVIEW - This seems sort of useless now? Can't it be integrated somewhere else?
         */
        async runBucketStage(label, fn) {
            if (this.generating) {
                this.debug(`[EasyShapeUI] - Busy: ignored '${label}' while a previous operation is still being processed.`);
                return;
            }
            this.generating = true;
            try {
                await fn();
            } catch (e) {
                console.error(`[EasyShapeUI] ${label} failed:`, e);
                this.setStatus(`${label} failed: ` + e.message, 'error');
            } finally {
                this.generating = false;
            }
        }

        initVizFilters() {
            const bind = (id, key) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.checked = this.vizFilters[key] !== false;
                el.addEventListener('change', () => { this.vizFilters[key] = el.checked; this.rebuildLayers(); });
            };
            bind('show-unassigned', 'unassigned');
            bind('show-profile', 'profile');
            bind('show-pocket', 'pocket');
            bind('show-drill', 'drill');
            bind('show-engrave', 'engrave');
            bind('show-vcarve', 'vcarve');
            bind('show-relief', 'relief');
            bind('show-rotary', 'rotary');
            // bind('show-pattern', 'pattern'); // Not wired
            bind('show-generated', 'generated');
            bind('show-tool-preview-shape', 'preview');
        }

        // ═══════════════════════════════════════════════════════════════
        // Renderer layer management
        // ═══════════════════════════════════════════════════════════════

        rebuildLayers() {
            if (!this.renderer) return;
            this.renderer.clearLayers();
            this.addStockLayer();
            const f = this.vizFilters;

            // Pre-compute selected shape ids (groups expanded). Selected shapes
            // get their OWN layer so the drag fast-path (updateLayerTransform on
            // `shape_${id}`) keeps working - batched shapes have no per-shape
            // layer to update mid-drag.
            const selectedShapeIds = new Set();
            for (const id of this.ctrl.selection.toSet()) {
                const node = this.ctrl.scene.findNode(id);
                if (!node) continue;
                if (node.kind === 'shape') selectedShapeIds.add(node.id);
                else for (const sid of this.ctrl.scene.collectShapeIds(node)) selectedShapeIds.add(sid);
            }

            // Batch identity-transform, unselected shapes by EasyShape op type
            // (or 'unassigned'). Transformed or selected shapes get own layers.
            const batches = new Map(); // opKey → prims[]
            const pushBatch = (opKey, prim) => {
                let arr = batches.get(opKey);
                if (!arr) { arr = []; batches.set(opKey, arr); }
                arr.push(prim);
            }

            for (const shape of this.ctrl.scene.allShapes()) {
                if (!shape.isVisible) continue;

                const opKey = shape.operation ? shape.operation.type : 'unassigned';

                // Per-category visibility filter (default true).
                if (f && f[opKey] === false) continue;

                const m = shape.getWorldMatrix();
                const isIdentity = m.a === 1 && m.b === 0 && m.c === 0 &&
                                   m.d === 1 && m.e === 0 && m.f === 0;
                const isSelected = selectedShapeIds.has(shape.id);

                if (isIdentity && !isSelected) {
                    pushBatch(opKey, shape.primitive);
                } else {
                    this.renderer.addLayer(`shape_${shape.id}`, [shape.primitive], {
                        type: opKey,
                        operationType: opKey,
                        visible: true,
                        transform: m,
                        bounds: this.ctrl.scene.getShapeWorldBounds(shape),
                        zIndex: this.getLayerZIndex(opKey, { operationType: opKey })
                    });
                }
            }

            for (const [opKey, prims] of batches) {
                this.renderer.addLayer(`batch_${opKey}`, prims, {
                    type: opKey,
                    operationType: opKey,
                    visible: true,
                    zIndex: this.getLayerZIndex(opKey, { operationType: opKey })
                });
            }

            // Generated geometry (offsets + previews) from operation buckets.
            this.addBucketLayers();

            // Mirror the fresh layer snapshot into the 3D view (no-op in 2D mode)
            this.ctrl.refresh3D?.();

            this.renderer.render();
        }

        /**
         * Adds offset and preview layers for every operation bucket.
         */
        addBucketLayers() {
            if (!this.opsPanel) return;
            const f = this.vizFilters;
            const showGenerated = !f || f.generated !== false;
            const showPreview = !f || f.preview !== false;
            const core = this.ctrl.core;

            for (const bucket of this.opsPanel.getAllBuckets()) {
                const op = bucket.getOperation(core);
                if (!op) continue;

                // Rotary developed strips carry y = θ·refRadius starting at
                // 0 (the future A-axis coordinate - data must stay pure).
                // DISPLAY ONLY: translate the strip so it straddles the
                // rotation axis line over the mesh footprint.
                let stripTransform = null;
                const meta0 = op.offsets?.[0]?.metadata;
                if (bucket.type === 'rotary' && meta0?.developedSpace &&
                    meta0.circumference > 0) {
                    const halfC = meta0.circumference / 2;
                    const axisB = meta0.axisCenter?.b || 0;   // world
                    // axis 'x': developed x IS workspace X; translate the arc
                    //   dimension so it straddles the axis line.
                    // axis 'y': developed x IS workspace Y, and +arc points
                    //   toward -workspace X (the slicer's cross-u is -X - see
                    //   ShapeRotaryHandler.getInternalOrient). Rotate, don't
                    //   mirror: det must stay +1 or the strip renders as the
                    //   mirror image of what the machine cuts.
                    stripTransform = meta0.rotaryAxis === 'y'
                        ? { a: 0, b: 1, c: -1, d: 0, e: axisB + halfC, f: 0 }
                        : { a: 1, b: 0, c: 0,  d: 1, e: 0, f: axisB - halfC };
                }

                // Offsets
                if (showGenerated && op.offsets?.length > 0 && !op.isInvalidated) {
                    const allPrims = op.offsets.flatMap(o => o.primitives || []);
                    if (allPrims.length > 0) {
                        const first = op.offsets[0];
                        let offsetType = 'external';
                        if (first.distance < 0) offsetType = 'internal';
                        else if (first.distance === 0) offsetType = 'on';

                        this.renderer.addLayer(`bucket_offset_${bucket.id}`, allPrims, {
                            type: 'offset',
                            visible: !op.preview?.ready,
                            operationId: bucket.id,
                            operationType: bucket.type,
                            offsetType,
                            distance: first.distance,
                            combined: true,
                            transform: stripTransform || undefined,
                            metadata: first.metadata,
                            zIndex: this.getLayerZIndex('offset', { operationType: bucket.type })
                        });
                    }
                }

                // Preview
                if (showPreview && op.preview?.primitives?.length > 0 && !op.isInvalidated) {
                    this.renderer.addLayer(`bucket_preview_${bucket.id}`, op.preview.primitives, {
                        type: 'preview',
                        visible: true,
                        operationId: bucket.id,
                        operationType: bucket.type,
                        transform: stripTransform || undefined,
                        metadata: op.preview.metadata,
                        zIndex: this.getLayerZIndex('preview', { operationType: bucket.type })
                    });
                }
            }
        }

        addStockLayer() {
            const stock = this.ctrl.core.stock;
            if (!stock) return;
            const { width: w, height: h } = stock;
            if (!w || !h || w <= 0 || h <= 0) return;

            const prim = new PathPrimitive([{
                points: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }, { x: 0, y: 0 }],
                isHole: false, nestingLevel: 0, parentId: null, arcSegments: [], curveIds: []
            }], {
                stroke: true, fill: false, strokeWidth: 0.5, polarity: 'dark', isStock: true
            });
            this.renderer.addLayer('__stock__', [prim], { type: 'stock', visible: true, isStock: true, zIndex: this.getLayerZIndex('stock') });
        }

        // ═══════════════════════════════════════════════════════════════
        // Selection highlights
        // ═══════════════════════════════════════════════════════════════

        renderSelectionHighlights(ctx, core) {
            if (this.ctrl.selection.size() === 0) return;
            if (!this.renderer?.primitiveRenderer) return;

            const fc = core.frameCache;
            const uiScale = core.devicePixelRatio || 1;
            const glowWidth = Math.max(2.5 * uiScale * fc.invScale, fc.minWorldWidth * 2);

            const accent = this.readCSSVar('--color-interaction-selection-stroke', '#22d3ee');
            const accentFill = this.readCSSVar('--color-interaction-selection-fill', '#0a3f47');

            const pr = this.renderer.primitiveRenderer;

            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.setLineDash([]);

            // Expand groups into underlying shapes
            const shapeIds = new Set();
            for (const id of this.ctrl.selection.toSet()) {
                const node = this.ctrl.scene.findNode(id);
                if (!node) continue;
                if (node.kind === 'shape') shapeIds.add(node.id);
                else for (const sid of this.ctrl.scene.collectShapeIds(node)) shapeIds.add(sid);
            }

            for (const id of shapeIds) {
                const shape = this.ctrl.scene.findShape(id);
                if (!shape?.primitive) continue;
                const m = shape.getWorldMatrix?.();
                ctx.save();
                if (m) ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
                const props = shape.primitive.properties || {};
                const isStroked = props.stroke === true || props.isTrace === true;
                const isFilled = !isStroked && props.fill !== false;
                const hlPath = pr.getPath2D(shape.primitive);
                if (isFilled) {
                    ctx.fillStyle = accentFill;
                    ctx.fill(hlPath, 'evenodd');
                }
                ctx.strokeStyle = accent;
                ctx.lineWidth = glowWidth;
                ctx.stroke(hlPath);
                ctx.restore();
            }
            ctx.restore();
        }

        // ═══════════════════════════════════════════════════════════════
        // Selection change handler
        // ═══════════════════════════════════════════════════════════════

        onSelectionChanged() {
            if (this.ctrl.selection.size() === 0) {
                const panel = document.getElementById('right-panel');
                if (panel) panel.dataset.rightPanelState = 'no-selection';
                this.navScenePanel?.updateSelectionHighlights(new Set());
                if (this.renderer) this.renderer.render();
                return;
            }

            const anchorId = this.ctrl.selection.anchor();
            const anchor = anchorId ? this.ctrl.scene.findShape(anchorId) : null;
            const panel = document.getElementById('right-panel');
            const container = document.getElementById('operation-form-container');

            if (anchor?.operation) {
                // Shape already has an operation - show its properties
                if (panel) panel.dataset.rightPanelState = 'op-assigned';
                if (container && this.shapeOperationPanel) {
                    this.shapeOperationPanel.showOperationProperties(container, anchor);
                }
            } else {
                // No operation - show fresh selection with default tab
                if (panel) panel.dataset.rightPanelState = 'source-selected';
                if (container && this.shapeOperationPanel) {
                    const activeTab = document.querySelector('.op-type-tab.active');
                    const defaultOp = activeTab?.dataset.op || 'profile';
                    this.shapeOperationPanel.showFreshSelection(container, anchorId, defaultOp);
                }
            }

            if (this.controls?.collapseRightSidebar) {
                this.controls.collapseRightSidebar();
                // Expand the specific section header for cut settings
                UIControls.expandSection('#sidebar-right .inspector-section .section-header');
            }

            this.navScenePanel?.syncTreeToolbar(this.ctrl.selection, this.ctrl.scene);
            this.navScenePanel?.updateSelectionHighlights(this.ctrl.selection.toSet());
            this.syncTransformFromSelection();
            // REVIEW - Why is this checking if the render exists? I'm not sure it's possible to get this far without it?
            if (this.renderer) this.renderer.render();
        }

        // ═══════════════════════════════════════════════════════════════
        // Right Panel State
        // ═══════════════════════════════════════════════════════════════

        updateRightPanelState() {
            const panel = document.getElementById('right-panel');
            if (!panel) return;

            let state;
            if (this.ctrl.scene.shapeCount() === 0) state = 'no-svg';
            else if (this.ctrl.selection.size() === 0) state = 'no-selection';
            else {
                const anchorId = this.ctrl.selection.anchor();
                const anchor = anchorId ? this.ctrl.scene.findShape(anchorId) : null;
                state = anchor?.operation ? 'op-assigned' : 'selected-no-op';
            }
            panel.dataset.rightPanelState = state;

            const container = document.getElementById('operation-form-container');
            if (!container) return;
            if (state === 'op-assigned') {
                const anchor = this.ctrl.scene.findShape(this.ctrl.selection.anchor());
                if (this.shapeOperationPanel && anchor) {
                    this.shapeOperationPanel.showOperationProperties(container, anchor);
                }
            } else {
                container.innerHTML = '';
                this.shapeOperationPanel?.clearProperties();
            }
        }

        renderStatusBar() {}

        openExportModal() {
            const readyOps = this.ctrl.core.operations.filter(op => this.ctrl.core.isExportReady(op));
            if (readyOps.length === 0) { this.setStatus('No operations ready for export. Generate previews first.', 'warning'); return; }
            this.ctrl.ensureBucketParamsLoaded(readyOps);
            this.ctrl.modalManager.showModal('exportManager', { operations: readyOps });
        }

        // ═══════════════════════════════════════════════════════════════
        // Transform Fields
        // ═══════════════════════════════════════════════════════════════

        setupTransformFields() {
            // Position (X/Y) are RELATIVE nudges that rest at 0 - Apply adds
            // them to the committed position, then they snap back to 0.
            // Rotation/Scale are ABSOLUTE - inputs show live values and Apply
            // writes them verbatim. Each group has its own Apply/Reset.
            for (const fid of ['shape-x', 'shape-y']) {
                const el = document.getElementById(fid);
                if (!el) continue;
                el.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') { el.blur(); this.commitPosition(); }
                });
            }
            for (const fid of ['shape-rotation']) {
                const el = document.getElementById(fid);
                if (!el) continue;
                el.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') { el.blur(); this.commitRotation(); }
                });
            }
            for (const fid of ['shape-scale']) {
                const el = document.getElementById(fid);
                if (!el) continue;
                el.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') { el.blur(); this.commitScale(); }
                });
            }
            for (const fid of ['shape-mirror-x', 'shape-mirror-y']) {
                document.getElementById(fid)?.addEventListener('change', () => this.commitMirrorToggle());
            }

            // Position (X/Y nudge) - Apply adds to committed position; Reset reloads fields to 0.
            document.getElementById('shape-apply-transform')?.addEventListener('click', () => this.commitPosition());
            document.getElementById('shape-reset-transform')?.addEventListener('click', () => this.resetPosition());
            // Rotation - absolute, independent of scale.
            document.getElementById('shape-apply-rotation')?.addEventListener('click', () => this.commitRotation());
            document.getElementById('shape-reset-rotation')?.addEventListener('click', () => this.resetRotation());
            // Scale - absolute magnitude, preserves mirror sign and rotation.
            document.getElementById('shape-apply-scale')?.addEventListener('click', () => this.commitScale());
            document.getElementById('shape-reset-scale')?.addEventListener('click', () => this.resetScale());
            document.getElementById('shape-align-center')?.addEventListener('click', () => this.ctrl.alignSelectionTo('center'));
            document.getElementById('shape-align-bl')?.addEventListener('click', () => this.ctrl.alignSelectionTo('bottom-left'));
        }

        syncTransformFromSelection() {
            const anchorId = this.ctrl.selection.anchor();
            const node = anchorId ? this.ctrl.scene.findNode(anchorId) : null;
            if (!node) return;
            const t = node.transform;
            const set   = (id, v) => { const el = document.getElementById(id); if (el && document.activeElement !== el) el.value = v; };
            const check = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };

            // X/Y are relative nudges that rest at 0; rotation/scale/mirror are absolute.
            set('shape-x', (0).toFixed(2));
            set('shape-y', (0).toFixed(2));
            set('shape-rotation', t.rotation.toFixed(1));
            set('shape-scale', Math.abs(t.scaleX).toFixed(3));
            check('shape-mirror-x', t.scaleX < 0);
            check('shape-mirror-y', t.scaleY < 0);

            const meta = document.getElementById('shape-meta-size');
            if (meta) {
                const b = node.getLocalBounds();
                if (b) meta.textContent = `Size: ${(b.maxX - b.minX).toFixed(2)} x ${(b.maxY - b.minY).toFixed(2)} mm`;
            }
        }

        commitPosition() {
            const anchorId = this.ctrl.selection.anchor();
            if (!anchorId) return;
            const node = this.ctrl.scene.findNode(anchorId);
            if (!node) return;
            if (!this.ctrl.canMutateNode(node)) { this.syncTransformFromSelection(); this.setStatus('Item is locked', 'warning'); return; }

            const dx = parseFloat(document.getElementById('shape-x')?.value) || 0;
            const dy = parseFloat(document.getElementById('shape-y')?.value) || 0;
            if (dx === 0 && dy === 0) { this.syncTransformFromSelection(); return; }

            const t = node.transform;
            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId,
                { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY, rotationCenter: t.rotationCenter ?? null },
                { x: t.x + dx, y: t.y + dy }
            ));
        }

        // Shared guard: resolve the anchor node, bail (and resync) if locked/missing.
        resolveTransformTarget() {
            const anchorId = this.ctrl.selection.anchor();
            if (!anchorId) return null;
            const node = this.ctrl.scene.findNode(anchorId);
            if (!node) return null;
            if (!this.ctrl.canMutateNode(node)) {
                this.syncTransformFromSelection();
                this.setStatus('Item is locked', 'warning');
                return null;
            }
            return { anchorId, node, t: node.transform };
        }

        // Snapshot of the full committed transform, for SetShapeTransformCommand's `prev`.
        transformSnapshot(t) {
            return {
                x: t.x, y: t.y, rotation: t.rotation,
                scaleX: t.scaleX, scaleY: t.scaleY,
                rotationCenter: t.rotationCenter ?? null
            };
        }

        // Rotation is absolute. Scale and mirror are untouched.
        commitRotation() {
            const ctx = this.resolveTransformTarget();
            if (!ctx) return;
            const { anchorId, node, t } = ctx;

            const rotation = parseFloat(document.getElementById('shape-rotation')?.value) || 0;
            if (t.rotation === rotation) { this.syncTransformFromSelection(); return; }

            // Optional (no-op until getLocalMatrix's bounds fallback is removed):
            // pin the pivot once so the matrix stops depending on live bounds.
            const next = { rotation };
            if (!t.rotationCenter) {
                const b = node.getLocalBounds();
                if (b) next.rotationCenter = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
            }

            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId, this.transformSnapshot(t), next
            ));
        }

        // Scale is absolute magnitude. Mirror sign and rotation are preserved.
        commitScale() {
            const ctx = this.resolveTransformTarget();
            if (!ctx) return;
            const { anchorId, node, t } = ctx;

            const magRaw = parseFloat(document.getElementById('shape-scale')?.value);
            const mag = (Number.isFinite(magRaw) && magRaw > 0) ? magRaw : 1;
            const signX = t.scaleX < 0 ? -1 : 1;
            const signY = t.scaleY < 0 ? -1 : 1;
            const next = { scaleX: mag * signX, scaleY: mag * signY };

            if (t.scaleX === next.scaleX && t.scaleY === next.scaleY) {
                this.syncTransformFromSelection();
                return;
            }

            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId, this.transformSnapshot(t), next
            ));
        }

        // Reset rotation to 0 and release the pinned pivot; scale/mirror untouched.
        resetRotation() {
            const ctx = this.resolveTransformTarget();
            if (!ctx) return;
            const { anchorId, t } = ctx;
            if (t.rotation === 0 && t.rotationCenter == null) { this.syncTransformFromSelection(); return; }

            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId, this.transformSnapshot(t), { rotation: 0, rotationCenter: null }
            ));
        }

        // Reset scale magnitude to 1, keeping mirror sign; rotation untouched.
        resetScale() {
            const ctx = this.resolveTransformTarget();
            if (!ctx) return;
            const { anchorId, t } = ctx;
            const signX = t.scaleX < 0 ? -1 : 1;
            const signY = t.scaleY < 0 ? -1 : 1;
            if (Math.abs(t.scaleX) === 1 && Math.abs(t.scaleY) === 1) { this.syncTransformFromSelection(); return; }

            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId, this.transformSnapshot(t), { scaleX: signX, scaleY: signY }
            ));
        }

        // Position fields are relative nudges resting at 0 - Reset just reloads them.
        resetPosition() {
            this.syncTransformFromSelection();
        }

        // Mirror toggle is absolute and instant. It commits using the COMMITTED
        // x/y/rotation/scale (not the staged text inputs), so a toggle never
        // flushes a half-typed rotation or scale edit.
        commitMirrorToggle() {
            const anchorId = this.ctrl.selection.anchor();
            if (!anchorId) return;
            const node = this.ctrl.scene.findNode(anchorId);
            if (!node) return;
            if (!this.ctrl.canMutateNode(node)) { this.syncTransformFromSelection(); this.setStatus('Item is locked', 'warning'); return; }

            const t = node.transform;
            const mag = Math.abs(t.scaleX) || 1;
            const nextSX = mag * (document.getElementById('shape-mirror-x')?.checked ? -1 : 1);
            const nextSY = mag * (document.getElementById('shape-mirror-y')?.checked ? -1 : 1);
            if (t.scaleX === nextSX && t.scaleY === nextSY) return;

            this.ctrl.history.executeAndRecord(new SetShapeTransformCommand(
                anchorId,
                { x: t.x, y: t.y, rotation: t.rotation, scaleX: t.scaleX, scaleY: t.scaleY, rotationCenter: t.rotationCenter ?? null },
                { scaleX: nextSX, scaleY: nextSY }
            ));
        }

        // ═══════════════════════════════════════════════════════════════
        // Full render pass & history
        // ═══════════════════════════════════════════════════════════════

        renderAll() {
            this.navScenePanel?.refreshTree();
            this.navScenePanel?.syncTreeToolbar(this.ctrl.selection, this.ctrl.scene);
            this.syncTransformFromSelection();
            this.rebuildLayers();
            this.renderStatusBar();
        }

        updateHistoryButtons() {
            const h = this.ctrl.history;
            const undoBtn = document.getElementById('btn-undo');
            const redoBtn = document.getElementById('btn-redo');
            if (undoBtn) {
                undoBtn.disabled = !h.canUndo();
                undoBtn.title = h.getTopUndoLabel() ? `Undo: ${h.getTopUndoLabel()}` : 'Undo';
            }
            if (redoBtn) {
                redoBtn.disabled = !h.canRedo()
                redoBtn.title = h.getTopRedoLabel() ? `Redo: ${h.getTopRedoLabel()}` : 'Redo';
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Stock overlay
        // ═══════════════════════════════════════════════════════════════

        updateStockOverlay() {
            const s = this.ctrl.core.stock;
            const el = document.getElementById('overlay-stock-dims');
            if (el && s) el.textContent = `${s.width} x ${s.height} x ${s.thickness} mm`;
        }
    }

    window.EasyShapeUI = EasyShapeUI;
})();