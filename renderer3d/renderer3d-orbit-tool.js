/*!
 * @file        renderer3d/renderer3d-orbit-tool.js
 * @description Orbit / pan / dolly camera tool for the 3D view, built on
 *              the shared input stack (InputManager + ToolController +
 *              BaseTool) instead of three's OrbitControls - same
 *              normalized events, same two-pointer pinch path, same
 *              button conventions as the 2D apps:
 *
 *                LMB drag      orbit around the target (Z-up spherical)
 *                MMB/RMB drag  screen-space pan of the target
 *                Wheel         dolly, distance-proportional
 *                Two pointers  pinch dolly + midpoint pan
 *
 *              Owns the orbit target (Vector3). Renderer3D.fitToContent
 *              talks to it through an OrbitControls-shaped adapter
 *              (target / update()) created in attachOrbitTool().
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';

// window.BaseTool comes from the IIFE input stack, loaded long before
// this module is dynamically imported. Local stub keeps the module
// importable standalone (tests).
const Base = (typeof window !== 'undefined' && window.BaseTool)
    ? window.BaseTool
    : class {
        constructor() { this.name = this.constructor.name; }
        onActivate() {} onDeactivate() {}
        onPointerDown() { return false; } onPointerMove() { return false; }
        onPointerUp() { return false; } onWheel() { return false; }
        onKeyDown() { return false; } onKeyUp() { return false; }
        getOverlayState() { return null; }
    };

const ORBIT_SPEED = 0.008;     // rad per CSS px
const DOLLY_SPEED = 0.0015;    // wheel exponent factor
const MIN_RADIUS = 1;          // mm
const MAX_RADIUS = 50000;      // mm
const POLAR_EPS = 0.02;        // keep off the poles (lookAt degeneracy)
const PINCH_DEADBAND = 0.005;

export class Orbit3DTool extends Base {
    /** @param {Renderer3D} view */
    constructor(view, options = {}) {
        super();
        this.view = view;
        this.target = new THREE.Vector3(0, 0, 0);

        // Z-up spherical state: z = r·cos(polar),
        // x = r·sin(polar)·cos(azimuth), y = r·sin(polar)·sin(azimuth)
        this.radius = 200;
        this.polar = Math.PI / 3;
        this.azimuth = -Math.PI / 4;

        this.mode = null;          // 'orbit' | 'pan' | null
        this.lastClient = null;

        this.pinchActive = false;
        this.pinchLastDistance = 0;
        this.pinchLastMid = null;

        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3();

        this.onPick = options.onPick || null;   // ({object, nodeId, layerName, point}) => void
        this.downClient = null;
        this._raycaster = null;
    }

    onActivate() {
        this.syncFromCamera();
    }

    onDeactivate() {
        this.mode = null;
        this.lastClient = null;
        this.pinchActive = false;
    }

    /** Re-derives spherical state from wherever the camera currently is
     *  (called by the fitToContent adapter after it repositions). */
    syncFromCamera() {
        const off = this.view.camera.position.clone().sub(this.target);
        this.radius = Math.max(MIN_RADIUS, off.length());
        this.polar = Math.acos(
            Math.min(1, Math.max(-1, off.z / this.radius)));
        this.polar = Math.min(Math.PI - POLAR_EPS, Math.max(POLAR_EPS, this.polar));
        this.azimuth = Math.atan2(off.y, off.x);
    }

    updateCamera() {
        const sp = Math.sin(this.polar);
        this.view.camera.position.set(
            this.target.x + this.radius * sp * Math.cos(this.azimuth),
            this.target.y + this.radius * sp * Math.sin(this.azimuth),
            this.target.z + this.radius * Math.cos(this.polar)
        );
        this.view.camera.lookAt(this.target);
        this.view.requestRender();
    }

    // ─── Pointer handling ────────────────────────────────────────────

    onPointerDown(data, ctx) {
        const active = ctx.input ? ctx.input.activePointers.size : 1;
        if (active === 2) {
            this.startPinch(ctx);
            return true;
        }
        this.mode = (data.button === 1 || data.button === 2) ? 'pan' : 'orbit';
        this.lastClient = { x: data.clientX, y: data.clientY };
        this.downClient = { x: data.clientX, y: data.clientY, cssX: data.cssX, cssY: data.cssY };
        return true;
    }

    onPointerMove(data, ctx) {
        const pointers = ctx.input ? ctx.input.activePointers : null;
        if (pointers && pointers.size === 2) {
            if (!this.pinchActive) this.startPinch(ctx);
            this.updatePinch(ctx);
            return true;
        }

        if (!this.lastClient || !this.mode) return false;
        const dx = data.clientX - this.lastClient.x;
        const dy = data.clientY - this.lastClient.y;
        this.lastClient = { x: data.clientX, y: data.clientY };

        if (this.mode === 'orbit') {
            this.azimuth -= dx * ORBIT_SPEED;
            this.polar = Math.min(Math.PI - POLAR_EPS,
                Math.max(POLAR_EPS, this.polar - dy * ORBIT_SPEED));
        } else {
            this.pan(dx, dy);
        }
        this.updateCamera();
        return true;
    }

    onPointerUp(data, ctx) {
        const pointers = ctx.input ? ctx.input.activePointers : null;
        if (this.pinchActive) {
            if (pointers && pointers.size === 1) {
                // 2→1 transition: hand off to single-pointer orbit cleanly
                const remaining = Array.from(pointers.values())[0];
                this.lastClient = { x: remaining.clientX, y: remaining.clientY };
                this.mode = 'orbit';
                this.pinchActive = false;
                return true;
            }
            this.pinchActive = false;
        }

        // Click (down→up inside the dead zone) = pick, not orbit
        if (this.onPick && this.mode === 'orbit' && this.downClient) {
            const dx = data.clientX - this.downClient.x;
            const dy = data.clientY - this.downClient.y;
            const slop = (data.pointerType === 'touch') ? 10 : 5;
            if ((dx * dx + dy * dy) < slop * slop) {
                const hit = this.pick(data.cssX, data.cssY);
                if (hit) this.onPick(hit);
            }
        }
        this.downClient = null;
        this.mode = null;
        this.lastClient = null;
        return true;
    }

    /** Raycasts contentGroup and reports the nearest tagged object. */
    pick(cssX, cssY) {
        const el = this.view.renderer.domElement;
        const ndc = new THREE.Vector2(
            (cssX / (el.clientWidth || 1)) * 2 - 1,
            -(cssY / (el.clientHeight || 1)) * 2 + 1
        );
        if (!this._raycaster) {
            this._raycaster = new THREE.Raycaster();
            this._raycaster.params.Line = { threshold: 0.75 }; // mm
        }
        this._raycaster.setFromCamera(ndc, this.view.camera);
        // Only the geometry and stock layers tag objects with nodeId /
        // layerName, and the loop below discards everything else - so
        // raycasting contentGroup made every click walk hundreds of
        // thousands of toolpath line segments to produce nothing.
        const pickable = [];
        if (this.view.geometry?.group) pickable.push(this.view.geometry.group);
        if (this.view.stock?.group) pickable.push(this.view.stock.group);
        if (pickable.length === 0) return null;
        const hits = this._raycaster.intersectObjects(pickable, true);
        for (const hit of hits) {
            let o = hit.object;
            while (o && o !== this.view.contentGroup && o !== this.view.scene) {
                if (o.userData?.nodeId || o.userData?.layerName) {
                    return {
                        object: o,
                        nodeId: o.userData.nodeId || null,
                        layerName: o.userData.layerName || null,
                        point: hit.point
                    };
                }
                o = o.parent;
            }
        }
        return null;
    }

    onWheel(data) {
        this.radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS,
            this.radius * Math.exp(data.deltaY * DOLLY_SPEED)));
        this.updateCamera();
        return true;
    }

    // ─── Pan: move the target in the camera's screen plane ──────────

    pan(dxPx, dyPx) {
        const cam = this.view.camera;
        const h = this.view.renderer.domElement.clientHeight || 1;
        const worldPerPx =
            (2 * this.radius * Math.tan((cam.fov * Math.PI / 180) / 2)) / h;

        this._right.setFromMatrixColumn(cam.matrix, 0);
        this._up.setFromMatrixColumn(cam.matrix, 1);
        this.target
            .addScaledVector(this._right, -dxPx * worldPerPx)
            .addScaledVector(this._up, dyPx * worldPerPx);
    }

    // ─── Pinch (dolly + midpoint pan), same shape as PanZoomTool ────

    startPinch(ctx) {
        const pts = Array.from(ctx.input.activePointers.values());
        if (pts.length < 2) return;
        const [a, b] = pts;
        this.pinchLastDistance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        this.pinchLastMid = {
            x: (a.clientX + b.clientX) / 2,
            y: (a.clientY + b.clientY) / 2
        };
        this.pinchActive = true;
        this.lastClient = null;
        this.mode = null;
    }

    updatePinch(ctx) {
        const pts = Array.from(ctx.input.activePointers.values());
        if (pts.length < 2 || !this.pinchLastMid) return;
        const [a, b] = pts;
        const distance = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;

        this.pan(midX - this.pinchLastMid.x, midY - this.pinchLastMid.y);

        if (this.pinchLastDistance > 0) {
            const ratio = distance / this.pinchLastDistance;
            if (Math.abs(1 - ratio) > PINCH_DEADBAND) {
                this.radius = Math.min(MAX_RADIUS,
                    Math.max(MIN_RADIUS, this.radius / ratio));
            }
        }
        this.updateCamera();
        this.pinchLastDistance = distance;
        this.pinchLastMid = { x: midX, y: midY };
    }
}