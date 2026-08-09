/*!
 * @file        ui/ui-parameter-manager.js
 * @description Parameter input management, validation and form rendering.
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
    const validationRules = C.ui.validation;

    class ParameterManager {
        constructor(core) {
            this.core = core;

            // Parameter definitions start empty, populated by the app controller
            this.parameterDefinitions = {};

            // State storage - persists across operation/stage switches
            this.operationStates = new Map();
            this.dirtyFlags = new Map();

            // Active state
            this.currentOperationId = null;
            this.currentStage = null;

            this.validators = {};

            this.changeListeners = new Set();

            this.definitionsSource = 'empty';

            // Capability gates for individual <option>s, keyed by the
            // `requiresCapability` string a profile option declares.
            // { 'rotary.indexed': { ok: false, reason: '…' } }
            // A key with no entry is permissive: an unknown capability must
            // never silently remove a control.
            this.optionGates = {};
        }

        /**
         * Replaces parameter definitions with an external set and rebuilds
         * validators. Used by EasyShape to load app-specific definitions
         * from a JSON file instead of the hardcoded EasyTrace set.
         */
        setDefinitions(definitions) {
            this.parameterDefinitions = definitions;
            this.validators = this.initializeValidators();
            this.operationStates.clear();
            this.dirtyFlags.clear();
            this.definitionsSource = 'external';
        }

        /**
         * Loads parameter definitions from a JSON URL. Returns true on success.
         */
        async loadDefinitionsFromURL(url) {
            try {
                const resp = await fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                // Strip meta key if present
                const defs = {};
                for (const [k, v] of Object.entries(json)) {
                    if (k.startsWith('_')) continue;
                    defs[k] = v;
                }
                this.setDefinitions(defs);
                this.debug(`Loaded ${Object.keys(defs).length} definitions from ${url}`);
                return true;
            } catch (e) {
                console.error(`[ParameterManager] Failed to load definitions from ${url}:`, e);
                return false;
            }
        }

        initializeValidators() {
            // Dynamically build validator based on the definitions, which are based on the config.
            const validators = {};
            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (def.type === 'number') {
                    // Create a validation function for this number
                    validators[name] = (val) => {
                        const num = parseFloat(val);
                        if (isNaN(num)) return { success: false, error: `${def.label} must be a number` };

                        if (def.min !== undefined && num < def.min) {
                            return { success: false, error: `${def.label} must be at least ${def.min}`, correctedValue: def.min };
                        }
                        if (def.max !== undefined && num > def.max) {
                            return { success: false, error: `${def.label} must be no more than ${def.max}`, correctedValue: def.max };
                        }
                        return { success: true, value: num };
                    };
                }
                // Add more validators for 'select', 'checkbox' etc. if needed
                // REVIEW - Are they needed?
            }
            return validators;
        }

        /**
         * Updates validator constraints based on the active machine profile.
         * Called when the user changes the Roland machine model or switches post-processor.
         */
        updateMachineConstraints(machineProfile, postProcessor) {
            const isRoland = postProcessor === 'roland';

            // Update spindle speed constraints from profile
            if (machineProfile.spindleRange) {
                const def = this.parameterDefinitions.spindleSpeed;
                def.min = machineProfile.spindleRange.min;
                def.max = machineProfile.spindleRange.max;

                // Regenerate validator
                this.validators.spindleSpeed = (val) => {
                    const num = parseFloat(val);
                    if (isNaN(num)) return { success: false, error: `${def.label} must be a number` };
                    if (num < def.min) return { success: false, error: `${def.label} must be at least ${def.min}`, correctedValue: def.min };
                    if (num > def.max) return { success: false, error: `${def.label} must be no more than ${def.max}`, correctedValue: def.max };
                    return { success: true, value: num };
                };
            } // Roland without RC: fixed/manual spindle - no validator override needed.
            

            // Update feed rate constraints from profile max speeds
            if (isRoland && machineProfile.maxFeedXY) {
                const maxMmMin = machineProfile.maxFeedXY * 60;

                const feedDef = this.parameterDefinitions.feedRate;
                feedDef.max = maxMmMin;
                this.validators.feedRate = (val) => {
                    const num = parseFloat(val);
                    if (isNaN(num)) return { success: false, error: `${feedDef.label} must be a number` };
                    if (num < feedDef.min) return { success: false, error: `${feedDef.label} must be at least ${feedDef.min}`, correctedValue: feedDef.min };
                    if (num > feedDef.max) return { success: false, error: `${feedDef.label} must be no more than ${feedDef.max}`, correctedValue: feedDef.max };
                    return { success: true, value: num };
                };

                const plungeDef = this.parameterDefinitions.plungeRate;
                const maxPlungeMmMin = (machineProfile.maxFeedZ || machineProfile.maxFeedXY) * 60;
                plungeDef.max = maxPlungeMmMin;
                this.validators.plungeRate = (val) => {
                    const num = parseFloat(val);
                    if (isNaN(num)) return { success: false, error: `${plungeDef.label} must be a number` };
                    if (num < plungeDef.min) return { success: false, error: `${plungeDef.label} must be at least ${plungeDef.min}`, correctedValue: plungeDef.min };
                    if (num > plungeDef.max) return { success: false, error: `${plungeDef.label} must be no more than ${plungeDef.max}`, correctedValue: plungeDef.max };
                    return { success: true, value: num };
                };
            } else if (!isRoland) {
                // Switching away from Roland - restore default validation limits
                this.restoreDefaultValidators(['feedRate', 'plungeRate', 'spindleSpeed']);
            }

            // Re-validate all currently loaded operations against new constraints
            for (const [opId, state] of this.operationStates) {
                for (const [stage, params] of Object.entries(state)) {
                    for (const [name, value] of Object.entries(params)) {
                        if (this.validators[name]) {
                            const result = this.validators[name](value);
                            if (result.correctedValue !== undefined) {
                                state[stage][name] = result.correctedValue;
                                this.markDirty(opId, stage);
                            }
                        }
                    }
                }
            }

            this.debug(`Machine constraints updated for ${machineProfile.label || 'unknown'}`);
        }

        // Restores validators to their original config-based limits.
        restoreDefaultValidators(paramNames) {
            for (const name of paramNames) {
                const def = this.parameterDefinitions[name];
                if (!def || def.type !== 'number') continue;

                // Restore min/max from original config spread
                if (validationRules[name]) {
                    if (validationRules[name].min !== undefined) def.min = validationRules[name].min;
                    if (validationRules[name].max !== undefined) def.max = validationRules[name].max;
                }

                // Regenerate validator from restored definition
                this.validators[name] = (val) => {
                    const num = parseFloat(val);
                    if (isNaN(num)) return { success: false, error: `${def.label} must be a number` };
                    if (def.min !== undefined && num < def.min) {
                        return { success: false, error: `${def.label} must be at least ${def.min}`, correctedValue: def.min };
                    }
                    if (def.max !== undefined && num > def.max) {
                        return { success: false, error: `${def.label} must be no more than ${def.max}`, correctedValue: def.max };
                    }
                    return { success: true, value: num };
                };
            }
        }

        /**
         * Merges capability gates and returns the new map. Callers own the
         * key namespace; MachineSettingsUI owns 'rotary.*'.
         */
        setOptionGates(gates) {
            this.optionGates = { ...this.optionGates, ...gates };
            return this.optionGates;
        }
        
        // Get or create state for an operation
        getOperationState(operationId) {
            if (!this.operationStates.has(operationId)) {
                this.operationStates.set(operationId, {});
            }
            return this.operationStates.get(operationId);
        }

        // Get parameters for current context
        getParameters(operationId, stage) {
            const state = this.getOperationState(operationId);
            if (!state[stage]) state[stage] = {};
            return state[stage];
        }

        setParameter(operationId, stage, name, value) {
            const state = this.getOperationState(operationId);
            if (!state[stage]) state[stage] = {};

            // Check if validator exists
            if (this.validators[name]) {
                const result = this.validators[name](value);

                if (!result.success) {
                    this.debug(`Invalid value for ${name}: ${value}. ${result.error}`);
                    // If validation failed but provided a corrected value (clamping), set that corrected value.
                    if (result.correctedValue !== undefined) {
                        state[stage][name] = result.correctedValue;
                        this.markDirty(operationId, stage);
                        this.notifyChange(operationId, stage, name, result.correctedValue);
                        // Return the error and the value it was changed to
                        return { success: false, error: result.error, correctedValue: result.correctedValue };
                    }
                    // If no corrected value, return the failure
                    return { success: false, error: result.error, correctedValue: state[stage][name] }; // Return old value
                }

                // Validation succeeded, update the value
                value = result.value;
            }

            // Non-validated type (e.g., checkbox, select) or valid number
            state[stage][name] = value;
            this.markDirty(operationId, stage);
            this.notifyChange(operationId, stage, name, value);

            return { success: true, value: value };
        }

        markDirty(operationId, stage) {
            if (!this.dirtyFlags.has(operationId)) {
                this.dirtyFlags.set(operationId, new Set());
            }
            this.dirtyFlags.get(operationId).add(stage);
        }

        // Set multiple parameters (less used by UI, more by loading logic)
        setParameters(operationId, stage, params) {
            const state = this.getOperationState(operationId);
            if (!state[stage]) state[stage] = {};
            
            for (const [name, value] of Object.entries(params)) {
                this.setParameter(operationId, stage, name, value);
            }
        }

        // Get all parameters for an operation (merged across stages)
        getAllParameters(operationId) {
            const op = this.core?.getOperation?.(operationId);
            if (op && !this.operationStates.has(operationId)) {
                this.loadFromOperation(op);
            }
            const state = this.getOperationState(operationId);
            const merged = {};
            for (const stageParams of Object.values(state)) {
                Object.assign(merged, stageParams);
            }
            return merged;
        }

        // Commit parameters to operation object
        commitToOperation(operation) {
            if (!operation) return;

            if (!operation.userOverrides) {
                operation.userOverrides = new Set();
            } else if (Array.isArray(operation.userOverrides)) {
                operation.userOverrides = new Set(operation.userOverrides);
            }

            const allLiveParams = this.getAllParameters(operation.id);
            if (!operation.settings) operation.settings = {};

            // Persist ONLY parameters explicitly modified by the user
            for (const [name, value] of Object.entries(allLiveParams)) {
                if (operation.userOverrides.has(name)) {
                    operation.settings[name] = value;
                } else {
                    // Purge non-overridden keys so stale profile defaults aren't locked in settings
                    delete operation.settings[name];
                }
            }

            // Convert Set to Array for JSON persistence
            operation.userOverrides = Array.from(operation.userOverrides);

            this.dirtyFlags.delete(operation.id);
            this.debug(`Committed explicit overrides (${operation.userOverrides.length}) to operation ${operation.id}`);
        }

        /**
         * Loads parameters from an operation's settings into the manager's state.
         */
        loadFromOperation(operation) {
            if (!operation) return;

            // Ensure operation.userOverrides is a Set
            if (!operation.userOverrides) {
                operation.userOverrides = new Set();
            } else if (Array.isArray(operation.userOverrides)) {
                operation.userOverrides = new Set(operation.userOverrides);
            }

            const opSettings = operation.settings || {};
            // Get the operation-specific config defaults (e.g., passes for "isolation")
            const defaults = this.getDefaults(operation.type);

            // Re-build fresh state for this operation
            const state = {};
            this.operationStates.set(operation.id, state);

            // Iterate over ALL parameter definitions
            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (!def.stage) continue; // Skip non-parameter definitions
                if (def.operationTypes && !def.operationTypes.includes(operation.type)) continue;

                let value;

                // If user explicitly modified this parameter, use saved override
                if (operation.userOverrides.has(name) && opSettings[name] !== undefined) {
                    value = opSettings[name];
                } else {
                    // Otherwise dynamically resolve from current defaults -> hardcoded default
                    value = defaults[name] ?? def.default;
                }

                // If a value was found (from any source), set it in the manager.
                // This validates/clamps the value on load.
                if (value !== undefined) {
                    const validator = this.validators[name];
                    const result = validator ? validator(value) : { success: true, value };
                    const finalValue = result.correctedValue !== undefined ? result.correctedValue : result.value;

                    if (!state[def.stage]) state[def.stage] = {};
                    state[def.stage][name] = finalValue;
                }
            }

            // Laser spot size synchronization
            if (this.core.settings?.laser?.spotSize !== undefined) {
                if (!state.geometry) state.geometry = {};
                state.geometry.laserSpotSize = this.core.settings.laser.spotSize;
            }

            // Clear dirty flag after a fresh load
            this.dirtyFlags.delete(operation.id);
        }

        // Check if operation has unsaved changes
        hasUnsavedChanges(operationId) {
            return this.dirtyFlags.has(operationId);
        }

        // Get parameters filtered by stage, operation type, and pipeline.
        getStageParameters(stage, operationType, pipelineType) {
            const params = [];
            const isLaser = pipelineType === 'laser' || pipelineType === 'hybrid';

            const exportFormat = this.core.settings?.laser?.exportFormat;

            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                // Stage matching: 'export_summary' has no parameters - it's a display-only stage
                if (stage === 'export_summary') continue;
                if (def.stage !== stage) continue;


                // Operation type filtering
                if (def.operationTypes && !def.operationTypes.includes(operationType)) continue;

                // Pipeline filtering: laser params only in laser mode, CNC params only in CNC mode.
                // Stencil params pass through regardless of pipeline.
                const isStencilParam = def.operationTypes && def.operationTypes.includes('stencil');
                if (!isStencilParam) {
                    if (def.pipelineType === 'laser' && !isLaser) continue;
                    if (!def.pipelineType && isLaser) continue;
                }

                // Hide clearing-related params if exporting to PNG
                if (isLaser && exportFormat === 'png') {
                    if (name === 'laserClearStrategy' || name === 'laserSpacingMode' ||
                        name === 'laserStepOver' || name === 'laserLinesPerCm' ||
                        name === 'laserLinesPerInch' || name === 'laserHatchAngle') {
                        continue;
                    }
                }

                const resolved = { name, ...def };
                params.push(resolved);
            }

            return params;
        }

        /**
         * Valid stages for a pipeline + operation type.
         *
         * The middle stage is DERIVED, never declared: it exists only while
         * some parameter is filed under it. A 3D operation consumes its whole
         * set at generation time, so the stage would otherwise render an empty
         * form behind a second button that computes nothing. File a
         * strategy-stage parameter against an operation type and the stage
         * comes back with no code change.
         */
        getStagesForPipeline(pipelineType, operationType) {
            if (pipelineType === 'laser' || operationType === 'stencil') {
                return ['geometry', 'export_summary'];
            }
            if (operationType &&
                this.getStageParameters('strategy', operationType, pipelineType).length === 0) {
                return ['geometry', 'machine'];
            }
            // CNC and hybrid use the standard three stages
            return ['geometry', 'strategy', 'machine'];
        }

        /**
         * Returns the next stage in the pipeline after the given one.
         * Returns null if the current stage is the last one.
         */
        getNextStage(currentStage, pipelineType, operationType) {
            const stages = this.getStagesForPipeline(pipelineType, operationType);
            const idx = stages.indexOf(currentStage);
            if (idx === -1 || idx >= stages.length - 1) return null;
            return stages[idx + 1];
        }

        // Validate all parameters for an operation
        validateOperation(operationId) {
            const params = this.getAllParameters(operationId);
            const errors = [];

            for (const [name, value] of Object.entries(params)) {
                if (this.validators[name]) {
                    const result = this.validators[name](value);
                    if (!result.success) {
                        errors.push({
                            parameter: name,
                            value: value,
                            message: result.error || `Invalid value for ${name}`
                        });
                    }
                }
            }

            return {
                valid: errors.length === 0,
                errors
            };
        }

        // Get default values for operation type
        getDefaults(operationType) {
            const defaults = {};

            // Ask the Tool Library for an appropriate starting tool via the core
            if (this.core.toolLibrary) {
                const tool = this.core.toolLibrary.getDefaultToolForOperation(operationType);
                if (tool) {
                    const toolDiam = this.core.toolLibrary.getToolDiameter(tool.id);
                    defaults.tool = tool.id;
                    defaults.toolDiameter = toolDiam;

                    // Support custom tool selection keys like engraveTool or vcarveTool
                    for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                        if (name.endsWith('Tool') && def.operationTypes && def.operationTypes.includes(operationType)) {
                            defaults[name] = tool.id;
                        }
                    }

                    // Pull tool geometry parameters so specialized operation fields populate
                    if (tool.geometry) {
                        if (tool.geometry.tipDiameter !== undefined) {
                            defaults.vbitTipDiameter = tool.geometry.tipDiameter;
                        }
                        if (tool.geometry.angle !== undefined) {
                            defaults.vbitAngle = tool.geometry.angle;
                        }
                        if (tool.geometry.cornerRadius !== undefined) {
                            defaults.reliefCornerRadius = tool.geometry.cornerRadius;
                            defaults.rotaryCornerRadius = tool.geometry.cornerRadius;
                        }
                        if (tool.geometry.tipType !== undefined) {
                            defaults.reliefToolShape = tool.geometry.tipType;
                            defaults.rotaryToolShape = tool.geometry.tipType;
                        }
                    }

                    // Pull cutting parameters from the tool so form fields populate
                    if (tool.cutting) {
                        if (tool.cutting.feedRate !== undefined) defaults.feedRate = tool.cutting.feedRate;
                        if (tool.cutting.plungeRate !== undefined) defaults.plungeRate = tool.cutting.plungeRate;
                        if (tool.cutting.spindleSpeed !== undefined) defaults.spindleSpeed = tool.cutting.spindleSpeed;
                        if (tool.cutting.spindleDwell !== undefined) defaults.spindleDwell = tool.cutting.spindleDwell;
                        if (tool.cutting.cutDepth !== undefined) defaults.cutDepth = tool.cutting.cutDepth;
                        if (tool.cutting.depthPerPass !== undefined) defaults.depthPerPass = tool.cutting.depthPerPass;
                    }
                }
            }

            // Handle specific pipeline injections (Laser/Stencil)
            const settings = this.core.settings || {};
            if (settings.laser) {
                defaults.laserSpotSize = settings.laser.spotSize;
                defaults.laserExportFormat = settings.laser.exportFormat;
                defaults.laserExportDPI = settings.laser.exportDPI;
            }

            // Check app profile for operation-specific overrides
            const profileDefaults = this.core.appProfile?.operationDefaults?.[operationType];
            if (profileDefaults) {
                Object.assign(defaults, profileDefaults);
            }

            return defaults;
        }

        addChangeListener(callback) {
            this.changeListeners.add(callback);
        }

        removeChangeListener(callback) {
            this.changeListeners.delete(callback);
        }

        notifyChange(operationId, stage, name, value) {
            for (const listener of this.changeListeners) {
                listener({ operationId, stage, name, value });
            }
        }

        exportState() {
            const state = {};
            for (const [opId, opState] of this.operationStates) {
                state[opId] = JSON.parse(JSON.stringify(opState));
            }
            return state;
        }

        importState(state) {
            this.operationStates.clear();
            this.dirtyFlags.clear();

            for (const [opId, opState] of Object.entries(state)) {
                this.operationStates.set(opId, opState);
            }
        }

        clearOperation(operationId) {
            this.operationStates.delete(operationId);
            this.dirtyFlags.delete(operationId);
        }

        // ═══════════════════════════════════════════════════════════════
        // Form Rendering
        // ═══════════════════════════════════════════════════════════════

        /**
         * Creates a complete .property-field element from a parameter definition.
         *
         * @param {Object}   param              Parameter definition
         * @param {*}        value              Current value
         * @param {Object}   [options]
         * @param {string}   [options.idPrefix='op-']  DOM id prefix
         * @param {string}   [options.opType]          Operation type (for tool filtering)
         * @param {Object}   [options.toolLibrary]     ToolLibrary instance
         * @param {Object}   [options.lang]            LanguageManager instance
         * @param {Function} [options.onChange]         Callback(paramName, newValue, inputElement)
         * @returns {HTMLElement} The .property-field div
         */
        static createField(param, value, options = {}) {
            const field = document.createElement('div');
            field.className = 'property-field';
            field.dataset.param = param.name;
            if (param.conditional) field.dataset.conditional = param.conditional;
            // Fallback for applyOptionGates when the current selection becomes
            // unavailable.
            if (param.default !== undefined) field.dataset.default = String(param.default);

            const inputId = `${options.idPrefix || 'op-'}${param.name}`;

            const label = document.createElement('label');
            label.setAttribute('for', inputId);

            const lang = options.lang;
            const labelText = lang ? lang.get(`parameters.${param.name}`, param.label) : param.label;
            label.textContent = labelText;
            field.appendChild(label);

            if (lang && lang.has(`tooltips.parameters.${param.name}`)) {
                const helpText = lang.get(`tooltips.parameters.${param.name}`);
                if (helpText && window.TooltipManager) {
                    window.TooltipManager.attachWithIcon(label, { title: labelText, text: helpText }, { showOnFocus: true });
                }
            }

            let inputEl;

            switch (param.type) {
                case 'number': {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'input-unit';
                    inputEl = document.createElement('input');
                    inputEl.type = 'number';
                    inputEl.id = inputId;
                    inputEl.value = value ?? 0;
                    if (param.min !== undefined) inputEl.min = param.min;
                    if (param.max !== undefined) inputEl.max = param.max;
                    if (param.step !== undefined) inputEl.step = param.step;
                    if (param.unit) inputEl.setAttribute('aria-label', `${labelText} in ${param.unit}`);
                    if (param.readOnly) { inputEl.readOnly = true; inputEl.classList.add('input-readonly'); }

                    inputEl.addEventListener('input', () => inputEl.classList.remove('input-error'));

                    wrapper.appendChild(inputEl);
                    if (param.unit) {
                        const unit = document.createElement('span');
                        unit.className = 'unit';
                        unit.textContent = param.unit;
                        unit.setAttribute('aria-hidden', 'true');
                        wrapper.appendChild(unit);
                    }
                    field.appendChild(wrapper);
                    break;
                }

                case 'select': {
                    inputEl = document.createElement('select');
                    inputEl.id = inputId;

                    const isToolSelect = param.name === 'tool' || param.name.endsWith('Tool');
                    if (isToolSelect && options.toolLibrary) {
                        ParameterManager.populateToolSelect(inputEl, options.opType, value, options.toolLibrary);
                    } else if (param.options) {
                        for (const opt of param.options) {
                            const o = document.createElement('option');
                            o.value = opt.value;
                            const optLabel = lang ? lang.get(`dropdowns.${opt.value}`, opt.label) : opt.label;
                            o.textContent = optLabel;
                            // Machine-capability gate, applied post-render by
                            // applyOptionGates - the value is unknown at field
                            // build time and changes with the post-processor.
                            if (opt.requiresCapability) o.dataset.requires = opt.requiresCapability;
                            if (String(opt.value) === String(value)) o.selected = true;
                            inputEl.appendChild(o);
                        }
                    }
                    field.appendChild(inputEl);
                    break;
                }

                case 'checkbox': {
                    const icon = label.querySelector('.tooltip-trigger');
                    if (icon) label.removeChild(icon);

                    label.className = 'checkbox-label';
                    label.removeAttribute('for');
                    label.textContent = '';

                    inputEl = document.createElement('input');
                    inputEl.type = 'checkbox';
                    inputEl.id = inputId;
                    inputEl.checked = !!value;

                    const span = document.createElement('span');
                    span.textContent = labelText;
                    label.appendChild(inputEl);
                    label.appendChild(span);

                    if (icon) {
                        icon.addEventListener('mousedown', e => e.stopPropagation());
                        icon.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });
                        label.appendChild(icon);
                    }
                    break;
                }
            }

            // A parameter can be present, documented and inert. Declaring
            // `disabled` in the profile is the honest state for a control
            // whose logic is unimplemented or unverified.
            if (param.disabled === true) {
                field.classList.add('property-field--disabled');
                field.title = 'Not available yet';
                if (inputEl) inputEl.disabled = true;
            } else if (inputEl && options.onChange) {
                const handleCommit = () => {
                    const val = param.type === 'checkbox' ? inputEl.checked
                        : param.type === 'number' ? (parseFloat(inputEl.value) || 0)
                        : inputEl.value;
                    options.onChange(param.name, val, inputEl);
                };
                inputEl.addEventListener('change', handleCommit);
            }

            return field;
        }

        /**
         * Populates a <select> with tools from the ToolLibrary.
         */
        static populateToolSelect(select, opType, selectedId, toolLibrary) {
            if (!toolLibrary || !toolLibrary.isLoaded) {
                select.innerHTML = '<option>No tools loaded</option>';
                select.disabled = true;
                return;
            }
            const tools = toolLibrary.getToolsForOperation(opType) || [];
            if (tools.length === 0) {
                select.innerHTML = '<option>No compatible tools</option>';
                select.disabled = true;
                return;
            }
            for (const tool of tools) {
                const opt = document.createElement('option');
                opt.value = tool.id;
                const diam = toolLibrary.getToolDiameter(tool.id);
                opt.textContent = `${tool.name} (${diam}mm)`;
                if (tool.id === selectedId) opt.selected = true;
                select.appendChild(opt);
            }
        }

        /**
         * Shows/hides fields based on [data-conditional] attributes.
         * Supports: "paramName" (truthy), "!paramName" (falsy),
         * "paramName:val1,val2" (value match), "a && b" (compound).
         */
        static evaluateConditionals(container, values, gates = {}) {
            container.querySelectorAll('[data-conditional]').forEach(field => {
                const cond = field.dataset.conditional;
                let show = true;

                for (const clause of cond.split('&&')) {
                    const trimmed = clause.trim();
                    if (trimmed.includes(':')) {
                        const colonIdx = trimmed.indexOf(':');
                        const paramName = trimmed.substring(0, colonIdx);
                        const allowedValues = trimmed.substring(colonIdx + 1).split(',');
                        show = show && allowedValues.includes(String(values[paramName] ?? ''));
                    } else if (trimmed.startsWith('!')) {
                        show = show && !values[trimmed.slice(1)];
                    } else {
                        show = show && !!values[trimmed];
                    }
                }

                field.style.display = show ? '' : 'none';
            });

            ParameterManager.applyOptionGates(container, gates);
            ParameterManager.updateCannedCycleOptions(container, values);
        }

        /**
         * Disables <option>s whose declared `requiresCapability` the current
         * machine cannot satisfy, and re-selects the field default when the
         * live selection is one of them.
         *
         * The reset dispatches a real 'change', so it commits through
         * onParameterChange like any user edit - which is what writes the
         * corrected value into every parameter store and invalidates
         * generated geometry. A silent DOM-only reset would leave the
         * unsupported value in state and be restored on the next reload.
         *
         * A capability with no gate entry stays enabled.
         */
        // REVIEW - This isn't locking the UI options in some conditions, like possibly when loading postprocessor from storage and some UI updates that don't trigger the gate check prior to refreshing html.
        static applyOptionGates(container, gates) {
            if (!gates) return;

            container.querySelectorAll('option[data-requires]').forEach(opt => {
                const gate = gates[opt.dataset.requires];
                const blocked = gate ? gate.ok === false : false;
                if (opt.dataset.label === undefined) opt.dataset.label = opt.textContent;
                opt.disabled = blocked;
                opt.title = blocked ? (gate.reason || '') : '';
                opt.textContent = blocked
                    ? `${opt.dataset.label} (incompatible)`
                    : opt.dataset.label;
            });

            container.querySelectorAll('select').forEach(select => {
                if (!select.querySelector('option[data-requires]')) return;
                const current = select.selectedOptions[0];
                if (!current || !current.disabled) return;

                const field = select.closest('.property-field');
                const fallback = field?.dataset.default;
                const target = Array.from(select.options).find(o => o.value === fallback && !o.disabled)
                    || Array.from(select.options).find(o => !o.disabled);
                if (!target) return;

                select.value = target.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
        }

        /**
         * Dynamically filters canned cycle options based on peck/dwell values.
         */
        static updateCannedCycleOptions(container, values) {
            const wrapper = container.querySelector('.property-field[data-param="cannedCycle"]');
            if (!wrapper) return;

            const cannedSelect = wrapper.querySelector('select');
            if (!cannedSelect) return;

            const peckDepth = values.peckDepth || 0;
            const dwellTime = values.dwellTime || 0;
            let currentStillValid = false;

            Array.from(cannedSelect.options).forEach(opt => {
                const val = opt.value;
                let visible = true;

                if (val === 'G82' && dwellTime <= 0) visible = false;
                if ((val === 'G83' || val === 'G73') && peckDepth <= 0) visible = false;

                opt.style.display = visible ? '' : 'none';
                opt.disabled = !visible;

                if (visible && opt.value === cannedSelect.value) currentStillValid = true;
            });

            if (!currentStillValid) {
                cannedSelect.value = 'none';
                cannedSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        /**
         * Resolves a tool diameter from a tool ID.
         * Returns the diameter or null if not found.
         */
        static resolveToolDiameter(toolId, toolLibrary) {
            if (!toolLibrary) return null;
            return toolLibrary.getToolDiameter(toolId);
        }

        debug(message, data = null) {
            if (D.debug.enabled) {
                if (data !== null) {
                    console.log(`[ParameterManager] ${message}`, data);
                } else {
                    console.log(`[ParameterManager] ${message}`);
                }
            }
        }
    }

    window.ParameterManager = ParameterManager;
})();