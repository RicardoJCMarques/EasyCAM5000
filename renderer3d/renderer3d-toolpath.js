/*!
 * @file        renderer3d/renderer3d-toolpath.js
 * @description Machine-ready plans → line geometry. Walks commands with
 *              the same stateful position resolution as GCodeGenerator
 *              (null coord = unchanged), so what renders IS what exports.
 *
 *              Two LineSegments objects per batch:
 *                - rapids: dim, semi-transparent (RAPID / RETRACT moves)
 *                - cuts:   per-vertex color, depth gradient shallow→deep
 *
 *              walkPlans() is exported standalone - the future simulator
 *              module reuses it to time-parameterize the same motion.
 *
 *              NOTE: LineBasicMaterial renders 1px lines regardless of
 *              linewidth (WebGL/WebGPU limitation). Good enough for the
 *              preview draft; upgrade to Line2 fat lines when polish
 *              matters.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';

const ARC_SEGMENT_LENGTH = window.CAMConfig?.defaults?.rendering?.preview3D?.arcSegmentLength ?? 0.4;

/**
 * Walks plans/commands, resolving null coordinates against the running
 * position, and emits segments via callback:
 *   emit(x1,y1,z1, x2,y2,z2, kind, feed, aDeg, axisKind)
 *     kind: 'rapid' | 'cut'
 *     aDeg/axisKind: [INDEXED] the wrap this segment was drawn under
 *       (null when not indexed). Emitted coordinates are in the
 *       PART-FIXED frame, so anything drawn ALONGSIDE the path - the
 *       simulator's tool marker above all - has to carry the same
 *       R(-A) or it points into the side of the part on every face
 *       but the first.
 *     feed: mm/min from the command (undefined for rapids - caller
 *           substitutes the machine rapid rate; the simulator does).
 * Returns { minZ, maxZ } across cut segments (for color mapping).
 * Known simplifications: DWELL contributes no time/motion here (the
 * simulator notes it), peck sub-moves render as one down-up reach.
 */
