/*!
 * @file        ui/ui-operation-registry.js
 * @description Single source of truth for what an operation TYPE is.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  /**
   * OperationRegistry - reads the `operations` block of an app profile and
   * answers what an operation type is: which types exist, which handler
   * class backs a type, which extensions it accepts, its default tool, its
   * icon and label, whether it gets a tab or a viz toggle, and its machine
   * classes, dimension and stages.
   * Declaration ORDER in the JSON is the UI order. Object key order is
   * stable for string keys, so the tab strip and the viz list follow the
   * profile without a separate ordering field.
   * Read-only at runtime; nothing in this class holds state.
   */
  class OperationRegistry {
    constructor(profile) {
      this.entries = profile?.operations || {};
      this.aux = profile?.auxHandlers || {};
      this.chains = profile?.chains || {};
      this.artifactMeta = profile?.ui?.artifacts || {};
      this.exportOrder = profile?.ui?.exportOrder || []; // The Export Manager's default cut order, by type.
      // Extension → type. Built once.
      this._byExtension = new Map();
      for (const [type, def] of Object.entries(this.entries)) {
        if (def?.virtual) continue;
        for (const ext of def?.extensions || []) {
          const key = ext.toLowerCase();
          if (!this._byExtension.has(key)) this._byExtension.set(key, type);
        }
      }
    }

    /** All declared types, in profile declaration order.*/
    types() {
      return Object.keys(this.entries);
    }

    get(type) {
      return this.entries[type] || null;
    }

    has(type) {
      return !!this.entries[type];
    }

    /** Types that get a button in the op-type strip.*/
    tabTypes() {
      return this.types().filter(t => this.entries[t]?.tab !== false && !this.entries[t]?.virtual);
    }

    /** Types the app should register a handler for. */
    handlerTypes() {
      return this.types().filter(t => !this.entries[t]?.virtual && this.entries[t]?.handler);
    }

    handlerFor(type) {
      return this.entries[type]?.handler || null;
    }

    isHandlerOptional(t) {
      return this.entries[t]?.optionalHandler === true;
    }

    auxHandlers() {
      return { ...this.aux };
    }

    labelFor(type) {
      return i18n.t(`ops.${type}.label`);
    }

    iconFor(type)  {
      return this.entries[type]?.icon || `icon-op-${type}`;
    }

    extensionsFor(type) {
      return [...(this.entries[type]?.extensions || [])];
    }

    /** Every extension some type loads, for a file picker's accept list. */
    extensions() {
      return [...this._byExtension.keys()];
    }

    /**
     * The Export Manager's default cut order: the types the profile's
     * ui.exportOrder lists, in its order, then the rest in creation order.
     * @param {Object[]} operations
     * @returns {Object[]} a sorted copy
     */
    sortForExport(operations) {
      const rank = op => {
        const i = this.exportOrder.indexOf(op.type);
        return i === -1 ? this.exportOrder.length : i;
      };
      return [...operations].sort((a, b) => rank(a) - rank(b));
    }

    /**
     * accept="" string for a file input. SVG is universally importable,
     * so it is appended when a type does not already declare it
     */
    acceptFor(type) {
      const ext = this.extensionsFor(type);
      if (!ext.includes('.svg')) ext.push('.svg');
      return ext.join(',');
    }

    /**
     * @param {string} ext - with or without the leading dot.
     */
    typeForExtension(ext) {
      if (!ext) return null;
      const key = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
      return this._byExtension.get(key) || null;
    }

    defaultToolFor(type) {
      return this.entries[type]?.defaultTool || null;
    }

    /**
     * Which tool size seeds this type's toolDiameter field. 'effective' =
     *  the width a tapered bit cuts at engraving depth (copper isolation,
     *  clearing, engrave); anything else = the tool's diameter. Straight bits
     *  report the same number either way.
     * @returns {'diameter'|'effective'}
     */
    toolSizingFor(type) {
      return this.entries[type]?.toolSizing === 'effective' ? 'effective' : 'diameter';
    }

    /** Profile-level parameter defaults for a type. Never null. */
    defaultsFor(type) {
      return this.entries[type]?.defaults || null;
    }

    /**
     * Whether this type cuts the stock through. Depth then follows stock
     * thickness instead of the shared cutDepth default, which isolation
     * needs at 0.1 mm into copper.
     */
    cutsThrough(type) {
      return this.entries[type]?.cutsThrough === true;
    }

    /**
     * @returns {string[]} classes this type can run on, declaration order.
     */
    machineClassesFor(type) {
      return Object.keys(this.entries[type]?.machineClasses || {});
    }

    supports(type, machineClass) {
      return !!this.entries[type]?.machineClasses?.[machineClass];
    }

    resolveMachineClass(type, preferred) {
      if (this.supports(type, preferred)) return preferred; // First declaration wins.
      if ("laser" === preferred && this.supports(type, "knife")) return "knife";
      return this.machineClassesFor(type)[0] || preferred || null;
    }

    /**
     * @returns {'2d'|'2.5d'|'3d'|null}
     */
    dimensionFor(type, machineClass) {
      const cls = this.resolveMachineClass(type, machineClass);
      return this.entries[type]?.machineClasses?.[cls] || null;
    }

    /**
     * @returns {{stages:string[], artifacts:string[]}|null}
     */
    chainFor(type, machineClass) {
      const dim = this.dimensionFor(type, machineClass);
      return dim ? (this.chains[dim] || null) : null;
    }

    /**
     * Parameter stages, in order. stages[0] is the source form;
     * stages[i] is the form shown by artifact node i.
     */
    stagesFor(type, machineClass) {
      return [...(this.chainFor(type, machineClass)?.stages || [])];
    }

    /**
     * Artifact nodes, in order. Node i is produced by the action on
     * stages[i], and shows the form for stages[i + 1].
     */
    artifactsFor(type, machineClass) {
      return [...(this.chainFor(type, machineClass)?.artifacts || [])];
    }

    /** A 3D chain names an artifact by its label3d where the language pack has one. */
    artifactLabel(a, dimension) {
      const variant = `artifacts.${a}.label3d`;
      return dimension === '3d' && i18n.has(variant) ? i18n.t(variant) : i18n.t(`artifacts.${a}.label`);
    }

    artifactIcon(a) {
      return this.artifactMeta[a]?.icon || `icon-stage-${a}`;
    }

    /**
     * Startup sanity. The chain invariant is what makes node → form
     * mapping positional-safe; violating it is how a node ended up
     * captioned "Offsets" while rendering Feeds & Speeds.
     */
    validate() {
      for (const [dim, chain] of Object.entries(this.chains)) {
        if ((chain.stages?.length || 0) !== (chain.artifacts?.length || 0) + 1) {
          console.error(`[Registry] chain '${dim}': stages must be artifacts + 1`, chain.stages, chain.artifacts);
        }
      }
      for (const type of this.types()) {
        if (this.entries[type]?.virtual) continue;
        if (!this.machineClassesFor(type).length) {
          console.warn(`[Registry] '${type}' declares no machineClasses`);
          continue;
        }
        for (const cls of this.machineClassesFor(type)) {
          if (!this.chainFor(type, cls)) console.error(`[Registry] '${type}' on '${cls}': no chain for dimension '${this.dimensionFor(type, cls)}'`);
        }
      }
    }

    /** [{ type, id, label }] for every type with `viz: true`, in declaration order. */
    vizEntries() {
      const out = [];
      for (const [type, def] of Object.entries(this.entries)) {
        if (def?.viz !== true) continue;
        out.push({type, id: `show-${type}`, label: i18n.t(`ops.${type}.short`)});
      }
      return out;
    }
  }

  window.OperationRegistry = OperationRegistry;
})();