/*!
 * @file        ui/ui-controls.js
 * @description Shared UI controls.
 *              Static methods: pure DOM utilities (focus zones, collapsibles,
 *              sidebar nav, section expand/collapse).
 *              Instance methods: renderer-aware controls (viz toggles, theme).
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
    const renderingOptions = D.rendering.defaultOptions;
    const debugState = D.debug;

    /**
     * Lightweight event emitter base class. Extend in any panel or
     * module that needs on()/off()/emit().
     */
    class EventEmitter {
        constructor() {
            this.listeners = new Map();
        }

        on(event, fn) {
            if (!this.listeners.has(event)) this.listeners.set(event, []);
            this.listeners.get(event).push(fn);
            return this;
        }

        off(event, fn) {
            const fns = this.listeners.get(event);
            if (!fns) return this;
            const idx = fns.indexOf(fn);
            if (idx !== -1) fns.splice(idx, 1);
            return this;
        }

        emit(event, data) {
            const fns = this.listeners.get(event);
            if (!fns) return;
            for (const fn of fns) {
                try { fn(data); } catch (e) { console.error(`[EventEmitter] '${event}':`, e); }
            }
        }
    }

    class UIControls {
        constructor(ui) {
            this.ui = ui;
            this.renderer = null;
        }

        // ═══════════════════════════════════════════════════════════════
        // Instance Init - called by both apps after renderer is ready
        // ═══════════════════════════════════════════════════════════════

        init(renderer) {
            this.renderer = renderer;
            this.setupVisualizationToggles();
            UIControls.setupVizPanelButton();
            this.setupThemeToggle();
        }

        // ═══════════════════════════════════════════════════════════════
        // Visualization Toggles (instance - needs renderer + ui)
        // ═══════════════════════════════════════════════════════════════

        setupVisualizationToggles() {
            if (!this.renderer) return;

            const vizControls = document.getElementById('viz-controls');
            if (!vizControls) return;

            // Set Initial State
            // Iterate over all checkboxes with a [data-option]
            vizControls.querySelectorAll('input[type="checkbox"][data-option]').forEach(el => {
                const option = el.dataset.option;
                if (option && renderingOptions[option] !== undefined) {
                    el.checked = renderingOptions[option];
                    this.renderer.options[option] = renderingOptions[option];
                }
            });

            // Set initial disabled state for dependent toggles
            const fuseToggle = document.getElementById('fuse-geometry');
            const prepToggle = document.getElementById('show-preprocessed');
            const arcToggle = document.getElementById('enable-arc-reconstruction');

            if (fuseToggle) {
                if (prepToggle) prepToggle.disabled = !fuseToggle.checked;
                if (arcToggle) arcToggle.disabled = !fuseToggle.checked;
            }

            // Special case: Debug log toggle
            const debugLogToggle = document.getElementById('debug-log-toggle');
            if (debugLogToggle) debugLogToggle.checked = debugState.enabled;

            // Attach Single Event Listener
            vizControls.addEventListener('change', async (e) => {
                const el = e.target;
                if (el.tagName !== 'INPUT' || el.type !== 'checkbox') return;

                const isChecked = el.checked;
                const option = el.dataset.option;
                const action = el.dataset.action;
                const dependencyId = el.dataset.dependency;

                // Handle Dependencies
                if (dependencyId) {
                    const depEl = document.getElementById(dependencyId);
                    if (depEl && !depEl.checked) {
                        el.checked = false;
                        this.ui.setStatus(`Enable '${depEl.labels?.[0]?.textContent || dependencyId}' first`, 'warning');
                        return;
                    }
                }

                if (option === 'showPreprocessed' && isChecked) {
                    const arc = document.getElementById('enable-arc-reconstruction');
                    if (arc?.checked) { arc.checked = false; this.renderer.setOptions({ enableArcReconstruction: false }); }
                }
                if (option === 'enableArcReconstruction' && isChecked) {
                    const prep = document.getElementById('show-preprocessed');
                    if (prep?.checked) { prep.checked = false; this.renderer.setOptions({ showPreprocessed: false }); }
                }
                if (option === 'fuseGeometry') {
                    if (prepToggle) prepToggle.disabled = !isChecked;
                    if (arcToggle) arcToggle.disabled = !isChecked;
                }

                switch (action) {
                    case 'render':
                        // Simple redraw (e.g., grid, wireframe)
                        if (option) this.renderer.setOptions({ [option]: isChecked });
                        break;
                    case 'update':
                        // Full re-process and redraw (e.g., fusion, offsets)
                        if (option) this.renderer.core.setOptions({ [option]: isChecked });
                        // Special logic for fusion/arc changes
                        if (option === 'fuseGeometry' && !isChecked) this.resetFusionStates();
                        if (option === 'fuseGeometry' || option === 'enableArcReconstruction') {
                            this.ui.core.geometryProcessor.clearCachedStates?.();
                        }
                        if (this.ui.updateRendererAsync) await this.ui.updateRendererAsync();
                        break;
                    case 'toggle-debug':
                        // Special case for the global debug flag
                        D.debug.enabled = isChecked;
                        if (this.ui.statusManager) this.ui.statusManager.setDebugVisibility(isChecked);
                        break;
                    default:
                        // For toggles that manage layer visibility directly (e.g., show-regions)
                        if (option) this.renderer.setOptions({ [option]: isChecked });
                        break;
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Theme Toggle (instance - needs renderer)
        // ═══════════════════════════════════════════════════════════════

        setupThemeToggle() {
            const btn = document.querySelector('.theme-toggle');
            if (!btn) return;

            const useEl = btn.querySelector('use');

            // Set the initial icon based on the starting theme
            const initialTheme = document.documentElement.getAttribute('data-theme') || 'dark';
            if (useEl) {
                useEl.setAttribute('href', initialTheme === 'dark' ? '#icon-sun' : '#icon-moon');
            }

            // Handle the toggle
            btn.addEventListener('click', async () => {
                let theme;
                if (window.ThemeLoader?.isLoaded()) {
                    theme = await window.ThemeLoader.toggleTheme();
                } else {
                    const root = document.documentElement;
                    theme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                    root.setAttribute('data-theme', theme);
                }

                // Swap the icon to match the newly selected theme
                if (useEl) {
                    useEl.setAttribute('href', theme === 'dark' ? '#icon-sun' : '#icon-moon');
                }

                if (this.renderer) {
                    this.renderer.setOptions({ theme });
                    this.renderer.render();
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Fusion / Arc Helpers (instance - needs renderer)
        // ═══════════════════════════════════════════════════════════════

        resetFusionStates() {
            // Reset preprocessed view and arc-reconstruction
            this.renderer.setOptions({ showPreprocessed: false, enableArcReconstruction: false });
            const prep = document.getElementById('show-preprocessed');
            const arc = document.getElementById('enable-arc-reconstruction');
            if (prep) prep.checked = false;
            if (arc) arc.checked = false;
        }

        // ═══════════════════════════════════════════════════════════════
        // Instance convenience (delegates to static)
        // ═══════════════════════════════════════════════════════════════

        collapseRightSidebar() {
            UIControls.collapseAllIn('#sidebar-right');
        }

        debug(message, data = null) {
            if (this.ui.debug) this.ui.debug(`[UIControls] ${message}`, data);
        }

        // ═══════════════════════════════════════════════════════════════
        // Static Methods - Pure DOM, no instance state required
        // ═══════════════════════════════════════════════════════════════

        /**
         * Wires all .section-header.collapsible elements. Each header needs
         * data-target pointing to its content panel.
         */
        static setupCollapsibles(rootEl) {
            const root = rootEl || document;
            root.querySelectorAll('.section-header.collapsible').forEach(header => {
                if (header.dataset.collapsibleInit) return;
                header.dataset.collapsibleInit = 'true';

                const targetId = header.getAttribute('data-target');
                const content = targetId ? document.getElementById(targetId) : null;
                const indicator = header.querySelector('.collapse-indicator');
                if (!content || !indicator) return;

                // Make header focusable
                header.setAttribute('tabindex', '0');
                header.setAttribute('role', 'button');
                header.setAttribute('aria-expanded', !content.classList.contains('collapsed'));
                if (targetId) header.setAttribute('aria-controls', targetId);
                indicator.classList.toggle('collapsed', content.classList.contains('collapsed'));

                // Click handler
                const toggle = () => {
                    content.classList.toggle('collapsed');
                    indicator.classList.toggle('collapsed');
                    header.setAttribute('aria-expanded', !content.classList.contains('collapsed'));
                };
                header.addEventListener('click', toggle);

                // Keyboard handler
                header.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
                });
            });
        }

        /**
         * ArrowUp/ArrowDown navigation across section headers and fields
         * inside a sidebar.
         */
        static setupArrowSidebarNav(sidebarSelector) {
            const sidebar = document.querySelector(sidebarSelector);
            if (!sidebar) return;

            const headers = sidebar.querySelectorAll('.section-header.collapsible');
            headers.forEach((header, idx) => {
                header.setAttribute('tabindex', idx === 0 ? '0' : '-1');
            });

            sidebar.addEventListener('keydown', (e) => {
                if (!['ArrowUp', 'ArrowDown'].includes(e.key)) return;
                const focused = document.activeElement;
                if (!sidebar.contains(focused)) return;
                e.preventDefault();

                if (focused.classList.contains('section-header')) {
                    const all = Array.from(headers);
                    const idx = all.indexOf(focused);
                    if (e.key === 'ArrowDown') {
                        const section = focused.closest('.sidebar-section');
                        const content = section?.querySelector('.section-content:not(.collapsed)');
                        if (content) {
                            const first = content.querySelector('input, select, button, [tabindex="0"]');
                            if (first) { focused.setAttribute('tabindex', '-1'); first.focus(); return; }
                        }
                        if (all[idx + 1]) {
                            focused.setAttribute('tabindex', '-1');
                            all[idx + 1].setAttribute('tabindex', '0');
                            all[idx + 1].focus();
                        }
                    } else if (all[idx - 1]) {
                        focused.setAttribute('tabindex', '-1');
                        all[idx - 1].setAttribute('tabindex', '0');
                        all[idx - 1].focus();
                    }
                    return;
                }

                if (focused.matches('input, select')) {
                    const section = focused.closest('.section-content');
                    if (!section) return;
                    const fields = Array.from(section.querySelectorAll('input, select, button'))
                        .filter(f => !f.disabled && f.closest('.property-field')?.style.display !== 'none');
                    const idx = fields.indexOf(focused);
                    const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
                    if (fields[next]) {
                        fields[next].focus();
                    } else if (e.key === 'ArrowUp' && idx === 0) {
                        const header = section.closest('.sidebar-section')?.querySelector('.section-header');
                        if (header) { header.setAttribute('tabindex', '0'); header.focus(); }
                    }
                }
            });
        }

        /**
         * Expands a specific collapsible section by header selector.
         */
        static expandSection(headerSelector) {
            const header = document.querySelector(headerSelector);
            if (!header) return;
            const targetId = header.getAttribute('data-target') || header.getAttribute('aria-controls');
            const content = targetId ? document.getElementById(targetId) : header.nextElementSibling;
            if (content && content.classList.contains('collapsed')) {
                content.classList.remove('collapsed');
                const indicator = header.querySelector('.collapse-indicator');
                if (indicator) indicator.classList.remove('collapsed');
                header.setAttribute('aria-expanded', 'true');
            }
        }

        /**
         * Collapses all collapsible sections inside a container.
         */
        static collapseAllIn(containerSelector) {
            const container = document.querySelector(containerSelector);
            if (!container) return;
            container.querySelectorAll('.section-content.collapsible').forEach(content => {
                content.classList.add('collapsed');
                const header = content.previousElementSibling;
                const indicator = header?.querySelector('.collapse-indicator');
                if (indicator) indicator.classList.add('collapsed');
                if (header) header.setAttribute('aria-expanded', 'false');
            });
        }

        /**
         * Wires the viz panel toggle button and outside-click-to-close.
         */
        static setupVizPanelButton(btnId, panelId) {
            const btn = document.getElementById(btnId || 'show-viz-panel-btn');
            const panel = document.getElementById(panelId || 'viz-panel');
            if (!btn || !panel) return;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                panel.classList.toggle('collapsed');
                btn.classList.toggle('active', !panel.classList.contains('collapsed'));
            });

            document.addEventListener('click', (e) => {
                if (!panel.classList.contains('collapsed') &&
                    !panel.contains(e.target) && !btn.contains(e.target)) {
                    panel.classList.add('collapsed');
                    btn.classList.remove('active');
                }
            });

            panel.addEventListener('click', (e) => e.stopPropagation());
        }

        /**
         * Wires zoom buttons to a renderer core.
         */
        static setupZoomControls(rendererCore, render, readout) {
            if (!rendererCore || !render) return;
            const bindings = [
                ['zoom-fit-btn', () => rendererCore.zoomFit()],
                ['zoom-in-btn',  () => rendererCore.zoomIn()],
                ['zoom-out-btn', () => rendererCore.zoomOut()]
            ];
            for (const [id, op] of bindings) {
                const el = document.getElementById(id);
                if (!el) continue;
                el.addEventListener('click', () => { op(); render(); readout?.updateZoom?.(); });
            }
        }

        /**
         * Attaches arrow-key, Enter, and Escape navigation to a property
         * form container. Used for right-sidebar parameter grids.
         */
        static setupPropertyGridNavigation(container) {
            const getNavigableItems = () => {
                return Array.from(container.querySelectorAll(
                    '.property-field, .tooltip-trigger, input:not([disabled]), select:not([disabled]), button:not([disabled])'
                )).filter(el => {
                    if (el.offsetParent === null) return false;
                    if (el.matches('input, select') && el.closest('.property-field')) return false;
                    return true;
                });
            };

            const items = getNavigableItems();
            if (items.length === 0) return;
            items.forEach((el, idx) => {
                el.setAttribute('tabindex', idx === 0 ? '0' : '-1');
            });

            if (container.dataset.hasNavListener === 'true') return;
            container.dataset.hasNavListener = 'true';

            container.addEventListener('keydown', (e) => {
                const focused = document.activeElement;
                if (!container.contains(focused)) return;

                const currentItems = getNavigableItems();
                const currentIdx = currentItems.indexOf(focused);
                const isEditing = focused.matches('input, select, textarea') &&
                                  focused.closest('.property-field');
                const isTooltip = focused.classList.contains('tooltip-trigger');

                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    if (focused.tagName === 'SELECT') return;
                    e.preventDefault();
                    if (window.TooltipManager) window.TooltipManager.hide();

                    const nextIdx = e.key === 'ArrowDown' ? currentIdx + 1 : currentIdx - 1;
                    if (currentItems[nextIdx]) {
                        focused.setAttribute('tabindex', '-1');
                        currentItems[nextIdx].setAttribute('tabindex', '0');
                        currentItems[nextIdx].focus();
                    }
                    return;
                }

                if ((e.key === 'Enter' || e.key === ' ') && focused.classList.contains('property-field')) {
                    e.preventDefault();
                    const input = focused.querySelector('input:not([disabled]), select:not([disabled])');
                    if (input) { input.focus(); if (input.select) input.select(); }
                    return;
                }

                if (e.key === 'Enter' && isEditing && !focused.matches('textarea')) {
                    e.preventDefault();
                    focused.blur();
                    const nextIdx = currentIdx + 1;
                    if (currentItems[nextIdx]) {
                        currentItems[nextIdx].setAttribute('tabindex', '0');
                        currentItems[nextIdx].focus();
                    }
                    return;
                }

                if (e.key === 'Escape') {
                    if (isEditing) {
                        e.preventDefault();
                        e.stopPropagation();
                        focused.blur();
                        const row = focused.closest('.property-field');
                        if (row) { row.setAttribute('tabindex', '0'); row.focus(); }
                    } else if (isTooltip) {
                        e.preventDefault();
                        if (window.TooltipManager) window.TooltipManager.hide();
                        const nextIdx = currentIdx + 1;
                        if (currentItems[nextIdx]) {
                            focused.setAttribute('tabindex', '-1');
                            currentItems[nextIdx].setAttribute('tabindex', '0');
                            currentItems[nextIdx].focus();
                        }
                    }
                }
            });
        }

        /**
         * Attaches standard tree keyboard navigation to a container.
         * Works for NavScenePanel, NavTreePanel and NavOperationsPanel.
         *
         * @param {HTMLElement} container - The tree container element
         * @param {string} rowSelector - CSS selector for navigable rows
         * @param {Object} callbacks
         * @param {Function} callbacks.onSelect - (id, e) called on Enter/Space
         * @param {Function} callbacks.onDelete - (id, e) called on Delete
         * @param {Function} [callbacks.onExpand] - (id) called on ArrowRight for groups
         * @param {Function} [callbacks.onCollapse] - (id) called on ArrowLeft for groups
         */
        static setupTreeKeyboard(container, rowSelector, callbacks) {
            if (!container) return;

            container.addEventListener('keydown', (e) => {
                const focused = document.activeElement;
                if (!container.contains(focused)) return;

                const rows = Array.from(container.querySelectorAll(rowSelector));
                const idx = rows.indexOf(focused);
                if (idx === -1) return;

                const id = focused.dataset.pathId || focused.dataset.groupId ||
                           focused.dataset.bucketId || focused.dataset.fileId;

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        if (rows[idx + 1]) {
                            focused.setAttribute('tabindex', '-1');
                            rows[idx + 1].setAttribute('tabindex', '0');
                            rows[idx + 1].focus();
                        }
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        if (rows[idx - 1]) {
                            focused.setAttribute('tabindex', '-1');
                            rows[idx - 1].setAttribute('tabindex', '0');
                            rows[idx - 1].focus();
                        }
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        if (callbacks.onExpand && id) callbacks.onExpand(id, focused);
                        break;
                    case 'ArrowLeft':
                        e.preventDefault();
                        if (callbacks.onCollapse) callbacks.onCollapse(id, focused, rows, idx);
                        break;
                    case 'Enter': case ' ':
                        e.preventDefault();
                        if (callbacks.onSelect && id) callbacks.onSelect(id, e);
                        break;
                    case 'Delete': case 'Backspace':
                        e.preventDefault();
                        if (callbacks.onDelete && id) callbacks.onDelete(id, focused);
                        break;
                    case 'Home':
                        e.preventDefault();
                        if (rows[0]) { focused.setAttribute('tabindex', '-1'); rows[0].setAttribute('tabindex', '0'); rows[0].focus(); }
                        break;
                    case 'End':
                        e.preventDefault();
                        if (rows.length) { const last = rows[rows.length - 1]; focused.setAttribute('tabindex', '-1'); last.setAttribute('tabindex', '0'); last.focus(); }
                        break;
                }
            });
        }
    }

    window.EventEmitter = EventEmitter;
    window.UIControls = UIControls;
})();