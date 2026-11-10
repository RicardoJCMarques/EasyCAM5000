/*!
 * @file        export/processors/roland-processor.js
 * @description Roland RML-1 post-processing main logic module
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
  /**
   * Roland RML-1 Post-Processor
   * Implements the same interface as BasePostProcessor for use by GCodeGenerator.
   * Does NOT extend BasePostProcessor - RML is a completely different command language.
   * TWO COMMAND MODELS:
   * 3D Mode (MDX-40A+):
   *  All motion via Z x,y,z; command. Speed controlled by !VZ/V.
   *  No PU/PD/VS used.
   * 2.5D Mode (PU/PD):
   *  PU x,y; - rapid move to (x,y) at !PZ z2 height
   *  PD x,y; - cut move to (x,y) at !PZ z1 depth, speed VS
   *  !PZ z1,z2; - set depth register (z1=PD depth, z2=PU height)
   *  VS speed; - set XY cutting velocity (mm/s)
   *  !VZ speed; - set Z/plunge velocity (mm/s)
   * Common commands:
   *  PA; - Plot Absolute mode
   *  !MC 0|1; - Motor Control off/on
   *  !RC value; - Rotation Control (RPM or index 1-15)
   *  !DW ms; - Dwell in milliseconds
   * Coordinates are integer "steps" (mm x stepsPerMM).
   *
   * Every machine fact comes from the setup's model table (flags.models in
   * roland.json): steps per mm, the feed ceilings, whether the
   * spindle takes !RC and the machine takes !DW, and the init and end
   * sequences. The operator picks the model and the Z mode. A machine the
   * table lacks is a custom setup with a model entry of its own.
   *
   * The rml setup schema pins every capability flag to what this logic can
   * write. RML-1 has no tool-select verb and no unconditional pause: the
   * command set is plotter-derived (PU/PD/Z/!VZ/!PZ/!MC/!RC/!DW/;;^DF), with
   * no T word and no M6 equivalent, and !DW is a timed dwell, not an operator
   * wait. The MDX-50 has an automatic tool LENGTH sensor, not a changer, and
   * its length sensing is a machine-side operation, not a file command.
   * Multi-tool Roland work is one file per tool, which the multi-file and
   * split-drill export paths already produce. ';' terminates a command and
   * there is no comment syntax either.
   */
  class RolandPostProcessor {
    /** The core/file-validation.json definition a setup for this logic passes. */
    static setupSchema = 'setup-rml';

    /**
     * @param {Object} setup - a setup whose logic is 'rml'
     */
    constructor(setup) {
      this.config = setup.flags;
      // A model with a proper name carries its label; a generic one carries
      // null and is captioned by params.rolandModel.options.<id>. A model's
      // caveat is params.rolandModel.notes.<id>.
      const models = setup.flags.models;
      const model = {
        name: 'rolandModel',
        type: 'select',
        category: 'post',
        default: Object.keys(models)[0],
        options: Object.entries(models).map(([value, m]) => ({ value, label: m.label })),
      };
      const zMode = { name: 'rolandZMode', type: 'select', category: 'post', default: '3d', options: [{ value: '3d' }, { value: '2.5d' }] };
      this.descriptor = BasePostProcessor.describe(setup, [model, zMode, ...BasePostProcessor.parameters]);
      this.resetState();
    }

    /**
     * RML machine limits, applied to the job context before it freezes.
     * 2.5D machines drive Z through the PU/PD depth register, so there is
     * no interpolated entry and no partial-depth tab; a mill in a 2.5D
     * profile must also step down, because the register cannot ramp.
     * Feed clamps are hardware maxima - VS above them is rejected by the
     * controller rather than reduced.
     */
    prepareContext(ctx, operation) {
      const own = ctx.processorSettings[this.descriptor.id];
      const model = this.config.models[own.rolandModel];
      if (own.rolandZMode === '2.5d') {
        ctx.strategy.entryType = 'plunge';
        if (operation.type === 'cutout') ctx.strategy.cutout.tabs = 0;
        if (operation.type === 'drill' && ctx.strategy.drill.millHoles) {
          ctx.strategy.multiDepth = true;
          const maxSafeStep = ctx.tool.diameter * 0.5;
          if (Math.abs(ctx.strategy.depthPerPass) > maxSafeStep) ctx.strategy.depthPerPass = maxSafeStep;
        }
      }
      // Model feeds are mm/s; the context carries mm/min.
      const maxCutFeed = model.maxFeedXY * 60;
      const maxPlungeFeed = model.maxFeedZ * 60;
      if (ctx.cutting.feedRate > maxCutFeed) ctx.cutting.feedRate = maxCutFeed;
      if (ctx.cutting.plungeRate > maxPlungeFeed) ctx.cutting.plungeRate = maxPlungeFeed;
    }

    // GCodeGenerator calls these on whatever post is active. RML has no
    // feed-rate mode word, no canned cycles and no line numbers, so the
    // honest answer is "nothing to emit" - not "method missing".
    setFeedRateMode() {
      return '';
    }

    cancelCannedCycle() {
      return '';
    }

    // RML is not G-code and has no N word - `N10 PU0,0;` is a syntax
    // error, not a block the sender might tolerate.
    applyLineNumbers(gcodeText) {
      return gcodeText;
    }

    // Machine limits are machine facts, not G-code facts - RML output is
    // bounded by the same maxFeed and maxSafeDepth as every other post.
    // RML has no feed-rate mode word and no rotary word, so F is always a
    // velocity and Z is always flat-stock referenced.
    validateCommand(cmd, options) {
      return BasePostProcessor.validateCommandLimits(cmd, options, {
        inverseTime: false,
        maxInverseTime: 0,
        rotaryAxisWord: null,
        zDatum: 0,
        zFloor: null,
      });
    }

    resetState() {
      this.currentPosition = { x: 0, y: 0, z: 0 };
      this.currentSpindle = 0;
      // Not a BasePostProcessor subclass - the generator reads these
      // fields on whatever processor is active, so they have to exist
      // here too even though RML can never change a tool. This post
      // formats its own integer steps and does not call
      // formatNumberSafe, so the count stays 0 and the program scan is
      // what covers it.
      this.currentToolNumber = null;
      this.numericFaults = 0;
      this.currentFeed = null; // VS value (mm/min internally, for 2.5D XY)
      this.currentVZ = null; // !VZ value (mm/min internally)
      // !PZ register tracking (in mm, converted on output)
      this.pzDownMM = 0;
      this.pzUpMM = 0;
      // The program's machine, latched in generateHeader from the model table
      this.model = null;
      this.stepsPerMM = 0;
      this.maxFeedXY = 0; // mm/s
      this.maxFeedZ = 0; // mm/s
      this.zMode = null;
      this.travelZ = 0;
      this.useLegacyVelocity = false;
    }

    generateHeader(options) {
      this.model = this.config.models[options.rolandModel];
      this.stepsPerMM = this.model.stepsPerMM;
      this.maxFeedXY = this.model.maxFeedXY;
      this.maxFeedZ = this.model.maxFeedZ;
      this.zMode = options.rolandZMode;
      this.travelZ = options.travelZ;
      this.useLegacyVelocity = this.model.protocol === 'legacy';
      // The model's init sequence, then the operator's start block. RML
      // has no comment syntax - ';' terminates a command - so nothing here
      // may carry text: a "; note" line is junk commands and error 1025.
      const lines = [this.model.init];
      if (options.startCode.trim()) lines.push(options.startCode);
      // Velocity setup - differs by Z mode and protocol
      const firstPlan = options.firstPlan;
      const velCmd = this.useLegacyVelocity ? 'V' : '!VZ';
      if (this.zMode === '3d') {
        // 3D mode: Z command uses V/!VZ speed for ALL axes.
        // VS is irrelevant - never set it. Only V/!VZ matters.
        const cutFeed = firstPlan && firstPlan.metadata ? firstPlan.metadata.feedRate : 150;
        lines.push(`${velCmd}${this.mmMinToVS(cutFeed)};`);
        this.currentVZ = cutFeed;
      } else {
        // 2.5D mode: VS for XY cutting (PD), V/!VZ for plunge speed
        const cutFeed = firstPlan && firstPlan.metadata ? firstPlan.metadata.feedRate : 150;
        lines.push(`VS${this.mmMinToVS(cutFeed)};`);
        this.currentFeed = cutFeed;
        const plungeRate = firstPlan && firstPlan.metadata && firstPlan.metadata.plungeRate ? firstPlan.metadata.plungeRate : 60;
        lines.push(`${velCmd}${this.mmMinToVS(plungeRate)};`);
        this.currentVZ = plungeRate;
      }
      // Z parameters - safety registers (used as fallback in both modes)
      this.pzDownMM = 0;
      this.pzUpMM = this.travelZ;
      lines.push(`!PZ${this.fmtCoord(this.pzDownMM)},${this.fmtCoord(this.pzUpMM)};`);
      // Spindle - after all setup params are established
      if (firstPlan && firstPlan.metadata && firstPlan.metadata.spindleSpeed > 0) {
        const speed = firstPlan.metadata.spindleSpeed;
        // A model without !RC runs at its own speed: on and off only.
        if (this.model.spindleControl) lines.push(`!RC${Math.round(speed)};`);
        lines.push('!MC1;');
        const dwell = firstPlan.metadata.spindleDwell || 0;
        if (dwell > 0 && this.model.dwell) lines.push(`!DW${Math.round(dwell * 1000)};`);
        this.currentSpindle = speed;
      }
      return lines.join('\n');
    }

    generateFooter(options) {
      // The operator's end block, then the model's end sequence (motor
      // off, park, reset).
      const lines = [];
      if (options.endCode.trim()) lines.push(options.endCode);
      lines.push(this.model.end);
      return lines.join('\n');
    }

    /**
     * RML-1 cannot change tools. Kept as an explicit no-op rather than
     * omitted: GCodeGenerator reads the method off whichever processor is
     * active, and supportsToolChange:false already stops it being called.
     * See the class comment for what would have to be verified on real
     * hardware before this becomes real.
     */
    generateToolChange(tool, options) {
      return '';
    }

    generateInitialTool(tool, options) {
      return '';
    }

    setSpindle(speed, dwell = 0, options = {}) {
      const wantOn = speed > 0;
      const wasOn = this.currentSpindle > 0;
      if (wantOn === wasOn && (!wantOn || speed === this.currentSpindle)) return null;
      const lines = [];
      if (wantOn && !wasOn) {
        // Turning on
        if (this.model.spindleControl) lines.push(`!RC${Math.round(speed)};`);
        lines.push('!MC1;');
        if (dwell > 0 && this.model.dwell) lines.push(`!DW${Math.round(dwell * 1000)};`);
        this.currentSpindle = speed;
      } else if (!wantOn && wasOn) {
        // Turning off
        lines.push('!MC0;');
        this.currentSpindle = 0;
      } else if (wantOn && wasOn && speed !== this.currentSpindle) {
        // Speed change while running
        if (this.model.spindleControl) lines.push(`!RC${Math.round(speed)};`);
        this.currentSpindle = speed;
      }
      return lines.join('\n');
    }

    /** Main dispatch - routes to the correct command model. */
    processCommand(cmd) {
      return this.zMode === '3d' ? this.process3D(cmd) : this.process25D(cmd);
    }

    /**
     * Target position for cmd, with change detection on the machine step
     * grid: a move smaller than one step emits nothing.
     */
    stepTarget(cmd) {
      const s = this.stepsPerMM;
      const cur = this.currentPosition;
      const x = cmd.x ?? cur.x;
      const y = cmd.y ?? cur.y;
      const z = cmd.z ?? cur.z;
      const sx = Math.round(x * s);
      const sy = Math.round(y * s);
      const sz = Math.round(z * s);
      return {
        x, y, z,
        stepped: { x: sx / s, y: sy / s, z: sz / s },
        xChanged: sx !== Math.round(cur.x * s),
        yChanged: sy !== Math.round(cur.y * s),
        zChanged: sz !== Math.round(cur.z * s),
      };
    }

    // V (legacy) / !VZ is modal: re-emitted only on a change above 0.1 mm/min.
    pushVelocity(lines, mmPerMin, axis) {
      if (this.currentVZ === null || Math.abs(mmPerMin - this.currentVZ) > 0.1) {
        lines.push(`${this.useLegacyVelocity ? 'V' : '!VZ'}${this.mmMinToVS(mmPerMin, axis)};`);
        this.currentVZ = mmPerMin;
      }
    }

    /**
     * 3D Mode: All motion via V/!VZ + Z x,y,z; command.
     * Modern machines (MDX-40+): !VZ sets speed for Z command (all axes)
     * Legacy machines (MDX-15/20): V sets speed for Z command (all axes)
     * In both cases:
     *  Z x,y,z; moves to absolute position at that speed
     *  VS, PU, PD are NEVER used
     *  Rapids = Z command at machine max speed
     *  Cuts = Z command at cutting feed
     *  Plunges = Z command at plunge feed
     */
    process3D(cmd) {
      const t = this.stepTarget(cmd);
      if (!t.xChanged && !t.yChanged && !t.zChanged && cmd.type !== 'DWELL') return '';
      const lines = [];
      const moveTo = () => {
        lines.push(`Z${this.fmtCoord(t.x)},${this.fmtCoord(t.y)},${this.fmtCoord(t.z)};`);
        this.currentPosition = t.stepped;
      };
      switch (cmd.type) {
        case 'RAPID':
        case 'RETRACT':
          // Machine maximum for rapid travel
          this.pushVelocity(lines, Math.min(this.maxFeedXY, this.maxFeedZ) * 60, 'combined');
          moveTo();
          break;
        case 'LINEAR':
        case 'PLUNGE':
          if (cmd.f != null) {
            // Clamp against the dominant axis
            const feedAxis = !t.xChanged && !t.yChanged ? 'z' : !t.zChanged ? 'xy' : 'combined';
            this.pushVelocity(lines, cmd.f, feedAxis);
          }
          moveTo();
          break;
        case 'DWELL': {
          // A model without !DW drops the dwell rather than send a command it rejects.
          if (!this.model.dwell) break;
          const ms = Math.round((cmd.dwell || 0) * 1000);
          if (ms > 0) lines.push(`!DW${ms};`);
          break;
        }
        case 'ARC_CW':
        case 'ARC_CCW':
          console.warn('[RolandProcessor] Arc command reached processor - should have been linearized');
          if (cmd.f != null) this.pushVelocity(lines, cmd.f);
          moveTo();
          break;
        default:
          break;
      }
      return lines.join('\n');
    }

    /**
     * 2.5D Mode: PU/PD with !PZ register management.
     * Command model:
     *  PU x,y; - pen up, move XY at PU height (z2). Speed is max.
     *  PD x,y; - pen down to PD depth (z1), then move XY. Speed is VS.
     *  !PZ z1,z2; - set the depth (z1) and clearance (z2) registers
     *  VS speed; - set XY cutting speed for PD moves
     *  !VZ speed; - set plunge speed (Z-axis movement in PD)
     * Z position is implicit: after PU it's z2, after PD it's z1.
     * No simultaneous XYZ motion is possible.
     */
    process25D(cmd) {
      const t = this.stepTarget(cmd);
      if (!t.xChanged && !t.yChanged && !t.zChanged && cmd.type !== 'DWELL') return '';
      const lines = [];
      // PD: the depth register (z1) follows the target Z, then the XY move.
      const penDown = () => {
        if (t.zChanged) {
          const pz = this.emitPZIfChanged(t.z, this.pzUpMM);
          if (pz) lines.push(pz);
        }
        lines.push(`PD${this.fmtCoord(t.x)},${this.fmtCoord(t.y)};`);
        this.currentPosition = { x: t.stepped.x, y: t.stepped.y, z: this.pzDownMM };
      };
      switch (cmd.type) {
        case 'RAPID':
        case 'RETRACT': {
          // PU: the height register (z2) follows the target Z
          if (t.zChanged) {
            const pz = this.emitPZIfChanged(this.pzDownMM, t.z);
            if (pz) lines.push(pz);
          }
          lines.push(`PU${this.fmtCoord(t.x)},${this.fmtCoord(t.y)};`);
          // After PU the machine sits at z2
          this.currentPosition = { x: t.stepped.x, y: t.stepped.y, z: this.pzUpMM };
          break;
        }
        case 'LINEAR':
        case 'PLUNGE':
          if (cmd.f != null) {
            const isPlungeMove = cmd.type === 'PLUNGE' || (t.zChanged && !t.xChanged && !t.yChanged);
            const isSimultaneous = t.zChanged && (t.xChanged || t.yChanged);
            // Plunge/Z speed via V/!VZ
            if (isPlungeMove || isSimultaneous) this.pushVelocity(lines, cmd.f);
            // XY cutting speed via VS
            if (!isPlungeMove && (this.currentFeed === null || Math.abs(cmd.f - this.currentFeed) > 0.1)) {
              lines.push(`VS${this.mmMinToVS(cmd.f)};`);
              this.currentFeed = cmd.f;
            }
          }
          penDown();
          break;
        case 'DWELL': {
          if (!this.model.dwell) break;
          const ms = Math.round((cmd.dwell || 0) * 1000);
          if (ms > 0) lines.push(`!DW${ms};`);
          break;
        }
        case 'ARC_CW':
        case 'ARC_CCW':
          console.warn('[RolandProcessor] Arc command reached 2.5D processor - should have been linearized');
          penDown();
          break;
        default:
          break;
      }
      return lines.join('\n');
    }

    /** Emits !PZ command only if register values actually changed. */
    emitPZIfChanged(newDownMM, newUpMM) {
      const EPSILON = ROOT.CAMConfig.constants.precision.coordinate;
      const downChanged = Math.abs(newDownMM - this.pzDownMM) > EPSILON;
      const upChanged = Math.abs(newUpMM - this.pzUpMM) > EPSILON;
      if (downChanged || upChanged) {
        this.pzDownMM = newDownMM;
        this.pzUpMM = newUpMM;
        return `!PZ${this.fmtCoord(this.pzDownMM)},${this.fmtCoord(this.pzUpMM)};`;
      }
      return '';
    }

    /** Format a mm value as integer steps for RML output. */
    fmtCoord(value) {
      if (value === null || value === undefined) return '0';
      return Math.round(value * this.stepsPerMM).toString();
    }

    /** Convert mm/min feed rate to Roland velocity string (mm/s, clamped to machine max). */
    mmMinToVS(mmPerMin, axis = 'combined') {
      const mmPerSec = mmPerMin / 60;
      let maxForAxis;
      switch (axis) {
        case 'xy':
          maxForAxis = this.maxFeedXY;
          break;
        case 'z':
          maxForAxis = this.maxFeedZ;
          break;
        default:
          maxForAxis = Math.min(this.maxFeedXY, this.maxFeedZ);
          break;
      }
      const clamped = Math.max(0.1, Math.min(maxForAxis, mmPerSec));
      return parseFloat(clamped.toFixed(1)).toString();
    }
  }

  ROOT.PostLogic.set('rml', RolandPostProcessor);
})();