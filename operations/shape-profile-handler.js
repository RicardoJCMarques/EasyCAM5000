/*!
 * @file        operations/shape-profile-handler.js
 * @description Profile cut handler for EasyShape5000.
 *              Extends OffsetOperationHandler with cutSide control and
 *              holding tab support. Does NOT extend CutoutOperationHandler
 *              because cutout's classifyPrimitives (closure detection) is
 *              irrelevant - EasyShape primitives are already closed paths
 *              from SVG import.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapeProfileHandler extends OffsetOperationHandler {

        // Offset direction hooks

        isInternalOffset(operation, settings) {
            return settings.cutSide === 'inside';
        }

        isOnLine(operation, settings) {
            return settings.cutSide === 'on';
        }

        // Orchestration

        resolveSourceTopology(operation, params) {
            return this.resolveContourTopology(
                operation.primitives, { mergeNesting: params.detectNesting === true });
        }

        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);

            // The base orchestration calls this immediately after the token;
            // overriding orchestration meant detectNesting reached the hook and
            // the hook was never invoked.
            const resolved = this.resolveSourceTopology(operation, params);
            if (resolved) operation.primitives = resolved;

            // Validate: profile requires closed geometry
            const openCount = this.countOpenPaths(operation);
            if (openCount > 0) {
                return {
                    success: false,
                    message: `${openCount} open path(s) detected. Profile cutting requires closed shapes.`,
                    status: 'warning'
                };
            }

            const opParams = core.compileOperationParams(operation, params);

            // Profile always produces a single offset pass per shape
            await this.generateGeometry(operation, {
                ...params,
                ...opParams,
                passes: 1,
                combineOffsets: false
            });

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation superseded by a newer request', status: 'warning' };
            }

            const total = operation.offsets?.reduce(
                (s, o) => s + (o.primitives?.length || 0), 0
            ) || 0;

            if (total === 0) {
                return {
                    success: false,
                    message: 'No profile path generated - tool may be too large for the shape',
                    status: 'warning'
                };
            }

            return {
                success: true,
                message: `Profile path generated (${opParams.cutSide || 'outside'} cut)`,
                status: 'success'
            };
        }
    }

    window.ShapeProfileHandler = ShapeProfileHandler;
})();