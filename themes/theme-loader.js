/*!
 * @file        theme-loader.js
 * @description Theme loading and switching utility
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ThemeLoader {
        constructor() {
            this.currentTheme = 'dark'; // Matches CSS default
            this.themes = new Map();
            // Safely fallback if CAMConfig isn't loaded (e.g., on the root index or docs)
            this.storageKey = window.CAMConfig?.constants?.storageKeys?.theme || 'cam-theme';
            this.initialized = false;

            // Registry of available themes and their paths
            this.themeRegistry = {
                'dark': '/themes/dark.json',
                'light': '/themes/light.json'
            };
        }

        async init(defaultTheme = 'dark') {
            if (this.initialized) return true;

            const savedTheme = localStorage.getItem(this.storageKey) || defaultTheme;

            // The JSON is applied for EVERY theme, including the default
            // Note theme.css is synced from dark.json with an external script.
            document.documentElement.setAttribute('data-theme', savedTheme);
            try {
                await this.applyTheme(savedTheme);
                this.initialized = true;
                return true;
            } catch (error) {
                console.error('Theme initialization failed, falling back to static CSS:', error);
                this.currentTheme = savedTheme;
                return false;
            }
        }

        async applyTheme(themeId) {
            // Check if already loaded in memory
            if (!this.themes.has(themeId)) {

                // If not, check if it can be found
                if (this.themeRegistry[themeId]) {
                    // Lazy load it now
                    await this.loadTheme(themeId, this.themeRegistry[themeId]);
                } else {
                    console.warn(`Theme ${themeId} not found`);
                    return false;
                }
            }

            const theme = this.themes.get(themeId);

            // DOM Updates
            document.documentElement.setAttribute('data-theme', themeId);
            this.applyColorVariables(theme.colors); // Overwrites the static CSS vars

            document.querySelector('meta[name="theme-color"]').setAttribute(
                'content', 
                themeId === 'dark' ? '#1a1a1a' : '#f8f9fa'
            );

            // Persist
            localStorage.setItem(this.storageKey, themeId);
            this.currentTheme = themeId;

            window.dispatchEvent(new CustomEvent('themechange', {
                detail: { themeId, theme }
            }));

            return true;
        }

        async loadTheme(id, url) {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const themeData = await response.json();
            this.normalizeColors(id, themeData.colors);
            this.themes.set(id, themeData);
            return themeData;
        }

        /**
         * One validation pass at load instead of per-consumer repair.
         *
         * A malformed value fails differently at every consumer: canvas
         * silently ignores an invalid strokeStyle, CSS drops the declaration,
         * the SVG exporter had grown its own stripAlpha. Themes are becoming
         * user-supplied, so they get checked once, here, loudly.
         *
         * Repairs: bare 6/8-digit hex missing '#', 8-digit hex trimmed to 6
         * (the palette is deliberately opaque - overlapping transparency is
         * unmanageable). Anything else is reported and left alone.
         */
        // REVIEW - This is a band-aid, everything should just be setup correctly from the start.
        normalizeColors(themeId, colors, path = '') {
            if (!colors || typeof colors !== 'object') return;

            for (const [key, value] of Object.entries(colors)) {
                const where = path ? `${path}.${key}` : key;

                if (value !== null && typeof value === 'object') {
                    this.normalizeColors(themeId, value, where);
                    continue;
                }
                if (typeof value !== 'string') continue;

                let v = value.trim();

                if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{8}$/.test(v)) {
                    console.warn(`[Theme:${themeId}] ${where} "${v}" is missing '#' - repaired.`);
                    v = `#${v}`;
                }
                if (/^#[0-9a-fA-F]{8}$/.test(v)) {
                    console.warn(`[Theme:${themeId}] ${where} "${v}" carries alpha - trimmed to 6 digits.`);
                    v = v.slice(0, 7);
                }
                if (!/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) &&
                    !/^(rgb|hsl)a?\(/.test(v) && !CSS.supports('color', v)) {
                    console.error(`[Theme:${themeId}] ${where} "${v}" is not a valid CSS color.`);
                }

                colors[key] = v;
            }
        }

        applyColorVariables(colors) {
            const root = document.documentElement;
            const set = (k, v) => root.style.setProperty(k, v);

            const flatten = (prefix, obj) => {
                Object.entries(obj).forEach(([key, value]) => {
                    const kebabKey = key.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
                    const newPrefix = prefix ? `${prefix}-${kebabKey}` : kebabKey;

                    if (typeof value === 'object' && value !== null) {
                        flatten(newPrefix, value);
                    } else {
                        set(`--${newPrefix}`, value);
                    }
                });
            };

            // Palette groups only. Application-level mappings (which operation
            // type uses which palette entry) live in each app's layout CSS as
            // --op-color-<type> and are never emitted from here.
            if (colors.background) flatten('color-bg', colors.background);
            if (colors.text) flatten('color-text', colors.text);
            if (colors.border) flatten('color-border', colors.border);
            if (colors.accent) flatten('color-accent', colors.accent);
            if (colors.semantic) flatten('color', colors.semantic);
            if (colors.operations) flatten('color-operation', colors.operations);
            if (colors.render2d) flatten('color-render2d', colors.render2d);
            if (colors.render3d) flatten('color-render3d', colors.render3d);
            if (colors.debug) flatten('color-debug', colors.debug);
            if (colors.geometry) flatten('color-geometry', colors.geometry);
            if (colors.primitives) flatten('color-primitive', colors.primitives);
            if (colors.bw) flatten('color-bw', colors.bw);
            if (colors.pipelines) flatten('color-pipeline', colors.pipelines);
            if (colors.render3d) flatten('color-render3d', colors.render3d);
            if (colors.interaction) flatten('color-interaction', colors.interaction);
        }

        async toggleTheme() {
            const newTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
            await this.applyTheme(newTheme);
            return newTheme;
        }

        getCurrentTheme() { return this.currentTheme; }
        isLoaded() { return this.initialized; }
    }

    window.ThemeLoader = new ThemeLoader();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.ThemeLoader.init());
    } else {
        window.ThemeLoader.init();
    }
})();