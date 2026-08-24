/*!
 * @file        renderer/renderer-layer.js
 * @description Manages canvas layers
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class LayerRenderer {
        constructor(canvasId, core) {
            this.canvas = document.getElementById(canvasId);
            if (!this.canvas) {
                throw new Error(`Canvas element '${canvasId}' not found`);
            }

            // RendererCore reads scene.transform via getters - pass it now
            // so origin/rotation/mirror are correct on the first paint.
            this.core = new RendererCore(this.canvas, core ? core.scene : null);
            this.appCore = core;

            this.primitiveRenderer = new PrimitiveRenderer(this.core);
            this.overlayRenderer = new OverlayRenderer(this.core);

            this.debugPrimitives = [];
            this.debugPrimitivesScreen = [];
            this.renderQueued = false;
            this.renderHandle = null;

            this.core.resizeCanvas();
            this.core.zoomFit(); // Enforce default origin placement in canvas
        }

        // Property accessors
        get layers() { return this.core.layers; }
        get options() { return this.core.options; }
        get viewScale() { return this.core.viewScale; }
        get viewOffset() { return this.core.viewOffset; }
        get ctx() { return this.core.ctx; }
        get bounds() { return this.core.bounds; }
        get renderStats() { return this.core.renderStats; }

        setOptions(options) {
            this.core.setOptions(options);
            this.render();
        }

        addLayer(name, primitives, options = {}) {
            this.core.addLayer(name, primitives, options);
        }

        removeLayer(name) {
            this.core.removeLayer(name);
        }

        clearLayers() {
            this.core.clearLayers();
        }

        /**
         * Updates a layer's world matrix and bounds without rebuilding any
         * primitives or render cache entries. Called from drag-move handlers
         * to avoid the cost of clearLayers() + addLayer() per mousemove tick.
         *
         * The per-primitive renderCache.entries[*].bounds stay in LOCAL space
         * (they describe the primitive's local-frame bbox). The renderer's
         * per-layer inverse-transform of viewBounds (see renderVisibleLayers
         * below) compensates so viewport culling stays correct.
         *
         * @param {string} layerName   Layer key (e.g. `shape_${shape.id}`)
         * @param {object} newMatrix   Affine matrix {a,b,c,d,e,f}
         * @param {object} [newBounds] Optional world-space AABB. If omitted,
         *                             the cached bounds stay as-is.
         */
        updateLayerTransform(layerName, newMatrix, newBounds) {
            const layer = this.core.layers.get(layerName);
            if (!layer) return false;
            layer.transform = newMatrix;
            if (newBounds) {
                layer.bounds = newBounds;
                if (layer.renderCache) layer.renderCache.bounds = newBounds;
            }
            this.core.calculateOverallBounds();
            return true;
        }

        // ========================================================================
        // Main Render Entry Point
        // ========================================================================

        render() {
            if (this.renderQueued) return;
            this.renderQueued = true;
            this.renderHandle = requestAnimationFrame(() => {
                this.renderQueued = false;
                this.actualRender();
            });
        }

        actualRender() {
            const startTime = this.core.beginRender();
            this.core.clearCanvas();
            this.debugPrimitives = [];
            this.core.setupTransform();
            this.ctx.save();

            // Apply the global workspace transform as a single matrix.
            // Composition order, mirror pivots, and the mirror-XOR-rotation
            // sign rule are all baked into Scene.getWorkspaceMatrix() -
            // the renderer no longer reimplements any transform math.
            const scene = this.core.scene;
            if (scene) {
                const wm = scene.getWorkspaceMatrix();
                if (!TransformMath.isIdentity(wm)) {
                    this.ctx.transform(wm.a, wm.b, wm.c, wm.d, wm.e, wm.f);
                }
            }

            // Render geometry using hybrid approach
            if (this.options.showWireframe) {
                this.renderWireframeMode();
            } else {
                this.renderVisibleLayers();
            }

            // Debug overlay - re-collect from all visible layers to bypass LOD culling.
            // Per-point viewport culling still happens inside renderDebugOverlayWorld.
            // Primitives from transformed layers (EasyShape per-shape layers) are
            // snapshot-transformed into world space so debug dots track the geometry.
            if (this.options.debugPoints || this.options.debugArcs) {
                this.debugPrimitives = [];
                this.layers.forEach(layer => {
                    if (!layer.visible || !layer.renderCache?.entries) return;
                    const m = layer.transform || null;
                    for (const entry of layer.renderCache.entries) {
                        if (this.shouldCollectDebug(entry.primitive)) {
                            if (m && typeof GeometryUtils !== 'undefined') {
                                const world = GeometryUtils.transformPrimitive(entry.primitive, m);
                                if (world) this.debugPrimitives.push(world);
                            } else {
                                this.debugPrimitives.push(entry.primitive);
                            }
                        }
                    }
                });
            }

            if ((this.options.debugPoints || this.options.debugArcs) && 
                this.debugPrimitives.length > 0) {
                this.renderDebugOverlayWorld();
            }

            this.ctx.restore();

            // World-space overlays
            if (this.options.showGrid) this.overlayRenderer.renderGrid();
            if (this.options.showBounds) this.overlayRenderer.renderBounds();
            if (this.options.showOrigin) this.overlayRenderer.renderOrigin();

            // Interaction overlay (marquee box, selection bounds, drag handles).
            // World-space - drawn before resetTransform so the tool can reason
            // in mm. EasyTrace never sets this hook, so the call is a no-op
            // there. The callback receives the canvas 2D context and the
            // renderer core (useful for view-scale-aware line widths via
            // core.frameCache.invScale).
            if (typeof this.onRenderOverlay === 'function') {
                this.onRenderOverlay(this.ctx, this.core);
            }

            // Screen-space overlays
            this.core.resetTransform();
            if (this.options.showRulers) this.overlayRenderer.renderRulers();
            this.overlayRenderer.renderScaleIndicator();
            if (this.options.showStats) this.overlayRenderer.renderStats();

            this.core.endRender(startTime);
        }

        // ========================================================================
        // Hybrid Rendering Pipeline
        // ========================================================================

        renderVisibleLayers() {
            const orderedLayers = this.getOrderedLayers();

            // Per-type copper source layer counts for multi-file transparency
            const copperSourceCounts = { isolation: 0, clearing: 0 };
            for (const layer of orderedLayers) {
                if (!layer.visible) continue;
                const isSource = !layer.isOffset && !layer.isPreview && layer.type !== 'offset' && layer.type !== 'preview' && layer.type !== 'fused';
                if (isSource && layer.type in copperSourceCounts) {
                    copperSourceCounts[layer.type]++;
                }
            }

            // Save the world-space view bounds once. Swap them out per-layer
            // when a layer has its own transform (drag-moved shapes), so the
            // type-specific renderers' viewport-culling tests compare against
            // bounds in the same coordinate frame as entry.bounds (local).
            const worldViewBounds = this.core.frameCache.viewBounds;

            for (const layer of orderedLayers) {
                if (!layer.visible) continue;

                // Non-finite guard: one NaN primitive poisons layer bounds and
                // every downstream fit/cull. Skip the layer loudly instead of
                // drawing nothing.
                const layerBounds = layer.bounds;
                if (layerBounds && !(Number.isFinite(layerBounds.minX) && Number.isFinite(layerBounds.maxX) &&
                                     Number.isFinite(layerBounds.minY) && Number.isFinite(layerBounds.maxY))) {
                    console.warn(`[Render] Skipped layer "${layer.name || layer.type}" - non-finite geometry bounds.`);
                    this.core.renderStats.skippedPrimitives += layer.primitives.length;
                    continue;
                }

                // Centralized layer-level culling (always world space) // REVIEW - Double check this is the best way to do this
                if (layerBounds && !this.core.boundsIntersect(layerBounds, worldViewBounds)) {
                    this.core.renderStats.primitives += layer.primitives.length;
                    this.core.renderStats.skippedPrimitives += layer.primitives.length;
                    continue;
                }

                const isStencil = layer.type === 'stencil' || layer.operationType === 'stencil';
                const isStencilSource = isStencil && !layer.isOffset && !layer.isPreview && layer.type !== 'offset' && layer.type !== 'preview';
                const isStencilGenerated = isStencil && !isStencilSource;

                // EasyShape5000: per-layer world transform.
                // EasyTrace5000: layers have no transform so this branch
                // is skipped entirely (no save/restore cost).
                const hasLayerTransform = !!layer.transform;
                if (hasLayerTransform) {
                    this.ctx.save();
                    const m = layer.transform;
                    this.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);

                    // Transform view bounds into this layer's local frame so
                    // viewport culling works.
                    const inv = TransformMath.invert(m);
                    if (inv) {
                        this.core.frameCache.viewBounds =
                            TransformMath.transformBounds(inv, worldViewBounds);
                    }
                }

                // Dispatch to renderer
                if (layer.isHatch) {
                    this.renderHatchLayerBatched(layer);
                } else if (isStencilSource) {
                    this.renderStencilSourceImmediate(layer);
                } else if (isStencilGenerated) {
                    this.renderStencilGeneratedImmediate(layer);
                } else if (layer.metadata?.strategy === 'filled') {
                    this.renderFilledLayerImmediate(layer);
                } else if (layer.isOffset || layer.type === 'offset') {
                    this.renderOffsetLayerImmediate(layer);
                } else if (layer.isPreview || layer.type === 'preview') {
                    this.renderPreviewLayerImmediate(layer);
                } else {
                    this.renderSourceLayerImmediate(layer);
                }

                if (hasLayerTransform) {
                    this.ctx.restore();
                    // Restore world-space view bounds for subsequent layers.
                    this.core.frameCache.viewBounds = worldViewBounds;
                }
            }
        }

        /**
         * Viewport + LOD + filter gate, shared by every layer renderer.
         * Bumps the render stats and collects debug primitives so the
         * counters mean the same thing on every path.
         * @param {object} layer
         * @param {object} entry  renderCache entry
         * @param {object} opts
         * @param {boolean} [opts.lod=true]     apply LOD culling
         * @param {boolean} [opts.filter=true]  apply options.primitiveFilter
         * @returns {boolean} true when the primitive should be drawn
         */
        acceptPrimitive(layer, entry, opts = {}) {
            const stats = this.core.renderStats;
            stats.primitives++;

            if (!this.core.boundsIntersect(entry.bounds, this.core.frameCache.viewBounds)) {
                stats.skippedPrimitives++;
                stats.culledViewport++;
                return false;
            }

            if (opts.lod !== false &&
                !this.core.passesLODCull(entry.screenSize, this.core.viewScale, this.core.lodThreshold)) {
                stats.skippedPrimitives++;
                stats.culledLOD++;
                return false;
            }

            if (opts.filter !== false && this.options.primitiveFilter &&
                !this.options.primitiveFilter(entry.primitive, layer.type)) {
                stats.skippedPrimitives++;
                return false;
            }

            stats.renderedPrimitives++;
            if (this.shouldCollectDebug(entry.primitive)) {
                this.debugPrimitives.push(entry.primitive);
            }
            return true;
        }

        getOrderedLayers() {
            // Dumb numeric paint-order sort. Semantic ordering (drills last,
            // stencil on top, source under offsets, etc.) is encoded by each
            // app as zIndex when it adds the layer. Array#sort is stable in all
            // current engines, so equal-zIndex layers keep Map insertion order
            // (i.e. document order).
            const layers = [];
            this.layers.forEach((layer) => {
                if (layer.visible) layers.push(layer);
            });
            layers.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
            return layers;
        }

        // ========================================================================
        // OFFSET: Immediate Mode
        // ========================================================================

        renderOffsetLayerImmediate(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            const offsetColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);

            // Buckets for z-ordering
            const standardGeometry = [];
            const drillMillingPaths = [];
            const peckMarks = [];

            const entries = layer.renderCache.entries;

            for (const entry of entries) {
                if (!this.acceptPrimitive(layer, entry)) continue;

                const prim = entry.primitive;
                const role = prim.properties?.role;
                if (role === 'peck_mark' || prim.properties?.isToolPeckMark) {
                    peckMarks.push(prim);
                } else if (role === 'drill_milling_path' || prim.properties?.isCenterlinePath) {
                    drillMillingPaths.push(prim);
                } else {
                    standardGeometry.push(prim);
                }
            }

            // Render in z-order using IMMEDIATE MODE (fast)
            // Standard offsets
            for (const prim of standardGeometry) {
                this.primitiveRenderer.renderOffsetPrimitive(prim, offsetColor, { layer });
                this.core.renderStats.drawCalls++;
            }

            // Drill milling paths
            for (const prim of drillMillingPaths) {
                this.primitiveRenderer.renderOffsetPrimitive(prim, offsetColor, { layer });
                this.core.renderStats.drawCalls++;
            }

            // Peck marks
            for (const prim of peckMarks) {
                this.primitiveRenderer.renderPeckMark(prim, { layer });
                this.core.renderStats.drawCalls++;
            }
        }

        // ========================================================================
        // STENCIL SOURCE: Ghost fill overlay
        // ========================================================================

        renderStencilSourceImmediate(layer) {
            const stencilColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);
            this.ctx.fillStyle = stencilColor;

            for (const entry of layer.renderCache.entries) {
                if (!this.acceptPrimitive(layer, entry)) continue;

                this.primitiveRenderer.drawPrimitivePath(entry.primitive);
                this.ctx.save();
                this.ctx.globalAlpha = 0.45; // Keep this alpha so only 1 theme color is needed
                this.ctx.fill('evenodd');
                this.ctx.restore();

                this.core.renderStats.drawCalls++;
            }
        }

        // ========================================================================
        // STENCIL GENERATED: Fill + stroke outlines (aperture cutouts)
        // ========================================================================

        renderStencilGeneratedImmediate(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            const stencilColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);
            const fc = this.core.frameCache;
            const strokeWidth = Math.max(2.0 * fc.invScale, fc.minWorldWidth);

            this.ctx.fillStyle = stencilColor;
            this.ctx.strokeStyle = stencilColor;
            this.ctx.lineWidth = strokeWidth;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.setLineDash([]);

            const entries = layer.renderCache.entries;

            for (const entry of entries) {
                this.core.renderStats.primitives++;

                if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledViewport++;
                    continue;
                }

                if (!this.core.passesLODCull(entry.screenSize, this.core.viewScale, this.core.lodThreshold)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledLOD++;
                    continue;
                }

                this.core.renderStats.renderedPrimitives++;

                if (this.shouldCollectDebug(entry.primitive)) {
                    this.debugPrimitives.push(entry.primitive);
                }

                // Fill + stroke: shows aperture area with crisp boundary
                this.primitiveRenderer.drawPrimitivePath(entry.primitive);
                this.ctx.fill('evenodd');
                this.ctx.stroke();

                this.core.renderStats.drawCalls += 2;
            }
        }

        // ========================================================================
        // FILLED (Laser): Immediate Mode
        // ========================================================================

        renderFilledLayerImmediate(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            // Resolve colors from theme with fallback
            const fillColor = this.core.colors.geometry.laser.filled ||
                              this.core.colors.geometry.preview;
            const minWidth = this.core.frameCache.minWorldWidth;
            const outlineWidth = Math.max(1.0 * this.core.frameCache.invScale, minWidth);

            const entries = layer.renderCache.entries;

            for (const entry of entries) {
                this.core.renderStats.primitives++;

                // Viewport culling
                if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledViewport++;
                    continue;
                }

                // LOD culling
                if (!this.core.passesLODCull(entry.screenSize, this.core.viewScale, this.core.lodThreshold)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledLOD++;
                    continue;
                }

                const prim = entry.primitive;
                if (this.options.primitiveFilter && !this.options.primitiveFilter(prim, layer.type)) {
                    this.core.renderStats.skippedPrimitives++;
                    continue;
                }

                this.core.renderStats.renderedPrimitives++;

                // Build the path once - drawPrimitivePath calls beginPath() internally.
                // Multi-contour paths with holes render correctly via evenodd fill rule since outer and hole contours have opposite winding from Clipper output.
                this.primitiveRenderer.drawPrimitivePath(prim);

                // Solid fill to show ablation zone
                this.ctx.save();
                this.ctx.fillStyle = fillColor;
                this.ctx.fill('evenodd');
                this.ctx.restore();

                // Debug collection
                if (this.shouldCollectDebug(prim)) {
                    this.debugPrimitives.push(prim);
                }

                this.core.renderStats.drawCalls += 2;
            }
        }

        // ========================================================================
        // HATCH (Laser): Batched Immediate Mode
        // ========================================================================

        /**
         * Renders laser hatch lines using a single batched draw call.
         */
        renderHatchLayerBatched(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            // No layer-level LOD: hatch lines are all one size, so per-line
            // LOD can only ever cull all or none, and the layer-level bbox
            // test in renderVisibleLayers already rejects an off-screen
            // region. Viewport culling below still applies per line.

            const hatchColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);

            // Use the same screen-pixel-based stroke width as standard offsets.
            // Hatch metadata carries toolDiameter for future export use, but rendering uses a zoom-invariant stroke like all other offset geometry.
            const fc = this.core.frameCache;
            const lineWidth = Math.max(this.primitiveRenderer.cfg.stroke.offset * fc.invScale, fc.minWorldWidth);

            this.ctx.save();
            this.ctx.strokeStyle = hatchColor;
            this.ctx.lineWidth = lineWidth;
            this.ctx.lineCap = 'butt';
            this.ctx.lineJoin = 'miter';
            this.ctx.setLineDash([]);

            // Single batched path for all hatch lines
            this.ctx.beginPath();

            const entries = layer.renderCache.entries;

            let batchedCount = 0;

            for (const entry of entries) {
                this.core.renderStats.primitives++;

                // Viewport culling still applies per-primitive - lines off-screen are cheap to skip and the check is just 4 comparisons.
                if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledViewport++;
                    continue;
                }

                const prim = entry.primitive;
                this.core.renderStats.renderedPrimitives++;

                // Accumulate into the batch path.
                // Hatch primitives are always 2-point open paths from HatchGenerator.
                if (prim.contours && prim.contours[0] && prim.contours[0].points.length >= 2) {
                    const pts = prim.contours[0].points;
                    this.ctx.moveTo(pts[0].x, pts[0].y);
                    for (let i = 1; i < pts.length; i++) {
                        this.ctx.lineTo(pts[i].x, pts[i].y);
                    }
                    batchedCount++;
                }
            }

            // Single draw call for the entire layer
            if (batchedCount > 0) {
                this.ctx.stroke();
                this.core.renderStats.drawCalls++;
            }

            this.ctx.restore();
        }

        // ========================================================================
        // PREVIEW: Immediate Mode
        // ========================================================================


        renderPreviewLayerImmediate(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            const previewColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);
            const minWidth = this.core.frameCache.minWorldWidth;

            // Set Base State
            this.ctx.strokeStyle = previewColor;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.setLineDash([]);

            let currentDiameter = -1;

            const entries = layer.renderCache.entries;

            for (const entry of entries) {
                this.core.renderStats.primitives++;

                // Culling
                if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledViewport++;
                    continue;
                }

                if (!this.core.passesLODCull(entry.screenSize, this.core.viewScale, this.core.lodThreshold)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledLOD++;
                    continue;
                }

                const prim = entry.primitive;
                if (this.options.primitiveFilter && !this.options.primitiveFilter(prim, layer.type)) {
                    this.core.renderStats.skippedPrimitives++;
                    continue;
                }

                this.core.renderStats.renderedPrimitives++;

                if (this.shouldCollectDebug(prim)) {
                    this.debugPrimitives.push(prim);
                }

                // Determine Geometry Type
                const role = prim.properties?.role;
                const isComplex = role === 'peck_mark' || 
                                prim.properties?.isCenterlinePath || 
                                (prim.properties?.toolRelation && prim.properties?.toolRelation !== 'exact') ||
                                role === 'drill_milling_path';

                if (isComplex) {
                    this.ctx.save();
                    // Let the dedicated renderer handle color changes / fills for complex items
                    const toolDia = prim.properties?.toolDiameter || layer.metadata?.toolDiameter;

                    if (role === 'peck_mark') {
                        this.primitiveRenderer.renderPeckMark(prim, { layer });
                    } else if (prim.properties?.isCenterlinePath) {
                        this.primitiveRenderer.renderCenterlineSlot(prim, { layer, toolDiameter: toolDia });
                    } else {
                        this.primitiveRenderer.renderToolPreview(prim, previewColor, { layer, toolDiameter: toolDia });
                    }

                    this.ctx.restore();
                    // Reset state tracker
                    currentDiameter = -1;
                } else {
                    // Standard Stroke (Fast Path)
                    const toolDia = layer.metadata?.toolDiameter || 
                                    prim.properties?.toolDiameter || 
                                    this.getToolDiameterForPrimitive(prim);

                    if (toolDia !== currentDiameter) {
                        this.ctx.lineWidth = Math.max(toolDia, minWidth);
                        currentDiameter = toolDia;
                    }

                    this.primitiveRenderer.drawPrimitivePath(prim);
                    this.ctx.stroke();
                }

                this.core.renderStats.drawCalls++;
            }
        }

        // ========================================================================
        // SOURCE: Immediate Mode
        // ========================================================================

        renderSourceLayerImmediate(layer) {
            const viewBounds = this.core.frameCache.viewBounds;

            // Determine Base Color.
            let layerColor = this.options.resolveLayerColor ? this.options.resolveLayerColor(layer) : (layer.color);

            // Set Base Context State
            this.ctx.fillStyle = layerColor;
            this.ctx.strokeStyle = layerColor;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';

            const minWidth = this.core.frameCache.minWorldWidth;
            let currentLineWidth = -1;

            const entries = layer.renderCache.entries;

            for (const entry of entries) {
                this.core.renderStats.primitives++;

                // Culling
                if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledViewport++;
                    continue;
                }

                if (!this.core.passesLODCull(entry.screenSize, this.core.viewScale, this.core.lodThreshold)) {
                    this.core.renderStats.skippedPrimitives++;
                    this.core.renderStats.culledLOD++;
                    continue;
                }

                const prim = entry.primitive;
                if (this.options.primitiveFilter && !this.options.primitiveFilter(prim, layer.type)) {
                    this.core.renderStats.skippedPrimitives++;
                    continue;
                }

                this.core.renderStats.renderedPrimitives++;

                // Debug Collection
                if (this.shouldCollectDebug(prim)) {
                    this.debugPrimitives.push(prim);
                }

                // Draw Logic
                // Determine if it needs stroke or fill
                const isStroke = (prim.properties?.stroke && !prim.properties?.fill) || prim.properties?.isTrace;
                const width = prim.properties?.strokeWidth || 0;

                // Lazy Line Width Switching
                if (isStroke && width !== currentLineWidth) {
                    this.ctx.lineWidth = Math.max(width, minWidth);
                    currentLineWidth = width;
                }

                // --- DRAW ---
                // Use the primitive renderer's direct draw path helper. 
                // Note: This bypasses 'renderPrimitiveNormal' to avoid excessive function calls and context save/restores for simple shapes.

                // Special case: Complex shapes that need specific winding (Drills/Slots/Complex Paths)
                const role = prim.properties?.role;
                if (role === 'drill_hole' || role === 'drill_slot' || role === 'peck_mark') {
                    this.primitiveRenderer.renderPrimitive(prim, layerColor, layerColor, layer.isPreprocessed, { layer });
                    // Reset state after external call
                    this.ctx.fillStyle = layerColor;
                    this.ctx.strokeStyle = layerColor;
                    currentLineWidth = -1; 
                } 
                else {
                    // Standard Geometry
                    this.primitiveRenderer.drawPrimitivePath(prim);

                    if (isStroke) {
                        this.ctx.stroke();
                    } else {
                        // Default to fill
                        if (layer.isPreprocessed && prim.properties?.polarity === 'clear') {
                            this.ctx.fillStyle = this.core.colors.render2d.background;
                            this.ctx.fill('evenodd');
                            this.ctx.fillStyle = layerColor; // Restore
                        } else {
                            this.ctx.fill('evenodd');
                        }
                    }
                }
                
                this.core.renderStats.drawCalls++;
            }
        }

        // ========================================================================
        // Wireframe: Immediate Mode
        // ========================================================================

        renderWireframeMode() {
            const viewBounds = this.core.frameCache.viewBounds;

            // Set Wireframe State Once
            this.ctx.strokeStyle = this.core.colors.debug.wireframe;
            this.ctx.lineWidth = this.core.getWireframeStrokeWidth();
            this.ctx.fillStyle = 'transparent';
            this.ctx.setLineDash([]);

            this.layers.forEach(layer => {
                if (!layer.visible) return;

                const entries = layer.renderCache.entries;

                for (const entry of entries) {
                    this.core.renderStats.primitives++;

                    if (!this.core.boundsIntersect(entry.bounds, viewBounds)) {
                        this.core.renderStats.skippedPrimitives++;
                        continue;
                    }

                    const prim = entry.primitive;
                    if (this.options.primitiveFilter && !this.options.primitiveFilter(prim, layer.type)) {
                        this.core.renderStats.skippedPrimitives++;
                        continue;
                    }

                    this.core.renderStats.renderedPrimitives++;

                    // Direct Immediate Draw
                    this.primitiveRenderer.drawPrimitivePath(prim);
                    this.ctx.stroke();

                    if (this.shouldCollectDebug(prim)) {
                        this.debugPrimitives.push(prim);
                    }
                    this.core.renderStats.drawCalls++;
                }
            });
        }

        // ========================================================================
        // Debug Overlay
        // ========================================================================

        shouldCollectDebug(primitive) {
            if (!this.options.debugPoints && !this.options.debugArcs) return false;
            if (primitive.type === 'circle') return true;
            if (primitive.type === 'arc') return true;
            if (primitive.type === 'path' && primitive.contours?.length > 0) return true;
            return false;
        }

        // ========================================================================
        // Debug Overlay - World Space (same transform as geometry)
        // ========================================================================

        /**
         * Renders debug points and arcs in world space (same transform as geometry).
         *
         * Toggle cascade:
         *   debugPoints ─── shows all vertex dots (source + offset geometry)
         *     └─ enableArcReconstruction ON → hides points replaced by arcSegments/circles
         *   debugArcs ──── requires enableArcReconstruction ON
         *     └─ draws reconstructed arcSegments + full circles + arc center dots
         *
         * Batching: single beginPath/fill for all points, single beginPath/stroke for arcs.
         * Viewport culling: individual regenerated points are skipped if outside view bounds.
         */
        renderDebugOverlayWorld() {
            const fc = this.core.frameCache;
            const uiScale = this.core.devicePixelRatio || 1;
            const arcStrokeWidth = 2 * fc.invScale * uiScale;
            const hasReconstruction = this.options.enableArcReconstruction;
            const vb = fc.viewBounds;

            // POINTS
            if (this.options.debugPoints) {
                this.ctx.fillStyle = this.core.colors.debug.points;

                // Calculate scaling constants once per frame
                const pointRadius = 1.5 * fc.invScale * uiScale; 

                this.ctx.beginPath();

                for (const prim of this.debugPrimitives) {

                    // Handle Standalone Circles
                    if (prim.type === 'circle' && prim.center) {
                        if (hasReconstruction && prim.properties?.reconstructed) continue;

                        if (!hasReconstruction && prim.properties?.reconstructed) {
                            const segments = GeometryUtils.getOptimalSegments(prim.radius, 'circle');
                            const step = (2 * Math.PI) / segments;
                            for (let s = 0; s < segments; s++) {
                                const angle = s * step;
                                const px = prim.center.x + prim.radius * Math.cos(angle);
                                const py = prim.center.y + prim.radius * Math.sin(angle);

                                if (px < vb.minX || px > vb.maxX || py < vb.minY || py > vb.maxY) continue;

                                // Draw perfectly round dot
                                this.ctx.moveTo(px + pointRadius, py);
                                this.ctx.arc(px, py, pointRadius, 0, Math.PI * 2);
                            }
                            continue;
                        }

                        if (prim.center.x >= vb.minX && prim.center.x <= vb.maxX && 
                            prim.center.y >= vb.minY && prim.center.y <= vb.maxY) {
                            this.ctx.moveTo(prim.center.x + pointRadius, prim.center.y);
                            this.ctx.arc(prim.center.x, prim.center.y, pointRadius, 0, Math.PI * 2);
                        }
                        continue;
                    }

                    // Handle Paths and Offset Geometry
                    if (!prim.contours) continue;

                    for (const contour of prim.contours) {
                        if (!contour.points) continue;

                        const arcs = contour.arcSegments || [];
                        const hasArcs = arcs.length > 0;

                        // Draw existing points in memory
                        for (let i = 0; i < contour.points.length; i++) {
                            const p = contour.points[i];
                            if (p.x < vb.minX || p.x > vb.maxX || p.y < vb.minY || p.y > vb.maxY) continue;

                            this.ctx.moveTo(p.x + pointRadius, p.y);
                            this.ctx.arc(p.x, p.y, pointRadius, 0, Math.PI * 2);
                        }

                        // Regenerate missing points
                        if (!hasReconstruction && hasArcs) {
                            for (const arc of arcs) {
                                if (!arc.center || !arc.radius) continue;

                                let sweep = arc.sweepAngle;
                                if (sweep === undefined) {
                                    sweep = arc.endAngle - arc.startAngle;
                                    if (arc.clockwise && sweep > 0) sweep -= 2 * Math.PI;
                                    else if (!arc.clockwise && sweep < 0) sweep += 2 * Math.PI;
                                }

                                const fullCircleSegs = GeometryUtils.getOptimalSegments(arc.radius, 'arc');
                                const arcSegs = Math.max(2, Math.ceil(fullCircleSegs * Math.abs(sweep) / (2 * Math.PI)));

                                for (let s = 1; s < arcSegs; s++) {
                                    const t = s / arcSegs;
                                    const angle = arc.startAngle + sweep * t;
                                    const px = arc.center.x + arc.radius * Math.cos(angle);
                                    const py = arc.center.y + arc.radius * Math.sin(angle);

                                    if (px < vb.minX || px > vb.maxX || py < vb.minY || py > vb.maxY) continue;

                                    this.ctx.moveTo(px + pointRadius, py);
                                    this.ctx.arc(px, py, pointRadius, 0, Math.PI * 2);
                                }
                            }
                        }
                    }
                }
                
                // Send all points to GPU in a single call
                this.ctx.fill(); 
            }

            // ARCS
            if (this.options.debugArcs && hasReconstruction) {
                const arcColor = this.core.colors.debug.arcs;
                this.ctx.strokeStyle = arcColor;
                this.ctx.lineWidth = arcStrokeWidth;
                this.ctx.setLineDash([]);

                this.ctx.beginPath();
                for (const prim of this.debugPrimitives) {
                    if (!prim.contours) continue;
                    for (const contour of prim.contours) {
                        if (!contour.arcSegments) continue;
                        for (const arc of contour.arcSegments) {
                            if (!arc.center) continue;
                            this.ctx.moveTo(
                                arc.center.x + arc.radius * Math.cos(arc.startAngle),
                                arc.center.y + arc.radius * Math.sin(arc.startAngle)
                            );
                            if (arc.sweepAngle !== undefined) {
                                this.ctx.arc(
                                    arc.center.x, arc.center.y, arc.radius,
                                    arc.startAngle, arc.startAngle + arc.sweepAngle,
                                    arc.sweepAngle < 0
                                );
                            } else {
                                this.ctx.arc(
                                    arc.center.x, arc.center.y, arc.radius,
                                    arc.startAngle, arc.endAngle, arc.clockwise
                                );
                            }
                        }
                    }
                }
                this.ctx.stroke();

                // Full reconstructed circles
                this.ctx.beginPath();
                for (const prim of this.debugPrimitives) {
                    if (prim.type === 'circle' && prim.properties?.reconstructed) {
                        this.ctx.moveTo(prim.center.x + prim.radius, prim.center.y);
                        this.ctx.arc(prim.center.x, prim.center.y, prim.radius, 0, Math.PI * 2);
                    }
                }
                this.ctx.stroke();

                // Arc center dots
                this.ctx.fillStyle = arcColor;
                this.ctx.beginPath(); // Start batch for arc centers

                // Use the exact same radius calculation as the debug points
                const arcCenterRadius = 1.5 * fc.invScale * uiScale;

                for (const prim of this.debugPrimitives) {
                    if (!prim.contours) continue;
                    for (const contour of prim.contours) {
                        if (!contour.arcSegments) continue;
                        for (const arc of contour.arcSegments) {
                            if (!arc.center) continue;

                            // Draw perfectly round dot
                            this.ctx.moveTo(arc.center.x + arcCenterRadius, arc.center.y);
                            this.ctx.arc(arc.center.x, arc.center.y, arcCenterRadius, 0, Math.PI * 2);
                        }
                    }
                }

                this.ctx.fill();
            }
        }

        // ========================================================================
        // Utility Methods
        // ========================================================================

        getToolDiameterForPrimitive(primitive) {
            const opId = primitive.properties?.operationId;
            if (!opId || !this.appCore) return null;
            const operation = this.appCore.getOperation(opId);
            const diameterStr = operation?.settings?.toolDiameter;
            if (diameterStr === undefined) return null;
            const diameter = parseFloat(diameterStr);
            return isNaN(diameter) ? null : diameter;
        }

        destroy() {
            if (this.renderHandle) {
                cancelAnimationFrame(this.renderHandle);
            }
            if (this.core?._onThemeChange) {
                window.removeEventListener('themechange', this.core._onThemeChange);
                this.core._onThemeChange = null;
            }
        }
    }

    window.LayerRenderer = LayerRenderer;
})();