export function walkPlans(plans, emit) {
    const pos = { x: 0, y: 0, z: 0 };   // RAW face-local frame (null-resolution)
    let minZ = Infinity, maxZ = -Infinity;

    // [INDEXED] Display-only face wrap for 3+1 plans. The EXPORTED frame is
    // face-local: X/Y in the top face's plane, Z below the shared face top
    // (Z0 = 0), cmd.a = absolute A/B face angle. The machine reaches each
    // face by POSITIONING A then cutting 3-axis, so exported Z is already
    // correct - the centerline +refR shift is the CONTINUOUS-rotary
    // convention and must never touch indexed (it is the literal "eyes
    // under the back of the head" transform; see convertDevelopedToRotary).
    // For the preview only, rigidly rotate each face's motion about the
    // rotary-axis line at Z = -apothem (apothem below the face top) by its
    // accumulated angle, so all faces land on the one physical blank.
    // Latched on first sight, never cleared (one operation per batch).
    // +A verbatim: if the preview mirrors the machine, fix the ONE angle in
    // the handler's buildFaceSliceOptions, never here.
    let curA = 0, wrapAxis = null, apothem = 0;
    // [ROTARY] Continuous 4th-axis wrap. Developed plans carry
    // x = axial, y = θ·refRadius, z = R - refRadius, and the machine
    // reaches them by rotating the part - so drawing them flat shows a
    // ribbon that exists nowhere. GeometryLayer3D already wraps the
    // OFFSET mirror of the same chains; without this the two 3D layers
    // render the same operation in two different frames, which is how a
    // stub cut in the wrong direction can look correct on screen.
    // Axis line at Z = -refRadius (blank top tangent to Z0) and cross
    // offset axisB, matching GeometryLayer3D's developed block exactly.
    let devR = 0, devAxisB = 0, devSwap = false;
    const wrapPt = (x, y, z) => {
        if (devR > 0) {
            const th = y / devR;
            const R = devR + z;
            const cross = devAxisB + R * Math.sin(th);
            const zz = R * Math.cos(th) - devR;
            return devSwap ? { x: cross, y: x, z: zz } : { x, y: cross, z: zz };
        }
        if (!wrapAxis || curA === 0) return { x, y, z };
        // R_axis(-A), matching how a 4th-axis viewer/controller places moves
        // (the table turns +A, so a machine point sits at -A in the part
        // frame) - and matching the export. The slicer captures each face
        // with R_axis(+θk) and the A word is +θk, so R_axis(-A)=R_axis(-θk)
        // rotates it back onto the physical part: screen == G-code. Using
        // +A here inverts every face at 3+ counts (correct only at 0/180).
        // THREE COUPLED SITES - flip together or not at all:
        //   1. ShapeIndexedHandler.buildFaceSliceOptions  rotAboutAxis(+θk)
        //   2. this wrapPt                                          R(-A)
        //   3. GeometryLayer3D's [INDEXED] block (renderer3d-geometry.js) R(-A)
        // (3) is the offset-geometry mirror and reads primitive PROPERTIES
        // (ip.indexA) while this reads plan METADATA (cmd.a) - a grep for
        // one will not find the other, and both draw in the same frame.
        const th = -curA * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
        const dz = z + apothem;                       // axis is apothem below Z0
        if (wrapAxis === 'y') {                        // B about world Y: rotate (x,z)
            return { x: x * c + dz * s, y, z: -x * s + dz * c - apothem };
        }
        return { x, y: y * c - dz * s, z: y * s + dz * c - apothem }; // A about world X
    };

    const seg = (x, y, z, kind, feed) => {
        if (x === pos.x && y === pos.y && z === pos.z) return;   // RAW no-op
        const a = wrapPt(pos.x, pos.y, pos.z);
        const b = wrapPt(x, y, z);
        emit(a.x, a.y, a.z, b.x, b.y, b.z, kind, feed,
             wrapAxis ? curA : null, wrapAxis);
        if (kind === 'cut') {                          // colour maps on DISPLAY Z
            if (b.z < minZ) minZ = b.z;
            if (a.z < minZ) minZ = a.z;
            if (b.z > maxZ) maxZ = b.z;
            if (a.z > maxZ) maxZ = a.z;
        }
        pos.x = x; pos.y = y; pos.z = z;               // store RAW
    };

    for (const plan of (plans || [])) {
        const m = plan.metadata;
        // Wrap frame, re-read from every indexed plan that carries one
        // (NOT latch-once - the comment used to claim first-sight, the code
        // has always been last-wins). Safe because executePipeline runs one
        // operation per batch, so every plan in `plans` shares a frame;
        // index-link plans are stamped to match in insertIndexMoves so the
        // very first A rapid wraps too.
        if (m && m.indexedApothem != null) {
            apothem = m.indexedApothem;
            wrapAxis = (m.rotaryAxisKind === 'y') ? 'y' : 'x';
        }
        // Developed frame, re-read per plan for the same reason. Cleared
        // when a plan is NOT developed so a converted batch (export path,
        // where MachineProcessor already un-wrapped to X/A/Z) draws raw.
        if (m && m.developedSpace === true && m.refRadius > 0) {
            devR = m.refRadius;
            devAxisB = m.axisB || 0;
            devSwap = m.rotaryAxisKind === 'y';
        } else if (m && m.developedSpace === false) {
            devR = 0;
        }
        for (const cmd of plan.commands) {
            // A/B accumulates BEFORE motion: the index move is an a-only
            // RAPID (no XYZ change) that seg() skips, so reading it here is
            // the only place curA advances for the next face.
            if (cmd.a !== null && cmd.a !== undefined) curA = cmd.a;

            const tx = (cmd.x !== null && cmd.x !== undefined) ? cmd.x : pos.x;
            const ty = (cmd.y !== null && cmd.y !== undefined) ? cmd.y : pos.y;
            const tz = (cmd.z !== null && cmd.z !== undefined) ? cmd.z : pos.z;

            switch (cmd.type) {
                case 'RAPID':
                case 'RETRACT':
                    seg(tx, ty, tz, 'rapid', undefined);
                    break;

                case 'DWELL':
                    break; // no motion

                case 'CANNED_SIMPLE':
                case 'CANNED_PECK': {
                    const retract = cmd.retract ?? pos.z;
                    seg(tx, ty, retract, 'rapid', undefined);
                    seg(tx, ty, tz, 'cut', cmd.f);
                    seg(tx, ty, retract, 'rapid', undefined);
                    break;
                }

                case 'ARC_CW':
                case 'ARC_CCW': {
                    const sx = pos.x, sy = pos.y, sz = pos.z;
                    const cx = sx + (cmd.i || 0);
                    const cy = sy + (cmd.j || 0);
                    const radius = Math.hypot(cmd.i || 0, cmd.j || 0);
                    if (radius < 1e-9) { seg(tx, ty, tz, 'cut', cmd.f); break; }

                    const a0 = Math.atan2(sy - cy, sx - cx);
                    const a1 = Math.atan2(ty - cy, tx - cx);
                    let sweep = a1 - a0;
                    if (cmd.type === 'ARC_CW') {
                        if (sweep >= -1e-9) sweep -= 2 * Math.PI;
                    } else {
                        if (sweep <= 1e-9) sweep += 2 * Math.PI;
                    }
                    if (Math.hypot(tx - sx, ty - sy) < 1e-6 && Math.abs(sweep) < 1e-6) {
                        sweep = (cmd.type === 'ARC_CW') ? -2 * Math.PI : 2 * Math.PI;
                    }

                    const steps = Math.max(2,
                        Math.ceil((Math.abs(sweep) * radius) / ARC_SEGMENT_LENGTH));
                    for (let s = 1; s <= steps; s++) {
                        const a = a0 + (sweep * s) / steps;
                        const zi = sz + ((tz - sz) * s) / steps;
                        const px = (s === steps) ? tx : cx + radius * Math.cos(a);
                        const py = (s === steps) ? ty : cy + radius * Math.sin(a);
                        seg(px, py, zi, 'cut', cmd.f);
                    }
                    break;
                }

                default: // LINEAR, PLUNGE, anything feed-driven
                    seg(tx, ty, tz, 'cut', cmd.f);
            }
        }
    }
    if (!Number.isFinite(minZ)) { minZ = 0; maxZ = 0; }
    return { minZ, maxZ };
}

