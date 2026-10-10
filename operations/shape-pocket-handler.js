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
    const ROOT = globalThis;

    class ShapePocketHandler extends OffsetOperationHandler {

        // Offset direction hooks

        /*Pocketing always clears inward; cutSide is not a pocket parameter.*/
        resolveCutSide() { return 'inside'; }

        // Concentric rings of one pocket, outermost first: every pass lies
        // inside its predecessor's swath.
        allowsInternalStaydown() {
            return true;
        }

        // Pocket clearing intentionally collapses geometry inward until nothing remains - the circle-collapse guard must not fire.
        shouldGuardCircleCollapse() {
            return false;
        }

        // Orchestration
        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);

            // Detect nested holes/islands
            const resolved = this.resolveSourceTopology(operation, params);
            if (resolved) operation.primitives = resolved;

            // Validate: pocket requires closed geometry
            const openCount = this.countOpenPaths(operation);
            if (openCount > 0) {
                return {
                    success: false,
                    message: `${openCount} open path(s) detected. Pocket cutting requires closed shapes. Close paths in your SVG editor (the automated tool may not be implemented yet).`,
                    status: 'warning'
                };
            }

            // Concentric offset pocketing
            const opParams = core.pipelineContext.compileOperationParams(operation, params);
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
            const passCount = operation.offsets?.[0]?.metadata?.offset?.passes || operation.offsets?.length || 0;

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

    ROOT.ShapePocketHandler = ShapePocketHandler;
})();