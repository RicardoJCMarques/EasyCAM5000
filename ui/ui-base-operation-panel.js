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
            this.toolLibrary = null;
            this.lang = null;
            this.appProfile = null;

            // Active state
            this.currentOperationId = null;
            this.currentStage = 'geometry';

            // Debounce for auto-save
            this.changeTimeout = null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Initialization - called by subclass init()
        // ═══════════════════════════════════════════════════════════════

        /**
         * @param {Object} o
         * @param {CamCore} o.core
         * @param {ParameterStore} o.store
         * @param {InputRenderer} o.renderer
         * @param {Object} o.appProfile
         * @param {Object} o.lang
         */
        initBase({ core, store, renderer, appProfile, lang }) {
            this.core = core;
            this.parameterStore = store;
            this.inputRenderer = renderer;
            this.toolLibrary = core?.toolLibrary || null;
            this.appProfile = appProfile;
            this.lang = lang;
            this.parameterStore.addChangeListener(change => this.onExternalParameterChange(change));
        }

        // ═══════════════════════════════════════════════════════════════
        // Abstract hooks - subclasses MUST override
        // ═══════════════════════════════════════════════════════════════

        /** @returns {string} 'prop-' for EasyTrace, 'op-' for EasyShape */
        getIdPrefix() { throw new Error('getIdPrefix() not implemented'); }

        /** @returns {HTMLElement|null} The container element for the parameter form */
        getFormContainer() { throw new Error('getFormContainer() not implemented'); }

        /**
         * Stamp first: an operation carries the class it was created under, and
         * the stencil picker can move it. Falls back to the session for a shape
         * that has no core operation behind it yet.
         * @returns {string} 'router' | 'laser' | 'knife'
         */
        getMachineClass(operationType) {
            const current = this.resolveCurrentOperation();
            const op = current && this.resolveOperationType(current) === operationType
                ? this.core.store.getOperation(current.id)
                : null;

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
        getActionButtonInfo(stage, opType) { return { text: 'Generate', disabled: false } }

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
            this.ui.setStatus(
                'drillMultiTool' === name
                    ? value
                        ? 'Multi-tool drilling on - assign a tool per hole size.'
                        : 'Single-tool drilling - the operation tool cuts every hole.'
                    : `Switched to ${value ? 'milling' : 'pecking'} mode`,
                'info',
            );
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
            // Identity-carrying fields (tool number, labels) move no geometry.
            if (def.invalidates === false) return;

            this.core.store.bumpOperationRevision(op.id, def.stage);
            const reason = `'${def.label || paramName}' changed after generation - regenerate before exporting.`;
            if (this.core.store.refreshStaleFlags(op.id, reason)) this.ui.setStatus(op.invalidatedReason, 'warning');
            this.onInvalidated(op);
        }

        /** App hook: refresh whichever tree draws this operation's nodes. */
        onInvalidated(operation) {}

        // ═══════════════════════════════════════════════════════════════
        // Shared Form Rendering
        // ═══════════════════════════════════════════════════════════════

        /** Renders parameter fields grouped by category into a container. */
        renderParameterForm(container, opType, stage, values) {
            const store = this.parameterStore;
            const ctx = this.getOperationContext(opType);
            const groups = {};
            for (const param of store.getStageParameters(stage, opType, ctx)) {
                (groups[param.category || 'general'] ||= []).push(param);
            }
            // Profile declaration order. Undeclared categories fall to the end
            // in the order they were met - the sort is stable.
            const titles = this.appProfile.ui.categories || {};
            const declared = Object.keys(titles);
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
                h3.textContent = titles[cat] || cat.charAt(0).toUpperCase() + cat.slice(1);
                section.appendChild(h3);
                for (const p of groups[cat]) {
                    const val = values[p.name] !== undefined ? values[p.name] : p.default;
                    section.appendChild(
                        this.inputRenderer.createField(p, val, {
                            idPrefix: prefix,
                            opType: opType,
                            toolLibrary: this.toolLibrary,
                            lang: this.lang,
                            onChange: (name, newVal, el) => this.onParameterChange(name, newVal, el, opType)
                        })
                    );
                }
                container.appendChild(section);
            }
            this.inputRenderer.refreshFields(container, values, store.optionGates);
            UIControls.setupPropertyGridNavigation(container);
        }

        // ═══════════════════════════════════════════════════════════════
        // Unified Parameter Change Handler
        // ═══════════════════════════════════════════════════════════════

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
                if (tool) {
                    this.syncToolParameters(tool, opType);
                }
            }

            // Validate through ParameterStore
            const result = ps.setParameter(this.currentOperationId, getStage(name), name, value);

            if (result.success) {
                if (inputEl) { inputEl.classList.remove('input-error'); inputEl.removeAttribute('aria-invalid'); }
            } else {
                if (inputEl) { inputEl.classList.add('input-error'); inputEl.setAttribute('aria-invalid', 'true'); }
                if (result.correctedValue !== undefined && inputEl) {
                    inputEl.value = result.correctedValue;
                    inputEl.classList.remove('input-error');
                    inputEl.removeAttribute('aria-invalid');
                }
                if (result.error) this.ui.setStatus(result.error, 'error');
            }

            // A parameter may own the operation's machine class. That changes
            // which parameters exist and how many stages the chain has, so the
            // form is rebuilt rather than patched.
            // CNC Stencil only, for diode/co2 lasers, vinyl cutters or drag knife machines
            const boundDef = ps.parameterDefinitions[name];
            if (boundDef?.bindsMachineClass) {
                clearTimeout(this.changeTimeout);
                const target = this.core.store.getOperation(this.currentOperationId);
                if (target) {
                    const label = boundDef.options?.find(o => o.value === value)?.label || value;
                    target.machineClass = value;
                    this.core.store.bumpOperationRevision(target.id, 'geometry');
                    this.core.store.refreshStaleFlags(target.id,
                        `Machine changed to ${label} - regenerate before exporting.`);
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
                this.changeTimeout = setTimeout(
                    () => this.saveCurrentState(), D.ui.timing.propertyDebounce);
            }
        }

        syncToolParameters(tool, opType) {
            if (!tool || !this.currentOperationId) return;
            const ps = this.parameterStore;
            const prefix = this.getIdPrefix();
            // Skips null/undefined, so a tool leaves alone the fields it has no value for.
            const setField = (paramName, val) => {
                if (val == null) return;
                const def = ps.parameterDefinitions[paramName];
                if (!def) return;
                if (def.operationTypes && !def.operationTypes.includes(opType)) return;
                ps.setParameter(this.currentOperationId, def.stage || this.currentStage, paramName, val);
                const el = document.getElementById(`${prefix}${paramName}`);
                if (!el) return;
                if (el.type === 'checkbox') el.checked = !!val;
                else el.value = val;
            };

            // Sizing follows the operation, not the tool: only copper reads the effective cut width.
            const sizes = this.toolLibrary.getToolSizes(tool.id);
            if (!sizes) return;
            const useEffective = this.core.registry.toolSizingFor(opType) === 'effective';
            setField('toolDiameter', useEffective ? sizes.effective : sizes.diameter);
            setField('vbitTipRadius', sizes.tipRadius);
            setField('vbitAngle', sizes.angle);
            setField('reliefCornerRadius', sizes.cornerRadius);
            setField('rotaryCornerRadius', sizes.cornerRadius);
            setField('reliefToolShape', sizes.tipType);
            setField('rotaryToolShape', sizes.tipType);

            const cutting = tool.cutting;
            if (!cutting) return;
            setField('feedRate', cutting.feedRate);
            setField('plungeRate', cutting.plungeRate);
            setField('spindleSpeed', cutting.spindleSpeed);
            setField('spindleDwell', cutting.spindleDwell);
            setField('cutDepth', cutting.cutDepth);
            const depthPerPass = cutting.maxDepthPerPass ?? cutting.depthPerPass;
            setField('depthPerPass', depthPerPass);
            setField('drillDepthPerPass', depthPerPass);
            setField('stepOver', cutting.stepOver);
            setField('drillStepOver', cutting.stepOver);
        }

        onExternalParameterChange(change) {
            if (change.operationId !== this.currentOperationId) return;
            const input = document.getElementById(`${this.getIdPrefix()}${change.name}`);
            if (!input) return;
            if (input.type === 'checkbox') input.checked = change.value;
            else input.value = change.value;
        }

        // ═══════════════════════════════════════════════════════════════
        // Stage Management
        // ═══════════════════════════════════════════════════════════════

        refresh() {
            const op = this.resolveCurrentOperation();
            this.refreshOperationPanel(op);
        }

        clearProperties() {
            this.currentOperationId = null;
            this.currentStage = null;
            clearTimeout(this.changeTimeout);
        }

        // ═══════════════════════════════════════════════════════════════
        // Generation & Preview Pipeline
        // ═══════════════════════════════════════════════════════════════

        /** Calls the operation handler's orchestrateGeneration. */
        async runGeneration(operationId) {
            const operation = this.core.store.getOperation(operationId);
            if (!operation) return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            let handler;
            try {
                handler = this.core.getHandler(operation.type);
            } catch (e) {
                return { success: false, message: `No handler for '${operation.type}': ${e.message}`, status: 'warning' };
            }
            const params = this.parameterStore.getAllParameters(operationId);
            // Refusals come before the progress task opens, so there is nothing to close.
            const multiToolDrill = 'drill' === operation.type && true === params.drillMultiTool;
            if (multiToolDrill) {
                const info = DrillHandler.describeTable(operation, params);
                if (!info.complete) {
                    return {
                        success: false,
                        status: 'warning',
                        message: info.reason || 'Complete multi-tool drill tooling setup before generating.',
                    };
                }
            }
            const toolNumDef = this.parameterStore.parameterDefinitions.toolNumber;
            const toolNumApplies =
                toolNumDef &&
                !multiToolDrill &&
                (!toolNumDef.operationTypes || toolNumDef.operationTypes.includes(operation.type));
            if (toolNumApplies) {
                const toolNum = Number(params.toolNumber);
                if (!Number.isInteger(toolNum) || toolNum < 1) {
                    return {
                        success: false,
                        status: 'warning',
                        message:
                            'Enter a tool number (the T word your controller receives) before generating. If your machine has no tool changer, 1 is correct.',
                    };
                }
            }
            const sm = this.ui.statusManager;
            const taskId = sm.beginTask(this.getSpinnerLabel('geometry', operation.type) || 'Generating');
            try {
                // Let the overlay paint before blocking work
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const result = await handler.orchestrateGeneration(operation, params, this.core, {
                    onProgress: (p) => sm.tick(taskId, p),
                });
                if (result?.success) this.core.store.stampArtifact(operationId, 'offsets');
                return this.withDepthWarning(result, operation, params);
            } catch (e) {
                console.error(`[BaseOperationPanel] Generation failed for ${operation.type}:`, e);
                return { success: false, message: `Generation failed: ${e.message}`, status: 'error' };
            } finally {
                sm.endTask(taskId);
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
            if (!operation) {
                return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            }

            const params = this.parameterStore.getAllParameters(operationId) || {};

            // Feeds are the one parameter with no safe default anywhere in the
            // stack. F0 is not "use the last feed": Grbl and grblHAL reject it
            // (error:22), LinuxCNC and Fanuc-style controls alarm, and Marlin
            // silently keeps the PREVIOUS modal feed - so a zero here cuts at
            // whatever the operation before it was set to. NaN reaches the post
            // as the literal FNaN.
            // Number.isFinite, never truthiness: 0 is a legal coordinate but
            // never a legal feed, and those are different tests.
            const badFeeds = [
                Number.isFinite(params.feedRate) && params.feedRate > 0 ? null : 'feed rate',
                Number.isFinite(params.plungeRate) && params.plungeRate > 0 ? null : 'plunge rate'
            ].filter(Boolean);
            if (badFeeds.length) {
                return {
                    success: false,
                    status: 'warning',
                    message: `Set a ${badFeeds.join(' and ')} above zero before calculating toolpaths. Feeds seed from the selected tool - pick one, or type a value.`
                };
            }

            try {
                const { plans, warnings, metrics } = await this.ui.ctrl.computeToolpaths(operationId, {
                    optimize: params.optimizeToolpath !== false
                });

                if (!plans.length) {
                    return { success: false, message: 'Toolpath calculation produced no motion', status: 'warning' };
                }

                if (warnings.length) {
                    this.ui.setStatus(warnings[0], 'warning');
                    if (D.debug.enabled) console.warn(`[Toolpaths] ${operationId}:\n  ${warnings.join('\n  ')}`);
                }

                const mins = Math.floor(metrics.estimatedTime / 60);
                const secs = Math.floor(metrics.estimatedTime % 60);
                return {
                    success: true,
                    status: 'success',
                    message: `${plans.length} toolpath(s) - ~${mins}:${String(secs).padStart(2, '0')}, ` +
                             `${metrics.totalDistance.toFixed(0)}mm (this operation alone)`
                };
            } catch (e) {
                console.error(`[BaseOperationPanel] Toolpath calculation failed for ${operationId}:`, e);
                return { success: false, message: `Toolpath calculation failed: ${e.message}`, status: 'error' };
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
            h3.textContent = 'Output';
            section.appendChild(h3);

            const tp = this.core.store.getToolpaths(operation.id);
            const summary = document.createElement('div');
            summary.className = 'summary-line';
            if (tp?.plans?.length) {
                const mins = Math.floor(tp.metrics.estimatedTime / 60);
                const secs = Math.floor(tp.metrics.estimatedTime % 60);
                summary.innerHTML = `<strong>${tp.plans.length} toolpath(s)</strong>, ~${mins}:${String(secs).padStart(2, '0')}, ${tp.metrics.totalDistance.toFixed(0)}mm`;
            } else summary.innerHTML = '<strong>No toolpaths calculated.</strong>';
            section.appendChild(summary);

            const note = document.createElement('div');
            note.className = 'summary-line summary-secondary';
            note.textContent = 'Files, ordering and tool changes are set in the Export Manager.';
            section.appendChild(note);
            return section;
        }

        /**
         * Generates a CNC toolpath preview from existing offsets.
         * Returns { success, message, status }.
         */
        async runPreview(operationId) {
            const operation = this.core.store.getOperation(operationId);
            if (!operation) {
                return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            }

            if (!operation.offsets || operation.offsets.length === 0) {
                return { success: false, message: 'Generate geometry first', status: 'warning' };
            }

            const success = this.core.store.generateCNCPreview(operationId);
            if (!success) {
                return { success: false, message: 'Preview generation failed (check tool diameter)', status: 'error' };
            }
            this.core.store.stampArtifact(operationId, 'preview');

            return this.withDepthWarning(
                { success: true, message: 'Preview generated', status: 'success' },
                operation, this.parameterStore.getAllParameters(operationId)
            );
        }

        /** Appends a depth warning to a successful result, if there is one. */
        withDepthWarning(result, operation, params) {
            if (!result?.success) return result;
            const warning = this.checkDepthLimits(operation, params);
            if (!warning) return result;
            return { ...result, status: 'warning', message: `${result.message} - ${warning}` };
        }

        /**
         * cutDepth against the machine's configured floor. The only other
         * check is BasePostProcessor.validateCommand, which runs per command
         * at emission and reaches the user after the file is written.
         * @returns {string|null}
         */
        checkDepthLimits(operation, params) {
            if (params.cutDepth == null) return null;   // 3D ops own their depths
            const maxSafe = this.core.settings?.machine?.heights?.maxSafeDepth;
            if (typeof maxSafe !== 'number') return null;

            const deepestZ = this.core.pipelineContext.resolveSurfaceZ(operation) - Math.abs(params.cutDepth);

            if (deepestZ < maxSafe) {
                return `cut reaches Z ${deepestZ.toFixed(2)}mm, past the machine's max ` +
                    `safe depth (${maxSafe}mm). Check stock thickness and Z-zero.`;
            }
            return null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Shared UI Builders
        // ═══════════════════════════════════════════════════════════════

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
         * The card is the per-size table, which exists only when the profile
         * declares drillMultiTool. Keyed on the parameter, not the app.
         */
        supportsDrillTooling() {
            return !!this.parameterStore?.parameterDefinitions?.drillMultiTool;
        }

        /**
         * Drill tooling card, shown in multi-tool mode only (the drillMultiTool
         * checkbox above): summarizes the per-size table and opens it.
         */
        createDrillToolingCard(operation, settings, stage) {
            const info = DrillHandler.describeTable(operation, settings);
            if (info.mode !== 'perSize') return null;
            const section = document.createElement('div');
            section.className = 'property-section drill-tooling-card';
            const h3 = document.createElement('h3');
            h3.textContent = this.lang?.get('drill.tooling.title', 'Drill Tooling');
            section.appendChild(h3);
            const parts = [];
            if (info.counts.peck) parts.push(`${info.counts.peck} pecked`);
            if (info.counts.mill) parts.push(`${info.counts.mill} milled`);
            if (info.counts.skip) parts.push(`${info.counts.skip} skipped`);
            const summary = document.createElement('div');
            summary.className = 'summary-line';
            summary.innerHTML = info.sizeCount > 0
                ? `<strong>${info.sizeCount} size${info.sizeCount > 1 ? 's' : ''}:</strong> ${parts.join(', ')}`
                : '<strong>No hole sizes detected yet.</strong>';
            section.appendChild(summary);
            const detail = document.createElement('div');
            detail.className = 'summary-line summary-secondary';
            detail.textContent = info.numbers.length > 0
                ? `Tools: ${info.numbers.map(n => `T${n}`).join(', ')}`
                : 'No tool numbers assigned yet.';
            section.appendChild(detail);
            if (info.reason) {
                const warn = document.createElement('div');
                warn.className = 'summary-line summary-warning';
                warn.textContent = info.reason;
                section.appendChild(warn);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn--block btn--primary';
            button.textContent = this.lang?.get('drill.tooling.configure', 'Configure Drill Tooling...');
            button.disabled = info.rows.length === 0;
            button.title = info.rows.length
                ? 'Assign a tool, a T number and a strategy per hole size.'
                : 'No hole sizes detected yet - generate once to build the table.';
            // The card renders at geometry AND strategy, and the modal shows
            // only that stage's columns: the cutter belongs to geometry because
            // changing it stales the operation, feeds and T numbers to strategy
            // because they resolve at translation. Same split GEOMETRY_FIELDS
            // already enforces on the write path.
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
            panel.querySelector('.warning-message').textContent = operation.invalidatedReason;
            panel.querySelector('.invalidation-redo-btn').onclick = async () => {
                await this.discardInvalidGeometry(operation);
                this.ui.setStatus('Invalid geometry cleared. Ready to regenerate.', 'success');
            };
            return panel;
        }

        /** App hook: drops the operation's stale geometry and shows its source form. */
        discardInvalidGeometry(operation) {}

        createWarningPanel(warnings) {
            const panel = document.createElement('div');
            panel.className = 'parameter-warning-panel';

            const icon = `<svg class="cam-icon" width="14" height="14"><use href="#icon-warning"></use></svg>`;

            // Deduplicate
            const seen = new Set();
            const unique = warnings.filter(w => {
                const msg = typeof w === 'string' ? w : w.message;
                if (seen.has(msg)) return false;
                seen.add(msg);
                return true;
            });

            const header = document.createElement('div');
            header.className = 'parameter-warning-header';
            header.innerHTML = `${icon} ${unique.length} Warning${unique.length > 1 ? 's' : ''}`;
            panel.appendChild(header);

            const list = document.createElement('ul');
            list.className = 'parameter-warning-list';

            for (const w of unique) {
                const item = document.createElement('li');
                item.textContent = typeof w === 'string' ? w : w.message;
                list.appendChild(item);
            }

            panel.appendChild(list);
            return panel;
        }

        // ═══════════════════════════════════════════════════════════════
        // Action Dispatch
        // ═══════════════════════════════════════════════════════════════

        /**
         * Stage-based action dispatch. Subclass hooks: getSpinnerLabel,
         * onGenerationSuccess, onGenerationFailure, onPreviewSuccess,
         * onToolpathSuccess. Each success hook selects the node the action
         * produced, and that selection renders the next stage's form.
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
            const opType = this.resolveOperationType(operation);
            const ACTIONS = {
                geometry: {
                    run: () => this.runGeneration(opId),
                    after: (id) => this.onGenerationSuccess(id, operation),
                    spinner: null,
                },
                strategy: {
                    run: () => this.runPreview(opId),
                    after: (id) => this.onPreviewSuccess(id, operation),
                    spinner: 'Generating preview...',
                },
                machine: {
                    run: () => this.runToolpaths(opId),
                    after: (id) => this.onToolpathSuccess(id, operation),
                    spinner: 'Calculating toolpaths...',
                },
            };
            const action = ACTIONS[stage];
            if (!action) return;
            const spinner = action.spinner === null ? null : this.getSpinnerLabel(stage, opType) || action.spinner;
            let taskId = null;
            if (spinner) {
                taskId = this.ui.statusManager.beginTask(spinner);
                // Let the overlay paint before blocking work
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
            try {
                const result = await action.run();
                this.ui.setStatus(result.message, result.status);
                if (result.success) await action.after(opId);
                else if (stage === 'geometry') this.onGenerationFailure(opId, operation, stage);
            } catch (e) {
                console.error(`[${this.constructor.name}] ${stage} failed:`, e);
                this.ui.setStatus(`${stage} failed: ${e.message}`, 'error');
            } finally {
                if (taskId !== null) this.ui.statusManager.endTask(taskId);
            }
            this.ui.ctrl.returnFocusToTree();
        }

        // Hooks for subclass override

        /** Resolve the current operation/shape. Apps store this differently. */
        resolveCurrentOperation() { return null; }

        /** Extract opType from the resolved operation object. */
        resolveOperationType(operation) { return operation?.type || ''; }

        /** Spinner label per stage. */
        getSpinnerLabel(stage, opType) { return null; }

        /** Called after successful generation. Update tree, renderer, etc. */
        async onGenerationSuccess(opId, operation) {}

        /** Called after failed generation. Refresh panel, etc. */
        onGenerationFailure(opId, operation, stage) {}

        /** Called after successful preview. Update tree, renderer, etc. */
        async onPreviewSuccess(opId, operation) {}

        /** Toolpaths just landed. Apps refresh their tree and the 3D view. */
        async onToolpathSuccess(opId, operation) {}

        // ═══════════════════════════════════════════════════════════════
        // Debug
        // ═══════════════════════════════════════════════════════════════

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