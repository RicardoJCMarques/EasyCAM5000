/*!
 * @file        geometry/geometry-utils-relief.js
 * @description Relief / 2.5D-mold toolpath generator - the PLANAR
 *              adapter over FieldPipeline. Converts a Heightmap into 3D
 *              path primitives (per-point Z) with
 *              properties.is3DContour = true.
 *
 *              This file owns only what is planar-specific: depth
 *              resolution, which boundary policy applies, the finishing
 *              strategy set, and the emitted primitive properties.
 *              Window, end zones, target composition, compensation and
 *              rastering live in geometry-utils-fieldpipeline.js and are
 *              shared with the rotary generator.
 *
 *              Two configurations:
 *                plain relief  - isotropic silhouette boundary
 *                indexed 3+1   - o.axial present: axial workholding
 *                                boundary, per-face, sharing one Z datum
 *                                (o.surfaceRefZ = blank face plane)
 *
 *              Depends on: geometry-utils-{fieldpipeline,field,fieldpaths,
 *              heightmap,toolprofile}.js.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const ROOT = (typeof self !== 'undefined') ? self : window;
    const debugState = ROOT.CAMConfig?.defaults?.debug || { enabled: false };

    const ReliefGenerator = {

        /**
         * @param {HeightmapPrimitive|Heightmap} source
         * @param {Object} o - options
         * @param {number}  o.toolDiameter               - mm
         * @param {string} [o.toolShape='ball']          - 'ball' | 'flat' | 'bull'
         * @param {number} [o.cornerRadius=0]            - mm (bull only)
         * @param {Object} [o.holder]                    - plain-data holder
         *        envelope; wrapped into the profile here so worker and
         *        sync-fallback paths behave identically.
         * @param {number} [o.totalDepth]                - carve depth (mm,
         *        positive). 0/absent = auto: the full model height.
         * @param {number} [o.startDepth=0]              - surface offset (mm)
         * @param {boolean}[o.invert=false]              - mold mode
         * @param {string} [o.depthMapping='scaled']     - 'scaled' | 'literal'
         * // REVIEW - Why have a depthMapping parameter? It seems like everything is literal anyway?
         *             And it should be literal? Only gray-scale could use this somehow but it's not implemented yet?
         * @param {number} [o.surfaceRefZ]               - [INDEXED] shared Z
         *        datum: depth 0 is the blank FACE PLANE, not this view's
         *        model top. Required whenever o.axial is set.
         * @param {Object} [o.boundary]                  - { mode, mm }:
         *        'stop' (default) | 'rollover' | 'extend'. Superseded by
         *        o.axial.
         * @param {boolean}[o.maskUncovered=false]       - honor the coverage
         *        mask under boundary mode 'stop'.
         * @param {Object} [o.axial]                     - [INDEXED] axial
         *        limits: { axis:'x'|'y', ends:{chuck,tail} }, each end being
         *        resolveWorkholding's { mode, mm, material, reach }.
         *        chuck = LOW index, tail = HIGH.
         * @param {number} [o.coreRadius=0]              - [INDEXED] drive-core
         *        cylinder radius about the rotation axis.
         * @param {number} [o.axialOvercut=0]            - [INDEXED] mm the tip
         *        may pass the rotation axis. RESOLVER-OWNED; consumed verbatim.
         * @param {number} [o.axialFacetHalfWidth=0]     - [INDEXED] half-width
         *        of the facet this setup clears. 0 = silhouette only.
         * @param {Object} [o.tuning]                    - required with o.axial
         * @param {boolean}[o.roughing=true], [o.finishing=true]
         * @param {number} [o.roughStepdown=1.5], [o.roughStepover], [o.roughStock=0.3]
         * @param {number} [o.finishStepover]
         * @param {boolean}[o.crossFinish=false]         - 90° second finish pass
         * @param {string} [o.rasterAxis='x']            - 'x' (rows) | 'y' (columns)
         * @param {number} [o.simplifyTolerance=0.01], [o.minSegmentLength=0.2]
         * @param {boolean}[o.skipFloor=false]           - floor-flat handoff
         * @param {number} [o.compLattice=0]             - 0 = auto
         * @returns {Array} 3D path primitives (is3DContour)
         */
        generateReliefPaths(source, o) {
            const hm = source.heightmap || source;
            const t0 = performance.now();

            const FP = ROOT.FieldPaths;
            const FPL = ROOT.FieldPipeline;

            const toolDiameter = o.toolDiameter || 3;
            // 0/absent = auto: carve the full model height. Resolved here,
            // not in the handler, because it depends on the sliced field.
            const reliefDepth = (o.totalDepth > 0) ? Math.abs(o.totalDepth) : hm.maxH;
            const startDepth = Math.max(0, o.startDepth || 0);
            // Deepest legal tip Z anywhere in this operation.
            const floorZ = -(startDepth + reliefDepth);

            const axis = o.rasterAxis === 'y' ? 'y' : 'x';
            const simplifyTol = o.simplifyTolerance ?? 0.01;
            const skipFloor = o.skipFloor === true;
            const ax = o.axial || null;

            const { profile, cutR } = FPL.makeProfile({
                toolShape: o.toolShape || 'ball',
                toolDiameter,
                cornerRadius: o.cornerRadius || 0,
                holder: o.holder
            });

            const space = ROOT.FieldSpace.planar(hm, {
                axialAxis: ax ? ax.axis : 'x',
                surfaceRefZ: o.surfaceRefZ,
                reliefDepth, startDepth,
                invert: !!o.invert,
                depthMapping: o.depthMapping || 'scaled'
            });

            const policy = ax
                ? this.buildAxialPolicy(o, hm, cutR)
                : this.buildIsotropicPolicy(o);

            // A rollover lip is allowed to land slightly below the relief
            // floor - that separation groove is the point of the mode.
            const boundaryLip = (!ax && hm.mask && policy.mode === 'rollover')
                ? Math.max(0, o.boundary?.mm || 0) : 0;

            const finishStepover = o.finishStepover || toolDiameter * 0.1;
            const passes = [axis];
            if (o.crossFinish) passes.push(axis === 'x' ? 'y' : 'x');

            const res = FPL.generate({
                space, profile, cutR, policy,
                lattice: o.compLattice | 0,
                simplifyTolerance: simplifyTol,
                minSegmentLength: o.minSegmentLength ?? 0.2,

                rough: {
                    enabled: o.roughing !== false && reliefDepth > FP.VALUE_EPS,
                    startVal: -startDepth,
                    stepdown: o.roughStepdown || 1.5,
                    stepover: o.roughStepover || toolDiameter / 2,
                    stock: o.roughStock ?? 0.3,
                    axis,
                    skipFloor,
                    floorVal: floorZ,
                    layersEndFallback: floorZ - boundaryLip
                },

                finish: {
                    enabled: o.finishing !== false,
                    strategies: passes.map(fax => ({
                        label: `raster ${fax}`,
                        run: (view, ctx) => FP.rasterFinish(view, {
                            axis: fax,
                            stepover: finishStepover,
                            simplifyTolerance: simplifyTol,
                            skipFloor,
                            floorVal: floorZ,
                            onProgress: ctx.onProgress,
                            // Partial coverage breaks the continuous
                            // single-chain assumption - fall back to
                            // per-line chains, which the 3D macro hop-links.
                            splitLines: !!(ctx.finishMask || ctx.roughMask) && !skipFloor
                        })
                    }))
                },

                emitProps: (phase, layerIndex) => ({
                    isRelief: true,
                    role: 'relief_path',
                    machiningPhase: phase,          // 'roughing' | 'finishing'
                    // Raster emission is serpentine: the emission sequence
                    // IS the near-optimal route.
                    preserveOrder: true,
                    // Roughing layers must keep top-to-bottom order through
                    // the optimizer; a per-layer group key does that.
                    // Finishing gets no index, so its raster stays one group.
                    ...(layerIndex != null ? { roughLayerIndex: layerIndex } : {})
                }),

                onProgress: o.onProgress || null,
                // null when off: the pipeline gates its minima scans on
                // o.debug, so disabled runs skip them entirely.
                debug: debugState.enabled ? (m) => this.debug(m) : null
            });

            for (const w of res.warnings) {
                (hm.meta.warnings || (hm.meta.warnings = [])).push(w);
            }

            if (debugState.enabled) {
                let zMin = Infinity, zMax = -Infinity;
                for (const p of res.primitives) {
                    if (p.positions) {
                        const a = p.positions;
                        for (let i = 2; i < a.length; i += 3) {
                            if (a[i] < zMin) zMin = a[i];
                            if (a[i] > zMax) zMax = a[i];
                        }
                    } else for (const c of (p.contours || [])) {
                        for (const pt of (c.points || [])) {
                            const z = pt.z ?? 0;
                            if (z < zMin) zMin = z;
                            if (z > zMax) zMax = z;
                        }
                    }
                }
                const refZ = o.surfaceRefZ || 0;
                this.debug(`Emitted Z [machineZ]: ` +
                    `${Number.isFinite(zMin) ? (zMin + refZ).toFixed(3) : 'n/a'}` +
                    ` .. ${Number.isFinite(zMax) ? (zMax + refZ).toFixed(3) : 'n/a'}`);
            }
            return res.primitives;
        },

        /**
         * [INDEXED] Axial workholding policy for one face.
         *
         * The face plane sits at z = +apothem and the rotation axis at
         * z = -apothem in this face's sliced frame, so every value below
         * is measured from the face plane and converts to a radius through
         * the space's toRadius/fromRadius pair.
         */
        buildAxialPolicy(o, hm, cutR) {
            const T = ROOT.CAMConfig.constants.rotary; // Field-worker installs self.CAMConfig before importScripts, so this resolves on both threads.
            const ends = o.axial.ends;

            const apo = o.surfaceRefZ;
            const core = Number.isFinite(o.coreRadius) ? Math.max(0, o.coreRadius) : 0;
            // RESOLVER-OWNED. Whether a face may pass the rotation axis, and
            // by how much, is decided once in the handler; re-deriving it
            // here is how a job asking for both a drive stub and an over-cut
            // silently got zero.
            const overcut = Math.max(0, o.axialOvercut || 0);
            // The axis plane plus any over-cut: the SHALLOWEST the waste
            // floor may sit. The pipeline deepens it per station wherever a
            // covered cell within one cutting radius needs it, so a face
            // whose visible surface runs past the axis is not shouldered
            // back up to this plane by its own waste.
            const axisFloor = -(apo + overcut);

            return {
                kind: 'axial',
                ends,
                edgeRun: T.edgeRunCells,
                coreRadius: core,
                coreFloor: true,
                severanceFloor: axisFloor,
                windowFloor: null,      // mapDepths already clamped the window
                fillGaps: true,
                wasteValue: axisFloor,
                maskMode: 'collar',
                // May not exceed the compensation kernel: a cell with no
                // covered cell in reach keeps its raw target, and dilateMask
                // is L1 (>= Euclidean).
                collarCells: Math.max(1, Math.floor(cutR / hm.cellSize)),
                // Hull cells further than one cutting radius from formable
                // material are severance waste, not leave-stock. Unbounded,
                // the vertical-wall hull stamps shield the whole band where
                // opposing faces must overlap, and the two faces meet tangent
                // at the axis instead of separating.
                fillReachCells: Math.max(1, Math.ceil(cutR / hm.cellSize)),
                // Always finite (IndexedBlank.resolve). 0 = silhouette only.
                facetHalfWidth: Math.max(0, o.axialFacetHalfWidth || 0),
                // The target holds a depth-window BOUND over uncovered cells,
                // so its minimum is not a reachable surface.
                deepestFrom: 'compensated',
                // Every cell carries a real target after composition, so
                // "no material here" no longer exists.
                compensateMasked: false,
                forceExactLattice: true
            };
        },

        /** Plain relief: an isotropic band around the model silhouette. */
        buildIsotropicPolicy(o) {
            return {
                kind: 'isotropic',
                mode: o.boundary?.mode || 'stop',
                mm: o.boundary?.mm || 0,
                maskUncovered: o.maskUncovered === true,
                compensateMasked: true,
                forceExactLattice: false
            };
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[ReliefGenerator] ${message}`, data)
                 : console.log(`[ReliefGenerator] ${message}`);
        }
    };

    ROOT.ReliefGenerator = ReliefGenerator;
})();
