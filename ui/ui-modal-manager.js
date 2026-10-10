/*!
 * @file        ui/ui-modal-manager.js
 * @description Unified modal management
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/* TODO(modal-split) - ModalManager holds the modal lifecycle and, beside it,
 * what each modal shows and does. The lifecycle belongs here: showModal/
 * closeModal, the stack, hash routing, MODAL_POLICY, the focus trap, field
 * navigation and showWarning. The rest splits by concern, not into one file
 * per modal:
 * - Markup: a modal's static DOM (headers, buttons, notices, table heads and
 *   the column set per stage) belongs in index.html, as markup or a
 *   <template>; script fills rows and values only. Drill tooling builds all
 *   of it as strings today.
 * - Rules: the module that owns the data owns its rules. Drill tooling's row
 *   patching, input validation and presets belong to DrillHandler, beside
 *   buildDrillTable/updateDrillRow/applyDrillPreset. Export planning, the
 *   program cache and the tool-change decision already live on CamCore and
 *   PipelineContext.
 * - Orchestration: of the export run (readExportIntent..runToolpathOrchestration),
 *   only the DOM read and the progress display belong here.
 * - Onboarding (welcome, laserConfig, quickstart, support, help) is mostly
 *   markup plus file intake the controllers already own.
 * What stays per modal is thin view binding. New files only for a concern
 * above that has no home yet, never one per modal.
 */

