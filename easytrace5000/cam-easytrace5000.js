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

    const escapeHTML = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

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

        // ════════════════════════════════════════════════════════════════
        // Template Hooks
        // ════════════════════════════════════════════════════════════════

        getAppLabel() { return 'EasyTrace5000 PCB Workspace'; }

        getProfileConfig() {
            return { embeddedVar: 'EMBEDDED_PROFILE_TRACE', fetchPath: '../ui/profile-trace.json' };
        }

        createUI() {
            return new EasyTraceUI(this);
        }

        registerHandlers() {
            // Parsers
            this.core.ingest.registerParser('.svg', new SVGParser());

            const gerber = new GerberParser();
            for (const ext of ['.gbr', '.ger', '.gtl', '.gbl', '.gp1', '.gnd', '.gbp', '.gm1', '.gko']) {
                this.core.ingest.registerParser(ext, gerber);
            }

            const excellon = new ExcellonParser();
            for (const ext of ['.drl', '.xln', '.txt', '.drill', '.exc']) {
                this.core.ingest.registerParser(ext, excellon);
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
                toggleWireframe: () => {
                    const t = document.getElementById('show-wireframe');
                    if (t) {
                        t.checked = !t.checked;
                        t.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                },
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
                    const label = this.registry?.labelFor(opType) || opType;
                    this.ui.setStatus(`${label} category`, 'info', true);
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
            // A file dropped anywhere outside the quickstart drop zones loads
            // straight into the workspace.
            window.addEventListener('dragover', e => {
                e.preventDefault();
                if (this.modalManager.activeModal) e.dataTransfer.dropEffect = 'none';
            });
            window.addEventListener('drop', async e => {
                e.preventDefault();
                if (this.modalManager.activeModal) return;
                if (e.target.closest('.file-drop-zone') || e.target.closest('#file-drop-zone')) return;
                // filesFromDrop reads the DataTransfer before this handler yields.
                await this.handleGlobalFileDrop(await UIControls.filesFromDrop(e.dataTransfer));
            });
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

        // ════════════════════════════════════════════════════════════════
        // File Processing
        // ════════════════════════════════════════════════════════════════

        clearWorkspace() {
            this.core.clearAll();
            this.ui.navTreePanel.refreshTree();
        }

        async processFile(file, type) {
            if (!file || !type) { console.error('Invalid file or type provided'); return; }
            const validation = this.core.ingest.validateFileType(file.name, type);
            if (validation && !validation.valid) { this.ui.setStatus(validation.message, 'error'); return; }
            const operation = this.core.store.createOperation(type, file);
            if (!operation) { console.error('Failed to create operation'); return; }
            this.ui.navTreePanel.addFileNode(operation);
            this.ui.setStatus(`${this.appProfile.ui.text.statusLoading || 'Loading...'} ${file.name}...`, 'info', true);
            try {
                operation.file.content = await file.text();
            } catch (err) {
                operation.error = 'Failed to read file';
                this.ui.setStatus(`Failed to read ${file.name}`, 'error');
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
                    let finalStatusMsg = `Loaded ${operation.file.name}: ${count} primitives`;
                    let finalStatusType = 'success';
                    if (operation.warnings?.length > 0) {
                        for (const w of operation.warnings) {
                            const msg = typeof w === 'string' ? w : w.message;
                            const severity = (typeof w === 'object' && w.severity) || 'warning';
                            this.ui.setStatus(`${operation.file.name}: ${msg}`, severity);
                            if (msg.includes('No explicit format found')) {
                                finalStatusMsg = `Loaded ${operation.file.name}: ${count} drills (Guessed Format!)`;
                                finalStatusType = 'warning';
                            }
                        }
                    }
                    this.ui.setStatus(finalStatusMsg, finalStatusType);
                    this.core.updateBoardBounds();
                } else {
                    this.ui.setStatus(`Error processing ${operation.file.name}: ${operation.error}`, 'error');
                }
            } catch (err) {
                console.error(`[EasyTrace] Failed to process ${file.name}:`, err);
                this.ui.setStatus(`Error processing ${file.name}: ${err.message}`, 'error');
            }
            const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
            if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
            await this.ui.rebuildLayers();
            if (this.core.operations.length <= 1) this.ui.zoomFit();
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
            const gapTextList = actualGaps.length > 0 ? actualGaps.slice(0, 3).map(g => g.toFixed(4) + 'mm').join(', ') : 'Unknown';
            const formatResult = (result) => {
                if (!result) return '<span style="color:var(--color-error);">Probe failed.</span>';
                const color = result.success ? 'var(--color-success)' : 'var(--color-error)';
                const iconId = result.success ? 'icon-check' : 'icon-close';
                const icon = `<svg class="cam-icon" width="14" height="14" style="vertical-align: text-bottom;"><use href="#${iconId}"></use></svg>`;
                let html = `<span style="color:${color};font-weight:bold;">${icon} ${result.chainedCount} of ${result.totalSegments} segments joined</span>`;
                if (result.success) html += `<br><span style="color:var(--color-text-secondary);">Path successfully closed using ${result.testedTol}mm tolerance.</span>`;
                else { html += `<br><span style="color:var(--color-error);">${result.unchainedCount} segment(s) remain disconnected.</span>`; html += `<br><span style="color:var(--color-text-secondary);">Increase tolerance to bridge larger gaps.</span>`; }
                return html;
            };
            const extractedCount = operation.extractedLoops ? operation.extractedLoops.length : 0;
            let introHTML = `<p>The cutout geometry in <strong>${escapeHTML(operation.file.name)}</strong> contains disconnected segments.</p>`;
            if (extractedCount > 0) introHTML = `<p><strong>${extractedCount}</strong> closed loop(s) were extracted successfully, but <strong>${info.rawPrimitives.length}</strong> segment(s) remain disconnected.</p>`;
            const bodyHTML = `${introHTML}<div class="closure-gaps"><strong>Detected Gaps:</strong> ${gapTextList}</div><p>Set a tolerance large enough to bridge the maximum gap:</p><div class="closure-controls"><label for="closure-tolerance">Tolerance:</label><div class="input-unit"><input type="number" id="closure-tolerance" value="${suggestedTol}" min="0.001" max="5.0" step="0.001"><span class="unit">mm</span></div><button id="closure-test-btn" class="btn btn--secondary btn--compact">Test</button></div><div class="closure-results" id="closure-probe-results">${formatResult(lastProbeResult)}</div>`;
            this.modalManager.showWarning('Open Cutout Path Detected', null, {
                bodyHTML,
                confirmText: 'Close path',
                cancelText: 'Keep as-is',
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
                            operation.warnings = operation.warnings.filter(
                                (w) => !(typeof w === 'string' ? w : w.message).includes('do not form closed loops'),
                            );
                        if (this.ui.navTreePanel) {
                            const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                            if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation);
                        }
                        await this.ui.rebuildLayers();
                        this.ui.setStatus('Cutout paths automatically closed.', 'success');
                    } else {
                        this.ui.setStatus('Cannot close - test with a higher tolerance first.', 'error');
                    }
                },
                onCancel: () => {
                    delete operation.needsClosurePrompt;
                    delete operation.closureInfo;
                    delete operation.extractedLoops;
                    this.ui.setStatus(
                        operation.primitives?.length > 0
                            ? 'Orphan segments discarded. Board outlines preserved.'
                            : 'Cutout left as open path.',
                        'info',
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
                            resultsDiv.innerHTML =
                                '<span style="color:var(--color-error);">Enter a positive tolerance value.</span>';
                            return;
                        }
                        lastProbeResult = runProbe(Math.min(5.0, Math.max(0.001, rawTol)));
                        resultsDiv.innerHTML = formatResult(lastProbeResult);
                        confirmBtn.disabled = !lastProbeResult?.success;
                    };
                    testBtn.addEventListener('click', doTest);
                    tolInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') doTest();
                    });
                    confirmBtn.disabled = !lastProbeResult?.success;
                },
            });
        }

        handleDrillRecovery(operation) {
            if (!this.modalManager) return;
            const rec = operation.drillRecoverable;

            const buildSizeList = (items, type) => {
                if (!items?.length) return '';
                const groups = new Map();
                for (const item of items) {
                    const d = item.detected.diameter;
                    const key = type === 'circle' ? d.toFixed(3) : (() => { const slot = item.detected.originalSlot; const len = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y); return `${d.toFixed(3)} x ${(len + d).toFixed(3)}`; })();
                    groups.set(key, (groups.get(key) || 0) + 1);
                }
                return Array.from(groups.entries()).map(([size, count]) => `<div class="recovery-size-entry">${type === 'circle' ? `⌀${size}mm` : `${size}mm`} x ${count}</div>`).join('');
            };

            const circleCount = rec.circles?.length || 0;
            const obroundCount = rec.obrounds?.length || 0;
            const gridClass = (circleCount > 0 && obroundCount > 0) ? 'drill-recovery-grid' : 'drill-recovery-grid drill-recovery-single';

            // TODO - Unminify this?
            const bodyHTML = `<p>The SVG file <strong>${escapeHTML(operation.file.name)}</strong> contains ${circleCount + obroundCount} compound path(s) that match known drill shapes.</p><div class="${gridClass}">${circleCount > 0 ? `<div class="drill-recovery-column"><h4>Circle Candidates (${circleCount})</h4><p>Compound paths that form complete circles.</p>${buildSizeList(rec.circles, 'circle')}</div>` : ''}${obroundCount > 0 ? `<div class="drill-recovery-column"><h4>Obround Candidates (${obroundCount})</h4><p>Compound paths that form stadium/capsule shapes.</p>${buildSizeList(rec.obrounds, 'obround')}</div>` : ''}</div><p class="drill-recovery-question">Convert these into valid hole and slot geometry for the drill operation?</p>`;

            this.modalManager.showWarning('Recoverable Drill Geometry', null, {
                bodyHTML,
                confirmText: 'Convert',
                cancelText: 'Skip',
                onConfirm: async () => {
                    this.core.getHandler('drill').promoteDrillRecoverable(operation, circleCount > 0, obroundCount > 0);
                    if (this.ui.navTreePanel) { const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id); if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation); }
                    await this.ui.rebuildLayers();
                    this.ui.setStatus(`Recovered ${circleCount + obroundCount} drill shape(s)`, 'success');
                },
                onCancel: () => { delete operation.drillRecoverable; this.ui.setStatus('Compound shapes skipped', 'info'); }
            });
        }

        /**
         * Loads every dropped file whose extension maps to an operation type.
         * The rest are counted, not ignored: a dropped folder brings whatever
         * sits beside the CAM files (job files, masks, silkscreen, readmes).
         */
        async handleGlobalFileDrop(files) {
            let totalWarnings = 0, formatGuessed = false, fileCount = 0, skipped = 0;
            for (const file of files) {
                const ext = file.name.toLowerCase().split('.').pop();
                const opType = this.registry.typeForExtension(ext);
                if (!opType) { skipped++; continue; }
                await this.processFile(file, opType);
                fileCount++;
                const lastOp = this.core.operations[this.core.operations.length - 1];
                if (lastOp?.warnings?.length > 0) {
                    totalWarnings += lastOp.warnings.length;
                    if (
                        lastOp.warnings.some(w =>
                            (typeof w === 'string' ? w : w.message).includes('No explicit format found')
                        )
                    )
                        formatGuessed = true;
                }
            }
            if (fileCount > 0) {
                this.core.updateBoardBounds();
                this._hasFitted3DOnce = false;
                await this.ui.rebuildLayers();
                this.ui.zoomFit();
                this.ui.renderer.render();
            }
            const skipNote = skipped > 0 ? ` Skipped ${skipped} file(s) with no matching operation type.` : '';
            if (fileCount === 0) {
                this.ui.setStatus(`No loadable files in the drop.${skipNote}`, 'warning');
            } else if (formatGuessed) {
                this.ui.setStatus(
                    `Loaded ${fileCount} file(s). Warning: Excellon format guessed! See log.${skipNote}`,
                    'warning'
                );
            } else if (totalWarnings > 0) {
                this.ui.setStatus(
                    `Loaded ${fileCount} file(s) with ${totalWarnings} warning(s). See log.${skipNote}`,
                    'warning'
                );
            } else if (skipped > 0) {
                this.ui.setStatus(`Loaded ${fileCount} file(s).${skipNote}`, 'info');
            } else if (fileCount > 1) {
                this.ui.setStatus(`Successfully loaded ${fileCount} files.`, 'success', true);
            }
        }

        // ════════════════════════════════════════════════════════════════
        // API
        // ════════════════════════════════════════════════════════════════

        onPipelineSelected(pipelineId) {
            if (pipelineId === 'laser') return 'laserConfig';
            this.setMachineClass('router');
            return 'quickstart';
        }

        getQuickstartOpTypes() {
            return [...this.registry.tabTypes().filter(t => t !== 'stencil'), 'unassigned'];
        }

        getTreeFocusSelector() { return '#operations-tree [tabindex="0"]'; }
    }

    // ════════════════════════════════════════════════════════════════
    // Bootstrap
    // ════════════════════════════════════════════════════════════════

    let ctrl = null;

    async function startTraceApp() {
        if (ctrl) { console.warn('Application already initialized'); return; }
        ctrl = new EasyTraceController();
        await ctrl.initialize();
        return true;
    }

    window.startTraceApp = startTraceApp;
})();