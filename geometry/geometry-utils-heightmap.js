/*!
 * @file        geometry/geometry-utils-heightmap.js
 * @description Heightmap grid container + on-demand mesh rasterization
 *              + HeightmapPrimitive wrapper for the operation pipeline.
 *
 *              Rebased on ScalarField (geometry-utils-field.js): storage,
 *              clamped get(), and bilinear index sampling are inherited.
 *              World-coordinate mapping (cellSize/origin) stays here.
 *              New: a coverage mask is built by fromMesh (1 = model
 *              covers the cell). Legacy behavior is preserved - uncovered
 *              cells are still filled to the covered minimum, so output
 *              is unchanged unless a consumer opts into the mask.
 *
 *              The mesh is sliced HERE, at generation time, not at parse
 *              time - resolution and orientation are operation parameters
 *              the user can change between generations.
 *
 *              Depends on: geometry-utils-field.js (ScalarField).
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const ROOT = (typeof self !== 'undefined') ? self : window;
    const debugState = ROOT.CAMConfig?.defaults?.debug || { enabled: false };

    // ════════════════════════════════════════════════════════════════
    // Heightmap - uniform grid of model heights (mm), normalized so
    // the lowest stored value is 0. (originX, originY) is the WORLD
    // coordinate of cell [0,0]'s center. Heights are model heights,
    // not cut depths - depth mapping is the ReliefGenerator's job.
    // ════════════════════════════════════════════════════════════════
    class Heightmap extends ROOT.ScalarField {
        constructor(cols, rows, cellSize, originX, originY, options = {}) {
            super(cols, rows, { wrapRows: false, withMask: options.withMask === true });
            this.cellSize = cellSize;
            this.originX = originX;
            this.originY = originY;
            this.maxH = 0;
            // Absolute Z of the pre-normalize floor (sliced-frame world Z of
            // the lowest stored height). normalize() rebases data to min=0;
            // zMin makes the absolute frame recoverable:
            //   absoluteZ(cell) = data[cell] + zMin
            // Consumer: ReliefGenerator's surfaceRefZ option (indexed 3+1
            // shared-Z contract). Serialized by field-worker's props list.
            this.zMin = 0;
            // Builder/generator diagnostics + user-facing warnings. Anything
            // meant to survive the worker round-trip MUST also be named in
            // field-worker.js's heightmap props list - cylmap always shipped
            // its meta, heightmap silently dropped it, so ReliefGenerator
            // had no warnings channel at all.
            this.meta = { uncovered: 0 };
            // XY footprint: 1 = some triangle projects here, INCLUDING the
            // XY-degenerate ones the rasterizer cannot assign a height to.
            // Distinct from `mask` (a formable top surface exists) - that
            // distinction is what lets the axial policy tell "model is here,
            // unformable" apart from "no model at all". Built by fromMesh;
            // serialized alongside data/mask by FieldSpace.
            this.hull = null;
        }

        cellX(ix) { return this.originX + ix * this.cellSize; }
        cellY(iy) { return this.originY + iy * this.cellSize; }

        worldBounds() {
            return {
                minX: this.originX - this.cellSize / 2,
                minY: this.originY - this.cellSize / 2,
                maxX: this.originX + (this.cols - 0.5) * this.cellSize,
                maxY: this.originY + (this.rows - 0.5) * this.cellSize
            };
        }

        /** Shift heights so min = 0 and refresh maxH. Records the
         *  pre-shift minimum as zMin (see constructor note). */
        normalize() {
            const { min, max } = this.stats(false);
            this.zMin = min;
            if (min !== 0) {
                const d = this.data;
                for (let i = 0; i < d.length; i++) d[i] -= min;
            }
            this.maxH = max - min;
            return this;
        }
    }

    // ════════════════════════════════════════════════════════════════
    // HeightmapBuilder - slices source data into a Heightmap on demand
    // ════════════════════════════════════════════════════════════════
    const HeightmapBuilder = {

        /**
         * Rasterizes a triangle soup (top surface, max-Z per cell) into
         * a heightmap. Triangle orientation/normals are irrelevant -
         * the highest surface above each cell wins, which is exactly
         * what a 3-axis tool can reach.
         *
         * @param {Float32Array} triangles - 9 floats per triangle
         * @param {Object} options
         * @param {number} [options.cellSize]   - mm per cell. If omitted,
         *        derived from gridMaxDim.
         * @param {number|{x:number,y:number}} [options.padding=0] - mm of
         *        empty margin added to the bounds. Scalar = both axes;
         *        {x,y} = per axis.
         * @param {number} [options.gridMaxDim=1024] - cap on the longer
         *        grid axis when cellSize is auto-derived.
         * @param {Object} [options.expandTo] - {minX,maxX,minY,maxY} in
         *        sliced-frame mm. Bounds are widened (never narrowed) to
         *        include this box, AFTER padding and AFTER cell-size
         *        derivation - so it adds cells without changing resolution.
         * @returns {Heightmap} with .mask populated (1 = model footprint).
         *        Uncovered cells are FILLED to the covered minimum
         *        before normalize() - legacy-identical data; the mask is
         *        additional information for opt-in consumers.
         */
        fromMesh(triangles, options = {}) {
            const t0 = performance.now();
            const gridMaxDim = options.gridMaxDim || 1024;
            const onProgress = options.onProgress || null;

            // [INDEXED] Optional per-vertex frame change, mirroring the
            // CylMapBuilder precedent: p' = orient·p - offset.
            //   options.orient  - row-major 3x3, PURE ROTATION (det +1).
            //   options.offset  - [x,y,z] subtracted AFTER rotation; the
            //                     indexed handler uses it to put the
            //                     rotary axis line at (y=0, z=0) so every
            //                     face shares one frame.
            // Implemented as a one-time transformed copy so the bounds
            // pass and the rasterizer below stay byte-identical when the
            // options are absent (regression-safe for plain relief), and
            // pay the matrix exactly once per vertex when present.
            if (options.orient || options.offset) {
                // p' = M·p - offset, over packed xyz. Branch-hoisted in
                // Transform3D; a one-time transformed copy keeps the bounds
                // pass and the rasterizer byte-identical when absent.
                triangles = ROOT.Transform3D.transformPoints(
                    triangles, options.orient || null, options.offset || null);
            }
            const triCount = (triangles.length / 9) | 0;
            const tickEvery = Math.max(1, triCount >> 6) * 9;

            // Bounds
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let i = 0; i < triangles.length; i += 3) {
                const x = triangles[i], y = triangles[i + 1];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }

            // Cell size derives from the MODEL extent, BEFORE padding.
            // Padding used to feed the auto denominator, so a long end
            // reach (a 60mm tailstock stub) silently halved the resolution
            // over the model itself. Padding is added afterwards as extra
            // cells at the same resolution.
            const extXraw = maxX - minX, extYraw = maxY - minY;
            if (!(extXraw > 0) || !(extYraw > 0)) {
                throw new Error('Mesh has degenerate XY extent');
            }
            const cellSize = Math.max(
                options.cellSize || Math.max(extXraw, extYraw) / gridMaxDim,
                0.005
            );

            // Padding shapes:
            //   number           - all four sides (plain relief; the
            //                      rollover band is isotropic)
            //   { x, y }         - per axis, both sides (legacy)
            //   { x0, x1, y0, y1 } - per SIDE. Indexed 3+1 reserves each
            //                      end's OWN reach, so a 'stop' chuck no
            //                      longer inherits the tail's overrun as
            //                      dead grid.
            const pad = options.padding || 0;
            const isObj = typeof pad === 'object';
            const padX0 = isObj ? (pad.x0 ?? pad.x ?? 0) : pad;
            const padX1 = isObj ? (pad.x1 ?? pad.x ?? 0) : pad;
            const padY0 = isObj ? (pad.y0 ?? pad.y ?? 0) : pad;
            const padY1 = isObj ? (pad.y1 ?? pad.y ?? 0) : pad;
            minX -= padX0; maxX += padX1;
            minY -= padY0; maxY += padY1;

            // [INDEXED] Minimum bounds, in SLICED-FRAME coordinates, applied
            // after padding. The grid must span the BLANK, not the model:
            // indexed roughing clears stock the model never touches, and the
            // rotation axis is at (y=0, z=0) by the offset contract, so a
            // symmetric span about 0 is exactly the facet band. Absent for
            // plain relief - the bounds stay model-derived, byte-identical.
            const ex = options.expandTo;
            if (ex) {
                if (Number.isFinite(ex.minX)) minX = Math.min(minX, ex.minX);
                if (Number.isFinite(ex.maxX)) maxX = Math.max(maxX, ex.maxX);
                if (Number.isFinite(ex.minY)) minY = Math.min(minY, ex.minY);
                if (Number.isFinite(ex.maxY)) maxY = Math.max(maxY, ex.maxY);
            }

            const extX = maxX - minX, extY = maxY - minY;
            const cols = Math.max(2, Math.ceil(extX / cellSize) + 1);
            const rows = Math.max(2, Math.ceil(extY / cellSize) + 1);

            const hm = new Heightmap(cols, rows, cellSize, minX, minY, { withMask: true });
            hm.data.fill(-Infinity);
            const data = hm.data;
            const hull = new Uint8Array(cols * rows);
            hm.hull = hull;

            // XY-degenerate triangles project to a segment, so they hold no
            // height - but they ARE the model. On an indexed face they are
            // the part's own end walls; dropping them entirely is what let
            // the severance over-cut treat an end wall as waste. Stamped at
            // half-cell steps: the footprint only has to be right to within
            // a cell, and this is exact enough without a supercover walk.
            const stampSegment = (x0, y0, x1, y1) => {
                const dx = x1 - x0, dy = y1 - y0;
                const steps = Math.ceil(Math.hypot(dx, dy) / (cellSize * 0.5));
                for (let s = 0; s <= steps; s++) {
                    const t = steps ? s / steps : 0;
                    const ix = Math.round((x0 + dx * t - minX) / cellSize);
                    const iy = Math.round((y0 + dy * t - minY) / cellSize);
                    if (ix < 0 || ix >= cols || iy < 0 || iy >= rows) continue;
                    hull[iy * cols + ix] = 1;
                }
            };

            // Rasterize each triangle: barycentric coverage of cell centers,
            // interpolated Z, keep max per cell.
            for (let t = 0; t < triangles.length; t += 9) {
                if (onProgress && t % tickEvery === 0) {
                    onProgress({ frac: t / triangles.length, label: 'Slicing mesh', stage: 'slice' });
                }

                const ax = triangles[t],     ay = triangles[t + 1], az = triangles[t + 2];
                const bx = triangles[t + 3], by = triangles[t + 4], bz = triangles[t + 5];
                const cx = triangles[t + 6], cy = triangles[t + 7], cz = triangles[t + 8];

                const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
                if (Math.abs(denom) < 1e-12) {
                    // Vertical wall: no height to interpolate, but its
                    // footprint is real.
                    stampSegment(ax, ay, bx, by);
                    stampSegment(bx, by, cx, cy);
                    stampSegment(cx, cy, ax, ay);
                    continue;
                }

                const txMin = Math.min(ax, bx, cx), txMax = Math.max(ax, bx, cx);
                const tyMin = Math.min(ay, by, cy), tyMax = Math.max(ay, by, cy);

                const ix0 = Math.max(0, Math.floor((txMin - minX) / cellSize));
                const ix1 = Math.min(cols - 1, Math.ceil((txMax - minX) / cellSize));
                const iy0 = Math.max(0, Math.floor((tyMin - minY) / cellSize));
                const iy1 = Math.min(rows - 1, Math.ceil((tyMax - minY) / cellSize));

                const invDenom = 1 / denom;
                const EPS = -1e-6; // slight tolerance so shared edges have no seam gaps

                for (let iy = iy0; iy <= iy1; iy++) {
                    const py = minY + iy * cellSize;
                    const rowBase = iy * cols;
                    for (let ix = ix0; ix <= ix1; ix++) {
                        const px = minX + ix * cellSize;
                        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) * invDenom;
                        if (w0 < EPS) continue;
                        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) * invDenom;
                        if (w1 < EPS) continue;
                        const w2 = 1 - w0 - w1;
                        if (w2 < EPS) continue;
                        const z = w0 * az + w1 * bz + w2 * cz;
                        const idx = rowBase + ix;
                        hull[idx] = 1;
                        if (z > data[idx]) data[idx] = z;
                    }
                }
            }

            // Coverage mask + legacy fill: uncovered cells (outside the
            // model footprint) → base plane, exactly as before.
            let coveredMin = Infinity;
            for (let i = 0; i < data.length; i++) {
                if (data[i] !== -Infinity && data[i] < coveredMin) coveredMin = data[i];
            }
            if (!Number.isFinite(coveredMin)) coveredMin = 0;
            let uncovered = 0;
            for (let i = 0; i < data.length; i++) {
                if (data[i] === -Infinity) {
                    data[i] = coveredMin;
                    uncovered++;
                } else {
                    hm.mask[i] = 1;
                }
            }

            // Pinhole count: uncovered cells with ≥5 of 8 neighbours covered
            // are INSIDE the silhouette - the point-in-triangle rasterizer
            // sampled cell centres and a steeply foreshortened triangle
            // projected to less than one cell. Harmless when the consumer
            // ignores the mask (plain relief interpolates across), fatal when
            // the mask IS the emission gate (indexed): the hole becomes a
            // missing toolpath on a steep face. A high count here means fix
            // the rasterization; a count near zero means the gaps are
            // tool-centre reach at the silhouette edge instead.
            let pinholes = 0;
            if (debugState.enabled) {
                for (let iy = 1; iy < rows - 1; iy++) {
                    for (let ix = 1; ix < cols - 1; ix++) {
                        const i = iy * cols + ix;
                        if (hm.mask[i]) continue;
                        let n = 0;
                        for (let dy = -1; dy <= 1; dy++) {
                            for (let dx = -1; dx <= 1; dx++) {
                                if (dx || dy) n += hm.mask[i + dy * cols + dx];
                            }
                        }
                        if (n >= 5) pinholes++;
                    }
                }
            }

            hm.meta.uncovered = uncovered;
            hm.normalize();

            if (debugState.enabled) {
                console.log(`[HeightmapBuilder] Mesh → ${cols}x${rows} grid @ ${cellSize.toFixed(3)}mm ` +
                    `(${uncovered} base cells, ${pinholes} interior pinhole(s), ` +
                    `maxH=${hm.maxH.toFixed(3)}mm) in ` +
                    `${(performance.now() - t0).toFixed(0)}ms`);
            }
            return hm;
        },

        /**
         * Builds a heightmap from a grayscale image (canvas ImageData).
         * White = high, black = low by convention (invert in the
         * ReliefGenerator options, not here).
         *
         * @param {ImageData} imageData
         * @param {Object} options
         * @param {number} options.widthMM      - physical width to map onto
         * @param {number} [options.heightScale=1] - model height (mm) at pure white
         * @param {boolean} [options.flipY=true]   - image rows are top-down;
         *        world Y is bottom-up
         * @returns {Heightmap}
         * REVIEW - Spin off?
        fromImageData(imageData, options = {}) {
            const { widthMM, heightScale = 1, flipY = true } = options;
            if (!(widthMM > 0)) throw new Error('fromImageData requires widthMM > 0');

            const cols = imageData.width;
            const rows = imageData.height;
            const cellSize = widthMM / cols;
            const hm = new Heightmap(cols, rows, cellSize, 0, 0);
            const px = imageData.data;

            for (let iy = 0; iy < rows; iy++) {
                const srcRow = flipY ? (rows - 1 - iy) : iy;
                for (let ix = 0; ix < cols; ix++) {
                    const p = (srcRow * cols + ix) * 4;
                    // Rec.601 luminance
                    const lum = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
                    hm.data[iy * cols + ix] = lum * heightScale;
                }
            }
            hm.normalize();

            if (debugState.enabled) {
                console.log(`[HeightmapBuilder] Image → ${cols}×${rows} grid @ ${cellSize.toFixed(3)}mm`);
            }
            return hm;
        }
         */
    };

    // ════════════════════════════════════════════════════════════════
    // HeightmapPrimitive - operation-pipeline wrapper. Gives the
    // heightmap a getBounds() so validateAndOptimizePrimitives,
    // operation.bounds, and zoom-fit work. Rendering support is a
    // separate (renderer) concern - until added, the renderer should
    // skip type 'heightmap' primitives gracefully.
    // ════════════════════════════════════════════════════════════════
    const Base = (typeof ROOT.RenderPrimitive !== 'undefined') ? ROOT.RenderPrimitive : class {
        constructor(type, properties = {}) {
            this.type = type;
            this.properties = properties;
            this.bounds = null;
            this.id = `prim_fld_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            this.geometricContext = { originalType: type, isAnalytic: false, metadata: {} };
        }
        getBounds() { if (!this.bounds) this.calculateBounds(); return this.bounds; }
        getCenter() {
            const b = this.getBounds();
            return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
        }
        canOffsetAnalytically() { return false; }
        getGeometricMetadata() { return this.geometricContext; }
    };

    class HeightmapPrimitive extends Base {
        constructor(heightmap, properties = {}) {
            super('heightmap', {
                role: 'relief_heightmap',
                fill: false,
                stroke: true,
                strokeWidth: 0,
                ...properties
            });
            this.heightmap = heightmap;
        }

        calculateBounds() {
            this.bounds = this.heightmap.worldBounds();
        }
    }

    ROOT.Heightmap = Heightmap;
    ROOT.HeightmapBuilder = HeightmapBuilder;
    ROOT.HeightmapPrimitive = HeightmapPrimitive;
    ROOT.FieldPrimitiveBase = Base; // shared by CylMapPrimitive
})();