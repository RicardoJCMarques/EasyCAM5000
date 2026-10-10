/*!
 * @file        easyshape5000/cam-easyshape5000.js
 * @description EasyShape5000 application controller - owns scene, history,
 *              mutations, modals, and keyboard. Delegates all UI to EasyShapeUI.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const D = window.CAMConfig.defaults;
    const decimals = D.geometry.decimals.coordinates;

    class EasyShapeController extends CamController {
        constructor() {
            super();
            this.scene = null;
            this.selection = null;
            this.history = null;
            // Dimensions this session's workspace can present. The 2D workspace
            // has no way to draw a field-generated surface, so the op-type strip
            // must not offer one. null = no restriction.
            this.workspaceDimensions = null;
            // Where Fit to Object put the stock: its world-space min corner, and
            // the margin drawn past both faces of the cut slab. Session state,
            // like the scene it was fitted to.
            this.stockPlacement = { minX: 0, minY: 0, marginZ: 0 };
            this._hasFitStockOnce = false;
            // Center / Bottom-Left last used; Fit to Object puts the origin there.
            this.originAnchor = 'bottom-left';
        }

        // ════════════════════════════════════════════════════════════════
        // Template Hooks
        // ════════════════════════════════════════════════════════════════

        getAppLabel() { return 'EasyShape5000 Router Workspace'; }

        getProfileConfig() {
            return { embeddedVar: 'EMBEDDED_PROFILE_SHAPE', fetchPath: '../ui/profile-shape.json' };
        }

        onCoreReady() {
            this.scene = this.core.scene;
            this.selection = this.scene.selection;
            this.history = new CommandManager(this, { onChange: () => this.ui.updateHistoryButtons() });
        }

        createUI() {
            return new EasyShapeUI(this);
        }

        registerHandlers() {
            super.registerHandlers();
            // Spin the field worker pool up during idle so the first
            // relief/rotary/vcarve generation doesn't pay importScripts
            // cold-start. Safe if the pool fails - sync paths take over.
            if (window.requestIdleCallback) {
                requestIdleCallback(() => window.FieldWorkerClient?.warmUp());
            } else {
                setTimeout(() => window.FieldWorkerClient?.warmUp(), 2000);
            }
        }

        registerAppShortcuts() {
            const deleteSelection = () => {
                if (this.selection.size() > 0) this.deleteShapes(Array.from(this.selection.toSet()));
            };
            this.shortcutManager.registerActions({
                undo: () => this.history.undo(),
                redo: () => this.history.redo(),
                group: () => this.groupSelection(),
                ungroup: () => this.ungroupSelection(),
                selectAll: () => {
                    const ids = [];
                    for (const child of this.scene.root.children) ids.push(child.id);
                    if (ids.length > 0) this.selection.replace(ids);
                },
                deleteSelection,
                addFiles: () => this.modalManager.showModal('quickstart'),
                bottomLeftOrigin: () => this.placeOrigin('bottom-left'),
                centerOrigin: () => this.placeOrigin('center'),
                pan: (e, mx, my) => {
                    if (this.renderMode === '3d') return; // Pan does nothing in 3D
                    if (document.activeElement?.closest('#sidebar-left, #sidebar-right')) return;
                    const amount = e.shiftKey ? 100 : 25;
                    this.ui.renderer.pan(mx * amount, my * amount);
                    this.ui.renderer.render();
                }
            });
        }

        onBindEvents() {
            this.selection.addChangeListener(() => this.ui.onSelectionChanged());
            document.getElementById('toolbar-import-svg')?.addEventListener('click', () => {
                this.importGeometry();
                this.closeDropdown();
            });
            const container = document.getElementById('preview-canvas')?.parentElement;
            if (container) {
                container.addEventListener('dragover', e => {
                    if (!document.querySelector('.modal.active')) e.preventDefault();
                });
                container.addEventListener('drop', async e => {
                    if (document.querySelector('.modal.active')) return;
                    e.preventDefault();
                    // filesFromDrop reads the DataTransfer before this handler yields.
                    await this.ingestFiles(await UIControls.filesFromDrop(e.dataTransfer));
                });
            }
            document.getElementById('btn-undo')?.addEventListener('click', () => {
                const lbl = this.history.getTopUndoLabel();
                if (this.history.undo()) this.ui.setStatus(`Undo: ${lbl}`);
            });
            document.getElementById('btn-redo')?.addEventListener('click', () => {
                if (this.history.redo()) this.ui.setStatus(`Redo: ${this.history.getTopUndoLabel() || ''}`);
            });
            this.setupStockAndMachine();
        }

        onFinalize() {
            this.ui.renderAll();
            this.modalManager.showStartupModal();
        }

        /**
         * Welcome-modal card → app action. EasyShape5000 is CNC-only; the 3D card
         * selects the workspace, not a pipeline.
         */
        onPipelineSelected(pipelineId) {
            this.setMachineClass('router');
            if (pipelineId === '3d') {
                this.setWorkspaceDimensions(null);
                queueMicrotask(() => this.toggle3DMode());
            } else {
                this.setWorkspaceDimensions(['2d', '2.5d']);
            }
            return 'quickstart';
        }

        /** @param {?string[]} dims - null clears the restriction. */
        setWorkspaceDimensions(dims) {
            this.workspaceDimensions = dims ? new Set(dims) : null;
            this.ui.initOpTypeTabs();
        }

        allowsOperationType(type) {
            if (!this.workspaceDimensions) return true;
            const dim = this.registry.dimensionFor(type, this.core.machineClassForType(type));
            return !dim || this.workspaceDimensions.has(dim);
        }

        /**
         * A mesh-only scene has no 2D drawing worth switching to.
         */
        has2DContent() {
            let any = false;
            for (const shape of this.scene.allShapes()) {
                any = true;
                if (!shape.mesh?.triangles?.length) return true;
            }
            return !any; // empty scene: leave the toggle free
        }

        getQuickstartOpTypes() { return ['unassigned']; }

        getTreeFocusSelector() { return '#scene-tree-list [tabindex="0"]'; }

        handleEscapeKey(e) {
            if (this.selection.size() > 0) this.selection.clear();
        }

        // ════════════════════════════════════════════════════════════════
        // 3D Render Mode
        // ════════════════════════════════════════════════════════════════

        get3DStockBox(w2m) {
            const stock = this.core.stock;
            if (!(stock.width > 0 && stock.length > 0)) return null;
            const { minX, minY, marginZ } = this.stockPlacement;
            const surfaceZ = stock.zeroReference && stock.zeroReference !== 'material' ? stock.thickness : 0;
            const machineMatrix = this.core.pipelineContext.getTransforms().machineMatrix;
            // The slab is the cut reference; the margin Fit applied is drawn past
            // both of its faces and is never read by the pipeline.
            return {
                width: stock.width,
                depth: stock.length,
                thickness: stock.thickness + 2 * marginZ,
                topZ: surfaceZ + marginZ,
                surfaceZ,
                centerX: minX + stock.width / 2,
                centerY: minY + stock.length / 2,
                matrix: machineMatrix
            };
        }

        /**
         * EasyShape's model layer: the relief/rotary mesh and whichever blank
         * the operation implies. The stock slab, the layer mirror and the plan
         * push are the base class's.
         */
        refresh3DModel(ctx) {
            const { view, machineMatrix, topZ } = ctx;
            // Model and frame come from ONE operation, so a two-model scene can
            // never draw one shape's mesh inside another shape's blank.
            const meshOp =
                this.core.operations.find(
                    (op) => op.sourceMesh?.triangles?.length && op.offsets?.[0]?.metadata?.is3DToolpath,
                ) || null;
            const meta = meshOp?.offsets?.[0]?.metadata || null;
            let meshTris = null;
            let meshNodeId = null;
            let orient = null;
            let offsetX = 0, offsetY = 0, offsetZ = 0;
            if (meshOp) {
                meshNodeId =
                    this.ui.opsPanel.getBucket(meshOp.id)?.shapeRefs.find((id) => this.scene.findShape(id)?.mesh) ||
                    null;
                if (meshNodeId && !this.scene.findShape(meshNodeId).isVisible) {
                    view.stock.removeTriangleMesh();
                    return meta;
                }
            }
            if (meshOp && meta.developedSpace && meta.refRadius > 0 && meta.axisCenter) {
                // Rotary, in the MACHINE frame. The mesh is the operation's
                // (already XY-transformed) copy, rotated by the VISUAL orient
                // only - the slicer's internal axis mapping is not a physical
                // rotation of the part and must not reach the renderer.
                orient = meta.rotaryFrame?.orient || null;
                // The rotary centreline is cross = 0, Z = 0: what the A/B word
                // turns about, and where both export paths put it
                // (convertDevelopedToRotary adds refRadius, insertIndexMoves
                // adds apothem).
                const shift = meta.axialShift || 0;
                const crossOff = -meta.axisCenter.b;
                if ('y' === meta.rotaryAxis) {
                    offsetX = crossOff;
                    offsetY = shift;
                } else {
                    offsetX = shift;
                    offsetY = crossOff;
                }
                offsetZ = -meta.axisCenter.c;
                // Cell CENTRES: originX is column 0's centre, so the grid spans
                // (cols - 1) cells, not cols.
                const len = (meta.gridCols - 1) * meta.cellSize;
                const along = (meta.originX ?? 0) + len / 2;
                view.stock.setRotaryBlank({
                    refRadius: meta.refRadius,
                    length: len,
                    axis: meta.rotaryAxis,
                    center: 'y' === meta.rotaryAxis ? { x: 0, y: along, z: 0 } : { x: along, y: 0, z: 0 },
                });
                meshTris = meshOp.sourceMesh.triangles;
            } else if (meshOp && meta.indexedFrame) {
                // Indexed 3+1: match the frame the toolpaths are wrapped in
                // (walkPlans + GeometryLayer3D) - rotation axis at
                // Z = baseZ - apothem, cross axis at 0. Slicing subtracts Cvis,
                // so exported paths are axis-centered: shift the mesh by
                // -axisCenter.b on the CROSS axis and leave the AXIAL one at 0.
                const f = meta.indexedFrame;
                orient = f.orient || null;
                const ixShift = f.axialShift || 0;
                if ('y' === f.machineAxis) { offsetX = -f.axisCenter.b; offsetY = ixShift; }
                else { offsetX = ixShift; offsetY = -f.axisCenter.b; }
                offsetZ = -f.axisCenter.c;
                // Indexed blank: an N-gon prism about the axis, drawn from the
                // SAME clearRadius insertIndexMoves lifts its rotation moves
                // above, so a bad apothem or a blank the tool would hit shows
                // before the cut. Every input comes from indexedFrame, so a
                // half-populated frame draws nothing rather than a wrong prism.
                const ixLen = Math.max(0, (f.gridCols || 1) - 1) * (f.cellSize || 0);
                const ixAlong = (f.originX ?? 0) + ixLen / 2;
                view.stock.setIndexedBlank({
                    clearRadius: f.clearRadius,
                    length: ixLen,
                    axis: f.machineAxis,
                    faces: f.faceCount,
                    startAngleDeg: f.startAngle,
                    // Cross 0, NOT axisCenter.b: the plans are axis-centered and
                    // the mesh above is shifted to match.
                    center: 'y' === f.machineAxis ? { x: 0, y: ixAlong, z: 0 } : { x: ixAlong, y: 0, z: 0 },
                });
                meshTris = meshOp.sourceMesh.triangles;
            } else if (meshOp) {
                // Flat relief. sourceMesh already carries the shape's world TRS
                // (syncPrimitives baked it), so only the machine map is left. The
                // workspace matrix carries no scale, so Z passes through.
                view.stock.removeRotaryBlank();
                offsetZ = topZ - meshOp.sourceMesh.bounds3D.maxZ;
                meshTris = Transform3D.transformTrianglesByAffine2D(meshOp.sourceMesh.triangles, machineMatrix, 1).triangles;
            } else {
                // Selected/pre-generation stage: honor node visibility and bake total transform directly into vertices
                view.stock.removeRotaryBlank();
                const parts = [];
                for (const sid of this.scene.collectShapeIds(this.scene.root)) {
                    const s = this.scene.findShape(sid);
                    if (!s?.mesh?.triangles?.length || !s.isVisible) continue;
                    const wm = s.getWorldMatrix();
                    const totalM = TransformMath.isIdentity(machineMatrix) ? wm : TransformMath.multiply(machineMatrix, wm);
                    const sc = Math.hypot(wm.a, wm.b) || 1;
                    parts.push({
                        nodeId: s.id,
                        triangles: Transform3D.transformTrianglesByAffine2D(s.mesh.triangles, totalM, sc).triangles,
                        dz: topZ - s.mesh.bounds3D.maxZ * sc,
                    });
                }
                if (1 === parts.length) {
                    meshNodeId = parts[0].nodeId;
                    meshTris = parts[0].triangles;
                    offsetZ = parts[0].dz;
                } else if (parts.length > 1) {
                    // One mesh for the view, each part dropped to its own top. The
                    // transform can return the source array, so parts are copied,
                    // never shifted in place. A merged mesh has no single node to pick.
                    meshTris = new Float32Array(parts.reduce((n, p) => n + p.triangles.length, 0));
                    let at = 0;
                    for (const { triangles, dz } of parts) {
                        for (let i = 0; i < triangles.length; i += 3) {
                            meshTris[at + i] = triangles[i];
                            meshTris[at + i + 1] = triangles[i + 1];
                            meshTris[at + i + 2] = triangles[i + 2] + dz;
                        }
                        at += triangles.length;
                    }
                }
            }

            if (meshTris) {
                view.stock.setTriangleMesh(meshTris, {
                    offsetX: offsetX,
                    offsetY: offsetY,
                    offsetZ: offsetZ,
                    orient: orient,
                    nodeId: meshNodeId
                });
            } else {
                view.stock.removeTriangleMesh();
            }
            return meta;
        }

        /**
         * Maps a 3D raycast hit back to a scene node and drives the SAME
         * selection set the tree and 2D tools use, so the parameter panel
         * reacts identically. Batched layers aren't node-addressable and
         * are ignored; per-shape layers (shape_<id>) and tagged meshes work.
         */
        on3DPick(hit) {
            let nodeId = hit.nodeId;
            if (!nodeId && hit.layerName?.startsWith('shape_')) {
                nodeId = hit.layerName.slice('shape_'.length);
            }
            if (!nodeId || !this.scene.findNode(nodeId)) return;
            this.scene.selection.replace([nodeId]);
            this.ui.renderAll();
        }

        // ════════════════════════════════════════════════════════════════
        // File Import
        // ════════════════════════════════════════════════════════════════

        /**
         * Standardized entry point for ModalManager/Quickstart.
         * Routes files to the correct importer based on extension.
         */
        async processFile(file, type) {
            if (!file) return;
            const ext = file.name.toLowerCase().split('.').pop();

            if (ext === 'svg') {
                await this.importSVG(file);
            } else if (ext === 'stl') {
                await this.importSTL(file);
            } else {
                this.ui.setStatus(`Unsupported file type: .${ext}`, 'warning');
            }
        }

        /**
         * Imports an STL as first-class scene objects: one ShapeNode per solid,
         * whose primitive is the solid's XY bounding box (selectable in
         * tree/canvas, draggable, bucket-assignable), carrying its triangle soup
         * on node.mesh. The relief OPERATION is created later through the
         * normal bucket flow - OperationBucket.syncPrimitives hands the mesh to
         * operation.sourceMesh, and ShapeReliefHandler slices it into a
         * heightmap on demand. File Z is pipeline-irrelevant (heightmap
         * normalizes; carve depth = relief params).
         */
        async importSTL(file) {
            if (!file) return;
            this.ui.setStatus(`Loading ${file.name}…`);
            let buffer;
            try { buffer = await file.arrayBuffer(); }
            catch (err) { this.ui.setStatus(`Failed to read ${file.name}: ${err.message}`, 'error'); return; }
            const parseResult = new STLParser().parse(buffer);
            if (!parseResult.success) {
                this.ui.setStatus(`STL parse error: ${parseResult.errors?.join('; ') || 'Unknown'}`, 'error');
                return;
            }
            const { solids } = parseResult;
            const boxes = solids.map(
                ({ bounds3D: b3 }) =>
                    new RectanglePrimitive({ x: b3.minX, y: b3.minY }, b3.maxX - b3.minX, b3.maxY - b3.minY, {
                        role: 'relief_mesh',
                        fill: false,
                        stroke: true,
                        strokeWidth: 0,
                        meshHeight: b3.maxZ - b3.minZ,
                    }),
            );
            this.scene.addShapesFromPlot(boxes, file.name);
            // A fresh file group, one child per primitive, in order.
            const nodes = this.scene.fileRoots.get(file.name)?.children || [];
            const stem = file.name.replace(/\.stl$/i, '');
            solids.forEach((solid, i) => {
                const node = nodes[i];
                if (!node) return;
                node.label = solids.length > 1 ? `${solid.name || `${stem} ${i + 1}`} (mesh)` : `${stem} (mesh)`;
                // node.mesh holds raw untransformed STL vertices for the scene graph.
                // OperationBucket.syncPrimitives bakes world transforms into operation.sourceMesh during generation.
                node.mesh = {
                    triangles: solid.triangles,
                    triangleCount: solid.triangles.length / 9,
                    bounds3D: solid.bounds3D,
                };
            });
            this.history.clear();
            this.scene.recomputeBoardBoundsFromShapes();
            this.ui.renderAll();
            this.ui.zoomFit();
            const minZ = Math.min(...solids.map((s) => s.bounds3D.minZ));
            const maxZ = Math.max(...solids.map((s) => s.bounds3D.maxZ));
            const meshNote = solids.length > 1 ? ` in ${solids.length} meshes` : '';
            this.ui.setStatus(
                `Loaded ${file.name}: ${parseResult.triangleCount} triangles${meshNote}, ${(maxZ - minZ).toFixed(2)}mm model height`,
                'success'
            );
        }

        async importSVG(file) {
            if (!file) return;
            this.ui.setStatus(`Loading ${file.name}…`);
            let content;
            try { content = await file.text(); }
            catch (err) { this.ui.setStatus(`Failed to read ${file.name}: ${err.message}`, 'error'); return; }

            const parser = new SVGParser();
            const parseResult = parser.parse(content);
            if (!parseResult.success) { this.ui.setStatus(`Parse error: ${(parseResult.errors?.join('; ')) || 'Unknown'}`, 'error'); return; }
            if (parseResult.warnings?.length > 0) for (const w of parseResult.warnings) console.warn(`[EasyShape] SVG warning:`, w);

            const plotter = new ParserPlotter({ markStrokes: true });
            const plotResult = plotter.plot(parseResult);
            if (!plotResult.success) { this.ui.setStatus(`Plotter error: ${plotResult.error}`, 'error'); return; }

            const beforeCount = this.scene.shapeCount();
            this.scene.addShapesFromPlot(plotResult.primitives, file.name);

            // Collapse imported groups
            // REVIEW - This works a bit too well, the UI hides it a bit too much, should the first added object get automatically selected? That UX could be relevant for EasyTrace5000 too?
            // const fileGroup = this.scene.fileRoots?.get(file.name);
            // if (fileGroup) {
            //     const collapseAll = (node) => {
            //         if (node.kind === 'group') node.collapsed = true;
            //         if (node.children) node.children.forEach(collapseAll);
            //     };
            //     collapseAll(fileGroup);
            // }

            const added = this.scene.shapeCount() - beforeCount;

            this.history.clear();
            this.scene.recomputeBoardBoundsFromShapes();
            this.ui.renderAll();
            this.ui.zoomFit();
            this.ui.setStatus(`Imported ${file.name}: ${added} shape(s)`, 'success');
        }

        // ════════════════════════════════════════════════════════════════
        // Mutation Helpers
        // ════════════════════════════════════════════════════════════════

        canMutateNode(node) {
            return !!node && !node.isLocked && !node.hasLockedDescendant;
        }

        getActionableIds() {
            return this.selection.toArray().filter(id => this.canMutateNode(this.scene.findNode(id)));
        }

        getTopLevelActionableIds(idList = null) {
            const selected = new Set(idList || this.selection.toArray());
            const topLevel = new Set();
            for (const id of selected) {
                const node = this.scene.findNode(id);
                if (!this.canMutateNode(node)) continue;
                let isChild = false, p = node.parent;
                while (p && p.kind !== 'root') { if (selected.has(p.id)) { isChild = true; break; } p = p.parent; }
                if (!isChild) topLevel.add(id);
            }
            return Array.from(topLevel);
        }

        // ════════════════════════════════════════════════════════════════
        // Shape Mutations
        // ════════════════════════════════════════════════════════════════

        deleteShapes(ids) {
            const snapshots = [];
            for (const id of ids) {
                const node = this.scene.findNode(id);
                if (!node) continue;
                const parent = node.parent || null;
                snapshots.push({ shape: node, parentId: parent?.id || null, indexInParent: parent ? parent.children.indexOf(node) : -1 });
            }
            if (snapshots.length === 0) return;

            const { removed, pruned } = this.planOrphanedBuckets(ids);
            const shapeText = `${snapshots.length} item${1 === snapshots.length ? "" : "s"}`;
            const opText = removed.length ? ` This also removes ${removed.length} operation${1 === removed.length ? "" : "s"}.` : "";
            this.confirmDestructive("Delete geometry", `Delete ${shapeText}?${opText} This can be undone with Ctrl+Z.`, () => {
                const cmds = [ new DeleteShapesCommand(snapshots) ];
                (removed.length || pruned.length) && cmds.push(new RemoveBucketsCommand(removed, pruned));
                this.history.executeAndRecord(1 === cmds.length ? cmds[0] : new CompositeCommand(cmds, `Delete ${shapeText}`));
            });
        }

        toggleNodeFlag(nodeId, flag) {
            const inSelection = this.selection.has(nodeId);
            let targetIds = inSelection ? Array.from(this.selection.toSet()) : [nodeId];

            if (flag === 'locked') {
                const blocked = [];
                targetIds = targetIds.filter(id => {
                    const n = this.scene.findNode(id);
                    if (!n) return false;
                    if (n.hasLockedAncestor) { blocked.push(id); return false; }
                    return true;
                });
                if (targetIds.length === 0) { this.ui.setStatus('Locked by parent - unlock the parent first', 'warning'); return; }
                if (blocked.length > 0) this.ui.setStatus(`${blocked.length} item(s) skipped (locked by parent)`, 'info');
            }

            let anyFalse = false;
            for (const id of targetIds) { const n = this.scene.findNode(id); if (n && !n[flag]) { anyFalse = true; break; } }
            const newValue = anyFalse;
            const entries = [];
            for (const id of targetIds) { const n = this.scene.findNode(id); if (!n || n[flag] === newValue) continue; entries.push({ nodeId: id, prevValue: n[flag], newValue }); }
            if (entries.length === 0) return;
            if (flag === 'locked' && newValue === true) this.selection.batch(() => { entries.forEach(e => this.selection.remove(e.nodeId)); });
            this.history.executeAndRecord(new SetNodeFlagCommand(entries, flag));
        }

        groupSelection() {
            const ids = this.getActionableIds();
            if (ids.length < 2) { this.ui.setStatus('Select 2 or more items to group'); return; }
            const snapshots = ids.map(id => { const n = this.scene.findNode(id); return { nodeId: id, parentId: n.parent?.id || null, indexInParent: n.parent ? n.parent.children.indexOf(n) : -1 }; });
            const firstNode = this.scene.findNode(ids[0]);
            this.history.executeAndRecord(new GroupCommand(snapshots, firstNode.parent?.id || null, firstNode.parent ? firstNode.parent.children.indexOf(firstNode) : 0, `g_${Date.now()}`));
            this.ui.setStatus(`Grouped ${ids.length} items`, 'success');
        }

        ungroupSelection() {
            const groupIds = this.getActionableIds().filter(id => { const n = this.scene.findNode(id); return n?.kind === 'group' && n.children?.length > 0; });
            if (groupIds.length === 0) { this.ui.setStatus('No groups in selection to ungroup'); return; }
            const commands = [];
            for (const gid of groupIds) {
                const group = this.scene.findNode(gid);
                if (!group) continue;
                const gSnap = { nodeId: group.id, label: group.label, parentId: group.parent?.id || null, indexInParent: group.parent ? group.parent.children.indexOf(group) : -1,
                    transform: { x: group.transform.x, y: group.transform.y, rotation: group.transform.rotation, scaleX: group.transform.scaleX, scaleY: group.transform.scaleY, rotationCenter: group.transform.rotationCenter ? { x: group.transform.rotationCenter.x, y: group.transform.rotationCenter.y } : null } };
                const cSnaps = group.children.map((c, i) => ({ nodeId: c.id, indexInParent: i, newParentId: group.parent?.id || null, newIndex: gSnap.indexInParent + i,
                    transform: { x: c.transform.x, y: c.transform.y, rotation: c.transform.rotation, scaleX: c.transform.scaleX, scaleY: c.transform.scaleY, rotationCenter: c.transform.rotationCenter ? { x: c.transform.rotationCenter.x, y: c.transform.rotationCenter.y } : null } }));
                commands.push(new UngroupCommand(gSnap, cSnaps));
            }
            if (commands.length === 1) this.history.executeAndRecord(commands[0]);
            else if (commands.length > 1) this.history.executeAndRecord(new CompositeCommand(commands, `Ungroup ${commands.length} groups`));
            this.ui.setStatus(`Ungrouped ${commands.length} group(s)`, 'success');
        }

        alignSelectionTo(target) {
            const bounds = this.scene.getSelectionWorldBounds();
            const stock = this.core.stock;
            if (!bounds || !stock || !this.scene) return;
            const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
            let dx = 0, dy = 0;
            const ox = this.scene.transform.origin.x, oy = this.scene.transform.origin.y;
            if (target === 'center') { dx = ox - cx; dy = oy - cy; }
            else if (target === 'bottom-left') { dx = ox - bounds.minX; dy = oy - bounds.minY; }
            if (dx === 0 && dy === 0) return;
            const ids = this.getTopLevelActionableIds();
            if (ids.length === 0) return;
            this.history.executeAndRecord(new TranslateCommand(ids, dx, dy));
        }

        // ════════════════════════════════════════════════════════════════
        // Bucket Lifecycle
        // ════════════════════════════════════════════════════════════════

        /**
         * Which buckets a pending shape deletion would strand, computed BEFORE
         * the scene changes: the delete is recorded as commands, so undo brings
         * the operations back with their shapes.
         */
        planOrphanedBuckets(deletingIds) {
            if (!this.ui.opsPanel) return { removed: [], pruned: [] };
            const doomed = new Set(deletingIds);
            const removed = [];
            const pruned = [];
            for (const bucket of this.ui.opsPanel.getAllBuckets()) {
                const survivors = bucket.shapeRefs.filter(ref => !doomed.has(ref) && this.scene.findShape(ref) !== null);
                if (survivors.length === 0) removed.push(bucket.id);
                else if (survivors.length !== bucket.shapeRefs.length) pruned.push({ bucketId: bucket.id, prevRefs: [...bucket.shapeRefs] });
            }
            return { removed, pruned };
        }

        /**
         * Flag-only mutation: visibility and lock. Repaints the rows and the
         * canvas and NOTHING else. Not an alias for afterMutation, which
         * invalidates every bucket whose shapes are in the selection: a flag
         * flip moves no geometry, so no artifact can go stale because of one.
         */
        afterFlagMutation() {
            this.ui.navScenePanel?.updateFlagStates();
            this.ui.navScenePanel?.syncTreeToolbar(this.selection, this.scene);
            this.ui.rebuildLayers();
        }

        afterMutation() {
            if (this.ui.opsPanel) {
                // Collect IDs of shapes that could have changed
                const changedShapeIds = new Set();
                for (const id of this.selection.toArray()) {
                    const node = this.scene.findNode(id);
                    if (!node) continue;
                    if (node.kind === 'shape') changedShapeIds.add(id);
                    else for (const sid of this.scene.collectShapeIds(node)) changedShapeIds.add(sid);
                }

                for (const bucket of this.ui.opsPanel.getAllBuckets()) {
                    // Only invalidate if this bucket references an affected shape
                    if (!bucket.shapeRefs.some((ref) => changedShapeIds.has(ref))) continue;
                    const reason = 'Source geometry changed. Regenerate offsets.';
                    if (this.core.store.invalidateOperationState(bucket.id, reason)) { this.ui.opsPanel.updateBucketDOM(bucket, this.core); }
                }
            }
            this.ui.renderAll();
            this.sync3DToggleAvailability();
            this.ui.syncTransformFromSelection();
        }

        // The Export Manager reads parameters from the store; load each bucket's.
        prepareExport(operations) {
            for (const op of operations) {
                const bucket = this.ui.opsPanel.getBucket(op.id);
                if (bucket) this.parameterStore.loadFromOperation(bucket.toParamSource());
            }
        }

        clearWorkspace() {
            // Remove all buckets before clearing the scene so core
            // operations are cleaned up in the correct order.
            if (this.ui.opsPanel) {
                for (const bucket of this.ui.opsPanel.getAllBuckets()) {
                    this.ui.opsPanel.removeBucket(bucket.id, this.core);
                }
            }
            this.scene.clear();
            this.history.clear();
            // The stock was placed around geometry that no longer exists.
            this.stockPlacement = { minX: 0, minY: 0, marginZ: 0 };
        }

        // ════════════════════════════════════════════════════════════════
        // Toolbar
        // ════════════════════════════════════════════════════════════════

        /**
         * One import path for the toolbar, the scene-tree button and the empty
         * state: drag-and-drop is not discoverable.
         */
        importGeometry() {
            const hidden = document.getElementById('file-input-hidden');
            if (!hidden) return;
            hidden.accept = '.svg,.stl';
            hidden.onchange = async e => { await this.ingestFiles(e.target.files); hidden.value = ''; };
            hidden.click();
        }

        /**
         * Every file, not only the first - a three-file drop that loaded one
         * would read as a parser failure on the other two. Unsupported files
         * are reported once, as a count: a dropped folder brings whatever sits
         * beside the drawings.
         */
        async ingestFiles(fileList) {
            const files = [...(fileList || [])];
            if (files.length === 0) return;
            const accepted = files.filter((f) => /\.(svg|stl)$/i.test(f.name));
            const skipped = files.filter((f) => !accepted.includes(f)).map((f) => f.name);
            if (skipped.length > 0) {
                const named = skipped.slice(0, 3).join(', ') + (skipped.length > 3 ? ', ...' : '');
                this.ui.setStatus(`Skipped ${skipped.length} unsupported file(s): ${named}`, 'warning');
            }
            for (const f of accepted) await this.processFile(f);
        }

        /**
         * Puts the origin on the bounding box of the selection, or of all
         * content when nothing is selected - the same set Fit to Object wraps -
         * and remembers the anchor for the next fit.
         */
        placeOrigin(anchor) {
            this.originAnchor = anchor;
            let b = this.scene.getSelectionWorldBounds();
            if (!b) {
                // Board bounds are not recomputed when shapes move.
                this.scene.recomputeBoardBoundsFromShapes();
                b = this.scene.getBoardBounds();
            }
            if (!b) {
                this.ui.setStatus('Nothing to place the origin on', 'warning');
                return;
            }
            if (anchor === 'center') this.scene.setOrigin((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
            else this.scene.setOrigin(b.minX, b.minY);
            this.ui.renderer.render();
        }

        // ════════════════════════════════════════════════════════════════
        // Modals
        // ════════════════════════════════════════════════════════════════

        setupStockAndMachine() {
            this.ui.bindOriginFields('stock-x-offset', 'stock-y-offset');
            const onClick = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
            onClick('apply-stock', () => this.ui.commitOrigin());
            onClick('reset-stock', () => this.ui.revertOrigin());
            onClick('stock-center-btn', () => this.placeOrigin('center'));
            onClick('stock-bottom-left-btn', () => this.placeOrigin('bottom-left'));

            document.getElementById('fit-stock-btn')?.addEventListener('click', () => {
                // Selected nodes first (groups expand to shapes); all content otherwise
                const sel = this.scene.selection;
                let ids = [];
                if (sel && sel.size() > 0) {
                    for (const id of sel.toSet()) {
                        const node = this.scene.findNode(id);
                        if (node) ids.push(...this.scene.collectShapeIds(node));
                    }
                } else {
                    ids = this.scene.collectShapeIds(this.scene.root);
                }
                if (ids.length === 0) { this.ui.setStatus('Nothing to fit stock to', 'warning'); return; }
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                let meshSpanZ = 0;
                for (const id of ids) {
                    const s = this.scene.findShape(id);
                    if (!s) continue;
                    const b = this.scene.getShapeWorldBounds(s);
                    if (b) {
                        if (b.minX < minX) minX = b.minX;
                        if (b.minY < minY) minY = b.minY;
                        if (b.maxX > maxX) maxX = b.maxX;
                        if (b.maxY > maxY) maxY = b.maxY;
                    }
                    // The mesh is the untransformed import, so its Z span still
                    // owes the shape's scale - the same factor syncPrimitives
                    // applies when the operation bakes its copy.
                    if (s.mesh?.bounds3D) {
                        const wm = s.getWorldMatrix();
                        const sc = Math.hypot(wm.a, wm.b);
                        meshSpanZ = Math.max(meshSpanZ, (s.mesh.bounds3D.maxZ - s.mesh.bounds3D.minZ) * sc);
                    }
                }
                if (!isFinite(minX)) { this.ui.setStatus('Nothing to fit stock to', 'warning'); return; }
                const margin = Math.max(0, this.core.stock.margin);
                // Exact sizes on the coordinate grid keep the geometry margin-centred.
                const round = v => +v.toFixed(decimals);
                const height = round(meshSpanZ);
                // The geometry never moves: the stock is placed around it, so the
                // origin keeps its meaning and the G-code its coordinates.
                this.stockPlacement = {
                    minX: round(minX - margin),
                    minY: round(minY - margin),
                    marginZ: height > 0 ? margin : 0
                };
                // Settings, not the inputs: renderMachineSettings() redraws those.
                this.core.setSetting('machine.stock.width', Math.max(1, round(maxX - minX + 2 * margin)));
                this.core.setSetting('machine.stock.length', Math.max(1, round(maxY - minY + 2 * margin)));
                // Thickness becomes the model height. The pipeline hangs the model
                // from the slab's top, so its top sits on Z0 with Material Surface
                // and its bottom with Machine Bed.
                if (height > 0) this.core.setSetting('machine.stock.thickness', height);
                // The origin follows the fit onto the same box, at the anchor last
                // chosen with Center / Bottom-Left, and is committed like Apply.
                this.placeOrigin(this.originAnchor);
                this.ui.commitOrigin(null);
                this.ui.renderMachineSettings();
                this.ui.rebuildLayers();
                // Only the first fit frames the view; later fits keep the user's.
                if (!this._hasFitStockOnce) {
                    this._hasFitStockOnce = true;
                    requestAnimationFrame(() => this.ui.zoomFit());
                }
            });
        }
    }

    // ════════════════════════════════════════════════════════════════
    // Bootstrap
    // ════════════════════════════════════════════════════════════════

    let ctrl = null;

    async function startShapeApp() {
        if (ctrl) return ctrl;
        ctrl = new EasyShapeController();
        await ctrl.initialize();
        return ctrl;
    }

    window.startShapeApp = startShapeApp;
})();