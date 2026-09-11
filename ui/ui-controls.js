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
                    this.renderer.setOptions({ [option]: renderingOptions[option] });
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

            // Global verbose-debug flag
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
                        if (option) this.renderer.setOptions({ [option]: isChecked });
                        // Special logic for fusion/arc changes
                        if (option === 'fuseGeometry' && !isChecked) this.resetFusionStates();
                        if (option === 'fuseGeometry' || option === 'enableArcReconstruction') {
                            this.ui.core.geometryProcessor.clearCachedStates?.();
                        }
                        if (this.ui.rebuildLayers) await this.ui.rebuildLayers();
                        break;
                    case 'toggle-debug':
                        D.debug.enabled = isChecked;
                        this.ui.statusManager.renderLog?.();
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
                const theme = await window.ThemeLoader.toggleTheme();

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
                // Native stepping owns arrows on these; taking them costs the
                // user the only keyboard way to change the value.
                if (focused.tagName === 'SELECT' || focused.type === 'number') return;
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
         * @param {Function} [onStatus] - (message, level) for reorder feedback.
         * A shared control cannot reach the app singleton for this: a global
         * lookup is untestable and no-ops silently before the app is ready.
         */
        static makeSortable(container, rowSelector, onStatus = null) {
            let draggedItem = null;
            container.addEventListener("dragstart", e => {
                if (!container.classList.contains("is-orderable")) {
                    e.preventDefault();
                    return;
                }
                const targetItem = e.target.closest(rowSelector);
                if (targetItem && container.contains(targetItem) && !targetItem.dataset.locked) {
                    draggedItem = targetItem;
                    draggedItem.classList.add("dragging");
                    e.dataTransfer.effectAllowed = "move";
                } else e.preventDefault();
            });
            container.addEventListener("dragend", () => {
                if (draggedItem) {
                    draggedItem.classList.remove("dragging");
                    draggedItem = null;
                }
            });
            container.addEventListener("dragover", e => {
                e.preventDefault();
                if (!draggedItem) return;
                const afterElement = UIControls.getDragAfterElement(container, e.clientY, rowSelector);
                if (null == afterElement) {
                    const firstLocked = container.querySelector(`${rowSelector}[data-locked="true"]`);
                    firstLocked ? container.insertBefore(draggedItem, firstLocked) : container.appendChild(draggedItem);
                } else if (afterElement.dataset.locked !== 'true') {
                    container.insertBefore(draggedItem, afterElement);
                }
            });
            container.querySelectorAll(rowSelector).forEach((item, idx) => {
                item.draggable = true;
                item.setAttribute("tabindex", 0 === idx ? "0" : "-1");
                item.setAttribute("role", "listitem");
                item.setAttribute("aria-grabbed", "false");
            });
            container.addEventListener("keydown", e => {
                const focused = document.activeElement;
                if (!focused || !focused.matches(rowSelector) || !container.contains(focused)) return;
                const items = Array.from(container.querySelectorAll(rowSelector));
                const isGrabbed = "true" === focused.getAttribute("aria-grabbed");
                if (" " === e.key) {
                    e.preventDefault();
                    if (!container.classList.contains("is-orderable") || focused.dataset.locked) return;
                    if (isGrabbed) {
                        focused.setAttribute("aria-grabbed", "false");
                        focused.classList.remove("is-grabbed");
                        onStatus?.('Item placed', 'info');
                    } else {
                        items.forEach(item => {
                            item.setAttribute("aria-grabbed", "false");
                            item.classList.remove("is-grabbed");
                        });
                        focused.setAttribute("aria-grabbed", "true");
                        focused.classList.add("is-grabbed");
                        onStatus?.('Item grabbed. Use Up/Down to move, Space to place.', 'info');
                    }
                }
                if ("ArrowDown" === e.key || "ArrowUp" === e.key) {
                    e.preventDefault();
                    const idx = items.indexOf(focused);
                    const targetIdx = "ArrowDown" === e.key ? idx + 1 : idx - 1;
                    if (isGrabbed) {
                        const sibling = "ArrowDown" === e.key ? focused.nextElementSibling : focused.previousElementSibling;
                        if (sibling && sibling.matches(rowSelector) && !sibling.dataset.locked) {
                            "ArrowUp" === e.key ? container.insertBefore(focused, sibling) : container.insertBefore(sibling, focused);
                            focused.focus();
                        }
                    } else if (items[targetIdx]) {
                        focused.setAttribute("tabindex", "-1");
                        items[targetIdx].setAttribute("tabindex", "0");
                        items[targetIdx].focus();
                    }
                }
                if ("Escape" === e.key && isGrabbed) {
                    e.preventDefault();
                    e.stopPropagation();
                    focused.setAttribute("aria-grabbed", "false");
                    focused.classList.remove("is-grabbed");
                    onStatus?.('Reorder cancelled', 'info');
                }
            });
        }

        /**
         * Inner half of makeSortable - not callable standalone, which is why
         * rowSelector has no default: the sortable rows are makeSortable's
         * argument and there is no second answer to that question.
         */
        static getDragAfterElement(container, y, rowSelector) {
            const draggableElements = [...container.querySelectorAll(`${rowSelector}:not(.dragging)`)];
            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                return offset < 0 && offset > closest.offset ? { offset: offset, element: child } : closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
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
         * Attaches arrow-key, Enter, and Escape navigation to a property
         * form container. Used for right-sidebar parameter grids.
         */
        static setupPropertyGridNavigation(container) {
            const getNavigableItems = () => Array.from(container.querySelectorAll(
                '.property-field, input:not([disabled]), select:not([disabled]), button:not([disabled])'
            )).filter(el => el.offsetParent !== null &&
                            (!el.matches('input, select') || !el.closest('.property-field')));

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

                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    // Native stepping owns arrows on these.
                    if (focused.tagName === 'SELECT' || focused.type === 'number') return;
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
                    }
                }
            });
        }

        /**
         * Attaches standard tree keyboard navigation to a container.
         * Works for NavScenePanel, NavTreePanel and NavOperationsPanel.
         * @param {HTMLElement} container - The tree container element
         * @param {string|Array} rows - A row selector for a flat tree, or an
         *     ordered levels descriptor [{ selector, idFrom, onActivate }] with
         *     index 0 outermost. Descend/ascend are derived from document order:
         *     a child row follows its parent and the run ends at the first row
         *     at the same or shallower depth, so a tree gains a level by adding
         *     an entry rather than a switch arm.
         * @param {Object} callbacks
         * @param {Function} [callbacks.onSelect] - (id, e) Enter/Space, when the
         *     focused level declares no onActivate
         * @param {Function} [callbacks.onDelete] - (id, focused) Delete/Backspace
         * @param {Function} [callbacks.onExpand] - (id, focused) ArrowRight, when
         *     there is no deeper row to move to
         * @param {Function} [callbacks.onCollapse] - (id, focused, items, idx)
         *     ArrowLeft, when there is no shallower row to move to
         *     @param {Function} [callbacks.depthOf] - (el) => number. Overrides the
         *     levels-derived depth for trees whose nesting is runtime, e.g.
         *     reading aria-level. Required for ArrowLeft/ArrowRight to traverse
         *     a variable-depth tree.
         * @param {Function} [callbacks.onKey] - (key, id, focused, e) anything else.
         */
        static setupTreeKeyboard(container, rows, callbacks) {
            if (!container) {
                this.debug('[UIControls] setupTreeKeyboard: no container - keyboard navigation is off for this panel.');
                return;
            }

            const levels = Array.isArray(rows)
                ? rows
                : [{ selector: rows, idFrom: null, onActivate: null }];
            const allSelector = levels.map(l => l.selector).join(', ');

            container.addEventListener('keydown', e => {
                const focused = document.activeElement;
                if (!container.contains(focused)) return;

                // offsetParent filters collapsed rows: a hidden row cannot take
                // focus, and stepping onto one strands the roving tabindex.
                const items = Array.from(container.querySelectorAll(allSelector))
                    .filter(el => el.offsetParent !== null);
                const idx = items.indexOf(focused);
                if (idx === -1) return;

                // A tree with runtime depth (nested groups) supplies its own
                // depth reader; a fixed-shape tree derives it from the levels
                // list. Either way descend/ascend below is the same walk.
                const depthOf = callbacks.depthOf || (el => {
                    const d = levels.findIndex(l => el.matches(l.selector));
                    return d === -1 ? 0 : d;
                });
                const depth = depthOf(focused);
                const level = levels[depth] || levels[0];
                const id = level.idFrom
                    ? level.idFrom(focused)
                    : (focused.dataset.pathId || focused.dataset.groupId
                        || focused.dataset.bucketId || focused.dataset.fileId
                        || focused.closest('[data-file-id]')?.dataset.fileId);

                const moveTo = el => {
                    if (!el) return;
                    focused.setAttribute('tabindex', '-1');
                    el.setAttribute('tabindex', '0');
                    el.focus();
                };

                // First row deeper than this one, before the run ends.
                const firstChild = () => {
                    for (let i = idx + 1; i < items.length; i++) {
                        const d = depthOf(items[i]);
                        if (d <= depth) return null;
                        if (d === depth + 1) return items[i];
                    }
                    return null;
                };

                // Nearest row above that is shallower - the owning parent.
                const parentRow = () => {
                    for (let i = idx - 1; i >= 0; i--) {
                        if (depthOf(items[i]) < depth) return items[i];
                    }
                    return null;
                };

                switch (e.key) {
                    case 'ArrowDown':
                        e.preventDefault();
                        moveTo(items[idx + 1]);
                        break;
                    case 'ArrowUp':
                        e.preventDefault();
                        moveTo(items[idx - 1]);
                        break;
                    case 'ArrowRight': {
                        e.preventDefault();
                        // Descend if the tree has depth here. A flat tree falls
                        // through to onExpand, which is where group expansion
                        // lives - the two are different questions.
                        const child = firstChild();
                        if (child) moveTo(child);
                        else if (callbacks.onExpand && id) callbacks.onExpand(id, focused);
                        break;
                    }
                    case 'ArrowLeft': {
                        e.preventDefault();
                        // onCollapse first: a group that is open should close
                        // before focus leaves it. It returns truthy when it acted.
                        if (callbacks.onCollapse
                            && callbacks.onCollapse(id, focused, items, idx) === true) break;
                        const parent = parentRow();
                        if (parent) moveTo(parent);
                        break;
                    }
                    case 'Enter':
                    case ' ':
                        e.preventDefault();
                        if (level.onActivate) level.onActivate(focused, e);
                        else if (callbacks.onSelect && id) callbacks.onSelect(id, e);
                        break;
                    case 'Delete':
                    case 'Backspace':
                        // Without stopPropagation the same keystroke reaches the
                        // document listener and runs the GLOBAL delete on the
                        // canvas selection as well as this node.
                        e.preventDefault();
                        e.stopPropagation();
                        if (callbacks.onDelete && id) callbacks.onDelete(id, focused);
                        break;
                    case 'Home':
                        e.preventDefault();
                        moveTo(items[0]);
                        break;
                    case 'End':
                        e.preventDefault();
                        moveTo(items[items.length - 1]);
                        break;
                    default:
                        if (callbacks.onKey) callbacks.onKey(e.key, id, focused, e);
                        break;
                }
            });
        }

        /**
         * Identity of a tree row across a rebuild. Bucket headers carry no id
         * of their own, so the owning row supplies it.
         */
        static treeRowKey(el) {
            if (!el) return null;
            const owner = el.dataset.pathId || el.dataset.groupId || el.dataset.bucketId ||
                          el.dataset.fileId || el.closest('[data-bucket-id]')?.dataset.bucketId || '';
            const stage = el.dataset.stage ||
                          (el.classList.contains('bucket-header') ? 'geometry' : '');
            return `${owner}|${stage}`;
        }

        /**
         * Exactly one row carries tabindex="0" so Tab can enter the tree.
         * Without it every row is -1 and the panel is mouse-only.
         */
        static seedRovingTabindex(container, rowSelector) {
            if (!container) return null;
            const rows = Array.from(container.querySelectorAll(rowSelector));
            if (!rows.length) return null;
            const entry = rows.find(r => r.getAttribute('tabindex') === '0')
                       || rows.find(r => r.classList.contains('selected'))
                       || rows[0];
            for (const r of rows) r.setAttribute('tabindex', r === entry ? '0' : '-1');
            return entry;
        }

        /**
         * Runs a rebuild that replaces rows and puts focus back on the same
         * logical node, falling back to the same position when it is gone.
         */
        static preserveTreeFocus(container, rowSelector, rebuild) {
            const active = document.activeElement;
            const had = !!container && container.contains(active) &&
                        typeof active.matches === 'function' && active.matches(rowSelector);
            const key = had ? UIControls.treeRowKey(active) : null;
            const index = had ? Array.from(container.querySelectorAll(rowSelector)).indexOf(active) : -1;

            rebuild();

            const rows = Array.from(container?.querySelectorAll(rowSelector) || []);
            if (!rows.length) return;

            const target = (key && rows.find(r => UIControls.treeRowKey(r) === key))
                        || (index >= 0 ? rows[Math.min(index, rows.length - 1)] : null)
                        || rows.find(r => r.classList.contains('selected'))
                        || rows[0];

            for (const r of rows) r.setAttribute('tabindex', r === target ? '0' : '-1');
            if (had) target.focus();
        }
    }

    window.EventEmitter = EventEmitter;
    window.UIControls = UIControls;
})();