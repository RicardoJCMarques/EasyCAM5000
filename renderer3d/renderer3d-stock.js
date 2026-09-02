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
        this.surfaceMesh = null;
        this.triangleMesh = null;
        this.rotaryBlank = null;
    }

    /**
     * Translucent stock box with edges. Top face at topZ (default Z0 -
     * the machine surface), bottom at topZ - thickness.
     * @param {{minX,minY,maxX,maxY,thickness,topZ?}} box
     */
    setStock(box) {
        this.removeStock();
        const w = box.width ?? (box.maxX - box.minX);
        const d = box.depth ?? (box.maxY - box.minY);
        const t = box.thickness || 10;
        const topZ = box.topZ ?? 0;
        if (!(w > 0) || !(d > 0)) return;

        const geo = new THREE.BoxGeometry(w, d, t);
        const cx = box.centerX ?? ((box.minX ?? 0) + w / 2);
        const cy = box.centerY ?? ((box.minY ?? 0) + d / 2);
        geo.translate(cx, cy, topZ - t / 2);

        const mat = new THREE.MeshStandardMaterial({
            color: this.core.options.stockColor,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.12,
            depthWrite: false
        });
        this.stockMesh = new THREE.Mesh(geo, mat);
        this.stockMesh.renderOrder = 10;

        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({
                color: this.core.options.stockColor,
                transparent: true,
                opacity: 0.5,
                depthWrite: false,
                depthTest: true
            })
        );
        edges.renderOrder = 11;
        this.stockMesh.add(edges);

        if (box.matrix) {
            const m = box.matrix;
            this.stockMesh.matrixAutoUpdate = false;
            this.stockMesh.matrix.set(
                m.a, m.c, 0, m.e,
                m.b, m.d, 0, m.f,
                0,   0,   1, 0,
                0,   0,   0, 1
            );
        }

        this.group.add(this.stockMesh);
    }

    /**
     * Heightmap → shaded terrain mesh at world coordinates.
     * @param {Heightmap} hm
     * @param {Object} [o]
     * @param {number} [o.zOffset=0]  Shift the surface (e.g. -reliefDepth
     *        -startDepth + zScale mapping to show the CARVED result
     *        instead of the raw model - wire during the parameter pass).
     * @param {number} [o.zScale=1]
     * @param {number} [o.maxVertices=600000] Downsample budget.
     * @param {number} [o.opacity=1]
     */
    setHeightmapSurface(hm, o = {}) {
        this.removeSurface();
        const zOffset = o.zOffset ?? 0;
        const zScale = o.zScale ?? 1;
        const maxVertices = o.maxVertices ?? 600000;

        // Stride-downsample to the vertex budget
        const stride = Math.max(1,
            Math.ceil(Math.sqrt((hm.cols * hm.rows) / maxVertices)));
        const cols = Math.max(2, Math.floor((hm.cols - 1) / stride) + 1);
        const rows = Math.max(2, Math.floor((hm.rows - 1) / stride) + 1);

        const positions = new Float32Array(cols * rows * 3);
        let p = 0;
        for (let iy = 0; iy < rows; iy++) {
            const sy = Math.min(hm.rows - 1, iy * stride);
            for (let ix = 0; ix < cols; ix++) {
                const sx = Math.min(hm.cols - 1, ix * stride);
                positions[p++] = hm.cellX(sx);
                positions[p++] = hm.cellY(sy);
                positions[p++] = hm.data[sy * hm.cols + sx] * zScale + zOffset;
            }
        }

        // Two triangles per quad, CCW seen from +Z
        const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
        let q = 0;
        for (let iy = 0; iy < rows - 1; iy++) {
            for (let ix = 0; ix < cols - 1; ix++) {
                const a = iy * cols + ix;
                const b = a + 1;
                const c = a + cols;
                const d = c + 1;
                index[q++] = a; index[q++] = b; index[q++] = d;
                index[q++] = a; index[q++] = d; index[q++] = c;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setIndex(new THREE.BufferAttribute(index, 1));
        geo.computeVertexNormals();

        const mat = new THREE.MeshStandardMaterial({
            color: this.core.options.surfaceColor,
            side: THREE.DoubleSide,
            transparent: (o.opacity ?? 1) < 1,
            opacity: o.opacity ?? 1
        });
        this.surfaceMesh = new THREE.Mesh(geo, mat);
        this.group.add(this.surfaceMesh);
    }

    /**
     * Raw triangle-soup mesh (STL relief/rotary models).
     *
     * ZERO-COPY AND NON-DESTRUCTIVE. The BufferAttribute wraps the
     * operation's Float32Array directly; computeVertexNormals() ADDS a
     * normal attribute and `orient` is applied as the OBJECT's rotation
     * matrix, so vertex data is never written. geometry.dispose() frees
     * GPU buffers, not the source array. Keep it that way: this same
     * array is the field pipeline's slicing input, and any in-place
     * transform here would silently corrupt every subsequent generation.
     * @param {Float32Array} triangles
     * @param {Object} [o]
     * @param {number} [o.offsetX=0] machine-space placement
     * @param {number} [o.offsetY=0]
     * @param {number} [o.offsetZ=0] e.g. stockTopZ - bounds3D.maxZ pins
     *        the model top to the stock surface
     * @param {Array}  [o.orient]   row-major 3x3 rotation applied as the
     *        mesh's object rotation. Pass the SAME matrix the slicer used
     *        - ShapeRotaryHandler.getVisualOrient(machineAxis, upright),
     *        republished as metadata.rotaryFrame.orient - so display and
     *        slicing frames can never disagree. One matrix set, zero
     *        per-vertex cost. // REVIEW - make sure there are no unnecessary aliases and fallbacks left.
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
        if (o.orient) {
            const r = o.orient;
            this.triangleMesh.setRotationFromMatrix(new THREE.Matrix4().set(
                r[0], r[1], r[2], 0,
                r[3], r[4], r[5], 0,
                r[6], r[7], r[8], 0,
                0,    0,    0,    1
            ));
        }
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
    // REVIEW - Virtually identical to setRotaryBlank
    setIndexedBlank(o) {
        this.removeRotaryBlank();
        if (!(o.clearRadius > 0) || !(o.length > 0)) return;

        const sides = Math.max(3, o.faces | 0);
        const geo = new THREE.CylinderGeometry(
            o.clearRadius, o.clearRadius, o.length, sides, 1, false);
        // CylinderGeometry's first vertex sits at +X; rotate so a FACE
        // (not a corner) is centred on the first index angle.
        geo.rotateY(Math.PI / sides + ((o.startAngleDeg || 0) * Math.PI / 180));
        if (o.axis === 'x') geo.rotateZ(Math.PI / 2);
        const mat = new THREE.MeshStandardMaterial({
            color: this.core.options.stockColor,
            transparent: true,
            opacity: 0.12,
            depthWrite: false
        });
        this.rotaryBlank = new THREE.Mesh(geo, mat);
        this.rotaryBlank.renderOrder = 10;
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({
                color: this.core.options.stockColor,
                transparent: !0,
                opacity: 0.5,
                depthWrite: false,
                depthTest: true
            })
        );
        edges.renderOrder = 11;
        this.rotaryBlank.add(edges);
        this.rotaryBlank.position.set(o.center.x, o.center.y, o.center.z);
        this.group.add(this.rotaryBlank);
    }

    /**
     * Rotary blank: translucent cylinder on the axis line. Coordinates
     * are machine-frame; caller derives them from rotary metadata.
     * @param {{refRadius, length, axis:'x'|'y',
     *          center:{x,y,z}}} o
     */
    // REVIEW - Virtually identical to setIndexedBlank
    setRotaryBlank(o) {
        this.removeRotaryBlank();
        if (!(o.refRadius > 0) || !(o.length > 0)) return;

        const geo = new THREE.CylinderGeometry(
            o.refRadius, o.refRadius, o.length, 48, 1, false);
        // CylinderGeometry's axis is local Y → rotate onto the machine axis
        if (o.axis === 'x') geo.rotateZ(Math.PI / 2);
        const mat = new THREE.MeshStandardMaterial({
            color: this.core.options.stockColor,
            transparent: true,
            opacity: 0.12,
            depthWrite: false
        });
        this.rotaryBlank = new THREE.Mesh(geo, mat);
        this.rotaryBlank.renderOrder = 10;
        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geo),
            new THREE.LineBasicMaterial({
                color: this.core.options.stockColor,
                transparent: !0,
                opacity: 0.5,
                depthWrite: false,
                depthTest: true
            })
        );
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

    removeSurface() {
        if (!this.surfaceMesh) return;
        this.surfaceMesh.geometry.dispose();
        this.surfaceMesh.material.dispose();
        this.group.remove(this.surfaceMesh);
        this.surfaceMesh = null;
    }

    clear() {
        this.removeStock();
        this.removeSurface();
        this.removeTriangleMesh();
        this.removeRotaryBlank(); 
    }
}