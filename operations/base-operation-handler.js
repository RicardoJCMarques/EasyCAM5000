/*!
 * @file        operations/base-operation-handler.js
 * @description Base operation handler interface - contract for all operation types
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const D = window.CAMConfig.defaults;
    const debugState = D.debug;

    class BaseOperationHandler {
        constructor(core) {
            this.core = core;
        }

        /**
         * Standard operation generation entry point called by BaseOperationPanel.
         * Default implementation binds progress tracking, tracks stale generation tokens,
         * and delegates to generateGeometry(). Subclasses can override for custom pipelines.
         *
         * @param {Object} operation - The operation object
         * @param {Object} params - Merged parameters from ParameterManager
         * @param {Object} core - App core reference
         * @param {Object} [options={}] - Pipeline options ({ onProgress })
         * @returns {Promise<{success: boolean, message: string, status: string}>}
         */
        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);
            const onProgress = operation._onProgress;

            onProgress?.({ frac: 0.1, label: `Generating ${operation.type}...` });

            // Delegate to existing generateGeometry logic
            if (typeof this.generateGeometry === 'function') {
                await this.generateGeometry(operation, params);

                if (this.isStale(operation, token)) {
                    return { success: false, message: 'Generation cancelled', status: 'warning' };
                }

                onProgress?.({ frac: 1.0, label: 'Complete' });
                return {
                    success: true,
                    message: `${operation.type.toUpperCase()} geometry generated`,
                    status: 'success'
                };
            }

            throw new Error(`[${this.constructor.name}] orchestrateGeneration() or generateGeometry() must be implemented.`);
        }

        /**
         * Pre-validation classification of raw plotter output.
         * Override to filter/transform primitives before validation and compositing.
         * Called after ParserPlotter, before analyzeGeometricContext.
         * @param {Object} operation - The operation object (may set flags like needsClosurePrompt)
         * @param {Array} rawPrimitives - Raw plotter output
         * @returns {{ primitives: Array, warnings: Array }}
         */
        classifyPrimitives(operation, rawPrimitives) {
            return { primitives: rawPrimitives, warnings: [] };
        }

        /**
         * Post-parse hook called after operation.primitives and bounds are set.
         * Override for classification that needs the final validated primitive set.
         * @param {Object} operation - The operation with .primitives populated
         */
        postParsePrimitives(operation) {
            // No-op by default
        }

        /**
         * Resolves contour topology before the offset pipeline.
         *
         * Tier 1 (always): Re-derives hole assignment within each compound
         *   primitive by geometric containment. Fixes the winding-sign
         *   fragility in plotRegion for even-parity transforms.
         *
         * Tier 2 (opt-in via mergeNesting:true): Detects containment among
         *   separate primitives and merges outers with their holes into
         *   compound PathPrimitives.
         *
         * @param {Array} primitives
         * @param {Object} [options]
         * @param {boolean} [options.mergeNesting=false] - Run inter-primitive merge
         * @returns {Array} Primitives with corrected topology
         */
        resolveContourTopology(primitives, { mergeNesting = false } = {}) {
            if (!primitives || primitives.length === 0) return primitives;

            // Tier 1: intra-primitive compound resolution
            let resolved = [];
            let compoundsFixed = 0;

            for (const prim of primitives) {
                const result = GeometryUtils.resolveCompoundContours(prim);
                if (result.length !== 1 || result[0] !== prim) compoundsFixed++;
                resolved.push(...result);
            }

            if (compoundsFixed > 0) {
                this.debug(`Tier 1: resolved ${compoundsFixed} compound primitive(s) by containment`);
            }

            // Tier 2: inter-primitive nesting merge
            if (!mergeNesting || resolved.length < 2) return resolved;

            // Build the loop set for topology analysis. Closed analytic
            // shapes (circle/rectangle/obround) are converted to paths HERE
            // so they participate in nesting detection - an SVG circle
            // dropped inside a rectangle is the common EasyShape case.
            // Anything without a usable closed contour (open strokes, drill
            // points) is set aside and re-appended untouched.
            const loops    = [];
            const passthru = [];
            const sourceOf = new Map(); // converted loop -> original primitive

            for (const prim of resolved) {
                let loop = prim;
                if (prim.type !== 'path') {
                    const path = GeometryUtils.primitiveToPath(prim);
                    if (path) {
                        path.properties = { ...prim.properties, ...path.properties };
                        loop = path;
                    }
                }

                if (loop && loop.type === 'path' && loop.contours?.length > 0) {
                    // Explode every contour into its own single-contour loop.
                    // classifyCutoutTopology only inspects contours[0], so a
                    // compound path (outer + holes - re-fed from a previous
                    // generation, or a native SVG compound path) would otherwise
                    // hide its holes from the classifier and the merge would drop
                    // them. Mirrors GeometryUtils.resolveCompoundContours.
                    for (const contour of loop.contours) {
                        const singleLoop = new PathPrimitive([contour], { ...loop.properties });
                        loops.push(singleLoop);
                        // Only genuinely single-contour inputs revert to their
                        // original primitive (preserves analytic arcs). Exploded
                        // compound pieces get NO sourceOf entry, so the merge's
                        // `|| outer.loop` fallback keeps the exploded contour
                        // instead of dragging the whole compound (hole included)
                        // back in.
                        if (loop.contours.length === 1) sourceOf.set(singleLoop, prim);
                    }
                } else {
                    passthru.push(prim);
                }
            }

            if (loops.length < 2) return resolved;

            const topology = GeometryUtils.classifyCutoutTopology(loops);
            if (!topology.some(t => t.isHole)) return resolved;

            // Group holes under their parent outers. Standalone outers (no holes)
            // are emitted as their ORIGINAL primitive so analytic arcs survive;
            // only true compounds (outer + hole contours) must be polygonized
            // into a PathPrimitive.
            const outers = topology.filter(t => !t.isHole);
            const holes  = topology.filter(t => t.isHole);
            const merged = [];

            for (const outer of outers) {
                const children = holes.filter(h => h.parentIdx === outer.originalIdx);
                if (children.length === 0) {
                    merged.push(sourceOf.get(outer.loop) || outer.loop);
                } else {
                    const newContours = [outer.loop.contours[0]];
                    for (const child of children) {
                        newContours.push(child.loop.contours[0]);
                    }
                    merged.push(new PathPrimitive(newContours, {
                        ...outer.loop.properties
                    }));
                }
            }

            // Orphan holes (no parent) - keep as their original primitive
            for (const hole of holes) {
                if (hole.parentIdx === null) merged.push(sourceOf.get(hole.loop) || hole.loop);
            }

            this.debug(`Tier 2: merged ${loops.length} loop(s) → ${merged.length} primitive(s)`);
            return [...merged, ...passthru];
        }

        /**
         * Topology resolution that must run on the SOURCE primitives before
         * the offset pipeline. Called by OffsetOperationHandler after the
         * stale token is stamped, so a superseded run cannot rewrite
         * operation.primitives out from under a newer one.
         * @returns {Array|null} replacement primitives, or null to leave as-is
         */
        resolveSourceTopology(operation, params) {
            return null;
        }

        /**
         * Default preparation for offset pipeline: strips SVG visual
         * properties and forces machining-intent flags. Primitives that
         * already have fill:true + no stroke pass through unchanged.
         * Subclasses override only when they need different behavior
         * (e.g. copper handlers that preserve stroke for expandStroke).
         */
        preparePrimitivesForOffset(primitives) {
            return primitives.map(prim => {
                const props = prim.properties || {};
                if (props.fill && !props.stroke && !props.isTrace) return prim;

                // Shallow spread first (keeps a V8 hidden class - fast property
                // access downstream in the offset loop and Clipper marshalling),
                // then re-attach the prototype for class methods (getBounds etc).
                // Object.create + Object.assign built the object incrementally
                // on a bare prototype, forcing dictionary-mode lookups.
                const clone = {
                    ...prim,
                    properties: {
                        ...props,
                        fill: true,
                        stroke: false,
                        strokeWidth: 0,
                        isTrace: false
                    }
                };
                Object.setPrototypeOf(clone, Object.getPrototypeOf(prim));
                return clone;
            });
        }

        /**
         * Routes a single primitive to the appropriate geometry operation
         * during the per-pass offset loop.
         *
         * Default: calls offsetBoundary (treat everything as a filled boundary).
         * EasyTrace5000 copper handlers override to detect strokes, nesting and
         * call expandStroke with combined width instead.
         *
         * @param {Object} primitive - A single primitive to offset
         * @param {number} distance - Signed offset distance
         * @returns {Object|Array|null} Offset result(s)
         */
        async offsetSinglePrimitive(primitive, distance) {
            return this.core.geometryOffsetter.offsetBoundary(primitive, distance);
        }

        /**
         * Offset-record id. Pass records are keyed the same way across every
         * handler so downstream lookups don't need per-handler knowledge.
         * @param {string} operationId
         * @param {number|string} pass  pass index, or a label like 'combined'
         */
        offsetRecordId(operationId, pass = 0) {
            return `offset_${operationId}_${pass}`;
        }

        /** Standard post-generation stamp. */
        stampExportMetadata(operation, strategy) {
            operation.exportMetadata = {
                generatedAt: Date.now(),
                sourceOffsets: operation.offsets?.length || 0,
                strategy
            };
        }

        /**
         * CNC variant: Generate operation-specific geometry (offsets, drill
         * strategy, stencil apertures). Writes to operation.offsets[].
         */
        async generateGeometry(operation, settings) {}

        /**
         * Laser variant: Generate laser-specific geometry.
         * Default delegates to generateGeometry (offset strategy).
         */
        async generateLaserFills(operation, settings) {
            return this.generateGeometry(operation, settings);
        }

        /** Closed-region gate shared by V-Carve and the offset handlers. */
        countOpenPaths(operation) {
            const precision = window.CAMConfig.constants.precision.coordinate;
            return (operation.primitives || []).filter(p => {
                if (p.type === 'circle' || p.type === 'rectangle' || p.type === 'obround') return false;
                return !GeometryUtils.isPrimitiveClosed(p, precision);
            }).length;
        }

        /**
         * Binds the panel's progress callback onto the operation. Progress is
         * STRUCTURED ({frac, label}) end to end - never format here, the state
         * manager owns the one formatter.
         */
        resolveProgress(operation, options) {
            operation._onProgress = options?.onProgress || null;
            return operation._onProgress;
        }

        /**
         * Canonical opening of a generation run: bind progress, stamp the
         * stale token, wipe previous state. The ordering matters (token BEFORE
         * reset, progress before anything that can tick), and it had already
         * drifted into three different sequences across the handler families -
         * so it lives in exactly one place now.
         *
         * @param {Object} operation
         * @param {Object|Function} options - the orchestrateGeneration slot
         * @param {Object} [core] - omit to skip the state reset
         * @returns {number} the stale-run token
         */
        beginRun(operation, options, core) {
            this.resolveProgress(operation, options);
            const token = this.beginGeneration(operation);
            if (core) core.resetOperationState(operation.id);
            return token;
        }

        /**
         * Stale-run token, shared by every handler family. Stamp BEFORE
         * resetOperationState; compare after any await that a newer run
         * could span. Replaces FieldOperationHandler's inline _genToken
         * bump and ShapeVCarveHandler's parallel _vcarveToken.
         */
        beginGeneration(operation) {
            return (operation._genToken = (operation._genToken || 0) + 1);
        }

        isStale(operation, token) {
            return operation._genToken !== token;
        }

        /**
         * Toolpath optimization policy - controls how the optimizer
         * orders and clusters this operation's plans.
         *
         * staydownPartition:
         *   'shape'     - hard wall per shapeKey; staydown never crosses shapes (profile, pocket, cutout)
         *   'proximity' - proximity clusters are the staydown unit; ignores shapeKey (isolation, clearing)
         *
         * Override in subclasses. Base default suits single-pass and
         * multi-depth profile/cutout operations.
         */
        getToolpathPolicy() {
            return { staydownPartition: 'shape' };
        }

        debug(message, data = null) {
            if (debugState.enabled) {
                const tag = `[${this.constructor.name}]`;
                if (data) console.log(`${tag} ${message}`, data);
                else console.log(`${tag} ${message}`);
            }
        }
    }

    window.BaseOperationHandler = BaseOperationHandler;
})();