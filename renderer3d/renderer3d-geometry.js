/*!
 * @file        renderer3d/renderer3d-geometry.js
 * @description Flat 2D geometry mirror in 3D space with full status color
 *              parity, drill feature nuance, opaque preview swathes,
 *              and translucent board substrate.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from "three/webgpu";
import { arcSegmentCount } from "./renderer3d-toolpath.js";

const ARC_SEGMENT_LENGTH = window.CAMConfig?.defaults?.rendering?.preview3D?.arcSegmentLength ?? 0.4;
const SURFACE_Z_EPSILON = 0.001;

// Tessellation

function emitAnnulus(cx, cy, rInner, rOuter, z, out) {
    if (!(rOuter > 0)) return;
    const segs = Math.max(12, arcSegmentCount(rOuter, 2 * Math.PI));
    for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2;
        const a1 = ((s + 1) / segs) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);
        rInner <= 0
            ? out.push(cx, cy, z, cx + rOuter * c0, cy + rOuter * s0, z, cx + rOuter * c1, cy + rOuter * s1, z)
            : out.push(
                  cx + rInner * c0, cy + rInner * s0, z,
                  cx + rOuter * c0, cy + rOuter * s0, z,
                  cx + rOuter * c1, cy + rOuter * s1, z,
                  cx + rInner * c0, cy + rInner * s0, z,
                  cx + rOuter * c1, cy + rOuter * s1, z,
                  cx + rInner * c1, cy + rInner * s1, z
              );
    }
}

function emitRibbon(pts, r, z, out, closed) {
    if (r > 0 && !(pts.length < 2)) {
        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const dx = b.x - a.x, dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue;
            const nx = (-dy / len) * r, ny = (dx / len) * r;
            out.push(
                a.x + nx, a.y + ny, z,
                b.x + nx, b.y + ny, z,
                b.x - nx, b.y - ny, z,
                a.x + nx, a.y + ny, z,
                b.x - nx, b.y - ny, z,
                a.x - nx, a.y - ny, z
            );
        }
        for (const p of pts) emitAnnulus(p.x, p.y, 0, r, z, out);
        if (closed && pts.length > 2) {
            const first = pts[0];
            emitAnnulus(first.x, first.y, 0, r, z, out);
        }
    }
}

function emitCrosshair(cx, cy, markSize, z, out) {
    out.push(
        cx - markSize, cy, z,
        cx + markSize, cy, z,
        cx, cy - markSize, z,
        cx, cy + markSize, z
    );
}

function emitCircleLines(cx, cy, radius, z, out) {
    if (!(radius > 0)) return;
    const segs = Math.max(16, arcSegmentCount(radius, 2 * Math.PI));
    for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2;
        const a1 = ((s + 1) / segs) * Math.PI * 2;
        out.push(
            cx + radius * Math.cos(a0), cy + radius * Math.sin(a0), z,
            cx + radius * Math.cos(a1), cy + radius * Math.sin(a1), z
        );
    }
}

function emitObroundOutline(p1, p2, radius, z, out) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const angle = Math.atan2(dy, dx);
    const segs = Math.max(8, arcSegmentCount(radius, Math.PI));

    // Cap at p2 (angle - PI/2 to angle + PI/2)
    for (let s = 0; s < segs; s++) {
        const a0 = angle - Math.PI / 2 + (s / segs) * Math.PI;
        const a1 = angle - Math.PI / 2 + ((s + 1) / segs) * Math.PI;
        out.push(
            p2.x + radius * Math.cos(a0), p2.y + radius * Math.sin(a0), z,
            p2.x + radius * Math.cos(a1), p2.y + radius * Math.sin(a1), z
        );
    }

    // Straight side 1
    const p2Top = { x: p2.x + radius * Math.cos(angle + Math.PI / 2), y: p2.y + radius * Math.sin(angle + Math.PI / 2) };
    const p1Top = { x: p1.x + radius * Math.cos(angle + Math.PI / 2), y: p1.y + radius * Math.sin(angle + Math.PI / 2) };
    out.push(p2Top.x, p2Top.y, z, p1Top.x, p1Top.y, z);

    // Cap at p1 (angle + PI/2 to angle + 3*PI/2)
    for (let s = 0; s < segs; s++) {
        const a0 = angle + Math.PI / 2 + (s / segs) * Math.PI;
        const a1 = angle + Math.PI / 2 + ((s + 1) / segs) * Math.PI;
        out.push(
            p1.x + radius * Math.cos(a0), p1.y + radius * Math.sin(a0), z,
            p1.x + radius * Math.cos(a1), p1.y + radius * Math.sin(a1), z
        );
    }

    // Straight side 2
    const p1Bot = { x: p1.x + radius * Math.cos(angle - Math.PI / 2), y: p1.y + radius * Math.sin(angle - Math.PI / 2) };
    const p2Bot = { x: p2.x + radius * Math.cos(angle - Math.PI / 2), y: p2.y + radius * Math.sin(angle - Math.PI / 2) };
    out.push(p1Bot.x, p1Bot.y, z, p2Bot.x, p2Bot.y, z);
}

function emitFill(loops, z, out) {
    if (0 === loops.length || loops[0].length < 3) return;
    const toV = pts => pts.map(p => new THREE.Vector2(p.x, p.y));
    const outer = toV(loops[0]);
    const holes = loops.slice(1).filter(l => l.length >= 3).map(toV);
    let faces;
    try {
        faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    } catch {
        return;
    }
    const all = outer.concat(...holes);
    for (const f of faces) {
        for (const idx of f) {
            const v = all[idx];
            v && out.push(v.x, v.y, z);
        }
    }
}

function sampleArc(center, radius, a0, sweep, skipFirst) {
    const segs = arcSegmentCount(radius, sweep);
    const pts = [];
    for (let s = skipFirst ? 1 : 0; s <= segs; s++) {
        const a = a0 + (sweep * s) / segs;
        pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
    return pts;
}

/** Y-up sweep normalization: clockwise = decreasing angle. Matches the
 *  2D renderer's ctx.arc(..., primitive.clockwise) under its Y-flipped
 *  canvas transform. a0 === a1 resolves to a full circle.
 */
