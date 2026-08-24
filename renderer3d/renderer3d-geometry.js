/*!
 * @file        renderer3d/renderer3d-geometry.js
 * @description Flat 2D geometry mirror. Consumes layer snapshots from the
 *              2D LayerRenderer (same primitive objects, color already
 *              resolved by the UI theme system) and rebuilds them as
 *              polylines at the stock top. All XY runs through a
 *              caller-supplied world→machine mapping so source geometry,
 *              offsets, stock, and machine-ready plans share one frame.
 *
 *              path3d (Polyline3DPrimitive) keeps its real Z: XY is
 *              workspace-mapped, Z is baseZ + stored depth (assumes
 *              stored Z is surface-relative - recheck when v-carve lands).
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';
import { arcSegmentCount } from './renderer3d-toolpath.js'; // REVIEW - Wouldn't it be better to leave all these in the renderer3d-core to avoid down-stream modules from talking to each other?

const ARC_SEGMENT_LENGTH = window.CAMConfig?.defaults?.rendering?.preview3D?.arcSegmentLength ?? 0.4;
const BASE_LIFT = 0.02;       // mm above stock top (z-fight guard vs stock face)
const TIER_LIFT = 0.00008;    // mm per zIndex unit (zIndex 0..850 → +0..0.068)

// ─── Tessellation (mirrors PrimitiveRenderer.drawPrimitivePath cases) ───

/** Samples an arc from a0 over a signed sweep (Y-up: +sweep = CCW). */
function sampleArc(center, radius, a0, sweep, skipFirst) {
    const segs = arcSegmentCount(radius, sweep);
    const pts = [];
    for (let s = skipFirst ? 1 : 0; s <= segs; s++) {
        const a = a0 + (sweep * s) / segs;
        pts.push({ x: center.x + radius * Math.cos(a),
                   y: center.y + radius * Math.sin(a) });
    }
    return pts;
}

/** Y-up sweep normalization: clockwise = decreasing angle. Matches the
 *  2D renderer's ctx.arc(..., primitive.clockwise) under its Y-flipped
 *  canvas transform. a0 === a1 resolves to a full circle. */
function arcSweep(a0, a1, clockwise) {
    let sweep = a1 - a0;
    if (clockwise) { if (sweep >= 0) sweep -= Math.PI * 2; }
    else           { if (sweep <= 0) sweep += Math.PI * 2; }
    return sweep;
}

function arcPoints(center, radius, a0, a1, clockwise, fullCircle) {
    const sweep = fullCircle ? Math.PI * 2 : arcSweep(a0, a1, clockwise);
    return sampleArc(center, radius, a0, sweep, false);
}

/**
 * Contour → dense point list, honoring analytic arcSegments the same
 * way PrimitiveRenderer.drawPrimitivePath does: straight lines between
 * plain points, arcs tessellated from center/radius/angles. Handles
 * both encodings ({sweepAngle} and {startAngle, endAngle, clockwise})
 * and the degenerate offset-circle contour (ONE point + one 2π arc).
 */
function contourToPoints(contour) {
    const pts = contour.points || [];
    const arcs = contour.arcSegments;
    if (!arcs || arcs.length === 0 || pts.length === 0) return pts;

    const sorted = arcs.slice().sort((a, b) => a.startIndex - b.startIndex);
    const out = [pts[0]];
    let cur = 0;

    for (const arc of sorted) {
        for (let i = cur + 1; i <= arc.startIndex && i < pts.length; i++) {
            out.push(pts[i]);
        }
        const sweep = (arc.sweepAngle !== undefined)
            ? arc.sweepAngle
            : arcSweep(arc.startAngle, arc.endAngle, arc.clockwise);
        // skipFirst: out already ends at (≈) the arc's start point
        out.push(...sampleArc(arc.center, arc.radius, arc.startAngle, sweep, true));
        cur = arc.endIndex;
    }

    // Tail guard mirrors the 2D painter: a lone full-circle arc has
    // endIndex 0 - re-walking the points would double the ring.
    if (cur !== 0 || sorted.length === 0) {
        for (let i = cur + 1; i < pts.length; i++) out.push(pts[i]);
    }
    return out;
}

