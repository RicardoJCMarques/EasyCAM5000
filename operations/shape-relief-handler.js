/*!
 * @file        operations/shape-relief-handler.js
 * @description Relief / 2.5D-mold operation handler - heightmap-driven
 *              3D surfacing (roughing + finishing rasters).
 *
 *              Orchestration, worker dispatch, field caching and pass
 *              grouping are inherited from FieldOperationHandler; this
 *              file owns only relief specifics - the slice frame, the
 *              generator option mapping, and the published metadata.
 *
 *              All parameters flow from profile-shape.json via the
 *              parameter manager → compileOperationParams → settings.
 *              Inline fallbacks mirror the JSON defaults and only fire
 *              if a parameter is ever removed from the profile.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapeReliefHandler extends FieldOperationHandler {

        passTypePrefix() { return 'relief'; }
        pipelineLabel() { return 'RELIEF'; }
        emptyMessage() {
            return 'No relief paths generated - model may be flat or below resolution';
        }

        validateSource(operation) {
            if (!this.getMeshSource(operation)) {
                return {
                    success: false,
                    message: 'No relief source - import an STL model for this operation',
                    status: 'warning'
                };
            }
            return null;
        }

        buildJobs(operation, p, warnings) {
            const mesh = this.getMeshSource(operation);
            if (!mesh) return [];
            return [{
                kind: 'relief',
                mesh,
                sliceOptions: this.buildSliceOptions(p),
                genOptions: this.buildGeneratorOptions(p)
            }];
        }

        /**
         * Slice frame. Padding reserves grid for the boundary band so the
         * band cannot clamp at the grid edge; a 'stop' boundary needs none.
         * The cell size derives from the model extent, not the padded one.
         */
        buildSliceOptions(p) {
            const boundaryMode = p.reliefBoundaryMode || 'stop';
            return {
                cellSize: p.reliefCellSize > 0 ? p.reliefCellSize : null,
                gridMaxDim: p.reliefGridMaxDim,
                padding: boundaryMode === 'stop' ? 0
                    : (p.toolDiameter || 3) / 2 + Math.max(0, p.reliefBoundaryMm || 0)
            };
        }

        buildGeneratorOptions(p) {
            const toolDiameter = p.toolDiameter;
            const mode = p.reliefMode;

            return {
                toolDiameter,
                toolShape: p.reliefToolShape,
                cornerRadius: p.reliefCornerRadius,
                totalDepth: p.reliefDepth > 0 ? p.reliefDepth : 0, // 0 = auto (generator)
                startDepth: p.reliefStartDepth,
                invert: p.reliefInvert === true,
                depthMapping: p.reliefDepthMapping,
                roughing: mode !== 'finishing',
                finishing: mode !== 'roughing',
                roughStepdown: p.reliefRoughStepdown ?? 1.5,
                roughStepover: toolDiameter * ((p.reliefRoughStepoverPct ?? 45) / 100),
                roughStock: p.reliefRoughStock ?? 0.3,
                finishStepover: toolDiameter * ((p.reliefFinishStepoverPct ?? 10) / 100),
                crossFinish: p.reliefCrossFinish === true,
                rasterAxis: p.reliefRasterAxis,
                simplifyTolerance: p.reliefSimplifyTolerance ?? 0.01,
                minSegmentLength: p.reliefMinSegmentLength ?? 0.2,
                skipFloor: p.reliefSkipFloor === true,
                maskUncovered: p.reliefMaskUncovered === true,
                boundary: { mode: p.reliefBoundaryMode || 'stop', mm: p.reliefBoundaryMm || 0 }
            };
        }

        buildSharedMetadata(ctx) {
            const hm = ctx.containers[0];
            const o = ctx.jobs[0].genOptions;
            return {
                generatedAt: Date.now(),
                toolDiameter: o.toolDiameter,
                toolShape: o.toolShape,
                reliefDepth: o.totalDepth > 0 ? o.totalDepth : hm.maxH,
                startDepth: o.startDepth,
                gridCols: hm.cols,
                gridRows: hm.rows,
                cellSize: hm.cellSize,
                is3DToolpath: true
            };
        }
    }

    window.ShapeReliefHandler = ShapeReliefHandler;
})();
