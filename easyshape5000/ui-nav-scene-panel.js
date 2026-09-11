/*!
 * @file        easyshape5000/ui-nav-scene-panel.js
 * @description Scene graph tree panel — EasyShape5000 only.
 *              Renders the hierarchical group/shape tree from a Scene
 *              instance. Emits events for selection, actions, and warnings.
 *              Does NOT mutate scene state — the controller decides.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class NavScenePanel extends EventEmitter {
        constructor(ui) {
            // Event emitter
            super();

            this.ui = ui;
            this.lang = ui.lang;
            this.treeContainer = null;
            this.sceneRef = null;
            this.initialized = false;
        }

        // ═══════════════════════════════════════════════════════════════
        // Initialization
        // ═══════════════════════════════════════════════════════════════

        init(containerId) {
            this.treeContainer = document.getElementById(containerId || 'scene-tree-list');
            if (this.treeContainer) {
                // Keyboard navigation via shared utility. The scene tree has
                // runtime depth (nested groups), not a fixed level list, so
                // depthOf reads aria-level and the generic ascend/descend in
                // setupTreeKeyboard works without a per-panel walk.
                UIControls.setupTreeKeyboard(this.treeContainer, '[role="treeitem"]', {
                    depthOf: el => parseInt(el.getAttribute('aria-level') || '1', 10) - 1,
                    onSelect: (id, e) => {
                        this.emit('select', { id, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
                    },
                    onDelete: (id) => {
                        this.emit('action', { id, action: 'delete' });
                    },
                    onKey: (key, id, focused) => {
                        const sel = (key === 'v' || key === 'V') ? '.path-visibility'
                                  : (key === 'l' || key === 'L') ? '.path-lock'
                                  : null;
                        if (!sel) return;
                        const btn = focused.querySelector(sel);
                        if (btn && !btn.disabled) btn.click();
                    },
                    onExpand: (id, focused) => {
                        if (!focused.classList.contains('group-row')) return;
                        const node = this.sceneRef?.findNode(id);
                        if (node?.collapsed) { node.collapsed = false; this.refreshTree(); }
                    },
                    // Close an open group before letting focus leave it. Return
                    // true when it acted; false hands ArrowLeft back to the
                    // generic parent walk.
                    onCollapse: (id, focused) => {
                        if (!focused.classList.contains('group-row')) return false;
                        const node = this.sceneRef?.findNode(id);
                        if (node && !node.collapsed) {
                            node.collapsed = true;
                            this.refreshTree();
                            return true;
                        }
                        return false;
                    }
                });

                // Delegated click handler
                this.treeContainer.addEventListener('click', (e) => {
                    const actionBtn = e.target.closest('[data-action]');
                    const row = e.target.closest('.path-row, .group-row');
                    if (!row) return;

                    const id = row.dataset.pathId || row.dataset.groupId;
                    if (!id) return;

                    if (actionBtn) {
                        e.stopPropagation();
                        const action = actionBtn.dataset.action;
                        if (action === 'lock' && this.hasLockedAncestor(this.sceneRef?.findNode(id))) {
                            this.emit('warn', 'Locked by parent — unlock the parent first');
                            return;
                        }
                        this.emit('action', { id, action });
                        return;
                    }

                    if (e.target.closest('.group-toggle') && row.classList.contains('group-row')) {
                        e.stopPropagation();
                        const node = this.sceneRef?.findNode(id);
                        if (node) { node.collapsed = !node.collapsed; this.refreshTree(); }
                        return;
                    }

                    this.emit('select', { id, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
                });
            }

            this.setupTreeToolbar();

            this.initialized = true;
        }

        bindScene(scene) {
            this.sceneRef = scene;
        }

        /**
         * Updates .selected class on existing rows without a full tree rebuild.
         */
        updateSelectionHighlights(selectedIds) {
            this.treeContainer?.querySelectorAll(".path-row, .group-row").forEach(row => {
                const id = row.dataset.pathId || row.dataset.groupId;
                const isSelected = !!id && selectedIds.has(id);
                row.classList.toggle("selected", isSelected);
                row.setAttribute("aria-selected", isSelected ? "true" : "false");
            });
        }

        /**
         * Repaints lock/visibility state on the rows that already exist.
         * A flag flip changes two icons and two classes, and refreshTree()
         * rebuilds every row to do it - which drops keyboard focus and the
         * scroll position on every eye click.
         */
        updateFlagStates() {
            if (!this.treeContainer || !this.sceneRef) return;
            this.treeContainer.querySelectorAll('.path-row, .group-row').forEach(row => {
                const id = row.dataset.pathId || row.dataset.groupId;
                const node = id ? this.sceneRef.findNode(id) : null;
                if (!node) return;

                const visible = node.visible !== false;
                row.classList.toggle('is-hidden-shape', !visible);
                const visBtn = row.querySelector('.path-visibility');
                if (visBtn) {
                    visBtn.title = visible ? 'Hide' : 'Show';
                    visBtn.querySelector('use')?.setAttribute('href', visible ? '#icon-eye' : '#icon-eye-off');
                }

                const localLocked = !!node.locked;
                const descendantLock = node.kind === 'group' && this.hasLockedDescendant(node);
                row.classList.toggle('is-locked-shape', !!node.isLocked || descendantLock);
                const lockBtn = row.querySelector('.path-lock');
                if (lockBtn) {
                    lockBtn.querySelector('use')?.setAttribute('href', localLocked ? '#icon-lock-locked' : '#icon-lock-unlocked');
                    lockBtn.title = this.hasLockedAncestor(node) ? 'Locked by parent'
                        : descendantLock && !localLocked ? 'Contains locked items'
                        : localLocked ? 'Unlock' : 'Lock';
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Tree Toolbar
        // ═══════════════════════════════════════════════════════════════

        setupTreeToolbar() {
            const bind = (id, action) => { document.getElementById(id)?.addEventListener('click', () => this.emit('toolbar', action)); };
            bind('tree-btn-add', 'add');
            bind('tree-btn-group', 'group');
            bind('tree-btn-ungroup', 'ungroup');
            bind('tree-btn-lock', 'lock');
            bind('tree-btn-hide', 'visibility');
            bind('tree-btn-delete', 'delete');
        }

        syncTreeToolbar(selection, scene) {
            if (!selection || !scene) return;
            const sel = selection.toArray();
            const count = sel.length;
            const hasGroup = sel.some(id => { const n = scene.findNode(id); return n?.kind === 'group'; });
            const set = (id, enabled) => { const el = document.getElementById(id); if (el) el.disabled = !enabled; };
            set('tree-btn-group', count >= 2);
            set('tree-btn-ungroup', hasGroup);
            set('tree-btn-lock', count > 0);
            set('tree-btn-hide', count > 0);
            set('tree-btn-delete', count > 0);
        }

        // ═══════════════════════════════════════════════════════════════
        // Tree rendering — full rebuild from scene graph
        // ═══════════════════════════════════════════════════════════════

        refreshTree() {
            if (!this.treeContainer) return;
            // Every row is replaced here, including the one holding focus.
            // ArrowRight lands on a detached node without this wrapper.
            UIControls.preserveTreeFocus(
                this.treeContainer, '[role="treeitem"]', () => this._rebuildTree()
            );
        }

        _rebuildTree() {
            const list = this.treeContainer;
            if (!list || !this.sceneRef) return;

            const emptyState = document.getElementById('scene-empty-state');

            list.querySelectorAll('.path-row, .group-row').forEach(r => r.remove());

            if (this.sceneRef.shapeCount() === 0) {
                if (emptyState) emptyState.style.display = '';
                // Empty tree owns no treeitems. Drop the role so it doesn't
                // trip aria-required-children.
                list.removeAttribute('role');
                list.removeAttribute('aria-label');
                list.removeAttribute('aria-multiselectable');
                return;
            }
            if (emptyState) emptyState.style.display = 'none';
            list.setAttribute('role', 'tree');
            list.setAttribute('aria-label', 'Scene tree');
            list.setAttribute('aria-multiselectable', 'true');

            const selectedIds = this.sceneRef.selection.toSet();

            const renderNode = (node, depth, pos, size) => {
                if (node.kind === 'root') {
                    const kids = node.children;
                    kids.forEach((child, i) => renderNode(child, 0, i + 1, kids.length));
                    return;
                }
                if (node.kind === 'group') {
                    this.buildGroupRow(node, depth, selectedIds, list, pos, size);
                    if (!node.collapsed) {
                        const kids = node.children;
                        kids.forEach((child, i) => renderNode(child, depth + 1, i + 1, kids.length));
                    }
                    return;
                }
                this.buildShapeRow(node, depth, selectedIds, list, pos, size);
            };

            renderNode(this.sceneRef.root, 0, 1, 1);

            UIControls.seedRovingTabindex(list, '[role="treeitem"]');
        }

        // ═══════════════════════════════════════════════════════════════
        // Row builders
        // ═══════════════════════════════════════════════════════════════

        buildGroupRow(node, depth, selectedIds, list, pos = 1, size = 1) {
            const row = document.createElement('div');
            row.className = 'group-row';
            row.style.paddingLeft = `${8 + depth * 14}px`;
            row.dataset.groupId = node.id;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('aria-level', String(depth + 1));
            // The DOM is flat and indented by padding alone, so position in
            // the branch has to be stated rather than derived.
            row.setAttribute('aria-posinset', String(pos));
            row.setAttribute('aria-setsize', String(size));
            row.setAttribute('aria-selected', selectedIds.has(node.id) ? 'true' : 'false');
            if (node.children.length) {
                row.setAttribute('aria-expanded', node.collapsed ? 'false' : 'true');
            }
            if (selectedIds.has(node.id)) row.classList.add('selected');
            if (!node.visible) row.classList.add('is-hidden-shape');

            const localLocked = node.locked;
            const ancestorLocked = this.hasLockedAncestor(node);
            const descendantLock = this.hasLockedDescendant(node);
            if (node.isLocked || descendantLock) row.classList.add('is-locked-shape');

            const lockTitle = ancestorLocked ? 'Locked by parent'
                : descendantLock && !localLocked ? 'Contains locked items'
                : (localLocked ? 'Unlock' : 'Lock');
            const lockDisabled = ancestorLocked ? 'disabled' : '';
            const lockExtra = ancestorLocked ? ' btn--locked-by-ancestor'
                : (descendantLock && !localLocked ? ' btn--locked-by-descendant' : '');

            const lockId = localLocked ? 'icon-lock-locked' : 'icon-lock-unlocked';
            const visId = node.visible ? 'icon-eye' : 'icon-eye-off';

            row.innerHTML = `
                <span class="group-toggle">
                    <svg class="cam-icon" width="14" height="14">
                        <use href="#${node.collapsed ? 'icon-chevron-right' : 'icon-chevron-down'}"></use>
                    </svg>
                </span>
                <span class="group-name"></span>
                <span class="group-count">${node.children.length}</span>
                <button class="btn btn--icon btn--compact path-lock${lockExtra}" data-action="lock" title="${lockTitle}" aria-label="${lockTitle}: ${node.label || 'Group'}" ${lockDisabled}>
                    <svg class="cam-icon" width="12" height="12"><use href="#${lockId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact path-visibility" data-action="visibility" title="${node.visible ? 'Hide' : 'Show'}" aria-label="${node.visible ? 'Hide' : 'Show'}: ${node.label || 'Group'}">
                    <svg class="cam-icon" width="12" height="12"><use href="#${visId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact" data-action="delete" title="Delete group" aria-label="Delete group: ${node.label || 'Group'}">
                    <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                </button>
            `;
            row.querySelector('.group-name').textContent = node.label || 'Group';
            row.querySelectorAll('button').forEach(b => b.setAttribute('tabindex', '-1'));

            list.appendChild(row);
        }

        buildShapeRow(shape, depth, selectedIds, list, pos = 1, size = 1) {
            const row = document.createElement('div');
            row.className = 'path-row';
            row.style.paddingLeft = `${8 + depth * 14}px`;
            row.dataset.pathId = shape.id;
            row.dataset.op = this.ui.opsPanel?.getShapeOpType(shape.id) || 'none';
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('aria-level', String(depth + 1));
            row.setAttribute('aria-posinset', String(pos));
            row.setAttribute('aria-setsize', String(size));
            row.setAttribute('aria-selected', selectedIds.has(shape.id) ? 'true' : 'false');
            if (selectedIds.has(shape.id)) row.classList.add('selected');
            if (!shape.isVisible) row.classList.add('is-hidden-shape');

            const localLocked = shape.locked;
            const ancestorLocked = this.hasLockedAncestor(shape);
            if (shape.isLocked) row.classList.add('is-locked-shape');

            const lockTitle = ancestorLocked ? 'Locked by parent' : (localLocked ? 'Unlock' : 'Lock');
            const lockDisabled = ancestorLocked ? 'disabled' : '';
            const lockExtra = ancestorLocked ? ' btn--locked-by-ancestor' : '';

            let displayLabel = shape.label || 'Shape';
            const path = shape.primitive?.properties?.groupPath;
            if (Array.isArray(path) && path.length > 0) {
                for (let i = path.length - 1; i >= 0; i--) {
                    const lbl = path[i].label || path[i].id;
                    if (lbl && !/^uid_/.test(lbl) && !/^g\d+$/.test(lbl)) {
                        displayLabel = `${lbl} · ${shape.primitive.type}`;
                        break;
                    }
                }
            }

            const lockId = localLocked ? "icon-lock-locked" : "icon-lock-unlocked";
            const visId = shape.visible ? "icon-eye" : "icon-eye-off";

            row.innerHTML = `
                <span class="path-name"></span>
                <button class="btn btn--icon btn--compact path-lock${lockExtra}" data-action="lock" title="${lockTitle}" aria-label="${lockTitle}: ${displayLabel}" ${lockDisabled}>
                    <svg class="cam-icon" width="12" height="12"><use href="#${lockId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact path-visibility" data-action="visibility" title="${shape.visible ? 'Hide' : 'Show'}" aria-label="${shape.visible ? 'Hide' : 'Show'}: ${displayLabel}">
                    <svg class="cam-icon" width="12" height="12"><use href="#${visId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact" data-action="delete" title="Remove" aria-label="Remove ${displayLabel}">
                    <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                </button>
            `;
            row.querySelector(".path-name").textContent = shape.label || "Shape";
            row.querySelectorAll('button').forEach(b => b.setAttribute("tabindex", "-1"));

            list.appendChild(row);
        }

        // ═══════════════════════════════════════════════════════════════
        // Lock/visibility ancestor helpers
        // ═══════════════════════════════════════════════════════════════

        hasLockedAncestor(node) {
            if (!node) return false;
            let n = node.parent;
            while (n && n.kind !== 'root') {
                if (n.locked) return true;
                n = n.parent;
            }
            return false;
        }

        hasLockedDescendant(node) {
            if (!node || !node.children) return false;
            for (const c of node.children) {
                if (c.locked || this.hasLockedDescendant(c)) return true;
            }
            return false;
        }
    }

    window.NavScenePanel = NavScenePanel;
})();