/*!
 * @file        geometry/geometry-utils-vcarve.js
 * @description Straight-skeleton generator for V-Carve toolpaths (3D centerline paths)
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// REVIEW - wavefront skeleton has been replaced by vonoroi medial axis, so all mentions to it are outdated and need a lookover.

(function() {
    'use strict';

    const ROOT = (typeof self !== 'undefined') ? self : window;
    // Worker-safe: CAMConfig is not loaded in the field worker. Fallbacks
    // MUST match config values (0.001mm coordinate grid) - if the config
    // precision ever changes, ship it in the worker job instead.
    const C = ROOT.CAMConfig?.constants;
    const D = ROOT.CAMConfig?.defaults;
    const PRECISION = C?.precision?.coordinate ?? 0.001;   // 0.001mm - node quantization grid
    const debugState = D?.debug || { enabled: false };

    // Numerical guards (module-local; promote to CAMConfig.constants.precision later if reused)
    const T_EPS    = 1e-7;   // wavefront time/distance epsilon
    const DEG_EPS  = 1e-12;  // degenerate-denominator guard

    // Vector helpers
    const sub   = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
    const dot   = (a, b) => a.x * b.x + a.y * b.y;
    const cross = (a, b) => a.x * b.y - a.y * b.x;
    const len   = (a) => Math.hypot(a.x, a.y);
    const norm  = (a) => { const l = len(a); return l < DEG_EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; };

    // REVIEW - Update comments now uses Medial axis via the Voronoi diagram of densely sampled boundary points (Delaunator).
    /**
     * Straight-skeleton based V-Carve path generator.
     *
     * Algorithm: wavefront simulation (Felkel/Obdržálek style).
     *   Every boundary edge advances inward at unit speed. Vertices ride
     *   their angle bisectors. Two event types consume the wavefront:
     *     - Edge events:  two adjacent bisectors meet - an edge collapses.
     *     - Split events: a reflex vertex hits an opposite edge - the
     *       wavefront splits (or merges across a hole boundary; the
     *       pointer surgery is identical for both).
     *   Every skeleton node carries the wavefront time t, which IS the
     *   perpendicular distance to the nearest boundary. Depth follows:
     *       Z = -(startDepth + t / tan(vbitAngle / 2))
     *
     * Input contract:
     *   - One primitive = one connected region (outer + its holes).
     *     Disjoint regions must be passed as separate primitives -
     *     split-event validity cannot distinguish overlapping wedges of
     *     unrelated regions. (Handler enforces this via nesting merge.)
     *   - Contours are closed polylines. Arc tessellation has already
     *     happened upstream (arcSegments are metadata only).
     *   - contour.isHole flags are trusted when present.
     *
     * Output: array of PathPrimitive-like objects whose contour points
     * carry {x, y, z}. properties.is3DContour = true marks them for the
     * downstream pipeline (translator / optimizer / machine processor).
     *
     * Known limitations (v1, document in commit message):
     *   - Simultaneous events at identical t are processed sequentially;
     *     highly symmetric shapes (perfect squares) rely on epsilon
     *     tie-breaking. Quantized output hides sub-precision noise.
     *   - No "vertex events" (4+ bisectors meeting exactly): resolved as
     *     cascaded edge events, which is geometrically fine but can emit
     *     near-zero-length arcs (filtered at emission).
     *   - Split-event sign conventions assume CCW outers / CW holes;
     *     orientation is enforced in prepareContours.
     */

    // REVIEW - This is a weird way to do this?
    const VCarveGenerator = {

        // ═══════════════════════════════════════════════════════════
        // Public API
        // ═══════════════════════════════════════════════════════════

        /**
         * @param {Object} primitive  PathPrimitive (or convertible) - one region
         * @param {Object} options
         *   vbitAngle         {number} included angle in degrees (default 90)
         *   startDepth        {number} mm below surface where carving starts (default 0)
         *   maxDepth          {number|null} mm magnitude; Z is clamped to -maxDepth.
         *                     null disables clamping. Clamping only - flat-floor
         *                     CLEARING is a separate, future feature.
         *   simplifyTolerance {number} RDP pre-simplification in mm (default 0 = off).
         *                     Directly controls skeleton "spoke" density on
         *                     tessellated curves. Max sensible value ≈ a few x PRECISION.
         *   minChainLength    {number} drop output chains shorter than this (default 0 = keep all)
         * @returns {Array} PathPrimitive-like objects with {x,y,z} points
         */
        generateVCarvePaths(primitive, options = {}) {
            const vbitAngle = options.vbitAngle || 90;
            const startDepth = Math.max(0, options.startDepth || 0);
            const maxDepth = (options.maxDepth !== undefined && options.maxDepth !== null)
                ? Math.abs(options.maxDepth) : null;
            const simplifyTolerance = options.simplifyTolerance || 0;
            const minChainLength = options.minChainLength || 0;
            // V-bit tip is a flat of radius tipRadius, not a perfect apex.
            // Depth model: depth(t) = max(0, t - tipRadius) / tanHalf,
            // groove half-width at depth h = tipRadius + h·tanHalf.
            const tipRadius = Math.max(0, options.tipRadius || 0);
            // Boundary direction change (deg) below which a vertex is
            // "smooth" and its skeleton spoke is construction-only.
            const cornerAngle = options.cornerAngle ?? 30;
            const noiseThreshold = Math.max(0, options.noiseThreshold || 0);

            const tanHalf = Math.tan((vbitAngle * Math.PI / 180) / 2);
            if (!(tanHalf > DEG_EPS)) {
                console.error(`[VCarveGenerator] Invalid V-bit angle: ${vbitAngle}`);
                return [];
            }

            options.onProgress?.({ frac: 0.05, label: 'V-Carve: contours' });
            const contours = this.prepareContours(primitive, simplifyTolerance);
            if (contours.length === 0) {
                this.debug('No usable contours after preparation');
                return [];
            }

            // REVIEW - Update comments now uses Medial axis via the Voronoi diagram of densely sampled boundary points (Delaunator).
            // Wavefront time at which the bit bottoms out (shared formula
            // with the handler via computeFloorClamp).
            const tClamp = this.computeFloorClamp({ vbitAngle, startDepth, maxDepth, tipRadius });

            // Stage 2: Delaunay medial axis (Voronoi engine). Floor
            // perimeter loops now come from the handler's Clipper inset at
            // tClamp (options.floorLoops) instead of wavefront capture -
            // round-join inset at reflex corners is the geometrically
            // correct flank-contact perimeter anyway.
            options.onProgress?.({ frac: 0.15, label: 'V-Carve: medial axis' });
            const { arcs } = this.computeMedialAxis(contours, {
                cornerAngleRad: cornerAngle * Math.PI / 180,
                sampleSpacing: options.sampleSpacing
            });
            const floorLoops = (tClamp !== null && Array.isArray(options.floorLoops))
                ? options.floorLoops : [];
            
            this.debug(`Skeleton: ${arcs.length} arc(s), ${floorLoops.length} floor loop(s) from ${contours.length} contour(s)`);
            if (arcs.length === 0 && floorLoops.length === 0) return [];

            // ── Rib pruning ──────────────────────────────────────────────
            // REVIEW - is this still necessary with voronoi instead of wavefront?
            // Geometric gate: t is distance-to-boundary, so along any arc
            // |Δt| ≤ length (1-Lipschitz), slope = |Δt|/length ∈ [0,1]. An
            // arc riding the bisector of a vertex whose boundary direction
            // changes by δ has slope = cos(δ/2) EXACTLY - for convex AND
            // reflex vertices, boundary spokes AND their interior merge
            // cascades. Smooth tessellation stubble rides at slope ≈ 1;
            // real corners sit below cos(cornerAngle/2). Iteratively eroding
            // steep leaves therefore strips construction ribs on both the
            // convex and concave side - the two cases the c-flag alone
            // could not reach (cascades carry c:false; reflex vertices were
            // excluded from smoothSpoke entirely).
            const slopeGate = Math.cos((cornerAngle * Math.PI / 180) / 2) - 1e-6;
            let prunedArcs = this.pruneSkeleton(arcs, { slopeGate, noiseThreshold });

            // Near-circular regions erode completely (their true medial
            // axis is ~a point). Keep the single deepest arc so dots still
            // get carved at their deepest spot instead of vanishing.
            if (prunedArcs.length === 0 && arcs.length > 0) {
                let best = arcs[0];
                for (const a of arcs) {
                    if (Math.max(a.t1, a.t2) > Math.max(best.t1, best.t2)) best = a;
                }
                prunedArcs = [best];
                this.debug('Skeleton fully eroded - keeping single deepest arc');
            }

            // Junction-fan prune. In the Voronoi engine, noise branches are
            // sampling-scale offshoots (O(sampleSpacing)); real corner
            // branches are stroke-scale (length ≈ (w/2)·√2, depth ≈ w/2).
            // Floors therefore tie to the sampling step - the old absolute
            // mm floors (0.8 / 0.3) were eating legitimate corner branches
            // on any stroke narrower than ~1mm. depthFloor keeps tipRadius
            // as a lower bound: a branch that never exceeds tipRadius
            // clearance maps to z = 0 for its whole length and cuts nothing.
            // (Strokes thinner than ~3x spacing still lose corners - the
            // wall-recovery warning fires in the same regime; lower
            // vcarveSampleSpacing for very small text.)
            const spacing = Math.max(10 * PRECISION, options.sampleSpacing || 0.15);
            const branchLengthFloor = 3 * spacing;
            const branchDepthFloor  = Math.max(1.5 * spacing, tipRadius);
            prunedArcs = this.pruneShortBranches(prunedArcs, {
                lengthFloor: branchLengthFloor,
                depthFloor:  branchDepthFloor
            });

            const chains = this.chainArcs(prunedArcs);
            this.debug(`Chained into ${chains.length} continuous path(s)`);

            // ── Flat-zone unification (computed BEFORE chainsToPrimitives) ──
            // Each bottomed-out floor loop becomes ONE continuous path -
            // perimeter side 1 → spine (reversed) → perimeter side 2 - via
            // stitchFloorRegion. The spine nodes it consumes are flagged
            // (_claimed) so chainsToPrimitives OMITS them from the standalone
            // V-groove chains. Without this the deep centreline is cut twice
            // (once clamped-to-floor inside its own chain, once as the stitch
            // centre) and the two copies scatter to different optimizer slots -
            // the jumps and the dense collinear runs you were seeing. A spine
            // run that no loop claims is left in its chain untouched, so a cut
            // is never dropped.
            const floorPaths = [];
            if (floorLoops.length > 0) {
                let maxT = 0;
                for (const chain of chains) for (const n of chain) if (n.t > maxT) maxT = n.t;
                const ridgeRisk = maxT > 2 * tClamp + T_EPS;
                const zFloor = -maxDepth;

                // Claim ONLY genuinely bottomed-out nodes. The old
                // 0.5 * spacing slack pulled un-clamped ramp nodes into the
                // spine; those nodes were then deleted from their chain and
                // re-emitted flat at zFloor inside the stitch, which both
                // gapped the ramp and flattened material that should be a V.
                const spineEps = T_EPS;

                // Contiguous t>=tClamp runs. Nodes are refs into the chain
                // arrays, so flagging a node marks it inside its chain too.
                const spineRuns = [];
                for (const chain of chains) {
                    let run = null;
                    for (const n of chain) {
                        if (n.t >= tClamp - spineEps) {
                            if (!run) { run = []; spineRuns.push(run); }
                            run.push(n);
                        } else {
                            run = null;
                        }
                    }
                }

                // Accept both the new { points, isHole } shape and the legacy
                // bare point array, so an out-of-order deploy cannot silently
                // treat every loop as a hole.
                const normalized = floorLoops.map(l => Array.isArray(l)
                    ? { points: l, isHole: false }
                    : { points: l.points || [], isHole: l.isHole === true });

                for (const loop of normalized) {
                    const denseLoop = this.resampleClosed(loop.points, spacing);
                    if (denseLoop.length < 4) continue;

                    let spine = null;
                    if (!loop.isHole) {
                        for (const run of spineRuns) {
                            if (run.length < 2 || run._claimed) continue;
                            // ALWAYS containment-test. Two old defects:
                            //  - the test was skipped whenever there was a
                            //    single floor loop, so a loop could claim the
                            //    longest run ANYWHERE in the region (Clipper
                            //    routinely drops one of two flat zones);
                            //  - it probed only the midpoint, so a run that
                            //    merely grazed the loop qualified.
                            if (!this.runInsideLoop(run, denseLoop)) continue;
                            if (!spine || run.length > spine.length) spine = run;
                        }
                    }

                    const stitched = spine ? this.stitchFloorRegion(denseLoop, spine, zFloor) : null;
                    const pts = stitched || this.closedPerimeter(denseLoop, zFloor);
                    if (!pts || pts.length < 3) continue;

                    // Claim the spine ONLY when it was actually stitched in - a
                    // fallback closedPerimeter consumes no spine, so claiming
                    // one would silently drop that centreline (a gap). Failing
                    // the containment test therefore costs a double cut inside
                    // the flat zone, never a missing one.
                    if (stitched && spine) {
                        for (const n of spine) n._claimed = true;
                        spine._claimed = true;
                    }

                    const properties = {
                        isVCarve: true,
                        is3DContour: true,
                        role: 'vcarve_path',
                        vcarvePass: 'floor-perimeter',
                        ridgeRisk,
                        isHole: loop.isHole,
                        stitched: stitched !== null,
                        stroke: true, fill: false, strokeWidth: 0
                    };
                    if (typeof Polyline3DPrimitive !== 'undefined') {
                        floorPaths.push(Polyline3DPrimitive.fromPoints(pts, properties));
                    } else {
                        floorPaths.push(typeof PathPrimitive !== 'undefined'
                            ? new PathPrimitive([{
                                points: pts, closed: false, isHole: false,
                                nestingLevel: 0, parentId: null,
                                arcSegments: [], curveIds: []
                            }], properties)
                            : { type: 'path', contours: [{ points: pts, closed: false }], properties });
                    }
                }
            }

            options.onProgress?.({ frac: 0.85, label: 'V-Carve: emitting chains' });
            // Standalone V-groove chains. Claimed spine nodes are skipped, so
            // the bottomed-out centreline is emitted ONLY inside its floor path.
            const out = this.chainsToPrimitives(chains, tanHalf, startDepth, maxDepth, minChainLength, tipRadius);
            out.push(...floorPaths);
            return out;
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 1 - Contour preparation
        // ═══════════════════════════════════════════════════════════

        // GeometryUtils is main-thread only - it is not in field-worker.js's
        // importScripts list, so these two guards are live inside the worker.
        prepareContours(primitive, simplifyTolerance) {
            let source = primitive;
            if (primitive.type !== 'path' && typeof GeometryUtils !== 'undefined'
                && GeometryUtils.primitiveToPath) {
                const converted = GeometryUtils.primitiveToPath(primitive);
                if (converted?.contours?.length > 0) source = converted;
            }
            if (!source.contours || source.contours.length === 0) return [];

            const prepared = [];
            for (const rawContour of source.contours) {
                // REVIEW - Update comments now uses Medial axis via the Voronoi diagram of densely sampled boundary points (Delaunator).
                // Arcs cannot be consumed analytically by the wavefront -
                // resolve them to a dense point array FIRST, so the skeleton
                // sees the true curve instead of straight chords between arc
                // endpoints (which would miter every rounded corner).
                // contourArcsToPath is a no-op when the contour carries no
                // arcSegments, so this is safe to call unconditionally.
                const contour = (rawContour.arcSegments?.length
                                 && typeof GeometryUtils !== 'undefined'
                                 && GeometryUtils.contourArcsToPath)
                    ? GeometryUtils.contourArcsToPath(rawContour)
                    : rawContour;

                let pts = (contour.points || []).map(p => ({ x: p.x, y: p.y }));
                if (pts.length < 3) continue;

                // Drop closing duplicate
                if (Math.hypot(pts[0].x - pts[pts.length - 1].x,
                               pts[0].y - pts[pts.length - 1].y) < PRECISION) {
                    pts.pop();
                }
                // Dedupe consecutive points
                pts = pts.filter((p, i) => {
                    if (i === 0) return true;
                    const q = pts[i - 1];
                    return Math.hypot(p.x - q.x, p.y - q.y) >= PRECISION;
                });
                if (pts.length < 3) continue;

                // RDP is OFF for V-Carve by default (tolerance 0). See the
                // note on vcarveSimplifyTolerance in shape-vcarve-handler.js.
                if (simplifyTolerance > 0) {
                    pts = this.simplifyRDP(pts, simplifyTolerance);
                    if (pts.length < 3) continue;
                }

                const isHole = contour.isHole === true;
                const area = this.signedArea(pts);
                if (Math.abs(area) < PRECISION * PRECISION) {
                    this.debug(`prepareContours: dropped ${isHole ? 'HOLE' : 'outer'} contour - degenerate area ${area.toExponential(2)} (${pts.length} pts). If this was a hole its void will carve solid.`);
                    continue;
                }

                prepared.push({ points: pts, isHole });
            }
            return prepared;
        },

        signedArea(pts) {
            let a = 0;
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i], q = pts[(i + 1) % pts.length];
                a += p.x * q.y - q.x * p.y;
            }
            return a / 2;
        },

        /** Closed-loop Douglas-Peucker: anchors at the two most distant points, simplifies both halves. */
        // REVIEW - Five independent polyline simplifiers ship in this repo:
        // GeometryUtils.simplifyDouglasPeucker, VCarveGenerator.simplifyRDP/rdpOpen,
        // FieldPaths.simplify3D, ToolpathOptimizer.simplifyCollinearPoints and
        // GerberParser.simplifyRDP. Consolidation is blocked on the worker boundary
        // (vcarve and fieldpaths cannot reach GeometryUtils). Fix all five together
        // or none.
        simplifyRDP(pts, tolerance) {
            if (pts.length <= 4) return pts;
            // Find two mutually distant anchor indices (0 and farthest from 0)
            let far = 0, maxD = -1;
            for (let i = 1; i < pts.length; i++) {
                const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
                if (d > maxD) { maxD = d; far = i; }
            }
            const half1 = this.rdpOpen(pts.slice(0, far + 1), tolerance);
            const half2 = this.rdpOpen(pts.slice(far).concat([pts[0]]), tolerance);
            return half1.slice(0, -1).concat(half2.slice(0, -1));
        },

        rdpOpen(pts, tolerance) {
            if (pts.length <= 2) return pts;
            const first = pts[0], last = pts[pts.length - 1];
            let maxDist = 0, idx = 0;
            const dx = last.x - first.x, dy = last.y - first.y;
            const segLen = Math.hypot(dx, dy) || DEG_EPS;
            for (let i = 1; i < pts.length - 1; i++) {
                const d = Math.abs(dy * (pts[i].x - first.x) - dx * (pts[i].y - first.y)) / segLen;
                if (d > maxDist) { maxDist = d; idx = i; }
            }
            if (maxDist <= tolerance) return [first, last];
            const left = this.rdpOpen(pts.slice(0, idx + 1), tolerance);
            const right = this.rdpOpen(pts.slice(idx), tolerance);
            return left.slice(0, -1).concat(right);
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 2 Delaunay-based medial axis - (Voronoi engine)
        // ═══════════════════════════════════════════════════════════

        /**
         * Wavefront time at which the V-bit bottoms out. Shared with the
         * handler so floor insets can be computed (async, via the Clipper
         * offsetter) BEFORE calling the sync generator.
         * REVIEW - Medial axis via the Voronoi diagram of densely sampled
         * boundary points (Delaunator). Replaced the wavefront simulation.
         * @returns {number|null}
         */
        computeFloorClamp(opts = {}) {
            const vbitAngle = opts.vbitAngle || 90;
            const startDepth = Math.max(0, opts.startDepth || 0);
            const maxDepth = (opts.maxDepth !== undefined && opts.maxDepth !== null)
                ? Math.abs(opts.maxDepth) : null;
            const tipRadius = Math.max(0, opts.tipRadius || 0);
            const tanHalf = Math.tan((vbitAngle * Math.PI / 180) / 2);
            if (!(tanHalf > DEG_EPS)) return null;
            return (maxDepth !== null && maxDepth > startDepth)
                ? (maxDepth - startDepth) * tanHalf + tipRadius
                : null;
        },

        /**
         * Uniform closed-contour resampling. Original vertices are ALWAYS
         * kept (corners stay exact); segments longer than `spacing` are
         * subdivided evenly. Zero-length segments are dropped.
         */
        resampleClosed(points, spacing) {
            const out = [];
            const n = points.length;
            for (let i = 0; i < n; i++) {
                const a = points[i], b = points[(i + 1) % n];
                const dx = b.x - a.x, dy = b.y - a.y;
                const d = Math.hypot(dx, dy);
                if (d < PRECISION) continue;
                out.push({ x: a.x, y: a.y });
                const k = Math.ceil(d / spacing);
                for (let j = 1; j < k; j++) {
                    const f = j / k;
                    out.push({ x: a.x + f * dx, y: a.y + f * dy });
                }
            }
            return out;
        },

        /**
         * Medial axis via the Voronoi diagram of densely sampled boundary
         * points (Delaunator). Replaces the wavefront simulation.
         *
         * Method (F-Engrave-style):
         *   1. Resample every contour at ~uniform spacing.
         *   2. Delaunay-triangulate all samples (outer + holes together).
         *   3. Classify triangles inside/outside by parity flood fill
         *      across recovered boundary edges (ray-cast fallback).
         *   4. Each Delaunay edge shared by two interior triangles is dual
         *      to a Voronoi edge between their circumcenters; circumradius
         *      IS the clearance t at each endpoint.
         *
         * Output contract matches computeSkeleton's arcs, so
         * pruneSkeleton / pruneShortBranches / chainArcs run unchanged:
         *   - Sampling "teeth" ride at slope ≈ 1 → eroded by the existing
         *     slope gate, same math as tessellation spokes.
         *   - Corner spokes (turn ≥ cornerAngle) ride at cos(δ/2) → kept.
         *   - Every node is parity-verified inside the region, so
         *     out-of-footprint arcs are structurally impossible.
         *
         * Accuracy: t errs by ~spacing²/(8·t) (chord sagitta) - ≈ 6µm at
         * spacing 0.15mm / t 0.5mm, below machine resolution. Halve
         * spacing to quarter the error.
         *
         * @returns {{ arcs: Array }}
         */
        computeMedialAxis(contours, opts = {}) {
            const cornerRad = opts.cornerAngleRad ?? (30 * Math.PI / 180);
            const spacing = Math.max(10 * PRECISION, opts.sampleSpacing || 0.15);
            const arcs = [];

            if (typeof Delaunator === 'undefined') {
                throw new Error('Delaunator missing (vendor/delaunator.min.js must load before geometry-utils-vcarve.js)');
            }

            // ── Sampling ─────────────────────────────────────────────
            const coords = [];        // flat [x,y,...] for Delaunator
            const sContour = [];      // sample → contour ordinal
            const sIndex = [];        // sample → index within its contour
            const cCount = [];        // contour ordinal → sample count
            const cBase = [];         // contour ordinal → first sample id
            const polys = [];         // resampled rings (for parity tests)

            for (const contour of contours) {
                const ring = this.resampleClosed(contour.points, spacing);
                if (ring.length < 3) {
                    this.debug(`computeMedialAxis: contour degenerated to ${ring.length} sample(s) - SKIPPED. If this was a hole, its area will be carved solid.`);
                    continue;
                }
                const ci = polys.length;
                cBase.push(sContour.length);
                polys.push(ring);
                cCount.push(ring.length);
                for (let i = 0; i < ring.length; i++) {
                    sContour.push(ci); sIndex.push(i);
                    coords.push(ring[i].x, ring[i].y);
                }
            }
            const N = sContour.length;
            if (N < 3) return { arcs };

            // Per-ring bounds for the parity prefilter below. A query
            // point outside a ring's bbox contributes an EVEN number of
            // ray crossings (zero when right/above/below; enter-exit
            // pairs when strictly left), so parity is unchanged and the
            // ring is skipped. Exact. Pays off hardest in the parity-
            // fallback regime, where every centroid, escaped circum-
            // center, and dual-edge midpoint queries ALL rings.
            const polyBB = polys.map(ring => {
                let minX = Infinity, minY = Infinity,
                    maxX = -Infinity, maxY = -Infinity;
                for (const p of ring) {
                    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
                }
                return { minX, minY, maxX, maxY };
            });

            // Per-sample boundary turn angle: 0 on subdivided straights,
            // the true direction change at preserved corner vertices.
            const turn = new Float64Array(N);
            {
                let base = 0;
                for (const ring of polys) {
                    const m = ring.length;
                    for (let i = 0; i < m; i++) {
                        const p0 = ring[(i - 1 + m) % m], p1 = ring[i], p2 = ring[(i + 1) % m];
                        const ux = p1.x - p0.x, uy = p1.y - p0.y;
                        const vx = p2.x - p1.x, vy = p2.y - p1.y;
                        turn[base + i] = Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
                    }
                    base += m;
                }
            }

            const del = new Delaunator(coords);
            const tri = del.triangles, half = del.halfedges;
            const nTri = (tri.length / 3) | 0;
            if (nTri === 0) return { arcs };
            const nextHE = (e) => (e % 3 === 2) ? e - 2 : e + 1;

            // ── Boundary ("wall") edge set, keyed by sample pair ─────
            const ekey = (a, b) => a < b ? a * N + b : b * N + a;
            const walls = new Set();
            for (let ci = 0; ci < polys.length; ci++) {
                const base = cBase[ci], m = cCount[ci];
                for (let i = 0; i < m; i++) {
                    walls.add(ekey(base + i, base + (i + 1) % m));
                }
            }

            // Boundary-recovery check: every wall must appear as a Delaunay
            // edge or flood fill is unsound. Dense sampling guarantees this;
            // a miss means spacing > local feature size (thin stroke).
            const delEdges = new Set();
            for (let e = 0; e < tri.length; e++) {
                delEdges.add(ekey(tri[e], tri[nextHE(e)]));
            }
            let wallsMissing = 0;
            for (const w of walls) if (!delEdges.has(w)) wallsMissing++;
            if (wallsMissing > 0) {
                this.debug(`computeMedialAxis: ${wallsMissing} boundary edge(s) not recovered - parity fallback. Reduce sampleSpacing below the thinnest stroke width.`);
            }

            // Even-odd parity: inside the region iff crossing count is odd.
            // Orientation-independent; holes handled implicitly.
            const parityInside = (x, y) => {
                let inside = false;
                for (let r = 0; r < polys.length; r++) {
                    const bb = polyBB[r];
                    if (y < bb.minY || y > bb.maxY ||
                        x > bb.maxX || x < bb.minX) continue;
                    const ring = polys[r];
                    const m = ring.length;
                    for (let i = 0, j = m - 1; i < m; j = i++) {
                        const yi = ring[i].y, yj = ring[j].y;
                        if ((yi > y) !== (yj > y)) {
                            const xInt = ring[i].x + (y - yi) / (yj - yi) * (ring[j].x - ring[i].x);
                            if (x < xInt) inside = !inside;
                        }
                    }
                }
                return inside;
            };
            const centroidInside = (t) => {
                const a = 2 * tri[3 * t], b = 2 * tri[3 * t + 1], c = 2 * tri[3 * t + 2];
                return parityInside(
                    (coords[a] + coords[b] + coords[c]) / 3,
                    (coords[a + 1] + coords[b + 1] + coords[c + 1]) / 3);
            };

            // ── Triangle interior classification ────────────────────
            // Primary: O(T) parity flood fill over triangle adjacency -
            // crossing a wall edge flips inside/outside, any other edge
            // preserves it. Seeds: hull triangles (beyond the hull is
            // outside; a wall ON the hull means its triangle is inside).
            // Any inconsistency → definitive per-triangle ray cast.
            const isWallHE = (e) => walls.has(ekey(tri[e], tri[nextHE(e)]));
            const inside = new Uint8Array(nTri);
            let useParity = wallsMissing > 0;
            if (!useParity) {
                const state = new Int8Array(nTri).fill(-1);
                const queue = [];
                let conflicts = 0;
                for (let e = 0; e < half.length; e++) {
                    if (half[e] !== -1) continue;
                    const t = (e / 3) | 0;
                    const s = isWallHE(e) ? 1 : 0;
                    if (state[t] === -1) { state[t] = s; queue.push(t); }
                    else if (state[t] !== s) conflicts++;
                }
                while (queue.length && conflicts === 0) {
                    const t = queue.pop();
                    for (let k = 0; k < 3; k++) {
                        const e = 3 * t + k, o = half[e];
                        if (o === -1) continue;
                        const nt = (o / 3) | 0;
                        const s = isWallHE(e) ? (state[t] ^ 1) : state[t];
                        if (state[nt] === -1) { state[nt] = s; queue.push(nt); }
                        else if (state[nt] !== s) { conflicts++; break; }
                    }
                }
                if (conflicts > 0) {
                    this.debug(`computeMedialAxis: flood-fill conflict - parity fallback`);
                    useParity = true;
                } else {
                    for (let t = 0; t < nTri; t++) {
                        inside[t] = state[t] === 1 ? 1 : (state[t] === -1 ? (centroidInside(t) ? 1 : 0) : 0);
                    }
                }
            }
            if (useParity) {
                for (let t = 0; t < nTri; t++) inside[t] = centroidInside(t) ? 1 : 0;
            }

            // ── Circumcenters (Voronoi vertices) + clearance ─────────
            // Circumradius = distance to the three nearest boundary
            // samples = clearance t. Circumcenters that escape the region
            // (obtuse slivers near reflex corners / gentle curvature) are
            // dropped at the source - the true medial axis never exits.
            const ccx = new Float64Array(nTri), ccy = new Float64Array(nTri);
            const ccr = new Float64Array(nTri);
            const ccOk = new Uint8Array(nTri);
            for (let t = 0; t < nTri; t++) {
                if (!inside[t]) continue;
                const ia = 2 * tri[3 * t], ib = 2 * tri[3 * t + 1], ic = 2 * tri[3 * t + 2];
                const ax = coords[ia], ay = coords[ia + 1];
                const bx = coords[ib], by = coords[ib + 1];
                const cx = coords[ic], cy = coords[ic + 1];
                const dx = bx - ax, dy = by - ay, ex = cx - ax, ey = cy - ay;
                const den = dx * ey - dy * ex;
                if (Math.abs(den) < DEG_EPS) continue;   // collinear sliver
                const bl = dx * dx + dy * dy, cl = ex * ex + ey * ey;
                const dd = 0.5 / den;
                const px = ax + (ey * bl - dy * cl) * dd;
                const py = ay + (dx * cl - ex * bl) * dd;
                // Cheap in-own-triangle test avoids most ray casts
                // (acute triangles contain their circumcenter).
                const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
                const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
                const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
                // In-own-triangle fast path is sound ONLY when the triangulation
                // is fully constrained (every wall recovered as a Delaunay edge).
                // In parity fallback (useParity) a material triangle can straddle
                // a hole: its circumcenter lands "in-triangle" yet inside the
                // void. Force the ray cast there so void nodes are rejected.
                let ok = false;
                if (!useParity) {
                    ok = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
                }
                if (!ok) ok = parityInside(px, py);
                if (!ok) continue;
                ccx[t] = px; ccy[t] = py;
                ccr[t] = Math.hypot(px - ax, py - ay);
                ccOk[t] = 1;
            }

            // ── Emit medial arcs ─────────────────────────────────────
            // Construction flag: a Voronoi edge whose dual generators sit
            // a few samples apart on a locally SMOOTH stretch of one
            // contour is curvature stubble (the sampled analog of the
            // smooth-vertex spokes). Across a real corner the accumulated
            // turn exceeds cornerAngle and the spoke stays real.
            const smoothChord = (a, b) => {
                if (sContour[a] !== sContour[b]) return false;
                const ci = sContour[a], m = cCount[ci], base = cBase[ci];
                let d = sIndex[b] - sIndex[a];
                if (d < 0) d += m;
                let from = a, steps = d;
                if (d > m - d) { from = b; steps = m - d; }   // walk the short way
                if (steps > 8) return false;                   // far apart → trunk chord
                // INCLUSIVE max-turn: the chord is construction only when
                // NO sample in its span - generators included - is a real
                // corner. The previous sum over strictly-between samples
                // excluded the generators themselves, so chords radiating
                // FROM a corner sample read as smooth, got c:true, and
                // pruneSkeleton ate the spoke tip, then erosion marched
                // inward until slope stopped it - truncated corner branches.
                // Max (not sum) also keeps gentle multi-sample curvature
                // classified as smooth, matching the old per-vertex
                // smoothSpoke semantics.
                let i = sIndex[from];
                let maxTurn = turn[base + i];
                for (let k = 1; k <= steps; k++) {
                    i = (i + 1) % m;
                    if (turn[base + i] > maxTurn) maxTurn = turn[base + i];
                }
                return maxTurn < cornerRad;
            };
            for (let e = 0; e < half.length; e++) {
                const o = half[e];
                if (o < e) continue;                 // visit once (also skips hull, o = -1)
                const ta = (e / 3) | 0, tb = (o / 3) | 0;
                if (!ccOk[ta] || !ccOk[tb]) continue;

                // Dual-edge hole guard. With every wall recovered, Delaunay
                // planarity forbids an edge from crossing a hole, so two valid
                // circumcenters imply a valid segment. In parity fallback that
                // guarantee is gone: an unconstrained edge can bridge a hole,
                // giving two in-material circumcenters joined by a Voronoi
                // segment that dives through the void. Sample the midpoint (the
                // deepest incursion for a straight chord across a convex hole)
                // and drop the arc if it leaves the stock.
                if (useParity) {
                    const mx = (ccx[ta] + ccx[tb]) * 0.5;
                    const my = (ccy[ta] + ccy[tb]) * 0.5;
                    if (!parityInside(mx, my)) continue;
                }

                const g1 = tri[e], g2 = tri[nextHE(e)];
                arcs.push({
                    x1: ccx[ta], y1: ccy[ta], t1: ccr[ta],
                    x2: ccx[tb], y2: ccy[tb], t2: ccr[tb],
                    c: smoothChord(g1, g2)
                });
            }

            this.debug(`Medial axis: ${polys.length} contour(s), ${N} sample(s) → ${nTri} triangle(s) → ${arcs.length} arc(s)`
                + (wallsMissing ? ` [${wallsMissing} unrecovered wall(s)]` : ''));
            return { arcs };
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 3 - Chain arcs into continuous polylines
        // ═══════════════════════════════════════════════════════════

        chainArcs(arcs) {
            const key = (x, y) =>
                `${Math.round(x / PRECISION)}_${Math.round(y / PRECISION)}`;

            // Node graph
            const nodes = new Map(); // key → { x, y, t, arcs: [{idx, otherKey}] }
            const getNode = (x, y, t) => {
                const k = key(x, y);
                let n = nodes.get(k);
                if (!n) { n = { x, y, t, arcs: [] }; nodes.set(k, n); }
                else if (t < n.t) n.t = t; // keep shallowest time seen at this node
                return { k, n };
            };

            arcs.forEach((arc, idx) => {
                const a = getNode(arc.x1, arc.y1, arc.t1);
                const b = getNode(arc.x2, arc.y2, arc.t2);
                if (a.k === b.k) return; // quantized to a point - drop
                a.n.arcs.push({ idx, otherKey: b.k });
                b.n.arcs.push({ idx, otherKey: a.k });
            });

            const used = new Set();
            const chains = [];

            const walk = (startKey) => {
                const chain = [];
                let currentKey = startKey;
                let node = nodes.get(currentKey);
                let seeded = false;
                while (true) {
                    // Trunk-first continuation: among unused arcs, follow
                    // the one whose FAR endpoint is deepest. t is read from
                    // the candidate arc's own endpoint, never the node
                    // table - node t is min-merged across quantization
                    // collisions and lies about depth at shared nodes.
                    let next = null, bestT = -Infinity;
                    for (const a of node.arcs) {
                        if (used.has(a.idx)) continue;
                        const cand = arcs[a.idx];
                        const farIsP1 = key(cand.x1, cand.y1) === a.otherKey;
                        const farT = farIsP1 ? cand.t1 : cand.t2;
                        if (farT > bestT) { bestT = farT; next = a; }
                    }
                    if (!next) break;
                    used.add(next.idx);
                    const arc = arcs[next.idx];
                    const arriveAtP1 = key(arc.x1, arc.y1) === next.otherKey;
                    if (!seeded) {
                        // Seed with the NEAR endpoint of the first arc taken,
                        // carrying that arc's own t (not the node-table min).
                        chain.push(arriveAtP1
                            ? { x: arc.x2, y: arc.y2, t: arc.t2 }
                            : { x: arc.x1, y: arc.y1, t: arc.t1 });
                        seeded = true;
                    }
                    chain.push(arriveAtP1
                        ? { x: arc.x1, y: arc.y1, t: arc.t1 }
                        : { x: arc.x2, y: arc.y2, t: arc.t2 });
                    currentKey = next.otherKey;
                    node = nodes.get(currentKey);
                }
                return chain;
            };

            // Pass 1: start at odd-degree nodes, shallowest first
            // (chains begin at boundary corners → plunges happen at the surface)
            const endpoints = [...nodes.entries()]
                .filter(([, n]) => n.arcs.length % 2 === 1)
                .sort((a, b) => a[1].t - b[1].t);

            for (const [k, n] of endpoints) {
                while (n.arcs.some(a => !used.has(a.idx))) {
                    const chain = walk(k);
                    if (chain.length > 1) chains.push(chain);
                }
            }
            // Pass 2: leftover cycles / even components
            for (const [k, n] of nodes) {
                while (n.arcs.some(a => !used.has(a.idx))) {
                    const chain = walk(k);
                    if (chain.length > 1) chains.push(chain);
                }
            }

            // Prefer cutting shallow → deep
            for (const chain of chains) {
                if (chain[0].t > chain[chain.length - 1].t + T_EPS) chain.reverse();
            }
            return chains;
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 4 - Rib pruning & floor stitching
        // ═══════════════════════════════════════════════════════════

        /**
         * Erodes construction ribs from the raw skeleton arc list.
         * A "leaf" arc touches a degree-1 node. A leaf is removed when:
         *   - arc.c === true (smooth-origin boundary spoke), OR
         *   - its slope |Δt|/length ≥ opts.slopeGate. Slope equals
         *     cos(δ/2) for a bisector arc of a vertex with direction
         *     change δ, so the gate cos(cornerAngle/2) prunes exactly the
         *     sub-corner-threshold vertices - convex or reflex, boundary
         *     spoke or interior merge cascade - which the c flag cannot
         *     mark (cascade vertices are created flagless at events, and
         *     reflex vertices were excluded from smoothSpoke), OR
         *   - |Δt| < opts.noiseThreshold (dimensional stubble, 0 = off).
         * Removing a leaf can expose a new leaf one step inward, so the
         * pass repeats until stable. Trunk arcs (near-parallel walls,
         * slope ≈ 0) and genuine corner roll-ups (slope = cos(δ/2) below
         * the gate) are never eroded; the floor spine is deep at both
         * ends, never a leaf, and never touched.
         *
         * @param {Array} arcs raw arcs from computeSkeleton
         * @param {Object} opts { slopeGate?, noiseThreshold? }
         * @returns {Array} pruned arcs (new array)
         */
        pruneSkeleton(arcs, opts = {}) {
            const slopeGate = opts.slopeGate ?? 2;   // > 1 disables slope pruning
            const noiseThreshold = opts.noiseThreshold || 0;
            if (!arcs || arcs.length === 0) return arcs;

            const key = (x, y) =>
                `${Math.round(x / PRECISION)}_${Math.round(y / PRECISION)}`;

            const ka = new Array(arcs.length);
            const kb = new Array(arcs.length);
            const slope = new Float64Array(arcs.length);
            const degree = new Map();
            const bump = (k, d) => { if (k !== null) degree.set(k, (degree.get(k) || 0) + d); };

            for (let i = 0; i < arcs.length; i++) {
                const a = arcs[i];
                const k1 = key(a.x1, a.y1);
                const k2 = key(a.x2, a.y2);
                if (k1 === k2) { ka[i] = kb[i] = null; continue; } // zero-length
                ka[i] = k1; kb[i] = k2;
                bump(k1, 1); bump(k2, 1);
                const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
                slope[i] = len > DEG_EPS ? Math.abs(a.t2 - a.t1) / len : 1;
            }

            const alive = new Uint8Array(arcs.length);
            for (let i = 0; i < arcs.length; i++) alive[i] = ka[i] !== null ? 1 : 0;

            let changed = true;
            while (changed) {
                changed = false;
                for (let i = 0; i < arcs.length; i++) {
                    if (!alive[i]) continue;
                    const isLeaf = degree.get(ka[i]) === 1 || degree.get(kb[i]) === 1;
                    if (!isLeaf) continue;

                    const arc = arcs[i];
                    const prunable = arc.c === true ||
                        slope[i] >= slopeGate ||
                        (noiseThreshold > 0 && Math.abs(arc.t2 - arc.t1) < noiseThreshold);
                    if (!prunable) continue;

                    alive[i] = 0;
                    bump(ka[i], -1);
                    bump(kb[i], -1);
                    changed = true;
                }
            }

            const kept = [];
            let removed = 0;
            for (let i = 0; i < arcs.length; i++) {
                if (alive[i]) kept.push(arcs[i]); else removed++;
            }
            this.debug(`Pruned ${removed} construction rib(s); ${kept.length} arc(s) remain`);
            return kept;
        },

        /**
         * Whole-branch prune for junction "fans". After the slope prune, the
         * residual noise at concave junctions (leaf-meets-stem) is dense
         * reflex micro-branches: several near-coincident reflex boundary
         * vertices each spawn a tiny medial offshoot, so one intended bisector
         * reads as a fan. They are low-slope (pruneSkeleton misses them) and
         * in-bounds (containment misses them) yet carve nothing the trunk and
         * tool tip already cover.
         *
         * Each leaf is walked inward to its first junction (degree ≥ 3) or
         * dead end, accumulating path length and max |t|. The WHOLE branch is
         * dropped only if BOTH stay below the floors - evaluating the whole
         * branch (not per-arc) protects a genuine sharp corner, whose branch
         * is long/deep and survives. Iterated: dropping a branch can expose a
         * new leaf. Floors are caller-tuned (tie to tip footprint).
         *
         * @param {Array} arcs
         * @param {Object} floors { lengthFloor, depthFloor } in mm
         * @returns {Array} filtered arcs
         */
        pruneShortBranches(arcs, floors = {}) {
            const lengthFloor = floors.lengthFloor || 0;
            const depthFloor  = floors.depthFloor  || 0;
            if ((lengthFloor <= 0 && depthFloor <= 0) || !arcs || arcs.length === 0) return arcs;

            const key = (x, y) =>
                `${Math.round(x / PRECISION)}_${Math.round(y / PRECISION)}`;

            const adj = new Map();   // nodeKey → [{ idx, otherKey }]
            const addNode = (x, y) => {
                const k = key(x, y);
                if (!adj.has(k)) adj.set(k, []);
                return k;
            };
            const arcLen = new Float64Array(arcs.length);
            for (let i = 0; i < arcs.length; i++) {
                const a = arcs[i];
                const ka = addNode(a.x1, a.y1);
                const kb = addNode(a.x2, a.y2);
                arcLen[i] = Math.hypot(a.x2 - a.x1, a.y2 - a.y1);
                if (ka === kb) continue;
                adj.get(ka).push({ idx: i, otherKey: kb });
                adj.get(kb).push({ idx: i, otherKey: ka });
            }

            const dead = new Uint8Array(arcs.length);
            const degOf = (k) => {
                let d = 0;
                for (const e of adj.get(k)) if (!dead[e.idx]) d++;
                return d;
            };

            let changed = true;
            while (changed) {
                changed = false;
                for (const [k] of adj) {
                    if (degOf(k) !== 1) continue; // leaves only

                    const branch = [];
                    let curK = k, prevIdx = -1, maxT = 0, length = 0;
                    let guard = arcs.length + 1;
                    while (guard-- > 0) {
                        let step = null;
                        for (const e of adj.get(curK)) {
                            if (!dead[e.idx] && e.idx !== prevIdx) { step = e; break; }
                        }
                        if (!step) break;
                        branch.push(step.idx);
                        length += arcLen[step.idx];
                        const a = arcs[step.idx];
                        maxT = Math.max(maxT, a.t1, a.t2);
                        prevIdx = step.idx;
                        curK = step.otherKey;
                        const deg = degOf(curK);
                        if (deg >= 3 || deg === 1) break; // junction or opposite leaf
                    }
                    if (branch.length === 0) continue;

                    if (maxT < depthFloor && length < lengthFloor) {
                        for (const idx of branch) dead[idx] = 1;
                        changed = true;
                    }
                }
            }

            const kept = [];
            let removed = 0;
            for (let i = 0; i < arcs.length; i++) {
                if (dead[i]) removed++; else kept.push(arcs[i]);
            }
            this.debug(`Branch prune removed ${removed} junction-fan arc(s); ${kept.length} remain`);
            return kept;
        },

        /**
         * Stitches one bottomed-out region into a single continuous stroke:
         *   leftHalf (perimeter A→B) + spine (B→A) + rightHalf (perimeter A→B).
         * A and B are the perimeter vertices nearest the spine's two ends.
         * All points emit at zFloor. Returns null (caller falls back to a
         * plain closed perimeter) when the region has no usable spine.
         *
         * @param {Array} loop   closed floor perimeter, array of {x,y}
         * @param {Array} spine  ordered medial-centerline nodes, array of {x,y,...}
         * @param {number} zFloor floor Z (negative)
         * @returns {Array|null} array of {x,y,z}
         */
        stitchFloorRegion(loop, spine, zFloor) {
            if (!loop || loop.length < 4) return null;
            if (!spine || spine.length < 2) return null;

            const s0 = spine[0];
            const s1 = spine[spine.length - 1];
            if (Math.hypot(s1.x - s0.x, s1.y - s0.y) < PRECISION) return null;

            const nearest = (pt) => {
                let bi = 0, bd = Infinity;
                for (let i = 0; i < loop.length; i++) {
                    const dx = loop[i].x - pt.x, dy = loop[i].y - pt.y;
                    const d = dx * dx + dy * dy;
                    if (d < bd) { bd = d; bi = i; }
                }
                return bi;
            };
            const ai = nearest(s0);   // perimeter point A near spine start
            const bi = nearest(s1);   // perimeter point B near spine end
            if (ai === bi) return null;

            // Perimeter A→B both ways round the ring (the two halves).
            const forward = [];
            for (let i = ai; ; i = (i + 1) % loop.length) {
                forward.push(loop[i]);
                if (i === bi) break;
            }
            const backward = [];
            for (let i = ai; ; i = (i - 1 + loop.length) % loop.length) {
                backward.push(loop[i]);
                if (i === bi) break;
            }

            const seq = [];
            const push = (p) => {
                const q = seq[seq.length - 1];
                if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= PRECISION) {
                    seq.push({ x: p.x, y: p.y, z: zFloor });
                }
            };

            for (const p of forward) push(p);                          // A → B, side 1
            for (let i = spine.length - 1; i >= 0; i--) push(spine[i]); // B → A, centerline reversed
            for (const p of backward) push(p);                         // A → B, side 2

            return seq.length >= 3 ? seq : null;
        },

        /**
         * True when a spine run genuinely belongs to `ring`.
         * Five probes along the run; the midpoint must be inside and a
         * majority of the probes must be inside. Endpoints sit ON the
         * tClamp isoline (= the ring itself), so requiring all five would
         * reject every legitimate spine.
         */
        runInsideLoop(run, ring) {
            if (!run || run.length < 2 || !ring || ring.length < 3) return false;
            const last = run.length - 1;
            const probes = [
                run[0],
                run[(last * 0.25) | 0],
                run[last >> 1],
                run[(last * 0.75) | 0],
                run[last]
            ];
            const mid = run[last >> 1];
            if (!this.pointInRing(mid, ring)) return false;
            let inside = 0;
            for (const p of probes) if (this.pointInRing(p, ring)) inside++;
            return inside >= 3;
        },

        /**
         * Even-odd ray cast. Local (not GeometryUtils.pointInPolygon) so the
         * containment test can never silently degrade to "always true" when
         * the helper module is absent.
         */
        pointInRing(pt, ring) {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const yi = ring[i].y, yj = ring[j].y;
                if ((yi > pt.y) !== (yj > pt.y)) {
                    const xInt = ring[i].x + (pt.y - yi) / (yj - yi) * (ring[j].x - ring[i].x);
                    if (pt.x < xInt) inside = !inside;
                }
            }
            return inside;
        },

        /** Plain closed floor perimeter (fallback when stitching is not possible). */
        closedPerimeter(loop, zFloor) {
            if (!loop || loop.length < 3) return null;
            const pts = loop.map(p => ({ x: p.x, y: p.y, z: zFloor }));
            pts.push({ ...pts[0] });
            return pts;
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 5 - Depth mapping → PathPrimitives
        // ═══════════════════════════════════════════════════════════

        chainsToPrimitives(chains, tanHalf, startDepth, maxDepth, minChainLength, tipRadius = 0) {
            const zOf = (t) => -(startDepth + Math.max(0, t - tipRadius) / tanHalf);
            const zFloor = (maxDepth !== null) ? -maxDepth : null;

            // Sanity guard: tip flat swallowing the whole skeleton.
            let deepestT = 0;
            for (const chain of chains) {
                for (const n of chain) if (n.t > deepestT) deepestT = n.t;
            }
            if (tipRadius > 0 && deepestT > 0 && deepestT <= tipRadius) {
                console.warn(
                    `[VCarveGenerator] tipRadius ${tipRadius.toFixed(3)}mm ≥ deepest ` +
                    `clearance ${deepestT.toFixed(3)}mm - ALL centerlines will emit at ` +
                    `Z0 (surface). Verify toolDiameter is the V-bit TIP flat diameter, ` +
                    `not the cutting diameter.`
                );
            }

            // Split a chain at _claimed nodes (spine owned by a floor stitch),
            // but KEEP the boundary nodes in the neighbouring runs.
            //
            // The claimed nodes sit ON the tClamp isoline, which IS the floor
            // perimeter. The old exclusive split ended the V-groove ramp one
            // sample SHORT of the floor and started the next run one sample
            // past it: a permanently uncut wedge at every flat-zone entry.
            // Those are the "random gaps" - random because they only appear
            // where a chain happens to cross tClamp.
            //
            // `seg.split` marks a fragment produced by a split so emitChain
            // never length-filters it away (a 0.3mm fragment of a 40mm chain
            // is not a stub, it is the tail of a real cut).
            const splitUnclaimed = (chain) => {
                const segs = [];
                let cur = null;
                let sawClaimed = false;
                for (let i = 0; i < chain.length; i++) {
                    const n = chain[i];
                    if (n._claimed) {
                        sawClaimed = true;
                        if (cur) { cur.push(n); cur = null; }   // close ON the boundary node
                        continue;
                    }
                    if (!cur) {
                        cur = [];
                        const prev = chain[i - 1];
                        if (prev && prev._claimed) cur.push(prev); // re-open ON the boundary node
                        segs.push(cur);
                    }
                    cur.push(n);
                }
                if (sawClaimed) for (const s of segs) s.split = true;
                return segs;
            };

            const emitChain = (chain, out) => {
                if (chain.length < 2) return;
                // minChainLength is a NOISE filter for whole chains. A fragment
                // handed to us by splitUnclaimed is part of a longer cut and is
                // never noise, however short it is.
                if (minChainLength > 0 && !chain.split) {
                    let l = 0;
                    for (let i = 1; i < chain.length; i++) {
                        l += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
                    }
                    if (l < minChainLength) return;
                }

                const points = [];
                let prev = null;
                for (const node of chain) {
                    let z = zOf(node.t);
                    if (zFloor !== null && prev !== null) {
                        const zPrev = zOf(prev.t);
                        const prevClamped = zPrev < zFloor;
                        const currClamped = z < zFloor;
                        if (prevClamped !== currClamped && Math.abs(z - zPrev) > T_EPS) {
                            const f = (zFloor - zPrev) / (z - zPrev);
                            points.push({
                                x: prev.x + f * (node.x - prev.x),
                                y: prev.y + f * (node.y - prev.y),
                                z: zFloor
                            });
                        }
                    }
                    if (zFloor !== null && z < zFloor) z = zFloor;
                    points.push({ x: node.x, y: node.y, z });
                    prev = node;
                }
                if (points.length < 2) return;

                const properties = {
                    isVCarve: true,
                    is3DContour: true,
                    role: 'vcarve_path',
                    vcarvePass: chain.split ? 'groove-split' : 'groove',
                    stroke: true,
                    fill: false,
                    strokeWidth: 0
                };

                if (typeof Polyline3DPrimitive !== 'undefined') {
                    out.push(Polyline3DPrimitive.fromPoints(points, properties));
                    return;
                }
                const contour = {
                    points, closed: false, isHole: false,
                    nestingLevel: 0, parentId: null,
                    arcSegments: [], curveIds: []
                };
                out.push(typeof PathPrimitive !== 'undefined'
                    ? new PathPrimitive([contour], properties)
                    : { type: 'path', contours: [contour], properties });
            };

            const out = [];
            for (const chain of chains) {
                for (const sub of splitUnclaimed(chain)) emitChain(sub, out);
            }
            return out;
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[VCarveGenerator] ${message}`, data)
                 : console.log(`[VCarveGenerator] ${message}`);
        }
    };

    ROOT.VCarveGenerator = VCarveGenerator;
})();