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
                // Keyboard navigation via shared utility
                UIControls.setupTreeKeyboard(this.treeContainer, '[role="treeitem"]', {
                    onSelect: (id, e) => {
                        this.emit('select', { id, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey || e.metaKey });
                    },
                    onDelete: (id) => {
                        this.emit('action', { id, action: 'delete' });
                    },
                    onExpand: (id, focused) => {
                        if (focused.classList.contains('group-row')) {
                            const node = this.sceneRef?.findNode(id);
                            if (node?.collapsed) { node.collapsed = false; this.refreshTree(); }
                        }
                    },
                    onCollapse: (id, focused, rows, idx) => {
                        if (focused.classList.contains('group-row')) {
                            const node = this.sceneRef?.findNode(id);
                            if (node && !node.collapsed) { node.collapsed = true; this.refreshTree(); return; }
                        }
                        // Navigate to parent level
                        const level = parseInt(focused.getAttribute('aria-level') || '1');
                        if (level > 1) {
                            for (let i = idx - 1; i >= 0; i--) {
                                if (parseInt(rows[i].getAttribute('aria-level') || '1') < level) {
                                    focused.setAttribute('tabindex', '-1');
                                    rows[i].setAttribute('tabindex', '0');
                                    rows[i].focus();
                                    break;
                                }
                            }
                        }
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
            if (!this.treeContainer) return;
            this.treeContainer.querySelectorAll('.path-row, .group-row').forEach(row => {
                const id = row.dataset.pathId || row.dataset.groupId;
                const isSelected = id && selectedIds.has(id);
                row.classList.toggle('selected', isSelected);
                if (isSelected) row.setAttribute('aria-selected', 'true');
                else row.removeAttribute('aria-selected');
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Tree Toolbar
        // ═══════════════════════════════════════════════════════════════

        setupTreeToolbar() {
            const bind = (id, action) => {
                document.getElementById(id)?.addEventListener('click', () => this.emit('toolbar', action));
            };
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
            const list = this.treeContainer;
            if (!list || !this.sceneRef) return;

            const emptyState = document.getElementById('scene-empty-state');
            const clearBtn = document.getElementById('btn-clear-all');

            list.querySelectorAll('.path-row, .group-row').forEach(r => r.remove());

            if (this.sceneRef.shapeCount() === 0) {
                if (emptyState) emptyState.style.display = '';
                if (clearBtn) clearBtn.style.display = 'none';
                // Empty tree owns no treeitems. Drop the role so it doesn't
                // trip aria-required-children.
                list.removeAttribute('role');
                list.removeAttribute('aria-label');
                return;
            }
            if (emptyState) emptyState.style.display = 'none';
            if (clearBtn) clearBtn.style.display = '';
            list.setAttribute('role', 'tree');
            list.setAttribute('aria-label', 'Scene tree');

            const selectedIds = this.sceneRef.selection.toSet();

            const renderNode = (node, depth) => {
                if (node.kind === 'root') {
                    for (const child of node.children) renderNode(child, 0);
                    return;
                }
                if (node.kind === 'group') {
                    this.buildGroupRow(node, depth, selectedIds, list);
                    if (!node.collapsed) {
                        for (const child of node.children) renderNode(child, depth + 1);
                    }
                    return;
                }
                this.buildShapeRow(node, depth, selectedIds, list);
            };

            renderNode(this.sceneRef.root, 0);
        }

        // ═══════════════════════════════════════════════════════════════
        // Row builders
        // ═══════════════════════════════════════════════════════════════

        buildGroupRow(node, depth, selectedIds, list) {
            const row = document.createElement('div');
            row.className = 'group-row';
            row.style.paddingLeft = `${8 + depth * 14}px`;
            row.dataset.groupId = node.id;
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('aria-level', String(depth + 1));
            if (selectedIds.has(node.id)) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); }
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
                <button class="btn btn--icon btn--compact path-lock${lockExtra}" data-action="lock" title="${lockTitle}" ${lockDisabled}>
                    <svg class="cam-icon" width="12" height="12"><use href="#${lockId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact path-visibility" data-action="visibility" title="${node.visible ? 'Hide' : 'Show'}">
                    <svg class="cam-icon" width="12" height="12"><use href="#${visId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact" data-action="delete" title="Delete group">
                    <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                </button>
            `;
            row.querySelector('.group-name').textContent = node.label || 'Group';

            list.appendChild(row);
        }

        buildShapeRow(shape, depth, selectedIds, list) {
            const row = document.createElement('div');
            row.className = 'path-row';
            row.style.paddingLeft = `${8 + depth * 14}px`;
            row.dataset.pathId = shape.id;
            row.dataset.op = this.ui.opsPanel?.getShapeOpType(shape.id) || 'none';
            row.setAttribute('role', 'treeitem');
            row.setAttribute('tabindex', '-1');
            row.setAttribute('aria-level', String(depth + 1));
            if (selectedIds.has(shape.id)) { row.classList.add('selected'); row.setAttribute('aria-selected', 'true'); }
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

            const lockId = localLocked ? 'icon-lock-locked' : 'icon-lock-unlocked';
            const visId = shape.visible ? 'icon-eye' : 'icon-eye-off';

            row.innerHTML = `
                <span class="path-name"></span>
                <button class="btn btn--icon btn--compact path-lock${lockExtra}" data-action="lock" title="${lockTitle}" ${lockDisabled}>
                    <svg class="cam-icon" width="12" height="12"><use href="#${lockId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact path-visibility" data-action="visibility" title="${shape.visible ? 'Hide' : 'Show'}">
                    <svg class="cam-icon" width="12" height="12"><use href="#${visId}"></use></svg>
                </button>
                <button class="btn btn--icon btn--compact" data-action="delete" title="Remove">
                    <svg class="cam-icon" width="12" height="12"><use href="#icon-delete"></use></svg>
                </button>
            `;
            row.querySelector('.path-name').textContent = displayLabel;

            list.appendChild(row);
        }

        // ═══════════════════════════════════════════════════════════════
        // In-place flag updates
        // ═══════════════════════════════════════════════════════════════

        /**
         * Updates lock/visibility classes and button states on existing rows
         * without destroying and recreating the DOM. Called by the controller's
         * afterFlagMutation() path for SetNodeFlagCommand and similar
         * non-structural mutations.
         */
        updateFlagStates() {
            if (!this.treeContainer || !this.sceneRef) return;

            this.treeContainer.querySelectorAll('.path-row, .group-row').forEach(row => {
                const id = row.dataset.pathId || row.dataset.groupId;
                if (!id) return;
                const node = this.sceneRef.findNode(id);
                if (!node) return;

                // Visibility
                row.classList.toggle('is-hidden-shape', !node.isVisible);
                const visBtn = row.querySelector('.path-visibility');
                if (visBtn) {
                    const useEl = visBtn.querySelector('use');
                    if (useEl) useEl.setAttribute('href', node.visible ? '#icon-eye' : '#icon-eye-off');
                    visBtn.title = node.visible ? 'Hide' : 'Show';
                }

                // Lock state
                const localLocked = node.locked;
                const ancestorLocked = this.hasLockedAncestor(node);
                const descendantLock = node.children ? this.hasLockedDescendant(node) : false;
                const effectivelyLocked = node.isLocked || descendantLock;

                row.classList.toggle('is-locked-shape', effectivelyLocked);

                const lockBtn = row.querySelector('.path-lock, [data-action="lock"]');
                if (lockBtn) {
                    lockBtn.disabled = ancestorLocked;
                    lockBtn.title = ancestorLocked ? 'Locked by parent'
                        : (descendantLock && !localLocked) ? 'Contains locked items'
                        : (localLocked ? 'Unlock' : 'Lock');

                    // Update lock icon dash style
                    const lockUse = lockBtn.querySelector('use');
                    if (lockUse) {
                        lockUse.setAttribute('href', localLocked ? '#icon-lock-locked' : '#icon-lock-unlocked');
                    }

                    // Update class modifiers
                    lockBtn.classList.remove('btn--locked-by-ancestor', 'btn--locked-by-descendant');
                    if (ancestorLocked) lockBtn.classList.add('btn--locked-by-ancestor');
                    else if (descendantLock && !localLocked) lockBtn.classList.add('btn--locked-by-descendant');
                }

                // Operation badge (for shapes with data-op attribute)
                if (row.dataset.op !== undefined) {
                    row.dataset.op = this.ui.opsPanel?.getShapeOpType(id) || 'none';
                }
            });
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