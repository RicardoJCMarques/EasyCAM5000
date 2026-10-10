/*!
 * @file        input/canvas-readout.js REVIEW - Rename to canvas-state or canvas-stats? Can probably just be integrated into another module for simplicity.
 * @description Footer chip widget. Reads the renderer's current transform
 *              state and writes file-space coordinates + zoom percent to
 *              #coord-x / #coord-y / #zoom-level.
 *
 *              EasyTrace's renderer has origin / rotation / mirror state;
 *              EasyShape's renderer leaves them at identity. The same code
 *              works for both - the inverse transforms collapse to no-ops
 *              when state is identity.
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

    class CanvasReadout {
        /** @param {RendererCore} core */
        constructor(core) {
            this.core = core;
            this.coordXEl = document.getElementById('coord-x');
            this.coordYEl = document.getElementById('coord-y');
            this.zoomEl = document.getElementById('zoom-level');
            this._lastX = null;
            this._lastY = null;
            this._rafId = null;
            this._pendingData = null;
        }

        /**
         * @param {object} data Normalized pointer payload from InputManager.
         */
        updatePointer(data) {
            this._pendingData = data;
            if (null === this._rafId) {
                this._rafId = requestAnimationFrame(() => {
                    this._rafId = null;
                    if (!this._pendingData || !this.coordXEl || !this.coordYEl) return;
                    const pt = this.core.canvasToWorld(this._pendingData.canvasX, this._pendingData.canvasY);
                    const world = this.core.scene ? this.core.scene.worldToWorkspace(pt) : pt;
                    const sx = world.x.toFixed(2);
                    const sy = world.y.toFixed(2);
                    if (this._lastX !== sx) { this.coordXEl.textContent = sx; this._lastX = sx; }
                    if (this._lastY !== sy) { this.coordYEl.textContent = sy; this._lastY = sy; }
                });
            }
        }

        updateZoom() {
            if (!this.zoomEl) return;
            // viewScale × 10, as a percentage
            this.zoomEl.textContent = (this.core.viewScale * 10).toFixed(0) + '%';
        }
    }

    window.CanvasReadout = CanvasReadout;
})();