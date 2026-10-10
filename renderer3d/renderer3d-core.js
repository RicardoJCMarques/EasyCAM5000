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
 *              Frames run in three's animation loop while the view is
 *              active (setActive). requestRender() only marks the scene
 *              dirty; the loop callback sizes the drawing buffer first and
 *              draws second, so a drawn frame is never resized before it is
 *              presented. A hidden view runs no loop at all.
 *
 *              WebGPURenderer initializes WebGPU and falls back to WebGL2
 *              automatically on unsupported browsers.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}

 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from "three/webgpu";
import { ToolpathLayer3D } from "./renderer3d-toolpath.js";
import { StockLayer3D } from "./renderer3d-stock.js";
import { Simulator3D } from "./renderer3d-simulator.js";
import { GeometryLayer3D } from "./renderer3d-geometry.js";
import { Orbit3DTool } from "./renderer3d-orbit-tool.js";

// Machine coordinates are Z-up. Must be set before cameras/controls exist.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export class Renderer3D {

    /**
     * Preferred entry: const view = await Renderer3D.mount(container);
     * The view starts inactive; the owner calls setActive(true) once the
     * container is visible and populated.
     */
    static async mount(container, options) {
        const r = new Renderer3D(container, options);
        await r.init();
        return r;
    }

    /**
     * @param {HTMLElement} container - sized by layout; the canvas fills it
     * @param {Object} options - the theme palette (every colour key, from
     *  CamController.buildRenderer3DOptions), plus onDeviceLost(info),
     *  called once when the WebGPU device or WebGL context is lost
     */
    constructor(container, options) {
        this.container = container;
        this.options = {
            // REVIEW - shouldn't these be config or theme jsons? 
            // Light
            keyIntensity: 1.4,
            fillIntensity: 1.1,
            gridSize: 400, // mm
            gridDivisions: 40,
            ...options
        };

        this.renderer = null;
        this.scene = null;
        this.camera = null;
        this.controls = null;
        this.contentGroup = null; // everything fitToContent frames
        this.hemi = null;
        this.dir = null;
        this.grid = null;
        this.toolpaths = null;
        this.stock = null;
        this.geometry = null;
        this.simulator = null;
        this.toolController = null;
        this.input = null;
        this.orbitTool = null;

        this._orbitKeyHandler = null;
        this._width = 0; // CSS px the drawing buffer is sized to
        this._height = 0;
        this._pixelRatio = 0;
        this._active = false;
        this._needsRender = false;
        this._deviceLost = false;
        this._animTick = null;
        this._lastTime = null;
        this._onFrame = (time) => this._frame(time);
    }

    async init() {
        const cfg = window.CAMConfig.defaults.rendering.preview3D;

        // The scene graph needs no GPU, and the camera has to exist before
        // the first size sync sets its aspect.
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.options.background);

        this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
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

        const renderer = new THREE.WebGPURenderer({
            antialias: cfg.antialias,
            alpha: false, // the scene background is opaque
            forceWebGL: cfg.forceWebGL
        });
        this.renderer = renderer;

        // pixel ratio and size before init, so the canvas context is
        // configured at its real size.
        this._syncSize();
        try {
            await renderer.init();
        } catch (err) {
            this.renderer = null; // the canvas was never attached
            throw err;
        }
        // init() starts three's internal rAF loop; setActive() runs it only
        // while the view is shown.
        renderer._animation.stop();

        // Wrapped, not replaced: three's handler logs the loss and sets the
        // flag that stops its own render path. WebGL context loss arrives
        // through the same hook.
        const handleDeviceLost = renderer.onDeviceLost;
        renderer.onDeviceLost = (info) => {
            handleDeviceLost.call(renderer, info);
            this._deviceLost = true;
            this.setActive(false);
            this.options.onDeviceLost?.(info);
        };

        this.container.appendChild(renderer.domElement);

        // Size changes only mark the view dirty; _frame applies them
        // before drawing.
        new ResizeObserver(() => {
            if (this._active) this._needsRender = true;
        }).observe(this.container);

        this.debug(`three r${THREE.REVISION}, ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'} backend`);
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
        for (const [k, v] of Object.entries(options)) {
            if (v !== undefined) this.options[k] = v;
        }
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
        this._syncSize();
        this.contentGroup.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(this.contentGroup);
        if (box.isEmpty()) return;

        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        // One non-finite vertex makes the box non-finite, and a camera placed
        // from it leaves the orbit state NaN.
        if (!Number.isFinite(center.x + center.y + center.z + size.x + size.y + size.z)) return;
        if (size.x <= 0 && size.y <= 0 && size.z <= 0) return;

        // Isometric view direction (Z-up)
        const dirV = new THREE.Vector3(0.55, -0.55, 0.63).normalize();
        const fovV = (this.camera.fov * Math.PI) / 180;
        const aspect = Math.max(0.1, this.camera.aspect);
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

    // Frame loop

    /** Marks the scene dirty; the next frame of an active view draws it. */
    requestRender() {
        this._needsRender = true;
    }

    /**
     * Starts or stops the frame loop. Called by the owner when the view is
     * shown or hidden: a hidden canvas is neither resized nor drawn.
     */
    setActive(active) {
        const run = active && !this._deviceLost;
        if (run === this._active) return;
        this._active = run;
        // setAnimationLoop(null) only drops the callback; three's loop itself
        // stops only through _animation, which is private API - re-check it on
        // three upgrades.
        if (run) {
            this._needsRender = true;
            this._lastTime = null;
            // start() runs one tick synchronously, so the callback goes in
            // after it and the first _frame gets a real rAF timestamp.
            this.renderer._animation.start();
            this.renderer.setAnimationLoop(this._onFrame);
        } else {
            this.renderer.setAnimationLoop(null);
            this.renderer._animation.stop();
        }
    }

    /**
     * Matches the drawing buffer to the container. Returns false while the
     * container has no size, keeping the last buffer. Writes only on a real
     * change: every canvas size write discards the current WebGPU texture
     * and three's canvas attachments.
     */
    _syncSize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return false;
        const pixelRatio = window.devicePixelRatio;
        if (w === this._width && h === this._height && pixelRatio === this._pixelRatio) return true;
        this._width = w;
        this._height = h;
        this._pixelRatio = pixelRatio;
        // One buffer write for both: setPixelRatio alone already resizes the
        // buffer at the previous size. CSS sizes the canvas element.
        this.renderer.setDrawingBufferSize(w, h, pixelRatio);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        return true;
    }

    /** three's animation-loop callback: size first, then draw, once per dirty frame. */
    _frame(time) {
        if (this._animTick) {
            const dt = this._lastTime === null ? 0 : Math.min(0.1, (time - this._lastTime) / 1000); // clamp tab-switch jumps
            this._lastTime = time;
            this._animTick(dt);
            this._needsRender = true;
        }
        if (!this._needsRender || !this._syncSize()) return;
        this._needsRender = false;
        this.renderer.render(this.scene, this.camera);
    }

    // Simulator playback ticks inside the same loop until stopAnimation;
    // static viewing only draws when something marked the scene dirty.

    startAnimation(tick) {
        this._animTick = tick;
        this._lastTime = null;
    }

    stopAnimation() {
        this._animTick = null;
        this._needsRender = true;
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

        this.orbitTool = orbit;

        // ShortcutManager listens on document; without stopPropagation the
        // same arrow press also pans the hidden 2D renderer in EasyTrace.
        this._orbitKeyHandler = (e) => {
            if (orbit.onKeyDown(e)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        this.container?.addEventListener('keydown', this._orbitKeyHandler);

        this.controls = {
            target: orbit.target,
            update: () => orbit.syncFromCamera(),
            dispose: () => {
                this.container?.removeEventListener('keydown', this._orbitKeyHandler);
            }
        };
        return true;
    }

    debug(message, data = null) {
        if (!window.CAMConfig.defaults.debug.enabled) return;
        if (data !== null) console.log(`[Renderer3D] ${message}`, data);
        else console.log(`[Renderer3D] ${message}`);
    }
}

window.Renderer3D = Renderer3D;