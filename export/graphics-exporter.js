/*!
 * @file        export/graphics-exporter.js
 * @description Graphics processor
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

    const C = ROOT.CAMConfig.constants;
    const D = ROOT.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class GraphicsExporter {
        constructor() {
            this.DECIMAL = 4;
            this.HAIRLINE_STROKE = .01; // mm - standard svg hairline
            this.MAX_CANVAS_DIM = 16000;
            this.MAX_CANVAS_PIXELS = 8192 * 8192; // 256 MB as RGBA
            this.profiles = new Map;
        }

        /**
         * The profile table, loaded once by the controller. A profile is to a
         * laser what a post-processor descriptor is to a mill: an id, a label,
         * a palette and its own settings. Holding the table here is why nothing
         * outside this file has to know that laser profiles exist.
         */
        setProfiles(json) {
            if (json?.profiles) {
            this.profiles = new Map(Object.entries(json.profiles).map(([id, p]) => [id, { id: id, ...p }]));
            }
        }

        getProfileInfo(id) {
            return this.profiles ? this.profiles.get(id) || null : null;
        }

        getAllProfileDescriptors() {
            return this.profiles ? [...this.profiles.values()] : [];
        }

        /**
         * Everything the renderers need, resolved once: the profile's own
         * table under the user's edits for that profile. A missing profile is
         * a wiring bug - falling back to a bare settings read produced a
         * plausible export with no palette and the wrong colours.
         */
        resolveOptions(settings) {
            const id = settings.laser.activeProfile;
            const profile = this.getProfileInfo(id);
            if (!profile) throw new Error(`Laser profile '${id}' is not registered`);
            return { ...profile, ...settings.laserSettings[profile.id] };
        }

        /**
         * Planned groups → files. Each group is { operations, format, filename }
         * from CamCore.planExportFiles, which decides grouping and names; this
         * owns the operation-to-layer mapping, and generate() below owns the
         * rendering.
         * `ctx` carries the session facts this class must not go looking for:
         *  laser        settings.laser
         *  profile      the resolved laser profile
         *  transforms   the workspace matrix set
         *  bounds       scene board bounds
         *  appName      for the comment block
         * A group that fails is reported and does not take its siblings down.
         * @returns {Promise<{files: Array<{blob: Blob, filename: string}>,
         *  failures: Array<{filename: string, reason: string}>}>}
         */
        async exportGroups(groups, ctx, overrides = {}) {
            const laser = ctx.laser;
            const profile = ctx.profile;
            // The profile answers for everything the target software dictates.
            // `??`, not `||`: the plain-vector route overrides reverseCutOrder
            // and colorPerPass to false, and those must beat a profile's true.
            const style = {
                svgGrouping: overrides.svgGrouping ?? profile.svgGrouping,
                reverseCutOrder: overrides.reverseCutOrder ?? profile.reverseCutOrder,
                heatManagement: overrides.heatManagement ?? profile.heatManagement,
                colorPerPass: overrides.colorPerPass ?? profile.colorPerPass,
                palette: overrides.palette ?? profile.palette,
                paletteLumping: overrides.paletteLumping ?? profile.paletteLumping,
                layerColors: overrides.layerColors ?? profile.layerColors,
            };
            const layerColors = style.layerColors;
            const baseOptions = {
                dpi: overrides.dpi || laser.exportDPI,
                padding: overrides.padding ?? laser.exportPadding,
                transforms: ctx.transforms,
                bounds: ctx.bounds,
                reverseCutOrder: style.reverseCutOrder,
                svgGrouping: style.svgGrouping,
                colorPerPass: style.colorPerPass,
                palette: style.palette,
                paletteLumping: style.paletteLumping,
                includeComments: overrides.includeComments,
            };
            const buildLayer = (op) => {
                if (!op.offsets || op.offsets.length === 0) return null;
                const passes = op.offsets.map((offset, idx) => ({
                    passIndex: idx + 1,
                    type: offset.type || 'offset',
                    primitives: offset.primitives || [],
                    metadata: {
                        ...(offset.metadata || {}),
                        offsetType: offset.offsetType || 'external',
                        thermalGroup: offset.metadata?.thermalGroup || 'shell',
                        pass: offset.pass || idx + 1,
                        distance: offset.distance,
                    },
                }));
                let layerName = op.type;
                if (op.type === 'stencil') {
                    const cleanName = op.file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
                    layerName = `Stencil_${cleanName}`;
                }
                return {
                    operationId: op.id,
                    operationType: op.type,
                    fileName: op.file.name,
                    baseColor: layerColors[op.type] || '#000000',
                    layerName,
                    strokeWidth: laser.spotSize,
                    passes,
                };
            };
            const files = [];
            const failures = [];
            for (const group of groups) {
                const layers = group.operations.map(buildLayer).filter(Boolean);
                if (layers.length === 0) {
                    failures.push({ filename: group.filename, reason: 'no generated geometry' });
                    continue;
                }
                const options = {
                    ...baseOptions,
                    format: group.format,
                    // PNG has no per-pass colour channel, so heat management has
                    // nothing to sequence against.
                    heatManagement: group.format === 'png' ? 'off' : style.heatManagement,
                };
                // REVIEW - these should come from the language file.
                if (overrides.includeComments) {
                    options.commentBlock = [
                        `${ctx.appName} SVG Export`,
                        `Date: ${new Date().toLocaleString()}`,
                        `Operations ${group.operations.length}:`,
                        ...group.operations.map((op) => `  - ${op.type}: ${op.file.name}`),
                    ];
                }
                try {
                    const result = await this.generate(layers, options);
                    if (result?.blob) {
                        files.push({ blob: result.blob, filename: group.filename });
                    } else {
                        failures.push({ filename: group.filename, reason: 'renderer returned no data' });
                    }
                } catch (error) {
                    console.error(`[GraphicsExporter] ${group.filename} failed:`, error);
                    failures.push({ filename: group.filename, reason: error.message });
                }
            }
            return { files, failures };
        }

        async generate(layers, options) {
            // Fuse colinear hatch segments across operation layers before export
            this.fuseColinearSegments(layers);

            // User-transform matrix (rotation, mirror, origin - no bounds shift or
            // Y-flip): the pipeline's own, so export cannot disagree with toolpaths.
            const userMat = options.transforms?.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

            // Apply userMat to all geometry to find the TRUE output bounds.
            // This prevents the white-PNG / clipped-SVG bug where rotated or mirrored geometry extends beyond the raw board bounds used for the viewBox.
            const trueBounds = this.computeTransformedBounds(layers, userMat);

            // Build full output matrix (userMat + bounds-shift + Y-flip) using true bounds
            const padding = options.padding || 0;
            const output = this.buildOutputMatrix(userMat, trueBounds, padding);

            // Package pre-computed values for the generators
            const renderCtx = {
                mat: output.mat,
                widthMm: output.widthMm,
                heightMm: output.heightMm,
                padding: padding,
                origin: options.transforms?.origin || { x: 0, y: 0 },
                heatManagement: options.heatManagement,
                reverseCutOrder: options.reverseCutOrder,
                svgGrouping: options.svgGrouping,
                colorPerPass: options.colorPerPass,
                palette: options.palette,
                paletteLumping: options.paletteLumping,
                includeComments: options.includeComments,
                commentBlock: options.commentBlock
            };

            if (options.format === 'png') {
                return this.generatePNG(layers, options, renderCtx);
            }
            return this.generateSVG(layers, renderCtx);
        }

        /**
         * Scans all geometry through the user-transform matrix to find the true bounding box of the output.
         */
        computeTransformedBounds(layers, userMat) {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            const expand = (x, y) => {
                const p = TransformMath.applyToPoint(userMat, { x, y });
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            };
            // The point of a circle furthest along output axis e sits at
            // center + r * normalize(L^T e), L being the matrix's linear part.
            const axisDirs = [[1, 0], [0, 1], [-1, 0], [0, -1]].map(([ex, ey]) => {
                const ux = userMat.a * ex + userMat.b * ey;
                const uy = userMat.c * ex + userMat.d * ey;
                const len = Math.hypot(ux, uy) || 1;
                return { x: ux / len, y: uy / len, angle: Math.atan2(uy, ux) };
            });
            for (const layer of layers) {
                for (const pass of layer.passes) {
                    if (!pass.primitives) continue;
                    for (const prim of pass.primitives) {
                        // Circles: expand by center ± radius (rotation/mirror preserve distances)
                        if (prim.type === 'circle' && prim.center && prim.radius) {
                            const r = prim.radius;
                            expand(prim.center.x - r, prim.center.y - r);
                            expand(prim.center.x + r, prim.center.y + r);
                            expand(prim.center.x - r, prim.center.y + r);
                            expand(prim.center.x + r, prim.center.y - r);
                        }
                        // Paths: expand by every vertex, then by the extremes each arc
                        // reaches between its endpoints (chord arcs store only those).
                        if (prim.contours) {
                            for (const c of prim.contours) {
                                if (!c.points) continue;
                                for (const pt of c.points) {
                                    expand(pt.x, pt.y);
                                }
                                for (const arc of this.buildArcMap(c, prim.arcSegments).values()) {
                                    for (const dir of axisDirs) {
                                        if (!GeometryPoints.arcPassesAngle(arc.startAngle, arc.endAngle, arc.clockwise, dir.angle)) continue;
                                        expand(arc.center.x + arc.radius * dir.x, arc.center.y + arc.radius * dir.y);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (!isFinite(minX)) {
                return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
            }
            return { minX, minY, maxX, maxY };
        }

        /**
         * Builds the final output matrix by composing: boundsShift (using TRUE post-transform bounds) → Y-flip on top of the pre-built user-transform matrix.
         */
        buildOutputMatrix(userMat, trueBounds, padding) {
            const widthMm = trueBounds.maxX - trueBounds.minX + padding * 2;
            const heightMm = trueBounds.maxY - trueBounds.minY + padding * 2;
            // Bounds shift using TRUE bounds → geometry min lands at (padding, padding)
            let m = TransformMath.multiply(
                TransformMath.translation(padding - trueBounds.minX, padding - trueBounds.minY),
                userMat,
            );
            // Y-flip: SVG/Canvas Y-down, CAM Y-up → y' = heightMm - y
            m = TransformMath.multiply({ a: 1, b: 0, c: 0, d: -1, e: 0, f: heightMm }, m);
            return { mat: m, widthMm, heightMm };
        }

        /**
         * Builds a lookup map from point index → arc segment for a contour.
         * Falls back to primitive-level arcSegments for single-contour paths.
         */
        buildArcMap(contour, primArcSegments) {
            const map = new Map();
            const arcs = (contour.arcSegments && contour.arcSegments.length > 0)
                ? contour.arcSegments
                : (primArcSegments || []);
            for (const arc of arcs) {
                if (arc.startIndex != null && arc.endIndex != null &&
                    arc.center && typeof arc.radius === 'number' && arc.radius > 0) {
                    map.set(arc.startIndex, arc);
                }
            }
            return map;
        }

        // ────────────────────────────────────────────────────────────
        // SVG Generation
        // ────────────────────────────────────────────────────────────

        async generateSVG(layers, renderCtx) {
            // Destructure origin from context package
            const { mat, widthMm, heightMm, svgGrouping, reverseCutOrder, origin } = renderCtx;
            const p = this.DECIMAL;
            const fmt = (n) => this.formatNumber(n, this.DECIMAL);

            const lines = [];
            lines.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);

            // Consider a comment structure similar to:
            // <!--
            // -->
            // with single top and bottom comment tag instead of looping through each line?
            if (renderCtx.includeComments && renderCtx.commentBlock && renderCtx.commentBlock.length > 0) {
                renderCtx.commentBlock.forEach(comment => {
                    this.debug("Writing comment:", comment);
                    const safeComment = String(comment).replace(/--/g, '=='); // '--' is illegal inside an XML/SVG comment; replace it.
                    lines.push(`<!-- ${safeComment} -->`);
                });
            }

            lines.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${widthMm.toFixed(p)}mm" height="${heightMm.toFixed(p)}mm" viewBox="0 0 ${widthMm.toFixed(p)} ${heightMm.toFixed(p)}" version="1.1">`);

            lines.push(`<style>path,circle,line{vector-effect:non-scaling-stroke;-inkscape-stroke:hairline}</style>`);

            // Adjust translation components to compensate for the inner path shifts
            const txOriginX = mat.a * origin.x + mat.c * origin.y;
            const txOriginY = mat.b * origin.x + mat.d * origin.y;
            const adjE = mat.e + txOriginX;
            const adjF = mat.f + txOriginY;

            const transformAttr = `transform="matrix(${mat.a}, ${mat.b}, ${mat.c}, ${mat.d}, ${this.formatNumber(adjE, p)}, ${this.formatNumber(adjF, p)})"`;

            lines.push(`<g id="EasyTrace_Export" ${transformAttr} stroke-linecap="round" stroke-linejoin="round" stroke-width="1px">`);

            const orderedLayers = reverseCutOrder ? layers.slice().reverse() : layers;
            const useGroups = svgGrouping !== 'none';
            const useLayers = svgGrouping === 'layer';

            // ════════════════════════════════════════════════════════════
            // COLOR GROUPING BRANCH (xTool Studio)
            // ════════════════════════════════════════════════════════════
            if (svgGrouping === 'color') {
                const colorBuckets = new Map();     // hex -> array of offset/hatch primitives
                const filledBuckets = new Map();    // hex -> array of filled primitives

                for (const layer of orderedLayers) {
                    const orderedPasses = reverseCutOrder ? layer.passes.slice().reverse() : layer.passes;

                    const isFilledLayer = layer.passes.some(p => p.type === 'filled');
                    const physicalPassCount = Math.max(...orderedPasses.map(p => p.metadata?.pass || 1), 1);

                    let passColors = null;

                    if (renderCtx.colorPerPass && physicalPassCount > 0 && !isFilledLayer) {
                        if (renderCtx.palette && renderCtx.palette.length > 0) {
                            passColors = this.generatePaletteMappedColors(physicalPassCount, renderCtx.palette, renderCtx.paletteLumping);
                        } else {
                            passColors = this.generatePassColors(layer.baseColor, physicalPassCount);
                        }
                    }

                    for (let i = 0; i < orderedPasses.length; i++) {
                        const pass = orderedPasses[i];
                        if (!pass.primitives || pass.primitives.length === 0) continue;

                        const physicalIndex = (pass.metadata?.pass || 1) - 1;

                        // Filled: collect separately to preserve hole topology
                        if (pass.type === 'filled') {
                            let colorHex = layer.baseColor;
                            if (renderCtx.colorPerPass && passColors) {
                                colorHex = passColors[physicalIndex] || layer.baseColor;
                            }
                            const safeColor = colorHex.toUpperCase();
                            if (!filledBuckets.has(safeColor)) filledBuckets.set(safeColor, []);

                            for (const prim of pass.primitives) {
                                filledBuckets.get(safeColor).push(prim);
                            }
                            continue;
                        }

                        // Hatch passes: assign palette color per angular pass, funnel into color buckets
                        if (pass.metadata?.isHatch === true) {
                            let colorHex = layer.baseColor;
                            if (renderCtx.colorPerPass && passColors) {
                                colorHex = passColors[physicalIndex] || layer.baseColor;
                            }
                            const safeColor = colorHex.toUpperCase();
                            if (!colorBuckets.has(safeColor)) colorBuckets.set(safeColor, []);
                            const bucket = colorBuckets.get(safeColor);
                            for (const prim of pass.primitives) {
                                if (!prim.properties) prim.properties = {};
                                prim.properties.isHatch = true;
                                bucket.push(prim);
                            }
                            continue;
                        }

                        const assignToBucket = (singlePrim) => {
                            let colorHex = layer.baseColor;
                            if (renderCtx.colorPerPass && passColors) {
                                colorHex = passColors[physicalIndex] || layer.baseColor;
                            }

                            const safeColor = colorHex.toUpperCase();
                            if (!colorBuckets.has(safeColor)) colorBuckets.set(safeColor, []);
                            colorBuckets.get(safeColor).push(singlePrim);
                        };

                        for (const prim of pass.primitives) {
                            if (prim.contours && prim.contours.length > 1) {
                                for (const contour of prim.contours) {
                                    assignToBucket({ ...prim, contours: [contour] });
                                }
                            } else {
                                assignToBucket(prim);
                            }
                        }
                    }
                }

                // Render color buckets in profile palette order
                const renderOrder = renderCtx.palette
                    ? [...renderCtx.palette.map(c => c.toUpperCase()), '#000000']
                    : Array.from(colorBuckets.keys());

                if (reverseCutOrder) {
                    renderOrder.reverse();
                }

                const renderedColors = new Set();

                for (const color of renderOrder) {
                    if (!colorBuckets.has(color) || renderedColors.has(color)) continue;
                    renderedColors.add(color);

                    let primitives = colorBuckets.get(color);

                    // Detect if this bucket contains hatch lines
                    const hasHatch = primitives.some(p => p.properties?.isHatch);

                    // Skip thermal sorting and reversing for hatch buckets - preserves zig-zag scan order
                    if (renderCtx.heatManagement !== 'off' && !hasHatch) {
                        primitives = this.applyHeatManagementSort(primitives);
                    }
                    if (reverseCutOrder && !hasHatch) {
                        primitives = primitives.slice().reverse();
                    }

                    const safeId = color.replace('#', '');
                    const groupId = hasHatch ? `xCS_Hatch_${safeId}` : `xCS_Layer_${safeId}`;
                    lines.push(`  <g id="${groupId}" fill="none" stroke="${color}">`);

                    if (hasHatch) {
                        // Hatch: batch all scan lines into a single <path> to preserve order
                        const batchedData = this.buildRawPathData(primitives);
                        if (batchedData) lines.push(`    <path d="${batchedData}"/>`);
                    } else {
                        // Offset: individual elements for circle/path rendering
                        for (const prim of primitives) {
                            if (prim.type === 'circle' && prim.center && prim.radius) {
                                // Normalize raw circle coordinates
                                lines.push(`    <circle cx="${fmt(prim.center.x - origin.x)}" cy="${fmt(prim.center.y - origin.y)}" r="${fmt(prim.radius)}"/>`);
                            } else {
                                if (prim.contours && prim.contours.length > 1) {
                                    for (const contour of prim.contours) {
                                        const singlePrim = { ...prim, contours: [contour] };
                                        const pathData = this.buildRawPathData([singlePrim], origin);
                                        if (pathData) lines.push(`    <path d="${pathData}"/>`);
                                    }
                                } else {
                                    const pathData = this.buildRawPathData([prim], origin);
                                    if (pathData) lines.push(`    <path d="${pathData}"/>`);
                                }
                            }
                        }
                    }
                    lines.push(`  </g>`);
                }

                // Render filled regions as a single group preserving hole topology
                for (const [color, primitives] of filledBuckets.entries()) {
                    const safeId = color.replace('#', '');
                    lines.push(`  <g id="xCS_Filled_${safeId}" fill="${color}" stroke="none">`);

                    // Output each primitive as its OWN path to prevent evenodd interference
                    for (const prim of primitives) {
                        if (prim.type === 'circle' && prim.center && prim.radius) continue; // Handled below
                        const pathData = this.buildRawPathData([prim], origin);
                        if (pathData) lines.push(`    <path d="${pathData}" fill-rule="evenodd"/>`);
                    }

                    this.appendRawCircles(lines, primitives, '    ', origin);
                    lines.push(`  </g>`);
                }

                lines.push(`</g>\n</svg>`);
                return { blob: new Blob([lines.join('\n')], { type: 'image/svg+xml;charset=utf-8' }) };
            }

            // ════════════════════════════════════════════════════════════
            // LAYER / GROUP / NONE BRANCHES (LightBurn, RDWorks, Generic)
            // ════════════════════════════════════════════════════════════
            for (const layer of orderedLayers) {
                const layerId = this.sanitizeId(layer.layerName);
                const orderedPasses = reverseCutOrder ? layer.passes.slice().reverse() : layer.passes;

                // Calculate true physical pass count to prevent palette skewing
                const physicalPassCount = Math.max(...orderedPasses.map(p => p.metadata?.pass || 1), 1);

                let passColors = null;
                const isFilledLayer = layer.passes.some(p => p.type === 'filled');

                // Compute per-pass colors for offset AND hatch strategies (not filled)
                if (renderCtx.colorPerPass && physicalPassCount > 0 && !isFilledLayer) {
                    passColors = renderCtx.palette && renderCtx.palette.length > 0
                        ? this.generatePaletteMappedColors(physicalPassCount, renderCtx.palette, renderCtx.paletteLumping)
                        : this.generatePassColors(layer.baseColor, physicalPassCount);
                }

                const wrapOperation = useGroups && !useLayers && orderedLayers.length > 1;
                if (wrapOperation) lines.push(`  <g id="Layer_${layerId}">`);

                const indent = wrapOperation ? '    ' : '  ';
                const innerIndent = useGroups ? (wrapOperation ? '      ' : '    ') : '  ';

                for (let i = 0; i < orderedPasses.length; i++) {
                    const pass = orderedPasses[i];
                    if (!pass.primitives || pass.primitives.length === 0) continue;

                    const physicalIndex = (pass.metadata?.pass || 1) - 1;
                    const isFilled = pass.type === 'filled';
                    const passId = this.buildPassId(layer.layerName, pass, physicalIndex);
                    const isHatch = pass.metadata?.isHatch === true;

                    let color = layer.baseColor;
                    if (renderCtx.colorPerPass && passColors) color = passColors[physicalIndex] || layer.baseColor;

                    let sortablePrimitives = pass.primitives;
                    if (renderCtx.heatManagement !== 'off' && !isFilled && !isHatch && sortablePrimitives.length > 1) {
                        sortablePrimitives = this.applyHeatManagementSort(sortablePrimitives);
                    }

                    // Reverse cut order for non-filled, non-hatch passes only
                    if (reverseCutOrder && !isFilled && !isHatch) sortablePrimitives = sortablePrimitives.slice().reverse();

                    const layerAttrs = useLayers ? ` inkscape:groupmode="layer" inkscape:label="${passId}"` : '';

                    if (isFilled) {
                        if (useGroups) {
                            lines.push(`${indent}<g id="${passId}"${layerAttrs} fill="${color}" stroke="none">`);
                            for (const prim of sortablePrimitives) {
                                if (prim.type === 'circle' && prim.center && prim.radius) continue; // Handled below
                                const pathData = this.buildRawPathData([prim], origin);
                                if (pathData) lines.push(`${innerIndent}<path d="${pathData}" fill-rule="evenodd"/>`);
                            }
                            this.appendRawCircles(lines, sortablePrimitives, innerIndent, origin);
                            lines.push(`${indent}</g>`);
                        } else {
                            for (const prim of sortablePrimitives) {
                                if (prim.type === 'circle' && prim.center && prim.radius) {
                                    lines.push(`${indent}<circle cx="${fmt(prim.center.x - origin.x)}" cy="${fmt(prim.center.y - origin.y)}" r="${fmt(prim.radius)}" fill="${color}" stroke="none"/>`);
                                } else {
                                    const pathData = this.buildRawPathData([prim], origin);
                                    if (pathData) lines.push(`${indent}<path d="${pathData}" fill="${color}" stroke="none" fill-rule="evenodd"/>`);
                                }
                            }
                        }
                    } else {
                        // Stroked passes (offset and hatch)
                        if (useGroups) {
                            lines.push(`${indent}<g id="${passId}"${layerAttrs} fill="none" stroke="${color}">`);
                            if (isHatch) {
                                const batchedData = this.buildRawPathData(sortablePrimitives, origin);
                                if (batchedData) lines.push(`${innerIndent}<path d="${batchedData}"/>`);
                            } else {
                                for (const prim of sortablePrimitives) {
                                    if (prim.type === 'circle' && prim.center && prim.radius) {
                                        lines.push(`${innerIndent}<circle cx="${fmt(prim.center.x - origin.x)}" cy="${fmt(prim.center.y - origin.y)}" r="${fmt(prim.radius)}"/>`);
                                    } else if (prim.contours && prim.contours.length > 1) {
                                        for (const contour of prim.contours) {
                                            const singlePrim = { ...prim, contours: [contour] };
                                            const pathData = this.buildRawPathData([singlePrim], origin);
                                            if (pathData) lines.push(`${innerIndent}<path d="${pathData}"/>`);
                                        }
                                    } else {
                                        const pathData = this.buildRawPathData([prim], origin);
                                        if (pathData) lines.push(`${innerIndent}<path d="${pathData}"/>`);
                                    }
                                }
                            }
                            lines.push(`${indent}</g>`);
                        } else {
                            if (isHatch) {
                                const batchedData = this.buildRawPathData(sortablePrimitives, origin);
                                if (batchedData) lines.push(`${indent}<path d="${batchedData}" fill="none" stroke="${color}"/>`);
                            } else {
                                for (const prim of sortablePrimitives) {
                                    if (prim.type === 'circle' && prim.center && prim.radius) {
                                        lines.push(`${innerIndent}<circle cx="${fmt(prim.center.x - origin.x)}" cy="${fmt(prim.center.y - origin.y)}" r="${fmt(prim.radius)}"/>`);
                                    } else if (prim.contours && prim.contours.length > 1) {
                                        for (const contour of prim.contours) {
                                            const singlePrim = { ...prim, contours: [contour] };
                                            const pathData = this.buildRawPathData([singlePrim], origin);
                                            if (pathData) lines.push(`${innerIndent}<path d="${pathData}" fill="none" stroke="${color}"/>`);
                                        }
                                    } else {
                                        const pathData = this.buildRawPathData([prim], origin);
                                        if (pathData) lines.push(`${innerIndent}<path d="${pathData}" fill="none" stroke="${color}"/>`);
                                    }
                                }
                            }
                        }
                    }
                }
                if (wrapOperation) lines.push(`  </g>`);
            }

            lines.push(`</g>\n</svg>`);
            return { blob: new Blob([lines.join('\n')], { type: 'image/svg+xml;charset=utf-8' }) };
        }

        // ────────────────────────────────────────────────────────────
        // PNG Generation
        // ────────────────────────────────────────────────────────────

        async generatePNG(layers, options, renderCtx) {
            const { mat, widthMm, heightMm } = renderCtx;
            const dpi = options.dpi || 1000;
            const pxPerMm = dpi / 25.4;
            let pxW = Math.ceil(widthMm * pxPerMm);
            let pxH = Math.ceil(heightMm * pxPerMm);

            // Browsers cap both side length and total area; past either the
            // canvas fails to allocate or renders blank.
            const fit = Math.min(
                1,
                this.MAX_CANVAS_DIM / pxW,
                this.MAX_CANVAS_DIM / pxH,
                Math.sqrt(this.MAX_CANVAS_PIXELS / (pxW * pxH))
            );
            if (fit < 1) {
                pxW = Math.max(1, Math.floor(pxW * fit));
                pxH = Math.max(1, Math.floor(pxH * fit));
                console.warn(`[graphicsExporter] Canvas clamped to ${pxW}x${pxH} - effective DPI ${Math.floor(dpi * fit)}.`);
            }
            const scaleX = pxW / widthMm;
            const scaleY = pxH / heightMm;

            // OffscreenCanvas exists in every Worker, so the document branch is
            // browser-main-thread only. Neither exists under Node: fail by name
            // rather than as a bare ReferenceError on `document`.
            let canvas;
            if (typeof OffscreenCanvas !== 'undefined') {
                canvas = new OffscreenCanvas(pxW, pxH);
            } else if (typeof document !== 'undefined') {
                canvas = Object.assign(document.createElement('canvas'), { width: pxW, height: pxH });
            } else {
                throw new Error('[graphicsExporter] PNG export needs OffscreenCanvas or a DOM canvas; neither is available in this host. Export SVG instead.');
            }

            // Null when the browser cannot back a canvas this large.
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error(`[graphicsExporter] Could not allocate a ${pxW}x${pxH} canvas. Lower the export DPI.`);
            }

            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, pxW, pxH);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            // Minimum line width: 1px in device space (sub-pixel protection)
            const minLineWidthMm = 1 / Math.min(scaleX, scaleY);
            for (const layer of layers) {
                // Use spot size for PNG raster strokes, but at least 1px
                const lineWidthMm = Math.max(layer.strokeWidth, minLineWidthMm);
                for (let i = 0; i < layer.passes.length; i++) {
                    const pass = layer.passes[i];
                    if (!pass.primitives || pass.primitives.length === 0) continue;
                    const isFilled = pass.type === 'filled';
                    const color = layer.baseColor;
                    ctx.beginPath();
                    this.traceTransformedPrimitives(ctx, pass.primitives, mat, scaleX, scaleY);
                    if (isFilled) {
                        ctx.fillStyle = color;
                        ctx.fill('evenodd');
                    } else {
                        ctx.lineWidth = lineWidthMm * Math.min(scaleX, scaleY);
                        ctx.strokeStyle = color;
                        ctx.stroke();
                    }
                }
            }

            // OffscreenCanvas encodes with convertToBlob(); toBlob() exists only on the DOM canvas.
            let blob;
            try {
                blob = typeof canvas.convertToBlob === 'function'
                    ? await canvas.convertToBlob({ type: 'image/png' })
                    : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            } finally {
                // Free the backing store now rather than at the next GC.
                canvas.width = 0;
                canvas.height = 0;
            }
            if (!blob) throw new Error('[graphicsExporter] PNG encoding returned no data.');
            return { blob };
        }

        // ────────────────────────────────────────────────────────────
        // Pre-transformed primitive rendering
        // ────────────────────────────────────────────────────────────

        /**
         * Formats numbers to strip trailing zeros: 0.5000 -> 0.5, 10.0000 -> 10.
         * SVG's number grammar also accepts the leading-zero-stripped form
         * (.5, -.25).
         */
        formatNumber(value, precision) {
            return parseFloat(value.toFixed(precision)).toString();
        }

        /**
         * Builds SVG path 'd' attribute
         */
        buildRawPathData(primitives, origin = { x: 0, y: 0 }) {
            const chunks = [];
            const prec = this.DECIMAL;
            const fmt = (n) => this.formatNumber(n, prec);

            for (const prim of primitives) {
                if (prim.type === 'circle') continue;
                if (!prim.contours || prim.contours.length === 0) continue;

                for (const contour of prim.contours) {
                    const pts = contour.points;
                    if (!pts || pts.length < 2) continue;

                    const arcMap = this.buildArcMap(contour, prim.arcSegments);

                    // Shift absolute initial positioning
                    let cx = pts[0].x - origin.x;
                    let cy = pts[0].y - origin.y;
                    // Start absolute
                    let d = `M${fmt(cx)} ${fmt(cy)}`;

                    // Helper to append optimized relative line
                    const appendRelLine = (tx, ty) => {
                        // Relative changes remain perfectly identical since the origin scalar cancels out
                        const dx = (tx - origin.x) - cx;
                        const dy = (ty - origin.y) - cy;
                        const sDx = fmt(dx);
                        const sDy = fmt(dy);
                        // Skip space if the Y value starts with a minus sign
                        const sep = sDy.startsWith('-') ? '' : ' ';
                        d += `l${sDx}${sep}${sDy}`;
                        cx = tx - origin.x; 
                        cy = ty - origin.y;
                    };

                    let i = 1;
                    while (i < pts.length) {
                        const arc = arcMap.get(i - 1);

                        if (arc && arc.endIndex < pts.length && arc.endIndex > i - 1) {
                            const r = arc.radius;
                            const endIdx = arc.endIndex;
                            const endPt = pts[endIdx];

                            let span = arc.sweepAngle;
                            if (span === undefined || span === null) {
                                span = arc.endAngle - arc.startAngle;
                                if (arc.clockwise && span > 0) span -= 2 * Math.PI;
                                if (!arc.clockwise && span < 0) span += 2 * Math.PI;
                            }

                            const largeArc = Math.abs(span) > Math.PI ? 1 : 0;
                            const sweep = arc.clockwise ? 0 : 1;
                            const sR = fmt(r);

                            if (Math.abs(span) >= Math.PI * 1.99) {
                                // Shift absolute midpoint positions
                                const mx = (2 * arc.center.x - pts[i - 1].x) - origin.x;
                                const my = (2 * arc.center.y - pts[i - 1].y) - origin.y;
                                d += `A${sR} ${sR} 0 0 ${sweep} ${fmt(mx)} ${fmt(my)}`;
                                d += `A${sR} ${sR} 0 0 ${sweep} ${fmt(endPt.x - origin.x)} ${fmt(endPt.y - origin.y)}`;
                            } else {
                                // Arcs remain absolute, shift the absolute target endpoint
                                d += `A${sR} ${sR} 0 ${largeArc} ${sweep} ${fmt(endPt.x - origin.x)} ${fmt(endPt.y - origin.y)}`;
                            }

                            cx = endPt.x - origin.x;
                            cy = endPt.y - origin.y;
                            i = endIdx + 1;
                        } else {
                            appendRelLine(pts[i].x, pts[i].y);
                            i++;
                        }
                    }

                    if (prim.properties?.closed !== false && pts.length > 2) d += 'Z';
                    chunks.push(d);
                }
            }
            return chunks.length > 0 ? chunks.join(' ') : null;
        }

        /**
         * Appends raw <circle>
         */
        appendRawCircles(lines, primitives, indent, origin = { x: 0, y: 0 }) {
            const fmt = (n) => this.formatNumber(n, this.DECIMAL);

            for (const prim of primitives) {
                if (prim.type !== 'circle' || !prim.center || !prim.radius) continue;
                lines.push(`${indent}<circle cx="${fmt(prim.center.x - origin.x)}" cy="${fmt(prim.center.y - origin.y)}" r="${fmt(prim.radius)}"/>`);
            }
        }

        /**
         * Traces pre-transformed primitives into a Canvas path.
         */
        traceTransformedPrimitives(ctx, primitives, mat, scaleX, scaleY) {
            const det = TransformMath.det(mat);;
            const scaleFactor = Math.sqrt(mat.a * mat.a + mat.b * mat.b);
            const rScale = Math.min(scaleX, scaleY);

            for (const prim of primitives) {
                if (prim.type === 'circle' && prim.center && prim.radius) {
                    const c = TransformMath.applyToPoint(mat, prim.center);
                    const rPx = prim.radius * scaleFactor * rScale;
                    const cx = c.x * scaleX;
                    const cy = c.y * scaleY;
                    ctx.moveTo(cx + rPx, cy);
                    ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
                    continue;
                }

                if (!prim.contours || prim.contours.length === 0) continue;

                for (const contour of prim.contours) {
                    const pts = contour.points;
                    if (!pts || pts.length < 2) continue;

                    const arcMap = this.buildArcMap(contour, prim.arcSegments);

                    const p0 = TransformMath.applyToPoint(mat, pts[0]);
                    ctx.moveTo(p0.x * scaleX, p0.y * scaleY);

                    let i = 1;
                    while (i < pts.length) {
                        const arc = arcMap.get(i - 1);

                        if (arc && arc.endIndex < pts.length && arc.endIndex > i - 1) {
                            // Transform center and compute pixel-space values
                            const tc = TransformMath.applyToPoint(mat, arc.center);
                            const rPx = arc.radius * scaleFactor * rScale;
                            const tcx = tc.x * scaleX;
                            const tcy = tc.y * scaleY;

                            // Compute angles in transformed space from actual points
                            const tStart = TransformMath.applyToPoint(mat, pts[i - 1]);
                            const tEnd = TransformMath.applyToPoint(mat, pts[arc.endIndex]);
                            const sa = Math.atan2(tStart.y * scaleY - tcy, tStart.x * scaleX - tcx);
                            const ea = Math.atan2(tEnd.y * scaleY - tcy, tEnd.x * scaleX - tcx);

                            // Canvas arc: counterclockwise param
                            // Baseline: CAM CW (true) -> Canvas CW (false). CAM CCW (false) -> Canvas CCW (true).
                            let ccw = !arc.clockwise;

                            // Only flip the winding if the user explicitly mirrored the geometry
                            // (A standard Y-down projection has det < 0. A mirrored one has det > 0)
                            if (det > 0) ccw = !ccw;

                            // Use sweepAngle if available (avoids wrap-around ballooning)
                            let span = arc.sweepAngle;
                            if (span === undefined || span === null) {
                                span = arc.endAngle - arc.startAngle;
                                if (arc.clockwise && span > 0) span -= 2 * Math.PI;
                                if (!arc.clockwise && span < 0) span += 2 * Math.PI;
                            }

                            // Full circle check based on angular span
                            if (Math.abs(span) >= Math.PI * 1.99) {
                                ctx.arc(tcx, tcy, rPx, sa, sa + 2 * Math.PI, ccw);
                            } else {
                                ctx.arc(tcx, tcy, rPx, sa, ea, ccw);
                            }

                            i = arc.endIndex + 1;
                        } else {
                            const pt = TransformMath.applyToPoint(mat, pts[i]);
                            ctx.lineTo(pt.x * scaleX, pt.y * scaleY);
                            i++;
                        }
                    }

                    if (prim.properties?.closed !== false && pts.length > 2) {
                        ctx.closePath();
                    }
                }
            }
        }

        // ────────────────────────────────────────────────────────────
        // Colinear Hatch Segment Fusion
        // ────────────────────────────────────────────────────────────

        /**
         * Merges colinear/overlapping hatch line segments across all layers.
         * Only operates on hatch passes. Rewrites pass.primitives on the
         * export's own pass objects; the primitives themselves are never
         * modified - the unfused ones belong to the operation.
         */
        fuseColinearSegments(layers) {
            const scanLines = new Map();

            for (let li = 0; li < layers.length; li++) {
                const layer = layers[li];
                for (let pi = 0; pi < layer.passes.length; pi++) {
                    const pass = layer.passes[pi];
                    if (!pass.metadata?.isHatch) continue;
                    if (!pass.primitives || pass.primitives.length === 0) continue;

                    const angle = pass.metadata.angle || 0;
                    const rad = -angle * Math.PI / 180;
                    const cosA = Math.cos(rad);
                    const sinA = Math.sin(rad);

                    for (let si = 0; si < pass.primitives.length; si++) {
                        const prim = pass.primitives[si];
                        if (!prim.contours || prim.contours.length === 0) continue;

                        const pts = prim.contours[0].points;
                        if (!pts || pts.length !== 2) continue;

                        const p0 = { x: pts[0].x * cosA - pts[0].y * sinA, y: pts[0].x * sinA + pts[0].y * cosA };
                        const p1 = { x: pts[1].x * cosA - pts[1].y * sinA, y: pts[1].x * sinA + pts[1].y * cosA };

                        const perpDist = Math.round(p0.y / PRECISION) * PRECISION;
                        const key = `${li}_${pi}_${angle}_${perpDist.toFixed(4)}`;

                        const xMin = Math.min(p0.x, p1.x);
                        const xMax = Math.max(p0.x, p1.x);

                        if (!scanLines.has(key)) scanLines.set(key, []);
                        scanLines.get(key).push({
                            xMin, xMax, perpDist,
                            angle, cosA, sinA,
                            layerIdx: li, passIdx: pi, primIdx: si
                        });
                    }
                }
            }

            const fusedByPass = new Map();
            const newPrimitivesByPass = new Map();

            for (const segments of scanLines.values()) {
                if (segments.length < 2) continue;

                segments.sort((a, b) => a.xMin - b.xMin);

                const merged = [];
                let current = { xMin: segments[0].xMin, xMax: segments[0].xMax };
                const consumed = [segments[0]];

                for (let i = 1; i < segments.length; i++) {
                    const seg = segments[i];
                    if (seg.xMin <= current.xMax + PRECISION) {
                        current.xMax = Math.max(current.xMax, seg.xMax);
                        consumed.push(seg);
                    } else {
                        if (consumed.length > 1) {
                            merged.push({ interval: { ...current }, sources: [...consumed] });
                        }
                        current = { xMin: seg.xMin, xMax: seg.xMax };
                        consumed.length = 0;
                        consumed.push(seg);
                    }
                }
                if (consumed.length > 1) {
                    merged.push({ interval: { ...current }, sources: [...consumed] });
                }

                for (const merge of merged) {
                    const ref = merge.sources[0];
                    const cosR = Math.cos(ref.angle * Math.PI / 180);
                    const sinR = Math.sin(ref.angle * Math.PI / 180);

                    const rotX0 = merge.interval.xMin;
                    const rotX1 = merge.interval.xMax;
                    const rotY = ref.perpDist;

                    const worldP0 = { x: rotX0 * cosR - rotY * sinR, y: rotX0 * sinR + rotY * cosR };
                    const worldP1 = { x: rotX1 * cosR - rotY * sinR, y: rotX1 * sinR + rotY * cosR };

                    const targetKey = `${ref.layerIdx}_${ref.passIdx}`;

                    for (const src of merge.sources) {
                        const srcKey = `${src.layerIdx}_${src.passIdx}`;
                        if (!fusedByPass.has(srcKey)) fusedByPass.set(srcKey, new Set());
                        fusedByPass.get(srcKey).add(src.primIdx);
                    }

                    if (!newPrimitivesByPass.has(targetKey)) newPrimitivesByPass.set(targetKey, []);
                    newPrimitivesByPass.get(targetKey).push(this.createLinePrimitive(worldP0, worldP1, {
                        isHatch: true, isFused: true,
                        fusedCount: merge.sources.length,
                        angle: ref.angle, closed: false
                    }));
                }
            }

            if (fusedByPass.size === 0) return;

            let totalRemoved = 0, totalAdded = 0;

            for (const [passKey, removeSet] of fusedByPass) {
                const [li, pi] = passKey.split('_').map(Number);
                const pass = layers[li].passes[pi];

                const originalCount = pass.primitives.length;
                pass.primitives = pass.primitives.filter((_, idx) => !removeSet.has(idx));
                totalRemoved += originalCount - pass.primitives.length;

                const newPrims = newPrimitivesByPass.get(passKey);
                if (newPrims) {
                    pass.primitives.push(...newPrims);
                    totalAdded += newPrims.length;
                }

                // Restore the zig-zag for the pass: scanlines ascend, even ones
                // run L→R, odd ones R→L. Direction is set from position, never
                // by flipping - generation already drew odd lines R→L, fused
                // lines arrive L→R - and a segment that has to turn is redrawn
                // as a NEW primitive. The unfused ones are the operation's own
                // objects (buildLayer passes offset.primitives by reference),
                // so nothing here writes to them.
                if (pass.metadata?.isHatch) {
                    const angle = pass.metadata.angle || 0;
                    const rad = (-angle * Math.PI) / 180;
                    const cosA = Math.cos(rad);
                    const sinA = Math.sin(rad);
                    const par = (p) => p.x * cosA - p.y * sinA;
                    const perp = (p) => p.x * sinA + p.y * cosA;
                    const ends = (prim) => prim.contours[0].points;
                    const oriented = (prim, leftToRight) => {
                        const [p0, p1] = ends(prim);
                        return par(p0) <= par(p1) === leftToRight
                            ? prim
                            : this.createLinePrimitive(p1, p0, prim.properties);
                    };
                    // By scanline, then along it from each segment's left end,
                    // whichever way the segment is drawn.
                    const left = (prim) => Math.min(par(ends(prim)[0]), par(ends(prim)[1]));
                    pass.primitives.sort((a, b) => {
                        const dPerp = perp(ends(a)[0]) - perp(ends(b)[0]);
                        return Math.abs(dPerp) > PRECISION ? dPerp : left(a) - left(b);
                    });
                    const ordered = [];
                    let line = [];
                    let lineIndex = 0;
                    const flush = () => {
                        if (line.length === 0) return;
                        const leftToRight = lineIndex % 2 === 0;
                        if (!leftToRight) line.reverse();
                        for (const prim of line) ordered.push(oriented(prim, leftToRight));
                        line = [];
                        lineIndex++;
                    };
                    let linePerp = null;
                    for (const prim of pass.primitives) {
                        const p = perp(ends(prim)[0]);
                        if (linePerp === null || Math.abs(p - linePerp) > PRECISION) {
                            flush();
                            linePerp = p;
                        }
                        line.push(prim);
                    }
                    flush();
                    pass.primitives = ordered;
                }
            }

            if (totalRemoved > 0) {
                this.debug(`[graphicsExporter] Hatch fusion: removed ${totalRemoved}, added ${totalAdded} (saved ${totalRemoved - totalAdded} elements)`);
            }
        }

        createLinePrimitive(p0, p1, properties) {
            return new PathPrimitive([{ points: [p0, p1], isHole: false, closed: false }], properties);
        }

        /**
         * Sorts primitives within a single pass by bounding-box area, smallest first.
         * This ensures small sensitive features are always cut before large geometry isolate them from the rest of the copper and limits their ability to cool between cutting passes.
         * Returns a new array; never mutates the input.
         */
        applyHeatManagementSort(primitives) {
            if (!primitives || primitives.length <= 1) return primitives;

            const len = primitives.length;
            const entries = new Array(len);

            for (let i = 0; i < len; i++) {
                const prim = primitives[i];
                const bounds = typeof prim.getBounds === 'function' ? prim.getBounds() : null;
                let area = 0;

                if (bounds && isFinite(bounds.minX)) {
                    area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
                }

                entries[i] = { prim, area };
            }

            entries.sort((a, b) => a.area - b.area);

            const result = new Array(len);
            for (let i = 0; i < len; i++) {
                result[i] = entries[i].prim;
            }
            return result;
        }

        // ────────────────────────────────────────────────────────────
        // Naming helpers
        // ────────────────────────────────────────────────────────────

        /**
         * Assigns colors based on laser controller profile palettes
         */
        generatePaletteMappedColors(passCount, palette, enableLumping) {
            const maxColors = palette.length;
            const colors = [];

            for (let i = 0; i < passCount; i++) {
                if (enableLumping) {
                    // Lumps all passes >= maxColors into the final palette color
                    colors.push(palette[Math.min(i, maxColors - 1)]);
                } else {
                    // Wraps around the palette if lumping is disabled
                    colors.push(palette[i % maxColors]);
                }
            }
            return colors;
        }

        /**
         * Generates a distinct color for each pass by rotating hue from a base color.
         * Returns an array of hex color strings, one per pass.
         */
        generatePassColors(baseColor, passCount) {
            if (passCount <= 1) return [baseColor];

            // Parse base color to HSL
            const r = parseInt(baseColor.slice(1, 3), 16) / 255;
            const g = parseInt(baseColor.slice(3, 5), 16) / 255;
            const b = parseInt(baseColor.slice(5, 7), 16) / 255;

            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2;
            let h = 0, s = 0;

            if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                else if (max === g) h = ((b - r) / d + 2) / 6;
                else h = ((r - g) / d + 4) / 6;
            }

            // Keep saturation high and lightness in visible range
            const sat = Math.max(s, 0.7);
            const lit = Math.min(Math.max(l, 0.35), 0.55);

            // Distribute passes evenly across the hue wheel starting from the base hue
            const colors = [];
            const hueStep = 1.0 / Math.max(passCount, 2);

            for (let i = 0; i < passCount; i++) {
                const pH = (h + hueStep * i) % 1.0;
                colors.push(this.hslToHex(pH, sat, lit));
            }

            return colors;
        }

        hslToHex(h, s, l) {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };

            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
            }

            const toHex = (c) => {
                const hex = Math.round(c * 255).toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            };

            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }

        buildPassId(layerName, pass, index) {
            const safe = this.sanitizeId(layerName);
            if (pass.metadata?.isHatch && pass.metadata?.angle !== undefined) {
                return `${safe}_Hatch_${pass.metadata.angle}deg`;
            }
            if (pass.type === 'filled') return `${safe}_Filled`;
            return `${safe}_Pass_${index + 1}`;
        }

        sanitizeId(str) {
            return (str || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[GraphicsExporter] ${message}`, data)
                 : console.log(`[GraphicsExporter] ${message}`);
        }
    }

    ROOT.GraphicsExporter = GraphicsExporter;
})();