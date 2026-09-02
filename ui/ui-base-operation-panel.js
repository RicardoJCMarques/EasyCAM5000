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
            this.parameterManager = null;
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

        initBase(core, paramManager, appProfile, lang) {
            this.core = core;
            this.parameterManager = paramManager;
            this.toolLibrary = core?.toolLibrary || null;
            this.appProfile = appProfile;
            this.lang = lang;

            this.parameterManager.addChangeListener((change) => {
                this.onExternalParameterChange(change);
            });
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
                ? this.core.getOperation(current.id)
                : null;
            if (op) return this.core.machineClassOf(op);

            return this.ui.ctrl.resolveMachineClass?.(operationType)
                || this.ui.ctrl.pipelineState?.machineClass
                || 'router';
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
                stages: this.parameterManager.getStages(operationType, machineClass),
                artifacts: this.parameterManager.getArtifacts(operationType, machineClass)
            };
        }

        /** Persist current form state to the operation/shape model */
        saveCurrentState() {
            if (!this.currentOperationId) return;
            const operation = this.resolveCurrentOperation();
            if (!operation) return;
            this.parameterManager.commitToOperation(this.normalizeForCommit(operation));
            this.debug(`Saved state for ${this.currentOperationId}`);
        }

        /** Renders the parameter form for the given operation/shape. */
        showOperationProperties(container, operation, stage) {
            throw new Error('showOperationProperties() not implemented');
        }

        /**
         * Converts the resolved operation/shape into the flat {id, settings}
         * object that commitToOperation expects. Subclasses override if their
         * object model differs.
         */
        normalizeForCommit(resolved) {
            // Default: assume resolved IS the operation (EasyTrace)
            return resolved;
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
            const operation = this.resolveDrillOperation();
            if (operation) {
                const settings = this.parameterManager.getAllParameters(this.currentOperationId) || {};
                try {
                    this.core.getHandler('drill').ensureDrillTable(operation, settings);
                } catch (e) {
                    this.debug(`Drill table refresh skipped: ${e.message}`);
                }
            }
            this.refreshOperationPanel(operation);
            this.ui.setStatus('drillMultiTool' === name
                ? (value
                    ? 'Multi-tool drilling on - assign a tool per hole size.'
                    : 'Single-tool drilling - the operation tool cuts every hole.')
                : `Switched to ${value ? 'milling' : 'pecking'} mode`, 'info');
        }

        /**
         * The core operation behind whatever the panel is editing. EasyTrace
         * edits the operation directly; EasyShape edits a shape or a bucket and
         * only the bucket's id is an operation id, so a shape-context toggle
         * resolves to null and simply skips the table refresh.
         */
        resolveDrillOperation() {
            if (this.currentBucket) return this.currentBucket.getOperation(this.core);
            return this.core?.getOperation?.(this.currentOperationId) || null;
        }

        /**
         * A parameter changed. Bump that stage's revision and let the core
         * work out whether anything downstream went stale.
         *
         * This used to be a per-app override and the two drifted: EasyShape
         * fired on the geometry stage only and whenever offsets existed;
         * EasyTrace fired on geometry OR strategy but only once the
         * operation was already export-ready. Neither watched stock
         * thickness, machine heights or the workspace transform at all.
         */
        checkInvalidation(paramName) {
            const target = this.resolveCurrentOperation();
            if (!target) return;

            const op = this.core.getOperation(target.id);
            if (!op) return;

            const def = this.parameterManager.parameterDefinitions[paramName];
            if (!def || !def.stage) return;
            // Identity-carrying fields (tool number, labels) move no geometry.
            if (def.invalidates === false) return;

            this.core.bumpOperationRevision(op.id, def.stage);
            const reason = `'${def.label || paramName}' changed after generation - regenerate before exporting.`;
            if (this.core.refreshStaleFlags(op.id, reason)) this.ui.setStatus(op.invalidatedReason, 'warning');
            this.onInvalidated(op);
        }

        /** App hook: refresh whichever tree draws this operation's nodes. */
        onInvalidated(operation) {}

        /** Returns focus to the appropriate tree/list element after generation */
        returnFocusToTree() {}

        // ═══════════════════════════════════════════════════════════════
        // Shared Form Rendering
        // ═══════════════════════════════════════════════════════════════

        /**
         * Renders parameter fields grouped by category into a container.
         * Called by both showOperationProperties variants.
         */
        renderParameterForm(container, opType, stage, values) {
            const pm = this.parameterManager;
            const ctx = this.getOperationContext(opType);
            const groups = this.groupByCategory(pm.getStageParameters(stage, opType, ctx));
            const prefix = this.getIdPrefix();

            for (const cat of this.orderCategories(Object.keys(groups))) {
                const section = document.createElement('div');
                section.className = 'property-section';
                section.dataset.category = cat;

                const h3 = document.createElement('h3');
                h3.textContent = this.getCategoryTitle(cat);
                section.appendChild(h3);

                for (const p of groups[cat]) {
                    const val = void 0 !== values[p.name] ? values[p.name] : p.default;
                    section.appendChild(ParameterManager.createField(p, val, {
                        idPrefix: prefix, opType, toolLibrary: this.toolLibrary, lang: this.lang,
                        onChange: (name, newVal, el) => this.onParameterChange(name, newVal, el, opType)
                    }));
                }
                container.appendChild(section);
            }
            ParameterManager.evaluateConditionals(container, values, pm.optionGates);
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

            const pm = this.parameterManager;
            const getStage = paramName => pm.parameterDefinitions[paramName]?.stage || this.currentStage;

            // Tool selection change - sync all tool attributes
            if (inputEl?.tagName === 'SELECT' && (name === 'tool' || name.endsWith('Tool')) && this.toolLibrary) {
                const tool = this.toolLibrary.getTool(value);
                if (tool) {
                    this.syncToolParameters(tool, opType);
                }
            }

            // Validate through ParameterManager
            const result = pm.setParameter(this.currentOperationId, getStage(name), name, value);

            if (result.success) {
                if (inputEl) inputEl.classList.remove('input-error');
            } else {
                if (inputEl) inputEl.classList.add('input-error');
                if (result.correctedValue !== undefined && inputEl) {
                    inputEl.value = result.correctedValue;
                    inputEl.classList.remove('input-error');
                }
                if (result.error) this.ui.setStatus(result.error, 'error');
            }

            // A parameter may own the operation's machine class. That changes
            // which parameters exist and how many stages the chain has, so the
            // form is rebuilt rather than patched.
            // CNC Stencil only, for diode/co2 lasers, vinyl cutters or drag knife machines
            const boundDef = pm.parameterDefinitions[name];
            if (boundDef?.bindsMachineClass) {
                clearTimeout(this.changeTimeout);
                const target = this.core.getOperation(this.currentOperationId);
                if (target) {
                    const label = boundDef.options?.find(o => o.value === value)?.label || value;
                    target.machineClass = value;
                    this.core.bumpOperationRevision(target.id, 'geometry');
                    this.core.refreshStaleFlags(target.id,
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

            // Re-evaluate conditionals from PM state (single source of truth)
            const formContainer = this.getFormContainer();
            if (formContainer) {
                const allParams = pm.getAllParameters(this.currentOperationId);
                ParameterManager.evaluateConditionals(formContainer, allParams, pm.optionGates);
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
            const pm = this.parameterManager;
            const prefix = this.getIdPrefix();
            const setField = (paramName, val) => {
                if (null == val) return;
                const def = pm.parameterDefinitions[paramName];
                if (!def) return;
                if (def.operationTypes && !def.operationTypes.includes(opType)) return;
                pm.setParameter(this.currentOperationId, def.stage || this.currentStage, paramName, val);
                const el = document.getElementById(`${prefix}${paramName}`);
                el && ("checkbox" === el.type ? (el.checked = !!val) : (el.value = val));
            };

            // setField ignores null/undefined, so a flat tool simply skips the
            // fields it has no value for. Sizing follows the operation, not the
            // tool: only copper reads the effective cut width.
            const sizes = this.toolLibrary.getToolSizes(tool.id);
            if (!sizes) return;
            const useEffective = this.core?.registry?.toolSizingFor(opType) === 'effective';
            setField('toolDiameter', useEffective ? sizes.effective : sizes.diameter);
            setField('vbitTipRadius', sizes.tipRadius);
            setField('vbitAngle', sizes.angle);
            setField('reliefCornerRadius', sizes.cornerRadius);
            setField('rotaryCornerRadius', sizes.cornerRadius);
            setField('reliefToolShape', sizes.tipType);
            setField('rotaryToolShape', sizes.tipType);

            if (tool.cutting) {
                // REVIEW - What do all these void 0 !== checks do?
                void 0 !== tool.cutting.feedRate && setField("feedRate", tool.cutting.feedRate);
                void 0 !== tool.cutting.plungeRate && setField("plungeRate", tool.cutting.plungeRate);
                void 0 !== tool.cutting.spindleSpeed && setField("spindleSpeed", tool.cutting.spindleSpeed);
                void 0 !== tool.cutting.spindleDwell && setField("spindleDwell", tool.cutting.spindleDwell);
                void 0 !== tool.cutting.cutDepth && setField("cutDepth", tool.cutting.cutDepth);
                if (void 0 !== tool.cutting.maxDepthPerPass || void 0 !== tool.cutting.depthPerPass) {
                    setField("depthPerPass", tool.cutting.maxDepthPerPass ?? tool.cutting.depthPerPass);
                    setField("drillDepthPerPass", tool.cutting.maxDepthPerPass ?? tool.cutting.depthPerPass);
                }
                if (void 0 !== tool.cutting.stepOver) {
                    setField("stepOver", tool.cutting.stepOver);
                    setField("drillStepOver", tool.cutting.stepOver);
                }
            }
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

        switchStage(newStage) {
            this.currentStage = newStage;
        }

        /**
         * Re-renders the current operation/shape view. Subclasses override
         * to resolve the correct object type for showOperationProperties.
         */
        refresh() {
            if (!this.currentOperationId) return;
            const container = this.getFormContainer();
            const operation = this.resolveCurrentOperation();
            if (container && operation) {
                this.showOperationProperties(container, operation, this.currentStage);
            }
        }

        clearProperties() {
            this.currentOperationId = null;
            this.currentStage = null;
            clearTimeout(this.changeTimeout);
        }

        // ═══════════════════════════════════════════════════════════════
        // Generation & Preview Pipeline
        // ═══════════════════════════════════════════════════════════════

        /**
         * Calls the operation handler's orchestrateGeneration.
         * Returns the handler's result object { success, message, status }.
         */
        async runGeneration(operationId) {
            const operation = this.core.getOperation(operationId);
            if (!operation) {
                return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            }

            let handler;
            try {
                handler = this.core.getHandler(operation.type);
            } catch (e) {
                return { success: false, message: `No handler for '${operation.type}': ${e.message}`, status: 'warning' };
            }

            const params = this.parameterManager.getAllParameters(operationId);

            // Task ownership lives HERE: every entry point into generation
            // (handleAction, EasyShape bucket flows) funnels through
            // runGeneration, so this is the one begin/end pair. Progress is
            // forwarded STRUCTURED ({frac,label}); StatusManager formats.
            // REVIEW - EasyTrace5000 should be updated for this as well.
            const sm = this.ui.statusManager;
            const taskId = sm?.beginTask?.(
                this.getSpinnerLabel?.('geometry', operation.type) || 'Generating');
            const onProgress = (p) => sm?.tick?.(taskId, p);

            // Tool number is the operator's responsibility and it is taken
            // HERE, at generation, not at export. Scope matters: the check
            // must ask whether toolNumber applies to THIS operation type, not
            // whether it exists in the profile at all. Stencil is not in
            // toolNumber's operationTypes, so loadFromOperation skips the key,
            // getAllParameters returns undefined, and a global check blocks
            // stencil generation outright.
            const toolNumDef = this.parameterManager.parameterDefinitions.toolNumber;
            // In multi-tool drilling the sidebar's number is hidden and the table
            // carries one per size, so the gate that applies is describeTable's,
            // not this one.
            const multiToolDrill = 'drill' === operation.type && true === params.drillMultiTool;
            const toolNumApplies = toolNumDef && !multiToolDrill
                && (!toolNumDef.operationTypes || toolNumDef.operationTypes.includes(operation.type));
            if (toolNumApplies) {
                const toolNum = Number(params.toolNumber);
                if (!Number.isInteger(toolNum) || toolNum < 1) {
                    if (taskId != null) sm?.endTask?.(taskId);
                    return {
                        success: false,
                        status: 'warning',
                        message: 'Enter a tool number (the T word your controller ' +
                            'receives) before generating. If your machine has no ' +
                            'tool changer, 1 is correct.'
                    };
                }
            }

            // Let the overlay paint before any main-thread-blocking work.
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            try {
                const result = await handler.orchestrateGeneration(
                    operation, params, this.core, { onProgress });

                // An operation with no strategy stage has no second button to
                // build the preview artifact, and preview.ready is the export
                // gate isExportReady and executeExport both read. Route it
                // through runPreview rather than core.generateCNCPreview so
                // the 3D refresh below happens for both paths.
                const { stages, artifacts } = this.getOperationContext(operation.type);
                if (result?.success) {
                    this.core.stampArtifact(operationId, 'offsets');
                    // A chain that declares a preview artifact but no stage to build
                    // it from has no second button, so build it here. A chain that
                    // declares no preview must not get one: stamping an artifact the
                    // chain does not list hides the offsets layer behind a node that
                    // is never drawn.
                    if (artifacts.includes('preview') && !stages.includes('strategy')) await this.runPreview(operationId);
                }
                return this.withDepthWarning(result, operation, params);
            } catch (e) {
                console.error(`[BaseOperationPanel] Generation failed for ${operation.type}:`, e);
                return { success: false, message: `Generation failed: ${e.message}`, status: 'error' };
            } finally {
                sm?.endTask?.(taskId);
                // Never leave a UI closure retained on the operation object.
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
            const operation = this.core.getOperation(operationId);
            if (!operation) {
                return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            }

            const params = this.parameterManager.getAllParameters(operationId) || {};

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
                    console.warn(`[Toolpaths] ${operationId}:\n  ${warnings.join('\n  ')}`);
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

        /* Read-only job summary for the output stage. The modal owns file layout,
        ordering and tool changes, and the stage's action button opens it. */
        createOutputBlock(operation) {
            const section = document.createElement('div');
            section.className = 'property-section';
            const h3 = document.createElement('h3');
            h3.textContent = 'Output';
            section.appendChild(h3);

            const tp = this.core.getToolpaths?.(operation.id);
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
            const operation = this.core.getOperation(operationId);
            if (!operation) {
                return { success: false, message: `Operation ${operationId} not found`, status: 'error' };
            }

            if (!operation.offsets || operation.offsets.length === 0) {
                return { success: false, message: 'Generate geometry first', status: 'warning' };
            }

            const success = this.core.generateCNCPreview(operationId);
            if (!success) {
                return { success: false, message: 'Preview generation failed (check tool diameter)', status: 'error' };
            }
            this.core.stampArtifact(operationId, 'preview');

            operation.exportReady = true;
            return this.withDepthWarning(
                { success: true, message: 'Preview generated', status: 'success' },
                operation, this.parameterManager.getAllParameters(operationId)
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

            const deepestZ = this.core.resolveSurfaceZ(operation) - Math.abs(params.cutDepth);

            if (deepestZ < maxSafe) {
                return `cut reaches Z ${deepestZ.toFixed(2)}mm, past the machine's max ` +
                    `safe depth (${maxSafe}mm). Check stock thickness and Z-zero.`;
            }
            return null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Shared UI Builders
        // ═══════════════════════════════════════════════════════════════

        groupByCategory(params) {
            const groups = {};
            for (const param of params) {
                const cat = param.category || 'general';
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(param);
            }
            return groups;
        }

        /**
         * ui.categories values are either a label string or { label }.
         */
        getCategoryTitle(category) {
            const entry = this.appProfile?.ui?.categories?.[category];
            const label = 'string' == typeof entry ? entry : entry?.label;
            return label || category.charAt(0).toUpperCase() + category.slice(1);
        }

        /**
         * Anything the profile does not declare falls to the end, in the order it
         * was met - sort is stable, so undeclared keys keep their relative order.
         */
        orderCategories(keys) {
            const declared = Object.keys(this.appProfile?.ui?.categories || {});
            const rank = k => { const i = declared.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
            return keys.slice().sort((a, b) => rank(a) - rank(b));
        }

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
         * The card's whole purpose is the per-size table, which only exists
         * when the app declares drillMultiTool. EasyShape does not, so it
         * rendered a permanently disabled Configure button whose tooltip
         * named a checkbox that is not in its profile. Keyed on the
         * parameter, not the app: declaring it is all Batch C has to do.
         */
        supportsDrillTooling() {
            return !!this.parameterManager?.parameterDefinitions?.drillMultiTool;
        }

        /**
         * Drill tooling card. The mode itself is the drillMultiTool checkbox in
         * the form above - this card only reports what that choice means and
         * opens the table. The Configure button is present in both modes so the
         * surface never moves; it is inert in single-tool mode because the table
         * is not read there.
         */
        createDrillToolingCard(operation, settings, stage) {
            const info = DrillHandler.describeTable(operation, settings);
            const multiTool = 'perSize' === info.mode;

            const section = document.createElement('div');
            section.className = 'property-section drill-tooling-card';

            const h3 = document.createElement('h3');
            h3.textContent = this.lang?.get('drill.tooling.title', 'Drill Tooling') || 'Drill Tooling';
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
            detail.textContent = multiTool
                ? (info.numbers.length > 0
                    ? `Tools: ${info.numbers.map(n => `T${n}`).join(', ')}`
                    : 'No tool numbers assigned yet.')
                : 'Every size is cut with the operation tool selected above.';
            section.appendChild(detail);

            if (info.reason) {
                const warn = document.createElement('div');
                warn.className = 'summary-line summary-warning';
                warn.textContent = info.reason;
                section.appendChild(warn);
            }
            if (info.note) {
                const hint = document.createElement('div');
                hint.className = 'summary-line summary-secondary';
                hint.textContent = info.note;
                section.appendChild(hint);
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn btn--block ' + (multiTool ? 'btn--primary' : 'btn--secondary');
            button.textContent = this.lang?.get('drill.tooling.configure', 'Configure Drill Tooling...')
                || 'Configure Drill Tooling...';
            button.disabled = !multiTool || 0 === info.rows.length;
            button.title = multiTool
                ? (info.rows.length
                    ? 'Assign a tool, a T number and a strategy per hole size.'
                    : 'No hole sizes detected yet - generate once to build the table.')
                : 'Enable Multi-Tool Drilling to assign a tool per hole size.';
            // The card renders at geometry AND strategy, and the modal shows
            // only that stage's columns: the cutter belongs to geometry because
            // changing it stales the operation, feeds and T numbers to strategy
            // because they resolve at translation. Same split GEOMETRY_FIELDS
            // already enforces on the write path.
            button.addEventListener('click', () => {
                this.ui.ctrl.modalManager?.showModal('drillTooling', {
                    operationId: operation.id,
                    stage: stage || 'geometry',
                    // Full re-render: a modal edit can change the field set and
                    // whether Generate is allowed, so swapping the card alone
                    // would leave two of those three stale.
                    onChange: () => this.refreshOperationPanel(operation)
                });
            });
            section.appendChild(button);

            return section;
        }

        /**
         * Re-renders the form after a tooling change. Subclasses override.
         */
        refreshOperationPanel(operation) {}

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
         * onToolpathSuccess, onStageTransition, onExportStage.
         */
        async handleAction() {
            this.saveCurrentState();
            const opId = this.currentOperationId;
            const stage = this.currentStage;
            const operation = this.resolveCurrentOperation();
            if (!operation) return;

            const opType = this.resolveOperationType(operation);
            const machineClass = this.getMachineClass(opType);
            const yieldToRender = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

            const advance = () => {
                const next = this.parameterManager.getNextStage(stage, opType, machineClass);
                if (!next) return;
                setTimeout(() => { this.switchStage(next); this.onStageTransition(next); }, D.ui.timing.uiTransitionDelay);
            };

            // Every chain terminates in the job modal. Per-operation G-code was a
            // second producer for the same file with none of the modal's ordering,
            // tool-change or split-drill context.
            if ('output' === stage) {
                this.onExportStage(opId, operation);
                return;
            }

            const ACTIONS = {
                geometry: { run: () => this.runGeneration(opId), after: id => this.onGenerationSuccess(id, operation), spinner: null },
                strategy: { run: () => this.runPreview(opId), after: id => this.onPreviewSuccess(id, operation), spinner: 'Generating preview...' },
                machine: { run: () => this.runToolpaths(opId), after: id => this.onToolpathSuccess(id, operation), spinner: 'Calculating toolpaths...' }
            };

            const action = ACTIONS[stage];
            if (!action) return;

            const spinner = this.getSpinnerLabel?.(stage, opType) || action.spinner;
            if (spinner) { this.ui.showCanvasSpinner?.(spinner); await yieldToRender(); }
            try {
                const result = await action.run();
                this.ui.setStatus(result.message, result.status);
                if (result.success) { await action.after(opId); advance(); }
                else if ('geometry' === stage) this.onGenerationFailure(opId, operation, stage);
            } catch (e) {
                console.error(`[${this.constructor.name}] ${stage} failed:`, e);
                this.ui.setStatus(`${stage} failed: ${e.message}`, 'error');
            } finally {
                if (spinner) this.ui.hideCanvasSpinner?.();
            }
            this.returnFocusToTree();
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
        onGenerationFailure(opId, operation, stage) {} // EasyTrace5000 needs the stage, EasyShape5000 does not.

        /** Called after successful preview. Update tree, renderer, etc. */
        async onPreviewSuccess(opId, operation) {}

        /** Called when stage transitions */
        onStageTransition(newStage) {}

        /** Toolpaths just landed. Apps refresh their tree and the 3D view. */
        async onToolpathSuccess(opId, operation) {}

        /** Opens the job export modal. */
        onExportStage(opId, operation) {}

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