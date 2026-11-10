/*!
 * @file        ui/ui-base-operation-panel.js
 * @description Shared operation panel base class.
 *              Owns parameter form rendering, change handling, stage dispatch,
 *              generation/preview pipeline, and action button logic.
 *              Subclasses override hooks for app-specific behavior.
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

  class BaseOperationPanel extends EventEmitter {
    constructor(ui) {
      super();
      this.ui = ui;
      this.core = null;
      this.parameterStore = null;
      this.inputRenderer = null;
      this.toolLibrary=null;this.appProfile=null;
      // Active state
      this.currentOperationId = null;
      this.currentStage = 'geometry';
      // Debounce for auto-save
      this.changeTimeout = null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Initialization - called by subclass init()
    // ────────────────────────────────────────────────────────────────────

    /**
     * @param {Object} o
     * @param {CamCore} o.core
     * @param {ParameterStore} o.store
     * @param {InputRenderer} o.renderer
     * @param {Object} o.appProfile
     */
    initBase({ core, store, renderer, appProfile }) {
      this.core = core;
      this.parameterStore = store;
      this.inputRenderer = renderer;
      this.toolLibrary = core?.toolLibrary || null;
      this.appProfile=appProfile;
      this.parameterStore.addChangeListener(change => this.onExternalParameterChange(change));
    }

    // ────────────────────────────────────────────────────────────────────
    // Abstract hooks - subclasses MUST override
    // ────────────────────────────────────────────────────────────────────

    /** @returns {string} 'prop-' for EasyTrace, 'op-' for EasyShape */
    getIdPrefix() {
      throw new Error('getIdPrefix() not implemented');
    }

    /** @returns {HTMLElement|null} The container element for the parameter form */
    getFormContainer() {
      throw new Error('getFormContainer() not implemented');
    }

    /**
     * Stamp first: an operation carries the class it was created under, and
     * the stencil picker can move it. Falls back to the session for a shape
     * that has no core operation behind it yet.
     * @returns {string} 'router' | 'laser' | 'knife'
     */
    getMachineClass(operationType) {
      const current = this.resolveCurrentOperation();
      const op = current && this.resolveOperationType(current) === operationType ? this.core.store.getOperation(current.id) : null;
      return op ? this.core.machineClassOf(op) : this.core.machineClassForType(operationType);
    }

    /**
     * Everything stage-shaped reads from here so the machine class and
     * dimension are resolved ONCE per form render.
     */
    getOperationContext(operationType) {
      const registry = this.core.registry;
      const machineClass = this.getMachineClass(operationType);
      return {
        machineClass,
        dimension: registry?.dimensionFor(operationType, machineClass) || null,
        stages: this.parameterStore.getStages(operationType, machineClass),
        artifacts: this.parameterStore.getArtifacts(operationType, machineClass)
      };
    }

    /** Persist current form state to the operation/shape model */
    saveCurrentState() {
      if (!this.currentOperationId) return;
      const operation = this.resolveCurrentOperation();
      if (!operation) return;
      this.parameterStore.commitToOperation(operation);
      this.debug(`Saved state for ${this.currentOperationId}`);
    }

    /** Renders the parameter form for the given operation/shape. */
    showOperationProperties(container, operation, stage) {
      throw new Error('showOperationProperties() not implemented');
    }

    /** Label and enablement for the panel's primary action button.
     * @param {string} stage current stage id
     * @param {string} opType operation type
     * @returns {{text: string, disabled: boolean}}
     */
    getActionButtonInfo(stage, opType) {
      return { text: i18n.t('panels.operation.actions.generate'), disabled: false }
    }

    /**
     * millHoles and drillMultiTool both move which surface owns tool
     * identity, so the table is re-derived and the whole panel rebuilt.
     * Shared by both apps deliberately: a per-app copy is how EasyShape
     * ended up toggling millHoles without invalidating anything.
     */
    onDrillToolingChange(name, value) {
      // A shape in EasyShape has no core operation until it joins a bucket.
      const operation = this.core.store.getOperation(this.currentOperationId) || null;
      if (operation) {
        try {
          this.core.getHandler('drill').ensureDrillTable(operation);
        } catch (e) {
          this.debug(`Drill table refresh skipped: ${e.message}`);
        }
      }
      this.refreshOperationPanel(operation);
      const key = 'drillMultiTool' === name
        ? (value ? 'messages.drill.multiToolOn' : 'messages.drill.multiToolOff')
        : (value ? 'messages.drill.modeMilling' : 'messages.drill.modePecking');
      this.ui.setStatus(i18n.t(key), 'info');
    }

    /**
     * A parameter changed, bump that stage's revision and let the core
     * work out whether anything downstream went stale.
     */
    checkInvalidation(paramName) {
      const target = this.resolveCurrentOperation();
      if (!target) return;
      const op = this.core.store.getOperation(target.id);
      if (!op) return;
      const def = this.parameterStore.parameterDefinitions[paramName];
      if (!def || !def.stage) return;
      // Identity-carrying fields (tool number, labels) move no geometry but reach
      // the program: '__identity' is a revision no chain stage reads, so it moves
      // the export cache key and stales nothing.
      if (def.invalidates === false) {
        this.core.store.bumpOperationRevision(op.id, '__identity');
        return;
      }
      this.core.store.bumpOperationRevision(op.id, def.stage);
      const reason = {
        key: 'messages.operations.paramChanged',
        values: { param: { key: `params.${paramName}.label` } }
      };
      if (this.core.store.refreshStaleFlags(op.id, reason)) {
        this.ui.setStatus(op.invalidatedReason, 'warning');
        this.ui.ctrl.refresh3D();
      }
      this.onInvalidated(op);
    }

    /** App hook: refresh whichever tree draws this operation's nodes. */
    onInvalidated(operation) {}

    // ────────────────────────────────────────────────────────────────────
    // Shared Form Rendering
    // ────────────────────────────────────────────────────────────────────

    /** Renders parameter fields grouped by category into a container. */
    renderParameterForm(container, opType, stage, values) {
      const store = this.parameterStore;
      const ctx = this.getOperationContext(opType);
      const groups = {};
      for (const param of store.getStageParameters(stage, opType, ctx)) {
        (groups[param.category || 'general'] ||= []).push(param);
      }
      // Profile order (ui.categories, a list of ids). Undeclared categories
      // fall to the end in the order they were met - the sort is stable.
      const declared = this.appProfile.ui.categories;
      const rank = k => {
        const i = declared.indexOf(k);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      const prefix = this.getIdPrefix();
      for (const cat of Object.keys(groups).sort((a, b) => rank(a) - rank(b))) {
        const section = document.createElement('div');
        section.className = 'property-section';
        section.dataset.category = cat;
        const h3 = document.createElement('h3');
        h3.textContent = i18n.t(`categories.${cat}`);
        section.appendChild(h3);
        for (const p of groups[cat]) {
          const val = values[p.name] !== undefined ? values[p.name] : p.default;
          section.appendChild(this.inputRenderer.createField(p, val, {
            idPrefix: prefix,
            opType: opType,
            toolLibrary: this.toolLibrary,
            onChange: (name, newVal, el) => this.onParameterChange(name, newVal, el, opType)
          }));
        }
        container.appendChild(section);
      }
      this.inputRenderer.refreshFields(container, values, store.optionGates);
      UIControls.setupPropertyGridNavigation(container);
    }

    // ────────────────────────────────────────────────────────────────────
    // Unified Parameter Change Handler
    // ────────────────────────────────────────────────────────────────────

    onParameterChange(name, value, inputEl, opType) {
      if (!this.currentOperationId) return;
      // Register explicit user choice so defaults don't overwrite it later
      const op = this.resolveCurrentOperation();
      if (op) {
        if (!op.userOverrides) op.userOverrides = new Set();
        if (Array.isArray(op.userOverrides)) op.userOverrides = new Set(op.userOverrides);
        // Track explicitly edited parameter
        op.userOverrides.add(name);
      }
      const ps = this.parameterStore;
      const getStage = paramName => ps.parameterDefinitions[paramName]?.stage || this.currentStage;
      // Tool selection change - sync all tool attributes
      if (inputEl?.tagName === 'SELECT' && (name === 'tool' || name.endsWith('Tool')) && this.toolLibrary) {
        const tool = this.toolLibrary.getTool(value);
        if (tool) this.syncToolParameters(tool, opType);
      }
      // Validate through ParameterStore. A clamped value goes back into
      // the field; the status bar says why.
      const result = ps.setParameter(this.currentOperationId, getStage(name), name, value);
      const corrected = result.correctedValue !== undefined;
      if (corrected) inputEl.value = result.correctedValue;
      const invalid = !result.success && !corrected;
      inputEl.classList.toggle('input-error', invalid);
      if (invalid) inputEl.setAttribute('aria-invalid', 'true');
      else inputEl.removeAttribute('aria-invalid');
      if (result.error) this.ui.setStatus(result.error, 'error');
      // A parameter may own the operation's machine class. That changes
      // which parameters exist and how many stages the chain has, so the
      // form is rebuilt rather than patched.
      // CNC Stencil only, for diode/co2 lasers, vinyl cutters or drag knife machines
      const boundDef = ps.parameterDefinitions[name];
      if (boundDef?.bindsMachineClass) {
        clearTimeout(this.changeTimeout);
        const target = this.core.store.getOperation(this.currentOperationId);
        if (target) {
          const machine = { key: ['params', name, 'options', value] };
          target.machineClass = value;
          this.core.store.bumpOperationRevision(target.id, 'geometry');
          this.core.store.refreshStaleFlags(target.id, {key: 'messages.operations.machineChanged', values: {machine}});
          this.saveCurrentState();
          this.currentStage = this.getOperationContext(opType).stages[0];
          this.onInvalidated(target);
          this.refreshOperationPanel(target);
        }
        return;
      }
      // millHoles and drillMultiTool both move which surface owns tool
      // identity, so the panel is rebuilt rather than patched.
      // checkInvalidation is called here because the early return skips
      // the shared call below it.
      if ('millHoles' === name || 'drillMultiTool' === name) {
        clearTimeout(this.changeTimeout);
        this.saveCurrentState();
        this.checkInvalidation(name);
        this.onDrillToolingChange(name, value);
        return;
      }
      // Invalidate generated geometry when source params change
      this.checkInvalidation(name);
      // Re-evaluate conditionals from PS state (single source of truth)
      const formContainer = this.getFormContainer();
      if (formContainer) {
        const allParams = ps.getAllParameters(this.currentOperationId);
        this.inputRenderer.refreshFields(formContainer, allParams, ps.optionGates);
      }
      // Debounced auto-save
      if (result.success) {
        clearTimeout(this.changeTimeout);
        this.changeTimeout = setTimeout(() => this.saveCurrentState(), D.ui.timing.propertyDebounce);
      }
    }

    syncToolParameters(tool, opType) {
      if (!tool || !this.currentOperationId) return;
      const ps = this.parameterStore;
      // onExternalParameterChange writes each value into its input.
      for (const [name, value] of Object.entries(ps.toolValues(tool, opType))) {
        ps.setParameter(this.currentOperationId, ps.parameterDefinitions[name].stage || this.currentStage, name, value);
      }
    }

    onExternalParameterChange(change) {
      if (change.operationId !== this.currentOperationId) return;
      const input = document.getElementById(`${this.getIdPrefix()}${change.name}`);
      if (!input) return;
      if (input.type === 'checkbox') input.checked = change.value;
      else input.value = change.value;
    }

    // ────────────────────────────────────────────────────────────────────
    // Stage Management
    // ────────────────────────────────────────────────────────────────────

    refresh() {
      const op = this.resolveCurrentOperation();
      this.refreshOperationPanel(op);
    }

    clearProperties() {
      this.currentOperationId = null;
      this.currentStage = null;
      clearTimeout(this.changeTimeout);
    }

    // ────────────────────────────────────────────────────────────────────
    // Generation & Preview Pipeline
    // ────────────────────────────────────────────────────────────────────

    /**
     * Calls the operation handler's orchestrateGeneration.
     * @param {string} operationId
     * @param {Function} [onProgress] - the task's tick
     */
    async runGeneration(operationId, onProgress = null) {
      const operation = this.core.store.getOperation(operationId);
      if (!operation) return { success: false, message: i18n.t('messages.operations.notFound', { id: operationId }), status: 'error' };
      let handler;
      try {
        handler = this.core.getHandler(operation.type);
      } catch (e) {
        return {
          success: false,
          message: i18n.t('messages.operations.noHandler',{ type: operation.type, error: e }),
          status: 'warning'
        };
      }
      const params = this.parameterStore.getAllParameters(operationId);
      const multiToolDrill = 'drill' === operation.type && true === params.drillMultiTool;
      if (multiToolDrill) {
        const info = DrillHandler.describeTable(operation, params);
        if (!info.complete)  return {
          success: false,
          status: 'warning',
          message: info.reason || i18n.t('messages.drill.completeTooling')
        };
      }
      const toolNumDef = this.parameterStore.parameterDefinitions.toolNumber;
      const toolNumApplies = toolNumDef && !multiToolDrill && (!toolNumDef.operationTypes || toolNumDef.operationTypes.includes(operation.type));
      if (toolNumApplies) {
        const toolNum = Number(params.toolNumber);
        if (!Number.isInteger(toolNum) || toolNum < 1) return {
          success: false,
          status: 'warning',
          message: i18n.t('messages.operations.needToolNumber')
        };
      }
      try {
        const result = await handler.orchestrateGeneration(operation, params, this.core, { onProgress });
        if (result?.success) this.core.store.stampArtifact(operationId, 'offsets');
        return this.withDepthWarning(result, operation, params);
      } catch (e) {
        // Cancel rejects the run's worker jobs: not a failure to log.
        if (!e.cancelled) console.error(`[BaseOperationPanel] Generation failed for ${operation.type}:`, e);
        return {
          success: false,
          message: i18n.t('messages.operations.generationFailed', { error: e }),
          status: 'error'
        };
      } finally {
        operation._onProgress = null;
      }
    }

    /**
     * Calculates machine-ready plans for ONE operation and hands them to
     * the 3D view. Deliberately NOT the same artifact the exporter
     * builds: see CamCore.computeToolpaths for the three batch-stateful
     * behaviours that make a per-operation plan a per-operation plan.
     */
    async runToolpaths(operationId) {
      const operation = this.core.store.getOperation(operationId);
      if (!operation) return {
        success: false,
        message: i18n.t('messages.operations.notFound', { id: operationId }),
        status: 'error'
      };
      const params = this.parameterStore.getAllParameters(operationId) || {};
      // Feeds are the one parameter with no safe default anywhere in the
      // stack. F0 is not "use the last feed": Grbl and grblHAL reject it
      // (error:22), LinuxCNC and Fanuc-style controls alarm, and Marlin
      // silently keeps the PREVIOUS modal feed - so a zero here cuts at
      // whatever the operation before it was set to. NaN reaches the post
      // as the literal FNaN.
      // Number.isFinite, never truthiness: 0 is a legal coordinate but
      // never a legal feed, and those are different tests.
      const unset = ['feedRate', 'plungeRate'].filter(name => !(Number.isFinite(params[name]) && params[name] > 0));
      if (unset.length) {
        return {
          success: false,
          status: 'warning',
          message: i18n.t('messages.toolpaths.needFeeds', {feeds: unset.map(name => ({key: `params.${name}.label`}))})
        };
      }
      try {
        const { plans, warnings, metrics } = await this.ui.ctrl.computeToolpaths(operationId, { optimize: params.optimizeToolpath !== false });
        if (!plans.length) return {
          success: false,
          message: i18n.t('messages.toolpaths.noMotion'),
          status: 'warning'
        };
        const mins = Math.floor(metrics.estimatedTime / 60);
        const secs = Math.floor(metrics.estimatedTime % 60);
        return {
          success: true,
          status: warnings.length > 0 ? 'warning' : 'success',
          notes: warnings,
          message: i18n.t('messages.toolpaths.calculated', {count: plans.length, time: `${mins}:${String(secs).padStart(2, '0')}`, distance: metrics.totalDistance.toFixed(0)})
        };
      } catch (e) {
        console.error(`[BaseOperationPanel] Toolpath calculation failed for ${operationId}:`, e);
        return {
          success: false,
          message: i18n.t('messages.toolpaths.failed', { error: e }),
          status: 'error'
        };
      }
    }

    /**
     * Read-only job summary for the output stage. The modal owns file layout,
     * ordering and tool changes, and the stage's action button opens it.
     */
    createOutputBlock(operation) {
      const section = document.createElement('div');
      section.className = 'property-section';
      const h3 = document.createElement('h3');
      h3.textContent = i18n.t('panels.operation.output.title');
      section.appendChild(h3);
      const tp = this.core.store.getToolpaths(operation.id);
      const summary = document.createElement('div');
      summary.className = 'summary-line';
      if (tp?.plans?.length) {
        const mins = Math.floor(tp.metrics.estimatedTime / 60);
        const secs = Math.floor(tp.metrics.estimatedTime % 60);
        summary.innerHTML = i18n.html('panels.operation.output.summary', { count: tp.plans.length, time: `${mins}:${String(secs).padStart(2, '0')}`, distance: tp.metrics.totalDistance.toFixed(0) });
      } else {
        summary.innerHTML = `<strong>${i18n.html('panels.operation.output.none')}</strong>`;
      }
      section.appendChild(summary);
      const note = document.createElement('div');
      note.className = 'summary-line summary-secondary';
      note.textContent = i18n.t('panels.operation.output.note');
      section.appendChild(note);
      return section;
    }

    /**
     * Generates a CNC toolpath preview from existing offsets.
     * Returns { success, message, status }.
     */
    async runPreview(operationId) {
      const operation = this.core.store.getOperation(operationId);
      if (!operation) return {
        success: false,
        message: i18n.t('messages.operations.notFound', { id: operationId }),
        status: 'error'
      };
      if (!operation.offsets || operation.offsets.length === 0) return {
        success: false,
        message: i18n.t('messages.operations.generateFirst'),
        status: 'warning'
      };
      const success = this.core.store.generateCNCPreview(operationId);
      if (!success) return {
        success: false,
        message: i18n.t('messages.operations.previewFailed'),
        status: 'error'
      };
      this.core.store.stampArtifact(operationId, 'preview');
      return this.withDepthWarning(
        {success: true, message: i18n.t('messages.operations.previewGenerated'), status: 'success'},
        operation,
        this.parameterStore.getAllParameters(operationId)
      );
    }

    /** Adds a depth warning to a successful result's notes, if there is one. */
    withDepthWarning(result, operation, params) {
      if (!result?.success) return result;
      const warning = this.checkDepthLimits(operation, params);
      if (!warning) return result;
      return { ...result, status: 'warning', notes: [...(result.notes ?? []), warning] };
    }

    /**
     * cutDepth against the machine's configured floor. The only other
     * check is BasePostProcessor.validateCommand, which runs per command
     * at emission and reaches the user after the file is written.
     * @returns {Object|null} message descriptor
     */
    checkDepthLimits(operation, params) {
      if (params.cutDepth == null) return null;
      // 3D ops own their depths
      const maxSafe = this.core.settings?.machine?.heights?.maxSafeDepth;
      if (typeof maxSafe !== 'number') return null;
      const deepestZ = this.core.pipelineContext.resolveSurfaceZ(operation) - Math.abs(params.cutDepth);
      if (deepestZ < maxSafe) return { key: 'messages.operations.depthWarning', values: { z: deepestZ.toFixed(2), max: maxSafe } };
      return null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Shared UI Builders
    // ────────────────────────────────────────────────────────────────────

    createActionButton(text, disabled = false, title = '') {
      const wrapper = document.createElement('div');
      wrapper.className = 'property-actions';
      const button = document.createElement('button');
      button.className = 'btn btn--primary btn--block';
      button.id = 'action-button';
      button.textContent = text;
      button.disabled = disabled;
      // A disabled button with no reason on it is a dead end - the card
      // above says which sizes are unanswered, this repeats it on hover.
      if (title) button.title = title;
      button.addEventListener('click', () => this.handleAction());
      wrapper.appendChild(button);
      return wrapper;
    }

    /**
     * Drill tooling card, in multi-tool mode (the drillMultiTool checkbox
     * above) at each stage the modal has columns for. It summarizes the
     * per-row table and opens it at the current stage. The table exists
     * only where the profile declares drillMultiTool.
     */
    createDrillToolingCard(operation, settings, stage) {
      if (operation?.type !== 'drill' || !this.parameterStore?.parameterDefinitions?.drillMultiTool) return null;
      if (!['geometry', 'strategy', 'machine'].includes(stage)) return null;
      const info = DrillHandler.describeTable(operation, settings);
      if (info.mode !== 'perSize') return null;
      const section = document.createElement('div');
      section.className = 'property-section drill-tooling-card';
      const h3 = document.createElement('h3');
      h3.textContent = i18n.t('modals.drillTooling.title');
      section.appendChild(h3);
      const parts = [];
      for (const strategy of ['peck', 'mill', 'skip']) {
        const count = info.counts[strategy];
        if (count) parts.push(i18n.t(`panels.operation.drillCard.${strategy}`, { count }));
      }
      const rowCount = info.rows.length;
      const summary = document.createElement('div');
      summary.className = 'summary-line';
      summary.innerHTML = rowCount > 0
        ? i18n.html('panels.operation.drillCard.rows', { count: rowCount, parts: i18n.list(parts, 'unit') })
        : `<strong>${i18n.html('panels.operation.drillCard.noSizes')}</strong>`;
      section.appendChild(summary);
      const detail = document.createElement('div');
      detail.className = 'summary-line summary-secondary';
      detail.textContent = info.numbers.length > 0
        ? i18n.t('panels.operation.drillCard.tools', { tools: i18n.list(info.numbers.map(n => `T${n}`), 'unit') })
        : i18n.t('panels.operation.drillCard.noTools');
      section.appendChild(detail);
      if (info.reason) {
        const warn = document.createElement('div');
        warn.className = 'summary-line summary-warning';
        warn.textContent = i18n.format(info.reason);
        section.appendChild(warn);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--block btn--primary';
      button.textContent = i18n.t('modals.drillTooling.configure');
      button.disabled = rowCount === 0;
      button.title = i18n.t(rowCount > 0 ? 'panels.operation.drillCard.configureTip' : 'panels.operation.drillCard.configureDisabledTip');
      // The modal edits this stage's columns only: strategy, cutter and
      // T number at geometry, peck depth at strategy, feeds at machine.
      button.addEventListener('click', () => {
        this.ui.ctrl.modalManager.showModal('drillTooling', {
          operationId: operation.id,
          stage,
          // Full re-render: a modal edit can change the field set and
          // whether Generate is allowed, so swapping the card alone
          // would leave two of those three stale.
          onChange: () => this.refreshOperationPanel(operation)
        });
      });
      section.appendChild(button);
      return section;
    }

    /** Re-renders the form after a tooling change. Subclasses override. */
    refreshOperationPanel(operation) {}

    /**
     * Invalidation warning with its "delete and redo" action. Each app's
     * discardInvalidGeometry does the delete and lands on the source form.
     */
    createInvalidationPanel(operation) {
      const panel = document
        .getElementById('invalidation-panel-template')
        .content.cloneNode(true)
        .querySelector('.invalidation-panel');
      panel.querySelector('.warning-message').textContent = i18n.format(operation.invalidatedReason);
      panel.querySelector('.invalidation-redo-btn').onclick = async () => {
        await this.discardInvalidGeometry(operation);
        this.ui.setStatus(i18n.t('messages.operations.invalidCleared'), 'success');
      };
      return panel;
    }

    /** App hook: drops the operation's stale geometry and shows its source form. */
    discardInvalidGeometry(operation) {}

    createWarningPanel(warnings) {
      const panel = document.createElement('div');
      panel.className = 'parameter-warning-panel';
      const icon = `<svg class="cam-icon" width="14" height="14"><use href="#icon-warning"></use></svg>`;
      // Deduplicate on the worded text; descriptors are distinct objects.
      const unique = [...new Set(warnings.map(w => i18n.format(w.message ?? w)))];
      const header = document.createElement('div');
      header.className = 'parameter-warning-header';
      header.innerHTML = icon;
      header.append(` ${i18n.t('panels.warnings.header', {count: unique.length})}`);
      panel.appendChild(header);
      const list = document.createElement('ul');
      list.className = 'parameter-warning-list';
      for (const text of unique) {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
      }
      panel.appendChild(list);
      return panel;
    }

    // ────────────────────────────────────────────────────────────────────
    // Action Dispatch
    // ────────────────────────────────────────────────────────────────────

    /**
     * Stage-based action dispatch. Subclass hooks: getSpinnerLabel,
     * onGenerationSuccess, onGenerationFailure, onPreviewSuccess,
     * onToolpathSuccess. Each success hook selects the node the action
     * produced, and that selection renders the next stage's form. The
     * action is one task from the click to the rendered result;
     * generation can be cancelled.
     */
    async handleAction() {
      this.saveCurrentState();
      const opId = this.currentOperationId;
      const stage = this.currentStage;
      const operation = this.resolveCurrentOperation();
      if (!operation) return;
      if (stage === 'output') {
        this.ui.ctrl.openExportManager();
        return;
      }
      const ACTIONS = {
        geometry: {run: onProgress => this.runGeneration(opId, onProgress), after: id => this.onGenerationSuccess(id, operation)},
        strategy: {run: () => this.runPreview(opId), after: id => this.onPreviewSuccess(id, operation)},
        machine: {run: () => this.runToolpaths(opId), after: id => this.onToolpathSuccess(id, operation)}
      };
      const action = ACTIONS[stage];
      if (!action) return;
      const cancel = stage === 'geometry' ? () => this.cancelGeneration(opId) : null;
      try {
        await this.ui.runTask(this.getSpinnerLabel(stage, this.resolveOperationType(operation)), async task => {
          const result = await action.run(task.tick);
          // A run that finished before Cancel landed is kept.
          if (task.cancelled && !result.success) {
            this.ui.setStatus(i18n.t('messages.operations.cancelled'), 'info');
            this.onGenerationFailure(opId, operation, stage);
            return;
          }
          this.ui.setStatus(result.message, result.status, { notes: result.notes });
          if (result.success) await action.after(opId);
          else if (stage === 'geometry') this.onGenerationFailure(opId, operation, stage);
        }, { cancel });
      } catch (e) {
        console.error(`[${this.constructor.name}] ${stage} failed:`, e);
        this.ui.setStatus(i18n.t('messages.operations.stageFailed', {stage: i18n.t(`stages.${stage}.label`), error: e }), 'error');
      }
      this.ui.ctrl.returnFocusToTree();
    }

    /** Cancel on a generation task: the operation's handler abandons its run. */
    cancelGeneration(operationId) {
      const operation = this.core.store.getOperation(operationId);
      this.core.getHandler(operation.type).cancelRun(operation);
    }

    // Hooks for subclass override

    /** Resolve the current operation/shape. Apps store this differently. */
    resolveCurrentOperation() {
      return null;
    }

    /** Extract opType from the resolved operation object. */
    resolveOperationType(operation) {
      return operation?.type || '';
    }

    /**
     * The label a stage's task opens with; the handler's own ticks take
     * over once it reports.
     */
    getSpinnerLabel(stage, opType) {
      const LABELS = { geometry: 'progress.generating', strategy: 'progress.preview', machine: 'progress.toolpaths' };
      return i18n.t(LABELS[stage]);
    }

    /** Called after successful generation. Update tree, renderer, etc. */
    async onGenerationSuccess(opId, operation) {}

    /** Called after failed generation. Refresh panel, etc. */
    onGenerationFailure(opId, operation, stage) {}

    /** Called after successful preview. Update tree, renderer, etc. */
    async onPreviewSuccess(opId, operation) {}

    /** Toolpaths just landed. Apps refresh their tree and the 3D view. */
    async onToolpathSuccess(opId, operation) {}

    // ────────────────────────────────────────────────────────────────────
    // Debug
    // ────────────────────────────────────────────────────────────────────

    debug(message, data = null) {
      if (D.debug.enabled) {
        data !== null
          ? console.log(`[${this.constructor.name}] ${message}`, data)
          : console.log(`[${this.constructor.name}] ${message}`);
      }
    }
  }

  window.BaseOperationPanel = BaseOperationPanel;
})();