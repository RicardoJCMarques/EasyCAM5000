/*!
 * @file        input/canvas-readout.js REVIEW - Rename to canvas-state or canvas-stats? Can probably just be integrated into another module for simplicity.
 * @description Footer chip widget. Reads the renderer's current transform
 *              state and writes file-space coordinates + zoom percent to
 *              #coord-x / #coord-y / #zoom-level.
 *
 *              Replaces the readout methods that used to live inside the
 *              old InteractionHandler. Knows about renderer transforms but
 *              not about input. The InputManager pings updatePointer() on
 *              every pointermove (so the chip keeps tracking even when a
 *              tool consumes the gesture); tools call updateZoom() after
 *              any zoom change.
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
        /**
         * @param {RendererCore} core
         * @param {object} [options]
         * @param {string} [options.coordXId='coord-x']
         * @param {string} [options.coordYId='coord-y']
         * @param {string} [options.zoomId='zoom-level']
         * @param {number} [options.coordPrecision=2]
         * @param {number} [options.zoomPrecision=0]
         * @param {number} [options.zoomDisplayFactor=10]  Multiplier applied
         *        to viewScale before formatting. 10 reproduces EasyTrace's
         *        legacy "viewScale * 10 + %" display.
         */
        constructor(core, options = {}) {
            this.core = core;
            this.coordXEl = document.getElementById(options.coordXId || "coord-x");
            this.coordYEl = document.getElementById(options.coordYId || "coord-y");
            this.zoomEl = document.getElementById(options.zoomId || "zoom-level");
            this.coordPrecision = null != options.coordPrecision ? options.coordPrecision : 2;
            this.zoomPrecision = null != options.zoomPrecision ? options.zoomPrecision : 0;
            this.zoomDisplayFactor = null != options.zoomDisplayFactor ? options.zoomDisplayFactor : 10;
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
                    const sx = world.x.toFixed(this.coordPrecision);
                    const sy = world.y.toFixed(this.coordPrecision);
                    if (this._lastX !== sx) { this.coordXEl.textContent = sx; this._lastX = sx; }
                    if (this._lastY !== sy) { this.coordYEl.textContent = sy; this._lastY = sy; }
                });
            }
        }

        updateZoom() {
            if (!this.zoomEl) return;
            const pct = (this.core.viewScale * this.zoomDisplayFactor).toFixed(this.zoomPrecision);
            this.zoomEl.textContent = pct + '%';
        }
    }

    window.CanvasReadout = CanvasReadout;
})();