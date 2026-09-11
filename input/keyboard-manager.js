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
            this.actions = {};
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
         * Named actions, so a combo table can be data. An action with no handler
         * is a table entry for a feature this app does not have - skipped, not an
         * error, because both apps read from the same shared table.
         */
        registerActions(map) {
            Object.assign(this.actions, map);
        }

        /**
         * [{ combo, action, args, mod, shift, alt, allowInTree, shiftOptional }]
         * `args` is what lets one action back many keys - five category keys and
         * four pan directions are one handler each, not nine.
         * Handlers come from registerActions; a combo whose action has none is a
         * table entry for a feature this app lacks, skipped rather than an error.
         */
        applyTable(table) {
            for (const entry of table || []) {
                const fn = this.actions[entry.action];
                if (typeof fn !== 'function') continue;
                const args = entry.args;
                this.register(entry.combo, args ? e => fn(e, ...args) : fn, entry);
            }
        }

        /**
         * Invoke by name, with no keystroke. The surface a headless caller and a
         * future command palette both need.
         */
        invoke(action, ...args) {
            const fn = this.actions[action];
            return typeof fn === 'function' ? fn(...args) : undefined;
        }

        /**
         * Register a keyboard shortcut.
         *
         * @param {string}   combo      Key or combo: 'g', 'Delete', 'ctrl+z',
         *                              'ctrl+shift+g', 'ArrowLeft', 'F1', 'F6'
         * @param {Function} callback   (event) => void
         * @param {object}   [options]
         * @param {boolean}  [options.mod]           Requires Ctrl/Meta
         * @param {boolean}  [options.shift]         Requires Shift
         * @param {boolean}  [options.allowInTree]   If false, skip when focus
         *                                           is inside a tree panel
         * @param {boolean}  [options.shiftOptional] Allow Shift to be held.
         *                                           Set it when the callback
         *                                           reads e.shiftKey, or when
         *                                           the key is itself shifted.
         */
        register(combo, callback, options = {}) {
            const parsed = this.parseCombo(combo);
            this.shortcuts.push({
                ...parsed,
                callback,
                allowInTree: options.allowInTree !== false,
                // Shift is exclusive by default. Opt out when the callback
                // reads e.shiftKey itself (F6 reverse cycling, Shift-pan) or
                // when the key IS a shifted keystroke ('+' is Shift+= on most
                // layouts, so a strict check would make it unreachable).
                shiftOptional: options.shiftOptional === true,
                mod: options.mod || parsed.mod,
                shift: options.shift || parsed.shift,
                alt: options.alt || parsed.alt
            });
        }

        parseCombo(combo) {
            const parts = combo.toLowerCase().split('+');
            const key = parts[parts.length - 1];
            const mod = parts.includes('ctrl') || parts.includes('meta');
            const shift = parts.includes('shift');
            const alt = parts.includes('alt');
            return { key, mod, shift, alt };
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
                const openDropdown = document.querySelector('.dropdown-content.is-open');
                if (openDropdown) {
                    e.preventDefault();
                    openDropdown.classList.remove('is-open');
                    const btn = openDropdown.previousElementSibling;
                    if (btn) {
                        btn.classList.remove('active');
                        btn.setAttribute('aria-expanded', 'false');
                        btn.focus();
                    }
                    return;
                }
            }

            // Two zones own their own keyboard model, and they own it
            // differently. A tree is a NAVIGATION zone: single-key commands are
            // welcome there, and only destructive ones opt out via allowInTree.
            // A form row is a TYPING zone: setupPropertyGridNavigation gives
            // roving focus to the ROW div, which isEditing() cannot match, so
            // anything that could be typed belongs to the form and never to a
            // command.
            const inTree = !!e.target.closest('#operations-tree, #scene-tree-list, #operations-bucket-list');
            const inForm = !!e.target.closest('.property-field');

            const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
            if ((inTree || inForm) && isArrowKey) return;

            // Function keys and Escape cannot be confused with typing, so the
            // form guard does not apply to them.
            const isTypeable = e.key.length === 1 ||
                               ['Delete', 'Backspace', 'Enter', ' '].includes(e.key);
            if (inForm && isTypeable) return;

            // Match against registered shortcuts
            const isMod = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;
            const isAlt = e.altKey;
            const keyLower = e.key.toLowerCase();

            for (const shortcut of this.shortcuts) {
                // Modifier matching
                if (shortcut.mod && !isMod) continue;
                if (!shortcut.mod && isMod && shortcut.key !== 'escape') continue;
                if (shortcut.shift && !isShift) continue;
                if (!shortcut.shift && isShift && !shortcut.shiftOptional) continue;
                if (shortcut.alt && !isAlt) continue;
                if (!shortcut.alt && isAlt) continue;

                // Key matching (case-insensitive for letters)
                const matchKey = shortcut.key === keyLower ||
                                 shortcut.key === e.key ||
                                 shortcut.key === e.code;

                if (!matchKey) continue;

                // Tree guard
                if (inTree && !shortcut.allowInTree) continue;

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