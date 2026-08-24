/*!
 * @file        utils/transform-math.js
 * @description Single source of truth for ALL 2D affine transform math. - REVIEW - rework both coordinate-system and transform-math header comments
 *              Pure stateless functions - no DOM, no scene state, no caches.
 *
 *              Matrix form: m = { a, b, c, d, e, f } representing
 *                  | a c e |
 *                  | b d f |        p' = (a*x + c*y + e,  b*x + d*y + f)
 *                  | 0 0 1 |
 *              Maps directly to ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f).
 *
 *              Workspace convention (machine-verified, matches the old
 *              WorkspaceTransform.forwardPoint): rotate about rotationCenter
 *              by the EFFECTIVE angle (mirror-XOR sign rule), THEN mirror
 *              about mirrorCenter. Origin translation is NEVER baked into
 *              matrices - G-code applies it at generation time; Scene applies
 *              it explicitly in its workspace/world conversions.
 *
 *              Winding: det(m) < 0 ⇔ the transform contains a reflection ⇔
 *              arc/contour winding (CW/CCW) must flip. For the workspace
 *              params this is equivalent to mirrorX XOR mirrorY.
 *
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const TransformMath = {

        // Construction

        identity() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },

        clone(m) { return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }; },

        translation(tx, ty) { return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }; },

        scaling(sx, sy) { return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }; },

        /** Rotation by deg (CCW, Y-up) about pivot (cx, cy): T(c)·R·T(-c). */
        rotationAbout(deg, cx, cy) {
            const r = (deg * Math.PI) / 180;
            const cos = Math.cos(r), sin = Math.sin(r);
            return {
                a: cos, b: sin, c: -sin, d: cos,
                e: cx - cos * cx + sin * cy,
                f: cy - sin * cx - cos * cy
            };
        },

        /** Axis mirror(s) about pivot (cx, cy): T(c)·S(±1,±1)·T(-c). */
        mirrorAbout(mirrorX, mirrorY, cx, cy) {
            const sx = mirrorX ? -1 : 1;
            const sy = mirrorY ? -1 : 1;
            return { a: sx, b: 0, c: 0, d: sy, e: cx - sx * cx, f: cy - sy * cy };
        },

        // Core operations

        /** result = m1 * m2. Parent on the left, child on the right. */
        multiply(m1, m2) {
            return {
                a: m1.a * m2.a + m1.c * m2.b,
                b: m1.b * m2.a + m1.d * m2.b,
                c: m1.a * m2.c + m1.c * m2.d,
                d: m1.b * m2.c + m1.d * m2.d,
                e: m1.a * m2.e + m1.c * m2.f + m1.e,
                f: m1.b * m2.e + m1.d * m2.f + m1.f
            };
        },

        /** Inverse, or null if singular. Workspace matrices (det = ±1) never are. */
        invert(m) {
            const det = m.a * m.d - m.b * m.c;
            if (Math.abs(det) < 1e-12) return null;
            const inv = 1 / det;
            return {
                a:  m.d * inv,
                b: -m.b * inv,
                c: -m.c * inv,
                d:  m.a * inv,
                e: (m.c * m.f - m.d * m.e) * inv,
                f: (m.b * m.e - m.a * m.f) * inv
            };
        },

        applyToPoint(m, p) {
            return {
                x: m.a * p.x + m.c * p.y + m.e,
                y: m.b * p.x + m.d * p.y + m.f
            };
        },

        det(m) { return m.a * m.d - m.b * m.c; },

        isIdentity(m, eps = 1e-12) {
            return Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps &&
                   Math.abs(m.c) < eps && Math.abs(m.d - 1) < eps &&
                   Math.abs(m.e) < eps && Math.abs(m.f) < eps;
        },

        // Winding

        /** Matrix-based winding check: negative determinant = reflection. */
        windingFlipped(m) { return this.det(m) < 0; },

        /** Param-based winding check (identical result for workspace params).
         *  Kept for pipeline code that has the params struct but no matrix. */
        windingFlippedParams(t) {
            if (!t) return false;
            return !!((t.mirrorX ? 1 : 0) ^ (t.mirrorY ? 1 : 0));
        },

        /** Mirror-XOR rule: a single-axis mirror inverts visual rotation. */
        effectiveRotationDeg(t) {
            if (!t || !t.rotation) return 0;
            return this.windingFlippedParams(t) ? -t.rotation : t.rotation;
        },

        // Composition

        /**
         * Node-local TRS: translate (tx,ty), rotate by rotationDeg around
         * (cx,cy), scale by (sx,sy) around (cx,cy). Identical formula to the
         * old MatrixUtils.composeTRS - per-shape transforms are unchanged.
         */
        composeTRS(tx, ty, rotationDeg, sx, sy, cx, cy) {
            const rad = (rotationDeg * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            return {
                a: sx * cos,
                b: sx * sin,
                c: -sy * sin,
                d: sy * cos,
                e: tx + cx - (sx * cos * cx - sy * sin * cy),
                f: ty + cy - (sx * sin * cx + sy * cos * cy)
            };
        },

        /**
         * Inverse of composeTRS for SIMILARITY matrices (uniform scale, optional
         * single-axis reflection, rotation, translation) - exactly what the scene
         * produces. Returns { x, y, rotation, scaleX, scaleY } such that
         * composeTRS(x, y, rotation, scaleX, scaleY, pivot.x, pivot.y) === m.
         * A reflection (det < 0) is reported canonically as a negative scaleX.
         * NOT valid for sheared / non-uniform matrices.
         */
        decomposeToTRS(m, pivot = { x: 0, y: 0 }) {
            const a = m.a, b = m.b;
            const det = m.a * m.d - m.b * m.c;
            const scale = Math.sqrt(a * a + b * b);
            if (scale < 1e-12) {
                return { x: m.e, y: m.f, rotation: 0, scaleX: 0, scaleY: 0 };
            }
            let sx, sy, rad;
            if (det < 0) {
                sx = -scale; sy = scale;
                rad = Math.atan2(-b, -a);
            } else {
                sx = scale; sy = scale;
                rad = Math.atan2(b, a);
            }
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const cx = pivot.x, cy = pivot.y;
            // Undo composeTRS's pivot-baked translation terms.
            const x = m.e - cx + (sx * cos * cx - sy * sin * cy);
            const y = m.f - cy + (sx * sin * cx + sy * cos * cy);
            return { x, y, rotation: rad * 180 / Math.PI, scaleX: sx, scaleY: sy };
        },

        /**
         * Canonical GLOBAL workspace matrix from semantic params
         * { rotation, rotationCenter, mirrorX, mirrorY, mirrorCenter }.
         * Replaces WorkspaceTransform.forwardPoint / forwardMatrix.
         * Rotate (effective angle) about rotationCenter, THEN mirror about
         * mirrorCenter. Origin is intentionally NOT included.
         */
        composeWorkspace(t) {
            if (!t) return this.identity();
            let m = this.identity();
            if (t.rotation && t.rotation !== 0) {
                const rc = t.rotationCenter || { x: 0, y: 0 };
                m = this.rotationAbout(this.effectiveRotationDeg(t), rc.x, rc.y);
            }
            if (t.mirrorX || t.mirrorY) {
                const mc = t.mirrorCenter || { x: 0, y: 0 };
                m = this.multiply(this.mirrorAbout(!!t.mirrorX, !!t.mirrorY, mc.x, mc.y), m);
            }
            return m;
        },

        // Bounds

        /** AABB of an AABB after transformation. Rich form (width/center). */
        transformBounds(m, b) {
            const corners = [
                this.applyToPoint(m, { x: b.minX, y: b.minY }),
                this.applyToPoint(m, { x: b.maxX, y: b.minY }),
                this.applyToPoint(m, { x: b.maxX, y: b.maxY }),
                this.applyToPoint(m, { x: b.minX, y: b.maxY })
            ];
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            for (const p of corners) {
                if (p.x < minX) minX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x;
                if (p.y > maxY) maxY = p.y;
            }
            return {
                minX, minY, maxX, maxY,
                width: maxX - minX, height: maxY - minY,
                centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2
            };
        },

    };

    window.TransformMath = TransformMath;
})();