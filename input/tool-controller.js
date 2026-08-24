/*!
 * @file        input/tool-controller.js
 * @description Tool state machine. Routes normalized input from InputManager
 *              to the currently active tool, with an "override tool" slot
 *              that takes priority while held (used for middle/right-drag
 *              pan in EasyShape - EasyTrace doesn't push overrides).
 *
 *              Exposes getOverlayState() so the renderer can paint transient
 *              UI (marquee box, selection bounds, drag handles) without
 *              knowing what tool is active.
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

    class BaseTool {
        constructor() {
            this.name = this.constructor.name;
        }
        onActivate(ctx) {}
        onDeactivate(ctx) {}
        /** An override tool is taking over mid-gesture. Commit and reset. */
        onSuspend(ctx) {}
        onPointerDown(data, ctx) { return false; }
        onPointerMove(data, ctx) { return false; }
        onPointerUp(data, ctx)   { return false; }
        onWheel(data, ctx)       { return false; }
        onKeyDown(data, ctx)     { return false; }
        onKeyUp(data, ctx)       { return false; }
        getOverlayState(ctx)     { return null; }
    }

    class ToolController {
        constructor(context) {
            this.context = context;
            this.defaultTool = null;
            this.overrideTool = null;
            this.input = null;
        }

        setInputManager(input) {
            this.input = input;
            this.context.input = input;
        }

        setDefaultTool(tool) {
            if (this.defaultTool && this.defaultTool.onDeactivate) {
                this.defaultTool.onDeactivate(this.context);
            }
            this.defaultTool = tool;
            if (tool && tool.onActivate) tool.onActivate(this.context);
        }

        pushOverrideTool(tool) {
            if (this.overrideTool && this.overrideTool.onDeactivate) {
                this.overrideTool.onDeactivate(this.context);
            }
            // The default tool may be mid-gesture; it will receive no further
            // events until the override pops.
            this.defaultTool?.onSuspend?.(this.context);
            this.overrideTool = tool;
            if (tool && tool.onActivate) tool.onActivate(this.context);
        }

        popOverrideTool() {
            if (this.overrideTool && this.overrideTool.onDeactivate) {
                this.overrideTool.onDeactivate(this.context);
            }
            this.overrideTool = null;
        }

        get activeTool() {
            return this.overrideTool || this.defaultTool;
        }

        /**
         * Override entry policy:
         *   If the context exposes a createPanZoomTool() factory AND a
         *   middle/right pointerdown arrives without an existing override,
         *   create and push a PanZoomTool. EasyTrace doesn't define the
         *   factory, so it never enters override mode - its default tool
         *   handles every button.
         *
         * Override exit policy:
         *   Pop on pointerup when the active-pointer map is empty, or when
         *   the middle/right button itself comes up.
         */
        dispatch(eventName, data) {
            // Override entry policy
            if (eventName === 'PointerDown' && !this.overrideTool) {
                const isMiddleOrRight = data.button === 1 || data.button === 2;
                const isSecondPointer = this.input && this.input.activePointers.size === 2;

                // Push PanZoomTool if MMB/RMB is pressed, OR if a second finger touches
                if (isMiddleOrRight || isSecondPointer) {
                    if (typeof this.context.createPanZoomTool === 'function') {
                        const pz = this.context.createPanZoomTool();
                        this.pushOverrideTool(pz);
                    }
                }
            }

            const tool = this.activeTool;
            let consumed = false;
            if (tool) {
                const handlerName = `on${eventName}`;
                if (typeof tool[handlerName] === 'function') {
                    consumed = !!tool[handlerName](data, this.context);
                }
            }

            if (eventName === 'PointerUp' && this.overrideTool) {
                const noActive = !this.input || this.input.activePointers.size === 0;
                if (noActive || data.button === 1 || data.button === 2) {
                    this.popOverrideTool();
                }
            }

            return consumed;
        }

        getOverlayState() {
            const tool = this.activeTool;
            if (tool && typeof tool.getOverlayState === 'function') {
                return tool.getOverlayState(this.context);
            }
            return null;
        }
    }

    window.BaseTool = BaseTool;
    window.ToolController = ToolController;
})();