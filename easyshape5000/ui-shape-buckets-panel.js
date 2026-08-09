/*!
 * @file        easyshape5000/ui-shape-buckets-panel.js
 * @description Operation buckets panel
 *              Manages the operation list below the scene tree.
 *              Each bucket represents one CAM operation with three
 *              stage nodes: Geometry, Offsets, Preview.
 *              Emits events - the controller decides what to execute.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // Data Model
    // ═══════════════════════════════════════════════════════════════

    class OperationBucket {
        constructor(operationId, type, label, shapeRefs) {
            this.id = operationId;       // Same as the operation ID in core.operations[]
            this.type = type;
            this.label = label;
            this.shapeRefs = Array.isArray(shapeRefs) ? [...shapeRefs] : [shapeRefs];
            this.settings = {};
            this.cachedHasOffsets = false;
            this.cachedHasPreview = false;
        }

        /**
         * Syncs primitives from scene current shapes into the operation in core.
         */
        syncPrimitives(core, scene) {
            const operation = core.getOperation(this.id);
            if (!operation) return;

            operation.primitives = [];
            operation.sourceMesh = null;
            operation.shapeKeyToNodeId = new Map();   // dense sourceId → scene node id
            let shapeKeySeq = 0;
            const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

            const growBounds = (b) => {
                if (!b) return;
                if (b.minX < bounds.minX) bounds.minX = b.minX;
                if (b.minY < bounds.minY) bounds.minY = b.minY;
                if (b.maxX > bounds.maxX) bounds.maxX = b.maxX;
                if (b.maxY > bounds.maxY) bounds.maxY = b.maxY;
            };

            for (const sid of this.shapeRefs) {
                const shape = scene.findShape(sid);
                if (!shape?.primitive) continue;

                const m = shape.getWorldMatrix();

                // Relief mesh shapes: hand the (XY-transformed) triangle
                // soup to the operation - the 2D footprint rect is a
                // placeholder, not machinable geometry. ShapeReliefHandler
                // slices operation.sourceMesh into a heightmap on demand.
                if (shape.reliefMesh?.triangles?.length) {
                    operation.sourceMesh = this.transformReliefMesh(shape.reliefMesh, m);
                    growBounds(TransformMath.transformBounds(m, shape.getLocalBounds()));
                    continue;
                }

                const transformed = GeometryUtils.transformPrimitive(shape.primitive, m);
                if (!transformed) continue;

                // Per-operation dense identity (1..N).
                const sourceId = ++shapeKeySeq;
                (transformed.properties ||= {}).sourceId = sourceId;
                operation.shapeKeyToNodeId.set(sourceId, sid);

                // Stamp non-arc points so the Z channel carries identity through Clipper booleans.
                if (transformed.contours) {
                    for (const c of transformed.contours) {
                        if (!c.points) continue;
                        for (const pt of c.points) {
                            if (!pt.curveId || pt.curveId <= 0) pt.sourceId = sourceId;
                        }
                    }
                }

                operation.primitives.push(transformed);
                growBounds(transformed.getBounds());
            }

            operation.bounds = isFinite(bounds.minX) ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        /**
         * XY-transforms a relief mesh by the shape's world matrix so a
         * dragged/rotated footprint carves where it sits. Z passes through
         * untouched (heightmap normalizes it anyway). Identity matrix →
         * zero-copy passthrough.
         */
        // REVIEW - Why is this here? Feels like there are more suited places to leave this? Geometry Utils? 3d-math?
        transformReliefMesh(mesh, m) {
            if (TransformMath.isIdentity(m)) return mesh;

            // XY-ONLY, Z passes through. Correct for a flat relief footprint,
            // WRONG for any 3D body: a scaled shape gets two of its three
            // dimensions scaled and the third left alone, so a rotary blank
            // comes out with an elliptical cross-section (model lying along
            // the axis) or a correct cross-section on an unscaled axial length
            // (upright model, laid down by getVisualOrient). indexedBlankWidth
            // and the apothem both derive from those distorted bounds.
            // Similarity matrix ⇒ uniform scale = hypot(a, b).
            // TODO(mesh-3d) - promote mesh shapes to a real 3D TRS on the
            // scene node (Transform3D already has the algebra) so scale and
            // rotation apply to Z, and delete this warning.
            const sc = Math.hypot(m.a, m.b);
            if (Math.abs(sc - 1) > 1e-6) {
                console.warn(`[OperationBucket] Mesh shape has a ${sc.toFixed(3)}× ` +
                    'scale - only X and Y are scaled, mesh Z passes through ' +
                    'unscaled. 3D/rotary results from this shape will be distorted.');
            }

            const src = mesh.triangles;
            const out = new Float32Array(src.length);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < src.length; i += 3) {
                const x = src[i], y = src[i + 1];
                const tx = m.a * x + m.c * y + m.e;
                const ty = m.b * x + m.d * y + m.f;
                out[i] = tx; out[i + 1] = ty; out[i + 2] = src[i + 2];
                if (tx < minX) minX = tx; if (tx > maxX) maxX = tx;
                if (ty < minY) minY = ty; if (ty > maxY) maxY = ty;
            }
            return {
                ...mesh,
                triangles: out,
                bounds3D: { ...mesh.bounds3D, minX, minY, maxX, maxY }
            };
        }

        /**
         * Reads current state from the real operation in core.
         */
        getOperation(core) {
            return core.operations.find(op => op.id === this.id) || null;
        }

        get hasOffsets() { return this.cachedHasOffsets; }

        get hasPreview() { return this.cachedHasPreview; }

        /**
         * Refreshes cached flags from the real operation. Invalidation is NOT
         * mirrored here - it lives on the operation, and resetOperationState
         * clears it at the start of every generation.
         */
        syncStateFromOperation(core) {
            const op = this.getOperation(core);
            if (!op) return;
            this.cachedHasOffsets = op.offsets && op.offsets.length > 0;
            this.cachedHasPreview = op.preview?.ready === true;
        }

        /**
         * Updates cached flags from the real operation. Called after generation.
         */
        syncStateFromOperation(core) {
            const op = this.getOperation(core);
            if (!op) return;
            this.cachedHasOffsets = op.offsets && op.offsets.length > 0;
            this.cachedHasPreview = op.preview?.ready === true;
            // Clear invalidation after successful generation
            if (this.cachedHasOffsets) {
                this.isInvalidated = false;
                this.invalidatedReason = null;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Panel UI
    // ═══════════════════════════════════════════════════════════════

    class NavOperationsPanel extends EventEmitter {
        constructor() {
            // Event emitter
            super();

            this.container = null;
            this.buckets = new Map();
            this.selectedNode = null; // { bucketId, stage }
        }

        // Initialization
        init(containerId) {
            this.container = document.getElementById(containerId || 'operations-bucket-list');
            if (this.container) {
                this.container.addEventListener('keydown', (e) => this.handleKeydown(e));
            }
            this.updateEmptyState();
        }

        setSceneResolver(fn) {
            this._resolveScene = fn;
        }

        /**
         * (opType) => string[] - the operation's parameter stage list. The
         * tree draws one node per stage after 'geometry'.
         */
        setStageResolver(fn) {
            this._resolveStages = fn;
        }

        // Bucket CRUD
        /**
         * Creates a new operation bucket backed by a real operation in core.
         * @param {CamCore} core - The core instance
         * @param {Scene} scene - The scene instance
         * @param {string} type - Operation type
         * @param {string} label - Display label
         * @param {string[]} shapeRefs - Shape IDs from scene
         * @returns {string} The new bucket's ID (same as operation ID)
         */
        createBucket(core, scene, type, label, shapeRefs) {
            const operation = core.createOperation(type, { label });
            const bucket = new OperationBucket(operation.id, type, label, shapeRefs);
            bucket.syncPrimitives(core, scene);
            this.buckets.set(operation.id, bucket);
            this.renderBucket(bucket);
            this.updateEmptyState();
            return operation.id;
        }

        removeBucket(bucketId, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket) return;

            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucketId}"]`);
            if (row) row.remove();

            // Remove from core.operations[]
            // REVIEW - What is this doing exactly? Is it a connection to the core operation creation? The base operation could remain in the core?
            if (core) core.removeOperation(bucketId);

            this.buckets.delete(bucketId);

            if (this.selectedNode?.bucketId === bucketId) {
                this.selectedNode = null;
            }

            this.updateEmptyState();
            this.emit('bucketRemoved', { bucketId, bucket });
        }

        getBucket(bucketId) {
            return this.buckets.get(bucketId) || null;
        }

        /**
         * Returns all buckets that reference a given shape ID.
         */
        getBucketsForShape(shapeId) {
            const result = [];
            for (const bucket of this.buckets.values()) {
                if (bucket.shapeRefs.includes(shapeId)) result.push(bucket);
            }
            return result;
        }

        /**
         * Adds shape refs to an existing bucket. Invalidates if geometry was generated.
         */
        addShapesToBucket(bucketId, shapeIds, scene, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket) return;

            for (const id of shapeIds) {
                const node = scene.findNode(id);
                if (!node) continue;
                if (node.kind === 'group') {
                    for (const sid of scene.collectShapeIds(node)) {
                        if (!bucket.shapeRefs.includes(sid)) bucket.shapeRefs.push(sid);
                    }
                } else if (node.kind === 'shape') {
                    if (!bucket.shapeRefs.includes(id)) bucket.shapeRefs.push(id);
                }
            }

            if (core) bucket.syncPrimitives(core, scene);
            this.invalidateBucket(bucketId, 'Source geometry changed. Regenerate offsets.', core);
            this.updateBucketDOM(bucket, core);
        }

        removeShapeFromBucket(bucketId, shapeId, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket) return;
            bucket.shapeRefs = bucket.shapeRefs.filter(id => id !== shapeId);

            this.invalidateBucket(bucketId, 'Source geometry changed. Regenerate offsets.', core);
            this.updateBucketDOM(bucket, core);
        }

        // Generation State Updates

        /**
         * Called after handler.orchestrateGeneration succeeds.
         * Writes results into the bucket and updates the DOM.
         */
        updateBucketAfterGeneration(bucketId, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket) return;
            bucket.syncStateFromOperation(core);
            this.updateBucketDOM(bucket, core);
        }

        /**
         * Invalidation lives on the OPERATION. buildStages, addBucketLayers and
         * isExportReady all read it there, so a flag written on the bucket is
         * write-only: stale offsets kept rendering and stayed exportable after
         * their source shape moved.
         */
        invalidateBucket(bucketId, reason, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket || !core || !bucket.hasOffsets) return;

            const op = bucket.getOperation(core);
            if (!op || op.isInvalidated) return;

            core.invalidateOperationState(bucketId);
            op.isInvalidated = true;
            op.invalidatedReason = reason;
        }

        /**
         * Clears a specific stage's generated geometry.
         * Parallel to EasyTrace's handleDeleteGeometry.
         */
        clearBucketStage(bucketId, stage, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket || !core) return;

            const op = bucket.getOperation(core);
            if (!op) return;

            if (stage === 'preview') {
                op.preview = null;
                op.exportReady = false;
            } else if (stage === 'offsets') {
                // preview.primitives ARE the offset primitives, tagged in
                // place - keeping the preview after the offsets go leaves an
                // operation with zero paths that isExportReady answers true
                // for, and refresh3DPlans then builds a context for it.
                op.offsets = [];
                op.preview = null;
                op.exportReady = false;
            }

            bucket.syncStateFromOperation(core);
            this.updateBucketDOM(bucket, core);
            this.emit('stageCleared', { bucketId, stage });
        }

        // Selection
        selectStage(bucketId, stage) {
            // Clear all selection highlights
            this.container.querySelectorAll('.bucket-header.selected, .stage-node.selected')
                .forEach(el => el.classList.remove('selected'));

            this.selectedNode = { bucketId, stage };

            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucketId}"]`);
            if (!row) return;

            if (stage === 'geometry') {
                row.querySelector('.bucket-header')?.classList.add('selected');
            } else {
                const stageNode = row.querySelector(`.stage-node[data-stage="${stage}"]`);
                if (stageNode) {
                    stageNode.classList.add('selected');
                } else {
                    // Stage doesn't exist in DOM (data was deleted) - fall back to header
                    row.querySelector('.bucket-header')?.classList.add('selected');
                    this.selectedNode.stage = 'geometry';
                }
            }

            this.emit('select', { bucketId, stage: this.selectedNode.stage });
        }

        getSelectedBucketId() {
            return this.selectedNode?.bucketId || null;
        }

        getSelectedStage() {
            return this.selectedNode?.stage || null;
        }

        // DOM Rendering
        buildStages(bucket, container, core) {
            container.innerHTML = '';
            const stages = this._resolveStages?.(bucket.type)
                || ['geometry', 'strategy', 'machine'];
            // One node per stage after 'geometry'. A 3D operation has two
            // stages, so it gets one node and no separate preview step - its
            // preview artifact is built during generation.
            const intrinsicStages = stages.includes('strategy')
                ? ['offsets', 'preview']
                : ['offsets'];

            for (const stage of intrinsicStages) {
                const hasData = (stage === 'offsets' && bucket.hasOffsets) ||
                                (stage === 'preview' && bucket.hasPreview);
                if (!hasData) continue;

                const stageLabel = stage.charAt(0).toUpperCase() + stage.slice(1);

                const node = document.createElement('div');
                node.className = 'stage-node';
                node.dataset.stage = stage;
                node.setAttribute('tabindex', '-1');
                node.setAttribute('role', 'treeitem');

                const isInvalidated = stage === 'offsets' && core &&
                    bucket.getOperation(core)?.isInvalidated && bucket.hasOffsets;

                if (isInvalidated) node.classList.add('is-invalidated');

                node.innerHTML = `
                    <span class="stage-icon"><svg class="cam-icon" width="14" height="14"><use href="#icon-${stage}-stage"></use></svg></span>
                    <span class="stage-label">${stageLabel}</span>
                    <span class="stage-info"></span>
                    <button class="btn btn--icon btn--compact stage-delete" data-action="delete-stage" title="Delete ${stageLabel}">
                        <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                    </button>
                `;

                node.addEventListener('click', (e) => {
                    if (e.target.closest('[data-action]')) {
                        e.stopPropagation();
                        this.emit('action', {
                            bucketId: bucket.id,
                            action: 'delete-stage',
                            stage: stage
                        });
                        return;
                    }
                    this.selectStage(bucket.id, stage);
                });

                container.appendChild(node);
            }
        }

        renderBucket(bucket) {
            const row = document.createElement('div');
            row.className = 'bucket-row';
            row.dataset.bucketId = bucket.id;
            row.dataset.op = bucket.type;
            row.setAttribute('role', 'treeitem');

            // Header
            const header = document.createElement('div');
            header.className = 'bucket-header';
            header.setAttribute('tabindex', '-1');

            header.innerHTML = `
                <span class="bucket-icon"><svg class="cam-icon" width="14" height="14"><use href="#icon-op-${bucket.type}"></use></svg></span>
                <span class="bucket-label"></span>
                <span class="bucket-info">${bucket.shapeRefs.length} shape(s)</span>
                <button class="btn btn--icon btn--compact bucket-delete" data-action="delete-bucket" title="Delete operation" aria-label="Delete operation">
                    <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                </button>
            `;
            let displayLabel = bucket.label;
            if (bucket.shapeRefs.length === 1) {
                const shape = this._resolveScene?.()?.findShape(bucket.shapeRefs[0]);
                if (shape?.label && shape.label !== 'Shape') displayLabel = shape.label;
            }
            header.querySelector('.bucket-label').textContent = displayLabel;

            header.addEventListener('click', (e) => {
                if (e.target.closest('[data-action]')) {
                    e.stopPropagation();
                    const action = e.target.closest('[data-action]').dataset.action;
                    if (action === 'delete-bucket') {
                        this.emit('action', { bucketId: bucket.id, action: 'delete' });
                    }
                    return;
                }
                // Click header = select geometry stage
                this.selectStage(bucket.id, 'geometry');
            });

            row.appendChild(header);

            // Stage nodes
            const stages = document.createElement('div');
            stages.className = 'bucket-stages';

            this.buildStages(bucket, stages, null);

            row.appendChild(stages);

            // Insert before empty state
            const emptyState = document.getElementById('ops-empty-state');
            if (emptyState) {
                this.container.insertBefore(row, emptyState);
            } else {
                this.container.appendChild(row);
            }

            this.updateStageInfo(bucket, row, null);
        }

        updateBucketDOM(bucket, core) {
            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucket.id}"]`);
            if (!row) return;

            row.querySelector('.bucket-label').textContent = bucket.label;
            const infoEl = row.querySelector('.bucket-info');
            if (infoEl) infoEl.textContent = `${bucket.shapeRefs.length} shape(s)`;

            const stages = row.querySelector('.bucket-stages');
            if (stages) {
                this.buildStages(bucket, stages, core);
            }

            this.updateStageInfo(bucket, row, core);
        }

        updateStageInfo(bucket, row, core) {
            // Offsets info
            const offInfo = row.querySelector('.stage-node[data-stage="offsets"] .stage-info');
            if (offInfo) {
                const op = core ? bucket.getOperation(core) : null;
                if (op?.offsets?.length > 0) {
                    const count = op.offsets.reduce((s, o) => s + (o.primitives?.length || 0), 0);
                    offInfo.textContent = `${count} path(s)`;
                } else {
                    offInfo.textContent = '';
                }
            }

            // Preview info
            const prvInfo = row.querySelector('.stage-node[data-stage="preview"] .stage-info');
            if (prvInfo) {
                prvInfo.textContent = bucket.hasPreview ? 'Ready' : '';
            }
        }

        updateEmptyState() {
            const isEmpty = this.buckets.size === 0;

            const emptyState = document.getElementById('ops-empty-state');
            if (emptyState) {
                emptyState.style.display = isEmpty ? '' : 'none';
            }

            if (this.container) {
                if (isEmpty) {
                    this.container.removeAttribute('role');
                    this.container.removeAttribute('aria-label');
                } else {
                    this.container.setAttribute('role', 'tree');
                    this.container.setAttribute('aria-label', 'Operations');
                }
            }
        }

        refreshPanel() {
            if (!this.container) return;
            this.container.querySelectorAll('.bucket-row').forEach(r => r.remove());
            for (const bucket of this.buckets.values()) {
                this.renderBucket(bucket);
            }
            this.updateEmptyState();
        }

        // Keyboard Navigation
        handleKeydown(e) {
            if (!this.container) return;
            const focused = document.activeElement;
            if (!this.container.contains(focused)) return;

            const rows = Array.from(this.container.querySelectorAll('.bucket-header, .stage-node:not(.is-gated)'));
            const idx = rows.indexOf(focused);
            if (idx === -1) return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (rows[idx + 1]) { focused.setAttribute('tabindex', '-1'); rows[idx + 1].setAttribute('tabindex', '0'); rows[idx + 1].focus(); }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    if (rows[idx - 1]) { focused.setAttribute('tabindex', '-1'); rows[idx - 1].setAttribute('tabindex', '0'); rows[idx - 1].focus(); }
                    break;
                case 'Enter': case ' ':
                    e.preventDefault();
                    focused.click();
                    break;
                case 'Delete': case 'Backspace':
                    e.preventDefault();
                    if (focused.classList.contains('bucket-header')) {
                        const bucketId = focused.closest('.bucket-row')?.dataset.bucketId;
                        if (bucketId) this.emit('action', { bucketId, action: 'delete' });
                    } else if (focused.classList.contains('stage-node')) {
                        const bucketId = focused.closest('.bucket-row')?.dataset.bucketId;
                        const stage = focused.dataset.stage;
                        if (bucketId && stage !== 'geometry') {
                            this.emit('action', { bucketId, action: 'delete-stage', stage });
                        }
                    }
                    break;
            }
        }

        // Queries
        getAllBuckets() { return Array.from(this.buckets.values()); }

        getExportReadyBuckets() {
            return this.getAllBuckets().filter(b => b.exportReady);
        }
    }

    window.NavOperationsPanel = NavOperationsPanel;
    window.OperationBucket = OperationBucket;
})();