export class ToolpathLayer3D {
    constructor(core) {
        this.core = core;
        this.group = new THREE.Group();
        this.group.name = 'toolpaths';
        core.contentGroup.add(this.group);
        this.depthRange = { minZ: 0, maxZ: 0 };
    }

    /** @param {Array<ToolpathPlan>} plans - machine-ready plans */
    setPlans(plans) {
        this.clear();

        const rapidPos = [];
        const cutPos = [];

        const range = walkPlans(plans, (x1, y1, z1, x2, y2, z2, kind) => {
            const target = (kind === 'rapid') ? rapidPos : cutPos;
            target.push(x1, y1, z1, x2, y2, z2);
        });
        this.depthRange = range;

        // Rapids: dim single-color segments
        if (rapidPos.length > 0) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position',
                new THREE.Float32BufferAttribute(rapidPos, 3));
            const m = new THREE.LineBasicMaterial({
                color: this.core.options.rapidColor,
                transparent: true,
                opacity: 0.35
            });
            this.group.add(new THREE.LineSegments(g, m));
        }

        // Cuts: per-vertex depth gradient (surface → deepest)
        if (cutPos.length > 0) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position',
                new THREE.Float32BufferAttribute(cutPos, 3));

            const shallow = new THREE.Color(this.core.options.cutColorShallow);
            const deep = new THREE.Color(this.core.options.cutColorDeep);
            const span = Math.max(1e-6, range.maxZ - range.minZ);
            const colors = new Float32Array(cutPos.length);
            const c = new THREE.Color();
            for (let i = 0; i < cutPos.length; i += 3) {
                const t = (range.maxZ - cutPos[i + 2]) / span; // 0 surface → 1 deepest
                c.copy(shallow).lerp(deep, Math.min(1, Math.max(0, t)));
                colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b;
            }
            g.setAttribute('color', new THREE.BufferAttribute(colors, 3));

            const m = new THREE.LineBasicMaterial({ vertexColors: true });
            this.group.add(new THREE.LineSegments(g, m));
        }
    }

    clear() {
        for (const child of [...this.group.children]) {
            child.geometry?.dispose?.();
            child.material?.dispose?.();
            this.group.remove(child);
        }
    }
}