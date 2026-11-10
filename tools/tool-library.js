/*!
 * @file        tools/tool-library.js
 * @description Manages tool definitions and tool selection functionality
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

  // Held in a constant, not written into fetch(): build.js embeds the
  // library in dist, deletes the file, and checks every fetch('…json') literal.
  const TOOLS_URL = '../tools/tools.json';

  /**
   * Per tool type: the geometry it requires and the relief/rotary tip shape
   * it seeds (reliefToolShape, rotaryToolShape; null leaves them alone).
   * Sizes are mm, angles degrees. `diameter` is always the widest cutting
   * diameter. tools.json _schema documents the same rules for library
   * authors.
   */
  const TYPES = {
    flat: { geometry: ['diameter'], shape: 'flat' },
    ball: { geometry: ['diameter'], shape: 'ball' },
    bull: { geometry: ['diameter', 'cornerRadius'], shape: 'bull' },
    corn: { geometry: ['diameter'], shape: 'flat' },
    drill: { geometry: ['diameter'], shape: null },
    vbit: { geometry: ['diameter', 'tipDiameter', 'angle'], shape: null, tapered: true },
    taperedBall: { geometry: ['diameter', 'tipDiameter', 'halfAngle'], shape: null, tapered: true }
  };

  const GEOMETRY_OPTIONAL = ['effectiveDiameter', 'flutes', 'pointAngle', 'cuttingLength', 'shankDiameter', 'totalLength', 'holderDiameter', 'holderStickout'];
  const CUTTING_REQUIRED = ['feedRate', 'plungeRate', 'spindleSpeed'];

  /**
   * Why a library, or one tool in it, is refused: the descriptor is what an
   * import report shows (tools.validation.*), the message is console text.
   */
  const refuse = (key, values = {}) => Object.assign(
    new Error(`[ToolLibrary] ${key} ${JSON.stringify(values)}`),
    { i18n: { key: `tools.validation.${key}`, values } }
  );

  class ToolLibrary {
    constructor() {
      this.tools = [];
      this.toolsById = new Map();
      this.toolsByType = new Map();
      this.toolsByOperation = new Map();
      this.registry = null; // OperationRegistry, set by CamController: answers profile defaults.
    }

    /**
     * Loads the built-in library. Shipped data must be valid, so any tool that fails
     * validation stops startup instead of being dropped.
     */
    async init() {
      const result = this.importTools(await this.builtInData());
      if (result.failed.length > 0)
        throw new Error(`[ToolLibrary] tools.json: ${result.failed.map((f) => `${f.id}: ${f.detail}`).join('; ')}`);
      this.debug(`Loaded ${this.tools.length} tools`);
    }

    /** The built-in library: embedded by build.js in dist, fetched in source. */
    async builtInData() {
      if (typeof EMBEDDED_TOOLS !== 'undefined') return EMBEDDED_TOOLS;
      const response = await fetch(TOOLS_URL);
      if (!response.ok) throw new Error(`[ToolLibrary] tools.json: HTTP ${response.status}`);
      return response.json();
    }

    /** Puts the built-in library back in place of a custom one (CustomFiles.remove). */
    async restoreBuiltIn() {
      return this.replace(await this.builtInData());
    }

    // ────────────────────────────────────────────────────────────────────
    // Import and validation
    // ────────────────────────────────────────────────────────────────────

    /**
     * Adds a library's tools. One bad tool does not stop the rest: each
     * failure is reported with its id and reason.
     * @param {Object} data - a parsed tool library { tools }
     * @returns {{imported: string[], failed: Array<{id: string, reason: Object|string, detail: string}>, total: number}}
     */
    importTools(data) {
      if (!Array.isArray(data?.tools)) throw refuse('notLibrary');
      const imported = [];
      const failed = [];
      // toolNumber -> id, seeded with the loaded tools so an import
      // cannot take a slot a built-in tool already holds.
      const slots = new Map(this.tools.filter(t => t.toolNumber != null).map(t => [t.toolNumber, t.id]));
      for (const tool of data.tools) {
        try {
          this.validateTool(tool);
          if (this.toolsById.has(tool.id)) throw refuse('duplicateId');
          if (tool.toolNumber != null && slots.has(tool.toolNumber)) throw refuse('toolNumberTaken', { number: tool.toolNumber, id: slots.get(tool.toolNumber) });
        } catch (e) {
          // reason is shown; a malformed record's TypeError has no
          // descriptor and shows its own message. detail is for the console.
          failed.push({ id: typeof tool?.id === 'string' ? tool.id : '(no id)', reason: e.i18n ?? e.message, detail: e.message });
          continue;
        }
        if (tool.toolNumber != null) slots.set(tool.toolNumber, tool.id);
        this.addTool(tool);
        imported.push(tool.id);
      }
      return { imported, failed, total: data.tools.length };
    }

    /**
     * Replaces the library with one from a custom file (CustomFiles). Its
     * tools that pass validateTool make the new library; when none does,
     * or the file is not a library (importTools throws), the current one
     * stays as it was.
     * @param {Object} data - a parsed tool library { tools }
     * @returns {{imported: string[], failed: Array, total: number}}
     */
    replace(data) {
      const previous = [this.tools, this.toolsById, this.toolsByType, this.toolsByOperation];
      this.tools = [];
      this.toolsById = new Map();
      this.toolsByType = new Map();
      this.toolsByOperation = new Map();
      let result = null;
      try {
        result = this.importTools(data);
      } finally {
        if (!result || result.imported.length === 0) [this.tools, this.toolsById, this.toolsByType, this.toolsByOperation] = previous;
      }
      return result;
    }

    /**
     * Throws on the first field that breaks the schema. Fields the schema
     * does not name are kept and ignored.
     */
    validateTool(tool) {
      const fail = (key, values) => { throw refuse(key, values); };
      const positive = v => typeof v === 'number' && v > 0;
      if (typeof tool?.id !== 'string' || tool.id === '') fail('missingId');
      const spec = TYPES[tool.type];
      if (!spec) fail('unknownType', { type: String(tool.type), types: { list: Object.keys(TYPES), type: 'unit' } });
      if (tool.name != null && (typeof tool.name !== 'string' || tool.name.trim() === '')) fail('name');
      const g = tool.geometry;
      if (g === null || typeof g !== 'object') fail('missingGeometry');
      for (const field of spec.geometry) {
        if (!positive(g[field])) fail('positive', { field: `geometry.${field}` });
      }
      for (const field of GEOMETRY_OPTIONAL) {
        if (g[field] != null && !positive(g[field])) fail('positive', { field: `geometry.${field}` });
      }
      if (tool.type === 'bull' && g.cornerRadius > g.diameter / 2) fail('cornerRadius');
      if (tool.type === 'vbit' && g.angle >= 180) fail('vbitAngle');
      if (tool.type === 'taperedBall' && g.halfAngle >= 90) fail('halfAngle');
      if (spec.tapered && g.tipDiameter > g.diameter) fail('tipWider');
      if (g.effectiveDiameter > g.diameter) fail('effectiveWider');
      if ((g.holderDiameter == null) !== (g.holderStickout == null)) fail('holderPair');
      if (g.holderDiameter != null && !(g.shankDiameter > 0 && g.cuttingLength > 0)) fail('holderNeeds');
      const c = tool.cutting;
      if (c === null || typeof c !== 'object') fail('missingCutting');
      for (const field of CUTTING_REQUIRED) {
        if (!positive(c[field])) fail('positive', { field: `cutting.${field}` });
      }
      if (!Array.isArray(tool.operations)) fail('operations');
      if (tool.toolNumber != null && !(Number.isInteger(tool.toolNumber) && tool.toolNumber > 0)) fail('toolNumber');
    }

    addTool(tool) {
      this.tools.push(tool);
      this.toolsById.set(tool.id, tool);
      if (!this.toolsByType.has(tool.type)) this.toolsByType.set(tool.type, []);
      this.toolsByType.get(tool.type).push(tool);
      for (const op of tool.operations) {
        if (!this.toolsByOperation.has(op)) this.toolsByOperation.set(op, []);
        this.toolsByOperation.get(op).push(tool);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Lookup
    // ────────────────────────────────────────────────────────────────────

    getTool(id) {
      return this.toolsById.get(id) || null;
    }

    getToolsByType(type) {
      return this.toolsByType.get(type) || [];
    }

    getToolsForOperation(operationType) {
      return this.toolsByOperation.get(operationType) || [];
    }

    /** The profile's default for the type, else the first tool listed for it. */
    getDefaultToolForOperation(operationType) {
      const defaultId = this.registry?.defaultToolFor(operationType);
      if (defaultId) {
        const tool = this.getTool(defaultId);
        if (tool) return tool;
      }
      return this.getToolsForOperation(operationType)[0] || null;
    }

    // ────────────────────────────────────────────────────────────────────
    // Sizes and names
    // ────────────────────────────────────────────────────────────────────

    static isTapered(tool) {
      return TYPES[tool?.type]?.tapered === true;
    }

    /**
     * Three tool sizes, and every consumer names the one it means:
     *  diameter  - the widest the tool cuts, in every form. A V-carve's
     *              reach clamp reads it.
     *  effective - the width a tapered bit cuts at engraving depth.
     *              DECLARED per tool, not derived: it depends on how deep
     *              the operator runs and on how the bit was ground.
     *              Operations with toolSizing 'effective' read it.
     *  tipRadius - the flat or ball at the very tip. V-carve only.
     * For a straight bit the first two are the same number.
     * angle is the included angle (twice a tapered ball's halfAngle),
     * cornerRadius a bull nose's, shape the relief/rotary tip shape. Each
     * is null where the type has none.
     * @returns {Object|null}
     */
    getToolSizes(toolId) {
      const tool = this.getTool(toolId);
      if (!tool) return null;
      const g = tool.geometry;
      const tapered = ToolLibrary.isTapered(tool);
      let angle = null;
      if (tool.type === 'vbit') angle = g.angle;
      else if (tool.type === 'taperedBall') angle = 2 * g.halfAngle;
      return {
        tapered,
        diameter: g.diameter,
        effective: tapered ? g.effectiveDiameter ?? g.tipDiameter : g.diameter,
        tipRadius: (g.tipDiameter ?? 0) / 2,
        angle,
        cornerRadius: tool.type === 'bull' ? g.cornerRadius : null,
        shape: TYPES[tool.type].shape
      };
    }

    /**
     * What a tool is called in the tool lists and in G-code comments: its
     * own `name` exactly as written, or the name its type generates from
     * the language pack (tools.names.<type>, filled from its geometry).
     * @param {Object} tool - a library record
     * @returns {string|Object} the custom name or a message descriptor
     */
    static label(tool) {
      if (tool.name != null) return tool.name;
      const generated = { key: `tools.names.${tool.type}`, values: tool.geometry };
      if (tool.geometry.holderDiameter == null) return generated;
      return { key: 'tools.names.withHolder', values: { name: generated, holderDiameter: tool.geometry.holderDiameter } };
    }

    /**
     * The generated name of a cutter known only by type and diameter: a
     * drill-table row with no library tool.
     * @returns {Object} message descriptor
     */
    static nameFor(type, diameter) {
      return { key: `tools.names.${type}`, values: { diameter } };
    }

    debug(message, data = null) {
      if (!D.debug.enabled) return;
      data !== null
        ? console.log(`[ToolLibrary] ${message}`, data)
        : console.log(`[ToolLibrary] ${message}`);
    }
  }

  window.ToolLibrary = ToolLibrary;
})();