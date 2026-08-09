/*!
 * @file        input/tools-common.js
 * @description Cross-app tools. Currently:
 *
 *              PanZoomTool - pans on mouse drag (configurable buttons),
 *                zooms on wheel, pinch-zooms on two-pointer touch.
 *
 *                EasyTrace uses it as the DEFAULT tool with allowedButtons
 *                = [0, 1, 2] (every button pans, current EasyTrace behavior).
 *
 *                EasyShape uses it as an OVERRIDE tool with allowedButtons
 *                = [1, 2], pushed on middle/right pointerdown and popped on
 *                pointerup. EasyShape's SelectMoveTool owns left-click and
 *                wheel zoom from idle - PanZoomTool's onWheel still runs
 *                only when the tool is the active one.
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

    const DEFAULT_WHEEL_ZOOM_SPEED = 0.002;
    // Minimum pinch ratio change before applying - filters tremor.
    const PINCH_DEADBAND = 0.005;

    class PanZoomTool extends BaseTool {
        /**
         * @param {object}   [options]
         * @param {number[]} [options.allowedButtons=[1,2]]  Buttons that pan
         *                                                   on drag.
         * @param {number}   [options.wheelZoomSpeed]        Wheel zoom rate.
         * @param {string}   [options.cursor]                Cursor while
         *                                                   active (default
         *                                                   inherits canvas).
         */
        constructor(options = {}) {
            super();
            this.allowedButtons = options.allowedButtons || [1, 2];
            this.wheelZoomSpeed = options.wheelZoomSpeed != null
                ? options.wheelZoomSpeed
                : DEFAULT_WHEEL_ZOOM_SPEED;
            this.cursorActive = options.cursor || null;

            // Single-pointer pan state
            this.lastClient = null;
            this.button = -1;

            // Two-pointer pinch state
            this.pinchActive = false;
            this.pinchLastDistance = 0;
            this.pinchLastMid = null;  // CSS pixels
        }

        onActivate(ctx) {
            // EasyShape's override - show a grab cursor. EasyTrace uses this as default so avoid clobbering the cursor.
            if (this.cursorActive && ctx.canvas) {
                ctx.canvas.style.cursor = this.cursorActive;
            }
            // EasyShape sets the global panning flag here; EasyTrace doesn't need it - pass cursor=null and leave the class alone.
            if (this.cursorActive) {
                document.documentElement.classList.add('is-panning');
            }
        }

        onDeactivate(ctx) {
            if (this.cursorActive && ctx.canvas) {
                ctx.canvas.style.cursor = 'default';
            }
            if (this.cursorActive) {
                document.documentElement.classList.remove('is-panning');
            }
            this.lastClient = null;
            this.button = -1;
            this.pinchActive = false;
            this.pinchLastDistance = 0;
            this.pinchLastMid = null;
        }

        onPointerDown(data, ctx) {
            // Touch / pen primary press always reports button 0. For the
            // EasyTrace [0,1,2] case this is fine. For the EasyShape [1,2]
            // case, touch never enters PanZoomTool through this path -
            // single-touch falls to SelectMoveTool. Pinch on EasyShape is a
            // known gap (flagged in the action plan).
            const active = ctx.input ? ctx.input.activePointers.size : 1;

            // Always start a pinch if there are 2 pointers, regardless of allowedButtons
            if (active === 2) {
                this.startPinch(ctx);
                return true;
            }

            // Normal panning restriction applies only to single-pointer moves
            if (!this.allowedButtons.includes(data.button)) return false;

            this.lastClient = { x: data.clientX, y: data.clientY };
            this.button = data.button;
            return true;
        }

        onPointerMove(data, ctx) {
            // Pinch path takes priority when two pointers held.
            const pointers = ctx.input ? ctx.input.activePointers : null;
            if (pointers && pointers.size === 2) {
                if (!this.pinchActive) this.startPinch(ctx);
                this.updatePinch(ctx);
                return true;
            }

            // Single-pointer pan.
            if (!this.lastClient) return false;
            const dpr = window.devicePixelRatio || 1;
            const dx = (data.clientX - this.lastClient.x) * dpr;
            const dy = (data.clientY - this.lastClient.y) * dpr;
            ctx.renderer.core.pan(dx, dy);
            ctx.renderer.render();
            this.lastClient = { x: data.clientX, y: data.clientY };
            return true;
        }

        onPointerUp(data, ctx) {
            const pointers = ctx.input ? ctx.input.activePointers : null;

            if (this.pinchActive) {
                // 2→1 transition: resync the single-pointer pan anchor so we
                // don't get a jump when the user lifts one finger.
                if (pointers && pointers.size === 1) {
                    const remaining = Array.from(pointers.values())[0];
                    this.lastClient = { x: remaining.clientX, y: remaining.clientY };
                    this.pinchActive = false;
                    this.pinchLastDistance = 0;
                    this.pinchLastMid = null;
                    return true;
                }
                // Fully released - clear everything.
                this.pinchActive = false;
                this.pinchLastDistance = 0;
                this.pinchLastMid = null;
            }

            this.lastClient = null;
            this.button = -1;
            return true;
        }

        onWheel(data, ctx) {
            const zoomFactor = Math.exp(-data.deltaY * this.wheelZoomSpeed);
            ctx.renderer.core.zoomToPoint(data.canvasX, data.canvasY, zoomFactor);
            ctx.renderer.render();
            return true;
        }

        // ─── Pinch helpers ────────────────────────────────────────────

        startPinch(ctx) {
            const pts = this.getActivePointers(ctx);
            if (pts.length < 2) return;

            const [a, b] = pts;
            const dx = b.clientX - a.clientX;
            const dy = b.clientY - a.clientY;
            this.pinchLastDistance = Math.sqrt(dx * dx + dy * dy);
            this.pinchLastMid = {
                x: (a.clientX + b.clientX) / 2,
                y: (a.clientY + b.clientY) / 2
            };
            this.pinchActive = true;
            // Cancel any single-pointer anchor so the 1→2 transition doesn't
            // double-apply pan.
            this.lastClient = null;
        }

        updatePinch(ctx) {
            const pts = this.getActivePointers(ctx);
            if (pts.length < 2 || !this.pinchLastMid) return;

            const [a, b] = pts;
            const dx = b.clientX - a.clientX;
            const dy = b.clientY - a.clientY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const midX = (a.clientX + b.clientX) / 2;
            const midY = (a.clientY + b.clientY) / 2;

            const dpr = window.devicePixelRatio || 1;

            // Pan by midpoint delta first (CSS px → physical px).
            const panDx = (midX - this.pinchLastMid.x) * dpr;
            const panDy = (midY - this.pinchLastMid.y) * dpr;
            if (Math.abs(panDx) > 1 || Math.abs(panDy) > 1) {
                ctx.renderer.core.pan(panDx, panDy);
            }

            // Then zoom about the midpoint.
            if (this.pinchLastDistance > 0) {
                const ratio = distance / this.pinchLastDistance;
                if (Math.abs(1 - ratio) > PINCH_DEADBAND) {
                    const rect = ctx.canvas.getBoundingClientRect();
                    const canvasX = (midX - rect.left) * dpr;
                    const canvasY = (midY - rect.top) * dpr;
                    ctx.renderer.core.zoomToPoint(canvasX, canvasY, ratio);
                    if (ctx.canvasReadout) ctx.canvasReadout.updateZoom();
                }
            }

            ctx.renderer.render();
            this.pinchLastDistance = distance;
            this.pinchLastMid = { x: midX, y: midY };
        }

        getActivePointers(ctx) {
            if (!ctx.input) return [];
            return Array.from(ctx.input.activePointers.values());
        }
    }

    window.PanZoomTool = PanZoomTool;
})();