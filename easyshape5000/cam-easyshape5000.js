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
      this._3dFocus = null; // the focus the 3D view last drew - see refresh3DFocus
    }

    // ────────────────────────────────────────────────────────────────────
    // Template Hooks
    // ────────────────────────────────────────────────────────────────────

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
      // Spin the field worker pool up once the page has settled, so the first
      // relief/rotary/vcarve generation doesn't pay importScripts cold-start.
      // Safe if the pool fails - sync paths take over.
      this.whenSettled(() => window.FieldWorkerClient.warmUp());
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
        this.openFilePicker();
        this.closeDropdown();
      });
      document.getElementById('btn-undo')?.addEventListener('click', () => {
        const lbl = this.history.getTopUndoLabel();
        if (this.history.undo()) this.ui.setStatus(i18n.t('messages.history.undone', { action: lbl }));
      });
      document.getElementById('btn-redo')?.addEventListener('click', () => {
        if (this.history.redo()) this.ui.setStatus(i18n.t('messages.history.redone', { action: this.history.getTopUndoLabel() || '' }));
      });
      // The radial scene draws its workholding from the focused parameters
      // (holding mode, both ends, tool diameter), so any edit to them redraws it.
      this.parameterStore.addChangeListener(({ operationId }) => {
        if (this.renderMode !== '3d') return;
        const focus = this.get3DFocus();
        if (focus.axis !== null && operationId === focus.paramsId) this.refresh3D();
      });
      // The 3D workspace card opens the 3D view: pointing at it starts the module.
      const card3D = document.getElementById('pipeline-3d');
      card3D.addEventListener('pointerenter', () => this.load3D(), { once: true });
      card3D.addEventListener('focus', () => this.load3D(), { once: true });
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
      const want3D = pipelineId === '3d';
      this.setWorkspaceDimensions(want3D ? null : ['2d', '2.5d']);
      // Each card names its view, so picking the other one switches back.
      if (want3D !== (this.renderMode === '3d')) queueMicrotask(() => this.toggle3DMode());
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

    /** A mesh-only scene has no 2D drawing worth switching to. */
    has2DContent() {
      let any = false;
      for (const shape of this.scene.allShapes()) {
        any = true;
        if (!shape.mesh?.triangles?.length) return true;
      }
      return !any; // empty scene: leave the toggle free
    }

    getQuickstartOpTypes() {
      return ['unassigned'];
    }

    getTreeFocusSelector() {
      return '#scene-tree-list [tabindex="0"]';
    }

    handleEscapeKey(e) {
      if (this.selection.size() > 0) this.selection.clear();
    }

    // ────────────────────────────────────────────────────────────────────
    // 3D Render Mode
    // ────────────────────────────────────────────────────────────────────

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
     * EasyShape's model layer: the relief/rotary mesh, its rotary envelope and the blank a
     * rotary result was cut from, and in the radial scene the ground grid and the chuck and
     * tailstock. The stock slab, the layer mirror and the plan push are the base class's.
     * In the radial scene (ctx.frameAxis) everything sits about the rotary axis through the
     * origin - the frame the generators slice in, so the model stays put when a result
     * arrives.
     */
    refresh3DModel(ctx) {
      const { view, machineMatrix, topZ, frameAxis, focus } = ctx;
      const { op, nodeId } = focus;
      this._3dFocus = focus;
      view.stock.removeRotaryBlank();
      view.stock.removeRotaryEnvelope();
      view.workholding.clear();
      // A result shows the copy of the mesh it was cut from, so model and toolpaths can
      // never disagree; before one, the scene's own placement.
      const shape = nodeId ? this.scene.findShape(nodeId) : null;
      if (shape && !shape.isVisible) {
        view.stock.removeTriangleMesh();
        return;
      }
      if (frameAxis) {
        const settings = this.core.settings;
        const frame = FieldParams.radialFrame(settings);
        const placed = op
          ? op.sourceMesh
          : shape
            ? Transform3D.placeMeshRadial(shape.mesh, shape.transform, shape.getWorldMatrix(), frame)
            : null;
        // The model's axial ends, and the radius the holders are sized from: the blank a
        // result was cut from, else the cylinder the mesh sweeps about the axis in this
        // orientation - what the blank has to hold and every tool has to clear.
        let span = null;
        if (placed) {
          view.stock.setTriangleMesh(placed.triangles, { nodeId });
          const b = placed.bounds3D;
          span = {
            low: frameAxis === 'y' ? b.minY : b.minX,
            high: frameAxis === 'y' ? b.maxY : b.maxX,
            radius: Transform3D.sweptRadius(placed.triangles, frameAxis),
          };
          view.stock.setRotaryEnvelope({ axis: frameAxis, axialMin: span.low, axialMax: span.high, radius: span.radius });
        } else {
          view.stock.removeTriangleMesh();
        }
        if (op) {
          // The blank along the grid the result was sliced on. Cell CENTRES: originX is
          // column 0's centre, so the grid spans (cols - 1) cells, not cols.
          const meta = op.offsets[0].metadata;
          const f = meta.indexedFrame;
          const length = f ? Math.max(0, f.gridCols - 1) * f.cellSize : (meta.gridCols - 1) * meta.cellSize;
          const along = (f ? f.originX : meta.originX) + length / 2;
          const center = frameAxis === 'y' ? { x: 0, y: along, z: 0 } : { x: along, y: 0, z: 0 };
          if (f) {
            // Indexed 3+1: an N-gon prism drawn from the SAME clearRadius
            // insertIndexMoves lifts its rotation moves above, so a bad apothem or
            // a blank the tool would hit shows before the cut.
            view.stock.setIndexedBlank({
              clearRadius: f.clearRadius,
              length,
              axis: frameAxis,
              faces: f.faceCount,
              startAngleDeg: f.startAngle,
              center,
            });
          } else {
            view.stock.setRotaryBlank({ refRadius: meta.refRadius, length, axis: frameAxis, center });
          }
          if (span) span.radius = f ? f.clearRadius : meta.refRadius;
        }
        // Machine Settings' 4th-axis view. The grid sits at the program's Z0: the rotation
        // centerline, under Absolute Z0 the bed (the axis height below it), and on the
        // axis-replacement route the blank's top.
        const g = settings.gcode;
        const gridZ = g.absoluteZ && g.rotaryAxisHeight > 0 ? -g.rotaryAxisHeight : g.rotaryRoute === 'wrapped-linear' ? (span?.radius ?? 0) : 0;
        view.setRadialGrid(settings.machine.view.rotaryGrid ? gridZ : null);
        if (span && settings.machine.view.rotaryWorkholding) {
          const params = focus.paramsId ? this.parameterStore.getAllParameters(focus.paramsId) : {};
          const { holdingMode, ends } = FieldParams.workholding({ ...params, rotaryChuckSide: frame.chuckSide });
          // Each holder stands clear of the cut: past the end's machining reach (the offset
          // the operation sets) by one tool diameter - the flank's reach and as much again.
          const toolD = Number(params.toolDiameter) || 0;
          const past = (end) => (Number.isFinite(end.reach) ? Math.max(0, end.reach) : 0) + toolD;
          view.workholding.set({
            axis: frameAxis,
            low: span.low - past(ends.low),
            high: span.high + past(ends.high),
            radius: span.radius,
            chuckSide: frame.chuckSide,
            tail: holdingMode === 'between_centers',
          });
        }
        return;
      }
      if (op) {
        // Flat relief. sourceMesh already carries the shape's placement (syncPrimitives baked
        // it), so only the machine map is left. The workspace matrix carries no scale, so Z
        // passes through. Seated by its top on the stock surface, then moved by the Z offset
        // it was cut with.
        const triangles = Transform3D.placeTriangles(op.sourceMesh.triangles, { m: machineMatrix }).triangles;
        const offsetZ = topZ - op.sourceMesh.bounds3D.maxZ + op.sourceMesh.offsetZ;
        view.stock.setTriangleMesh(triangles, { offsetZ, nodeId });
        return;
      }
      // Before a result: every visible mesh in its full placement, each seated by
      // its own top and moved by its Z offset.
      const parts = [];
      for (const sid of this.scene.collectShapeIds(this.scene.root)) {
        const s = this.scene.findShape(sid);
        if (!s?.mesh?.triangles?.length || !s.isVisible) continue;
        const wm = s.getWorldMatrix();
        const totalM = TransformMath.isIdentity(machineMatrix) ? wm : TransformMath.multiply(machineMatrix, wm);
        const placed = Transform3D.placeMesh(s.mesh, s.transform, totalM);
        parts.push({ nodeId: s.id, triangles: placed.triangles, dz: topZ - (placed.bounds3D ?? s.mesh.bounds3D).maxZ + s.transform.z, });
      }
      if (parts.length === 0) {
        view.stock.removeTriangleMesh();
      } else if (parts.length === 1) {
        view.stock.setTriangleMesh(parts[0].triangles, { offsetZ: parts[0].dz, nodeId: parts[0].nodeId });
      } else {
        // One mesh for the view, each part dropped to its own top. The
        // transform can return the source array, so parts are copied,
        // never shifted in place. A merged mesh has no single node to pick.
        const merged = new Float32Array(parts.reduce((n, p) => n + p.triangles.length, 0));
        let at = 0;
        for (const { triangles, dz } of parts) {
          for (let i = 0; i < triangles.length; i += 3) {
            merged[at + i] = triangles[i];
            merged[at + i + 1] = triangles[i + 1];
            merged[at + i + 2] = triangles[i + 2] + dz;
          }
          at += triangles.length;
        }
        view.stock.setTriangleMesh(merged);
      }
    }

    /**
     * What the 3D view is about - the one decision render3D, refresh3DModel, the transform
     * grid and the rotation cue all read: a bucket's stage shows that bucket, a selection
     * offered under the Rotary tab its mesh in the radial frame, any other selection the
     * flat scene, and nothing selected what the view last showed, while it still exists,
     * else the first current 3D result (generated, not stale) or null; `nodeId` the mesh
     * the scene singles out; `axis` the machine rotary axis of the radial frame, null for
     * the flat one; `paramsId` the id whose parameters describe the scene.
     */
    get3DFocus() {
      const current = (op) => op && !op.isInvalidated && op.sourceMesh?.triangles?.length && op.offsets?.[0]?.metadata?.is3DToolpath ? op : null;
      const meshIn = (ids = []) => ids.find((id) => this.scene.findShape(id)?.mesh) || null;
      const axisIf = (radial) => (radial ? FieldParams.radialFrame(this.core.settings).axis : null);
      const { panelState, activeOpType } = this.ui;
      const bucket = panelState === 'bucket-stage' ? this.ui.shapeOperationPanel.currentBucket : null;
      if (bucket) {
        return {
          op: current(this.core.store.getOperation(bucket.id)),
          nodeId: meshIn(bucket.shapeRefs),
          axis: axisIf(bucket.type === 'rotary'),
          paramsId: bucket.id,
        };
      }
      if (panelState === 'source-selected') {
        // The flat scene draws every visible mesh; only the radial one singles one out.
        if (activeOpType !== 'rotary') return { op: null, nodeId: null, axis: null, paramsId: null };
        const ids = this.selection.toArray().flatMap((id) => this.scene.collectShapeIds(this.scene.findNode(id)));
        return { op: null, nodeId: meshIn(ids), axis: axisIf(true), paramsId: this.selection.anchor() };
      }
      // Escape must not flip the view: with nothing selected it keeps what it last
      // showed while that still exists. The axis is re-read from the settings.
      const shown = this._3dFocus;
      if (shown
        && (!shown.op || current(shown.op))
        && (!shown.nodeId || this.scene.findShape(shown.nodeId))
        && (!shown.paramsId || this.core.store.getOperation(shown.paramsId) || this.scene.findNode(shown.paramsId))) {
        return { ...shown, axis: axisIf(shown.axis !== null) };
      }
      const op = this.core.operations.find(current) || null;
      const meta = op?.offsets[0].metadata;
      return {
        op,
        nodeId: op ? meshIn(this.ui.opsPanel.getBucket(op.id)?.shapeRefs) : null,
        axis: axisIf(!!(meta?.developedSpace || meta?.indexedFrame)),
        paramsId: op?.id ?? null,
      };
    }

    /**
     * The 3D cue for a focused Shape Transform field: the selected mesh where the view draws
     * it (the placements refresh3DModel uses) and the direction a positive value moves it
     * along (`kind` 'offset') or turns it about ('rotation', right-hand rule). Flat offsets
     * move the anchor in its parent's frame, radial ones the mesh along the machine axes.
     * Placement is A·Ry(tiltY)·Rx(tiltX), so a tilt turns the mesh about its own axis as the
     * later steps carry it - with Z at 90°, the Y field turns it about world X - and a
     * reflection reverses a turn.
     * @param {'offset'|'rotation'} kind
     * @param {'x'|'y'|'z'} axis - the field's axis; a Z rotation is the anchor's own
     */
    showTransformCue(kind, axis) {
      const view = this.renderer3D;
      if (!view || this.renderMode !== '3d') return;
      const targets = this.ui.transformTargets();
      const shape = targets?.mesh;
      if (!shape?.isVisible) {
        view.setTransformCue(null);
        return;
      }
      const t = shape.transform;
      const wm = shape.getWorldMatrix();
      const machineMatrix = this.core.pipelineContext.getTransforms().machineMatrix;
      const parent = targets.node.parent?.kind === 'root' ? null : targets.node.parent;
      const parentMatrix = parent ? parent.getWorldMatrix() : TransformMath.identity();
      let m;
      let outer;
      let b;
      if (targets.radial) {
        m = { a: wm.a, b: wm.b, c: wm.c, d: wm.d, e: 0, f: 0 };
        outer = parentMatrix;
        b = Transform3D.placeMeshRadial(shape.mesh, t, wm, FieldParams.radialFrame(this.core.settings)).bounds3D;
      } else {
        m = TransformMath.multiply(machineMatrix, wm);
        outer = TransformMath.multiply(machineMatrix, parentMatrix);
        const placed = Transform3D.placeMesh(shape.mesh, t, m).bounds3D ?? shape.mesh.bounds3D;
        const topZ = this.get3DStockBox()?.surfaceZ ?? 0; // seated by its own top, moved by its Z offset
        const dz = topZ - placed.maxZ + t.z;
        b = { ...placed, minZ: placed.minZ + dz, maxZ: placed.maxZ + dz };
      }
      let dir;
      let flip = false;
      if (kind === 'offset') {
        // Radial offsets run along the machine axes; flat X/Y move the anchor in its parent's frame.
        dir = targets.radial
          ? { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis]
          : axis === 'x'
            ? [outer.a, outer.b, 0]
            : axis === 'y'
              ? [outer.c, outer.d, 0]
              : [0, 0, 1];
      } else if (axis === 'z') {
        dir = [0, 0, 1];
        flip = TransformMath.det(outer) < 0;
      } else {
        const P = Transform3D.placement({ tiltX: t.rotationX, tiltY: t.rotationY, m, scaleZ: Math.hypot(m.a, m.b) }).m;
        const column = (k) => [P[k], P[3 + k], P[6 + k]];
        const [cx, cy, cz] = [column(0), column(1), column(2)];
        const tilt = (t.rotationX * Math.PI) / 180;
        // X turns about the mesh's X as placed; Y about its Y before the X tilt.
        dir = axis === 'x' ? cx : cy.map((v, i) => Math.cos(tilt) * v - Math.sin(tilt) * cz[i]);
        flip = Transform3D.det(P) < 0;
      }
      const length = Math.hypot(...dir) * (flip ? -1 : 1);
      dir = dir.map((v) => v / length);
      const origin = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
      const half = [(b.maxX - b.minX) / 2, (b.maxY - b.minY) / 2, (b.maxZ - b.minZ) / 2];
      const span = 2 * Math.max(...half);
      if (kind === 'offset') {
        // How far the box reaches along the move, so the arrow starts outside the model.
        const extent = half[0] * Math.abs(dir[0]) + half[1] * Math.abs(dir[1]) + half[2] * Math.abs(dir[2]);
        view.setTransformCue({ kind, axis, origin, dir, span, extent });
        return;
      }
      // The box corner farthest from the axis, so the arrow clears the model.
      let radius = 0;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const v = [sx * half[0], sy * half[1], sz * half[2]];
            const along = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
            radius = Math.max(radius, Math.hypot(v[0] - along * dir[0], v[1] - along * dir[1], v[2] - along * dir[2]));
          }
        }
      }
      view.setTransformCue({ kind, axis, origin, dir, span, radius: 1.1 * radius });
    }

    /**
     * Refreshes the 3D view when the focus moved from the one it last drew - frame,
     * result, mesh or parameters. A selection that leaves them alone costs no rebuild.
     */
    refresh3DFocus() {
      const f = this.get3DFocus();
      const shown = this._3dFocus;
      if (
        !shown ||
        f.axis !== shown.axis ||
        f.op !== shown.op ||
        f.nodeId !== shown.nodeId ||
        f.paramsId !== shown.paramsId
      ) {
        this.refresh3D();
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
      if (!nodeId && hit.layerName?.startsWith('shape_')) nodeId = hit.layerName.slice('shape_'.length);
      if (!nodeId || !this.scene.findNode(nodeId)) return;
      const radial = this.get3DFocus().axis !== null;
      this.scene.selection.replace([nodeId]);
      // A pick in the radial scene keeps it: the picked mesh is offered under the Rotary tab.
      if (radial) this.ui.activateOpType('rotary');
      this.ui.renderAll();
    }

    // ────────────────────────────────────────────────────────────────────
    // File Import
    // ────────────────────────────────────────────────────────────────────

    /** Every file loads into the scene unassigned; buckets assign operation types later. */
    routeFile(file) {
      return this.core.ingest.validateFileType(file.name, 'unassigned').valid ? 'unassigned' : null;
    }

    /**
     * Standardized entry point for ModalManager/Quickstart.
     * Routes files to the correct importer based on extension.
     */
    async processFile(file, type) {
      const ext = file.name.toLowerCase().split('.').pop();
      if (ext === 'svg') {
        await this.importSVG(file);
      } else if (ext === 'stl') {
        await this.importSTL(file);
      } else {
        this.ui.setStatus(i18n.t('messages.files.unsupportedType', { ext }), 'warning');
      }
    }

    /**
     * Rebuilds a mesh shape's footprint - the XY box of its tilted mesh - so 2D
     * bounds, picking, Fit and the board bounds follow a tilt. The shape's 2D
     * transform still applies on top.
     */
    refreshMeshFootprint(node) {
      const t = node.transform;
      const tilted = Transform3D.placeMesh(node.mesh, { z: 0, rotationX: t.rotationX, rotationY: t.rotationY }, TransformMath.identity());
      const b = tilted.bounds3D ?? node.mesh.bounds3D;
      node.setPrimitive(new RectanglePrimitive(
        { x: b.minX, y: b.minY },
        b.maxX - b.minX,
        b.maxY - b.minY,
        { ...node.primitive.properties, meshHeight: b.maxZ - b.minZ }
      ));
      this.scene.recomputeBoardBoundsFromShapes();
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
      let buffer;
      try { buffer = await file.arrayBuffer(); }
      catch (err) { this.ui.setStatus(i18n.t('messages.files.readFailed', { file: file.name, error: err }), 'error'); return; }
      const parseResult = new STLParser().parse(buffer);
      if (!parseResult.success) {
        this.ui.setStatus(i18n.t('messages.files.stlParseError', { errors: parseResult.errors }), 'error');
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
        node.label = solids.length > 1 ? i18n.t('panels.scene.meshName', { name: solid.name || `${stem} ${i + 1}` }) : i18n.t('panels.scene.meshName', { name: stem });
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
      const minZ = Math.min(...solids.map((s) => s.bounds3D.minZ));
      const maxZ = Math.max(...solids.map((s) => s.bounds3D.maxZ));
      const loaded = { file: file.name, triangles: parseResult.triangleCount, count: solids.length, height: (maxZ - minZ).toFixed(2) };
      this.ui.reportFileLoaded(file.name, i18n.t(solids.length > 1 ? 'messages.files.stlLoadedMeshes' : 'messages.files.stlLoaded', loaded), parseResult.warnings);
      this.load3D(); // a mesh is viewed in 3D next
    }

    async importSVG(file) {
      let content;
      try { content = await file.text(); }
      catch (err) { this.ui.setStatus(i18n.t('messages.files.readFailed', { file: file.name, error: err }), 'error'); return; }
      const parser = new SVGParser();
      const parseResult = parser.parse(content);
      if (!parseResult.success) { this.ui.setStatus(i18n.t('messages.files.parseError', { errors: parseResult.errors }), 'error'); return; }
      const plotter = new ParserPlotter({ markStrokes: true });
      const plotResult = plotter.plot(parseResult);
      if (!plotResult.success) { this.ui.setStatus(i18n.t('messages.files.plotterError', { error: plotResult.error }), 'error'); return; }
      const beforeCount = this.scene.shapeCount();
      this.scene.addShapesFromPlot(plotResult.primitives, file.name);
      const added = this.scene.shapeCount() - beforeCount;
      this.history.clear();
      this.scene.recomputeBoardBoundsFromShapes();
      this.ui.renderAll();
      this.ui.reportFileLoaded(file.name, i18n.t('messages.files.svgImported', { file: file.name, count: added }), parseResult.warnings);
    }

    // ────────────────────────────────────────────────────────────────────
    // Mutation Helpers
    // ────────────────────────────────────────────────────────────────────

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

    // ────────────────────────────────────────────────────────────────────
    // Shape Mutations
    // ────────────────────────────────────────────────────────────────────

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
      const shapeText = i18n.t('dialogs.deleteGeometry.items', { count: snapshots.length });
      const message = removed.length
        ? i18n.t('dialogs.deleteGeometry.messageWithOps', { items: shapeText, count: removed.length })
        : i18n.t('dialogs.deleteGeometry.message', { items: shapeText });
      this.confirmDestructive(i18n.t('dialogs.deleteGeometry.title'), message,  () => {
        const cmds = [ new DeleteShapesCommand(snapshots) ];
        (removed.length || pruned.length) && cmds.push(new RemoveBucketsCommand(removed, pruned));
        this.history.executeAndRecord(1 === cmds.length ? cmds[0] : new CompositeCommand(cmds, { key: 'history.deleteItems', values: { items: { key: 'dialogs.deleteGeometry.items', values: { count: snapshots.length } } } }));
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
        if (targetIds.length === 0) { this.ui.setStatus(i18n.t('messages.scene.lockedByParent'), 'warning'); return; }
        if (blocked.length > 0) this.ui.setStatus(i18n.t('messages.scene.skippedLocked', { count: blocked.length }), 'info');
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
      if (ids.length < 2) { this.ui.setStatus(i18n.t('messages.scene.groupNeedsTwo')); return; }
      const snapshots = ids.map(id => { const n = this.scene.findNode(id); return { nodeId: id, parentId: n.parent?.id || null, indexInParent: n.parent ? n.parent.children.indexOf(n) : -1 }; });
      const firstNode = this.scene.findNode(ids[0]);
      this.history.executeAndRecord(new GroupCommand(snapshots, firstNode.parent?.id || null, firstNode.parent ? firstNode.parent.children.indexOf(firstNode) : 0, `g_${Date.now()}`));
      this.ui.setStatus(i18n.t('messages.scene.grouped', { count: ids.length }), 'success');
    }

    ungroupSelection() {
      const groupIds = this.getActionableIds().filter(id => { const n = this.scene.findNode(id); return n?.kind === 'group' && n.children?.length > 0; });
      if (groupIds.length === 0) { this.ui.setStatus(i18n.t('messages.scene.nothingToUngroup')); return; }
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
      else if (commands.length > 1) this.history.executeAndRecord(new CompositeCommand(commands, { key: 'history.ungroupMany', values: { count: commands.length } }));
      this.ui.setStatus(i18n.t('messages.scene.ungrouped', { count: commands.length }), 'success');
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

    // ────────────────────────────────────────────────────────────────────
    // Bucket Lifecycle
    // ────────────────────────────────────────────────────────────────────

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
      let staled = false;
      if (this.ui.opsPanel) {
        // Collect IDs of shapes that could have changed
        const changedShapeIds = new Set();
        for (const id of this.selection.toArray()) {
          const node = this.scene.findNode(id);
          if (!node) continue;
          if (node.kind === 'shape') changedShapeIds.add(id);
          else for (const sid of this.scene.collectShapeIds(node)) changedShapeIds.add(sid);
        }
        const reason = { key: 'messages.operations.sourceChanged' };
        for (const bucket of this.ui.opsPanel.getAllBuckets()) {
          // Only invalidate if this bucket references an affected shape
          if (!bucket.shapeRefs.some(ref => changedShapeIds.has(ref))) continue;
          if (this.core.store.invalidateOperationState(bucket.id, reason)) {
            this.ui.opsPanel.updateBucketDOM(bucket, this.core);
            staled = true;
          }
        }
      }
      this.ui.renderAll();
      this.sync3DToggleAvailability();
      this.ui.syncTransformFromSelection();
      // The 3D view would keep drawing the stale results
      if (staled) this.refresh3D();
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

    // ────────────────────────────────────────────────────────────────────
    // Toolbar
    // ────────────────────────────────────────────────────────────────────

    /**
     * Puts the origin on the bounding box of the selection, or of all
     * content when nothing is selected - the same set Fit to Object wraps -
     * and remembers the anchor for the next fit.
     */
    placeOrigin(anchor) {
      this.originAnchor = anchor;
      const stock = this.core.stock;
      if (stock && stock.width > 0 && stock.length > 0 && this.stockPlacement) {
        const { minX, minY } = this.stockPlacement;
        if (anchor === 'center') {
          this.scene.setOrigin(minX + stock.width / 2, minY + stock.length / 2);
        } else {
          this.scene.setOrigin(minX, minY);
        }
        this.ui.renderer.render();
        return;
      }
      let b = this.scene.getSelectionWorldBounds();
      if (!b) {
        this.scene.recomputeBoardBoundsFromShapes();
        b = this.scene.getBoardBounds();
      }
      if (!b) {
        this.ui.setStatus(i18n.t('messages.stock.noOriginTarget'), 'warning');
        return;
      }
      if (anchor === 'center') this.scene.setOrigin((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
      else this.scene.setOrigin(b.minX, b.minY);
      this.ui.renderer.render();
    }

    // ────────────────────────────────────────────────────────────────────
    // Modals
    // ────────────────────────────────────────────────────────────────────

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
        if (ids.length === 0) { this.ui.setStatus(i18n.t('messages.stock.nothingToFit'), 'warning'); return; }
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
          // The mesh is the raw import: its Z span follows the tilt and the
          // shape's scale - the placement syncPrimitives bakes into the operation.
          if (s.mesh?.bounds3D) {
            const b3 = Transform3D.placeMesh(s.mesh, s.transform, s.getWorldMatrix()).bounds3D ?? s.mesh.bounds3D;
            // A sunk mesh (negative Z) needs that much more stock under its seat.
            meshSpanZ = Math.max(meshSpanZ, b3.maxZ - b3.minZ - s.transform.z);
          }
        }
        if (!isFinite(minX)) { this.ui.setStatus(i18n.t('messages.stock.nothingToFit'), 'warning'); return; }
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
        if (this.originAnchor === 'bottom-left') {
          this.scene.setOrigin(this.stockPlacement.minX, this.stockPlacement.minY);
        } else {
          this.scene.setOrigin(this.stockPlacement.minX + (maxX - minX + 2 * margin) / 2, this.stockPlacement.minY + (maxY - minY + 2 * margin) / 2);
        }
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

  // ────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ────────────────────────────────────────────────────────────────────

  let ctrl = null;

  async function startShapeApp() {
    if (ctrl) return ctrl;
    ctrl = new EasyShapeController();
    await ctrl.initialize();
    return ctrl;
  }

  window.startShapeApp = startShapeApp;
})();