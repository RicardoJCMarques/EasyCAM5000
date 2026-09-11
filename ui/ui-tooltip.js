/*!
 * @file        ui/ui-tooltip.js
 * @description Manages all UI tooltips
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

    class TooltipManager {
        constructor() {
            this.tooltip = null;
            this.currentTarget = null;
            this.showTimeout = null;
            this.hideTimeout = null;
            this.delayShow = D.ui.tooltips.delayShow;
            this.delayHide = D.ui.tooltips.delayHide;
            this._seq = 0;
            this._suppressUntilMove = false;
            this.createTooltip();

            // Content shown on hover must be dismissible without moving the
            // pointer or focus (WCAG 1.4.13). currentTarget is what tracks the
            // visible tooltip - there is no activeElement on this class.
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.currentTarget) {
                    clearTimeout(this.showTimeout);
                    clearTimeout(this.hideTimeout);
                    this.tooltip.classList.remove('visible');
                    this.currentTarget = null;
                    this._suppressUntilMove = true;
                }
            }, true);
            document.addEventListener('mousemove', () => { this._suppressUntilMove = false; }, { passive: true });

            // Hoverable: moving onto the tooltip keeps it open long enough to
            // read one that overflows its trigger.
            this.tooltip.addEventListener('mouseenter', () => clearTimeout(this.hideTimeout));
            this.tooltip.addEventListener('mouseleave', () => this.hide());
        }

        createTooltip() {
            this.tooltip = document.createElement('div');
            this.tooltip.className = 'tooltip';
            this.tooltip.innerHTML = '<div class="tooltip-content"></div>';
            document.body.appendChild(this.tooltip);
        }

        show(target, content, options = {}) {
            if (this._suppressUntilMove) return;
            clearTimeout(this.hideTimeout);

            if (this.showTimeout) {
                clearTimeout(this.showTimeout);
            }

            this.showTimeout = setTimeout(() => {
                this.currentTarget = target;
                this.renderContent(content, options);
                this.position(target, options.position);
                this.tooltip.classList.add('visible');
            }, options.immediate ? 0 : this.delayShow);
        }

        hide() {
            clearTimeout(this.showTimeout);

            this.hideTimeout = setTimeout(() => {
                this.tooltip.classList.remove('visible');
                this.currentTarget = null;
            }, this.delayHide);
        }

        renderContent(content, options = {}) {
            const container = this.tooltip.querySelector('.tooltip-content');
            container.innerHTML = '';

            if (typeof content === 'string') {
                container.textContent = content;
            } else if (content.text) {
                // Structured tooltip
                if (content.title) {
                    const title = document.createElement('div');
                    title.className = 'tooltip-title';
                    title.textContent = content.title;
                    container.appendChild(title);
                }

                const text = document.createElement('div');
                text.className = 'tooltip-text';
                text.textContent = content.text;
                container.appendChild(text);

                if (content.example) {
                    const example = document.createElement('div');
                    example.className = 'tooltip-example';
                    example.textContent = content.example;
                    container.appendChild(example);
                }
            } else if (content.html) {
                container.innerHTML = content.html;
            }

            // Apply max width if specified
            if (options.maxWidth) {
                this.tooltip.style.maxWidth = options.maxWidth + 'px';
            }
        }

        position(target, preferredPosition = 'top') {
            const rect = target.getBoundingClientRect();
            const tooltipRect = this.tooltip.getBoundingClientRect();

            const positions = {
                top: {
                    left: rect.left + (rect.width - tooltipRect.width) / 2,
                    top: rect.top - tooltipRect.height - 8
                },
                bottom: {
                    left: rect.left + (rect.width - tooltipRect.width) / 2,
                    top: rect.bottom + 8
                },
                left: {
                    left: rect.left - tooltipRect.width - 8,
                    top: rect.top + (rect.height - tooltipRect.height) / 2
                },
                right: {
                    left: rect.right + 8,
                    top: rect.top + (rect.height - tooltipRect.height) / 2
                }
            };

            // Try preferred position first
            let position = positions[preferredPosition];

            // Check if tooltip would go off-screen and adjust
            const padding = 8;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            // Adjust horizontal position
            if (position.left < padding) {
                position.left = padding;
            } else if (position.left + tooltipRect.width > viewportWidth - padding) {
                position.left = viewportWidth - tooltipRect.width - padding;
            }

            // Adjust vertical position - flip if needed
            if (position.top < padding) {
                // Flip to bottom if top doesn't fit
                position = positions.bottom;
            } else if (position.top + tooltipRect.height > viewportHeight - padding) {
                // Flip to top if bottom doesn't fit
                position = positions.top;
            }

            this.tooltip.style.left = position.left + 'px';
            this.tooltip.style.top = position.top + 'px';
        }

        // Helper to attach tooltip to element
        attach(element, content, options = {}) {
            element.addEventListener('mouseenter', () => {
                this.show(element, content, options);
            });

            element.addEventListener('mouseleave', () => {
                this.hide();
            });

            // Optional: show on focus for accessibility
            if (options.showOnFocus) {
                element.addEventListener('focus', () => {
                    this.show(element, content, { immediate: true });
                });

                element.addEventListener('blur', () => {
                    this.hide();
                });
            }
        }

        /**
         * The trigger is DECORATIVE. Making it a role="button" forced it out of
         * the <label> (an interactive control inside a label forwards its
         * activation to the field), which broke the layout everywhere the label
         * is not a lone flex row. A decorative span can live inside the label,
         * and the help text reaches assistive tech the correct way: as the
         * field's description, announced on focus, with no extra tab stop.
         */
        attachWithIcon(element, content, options = {}) {
            const icon = document.createElement('span');
            icon.className = 'tooltip-trigger';
            icon.innerHTML = `<svg class="cam-icon" width="12" height="12" aria-hidden="true"><use href="#icon-help"></use></svg>`;
            icon.setAttribute('aria-hidden', 'true');
            element.appendChild(icon);

            // Inside a <label> a click anywhere - including on the icon -
            // activates the control. A help affordance must not toggle it.
            icon.addEventListener('mousedown', e => e.stopPropagation());
            icon.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); });

            // BEFORE the description work below, which returns early on any
            // target that is not a label with a control - a toolbar icon would
            // otherwise end up with no tooltip at all.
            this.attach(icon, content, { ...options, showOnFocus: false });

            const control = element.tagName === 'LABEL'
                ? (element.control || element.querySelector('input, select, textarea'))
                : null;
            if (!control || !content?.text) return icon;

            // The help text reaches assistive tech as the field's DESCRIPTION,
            // announced on focus, rather than as a button to hunt for.
            if (!control.id) control.id = `ctl-${++this._seq}`;
            const helpId = `help-${control.id}`;
            let help = document.getElementById(helpId);
            if (!help) {
                help = document.createElement('span');
                help.id = helpId;
                help.className = 'visually-hidden';
                (element.parentNode || element).appendChild(help);
            }
            help.textContent = content.text;
            control.setAttribute('aria-describedby', helpId);

            // Focus lands on the control, not the icon, so the popup binds there.
            if (options.showOnFocus !== false) {
                control.addEventListener('focus', () => this.show(icon, content, { immediate: true }));
                control.addEventListener('blur', () => this.hide());
            }

            return icon;
        }

        debug(message, data = null) {
            if (D.debug.enabled) {
                console.log(`[TooltipManager] ${message}`, data ? data : '');
            }
        }
    }

    window.TooltipManager = new TooltipManager();
})();