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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const debugState = D.debug;
    const decimals = D.gcode.decimals.coordinates;

    class EasyShapeController extends CamController {
        constructor() {
            super();
            this.scene = null;
            this.selection = null;
            this.sceneInteraction = null;
            this.history = null;

            this.renderer3D = null;
            this._renderMode = '2d';
            this._modeSwitching = false;
        }

        // ════════════════════════════════════════════════════════════════
        // Template Hooks
        // ════════════════════════════════════════════════════════════════

        getAppLabel() { return 'EasyShape5000 Workspace'; }

        getProfileConfig() {
            return { embeddedVar: 'EMBEDDED_PROFILE_SHAPE', fetchPath: '../ui/profile-shape.json' };
        }

        onCoreReady() {
            this.scene = this.core.scene;
            this.selection = this.scene.selection;
            this.sceneInteraction = this.core.sceneInteraction;
            this.history = new CommandManager(this);
        }

        /**
         * Factory stock straight from the app profile
         */
        getStockDefaults() {
            return { ...(this.appProfile?.machineDefaults?.stock || {}) };
        }

        createUI() {
            return new EasyShapeUI(this);
        }

        registerHandlers() {
            // Parsers
            this.core.registerParser('.svg', new SVGParser());
            this.core.registerParser('.stl', new STLParser());

            // Handlers (profile-declared, incl. the rotary-indexed alias)
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
            const sm = this.shortcutManager;

            sm.register('ctrl+z', () => this.history.undo(), { mod: true });
            sm.register('ctrl+shift+z', () => this.history.redo(), { mod: true });
            sm.register('ctrl+y', () => this.history.redo(), { mod: true });
            sm.register('ctrl+g', () => this.groupSelection(), { mod: true });
            sm.register('ctrl+shift+g', () => this.ungroupSelection(), { mod: true });
            sm.register('ctrl+a', () => {
                const ids = [];
                for (const child of this.scene.root.children) ids.push(child.id);
                if (ids.length > 0) this.selection.replace(ids);
            }, { mod: true });
            sm.register('Delete', () => {
                if (this.selection.size() > 0) this.deleteShapes(Array.from(this.selection.toSet()));
            });
            sm.register('Backspace', () => {
                if (this.selection.size() > 0) this.deleteShapes(Array.from(this.selection.toSet()));
            });
            sm.register('i', () => this.importGeometry());
        }

        onBindEvents() {
            this.selection.addChangeListener(() => this.ui.onSelectionChanged());

            this.history.addListener(() => {
                this.ui.updateHistoryButtons();
            });
            this.setupToolbar();
            this.setupViewportBarDismiss();
            this.setupWelcomeFlow();
            this.setupStockAndMachine();
        }

        onFinalize() {
            this.ui.renderAll();
            this.modalManager.showModal('welcome');
            window.easyshape = this;
        }

        /**
         * Welcome-modal card → app action. EasyShape is CNC-only; the 3D card
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

        /**
         * A mesh-only scene has no 2D drawing worth switching to.
         */
        has2DContent() {
            let any = false;
            for (const shape of this.scene.allShapes()) {
                any = true;
                if (!shape.reliefMesh?.triangles?.length) return true;
            }
            return !any; // empty scene: leave the toggle free
        }

        /** EasyShape wires its own single drop target in setupWelcomeFlow. */
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
            if (!(stock?.width > 0 && stock?.height > 0)) return null;
            const isBedZero = stock.zeroReference && "material" !== stock.zeroReference;
            const topZ = (isBedZero && stock.thickness) || 0;
            const machineMatrix = this.core.getTransforms().machineMatrix;
            return {
                width: stock.width,
                depth: stock.height,
                thickness: stock.thickness || 0,
                topZ: topZ,
                centerX: stock.width / 2,
                centerY: stock.height / 2,
                matrix: machineMatrix
            };
        }

        /**
         * EasyShape's model layer: the relief/rotary mesh and whichever
         * blank the operation implies. The stock slab, the layer mirror and
         * the plan push are the base class's.
         */
        refresh3DModel(ctx) {
            const { view, w2m, machineMatrix, topZ } = ctx;

            // ── Model + frame: ONE operation owns both ──
            // Resolving the mesh by scanning the SCENE while the blank and the
            // orient came from whichever operation matched first let a
            // two-model scene draw one shape's mesh inside another shape's
            // blank, tagged with the wrong nodeId - which then mis-routed 3D
            // picks back onto the other shape.
            const meshOp = this.core.operations.find(op =>
                op.sourceMesh?.triangles?.length &&
                op.offsets?.[0]?.metadata?.is3DToolpath) || null;
            const meta = meshOp?.offsets?.[0]?.metadata || null;

            let meshTris = null;
            let meshNodeId = null;
            let orient = null;
            let offsetX = 0, offsetY = 0, offsetZ = 0;

            if (meshOp) {
                meshTris = meshOp.sourceMesh.triangles;
                meshNodeId = this.ui.opsPanel?.getBucket(meshOp.id)?.shapeRefs
                    .find(id => this.scene.findShape(id)?.reliefMesh) || null;
            }

            if (meshOp && meta.developedSpace && meta.refRadius > 0 && meta.axisCenter) {
                // Rotary: display the MACHINE frame. The mesh is the
                // operation's (already XY-transformed) copy, rotated by the
                // VISUAL orient only - the slicer's internal axis mapping is
                // not a physical rotation of the part and must not reach the
                // renderer. The metadata axis line is published in world
                // coordinates, so XY offsets are 0.
                orient = meta.rotaryFrame?.orient || null;

                // MACHINE FRAME. The rotary centreline is the line cross = 0,
                // Z = 0 - that is what the A/B word turns about, and both export
                // paths already put it there (convertDevelopedToRotary adds
                // refRadius, insertIndexMoves adds apothem). The preview drew the
                // BLANK SURFACE at Z0 instead, which is why the part hung a
                // radius below the plane on screen and sat on it in the G-code.
                // There is no axis height to publish any more: it is 0.
                const shift = meta.axialShift || 0;
                const crossOff = -meta.axisCenter.b;
                if ('y' === meta.rotaryAxis) { offsetX = crossOff; offsetY = shift; }
                else { offsetX = shift; offsetY = crossOff; }
                offsetZ = -meta.axisCenter.c;

                // Cell CENTRES: originX is column 0's centre, so the grid spans
                // (cols - 1) cells, not cols.
                const len = (meta.gridCols - 1) * meta.cellSize;
                const along = (meta.originX ?? 0) + len / 2;
                view.stock.setRotaryBlank({
                    refRadius: meta.refRadius, length: len, axis: meta.rotaryAxis,
                    center: 'y' === meta.rotaryAxis ? { x: 0, y: along, z: 0 } : { x: along, y: 0, z: 0 }
                });
            } else if (meshOp && meta.indexedFrame) {
                // [INDEXED] Match the frame the toolpaths are wrapped in
                // (walkPlans + GeometryLayer3D): rotation axis line at
                // Z = baseZ - apothem, cross axis at 0. Slicing subtracts
                // Cvis, so exported paths are axis-centered - translate the
                // mesh by -axisCenter.b on the CROSS axis and leave the AXIAL
                // one at 0 (slicing preserves it).
                const f = meta.indexedFrame;
                orient = f.orient || null;
                const ixShift = f.axialShift || 0;
                if ('y' === f.machineAxis) { offsetX = -f.axisCenter.b; offsetY = ixShift; }
                else { offsetX = ixShift; offsetY = -f.axisCenter.b; }
                offsetZ = -f.axisCenter.c;

                // Indexed blank: an N-gon prism about the axis, drawn from the
                // SAME clearRadius insertIndexMoves lifts its rotation moves
                // above, so a bad apothem or a blank the tool would hit is
                // visible before the cut. All inputs come from indexedFrame -
                // one object, so a half-populated frame draws nothing instead
                // of drawing a wrong prism.
                const ixLen = Math.max(0, (f.gridCols || 1) - 1) * (f.cellSize || 0);
                const ixAlong = (f.originX ?? 0) + ixLen / 2;
                view.stock.setIndexedBlank({
                    clearRadius: f.clearRadius,
                    length: ixLen,
                    axis: f.machineAxis,
                    faces: f.faceCount,
                    startAngleDeg: f.startAngle,
                    // Cross coordinate 0, NOT axisCenter.b. Slicing subtracts
                    // Cvis outright, so the plans are axis-centered and
                    // walkPlans wraps them about cross 0 - and the mesh above
                    // is translated by -axisCenter.b to match. Placing the
                    // prism at the world axis instead put the blank beside its
                    // own toolpaths on every model not centred on the axis.
                    center: 'y' === f.machineAxis
                        ? { x: 0, y: ixAlong, z: 0 }
                        : { x: ixAlong, y: 0, z: 0 }
                });
            } else if (meshOp) {
                // Flat relief. sourceMesh already carries the shape's world
                // TRS (syncPrimitives baked it), so only the machine map is
                // left, and setTriangleMesh takes a rotation plus an offset -
                // which expresses translation and rotation exactly. The
                // workspace matrix carries no scale, so det is +-1; det < 0 is
                // a mirror and is not a rotation.
                view.stock.removeRotaryBlank();
                const m = machineMatrix;
                const det = m.a * m.d - m.b * m.c;
                offsetX = m.e;
                offsetY = m.f;
                offsetZ = topZ - meshOp.sourceMesh.bounds3D.maxZ;
                if (det > 0) {
                    orient = [m.a, m.c, 0,
                              m.b, m.d, 0,
                              0,   0,   1];
                } else {
                    console.warn('[EasyShape] Workspace mirror is not applied to the 3D model - ' +
                        'the toolpaths are mirrored, the displayed mesh is not.');
                }

            } else {
                // Nothing generated yet - show the imported model so it can be
                // placed. Translation only: without a sourceMesh there is no
                // copy carrying the node's rotation and scale to draw instead.
                view.stock.removeRotaryBlank();
                for (const sid of this.scene.collectShapeIds(this.scene.root)) {
                    const s = this.scene.findShape(sid);
                    if (!s?.reliefMesh?.triangles?.length) continue;
                    const wm = s.getWorldMatrix();
                    const off = w2m({ x: wm.e, y: wm.f });
                    meshTris = s.reliefMesh.triangles;
                    meshNodeId = s.id;
                    offsetX = off.x;
                    offsetY = off.y;
                    offsetZ = topZ - s.reliefMesh.bounds3D.maxZ;
                    break;
                }
            }

            if (meshTris) {
                view.stock.setTriangleMesh(meshTris, {
                    offsetX, offsetY, offsetZ, orient, nodeId: meshNodeId
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

        async loadExample(exampleId) {
            const examples = this.getExamples();
            const example = examples[exampleId];
            if (!example) { this.ui.setStatus(`Example not found: ${exampleId}`, 'error'); return; }
            this.ui.setStatus(`Loading example: ${example.name}...`, 'info');
            try {
                // Route by file type
                const path = example.files?.svg || example.files?.stl
                    || Object.values(example.files || {})[0];
                if (!path) throw new Error('example has no files');

                const resp = await fetch(path);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

                const name = path.split('/').pop();
                const ext = name.toLowerCase().split('.').pop();
                const body = (ext === 'stl') ? await resp.arrayBuffer() : await resp.text();
                const mime = (ext === 'stl') ? 'model/stl' : 'image/svg+xml';

                await this.processFile(new File([body], name, { type: mime }));
            } catch (e) { this.ui.setStatus(`Failed to load example: ${e.message}`, 'error'); }
        }

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
         * Imports an STL as a first-class scene object: a ShapeNode whose
         * primitive is the mesh's XY footprint (selectable in tree/canvas,
         * draggable, bucket-assignable) carrying the triangle soup on
         * node.reliefMesh. The relief OPERATION is created later through
         * the normal bucket flow - OperationBucket.syncPrimitives hands
         * the mesh to operation.sourceMesh, and ShapeReliefHandler slices
         * it into a heightmap on demand. File Z is pipeline-irrelevant
         * (heightmap normalizes; carve depth = relief params).
         */
        async importSTL(file) {
            if (!file) return;
            this.ui.setStatus(`Loading ${file.name}…`);

            let buffer;
            try { buffer = await this.readFileAsArrayBuffer(file); }
            catch (err) { this.ui.setStatus(`Failed to read ${file.name}: ${err.message}`, 'error'); return; }

            const parser = new STLParser();
            const parseResult = parser.parse(buffer);
            if (!parseResult.success) {
                this.ui.setStatus(`STL parse error: ${(parseResult.errors?.join('; ')) || 'Unknown'}`, 'error');
                return;
            }

            const b3 = parseResult.bounds3D;
            const footprint = new RectanglePrimitive(
                { x: b3.minX, y: b3.minY },
                b3.maxX - b3.minX,
                b3.maxY - b3.minY,
                { role: 'relief_mesh', fill: false, stroke: true, strokeWidth: 0 }
            );

            this.scene.addShapesFromPlot([footprint], file.name);
            const fileGroup = this.scene.fileRoots.get(file.name);
            const node = fileGroup?.children?.[fileGroup.children.length - 1];
            if (node) {
                node.label = file.name.replace(/\.stl$/i, '') + ' (mesh)';
                // REVIEW - scene-node mesh, separate from operation.sourceMesh?
                node.reliefMesh = {
                    triangles: parseResult.triangles,
                    triangleCount: parseResult.triangleCount,
                    bounds3D: b3
                };
            }

            this.history.clear();
            this.scene.recomputeBoardBoundsFromShapes();
            this.ui.renderAll();
            this.ui.zoomFit();
            this.ui.setStatus(
                `Loaded ${file.name}: ${parseResult.triangleCount} triangles, ` +
                `${(b3.maxZ - b3.minZ).toFixed(2)}mm model height`,
                'success'
            );
            return node;
        }

        async importSVG(file) {
            if (!file) return;
            this.ui.setStatus(`Loading ${file.name}…`);
            let content;
            try { content = await this.readFileAsText(file); }
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
            // REVIEW - it works a bit too well, the UI hides it a bit too much, should the first added object get automatically selected? That UX could be relevant for EasyTrace5000 too?
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
            if (!node) return false;
            if (node.isLocked) return false;
            if (this.hasLockedDescendant(node)) return false;
            return true;
        }

        hasLockedDescendant(node) {
            if (!node?.children) return false;
            for (const c of node.children) { if (c.locked || this.hasLockedDescendant(c)) return true; }
            return false;
        }

        hasLockedAncestor(node) {
            if (!node) return false;
            let n = node.parent;
            while (n && n.kind !== 'root') { if (n.locked) return true; n = n.parent; }
            return false;
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
            this.history.executeAndRecord(new DeleteShapesCommand(snapshots));
        }

        toggleNodeFlag(nodeId, flag) {
            const inSelection = this.selection.has(nodeId);
            let targetIds = inSelection ? Array.from(this.selection.toSet()) : [nodeId];

            if (flag === 'locked') {
                const blocked = [];
                targetIds = targetIds.filter(id => {
                    const n = this.scene.findNode(id);
                    if (!n) return false;
                    if (this.hasLockedAncestor(n)) { blocked.push(id); return false; }
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

        // REVIEW - Currently unused, Could be worth having a single reset button in the tool bar menu that reloads the original geometry without any transforms? For users that want to reset without tracking files to add again?
        // resetShapeTransform() {
        //     const ids = this.getTopLevelActionableIds();
        //     if (ids.length === 0) return;
        //     const commands = [];
        //     for (const id of ids) {
        //         const node = this.scene.findNode(id);
        //         if (!node) continue;
        //         const t = node.transform;
        //         if (t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1) continue;
        //         commands.push(new SetShapeTransformCommand(id, { ...t, rotationCenter: t.rotationCenter ?? null }, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, rotationCenter: null }));
        //     }
        //     if (commands.length === 1) this.history.executeAndRecord(commands[0]);
        //     else if (commands.length > 1) this.history.executeAndRecord(new CompositeCommand(commands, 'Reset Transforms'));
        // }

        // ════════════════════════════════════════════════════════════════
        // Bucket Lifecycle
        // ════════════════════════════════════════════════════════════════

        /**
         * Removes stale shape refs from every bucket. If a bucket loses
         * all its refs (every source shape was deleted), the bucket and
         * its backing core operation are removed entirely.
         */
        cleanupOrphanedBuckets() {
            if (!this.ui.opsPanel) return;

            const bucketsToRemove = [];

            for (const bucket of this.ui.opsPanel.getAllBuckets()) {
                const prevCount = bucket.shapeRefs.length;

                bucket.shapeRefs = bucket.shapeRefs.filter(ref =>
                    this.scene.findShape(ref) !== null
                );

                if (bucket.shapeRefs.length === 0) {
                    bucketsToRemove.push(bucket.id);
                } else if (bucket.shapeRefs.length !== prevCount) {
                    // Some refs died but bucket survives - update count + invalidate
                    this.ui.opsPanel.invalidateBucket(
                        bucket.id, 'Source shape(s) deleted. Regenerate offsets.', this.core);
                    this.ui.opsPanel.updateBucketDOM(bucket, this.core);
                }
            }

            for (const bucketId of bucketsToRemove) {
                this.ui.opsPanel.removeBucket(bucketId, this.core);
            }
        }

        /**
         * Flag-only mutation: visibility and lock. Repaints the rows and the
         * canvas and NOTHING else.
         * Deliberately not afterMutation and never an alias for it: that one runs
         * cleanupOrphanedBuckets and invalidates every bucket whose shapes are in
         * the selection, so hiding a shape would stale its offsets and demand a
         * regenerate. A flag flip moves no geometry, so no artifact can go stale
         * because of one - that is the whole reason the two methods exist.
         */
        afterFlagMutation() {
            this.ui.navScenePanel?.updateFlagStates();
            this.ui.navScenePanel?.syncTreeToolbar(this.selection, this.scene);
            this.ui.rebuildLayers();
        }

        afterMutation() {
            this.cleanupOrphanedBuckets();

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
                    if (!bucket.hasOffsets && !bucket.hasPreview) continue;
                    // Only invalidate if this bucket references an affected shape
                    const isAffected = bucket.shapeRefs.some(ref => changedShapeIds.has(ref));
                    if (!isAffected) continue;
                    this.ui.opsPanel.invalidateBucket(
                        bucket.id, 'Source geometry changed. Regenerate offsets.', this.core);
                    this.ui.opsPanel.updateBucketDOM(bucket, this.core);
                }
            }
            this.ui.renderAll();
            this.sync3DToggleAvailability();
            this.ui.syncTransformFromSelection();
        }

        ensureBucketParamsLoaded(operations) {
            for (const op of operations) {
                const bucket = this.ui.opsPanel?.getBucket(op.id);
                if (bucket) {
                    this.parameterManager.loadFromOperation(bucket.toParamSource());
                }
            }
        }

        clearScene() {
            // Remove all buckets before clearing the scene so core
            // operations are cleaned up in the correct order.
            if (this.ui.opsPanel) {
                for (const bucket of this.ui.opsPanel.getAllBuckets()) {
                    this.ui.opsPanel.removeBucket(bucket.id, this.core);
                }
            }
            this.scene.clear();
            this.history.clear();
        }

        // ════════════════════════════════════════════════════════════════
        // Toolbar
        // ════════════════════════════════════════════════════════════════

        setupToolbar() {
            this.setupToolbarDropdown('quick-actions-btn', 'quick-actions-menu');

            const importBtn = document.getElementById('toolbar-import-svg');
            importBtn?.addEventListener('click', () => { this.importGeometry(); this.closeDropdown(); });

            const canvas = document.getElementById('preview-canvas');
            const container = canvas?.parentElement;
            if (container) {
                container.addEventListener('dragover', e => { if (!document.querySelector('.modal.active')) e.preventDefault(); });
                container.addEventListener('drop', async e => {
                    if (document.querySelector('.modal.active')) return;
                    e.preventDefault();
                    await this.ingestFiles(e.dataTransfer.files);
                });
            }

            document.getElementById('toolbar-export-canvas')?.addEventListener('click', async () => {
                if (!this.ui.canvasExporter) {
                    this.ui.setStatus('Canvas exporter not available', 'error');
                    return;
                }
                try {
                    this.ui.canvasExporter.exportCanvasSVG();
                    this.ui.setStatus('Canvas exported successfully', 'success');
                } catch (error) {
                    console.error('Canvas export error:', error);
                    this.ui.setStatus('Canvas export failed: ' + error.message, 'error');
                }
                this.closeDropdown();
            });

            this.setupSharedToolbarButtons();

            document.getElementById('btn-undo')?.addEventListener('click', () => { const lbl = this.history.getTopUndoLabel(); if (this.history.undo()) this.ui.setStatus(`Undo: ${lbl}`); });
            document.getElementById('btn-redo')?.addEventListener('click', () => { if (this.history.redo()) this.ui.setStatus(`Redo: ${this.history.getTopUndoLabel() || ''}`); });
            
            document.getElementById('btn-toggle-3d')?.addEventListener('click', () => this.toggle3DMode());

            document.getElementById('toolbar-export-gcode')?.addEventListener('click', () => {
                const readyOps = this.core.operations.filter(op => this.core.isExportReady(op));
                if (readyOps.length === 0) { this.ui.setStatus('No operations ready for export. Generate previews first.', 'warning'); return; }
                this.ensureBucketParamsLoaded(readyOps);
                this.modalManager.showModal('exportManager', { operations: readyOps });
                this.closeDropdown();
            });
        }

        /**
         * One import path for the toolbar, the scene-tree button and the empty
         * state. Drag-and-drop is not discoverable, and the dropdown entry was
         * the only visible alternative.
         */
        importGeometry() {
            const hidden = document.getElementById('file-input-hidden');
            if (!hidden) return;
            hidden.accept = '.svg,.stl';
            hidden.onchange = async e => { await this.ingestFiles(e.target.files); hidden.value = ''; };
            hidden.click();
        }

        /**
         * Every file, not just the first. Both entry points took files[0] and
         * discarded the rest with no message - a three-file drop looked like a
         * parser failure on two of them.
         */
        async ingestFiles(fileList) {
            const files = [...(fileList || [])];
            if (files.length === 0) return;
            const accepted = files.filter(f => /\.(svg|stl)$/i.test(f.name));
            for (const f of files.filter(f => !accepted.includes(f))) {
                this.ui.setStatus(`Unsupported file: ${f.name}`, 'warning');
            }
            for (const f of accepted) await this.processFile(f);
        }

        // ════════════════════════════════════════════════════════════════
        // Modals
        // ════════════════════════════════════════════════════════════════

        setupWelcomeFlow() {
            document.querySelectorAll('[data-welcome-action]').forEach(card => {
                card.addEventListener('click', e => {
                    e.preventDefault();
                    this.modalManager.closeModal();
                    switch (card.dataset.welcomeAction) {
                        case 'start': this.modalManager.showModal('quickstart'); break;
                        case 'example':
                            // Route through quickstart so the load has a surface to
                            // report progress on; the bare call closed the modal and
                            // left the canvas empty for the length of the fetch.
                            this.modalManager.showModal('quickstart');
                            break;
                        case 'reopen': this.ui.setStatus('Project reopen not wired yet.'); break;
                    }
                });
            });

            ['sponsor-slot-1', 'sponsor-slot-2', 'sponsor-slot-3', 'sponsor-contact-cta'].forEach(id => {
                document.getElementById(id)?.addEventListener('click', (e) => { e.preventDefault(); this.modalManager.showModal('support'); });
            });
        }

        setupStockAndMachine() {
            this.committedOrigin = this.scene
                ? { x: this.scene.transform.origin.x, y: this.scene.transform.origin.y }
                : { x: 0, y: 0 };
            const xInput = document.getElementById('stock-x-offset');
            const yInput = document.getElementById('stock-y-offset');

            if (xInput) xInput.value = (0).toFixed(decimals);
            if (yInput) yInput.value = (0).toFixed(decimals);

            if (this.scene) {
                this.scene.addTransformListener(() => {
                    if (!xInput || !yInput || !this.scene) return;
                    const o = this.scene.transform.origin;
                    xInput.value = (o.x - this.committedOrigin.x).toFixed(decimals);
                    yInput.value = (o.y - this.committedOrigin.y).toFixed(decimals);
                });
            }

            const updatePreview = () => {
                if (!this.scene) return;
                this.scene.setOrigin(
                    this.committedOrigin.x + (parseFloat(xInput?.value) || 0),
                    this.committedOrigin.y + (parseFloat(yInput?.value) || 0)
                );
                this.ui.renderer?.render();
            };

            xInput?.addEventListener('input', updatePreview);
            yInput?.addEventListener('input', updatePreview);

            document.getElementById('stock-center-btn')?.addEventListener('click', () => {
                if (!this.scene || !this.core.stock) return;
                const cx = this.core.stock.width / 2, cy = this.core.stock.height / 2;
                this.scene.setOrigin(cx, cy);
                this.ui.renderer?.render();
            });

            document.getElementById('stock-bottom-left-btn')?.addEventListener('click', () => {
                if (!this.scene) return;
                this.scene.setOrigin(0, 0);
                this.ui.renderer?.render();
            });

            const applyStock = () => {
                const w = parseFloat(document.getElementById('stock-width')?.value);
                const h = parseFloat(document.getElementById('stock-height')?.value);
                const t = parseFloat(document.getElementById('stock-thickness')?.value);
                if (!this.core.stock) this.core.stock = this.getStockDefaults();
                if (Number.isFinite(w) && w > 0) this.core.stock.width = w;
                if (Number.isFinite(h) && h > 0) this.core.stock.height = h;
                if (Number.isFinite(t) && t > 0) this.core.stock.thickness = t;
                const mat = document.getElementById('stock-material')?.value;
                const zRef = document.getElementById('z-zero')?.value;
                if (mat) this.core.stock.material = mat;
                if (zRef) this.core.stock.zeroReference = zRef;
                if (this.scene) {
                    this.committedOrigin = { x: this.scene.transform.origin.x, y: this.scene.transform.origin.y };
                }
                if (xInput) xInput.value = (0).toFixed(decimals);
                if (yInput) yInput.value = (0).toFixed(decimals);
                this.ui.rebuildLayers(); this.ui.zoomFit();
                this.core.saveSettings();
                this.ui.setStatus('Stock settings and origin applied', 'success');
            };

            const resetStock = () => {
                const defaults = this.getStockDefaults();
                this.core.stock = { ...defaults };
                this.core.saveSettings();

                const stockW = document.getElementById('stock-width');
                const stockH = document.getElementById('stock-height');
                const stockT = document.getElementById('stock-thickness');
                const stockM = document.getElementById('stock-material');
                const zEl = document.getElementById('z-zero');
                if (stockW) stockW.value = defaults.width;
                if (stockH) stockH.value = defaults.height;
                if (stockT) stockT.value = defaults.thickness;
                if (stockM) stockM.value = defaults.material;
                if (zEl) zEl.value = defaults.zeroReference;

                if (this.scene) this.scene.setOrigin(this.committedOrigin.x, this.committedOrigin.y);
                if (xInput) xInput.value = (0).toFixed(decimals);
                if (yInput) yInput.value = (0).toFixed(decimals);
                this.ui.rebuildLayers(); this.ui.zoomFit();
                this.ui.setStatus('Stock reset to defaults');
            };

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
                    if (s.reliefMesh?.bounds3D) {
                        meshSpanZ = Math.max(meshSpanZ,
                            s.reliefMesh.bounds3D.maxZ - s.reliefMesh.bounds3D.minZ);
                    }
                }
                if (!isFinite(minX)) { this.ui.setStatus('Nothing to fit stock to', 'warning'); return; }
                if (minX < -1e-6 || minY < -1e-6) {
                    this.ui.setStatus('Content extends into negative coordinates - move it above (0,0) first', 'warning');
                }

                // Calculate true dimensions based on the original bounding box
                const actualWidth = maxX - minX;
                const actualHeight = maxY - minY;

                // Set the UI inputs to the true dimensions
                document.getElementById('stock-width').value = Math.max(1, Math.ceil(actualWidth));
                document.getElementById('stock-height').value = Math.max(1, Math.ceil(actualHeight));
                if (meshSpanZ > 0) {
                    document.getElementById('stock-thickness').value = Math.ceil(meshSpanZ * 2) / 2;
                }

                // Move the physical shapes to the current origin (World 0,0)
                const ox = this.scene.transform.origin.x;
                const oy = this.scene.transform.origin.y;
                const dx = ox - minX;
                const dy = oy - minY;

                if (dx !== 0 || dy !== 0) {
                    // This leverages your undo/redo history to safely translate the shapes
                    this.history.executeAndRecord(new TranslateCommand(ids, dx, dy));
                }

                // Commit the state
                applyStock();
            });

            document.getElementById('reset-stock')?.addEventListener('click', resetStock);
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

    // REVIEW - Anywhere else this should be? Is it being used yet? This seems like it should be shared?
    window.showShapeStats = function() { 
        if (ctrl) ctrl.logState(); 
        else console.error('Application not initialized'); 
    };
    window.enableShapeDebug = function() { 
        debugState.enabled = true; 
        console.log('Debug mode enabled'); 
    };
    window.disableShapeDebug = function() { 
        debugState.enabled = false; 
        console.log('Debug mode disabled'); 
    };
})();