function arcSweep(a0, a1, clockwise) {
    let sweep = a1 - a0;
    clockwise ? sweep >= 0 && (sweep -= 2 * Math.PI) : sweep <= 0 && (sweep += 2 * Math.PI);
    return sweep;
}

function arcPoints(center, radius, a0, a1, clockwise, fullCircle) {
    const sweep = fullCircle ? 2 * Math.PI : arcSweep(a0, a1, clockwise);
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
    if (!arcs || 0 === arcs.length || 0 === pts.length) return pts;
    const sorted = arcs.slice().sort((a, b) => a.startIndex - b.startIndex);
    const out = [pts[0]];
    let cur = 0;
    for (const arc of sorted) {
        for (let i = cur + 1; i <= arc.startIndex && i < pts.length; i++) out.push(pts[i]);
        const sweep = void 0 !== arc.sweepAngle ? arc.sweepAngle : arcSweep(arc.startAngle, arc.endAngle, arc.clockwise);
        // skipFirst: out already ends at (≈) the arc's start point
        out.push(...sampleArc(arc.center, arc.radius, arc.startAngle, sweep, true));
        cur = arc.endIndex;
    }
    // Tail guard mirrors the 2D painter: a lone full-circle arc has
    // endIndex 0 - re-walking the points would double the ring.
    if (0 !== cur || 0 === sorted.length) {
        for (let i = cur + 1; i < pts.length; i++) out.push(pts[i]);
    }
    return out;
}

