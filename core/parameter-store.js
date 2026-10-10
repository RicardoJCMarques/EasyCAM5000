/*!
 * @file        core/parameter-store.js
 * @description Parameter definitions, validation, and per-operation state management
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 
 * Parameter definitions, validators and per-id parameter state. DOM-free: the
 * form renderer (ui/ui-input-renderer.js) reads values from here and writes them
 * back through setParameter. The pipeline's entire contract with this module is
 * getAllParameters, hasUnsavedChanges and commitToOperation.
 */

!function () {
    "use strict";

    const ROOT = globalThis;
    const debugState = ROOT.CAMConfig.defaults.debug;

    /**
     * A raster export carries pixels, so the laser's own software owns the
     * fill and these controls describe nothing the exported file can express.
     */
    const PNG_HIDDEN = new Set([
        'laserClearStrategy',
        'laserSpacingMode',
        'laserStepOver',
        'laserLinesPerCm',
        'laserLinesPerInch',
        'laserHatchAngle',
        'laserSpotSize' // REVIEW - COnsider renaming laserSpotSize to something related to Kerf maybe? More realistic? Would turn offset isolation more manageable maybe? Less overlap though.
    ]);

    class ParameterStore {

        /**
         * @param {Object} hooks
         * @param {Object} hooks.settings                 CamCore.settings, live
         * @param {Object} hooks.registry                 OperationRegistry
         * @param {Object} hooks.toolLibrary              ToolLibrary
         * @param {Object} hooks.lang LanguageManager, for validator messages
         * @param {(id:string) => Object|null} hooks.getOperation
         */
        constructor(hooks = {}) {
            // Held as the hooks object, not as four copies: `settings`,
            // `registry` and `toolLibrary` are supplied as getters so they
            // resolve at read time. Copying them here would snapshot the nulls
            // that exist before loadProfile runs.
            this._hooks = hooks;
            this._getOperation = hooks.getOperation || (() => null);

            // Populated by the app controller from profile-{trace,shape}.json
            this.parameterDefinitions = {};

            // Keyed by FORM id, which is not always an operation id: EasyShape
            // holds state under bucket ids, and under a bare scene-node id for
            // a shape that has no operation yet.
            this.operationStates = new Map();
            this.dirtyFlags = new Map();

            this.validators = {};
            this.changeListeners = new Set();

            // Capability gates for individual <option>s, keyed by the
            // `requiresCapability` string a profile option declares.
            // { 'rotary.indexed': { ok: false, reason: '…' } }
            // A key with no entry is permissive: an unknown capability must
            // never silently remove a control.
            this.optionGates = {};
        }

        get settings() { return this._hooks.settings || null; }
        get registry() { return this._hooks.registry || null; }
        get toolLibrary() { return this._hooks.toolLibrary || null; }
        get lang() { return this._hooks.lang || null; }

        // ═══════════════════════════════════════════════════════════════
        // Definitions and validators
        // ═══════════════════════════════════════════════════════════════

        /**
         * Replaces parameter definitions and rebuilds validators. Both apps
         * have their own set from profile-{trace,shape}.json.
         */
        setDefinitions(definitions) {
            this.parameterDefinitions = definitions;
            this.validators = {};
            for (const [name, def] of Object.entries(definitions)) {
                if (!def) continue;
                // `.includes()` on a bare string matches substrings, so a future
                // drill/drillMill pair would silently cross-match.
                if (typeof def.operationTypes === 'string') def.operationTypes = [def.operationTypes];
                if (def.type === 'number') this.validators[name] = this.makeNumberValidator(def);
            }
            this.operationStates.clear();
            this.dirtyFlags.clear();
        }

        /** Range validator bound to a definition, so min/max edits take effect live. */
        makeNumberValidator(def) {
            const msg = (key, fallback, tokens) => {
                const t = this.lang?.format?.(`messages.validation.${key}`, tokens);
                if (t) return t;
                let out = fallback;
                for (const [k, v] of Object.entries(tokens)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
                return out;
            };

            return (val) => {
                if (def.nullable && (val === null || val === undefined || val === '')) {
                    return { success: true, value: null };
                }
                const num = parseFloat(val);
                if (isNaN(num)) {
                    return { success: false, error: msg('mustBeNumber', '{field} must be a number', { field: def.label }) };
                }
                if (def.min !== undefined && num < def.min) {
                    return {
                        success: false,
                        correctedValue: def.min,
                        error: msg('min', '{field} must be at least {min}', { field: def.label, min: def.min })
                    };
                }
                if (def.max !== undefined && num > def.max) {
                    return {
                        success: false,
                        correctedValue: def.max,
                        error: msg('max', '{field} must be no more than {max}', { field: def.label, max: def.max })
                    };
                }
                return { success: true, value: num };
            };
        }

        /**
         * Merges capability gates and returns the new map. Callers own the
         * key namespace; the machine settings form owns 'rotary.*'.
         */
        setOptionGates(gates) {
            this.optionGates = { ...this.optionGates, ...gates };
            return this.optionGates;
        }

        // ═══════════════════════════════════════════════════════════════
        // Value state
        // ═══════════════════════════════════════════════════════════════

        getOperationState(operationId) {
            if (!this.operationStates.has(operationId)) this.operationStates.set(operationId, {});
            return this.operationStates.get(operationId);
        }

        /**
         * @returns {{success:boolean, value?:*, error?:string, correctedValue?:*}}
         * A clamp reports success:false WITH the corrected value already stored,
         * so the caller can flag the field and show what it became.
         */
        setParameter(operationId, stage, name, value) {
            const state = this.getOperationState(operationId);
            if (!state[stage]) state[stage] = {};

            if (this.validators[name]) {
                const result = this.validators[name](value);
                if (!result.success) {
                    this.debug(`Invalid value for ${name}: ${value}. ${result.error}`);
                    if (result.correctedValue !== undefined) {
                        state[stage][name] = result.correctedValue;
                        this.markDirty(operationId, stage);
                        this.notifyChange(operationId, stage, name, result.correctedValue);
                        return { success: false, error: result.error, correctedValue: result.correctedValue };
                    }
                    // No correction possible: hand back the value still stored.
                    return { success: false, error: result.error, correctedValue: state[stage][name] };
                }
                value = result.value;
            }

            state[stage][name] = value;
            this.markDirty(operationId, stage);
            this.notifyChange(operationId, stage, name, value);
            return { success: true, value };
        }

        markDirty(operationId, stage) {
            if (!this.dirtyFlags.has(operationId)) this.dirtyFlags.set(operationId, new Set());
            this.dirtyFlags.get(operationId).add(stage);
        }

        /** All parameters for an id, merged across stages. */
        getAllParameters(operationId) {
            const op = this._getOperation(operationId);
            if (op && !this.operationStates.has(operationId)) this.loadFromOperation(op);
            const state = this.getOperationState(operationId);
            const merged = {};
            for (const stageParams of Object.values(state)) Object.assign(merged, stageParams);
            // A reminder of the Machine Settings value: mirrored on every read and
            // never persisted, so it cannot go stale.
            if (this.parameterDefinitions.laserSpotSize) {
                merged.laserSpotSize = this.readSetting('laser.spotSize');
            }
            return merged;
        }

        hasUnsavedChanges(operationId) {
            return this.dirtyFlags.has(operationId);
        }

        // ═══════════════════════════════════════════════════════════════
        // Operation round trip
        // ═══════════════════════════════════════════════════════════════

        /**
         * Writes live values onto the operation. `operation` is any object
         * carrying { id, type, settings, userOverrides } - EasyShape5000 hands over a
         * bucket view whose userOverrides forwards to the object that owns it.
         * userOverrides is a Set at runtime and an Array on the operation, so
         * both ends coerce; keep every read guarded.
         */
        commitToOperation(operation) {
            if (!operation) return;

            if (!operation.userOverrides) operation.userOverrides = new Set();
            else if (Array.isArray(operation.userOverrides)) operation.userOverrides = new Set(operation.userOverrides);

            const allLiveParams = this.getAllParameters(operation.id);
            if (!operation.settings) operation.settings = {};

            for (const [name, value] of Object.entries(allLiveParams)) {
                if (operation.userOverrides.has(name)) {
                    // Persist ONLY parameters explicitly modified by the user
                    operation.settings[name] = value;
                } else {
                    // Purge the rest so stale profile defaults aren't locked in
                    delete operation.settings[name];
                }
            }

            operation.userOverrides = Array.from(operation.userOverrides);
            this.dirtyFlags.delete(operation.id);
            this.debug(`Committed explicit overrides (${operation.userOverrides.length}) to operation ${operation.id}`);
        }

        /** Rebuilds state for an operation from its settings. */
        loadFromOperation(operation) {
            if (!operation) return;

            if (!operation.userOverrides) operation.userOverrides = new Set();
            else if (Array.isArray(operation.userOverrides)) operation.userOverrides = new Set(operation.userOverrides);

            const opSettings = operation.settings || {};

            // The persisted tool id, if the user picked one, so tool-derived
            // defaults resolve against it rather than the profile default.
            const savedToolId = operation.userOverrides.has('tool') && opSettings.tool ? opSettings.tool : null;
            const defaults = this.getDefaults(operation.type, savedToolId);

            // Ensure newly initialized or unoverridden stencil operations adopt the operation's machineClass
            if ("stencil" === operation.type && operation.machineClass) {
                defaults.stencilMachine = "knife" === operation.machineClass ? "knife" : "router";
            }

            const state = {};
            this.operationStates.set(operation.id, state);

            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (!def.stage) continue; // Skip non-parameter definitions
                if (def.operationTypes && !def.operationTypes.includes(operation.type)) continue;

                const value = operation.userOverrides.has(name) && opSettings[name] !== undefined
                    ? opSettings[name]
                    : defaults[name] ?? def.default;

                // null is a REAL value for a nullable field - `!== undefined`
                // lets it through so the empty state persists across reloads.
                if (value === undefined) continue;

                const validator = this.validators[name];
                const result = validator ? validator(value) : { success: true, value };
                const finalValue = result.correctedValue !== undefined ? result.correctedValue : result.value;

                if (!state[def.stage]) state[def.stage] = {};
                state[def.stage][name] = finalValue;
            }
            this.dirtyFlags.delete(operation.id);
        }

        // ═══════════════════════════════════════════════════════════════
        // Schema queries
        // ═══════════════════════════════════════════════════════════════

        /**
         * Parameters for a stage, filtered by operation type and machine
         * class. `ctx` is { machineClass, dimension } - build it once per
         * form via BaseOperationPanel.getOperationContext().
         * Default machine class is ['router']: that is the existing corpus's
         * implicit rule, now written down. Laser params opt in.
         */
        getStageParameters(stage, operationType, ctx = {}) {
            const machineClass = ctx.machineClass || 'router';
            const dimension = ctx.dimension || null;
            const isLaser = machineClass === 'laser';
            const exportFormat = this.settings?.laser?.exportFormat;
            const params = [];

            for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                if (def.stage !== stage) continue;
                if (def.operationTypes && !def.operationTypes.includes(operationType)) continue;

                const classes = def.machineClasses || ['router'];
                if (!classes.includes(machineClass)) continue;
                if (def.dimensions && dimension && !def.dimensions.includes(dimension)) continue;
                if (isLaser && exportFormat === 'png' && PNG_HIDDEN.has(name)) continue;

                params.push({ name, ...def });
            }

            return params;
        }

        /**
         * The operation's parameter-stage list, from the registry.
         * stages[0] is the source form. Artifact node i shows stages[i + 1],
         * so `stages.length === artifacts.length + 1` always holds -
         * OperationRegistry.validate() enforces it.
         */
        getStages(operationType, machineClass) {
            const stages = this.registry?.stagesFor(operationType, machineClass);
            return stages?.length ? stages : ['geometry', 'strategy', 'machine', 'output'];
        }

        getArtifacts(operationType, machineClass) {
            const artifacts = this.registry?.artifactsFor(operationType, machineClass);
            return artifacts?.length ? artifacts : ['offsets', 'preview', 'toolpath'];
        }

        /** Reads one dot path out of settings. */
        readSetting(path) {
            return path.split('.').reduce((node, key) => node?.[key], this.settings);
        }

        /**
         * Flattens a device descriptor's parameters into schema entries. The path
         * is `<namespace>.<deviceId>.<name>` and nothing else is possible, so the
         * descriptor declares a name and never a path.
         * The namespace decides the machine class the settings belong to - a
         * post's are router truth, a laser profile's are laser truth - because a
         * descriptor cannot know which namespace it was mounted under. A
         * parameter may still declare its own `classes` and win.
         */
        deviceSchema(descriptor, namespace, classes = null) {
            const out = {};
            for (const p of descriptor?.parameters || []) {
                const entry = { ...p, owner: descriptor.id, namespace };
                if (!entry.classes && classes) entry.classes = classes;
                out[`${namespace}.${descriptor.id}.${p.name}`] = entry;
            }
            return out;
        }

        // ═══════════════════════════════════════════════════════════════
        // Defaults
        // ═══════════════════════════════════════════════════════════════

        getDefaults(operationType, selectedToolId = null) {
            const defaults = {};

            // Ask the Tool Library for an appropriate starting tool via the core
            if (this.toolLibrary) {
                const tool = (selectedToolId ? this.toolLibrary.getTool(selectedToolId) : null)
                    || this.toolLibrary.getDefaultToolForOperation(operationType);

                if (tool) {
                    // One field, one meaning: the tool's diameter. Copper
                    // operations declare toolSizing 'effective' and take the
                    // bit's declared cut width instead - the only place the two
                    // differ, and only for a tapered bit.
                    const sizes = this.toolLibrary.getToolSizes(tool.id);
                    const useEffective = this.registry?.toolSizingFor(operationType) === 'effective';

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

                    // Support custom tool selection keys like engraveTool or
                    // vcarveTool (select fields only)
                    for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                        if (def.type === 'select' && name.endsWith('Tool') && def.operationTypes?.includes(operationType)) {
                            defaults[name] = tool.id;
                        }
                    }
                }
            }

            // Profile-declared defaults for this operation type
            const profileDefaults = this.registry?.defaultsFor(operationType);
            if (profileDefaults) Object.assign(defaults, profileDefaults);

            // In a laser pipeline, default stencil operations to the SVG vector (knife) path
            if ("stencil" === operationType) {
                const sessionClass = this.settings?.pipeline?.machineClass || "router";
                defaults.stencilMachine = "laser" === sessionClass ? "knife" : "router";
            }

            // Depth that follows the stock, for operations the profile declares as
            // cutting through it. Runs last: a session fact the operator set beats
            // a static profile number. The sign is declared, not inferred -
            // EasyTrace stores cutDepth negative and EasyShape5000 stores it positive.
            if (this.registry?.cutsThrough(operationType)) {
                for (const [name, def] of Object.entries(this.parameterDefinitions)) {
                    if (!def.throughFrom) continue;
                    const v = this.readSetting(def.throughFrom);
                    if (v !== undefined) defaults[name] = def.negate ? -v : v;
                }
            }

            return defaults;
        }

        // ═══════════════════════════════════════════════════════════════
        // Change notification
        // ═══════════════════════════════════════════════════════════════

        addChangeListener(callback) {
            this.changeListeners.add(callback);
        }

        notifyChange(operationId, stage, name, value) {
            for (const listener of this.changeListeners) {
                listener({ operationId, stage, name, value });
            }
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data !== null
                ? console.log(`[ParameterStore] ${message}`, data)
                : console.log(`[ParameterStore] ${message}`);
        }
    }

    ROOT.ParameterStore = ParameterStore;
}();
