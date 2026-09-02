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
    const D = window.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class EasyTraceController extends CamController {
        constructor() {
            super();
            this.uploadedFiles = { isolation: null, drill: null, clearing: null, cutout: null, stencil: null };
            this.queuedFiles = [];
            this.pendingOperations = [];
        }

        // ════════════════════════════════════════════════════════════════
        // Template Hooks
        // ════════════════════════════════════════════════════════════════

        getAppLabel() { return 'EasyTrace5000 Workspace'; }

        getProfileConfig() {
            return { embeddedVar: 'EMBEDDED_PROFILE_TRACE', fetchPath: '../ui/profile-trace.json' };
        }

        createUI() {
            return new EasyTraceUI(this);
        }

        registerHandlers() {
            // Parsers
            if (typeof SVGParser !== 'undefined') this.core.registerParser('.svg', new SVGParser());
            if (typeof GerberParser !== 'undefined') {
                const gerber = new GerberParser();
                for (const ext of ['.gbr', '.gtl', '.gbl', '.gts', '.gbs', '.gto', '.gbo', '.gtp', '.gbp', '.gm1', '.gko']) {
                    this.core.registerParser(ext, gerber);
                }
            }
            if (typeof ExcellonParser !== 'undefined') {
                const excellon = new ExcellonParser();
                for (const ext of ['.drl', '.xln', '.exc', '.txt']) {
                    this.core.registerParser(ext, excellon);
                }
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
            const thickness = this.core.settings.machine.pcb.thickness;
            const zeroRef = this.core.settings?.machine?.stock?.zeroReference;
            const topZ = (zeroRef && "material" !== zeroRef) ? thickness : 0;
            const machineMatrix = this.core.getTransforms().machineMatrix;
            const w = b.maxX - b.minX;
            const d = b.maxY - b.minY;
            return {
                width: w,
                depth: d,
                thickness: thickness,
                topZ: topZ,
                centerX: (b.minX + b.maxX) / 2,
                centerY: (b.minY + b.maxY) / 2,
                matrix: machineMatrix
            };
        }

        onPostWASM() { this.ui.machineSettings?.updatePipelineFieldVisibility(); }

        registerAppShortcuts() {
            const sm = this.shortcutManager;

            sm.register('w', () => {
                const t = document.getElementById('show-wireframe');
                if (t) { t.checked = !t.checked; t.dispatchEvent(new Event('change', { bubbles: true })); }
            });
            sm.register('Delete', () => this.removeSelectedOperation());
            sm.register('b', () => this.ui.bottomLeftOrigin());
            sm.register('o', () => this.ui.applyOffsetAndSetOrigin());
            sm.register('c', () => this.ui.centerOrigin());

            // Operation category cycling
            for (const [key, opType] of Object.entries({ '1': 'isolation', '2': 'drill', '3': 'clearing', '4': 'cutout', '5': 'stencil' })) {
                sm.register(key, () => this.ui.navTreePanel.cycleOperationCategory(opType));
            }

            // Arrow panning (only when not in sidebar)
            const panKeys = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
            for (const [key, [mx, my]] of Object.entries(panKeys)) {
                sm.register(key, (e) => {
                    const inSidebar = document.activeElement?.closest('#sidebar-left, #sidebar-right');
                    if (inSidebar) return;
                    const amount = e.shiftKey ? 100 : 25;
                    this.ui.renderer.core?.pan(mx * amount, my * amount);
                    this.ui.renderer.render();
                }, { allowInTree: false });
            }
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
            this.setupFileDrops();
            this.setupToolbar();
        }

        onFinalize() {
            this.processPendingOperations();
            window.easytrace = this;

            const hash = window.location.hash.substring(1);
            const deepLinkModals = ['support', 'welcome', 'quickstart'];
            if (deepLinkModals.includes(hash)) {
                if (hash === 'support') this.modalManager.showModal('welcome');
                this.modalManager.showModal(hash);
                history.replaceState(null, null, window.location.pathname);
            } else {
                this.modalManager.showModal('welcome');
            }
        }

        // ════════════════════════════════════════════════════════════════
        // Toolbar
        // ════════════════════════════════════════════════════════════════

        setupToolbar() {
            this.setupToolbarDropdown('quick-actions-btn', 'quick-actions-menu');

            document.getElementById('toolbar-add-files')?.addEventListener('click', () => {
                this.modalManager.showModal('quickstart');
                this.closeDropdown();
            });

            document.getElementById('toolbar-manage-toolpaths')?.addEventListener('click', () => {
                const readyOps = this.core.operations.filter(op => this.core.isExportReady(op));
                if (readyOps.length === 0) {
                    this.ui.setStatus('No operations ready for export. Finish each operation through its Toolpaths stage first.', 'warning');
                    return;
                }
                this.modalManager.showModal('exportManager', { operations: readyOps });
                this.closeDropdown();
            });

            document.getElementById('toolbar-export-canvas')?.addEventListener('click', async () => {
                if (!this.ui.canvasExporter) {
                    this.ui.setStatus('Canvas exporter not available', 'error');
                    return;
                }
                try {
                    this.ui.canvasExporter.exportCanvasSVG();
                    this.ui.setStatus('Canvas exported successfully', 'success');
                } catch (error) {
                    console.error('Canvas export error:', error);
                    this.ui.setStatus('Canvas export failed: ' + error.message, 'error');
                }
                this.closeDropdown();
            });

            document.getElementById('btn-toggle-3d')?.addEventListener('click', () => this.toggle3DMode()); // REVIEW - Is this in the right place?
            this.setupSharedToolbarButtons();
        }

        // ════════════════════════════════════════════════════════════════
        // Setup Handlers
        // ════════════════════════════════════════════════════════════════

        setupFileDrops() {
            window.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this.modalManager?.activeModal) { e.dataTransfer.dropEffect = 'none'; }
            });

            window.addEventListener('drop', async (e) => {
                e.preventDefault();
                if (this.modalManager?.activeModal) return;
                if (!e.target.closest('.file-drop-zone') && !e.target.closest('#file-drop-zone')) {
                    await this.handleGlobalFileDrop(e.dataTransfer.files);
                }
            });
        }

        returnFocusToTree() {
            const selected = document.querySelector('.file-node-content.selected, .geometry-node-content.selected, .geometry-node.selected');
            if (selected) {
                const focusTarget = selected.classList.contains('selected') ? selected : selected.querySelector('.file-node-content, .geometry-node-content');
                if (focusTarget) { focusTarget.setAttribute('tabindex', '0'); focusTarget.focus(); }
            } else {
                document.querySelector('.category-header')?.focus();
            }
        }

        ensureCoordinateSystem() {
            if (this.core.scene && !this.core.scene.boardBounds) {
                this.core.scene.initializeEmptyBoardBounds();
            }
            this.ui.updateOriginDisplay?.();
        }

        // ════════════════════════════════════════════════════════════════
        // File Processing
        // ════════════════════════════════════════════════════════════════

        async loadExample(exampleId) {
            if (!exampleId) {
                const select = document.getElementById('pcb-example-select');
                exampleId = select ? select.value : 'exampleSMD1';
            }
            const examples = this.getExamples();
            const example = examples[exampleId];
            if (!example) { this.ui.setStatus(`Example not found: ${exampleId}`, 'error'); return; }
            this.ui.setStatus(`Loading example: ${example.name}...`, 'info');
            if (this.core) this.core.clearAll();
            this.ui.navTreePanel.refreshTree();
            for (const [type, filepath] of Object.entries(example.files)) {
                try {
                    const response = await fetch(filepath);
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    const content = await response.text();
                    const fileName = filepath.split('/').pop();
                    await this.processFile(new File([content], fileName, { type: 'text/plain' }), type);
                } catch (e) {
                    console.error(`Failed to load example file ${filepath}:`, e);
                    this.ui.setStatus(`Failed to load ${filepath.split('/').pop()}`, 'error');
                }
            }
            this.core.updateBoardBounds();
            this._hasFitted3DOnce = false;
            this.ui.setStatus(`Example '${example.name}' loaded successfully.`, 'success');
            await this.ui.updateRendererAsync();
            this.ui.zoomFit();
            this.ui.renderer.render();
        }

        async processFile(file, type) {
            if (!file || !type) { console.error('Invalid file or type provided'); return; }
            const validation = this.core.validateFileType(file.name, type);
            if (validation && !validation.valid) { this.ui.setStatus(validation.message, 'error'); return; }
            const operation = this.core.createOperation(type, file);
            if (!operation) { console.error('Failed to create operation'); return; }
            this.ui.navTreePanel.addFileNode(operation);
            this.ui.setStatus(`${this.appProfile.ui.text.statusLoading || 'Loading...'} ${file.name}...`, 'info', true);
            const reader = new FileReader();

            return new Promise((resolve) => {
                reader.onload = async (e) => {
                    operation.file.content = e.target.result;
                    const success = await this.core.parseOperation(operation);

                    if (success) {
                        const count = operation.primitives.length;
                        if (operation.geometricContext?.hasArcs && debugState.enabled) {
                            let arcCount = 0;
                            operation.primitives.forEach(p => { if (p.type === 'arc') arcCount++; if (p.contours) p.contours.forEach(c => { if (c.arcSegments) arcCount += c.arcSegments.length; }); });
                            console.log(`Preserved ${arcCount} arcs for potential reconstruction`);
                        }

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

                    if (this.ui.navTreePanel) {
                        const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                        if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
                    }

                    if (this.ui.updateRendererAsync) await this.ui.updateRendererAsync();
                    else if (this.ui.updateRenderer) await this.ui.updateRenderer();

                    if (this.core.operations.length <= 1) this.ui.zoomFit();
                    this.ui.updateStatistics();
                    resolve();
                };
                reader.onerror = () => { operation.error = 'Failed to read file'; this.ui.setStatus(`Failed to read ${file.name}`, 'error'); resolve(); };
                reader.readAsText(file);
            });
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
            let introHTML = `<p>The cutout geometry in <strong>${operation.file.name}</strong> contains disconnected segments.</p>`;
            if (extractedCount > 0) introHTML = `<p><strong>${extractedCount}</strong> closed loop(s) were extracted successfully, but <strong>${info.rawPrimitives.length}</strong> segment(s) remain disconnected.</p>`;

            const bodyHTML = `${introHTML}<div class="closure-gaps"><strong>Detected Gaps:</strong> ${gapTextList}</div><p>Set a tolerance large enough to bridge the maximum gap:</p><div class="closure-controls"><label for="closure-tolerance">Tolerance:</label><div class="input-unit"><input type="number" id="closure-tolerance" value="${suggestedTol}" min="0.001" max="5.0" step="0.001"><span class="unit">mm</span></div><button id="closure-test-btn" class="btn btn--secondary btn--compact">Test</button></div><div class="closure-results" id="closure-probe-results">${formatResult(lastProbeResult)}</div>`;

            this.modalManager.showWarning('Open Cutout Path Detected', null, {
                bodyHTML,
                confirmText: 'Close path',
                cancelText: 'Keep as-is',
                onConfirm: async () => {
                    const resolvedLoops = lastProbeResult?.loops;
                    if (resolvedLoops?.length > 0) {
                        const allLoops = operation.extractedLoops ? [...operation.extractedLoops, ...resolvedLoops] : resolvedLoops;
                        const topology = GeometryTopology.classifyCutoutTopology(allLoops);
                        const compounds = GeometryTopology.assembleCutoutCompounds(topology);
                        operation.primitives = compounds.length > 0 ? compounds : allLoops;
                        delete operation.extractedLoops;
                        operation.bounds = this.core.recalculateBounds(operation.primitives);
                        this.core.analyzeGeometricContext(operation, operation.primitives);
                        delete operation.needsClosurePrompt; delete operation.closureInfo;
                        if (operation.warnings) operation.warnings = operation.warnings.filter(w => !(typeof w === 'string' ? w : w.message).includes('do not form closed loops'));
                        if (this.ui.navTreePanel) { const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id); if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation); }
                        await this.ui.updateRendererAsync();
                        this.ui.setStatus('Cutout paths automatically closed.', 'success');
                    } else { this.ui.setStatus('Cannot close - test with a higher tolerance first.', 'error'); }
                },
                onCancel: () => {
                    delete operation.needsClosurePrompt; delete operation.closureInfo; delete operation.extractedLoops;
                    this.ui.setStatus(operation.primitives?.length > 0 ? 'Orphan segments discarded. Board outlines preserved.' : 'Cutout left as open path.', 'info');
                }
            });

            requestAnimationFrame(() => {
                const testBtn = document.getElementById('closure-test-btn');
                const tolInput = document.getElementById('closure-tolerance');
                const resultsDiv = document.getElementById('closure-probe-results');
                const confirmBtn = document.querySelector('#warning-modal .warning-confirm');
                if (testBtn && tolInput && resultsDiv) {
                    const doTest = () => {
                        const rawTol = parseFloat(tolInput.value);
                        if (!rawTol || rawTol <= 0) { resultsDiv.innerHTML = '<span style="color:var(--color-error);">Enter a positive tolerance value.</span>'; return; }
                        lastProbeResult = runProbe(Math.min(5.0, Math.max(0.001, rawTol)));
                        resultsDiv.innerHTML = formatResult(lastProbeResult);
                        if (confirmBtn) confirmBtn.disabled = !lastProbeResult?.success;
                    };
                    testBtn.addEventListener('click', doTest);
                    tolInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') doTest(); });
                    if (confirmBtn) confirmBtn.disabled = !lastProbeResult?.success;
                }
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

            const bodyHTML = `<p>The SVG file <strong>${operation.file.name}</strong> contains ${circleCount + obroundCount} compound path(s) that match known drill shapes.</p><div class="${gridClass}">${circleCount > 0 ? `<div class="drill-recovery-column"><h4>Circle Candidates (${circleCount})</h4><p>Compound paths that form complete circles.</p>${buildSizeList(rec.circles, 'circle')}</div>` : ''}${obroundCount > 0 ? `<div class="drill-recovery-column"><h4>Obround Candidates (${obroundCount})</h4><p>Compound paths that form stadium/capsule shapes.</p>${buildSizeList(rec.obrounds, 'obround')}</div>` : ''}</div><p class="drill-recovery-question">Convert these into valid hole and slot geometry for the drill operation?</p>`;

            this.modalManager.showWarning('Recoverable Drill Geometry', null, {
                bodyHTML,
                confirmText: 'Convert',
                cancelText: 'Skip',
                onConfirm: async () => {
                    this.core.getHandler('drill').promoteDrillRecoverable(operation, circleCount > 0, obroundCount > 0);
                    if (this.ui.navTreePanel) { const fn = this.ui.navTreePanel.getNodeByOperationId(operation.id); if (fn) this.ui.navTreePanel.updateFileGeometries(fn.id, operation); }
                    await this.ui.updateRendererAsync();
                    this.ui.setStatus(`Recovered ${circleCount + obroundCount} drill shape(s)`, 'success');
                },
                onCancel: () => { delete operation.drillRecoverable; this.ui.setStatus('Compound shapes skipped', 'info'); }
            });
        }

        async handleGlobalFileDrop(files) {
            if (!this.ui) return;
            let totalWarnings = 0, formatGuessed = false, fileCount = 0;
            for (let file of files) {
                const ext = file.name.toLowerCase().split('.').pop();
                const opType = this.getOperationTypeFromExtension(ext);
                if (opType) {
                    if (this.initState.fullyReady) {
                        await this.processFile(file, opType);
                        fileCount++;
                        const lastOp = this.core.operations[this.core.operations.length - 1];
                        if (lastOp?.warnings?.length > 0) {
                            totalWarnings += lastOp.warnings.length;
                            if (lastOp.warnings.some(w => (typeof w === 'string' ? w : w.message).includes('No explicit format found'))) formatGuessed = true;
                        }
                    } else {
                        this.pendingOperations.push({ file, opType });
                    }
                }
            }
            if (this.pendingOperations.length === 0 && this.initState.fullyReady) {
                this.core.updateBoardBounds();
                this._hasFitted3DOnce = false;
                await this.ui.updateRendererAsync();
                this.ui.zoomFit();
                this.ui.renderer.render();
                if (fileCount > 1) {
                    if (formatGuessed) this.ui.setStatus(`Loaded ${fileCount} files. Warning: Excellon format guessed! See log.`, 'warning');
                    else if (totalWarnings > 0) this.ui.setStatus(`Loaded ${fileCount} files with ${totalWarnings} warning(s). See log.`, 'warning');
                    else this.ui.setStatus(`Successfully loaded ${fileCount} files.`, 'success', true);
                }
            }
            if (this.pendingOperations.length > 0 && !this.initState.fullyReady) {
                this.ui.setStatus(this.appProfile.ui.text.statusLoading || 'Loading...');
            }
        }

        getOperationTypeFromExtension(ext) {
            return this.registry?.typeForExtension(ext) || null;
        }

        async processPendingOperations() {
            if (this.pendingOperations.length === 0) return;
            this.debug(`Processing ${this.pendingOperations.length} pending files...`);
            for (let op of this.pendingOperations) await this.processFile(op.file, op.opType);
            this.pendingOperations = [];
        }

        removeSelectedOperation() {
            const selectedNode = this.ui.navTreePanel.selectedNode;
            if (selectedNode?.type === 'file' && selectedNode.operation) {
                this.ui.removeOperation(selectedNode.operation.id);
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

        getStats() {
            return { ...super.getStats(), toolLibrary: this.toolLibrary?.getStats?.() || null };
        }
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

    // Debug utilities
    // REVIEW - Anywhere else this should be? Is it being used yet? This seems like it should be shared?
    window.showTraceStats = function() { if (ctrl) ctrl.logState(); };
    window.enableTraceDebug = function() { debugState.enabled = true; };
    window.disableTraceDebug = function() { debugState.enabled = false; };

    window.addFile = function(type) {
        if (!ctrl?.ui?.triggerFileInput) { console.error('Controller not initialized'); return; }
        ctrl.ui.triggerFileInput(type);
    };
})();