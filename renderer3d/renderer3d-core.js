/*!
 * @file        renderer3d/renderer3d-core.js
 * @description 3D preview renderer - ESM entry for the renderer3d family.
 *              Owns the full lifecycle (scene, camera, resize, dispose)
 *              and the sub-layers (ToolpathLayer3D, StockLayer3D). No
 *              index.js: importing this module IS mounting the pipeline.
 *
 *              Coordinate frame: machine coordinates, mm, Z-up. Consumes
 *              machine-ready ToolpathPlans (post-MachineProcessor), i.e.
 *              the exact array handed to GCodeGenerator.generate - the
 *              preview can never diverge from the export.
 *
 *              Rendering is ON-DEMAND: requestRender() coalesces into one
 *              rAF frame. No continuous loop until the simulator lands.
 *
 *              WebGPURenderer initializes WebGPU and falls back to WebGL2
 *              automatically on unsupported browsers.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';
import { ToolpathLayer3D } from './renderer3d-toolpath.js';
import { StockLayer3D } from './renderer3d-stock.js';
import { Simulator3D } from './renderer3d-simulator.js';
import { GeometryLayer3D } from './renderer3d-geometry.js';

// Machine coordinates are Z-up. Must be set before cameras/controls exist.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Renderer3D {

    /** Preferred entry: const view = await Renderer3D.mount(container); */
    static async mount(container, options = {}) {
        const r = new Renderer3D(container, options);
        await r.init();
        return r;
    }

    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            // REVIEW - shouldn't these be config and theme material?
            background: 0x16181c,
            gridSize: 400,          // mm
            gridDivisions: 40,
            gridColor: 0x2a2e34,
            gridCenterColor: 0x3a3f46,
            rapidColor: 0x565b63,
            cutColorShallow: 0x4fc3f7,
            cutColorDeep: 0xe07a7a,
            stockColor: 0x8a7a5c,
            surfaceColor: 0xb0a58e,
            ...options
        };

        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.controls = null;
        this.contentGroup = null;   // everything fitToContent frames
        this.toolpaths = null;
        this.stock = null;
        this.geometry = null;

        this._renderQueued = false;
        this._resizeObserver = null;
        this._disposed = false;
    }

    async init() {
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;

        this.renderer = new THREE.WebGPURenderer({ antialias: true });
        await this.renderer.init(); // async backend selection (WebGPU → WebGL2)
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(w, h);
        this.container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.options.background);

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);
        this.camera.position.set(120, -120, 140); // iso-ish, looking at origin
        this.camera.lookAt(0, 0, 0);

        // Lighting: soft hemisphere + one directional for surface relief
        this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343a, 1.1));
        const dir = new THREE.DirectionalLight(0xffffff, 1.4);
        dir.position.set(150, -100, 300);
        this.scene.add(dir);

        // Ground grid: GridHelper lies in XZ by default → rotate into XY (Z-up)
        const grid = new THREE.GridHelper(
            this.options.gridSize, this.options.gridDivisions,
            this.options.gridCenterColor, this.options.gridColor
        );
        grid.rotation.x = Math.PI / 2;
        this.scene.add(grid);
        this.scene.add(new THREE.AxesHelper(20)); // X red, Y green, Z blue

        this.contentGroup = new THREE.Group();
        this.contentGroup.name = 'content';
        this.scene.add(this.contentGroup);

        // Sub-layers
        this.toolpaths = new ToolpathLayer3D(this);
        this.stock = new StockLayer3D(this);
        this.simulator = new Simulator3D(this);
        this.geometry = new GeometryLayer3D(this);

        this._resizeObserver = new ResizeObserver(() => this.onResize());
        this._resizeObserver.observe(this.container);

        this.requestRender();
    }

    // ─── Public data API ─────────────────────────────────────────────

    /**
     * @param {Array<ToolpathPlan>} plans - machine-ready (post-processor)
     * @param {Object} [o]
     * @param {boolean} [o.fit=false] - frame content after loading.
     *        Live refreshes pass nothing so the camera never jumps.
     */
    setPlans(plans, o = {}) {
        this.toolpaths.setPlans(plans);
        if (o.fit) this.fitToContent();
        this.requestRender();
    }

    /** @param {Heightmap} heightmap - from HeightmapBuilder / HeightmapPrimitive.heightmap */
    setHeightmap(heightmap, opts = {}) {
        this.stock.setHeightmapSurface(heightmap, opts);
        this.requestRender();
    }

    /** @param {{minX,minY,maxX,maxY,thickness,topZ?}} box */
    setStock(box) {
        this.stock.setStock(box);
        this.requestRender();
    }

    fitToContent() {
        const box = new THREE.Box3().setFromObject(this.contentGroup);
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) return;
        const dist = sphere.radius /
            Math.sin((this.camera.fov * Math.PI / 180) / 2) * 1.15;

        // Iso direction, preserving Z-up
        const dirV = new THREE.Vector3(0.55, -0.55, 0.63).normalize();
        this.camera.position.copy(sphere.center)
            .add(dirV.multiplyScalar(dist));
        this.camera.near = Math.max(0.01, dist / 1000);
        this.camera.far = dist * 20;
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(sphere.center);

        if (this.controls) {
            this.controls.target.copy(sphere.center);
            this.controls.update();
        }
        this.requestRender();
    }

    // ─── Render loop (on-demand) ─────────────────────────────────────

    requestRender() {
        if (this._renderQueued || this._disposed) return;
        this._renderQueued = true;
        requestAnimationFrame(() => {
            this._renderQueued = false;
            if (this._disposed) return;
            this.renderer.render(this.scene, this.camera);
        });
    }

    onResize() {
        if (this._disposed) return;
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.requestRender();
    }

    // ─── Animation loop (simulator only) ─────────────────────────────
    // The on-demand requestRender path stays authoritative for static
    // viewing; this continuous loop runs ONLY while the simulator plays.

    startAnimation(tick) {
        this._animTick = tick;
        if (this._animating) return;
        this._animating = true;
        let last = performance.now();
        const loop = (now) => {
            if (!this._animating || this._disposed) return;
            const dt = Math.min(0.1, (now - last) / 1000); // clamp tab-switch jumps
            last = now;
            this._animTick?.(dt);
            this.renderer.render(this.scene, this.camera);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    stopAnimation() {
        this._animating = false;
        this._animTick = null;
        this.requestRender();
    }

    /**
     * Wires the app's shared input stack (InputManager + ToolController
     * + Orbit3DTool) as the camera controls. Requires the IIFE input
     * modules - without them the view stays static (OrbitControls is
     * gone). The adapter object keeps fitToContent()'s controls.target /
     * controls.update() contract working unchanged.
     */
    async attachOrbitTool(options = {}) {
        if (typeof window.InputManager === 'undefined' ||
            typeof window.ToolController === 'undefined') {
            console.warn('[Renderer3D] Input stack not loaded - 3D view will be static');
            return false;
        }
        const { Orbit3DTool } = await import('./renderer3d-orbit-tool.js');

        if (this.controls) { this.controls.dispose(); this.controls = null; }

        const orbit = new Orbit3DTool(this, options);
        const context = { view: this, canvas: this.renderer.domElement };
        this.toolController = new window.ToolController(context);
        this.input = new window.InputManager(this.renderer.domElement);
        this.toolController.setInputManager(this.input);
        this.input.attach(this.toolController);
        this.toolController.setDefaultTool(orbit);

        this.controls = {
            target: orbit.target,
            update: () => orbit.syncFromCamera(),
            dispose: () => {}
        };
        return true;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────

    dispose() {
        this._disposed = true;
        this.stopAnimation();
        this._resizeObserver?.disconnect();
        this.input?.detach();
        this.controls?.dispose();
        this.simulator?.unload();
        this.toolpaths?.clear();
        this.geometry?.clear();
        this.stock?.clear();
        this.scene.traverse(obj => {
            obj.geometry?.dispose?.();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach(x => x.dispose?.());
            else m?.dispose?.();
        });
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }
}

window.Renderer3D = Renderer3D;