/*!
* @file        cam-easytrace5000.js
* @description EasyTrace5000 application controller - UI orchestration, file handling, export
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
  const PRECISION = C.precision.coordinate;

  class EasyTraceController extends CamController {
    // 3D copper: types drawn as copper, and types whose previews cut it
    // (clearing is both).
    static COPPER_TYPES = new Set(['isolation', 'clearing']);
    static CUTTER_TYPES = new Set(['drill', 'clearing']);

    constructor() {
      super();
      // Copper drawn in 3D with every cutter removed, keyed by operation
      // id; `inputs` are the arrays it was computed from.
      this.copper3D = { inputs: null, byOp: new Map(), pending: null };
    }

    // ────────────────────────────────────────────────────────────────────
    // Template Hooks
    // ────────────────────────────────────────────────────────────────────

    getAppLabel() { 
      return 'EasyTrace5000 PCB Workspace';
    }

    getProfileConfig() {
      return { embeddedVar: 'EMBEDDED_PROFILE_TRACE', fetchPath: '../ui/profile-trace.json' };
    }

    createUI() {
      return new EasyTraceUI(this);
    }

    registerHandlers() {
      // Parsers. Every extension a profile type routes needs a parser here, and every one here
      // a type that routes it: the two lists are kept by hand, so a mismatch is reported.
      this.core.ingest.registerParser('.svg', new SVGParser());
      const gerber = new GerberParser();
      for (const ext of ['.gbr', '.ger', '.gtl', '.gbl', '.gbx', '.gts', '.gbs', '.gtp', '.gbp', '.gko', '.gml', '.gm1']) {
        this.core.ingest.registerParser(ext, gerber);
      }
      const excellon = new ExcellonParser();
      for (const ext of ['.drl', '.xln', '.txt', '.tap', '.drill', '.exc']) {
        this.core.ingest.registerParser(ext, excellon);
      }
      for (const ext of this.registry.extensions()) {
        if (!this.core.ingest.parsers.has(ext)) console.error(`[EasyTrace] No parser for ${ext}`);
      }
      // Handlers
      super.registerHandlers();
    }

    /**
     * PCB slab: board bounds in machine space, thickness from settings.
     */
    get3DStockBox(w2m) {
      const b = this.core.scene?.boardBounds;
      if (!(b && b.maxX > b.minX)) return null;
      const thickness = this.core.settings.machine.stock.thickness;
      const zeroRef = this.core.settings.machine.stock.zeroReference;
      const topZ = zeroRef && "material" !== zeroRef ? thickness : 0;
      const machineMatrix = this.core.pipelineContext.getTransforms().machineMatrix;
      const w = b.maxX - b.minX;
      const d = b.maxY - b.minY;
      return {
        width: w,
        depth: d,
        thickness,
        topZ,
        surfaceZ: topZ,
        centerX: (b.minX + b.maxX) / 2,
        centerY: (b.minY + b.maxY) / 2,
        matrix: machineMatrix
      };
    }

    /**
     * Starts the 3D copper subtraction when its inputs change. Keyed on
     * input-array identity: regenerating, deleting or removing an operation
     * replaces or drops its array, so no result outlives its inputs and
     * nothing has to invalidate it.
     */
    refresh3DModel(ctx) {
      const ops = this.core.operations;
      const copperOps = ops.filter((op) => EasyTraceController.COPPER_TYPES.has(op.type) && op.primitives?.length > 0);
      // A stale preview (ready === false) cuts nothing.
      const cutterOps = ops.filter(
        (op) => EasyTraceController.CUTTER_TYPES.has(op.type) && op.preview?.ready && op.preview.primitives?.length > 0,
      );
      const inputs = [...copperOps.map((op) => op.primitives), ...cutterOps.map((op) => op.preview.primitives)];
      const cache = this.copper3D;
      const current = cache.inputs?.length === inputs.length && inputs.every((ref, i) => ref === cache.inputs[i]);
      if (current || cache.pending) return null;
      if (0 === copperOps.length || 0 === cutterOps.length || !this.core.geometryProcessor) {
        cache.inputs = inputs;
        cache.byOp = new Map();
        return null;
      }
      cache.pending = this.subtractCutters3D(copperOps, cutterOps)
        .then((byOp) => {
          cache.byOp = byOp;
        })
        .catch((err) => {
          console.error('[EasyTrace] 3D copper subtraction failed:', err);
          cache.byOp = new Map();
        })
        .finally(() => {
          cache.inputs = inputs;
          cache.pending = null;
          this.render3D();
        });
      return null;
    }

    /**
     * Each copper operation's source minus every cutter. Each handler says
     * what its own preview primitives cut, so drill tooling, millHoles and
     * slot strategy are never re-derived here.
     * @returns {Promise<Map<string, Array>>} differenced primitives by operation id
     */
    async subtractCutters3D(copperOps, cutterOps) {
      const gp = this.core.geometryProcessor;
      const pieces = [];
      for (const op of cutterOps) {
          const handler = this.core.getHandler(op.type);
        for (const prim of op.preview.primitives) {
          for (const piece of handler.previewCutArea(prim)) pieces.push(piece);
        }
      }
      const cutters = pieces.length > 0 ? await gp.unionGeometry(pieces) : [];
      const byOp = new Map();
      for (const op of copperOps) {
        const copper = [];
        for (const prim of op.primitives) {
          const standardized = gp.standardizePrimitive(prim, prim.curveIds || []);
          if (Array.isArray(standardized)) {
            for (const s of standardized) copper.push(s);
          } else if (standardized) {
            copper.push(standardized);
          }
        }
        if (copper.length > 0) byOp.set(op.id, await gp.difference(copper, cutters));
      }
      return byOp;
    }

    /** Copper source layers draw with every cutter removed once the subtraction lands. */
    layerPrimitives3D(layer, op) {
      if ('source' !== layer.role || !op) return layer.primitives;
      return this.copper3D.byOp.get(op.id) || layer.primitives;
    }

    registerAppShortcuts() {
      this.shortcutManager.registerActions({
        deleteSelection: () => {
          const node = this.ui.navTreePanel.selectedNode;
          if (node?.type === 'file' && node.operation) this.ui.promptRemoveOperation(node.operation.id);
        },
        addFiles: () => this.modalManager.showModal('quickstart'),
        bottomLeftOrigin: () => this.ui.bottomLeftOrigin(),
        offsetOrigin: () => this.ui.commitOrigin(),
        centerOrigin: () => this.ui.centerOrigin(),
        cycleCategory: (e, opType) => {
          this.ui.navTreePanel.cycleOperationCategory(opType);
          this.ui.setStatus(i18n.t('messages.operations.categorySelected', { category: this.registry.labelFor(opType) }), 'info', { log: false });
        },
        pan: (e, mx, my) => {
          if (this.renderMode === '3d') return; // Pan does nothing in 3D
          if (document.activeElement?.closest('#sidebar-left, #sidebar-right')) return;
          const amount = e.shiftKey ? 100 : 25;
          this.ui.renderer.pan(mx * amount, my * amount);
          this.ui.renderer.render();
        }
      });
    }

    handleEscapeKey(e) {
      const rightSidebar = document.getElementById('sidebar-right');
      if (rightSidebar && rightSidebar.contains(document.activeElement)) { this.returnFocusToTree(); return; }
      if (document.activeElement === document.getElementById('preview-canvas')) { this.returnFocusToTree(); return; }
      if (this.ui.navTreePanel.selectedNode) {
        this.ui.navTreePanel.selectedNode = null;
        document.querySelectorAll('.file-node-content.selected, .geometry-node.selected').forEach(el => el.classList.remove('selected'));
        this.ui.traceOperationPanel.clearProperties();
      }
    }

    onBindEvents() {
      document.getElementById('toolbar-add-files')?.addEventListener('click', () => {
        this.modalManager.showModal('quickstart');
        this.closeDropdown();
      });
    }

    onFinalize() {
      this.modalManager.showStartupModal();
    }

    returnFocusToTree() {
      const selected = document.querySelector('.file-node-content.selected, .geometry-node.selected');
      // A geometry node is selected on its wrapper; the treeitem is its content row.
      const target = selected?.matches('.geometry-node') ? selected.querySelector('.geometry-node-content') : selected;
      if (target) this.ui.navTreePanel.setFocusOnItem(document.querySelector('#operations-tree [tabindex="0"]'), target);
      else document.querySelector('.category-header')?.focus();
    }

    // ────────────────────────────────────────────────────────────────────
    // File Processing
    // ────────────────────────────────────────────────────────────────────

    clearWorkspace() {
      this.core.clearAll();
      this.ui.navTreePanel.refreshTree();
    }

    async processFile(file, type) {
      const validation = this.core.ingest.validateFileType(file.name, type);
      if (validation && !validation.valid) { this.ui.setStatus(validation.message, 'error'); return; }
      const operation = this.core.store.createOperation(type, file);
      if (!operation) { console.error('Failed to create operation'); return; }
      this.ui.navTreePanel.addFileNode(operation);
      try {
        operation.file.content = await file.text();
      } catch (err) {
        operation.error = i18n.t('messages.files.readFailedShort');
        this.ui.setStatus(i18n.t('messages.files.readFailedNamed', { file: file.name }), 'error');
        return;
      }
      try {
        const success = await this.core.ingest.parseOperation(operation);
        if (success) {
          const count = operation.primitives.length;
          if (operation.needsClosurePrompt && operation.closureInfo) {
            setTimeout(() => this.handleClosurePrompt(operation), 200);
          }
          if (operation.type === 'drill' && operation.drillRecoverable) {
            setTimeout(() => this.handleDrillRecovery(operation), 250);
          }
          const guessed = operation.warnings.some(w => (w.message ?? w)?.key === 'messages.parser.excellon.formatGuessed');
          this.ui.reportFileLoaded(operation.file.name, i18n.t(guessed ? 'messages.files.drillsGuessed' : 'messages.files.loadedPrimitives', {
            file: operation.file.name,
            count
          }), operation.warnings);
          this.core.updateBoardBounds();
        } else {
          this.ui.setStatus(i18n.t('messages.files.processingError', { file: operation.file.name, error: operation.error }), 'error');
        }
      } catch (err) {
        console.error(`[EasyTrace] Failed to process ${file.name}:`, err);
        this.ui.setStatus(i18n.t('messages.files.processingError', { file: file.name, error: err }), 'error');
      }
      const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
      if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
      await this.ui.rebuildLayers();
      this.ui.updateStatistics();
    }

    handleClosurePrompt(operation) {
      if (!this.modalManager) return;
      const info = operation.closureInfo;
      const actualGaps = [...(info.gaps?.length > 0 ? info.gaps : GeometryTopology.analyzeSegmentGaps(info.rawPrimitives))].reverse();
      const suggestedTol = (Math.max(...actualGaps) + PRECISION).toFixed(3);
      let lastProbeResult = null;
      const runProbe = (tol) => {
        const { loops, orphans } = GeometryTopology.extractClosedLoops(info.rawPrimitives, tol);
        return { success: orphans.length === 0 && loops.length > 0, loops, chainedCount: info.rawPrimitives.length - orphans.length, totalSegments: info.rawPrimitives.length, unchainedCount: orphans.length, testedTol: tol };
      };
      lastProbeResult = runProbe(parseFloat(suggestedTol));
      const gapTextList = actualGaps.length > 0
        ? i18n.list(actualGaps.slice(0, 3).map(g => i18n.t('common.millimeters', { value: g.toFixed(4) })), 'unit')
        : i18n.t('dialogs.openCutout.unknownGaps');
      const formatResult = result => {
        if (!result) return `<span style="color:var(--color-error);">${i18n.html('dialogs.openCutout.probeFailed')}</span>`;
        const color = result.success ? 'var(--color-success)' : 'var(--color-error)';
        const iconId = result.success ? 'icon-check' : 'icon-close';
        const icon = `<svg class="cam-icon" width="14" height="14" style="vertical-align: text-bottom;"><use href="#${iconId}"></use></svg>`;
        let html = `<span style="color:${color};font-weight:bold;">${icon} ${i18n.html('dialogs.openCutout.joined', { joined: result.chainedCount, count: result.totalSegments })}</span>`;
        if (result.success) {
          html += `<br><span style="color:var(--color-text-secondary);">${i18n.html('dialogs.openCutout.closed', { tolerance: result.testedTol })}</span>`;
        } else {
          html += `<br><span style="color:var(--color-error);">${i18n.html('dialogs.openCutout.remaining', { count: result.unchainedCount })}</span>`;
          html += `<br><span style="color:var(--color-text-secondary);">${i18n.html('dialogs.openCutout.increase')}</span>`;
        }
        return html;
      };
      const extractedCount = operation.extractedLoops ? operation.extractedLoops.length : 0;
      let introHTML = `<p>${i18n.html('dialogs.openCutout.intro', { file: operation.file.name })}</p>`;
      if (extractedCount > 0) introHTML = `<p>${i18n.html('dialogs.openCutout.partial', {
          count: extractedCount,
          segments: { key: 'dialogs.openCutout.segmentCount', values: { count: info.rawPrimitives.length } }
      })}</p>`;
      const bodyHTML = `${introHTML}<div class="closure-gaps">${i18n.html('dialogs.openCutout.gaps', { gaps: gapTextList })}</div><p>${i18n.html('dialogs.openCutout.setTolerance')}</p><div class="closure-controls"><label for="closure-tolerance">${i18n.html('dialogs.openCutout.tolerance')}</label><div class="input-unit"><input type="number" id="closure-tolerance" value="${suggestedTol}" min="0.001" max="5.0" step="0.001"><span class="unit">${i18n.html(['units', 'mm'])}</span></div><button id="closure-test-btn" class="btn btn--secondary btn--compact">${i18n.html('dialogs.openCutout.test')}</button></div><div class="closure-results" id="closure-probe-results">${formatResult(lastProbeResult)}</div>`;
      this.modalManager.showWarning(i18n.t('dialogs.openCutout.title'), null, {
        bodyHTML,
        confirmText: i18n.t('dialogs.openCutout.confirm'),
        cancelText: i18n.t('dialogs.openCutout.cancel'),
        onConfirm: async () => {
          const resolvedLoops = lastProbeResult?.loops;
          if (resolvedLoops?.length > 0) {
            const allLoops = operation.extractedLoops
              ? [...operation.extractedLoops, ...resolvedLoops]
              : resolvedLoops;
            const topology = GeometryTopology.classifyCutoutTopology(allLoops);
            const compounds = GeometryTopology.assembleCutoutCompounds(topology);
            operation.primitives = compounds.length > 0 ? compounds : allLoops;
            delete operation.extractedLoops;
            operation.bounds = this.core.ingest.recalculateBounds(operation.primitives);
            delete operation.needsClosurePrompt;
            delete operation.closureInfo;
            if (operation.warnings)
              operation.warnings = operation.warnings.filter(w => (w.message ?? w)?.key !== 'messages.cutout.openSegments');
            if (this.ui.navTreePanel) {
              const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id);
              if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation);
            }
            await this.ui.rebuildLayers();
            this.ui.setStatus(i18n.t('messages.cutout.closed'), 'success');
          } else {
            this.ui.setStatus(i18n.t('messages.cutout.cannotClose'), 'error');
          }
        },
        onCancel: () => {
          delete operation.needsClosurePrompt;
          delete operation.closureInfo;
          delete operation.extractedLoops;
          this.ui.setStatus(
            operation.primitives?.length > 0
              ? i18n.t('messages.cutout.orphansDiscarded')
              : i18n.t('messages.cutout.leftOpen'),
            'info'
          );
        },
        // The controls exist only once this prompt is on screen; a queued
        // prompt shows after the one before it closes.
        onShow: (modal) => {
          const testBtn = modal.querySelector('#closure-test-btn');
          const tolInput = modal.querySelector('#closure-tolerance');
          const resultsDiv = modal.querySelector('#closure-probe-results');
          const confirmBtn = modal.querySelector('.warning-confirm');
          if (!testBtn || !tolInput || !resultsDiv) return;
          const doTest = () => {
            const rawTol = parseFloat(tolInput.value);
            if (!rawTol || rawTol <= 0) {
              resultsDiv.innerHTML = `<span style="color:var(--color-error);">${i18n.html('dialogs.openCutout.positive')}</span>`;
              return;
            }
            lastProbeResult = runProbe(Math.min(5.0, Math.max(0.001, rawTol)));
            resultsDiv.innerHTML = formatResult(lastProbeResult);
            confirmBtn.disabled = !lastProbeResult?.success;
          };
          testBtn.addEventListener('click', doTest);
          tolInput.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') doTest();
          });
          confirmBtn.disabled = !lastProbeResult?.success;
        },
      });
    }

    handleDrillRecovery(operation) {
      if (!this.modalManager) return;
      const rec = operation.drillRecoverable;
      // One entry per size: common.holesOfSize for circles, common.slotsOfSize for obrounds.
      const buildSizeList = (items, type) => {
        const groups = new Map();
        for (const item of items) {
          const d = item.detected.diameter;
          let values = { diameter: d.toFixed(3) };
          if (type !== 'circle') {
            const slot = item.detected.originalSlot;
            const length = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y) + d;
            values = { width: d.toFixed(3), length: length.toFixed(3) };
          }
          const id = Object.values(values).join('x');
          const group = groups.get(id) ?? { values, count: 0 };
          group.count++;
          groups.set(id, group);
        }
        const key = type === 'circle' ? 'common.holesOfSize' : 'common.slotsOfSize';
        return [...groups.values()]
          .map(g => `<div class="recovery-size-entry">${i18n.html(key, { ...g.values, count: g.count })}</div>`)
          .join('');
      };
      const column = (items, type, titleKey, hintKey) => items?.length ? `
        <div class="drill-recovery-column">
          <h4>${i18n.html(titleKey, { count: items.length })}</h4>
          <p>${i18n.html(hintKey)}</p>
          ${buildSizeList(items, type)}
        </div>` : '';
      const circleCount = rec.circles?.length || 0;
      const obroundCount = rec.obrounds?.length || 0;
      const single = circleCount === 0 || obroundCount === 0;
      const bodyHTML = `
        <p>${i18n.html('dialogs.drillRecovery.intro', { file: operation.file.name, count: circleCount + obroundCount })}</p>
        <div class="drill-recovery-grid${single ? ' drill-recovery-single' : ''}">
          ${column(rec.circles, 'circle', 'dialogs.drillRecovery.circles', 'dialogs.drillRecovery.circlesHint')}
          ${column(rec.obrounds, 'obround', 'dialogs.drillRecovery.obrounds', 'dialogs.drillRecovery.obroundsHint')}
        </div>
        <p class="drill-recovery-question">${i18n.html('dialogs.drillRecovery.question')}</p>`;
      this.modalManager.showWarning(i18n.t('dialogs.drillRecovery.title'), null, {
        bodyHTML,
        confirmText: i18n.t('dialogs.drillRecovery.confirm'),
        cancelText: i18n.t('dialogs.drillRecovery.cancel'),
        onConfirm: async () => {
          this.core.getHandler('drill').promoteDrillRecoverable(operation, circleCount > 0, obroundCount > 0);
          if (this.ui.navTreePanel) {
            const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id);
            if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation);
          }
          await this.ui.rebuildLayers();
          this.ui.setStatus(i18n.t('messages.drill.recovered', { count: circleCount + obroundCount }), 'success');
        },
        onCancel: () => {
          delete operation.drillRecoverable;
          this.ui.setStatus(i18n.t('messages.drill.recoverySkipped'), 'info');
        }
      });
    }

    // ────────────────────────────────────────────────────────────────────
    // API
    // ────────────────────────────────────────────────────────────────────

    onPipelineSelected(pipelineId) {
      if (pipelineId === 'laser') return 'laserConfig';
      this.setMachineClass('router');
      return 'quickstart';
    }

    getQuickstartOpTypes() {
      return [...this.registry.tabTypes().filter(t => t !== 'stencil'), 'unassigned'];
    }

    getTreeFocusSelector() {
      return '#operations-tree [tabindex="0"]';
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ────────────────────────────────────────────────────────────────────

  let ctrl = null;

  async function startTraceApp() {
    if (ctrl) { console.warn('Application already initialized'); return; }
    ctrl = new EasyTraceController();
    await ctrl.initialize();
    return true;
  }

  window.startTraceApp = startTraceApp;
})();