/*!
 * @file        renderer/renderer-core.js
 * @description Coordinates canvas, view and layer states
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
    const renderingOptions = D.rendering.defaultOptions;
    const canvasConfig = D.rendering.canvas;
    const debugState = D.debug;

    // Centralized Layer Naming
    window.LayerNaming = {
        // EasyTrace: one layer set per operation
        source: (opId) => `source_${opId}`,
        fused: (opId) => `fused_${opId}`,
        preprocessed: (opId) => `preprocessed_${opId}`,
        offsetCombined: (opId) => `offset_${opId}_combined`,
        offsetPass: (opId, passNumber) => `offset_${opId}_pass_${passNumber}`,
        preview: (opId) => `preview_${opId}`,

        // EasyShape: per-shape layers, per-op-type batches, per-bucket output
        shape: (shapeId) => `shape_${shapeId}`,
        batch: (opType) => `batch_${opType}`,
        bucketOffset: (bucketId) => `bucket_offset_${bucketId}`,
        bucketPreview: (bucketId) => `bucket_preview_${bucketId}`,

        // Shared
        stock: () => '__stock__'
    };

    class RendererCore {
        constructor(canvas, scene = null) {
            this.canvas = canvas;
            this.ctx = canvas.getContext('2d', { 
                alpha: C.renderer.context.alpha,
                desynchronized: C.renderer.context?.desynchronized
            });

            if (!this.ctx) {
                throw new Error('Could not get 2D context from canvas');
            }

            // View state
            this.viewOffset = { x: 0, y: 0 };
            this.viewScale = canvasConfig.defaultZoom;
            this.isDragging = false;
            this.lastMousePos = null;
            this.originIncludedInFit = false;

            // Scene reference for transform data
            // All origin/rotation/mirror state lives on scene.transform.
            // The getters below delegate to it. Renderer never caches.
            // REVIEW - Would it make sense for rendering to cache it some way or are there other caches at play now?
            this.scene = scene;

            // Bounds
            this.bounds = null;
            this.overallBounds = null;

            // Layers storage
            this.layers = new Map();

            // Device pixel ratio
            this.devicePixelRatio = 1;

            // Render options
            this.options = {
                showWireframe: renderingOptions.showWireframe,
                showGrid: renderingOptions.showGrid,
                showOrigin: renderingOptions.showOrigin,
                showBounds: renderingOptions.showBounds,
                showRulers: renderingOptions.showRulers,
                showPads: renderingOptions.showPads,
                showRegions: renderingOptions.showRegions,
                showTraces: renderingOptions.showTraces,
                showDrills: renderingOptions.showDrills,
                showCutouts: renderingOptions.showCutouts,
                fuseGeometry: renderingOptions.fuseGeometry,
                showOffsets: renderingOptions.showOffsets,
                showPreviews: renderingOptions.showPreviews,
                showPreprocessed: renderingOptions.showPreprocessed,
                enableArcReconstruction: renderingOptions.enableArcReconstruction,
                blackAndWhite: renderingOptions.blackAndWhite,
                debugPoints: renderingOptions.debugPoints,
                debugArcs: renderingOptions.debugArcs,
                theme: 'dark', // replaced by BaseAppUI.initRenderer
                showStats: renderingOptions.showStats,
                primitiveFilter: null
            };

            // LOD threshold (screen pixels)
            this.lodThreshold = C.renderer.lodThreshold ?? 0.5;

            // Color schemes
            // Geometry colors are managed by the UI via options.resolveLayerColor, 
            // but structural colors (canvas, grid, rulers) are handled here.
            this.colors = {};
            this.updateThemeColors();

            this._onThemeChange = () => {
                this.updateThemeColors();
                this.renderStats.lastSignificantChange = 'theme-changed';
            };
            window.addEventListener('themechange', this._onThemeChange);

            // Statistics
            this.renderStats = {
                lastRenderTime: 0,
                renderTime: 0,
                primitives: 0,
                renderedPrimitives: 0,
                skippedPrimitives: 0,
                culledViewport: 0,
                culledLOD: 0,
                drawCalls: 0,
                lastSignificantChange: null
            };

            // Frame cache for per-frame calculations
            this.frameCache = {
                invScale: 1,
                minWorldWidth: 1,
                viewBounds: null
            };

            this.rendererType = 'canvas2d';
            this.lastMouseCanvasPos = { x: 0, y: 0 };
        }

        updateThemeColors() {
            const rootStyle = getComputedStyle(document.documentElement);
            const read = (varName, fallback) => rootStyle.getPropertyValue(varName).trim() || fallback;

            // Custom-property names are kebab-case end to end: theme.css is
            // generated from dark.json by sync-theme.js, and ThemeLoader
            // kebab-cases the same keys. A camelCase name here reads empty and
            // silently pins the fallback.
            this.colors = {
                render2d: {
                    background: read('--color-render2d-background', '#0f0f0f'),
                    grid: read('--color-render2d-grid', '#aaaaaa'),
                    origin: read('--color-render2d-origin', '#aaaaaa'),
                    originOutline: read('--color-render2d-origin-outline', '#000000'),
                    bounds: read('--color-render2d-bounds', '#aaaaaa'),
                    ruler: read('--color-render2d-ruler', '#aaaaaa'),
                    rulerText: read('--color-render2d-ruler-text', '#aaaaaa')
                },
                primitives: {
                    offsetInternal: read('--color-primitive-offset-internal', '#00aa00'),
                    offsetExternal: read('--color-primitive-offset-external', '#ff0000'),
                    peckMarkGood: read('--color-primitive-peck-mark-good', '#16d329'),
                    peckMarkWarn: read('--color-primitive-peck-mark-warn', '#d2cb00'),
                    peckMarkError: read('--color-primitive-peck-mark-error', '#ff0000'),
                    peckMarkSlow: read('--color-primitive-peck-mark-slow', '#ff5e00'),
                    reconstructed: read('--color-primitive-reconstructed', '#00ffff'),
                    reconstructedPath: read('--color-primitive-reconstructed-path', '#ffff00')
                },
                // Consumed by renderer-layer (laser fills) and CanvasExporter.
                geometry: {
                    preview: read('--color-geometry-preview', '#0060dd'),
                    toolpath: read('--color-geometry-toolpath', '#00ffff'),
                    selection: read('--color-geometry-selection', '#00ffff'),
                    offset: {
                        external: read('--color-geometry-offset-external', '#a60000'),
                        internal: read('--color-geometry-offset-internal', '#00a600'),
                        on: read('--color-geometry-offset-on', '#bcbc02')
                    },
                    laser: {
                        filled: read('--color-geometry-laser-filled', '#0060dd')
                    }
                },
                // EasyTrace source-layer fills, read by CanvasExporter's <style>.
                source: {
                    isolation: read('--color-geometry-source-isolation', '#ff8844'),
                    drill: read('--color-geometry-source-drill', '#4488ff'),
                    clearing: read('--color-geometry-source-clearing', '#44ff88'),
                    cutout: read('--color-geometry-source-cutout', '#333333'),
                    stencil: read('--color-geometry-source-stencil', '#90177d'),
                    unassigned: read('--color-geometry-source-unassigned', '#228b9d')
                },
                bw: {
                    black: read('--color-bw-black', '#000000'),
                    white: read('--color-bw-white', '#ffffff')
                },
                debug: {
                    wireframe: read('--color-debug-wireframe', '#00aa00'),
                    points: read('--color-debug-points', '#ff00ff'),
                    arcs: read('--color-debug-arcs', '#00ffff'),
                    bounds: read('--color-debug-bounds', '#ff0000'),
                    preprocessedStroke: read('--color-debug-preprocessed-stroke', '#00ffff'),
                    preprocessedFill: read('--color-debug-preprocessed-fill', '#0a3333')
                }
            };
        }

        // ========================================================================
        // Layer Management
        // ========================================================================

        addLayer(name, primitives, options = {}) {
            const layer = {
                name: name,
                primitives: primitives,
                type: options.type,
                visible: options.visible,
                color: options.color,
                isFused: options.isFused,
                isPreprocessed: options.isPreprocessed,
                isOffset: options.type === 'offset',
                isPreview: options.type === 'preview',
                isHatch: options.isHatch,
                operationId: options.operationId,
                operationType: options.operationType,
                role: options.role || null,
                offsetType: options.offsetType,
                distance: options.distance,
                metadata: options.metadata,
                isStock: options.isStock || false,
                zIndex: options.zIndex ?? 0,
                bounds: options.bounds || this.calculateLayerBounds(primitives),
                transform: options.transform || null,
                renderCache: null
            };

            this.layers.set(name, layer);
            this.buildLayerBoundsCache(layer);
            this.calculateOverallBounds();
            this.renderStats.lastSignificantChange = 'layer-added';
        }

        /**
         * Builds lightweight bounds cache for culling
         * cache bounds for fast culling, but don't pay the Path2D allocation cost.
         */
        buildLayerBoundsCache(layer) {
            if (!layer.primitives || layer.primitives.length === 0) {
                layer.renderCache = { entries: [], bounds: null, valid: true };
                return;
            }

            const entries = [];
            // Cache global layer tool diameter if available
            const layerToolDia = layer.metadata?.toolDiameter || 0;

            // EasyShape layers carry a world transform. Extract its scale
            // magnitude so LOD culling reflects on-screen size, not local size.
            // A 0.5mm primitive on a layer scaled 100x is 50mm on screen and
            // must not be culled when zoomed out. EasyTrace layers have no
            // transform → scaleMag stays 1 (no behavior change).
            let scaleMag = 1;
            if (layer.transform) {
                const m = layer.transform;
                scaleMag = Math.max(
                    Math.hypot(m.a, m.b),
                    Math.hypot(m.c, m.d)
                ) || 1;
            }

            for (const prim of layer.primitives) {
                let bounds;
                try {
                    bounds = prim.getBounds();
                    if (!bounds || !Number.isFinite(bounds.minX)) continue;
                } catch (e) { continue; }

                let width = bounds.maxX - bounds.minX;
                let height = bounds.maxY - bounds.minY;

                const props = prim.properties || {};
                let inflation = 0;

                // Peck Marks & Centerline Slots (Critical Operational Data)
                // These contain crosshairs or drill hits that must remain visible even if the geometry itself is a tiny dot.
                if (props.role === 'peck_mark' || 
                    props.isToolPeckMark || 
                    props.isCenterlinePath || 
                    props.role === 'drill_milling_path') {

                    // Set to Infinity to effectively disable LOD culling for these items.
                    // They will still be culled by Viewport (off-screen), but never by size.
                    inflation = Infinity; 
                }
                // Previews & Thick Traces
                // If it's a tool preview, the visual size is Geometry + ToolDiameter
                else if (layer.isPreview || layer.type === 'preview') {
                    inflation = props.toolDiameter || layerToolDia || 0;
                }
                // Stroked Primitives (Standard)
                else if (props.stroke && props.strokeWidth) {
                    inflation = props.strokeWidth;
                }

                // Apply Inflation - If Infinity, screenSize becomes Infinity (always passes LOD)
                // Multiply the geometric span by the layer's scale magnitude so
                // LOD reflects true on-screen size. Inflation (tool diameter,
                // stroke width) is already in world units, so it is added AFTER
                // scaling the local span.
                const screenSize = (inflation === Infinity) 
                    ? Infinity 
                    : (Math.max(width, height) * scaleMag) + inflation;

                entries.push({
                    primitive: prim,
                    bounds: bounds, // Keep geometric bounds for Viewport Culling (accurate)
                    screenSize: screenSize // Use Inflated bounds for LOD Culling (visual)
                });
            }

            layer.renderCache = {
                entries: entries,
                bounds: layer.bounds,
                valid: true
            };
        }

        invalidateLayerCache(layerName) {
            const layer = this.layers.get(layerName);
            if (layer && layer.renderCache) {
                layer.renderCache.valid = false;
            }
        }

        rebuildLayerCache(layerName) {
            const layer = this.layers.get(layerName);
            if (layer) {
                this.buildLayerBoundsCache(layer);
            }
        }

        removeLayer(name) {
            this.layers.delete(name);
            this.calculateOverallBounds();
            this.renderStats.lastSignificantChange = 'layer-removed';
        }

        clearLayers() {
            this.layers.clear();
            this.overallBounds = null;
            this.bounds = null;
            this.originIncludedInFit = false;
            this.renderStats.lastSignificantChange = 'layers-cleared';
        }

        getVisibleLayers() {
            const visible = new Map();
            this.layers.forEach((layer, name) => {
                if (layer.visible) visible.set(name, layer);
            });
            return visible;
        }

        // ========================================================================
        // View Bounds & Culling Helpers
        // ========================================================================

        getViewBounds() {
            const corners = [
                this.canvasToWorld(0, 0),
                this.canvasToWorld(this.canvas.width, 0),
                this.canvasToWorld(this.canvas.width, this.canvas.height),
                this.canvasToWorld(0, this.canvas.height)
            ];

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            corners.forEach(c => {
                minX = Math.min(minX, c.x);
                minY = Math.min(minY, c.y);
                maxX = Math.max(maxX, c.x);
                maxY = Math.max(maxY, c.y);
            });

            return { minX, minY, maxX, maxY };
        }

        boundsIntersect(b1, b2) {
            return !(b2.minX > b1.maxX || 
                     b2.maxX < b1.minX || 
                     b2.minY > b1.maxY || 
                     b2.maxY < b1.minY);
        }

        /**
         * LOD culling check - rejects sub-pixel primitives.
         */
        passesLODCull(screenSize, viewScale, threshold) {
            const dpr = this.devicePixelRatio || 1;
            const screenSizeCSS = (screenSize * viewScale) / dpr;
            return screenSizeCSS >= threshold;
        }

        // ========================================================================
        // Coordinate Transforms
        // ========================================================================

        setupTransform() {
            this.ctx.save();
            this.ctx.translate(this.viewOffset.x, this.viewOffset.y);
            this.ctx.scale(this.viewScale, -this.viewScale);
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
        }

        resetTransform() {
            this.ctx.restore();
        }

        worldToCanvasX(worldX) {
            return this.viewOffset.x + worldX * this.viewScale;
        }

        worldToCanvasY(worldY) {
            return this.viewOffset.y - worldY * this.viewScale;
        }

        canvasToWorld(canvasX, canvasY) {
            return {
                x: (canvasX - this.viewOffset.x) / this.viewScale,
                y: -(canvasY - this.viewOffset.y) / this.viewScale
            };
        }

        worldToScreen(worldX, worldY) {
            return {
                x: this.worldToCanvasX(worldX),
                y: this.worldToCanvasY(worldY)
            };
        }

        // ========================================================================
        // Bounds Calculations
        // ========================================================================

        calculateLayerBounds(primitives) {
            if (!primitives || primitives.length === 0) {
                return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            let validCount = 0;

            primitives.forEach((primitive, index) => {
                try {
                    if (typeof primitive.getBounds !== 'function') return;
                    const bounds = primitive.getBounds();
                    if (!bounds || !Number.isFinite(bounds.minX)) return;

                    minX = Math.min(minX, bounds.minX);
                    minY = Math.min(minY, bounds.minY);
                    maxX = Math.max(maxX, bounds.maxX);
                    maxY = Math.max(maxY, bounds.maxY);
                    validCount++;
                } catch (error) {
                    this.debug(`[RendererCore] Primitive ${index} bounds failed:`, error);
                }
            });

            if (validCount === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            return { minX, minY, maxX, maxY };
        }

        calculateOverallBounds(ignoreStock = false) {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            let hasContent = false;

            this.layers.forEach((layer) => {
                if (!layer.primitives || layer.primitives.length === 0) return;
                if (!layer.visible) return;
                if (ignoreStock && layer.isStock) return;

                const b = layer.bounds;
                if (b) {
                    minX = Math.min(minX, b.minX);
                    minY = Math.min(minY, b.minY);
                    maxX = Math.max(maxX, b.maxX);
                    maxY = Math.max(maxY, b.maxY);
                    hasContent = true;
                }
            });

            if (hasContent && Number.isFinite(minX)) {
                this.overallBounds = {
                    minX, minY, maxX, maxY,
                    width: maxX - minX,
                    height: maxY - minY,
                    centerX: (minX + maxX) / 2,
                    centerY: (minY + maxY) / 2
                };
                this.bounds = this.overallBounds;
            } else {
                this.overallBounds = null;
                this.bounds = null;
            }
        }

        // ========================================================================
        // Zoom & Pan
        // ========================================================================

        zoomFit(includeOrigin = false) {
            // Force layout update synchronously before calculating zoom math
            this.resizeCanvas();

            const hasStock = Array.from(this.layers.values()).some(l => l.isStock && l.visible);
            
            // Always recalculate to ensure bounds aren't stale
            this.calculateOverallBounds(hasStock);

            if (!this.overallBounds) {
                // No content (only stock or empty) - restore full bounds so we
                // still frame the bed instead of showing nothing.
                if (hasStock) this.calculateOverallBounds(false);
                if (!this.overallBounds) {
                    const emptyConfig = C.renderer.emptyCanvas;
                    this.viewScale = emptyConfig.defaultScale;
                    const canvasX = this.canvas.width * emptyConfig.originMarginLeft;
                    const canvasY = this.canvas.height * (1 - emptyConfig.originMarginBottom);
                    this.viewOffset = { x: canvasX, y: canvasY };
                    return;
                }
            }

            // Use the standard tight padding unconditionally so it fills 
            // the viewport properly on the very first click.
            const fitPadding = C.renderer.zoom.fitPadding;

            let bounds = { ...this.overallBounds };

            // Transform bounds to visual space (forward workspace transform).
            if (this.scene) {
                const wm = this.scene.getWorkspaceMatrix();
                if (!TransformMath.isIdentity(wm)) {
                    bounds = TransformMath.transformBounds(wm, bounds);
                }
            }

            // Shift the effective canvas area inward by the ruler size so geometry isn't hidden behind them
            const rulerSize = this.options.showRulers
                ? D.rendering.canvas.rulerSize * (this.devicePixelRatio || 1)
                : 0;

            if (includeOrigin) {
                const origin = this.originPosition || { x: 0, y: 0 };
                bounds = {
                    minX: Math.min(bounds.minX, origin.x),
                    minY: Math.min(bounds.minY, origin.y),
                    maxX: Math.max(bounds.maxX, origin.x),
                    maxY: Math.max(bounds.maxY, origin.y)
                };
                bounds.width = bounds.maxX - bounds.minX;
                bounds.height = bounds.maxY - bounds.minY;
                bounds.centerX = (bounds.minX + bounds.maxX) / 2;
                bounds.centerY = (bounds.minY + bounds.maxY) / 2;

                // Track state for debugging/readout if needed, but don't use it to toggle padding
                this.originIncludedInFit = true;
            } else {
                this.originIncludedInFit = false;
            }

            // Recalculate derived values if not already set
            if (bounds.width === undefined) {
                bounds.width = bounds.maxX - bounds.minX;
                bounds.height = bounds.maxY - bounds.minY;
                bounds.centerX = (bounds.minX + bounds.maxX) / 2;
                bounds.centerY = (bounds.minY + bounds.maxY) / 2;
            }

            // Account for rulers
            const availableWidth = this.canvas.width - rulerSize;
            const availableHeight = this.canvas.height - rulerSize;
            const canvasAspect = availableWidth / availableHeight;
            const boundsAspect = bounds.width / bounds.height;

            let scale;
            if (boundsAspect > canvasAspect) {
                scale = availableWidth / (bounds.width * fitPadding);
            } else {
                scale = availableHeight / (bounds.height * fitPadding);
            }

            this.viewScale = Math.max(C.renderer.zoom.min,
                             Math.min(C.renderer.zoom.max, scale));
            this.viewOffset = {
                x: rulerSize + availableWidth / 2 - bounds.centerX * this.viewScale,
                y: rulerSize + availableHeight / 2 + bounds.centerY * this.viewScale
            };
        }

        zoomIn(factor = C.renderer.zoom.factor) {
            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            this.zoomToPoint(cx, cy, factor);
        }

        zoomOut(factor = C.renderer.zoom.factor) {
            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            this.zoomToPoint(cx, cy, 1 / factor);
        }

        zoomToPoint(canvasX, canvasY, factor) {
            const worldBefore = this.canvasToWorld(canvasX, canvasY);
            this.viewScale *= factor;
            this.viewScale = Math.max(C.renderer.zoom.min, 
                             Math.min(C.renderer.zoom.max, this.viewScale));
            this.viewOffset.x = canvasX - worldBefore.x * this.viewScale;
            this.viewOffset.y = canvasY + worldBefore.y * this.viewScale;
        }

        pan(dx, dy) {
            this.viewOffset.x += dx;
            this.viewOffset.y += dy;
        }

        // ========================================================================
        // Canvas Management
        // ========================================================================

        resizeCanvas() {
            const container = this.canvas.parentElement;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;

            const newWidth = rect.width * dpr;
            const newHeight = rect.height * dpr;

            // Keep geometry anchored to the center during CSS transitions/resizes
            if (this.canvas.width > 0 && this.canvas.height > 0 && this.viewOffset) {
                const dw = newWidth - this.canvas.width;
                const dh = newHeight - this.canvas.height;
                this.viewOffset.x += dw / 2;
                this.viewOffset.y += dh / 2;
            }

            this.canvas.width = newWidth;
            this.canvas.height = newHeight;
            this.canvas.style.width = rect.width + 'px';
            this.canvas.style.height = rect.height + 'px';

            this.devicePixelRatio = dpr;

            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';

            this.ctx.fillStyle = this.colors.render2d.background;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        clearCanvas() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.fillStyle = this.colors.render2d.background;
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        // ========================================================================
        // Rendering Utilities
        // ========================================================================

        getWireframeStrokeWidth() {
            const base = canvasConfig.wireframe.baseThickness;
            const min = canvasConfig.wireframe.minThickness;
            const max = canvasConfig.wireframe.maxThickness;
            const scaled = base / this.viewScale;
            const dpr = this.devicePixelRatio || 1;
            const minVisible = dpr / this.viewScale;
            return Math.max(min, Math.min(max, Math.max(scaled, minVisible)));
        }

        setOptions(options) {
            const oldOptions = { ...this.options };
            Object.assign(this.options, options);
            const changed = Object.keys(options).some(k => oldOptions[k] !== options[k]);
            if (changed) {
                this.renderStats.lastSignificantChange = options.theme ? 'theme-changed' : 'options-changed';
            }
        }

        setScene(scene) { this.scene = scene; }

        // ========================================================================
        // Origin, Rotation and Mirroring
        // ========================================================================
        // No more setX methods. Mutation happens on scene; the renderer
        // pulls the current values each frame via these getters. UI code
        // calls scene.setOrigin / setRotation / setMirrorX/Y and adds a
        // transform listener that calls renderer.render().

        get originPosition() {
            return this.scene ? this.scene.transform.origin : { x: 0, y: 0 };
        }
        get currentRotation() {
            return this.scene ? this.scene.transform.rotation : 0;
        }
        get rotationCenter() {
            return this.scene ? this.scene.transform.rotationCenter : { x: 0, y: 0 };
        }
        get mirrorX() {
            return this.scene ? this.scene.transform.mirrorX : false;
        }
        get mirrorY() {
            return this.scene ? this.scene.transform.mirrorY : false;
        }
        get mirrorCenter() {
            return this.scene ? this.scene.transform.mirrorCenter : { x: 0, y: 0 };
        }

        getOriginPosition() { return { ...this.originPosition }; }
        getMirrorState() {
            return {
                mirrorX: this.mirrorX,
                mirrorY: this.mirrorY,
                mirrorCenter: { ...this.mirrorCenter }
            };
        }

        // ========================================================================
        // View State
        // ========================================================================

        /**
         * View state is camera state only (pan + zoom). Rotation lives on
         * scene.transform; the old getViewState returned both but that
         * conflated "where am I looking" with "what is the workspace doing".
         */
        getViewState() {
            return {
                offset: { ...this.viewOffset },
                scale: this.viewScale,
                bounds: this.bounds ? { ...this.bounds } : null
            };
        }

        setViewState(state) {
            if (state.offset) this.viewOffset = { ...state.offset };
            if (state.scale !== undefined) this.viewScale = state.scale;
        }

        // ========================================================================
        // Rendering Timing
        // ========================================================================

        beginRender() {
            this.renderStats.primitives = 0;
            this.renderStats.renderedPrimitives = 0;
            this.renderStats.skippedPrimitives = 0;
            this.renderStats.culledViewport = 0;
            this.renderStats.culledLOD = 0;
            this.renderStats.drawCalls = 0;

            // Pre-calculate frame constants ONCE
            const dpr = this.devicePixelRatio || 1;
            this.frameCache.invScale = 1 / this.viewScale;
            this.frameCache.minWorldWidth = dpr / this.viewScale;

            // Get view bounds in screen-world space
            let viewBounds = this.getViewBounds();

            // Transform view bounds into source-geometry space (inverse of
            // the global workspace transform) so culling compares like-for-
            // like. Single matrix op replaces the mirror+rotation passes.
            if (this.scene) {
                const inv = this.scene.getWorkspaceInverse();
                if (!TransformMath.isIdentity(inv)) {
                    viewBounds = TransformMath.transformBounds(inv, viewBounds);
                }
            }

            this.frameCache.viewBounds = viewBounds;

            this.clearCanvas();
            return performance.now();
        }

        endRender(startTime) {
            const endTime = performance.now();
            this.renderStats.renderTime = endTime - startTime;
            this.renderStats.lastRenderTime = Date.now();

            if (this.renderStats.lastSignificantChange && debugState.enabled) {
                console.log(`[RendererCore] Rendered ${this.renderStats.renderedPrimitives} prims, ` +
                    `${this.renderStats.drawCalls} draws, ${this.renderStats.renderTime.toFixed(1)}ms ` +
                    `(${this.renderStats.lastSignificantChange})`);
                this.renderStats.lastSignificantChange = null;
            }
        }
    }

    window.RendererCore = RendererCore;
})();