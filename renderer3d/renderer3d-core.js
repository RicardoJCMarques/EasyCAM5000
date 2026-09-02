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

    /**
     * Preferred entry: const view = await Renderer3D.mount(container);
     */
    static async mount(container, options = {}) {
        const r = new Renderer3D(container, options);
        await r.init();
        return r;
    }

    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            // REVIEW - shouldn't these be config and theme material? Aren't they already in the theme jsons?
            // Light
            skyColor: 0xffffff,
            groundColor: 0x303a3a,
            keyIntensity: 1.4,
            fillIntensity: 1.1,

            background: 0x16181c,
            gridSize: 400, // mm
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
        this.simulator = null;
        this.toolController = null;
        this.input = null;

        this._renderQueued = false;
        this._resizeObserver = null;
        this._disposed = false;
        this._animating = false;
        this._animTick = null;
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

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.5, 5000);
        this.camera.position.set(120, -120, 140); // iso-ish, looking at origin
        this.camera.lookAt(0, 0, 0);

        // Lighting: soft hemisphere + one directional for surface relief.
        // Kept as fields because a light theme needs a light ground bounce -
        // a dark bounce under a dark surface colour reads as heavy shadow.
        this.hemi = new THREE.HemisphereLight(this.options.skyColor, this.options.groundColor, this.options.fillIntensity);
        this.scene.add(this.hemi);
        this.dir = new THREE.DirectionalLight(this.options.skyColor, this.options.keyIntensity);
        this.dir.position.set(150, -100, 300);
        this.scene.add(this.dir);

        // Ground grid: GridHelper lies in XZ by default → rotate into XY (Z-up)
        this.grid = this.buildGrid();
        this.scene.add(this.grid);
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

    // Public data API

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

    /**
     * GridHelper lies in XZ by default → rotate into XY (Z-up).
     */
    buildGrid() {
        const grid = new THREE.GridHelper(this.options.gridSize, this.options.gridDivisions, this.options.gridCenterColor, this.options.gridColor);
        grid.rotation.x = Math.PI / 2;
        return grid;
    }

    /**
     * Re-theme in place. Merges over the live options, resets what this class
     * owns (background, grid) and leaves the sub-layers to the caller's
     * refresh - CamController.refresh3D re-pushes stock, layers and plans, so
     * every material that reads core.options is rebuilt from the new palette.
     */
    setOptions(options = {}) {
        Object.assign(this.options, options);
        if (this.scene) this.scene.background = new THREE.Color(this.options.background);
        if (this.hemi) {
            this.hemi.color.set(this.options.skyColor);
            this.hemi.groundColor.set(this.options.groundColor);
            this.hemi.intensity = this.options.fillIntensity;
        }
        if (this.dir) {
            this.dir.color.set(this.options.skyColor);
            this.dir.intensity = this.options.keyIntensity;
        }
        if (this.grid) {
            this.scene.remove(this.grid);
            this.grid.geometry?.dispose?.();
            const m = this.grid.material;
            Array.isArray(m) ? m.forEach(x => x.dispose?.()) : m?.dispose?.();
            this.grid = this.buildGrid();
            this.scene.add(this.grid);
        }
        this.requestRender();
    }

    fitToContent() {
        this.contentGroup.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.contentGroup);
        if (box.isEmpty()) return;


        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        if (!Number.isFinite(size.x) || (size.x <= 0 && size.y <= 0 && size.z <= 0)) return;

        // Isometric view direction (Z-up)
        const dirV = new THREE.Vector3(0.55, -0.55, 0.63).normalize();
        const fovV = (this.camera.fov * Math.PI) / 180;
        const aspect = Math.max(0.1, this.camera.aspect || 1);
        const tanV = Math.tan(fovV / 2);
        const tanH = tanV * aspect;

        // Camera coordinate frame looking at center from dirV
        const camPosTemp = center.clone().add(dirV);
        const lookMat = new THREE.Matrix4().lookAt(camPosTemp, center, new THREE.Vector3(0, 0, 1));
        const camRight = new THREE.Vector3(lookMat.elements[0], lookMat.elements[1], lookMat.elements[2]);
        const camUp = new THREE.Vector3(lookMat.elements[4], lookMat.elements[5], lookMat.elements[6]);

        // 8 corners of the bounding box
        const corners = [
            new THREE.Vector3(box.min.x, box.min.y, box.min.z),
            new THREE.Vector3(box.min.x, box.min.y, box.max.z),
            new THREE.Vector3(box.min.x, box.max.y, box.min.z),
            new THREE.Vector3(box.min.x, box.max.y, box.max.z),
            new THREE.Vector3(box.max.x, box.min.y, box.min.z),
            new THREE.Vector3(box.max.x, box.min.y, box.max.z),
            new THREE.Vector3(box.max.x, box.max.y, box.min.z),
            new THREE.Vector3(box.max.x, box.max.y, box.max.z)
        ];

        let maxDist = 0;
        for (const pt of corners) {
            const rel = pt.clone().sub(center);
            const x = Math.abs(rel.dot(camRight));
            const y = Math.abs(rel.dot(camUp));
            const z = -rel.dot(dirV); // depth along camera view vector
            const reqDist = z + Math.max(x / tanH, y / tanV);
            if (reqDist > maxDist) maxDist = reqDist;
        }

        const dist = Math.max(5, maxDist * 1.15);

        this.camera.position.copy(center).add(dirV.multiplyScalar(dist));
        this.camera.near = Math.max(0.01, dist / 1000);
        this.camera.far = Math.max(1000, dist * 20);
        this.camera.updateProjectionMatrix();
        this.camera.lookAt(center);

        if (this.controls) {
            this.controls.target.copy(center);
            this.controls.update();
        }
        this.requestRender();
    }

    // Render loop (on-demand)

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

    // Animation loop (simulator only)
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

        // Re-attaching without tearing down the previous stack leaves a
        // second InputManager listening on the same canvas.
        if (this.input) { this.input.detach(); this.input = null; }
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

    // Lifecycle

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