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

  const ROOT = globalThis;

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
        return core.getHandler('rotary-indexed').orchestrateGeneration(operation, params, core, options);
      }
      return super.orchestrateGeneration(operation, params, core, options);
    }

    /**
     * How the rotary is mounted is machine setup, not part of an
     * operation: the axis it turns about and the end its chuck holds.
     */
    machineParams(settings) {
      return { rotaryAxis: settings.gcode.rotaryAxis, rotaryChuckSide: settings.gcode.rotaryChuckSide };
    }

    passTypePrefix() {
      return 'rotary';
    }

    pipelineLabel() {
      return 'ROTARY';
    }

    emptyMessage() {
      return { key: 'messages.operations.noRotary' };
    }

    validateSource(operation) {
      if (!this.getMeshSource(operation)) {
        return {
          success: false,
          message: {key: 'messages.operations.noRotarySource'},
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
      // The mesh arrives in the radial frame (syncPrimitives): oriented by the
      // scene, its axis the machine axis line through the origin. internalOrient
      // only maps that axis onto the builder's axial X - a pure rotation about the
      // origin, so the axis stays at (0, 0) and θ needs no sign correction.
      const machineAxis = p.rotaryAxis === 'y' ? 'y' : 'x';
      return {
        axis: machineAxis,
        // null for an A job: the builders treat an absent orient as identity.
        orient: FieldParams.internalOrient(machineAxis),
        // The axis is the frame's, never the model's own centre.
        axisCenter: { b: 0, c: 0 },
        cellSize: p.rotaryCellSize > 0 ? p.rotaryCellSize : null,
        gridMaxDim: p.rotaryGridMaxDim,
        refRadius: p.rotaryBlankDiameter > 0 ? p.rotaryBlankDiameter / 2 : 0,
        // Constant 0 - the slicer must NOT clip the radius field.
        // The stub is composed into the generator's target surface
        // before compensation; clipping here flattens sub-core
        // geometry into a mesa with vertical walls.
        coreRadius: 0,
        // Radiality gate: reject faces within ~asin(√v) of axial
        // (end caps, tilted bases a radial tool cannot form).
        minRadiality: ROOT.CAMConfig.constants.rotary.minRadialitySin2,
        // Grid reserved PER END from that end's OWN reach, so a
        // 'stop' end does not inherit the other end's overrun as
        // dead grid (which also degrades the auto cell size).
        padding: {
          low: Math.max(0, wh.ends.low.reach) + 0.1,
          high: Math.max(0, wh.ends.high.reach) + 0.1
        }
      };
    }

    buildGeneratorOptions(p, wh) {
      const toolDiameter = p.toolDiameter;
      const mode = p.rotaryMode;

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

    buildSharedMetadata(ctx) {
      const cm = ctx.containers[0];
      const o = ctx.jobs[0].genOptions;
      return {
        generatedAt: Date.now(),
        toolDiameter: o.toolDiameter,
        toolShape: o.toolShape,
        refRadius: cm.refRadius,
        totalDepth: cm.meta.appliedDepth,
        circumference: 2 * Math.PI * cm.refRadius,
        rotaryAxis: cm.axis, // slicing frame: 'x' | 'y'
        stockStartRadius: cm.meta.appliedStockStartRadius,
        // Radial-frame axial coordinate of column 0's centre: the 3D blank sits along the grid as is.
        originX: cm.originX,
        gridCols: cm.cols,
        gridRows: cm.rows,
        cellSize: cm.cellX,
        developedSpace: true, // y = unwound arc at refRadius - the machine pass must convert
        is3DToolpath: true
      };
    }
  }

  ROOT.ShapeRotaryHandler = ShapeRotaryHandler;
})();