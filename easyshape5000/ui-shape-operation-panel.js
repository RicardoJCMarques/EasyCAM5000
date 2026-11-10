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

  /** Operation title colour, from the theme's operation palette. */
  const opColorVar = (opType) => `var(--color-operation-${opType})`;

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
      // The fresh-selection form on screen: its scene node, id, op type and
      // what it changed (name -> stage), so a rebuild of it can put that back.
      this.fresh = null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Hook Overrides
    // ────────────────────────────────────────────────────────────────────

    getIdPrefix() { return 'op-'; }

    getFormContainer() { return document.getElementById('operation-form-container'); }

    /**
     * EasyShape keeps its own init because scene and selection are its
     * state, not the base's. EasyTrace has no extra state and calls
     * initBase directly.
     */
    init(opts) {
      this.scene = opts.scene;
      this.selection = opts.selection;
      this.initBase(opts);
    }

    /**
     * The {id, type, settings} view parameterStore wants, with
     * userOverrides forwarded to the object that actually OWNS it.
     *
     * onParameterChange records overrides on the scene node or the
     * bucket; commitToOperation and loadFromOperation read them off
     * whatever object they are handed. A plain literal makes those two
     * different objects, and the failure is silent in both directions:
     * commit sees an empty set and takes its purge branch, deleting
     * every saved key, and load sees an empty set and resolves every
     * field from defaults. EasyTrace hands over the live operation, so
     * it never had the problem.
     */
    paramSourceFor(owner, type, settings) {
      return {
        id: owner.id,
        type,
        settings,
        get userOverrides() { return owner.userOverrides; },
        set userOverrides(value) { owner.userOverrides = value; }
      };
    }

    /**
     * Bucket context: the form is keyed by bucket id but its values also
     * mirror onto every shape the bucket references, and a value typed but
     * not yet in bucket.settings is not a userOverride, so commit alone
     * would delete it. Capture first, then commit.
     */
    saveCurrentState() {
      if (!this.currentOperationId) return;
      if (!this.currentBucket) { super.saveCurrentState(); return; }

      const bucket = this.currentBucket;
      const captured = this.captureFormStateForId(bucket.id, bucket.type, bucket.shapeRefs);
      bucket.settings = { ...bucket.settings, ...captured };
      this.parameterStore.commitToOperation(bucket.toParamSource());
      this.debug(`Saved bucket state for ${this.currentOperationId}`);
    }

    clearProperties() {
      this.currentBucket = null;
      this.fresh = null;
      super.clearProperties();
    }

    /** Notes each value a fresh-selection form changes, for showFreshSelection to put back. */
    onExternalParameterChange(change) {
      if (!this.currentBucket && this.fresh?.id === change.operationId) this.fresh.touched.set(change.name, change.stage);
      super.onExternalParameterChange(change);
    }

    /** Bucket tree draws the stage nodes; refresh them when stale. */
    onInvalidated(operation) {
      this.ui.opsPanel.updateBucketDOM(this.ui.opsPanel.getBucket(operation.id), this.core);
    }

    /**
     * A tooling change moves which fields exist and whether Generate is
     * allowed. Only the bucket context has a core operation behind it, so
     * the shape context just re-renders the form.
     */
    refreshOperationPanel(operation) {
      const container = this.getFormContainer();
      if (this.currentBucket) {
        // showBucketStage takes the NODE and renders the form after it,
        // so map the form on screen back to the node that shows it.
        const { stages, artifacts } = this.getOperationContext(this.currentBucket.type);
        const node = artifacts[stages.indexOf(this.currentStage) - 1] || 'geometry';
        this.showBucketStage(container, this.currentBucket, node);
        return;
      }
      if (this.currentOperationId && this.ui.activeOpType) this.showFreshSelection(container, this.currentOperationId, this.ui.activeOpType);
    }

    // ────────────────────────────────────────────────────────────────────
    // Fresh Selection + Bucket Stage
    // ────────────────────────────────────────────────────────────────────

    showFreshSelection(container, shapeId, opType) {
      const ps = this.parameterStore;
      const node = this.scene.findShape(shapeId);
      // A fresh shape has no operation to hold its edits: they live only in
      // the store, which loadFromOperation below resets. Rebuilding the same
      // form - a language switch, any Machine Settings edit - puts back what
      // it changed. Matching the node, not the id, keeps a cleared scene's
      // reused ids from inheriting old values.
      const same = !!node && this.fresh?.node === node && this.fresh.type === opType;
      const kept = [];
      if (same) {
        const current = ps.getAllParameters(shapeId);
        for (const [name, stage] of this.fresh.touched) {
          if (current[name] !== undefined) kept.push([stage, name, current[name]]);
        }
      }
      this.fresh = { node, id: shapeId, type: opType, touched: same ? this.fresh.touched : new Map() };
      this.currentOperationId = shapeId;
      this.currentBucket = null;
      this.currentStage = 'geometry';
      container.innerHTML = '';
      // Seed PM state with full default cascade so captureFormStateForId
      // can read toolDiameter and all other defaults. Without this,
      // getAllParameters() returns {} and offset distances become NaN.
      ps.loadFromOperation(node ? this.paramSourceFor(node, opType, {}) : { id: shapeId, type: opType, settings: {} });
      for (const [stage, name, value] of kept) ps.setParameter(shapeId, stage, name, value);
      const values = ps.getAllParameters(shapeId);
      this.renderParameterForm(container, opType, 'geometry', values);
      const wrapper = document.createElement("div");
      wrapper.className = "property-actions";
      const btn = document.createElement("button");
      btn.className = "btn btn--primary btn--block";
      btn.id = "action-button";
      const actionInfo = this.getActionButtonInfo("geometry", opType);
      btn.textContent = actionInfo?.text || i18n.t('panels.operation.actions.generate');
      btn.disabled = !!actionInfo?.disabled;
      btn.addEventListener("click", () => this.emit("createAndGenerate", { shapeId: shapeId, opType: opType }));
      wrapper.appendChild(btn);
      container.appendChild(wrapper);
    }

    /** Renders params for a specific stage of an existing bucket. */
    showBucketStage(container, bucket, stage) {
      // Save the form being left: an edit still inside propertyDebounce is
      // otherwise lost, and its pending save then writes the reloaded values back.
      this.saveCurrentState();
      // The form below is rendered from getAllParameters(bucket.id), so
      // currentOperationId MUST be bucket.id: onParameterChange writes
      // through it, applyConditionals re-reads through it, and
      // onExternalParameterChange compares against it.
      this.currentOperationId = bucket.id;
      this.currentBucket = bucket;
      this.fresh = null;
      container.innerHTML = '';
      const opType = bucket.type;
      // Positional indexing here renders the wrong stage under a node's caption.
      const { stages, artifacts } = this.getOperationContext(opType);
      const nodeIndex = artifacts.indexOf(stage);
      const paramStage = nodeIndex === -1 ? stages[0] : stages[nodeIndex + 1];
      this.currentStage = paramStage;
      // Load bucket settings into parameter manager
      this.parameterStore.loadFromOperation(bucket.toParamSource());
      const operation = this.core.store.getOperation(bucket.id);
      // Header
      const header = document.createElement('div');
      header.className = 'param-form-header';
      const title = document.createElement('span');
      title.className = 'op-title';
      title.style.color = opColorVar(opType);
      title.textContent = i18n.t('panels.inspector.operationTitle', { type: { key: `ops.${opType}.short` }, file: bucket.label });
      header.appendChild(title);
      container.appendChild(header);
      if (operation?.isInvalidated) container.appendChild(this.createInvalidationPanel(operation));
      // Render Parameter form
      const values = this.parameterStore.getAllParameters(bucket.id);
      this.renderParameterForm(container, opType, paramStage, values);
      if (paramStage === 'output' && operation) container.appendChild(this.createOutputBlock(operation));
      // Drill tooling sits directly above the action button, same as
      // EasyTrace. Bucket context only: the shape context has no core
      // operation yet, so there is no summary to describe.
      const card = this.createDrillToolingCard(operation, values, paramStage);
      if (card) container.appendChild(card);
      // Stage-appropriate action button
      const actionInfo = this.getBucketActionInfo(stage, bucket);
      if (actionInfo) {
        container.appendChild(this.createActionButton(actionInfo.text, actionInfo.disabled, actionInfo.title || ''));
      }
    }

    /**
     * Shape context has no core operation yet: currentOperationId is a
     * scene id and the action is bucket CREATION. Bucket context is the
     * shared stage table.
     */
    async handleAction() {
      // Shape context has no core operation and no stage chain; its
      // button emits createAndGenerate directly from showFreshSelection.
      if (!this.currentBucket) return;
      await super.handleAction();
    }

    /**
     * Node transforms are baked into pipeline space at generation, not at
     * edit time, so a moved shape needs a re-sync before every run.
     */
    async runGeneration(operationId, onProgress) {
      if (this.currentBucket?.id === operationId) this.currentBucket.syncPrimitives(this.core, this.scene);
      return super.runGeneration(operationId, onProgress);
    }

    // ────────────────────────────────────────────────────────────────────
    // Action Dispatch
    // ────────────────────────────────────────────────────────────────────

    /**
     * The object that owns userOverrides for whatever is being edited.
     * A BUCKET is its own owner - its id is not a scene node id, so
     * findShape returns null for it.
     */
    resolveCurrentOperation() {
      if (this.currentBucket) return this.currentBucket;
      const node = this.scene.findShape(this.currentOperationId);
      return node?.operation ? node : null;
    }

    /** Shape nodes carry `.operation.type`; buckets carry `.type`. */
    resolveOperationType(operation) {
      return operation?.operation?.type || operation?.type || '';
    }

    getSpinnerLabel(stage, opType) {
      if (stage === 'geometry') {
        // Field ops slice and compensate before any pass exists; the
        // handler's own ticks take over once jobs are dispatched.
        if (opType === 'relief' || opType === 'rotary') return i18n.t('progress.slicingModel');
        if (opType === 'vcarve') return i18n.t('progress.medialSkeleton');
      }
      return super.getSpinnerLabel(stage, opType);
    }

    async onGenerationSuccess(opId, operation) {
      await this.ui.rebuildLayers();
      this.selectArtifactNode(opId, 'offsets');
    }

    onGenerationFailure(opId, operation, stage) {
      const container = this.getFormContainer();
      // `operation` is a bucket here and has no `.operation` to render.
      if (this.currentBucket) this.showBucketStage(container, this.currentBucket, 'geometry');
    }

    async onPreviewSuccess(opId, operation) {
      await this.ui.rebuildLayers();
      this.selectArtifactNode(opId, 'preview');
    }

    async onToolpathSuccess(opId, operation) {
      await this.ui.rebuildLayers();
      this.selectArtifactNode(opId, "toolpath");
    }

    /**
     * Selecting the node the action just produced is what advances the
     * form: the tree's 'select' handler owns both showBucketStage and the
     * viewport route, so nothing else may re-render here.
     */
    selectArtifactNode(opId, artifact) {
      const panel = this.ui.opsPanel;
      if (!panel?.getBucket(opId)) return;
      panel.updateBucketAfterGeneration(opId, this.core);
      panel.selectStage(opId, artifact);
    }

    /** Drops the stale geometry, then shows the source form. */
    discardInvalidGeometry(operation) {
      this.ui.opsPanel.clearBucketStage(operation.id, 'offsets', this.core);
      this.ui.opsPanel.selectStage(operation.id, 'geometry');
    }

    // ────────────────────────────────────────────────────────────────────
    // Button Info
    // ────────────────────────────────────────────────────────────────────

    getActionButtonInfo(stage, opType) {
      if (COMING_SOON_OPS.has(opType)) return { text: i18n.t('panels.operation.actions.comingSoon'), disabled: true };

      if (stage === 'geometry') {
        const labels = {
          profile: i18n.t('ops.profile.generate'),
          pocket: i18n.t('ops.pocket.generate'),
          drill: i18n.t('ops.drill.generate'),
          vcarve: i18n.t('ops.vcarve.generate'),
          relief: i18n.t('ops.relief.generate'),
          rotary: i18n.t('ops.rotary.generate'),
          engrave: i18n.t('ops.engrave.generate')
          // pattern: 'Generate Pattern' // Not Wired
        };
        return { text: labels[opType] || i18n.t('panels.operation.actions.generate'), disabled: false };
      }
      if (stage === 'strategy') return { text: i18n.t('panels.operation.actions.preview'), disabled: false };
      if (stage === 'machine') return { text: i18n.t('panels.operation.actions.toolpaths'), disabled: false };
      if (stage === 'output') return { text: i18n.t('panels.operation.actions.exportManager'), disabled: false };
      return null;
    }

    getBucketActionInfo(stage, bucket) {
      if ('geometry' === stage) {
        const text = bucket.hasOffsets ? i18n.t('panels.operation.actions.regenerateOffsets') : i18n.t('panels.operation.actions.offsets');
        if ('drill' === bucket.type) {
          const operation = this.core.store.getOperation(bucket.id);
          const settings = this.parameterStore.getAllParameters(bucket.id);
          const info = operation ? DrillHandler.describeTable(operation, settings) : null;
          if (info && 'perSize' === info.mode) {
            return { text, disabled: !info.complete, title: info.complete ? '' : i18n.format(info.reason) };
          }
        }
        return { text, disabled: false };
      }
      
      const { artifacts } = this.getOperationContext(bucket.type);
      const nodeIndex = artifacts.indexOf(stage);
      if (nodeIndex === -1) return null;

      const produces = artifacts[nodeIndex + 1];
      const hasThis = stage === 'offsets' ? bucket.hasOffsets
                    : stage === 'preview' ? bucket.hasPreview
                    : !!this.core.store.getOperation(bucket.id)?.stamps?.[stage];

      if (!produces) {
        return {
          text: stage === 'toolpath' ? i18n.t('panels.operation.actions.exportGcode') : i18n.t('panels.operation.actions.exportManager'),
          disabled: !hasThis
        };
      }

      const LABELS = { preview: i18n.t('panels.operation.actions.preview'), toolpath: i18n.t('panels.operation.actions.toolpaths') };
      return { text: LABELS[produces] || i18n.t('panels.operation.actions.generateArtifact', { artifact: { key: ['artifacts', produces, 'label'] } }), disabled: !hasThis };
    }

    // ────────────────────────────────────────────────────────────────────
    // Save & Capture
    // ────────────────────────────────────────────────────────────────────

    /**
     * Parameter values from PM state for `sourceId`, filtered to the
     * definitions that apply to `opType`.
     */
    collectParamsForType(sourceId, opType) {
      const pm = this.parameterStore;
      const source = pm.getAllParameters(sourceId);
      const out = {};

      for (const [name, def] of Object.entries(pm.parameterDefinitions)) {
        if (!def.stage) continue;
        if (def.operationTypes && !def.operationTypes.includes(opType)) continue;
        if (source[name] !== undefined) out[name] = source[name];
      }
      return out;
    }

    /**
     * Re-keys the current form's parameters onto `targetId` (a bucket id),
     * routing each value by its own def.stage.
     * `shapeIds` is the mirror target. A bucket action can fire while an
     * unrelated shape is selected, so the bucket's own refs must be passed
     * from that path - mirroring to the canvas selection wrote one bucket's
     * parameters onto another operation's shapes.
     */
    captureFormStateForId(targetId, opType, shapeIds = null) {
      clearTimeout(this.changeTimeout);
      const pm = this.parameterStore;
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
  }

  window.ShapeOperationPanel = ShapeOperationPanel;
})();