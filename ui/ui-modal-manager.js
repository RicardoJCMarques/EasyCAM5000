/*!
* @file        ui/ui-modal-manager.js
* @description Unified modal management - Modal lifecycle (MODAL_POLICY, the
*              stack, hash routing, the focus trap, the warning queue) and
*              each modal's view binding. Static DOM lives in index.html;
*              rules live with the module that owns the data.
* @author      Eltryus - Ricardo Marques
* @copyright   2025-2026 Eltryus - Ricardo Marques
* @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
*
* SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
* SPDX-License-Identifier: AGPL-3.0-or-later
*/

(function() {
  'use strict';

  /**
   * Modal policy as data. A new app declares a table; it does not edit
   * the lifecycle methods. Dismissing is leaving by the ✕, a click on the
   * backdrop or Escape; a modal's own buttons do their own leaving.
   *  hashable - the URL carries #name while it is open
   *  hashOpen - safe to open directly from the URL (needs no app state)
   *  onDismiss - modal to hand on to when dismissed, or null to close
   *  commit(ctrl) - runs on dismissal, before the hand-on
   *  cancelOnDismiss - dismissal runs the open prompt's onCancel
   */
  const MODAL_POLICY = {
    welcome: { hashable: false, hashOpen: true, onDismiss: 'quickstart' },
    quickstart: { hashable: true, hashOpen: true, onDismiss: null },
    laserConfig: {
      hashable: false, hashOpen: false, onDismiss: 'quickstart',
      // Dismissing without choosing means the default UV pipeline.
      commit: ctrl => ctrl.applyPipelineChoice('uv')
    },
    support: { hashable: true, hashOpen: true, onDismiss: null },
    help: { hashable: false, hashOpen: true, onDismiss: null },
    exportManager: { hashable: false, hashOpen: false, onDismiss: null },
    drillTooling: { hashable: false, hashOpen: false, onDismiss: null },
    warning: { hashable: false, hashOpen: false, onDismiss: null, cancelOnDismiss: true }
  };

  const clearHash = () => history.replaceState(history.state, '', location.pathname + location.search); // keeps ?lang

  class ModalManager {
    constructor(ctrl) {
      this.ctrl = ctrl;
      this.ui = ctrl.ui;
      this.activeModal = null;
      this.modalStack = [];
      this.activeWarningCallbacks = null;
      this.warningQueue = []; // prompts waiting for the warning modal
      // Modal references
      this.modals = {
        welcome: document.getElementById('welcome-modal'),
        laserConfig: document.getElementById('laser-config-modal'),
        quickstart: document.getElementById('quickstart-modal'),
        exportManager: document.getElementById('exporter-manager-modal'),
        support: document.getElementById('support-modal'),
        help: document.getElementById('help-modal'),
        warning: document.getElementById('warning-modal'),
        drillTooling: document.getElementById('drill-tooling-modal')
      };
      // Track selected pipeline
      this.selectedPipeline = 'cnc'; // default
      // "Don't show again" on the quickstart, per app. Kept in memory too.
      this.skipQuickstart = false;
      try {
        this.skipQuickstart = localStorage.getItem(ctrl.storageKeys.hideWelcome) !== null;
      } catch {
        // Storage blocked (private mode, sandboxed frame). Reads stay
        // quiet, as everywhere; CamCore reports the first failed save.
      }
      // Quickstart drop-zone state. Zone ids are app-owned - EasyTrace
      // maps one gerber layer per zone, EasyShape uses a single drop
      // target it wires itself.
      this.quickstartOpTypes = ctrl.getQuickstartOpTypes();
      this.quickstartFiles = {};
      // Focus management for accessibility
      this.previousActiveElement = null;
      this.focusTrapListener = null;
      // Toolpath-specific state
      this.selectedOperations = [];
      this.drillToolingOpId = null;
      this.drillToolingOnChange = null;
      this.drillToolingStage = "geometry";
      this.currentModalFocusables = null;
      this.exporterModalTooltipsProcessed = new Set();
      this.init();
    }

    init() {
      // The ways out that are not a modal's own buttons: the ✕ and a
      // click on the backdrop. Escape arrives through KeyboardManager.
      for (const [name, modal] of Object.entries(this.modals)) {
        // Apps differ in modals: EasyShape5000 has no laser modal.
        if (!modal) continue;
        modal.addEventListener('click', e => {
          if (e.target === modal) this.dismissModal(name);
        });
        modal.querySelector('.modal-close').addEventListener('click', () => this.dismissModal(name));
      }
      window.addEventListener('hashchange', () => this.checkHash());
      // In-page links to a modal open it without navigating, so they leave no
      // history entry for Back to replay. Links whose own handler prevented the
      // default (the pipeline cards) and modified clicks are left alone.
      document.addEventListener('click', e => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const name = e.target.closest('a[href^="#"]')?.hash.slice(1);
        if (!MODAL_POLICY[name]?.hashOpen) return;
        e.preventDefault();
        this.showModal(name);
      });
      // A held Enter that opened a prompt (a remove button) must not confirm it
      // too: its auto-repeat lands on the focused confirm button.
      this.modals.warning.addEventListener('keydown', e => {
        if (e.repeat && e.key === 'Enter') e.preventDefault();
      }, true);
      window.addEventListener('settingschange', () => {
        this.invalidateCalculated();
        // The post decides the G-code extension, the laser format the PNG/SVG split.
        if (this.getActiveModalName() === 'exportManager') this.refreshExportState();
      });
    }

    /**
     * Leaves a modal by the ✕, the backdrop or Escape. Its policy's commit
     * runs first, then the modal closes or hands on to its onDismiss modal.
     * @param {string} [modalName] - the active modal by default
     */
    dismissModal(modalName = this.getActiveModalName()) {
      const policy = MODAL_POLICY[modalName];
      if (policy.cancelOnDismiss && this.activeWarningCallbacks?.onCancel) {
        this.activeWarningCallbacks.onCancel();
        this.activeWarningCallbacks = null;
      }
      policy.commit?.(this.ctrl);
      if (!policy.onDismiss) {
        this.closeModal();
        return;
      }
      // Handing on replaces whatever was stacked underneath.
      this.modalStack = [];
      this.closeModal();
      this.advanceTo(policy.onDismiss);
    }

    /**
     * Shows the next onboarding step. "Don't show again" skips the
     * quickstart only: a laser pick still needs the laser modal.
     * @param {string} modalName
     */
    advanceTo(modalName) {
      if (modalName === 'quickstart' && this.skipQuickstart) return;
      this.showModal(modalName);
    }

    /**
     * "Don't show again" on the quickstart.
     * @param {boolean} skip
     */
    setSkipQuickstart(skip) {
      this.skipQuickstart = skip;
      try {
        if (skip) localStorage.setItem(this.ctrl.storageKeys.hideWelcome, 'true');
        else localStorage.removeItem(this.ctrl.storageKeys.hideWelcome);
      } catch {
        // Storage blocked: the choice lasts for this page load only.
      }
    }

    /**
     * A Back button: returns to the modal underneath, or opens the step
     * before when this modal is alone.
     * @param {string} previous
     */
    goBack(previous) {
      const underneath = this.modalStack.length > 0;
      this.closeModal();
      if (!underneath) this.showModal(previous);
    }

    /**
     * Opens the modal the URL hash names, when its policy allows a deep link.
     * A modal that is not hashable drops the hash at once; closeModal drops the rest.
     * @returns {boolean} whether one opened
     */
    checkHash() {
      const name = window.location.hash.slice(1);
      const policy = MODAL_POLICY[name];
      if (!policy?.hashOpen) return false;
      this.showModal(name);
      if (!policy.hashable) clearHash();
      return true;
    }

    /** First modal of a session: the URL's deep link if it has one, else welcome. */
    showStartupModal() {
      if (!this.checkHash()) this.showModal('welcome');
    }

    updateCopyButtonScrollbar() {
      const previewText = document.getElementById('exporter-preview-text');
      const copyBtn = document.getElementById('exporter-copy-btn');
      if (previewText && copyBtn) {
        // If the scroll height is greater than the visible height, a scrollbar is present
        if (previewText.scrollHeight > previewText.clientHeight) {
          // Calculate the exact pixel width of the scrollbar rendered by the user's browser/OS offsetWidth includes borders and scrollbar. clientWidth excludes them.
          // Subtract 2 to account for the 1px left and 1px right borders on the textarea.
          const scrollbarWidth = previewText.offsetWidth - previewText.clientWidth - 2;
          // Pass the exact width to CSS
          copyBtn.style.setProperty('--dynamic-scrollbar-width', `${scrollbarWidth}px`);
          copyBtn.classList.add('has-scrollbar');
        } else {
          copyBtn.classList.remove('has-scrollbar');
        }
      }
    }

    showGcodeForOperation(opId) {
      const result = this.ctrl.core.exportPrograms.results?.[opId];
      const previewText = document.getElementById('exporter-preview-text');
      if (!result || !previewText) return;
      previewText.value = result.gcode;
      const lineCount = document.getElementById('exporter-line-count');
      if (lineCount) lineCount.textContent = result.lineCount;
      const planCount = document.getElementById('exporter-op-count');
      if (planCount) planCount.textContent = result.planCount;
      const estTime = document.getElementById('exporter-est-time');
      if (estTime) {
        const minutes = Math.floor(result.estimatedTime / 60);
        const seconds = Math.floor(result.estimatedTime % 60);
        estTime.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }
      const distance = document.getElementById('exporter-distance');
      if (distance) distance.textContent = i18n.t('common.millimeters', { value: result.totalDistance.toFixed(1) });
      // Pipeline warnings - dropped rotary/indexed plans above all.
      // These were console.warn-only, so a post that cannot emit the
      // operation's route produced an EMPTY program that looked like a
      // clean export.
      const warn = document.getElementById('exporter-warnings');
      if (warn) {
        const list = result.warnings || [];
        warn.style.display = list.length ? '' : 'none';
        warn.innerHTML = '';
        for (const w of list) {
          const line = document.createElement('div');
          line.className = 'preview-warning';
          line.textContent = `⚠ ${i18n.format(w)}`;
          warn.appendChild(line);
        }
      }
      this.updateCopyButtonScrollbar();
    }

    /**
     * Router drills whose preview holds more than one bit. One predicate
     * for the field's visibility, its gate and the intent.
     */
    splittableDrills(operations) {
      const core = this.ctrl.core;
      return operations.filter(op => op.type === 'drill' && core.machineClassOf(op) === 'router' && DrillHandler.splitDrillFiles(op).length > 1);
    }

    /**
     * The ONE place export state is read out of the DOM. A disabled toggle
     * reads as off: its gate has decided it cannot apply to this job.
     */
    readExportIntent() {
      const list = document.getElementById('exporter-operation-order');
      const byId = (id) => document.getElementById(id);
      const on = (id) => byId(id)?.checked === true && !byId(id).disabled;
      const number = (id) => {
        const value = parseFloat(byId(id)?.value);
        return Number.isFinite(value) ? value : undefined;
      };
      // Document order IS the cut order. Do not sort.
      const rows = [];
      list?.querySelectorAll('.file-node-content').forEach((item) => {
        if (!item.querySelector('.exporter-op-checkbox')?.checked) return;
        const op = this.selectedOperations.find((o) => o.id === item.dataset.operationId);
        if (op) rows.push(op);
      });
      const singleFile = on('exporter-single-file');
      // A split drill file holds one bit by construction, so splitting
      // and the multi-tool gate are the same question asked twice.
      const splitDrillOpIds = on('exporter-split-drills') && !singleFile ? this.splittableDrills(rows).map(op => op.id) : [];
      const nameInput = byId('exporter-filename');
      return {
        operations: rows,
        operationIds: rows.map((op) => op.id),
        singleFile,
        splitDrillOpIds,
        optimize: byId('exporter-optimize-paths')?.checked ?? true,
        includeComments: on('exporter-include-comments'),
        verboseComments: on('exporter-verbose-comments'),
        toolChanges: on('exporter-tool-changes'),
        groupByTool: on('exporter-group-by-tool'),
        zip: on('exporter-zip'),
        baseName: nameInput.value.trim().replace(/\.[^/.]+$/, ''),
        laserPadding: number('laser-exporter-padding'),
        stencilPadding: number('stencil-exporter-padding'),
      };
    }

    /**
     * Re-derives the panel from one intent and one plan. Which options are
     * on screen is showExportManagerHandler's call, made once per open;
     * this only enables and disables, so ticking an option never moves the
     * rest of the panel.
     * Gates run in dependency order, each on the intent the ones before it
     * settled, because readExportIntent reads a disabled toggle as off. An
     * option that cannot apply is unticked as well as greyed - what is
     * ticked is what gets written - and its row says why. The user's own
     * choice is kept in data-wanted and returns when the gate opens; it
     * starts from the markup default, not from whatever state the browser
     * restored on reload.
     */
    refreshExportState() {
      const core = this.ctrl.core;
      const ps = this.ctrl.parameterStore;
      const byId = (id) => document.getElementById(id);
      const gate = (id, reason) => {
        const input = byId(id);
        if (!input) return;
        input.dataset.wanted ??= String(input.defaultChecked);
        input.disabled = reason !== null;
        input.checked = !input.disabled && input.dataset.wanted === 'true';
        const note = input.closest('label')?.querySelector('.option-reason');
        if (note) note.textContent = reason ?? '';
      };
      const caps = core.gcodeGenerator.getProcessorInfo(core.settings.gcode.postProcessor).capabilities;
      let intent = this.readExportIntent();
      gate('exporter-single-file', core.planExportFiles(intent).canCombine ? null : i18n.t('modals.exporter.reasons.nothingToCombine'));
      intent = this.readExportIntent();
      const drills = intent.operations.filter(op => op.type === 'drill' && core.machineClassOf(op) === 'router');
      gate('exporter-split-drills', intent.singleFile ? i18n.t('modals.exporter.reasons.singleFileOn')
        : drills.length === 0 ? i18n.t('modals.exporter.reasons.noDrill')
        : this.splittableDrills(drills).length > 0 ? null
        : i18n.t('modals.exporter.reasons.oneBit'));
      intent = this.readExportIntent();
      const plan = core.planExportFiles(intent);
      gate('exporter-zip', plan.files.length > 1 ? null : i18n.t('modals.exporter.reasons.oneFile'));
      // Every SVG carries the comment block; G-code only where the post
      // can hold comments.
      const commented =
        plan.files.length === 0 ||
        plan.files.some((file) => file.format === 'svg' || (file.format === 'gcode' && caps.supportsComments));
      gate('exporter-include-comments', commented ? null : i18n.t('modals.exporter.reasons.notOnPost'));
      intent = this.readExportIntent();
      // Verbose notes extend the G-code header: they need comments on and a G-code file that carries them.
      gate(
        'exporter-verbose-comments',
        !intent.includeComments
          ? i18n.t('modals.exporter.reasons.commentsOff')
          : plan.files.length === 0 || plan.files.some((file) => file.format === 'gcode' && caps.supportsComments)
            ? null
            : i18n.t('modals.exporter.reasons.gcodeOnly'),
      );
      // Never closed - passed through so it too starts from the markup default.
      gate('exporter-optimize-paths', null);
      // A split file holds one bit by construction; only whole-operation
      // files can need a swap.
      const routerIds = intent.operations.filter((op) => core.machineClassOf(op) === 'router').map((op) => op.id);
      const fileGroups = plan.files
        .filter((file) => file.route === 'router' && !file.splitKey)
        .map((file) => file.operationIds);
      const tooling = routerIds.length
        ? core.pipelineContext.describeExportTooling(routerIds, ps, fileGroups)
        : { shared: [], hasMultiToolFile: false, staged: [] };
      const support = core.pipelineContext.describeToolChangeSupport(intent, ps, tooling);
      gate(
        'exporter-tool-changes',
        !support.supported ? i18n.t('modals.exporter.reasons.notOnPost') : tooling.hasMultiToolFile ? null : i18n.t('modals.exporter.reasons.oneToolPerFile'),
      );
      gate(
        'exporter-group-by-tool',
        !intent.singleFile ? i18n.t('modals.exporter.reasons.singleFileOnly') : tooling.hasMultiToolFile ? null : i18n.t('modals.exporter.reasons.oneToolInFile'),
      );
      intent = this.readExportIntent();
      // A shared T number only matters where a T word picks the cutter.
      this.renderToolNotice(support.hint, intent.toolChanges ? tooling.shared : []);
      // Order only matters inside a file that holds several operations.
      byId('exporter-operation-order')?.classList.toggle(
        'is-orderable',
        plan.files.some((file) => file.operationIds.length > 1),
      );
      this.updateExportBlocksVisibility(intent);
      this.renderExportSummary(plan, intent);
    }

    /**
     * One line naming what Export writes - the archive, or the count per
     * format - with every file name in its tooltip. A full list would
     * reflow the panel on every toggle, and the G-code names are already
     * in the preview selector.
     */
    renderExportSummary(plan, intent) {
      // An empty field shows the base name the files will carry.
      document.getElementById('exporter-filename').placeholder = plan.baseName;
      const line = document.getElementById('exporter-summary');
      if (!line) return;
      const { files } = plan;
      line.title = files.map((file) => file.filename).join('\n');
      if (files.length < 2) {
        line.textContent = files[0]?.filename || i18n.t('modals.exporter.summary.none');
        return;
      }
      const counts = new Map();
      for (const file of files) {
        const ext = file.filename.split('.').pop().toUpperCase();
        counts.set(ext, (counts.get(ext) || 0) + 1);
      }
      const kinds = i18n.list([...counts].map(([format, count]) => i18n.t('modals.exporter.summary.kind', { count, format })), 'unit');
      line.textContent = intent.zip
        ? i18n.t('modals.exporter.summary.zip', { name: `${plan.baseName}.zip`, kinds })
        : i18n.t('modals.exporter.summary.files', { count: files.length, kinds });
    }

    /**
     * Tooling notes, last in the CNC block so appearing pushes nothing the
     * user is about to click. `hint` is a real problem - a file needs a
     * swap the post cannot make - and always shows. `shared` lists T
     * numbers carried by different sizes; the caller passes it only while
     * tool changes are on, because with them off one T word is emitted,
     * nothing swaps and the number is decorative. Grouped by number, so
     * three operations on T1 read as one thing to look at, not three
     * problems. Text nodes only: the labels carry file names.
     */
    renderToolNotice(hint, shared) {
      const panel = document.getElementById('exporter-tool-warning');
      if (!panel) return;
      const el = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
      panel.textContent = '';
      panel.className = hint || shared.length > 0 ? 'export-gate' : 'is-hidden';
      if(hint)panel.appendChild(el('p', i18n.format(hint)));
      if (shared.length === 0) return;
      const list = document.createElement('ul');
      for (const s of shared) {
        const sizes = s.entries.map(e => ({
          key: 'modals.exporter.toolNotice.size',
          values: {diameter: e.diameter.toFixed(2), label: e.label}
        }));
        list.appendChild(el('li', i18n.t('modals.exporter.toolNotice.shared', {number: s.number, sizes})));
      }
      panel.append(
        el('strong', i18n.t('modals.exporter.toolNotice.title')),
        list,
        el('p', i18n.t('modals.exporter.toolNotice.text')),
      );
    }      

    /**
     * Per-row drill tooling. operation.drillTable is the source of truth:
     * this renders it and writes back through DrillHandler, so what stales
     * the operation and what does not stays in one place.
     */
    showDrillToolingHandler(options = {}) {
      if (options.operationId) this.drillToolingOpId = options.operationId;
      this.drillToolingOnChange = options.onChange || this.drillToolingOnChange || null;
      // renderDrillToolingModal re-enters on every edit with no options,
      // so the stage is captured on open.
      this.drillToolingStage = options.stage || this.drillToolingStage || 'geometry';
      document.getElementById('drill-tooling-done').onclick = () => this.closeModal();
      this.renderDrillToolingModal();
    }

    renderDrillToolingModal() {
      const body = document.getElementById('drill-tooling-body');
      const subtitle = document.getElementById('drill-tooling-subtitle');
      const operation = this.ctrl.core.store.getOperation(this.drillToolingOpId);
      const entries = Object.values(operation?.drillTable?.rows ?? {});
      if (entries.length === 0) {
        const notice = document.createElement('p');
        notice.className = 'modal-notice';
        notice.textContent = i18n.t('modals.drillTooling.empty');
        body.replaceChildren(notice);
        subtitle.textContent = '';
        return;
      }
      // By size, each size's hole row before its slot row.
      entries.sort((a, b) => a.diameter - b.diameter || a.slots - b.slots);
      const diameters = new Set(entries.map(row => row.diameter)).size;
      subtitle.textContent = i18n.t('modals.drillTooling.subtitle', { file: operation.file?.name || operation.id, count: diameters });
      // Each stage edits the columns of its own sidebar parameters:
      // strategy, cutter and T number at geometry, peck depth at strategy,
      // feeds at machine. Cells marked for another stage are removed; the
      // unmarked columns stay as read-only context.
      const stage = this.drillToolingStage;
      const offStage = `[data-stage]:not([data-stage="${stage}"])`;
      const view = document.getElementById('drill-tooling-template').content.cloneNode(true);
      view.querySelectorAll(offStage).forEach(el => el.remove());
      for (const th of view.querySelectorAll('th[data-help]')) {
        const column = th.dataset.help;
        window.TooltipManager?.attachWithIcon(th, () => ({
          title: i18n.t(`modals.drillTooling.columns.${column}`),
          text: i18n.t(`modals.drillTooling.help.${column}`)
        }));
      }
      const rowTemplate = document.getElementById('drill-tooling-row-template').content.firstElementChild;
      const tbody = view.querySelector('tbody');
      for (const row of entries) {
        const tr = rowTemplate.cloneNode(true);
        tr.querySelectorAll(offStage).forEach(el => el.remove());
        this.fillDrillToolingRow(tr, row, stage);
        tbody.append(tr);
      }
      body.replaceChildren(view);
      this.setupDrillToolingHandlers(operation);
    }

    /**
     * One row's values and the state of its controls. A column header
     * names a CELL, never a control inside it, so every control's name
     * spells the row: "Strategy for 1 mm slots".
     */
    fillDrillToolingRow(tr, row, stage) {
      tr.dataset.key = row.key;
      const size = tr.querySelector('.drill-tooling-size');
      size.prepend(`⌀${row.diameter.toFixed(3)}`);
      if (row.nativeTools?.length) size.title = i18n.t('modals.drillTooling.excellonCode', { codes: i18n.list(row.nativeTools, 'unit') });
      tr.querySelector('.drill-tooling-features').textContent = row.slots > 0
        ? i18n.t('modals.drillTooling.slots', { count: row.slots })
        : i18n.t('modals.drillTooling.holes', { count: row.holes });
      const label = DrillHandler.rowLabel(row.key);
      const values = {
        strategy: row.strategy,
        toolDiameter: +(row.toolDiameter ?? row.diameter).toFixed(3),
        toolNumber: row.toolNumber,
        feedRate: row.cutting?.feedRate,
        plungeRate: row.cutting?.plungeRate,
        spindleSpeed: row.cutting?.spindleSpeed,
        peckDepth: row.peck?.peckDepth
      };
      // Strategy, cutter and T number are set at geometry; the later
      // stages show them for reference.
      const geometry = stage === 'geometry';
      const skip = row.strategy === 'skip';
      const disabled = {
        strategy: !geometry,
        toolDiameter: !geometry || skip,
        toolNumber: !geometry,
        peckDepth: row.strategy !== 'peck',
        feedRate: skip,
        plungeRate: skip,
        spindleSpeed: skip
      };
      for (const input of tr.querySelectorAll('[data-field]')) {
        const field = input.dataset.field;
        input.value = values[field] ?? '';
        input.disabled = disabled[field] === true;
        input.setAttribute('aria-label', i18n.t(`modals.drillTooling.${field}Aria`, { holes: label }));
      }
      tr.querySelector('[data-field="toolDiameter"]').placeholder = +row.diameter.toFixed(3);
    }

    setupDrillToolingHandlers(operation) {
      const body = document.getElementById('drill-tooling-body');
      const handler = this.ctrl.core.getHandler('drill');
      body.querySelectorAll('[data-preset]').forEach(btn => {
        btn.onclick = () => {
          // Read on click, not at render: millHoles can change behind
          // the modal and the presets seed from it.
          handler.applyDrillPreset(operation, btn.dataset.preset);
          this.afterDrillToolingEdit(operation, true);
          this.renderDrillToolingModal();
        };
      });
      body.querySelectorAll('[data-field]').forEach(input => {
        const key = input.closest('tr').dataset.key;
        input.onchange = () => {
          const {stales, value} = handler.setDrillField(operation, key, input.dataset.field, input.value);
          input.value = value ?? '';
          this.afterDrillToolingEdit(operation, stales);
          // The strategy decides which of the row's inputs apply.
          if (input.dataset.field === 'strategy') this.renderDrillToolingModal();
        };
      });
    }

    /**
     * Geometry-affecting edits stale the operation; identity and cutting edits
     * do not - the toolpath pass reads those from the table at export, so
     * discarding generated paths for a T number would be gratuitous. They bump
     * '__identity' instead, which moves the export cache key.
     */
    afterDrillToolingEdit(operation, stales) {
      this.drillToolingOnChange?.();
      const store = this.ctrl.core.store;
      if (!stales) {
        store.bumpOperationRevision(operation.id, '__identity');
        return;
      }
      const reason = { key: 'messages.drill.toolingChanged' };
      if (store.invalidateOperationState(operation.id, reason)) this.ui.setStatus(reason, 'warning');
    }

    /**
     * Back to the uncalculated state: empty preview, zeroed stats, no
     * warnings and no program selector - that only appears once a
     * calculation returns more than one program. The prompt is the
     * textarea's placeholder, never its value, so it cannot be copied as
     * if it were G-code.
     */
    resetExportPreview() {
      const byId = (id) => document.getElementById(id);
      const setText = (id, text) => {
        const el = byId(id);
        if (el) el.textContent = text;
      };
      const previewText = byId('exporter-preview-text');
      if (previewText) {
        previewText.value = '';
        previewText.placeholder = i18n.t('modals.exporter.previewPlaceholder');
      }
      setText('exporter-line-count', '0');
      setText('exporter-op-count', '0');
      setText('exporter-est-time', '--:--');
      setText('exporter-distance', i18n.t('common.millimeters', {value: 0}));
      const warn = byId('exporter-warnings');
      if (warn) {
        warn.style.display = 'none';
        warn.innerHTML = '';
      }
      const select = byId('exporter-preview-select');
      if (select) select.innerHTML = '';
      const selector = byId('exporter-operation-selector');
      if (selector) selector.style.display = 'none';
      this.updateCopyButtonScrollbar();
    }

    /** G-code is only reusable while nothing that shapes it has moved. */
    invalidateCalculated() {
      this.ctrl.core.exportPrograms = { key: null, results: null };
      this.resetExportPreview();
    }

    showModal(modalName, options = {}) {
      const modal = this.modals[modalName];
      if (!modal) {
        console.error(`[UI-ModalManager] Modal - '${modalName}' - not found`);
        return;
      }
      // replaceState: opening a modal adds no history entry for Back/Forward to replay.
      if (MODAL_POLICY[modalName].hashable) history.replaceState(history.state, '', `#${modalName}`);
      // Store return focus target
      this.previousActiveElement = document.activeElement;
      // Close current modal if exists
      if (this.activeModal) {
        this.removeFocusTrap();
        this.modalStack.push(this.activeModal);
        this.activeModal.classList.remove('active');
      }
      this.activeModal = modal;
      modal.classList.add('active');
      // Each modal's markup carries its role and aria-labelledby.
      modal.setAttribute('aria-modal', 'true');
      // Call specific show handler
      const handler = `show${modalName.charAt(0).toUpperCase() + modalName.slice(1)}Handler`;
      if (this[handler]) this[handler](options);
      // Setup focus trap
      this.setupFocusTrap(modal);
      this.setupModalFieldNavigation(modal);
      // Focus moves in once the modal has laid out: kept where a show handler or
      // onShow put it, else a [data-autofocus] control, else the scroll container.
      requestAnimationFrame(() => {
        const content = modal.querySelector('.modal-content');
        if (!content) return;
        // -1 allows JS to focus it, but users can't Tab to it
        content.setAttribute('tabindex', '-1');
        content.style.outline = 'none';
        // .modal-content is overflow:hidden - .modal-body is the
        // scroller. Focusing the wrapper left arrow keys with nothing
        // to move, and a text-only body (help, quickstart) has no
        // focusable child to scroll it either.
        const body = modal.querySelector('.modal-body');
        const scrolls = !!body && body.scrollHeight > body.clientHeight + 1;
        if (body) body.setAttribute('tabindex', scrolls ? '0' : '-1');
        if (modal.contains(document.activeElement)) return;
        const marked = modal.querySelector('[data-autofocus]:not(:disabled)');
        (marked ?? (scrolls ? body : content)).focus();
      });
    }

    closeModal() {
      if (!this.activeModal) return;
      const closing = this.getActiveModalName();
      this.removeFocusTrap();
      this.activeModal.classList.remove('active');
      if (this.modalStack.length > 0) {
        // Returning to previous modal; the URL names it only when it is hashable
        this.activeModal = this.modalStack.pop();
        this.activeModal.classList.add('active');
        this.setupFocusTrap(this.activeModal);
        const returnModalName = this.getActiveModalName();
        if (MODAL_POLICY[returnModalName]?.hashable) history.replaceState(history.state, '', `#${returnModalName}`);
        else clearHash();
      } else {
        // Fully closing removes hash
        this.activeModal = null;
        if (window.location.hash) clearHash();
        // Restore focus - but never to canvas
        if (this.previousActiveElement && document.body.contains(this.previousActiveElement) && this.previousActiveElement.id !== 'preview-canvas') {
          this.previousActiveElement.focus();
        } else {
          // Jump back to the app's tree or else focus lands on <body> and
          // keyboard navigation restarts from the top.
          const sel = this.ctrl.getTreeFocusSelector() || '#operations-tree [tabindex="0"]';
          document.querySelector(sel)?.focus();
        }
        this.previousActiveElement = null;
      }
      if (closing === 'warning' && this.warningQueue.length > 0) this.showWarning(...this.warningQueue.shift());
    }

    getActiveModalName() {
      if (!this.activeModal) return null;
      for (const [name, modal] of Object.entries(this.modals)) {
        if (modal === this.activeModal) return name;
      }
      return null;
    }

    showLaserConfigHandler() {
      const choose = pipeline => e => {
        e.preventDefault();
        this.ctrl.applyPipelineChoice(pipeline);
        this.closeModal();
        this.advanceTo('quickstart');
      };
      document.getElementById('laser-select-uv').onclick = choose('uv');
      document.getElementById('laser-select-fiber').onclick = choose('fiber');
      document.getElementById('laser-config-back-btn').onclick = () => this.goBack('welcome');
    }

    showSupportHandler() {
      // Built at runtime and absent from the markup: neither the page nor the
      // bundle holds the address as one string.
      const email = ['sponsor', 'eltryus.design'].join('@');
      const copyBtn = document.getElementById('support-email-copy');
      const textSpan = document.getElementById('support-email-text');
      textSpan.textContent = email;
      copyBtn.classList.remove('copied');
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(email);
          textSpan.textContent = i18n.t('modals.support.sponsor.copied');
          copyBtn.classList.add('copied');
          setTimeout(() => {
            textSpan.textContent = email;
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Copy failed:', err);
          // Select the address for a manual copy
          const range = document.createRange();
          range.selectNode(textSpan);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
      };
      // Back returns to the modal underneath (Welcome's sponsor links); opened
      // alone, the same button closes.
      const back = document.getElementById('support-back-btn');
      back.dataset.i18n = this.modalStack.length > 0 ? 'common.back' : 'common.close';
      back.textContent = i18n.t(back.dataset.i18n);
      back.onclick = () => this.closeModal();
    }

    showHelpHandler() {
      document.getElementById('help-close-btn').onclick = () => this.closeModal();
    }

    showWelcomeHandler() {
      const modal = this.modals.welcome;
      // A choice that loads a file holds its picker until the file
      // lands; a failure keeps the previous choice.
      const hold = async (select, apply, failureKey) => {
        const option = select.selectedOptions[0];
        const label = option.textContent;
        option.textContent = i18n.t('common.loading');
        select.disabled = true;
        const applied = await apply(select.value).then(result => result !== false, error => {
          console.error('[UI-ModalManager] Preference change failed:', error);
          this.ui.setStatus(i18n.t(failureKey, { error }), 'error');
          return false;
        });
        option.textContent = label;
        select.disabled = false;
        select.focus();
        return applied;
      };
      // Choices from custom files first, each marked Custom, then the shipped ones.
      const fill = (select, choices, current) => {
        const option = ({ value, label, shipped }) =>
          new Option(
            shipped ? label : i18n.t('devices.maturity.custom.label', { name: label }),
            value,
            false,
            value === current,
          );
        select.replaceChildren(
          ...choices.filter((choice) => !choice.shipped).map(option),
          ...choices.filter((choice) => choice.shipped).map(option),
        );
      };
      const language = document.getElementById('welcome-language');
      fill(language, i18n.available().map(([value, label]) => ({ value, label, shipped: i18n.isShipped(value) })), i18n.locale);
      // The page is reworded in place, this modal included.
      language.onchange = async () => {
        if (await hold(language, value => i18n.setLocale(value), 'messages.language.loadFailed')) this.showWelcomeHandler();
        else language.value = i18n.locale;
      };
      const theme = document.getElementById('welcome-theme');
      fill(theme, window.ThemeLoader.list().map(({ id, label }) => ({
        value: id,
        label: label != null ? i18n.format(label) : i18n.t(['params', 'theme', 'options', id]),
        shipped: window.ThemeLoader.builtIn.has(id)
      })), window.ThemeLoader.currentTheme);
      theme.onchange = async () => {
        if (!await hold(theme, value => window.ThemeLoader.applyTheme(value), 'messages.theme.loadFailed')) theme.value = window.ThemeLoader.currentTheme;
      };
      // One button per kind of device the machine output comes from. It names the one in
      // use and opens Machine Settings where that device is chosen; when a custom file
      // supplied it, the button removes that file instead, once confirmed.
      const settings = this.ctrl.core.settings;
      const inUse = {
        setup: [settings.gcode.postProcessor, id => this.ui.postLabel(id)],
        laserProfile: [settings.laser?.activeProfile, id => this.ui.laserLabel(id)],
        toolLibrary: ['library', null]
      };
      for (const button of modal.querySelectorAll('.welcome-device')) {
        const kind = button.dataset.kind;
        const [id, nameOf] = inUse[kind] || [];
        if (!id) continue;
        const file = this.ctrl.customFiles.sourceOf(kind, id);
        const isCustom = file !== null;
        const message = nameOf ? isCustom ? 'customDevice' : 'device' : isCustom ? 'customLibrary' : 'library';
        const device = i18n.t(`devices.inUse.${message}`, {
          kind: { key: `customFiles.kinds.${kind}` },
          name: nameOf?.(id),
          file
        });
        const label = isCustom ? i18n.t('customFiles.remove.tip', {
          device
        }) : device;
        button.classList.toggle('is-custom', isCustom);
        button.tabIndex = isCustom ? 0 : -1;
        button.title = label;
        button.setAttribute('aria-label', label);
        button.onclick = !isCustom ? null : () => {
          this.ctrl.customFiles.remove(kind, id).then(invalidated => {
            this.ui.renderMachineSettings();
            const notes = invalidated > 0 ? [{
              key: 'messages.operations.toolsChanged',
              values: {count: invalidated}
            }] : [];
            this.ui.setStatus(i18n.t('customFiles.remove.done', {
              file
            }), 'success', {
              notes
            });
            this.showWelcomeHandler();
          }, error => {
            console.error('[UI-ModalManager] Removing a custom file failed:', error);
            this.ui.setStatus(i18n.t('customFiles.remove.failed', {
              file,
              error
            }), 'error');
          });
        };
      }
      modal.querySelectorAll('.pipeline-card[data-pipeline]').forEach(card => {
        // The controller performs the app-specific side effect and returns
        // the modal to advance to, or null to land straight in the workspace.
        card.onclick = e => {
          e.preventDefault();
          this.selectedPipeline = card.dataset.pipeline;
          const next = this.ctrl.onPipelineSelected(card.dataset.pipeline);
          this.closeModal();
          if (next) this.advanceTo(next);
        };
      });
    }

    showQuickstartHandler() {
      const modal = this.modals.quickstart;
      // Get the modal content wrapper (to apply the mode class)
      const modalContent = modal.querySelector('.modal-content');
      // Determine pipeline State
      const pipeline = this.selectedPipeline || 'cnc';
      // Apply State
      modalContent.classList.remove('mode-cnc', 'mode-laser', 'mode-3d');
      modalContent.classList.add(`mode-${pipeline}`);
      // Reset file state
      this.quickstartFiles = {};
      for (const opType of this.quickstartOpTypes) this.quickstartFiles[opType] = null;
      // "Don't show again" is a preference like the welcome pickers: it
      // holds the moment it changes, however the quickstart is left.
      const dontShow = document.getElementById('dont-show-quickstart');
      dontShow.checked = this.skipQuickstart;
      dontShow.onchange = () => {
        this.setSkipQuickstart(dontShow.checked);
        if (!dontShow.checked) this.ui.setStatus(i18n.t('messages.quickstart.willShow'), 'info');
      };
      // Setup example dropdown directly from controller profile data
      const select = document.getElementById('quickstart-example-select');
      const examples = this.ctrl.getExamples();
      const exampleRow = select?.closest('.quickstart-example-row');
      if (select && examples && Object.keys(examples).length > 0) {
        select.innerHTML = '';
        for (const key of Object.keys(examples)) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = this.ctrl.exampleLabel(key);
          select.appendChild(option);
        }
        if (exampleRow) exampleRow.style.display = '';
      } else if (exampleRow) {
        exampleRow.style.display = 'none';
      }
      // Setup compact drop zones
      this.setupQuickstartDropZones();
      // Load example button
      const loadExampleBtn = document.getElementById('load-example-btn');
      if (loadExampleBtn) loadExampleBtn.onclick = async () => {
        const selectedExample = select?.value;
        if (!selectedExample || this._loadingExample) return;
        // The fetch is not instant off localhost. Hold the modal open,
        // disable its inputs and say what is happening - closing first
        // leaves the user on an empty canvas with no explanation.
        this._loadingExample = true;
        const label = loadExampleBtn.textContent;
        loadExampleBtn.disabled = true;
        loadExampleBtn.textContent = i18n.t('modals.quickstart.loading');
        if (select) select.disabled = true;
        const processBtn = document.getElementById('process-quickstart-files-btn');
        if (processBtn) processBtn.disabled = true;
        try {
          await this.ctrl.loadExample(selectedExample);
          this.closeModal();
        } catch (e) {
          console.error('[ModalManager] Example load failed:', e);
          this.ui.setStatus(i18n.t('messages.examples.loadFailed', { error: e }), 'error');
        } finally {
          this._loadingExample = false;
          loadExampleBtn.disabled = false;
          loadExampleBtn.textContent = label;
          if (select) select.disabled = false;
          this.updateQuickstartProcessButton();
        }
      };
      // Process files button. The quickstart closes first: the task
      // overlay says what is loading, and a prompt a file raises opens
      // over the workspace, not over this modal.
      const processBtn = document.getElementById('process-quickstart-files-btn');
      if (processBtn) {
        processBtn.disabled = true;
        processBtn.onclick = async () => {
          // Each zone holds one file of its own type.
          const types = new Map(Object.entries(this.quickstartFiles).filter(([, file]) => file).map(([type, file]) => [file, type]));
          this.quickstartFiles = {};
          this.closeModal();
          await this.ctrl.ingestFiles([...types.keys()], file => types.get(file));
        };
      }
      // Start empty button
      document.getElementById('start-empty-btn').onclick = () => this.closeModal();
      // Back button - pipeline-aware
      document.getElementById('quickstart-back-btn').onclick = () => this.goBack(this.selectedPipeline === 'laser' ? 'laserConfig' : 'welcome');
    }

    setupQuickstartDropZones() {
      const opTypes = this.quickstartOpTypes;
      if (opTypes.length === 0) return;
      opTypes.forEach(opType => {
        const zone = document.getElementById(`qs-${opType}-zone`);
        if (!zone) return;
        const fileInput = zone.querySelector('input[type="file"]');
        const fileLabel = zone.querySelector('.zone-file');
        // Reset visual state
        zone.classList.remove('has-file', 'dragging');
        if (fileLabel) fileLabel.textContent = '';
        // Click to browse
        zone.onclick = () => fileInput?.click();
        // Keyboard: Enter or Space to browse
        zone.onkeydown = (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput?.click();
          }
        };
        // File input change
        if (fileInput) {
          fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) this.handleQuickstartFile(file, opType, zone);
          };
        }
        // Drag events
        zone.ondragover = (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.add('dragging');
        };
        zone.ondragleave = (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.remove('dragging');
        };
        zone.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          zone.classList.remove('dragging');
          const file = e.dataTransfer.files[0];
          if (file) this.handleQuickstartFile(file, opType, zone);
        };
      });
    }

    handleQuickstartFile(file, opType, zone) {
      const validation = this.ctrl.core.ingest.validateFileType(file.name, opType);
      if (validation && !validation.valid) {
        this.ui.setStatus(validation.message, "error");
        return;
      }
      this.quickstartFiles[opType] = file;
      zone.classList.add("has-file");
      const fileLabel = zone.querySelector(".zone-file");
      fileLabel && (fileLabel.textContent = file.name);
      this.updateQuickstartProcessButton();
    }

    updateQuickstartProcessButton() {
      const processBtn = document.getElementById("process-quickstart-files-btn");
      if (processBtn) {
        const hasFiles = Object.values(this.quickstartFiles).some(f => f !== null);
        processBtn.disabled = !hasFiles;
      }
    }

    // Toolpath modal handler
    showExportManagerHandler(options = {}) {
      const operations = options.operations || [];
      this.debug(`Opening Export Manager with ${operations.length} operation(s)`);
      const core = this.ctrl.core;
      this.selectedOperations = this.ctrl.registry.sortForExport(operations);
      const all = this.selectedOperations;
      const classes = new Set(all.map(op => core.machineClassOf(op)));
      const hasCNC = classes.has('router');
      const hasLaser = classes.has('laser');
      const hasVector = [...classes].some(cls => cls !== 'router' && cls !== 'laser');
      const board = all.filter(op => core.machineClassOf(op) === 'router' && op.type !== 'stencil');
      const splittable = this.splittableDrills(board).length > 0;
      const byId = id => document.getElementById(id);
      const show = (id, visible) => byId(id)?.classList.toggle('is-hidden', !visible);
      // What is on screen is decided here, once, from what this job could
      // ever use; refreshExportState only enables and disables after this.
      // Class toggles, not inline display, so the CSS grid stays in control.
      show('exporter-cnc-options', hasCNC);
      show('exporter-cnc-preview', hasCNC);
      show('exporter-calculate-btn', hasCNC);
      show('exporter-laser-options', hasLaser);
      show('exporter-stencil-options', hasVector);
      show('exporter-single-file-field', core.planExportFiles({ operations: all }).canCombine);
      show('exporter-split-drills-field', splittable);
      show('exporter-zip-field', all.length > 1 || splittable);
      show('exporter-group-by-tool-field', board.length > 1);
      // Without CNC work the preview column is gone and the options take its width.
      document.querySelector('.gcode-options')?.classList.toggle('is-full-width', !hasCNC);
      // What the G-code depends on, named where it is exported: the post
      // and, when a custom file supplied it, the tool library.
      if (hasCNC) {
        byId('post-summary-label').textContent = this.ui.postLabel(core.settings.gcode.postProcessor);
        const library = this.ctrl.customFiles.sourceOf('toolLibrary', 'library');
        show('tool-library-summary', library !== null);
        if (library !== null) byId('tool-library-summary-label').textContent = library;
      }
      // Laser and vector work only exist in apps that keep the laser settings.
      if (hasLaser) {
        const paddingInput = byId('laser-exporter-padding');
        if (paddingInput) paddingInput.value = core.settings.laser.exportPadding;
        const activeProfile = core.graphicsExporter.getProfileInfo(core.settings.laser.activeProfile);
        const summaryLabel = byId('laser-profile-summary-label');
        if(summaryLabel&&activeProfile)summaryLabel.textContent=this.ui.laserLabel(activeProfile.id);
      }
      if (hasVector) {
        const stencilPaddingInput = byId('stencil-exporter-padding');
        if (stencilPaddingInput) stencilPaddingInput.value = core.settings.laser.exportPadding;
      }
      this.populateExportOperationsList();
      this.setupExportHandlers();
      // Rebuild on every open: the header's date and the operation labels are not in exportIntentKey.
      this.invalidateCalculated();
      this.refreshExportState();
      this.attachExporterModalTooltips();
    }

    populateExportOperationsList() {
      const list = document.getElementById('exporter-operation-order');
      if (!list) return;
      list.innerHTML = '';
      const core = this.ctrl.core;
      const cncExt = core.gcodeGenerator.getProcessorInfo(core.settings.gcode.postProcessor).fileExtension.slice(1).toUpperCase();
      const badgeClass = { router: 'cnc', laser: 'laser' };
      for (const op of this.selectedOperations) {
        const item = document.createElement('div');
        item.className = 'file-node-content';
        item.dataset.operationId = op.id;
        // The badge is the format the operation is written in. In a PNG
        // laser job that differs per operation: cut-through work stays SVG.
        const format = core.exportFormatOf(op);
        const route = badgeClass[core.machineClassOf(op)] || 'stencil';
        item.innerHTML = `
          <input type="checkbox" class="exporter-op-checkbox" id="exp-check-${op.id}" checked>
          <label for="exp-check-${op.id}">
            <span class="exporter-op-name"></span>
            <span class="exporter-route-badge exporter-route-badge--${route}">${format === 'gcode' ? cncExt : format.toUpperCase()}</span>
          </label>
          `;
        item.querySelector('.exporter-op-name').textContent = i18n.t('messages.export.operationLabel', {type: {key: `ops.${op.type}.short`}, name: op.file.name});
        item.querySelector('input').addEventListener('change', () => {
          this.refreshExportState();
          this.invalidateCalculated();
        });
        // A stencil is its own job on its own material, so it is never part
        // of the board's processing order.
        if (op.type === 'stencil') {
          item.dataset.locked = 'true';
          item.title = i18n.t('modals.exporter.stencilSeparate');
        }
        list.appendChild(item);
      }
      UIControls.makeSortable(
        list,
        '.file-node-content',
        (msg, level) => this.ui.setStatus(msg, level),
        () => {
          this.refreshExportState();
          this.invalidateCalculated();
        },
      );
    }

    /**
     * Dims each route's options when none of its operations are checked.
     */
    updateExportBlocksVisibility(intent) {
      const classes = new Set(intent.operations.map((op) => this.ctrl.core.machineClassOf(op)));
      const hasCNC = classes.has('router');
      const hasVector = [...classes].some((cls) => cls !== 'router' && cls !== 'laser');
      const byId = (id) => document.getElementById(id);
      byId('exporter-cnc-options')?.classList.toggle('is-disabled', !hasCNC);
      byId('exporter-cnc-preview')?.classList.toggle('is-disabled', !hasCNC);
      byId('exporter-laser-options')?.classList.toggle('is-disabled', !classes.has('laser'));
      byId('exporter-stencil-options')?.classList.toggle('is-disabled', !hasVector);
      const calcBtn = byId('exporter-calculate-btn');
      if (calcBtn) calcBtn.disabled = !hasCNC;
    }

    setupExportHandlers() {
      const byId = (id) => document.getElementById(id);
      // .onchange / .onclick throughout: this re-runs on every modal open,
      // and addEventListener on a static element stacks a new listener
      // each time.
      const cancelBtn = byId('exporter-cancel-btn');
      if (cancelBtn) cancelBtn.onclick = () => this.closeModal();
      const calcBtn = byId('exporter-calculate-btn');
      if (calcBtn) calcBtn.onclick = () => this.runToolpathOrchestration();
      // A tick is recorded as data-wanted before anything reads it: a
      // gate may untick an option that cannot apply, and
      // refreshExportState gives the choice back once it can.
      const wire = (id, after) => {
        const toggle = byId(id);
        if (!toggle) return;
        toggle.onchange = () => {
          toggle.dataset.wanted = String(toggle.checked);
          after();
        };
      };
      // These change which files exist or which tools a file holds.
      for (const id of ['exporter-single-file', 'exporter-split-drills', 'exporter-tool-changes']) {
        wire(id, () => {
          this.refreshExportState();
          this.invalidateCalculated();
        });
      }
      // These change the program text only.
      for (const id of ['exporter-group-by-tool', 'exporter-verbose-comments', 'exporter-optimize-paths']) {
        wire(id, () => this.invalidateCalculated());
      }
      // Comments change the program text and gate the verbose option.
      wire('exporter-include-comments', () => {
        this.refreshExportState();
        this.invalidateCalculated();
      });
      // Delivery only - calculated programs stay valid.
      wire('exporter-zip', () => this.refreshExportState());
      // The base name only changes file names, so only the summary redraws.
      const filenameInput = byId('exporter-filename');
      if (filenameInput) {
        filenameInput.oninput = () => {
          const intent = this.readExportIntent();
          this.renderExportSummary(this.ctrl.core.planExportFiles(intent), intent);
        };
      }
      // Preview selector: switch the displayed program
      const previewSelect = byId('exporter-preview-select');
      if (previewSelect) previewSelect.onchange = (e) => this.showGcodeForOperation(e.target.value);
      // Copy to Clipboard
      const copyBtn = byId('exporter-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = async () => {
          const previewText = byId('exporter-preview-text');
          if (!previewText?.value) {
            this.ui.setStatus(i18n.t('messages.export.nothingToCopy'), 'warning');
            return;
          }
          try {
            await navigator.clipboard.writeText(previewText.value);
            this.ui.setStatus(i18n.t('messages.export.copied'), 'success');
            // Visual feedback via class toggle
            copyBtn.classList.add('copy-success');
            setTimeout(() => copyBtn.classList.remove('copy-success'), 2000);
          } catch (err) {
            console.error('[UI-ModalManager] Failed to copy text:', err);
            this.ui.setStatus(i18n.t('messages.export.copyFailed'), 'error');
          }
        };
      }
      const executeBtn = byId('exporter-execute-btn');
      if (executeBtn) executeBtn.onclick = () => this.executeUnifiedExport();
    }

    async executeUnifiedExport() {
      const intent = this.readExportIntent();
      if (intent.operationIds.length === 0) {
        this.ui.setStatus(i18n.t('messages.export.noneSelected'), 'warning');
        return;
      }
      // Loose files are paced one by one in WebKit; an archive is one download.
      const looseFiles = intent.zip ? 0 : this.ctrl.core.planExportFiles(intent).files.length;
      const paced = looseFiles > 1 && this.ctrl.pacesDownloads;
      try {
        const result = await this.ui.runTask(i18n.t(paced ? 'progress.exportingPaced' : 'progress.exporting'), () => this.ctrl.executeExports(intent));
        if (result.success) {
          this.ui.setStatus(result.message, result.failures.length > 0 ? 'warning' : 'success');
          this.closeModal();
        } else {
          this.ui.setStatus(result.message || i18n.t('messages.export.producedNothing'), 'warning');
        }
      } catch (error) {
        console.error('[UI-ModalManager] Export failed:', error);
        this.ui.setStatus(i18n.t('messages.export.failed', { error }), 'error');
      }
    }

    /**
     * The (?) help on every export option, from modals.exporter.*: what
     * the option does and when it applies. Why it is off right now is the
     * row's own note. Once per element - the modal reopens, its markup
     * stays.
     */
    attachExporterModalTooltips() {
      if (!window.TooltipManager) return;
      const processed = this.exporterModalTooltipsProcessed;
      // Worded when shown, so a language change reaches them.
      const help = key => () => ({title: i18n.t(`${key}.label`), text: i18n.t(`${key}.help`)});
      const attachTo = (inputId, key) => {
        const label = document.getElementById(inputId)?.closest('.property-field')?.querySelector('label');
        if (!label || processed.has(label)) return;
        processed.add(label);
        window.TooltipManager.attachWithIcon(label, help(key), {showOnFocus: true});
      };
      const hoverHelp = (el, key) => {
        if (!el || processed.has(el)) return;
        processed.add(el);
        window.TooltipManager.attach(el, help(key), {showOnFocus: true});
      };
      const exporter = name => `modals.exporter.${name}`;
      attachTo('exporter-filename', exporter('filename'));
      attachTo('exporter-single-file', exporter('singleFile'));
      attachTo('exporter-split-drills', exporter('splitDrills'));
      attachTo('exporter-zip', exporter('zip'));
      attachTo('exporter-include-comments', exporter('includeComments'));
      attachTo('exporter-verbose-comments', exporter('verboseComments'));
      attachTo('exporter-tool-changes', exporter('toolChanges'));
      attachTo('exporter-group-by-tool', exporter('groupByTool'));
      attachTo('exporter-optimize-paths', exporter('optimize'));
      attachTo('laser-exporter-padding', 'params.laserExportPadding');
      attachTo('stencil-exporter-padding', 'params.stencilExportPadding');
      hoverHelp(document.getElementById('exporter-order-help'), exporter('order'));
      hoverHelp(document.getElementById('exporter-calculate-btn'), exporter('calculate'));
    }

    /**
     * Calculate button. Reads intent from the DOM, hands the job to the core
     * under a task, renders what comes back. Which operations run, whether
     * they are ready and how they group into programs are CamCore's
     * decisions - the only thing that belongs here is the panel.
     */
    async runToolpathOrchestration() {
      try {
        const job = await this.ui.runTask(i18n.t('progress.toolpaths'), () => this.ctrl.core.computeExportPrograms(this.readExportIntent(), this.ctrl.parameterStore));
        this.resetExportPreview();
        if (!job.ok) {
          if (job.reason === 'not-ready') {
            this.ui.setStatus(i18n.t('messages.export.notReady', { files: job.notReady.map(o => o.file.name) }), 'warning');
          } else {
            this.ui.setStatus(i18n.t('messages.export.noCncOperations'), 'info');
          }
          return;
        }
        const produced = job.files.filter(file => job.results[file.key]);
        if (produced.length === 0) {
          this.ui.setStatus(i18n.t('messages.export.noGcode'), 'warning');
          return;
        }
        const previewSelect = document.getElementById('exporter-preview-select');
        if (previewSelect) {
          for (const file of produced) {
            const option = document.createElement('option');
            option.value = file.key;
            option.textContent = file.filename;
            previewSelect.appendChild(option);
          }
          previewSelect.value = produced[0].key;
        }
        const selector = document.getElementById('exporter-operation-selector');
        if (selector) selector.style.display = produced.length > 1 ? '' : 'none';
        this.showGcodeForOperation(produced[0].key);
      } catch (error) {
        console.error('[UI-ModalManager] Orchestration failed:', error);
        this.resetExportPreview();
        this.ui.setStatus(i18n.t('messages.export.calculationFailed', { error }), 'error');
      }
    }

    setupFocusTrap(modal) {
      const focusableSelector = 
        'button:not([disabled]), [href]:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      // Store for trap logic
      this.currentModalFocusables = () => {return Array.from(modal.querySelectorAll(focusableSelector));};
      // Trap focus - handles both initial entry and cycling
      this.focusTrapListener = (e) => {
        if (e.key !== 'Tab') return;
        const focusables = this.currentModalFocusables();
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const current = document.activeElement;
        // Check if focus is currently inside this modal
        const focusInModal = modal.contains(current);
        if (!focusInModal) {
          // First Tab press - enter the modal
          e.preventDefault();
          if (e.shiftKey) {
            last.focus();
          } else {
            first.focus();
          }
          return;
        }
        // Normal cycling within modal
        if (e.shiftKey && current === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        }
      };
      // Listen on document to catch Tab when focus is outside modal
      document.addEventListener('keydown', this.focusTrapListener);
    }

    removeFocusTrap() {
      if (this.focusTrapListener) {
        document.removeEventListener('keydown', this.focusTrapListener);
        this.focusTrapListener = null;
      }
      this.currentModalFocusables = null;
    }

    setupModalFieldNavigation(modal) {
      const content = modal.querySelector('.modal-content');
      if (!content) return;
      // showModal runs on every open. Without this flag each open stacks
      // another listener and ArrowDown starts skipping N fields.
      if (content.dataset.fieldNavBound === 'true') return;
      content.dataset.fieldNavBound = 'true';
      content.addEventListener('keydown', (e) => {
        // Only handle arrows
        if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
        const focused = document.activeElement;
        // Skip if in select (let native handle), textarea and number
        if (focused.tagName === 'SELECT' || focused.tagName === 'TEXTAREA' || focused.type === 'number') return;
        // Get all navigable fields
        const fields = Array.from(content.querySelectorAll(
          'input:not([type="hidden"]):not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]'
        )).filter(el => el.offsetParent !== null); // visible only
        const idx = fields.indexOf(focused);
        if (idx === -1) return;
        const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
        if (fields[nextIdx]) {
          e.preventDefault();
          fields[nextIdx].focus();
        }
      });
    }

    // Warning modal
    showWarning(title, message, options = {}) {
      const modal = this.modals.warning;
      if (!modal) {
        console.error('[ModalManager] Warning modal not found in DOM');
        return;
      }
      // One element, one set of callbacks: a prompt raised while another
      // is open or stacked waits until that one closes.
      if (this.activeModal === modal || this.modalStack.includes(modal)) {
        this.warningQueue.push([title, message, options]);
        return;
      }
      // onShow(modal) runs once the prompt's markup is on screen.
      // Title, message and button texts may be strings or message
      // descriptors; format() words both.
      const {
        onConfirm,
        onCancel,
        onShow,
        confirmText = i18n.t('common.ok'),
        cancelText = i18n.t('common.cancel'),
        bodyHTML = null
      } = options;
      // Track active callbacks at the class level for keyboard/backdrop dismissal
      this.activeWarningCallbacks = { onConfirm, onCancel };
      // Set content
      modal.querySelector('.warning-title').textContent = i18n.format(title);
      const bodyContainer = modal.querySelector('.warning-body');
      if (bodyHTML) {
        bodyContainer.innerHTML = bodyHTML;
      } else {
        const p = document.createElement('p');
        p.className = 'warning-message';
        p.textContent = i18n.format(message);
        bodyContainer.replaceChildren(p);
      }
      // Setup buttons
      const confirmBtn = modal.querySelector('.warning-confirm');
      confirmBtn.textContent = i18n.format(confirmText);
      confirmBtn.disabled = false;
      confirmBtn.onclick = () => {
        if (this.activeWarningCallbacks?.onConfirm) this.activeWarningCallbacks.onConfirm();
        this.activeWarningCallbacks = null;
        this.closeModal();
      };
      const cancelBtn = modal.querySelector('.warning-cancel');
      if (onCancel) {
        cancelBtn.style.display = '';
        cancelBtn.textContent = i18n.format(cancelText);
        cancelBtn.onclick = () => {
          if (this.activeWarningCallbacks?.onCancel) this.activeWarningCallbacks.onCancel();
          this.activeWarningCallbacks = null;
          this.closeModal();
        };
      } else {
        cancelBtn.style.display = 'none';
      }
      this.showModal('warning');
      onShow?.(modal);
    }

    debug(message, data = null) {
      if (this.ui.debug) this.ui.debug(`[UI-ModalManager] ${message}`, data);
    }
  }

  window.ModalManager = ModalManager;
})();