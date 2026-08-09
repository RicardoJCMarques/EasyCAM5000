/*!
 * @file        operations/shape-drill-handler.js
 * @description Drill handler for EasyShape5000.
 *              Thin extension of DrillHandler. The base class
 *              already handles SVG circle/obround classification, peck vs
 *              mill strategy, and compound path recovery - all of which
 *              apply identically to EasyShape's SVG-imported shapes.
 *
 *              The only EasyShape-specific behavior: shapes arrive one at
 *              a time (per-shape operations) rather than as a batch file.
 *              The base handler's classifySVGDrillPrimitives already
 *              processes single primitives correctly so no override needed.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapeDrillHandler extends DrillHandler {

        /**
         * Override postParsePrimitives to handle shapes that are already
         * classified. When EasyShape assigns a drill operation to a circle
         * shape, the primitive doesn't have role tags yet - the base class
         * SVG classifier adds them.
         */
        postParsePrimitives(operation) {
            this.classifySVGDrillPrimitives(operation);
        }

        /**
         * Ensures drill classification runs before strategy planning.
         * syncPrimitives copies raw primitives without calling postParsePrimitives,
         * so role tags (drill_hole, drill_slot) are missing. Classify here.
         */
        async orchestrateGeneration(operation, params, core, options = {}) {
            // Classify primitives if they lack role tags (fresh from syncPrimitives)
            const needsClassification = operation.primitives?.length > 0 &&
                !operation.primitives.some(p => p.properties?.role);
            if (needsClassification) {
                this.classifySVGDrillPrimitives(operation);
            }

            return super.orchestrateGeneration(operation, params, core, options);
        }
    }

    window.ShapeDrillHandler = ShapeDrillHandler;
})();