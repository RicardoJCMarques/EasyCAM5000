/*!
 * @file        geometry/geometry-utils-vcarve.js
 * @description Medial-axis generator for V-Carve toolpaths (3D centerline
 *              paths). The axis is the Voronoi dual of a Delaunay
 *              triangulation of densely sampled boundary points.
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
    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    const T_EPS = 1e-7;
    const DEG_EPS = 1e-12;

    // field-worker installs its CAMConfig snapshot before importScripts and
    // MUTATES it per job, so the C / D / debugState captures above stay live
    // in the worker. Everything else derived from C.vcarve is read at its
    // call site; only what more than one stage needs is hoisted here.
    const RESAMPLE_KEEP_RAD = C.vcarve.resampleCornerAngle * Math.PI / 180;

    // Arc endpoints naming one circumcentre are bit-identical, so the
    // graph key only has to reject numerical noise. A coordinate-scale
    // grid merges points that are genuinely apart.
    const NODE_SNAP = 0.001 * PRECISION;

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
         *   minChainLength    {number} drop output chains shorter than this (default 0 = keep all)
         *   tipRadius         {number} V-bit tip flat radius (default 0)
         *   cornerAngle       {number} boundary turn threshold in degrees (default 30)
         *   sampleSpacing     {number} boundary resampling step in mm (default 0.15)
         * @returns {Array} PathPrimitive-like objects with {x,y,z} points
         */
        generateVCarvePaths(primitive, options = {}) {
            const vbitAngle = options.vbitAngle || 90;
            const startDepth = Math.max(0, options.startDepth || 0);
            const maxDepth = (options.maxDepth !== undefined && options.maxDepth !== null && options.maxDepth > 0)
                ? Math.abs(options.maxDepth) : null;
            const minChainLength = options.minChainLength || 0;
            const tipRadius = Math.max(0, options.tipRadius || 0);
            const cornerAngle = options.cornerAngle ?? 30;
            const noiseThreshold = Math.max(0, options.noiseThreshold || 0);

            const tanHalf = Math.tan((vbitAngle * Math.PI / 180) / 2);
            if (!(tanHalf > DEG_EPS)) {
                console.error(`[VCarveGenerator] Invalid V-bit angle: ${vbitAngle}`);
                return [];
            }

            options.onProgress?.({ frac: 0.05, label: 'V-Carve: contours' });
            const contours = this.prepareContours(primitive);
            if (contours.length === 0) {
                this.debug('No usable contours after preparation');
                return [];
            }

            const { tClamp, maxDepth: effMaxDepth } = VCarveGenerator.resolveDepthLimit({
                vbitAngle, startDepth, maxDepth, tipRadius, maxCutRadius: options.maxCutRadius
            });
            const floorLoops = (tClamp !== null && Array.isArray(options.floorLoops)) ? options.floorLoops : [];
            const spacing = Math.max(10 * PRECISION, options.sampleSpacing || 0.15);
            const zFloor = (effMaxDepth !== null) ? -effMaxDepth : null;

            // FAST PATH: Single-contour geometric circles / segmented circles
            if (1 === contours.length && !contours[0].isHole) {
                const circleInfo = this.detectCircleLike(contours[0].points);
                if (circleInfo) {
                    this.debug(`Circle detected geometrically: R=${circleInfo.radius.toFixed(3)}mm at (${circleInfo.center.x.toFixed(3)}, ${circleInfo.center.y.toFixed(3)})`);
                    const chains = [];
                    const floorPaths = [];
                    // If circle radius exceeds floor clamp, generate circular floor loop; otherwise single plunge
                    if (null !== tClamp && circleInfo.radius > tClamp && floorLoops.length > 0) {
                        const floorProps = {
                            isVCarve: true,
                            is3DContour: true,
                            role: "vcarve_path",
                            vcarvePass: "floor-perimeter",
                            ridgeRisk: circleInfo.radius > 2 * tClamp,
                            isHole: false,
                            stitched: false,
                            stroke: true,
                            fill: false,
                            strokeWidth: 0
                        };
                        const denseLoop = this.resampleClosed(floorLoops[0].points || floorLoops[0], spacing).points;
                        const pts = this.closedPerimeter(denseLoop, zFloor);
                        pts && pts.length >= 3 && floorPaths.push(this.makePath3D(pts, floorProps));
                    } else if (circleInfo.radius > tipRadius) {
                        chains.push([
                            { x: circleInfo.center.x, y: circleInfo.center.y, t: 0 },
                            { x: circleInfo.center.x, y: circleInfo.center.y, t: circleInfo.radius }
                        ]);
                    }
                    const out = this.chainsToPrimitives(chains, tanHalf, startDepth, effMaxDepth, minChainLength, tipRadius);
                    out.push(...floorPaths);
                    return out;
                }
            }

            // GENERAL PATH: Voronoi Medial Axis (Delaunator)
            options.onProgress?.({ frac: 0.15, label: 'V-Carve: medial axis' });
            const { arcs, field } = this.computeMedialAxis(contours, {
                cornerAngleRad: cornerAngle * Math.PI / 180,
                sampleSpacing: spacing
            });

            this.debug(`Skeleton: ${arcs.length} arc(s), ${floorLoops.length} floor loop(s) from ${contours.length} contour(s)`);
            if (arcs.length === 0 && floorLoops.length === 0) return [];

            const graph = this.buildArcGraph(arcs);
            let prunedArcs = this.pruneSkeleton(arcs, { noiseThreshold, graph });

            const branchLengthFloor = C.vcarve.branchLengthFactor * spacing;
            const branchDepthFloor = C.vcarve.branchDepthFactor * spacing;
            prunedArcs = this.pruneShortBranches(prunedArcs, {
            lengthFloor: branchLengthFloor,
            depthFloor: branchDepthFloor,
            tipFloor: tipRadius,
            sampleSpacing: spacing
            });
            let chains = this.chainArcs(prunedArcs);

            // Component rescue: if a sub-tool speck or isolated round dot lost all arcs, emit center plunge
            const survivors = new Set(prunedArcs);
            const aliveComponents = new Set();
            for (let i = 0; i < arcs.length; i++) {
                if (survivors.has(arcs[i])) aliveComponents.add(graph.ends[i].a.component);
            }
            const deepestLost = new Map();
            for (const n of graph.nodes.values()) {
                if (aliveComponents.has(n.component) || n.t <= tipRadius) continue;
                const best = deepestLost.get(n.component);
                if (!best || n.t > best.t) deepestLost.set(n.component, n);
            }
            for (const n of deepestLost.values()) {
                chains.push([{ x: n.x, y: n.y, t: 0 }, { x: n.x, y: n.y, t: n.t }]);
            }
            if (deepestLost.size > 0) {
                this.debug(`Rescued ${deepestLost.size} fully-pruned component(s) as centre plunge(s)`);
            }

            chains = this.smoothChainClearance(chains, { passes: C.vcarve.clearanceSmoothPasses, field });
            
            this.debug(`Chained into ${chains.length} continuous path(s)`);

            // Flat-zone coverage
            const floorPaths = [];
            if (floorLoops.length > 0) {
                const spineEps = T_EPS;
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

                const normalized = floorLoops.map(l => Array.isArray(l)
                    ? { points: l, isHole: false }
                    : { points: l.points || [], isHole: true === l.isHole });

                const floorProps = (pass, extra) => ({
                    isVCarve: true,
                    is3DContour: true,
                    role: 'vcarve_path',
                    vcarvePass: pass,
                    stroke: true,
                    fill: false,
                    strokeWidth: 0,
                    ...extra
                });

                for (const loop of normalized) {
                    const denseLoop = this.resampleClosed(loop.points, spacing).points;
                    if (denseLoop.length < 4) continue;
                    const insideRuns = [];
                    if (!loop.isHole) {
                        for (const run of spineRuns) {
                            if (!(run.length < 2 || run._claimed) && this.runInsideLoop(run, denseLoop)) {
                                run._len = this.polylineLength(run);
                                insideRuns.push(run);
                            }
                        }
                        insideRuns.sort((a, b) => b._len - a._len);
                    }

                    let loopMaxT = 0;
                    for (const run of insideRuns) for (const n of run) if (n.t > loopMaxT) loopMaxT = n.t;
                    const ridgeRisk = loopMaxT > 2 * tClamp + T_EPS;
                    const spine = insideRuns[0] || null;
                    const stitched = spine ? this.stitchFloorRegion(denseLoop, spine, zFloor, 2 * spacing) : null;
                    const pts = stitched || this.closedPerimeter(denseLoop, zFloor);
                    if (pts && !(pts.length < 3)) {
                        floorPaths.push(this.makePath3D(pts, floorProps('floor-perimeter', { ridgeRisk, isHole: loop.isHole, stitched: null !== stitched })));
                        for (let r = stitched ? 1 : 0; r < insideRuns.length; r++) {
                            const run = insideRuns[r];
                            if (run._len >= PRECISION) {
                                floorPaths.push(this.makePath3D(run.map(n => ({ x: n.x, y: n.y, z: zFloor })), floorProps('floor-spine', { ridgeRisk, isHole: false, stitched: false })));
                            }
                        }
                        for (const run of insideRuns) {
                            for (const node of run) node._claimed = true;
                            run._claimed = true;
                        }
                    }
                }
            }

            options.onProgress?.({ frac: 0.85, label: "V-Carve: emitting chains" });
            const out = this.chainsToPrimitives(chains, tanHalf, startDepth, effMaxDepth, minChainLength, tipRadius);
            out.push(...floorPaths);
            return out;
        },

        // ═══════════════════════════════════════════════════════════
        // Geometric Detection Helpers
        // ═══════════════════════════════════════════════════════════════

        /**
         * Fits a circle to a closed loop and returns it when the loop IS
         * that circle to within tolerance, else null.
         * 
         * The fit is algebraic over the loop's own points. A vertex MEAN is
         * the circle centre only for samples uniform in ANGLE, and a
         * pre-segmented arc source is not - bezier flattening and mixed
         * line/arc runs cluster vertices, and the bias then reads as radial
         * deviation and rejects the circle.
         * 
         * Deviation is measured at vertices AND edge midpoints: an inscribed
         * n-gon passes through the fit at every vertex and misses it by the
         * sagitta in between, so the midpoints are what separate a circle
         * from a coarse polygon.
         * 
         * The radial band is the aspect gate and nothing here may scale with
         * sampleSpacing: |dr| <= tau*R accepts exactly a/b <= (1+tau)/(1-tau),
         * while a spacing floor makes the same test absolute (a - b <= 2*spacing)
         * and independent of size. A near-circular ellipse's medial slit runs
         * ~4*(a - b), eight times the deviation it is measured by, so a miss
         * the fit rejects is always something the axis can resolve.
         * 
         * @param {Array<{x,y}>} points closed loop, no closing duplicate
         */
        // REVIEW - Could this be expanded to detect/collapse excess geometry in arcs? Semi-circular sections?
        detectCircleLike(points) {
            const n = points.length;
            if (n < 6) return null;

            let area = 0, perim = 0;
            for (let i = 0; i < n; i++) {
                const p1 = points[i], p2 = points[(i + 1) % n];
                area += p1.x * p2.y - p2.x * p1.y;
                perim += Math.hypot(p2.x - p1.x, p2.y - p1.y);
            }
            area = Math.abs(area) / 2;
            if (area < PRECISION * PRECISION || perim < PRECISION) return null;

            // Isoperimetric prefilter - rejects rectangles and stars before
            // the fit is worth paying for. Loose on purpose; the radial band
            // below is the gate that decides.
            if (4 * Math.PI * area / (perim * perim) < 0.92) return null;

            const fit = this.fitCircle(points);
            if (!fit) return null;

            // Absolute floor is the coordinate grid, not the sample step:
            // at R = 0.3mm a purely relative band is three quantisation units.
            const tol = Math.max(2 * PRECISION, C.vcarve.circleTolerance * fit.radius);
            for (let i = 0; i < n; i++) {
                const p1 = points[i], p2 = points[(i + 1) % n];
                if (Math.abs(Math.hypot(p1.x - fit.cx, p1.y - fit.cy) - fit.radius) > tol) return null;
                const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
                if (Math.abs(Math.hypot(mx - fit.cx, my - fit.cy) - fit.radius) > tol) return null;
            }
            return { center: { x: fit.cx, y: fit.cy }, radius: fit.radius };
        },

        /**
         * Kasa algebraic circle fit: minimises the linear least-squares of
         * (x^2 + y^2 - 2*cx*x - 2*cy*y - k)^2. Coordinates are centred on
         * the vertex mean first so the normal equations stay conditioned
         * for loops far from the origin. Radius is the mean sample distance
         * from the fitted centre. Returns null on a collinear system.
         */
        fitCircle(points) {
            const n = points.length;
            let mx = 0, my = 0;
            for (const p of points) { mx += p.x; my += p.y; }
            mx /= n; my /= n;

            let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
            for (const p of points) {
                const x = p.x - mx, y = p.y - my;
                const z = x * x + y * y;
                sxx += x * x; sxy += x * y; syy += y * y;
                sxz += x * z; syz += y * z;
            }
            const det = sxx * syy - sxy * sxy;
            if (Math.abs(det) < DEG_EPS) return null;

            const cx = (sxz * syy - syz * sxy) / (2 * det);
            const cy = (syz * sxx - sxz * sxy) / (2 * det);

            let r = 0;
            for (const p of points) r += Math.hypot(p.x - mx - cx, p.y - my - cy);
            return { cx: cx + mx, cy: cy + my, radius: r / n };
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 1 - Contour preparation
        // ═══════════════════════════════════════════════════════════

        prepareContours(primitive) {
            let source = primitive;
            if (primitive.type !== 'path' && typeof GeometryUtils !== 'undefined' && GeometryUtils.primitiveToPath) {
                const converted = GeometryUtils.primitiveToPath(primitive);
                if (converted?.contours?.length > 0) source = converted;
            }
            if (!source.contours || source.contours.length === 0) return [];

            const prepared = [];
            for (const rawContour of source.contours) {
                // GeometryTessellation is main-thread-only today: this file runs
                // both in the worker and as the sync fallback, so the probe is
                // load-context detection, not a load-order guard.
                // REVIEW - GeometryTessellation is already worker safe and in the importScripts list
                const contour = rawContour.arcSegments?.length && typeof GeometryTessellation !== 'undefined' && GeometryTessellation.contourArcsToPath
                    ? GeometryTessellation.contourArcsToPath(rawContour)
                    : rawContour;

                let pts = (contour.points || []).map(p => ({ x: p.x, y: p.y }));
                if (pts.length < 3) continue;

                // Drop closing duplicate
                if (Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < PRECISION) {
                    pts.pop();
                }
                // Dedupe consecutive points
                pts = pts.filter((p, i) => {
                    if (i === 0) return true;
                    const q = pts[i - 1];
                    return Math.hypot(p.x - q.x, p.y - q.y) >= PRECISION;
                });
                if (pts.length < 3) continue;

                const isHole = true === contour.isHole;
                const area = this.signedArea(pts);
                if (Math.abs(area) < PRECISION * PRECISION) {
                    this.debug(`prepareContours: dropped ${isHole ? 'HOLE' : 'outer'} contour - degenerate area`);
                    continue;
                }
                // CCW outer / CW hole puts the material on the LEFT of every
                // ring. That is what makes the left-hand normal the inward
                // one and a positive signed turn a convex MATERIAL corner -
                // computeMedialAxis's spoke pass reads both, and on a
                // CW-wound ring it silently picks the reflex vertices and
                // fires the bisector out of the part.
                if ((area < 0) !== isHole) pts.reverse();
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

        polylineLength(pts) {
            let l = 0;
            for (let i = 1; i < pts.length; i++) {
                l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
            }
            return l;
        },

        makePath3D: (points, properties) =>
            typeof Polyline3DPrimitive !== 'undefined'
                ? Polyline3DPrimitive.fromPoints(points, properties)
                : typeof PathPrimitive !== 'undefined'
                    ? new PathPrimitive([{ points, closed: false, isHole: false, nestingLevel: 0, parentId: null, arcSegments: [], curveIds: [] }], properties)
                    : { type: 'path', contours: [{ points, closed: false }], properties },

        // ═══════════════════════════════════════════════════════════
        // Stage 2 - Delaunay-based medial axis (Voronoi engine)
        // ═══════════════════════════════════════════════════════════

        /**
         * The V-carve floor is set by TWO independent limits and the tighter
         * one wins:
         *
         *   user   - vcarveMaxDepth, the depth the operator asked not to pass
         *   tool   - the clearance the bit can physically reach, from its
         *            widest cutting radius and its flute length
         *
         * @returns {{tClamp: ?number, maxDepth: ?number}} clearance at which
         *          the bit bottoms out, and the matching depth. Both null only
         *          when neither limit exists.
         */
        resolveDepthLimit(opts = {}) {
            const vbitAngle = opts.vbitAngle || 90;
            const startDepth = Math.max(0, opts.startDepth || 0);
            const tipRadius = Math.max(0, opts.tipRadius || 0);
            const tanHalf = Math.tan((vbitAngle * Math.PI / 180) / 2);
            if (!(tanHalf > DEG_EPS)) return { tClamp: null, maxDepth: null };

            const userDepth = (opts.maxDepth != null && opts.maxDepth > 0) ? Math.abs(opts.maxDepth) : null;
            const userClamp = (userDepth !== null && userDepth > startDepth)
                ? (userDepth - startDepth) * tanHalf + tipRadius
                : null;

            const toolClamp = (opts.maxCutRadius && opts.maxCutRadius > tipRadius) ? opts.maxCutRadius : null;

            let tClamp = null;
            if (userClamp !== null && toolClamp !== null) tClamp = Math.min(userClamp, toolClamp);
            else tClamp = userClamp !== null ? userClamp : toolClamp;
            if (tClamp === null) return { tClamp: null, maxDepth: null };

            return { tClamp, maxDepth: startDepth + (tClamp - tipRadius) / tanHalf };
        },

        /**
         * Uniform-grid index over every boundary segment of every ring.
         * Clearance is queried at the point it is USED, never inferred from a
         * ring-index neighbourhood of the triangle it came from: a needle
         * triangle's circumcentre sits far from its own three vertices, and a
         * pool anchored to those vertices reports the distance back to them
         * rather than the local half-width. t drives Z directly, so that
         * over-estimate is a plunge.
         * Exactness buys the rest for free - a true distance function is
         * 1-Lipschitz, so no chain step can jump in Z faster than it moves in
         * XY, and a node that is off the medial ridge under-cuts by a hair
         * instead of gouging.
         */
        buildClearanceField(coords, cBase, cCount, spacing) {
            const nSeg = coords.length >> 1;
            const segA = new Int32Array(nSeg);
            const segB = new Int32Array(nSeg);
            let w = 0;
            for (let ci = 0; ci < cBase.length; ci++) {
                const base = cBase[ci], m = cCount[ci];
                for (let i = 0; i < m; i++) {
                    segA[w] = base + i;
                    segB[w] = base + (i + 1) % m;
                    w++;
                }
            }

            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < coords.length; i += 2) {
                const x = coords[i], y = coords[i + 1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }

            let cell = Math.max(C.vcarve.clearanceGridCell * spacing, 10 * PRECISION);
            let cols = 1, rows = 1;
            for (;;) {
                cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
                rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
                if (cols * rows <= 1 << 20) break;
                cell *= 2;
            }
            const nCell = cols * rows;
            const start = new Int32Array(nCell + 1);
            const box = new Int32Array(4);
            const spanOf = (s) => {
                const ga = segA[s], gb = segB[s];
                const ax = coords[2 * ga], ay = coords[2 * ga + 1];
                const bx = coords[2 * gb], by = coords[2 * gb + 1];
                box[0] = Math.min(cols - 1, Math.max(0, Math.floor((Math.min(ax, bx) - minX) / cell)));
                box[1] = Math.min(cols - 1, Math.max(0, Math.floor((Math.max(ax, bx) - minX) / cell)));
                box[2] = Math.min(rows - 1, Math.max(0, Math.floor((Math.min(ay, by) - minY) / cell)));
                box[3] = Math.min(rows - 1, Math.max(0, Math.floor((Math.max(ay, by) - minY) / cell)));
            };
            for (let s = 0; s < nSeg; s++) {
                spanOf(s);
                for (let gy = box[2]; gy <= box[3]; gy++)
                    for (let gx = box[0]; gx <= box[1]; gx++) start[gy * cols + gx + 1]++;
            }
            for (let c = 0; c < nCell; c++) start[c + 1] += start[c];
            const items = new Int32Array(start[nCell]);
            const cursor = Int32Array.from(start.subarray(0, nCell));
            for (let s = 0; s < nSeg; s++) {
                spanOf(s);
                for (let gy = box[2]; gy <= box[3]; gy++)
                    for (let gx = box[0]; gx <= box[1]; gx++) items[cursor[gy * cols + gx]++] = s;
            }

            let hx = 0, hy = 0;
            const segDist = (px, py, s) => {
                const ga = segA[s], gb = segB[s];
                const ax = coords[2 * ga], ay = coords[2 * ga + 1];
                const bx = coords[2 * gb], by = coords[2 * gb + 1];
                const dx = bx - ax, dy = by - ay;
                const l2 = dx * dx + dy * dy;
                let u = l2 > DEG_EPS ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
                u = u < 0 ? 0 : u > 1 ? 1 : u;
                hx = ax + u * dx;
                hy = ay + u * dy;
                return Math.hypot(px - hx, py - hy);
            };

            const rMax = cols + rows;
            const field = { cell, hitX: 0, hitY: 0 };

            field.clearance = (px, py) => {
                const gx0 = Math.min(cols - 1, Math.max(0, Math.floor((px - minX) / cell)));
                const gy0 = Math.min(rows - 1, Math.max(0, Math.floor((py - minY) / cell)));
                let best = Infinity;
                for (let r = 0; r <= rMax; r++) {
                    if (best < Infinity && (r - 1) * cell >= best) break;
                    for (let gy = gy0 - r; gy <= gy0 + r; gy++) {
                        if (gy < 0 || gy >= rows) continue;
                        const edge = gy === gy0 - r || gy === gy0 + r;
                        for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
                            if (gx < 0 || gx >= cols) continue;
                            if (!edge && gx !== gx0 - r && gx !== gx0 + r) continue;
                            const c = gy * cols + gx;
                            for (let k = start[c]; k < start[c + 1]; k++) {
                                const d = segDist(px, py, items[k]);
                                if (d < best) { best = d; field.hitX = hx; field.hitY = hy; }
                            }
                        }
                    }
                }
                return best;
            };

            // Nearest segment whose contact normal is at least minSepSq off n1.
            // Ranking by distance alone picks the segments meeting at a shared
            // sample, which return the SAME contact point and define no ridge.
            field.secondContact = (px, py, n1x, n1y, minSepSq, maxDist) => {
                const gx0 = Math.min(cols - 1, Math.max(0, Math.floor((px - minX) / cell)));
                const gy0 = Math.min(rows - 1, Math.max(0, Math.floor((py - minY) / cell)));
                let best = maxDist, found = false;
                for (let r = 0; r <= rMax; r++) {
                    if ((r - 1) * cell >= best) break;
                    for (let gy = gy0 - r; gy <= gy0 + r; gy++) {
                        if (gy < 0 || gy >= rows) continue;
                        const edge = gy === gy0 - r || gy === gy0 + r;
                        for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
                            if (gx < 0 || gx >= cols) continue;
                            if (!edge && gx !== gx0 - r && gx !== gx0 + r) continue;
                            const c = gy * cols + gx;
                            for (let k = start[c]; k < start[c + 1]; k++) {
                                const d = segDist(px, py, items[k]);
                                if (!(d > DEG_EPS) || d >= best) continue;
                                const ex = n1x - (px - hx) / d;
                                const ey = n1y - (py - hy) / d;
                                if (ex * ex + ey * ey < minSepSq) continue;
                                best = d; found = true;
                                field.hitX = hx; field.hitY = hy;
                            }
                        }
                    }
                }
                return found ? best : Infinity;
            };

            return field;
        },

        /**
         * Uniform arc-length resampling of a closed loop.
         *
         * Input density is a Clipper/arc-reconstruction contract
         * (geometry.segments.targetLength = 0.01mm, minArc = 200), so a
         * curved wall arrives 5-15x denser than sampleSpacing. Subdividing
         * without decimating carries that into Delaunay, where a smooth
         * wall becomes a fan of near-cocircular slivers.
         *
         * A vertex is kept verbatim only when it is a corner AT THE SAMPLE
         * SCALE: past cornerKeepRad AND owning at least cornerTurnShare of
         * the absolute turn within one `spacing` of arc length each side.
         * The window accumulates a neighbour's turn ONLY while that
         * neighbour lies inside the arc-length budget - the budget is
         * checked BEFORE the turn is added, so a vertex a full edge away is
         * never counted. Without that ordering a polygon corner sums its
         * two neighbours' full turns and fails its own test (a square then
         * loses all four corners).
         *
         * Kept corners anchor the sampling: each run between two of them is
         * divided into an integer number of equal steps, so an edge lands in
         * roughly [0.67, 1.5] * spacing everywhere and no run ends against a
         * fractional remnant.
         *
         * @returns {{points: Array<{x,y}>, kept: Uint8Array}} kept[i] is 1
         *   when points[i] is an input corner, 0 when interpolated or a
         *   non-corner input vertex. Only a kept sample may carry a spoke.
         */
        resampleClosed(points, spacing) {
            const n = points.length;
            if (n < 3) return { points: points.map(p => ({ x: p.x, y: p.y })), kept: new Uint8Array(n).fill(1) };
            const share = C.vcarve.cornerTurnShare;
            const win = Math.max(C.vcarve.cornerWindow * spacing, spacing);
            const sTurn = new Float64Array(n);
            const absTurn = new Float64Array(n);
            const segLen = new Float64Array(n); // length of edge i -> i+1

            for (let i = 0; i < n; i++) {
                const p0 = points[(i - 1 + n) % n], p1 = points[i], p2 = points[(i + 1) % n];
                const ux = p1.x - p0.x, uy = p1.y - p0.y;
                const vx = p2.x - p1.x, vy = p2.y - p1.y;
                const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
                segLen[i] = lv;
                if (lu < DEG_EPS || lv < DEG_EPS) continue;
                sTurn[i] = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
                absTurn[i] = Math.abs(sTurn[i]);
            }

            const keep = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                if (absTurn[i] < RESAMPLE_KEEP_RAD) continue;
                let signed = sTurn[i], total = absTurn[i], dominant = true;

                // Back: edge (j-1 -> j) is the arc distance to vertex j-1. The
                // budget is checked BEFORE the neighbour is counted, so a vertex
                // outside the window contributes nothing and does not suppress.
                let arc = 0, j = i;
                for (let g = 0; g < n; g++) {
                    const e = (j - 1 + n) % n;
                    arc += segLen[e];
                    if (arc > win) break;
                    if (absTurn[e] > absTurn[i]) { dominant = false; break; }
                    signed += sTurn[e]; total += absTurn[e]; j = e;
                }
                if (!dominant) continue;

                arc = 0; j = i;
                for (let g = 0; g < n; g++) {
                    arc += segLen[j];
                    if (arc > win) break;
                    const f = (j + 1) % n;
                    if (absTurn[f] >= absTurn[i]) { dominant = false; break; }
                    signed += sTurn[f]; total += absTurn[f]; j = f;
                }
                if (!dominant) continue;

                // Net signed turn across the window
                if (Math.abs(signed) < RESAMPLE_KEEP_RAD) continue;
                if (absTurn[i] < share * total) continue;
                keep[i] = 1;
            }

            const out = [];
            const outKeep = [];
            const pushPt = (x, y, isCorner) => {
                const q = out[out.length - 1];
                if (!q || Math.hypot(x - q.x, y - q.y) >= PRECISION) {
                    out.push({ x, y });
                    outKeep.push(isCorner ? 1 : 0);
                }
            };

            // Arc length walking forward from a to b. a === b is the full ring.
            const runLength = (a, b) => {
                let L = 0, i = a;
                do { L += segLen[i]; i = (i + 1) % n; } while (i !== b);
                return L;
            };

            // Places k * (L / steps) along the run, so the LAST edge of the run
            // is the same length as the rest. A running remainder instead leaves
            // an arbitrary fraction of `spacing` against the far anchor, so a few
            // percent of corners get a boundary sample sitting almost on top of
            // them and Delaunator answers that with needle triangles.
            const emitRun = (a, b) => {
                pushPt(points[a].x, points[a].y, keep[a] === 1);
                const L = runLength(a, b);
                if (L < PRECISION) return;
                const steps = Math.max(1, Math.round(L / spacing));
                const step = L / steps;
                let i = a, walked = 0;
                for (let k = 1; k < steps; k++) {
                    const target = k * step;
                    let guard = n;
                    while (guard-- > 0 && walked + segLen[i] < target - PRECISION) {
                        walked += segLen[i];
                        i = (i + 1) % n;
                    }
                    const seg = segLen[i];
                    const f = seg > PRECISION ? (target - walked) / seg : 0;
                    const p = points[i], q = points[(i + 1) % n];
                    pushPt(p.x + f * (q.x - p.x), p.y + f * (q.y - p.y), false);
                }
            };

            const anchors = [];
            for (let i = 0; i < n; i++) if (keep[i]) anchors.push(i);
            if (anchors.length === 0) {
                // No corner to anchor to, so the seam is arbitrary and the whole
                // ring divides as one run. Three samples minimum or Delaunator
                // has no interior to triangulate.
                let L = 0;
                for (let i = 0; i < n; i++) L += segLen[i];
                const steps = Math.max(3, Math.round(L / spacing));
                const step = L / steps;
                let i = 0, walked = 0;
                for (let k = 0; k < steps; k++) {
                    const target = k * step;
                    let guard = n;
                    while (guard-- > 0 && walked + segLen[i] < target - PRECISION) {
                        walked += segLen[i];
                        i = (i + 1) % n;
                    }
                    const seg = segLen[i];
                    const f = seg > PRECISION ? (target - walked) / seg : 0;
                    const p = points[i], q = points[(i + 1) % n];
                    pushPt(p.x + f * (q.x - p.x), p.y + f * (q.y - p.y), false);
                }
            } else {
                for (let a = 0; a < anchors.length; a++) emitRun(anchors[a], anchors[(a + 1) % anchors.length]);
            }

            if (out.length > 2) {
                const f = out[0], l = out[out.length - 1];
                if (Math.hypot(f.x - l.x, f.y - l.y) < PRECISION) {
                    out.pop();
                    outKeep.pop();
                }
            }
            return { points: out, kept: Uint8Array.from(outKeep) };
        },

        computeMedialAxis(contours, opts = {}) {
            const cornerRad = opts.cornerAngleRad ?? (30 * Math.PI / 180);
            // Corner-hood is a tessellation-noise scale, not a detail knob:
            // one threshold has to gate which boundary VERTICES are kept
            // verbatim AND which may fire a spoke, or a corner is preserved
            // geometrically and never ramped and the chain stops short of the
            // surface. cornerAngleRad is the unrelated contact-separation gate
            // for construction ribs below; folding it in here drags corner-hood
            // down with a low detail setting and fires spokes off chord noise.
            const spokeSpan = C.vcarve.spokeSearchSpan;
            const spokeRayMinCos = Math.cos(C.vcarve.cornerRayMaxAngle * Math.PI / 180);
            const ridgeMaxSteps = C.vcarve.ridgeMaxSteps;
            const ridgeMinSep = C.vcarve.ridgeMinSeparation;
            const ridgeMinSepSq = ridgeMinSep * ridgeMinSep;
            const spacing = Math.max(10 * PRECISION, opts.sampleSpacing || .15);
            const arcs = [];
            if (typeof Delaunator === 'undefined') throw new Error('Delaunator missing (vendor/delaunator.min.js must load before geometry-utils-vcarve.js)');

            const coords = [];
            const sContour = [];
            const sIndex = [];
            const isVertex = []; // 1 = input vertex, 0 = resampler-inserted
            const cCount = [];
            const cBase = [];
            const polys = [];
            for (const contour of contours) {
                const rs = this.resampleClosed(contour.points, spacing);
                const ring = rs.points;
                if (ring.length < 3) continue;
                const ci = polys.length;
                cBase.push(sContour.length);
                polys.push(ring);
                cCount.push(ring.length);
                for (let i = 0; i < ring.length; i++) {
                    sContour.push(ci);
                    sIndex.push(i);
                    isVertex.push(rs.kept[i]);
                    coords.push(ring[i].x, ring[i].y);
                }
            }
            const N = sContour.length;
            if (N < 3) return { arcs, field: null };

            const field = this.buildClearanceField(coords, cBase, cCount, spacing);

            const polyBB = polys.map(ring => {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const p of ring) {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                }
                const pad = 2 * spacing;
                return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
            });

            // Signed turn angle (CCW outer in Y-up: convex corners > 0, reflex corners < 0)
            const turn = new Float64Array(N);
            {
                let base = 0;
                for (const ring of polys) {
                    const m = ring.length;
                    for (let i = 0; i < m; i++) {
                        const p0 = ring[(i - 1 + m) % m], p1 = ring[i], p2 = ring[(i + 1) % m];
                        const ux = p1.x - p0.x, uy = p1.y - p0.y;
                        const vx = p2.x - p1.x, vy = p2.y - p1.y;
                        turn[base + i] = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
                    }
                    base += m;
                }
            }

            const del = new Delaunator(coords);
            const tri = del.triangles, half = del.halfedges;
            const nTri = tri.length / 3 | 0;
            if (nTri === 0) return { arcs, field };

            const nextHE = e => (e % 3 === 2 ? e - 2 : e + 1);
            const ekey = (a, b) => (a < b ? a * N + b : b * N + a);
            const walls = new Set();
            for (let ci = 0; ci < polys.length; ci++) {
                const base = cBase[ci], m = cCount[ci];
                for (let i = 0; i < m; i++) walls.add(ekey(base + i, base + (i + 1) % m));
            }
            const delEdges = new Set();
            for (let e = 0; e < tri.length; e++) delEdges.add(ekey(tri[e], tri[nextHE(e)]));
            let wallsMissing = 0;
            for (const w of walls) if (!delEdges.has(w)) wallsMissing++;

            const parityInside = (x, y) => {
                let inside = false;
                for (let r = 0; r < polys.length; r++) {
                    const bb = polyBB[r];
                    if (y < bb.minY || y > bb.maxY || x > bb.maxX || x < bb.minX) continue;
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
            const centroidInside = t => {
                const a = 2 * tri[3 * t], b = 2 * tri[3 * t + 1], c = 2 * tri[3 * t + 2];
                return parityInside((coords[a] + coords[b] + coords[c]) / 3, (coords[a + 1] + coords[b + 1] + coords[c + 1]) / 3);
            };
            const isWallHE = e => walls.has(ekey(tri[e], tri[nextHE(e)]));

            const inside = new Uint8Array(nTri);
            let useParity = wallsMissing > 0;
            if (!useParity) {
                const state = new Int8Array(nTri).fill(-1);
                const queue = [];
                let conflicts = 0;
                for (let e = 0; e < half.length; e++) {
                    if (half[e] !== -1) continue;
                    const t = e / 3 | 0;
                    const s = isWallHE(e) ? 1 : 0;
                    if (state[t] === -1) { state[t] = s; queue.push(t); }
                    else if (state[t] !== s) conflicts++;
                }
                while (queue.length && conflicts === 0) {
                    const t = queue.pop();
                    for (let k = 0; k < 3; k++) {
                        const e = 3 * t + k, o = half[e];
                        if (o === -1) continue;
                        const nt = o / 3 | 0;
                        const s = isWallHE(e) ? 1 ^ state[t] : state[t];
                        if (state[nt] === -1) { state[nt] = s; queue.push(nt); }
                        else if (state[nt] !== s) { conflicts++; break; }
                    }
                }
                if (conflicts > 0) useParity = true;
                else for (let t = 0; t < nTri; t++) inside[t] = (state[t] === 1 || (state[t] === -1 && centroidInside(t))) ? 1 : 0;
            }
            if (useParity) for (let t = 0; t < nTri; t++) inside[t] = centroidInside(t) ? 1 : 0;

            const ccx = new Float64Array(nTri), ccy = new Float64Array(nTri);
            const ccr = new Float64Array(nTri);
            const ccOk = new Uint8Array(nTri);
            const vertTri = Array.from({ length: N }, () => []);

            // Corner ramp from an apex to its spoke target. Clearance is the
            // exact query at every step INCLUDING the last, so the ramp arrives
            // at the target's own t by construction - there is no terminal step
            // to special-case and no linear bound to carry the tail. Parity is
            // checked per step: an off-bisector target can put the ray across a
            // notch, and the ramp would then cut air.
            const pushSpoke = (vx0, vy0, tx, ty) => {
                const dx = tx - vx0, dy = ty - vy0;
                const L = Math.hypot(dx, dy);
                if (!(L > DEG_EPS)) return false;
                const steps = Math.max(1, Math.ceil(L / spacing));
                const pending = [];
                let px0 = vx0, py0 = vy0, pt0 = 0;
                for (let k = 1; k <= steps; k++) {
                    const last = k === steps;
                    const qx = last ? tx : vx0 + (k / steps) * dx;
                    const qy = last ? ty : vy0 + (k / steps) * dy;
                    if (!last && !parityInside(qx, qy)) return false;
                    const qt = field.clearance(qx, qy);
                    pending.push({ x1: px0, y1: py0, t1: pt0, x2: qx, y2: qy, t2: qt, c: false });
                    px0 = qx; py0 = qy; pt0 = qt;
                }
                for (const a of pending) arcs.push(a);
                return true;
            };

            let ccRejected = 0, ridgeMoved = 0, ridgeCapped = 0, maxRidgeMove = 0;
            for (let t = 0; t < nTri; t++) {
                if (!inside[t]) continue;
                const ia = 2 * tri[3 * t], ib = 2 * tri[3 * t + 1], ic = 2 * tri[3 * t + 2];
                const ax = coords[ia], ay = coords[ia + 1];
                const bx = coords[ib], by = coords[ib + 1];
                const cx = coords[ic], cy = coords[ic + 1];
                const dx = bx - ax, dy = by - ay, ex = cx - ax, ey = cy - ay;
                const den = dx * ey - dy * ex;
                if (Math.abs(den) < DEG_EPS) continue;
                const bl = dx * dx + dy * dy, cl = ex * ex + ey * ey;
                const dd = .5 / den;
                const px = ax + (ey * bl - dy * cl) * dd;
                const py = ay + (dx * cl - ex * bl) * dd;
                const s1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
                const s2 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
                const s3 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
                let ok = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
                if (!ok) ok = parityInside(px, py);
                if (!ok) { ccRejected++; continue; }

                // The circumcentre is equidistant from three SAMPLE POINTS, not
                // from the walls they sit on. Between two walls of separation 2h
                // it misses the true ridge by ~s^2/(16h), alternating sides with
                // ear orientation. Move along (n1 - n2), the direction that
                // changes (d1 - d2) fastest, by the amount that zeroes it.
                // Centring only: t below is the exact clearance wherever the
                // point ends up, so an unconverged step leaves a hair of
                // material and can never over-cut.
                let rx = px, ry = py;
                let d1 = field.clearance(rx, ry);
                for (let step = 0; step < ridgeMaxSteps && d1 > DEG_EPS; step++) {
                    const n1x = (rx - field.hitX) / d1, n1y = (ry - field.hitY) / d1;
                    const d2 = field.secondContact(rx, ry, n1x, n1y, ridgeMinSepSq, 3 * d1 + field.cell);
                    if (d2 === Infinity) break;
                    const wx = n1x - (rx - field.hitX) / d2;
                    const wy = n1y - (ry - field.hitY) / d2;
                    const wl = Math.hypot(wx, wy);
                    if (!(wl > DEG_EPS)) break;
                    const cap = Math.min(.5 * spacing, .5 * d1);
                    let delta = (d2 - d1) / wl;
                    if (delta > cap) { delta = cap; ridgeCapped++; }
                    else if (delta < -cap) { delta = -cap; ridgeCapped++; }
                    rx += delta * wx / wl;
                    ry += delta * wy / wl;
                    d1 = field.clearance(rx, ry);
                    if (Math.abs(delta) < .1 * PRECISION) break;
                }
                const moved = Math.hypot(rx - px, ry - py);
                if (moved > PRECISION) ridgeMoved++;
                if (moved > maxRidgeMove) maxRidgeMove = moved;

                ccx[t] = rx; ccy[t] = ry; ccr[t] = d1; ccOk[t] = 1;
                vertTri[tri[3 * t]].push(t);
                vertTri[tri[3 * t + 1]].push(t);
                vertTri[tri[3 * t + 2]].push(t);
            }

            // Boundary turn accumulated strictly BETWEEN two contact samples,
            // the shorter way round. Two contacts on one smooth stretch of wall
            // accumulate almost nothing - that is a construction rib and
            // pruneSkeleton must be allowed to erode it. Contacts on facing
            // walls only reach each other by wrapping a cap or a corner, and
            // that wrap is the turn they accumulate. Signed on purpose: two
            // contacts either side of an S-bend in ONE wall cancel to zero,
            // which is exactly the rib case an absolute sum would preserve.
            const contactTurn = (a, b) => {
                if (sContour[a] !== sContour[b]) return Math.PI;
                const ci = sContour[a], m = cCount[ci], base = cBase[ci];
                let d = sIndex[b] - sIndex[a];
                if (d < 0) d += m;
                let from = sIndex[a], steps = d;
                if (d > m - d) { from = sIndex[b]; steps = m - d; }
                let acc = 0, i = from;
                for (let k = 1; k < steps; k++) {
                    i = (i + 1) % m;
                    acc += turn[base + i];
                }
                return Math.abs(acc);
            };

            let ribs = 0;
            for (let e = 0; e < half.length; e++) {
                const o = half[e];
                if (o < e) continue;
                const ta = e / 3 | 0, tb = o / 3 | 0;
                if (!ccOk[ta] || !ccOk[tb]) continue;
                if (isWallHE(e)) continue;
                const g1 = tri[e], g2 = tri[nextHE(e)];
                const isRib = contactTurn(g1, g2) < cornerRad;
                if (isRib) ribs++;
                arcs.push({ x1: ccx[ta], y1: ccy[ta], t1: ccr[ta], x2: ccx[tb], y2: ccy[tb], t2: ccr[tb], c: isRib });
            }

            // Corner spokes for CONVEX vertices (signed turn >= cornerRad).
            // Winding is normalized in prepareContours, so the left-hand normal
            // is the inward one on outers AND holes and the sign test means one
            // thing on both. The resampler's kept flag is the only cornerhood
            // test - it already measures dominance over a metric window, and a
            // second 1-hop test on the RESAMPLED ring is vacuous whenever the
            // run between two corners carries an interpolated sample.
            let spokes = 0, spokeMissed = 0, spokeBlocked = 0;
            for (let ci = 0; ci < polys.length; ci++) {
                const base = cBase[ci], m = cCount[ci];
                const ring = polys[ci];
                for (let i = 0; i < m; i++) {
                    const gIdx = base + i;
                    if (!isVertex[gIdx] || turn[gIdx] < RESAMPLE_KEEP_RAD) continue;
                    const p0 = ring[(i - 1 + m) % m], p1 = ring[i], p2 = ring[(i + 1) % m];
                    const ux = p1.x - p0.x, uy = p1.y - p0.y;
                    const vx = p2.x - p1.x, vy = p2.y - p1.y;
                    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
                    if (lu < DEG_EPS || lv < DEG_EPS) continue;
                    const nux = -uy / lu, nuy = ux / lu;
                    const nvx = -vy / lv, nvy = vx / lv;
                    let bx = nux + nvx, by = nuy + nvy;
                    const lb = Math.hypot(bx, by);
                    if (lb < DEG_EPS) continue;
                    bx /= lb; by /= lb;

                    // Nearest circumcentre inside the bisector cone. Ranking by
                    // alignment instead lets a node several millimetres down the
                    // stem win on cos alone. The relaxed fallback accepts a node
                    // outside the cone only when the bisector ray passes within
                    // that node's own clearance disc, so the ramp still lands in
                    // material - a plain max-projection fallback aims it at
                    // whatever happens to be furthest along the ray.
                    let bestT = -1, bestDist = Infinity;
                    let relaxT = -1, relaxDist = Infinity;
                    for (let k = -spokeSpan; k <= spokeSpan; k++) {
                        const tris = vertTri[base + ((i + k) % m + m) % m];
                        if (!tris || tris.length === 0) continue;
                        for (const tIdx of tris) {
                            const dx = ccx[tIdx] - p1.x, dy = ccy[tIdx] - p1.y;
                            const d = Math.hypot(dx, dy);
                            if (d < DEG_EPS) continue;
                            const proj = dx * bx + dy * by;
                            if (proj <= 0) continue;
                            if (proj / d >= spokeRayMinCos) {
                                if (d < bestDist) { bestDist = d; bestT = tIdx; }
                            } else if (Math.abs(dx * by - dy * bx) <= ccr[tIdx] && d < relaxDist) {
                                relaxDist = d; relaxT = tIdx;
                            }
                        }
                    }
                    if (bestT < 0) bestT = relaxT;
                    if (bestT < 0) { spokeMissed++; continue; }
                    if (pushSpoke(p1.x, p1.y, ccx[bestT], ccy[bestT])) spokes++;
                    else spokeBlocked++;
                }
            }

            // t is a distance function and therefore 1-Lipschitz: no arc can
            // change clearance faster than it moves. A nonzero count here is a
            // clearance bug upstream, and reads downstream as a Z step.
            let lipschitz = 0;
            for (const a of arcs) {
                if (Math.abs(a.t2 - a.t1) > Math.hypot(a.x2 - a.x1, a.y2 - a.y1) + 10 * PRECISION) lipschitz++;
            }

            // A wall edge Delaunay never built cannot be caught by isWallHE, so
            // arcs cross it: the two sides of a feature thinner than the sample
            // step are triangulated as one region. This is the "generator warns"
            // half of the sampleSpacing contract.
            if (wallsMissing > 0) console.warn(`[VCarveGenerator] ${wallsMissing} boundary edge(s) unrecovered at sampleSpacing ${spacing.toFixed(3)}mm - features thinner than the sample step have no wall between their sides. Lower V-Carve sample spacing.`);
            this.debug(`Medial axis: ${polys.length} contour(s), ${N} sample(s) → ${nTri} triangle(s) → ${arcs.length} arc(s) [ribs=${ribs}, ccRejected=${ccRejected}, ridgeMoved=${ridgeMoved}, ridgeCapped=${ridgeCapped}, ridgeMax=${maxRidgeMove.toFixed(4)}mm, spokes=${spokes}, spokeMissed=${spokeMissed}, spokeBlocked=${spokeBlocked}, lipschitz=${lipschitz}, wallsMissing=${wallsMissing}, parityFallback=${useParity}]`);
            return { arcs, field };
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 3 - Chain arcs into continuous polylines
        // ═══════════════════════════════════════════════════════════

        /**
         * Arc endpoints naming one circumcentre are bit-identical by
         * construction, so the key grid exists only to reject numerical noise.
         * A coordinate-scale grid merged points that were genuinely apart, and
         * the merge OVERWROTE the surviving node's position - every arc already
         * bound to it moved with it, after the fact. The t tie-break resolves
         * downward: two coincident points have one true clearance, any spread
         * between them is candidate-pool error, and taking the deeper of the
         * two turns that error into an over-cut.
         */
        buildArcGraph(arcs) {
            const key = (x, y) => `${Math.round(x / NODE_SNAP)}_${Math.round(y / NODE_SNAP)}`;
            const nodes = new Map();
            const ends = new Array(arcs.length);
            const arcLen = new Float64Array(arcs.length);
            const touch = (x, y, t) => {
                const k = key(x, y);
                let n = nodes.get(k);
                if (n) {
                    if (t < n.t) n.t = t;
                    return n;
                }
                n = { key: k, x: x, y: y, t: t, arcs: [], component: -1 };
                nodes.set(k, n);
                return n;
            };

            for (let i = 0; i < arcs.length; i++) {
                const a = arcs[i];
                const na = touch(a.x1, a.y1, a.t1);
                const nb = touch(a.x2, a.y2, a.t2);
                const loop = na === nb;
                ends[i] = { a: na, b: nb, loop };
                if (!loop) {
                    na.arcs.push({ idx: i, other: nb });
                    nb.arcs.push({ idx: i, other: na });
                }
            }

            for (let i = 0; i < arcs.length; i++) {
                const { a, b } = ends[i];
                arcLen[i] = Math.hypot(b.x - a.x, b.y - a.y);
            }

            let components = 0;
            for (const n of nodes.values()) {
                if (n.component !== -1) continue;
                const id = components++;
                n.component = id;
                const stack = [n];
                while (stack.length) {
                    const cur = stack.pop();
                    for (const e of cur.arcs) {
                        if (e.other.component === -1) {
                            e.other.component = id;
                            stack.push(e.other);
                        }
                    }
                }
            }
            return { nodes, ends, arcLen, components };
        },

        /* Splits the arc graph into maximal degree-2 runs. A chain STOPS at
         * every node that is not a through-node, so a junction is a terminal
         * point on every chain that reaches it and its position is identical
         * in all of them - nothing downstream has to protect it. Chains are
         * oriented shallow -> deep so the plunge lands at the shallow end.
         */
        chainArcs(arcs) {
            const { nodes } = this.buildArcGraph(arcs);
            const used = new Set();
            const chains = [];
            const snap = (n) => ({ x: n.x, y: n.y, t: n.t });

            // Walks out of `start` along `firstArc` until a node that is not
            // degree 2. Terminates on a closed ring because the seed arc is
            // already used by the time the walk returns to it.
            const walk = (start, firstArc) => {
            const chain = [snap(start)];
            let edge = firstArc;
            while (edge && !used.has(edge.idx)) {
                used.add(edge.idx);
                const node = edge.other;
                chain.push(snap(node));
                if (node.arcs.length !== 2) break;
                edge = node.arcs.find((e) => !used.has(e.idx)) || null;
            }
            return chain;
            };

            const seed = (n) => {
            for (const e of n.arcs) {
                if (used.has(e.idx)) continue;
                const chain = walk(n, e);
                if (chain.length > 1) chains.push(chain);
            }
            };

            for (const n of nodes.values()) if (n.arcs.length !== 2) seed(n);
            // Whatever survives is a cycle of through-nodes; open it anywhere.
            for (const n of nodes.values()) seed(n);

            for (const chain of chains) {
            if (chain[0].t > chain[chain.length - 1].t + T_EPS) chain.reverse();
            }
            return chains;
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 4 - Rib pruning & smoothing
        // ═══════════════════════════════════════════════════════════

        pruneSkeleton(arcs, opts = {}) {
            const noiseThreshold = opts.noiseThreshold || 0;
            if (!arcs || arcs.length === 0) return arcs;

            const { nodes, ends } = opts.graph || this.buildArcGraph(arcs);
            const degree = new Map();
            for (const n of nodes.values()) degree.set(n, n.arcs.length);

            const alive = new Uint8Array(arcs.length);
            for (let i = 0; i < arcs.length; i++) alive[i] = ends[i].loop ? 0 : 1;

            let changed = true;
            while (changed) {
                changed = false;
                for (let i = 0; i < arcs.length; i++) {
                    if (!alive[i]) continue;
                    const { a, b } = ends[i];
                    if (degree.get(a) !== 1 && degree.get(b) !== 1) continue;

                    const prunable = arcs[i].c === true ||
                        (noiseThreshold > 0 && Math.abs(a.t - b.t) < noiseThreshold);
                    if (!prunable) continue;

                    alive[i] = 0;
                    degree.set(a, degree.get(a) - 1);
                    degree.set(b, degree.get(b) - 1);
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

        pruneShortBranches(arcs, floors = {}) {
            const lengthFloor = floors.lengthFloor || 0;
            const depthFloor  = floors.depthFloor  || 0;
            const tipFloor    = floors.tipFloor    || 0;
            const sampleSpacing = floors.sampleSpacing || 0.15;
            if ((lengthFloor <= 0 && depthFloor <= 0 && tipFloor <= 0) || !arcs || arcs.length === 0) return arcs;

            const { nodes, ends, arcLen } = this.buildArcGraph(arcs);
            const dead = new Uint8Array(arcs.length);
            for (let i = 0; i < arcs.length; i++) if (ends[i].loop) dead[i] = 1;

            const degOf = (n) => {
                let d = 0;
                for (const e of n.arcs) if (!dead[e.idx]) d++;
                return d;
            };

            let changed = true;
            while (changed) {
                changed = false;
                for (const node of nodes.values()) {
                    if (degOf(node) !== 1) continue;

                    const branch = [];
                    const ts = [node.t];
                    let cur = node, prevIdx = -1, maxT = 0, length = 0;
                    let endedAtJunction = false;
                    let guard = arcs.length + 1;
                    while (guard-- > 0) {
                        let step = null;
                        for (const e of cur.arcs) {
                            if (!dead[e.idx] && e.idx !== prevIdx) { step = e; break; }
                        }
                        if (!step) break;
                        branch.push(step.idx);
                        length += arcLen[step.idx];
                        const a = arcs[step.idx];
                        maxT = Math.max(maxT, a.t1, a.t2);
                        prevIdx = step.idx;
                        cur = step.other;
                        ts.push(cur.t);
                        const deg = degOf(cur);
                        if (deg >= 3) { endedAtJunction = true; break; }
                        if (deg === 1) break;
                    }
                    if (branch.length === 0) continue;

                    const minT = Math.min(...ts);
                    const span = maxT - minT;
                    // Protect genuine corner ramps: a branch that gets within one
                    // sample of the tip contact clearance is ramping to Z0.
                    const reachesBoundary = minT <= tipFloor + sampleSpacing;
                    const isRealCornerRamp = reachesBoundary || (span > depthFloor && minT < 0.5 * maxT);

                    const drop = endedAtJunction
                        ? (!isRealCornerRamp && maxT < depthFloor && length < lengthFloor)
                        : maxT < tipFloor;

                    if (drop) {
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

        stitchFloorRegion(loop, spine, zFloor, maxBridge) {
            if (!loop || loop.length < 4) return null;
            if (!spine || spine.length < 2) return null;

            const s0 = spine[0];
            const s1 = spine[spine.length - 1];
            if (Math.hypot(s1.x - s0.x, s1.y - s0.y) < PRECISION) return null;

            const nearest = (pt) => {
                let idx = -1, distSq = Infinity;
                for (let i = 0; i < loop.length; i++) {
                    const dx = loop[i].x - pt.x, dy = loop[i].y - pt.y;
                    const d = dx * dx + dy * dy;
                    if (d < distSq) { distSq = d; idx = i; }
                }
                return { idx, distSq };
            };
            const n0 = nearest(s0);
            const n1 = nearest(s1);

            // The bridge is a cutting move at zFloor across floor nothing else
            // clears. It earns that only when a spine end sits against the
            // perimeter; when both ends are inboard it is a stray chord and the
            // caller's fallback emits perimeter and spine separately.
            const useTail = n1.distSq <= n0.distSq;
            const join = useTail ? n1 : n0;
            if (join.idx === -1 || join.distSq > maxBridge * maxBridge) return null;

            // Spine FIRST. Its free end is a medial node a groove chain was
            // _claimed-split at - same XY, same zFloor, same node object - so
            // the optimizer's 3D continuation link enters here with no retract
            // and no plunge. Starting on the perimeter makes the entry a
            // vertical full-depth plunge into stock nothing has opened.
            const seq = [];
            const push = (p) => {
                const q = seq[seq.length - 1];
                if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= PRECISION) {
                    seq.push({ x: p.x, y: p.y, z: zFloor });
                }
            };

            if (useTail) for (let i = 0; i < spine.length; i++) push(spine[i]);
            else for (let i = spine.length - 1; i >= 0; i--) push(spine[i]);
            for (let k = 0; k <= loop.length; k++) push(loop[(join.idx + k) % loop.length]);

            return seq.length >= 3 ? seq : null;
        },

        runInsideLoop(run, ring) {
            if (!run || run.length < 2 || !ring || ring.length < 3) return false;
            const last = run.length - 1;
            const mid = {
                x: run[last >> 1].x,
                y: run[last >> 1].y
            };
            if (!this.pointInRing(mid, ring)) return false;
            let inside = 0;
            for (const f of [0.16, 0.33, 0.5, 0.66, 0.83]) {
                const idx = Math.min(last - 1, Math.floor(f * last));
                if (this.pointInRing(run[idx], ring)) inside++;
            }
            return inside >= 3;
        },

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

        closedPerimeter(loop, zFloor) {
            if (!loop || loop.length < 3) return null;
            const pts = loop.map(p => ({ x: p.x, y: p.y, z: zFloor }));
            pts.push({ ...pts[0] });
            return pts;
        },

        // ═══════════════════════════════════════════════════════════
        // Stage 5 - Depth mapping → PathPrimitives
        // ═══════════════════════════════════════════════════════════

        /**
         * Light Laplacian over chain INTERIORS. Ridge projection removes the
         * perpendicular zig-zag but leaves along-ridge jitter: circumcentres that
         * sit on the ridge yet wander in arc position, worst where the spine
         * hairpins into a sharp reversal.
         * t is RE-QUERIED from the relaxed position rather than carried. Along an
         * exact medial ridge the motion is iso-clearance and the query returns
         * what was already there; off the ridge - which is where the jitter is by
         * definition - carrying t forward would pair a moved tool centre with the
         * depth it had somewhere else.
         * Anchors are structural: index 0 and the last index of every chain.
         * Junction-terminated chaining makes every junction a chain endpoint, so
         * junctions and corner-spoke apices are already anchored and stay put
         * across the chains that share them.
         */
        smoothChainClearance(chains, opts = {}) {
            const passes = Math.max(0, opts.passes ?? 0);
            const field = opts.field || null;
            if (passes === 0) return chains;
            for (const chain of chains) {
                const len = chain.length;
                if (len < 3) continue;
                for (let pass = 0; pass < passes; pass++) {
                    const sx = new Float64Array(len);
                    const sy = new Float64Array(len);
                    for (let i = 0; i < len; i++) { sx[i] = chain[i].x; sy[i] = chain[i].y; }
                    for (let i = 1; i < len - 1; i++) {
                        chain[i].x = .5 * sx[i] + .25 * (sx[i - 1] + sx[i + 1]);
                        chain[i].y = .5 * sy[i] + .25 * (sy[i - 1] + sy[i + 1]);
                    }
                }
                if (field) for (let i = 1; i < len - 1; i++) chain[i].t = field.clearance(chain[i].x, chain[i].y);
            }
            return chains;
        },

        /**
         * Cuts every chain to the region the cutter can physically reach.
         * A V-bit's cutting radius at depth |Z| is tipRadius + |Z|*tan(half), so
         * at Z0 it is tipRadius: the tool CENTRE at Z0 must sit where the
         * inscribed circle radius is exactly tipRadius, which for a corner of
         * half-angle a is tipRadius/sin(a) back from the apex along the bisector.
         * Running the centre on to the apex holds Z0 for the whole t < tipRadius
         * stretch and drags a flat of radius tipRadius past both walls.
         * Interior crossings split rather than clamp: t dipping under tipRadius
         * mid-chain is a pinch narrower than the tip flat, and the tool does not
         * fit through it.
         */
        trimChainsToTip(chains, tipRadius) {
            if (!(tipRadius > 0)) return chains;
            const cross = (a, b) => {
                const f = (tipRadius - a.t) / (b.t - a.t);
                return { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y), t: tipRadius };
            };
            const out = [];
            for (const chain of chains) {
                let run = null;
                for (let i = 0; i < chain.length; i++) {
                    const n = chain[i];
                    const prev = chain[i - 1];
                    if (n.t >= tipRadius - T_EPS) {
                        if (!run) {
                            run = [];
                            if (prev && Math.abs(n.t - prev.t) > T_EPS) run.push(cross(prev, n));
                            out.push(run);
                        }
                        run.push(n);
                    } else if (run) {
                        if (prev && Math.abs(n.t - prev.t) > T_EPS) run.push(cross(prev, n));
                        run = null;
                    }
                }
            }
            return out.filter(r => r.length >= 2);
        },

        chainsToPrimitives(chains, tanHalf, startDepth, maxDepth, minChainLength, tipRadius = 0) {
            const emitted = this.trimChainsToTip(chains, tipRadius);
            const zOf = t => -(startDepth + Math.max(0, t - tipRadius) / tanHalf);
            const zFloor = maxDepth !== null ? -maxDepth : null;

            let deepestT = 0;
            for (const chain of chains) {
                for (const n of chain) if (n.t > deepestT) deepestT = n.t;
            }
            if (tipRadius > 0 && deepestT > 0 && deepestT <= tipRadius) {
                console.warn(
                    `[VCarveGenerator] tipRadius ${tipRadius.toFixed(3)}mm ≥ deepest clearance ` +
                    `${deepestT.toFixed(3)}mm - centerlines will emit at Z0.`
                );
            }

            const splitUnclaimed = (chain) => {
                const segs = [];
                let cur = null;
                let sawClaimed = false;
                for (let i = 0; i < chain.length; i++) {
                    const n = chain[i];
                    if (n._claimed) {
                        sawClaimed = true;
                        if (cur) { cur.push(n); cur = null; }
                        continue;
                    }
                    if (!cur) {
                        cur = [];
                        const prev = chain[i - 1];
                        if (prev && prev._claimed) cur.push(prev);
                        segs.push(cur);
                    }
                    cur.push(n);
                }
                if (sawClaimed) for (const s of segs) s.split = true;
                return segs;
            };

            const emitChain = (chain, out) => {
                if (chain.length < 2) return;
                // A chain END at the tip contact clearance is a corner ramp.
                // Dropping it leaves the apex unmachined and blunts the tip,
                // which is the one thing minChainLength must never do. Both
                // ends have to be tested: t is not monotonic along a chain, so
                // a trimChainsToTip run or a splitUnclaimed fragment can carry
                // its tip crossing at either end.
                const last = chain[chain.length - 1];
                const isCornerRamp = chain[0].t <= tipRadius + T_EPS || last.t <= tipRadius + T_EPS;
                if (minChainLength > 0 && !chain.split && !isCornerRamp) {
                    let l = 0;
                    for (let i = 1; i < chain.length; i++) {
                        l += Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
                    }
                    // Retain vertical plunge cuts (length === 0)
                    if (l > 0 && l < minChainLength) return;
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

                out.push(this.makePath3D(points, properties));
            };

            const out = [];
            for (const chain of emitted) for (const sub of splitUnclaimed(chain)) emitChain(sub, out);
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