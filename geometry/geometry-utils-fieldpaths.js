/*!
 * @file        geometry/geometry-utils-fieldpaths.js
 * @description Shared raster engine over compensated scalar fields —
 *              Stages 3-5 extracted from geometry-utils-relief.js and
 *              generalized to the FieldView contract (geometry-utils-
 *              field.js) so the flat relief and rotary generators are
 *              both thin glue over one engine:
 *
 *                layers()           - constant-stepdown level sequence
 *                                     (Z levels for relief, radii for
 *                                     rotary — same descending math)
 *                rasterRoughLayer() - clamped surface-follow scanlines
 *                                     with span trimming
 *                rasterFinish()     - serpentine raster; continuous,
 *                                     skip-floor, or split-lines modes
 *                spiralFinish()     - continuous helix (wrapped views):
 *                                     one chain, one plunge, no stepover
 *                                     witness lines
 *                simplify3D()       - 3D Douglas-Peucker
 *                toPrimitive()      - Polyline3DPrimitive / PathPrimitive
 *                                     emission (is3DContour contract)
 *
 *              Value conventions: larger value = closer to the stock
 *              surface, layers DESCEND numerically (relief cut-Z is
 *              negative-down; rotary radii shrink inward — identical
 *              ordering). view.mapZ converts value → emitted Z and must
 *              be affine increasing (max() runs in value space).
 *
 *              No DOM, guarded CAMConfig access - Web Worker loadable.
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

    // Value-space "removes material" threshold (mm for both Z and R)
    const VALUE_EPS = 1e-4;

    const FieldPaths = {

        // REVIEW - this looks lost and useless?
        VALUE_EPS,

        // ════════════════════════════════════════════════════════════
        // Level sequence — descending from startVal (exclusive) to
        // endVal (inclusive, always emitted exactly).
        // Relief: layers(-startDepth, -(startDepth+reliefDepth), stepdown)
        // Rotary: layers(refRadius, floorRadius, stepdown)
        // ════════════════════════════════════════════════════════════
        layers(startVal, endVal, step) {
            const s = Math.abs(step) || 1.5;
            if (!(endVal < startVal - VALUE_EPS)) return [endVal];
            const out = [];
            let v = startVal;
            while (v - s > endVal + VALUE_EPS) {
                v -= s;
                out.push(v);
            }
            out.push(endVal);
            return out;
        },

        /**
         * Throttled per-line progress for the emission stage. The pipeline
         * threads onProgress into every raster; without a tick the 'emit'
         * band is never visited and the bar sits at the top of the
         * upsample band for the whole raster.
         */
        _lineTicker(onProgress, from, to, label) {
            if (!onProgress || !(to > from)) return () => {};
            const span = to - from;
            const every = span / 64;
            let next = from;
            return (pos) => {
                if (pos < next) return;
                next = pos + every;
                onProgress({ frac: (pos - from) / span, label, stage: 'emit' });
            };
        },

        // ════════════════════════════════════════════════════════════
        // Roughing — one layer of scanlines. Target per sample is
        // max(surface, layerVal): clamped surface-follow, which roughs
        // AND semi-finishes in one motion (no stair-steps on slopes).
        //
        // Span trimming: a sample belongs to this layer only if material
        // remains after the PREVIOUS layer (surface < prevVal - ε).
        // Contiguous qualifying samples form independent chains.
        //
        // Axis semantics (matches the relief generator):
        //   'x' - lines are ROWS, samples run along columns
        //   'y' - lines are COLUMNS, samples run along rows
        // On a wrapped view with axis 'y', samples traverse the periodic
        // dimension: chains that touch the θ seam are merged across it,
        // and a chain covering the full circumference closes into a ring.
        //
        // Uncovered cells (view.covered) never qualify — roughing stays
        // inside the model/setup footprint. This is the multi-setup
        // (indexed 3+1) ownership hook.
        //
        // Returns raw chains — the caller simplifies (same contract as
        // the original rasterRoughLayer).
        // ════════════════════════════════════════════════════════════
        rasterRoughLayer(view, o) {
            const axis = o.axis === 'y' ? 'y' : 'x';
            const alongX = axis === 'x';
            const lineCount = alongX ? view.rows : view.cols;
            const sampleCount = alongX ? view.cols : view.rows;
            const lineCell = alongX ? view.cellRow : view.cellCol;
            const stepCells = Math.max(1, Math.round((o.stepover || lineCell) / lineCell));

            const wrappedSamples = view.wrapRows && !alongX;
            const stock = o.stock ?? 0;
            const minSegLen = o.minSegLen ?? 0;
            const skipFloor = o.skipFloor === true;
            const floorVal = o.floorVal ?? null;
            const layerVal = o.layerVal;
            const prevVal = o.prevVal;

            const li0 = o.lineStart ?? 0;
            const li1 = o.lineEnd ?? (lineCount - 1);
            const tick = this._lineTicker(o.onProgress, li0, li1, 'Emitting roughing');
            const chains = [];
            let flip = false;

            for (let li = li0; li <= li1; li += stepCells) {
                tick(li);
                // Raw spans first (with sample bookkeeping); the seam
                // merge must run before the min-length filter so two
                // sub-threshold halves of one seam-crossing span survive.
                const spans = [];
                let span = null;

                const flush = () => {
                    if (span && span.points.length >= 2) spans.push(span);
                    span = null;
                };

                for (let s = 0; s < sampleCount; s++) {
                    const si = (flip && !wrappedSamples) ? (sampleCount - 1 - s) : s;
                    const ic = alongX ? si : li;
                    const ir = alongX ? li : si;

                    if (!view.covered(ic, ir)) { flush(); continue; }

                    const compVal = view.get(ic, ir);
                    // skipFloor: floor-flat cells drop the finishing
                    // allowance and get cut to the EXACT floor (see the
                    // relief handler's skipFloor rationale).
                    const atFloor = skipFloor && floorVal !== null &&
                        compVal <= floorVal + VALUE_EPS;
                    const surface = compVal + (atFloor ? 0 : stock);

                    if (surface < prevVal - VALUE_EPS) {
                        const v = Math.max(surface, layerVal);
                        if (!span) span = { start: si, end: si, points: [] };
                        span.end = si;
                        span.points.push({
                            x: view.colCoord(ic),
                            y: view.rowCoord(ir),
                            z: view.mapZ(v)
                        });
                    } else {
                        flush();
                    }
                }
                flush();

                // Seam handling on wrapped sample axes.
                //
                // Developed y is the UNWOUND arc: y=0 and y=circumference are
                // the same physical point but differ by a full turn of A.
                // Splicing back to y=0 reads as a 360° REVERSE revolution at
                // depth once the θ→A stage runs.
                if (wrappedSamples && spans.length > 0) {
                    const wrapSpan = view.rowCoord(sampleCount) - view.rowCoord(0);
                    const first = spans[0];
                    const last = spans[spans.length - 1];
                    if (spans.length >= 2 && first.start === 0 && last.end === sampleCount - 1) {
                        // Material continues across the seam: last + first is one
                        // contiguous span, with the wrapped half advanced one turn.
                        last.points = last.points.concat(
                            first.points.map(p => ({ x: p.x, y: p.y + wrapSpan, z: p.z })));
                        last.end = first.end;
                        spans.shift();
                    } else if (spans.length === 1 &&
                               first.start === 0 && first.end === sampleCount - 1) {
                        // Full-circumference span → closed ring, closed FORWARD.
                        const p0 = first.points[0];
                        first.points.push({ x: p0.x, y: p0.y + wrapSpan, z: p0.z });
                    }
                }

                for (const sp of spans) {
                    if (sp.points.length >= 2 &&
                        this.chainLength(sp.points) >= minSegLen) {
                        chains.push(sp.points);
                    }
                }

                if (!wrappedSamples) flip = !flip; // serpentine line order
            }
            return chains;
        },

        // ════════════════════════════════════════════════════════════
        // Finishing — serpentine raster over the compensated surface.
        //
        // Modes (mutually exclusive, in precedence order):
        //   splitLines  - every raster line is its own chain; NO
        //                 connectors. The 3D macro links chains with
        //                 feed-height hops (allow3DHop). REQUIRED for
        //                 rotary along-axis finishing, where an
        //                 in-surface connector would sweep a full
        //                 circumference at depth.
        //   skipFloor   - floor-flat spans (end-milled exactly by the
        //                 roughing final layer) are skipped; one chain
        //                 per remaining span, with one floor edge sample
        //                 kept at each end to blend onto the flat.
        //   (default)   - one continuous chain; row→row connectors are
        //                 cut along the compensated surface (legitimate
        //                 in-material moves): single plunge + retract.
        //                 Assumes a fully covered field — with a partial
        //                 mask use splitLines or skipFloor.
        //
        // Wrapped sample axes ('around' passes): serpentine flip is
        // disabled, each line closes into a ring, and connectors run at
        // sample 0. (skipFloor seam merge is NOT implemented — spans
        // touching the seam stay split; harmless, they're separate
        // chains anyway.)
        // ════════════════════════════════════════════════════════════
        rasterFinish(view, o) {
            const axis = o.axis === 'y' ? 'y' : 'x';
            const alongX = axis === 'x';
            const lineCount = alongX ? view.rows : view.cols;
            const sampleCount = alongX ? view.cols : view.rows;
            const lineCell = alongX ? view.cellRow : view.cellCol;
            const stepCells = Math.max(1, Math.round((o.stepover || lineCell) / lineCell));

            const wrappedSamples = view.wrapRows && !alongX;
            const simplifyTol = o.simplifyTolerance ?? 0;
            const skipFloor = o.skipFloor === true && !o.splitLines;
            const li0 = o.lineStart ?? 0;
            const li1 = o.lineEnd ?? (lineCount - 1);
            const floorVal = o.floorVal ?? null;
            const tick = this._lineTicker(o.onProgress, li0, li1, 'Emitting finishing');

            const pointAt = (si, li) => {
                const ic = alongX ? si : li;
                const ir = alongX ? li : si;
                return {
                    x: view.colCoord(ic),
                    y: view.rowCoord(ir),
                    z: view.mapZ(view.get(ic, ir))
                };
            };
            const coveredAt = (si, li) =>
                view.covered(alongX ? si : li, alongX ? li : si);

            // splitLines: per-line chains, no connectors
            if (o.splitLines === true) {
                const chains = [];
                let flip = false;
                for (let li = li0; li <= li1; li += stepCells) {
                    tick(li);
                    let line = [];
                    const flushLine = () => {
                        if (line.length >= 2) {
                            chains.push(simplifyTol > 0
                                ? this.simplify3D(line, simplifyTol) : line);
                        }
                        line = [];
                    };
                    for (let s = 0; s < sampleCount; s++) {
                        const si = (flip && !wrappedSamples) ? (sampleCount - 1 - s) : s;
                        if (!coveredAt(si, li)) { flushLine(); continue; }
                        line.push(pointAt(si, li));
                    }
                    if (wrappedSamples && line.length >= 2 &&
                        line.length === sampleCount) {
                        const p0 = line[0];
                        // Forward closure
                        line.push({ x: p0.x,
                                    y: p0.y + (view.rowCoord(sampleCount) - view.rowCoord(0)),
                                    z: p0.z });
                    }
                    flushLine();
                    if (!wrappedSamples) flip = !flip;
                }
                return chains;
            }

            // skipFloor: floor-flat spans skipped, chains per span
            if (skipFloor && floorVal !== null) {
                const chains = [];
                let flip = false;
                for (let li = li0; li <= li1; li += stepCells) {
                    tick(li);
                    let span = null;
                    let lastFloorPt = null;
                    const flushSpan = (edgePt) => {
                        if (span && span.length >= 2) {
                            if (edgePt) span.push(edgePt);
                            chains.push(simplifyTol > 0
                                ? this.simplify3D(span, simplifyTol) : span);
                        }
                        span = null;
                    };
                    for (let s = 0; s < sampleCount; s++) {
                        const si = (flip && !wrappedSamples) ? (sampleCount - 1 - s) : s;
                        if (!coveredAt(si, li)) { flushSpan(null); lastFloorPt = null; continue; }
                        const pt = pointAt(si, li);
                        const val = view.get(alongX ? si : li, alongX ? li : si);
                        if (val <= floorVal + VALUE_EPS) {
                            flushSpan(pt);       // trailing edge sample onto the flat
                            lastFloorPt = pt;
                        } else {
                            if (!span) {
                                span = [];
                                if (lastFloorPt) span.push(lastFloorPt); // leading edge
                            }
                            span.push(pt);
                        }
                    }
                    flushSpan(null);
                    lastFloorPt = null;
                    if (!wrappedSamples) flip = !flip;
                }
                return chains;
            }

            // Continuous serpentine: one chain, in-surface connectors
            //
            // Wrapped views: each ring advances A by one full turn and the
            // next ring continues from there (y accumulates, never resets).
            // Resetting to y=0 per ring would command a 360° reverse sweep
            // at depth. Accumulated A is the documented contract —
            // convertDevelopedToRotary never wraps it.
            const out = [];
            let flip = false;
            let prevLine = -1;
            const wrapSpan = wrappedSamples
                ? view.rowCoord(sampleCount) - view.rowCoord(0) : 0;
            let turns = 0;

            for (let li = li0; li <= li1; li += stepCells) {
                tick(li);
                const yOff = turns * wrapSpan;

                if (prevLine >= 0) {
                    // Connector: walk intermediate lines at the fixed end
                    // sample, cutting along the compensated surface.
                    const fixedSample = (wrappedSamples || !flip) ? 0 : sampleCount - 1;
                    for (let c = prevLine + 1; c <= li; c++) {
                        const p = pointAt(fixedSample, c);
                        out.push(wrappedSamples ? { x: p.x, y: p.y + yOff, z: p.z } : p);
                    }
                }

                const line = [];
                for (let s = 0; s < sampleCount; s++) {
                    const si = (flip && !wrappedSamples) ? (sampleCount - 1 - s) : s;
                    const p = pointAt(si, li);
                    line.push(wrappedSamples ? { x: p.x, y: p.y + yOff, z: p.z } : p);
                }
                if (wrappedSamples) {
                    const p0 = line[0];
                    // Close the ring FORWARD: +one turn, not back to the seam.
                    line.push({ x: p0.x, y: p0.y + wrapSpan, z: p0.z });
                    turns++;
                }
                const simplified = simplifyTol > 0
                    ? this.simplify3D(line, simplifyTol) : line;

                const start = (prevLine >= 0) ? 1 : 0;
                for (let i = start; i < simplified.length; i++) out.push(simplified[i]);

                prevLine = li;
                if (!wrappedSamples) flip = !flip;
            }
            return out.length >= 2 ? [out] : [];
        },

        // ════════════════════════════════════════════════════════════
        // Spiral finishing — wrapped views only. One continuous helix:
        // θ advances one angular cell per step, the column advances
        // stepover per revolution. Emitted y is the UNWOUND developed
        // arc (rowCoord extrapolated past rows — affine contract), so
        // A-axis continuity survives all the way to the machine pass.
        //
        // capRings adds one full closed revolution at the first and last
        // columns (the bare spiral leaves a helical ridge at each end
        // face). The spiral samples the field bilinearly, mask-blind:
        // masked cylindrical fields should be filled to stock radius
        // before finishing.
        // ════════════════════════════════════════════════════════════
        spiralFinish(view, o) {
            if (!view.wrapRows) {
                throw new Error('FieldPaths.spiralFinish requires a wrapped (cylindrical) view');
            }
            const stepover = o.stepover;
            if (!(stepover > 0)) {
                throw new Error('FieldPaths.spiralFinish requires stepover > 0');
            }
            const rows = view.rows, cols = view.cols;
            const c0 = o.colStart ?? 0;
            const c1 = o.colEnd ?? (cols - 1);
            const colsPerStep = (stepover / view.cellCol) / rows;
            const simplifyTol = o.simplifyTolerance ?? 0;
            const capRings = o.capRings === true;

            const points = [];
            let kk = 0; // unwound angular step counter (y continuity)

            const emit = (fc) => {
                const val = view.sampleIndex(fc, kk % rows);
                points.push({
                    x: view.colCoord(fc),
                    y: view.rowCoord(kk),
                    z: view.mapZ(val)
                });
            };

            // One closed revolution at a fixed column, closed FORWARD (+one
            // turn of A, never spliced back to the seam).
            const ring = (fc) => {
                for (let j = 0; j < rows; j++) { emit(fc); kk++; }
                emit(fc);
            };

            // Ring stops the helix passes through, in travel order.
            // capColStart/capColEnd let a caller put closing revolutions at
            // the MODEL EDGE rather than the window edge: with a 'lip' end
            // the window runs a full tool diameter past the part, so a ring
            // out there rides the lip flat while the model's own base edge
            // — the line you part the job on — was left with the helix
            // crossing it at the spiral angle.
            const stops = [];
            const addStop = (v) => {
                if (v == null) return;
                const w = Math.min(Math.max(v, c0), c1);
                if (!stops.some(s => Math.abs(s - w) < 1e-9)) stops.push(w);
            };
            if (capRings) { addStop(c0); addStop(c1); }
            addStop(o.capColStart);
            addStop(o.capColEnd);
            stops.sort((a, b) => a - b);

            const tick = this._lineTicker(o.onProgress, c0, c1, 'Emitting spiral');

            const helixTo = (target, from) => {
                if (!(target > from + 1e-9)) return from;
                const steps = Math.ceil((target - from) / colsPerStep);
                for (let k = 1; k <= steps; k++) {
                    const fc = Math.min(from + k * colsPerStep, target);
                    emit(fc);
                    tick(fc);
                    kk++;
                }
                return target;
            };

            let cur = c0;
            emit(cur); kk++;                 // seed the chain
            for (const s of stops) {
                cur = helixTo(s, cur);
                ring(cur);
            }
            cur = helixTo(c1, cur);

            const chain = simplifyTol > 0 ? this.simplify3D(points, simplifyTol) : points;
            return chain.length >= 2 ? [chain] : [];
        },

        // ════════════════════════════════════════════════════════════
        // 3D Douglas-Peucker (point-to-segment distance in XYZ).
        // ════════════════════════════════════════════════════════════
        // REVIEW - Five independent polyline simplifiers ship in this repo:
        // GeometryUtils.simplifyDouglasPeucker, VCarveGenerator.simplifyRDP/rdpOpen,
        // FieldPaths.simplify3D, ToolpathOptimizer.simplifyCollinearPoints and
        // GerberParser.simplifyRDP. Consolidation is blocked on the worker boundary
        // (vcarve and fieldpaths cannot reach GeometryUtils). Fix all five together.
        simplify3D(points, tolerance) {
            if (points.length <= 2) return points;
            const keep = new Uint8Array(points.length);
            keep[0] = 1;
            keep[points.length - 1] = 1;

            // Iterative stack — scanlines can be long
            const stack = [[0, points.length - 1]];
            while (stack.length) {
                const [a, b] = stack.pop();
                if (b - a < 2) continue;

                const pa = points[a], pb = points[b];
                const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
                const segLen2 = dx * dx + dy * dy + dz * dz;

                let maxDist2 = -1, maxIdx = -1;
                for (let i = a + 1; i < b; i++) {
                    const p = points[i];
                    let d2;
                    if (segLen2 < 1e-18) {
                        const ex = p.x - pa.x, ey = p.y - pa.y, ez = p.z - pa.z;
                        d2 = ex * ex + ey * ey + ez * ez;
                    } else {
                        let t = ((p.x - pa.x) * dx + (p.y - pa.y) * dy + (p.z - pa.z) * dz) / segLen2;
                        if (t < 0) t = 0; else if (t > 1) t = 1;
                        const ex = p.x - (pa.x + t * dx);
                        const ey = p.y - (pa.y + t * dy);
                        const ez = p.z - (pa.z + t * dz);
                        d2 = ex * ex + ey * ey + ez * ez;
                    }
                    if (d2 > maxDist2) { maxDist2 = d2; maxIdx = i; }
                }

                if (maxDist2 > tolerance * tolerance) {
                    keep[maxIdx] = 1;
                    stack.push([a, maxIdx], [maxIdx, b]);
                }
            }

            const out = [];
            for (let i = 0; i < points.length; i++) {
                if (keep[i]) out.push(points[i]);
            }
            return out;
        },

        // ════════════════════════════════════════════════════════════
        // Output — is3DContour contract shared with the V-Carve and
        // relief generators. The caller supplies operation-specific
        // properties (role, isRelief/isRotary, machiningPhase — the phase
        // key Toolpath3DTranslator ranks by).
        // ════════════════════════════════════════════════════════════
        toPrimitive(points, properties = {}) {
            const props = {
                is3DContour: true,
                stroke: true,
                fill: false,
                strokeWidth: 0,
                ...properties
            };
            // Packed 3D primitive when available (12 B/point vs object
            // points); PathPrimitive contour fallback otherwise so the
            // engine stays loadable standalone in tests/workers.
            if (typeof ROOT.Polyline3DPrimitive !== 'undefined') {
                return ROOT.Polyline3DPrimitive.fromPoints(points, props);
            }
            const contour = {
                points, closed: false, isHole: false,
                nestingLevel: 0, parentId: null,
                arcSegments: [], curveIds: []
            };
            return (typeof ROOT.PathPrimitive !== 'undefined')
                ? new ROOT.PathPrimitive([contour], props)
                : { type: 'path', contours: [contour], properties: props };
        },

        // XY-only, matching the original relief implementation exactly so
        // the rebase regression-gates byte-identical. Switching to 3D
        // length changes minSegLen filtering on steep slivers — do it
        // deliberately, later, if ever.
        chainLength(points) {
            let l = 0;
            for (let i = 1; i < points.length; i++) {
                l += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
            }
            return l;
        },

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[FieldPaths] ${message}`, data)
                 : console.log(`[FieldPaths] ${message}`);
        }
    };

    ROOT.FieldPaths = FieldPaths;
})();