/*!
 * @file        renderer3d/renderer3d-orientation.js
 * @description Corner orientation cue for the 3D view: a cube in the Cartesian frame, a
 *              cylinder along the machine rotary axis in the radial one, with the X/Y/Z axes
 *              through it. Display only - it takes no input.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';

const SIZE = 96; // CSS px, square
const MARGIN = 10; // CSS px from the viewport's edges
const SPAN = 1.6; // half-extent of the cue's orthographic view
const AXIS_LENGTH = 1.2;
const Y_UP = new THREE.Vector3(0, 1, 0);
const AXES = [
  { key: 'x', dir: new THREE.Vector3(1, 0, 0) },
  { key: 'y', dir: new THREE.Vector3(0, 1, 0) },
  { key: 'z', dir: new THREE.Vector3(0, 0, 1) }
];

/** Axis colours, shared with the transform cue. */
export const AXIS_COLOR_KEYS = { x: 'axisXColor', y: 'axisYColor', z: 'axisZColor' };

export class OrientationCue3D {
  constructor(core) {
    this.core = core;
    this.scene = new THREE.Scene();
    // No lookAt: DEFAULT_UP is +Z in this app, and a Z-up lookAt along Z is degenerate.
    // The camera keeps its identity rotation (looking down -Z); the root turns instead.
    this.camera = new THREE.OrthographicCamera(-SPAN, SPAN, SPAN, -SPAN, 0.1, 10);
    this.camera.position.set(0, 0, 5);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.axis = null;
    this.viewport = new THREE.Vector4();
    this.build();
  }

  /**
   * @param {?string} axis - machine rotary axis ('x' | 'y') for the cylinder, or null for
   *   the Cartesian cube
   */
  setAxis(axis) {
    const next = axis === 'x' || axis === 'y' ? axis : null;
    if (next === this.axis) return;
    this.axis = next;
    this.build();
  }

  /** (Re)creates the body and the axes from the current axis and theme colours. */
  build() {
    for (const child of [...this.root.children]) {
      child.traverse((c) => {
        c.geometry?.dispose?.();
        c.material?.dispose?.();
      });
      this.root.remove(child);
    }
    const options = this.core.options;
    const rotary = this.axis !== null;
    const body = rotary
      ? new THREE.CylinderGeometry(0.45, 0.45, 1.3, 32)
      : new THREE.BoxGeometry(0.9, 0.9, 0.9);
    // CylinderGeometry's axis is local Y; 'x' turns it onto X.
    if (this.axis === 'x') body.rotateZ(Math.PI / 2);
    const shell = new THREE.Mesh(body, new THREE.MeshBasicMaterial({
      color: options.surfaceColor,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    }));
    // 15° keeps the cylinder's side seams out of the outline: only its caps draw.
    shell.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(body, 15),
      new THREE.LineBasicMaterial({ color: options.gridCenterColor })
    ));
    shell.renderOrder = 1;
    this.root.add(shell);
    for (const { key, dir } of AXES) {
      // The rotary axis runs through the cylinder; the others start at the centre.
      const through = rotary && key === this.axis;
      const material = new THREE.MeshBasicMaterial({ color: options[AXIS_COLOR_KEYS[key]] });
      const shaft = new THREE.CylinderGeometry(0.035, 0.035, through ? 2 * AXIS_LENGTH : AXIS_LENGTH, 8);
      if (!through) shaft.translate(0, AXIS_LENGTH / 2, 0);
      const tip = new THREE.ConeGeometry(0.1, 0.28, 16);
      tip.translate(0, AXIS_LENGTH + 0.14, 0);
      const arrow = new THREE.Group();
      arrow.add(new THREE.Mesh(shaft, material), new THREE.Mesh(tip, material));
      arrow.quaternion.setFromUnitVectors(Y_UP, dir);
      this.root.add(arrow);
      if (through) {
        // A ring around the rotary axis: the part turns about this one.
        const ring = new THREE.TorusGeometry(0.62, 0.03, 8, 48);
        if (key === 'x') ring.rotateY(Math.PI / 2);
        else ring.rotateX(Math.PI / 2);
        this.root.add(new THREE.Mesh(ring, material));
      }
    }
  }

  /**
   * Draws the cue in its corner (rendering.preview3D orientationCueRight / Top) over the
   * frame just rendered, turned by the camera's rotation alone: orbit and fit turn it, pan
   * and dolly do not. Aiming it at the origin instead makes every pan turn it. Viewport
   * values are CSS px from the top-left in three's WebGPU renderer, on both backends.
   */
  render(renderer, width, height) {
    if (width < SIZE + 2 * MARGIN || height < SIZE + 2 * MARGIN) return;
    this.root.quaternion.copy(this.core.camera.quaternion).invert();
    const cfg = window.CAMConfig.defaults.rendering.preview3D;
    const x = cfg.orientationCueRight ? width - SIZE - MARGIN : MARGIN;
    const y = cfg.orientationCueTop ? MARGIN : height - SIZE - MARGIN;
    renderer.getViewport(this.viewport);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setViewport(x, y, SIZE, SIZE);
    renderer.render(this.scene, this.camera);
    renderer.setViewport(this.viewport);
    renderer.autoClear = autoClear;
  }
}