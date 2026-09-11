/*!
 * @file        ui/ui-input-renderer.js
 * @description Builds parameter and machine-settings form DOM from schema entries
 *              and applies the visibility, conditional and capability passes over
 *              it. Holds no parameter state: values come from ParameterStore and
 *              edits go back to it through the onChange callbacks this module
 *              invokes.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

!function () {
    "use strict";

    const D = window.CAMConfig.defaults;

    class InputRenderer {

        /**
         * @param {ParameterStore} store - the value and schema owner.
         * @param {CamCore} core - renderSettingsForm writes machine settings
         *        straight back through setSetting. The store is deliberately
         *        core-free, so the writer is supplied here and never replaced.
         */
        constructor(store, core) {
            this.store = store;
            this.core = core;
        }

        // ═══════════════════════════════════════════════════════════════
        // Form Rendering
        // ═══════════════════════════════════════════════════════════════

        /**
         * Creates a complete .property-field element from a parameter definition.
         *
         * @param {Object} param Parameter definition
         * @param {*} value Current value
         * @param {Object} [options]
         * @param {string} [options.idPrefix='op-'] DOM id prefix
         * @param {string} [options.key] DOM id suffix when the name is not unique in the form
         * @param {string} [options.opType] Operation type (for tool filtering)
         * @param {Object} [options.toolLibrary] ToolLibrary instance
         * @param {Object} [options.lang] LanguageManager instance
         * @param {Function} [options.onChange] Callback(paramName, newValue, inputElement)
         * @returns {HTMLElement} The .property-field div
         */
        createField(param, value, options = {}) {
            const field = document.createElement("div");
            field.className = "property-field";
            field.dataset.param = param.name;
            if (param.conditional) field.dataset.conditional = param.conditional;
            // Fallback for applyOptionGates when the current selection becomes
            // unavailable.
            if (param.default !== undefined) field.dataset.default = String(param.default);

            const inputId = `${options.idPrefix || 'op-'}${options.key || param.name}`;

            const label = document.createElement("label");
            label.setAttribute("for", inputId);

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
                case "number": {
                    const wrapper = document.createElement("div");
                    wrapper.className = "input-unit";
                    inputEl = document.createElement("input");
                    inputEl.type = "number";
                    inputEl.id = inputId;
                    // Nullable numbers render EMPTY when unassigned. `?? 0`
                    // would put a plausible value in the box that the user
                    // never entered and would never be prompted to check.
                    inputEl.value = param.nullable
                        ? (value === null || value === undefined ? "" : value)
                        : (value ?? 0);
                    if (param.placeholder) inputEl.placeholder = param.placeholder;
                    if (param.min !== undefined) inputEl.min = param.min;
                    if (param.max !== undefined) inputEl.max = param.max;
                    if (param.step !== undefined) inputEl.step = param.step;
                    if (param.unit) inputEl.setAttribute('aria-label', `${labelText} in ${param.unit}`);
                    if (param.readOnly) {inputEl.readOnly = true; inputEl.classList.add("input-readonly");}

                    inputEl.addEventListener("input", () => {
                        inputEl.classList.remove("input-error");
                        inputEl.removeAttribute("aria-invalid");
                    });

                    wrapper.appendChild(inputEl);
                    if (param.unit) {
                        const unit = document.createElement("span");
                        unit.className = "unit";
                        unit.textContent = param.unit;
                        unit.setAttribute("aria-hidden", "true");
                        wrapper.appendChild(unit);
                    }
                    field.appendChild(wrapper);
                    break;
                }

                case "select": {
                    inputEl = document.createElement("select");
                    inputEl.id = inputId;

                    const isToolSelect = param.name === "tool" || param.name.endsWith("Tool");
                    if (isToolSelect && options.toolLibrary) {
                        this.populateToolSelect(inputEl, options.opType, value, options.toolLibrary);
                    } else if (param.options) {
                        for (const opt of param.options) {
                            const o = document.createElement("option");
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

                case "textarea": {
                    inputEl = document.createElement("textarea");
                    inputEl.id = inputId;
                    inputEl.rows = param.rows || 5;
                    inputEl.value = value ?? "";
                    field.appendChild(inputEl);
                    break;
                }
                case "colorgrid": {
                    const grid = document.createElement("div");
                    grid.className = "color-grid";
                    for (const [type, hex] of Object.entries(value || {})) {
                        const cell = document.createElement("label");
                        cell.className = "color-cell";
                        const swatch = document.createElement("input");
                        swatch.type = "color";
                        swatch.id = `${inputId}-${type}`;
                        swatch.value = hex;
                        swatch.addEventListener("change", () =>
                            options.onChange(param.name, { ...value, [type]: swatch.value }));
                        const caption = document.createElement("span");
                        caption.textContent = options.lang.get(`enums.${type}`, type);
                        cell.append(swatch, caption);
                        grid.appendChild(cell);
                    }
                    field.appendChild(grid);
                    return field;
                }

                case "checkbox": {
                    label.className = "checkbox-label";
                    label.removeAttribute('for');
                    label.textContent = "";

                    inputEl = document.createElement("input");
                    inputEl.type = "checkbox";
                    inputEl.id = inputId;
                    inputEl.checked = !!value;

                    const span = document.createElement("span");
                    span.textContent = labelText;
                    label.appendChild(inputEl);
                    label.appendChild(span);
                    break;
                }
            }

            // A parameter can be present, documented and inert. Declaring
            // `disabled` in the profile is the honest state for a control
            // whose logic is unimplemented or unverified.
            if (param.disabled === true) {
                field.classList.add("property-field--disabled");
                field.title = "Not available yet";
                if (inputEl) inputEl.disabled = true;
            } else if (inputEl && options.onChange) {
                const handleCommit = () => {
                    const raw = inputEl.value;
                    const val = param.type === "checkbox" ? inputEl.checked
                        : param.type === 'number'
                            ? (param.nullable && raw.trim() === ""
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
        populateToolSelect(select, opType, selectedId, toolLibrary) {
            if (!toolLibrary || !toolLibrary.isLoaded) {
                select.innerHTML = "<option>No tools loaded</option>";
                select.disabled = true;
                return;
            }
            const tools = toolLibrary.getToolsForOperation(opType) || [];
            if (tools.length === 0) {
                select.innerHTML = "<option>No compatible tools</option>";
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
         * Renders a schema into one or more panels. `hosts` maps a category to
         * its container; anything without an entry goes to `hosts.default`.
         * A category with a panel of its own is already titled by that panel, so
         * the section heading is only drawn in the fallback host.
         */
        renderSettingsForm(hosts, schema, opts = {}) {
            const { sources = {}, resolvers = {}, lang = null, categoryTitle = c => c, onChange = null } = opts;
            const fallback = hosts.default;
            const panels = Object.values(hosts).filter(Boolean);
            for (const host of panels) host.innerHTML = '';

            const groups = {};
            const values = {};

            for (const [path, def] of Object.entries(schema)) {
                if (!def) continue; // profile removed it
                const segments = path.split('.');
                const name = segments[segments.length - 1];
                // No `type` means the entry exists to seed a value the engine
                // reads, not to be edited. Without this it renders as a labelled
                // row with no control in it.
                if (!def.type) continue;
                const options = def.source ? sources[def.source] : def.options;
                // A picker with one option is not a decision, and an empty source
                // means the active device declares none - both are "no field".
                if (def.source && !(options?.length > 1)) continue;
                const param = { ...def, name, options };
                // Keyed by PATH, not by leaf: every laser profile declares its own
                // svgGrouping, so the leaf is unique per device and not per form.
                values[path] = def.resolver ? resolvers[def.resolver]() : this.store.readSetting(path);
                (groups[def.category || 'general'] ||= []).push({ path, param });
            }

            for (const [cat, entries] of Object.entries(groups)) {
                const host = hosts[cat] || fallback;
                const section = document.createElement('div');
                section.className = 'property-section';
                section.dataset.category = cat;
                if (host === fallback) {
                    const h3 = document.createElement('h3');
                    h3.textContent = categoryTitle(cat);
                    section.appendChild(h3);
                }
                for (const { path, param } of entries) {
                    const field = this.createField(param, values[path], {
                        idPrefix: 'set-',
                        key: path.replace(/\./g, '-'),
                        lang,
                        onChange: (n, v) => {
                            this.core.setSetting(path, v);
                            onChange?.(n, v, param);
                        }
                    });
                    // A `conditional:` names a SIBLING leaf, which is all a device
                    // descriptor can know; the scope turns that back into a path.
                    field.dataset.scope = path.slice(0, path.lastIndexOf('.'));
                    if (param.capability) field.dataset.capability = param.capability;
                    if (param.classes) field.dataset.classes = param.classes.join(',');
                    if (param.owner) {
                        field.dataset.owner = param.owner;
                        field.dataset.namespace = param.namespace;
                    }
                    section.appendChild(field);
                }
                host.appendChild(section);
            }

            for (const host of panels) {
                this.refreshFields(host, values, this.store.optionGates);
                UIControls.setupPropertyGridNavigation(host);
            }
            return values;
        }

        /**
         * One pass over the three reasons a settings field is not on screen.
         * They were three functions that did not know about each other, so the
         * last one to run decided - which is why the line-number field was hidden
         * by a capability check and re-shown by a processor group in the same tick.
         * `owners` is per namespace: the active post owns processorSettings, the
         * active laser profile owns laserSettings.
         * Idempotent: it re-shows what it hid, and defers to a conditional's
         * verdict via data-cond-hidden, so a class change alone can re-run it.
         */
        applyVisibility(container, { caps = {}, classes = null, owners = {} } = {}) {
            container.querySelectorAll('.property-field').forEach(field => {
                const cap = field.dataset.capability;
                const owner = field.dataset.owner;
                const only = field.dataset.classes;
                let show = !field.dataset.condHidden;
                if (cap && caps[cap] === false) show = false;
                if (owner && owner !== owners[field.dataset.namespace]) show = false;
                if (only && classes) show = show && only.split(',').some(c => classes.has(c));
                field.style.display = show ? '' : 'none';
            });
            this.hideEmptySections(container);
        }

        /**
         * Post-render passes: conditionals, then option gates, then the
         * canned-cycle option list. Each is idempotent on its own.
         */
        refreshFields(container, values, gates = {}) {
            this.applyConditionals(container, values);
            this.applyOptionGates(container, gates);
            this.applyCannedCycleOptions(container, values);
            this.hideEmptySections(container);
        }

        /**
         * Supports: "paramName" (truthy), "!paramName" (falsy),
         * "paramName:val1,val2" (value match), "a && b" (compound).
         * A settings field carries a `data-scope`; its clauses name siblings
         * under that scope. Operation fields have none and read a flat bag.
         * Sets display only. A hidden parameter keeps its value and still
         * reaches the handler through the merged bag - hiding is not disabling.
         */
        applyConditionals(container, values) {
            container.querySelectorAll('[data-conditional]').forEach(field => {
                const scope = field.dataset.scope;
                const read = n => values[scope ? `${scope}.${n}` : n];
                const cond = field.dataset.conditional;
                let show = true;
                for (const clause of cond.split('&&')) {
                    const trimmed = clause.trim();
                    if (trimmed.includes(':')) {
                        const colonIdx = trimmed.indexOf(':');
                        const paramName = trimmed.substring(0, colonIdx);
                        const allowedValues = trimmed.substring(colonIdx + 1).split(',');
                        show = show && allowedValues.includes(String(read(paramName) ?? ''));
                    } else if (trimmed.startsWith('!')) {
                        show = show && !read(trimmed.slice(1));
                    } else {
                        show = show && !!read(trimmed);
                    }
                }
                // Each pass records its own verdict rather than racing on one
                // style property: applyVisibility can then be re-run on its own
                // without resurrecting a field a conditional hid.
                if (show) delete field.dataset.condHidden; else field.dataset.condHidden = '1';
                field.style.display = show ? '' : 'none';
            });
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
        hideEmptySections(root) {
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
        applyOptionGates(container, gates) {
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
        applyCannedCycleOptions(container, values) {
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
                    console.log(`[InputRenderer] ${message}`, data);
                } else {
                    console.log(`[InputRenderer] ${message}`);
                }
            }
        }
    }

    window.InputRenderer = InputRenderer;
}();