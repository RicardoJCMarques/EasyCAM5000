/*!
 * @file        renderer3d/renderer3d-simulator.js
 * @description Toolpath playback. Reuses walkPlans() to build a
 *              time-parameterized motion table (same feed math as
 *              MachineProcessor.calculatePathMetrics: dt = dist/feed·60,
 *              rapids at the machine rapid rate), then drives a tool
 *              marker along it with a progressive cut trail.
 *
 *              While loaded+visible it hides ToolpathLayer3D's group and
 *              shows its own trail (same segment order, animated
 *              drawRange); stop() restores the static view. Playback is
 *              the only consumer of core.startAnimation - static viewing
 *              stays on-demand.
 *
 *              v1 simplifications: DWELL contributes no time, peck
 *              sub-moves are one reach, no material removal.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';
import { walkPlans } from './renderer3d-toolpath.js';

const DEFAULT_CUT_FEED = 150;    // mm/min fallback for feed-less cut cmds
const DEFAULT_RAPID_FEED = 1500; // mm/min fallback when machine rate unknown

// REVIEW - This isn't wired up to the UI yet.
export class Simulator3D {
    /** @param {Renderer3D} core */
    constructor(core) {
        this.core = core;
        this.group = new THREE.Group();
        this.group.name = 'simulator';
        this.group.visible = false;
        core.contentGroup.add(this.group);

        this.timeline = [];      // { x1..z2, kind, t0, t1, cutVertexEnd }
        this.duration = 0;
        this.time = 0;
        this.speed = 1;
        this.playing = false;

        this.marker = null;
        this.trail = null;
        this._segCursor = 0;     // monotonic playback hint for segment search
    }

    // ─── Loading ─────────────────────────────────────────────────────

    /**
     * @param {Array<ToolpathPlan>} plans - machine-ready plans (same
     *        array given to ToolpathLayer3D / GCodeGenerator).
     * @param {Object} [o]
     * @param {number} [o.rapidFeedRate] - context.machine.rapidFeedRate
     * @param {Object} [o.tool] - { shape:'flat'|'ball'|'vbit',
     *        diameter, vbitAngle } for the marker mesh
     */
    load(plans, o = {}) {
        this.unload();
        const rapidFeed = o.rapidFeedRate || DEFAULT_RAPID_FEED;

        const segs = [];
        const cutPos = [];
        let cutVerts = 0;
        let t = 0;

        walkPlans(plans, (x1, y1, z1, x2, y2, z2, kind, feed, aDeg, axisKind) => {
            const dist = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
            const f = (kind === 'rapid') ? rapidFeed : (feed || DEFAULT_CUT_FEED);
            const dt = f > 0 ? (dist / f) * 60 : 0;
            if (kind === 'cut') {
                cutPos.push(x1, y1, z1, x2, y2, z2);
                cutVerts += 2;
            }
            segs.push({
                x1, y1, z1, x2, y2, z2, kind,
                t0: t, t1: t + dt,
                cutVertexEnd: cutVerts,
                // [INDEXED] walkPlans emits in the PART-FIXED frame, so the
                // tool has to be tilted by the same R(-A) or it approaches
                // the side of the blank on every face but the first.
                aDeg: aDeg ?? null,
                axisKind: axisKind || null
            });
            t += dt;
        });

        this.timeline = segs;
        this.duration = t;

        // Progressive trail: full cut geometry, revealed via drawRange
        if (cutPos.length > 0) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position',
                new THREE.Float32BufferAttribute(cutPos, 3));
            g.setDrawRange(0, 0);
            const m = new THREE.LineBasicMaterial({
                color: this.core.options.cutColorShallow
            });
            this.trail = new THREE.LineSegments(g, m);
            this.group.add(this.trail);
        }

        this.setTool(o.tool || { shape: 'flat', diameter: 3 });
        this.setTime(0);
    }

    /** Builds the tool marker; local origin = tool TIP, body extends +Z. */
    setTool(spec) {
        if (this.marker) {
            this.marker.traverse(c => {
                c.geometry?.dispose?.();
                c.material?.dispose?.();
            });
            this.group.remove(this.marker);
            this.marker = null;
        }

        const d = spec.diameter || 3;
        const r = d / 2;
        const shaftH = Math.max(d * 4, 12);
        const mat = new THREE.MeshStandardMaterial({
            color: 0xd8dde3, transparent: true, opacity: 0.85
        });
        const marker = new THREE.Group();
        marker.name = 'tool_marker';

        const addZCylinder = (radius, height, zBottom) => {
            const geo = new THREE.CylinderGeometry(radius, radius, height, 24);
            geo.rotateX(Math.PI / 2);                 // axis Y → Z
            geo.translate(0, 0, zBottom + height / 2);
            marker.add(new THREE.Mesh(geo, mat));
        };

        switch (spec.shape) {
            case 'vbit': {
                const angle = (spec.vbitAngle || 90) * Math.PI / 180;
                const tipH = r / Math.tan(angle / 2);
                const cone = new THREE.ConeGeometry(r, tipH, 24);
                cone.rotateX(-Math.PI / 2);           // apex → -Z
                cone.translate(0, 0, tipH / 2);       // apex at local origin
                marker.add(new THREE.Mesh(cone, mat));
                addZCylinder(r, shaftH, tipH);
                break;
            }
            case 'ball': {
                const sphere = new THREE.SphereGeometry(r, 20, 14);
                sphere.translate(0, 0, r);            // tip at local origin
                marker.add(new THREE.Mesh(sphere, mat));
                addZCylinder(r, shaftH, r);
                break;
            }
            default: // flat endmill
                addZCylinder(r, shaftH, 0);
        }

        // Local +Z is the tool axis. setTime re-orients this whole group
        // per segment for indexed playback; a non-indexed job leaves it at
        // identity, which is the machine's real (always +Z) spindle.
        this.marker = marker;
        this.group.add(marker);
    }

    unload() {
        this.pause();
        if (this.trail) {
            this.trail.geometry.dispose();
            this.trail.material.dispose();
            this.group.remove(this.trail);
            this.trail = null;
        }

        // REVIEW - these if ( safety safeguards may not be necessary.
        if (this.marker) {
            this.marker.traverse(c => {
                c.geometry?.dispose?.();
                c.material?.dispose?.();
            });
            this.group.remove(this.marker);
            this.marker = null;
        }

        this.timeline = [];
        this.duration = 0;
        this.time = 0;
        this._segCursor = 0;
        this.group.visible = false;
        if (this.core.toolpaths) this.core.toolpaths.group.visible = true;
    }

    // ─── Transport ───────────────────────────────────────────────────

    play() {
        if (this.playing || this.duration <= 0) return;
        if (this.time >= this.duration) this.setTime(0);   // replay from start
        this.playing = true;
        this.group.visible = true;
        if (this.core.toolpaths) this.core.toolpaths.group.visible = false;
        this.core.startAnimation((dt) => this.tick(dt));
    }

    pause() {
        if (!this.playing) return;
        this.playing = false;
        this.core.stopAnimation();
    }

    /** Stops playback and restores the static toolpath view. */
    stop() {
        this.pause();
        this.setTime(0);
        this.group.visible = false;
        if (this.core.toolpaths) this.core.toolpaths.group.visible = true;
        this.core.requestRender();
    }

    /** @param {number} mult - playback speed multiplier (1 = realtime) */
    setSpeed(mult) {
        this.speed = Math.max(0.05, mult || 1);
    }

    /** @param {number} fraction - 0..1 of total job time */
    seek(fraction) {
        this.group.visible = true;
        if (this.core.toolpaths) this.core.toolpaths.group.visible = false;
        this.setTime(fraction * this.duration);
        if (!this.playing) this.core.requestRender();
    }

    tick(dt) {
        this.setTime(this.time + dt * this.speed);
        if (this.time >= this.duration) this.pause(); // hold on last frame
    }

    // ─── Time → position + trail ─────────────────────────────────────

    setTime(t) {
        this.time = Math.min(this.duration, Math.max(0, t));
        if (this.timeline.length === 0) return;

        const i = this.findSegment(this.time);
        const seg = this.timeline[i];

        // Marker: interpolate within the segment
        if (this.marker) {
            const span = seg.t1 - seg.t0;
            const f = span > 1e-9
                ? (this.time - seg.t0) / span
                : 1;
            this.marker.position.set(
                seg.x1 + (seg.x2 - seg.x1) * f,
                seg.y1 + (seg.y2 - seg.y1) * f,
                seg.z1 + (seg.z2 - seg.z1) * f
            );
            // [INDEXED] Match walkPlans' wrap: the part frame is rotated by
            // R(-A) about the machine rotary axis, so the spindle is too.
            if (seg.aDeg != null && seg.axisKind) {
                const th = -seg.aDeg * Math.PI / 180;
                this.marker.rotation.set(0, 0, 0);
                if (seg.axisKind === 'y') this.marker.rotateY(th);
                else this.marker.rotateX(th);
            } else if (this.marker.rotation.x || this.marker.rotation.y) {
                this.marker.rotation.set(0, 0, 0);
            }
        }

        // Trail: reveal cut segments up to and including the current one
        // once entered (at most one 0.4mm-ish segment ahead of the tool).
        if (this.trail) {
            const prevEnd = i > 0 ? this.timeline[i - 1].cutVertexEnd : 0;
            const count = (seg.kind === 'cut') ? seg.cutVertexEnd : prevEnd;
            this.trail.geometry.setDrawRange(0, count);
        }
    }

    /** Monotonic-friendly segment lookup: cursor walk forward when
     *  playing, binary search on scrubs/rewinds. */
    findSegment(t) {
        const tl = this.timeline;
        let i = this._segCursor;
        if (i >= tl.length || t < tl[i].t0) {
            // Rewind or invalid cursor → binary search
            let lo = 0, hi = tl.length - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (tl[mid].t1 < t) lo = mid + 1;
                else hi = mid;
            }
            i = lo;
        } else {
            while (i < tl.length - 1 && tl[i].t1 < t) i++;
        }
        this._segCursor = i;
        return i;
    }
}