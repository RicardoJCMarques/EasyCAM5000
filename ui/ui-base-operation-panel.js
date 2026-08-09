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

        /** @returns {string} 'cnc' | 'laser' | 'hybrid' */
        getPipelineType() { return 'cnc'; }

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

        /** Called when millHoles checkbox toggles - requires full panel rebuild */
        onMillHolesToggle(value) {}

        /** Called after a successful parameter change to check if generated geometry should be invalidated */
        checkInvalidation(paramName) {}

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
            const pipelineType = this.getPipelineType();
            const stageParams = pm.getStageParameters(stage, opType, pipelineType);
            const groups = this.groupByCategory(stageParams);
            const prefix = this.getIdPrefix();

            for (const [cat, catParams] of Object.entries(groups)) {
                const section = document.createElement('div');
                section.className = 'property-section';

                const h3 = document.createElement('h3');
                h3.textContent = this.getCategoryTitle(cat);
                section.appendChild(h3);

                for (const p of catParams) {
                    const val = values[p.name] !== undefined ? values[p.name] : p.default;
                    section.appendChild(ParameterManager.createField(p, val, {
                        idPrefix: prefix,
                        opType,
                        toolLibrary: this.toolLibrary,
                        lang: this.lang,
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

            // Tool diameter resolution
            if ((name === 'tool' || name.endsWith('Tool')) && this.toolLibrary) {
                const resolvedDiam = ParameterManager.resolveToolDiameter(value, this.toolLibrary);
                if (resolvedDiam !== null) {
                    pm.setParameter(this.currentOperationId, getStage('toolDiameter'), 'toolDiameter', resolvedDiam);
                    const diamInput = document.getElementById(`${this.getIdPrefix()}toolDiameter`);
                    if (diamInput) diamInput.value = resolvedDiam;
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

            // millHoles requires full panel rebuild (switches peck↔mill UI)
            if (name === 'millHoles') {
                clearTimeout(this.changeTimeout);
                this.saveCurrentState();
                return void this.onMillHolesToggle(value);
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
                const debounceDelay = CAMConfig.defaults.ui.timing.propertyDebounce;
                this.changeTimeout = setTimeout(() => this.saveCurrentState(), debounceDelay);
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

        getCurrentStage() {
            return this.currentStage;
        }

        clearProperties() {
            this.currentOperationId = null;
            this.currentStage = 'geometry';
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
            const operation = this.core.operations.find(op => op.id === operationId);
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
                const stages = this.parameterManager.getStagesForPipeline(
                    this.getPipelineType(), operation.type);
                if (result?.success && !stages.includes('strategy')) {
                    await this.runPreview(operationId);
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
         * Generates a CNC toolpath preview from existing offsets.
         * Returns { success, message, status }.
         */
        async runPreview(operationId) {
            const operation = this.core.operations.find(op => op.id === operationId);
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

            operation.exportReady = true;

            // preview.ready is what refresh3DPlans filters on, so this is the
            // only moment a new toolpath can reach the 3D plan layer. The
            // refresh is reentrancy-guarded and coalescing, so a generation-
            // side call and this one collapse into one pipeline run.
            this.ui.ctrl?.refresh3DPlans?.();

            return this.withDepthWarning(
                { success: true, message: 'Preview generated', status: 'success' },
                operation, this.parameterManager.getAllParameters(operationId));
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
         * check in the codebase is BasePostProcessor.validateCommand, which
         * runs per command at G-code emission and reaches the user as a
         * console.warn - after the file is written. surfaceZ mirrors
         * buildToolpathContext exactly; if the two ever diverge this warning
         * describes a depth the export never cuts.
         * @returns {string|null}
         */
        checkDepthLimits(operation, params) {
            if (params.cutDepth == null) return null;   // 3D ops own their depths
            const machine = this.core.settings?.machine;
            const maxSafe = machine?.heights?.maxSafeDepth;
            if (typeof maxSafe !== 'number') return null;

            const stock = machine.stock || {};
            const bedZero = stock.zeroReference && stock.zeroReference !== 'material'
                && operation.type !== 'rotary';
            const surfaceZ = bedZero ? (stock.thickness || 0) : 0;
            const deepestZ = surfaceZ - Math.abs(params.cutDepth);

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

        getCategoryTitle(category) {
            const titles = this.appProfile?.ui?.categories || {};
            return titles[category] || category.charAt(0).toUpperCase() + category.slice(1);
        }

        createActionButton(text, disabled = false) {
            const wrapper = document.createElement('div');
            wrapper.className = 'property-actions';

            const button = document.createElement('button');
            button.className = 'btn btn--primary btn--block';
            button.id = 'action-button';
            button.textContent = text;
            button.disabled = disabled;
            button.addEventListener('click', () => this.handleAction());

            wrapper.appendChild(button);
            return wrapper;
        }

        createWarningPanel(warnings) {
            const panel = document.createElement('div');
            panel.className = 'warning-panel';

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
            header.style.fontWeight = 'bold';
            header.style.marginBottom = 'var(--spacing-sm)';
            header.innerHTML = `${icon} ${unique.length} Warning${unique.length > 1 ? 's' : ''}`;
            panel.appendChild(header);

            const list = document.createElement('ul');
            list.style.margin = '0';
            list.style.paddingLeft = 'var(--spacing-md)';

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
         * Shared stage-based action dispatch. Subclasses override hooks:
         *   getActionStageLabel(stage, opType) - returns spinner text
         *   onGenerationSuccess(operationId)   - post-generation UI update
         *   onPreviewSuccess(operationId)      - post-preview UI update
         *   getExportModalOptions(opType)      - data for export modal
         */
        async handleAction() {
            this.saveCurrentState();

            const opId = this.currentOperationId;
            const stage = this.currentStage;
            const pipelineType = this.getPipelineType();

            // Resolve the operation (apps store it differently)
            const operation = this.resolveCurrentOperation();
            if (!operation) return;

            const opType = this.resolveOperationType(operation);
            const transitionDelay = D.layout.ui.transitionDelay;

            const yieldToRender = () => new Promise(resolve => {
                requestAnimationFrame(() => requestAnimationFrame(resolve));
            });

            if (stage === 'geometry') {
                // this.ui.showCanvasSpinner?.(this.getSpinnerLabel?.('geometry', opType) || 'Generating...');
                await yieldToRender(); // REVIEW - Is this still necessary now that the spinner is managed directly by the state manager?

                try {
                    const result = await this.runGeneration(opId);
                    this.ui.setStatus(result.message, result.status);

                    if (result.success) {
                        await this.onGenerationSuccess(opId, operation);
                        const nextStage = this.parameterManager.getNextStage(stage, pipelineType, opType);
                        if (nextStage) {
                            setTimeout(() => {
                                this.switchStage(nextStage);
                                this.onStageTransition(nextStage);
                            }, transitionDelay);
                        }
                    } else {
                        this.onGenerationFailure(opId, operation, stage);
                    }
                } catch (e) {
                    console.error(`[${this.constructor.name}] Generation failed:`, e);
                    this.ui.setStatus('Failed: ' + e.message, 'error');
                } finally {
                    this.ui.hideCanvasSpinner?.();
                }
                this.returnFocusToTree();
                return;
            }

            if (stage === 'strategy') {
                this.ui.showCanvasSpinner?.(this.getSpinnerLabel?.('strategy', opType) || 'Generating preview...');
                await yieldToRender();

                try {
                    const result = await this.runPreview(opId);
                    this.ui.setStatus(result.message, result.status);

                    if (result.success) {
                        await this.onPreviewSuccess(opId, operation);
                        setTimeout(() => {
                            this.switchStage('machine');
                            this.onStageTransition('machine');
                        }, transitionDelay);
                    }
                } catch (e) {
                    console.error(`[${this.constructor.name}] Preview failed:`, e);
                    this.ui.setStatus('Preview failed: ' + e.message, 'error');
                } finally {
                    this.ui.hideCanvasSpinner?.();
                }
                this.returnFocusToTree();
                return;
            }

            if (stage === 'machine' || stage === 'export_summary') {
                this.onExportStage(opId, operation);
            }
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

        /** Called when stage transitions (e.g., emit 'stageChanged'). */
        onStageTransition(newStage) {}

        /** Called at machine/export_summary stage. Open export modal. */
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