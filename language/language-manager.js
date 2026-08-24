/*!
 * @file        language/language-manager.js
 * @description Language & translation manager
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

    class LanguageManager {
        constructor() {
            this.strings = {};
            this.isLoaded = false;
        }

        /**
         * Loads the language file from the server.
         */
        async load(lang = 'en') {
            try {
                const response = await fetch(`../language/${lang}.json`);
                if (!response.ok) {
                    throw new Error(`Failed to load ../language/${lang}.json: ${response.statusText}`);
                }
                const data = await response.json();
                // v2 schema has no `strings` wrapper - the namespaces are top level.
                // `data.strings` is the v1 shape, kept so a stale file still loads.
                // REVIEW - Is this fallback still necessary?
                this.strings = data.strings || data;
                this.isLoaded = true;
                console.log(`[Lang] Language pack '${lang}' loaded.`);
            } catch (err) {
                console.error('[Lang] Failed to load language file:', err);
                this.strings = {}; // Fallback to empty
                this.isLoaded = false;
            }
        }

        /**
         * Gets a string by its key.
         */
        get(key, defaultValue = '') {
            if (!this.isLoaded) {
                console.warn(`[Lang] Tried to get key "${key}" before strings were loaded.`);
            }

            // REVIEW - Can this be optimized?
            // This reducer handily navigates nested JSON keys 'tooltips.toolDiameter' -> this.strings['tooltips']['toolDiameter']
            try {
                const value = key.split('.').reduce((obj, k) => obj[k], this.strings);
                return value !== undefined ? value : defaultValue;
            } catch (e) {
                return defaultValue; // Key path was invalid
            }
        }

        /**
         * Checks if a translation key exists.
         */
        has(key) {
            try {
                // This logic is similar to get(), but returns true/false
                const value = key.split('.').reduce((obj, k) => obj[k], this.strings);
                return value !== undefined;
            } catch (e) {
                return false; // Key path was invalid
            }
        }

       /**
         * A v2 entry. Objects pass through; a bare string becomes { help }.
         * Returns {} for a miss so callers can destructure without guarding.
         */
        entry(key) {
            const v = this.get(key, null);
            if (v && typeof v === 'object') return v;
            if (typeof v === 'string') return { help: v };
            return {};
        }

        /**
         * Returns an entire section as a flat object, or null if not found.
         * Useful for bulk-loading comment strings for export pipelines.
         * Example: getSection('gcode.comments') returns { header: "...", date: "...", ... }
         */
        getSection(key) {
            try {
                const section = key.split('.').reduce((obj, k) => obj[k], this.strings);
                return (section && typeof section === 'object') ? section : null;
            } catch (e) {
                return null;
            }
        }

        /**
         * Gets a string by key and replaces {placeholder} tokens with values.
         * Example: format('gcode.comments.date', { date: '2025-01-01' })
         *          → "Date: 2025-01-01"
         */
        format(key, replacements = {}) {
            let str = this.get(key, '');
            for (const [token, value] of Object.entries(replacements)) {
                str = str.replace(new RegExp(`\\{${token}\\}`, 'g'), value);
            }
            return str;
        }
    }

    window.LanguageManager = LanguageManager;
})();