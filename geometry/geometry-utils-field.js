/*!
 * @file        geometry/geometry-utils-field.js
 * @description Scalar-field infrastructure shared by the flat relief and
 *              rotary pipelines:
 *
 *              ScalarField      - uniform grid base (Heightmap and CylMap
 *                                 rebase onto this). Owns storage, the
 *                                 clamp-vs-wrap row semantics, the
 *                                 coverage mask, and bilinear sampling.
 *                                 Coordinate mapping (world mm / developed
 *                                 arc) stays in the subclasses.
 *
 *              createFieldView  - the sampler contract FieldPaths rasters
 *                                 against. Decouples the raster engine
 *                                 from any concrete container.
 *
 *              FieldCompensator - tool-tip dilation (gouge protection).
 *                                 planar() generalizes the kernel that
 *                                 lived in ReliefGenerator.compensate();
 *                                 cylindrical() is the rotary variant
 *                                 (θ wrap, exact chordal metric). Both
 *                                 take a ToolProfile and support an
 *                                 optional coarse evaluation lattice.
 *
 *              The coverage mask is also the indexed-3+1 hook: each
 *              indexed setup owns only the cells its view direction can
 *              see, so multi-setup (undercut) jobs mask per setup instead
 *              of forking the engine.
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
    // Worker-safe: CAMConfig may not be loaded inside a worker. Captured at
    // load like the other modules; falls back to disabled.
    const debugState = ROOT.CAMConfig?.defaults?.debug || { enabled: false };

    // ════════════════════════════════════════════════════════════════
    // ScalarField - uniform grid of float values + optional coverage mask
    // (Heightmap and CylMap extend ScalarField)
    // ════════════════════════════════════════════════════════════════
    class ScalarField {
        /**
         * @param {number} cols
         * @param {number} rows
         * @param {Object} [options]
         * @param {boolean} [options.wrapRows=false] - rows are periodic
         *        (CylMap θ axis). Columns always clamp.
         * @param {boolean} [options.withMask=false] - allocate coverage
         *        mask (1 = model covers this cell). Absent mask means
         *        "fully covered".
         */
        constructor(cols, rows, options = {}) {
            if (!(cols >= 2) || !(rows >= 2)) {
                throw new Error(`ScalarField: degenerate grid ${cols}x${rows}`);
            }
            this.cols = cols;
            this.rows = rows;
            this.wrapRows = options.wrapRows === true;
            this.data = new Float32Array(cols * rows);
            this.mask = options.withMask ? new Uint8Array(cols * rows) : null;
        }

        index(ix, iy) { return iy * this.cols + ix; }

        clampCol(ix) {
            if (ix < 0) return 0;
            if (ix >= this.cols) return this.cols - 1;
            return ix;
        }

        /** Row folding: wrap (periodic) or clamp, per construction. */
        foldRow(iy) {
            if (this.wrapRows) {
                const r = iy % this.rows;
                return r < 0 ? r + this.rows : r;
            }
            if (iy < 0) return 0;
            if (iy >= this.rows) return this.rows - 1;
            return iy;
        }

        get(ix, iy) {
            return this.data[this.foldRow(iy) * this.cols + this.clampCol(ix)];
        }

        set(ix, iy, v) {
            this.data[iy * this.cols + ix] = v;
        }

        covered(ix, iy) {
            if (!this.mask) return true;
            return this.mask[this.foldRow(iy) * this.cols + this.clampCol(ix)] !== 0;
        }

        /**
         * Bilinear sample on FRACTIONAL GRID INDICES (not world coords -
         * world→index mapping is the subclass's job). Honors clamp/wrap.
         */
        sampleIndex(fx, fy) {
            const ix = Math.floor(fx), iy = Math.floor(fy);
            const tx = fx - ix, ty = fy - iy;
            const h00 = this.get(ix, iy),     h10 = this.get(ix + 1, iy);
            const h01 = this.get(ix, iy + 1), h11 = this.get(ix + 1, iy + 1);
            return (h00 * (1 - tx) + h10 * tx) * (1 - ty)
                 + (h01 * (1 - tx) + h11 * tx) * ty;
        }

        /** min/max over the field; coveredOnly restricts to masked cells. */
        stats(coveredOnly = false) {
            let min = Infinity, max = -Infinity;
            const d = this.data, m = this.mask;
            for (let i = 0; i < d.length; i++) {
                if (coveredOnly && m && !m[i]) continue;
                if (d[i] < min) min = d[i];
                if (d[i] > max) max = d[i];
            }
            if (!Number.isFinite(min)) { min = 0; max = 0; }
            return { min, max };
        }
    }

    // ════════════════════════════════════════════════════════════════
    // FieldView - the contract FieldPaths rasters against.
    //
    // REQUIRED spec members:
    //   cols, rows          - grid dimensions
    //   get(ic, ir)         - compensated value at integer cell
    //   colCoord(ic)        - output-space X for a column index
    //   rowCoord(ir)        - output-space Y for a row index (developed
    //                         arc length for cylindrical views)
    //   cellCol, cellRow    - output-space size of one cell in each axis
    //
    // OPTIONAL:
    //   wrapRows            - rows periodic (default false)
    //   covered(ic, ir)     - coverage predicate (default: always true)
    //   mapZ(v)             - value → emitted Z (default identity).
    //                         MUST be affine increasing: the rasters
    //                         compute max() in value space before mapping
    //                         (relief: identity; rotary: v - refRadius).
    //   sampleIndex(fc, fr) - bilinear at fractional indices (default
    //                         built from get(); required by spiralFinish)
    //
    // colCoord/rowCoord MUST be affine in the index: spiralFinish
    // extrapolates rowCoord beyond rows for the unwound helix, and
    // fractional column indices are passed straight through.
    // ════════════════════════════════════════════════════════════════
    function createFieldView(spec) {
        for (const k of ['cols', 'rows', 'get', 'colCoord', 'rowCoord', 'cellCol', 'cellRow']) {
            if (spec[k] === undefined) {
                throw new Error(`createFieldView: missing required member '${k}'`);
            }
        }
        const wrapRows = spec.wrapRows === true;
        const get = spec.get;
        const rows = spec.rows;

        const defaultSample = (fc, fr) => {
            const ic = Math.floor(fc), ir = Math.floor(fr);
            const tc = fc - ic, tr = fr - ir;
            const v00 = get(ic, ir),     v10 = get(ic + 1, ir);
            const v01 = get(ic, ir + 1), v11 = get(ic + 1, ir + 1);
            return (v00 * (1 - tc) + v10 * tc) * (1 - tr)
                 + (v01 * (1 - tc) + v11 * tc) * tr;
        };

        return {
            cols: spec.cols,
            rows,
            wrapRows,
            get,
            colCoord: spec.colCoord,
            rowCoord: spec.rowCoord,
            cellCol: spec.cellCol,
            cellRow: spec.cellRow,
            covered: spec.covered || (() => true),
            mapZ: spec.mapZ || ((v) => v),
            sampleIndex: spec.sampleIndex || defaultSample
        };
    }

    // ════════════════════════════════════════════════════════════════
    // FieldCompensator - tool-tip dilation (gouge protection)
    //
    //   tipVal(p) = max over neighbors q within kernelRadius of
    //               [ value(q) - h(d(p,q)) ]
    //
    // planar():      d = Euclidean grid distance. Direct generalization
    //                of the kernel previously in ReliefGenerator (hFn
    //                from ToolProfile instead of hardcoded ball/flat).
    // cylindrical(): the part rotates under a radial tool. For a
    //                neighbor at radius Rn and angular offset Δθ:
    //                  height along tool axis:  Rn·cosΔθ
    //                  chordal distance:        √(dx² + Rn²·sin²Δθ)
    //                Running the planar kernel on the developed grid
    //                substitutes arc for chord and drops the cosΔθ term -
    //                conservative but wrong at small radii, so don't.
    //
    // Coarse lattice: the dilated surface's curvature is bounded by the
    // tool, so it can be EVALUATED on a lattice of L cells and bilinearly
    // upsampled while the input stays full resolution (the kernel still
    // scans every fine cell, so thin tall features are never missed).
    // Max undershoot ≈ (L·cell)² / (8·kernelRadius). suggestLattice()
    // picks L for a target error. TODO(perf): the remaining upgrade path
    // is 1D max-plus decomposition per angular offset (monotone stack).
    //
    // Mask semantics: uncovered neighbors are skipped (no material there
    // constrains the tool); a cell with zero covered neighbors falls back
    // to its own input value.
    //
    // Roughing note: with roughStock ≥ ~0.3mm a cheap flat profile over
    // the raw field is a valid conservative stand-in; only the finishing
    // pass needs the exact profile.
    // ════════════════════════════════════════════════════════════════
    const FieldCompensator = {

        /**
         * @param {Float32Array} values - input field (cut depths / heights)
         * @param {Object} o
         * @param {number} o.cols, o.rows
         * @param {number} o.cellSize        - mm per cell (square cells)
         * @param {Object} o.profile        - ToolProfile.make() result
         * @param {Uint8Array} [o.mask]     - coverage mask
         * @param {boolean} [o.wrapRows=false]
         * @param {number} [o.lattice=0]    - evaluation lattice in cells;
         *                                    ≤1 = exact per-cell
         * @returns {Float32Array} compensated field (input returned
         *          unchanged when the kernel is sub-cell)
         */
        planar(values, o) {
            const { cols, rows, cellSize, profile } = o;
            const mask = o.mask || null;
            const wrapRows = o.wrapRows === true;
            const radius = profile.kernelRadius;
            const rCells = Math.ceil(radius / cellSize);
            if (rCells <= 0) return values;

            const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

            // Kernel taps as parallel typed arrays, sorted by adj
            // DESCENDING (adj = -h(d): center first, rim last). Enables
            // an EXACT early exit in evalCell: taps are visited in
            // decreasing best-possible order, so the moment
            // vMax + adj ≤ best, no remaining tap can beat the current
            // max - break. The effective scan radius adapts to local
            // relief amplitude instead of always paying the full disc;
            // output is bit-identical to the exhaustive scan.
            const raw = [];
            for (let dy = -rCells; dy <= rCells; dy++) {
                for (let dx = -rCells; dx <= rCells; dx++) {
                    const d = Math.hypot(dx, dy) * cellSize;
                    if (d > radius) continue;
                    raw.push([dx, dy, -profile.h(d)]);
                }
            }
            raw.sort((a, b) => b[2] - a[2]);
            const nTaps = raw.length;
            const tdx = new Int32Array(nTaps);
            const tdy = new Int32Array(nTaps);
            const tadj = new Float64Array(nTaps);
            for (let k = 0; k < nTaps; k++) {
                tdx[k] = raw[k][0]; tdy[k] = raw[k][1]; tadj[k] = raw[k][2];
            }

            // Upper bound for the early exit. A superset max (mask
            // ignored) is still a valid bound - just slightly less tight.
            let vMax = -Infinity;
            for (let i = 0; i < values.length; i++) {
                if (values[i] > vMax) vMax = values[i];
            }

            const lastRow = rows - 1, lastCol = cols - 1;
            const evalCell = (ix, iy) => {
                let best = -Infinity;
                for (let k = 0; k < nTaps; k++) {
                    if (vMax + tadj[k] <= best) break;  // no remaining tap can win
                    const nx = ix + tdx[k];

                    // If the tool overhangs the grid, assume it hits nothing (empty space)
                    if (nx < 0 || nx > lastCol) continue;

                    let ny = iy + tdy[k];
                    if (wrapRows) {
                        ny %= rows; if (ny < 0) ny += rows;
                    } else {
                        if (ny < 0 || ny > lastRow) continue;
                    }

                    const idx = ny * cols + nx;
                    if (mask && mask[idx] === 0) continue;

                    const v = values[idx] + tadj[k];
                    if (v > best) best = v;
                }
                return (best === -Infinity) ? values[iy * cols + ix] : best;
            };

            const out = this._evaluate(cols, rows, wrapRows, o.lattice | 0, evalCell, ' planar', o.onProgress);

            if (debugState.enabled) {
                console.log(`[FieldCompensator] planar ${cols}x${rows} ` +
                    `(${profile.describe()}, ${nTaps} taps` +
                    `${(o.lattice | 0) > 1 ? `, lattice=${o.lattice}` : ''}) in ` +
                    `${((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(0)}ms`);
            }
            return out;
        },

        /**
         * @param {Float32Array} radii - part radius per (col=axial, row=θ)
         * @param {Object} o
         * @param {number} o.cols, o.rows  - rows are PERIODIC
         * @param {number} o.cellX         - mm per axial cell
         * @param {number} o.dTheta        - radians per angular cell
         * @param {Object} o.profile       - ToolProfile.make() result
         * @param {number} o.floorRadius   - smallest radius material can
         *        reach (refRadius - totalDepth). Bounds the θ kernel
         *        window; the caller validates floorRadius ≥ some sane
         *        minimum before getting here.
         * @param {Uint8Array} [o.mask]
         * @param {number} [o.lattice=0]
         * @returns {Float32Array} compensated tip radius per cell
         */
        cylindrical(radii, o) {
            const { cols, rows, cellX, dTheta, profile } = o;
            const mask = o.mask || null;
            const rt = profile.kernelRadius;
            if (!(rt > 0)) return radii;

            const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;

            const kx = Math.ceil(rt / cellX);
            // Worst-case angular reach: a neighbor at radius Rn is laterally
            // within rt only while Rn·sinΔθ ≤ rt; the deepest material sits
            // at floorRadius. rt ≥ floorRadius → quarter turn.
            const floorR = Math.max(o.floorRadius ?? 0, 1e-6);
            const sinArg = Math.min(1, rt / floorR);
            const ktMax = Math.min(Math.ceil(Math.asin(sinArg) / dTheta), rows >> 1);

            if (debugState.enabled) {
                console.log(`[FieldCompensator] cylindrical start: ${cols}x${rows}, ` +
                    `kernel kx=${kx} kθmax=${ktMax}, lattice=${Math.max(1, o.lattice | 0)}`);
            }
            if (ktMax > rows >> 4) {
                console.warn(`[FieldCompensator] worst-case θ-window spans ` +
                    `${(2 * ktMax * dTheta * 180 / Math.PI).toFixed(0)}° ` +
                    `(floorRadius ${floorR.toFixed(2)}mm vs tool reach ${rt.toFixed(2)}mm) - ` +
                    `deep regions will be slow. Reduce carve depth or grid resolution.`);
            }

            // θ tables, worst-case size; the adaptive window indexes into them.
            const cosT = new Float64Array(2 * ktMax + 1);
            const sin2T = new Float64Array(2 * ktMax + 1);
            for (let j = -ktMax; j <= ktMax; j++) {
                cosT[j + ktMax] = Math.cos(j * dTheta);
                const s = Math.sin(j * dTheta);
                sin2T[j + ktMax] = s * s;
            }

            // Axial offsets squared (was recomputed per tap).
            const ax2 = new Float64Array(2 * kx + 1);
            for (let i = -kx; i <= kx; i++) ax2[i + kx] = (i * cellX) * (i * cellX);

            // Squared radii, once - saves one multiply per tap over ~1e8-1e9 taps.
            const n = cols * rows;
            const r2 = new Float32Array(n);
            for (let i = 0; i < n; i++) r2[i] = radii[i] * radii[i];

            // h(d²) lookup with linear interpolation - replaces the per-tap
            // Math.sqrt + profile.h() closure call. Quantization error is
            // µm-level for all current profiles; raise H_N if a future
            // profile is spikier near the rim.
            const rt2 = rt * rt;
            const H_N = 4096;
            const hTab = new Float64Array(H_N + 2);
            for (let k = 0; k <= H_N; k++) hTab[k] = profile.h(Math.sqrt(rt2 * k / H_N));
            hTab[H_N + 1] = hTab[H_N];
            const hScale = H_N / rt2;

            // Adaptive θ-window: a neighbor at radius Rn only reaches
            // |Δθ| ≤ asin(rt/Rn), so each axial column sizes its window from
            // the SMALLEST covered radius within ±kx instead of the global
            // floor. Radii below floorR are windowed AS floorR. That is
            // exact because the AXIAL POLICY composes a core floor into the
            // target before compensation (FieldPipeline._composeAxial step
            // 3), so no cell holds less than floorR to begin with. It used
            // to be justified by a post-compensation clamp in the rotary
            // FieldView; the pipeline refactor removed that clamp
            // deliberately ("the compensated field IS the final tip
            // surface"), so if a caller ever runs this with coreFloor off,
            // the exclusion below becomes an approximation.
            const colMin = new Float64Array(cols).fill(Infinity);
            for (let iy = 0; iy < rows; iy++) {
                const base = iy * cols;
                for (let ix = 0; ix < cols; ix++) {
                    const idx = base + ix;
                    if (mask && mask[idx] === 0) continue;
                    const v = radii[idx];
                    // Cells at/below the floor can never raise a
                    // compensated value above floorR (v·cosΔθ - h ≤ v ≤
                    // floorR), so they must not size the θ-window. Without
                    // this exclusion the generator's zoned web (in-span
                    // uncovered cells retargeted to floorR) drags EVERY
                    // column to the worst-case window on off-axis parts -
                    // the "compensation cost explodes" failure.
                    if (v <= floorR + 1e-6) continue;
                    if (v < colMin[ix]) colMin[ix] = v;
                }
            }
            const ktCol = new Int32Array(cols);
            for (let ix = 0; ix < cols; ix++) {
                let mMin = Infinity;
                const i0 = Math.max(0, ix - kx), i1 = Math.min(cols - 1, ix + kx);
                for (let i = i0; i <= i1; i++) if (colMin[i] < mMin) mMin = colMin[i];
                if (!Number.isFinite(mMin)) { ktCol[ix] = 0; continue; } // window fully masked
                mMin = Math.max(mMin, floorR);
                const sa = Math.min(1, rt / mMin);
                ktCol[ix] = Math.min(ktMax, Math.ceil(Math.asin(sa) / dTheta));
            }

            const lastCol = cols - 1;

            const evalCell = (ix, it) => {
                let best = -Infinity;
                const kt = ktCol[ix];
                for (let j = -kt; j <= kt; j++) {
                    let jt = (it + j) % rows;
                    if (jt < 0) jt += rows;
                    const c = cosT[j + ktMax], s2 = sin2T[j + ktMax];
                    const base = jt * cols;
                    for (let i = -kx; i <= kx; i++) {
                        const nx = ix + i;
                        // Beyond the axial ends: empty space, the tool can drop
                        if (nx < 0 || nx > lastCol) continue;
                        const idx = base + nx;
                        if (mask && mask[idx] === 0) continue;  // no material there
                        const d2 = ax2[i + kx] + r2[idx] * s2;
                        if (d2 > rt2) continue;                 // outside tool reach
                        const q = d2 * hScale;
                        const k0 = q | 0;
                        const h = hTab[k0] + (hTab[k0 + 1] - hTab[k0]) * (q - k0);
                        const v = radii[idx] * c - h;
                        if (v > best) best = v;
                    }
                }
                return (best === -Infinity) ? radii[it * cols + ix] : best;
            };

            const out = this._evaluate(cols, rows, true, o.lattice | 0, evalCell, ' cylindrical', o.onProgress);

            if (debugState.enabled) {
                console.log(`[FieldCompensator] cylindrical ${cols}x${rows} ` +
                    `(${profile.describe()}, kx=${kx}, kθ≤${ktMax}` +
                    `${(o.lattice | 0) > 1 ? `, lattice=${o.lattice}` : ''}) in ` +
                    `${((typeof performance !== 'undefined' ? performance.now() : 0) - t0).toFixed(0)}ms`);
            }
            return out;
        },

        /**
         * Lattice step (cells) for a target undershoot:
         *   error ≈ (L·cell)² / (8·kernelRadius)  →  L = √(8·r·err) / cell
         */
        suggestLattice(profile, cellSize, maxError = 0.005) {
            const L = Math.floor(Math.sqrt(8 * profile.kernelRadius * maxError) / cellSize);
            return Math.max(1, L);
        },

        // ════════════════════════════════════════════════════════════
        // Shared evaluation: exact per-cell, or coarse lattice + bilinear
        // upsample (wrap-aware on rows).
        // ════════════════════════════════════════════════════════════
        _evaluate(cols, rows, wrapRows, lattice, evalCell, label = '', onProgress = null) {
            const out = new Float32Array(cols * rows);
            const logEvery = debugState.enabled ? Math.max(1, rows >> 3) : 0;
            const tickEvery = Math.max(1, rows >> 6);

            if (lattice <= 1) {
                for (let iy = 0; iy < rows; iy++) {
                    if (logEvery && iy > 0 && iy % logEvery === 0) {
                        console.log(`[FieldCompensator]${label} row ${iy}/${rows}`);
                    }
                    if (onProgress && iy % tickEvery === 0) {
                        onProgress({ frac: iy / rows, label: `Compensating${label}`,
                                     stage: 'compensate' });
                    }
                    const rowBase = iy * cols;
                    for (let ix = 0; ix < cols; ix++) {
                        out[rowBase + ix] = evalCell(ix, iy);          // ← write-back (exact)
                    }
                }
                return out;
            }

            // Coarse sample positions. Columns always include the final
            // column; wrapped rows interpolate the last→first segment.
            const positions = (count, wrap) => {
                const pos = [];
                for (let p = 0; p < count; p += lattice) pos.push(p);
                if (!wrap && pos[pos.length - 1] !== count - 1) pos.push(count - 1);
                return pos;
            };
            const px = positions(cols, false);
            const py = positions(rows, wrapRows);
            const cw = px.length, ch = py.length;

            const coarse = new Float32Array(cw * ch);
            const logCoarse = debugState.enabled ? Math.max(1, ch >> 3) : 0;
            const tickCoarse = Math.max(1, ch >> 6);
            for (let jj = 0; jj < ch; jj++) {
                if (logCoarse && jj > 0 && jj % logCoarse === 0) {
                    console.log(`[FieldCompensator]${label} coarse row ${jj}/${ch}`);
                }
                if (onProgress && jj % tickCoarse === 0) {
                    onProgress({ frac: jj / ch, label: `Compensating${label}`,
                                 stage: 'compensate' });
                }
                for (let ii = 0; ii < cw; ii++) {
                    coarse[jj * cw + ii] = evalCell(px[ii], py[jj]);   // ← write-back (coarse)
                }
            }

            const seg = (pos, count, wrap, i) => {
                let a = Math.floor(i / lattice);
                if (wrap) {
                    if (a >= pos.length) a = pos.length - 1;
                    const b = (a + 1) % pos.length;
                    const span = (a === pos.length - 1) ? (count - pos[a]) : (pos[a + 1] - pos[a]);
                    return { a, b, t: span > 0 ? (i - pos[a]) / span : 0 };
                }
                if (a >= pos.length - 1) a = pos.length - 2;
                if (i > pos[a + 1]) a = pos.length - 2;
                const span = pos[a + 1] - pos[a];
                return { a, b: a + 1, t: span > 0 ? (i - pos[a]) / span : 0 };
            };

            for (let iy = 0; iy < rows; iy++) {
                if (onProgress && iy % tickEvery === 0) {
                    onProgress({ frac: iy / rows, label: `Upsampling${label}`,
                                 stage: 'upsample' });
                }
                const sy = seg(py, rows, wrapRows, iy);
                const rowA = sy.a * cw, rowB = sy.b * cw;
                const outBase = iy * cols;
                for (let ix = 0; ix < cols; ix++) {
                    const sx = seg(px, cols, false, ix);
                    const v0 = coarse[rowA + sx.a] * (1 - sx.t) + coarse[rowA + sx.b] * sx.t;
                    const v1 = coarse[rowB + sx.a] * (1 - sx.t) + coarse[rowB + sx.b] * sx.t;
                    out[outBase + ix] = v0 * (1 - sy.t) + v1 * sy.t;   // ← write-back (upsample)
                }
            }
            return out;
        }
    };
    
    // ════════════════════════════════════════════════════════════════
    // dilateMask - grid dilation of a coverage mask by N cells.
    // Two-pass chamfer distance (L1). L1 slightly UNDER-dilates
    // diagonals vs the true circular kernel - pass cells = ceil(band /
    // cellSize) + 1 when the band must be guaranteed. Columns clamp;
    // rows optionally wrap (θ-periodic fields).
    // Consumers: the relief silhouette band ('rollover' / 'extend') AND
    // the indexed 3+1 emission collar in ReliefGenerator's axial block.
    // ════════════════════════════════════════════════════════════════
    function dilateMask(mask, cols, rows, cells, wrapRows = false) {
        if (!mask || cells <= 0) return mask;
        const n = cols * rows;
        const INF = 1 << 29;
        const dist = new Int32Array(n);
        for (let i = 0; i < n; i++) dist[i] = mask[i] ? 0 : INF;

        // Horizontal (column-direction) chamfer.
        const hpass = () => {
            for (let iy = 0; iy < rows; iy++) {
                const base = iy * cols;
                for (let ix = 1; ix < cols; ix++) {
                    const d = dist[base + ix - 1] + 1;
                    if (d < dist[base + ix]) dist[base + ix] = d;
                }
                for (let ix = cols - 2; ix >= 0; ix--) {
                    const d = dist[base + ix + 1] + 1;
                    if (d < dist[base + ix]) dist[base + ix] = d;
                }
            }
        };
        // Vertical (row-direction) chamfer.
        const vpass = () => {
            for (let ix = 0; ix < cols; ix++) {
                for (let iy = 1; iy < rows; iy++) {
                    const d = dist[(iy - 1) * cols + ix] + 1;
                    if (d < dist[iy * cols + ix]) dist[iy * cols + ix] = d;
                }
                for (let iy = rows - 2; iy >= 0; iy--) {
                    const d = dist[(iy + 1) * cols + ix] + 1;
                    if (d < dist[iy * cols + ix]) dist[iy * cols + ix] = d;
                }
            }
        };

        // h THEN v - that order is what makes the two-pass chamfer L1.
        hpass();
        vpass();
        if (wrapRows) {
            // Seed each seam row from the other, then settle once more.
            for (let ix = 0; ix < cols; ix++) {
                const top = dist[ix], bot = dist[(rows - 1) * cols + ix];
                if (bot + 1 < dist[ix]) dist[ix] = bot + 1;
                if (top + 1 < dist[(rows - 1) * cols + ix]) dist[(rows - 1) * cols + ix] = top + 1;
            }
            vpass();
        }
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i++) out[i] = dist[i] <= cells ? 1 : 0;
        return out;
    }

    // ════════════════════════════════════════════════════════════════
    // fillFromFootprint - resolves the THREE states a sliced cell can be
    // in, which is the distinction the whole "uncovered is two different
    // facts" rule rests on:
    //
    //   covered              → keep the sliced surface value.
    //   uncovered + hull,    → the model IS on this ray, the slicer just
    //     within reachCells    could not form it (radiality-gated end
    //                          caps, tilted bases, occlusion). Hold the
    //                          nearest formable value ALONG THE SCAN
    //                          AXIS. Leave stock; sand later.
    //   anything else        → true waste → min(seed, wasteValue), flagged
    //                          so a later floor compose can exempt it.
    //
    // Scans across LINES (the cross direction) at each STATION along the
    // axial direction, via the caller's idxOf - so the caller's own axis
    // convention holds for cylindrical θ and for a planar field whose
    // axial axis is either 'x' or 'y'. Two laps each way is exact L1 on
    // a cycle. Mutates `values` in place.
    //
    // A line with no formable cell at all (a fully-gated flat end cap)
    // carries the PREVIOUS station's already-filled value where the
    // footprint says the model is there. Directional by construction -
    // the low-index end has no predecessor and keeps blank stock, which
    // the end policy trims anyway.
    // ════════════════════════════════════════════════════════════════
    // REVIEW - Is this comment outdated? Should be trimmed a bit too
    function fillFromFootprint(values, mask, hull, o) {
        const lines = o.lines, length = o.length, idxOf = o.idxOf;
        const wasteValue = o.wasteValue;
        // Per-station waste floor. wasteValue is the CAP (severance plane /
        // drive stub); this array may go DEEPER where a covered cell within
        // the tool's reach demands it. Compensation is max-plus, so a waste
        // constant shallower than a covered target inside the kernel
        // out-bids it and lifts the tool off the surface.
        const byStation = o.wasteByStation || null;
        const wrapLines = o.wrapLines === true;
        // How far across the scan a hull cell may reach for a formable
        // value. The hull includes vertical-wall stamps, which is what
        // stops the over-cut eating an end wall - but unbounded it also
        // shields the severance band, where the model genuinely is not
        // there and cutting through IS the job. One cutting radius keeps
        // the wall fix and returns everything past it to waste.
        // Infinity = legacy unbounded behaviour.
        const reach = Number.isFinite(o.reachCells) ? Math.max(0, o.reachCells) : Infinity;

        const INF = 1 << 29;
        const waste = new Uint8Array(values.length);
        const dist = new Int32Array(lines);
        const src = new Int32Array(lines);
        let retargeted = 0, wasted = 0, wasteMin = Infinity;

        // Waste FALLS to wasteValue; it never rises to it. Both spaces are
        // min-is-deeper (planar cut depth, cylindrical radius) and the
        // compensator is max-plus, so a waste constant shallower than a real
        // surface within one kernel radius out-bids that surface and lifts
        // it - the whole below-axis half of an indexed face collapsing onto
        // the severance plane. The seed is the builder's own floor (blank
        // radius / deepest covered plane), which is <= every covered target
        // by construction, so min() is the only safe write.

        for (let st = 0; st < length; st++) {
            let any = false;
            for (let L = 0; L < lines; L++) {
                const i = idxOf(L, st);
                if (mask[i]) { dist[L] = 0; src[L] = L; any = true; }
                else { dist[L] = INF; src[L] = -1; }
            }

            const wv = byStation ? byStation[st] : wasteValue;

            if (!any) {
                for (let L = 0; L < lines; L++) {
                    const i = idxOf(L, st);
                    if (!hull[i]) { values[i] = wv; waste[i] = 1; wasted++; continue; }
                    if (st > 0) { values[i] = values[idxOf(L, st - 1)]; retargeted++; }
                }
                continue;
            }

            const laps = wrapLines ? lines * 2 : lines;
            for (let k = 0; k < laps; k++) {
                const L = k % lines;
                const pL = (L - 1 + lines) % lines;
                if (!wrapLines && L === 0) continue;
                if (dist[pL] + 1 < dist[L]) { dist[L] = dist[pL] + 1; src[L] = src[pL]; }
            }
            for (let k = laps - 1; k >= 0; k--) {
                const L = k % lines;
                const nL = (L + 1) % lines;
                if (!wrapLines && L === lines - 1) continue;
                if (dist[nL] + 1 < dist[L]) { dist[L] = dist[nL] + 1; src[L] = src[nL]; }
            }

            for (let L = 0; L < lines; L++) {
                const i = idxOf(L, st);
                if (mask[i]) continue;
                if (hull[i] && src[L] >= 0 && dist[L] <= reach) {
                    values[i] = values[idxOf(src[L], st)];
                    retargeted++;
                } else {
                    values[i] = wv;
                    waste[i] = 1;
                    wasted++;
                }
            }
        }
        return { waste, retargeted, wasted, wasteMin };
    }

    // ════════════════════════════════════════════════════════════════
    // rowEdges - first/last position along each scan line where the
    // footprint starts a run of `runLen` consecutive set cells.
    //
    // Both generators anchor their end zones per scan line rather than on
    // a global bounding box: a bounding box puts the end band past every
    // line that ends early, which on any end that is not a flat face
    // perpendicular to the axis is most of them. The run gate rejects
    // single-cell pinholes without trimming genuinely thin tips.
    //
    // idxOf(line, pos) → flat index, so callers keep their own axis
    // convention (rotary scans columns within a θ row; the axial block's
    // axis depends on axialGridAxis).
    // ════════════════════════════════════════════════════════════════
    function rowEdges(mask, lines, length, runLen, idxOf) {
        const first = new Int32Array(lines).fill(-1);
        const last  = new Int32Array(lines).fill(-1);
        const n = Math.max(1, runLen | 0);
        for (let L = 0; L < lines; L++) {
            let run = 0;
            for (let p = 0; p < length; p++) {
                if (mask[idxOf(L, p)]) {
                    if (++run >= n) { first[L] = p - n + 1; break; }
                } else run = 0;
            }
            run = 0;
            for (let p = length - 1; p >= 0; p--) {
                if (mask[idxOf(L, p)]) {
                    if (++run >= n) { last[L] = p + n - 1; break; }
                } else run = 0;
            }
        }
        return { first, last };
    }

    // ════════════════════════════════════════════════════════════════
    // makeStageScaler - one job, several sequential 0→1 sweeps, one bar.
    //
    // A field job's progress is NOT a single ramp. The slicer sweeps
    // 0→1 over its columns, then FieldCompensator sweeps 0→1 over the
    // coarse lattice, then 0→1 again over the fine pass, then 0→1 again
    // upsampling. Handing those to a progress bar raw produces the
    // sawtooth ("weird back and forth") and no receiver-side rule can
    // undo it - the receiver cannot know a reset to 0 means "next stage"
    // rather than "restarted".
    //
    // So map each stage onto a fixed band of the global 0..1. Bands are
    // ordered and disjoint; a stage that never runs (upsample at
    // lattice 1) simply leaves its band unvisited, which reads as a jump
    // and is honest. Untagged ticks pass through the widest band so an
    // unconverted emitter degrades to today's behaviour instead of
    // vanishing.
    //
    // Weights are wall-clock guesses from a 1024-grid ball-nose job;
    // compensation dominates. They only affect bar smoothness.
    // ════════════════════════════════════════════════════════════════
    const STAGE_BANDS = {
        slice:      [0.00, 0.30],
        compensate: [0.30, 0.88],
        upsample:   [0.88, 0.95],
        emit:       [0.95, 1.00]
    };

    function makeStageScaler(onProgress) {
        if (!onProgress) return null;
        return (p) => {
            if (!p) return;
            const band = STAGE_BANDS[p.stage] || STAGE_BANDS.compensate;
            const local = Math.min(1, Math.max(0, p.frac || 0));
            onProgress({
                frac: band[0] + (band[1] - band[0]) * local,
                label: p.label || 'Working'
            });
        };
    }

    // ════════════════════════════════════════════════════════════════
    // Axial end handling - shared by RotaryGenerator and the axial
    // block of ReliefGenerator.
    //
    // Both terminate a model the same way: take each cross row's own
    // first/last covered station, widen the machinable window by each
    // end's reach, and write a lip or taper band anchored on that row's
    // edge. Only the VALUE SPACE differs - radius from the rotation axis
    // vs depth below the face plane - so that is all the callers supply,
    // as three closures. Window, per-row edges, inward reference scan,
    // band bounds and inZone bookkeeping live here. Two copies of this is
    // how the two generators drifted apart four separate ways.
    //
    // Index convention matches rowEdges: idxOf(row, station).
    // ════════════════════════════════════════════════════════════════

    /**
     * Model span + machinable window from each end's reach.
     *
     * @param {Object} o
     * @param {Uint8Array} o.footprint - ANY model presence. Radial passes
     *        cm.hull ?? cm.mask (a gated end cap still means the model
     *        reaches here); the planar side has no hull channel and passes
     *        coverage, which is the known degradation.
     * @param {number}   o.lines      - cross rows (θ rays / cross cells)
     * @param {number}   o.length     - stations along the rotary axis
     * @param {Function} o.idxOf      - (row, station) → flat index
     * @param {number}   o.cellMm     - mm per station
     * @param {number}   o.edgeRun    - rowEdges noise-rejection run length
     * @param {number}   o.reachFloor - min reach for non-'stop' ends (cutR)
     * @param {Object}   o.ends       - resolveWorkholding().ends
     * @returns {Object} { ok, empty, m0, m1, c0, c1, rowFirst, rowLast,
     *                     unitsOf, reachOf }
     */
    function resolveFieldWindow(o) {
        const { footprint, lines, length, idxOf, cellMm, edgeRun,
                reachFloor, ends } = o;

        const unitsOf = (mm) => Math.round(mm / cellMm);
        const { first: rowFirst, last: rowLast } =
            rowEdges(footprint, lines, length, edgeRun, idxOf);

        // Per row, not a 1-D bounding box: every row that ends early (a
        // dome, a point, a taper, an off-centre base) would otherwise have
        // the stations between its own edge and the global m1 treated as
        // in-span, and the end band written past it.
        let m0 = length, m1 = -1;
        for (let L = 0; L < lines; L++) {
            if (rowFirst[L] < 0) continue;
            if (rowFirst[L] < m0) m0 = rowFirst[L];
            if (rowLast[L]  > m1) m1 = rowLast[L];
        }
        if (m1 < 0) return { ok: false, empty: true, unitsOf };

        // 'stop' carries its own SIGNED reach from the resolver: 0 ends
        // the window on the model's own edge, negative trims inward. Do
        // not floor it at the cutting radius - that is what made a 'stop'
        // end machine one tool radius out over the fixture. 'lip' and
        // 'free' ARE floored there: their falloff lives outside the
        // silhouette and the tool must reach across it.
        const reachOf = (end) => (end.mode === 'stop')
            ? (end.reach || 0)
            : Math.max(reachFloor, end.reach || 0);

        const c0 = Math.max(0, m0 - unitsOf(reachOf(ends.chuck)));
        const c1 = Math.min(length - 1, m1 + unitsOf(reachOf(ends.tail)));

        return { ok: c1 > c0, empty: false, m0, m1, c0, c1,
                 rowFirst, rowLast, unitsOf, reachOf };
    }

    /**
     * Writes the explicit 'lip' end bands into `target` and returns
     * inZone. 'stub' and 'free' write nothing - a stop's signed reach
     * already moved the window in the resolver, and a free end's falloff
     * is the waste fill (radial) / per-station floor (axial) plus the
     * tool profile: composing a band for it re-created the old taper
     * cone, whose toRadius/fromRadius round-trip clamped at the axis on
     * any planar face whose surface passes it.
     *
     * @param {Object} o
     * @param {Float32Array} o.target   - written IN PLACE
     * @param {Uint8Array}   o.coverage - formable surface only, NOT the
     *        footprint: the edge index sits on the footprint and a gated
     *        tip holds the waste value there, so reading it directly
     *        grooves from waste, not from the part edge.
     * @param {number}   o.lines, o.length
     * @param {Function} o.idxOf      - (row, station) → flat index
     * @param {Function} o.unitsOf    - from resolveFieldWindow
     * @param {Function} o.reachOf    - from resolveFieldWindow
     * @param {Int32Array} o.rowFirst, o.rowLast
     * @param {Object}   o.ends
     * @param {Function} o.lipValue   - (ref, amountMm) → value
     * @returns {Uint8Array} inZone
     */
    function writeFieldEndZones(o) {
        const { target, coverage, lines, length, idxOf, unitsOf, reachOf,
                rowFirst, rowLast, ends } = o;
        const inZone = new Uint8Array(lines * length);

        // BOUNDED BY THE END'S REACH. Anchored per row, an unbounded band
        // writes a plateau from every early-ending row out to the grid
        // edge; a large value wins the max-plus compensation, shoulders
        // the real surface beside it and drags the deepest value with it.
        const write = (end, edges, outward) => {
            if (end.material !== 'lip') return;
            const amount = Math.max(0, end.mm || 0);
            const band = Math.max(1, unitsOf(reachOf(end)));

            for (let L = 0; L < lines; L++) {
                const e = edges[L];
                if (e < 0) continue;

                let ref = target[idxOf(L, e)];
                for (let s = 0; s <= band; s++) {
                    const p = outward ? e - s : e + s;
                    if (p < 0 || p >= length) break;
                    if (coverage[idxOf(L, p)]) { ref = target[idxOf(L, p)]; break; }
                }

                const a = outward ? e + 1 : Math.max(0, e - band);
                const b = outward ? Math.min(length - 1, e + band) : e - 1;
                if (a > b) continue;

                for (let p = a; p <= b; p++) {
                    const i = idxOf(L, p);
                    target[i] = o.lipValue(ref, amount);
                    inZone[i] = 1;
                }
            }
        };
        write(ends.chuck, rowFirst, false);
        write(ends.tail,  rowLast,  true);
        return inZone;
    }

    ROOT.STAGE_BANDS = STAGE_BANDS;
    ROOT.makeStageScaler = makeStageScaler;

    ROOT.rowEdges = rowEdges;
    ROOT.dilateMask = dilateMask;
    ROOT.ScalarField = ScalarField;
    ROOT.fillFromFootprint = fillFromFootprint;
    ROOT.resolveFieldWindow = resolveFieldWindow;
    ROOT.writeFieldEndZones = writeFieldEndZones;
    ROOT.createFieldView = createFieldView;
    ROOT.FieldCompensator = FieldCompensator;
})();