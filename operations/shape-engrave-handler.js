/*!
 * @file        operations/shape-engrave-handler.js
 * @description Engrave operation handler for EasyShape5000.
 *              Extends BaseOperationHandler to perform direct zero-offset
 *              (on-path / centerline) engraving across both open and closed paths.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapeEngraveHandler extends BaseOperationHandler {

        /**
         * Orchestrates engrave geometry generation and preview integration.
         * Bypasses offset pipeline validation and Clipper calls.
         */
        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);
            const opParams = core.compileOperationParams(operation, params);

            await this.generateGeometry(operation, {
                ...params,
                ...opParams
            });

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation cancelled', status: 'warning' };
            }

            const total = operation.offsets?.[0]?.primitives?.length || 0;

            if (total === 0) {
                return {
                    success: false,
                    message: 'No engrave paths found or generated',
                    status: 'warning'
                };
            }

            this.stampExportMetadata(operation, 'engrave');

            return {
                success: true,
                message: `Engrave path generated (${total} path${total > 1 ? 's' : ''})`,
                status: 'success'
            };
        }

        /**
         * Generates direct zero-offset (centerline / on-path) geometry.
         * primitiveToCenterlinePath keeps arcs analytic and open paths open;
         * primitiveToPath is the wrong converter here - it returns the stroke
         * OUTLINE for stroked sources and fabricates closed: true.
         */
        async generateGeometry(operation, settings) {
            const primitives = operation.primitives || [];

            if (primitives.length === 0) {
                operation.offsets = [];
                return [];
            }

            const engravePaths = [];

            for (const prim of primitives) {
                let processedPrim = GeometryUtils.primitiveToCenterlinePath(prim);
                if (!processedPrim) continue;

                // Clone when the converter passed the source through:
                // operation.primitives is scene-synced source geometry, and a
                // shape in two buckets would otherwise carry the last
                // operation's tags. Spread-then-setPrototypeOf keeps the V8
                // hidden class, matching preparePrimitivesForOffset.
                if (processedPrim === prim) {
                    const clone = { ...prim };
                    Object.setPrototypeOf(clone, Object.getPrototypeOf(prim));
                    processedPrim = clone;
                }

                const hasArcs = !!processedPrim.contours?.some(c => c.arcSegments?.length > 0);

                // Spread the CONVERTER's properties, not the source's - the
                // converter resolved `closed`, and the source's value describes
                // the analytic shape it replaced.
                processedPrim.properties = {
                    ...(processedPrim.properties || {}),
                    operationType: 'engrave',
                    operationId: operation.id,
                    isOffset: false,
                    offsetDistance: 0,
                    offsetType: 'on_line',
                    hasAnalyticArcs: hasArcs,
                    preserveDirection: true
                };

                engravePaths.push(processedPrim);
            }

            operation.offsets = [
                {
                    id: this.offsetRecordId(operation.id, 0),
                    distance: 0,
                    pass: 1,
                    type: 'engrave',
                    primitives: engravePaths,
                    metadata: {
                        strategy: 'engrave',
                        finalCount: engravePaths.length,
                        generatedAt: Date.now(),
                        toolDiameter: settings.toolDiameter
                    },
                    settings: { ...settings }
                }
            ];

            return operation.offsets;
        }
    }

    window.ShapeEngraveHandler = ShapeEngraveHandler;
})();