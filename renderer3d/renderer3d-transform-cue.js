/*!
 * @file        renderer3d/renderer3d-transform-cue.js
 * @description Cue for a focused Shape Transform field, drawn on the mesh in view: an arrow
 *              out of it along the axis a positive offset moves it, or around it about the
 *              axis a positive rotation turns it
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 * 
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';
import { AXIS_COLOR_KEYS } from './renderer3d-orientation.js';

const Z_UP = new THREE.Vector3(0, 0, 1);
const ARC = 1.5 * Math.PI; // a rotation arrow's sweep
const LETTER_PX = 64; // axis-letter texture, square

/**
 * While a Shape Transform field has focus: an arrow showing what a positive value does to the
 * model - straight out of it along the axis an offset moves it on, or around it about the
 * axis a rotation turns it about - that axis dashed through the model, and its letter, in the
 * axis colour. Drawn over the model.
 */
export class TransformCue3D {
  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.name = 'transform-cue'; // outside contentGroup: fitToContent never frames it
    core.scene.add(this.group);
    this.cue = null;
  }

  /**
   * @param {?{kind: 'offset'|'rotation', axis: 'x'|'y'|'z', origin: number[], dir: number[],
   *  span: number, extent?: number, radius?: number}} cue - machine frame. `dir` is the unit
   *  vector a positive value moves the model along, or turns it about by the right-hand rule;
   *  `span` is the model's largest extent; an offset's `extent` is how far the model reaches
   *  along `dir`, a rotation's `radius` clears the model around the axis. null clears the cue.
   */
  show(cue) {
    this.clear();
    if (!cue) return;
    this.cue = cue;
    const color = this.core.options[AXIS_COLOR_KEYS[cue.axis]];
    const { span } = cue;
    const tube = span * 0.012;
    const head = span * 0.08;
    const offset = cue.kind === 'offset';
    // The dashed axis runs past the arrow: out of the model for a move, around it for a turn.
    const half = offset ? cue.extent + 0.6 * span : Math.max(1.5 * span, 2 * cue.radius);
    const look = { color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false };
    const material = new THREE.MeshBasicMaterial(look);
    const part = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(2.5 * tube, head, 16), material);
    if (offset) {
      // Straight out of the model along +dir, its head at the end of the dashed axis.
      const from = cue.extent + 0.1 * span;
      const to = half - head;
      const shaft = new THREE.CylinderGeometry(tube, tube, to - from, 8);
      shaft.rotateX(Math.PI / 2); // the cylinder's +Y onto +Z
      shaft.translate(0, 0, (from + to) / 2);
      tip.position.set(0, 0, to + head / 2);
      tip.rotation.x = Math.PI / 2; // the cone's +Y onto +Z
      part.add(new THREE.Mesh(shaft, material), tip);
    } else {
      // Counter-clockwise seen from +dir, its head at the end of the sweep.
      tip.position.set(cue.radius * Math.cos(ARC), cue.radius * Math.sin(ARC), 0);
      tip.rotation.z = ARC; // the cone's +Y onto the arc's tangent
      part.add(new THREE.Mesh(new THREE.TorusGeometry(cue.radius, tube, 8, 64, ARC), material), tip);
    }
    // Dashed, so the axis reads as a guide through the model rather than as geometry.
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, -half), new THREE.Vector3(0, 0, half)]),
      new THREE.LineDashedMaterial({ ...look, opacity: 0.7, dashSize: span * 0.05, gapSize: span * 0.03 }),
    );
    line.computeLineDistances();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = LETTER_PX;
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${LETTER_PX * 0.75}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(cue.axis.toUpperCase(), LETTER_PX / 2, LETTER_PX / 2);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const letter = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false }));
    letter.position.set(0, 0, half + head);
    letter.scale.setScalar(span * 0.12);
    part.add(line, letter);
    part.position.fromArray(cue.origin);
    part.quaternion.setFromUnitVectors(Z_UP, new THREE.Vector3().fromArray(cue.dir));
    part.traverse((o) => {o.renderOrder = 20;});
    this.group.add(part);
  }

  /** Builds the cue again, in the current theme colours. */
  refresh() {
    if (this.cue) this.show(this.cue);
  }

  clear() {
    const materials = new Set();
    for (const child of [...this.group.children]) {
      child.traverse((o) => {
        // Every Sprite shares one geometry: disposing it destroys the buffers the next sprite draws from.
        if (!o.isSprite) o.geometry?.dispose();
        if (o.material) materials.add(o.material);
      });
      this.group.remove(child);
    }
    for (const material of materials) {
      material.map?.dispose();
      material.dispose();
    }
    this.cue = null;
  }
}
