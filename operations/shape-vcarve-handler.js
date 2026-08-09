/*!
 * @file        operations/shape-vcarve-handler.js
 * @description V-Carve operation handler - straight-skeleton 3D centerline paths.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const C = window.CAMConfig.constants;
    const PRECISION = C.precision.coordinate;

    class ShapeVCarveHandler extends BaseOperationHandler {

        // NOTE: descriptive-only for 3D chains. ToolpathOptimizer routes
        // is3DContour groups via its ordered3D/unordered3D fast paths and
        // `continue`s BEFORE the toolpathPolicy read - staydownPartition is
        // never consulted for these plans. Kept for the day the optimizer
        // branches on policy instead of flags.
        getToolpathPolicy() {
            return {
                staydownPartition: 'proximity',
                depthOrder: 'featureMajor'
            };
        }

        // ════════════════════════════════════════════════════════════
        // Validation helpers
        // ════════════════════════════════════════════════════════════

        /**
         * Floor perimeter at the bottom-out clearance: inset the region by
         * tClamp via the Clipper offsetter.
         * Returns arrays of {x,y} loops, or null on failure (generator
         * then clamps depth without perimeter stitching - safe fallback).
         */
        async buildFloorLoops(prim, tClamp) {
            try {
                // The offsetter's boolean path (offsetPathViaBoolean) normalizes
                // every mask contour to CCW + isHole:false, and the wrapper
                // differences with NonZero fill - so nested holes read as FILLED
                // and a compound inset leaves solid islands inside each hole
                // (loops in the void). Offset within its contract instead: each
                // hole as its OWN single-contour primitive (external +tClamp →
                // grows the void), shells internally (-tClamp), then subtract.
                // Single-contour calls are handled correctly, so this is right
                // by construction; the void guard below is now just insurance.
                const shells = [];
                const holes = [];
                if (prim.contours && prim.contours.length > 0) {
                    for (const c of prim.contours) {
                        const sp = new PathPrimitive([c], { ...prim.properties });
                        (c.isHole ? holes : shells).push(sp);
                    }
                } else {
                    shells.push(prim);
                }
                if (shells.length === 0) return null;

                const flat = (arr) => arr.flat().filter(Boolean);
                const insetShells = flat(await Promise.all(
                    shells.map(s => this.core.geometryOffsetter.offsetBoundary(s, -tClamp))));
                if (insetShells.length === 0) return null;

                const grownHoles = holes.length
                    ? flat(await Promise.all(
                        holes.map(h => this.core.geometryOffsetter.offsetBoundary(h, tClamp))))
                    : [];

                const shellUnion = await this.core.geometryProcessor.unionGeometry(insetShells);
                let floorPolys = shellUnion;
                if (grownHoles.length > 0) {
                    const holeUnion = await this.core.geometryProcessor.unionGeometry(grownHoles);
                    floorPolys = await this.core.geometryProcessor.difference(shellUnion, holeUnion);
                }
                if (!floorPolys || floorPolys.length === 0) return null;

                // Insurance only (redundant with the in-contract offset above):
                // reject any loop whose VERTICES land in a hole void. Never test
                // the centroid - the legitimate grown-hole boundary encircles the
                // void yet its vertices sit tClamp into the material.
                // REVIEW - After testing this should be deprecated?
                const rings = (prim.contours || [])
                    .map(c => c.points).filter(pts => pts && pts.length >= 3);
                const inMaterial = (x, y) => {
                    let inside = false;
                    for (const pts of rings) {
                        const m = pts.length;
                        for (let i = 0, j = m - 1; i < m; j = i++) {
                            const yi = pts[i].y, yj = pts[j].y;
                            if ((yi > y) !== (yj > y)) {
                                const xInt = pts[i].x + (y - yi) / (yj - yi) * (pts[j].x - pts[i].x);
                                if (x < xInt) inside = !inside;
                            }
                        }
                    }
                    return inside;
                };
                const loopOnMaterial = (pts) => {
                    if (rings.length === 0) return true;
                    const step = Math.max(1, (pts.length / 16) | 0);
                    let tested = 0, onMat = 0;
                    for (let i = 0; i < pts.length; i += step) {
                        tested++;
                        if (inMaterial(pts[i].x, pts[i].y)) onMat++;
                    }
                    return tested > 0 && onMat * 2 >= tested;
                };

                // Loops now carry isHole. A hole ring of an inset polygon
                // encircles a VOID: it must be cut as a plain perimeter, but
                // it must never claim a medial spine (nothing on the medial
                // axis lives inside it). The generator used to see a flat
                // array of point-arrays and let hole rings compete for spines.
                const loops = [];
                let dropped = 0;
                for (const p of floorPolys) {
                    for (const c of (p.contours || [])) {
                        const dense = (c.arcSegments?.length
                                    && typeof GeometryUtils !== 'undefined'
                                    && GeometryUtils.contourArcsToPath)
                            ? GeometryUtils.contourArcsToPath(c) : c;
                        const pts = dense.points;
                        if (!pts || pts.length < 3) continue;
                        if (!loopOnMaterial(pts)) { dropped++; continue; }
                        loops.push({
                            points: pts.map(q => ({ x: q.x, y: q.y })),
                            isHole: c.isHole === true
                        });
                    }
                }
                if (dropped > 0) this.debug(`buildFloorLoops: dropped ${dropped} void loop(s) (guard)`);
                return loops.length > 0 ? loops : null;
            } catch (err) {
                this.debug(`Floor inset failed (${err.message}) - clamp-only floors`);
                return null;
            }
        }

        // Orchestration

        /**
         * Worker-safe loop extraction. The worker has no GeometryUtils, so
         * analytic shapes are polygonized and arcSegments densified HERE -
         * the worker's prepareContours then sees plain closed point loops,
         * which is its native input.
         */
        denseLoops(prim) {
            let source = prim;
            if (prim.type !== 'path' && GeometryUtils.primitiveToPath) {
                const p = GeometryUtils.primitiveToPath(prim);
                if (p?.contours?.length) source = p;
            }
            return (source.contours || []).map(c => {
                const dense = (c.arcSegments?.length && GeometryUtils.contourArcsToPath)
                    ? GeometryUtils.contourArcsToPath(c) : c;
                return { pts: dense.points || [], isHole: c.isHole === true };
            });
        }

        /**
         * [{pts:[{x,y}], isHole}] → transferable { counts, flags, xy }.
         *
         * Float64, NOT Float32: these contours drive Delaunator, and
         * quantizing them would make worker output diverge subtly from the
         * sync path that has to reproduce it on failure. Transfer cost is
         * size-independent, so the extra bytes are free. (Output positions
         * stay Float32 - those are toolpath samples, already at that
         * precision everywhere downstream.)
         */
        static packLoops(loops) {
            let n = 0;
            for (const l of loops) n += l.pts.length;
            const counts = new Int32Array(loops.length);
            const flags  = new Uint8Array(loops.length);
            const xy     = new Float64Array(n * 2);
            let w = 0;
            for (let i = 0; i < loops.length; i++) {
                const pts = loops[i].pts;
                counts[i] = pts.length;
                flags[i]  = loops[i].isHole ? 1 : 0;
                for (let j = 0; j < pts.length; j++) {
                    xy[w++] = pts[j].x;
                    xy[w++] = pts[j].y;
                }
            }
            return { counts, flags, xy };
        }

        /**
         * Assembles one worker job, fully packed.
         *
         * Everything crossing the wire is a transferable typed array because
         * postMessage's structured clone is SYNCHRONOUS on the sender: cloning
         * ~2k {x,y} objects per glyph across hundreds of glyphs bills the main
         * thread twice over - once for the clone, and again as dispatch latency
         * that leaves pool workers idle. The worker unpacks into the {x,y}
         * shape prepareContours already expects, off this thread, so
         * VCarveGenerator's input contract is untouched.
         *
         * The worker rebuilds the primitive as { type:'path', contours,
         * properties:{} } - properties are DELIBERATELY empty. VCarveGenerator
         * never reads primitive.properties; every emitted property is built
         * fresh (floor-perimeter and chain blocks). Do not "fix" this by
         * shipping the source properties: they would then differ between the
         * worker path and the sync retry, which must reproduce it exactly.
         */
        buildVCarveJob(prim, floorLoops, generatorOptions) {
            const packedPrim = ShapeVCarveHandler.packLoops(this.denseLoops(prim));
            const packedFloor = (floorLoops && floorLoops.length)
                ? ShapeVCarveHandler.packLoops(
                    floorLoops.map(l => ({ pts: l.points, isHole: l.isHole })))
                : null;

            const transfer = [packedPrim.counts.buffer, packedPrim.flags.buffer,
                              packedPrim.xy.buffer];
            if (packedFloor) {
                transfer.push(packedFloor.counts.buffer, packedFloor.flags.buffer,
                              packedFloor.xy.buffer);
            }
            return {
                kind: 'vcarve',
                prim: packedPrim,
                // Floor loops ride packed inside genOptions; the worker
                // rehydrates them into genOptions.floorLoops before calling
                // the generator.
                genOptions: { ...generatorOptions, packedFloorLoops: packedFloor },
                transfer
            };
        }

        async orchestrateGeneration(operation, params, core, options = {}) {
            // Monotonic per-operation token, stamped BEFORE any state reset:
            // a second Generate while this one is fanned out across the pool
            // must supersede it. Progress binds first so anything ticking
            // during param compilation is not dropped.
            const token = this.beginRun(operation, options, core);

            const opParams = core.compileOperationParams(operation, params);

            // V-Carve is strictly closed-region work
            const openCount = this.countOpenPaths(operation);
            if (openCount > 0) {
                return {
                    success: false,
                    message: `V-Carve requires closed paths - ${openCount} open path(s) in selection`,
                    status: 'warning'
                };
            }

            // Pass the run's OWN token. generateGeometry used to re-read
            // operation._genToken, which is the LIVE one - a newer run
            // starting mid-flight made the inner stale gate compare the new
            // token against itself and pay for a sync retry it then threw away.
            await this.generateGeometry(operation, { ...params, ...opParams }, token);

            // A newer run finished (or is running) - this run's offsets were
            // discarded inside generateGeometry. Without this gate the OLDER
            // run reports the NEWER run's counts as its own, or emits a false
            // "degenerate shapes" warning.
            if (this.isStale(operation, token)) {
                return {
                    success: false,
                    message: 'Generation superseded by a newer request',
                    status: 'warning'
                };
            }

            const total = operation.offsets?.reduce(
                (s, o) => s + (o.primitives?.length || 0), 0) || 0;

            if (total === 0) {
                return {
                    success: false,
                    message: 'No V-Carve paths generated - shapes may be degenerate or too small',
                    status: 'warning'
                };
            }

            // Bottomed-out reporting: floor perimeter loops mean maxDepth
            // clamped; ridgeRisk means flats wider than the bit can cover
            // with perimeter + spine.
            let floorCount = 0, ridgeRisk = false;
            for (const o of operation.offsets || []) {
                for (const pr of o.primitives || []) {
                    if (pr.properties?.vcarvePass === 'floor-perimeter') {
                        floorCount++;
                        if (pr.properties.ridgeRisk) ridgeRisk = true;
                    }
                }
            }
            let message = `Generated ${total} V-Carve path(s)`;
            let status = 'success';
            if (floorCount > 0) {
                message += ` - ${floorCount} flat region outline(s) bottomed out at max depth`;
                if (ridgeRisk) {
                    message += ' (wider than bit coverage: central ridges will remain until flat clearing is implemented)';
                    status = 'warning';
                }
            }
            return { success: true, message, status };
        }

        // Geometry generation

        async generateGeometry(operation, settings, runToken = null) {
            this.debug('=== V-CARVE PIPELINE START ===');
            this.debug(`Operation: ${operation.id} (${operation.type})`);

            if (!operation.primitives || operation.primitives.length === 0) {
                operation.offsets = [];
                return [];
            }

            // All V-Carve parameters flow from profile-shape.json via the
            // parameter manager -> compileOperationParams -> settings.
            // Inline fallbacks mirror the JSON defaults and only fire if a
            // parameter is ever removed from the profile.
            const vbitAngle = settings.vbitAngle || 90;
            const startDepth = Math.max(0, settings.vcarveStartDepth || 0);
            // SAFETY clamp only - flat-floor CLEARING (vcarveFlatDepth /
            // vcarveClearingTool) is still deferred.
            const maxDepth = Math.abs(settings.vcarveMaxDepth || 3);
            // V-bit TIP radius. Shifts the whole depth map: the bit cuts
            // width tipDiameter at the surface, and bottoms out at clearance
            // (maxDepth - startDepth)·tan(A/2) + tipRadius.
            const tipRadius = Math.max(0, (settings.vbitTipDiameter || 0) / 2);

            // Merge separate-but-nested primitives into compounds with
            // proper hole flags. The generator requires one connected
            // region (outer + its holes) per call.
            const tTopo = performance.now();
            const merged = this.resolveContourTopology(operation.primitives, { mergeNesting: true });
            this.debug(`Topology: ${operation.primitives.length} prim(s) → ` +
                `${merged.length} compound(s) in ${(performance.now() - tTopo).toFixed(0)}ms`);

            const generatorOptions = {
                vbitAngle,
                startDepth,
                maxDepth,
                tipRadius,
                simplifyTolerance: settings.vcarveSimplifyTolerance ?? 0,
                minChainLength: settings.vcarveMinChainLength ?? 0,
                cornerAngle: settings.vcarveCornerAngle ?? 30,
                // Internal-only for now (not in profile-shape.json): extra
                // dimensional erosion gate in mm, 0 = off. Expose as a UI
                // parameter later if angle-based pruning ever needs help.
                noiseThreshold: settings.vcarveNoiseThreshold ?? 0,
                // Boundary sampling step for the Voronoi medial engine.
                // Must be smaller than the thinnest stroke width; the
                // generator warns (unrecovered walls) when it is not.
                sampleSpacing: settings.vcarveSampleSpacing ?? 0.15
            };
            this.debug('Generator options:', generatorOptions);

            // Floor clamp time (same formula the generator uses). Computed
            // here so the floor perimeter can be produced by the Clipper
            // offsetter (async) before the sync generator runs.
            const tClamp = VCarveGenerator.computeFloorClamp({
                vbitAngle, startDepth, maxDepth, tipRadius
            });

            // ── Dispatch: one worker job per primitive ──────────────────
            // floorLoops need main-thread Clipper (WASM), so they are computed
            // here; each resolved primitive is dispatched to the pool
            // IMMEDIATELY, so worker Delaunay math overlaps the NEXT
            // primitive's Clipper inset. The pool is N workers on least-busy
            // dispatch, so hundreds of shapes fan out across cores. Clipper is
            // serial by construction (main-thread WASM), so this
            // producer/consumer shape is the ceiling - which is exactly why
            // dispatch itself must be cheap (see buildVCarveJob).
            const WC = window.FieldWorkerClient;
            const token = runToken ?? operation._genToken;
            const onProgress = operation._onProgress || null;

            // Blended progress: done jobs count 1, in-flight jobs contribute
            // their worker-reported fraction. One number, monotone-ish, that
            // keeps moving even when a single dense glyph dominates the run.
            const partials = new Float64Array(merged.length);
            let done = 0;
            const report = (labelOverride) => {
                if (!onProgress) return;
                let sum = done;
                for (let k = 0; k < partials.length; k++) sum += partials[k];
                onProgress({ frac: Math.min(sum / merged.length, 1),
                             label: labelOverride ||
                                    `V-Carve ${done}/${merged.length} shapes` });
            };

            // PROFILING (temporary): dispatch-loop cost split. clipperMs is
            // serial main-thread Clipper (buildFloorLoops); packMs is
            // polygonize+pack+postMessage. If clipperMs dominates wall time,
            // Clipper is the fan-out ceiling the dispatch comment assumes
            // away - candidates then: cache floor loops per primitive, or
            // load Clipper WASM in the workers.
            const prof = { clipperMs: 0, packMs: 0, t0: performance.now(), dispatchMs: 0 };

            // Dispatch is split in TWO PHASES because buildFloorLoops is
            // main-thread Clipper WASM and every `await` on it used to sit
            // BETWEEN two dispatches - job k+1 was only posted after glyph
            // k's inset finished, so the pool ran one job deep no matter how
            // many workers it had. The bbox triage below is the same inradius
            // bound as before (a region whose bbox min-dimension is under
            // 2·tClamp cannot contain a disc of radius tClamp, so its inset
            // is provably empty); on text that is the large majority of
            // glyphs, and they now fan out on the first tick instead of
            // queueing behind Clipper work they never needed.
            const jobs = new Array(merged.length);
            const wantsFloor = new Uint8Array(merged.length);
            const canFloor = tClamp !== null && !!this.core.geometryOffsetter;

            if (canFloor) {
                for (let i = 0; i < merged.length; i++) {
                    const pb = merged[i].getBounds ? merged[i].getBounds() : merged[i].bounds;
                    const minDim = pb
                        ? Math.min(pb.maxX - pb.minX, pb.maxY - pb.minY) : Infinity;
                    if (minDim >= 2 * tClamp) wantsFloor[i] = 1;
                    else prof.skippedFloor = (prof.skippedFloor || 0) + 1;
                }
            }

            const dispatch = (i, floorLoops) => {
                const prim = merged[i];
                // opts keep the UNPACKED loops: buildVCarveJob transfers (and
                // therefore detaches) its own copies, but the sync retry below
                // needs these intact.
                const opts = { ...generatorOptions, floorLoops };
                let promise = null;
                if (WC) {
                    const p0 = performance.now();
                    promise = WC.run(
                        this.buildVCarveJob(prim, floorLoops, generatorOptions),
                        (p) => { // worker heartbeat - live mid-glyph feedback
                            if (p.frac != null) partials[i] = Math.min(p.frac, 0.999);
                            report();
                        });
                    prof.packMs += performance.now() - p0;
                    // Count ONLY worker successes live; rejected jobs are
                    // counted after their sync retry completes below, and the
                    // no-pool path (null promise) is counted after its sync
                    // run - progress can no longer hit 100% before the work.
                    if (promise) promise.then(
                        () => { partials[i] = 0; done++; report(); },
                        () => { partials[i] = 0; });
                }
                jobs[i] = { prim, opts, promise };
            };

            // Phase 1 - everything that needs no Clipper, posted immediately.
            for (let i = 0; i < merged.length; i++) {
                if (!wantsFloor[i]) dispatch(i, null);
            }

            // Phase 2 - serial Clipper, dispatching each result as it lands so
            // the inset for glyph k+1 overlaps worker time for glyph k.
            let floorDone = 0, floorTotal = 0;
            for (let i = 0; i < merged.length; i++) if (wantsFloor[i]) floorTotal++;
            for (let i = 0; i < merged.length; i++) {
                if (!wantsFloor[i]) continue;
                const c0 = performance.now();
                const floorLoops = await this.buildFloorLoops(merged[i], tClamp);
                prof.clipperMs += performance.now() - c0;
                dispatch(i, floorLoops);
                if (((++floorDone) & 15) === 0) {
                    report(`Preparing floors ${floorDone}/${floorTotal}`);
                }
            }
            prof.dispatchMs = performance.now() - prof.t0;

            // allSettled, not all: one degenerate glyph must not force a
            // synchronous re-run of every OTHER glyph and every Clipper inset
            // already paid for. A null promise (pool unavailable) settles as
            // fulfilled/undefined and falls through the same branch, so the
            // no-worker path needs no separate loop. Order is preserved either
            // way - the optimizer depends on deterministic output.
            const settled = await Promise.allSettled(jobs.map(j => j.promise));

            // Stale-run gate FIRST: a superseded run must not pay the
            // main-thread sync retry for results it is about to discard.
            if (this.isStale(operation, token)) {
                this.debug('Superseded by a newer generation - result discarded');
                return operation.offsets || [];
            }

            const vcarvePrimitives = [];
            for (let i = 0; i < jobs.length; i++) {
                const s = settled[i];
                if (s.status === 'fulfilled' && s.value) {
                    vcarvePrimitives.push(...s.value.primitives.map(p =>
                        new Polyline3DPrimitive(p.positions, p.properties)));
                    continue; // counted live at promise resolution
                }
                if (s.status === 'rejected') {
                    this.debug(`vcarve job ${i} failed (${s.reason?.message}) - sync retry`);
                }
                vcarvePrimitives.push(...VCarveGenerator.generateVCarvePaths(
                    jobs[i].prim, jobs[i].opts));
                done++; report(); // sync-run completion is the real progress
            }

            const wallMs = performance.now() - prof.t0;
            this.debug(`Dispatch profile: wall=${wallMs.toFixed(0)}ms, ` +
                `dispatchLoop=${prof.dispatchMs.toFixed(0)}ms ` +
                `(clipper=${prof.clipperMs.toFixed(0)}ms, ` +
                `pack+post=${prof.packMs.toFixed(0)}ms), ` +
                `workerOverlap=${(wallMs - prof.dispatchMs).toFixed(0)}ms`);

            // Standard offsets container so renderer / preview / export
            // flow untouched. metadata.is3DToolpath flags the group;
            // each primitive also carries properties.is3DContour for the
            // per-primitive dispatch in GeometryTranslator.
            operation.offsets = [{
                id: `vcarve_${operation.id}`,
                distance: 0,
                pass: 1,
                type: 'vcarve',
                primitives: vcarvePrimitives,
                metadata: {
                    generatedAt: Date.now(),
                    sourceCount: merged.length,
                    finalCount: vcarvePrimitives.length,
                    toolDiameter: settings.toolDiameter,   // V-bit TIP diameter (preview + tool selection)
                    tipRadius,
                    vbitAngle,
                    startDepth,
                    maxDepth,
                    is3DToolpath: true
                },
                settings: { ...settings }
            }];

            this.debug(`Generated ${vcarvePrimitives.length} 3D path primitive(s)`);
            this.debug('=== V-CARVE PIPELINE COMPLETE ===');
            return operation.offsets;
        }
    }

    window.ShapeVCarveHandler = ShapeVCarveHandler;
})();