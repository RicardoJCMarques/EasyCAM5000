/*!
 * @file        easyshape5000/ui-shape-operation-panel.js
 * @description Operation parameter panel for EasyShape5000.
 *              Renders staged parameter forms for the selected shape's
 *              assigned operation. Emits events for mutations -
 *              the controller decides what to execute.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    /** Operation title colour, resolved through the app's CSS operation map. */
    // REVIEW - EasyTrace5000 needs this too? Resolve inconsistency and fix --op-color vs --color-operation mismatches.
    const opColorVar = (opType) => `var(--op-color-${opType})`;

    const COMING_SOON_OPS = new Set(['pattern']);

    class ShapeOperationPanel extends BaseOperationPanel {
        constructor(ui) {
            super(ui);

            this.scene = null;
            this.selection = null;
            // Non-null while a bucket STAGE is showing. The panel has two
            // contexts with different id spaces (shape id vs operation/bucket
            // id) and currentOperationId alone cannot tell them apart.
            this.currentBucket = null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Hook Overrides
        // ═══════════════════════════════════════════════════════════════

        getIdPrefix() { return 'op-'; }

        getFormContainer() { return document.getElementById('operation-form-container'); }

        getPipelineType() { return 'cnc'; }

        init(scene, selection, core, paramManager, appProfile, lang) {
            this.scene = scene;
            this.selection = selection;
            this.initBase(core, paramManager, appProfile, lang);
        }

        normalizeForCommit(resolved) {
            // Shape panel: resolved is the shape node, operation is nested
            const shape = resolved;
            if (!shape?.operation) return null;
            // Also persist to the shape's local params via saveToSelection
            this.saveToSelection(shape.operation.type);
            return {
                id: shape.id,
                type: shape.operation.type,
                settings: shape.operation.params || {}
            };
        }

        /**
         * Two contexts, two persistence targets.
         *  - shape context: the base behaviour (commit into the shape's
         *    operation.params via normalizeForCommit).
         *  - bucket context: write the bucket's own settings. Until now
         *    OperationBucket.settings was initialised to {} and assigned
         *    NOWHERE, so showBucketStage's loadFromOperation always seeded
         *    from empty and the bucket's parameters lived only in the
         *    ParameterManager's in-memory state.
         */
        saveCurrentState() {
            if (!this.currentOperationId) return;

            if (this.currentBucket) {
                this.currentBucket.settings = {
                    ...this.currentBucket.settings,
                    ...this.parameterManager.getAllParameters(this.currentOperationId)
                };
                this.debug(`Saved bucket state for ${this.currentOperationId}`);
                return;
            }

            super.saveCurrentState();
        }

        clearProperties() {
            this.currentBucket = null;
            super.clearProperties();
        }

        /**
         * Geometry-stage changes make existing offsets stale. EasyShape had
         * no implementation of this hook, so flipping the Z datum, the blank
         * width or a workholding mode after generating left the OLD geometry
         * exportable - and because the generation-time value is stamped on
         * the primitives, the exported file silently used the old datum while
         * the panel showed the new one.
         *
         * Fires once per invalidation (isInvalidated latches) so a slider
         * drag doesn't spam the status bar. resetOperationState clears both
         * flags on the next generation.
         */
        checkInvalidation(paramName) {
            const bucket = this.currentBucket;
            if (!bucket) return;

            const def = this.parameterManager.parameterDefinitions[paramName];
            if (!def || def.stage !== 'geometry') return;

            const op = this.core.getOperation(bucket.id);
            if (!op || !op.offsets || op.offsets.length === 0) return;
            if (op.isInvalidated) return;

            this.core.invalidateOperationState(bucket.id);
            op.isInvalidated = true;
            op.invalidatedReason = `'${def.label || paramName}' changed after ` +
                `generation - regenerate before exporting.`;
            this.ui.setStatus(op.invalidatedReason, 'warning');
        }

        onMillHolesToggle(value) {
            const container = this.getFormContainer();
            if (container) {
                const values = this.parameterManager.getAllParameters(this.currentOperationId);
                ParameterManager.evaluateConditionals(container, values,
                    this.parameterManager.optionGates);
            }
            this.ui.setStatus(`Switched to ${value ? 'milling' : 'pecking'} mode`, 'info');
        }

        // ═══════════════════════════════════════════════════════════════
        // showOperationProperties
        // ═══════════════════════════════════════════════════════════════

        /**
         * Renders the operation form for the given shape into the container.
         *
         * @param {HTMLElement} container  The #operation-form-container element
         * @param {Object}      shape      The anchor shape from selection
         * @param {string}      stage      'geometry' | 'strategy' | 'machine'
         */
        showOperationProperties(container, shape) {
            if (!shape?.operation) {
                this.clearProperties();
                if (container) container.innerHTML = '';
                return;
            }

            this.currentBucket = null;
            const formStage = 'geometry';
            this.currentStage = formStage;

            const isSameShape = this.currentOperationId === shape.id;

            if (!isSameShape) {
                // Persist outgoing state before switching
                if (this.currentOperationId) this.saveCurrentState();
                this.currentOperationId = shape.id;

                // Load incoming shape's params into ParameterManager
                this.parameterManager.loadFromOperation({
                    id: shape.id,
                    type: shape.operation.type,
                    settings: shape.operation.params || {}
                });
            }

            if (!container) return;
            container.innerHTML = '';

            const opType = shape.operation.type;
            const values = this.parameterManager.getAllParameters(shape.id);

            // Mixed-operation warning
            this.renderMixedOpWarning(container, opType);

            // Header with operation name + remove button
            this.renderHeader(container, opType);

            // Parameter form (shared)
            this.renderParameterForm(container, opType, formStage, values);

            const actionInfo = this.getActionButtonInfo(formStage, opType);
            if (actionInfo) {
                container.appendChild(this.createActionButton(actionInfo.text, actionInfo.disabled));
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Fresh Selection + Bucket Stage
        // ═══════════════════════════════════════════════════════════════

        showFreshSelection(container, shapeId, opType) {
            this.currentOperationId = shapeId;
            this.currentBucket = null;
            this.currentStage = 'geometry';
            container.innerHTML = '';

            // Seed PM state with full default cascade so captureFormStateForId
            // can read toolDiameter and all other defaults. Without this,
            // getAllParameters() returns {} and offset distances become NaN.
            this.parameterManager.loadFromOperation({
                id: shapeId,
                type: opType,
                settings: {}
            });

            const values = this.parameterManager.getAllParameters(shapeId);
            this.renderParameterForm(container, opType, 'geometry', values);

            const wrapper = document.createElement('div');
            wrapper.className = 'property-actions';
            const btn = document.createElement('button');
            btn.className = 'btn btn--primary btn--block';
            btn.id = 'action-button';
            btn.textContent = 'Generate Offsets';
            btn.addEventListener('click', () => this.emit('createAndGenerate', { shapeId, opType }));
            wrapper.appendChild(btn);
            container.appendChild(wrapper);
        }

        /**
         * Renders params for a specific stage of an existing bucket.
         */
        showBucketStage(container, bucket, stage) {
            // The form below is rendered from getAllParameters(bucket.id), so
            // currentOperationId MUST be bucket.id: onParameterChange writes
            // through it, evaluateConditionals re-reads through it, and
            // onExternalParameterChange compares against it. Pointing it at
            // shapeRefs[0] made the panel read one store and write another -
            // conditionals re-evaluated against a different (possibly stale)
            // state than the values on screen.
            this.currentOperationId = bucket.id;
            this.currentBucket = bucket;
            container.innerHTML = '';

            const opType = bucket.type;

            // Tree nodes map onto the operation's OWN stage list: the header
            // is stage 0, each node below it is the next stage in order. A 3D
            // operation has no strategy stage, so its single node is machine.
            const stages = this.parameterManager.getStagesForPipeline(
                this.getPipelineType(), opType);
            const paramStage = stage === 'geometry' ? stages[0]
                             : stage === 'offsets'  ? (stages[1] || 'machine')
                             : (stages[2] || 'machine');
            // PARAMETER stage, not the UI stage name. setParameter keys state
            // by this, so 'offsets'/'preview' created phantom stage buckets
            // that getStageParameters never queries - they only surfaced at
            // all because getAllParameters merges every key it finds.
            this.currentStage = paramStage;

            // Load bucket settings into parameter manager
            this.parameterManager.loadFromOperation({
                id: bucket.id, type: opType, settings: bucket.settings
            });

            // Header
            const header = document.createElement('div');
            header.className = 'param-form-header';
            const title = document.createElement('span');
            title.className = 'op-title';
            title.style.color = opColorVar(opType);
            title.textContent = opType.charAt(0).toUpperCase() + opType.slice(1) + ' - ' + bucket.label;
            header.appendChild(title);
            container.appendChild(header);

            // Render Parameter form
            const values = this.parameterManager.getAllParameters(bucket.id);
            this.renderParameterForm(container, opType, paramStage, values);

            // Stage-appropriate action button
            const actionInfo = this.getBucketActionInfo(stage, bucket);
            if (actionInfo) {
                const wrapper = document.createElement('div');
                wrapper.className = 'property-actions';
                const btn = document.createElement('button');
                btn.className = 'btn btn--primary btn--block';
                btn.id = 'action-button';
                btn.textContent = actionInfo.text;
                btn.disabled = actionInfo.disabled;
                btn.addEventListener('click', () => this.emit('bucketAction', { bucketId: bucket.id, stage }));
                wrapper.appendChild(btn);
                container.appendChild(wrapper);
            }
        }

        /**
         * Shape context has no core operation - the id in currentOperationId is
         * a SHAPE id, and runGeneration resolves against core.operations. The
         * generate action there is bucket creation; only the bucket context has
         * an operation to regenerate, and it dispatches through 'bucketAction'
         * from showBucketStage. The base implementation is EasyTrace5000's.
         * REVIEW - EasyTrace5000 doesn't have a handleAction() method though?
         */
        async handleAction() {
            if (this.currentBucket) return super.handleAction();

            this.saveCurrentState();
            const shape = this.resolveCurrentOperation();
            if (!shape?.operation) return;
            this.emit('createAndGenerate', {
                shapeId: shape.id,
                opType: shape.operation.type
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Action Dispatch
        // ═══════════════════════════════════════════════════════════════

        resolveCurrentOperation() {
            const shape = this.scene.findShape(this.currentOperationId);
            return shape?.operation ? shape : null;
        }

        resolveOperationType(operation) {
            return operation?.operation?.type || '';
        }

        getSpinnerLabel(stage, opType) {
            if (stage === 'geometry') {
                // Field ops slice and compensate before any pass exists; the
                // handler's own ticks take over once jobs are dispatched.
                if (opType === 'relief' || opType === 'rotary') return 'Slicing model...';
                if (opType === 'vcarve') return 'Building medial skeleton';
                return 'Generating... pass 1'; // REVIEW - pass 1 isn't good enough, this isn't consistent now.
            }
            if (stage === 'strategy') return 'Generating preview...';
            return null;
        }

        async onGenerationSuccess(opId, operation) {
            if (this.ui.rebuildLayers) this.ui.rebuildLayers();
            this.ui.ctrl.refresh3DPlans?.();
        }

        onGenerationFailure(opId, operation, stage) { // EasyTrace5000 uses the base ,stage parameter.
            const container = this.getFormContainer();
            if (container) this.showOperationProperties(container, operation);
        }

        async onPreviewSuccess(opId, operation) {
            if (this.ui.rebuildLayers) this.ui.rebuildLayers();
            this.ui.ctrl.refresh3DPlans?.();
        }

        onStageTransition(newStage) {
            this.emit('stageChanged', newStage);
        }

        onExportStage(opId, operation) {
            this.emit('openExportManager', { opType: this.resolveOperationType(operation) });
        }

        // ═══════════════════════════════════════════════════════════════
        // Button Info
        // ═══════════════════════════════════════════════════════════════

        getActionButtonInfo(stage, opType) {
            if (COMING_SOON_OPS.has(opType)) {
                return { text: 'Coming Soon', disabled: true };
            }

            if (stage === 'geometry') {
                const labels = {
                    profile: 'Generate Profile Path',
                    pocket: 'Generate Pocket Paths',
                    drill: 'Generate Drill Strategy',
                    vcarve: 'Generate V-Carve Paths',
                    relief: 'Generate Relief Paths',
                    rotary: 'Generate Rotary Paths',
                    engrave: 'Generate Engrave Path'
                    // pattern: 'Generate Pattern' // Not Wired
                };
                return { text: labels[opType] || 'Generate', disabled: false };
            }
            if (stage === 'strategy') return { text: 'Generate Preview', disabled: false };
            if (stage === 'machine') return { text: 'Export Manager', disabled: false };
            return null;
        }

        getBucketActionInfo(stage, bucket) {
            if (stage === 'geometry') {
                return { text: bucket.hasOffsets ? 'Regenerate Offsets' : 'Generate Offsets', disabled: false };
            }
            const stages = this.parameterManager.getStagesForPipeline(
                this.getPipelineType(), bucket.type);
            if (stage === 'offsets') {
                return stages.includes('strategy')
                    ? { text: 'Generate Preview', disabled: !bucket.hasOffsets }
                    : { text: 'Export Manager',  disabled: !bucket.hasOffsets };
            }
            if (stage === 'preview') return { text: 'Export Manager', disabled: !bucket.hasPreview };
            return null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Save & Capture
        // ═══════════════════════════════════════════════════════════════

        /**
         * Parameter values from PM state for `sourceId`, filtered to the
         * definitions that apply to `opType`.
         */
        collectParamsForType(sourceId, opType) {
            const pm = this.parameterManager;
            const source = pm.getAllParameters(sourceId);
            const out = {};

            for (const [name, def] of Object.entries(pm.parameterDefinitions)) {
                if (!def.stage) continue;
                if (def.operationType && def.operationType !== opType) continue;
                if (def.operationTypes && !def.operationTypes.includes(opType)) continue;
                if (source[name] !== undefined) out[name] = source[name];
            }
            return out;
        }

        /**
         * Fans the current parameters out to every selected shape of the same
         * operation type. Values come from PM state, which onParameterChange
         * has already validated and clamped - re-reading the DOM here was a
         * second extraction path that ran on the debounce and could capture
         * half-typed input PM never accepted.
         */
        saveToSelection(opType) {
            if (!this.parameterManager || !this.currentOperationId) return;

            const values = this.collectParamsForType(this.currentOperationId, opType);
            for (const id of this.selection.toArray()) {
                const s = this.scene.findShape(id);
                if (!s?.operation || s.operation.type !== opType) continue;
                s.operation.params = { ...s.operation.params, ...values };
            }
        }

        /**
         * Re-keys the current form's parameters onto `targetId` (a bucket id),
         * routing each value by its own def.stage.
         *
         * `shapeIds` is the mirror target. A bucket action can fire while an
         * unrelated shape is selected, so the bucket's own refs must be passed
         * from that path - mirroring to the canvas selection wrote one bucket's
         * parameters onto another operation's shapes.
         */
        captureFormStateForId(targetId, opType, shapeIds = null) {
            clearTimeout(this.changeTimeout);

            const pm = this.parameterManager;
            const captured = this.collectParamsForType(this.currentOperationId, opType);

            for (const [name, value] of Object.entries(captured)) {
                pm.setParameter(targetId, pm.parameterDefinitions[name].stage, name, value);
            }

            for (const id of (shapeIds || this.selection.toArray())) {
                const s = this.scene.findShape(id);
                if (!s?.operation || s.operation.type !== opType) continue;
                s.operation.params = { ...s.operation.params, ...captured };
            }

            return captured;
        }

        // ═══════════════════════════════════════════════════════════════
        // Rendering Helpers
        // ═══════════════════════════════════════════════════════════════

        renderMixedOpWarning(container, opType) {
            const selIds = this.selection.toArray();
            const opTypes = new Set();
            for (const id of selIds) {
                const s = this.scene.findShape(id);
                if (s?.operation?.type) opTypes.add(s.operation.type);
            }
            if (opTypes.size <= 1) return;

            const warn = document.createElement('div');
            warn.className = 'warning-panel warning-panel--inline';
            warn.textContent = `Mixed operations selected. Changes apply only to ${opType} shapes.`;
            container.appendChild(warn);
        }

        renderHeader(container, opType) {
            const header = document.createElement('div');
            header.className = 'param-form-header';

            const title = document.createElement('span');
            title.className = 'op-title';
            title.style.color = opColorVar(opType);
            title.textContent = opType.charAt(0).toUpperCase() + opType.slice(1);
            header.appendChild(title);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'op-clear';
            removeBtn.textContent = 'Remove';
            removeBtn.addEventListener('click', () => this.emit('clearOp'));
            header.appendChild(removeBtn);

            container.appendChild(header);
        }
    }

    window.ShapeOperationPanel = ShapeOperationPanel;
})();