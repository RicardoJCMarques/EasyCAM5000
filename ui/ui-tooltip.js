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

            this.createTooltip();
        }

        createTooltip() {
            this.tooltip = document.createElement('div');
            this.tooltip.className = 'tooltip';
            this.tooltip.innerHTML = '<div class="tooltip-content"></div>';
            document.body.appendChild(this.tooltip);
        }

        show(target, content, options = {}) {
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

        // Helper to attach tooltip with icon
        attachWithIcon(element, content, options = {}) {
            const icon = document.createElement('span');
            icon.className = 'tooltip-trigger';
            icon.innerHTML = `<svg class="cam-icon" width="14" height="14"><use href="#icon-help"></use></svg>`;
            icon.setAttribute('tabindex', '0');
            icon.setAttribute('role', 'button');
            icon.setAttribute('aria-label', 'Show help');

            element.appendChild(icon);

            this.attach(icon, content, { ...options, showOnFocus: true });

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