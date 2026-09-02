/*!
 * @file        operations/shape-vcarve-handler.js
 * @description V-Carve operation handler - medial-axis 3D centerline paths.
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

        // ════════════════════════════════════════════════════════════
        // Validation helpers
        // ════════════════════════════════════════════════════════════

        /**
         * The bit's widest usable cutting radius: the smaller of its diameter
         * and what the flute length carries at its angle. toolDiameter IS the
         * V-bit's diameter here - the field means the same thing on this form as
         * on every other one - so it is read directly and the library only answers
         * for an operation saved before the tool was resolved.
         */
        resolveMaxCutRadius(settings) {
            const g = settings.tool ? this.core.toolLibrary?.getTool(settings.tool)?.geometry : null;
            const toolOD = Number(settings.toolDiameter) > 0
                ? Number(settings.toolDiameter)
                : (g?.maxDiameter ?? g?.diameter ?? null);
            if (!toolOD && !g) return null;
            const tipRadius = Math.max(0, Number(settings.vbitTipRadius ?? 0));
            const vbitAngle = settings.vbitAngle ?? g?.angle ?? 90;
            const tanHalf = Math.tan(Number(vbitAngle) * Math.PI / 180 / 2);
            const byOD = toolOD > 0 ? toolOD / 2 : Infinity;
            const byFlute = g?.cuttingLength > 0 && tanHalf > 1e-12 ? tipRadius + g.cuttingLength * tanHalf : Infinity;
            const r = Math.min(byOD, byFlute);
            if (Number.isFinite(r) && r > tipRadius) return r;
            return Number.isFinite(byOD) && byOD > tipRadius ? byOD : null;
        }

        resolveDepthLimit(opts) {
            return VCarveGenerator.resolveDepthLimit(opts);
        }

        /**
         * Floor perimeter at the bottom-out clearance: inset the region by
         * tClamp via the Clipper offsetter.
         * Returns arrays of {x,y} loops, or null on failure (generator
         * then clamps depth without perimeter stitching - safe fallback).
         */
        async buildFloorLoops(prim, tClamp) {
            try {
                // ONE native offset over the whole nested set. A negative delta
                // shrinks positive-area outers and grows negative-area holes in
                // the same pass, so winding carries the sign and no shell/hole
                // split, union or difference is needed. The input is rebuilt from
                // the densified loops with the orientation isHole implies: a
                // mis-wound contour would otherwise offset the wrong way with no
                // error anywhere.
                const contours = this.denseLoops(prim)
                    .filter(l => l.pts && l.pts.length >= 3)
                    .map(l => {
                        const cw = GeometryUtils.isClockwise(l.pts);
                        return {
                            points: (l.isHole === cw) ? l.pts : [...l.pts].reverse(),
                            isHole: l.isHole
                        };
                    });
                if (contours.length === 0) return null;

                const floorPolys = await this.core.geometryProcessor
                    .offsetGeometry([{ type: 'path', contours }], -tClamp, { joinType: 'round' });
                if (!floorPolys || floorPolys.length === 0) {
                    // Legitimate outcome: inradius < tClamp, nothing bottoms out.
                    this.debug(`[ShapeVCarveHandler] Floor inset at -${tClamp.toFixed(3)}mm is empty`);
                    return null;
                }

                // Densified, orientation-normalized loops - the same input the
                // offset above consumed. Reading prim.contours raw gives a
                // chord-encoded arc contour only its arc endpoints, so a circle
                // arrives as 2 points, fails the >= 3 filter, and silently
                // disables the guard; a partly tessellated contour keeps it
                // enabled on the wrong polygon. Parity is winding-independent,
                // so the reversal contours carries is irrelevant here.
                const rings = contours.map(c => c.points);
                // Even-odd across the ring set: the parity of the total crossing
                // count is the XOR of the per-ring parities, so holes fall out
                // without an orientation test.
                const inMaterial = (x, y) => {
                    const pt = { x, y };
                    let inside = false;
                    for (const pts of rings) {
                        if (GeometryUtils.pointInPolygon(pt, pts)) inside = !inside;
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
                    for (const c of p.contours || []) {
                    const dense = c.arcSegments?.length ? GeometryTessellation.contourArcsToPath(c) : c;
                    const pts = dense.points;
                    if (!pts || pts.length < 3) continue;
                    if (loopOnMaterial(pts)) {
                        loops.push({ points: pts.map((q) => ({ x: q.x, y: q.y })), isHole: c.isHole === true });
                    } else {
                        dropped++;
                    }
                    }
                }
                if (dropped > 0) this.debug(`[ShapeVCarveHandler] buildFloorLoops: dropped ${dropped} void loop(s) (guard)`);
                return loops.length > 0 ? loops : null;
            } catch (err) {
                this.debug(`[ShapeVCarveHandler] Floor inset failed (${err.message}) - clamp-only floors`);
                return null;
            }
        }

        // Orchestration

        /**
         * Counts genuinely overlapping region pairs in a merged set.
         *
         * bbox first, then vertex-in-region both ways. The bbox alone means
         * nothing here - glyph boxes overlap constantly through kerning,
         * italics and descenders - so it is a prefilter, not the test. Loops
         * are densified lazily so a set with no bbox collisions pays nothing.
         */
        countOverlappingRegions(prims) {
            if (!prims || prims.length < 2) return 0;

            const bounds = prims.map(p => (p.getBounds ? p.getBounds() : p.bounds) || null);
            const cache = new Map();
            const ringsOf = (i) => {
                let r = cache.get(i);
                if (!r) {
                    r = this.denseLoops(prims[i])
                        .map(l => l.pts).filter(pts => pts && pts.length >= 3);
                    cache.set(i, r);
                }
                return r;
            };
            // Even-odd parity across the ring set
            const inRegion = (pt, rings) => {
                let v = false;
                for (const pts of rings) {
                    if (GeometryUtils.pointInPolygon(pt, pts)) v = !v;
                }
                return v;
            };
            const anyVertexInside = (rings, other) => {
                for (const pts of rings) {
                    const step = Math.max(1, (pts.length / 8) | 0);
                    for (let i = 0; i < pts.length; i += step) {
                        if (inRegion(pts[i], other)) return true;
                    }
                }
                return false;
            };

            let pairs = 0;
            for (let i = 0; i < prims.length; i++) {
                const a = bounds[i];
                if (!a) continue;
                for (let j = i + 1; j < prims.length; j++) {
                    const b = bounds[j];
                    if (!b) continue;
                    if (a.minX >= b.maxX - PRECISION || b.minX >= a.maxX - PRECISION ||
                        a.minY >= b.maxY - PRECISION || b.minY >= a.maxY - PRECISION) continue;
                    const ra = ringsOf(i), rb = ringsOf(j);
                    if (!ra.length || !rb.length) continue;
                    if (anyVertexInside(ra, rb) || anyVertexInside(rb, ra)) pairs++;
                }
            }
            return pairs;
        }

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
                const dense = (c.arcSegments?.length && GeometryTessellation.contourArcsToPath)
                    ? GeometryTessellation.contourArcsToPath(c) : c;
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
                    if ("floor-perimeter" === pr.properties?.vcarvePass) {
                        floorCount++;
                        pr.properties.ridgeRisk && (ridgeRisk = true);
                    }
                }
            }
            let message = `Generated ${total} V-Carve path(s)`;
            let status = "success";
            if (floorCount > 0) {
                const limit = (params.vcarveMaxDepth > 0) ? "the depth limit" : "the bit's reach";
                message += ` - ${floorCount} flat region outline(s) bottomed out at ${limit}`;
                if (ridgeRisk) {
                    message += " (wider than bit coverage: central ridges will remain until flat clearing is implemented)";
                    status = "warning";
                }
            }
            return { success: true, message: message, status: status };
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
            const vbitAngle = Number(settings.vbitAngle);
            const startDepth = Math.max(0, Number(settings.vcarveStartDepth));
            // 0 = unconstrained natural V-carve depth (no flat floor clamping)
            const maxDepth = (settings.vcarveMaxDepth !== undefined && settings.vcarveMaxDepth !== null && Number(settings.vcarveMaxDepth) > 0)
                ? Math.abs(Number(settings.vcarveMaxDepth)) : null;

            // V-bit TIP radius (0 = sharp point)
            const tipRadius = Math.max(0, Number(settings.vbitTipRadius ?? 0));

            // Merge separate-but-nested primitives into compounds with
            // proper hole flags. The generator requires one connected
            // region (outer + its holes) per call.
            const tTopo = performance.now();
            const merged = this.resolveContourTopology(operation.primitives, { mergeNesting: true });
            this.debug(`Topology: ${operation.primitives.length} prim(s) → ` +
                `${merged.length} compound(s) in ${(performance.now() - tTopo).toFixed(0)}ms`);

            
            // One job = one connected region. resolveContourTopology merges by
            // CONTAINMENT only, so two OVERLAPPING outers arrive as two jobs and
            // each computes a medial axis over material the other also covers:
            // the lap is carved twice, at a depth neither region agrees on, and
            // nothing downstream can detect it.
            const overlapPairs = this.countOverlappingRegions(merged);
            if (overlapPairs > 0) {
                console.warn(`[ShapeVCarveHandler] ${overlapPairs} overlapping region pair(s) ` +
                    `in this operation. Shared material will be carved more than once, ` +
                    `each pass unaware of the other's depth. Union the shapes before ` +
                    `assigning them to a V-Carve bucket.`);
            }

            const maxCutRadius = this.resolveMaxCutRadius(settings);
            const generatorOptions = {
                vbitAngle,
                startDepth,
                maxDepth,
                tipRadius,
                maxCutRadius,
                minChainLength: settings.vcarveMinChainLength ?? 0,
                cornerAngle: settings.vcarveCornerAngle ?? 30,
                // Extra dimensional erosion gate in mm on top of the angle
                // based rib prune. 0 = off, which is the profile default.
                noiseThreshold: settings.vcarveNoiseThreshold ?? 0,
                // Boundary sampling step for the Voronoi medial engine.
                // Must be smaller than the thinnest stroke width; the
                // generator warns (unrecovered walls) when it is not.
                sampleSpacing: settings.vcarveSampleSpacing ?? 0.15
            };
            this.debug('Generator options:', generatorOptions);

            // Floor clamp clearance calculated locally so Clipper can generate
            // floor loops on the main thread before worker dispatch.
            const { tClamp } = this.resolveDepthLimit({ vbitAngle, startDepth, maxDepth, tipRadius, maxCutRadius });

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
            const canFloor = tClamp !== null && !!this.core.geometryProcessor;

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
                const generator = typeof VCarveGenerator !== 'undefined'
                    ? VCarveGenerator
                    : (typeof window !== 'undefined' ? window.VCarveGenerator : null);
                if (generator) {
                    vcarvePrimitives.push(...generator.generateVCarvePaths(
                        jobs[i].prim, jobs[i].opts));
                } else {
                    console.error('[ShapeVCarveHandler] VCarveGenerator is not available for sync fallback');
                }
                done++; report(); // sync-run completion is the real progress
            }

            const wallMs = performance.now() - prof.t0;
            this.debug(`Dispatch profile: wall=${wallMs.toFixed(0)}ms, ` +
                `dispatchLoop=${prof.dispatchMs.toFixed(0)}ms ` +
                `(clipper=${prof.clipperMs.toFixed(0)}ms, ` +
                `pack+post=${prof.packMs.toFixed(0)}ms), ` +
                `workerOverlap=${(wallMs - prof.dispatchMs).toFixed(0)}ms` +
                (prof.skippedFloor ? `, floorSkipped=${prof.skippedFloor} (bbox < 2·tClamp)` : ''));

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
                    toolDiameter: settings.toolDiameter,
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