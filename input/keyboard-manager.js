/*!
 * @file        input/keyboard-manager.js
 * @description Centralized keyboard shortcut routing. Single document-level
 *              keydown listener replaces the fragmented keyboard handling
 *              previously spread across CamController, ModalManager, and
 *              UIControls. Handles modal suppression, input-field guarding,
 *              and priority-based shortcut matching.
 *
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShortcutManager {
        constructor() {
            this.shortcuts = [];
            this.modalManager = null;

            document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        }

        /**
         * @param {ModalManager} mm
         */
        setModalManager(mm) {
            this.modalManager = mm;
        }

        /**
         * Register a keyboard shortcut.
         *
         * @param {string}   combo      Key or combo: 'g', 'Delete', 'ctrl+z',
         *                              'ctrl+shift+g', 'ArrowLeft', 'F1', 'F6'
         * @param {Function} callback   (event) => void
         * @param {object}   [options]
         * @param {boolean}  [options.mod]          Requires Ctrl/Meta
         * @param {boolean}  [options.shift]        Requires Shift
         * @param {boolean}  [options.allowInTree]  If false, skip when focus
         *                                          is inside a tree panel
         */
        register(combo, callback, options = {}) {
            const parsed = this.parseCombo(combo);
            this.shortcuts.push({
                ...parsed,
                callback,
                allowInTree: options.allowInTree !== false,
                mod: options.mod || parsed.mod,
                shift: options.shift || parsed.shift
            });
        }

        unregister(combo, callback) {
            const parsed = this.parseCombo(combo);
            this.shortcuts = this.shortcuts.filter(s =>
                !(s.key === parsed.key && s.mod === parsed.mod &&
                  s.shift === parsed.shift && s.callback === callback)
            );
        }

        parseCombo(combo) {
            const parts = combo.toLowerCase().split('+');
            const key = parts[parts.length - 1];
            const mod = parts.includes('ctrl') || parts.includes('meta');
            const shift = parts.includes('shift');
            return { key, mod, shift };
        }

        handleKeyDown(e) {
            // Modal active → only Escape routes to modal handler
            if (this.modalManager?.activeModal) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.modalManager.handleEscapeKey();
                }
                // Let Tab through for focus trap (handled by ModalManager)
                return;
            }

            // Editing an input → only Escape blurs
            if (this.isEditing(e.target)) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.target.blur();
                }
                return;
            }

            // Close open dropdown on Escape before checking shortcuts
            if (e.key === 'Escape') {
                const openDropdown = document.querySelector('.dropdown-content.show');
                if (openDropdown) {
                    e.preventDefault();
                    openDropdown.classList.remove('show');
                    const btn = openDropdown.previousElementSibling;
                    if (btn) { btn.classList.remove('active'); btn.setAttribute('aria-expanded', 'false'); }
                    return;
                }
            }

            // If focus is inside a tree panel and the key is an arrow,
            // let the tree's own handler deal with it
            const isInTree = e.target.closest('#operations-tree, #scene-tree-list, #operations-bucket-list');
            const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
            if (isInTree && isArrowKey) return;

            // Match against registered shortcuts
            const isMod = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;
            const keyLower = e.key.toLowerCase();

            for (const shortcut of this.shortcuts) {
                // Modifier matching
                if (shortcut.mod && !isMod) continue;
                if (!shortcut.mod && isMod && !['escape'].includes(shortcut.key)) continue;
                if (shortcut.shift && !isShift) continue;
                if (!shortcut.shift && isShift && shortcut.mod) continue; // REVIEW - This doesn't lock a plain key from triggering even with shift modifier on? Could be problematic when shortcuts overlap?

                // Key matching (case-insensitive for letters)
                const matchKey = shortcut.key === keyLower ||
                                 shortcut.key === e.key ||
                                 shortcut.key === e.code;

                if (!matchKey) continue;

                // Tree guard
                if (isInTree && !shortcut.allowInTree) continue;

                e.preventDefault();
                shortcut.callback(e);
                return;
            }
        }

        isEditing(target) {
            return target.matches(
                'input, textarea, select, [contenteditable="true"], .property-field input, .property-field select'
            );
        }
    }

    window.ShortcutManager = ShortcutManager;
})();