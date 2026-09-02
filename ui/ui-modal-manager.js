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
/* TODO(modal-scope) - ModalManager should own presentation and lifecycle:
   showModal/closeModal, the stack, hash routing, the focus trap, field
   navigation, sortable lists and showWarning. Four clusters here are
   orchestration with a home elsewhere. Two are ready to move:
     - routeOf / exportHasMultiToolFile / updateToolChangeVisibility /
       renderToolNotice  -> PipelineContext, next to checkToolAssignment,
       which already answers the same question for the same modal.
     - selectPipeline / quickstart drop zones / handleQuickstartFile /
       processQuickstartFiles -> CamController.onPipelineSelected and
       processFile already exist and are what the modal should call.
   Two are BLOCKED and must not move first:
     - runToolpathOrchestration / executeUnifiedExport / showGcodeForOperation
       wait on cam-core's TODO(pipeline-entry): they are a third name for the
       two artifacts it names, and moving them before that decision lands
       moves them twice.
     - the drill-table cluster waits on the stage column sets settling.
   Splitting the modals themselves is NOT the goal and would not help. */

(function() {
    'use strict';

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const storageKeys = C.storageKeys;

    class ModalManager {
        constructor(ctrl) {
            this.ctrl = ctrl;
            this.ui = ctrl.ui;
            this.lang = this.ui.lang;
            this.text = ctrl.appProfile.ui.text;
            this.activeModal = null;
            this.modalStack = [];

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
            // REVIEW - Double check consistency, both apps have drop zones, initialization should be consistent now and for future apps.
            this.quickstartOpTypes = ctrl.getQuickstartOpTypes?.() || [];
            this.quickstartFiles = {};

            // Focus management for accessibility
            this.previousActiveElement = null;
            this.focusTrapListener = null;

            // Toolpath-specific state
            this.selectedOperations = [];
            this.highlightedOpId = null;
            this.gcodeResults = new Map();

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
        }

        handleClickOutside(modalName) {
            if (modalName === 'welcome' || modalName === 'laserConfig') {
                // If users click outside the laser config, assume default UV laser settings
                if (modalName === 'laserConfig') {
                    const laserConfig = {
                        laserType: 'uv',
                        outputFormat: D.laser.exportFormat,
                        layerColors: { ...(D.laser.layerColors) }
                    };
                    this.ctrl.setMachineClass('laser', { laser: laserConfig });

                    if (this.ui.machineSettings) {
                        this.ui.machineSettings.updatePipelineFieldVisibility();
                    }
                }

                // Clear the modal state
                this.activeModal?.classList.remove('active');
                this.activeModal = null;
                this.modalStack = [];

                // Move forward to quickstart if not disabled
                const hideWelcome = localStorage.getItem(storageKeys.hideWelcome);
                if (!hideWelcome) {
                    this.showModal('quickstart');
                }
            } else {
                if (modalName === 'warning' && this.activeWarningCallbacks?.onCancel) {
                    this.activeWarningCallbacks.onCancel();
                    this.activeWarningCallbacks = null;
                }
                this.closeModal();
            }
        }

        checkHash() {
            // Remove the '#' character
            const hash = window.location.hash.substring(1);

            // List of modals that are safe to open directly via URL
            const allowList = ['support', 'welcome', 'quickstart', 'help']; // (Excludes 'gcode' because it needs app state)

            if (allowList.includes(hash)) {
                this.showModal(hash);

                // This removes #modifier from the URL bar without reloading
                history.replaceState(null, null, window.location.pathname);
            }
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
            const result = this.gcodeResults.get(opId);
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
         * Export route for an operation. 'router' | 'laser' | plain vector.
         */
        routeOf(op) {
            return this.ctrl.core.machineClassOf(op);
        }

        /**
         * True when any SINGLE exported file would hold more than one tool.
         * Multi-file export separates operations, not tools: a multi-tool drill
         * operation is one file holding several bits, and gating the toggle on
         * single-file mode emitted that file with one T word and cut every
         * diameter with whichever cutter loaded first.
         * Reads the same staged descriptors the pipeline uses, so the control
         * and the emitted G-code cannot disagree.
         */
        exportHasMultiToolFile() {
            const ids = this.selectedOperations.filter(op => this.routeOf(op) === 'router').map(op => op.id);
            if (ids.length === 0) return false;

            const staged = this.ctrl.core.stageToolDescriptors(ids, this.ctrl.parameterManager, this.toolIndexMap || {});
            for (const { tool } of staged) {
                const numbers = new Set();
                if (tool.cutsWithOwnTool !== false && tool.number > 0) numbers.add(tool.number);
                for (const entry of Object.values(tool.drillMap || {})) {
                    if (entry.number > 0) numbers.add(entry.number);
                }
                if (numbers.size > 1) return true;
            }
            return false;
        }

        /**
         * Capability-gates the tool-change controls.
         *
         * Two independent decisions, two checkboxes:
         *   tool-changes  - an OUTPUT decision. Insert T/M6 blocks.
         *   group-by-tool - a SEQUENCING decision. Reorders the operation
         *                   list to minimise physical swaps, overriding the
         *                   order the user dragged. Never implied by the
         *                   first: assume the sequence is deliberate.
         */
        updateToolChangeVisibility() {
            const toggle = document.getElementById('exporter-tool-changes');
            const hint = document.getElementById('exporter-tool-changes-hint');
            const groupField = document.getElementById('exporter-group-by-tool-field');
            const groupToggle = document.getElementById('exporter-group-by-tool');
            if (!toggle) return;

            const postName = this.ctrl.core.settings.gcode.postProcessor;
            const caps = this.ctrl.gcodeGenerator
                ?.getProcessorInfo(postName)?.capabilities || {};
            const isSingleFile = document.getElementById('exporter-single-file')?.checked === true;
            const supported = caps.supportsToolChange === true;
            const multiToolFile = !isSingleFile && this.exportHasMultiToolFile();
            toggle.disabled = !supported || (!isSingleFile && !multiToolFile);

            // The hint must name what is actually emitted. supportsToolLengthComp is
            // modes.some(m => m !== 'none'), which is true for probe (emits nothing
            // extra) and table-implicit (T.. M06 G43, no H word anywhere) - so the
            // old string promised an H word in two of the three modes.
            const tlcModes = caps.toolLengthComp?.modes || ['none'];
            const savedTlc = this.ctrl.core.settings.gcode.toolLengthCompMode;
            const tlcMode = savedTlc && tlcModes.includes(savedTlc)
                ? savedTlc
                : (caps.toolLengthComp?.default || tlcModes[0] || 'none');
            const tlcText = tlcMode === 'table' ? ' and G43 H…'
                : tlcMode === 'table-implicit' ? ' and G43'
                : tlcMode === 'probe' ? ', measuring tool length at each change'
                : '';

            let hintText;
            if (!supported) hintText = `${postName} declares no tool-change support - export one file per tool instead.`;
            else if (!isSingleFile && !multiToolFile) hintText = 'Multi-file export already separates tools - one file per operation.';
            else if (!caps.useM6) hintText = 'Emits M0 and waits for cycle start at each change.';
            else hintText = 'Emits T… M6' + tlcText + (caps.pauseAfterToolChange ? ', then M0 until cycle start.' : '.');
            if (!isSingleFile && multiToolFile) hintText += ' One operation holds more than one tool - its file needs the swaps.';
            if (hint) hint.textContent = hintText;

            // One rule across every export control: HIDE only when there is no
            // decision to make (a picker with one option); otherwise DISABLE and put
            // the reason in the hint. Never clear `checked` - a transient state like
            // multi-file must not destroy a preference the user set deliberately.
            const canGroup = supported && isSingleFile && toggle.checked;
            if (groupToggle) {
                groupToggle.disabled = !canGroup;
                groupToggle.title = supported ? (isSingleFile ? 'Reorders operations so each tool is used once.'
                    : 'Multi-file export already separates tools.')
                    : `${postName} declares no tool-change support.`;
            }
            groupField && groupField.classList.remove('is-hidden');

            this.renderToolNotice();
        }

        /**
         * Note about T numbers shared by tools of different sizes.
         *
         * Advisory only and silent unless tool changes are on: with them off
         * exactly one T word is emitted, nothing swaps, and the number is
         * decorative - warning then is noise during a geometry check.
         *
         * Grouped by number so three operations on T1 read as one thing to
         * look at, not three problems.
         */
        renderToolNotice() {
            const panel = document.getElementById('exporter-tool-warning');
            if (!panel) return;

            const hide = () => { panel.className = 'is-hidden'; panel.innerHTML = ''; };

            const toolChangesOn =
                document.getElementById('exporter-tool-changes')?.checked === true;
            if (!toolChangesOn) return hide();

            const ids = this.selectedOperations.filter(op => this.routeOf(op) === 'router').map(op => op.id);
            if (ids.length === 0) return hide();

            const shared = this.ctrl.core.checkToolAssignment(ids, this.ctrl.parameterManager);
            if (shared.length === 0) return hide();

            const mm = (d) => `${d.toFixed(2)} mm`;
            panel.className = 'export-gate export-gate--warning';
            panel.innerHTML =
                '<strong>Some tool numbers are shared by different sizes</strong>' +
                '<ul>' + shared.map(s =>
                    `<li>T${s.number} is called once for ` +
                    s.entries.map(e => `${mm(e.diameter)} (${e.label})`).join(' and ') +
                    '</li>').join('') + '</ul>' +
                '<p>Fine if that is one physical tool - EasyCAM compares sizes, not tool ' +
                'library names. If they are different cutters, give each its own Tool ' +
                'Number in the Tool section of the geometry stage.</p>';
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

            const operation = this.ctrl.core.getOperation(this.drillToolingOpId);
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
                ? '<th>Size</th><th>Features</th><th>Strategy</th><th>Tool &#8960; (mm)</th><th>T#</th>'
                : '<th>Size</th><th>Strategy</th><th>Tool &#8960; (mm)</th><th>T#</th><th>Feed</th><th>Plunge</th><th>RPM</th><th>Peck</th>';

            const sizeCell = row => `<td class="drill-tooling-size">&#8960;${row.diameter.toFixed(3)}<span>mm</span>${row.nativeTools?.length ? `<em>${row.nativeTools.join(', ')}</em>` : ''}</td>`;

            const strategyCell = row => `<td><select data-field="strategy"${ro}>
                                <option value="peck"${'peck' === row.strategy ? ' selected' : ''}>Peck</option>
                                <option value="mill"${'mill' === row.strategy ? ' selected' : ''}>Mill</option>
                                <option value="skip"${'skip' === row.strategy ? ' selected' : ''}>Skip</option>
                            </select></td>`;

            const diameterCell = row => `<td><input type="number" min="0.01" step="0.01" data-field="toolDiameter" value="${row.toolDiameter ?? ''}" placeholder="${'peck' === row.strategy ? row.diameter.toFixed(3) : 'op'}"${'skip' !== row.strategy && geo ? '' : ' disabled'}></td>`;

            const numberCell = row => `<td><input type="number" min="1" step="1" data-field="toolNumber" value="${row.toolNumber ?? ''}" placeholder="&mdash;"${ro}></td>`;

            const cells = row => geo
                ? sizeCell(row) + `<td>${features(row)}</td>` + strategyCell(row) + diameterCell(row) + numberCell(row)
                : sizeCell(row) + strategyCell(row) + diameterCell(row) + numberCell(row)
                    + `<td><input type="number" min="1" step="1" data-field="feedRate" value="${row.cutting?.feedRate ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="1" step="1" data-field="plungeRate" value="${row.cutting?.plungeRate ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="100" step="100" data-field="spindleSpeed" value="${row.cutting?.spindleSpeed ?? ''}" placeholder="op"></td>`
                    + `<td><input type="number" min="0" step="0.05" data-field="peckDepth" value="${row.peck?.peckDepth ?? ''}" placeholder="op"${'peck' === row.strategy ? '' : ' disabled'}></td>`;

            body.innerHTML = `
                <div class="drill-tooling-presets"${geo ? '' : ' hidden'}>
                    <button class="btn btn--secondary btn--compact" data-preset="flatten">Reset to Defaults</button>
                    <button class="btn btn--secondary btn--compact" data-preset="match">Auto-match Tool Library</button>
                    <button class="btn btn--secondary btn--compact" id="drill-tooling-native" title="Excellon header numbers are file indices, not magazine slots. Check them against the machine before running.">Copy Excellon T numbers</button>
                </div>
                <table class="drill-tooling-table">
                    <thead><tr>${head}</tr></thead>
                    <tbody>${entries.map(row => `<tr data-key="${row.key}">${cells(row)}</tr>`).join('')}</tbody>
                </table>
                <p class="modal-notice">${geo
                    ? 'Pick a cutter and a T number for every size you are not skipping. The T number is the slot your controller receives - check it against the machine\'s magazine, not against the file. Changing a cutter discards generated paths; a T number does not.'
                    : 'Feeds and peck depth only. Leave a field empty to inherit the operation\'s value. Cutter and T number are set at the geometry stage.'}</p>
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
                    const settings = this.ctrl.parameterManager.getAllParameters(operation.id) || {};
                    handler.applyDrillPreset(operation, settings, btn.dataset.preset);
                    this.afterDrillToolingEdit(operation, true);
                    this.renderDrillToolingModal();
                };
            });

            const native = document.getElementById('drill-tooling-native');
            native && (native.onclick = () => {
                let applied = 0;
                for (const row of Object.values(operation.drillTable.rows)) {
                    const parsed = parseInt(String((row.nativeTools || [])[0] || '').replace(/\D/g, ''), 10);
                    if (parsed > 0) {
                        handler.updateDrillRow(operation, row.key, { toolNumber: parsed });
                        applied++;
                    }
                }
                this.afterDrillToolingEdit(operation, false);
                this.ui.setStatus(applied > 0
                    ? `Copied ${applied} Excellon tool number(s) - verify them against the machine's magazine.`
                    : 'This file carries no Excellon tool numbers.', applied > 0 ? 'info' : 'warning');
                this.renderDrillToolingModal();
            });

            body.querySelectorAll('[data-field]').forEach(input => {
                input.onchange = () => {
                    const key = input.closest('tr')?.dataset.key;
                    const row = operation.drillTable?.rows?.[key];
                    if (!row) return;
                    const field = input.dataset.field;
                    const raw = String(input.value).trim();
                    // toolNumber is a slot index. parseFloat accepted 3.7 and
                    // the Number.isInteger test below then cleared it silently.
                    const value = '' === raw
                        ? null
                        : ('toolNumber' === field ? parseInt(raw, 10) : parseFloat(raw));
                    let patch;

                    if (field === 'strategy') {
                        patch = { strategy: input.value };
                    } else if (field === 'toolDiameter') {
                        patch = { toolDiameter: (value !== null && value > 0) ? value : null };
                    } else if (field === 'toolNumber') {
                        patch = { toolNumber: Number.isInteger(value) && value > 0 ? value : null };
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
            if (!stales || !operation.offsets?.length || operation.isInvalidated) return;
            this.ctrl.core.invalidateOperationState(operation.id);
            operation.isInvalidated = true;
            operation.invalidatedReason = 'Drill tooling changed after generation - regenerate before exporting.';
            this.ui.setStatus(operation.invalidatedReason, 'warning');
        }

        /**
         * Enables the master toggle only when a split has a decision in it.
         * "Splittable" is DrillHandler.splitDrillFiles' answer, not a count of
         * peck diameters: milled sizes are one bit each in multi-tool mode, so
         * counting pecks disabled the toggle in exactly the job that needs it.
         * The reason rides on the FIELD's title, not a dedicated element: a
         * disabled input does not fire hover in every browser, and the static
         * help already has a tooltip. State and documentation stay separate.
         */
        updateSplitDrillVisibility() {
            const checkbox = document.getElementById('exporter-split-drills');
            const field = document.getElementById('exporter-split-drills-field');
            if (!checkbox) return;

            const list = document.getElementById('exporter-operation-order');
            const isSingleFile = document.getElementById('exporter-single-file')?.checked === true;

            let anyDrill = false, anyUnpreviewed = false, anySplittable = false;
            list?.querySelectorAll('.file-node-content').forEach(item => {
                const cb = item.querySelector('.exporter-op-checkbox');
                if (!cb?.checked) return;
                const op = this.selectedOperations.find(o => o.id === item.dataset.operationId);
                if (op?.type !== 'drill') return;
                anyDrill = true;
                if (op.preview?.ready !== true) { anyUnpreviewed = true; return; }
                if (DrillHandler.splitDrillFiles(op).length > 1) anySplittable = true;
            });

            checkbox.disabled = isSingleFile || !anySplittable;
            if (checkbox.disabled) checkbox.checked = false;

            const reason = isSingleFile
                ? 'Disable "Export as single file" first.'
                : !anyDrill ? 'No drill operations selected.'
                : anyUnpreviewed ? 'Generate the drill previews first.'
                : anySplittable ? 'Writes one file per bit. Sizes sharing a cutter stay together.'
                : 'Every size in this job uses the same bit - nothing to split.';
            if (field) field.title = reason;
            checkbox.title = reason;
        }

        /**
         * Operations the split applies to. The master checkbox is the only
         * control now, so "which ops" is derived rather than collected from
         * per-row state that could drift out of step with it.
         */
        splitDrillOperationIds() {
            if (document.getElementById('exporter-split-drills')?.checked !== true) return [];
            if (document.getElementById('exporter-single-file')?.checked === true) return [];
            const list = document.getElementById('exporter-operation-order');
            const ids = [];
            list?.querySelectorAll('.file-node-content').forEach(item => {
                if (!item.querySelector('.exporter-op-checkbox')?.checked) return;
                const op = this.selectedOperations.find(o => o.id === item.dataset.operationId);
                if (op?.type === 'drill' && op.preview?.ready === true && DrillHandler.splitDrillFiles(op).length > 1) {
                    ids.push(op.id);
                }
            });
            return ids;
        }

        clearExportPreview() {
            const previewText = document.getElementById('exporter-preview-text');
            if (previewText) previewText.value = '';

            const lineCount = document.getElementById('exporter-line-count');
            if (lineCount) lineCount.textContent = '0';

            const opCount = document.getElementById('exporter-op-count');
            if (opCount) opCount.textContent = '0';

            const estTime = document.getElementById('exporter-est-time');
            if (estTime) estTime.textContent = '--:--';

            const distance = document.getElementById('exporter-distance');
            if (distance) distance.textContent = '0mm';

            const warn = document.getElementById('exporter-warnings');
            if (warn) { warn.style.display = 'none'; warn.innerHTML = ''; }

            this.updateCopyButtonScrollbar();
        }

        // REVIEW - Rename, no need to call it placeholder these days.
        showPlaceholderPreview() {
            const previewText = document.getElementById('exporter-preview-text');
            if (previewText) {
                previewText.value = this.text.gcodePlaceholder;
            }

            // Reset stats
            document.getElementById('exporter-line-count').textContent = '0';
            const opCountEl = document.getElementById('exporter-op-count');
            if(opCountEl) opCountEl.textContent = this.selectedOperations.length;
            document.getElementById('exporter-est-time').textContent = '--:--';
            document.getElementById('exporter-distance').textContent = '0mm';

            this.updateCopyButtonScrollbar();
        }

        // Generic modal methods
        showModal(modalName, options = {}) {
            const modal = this.modals[modalName];
            if (!modal) {
                console.error(`[UI-ModalManager] Modal - '${modalName}' - not found`);
                return;
            }

            // Only update hash for content modals, except welcome
            const hashableModals = ['quickstart', 'support'];
            if (hashableModals.includes(modalName)) {
                history.pushState(null, null, `#${modalName}`);
            }

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
                content.setAttribute('role', 'dialog');
                content.setAttribute('aria-modal', 'true');

                const heading = content.querySelector('.modal-header h2');
                if (heading) {
                    const headingId = `modal-heading-${modalName}`;
                    heading.id = headingId;
                    content.setAttribute('aria-labelledby', headingId);
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

            // Move focus to first focusable element inside modal
            requestAnimationFrame(() => {
                const content = modal.querySelector('.modal-content');
                if (content) {
                    // -1 allows JS to focus it, but users can't Tab to it
                    // This satisfies ARIA requirements without showing a button ring
                    content.setAttribute('tabindex', '-1'); 
                    content.style.outline = 'none'; // Ensure no visual ring on the box itself
                    content.focus();
                }
            });
        }

        closeModal() {
            if (!this.activeModal) return;

            this.removeFocusTrap();
            this.activeModal.classList.remove('active');

            if (this.modalStack.length > 0) {
                // Returning to previous modal
                this.activeModal = this.modalStack.pop();
                this.activeModal.classList.add('active');
                this.setupFocusTrap(this.activeModal);

                // Update hash to reflect the modal being returning to
                const returnModalName = this.getActiveModalName();
                if (returnModalName && returnModalName !== 'welcome') {
                    history.replaceState(null, null, `#${returnModalName}`);
                } else {
                    // If returning to welcome (or unknown), clean the URL to root
                    history.replaceState(null, null, window.location.pathname);
                }
            } else {
                // Fully closing removes hash
                this.activeModal = null;
                if (window.location.hash) {
                    history.replaceState(null, null, window.location.pathname);
                }

                // Restore focus - but never to canvas
                if (this.previousActiveElement && 
                    document.body.contains(this.previousActiveElement) &&
                    this.previousActiveElement.id !== 'preview-canvas') {
                    this.previousActiveElement.focus();
                } else {
                    // Jump back to the app's tree or else focus lands on <body> and
                    // keyboard navigation restarts from the top.
                    const sel = this.ctrl.getTreeFocusSelector?.() || '#operations-tree [tabindex="0"]';
                    document.querySelector(sel)?.focus();
                }
                this.previousActiveElement = null;
            }
        }

        handleEscapeKey() {
            if (!this.activeModal) return;

            const modalName = this.getActiveModalName();

            switch (modalName) {
                case 'welcome':
                    // Welcome -> transition to quickstart (same as clicking outside)
                    this.handleClickOutside('welcome');
                    break;

                case 'quickstart':
                    // Quickstart -> go back to welcome
                    this.closeModal()
                    break;
                case 'laserConfig':
                    // laserConfig -> go back to welcome
                    this.closeModal()
                    break;
                case 'support':
                    // Support -> go back to previous (welcome if stacked, or just close)
                    if (this.modalStack.length > 0) {
                        // There's a modal underneath, go back to it
                        this.closeModal();
                    } else {
                        // Opened standalone (e.g., from footer), just close
                        this.closeModal();
                        this.showModal('welcome');
                    }
                    break;

                case 'gcode':
                    // G-code modal -> just close
                    this.closeModal();
                    break;

                case 'warning':
                    // Review - This check looks useless? Why is it checking for activeWarningCallbacks? Shouldn't it exist all the time? or is it checking a state to run the similarly named method?
                    if (this.activeWarningCallbacks?.onCancel) {
                        this.activeWarningCallbacks.onCancel();
                    }
                    this.activeWarningCallbacks = null;
                    this.closeModal();
                    break;

                default:
                    this.closeModal();
            }
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

        showLaserConfigHandler(options = {}) {
            const modal = this.modals.laserConfig;
            if (!modal) return;

            // UV card - full laser pipeline
            const uvCard = document.getElementById('laser-select-uv');
            if (uvCard) {
                uvCard.onclick = (e) => {
                    e.preventDefault();
                    const laserConfig = {
                        laserType: 'uv',
                        outputFormat: D.laser.exportFormat,
                        layerColors: { ...(D.laser.layerColors) }
                    };
                    this.ctrl.setMachineClass('laser', { laser: laserConfig });

                    if (this.ui.machineSettings) {
                        this.ui.machineSettings.updatePipelineFieldVisibility();
                    }

                    this.closeModal();
                    this.showModal('quickstart', options);
                };
            }

            // Fiber card - hybrid pipeline
            const fiberCard = document.getElementById('laser-select-fiber');
            if (fiberCard) fiberCard.onclick = (e) => {
                e.preventDefault();
                // Fixed split for a fiber board: copper goes to the laser, holes
                // and outline to the mill. Per-operation stamps come from this
                // at createOperation.
                const laserConfig = {
                    laserType: 'fiber',
                    outputFormat: D.laser.exportFormat,
                    layerColors: { ...D.laser.layerColors }
                };
                this.ctrl.setMachineClass('router', {
                    laser: laserConfig,
                    classByType: { isolation: 'laser', clearing: 'laser' }
                });
                this.ui.machineSettings?.updatePipelineFieldVisibility();
                this.closeModal();
                this.showModal('quickstart', options);
            };

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

        showWelcomeHandler(options) {
            const modal = this.modals.welcome;

            // Cards are declared per app in HTML with data-pipeline; the
            // controller decides what each id means. EasyTrace: cnc | laser.
            // EasyShape: cnc | 3d. Re-assigned (not addEventListener) because
            // this handler runs on every showModal('welcome').
            modal?.querySelectorAll('.pipeline-card[data-pipeline]').forEach(card => {
                card.onclick = (e) => {
                    e.preventDefault();
                    this.selectPipeline(card.dataset.pipeline, options);
                };
            });

            // Sponsor slots and CTA
            ['sponsor-slot-1', 'sponsor-slot-2', 'sponsor-slot-3', 'sponsor-contact-cta'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.onclick = (e) => {
                        e.preventDefault();
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

        /**
         * Single entry point for welcome-modal pipeline choices. The
         * controller performs the app-specific side effect and returns the
         * modal to advance to, or null to land straight in the workspace.
         */
        selectPipeline(pipelineId, options) {
            this.selectedPipeline = pipelineId;
            const next = this.ctrl.onPipelineSelected?.(pipelineId) ?? 'quickstart';
            this.closeModal();
            if (next && !localStorage.getItem(storageKeys.hideWelcome)) {
                this.showModal(next, options);
            }
        }

        showQuickstartHandler(options = {}) {
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
                const hideWelcome = localStorage.getItem(storageKeys.hideWelcome);
                dontShowCheckbox.checked = !!hideWelcome;

                dontShowCheckbox.onchange = (e) => {
                    if (!e.target.checked) {
                        localStorage.removeItem(storageKeys.hideWelcome);
                        this.ui.setStatus('Quickstart will show on next visit', 'info');
                    }
                };
            }

            // Setup example dropdown
            const select = document.getElementById('pcb-example-select');
            const examples = options.examples || this.ctrl.getExamples(); 

            if (select && examples) {
                select.innerHTML = '';
                Object.entries(examples).forEach(([key, example]) => {
                    const option = document.createElement('option');
                    option.value = key;
                    option.textContent = example.name;
                    select.appendChild(option);
                });
            }

            // Setup compact drop zones
            this.setupQuickstartDropZones();

            // Load example button
            const loadExampleBtn = document.getElementById('load-example-btn');
            if (loadExampleBtn) loadExampleBtn.onclick = async () => {
                const selectedExample = select?.value;
                if (!selectedExample || !this.ctrl.loadExample || this._loadingExample) return;

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
                    this.ui.renderer.core.zoomFit(true);
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
                    await this.processQuickstartFiles();
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
            const validation = this.ctrl.core?.validateFileType(file.name, opType);
            if (validation && !validation.valid) {
                this.ui.setStatus(validation.message, 'error');
                return;
            }

            this.quickstartFiles[opType] = file;

            // Update zone visual
            zone.classList.add('has-file');
            const fileLabel = zone.querySelector('.zone-file');
            if (fileLabel) {
                fileLabel.textContent = file.name;
            }

            this.updateQuickstartProcessButton();
        }

        updateQuickstartProcessButton() {
            const processBtn = document.getElementById('process-quickstart-files-btn');
            if (processBtn) {
                const hasFiles = Object.values(this.quickstartFiles).some(f => f !== null);
                processBtn.disabled = !hasFiles;
            }
        }

        async processQuickstartFiles() {
            for (const [type, file] of Object.entries(this.quickstartFiles)) {
                if (file) {
                    await this.ctrl.processFile(file, type);
                }
            }
            this.quickstartFiles = {};
            
            // Wait for DOM reflow
            requestAnimationFrame(() => {
                this.ui.renderer.core.zoomFit();
                this.ui.renderer.render();
            });
        }

        handleQuickstartClose() {
            // Check the "Don't show again" checkbox
            const dontShowCheckbox = document.getElementById('dont-show-quickstart');
            if (dontShowCheckbox && dontShowCheckbox.checked) {
                // Save preference to localStorage
                localStorage.setItem(storageKeys.hideWelcome, 'true');
            }

            // Actually close the modal
            this.closeModal();
        }

        // Toolpath modal handler
        async showExportManagerHandler(options = {}) {
            const operations = options.operations || [];
            const highlightOperationId = options.highlightOperationId || null;

            this.debug(`Opening Export Manager with ${operations.length} operation(s)`);

            // Reset per-session state
            this.gcodeResults.clear();

            // Sync all toggle visibility with current DOM state
            const selectorDiv = document.getElementById('exporter-operation-selector');
            const singleFileCheck = document.getElementById('exporter-single-file');
            if (selectorDiv) {
                selectorDiv.style.display = (singleFileCheck && singleFileCheck.checked) ? 'none' : '';
            }

            const getSortOrder = (opType) => {
                switch (opType) {
                    case 'isolation': return 1;
                    case 'laser_isolation': return 1;
                    case 'clearing':  return 2;
                    case 'drill':     return 3;
                    case 'cutout':    return 4;
                    case 'stencil':   return 99;
                    default:          return 5;
                }
            };

            this.selectedOperations = operations.sort((a, b) => getSortOrder(a.type) - getSortOrder(b.type));
            this.highlightedOpId = highlightOperationId;

            // Check which operations actually exist in this job
            this.jobHasLaser = this.selectedOperations.some(op => this.routeOf(op) === 'laser');
            this.jobHasCNC = this.selectedOperations.some(op => this.routeOf(op) === 'router');
            this.jobHasVector = this.selectedOperations.some(op => this.routeOf(op) === 'knife');

            const laserOptions = document.getElementById('exporter-laser-options');
            const cncOptions = document.getElementById('exporter-cnc-options');
            const cncPreview = document.getElementById('exporter-cnc-preview');
            const stencilOptions = document.getElementById('exporter-stencil-options');
            const leftColumnWrapper = document.querySelector('.gcode-options');

            // Set the MACRO layout based on the job contents.
            // Use class toggles instead of inline display so the CSS grid layout stays in control.
            if (laserOptions) laserOptions.classList.toggle('is-hidden', !this.jobHasLaser);
            if (cncOptions) cncOptions.classList.toggle('is-hidden', !this.jobHasCNC);
            if (cncPreview) cncPreview.classList.toggle('is-hidden', !this.jobHasCNC);
            if (stencilOptions) stencilOptions.classList.toggle('is-hidden', !this.jobHasVector);
            

            // Update the calculate button text and visibility based on job contents
            const calcBtn = document.getElementById('exporter-calculate-btn');
            if (calcBtn) {
                calcBtn.textContent = this.jobHasCNC ? 'Calculate Toolpaths' : 'Preview Export';
                calcBtn.classList.toggle('is-hidden', !this.jobHasCNC);
            }

            // Fix the grid sizing if CNC preview is completely gone
            if (leftColumnWrapper) {
                leftColumnWrapper.classList.toggle('is-full-width', !this.jobHasCNC);
            }

            this.populateExportOperationsList();

            const orderList = document.getElementById('exporter-operation-order');
            const isSingleFile = document.getElementById('exporter-single-file')?.checked === true;
            if (orderList) {
                orderList.classList.toggle('is-orderable', isSingleFile);
            }

            // Hide split-drills field entirely in laser-only jobs
            const splitDrillsField = document.getElementById('exporter-split-drills-field');
            if (splitDrillsField) {
                splitDrillsField.style.display = this.jobHasCNC ? '' : 'none';
            }

            this.updateExportBlocksVisibility();
            this.updateSplitDrillVisibility();
            this.updateToolChangeVisibility();
            this.setupExportHandlers();

            // Laser specific init (only if laser ops present)
            if (this.jobHasLaser) {
                const laserSettings = this.ctrl.core.settings.laser;

                // Populate the per-job padding input from persisted settings
                const paddingInput = document.getElementById('laser-exporter-padding');
                if (paddingInput) {
                    paddingInput.value = laserSettings.exportPadding ?? D.laser.exportPadding;
                }

                // Update profile summary label in the modal
                const activeProfile = laserSettings.profiles?.[laserSettings.activeProfile];
                const summaryLabel = document.getElementById('laser-profile-summary-label');
                if (summaryLabel && activeProfile) {
                    summaryLabel.textContent = activeProfile.label;
                }
            }

            // Stencil specific init (only if stencil ops present)
            if (this.jobHasVector) {
                const stencilPaddingInput = document.getElementById('stencil-exporter-padding');
                if (stencilPaddingInput) {
                    const laserSettings = this.ctrl.core.settings.laser;
                    stencilPaddingInput.value = laserSettings.exportPadding ?? D.laser.exportPadding;
                }
            }

            // Update filename input with the correct extension for immediate visual feedback
            const filenameInput = document.getElementById('exporter-filename');
            if (filenameInput) {
                // CNC wins when a job mixes routes: the G-code is the file the
                // operator loads, the vectors ride along beside it.
                let ext = '.svg';
                if (this.jobHasCNC) {
                    const processorInfo = this.ctrl.gcodeGenerator
                        .getProcessorInfo(this.ctrl.core.settings.gcode.postProcessor);
                    ext = processorInfo.fileExtension;
                } else if (this.jobHasLaser) {
                    ext = this.ctrl.core.settings.laser.exportFormat === 'png' ? '.png' : '.svg';
                }

                const defaultBaseName = this.ctrl.core.settings.export.defaultBaseName;
                const currentName = filenameInput.value || defaultBaseName;
                const baseName = currentName.replace(/\.[^/.]+$/, ''); // Strip old extension if present
                filenameInput.value = `${baseName}${ext}`;
            }

            this.attachExporterModalTooltips();
        }

        populateExportOperationsList() {
            const list = document.getElementById('exporter-operation-order');
            if (!list) return;
            list.innerHTML = '';

            for (const op of this.selectedOperations) {
                const item = document.createElement('div');
                item.className = 'file-node-content';
                item.dataset.operationId = op.id;

                // Three-way route badge with format indicator
                const route = this.routeOf(op);
                let routeBadge;
                if (route === 'laser') {
                    const laserFormat = this.ctrl.core.settings.laser.exportFormat.toUpperCase();
                    routeBadge = `<span class="exporter-route-badge exporter-route-badge--laser">${laserFormat}</span>`;
                } else if (route === 'router') {
                    const processorInfo = this.ctrl.gcodeGenerator
                        .getProcessorInfo(this.ctrl.core.settings.gcode.postProcessor);
                    const ext = (processorInfo?.fileExtension).replace('.', '').toUpperCase();
                    routeBadge = `<span class="exporter-route-badge exporter-route-badge--cnc">${ext}</span>`;
                } else {
                    routeBadge = '<span class="exporter-route-badge exporter-route-badge--stencil">SVG</span>';
                }

                // REVIEW - Consider moving the operation drag-handler icon to the right so that there aren't shifts when toggling them on/off?
                item.innerHTML = `
                    <input type="checkbox" class="exporter-op-checkbox" id="exp-check-${op.id}" checked>
                    <label for="exp-check-${op.id}">
                        ${op.type}: ${op.file.name}
                        ${routeBadge}
                    </label>
                `;

                // Re-evaluate visibility when checkboxes change
                const checkbox = item.querySelector('input');
                checkbox.addEventListener('change', () => {
                    this.updateExportBlocksVisibility();
                    this.updateSplitDrillVisibility();
                });

                // A stencil is its own job on its own material, so it is never part
                // of the board's processing order.
                if ('stencil' === op.type) {
                    item.dataset.locked = 'true';
                    item.title = 'Exported as a separate file - stencil stock is a different setup.';
                }

                list.appendChild(item);
            }

            this.makeSortable(list);
        }

        updateExportBlocksVisibility() {
            const cncOptions = document.getElementById('exporter-cnc-options');
            const cncPreview = document.getElementById('exporter-cnc-preview');
            const calcBtn = document.getElementById('exporter-calculate-btn');
            const laserOptions = document.getElementById('exporter-laser-options');
            const stencilOptions = document.getElementById('exporter-stencil-options');
            const list = document.getElementById('exporter-operation-order');

            let hasCheckedLaser = false;
            let hasCheckedCNC = false;
            let hasCheckedVector = false;

            // Check what the user currently has checked
            if (list) {
                list.querySelectorAll('.file-node-content').forEach(item => {
                    const checkbox = item.querySelector('input[type="checkbox"]');
                    if (checkbox && checkbox.checked) {
                        const op = this.selectedOperations.find(o => o.id === item.dataset.operationId);
                        if (op) {
                            const route = this.routeOf(op);
                            if (route === 'laser') hasCheckedLaser = true;
                            else if (route === 'router') hasCheckedCNC = true;
                            else hasCheckedVector = true;
                        }
                    }
                });
            }

            // MICRO STATE: Disable (gray out) blocks if their corresponding ops are unchecked
            if (cncOptions) cncOptions.classList.toggle('is-disabled', !hasCheckedCNC);
            if (cncPreview) cncPreview.classList.toggle('is-disabled', !hasCheckedCNC);
            if (laserOptions) laserOptions.classList.toggle('is-disabled', !hasCheckedLaser);
            if (stencilOptions) stencilOptions.classList.toggle('is-disabled', !hasCheckedVector);

            if (calcBtn) calcBtn.disabled = !hasCheckedCNC;
        }

        setupExportHandlers() {
            const cancelBtn = document.getElementById('exporter-cancel-btn');
            const executeBtn = document.getElementById('exporter-execute-btn');
            const calcBtn = document.getElementById('exporter-calculate-btn');
            const closeBtn = this.modals.exportManager?.querySelector('.modal-close');

            if (cancelBtn) cancelBtn.onclick = () => this.closeModal();
            if (closeBtn) closeBtn.onclick = () => this.closeModal();

            if (calcBtn) {
                calcBtn.onclick = () => this.runToolpathOrchestration(calcBtn);
            }

            const singleFileToggle = document.getElementById('exporter-single-file');
            if (singleFileToggle) {
                singleFileToggle.onchange = (e) => {
                    const selectorDiv = document.getElementById('exporter-operation-selector');
                    if (selectorDiv) {
                        selectorDiv.style.display = e.target.checked ? 'none' : '';
                    }
                    const orderList = document.getElementById('exporter-operation-order');
                    if (orderList) {
                        orderList.classList.toggle('is-orderable', e.target.checked);
                    }
                    this.updateSplitDrillVisibility();
                    this.updateToolChangeVisibility();
                    this.gcodeResults.clear();
                    this.showPlaceholderPreview();
                };
            }

            // .onchange, like every sibling control here: setupExportHandlers
            // re-runs on every modal open, and addEventListener on a static
            // element stacks a new listener each time.
            const splitDrillsToggle = document.getElementById('exporter-split-drills');
            if (splitDrillsToggle) splitDrillsToggle.onchange = () => {
                this.gcodeResults.clear();
                this.showPlaceholderPreview();
            };

            // Tool-change controls invalidate calculated G-code the same way
            // the single-file toggle does - without this, toggling after a
            // Calculate exports the previously generated program.
            const toolChangeToggle = document.getElementById('exporter-tool-changes');
            if (toolChangeToggle) {
                toolChangeToggle.onchange = () => {
                    this.updateToolChangeVisibility();
                    this.gcodeResults.clear();
                    this.showPlaceholderPreview();
                };
            }
            const groupByToolToggle = document.getElementById('exporter-group-by-tool');
            if (groupByToolToggle) {
                groupByToolToggle.onchange = () => {
                    this.gcodeResults.clear();
                    this.showPlaceholderPreview();
                };
            }

            // Preview selector: switch displayed G-code when user picks a different operation
            const previewSelect = document.getElementById('exporter-preview-select');
            if (previewSelect) {
                previewSelect.onchange = (e) => this.showGcodeForOperation(e.target.value);
            }

            // Copy to Clipboard
            const copyBtn = document.getElementById('exporter-copy-btn');
            if (copyBtn) {
                copyBtn.onclick = async () => {
                    const previewText = document.getElementById('exporter-preview-text');

                    if (previewText && previewText.value && previewText.value !== (this.text.gcodePlaceholder)) {
                        try {
                            await navigator.clipboard.writeText(previewText.value);
                            this.ui.setStatus('G-code copied to clipboard!', 'success');

                            // Visual feedback via class toggle
                            copyBtn.classList.add('copy-success');

                            setTimeout(() => { 
                                copyBtn.classList.remove('copy-success');
                            }, 2000);

                        } catch (err) {
                            console.error('[UI-ModalManager] Failed to copy text:', err);
                            this.ui.setStatus('Clipboard copy failed. Check browser permissions.', 'error');
                        }
                    } else {
                        this.ui.setStatus('No generated G-code to copy.', 'warning');
                    }
                };
            }

            if (executeBtn) {
                executeBtn.onclick = async () => {
                    await this.executeUnifiedExport();
                };
            }
        }

        async executeUnifiedExport() {
            const executeBtn = document.getElementById('exporter-execute-btn');
            const loadingOverlay = document.getElementById('loading-overlay');
            const loadingText = document.getElementById('loading-text');

            if (executeBtn) executeBtn.disabled = true;

            // Trigger the global wait spinner (with webkit delay context)
            const isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
            if (loadingOverlay && loadingText) {
                loadingText.textContent = isWebKit ? 'Exporting Files - Pacing downloads in webkit...' : 'Exporting Files...';
                loadingOverlay.classList.remove('is-hidden');
                loadingOverlay.focus();
            }

            try {
                // Gather all checked operations
                const activeOpIds = [];
                const list = document.getElementById('exporter-operation-order');
                if (list) {
                    list.querySelectorAll('.file-node-content').forEach(item => {
                        const cb = item.querySelector('input[type="checkbox"]');
                        if (cb?.checked) activeOpIds.push(item.dataset.operationId);
                    });
                }

                // Safeguard: Did users uncheck everything?
                if (activeOpIds.length === 0) {
                    this.ui.setStatus('No operations selected for export.', 'warning');
                    return;
                }

                const laserPaddingInput = document.getElementById('laser-exporter-padding');
                const stencilPaddingInput = document.getElementById('stencil-exporter-padding');

                if (laserPaddingInput) {
                    this.ctrl.core?.updateSettings('laser', { exportPadding: parseFloat(laserPaddingInput.value) });
                }

                const result = await this.ctrl.executeExports({
                    operationIds: activeOpIds,
                    singleFile: document.getElementById('exporter-single-file')?.checked === true,
                    baseName: (document.getElementById('exporter-filename')?.value || 'pcb-output').replace(/\.[^/.]+$/, ''),
                    toolIndexMap: this.toolIndexMap || {},
                    splitDrillOpIds: this.splitDrillOperationIds(),
                    optimize: document.getElementById('exporter-optimize-paths')?.checked ?? true,
                    includeComments: document.getElementById('exporter-include-comments')?.checked,
                    toolChanges: (() => {
                        const t = document.getElementById('exporter-tool-changes');
                        return t?.checked === true && !t.disabled;
                    })(),
                    groupByTool: document.getElementById('exporter-group-by-tool')?.checked === true,
                    laserPadding: laserPaddingInput ? parseFloat(laserPaddingInput.value) : undefined,
                    stencilPadding: stencilPaddingInput ? parseFloat(stencilPaddingInput.value) : undefined,
                    gcodeResults: this.gcodeResults.size > 0 ? Object.fromEntries(this.gcodeResults) : null
                });

                if (result.success) {
                    this.ui.setStatus(result.message, 'success');
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

        attachExporterModalTooltips() {
            if (!this.lang || !window.TooltipManager) return;

            // Manage Modal box
            if (!this.exporterModalTooltipsProcessed) {
                this.exporterModalTooltipsProcessed = new Set();
            }
            const processedLabels = this.exporterModalTooltipsProcessed;

            const attachTo = (inputId, tooltipKey) => {
                const input = document.getElementById(inputId);
                if (!input) return;

                const label = input.closest('.property-field, .field-group')?.querySelector('label');
                if (label) {
                    // Check if modal already has tooltips
                    if (processedLabels.has(label)) {
                        return;
                    }
                    processedLabels.add(label);

                    const { help } = this.lang.entry(tooltipKey);
                    const title = label.textContent; // Use the label text as title

                    if (help) {
                        // This will create the '?' icon
                        window.TooltipManager.attachWithIcon(label, { title, text: help }, {
                            showOnFocus: true
                        });
                    }
                }
            };

            // Find the "Processing Order" <h3> and attach a tooltip to its help text
            const orderHelp = document.querySelector('#exporter-operation-order + .help-text');
            if (orderHelp) {
                const { label, help } = this.lang.entry('ui.modals.exporter.order');
                if (help) {
                window.TooltipManager.attach(orderHelp,
                    { title: label || 'Processing Order', text: help },
                    { immediate: true });
                orderHelp.classList.add('has-help');
                }
            }

            // Attach to checkboxes and inputs
            attachTo('exporter-include-comments', 'ui.modals.exporter.includeComments');
            attachTo('exporter-tool-changes', 'ui.modals.exporter.toolChanges');
            attachTo('exporter-optimize-paths', 'ui.modals.exporter.optimize');
            attachTo('exporter-single-file', 'ui.modals.exporter.singleFile');
            attachTo('exporter-split-drills', 'ui.modals.exporter.splitDrills');
            attachTo('exporter-filename', 'ui.modals.exporter.filename');
            attachTo('laser-exporter-padding', 'params.laserExportPadding');
            attachTo('stencil-exporter-padding', 'params.stencilExportPadding');

            // Attach to calculate button
            const calcBtn = document.getElementById('exporter-calculate-btn');
            if (calcBtn) {
                const { label, help } = this.lang.entry('ui.modals.exporter.calculate');
                if (help) {
                window.TooltipManager.attach(calcBtn,
                    { title: label || 'Calculate Toolpaths', text: help },
                    { immediate: true });
                }
            }
        }

        makeSortable(container) {
            let draggedItem = null;
            let grabbedItem = null;

            // Mouse drag support - only when ordering is active and item isn't locked
            container.addEventListener('dragstart', (e) => {
                if (!container.classList.contains('is-orderable')) {
                    e.preventDefault();
                    return;
                }
                const targetItem = e.target.closest('.file-node-content');
                if (targetItem && container.contains(targetItem) && !targetItem.dataset.locked) {
                    draggedItem = targetItem;
                    draggedItem.classList.add('dragging');
                    e.dataTransfer.effectAllowed = 'move';
                } else {
                    e.preventDefault();
                }
            });

            container.addEventListener('dragend', () => {
                if (draggedItem) {
                    draggedItem.classList.remove('dragging');
                    draggedItem = null;
                }
            });

            container.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (!draggedItem) return;

                const afterElement = this.getDragAfterElement(container, e.clientY);
                if (afterElement == null) {
                    // Don't append after locked items - insert before the first locked one
                    const firstLocked = container.querySelector('.file-node-content[data-locked="true"]');
                    if (firstLocked) {
                        container.insertBefore(draggedItem, firstLocked);
                    } else {
                        container.appendChild(draggedItem);
                    }
                } else if (afterElement.dataset.locked) {
                    // Don't insert after a locked item
                    container.insertBefore(draggedItem, afterElement);
                } else {
                    container.insertBefore(draggedItem, afterElement);
                }
            });

            // Make items draggable and keyboard accessible
            container.querySelectorAll('.file-node-content').forEach((item, idx) => {
                item.draggable = true;
                item.setAttribute('tabindex', idx === 0 ? '0' : '-1');
                item.setAttribute('role', 'listitem');
                item.setAttribute('aria-grabbed', 'false');
            });

            // Keyboard sorting
            container.addEventListener('keydown', (e) => {
                const focused = document.activeElement;
                if (!focused || !focused.classList.contains('file-node-content')) return;
                if (!container.contains(focused)) return;

                const items = Array.from(container.querySelectorAll('.file-node-content'));
                const isGrabbed = focused.getAttribute('aria-grabbed') === 'true';

                // Space: Toggle grab (only in orderable mode, never on locked items)
                if (e.key === ' ') {
                    e.preventDefault();

                    if (!container.classList.contains('is-orderable') || focused.dataset.locked) return;

                    if (isGrabbed) {
                        // Drop
                        focused.setAttribute('aria-grabbed', 'false');
                        focused.classList.remove('is-grabbed');
                        grabbedItem = null;
                        this.ui.setStatus('Item placed', 'info');
                    } else {
                        // Grab - release any other grabbed item first
                        items.forEach(item => {
                            item.setAttribute('aria-grabbed', 'false');
                            item.classList.remove('is-grabbed');
                        });
                        focused.setAttribute('aria-grabbed', 'true');
                        focused.classList.add('is-grabbed');
                        grabbedItem = focused;
                        this.ui.setStatus('Item grabbed. Use Up/Down to move, Space to place.', 'info');
                    }
                }

                // Arrow navigation / reordering
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const idx = items.indexOf(focused);
                    const targetIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;

                    if (isGrabbed) {
                        // Reorder - but never past locked items
                        const sibling = e.key === 'ArrowDown' ? focused.nextElementSibling : focused.previousElementSibling;
                        if (sibling && sibling.classList.contains('file-node-content') && !sibling.dataset.locked) {
                            if (e.key === 'ArrowUp') {
                                container.insertBefore(focused, sibling);
                            } else {
                                container.insertBefore(sibling, focused);
                            }
                            focused.focus();
                        }
                    } else {
                        // Navigate
                        if (items[targetIdx]) {
                            focused.setAttribute('tabindex', '-1');
                            items[targetIdx].setAttribute('tabindex', '0');
                            items[targetIdx].focus();
                        }
                    }
                }

                // Escape: Cancel grab
                if (e.key === 'Escape' && isGrabbed) {
                    e.preventDefault();
                    e.stopPropagation();
                    focused.setAttribute('aria-grabbed', 'false');
                    focused.classList.remove('is-grabbed');
                    grabbedItem = null;
                    this.ui.setStatus('Reorder cancelled', 'info');
                }
            });
        }

        getDragAfterElement(container, y) {
            const draggableElements = [...container.querySelectorAll('.file-node-content:not(.dragging)')];

            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;

                if (offset < 0 && offset > closest.offset) {
                    return { offset: offset, element: child };
                } else {
                    return closest;
                }
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        async runToolpathOrchestration(btn, explicitOps = null) {
            const originalText = btn.textContent;
            btn.textContent = 'Calculating...';
            btn.disabled = true;

            try {
                // Gather UI intent only - no machine settings, no business logic
                let selectedItemIds = [];
                if (explicitOps) {
                    selectedItemIds = explicitOps.map(o => o.id);
                } else {
                    const list = document.getElementById('exporter-operation-order');
                    if (list) {
                        list.querySelectorAll('.file-node-content').forEach(item => {
                            const checkbox = item.querySelector('input[type="checkbox"]');
                            const op = this.selectedOperations.find(o => o.id === item.dataset.operationId);
                            if (checkbox?.checked && op && this.routeOf(op) === 'router') {
                                selectedItemIds.push(item.dataset.operationId);
                            }
                        });
                    }
                }

                if (selectedItemIds.length === 0) {
                    this.ui.setStatus('No CNC operations selected for calculation', 'info');
                    return;
                }

                // Validate all have previews
                const selectedOps = selectedItemIds.map(id => this.selectedOperations.find(o => o.id === id)).filter(Boolean);
                const opsWithoutPreview = selectedOps.filter(op => !this.ctrl.core.isExportReady(op));
                if (opsWithoutPreview.length > 0) {
                    this.showPlaceholderPreview();
                    this.ui.setStatus(`Not ready: ${opsWithoutPreview.map(o => o.file.name).join(', ')}. Finish each operation's stages first.`, 'warning');
                    return;
                }

                const isSingleFile = document.getElementById('exporter-single-file')?.checked === true;

                // Delegate to controller
                const results = await this.ctrl.calculateToolpaths({
                    operationIds: selectedItemIds,
                    singleFile: isSingleFile,
                    toolIndexMap: this.toolIndexMap || {},
                    splitDrillOpIds: this.splitDrillOperationIds(),
                    optimize: document.getElementById('exporter-optimize-paths')?.checked ?? true,
                    includeComments: document.getElementById('exporter-include-comments')?.checked,
                    toolChanges: (() => {
                        const t = document.getElementById('exporter-tool-changes');
                        return t?.checked === true && !t.disabled;
                    })(),
                    groupByTool: document.getElementById('exporter-group-by-tool')?.checked === true
                });

                // Display results in UI
                this.gcodeResults.clear();
                const previewSelect = document.getElementById('exporter-preview-select');
                if (previewSelect) previewSelect.innerHTML = '';

                if (isSingleFile) {
                    const combined = results['__combined__'];
                    if (combined) {
                        this.gcodeResults.set('__combined__', combined);
                        this.showGcodeForOperation('__combined__');
                        const el = document.getElementById('exporter-op-count');
                        if (el) el.textContent = combined.planCount;
                    } else {
                        this.showPlaceholderPreview();
                        this.ui.setStatus('Calculation returned no G-code', 'warning');
                    }
                } else {
                    for (const [key, result] of Object.entries(results)) {
                        this.gcodeResults.set(key, result);
                        if (previewSelect) {
                            const opt = document.createElement('option');
                            opt.value = key;
                            opt.textContent = result.label || key;
                            previewSelect.appendChild(opt);
                        }
                    }
                    if (previewSelect?.options.length > 0) {
                        previewSelect.value = previewSelect.options[0].value;
                        this.showGcodeForOperation(previewSelect.value);
                    } else {
                        this.showPlaceholderPreview();
                    }
                }

                // Show/hide the per-op selector
                const selectorDiv = document.getElementById('exporter-operation-selector');
                if (selectorDiv) selectorDiv.style.display = isSingleFile ? 'none' : '';

            } catch (error) {
                console.error('[UI-ModalManager] Orchestration failed:', error);
                this.showPlaceholderPreview();
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
            const { onConfirm, onCancel, confirmText = 'OK', cancelText = 'Cancel', bodyHTML = null } = options;

            // Track active callbacks at the class level for keyboard/backdrop dismissal
            this.activeWarningCallbacks = { onConfirm, onCancel };

            const modal = this.modals.warning;
            if (!modal) {
                console.error('[ModalManager] Warning modal not found in DOM');
                return;
            }

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
        }

        debug(message, data = null) {
            if (this.ui.debug) {
                this.ui.debug(`[UI-ModalManager] ${message}`, data);
            }
        }
    }

    window.ModalManager = ModalManager;
})();