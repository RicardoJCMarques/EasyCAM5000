/*!
 * @file        geometry/geometry-utils-rotary.js
 * @description Rotary (4th-axis) toolpath generator - the CYLINDRICAL
 *              adapter over FieldPipeline. CylMap R(x,θ) → 3D path
 *              primitives in DEVELOPED coordinates: x = axial mm,
 *              y = unwound arc length at refRadius (mm, monotone, never
 *              wrapped - θ→A happens later at the machine boundary),
 *              z = R - refRadius (≤ 0).
 *
 *              This file owns only what is cylindrical-specific: depth
 *              window and drive-stub resolution, square-stock roughing
 *              start, the finishing pattern set, and the emitted
 *              primitive properties. Window, end zones, target
 *              composition, compensation and rastering live in
 *              geometry-utils-fieldpipeline.js and are shared with the
 *              relief generator.
 *
 *              Depends on: geometry-utils-{fieldpipeline,field,fieldpaths,
 *              cylmap,toolprofile}.js.
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

    const RotaryGenerator = {

        /**
         * @param {CylMapPrimitive|CylMap} source
         * @param {Object} o - options
         * @param {number}  o.toolDiameter               - mm
         * @param {string} [o.toolShape='ball']          - 'ball' | 'flat' | 'bull'
         * @param {number} [o.cornerRadius=0]            - mm (bull only)
         * @param {Object} [o.holder]                    - plain-data holder envelope
         * @param {number} [o.totalDepth=0]              - carve depth below the
         *        blank surface (mm). 0 = auto: down to the model's minimum
         *        covered radius.
         * @param {number} [o.coreRadius]                - DRIVE STUB radius.
         *        Radial removal cannot reach the axis, so a cylinder of at
         *        least this radius survives the whole machined length by
         *        construction - it is what the chuck drives and what a
         *        tailstock centre bears on. Present in every workholding
         *        mode; set it small for a cantilevered job and the free end
         *        finishes as a sandable nib.
         * @param {string} [o.stockShape]                - 'square' → roughing
         *        starts at the corner radius refR·√2 and turns the stock round.
         * @param {Object}  o.tuning                     - REQUIRED
         *        Unused since the worker gained CAMConfig - the generator
         *        reads constants.rotary directly. Kept for direct API
         *        callers that want to override edgeRunCells / minRadiusClip
         *        / stubDefaultMm.
         * @param {Object}  o.ends                       - REQUIRED, per-end
         *        policy from resolveWorkholding:
         *        { chuck: { mode, mm, material, reach }, tail: {...} }.
         *        material 'stub' | 'lip' | 'free'; reach is the mm the tool
         *        CENTRE may pass the model edge and is RESOLVER-OWNED -
         *        never re-floored here.
         * @param {boolean}[o.roughing=true], [o.finishing=true]
         * @param {number} [o.roughStepdown=1.5]         - mm of RADIUS per layer
         * @param {number} [o.roughStepover], [o.roughStock=0.3]
         * @param {string} [o.roughAxis='x']             - 'x' (along) | 'y' (around)
         * @param {number} [o.finishStepover]
         * @param {string} [o.finishPattern='spiral']    - 'spiral' | 'along' | 'around'
         * @param {number} [o.simplifyTolerance=0.01], [o.minSegmentLength=0.2]
         * @param {number} [o.compLattice=0]             - 0 = auto
         * @returns {Array} 3D path primitives (is3DContour)
         */
        generateRotaryPaths(source, o) {
            const cm = source.cylmap || source;
            const t0 = performance.now();

            const FP = ROOT.FieldPaths;
            const FPL = ROOT.FieldPipeline;
            const warn = (msg) => {
                (cm.meta.warnings || (cm.meta.warnings = [])).push(msg);
            };

            // REVIEW - all of these checks to CAMConfig should just be setup before the classes.
            const T = ROOT.CAMConfig.constants.rotary;
            const ends = o.ends;
            if (!ends?.chuck || !ends?.tail) {
                throw new Error('RotaryGenerator: o.ends must carry both chuck ' +
                    'and tail (resolveWorkholding output)');
            }

            const toolDiameter = o.toolDiameter || 3;
            const { profile, cutR } = FPL.makeProfile({
                toolShape: o.toolShape || 'ball',
                toolDiameter,
                cornerRadius: o.cornerRadius || 0,
                holder: o.holder
            });

            const refR = cm.refRadius;
            const stubR = Math.max(o.coreRadius ?? T.stubDefaultMm, T.minRadiusClip);

            const stockStartRadius = (o.stockShape === 'square') ? refR * Math.SQRT2 : 0;
            cm.meta.appliedStockStartRadius = stockStartRadius;

            // Depth window ≠ stub. Two different limits:
            //   depthFloorR - how deep the MODEL may be cut
            //   stubR       - hard floor everywhere, and the radius the end
            //                 zones cone down to
            // Collapsing them makes auto depth resolve to the model's own
            // thinnest radius, so any model with a waist wider than its
            // minimum gets no stub at all.
            cm.refreshStats();
            const autoDepth = Math.max(0, refR - Math.max(cm.minR, stubR));
            let totalDepth = (o.totalDepth > 0) ? o.totalDepth : autoDepth;
            let depthFloorR = refR - totalDepth;
            if (depthFloorR < stubR) {
                depthFloorR = stubR;
                totalDepth = refR - depthFloorR;
                this.debug(`totalDepth clamped by the drive stub → ${totalDepth.toFixed(3)}mm`);
            }

            // An explicit depth deeper than the model needs truncates
            // everything below it to a constant-radius rod. Auto depth cannot
            // do this - it stops at the model's minimum.
            if (o.totalDepth > 0 && depthFloorR < cm.minR - 1e-9) {
                warn(`Carve depth ${totalDepth.toFixed(2)}mm passes the model's own ` +
                    `minimum radius (${cm.minR.toFixed(2)}mm): everything below ` +
                    `${depthFloorR.toFixed(2)}mm becomes a constant-radius rod. Set ` +
                    `depth to 0 (auto) to follow the model instead.`);
            }

            // Cells the slicer never hit (radiality gate, open sections,
            // occlusion) are held to the nearest covered radius by the gap
            // fill, so a high count silently changes the surface. The gate
            // itself is config tuning - this is the only way the user sees it.
            const uncoveredPct = 100 * cm.meta.uncovered / (cm.cols * cm.rows);
            if (uncoveredPct > 25) {
                warn(`${uncoveredPct.toFixed(0)}% of the cylindrical grid is ` +
                    `uncovered - those regions hold the surrounding radius rather ` +
                    `than the model. Check the rotation axis, model orientation, ` +
                    `and that the mesh is closed.`);
            }

            cm.meta.appliedDepth = totalDepth;
            if (!(totalDepth > FP.VALUE_EPS) && !(stockStartRadius > refR)) {
                this.debug('Nothing to carve (totalDepth ≈ 0)');
                return [];
            }

            // Every non-lip end lands ON the stub: stop's window ends
            // against it, free falls to it (waste fill = stubR).
            const formsStub = (e) => e.material !== 'lip';
            if ((formsStub(ends.chuck) || formsStub(ends.tail)) && stubR < cutR - 1e-9) {
                warn(`Drive stub radius ${stubR.toFixed(2)}mm is below the tool's ` +
                    `reach ${cutR.toFixed(2)}mm - the stub is formed as the tool's ` +
                    `offset of the core cylinder (safe, but wider than set).`);
            }

            // An auto depth that reaches near the centerline blows the
            // compensation θ-window up toward a quarter turn. The fix is an
            // explicit depth (or a mesh that is actually round about the
            // axis), not compute.
            if (!(o.totalDepth > 0) && depthFloorR <= Math.max(stubR * 2, refR * 0.05)) {
                const msg = `Auto carve depth reaches near the centerline ` +
                    `(floor R=${depthFloorR.toFixed(2)}mm of blank R=${refR.toFixed(2)}mm) - ` +
                    `set an explicit rotary depth; generation slows sharply near the ` +
                    `axis and the mesh may not be round about it.`;
                console.warn(`[RotaryGenerator] ${msg}`);
                warn(msg);
            }

            const space = ROOT.FieldSpace.cylindrical(cm, { minValue: T.minRadiusClip });

            const policy = {
                kind: 'axial',
                ends,
                edgeRun: T.edgeRunCells,
                // The stub is what the end tapers cone down to; the depth
                // window is a separate, shallower floor.
                coreRadius: stubR,
                // The drive stub is a PHYSICAL floor for every cell, not
                // just for waste. Step 2's lip zones are exempt from the
                // depth-window floor by design (a lip is a cut past the
                // edge) and clamp only at tuning.minRadiusClip, so a
                // rollover end deeper than (edgeR - stubR) writes a target
                // below the core and the tool drives into the part the
                // chuck is gripping. It also drags deepestFrom:'target'
                // down to 0.01mm, which opens the compensator's angular
                // window to a quarter turn.
                // No-op for 'stop' and 'free' ends - their waste is
                // already exactly the stub radius.
                coreFloor: true,
                windowFloor: depthFloorR,
                severanceFloor: null,
                fillGaps: true,
                wasteValue: stubR,
                maskMode: 'window',
                deepestFrom: 'target',
                // Every column carries a meaningful target after the fill and
                // the zones, so no cell means "nothing here" and an unmasked
                // compensation is correct by construction.
                compensateMasked: false,
                forceExactLattice: false
            };

            const simplifyTol = o.simplifyTolerance ?? 0.01;
            const finishStepover = o.finishStepover || toolDiameter * 0.1;
            const pattern = o.finishPattern || 'spiral';
            // Round stock starts at the blank surface; square stock starts
            // above it and turns round on the way down. Layers above refR cut
            // full rings - air on the flats, ≤ one stepdown at the corners.
            const startR = (stockStartRadius > refR) ? stockStartRadius : refR;

            const res = FPL.generate({
                space, profile, cutR, policy,
                lattice: o.compLattice | 0,
                simplifyTolerance: simplifyTol,
                minSegmentLength: o.minSegmentLength ?? 0.2,

                rough: {
                    enabled: o.roughing !== false,
                    startVal: startR,
                    stepdown: o.roughStepdown || 1.5,
                    stepover: o.roughStepover || toolDiameter / 2,
                    stock: o.roughStock ?? 0.3,
                    axis: o.roughAxis === 'y' ? 'y' : 'x',
                    // Lines run along the axis under 'y', so they must be
                    // clamped to the machinable window; under 'x' the lines
                    // are θ rings and the coverage mask already does it.
                    lineWindow: true,
                    layersEndFallback: stubR
                },

                finish: {
                    enabled: o.finishing !== false,
                    strategies: [this.finishStrategy(pattern, finishStepover, simplifyTol)]
                },

                emitProps: (phase, layerIndex) => ({
                    isRotary: true,
                    developed: true,                 // y = unwound arc at refRadius
                    // Square-stock roughing runs ABOVE the blank surface; the
                    // machine pass needs this to raise retracts clear of the
                    // corner, since travelZ is measured from the blank surface.
                    stockStartRadius: cm.meta.appliedStockStartRadius || 0,
                    refRadius: cm.refRadius,
                    axisKind: cm.axis,               // 'x' | 'y'
                    // SLICED cross-u, not world. ShapeRotaryHandler's
                    // onJobPrimitives applies axisBSign after the job returns;
                    // the generator cannot know the sign because internalOrient
                    // is a slicer detail.
                    axisB: cm.axisB,
                    axisC: cm.axisC,                 // cross-v is +worldZ, no sign
                    role: 'rotary_path',
                    machiningPhase: phase,           // 'roughing' | 'finishing'
                    preserveOrder: true,
                    ...(layerIndex != null ? { roughLayerIndex: layerIndex } : {})
                }),

                onProgress: o.onProgress || null,
                debug: debugState.enabled ? (m) => this.debug(m) : null
            });

            for (const w of res.warnings) warn(w);

            this.debug(`Rotary generation complete: ${res.primitives.length} ` +
                `primitive(s) in ${(performance.now() - t0).toFixed(0)}ms`);
            return res.primitives;
        },

        /**
         * Finishing pattern → pipeline strategy.
         *
         * 'spiral' - one continuous helix: single entry, no stepover witness
         *   lines, A-axis continuity by construction. Closing revolutions go
         *   at the MODEL EDGE as well as the window edge: with a 'lip' end
         *   the window runs a full tool diameter past the part, so a ring out
         *   there rides the lip flat while the model's own base edge - the
         *   line the job is parted on - keeps the helix crossing it at the
         *   spiral angle.
         * 'along'  - lines are θ positions, samples sweep the axis. An
         *   in-surface connector here would be a full-depth sweep around the
         *   part, so splitLines is mandatory; the 3D macro hop-links.
         * 'around' - lines are axial positions, samples wrap into closed
         *   rings; the continuous connector walks the surface at θ = 0.
         */
        finishStrategy(pattern, stepover, simplifyTolerance) {
            const FP = ROOT.FieldPaths;

            if (pattern === 'along') {
                return {
                    label: 'along',
                    run: (view, ctx) => FP.rasterFinish(view, {
                        axis: 'x', stepover, simplifyTolerance, splitLines: true,
                        onProgress: ctx.onProgress
                    })
                };
            }
            if (pattern === 'around') {
                return {
                    label: 'around',
                    run: (view, ctx) => FP.rasterFinish(view, {
                        axis: 'y', stepover, simplifyTolerance,
                        lineStart: ctx.c0, lineEnd: ctx.c1,
                        onProgress: ctx.onProgress
                    })
                };
            }
            return {
                label: 'spiral',
                run: (view, ctx) => FP.spiralFinish(view, {
                    stepover, simplifyTolerance,
                    capRings: true,
                    colStart: ctx.c0, colEnd: ctx.c1,
                    capColStart: ctx.m0, capColEnd: ctx.m1,
                    onProgress: ctx.onProgress
                })
            };
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[RotaryGenerator] ${message}`, data)
                 : console.log(`[RotaryGenerator] ${message}`);
        }
    };

    ROOT.RotaryGenerator = RotaryGenerator;
})();
