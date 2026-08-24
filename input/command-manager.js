/*!
 * @file        input/command-manager.js
 * @description Command pattern history for EasyShape (and any future app
 *              needing undo/redo). Commands store deltas, not snapshots,
 *              so memory cost stays flat regardless of scene size.
 *
 *              The controller is passed into each command's execute/undo
 *              so commands can reach scene, selection, and trigger UI
 *              refresh via controller.afterMutation().
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

    /** Base class - subclass and override execute/undo. */
    class Command {
        execute(ctrl) {}
        undo(ctrl) {}
        get label() { return 'Action'; }
    }

    /** Multiple commands as one undoable unit. Used for multi-action gestures. */
    class CompositeCommand extends Command {
        constructor(commands, label = 'Composite') {
            super();
            this.commands = commands;
            this._label = label;
        }
        execute(ctrl) {
            for (const c of this.commands) c.execute(ctrl);
        }
        undo(ctrl) {
            for (let i = this.commands.length - 1; i >= 0; i--) {
                this.commands[i].undo(ctrl);
            }
        }
        get label() { return this._label; }
    }

    /**
     * Move N shapes by a 2D delta. Stores only shape IDs and the delta -
     * a few dozen bytes regardless of shape complexity.
     *
     * The delta is in WORLD space. If a node sits inside a parent group
     * that has rotation or non-uniform scale, the world delta is projected
     * through the inverse of the parent's linear transform so the node
     * moves along the correct screen axis.
     */
    class TranslateCommand extends Command {
        constructor(nodeIds, dx, dy) {
            super();
            this.nodeIds = [...nodeIds];
            this.dx = dx;
            this.dy = dy;
        }
        execute(ctrl) {
            for (const id of this.nodeIds) {
                const n = ctrl.scene.findNode(id);
                if (n && !n.isLocked) {
                    const local = TranslateCommand.toLocalDelta(n, this.dx, this.dy);
                    n.translateBy(local.x, local.y);
                }
            }
            ctrl.afterMutation();
        }
        undo(ctrl) {
            for (const id of this.nodeIds) {
                const n = ctrl.scene.findNode(id);
                if (n && !n.isLocked) {
                    const local = TranslateCommand.toLocalDelta(n, -this.dx, -this.dy);
                    n.translateBy(local.x, local.y);
                }
            }
            ctrl.afterMutation();
        }
        get label() { return `Move ${this.nodeIds.length} item(s)`; }

        /**
         * Projects a world-space direction vector into the node's parent
         * coordinate space. When parent is root or has identity rotation/scale,
         * this is a no-op (returns the input unchanged).
         */
        static toLocalDelta(node, dx, dy) {
            if (!node.parent || node.parent.kind === 'root') {
                return { x: dx, y: dy };
            }
            const parentWorld = node.parent.getWorldMatrix();
            const inv = TransformMath.invert(parentWorld);
            if (!inv) return { x: dx, y: dy };
            // Transform direction vector (not point) - use linear part only
            return {
                x: inv.a * dx + inv.c * dy,
                y: inv.b * dx + inv.d * dy
            };
        }
    }

    /**
     * Assign or clear an operation on N shapes. `entries` is built by the
     * controller - each entry captures the previous and new op so undo is
     * symmetric (it can revert to whatever was there before, including
     * different-typed operations across the selection).
     */
    class AssignOperationCommand extends Command {
        constructor(entries, labelVerb = 'Assign') {
            super();
            // Shallow-clone the op refs so external mutation can't poison history.
            this.entries = entries.map(e => ({
                shapeId: e.shapeId,
                prevOp: e.prevOp ? { ...e.prevOp, params: { ...(e.prevOp.params || {}) } } : null,
                newOp:  e.newOp  ? { ...e.newOp,  params: { ...(e.newOp.params  || {}) } } : null
            }));
            this.labelVerb = labelVerb;
        }
        execute(ctrl) {
            for (const e of this.entries) {
                const s = ctrl.scene.findShape(e.shapeId);
                if (!s) continue;
                s.operation = e.newOp ? { ...e.newOp, params: { ...(e.newOp.params || {}) } } : null;
            }
            ctrl.afterFlagMutation();
        }
        undo(ctrl) {
            for (const e of this.entries) {
                const s = ctrl.scene.findShape(e.shapeId);
                if (!s) continue;
                s.operation = e.prevOp ? { ...e.prevOp, params: { ...(e.prevOp.params || {}) } } : null;
            }
            ctrl.afterFlagMutation();
        }
        get label() { return `${this.labelVerb} operation (${this.entries.length})`; }
    }

    /**
     * Delete N shapes. The shape NODE itself is kept by reference so undo
     * just re-inserts it.
     *
     * snapshots: [{ shape: ShapeNode, parentId: string|null, indexInParent: number }]
     */
    class DeleteShapesCommand extends Command {
        constructor(snapshots) {
            super();
            this.snapshots = snapshots;
            // Remember selection so undo restores the user's mental state.
            this.priorSelection = null;
        }
        execute(ctrl) {
            if (this.priorSelection === null) {
                this.priorSelection = [...ctrl.selection.toSet()];
            }
            for (const snap of this.snapshots) {
                ctrl.scene.removeNode(snap.shape.id);
            }
            ctrl.selection.clear();
            ctrl.afterMutation();
        }
        undo(ctrl) {
            // Re-insert in original order - earliest index first works because
            // siblings beyond the index don't matter for our flat slot model.
            const sorted = [...this.snapshots].sort((a, b) => a.indexInParent - b.indexInParent);
            for (const snap of sorted) {
                ctrl.scene.reinsertShape(snap.shape, snap.parentId, snap.indexInParent);
            }
            ctrl.selection.replace(this.priorSelection || []);
            ctrl.scene.recomputeBoardBoundsFromShapes?.();
            ctrl.afterMutation();
        }
        get label() { return `Delete ${this.snapshots.length} shape(s)`; }
    }

    class CommandManager {
        constructor(ctrl, options = {}) {
            this.ctrl = ctrl;
            this.undoStack = [];
            this.redoStack = [];
            this.maxSize = options.maxSize || 200;
            this.listeners = [];
        }

        /** Run the command's forward action AND record it. */
        executeAndRecord(cmd) {
            cmd.execute(this.ctrl);
            this.record(cmd);
        }

        /** For mutations already applied externally (e.g. live drag). */
        record(cmd) {
            this.undoStack.push(cmd);
            if (this.undoStack.length > this.maxSize) this.undoStack.shift();
            this.redoStack.length = 0;  // any new mutation kills old redo future branch
            this.fire();
        }

        undo() {
            const cmd = this.undoStack.pop();
            if (!cmd) return false;
            cmd.undo(this.ctrl);
            this.redoStack.push(cmd);
            this.fire();
            return true;
        }

        redo() {
            const cmd = this.redoStack.pop();
            if (!cmd) return false;
            cmd.execute(this.ctrl);
            this.undoStack.push(cmd);
            this.fire();
            return true;
        }

        canUndo() { return this.undoStack.length > 0; }
        canRedo() { return this.redoStack.length > 0; }

        clear() {
            this.undoStack.length = 0;
            this.redoStack.length = 0;
            this.fire();
        }

        getTopUndoLabel() { return this.canUndo() ? this.undoStack[this.undoStack.length - 1].label : null; }
        getTopRedoLabel() { return this.canRedo() ? this.redoStack[this.redoStack.length - 1].label : null; }

        addListener(fn) { this.listeners.push(fn); }
        removeListener(fn) { this.listeners = this.listeners.filter(l => l !== fn); }
        fire() { for (const fn of this.listeners) fn(this); }
    }

    class GroupCommand extends Command {
        constructor(nodeSnapshots, insertParentId, insertIndex, groupId) {
            super();
            this.nodeSnapshots = nodeSnapshots;
            this.insertParentId = insertParentId;
            this.insertIndex = insertIndex;
            this.groupId = groupId;
        }
        execute(ctrl) {
            const group = new GroupNode('Group');
            group.id = this.groupId;
            ctrl.scene.reinsertShape(group, this.insertParentId, this.insertIndex);
            for (const snap of this.nodeSnapshots) {
                const node = ctrl.scene.findNode(snap.nodeId);
                if (node) ctrl.scene.reinsertShape(node, group.id);
            }
            ctrl.selection.replace([group.id]);
            ctrl.scene.recomputeBoardBoundsFromShapes?.();
            ctrl.afterMutation();
        }
        undo(ctrl) {
            const sorted = [...this.nodeSnapshots].sort((a, b) => a.indexInParent - b.indexInParent);
            for (const snap of sorted) {
                const node = ctrl.scene.findNode(snap.nodeId);
                if (node) ctrl.scene.reinsertShape(node, snap.parentId, snap.indexInParent);
            }
            ctrl.scene.removeNode(this.groupId);
            ctrl.selection.replace(this.nodeSnapshots.map(s => s.nodeId));
            ctrl.afterMutation();
        }
        get label() { return `Group ${this.nodeSnapshots.length} item(s)`; }
    }

    class UngroupCommand extends Command {
        constructor(groupSnapshot, childrenSnapshots) {
            super();
            this.groupSnapshot = groupSnapshot;
            this.childrenSnapshots = childrenSnapshots;
        }
        execute(ctrl) {
            const group = ctrl.scene.findNode(this.groupSnapshot.nodeId);
            if (!group) return;
            // Fold the group's local transform into each child so its WORLD
            // position survives losing the group from its parent chain:
            //   childLocal_new = groupLocal x childLocal_old
            // Compute every matrix BEFORE mutating the tree.
            const groupLocalM = group.getLocalMatrix();
            const sorted = [...this.childrenSnapshots].sort((a, b) => a.indexInParent - b.indexInParent);
            const rebases = [];
            for (const snap of sorted) {
                const node = ctrl.scene.findNode(snap.nodeId);
                if (!node) continue;
                const newLocalM = TransformMath.multiply(groupLocalM, node.getLocalMatrix());
                const pivot = node.transform.rotationCenter || node.getLocalBoundsCentre();
                rebases.push({ node, trs: TransformMath.decomposeToTRS(newLocalM, pivot) });
            }
            for (const { node, trs } of rebases) {
                node.transform.x = trs.x;
                node.transform.y = trs.y;
                node.transform.rotation = trs.rotation;
                node.transform.scaleX = trs.scaleX;
                node.transform.scaleY = trs.scaleY;
                node.markDirty();
            }
            for (const snap of sorted) {
                const node = ctrl.scene.findNode(snap.nodeId);
                if (node) ctrl.scene.reinsertShape(node, snap.newParentId, snap.newIndex);
            }
            ctrl.scene.removeNode(this.groupSnapshot.nodeId);
            ctrl.selection.replace(this.childrenSnapshots.map(s => s.nodeId));
            ctrl.afterMutation();
        }
        undo(ctrl) {
            const group = new GroupNode(this.groupSnapshot.label || 'Group');
            group.id = this.groupSnapshot.nodeId;
            // Restore the group's own transform (lost when the node was destroyed).
            const gt = this.groupSnapshot.transform;
            if (gt) {
                group.transform.x = gt.x; group.transform.y = gt.y; group.transform.rotation = gt.rotation;
                group.transform.scaleX = gt.scaleX; group.transform.scaleY = gt.scaleY;
                group.transform.rotationCenter = gt.rotationCenter ? { x: gt.rotationCenter.x, y: gt.rotationCenter.y } : null;
            }
            ctrl.scene.reinsertShape(group, this.groupSnapshot.parentId, this.groupSnapshot.indexInParent);
            for (const snap of this.childrenSnapshots) {
                const node = ctrl.scene.findNode(snap.nodeId);
                if (!node) continue;
                // Undo the rebase: restore each child's pre-ungroup local transform.
                const ct = snap.transform;
                if (ct) {
                    node.transform.x = ct.x; node.transform.y = ct.y; node.transform.rotation = ct.rotation;
                    node.transform.scaleX = ct.scaleX; node.transform.scaleY = ct.scaleY;
                    node.transform.rotationCenter = ct.rotationCenter ? { x: ct.rotationCenter.x, y: ct.rotationCenter.y } : null;
                    node.markDirty();
                }
                ctrl.scene.reinsertShape(node, group.id);
            }
            ctrl.selection.replace([group.id]);
            ctrl.scene.recomputeBoardBoundsFromShapes?.();
            ctrl.afterMutation();
        }
        get label() { return `Ungroup`; }
    }

    /**
     * Toggles `visible` or `locked` on a set of shapes. Both are simple
     * boolean flips so one command class handles both via a `flag` field.
     */
    class SetNodeFlagCommand extends Command {
        constructor(entries, flag) {
            super();
            this.entries = entries.map(e => ({ ...e }));
            this.flag = flag; // 'visible' | 'locked'
        }
        execute(ctrl) {
            for (const e of this.entries) {
                const n = ctrl.scene.findNode(e.nodeId);
                if (n) n[this.flag] = e.newValue;
            }
            ctrl.afterFlagMutation();
        }
        undo(ctrl) {
            for (const e of this.entries) {
                const n = ctrl.scene.findNode(e.nodeId);
                if (n) n[this.flag] = e.prevValue;
            }
            ctrl.afterFlagMutation();
        }
        get label() {
            const verb = this.flag === 'visible'
                ? (this.entries[0]?.newValue ? 'Show' : 'Hide')
                : (this.entries[0]?.newValue ? 'Lock' : 'Unlock');
            return `${verb} ${this.entries.length} item(s)`;
        }
    }

    /**
     * Sets one or more transform components (x, y, rotation, scaleX, scaleY)
     * on a single shape. Multi-shape edits compose multiple instances.
     *
     * fields: { x?, y?, rotation?, scaleX?, scaleY? }   (only fields to change)
     * The prevTransform snapshot is captured at construction so undo restores
     * exactly what was there even if other code mutated the shape between
     * commands.
     */
    class SetShapeTransformCommand extends Command {
        constructor(shapeId, prevTransform, newFields) {
            super();
            this.shapeId = shapeId;
            this.prev = { ...prevTransform };
            this.next = { ...prevTransform, ...newFields };
        }
        apply(ctrl, t) {
            const s = ctrl.scene.findNode(this.shapeId);
            if (!s) return;
            s.transform.x = t.x;
            s.transform.y = t.y;
            s.transform.rotation = t.rotation;
            s.transform.scaleX = t.scaleX;
            s.transform.scaleY = t.scaleY;
            if ('rotationCenter' in t) {
                s.transform.rotationCenter = t.rotationCenter
                    ? { x: t.rotationCenter.x, y: t.rotationCenter.y }
                    : null;
            }
            s.markDirty();
        }
        execute(ctrl) { this.apply(ctrl, this.next); ctrl.afterMutation(); }
        undo(ctrl)    { this.apply(ctrl, this.prev); ctrl.afterMutation(); }
        get label() { return 'Edit transform'; }
    }

    window.Command = Command;
    window.CompositeCommand = CompositeCommand;
    window.TranslateCommand = TranslateCommand;
    window.GroupCommand = GroupCommand;
    window.UngroupCommand = UngroupCommand;
    window.AssignOperationCommand = AssignOperationCommand;
    window.DeleteShapesCommand = DeleteShapesCommand;
    window.SetNodeFlagCommand = SetNodeFlagCommand;
    window.SetShapeTransformCommand = SetShapeTransformCommand;
    window.CommandManager = CommandManager;
})();