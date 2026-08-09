/*!
 * @file        utils/transform-math-3d.js
 * @description Single source of truth for ALL 3D rotation math in the field
 *              pipeline (relief / rotary / indexed 3+1). The 3D counterpart
 *              of transform-math.js, which owns 2D affine transforms and is
 *              deliberately left alone.
 *
 *              Matrix form: row-major 3x3 as a flat 9-element array
 *                  [ m0 m1 m2 ]
 *                  [ m3 m4 m5 ]     p' = M * p
 *                  [ m6 m7 m8 ]
 *              This is the layout CylMapBuilder and HeightmapBuilder already
 *              consume as `options.orient`, so matrices produced here drop
 *              straight into a slice job (including across postMessage - a
 *              plain Array of 9 numbers is structured-clone safe).
 *
 *              SCOPE. This module owns ALGEBRA, not frame POLICY. Which way
 *              a model is laid onto the rotary, and which sign the A word
 *              carries, are application decisions that stay in
 *              ShapeRotaryHandler / ShapeIndexedHandler. They call in here
 *              for every multiply, rotation and vertex transform.
 *
 *              HANDEDNESS. Every rotation this module builds is a PURE
 *              rotation (orthonormal, det +1). That is load-bearing, not
 *              decoration: CylMapBuilder derives theta from atan2 on the
 *              oriented cross-section and votes on mesh winding via a signed
 *              volume. A reflection (det -1) inverts both, which flips the
 *              rotary direction against the machine's right-hand rule and
 *              inverts the hull-culling test. assertRotation() exists to
 *              make that failure loud at the point of construction instead
 *              of silent in a G-code file. Never hand-build an `orient` that
 *              has not been through it.
 *
 *              SIGN CONTRACT (rotAboutAxis). Rotations follow the standard
 *              right-hand rule about +x / +y / +z. The indexed pipeline's
 *              calibration - slicing a face at +theta_k while the preview
 *              wraps with R_axis(-A), because the table turns +A and a
 *              machine point therefore sits at -A in the part frame - is a
 *              CALLER decision and lives in buildFaceSliceOptions. Do not
 *              "fix" a sign in here; it will silently decouple the preview
 *              from the emitted G-code.
 *
 *              No DOM, no CAMConfig, worker-loadable via importScripts().
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

    const DEG = Math.PI / 180;

    const Transform3D = {

        // ════════════════════════════════════════════════════════════
        // Construction
        // ════════════════════════════════════════════════════════════

        identity() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; },

        /** Shared read-only identity. Call identity() for a mutable copy. */
        IDENTITY: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]),

        clone(m) { return m ? [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]] : null; },

        isIdentity(m, eps = 1e-12) {
            if (!m) return true;                      // null IS identity here
            const I = this.IDENTITY;
            for (let i = 0; i < 9; i++) {
                if (Math.abs(m[i] - I[i]) > eps) return false;
            }
            return true;
        },

        // ════════════════════════════════════════════════════════════
        // Core operations
        //
        // NULL = IDENTITY throughout. The slice builders treat a missing
        // `orient` as "no frame change" and skip the transform pass
        // entirely (a real optimization - plain relief pays nothing), so
        // the algebra has to agree with that convention or composing an
        // optional rotation would need a branch at every call site.
        // ════════════════════════════════════════════════════════════

        /** m1 * m2 - m2 is applied to the point FIRST. */
        mul(m1, m2) {
            if (!m1) return m2;
            if (!m2) return m1;
            const o = new Array(9);
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    o[r * 3 + c] = m1[r * 3]     * m2[c]
                                 + m1[r * 3 + 1] * m2[3 + c]
                                 + m1[r * 3 + 2] * m2[6 + c];
                }
            }
            return o;
        },

        /** Left-to-right composition: mulAll(A, B, C) === A*B*C (C first). */
        mulAll(...ms) {
            let out = null;
            for (const m of ms) out = this.mul(out, m);
            return out;
        },

        /** M * v for v = [x, y, z]. Returns a new array. */
        applyVec(m, v) {
            if (!m) return [v[0], v[1], v[2]];
            return [
                m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
                m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
                m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
            ];
        },

        /** In-place variant. Mutates and returns v. Own the array you pass. */
        applyVecMut(m, v) {
            if (!m) return v;
            const x = v[0], y = v[1], z = v[2];
            v[0] = m[0] * x + m[1] * y + m[2] * z;
            v[1] = m[3] * x + m[4] * y + m[5] * z;
            v[2] = m[6] * x + m[7] * y + m[8] * z;
            return v;
        },

        /**
         * Scalar-in / array-out variant for hot loops that hold x, y, z in
         * locals and do not want a temporary per vertex. `out` is written
         * and returned; pass a scratch array you reuse.
         */
        applyXYZ(m, x, y, z, out) {
            const o = out || [0, 0, 0];
            if (!m) { o[0] = x; o[1] = y; o[2] = z; return o; }
            o[0] = m[0] * x + m[1] * y + m[2] * z;
            o[1] = m[3] * x + m[4] * y + m[5] * z;
            o[2] = m[6] * x + m[7] * y + m[8] * z;
            return o;
        },

        transpose(m) {
            if (!m) return null;
            return [m[0], m[3], m[6],
                    m[1], m[4], m[7],
                    m[2], m[5], m[8]];
        },

        det(m) {
            if (!m) return 1;
            return m[0] * (m[4] * m[8] - m[5] * m[7])
                 - m[1] * (m[3] * m[8] - m[5] * m[6])
                 + m[2] * (m[3] * m[7] - m[4] * m[6]);
        },

        /**
         * Inverse. For a rotation this is the transpose, which is what the
         * fast path returns. Falls back to a general 3x3 inverse (used by
         * nothing in the pipeline today - every matrix here is a rotation -
         * but a wrong answer for a scaled matrix would be worse than a slow
         * one). Returns null if singular.
         */
        inverse(m) {
            if (!m) return null;
            if (this.isRotation(m)) return this.transpose(m);
            const d = this.det(m);
            if (Math.abs(d) < 1e-12) return null;
            const i = 1 / d;
            return [
                (m[4] * m[8] - m[5] * m[7]) * i,
                (m[2] * m[7] - m[1] * m[8]) * i,
                (m[1] * m[5] - m[2] * m[4]) * i,
                (m[5] * m[6] - m[3] * m[8]) * i,
                (m[0] * m[8] - m[2] * m[6]) * i,
                (m[2] * m[3] - m[0] * m[5]) * i,
                (m[3] * m[7] - m[4] * m[6]) * i,
                (m[1] * m[6] - m[0] * m[7]) * i,
                (m[0] * m[4] - m[1] * m[3]) * i
            ];
        },

        // ════════════════════════════════════════════════════════════
        // Axis rotations - right-hand rule, angle in degrees
        // ════════════════════════════════════════════════════════════

        rotX(deg) { return this.rotXRad(deg * DEG); },
        rotY(deg) { return this.rotYRad(deg * DEG); },
        rotZ(deg) { return this.rotZRad(deg * DEG); },

        rotXRad(rad) {
            const c = Math.cos(rad), s = Math.sin(rad);
            return [1, 0, 0,
                    0, c, -s,
                    0, s, c];
        },

        rotYRad(rad) {
            const c = Math.cos(rad), s = Math.sin(rad);
            return [c, 0, s,
                    0, 1, 0,
                    -s, 0, c];
        },

        rotZRad(rad) {
            const c = Math.cos(rad), s = Math.sin(rad);
            return [c, -s, 0,
                    s, c, 0,
                    0, 0, 1];
        },

        /**
         * Rotation about a named axis. `axis` is 'x' | 'y' | 'z'; anything
         * else throws rather than quietly returning identity, because a
         * typo'd axis name would produce an unrotated face set that looks
         * almost right.
         */
        rotAboutAxis(axis, deg) {
            switch (axis) {
                case 'x': return this.rotX(deg);
                case 'y': return this.rotY(deg);
                case 'z': return this.rotZ(deg);
                default:
                    throw new Error(`Transform3D.rotAboutAxis: unknown axis '${axis}'`);
            }
        },

        rotAboutAxisRad(axis, rad) {
            switch (axis) {
                case 'x': return this.rotXRad(rad);
                case 'y': return this.rotYRad(rad);
                case 'z': return this.rotZRad(rad);
                default:
                    throw new Error(`Transform3D.rotAboutAxisRad: unknown axis '${axis}'`);
            }
        },

        /** 0 | 1 | 2 for 'x' | 'y' | 'z'. Throws on anything else. */
        axisIndex(axis) {
            const i = { x: 0, y: 1, z: 2 }[axis];
            if (i === undefined) {
                throw new Error(`Transform3D.axisIndex: unknown axis '${axis}'`);
            }
            return i;
        },

        /**
         * The two cross-section axes for a given rotation axis, in the
         * (b, c) order the CylMap records them: b = first cross dim,
         * c = second. 'x' -> ['y','z'], 'y' -> ['x','z'], 'z' -> ['x','y'].
         */
        crossAxes(axis) {
            switch (axis) {
                case 'x': return ['y', 'z'];
                case 'y': return ['x', 'z'];
                case 'z': return ['x', 'y'];
                default:
                    throw new Error(`Transform3D.crossAxes: unknown axis '${axis}'`);
            }
        },

        // ════════════════════════════════════════════════════════════
        // Validation
        // ════════════════════════════════════════════════════════════

        /** Orthonormal with det +1 - i.e. a rotation, not a reflection. */
        isRotation(m, eps = 1e-6) {
            if (!m) return true;                       // identity
            // Rows orthonormal
            for (let r = 0; r < 3; r++) {
                let n = 0;
                for (let c = 0; c < 3; c++) n += m[r * 3 + c] * m[r * 3 + c];
                if (Math.abs(n - 1) > eps) return false;
                for (let q = r + 1; q < 3; q++) {
                    let d = 0;
                    for (let c = 0; c < 3; c++) d += m[r * 3 + c] * m[q * 3 + c];
                    if (Math.abs(d) > eps) return false;
                }
            }
            return Math.abs(this.det(m) - 1) <= eps;
        },

        /**
         * Throwing form for construction sites. `where` is quoted back in
         * the message so a failure names the builder that produced it.
         */
        assertRotation(m, where = 'matrix') {
            if (!this.isRotation(m)) {
                throw new Error(
                    `Transform3D: ${where} is not a pure rotation ` +
                    `(det=${this.det(m).toFixed(6)}). A reflection inverts theta ` +
                    `against the machine's right-hand rule and flips the mesh ` +
                    `winding vote - the rotary would run backwards.`);
            }
            return m;
        },

        // ════════════════════════════════════════════════════════════
        // Bulk vertex transforms
        //
        // The hot path: one call per vertex per face. An 8-face indexed job
        // on a 100k-triangle mesh runs 2.4M of these, which is why both
        // variants below are branch-hoisted (the null-matrix and null-offset
        // cases never test inside the loop) and why the builders should call
        // these instead of open-coding the multiply a third and fourth time.
        // ════════════════════════════════════════════════════════════

        /**
         * p' = M*p - offset, over a packed Float32Array of xyz triplets.
         *
         * @param {Float32Array} src    - packed xyz, length % 3 === 0
         * @param {Array|null}   m      - row-major 3x3, or null for none
         * @param {Array|null}   offset - [x,y,z] subtracted AFTER rotation
         * @param {Float32Array} [dst]  - destination; omit to allocate.
         *        Passing src performs the transform in place.
         * @returns {Float32Array} dst
         */
        transformPoints(src, m, offset, dst) {
            const n = src.length;
            const out = dst || new Float32Array(n);
            const ox = offset ? (offset[0] || 0) : 0;
            const oy = offset ? (offset[1] || 0) : 0;
            const oz = offset ? (offset[2] || 0) : 0;

            if (!m) {
                if (!ox && !oy && !oz) {
                    if (out !== src) out.set(src);
                    return out;
                }
                for (let i = 0; i < n; i += 3) {
                    out[i]     = src[i]     - ox;
                    out[i + 1] = src[i + 1] - oy;
                    out[i + 2] = src[i + 2] - oz;
                }
                return out;
            }

            const m0 = m[0], m1 = m[1], m2 = m[2];
            const m3 = m[3], m4 = m[4], m5 = m[5];
            const m6 = m[6], m7 = m[7], m8 = m[8];
            for (let i = 0; i < n; i += 3) {
                const x = src[i], y = src[i + 1], z = src[i + 2];
                out[i]     = m0 * x + m1 * y + m2 * z - ox;
                out[i + 1] = m3 * x + m4 * y + m5 * z - oy;
                out[i + 2] = m6 * x + m7 * y + m8 * z - oz;
            }
            return out;
        },

        /**
         * Structure-of-arrays variant: transforms packed xyz into three
         * separate component arrays and returns the bounds in one pass.
         * CylMapBuilder wants exactly this shape - it indexes vy/vz per
         * triangle edge during slicing and needs the extents to size the
         * grid - so fusing the transform with the bounds sweep saves a
         * second full pass over the vertex set.
         *
         * @param {Float32Array} src - packed xyz triplets
         * @param {Array|null}   m   - row-major 3x3, or null
         * @param {Array|null}   offset - [x,y,z] subtracted AFTER rotation
         * @param {Float32Array} vx, vy, vz - outputs, length src.length/3
         * @returns {{minX,maxX,minY,maxY,minZ,maxZ}}
         */
        transformPointsSoA(src, m, offset, vx, vy, vz) {
            const nVerts = (src.length / 3) | 0;
            const ox = offset ? (offset[0] || 0) : 0;
            const oy = offset ? (offset[1] || 0) : 0;
            const oz = offset ? (offset[2] || 0) : 0;

            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;

            const m0 = m ? m[0] : 1, m1 = m ? m[1] : 0, m2 = m ? m[2] : 0;
            const m3 = m ? m[3] : 0, m4 = m ? m[4] : 1, m5 = m ? m[5] : 0;
            const m6 = m ? m[6] : 0, m7 = m ? m[7] : 0, m8 = m ? m[8] : 1;

            for (let v = 0; v < nVerts; v++) {
                const b = v * 3;
                const sx = src[b], sy = src[b + 1], sz = src[b + 2];
                let x, y, z;
                if (m) {
                    x = m0 * sx + m1 * sy + m2 * sz - ox;
                    y = m3 * sx + m4 * sy + m5 * sz - oy;
                    z = m6 * sx + m7 * sy + m8 * sz - oz;
                } else {
                    x = sx - ox; y = sy - oy; z = sz - oz;
                }
                vx[v] = x; vy[v] = y; vz[v] = z;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }

            if (nVerts === 0) {
                minX = maxX = minY = maxY = minZ = maxZ = 0;
            }
            return { minX, maxX, minY, maxY, minZ, maxZ };
        },

    };

    ROOT.Transform3D = Transform3D;
})();
