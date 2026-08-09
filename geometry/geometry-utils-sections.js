/*!
 * @file        geometry/geometry-utils-sections.js
 * @description Cross-section stack for axis-based operations. One plane
 *              sweep of the mesh perpendicular to the rotation axis
 *              yields, per axial station, the material cross-section as
 *              raw segments; a 2D rotation + scanline then gives any
 *              face's top envelope z_max(u) exactly - no radiality gate,
 *              no pinholes, no per-face vertex pass.
 *
 *              v1 is VALIDATION ONLY: envelopes are diffed against the
 *              heightmaps the faces actually machined from. Stage 2+
 *              (survey on sections, waste = B \ P, sections over
 *              postMessage) build on this container.
 *
 *              Even-odd everywhere: crossing parity needs no consistent
 *              triangle orientation, so dirty normals degrade gracefully.
 *              Loop chaining (for the later Clipper stages) is separable
 *              and allowed to fail per station without hurting envelopes.
 *
 *              Pure math. No DOM, guarded CAMConfig - worker-loadable.
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

    const SectionSlicer = {

        /**
         * @param {Float32Array} triangles - 9 floats per triangle
         * @param {Object} o
         * @param {number[]|null} o.orient - row-major 3x3 visual orient
         * @param {number[]} o.origin      - [x,y,z] subtracted AFTER orient
         *        (the axis line, e.g. IndexedBlank's Cvis) so sections are
         *        axis-centered
         * @param {boolean} o.uIsX         - cross-u = world X (machine 'y')
         *        or world Y (machine 'x'); cross-v is world Z; axial is
         *        the remaining coordinate
         * @param {number} o.a0            - axial coord of station 0
         * @param {number} o.pitch         - mm between stations
         * @param {number} o.count         - station count
         * @returns {{a0,pitch,count,stations:Array<{segs:Float32Array}>}}
         *        segs = [u0,v0,u1,v1, ...] per station
         */
        fromMesh(triangles, o) {
            const m = o.orient;
            const [cx, cy, cz] = o.origin || [0, 0, 0];
            const uIsX = o.uIsX === true;
            const { a0, pitch, count } = o;
            const nT = (triangles.length / 9) | 0;

            // Pass 1: transform once into (u, v, a); record each triangle's
            // station span and bucket it by its FIRST station only.
            const U = new Float32Array(nT * 3);
            const V = new Float32Array(nT * 3);
            const A = new Float32Array(nT * 3);
            const s0 = new Int32Array(nT);
            const s1 = new Int32Array(nT);
            const startCount = new Int32Array(count);
            let live = 0;

            for (let t = 0; t < nT; t++) {
                let aMin = Infinity, aMax = -Infinity;
                for (let k = 0; k < 3; k++) {
                    const j = t * 9 + k * 3;
                    let x = triangles[j], y = triangles[j + 1], z = triangles[j + 2];
                    if (m) {
                        const ox = m[0] * x + m[1] * y + m[2] * z;
                        const oy = m[3] * x + m[4] * y + m[5] * z;
                        const oz = m[6] * x + m[7] * y + m[8] * z;
                        x = ox; y = oy; z = oz;
                    }
                    x -= cx; y -= cy; z -= cz;
                    const i = t * 3 + k;
                    U[i] = uIsX ? x : y;
                    A[i] = uIsX ? y : x;
                    V[i] = z;
                    if (A[i] < aMin) aMin = A[i];
                    if (A[i] > aMax) aMax = A[i];
                }
                let lo = Math.ceil((aMin - a0) / pitch);
                let hi = Math.floor((aMax - a0) / pitch);
                if (lo < 0) lo = 0;
                if (hi > count - 1) hi = count - 1;
                s1[t] = hi;
                if (lo <= hi) { s0[t] = lo; startCount[lo]++; live++; }
                else s0[t] = -1;
            }

            // CSR over START stations - each triangle appears ONCE. Binning
            // into every station it spans made this list O(T x stations); a
            // coarse mesh whose triangles run the length of the part (a
            // cylinder wall is two of them) put that in the hundreds of
            // millions.
            const startAt = new Int32Array(count + 1);
            for (let s = 0; s < count; s++) startAt[s + 1] = startAt[s] + startCount[s];
            const starts = new Int32Array(live);
            const cursor = startAt.slice(0, count);
            for (let t = 0; t < nT; t++) if (s0[t] >= 0) starts[cursor[s0[t]]++] = t;

            // Pass 2: active-edge sweep. Triangles enter at their first
            // station and are compacted out in the same walk that emits, so
            // the cost is O(T + sum of active-set sizes) with no replication.
            //
            // Vertex-on-plane guard: |d| < EPS is pushed to the POSITIVE
            // side, consistently, so a touching vertex yields a well-formed
            // (tiny) crossing pair instead of a degenerate case per shape.
            const EPS = 1e-7;
            const stations = new Array(count);
            let active = new Int32Array(64);
            let nAct = 0;

            for (let s = 0; s < count; s++) {
                const add = startAt[s + 1] - startAt[s];
                if (nAct + add > active.length) {
                    let cap = active.length;
                    while (cap < nAct + add) cap *= 2;
                    const grown = new Int32Array(cap);
                    grown.set(active.subarray(0, nAct));
                    active = grown;
                }
                for (let b = startAt[s]; b < startAt[s + 1]; b++) active[nAct++] = starts[b];

                const plane = a0 + s * pitch;
                const out = [];
                let w = 0;
                for (let a = 0; a < nAct; a++) {
                    const t = active[a];
                    if (s1[t] < s) continue;      // expired - drop
                    active[w++] = t;              // survives this station

                    const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2;
                    let d0 = A[i0] - plane, d1 = A[i1] - plane, d2 = A[i2] - plane;
                    if (d0 > -EPS && d0 < EPS) d0 = EPS;
                    if (d1 > -EPS && d1 < EPS) d1 = EPS;
                    if (d2 > -EPS && d2 < EPS) d2 = EPS;
                    const p0 = d0 > 0, p1 = d1 > 0, p2 = d2 > 0;
                    if (p0 === p1 && p1 === p2) continue;

                    let pu = 0, pv = 0, qu = 0, qv = 0, n = 0;
                    if (p0 !== p1) {
                        const f = d0 / (d0 - d1);
                        pu = U[i0] + f * (U[i1] - U[i0]);
                        pv = V[i0] + f * (V[i1] - V[i0]);
                        n = 1;
                    }
                    if (p1 !== p2) {
                        const f = d1 / (d1 - d2);
                        const eu = U[i1] + f * (U[i2] - U[i1]);
                        const ev = V[i1] + f * (V[i2] - V[i1]);
                        if (n === 0) { pu = eu; pv = ev; n = 1; }
                        else { qu = eu; qv = ev; n = 2; }
                    }
                    if (n < 2 && p2 !== p0) {
                        const f = d2 / (d2 - d0);
                        qu = U[i2] + f * (U[i0] - U[i2]);
                        qv = V[i2] + f * (V[i0] - V[i2]);
                        n = 2;
                    }
                    if (n === 2) out.push(pu, pv, qu, qv);
                }
                nAct = w;
                stations[s] = { segs: Float32Array.from(out) };
            }

            return { a0, pitch, count, stations };
        },

        /**
         * Top envelope z_max(u) of one station, in a face frame given by a
         * 2x2 rotation. Half-open crossing rule ((u0 <= uc) !== (u1 <= uc))
         * so a shared segment endpoint is counted exactly once.
         *
         * @param {Object} station - fromMesh stations[s]
         * @param {Object} o
         * @param {number} o.uu,o.uv,o.vu,o.vv - 2x2 rotation, cross-plane
         *        restriction of the SAME rotAboutAxis the slicer uses
         * @param {number} o.u0    - u of column 0 (face frame)
         * @param {number} o.cell  - mm per column
         * @param {number} o.cols
         * @returns {{top:Float32Array, cover:Uint8Array}} top is -Infinity
         *        where cover=0
         */
        envelopeTop(station, o) {
            const { uu, uv, vu, vv, u0, cell, cols } = o;
            const segs = station.segs;
            const top = new Float32Array(cols).fill(-Infinity);
            const cover = new Uint8Array(cols);

            for (let i = 0; i < segs.length; i += 4) {
                const au = uu * segs[i]     + uv * segs[i + 1];
                const av = vu * segs[i]     + vv * segs[i + 1];
                const bu = uu * segs[i + 2] + uv * segs[i + 3];
                const bv = vu * segs[i + 2] + vv * segs[i + 3];

                const lo = Math.min(au, bu), hi = Math.max(au, bu);
                let c0 = Math.ceil((lo - u0) / cell);
                let c1 = Math.floor((hi - u0) / cell);
                if (c0 < 0) c0 = 0;
                if (c1 > cols - 1) c1 = cols - 1;
                const du = bu - au;
                for (let c = c0; c <= c1; c++) {
                    const uc = u0 + c * cell;
                    if ((au <= uc) === (bu <= uc)) continue;
                    const z = av + ((uc - au) / du) * (bv - av);
                    if (z > top[c]) top[c] = z;
                    cover[c] = 1;
                }
            }
            return { top, cover };
        }
    };

    ROOT.SectionSlicer = SectionSlicer;
})();