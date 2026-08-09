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
    const EPSILON = C.precision.epsilon;
    const PRECISION = C.precision.coordinate;

    class DrillHandler extends BaseOperationHandler {

        /**
         * SVG Drill Classification
         * Called from postParsePrimitives after operation.primitives is set.
         * For Excellon files, the plotter already assigns roles - no action needed.
         */

        postParsePrimitives(operation) {
            if (operation.file.name.toLowerCase().endsWith('.svg')) {
                this.classifySVGDrillPrimitives(operation);
            }
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
                holes: Array.from(holeSizes.entries())
                    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
                    .map(([diameter, count]) => ({ diameter: parseFloat(diameter), count })),
                slots: Array.from(slotSizes.entries())
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([key, count]) => {
                        const [w, l] = key.split('x').map(parseFloat);
                        return { width: w, length: l, count };
                    }),
                totalAccepted: accepted.length,
                totalRejected: rejected.length,
                rejected: rejected,
                source: 'svg'
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
                holes: Array.from(holeSizes.entries())
                    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
                    .map(([diameter, count]) => ({ diameter: parseFloat(diameter), count })),
                slots: Array.from(slotSizes.entries())
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([key, count]) => {
                        const [w, l] = key.split('x').map(parseFloat);
                        return { width: w, length: l, count };
                    }),
                totalAccepted: operation.primitives.length,
                totalRejected: 0,
                rejected: [],
                source: 'svg',
                promoted: promoted
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
                id: `laser_drill_${operation.id}`,
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
                    operation.exportMetadata = {
                        generatedAt: Date.now(),
                        sourceOffsets: operation.offsets?.length || 0,
                        strategy: opParams.clearStrategy || 'filled'
                    };
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

            const count = operation.offsets?.[0]?.primitives?.length || 0;
            const mode = params.millHoles ? 'milling paths' : 'peck positions';
            return { success: count > 0, message: `Generated ${count} ${mode}`, status: 'success' };
        }

        /**
         * Separates a drill operation's preview into milled paths and peck groups by diameter.
         * Works regardless of millHoles setting - a milled operation still generates pecks
         * for holes too small to mill.
         */
        static groupPrimitivesByDiameter(operation) {
            if (!operation.preview?.primitives) return { milledPrimitives: [], peckGroups: [] };

            const milledPrimitives = [];
            const pecksByDiameter = new Map();

            for (const prim of operation.preview.primitives) {
                if (prim.properties?.role === 'peck_mark') {
                    const dia = parseFloat(
                        (prim.properties?.originalDiameter || prim.properties?.diameter || 0).toFixed(3)
                    );
                    if (!pecksByDiameter.has(dia)) pecksByDiameter.set(dia, []);
                    pecksByDiameter.get(dia).push(prim);
                } else {
                    milledPrimitives.push(prim);
                }
            }

            const peckGroups = Array.from(pecksByDiameter.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([diameter, primitives]) => ({ diameter, primitives }));

            return { milledPrimitives, peckGroups };
        }

        /**
         * Drill Strategy & Geometry Generation
         */

        async generateGeometry(operation, settings) {
            // Clone to prevent mutating shared state
            settings = { ...settings };

            this.debug(`=== DRILL STRATEGY GENERATION ===`);
            this.debug(`Mode: ${settings.millHoles ? 'milling' : 'pecking'}`);

            const { plan, warnings } = this.determineDrillStrategy(operation, settings);
            operation.warnings = warnings;

            const strategyGeometry = await this.generateGeometryFromPlan(plan, operation, settings);

            operation.offsets = [{
                id: `drill_strategy_${operation.id}`,
                distance: 0,
                pass: 1,
                primitives: strategyGeometry,
                type: 'drill',
                metadata: {
                    sourceCount: operation.primitives.length,
                    finalCount: strategyGeometry.length,
                    generatedAt: Date.now(),
                    toolDiameter: settings.toolDiameter || settings.tool?.diameter,
                    drill: {
                        mode: settings.millHoles ? 'milling' : 'pecking',
                        peckCount: strategyGeometry.filter(p => p.properties?.role === 'peck_mark').length,
                        millCount: strategyGeometry.filter(p => p.properties?.role === 'drill_milling_path').length
                    }
                },
                settings: { ...settings }
            }];

            return operation.offsets;
        }

        determineDrillStrategy(operation, settings) {
            const plan = [];
            const warnings = [];
            const toolDiameter = parseFloat(settings.toolDiameter);
            const minMillingMargin = 0.05; // Slightly arbitrary safeguard for helixes that are too tight

            for (const primitive of operation.primitives) {
                const role = primitive.properties?.role;

                if (role === 'drill_hole') {
                    if (primitive.type !== 'circle' || !primitive.center || !primitive.radius) {
                        console.warn(`[DrillHandler] Invalid drill hole primitive ${primitive.id}`);
                        continue;
                    }
                } else if (role === 'drill_slot') {
                    if (!primitive.properties?.originalSlot) {
                        console.warn(`[DrillHandler] Drill slot ${primitive.id} missing originalSlot data`);
                        continue;
                    }
                    const slot = primitive.properties.originalSlot;
                    if (!slot.start || !slot.end) {
                        console.warn(`[DrillHandler] Drill slot ${primitive.id} has invalid originalSlot`);
                        continue;
                    }
                } else {
                    continue;
                }

                let isSlot = role === 'drill_slot';
                let featureSize = primitive.properties.diameter;

                if (isSlot) {
                    const slot = primitive.properties.originalSlot;
                    if (slot) {
                        const len = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y);
                        if (len < PRECISION) {
                            isSlot = false;
                            primitive.center = slot.start;
                            if (!primitive.radius) primitive.radius = featureSize / 2;
                        }
                    }
                }

                const diff = featureSize - toolDiameter;
                let toolRelation = 'exact';
                if (diff < -PRECISION) toolRelation = 'oversized';
                else if (diff > PRECISION) toolRelation = 'undersized';

                if (!isSlot) {
                    if (settings.millHoles &&
                        toolRelation === 'undersized' &&
                        diff >= (minMillingMargin - EPSILON)) {
                        plan.push({ type: 'mill', primitiveToOffset: primitive, toolRelation });
                    } else {
                        plan.push({
                            type: 'peck',
                            position: primitive.center,
                            toolDiameter: toolDiameter,
                            originalDiameter: featureSize,
                            toolRelation: toolRelation
                        });
                    }
                } else {
                    const slot = primitive.properties.originalSlot;
                    if (!slot) continue;

                    const isCenterline =
                        toolRelation === 'exact' ||
                        toolRelation === 'oversized' ||
                        (toolRelation === 'undersized' && diff < minMillingMargin);

                    if (settings.millHoles) {
                        if (isCenterline) {
                            plan.push({
                                type: 'centerline',
                                primitiveToOffset: primitive,
                                isCenterline: true,
                                toolRelation: toolRelation,
                                originalSlot: slot
                            });
                        } else {
                            plan.push({ type: 'mill', primitiveToOffset: primitive, toolRelation: 'undersized' });
                        }
                    } else {
                        const proximityRisk = Math.hypot(slot.end.x - slot.start.x, slot.end.y - slot.start.y) < toolDiameter;
                        plan.push(
                            { type: 'peck', position: slot.start, toolDiameter, originalDiameter: featureSize, toolRelation },
                            { type: 'peck', position: slot.end, toolDiameter, originalDiameter: featureSize, toolRelation, reducedPlunge: proximityRisk }
                        );
                    }
                }
            }
            return { plan, warnings };
        }

        async generateGeometryFromPlan(plan, operation, settings) {
            const strategyPrimitives = [];
            const toolDiameter = parseFloat(settings.toolDiameter);

            if (!toolDiameter || isNaN(toolDiameter) || toolDiameter <= 0) {
                console.error(`[DrillHandler] Invalid tool diameter (${toolDiameter})`);
                return [];
            }

            const onProgress = operation._onProgress || null;
            const total = plan.length;

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

                if (action.type === 'peck') {
                    strategyPrimitives.push(new CirclePrimitive(
                        action.position,
                        toolDiameter / 2,
                        {
                            role: 'peck_mark',
                            holeIndex: actionIdx,
                            originalDiameter: action.originalDiameter,
                            toolDiameter: toolDiameter,
                            toolRelation: action.toolRelation,
                            reducedPlunge: action.reducedPlunge,
                            slotPart: action.slotPart,
                            operationId: operation.id
                        }
                    ));

                } else if (action.type === 'mill') {
                    const source = action.primitiveToOffset;
                    const toolRadius = toolDiameter / 2;
                    const minFeatureSize = 0.01; // Slightly arbitrary safeguard REVIEW - can't remember what for though? force plunge entry instead of milling?

                    if (source.type === 'circle') {
                        const holeRadius = source.radius;
                        const pathRadius = holeRadius - toolRadius;

                        if (pathRadius > minFeatureSize) {
                            const stepOverPct = settings.stepOver;
                            const stepDist = toolDiameter * (1.0 - (stepOverPct / 100.0));

                            const concentricPasses = [];
                            let currentRadius = pathRadius;
                            let p = 1;

                            while (currentRadius >= minFeatureSize) {
                                concentricPasses.push(new CirclePrimitive(
                                    source.center,
                                    currentRadius,
                                    {
                                        role: 'drill_milling_path',
                                        holeIndex: actionIdx,
                                        operationId: operation.id,
                                        toolDiameter: toolDiameter,
                                        originalDiameter: holeRadius * 2,
                                        toolRelation: action.toolRelation || 'undersized',
                                        isOffset: true,
                                        offsetType: 'internal',
                                        pass: p++
                                    }
                                ));

                                if (currentRadius <= toolRadius) break;
                                currentRadius -= stepDist;
                                if (currentRadius < minFeatureSize && currentRadius > 0) {
                                    currentRadius = minFeatureSize;
                                }
                            }

                            strategyPrimitives.push(...concentricPasses.reverse());
                        } else {
                            strategyPrimitives.push(new CirclePrimitive(
                                source.center,
                                toolDiameter / 2,
                                {
                                    role: 'peck_mark',
                                    holeIndex: actionIdx,
                                    originalDiameter: source.radius * 2,
                                    toolDiameter: toolDiameter,
                                    toolRelation: 'undersized_too_small',
                                    operationId: operation.id
                                }
                            ));
                        }
                    } else if (source.properties?.originalSlot) {
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
                            const stepOverPct = settings.stepOver; // REVIEW - Is this logic flipped? 90% step-over is only doing less passes 10%?
                            const stepDist = toolDiameter * (1.0 - (stepOverPct / 100.0));

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

                                concentricPasses.push(new ObroundPrimitive(
                                    { x: cornerX, y: cornerY },
                                    obroundWidth,
                                    obroundHeight,
                                    {
                                        role: 'drill_milling_path',
                                        holeIndex: actionIdx,
                                        originalDiameter: slotWidth,
                                        toolDiameter: toolDiameter,
                                        originalSlot: originalSlot,
                                        toolRelation: 'undersized',
                                        operationId: operation.id,
                                        isOffset: true,
                                        offsetType: 'internal',
                                        pass: p++
                                    }
                                ));

                                if (currentShort <= toolDiameter) break;
                                currentShort -= (2 * stepDist);
                                currentLong -= (2 * stepDist);
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
                } else if (action.type === 'centerline') {
                    const source = action.primitiveToOffset;
                    const originalSlot = source.properties?.originalSlot;

                    if (originalSlot) {
                        const millingPath = new PathPrimitive([{
                            points: [originalSlot.start, originalSlot.end],
                            isHole: false,
                            nestingLevel: 0,
                            parentId: null,
                            arcSegments: [],
                            curveIds: []
                        }], {
                            role: 'drill_milling_path',
                            holeIndex: actionIdx,
                            isCenterlinePath: true,
                            isDrillMilling: true,
                            toolRelation: action.toolRelation,
                            originalDiameter: source.properties.diameter,
                            toolDiameter: toolDiameter,
                            operationId: operation.id,
                            originalSlot: originalSlot,
                            closed: false,
                        });
                        strategyPrimitives.push(millingPath);
                    }
                }
            }

            return strategyPrimitives;
        }
    }

    window.DrillHandler = DrillHandler;
})();