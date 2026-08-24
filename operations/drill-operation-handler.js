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

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const EPSILON = C.precision.epsilon;
    const PRECISION = C.precision.coordinate;

    // Row fields baked into primitive geometry at generation. Editing one
    // stales the operation; everything else resolves at translation.
    const GEOMETRY_FIELDS = new Set(['strategy', 'toolId', 'toolDiameter', 'mill']);

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
         * The one place a diameter becomes a map key. The export table, the
         * split-drill path and the tool descriptor all match on this string;
         * change the rounding here and they stop agreeing silently.
         */
        static diameterKey(diameter) {
            return Number(diameter).toFixed(3);
        }

        /**
         * Feature taxonomy for one drill operation, keyed by feature size.
         * A slot's width takes the same bit as a hole of that diameter, so
         * both share a row. Excellon header tool ids ride along as advisory
         * text only: a header T index is a file index, not a magazine slot.
         */
        static summarizePrimitives(primitives, source) {
            const quantize = value => Math.round(value / PRECISION) * PRECISION;
            const sizes = new Map();
            const slotSizes = new Map();
            let totalHoles = 0;
            let totalSlots = 0;

            for (const prim of primitives || []) {
                const props = prim.properties;
                const role = props?.role;
                const diameter = props?.diameter;
                if (!diameter || (role !== 'drill_hole' && role !== 'drill_slot')) continue;

                const key = DrillHandler.diameterKey(diameter);
                let size = sizes.get(key);
                if (!size) {
                    size = { key, diameter: parseFloat(key), holes: 0, slots: 0, nativeTools: [] };
                    sizes.set(key, size);
                }
                if (props.tool && !size.nativeTools.includes(props.tool)) size.nativeTools.push(props.tool);

                if (role === 'drill_hole') {
                    size.holes++;
                    totalHoles++;
                    continue;
                }

                size.slots++;
                totalSlots++;
                const slot = props.originalSlot;
                if (!slot) continue;
                const len = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y);
                const slotKey = `${key}x${quantize(len + diameter).toFixed(3)}`;
                slotSizes.set(slotKey, (slotSizes.get(slotKey) || 0) + 1);
            }

            const ordered = [...sizes.values()].sort((a, b) => a.diameter - b.diameter);
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
         * null in a row means INHERIT the operation - that is what keeps the
         * single-tool desktop path one click, and it is also why nothing here
         * writes toolNumber: a slot number is not derivable from a diameter,
         * and enumerating T1/T2/T3 across rows is exactly the invention the
         * tool contract forbids. Rows stay on the operation's number until the
         * operator assigns one, which checkToolAssignment then reports as the
         * collision it is.
         */
        buildDrillTable(operation, settings, preset = 'flatten') {
            const table = { preset, rows: {}, generatedAt: Date.now() };
            const sizes = operation.drillSummary?.sizes;
            if (!sizes?.length) return table;

            const library = this.core?.toolLibrary || null;
            const useLibrary = preset === 'match' && library;
            const millOversize = settings?.millHoles !== false;

            for (const size of sizes) {
                const row = {
                    key: size.key,
                    diameter: size.diameter,
                    holes: size.holes,
                    slots: size.slots,
                    nativeTools: size.nativeTools || [],
                    strategy: millOversize ? 'mill' : 'peck',
                    toolId: null,
                    toolDiameter: null,
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
         * Auto-match for one row: an exact drill bit pecks, otherwise the
         * largest end mill that still leaves a millable ring bores it, otherwise
         * the row is skipped and says so. Assigns tools and cutting data only.
         */
        matchLibraryTool(row, library) {
            const tolerance = D.toolpath.generation.drilling.matchTolerance;
            const margin = D.toolpath.generation.drilling.millMargin;

            const drill = (library.getToolsByType('drill') || [])
                .filter(t => Math.abs((t.geometry?.diameter ?? 0) - row.diameter) <= tolerance)
                .sort((a, b) => Math.abs(a.geometry.diameter - row.diameter) - Math.abs(b.geometry.diameter - row.diameter))[0];
            if (drill) {
                row.strategy = 'peck';
                this.applyLibraryTool(row, drill);
                return;
            }

            const mill = (library.getToolsByType('end_mill') || [])
                .filter(t => (t.geometry?.diameter ?? 0) > 0 && t.geometry.diameter <= row.diameter - margin)
                .sort((a, b) => b.geometry.diameter - a.geometry.diameter)[0];
            if (mill) {
                row.strategy = 'mill';
                this.applyLibraryTool(row, mill);
                return;
            }

            row.strategy = 'skip';
        }

        /**
         * Assigns the cutter and the feeds the modal actually shows. Fields
         * with no column stay null on purpose: Auto-match used to write
         * mill.stepOver, mill.depthPerPass and peck.dwellTime, all three of
         * which are read downstream (buildDrillDepthLevels builds a per-key
         * depth ladder from depthPerPass; processPeckMark takes dwellTime as
         * the G82 dwell word) and none of which the operator can see or clear.
         * Surface them before writing them again.
         * TODO(drill-tool-numbers) - ToolLibrary.importTools already accepts and
         * dedups tool.toolNumber, so a custom library could seed row.toolNumber
         * here. The shipped tools.json declares none, and inventing one is what
         * the tool contract forbids.
         */
        applyLibraryTool(row, tool) {
            const cut = tool.cutting || {};
            row.toolId = tool.id;
            row.toolDiameter = tool.geometry?.diameter ?? null;
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
         * still seed from millHoles through buildDrillTable.
         */
        reconcileDrillTable(operation, settings) {
            const preset = operation.drillTable?.preset || 'flatten';
            const previous = operation.drillTable?.rows;
            const table = this.buildDrillTable(operation, settings, preset);

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
         * Builds the table on demand from the summary that already exists after
         * parsing, so the modal has rows the moment multi-tool is switched on
         * rather than only after a generation. Re-classifies first when the
         * primitives carry no roles: EasyShape's syncPrimitives copies them raw,
         * and summarizePrimitives would otherwise report zero sizes.
         */
        ensureDrillTable(operation, settings) {
            if (!operation) return null;
            const hasRoles = operation.primitives?.some(p => p.properties?.role);
            if (operation.primitives?.length > 0 && !hasRoles) this.classifySVGDrillPrimitives(operation);
            else this.refreshDrillSummary(operation);
            return this.reconcileDrillTable(operation, settings || {});
        }

        /**
         * Rebuilds every row from a preset, discarding manual assignments.
         */
        applyDrillPreset(operation, settings, preset) {
            operation.drillTable = this.buildDrillTable(operation, settings, preset);
            return operation.drillTable;
        }

        /**
         * One read of the drill table for every consumer that needs to know what
         * it says: the sidebar card, the action-button gate and the export
         * checks. Mode comes from the parameter, never from the preset.
         * Single-tool mode has nothing to gate on - the operation's own tool and
         * number cut everything and the rows are dormant.
         * A row with no CUTTER blocks: generation cannot compute a path without
         * a diameter. A row with no T NUMBER does not - it inherits the
         * operation's number exactly as resolveToolDescriptor's drillMap does
         * (`assigned ?? descriptor.number`), so refusing here would block
         * geometry the pipeline can already emit. It reports as a note, and the
         * inherited number joins `numbers` so the card's tool list stays honest.
         * An empty table never blocks. EasyShape has no operation until its
         * first generation, so blocking there would block the run that builds
         * the rows in the first place.
         */
        static describeTable(operation, settings) {
            const multiTool = DrillHandler.isMultiTool(settings);
            const rows = operation?.drillTable?.rows ? Object.values(operation.drillTable.rows) : [];
            const sizes = operation?.drillSummary?.sizes || [];
            const counts = { peck: 0, mill: 0, skip: 0 };
            const numbers = new Set();
            const unassigned = [];
            const unnumbered = [];

            if (multiTool) {
                for (const row of rows) {
                    counts[row.strategy] = (counts[row.strategy] || 0) + 1;
                    if (row.strategy === 'skip') continue;
                    const hasTool = (row.toolDiameter !== null && row.toolDiameter > 0) || Boolean(row.toolId);
                    if (!hasTool) unassigned.push(row.key);
                    if (row.toolNumber > 0) numbers.add(row.toolNumber);
                    else unnumbered.push(row.key);
                }
            } else {
                counts[settings?.millHoles !== false ? 'mill' : 'peck'] = sizes.length || rows.length;
            }

            const list = keys => keys.map(k => `⌀${k}`).join(', ');
            const opNumber = Number(settings?.toolNumber) > 0 ? Number(settings.toolNumber) : null;
            if (unnumbered.length > 0 && opNumber) numbers.add(opNumber);

            let reason = null;
            let note = null;
            if (multiTool && rows.length > 0) {
                if (counts.peck + counts.mill === 0) reason = 'Every size is set to Skip - nothing would be cut.';
                else if (unassigned.length > 0) reason = `No tool assigned for ${list(unassigned)}.`;

                if (unnumbered.length > 0) {
                    note = opNumber
                        ? `${list(unnumbered)} inherit the operation's T${opNumber} - assign a number to give them their own.`
                        : `${list(unnumbered)} have no T number - no tool change is emitted for them.`;
                }
            }

            return {
                mode: multiTool ? 'perSize' : 'single',
                preset: operation?.drillTable?.preset || null,
                rows,
                sizeCount: sizes.length || rows.length,
                counts,
                numbers: [...numbers].sort((a, b) => a - b),
                unassigned,
                unnumbered,
                reason,
                note,
                complete: reason === null
            };
        }

        /**
         * Collapses one row plus the operation defaults into the identity a
         * primitive carries downstream. In single-tool mode the row is NOT read:
         * the operation answers everything, so per-size assignments survive a
         * round trip through the checkbox untouched instead of being rebuilt.
         * 
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
                    tool: {
                        number: null,
                        id: settings.tool ?? null,
                        name: settings.tool ?? null,
                        diameter: operationDiameter,
                        type: 'mill' === strategy ? 'end_mill' : 'drill'
                    },
                    cutting: null,
                    peck: null,
                    mill: null
                };
            }

            const toolDiameter = row?.toolDiameter > 0 ? row.toolDiameter : operationDiameter;
            return {
                key: row?.key || key,
                strategy: row?.strategy || 'peck',
                toolDiameter,
                stepOver: row?.mill?.stepOver ?? settings.stepOver,
                tool: {
                    number: row?.toolNumber ?? null,
                    id: row?.toolId ?? null,
                    name: row?.toolId ?? null,
                    diameter: toolDiameter,
                    type: 'mill' === row?.strategy ? 'end_mill' : 'drill'
                },
                cutting: row?.cutting || null,
                peck: row?.peck || null,
                mill: row?.mill || null
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

        classifySVGDrillPrimitives(operation) {
            const quantize = (value) => Math.round(value / PRECISION) * PRECISION;

            const accepted = [];
            const warnings = [];
            const rejected = [];
            const holeSizes = new Map();
            const slotSizes = new Map();

            for (const prim of operation.primitives) {
                if (!prim.properties) prim.properties = {};

                if (prim.type === 'circle') {
                    const rawDiameter = prim.radius * 2;
                    const diameter = quantize(rawDiameter);

                    prim.properties.role = 'drill_hole';
                    prim.properties.diameter = diameter;
                    prim.center = prim.center || prim.getCenter();

                    if (Math.abs(rawDiameter - diameter) > PRECISION * 0.1) {
                        this.debug(`Quantized circle diameter: ${rawDiameter.toFixed(6)} → ${diameter.toFixed(3)}mm`);
                    }

                    const key = diameter.toFixed(3);
                    holeSizes.set(key, (holeSizes.get(key) || 0) + 1);
                    accepted.push(prim);

                } else if (prim.type === 'obround') {
                    const w = prim.width;
                    const h = prim.height;
                    const isCircular = Math.abs(w - h) < PRECISION;

                    if (isCircular) {
                        const diameter = quantize(Math.min(w, h));
                        const cx = prim.position.x + w / 2;
                        const cy = prim.position.y + h / 2;

                        prim.properties.role = 'drill_hole';
                        prim.properties.diameter = diameter;
                        prim.center = { x: cx, y: cy };
                        prim.radius = diameter / 2;

                        const key = diameter.toFixed(3);
                        holeSizes.set(key, (holeSizes.get(key) || 0) + 1);
                        accepted.push(prim);
                    } else {
                        const isHorizontal = w > h;
                        const r = Math.min(w, h) / 2;
                        const diameter = quantize(Math.min(w, h));

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

                        const slotLength = Math.hypot(end.x - start.x, end.y - start.y);
                        const slotKey = `${diameter.toFixed(3)}x${quantize(slotLength + diameter).toFixed(3)}`;
                        slotSizes.set(slotKey, (slotSizes.get(slotKey) || 0) + 1);
                        accepted.push(prim);
                    }

                } else if (prim.type === 'rectangle') {
                    const w = prim.width;
                    const h = prim.height;
                    const isSquare = Math.abs(w - h) < PRECISION;

                    if (isSquare) {
                        const diameter = quantize(w);
                        const cx = prim.position.x + w / 2;
                        const cy = prim.position.y + h / 2;

                        prim.properties.role = 'drill_hole';
                        prim.properties.diameter = diameter;
                        prim.center = { x: cx, y: cy };
                        prim.radius = diameter / 2;

                        warnings.push({
                            message: `Square rectangle (${w.toFixed(3)}mm) treated as circular hole`,
                            severity: 'info'
                        });

                        const key = diameter.toFixed(3);
                        holeSizes.set(key, (holeSizes.get(key) || 0) + 1);
                        accepted.push(prim);
                    } else {
                        rejected.push({ type: 'rectangle', id: prim.id, width: w, height: h });
                        warnings.push({
                            message: `Non-square rectangle (${w.toFixed(3)}x${h.toFixed(3)}mm) rejected - use circles or obrounds for drill holes`,
                            severity: 'warning'
                        });
                    }

                } else {
                    rejected.push({ type: prim.type, id: prim.id });
                    warnings.push({
                        message: `${prim.type} shape rejected - drill operation only supports circles and obrounds`,
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

                const ring = prim.contours?.length === 1
                    ? GeometryUtils.analyzeCircleRing(prim.contours[0].points)
                    : null;
                const circleMatch = ring?.isFullCircle
                    ? { center: ring.center, radius: ring.radius, diameter: ring.radius * 2 }
                    : this.detectCircleFromPath(prim);
                if (circleMatch) {
                    const qDiam = quantize(circleMatch.diameter);
                    recoverableCircles.push({
                        primitiveId: prim.id,
                        detected: { ...circleMatch, diameter: qDiam }
                    });
                    continue;
                }

                const obroundMatch = this.detectObroundFromPath(prim);
                if (obroundMatch) {
                    const qDiam = quantize(obroundMatch.diameter);
                    recoverableObrounds.push({
                        primitiveId: prim.id,
                        detected: { ...obroundMatch, diameter: qDiam }
                    });
                }
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
            operation.bounds = this.core.recalculateBounds(accepted);
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
         * Promotes user-accepted recoverable shapes into proper drill primitives.
         * Called from cam-controller when user confirms the drill recovery modal.
         */
        promoteDrillRecoverable(operation, acceptCircles, acceptObrounds) {
            if (!operation.drillRecoverable) return;

            const quantize = (value) => Math.round(value / PRECISION) * PRECISION;
            let promoted = 0;

            if (acceptCircles && operation.drillRecoverable.circles) {
                for (const candidate of operation.drillRecoverable.circles) {
                    const diameter = quantize(candidate.detected.diameter);
                    const prim = new CirclePrimitive(
                        candidate.detected.center,
                        diameter / 2,
                        {
                            role: 'drill_hole',
                            diameter: diameter,
                            polarity: 'dark',
                            operationType: operation.type,
                            operationId: operation.id,
                            recoveredFromPath: true
                        }
                    );
                    operation.primitives.push(prim);
                    promoted++;
                }
            }

            if (acceptObrounds && operation.drillRecoverable.obrounds) {
                for (const candidate of operation.drillRecoverable.obrounds) {
                    const det = candidate.detected;
                    const diameter = quantize(det.diameter);
                    const prim = new ObroundPrimitive(
                        det.position,
                        det.width,
                        det.height,
                        {
                            role: 'drill_slot',
                            diameter: diameter,
                            originalSlot: det.originalSlot,
                            polarity: 'dark',
                            operationType: operation.type,
                            operationId: operation.id,
                            recoveredFromPath: true
                        }
                    );
                    operation.primitives.push(prim);
                    promoted++;
                }
            }

            operation.bounds = this.core.recalculateBounds(operation.primitives);
            delete operation.drillRecoverable;

            // Rebuild drill summary
            const holeSizes = new Map();
            const slotSizes = new Map();

            for (const prim of operation.primitives) {
                const d = prim.properties?.diameter;
                if (!d) continue;

                if (prim.properties.role === 'drill_hole') {
                    const key = d.toFixed(3);
                    holeSizes.set(key, (holeSizes.get(key) || 0) + 1);
                } else if (prim.properties.role === 'drill_slot') {
                    const slot = prim.properties.originalSlot;
                    if (slot) {
                        const len = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y);
                        const slotKey = `${d.toFixed(3)}x${quantize(len + d).toFixed(3)}`;
                        slotSizes.set(slotKey, (slotSizes.get(slotKey) || 0) + 1);
                    }
                }
            }

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

            // Calculate a simple internal offset of half the laser spot size
            const offsetDist = -(settings.toolDiameter / 2);
            const processedGeometry = [];

            for (const prim of operation.primitives) {
                // Safeguard: Offset only actual drill holes/slots
                if (prim.properties?.role !== 'drill_hole' && prim.properties?.role !== 'drill_slot') {
                    continue;
                }

                const offsetResult = await this.core.geometryOffsetter.offsetBoundary(prim, offsetDist);
                
                if (offsetResult) {
                    if (Array.isArray(offsetResult)) {
                        processedGeometry.push(...offsetResult);
                    } else {
                        processedGeometry.push(offsetResult);
                    }
                }
            }

            // Tag the newly generated geometry 
            processedGeometry.forEach(p => {
                if (!p.properties) p.properties = {};
                p.properties.isOffset = true;
                p.properties.offsetType = 'internal';
                p.properties.offsetDistance = offsetDist;
            });

            // Assign the result to the operation's offsets array
            operation.offsets = [{
                id: this.offsetRecordId(operation.id, 0),
                distance: offsetDist,
                pass: 1,
                type: 'drill',
                primitives: processedGeometry,
                metadata: {
                    strategy: 'offset',
                    toolDiameter: settings.toolDiameter,
                    finalCount: processedGeometry.length,
                    generatedAt: Date.now()
                }
            }];

            return operation.offsets;
        }

        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);

            // Compile parameters
            const opParams = core.compileOperationParams(operation, params);

            if (opParams.isLaser) {
                await this.generateLaserFills(operation, opParams);

                const count = operation.offsets?.[0]?.primitives?.length || 0;
                if (count > 0) {
                    operation.exportReady = true;
                    this.stampExportMetadata(operation, opParams.clearStrategy || 'filled');
                }
                return { success: count > 0, message: `Generated ${count} laser drill marks`, status: 'success' };
            }

            await this.generateGeometry(operation, { ...params, ...opParams });

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation superseded by a newer request', status: 'warning' };
            }

            if (operation.warnings?.length > 0) {
                return { success: true, message: `Generated with ${operation.warnings.length} warning(s)`, status: 'warning', refreshPanel: true };
            }

            const drill = operation.offsets?.[0]?.metadata?.drill;
            const count = operation.offsets?.[0]?.primitives?.length || 0;
            const parts = [];
            if (drill?.peckCount) parts.push(`${drill.peckCount} peck position${drill.peckCount > 1 ? 's' : ''}`);
            if (drill?.millCount) parts.push(`${drill.millCount} milling path${drill.millCount > 1 ? 's' : ''}`);
            const detail = parts.length > 0 ? parts.join(', ') : `${count} feature(s)`;
            return { success: count > 0, message: `Generated ${detail} across ${drill?.groups || 0} tool group(s)`, status: 'success' };
        }

        /**
         * Separates a drill operation's preview into milled and pecked groups,
         * both keyed on the string generation stamped. Milled paths group the
         * same way pecks do because they carry the same per-size cutter: lumping
         * every diameter into one file emitted them under a single T word, so a
         * 1.5mm and a 3.2mm end mill cut the same program.
         * Falls back to the hole diameter for operations generated before the
         * drill table.
         */
        static groupPrimitivesByDiameter(operation) {
            if (!operation.preview?.primitives) return { milledGroups: [], peckGroups: [] };

            const millsByKey = new Map();
            const pecksByKey = new Map();

            for (const prim of operation.preview.primitives) {
                const props = prim.properties;
                const key = props?.drillKey || DrillHandler.diameterKey(props?.originalDiameter || props?.diameter || 0);
                const target = props?.role === 'peck_mark' ? pecksByKey : millsByKey;
                if (!target.has(key)) target.set(key, []);
                target.get(key).push(prim);
            }

            const toGroups = map => [...map.entries()]
                .map(([key, primitives]) => ({ key, diameter: parseFloat(key), primitives }))
                .sort((a, b) => a.diameter - b.diameter);

            return { milledGroups: toGroups(millsByKey), peckGroups: toGroups(pecksByKey) };
        }

        /**
         * Drill Strategy & Geometry Generation
         */
        async generateGeometry(operation, settings) {
            settings = { ...settings };
            this.debug('=== DRILL STRATEGY GENERATION ===');

            const table = this.ensureDrillTable(operation, settings);
            this.debug(`Drill table (${table.preset}): ${Object.keys(table.rows).length} diameter group(s)`);

            const { plan, warnings } = this.determineDrillStrategy(operation, settings);

            // Replace only this pass's warnings - parse-time rejections and
            // recovery notes must survive a regenerate.
            const kept = (operation.warnings || []).filter(w => w?.source !== 'drill-strategy');
            operation.warnings = [...kept, ...warnings];

            const strategyGeometry = await this.generateGeometryFromPlan(plan, operation, settings);
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
                    finalCount: strategyGeometry.length,
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
         * Resolves every feature against ITS row in the drill table rather
         * than one global cutter. A row that inherits resolves to the
         * operation tool, which is what makes the flatten preset identical to
         * the single-tool behaviour.
         */
        determineDrillStrategy(operation, settings) {
            const plan = [];
            const warnings = [];
            const rows = operation.drillTable?.rows || {};
            const minMillingMargin = D.toolpath.generation.drilling.millMargin;

            // Counted per diameter - one warning per row, not one per hole.
            const skipped = new Map();
            const unmillable = new Map();
            const oversize = new Map();
            const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

            for (const primitive of operation.primitives) {
                const role = primitive.properties?.role;

                if (role === 'drill_hole') {
                    if (primitive.type !== 'circle' || !primitive.center || !primitive.radius) {
                        console.warn(`[DrillHandler] Invalid drill hole primitive ${primitive.id}`);
                        continue;
                    }
                } else if (role === 'drill_slot') {
                    const slot = primitive.properties?.originalSlot;
                    if (!slot || !slot.start || !slot.end) {
                        console.warn(`[DrillHandler] Drill slot ${primitive.id} missing or invalid originalSlot data`);
                        continue;
                    }
                } else {
                    continue;
                }

                const featureSize = primitive.properties.diameter;
                const key = DrillHandler.diameterKey(featureSize);
                const entry = this.resolveDrillRow(rows[key], settings, key);

                if (entry.strategy === 'skip') {
                    bump(skipped, key);
                    continue;
                }

                const toolDiameter = entry.toolDiameter;
                if (!(toolDiameter > 0)) {
                    bump(skipped, key);
                    continue;
                }

                // A zero-length slot is a hole the plotter wrote as a route.
                let isSlot = role === 'drill_slot';
                if (isSlot) {
                    const slot = primitive.properties.originalSlot;
                    const length = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y);
                    if (length < PRECISION) {
                        isSlot = false;
                        primitive.center = slot.start;
                        if (!primitive.radius) primitive.radius = featureSize / 2;
                    }
                }

                const diff = featureSize - toolDiameter;
                let toolRelation = 'exact';
                if (diff < -PRECISION) toolRelation = 'oversized';
                else if (diff > PRECISION) toolRelation = 'undersized';

                const wantsMill = entry.strategy === 'mill';
                const canMill = toolRelation === 'undersized' && diff >= minMillingMargin - EPSILON;

                if (isSlot) {
                    const slot = primitive.properties.originalSlot;
                    if (wantsMill) {
                        if (canMill) plan.push({ type: 'mill', primitiveToOffset: primitive, toolRelation: 'undersized', entry });
                        else plan.push({ type: 'centerline', primitiveToOffset: primitive, isCenterline: true, toolRelation, entry });
                        continue;
                    }
                    if (toolRelation === 'oversized') bump(oversize, key);
                    const proximityRisk = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y) < toolDiameter;
                    plan.push(
                        { type: 'peck', position: slot.start, originalDiameter: featureSize, toolRelation, entry },
                        { type: 'peck', position: slot.end, originalDiameter: featureSize, toolRelation, entry, reducedPlunge: proximityRisk }
                    );
                    continue;
                }

                if (wantsMill && canMill) {
                    plan.push({ type: 'mill', primitiveToOffset: primitive, toolRelation, entry });
                    continue;
                }
                if (wantsMill) bump(unmillable, key);
                if (toolRelation === 'oversized') bump(oversize, key);
                plan.push({ type: 'peck', position: primitive.center, originalDiameter: featureSize, toolRelation, entry });
            }

            for (const [key, count] of skipped) {
                warnings.push({ message: `⌀${key}mm: ${count} feature(s) skipped - no usable tool assigned`, severity: 'warning', source: 'drill-strategy' });
            }
            for (const [key, count] of unmillable) {
                warnings.push({ message: `⌀${key}mm: cutter too large to mill - ${count} feature(s) pecked at centre instead`, severity: 'warning', source: 'drill-strategy' });
            }
            for (const [key, count] of oversize) {
                warnings.push({ message: `⌀${key}mm: assigned cutter is wider than the feature - ${count} hole(s) will cut oversize`, severity: 'warning', source: 'drill-strategy' });
            }

            return { plan, warnings };
        }

        async generateGeometryFromPlan(plan, operation, settings) {
            const strategyPrimitives = [];
            const onProgress = operation._onProgress || null;
            const total = plan.length;
            const minFeatureSize = 0.01;

            for (let actionIdx = 0; actionIdx < total; actionIdx++) {
                // Chunked: the loop is synchronous, so a tick without a
                // macrotask yield never reaches the rAF-coalesced overlay.
                if (onProgress && actionIdx > 0 && actionIdx % 128 === 0) {
                    onProgress({ frac: actionIdx / total, label: `Drill ${actionIdx}/${total} holes` });
                    await new Promise(resolve => {
                        const ch = new MessageChannel();
                        ch.port1.onmessage = () => resolve();
                        ch.port2.postMessage(null);
                    });
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
                        slotPart: action.slotPart,
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

    window.DrillHandler = DrillHandler;
})();