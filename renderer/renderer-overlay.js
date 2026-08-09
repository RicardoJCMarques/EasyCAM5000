/*!
 * @file        renderer/renderer-overlay.js
 * @description Handles grid, rulers, origin, scale indicator, and other UI overlays
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
    const gridConfig = D.rendering.grid;
    const canvasConfig = D.rendering.canvas;
    const overlayConfig = C.renderer.overlay;
    const debugState = D.debug;

    class OverlayRenderer {
        constructor(core) {
            this.core = core;
            this.ctx = core.ctx;
            this.canvas = core.canvas;
        }

        // Grid

        renderGrid() {
            if (!this.core.options.showGrid) return;

            const colors = this.core.colors.render2d;
            if (!colors) return;

            const uiScale = this.core.devicePixelRatio || 1;
            const fc = this.core.frameCache;
            const step = this.calculateStepSize();
            if (step <= 0) return;

            const view = this.core.getViewBounds();
            const origin = this.core.getOriginPosition();

            this.ctx.save();
            this.ctx.strokeStyle = colors.grid;

            // Using fc.invScale makes it constant screen width regardless of zoom
            this.ctx.lineWidth = fc.invScale * (0.8 * uiScale); 

            this.ctx.setLineDash([]);
            this.ctx.globalAlpha = 0.15;

            this.ctx.beginPath();

            const startX = Math.floor((view.minX - origin.x) / step) * step + origin.x;
            for (let x = startX; x <= view.maxX; x += step) {
                this.ctx.moveTo(x, view.minY);
                this.ctx.lineTo(x, view.maxY);
            }

            const startY = Math.floor((view.minY - origin.y) / step) * step + origin.y;
            for (let y = startY; y <= view.maxY; y += step) {
                this.ctx.moveTo(view.minX, y);
                this.ctx.lineTo(view.maxX, y);
            }

            this.ctx.stroke();
            this.ctx.restore();
        }

        // Origin

        renderOrigin() {
            if (!this.core.options.showOrigin) return;

            const colors = this.core.colors.render2d;
            if (!colors) return;

            const fc = this.core.frameCache; 

            // Apply UI scaling to world-space overlay elements
            const uiScale = this.core.devicePixelRatio || 1;
            const scaleFactor = fc.invScale * uiScale;

            // Scale configuration values by the DPI factor
            const markerSize = (canvasConfig.originMarkerSize) * scaleFactor;
            const circleSize = (canvasConfig.originCircleSize) * scaleFactor;
            const strokeWidth = (overlayConfig.originStrokeWidth) * scaleFactor;
            const outlineWidth = (overlayConfig.originOutlineWidth) * scaleFactor;

            const originX = this.core.originPosition?.x || 0;
            const originY = this.core.originPosition?.y || 0;

            // Draw Outline (Contrast)
            this.ctx.strokeStyle = colors.originOutline;
            this.ctx.lineWidth = strokeWidth + outlineWidth;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';

            this.ctx.beginPath();
            this.ctx.moveTo(originX - markerSize, originY);
            this.ctx.lineTo(originX + markerSize, originY);
            this.ctx.moveTo(originX, originY - markerSize);
            this.ctx.lineTo(originX, originY + markerSize);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(originX, originY, circleSize, 0, 2 * Math.PI);
            this.ctx.stroke();

            // Draw Main Marker
            this.ctx.strokeStyle = colors.origin;
            this.ctx.lineWidth = strokeWidth;

            this.ctx.beginPath();
            this.ctx.moveTo(originX - markerSize, originY);
            this.ctx.lineTo(originX + markerSize, originY);
            this.ctx.moveTo(originX, originY - markerSize);
            this.ctx.lineTo(originX, originY + markerSize);
            this.ctx.stroke();

            this.ctx.beginPath();
            this.ctx.arc(originX, originY, circleSize, 0, 2 * Math.PI);
            this.ctx.stroke();

            this.ctx.fillStyle = colors.origin;
            this.ctx.fill();
        }

        // Bounds

        renderBounds() {
            if (!this.core.options.showBounds || !this.core.overallBounds) return;

            const colors = this.core.colors.render2d;
            if (!colors) return;

            const bounds = this.core.overallBounds;
            const fc = this.core.frameCache; 

            this.ctx.strokeStyle = colors.bounds;
            this.ctx.lineWidth = overlayConfig.boundsLineWidth * fc.invScale;

            const dash = overlayConfig.boundsDash;
            this.ctx.setLineDash([dash[0] * fc.invScale, dash[1] * fc.invScale]);

            this.ctx.strokeRect(
                bounds.minX,
                bounds.minY,
                bounds.width,
                bounds.height
            );

            // Corner markers
            const markerSize = overlayConfig.boundsMarkerSize * fc.invScale;
            this.ctx.setLineDash([]);
            this.ctx.lineWidth = overlayConfig.boundsMarkerWidth * fc.invScale;

            this.ctx.beginPath();
            // Top-Left
            this.ctx.moveTo(bounds.minX, bounds.minY + markerSize);
            this.ctx.lineTo(bounds.minX, bounds.minY);
            this.ctx.lineTo(bounds.minX + markerSize, bounds.minY);
            this.ctx.stroke();

            // Bottom-Right
            this.ctx.beginPath();
            this.ctx.moveTo(bounds.maxX - markerSize, bounds.maxY);
            this.ctx.lineTo(bounds.maxX, bounds.maxY);
            this.ctx.lineTo(bounds.maxX, bounds.maxY - markerSize);
            this.ctx.stroke();
        }

        // Rulers

        renderRulers() {
            if (!this.core.options.showRulers) return;

            // Use Core to reset transform (Screen Space)
            this.core.resetTransform();

            const colors = this.core.colors.render2d;
            if (!colors) return;

            // Setup Scaling & Font
            const uiScale = this.core.devicePixelRatio;

            // Scale config dimensions
            const rulerSize = (canvasConfig.rulerSize) * uiScale;
            const tickLen = (canvasConfig.rulerTickLength) * uiScale;

            // Setup Font
            const confFont = overlayConfig.rulerFont;
            const sizeMatch = confFont.match(/(\d+)px/);
            const baseFontSize = sizeMatch ? parseInt(sizeMatch[1]) : 11;
            const fontSize = baseFontSize * uiScale;

            this.ctx.font = `300 ${fontSize}px system-ui, -apple-system, sans-serif`;
            this.ctx.lineWidth = 1 * uiScale; 
            this.ctx.textBaseline = 'top';
            this.ctx.textAlign = 'center';

            // Draw Backgrounds & Borders
            // Hex-only concatenation broke on any non-hex palette value, and
            // the palette already carries rgba() for the scrims. Composition
            // alpha belongs on the context, not glued onto a colour string.
            // REVIEW - is this commentary necessary? Only stencil geometry fill has inherent transparancy.
            this.ctx.save();
            this.ctx.globalAlpha = parseInt(overlayConfig.rulerAlpha ?? 'CC', 16) / 255;
            this.ctx.fillStyle = colors.background;
            this.ctx.fillRect(0, 0, this.canvas.width, rulerSize);
            this.ctx.fillRect(0, 0, rulerSize, this.canvas.height);
            this.ctx.restore();

            // Setup Lines
            this.ctx.strokeStyle = colors.ruler;
            this.ctx.fillStyle = colors.rulerText;
            this.ctx.beginPath();
            // Horizontal border
            this.ctx.moveTo(rulerSize, rulerSize);
            this.ctx.lineTo(this.canvas.width, rulerSize);
            // Vertical border
            this.ctx.moveTo(rulerSize, rulerSize);
            this.ctx.lineTo(rulerSize, this.canvas.height);
            this.ctx.stroke();

            // Calculate Layout
            const stepWorld = this.calculateStepSize();
            const view = this.core.getViewBounds();
            const origin = this.core.getOriginPosition();

            // How many pixels between ticks?
            const stepPixels = stepWorld * this.core.viewScale;

            // If ticks are closer than 60px, skipping 1 (stride 2) ensures at least 80-120px of space.
            const safeLabelSpace = 60 * uiScale; 
            const stride = (stepPixels < safeLabelSpace) ? 2 : 1;

            // HORIZONTAL RULER
            const startX = Math.floor(view.minX / stepWorld) * stepWorld;

            this.ctx.beginPath();
            if (stepWorld > 0) {
                for (let wx = startX; wx < view.maxX; wx += stepWorld) {
                    const cx = this.core.worldToCanvasX(wx);

                    if (cx < rulerSize || cx > this.canvas.width) continue;

                    // Draw Tick (Always)
                    this.ctx.moveTo(cx, rulerSize);
                    this.ctx.lineTo(cx, rulerSize - tickLen);

                    // Draw Label (Conditional)
                    const tickIndex = Math.round(wx / stepWorld);

                    if (tickIndex % stride === 0) {
                        const labelVal = wx - origin.x;
                        const label = Math.abs(labelVal) < C.precision.coordinate ? "0" :
                                    (stepWorld < 1 ? labelVal.toFixed(3).replace(/0+$/, '') : 
                                    stepWorld < 10 ? labelVal.toFixed(1).replace(/\.0$/, '') : 
                                    labelVal.toFixed(0));

                        this.ctx.fillText(label, cx, 3 * uiScale);
                    }
                }
            }
            this.ctx.stroke();

            // VERTICAL RULER
            const startY = Math.floor(view.minY / stepWorld) * stepWorld;

            this.ctx.beginPath();

            // Vertical Text Setup
            this.ctx.textAlign = 'right';
            this.ctx.textBaseline = 'middle';

            if (stepWorld > 0) {
                for (let wy = startY; wy < view.maxY; wy += stepWorld) {
                    const cy = this.core.worldToCanvasY(wy);

                    if (cy < rulerSize || cy > this.canvas.height) continue;

                    this.ctx.moveTo(rulerSize, cy);
                    this.ctx.lineTo(rulerSize - tickLen, cy);

                    const tickIndex = Math.round(wy / stepWorld);

                    if (tickIndex % stride === 0) {
                        const labelVal = wy - origin.y;
                        const label = Math.abs(labelVal) < 0.0001 ? "0" : 
                                    (stepWorld < 1 ? labelVal.toFixed(3).replace(/0+$/, '') : 
                                    stepWorld < 10 ? labelVal.toFixed(1).replace(/\.0$/, '') : 
                                    labelVal.toFixed(0));

                        this.ctx.fillText(label, rulerSize - tickLen - (3 * uiScale), cy);
                    }
                }
            }
            this.ctx.stroke();

            // Corner Box & Unit
            this.ctx.fillStyle = colors.background;
            this.ctx.fillRect(0, 0, rulerSize, rulerSize);
            this.ctx.strokeRect(0, 0, rulerSize, rulerSize);

            // Unit Label
            this.ctx.fillStyle = colors.rulerText;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';

            // Parse the corner font settings too if present, or scale default
            const cornerFont = overlayConfig.rulerCornerFont || '9px Arial';
            const cornerMatch = cornerFont.match(/(\d+)px/);
            const cornerSize = (cornerMatch ? parseInt(cornerMatch[1]) : 9) * uiScale;

            this.ctx.font = `${cornerSize}px system-ui, sans-serif`;

            const unitText = overlayConfig.rulerCornerText || 'mm';
            this.ctx.fillText(unitText, rulerSize/2, rulerSize/2);
        }

        // Scale Indicator

        renderScaleIndicator() {
            if (!this.core.options.showRulers) return;

            this.ctx.save();
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);

            const colors = this.core.colors.render2d;
            if (!colors) {
                this.ctx.restore();
                return;
            }

            const uiScale = this.core.devicePixelRatio || 1;

            // Dimensions
            const padding = (overlayConfig.scaleIndicatorPadding || 10) * uiScale;
            const barHeight = 2 * uiScale; 
            const capHeight = 8 * uiScale; 
            const capWidth = 1 * uiScale; 

            const yOffset = (overlayConfig.scaleIndicatorYOffset || 25) * uiScale;
            const minPixels = (overlayConfig.scaleIndicatorMinPixels || 100) * uiScale;

            const y = this.canvas.height - padding - yOffset;

            // Calculate length
            const possibleLengths = gridConfig.steps;
            const niceLength = possibleLengths.find(len => len * this.core.viewScale >= minPixels);
            
            if (!niceLength) {
                this.ctx.restore();
                return;
            }

            const barWidth = niceLength * this.core.viewScale;
            const x = this.canvas.width - padding - barWidth;

            // Center Y of the bar
            const centerY = y + (barHeight / 2);
            // Top Y of the end caps
            const capTop = centerY - (capHeight / 2);
            
            // Halo thickness (matches the text outline roughly)
            const halo = 2 * uiScale;

            // --- Render Helper ---
            // Define a function to draw the shape so it can be called twice expansion: how much to inflate the shape (0 for foreground, >0 for halo)
            const drawScaleBar = (expansion) => {
                // Horizontal Bar
                this.ctx.fillRect(
                    x - expansion, 
                    y - expansion, 
                    barWidth + (expansion * 2), 
                    barHeight + (expansion * 2)
                );

                // Left Cap
                this.ctx.fillRect(
                    x - expansion, 
                    capTop - expansion, 
                    capWidth + (expansion * 2), 
                    capHeight + (expansion * 2)
                );

                // Right Cap
                this.ctx.fillRect(
                    x + barWidth - capWidth - expansion, 
                    capTop - expansion, 
                    capWidth + (expansion * 2), 
                    capHeight + (expansion * 2)
                );
            };

            // Draw Bar Halo
            this.ctx.fillStyle = colors.background;
            drawScaleBar(halo);

            // Draw Bar Foreground
            this.ctx.fillStyle = colors.rulerText;
            drawScaleBar(0);

            // Draw Label with Halo
            const fontSize = 10 * uiScale;
            this.ctx.font = `300 ${fontSize}px system-ui, -apple-system, sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'bottom';

            let label;
            if (niceLength < 0.01) {
                label = `${(niceLength * 1000).toFixed(0)}μm`;
            } else if (niceLength < 1) {
                label = `${niceLength.toFixed(2)}mm`;
            } else if (niceLength >= 1000) {
                label = `${(niceLength / 1000).toFixed(2)}m`;
            } else {
                label = `${niceLength}mm`;
            }

            const textX = x + barWidth / 2;
            const textY = capTop - (2 * uiScale);

            // Text Halo
            this.ctx.lineJoin = 'round';
            this.ctx.lineWidth = 3 * uiScale; 
            this.ctx.strokeStyle = colors.background; 
            this.ctx.strokeText(label, textX, textY);

            // Text Fill
            this.ctx.fillStyle = colors.rulerText;
            this.ctx.fillText(label, textX, textY);

            this.ctx.restore();
        }

        // Statistics

        renderStats() {
            if (!this.core.options.showStats || !this.core.renderStats) return;

            this.ctx.save();
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);

            const colors = this.core.colors.render2d;
            if (!colors) {
                this.ctx.restore();
                return;
            }

            const stats = this.core.renderStats;

            const x = overlayConfig.statsX;
            let y = overlayConfig.statsY;
            const lineHeight = overlayConfig.statsLineHeight;

            // Calculate background size
            const lines = [];
            lines.push(`Primitives: ${stats.renderedPrimitives}/${stats.primitives}`);
            if (stats.skippedPrimitives > 0) {
                lines.push(`Culled: ${stats.skippedPrimitives}`);
            }
            if (stats.drawCalls !== undefined && stats.drawCalls > 0) {
                lines.push(`Draw calls: ${stats.drawCalls}`);
            }
            lines.push(`Render: ${stats.renderTime.toFixed(1)}ms`);
            lines.push(`Zoom: ${this.core.viewScale.toFixed(2)}x`);

            const bgHeight = lines.length * lineHeight + 10;

            // Background
            this.ctx.fillStyle = colors.background;
            this.ctx.fillRect(x - 5, y - 15, overlayConfig.statsBGWidth, bgHeight);

            // Text
            this.ctx.fillStyle = colors.rulerText;
            this.ctx.font = overlayConfig.statsFont || '12px monospace';
            this.ctx.textAlign = 'left';
            this.ctx.textBaseline = 'top';

            lines.forEach(line => {
                this.ctx.fillText(line, x, y);
                y += lineHeight;
            });

            this.ctx.restore();
        }

        // Helper Methods

        calculateStepSize() {
            const minPixelSize = gridConfig.minPixelSpacing;
            const possibleSteps = gridConfig.steps;

            for (const step of possibleSteps) {
                if (step * this.core.viewScale >= minPixelSize) {
                    return step;
                }
            }
            return possibleSteps[possibleSteps.length - 1];
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[OverlayRenderer] ${message}`, data)
                 : console.log(`[OverlayRenderer] ${message}`);
        }
    }

    window.OverlayRenderer = OverlayRenderer;
})();