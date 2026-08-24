/*!
 * @file        renderer/renderer-primitives.js
 * @description Dedicated geometry object definitions
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
    const primitivesConfig = C.renderer.primitives;
    const debugState = D.debug;

    class PrimitiveRenderer {
        constructor(core) {
            this.core = core;
            this.ctx = core.ctx;

            // Cache config values
            const pc = primitivesConfig;
            this.cfg = {
                stroke: {
                    offset: pc.offsetStrokeWidth,
                    centerMark: pc.centerMarkStrokeWidth,
                    sourceDrill: pc.sourceDrillStrokeWidth,
                    peckMark: pc.peckMarkStrokeWidth,
                    reconstructed: pc.reconstructedStrokeWidth,
                    debugArc: pc.debugArcStrokeWidth,
                    debugContour: pc.debugContourStrokeWidth,
                    debugLabel: pc.debugLabelLineWidth
                },
                mark: {
                    drillSize: pc.sourceDrillMarkSize,
                    drillRatio: pc.sourceDrillMarkRatio,
                    peckSize: pc.peckMarkMarkSize,
                    peckRatio: pc.peckMarkMarkRatio
                },
                peck: {
                    dash: pc.peckMarkDash,
                    ringFactor: pc.peckMarkRingFactor
                },
                reconstructed: {
                    centerSize: pc.reconstructedCenterSize,
                    pathDash: pc.reconstructedPathDash
                },
                debug: {
                    pointSize: pc.debugPointSize,
                    font: pc.debugFont,
                    arcCenterSize: pc.debugArcCenterSize,
                    contourDash: pc.debugContourDash
                }
            };

            this.debugStats = {
                totalPoints: 0,
                taggedPoints: 0,
                curvePoints: new Map()
            };
        }

        // ========================================================================
        // Main Dispatcher
        // ========================================================================

        renderPrimitive(primitive, fillColor, strokeColor, isPreprocessed = false, context = {}) {
            const role = primitive.properties?.role;

            if (role) {
                switch (role) {
                    case 'drill_hole':
                    case 'drill_slot':
                        this.renderSourceDrill(primitive, strokeColor);
                        return;
                    case 'peck_mark':
                        this.renderPeckMark(primitive, context);
                        return;
                    case 'drill_milling_path':
                        this.renderOffsetPrimitive(primitive, strokeColor || fillColor, context);
                        return;
                }
            }

            const layer = context.layer || {};

            if (layer.isPreview) {
                this.renderToolPreview(primitive, fillColor || strokeColor, context);
                return;
            }

            if (layer.isOffset) {
                this.renderOffsetPrimitive(primitive, strokeColor || fillColor, context);
                return;
            }

            if (primitive.properties?.reconstructed) {
                this.renderReconstructedPrimitive(primitive, fillColor);
                return;
            }

            if (this.core.options.showWireframe) {
                this.renderWireframe(primitive);
                return;
            }

            this.renderPrimitiveNormal(primitive, fillColor, strokeColor, isPreprocessed);
        }

        /**
         * Main offset renderer - uses immediate mode for speed.
         */
        renderOffsetPrimitive(primitive, color, context) {
            if (primitive.properties?.isToolPeckMark || primitive.properties?.role === 'peck_mark') {
                this.renderPeckMark(primitive, context);
                return;
            }

            // Use pre-calculated values from frame cache
            const fc = this.core.frameCache;
            const lineWidth = Math.max(this.cfg.stroke.offset * fc.invScale, fc.minWorldWidth);
            const markSize = this.cfg.mark.drillSize;

            // 3D toolpath chains (V-Carve / Relief): packed xyz triplets.
            // The 2D preview strokes the XY projection only; depth
            // visualization is renderer3d territory.
            if (primitive.type === 'path3d') {
                const pos = primitive.positions;
                if (!pos || pos.length < 6) return;
                this.ctx.strokeStyle = color;
                this.ctx.lineWidth = lineWidth;
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';
                this.ctx.setLineDash([]);
                this.ctx.beginPath();
                this.ctx.moveTo(pos[0], pos[1]);
                for (let i = 3; i < pos.length; i += 3) {
                    this.ctx.lineTo(pos[i], pos[i + 1]);
                }
                this.ctx.stroke();
                return;
            }

            // Centerline Slot Path
            if (primitive.properties?.isCenterlinePath) {
                const pts = primitive.contours[0].points;
                const start = pts[0];
                const end = pts[pts.length - 1];
                const toolDiameter = context.toolDiameter || primitive.properties.toolDiameter;
                const radius = toolDiameter / 2;

                const toolRelation = primitive.properties.toolRelation || 'exact';
                const lineColor = this.getStatusColor(toolRelation, color);

                this.ctx.strokeStyle = lineColor;
                this.ctx.lineWidth = lineWidth;
                this.ctx.setLineDash([]);

                // Draw perimeter
                this.ctx.beginPath();
                const dx = end.x - start.x;
                const dy = end.y - start.y;
                const angle = Math.atan2(dy, dx);
                this.ctx.arc(end.x, end.y, radius, angle - Math.PI/2, angle + Math.PI/2, false);
                this.ctx.arc(start.x, start.y, radius, angle + Math.PI/2, angle - Math.PI/2, false);
                this.ctx.closePath();
                this.ctx.stroke();

                // Center line
                this.ctx.beginPath();
                this.ctx.moveTo(start.x, start.y);
                this.ctx.lineTo(end.x, end.y);
                this.ctx.stroke();

                // Crosshairs
                this.renderCenterMarks(start, markSize, lineColor);
                this.renderCenterMarks(end, markSize, lineColor);
                return;
            }

            // Undersized Milling Path
            if (primitive.properties?.role === 'drill_milling_path') {
                const toolRelation = primitive.properties.toolRelation || 'exact';
                const statusColor = this.getStatusColor(toolRelation, color);

                this.ctx.strokeStyle = statusColor;
                this.ctx.lineWidth = lineWidth;
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';
                this.ctx.setLineDash([]);

                this.drawPrimitivePath(primitive);
                this.ctx.stroke();

                if (primitive.properties?.originalSlot) {
                    const slot = primitive.properties.originalSlot;
                    this.renderCenterMarks(slot.start, markSize, statusColor);
                    this.renderCenterMarks(slot.end, markSize, statusColor);
                } else if (primitive.center) {
                    this.renderCenterMarks(primitive.center, markSize, statusColor);
                }
                return;
            }

            // Standard Offsets
            const offsetDistance = context.distance || primitive.properties?.offsetDistance || 0;
            const isInternal = offsetDistance < 0;
            const primColors = this.core.colors.primitives;

            const strokeColor = isInternal ? primColors.offsetInternal : (color || primColors.offsetExternal);

            this.ctx.strokeStyle = strokeColor;
            this.ctx.lineWidth = lineWidth;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.setLineDash([]);

            this.drawPrimitivePath(primitive);
            this.ctx.stroke();

            if (primitive.properties?.originalSlot) {
                const slot = primitive.properties.originalSlot;
                this.renderCenterMarks(slot.start, markSize, strokeColor);
                this.renderCenterMarks(slot.end, markSize, strokeColor);
            }
        }

        renderToolPreview(primitive, color, context) {
            this.ctx.save();

            if (primitive.properties?.role === 'peck_mark') {
                this.renderPeckMark(primitive, context);
                this.ctx.restore();
                return;
            }

            if (primitive.properties?.isCenterlinePath) {
                this.renderCenterlineSlot(primitive, context);
                this.ctx.restore();
                return;
            }

            const toolDiameter = context.toolDiameter || 
                                context.layer?.metadata?.toolDiameter || 
                                primitive.properties?.toolDiameter;

            const fc = this.core.frameCache;
            const lineWidth = Math.max(toolDiameter, fc.minWorldWidth);

            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = lineWidth;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.setLineDash([]);

            this.drawPrimitivePath(primitive);
            this.ctx.stroke();

            // Yellow center marks for undersized drill ops
            if (primitive.properties?.toolRelation === 'undersized') {
                const warnColor = this.core.colors.primitives.peckMarkWarn;
                const markSize = this.cfg.mark.drillSize;

                if (primitive.properties?.originalSlot) {
                    const slot = primitive.properties.originalSlot;
                    this.renderCenterMarks(slot.start, markSize, warnColor);
                    this.renderCenterMarks(slot.end, markSize, warnColor);
                } else if (primitive.center) {
                    this.renderCenterMarks(primitive.center, markSize, warnColor);
                }
            }

            this.ctx.restore();
        }

        renderSourceDrill(primitive, color) {
            const fc = this.core.frameCache;
            const strokeWidth = Math.max(this.cfg.stroke.sourceDrill * fc.invScale, fc.minWorldWidth);

            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = strokeWidth;

            if (primitive.properties.role === 'drill_hole') {
                const r = primitive.radius;
                this.ctx.beginPath();
                this.ctx.arc(primitive.center.x, primitive.center.y, r, 0, Math.PI * 2);
                this.ctx.stroke();

                const markRatio = this.cfg.mark.drillRatio;
                const maxMarkSize = this.cfg.mark.drillSize;
                const markSize = Math.min(maxMarkSize, r * markRatio);
                this.renderCenterMarks(primitive.center, markSize, color);

            } else if (primitive.properties.role === 'drill_slot') {
                const slot = primitive.properties.originalSlot;
                if (!slot) return;

                const diameter = primitive.properties.diameter;
                const radius = diameter / 2;

                const dx = slot.end.x - slot.start.x;
                const dy = slot.end.y - slot.start.y;
                const angle = Math.atan2(dy, dx);

                this.ctx.beginPath();
                this.ctx.arc(slot.end.x, slot.end.y, radius, angle - Math.PI/2, angle + Math.PI/2, false);
                this.ctx.arc(slot.start.x, slot.start.y, radius, angle + Math.PI/2, angle - Math.PI/2, false);
                this.ctx.closePath();
                this.ctx.stroke();

                const markRatio = this.cfg.mark.drillRatio;
                const maxMarkSize = this.cfg.mark.drillSize;
                const markSize = Math.min(maxMarkSize, radius * markRatio);
                this.renderCenterMarks(slot.start, markSize, color);
                this.renderCenterMarks(slot.end, markSize, color);
            }
        }

        renderPeckMark(primitive, context) {
            const center = primitive.center;
            const radius = primitive.radius;
            const toolRelation = primitive.properties?.toolRelation || 'exact';
            const reducedPlunge = primitive.properties?.reducedPlunge;
            const isPreview = context.layer?.isPreview;

            const baseColor = this.getStatusColor(toolRelation, this.core.colors.primitives.peckMarkGood);
            const fc = this.core.frameCache;
            const strokeWidth = Math.max(this.cfg.stroke.peckMark * fc.invScale, fc.minWorldWidth);

            if (isPreview) {
                this.ctx.save();
                this.ctx.globalAlpha = 1.0;

                this.ctx.fillStyle = baseColor;
                this.ctx.beginPath();
                this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
                this.ctx.fill();

                this.ctx.strokeStyle = baseColor;
                this.ctx.lineWidth = strokeWidth;
                this.ctx.stroke();

                const markSize = Math.min(0.5, radius * 0.4);
                this.renderCenterMarks(center, markSize, this.core.colors.bw.white);

                if (reducedPlunge) {
                    this.ctx.strokeStyle = this.core.colors.primitives.peckMarkSlow;
                    this.ctx.lineWidth = strokeWidth;
                    this.ctx.setLineDash(this.cfg.peck.dash);
                    this.ctx.beginPath();
                    this.ctx.arc(center.x, center.y, radius * this.cfg.peck.ringFactor, 0, Math.PI * 2);
                    this.ctx.stroke();
                }
                this.ctx.restore();
                return;
            }

            // Offset/Wireframe mode
            this.ctx.save();
            this.ctx.strokeStyle = baseColor;
            this.ctx.lineWidth = strokeWidth;

            this.ctx.beginPath();
            this.ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
            this.ctx.stroke();

            const markRatio = this.cfg.mark.peckRatio;
            const maxMarkSize = this.cfg.mark.peckSize;
            const markSize = Math.min(maxMarkSize, radius * markRatio);
            this.renderCenterMarks(center, markSize, baseColor);

            if (reducedPlunge) {
                this.ctx.strokeStyle = this.core.colors.primitives.peckMarkSlow;
                this.ctx.setLineDash(this.cfg.peck.dash);
                this.ctx.beginPath();
                this.ctx.arc(center.x, center.y, radius * this.cfg.peck.ringFactor, 0, Math.PI * 2);
                this.ctx.stroke();
            }
            this.ctx.restore();
        }

        renderCenterlineSlot(primitive, context) {
            const pts = primitive.contours[0].points;
            const p1 = pts[0];
            const p2 = pts[1];
            const toolDiameter = context.toolDiameter || primitive.properties.toolDiameter;
            const radius = toolDiameter / 2;

            const toolRelation = primitive.properties.toolRelation || 'exact';
            const baseColor = this.getStatusColor(toolRelation, this.core.colors.primitives.peckMarkGood);

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const angle = Math.atan2(dy, dx);

            this.ctx.beginPath();
            this.ctx.arc(p2.x, p2.y, radius, angle - Math.PI/2, angle + Math.PI/2, false);
            this.ctx.arc(p1.x, p1.y, radius, angle + Math.PI/2, angle - Math.PI/2, false);
            this.ctx.closePath();

            this.ctx.save();
            this.ctx.globalAlpha = 1.0;
            this.ctx.fillStyle = baseColor;
            this.ctx.fill();

            const fc = this.core.frameCache;
            const strokeWidth = Math.max(this.cfg.stroke.peckMark * fc.invScale, fc.minWorldWidth);
            this.ctx.lineWidth = strokeWidth;
            this.ctx.strokeStyle = baseColor;
            this.ctx.stroke();

            const markSize = Math.min(0.5, radius * 0.5);
            this.renderCenterMarks(p1, markSize, this.core.colors.bw.white);
            this.renderCenterMarks(p2, markSize, this.core.colors.bw.white);

            this.ctx.beginPath();
            this.ctx.moveTo(p1.x, p1.y);
            this.ctx.lineTo(p2.x, p2.y);
            this.ctx.strokeStyle = this.core.colors.bw.white;
            this.ctx.lineWidth = strokeWidth;
            this.ctx.stroke();

            this.ctx.restore();
        }

        // ========================================================================
        // Helper Methods
        // ========================================================================

        getStatusColor(toolRelation, defaultColor) {
            const primColors = this.core.colors.primitives;
            return window.resolveToolRelationColor(toolRelation, {
                error: primColors.peckMarkError,
                warn: primColors.peckMarkWarn,
                good: primColors.peckMarkGood
            }, defaultColor);
        }

        renderCenterMarks(center, markSize, color) {
            const fc = this.core.frameCache;
            const lineWidth = Math.max(this.cfg.stroke.centerMark * fc.invScale, fc.minWorldWidth);

            this.ctx.save();
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = lineWidth;
            this.ctx.beginPath();
            this.ctx.moveTo(center.x - markSize, center.y);
            this.ctx.lineTo(center.x + markSize, center.y);
            this.ctx.moveTo(center.x, center.y - markSize);
            this.ctx.lineTo(center.x, center.y + markSize);
            this.ctx.stroke();
            this.ctx.restore();
        }

        /**
         * Lazily builds and caches a Path2D for a primitive in its LOCAL frame.
         * Primitives are immutable once built, so the cache never needs
         * invalidation. Callers apply any world transform on the ctx before
         * fill/stroke. Used by selection highlighting to avoid re-walking
         * contours into the canvas path on every pan/zoom frame.
         */
        getPath2D(primitive) {
            if (primitive._path2DCache) return primitive._path2DCache;
            const path = new Path2D();
            const P = primitive;

            if (P.type === 'path') {
                if (P.contours) {
                    for (const contour of P.contours) {
                        if (!contour.points || contour.points.length === 0) continue;
                        const arcs = (contour.arcSegments || []).slice().sort((a, b) => a.startIndex - b.startIndex);
                        if (arcs.length > 0) {
                            let idx = 0;
                            path.moveTo(contour.points[0].x, contour.points[0].y);
                            for (const arc of arcs) {
                                for (let i = idx + 1; i <= arc.startIndex; i++) path.lineTo(contour.points[i].x, contour.points[i].y);
                                if (arc.sweepAngle !== undefined) {
                                    path.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.startAngle + arc.sweepAngle, arc.sweepAngle < 0);
                                } else {
                                    path.arc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, arc.clockwise);
                                }
                                idx = arc.endIndex;
                            }
                            if (idx !== 0 || arcs.length === 0) {
                                for (let i = idx + 1; i < contour.points.length; i++) path.lineTo(contour.points[i].x, contour.points[i].y);
                            }
                        } else {
                            contour.points.forEach((p, i) => i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y));
                        }
                        if (P.closed !== false) path.closePath();
                    }
                }
            } else if (P.type === 'circle') {
                path.arc(P.center.x, P.center.y, P.radius, 0, Math.PI * 2);
                path.closePath();
            } else if (P.type === 'rectangle') {
                path.rect(P.position.x, P.position.y, P.width, P.height);
            } else if (P.type === 'arc') {
                path.arc(P.center.x, P.center.y, P.radius, P.startAngle, P.endAngle, P.clockwise);
            } else if (P.type === 'obround') {
                // Highlight ignores obround rotation (rare for shapes); the main
                // renderer still honors it. Good enough for a selection glow.
                const x = P.position.x, y = P.position.y, w = P.width, h = P.height, r = Math.min(w, h) / 2;
                if (w > h) {
                    path.moveTo(x + r, y);
                    path.lineTo(x + w - r, y);
                    path.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
                    path.lineTo(x + r, y + h);
                    path.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
                } else {
                    path.moveTo(x + w, y + r);
                    path.lineTo(x + w, y + h - r);
                    path.arc(x + r, y + h - r, r, 0, Math.PI);
                    path.lineTo(x, y + r);
                    path.arc(x + r, y + r, r, Math.PI, 0);
                }
                path.closePath();
            }

            primitive._path2DCache = path;
            return path;
        }

        drawPrimitivePath(primitive) {
            this.ctx.beginPath();

            // Packed 3D chains: build the XY projection path.
            if (primitive.type === 'path3d') {
                const pos = primitive.positions || [];
                if (pos.length >= 6) {
                    this.ctx.moveTo(pos[0], pos[1]);
                    for (let i = 3; i < pos.length; i += 3) {
                        this.ctx.lineTo(pos[i], pos[i + 1]);
                    }
                }
                return;
            }

            if (primitive.type === 'path') {
                if (primitive.contours && primitive.contours.length > 0) {
                    for (const contour of primitive.contours) {
                        if (!contour.points || contour.points.length === 0) continue;

                        if (contour.arcSegments && contour.arcSegments.length > 0) {
                            const sortedArcs = contour.arcSegments.slice().sort((a, b) => a.startIndex - b.startIndex);
                            let currentIndex = 0;
                            this.ctx.moveTo(contour.points[0].x, contour.points[0].y);

                            for (const arc of sortedArcs) {
                                for (let i = currentIndex + 1; i <= arc.startIndex; i++) {
                                    this.ctx.lineTo(contour.points[i].x, contour.points[i].y);
                                }
                                if (arc.sweepAngle !== undefined) {
                                    this.ctx.arc(arc.center.x, arc.center.y, arc.radius,
                                        arc.startAngle, arc.startAngle + arc.sweepAngle,
                                        arc.sweepAngle < 0);
                                } else {
                                    this.ctx.arc(arc.center.x, arc.center.y, arc.radius,
                                        arc.startAngle, arc.endAngle, arc.clockwise);
                                }
                                currentIndex = arc.endIndex;
                            }

                            if (currentIndex !== 0 || sortedArcs.length === 0) {
                                for (let i = currentIndex + 1; i < contour.points.length; i++) {
                                    this.ctx.lineTo(contour.points[i].x, contour.points[i].y);
                                }
                            }
                        } else {
                            contour.points.forEach((p, i) => {
                                if (i === 0) this.ctx.moveTo(p.x, p.y);
                                else this.ctx.lineTo(p.x, p.y);
                            });
                        }

                        if (primitive.closed !== false) this.ctx.closePath();
                    }
                }
            } else if (primitive.type === 'circle') {
                this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, 0, Math.PI * 2);
                this.ctx.closePath();
            } else if (primitive.type === 'rectangle') {
                this.ctx.rect(primitive.position.x, primitive.position.y, primitive.width, primitive.height);
            } else if (primitive.type === 'arc') {
                this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius,
                    primitive.startAngle, primitive.endAngle, primitive.clockwise);
            } else if (primitive.type === 'obround') {
                let x = primitive.position.x;
                let y = primitive.position.y;
                const w = primitive.width;
                const h = primitive.height;
                const r = Math.min(w, h) / 2;

                if (primitive.properties?.rotation) {
                    const cx = x + w / 2;
                    const cy = y + h / 2;
                    this.ctx.save();
                    this.ctx.translate(cx, cy);
                    this.ctx.rotate(primitive.properties.rotation * Math.PI / 180);
                    x = -w / 2;
                    y = -h / 2;
                }

                if (w > h) {
                    this.ctx.moveTo(x + r, y);
                    this.ctx.lineTo(x + w - r, y);
                    this.ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
                    this.ctx.lineTo(x + r, y + h);
                    this.ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
                } else {
                    this.ctx.moveTo(x + w, y + r);
                    this.ctx.lineTo(x + w, y + h - r);
                    this.ctx.arc(x + r, y + h - r, r, 0, Math.PI);
                    this.ctx.lineTo(x, y + r);
                    this.ctx.arc(x + r, y + r, r, Math.PI, 0);
                }

                if (primitive.properties?.rotation) {
                    this.ctx.restore();
                }
                this.ctx.closePath();
            }
        }

        // ========================================================================
        // Normal Rendering
        // ========================================================================

        renderPrimitiveNormal(primitive, fillColor, strokeColor, isPreprocessed) {
            if (primitive.type !== 'path') {
                switch (primitive.type) {
                    case 'circle':
                        this.renderCircle(primitive, fillColor, strokeColor);
                        break;
                    case 'rectangle':
                        this.renderRectangle(primitive, fillColor, strokeColor);
                        break;
                    case 'arc':
                        this.renderArc(primitive, fillColor, strokeColor);
                        break;
                    case 'obround':
                        this.renderObround(primitive, fillColor, strokeColor);
                        break;
                }
                return;
            }

            this.renderPath(primitive, fillColor, strokeColor, isPreprocessed);
        }

        renderPath(primitive, fillColor, strokeColor, isPreprocessed) {
            const shouldFill = (primitive.properties?.fill !== false && !primitive.properties?.stroke) || isPreprocessed;
            const shouldStroke = primitive.properties?.stroke === true && !isPreprocessed;

            if (!primitive.contours || primitive.contours.length === 0) return;

            this.drawPrimitivePath(primitive);

            if (shouldFill) {
                if (isPreprocessed && primitive.properties?.polarity === 'clear') {
                    this.ctx.fillStyle = this.core.colors.render2d.background;
                } else {
                    this.ctx.fillStyle = fillColor;
                }
                this.ctx.fill('evenodd');
            }

            if (shouldStroke) {
                this.ctx.strokeStyle = strokeColor;
                this.ctx.lineWidth = primitive.properties.strokeWidth;
                this.ctx.lineCap = 'round';
                this.ctx.lineJoin = 'round';
                this.ctx.stroke();
            }
        }

        renderCircle(primitive, fillColor, strokeColor) {
            this.ctx.beginPath();
            this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, 0, Math.PI * 2);

            if (primitive.properties?.fill !== false) {
                this.ctx.fillStyle = fillColor;
                this.ctx.fill();
            }

            if (primitive.properties?.stroke) {
                this.ctx.strokeStyle = strokeColor;
                this.ctx.lineWidth = primitive.properties.strokeWidth;
                this.ctx.stroke();
            }
        }

        renderRectangle(primitive, fillColor, strokeColor) {
            if (primitive.properties?.fill !== false) {
                this.ctx.fillStyle = fillColor;
                this.ctx.fillRect(primitive.position.x, primitive.position.y, primitive.width, primitive.height);
            }

            if (primitive.properties?.stroke) {
                this.ctx.strokeStyle = strokeColor;
                this.ctx.lineWidth = primitive.properties.strokeWidth;
                this.ctx.strokeRect(primitive.position.x, primitive.position.y, primitive.width, primitive.height);
            }
        }

        renderArc(primitive, fillColor, strokeColor) {
            this.ctx.beginPath();
            this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius,
                primitive.startAngle, primitive.endAngle, primitive.clockwise);

            if (primitive.properties?.fill) {
                this.ctx.closePath();
                this.ctx.fillStyle = fillColor;
                this.ctx.fill();
            }

            this.ctx.strokeStyle = strokeColor;
            this.ctx.lineWidth = primitive.properties.strokeWidth;
            this.ctx.stroke();
        }

        renderObround(primitive, fillColor, strokeColor) {
            const x = primitive.position.x;
            const y = primitive.position.y;
            const w = primitive.width;
            const h = primitive.height;
            const r = Math.min(w, h) / 2;

            this.ctx.beginPath();

            if (w > h) {
                this.ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2, false);
                this.ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2, false);
            } else {
                this.ctx.arc(x + r, y + r, r, Math.PI, 0, false);
                this.ctx.arc(x + r, y + h - r, r, 0, Math.PI, false);
            }

            this.ctx.closePath();

            if (primitive.properties?.fill !== false) {
                this.ctx.fillStyle = fillColor;
                this.ctx.fill();
            }

            if (primitive.properties?.stroke) {
                this.ctx.strokeStyle = strokeColor;
                this.ctx.lineWidth = primitive.properties.strokeWidth;
                this.ctx.stroke();
            }
        }

        // ========================================================================
        // Debug/Reconstructed Rendering
        // ========================================================================

        renderReconstructedPrimitive(primitive, fillColor) {
            const primColors = this.core.colors.primitives || {};
            const accentColor = primColors.reconstructed;
            const fc = this.core.frameCache;

            this.ctx.save();

            if (primitive.type === 'circle') {
                this.ctx.strokeStyle = accentColor;
                this.ctx.lineWidth = this.cfg.stroke.reconstructed * fc.invScale;
                this.ctx.fillStyle = fillColor;

                this.ctx.beginPath();
                this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius, 0, 2 * Math.PI);
                this.ctx.fill();
                this.ctx.stroke();

                this.ctx.fillStyle = accentColor;
                this.ctx.beginPath();
                this.ctx.arc(primitive.center.x, primitive.center.y, 
                    this.cfg.reconstructed.centerSize * fc.invScale, 0, 2 * Math.PI);
                this.ctx.fill();
            } else if (primitive.type === 'arc') {
                this.ctx.strokeStyle = accentColor;
                this.ctx.lineWidth = this.cfg.stroke.reconstructed * fc.invScale;

                this.ctx.beginPath();
                this.ctx.arc(primitive.center.x, primitive.center.y, primitive.radius,
                    primitive.startAngle, primitive.endAngle, primitive.clockwise);
                this.ctx.stroke();
            } else if (primitive.type === 'path') {
                this.ctx.strokeStyle = primColors.reconstructedPath;
                this.ctx.lineWidth = this.cfg.stroke.reconstructed * fc.invScale;
                const dash = this.cfg.reconstructed.pathDash;
                this.ctx.setLineDash([dash[0] * fc.invScale, dash[1] * fc.invScale]);

                this.renderPrimitiveNormal(primitive, fillColor, primColors.reconstructedPath);
            }

            this.ctx.restore();
        }

        renderWireframe(primitive) {
            const debugColors = this.core.colors.debug;
            const strokeWidth = this.core.getWireframeStrokeWidth();

            this.ctx.strokeStyle = debugColors.wireframe;
            this.ctx.lineWidth = strokeWidth;
            this.ctx.fillStyle = 'transparent'; // Ensure no fill interferes
            this.ctx.setLineDash([]);

            // The helper calls beginPath() internally
            this.drawPrimitivePath(primitive);

            this.ctx.stroke();
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[PrimitiveRenderer] ${message}`, data)
                 : console.log(`[PrimitiveRenderer] ${message}`);
        }
    }

    /**
     * Tool-relation → status color. Single source for the 2D renderer and
     * the SVG canvas exporter (was duplicated in both).
     * @param {string} toolRelation - 'oversized' | 'undersized' | 'exact'
     * @param {{error,warn,good}} palette
     * @param {string} [fallback] - returned for unknown relations (renderer
     *        passes the primitive's own color; exporter omits → good).
     */
    window.resolveToolRelationColor = function(toolRelation, palette, fallback) {
        switch (toolRelation) {
            case 'oversized':  return palette.error;
            case 'undersized': return palette.warn;
            case 'exact':      return palette.good;
            default:           return fallback !== undefined ? fallback : palette.good;
        }
    };

    window.PrimitiveRenderer = PrimitiveRenderer;
})();