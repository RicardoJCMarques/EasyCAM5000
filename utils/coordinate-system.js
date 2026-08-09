/*!
 * @file        utils/coordinate-system.js
 * @description Shared Coordinate System
 * // REVIEW - rework both coordinate-system and transform-math headers
 *
 *              All transforms are 2D affine in object form:
 *                  m = { a, b, c, d, e, f }
 *              representing the column-major matrix
 *                  | a c e |
 *                  | b d f |
 *                  | 0 0 1 |
 *              which maps a point p to (m.a*p.x + m.c*p.y + m.e,
 *                                       m.b*p.x + m.d*p.y + m.f).
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

    // ID generation - sequential, scoped per scene.
    // Using sequential rather than UUIDs keeps DOM data-attributes short and
    // debug logs readable. The Scene resets the counter on clear().

    let idCounter = 1;
    function nextId(prefix) { return `${prefix}_${idCounter++}`; }

    // SceneNode - base class for both groups and shapes.
    // Each node owns a local TRS transform. World matrices are computed by
    // walking the parent chain and cached until a transform changes. When a
    // local transform mutates, the node marks itself and all descendants
    // dirty - descendants because their world matrices depend on the ancestor
    // chain that just changed.

    class SceneNode {
        constructor(kind, label = '') {
            this.id = nextId(kind === 'group' ? 'g' : 's');
            this.kind = kind;
            this.parent = null;
            this.label = label;
            this.visible = true;
            this.locked = false;
            this.transform = {
                x: 0,
                y: 0,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                rotationCenter: null
            };

            this.worldMatrixCache = null;
            this.localMatrixCache = null;
            this.isDirty = true;
        }

        get isVisible() {
            let n = this;
            while (n) {
                if (!n.visible) return false;
                n = n.parent;
            }
            return true;
        }

        get isLocked() {
            let n = this;
            while (n) {
                if (n.locked) return true;
                n = n.parent;
            }
            return false;
        }

        /**
         * Full invalidation - this node's own TRS changed.
         * Clears local + world caches, then cascades world-only to children.
         */
        markDirty() {
            this.isDirty = true;
            this.worldMatrixCache = null;
            this.localMatrixCache = null;
            if (this.kind === 'group' && this.children) {
                for (const child of this.children) child.markWorldDirty();
            }
        }

        /**
         * World-only invalidation - an ancestor's transform changed.
         * This node's LOCAL matrix is still valid (its own TRS didn't change),
         * only its world matrix (which depends on the ancestor chain) is stale.
         */
        markWorldDirty() {
            this.isDirty = true;
            this.worldMatrixCache = null;
            // localMatrixCache intentionally preserved
            if (this.kind === 'group' && this.children) {
                for (const child of this.children) child.markWorldDirty();
            }
        }

        /**
         * Local matrix: this node's TRS, with rotation/scale centred on
         * either an explicit rotationCenter or the node's local bbox centre.
         */
        getLocalMatrix() {
            if (this.localMatrixCache) return this.localMatrixCache;
            const t = this.transform;
            const centre = t.rotationCenter || this.getLocalBoundsCentre();
            this.localMatrixCache = TransformMath.composeTRS(
                t.x, t.y,
                t.rotation,
                t.scaleX, t.scaleY,
                centre.x, centre.y
            );
            return this.localMatrixCache;
        }

        /**
         * World matrix: cumulative transform from this node up to the root.
         * Cached and dirty-checked. Hot path during render + hit-test.
         */
        getWorldMatrix() {
            if (!this.isDirty && this.worldMatrixCache) {
                return this.worldMatrixCache;
            }
            let m = this.getLocalMatrix();
            if (this.parent && this.parent.kind !== 'root') {
                m = TransformMath.multiply(this.parent.getWorldMatrix(), m);
            }
            this.worldMatrixCache = m;
            this.isDirty = false;
            return m;
        }

        /**
         * Override in subclasses. The default is a degenerate point at origin
         * so abstract groups without children don't blow up.
         */
        getLocalBounds() {
            return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        }

        getLocalBoundsCentre() {
            const b = this.getLocalBounds();
            return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
        }

        /**
         * Convenience mutators. They funnel through markDirty so callers
         * never have to remember the invalidation step.
         */
        translateBy(dx, dy) {
            this.transform.x += dx;
            this.transform.y += dy;
            this.markDirty();
        }

        setRotation(deg, centre = null) {
            this.transform.rotation = deg;
            if (centre) this.transform.rotationCenter = { x: centre.x, y: centre.y };
            this.markDirty();
        }

        resetTransform() {
            this.transform.x = 0;
            this.transform.y = 0;
            this.transform.rotation = 0;
            this.transform.scaleX = 1;
            this.transform.scaleY = 1;
            this.transform.rotationCenter = null;
            this.markDirty();
        }
    }

    // GroupNode - internal tree node with ordered children.
    // The scene root is a GroupNode with kind === 'root', whose getWorldMatrix
    // short-circuits to identity (see SceneNode.getWorldMatrix). Every other
    // group sits below the root and contributes its local matrix normally.
    class GroupNode extends SceneNode {
        constructor(label = '') {
            super('group', label);
            this.children = [];
            this.collapsed = false;
        }

        addChild(node) {
            if (node.parent) node.parent.removeChild(node);
            node.parent = this;
            this.children.push(node);
            node.markDirty();
            return node;
        }

        removeChild(node) {
            const idx = this.children.indexOf(node);
            if (idx >= 0) {
                this.children.splice(idx, 1);
                node.parent = null;
                node.markDirty();
            }
            return node;
        }

        /**
         * Union of all descendant shape local bounds in this group's local
         * frame. Used when rotating a group around its own centre.
         */
        getLocalBounds() {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            const walk = (node) => {
                if (node === this) {
                    if (node.children) for (const c of node.children) walk(c);
                    return;
                }
                if (node.kind === 'shape') {
                    // Transform the shape's local bbox by its own local matrix
                    // to get its bounds in our (the group's) frame.
                    const m = node.getLocalMatrix();
                    const b = TransformMath.transformBounds(m, node.getLocalBounds());
                    if (b.minX < minX) minX = b.minX;
                    if (b.minY < minY) minY = b.minY;
                    if (b.maxX > maxX) maxX = b.maxX;
                    if (b.maxY > maxY) maxY = b.maxY;
                } else if (node.children) {
                    for (const c of node.children) walk(c);
                }
            };
            walk(this);
            if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            return { minX, minY, maxX, maxY };
        }
    }

    // ShapeNode - leaf node wrapping a RenderPrimitive.
    // The primitive's coordinates are the shape's local frame. The shape's
    // own transform is applied on top during render and hit-test. Operations
    // (profile, pocket, drill, engrave) attach here - not to the file - so
    // a single SVG can decompose into shapes with different ops.
    class ShapeNode extends SceneNode {
        constructor(primitive, sourceFile, label) {
            super('shape', label || 'Shape');
            this.primitive = primitive;
            this.sourceFile = sourceFile || null;

            // Per-shape operation. Null until the user assigns one. The shape
            // (and not core.operations) owns this - when toolpath generation
            // is wired in v2, the controller iterates shapes with operations
            // and pushes each into core.createOperation at that boundary.
            this.operation = null;

            // Cached local bounds - recomputed when the primitive is replaced
            // (currently never; the primitive is immutable once attached).
            this.localBounds = null;
            try {
                this.localBounds = primitive.getBounds();
            } catch (e) {
                this.localBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }
        }

        getLocalBounds() {
            return this.localBounds;
        }

        /**
         * Hit-test a world-space point against this shape's geometry.
         * Inverse-transforms the point into the shape's local frame, then
         * delegates to the primitive-shape-specific containment test.
         */
        containsWorldPoint(worldPt) {
            const worldM = this.getWorldMatrix();
            const invM = TransformMath.invert(worldM);
            if (!invM) return false;
            const localPt = TransformMath.applyToPoint(invM, worldPt);

            // Fast bbox reject first.
            const b = this.localBounds;
            if (localPt.x < b.minX || localPt.x > b.maxX ||
                localPt.y < b.minY || localPt.y > b.maxY) {
                return false;
            }

            return primitiveContainsLocalPoint(this.primitive, localPt);
        }
    }

    // SelectionSet - set of node IDs with anchor tracking and change events.
    // The anchor is the "most recent" pick - used for range selection (shift-
    // click in the tree, when that lands) and for resolving "show this one's
    // parameters" in the right panel.
    class SelectionSet {
        constructor() {
            this.ids = new Set();
            this.anchorId = null;
            this.listeners = new Set();
            this.batchDepth = 0;
            this.batchDirty = false;
            this.batchAction = null;
        }

        addChangeListener(fn) { this.listeners.add(fn); }
        removeChangeListener(fn) { this.listeners.delete(fn); }

        notify(action) {
            if (this.batchDepth > 0) {
                this.batchDirty = true;
                this.batchAction = this.batchAction || action;
                return;
            }
            for (const fn of this.listeners) {
                try { fn({ action, ids: Array.from(this.ids), anchor: this.anchorId }); }
                catch (e) { console.error('[SelectionSet] listener error:', e); }
            }
        }

        /**
         * Suppress notifications while fn runs. Coalesces every mutation
         * inside into one event. Reentrant - nested batches share one final fire.
         */
        batch(fn) {
            this.batchDepth++;
            try { fn(); }
            finally {
                this.batchDepth--;
                if (this.batchDepth === 0 && this.batchDirty) {
                    const action = this.batchAction;
                    this.batchDirty = false;
                    this.batchAction = null;
                    this.notify(action);
                }
            }
        }

        has(id) { return this.ids.has(id); }
        size() { return this.ids.size; }
        anchor() { return this.anchorId; }
        toSet() { return new Set(this.ids); }
        toArray() { return Array.from(this.ids); }

        replace(ids) {
            this.ids.clear();
            for (const id of ids) this.ids.add(id);
            this.anchorId = ids.length > 0 ? ids[ids.length - 1] : null;
            this.notify('replace');
        }

        /** Bulk add - single notification regardless of how many added. */
        addMany(ids) {
            this.batch(() => { for (const id of ids) this.add(id); });
        }

        add(id) {
            if (!this.ids.has(id)) {
                this.ids.add(id);
                this.anchorId = id;
                this.notify('add');
            } else {
                this.anchorId = id;
            }
        }

        toggle(id) {
            if (this.ids.has(id)) {
                this.ids.delete(id);
                if (this.anchorId === id) {
                    const remaining = Array.from(this.ids);
                    this.anchorId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
                }
                this.notify('toggle-off');
            } else {
                this.ids.add(id);
                this.anchorId = id;
                this.notify('toggle-on');
            }
        }

        remove(id) {
            if (!this.ids.has(id)) return;
            this.ids.delete(id);
            if (this.anchorId === id) {
                const remaining = Array.from(this.ids);
                this.anchorId = remaining.length > 0 ? remaining[remaining.length - 1] : null;
            }
            this.notify('remove');
        }

        clear() {
            if (this.ids.size === 0) return;
            this.ids.clear();
            this.anchorId = null;
            this.notify('clear');
        }
    }

    class Scene {
        constructor() {
            this.root = new GroupNode('root');
            this.root.kind = 'root';
            this.root.label = '__root__';

            this.selection = new SelectionSet();

            // Global workspace transform
            // Applied to every shape during rendering and to all coordinates
            // before G-code emission. Replaces the old CoordinateSystemManager
            // entirely. UI modules write to it via the methods below; the
            // renderer reads it via getters on RendererCore.
            //
            // origin         : file-space point that becomes world (0,0)
            // rotation       : degrees CCW, applied around rotationCenter
            // rotationCenter : file-space pivot for rotation
            // mirrorX/Y      : axis flips around mirrorCenter
            // mirrorCenter   : file-space pivot for mirror - defaults to
            //                  board centre, updated on setBoardBounds
            this.transform = {
                origin: { x: 0, y: 0 },
                rotation: 0,
                rotationCenter: { x: 0, y: 0 },
                mirrorX: false,
                mirrorY: false,
                mirrorCenter: { x: 0, y: 0 }
            };

            // Aggregate AABB of all geometry in file space. Set by the
            // controller after parse (EasyTrace) or after addShapesFromPlot
            // (EasyShape). Drives rotation/mirror centres and zoomFit.
            this.boardBounds = null;

            // Transform-only change listeners. Selection has its own channel
            // on SelectionSet; these fire on origin/rotation/mirror/bounds
            // updates so the renderer can re-paint and UI inputs can resync.
            this.transformListeners = new Set();

            // Derived matrix caches
            // this.transform (semantic params) is AUTHORITATIVE. These are
            // disposable caches invalidated by notifyTransformChange. The
            // matrix never includes origin (G-code ground truth).
            this.wsMatrix = null;
            this.wsInverse = null;
            this.wsRotOnly = null;

            // Per-source-file index of group UID → GroupNode.
            this.fileRoots = new Map();

            this.nodeIndex = new Map();
            this.nodeIndex.set(this.root.id, this.root);
        }

        // -------------------------------------------------------------
        // Construction from parsed primitives
        // -------------------------------------------------------------

        /**
         * Build a subtree from a flat list of primitives, using each
         * primitive's properties.groupPath to recreate the SVG hierarchy.
         *
         * Layout convention: every import gets its own file-level GroupNode
         * (label = filename) under root. Primitives without a groupPath land
         * directly under that file group. Primitives with a groupPath get
         * nested groups created lazily under the file group, keyed by the
         * descriptor's stable uid.
         */
        addShapesFromPlot(primitives, sourceFile) {
            const fileGroup = new GroupNode(sourceFile || 'Untitled');
            this.root.addChild(fileGroup);
            this.fileRoots.set(sourceFile, fileGroup);
            this.nodeIndex.set(fileGroup.id, fileGroup);

            // uid → GroupNode for this file, so two primitives in the same
            // SVG <g> reuse the same node rather than each spawning a fresh one.
            const groupIndex = new Map();

            let shapeIdx = 0;
            for (const primitive of primitives) {
                shapeIdx++;
                const path = primitive.properties && primitive.properties.groupPath;

                let parent = fileGroup;
                if (path && path.length > 0) {
                    for (const descriptor of path) {
                        let g = groupIndex.get(descriptor.uid);
                        if (!g) {
                            g = new GroupNode(descriptor.label || descriptor.id || 'Group');
                            parent.addChild(g);
                            groupIndex.set(descriptor.uid, g);
                            this.nodeIndex.set(g.id, g);
                        }
                        parent = g;
                    }
                }

                const label = `${primitive.type} ${shapeIdx}`;
                const shape = new ShapeNode(primitive, sourceFile, label);
                parent.addChild(shape);
                this.nodeIndex.set(shape.id, shape);
            }

            // Prune any empty file group (shouldn't happen for a successful
            // parse, but defensive against zero-primitive imports).
            if (fileGroup.children.length === 0) {
                this.root.removeChild(fileGroup);
                this.fileRoots.delete(sourceFile);
            }
        }

        // -------------------------------------------------------------
        // Removal
        // -------------------------------------------------------------

        /**
         * Removes a node by id. Empty parent groups are pruned upward so the
         * tree doesn't accumulate skeletal branches after deletions.
         * Recomputes board bounds so visual rotation/mirror centres track
         * remaining geometry.
         */
        removeNode(id) {
            const node = this.findNode(id);
            if (!node || !node.parent) return false;

            const parent = node.parent;
            parent.removeChild(node);
            this.selection.remove(id);
            // Unindex the removed node and all descendants
            const unindex = (n) => {
                this.nodeIndex.delete(n.id);
                if (n.children) for (const c of n.children) unindex(c);
            };
            unindex(node);

            let p = parent;
            while (p && p !== this.root && p.children.length === 0) {
                const grand = p.parent;
                if (!grand) break;
                grand.removeChild(p);
                p = grand;
            }

            this.recomputeBoardBoundsFromShapes();
            return true;
        }

        clear() {
            this.root.children = [];
            this.fileRoots.clear();
            this.nodeIndex.clear();
            this.selection.clear();
            idCounter = 1;
            // Reset to default 100x100 canvas so the renderer always has
            // something to fit on.
            this.initializeEmptyBoardBounds();
        }

        // -------------------------------------------------------------
        // Lookup
        // -------------------------------------------------------------

        findNode(id) {
            return this.nodeIndex.get(id) || null;
        }

        findShape(id) {
            const n = this.findNode(id);
            return (n && n.kind === 'shape') ? n : null;
        }

        // -------------------------------------------------------------
        // Iteration
        // -------------------------------------------------------------

        /**
         * Generator over all leaf ShapeNodes in document order (parent
         * before children, siblings in insertion order). This matches the
         * order shapes were imported, which is what users intuitively expect
         * in the scene tree and as draw order.
         */
        *allShapes() { // This * is not a typo...
            const stack = [this.root];
            while (stack.length > 0) {
                const node = stack.pop();
                if (node.kind === 'shape') {
                    yield node;
                    continue;
                }
                // Push children in reverse so they're popped in original order.
                if (node.children) {
                    for (let i = node.children.length - 1; i >= 0; i--) {
                        stack.push(node.children[i]);
                    }
                }
            }
        }

        shapeCount() {
            let n = 0;
            for (const _ of this.allShapes()) n++;
            return n;
        }

        // -------------------------------------------------------------
        // Picking and marquee
        // -------------------------------------------------------------

        /**
         * Top-down hit test.
         *
         * @param {{x,y}} worldPt
         * @param {object} [options]
         * @param {number} [options.tolerance=0]   World-space hit slop.
         * @param {'shape'|'group'} [options.selectMode='group']
         *        'shape' - return the leaf ShapeNode under the cursor.
         *        'group' - return the topmost ancestor (below root) that
         *                  contains the hit shape. This is what a single
         *                  click does in Illustrator/Figma. Alt-click in
         *                  the tool layer downgrades to 'shape'.
         */
        pick(worldPt, options = {}) {
            // World (render) space → pre-workspace shape space. Identity
            // today in EasyShape (global rotate/mirror unused there), but
            // keeps picking correct if the workspace transform is enabled.
            // Tolerance is preserved: the workspace matrix is rigid (det ±1).
            worldPt = TransformMath.applyToPoint(this.getWorkspaceInverse(), worldPt);

            const tolerance = options.tolerance || 0;
            const selectMode = options.selectMode || 'group';

            const shapes = [];
            for (const s of this.allShapes()) shapes.push(s);

            for (let i = shapes.length - 1; i >= 0; i--) {
                const shape = shapes[i];
                if (!shape.isVisible) continue;

                const wm = shape.getWorldMatrix();
                const inv = TransformMath.invert(wm);
                if (!inv) continue;
                const localPt = TransformMath.applyToPoint(inv, worldPt);

                const b = shape.getLocalBounds();
                if (localPt.x < b.minX - tolerance || localPt.x > b.maxX + tolerance ||
                    localPt.y < b.minY - tolerance || localPt.y > b.maxY + tolerance) {
                    continue;
                }

                if (primitiveContainsLocalPoint(shape.primitive, localPt, tolerance)) {
                    if (selectMode === 'shape') return shape;

                    // Walk up to topmost ancestor whose parent is root.
                    let node = shape;
                    while (node.parent && node.parent !== this.root) {
                        node = node.parent;
                    }
                    return node;
                }
            }
            return null;
        }

        /**
         * Returns every ShapeNode descendant of a node (or the node itself
         * if it's already a shape). Used by tools/commands that need to
         * operate on selections that include groups.
         */
        collectShapeIds(node) {
            if (!node) return [];
            if (node.kind === 'shape') return [node.id];
            const ids = [];
            const walk = (n) => {
                if (n.kind === 'shape') { ids.push(n.id); return; }
                if (n.children) for (const c of n.children) walk(c);
            };
            walk(node);
            return ids;
        }

        /**
         * Returns ids of every visible shape whose world bbox intersects the
         * given world-space rectangle. Used for marquee selection. Bbox-only
         * (no precise polygon test) is the universal convention - Figma,
         * Illustrator, etc. all do the same.
         */
        shapesIntersectingRect(rect) {
            // Marquee rect arrives in world (render) space.
            rect = TransformMath.transformBounds(this.getWorkspaceInverse(), rect);
            const ids = [];
            for (const s of this.allShapes()) {
                if (!s.isVisible || s.isLocked) continue;
                const wb = this.getShapeWorldBounds(s);
                if (wb.maxX < rect.minX || wb.minX > rect.maxX ||
                    wb.maxY < rect.minY || wb.minY > rect.maxY) {
                    continue;
                }
                ids.push(s.id);
            }
            return ids;
        }

        // -------------------------------------------------------------
        // Bounds
        // -------------------------------------------------------------

        /**
         * World-space axis-aligned bbox of a shape. Used by the renderer to
         * cull layers correctly when per-shape transforms are non-identity.
         */
        getShapeWorldBounds(shape) {
            return TransformMath.transformBounds(shape.getWorldMatrix(), shape.getLocalBounds());
        }

        /**
         * World-space bbox of the current selection. Used for the rotation/
         * scale handle anchor and for "fit selection to view" (future).
         */
        getSelectionWorldBounds() {
            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;
            let any = false;

            const shapeIds = new Set();
            for (const id of this.selection.toSet()) {
                const node = this.findNode(id);
                if (!node) continue;
                if (node.kind === 'shape') shapeIds.add(id);
                else {
                    const descendantIds = this.collectShapeIds(node);
                    descendantIds.forEach(sid => shapeIds.add(sid));
                }
            }

            for (const id of shapeIds) {
                const s = this.findShape(id);
                if (!s) continue;
                const b = this.getShapeWorldBounds(s);
                if (b.minX < minX) minX = b.minX;
                if (b.minY < minY) minY = b.minY;
                if (b.maxX > maxX) maxX = b.maxX;
                if (b.maxY > maxY) maxY = b.maxY;
                any = true;
            }

            if (!any) return null;
            return { minX, minY, maxX, maxY };
        }

        // Transform API
        //
        // All mutators emit a transform-change event so listeners (renderer,
        // UI input sync, etc.) can react. The 'action' field is a hint for
        // debug logging; consumers shouldn't switch on it.

        getTransform() {
            const t = this.transform;
            return {
                origin: { ...t.origin },
                rotation: t.rotation,
                rotationCenter: { ...t.rotationCenter },
                mirrorX: t.mirrorX,
                mirrorY: t.mirrorY,
                mirrorCenter: { ...t.mirrorCenter }
            };
        }

        setOrigin(x, y) {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
            this.transform.origin.x = x;
            this.transform.origin.y = y;
            this.notifyTransformChange('setOrigin');
            return true;
        }

        nudgeOrigin(dx, dy) {
            return this.setOrigin(this.transform.origin.x + dx, this.transform.origin.y + dy);
        }

        resetOrigin() {
            return this.setOrigin(0, 0);
        }

        /**
         * Centres the origin on the board (after rotation + mirror). Returns
         * the applied origin or null if no boardBounds yet.
         */
        centerOriginOnBoard() {
            const b = this.getVisualBounds();
            if (!b) return null;
            this.setOrigin(b.centerX, b.centerY);
            return { ...this.transform.origin };
        }

        /**
         * Sets origin to the visual bottom-left corner of the board (post
         * rotation + mirror). Returns the applied origin or null.
         */
        setOriginToBottomLeft() {
            const b = this.getVisualBounds();
            if (!b) return null;
            this.setOrigin(b.minX, b.minY);
            return { ...this.transform.origin };
        }

        setRotation(deg, center = null) {
            if (!Number.isFinite(deg)) return false;
            this.transform.rotation = ((deg % 360) + 360) % 360;
            if (center) {
                this.transform.rotationCenter.x = center.x;
                this.transform.rotationCenter.y = center.y;
            }
            this.notifyTransformChange('setRotation');
            return true;
        }

        rotateBy(deg) {
            return this.setRotation(this.transform.rotation + deg);
        }

        resetRotation() {
            this.transform.rotation = 0;
            this.notifyTransformChange('resetRotation');
            return true;
        }

        setMirrorX(enabled) {
            this.transform.mirrorX = !!enabled;
            this.notifyTransformChange('setMirrorX');
            return true;
        }

        setMirrorY(enabled) {
            this.transform.mirrorY = !!enabled;
            this.notifyTransformChange('setMirrorY');
            return true;
        }

        toggleMirrorX() { return this.setMirrorX(!this.transform.mirrorX); }
        toggleMirrorY() { return this.setMirrorY(!this.transform.mirrorY); }

        resetMirror() {
            this.transform.mirrorX = false;
            this.transform.mirrorY = false;
            this.notifyTransformChange('resetMirror');
            return true;
        }

        resetTransform() {
            this.transform.origin.x = 0;
            this.transform.origin.y = 0;
            this.transform.rotation = 0;
            this.transform.mirrorX = false;
            this.transform.mirrorY = false;
            this.notifyTransformChange('resetTransform');
        }

        // Board bounds

        /**
         * Called by the controller after geometry is loaded. Sets the
         * aggregate AABB and updates default rotation/mirror centres.
         * Preserves the user's rotation pivot if they've already rotated.
         */
        setBoardBounds(bounds) {
            if (!bounds || !Number.isFinite(bounds.minX)) {
                this.boardBounds = null;
                this.notifyTransformChange('boardBoundsCleared');
                return;
            }
            const centerX = (bounds.minX + bounds.maxX) / 2;
            const centerY = (bounds.minY + bounds.maxY) / 2;
            this.boardBounds = {
                minX: bounds.minX, minY: bounds.minY,
                maxX: bounds.maxX, maxY: bounds.maxY,
                width: bounds.maxX - bounds.minX,
                height: bounds.maxY - bounds.minY,
                centerX, centerY
            };
            // Default rotation pivot at board centre - only if user hasn't
            // rotated yet (preserve their custom pivot otherwise).
            if (this.transform.rotation === 0) {
                this.transform.rotationCenter.x = centerX;
                this.transform.rotationCenter.y = centerY;
            }
            // Mirror centre is always board centre (visual symmetry).
            this.transform.mirrorCenter.x = centerX;
            this.transform.mirrorCenter.y = centerY;
            this.notifyTransformChange('setBoardBounds');
        }

        /** Used when no real geometry is loaded - default 100x100 canvas. */
        initializeEmptyBoardBounds() {
            this.setBoardBounds({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
        }

        /**
         * Recompute boardBounds from the scene's own shapes (EasyShape
         * usage). EasyTrace doesn't populate the scene with shapes yet, so
         * it calls setBoardBounds() directly with aggregated operation
         * bounds via core.updateBoardBounds().
         */
        recomputeBoardBoundsFromShapes() {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            let any = false;
            for (const s of this.allShapes()) {
                const wb = this.getShapeWorldBounds(s);
                if (!Number.isFinite(wb.minX)) continue;
                if (wb.minX < minX) minX = wb.minX;
                if (wb.minY < minY) minY = wb.minY;
                if (wb.maxX > maxX) maxX = wb.maxX;
                if (wb.maxY > maxY) maxY = wb.maxY;
                any = true;
            }
            if (any) this.setBoardBounds({ minX, minY, maxX, maxY });
            else this.setBoardBounds(null);
        }

        // REVIEW - Why have a rotated board bounds method? If there's no rotation the bounds will pop-out as is now that there's a consistent system?
        getBoardBounds() { return this.boardBounds; }

        /**
         * Board AABB after rotation (effective angle, no mirror), file space.
         * Used by zoomFit and the centre/bottom-left origin calculations.
         */
        getRotatedBoardBounds() {
            const b = this.boardBounds;
            if (!b || this.transform.rotation === 0) return b;
            return TransformMath.transformBounds(this.getRotationOnlyMatrix(), b);
        }

        /** Board AABB after rotation AND mirror. Drives Center / Bottom-Left. */
        getVisualBounds() {
            const b = this.boardBounds;
            if (!b) return null;
            return TransformMath.transformBounds(this.getWorkspaceMatrix(), b);
        }

        // Workspace matrix (derived, cached)
        //
        // The single global transform both apps run through. EasyTrace's
        // "one group transform" IS this matrix - its geometry lives in
        // operation layers, the renderer applies getWorkspaceMatrix()
        // once per frame, and per-node transforms stay identity/hidden.

        getWorkspaceMatrix() {
            if (!this.wsMatrix) {
                this.wsMatrix = TransformMath.composeWorkspace(this.transform);
            }
            return this.wsMatrix;
        }

        getWorkspaceInverse() {
            if (!this.wsInverse) {
                this.wsInverse = TransformMath.invert(this.getWorkspaceMatrix())
                    || TransformMath.identity();
            }
            return this.wsInverse;
        }

        /** Rotation component only (effective angle, mirrors excluded). */
        getRotationOnlyMatrix() {
            if (!this.wsRotOnly) {
                this.wsRotOnly = TransformMath.rotationOnlyWorkspace(this.transform);
            }
            return this.wsRotOnly;
        }

        /** True when arc/contour winding must flip under the workspace transform. */
        windingFlipped() {
            return TransformMath.windingFlipped(this.getWorkspaceMatrix());
        }

        // Coordinate space conversions (absorbed from SceneInteraction)
        //
        // Three spaces:
        //   canvas    - physical canvas pixels (devicePixelRatio applied)
        //   world     - render space, post-workspace-transform
        //   workspace - file coords, pre-transform (G-code origin frame)

        /** world → workspace: inverse workspace matrix, then minus origin. */
        worldToWorkspace(p) {
            const t = this.transform;
            const w = TransformMath.applyToPoint(this.getWorkspaceInverse(), p);
            return { x: w.x - t.origin.x, y: w.y - t.origin.y };
        }

        /** workspace → world: plus origin, then forward workspace matrix. */
        workspaceToWorld(p) {
            const t = this.transform;
            return TransformMath.applyToPoint(this.getWorkspaceMatrix(), {
                x: p.x + t.origin.x,
                y: p.y + t.origin.y
            });
        }

        /** canvas pixel → workspace (file) coordinates. */
        canvasToWorkspace(rendererCore, canvasX, canvasY) {
            const w = rendererCore.canvasToWorld(canvasX, canvasY);
            return this.worldToWorkspace(w);
        }

        /** workspace → canvas pixel. */
        workspaceToCanvas(rendererCore, workspacePt) {
            const w = this.workspaceToWorld(workspacePt);
            return {
                x: rendererCore.worldToCanvasX(w.x),
                y: rendererCore.worldToCanvasY(w.y)
            };
        }

        // Viewport / frustum culling
        //
        // viewBounds arrives PRE-workspace (the renderer inverse-transforms
        // its frame viewBounds once via getWorkspaceInverse), so this stays
        // a plain AABB-vs-AABB walk. Swap body for OBB-vs-frustum in 3D.
        *shapesInViewport(viewBounds) {
            for (const s of this.allShapes()) {
                if (!s.isVisible) continue;
                const wb = this.getShapeWorldBounds(s);
                if (wb.maxX < viewBounds.minX || wb.minX > viewBounds.maxX ||
                    wb.maxY < viewBounds.minY || wb.minY > viewBounds.maxY) {
                    continue;
                }
                yield s;
            }
        }

        collectShapesInViewport(viewBounds) {
            return Array.from(this.shapesInViewport(viewBounds));
        }

        /** Back-compat alias for the old SceneInteraction surface. */
        pickShape(worldPt, options) { return this.pick(worldPt, options); }

        // Transform listeners

        addTransformListener(fn) { this.transformListeners.add(fn); }
        removeTransformListener(fn) { this.transformListeners.delete(fn); }

        notifyTransformChange(action) {
            this.wsMatrix = null;
            this.wsInverse = null;
            this.wsRotOnly = null;
            if (this.transformListeners.size === 0) return;
            const payload = { action, transform: this.getTransform(), boardBounds: this.boardBounds };
            for (const fn of this.transformListeners) {
                try { fn(payload); }
                catch (e) { console.error('[Scene] transform listener error:', e); }
            }
        }

        // History utils

        /**
         * Re-inserts a previously-removed shape node into the tree. Used by
         * DeleteShapesCommand.undo(). `parentId` is null for top-level.
         * `index` < 0 or > children.length appends at the end.
         *
         * The node's primitive, transform, operation, etc. are preserved
         * intact - this is a structural re-link only.
         */
        reinsertShape(node, parentId, index) {
            if (!node) return false;
            if (node.parent) {
                node.parent.removeChild(node);
            }
            const parent = parentId ? this.findNode(parentId) : this.root;
            if (!parent) return false;

            node.parent = parent;
            const children = parent.children || (parent.children = []);
            if (index === undefined || index < 0 || index > children.length) {
                children.push(node);
            } else {
                children.splice(index, 0, node);
            }

            // Re-index any internal lookup tables you maintain (id→node map).
            // If you have something like this.nodeIndex, add it back here:
            if (this.nodeIndex && typeof this.nodeIndex.set === 'function') {
                this.nodeIndex.set(node.id, node);
                // Re-index descendants too in case the removed subtree had children.
                const walk = (n) => {
                    if (n.children) for (const c of n.children) {
                        this.nodeIndex.set(c.id, c);
                        walk(c);
                    }
                };
                walk(node);
            }

            this.fireChange?.('reinsert', node);
            return true;
        }

    }

    // Primitive containment - internal, used by ShapeNode.containsWorldPoint.
    // This is the v1 controller's hit-test logic, lifted intact and made into
    // a free function so it can be reused without instantiating a shape.
    // Lives at module scope (private) - not exported on window because the
    // public hit-test API is shape.containsWorldPoint / scene.pick.
    /**
     * @param {RenderPrimitive} prim
     * @param {{x, y}} pt   Point in the primitive's local frame.
     * @param {number} tolerance  World-space slop budget (e.g. 4 CSS
     *                            pixels unprojected to world units).
     */
    function primitiveContainsLocalPoint(prim, pt, tolerance = 0) {
        const props = prim.properties || {};
        const hasFill   = props.fill !== false && !props.stroke;
        const hasStroke = props.stroke === true || props.isTrace === true;

        // STROKED ONLY - must click on the stroke itself, within
        // (strokeWidth/2 + tolerance) world units.
        if (hasStroke && !hasFill) {
            const halfStroke = (props.strokeWidth || 0) / 2;
            const hitDist = halfStroke + tolerance;
            return pointWithinDistanceOfPrimitive(prim, pt, hitDist);
        }

        // FILLED - inside-test with optional edge tolerance so users
        // can still click right on the edge even when zoomed out.
        if (hasFill) {
            if (pointInsidePrimitive(prim, pt)) return true;
            if (tolerance > 0 && pointWithinDistanceOfPrimitive(prim, pt, tolerance)) {
                return true;
            }
            return false;
        }

        // Neither filled nor stroked - treat as filled to keep clickability.
        return pointInsidePrimitive(prim, pt);
    }

    function pointWithinDistanceOfPrimitive(prim, pt, maxDist) {
        const maxSq = maxDist * maxDist;
        if (prim.type === 'circle') {
            const dx = pt.x - prim.center.x;
            const dy = pt.y - prim.center.y;
            const d = Math.abs(Math.sqrt(dx*dx + dy*dy) - prim.radius);
            return d <= maxDist;
        }
        if (!prim.contours) return false;
        for (const c of prim.contours) {
            if (!c.points || c.points.length < 2) continue;
            for (let i = 0; i < c.points.length - 1; i++) {
                const a = c.points[i], b = c.points[i + 1];
                if (pointSegmentDistSq(pt, a, b) <= maxSq) return true;
            }
        }
        return false;
    }

    function pointSegmentDistSq(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx*dx + dy*dy;
        if (len2 === 0) {
            const ex = p.x - a.x, ey = p.y - a.y;
            return ex*ex + ey*ey;
        }
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        const ex = p.x - cx, ey = p.y - cy;
        return ex*ex + ey*ey;
    }

    /**
     * Point-inside test that handles circle, rectangle, and multi-contour
     * paths. For paths, applies even-odd fill rule so holes work.
     */
    function pointInsidePrimitive(prim, pt) {
        if (prim.type === 'circle') {
            const dx = pt.x - prim.center.x;
            const dy = pt.y - prim.center.y;
            return (dx*dx + dy*dy) <= prim.radius * prim.radius;
        }
        if (prim.type === 'rectangle') {
            return pt.x >= prim.position.x && pt.x <= prim.position.x + prim.width
                && pt.y >= prim.position.y && pt.y <= prim.position.y + prim.height;
        }
        if (prim.type === 'obround') {
            const x = prim.position.x, y = prim.position.y;
            const w = prim.width, h = prim.height;
            const r = Math.min(w, h) / 2;
            // Fast reject on outer bbox first.
            if (pt.x < x || pt.x > x + w || pt.y < y || pt.y > y + h) return false;
            // Inner rect (between cap centres) is always inside.
            if (w > h) {
                if (pt.x >= x + r && pt.x <= x + w - r) return true;
                const cap = pt.x < x + r ? { x: x + r, y: y + r } : { x: x + w - r, y: y + r };
                const dx = pt.x - cap.x, dy = pt.y - cap.y;
                return dx*dx + dy*dy <= r*r;
            } else {
                if (pt.y >= y + r && pt.y <= y + h - r) return true;
                const cap = pt.y < y + r ? { x: x + r, y: y + r } : { x: x + r, y: y + h - r };
                const dx = pt.x - cap.x, dy = pt.y - cap.y;
                return dx*dx + dy*dy <= r*r;
            }
        }
        if (prim.contours) {
            // Even-odd across all contours so holes punch through.
            let inside = false;
            for (const c of prim.contours) {
                if (pointInPolygon(pt, c.points)) inside = !inside;
            }
            return inside;
        }
        return false;
    }

    function pointInPolygon(p, points) {
        // Prefer the canonical implementation when available - it handles
        // edge cases (vertex hits, horizontal edges) that the inline version
        // gets wrong in pathological inputs.
        if (typeof GeometryUtils !== 'undefined' && GeometryUtils.pointInPolygon) {
            return GeometryUtils.pointInPolygon(p, points);
        }
        if (!points || points.length < 3) return false;
        let inside = false;
        for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
            const pi = points[i], pj = points[j];
            if (((pi.y > p.y) !== (pj.y > p.y)) &&
                (p.x < (pj.x - pi.x) * (p.y - pi.y) / ((pj.y - pi.y) || 1e-12) + pi.x)) {
                inside = !inside;
            }
        }
        return inside;
    }

    function pointNearPolyline(p, points, tol) {
        if (!points || points.length < 2) return false;
        const tolSq = tol * tol;
        for (let i = 1; i < points.length; i++) {
            if (distSqToSegment(p, points[i - 1], points[i]) <= tolSq) return true;
        }
        return false;
    }

    function distSqToSegment(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq < 1e-12) {
            const ddx = p.x - a.x, ddy = p.y - a.y;
            return ddx * ddx + ddy * ddy;
        }
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + t * dx, cy = a.y + t * dy;
        const ex = p.x - cx, ey = p.y - cy;
        return ex * ex + ey * ey;
    }

    window.SceneNode = SceneNode;
    window.GroupNode = GroupNode;
    window.ShapeNode = ShapeNode;
    window.SelectionSet = SelectionSet;
    window.Scene = Scene;
})();