/*!
 * @file        parsers/parser-stl.js
 * @description STL mesh parser (binary + ASCII) for relief/2.5D operations.
 *              Output is a raw triangle soup - it is NOT ParserPlotter
 *              compatible and must bypass the plotter. The relief import
 *              path attaches the mesh to the operation directly; the
 *              ShapeReliefHandler rasterizes it into a heightmap on
 *              demand (HeightmapBuilder), so slicing always reflects the
 *              current operation parameters.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class STLParser extends ParserCore {
        constructor(options = {}) {
            super(options);
            // STL is unitless. Assume mm; expose a scale for inch files.
            this.scale = options.scale || 1.0;
        }

        /**
         * Parses STL content.
         * @param {ArrayBuffer|Uint8Array|string} content
         *        Binary STL requires an ArrayBuffer (read the file with
         *        readFileAsArrayBuffer, NOT readFileAsText). ASCII STL
         *        works from either.
         * @returns {{
         *   success: boolean,
         *   format: 'stl',
         *   type: 'mesh',
         *   triangles: Float32Array,   // 9 floats per triangle (x,y,z x3)
         *   triangleCount: number,
         *   bounds: {minX,minY,maxX,maxY},          // XY (for operation.bounds)
         *   bounds3D: {minX,minY,minZ,maxX,maxY,maxZ},
         *   units: 'mm',
         *   errors: Array, warnings: Array
         * }}
         */
        parse(content) {
            this.errors = [];
            this.warnings = [];

            try {
                let triangles;

                if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
                    const buffer = content instanceof ArrayBuffer
                        ? content
                        : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
                    triangles = this.isBinarySTL(buffer)
                        ? this.parseBinary(buffer)
                        : this.parseASCII(new TextDecoder().decode(buffer));
                } else if (typeof content === 'string') {
                    if (content.includes('facet') && content.includes('vertex')) {
                        triangles = this.parseASCII(content);
                    } else {
                        throw new Error(
                            'Content looks like binary STL but was read as text. ' +
                            'Read .stl files with readFileAsArrayBuffer().'
                        );
                    }
                } else {
                    throw new Error('Unsupported STL content type');
                }

                if (!triangles || triangles.length === 0) {
                    throw new Error('No triangles found in STL');
                }

                const bounds3D = this.computeBounds3D(triangles);
                this.stats.objectsCreated = triangles.length / 9;

                this.debug(`STL parsed: ${this.stats.objectsCreated} triangles, ` +
                    `Z range ${bounds3D.minZ.toFixed(3)}..${bounds3D.maxZ.toFixed(3)}mm`);

                return {
                    success: true,
                    format: 'stl',
                    type: 'mesh',
                    triangles,
                    triangleCount: triangles.length / 9,
                    bounds: {
                        minX: bounds3D.minX, minY: bounds3D.minY,
                        maxX: bounds3D.maxX, maxY: bounds3D.maxY
                    },
                    bounds3D,
                    units: 'mm',
                    errors: [],
                    warnings: this.warnings
                };
            } catch (error) {
                this.errors.push(error.message);
                return {
                    success: false,
                    format: 'stl',
                    triangles: null,
                    errors: this.errors,
                    warnings: this.warnings
                };
            }
        }

        /**
         * Binary detection: the size implied by the uint32 facet count must
         * match the buffer length. "solid" prefixes alone are unreliable -
         * some binary exporters write "solid" into the 80-byte header.
         */
        isBinarySTL(buffer) {
            if (buffer.byteLength < 84) return false;
            const view = new DataView(buffer);
            const count = view.getUint32(80, true);
            const expected = 84 + count * 50;
            if (buffer.byteLength === expected) return true;
            // Tolerate trailing junk from sloppy exporters
            if (buffer.byteLength > expected && buffer.byteLength - expected < 512) {
                this.warnings.push(`STL has ${buffer.byteLength - expected} trailing bytes (ignored)`);
                return true;
            }
            return false;
        }

        parseBinary(buffer) {
            const view = new DataView(buffer);
            const count = view.getUint32(80, true);
            const triangles = new Float32Array(count * 9);
            const s = this.scale;

            let offset = 84;
            for (let t = 0; t < count; t++) {
                offset += 12; // skip facet normal - recomputed if ever needed
                const base = t * 9;
                for (let v = 0; v < 9; v++) {
                    triangles[base + v] = view.getFloat32(offset, true) * s;
                    offset += 4;
                }
                offset += 2; // attribute byte count
                this.stats.coordinatesParsed += 9;
            }
            return triangles;
        }

        parseASCII(text) {
            const vertexRe = /vertex\s+([-+0-9eE.]+)\s+([-+0-9eE.]+)\s+([-+0-9eE.]+)/g;
            const values = [];
            const s = this.scale;
            let m;
            while ((m = vertexRe.exec(text)) !== null) {
                values.push(
                    parseFloat(m[1]) * s,
                    parseFloat(m[2]) * s,
                    parseFloat(m[3]) * s
                );
                this.stats.coordinatesParsed += 3;
            }
            if (values.length % 9 !== 0) {
                this.warnings.push(`ASCII STL vertex count not divisible by 3 - truncating partial facet`);
                values.length = values.length - (values.length % 9);
            }
            return new Float32Array(values);
        }

        computeBounds3D(triangles) {
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let i = 0; i < triangles.length; i += 3) {
                const x = triangles[i], y = triangles[i + 1], z = triangles[i + 2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            return { minX, minY, minZ, maxX, maxY, maxZ };
        }
    }

    window.STLParser = STLParser;
})();
