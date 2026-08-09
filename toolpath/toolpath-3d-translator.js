/*!
 * @file        toolpath/toolpath-3d-translator.js
 * @description Delegate translator for 3D contour primitives (V-Carve
 *              skeleton chains, relief rasters). Instantiated and called
 *              by GeometryTranslator so the pipeline keeps exactly ONE
 *              pipeline→machine-space crossing (parent.applyTransforms).
 *
 *              Consumes Polyline3DPrimitive (packed xyz triplets) natively
 *              and legacy PathPrimitive {x,y,z}-contour output as fallback.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const D = window.CAMConfig.defaults;
    const T3D = D.toolpath.generation.threeD;

    // Machining phase → sort rank. The optimizer orders plan groups by
    // ascending phaseRank BEFORE any proximity/nearest-neighbor pass, so
    // roughing groups always run before finishing regardless of insertion
    // order. 'default' (V-Carve, single-phase) ranks with finishing because a
    // single-phase op has nothing to precede.
    // REVIEW - This silent logic is bad, an explicit UI replacement is necessary.
    const PHASE_RANK = {
        'roughing': 0,
        'finishing': 1,
        'default': 1
    };

    class Toolpath3DTranslator {
        /** @param {GeometryTranslator} parent - owns applyTransforms */
        constructor(parent) {
            this.parent = parent;
            // Reusable read cursor - avoids one allocation per point
            this._pt = { x: 0, y: 0, z: 0 };
        }

        /**
         * tan(descentFeedAngle). Exported as a static so ToolpathOptimizer
         * can classify feeds identically after a reversal or a simplify
         * pass.
         */
        static slopeGate() {
            return Math.tan((T3D.descentFeedAngleDeg * Math.PI) / 180);
        }

        /** Feed for a segment whose delta is (dz, dxy). */
        static feedFor(dz, dxy, feedRate, plungeRate, gate) {
            return (dz < 0 && Math.abs(dz) > dxy * gate) ? plungeRate : feedRate;
        }

        /**
         * Translates one is3DContour primitive into one open-path plan
         * per chain. Every point carries its own Z; downstream stages
         * must preserve it (metadata.is3DContour gates the
         * MachineProcessor Z-stamp, the optimizer's staydown links,
         * entry-point rotation, and the 2D collinear simplifier).
         */
        translate(primitive, ctx) {
            const { operationId, tool, cutting } = ctx;
            const props = primitive.properties || {};

            const developed = props.developed === true;
            // [INDEXED] Indexed 3+1 chains are already MACHINE-frame:
            // x = axial along the rotary axis, y = 0 ON the axis line,
            // z = 0 at the blank face top (the handler's offset +
            // surfaceRefZ contract). Like developed rotary they bypass
            // the workspace matrix - rotating/mirroring a chucked blank
            // in software has no physical meaning - and must not be
            // shifted by surfaceZ (flat-stock zeroReference math): the
            // Z0-is-face-top contract is stated in the G-code header.
            const indexed = props.indexed === true;
            const machineFrame = developed || indexed;
            const transforms = ctx.transforms;
            if (machineFrame && transforms && !this.parent.isIdentityTransforms(transforms)) {
                console.warn('[Toolpath3DTranslator] Workspace transforms/origin are ' +
                    `ignored for ${developed ? 'rotary developed' : 'indexed 3+1'} ` +
                    'chains (the machine pass owns their frame).');
            }
            const mapPt = machineFrame
                ? (p) => ({ x: p.x, y: p.y })
                : (p) => this.parent.applyTransforms(p, transforms);

            const plans = [];

            // Phase resolution: relief passes carry machiningPhase; V-Carve
            // (single-phase) lands on 'default' → ranks with finishing.
            const phase = props.machiningPhase || 'default';
            const phaseRank = PHASE_RANK[phase] ?? PHASE_RANK.default;

            const feedRate = cutting.feedRate;
            const plungeRate = cutting.plungeRate;
            // Z-zero reference: generators emit Z relative to the stock TOP
            // (negative = into material) - EXCEPT machine-frame chains:
            //   developed rotary - z is depth below the BLANK surface; the
            //     θ→A machine pass applies its own reference.
            //   indexed 3+1      - z is depth below the blank FACE PLANE
            //     (surfaceRefZ contract); the operator touches Z0 off on
            //     one face top and every face shares it.
            // Stock thickness is meaningless in both frames; adding
            // surfaceZ let bed-zero stock settings silently shift depths.
            const surfaceZ = machineFrame ? 0 : (ctx.machine?.surfaceZ || 0);
            const slopeGate = Toolpath3DTranslator.slopeGate();

            // stepOver is meaningless for a V-bit and tool.diameter is the
            // TIP flat, so the optimizer's 2D margin formula collapses to
            // ~0 and every chain becomes its own region.
            const clusterMargin = Math.max(
                T3D.clusterMargin ?? 1.0,
                tool.diameter || 0
            );

            for (const chain of this.extractChains(primitive)) {
                const count = chain.count;
                if (count < 2) continue;
                const read = chain.read; // (i, out) → {x,y,z}

                const plan = new ToolpathPlan(operationId);
                plan.metadata.context = ctx;
                plan.metadata.transforms = ctx.transforms;
                plan.metadata.operationId = operationId;
                plan.metadata.operationType = ctx.operationType;
                plan.metadata.is3DContour = true;
                // Field rasters (relief/rotary) are emitted in serpentine
                // order; the optimizer's fast path preserves that order
                // instead of re-deriving it. V-Carve never sets this.
                plan.metadata.preserveOrder = props.preserveOrder === true;
                plan.metadata.developedSpace = developed;
                plan.metadata.refRadius = props.refRadius || 0;
                plan.metadata.stockStartRadius = props.stockStartRadius || 0;
                // Rotation-axis line in WORLD cross coordinates. The offset-
                // geometry mirror (GeometryLayer3D) reads these off primitive
                // properties to place the wrapped cylinder; without them on
                // the plan, walkPlans wraps the toolpath at the origin and an
                // off-centre axis puts the two previews in different places.
                plan.metadata.axisB = props.axisB || 0;
                plan.metadata.axisC = props.axisC || 0;
                // [INDEXED] Face identity for the machine pass, optimizer,
                // and 3D preview. indexedA is DEGREES on the A/B word,
                // verbatim from the handler (the sign-calibration point
                // lives THERE, never downstream). Plans without indexedA
                // are invisible to insertIndexMoves - mixed jobs pass
                // through. indexedApothem places the preview's rotation
                // axis line at z = -apothem below the face top.
                if (indexed) {
                    plan.metadata.indexedA = props.indexA ?? 0;
                    plan.metadata.indexOrder = props.indexOrder ?? 0;
                    plan.metadata.indexedFaceOrder = props.indexedFaceOrder || 'sequential';
                    plan.metadata.indexedApothem = props.indexedApothem || 0;
                    plan.metadata.indexedClearRadius = props.indexedClearRadius || 0;
                }
                // Sliced-frame rotation axis ('x' | 'y'). The developed
                // strip's x is the axial coordinate IN THAT FRAME, so a 'y'
                // job's axial travel is machine Y, not machine X, and its
                // rotary word is B, not A. convertDevelopedToRotary un-swaps
                // both; without this the plan can't tell them apart.
                plan.metadata.rotaryAxisKind = props.axisKind || 'x';
                plan.metadata.isClosed = false;
                plan.metadata.isClosedLoop = false;
                plan.metadata.primitiveType = 'path3d';
                plan.metadata.machiningPhase = phase;
                plan.metadata.phaseRank = phaseRank;
                plan.metadata.pass = phaseRank + 1;
                plan.metadata.allow3DHop = (T3D.allowHop !== false);
                plan.metadata.feedRate = feedRate;
                plan.metadata.plungeRate = plungeRate;
                plan.metadata.spindleSpeed = cutting.spindleSpeed;
                plan.metadata.spindleDwell = cutting.spindleDwell;
                plan.metadata.toolDiameter = tool.diameter;
                plan.metadata.stepOver = 0;
                // Explicit proximity margin - consumed by
                // ToolpathOptimizer.buildRegions/subdivideByProximity.
                plan.metadata.clusterMargin = clusterMargin;
                plan.metadata.entryType = 'plunge';
                // The handler's getToolpathPolicy() reaches the optimizer ONLY
                // through plan metadata. createPurePlan stamps it for 2D plans.
                plan.metadata.toolpathPolicy = ctx.computed?.toolpathPolicy ?? null;
                // Phase suffix keeps optimizer groups phase-local even if
                // it only groups by key and ignores phaseRank.
                plan.metadata.groupKey =
                    `T:${tool.diameter.toFixed(3)}_OP:${operationId}` +
                    `_TYPE:${ctx.operationType}_PH:${phaseRank}` +
                    // [INDEXED] Faces can never share an optimizer group:
                    // the _IX: wall guarantees proximity/NN ordering can't
                    // interleave chains across an A move.
                    (indexed ? `_IX:${props.indexOrder ?? 0}` : '') +
                    // Per-roughing-layer key: each Z-level has its own optimizer
                    // group so proximity ordering can't interleave depths. Relies
                    // on generators emitting layers shallow→deep and the optimizer's
                    // stable phaseRank sort preserving that insertion order.
                    (props.roughLayerIndex != null ? `_Z:${props.roughLayerIndex}` : '');

                let minZ = surfaceZ;
                const first = read(0, this._pt);
                const firstXY = mapPt(first);
                const firstZ = first.z + surfaceZ;
                if (firstZ < minZ) minZ = firstZ;
                plan.metadata.entryPoint = { x: firstXY.x, y: firstXY.y, z: firstZ };

                let prevX = first.x, prevY = first.y, prevZ = first.z;
                for (let i = 1; i < count; i++) {
                    const raw = read(i, this._pt);
                    const z = raw.z + surfaceZ;
                    if (z < minZ) minZ = z;

                    // Slope-gated feed: descending AND steeper than the
                    // gate angle → plunge rate. Ascents and shallow moves
                    // stay at cutting feed. (dz on raw z - the constant
                    // surfaceZ offset cancels out of the slope test.)
                    const dz = raw.z - prevZ;
                    const dxy = Math.hypot(raw.x - prevX, raw.y - prevY);
                    const feed = Toolpath3DTranslator.feedFor(
                        dz, dxy, feedRate, plungeRate, slopeGate);

                    prevX = raw.x; prevY = raw.y; prevZ = raw.z;
                    const p = mapPt(raw);
                    plan.addLinear(p.x, p.y, z, feed);
                }

                const last = read(count - 1, this._pt);
                const lastZ = last.z + surfaceZ;
                const lastXY = mapPt(last);
                plan.metadata.exitPoint = { x: lastXY.x, y: lastXY.y, z: lastZ };

                // cutDepth = 0 keeps all 3D chains in ONE Z-level group
                // (groupByZLevel keys on cutDepth) so nearest-neighbor
                // ordering works across chains. True deepest point lives
                // in minZ; per-command Z is what the export-depth
                // validator actually checks.
                plan.metadata.cutDepth = 0;
                plan.metadata.finalDepth = minZ;
                plan.metadata.minZ = minZ;

                plan.metadata.optimization = {
                    linkType: 'rapid',
                    // Copy, never alias metadata.entryPoint: simplify3DSegments
                    // and reversePlanCommands replace that object, and a stale
                    // alias silently feeds MachineProcessor the wrong plunge XY.
                    optimizedEntryPoint: { ...plan.metadata.entryPoint },
                    entryCommandIndex: 0
                };

                plan.computeBounds();
                plans.push(plan);
            }

            return plans;
        }

        /**
         * Normalizes both accepted input shapes into read cursors:
         *   - Polyline3DPrimitive: read triplets from .positions directly
         *   - Legacy PathPrimitive: read {x,y,z} contour points
         * Each chain: { count, read(i, out) }.
         */
        extractChains(primitive) {
            if (primitive.type === 'path3d' && primitive.positions) {
                const pos = primitive.positions;
                return [{
                    count: (pos.length / 3) | 0,
                    read: (i, out) => {
                        const b = i * 3;
                        out.x = pos[b]; out.y = pos[b + 1]; out.z = pos[b + 2];
                        return out;
                    }
                }];
            }
            // Legacy: one chain per contour of object points
            const contours = primitive.contours || [];
            if (contours.length === 0) {
                console.warn('[Toolpath3DTranslator] is3DContour primitive with no ' +
                             'positions and no contours - chain dropped.', primitive);
            }
            return contours.map(contour => {
                const pts = contour.points || [];
                return {
                    count: pts.length,
                    read: (i, out) => {
                        const p = pts[i];
                        out.x = p.x; out.y = p.y; out.z = p.z ?? 0;
                        return out;
                    }
                };
            });
        }
    }

    window.Toolpath3DTranslator = Toolpath3DTranslator;
})();