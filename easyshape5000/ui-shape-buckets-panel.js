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
         * Parameter-manager source for this bucket.
         *
         * bucket.settings is a FULL snapshot (saveCurrentState and
         * captureFormStateForId write the whole merged param set), unlike a
         * core operation's settings which holds only sparse overrides. So
         * every key in it is authoritative and must be declared as an
         * override - loadFromOperation reads opSettings ONLY inside the
         * userOverrides branch, and passing a bare literal made it fall
         * through to profile defaults and silently discard everything the
         * user had entered.
         */
        toParamSource() {
            const settings = this.settings || {};
            return {
                id: this.id,
                type: this.type,
                settings,
                userOverrides: Object.keys(settings)
            };
        }

       /** Reads current state from the real operation in core. */
        getOperation(core) {
            return core.getOperation(this.id) || null;
        }

        get hasOffsets() { return this.cachedHasOffsets; }

        get hasPreview() { return this.cachedHasPreview; }

        /**
         * Invalidation is NOT mirrored here - it lives on the operation, and
         * resetOperationState clears it at the start of every generation.
         */
        syncStateFromOperation(core) {
            const op = this.getOperation(core);
            if (!op) return;
            this.cachedHasOffsets = op.offsets && op.offsets.length > 0;
            this.cachedHasPreview = op.preview?.ready === true;
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
         * (opType) => string[] - the operation's Artifact list. The tree
         * draws one node per artifact. Renamed from setStageResolver: the
         * tree has never drawn parameter stages, and treating the two lists
         * as one is what produced the mislabelled node.
         */
        setArtifactResolver(fn) {
            this._resolveArtifacts = fn;
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
            this.renderBucket(bucket, core);
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
         * Clears one artifact and everything downstream of it. Core owns the
         * cascade: preview.primitives ARE the offset primitives tagged in
         * place, and a toolpath cannot outlive the geometry it was built from.
         */
        clearBucketStage(bucketId, stage, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket || !core) return;
            const op = bucket.getOperation(core);
            if (!op) return;

            if (stage === 'offsets') {
                core.resetOperationState(bucketId);
            } else if (stage === 'preview') {
                core.deleteOperationGeometry(bucketId, 'preview');
                op.exportReady = false;
                if (op.stamps) delete op.stamps.preview;
            } else {
                core.deleteOperationGeometry(bucketId, stage);
            }

            bucket.syncStateFromOperation(core);
            this.updateBucketDOM(bucket, core);
            this.emit('stageCleared', { bucketId, stage });
        }

        /**
         * Selects a bucket node and publishes it. The 'select' event is the
         * ONLY path to the right panel so an early return here silently
         * freezes the workflow rather than failing visibly.
         * @param {string} bucketId
         * @param {'geometry'|'offsets'|'preview'} stage
         * @param {Event} [e] - click event, when the node is already known
         */
        selectStage(bucketId, stage, e = null) {
            const row = this.container?.querySelector(`.bucket-row[data-bucket-id="${bucketId}"]`);
            if (!row) return;

            let target;
            if (stage === 'geometry') {
                target = row.querySelector('.bucket-header');
            } else {
                target = e?.target
                    ? e.target.closest('.stage-node')
                    : row.querySelector(`.stage-node[data-stage="${stage}"]`);

                // Stage node is gone (data was deleted) - fall back to geometry.
                if (!target) {
                    target = row.querySelector('.bucket-header');
                    stage = 'geometry';
                }
            }
            if (!target) return;

            // Single selection across the whole panel.
            this.container.querySelectorAll('.bucket-header.selected, .stage-node.selected')
                .forEach(el => el.classList.remove('selected'));

            target.classList.add('selected');
            this.selectedNode = { bucketId, stage };
            this.emit('select', { bucketId, stage });
        }

        /**
         * Per-artifact visibility, stored on the OPERATION so it survives a bucket
         * DOM rebuild and matches how EasyTrace persists the same choice.
         * Unset reads as visible: a new artifact must never appear hidden.
         */
        isArtifactVisible(bucket, key, core) {
            return bucket.getOperation(core)?.layerVisibility?.[key] !== false;
        }

        /**
         * The header eye is the bucket's GENERATED master - offsets, preview,
         * toolpath. It does NOT touch source: a shape's visibility belongs to
         * the scene tree and nowhere else, and two owners on one layer is how
         * an eye ended up open over geometry that would not draw.
         * Each icon reads exactly one key, so the header and the stage rows
         * cannot report different things about the same fact.
         */
        isBucketVisible(bucket, core) {
            return bucket?.getOperation(core)?.layerVisibility?.generated !== false;
        }

        toggleArtifactVisibility(bucketId, key, core) {
            const op = this.buckets.get(bucketId)?.getOperation(core);
            if (!op) return;
            op.layerVisibility ||= {};
            op.layerVisibility[key] = op.layerVisibility[key] === false;
            this.updateBucketDOM(this.buckets.get(bucketId), core);
        }

        // DOM Rendering
        buildStages(bucket, container, core) {
            container.innerHTML = '';
            // One node per ARTIFACT the chain declares. A 3D operation has no
            // preview node because tool compensation is already baked into
            // its field; a laser operation has only offsets.
            const artifacts = this._resolveArtifacts?.(bucket.type) || ['offsets', 'preview'];
            const registry = core?.registry;

            const dimension = registry?.dimensionFor(bucket.type, core?.machineClassOf(bucket.getOperation(core)) || 'router') || null;

            for (const stage of artifacts) {
                const hasData = (stage === 'offsets' && bucket.hasOffsets) ||
                                (stage === 'preview' && bucket.hasPreview) ||
                                (stage !== 'offsets' && stage !== 'preview' &&
                                 !!bucket.getOperation(core)?.stamps?.[stage]);
                if (!hasData) continue;

                const stageLabel = registry?.artifactLabel(stage, dimension)
                    || (stage.charAt(0).toUpperCase() + stage.slice(1));
                const stageIcon = registry?.artifactIcon(stage) || `icon-${stage}-stage`;

                const node = document.createElement('div');
                node.dataset.stage = stage;
                node.className = 'stage-node';

                const isInvalidated = stage === 'offsets' && core &&
                    bucket.getOperation(core)?.isInvalidated && bucket.hasOffsets;

                if (isInvalidated) node.classList.add('is-invalidated');

                const visible = this.isArtifactVisible(bucket, stage, core);
                // Presentation only - the master is a separate key with its
                // own icon. Dimming is what tells the operator why a stage
                // eye that reads "shown" is not drawing anything.
                if (!this.isBucketVisible(bucket, core)) node.classList.add('is-muted');
                node.innerHTML = `
                    <span class="stage-icon"><svg class="cam-icon" width="14" height="14"><use href="#${stageIcon}"></use></svg></span>
                    <span class="stage-label">${stageLabel}</span>
                    <button class="btn btn--icon btn--compact stage-visibility" data-action="visibility" title="${visible ? 'Hide' : 'Show'}" aria-label="Toggle ${stageLabel} visibility">
                        <svg class="cam-icon" width="12" height="12"><use href="#${visible ? 'icon-eye' : 'icon-eye-off'}"></use></svg>
                    </button>
                    <button class="btn btn--icon btn--compact stage-delete" data-action="delete-stage" title="Delete ${stageLabel}">
                        <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                    </button>
                `;

                node.addEventListener('click', e => {
                    const actionEl = e.target.closest('[data-action]');
                    if (actionEl) {
                        e.stopPropagation();
                        this.emit('action', { bucketId: bucket.id, action: actionEl.dataset.action, stage });
                        return;
                    }
                    this.selectStage(bucket.id, stage);
                });

                container.appendChild(node);
            }
        }

        renderBucket(bucket, core = null) {
            const row = document.createElement('div');
            row.className = 'bucket-row';
            row.dataset.bucketId = bucket.id;
            row.dataset.op = bucket.type;
            row.setAttribute('role', 'treeitem');

            // Header
            const header = document.createElement('div');
            header.className = 'bucket-header';
            header.setAttribute('tabindex', '-1');

            const genVisible = this.isBucketVisible(bucket, core);
            header.innerHTML = `
                <span class="bucket-icon"><svg class="cam-icon" width="14" height="14"><use href="#icon-op-${bucket.type}"></use></svg></span>
                <span class="bucket-label"></span>
                <span class="bucket-info">${bucket.shapeRefs.length} shape(s)</span>
                <button class="btn btn--icon btn--compact bucket-visibility" data-action="visibility" title="${genVisible ? 'Hide' : 'Show'} generated geometry" aria-label="Toggle generated geometry visibility">
                    <svg class="cam-icon" width="12" height="12"><use href="#${genVisible ? 'icon-eye' : 'icon-eye-off'}"></use></svg>
                </button>
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

            header.addEventListener('click', e => {
                const actionEl = e.target.closest('[data-action]');
                if (actionEl) {
                    e.stopPropagation();
                    const action = actionEl.dataset.action;
                    this.emit('action', { bucketId: bucket.id, action: 'delete-bucket' === action ? 'delete' : action, stage: 'generated' });
                    return;
                }
                this.selectStage(bucket.id, 'geometry');
            });

            row.appendChild(header);

            // Stage nodes
            const stages = document.createElement('div');
            stages.className = 'bucket-stages';

            this.buildStages(bucket, stages, core);

            row.appendChild(stages);

            // Insert before empty state
            const emptyState = document.getElementById('ops-empty-state');
            if (emptyState) {
                this.container.insertBefore(row, emptyState);
            } else {
                this.container.appendChild(row);
            }
        }

        updateBucketDOM(bucket, core) {
            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucket.id}"]`);
            if (!row) return;

            row.querySelector('.bucket-label').textContent = bucket.label;
            const infoEl = row.querySelector('.bucket-info');
            if (infoEl) infoEl.textContent = `${bucket.shapeRefs.length} shape(s)`;

            // The header is not inside the subtree buildStages rebuilds, so its
            // eye needs its own refresh or it renders the state it was born in.
            const visBtn = row.querySelector('.bucket-visibility');
            if (visBtn) {
                const genVisible = this.isBucketVisible(bucket, core);
                visBtn.title = (genVisible ? 'Hide' : 'Show') + ' generated geometry';
                visBtn.querySelector('use')?.setAttribute('href', genVisible ? '#icon-eye' : '#icon-eye-off');
                row.classList.toggle('is-generated-hidden', !genVisible);
            }

            const stages = row.querySelector('.bucket-stages');
            if (stages) this.buildStages(bucket, stages, core);
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

        /** Operation type assigned to a shape via bucket membership, or null. */
        getShapeOpType(shapeId) {
            for (const bucket of this.buckets.values()) {
                if (bucket.shapeRefs.includes(shapeId)) return bucket.type;
            }
            return null;
        }

        // Keyboard Navigation
        handleKeydown(e) {
            if (!this.container) return;
            const focused = document.activeElement;
            if (!this.container.contains(focused)) return;

            const rows = Array.from(this.container.querySelectorAll('.bucket-header, .stage-node'));
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
    }

    window.NavOperationsPanel = NavOperationsPanel;
    window.OperationBucket = OperationBucket;
})();