/*!
 * @file        renderer3d/renderer3d-workholding.js
 * @description Chuck and tailstock glyphs at the part's ends in the 3D view's radial scene
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 * 
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';

const Y_UP = new THREE.Vector3(0, 1, 0);
const JAW_ANGLES = [0, 120, 240].map((deg) => (deg * Math.PI) / 180);

/**
 * A simplified chuck at the end of the part the chuck holds and, between centers, a
 * tailstock centre at the other end, so the radial scene shows which end is which.
 * Display only: sized from the part's radius, placed where the caller says the cut ends.
 * Inside contentGroup, so Fit frames it; outside the pick layers, so a click passes it.
 */
export class WorkholdingLayer3D {
  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.name = 'workholding';
    core.contentGroup.add(this.group);
  }

  /**
   * @param {{axis: 'x'|'y', low: number, high: number, radius: number, chuckSide: 'low'|'high', tail: boolean}} o -
   *   where the holder faces stand along the machine axis `axis`, and the part's radius about it
   */
  set(o) {
    this.clear();
    // A non-finite end would leave fitToContent a non-finite box, and it refuses those.
    if (!Number.isFinite(o.low) || !Number.isFinite(o.high)) return;
    const r = o.radius > 1 ? o.radius : 1;
    const color = this.core.options.workholdingColor;
    const fill = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false });
    const edge = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false });
    const solid = (geo) => {
      const mesh = new THREE.Mesh(geo, fill);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 15), edge));
      return mesh;
    };
    // Each glyph is built along local +Y, pointing away from the part from the face it stands at.
    const mount = (glyph, at, outward) => {
      const away = o.axis === 'y' ? new THREE.Vector3(0, outward, 0) : new THREE.Vector3(outward, 0, 0);
      glyph.quaternion.setFromUnitVectors(Y_UP, away);
      glyph.position.set(o.axis === 'y' ? 0 : at, o.axis === 'y' ? at : 0, 0);
      this.group.add(glyph);
    };
    const chuckHigh = o.chuckSide === 'high';
    // Chuck: three jaws at the blank's radius, a thin body behind them.
    const jaw = 0.3 * r;
    const chuck = new THREE.Group();
    const body = new THREE.CylinderGeometry(1.3 * r, 1.3 * r, 0.4 * r, 32);
    body.translate(0, jaw + 0.2 * r, 0);
    chuck.add(solid(body));
    for (const angle of JAW_ANGLES) {
      const block = new THREE.BoxGeometry(0.22 * r, jaw, 0.3 * r);
      block.translate(0, jaw / 2, 1.15 * r);
      block.rotateY(angle);
      chuck.add(solid(block));
    }
    mount(chuck, chuckHigh ? o.high : o.low, chuckHigh ? 1 : -1);
    if (!o.tail) return;
    // Tailstock: a centre on the axis at the other face, its quill behind it.
    const tail = new THREE.Group();
    const centre = new THREE.ConeGeometry(0.2 * r, 0.35 * r, 32);
    centre.rotateX(Math.PI); // tip toward the part
    centre.translate(0, 0.175 * r, 0);
    const quill = new THREE.CylinderGeometry(0.25 * r, 0.25 * r, 0.8 * r, 32);
    quill.translate(0, 0.75 * r, 0);
    tail.add(solid(centre), solid(quill));
    mount(tail, chuckHigh ? o.low : o.high, chuckHigh ? -1 : 1);
  }

  clear() {
    const materials = new Set();
    for (const child of [...this.group.children]) {
      child.traverse((c) => {
        c.geometry?.dispose();
        if (c.material) materials.add(c.material);
      });
      this.group.remove(child);
    }
    for (const material of materials) material.dispose();
  }
}
