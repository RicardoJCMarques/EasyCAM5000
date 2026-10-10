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
            this.id = operationId; // Same as the operation ID in core.operations[]
            this.type = type;
            this.label = label;
            this.shapeRefs = Array.isArray(shapeRefs) ? [...shapeRefs] : [shapeRefs];
            this.settings = {};
            this.cachedHasOffsets = false;
            this.cachedHasPreview = false;
        }

        /** Syncs primitives from scene current shapes into the operation in core. */
        syncPrimitives(core, scene) {
            const operation = core.store.getOperation(this.id);
            if (!operation) return; // REVIEW - Is this check necessary? Why?
            operation.primitives = [];
            operation.shapeKeyToNodeId = new Map(); // dense sourceId → scene node id
            // One mesh per operation: createAndGenerate refuses a selection with more.
            operation.sourceMesh = null;
            let shapeKeySeq = 0;
            const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            const growBounds = b => {
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
                // Baked by the world matrix so scaled or rotated footprints carve in
                // place; an identity matrix hands the mesh back untouched.
                if (shape.mesh?.triangles?.length) {
                    const res = Transform3D.transformTrianglesByAffine2D(shape.mesh.triangles, m, Math.hypot(m.a, m.b));
                    operation.sourceMesh = res.bounds3D
                        ? { ...shape.mesh, triangles: res.triangles, bounds3D: res.bounds3D }
                        : shape.mesh;
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
                if (transformed.contours)
                    for (const c of transformed.contours)
                        if (c.points)
                            for (const pt of c.points) (!pt.curveId || pt.curveId <= 0) && (pt.sourceId = sourceId);
                operation.primitives.push(transformed);
                growBounds(transformed.getBounds());
            }
            operation.bounds = isFinite(bounds.minX) ? bounds : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        /**
         * Input-renderer source for this bucket.
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

        get hasOffsets() { return this.cachedHasOffsets; }

        get hasPreview() { return this.cachedHasPreview; }

        /**
         * Invalidation is NOT mirrored here - it lives on the operation, and
         * resetOperationState clears it at the start of every generation.
         */
        syncStateFromOperation(core) {
            const op = core.store.getOperation(this.id)
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
            this.scene = null;
            this.artifactsFor = null; // (opType) => string[], one tree node per artifact
        }

        // Initialization
        init(containerId, scene, artifactsFor) {
            this.scene = scene;
            this.artifactsFor = artifactsFor;
            this.container = document.getElementById(containerId || 'operations-bucket-list');
            if (this.container) {
                UIControls.setupTreeKeyboard(this.container, [
                    { selector: '.bucket-header', idFrom: el => el.closest('.bucket-row')?.dataset.bucketId },
                    { selector: '.stage-node',    idFrom: el => el.closest('.bucket-row')?.dataset.bucketId }
                ], {
                    onSelect: (id, e) => e.target.click(),
                    onDelete: (bucketId, focused) => {
                        if (focused.classList.contains('bucket-header')) {
                            this.emit('action', { bucketId, action: 'delete' });
                            return;
                        }
                        const stage = focused.dataset.stage;
                        if (stage && stage !== 'geometry') {
                            this.emit('action', { bucketId, action: 'delete-stage', stage });
                        }
                    },
                    onKey: (key, id, focused) => {
                        if (key !== 'v' && key !== 'V') return;
                        const btn = focused.querySelector('.stage-visibility, .bucket-visibility');
                        if (btn) btn.click();
                    }
                });
            }
            this.updateEmptyState();
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
            const operation = core.store.createOperation(type, { label });
            const bucket = new OperationBucket(operation.id, type, label, shapeRefs);
            bucket.syncPrimitives(core, scene);
            this.buckets.set(operation.id, bucket);
            this.renderBucket(bucket, core);
            this.updateEmptyState();
            return operation.id;
        }

        /**
         * Detaches the bucket and its core operation and returns a token that
         * restoreBucket() can put back. The core operation is the bucket's other
         * half - a bucket without one has no parameters, offsets or toolpaths -
         * so the two are removed and restored together.
         */
        removeBucket(bucketId, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket) return null;
            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucketId}"]`);
            const domIndex = row ? Array.from(this.container.children).indexOf(row) : -1;
            row?.remove();

            const opToken = core ? core.detachOperation(bucketId) : null;
            this.buckets.delete(bucketId);
            if (this.selectedNode?.bucketId === bucketId) this.selectedNode = null;
            this.updateEmptyState();
            this.emit('bucketRemoved', { bucketId, bucket });
            return { bucket, opToken, domIndex, shapeRefs: [...bucket.shapeRefs] };
        }

        restoreBucket(token, core) {
            if (!token?.bucket) return false;
            const { bucket, opToken, domIndex, shapeRefs } = token;
            if (opToken && core) core.attachOperation(opToken);
            bucket.shapeRefs = [...shapeRefs];
            this.buckets.set(bucket.id, bucket);
            this.renderBucket(bucket, core);
            const row = this.container.querySelector(`.bucket-row[data-bucket-id="${bucket.id}"]`);
            const siblings = Array.from(this.container.children);
            if (row && domIndex >= 0 && domIndex < siblings.length - 1) {
                this.container.insertBefore(row, siblings[domIndex]);
            }
            this.updateEmptyState();
            this.emit('bucketRestored', { bucketId: bucket.id, bucket });
            return true;
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
         * Clears one artifact and everything downstream of it. Core owns the
         * cascade: preview.primitives ARE the offset primitives tagged in
         * place, and a toolpath cannot outlive the geometry it was built from.
         */
        clearBucketStage(bucketId, stage, core) {
            const bucket = this.buckets.get(bucketId);
            if (!bucket || !core) return;
            const op = core.store.getOperation(bucket.id);
            if (!op) return;

            if (stage === 'offsets') {
                core.store.resetOperationState(bucketId);
            } else {
                core.store.deleteOperationGeometry(bucketId, stage);
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
                .forEach(el => { el.classList.remove('selected'); el.setAttribute('aria-selected', 'false'); });

            target.classList.add('selected');
            target.setAttribute('aria-selected', 'true');

            // Tab re-entry follows the selection.
            this.container.querySelectorAll('[role="treeitem"][tabindex="0"]')
                .forEach(el => el.setAttribute('tabindex', '-1'));
            target.setAttribute('tabindex', '0');

            this.selectedNode = { bucketId, stage };
            this.emit('select', { bucketId, stage });
        }

        /**
         * Per-artifact visibility, stored on the OPERATION so it survives a bucket
         * DOM rebuild and matches how EasyTrace persists the same choice.
         * Unset reads as visible: a new artifact must never appear hidden.
         */
        isArtifactVisible(bucket, key, core) {
            return core.store.getOperation(bucket.id)?.layerVisibility?.[key] !== false;
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
            return core.store.getOperation(bucket.id)?.layerVisibility?.generated !== false;
        }

        toggleArtifactVisibility(bucketId, key, core) {
            const op = core.store.getOperation(bucketId);
            if (op) {
                op.layerVisibility = op.layerVisibility || {};
                op.layerVisibility[key] = op.layerVisibility[key] === false;
                this.updateBucketDOM(this.buckets.get(bucketId), core);
            }
        }

        // DOM Rendering
        buildStages(bucket, container, core) {
            container.innerHTML = '';
            // One node per ARTIFACT the chain declares. A 3D operation has no
            // preview node because tool compensation is already baked into
            // its field; a laser operation has only offsets.
            const artifacts = this.artifactsFor(bucket.type);
            const registry = core?.registry;

            const dimension = registry?.dimensionFor(bucket.type, core?.machineClassOf(core.store.getOperation(bucket.id)) || 'router') || null;

            for (const stage of artifacts) {
                const hasData = (stage === 'offsets' && bucket.hasOffsets) ||
                                (stage === 'preview' && bucket.hasPreview) ||
                                (stage !== 'offsets' && stage !== 'preview' &&
                                 !!core.store.getOperation(bucket.id)?.stamps?.[stage]);
                if (!hasData) continue;

                const stageLabel = registry?.artifactLabel(stage, dimension)
                    || (stage.charAt(0).toUpperCase() + stage.slice(1));
                const stageIcon = registry.artifactIcon(stage);

                const node = document.createElement('div');
                node.dataset.stage = stage;
                node.className = 'stage-node';
                node.setAttribute('role', 'treeitem');
                node.setAttribute('aria-level', '2');
                node.setAttribute('tabindex', '-1');
                node.setAttribute('aria-selected',
                    this.selectedNode?.bucketId === bucket.id && this.selectedNode?.stage === stage
                        ? 'true' : 'false');

                const isInvalidated = stage === 'offsets' && core &&
                    core.store.getOperation(bucket.id)?.isInvalidated && bucket.hasOffsets;

                if (isInvalidated) node.classList.add('is-invalidated');

                const visible = this.isArtifactVisible(bucket, stage, core);
                // Presentation only - the master is a separate key with its
                // own icon. Dimming is what tells the operator why a stage
                // eye that reads "shown" is not drawing anything.
                if (!this.isBucketVisible(bucket, core)) node.classList.add('is-muted');
                node.innerHTML = `
                    <span class="stage-icon"><svg class="cam-icon" width="14" height="14" aria-hidden="true"><use href="#${stageIcon}"></use></svg></span>
                    <span class="stage-label">${stageLabel}</span>
                    ${isInvalidated ? '<span class="visually-hidden">(invalidated, regenerate before export)</span>' : ''}
                    <button class="btn btn--icon btn--compact stage-visibility" data-action="visibility" tabindex="-1" title="${visible ? 'Hide' : 'Show'}" aria-label="Toggle ${stageLabel} visibility">
                        <svg class="cam-icon" width="12" height="12" aria-hidden="true"><use href="#${visible ? 'icon-eye' : 'icon-eye-off'}"></use></svg>
                    </button>
                    <button class="btn btn--icon btn--compact stage-delete" data-action="delete-stage" tabindex="-1" title="Delete ${stageLabel}" aria-label="Delete ${stageLabel}">
                        <svg class="cam-icon" width="12" height="12" aria-hidden="true"><use href="#icon-delete"></use></svg>
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

            // The header is the treeitem and the stage list is its group, but
            // they are DOM SIBLINGS - aria-owns is what makes the header own
            // the group without restructuring the row.
            const header = container.closest('.bucket-row')?.querySelector('.bucket-header');
            if (header) {
                if (container.children.length) {
                    header.setAttribute('aria-owns', container.id);
                    header.setAttribute('aria-expanded', 'true');
                } else {
                    header.removeAttribute('aria-owns');
                    header.removeAttribute('aria-expanded');
                }
            }
        }

        renderBucket(bucket, core = null) {
            const row = document.createElement('div');
            row.className = 'bucket-row';
            row.dataset.bucketId = bucket.id;
            row.dataset.op = bucket.type;
            // Structural wrapper only. The treeitem is the header, because the
            // header is what takes focus.
            row.setAttribute('role', 'none');

            // Header
            const header = document.createElement('div');
            header.className = 'bucket-header';
            header.setAttribute('role', 'treeitem');
            header.setAttribute('aria-level', '1');
            header.setAttribute('tabindex', '-1');
            header.setAttribute('aria-selected', 'false');

            const genVisible = this.isBucketVisible(bucket, core);
            header.innerHTML = `
                <span class="bucket-icon"><svg class="cam-icon" width="14" height="14" aria-hidden="true"><use href="#${core.registry.iconFor(bucket.type)}"></use></svg></span>
                <span class="bucket-label"></span>
                <span class="bucket-info">${bucket.shapeRefs.length} shape(s)</span>
                <button class="btn btn--icon btn--compact bucket-visibility" data-action="visibility" tabindex="-1" title="${genVisible ? 'Hide' : 'Show'} generated geometry" aria-label="Toggle generated geometry visibility">
                    <svg class="cam-icon" width="12" height="12" aria-hidden="true"><use href="#${genVisible ? 'icon-eye' : 'icon-eye-off'}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact bucket-delete" data-action="delete-bucket" tabindex="-1" title="Delete operation" aria-label="Delete operation">
                    <svg class="cam-icon" width="12" height="12" aria-hidden="true"><use href="#icon-delete"></use></svg>
                </button>
            `;

            let displayLabel = bucket.label;
            if (bucket.shapeRefs.length === 1) {
                const shape = this.scene.findShape(bucket.shapeRefs[0]);
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
            stages.id = `bucket-stages-${bucket.id}`;
            stages.setAttribute('role', 'group');
            row.appendChild(stages);

            this.buildStages(bucket, stages, core);

            // Insert before empty state
            const emptyState = document.getElementById('ops-empty-state');
            if (emptyState) {
                this.container.insertBefore(row, emptyState);
            } else {
                this.container.appendChild(row);
            }

            UIControls.seedRovingTabindex(this.container, '[role="treeitem"]');
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
            if (stages) {
                // buildStages replaces the whole subtree, focus included.
                UIControls.preserveTreeFocus(this.container, '[role="treeitem"]',
                    () => this.buildStages(bucket, stages, core));
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
                    UIControls.seedRovingTabindex(this.container, '[role="treeitem"]');
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

        // Queries
        getAllBuckets() { return Array.from(this.buckets.values()); }
    }

    window.NavOperationsPanel = NavOperationsPanel;
})();