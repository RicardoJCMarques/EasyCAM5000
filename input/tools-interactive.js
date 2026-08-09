/*!
 * @file        input/tools-interactive.js
 * @description EasyShape-specific tools. SelectMoveTool is the default tool
 *              for EasyShape - pick / shift-toggle / ctrl-add, drag-move,
 *              marquee, wheel zoom from idle.
 *
 *              PanZoomTool used to live here too; it now lives in shared
 *              input/tools-common.js so EasyTrace can use it as default
 *              with allowedButtons = [0, 1, 2]. EasyShape pushes it as an
 *              override via the controller's createPanZoomTool() factory.
 *
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const DRAG_THRESHOLD_MOUSE_PX = 3;   // CSS px - mouse is precise
    const DRAG_THRESHOLD_TOUCH_PX = 8;   // CSS px - fingers jitter
    const WHEEL_ZOOM_SPEED = 0.002;

    function unprojectToWorld(ctx, canvasX, canvasY) {
        return ctx.renderer.core.canvasToWorld(canvasX, canvasY);
    }

    /**
     * Computes a hit-test tolerance in world units that maps to a fixed
     * screen-pixel target. ~4 CSS pixels is the Inkscape/Figma standard for
     * fuzzy stroke selection. Devices with DPR > 1 get scaled up so the
     * physical pixel budget stays constant.
     */
    function hitToleranceWorld(ctx) {
        const screenPx = 4;
        const dpr = window.devicePixelRatio || 1;
        const scale = ctx.renderer.core.viewScale;
        if (!scale || scale <= 0) return 0;
        return (screenPx * dpr) / scale;
    }

    class SelectMoveTool extends BaseTool {
        constructor() {
            super();
            this.state = 'idle';
            this.startScreen = null;
            this.startWorld = null;
            this.lastWorld = null;
            this.marqueeRect = null;

            // Drag accounting - captured at pointerdown so mid-drag tree
            // selection changes can't corrupt the recorded delta.
            this.dragShapeIds = null;
        }

        onPointerDown(data, ctx) {
            if (data.button !== 0) return false;

            const world = unprojectToWorld(ctx, data.canvasX, data.canvasY);
            const tol = hitToleranceWorld(ctx);
            const selectMode = data.altKey ? 'shape' : 'group';
            let hit = ctx.scene.pick(world, { tolerance: tol, selectMode });

            // Skip hidden hits - they're not on canvas, so they shouldn't
            // be pickable. Locked items ARE still pickable (user needs to
            // select them to unlock); drag is filtered separately.
            if (hit && ctx.isNodeVisible && !ctx.isNodeVisible(hit.id)) {
                hit = null;
            }

            this.startScreen = { x: data.clientX, y: data.clientY };
            this.startWorld = world;
            this.lastWorld = world;
            this.pointerType = data.pointerType || 'mouse';

            if (hit) {
                if (data.shiftKey) {
                    ctx.selection.toggle(hit.id);
                } else if (data.ctrlKey || data.metaKey) {
                    ctx.selection.add(hit.id);
                } else {
                    if (!ctx.selection.has(hit.id)) {
                        ctx.selection.replace([hit.id]);
                    }
                }
                this.state = 'maybe-drag';
                this.dragShapeIds = [...ctx.selection.toSet()];
            } else {
                if (!data.shiftKey && !data.ctrlKey && !data.metaKey) {
                    if (ctx.selection.size() > 0) ctx.selection.clear();
                }
                this.state = 'maybe-marquee';
                this.dragShapeIds = null;
            }

            ctx.requestRender();
            return true;
        }

        onPointerMove(data, ctx) {
            if (this.state === 'idle') return false;

            const world = unprojectToWorld(ctx, data.canvasX, data.canvasY);

            switch (this.state) {
                case 'maybe-drag':
                    if (this.exceedsDeadZone(data)) this.state = 'drag-move';
                    break;

                case 'drag-move': {
                    const dx = world.x - this.lastWorld.x;
                    const dy = world.y - this.lastWorld.y;
                    if (dx !== 0 || dy !== 0) {
                        this.translateSelection(ctx, dx, dy);
                        this.lastWorld = world;
                        ctx.requestRender();
                        if (ctx.syncInspector) ctx.syncInspector();
                    }
                    break;
                }

                case 'maybe-marquee':
                    if (this.exceedsDeadZone(data)) this.state = 'marquee';
                    break;

                case 'marquee':
                    this.lastWorld = world;
                    this.marqueeRect = this.marqueeBounds();
                    ctx.requestRender();
                    break;
            }
            return true;
        }

        onPointerUp(data, ctx) {
            if (this.state === 'idle') return false;

            switch (this.state) {
                case 'maybe-drag':
                    break;

                case 'drag-move': {
                    // Total delta from gesture start. The shapes have already
                    // moved live during onPointerMove - we just record.
                    const totalDx = this.lastWorld.x - this.startWorld.x;
                    const totalDy = this.lastWorld.y - this.startWorld.y;
                    if ((totalDx !== 0 || totalDy !== 0) && this.dragShapeIds && this.dragShapeIds.length > 0) {
                        if (typeof ctx.commitTranslate === 'function') {
                            ctx.commitTranslate(this.dragShapeIds, totalDx, totalDy);
                        }
                    }
                    if (ctx.onCommit) ctx.onCommit();
                    break;
                }

                case 'maybe-marquee':
                    break;

                case 'marquee': {
                    const rect = this.marqueeBounds();
                    const rawIds = ctx.scene.shapesIntersectingRect(rect);

                    // Drop any shape whose effective visibility is false.
                    // Hidden geometry isn't on canvas; the user can't see
                    // what they grabbed, so don't pretend it was selectable.
                    const visibleIds = ctx.isNodeVisible
                        ? rawIds.filter(id => ctx.isNodeVisible(id))
                        : rawIds;

                    let finalIds = new Set(visibleIds);
                    if (!data.altKey) {
                        finalIds = new Set();
                        for (const sid of visibleIds) {
                            let node = ctx.scene.findNode(sid);
                            while (node && node.parent && node.parent.kind !== 'root') {
                                node = node.parent;
                            }
                            if (node) finalIds.add(node.id);
                        }
                    }

                    if (data.shiftKey || data.ctrlKey || data.metaKey) {
                        ctx.selection.addMany(Array.from(finalIds));
                    } else {
                        ctx.selection.replace(Array.from(finalIds));
                    }
                    this.marqueeRect = null;
                    ctx.requestRender();
                    break;
                }
            }

            this.state = 'idle';
            this.startScreen = null;
            this.dragShapeIds = null;
            return true;
        }

        onWheel(data, ctx) {
            const zoomFactor = Math.exp(-data.deltaY * WHEEL_ZOOM_SPEED);
            ctx.renderer.core.zoomToPoint(data.canvasX, data.canvasY, zoomFactor);
            ctx.renderer.render();
            ctx.canvasReadout?.updateZoom?.();
            return true;
        }

        /**
         * Overlay payload - JUST the marquee. Selection visuals (path glow
         * and aggregate bbox) are drawn by the controller because they need
         * scene access; keeping them in the tool would force the tool to
         * import scene logic.
         */
        getOverlayState(ctx) {
            return this.marqueeRect ? { marqueeRect: this.marqueeRect } : null;
        }

        translateSelection(ctx, dx, dy) {
            if (!this.dragShapeIds) return;
            const topLevelIds = ctx.getTopLevelIds ? ctx.getTopLevelIds(this.dragShapeIds) : this.dragShapeIds;

            for (const id of topLevelIds) {
                const node = ctx.scene.findNode(id);
                if (!node) continue;
                if (!ctx.canMutateNode(node)) continue;

                // Project world-space delta into the node's parent space.
                // For top-level nodes (parent = root) this is identity.
                let localDx = dx, localDy = dy;
                if (node.parent && node.parent.kind !== 'root') {
                    const parentWorld = node.parent.getWorldMatrix();
                    const inv = TransformMath.invert(parentWorld);
                    if (inv) {
                        localDx = inv.a * dx + inv.c * dy;
                        localDy = inv.b * dx + inv.d * dy;
                    }
                }
                node.translateBy(localDx, localDy);

                // Update renderer layers for ALL child shapes
                const shapeIds = ctx.scene.collectShapeIds(node);
                for (const sid of shapeIds) {
                    const s = ctx.scene.findShape(sid);
                    if (s && ctx.renderer.updateLayerTransform) {
                        ctx.renderer.updateLayerTransform(
                            `shape_${s.id}`,
                            s.getWorldMatrix(),
                            ctx.scene.getShapeWorldBounds(s)
                        );
                    }
                }
            }
        }

        exceedsDeadZone(data) {
            const dx = data.clientX - this.startScreen.x;
            const dy = data.clientY - this.startScreen.y;
            // CSS pixels are already DPR-normalised. The real variable is
            // pointer type: touch needs more slack than mouse.
            const threshold = this.pointerType === 'touch'
                ? DRAG_THRESHOLD_TOUCH_PX
                : DRAG_THRESHOLD_MOUSE_PX;
            return (dx * dx + dy * dy) >= (threshold * threshold);
        }

        marqueeBounds() {
            const a = this.startWorld;
            const b = this.lastWorld;
            return {
                minX: Math.min(a.x, b.x),
                minY: Math.min(a.y, b.y),
                maxX: Math.max(a.x, b.x),
                maxY: Math.max(a.y, b.y)
            };
        }
    }

    window.SelectMoveTool = SelectMoveTool;
})();