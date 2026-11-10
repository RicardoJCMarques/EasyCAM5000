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
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'tooltip';
      this.tooltip.innerHTML = '<div class="tooltip-content"></div>';
      document.body.appendChild(this.tooltip);
      this.currentTarget = null; // the visible tooltip's trigger
      this.showTimeout = null;
      this.hideTimeout = null;
      this.delayShow = D.ui.tooltips.delayShow;
      this.delayHide = D.ui.tooltips.delayHide;
      this._seq = 0;
      this._dismissed = null;
      this._keyboard = false;
      // Content shown on hover must be dismissible without moving the
      // pointer or focus (WCAG 1.4.13). The dismissed trigger stays quiet
      // until the pointer moves.
      document.addEventListener('keydown', e => {
        this._keyboard = true;
        if (e.key === 'Escape' && this.currentTarget) {
          this._dismissed = this.currentTarget;
          this.hideNow();
        }
      }, true);
      document.addEventListener('mousemove', () => {this._dismissed = null;}, {passive: true});
      // Focus shows help only when it came from the keyboard: a click that
      // focuses a field has the hover tooltip for that.
      document.addEventListener('pointerdown', () => {
        this._keyboard = false;
      }, true);
      // Hoverable: moving onto the tooltip keeps it open long enough to
      // read one that overflows its trigger.
      this.tooltip.addEventListener('mouseenter', () => clearTimeout(this.hideTimeout));
      this.tooltip.addEventListener('mouseleave', () => this.hide());
      // Help given as a function is worded when shown. The description
      // it gives its control is worded again on a language change, so
      // such help is for controls that live as long as the page.
      this.liveDescriptions = [];
      window.addEventListener('localechange', () => {
        for (const { help, content } of this.liveDescriptions) help.textContent = content().text;
      });
    }

    /**
     * `content` is {title, text}, or a function returning it. A tooltip
     * already up swaps at once: waiting out the delay would leave it standing
     * over the new trigger.
     */
    show(target, content, options = {}) {
      if (target === this._dismissed) return;
      clearTimeout(this.showTimeout);
      clearTimeout(this.hideTimeout);
      const delay = options.immediate || this.currentTarget ? 0 : this.delayShow;
      this.showTimeout = setTimeout(() => {
        this.currentTarget = target;
        this.renderContent(typeof content === 'function' ? content() : content);
        this.position(target);
        this.tooltip.classList.add('visible');
      }, delay);
    }

    hide() {
      clearTimeout(this.showTimeout);
      clearTimeout(this.hideTimeout);
      this.hideTimeout = setTimeout(() => this.hideNow(), this.delayHide);
    }

    hideNow() {
      clearTimeout(this.showTimeout);
      clearTimeout(this.hideTimeout);
      this.tooltip.classList.remove('visible');
      this.currentTarget = null;
    }

    renderContent({ title, text }) {
      const parts = [];
      if (title) {
        const heading = document.createElement('div');
        heading.className = 'tooltip-title';
        heading.textContent = title;
        parts.push(heading);
      }
      const body = document.createElement('div');
      body.className = 'tooltip-text';
      body.textContent = text;
      parts.push(body);
      this.tooltip.firstElementChild.replaceChildren(...parts);
    }

    /**
     * Centred above the trigger, below it when there is no room above, and
     * inside the viewport. Measured at the viewport origin: where it last
     * stood, the viewport edge can squeeze the box.
     */
    position(target) {
      const gap = 8;
      const rect = target.getBoundingClientRect();
      this.tooltip.style.left = '0px';
      this.tooltip.style.top = '0px';
      const { width, height } = this.tooltip.getBoundingClientRect();
      const above = rect.top - height - gap;
      const top = above >= gap ? above : rect.bottom + gap;
      const left = Math.min(Math.max(gap, rect.left + (rect.width - width) / 2), window.innerWidth - width - gap);
      this.tooltip.style.left = `${left}px`;
      this.tooltip.style.top = `${top}px`;
    }

    /** Hover help, plus keyboard-focus help with options.showOnFocus. */
    attach(element, content, options = {}) {
      element.addEventListener('mouseenter', () => this.show(element, content, options));
      element.addEventListener('mouseleave', () => this.hide());
      if (options.showOnFocus) this.bindFocus(element, element, content);
    }

    /** Shows `trigger`'s tooltip while `control` has keyboard focus. */
    bindFocus(control, trigger, content) {
      control.addEventListener('focus', () => {
        if (this._keyboard) this.show(trigger, content, { immediate: true });
      });
      control.addEventListener('blur', () => this.hide());
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
      icon.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
      });
      // Before the description work below, which returns early on any
      // target that is not a label with a control - a toolbar icon would
      // otherwise end up with no tooltip at all.
      this.attach(icon, content, { ...options, showOnFocus: false });
      // A field built before it is in the document passes its control:
      // label.control only resolves inside a document.
      const control = options.control ?? (element.tagName === 'LABEL' ? element.control || element.querySelector('input, select, textarea') : null);
      const words = typeof content === 'function' ? content() : content;
      if (!control || !words?.text) return icon;
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
      help.textContent = words.text;
      if (typeof content === 'function') this.liveDescriptions.push({ help, content });
      const described = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      described.add(helpId);
      control.setAttribute('aria-describedby', [...described].join(' '));
      // Focus lands on the control, not the icon, so the popup binds there.
      if (options.showOnFocus !== false) this.bindFocus(control, icon, content);
      return icon;
    }
  }

  window.TooltipManager = new TooltipManager();
})();