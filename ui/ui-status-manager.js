/*!
 * @file        ui/ui-status-manager.js
 * @description Manages the status bar, log panel and overlay heartbeats.
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
  const timingConfig = D.ui.timing;
  const debugState = D.debug;

  /**
   * ProgressManager - the one owner of long-task state and its two views:
   * the app-wide overlay (#loading-overlay, also the startup screen) and
   * the footer progress bar (#status-progress / #progress-bar).
   * Contract:
   *  const result = await sm.runTask(label, async task => {
   *   task.tick({ frac: 0.4, label });
   *   if (task.cancelled) ...
   *  }, { cancel });
   * One task at a time. While it runs the rest of the page is inert and
   * no key reaches it, so nothing is edited, dropped or started under the
   * overlay; `cancel`, when given, is what Cancel and Escape call, once.
   * Ticks are STRUCTURED ({frac, label}); frac == null renders as
   * indeterminate. Formatting to a display string happens in exactly ONE
   * place (formatLabel). Rendering is coalesced to at most one DOM write
   * per animation frame, except the start, which renders synchronously so
   * the overlay is up before any blocking work that follows.
   */
  class ProgressManager {
    constructor() {
      this._task = null;
      this._rafId = null;
      this.overlayEl = document.getElementById('loading-overlay');
      this.overlayMsgEl = document.getElementById('loading-text');
      this.cancelEl = document.getElementById('loading-cancel');
      // The overlay is a long task's only feedback; the live region
      // carries it to screen readers.
      this.overlayMsgEl.setAttribute('role', 'status');
      this.overlayMsgEl.setAttribute('aria-live', 'polite');
      this.cancelEl.addEventListener('click', () => this.cancelTask());
      // Added on window, capture phase, for the length of a task: no key
      // reaches the page under it. Tab still moves to Cancel.
      this._keyGuard = e => {
        e.stopPropagation();
        if (e.key === 'Escape') this.cancelTask();
      };
      this.progressContainerEl = document.getElementById('status-progress');
      this.progressBarEl = document.getElementById('progress-bar');
    }

    get busy() {
      return this._task !== null;
    }

    /**
     * Runs one long action under the overlay, from the call until `work`
     * settles, whatever it renders before returning included.
     * @param {string|Object} label - text or message descriptor
     * @param {(task: {tick: Function, cancelled: boolean}) => Promise<*>} work
     * @param {{cancel?: Function}} [options]
     * @returns {Promise<*>} what work returns
     */
    async runTask(label, work, { cancel = null } = {}) {
      // A task started inside another runs under it.
      if (this._task) return work(this._task.handle);
      const task = {
        label: label ?? i18n.t('status.working'),
        frac: null,
        cancel,
        cancelled: false,
        startedAt: performance.now(),
        returnFocus: document.activeElement,
        // What this task makes inert, and so all it releases.
        inert: [...document.body.children].filter(el => el !== this.overlayEl && el instanceof HTMLElement && !el.inert)
      };
      task.handle = {
        tick: progress => this.tick(task, progress),
        get cancelled() {
          return task.cancelled;
        }
      };
      this._task = task;
      for (const el of task.inert) el.inert = true;
      window.addEventListener('keydown', this._keyGuard, true);
      this.overlayEl.classList.add('is-task');
      this.cancelEl.classList.toggle('hidden', !cancel);
      this.cancelEl.disabled = false;
      this.onTaskEvent({ phase: 'begin', label: task.label });
      this.render();
      (cancel ? this.cancelEl : this.overlayEl).focus();
      try {
        // Two frames: the overlay is painted before the first blocking chunk.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return await work(task.handle);
      } finally {
        this.onTaskEvent({ phase: 'end', label: task.label, ms: performance.now() - task.startedAt });
        this._task = null;
        if (this._rafId !== null) {
          cancelAnimationFrame(this._rafId);
          this._rafId = null;
        }
        window.removeEventListener('keydown', this._keyGuard, true);
        for (const el of task.inert) el.inert = false;
        this.render();
        if (task.returnFocus?.isConnected) task.returnFocus.focus();
      }
    }

    /**
     * A task's progress, structured: `frac` (0..1) and `label`, each kept
     * when a tick leaves it out. Renders at most once per animation frame.
     */
    tick(task, progress) {
      if (this._task !== task || task.cancelled) return;
      if (progress.label != null) task.label = progress.label;
      if (progress.frac != null) task.frac = progress.frac;
      if (this._rafId !== null) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null;
        this.render();
      });
    }

    /** Cancel and Escape: asks the task to stop, once. */
    cancelTask() {
      const task = this._task;
      if (!task?.cancel || task.cancelled) return;
      task.cancelled = true;
      task.label = i18n.t('progress.cancelling');
      task.frac = null;
      this.cancelEl.disabled = true;
      this.render();
      task.cancel();
    }

    /** Subclasses observe the task lifecycle; the base owns no log view. */
    onTaskEvent(evt) {}

    /** THE one formatter - nothing else stringifies progress. */
    formatLabel(t) {
      const label = i18n.format(t.label);
      if (t.frac == null) return i18n.t('progress.overlay', { label });
      const percent = Math.round(Math.min(1, Math.max(0, t.frac)) * 100);
      return i18n.t('progress.overlayPercent', { label, percent });
    }

    render() {
      const t = this._task;
      this.overlayEl.classList.toggle('is-hidden', !t);
      if (t) this.overlayMsgEl.textContent = this.formatLabel(t);
      const determinate = !!t && t.frac != null;
      this.progressContainerEl.classList.toggle('hidden', !determinate);
      if (determinate) {
        const w = Math.round(Math.min(1, Math.max(0, t.frac)) * 100);
        this.progressBarEl.style.width = `${w}%`;
        this.progressContainerEl.setAttribute('aria-valuenow', String(w));
      }
    }
  }

  class StatusManager extends ProgressManager {
    constructor(ui) {
      super();
      this.ui = ui;
      this.currentStatus = null;
      this.statusTimeout = null;
      this.logHistory = [];
      this.isExpanded = false;
      this.footerBar = document.getElementById('footer-bar'); // The whole footer
      this.statusBar = document.getElementById('status-bar'); // The clickable center part
      this.logPanel = document.getElementById('status-log-panel');
      this.logHistoryContainer = document.getElementById('status-log-history');
      this.init();
    }

    init() {
      if (!this.statusBar || !this.logHistoryContainer || !this.footerBar) {
        console.error('[StatusManager] Failed to find required log elements.');
        return;
      }
      this.statusBar.addEventListener('click', () => {this.toggleLog();});
      // The bar is a div wrapping a live region, so it cannot itself be a
      // button. The chevron is the keyboard route to the log, which is
      // where every warning lands.
      this.logToggleEl = document.getElementById('log-toggle-icon');
      if (this.logToggleEl) {
        this.logToggleEl.setAttribute('role', 'button');
        this.logToggleEl.setAttribute('tabindex', '0');
        this.logToggleEl.setAttribute('aria-expanded', 'false');
        this.logToggleEl.setAttribute('aria-label', i18n.t('status.toggleLog'));
        // Keydown only: a role="button" span synthesises no click, and
        // the click that a real button would fire bubbles to the bar
        // handler above, toggling twice.
        this.logToggleEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggleLog(); }
        });
      }
      this.addLogEntry(i18n.t('status.logHintViz'), 'info');
      this.statusTextEl = document.getElementById('status-text');
      this.statusAlertEl = document.getElementById('status-alert');
      this.statusAnnounceEl = document.getElementById('status-announce');
    }

    toggleLog() {
      this.isExpanded = !this.isExpanded;
      if (this.footerBar) this.footerBar.classList.toggle('is-expanded', this.isExpanded);
      if (this.logPanel)  this.logPanel.classList.toggle('is-expanded', this.isExpanded);
      if (this.logToggleEl)  this.logToggleEl.setAttribute('aria-expanded', String(this.isExpanded));
      if (this.isExpanded)  this.renderLog();
    }

    addLogEntry(message, type = 'normal') {
      const isDebug = type === 'debug';
      // If this is a debug message and the global debug flag is off, skip it.
      if (isDebug && !debugState.enabled) return;
      const logEntry = {timestamp: i18n.time(), message: i18n.format(message), type};
      this.logHistory.push(logEntry);
      // Keep log from getting too big
      if (this.logHistory.length > D.ui.logHistoryMax) this.logHistory.shift();
      // An open log follows the new entry only if it was already at the bottom.
      const box = this.logHistoryContainer;
      if (this.isExpanded && box) {
        const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
        box.appendChild(this.createLogElement(logEntry));
        if (atBottom) box.scrollTop = box.scrollHeight;
      }
    }

    renderLog() {
      if (!this.logHistoryContainer) return;
      const fragment = document.createDocumentFragment();
      for (const entry of this.logHistory) {
        fragment.appendChild(this.createLogElement(entry));
      }
      this.logHistoryContainer.innerHTML = '';
      this.logHistoryContainer.appendChild(fragment);
      this.logHistoryContainer.scrollTop = this.logHistoryContainer.scrollHeight;
    }

    createLogElement(logEntry) {
      const p = document.createElement('p');
      p.className = `log-entry ${logEntry.type}`;
      p.textContent = `[${logEntry.timestamp}] ${logEntry.message}`;
      return p;
    }

    /**
     * One status line, logged unless `log` is false. `notes` are warnings
     * that belong to the message: each gets its own log entry and the
     * line only counts them.
     * @param {string|Object|Error|null} [message] - null restores the idle line
     * @param {string} [type]
     * @param {{notes?: Array, log?: boolean}} [options]
     */
    updateStatus(message = null, type = 'normal', { notes = [], log = true } = {}) {
      if (!this.statusTextEl) return;
      const text = i18n.format(message);
      const line = text && notes.length > 0 ? i18n.t('status.withNotes', { message: text, count: notes.length }) : text;
      // #status-text is visual only.
      if (this.statusAnnounceEl) this.statusAnnounceEl.textContent = line && type !== 'error' ? line : '';
      if (this.statusAlertEl) this.statusAlertEl.textContent = type === 'error' && line ? line : '';
      if (this.statusTimeout) {
        clearTimeout(this.statusTimeout);
        this.statusTimeout = null;
      }
      if (line) {
        this.statusTextEl.textContent = line;
        this.statusTextEl.className = `status-text ${type}`;
        this.currentStatus = { message: line, type };
        if (log) {
          this.addLogEntry(text, type);
          for (const note of notes) this.addLogEntry(note, 'warning');
        }
        if (type === 'success' || type === 'info') this.statusTimeout = setTimeout(() => this.updateStatus(), timingConfig.statusMessageDuration);
        return;
      }

      // Idle line
      if (this.ui.core.store.operations.some(op => op.primitives?.length > 0)) {
      const stats = this.ui.core.store.getStats();
      this.statusTextEl.textContent = i18n.t('status.readyStats', {
        operations: {key: 'status.operationCount', values: {count: stats.operations}},
        primitives: {key: 'status.primitiveCount', values: {count: stats.totalPrimitives}}
      });
      } else {
        this.statusTextEl.textContent = i18n.t('status.ready');
      }
      this.statusTextEl.className = 'status-text';
      this.currentStatus = null;
    }

    debugLog(message) {
      this.addLogEntry(message, 'debug');
    }

    onTaskEvent(evt) {
      const label = i18n.format(evt.label);
      if (evt.phase === 'begin') this.debugLog(`Task started: ${label}`);
      else this.debugLog(`Task done: ${label} (${evt.ms.toFixed(0)}ms)`);
    }

    debug(message, data = null) {
      if (this.ui.debug) this.ui.debug(`[StatusManager] ${message}`, data);
    }
  }

  window.StatusManager = StatusManager;
})();