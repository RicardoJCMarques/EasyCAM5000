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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const PRECISION = C.precision.coordinate;
    const debugState = D.debug;

    class GraphicsExporter {
        constructor() {
            this.DECIMAL = 4;
            this.HAIRLINE_STROKE = 0.01; // mm - standard svg hairline
            this.MAX_CANVAS_DIM = 16000;
        }

        /**
         * Operations → files. Owns the operation-to-layer mapping, the
         * PNG/SVG group split and the filenames; generate() below owns the
         * rendering.
         *
         * `ctx` carries the session facts this class must not go looking for:
         *   laser        settings.laser
         *   transforms   the workspace matrix set
         *   bounds       scene board bounds
         *   appName      for the comment block
         *   spotSizeFor  (op) => number|null, per-operation stroke width
         *
         * @returns {Promise<{success: boolean, files: Array<{blob: Blob, filename: string}>}>}
         */
        async exportOperations(operations, ctx, overrides = {}) {
            if (!operations || operations.length === 0) return { success: false, files: [] };

            const laser = ctx.laser;
            const format = overrides.format || laser.exportFormat;
            const dpi = overrides.dpi || laser.exportDPI;
            const padding = overrides.padding ?? laser.exportPadding ?? D.laser.exportPadding;
            const singleFile = overrides.singleFile !== false;
            const baseName = overrides.baseName || D.export.defaultBaseName;

            const activeProfile = laser.profiles?.[laser.activeProfile || 'generic'] || {};
            const layerColors = overrides.layerColors || laser.layerColors || {};

            const commonOptions = {
                dpi,
                padding,
                transforms: ctx.transforms,
                bounds: ctx.bounds,
                heatManagement: overrides.heatManagement ??
                    ((laser.heatManagement !== 'off' && format !== 'png') ? laser.heatManagement : 'off'),
                reverseCutOrder: overrides.reverseCutOrder ?? laser.reverseCutOrder ?? false,
                svgGrouping: overrides.svgGrouping ?? laser.svgGrouping ?? 'layer',
                colorPerPass: overrides.colorPerPass ?? laser.colorPerPass ?? false,
                palette: overrides.palette ?? activeProfile.palette ?? null,
                paletteLumping: overrides.paletteLumping ?? activeProfile.paletteLumping ?? false,
                includeComments: overrides.includeComments
            };

            // REVIEW - these should come from the language file.
            if (overrides.includeComments) {
                commonOptions.commentBlock = [
                    `${ctx.appName} SVG Export`,
                    `Date: ${new Date().toLocaleString()}`,
                    `Operations ${operations.length}:`,
                    ...operations.map(op => `  - ${op.type}: ${op.file.name}`)
                ];
            }

            const buildLayer = (op) => {
                if (!op.offsets || op.offsets.length === 0) return null;

                const passes = op.offsets.map((offset, idx) => ({
                    passIndex: idx + 1,
                    type: offset.type || 'offset',
                    primitives: offset.primitives || [],
                    metadata: {
                        ...(offset.metadata || {}),
                        offsetType: offset.offsetType || 'external',
                        thermalGroup: offset.metadata?.thermalGroup || offset.thermalGroup || 'shell',
                        pass: offset.pass || idx + 1,
                        distance: offset.distance
                    }
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
                    strokeWidth: ctx.spotSizeFor(op) ?? laser.spotSize,
                    passes
                };
            };

            const isPNGFormat = format === 'png';
            const rasterTypes = ['isolation', 'clearing'];
            let layerGroups = [];

            if (isPNGFormat) {
                const rasterLayers = [], vectorLayers = [];
                for (const op of operations) {
                    const layer = buildLayer(op);
                    if (!layer) continue;
                    (rasterTypes.includes(op.type) ? rasterLayers : vectorLayers).push(layer);
                }
                if (rasterLayers.length > 0) layerGroups.push({ layers: rasterLayers, format: 'png', suffix: '' });
                if (vectorLayers.length > 0) layerGroups.push({ layers: vectorLayers, format: 'svg', suffix: '-vectors' });
            } else if (singleFile) {
                const allLayers = operations.map(buildLayer).filter(Boolean);
                if (allLayers.length > 0) layerGroups.push({ layers: allLayers, format: 'svg', suffix: '' });
            } else {
                for (const op of operations) {
                    const layer = buildLayer(op);
                    if (!layer) continue;
                    layerGroups.push({ layers: [layer], format: 'svg', suffix: `-${op.type}` });
                }
            }

            if (layerGroups.length === 0) return { success: false, files: [] };

            const files = [];
            try {
                for (const group of layerGroups) {
                    const ext = group.format === 'png' ? '.png' : '.svg';
                    const result = await this.generate(group.layers, { ...commonOptions, format: group.format });
                    if (result?.blob) {
                        files.push({ blob: result.blob, filename: `${baseName}${group.suffix}${ext}` });
                    }
                }
            } catch (error) {
                console.error('[GraphicsExporter] Export generation failed:', error);
                return { success: false, files: [] };
            }

            return { success: files.length > 0, files };
        }

        async generate(layers, options) {
            // Fuse colinear hatch segments across operation layers before export
            this.fuseColinearSegments(layers);

            // Build user-transform matrix (rotation, mirror, origin - no bounds shift or Y-flip)
            const userMat = this.buildUserTransformMatrix(options.transforms);

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
                heatManagement: options.heatManagement || 'off',
                reverseCutOrder: options.reverseCutOrder || false,
                svgGrouping: options.svgGrouping || 'layer',
                colorPerPass: options.colorPerPass || false,
                palette: options.palette || null,
                paletteLumping: options.paletteLumping || false,
                includeComments: options.includeComments,
                commentBlock: options.commentBlock
            };

            if (options.format === 'png') {
                return this.generatePNG(layers, options, renderCtx);
            }
            return this.generateSVG(layers, renderCtx);
        }

        /**
         * User-space transform as a matrix: delegates to WorkspaceTransform
         * so the exporter can never disagree with the toolpath pipeline.
         * Bounds-shift and Y-flip are composed on top in buildOutputMatrix.
         */
        buildUserTransformMatrix(transforms) {
            if (!transforms) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            return transforms.matrix;
        }

        /**
         * Scans all geometry through the user-transform matrix to find the true bounding box of the output.
         */
        computeTransformedBounds(layers, userMat) {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            const expand = (x, y) => {
                const p = this.tx(x, y, userMat);
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            };

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
                        // Paths: expand by every vertex
                        if (prim.contours) {
                            for (const c of prim.contours) {
                                if (!c.points) continue;
                                for (const pt of c.points) {
                                    expand(pt.x, pt.y);
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
            const widthMm  = (trueBounds.maxX - trueBounds.minX) + (padding * 2);
            const heightMm = (trueBounds.maxY - trueBounds.minY) + (padding * 2);

            // Start from the user matrix
            let m = userMat;

            // Bounds shift using TRUE bounds → geometry min lands at (padding, padding)
            m = this.matMul({
                a: 1, b: 0, c: 0, d: 1,
                e: -trueBounds.minX + padding,
                f: -trueBounds.minY + padding
            }, m);

            // Y-flip: SVG/Canvas Y-down, CAM Y-up → y' = heightMm - y
            m = this.matMul({
                a: 1, b: 0, c: 0, d: -1,
                e: 0, f: heightMm
            }, m);

            return { mat: m, widthMm, heightMm };
        }

        /**
         * Multiplies two affine matrices: result = m1 ∘ m2 (m1 applied after m2 to a point)
         */
        matMul(m1, m2) {
            return {
                a: m1.a * m2.a + m1.c * m2.b,
                b: m1.b * m2.a + m1.d * m2.b,
                c: m1.a * m2.c + m1.c * m2.d,
                d: m1.b * m2.c + m1.d * m2.d,
                e: m1.a * m2.e + m1.c * m2.f + m1.e,
                f: m1.b * m2.e + m1.d * m2.f + m1.f
            };
        }

        /** Applies pre-computed affine matrix to a point. */
        tx(x, y, m) {
            return {
                x: m.a * x + m.c * y + m.e,
                y: m.b * x + m.d * y + m.f
            };
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

            // Safety clamp
            if (pxW > this.MAX_CANVAS_DIM || pxH > this.MAX_CANVAS_DIM) {
                const s = Math.min(this.MAX_CANVAS_DIM / pxW, this.MAX_CANVAS_DIM / pxH);
                pxW = Math.floor(pxW * s);
                pxH = Math.floor(pxH * s);
                console.warn(`[graphicsExporter] Canvas clamped to ${pxW}x${pxH}. Effective DPI reduced.`);
            }

            const scaleX = pxW / widthMm;
            const scaleY = pxH / heightMm;

            const canvas = document.createElement('canvas');
            canvas.width = pxW;
            canvas.height = pxH;
            const ctx = canvas.getContext('2d');

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

            return new Promise((resolve, reject) => {
                canvas.toBlob(blob => {
                    // Force cleanup
                    ctx.clearRect(0, 0, pxW, pxH);
                    canvas.width = 0;
                    canvas.height = 0;

                    if (blob) resolve({ blob });
                    else reject(new Error('Canvas toBlob returned null'));
                }, 'image/png');
            });
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
            const det = mat.a * mat.d - mat.b * mat.c;
            const scaleFactor = Math.sqrt(mat.a * mat.a + mat.b * mat.b);
            const rScale = Math.min(scaleX, scaleY);

            for (const prim of primitives) {
                if (prim.type === 'circle' && prim.center && prim.radius) {
                    const c = this.tx(prim.center.x, prim.center.y, mat);
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

                    const p0 = this.tx(pts[0].x, pts[0].y, mat);
                    ctx.moveTo(p0.x * scaleX, p0.y * scaleY);

                    let i = 1;
                    while (i < pts.length) {
                        const arc = arcMap.get(i - 1);

                        if (arc && arc.endIndex < pts.length && arc.endIndex > i - 1) {
                            // Transform center and compute pixel-space values
                            const tc = this.tx(arc.center.x, arc.center.y, mat);
                            const rPx = arc.radius * scaleFactor * rScale;
                            const tcx = tc.x * scaleX;
                            const tcy = tc.y * scaleY;

                            // Compute angles in transformed space from actual points
                            const tStart = this.tx(pts[i - 1].x, pts[i - 1].y, mat);
                            const tEnd = this.tx(pts[arc.endIndex].x, pts[arc.endIndex].y, mat);
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
                            const pt = this.tx(pts[i].x, pts[i].y, mat);
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
         * Only operates on hatch passes. Modifies passes in-place.
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

            for (const [key, segments] of scanLines) {
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

                // Restore Zig-Zag order for the pass
                if (pass.metadata?.isHatch) {
                    const angle = pass.metadata.angle || 0;
                    const rad = -angle * Math.PI / 180;
                    const cosA = Math.cos(rad);
                    const sinA = Math.sin(rad);

                    // Sort by perpendicular distance, then parallel distance
                    pass.primitives.sort((a, b) => {
                        const pA = a.contours[0].points[0];
                        const pB = b.contours[0].points[0];
                        const perpA = pA.x * sinA + pA.y * cosA;
                        const perpB = pB.x * sinA + pB.y * cosA;
                        if (Math.abs(perpA - perpB) > PRECISION) {
                            return perpA - perpB;
                        }
                        const parA = pA.x * cosA - pA.y * sinA;
                        const parB = pB.x * cosA - pB.y * sinA;
                        return parA - parB;
                    });

                    // Re-apply alternating Zig-Zag direction and segment order
                    let currentPerp = null;
                    let scanlineStart = 0;
                    let scanlineIndex = -1;

                    for (let si = 0; si <= pass.primitives.length; si++) {
                        const prim = si < pass.primitives.length ? pass.primitives[si] : null;
                        const pts = prim ? prim.contours[0].points : null;
                        const perp = pts ? pts[0].x * sinA + pts[0].y * cosA : null;

                        const isNewScanline = prim === null || currentPerp === null || 
                            Math.abs(perp - currentPerp) > PRECISION;

                        if (isNewScanline) {
                            // Process previous scanline group
                            if (scanlineIndex >= 0 && scanlineIndex % 2 === 1) {
                                // Odd scanlines: reverse segment order AND flip each segment's direction
                                const group = pass.primitives.slice(scanlineStart, si);
                                group.reverse();
                                for (const g of group) {
                                    g.contours[0].points.reverse();
                                }
                                pass.primitives.splice(scanlineStart, group.length, ...group);
                            } else if (scanlineIndex >= 0) {
                                // Even scanlines: ensure L→R (already sorted ascending, no-op)
                            }

                            if (prim) {
                                scanlineStart = si;
                                scanlineIndex++;
                                currentPerp = perp;
                            }
                        }
                    }
                }
            }

            if (totalRemoved > 0) {
                this.debug(`[graphicsExporter] Hatch fusion: removed ${totalRemoved}, added ${totalAdded} (saved ${totalRemoved - totalAdded} elements)`);
            }
        }

        createLinePrimitive(p0, p1, properties) {
            if (typeof PathPrimitive !== 'undefined') {
                return new PathPrimitive([{
                    points: [p0, p1], isHole: false,
                    nestingLevel: 0, parentId: null,
                    arcSegments: [], curveIds: []
                }], properties);
            }
            return {
                type: 'path',
                contours: [{ points: [p0, p1], isHole: false }],
                properties: properties
            };
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

    window.GraphicsExporter = GraphicsExporter;
})();