(function() {
    'use strict';

    /**
     * Modal policy as data. A new app declares a table; it does not edit
     * the lifecycle methods.
     *   hashable  - pushes #name while open
     *   hashOpen  - safe to open directly from the URL (needs no app state)
     *   onEscape  - name of the modal to fall back to, or null to close
     *   onDismiss - click-outside behaviour; runs before the fallback
     *   opensOver - modal a deep link opens underneath this one
     */
    const MODAL_POLICY = {
        welcome: {hashable: false, hashOpen: true, onEscape: "quickstart", onDismiss: "quickstart"},
        quickstart: {hashable: true, hashOpen: true, onEscape: "welcome", onDismiss: null},
        laserConfig: {hashable: false, hashOpen: false, onEscape: null, onDismiss: "quickstart",
                    // Dismissing without choosing means the default UV pipeline.
                    commit: ctrl => ctrl.applyPipelineChoice("uv")},
        support: { hashable: true, hashOpen: true, onEscape: null, onDismiss: null, opensOver: 'welcome' },
        help: {hashable: false, hashOpen: true, onEscape: null, onDismiss: null},
        exportManager: {hashable: false, hashOpen: false, onEscape: null, onDismiss: null},
        drillTooling: {hashable: false, hashOpen: false, onEscape: null, onDismiss: null},
        warning: {hashable: false, hashOpen: false, onEscape: null, onDismiss: null, cancelOnDismiss: true}
    };

    class ModalManager {
        constructor(ctrl) {
            this.ctrl = ctrl;
            this.ui = ctrl.ui;
            this.lang = this.ui.lang;
            this.text = ctrl.appProfile.ui.text;
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
            // Click-outside handling with special cases
            Object.entries(this.modals).forEach(([name, modal]) => {
                if (modal) {
                    modal.addEventListener('click', (e) => {
                        if (e.target === modal) {
                            this.handleClickOutside(name);
                        }
                    });
                }
            });

            window.addEventListener('hashchange', () => this.checkHash());

            window.addEventListener('settingschange', () => {
                this.invalidateCalculated();
                // The post decides the G-code extension, the laser format the PNG/SVG split.
                if (this.getActiveModalName() === 'exportManager') this.refreshExportState();
            });
        }

        handleClickOutside(modalName) {
            const policy = MODAL_POLICY[modalName] || {};

            if (policy.cancelOnDismiss && this.activeWarningCallbacks?.onCancel) {
                this.activeWarningCallbacks.onCancel();
                this.activeWarningCallbacks = null;
            }
            // Dismissing without choosing still commits a pipeline.
            policy.commit?.(this.ctrl);

            if (!policy.onDismiss) { this.closeModal(); return; }

            // Clear the modal state
            this.activeModal?.classList.remove("active");
            this.activeModal = null;
            this.modalStack = [];
            if (!localStorage.getItem(this.ctrl.storageKeys.hideWelcome)) this.showModal(policy.onDismiss);
        }

        /**
         * Opens the modal the URL hash names, when its policy allows a deep
         * link. @returns {boolean} whether one opened
         */
        checkHash() {
            const hash = window.location.hash.substring(1);
            const policy = MODAL_POLICY[hash];
            if (!policy?.hashOpen) return false;
            if (policy.opensOver) this.showModal(policy.opensOver);
            this.showModal(hash);
            // Removes the #fragment from the URL bar without reloading
            history.replaceState(null, null, window.location.pathname);
            return true;
        }

        /**
         * First modal of a session: the URL's deep link if it has one, else
         * welcome - the landing modal, the only one no click, shortcut or link opens.
         */
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
            if (distance) distance.textContent = `${result.totalDistance.toFixed(1)}mm`;

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
                    line.textContent = `⚠ ${w}`;
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
            return operations.filter(op => op.type === 'drill'
                && core.machineClassOf(op) === 'router'
                && DrillHandler.splitDrillFiles(op).length > 1);
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
            const splitDrillOpIds = on('exporter-split-drills') && !singleFile
                ? this.splittableDrills(rows).map(op => op.id)
                : [];
            const nameInput = byId('exporter-filename');
            return {
                operations: rows,
                operationIds: rows.map((op) => op.id),
                singleFile,
                splitDrillOpIds,
                optimize: byId('exporter-optimize-paths')?.checked ?? true,
                includeComments: on('exporter-include-comments'),
                toolChanges: on('exporter-tool-changes'),
                groupByTool: on('exporter-group-by-tool'),
                zip: on('exporter-zip'),
                baseName: (nameInput?.value.trim() || nameInput?.placeholder || '').replace(/\.[^/.]+$/, ''),
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
            const caps = core.gcodeGenerator.getProcessorInfo(core.settings.gcode.postProcessor)?.capabilities || {};
            let intent = this.readExportIntent();
            gate('exporter-single-file', core.planExportFiles(intent).canCombine ? null : 'Nothing to combine');
            intent = this.readExportIntent();
            const drills = intent.operations.filter(op => op.type === 'drill' && core.machineClassOf(op) === 'router');
            gate('exporter-split-drills', intent.singleFile ? 'Single file is on'
                : drills.length === 0 ? 'No drill selected'
                : this.splittableDrills(drills).length > 0 ? null
                : 'One bit only');
            intent = this.readExportIntent();
            const plan = core.planExportFiles(intent);
            gate('exporter-zip', plan.files.length > 1 ? null : 'Only one file');
            // Every SVG carries the comment block; G-code only where the post
            // can hold comments.
            const commented =
                plan.files.length === 0 ||
                plan.files.some(
                    (file) => file.format === 'svg' || (file.format === 'gcode' && caps.supportsComments !== false),
                );
            gate('exporter-include-comments', commented ? null : 'Not on this post');
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
                !support.supported ? 'Not on this post' : tooling.hasMultiToolFile ? null : 'One tool per file',
            );
            gate(
                'exporter-group-by-tool',
                !intent.singleFile ? 'Single file only' : tooling.hasMultiToolFile ? null : 'One tool in file',
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
            const line = document.getElementById('exporter-summary');
            if (!line) return;
            const { files } = plan;
            line.title = files.map((file) => file.filename).join('\n');
            if (files.length < 2) {
                line.textContent = files[0]?.filename || 'No operations selected';
                return;
            }
            const counts = new Map();
            for (const file of files) {
                const ext = file.filename.split('.').pop().toUpperCase();
                counts.set(ext, (counts.get(ext) || 0) + 1);
            }
            const kinds = [...counts].map(([ext, n]) => `${n} ${ext}`).join(', ');
            line.textContent = intent.zip ? `${plan.baseName}.zip - ${kinds}` : `${files.length} files - ${kinds}`;
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
            if (hint) panel.appendChild(el('p', hint));
            if (shared.length === 0) return;
            const mm = (d) => `${d.toFixed(2)} mm`;
            const list = document.createElement('ul');
            for (const s of shared) {
                const sizes = s.entries.map((e) => `${mm(e.diameter)} (${e.label})`).join(' and ');
                list.appendChild(el('li', `T${s.number} is called once for ${sizes}`));
            }
            panel.append(
                el('strong', 'Some tool numbers are shared by different sizes'),
                list,
                el(
                    'p',
                    'Fine if that is one physical tool - EasyCAM compares sizes, not tool library names. ' +
                        'If they are different cutters, give each its own Tool Number in the Tool section ' +
                        'of the geometry stage.',
                ),
            );
        }      

        /**
         * Per-diameter drill tooling. operation.drillTable is the source of
         * truth - this renders it and writes back through DrillHandler so the
         * geometry/identity split (what stales the operation and what does not)
         * stays in one place.
         */
        showDrillToolingHandler(options = {}) {
            if (options.operationId) this.drillToolingOpId = options.operationId;
            this.drillToolingOnChange = options.onChange || this.drillToolingOnChange || null;
            // renderDrillToolingModal re-enters on every edit with no options,
            // so the stage has to be captured on open or the table rebuilds
            // itself into the wrong column set after the first change.
            this.drillToolingStage = options.stage || this.drillToolingStage || 'geometry';
            const done = document.getElementById("drill-tooling-done");
            done && (done.onclick = () => this.closeModal());
            const closeBtn = this.modals.drillTooling?.querySelector(".modal-close");
            closeBtn && (closeBtn.onclick = () => this.closeModal());
            this.renderDrillToolingModal();
        }

        renderDrillToolingModal() {
            const body = document.getElementById('drill-tooling-body');
            const subtitle = document.getElementById('drill-tooling-subtitle');
            if (!body) return;

            const operation = this.ctrl.core.store.getOperation(this.drillToolingOpId);
            const rows = operation?.drillTable?.rows;
            if (!operation || !rows || Object.keys(rows).length === 0) {
                body.innerHTML = `<p class="modal-notice">${this.lang?.get('drill.tooling.empty', 'No drill features detected. Load a drill file and generate the drill strategy first.') || ''}</p>`;
                subtitle && (subtitle.textContent = '');
                return;
            }

            const entries = Object.values(rows).sort((a, b) => a.diameter - b.diameter);

            subtitle && (subtitle.textContent = `${operation.file?.name || operation.id} - ${entries.length} diameter${entries.length > 1 ? 's' : ''}`);

            const features = row => [
                row.holes ? `${row.holes} hole${row.holes > 1 ? 's' : ''}` : null,
                row.slots ? `${row.slots} slot${row.slots > 1 ? 's' : ''}` : null
            ].filter(Boolean).join(', ');

            // Columns follow the profile's own stage for the equivalent
            // sidebar parameter: tool, toolNumber and toolDiameter are
            // geometry-stage, feeds and peck depth are strategy-stage.
            // toolNumber is identity, not geometry - it is declared
            // invalidates:false and GEOMETRY_FIELDS excludes it, so editing it
            // here does not discard paths.
            const geo = this.drillToolingStage !== 'strategy';
            const ro = geo ? '' : ' disabled';

            const head = geo
                ? '<th scope="col">Size</th><th scope="col">Features</th><th scope="col">Strategy</th><th scope="col">Tool &#8960; (mm)</th><th scope="col">T#</th>'
                : '<th scope="col">Size</th><th scope="col">Strategy</th><th scope="col">Tool &#8960; (mm)</th><th scope="col">T#</th><th scope="col">Feed</th><th scope="col">Plunge</th><th scope="col">RPM</th><th scope="col">Peck</th>';

            const sizeCell = row => `<td class="drill-tooling-size" title="${row.nativeTools?.length ? `Excellon code: ${row.nativeTools.join(', ')}` : ''}">&#8960;${row.diameter.toFixed(3)}<span>mm</span></td>`;

            // A column header names a CELL, never a control inside it, so every
            // input needs the hole size spelled into its own name.
            const named = row => `${row.diameter.toFixed(3)} mm holes`;

            const strategyCell = row => `<td><select data-field="strategy" aria-label="Strategy for ${named(row)}"${ro}>
                                <option value="peck"${'peck' === row.strategy ? ' selected' : ''}>Peck</option>
                                <option value="mill"${'mill' === row.strategy ? ' selected' : ''}>Mill</option>
                                <option value="skip"${'skip' === row.strategy ? ' selected' : ''}>Skip</option>
                            </select></td>`;

            const diameterCell = row => `<td><input type="number" min="0.01" step="0.001" data-field="toolDiameter" aria-label="Tool diameter in mm for ${named(row)}" value="${+(row.toolDiameter ?? row.diameter).toFixed(3)}" placeholder="${+row.diameter.toFixed(3)}"${row.strategy !== 'skip' && geo ? '' : ' disabled'}></td>`;

            const numberCell = row => `<td><input type="number" min="1" step="1" data-field="toolNumber" aria-label="Tool number for ${named(row)}" value="${row.toolNumber ?? ''}" placeholder="T#" required${ro}></td>`;

            const cells = row => geo
                ? sizeCell(row) + `<td>${features(row)}</td>` + strategyCell(row) + diameterCell(row) + numberCell(row)
                : sizeCell(row) + strategyCell(row) + diameterCell(row) + numberCell(row)
                    + `<td><input type="number" min="1" step="1" data-field="feedRate" aria-label="Feed rate for ${named(row)}" value="${row.cutting?.feedRate ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="1" step="1" data-field="plungeRate" aria-label="Plunge rate for ${named(row)}" value="${row.cutting?.plungeRate ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="100" step="100" data-field="spindleSpeed" aria-label="Spindle RPM for ${named(row)}" value="${row.cutting?.spindleSpeed ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="0" step="0.05" data-field="peckDepth" aria-label="Peck depth for ${named(row)}" value="${row.peck?.peckDepth ?? ''}" placeholder="op"${'peck' === row.strategy ? '' : ' disabled'}></td>`;

            body.innerHTML = `
                <div class="drill-tooling-presets"${geo ? '' : ' hidden'}>
                    <button class="btn btn--secondary btn--compact" data-preset="flatten">Reset to Defaults</button>
                    <button class="btn btn--secondary btn--compact" data-preset="match">Auto-match Tool Library</button>
                </div>
                <table class="drill-tooling-table">
                    <thead><tr>${head}</tr></thead>
                    <tbody>${entries.map(row => `<tr data-key="${row.key}">${cells(row)}</tr>`).join('')}</tbody>
                </table>
                <p class="modal-notice">${geo ? 'Pick a cutter and enter a tool number (T#) for every hole size. The T number cannot be zero or empty. Changing a cutter discards generated paths; a T number does not.' : 'Feeds and peck depth only. Leave a field empty to inherit the operation\'s value. Cutter and T number are set at the geometry stage.'}</p>
            `;
            this.setupDrillToolingHandlers(operation);
        }

        setupDrillToolingHandlers(operation) {
            const body = document.getElementById('drill-tooling-body');
            if (!body) return;
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
                const tr = input.closest('tr');
                const key = tr?.dataset.key;
                const row = operation.drillTable?.rows?.[key];
                if (!row) return;
                input.onchange = () => {
                    const field = input.dataset.field;
                    const raw = String(input.value).trim();
                    const value = raw === '' ? null : field === 'toolNumber' ? parseInt(raw, 10) : parseFloat(raw);
                    let patch;
                    if (field === 'strategy') {
                        patch = { strategy: input.value };
                        if (input.value === 'peck' && (!row.toolDiameter || row.toolDiameter <= 0)) {
                            patch.toolDiameter = row.diameter;
                        }
                    } else if (field === 'toolDiameter') {
                        // Empty or <= 0 falls back to the hole size the placeholder
                        // shows; every value snaps to the 0.001 mm coordinate grid.
                        const validDiam = +(value !== null && value > 0 ? value : row.diameter).toFixed(3);
                        if (validDiam !== value) input.value = validDiam;
                        patch = { toolDiameter: validDiam };
                    } else if (field === 'toolNumber') {
                        const validNum = Number.isInteger(value) && value > 0 ? value : null;
                        input.value = validNum !== null ? validNum : '';
                        patch = { toolNumber: validNum };
                    } else if (field === 'peckDepth') {
                        patch = { peck: { ...(row.peck || {}), peckDepth: value } };
                    } else {
                        patch = { cutting: { ...(row.cutting || {}), [field]: value } };
                    }
                    const stales = handler.updateDrillRow(operation, key, patch);
                    this.afterDrillToolingEdit(operation, stales);
                    if (field === 'strategy') this.renderDrillToolingModal();
                };
            });
        }

        /**
         * Geometry-affecting edits stale the operation; identity and cutting
         * edits do not - the toolpath pass reads those from the table at export,
         * so discarding generated paths for a T number would be gratuitous.
         */
        afterDrillToolingEdit(operation, stales) {
            this.drillToolingOnChange?.();
            const reason = 'Drill tooling changed after generation - regenerate before exporting.';
            if (stales && this.ctrl.core.store.invalidateOperationState(operation.id, reason)) {
                this.ui.setStatus(reason, 'warning');
            }
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
                if (this.text.gcodePlaceholder) previewText.placeholder = this.text.gcodePlaceholder;
            }
            setText('exporter-line-count', '0');
            setText('exporter-op-count', '0');
            setText('exporter-est-time', '--:--');
            setText('exporter-distance', '0mm');
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

        /**
         * Calculated G-code is only reusable while nothing that shapes it has
         * moved.
         */
        invalidateCalculated() {
            this.ctrl.core.exportPrograms = { key: null, results: null };
            this.resetExportPreview();
        }

        // Generic modal methods
        showModal(modalName, options = {}) {
            const modal = this.modals[modalName];
            if (!modal) {
                console.error(`[UI-ModalManager] Modal - '${modalName}' - not found`);
                return;
            }

            // Only update hash for content modals, except welcome
            if (MODAL_POLICY[modalName]?.hashable) history.pushState(null, '', `#${modalName}`);

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

            // Set ARIA attributes
            const content = modal.querySelector('.modal-content');
            if (content) {
                // The wrapper already carries role="dialog" from the markup.
                // Setting it here too produced two nested dialogs, and rewriting
                // the heading id orphaned the wrapper's aria-labelledby.
                modal.setAttribute('aria-modal', 'true');

                const heading = content.querySelector('.modal-header h2');
                if (heading && !modal.getAttribute('aria-labelledby')) {
                    if (!heading.id) heading.id = `modal-heading-${modalName}`;
                    modal.setAttribute('aria-labelledby', heading.id);
                }
            }

            // Call specific show handler
            const handler = `show${modalName.charAt(0).toUpperCase() + modalName.slice(1)}Handler`;
            if (this[handler]) {
                this[handler](options);
            }

            // Setup focus trap
            this.setupFocusTrap(modal);
            this.setupModalFieldNavigation(modal);

            // Move focus to the modal, preferring the scroll container
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

                (scrolls ? body : content).focus();
            });
        }

        closeModal() {
            if (!this.activeModal) return;
            const closing = this.getActiveModalName();
            this.removeFocusTrap();
            this.activeModal.classList.remove('active');
            if (this.modalStack.length > 0) {
                // Returning to previous modal
                this.activeModal = this.modalStack.pop();
                this.activeModal.classList.add('active');
                this.setupFocusTrap(this.activeModal);
                // Update hash to reflect the modal being returning to
                const returnModalName = this.getActiveModalName();
                if (returnModalName && MODAL_POLICY[returnModalName]?.hashable) {
                    history.replaceState(null, null, `#${returnModalName}`);
                } else {
                    // Nothing hashable underneath - clean the URL to root
                    history.replaceState(null, null, window.location.pathname);
                }
            } else {
                // Fully closing removes hash
                this.activeModal = null;
                if (window.location.hash) {
                    history.replaceState(null, null, window.location.pathname);
                }
                // Restore focus - but never to canvas
                if (
                    this.previousActiveElement &&
                    document.body.contains(this.previousActiveElement) &&
                    this.previousActiveElement.id !== 'preview-canvas'
                ) {
                    this.previousActiveElement.focus();
                } else {
                    // Jump back to the app's tree or else focus lands on <body> and
                    // keyboard navigation restarts from the top.
                    const sel = this.ctrl.getTreeFocusSelector() || '#operations-tree [tabindex="0"]';
                    document.querySelector(sel)?.focus();
                }
                this.previousActiveElement = null;
            }
            if ('warning' === closing && this.warningQueue.length > 0) this.showWarning(...this.warningQueue.shift());
        }

        handleEscapeKey() {
            if (!this.activeModal) return;
            const modalName = this.getActiveModalName();
            const policy = MODAL_POLICY[modalName] || {};

            if (policy.cancelOnDismiss && this.activeWarningCallbacks?.onCancel) {
                this.activeWarningCallbacks.onCancel();
                this.activeWarningCallbacks = null;
            }
            if (policy.onEscape) {
                this.handleClickOutside(modalName);
                return;
            }
            this.closeModal();
            // Standalone support (no modal underneath) returns to welcome.
            if (modalName === "support" && this.modalStack.length === 0) this.showModal("welcome");
        }

        getActiveModalName() {
            if (!this.activeModal) return null;

            for (const [name, modal] of Object.entries(this.modals)) {
                if (modal === this.activeModal) {
                    return name;
                }
            }
            return null;
        }

        showLaserConfigHandler() {
            const modal = this.modals.laserConfig;
            if (!modal) return;

            const uvCard = document.getElementById("laser-select-uv");
            uvCard && (uvCard.onclick = e => {
                e.preventDefault();
                this.ctrl.applyPipelineChoice("uv");
                this.closeModal();
                this.showModal("quickstart");
            });

            const fiberCard = document.getElementById("laser-select-fiber");
            fiberCard && (fiberCard.onclick = e => {
                e.preventDefault();
                this.ctrl.applyPipelineChoice("fiber");
                this.closeModal();
                this.showModal("quickstart");
            });

            // Back button
            const backBtn = document.getElementById('laser-config-back-btn');
            if (backBtn) {
                backBtn.onclick = () => {
                    if (this.modalStack.length > 0) {
                        this.closeModal();
                    } else {
                        this.closeModal();
                        this.showModal('welcome');
                    }
                };
            }

            // Close button
            const closeBtn = document.getElementById('laser-config-close');
            if (closeBtn) {
                closeBtn.onclick = () => this.closeModal();
            }
        }

        showSupportHandler() {
            const modal = this.modals.support;

            // Define the email parts to confuse basic scrapers
            const user = 'sponsor';
            const domain = 'eltryus';
            const tld = 'design';

            // Reassemble
            const email = `${user}@${domain}.${tld}`;

            // Get elements
            const oldBtn = document.getElementById('support-email-copy');
            const closeBtn = modal.querySelector('.modal-close');

            if (oldBtn) {
                // Clone the button to remove old listeners (critical for SPAs)
                const newBtn = oldBtn.cloneNode(true);
                oldBtn.parentNode.replaceChild(newBtn, oldBtn);

                // Get the text span inside the new button
                const textSpan = newBtn.querySelector('#support-email-text');

                // Reset state (in case it was stuck on "Copied!")
                if (textSpan) textSpan.textContent = email;
                newBtn.classList.remove('copied');

                // Attach Click Listener
                newBtn.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(email);

                        // Feedback: Change text inside button, leave external hint alone
                        if (textSpan) textSpan.textContent = 'Copied to clipboard!';
                        newBtn.classList.add('copied');

                        // Revert after 2 seconds
                        setTimeout(() => {
                            if (textSpan) textSpan.textContent = email;
                            newBtn.classList.remove('copied');
                        }, 2000);

                    } catch (err) {
                        console.error('Copy failed:', err);
                        // Fallback: Select text
                        if (textSpan) {
                            const range = document.createRange();
                            range.selectNode(textSpan);
                            window.getSelection().removeAllRanges();
                            window.getSelection().addRange(range);
                        }
                    }
                };
            }

            // Back button
            const backBtn = document.getElementById('support-back-btn');
            if (backBtn) {
                backBtn.onclick = () => {
                    if (this.modalStack.length > 0) {
                        this.closeModal();
                    } else {
                        this.closeModal();
                        this.showModal('welcome');
                    }
                };
            }

            // Close Button Handler
            if (closeBtn) {
                closeBtn.onclick = () => {
                    this.closeModal();
                    // Clean hash if closing the support modal
                    if (window.location.hash === '#support') {
                        history.pushState("", document.title, window.location.pathname + window.location.search);
                    }
                };
            }
        }

        showHelpHandler() {
            const modal = this.modals.help;

            // Close button
            const closeBtn = modal?.querySelector('.modal-close');
            if (closeBtn) {
                closeBtn.onclick = () => this.closeModal();
            }

            // "Got it" button
            const gotItBtn = document.getElementById('help-close-btn');
            if (gotItBtn) {
                gotItBtn.onclick = () => this.closeModal();
            }
        }

        showWelcomeHandler() {
            const modal = this.modals.welcome;
            modal?.querySelectorAll(".pipeline-card[data-pipeline]").forEach(card => {
                // The controller performs the app-specific side effect and returns
                // the modal to advance to, or null to land straight in the workspace.
                card.onclick = e => {
                    e.preventDefault();
                    this.selectedPipeline = card.dataset.pipeline;
                    const next = this.ctrl.onPipelineSelected(card.dataset.pipeline) ?? 'quickstart';
                    this.closeModal();
                    if (next && !localStorage.getItem(this.ctrl.storageKeys.hideWelcome)) this.showModal(next);
                };
            });

            // Sponsor slots and CTA (only open support modal on empty placeholder slots)
            ['sponsor-slot-1', 'sponsor-slot-2', 'sponsor-slot-3', 'sponsor-contact-cta'].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.classList.contains('sponsor-slot--filled')) {
                    el.onclick=e=>{e.preventDefault();
                        this.showModal('support');
                    };
                }
            });

            // Help link in footer
            const helpLink = document.getElementById('welcome-help-link');
            if (helpLink) {
                helpLink.onclick = (e) => {
                    e.preventDefault();
                    this.showModal('help');
                };
            }

            // Close button - same behavior as click-outside
            const closeBtn = modal?.querySelector('.modal-close');
            if (closeBtn) {
                closeBtn.onclick = () => this.handleClickOutside('welcome');
            }
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

            // Initialize "don't show again" checkbox from stored preference
            const dontShowCheckbox = document.getElementById('dont-show-quickstart');
            if (dontShowCheckbox) {
                const hideWelcome = localStorage.getItem(this.ctrl.storageKeys.hideWelcome);
                dontShowCheckbox.checked = !!hideWelcome;

                dontShowCheckbox.onchange = (e) => {
                    if (!e.target.checked) {
                        localStorage.removeItem(this.ctrl.storageKeys.hideWelcome);
                        this.ui.setStatus('Quickstart will show on next visit', 'info');
                    }
                };
            }

            // Setup example dropdown directly from controller profile data
            const select = document.getElementById("pcb-example-select");
            const examples = this.ctrl.getExamples();
            const exampleRow = select?.closest(".quickstart-example-row");

            if (select && examples && Object.keys(examples).length > 0) {
                select.innerHTML = "";
                for (const [key, example] of Object.entries(examples)) {
                    const option = document.createElement("option");
                    option.value = key;
                    option.textContent = example.name;
                    select.appendChild(option);
                }
                if (exampleRow) exampleRow.style.display = "";
            } else if (exampleRow) {
                exampleRow.style.display = "none";
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
                loadExampleBtn.textContent = 'Loading...';
                if (select) select.disabled = true;
                const processBtn = document.getElementById('process-quickstart-files-btn');
                if (processBtn) processBtn.disabled = true;
                try {
                    await this.ctrl.loadExample(selectedExample);
                    this.ui.renderer.zoomFit(true);
                    this.handleQuickstartClose();
                } catch (e) {
                    console.error('[ModalManager] Example load failed:', e);
                    this.ui.setStatus(`Could not load that example: ${e.message}`, 'error');
                } finally {
                    this._loadingExample = false;
                    loadExampleBtn.disabled = false;
                    loadExampleBtn.textContent = label;
                    if (select) select.disabled = false;
                    this.updateQuickstartProcessButton();
                }
            };

            // Process files button
            const processBtn = document.getElementById('process-quickstart-files-btn');
            if (processBtn) {
                processBtn.disabled = true;
                processBtn.onclick = async () => {
                    const files = { ...this.quickstartFiles };
                    this.quickstartFiles = {};
                    await this.ctrl.processFiles(files);
                    this.handleQuickstartClose();
                };
            }

            // Start empty button
            const startEmptyBtn = document.getElementById('start-empty-btn');
            if (startEmptyBtn) {
                startEmptyBtn.onclick = () => this.handleQuickstartClose();
            }

            // Back button - pipeline-aware
            const backBtn = document.getElementById('quickstart-back-btn');
            if (backBtn) {
                backBtn.onclick = () => {
                    if (this.modalStack.length > 0) {
                        this.closeModal();
                    } else {
                        this.closeModal();
                        if (this.selectedPipeline === 'laser') {
                            this.showModal('laserConfig');
                        } else {
                            this.showModal('welcome');
                        }
                    }
                };
            }

            // Close button
            const closeBtn = modal?.querySelector('.modal-close');
            if (closeBtn) {
                closeBtn.onclick = () => this.handleQuickstartClose();
            }
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

                // Make keyboard accessible
                zone.setAttribute('tabindex', '0');
                zone.setAttribute('role', 'button');
                zone.setAttribute('aria-label', `Upload ${opType} file. Click or press Enter to browse.`);

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

        handleQuickstartClose() {
            // Check the "Don't show again" checkbox
            const dontShowCheckbox = document.getElementById('dont-show-quickstart');
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                // Save preference to localStorage
                localStorage.setItem(this.ctrl.storageKeys.hideWelcome, 'true');
            }

            // Actually close the modal
            this.closeModal();
        }

        // Toolpath modal handler
        showExportManagerHandler(options = {}) {
            const operations = options.operations || [];
            this.debug(`Opening Export Manager with ${operations.length} operation(s)`);
            const core = this.ctrl.core;
            const sortOrder = { isolation: 1, clearing: 2, drill: 3, cutout: 4, stencil: 99 };
            this.selectedOperations = [...operations].sort((a, b) => (sortOrder[a.type] ?? 5) - (sortOrder[b.type] ?? 5));
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
            // Laser and vector work only exist in apps that keep the laser settings.
            if (hasLaser) {
                const paddingInput = byId('laser-exporter-padding');
                if (paddingInput) paddingInput.value = core.settings.laser.exportPadding;
                const activeProfile = core.graphicsExporter.getProfileInfo(core.settings.laser.activeProfile);
                const summaryLabel = byId('laser-profile-summary-label');
                if (summaryLabel && activeProfile) summaryLabel.textContent = activeProfile.label;
            }
            if (hasVector) {
                const stencilPaddingInput = byId('stencil-exporter-padding');
                if (stencilPaddingInput) stencilPaddingInput.value = core.settings.laser.exportPadding;
            }
            // The field holds the base name only; the summary line shows the final names.
            const filenameInput = byId('exporter-filename');
            if (filenameInput) {
                filenameInput.value = filenameInput.value.trim().replace(/\.[^/.]+$/, '') || filenameInput.placeholder;
            }
            this.populateExportOperationsList();
            this.setupExportHandlers();
            this.resetExportPreview();
            this.refreshExportState();
            this.attachExporterModalTooltips();
        }

        populateExportOperationsList() {
            const list = document.getElementById('exporter-operation-order');
            if (!list) return;
            list.innerHTML = '';
            const core = this.ctrl.core;
            const postInfo = core.gcodeGenerator.getProcessorInfo(core.settings.gcode.postProcessor);
            const cncExt = (postInfo?.fileExtension || '.nc').replace('.', '').toUpperCase();
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
                item.querySelector('.exporter-op-name').textContent = `${op.type}: ${op.file.name}`;
                item.querySelector('input').addEventListener('change', () => {
                    this.refreshExportState();
                    this.invalidateCalculated();
                });
                // A stencil is its own job on its own material, so it is never part
                // of the board's processing order.
                if (op.type === 'stencil') {
                    item.dataset.locked = 'true';
                    item.title = 'Exported as a separate file - stencil stock is a different setup.';
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
            const closeBtn = this.modals.exportManager?.querySelector('.modal-close');
            if (closeBtn) closeBtn.onclick = () => this.closeModal();
            const cancelBtn = byId('exporter-cancel-btn');
            if (cancelBtn) cancelBtn.onclick = () => this.closeModal();
            const calcBtn = byId('exporter-calculate-btn');
            if (calcBtn) calcBtn.onclick = () => this.runToolpathOrchestration(calcBtn);
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
            for (const id of ['exporter-group-by-tool', 'exporter-include-comments', 'exporter-optimize-paths']) {
                wire(id, () => this.invalidateCalculated());
            }
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
                        this.ui.setStatus('No generated G-code to copy.', 'warning');
                        return;
                    }
                    try {
                        await navigator.clipboard.writeText(previewText.value);
                        this.ui.setStatus('G-code copied to clipboard!', 'success');
                        // Visual feedback via class toggle
                        copyBtn.classList.add('copy-success');
                        setTimeout(() => copyBtn.classList.remove('copy-success'), 2000);
                    } catch (err) {
                        console.error('[UI-ModalManager] Failed to copy text:', err);
                        this.ui.setStatus('Clipboard copy failed. Check browser permissions.', 'error');
                    }
                };
            }
            const executeBtn = byId('exporter-execute-btn');
            if (executeBtn) executeBtn.onclick = () => this.executeUnifiedExport();
        }

        async executeUnifiedExport() {
            const intent = this.readExportIntent();
            if (intent.operationIds.length === 0) {
                this.ui.setStatus('No operations selected for export.', 'warning');
                return;
            }
            const executeBtn = document.getElementById('exporter-execute-btn');
            const loadingOverlay = document.getElementById('loading-overlay');
            const loadingText = document.getElementById('loading-text');
            // Loose files are paced one by one in WebKit; an archive is one download.
            const looseFiles = intent.zip ? 0 : this.ctrl.core.planExportFiles(intent).files.length;
            const paced = looseFiles > 1 && this.ctrl.pacesDownloads;
            if (executeBtn) executeBtn.disabled = true;
            if (loadingOverlay && loadingText) {
                loadingText.textContent = paced ? 'Exporting Files - Pacing downloads in webkit...' : 'Exporting Files...';
                loadingOverlay.classList.remove('is-hidden');
                loadingOverlay.focus();
            }
            try {
                const result = await this.ctrl.executeExports(intent);
                if (result.success) {
                    this.ui.setStatus(result.message, result.failures.length > 0 ? 'warning' : 'success');
                    this.closeModal();
                } else {
                    this.ui.setStatus(result.message || 'Export produced no output.', 'warning');
                }
            } catch (error) {
                console.error('[UI-ModalManager] Export failed:', error);
                this.ui.setStatus('Export failed: ' + error.message, 'error');
            } finally {
                if (executeBtn) executeBtn.disabled = false;
                // Hide the global wait spinner gracefully
                if (loadingOverlay) loadingOverlay.classList.add('is-hidden');
            }
        }

        /**
         * The (?) help on every export option, from ui.modals.exporter.*: what
         * the option does and when it applies. Why it is off right now is the
         * row's own note. Once per element - the modal reopens, its markup
         * stays.
         */
        attachExporterModalTooltips() {
            if (!this.lang || !window.TooltipManager) return;
            const processed = this.exporterModalTooltipsProcessed;
            const attachTo = (inputId, key) => {
                const label = document.getElementById(inputId)?.closest('.property-field')?.querySelector('label');
                if (!label || processed.has(label)) return;
                processed.add(label);
                const { label: title, help } = this.lang.entry(key);
                if (!help) return;
                window.TooltipManager.attachWithIcon(
                    label,
                    { title: title || label.querySelector('span')?.textContent || label.textContent, text: help },
                    { showOnFocus: true },
                );
            };
            const hoverHelp = (el, key, fallbackTitle) => {
                if (!el || processed.has(el)) return;
                processed.add(el);
                const { label, help } = this.lang.entry(key);
                if (help) window.TooltipManager.attach(el, { title: label || fallbackTitle, text: help }, { immediate: true });
            };
            const ui = (name) => `ui.modals.exporter.${name}`;
            attachTo('exporter-filename', ui('filename'));
            attachTo('exporter-single-file', ui('singleFile'));
            attachTo('exporter-split-drills', ui('splitDrills'));
            attachTo('exporter-zip', ui('zip'));
            attachTo('exporter-include-comments', ui('includeComments'));
            attachTo('exporter-tool-changes', ui('toolChanges'));
            attachTo('exporter-group-by-tool', ui('groupByTool'));
            attachTo('exporter-optimize-paths', ui('optimize'));
            attachTo('laser-exporter-padding', 'params.laserExportPadding');
            attachTo('stencil-exporter-padding', 'params.stencilExportPadding');
            hoverHelp(document.getElementById('exporter-order-help'), ui('order'), 'Processing Order');
            hoverHelp(document.getElementById('exporter-calculate-btn'), ui('calculate'), 'Calculate Toolpaths');
        }

        /**
         * Calculate button. Reads intent from the DOM, hands the job to the core,
         * renders what comes back. Which operations run, whether they are ready
         * and how they group into programs are CamCore's decisions - the only
         * thing that belongs here is the panel.
         */
        async runToolpathOrchestration(btn) {
            const originalText = btn.textContent;
            btn.textContent = 'Calculating...';
            btn.disabled = true;
            try {
                const job = await this.ctrl.core.computeExportPrograms(this.readExportIntent(), this.ctrl.parameterStore);
                this.resetExportPreview();
                if (!job.ok) {
                    if (job.reason === 'not-ready') {
                        this.ui.setStatus(
                            `Not ready: ${job.notReady.map((o) => o.file.name).join(', ')}. Finish each operation's stages first.`,
                            'warning',
                        );
                    } else {
                        this.ui.setStatus('No CNC operations selected for calculation', 'info');
                    }
                    return;
                }
                const produced = job.files.filter((file) => job.results[file.key]);
                if (produced.length === 0) {
                    this.ui.setStatus('Calculation returned no G-code', 'warning');
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
                this.ui.setStatus(`Failed: ${error.message}`, 'error');
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }

        setupFocusTrap(modal) {
            const focusableSelector = 
                'button:not([disabled]), [href]:not([disabled]), input:not([disabled]), ' +
                'select:not([disabled]), textarea:not([disabled]), ' +
                '[tabindex]:not([tabindex="-1"])';

            // Store for trap logic
            this.currentModalFocusables = () => {
                return Array.from(modal.querySelectorAll(focusableSelector));
            };

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
            const { onConfirm, onCancel, onShow, confirmText = 'OK', cancelText = 'Cancel', bodyHTML = null } = options;
            // Track active callbacks at the class level for keyboard/backdrop dismissal
            this.activeWarningCallbacks = { onConfirm, onCancel };
            // Set content
            modal.querySelector('.warning-title').textContent = title;
            const bodyContainer = modal.querySelector('.warning-body');
            if (bodyHTML) {
                bodyContainer.innerHTML = bodyHTML;
            } else {
                bodyContainer.innerHTML = '';
                const p = document.createElement('p');
                p.className = 'warning-message';
                p.textContent = message;
                bodyContainer.appendChild(p);
            }
            // Setup buttons
            const confirmBtn = modal.querySelector('.warning-confirm');
            confirmBtn.textContent = confirmText;
            confirmBtn.disabled = false;
            confirmBtn.onclick = () => {
                if (this.activeWarningCallbacks?.onConfirm) this.activeWarningCallbacks.onConfirm();
                this.activeWarningCallbacks = null;
                this.closeModal();
            };
            const cancelBtn = modal.querySelector('.warning-cancel');
            if (onCancel) {
                cancelBtn.style.display = '';
                cancelBtn.textContent = cancelText;
                cancelBtn.onclick = () => {
                    if (this.activeWarningCallbacks?.onCancel) this.activeWarningCallbacks.onCancel();
                    this.activeWarningCallbacks = null;
                    this.closeModal();
                };
            } else {
                cancelBtn.style.display = 'none';
            }
            const closeBtn = modal.querySelector('.modal-close');
            if (closeBtn) {
                closeBtn.onclick = () => {
                    if (this.activeWarningCallbacks?.onCancel) this.activeWarningCallbacks.onCancel();
                    this.activeWarningCallbacks = null;
                    this.closeModal();
                };
            }
            this.showModal('warning');
            onShow?.(modal);
        }

        debug(message, data = null) {
            if (this.ui.debug) {
                this.ui.debug(`[UI-ModalManager] ${message}`, data);
            }
        }
    }

    window.ModalManager = ModalManager;
})();