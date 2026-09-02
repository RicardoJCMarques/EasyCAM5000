/*!
 * @file        geometry/geometry-clipper-wrapper.js
 * @description Clipper2 WASM library intermediary
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
    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const debugState = D.debug;

    class ClipperWrapper {
        constructor(options = {}) {
            this.options = { ...options };
            this.scale = options.clipper2scale; // REVIEW - If this is applied before clipper and reverted after, scaling can be larger?

            this.clipper2 = null;
            this.initialized = false;
            this.supportsZ = false;

            // Metadata packing configuration - 64-bit Packing: CurveID (24-bit) + SegmentIndex (31-bit) + Clockwise Winding (1-bit) + Unused (8-bit)
            this.metadataPacking = {
                curveIdBits: 24n,      // Bits 0-23: supports 16.7 million curves
                segmentIndexBits: 31n,  // Bits 24-54: supports 2.1 billion points per curve (reduced by 1)
                clockwiseBit: 1n,       // Bit 55: clockwise flag
                reservedBits: 8n        // Bits 56-63: reserved for future use
            };

            // Pre-calculate bit masks for efficiency
            this.bitMasks = {
                curveId: (1n << this.metadataPacking.curveIdBits) - 1n,
                segmentIndex: (1n << this.metadataPacking.segmentIndexBits) - 1n,
                clockwise: 1n,
                reserved: (1n << this.metadataPacking.reservedBits) - 1n
            };
        }

        async initialize() {
            if (this.initialized) return true;

            try {
                if (typeof Clipper2ZFactory === 'undefined') {
                    throw new Error('Clipper2ZFactory not found');
                }

                const clipper2Core = await Clipper2ZFactory();
                if (!clipper2Core) {
                    throw new Error('Failed to load Clipper2 core module');
                }

                this.clipper2 = clipper2Core;

                // Verify required APIs
                const requiredAPIs = [
                    'Paths64', 'Path64', 'Point64', 'Clipper64',
                    'ClipType', 'FillRule', 'PolyPath64', 'AreaPath64'
                ];

                for (const api of requiredAPIs) {
                    if (!this.clipper2[api]) {
                        throw new Error(`Required Clipper2 API '${api}' not found`);
                    }
                }

                // Check Z coordinate support
                const testPoint = new this.clipper2.Point64(BigInt(0), BigInt(0), BigInt(1));
                this.supportsZ = testPoint.z !== undefined;
                testPoint.delete();

                this.initialized = true;
                this.debug(`Clipper2 initialized (Z support: ${this.supportsZ})`);
                this.debug(`Metadata packing: ${24}-bit curveId, ${31}-bit segmentIndex, 1-bit clockwise, ${8}-bit reserved`);
                return true;

            } catch (error) {
                console.error('Failed to initialize Clipper2:', error);
                this.initialized = false;
                throw error;
            }
        }

        // Pack metadata into 64-bit Z coordinate
        // REVIEW - Metadata packing comments need improvement
        packMetadata(curveId, segmentIndex, clockwise = false, reserved = 0) {
            // Allow reserved-only packing (sourceId) on non-arc points, which have no curveId.
            // // REVIEW - this doesn't make sense? Metadata packing could also be, CurveID is necessary for arc-reconstruction but non arc points don't need it?
            if ((!curveId || curveId === 0) && (!reserved || reserved === 0)) return BigInt(0);

            const packedCurveId = BigInt(curveId || 0) & this.bitMasks.curveId;
            const packedSegmentIndex = BigInt(segmentIndex || 0) & this.bitMasks.segmentIndex;
            const packedClockwise = clockwise ? 1n : 0n;
            const packedReserved = BigInt(reserved || 0) & this.bitMasks.reserved;

            const z = packedCurveId |
                     (packedSegmentIndex << 24n) |
                     (packedClockwise << 55n) |
                     (packedReserved << 56n);

            return z;
        }

        /**
         * Pack a source-shape identity into a Z word for non-arc points.
         * Bits 24-55, deliberately overlapping packMetadata's segmentIndex
         * field: a point carries either a curveId (bits 0-23 non-zero) or a
         * sourceId, never both, and unpackMetadata dispatches on curveId > 0.
         * unpackSourceId is therefore only meaningful when curveId = 0.
         * Identity is carried for downstream toolpath grouping; it is not
         * arc metadata and does not participate in reconstruction.
         */
        // The current system may not need this but stayDown clusters probably need it in the future.
        // Same shapeID if far appart by the offset distance (not just point distance) should be stayDown compatible, it would allow enough precision for more stayDown moves when explicit points are diagonally distant.
        packSourceId(sourceId) {
            if (!sourceId) return BigInt(0);
            return (BigInt(sourceId) & 0xFFFFFFFFn) << 24n;
        }

        /**
         * Recover sourceId from a Z word. Only valid when curveId = 0.
         */
        unpackSourceId(z) {
            if (!z || z === 0n) return 0;
            return Number((BigInt(z) >> 24n) & 0xFFFFFFFFn);
        }

        // Unpack metadata from 64-bit Z coordinate
        unpackMetadata(z) {
            if (!z || z === 0n) {
                return { curveId: 0, segmentIndex: 0, clockwise: false, reserved: 0 };
            }

            const zBigInt = BigInt(z);

            const curveId = Number(zBigInt & this.bitMasks.curveId);
            const segmentIndex = Number((zBigInt >> 24n) & this.bitMasks.segmentIndex);
            const clockwise = Boolean((zBigInt >> 55n) & 1n);
            const reserved = Number((zBigInt >> 56n) & this.bitMasks.reserved);

            return { curveId, segmentIndex, clockwise, reserved };
        }

        // Union multiple paths into merged regions
        async union(paths, fillRule = 'nonzero') {
            await this.ensureInitialized();

            const { Paths64, ClipType, FillRule, Clipper64, PolyPath64 } = this.clipper2;
            const objects = [];

            try {
                const input = new Paths64();
                objects.push(input);

                // Convert JS paths to Clipper paths - process ALL contours
                paths.forEach(path => {
                    if (path.contours && path.contours.length > 0) {
                        path.contours.forEach(contour => {
                            const clipperPath = this.jsPathToClipper(contour.points, path.properties?.sourceId || 0);
                            if (clipperPath) {
                                input.push_back(clipperPath);
                                objects.push(clipperPath);
                            }
                        });
                    } else if (path.type !== 'path') {
                        const pPath = GeometryUtils.primitiveToPath(path);
                        if (pPath && pPath.contours) {
                            pPath.contours.forEach(contour => {
                                const clipperPath = this.jsPathToClipper(contour.points, path.properties?.sourceId || 0);
                                if (clipperPath) {
                                    input.push_back(clipperPath);
                                    objects.push(clipperPath);
                                }
                            });
                        }
                    }
                });

                const clipper = new Clipper64();
                const solution = new PolyPath64();
                objects.push(clipper, solution);

                clipper.AddSubject(input);

                const fr = fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero;
                const success = clipper.ExecutePoly(ClipType.Union, fr, solution);

                if (!success) {
                    this.debug('Union operation failed');
                    return [];
                }

                return this.polyTreeToJS(solution);

            } finally {
                this.cleanup(objects);
            }
        }

        // Difference operation (subtract clipPaths from subjectPaths)
        async difference(subjectPaths, clipPaths, fillRule = 'nonzero') {
            await this.ensureInitialized();

            const { Paths64, ClipType, FillRule, Clipper64, PolyPath64 } = this.clipper2;
            const objects = [];

            try {
                const subjects = new Paths64();
                const clips = new Paths64();
                objects.push(subjects, clips);

                // Winding is trusted from upstream - outer=CCW (+1), hole=CW (-1) in Y-up.
                const addAllContours = (pathsArray, clipperPathsObj) => {
                    pathsArray.forEach(path => {
                        if (path.contours && path.contours.length > 0) {
                            path.contours.forEach(contour => {
                                const clipperPath = this.jsPathToClipper(contour.points, path.properties?.sourceId || 0);
                                if (clipperPath) {
                                    clipperPathsObj.push_back(clipperPath);
                                    objects.push(clipperPath);
                                }
                            });
                        } else if (path.type !== 'path') {
                            const pPath = GeometryUtils.primitiveToPath(path);
                            if (pPath && pPath.contours) {
                                pPath.contours.forEach(contour => {
                                    const clipperPath = this.jsPathToClipper(contour.points, path.properties?.sourceId || 0);
                                    if (clipperPath) {
                                        clipperPathsObj.push_back(clipperPath);
                                        objects.push(clipperPath);
                                    }
                                });
                            }
                        }
                    });
                };

                addAllContours(subjectPaths, subjects);
                addAllContours(clipPaths, clips);

                const clipper = new Clipper64();
                const solution = new PolyPath64();
                objects.push(clipper, solution);

                if (subjects.size() > 0) clipper.AddSubject(subjects);
                if (clips.size() > 0) clipper.AddClip(clips);

                const fr = fillRule === 'evenodd' ? FillRule.EvenOdd : FillRule.NonZero;
                const success = clipper.ExecutePoly(ClipType.Difference, fr, solution);

                if (!success) {
                    this.debug('Difference operation failed');
                    return [];
                }

                return this.polyTreeToJS(solution);

            } finally {
                this.cleanup(objects);
            }
        }

        // Convert JS path to Clipper Path64 with metadata packing
        jsPathToClipper(points, contourSourceId = 0) {
            const { Path64, Point64 } = this.clipper2;

            if (!points || points.length < 3) return null;

            const path = new Path64();

            try {
                // WORKER BLOCKER - the curve registry is main-thread singleton state.
                // In a worker every curveId resolves to clockwise:false, the packed Z
                // word loses the winding, and arc reconstruction silently degrades to
                // polylines. Moving 2D off-thread means shipping a registry slice per
                // job and merging offset-derived registrations back. V-carve, relief
                // and rotary have no registry dependency, which is why they moved.
                const reg = ROOT.globalCurveRegistry;
                const windingCache = new Map();
                const getClockwiseForCurve = (curveId) => {
                    let cw = windingCache.get(curveId);
                    if (cw === undefined) {
                        const curve = reg ? reg.getCurve(curveId) : null;
                        cw = curve ? (curve.clockwise === true) : false;
                        windingCache.set(curveId, cw);
                    }
                    return cw;
                };

                // Winding is trusted from upstream (parser enforces outer=CCW, hole=CW in Y-up).
                for (let i = 0; i < points.length; i++) {
                    const p = points[i];

                    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                        console.error(
                            `[ClipperWrapper] NaN/Infinite coordinate at point ${i}/${points.length}: ` +
                            `(${p.x}, ${p.y}). Scale=${this.scale}. Skipping entire contour.`
                        );
                        if (path && typeof path.delete === 'function') path.delete();
                        return null;
                    }

                    const x = BigInt(Math.round(p.x * this.scale));
                    const y = BigInt(Math.round(p.y * this.scale));

                    let z = BigInt(0);
                    if (this.supportsZ) {
                        if (p.curveId !== undefined && p.curveId !== null && p.curveId > 0) {
                            const curveClockwise = getClockwiseForCurve(p.curveId);
                            z = this.packMetadata(p.curveId, p.segmentIndex || 0, curveClockwise, 0);
                        } else {
                            const sid = (p.sourceId > 0) ? p.sourceId : contourSourceId;
                            if (sid > 0) z = this.packSourceId(sid);
                        }
                    }

                    const point = new Point64(x, y, z);
                    path.push_back(point);
                    point.delete();
                }

                return path;

            } catch (error) {
                console.error('Error converting path to Clipper:', error);
                if (path && typeof path.delete === 'function') path.delete();
                return null;
            }
        }

        /**
         * Lean converter for the native linear offset path. No curve registry,
         * no Z word: Clipper2 creates its own vertices when offsetting, so
         * there is nothing for arc provenance to survive on. Callers that need
         * arcs must use GeometryOffsetter.offsetPathViaBoolean instead as this
         * bypasses all arc logic.
         */
        // REVIEW - Should this be in geometry-utils? Like all other pre-processor methods?
        pointsToPath64Plain(points) {
            const { Path64, Point64 } = this.clipper2;
            if (!points || points.length < 3) return null;

            const path = new Path64();
            const Z = BigInt(0);
            try {
                for (let i = 0; i < points.length; i++) {
                    const p = points[i];
                    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                        console.error(
                            `[ClipperWrapper] NaN/Infinite coordinate at point ${i}/${points.length}: ` +
                            `(${p.x}, ${p.y}). Scale=${this.scale}. Skipping entire contour.`
                        );
                        path.delete();
                        return null;
                    }
                    const point = new Point64(
                        BigInt(Math.round(p.x * this.scale)),
                        BigInt(Math.round(p.y * this.scale)),
                        Z
                    );
                    path.push_back(point);
                    point.delete();
                }
                return path;
            } catch (error) {
                console.error('Error converting path to Clipper:', error);
                if (path && typeof path.delete === 'function') path.delete();
                return null;
            }
        }

        /**
         * Native Clipper2 polygon offsetting.
         *
         * ONE call replaces the stroke-polygon union: the inflate offsetter
         * builds ~1 quad + join per segment and unions them, so its Clipper
         * input scales with point count (a single glyph contour measured 13,724
         * polygons and ~31s). This does the same work inside C++.
         *
         * Winding carries the semantics: a NEGATIVE delta shrinks positive-area
         * outers and grows negative-area holes in the same pass, so a nested
         * contour set needs no shell/hole split, no union and no difference.
         *
         * Arc metadata is NOT preserved and cannot be - the offsetter emits new
         * vertices. This is the method for 3D tool compensation (V-Carve floor
         * clamping, field/FEA-style offsets). The 2D pipeline keeps
         * GeometryOffsetter.offsetPathViaBoolean.
         *
         * @param {Array<Object>} primitives - closed contours, correctly wound
         * @param {number} delta - offset in model units (negative = inward)
         * @param {Object} [options]
         * @param {'round'|'miter'|'square'|'bevel'} [options.joinType='round']
         * @param {number} [options.miterLimit=2]
         * @param {number} [options.arcTolerance=0] - model units; 0 lets
         *        Clipper2 pick (~0.25·|delta|)
         * @returns {Promise<Array<Object>>} primitives with hole hierarchy
         */
        async offsetPaths(primitives, delta, options = {}) {
            await this.ensureInitialized();

            if (!primitives || primitives.length === 0) return [];

            const { Paths64, ClipType, FillRule, Clipper64, PolyPath64,
                    JoinType, EndType } = this.clipper2;
            const objects = [];

            try {
                const input = new Paths64();
                objects.push(input);

                for (const prim of primitives) {
                    const contours = (prim.contours && prim.contours.length)
                        ? prim.contours
                        : (GeometryUtils.primitiveToPath(prim)?.contours || []);
                    for (const contour of contours) {
                        const path = this.pointsToPath64Plain(contour.points);
                        if (path) {
                            input.push_back(path);
                            objects.push(path);
                        }
                    }
                }
                if (input.size() === 0) return [];

                const jt = {
                    round:  JoinType.Round,
                    miter:  JoinType.Miter,
                    square: JoinType.Square,
                    bevel:  JoinType.Bevel ?? JoinType.Square
                }[options.joinType || 'round'];

                const scaledDelta = delta * this.scale;
                const miterLimit = options.miterLimit ?? 2.0;
                const arcTolerance = (options.arcTolerance ?? 0) * this.scale;

                let offset;
                offset = this.clipper2.InflatePaths64(
                    input, scaledDelta, jt, EndType.Polygon,
                    miterLimit, arcTolerance);
                objects.push(offset);

                // The offsetter returns a FLAT path list. Run it through a
                // union to recover the outer/hole hierarchy so the result has
                // the same shape every other boolean here produces.
                const clipper = new Clipper64();
                const solution = new PolyPath64();
                objects.push(clipper, solution);

                clipper.AddSubject(offset);
                const success = clipper.ExecutePoly(
                    ClipType.Union, FillRule.NonZero, solution);
                if (!success) {
                    this.debug('Offset union failed');
                    return [];
                }

                return this.polyTreeToJS(solution);

            } catch (error) {
                console.error('Offset operation failed:', error);
                throw error;
            } finally {
                this.cleanup(objects);
            }
        }

        // Convert Clipper PolyTree to JS primitives with metadata unpacking
        polyTreeToJS(polyNode) {
            const primitives = [];

            // Process each root node (top-level polygon)
            for (let i = 0; i < polyNode.count(); i++) {
                const rootNode = polyNode.child(i);
                const rootPoly = rootNode.polygon();

                if (!rootPoly || rootPoly.size() < 3) continue;

                // Extract root points with metadata
                const rootPoints = [];
                const curveIds = new Set();

                for (let j = 0; j < rootPoly.size(); j++) {
                    const pt = rootPoly.get(j);
                    const point = {
                        x: Number(pt.x) / this.scale,
                        y: Number(pt.y) / this.scale
                    };

                    if (this.supportsZ && pt.z !== undefined) {
                        const z = BigInt(pt.z);
                        if (z > 0n) {
                            const metadata = this.unpackMetadata(z);
                            if (metadata.curveId > 0) {
                                point.curveId = metadata.curveId;
                                point.segmentIndex = metadata.segmentIndex;
                                point.clockwise = metadata.clockwise;
                                curveIds.add(metadata.curveId);
                            } else {
                                const sid = this.unpackSourceId(z);
                                if (sid > 0) point.sourceId = sid;
                            }
                        }
                    }

                    rootPoints.push(point);
                }

                // Build complete contour hierarchy recursively
                const contours = [];

                const extractContours = (node, level, parentIdx) => {
                    const poly = node.polygon();
                    if (!poly || poly.size() < 3) return;

                    const points = [];
                    const contourCurveIds = new Set();

                    for (let k = 0; k < poly.size(); k++) {
                        const pt = poly.get(k);
                        const point = {
                            x: Number(pt.x) / this.scale,
                            y: Number(pt.y) / this.scale
                        };

                        // Extract metadata for ALL contours
                        if (this.supportsZ && pt.z !== undefined) {
                            const z = BigInt(pt.z);
                            if (z > 0n) {
                                const metadata = this.unpackMetadata(z);
                                if (metadata.curveId > 0) {
                                    point.curveId = metadata.curveId;
                                    point.segmentIndex = metadata.segmentIndex;
                                    point.clockwise = metadata.clockwise;
                                    contourCurveIds.add(metadata.curveId);
                                } else {
                                    const sid = this.unpackSourceId(z);
                                    if (sid > 0) point.sourceId = sid;
                                }
                            }
                        }
                        points.push(point);
                    }

                    const isHole = level % 2 === 1;
                    const contourIdx = contours.length;

                    contours.push({
                        points: points,
                        nestingLevel: level,
                        isHole: isHole,
                        parentId: parentIdx,
                        arcSegments: [],
                        curveIds: Array.from(contourCurveIds) // Store curve IDs per contour
                    });

                    // Recursively process children
                    for (let c = 0; c < node.count(); c++) {
                        extractContours(node.child(c), level + 1, contourIdx);
                    }
                };

                // Root is level 0
                contours.push({
                    points: rootPoints,
                    nestingLevel: 0,
                    isHole: false,
                    parentId: null,
                    arcSegments: [],
                    curveIds: Array.from(curveIds)
                });

                // Extract all nested contours
                for (let j = 0; j < rootNode.count(); j++) {
                    extractContours(rootNode.child(j), 1, 0);
                }

                // Pass the fully formed contours array directly to the constructor.
                const primitive = new PathPrimitive(contours, {
                    isFused: true,
                    fill: true,
                    polarity: 'dark',
                    closed: true
                });

                if (curveIds.size > 0) {
                    primitive.curveIds = Array.from(curveIds);
                }
                primitives.push(primitive);
            }

            if (debugState.enabled && primitives.length > 0) {
                const totalContours = primitives.reduce((sum, p) => sum + (p.contours?.length || 0), 0);
                const maxDepth = Math.max(...primitives.flatMap(p => 
                    (p.contours || []).map(c => c.nestingLevel)
                ));
                console.log(`[ClipperWrapper] Extracted ${primitives.length} primitives, ${totalContours} contours, max depth: ${maxDepth}`);
            }
            return primitives;
        }

        // Ensure initialized
        async ensureInitialized() {
            if (!this.initialized) {
                await this.initialize();
            }
            if (!this.initialized) {
                throw new Error('Clipper2 not initialized');
            }
        }

        // Clean up WASM objects
        cleanup(objects) {
            objects.forEach(obj => {
                try {
                    if (obj && typeof obj.delete === 'function' && !obj.isDeleted()) {
                        obj.delete();
                    }
                } catch (e) {
                    // Ignore cleanup errors
                }
            });
        }

        // Get capabilities
        getCapabilities() {
            return {
                initialized: this.initialized,
                supportsZ: this.supportsZ,
                scale: this.scale,
                metadataPacking: {
                    curveIdBits: Number(this.metadataPacking.curveIdBits),
                    segmentIndexBits: Number(this.metadataPacking.segmentIndexBits),
                    clockwiseBit: Number(this.metadataPacking.clockwiseBit),
                    reservedBits: Number(this.metadataPacking.reservedBits),
                    maxCurveId: Number(this.bitMasks.curveId),
                    maxSegmentIndex: Number(this.bitMasks.segmentIndex)
                }
            };
        }

        // Debug logging
        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[ClipperWrapper] ${message}`, data)
                 : console.log(`[ClipperWrapper] ${message}`);
        }
    }

    ROOT.ClipperWrapper = ClipperWrapper;
})();