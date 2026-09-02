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

    class ParameterManager {
        constructor(core) {
            this.core = core;

            // Parameter definitions start empty, populated by the app controller
            this.parameterDefinitions = {};

            // State storage - persists across operation/stage switches
            this.operationStates = new Map();
            this.dirtyFlags = new Map();

            this.validators = {};

            this.changeListeners = new Set();

            this.baseRanges = {};

            this.definitionsSource = 'empty';

            // Capability gates for individual <option>s, keyed by the
            // `requiresCapability` string a profile option declares.
            // { 'rotary.indexed': { ok: false, reason: '…' } }
            // A key with no entry is permissive: an unknown capability must
            // never silently remove a control.
            this.optionGates = {};
        }

        /**
         * Replaces parameter definitions and rebuilds validators. Both apps
         * have their own set from profile-{trace,shape}.json.
         */
        setDefinitions(definitions) {
            this.parameterDefinitions = definitions;
            this.baseRanges = {};
            for (const [name, def] of Object.entries(definitions)) {
                if (!def) continue;
                // `.includes()` on a bare string matches substrings, so a future
                // drill/drillMill pair would silently cross-match.
                if ('string' == typeof def.operationTypes) def.operationTypes = [def.operationTypes];
                if ('number' === def.type) this.baseRanges[name] = { min: def.min, max: def.max };
            }
            this.validators = this.initializeValidators();
            this.operationStates.clear();
            this.dirtyFlags.clear();
        }

        /** Range validator bound to a definition, so min/max edits take effect live. */
        makeNumberValidator(def) {
            const msg = (key, fallback, tokens) => {
                const t = this.core?.lang?.format?.(`messages.validation.${key}`, tokens);
                if (t) return t;
                let out = fallback;
                for (const [k, v] of Object.entries(tokens)) {
                    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
                }
                return out;
            };
            return (val) => {
                if (def.nullable && (val === null || val === undefined || val === '')) {
                    return { success: true, value: null };
                }
                const num = parseFloat(val);
                if (isNaN(num)) {
                    return { success: false,
                        error: msg('mustBeNumber', '{field} must be a number',
                                   { field: def.label }) };
                }
                if (def.min !== undefined && num < def.min) {
                    return { success: false, correctedValue: def.min,
                        error: msg('min', '{field} must be at least {min}',
                                   { field: def.label, min: def.min }) };
                }
                if (def.max !== undefined && num > def.max) {
                    return { success: false, correctedValue: def.max,
                        error: msg('max', '{field} must be no more than {max}',
                                   { field: def.label, max: def.max }) };
                }
                return { success: true, value: num };
            };
        }

        initializeValidators() {
            const validators = {};
            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (def.type === 'number') validators[name] = this.makeNumberValidator(def);
            }
            return validators;
        }

        /**
         * Narrows parameter ranges to the active machine's limits.
         * Roland's feeds are mm/sec; everything user-facing is mm/min.
         */
        updateMachineConstraints(machineProfile, postProcessor) {
            const isRoland = postProcessor === 'roland';
            const clamp = (name, min, max) => {
                const def = this.parameterDefinitions[name];
                if (!def) return;
                if (min !== undefined) def.min = min;
                if (max !== undefined) def.max = max;
                this.validators[name] = this.makeNumberValidator(def);
            };

            if (machineProfile?.spindleRange) {
                clamp('spindleSpeed', machineProfile.spindleRange.min, machineProfile.spindleRange.max);
            }

            if (isRoland && machineProfile?.maxFeedXY) {
                clamp('feedRate', undefined, machineProfile.maxFeedXY * 60);
                clamp('plungeRate', undefined,
                    (machineProfile.maxFeedZ || machineProfile.maxFeedXY) * 60);
            } else if (!isRoland) {
                this.restoreDefaultValidators(['feedRate', 'plungeRate', 'spindleSpeed']);
            }

            // Values already in state may now sit outside the new range.
            for (const [opId, state] of this.operationStates) {
                for (const [stage, params] of Object.entries(state)) {
                    for (const [name, value] of Object.entries(params)) {
                        const validator = this.validators[name];
                        if (!validator) continue;
                        const result = validator(value);
                        if (result.correctedValue !== undefined) {
                            state[stage][name] = result.correctedValue;
                            this.markDirty(opId, stage);
                        }
                    }
                }
            }

            this.debug(`Machine constraints updated for ${machineProfile?.label || 'unknown'}`);
        }

        /**
         * Reverts to the ranges the profile declared.
         */
        restoreDefaultValidators(paramNames) {
            for (const name of paramNames) {
                const def = this.parameterDefinitions[name];
                if (!def || def.type !== 'number') continue;

                const base = this.baseRanges[name];
                if (base) { def.min = base.min; def.max = base.max; }

                this.validators[name] = this.makeNumberValidator(def);
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
            // The persisted tool id, if the user picked one, so tool-derived
            // defaults resolve against it rather than the profile default.
            const savedToolId = (operation.userOverrides.has('tool') && opSettings.tool)
                ? opSettings.tool : null;
            const defaults = this.getDefaults(operation.type, savedToolId);

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
                // null is a REAL value for a nullable field - `!== undefined`
                // lets it through so the empty state persists across reloads.
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

        /**
         * Parameters for a stage, filtered by operation type and machine
         * class. `ctx` is { machineClass, dimension } - build it once per
         * form via BaseOperationPanel.getOperationContext().
         *
         * Default machine class is ['router']: that is the existing corpus's
         * implicit rule, now written down. Laser params opt in.
         */
        getStageParameters(stage, operationType, ctx = {}) {
            const machineClass = ctx.machineClass || 'router';
            const dimension = ctx.dimension || null;
            const sessionClass = ctx.sessionClass || machineClass;
            const isLaser = machineClass === 'laser';
            const exportFormat = this.core.settings?.laser?.exportFormat;
            const params = [];

            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (def.stage !== stage) continue;

                if (def.operationTypes && !def.operationTypes.includes(operationType)) continue;

                const classes = def.machineClasses || ['router'];
                if (!classes.includes(machineClass)) continue;

                if (def.dimensions && dimension && !def.dimensions.includes(dimension)) continue;

                // Hide clearing-related params if exporting to PNG
                if (isLaser && exportFormat === 'png') {
                    if (name === 'laserClearStrategy' || name === 'laserSpacingMode' ||
                        name === 'laserStepOver' || name === 'laserLinesPerCm' ||
                        name === 'laserLinesPerInch' || name === 'laserHatchAngle') {
                        continue;
                    }
                }

                params.push({ name, ...def });
            }

            return params;
        }

        /**
         * The operation's parameter-stage list, from the registry.
         *
         * stages[0] is the source form. Artifact node i shows stages[i + 1],
         * so `stages.length === artifacts.length + 1` always holds -
         * OperationRegistry.validate() enforces it.
         */
        getStages(operationType, machineClass) {
            const stages = this.core.registry?.stagesFor(operationType, machineClass);
            if (stages?.length) return stages;
            return ['geometry', 'strategy', 'machine', 'output'];
        }

        getArtifacts(operationType, machineClass) {
            const artifacts = this.core.registry?.artifactsFor(operationType, machineClass);
            if (artifacts?.length) return artifacts;
            return ['offsets', 'preview', 'toolpath'];
        }

        /** Next stage after `currentStage`, or null at the end of the chain. */
        getNextStage(currentStage, operationType, machineClass) {
            const stages = this.getStages(operationType, machineClass);
            const idx = stages.indexOf(currentStage);
            if (idx === -1 || idx >= stages.length - 1) return null;
            return stages[idx + 1];
        }

        // Get default values for operation type
        getDefaults(operationType, selectedToolId = null) {
            const defaults = {};

            // Ask the Tool Library for an appropriate starting tool via the core
            if (this.core.toolLibrary) {
                const tool = (selectedToolId ? this.core.toolLibrary.getTool(selectedToolId) : null)
                    || this.core.toolLibrary.getDefaultToolForOperation(operationType);
                if (tool) {
                    // One field, one meaning: the tool's diameter. Copper
                    // operations declare toolSizing 'effective' and take the
                    // bit's declared cut width instead - the only place the two
                    // differ, and only for a tapered bit.
                    const sizes = this.core.toolLibrary.getToolSizes(tool.id);
                    const useEffective = this.core.registry?.toolSizingFor(operationType) === 'effective';
                    defaults.tool = tool.id;
                    defaults.toolDiameter = useEffective ? sizes.effective : sizes.diameter;
                    defaults.vbitTipRadius = sizes.tipRadius;
                    if (sizes.angle !== null) defaults.vbitAngle = sizes.angle;
                    if (sizes.cornerRadius !== undefined) {
                        defaults.reliefCornerRadius = sizes.cornerRadius;
                        defaults.rotaryCornerRadius = sizes.cornerRadius;
                    }
                    if (sizes.tipType !== undefined) {
                        defaults.reliefToolShape = sizes.tipType;
                        defaults.rotaryToolShape = sizes.tipType;
                    }

                    // Feeds come from the tool. Assigned per field, not as a
                    // block: a custom library may omit a value validateTool
                    // does not require.
                    const cutting = tool.cutting;
                    if (cutting) {
                        if (cutting.feedRate != null) defaults.feedRate = cutting.feedRate;
                        if (cutting.plungeRate != null) defaults.plungeRate = cutting.plungeRate;
                        if (cutting.spindleSpeed != null) defaults.spindleSpeed = cutting.spindleSpeed;
                    }

                    // Support custom tool selection keys like engraveTool or vcarveTool (select fields only)
                    for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                        if (def.type === 'select' && name.endsWith('Tool') && def.operationTypes?.includes(operationType)) {
                            defaults[name] = tool.id;
                        }
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

            // Profile-declared defaults for this operation type
            const profileDefaults = this.core.registry?.defaultsFor(operationType);
            if (profileDefaults) {
                Object.assign(defaults, profileDefaults);
            }

            return defaults;
        }

        addChangeListener(callback) {
            this.changeListeners.add(callback);
        }

        notifyChange(operationId, stage, name, value) {
            for (const listener of this.changeListeners) {
                listener({ operationId, stage, name, value });
            }
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
            const entry = lang ? lang.entry(`params.${param.name}`) : {};
            const labelText = entry.label || param.label;
            label.textContent = labelText;
            field.appendChild(label);

            if (entry.help && window.TooltipManager) {
                window.TooltipManager.attachWithIcon(label,
                    { title: labelText, text: entry.help }, { showOnFocus: true });
            }

            let inputEl;

            switch (param.type) {
                case 'number': {
                    const wrapper = document.createElement('div');
                    wrapper.className = 'input-unit';
                    inputEl = document.createElement('input');
                    inputEl.type = 'number';
                    inputEl.id = inputId;
                    // Nullable numbers render EMPTY when unassigned. `?? 0`
                    // would put a plausible value in the box that the user
                    // never entered and would never be prompted to check.
                    inputEl.value = param.nullable
                        ? (value === null || value === undefined ? '' : value)
                        : (value ?? 0);
                    if (param.placeholder) inputEl.placeholder = param.placeholder;
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
                            const optLabel = lang
                                ? lang.get(`enums.${opt.value}`, opt.label) : opt.label;
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
                    const raw = inputEl.value;
                    const val = param.type === 'checkbox' ? inputEl.checked
                        : param.type === 'number'
                            ? (param.nullable && raw.trim() === ''
                                ? null
                                : (parseFloat(raw) || 0))
                        : raw;
                    options.onChange(param.name, val, inputEl);
                };
                inputEl.addEventListener('change', handleCommit);
            }

            return field;
        }

        /**
         * Populates a <select> with tools from the ToolLibrary. A tapered tool
         * is labelled with both sizes because neither one alone identifies it.
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
                const sizes = toolLibrary.getToolSizes(tool.id);
                // REVIEW - All these stats on the drop-down lable are useless and confusing
                opt.textContent = sizes.tapered
                    ? `${tool.name} (${sizes.effective}mm cut / ${sizes.diameter}mm dia)`
                    : `${tool.name} (${sizes.diameter}mm)`;
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
            ParameterManager.hideEmptySections(container);
        }

        /**
         * A heading for parameters that are not on screen is worse than no
         * heading: it claims a section exists and then shows nothing under it.
         * Fields disappear for three unrelated reasons - a data-conditional,
         * a machine-class group toggle, a processor group toggle - and none of
         * them knows about the others, so the check runs on the result.
         *
         * Sections with no .property-field at all (output block, drill card,
         * static info panels) are left alone: they carry their own content.
         */
        static hideEmptySections(root) {
            if (!root) return;
            root.querySelectorAll('.property-section').forEach(section => {
                const fields = section.querySelectorAll('.property-field');
                if (fields.length === 0) return;
                const anyVisible = Array.from(fields).some(f => f.style.display !== 'none');
                section.style.display = anyVisible ? '' : 'none';
            });
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