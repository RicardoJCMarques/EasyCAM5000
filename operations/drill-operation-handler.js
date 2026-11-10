/*!
 * @file        operations/drill-operation-handler.js
 * @description Drill strategy planning, SVG classification, and shape recovery
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  const ROOT = globalThis;
  const C = ROOT.CAMConfig.constants;
  const D = ROOT.CAMConfig.defaults;
  const PRECISION = C.precision.coordinate;
  // Row fields baked into primitive geometry at generation. Editing one
  // stales the operation; everything else resolves at translation.
  const GEOMETRY_FIELDS = new Set(['strategy', 'toolId', 'toolDiameter', 'mill']);
  // A slot row's key: its width's diameterKey plus this.
  const SLOT_SUFFIX = ':slot';

  class DrillHandler extends BaseOperationHandler {
    /**
     * Post-parse classification. SVG needs role tags derived from shape;
     * the Excellon plotter already assigns them, but only this hook builds
     * the per-diameter taxonomy every downstream consumer reads.
     */
    postParsePrimitives(operation) {
      if (operation.file.name.toLowerCase().endsWith('.svg')) {
        this.classifySVGDrillPrimitives(operation);
        return;
      }
      this.refreshDrillSummary(operation, 'excellon');
    }

    /**
     * True when the per-diameter table is authoritative. The drillMultiTool
     * checkbox is the ONLY writer of this decision. table.preset records how
     * the rows were SEEDED and must never be read as authority - a feed edit
     * in the modal sets preset='custom', which would otherwise move the
     * operation out of single-tool mode behind the operator's back.
     */
    static isMultiTool(settings) {
      return Boolean(settings?.drillMultiTool);
    }

    /**
     * The one place a diameter becomes a string key: rowKey builds on it and
     * splitDrillFiles names its bits with it. Change the rounding here and
     * they stop agreeing silently.
     */
    static diameterKey(diameter) {
      return Number(diameter).toFixed(3);
    }

    /**
     * A slot with length. A zero-length slot is a hole the plotter wrote as
     * a route, and drills as one.
     */
    static isSlot(prim) {
      const props = prim.properties;
      const slot = props?.role === 'drill_slot' ? props.originalSlot : null;
      return !!slot && Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y) >= PRECISION;
    }

    /**
     * A table row's key. Holes and slots of one size are separate rows, so
     * each takes its own strategy and cutter. The table, the export tool
     * map, the depth ladders and every drill primitive's drillKey match on
     * this string.
     */
    static rowKey(diameter, isSlot) {
      const key = DrillHandler.diameterKey(diameter);
      return isSlot ? key + SLOT_SUFFIX : key;
    }

    /** A row in words, from its key: "1 mm holes" or "1 mm slots". */
    static rowLabel(key) {
      const kind = key.endsWith(SLOT_SUFFIX) ? 'slotSize' : 'holeSize';
      return { key: `modals.drillTooling.${kind}`, values: { size: parseFloat(key) } };
    }

    /**
     * Feature taxonomy for one drill operation, one entry per table row.
     * Excellon header tool ids ride along as advisory text only: a header T
     * index is a file index, not a magazine slot.
     */
    static summarizePrimitives(primitives, source) {
      const sizes = new Map();
      const slotSizes = new Map();
      let totalHoles = 0;
      let totalSlots = 0;
      for (const prim of primitives || []) {
        const props = prim.properties;
        const role = props?.role;
        const diameter = props?.diameter;
        if (!diameter || role !== 'drill_hole' && role !== 'drill_slot') continue;
        const isSlot = DrillHandler.isSlot(prim);
        const key = DrillHandler.rowKey(diameter, isSlot);
        let size = sizes.get(key);
        if (!size) {
          size = { key, diameter: parseFloat(key), holes: 0, slots: 0, nativeTools: [] };
          sizes.set(key, size);
        }
        if (props.tool && !size.nativeTools.includes(props.tool)) size.nativeTools.push(props.tool);
        if (!isSlot) {
          size.holes++;
          totalHoles++;
          continue;
        }
        size.slots++;
        totalSlots++;
        const slot = props.originalSlot;
        const len = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y);
        const slotKey = `${DrillHandler.diameterKey(diameter)}x${(len + diameter).toFixed(3)}`;
        slotSizes.set(slotKey, (slotSizes.get(slotKey) || 0) + 1);
      }
      // By size, each size's hole row before its slot row.
      const ordered = [...sizes.values()].sort((a, b) => a.diameter - b.diameter || a.slots - b.slots);
      return {
        sizes: ordered,
        holes: ordered.filter(s => s.holes > 0).map(s => ({ diameter: s.diameter, count: s.holes })),
        slots: [...slotSizes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, count]) => {
          const [width, length] = key.split('x').map(parseFloat);
          return { width, length, count };
        }),
        totalHoles,
        totalSlots,
        source
      };
    }

    /**
     * Rebuilds the summary from the CURRENT primitive set, preserving the
     * rejection record the SVG classifier produced. EasyShape re-syncs
     * primitives without re-parsing, so this has to be cheap and repeatable.
     */
    refreshDrillSummary(operation, source = null) {
      const previous = operation.drillSummary;
      operation.drillSummary = {
        ...DrillHandler.summarizePrimitives(operation.primitives, source || previous?.source || 'primitives'),
        totalAccepted: operation.primitives?.length || 0,
        totalRejected: previous?.totalRejected || 0,
        rejected: previous?.rejected || []
      };
      return operation.drillSummary;
    }

    /**
     * Builds a fresh drill table from the current summary.
     * null in a row means INHERIT the operation, which is what keeps the
     * single-tool desktop path one click. Rows carry no toolNumber
     * because a slot number is not derivable from a diameter - the
     * operator assigns one per row when they want the change, and until
     * then every row cuts on the operation's own number.
     */
    buildDrillTable(operation, preset = 'flatten') {
      const table = { preset, rows: {}, generatedAt: Date.now() };
      const sizes = operation.drillSummary?.sizes;
      if (!sizes?.length) return table;
      const library = this.core?.toolLibrary || null;
      const useLibrary = preset === 'match' && library;
      for (const size of sizes) {
        const row = {
          key: size.key,
          diameter: size.diameter,
          holes: size.holes,
          slots: size.slots,
          nativeTools: size.nativeTools || [],
          strategy: size.slots > 0 ? 'mill' : 'peck',
          toolId: null,
          toolDiameter: size.diameter,
          toolNumber: null,
          cutting: null,
          peck: null,
          mill: null
        };
        if (useLibrary) this.matchLibraryTool(row, library);
        table.rows[size.key] = row;
      }
      return table;
    }

    /**
     * Seeds one row from the tool library. A hole takes a drill within
     * matchTolerance, else the largest flat end mill that clears it by
     * millMargin; a slot takes the largest flat end mill no wider than
     * itself, else such a drill. With neither, the row is skipped.
     */
    matchLibraryTool(row, library) {
      const tolerance = D.toolpath.generation.drilling.matchTolerance;
      const margin = D.toolpath.generation.drilling.millMargin;
      const sized = type => library.getToolsByType(type).map(tool => ({ tool, diameter: tool.geometry.diameter }));
      const drill = sized('drill')
        .filter(e => Math.abs(e.diameter - row.diameter) <= tolerance)
        .sort((a, b) => Math.abs(a.diameter - row.diameter) - Math.abs(b.diameter - row.diameter))[0];
      // Flat end mills only: a ball or bull nose leaves a rounded floor. A
      // slot's own width still fits: it mills in one centreline pass.
      const room = row.slots > 0 ? -PRECISION : margin;
      const mill = sized('flat').filter(e => e.diameter <= row.diameter - room).sort((a, b) => b.diameter - a.diameter)[0];
      const order = row.slots > 0 ? [['mill', mill], ['peck', drill]] : [['peck', drill], ['mill', mill]];
      const [strategy, match] = order.find(([, candidate]) => candidate) ?? ['skip', null];
      row.strategy = strategy;
      if (match) this.applyLibraryTool(row, match.tool, match.diameter);
    }

    /**
     * Assigns the cutter and the feeds the modal shows. mill.stepOver,
     * mill.depthPerPass and peck.dwellTime stay null on purpose: all three
     * are read downstream (buildDrillDepthLevels' per-key depth ladder,
     * processPeckMark's G82 dwell) and the modal has no column to show or
     * clear them. Surface them before writing them.
     */
    applyLibraryTool(row, tool, diameter) {
      const cut = tool.cutting || {};
      row.toolId = tool.id;
      row.toolDiameter = diameter ?? null;
      // A numbered library tool brings its T number; an unnumbered one
      // leaves the row's number alone. importTools validates and dedups it.
      if (Number.isInteger(tool.toolNumber) && tool.toolNumber > 0) row.toolNumber = tool.toolNumber;
      row.cutting = {
        feedRate: cut.feedRate ?? null,
        plungeRate: cut.plungeRate ?? null,
        spindleSpeed: cut.spindleSpeed ?? null
      };
      if (row.strategy === 'peck') {
        row.peck = { peckDepth: cut.peckDepth ?? null, dwellTime: null, cannedCycle: null, retractHeight: null };
        row.mill = null;
      } else {
        row.peck = null;
        row.mill = { stepOver: null, depthPerPass: null, multiDepth: null, entryType: null };
      }
    }

    /**
     * Re-derives the row set from the current geometry while keeping every
     * choice the operator made. Strategy is preserved unconditionally:
     * single-tool mode does not read the rows at all - resolveDrillRow
     * answers from the operation - so rewriting them here to track a
     * checkbox would only destroy per-size work on the way past. New keys
     * seed from the table's preset
     */
    reconcileDrillTable(operation) {
      const preset = operation.drillTable?.preset || 'flatten';
      const previous = operation.drillTable?.rows;
      const table = this.buildDrillTable(operation, preset)
      if (previous) {
        for (const [key, row] of Object.entries(table.rows)) {
          const prior = previous[key];
          if (!prior) continue;
          table.rows[key] = {
            ...prior,
            key,
            diameter: row.diameter,
            holes: row.holes,
            slots: row.slots,
            nativeTools: row.nativeTools
          };
        }
      }
      operation.drillTable = table;
      return table;
    }

    /**
     * Modal write path. Returns true when the patch touched something the
     * generated geometry depends on, which is the caller's signal to stale
     * the operation. A tool number or a feed rate resolves at translation
     * and must not discard generated paths.
     */
    updateDrillRow(operation, key, patch) {
      const row = operation.drillTable?.rows?.[key];
      if (!row) return false;
      Object.assign(row, patch);
      operation.drillTable.preset = 'custom';
      return Object.keys(patch).some(field => GEOMETRY_FIELDS.has(field));
    }

    /**
     * The drill tooling modal's write path: one raw input value in, the
     * row patched through updateDrillRow, the value the input should show
     * back out. A cutter diameter snaps to the 0.001 mm coordinate grid
     * and falls back to the hole size; a T number is a positive integer
     * or nothing; choosing peck gives a row without a cutter the hole's
     * own diameter. Feeds, speed and peck depth are stored as typed,
     * empty meaning inherit.
     * @param {Object} operation
     * @param {string} key - the row's diameter key
     * @param {string} field - strategy | toolDiameter | toolNumber | peckDepth | a cutting field
     * @param {string} raw - the input's value
     * @returns {{stales: boolean, value: *}}
     */
    setDrillField(operation, key, field, raw) {
      const row = operation.drillTable.rows[key];
      const text = String(raw).trim();
      let value = text === '' ? null : field === 'toolNumber' ? parseInt(text, 10) : parseFloat(text);
      let patch;
      if (field === 'strategy') {
        value = text;
        patch = { strategy: value };
        if (value === 'peck' && !(row.toolDiameter > 0)) patch.toolDiameter = row.diameter;
      } else if (field === 'toolDiameter') {
        value = +(value > 0 ? value : row.diameter).toFixed(3);
        patch = { toolDiameter: value };
      } else if (field === 'toolNumber') {
        value = Number.isInteger(value) && value > 0 ? value : null;
        patch = { toolNumber: value };
      } else if (field === 'peckDepth') {
        patch = { peck: { ...row.peck, peckDepth: value } };
      } else {
        patch = { cutting: { ...row.cutting, [field]: value } };
      }
      return { stales: this.updateDrillRow(operation, key, patch), value };
    }

    /**
     * Builds the table on demand from the summary that already exists after
     * parsing, so the modal has rows the moment multi-tool is switched on
     * rather than only after a generation. Re-classifies first when the
     * primitives carry no roles: EasyShape's syncPrimitives copies them raw,
     * and summarizePrimitives would otherwise report zero sizes.
     */
    ensureDrillTable(operation) {
      if (!operation) return null;
      const hasRoles = operation.primitives?.some(p => p.properties?.role);
      if (operation.primitives?.length > 0 && !hasRoles) this.classifySVGDrillPrimitives(operation);
      else this.refreshDrillSummary(operation);
      return this.reconcileDrillTable(operation);
    }

    /** Rebuilds every row from a preset, discarding manual assignments. */
    applyDrillPreset(operation, preset) {
      operation.drillTable = this.buildDrillTable(operation, preset);
      return operation.drillTable;
    }

    /**
     * One read of the drill table for the sidebar card and the action
     * button. Mode comes from the parameter, never from the preset.
     * Single-tool mode never blocks: the operation's own tool and number cut
     * everything and the rows are dormant. In multi-tool mode a row with no
     * cutter or no T number has nothing to fall back on and blocks. An empty
     * table never blocks: EasyShape builds the rows on its first generation.
     */
    static describeTable(operation, settings) {
      const multiTool = DrillHandler.isMultiTool(settings);
      const rows = operation?.drillTable?.rows ? Object.values(operation.drillTable.rows) : [];
      const counts = { peck: 0, mill: 0, skip: 0 };
      const numbers = new Set();
      const unassigned = [];
      const unnumbered = [];
      let reason = null;
      if (multiTool && rows.length > 0) {
        for (const row of rows) {
          counts[row.strategy] = (counts[row.strategy] || 0) + 1;
          if (row.strategy === 'skip') continue;
          if (!(row.toolDiameter > 0)) unassigned.push(DrillHandler.rowLabel(row.key));
          if (Number.isInteger(row.toolNumber) && row.toolNumber > 0) numbers.add(row.toolNumber);
          else unnumbered.push(DrillHandler.rowLabel(row.key));
        }
        if (counts.peck + counts.mill === 0) reason = { key: 'messages.drill.allSkipped' };
        else if (unassigned.length > 0) reason = { key: 'messages.drill.missingDiameter', values: { sizes: unassigned } };
        else if (unnumbered.length > 0) reason = { key: 'messages.drill.missingNumber', values: { sizes: unnumbered } };
      }
      return {
        mode: multiTool ? 'perSize' : 'single', rows,
        counts, numbers: [...numbers].sort((a, b) => a - b),
        reason, complete: reason === null };
    }

    /**
     * Collapses one row plus the operation defaults into the identity a
     * primitive carries downstream. In single-tool mode the row is NOT read:
     * the operation answers everything, so per-size assignments survive a
     * round trip through the checkbox untouched instead of being rebuilt.
     * In multi-tool mode cutting/peck/mill stay as the row wrote them - null
     * means inherit, and the translator resolves that against the operation
     * context. Only the cutter geometry resolves here, because generation
     * needs it to compute paths.
     */
    resolveDrillRow(row, settings, key) {
      const operationDiameter = parseFloat(settings.toolDiameter);
      if (!DrillHandler.isMultiTool(settings)) {
        const strategy = false !== settings.millHoles ? 'mill' : 'peck';
        return {
          key: row?.key || key,
          strategy,
          toolDiameter: operationDiameter,
          stepOver: settings.stepOver,
          tool: this.drillIdentity(null, settings.tool ?? null, strategy, operationDiameter),
          cutting: null,
          peck: null,
          mill: null
        };
      }
      const holeDiam = row?.diameter ? Number(row.diameter) : parseFloat(key);
      const toolDiameter = row?.toolDiameter > 0 ? row.toolDiameter : holeDiam;
      const number = Number.isInteger(row?.toolNumber) && row.toolNumber > 0 ? row.toolNumber : null;
      return {
        key: row?.key || key,
        strategy: row?.strategy || 'peck',
        toolDiameter,
        stepOver: row?.mill?.stepOver ?? settings.stepOver,
        tool: this.drillIdentity(number, row?.toolId ?? null, row?.strategy, toolDiameter),
        cutting: row?.cutting || null,
        peck: row?.peck || null,
        mill: row?.mill || null
      };
    }

    /**
     * The cutter identity a drill primitive carries to the translator, which
     * stamps it on the plan for the post. A library tool goes by its own
     * name; a row with no library tool by the name its kind of cutter
     * generates (tools.names.flat or tools.names.drill).
     */
    drillIdentity(number, id, strategy, diameter) {
      const type = 'mill' === strategy ? 'flat' : 'drill';
      const record = id ? this.core.toolLibrary.getTool(id) : null;
      return {
        number,
        id,
        name: record ? ToolLibrary.label(record) : ToolLibrary.nameFor(type, diameter),
        diameter,
        type
      };
    }

    /**
     * Tool identity every generated drill primitive carries, resolved at
     * creation so no consumer re-derives it from a diameter string.
     */
    stampDrillProps(action, extra) {
      const entry = action.entry;
      return {
        drillKey: entry.key,
        drillTool: entry.tool,
        drillCutting: entry.cutting,
        drillPeck: entry.peck,
        drillMill: entry.mill,
        toolDiameter: entry.toolDiameter,
        ...extra
      };
    }

    /**
     * Stock one preview primitive removes, as polygons to union. A peck
     * mark is drawn at the bit's radius; a milling path is the tool CENTRE,
     * so its cut reaches one tool radius past it.
     */
    previewCutArea(prim) {
      const props = prim.properties || {};
      if ('peck_mark' === props.role) return [new CirclePrimitive(prim.center, prim.radius, { polarity: 'dark' })];
      const r = (props.toolDiameter || 0) / 2;
      // Pass 1 is the outermost ring; the passes inside it cut nothing more.
      if ('drill_milling_path' !== props.role || props.pass > 1 || !(r > 0)) return [];
      if ('circle' === prim.type) return [new CirclePrimitive(prim.center, prim.radius + r, { polarity: 'dark' })];
      if ('obround' === prim.type) {
        return [
          new ObroundPrimitive(
            { x: prim.position.x - r, y: prim.position.y - r },
            prim.width + 2 * r,
            prim.height + 2 * r,
            { polarity: 'dark' },
          ),
        ];
      }
      // Centreline slot: the tool swept along the slot's axis.
      return props.isCenterlinePath ? GeometryUtils.traceToPolygon(prim.contours[0], 2 * r, { polarity: 'dark' }) : [];
    }

    classifySVGDrillPrimitives(operation) {
      const accepted = [];
      const warnings = [];
      const rejected = [];
      for (const prim of operation.primitives) {
        if (!prim.properties) prim.properties = {};
        if (prim.type === 'circle') {
          prim.properties.role = 'drill_hole';
          prim.properties.diameter = prim.radius * 2;
          prim.center = prim.center || prim.getCenter();
          accepted.push(prim);
        } else if (prim.type === 'obround') {
          const w = prim.width;
          const h = prim.height;
          const isCircular = Math.abs(w - h) < PRECISION;
          if (isCircular) {
            const diameter = Math.min(w, h);
            const cx = prim.position.x + w / 2;
            const cy = prim.position.y + h / 2;
            prim.properties.role = 'drill_hole';
            prim.properties.diameter = diameter;
            prim.center = { x: cx, y: cy };
            prim.radius = diameter / 2;
            accepted.push(prim);
          } else {
            const isHorizontal = w > h;
            const r = Math.min(w, h) / 2;
            const diameter = Math.min(w, h);
            let start, end;
            if (isHorizontal) {
              const cy = prim.position.y + h / 2;
              start = { x: prim.position.x + r, y: cy };
              end = { x: prim.position.x + w - r, y: cy };
            } else {
              const cx = prim.position.x + w / 2;
              start = { x: cx, y: prim.position.y + r };
              end = { x: cx, y: prim.position.y + h - r };
            }
            prim.properties.role = 'drill_slot';
            prim.properties.diameter = diameter;
            prim.properties.originalSlot = { start, end };
            accepted.push(prim);
          }
        } else if (prim.type === 'rectangle') {
          const w = prim.width;
          const h = prim.height;
          const isSquare = Math.abs(w - h) < PRECISION;
          if (isSquare) {
            const diameter = w;
            const cx = prim.position.x + w / 2;
            const cy = prim.position.y + h / 2;
            prim.properties.role = 'drill_hole';
            prim.properties.diameter = diameter;
            prim.center = { x: cx, y: cy };
            prim.radius = diameter / 2;
            warnings.push({
              message: {
                key: 'messages.drill.squareAsHole',
                values: {size: w.toFixed(3)}
              },
              severity: 'info'
            });
            accepted.push(prim);
          } else {
            rejected.push({ type: 'rectangle', id: prim.id, width: w, height: h });
            warnings.push({
              message: {
                key: 'messages.drill.rectangleRejected',
                values: {width: w.toFixed(3), height: h.toFixed(3)}
              },
              severity: 'warning'
            });
          }
        } else {
          rejected.push({ type: prim.type, id: prim.id });
          warnings.push({
            message: {
              key: 'messages.drill.shapeRejected',
              values: {type: {key: `panels.scene.types.${prim.type}`}}
            },
            severity: 'warning'
          });
        }
      }

      // Recovery detection: scan rejected PathPrimitives for circle/obround patterns
      const recoverableCircles = [];
      const recoverableObrounds = [];
      for (const entry of rejected) {
        const prim = operation.primitives.find(p => p.id === entry.id);
        if (!prim || prim.type !== 'path') continue;
        const ring = prim.contours?.length === 1 ? GeometryUtils.analyzeCircleRing(prim.contours[0].points) : null;
        const circleMatch = ring?.isFullCircle
          ? { center: ring.center, radius: ring.radius, diameter: ring.radius * 2 }
          : this.detectCircleFromPath(prim);
        if (circleMatch) {
          recoverableCircles.push({ primitiveId: prim.id, detected: circleMatch });
          continue;
        }
        const obroundMatch = this.detectObroundFromPath(prim);
        if (obroundMatch) recoverableObrounds.push({ primitiveId: prim.id, detected: obroundMatch });
      }

      const hasRecoverable = recoverableCircles.length > 0 || recoverableObrounds.length > 0;
      if (hasRecoverable) {
        operation.drillRecoverable = {
          circles: recoverableCircles.length > 0 ? recoverableCircles : null,
          obrounds: recoverableObrounds.length > 0 ? recoverableObrounds : null
        };
        this.debug(`Found ${recoverableCircles.length} circle + ${recoverableObrounds.length} obround candidates for recovery`);
      }

      operation.primitives = accepted;
      operation.bounds = this.core.ingest.recalculateBounds(accepted)
      operation.drillSummary = {
        ...DrillHandler.summarizePrimitives(accepted, 'svg'),
        totalAccepted: accepted.length,
        totalRejected: rejected.length,
        rejected
      };

      if (!operation.warnings) operation.warnings = [];
      operation.warnings.push(...warnings);
      this.debug(`Classified ${accepted.length} accepted, ${rejected.length} rejected from ${accepted.length + rejected.length} primitives`);
    }

    /**
     * DEPRECATED - matches the SVG two-semicircle idiom only (exactly two
     * arcSegments summing to 2*PI). Superseded by GeometryUtils.analyzeCircleRing,
     * which decides on registry provenance and works on every circle shape the
     * pipeline produces.
     *
     * Kept for the drill-recovery prompt while EasyTrace SVG imports are still
     * being surveyed. REMOVE once promoteDrillRecoverable has run a full board
     * set with no circle candidates that analyzeCircleRing missed.
     */
    detectCircleFromPath(primitive) {
      if (primitive.type !== 'path' || !primitive.contours || primitive.contours.length !== 1) return null;
      const contour = primitive.contours[0];
      if (!contour.arcSegments || contour.arcSegments.length !== 2) return null;
      const arc1 = contour.arcSegments[0];
      const arc2 = contour.arcSegments[1];
      if (!arc1.center || !arc2.center || !arc1.radius || !arc2.radius) return null;
      const dx = arc1.center.x - arc2.center.x;
      const dy = arc1.center.y - arc2.center.y;
      if ((dx * dx + dy * dy) > PRECISION * PRECISION) return null;
      if (Math.abs(arc1.radius - arc2.radius) > PRECISION) return null;
      const sweep1 = arc1.sweepAngle !== undefined ? Math.abs(arc1.sweepAngle) : Math.abs(arc1.endAngle - arc1.startAngle);
      const sweep2 = arc2.sweepAngle !== undefined ? Math.abs(arc2.sweepAngle) : Math.abs(arc2.endAngle - arc2.startAngle);
      const totalSweep = sweep1 + sweep2;
      if (Math.abs(totalSweep - 2 * Math.PI) > 0.1) return null;
      const radius = (arc1.radius + arc2.radius) / 2;
      const center = {
        x: (arc1.center.x + arc2.center.x) / 2,
        y: (arc1.center.y + arc2.center.y) / 2
      };
      return { center, radius, diameter: radius * 2 };
    }

    detectObroundFromPath(primitive) {
      if (primitive.type !== 'path' || !primitive.contours || primitive.contours.length !== 1) return null;

      const contour = primitive.contours[0];
      if (!contour.arcSegments || contour.arcSegments.length !== 2) return null;
      if (!contour.points || contour.points.length < 4) return null;

      const arc1 = contour.arcSegments[0];
      const arc2 = contour.arcSegments[1];

      if (!arc1.center || !arc2.center || !arc1.radius || !arc2.radius) return null;
      if (Math.abs(arc1.radius - arc2.radius) > PRECISION) return null;

      const sweep1 = arc1.sweepAngle !== undefined ? Math.abs(arc1.sweepAngle) : Math.abs(arc1.endAngle - arc1.startAngle);
      const sweep2 = arc2.sweepAngle !== undefined ? Math.abs(arc2.sweepAngle) : Math.abs(arc2.endAngle - arc2.startAngle);

      if (Math.abs(sweep1 - Math.PI) > 0.15 || Math.abs(sweep2 - Math.PI) > 0.15) return null;

      const dx = arc1.center.x - arc2.center.x;
      const dy = arc1.center.y - arc2.center.y;
      if ((dx * dx + dy * dy) < PRECISION * PRECISION) return null;

      const r = (arc1.radius + arc2.radius) / 2;
      const start = arc1.center;
      const end = arc2.center;

      const minX = Math.min(start.x, end.x) - r;
      const minY = Math.min(start.y, end.y) - r;
      const maxX = Math.max(start.x, end.x) + r;
      const maxY = Math.max(start.y, end.y) + r;

      return {
        position: { x: minX, y: minY },
        width: maxX - minX,
        height: maxY - minY,
        diameter: r * 2,
        originalSlot: { start: { ...start }, end: { ...end } }
      };
    }

    /**
     * Turns the shapes the operator accepted in the drill-recovery prompt
     * into drill primitives.
     */
    promoteDrillRecoverable(operation, acceptCircles, acceptObrounds) {
      if (!operation.drillRecoverable) return;
      let promoted = 0;
      if (acceptCircles && operation.drillRecoverable.circles) {
        for (const candidate of operation.drillRecoverable.circles) {
          const diameter = candidate.detected.diameter;
          const prim = new CirclePrimitive(candidate.detected.center, diameter / 2, {
            role: 'drill_hole',
            diameter: diameter,
            polarity: 'dark',
            operationType: operation.type,
            operationId: operation.id,
            recoveredFromPath: true
          });
          operation.primitives.push(prim);
          promoted++;
        }
      }
      if (acceptObrounds && operation.drillRecoverable.obrounds) {
        for (const candidate of operation.drillRecoverable.obrounds) {
          const det = candidate.detected;
          const prim = new ObroundPrimitive(det.position, det.width, det.height, {
            role: 'drill_slot',
            diameter: det.diameter,
            originalSlot: det.originalSlot,
            polarity: 'dark',
            operationType: operation.type,
            operationId: operation.id,
            recoveredFromPath: true
          });
          operation.primitives.push(prim);
          promoted++;
        }
      }
      operation.bounds = this.core.ingest.recalculateBounds(operation.primitives);
      delete operation.drillRecoverable;
      operation.drillSummary = {
        ...DrillHandler.summarizePrimitives(operation.primitives, 'svg'),
        totalAccepted: operation.primitives.length,
        totalRejected: 0,
        rejected: [],
        promoted
      };
      this.debug(`Promoted ${promoted} recoverable shape(s)`);
    }

    // ORCHESTRATION
    async generateLaserFills(operation, settings) {
      this.debug(`=== LASER DRILL GENERATION ===`);
      // Kerf follows the cut side, as on laser cutout: inside keeps the hole
      // to size, outside grows it by the spot, on burns the drawn outline.
      const side = settings.cutSide;
      const half = settings.toolDiameter / 2;
      const offsetDist = side === 'on' ? 0 : side === 'outside' ? half : -half;
      const offsetType = side === 'on' ? 'on' : side === 'outside' ? 'external' : 'internal';
      const processedGeometry = [];
      for (const prim of operation.primitives) {
        // Only actual drill holes and slots.
        const role = prim.properties?.role;
        if (role !== 'drill_hole' && role !== 'drill_slot') continue;
        let result = await this.core.geometryOffsetter.offsetBoundary(prim, offsetDist);
        if (!result) continue;
        // A zero distance hands the source back: tag a clone, never the source.
        if (result === prim) {
          result = { ...prim };
          Object.setPrototypeOf(result, Object.getPrototypeOf(prim));
        }
        if (Array.isArray(result)) processedGeometry.push(...result);
        else processedGeometry.push(result);
      }
      for (const p of processedGeometry) {
        p.properties = { ...p.properties, isOffset: true, offsetType, offsetDistance: offsetDist };
      }
      operation.offsets = [{
        id: this.offsetRecordId(operation.id, 0),
        distance: offsetDist,
        pass: 1,
        type: 'drill',
        offsetType,
        primitives: processedGeometry,
        metadata: {
          strategy: 'offset',
          toolDiameter: settings.toolDiameter,
          generatedAt: Date.now()
        }
      }];
      return operation.offsets;
    }

    async orchestrateGeneration(operation, params, core, options = {}) {
      const token = this.beginRun(operation, options, core);

      // Compile parameters
      const opParams = core.pipelineContext.compileOperationParams(operation, params);

      if (opParams.isLaser) {
        await this.generateLaserFills(operation, opParams);
        const count = operation.offsets?.[0]?.primitives?.length || 0;
        return { success: count > 0, message: { key: 'messages.drill.laserMarks', values: { count } }, status: 'success' };
      }

      await this.generateGeometry(operation, { ...params, ...opParams });

      if (this.isStale(operation, token)) {
        return { success: false, message: { key: 'messages.operations.superseded' }, status: 'warning' };
      }

      const drill = operation.offsets?.[0]?.metadata?.drill;
      const count = operation.offsets?.[0]?.primitives?.length || 0;
      const parts = [];
      if (drill?.peckCount) parts.push({ key: 'messages.drill.peckPositions', values: { count: drill.peckCount } });
      if (drill?.millCount) parts.push({ key: 'messages.drill.millPaths', values: { count: drill.millCount } });
      const detail = parts.length > 0 ? parts : [{ key: 'messages.drill.features', values: { count } }];
      const message = { key: 'messages.drill.generated', values: { detail, count: drill?.groups || 0 } };
      // The panel renders every warning; only a real one downgrades the
      // run. Parse-time rejections survive a regenerate by design.
      const blocking = (operation.warnings || []).filter(w => w?.severity === 'warning').length;
      return {
        success: count > 0,
        message: blocking > 0 ? { key: 'messages.drill.withWarnings', values: { message, count: blocking } } : message,
        status: blocking > 0 ? 'warning' : 'success',
        refreshPanel: blocking > 0
      };
    }

    // Keyed on the primitives array identity: regeneration replaces the
    // array, so a stale entry cannot survive a regenerate. Three call
    // sites hit this per checkbox event.
    static _splitCache = new WeakMap();

    /**
     * Files a split export writes for one operation: one per TOOL, in
     * ascending cutter size. The bit is what generation stamped on each
     * primitive - drillTool.id when a library cutter is assigned, else the
     * cutter diameter - so hole sizes cut by the same bit share a file:
     * every size in single-tool mode, the undersized holes an end mill
     * plunges, and table rows that name the same cutter. A job with one bit
     * yields one file and has nothing to split.
     * The export loop and the modal's gate both call this, so "would this
     * split" and "what did it split into" cannot disagree.
     */
    static splitDrillFiles(operation) {
      const primitives = operation?.preview?.primitives;
      if (!primitives) return [];
      const hit = DrillHandler._splitCache.get(primitives);
      if (hit) return hit;
      const bits = new Map();
      for (const prim of primitives) {
        const props = prim.properties || {};
        const diameter = props.toolDiameter ?? props.drillTool?.diameter ?? 0;
        const id = props.drillTool?.id || DrillHandler.diameterKey(diameter);
        if (!bits.has(id)) bits.set(id, { diameter, milled: false, primitives: [] });
        const bit = bits.get(id);
        // One milling path makes the bit an end mill; plunges alone leave it a drill.
        if (props.role !== 'peck_mark') bit.milled = true;
        bit.primitives.push(prim);
      }
      // Keys become file name parts, so they read as the bit - with a
      // counter only when two library cutters share a kind and a size.
      const taken = new Set();
      const files = [...bits.values()]
        .sort((a, b) => a.diameter - b.diameter)
        .map((bit) => {
          const base = `${bit.milled ? 'mill' : 'drill'}_${DrillHandler.diameterKey(bit.diameter)}mm`;
          let key = base;
          for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
          taken.add(key);
          return { key, primitives: bit.primitives };
        });
      DrillHandler._splitCache.set(primitives, files);
      return files;
    }

    /** Drill Strategy & Geometry Generation */
    async generateGeometry(operation, settings) {
      settings = { ...settings };
      this.debug('=== DRILL STRATEGY GENERATION ===');

      const table = this.ensureDrillTable(operation);
      this.debug(`Drill table (${table.preset}): ${Object.keys(table.rows).length} diameter group(s)`);

      const { plan, warnings } = this.determineDrillStrategy(operation, settings);

      // Replace only this pass's warnings - parse-time rejections and
      // recovery notes must survive a regenerate.
      const kept = (operation.warnings || []).filter(w => w?.source !== 'drill-strategy');
      operation.warnings = [...kept, ...warnings];

      const strategyGeometry = await this.generateGeometryFromPlan(plan, operation);
      const peckCount = strategyGeometry.filter(p => p.properties?.role === 'peck_mark').length;
      const millCount = strategyGeometry.filter(p => p.properties?.role === 'drill_milling_path').length;

      // Layer/preview width and the generateCNCPreview gate read this.
      // In per-size mode the sidebar tool is hidden and its value is
      // whatever it was last set to, so the widest bit the table
      // actually calls is the honest figure. settings.toolDiameter is
      // deliberately NOT touched: it is still the fallback a row that
      // inherits resolves against.
      let recordDiameter = settings.toolDiameter || settings.tool?.diameter;
      if (DrillHandler.isMultiTool(settings)) {
        const assigned = Object.values(table.rows)
          .filter(row => 'skip' !== row.strategy && row.toolDiameter > 0)
          .map(row => row.toolDiameter);
        if (assigned.length > 0) recordDiameter = Math.max(...assigned);
      }

      operation.offsets = [{
        id: this.offsetRecordId(operation.id, 0),
        distance: 0,
        pass: 1,
        primitives: strategyGeometry,
        type: 'drill',
        metadata: {
          sourceCount: operation.primitives.length,
          generatedAt: Date.now(),
          toolDiameter: recordDiameter,
          drill: {
            preset: table.preset,
            groups: Object.keys(table.rows).length,
            peckCount,
            millCount
          }
        },
        settings: { ...settings }
      }];

      return operation.offsets;
    }

    /**
     * Resolves every feature against its row in the drill table rather than
     * one global cutter. A zero-length slot resolves as a hole.
     */
    determineDrillStrategy(operation, settings) {
      const plan = [];
      const warnings = [];
      const rows = operation.drillTable?.rows || {};
      const minMillingMargin = D.toolpath.generation.drilling.millMargin;
      // Counted per diameter - one warning per row, not one per hole.
      const skipped = new Map();
      const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

      for (const primitive of operation.primitives) {
        const role = primitive.properties?.role;
        if (role === 'drill_hole') {
          if (primitive.type !== 'circle' || !primitive.center || !primitive.radius) {
            console.warn(`[DrillHandler] Invalid drill hole primitive ${primitive.id}`);
            continue;
          }
        } else {
          if (role !== 'drill_slot') continue;
          const slot = primitive.properties?.originalSlot;
          if (!slot || !slot.start || !slot.end) {
            console.warn(`[DrillHandler] Drill slot ${primitive.id} missing or invalid originalSlot data`);
            continue;
          }
        }

        const featureSize = primitive.properties.diameter;
        const isSlot = DrillHandler.isSlot(primitive);
        // A zero-length slot is a hole the plotter wrote as a route.
        if (role === 'drill_slot' && !isSlot) {
          primitive.center = primitive.properties.originalSlot.start;
          if (!primitive.radius) primitive.radius = featureSize / 2;
        }
        const key = DrillHandler.rowKey(featureSize, isSlot);
        const entry = this.resolveDrillRow(rows[key], settings, key);
        if (entry.strategy === 'skip' || !(entry.toolDiameter > 0)) {
          bump(skipped, key);
          continue;
        }
        const toolDiameter = entry.toolDiameter;

        // toolRelation IS the report: resolveToolRelationColor paints
        // oversized red, exact green, undersized yellow in both the
        // geometry and preview stages, and the toolpath node shows the
        // resulting plunges in 3D. Nothing here restates that in text.
        const diff = featureSize - toolDiameter;
        let toolRelation = 'exact';
        if (diff < -PRECISION) toolRelation = 'oversized';
        else if (diff > PRECISION) toolRelation = 'undersized';

        const wantsMill = entry.strategy === 'mill';
        // Same tolerance as toolRelation: SVG unit conversion leaves sizes nanometres off.
        const canMill = toolRelation === 'undersized' && diff >= minMillingMargin - PRECISION;

        if (isSlot) {
          const slot = primitive.properties.originalSlot;
          if (wantsMill) {
            plan.push(canMill
              ? { type: 'mill', primitiveToOffset: primitive, toolRelation: 'undersized', entry }
              : { type: 'centerline', primitiveToOffset: primitive, isCenterline: true, toolRelation, entry });
            continue;
          }
          const proximityRisk = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y) < toolDiameter;
          plan.push(
            { type: 'peck', position: slot.start, originalDiameter: featureSize, toolRelation, entry },
            { type: 'peck', position: slot.end, originalDiameter: featureSize, toolRelation, entry, reducedPlunge: proximityRisk }
          );
          continue;
        }

        if (wantsMill && canMill) plan.push({ type: 'mill', primitiveToOffset: primitive, toolRelation, entry });
        else plan.push({ type: 'peck', position: primitive.center, originalDiameter: featureSize, toolRelation, entry });
      }

      // The one drill condition with nothing on screen to see: a skipped size
      // emits no primitive at all, so no colour can report it.
      for (const [key, count] of skipped) {
        warnings.push({
          message: {
            key: 'messages.drill.noToolSkipped',
            values: {feature: DrillHandler.rowLabel(key), count}
          },
          severity: 'warning',
          source: 'drill-strategy'
        });
      }
      return { plan, warnings };
    }

    async generateGeometryFromPlan(plan, operation) {
      const strategyPrimitives = [];
      const onProgress = operation._onProgress || null;
      const total = plan.length;
      const minFeatureSize = 0.01;

      for (let actionIdx = 0; actionIdx < total; actionIdx++) {
        // The loop is synchronous: a tick reaches the rAF-coalesced
        // overlay only across a yield.
        if (this.yieldDue) {
          onProgress?.({
            frac: actionIdx / total,
            label: {
              key: 'progress.drillHoles',
              values: { done: actionIdx, count: total }
            }
          });
          await this.yieldToEventLoop();
        }

        const action = plan[actionIdx];
        const entry = action.entry;
        const toolDiameter = entry.toolDiameter;
        const toolRadius = toolDiameter / 2;

        if (action.type === 'peck') {
          strategyPrimitives.push(new CirclePrimitive(action.position, toolRadius, this.stampDrillProps(action, {
            role: 'peck_mark',
            holeIndex: actionIdx,
            originalDiameter: action.originalDiameter,
            toolRelation: action.toolRelation,
            reducedPlunge: action.reducedPlunge,
            operationId: operation.id
          })));
          continue;
        }

        if (action.type === 'mill') {
          const source = action.primitiveToOffset;
          const stepDist = toolDiameter * (entry.stepOver / 100);

          if (source.type === 'circle') {
            const holeRadius = source.radius;
            const pathRadius = holeRadius - toolRadius;

            if (pathRadius > minFeatureSize) {
              const concentricPasses = [];
              let currentRadius = pathRadius;
              let p = 1;
              while (currentRadius >= minFeatureSize) {
                concentricPasses.push(new CirclePrimitive(source.center, currentRadius, this.stampDrillProps(action, {
                  role: 'drill_milling_path',
                  holeIndex: actionIdx,
                  operationId: operation.id,
                  originalDiameter: 2 * holeRadius,
                  toolRelation: action.toolRelation || 'undersized',
                  isOffset: true,
                  offsetType: 'internal',
                  pass: p++
                })));
                if (currentRadius <= toolRadius) break;
                currentRadius -= stepDist;
                if (currentRadius < minFeatureSize && currentRadius > 0) currentRadius = minFeatureSize;
              }
              strategyPrimitives.push(...concentricPasses.reverse());
            } else {
              strategyPrimitives.push(new CirclePrimitive(source.center, toolRadius, this.stampDrillProps(action, {
                role: 'peck_mark',
                holeIndex: actionIdx,
                originalDiameter: 2 * source.radius,
                toolRelation: 'undersized_too_small',
                operationId: operation.id
              })));
            }
            continue;
          }

          if (source.properties?.originalSlot) {
            const originalSlot = source.properties.originalSlot;
            const slotWidth = source.properties.diameter || source.properties.width;
            const dx = originalSlot.end.x - originalSlot.start.x;
            const dy = originalSlot.end.y - originalSlot.start.y;
            const slotLength = Math.hypot(dx, dy);
            const pathThickness = slotWidth - toolDiameter;

            if (pathThickness > minFeatureSize) {
              const pathLength = slotLength + pathThickness;
              const centerX = (originalSlot.start.x + originalSlot.end.x) / 2;
              const centerY = (originalSlot.start.y + originalSlot.end.y) / 2;
              const isHorizontal = Math.abs(dx) > Math.abs(dy);
              const concentricPasses = [];
              let currentShort = pathThickness;
              let currentLong = pathLength;
              let p = 1;

              while (currentShort >= minFeatureSize && currentLong >= currentShort) {
                let obroundWidth, obroundHeight, cornerX, cornerY;
                if (isHorizontal) {
                  obroundWidth = currentLong;
                  obroundHeight = currentShort;
                  cornerX = centerX - currentLong / 2;
                  cornerY = centerY - currentShort / 2;
                } else {
                  obroundWidth = currentShort;
                  obroundHeight = currentLong;
                  cornerX = centerX - currentShort / 2;
                  cornerY = centerY - currentLong / 2;
                }
                concentricPasses.push(new ObroundPrimitive({ x: cornerX, y: cornerY }, obroundWidth, obroundHeight, this.stampDrillProps(action, {
                  role: 'drill_milling_path',
                  holeIndex: actionIdx,
                  originalDiameter: slotWidth,
                  originalSlot,
                  toolRelation: 'undersized',
                  operationId: operation.id,
                  isOffset: true,
                  offsetType: 'internal',
                  pass: p++
                })));
                if (currentShort <= toolDiameter) break;
                currentShort -= 2 * stepDist;
                currentLong -= 2 * stepDist;
                if (currentShort < minFeatureSize && currentShort > 0) {
                  currentShort = minFeatureSize;
                  currentLong = Math.max(currentLong, currentShort);
                }
              }
              strategyPrimitives.push(...concentricPasses.reverse());
            } else {
              console.warn(`[DrillHandler] Slot path too thin (${pathThickness.toFixed(3)}mm), skipping milling`);
            }
          }
          continue;
        }

        if (action.type === 'centerline') {
          const source = action.primitiveToOffset;
          const originalSlot = source.properties?.originalSlot;
          if (!originalSlot) continue;
          strategyPrimitives.push(new PathPrimitive([{
            points: [originalSlot.start, originalSlot.end],
            isHole: false,
            nestingLevel: 0,
            parentId: null,
            arcSegments: [],
            curveIds: []
          }], this.stampDrillProps(action, {
            role: 'drill_milling_path',
            holeIndex: actionIdx,
            isCenterlinePath: true,
            isDrillMilling: true,
            toolRelation: action.toolRelation,
            originalDiameter: source.properties.diameter,
            operationId: operation.id,
            originalSlot,
            closed: false
          })));
        }
      }

      return strategyPrimitives;
    }
  }

  ROOT.DrillHandler = DrillHandler;
})();