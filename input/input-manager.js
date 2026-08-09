/*!
 * @file        input/input-manager.js
 * @description Unified Pointer/Wheel/Keyboard input normalization.
 *
 *              Attaches at CAPTURE phase so it gets first refusal on every
 *              gesture. When a tool consumes an event the manager calls
 *              stopPropagation + preventDefault.
 *
 *              Knows nothing about shapes, cameras, or the scene. Translates
 *              raw DOM events into a uniform shape and dispatches them to a
 *              consumer (the ToolController). Optionally pings a CanvasReadout
 *              on every pointer move so the coordinate display keeps updating
 *              even when a tool consumes the gesture.
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

    class InputManager {
        constructor(target, options = {}) {
            this.target = target;
            this.ctrl = null;

            // Optional CanvasReadout. Pinged on every pointermove regardless
            // of tool consumption so the footer's coord display never freezes
            // mid-drag.
            this.readout = options.readout || null;

            this.activePointers = new Map();

            this.onPointerDown = this.handlePointerDown.bind(this);
            this.onPointerMove = this.handlePointerMove.bind(this);
            this.onPointerUp = this.handlePointerUp.bind(this);
            this.onPointerCancel = this.handlePointerUp.bind(this);
            this.onWheel = this.handleWheel.bind(this);
            this.onContextMenu = e => e.preventDefault();
        }

        attach(ctrl) {
            this.ctrl = ctrl;

            this.target.addEventListener('pointerdown', this.onPointerDown, { capture: true });
            this.target.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
            this.target.addEventListener('contextmenu', this.onContextMenu);

            window.addEventListener('pointermove', this.onPointerMove);
            window.addEventListener('pointerup', this.onPointerUp);
            window.addEventListener('pointercancel', this.onPointerCancel);
        }

        detach() {
            this.target.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
            this.target.removeEventListener('wheel', this.onWheel, { capture: true });
            this.target.removeEventListener('contextmenu', this.onContextMenu);
            window.removeEventListener('pointermove', this.onPointerMove);
            window.removeEventListener('pointerup', this.onPointerUp);
            window.removeEventListener('pointercancel', this.onPointerCancel);
            this.ctrl = null;
        }

        setReadout(readout) {
            this.readout = readout;
        }

        normalize(e) {
            const rect = this.target.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            return {
                id: e.pointerId,
                pointerType: e.pointerType || 'mouse',
                button: e.button,
                buttons: e.buttons,
                isPrimary: e.isPrimary !== false,
                clientX: e.clientX,
                clientY: e.clientY,
                cssX: e.clientX - rect.left,
                cssY: e.clientY - rect.top,
                canvasX: (e.clientX - rect.left) * dpr,
                canvasY: (e.clientY - rect.top) * dpr,
                shiftKey: !!e.shiftKey,
                ctrlKey: !!e.ctrlKey,
                metaKey: !!e.metaKey,
                altKey: !!e.altKey,
                deltaX: e.deltaX || 0,
                deltaY: e.deltaY || 0,
                deltaMode: e.deltaMode || 0,
                rawEvent: e
            };
        }

        handlePointerDown(e) {
            if (!this.ctrl) return;
            const data = this.normalize(e);
            this.activePointers.set(data.id, data);

            if (this.target.setPointerCapture && data.isPrimary) {
                try { this.target.setPointerCapture(data.id); } catch (_) { /* ignore */ }
            }

            const consumed = this.ctrl.dispatch('PointerDown', data);
            if (consumed) {
                e.stopPropagation();
                if (e.cancelable) e.preventDefault();
            }
        }

        handlePointerMove(e) {
            if (!this.ctrl) return;
            const data = this.normalize(e);
            if (this.activePointers.has(data.id)) {
                this.activePointers.set(data.id, data);
            }

            // Update the coordinate display BEFORE dispatch. This way the
            // footer keeps tracking even when a tool consumes (e.g. during
            // a drag-move) and calls stopPropagation.
            if (this.readout) this.readout.updatePointer(data);

            const consumed = this.ctrl.dispatch('PointerMove', data);
            if (consumed) e.stopPropagation();
        }

        handlePointerUp(e) {
            if (!this.ctrl) return;
            const data = this.normalize(e);
            this.activePointers.delete(data.id);
            const consumed = this.ctrl.dispatch('PointerUp', data);
            if (consumed) e.stopPropagation();
        }

        handleWheel(e) {
            if (!this.ctrl) return;
            const data = this.normalize(e);
            const consumed = this.ctrl.dispatch('Wheel', data);
            if (consumed) {
                e.stopPropagation();
                if (e.cancelable) e.preventDefault();
                // Tool changed the zoom - reflect it in the footer chip.
                if (this.readout) this.readout.updateZoom();
            }
        }
    }

    window.InputManager = InputManager;
})();