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

  /*
    * Theme contract.
    *
    * The default theme is css/theme.css, which sync-theme.js generates from
    * themes/dark.json, so a page on the default fetches no theme file. Every
    * other theme is a JSON file declaring every key dark.json declares (no
    * partial themes: sync-theme.js refuses a shipped one that is not
    * complete), applied as inline custom properties on <html>. A switch
    * removes the previous theme's properties first, so switching to the
    * default restores theme.css as it is.
    *
    * A theme may declare `base` ('dark' | 'light', applied as data-theme-base
    * for the few CSS rules that need light/dark branching - never key a
    * selector on a theme id) and `tokens`, applied with no prefix.
    *
    * A theme without `label` is captioned by the language pack
    * (params.theme.options.<id>); a theme with one is a name and shows as
    * written. The shipped themes carry none.
    */
  const DEFAULT_THEME = 'dark';

  // Palette group -> custom-property prefix. sync-theme.js keeps a copy.
  const GROUPS = {
    background: 'color-bg',
    text: 'color-text',
    border: 'color-border',
    accent: 'color-accent',
    semantic: 'color',
    operations: 'color-operation',
    render2d: 'color-render2d',
    render3d: 'color-render3d',
    debug: 'color-debug',
    geometry: 'color-geometry',
    primitives: 'color-primitive',
    bw: 'color-bw',
    pipelines: 'color-pipeline',
    interaction: 'color-interaction'
  };

  const kebab = key => key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());

  class ThemeLoader {
    constructor() {
      this.currentTheme = DEFAULT_THEME;
      // The doc and landing pages load no config.js: the key is the one config.js names.
      this.storageKey = window.CAMConfig?.constants.storageKeys.theme ?? 'cam-theme';
      this.initialized = false;
      // id -> { url, theme }: a URL is fetched on first use; the default
      // has neither, theme.css holds it.
      this.entries = new Map();
      // Custom properties the current theme set inline.
      this.applied = [];
      this.register(DEFAULT_THEME, null);
      // Root-absolute: fetch resolves a relative URL against the page, and the pages that
      // load this file sit at different depths (the landing page, each app, their docs).
      this.register('light', '/themes/light.json');
      this.register('hc-dark', '/themes/hc-dark.json');
      this.register('hc-light', '/themes/hc-light.json');
      // The shipped themes; a custom file may not take one of their ids.
      this.builtIn = new Set(this.entries.keys());
      // The custom theme, kept by CustomFiles in its one slot. A page that
      // does not load it (the docs) offers the shipped themes only.
      const record = window.CustomFiles?.slot('theme');
      if (record && this.builtIn.has(record.id)) {
        // A shipped theme took its id: the stored copy can never show.
        window.CustomFiles.discard('theme', record.id);
      } else if (record) {
        this.register(record.id, record.data);
      }
    }

    /**
     * Offers a theme to list() and applyTheme(). Registering an id again
     * replaces it.
     * @param {string} id
     * @param {string|Object|null} source - a URL, a parsed theme, or null
     *   for the default
     */
    register(id, source) {
      const url = typeof source === 'string' ? source : null;
      this.entries.set(id, { url, theme: url ? null : source });
    }

    /**
     * Withdraws a theme from list() and applyTheme(). When it is the
     * current theme, moving the page off it is the caller's.
     * @param {string} id
     */
    unregister(id) {
      this.entries.delete(id);
    }

    /**
     * Registered themes in registration order, for a picker.
     * @returns {Array<{id: string, label: string|null}>} label is null when
     *  the language pack captions the theme
     */
    list() {
      return [...this.entries].map(([id, { theme }]) => ({ id, label: theme?.label ?? null }));
    }

    /**
     * Applies the saved theme. It does not save: a page that falls back to
     * the default (an id it does not register) leaves the choice alone.
     */
    async init() {
      if (this.initialized) return true;
      let saved = null;
      try {
        saved = localStorage.getItem(this.storageKey);
      } catch {
        // Storage blocked (private mode, sandboxed frame)
      }
      // The custom theme stays while it is the one chosen: a load that
      // finds another choice deletes it.
      for (const id of [...this.entries.keys()]) {
        if (this.builtIn.has(id) || id === saved) continue;
        this.unregister(id);
        window.CustomFiles?.discard('theme', id);
      }
      const themeId = this.entries.has(saved) ? saved : DEFAULT_THEME;
      try {
        await this.applyTheme(themeId, { save: false });
        this.initialized = true;
        return true;
      } catch (error) {
        console.error('Theme initialization failed, falling back to static CSS:', error);
        await this.applyTheme(DEFAULT_THEME, { save: false });
        return false;
      }
    }

    /**
     * @param {string} themeId
     * @param {{save?: boolean}} [options] - save: false applies without
     *  remembering the choice
     * @returns {Promise<boolean>} false for an id nothing registered
     */
    async applyTheme(themeId, { save = true } = {}) {
      const entry = this.entries.get(themeId);
      if (!entry) {
        console.warn(`Theme ${themeId} not found`);
        return false;
      }
      const theme = themeId === DEFAULT_THEME ? null : entry.theme ?? await this.loadTheme(themeId, entry);
      const root = document.documentElement;
      for (const name of this.applied) root.style.removeProperty(name);
      this.applied = theme ? this.applyColorVariables(theme.colors, theme.tokens) : [];
      root.setAttribute('data-theme', themeId);
      // theme.base ('dark' | 'light') is the only thing CSS may ever
      // branch on for light/dark-specific rules - never the id itself,
      // which becomes arbitrary once themes are drop-in. theme.css is
      // dark.json, so the default's base is dark.
      root.setAttribute('data-theme-base', theme?.base || 'dark');
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(root).getPropertyValue('--color-bg-secondary').trim());
      if (save) {
        try {
          localStorage.setItem(this.storageKey, themeId);
        } catch {
          // Storage blocked: the choice lasts for this page load only.
        }
      }
      this.currentTheme = themeId;
      window.dispatchEvent(new CustomEvent('themechange', { detail: { themeId, theme } }));
      return true;
    }

    /**
     * A shipped theme to check a custom one against: one already loaded,
     * else the first with a file, which then stays cached for a switch.
     * The default has no file (theme.css holds it); every shipped theme
     * declares the same keys in the same forms.
     * @returns {Promise<Object>}
     */
    async reference() {
      const shipped = [...this.builtIn].map(id => [id, this.entries.get(id)]);
      const loaded = shipped.find(([, entry]) => entry.theme);
      if (loaded) return loaded[1].theme;
      const [id, entry] = shipped.find(([, entry]) => entry.url);
      return this.loadTheme(id, entry);
    }

    async loadTheme(themeId, entry) {
      const response = await fetch(entry.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      entry.theme = await response.json();
      this.validateColors(themeId, entry.theme.colors);
      return entry.theme;
    }

    /*
      * One validation pass at load. A malformed value fails differently at
      * every consumer - canvas silently ignores an invalid strokeStyle, CSS
      * drops the declaration - so a theme is checked once, here, loudly, and
      * fixed at its source rather than repaired. Hex must be 6-digit: the
      * palette is deliberately opaque (overlapping transparency is
      * unmanageable); the rgba() scrims are the one translucent exception.
      */
    validateColors(themeId, colors, path = '') {
      if (!colors || typeof colors !== 'object') return;
      for (const [key, value] of Object.entries(colors)) {
        const where = path ? `${path}.${key}` : key;
        if (value !== null && typeof value === 'object') {
          this.validateColors(themeId, value, where);
        } else if (typeof value === 'string' && (/^#[0-9a-f]{8}$/i.test(value) || !CSS.supports('color', value))) {
          console.error(`[Theme:${themeId}] ${where} "${value}" is not a valid opaque CSS color.`);
        }
      }
    }

    /**
     * Writes a theme's colours and tokens as inline custom properties.
     * @returns {string[]} the property names written
     */
    applyColorVariables(colors, tokens = {}) {
      const root = document.documentElement;
      const written = [];
      const set = (name, value) => {
        root.style.setProperty(name, value);
        written.push(name);
      };
      const flatten = (prefix, group) => {
        for (const [key, value] of Object.entries(group)) {
          const name = `${prefix}-${kebab(key)}`;
          if (value !== null && typeof value === 'object') flatten(name, value);
          else set(`--${name}`, value);
        }
      };
      for (const [group, prefix] of Object.entries(GROUPS)) {
        if (colors[group]) flatten(prefix, colors[group]);
      }
      // Structure/sizing overrides. NO prefix - a theme's tokens.shadow-sm
      // becomes --shadow-sm directly
      for (const [name, value] of Object.entries(tokens ?? {})) {
        set(`--${name}`, value);
      }
      return written;
    }

    /**
     * The toolbar's sun/moon button: flips the base and keeps the contrast
     * family. High contrast trades hc-dark and hc-light; dark, light and any
     * custom theme land on the shipped theme of the other base.
     * @returns {Promise<string>} the theme applied
     */
    async toggleTheme() {
      const toLight = document.documentElement.getAttribute('data-theme-base') !== 'light';
      const highContrast = this.currentTheme === 'hc-dark' || this.currentTheme === 'hc-light';
      const newTheme = highContrast ? (toLight ? 'hc-light' : 'hc-dark') : (toLight ? 'light' : 'dark');
      await this.applyTheme(newTheme);
      return newTheme;
    }
  }

  window.ThemeLoader = new ThemeLoader();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.ThemeLoader.init());
  } else {
    window.ThemeLoader.init();
  }
})();