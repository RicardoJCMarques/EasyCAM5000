/*!
 * @file        operations/shape-rotary-handler.js
 * @description Rotary (4th-axis) operation handler - CylMap-driven
 *              cylindrical surfacing in DEVELOPED coordinates (y =
 *              unwound arc at the blank radius). Output flows through
 *              the standard is3DToolpath / is3DContour pipeline.
 *
 *              The CylMap is sliced ON DEMAND from operation.sourceMesh
 *              at every generation, so blank, resolution and orientation
 *              changes always take effect.
 *
 *              This file is the RADIAL engine plus the kinematics
 *              dispatch. Workholding, tuning and the orientation
 *              matrices are FieldParams' - both engines resolve through
 *              it, so chuck/tail/core can never be interpreted two ways.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class ShapeRotaryHandler extends FieldOperationHandler {

        /**
         * [INDEXED] Kinematics dispatch. The UI keeps ONE 'rotary'
         * operation; rotaryKinematics ('radial' default | 'indexed')
         * selects the engine. Indexed delegates the ENTIRE orchestration
         * so both engines stay independently testable - including the
         * token, the reset and the progress binding, which is why nothing
         * happens here before the hand-off.
         */
        async orchestrateGeneration(operation, params, core, options = {}) {
            if ((params.rotaryKinematics || 'radial') === 'indexed') {
                return core.getHandler('rotary-indexed')
                    .orchestrateGeneration(operation, params, core, options);
            }
            return super.orchestrateGeneration(operation, params, core, options);
        }

        passTypePrefix() { return 'rotary'; }
        pipelineLabel() { return 'ROTARY'; }
        emptyMessage() {
            return 'No rotary paths generated - model may be round stock already or below resolution';
        }

        validateSource(operation) {
            if (!this.getMeshSource(operation)) {
                return {
                    success: false,
                    message: 'No rotary source - import an STL model for this operation',
                    status: 'warning'
                };
            }
            return null;
        }

        buildJobs(operation, p, warnings) {
            const mesh = this.getMeshSource(operation);
            if (!mesh) return [];
            // ONE workholding resolution per generation - the slice padding
            // and the generator's machinable window read the same reach, so
            // the two can never disagree.
            const wh = FieldParams.workholding(p);
            return [{
                kind: 'rotary',
                mesh,
                sliceOptions: this.buildSliceOptions(p, wh),
                genOptions: this.buildGeneratorOptions(p, wh)
            }];
        }

        buildSliceOptions(p, wh) {
            // Machine axis and model orientation are independent.
            // visualOrient lays an upright model along the machine's rotary
            // axis (world); internalOrient then maps that axis onto the
            // builder's axial X. Both are pure rotations, so the composed
            // frame is right-handed and θ needs no sign correction.
            // REVIEW - Once the UI is reworked this orientation logic may need changing.
            const machineAxis = p.rotaryAxis === 'y' ? 'y' : 'x';
            const upright = p.rotaryModelUp === 'upright';
            const bSign = FieldParams.axisBSign(machineAxis);

            return {
                axis: machineAxis,
                // composeOrient, never a bare mul: for the DEFAULT config
                // (axis 'x', model lying down) both factors are null.
                orient: FieldParams.composeOrient(
                    FieldParams.internalOrient(machineAxis),
                    FieldParams.visualOrient(machineAxis, upright)),
                cellSize: p.rotaryCellSize > 0 ? p.rotaryCellSize : null,
                gridMaxDim: p.rotaryGridMaxDim,
                refRadius: p.rotaryBlankDiameter > 0 ? p.rotaryBlankDiameter / 2 : 0,
                // Constant 0 - the slicer must NOT clip the radius field.
                // The stub is composed into the generator's target surface
                // before compensation; clipping here flattens sub-core
                // geometry into a mesa with vertical walls.
                coreRadius: 0,
                // rotaryAxisOffsetB is WORLD (world Y for an A/x job, world
                // X for a B/y job); bSign maps it into the sliced cross-u
                // frame. Cross-v is +worldZ, so C needs no sign.
                axisOffset: { b: bSign * (p.rotaryAxisOffsetB || 0),
                              c: p.rotaryAxisOffsetC || 0 },
                // Radiality gate: reject faces within ~asin(√v) of axial
                // (end caps, tilted bases a radial tool cannot form).
                minRadiality: window.CAMConfig.constants.rotary.minRadialitySin2,
                // Grid reserved PER END from that end's OWN reach, so a
                // 'stop' end does not inherit the other end's overrun as
                // dead grid (which also degrades the auto cell size).
                padding: {
                    low:  Math.max(0, wh.ends.chuck.reach) + 0.1,
                    high: Math.max(0, wh.ends.tail.reach) + 0.1
                }
            };
        }

        buildGeneratorOptions(p, wh) {
            const toolDiameter = p.toolDiameter;
            const mode = p.rotaryMode;
            const C = window.CAMConfig.constants.rotary;

            return {
                toolDiameter,
                toolShape: p.rotaryToolShape,
                cornerRadius: p.rotaryCornerRadius,
                totalDepth: p.rotaryDepth,
                coreRadius: wh.coreRadius,
                stockShape: p.rotaryStockShape, // 'square' → generator derives refR·√2
                roughing: mode !== 'finishing',
                finishing: mode !== 'roughing',
                roughStepdown: p.rotaryRoughStepdown,
                roughStepover: toolDiameter * (p.rotaryRoughStepoverPct / 100),
                roughStock: p.rotaryRoughStock,
                roughAxis: p.rotaryRoughAxis,
                finishStepover: toolDiameter * (p.rotaryFinishStepoverPct / 100),
                finishPattern: p.rotaryFinishPattern,
                // Workholding + per-end boundary policy - see profile params
                // rotaryHoldingMode / rotary{Chuck,Tail}End{Mode,Mm}.
                ends: wh.ends
            };
        }

        /**
         * cm.axisB is the SLICED cross-u coordinate. Every display consumer -
         * GeometryLayer3D's developed wrap and walkPlans' devAxisB - draws in
         * world/machine space, and buildSharedMetadata below already publishes
         * the world value for the blank cylinder. Republish it on the
         * primitives so the two can never disagree: axisBSign is -1 for a B(y)
         * job, which mirrored the wrapped strip across its own blank.
         */
        onJobPrimitives(primitives, job) {
            const bSign = FieldParams.axisBSign(job.sliceOptions.axis);
            if (bSign === 1) return;
            for (const p of primitives) {
                const props = p.properties;
                if (props && typeof props.axisB === 'number') props.axisB *= bSign;
            }
        }

        buildSharedMetadata(ctx) {
            const cm = ctx.containers[0];
            const o = ctx.jobs[0].genOptions;
            const settings = ctx.settings;

            const machineAxis = settings.rotaryAxis === 'y' ? 'y' : 'x';
            const bSign = FieldParams.axisBSign(machineAxis);
            // Published in WORLD coordinates - the 3D blank placement and the
            // 2D strip transform both want world, and cm.axisB is sliced.
            const axisCenter = { b: cm.axisB * bSign, c: cm.axisC };
            // VISUAL orient only. The internal axis mapping is a slicer
            // implementation detail and must never reach the renderer.
            // Computed from settings, not from cm: the CylMap's props are
            // serialized by a fixed list, so anything hung on the instance
            // dies at the postMessage boundary.
            const orient = FieldParams.visualOrient(
                machineAxis, settings.rotaryModelUp === 'upright');

            return {
                generatedAt: Date.now(),
                toolDiameter: o.toolDiameter,
                toolShape: o.toolShape,
                refRadius: cm.refRadius,
                totalDepth: cm.meta.appliedDepth,
                circumference: 2 * Math.PI * cm.refRadius,
                rotaryAxis: cm.axis, // slicing frame: 'x' | 'y'
                // Only `orient` is consumed (refresh3D's mesh placement);
                // refRadius, axisCenter and originX are read from the top
                // level below.
                rotaryFrame: { orient },
                stockStartRadius: cm.meta.appliedStockStartRadius,
                axisCenter,
                originX: cm.originX,
                gridCols: cm.cols,
                gridRows: cm.rows,
                cellSize: cm.cellX,
                developedSpace: true,   // y = unwound arc at refRadius -
                                        // the machine pass must convert
                is3DToolpath: true
            };
        }
    }

    window.ShapeRotaryHandler = ShapeRotaryHandler;
})();
