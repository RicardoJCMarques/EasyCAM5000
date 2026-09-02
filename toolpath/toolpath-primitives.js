/*!
 * @file        toolpath/toolpath-primitives.js
 * @description Shared primitive classes for toolpath generation
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const PRECISION = window.CAMConfig.constants.precision.coordinate;

    /**
     * Lightweight motion command structure
     */
    // TODO [COMMAND-STREAM-MEMORY] - one heap object per move; a relief
    // finishing pass holds hundreds of thousands live through translate →
    // optimize → machine-process → export, and every { ...cmd } clone
    // doubles the transient count. Fix is packed storage inside
    // ToolpathPlan (Uint8Array opcodes + Float32Array coords + sparse map
    // for dwell/peck/canned, plus a lane for the rotary 'a'), with
    // MotionCommand surviving as the boxed view for the in-place writers
    // (tab planner, reversePlan). Belongs in plan storage, not the
    // consumers, and touches five modules at once - do it in a quiet window.
    class MotionCommand {
        constructor(type, coords, params = {}) {
            this.type = type; // 'RAPID', 'LINEAR', 'ARC_CW', 'ARC_CCW', 'PLUNGE', 'RETRACT', 'DWELL'

            // Only set coordinates that are explicitly provided
            this.x = coords.x !== undefined ? coords.x : null;
            this.y = coords.y !== undefined ? coords.y : null;
            this.z = coords.z !== undefined ? coords.z : null;
            // 4th axis (degrees, accumulated - never wrapped). Set only by
            // the rotary θ→A conversion; null/absent means no rotary word.
            if (coords.a !== undefined) this.a = coords.a;
            this.f = params.feed;

            // Arc parameters (I,J are relative offsets from start)
            if (type === 'ARC_CW' || type === 'ARC_CCW') {
                this.i = params.i;
                this.j = params.j;
            }

            // Optional parameters
            if (params.dwell) this.dwell = params.dwell;
            if (params.cycleType) this.cycleType = params.cycleType;
            if (params.retract !== undefined) this.retract = params.retract;
            if (params.peckDepth !== undefined) this.peckDepth = params.peckDepth;
            if (params.comment) this.comment = params.comment;
        }
    }

    /**
     * Toolpath plan container
     */
    class ToolpathPlan {
        constructor(operationId) {
            this.operationId = operationId;
            this.commands = [];
            this.metadata = {
                tool: null,
                estimatedTime: 0,
                boundingBox: null,
                totalDistance: 0,
                depthLevels: [],
                entryPoint: null,
                exitPoint: null,
                cutDepth: 0,
                feedRate: 150,
                direction: 'climb',
                isClosedLoop: false,
                isSimpleCircle: false,
                primitiveType: 'unknown',
                hasArcs: false
            };
        }

        addCommand(cmd) {
            this.commands.push(cmd);
        }

        addRapid(x, y, z) {
            this.commands.push(new MotionCommand('RAPID', {
                x: x !== undefined ? x : null, 
                y: y !== undefined ? y : null, 
                z: z !== undefined ? z : null
            }));
        }

        addLinear(x, y, z, feed) {
            this.commands.push(new MotionCommand('LINEAR', {
                x: x !== undefined ? x : null, 
                y: y !== undefined ? y : null, 
                z: z !== undefined ? z : null
            }, { feed: feed }));
        }

        addPlunge(z, feed) {
            this.commands.push(new MotionCommand('PLUNGE', {x: null, y: null, z}, {feed}));
        }

        addRetract(z) {
            this.commands.push(new MotionCommand('RETRACT', {x: null, y: null, z}));
        }

        addArc(x, y, z, i, j, clockwise, feed) {
            const type = clockwise ? 'ARC_CW' : 'ARC_CCW';
            this.commands.push(new MotionCommand(type, {x, y, z}, {i, j, feed}));
        }

        addDwell(duration) {
            this.commands.push(new MotionCommand('DWELL', {x: null, y: null, z: null}, {dwell: duration}));
        }

        addCannedSimple(x, y, z, retract, feed, dwell) {
            this.commands.push(new MotionCommand('CANNED_SIMPLE', {x, y, z}, {retract, feed, dwell}));
        }

        addCannedPeck(x, y, z, retract, peckDepth, feed, cycleType = 'G83') {
            this.commands.push(new MotionCommand('CANNED_PECK', {x, y, z}, {retract, peckDepth, feed, cycleType}));
        }

        /**
         * Computes and stores the XY bounding box from this plan's commands.
         */
        computeBounds() {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            const include = (x, y) => {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            };

            for (const cmd of this.commands) {
                if (cmd.x !== null && cmd.x !== undefined &&
                    cmd.y !== null && cmd.y !== undefined) {
                    include(cmd.x, cmd.y);
                }
            }

            // A full circle is a single arc command, so the loop above only sees
            // its start point and the box collapses to that point - proximity
            // clustering then mis-measures it. Use the circle's center/radius
            // (set in analyzePrimitive) for the true extent.
            const c = this.metadata.center;
            const r = this.metadata.radius;
            if (this.metadata.isSimpleCircle && c && typeof r === 'number' && r > 0) {
                include(c.x - r, c.y - r);
                include(c.x + r, c.y + r);
            }

            this.metadata.boundingBox = { minX, minY, maxX, maxY };
            return this.metadata.boundingBox;
        }

        // ── Shared statics ──────────────────────────────────────────
        // These live INSIDE the class. The old
        // `ToolpathPlan.isClosedPoints = function…` bolted on after the
        // class body was the same thing written the confusing way.

        /**
         * Whether a points array forms a closed loop (first ≈ last).
         * Single source of truth - replaces duplicated implementations in
         * GeometryTranslator, ToolpathTabPlanner and ToolpathOptimizer.
         * @param {Array<{x:number,y:number}>} points
         * @param {number} [precision] - distance threshold (default: config)
         */
        static isClosedPoints(points, precision) {
            if (!points || points.length < 2) return false;
            const first = points[0];
            const last = points[points.length - 1];
            const dx = first.x - last.x;
            const dy = first.y - last.y;
            const threshold = precision !== undefined ? precision : PRECISION;
            return (dx * dx + dy * dy) < (threshold * threshold);
        }

        /**
         * Signed arc sweep in radians - THE one implementation.
         * Replaces the three near-copies in GeometryTranslator
         * (translateArc / translatePath), ToolpathTabPlanner (getArcData /
         * calculateTotalLength) and GCodeGenerator (linearizeArc), each of
         * which handled full circles differently. [ARC-NORMALIZATION]
         *
         * Precedence:
         *  1. An explicit sweepAngle is ground truth and is returned
         *     verbatim (including 0). The arc reconstructor emits ±2π for
         *     full circles precisely because angles CANNOT express one -
         *     start === end gives a derived sweep of 0.
         *  2. Otherwise fold (end - start) into the direction's half-plane.
         *  3. Full-circle rescue, for angle-derived sweeps only: a sweep of
         *     ~0 whose chord is COINCIDENT (not merely short - that would
         *     promote a micro-arc) and whose radius is real is a full
         *     circle. Without this, translateArc emitted a zero-length
         *     linear move and the circle vanished from the G-code.
         *
         * Sign note: callers that only gate on |sweep| may pass a
         * post-mirror `clockwise` alongside pre-transform angles; the
         * magnitude is unaffected. Callers that consume the sign must pass
         * a consistent pair.
         *
         * Machine-space fallback. graphics-exporter and the simulator rebuild arcs
         * from I/J commands and have no sweepAngle at all, so the chord-coincidence
         * rescue is the only full-circle signal they get.
         *
         * Geometry-space callers (translator, tab planner) always pass an explicit
         * sweepAngle, which short-circuits on the first line - by then the arc
         * reconstructor has already guaranteed +/-2*PI on circular contours via
         * GeometryUtils.analyzeCircleRing. Do not add a second geometric test here.
         * @param {Object} o
         * @param {number}  [o.sweepAngle] - explicit signed sweep, if known
         * @param {number}  [o.startAngle]
         * @param {number}  [o.endAngle]
         * @param {boolean} [o.clockwise]
         * @param {number}  [o.chord]    - |end - start| distance
         * @param {number}  [o.radius]   - guards the rescue vs degenerates
         * @param {number}  [o.eps]      - angular epsilon
         * @returns {number} signed sweep (negative = CW)
         */
        static normalizeArcSweep(o = {}) {
            const TAU = 2 * Math.PI;
            const eps = o.eps ?? 1e-9;
            const cw = o.clockwise === true;

            if (Number.isFinite(o.sweepAngle)) return o.sweepAngle;

            let sweep = (o.endAngle || 0) - (o.startAngle || 0);
            if (cw) { if (sweep >= eps) sweep -= TAU; }
            else    { if (sweep <= -eps) sweep += TAU; }

            if (Math.abs(sweep) < eps) {
                const coincident = o.chord !== undefined && o.chord < PRECISION;
                const hasRadius = o.radius === undefined || o.radius > eps;
                if (coincident && hasRadius) return cw ? -TAU : TAU;
            }
            return sweep;
        }
    }

    /**
     * Feed classification shared by generation, reversal and simplification.
     * Lives here rather than on the 3D translator so a 2D-only app never has
     * to load it.
     */
    const ToolpathFeeds = {
        /** tan(descentFeedAngle). Descents steeper than this use plungeRate. */
        slopeGate() {
            const T3D = window.CAMConfig.defaults.toolpath.generation.threeD;
            return Math.tan((T3D.descentFeedAngleDeg * Math.PI) / 180);
        },

        /** Feed for a segment whose delta is (dz, dxy). */
        feedFor(dz, dxy, feedRate, plungeRate, gate) {
            return (dz < 0 && Math.abs(dz) > dxy * gate) ? plungeRate : feedRate;
        }
    };

    window.ToolpathFeeds = ToolpathFeeds;
    window.MotionCommand = MotionCommand;
    window.ToolpathPlan = ToolpathPlan;
})();