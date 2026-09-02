/*!
 * @file        operations/trace-cutout-handler.js
 * @description Board cutout - offset with cutSide control, closure detection, and tab orchestration
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class TraceCutoutHandler extends OffsetOperationHandler {
        // Base OffsetOperationHandler hooks already handle cutSide-driven offset direction.
        // No hook overrides needed - cutout is the base case.

        /**
         * Classifies raw plotter primitives for cutout operations.
         * Extracts closed loops from multi-segment geometry, detects topology (board outlines vs internal holes), and flags orphan segments for the closure prompt.
         */
        classifyPrimitives(operation, rawPrimitives) {
            const warnings = [];
            let primitives = rawPrimitives;

            if (primitives.length > 1) {
                const { loops, orphans, orphanGaps } = GeometryTopology.extractClosedLoops(primitives);

                if (loops.length > 0) {
                    const topology = GeometryTopology.classifyCutoutTopology(loops);
                    const compounds = GeometryTopology.assembleCutoutCompounds(topology);

                    if (compounds.length > 0) {
                        primitives = compounds;
                        const holeCount = topology.filter(t => t.isHole).length;
                        this.debug(`Cutout: ${compounds.length} board(s), ${holeCount} hole(s) from ${loops.length} loop(s)`);
                    } else {
                        primitives = loops;
                    }

                    // Preserve loops for re-classification if orphans get resolved later
                    if (orphans.length > 0) {
                        operation.extractedLoops = loops;
                    }
                }

                if (orphans.length > 0) {
                    operation.needsClosurePrompt = true;
                    operation.closureInfo = {
                        rawPrimitives: orphans,
                        gaps: orphanGaps || []
                    };

                    const gapText = orphanGaps && orphanGaps.length > 0
                        ? orphanGaps.map(g => g.toFixed(4) + 'mm').join(', ')
                        : 'unknown';
                    warnings.push({
                        message: `${orphans.length} segment(s) do not form closed loops. Gaps: ${gapText}`,
                        severity: 'warning'
                    });
                    this.debug(`${orphans.length} orphan segment(s) flagged for closure prompt`);
                }

            } else if (primitives.length === 1) {
                const pts = primitives[0].contours?.[0]?.points;
                if (pts && pts.length >= 3 && GeometryUtils.isClockwise(pts)) {
                    GeometryTopology.reverseContourWinding(primitives[0].contours[0]);
                    this.debug('Single cutout primitive reversed to CCW');
                }
            }

            return { primitives, warnings };
        }

        /**
         * Tier 1 & 2 - newly closed orphans from the closure prompt must be
         * topologically merged so they classify as internal holes rather than
         * independent board outlines.
         */
        resolveSourceTopology(operation) {
            return this.resolveContourTopology(operation.primitives, { mergeNesting: true });
        }

        async orchestrateGeneration(operation, params, core, options = {}) {
            const result = await super.orchestrateGeneration(operation, params, core, options);
            // Override CNC message for cutout
            if (result.success && !options.isLaser) {
                result.message = 'Cutout path generated';
            }
            return result;
        }
    }

    window.TraceCutoutHandler = TraceCutoutHandler;
})();