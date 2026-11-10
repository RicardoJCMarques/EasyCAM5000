/*!
 * @file        renderer3d/renderer3d-stock.js
 * @description Stock box + heightmap surface mesh. The Heightmap grid
 *              (geometry-utils-heightmap.js) maps 1:1 onto an indexed
 *              BufferGeometry: one vertex per cell, two triangles per
 *              quad. Large grids are stride-downsampled to a vertex
 *              budget - the preview doesn't need slicing resolution.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import * as THREE from 'three/webgpu';

export class StockLayer3D {
  constructor(core) {
    this.core = core;
    this.group = new THREE.Group();
    this.group.name = 'stock';
    core.contentGroup.add(this.group);
    this.stockMesh = null;
    this.triangleMesh = null;
    this.rotaryBlank = null;
    this.rotaryEnvelope = null;
  }

  /**
   * Translucent stock box with edges. Top face at box.topZ, bottom at
   * topZ - thickness; box.matrix places it in the machine frame.
   * @param {{width, depth, thickness, topZ, centerX, centerY, matrix}} box
   */
  setStock(box) {
    this.removeStock();
    const { width: w, depth: d, thickness: t, topZ } = box;
    if (!(w > 0 && d > 0 && t > 0)) return;
    const geo = new THREE.BoxGeometry(w, d, t);
    geo.translate(box.centerX, box.centerY, topZ - t / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: this.core.options.stockColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.12,
      depthWrite: false
    });
    this.stockMesh = new THREE.Mesh(geo, mat);
    this.stockMesh.renderOrder = 10;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({
      color: this.core.options.stockColor,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      depthTest: true
    }));
    edges.renderOrder = 11;
    this.stockMesh.add(edges);
    const m = box.matrix;
    this.stockMesh.matrixAutoUpdate = false;
    this.stockMesh.matrix.set(m.a, m.c, 0, m.e, m.b, m.d, 0, m.f, 0, 0, 1, 0, 0, 0, 0, 1);
    this.stockMesh.updateMatrixWorld(true);
    this.group.add(this.stockMesh);
  }

  /**
   * Rotary envelope: the cylinder a mesh sweeps about the axis - rings at both ends of
   * its axial extent and lines along it at the swept radius. Display only.
   * @param {{axis: 'x'|'y', axialMin, axialMax, radius}} o
   */
  setRotaryEnvelope(o) {
    this.removeRotaryEnvelope();
    if (!(o.radius > 0) || !(o.axialMax > o.axialMin)) return;
    const segments = 64, rails = 8;
    const at = (a, th) => {
      const u = o.radius * Math.cos(th), v = o.radius * Math.sin(th);
      return o.axis === 'y' ? [u, a, v] : [a, u, v];
    };
    const points = [];
    for (const a of [o.axialMin, o.axialMax]) {
      for (let i = 0; i < segments; i++) {
        points.push(...at(a, 2 * Math.PI * i / segments), ...at(a, 2 * Math.PI * (i + 1) / segments));
      }
    }
    for (let i = 0; i < rails; i++) {
      const th = 2 * Math.PI * i / rails;
      points.push(...at(o.axialMin, th), ...at(o.axialMax, th));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.rotaryEnvelope = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: this.core.options.gridCenterColor }));
    this.group.add(this.rotaryEnvelope);
  }

  removeRotaryEnvelope() {
    if (!this.rotaryEnvelope) return;
    this.rotaryEnvelope.geometry.dispose();
    this.rotaryEnvelope.material.dispose();
    this.group.remove(this.rotaryEnvelope);
    this.rotaryEnvelope = null;
  }

  /**
   * Raw triangle-soup mesh (STL relief/rotary models).
   * ZERO-COPY AND NON-DESTRUCTIVE. The BufferAttribute wraps the
   * operation's Float32Array directly; computeVertexNormals() ADDS a
   * normal attribute and the placement is the OBJECT's position, so
   * vertex data is never written. geometry.dispose() frees GPU buffers,
   * not the source array. Keep it that way: this same array is the field
   * pipeline's slicing input, and any in-place transform here would
   * silently corrupt every subsequent generation.
   * @param {Float32Array} triangles
   * @param {Object} [o]
   * @param {number} [o.offsetX=0] machine-space placement
   * @param {number} [o.offsetY=0]
   * @param {number} [o.offsetZ=0] e.g. stockTopZ - bounds3D.maxZ pins
   *   the model top to the stock surface
   * @param {string} [o.nodeId]
   */
  setTriangleMesh(triangles, o = {}) {
    this.removeTriangleMesh();
    if (!triangles || triangles.length < 9) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(triangles, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: this.core.options.surfaceColor,
      side: THREE.DoubleSide,
      flatShading: true
    });
    this.triangleMesh = new THREE.Mesh(geo, mat);
    this.triangleMesh.position.set(o.offsetX || 0, o.offsetY || 0, o.offsetZ || 0);
    if (o.nodeId) this.triangleMesh.userData.nodeId = o.nodeId;
    this.group.add(this.triangleMesh);
  }

  /**
   * Indexed 3+1 blank: a translucent N-gon prism on the axis line.
   * CylinderGeometry with radialSegments = faceCount IS the prism - no
   * new geometry path needed, which is why the "only draws a cylinder"
   * note in refresh3D was never actually a limitation.
   * @param {{clearRadius, length, axis:'x'|'y', faces, startAngleDeg,
   *          center:{x,y,z}}} o - clearRadius is the CIRCUMradius
   *        (indexedClearRadius), i.e. corner-to-axis, not the apothem.
   */
  setIndexedBlank(o) {
    this.removeRotaryBlank();
    if (!(o.clearRadius > 0) || !(o.length > 0)) return;
    const sides = Math.max(3, o.faces | 0);
    const geo = new THREE.CylinderGeometry(o.clearRadius, o.clearRadius, o.length, sides, 1, false);
    // CylinderGeometry's first vertex sits at +X; rotate so a FACE
    // (not a corner) is centred on the first index angle.
    geo.rotateY(Math.PI / sides + (o.startAngleDeg || 0) * Math.PI / 180);
    this.mountBlank(geo, o);
  }

  /**
   * Rotary blank: translucent cylinder on the axis line. Coordinates
   * are machine-frame; caller derives them from rotary metadata.
   * @param {{refRadius, length, axis:'x'|'y', center:{x,y,z}}} o
   */
  setRotaryBlank(o) {
    this.removeRotaryBlank();
    if (!(o.refRadius > 0) || !(o.length > 0)) return;
    this.mountBlank(new THREE.CylinderGeometry(o.refRadius, o.refRadius, o.length, 48, 1, false), o);
  }

  // CylinderGeometry's axis is local Y; o.axis 'x' turns it onto machine X.
  mountBlank(geo, o) {
    if (o.axis === 'x') geo.rotateZ(Math.PI / 2);
    const color = this.core.options.stockColor;
    this.rotaryBlank = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: 0.12, depthWrite: false
    }));
    this.rotaryBlank.renderOrder = 10;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.5, depthWrite: false, depthTest: true
    }));
    edges.renderOrder = 11;
    this.rotaryBlank.add(edges);
    this.rotaryBlank.position.set(o.center.x, o.center.y, o.center.z);
    this.group.add(this.rotaryBlank);
  }

  removeRotaryBlank() {
    if (!this.rotaryBlank) return;
    this.rotaryBlank.traverse(c => {
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    });
    this.group.remove(this.rotaryBlank);
    this.rotaryBlank = null;
  }

  removeTriangleMesh() {
    if (!this.triangleMesh) return;
    this.triangleMesh.geometry.dispose();
    this.triangleMesh.material.dispose();
    this.group.remove(this.triangleMesh);
    this.triangleMesh = null;
  }

  removeStock() {
    if (!this.stockMesh) return;
    this.stockMesh.traverse(c => {
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    });
    this.group.remove(this.stockMesh);
    this.stockMesh = null;
  }
}