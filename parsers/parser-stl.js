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
    const ROOT = globalThis;

    class STLParser extends ParserCore {
        constructor(options = {}) {
            super(options);
            // STL is unitless. Assume mm; expose a scale for inch files.
            this.scale = options.scale || 1.0;
        }

        /**
         * Parses STL content into its solids: an ASCII file can hold several
         * `solid … endsolid` blocks, a binary file holds one.
         * @param {ArrayBuffer|Uint8Array|string} content
         *   Binary STL requires an ArrayBuffer (read the file with
         *   file.arrayBuffer(), NOT file.text()). ASCII STL
         *   works from either.
         * @returns {{
         *   success: boolean,
         *   format: 'stl',
         *   type: 'mesh',
         *   solids: Array<{name: ?string, triangles: Float32Array, bounds3D: {minX,minY,minZ,maxX,maxY,maxZ}}>,
         *   triangleCount: number,
         *   units: 'mm',
         *   errors: Array, warnings: Array
         * }}
         */
        parse(content) {
            this.errors = [];
            this.warnings = [];
            try {
                let solids;
                if (content instanceof ArrayBuffer || ArrayBuffer.isView(content)) {
                    const buffer =
                        content instanceof ArrayBuffer
                            ? content
                            : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
                    solids = this.isBinarySTL(buffer)
                        ? [{ name: null, triangles: this.parseBinary(buffer) }]
                        : this.parseASCIISolids(new TextDecoder().decode(buffer));
                } else if (typeof content === 'string') {
                    if (content.includes('facet') && content.includes('vertex')) {
                        solids = this.parseASCIISolids(content);
                    } else {
                        throw new Error(
                            'Content looks like binary STL but was read as text. ' +
                                'Read .stl files with file.arrayBuffer().',
                        );
                    }
                } else {
                    throw new Error('Unsupported STL content type');
                }
                solids = solids.filter((solid) => solid.triangles.length > 0);
                if (solids.length === 0) throw new Error('No triangles found in STL');
                for (const solid of solids) solid.bounds3D = this.computeBounds3D(solid.triangles);
                const triangleCount = solids.reduce((sum, solid) => sum + solid.triangles.length / 9, 0);
                this.stats.objectsCreated = triangleCount;
                this.debug(`STL parsed: ${triangleCount} triangles in ${solids.length} solid(s)`);
                return {
                    success: true,
                    format: 'stl',
                    type: 'mesh',
                    solids,
                    triangleCount,
                    units: 'mm',
                    errors: [],
                    warnings: this.warnings
                };
            } catch (error) {
                this.errors.push(error.message);
                return {
                    success: false,
                    format: 'stl',
                    solids: [],
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

        /**
         * One entry per `solid … endsolid` block; text with no such block is
         * read as a single unnamed solid.
         */
        parseASCIISolids(text) {
            const blocks = [];
            const re = /^[ \t]*solid\b([^\r\n]*)$([\s\S]*?)^[ \t]*endsolid\b/gm;
            let m;
            while ((m = re.exec(text)) !== null) blocks.push({ name: m[1].trim() || null, text: m[2] });
            if (blocks.length === 0) blocks.push({ name: null, text });
            return blocks.map((b) => ({ name: b.name, triangles: this.parseASCII(b.text) }));
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

    ROOT.STLParser = STLParser;
})();
