/*!
 * @file        geometry/geometry-utils-fieldpipeline.js
 * @description Shared generation pipeline for every field-driven 3D
 *              operation (flat relief, indexed 3+1 face, continuous
 *              radial rotary).
 *
 *              FieldSpace     - the value space. Two constructors,
 *                               planar (depth below a datum) and
 *                               cylindrical (radius from an axis). Owns
 *                               grid/coordinate mapping, the target
 *                               seed, the compensator entry, and the
 *                               depth<->radius conversion pair.
 *
 *              FieldPipeline  - the ten-stage sequence every engine
 *                               runs: profile, window, target
 *                               composition, emission masks, lattice,
 *                               compensation, view, roughing,
 *                               finishing, emission. Boundary policy is
 *                               data ('axial' | 'isotropic'), not a
 *                               branch on operation type.
 *
 *              The ONLY space-dependent maths is toRadius/fromRadius.
 *              End-mode, window and floor behaviour therefore live here
 *              once instead of once per generator.
 *
 *              No DOM, guarded CAMConfig access - Web Worker loadable.
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

    // ════════════════════════════════════════════════════════════════
    // FieldView construction, shared by both spaces.
    //
    // Column indices always clamp; row indices clamp or wrap per space.
    // Both are required: the default bilinear sampler reads ic+1 / ir+1
    // past the grid edge, and unfolded access there returns undefined -
    // a seam gouge on cylindrical fields, an edge gouge on planar ones.
    // ════════════════════════════════════════════════════════════════
    function buildView(space, values, mask) {
        const cols = space.cols, rows = space.rows, wrap = space.wrapRows;

        const get = wrap
            ? (ic, ir) => {
                const ix = ic < 0 ? 0 : (ic >= cols ? cols - 1 : ic);
                let jj = ir % rows;
                if (jj < 0) jj += rows;
                return values[jj * cols + ix];
            }
            : (ic, ir) => {
                const ix = ic < 0 ? 0 : (ic >= cols ? cols - 1 : ic);
                const iy = ir < 0 ? 0 : (ir >= rows ? rows - 1 : ir);
                return values[iy * cols + ix];
            };

        const spec = {
            cols, rows, wrapRows: wrap, get,
            colCoord: space.colCoord,
            rowCoord: space.rowCoord,
            cellCol: space.cellCol,
            cellRow: space.cellRow
        };
        if (space.mapZ) spec.mapZ = space.mapZ;
        if (mask) {
            spec.covered = wrap
                ? (ic, ir) => {
                    const ix = ic < 0 ? 0 : (ic >= cols ? cols - 1 : ic);
                    const jj = ((ir % rows) + rows) % rows;
                    return mask[jj * cols + ix] !== 0;
                }
                : (ic, ir) => {
                    const ix = ic < 0 ? 0 : (ic >= cols ? cols - 1 : ic);
                    const iy = ir < 0 ? 0 : (ir >= rows ? rows - 1 : ir);
                    return mask[iy * cols + ix] !== 0;
                };
        }
        return ROOT.createFieldView(spec);
    }

    /**
     * Multi-source BFS (L1) outward from every covered cell: each
     * uncovered cell receives the VALUE of its nearest covered cell.
     * Used by the isotropic 'rollover' band so the wall forms at the
     * model's own edge height rather than plunging to the base plane.
     * Module-local on purpose - if geometry-utils-field.js carries its
     * own copy from the pre-pipeline generators, that one is now unused.
     */
    function nearestCoveredValues(mask, values, cols, rows) {
        const n = cols * rows;
        const out = new Float32Array(values);
        const queue = new Int32Array(n);
        const seen = new Uint8Array(n);
        let head = 0, tail = 0;
        for (let i = 0; i < n; i++) {
            if (mask[i]) { seen[i] = 1; queue[tail++] = i; }
        }
        while (head < tail) {
            const i = queue[head++];
            const ic = i % cols;
            if (ic > 0        && !seen[i - 1])    { seen[i - 1] = 1;    out[i - 1] = out[i];    queue[tail++] = i - 1; }
            if (ic < cols - 1 && !seen[i + 1])    { seen[i + 1] = 1;    out[i + 1] = out[i];    queue[tail++] = i + 1; }
            if (i >= cols     && !seen[i - cols]) { seen[i - cols] = 1; out[i - cols] = out[i]; queue[tail++] = i - cols; }
            if (i < n - cols  && !seen[i + cols]) { seen[i + cols] = 1; out[i + cols] = out[i]; queue[tail++] = i + cols; }
        }
        return out;
    }

    // ════════════════════════════════════════════════════════════════
    // FieldSpace
    // ════════════════════════════════════════════════════════════════

    const FieldSpace = {

        /**
         * Planar space: value = signed cut depth, negative into material.
         *
         * @param {Heightmap|HeightmapPrimitive} source
         * @param {Object} o
         * @param {string} [o.axialAxis='x'] - grid direction that is the
         *        rotary axis (indexed 3+1). Ignored by plain relief.
         * @param {number} [o.surfaceRefZ]   - blank face plane / apothem.
         *        REQUIRED under the axial policy: every value in that
         *        policy is measured from it, and toRadius/fromRadius are
         *        NaN without it.
         * @param {number} o.reliefDepth, o.startDepth
         * @param {boolean} o.invert
         * @param {string} o.depthMapping - 'scaled' | 'literal'
         */
        planar(source, o = {}) {
            const hm = source.heightmap || source;
            const cols = hm.cols, rows = hm.rows;
            const alongX = o.axialAxis !== 'y';
            const apo = o.surfaceRefZ;

            return {
                kind: 'planar',
                container: hm,
                meta: hm.meta,
                cols, rows,
                wrapRows: false,
                mask: hm.mask || null,
                hull: hm.hull || null,
                surfaceRefZ: apo,

                cellCol: hm.cellSize,
                cellRow: hm.cellSize,
                cellAxial: hm.cellSize,
                colCoord: (ic) => hm.cellX(ic),
                rowCoord: (ir) => hm.cellY(ir),
                mapZ: null,

                // Axial scan convention, matching rowEdges/resolveFieldWindow:
                // `lines` are cross rows, `length` is stations along the
                // rotary axis, idxOf(line, station) is the flat index.
                axialAxis: alongX ? 'x' : 'y',
                lines: alongX ? rows : cols,
                length: alongX ? cols : rows,
                idxOf: alongX
                    ? (line, station) => line * cols + station
                    : (line, station) => station * cols + line,
                crossCoord: alongX
                    ? (line) => hm.cellY(line)
                    : (line) => hm.cellX(line),
                minValue: -Infinity,

                // The rotation axis sits at z = -apothem in every face's
                // sliced frame, so a depth v at cross offset y is
                // hypot(y, apo + v) from it, and a radius r maps back to
                // -apo + sqrt(r^2 - y^2), degrading to -apo for |y| >= r.
                toRadius: (v, y) => Math.hypot(y || 0, apo + v),
                fromRadius: (r, y) => {
                    const yy = y || 0;
                    const s = r * r - yy * yy;
                    return -apo + (s > 0 ? Math.sqrt(s) : 0);
                },

                seedTarget: () => FieldSpace.mapDepths(
                    hm, o.reliefDepth, o.startDepth, !!o.invert,
                    o.depthMapping || 'scaled', apo),

                compensate: (values, c) => ROOT.FieldCompensator.planar(values, {
                    cols, rows,
                    cellSize: hm.cellSize,
                    profile: c.profile,
                    mask: c.mask || null,
                    lattice: c.lattice,
                    onProgress: c.onProgress || null
                })
            };
        },

        /**
         * Cylindrical space: value = part radius from the rotation axis.
         * Radii are literal dimensions, so the seed is a straight copy.
         *
         * @param {CylMap|CylMapPrimitive} source
         * @param {Object} o
         * @param {number} [o.minValue=0] - smallest radius any target may
         *        hold (tuning.minRadiusClip).
         */
        cylindrical(source, o = {}) {
            const cm = source.cylmap || source;
            const cols = cm.cols, rows = cm.rows;
            const refR = cm.refRadius;

            return {
                kind: 'cylindrical',
                container: cm,
                meta: cm.meta,
                cols, rows,
                wrapRows: true,
                mask: cm.mask || null,
                hull: cm.hull || null,
                surfaceRefZ: 0,

                cellCol: cm.cellX,
                cellRow: cm.cellArc,
                cellAxial: cm.cellX,
                colCoord: (ic) => cm.cellXAt(ic),
                // Affine in the index - spiralFinish extrapolates past rows
                // for the unwound helix.
                rowCoord: (ir) => ir * cm.dTheta * refR,
                mapZ: (R) => R - refR,

                axialAxis: 'x',
                lines: rows,
                length: cols,
                idxOf: (line, station) => line * cols + station,
                // theta carries no cross offset - the end-zone maths is
                // radius-native here.
                crossCoord: () => 0,

                minValue: Number.isFinite(o.minValue) ? o.minValue : 0,
                toRadius: (v) => v,
                fromRadius: (r) => r,

                seedTarget: () => new Float32Array(cm.data),

                compensate: (values, c) => ROOT.FieldCompensator.cylindrical(values, {
                    cols, rows,
                    cellX: cm.cellX,
                    dTheta: cm.dTheta,
                    profile: c.profile,
                    floorRadius: c.floorRadius,
                    mask: c.mask || null,
                    lattice: c.lattice,
                    onProgress: c.onProgress || null
                })
            };
        },

        // ════════════════════════════════════════════════════════════
        // Model heights -> cut depths.
        //
        // 'scaled':  the full [0..maxH] range maps onto reliefDepth.
        // 'literal': real dimensions - depth below the top is
        //            (maxH - h), clipped to reliefDepth.
        //
        // With surfaceRefZ supplied, depth is measured from that ONE
        // shared datum (Z0 = blank face top) instead of from this
        // heightmap's own model top. src is post-normalize, so a cell's
        // absolute sliced Z is src[i] + hm.zMin. The reliefDepth clamp
        // then bites at the same absolute Z on every face, which is what
        // stops a face the model barely touches from carrying a
        // different Z0 than one it fills - a physical gouge between
        // faces. invert is not combined with an external datum.
        // ════════════════════════════════════════════════════════════
        mapDepths(hm, reliefDepth, startDepth, invert, mode, surfaceRefZ) {
            const n = hm.cols * hm.rows;
            const cut = new Float32Array(n);
            const maxH = hm.maxH > 1e-9 ? hm.maxH : 1;
            const src = hm.data;

            if (mode === 'literal') {
                const useRef = Number.isFinite(surfaceRefZ) && Number.isFinite(hm.zMin);
                const zMin = hm.zMin || 0;
                let clamped = 0;
                for (let i = 0; i < n; i++) {
                    let below;
                    if (useRef) {
                        below = surfaceRefZ - (src[i] + zMin);
                        if (below < 0) below = 0;
                    } else {
                        below = maxH - src[i];
                        if (invert) below = maxH - below;
                    }
                    if (below > reliefDepth) { below = reliefDepth; clamped++; }
                    cut[i] = -(startDepth + below);
                }
                if (clamped > 0 && useRef) {
                    const pct = (100 * clamped / n).toFixed(0);
                    (hm.meta.warnings || (hm.meta.warnings = [])).push(
                        `${pct}% of the grid is deeper than the ${reliefDepth.toFixed(2)}mm ` +
                        `depth window and was flattened to a plane at ` +
                        `${(surfaceRefZ - reliefDepth).toFixed(2)}mm. Raise the depth ` +
                        `or set it to 0 (auto).`);
                }
                return cut;
            }

            for (let i = 0; i < n; i++) {
                let hNorm = src[i] / maxH;
                if (invert) hNorm = 1 - hNorm;
                cut[i] = -(startDepth + reliefDepth * (1 - hNorm));
            }
            return cut;
        },

        // ════════════════════════════════════════════════════════════
        // Worker boundary.
        //
        // Serialization is by FIXED PROPERTY LIST - anything hung on a
        // container instance and not named here dies silently at
        // postMessage. Both halves live in this file so adding a member
        // is one edit, and so typed arrays cannot be left off the
        // transfer list (they are returned separately from `props`,
        // which is Object.assign'd).
        // ════════════════════════════════════════════════════════════

        /** @returns {{kind, props, data, mask, hull}} */
        serialize(kind, container) {
            const c = container;
            if (kind === 'cylmap') {
                return {
                    kind: 'cylmap',
                    props: {
                        cols: c.cols, rows: c.rows, wrapRows: true,
                        cellX: c.cellX, dTheta: c.dTheta, originX: c.originX,
                        refRadius: c.refRadius, minR: c.minR, maxR: c.maxR,
                        axis: c.axis, axisB: c.axisB, axisC: c.axisC,
                        meta: c.meta
                    },
                    data: c.data,
                    mask: c.mask || null,
                    hull: c.hull || null
                };
            }
            return {
                kind: 'heightmap',
                props: {
                    cols: c.cols, rows: c.rows, wrapRows: false,
                    cellSize: c.cellSize, originX: c.originX, originY: c.originY,
                    maxH: c.maxH, zMin: c.zMin,
                    meta: c.meta
                },
                data: c.data,
                mask: c.mask || null,
                hull: c.hull || null
            };
        },

        /**
         * Rebuilds a live container from a serialize() record. Prototype
         * re-attachment restores methods and getters (cellXAt, cellArc,
         * circumference, worldBounds); typed arrays arrive by transfer,
         * zero-copy.
         */
        rehydrate(record) {
            const proto = (record.kind === 'cylmap')
                ? ROOT.CylMap.prototype : ROOT.Heightmap.prototype;
            const c = Object.create(proto);
            Object.assign(c, record.props);
            c.data = record.data;
            c.mask = record.mask || null;
            c.hull = record.hull || null;
            return c;
        }
    };

    // ════════════════════════════════════════════════════════════════
    // FieldPipeline
    // ════════════════════════════════════════════════════════════════

    const FieldPipeline = {

        /**
         * Tool profile plus the CUTTING reach captured before the holder
         * wrap. Once wrapped, profile.kernelRadius is the HOLDER radius -
         * correct for gouge protection, wrong for every question of the
         * form "how far past an edge can this tool still cut?" (the edge
         * band, the end overrun, the stub-vs-tool check). Those read cutR.
         */
        makeProfile(o) {
            let profile = ROOT.ToolProfile.make(o.toolShape || 'ball', {
                toolDiameter: o.toolDiameter,
                cornerRadius: o.cornerRadius || 0
            });
            const cutR = profile.kernelRadius;
            // Plain data by design - the closure-carrying envelope is built
            // here so worker and sync-fallback paths behave identically.
            if (o.holder) profile = ROOT.ToolProfile.withHolder(profile, o.holder);
            return { profile, cutR };
        },

        /**
         * @param {Object} o
         * @param {Object}  o.space      - FieldSpace instance
         * @param {Object}  o.profile    - from makeProfile
         * @param {number}  o.cutR       - from makeProfile
         * @param {Object}  o.policy     - boundary policy, see below
         * @param {number}  o.lattice    - 0 = auto via suggestLattice
         * @param {number}  o.simplifyTolerance, o.minSegmentLength
         * @param {Object}  o.rough      - { enabled, startVal, stepdown,
         *        stepover, stock, axis, skipFloor, floorVal, lineWindow,
         *        layersEndFallback }
         * @param {Object}  o.finish     - { enabled, strategies: [{label, run}] }
         * @param {Function} o.emitProps - (phase, layerIndex) -> properties
         * @param {Function} [o.onProgress], [o.debug]
         * @returns {{primitives: Array, meta: Object, warnings: string[]}}
         *
         * POLICY, 'axial' (rotary + indexed): machining is bounded along
         * ONE grid direction by the model span, each end's reach, and the
         * per-end material.
         *   { kind:'axial', ends, edgeRun, coreRadius, coreFloor,
         *     windowFloor, severanceFloor, fillGaps, wasteValue,
         *     maskMode:'window'|'collar', collarCells, facetHalfWidth,
         *     deepestFrom:'target'|'compensated', compensateMasked,
         *     forceExactLattice }
         *
         * POLICY, 'isotropic' (plain relief): an isotropic band around
         * the model silhouette.
         *   { kind:'isotropic', mode:'stop'|'rollover'|'extend', mm,
         *     maskUncovered, compensateMasked }
         */
        generate(o) {
            const space = o.space;
            const pol = o.policy;
            const FP = ROOT.FieldPaths;
            // null when logging is off - the generators pass null, so this
            // is a real signal both here and inside _composeAxial, and the
            // O(stations) probe scans below can gate on it directly.
            const debug = o.debug || null;
            const warnings = [];
            const primitives = [];

            const target = space.seedTarget();
            // Stage chain: seed → composed → compensated → in-mask. A value
            // that moves between adjacent stages names the stage that moved
            // it - the only question worth asking when output lands flat.
            let seedMin = Infinity;
            if (debug) {
                for (let i = 0; i < target.length; i++) {
                    if (target[i] < seedMin) seedMin = target[i];
                }
            }

            let roughMask = null, finishMask = null, deepestVal = null;
            let win = null;

            if (pol.kind === 'axial') {
                const composed = this._composeAxial(
                    space, target, pol, o.cutR, warnings, debug);
                if (!composed.ok) return { primitives: [], meta: {}, warnings };
                roughMask = composed.roughMask;
                finishMask = composed.finishMask;
                deepestVal = composed.deepestTarget;
                win = composed.win;
            } else if (pol.kind === 'isotropic') {
                roughMask = this._composeIsotropic(space, target, pol, o.cutR, o.profile);
            }

            // ── Evaluation lattice ───────────────────────────────────
            // 0 = auto (~5um max undershoot), 1 = exact per-cell, >=2 =
            // explicit. Exact evaluation over a fine grid with a wide
            // kernel is the cost that makes generation appear to hang.
            let lattice = o.lattice | 0;
            if (lattice === 0) {
                lattice = ROOT.FieldCompensator.suggestLattice(o.profile, space.cellCol);
                debug?.(`compLattice auto -> ${lattice}`);
            }
            if (pol.forceExactLattice && lattice > 1) {
                // Not a preference. suggestLattice's undershoot bound assumes
                // field curvature is bounded by the tool - true inside the
                // collar, false at its OUTER boundary where the compensated
                // field steps from tool fillet to raw waste target. Bilinear
                // upsampling drags that cliff `lattice` cells INTO the
                // emission mask. The perf lever here is cell size, not this.
                debug?.(`compLattice ${lattice} -> 1 (axial: exact per-cell required)`);
                lattice = 1;
            }

            const comp = space.compensate(target, {
                profile: o.profile,
                mask: pol.compensateMasked ? roughMask : null,
                // Cylindrical only: sizes the compensator's angular search
                // window. Planar ignores it.
                floorRadius: deepestVal,
                lattice,
                onProgress: o.onProgress || null
            });
            debug?.(`Compensation done (${o.profile.describe()})`);

            if (debug) {
                // machine Z = value + surfaceRefZ (0 for plain relief).
                // seed→composed is policy; composed→compensated is tool
                // reach or a waste constant out-bidding real geometry in
                // the max-plus kernel; compensated→inMask is the emission
                // mask dropping the deep region.
                const em = finishMask || roughMask;
                let tMin = Infinity, cMin = Infinity, mMin = Infinity;
                for (let i = 0; i < target.length; i++) {
                    if (target[i] < tMin) tMin = target[i];
                    if (comp[i] < cMin) cMin = comp[i];
                    if ((!em || em[i]) && comp[i] < mMin) mMin = comp[i];
                }
                const refZ = space.surfaceRefZ || 0;
                const z = (v) => Number.isFinite(v) ? (v + refZ).toFixed(3) : 'n/a';
                debug?.(`Stages [machineZ] min: seed=${z(seedMin)} ` +
                    `composed=${z(tMin)} compensated=${z(cMin)} ` +
                    `inMask=${z(mMin)} (policy=${pol.kind}, lattice=${lattice})`);
            }

            // The compensated field IS the final tip surface - every limit
            // was composed into the target above, so there is deliberately
            // NO value clamp here.
            const view = buildView(space, comp, roughMask);
            const finishView = finishMask ? buildView(space, comp, finishMask) : view;

            // Deepest commanded value. Scanning the TARGET is only valid
            // where the target holds real surface everywhere (cylindrical,
            // after the waste fill). Where it holds a depth-window BOUND
            // over uncovered cells the scan has to come from the other
            // side, or the roughing stack descends to the bound and puts
            // layers of air under every face.
            if (pol.deepestFrom === 'compensated') {
                let mn = Infinity;
                for (let i = 0; i < comp.length; i++) {
                    if (roughMask && !roughMask[i]) continue;
                    if (comp[i] < mn) mn = comp[i];
                }
                deepestVal = Number.isFinite(mn) ? mn : null;
            }

            const rough = o.rough || {};
            const finish = o.finish || {};
            const layersEnd = (deepestVal != null)
                ? deepestVal : rough.layersEndFallback;
            const simplifyTol = o.simplifyTolerance ?? 0.01;

            // ── Roughing: constant-step layers, clamped surface-follow ──
            if (rough.enabled) {
                const layers = FP.layers(rough.startVal, layersEnd, rough.stepdown || 1.5);
                const lineStart = (rough.lineWindow && win && rough.axis === 'y')
                    ? win.c0 : undefined;
                const lineEnd = (rough.lineWindow && win && rough.axis === 'y')
                    ? win.c1 : undefined;
                let chainCount = 0;

                // Each layer rasters its own 0→1. Blend them across the
                // stack so the emit band advances once, not N times.
                const nLayers = layers.length;
                const layerTick = o.onProgress
                    ? (li) => (p) => o.onProgress({
                        frac: (li + (p.frac || 0)) / nLayers,
                        label: p.label,
                        stage: 'emit'
                    })
                    : () => null;

                for (let li = 0; li < nLayers; li++) {
                    const chains = FP.rasterRoughLayer(view, {
                        axis: rough.axis,
                        stepover: rough.stepover,
                        layerVal: layers[li],
                        prevVal: li === 0 ? rough.startVal : layers[li - 1],
                        stock: rough.stock,
                        minSegLen: o.minSegmentLength,
                        skipFloor: rough.skipFloor,
                        floorVal: rough.floorVal,
                        lineStart, lineEnd,
                        onProgress: layerTick(li)
                    });
                    for (const chain of chains) {
                        const pts = simplifyTol > 0
                            ? FP.simplify3D(chain, simplifyTol) : chain;
                        if (pts.length >= 2) {
                            primitives.push(FP.toPrimitive(pts, o.emitProps('roughing', li)));
                            chainCount++;
                        }
                    }
                }
                debug?.(`Roughing: ${nLayers} layer(s) -> ${chainCount} chain(s)`);
            }

            // ── Finishing: caller-supplied strategies over finishView ──
            if (finish.enabled) {
                const ctx = {
                    roughMask, finishMask, deepestVal,
                    c0: win ? win.c0 : null, c1: win ? win.c1 : null,
                    m0: win ? win.m0 : null, m1: win ? win.m1 : null,
                    onProgress: o.onProgress || null
                };
                for (const strategy of finish.strategies || []) {
                    const chains = strategy.run(finishView, ctx) || [];
                    let emitted = 0;
                    for (const chain of chains) {
                        if (chain.length >= 2) {
                            primitives.push(FP.toPrimitive(chain, o.emitProps('finishing', null)));
                            emitted++;
                        }
                    }
                    debug?.(`Finishing (${strategy.label}): ${emitted} chain(s)`);
                }
            }

            return {
                primitives,
                meta: { deepestValue: deepestVal, lattice },
                warnings
            };
        },

        /**
         * Per-station waste floor: the deepest covered target over a band of
         * ±ceil(reachMm/cell) stations, capped at the policy floor.
         *
         * The band is a superset of the compensation kernel disc in BOTH
         * directions (all lines, ±reach stations), so a waste cell can never
         * out-bid a covered cell the tool could be shouldered by. reachMm is
         * the CUTTING radius, not profile.kernelRadius: a holder tap sits at
         * h(d) = stickout and loses every max-plus comparison anyway.
         *
         * Sliding-window minimum, monotone deque - O(stations).
         */
        _wasteFloors(target, mask, o) {
            const U = o.length, V = o.lines, idxOf = o.idxOf, cap = o.cap;
            const k = Math.max(0, Math.ceil(o.reachMm / o.cellMm));

            const per = new Float32Array(U);
            for (let st = 0; st < U; st++) {
                let mn = Infinity;
                for (let L = 0; L < V; L++) {
                    const i = idxOf(L, st);
                    if (mask[i] && target[i] < mn) mn = target[i];
                }
                per[st] = mn;
            }

            const out = new Float32Array(U);
            const dq = new Int32Array(U);
            let head = 0, tail = 0;
            for (let j = 0; j < U + k; j++) {
                if (j < U) {
                    while (tail > head && per[dq[tail - 1]] >= per[j]) tail--;
                    dq[tail++] = j;
                }
                const i = j - k;
                if (i >= 0 && i < U) {
                    const lo = i - k;
                    while (dq[head] < lo) head++;
                    const w = per[dq[head]];
                    out[i] = (w < cap) ? w : cap;
                }
            }
            return { floors: out, bandCells: k };
        },

        // ════════════════════════════════════════════════════════════
        // Axial boundary policy.
        //
        // TARGET COMPOSITION ORDER IS LOAD-BEARING. Every limit is
        // written into the target BEFORE compensation, never clamped
        // after it: max-plus dilation distributes over max, so composing
        // is identical to a post-comp clamp wherever the limit is
        // locally flat and CORRECT at its steps, where a clamp leaves an
        // un-ramped wall the tool cannot produce. A post-comp per-cell
        // clamp also constrains only the TIP - it never keeps the FLANK
        // off the surface below it, which is how a tool wider than the
        // drive core gouges the core it was meant to protect.
        //
        // Each step is gated by the data its caller supplies, so the two
        // engines select steps rather than branching on kind.
        // ════════════════════════════════════════════════════════════
        _composeAxial(space, target, pol, cutR, warnings, debug) {
            const cols = space.cols, rows = space.rows;
            const U = space.length, V = space.lines;
            const idxOf = space.idxOf;
            const y = space.crossCoord;
            const ends = pol.ends;

            if (!space.mask) {
                throw new Error('FieldPipeline: the axial policy requires a coverage mask');
            }
            if (space.kind === 'planar' && !Number.isFinite(space.surfaceRefZ)) {
                // Without it every value in this policy is measured from NaN
                // and the whole target NaN-cascades into a silent blob at the
                // face plane. Fail loudly instead of shipping geometry.
                throw new Error('FieldPipeline: a planar axial job requires a finite ' +
                    'surfaceRefZ (the blank face plane / apothem)');
            }

            // Per-line model edges and the machinable window. Per line, not
            // a 1-D bounding box: every line that ends early (a dome, a
            // point, a taper, an off-centre base) would otherwise have the
            // stations between its own edge and the global maximum treated
            // as in-span, and the end band written past it.
            const win = ROOT.resolveFieldWindow({
                footprint: space.hull || space.mask,
                lines: V, length: U,
                idxOf,
                cellMm: space.cellAxial,
                edgeRun: pol.edgeRun,
                reachFloor: cutR,
                ends
            });

            if (win.empty) {
                const msg = 'No model coverage on the sliced grid - nothing to ' +
                    'machine. Check the rotation axis, the model orientation, ' +
                    'and that the mesh is closed.';
                debug?.(msg);
                warnings.push(msg);
                return { ok: false };
            }

            const { m0, m1, c0, c1, rowFirst, rowLast, unitsOf, reachOf } = win;

            debug?.(`Axial window: [${c0}..${c1}] of ${U} station(s) ` +
                `(model [${m0}..${m1}], chuck '${ends.chuck.mode}'/${ends.chuck.material} ` +
                `reach ${reachOf(ends.chuck).toFixed(2)}mm, tail '${ends.tail.mode}'/` +
                `${ends.tail.material} reach ${reachOf(ends.tail).toFixed(2)}mm)`);

            if (!win.ok) {
                const msg = `The chuck/tail end offsets leave no machinable length ` +
                    `(window [${c0}..${c1}] of ${U} stations). A negative offset ` +
                    `trims inward from that end - reduce it, or set it to 0. ` +
                    `Nothing was generated.`;
                console.warn(`[FieldPipeline] ${msg}`);
                warnings.push(msg);
                return { ok: false };
            }

            // ── 1. Gap fill ──────────────────────────────────────────
            // Resolves the three states a sliced cell can be in: covered
            // keeps its surface; uncovered-but-in-footprint holds the
            // nearest formable value (model IS there, the slicer could not
            // form it - leave stock, sand later); uncovered with no
            // footprint is true waste. Without it the compensator dilates
            // the BLANK value across every gated region.
            //
            // The scan runs across LINES at each axial station, so the
            // caller's own axis convention holds for a planar field whose
            // axialAxis is 'y' as well as for the cylindrical θ wrap.
            let waste = null;
            if (pol.fillGaps && space.hull) {
                const wf = this._wasteFloors(target, space.mask, {
                    lines: V, length: U, idxOf,
                    cellMm: space.cellAxial, reachMm: cutR,
                    cap: pol.wasteValue
                });
                const r = ROOT.fillFromFootprint(target, space.mask, space.hull, {
                    lines: V, length: U, idxOf,
                    wrapLines: space.wrapRows,
                    wasteValue: pol.wasteValue,
                    wasteByStation: wf.floors,
                    // Cross-direction cells, not mm: dist is an L1 hop count.
                    reachCells: Number.isFinite(pol.fillReachCells)
                        ? pol.fillReachCells : Infinity
                });
                waste = r.waste;
                if (debug) {
                    let fMin = Infinity, fMax = -Infinity, deepened = 0;
                    for (let st = 0; st < U; st++) {
                        const f = wf.floors[st];
                        if (f < fMin) fMin = f;
                        if (f > fMax) fMax = f;
                        if (f < pol.wasteValue - 1e-9) deepened++;
                    }
                    debug?.(`Fill: ${r.retargeted} gated cell(s) held to the ` +
                        `surface, ${r.wasted} waste cell(s); floor ` +
                        `${fMin.toFixed(3)}..${fMax.toFixed(3)} (cap ` +
                        `${pol.wasteValue.toFixed(3)}, ${deepened}/${U} ` +
                        `station(s) deepened, band ±${wf.bandCells})`);
                }
            }

            // ── 2. End zones ─────────────────────────────────────────
            // Anchored per line on that line's own edge. 'stub' and 'free'
            // write nothing: a stop's signed reach already moved the window
            // in the resolver, and a free end falls to the waste floor by
            // construction.
            const coreR = pol.coreRadius || 0;
            const minV = space.minValue;
            const inZone = ROOT.writeFieldEndZones({
                target,
                // Formable surface, NOT the footprint: the edge index sits
                // on the footprint and a gated tip holds the waste value
                // there, so reading it directly cones from waste to waste.
                coverage: space.mask,
                lines: V, length: U, idxOf,
                unitsOf, reachOf, rowFirst, rowLast, ends,
                rowCoord: y,
                lipValue: (ref, mm) => Math.max(minV, ref - mm)
            });

            // ── 3. Drive-core cylinder ───────────────────────────────
            // The physical stub that carries torque from the chuck and
            // that a tailstock centre bears on. It runs the WHOLE machined
            // length, so it floors waste as well as model: restricting it
            // to the silhouette lets waste beside a narrow section cut
            // straight through the stub.
            if (pol.coreFloor && coreR > 0) {
                let raised = 0;
                for (let iv = 0; iv < V; iv++) {
                    const yv = y(iv);
                    if (Math.abs(yv) >= coreR) continue;   // cylinder absent here
                    const f = space.fromRadius(coreR, yv);
                    for (let iu = 0; iu < U; iu++) {
                        const i = idxOf(iv, iu);
                        if (target[i] < f) { target[i] = f; raised++; }
                    }
                }
                debug?.(`Core floor: cylinder r=${coreR.toFixed(2)}mm - ` +
                    `${raised} cell(s) raised`);
            }

            // ── 4. Severance over-cut ────────────────────────────────
            // With N evenly spaced faces the per-face half-spaces tile the
            // cross-section, so stopping at the axis COVERS it but does not
            // SEPARATE it: two opposing faces that stop exactly on the axis
            // are tangent, and backlash, deflection or a Z touch-off error
            // leaves a centreline spine a ball tool's flank cannot clear.
            //
            // Waste cells only, and only OUTSIDE the core band: covered
            // cells follow their own surface however far past the axis, and
            // the stub must survive.
            if (Number.isFinite(pol.severanceFloor)) {
                const f = pol.severanceFloor;
                let sunk = 0;
                for (let iv = 0; iv < V; iv++) {
                    if (Math.abs(y(iv)) < coreR) continue;   // stub band
                    for (let iu = 0; iu < U; iu++) {
                        const i = idxOf(iv, iu);
                        if (space.mask[i]) continue;
                        // Footprint cells within the fill reach hold a formable
                        // value from step 1 and must keep it. Since wasteValue
                        // and severanceFloor are the same number, the cells that
                        // reach this test are already AT f - so this loop is a
                        // no-op whenever fillGaps ran. It is the guard for the
                        // day those two numbers diverge.
                        if (waste && !waste[i]) continue;
                        if (target[i] > f) { target[i] = f; sunk++; }
                    }
                }
                debug?.(`Severance over-cut: floor ${f.toFixed(3)} - ` +
                    `${sunk} waste cell(s) lowered`);
            }

            // ── 5. Depth-window floor ────────────────────────────────
            // Waste and zone cells are exempt: they sit below the model's
            // depth window deliberately (the drive core beside a model
            // section IS the stub; a lip is a cut past the edge).
            if (Number.isFinite(pol.windowFloor)) {
                const f = pol.windowFloor;
                for (let i = 0; i < target.length; i++) {
                    if ((!waste || !waste[i]) && !inZone[i] && target[i] < f) {
                        target[i] = f;
                    }
                }
            }

            let deepestTarget = null;
            if (pol.deepestFrom === 'target') {
                let mn = Infinity;
                for (let i = 0; i < target.length; i++) {
                    if (target[i] < mn) mn = target[i];
                }
                // A near-zero value saturates the compensator's angular
                // window to a quarter turn.
                deepestTarget = Math.max(mn, 1e-6);
            }

            // ── 6. Emission masks ────────────────────────────────────
            // 'window' - every cell inside the axial window. The target
            //   holds a real value everywhere, so there is nothing to
            //   exclude cross-wise.
            // 'collar' - TWO sets, and they are not the same:
            //   finishMask (silhouette collar OR end bands) is what the
            //   tool must FOLLOW; rastering the flats at finishing
            //   stepover is pure air time and a witness-line risk.
            //   roughMask adds the facet band - stock outside the model
            //   but within this setup's facet belongs to this face, and if
            //   no face clears it, it is still standing when the part
            //   turns. facetHalfWidth 0 (a 2-face slab) collapses them.
            //
            // The collar is the silhouette dilated by one CUTTING radius:
            // emission gates on the tool CENTRE over a covered cell, so
            // the mask must be dilated by cutR AND the dilated collar must
            // carry a real target value. Both halves or neither.
            let roughMask = null, finishMask = null;

            if (pol.maskMode === 'collar') {
                const dmask = ROOT.dilateMask(
                    space.mask, cols, rows, pol.collarCells, space.wrapRows);
                const facetHalf = Math.max(0, pol.facetHalfWidth || 0);
                roughMask = new Uint8Array(cols * rows);
                finishMask = new Uint8Array(cols * rows);
                for (let iu = c0; iu <= c1; iu++) {
                    for (let iv = 0; iv < V; iv++) {
                        const i = idxOf(iv, iu);
                        if (dmask[i] || inZone[i]) {
                            finishMask[i] = 1;
                            roughMask[i] = 1;
                        } else if (facetHalf > 0 && Math.abs(y(iv)) <= facetHalf) {
                            roughMask[i] = 1;
                        }
                    }
                }
            } else if (c0 > 0 || c1 < U - 1) {
                roughMask = new Uint8Array(cols * rows);
                for (let iu = c0; iu <= c1; iu++) {
                    for (let iv = 0; iv < V; iv++) roughMask[idxOf(iv, iu)] = 1;
                }
            }

            return { ok: true, roughMask, finishMask, deepestTarget, win };
        },

        // ════════════════════════════════════════════════════════════
        // Isotropic boundary policy (plain relief).
        //
        //   'stop'     - paths end at the silhouette when maskUncovered is
        //                set; full-rectangle behaviour otherwise.
        //   'rollover' - band of one CUTTING radius; band cells take the
        //                nearest model edge VALUE minus mm, so the wall
        //                forms by compensation and the flat beyond it is a
        //                small indentation around the model's own edge
        //                height, not a slot to the base.
        //   'extend'   - band of kernelRadius + mm, cut to the base plane.
        //
        // Returns the emission mask; mutates `target` for 'rollover'.
        // ════════════════════════════════════════════════════════════
        _composeIsotropic(space, target, pol, cutR, profile) {
            const mask0 = space.mask;
            if (!mask0) return null;

            const cols = space.cols, rows = space.rows, cell = space.cellCol;
            const mode = pol.mode || 'stop';

            if (mode === 'stop') {
                return (pol.maskUncovered === true) ? mask0 : null;
            }

            if (mode === 'rollover') {
                // +1 because dilateMask is L1, which under-dilates diagonals.
                const bandCells = Math.ceil(cutR / cell) + 1;
                const mask = ROOT.dilateMask(mask0, cols, rows, bandCells, false);
                const lip = Math.max(0, pol.mm || 0);
                const near = nearestCoveredValues(mask0, target, cols, rows);
                for (let i = 0; i < mask.length; i++) {
                    if (mask[i] && !mask0[i]) target[i] = near[i] - lip;
                }
                return mask;
            }

            const bandMm = profile.kernelRadius + Math.max(0, pol.mm || 0);
            const bandCells = Math.ceil(bandMm / cell) + 1;
            return ROOT.dilateMask(mask0, cols, rows, bandCells, false);
        }
    };

    ROOT.FieldSpace = FieldSpace;
    ROOT.FieldPipeline = FieldPipeline;
})();