function obroundPoints(prim) {
    const { x: x, y: y } = prim.position;
    const w = prim.width, h = prim.height;
    const r = Math.min(w, h) / 2;
    let pts;
    if (w >= h) {
        // Horizontal stadium: right cap CCW (-90°→+90°), left cap (+90°→+270°)
        const cy = y + r;
        pts = [
            ...arcPoints({ x: x + w - r, y: cy }, r, -Math.PI / 2, Math.PI / 2, false, false),
            ...arcPoints({ x: x + r, y: cy }, r, Math.PI / 2, (3 * Math.PI) / 2, false, false)
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
        const rad = (rotDeg * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        pts = pts.map(p => {
            const dx = p.x - cx, dy = p.y - cy;
            return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
        });
    }
    return pts;
}

function primitiveToLoops(prim) {
    const loops = [];
    switch (prim.type) {
        case "path": {
            const closed = false !== prim.closed;
            for (const c of prim.contours || []) {
                const dense = contourToPoints(c);
                dense.length >= 2 && loops.push({ points: dense, closed: closed, isHole: !!c.isHole });
            }
            break;
        }
        case "circle":
            loops.push({ points: arcPoints(prim.center, prim.radius, 0, 2 * Math.PI, false, true), closed: true, isHole: false });
            break;
        case "rectangle": {
            const { x: x, y: y } = prim.position;
            loops.push({
                points: [
                    { x: x, y: y },
                    { x: x + prim.width, y: y },
                    { x: x + prim.width, y: y + prim.height },
                    { x: x, y: y + prim.height }
                ],
                closed: true,
                isHole: false
            });
            break;
        }
        case "arc":
            loops.push({ points: arcPoints(prim.center, prim.radius, prim.startAngle, prim.endAngle, prim.clockwise, false), closed: false, isHole: false });
            break;
        case "obround":
            loops.push({ points: obroundPoints(prim), closed: true, isHole: false });
            break;
        default: {
            const path = "undefined" != typeof GeometryUtils ? GeometryUtils.primitiveToPath(prim) : null;
            for (const c of path?.contours || []) {
                const dense = contourToPoints(c);
                dense.length >= 2 && loops.push({ points: dense, closed: false !== path.closed, isHole: !!c.isHole });
            }
        }
    }
    return loops;
}

// Layer group

export class GeometryLayer3D {
    constructor(core) {
        this.core = core;
        this.group = new THREE.Group();
        this.group.name = "geometry2d";
        core.contentGroup.add(this.group);
    }

    /**
     * Rebuilds the mirrored 2D geometry from LayerRenderer snapshots.
     */
    setLayers(layerDefs, o = {}) {
        this.clear();
        const baseZ = o.baseZ ?? 0;
        const w2m = o.worldToMachine || (p => p);

        for (const def of layerDefs || []) {
            const t = def.transform;
            const z = baseZ + SURFACE_Z_EPSILON;

            // Local primitive coords → shape world matrix → machine coords
            const mapXY = (x, y) => w2m(t ? { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f } : { x: x, y: y });

            const isVCarveLayer = "vcarve" === def.operationType || def.name?.includes("vcarve");
            const isStencilLayer = "stencil" === def.operationType || def.name?.includes("stencil");
            const isPreviewLayer = def.name?.includes("preview") || "preview" === def.type || true === def.isPreview;
            const isOffsetLayer = def.name?.includes("offset") || "offset" === def.type || true === def.isOffset;
            const isSourceLayer = "source" === def.role || (!isOffsetLayer && !isPreviewLayer && !def.name?.includes("offset") && !def.name?.includes("preview"));
            const isKnifeStencil = isStencilLayer && ("knife" === def.machineClass || "knife" === def.operationType || !def.metadata?.toolDiameter);

            // PCB copper layers (isolation and clearing in EasyTrace) are the only physical filled copper sheets in 3D
            const isCopperLayer = "isolation" === def.operationType || "clearing" === def.operationType || def.name?.includes("isolation") || def.name?.includes("clearing");
            
            // CNC router source layers (unassigned SVG imports, V-carve, profile, pocket, engrave) represent cutting contours on stock
            const isRouterSource = isSourceLayer && ("router" === def.machineClass || "unassigned" === def.operationType) && !isCopperLayer && !isStencilLayer;
            
            const defaultLayerColor = def.color || "#a0a0a0";

            // Multi-color batching for 2D visual parity in 3D
            const batches = new Map();
            const getBatch = (colorHex, isFilled, opacity = 1.0, orderOffset = 0) => {
                const key = `${colorHex}_${isFilled ? "fill" : "line"}_${opacity}_${orderOffset}`;
                let b = batches.get(key);
                if (!b) {
                    b = { colorHex, isFilled, opacity, orderOffset, data: [] };
                    batches.set(key, b);
                }
                return b.data;
            };

            const resolveStatus = (toolRelation, fallback) => {
                return (
                    window.resolveToolRelationColor?.(toolRelation, {
                        error: "#ff0000",
                        warn: "#d2cb00",
                        good: "#16d329"
                    }, fallback) || fallback
                );
            };

            for (const prim of def.primitives || []) {
                const rp = prim.properties;

                // Rotary developed chains
                if ("path3d" === prim.type && rp?.developed && rp.refRadius > 0 && prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    const refR = rp.refRadius;
                    const swapAxis = "y" === rp.axisKind;
                    const wrap = (ax, arc, depth) => {
                        const th = arc / refR;
                        const R = refR + depth;
                        const cross = R * Math.sin(th);
                        const zz = R * Math.cos(th);
                        return swapAxis ? { x: cross, y: ax, z: zz } : { x: ax, y: cross, z: zz };
                    };
                    const outLines = getBatch(defaultLayerColor, false, 1.0, 1);
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const ax0 = pos[i], arc0 = pos[i + 1], d0 = pos[i + 2];
                        const ax1 = pos[i + 3], arc1 = pos[i + 4], d1 = pos[i + 5];
                        const subs = Math.min(1e5, Math.max(1, Math.ceil(Math.abs(arc1 - arc0) / ARC_SEGMENT_LENGTH)));
                        let prev = wrap(ax0, arc0, d0);
                        for (let s = 1; s <= subs; s++) {
                            const ratio = s / subs;
                            const cur = wrap(ax0 + (ax1 - ax0) * ratio, arc0 + (arc1 - arc0) * ratio, d0 + (d1 - d0) * ratio);
                            outLines.push(prev.x, prev.y, prev.z, cur.x, cur.y, cur.z);
                            prev = cur;
                        }
                    }
                    continue;
                }

                // Indexed 3+1 faces
                const ip = prim.properties;
                if ("path3d" === prim.type && ip?.indexed && prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    const ap = ip.indexedApothem || 0;
                    const th = (-(ip.indexA || 0) * Math.PI) / 180;
                    const c = Math.cos(th), s = Math.sin(th);
                    const rotY = "y" === ip.axisKind;
                    const place = (px, py, pz) => {
                        const dz = pz + ap;
                        let X = px, Y = py, Z;
                        if (rotY) {
                            X = px * c + dz * s;
                            Z = -px * s + dz * c;
                        } else {
                            Y = py * c - dz * s;
                            Z = py * s + dz * c;
                        }
                        return { x: X, y: Y, z: Z };
                    };
                    const outLines = getBatch(defaultLayerColor, false, 1.0, 1);
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const a = place(pos[i], pos[i + 1], pos[i + 2]);
                        const b = place(pos[i + 3], pos[i + 4], pos[i + 5]);
                        outLines.push(a.x, a.y, a.z, b.x, b.y, b.z);
                    }
                    continue;
                }

                // True-3D chains (V-Carve / Relief)
                if ("path3d" === prim.type && prim.positions && prim.positions.length >= 6) {
                    const pos = prim.positions;
                    const outLines = getBatch(defaultLayerColor, false, 1.0, 1);
                    for (let i = 0; i + 5 < pos.length; i += 3) {
                        const a = mapXY(pos[i], pos[i + 1]);
                        const b = mapXY(pos[i + 3], pos[i + 4]);
                        outLines.push(a.x, a.y, baseZ + pos[i + 2], b.x, b.y, baseZ + pos[i + 5]);
                    }
                    continue;
                }

                const props = prim.properties || {};
                const role = props.role;
                const toolRelation = props.toolRelation || "exact";
                const isPeck = role === "peck_mark" || props.isToolPeckMark;
                const isCenterline = props.isCenterlinePath;
                const isDrillMilling = role === "drill_milling_path";
                const isSourceHole = role === "drill_hole";
                const isSourceSlot = role === "drill_slot";

                // Drill Peck Marks
                if (isPeck && prim.center && prim.radius > 0) {
                    const c = mapXY(prim.center.x, prim.center.y);
                    const statusColor = resolveStatus(toolRelation, "#16d329");
                    const markSize = Math.min(0.5, prim.radius * 0.4);

                    if (isPreviewLayer) {
                        // Solid circular disk in status color (exact/undersized/oversized)
                        emitAnnulus(c.x, c.y, 0, prim.radius, z, getBatch(statusColor, true, 1.0, 0));
                        // White center crosshair
                        emitCrosshair(c.x, c.y, markSize, z, getBatch("#ffffff", false, 1.0, 1));
                    } else {
                        // Outline circle with 1px line segments
                        emitCircleLines(c.x, c.y, prim.radius, z, getBatch(statusColor, false, 1.0, 0));
                        // Status color crosshair
                        emitCrosshair(c.x, c.y, markSize, z, getBatch(statusColor, false, 1.0, 1));
                    }

                    if (props.reducedPlunge) {
                        emitCircleLines(c.x, c.y, prim.radius * 1.3, z, getBatch("#ff5e00", false, 1.0, 1));
                    }
                    continue;
                }

                // Source Drill Holes & Slots
                if (isSourceHole && prim.center && prim.radius > 0) {
                    const c = mapXY(prim.center.x, prim.center.y);
                    const markSize = Math.min(0.5, prim.radius * 0.6);
                    emitCircleLines(c.x, c.y, prim.radius, z, getBatch("#4488ff", false, 1.0, 0));
                    emitCrosshair(c.x, c.y, markSize, z, getBatch("#4488ff", false, 1.0, 1));
                    continue;
                }

                if (isSourceSlot && props.originalSlot) {
                    const slot = props.originalSlot;
                    const r = (props.diameter || prim.radius * 2) / 2;
                    const p1 = mapXY(slot.start.x, slot.start.y);
                    const p2 = mapXY(slot.end.x, slot.end.y);
                    const markSize = Math.min(0.5, r * 0.6);

                    emitObroundOutline(p1, p2, r, z, getBatch("#4488ff", false, 1.0, 0));
                    emitCrosshair(p1.x, p1.y, markSize, z, getBatch("#4488ff", false, 1.0, 1));
                    emitCrosshair(p2.x, p2.y, markSize, z, getBatch("#4488ff", false, 1.0, 1));
                    continue;
                }

                // Centerline Slots (Exact / Oversized Milling)
                if (isCenterline && prim.contours?.[0]?.points?.length >= 2) {
                    const pts = prim.contours[0].points;
                    const p1 = mapXY(pts[0].x, pts[0].y);
                    const p2 = mapXY(pts[pts.length - 1].x, pts[pts.length - 1].y);
                    const toolDia = props.toolDiameter || def.solidWidth || 1.0;
                    const r = toolDia / 2;
                    const statusColor = resolveStatus(toolRelation, defaultLayerColor);
                    const markSize = Math.min(0.5, r * 0.5);

                    if (isPreviewLayer) {
                        // Swath fill in preview blue
                        emitRibbon([p1, p2], r, z, getBatch(defaultLayerColor, true, 1.0, 0), false);
                        // Centerline in white
                        const whiteLines = getBatch("#ffffff", false, 1.0, 1);
                        whiteLines.push(p1.x, p1.y, z, p2.x, p2.y, z);
                        const markColor = "undersized" === toolRelation ? "#d2cb00" : "#ffffff";
                        emitCrosshair(p1.x, p1.y, markSize, z, getBatch(markColor, false, 1.0, 1));
                        emitCrosshair(p2.x, p2.y, markSize, z, getBatch(markColor, false, 1.0, 1));
                    } else {
                        // Offset mode: outer perimeter outline + centerline + crosshairs in status color
                        const statusLines = getBatch(statusColor, false, 1.0, 1);
                        emitObroundOutline(p1, p2, r, z, statusLines);
                        statusLines.push(p1.x, p1.y, z, p2.x, p2.y, z);
                        emitCrosshair(p1.x, p1.y, markSize, z, statusLines);
                        emitCrosshair(p2.x, p2.y, markSize, z, statusLines);
                    }
                    continue;
                }

                // Standard Primitives & Previews
                const isStroke = (props.stroke && !props.fill) || props.isTrace;
                const bandW = isPreviewLayer && def.solidWidth > 0 ? def.solidWidth : (isStroke ? (props.strokeWidth || 0) : 0);

                // Stencil source: translucent fill; Knife stencil offset: solid fill; CNC router offset: wireframe outline; Cutout: solid substrate base
                const isSolidStencilOffset = isKnifeStencil && isOffsetLayer;
                const isTranslucentStencilSource = isStencilLayer && isSourceLayer;

                // V-carve, unassigned vector artwork, and CNC router source contours must not render as solid opaque polygon caps over 3D stock
                const filled = !isVCarveLayer && !isRouterSource && !bandW && !(isStroke && !isTranslucentStencilSource) && !(def.isOffset && !isSolidStencilOffset) && false !== props.fill;

                let drawColor = defaultLayerColor;
                if (isPreviewLayer) {
                    drawColor = isDrillMilling && "undersized" !== toolRelation ? defaultLayerColor : (def.color || "#0060dd");
                } else if (isDrillMilling) {
                    drawColor = resolveStatus(toolRelation, defaultLayerColor);
                }

                if ("circle" === prim.type && prim.radius > 0 && (bandW > 0 || filled)) {
                    const c = mapXY(prim.center.x, prim.center.y);
                    const ex = mapXY(prim.center.x + prim.radius, prim.center.y);
                    const ey = mapXY(prim.center.x, prim.center.y + prim.radius);
                    const rx = Math.hypot(ex.x - c.x, ex.y - c.y);
                    const ry = Math.hypot(ey.x - c.y, ey.y - c.y);
                    if (Math.abs(rx - ry) < 1e-6 * Math.max(1, rx)) {
                        const fillOpacity = isTranslucentStencilSource ? 0.4 : 1.0;
                        emitAnnulus(c.x, c.y, bandW > 0 ? Math.max(0, rx - bandW / 2) : 0, bandW > 0 ? rx + bandW / 2 : rx, z, getBatch(drawColor, true, fillOpacity, 0));
                        if (isStencilLayer || isSolidStencilOffset) {
                            emitCircleLines(c.x, c.y, rx, z, getBatch(drawColor, false, 1.0, 1));
                        }
                        if (isPreviewLayer && "undersized" === toolRelation) {
                            emitCrosshair(c.x, c.y, Math.min(0.5, rx * 0.4), z, getBatch("#d2cb00", false, 1.0, 1));
                        }
                        continue;
                    }
                }

                const loops = primitiveToLoops(prim);
                const mappedLoops = [];
                for (const loop of loops) {
                    const pts = loop.points;
                    if (!pts || pts.length < 2) continue;
                    const mapped = pts.map(p => mapXY(p.x, p.y));
                    if (loop.closed && mapped.length > 2) {
                        const a = mapped[mapped.length - 1], b = mapped[0];
                        (a.x === b.x && a.y === b.y) || mapped.push({ x: b.x, y: b.y });
                    }
                    mappedLoops.push({ points: mapped, closed: loop.closed, isHole: loop.isHole });
                }

                if (filled && mappedLoops.length > 0 && mappedLoops[0].closed) {
                    const opacity = isTranslucentStencilSource ? 0.4 : 1.0;
                    emitFill(mappedLoops.map(l => l.points), z, getBatch(drawColor, true, opacity, 0));
                    if (isStencilLayer || isSolidStencilOffset) {
                        for (const loop of mappedLoops) {
                            const p = loop.points;
                            const linesOut = getBatch(drawColor, false, 1.0, 1);
                            for (let i = 0; i < p.length - 1; i++) {
                                linesOut.push(p[i].x, p[i].y, z, p[i + 1].x, p[i + 1].y, z);
                            }
                        }
                    }
                } else {
                    for (const loop of mappedLoops) {
                        if (bandW > 0) {
                            emitRibbon(loop.points, bandW / 2, z, getBatch(drawColor, true, 1.0, 0), loop.closed);
                        } else {
                            const p = loop.points;
                            const linesOut = getBatch(drawColor, false, 1.0, 1);
                            for (let i = 0; i < p.length - 1; i++) {
                                linesOut.push(p[i].x, p[i].y, z, p[i + 1].x, p[i + 1].y, z);
                            }
                        }
                    }
                }

                if (isPreviewLayer && isDrillMilling && "undersized" === toolRelation) {
                    if (props.originalSlot) {
                        const slot = props.originalSlot;
                        const p1 = mapXY(slot.start.x, slot.start.y);
                        const p2 = mapXY(slot.end.x, slot.end.y);
                        emitCrosshair(p1.x, p1.y, 0.5, z, getBatch("#d2cb00", false, 1.0, 1));
                        emitCrosshair(p2.x, p2.y, 0.5, z, getBatch("#d2cb00", false, 1.0, 1));
                    } else if (prim.center) {
                        const c = mapXY(prim.center.x, prim.center.y);
                        emitCrosshair(c.x, c.y, 0.5, z, getBatch("#d2cb00", false, 1.0, 1));
                    }
                }
            }

            // Materialize Batches for this Layer
            const layerRenderOrder = 1000 + (def.zIndex || 0) * 2;

            for (const b of batches.values()) {
                const arr = b.data;
                if (!arr || arr.length === 0) continue;

                if (!b.isFilled) {
                    if (arr.length < 6) continue;
                    const g = new THREE.BufferGeometry();
                    g.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
                    const m = new THREE.LineBasicMaterial({
                        color: new THREE.Color(b.colorHex),
                        transparent: b.opacity < 1.0,
                        opacity: b.opacity,
                        depthWrite: false,
                        depthTest: true
                    });
                    const lines = new THREE.LineSegments(g, m);
                    lines.renderOrder = layerRenderOrder + b.orderOffset;
                    lines.name = def.name || "layer2d";
                    lines.userData.layerName = def.name || "";
                    this.group.add(lines);
                } else {
                    if (arr.length < 9) continue;
                    const sg = new THREE.BufferGeometry();
                    sg.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));

                    const sm = new THREE.MeshBasicMaterial({
                        color: new THREE.Color(b.colorHex),
                        side: THREE.DoubleSide,
                        transparent: b.opacity < 1.0,
                        opacity: b.opacity,
                        depthWrite: false,
                        depthTest: true,
                        polygonOffset: true,
                        polygonOffsetFactor: 1,
                        polygonOffsetUnits: 1
                    });
                    const mesh = new THREE.Mesh(sg, sm);
                    mesh.renderOrder = layerRenderOrder + b.orderOffset;
                    mesh.name = (def.name || "layer2d") + "_solid";
                    mesh.userData.layerName = def.name || "";
                    this.group.add(mesh);
                }
            }
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