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
    const ROOT = globalThis;

    class TraceClearingHandler extends OffsetOperationHandler {

        isCopperOperation() { return true; }
        /** Copper clearing always grows inward from the region boundary. */
        resolveCutSide() { return 'inside'; }

        getToolpathPolicy() {
            return {
                staydownPartition: 'proximity'
            };
        }

        /**
         * Copper pours clear concentrically like a pocket. A pour that breaks
         * into islands yields more than one contour in a pass and the translator
         * stops welding there, so this is safe to declare unconditionally.
         */
        allowsInternalStaydown() {
            return true;
        }

        /**
         * Clearing intentionally collapses geometry inward until nothing
         * remains - the circle-collapse guard must not fire.
         */
        shouldGuardCircleCollapse() {
            return false;
        }

        /**
         * Both tiers: pour fragments contain each other, and an inner fragment
         * left unmerged collapses under the internal offset instead of acting as
         * a hole - reported as a false "tool too large".
         */
        resolveSourceTopology(operation) {
            return this.resolveContourTopology(operation.primitives, { mergeNesting: true });
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

    ROOT.TraceClearingHandler = TraceClearingHandler;
})();