/*!
 * @file        geometry/geometry-utils-toolprofile.js
 * @description Tool-of-revolution tip surface profiles. Single source of
 *              truth for h(d) - the height of the tool's cutting surface
 *              above the tip at radial distance d from the tool axis -
 *              plus the kernel radius (maximum radial reach) derived from
 *              it. The compensation identity everywhere downstream is:
 *
 *                  tipZ(p) = max over q, d(p,q) ≤ kernelRadius of
 *                            [ surface(q) - h(d(p,q)) ]
 *
 *              Consumers: FieldCompensator (planar relief + cylindrical
 *              rotary dilation).
 *
 *              Pure math. No DOM, no CAMConfig dependency - loadable in a
 *              Web Worker via importScripts().
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

    /**
     * Profile object contract (every make() variant returns this shape):
     *   shape         {string}   - profile id
     *   kernelRadius  {number}   - max radial reach (mm). For depth-derived
     *                              shapes (vbit, taperedBall) this is the
     *                              radius AT maxEngagement, not the shank.
     *   maxEngagement {number|null} - depth the kernelRadius was derived
     *                              for; null for fixed-radius tools.
     *   h(d)          {function} - surface height above tip at radial
     *                              distance d (mm). Total on [0, ∞):
     *                              clamped beyond kernelRadius so a stray
     *                              call can never return NaN.
     *   radiusAtDepth(D) {function} - largest d with h(d) ≤ D, capped at
     *                              kernelRadius. Used for validation
     *                              (floorRadius vs tool reach) and by the
     *                              future waterline strategy.
     *   params        {Object}   - echo of the resolved inputs
     *   describe()    {function} - short debug string
     */
    const ToolProfile = {

        /**
         * @param {string} shape - 'flat' | 'ball' | 'bull' | 'vbit' | 'taperedBall'
         * @param {Object} o
         * @param {number} [o.toolDiameter]  - mm (flat, ball, bull)
         * @param {number} [o.cornerRadius]  - mm (bull; 0 → flat, D/2 → ball)
         * @param {number} [o.tipDiameter]   - mm (vbit flat tip / taperedBall tip ball)
         * @param {number} [o.angleDeg]      - vbit: INCLUDED angle;
         *                                     taperedBall: per-side taper angle
         * @param {number} [o.maxEngagement] - mm, required for vbit/taperedBall
         */
        make(shape, o = {}) {
            switch (shape) {
                case 'flat':        return this._flat(o);
                case 'ball':        return this._ball(o);
                case 'bull':        return this._bull(o);
                case 'vbit':        return this._vbit(o);
                case 'taperedBall': return this._taperedBall(o);
                default:
                    throw new Error(`ToolProfile: unknown shape '${shape}'`);
            }
        },

        // ════════════════════════════════════════════════════════════
        // Fixed-radius profiles
        // ════════════════════════════════════════════════════════════

        _flat(o) {
            const r = this._requirePositive(o.toolDiameter, 'toolDiameter') / 2;
            return {
                shape: 'flat',
                kernelRadius: r,
                maxEngagement: null,
                h: () => 0,
                radiusAtDepth: () => r, // engages full width at any depth
                params: { toolDiameter: r * 2 },
                describe: () => `flat Ø${(r * 2).toFixed(3)}mm`
            };
        },

        _ball(o) {
            const r = this._requirePositive(o.toolDiameter, 'toolDiameter') / 2;
            const r2 = r * r;
            return {
                shape: 'ball',
                kernelRadius: r,
                maxEngagement: null,
                h: (d) => (d >= r) ? r : r - Math.sqrt(Math.max(0, r2 - d * d)),
                radiusAtDepth: (D) => (D >= r) ? r
                    : Math.sqrt(Math.max(0, D * (2 * r - D))),
                params: { toolDiameter: r * 2 },
                describe: () => `ball Ø${(r * 2).toFixed(3)}mm`
            };
        },

        _bull(o) {
            const rt = this._requirePositive(o.toolDiameter, 'toolDiameter') / 2;
            const rc = o.cornerRadius ?? 0;
            if (rc < 0 || rc > rt + 1e-9) {
                throw new Error(`ToolProfile: cornerRadius ${rc} outside [0, ${rt}]`);
            }
            // Degenerate ends collapse to the exact profiles (cheaper h()).
            if (rc <= 1e-9) return this._flat(o);
            if (rc >= rt - 1e-9) return this._ball(o);

            const flatSpan = rt - rc;
            const rc2 = rc * rc;
            return {
                shape: 'bull',
                kernelRadius: rt,
                maxEngagement: null,
                h: (d) => {
                    if (d <= flatSpan) return 0;
                    const e = Math.min(d, rt) - flatSpan;
                    return rc - Math.sqrt(Math.max(0, rc2 - e * e));
                },
                radiusAtDepth: (D) => (D >= rc) ? rt
                    : flatSpan + Math.sqrt(Math.max(0, D * (2 * rc - D))),
                params: { toolDiameter: rt * 2, cornerRadius: rc },
                describe: () => `bull Ø${(rt * 2).toFixed(3)}mm rc=${rc.toFixed(3)}mm`
            };
        },

        // ════════════════════════════════════════════════════════════
        // Depth-derived profiles - the kernel radius is a function of the
        // deepest engagement, so maxEngagement (typically startDepth +
        // totalDepth of the operation) is REQUIRED. Kernel cost is
        // O(cells x kernel area): big depths + fine grids get slow, which
        // is exactly the waterline-alternative note in the relief handler.
        // ════════════════════════════════════════════════════════════

        _vbit(o) {
            const angle = this._requirePositive(o.angleDeg, 'angleDeg');
            if (angle >= 180) throw new Error('ToolProfile: vbit angleDeg must be < 180');
            const maxE = this._requirePositive(o.maxEngagement, 'maxEngagement');
            const tipR = Math.max(0, (o.tipDiameter ?? 0) / 2);
            const halfTan = Math.tan((angle / 2) * DEG);
            const kernelRadius = tipR + maxE * halfTan;

            return {
                shape: 'vbit',
                kernelRadius,
                maxEngagement: maxE,
                h: (d) => {
                    if (d <= tipR) return 0;
                    return (Math.min(d, kernelRadius) - tipR) / halfTan;
                },
                radiusAtDepth: (D) => Math.min(kernelRadius, tipR + Math.max(0, D) * halfTan),
                params: { angleDeg: angle, tipDiameter: tipR * 2, maxEngagement: maxE },
                describe: () => `vbit ${angle}° tipØ${(tipR * 2).toFixed(3)}mm ` +
                    `reach=${kernelRadius.toFixed(3)}mm@${maxE.toFixed(2)}mm`
            };
        },

        _taperedBall(o) {
            const tipR = this._requirePositive(o.tipDiameter, 'tipDiameter') / 2;
            const alphaDeg = this._requirePositive(o.angleDeg, 'angleDeg'); // per-side
            if (alphaDeg >= 90) throw new Error('ToolProfile: taperedBall angleDeg must be < 90');
            const maxE = this._requirePositive(o.maxEngagement, 'maxEngagement');

            const alpha = alphaDeg * DEG;
            const tanA = Math.tan(alpha);
            const tipR2 = tipR * tipR;

            // Tangency between the tip ball (center at height tipR) and the
            // conical flank of per-side angle α from the tool axis:
            //   dT = tipR·cosα,  hT = tipR·(1 - sinα)
            // Ball curve for d ≤ dT, flank line h = hT + (d - dT)/tanα beyond.
            const dT = tipR * Math.cos(alpha);
            const hT = tipR * (1 - Math.sin(alpha));

            const kernelRadius = (maxE <= hT)
                ? Math.sqrt(Math.max(0, maxE * (2 * tipR - maxE)))
                : dT + (maxE - hT) * tanA;

            return {
                shape: 'taperedBall',
                kernelRadius,
                maxEngagement: maxE,
                h: (d) => {
                    const dd = Math.min(d, kernelRadius);
                    if (dd <= dT) return tipR - Math.sqrt(Math.max(0, tipR2 - dd * dd));
                    return hT + (dd - dT) / tanA;
                },
                radiusAtDepth: (D) => {
                    if (D <= 0) return 0;
                    const r = (D <= hT)
                        ? Math.sqrt(Math.max(0, D * (2 * tipR - D)))
                        : dT + (D - hT) * tanA;
                    return Math.min(r, kernelRadius);
                },
                params: { tipDiameter: tipR * 2, angleDeg: alphaDeg, maxEngagement: maxE },
                describe: () => `taperedBall tipØ${(tipR * 2).toFixed(3)}mm ${alphaDeg}°/side ` +
                    `reach=${kernelRadius.toFixed(3)}mm@${maxE.toFixed(2)}mm`
            };
        },

        // ════════════════════════════════════════════════════════════
        // Holder envelope - collision guard v1
        //
        // Gouge protection IS the compensation identity with a taller,
        // wider tool: wrap any base profile in the shank+holder envelope
        // and FieldCompensator (planar AND cylindrical - it only reads
        // kernelRadius and h(d)) limits per-cell tip Z so the shank and
        // holder can never intersect the surface. No new algorithm, no
        // toolpath post-check; applies identically to relief, rotary and
        // indexed via genOptions.holder (plain data - the generators call
        // this themselves because closures can't cross postMessage).
        //
        // Envelope h(d), height above tip at radial distance d:
        //   d ≤ base.kernelRadius            → min(base.h(d), fluteLength)
        //   d ≤ shankDiameter/2 + margin     → fluteLength
        //   beyond (up to kernelRadius)      → holderStickout
        // The middle zone self-eliminates when the shank hides behind a
        // fatter cutter (rShank < rBase) - common with 6-10mm ball noses
        // on 3.175mm shanks - keeping h monotone without special-casing.
        //
        // COST: kernel taps scale with (kernelRadius/cellSize)²; a 16mm
        // holder against a 0.1mm grid is ~2 orders of magnitude more taps
        // than the bare cutter. suggestLattice() coarsens automatically -
        // this is the expected long pole, and it runs in the worker.
        // ════════════════════════════════════════════════════════════

        /**
         * @param {Object} base - a make() result to wrap
         * @param {Object} o
         * @param {number} o.fluteLength    - mm, tip → end of flutes
         * @param {number} o.shankDiameter  - mm
         * @param {number} o.holderDiameter - mm
         * @param {number} o.holderStickout - mm, tip → holder face
         * @param {number} [o.margin=0.5]   - mm added to shank/holder radii
         */
        withHolder(base, o = {}) {
            const flute = this._requirePositive(o.fluteLength, 'fluteLength');
            const rShank = this._requirePositive(o.shankDiameter, 'shankDiameter') / 2
                + (o.margin ?? 0.5);
            const rHolder = this._requirePositive(o.holderDiameter, 'holderDiameter') / 2
                + (o.margin ?? 0.5);
            // Physical sanity: holder face can't sit below the flutes, and
            // the holder can't be thinner than the (margined) shank.
            const stickout = Math.max(
                this._requirePositive(o.holderStickout, 'holderStickout'), flute);
            const rHolderEff = Math.max(rHolder, rShank);
            const rBase = base.kernelRadius;

            return {
                shape: `${base.shape}+holder`,
                kernelRadius: rHolderEff,
                maxEngagement: base.maxEngagement,
                h: (d) => {
                    if (d <= rBase) return Math.min(base.h(d), flute);
                    if (d <= rShank) return flute; // unreachable when rShank ≤ rBase
                    return stickout;
                },
                // Genuine 3-zone piecewise inverse - do NOT delegate past
                // the base kernel; the envelope is discontinuous there.
                radiusAtDepth: (D) => {
                    if (D < flute) return Math.min(base.radiusAtDepth(D), rBase);
                    if (D < stickout) return Math.max(rShank, rBase);
                    return rHolderEff;
                },
                params: {
                    base: base.params, fluteLength: flute,
                    shankDiameter: o.shankDiameter,
                    holderDiameter: o.holderDiameter,
                    holderStickout: stickout, margin: o.margin ?? 0.5
                },
                describe: () => `${base.describe()} +holder ` +
                    `Ø${o.holderDiameter}mm@${stickout.toFixed(1)}mm ` +
                    `(flute ${flute.toFixed(1)}mm, reach=${rHolderEff.toFixed(2)}mm)`
            };
        },

        // ════════════════════════════════════════════════════════════

        _requirePositive(v, name) {
            if (!(v > 0)) throw new Error(`ToolProfile: ${name} must be > 0 (got ${v})`);
            return v;
        }
    };

    ROOT.ToolProfile = ToolProfile;
})();