function obroundPoints(prim) {
    const { x, y } = prim.position;
    const w = prim.width, h = prim.height;
    const r = Math.min(w, h) / 2;
    let pts;

    if (w >= h) {
        // Horizontal stadium: right cap CCW (-90°→+90°), left cap (+90°→+270°)
        const cy = y + r;
        pts = [
            ...arcPoints({ x: x + w - r, y: cy }, r, -Math.PI / 2, Math.PI / 2, false, false),
            ...arcPoints({ x: x + r, y: cy }, r, Math.PI / 2, 3 * Math.PI / 2, false, false)
        ];
    } else {
        // Vertical stadium: top cap (0°→180°), bottom cap (180°→360°)
        const cx = x + r;
        pts = [
            ...arcPoints({ x: cx, y: y + h - r }, r, 0, Math.PI, false, false),
            ...arcPoints({ x: cx, y: y + r }, r, Math.PI, 2 * Math.PI, false, false)
        ];
    }

    const rotDeg = prim.properties?.rotation;
    if (rotDeg) {
        const cx = x + w / 2, cy = y + h / 2;
        const rad = rotDeg * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        pts = pts.map(p => {
            const dx = p.x - cx, dy = p.y - cy;
            return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
        });
    }
    return pts;
}

/** @returns {Array<{points:Array<{x,y}>, closed:boolean}>} */
function primitiveToLoops(prim) {
    const loops = [];
    switch (prim.type) {
        case 'path': {
            const closed = prim.closed !== false;
            for (const c of (prim.contours || [])) {
                const dense = contourToPoints(c);
                if (dense.length >= 2) loops.push({ points: dense, closed });
            }
            break;
        }
        case 'circle':
            loops.push({
                points: arcPoints(prim.center, prim.radius, 0, Math.PI * 2, false, true),
                closed: true
            });
            break;
        case 'rectangle': {
            const { x, y } = prim.position;
            loops.push({
                points: [
                    { x, y }, { x: x + prim.width, y },
                    { x: x + prim.width, y: y + prim.height }, { x, y: y + prim.height }
                ],
                closed: true
            });
            break;
        }
        case 'arc':
            loops.push({
                points: arcPoints(prim.center, prim.radius,
                    prim.startAngle, prim.endAngle, prim.clockwise, false),
                closed: false
            });
            break;
        case 'obround':
            loops.push({ points: obroundPoints(prim), closed: true });
            break;
        default: {
            // Anything the switch above does not model analytically goes
            // through the canonical tessellator.
            const path = (typeof GeometryUtils !== 'undefined')
                ? GeometryUtils.primitiveToPath(prim)
                : null;
            for (const c of (path?.contours || [])) {
                const dense = contourToPoints(c);
                if (dense.length >= 2) {
                    loops.push({ points: dense, closed: path.closed !== false });
                }
            }
        }
    }
    return loops;
}

// ─── Layer group ─────────────────────────────────────────────────────

export class GeometryLayer3D {
    /** @param {Renderer3D} core */
    constructor(core) {
        this.core = core;
        this.group = new THREE.Group();
        this.group.name = 'geometry2d';
        core.contentGroup.add(this.group);
    }

