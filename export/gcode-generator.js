/*!
 * @file        export/gcode-generator.js
 * @description Complete G-code generation from toolpath plans
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
  const EPSILON = C.precision.epsilon;

  class GCodeGenerator {
    constructor(config, core, lang) {
      this.config = config;
      this.core = core;
      this.lang = lang;
      // Built posts and the setups they came from, by setup id, in
      // registration order: constants.setups first, then custom setups.
      this.processors = new Map();
      this.setups = new Map();
      this.currentProcessor = null;
      this.lastWarnings = [];
      this.limitWarnings = new Map(); // the program in progress's limit warnings, one per key with its count
      this.lastToolChangeCount = 0; // swaps the last program made, for the export preview
      this.untransformedPosition = { x: 0, y: 0, z: 0 };
    }

    /**
     * Builds a setup with the logic it names and registers it under its
     * id; the same id again replaces it.
     * @param {Object} setup - a shipped setup file, or a custom one
     * @returns {BasePostProcessor|RolandPostProcessor}
     */
    register(setup) {
      const Logic = ROOT.PostLogic.get(setup.logic);
      if (!Logic) throw new Error(`[GCodeGenerator] Setup '${setup.id}' names logic '${setup.logic}', which this page does not load`);
      const post = new Logic(setup);
      this.setups.set(setup.id, setup);
      this.processors.set(setup.id, post);
      return post;
    }

    /** Takes a custom setup out of use (CustomFiles.remove). */
    unregister(id) {
      this.setups.delete(id);
      this.processors.delete(id);
    }

    /**
     * Lookup by setup id. An unknown id is already a supported answer -
     * every caller either guards or wants the null from getProcessorInfo.
     */
    getProcessor(id) {
      return this.processors.get(id);
    }

    /** Returns the full descriptor for a registered processor. */
    getProcessorInfo(id) {
      return this.processors.get(id)?.descriptor ?? null;
    }

    /** Returns descriptors for all registered processors. */
    getAllProcessorDescriptors() {
      return [...this.processors.values()].map((p) => p.descriptor);
    }

    /**
     * Capability gates for profile <option>s. Indexed 3+1 needs the real
     * word for the machine's rotary axis (A about X, B about Y). A pinned
     * route other than 'a-word' - set by the operator or locked by the
     * setup - says the rotary is wired as axis replacement, and the two
     * cannot coexist on one machine. An unpinned route is only the setup's
     * default, which buildPipelineContext promotes to 'a-word' for an
     * indexed operation, so gating on it would disable indexed on every
     * setup that defaults to wrapped-linear.
     * @param {Object} settings - CamCore.settings
     * @param {boolean} routePinned
     */
    getOptionGates(settings, routePinned) {
      const desc = this.getProcessorInfo(settings.gcode.postProcessor);
      const rotary = desc.capabilities.rotary;
      const word = settings.gcode.rotaryAxis === 'y' ? 'B' : 'A';
      const hasWord = rotary.routes.includes('a-word') && rotary.axisWords.includes(word);
      const pinnedElsewhere = routePinned && settings.gcode.rotaryRoute !== 'a-word';
      return {
        'rotary.indexed': {
          ok: hasWord && !pinnedElsewhere,
          reason: hasWord
            ? { key: 'messages.export.routeIsReplacement' }
            : { key: 'messages.export.noRotaryWord', values: { post: desc.label, word, axis: word === 'B' ? 'Y' : 'X' } },
        },
      };
    }

    generate(toolpathPlans, options) {
      // No plans, no program: the caller omits the file and says so.
      if (toolpathPlans.length === 0) return '';
      // Rotary developed-space plans: y is an unwound arc, not a machine
      // Y. Reaching here means MachineProcessor neither converted nor
      // dropped them - a routing bug, not a user error.
      if (toolpathPlans.some((p) => p.metadata?.developedSpace)) {
        throw new Error('Rotary plans reached the post unconverted - MachineProcessor did not resolve an export route.');
      }
      // Rotary output is metric-only for now. A words must never be
      // rescaled by G20, and under 'a-linear'/'wrapped-linear' the arc
      // travel rides a word whose unit is a machine-side calibration.
      // Refuse rather than emit a plausible-looking wrong program.
      if (options.units === 'inch' && toolpathPlans.some((p) => p.metadata?.rotaryAxisWord)) {
        throw Object.assign(
          new Error('Rotary (4th-axis) export requires metric units. Switch the G-code units to mm.'),
          {i18n: {key: 'messages.export.rotaryNeedsMetric'}}
        );
      }
      const processorName = options.postProcessor;
      this.currentProcessor = this.getProcessor(processorName);
      if (!this.currentProcessor) {
        throw Object.assign(
          new Error(`Post-processor '${processorName}' not found`),
          {i18n: {key: 'messages.export.postNotFound', values: {post: processorName}}}
        );
      }
      const caps = this.currentProcessor.descriptor.capabilities;
      this.currentProcessor.resetState();
      this.lastWarnings = [];
      this.limitWarnings = new Map();
      this.untransformedPosition = { x: 0, y: 0, z: 0 };
      // Shallow clone
      options = { ...options };
      // File text is English whatever the interface language. Controls read comments as
      // ASCII, and folding to it (BasePostProcessor.sanitizeComment) leaves a non-Latin
      // pack's comments with no words at all; one language also keeps a program reading the
      // same for whoever opens it later - another operator, a forum, a support request.
      // Names stay as written, folded.
      options.text = (key, values = null) => this.lang.english(`output.gcode.${key}`, values);
      // Absolute Z0: the control's Z0 is fixed - the bed - rather than
      // touched off. Nothing may run below it, and a 4th-axis program,
      // whose Z is measured from the rotation centerline, is lifted by
      // the axis height as one datum for the whole program.
      // TODO(absolute-z) - Carry the Z frame per plan through the
      // pipeline. Until a plan says which frame its Z is in, a flat job
      // needs zeroReference 'bed' (the floor refuses the rest), and a
      // program mixing flat and 4th-axis work, or wrapped-linear's
      // blank-surface frame, is refused rather than guessed.
      let zDatum = 0;
      if (options.absoluteZ) {
        const refuse = (key) => {
          throw Object.assign(
            new Error(`[GCodeGenerator] ${key}`),
            {i18n: {key: `messages.export.${key}`}}
          );
        };
        const cutting = toolpathPlans.filter((p) => p.metadata?.synthetic !== true);
        const rotary = cutting.filter((p) => p.metadata?.rotaryAxisWord);
        if (cutting.some((p) => p.metadata?.refRadius > 0 && !p.metadata.rotaryAxisWord)) refuse('absoluteZWrapped');
        if (rotary.length > 0) {
          if (rotary.length < cutting.length) refuse('absoluteZFrames');
          if (!(options.rotaryAxisHeight > 0)) refuse('absoluteZHeight');
          zDatum = options.rotaryAxisHeight;
        }
      }
      this.currentProcessor.zDatum = zDatum;
      this.currentProcessor.zFloor = options.absoluteZ ? 0 : null;
      // The first height the program rapids to, in its own frame - above
      // the rotation centerline on a 4th-axis program, where safe Z alone
      // sits inside the blank. A swap before any motion (Fanuc's first
      // G43 H Z) comes down to it.
      const firstZ = toolpathPlans.find((p) => p.operationId === 'init')?.commands.find((cmd) => cmd.z != null)?.z;
      options.startZ = Math.max(options.safeZ, firstZ ?? options.safeZ);
      const output = [];
      if (options.includeComments && caps.supportsComments) {
        const text = options.text;
        const opIds = [...new Set(toolpathPlans.map((p) => p.operationId))];
        const operations = opIds.map((id) => this.core.store.getOperation(id)).filter(Boolean);
        // Verbose comments: under each operation, the values its cut ran with (CamCore hands
        // them over from the batch's contexts) and the deepest Z it reaches in this program.
        const notes = options.operationNotes;
        const deepest = new Map();
        if (notes) {
          for (const plan of toolpathPlans) {
            if (plan.metadata?.synthetic) continue;
            let z = deepest.get(plan.operationId) ?? Infinity;
            for (const cmd of plan.commands) if (cmd.z != null && cmd.z < z) z = cmd.z;
            deepest.set(plan.operationId, z);
          }
        }
        const verbose = id => {
        const note = notes?.get(id);
        if (!note) return [];
        const { tool, cutting, strategy, drillTable, metadata } = note;
        const lines = [];
        const feeds = (feed, plunge, spindle) => {
          if ([feed, plunge, spindle].every(Number.isFinite)) lines.push(text('comments.verbose.feeds', { feed, plunge, spindle }));
        };
        if (tool.cutsWithOwnTool) {
          if (tool.number != null && Number.isFinite(tool.diameter)) {
            lines.push(tool.name
              ? text('comments.verbose.tool', { number: tool.number, name: tool.name, diameter: tool.diameter })
              : text('comments.verbose.toolUnnamed', { number: tool.number, diameter: tool.diameter }));
          }
          feeds(cutting.feedRate, cutting.plungeRate, cutting.spindleSpeed);
        } else {
          // A multi-tool drill cuts only with its rows' bits; a row's null feed keeps the operation's.
          for (const row of Object.values(drillTable?.rows ?? {})) {
            if (row.strategy === 'skip') continue;
            lines.push(text(`comments.verbose.${row.slots > 0 ? 'slotRow' : 'drillRow'}`, {
              size: row.diameter,
              number: tool.drillNumbers[row.key],
              diameter: row.toolDiameter > 0 ? row.toolDiameter : row.diameter
            }));
            feeds(
              row.cutting?.feedRate ?? cutting.feedRate,
              row.cutting?.plungeRate ?? cutting.plungeRate,
              row.cutting?.spindleSpeed ?? cutting.spindleSpeed
            );
          }
        }
        // Unsigned: EasyTrace stores depths negative, EasyShape positive.
        if (Number.isFinite(strategy.cutDepth)) {
          const depth = Math.abs(strategy.cutDepth);
          const step = Math.abs(strategy.depthPerPass);
          lines.push(strategy.multiDepth && step > 0
            ? text('comments.verbose.depth', { depth, step })
            : text('comments.verbose.depthOnce', { depth }));
        }
        if (Number.isFinite(strategy.stepOver)) lines.push(text('comments.verbose.stepOver', { stepOver: strategy.stepOver }));
        // 3D results: the stepover each pass ran with.
        if (metadata?.roughStepover > 0) lines.push(text('comments.verbose.roughStepover', { stepOver: metadata.roughStepover }));
        if (metadata?.finishStepover > 0) lines.push(text('comments.verbose.finishStepover', { stepOver: metadata.finishStepover }));
        const z = deepest.get(id);
        if (Number.isFinite(z)) lines.push(text('comments.verbose.deepest', { z: Number((z + zDatum).toFixed(3)) }));
        return lines;
      };
        // ISO 8601 local time: files never follow the browser locale.
        const now = new Date();
        const stamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
        const commentBlock = [
          text('comments.header'),
          text('comments.date', { date: stamp }),
          // A custom post says so: what it writes is not what a shipped post writes.
          text(this.currentProcessor.descriptor.maturity === 'custom' ? 'comments.processorCustom' : 'comments.processor', {
            processor: this.currentProcessor.descriptor.label,
          }),
          text('comments.separator'),
          text('comments.operationCount', { count: operations.length }),
          ...operations.flatMap((op) => [
            text('comments.operationEntry', {
              type: { key: `ops.${op.type}.short` },
              file: op.sourceLabel || op.file?.name || op.id,
            }),
            ...verbose(op.id),
          ]),
          text('comments.separator'),
        ];
        // 4th-axis frame disclosure. A wrong Z touch-off on a rotary
        // job cuts the antipode of the part - say the reference out
        // loud in the header. Under absolute Z0 there is nothing to
        // touch off: the line says where the centerline sits instead.
        const rotPlan = toolpathPlans.find((p) => p.metadata?.rotaryAxisWord);
        if (rotPlan) {
          const rm = rotPlan.metadata;
          const absoluteZero = zDatum > 0 ? text('comments.rotaryAbsoluteZero', { height: zDatum.toFixed(3) }) : null;
          // [INDEXED] rotPlan may be the injected index link (no
          // indexedA on it), so detect across the batch.
          const isIndexed = toolpathPlans.some((p) => p.metadata?.indexedA != null);
          if (isIndexed) {
            const faces = [...new Set(toolpathPlans.map((p) => p.metadata?.indexedA).filter((a) => a != null))];
            const apo = toolpathPlans.map((p) => p.metadata?.indexedApothem).find((v) => v != null) || 0;
            commentBlock.push(
              text('comments.rotaryIndexed', {
                word: rm.rotaryAxisWord,
                faces: { list: faces.map((a) => a.toFixed(1)), type: 'unit' },
              }),
              absoluteZero ?? text('comments.rotaryIndexedZero', { apothem: apo.toFixed(3) }),
            );
          } else {
            commentBlock.push(
              text('comments.rotaryWrapped', {
                word: rm.rotaryAxisWord,
                units: {
                  key:
                    rm.rotaryUnits === 'mm'
                      ? 'output.gcode.comments.rotaryUnitsArc'
                      : 'output.gcode.comments.rotaryUnitsDegrees',
                },
              }),
              absoluteZero ?? text('comments.rotaryWrappedZero', { radius: (rm.refRadius || 0).toFixed(3) }),
            );
          }
          // TODO(zzero-workoffset) - emit the apothem as a work offset (G10 L2 or
          // G92, per-post capability) instead of having the operator dial it into
          // Z0. Blocked on a guaranteed cancel path and per-post bench tests: both
          // are modal state, and an abort before the cancel leaves a wrong origin.
          // Absolute Z0 machines take the axis height instead (zDatum above).
          commentBlock.push(text('comments.separator'));
        }
        options.commentBlock = commentBlock;
      }
      // First operational plan for the header's feed setup. Synthetic
      // plans (init/connection/entry/plunge/retract/final/index) carry no
      // cutting parameters; MachineProcessor stamps metadata.synthetic on each.
      options.firstPlan = toolpathPlans.find((p) => p.metadata?.synthetic !== true) || toolpathPlans[0];
      // Tool state. Resolved BEFORE the header, so the {toolNumber}
      // placeholder in the start block gets a real value.
      const enableToolChanges = options.toolChanges === true && caps.supportsToolChange;
      const firstTool = toolpathPlans.find((p) => p.metadata?.tool?.number > 0)?.metadata.tool || null;
      if (options.toolNumber == null && firstTool) options.toolNumber = firstTool.number;
      let toolChangeCount = 0;
      // Router operations carry a T word; laser and knife/vector do not.
      // A post that declares emitsInitialTool with nothing resolved means
      // no router operation reached here - the program has no T word and a
      // control that needs one will refuse to move. Rendered by the export
      // modal's warning panel.
      if (caps.emitsInitialTool && !firstTool) this.lastWarnings.push({ key: 'messages.export.noToolNumber' });
      // Generate header
      output.push(this.currentProcessor.generateHeader(options));
      // Initial tool selection, before any motion. Grbl-family controls
      // refuse to move without one; changer-equipped controls must be
      // told to LOAD the first tool rather than assume it.
      const initialTool = this.currentProcessor.generateInitialTool(firstTool, options);
      if (initialTool) output.push(initialTool);
      // Find init plan and process it first (safety height before spindle)
      const initPlanIndex = toolpathPlans.findIndex(p => p.operationId === 'init');
      if (initPlanIndex !== -1) {
        const initPlan = toolpathPlans[initPlanIndex];
        for (const cmd of initPlan.commands) {
          const gcode = this.currentProcessor.processCommand(cmd);
          if (gcode) output.push(gcode);
          // Update untransformed position tracking
          if (cmd.x !== null && cmd.x !== undefined) this.untransformedPosition.x = cmd.x;
          if (cmd.y !== null && cmd.y !== undefined) this.untransformedPosition.y = cmd.y;
          if (cmd.z !== null && cmd.z !== undefined) this.untransformedPosition.z = cmd.z;
        }
      }
      // Handle initial spindle command (after safety height)
      const firstPlanWithSpindle = toolpathPlans.find(p => p.metadata?.spindleSpeed > 0);
      if (firstPlanWithSpindle) {
        const spindle = firstPlanWithSpindle.metadata.spindleSpeed;
        const dwell = firstPlanWithSpindle.metadata.spindleDwell || 0;
        const spindleGcode = this.currentProcessor.setSpindle(spindle, dwell, options);
        if (spindleGcode) output.push(spindleGcode);
      }
      // Coolant follows the spindle, here as after every tool change; the
      // operator's start block may switch it already.
      if (caps.supportsCoolant) {
        const coolant = this.currentProcessor.coolantOn(options, options.startCode);
        if (coolant) output.push(coolant);
      }
      // Machine limits every command is validated against.
      const validationOptions = { maxFeed: options.maxFeed, maxSafeDepth: options.maxSafeDepth };
      let inCannedCycle = false;
      // Process remaining plans
      for (let i = 0; i < toolpathPlans.length; i++) {
        // Only skip the specific init plan index processed manually.
        // Do not skip plans by ID, as subsequent operations also have 'init' plans.
        if (i === initPlanIndex) continue;
        const plan = toolpathPlans[i];
        const metadata = plan.metadata || {};
        // Tool transition. Mirrors the spindle logic directly below.
        // MachineProcessor's backward fill puts the incoming tool on
        // the connection rapid and the entry plunge, so this fires on
        // the approach - not on the cutting plan, which would swap
        // with the machine already at depth holding the old cutter.
        const planTool = metadata.tool;
        if (enableToolChanges && planTool && planTool.number > 0
          && planTool.number !== this.currentProcessor.currentToolNumber) {
          // The change block contains motion (retract, and G43 H..
          // Z.. on table posts). Under a G93 left modal by a
          // preceding rotary plan those blocks carry no F and fault.
          const fm = this.currentProcessor.setFeedRateMode('G94', options);
          if (fm) output.push(fm);
          const tcGcode = this.currentProcessor.generateToolChange(planTool, options);
          if (tcGcode) {
            output.push(tcGcode);
            toolChangeCount++;
          }
        }
        // 4th-axis per-plan modal state. Both must be set BEFORE any
        // command of this plan is formatted:
        //  rotaryAxisWord - which word carries cmd.a ('A'|'B'), or
        //   null so a 3-axis plan can't leak one.
        //  feed mode - inverse time (G93) only over plans that carry
        //   converted durations; links and retracts stay G94.
        this.currentProcessor.rotaryAxisWord = metadata.rotaryAxisWord || null;
        const fm = this.currentProcessor.setFeedRateMode(metadata.rotaryInverseTime ? 'G93' : 'G94', options);
        if (fm) output.push(fm);
        // Handle spindle speed changes mid-job
        const spindle = metadata.spindleSpeed;
        if (spindle !== undefined && spindle !== this.currentProcessor.currentSpindle) {
          const dwell = metadata.spindleDwell || 0;
          const spindleGcode = this.currentProcessor.setSpindle(spindle, dwell, options);
          if (spindleGcode) output.push(spindleGcode);
        }
        // Process commands
        for (const cmd of plan.commands) {
          const startPosForTransform = { ...this.untransformedPosition };
          // Check modal transitions for Canned Cycles
          const isCannedCmd = (cmd.type === 'CANNED_SIMPLE' || cmd.type === 'CANNED_PECK');
          if (inCannedCycle && !isCannedCmd) {
            // Transitioning out of canned cycle, issue G80
            const cancelCode = this.currentProcessor.cancelCannedCycle(options);
            if (cancelCode) output.push(cancelCode);
            inCannedCycle = false;
          } else if (isCannedCmd) {
            inCannedCycle = true;
          }
          let commandsToProcess = [cmd];
          // Linearize arcs if processor doesn't support them
          if ((cmd.type === 'ARC_CW' || cmd.type === 'ARC_CCW') &&
            !this.currentProcessor.config.supportsArcCommands) {
            const radius = Math.hypot(cmd.i || 0, cmd.j || 0);
            const baseResolution = options.arcResolution || 0.1;
            const adaptiveResolution = radius < 2 ? baseResolution * 0.5 : radius > 10 ? baseResolution * 2 : baseResolution;
            commandsToProcess = this.linearizeArc(cmd, startPosForTransform, adaptiveResolution);
          }
          // Process each command/segment
          for (const commandToProcess of commandsToProcess) {
            const validation = this.currentProcessor.validateCommand(commandToProcess, validationOptions);
            if (validation.errors && validation.errors.length > 0) {
              // Hard abort. This bubbles up to your UI try/catch block.
              throw Object.assign(
                new Error(`Validation failed: ${validation.errors.map(e => e.key).join(' | ')}`),
                {i18n: {key: 'messages.export.validationFailed', values: {errors: validation.errors}}}
              );
            }
            if (validation.warnings && validation.warnings.length > 0) {
              // Per command: each kind is kept once with its count, or a
              // relief pass past the depth limit repeats it on every move.
              for (const w of validation.warnings) {
                const seen = this.limitWarnings.get(w.key);
                if (seen) seen.count++;
                else this.limitWarnings.set(w.key, { warning: w, count: 1 });
              }
            }
            const gcode = this.currentProcessor.processCommand(commandToProcess);
            if (gcode) output.push(gcode);
            // Update untransformed position to end of segment
            if (commandToProcess.x !== null && commandToProcess.x !== undefined) this.untransformedPosition.x = commandToProcess.x;
            if (commandToProcess.y !== null && commandToProcess.y !== undefined) this.untransformedPosition.y = commandToProcess.y;
            if (commandToProcess.z !== null && commandToProcess.z !== undefined) this.untransformedPosition.z = commandToProcess.z;
          }
        }
      }

      // Cancel canned cycle if it was the last operation before footer
      if (inCannedCycle) {
        const cancelCode = this.currentProcessor.cancelCannedCycle(options);
        if (cancelCode) output.push(cancelCode);
      }

      // Never leave G93 modal into the footer/end code - its G0 X0Y0
      // would be fine, but any later G1 without an F would fault.
      const fm = this.currentProcessor.setFeedRateMode('G94', options);
      if (fm) output.push(fm);

      output.push(this.currentProcessor.generateFooter(options));

      const program = output.join('\n');

      // One warning per kind, worded with the first offending move and
      // the count. Rendered by the export modal's warning panel.
      for (const { warning, count } of this.limitWarnings.values()) {
        this.lastWarnings.push({ key: warning.key, values: { ...warning.values, count } });
      }

      const capped = this.currentProcessor.spindleCapped;
      if (capped) {
        this.lastWarnings.push({
          key: 'messages.export.spindleCapped',
          values: { rpm: capped, max: this.currentProcessor.config.maxSpindleSpeed, post: this.currentProcessor.descriptor.label }
        });
      }

      // Final numeric audit. formatNumberSafe stops a non-finite word at
      // the source, but two routes bypass it: a post that formats its own
      // coordinates (Roland), and every {safeZ}/{travelZ}/{toolNumber}
      // token substituted into user start/end code. Both reach the file as
      // text. A dropped word is equally unsafe - the control holds its
      // last value and the move goes somewhere the operator did not ask
      // for - so a non-zero fault count refuses too.
      const faults = this.auditProgram(program);
      if (faults.length > 0) {
        throw Object.assign(
          new Error(`Export refused - non-numeric value in the program (${faults.length} line(s))`),
          {i18n: {key: 'messages.export.nonNumeric', values: {faults}}}
        );
      }
      if (this.currentProcessor.numericFaults > 0) {
        throw Object.assign(
          new Error(`Export refused - ${this.currentProcessor.numericFaults} non-finite word(s) dropped`),
          {i18n: {key: 'messages.export.droppedWords', values: {count: this.currentProcessor.numericFaults}}}
        );
      }

      // Read by runCNCPipeline for the export preview: the operator
      // decides whether the count justifies grouping by tool. The
      // software does not reorder their list to reduce it on its own.
      this.lastToolChangeCount = toolChangeCount;
      return this.currentProcessor.applyLineNumbers(program, options);
    }

    /**
     * Refuses a program containing a NaN, Infinity, undefined or null word,
     * glued to its letter (XNaN, RML's !VZNaN;) or not. Case-sensitive, as
     * JavaScript prints them, so a word such as "Ronan" in an M117 message
     * passes. Comment stripping is per line, so `(null)` in an operator note
     * is not a fault - which is why this cannot be one regex over the whole
     * string. The whole-string test is a gate, not the test: a clean 30MB
     * program never allocates the line array.
     */
    auditProgram(program) {
      const BAD = /(?:NaN|Infinity|undefined|null)\b/;
      if (!BAD.test(program)) return [];
      const faults = [];
      const lines = program.split('\n');
      for (let i = 0; i < lines.length && faults.length < 5; i++) {
        const code = lines[i].replace(/\([^)]*\)/g, '').split(';')[0];
        if (BAD.test(code)) faults.push({ key: 'messages.export.faultLine', values: { line: i + 1, text: lines[i].trim() } });
      }
      return faults;
    }

    linearizeArc(cmd, startPos, resolution = 1.0) {
      const linearizedCmds = [];
      const start = {
        x: startPos.x,
        y: startPos.y,
        z: startPos.z
      };
      const hasZ = cmd.z !== null && cmd.z !== undefined;
      const end = {
        x: (cmd.x !== null && cmd.x !== undefined) ? cmd.x : start.x,
        y: (cmd.y !== null && cmd.y !== undefined) ? cmd.y : start.y,
        z: hasZ ? cmd.z : start.z
      };
      const center = {
        x: start.x + (cmd.i || 0),
        y: start.y + (cmd.j || 0)
      };
      const radius = Math.hypot(cmd.i || 0, cmd.j || 0);
      if (radius < EPSILON) return [new MotionCommand('LINEAR', { x: end.x, y: end.y, z: hasZ ? end.z : null }, { feed: cmd.f })];
      const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
      const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
      const dist = Math.hypot(start.x - end.x, start.y - end.y);
      // Shared normalizer
      const sweep = ToolpathPlan.normalizeArcSweep({
        startAngle,
        endAngle,
        clockwise: cmd.type === 'ARC_CW',
        chord: dist,
        radius,
        eps: EPSILON
      });
      const arcLength = Math.abs(sweep) * radius;
      const segments = Math.max(2, Math.ceil(arcLength / resolution));
      const angleStep = sweep / segments;
      const zStep = hasZ ? (end.z - start.z) / segments : 0;
      for (let i = 1; i <= segments; i++) {
        const angle = startAngle + i * angleStep;
        const nextX = (i === segments) ? end.x : (center.x + radius * Math.cos(angle));
        const nextY = (i === segments) ? end.y : (center.y + radius * Math.sin(angle));
        const nextZ = hasZ ? ((i === segments) ? end.z : (start.z + i * zStep)) : null;
        linearizedCmds.push(new MotionCommand('LINEAR',
          { x: nextX, y: nextY, z: nextZ },
          { feed: cmd.f }
        ));
      }
      return linearizedCmds;
    }
  }

  ROOT.GCodeGenerator = GCodeGenerator;
})();