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
            this.coordXEl = document.getElementById(options.coordXId || 'coord-x');
            this.coordYEl = document.getElementById(options.coordYId || 'coord-y');
            this.zoomEl = document.getElementById(options.zoomId || 'zoom-level');
            this.coordPrecision = options.coordPrecision != null ? options.coordPrecision : 2;
            this.zoomPrecision = options.zoomPrecision != null ? options.zoomPrecision : 0;
            this.zoomDisplayFactor = options.zoomDisplayFactor != null ? options.zoomDisplayFactor : 10;
        }

        /**
         * @param {object} data Normalized pointer payload from InputManager.
         *                      Uses data.canvasX / data.canvasY (physical
         *                      canvas pixels - matches core.canvasToWorld).
         */
        updatePointer(data) {
            if (!this.coordXEl || !this.coordYEl) return;
            let world = this.core.canvasToWorld(data.canvasX, data.canvasY);
            world = this.applyInverseTransforms(world);
            this.coordXEl.textContent = world.x.toFixed(this.coordPrecision);
            this.coordYEl.textContent = world.y.toFixed(this.coordPrecision);
        }

        updateZoom() {
            if (!this.zoomEl) return;
            const pct = (this.core.viewScale * this.zoomDisplayFactor).toFixed(this.zoomPrecision);
            this.zoomEl.textContent = pct + '%';
        }

        /**
         * Maps a canvas-world point back through the user's coordinate
         * transforms (rotation → mirror → origin) so the chip shows file
         * coordinates, not raw render-space coordinates. Each inverse
         * collapses to identity when the corresponding renderer state is
         * default, so this is safe for EasyShape too.
         */
        applyInverseTransforms(p) {
            let { x, y } = p;

            if (this.core.currentRotation && this.core.rotationCenter) {
                const c = this.core.rotationCenter;
                const rad = -(this.core.currentRotation * Math.PI) / 180;
                const cos = Math.cos(rad), sin = Math.sin(rad);
                const dx = x - c.x, dy = y - c.y;
                x = c.x + (dx * cos - dy * sin);
                y = c.y + (dx * sin + dy * cos);
            }

            if (this.core.mirrorX || this.core.mirrorY) {
                const mc = this.core.mirrorCenter || { x: 0, y: 0 };
                if (this.core.mirrorX) x = 2 * mc.x - x;
                if (this.core.mirrorY) y = 2 * mc.y - y;
            }

            const origin = (typeof this.core.getOriginPosition === 'function')
                ? this.core.getOriginPosition()
                : { x: 0, y: 0 };

            return { x: x - origin.x, y: y - origin.y };
        }
    }

    window.CanvasReadout = CanvasReadout;
})();