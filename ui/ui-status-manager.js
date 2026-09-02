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
     * ProgressManager - single owner of long-task progress state and its
     * two views: the canvas overlay (#canvas-loading-overlay) and the
     * footer progress bar (#status-progress / #progress-bar).
     *
     * Contract:
     *   const id = sm.beginTask('V-Carve');   // replaces any current task
     *   sm.tick(id, { frac: 0.4, label: 'V-Carve 12/30 shapes' });
     *   sm.endTask(id);                        // idempotent; stale ids no-op
     *
     * Ticks are STRUCTURED ({frac, label}); frac == null renders as
     * indeterminate (spinner only, no bar). Formatting to a display string
     * happens in exactly ONE place (formatLabel). Rendering is coalesced
     * to at most one DOM write per animation frame, except beginTask,
     * which renders synchronously so the overlay is up before any
     * blocking work that follows.
     */
    class ProgressManager {
        constructor() {
            this._task = null;   // { id, label, frac, startedAt }
            this._taskSeq = 0;
            this._rafId = null;
            this.overlayEl = document.getElementById('canvas-loading-overlay');
            this.overlayMsgEl = document.getElementById('canvas-loading-message');
            this.progressContainerEl = document.getElementById('status-progress');
            this.progressBarEl = document.getElementById('progress-bar');
        }

        beginTask(label, opts = {}) {
            const id = ++this._taskSeq;
            this._task = { id, label: label || 'Working',
                           frac: opts.frac ?? null,
                           startedAt: performance.now() };
            this.onTaskEvent({ phase: 'begin', id, label: this._task.label });
            this.render(); // sync: visible before blocking work starts
            return id;
        }

        tick(id, p) {
            if (!this._task || id !== this._task.id) return; // stale/superseded
            if (typeof p === 'string') p = { label: p };     // tolerate legacy
            if (p.label != null) this._task.label = p.label;
            if (p.frac != null) this._task.frac = p.frac;
            this._schedule();
        }

        endTask(id) {
            if (!this._task || id !== this._task.id) return; // idempotent
            const ms = performance.now() - this._task.startedAt;
            this.onTaskEvent({ phase: 'end', id, label: this._task.label, ms });
            this._task = null;
            if (this._rafId !== null) { cancelAnimationFrame(this._rafId); this._rafId = null; }
            this.render();
        }

        /**
         * Subclasses observe the task lifecycle; the base owns no log view.
         */
        onTaskEvent(evt) {}

        isBusy() { return this._task !== null; }

        /**
         * THE one formatter - nothing else stringifies progress.
         */
        formatLabel(t) {
            const pct = (t.frac != null) ? ` ${Math.round(t.frac * 100)}%` : '';
            return `${t.label}…${pct}`;
        }

        _schedule() {
            if (this._rafId !== null) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this.render();
            });
        }

        render() {
            const t = this._task;
            if (this.overlayEl) {
                this.overlayEl.classList.toggle('hidden', !t);
                if (t && this.overlayMsgEl) {
                    this.overlayMsgEl.textContent = this.formatLabel(t);
                }
            }
            if (this.progressContainerEl) {
                const determinate = !!t && t.frac != null;
                this.progressContainerEl.classList.toggle('hidden', !determinate);
                if (determinate && this.progressBarEl) {
                    const w = Math.round(Math.min(1, Math.max(0, t.frac)) * 100);
                    this.progressBarEl.style.width = `${w}%`;
                    this.progressContainerEl.setAttribute('aria-valuenow', String(w));
                }
            }
        }

    }

    class StatusManager extends ProgressManager {
        constructor(ui) {
            super();
            this.ui = ui;
            this.lang = ui.lang;
            this.currentStatus = null;
            this.statusTimeout = null;

            this.logHistory = [];
            this.isExpanded = false;

            // Per-app strings. en.json localizes the app-neutral ones.
            this.text = ui.ctrl.appProfile.ui.text;

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

            // Add click listener to toggle the log
            this.statusBar.addEventListener('click', () => {
                this.toggleLog();
            });

            // Add initial hint message to the log
            this.addLogEntry(this.lang.get('ui.status.logHintViz', this.text.logHintViz || ''), 'info');

            this.statusTextEl = document.getElementById('status-text');
        }

        toggleLog() {
            this.isExpanded = !this.isExpanded;
            // Toggle classes on the new elements
            if (this.footerBar) {
                this.footerBar.classList.toggle('is-expanded', this.isExpanded);
            }
            if (this.logPanel) {
                this.logPanel.classList.toggle('is-expanded', this.isExpanded);
            }
            
            if (this.isExpanded) {
                this.renderLog(); // Render the log content when it's opened
            }
        }

        addLogEntry(message, type = 'normal') {
            const isDebug = type === 'debug';

            // If this is a debug message and the global debug flag is off, skip it.
            if (isDebug && !debugState.enabled) {
                return;
            }

            const timestamp = new Date().toLocaleTimeString();
            const logEntry = {
                timestamp,
                message,
                type
            };

            this.logHistory.push(logEntry);

            // Keep log from getting too big
            if (this.logHistory.length > D.ui.logHistoryMax) {
                this.logHistory.shift();
            }

            // If the log is open, append the new message
            if (this.isExpanded && this.logHistoryContainer) {
                this.appendLogEntry(logEntry);
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

        appendLogEntry(logEntry) {
            if (!this.logHistoryContainer) return;
            const shouldScroll = this.logHistoryContainer.scrollTop + this.logHistoryContainer.clientHeight >= this.logHistoryContainer.scrollHeight - 20;
            this.logHistoryContainer.appendChild(this.createLogElement(logEntry));
            if (shouldScroll) {
                this.logHistoryContainer.scrollTop = this.logHistoryContainer.scrollHeight;
            }
        }

        createLogElement(logEntry) {
            const p = document.createElement('p');
            p.className = `log-entry ${logEntry.type}`;
            p.textContent = `[${logEntry.timestamp}] ${logEntry.message}`;
            return p;
        }

        updateStatus(message = null, type = 'normal', skipLog = false) {
            if (!this.statusTextEl) return;

            // Set appropriate aria-live based on message type
            if (type === 'error') {
                this.statusTextEl.setAttribute('aria-live', 'assertive');
            } else {
                this.statusTextEl.setAttribute('aria-live', 'polite');
            }

            if (this.statusTimeout) {
                clearTimeout(this.statusTimeout);
                this.statusTimeout = null;
            }

            if (message) {
                this.statusTextEl.textContent = message;
                this.statusTextEl.className = `status-text ${type}`;
                this.currentStatus = { message, type };

                // Only add to permanent history if skipLog is false
                if (!skipLog) {
                    this.addLogEntry(message, type);
                }

                if (type === 'success' || type === 'info') {
                    const duration = timingConfig.statusMessageDuration;
                    this.statusTimeout = setTimeout(() => {
                        this.updateStatus(); // Reset to default
                    }, duration);
                }
            } else {
                // Reset to default status
                const hasOps = this.ui.core.hasValidOperations();
                let defaultMessage;
                if (hasOps) {
                    const stats = this.ui.core.getStats();
                    defaultMessage = this.lang
                        .get('ui.status.readyDynamic', 'Ready: {ops} operations, {prims} primitives')
                        .replace('{ops}', stats.operations)
                        .replace('{prims}', stats.totalPrimitives);
                } else {
                    defaultMessage = this.text.statusReady || this.lang.get('ui.status.default', 'Ready');
                }

                this.statusTextEl.textContent = defaultMessage;
                this.statusTextEl.className = 'status-text';
                this.currentStatus = null;
            }
        }

        debugLog(message) {
            this.addLogEntry(message, 'debug');
        }

        onTaskEvent(evt) {
            if (evt.phase === 'begin') this.debugLog(`Task started: ${evt.label}`);
            else this.debugLog(`Task done: ${evt.label} (${evt.ms.toFixed(0)}ms)`);
        }

        debug(message, data = null) {
            if (this.ui.debug) {
                this.ui.debug(`[StatusManager] ${message}`, data);
            }
        }
    }

    window.ProgressManager = ProgressManager;
    window.StatusManager = StatusManager;
})();