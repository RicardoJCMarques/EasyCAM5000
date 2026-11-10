/*!
 * @file        export/processors/makera-processor.js
 * @description Makera (Carvera) post-processing main logic module
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
   * Makera (Carvera) Post-Processor
   * Carvera runs grblHAL firmware with proprietary extensions for ATC,
   * auto-vacuum (M331/M332), collet control (M490.x), and tool probing (M491).
   * Key differences from standard GRBL:
   *  Requires explicit M6 before first motion (firmware ignores TLO without it)
   *  ATC: T{n} M6 triggers full drop→grab→probe cycle internally
   *  MTC: Proprietary M-code sequence for manual collet swap + auto-probe
   *  Auto-vacuum: M331 (on) / M332 (off) - not standard M10/M11
   *  Program end: G28 parks at clearance position (important for ATC magazine)
   */
  class MakeraPostProcessor extends BasePostProcessor {
    static parameters = [
      {
        name: 'makeraToolChangeMode',
        type: 'select',
        category: 'machine',
        options: [{ value: 'atc' }, { value: 'manual' }],
        default: 'atc',
      },
      ...BasePostProcessor.parameters,
    ];

    generateFooter(options) {
      const endCode = this.endBlock(options);
      const lines = ['', ...this.peripheralsOff(options, endCode)];
      lines.push(this.appendComment(`G0 Z${this.formatZ(this.above(options.safeZ))}`, 'comments.retractSafeZ', options));
      // Park at clearance position - critical for ATC magazine access
      lines.push(this.appendComment('G28', 'comments.parkClearance', options));
      if (endCode.trim()) lines.push(endCode);
      lines.push(...this.programEnd(endCode));
      return lines.join('\n');
    }

    vacuumWords() {
      return { on: 'M331', off: 'M332' };
    }

    toolChangeSwap(toolNumber, options) {
      const lines = [];
      const isManual = options.makeraToolChangeMode === 'manual';
      // ATC - Carvera handles drop, grab, and probe internally on M6
      if (!isManual) {
        lines.push(this.appendComment(`T${toolNumber} M6`, 'comments.makera.autoToolChange', options));
        return lines;
      }
      // MTC - Proprietary Makera sequence for manual collet swap with automatic tool length probing.
      // M27 - Move to park/tool-change position
      // M600 - Pause execution, wait for user
      // M490.2 - Open collet (pneumatic release)
      // M490.1 - Close collet (pneumatic grip)
      // M493.2 - Set internal calibration state flag
      // M491 - Execute automatic tool length measurement
      lines.push(this.appendComment('G28', 'comments.makera.mtcClearance', options));
      lines.push('M27');
      lines.push(this.appendComment('M600', 'comments.makera.mtcRelease', options));
      lines.push('M490.2');
      lines.push('M27');
      lines.push(this.appendComment('M600', 'comments.makera.mtcInsert', options));
      lines.push('M490.1');
      lines.push(this.appendComment(`M493.2 T${toolNumber}`, 'comments.makera.mtcCalibState', options));
      lines.push(this.appendComment('M491', 'comments.makera.mtcCalibRun', options));
      // G28 homes and M27 parks - all three axes are somewhere this
      // post's tracker does not know. Nulling currentPosition forces
      // _motionCoords to re-emit explicit G0 Z<travelZ> before XY
      // motion in the subsequent connectionPlan.
      this.currentPosition = { x: null, y: null, z: null, a: null };
      return lines;
    }
  }

  ROOT.PostLogic.set('makera', MakeraPostProcessor);
})();