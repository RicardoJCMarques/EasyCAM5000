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

    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

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
                this.strings = data;
                this.isLoaded = true;
                this.debug(`[Lang] Language pack '${lang}' loaded.`);
            } catch (err) {
                console.error('[Lang] Failed to load language file:', err);
                this.strings = {}; // Fallback to empty
                this.isLoaded = false;
            }
        }

        /**
         * Looks a dotted key up in the loaded strings. Sections come in two
         * shapes - nested (params.toolDiameter, drill.tooling.title) and flat,
         * where the whole rest of the path is one key (ui, messages and gcode
         * hold "modals.exporter.zip") - so at each level the rest of the key is
         * tried whole before descending one segment. Own properties only, so
         * a key like "toString" misses instead of returning a prototype method.
         * @returns {*} the value, or undefined on a miss
         */
        resolve(key) {
            const parts = String(key).split('.');
            let node = this.strings;
            for (let i = 0; i < parts.length; i++) {
                if (node === null || typeof node !== 'object') return undefined;
                const rest = parts.slice(i).join('.');
                if (Object.hasOwn(node, rest)) return node[rest];
                if (!Object.hasOwn(node, parts[i])) return undefined;
                node = node[parts[i]];
            }
            return undefined;
        }

        /**
         * Gets a string by its key.
         */
        get(key, defaultValue = '') {
            if (!this.isLoaded) {
                console.warn(`[Lang] Tried to get key "${key}" before strings were loaded.`);
            }
            const value = this.resolve(key);
            return value !== undefined ? value : defaultValue;
        }

        /**
         * Objects pass through; a bare string becomes { help }. Returns {}
         * for a miss so callers can destructure without guarding.
         */
        entry(key) {
            const v = this.get(key, null);
            if (v && typeof v === 'object') return v;
            if (typeof v === 'string') return { help: v };
            return {};
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[LanguageManager] ${message}`, data)
                 : console.log(`[LanguageManager] ${message}`);
        }
    }

    window.LanguageManager = LanguageManager;
})();