    /**
     * Rebuilds the mirrored 2D geometry from LayerRenderer snapshots.
     * @param {Array<{name?, primitives:Array, color:string,
     *               transform?:{a,b,c,d,e,f}|null, zIndex?:number}>} layerDefs
     * @param {Object} [o]
     * @param {number}   [o.baseZ=0]          Stock-top Z, machine coords.
     * @param {Function} [o.worldToMachine]   ({x,y})=>({x,y}) workspace map.
     */
    setLayers(layerDefs, o = {}) {
        this.clear();
        const baseZ = o.baseZ ?? 0;
        const w2m = o.worldToMachine || (p => p);

        for (const def of (layerDefs || [])) {
            const positions = [];
            const t = def.transform;
            const z = baseZ + BASE_LIFT + (def.zIndex || 0) * TIER_LIFT;

            // Local primitive coords → shape world matrix → machine coords
            const mapXY = (x, y) => {
                if (t) {
                    return w2m({ x: t.a * x + t.c * y + t.e,
                                 y: t.b * x + t.d * y + t.f });
                }
                return w2m({ x, y });
            };

            for (const prim of (def.primitives || [])) {
                // Rotary developed chains: wrap back around the rotation
                // axis for display. Data: x = axial (world), y = θ·refR,
                // z = R - refR (≤ 0). Display convention: blank top tangent
                // to the stock top plane (axis at baseZ - refR), θ = 0
                // pointing up (+Z). def.transform is the 2D canvas strip-
                // placement hack - deliberately ignored here.
                const rp = prim.properties;
                if (prim.type === 'path3d' && rp?.developed && rp.refRadius > 0 &&
                    prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    const refR = rp.refRadius;
                    const axisB = rp.axisB || 0;
                    const swapAxis = rp.axisKind === 'y';
                    const axisZ = o.rotaryAxisZ ?? (baseZ - refR);
                    const wrap = (ax, arc, depth) => {
                        const th = arc / refR;
                        const R = refR + depth;
                        const cross = axisB + R * Math.sin(th);
                        const zz = axisZ + R * Math.cos(th);
                        // NO w2m. Developed rotary chains are MACHINE frame
                        // already - Toolpath3DTranslator deliberately skips
                        // applyTransforms for them (and warns on a non-identity
                        // workspace), and walkPlans applies no mapping at all.
                        // Mapping here put the offset geometry and the
                        // toolpaths in different places the moment the
                        // workspace origin or rotation was not identity.
                        return swapAxis ? { x: cross, y: ax, z: zz }
                                        : { x: ax, y: cross, z: zz };
                    };
                    // Segments are straight in DEVELOPED space (that's the
                    // correct machine motion: linear X+A). Wrapping only the
                    // stored vertices draws chords through the cylinder -
                    // simplify3D legitimately collapses rings and helices to
                    // a few points. Subdivide by arc length before wrapping.
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const ax0 = pos[i],     arc0 = pos[i + 1], d0 = pos[i + 2];
                        const ax1 = pos[i + 3], arc1 = pos[i + 4], d1 = pos[i + 5];
                        const subs = Math.min(100000, Math.max(1,
                            Math.ceil(Math.abs(arc1 - arc0) / ARC_SEGMENT_LENGTH)));
                        let prev = wrap(ax0, arc0, d0);
                        for (let s = 1; s <= subs; s++) {
                            const t = s / subs;
                            const cur = wrap(
                                ax0 + (ax1 - ax0) * t,
                                arc0 + (arc1 - arc0) * t,
                                d0 + (d1 - d0) * t
                            );
                            positions.push(prev.x, prev.y, prev.z,
                                           cur.x, cur.y, cur.z);
                            prev = cur;
                        }
                    }
                    continue;
                }

                // [INDEXED] 3+1 faces: rigid rotation of the flat face about
                // the world rotary-axis line by its fixed A/B angle
                // (props.indexA), so every face lands on the one physical
                // blank instead of stacking at A=0. Axis line at
                // Z = baseZ - apothem (apothem below the shared face top,
                // which IS baseZ = Z0). Stored (px,py) are already WORLD x,y
                // (indexed slices in world orientation - no internal remap);
                // pz is depth below the face top (≤0). Straight in, straight
                // out - no subdivision. def.transform (2D strip hack) ignored.
                //
                // SIGN: R_axis(-A), matching how a 4th-axis viewer/controller
                // places moves (the table turns +A, so a machine point sits at
                // -A in the part frame). The slicer captures each face with
                // R_axis(+θk) and the A word is +θk, so R(-A)·R(+θk) = I puts
                // the face back on the physical part. Using +A here composes
                // to R(+2θk): identity at θk∈{0,180} (2-face agrees by luck)
                // but wrong at 120/240, 90/270 - faces pinned to the wrong
                // angular positions.
                //
                // THREE COUPLED SITES - flip together or not at all:
                //   1. ShapeIndexedHandler.buildFaceSliceOptions  rotAboutAxis(+θk)
                //   2. walkPlans' wrapPt      (renderer3d-toolpath.js)  R(-A)
                //   3. this block                                       R(-A)
                // (1) reads primitive PROPERTIES, (2) reads plan METADATA. Only
                // (1) and (3) are live today - the plan layer has no producer -
                // but (2) is what the export frame is checked against, so a flip
                // in either without the other desyncs screen from G-code.
                const ip = prim.properties;
                if (prim.type === 'path3d' && ip?.indexed &&
                    prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    const ap = ip.indexedApothem || 0;
                    const th = -(ip.indexA || 0) * Math.PI / 180;
                    const c = Math.cos(th), s = Math.sin(th);
                    const rotY = ip.axisKind === 'y';   // B about world Y
                    const axisZ = o.rotaryAxisZ ?? (baseZ - ap);
                    const place = (px, py, pz) => {
                        const dz = (baseZ + pz) - axisZ;   // = pz + apothem
                        let X = px, Y = py, Z;
                        if (rotY) {                         // rotate (X,Z); Y axial
                            X = px * c + dz * s;
                            Z = axisZ - px * s + dz * c;
                        } else {                            // rotate (Y,Z); X axial
                            Y = py * c - dz * s;
                            Z = axisZ + py * s + dz * c;
                        }
                        // NO w2m - same machine-frame contract as the
                        // developed block above and as walkPlans.
                        return { x: X, y: Y, z: Z };
                    };
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const a = place(pos[i],     pos[i + 1], pos[i + 2]);
                        const b = place(pos[i + 3], pos[i + 4], pos[i + 5]);
                        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
                    }
                    continue;
                }

                // True-3D chains: real Z, workspace-mapped XY
                if (prim.type === 'path3d' && prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const a = mapXY(pos[i], pos[i + 1]);
                        const b = mapXY(pos[i + 3], pos[i + 4]);
                        positions.push(a.x, a.y, baseZ + pos[i + 2],
                                       b.x, b.y, baseZ + pos[i + 5]);
                    }
                    continue;
                }

