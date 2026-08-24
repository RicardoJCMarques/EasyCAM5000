/*!
 * @file        operations/trace-isolation-handler.js
 * @description Isolation routing - external offsets around copper with cut-in resolution
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class TraceIsolationHandler extends OffsetOperationHandler {

        isCopperOperation() { return true; }
        isOnLine() { return false; }

        getToolpathPolicy() {
            return {
                staydownPartition: 'proximity'
            };
        }

        /**
         * Tier 1 only - isolation can have thousands of primitives, so skip
         * the O(n²) inter-primitive merge.
         */
        resolveSourceTopology(operation) {
            return this.resolveContourTopology(operation.primitives);
        }

        /**
         * Laser clearance zone: expanded copper minus original copper (halo around traces).
         */
        async getClearanceZone(operation, settings) {
            const step = settings.toolDiameter * (settings.stepOver / 100);
            const isolationWidth = settings.isolationWidth
                || (settings.toolDiameter + Math.max(0, (settings.passes || 1) - 1) * step)
                || 0.3;
            this.debug(`Isolation clearance width: ${isolationWidth.toFixed(3)}mm`);
            return this.generateClearancePolygon(operation, isolationWidth);
        }
    }

    window.TraceIsolationHandler = TraceIsolationHandler;
})();