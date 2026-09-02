/*!
 * @file        ui/tool-library.js
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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

    class ToolLibrary {
        constructor() {
            this.tools = [];
            this.toolsById = new Map();
            this.toolsByType = new Map();
            this.toolsByOperation = new Map();

            this.isLoaded = false;
            this.loadError = null;
        }

        async init(appProfile = null) {
            this.appProfile = appProfile;
            if (this.isLoaded) return true;

            // PROD: Use the array injected by build.js
            if (typeof EMBEDDED_TOOLS !== 'undefined') {
                this.importTools(EMBEDDED_TOOLS);
                this.isLoaded = true;
                this.debug(`Loaded ${this.tools.length} embedded tools`);
                return true;
            }

            // DEV: Fetch the JSON file directly.
            const loaded = await this.loadFromFile('../tools.json');
            if (!loaded) {
                throw new Error("[ToolLibrary] ToolLibrary failed to load tools.json in development mode.");
            }

            return true;
        }

        /**
         * Three tool sizes, and every consumer names the one it means.
         *     diameter  - the tool's diameter. maxDiameter for a tapered bit, the
         *                 plain diameter otherwise. One meaning for every tool in
         *                 every form, and what a V-carve's reach clamp reads.
         *     tipRadius - the flat or ball at the very tip. V-carve only.
         *     effective - the width a tapered bit actually cuts at engraving
         *                 depth. DECLARED per tool, not derived: it depends on how
         *                 deep the operator runs and on how the bit was ground.
         *                 Copper operations read this and ignore the diameter.
         * For a straight bit the first and third are the same number, which is why
         * only isolation, clearing and engrave declare toolSizing: 'effective'.
         */
        static isTapered(tool) {
            return tool?.type === 'v_bit' || tool?.type === 'tapered_ball';
        }

        getToolDiameter(toolId) {
            const g = this.getTool(toolId)?.geometry;
            return g ? (g.maxDiameter ?? g.diameter ?? null) : null;
        }

        getEffectiveDiameter(toolId) {
            const tool = this.getTool(toolId);
            if (!tool?.geometry) return null;
            if (!ToolLibrary.isTapered(tool)) return this.getToolDiameter(toolId);
            return tool.geometry.effectiveDiameter ?? tool.geometry.tipDiameter;
        }

        getToolSizes(toolId) {
            const tool = this.getTool(toolId);
            if (!tool) return null;
            const g = tool.geometry || {};
            return {
                tapered: ToolLibrary.isTapered(tool),
                diameter: this.getToolDiameter(toolId),
                effective: this.getEffectiveDiameter(toolId),
                tipRadius: (g.tipDiameter ?? 0) / 2,
                angle: g.angle ?? g.angleDeg ?? null,
                cornerRadius: g.cornerRadius,
                tipType: g.tipType
            };
        }

        async loadFromFile(url) {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`[ToolLibrary] HTTP error loading tools: ${response.status}`);
            }

            const data = await response.json();
            if (!data.tools || !Array.isArray(data.tools)) {
                throw new Error('[ToolLibrary] Invalid tools.json format: Missing "tools" array');
            }

            this.tools = [];
            this.toolsById.clear();
            this.toolsByType.clear();
            this.toolsByOperation.clear();

            data.tools.forEach(tool => this.addTool(tool)); // Assume validateTool throws if invalid

            this.isLoaded = true;
            this.debug(`Loaded ${this.tools.length} tools from ${url}`);
            return true;
        }

        addTool(tool) {
            this.tools.push(tool);
            this.toolsById.set(tool.id, tool);

            // Index by type
            if (!this.toolsByType.has(tool.type)) {
                this.toolsByType.set(tool.type, []);
            }
            this.toolsByType.get(tool.type).push(tool);

            // Index by operations
            if (tool.operations && Array.isArray(tool.operations)) {
                tool.operations.forEach(op => {
                    if (!this.toolsByOperation.has(op)) {
                        this.toolsByOperation.set(op, []);
                    }
                    this.toolsByOperation.get(op).push(tool);
                });
            }
        }

        validateTool(tool) {
            // Grab an identifier for the error message so you know exactly which tool broke
            const toolIdentifier = tool.id || tool.name || 'Unknown Tool';

            const required = ['id', 'name', 'type', 'geometry', 'cutting', 'operations'];

            // Check top-level required fields
            for (const field of required) {
                if (!tool[field]) {
                    throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' is missing required field '${field}'.`);
                }
            }

            // Check required geometry properties based on tool type
            if (tool.type === 'v_bit' || tool.type === 'tapered_ball') {
                // Tip, angle and max are load-time requirements: they seed
                // vbitTipRadius, vbitAngle and toolDiameter with no fallback
                // behind them. effectiveDiameter is optional and falls back to
                // the tip, but a value wider than the bit is a typo, not a
                // preference.
                if (!(tool.geometry.tipDiameter > 0)) throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' needs a positive 'geometry.tipDiameter'.`);
                if (!((tool.geometry.angle ?? tool.geometry.angleDeg) > 0)) throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' needs 'geometry.angle' (v-bit, included) or 'geometry.angleDeg' (tapered ball, per side).`);
                if (!(tool.geometry.maxDiameter > 0)) throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' needs a positive 'geometry.maxDiameter'.`);
                if (tool.geometry.effectiveDiameter != null &&
                    !(tool.geometry.effectiveDiameter > 0 && tool.geometry.effectiveDiameter <= tool.geometry.maxDiameter)) {
                    throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' has a 'geometry.effectiveDiameter' outside (0, maxDiameter].`);
                }
            } else if (tool.geometry.diameter === undefined || tool.geometry.diameter === null) {
                throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' is missing 'geometry.diameter'.`);
            }

            // Check required cutting properties
            const cuttingRequired = ['feedRate', 'plungeRate', 'spindleSpeed'];
            for (const field of cuttingRequired) {
                if (tool.cutting[field] === undefined || tool.cutting[field] === null) {
                    throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' is missing 'cutting.${field}'.`);
                }
            }

            // Optional: toolNumber, when present, identifies a magazine/
            // carousel slot for future tool-change UI and logic.
            if (tool.toolNumber != null &&
                (!Number.isInteger(tool.toolNumber) || tool.toolNumber <= 0)) {
                throw new Error(`[Fatal] Tool validation failed: Tool '${toolIdentifier}' has an invalid toolNumber (must be a positive integer).`);
            }

            return true;
        }

        getTool(id) {
            return this.toolsById.get(id) || null;
        }

        getToolsByType(type) {
            return this.toolsByType.get(type) || [];
        }

        getToolsForOperation(operationType) {
            return this.toolsByOperation.get(operationType) || [];
        }

        getDefaultToolForOperation(operationType) {
            // Profile default, via the operation registry
            const defaultId = this.registry?.defaultToolFor(operationType);
            if (defaultId) {
                const tool = this.getTool(defaultId);
                if (tool) return tool;
            }

            // Fallback to first compatible tool
            const compatibleTools = this.getToolsForOperation(operationType);
            return compatibleTools[0] || null;
        }

        getToolCategories() {
            const categories = new Set();
            this.tools.forEach(tool => {
                if (tool.category) {
                    categories.add(tool.category);
                }
            });
            return Array.from(categories);
        }

        getToolsByCategory(category) {
            return this.tools.filter(tool => tool.category === category);
        }

        // Export tool library for backup/sharing
        exportTools() {
            return {
                version: 1,
                timestamp: new Date().toISOString(),
                tools: this.tools
            };
        }

        // Import tools from JSON
        importTools(data) {
            if (!data || !data.tools || !Array.isArray(data.tools)) {
                throw new Error('Invalid tool import data');
            }

            const imported = [];
            const failed = [];
            // Seed with toolNumbers already in the loaded library so a
            // custom import can't silently collide with a built-in tool.
            const seenToolNumbers = new Map(); // toolNumber -> id
            for (const t of this.tools) {
                if (t.toolNumber != null) seenToolNumbers.set(t.toolNumber, t.id);
            }

            data.tools.forEach(tool => {
                const label = tool?.id || tool?.name || 'unknown';

                // validateTool THROWS on the first bad field - one malformed
                // tool in a custom upload must not abort the whole batch.
                try {
                    this.validateTool(tool);
                } catch (e) {
                    failed.push({ id: label, reason: e.message });
                    return;
                }

                if (this.toolsById.has(tool.id)) {
                    failed.push({ id: tool.id, reason: 'Duplicate ID' });
                    return;
                }
                if (tool.toolNumber != null) {
                    if (seenToolNumbers.has(tool.toolNumber)) {
                        failed.push({
                            id: tool.id,
                            reason: `Duplicate toolNumber ${tool.toolNumber} (already used by ${seenToolNumbers.get(tool.toolNumber)})`
                        });
                        return;
                    }
                    seenToolNumbers.set(tool.toolNumber, tool.id);
                }

                this.addTool(tool);
                imported.push(tool.id);
            });

            return {
                imported,
                failed,
                total: data.tools.length
            };
        }

        /**
         * Imports a user-supplied tools.json (drag-and-drop / file picker).
         * Thin wrapper isolating the one extra failure mode a raw file
         * introduces - invalid JSON - behind the same result shape as
         * importTools(), so the UI (whenever it's wired) has one path to
         * handle either way.
         * @param {string} jsonText - raw file contents
         * @returns {{success:boolean, imported:string[], failed:Array, total:number, error?:string}}
         * 
         * Not Wired
         */
        importFromJSONText(jsonText) {
            let data;
            try {
                data = JSON.parse(jsonText);
            } catch (e) {
                return { success: false, imported: [], failed: [], total: 0, error: `Invalid JSON: ${e.message}` };
            }
            try {
                const result = this.importTools(data);
                return { success: true, ...result };
            } catch (e) {
                return { success: false, imported: [], failed: [], total: 0, error: e.message };
            }
        }

        // REVIEW - Dead code? Worth keeping?
        logToolStats() {
            if (debugState.enabled) {
                console.log('[ToolLibrary] Statistics:');
                console.log(`   Total tools: ${this.tools.length}`);
                console.log(`   Tool types: ${Array.from(this.toolsByType.keys()).join(', ')}`);
                console.log(`   Operations covered: ${Array.from(this.toolsByOperation.keys()).join(', ')}`);

                this.toolsByType.forEach((tools, type) => {
                    console.log(`   ${type}: ${tools.length} tools`);
                });
            }
        }

        debug(message, data = null) {
            if (!D.debug.enabled) return;
            if (data !== null) {
                console.log(`[ToolLibrary] ${message}`, data);
            } else {
                console.log(`[ToolLibrary] ${message}`);
            }
        }
    }

    window.ToolLibrary = ToolLibrary;
})();