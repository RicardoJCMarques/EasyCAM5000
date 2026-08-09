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
            this._plansRefreshing = false;
            this._plansQueued = false;
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

            // Handlers
            this.core.registerHandler('profile', new ShapeProfileHandler(this.core));
            this.core.registerHandler('pocket', new ShapePocketHandler(this.core));
            this.core.registerHandler('drill', new ShapeDrillHandler(this.core));
            this.core.registerHandler('vcarve', new ShapeVCarveHandler(this.core));
            this.core.registerHandler('relief', new ShapeReliefHandler(this.core));
            this.core.registerHandler('rotary', new ShapeRotaryHandler(this.core));
            this.core.registerHandler('rotary-indexed', new ShapeIndexedHandler(this.core));
            this.core.registerHandler('engrave', new ShapeEngraveHandler(this.core));
            if (typeof ShapePatternHandler !== 'undefined')
                this.core.registerHandler('pattern', new ShapePatternHandler(this.core));

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
            sm.register('i', () => document.getElementById('toolbar-import-svg')?.click());

            sm.register('F2', () => this.toggle3DMode());
        }

        onBindEvents() {
            this.selection.addChangeListener(() => this.ui.onSelectionChanged());
            this.history.addListener(() => this.ui.updateHistoryButtons());
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
            this.setPipeline('cnc');
            if (pipelineId === '3d') queueMicrotask(() => this.toggle3DMode());
            return 'quickstart';
        }

        /** EasyShape wires its own single drop target in setupWelcomeFlow. */
        getQuickstartOpTypes() { return ['unassigned']; }

        getTreeFocusSelector() { return '#scene-tree-list [tabindex="0"]'; }

        handleEscapeKey(e) {
            if (this.selection.size() > 0) this.selection.clear();
        }

        // ════════════════════════════════════════════════════════════════
        // Render Mode (2D canvas ↔ 3D preview)
        // ════════════════════════════════════════════════════════════════

        get renderMode() { return this._renderMode; }

        async enter3DMode() {
            const container = document.getElementById('viewport-3d');
            const shell = document.querySelector('.canvas-container');
            if (!container || !shell) {
                this.ui.setStatus('3D viewport container missing from page', 'error');
                return;
            }

            shell.dataset.renderMode = '3d';
            container.hidden = false;
            this._renderMode = '3d';

            try {
                const view = await this.open3DPreview(container);  // mount + input stack only
                this.refresh3D();            // stock + relief mesh + 2D geometry mirror
                await this.refresh3DPlans(); // machine-ready toolpath plans
                view.fitToContent();         // frame ONCE, on entry only
                container.focus();

                // Update button active class and switch icon to 2D
                const btn3D = document.getElementById('btn-toggle-3d');
                if (btn3D) {
                    btn3D.classList.add('active');
                    btn3D.querySelector('use')?.setAttribute('href', '#icon-view-2d');
                }

                this.ui.setStatus('3D preview active. F2 returns to 2D.', 'info');
            } catch (err) {
                console.error('3D preview failed:', err);
                this.ui.setStatus('3D preview failed: ' + err.message, 'error');
                this.exit3DMode();
            }
        }

        /**
         * Re-derives everything the 3D view mirrors from app state: stock
         * box (size, Z-zero reference, workspace origin), the model, and
         * every visible 2D layer. Called from rebuildLayers() - the funnel
         * every 2D mutation already flows through - so the 3D view cannot
         * go stale. Deliberately never touches the camera.
         */
        refresh3D() {
            if (this._renderMode !== '3d' || !this.renderer3D) return;
            const view = this.renderer3D;

            // World → machine, taken from the SAME matrix GeometryTranslator
            // stamps into every plan. Scene.worldToWorkspace is the INVERSE
            // map (canvas pixel → file coordinate) and agrees with it only
            // while the workspace matrix is its own inverse, so a workspace
            // rotation drew the stock, the model and the 2D mirror at -angle
            // while the plans sat at +angle. Hoisted: w2m runs per vertex.
            const machineMatrix = this.core.getTransforms().machineMatrix;
            const w2m = (p) => TransformMath.applyToPoint(machineMatrix, p);

            // ── Stock: re-read settings on every refresh ──
            const stock = this.core.stock;
            let topZ = 0;
            if (stock?.width > 0 && stock?.height > 0) {
                const isBedZero = stock.zeroReference && stock.zeroReference !== 'material';
                topZ = isBedZero ? (stock.thickness || 0) : 0;

                const corners = [
                    w2m({ x: 0, y: 0 }),
                    w2m({ x: stock.width, y: 0 }),
                    w2m({ x: stock.width, y: stock.height }),
                    w2m({ x: 0, y: stock.height })
                ];
                view.setStock({
                    minX: Math.min(...corners.map(c => c.x)),
                    minY: Math.min(...corners.map(c => c.y)),
                    maxX: Math.max(...corners.map(c => c.x)),
                    maxY: Math.max(...corners.map(c => c.y)),
                    thickness: stock.thickness || 0,
                    topZ
                });
            }

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
                // Grounded rotary frame: blank rests ON the grid, axis line at
                // Z = refRadius. Stock-top has no meaning here.
                const rotaryAxisZ = meta.refRadius;
                offsetZ = rotaryAxisZ - meta.axisCenter.c;

                const len = meta.gridCols * meta.cellSize;
                const along = (meta.originX ?? 0) + len / 2;
                view.stock.setRotaryBlank({
                    refRadius: meta.refRadius,
                    length: len,
                    axis: meta.rotaryAxis,
                    center: meta.rotaryAxis === 'y'
                        ? { x: meta.axisCenter.b, y: along, z: rotaryAxisZ }
                        : { x: along, y: meta.axisCenter.b, z: rotaryAxisZ }
                });
                view.stock.removeStock(); // the rectangular slab is meaningless here

            } else if (meshOp && meta.indexedFrame) {
                // [INDEXED] Match the frame the toolpaths are wrapped in
                // (walkPlans + GeometryLayer3D): rotation axis line at
                // Z = baseZ - apothem, cross axis at 0. Slicing subtracts
                // Cvis, so exported paths are axis-centered - translate the
                // mesh by -axisCenter.b on the CROSS axis and leave the AXIAL
                // one at 0 (slicing preserves it).
                const f = meta.indexedFrame;
                orient = f.orient || null;
                if (f.machineAxis === 'y') {        // B about Y: axial = Y
                    offsetX = -f.axisCenter.b;
                    offsetY = 0;
                } else {                            // A about X: axial = X
                    offsetX = 0;
                    offsetY = -f.axisCenter.b;
                }
                offsetZ = (topZ - f.apothem) - f.axisCenter.c;

                // Indexed blank: an N-gon prism about the axis, drawn from the
                // SAME clearRadius insertIndexMoves lifts its rotation moves
                // above, so a bad apothem or a blank the tool would hit is
                // visible before the cut. All inputs come from indexedFrame -
                // one object, so a half-populated frame draws nothing instead
                // of drawing a wrong prism.
                const ixLen = (f.gridCols || 0) * (f.cellSize || 0);
                const ixAlong = (f.originX ?? 0) + ixLen / 2;
                const ixAxisZ = topZ - f.apothem;
                view.stock.removeStock();
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
                    center: f.machineAxis === 'y'
                        ? { x: 0, y: ixAlong, z: ixAxisZ }
                        : { x: ixAlong, y: 0, z: ixAxisZ }
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

            // 2D layer mirror: the exact snapshot the canvas paints
            const defs = [];
            for (const [name, layer] of this.ui.renderer.layers) {
                if (layer.visible === false || layer.isStock) continue;
                if (!layer.primitives || layer.primitives.length === 0) continue;
                defs.push({
                    name,
                    primitives: layer.primitives,
                    transform: layer.transform || null,
                    zIndex: layer.zIndex || 0,
                    color: this.ui.resolveLayerColor(layer)
                });
            }

            view.geometry.setLayers(defs, {
                baseZ: topZ,
                worldToMachine: w2m,
                // Grounded frame; undefined = legacy. Same operation as the
                // mesh above, so the strip and the blank cannot disagree.
                rotaryAxisZ: meta?.developedSpace ? meta.refRadius : undefined
            });
        }

        /**
         * Rebuilds machine-ready plans and pushes them to the 3D toolpath
         * layer. Uses the SAME pair assembly as export (params committed →
         * buildToolpathContext → executePipeline), so what renders IS what
         * exports. Reentrancy-guarded: a refresh requested mid-run
         * coalesces into one rerun. Never touches the camera.
         */
        async refresh3DPlans() {
            if (this._renderMode !== '3d' || !this.renderer3D) return;
            if (this._plansRefreshing) { this._plansQueued = true; return; }
            this._plansRefreshing = true;
            try {
                const readyOps = this.core.operations.filter(op => this.core.isExportReady(op));
                this.ensureBucketParamsLoaded(readyOps);
                const pairs = this.buildOperationContextPairs(readyOps.map(op => op.id));
                const { plans } = await this.core.executePipeline(pairs, { convertRotary: false });
                // Developed (rotary) plans carry y = θ·refR - drawing them
                // as machine XYZ paints the flat strip through the scene.
                // The wrapped preview lives in GeometryLayer3D; plans join
                // once the θ→A machine pass exists.
                const displayable = plans.filter(p => !p.metadata?.developedSpace);
                if (displayable.length < plans.length) {
                    console.info('[EasyShape] 3D plans preview: ' +
                        `${plans.length - displayable.length} rotary plan(s) hidden ` +
                        '(developed space, θ→A stage pending).');
                }
                this.renderer3D?.setPlans(displayable);   // no fit - camera stays put
            } catch (err) {
                console.warn('3D plan refresh failed:', err.message);
            } finally {
                this._plansRefreshing = false;
                if (this._plansQueued) { this._plansQueued = false; this.refresh3DPlans(); }
            }
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

        exit3DMode() {
            this.renderer3D?.simulator?.stop();
            const container = document.getElementById('viewport-3d');
            const shell = document.querySelector('.canvas-container');
            if (container) container.hidden = true;
            if (shell) delete shell.dataset.renderMode;
            this._renderMode = '2d';

            // Remove active class and reset icon back to 3D
            const btn3D = document.getElementById('btn-toggle-3d');
            if (btn3D) {
                btn3D.classList.remove('active');
                btn3D.querySelector('use')?.setAttribute('href', '#icon-view-3d');
            }

            this.ui.renderAll();
            document.getElementById('preview-canvas')?.focus();
        }

        /**
         * Guarded because enter3DMode awaits a dynamic import: a second
         * toggle mid-load would exit while the first entry is still in
         * flight, leaving refresh3D/refresh3DPlans skipped and the status
         * line claiming 3D over a 2D canvas.
         */
        async toggle3DMode() {
            if (this._modeSwitching) return;
            this._modeSwitching = true;
            try {
                if (this.renderMode === '3d') this.exit3DMode();
                else await this.enter3DMode();
            } finally {
                this._modeSwitching = false;
            }
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

        assignOperationToSelection(opType) {
            const entries = [];
            for (const id of this.getActionableIds()) {
                const shape = this.scene.findShape(id);
                if (!shape) continue;
                entries.push({ shapeId: id, prevOp: shape.operation ? { ...shape.operation } : null, newOp: { type: opType, params: {} } });
            }
            if (entries.length === 0) return;
            this.history.executeAndRecord(new AssignOperationCommand(entries, 'Assign'));
            this.ui.setStatus(`Assigned ${opType} to ${entries.length} shape(s)`);
        }

        clearOperationFromSelection() {
            const entries = [];
            for (const id of this.getActionableIds()) {
                const shape = this.scene.findShape(id);
                if (!shape?.operation) continue;
                entries.push({ shapeId: id, prevOp: { ...shape.operation }, newOp: null });
            }
            if (entries.length === 0) return;
            this.history.executeAndRecord(new AssignOperationCommand(entries, 'Remove'));
            this.ui.setStatus(`Removed operation from ${entries.length} shape(s)`);
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
        resetShapeTransform() {
            const ids = this.getTopLevelActionableIds();
            if (ids.length === 0) return;
            const commands = [];
            for (const id of ids) {
                const node = this.scene.findNode(id);
                if (!node) continue;
                const t = node.transform;
                if (t.x === 0 && t.y === 0 && t.rotation === 0 && t.scaleX === 1 && t.scaleY === 1) continue;
                commands.push(new SetShapeTransformCommand(id, { ...t, rotationCenter: t.rotationCenter ?? null }, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, rotationCenter: null }));
            }
            if (commands.length === 1) this.history.executeAndRecord(commands[0]);
            else if (commands.length > 1) this.history.executeAndRecord(new CompositeCommand(commands, 'Reset Transforms'));
        }

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
            this.ui.syncTransformFromSelection();
        }

        afterFlagMutation() {
            this.cleanupOrphanedBuckets();
            this.ui.navScenePanel.updateFlagStates();
            this.ui.navScenePanel.syncTreeToolbar(this.selection, this.scene);
            this.ui.syncTransformFromSelection();
            this.ui.rebuildLayers();
            const container = document.getElementById('operation-form-container');
            const anchorId = this.selection.anchor();
            const anchor = anchorId ? this.scene.findShape(anchorId) : null;
            if (container && anchor?.operation && this.ui.shapeOperationPanel) {
                this.ui.shapeOperationPanel.showOperationProperties(container, anchor);
            }
        }

        ensureBucketParamsLoaded(operations) {
            for (const op of operations) {
                const bucket = this.ui.opsPanel?.getBucket(op.id);
                if (bucket) {
                    this.parameterManager.loadFromOperation({
                        id: op.id, type: op.type, settings: bucket.settings || {}
                    });
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
            const hidden = document.getElementById('file-input-hidden');
            if (importBtn && hidden) {
                importBtn.addEventListener('click', () => {
                    hidden.accept = '.svg,.stl';
                    hidden.onchange = async (e) => { const f = e.target.files?.[0]; if (f) await this.processFile(f); hidden.value = ''; };
                    hidden.click();
                    this.closeDropdown();
                });
            }

            const canvas = document.getElementById('preview-canvas');
            const container = canvas?.parentElement;
            if (container) {
                container.addEventListener('dragover', e => { if (!document.querySelector('.modal.active')) e.preventDefault(); });
                container.addEventListener('drop', e => {
                    if (document.querySelector('.modal.active')) return;
                    e.preventDefault();
                    const f = e.dataTransfer.files?.[0];
                    if (f && /\.(svg|stl)$/i.test(f.name)) this.processFile(f);
                    else if (f) this.ui.setStatus(`Unsupported file: ${f.name}`, 'warning');
                });
            }

            document.getElementById('btn-clear-all')?.addEventListener('click', () => {
                if (this.scene.shapeCount() === 0) return;
                this.clearScene(); this.ui.renderAll(); this.ui.setStatus('Scene cleared');
            });

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
                        case 'example': this.loadExample('mesa'); break;
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