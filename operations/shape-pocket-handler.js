/*!
 * @file        operations/shape-pocket-handler.js
 * @description Pocket clearing handler for EasyShape5000.
 *              Always-internal offsets with stepover-based pass count.
 *              Extends OffsetOperationHandler.
 *
 *              Future: raster (zig-zag) and continuous spiral strategies.
 *              Currently only concentric offset pocketing is implemented.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapePocketHandler extends OffsetOperationHandler {

        // Offset direction hooks

        // Pockets are always internal - tool clears inside the shape boundary.
        isInternalOffset() {
            return true;
        }

        isOnLine() {
            return false;
        }

        getToolpathPolicy() {
            return {
                staydownPartition: 'shape'
            };
        }

        // Pocket clearing intentionally collapses geometry inward until nothing remains - the circle-collapse guard must not fire.
        shouldGuardCircleCollapse() {
            return false;
        }

        // Orchestration

        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);

            // Validate: pocket requires closed geometry
            const openCount = this.countOpenPaths(operation);
            if (openCount > 0) {
                return {
                    success: false,
                    message: `${openCount} open path(s) detected. Pocket cutting requires closed shapes. Close paths in your SVG editor (the automated too may not be implemented yet).`,
                    status: 'warning'
                };
            }

            const strategy = params.pocketStrategy || 'offset';

            // Raster / zig-zag (future)
            if (strategy === 'raster') {
                return {
                    success: false,
                    message: 'Raster pocket strategy not implemented yet. Use concentric offsets.',
                    status: 'warning'
                };
            }

            // Concentric offset pocketing
            const opParams = core.compileOperationParams(operation, params);

            // Resolve compound contours (tier 1) and merge separate
            // shapes that nest inside each other (tier 2).
            operation.primitives = this.resolveContourTopology(
                operation.primitives, { mergeNesting: params.detectNesting !== false }
            );

            await this.generateGeometry(operation, {
                ...params,
                ...opParams,
                combineOffsets: true
            });

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation superseded by a newer request', status: 'warning' };
            }

            const total = operation.offsets?.reduce(
                (s, o) => s + (o.primitives?.length || 0), 0
            ) || 0;
            const passCount = operation.offsets?.[0]?.metadata?.offset?.passes
                || operation.offsets?.length || 0;

            if (total === 0) {
                return {
                    success: false,
                    message: 'No pocket paths generated - tool may be too large for the shape',
                    status: 'warning'
                };
            }

            return {
                success: true,
                message: `Pocket cleared: ${total} path(s) across ${passCount} pass(es)`,
                status: 'success'
            };
        }
    }

    window.ShapePocketHandler = ShapePocketHandler;
})();