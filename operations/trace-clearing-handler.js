/*!
 * @file        operations/trace-clearing-handler.js
 * @description Copper clearing - always-internal offsets with cut-in resolution
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class TraceClearingHandler extends OffsetOperationHandler {

        isCopperOperation() { return true; }
        isInternalOffset() { return true; }
        isOnLine() { return false; }

        getToolpathPolicy() {
            return {
                staydownPartition: 'proximity'
            };
        }

        /**
         * Clearing intentionally collapses geometry inward until nothing
         * remains - the circle-collapse guard must not fire.
         */
        shouldGuardCircleCollapse() {
            return false;
        }

        /**
         * Detect nested topology before offsetting. Without this,
         * internal offsets collapse inner shapes (which should act as
         * holes) instead of expanding them, producing false "tool too
         * large" errors on complex multi-polygon geometry.
         */
        async orchestrateGeneration(operation, params, core, options = {}) {
            // Both tiers: compounds (glyphs, nested fills) + separate
            // loops (multi-polygon pour fragments that contain each other).
            operation.primitives = this.resolveContourTopology(
                operation.primitives, { mergeNesting: true }
            );

            return super.orchestrateGeneration(operation, params, core, options);
        }

        /**
         * Laser clearance zone: the source geometry itself IS the area to fill.
         * Fuse primitives into clean polygons for hatching/filling.
         */
        async getClearanceZone(operation, settings) {
            const result = await this.core.geometryProcessor.fuseGeometry(
                operation.primitives
            );
            this.debug(`Clearing zone from source geometry: ${result.length} polygon(s)`);
            return result;
        }
    }

    window.TraceClearingHandler = TraceClearingHandler;
})();