                for (const loop of primitiveToLoops(prim)) {
                    const pts = loop.points;
                    for (let i = 0; i < pts.length - 1; i++) {
                        const a = mapXY(pts[i].x, pts[i].y);
                        const b = mapXY(pts[i + 1].x, pts[i + 1].y);
                        positions.push(a.x, a.y, z, b.x, b.y, z);
                    }
                    if (loop.closed && pts.length > 2) {
                        const a = mapXY(pts[pts.length - 1].x, pts[pts.length - 1].y);
                        const b = mapXY(pts[0].x, pts[0].y);
                        if (a.x !== b.x || a.y !== b.y) {
                            positions.push(a.x, a.y, z, b.x, b.y, z);
                        }
                    }
                }
            }

            if (positions.length < 6) continue;

            // Non-finite guard: one NaN primitive poisons layer bounds and
            // every downstream fit/cull. Skip the layer loudly instead of
            // drawing nothing.
            let finite = true;
            for (let i = 0; i < positions.length; i++) {
                if (!Number.isFinite(positions[i])) { finite = false; break; }
            }
            if (!finite) {
                console.warn(`[Render] Skipped layer "${def.name || 'layer2d'}" - non-finite geometry bounds.`);
                continue;
            }

            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            const m = new THREE.LineBasicMaterial({
                color: new THREE.Color(def.color || '#a0a0a0')
            });
            const lines = new THREE.LineSegments(g, m);
            lines.name = def.name || 'layer2d';
            lines.userData.layerName = def.name || '';
            this.group.add(lines);
        }

        this.core.requestRender();
    }

    clear() {
        for (const child of [...this.group.children]) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
            this.group.remove(child);
        }
    }
}