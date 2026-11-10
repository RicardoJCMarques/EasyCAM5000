/*!
 * @file        utils/transform-math-3d.js
 * @description Single source of truth for ALL 3D rotation math in the field
 *              pipeline (relief / rotary / indexed 3+1). The 3D counterpart
 *              of transform-math.js, which owns 2D affine transforms and is
 *              deliberately left alone.
 *              Matrix form: row-major 3x3 as a flat 9-element array
 *               [ m0 m1 m2 ]
 *               [ m3 m4 m5 ] p' = M * p
 *               [ m6 m7 m8 ]
 *              This is the layout CylMapBuilder and HeightmapBuilder already
 *              consume as `options.orient`, so matrices produced here drop
 *              straight into a slice job (including across postMessage - a
 *              plain Array of 9 numbers is structured-clone safe).
 *              SCOPE. This module owns ALGEBRA, not frame POLICY. Which way
 *              a model is laid onto the rotary, and which sign the A word
 *              carries, are application decisions that stay in
 *              ShapeRotaryHandler / ShapeIndexedHandler. They call in here
 *              for every multiply, rotation and vertex transform.
 *              HANDEDNESS. Every rotation this module builds is a PURE
 *              rotation (orthonormal, det +1). That is load-bearing, not
 *              decoration: CylMapBuilder derives theta from atan2 on the
 *              oriented cross-section and votes on mesh winding via a signed
 *              volume. A reflection (det -1) inverts both, which flips the
 *              rotary direction against the machine's right-hand rule and
 *              inverts the hull-culling test.
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
      // Construction
      identity() {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      },

      /** Shared read-only identity. Call identity() for a mutable copy. */
      IDENTITY: Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]),

      clone(m) {
        return m ? [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]] : null;
      },

      isIdentity(m, eps = 1e-12) {
        if (!m) return true; // null IS identity here
        const I = this.IDENTITY;
        for (let i = 0; i < 9; i++) {
          if (Math.abs(m[i] - I[i]) > eps) return false;
        }
        return true;
      },

      // Core operations
      // NULL = IDENTITY throughout. The slice builders treat a missing
      // `orient` as "no frame change" and skip the transform pass
      // entirely (a real optimization - plain relief pays nothing), so
      // the algebra has to agree with that convention or composing an
      // optional rotation would need a branch at every call site.

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

      /** M * v for v = [x, y, z]. Returns a new array. */
      applyVec(m, v) {
        if (!m) return [v[0], v[1], v[2]];
        return [
          m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
          m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
        ];
      },

      det(m) {
        if (!m) return 1;
        return m[0] * (m[4] * m[8] - m[5] * m[7])
             - m[1] * (m[3] * m[8] - m[5] * m[6])
             + m[2] * (m[3] * m[7] - m[4] * m[6]);
      },

      /** Axis rotations - right-hand rule, angle in degrees */
      rotX(deg) {
        return this.rotXRad(deg * DEG);
      },

      rotY(deg) {
        return this.rotYRad(deg * DEG);
      },

      rotZ(deg) {
        return this.rotZRad(deg * DEG);
      },

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
          case 'x':
            return this.rotX(deg);
          case 'y':
            return this.rotY(deg);
          case 'z':
            return this.rotZ(deg);
          default:
            throw new Error(`Transform3D.rotAboutAxis: unknown axis '${axis}'`);
        }
      },

      // Bulk vertex transforms
      // The hot path: one call per vertex per face. An 8-face indexed job
      // on a 100k-triangle mesh runs 2.4M of these, which is why both
      // variants below are branch-hoisted (the null-matrix and null-offset
      // cases never test inside the loop) and why the builders should call
      // these instead of open-coding the multiply a third and fourth time.

      /**
       * p' = M*p - offset, over a packed Float32Array of xyz triplets.
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
       * @param {Float32Array} src - packed xyz triplets
       * @param {Array|null}   m   - row-major 3x3, or null
       * @param {Array|null}   offset - [x,y,z] subtracted AFTER rotation
       * @param {Float32Array} vx, vy, vz - outputs, length src.length/3
       * @returns {{minX,maxX,minY,maxY,minZ,maxZ}}
       */
      transformPointsSoA(src, m, offset, vx, vy, vz) {
        const nVerts = src.length / 3 | 0;
        const ox = offset && offset[0] || 0;
        const oy = offset && offset[1] || 0;
        const oz = offset && offset[2] || 0;
        let minX = 1 / 0, maxX = -1 / 0;
        let minY = 1 / 0, maxY = -1 / 0;
        let minZ = 1 / 0, maxZ = -1 / 0;
        if (m) {
          const m0 = m[0], m1 = m[1], m2 = m[2];
          const m3 = m[3], m4 = m[4], m5 = m[5];
          const m6 = m[6], m7 = m[7], m8 = m[8];
          for (let v = 0; v < nVerts; v++) {
            const b = 3 * v;
            const sx = src[b], sy = src[b + 1], sz = src[b + 2];
            const x = m0 * sx + m1 * sy + m2 * sz - ox;
            const y = m3 * sx + m4 * sy + m5 * sz - oy;
            const z = m6 * sx + m7 * sy + m8 * sz - oz;
            vx[v] = x;
            vy[v] = y;
            vz[v] = z;
            x < minX && (minX = x);
            x > maxX && (maxX = x);
            y < minY && (minY = y);
            y > maxY && (maxY = y);
            z < minZ && (minZ = z);
            z > maxZ && (maxZ = z);
          }
        } else for (let v = 0; v < nVerts; v++) {
          const b = 3 * v;
          const x = src[b] - ox, y = src[b + 1] - oy, z = src[b + 2] - oz;
          vx[v] = x;
          vy[v] = y;
          vz[v] = z;
          x < minX && (minX = x);
          x > maxX && (maxX = x);
          y < minY && (minY = y);
          y > maxY && (maxY = y);
          z < minZ && (minZ = z);
          z > maxZ && (maxZ = z);
        }
        0 === nVerts && (minX = maxX = minY = maxY = minZ = maxZ = 0);
        return {
          minX: minX,
          maxX: maxX,
          minY: minY,
          maxY: maxY,
          minZ: minZ,
          maxZ: maxZ
        };
      },

      /**
       * The affine placement M·p + t, as {m: row-major 3x3, t: [x, y, z]}: a tilt about
       * `pivot` (rotation about X by `tiltX`, then about Y by `tiltY`, degrees), then the 2D
       * similarity `m` {a,b,c,d,e,f} on XY with Z multiplied by `scaleZ`, then `offsetZ` added.
       */
      placement({ tiltX = 0, tiltY = 0, pivot = null, m = null, scaleZ = 1, offsetZ = 0 } = {}) {
        const ma = m ? m.a : 1, mb = m ? m.b : 0, mc = m ? m.c : 0;
        const md = m ? m.d : 1, me = m ? m.e : 0, mf = m ? m.f : 0;
        // M = A·R with A = [[a, c, 0], [b, d, 0], [0, 0, scaleZ]]. The pivot folds into t:
        // A·(R·(p - pivot) + pivot) + (e, f, offsetZ).
        const r = tiltX !== 0 || tiltY !== 0 ? this.mul(this.rotY(tiltY), this.rotX(tiltX)) : this.IDENTITY;
        const [px, py, pz] = pivot || [0, 0, 0];
        const rp = this.applyVec(r, [px, py, pz]);
        const qx = px - rp[0], qy = py - rp[1], qz = pz - rp[2];
        return {
          m: [
            ma * r[0] + mc * r[3], ma * r[1] + mc * r[4], ma * r[2] + mc * r[5],
            mb * r[0] + md * r[3], mb * r[1] + md * r[4], mb * r[2] + md * r[5],
            scaleZ * r[6], scaleZ * r[7], scaleZ * r[8]
          ],
          t: [ma * qx + mc * qy + me, mb * qx + md * qy + mf, scaleZ * qz + offsetZ]
        };
      },

      /**
       * Writes `src` placed by `P` (see placement) into `out` in one pass.
       * @param {Float32Array} src - packed xyz
       * @returns {{minX, minY, minZ, maxX, maxY, maxZ}} the placed bounds
       */
      applyPlacement(src, P, out) {
        const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = P.m;
        const [t0, t1, t2] = P.t;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < src.length; i += 3) {
          const x = src[i], y = src[i + 1], z = src[i + 2];
          const tx = m0 * x + m1 * y + m2 * z + t0;
          const ty = m3 * x + m4 * y + m5 * z + t1;
          const tz = m6 * x + m7 * y + m8 * z + t2;
          out[i] = tx;
          out[i + 1] = ty;
          out[i + 2] = tz;
          if (tx < minX) minX = tx;
          if (tx > maxX) maxX = tx;
          if (ty < minY) minY = ty;
          if (ty > maxY) maxY = ty;
          if (tz < minZ) minZ = tz;
          if (tz > maxZ) maxZ = tz;
        }
        return { minX, minY, minZ, maxX, maxY, maxZ };
      },

      /**
       * Places packed triangles (see placement) in one fused pass. Returns the source array
       * and null bounds when every step is identity.
       * @param {Float32Array} src - packed xyz
       * @returns {{triangles: Float32Array, bounds3D: ?{minX, minY, minZ, maxX, maxY, maxZ}}}
       */
      placeTriangles(src, opts = {}) {
        if (!src || src.length === 0) return { triangles: src, bounds3D: null };
        const { tiltX = 0, tiltY = 0, m = null, scaleZ = 1, offsetZ = 0 } = opts;
        const identity2D = !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0);
        if (tiltX === 0 && tiltY === 0 && identity2D && scaleZ === 1 && offsetZ === 0) return { triangles: src, bounds3D: null };
        const out = new Float32Array(src.length);
        return { triangles: out, bounds3D: this.applyPlacement(src, this.placement(opts), out) };
      },

    /**
     * World triangles of a mesh shape in the flat scene. `t` is the shape's transform record:
     * `rotationX`, then `rotationY` (degrees) tilt the raw mesh about its bounds centre; `m`, the
     * shape's world matrix, places XY and scales Z by its uniform factor; `z` (mm) lifts the
     * result. The flat scene then seats the mesh by its top on the stock surface, so `z` is an
     * offset from that seat, and every consumer adds it back: sourceMesh.offsetZ, refresh3DModel,
     * the transform cue and Fit to Object.
     * TODO(flat-placement): a 'file' seat like rotary.placement's - the mesh keeps its file's
     * Z with Z0 on the stock top, and the grid reads the file's own coordinates.
     */
      placeMesh(mesh, t, m) {
        const b = mesh.bounds3D;
        return this.placeTriangles(mesh.triangles, {
          tiltX: t.rotationX,
          tiltY: t.rotationY,
          pivot: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2],
          m,
          scaleZ: Math.hypot(m.a, m.b),
          offsetZ: t.z
        });
      },

      /**
       * World triangles of a mesh shape in the radial scene, where the rotary axis is the
       * machine axis `frame.axis` through the origin. The shape's rotations and scale orient
       * the mesh; its flat translation plays no part. The oriented mesh is centred on the
       * axis across it and anchored along it by `t.radialAnchor`, else `frame.anchor`:
       * 'chuck' puts the end the chuck holds (`frame.chuckSide`) on 0, 'center' its middle,
       * 'file' keeps the file's own axial coordinate. `t.radialX/Y/Z` move it from there.
       * TODO(rotary-fit): centre on the minimum enclosing circle of the cross-section
       * (Welzl over the convex hull of the vertices projected along the axis) instead of
       * its box - the tightest swept radius, so the smallest blank and the fewest roughing
       * passes - and search the orientation for the same minimum, longest principal axis
       * onto the machine axis first.
       * @returns {{triangles: Float32Array, bounds3D: {minX, minY, minZ, maxX, maxY, maxZ}}}
       */
      placeMeshRadial(mesh, t, m, frame) {
        const b = mesh.bounds3D;
        const P = this.placement({
          tiltX: t.rotationX,
          tiltY: t.rotationY,
          pivot: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2],
          m: { a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0 },
          scaleZ: Math.hypot(m.a, m.b)
        });
        const out = new Float32Array(mesh.triangles.length);
        const o = this.applyPlacement(mesh.triangles, P, out);
        const alongX = frame.axis !== 'y';
        const aMin = alongX ? o.minX : o.minY;
        const aMax = alongX ? o.maxX : o.maxY;
        const anchor = t.radialAnchor || frame.anchor;
        const axial = anchor === 'center' ? -(aMin + aMax) / 2 : anchor === 'chuck' ? -(frame.chuckSide === 'high' ? aMax : aMin) : 0;
        const cross = alongX ? -(o.minY + o.maxY) / 2 : -(o.minX + o.maxX) / 2;
        const dx = (alongX ? axial : cross) + t.radialX;
        const dy = (alongX ? cross : axial) + t.radialY;
        const dz = t.radialZ - (o.minZ + o.maxZ) / 2;
        for (let i = 0; i < out.length; i += 3) {
          out[i] += dx;
          out[i + 1] += dy;
          out[i + 2] += dz;
        }
        return {
          triangles: out,
          bounds3D: {
            minX: o.minX + dx,
            minY: o.minY + dy,
            minZ: o.minZ + dz,
            maxX: o.maxX + dx,
            maxY: o.maxY + dy,
            maxZ: o.maxZ + dz
          }
        };
      },

      /** Largest distance of any vertex from the rotary axis: `axis` ('x' | 'y') through the origin. */
      sweptRadius(src, axis) {
        const lane = axis === 'y' ? 0 : 1; // the cross coordinate: x about a Y axis, y about an X axis
        let r2 = 0;
        for (let i = 0; i < src.length; i += 3) {
          const u = src[i + lane], v = src[i + 2];
          const d = u * u + v * v;
          if (d > r2) r2 = d;
        }
        return Math.sqrt(r2);
      }
  };

  ROOT.Transform3D = Transform3D;
})();