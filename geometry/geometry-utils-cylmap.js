/*!
 * @file        geometry/geometry-utils-cylmap.js
 * @description Cylindrical radius map container + on-demand mesh
 *              slicer + CylMapPrimitive wrapper - the rotary analogue
 *              of geometry-utils-heightmap.js.
 *
 *              CylMap stores the part radius R(x, θ) on a uniform grid:
 *              columns = axial position (mm, clamped), rows = angle
 *              (PERIODIC). Radii are LITERAL dimensions - there is no
 *              normalize(); a chess piece keeps its real proportions.
 *
 *              CylMapBuilder.fromMesh ray-casts the triangle soup
 *              outward from the rotation axis: slice into X-slabs,
 *              intersect each column plane into 2D segments, cast one
 *              ray per angular cell and keep the FARTHEST hit (nearer
 *              surfaces are occluded - exactly what a radially
 *              approaching tool can reach; undercuts fill silently,
 *              same contract as the flat heightmap's max-Z).
 *
 *              Indexed-3+1 hook: fromMesh accepts an `orient` 3x3
 *              rotation applied to every vertex before slicing, and the
 *              coverage mask records which cells this view direction
 *              actually sees - multi-setup jobs mask per setup instead
 *              of forking the engine.
 *
 *              Depends on: geometry-utils-field.js (ScalarField),
 *              geometry-utils-heightmap.js (FieldPrimitiveBase).
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

    const TWO_PI = Math.PI * 2;

    // ════════════════════════════════════════════════════════════════
    // CylMap - R(x, θ) grid. wrapRows (θ) is periodic; columns clamp.
    // ════════════════════════════════════════════════════════════════
    class CylMap extends ROOT.ScalarField {
        /**
         * @param {number} cols      - axial cells
         * @param {number} rows      - angular cells (periodic)
         * @param {number} cellX     - mm per axial cell
         * @param {number} originX   - world X of column 0's center
         * @param {number} refRadius - blank/reference radius (mm). The
         *        developed-coordinate scale: arc = θ · refRadius.
         */
        constructor(cols, rows, cellX, originX, refRadius) {
            super(cols, rows, { wrapRows: true, withMask: true });
            this.cellX = cellX;
            this.dTheta = TWO_PI / rows;
            this.originX = originX;
            this.refRadius = refRadius;
            this.minR = 0;
            this.maxR = 0;
            // Rotation-axis record (post-orient, world coords):
            //   axis  - workspace rotation axis ('x' | 'y')
            //   axisB - axis line, first cross-section dim (world y for
            //           axis 'x', world x for axis 'y')
            //   axisC - axis line, second cross-section dim (world z)
            // Consumed by the display wrap now and the θ→A machine pass later.
            this.axis = 'x';
            this.axisB = 0;
            this.axisC = 0;
            this.meta = { uncovered: 0, clippedHigh: 0 };
            // Footprint ("hull") mask: 1 = the ray at this (x,θ) intersects
            // the mesh SOMEWHERE - recorded before the radiality gate and
            // hull culling reject the hit. Distinguishes "model present but
            // not formable" (hold the surrounding surface) from "no model on
            // this ray at all" (waste → stub). Serialized by field-worker's
            // rotary record; rehydrated alongside data/mask.
            this.hull = null;
        }

        cellXAt(ix) { return this.originX + ix * this.cellX; }

        /** Developed arc length at row j - AFFINE, extrapolates freely
         *  (spiralFinish walks j past rows for the unwound helix). */
        arcAt(j) { return j * this.dTheta * this.refRadius; }

        get cellArc() { return this.dTheta * this.refRadius; }

        get circumference() { return TWO_PI * this.refRadius; }

        /** Bounds of the developed (unrolled) strip. */
        developedBounds() {
            return {
                minX: this.originX - this.cellX / 2,
                minY: 0,
                maxX: this.originX + (this.cols - 0.5) * this.cellX,
                maxY: this.circumference
            };
        }

        /** min/max radius over covered cells. */
        refreshStats() {
            const { min, max } = this.stats(true);
            this.minR = min;
            this.maxR = max;
            return this;
        }
    }

    // ════════════════════════════════════════════════════════════════
    // CylMapBuilder
    // ════════════════════════════════════════════════════════════════
    const CylMapBuilder = {

        /**
         * @param {Float32Array} triangles - 9 floats per triangle,
         *        workspace coordinates (XY from syncPrimitives transform,
         *        Z = model height axis).
         * @param {Object} options
         * @param {string} [options.axis='x']  - workspace axis that is the
         *        rotation axis. Recorded on the CylMap for downstream; the
         *        actual frame mapping is done by `orient` (the caller
         *        composes it - see ShapeRotaryHandler.getInternalOrient).
         * @param {Float32Array|Array} [options.orient] - row-major 3x3
         *        rotation applied to every vertex FIRST. Must be a pure
         *        rotation (det +1): a reflection would invert θ against the
         *        machine's right-hand rule and flip the winding vote.
         * @param {Object} [options.axisCenter] - {b, c}: cross-section
         *        center in the two non-axial dims (post-orient: b = y,
         *        c = z). Default: bounds center.
         * @param {number} [options.cellSize]     - mm per axial cell;
         *        0/omitted = auto from gridMaxDim.
         * @param {number} [options.gridMaxDim=1024] - axial cell-count cap
         *        for auto cellSize.
         * @param {number} [options.rows]         - angular cells; default
         *        sized so the arc cell at refRadius ≈ cellX, clamped to
         *        [64, 8192].
         * @param {number} [options.refRadius]    - blank radius (mm);
         *        0/omitted = auto (max radial vertex distance).
         * @param {number} [options.coreRadius=0.01] - radii clip floor.
         * @param {number} [options.minRadiality=0] - reject triangles whose
         *        normal is within asin(√v) of the rotation axis (sin²
         *        threshold). 0 = off.
         * @returns {CylMap}
         */
        fromMesh(triangles, options = {}) {
            const t0 = performance.now();
            const orient = options.orient || null;

            const nVerts = (triangles.length / 3) | 0;
            const vx = new Float32Array(nVerts);
            const vy = new Float32Array(nVerts);
            const vz = new Float32Array(nVerts);

            // Pass A: transform vertices into SoA + gather bounds, fused.
            // Transform3D branch-hoists the null-matrix case and returns the
            // extents from the same sweep.
            const T3 = ROOT.Transform3D;
            const b = T3.transformPointsSoA(triangles, orient, null, vx, vy, vz);
            let minX = b.minX, maxX = b.maxX;
            let minY = b.minY, maxY = b.maxY;
            let minZ = b.minZ, maxZ = b.maxZ;

            // Cell size derives from the MODEL's axial extent, BEFORE
            // padding - end reach must not change resolution over the part,
            // nor the angular row count derived from cellX below (it used
            // to halve BOTH on a long stub).
            const extXraw = maxX - minX;
            if (!(extXraw > 0)) throw new Error('Mesh has degenerate axial extent');
            const gridMaxDim = options.gridMaxDim || 1024;
            const cellX = Math.max(
                options.cellSize || extXraw / gridMaxDim,
                0.005
            );

            // Per-end axial padding: { low, high } in mm. low = the CHUCK
            // end of the internal axial X (chuck = LOW end, both
            // kinematics), high = tail. A bare number pads both ends
            // (legacy/direct callers).
            const pad = options.padding || 0;
            const padLow  = (typeof pad === 'object') ? (pad.low  || 0) : pad;
            const padHigh = (typeof pad === 'object') ? (pad.high || 0) : pad;
            minX -= padLow;
            maxX += padHigh;
            const extX = maxX - minX;

            const b0 = (options.axisCenter?.b ?? (minY + maxY) / 2) + (options.axisOffset?.b || 0);
            const c0 = (options.axisCenter?.c ?? (minZ + maxZ) / 2) + (options.axisOffset?.c || 0);

            // Pass B: max radial distance from the axis line
            let rMax = 0;
            for (let v = 0; v < nVerts; v++) {
                const r = Math.hypot(vy[v] - b0, vz[v] - c0);
                if (r > rMax) rMax = r;
            }
            if (!(rMax > 0)) throw new Error('Mesh is degenerate about the rotation axis');

            const refRadius = (options.refRadius > 0) ? options.refRadius : rMax;
            const minRadius = Math.max(options.coreRadius ?? 0.01, 1e-6);

            const cols = Math.max(2, Math.ceil(extX / cellX) + 1);
            const rows = options.rows ||
                Math.min(8192, Math.max(64, Math.round(TWO_PI * refRadius / cellX)));

            const cm = new CylMap(cols, rows, cellX, minX, refRadius);
            cm.axis = options.axis === 'y' ? 'y' : 'x';
            cm.axisB = b0;
            cm.axisC = c0;
            const dTheta = TWO_PI / rows;
            const sinTh = new Float64Array(rows);
            const cosTh = new Float64Array(rows);

            for (let j = 0; j < rows; j++) {
                const angle = j * dTheta;
                sinTh[j] = Math.sin(angle);
                cosTh[j] = Math.cos(angle);
            }
            const data = cm.data;
            const mask = cm.mask;
            data.fill(refRadius); // uncovered cells sit at the blank surface
            const hull = new Uint8Array(cols * rows);
            cm.hull = hull;

            // Slab binning + per-triangle facing. nu/nv hold each
            // triangle normal's cross-section (u,v) components, unit-
            // normalized; (0,0) marks "facing unknown" (normal ~axial -
            // the column plane grazes the triangle) and the ray test
            // fails OPEN on those. vol6 accumulates 6x the mesh's signed
            // volume on the SAME transformed vertices. `orient` is a pure
            // rotation (det +1) so handedness is preserved and the sign IS
            // the source mesh's winding convention (STL winding is
            // unreliable; a divergence-theorem vote is robust and costs one
            // add per triangle).
            const bins = new Array(cols);
            const nTris = (nVerts / 3) | 0;
            const nu = new Float32Array(nTris);
            const nv = new Float32Array(nTris);
            const rad2 = new Float32Array(nTris); // sin² (normal vs rotation axis)
            let vol6 = 0;
            for (let t = 0; t < nTris; t++) {
                const a = t * 3;
                const x0 = vx[a], x1 = vx[a + 1], x2 = vx[a + 2];

                // Facing: N = e1 x e2 on post-orient vertices
                const e1x = x1 - x0, e1y = vy[a + 1] - vy[a], e1z = vz[a + 1] - vz[a];
                const e2x = x2 - x0, e2y = vy[a + 2] - vy[a], e2z = vz[a + 2] - vz[a];
                const nX = e1y * e2z - e1z * e2y;   // axial component
                const nU = e1z * e2x - e1x * e2z;   // u (= y) component
                const nV = e1x * e2y - e1y * e2x;   // v (= z) component
                const uv2 = nU * nU + nV * nV;
                const n2 = uv2 + nX * nX;
                rad2[t] = n2 > 1e-30 ? uv2 / n2 : 0;
                if (uv2 > 1e-6 * n2) {
                    const inv = 1 / Math.sqrt(uv2);
                    nu[t] = nU * inv;
                    nv[t] = nV * inv;
                }

                // Signed volume contribution: v0 · (v1 x v2)
                vol6 += vx[a] * (vy[a + 1] * vz[a + 2] - vz[a + 1] * vy[a + 2])
                      + vy[a] * (vz[a + 1] * vx[a + 2] - vx[a + 1] * vz[a + 2])
                      + vz[a] * (vx[a + 1] * vy[a + 2] - vy[a + 1] * vx[a + 2]);

                const tMin = Math.min(x0, x1, x2), tMax = Math.max(x0, x1, x2);
                let i0 = Math.max(0, Math.ceil((tMin - minX) / cellX - 1e-9));
                let i1 = Math.min(cols - 1, Math.floor((tMax - minX) / cellX + 1e-9));
                for (let i = i0; i <= i1; i++) {
                    (bins[i] || (bins[i] = [])).push(t);
                }
            }
            // Winding vote: a closed mesh with outward normals has
            // positive signed volume. Near-zero = degenerate/open mesh -
            // record it; hull culling still fail-opens per triangle.
            const windingSign = vol6 >= 0 ? 1 : -1;
            cm.meta.warnings = cm.meta.warnings || [];
            if (Math.abs(vol6) < 1e-9) {
                cm.meta.warnings.push('Mesh winding is ambiguous (near-zero ' +
                    'signed volume) - hull culling may be unreliable on this model.');
            }

            // Radiality gate: faces within ~asin(√minRad2) of axial are
            // end caps / tilted base planes a radial tool cannot form -
            // reject them BEFORE the facing cull (their in-plane normals
            // are the ill-conditioned ones). 0 = gate off.
            const minRad2 = options.minRadiality || 0;

            // Per column: plane-intersect triangles → 2D segments (u, v)
            // relative to the axis, then ray-cast per angular cell.
            const EPS = 1e-9;
            const segs = []; // reused: [u0, v0, u1, v1, ...]
            let coveredCells = 0, clippedHigh = 0;

            // Ray from origin along (sinθ, cosθ) vs segment PQ.
            // Returns distance t along the ray, or -1.
            const rayHit = (s, c, pu, pv, qu, qv) => {
                const eu = qu - pu, ev = qv - pv;
                const den = s * ev - c * eu;
                if (Math.abs(den) < 1e-12) return -1;   // parallel
                const t = (pu * ev - pv * eu) / den;    // distance along ray
                const w = (pu * c - pv * s) / den;      // 0..1 along segment
                return (w >= -1e-9 && w <= 1 + 1e-9 && t > 0) ? t : -1;
            };

            for (let ix = 0; ix < cols; ix++) {
                if (options.onProgress && (ix & 63) === 0) {
                    options.onProgress({ frac: ix / cols, label: 'Slicing mesh',
                                         stage: 'slice' });
                }
                const bin = bins[ix];
                if (!bin) continue;
                const xi = minX + ix * cellX;
                segs.length = 0;

                for (let bIdx = 0; bIdx < bin.length; bIdx++) {
                    const a = bin[bIdx] * 3;
                    const d0 = vx[a] - xi, d1 = vx[a + 1] - xi, d2 = vx[a + 2] - xi;

                    // Triangle lying in the plane: skip (neighbors catch it)
                    if (Math.abs(d0) < EPS && Math.abs(d1) < EPS && Math.abs(d2) < EPS) continue;

                    // Collect the (up to 2) crossing points of the 3 edges
                    let n = 0, u0 = 0, v0 = 0, u1 = 0, v1 = 0;
                    const cross = (i, j, di, dj) => {
                        let pu, pv;
                        if (Math.abs(di) < EPS) {              // vertex on plane
                            pu = vy[a + i] - b0; pv = vz[a + i] - c0;
                        } else if (di * dj < 0) {              // edge crosses
                            const f = di / (di - dj);
                            pu = (vy[a + i] + f * (vy[a + j] - vy[a + i])) - b0;
                            pv = (vz[a + i] + f * (vz[a + j] - vz[a + i])) - c0;
                        } else return;
                        // Dedupe (vertex-on-plane hits twice via its edges)
                        if (n === 1 && Math.abs(pu - u0) < 1e-9 && Math.abs(pv - v0) < 1e-9) return;
                        if (n === 0) { u0 = pu; v0 = pv; n = 1; }
                        else if (n === 1) { u1 = pu; v1 = pv; n = 2; }
                    };
                    cross(0, 1, d0, d1);
                    if (n < 2) cross(1, 2, d1, d2);
                    if (n < 2) cross(2, 0, d2, d0);
                    if (n === 2) segs.push(u0, v0, u1, v1, bin[bIdx]);
                }
                if (segs.length === 0) continue;

                // Ray-cast: each segment only over its angular span
                // (directions hitting a segment not containing the origin
                // form the SHORTER arc between its endpoint directions).
                const rowBase = ix; // column-major access via j*cols+ix
                for (let sgi = 0; sgi < segs.length; sgi += 5) {
                    const pu = segs[sgi],     pv = segs[sgi + 1];
                    const qu = segs[sgi + 2], qv = segs[sgi + 3];
                    const tri = segs[sgi + 4] | 0;

                    // Radiality gate becomes a FLAG, not a skip: gated
                    // segments still record footprint (the model exists on
                    // those rays - end caps, tilted bases), they just never
                    // write formable radii. Costs rayHit on gated triangles
                    // only (typically the few end-cap faces).
                    const gated = rad2[tri] < minRad2;

                    let ta = Math.atan2(pu, pv); if (ta < 0) ta += TWO_PI;
                    let tb = Math.atan2(qu, qv); if (tb < 0) tb += TWO_PI;
                    let d = tb - ta; d = ((d % TWO_PI) + TWO_PI) % TWO_PI;
                    if (d > Math.PI) { const t = ta; ta = tb; tb = t; d = TWO_PI - d; }

                    const j0 = Math.floor(ta / dTheta) - 1;
                    const j1 = j0 + Math.ceil(d / dTheta) + 2; // pad 1 cell each side
                    for (let j = j0; j <= j1; j++) {
                        let jj = j % rows; if (jj < 0) jj += rows;
                        const t = rayHit(sinTh[jj], cosTh[jj], pu, pv, qu, qv);
                        if (t < 0) continue;
                        const idx = jj * cols + rowBase;
                        // ANY intersection = model on this ray. Entry hits
                        // and gated hits count - footprint is a silhouette
                        // fact, not a formability fact.
                        hull[idx] = 1;
                        if (gated) continue;
                        // Hull culling: keep only exterior-exit faces.
                        // Provably a no-op on watertight sections - it kills
                        // phantom interior hits through open/grazed sections.
                        // f === 0 → facing unknown → fail open, keep the hit.
                        const f = sinTh[jj] * nu[tri] + cosTh[jj] * nv[tri];
                        if (f * windingSign < 0) continue;
                        if (mask[idx] === 0) { mask[idx] = 1; data[idx] = t; coveredCells++; }
                        else if (t > data[idx]) data[idx] = t;   // farthest hit wins
                    }
                }
            }

            // Clip to the physical envelope
            for (let i = 0; i < data.length; i++) {
                if (data[i] > refRadius) { data[i] = refRadius; if (mask[i]) clippedHigh++; }
                else if (data[i] < minRadius) data[i] = minRadius;
            }

            cm.meta.uncovered = cols * rows - coveredCells;
            cm.meta.clippedHigh = clippedHigh;
            // This is the radial twin of the indexed face-plane clamp: model
            // above the blank radius is flattened to the blank SURFACE (z = 0
            // developed) and never cut. It was counted here and printed only
            // in the debug line, so a user-set rotaryBlankDiameter smaller
            // than the model deleted geometry with no visible feedback.
            // Cannot happen under auto (refRadius = rMax).
            if (clippedHigh > 0) {
                const pct = 100 * clippedHigh / Math.max(1, coveredCells);
                cm.meta.warnings.push(`${pct.toFixed(1)}% of the model surface sits ` +
                    `outside the blank radius (${refRadius.toFixed(2)}mm) and was ` +
                    `flattened to the blank surface - that material will not be ` +
                    `machined. Raise rotaryBlankDiameter or set it to 0 (auto).`);
            }
            cm.refreshStats();

            if (debugState.enabled) {
                console.log(`[CylMapBuilder] Mesh → ${cols}x${rows} grid @ ${cellX.toFixed(3)}mm ` +
                    `(refR=${refRadius.toFixed(3)}mm, R∈[${cm.minR.toFixed(3)}, ${cm.maxR.toFixed(3)}], ` +
                    `${cm.meta.uncovered} blank cells` +
                    `${clippedHigh ? `, ${clippedHigh} clipped>blank` : ''}) in ` +
                    `${(performance.now() - t0).toFixed(0)}ms`);
            }
            return cm;
        },

    };

    // ════════════════════════════════════════════════════════════════
    // CylMapPrimitive - operation-pipeline wrapper (bounds = developed
    // strip). The renderer should skip type 'cylmap' gracefully, same
    // contract as 'heightmap'.
    // ════════════════════════════════════════════════════════════════
    class CylMapPrimitive extends ROOT.FieldPrimitiveBase {
        constructor(cylmap, properties = {}) {
            super('cylmap', {
                role: 'rotary_cylmap',
                fill: false,
                stroke: true,
                strokeWidth: 0,
                ...properties
            });
            this.cylmap = cylmap;
        }

        calculateBounds() {
            this.bounds = this.cylmap.developedBounds();
        }
    }

    ROOT.CylMap = CylMap;
    ROOT.CylMapBuilder = CylMapBuilder;
    ROOT.CylMapPrimitive = CylMapPrimitive;
})();