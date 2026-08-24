/*!
 * @file        export/processors/makera-processor.js
 * @description Makera (Carvera) post-processing module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    /**
     * Makera (Carvera) Post-Processor
     * 
     * Carvera runs grblHAL firmware with proprietary extensions for ATC,
     * auto-vacuum (M331/M332), collet control (M490.x), and tool probing (M491).
     * 
     * Key differences from standard GRBL:
     *   - Requires explicit M6 before first motion (firmware ignores TLO without it)
     *   - ATC: T{n} M6 triggers full drop→grab→probe cycle internally
     *   - MTC: Proprietary M-code sequence for manual collet swap + auto-probe
     *   - Auto-vacuum: M331 (on) / M332 (off) - not standard M10/M11
     *   - Program end: G28 parks at clearance position (important for ATC magazine)
     *   REVIEW - No Line Numbers, no inches either? Double check/test?
     */
    class MakeraPostProcessor extends BasePostProcessor {
        constructor() {
            super('Makera', {
                label: 'Makera (Carvera) (Experimental)',
                fileExtension: '.cnc',
                supportsToolChange: true,
                supportsArcCommands: true,
                supportsCannedCycles: false,
                initialToolUsesM6: true,
                // Carvera's MTC probes every tool against the fixed setter
                // (M491) and ATC probes internally on M6. Both own Z; a G43
                // over a probed offset double-applies it.
                toolLengthComp: { modes: ['probe', 'none'], default: 'probe' },
                // 4th axis: the Carvera rotary (A) exists, but its firmware's
                // feed handling for mixed X/A moves is UNVERIFIED and no G93 is
                // documented - inverseTime stays false and 'wrapped-linear'
                // leads. Confirm against the machine before promoting a-word.
                rotary: {
                    routes: ['wrapped-linear', 'a-word'],
                    axisWords: ['A'],
                    inverseTime: false,
                    continuous: true,
                    indexDwell: 0.3   // belt rotary; overridden in Machine Settings
                },
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 1,
                spindleDecimals: 0,
                modalCommands: true,
                maxSpindleSpeed: 24000,
                maxRapidRate: 3000,
                defaults: {
                    startCode: '',
                    // generateFooter() emits the full M5 → retract → G28 park → M30
                    // sequence itself. A default endCode here would run AFTER G28 and
                    // drive the machine back out of the ATC park position.
                    endCode: '', // Instead of - endCode: 'M5\nG0 X0Y0\nM2', 
                },
                customParameters: [
                    {
                        key: 'makeraToolChangeMode',
                        label: 'Tool Change Mode',
                        type: 'select',
                        category: 'machine',
                        options: [
                            { value: 'atc', label: 'Automatic (ATC)' },
                            { value: 'manual', label: 'Manual (MTC)' }
                        ],
                        default: 'atc'
                    }
                ],
            });
        }

        generateHeader(options) {
            const lines = [];
            // Comment block
            const c = options.comments || {};
            if (options.includeComments && options.commentBlock) {
                options.commentBlock.forEach(line => {
                    lines.push(this.formatComment(line, options));
                });
                lines.push('');
            }

            // Modal state
            this.modalState.units = (options.units === 'in') ? 'G20' : 'G21';
            this.outputScale = (options.units === 'in') ? (1 / 25.4) : 1.0;
            lines.push(this.modalState.coordinateMode);
            lines.push(this.modalState.units);
            lines.push(this.modalState.plane);
            lines.push(this.modalState.feedRateMode);
            lines.push('');

            // REVIEW - Dead Code?
            // lines.push(this.appendComment(`T${initialTool} M6`, c.initialTool, options));
            // const initialTool = options.toolNumber || 1;
            // lines.push('');


            // Peripherals
            if (options.coolant === 'mist') lines.push(this.appendComment('M7', c.coolantMist, options));
            else if (options.coolant === 'flood') lines.push(this.appendComment('M8', c.coolantFlood, options));
            if (options.vacuum) lines.push(this.appendComment('M331', c.vacuumOn, options));

            // User start code (extras from settings textarea)
            if (options.startCode && options.startCode.trim()) {
                lines.push(options.startCode);
            }

            return lines.join('\n');
        }

        generateFooter(options) {
            const lines = [''];
            const c = options.comments || {};

            lines.push(this.appendComment('M5', c.spindleStop, options));
            if (options.coolant && options.coolant !== 'none') lines.push(this.appendComment('M9', c.coolantOff, options));
            if (options.vacuum) lines.push(this.appendComment('M332', c.vacuumOff, options));

            const safeZ = this.formatCoordinate(options.safeZ || this.config.safetyHeight);
            lines.push(this.appendComment(`G0 Z${safeZ}`, c.retractSafeZ, options));

            // Park at clearance position - critical for ATC magazine access
            lines.push(this.appendComment('G28', c.parkClearance, options));

            // User end code (extras from settings textarea)
            if (options.endCode && options.endCode.trim()) {
                lines.push(options.endCode);
            }

            lines.push('M30');
            return lines.join('\n');
        }

        toolChangeSwap(toolNumber, options) {
            const c = options.comments || {};
            const lines = [];
            const isManual = options.makeraToolChangeMode === 'manual';

            // ATC - Carvera handles drop, grab, and probe internally on M6
            if (!isManual) {
                lines.push(this.appendComment(`T${toolNumber} M6`,
                    c.autoToolChange || 'Auto tool change', options));
                return lines;
            }

            // MTC - Proprietary Makera sequence for manual collet swap with automatic tool length probing.
            // M27      - Move to park/tool-change position
            // M600     - Pause execution, wait for user
            // M490.2   - Open collet (pneumatic release)
            // M490.1   - Close collet (pneumatic grip)
            // M493.2   - Set internal calibration state flag
            // M491     - Execute automatic tool length measurement
            lines.push(this.appendComment('G28',
                c.mtcClearance || 'Move to tool change clearance', options));
            lines.push('M27');
            lines.push(this.appendComment('M600',
                c.mtcRelease || 'Paused. Press Play to release collet.', options));
            lines.push('M490.2');
            lines.push('M27');
            lines.push(this.appendComment('M600',
                c.mtcInsert || 'Paused. Insert tool and press Play to close.', options));
            lines.push('M490.1');
            lines.push(this.appendComment(`M493.2 T${toolNumber}`,
                c.mtcCalibState || 'Set memory state for calibration', options));
            lines.push(this.appendComment('M491',
                c.mtcCalibRun || 'Execute Tool Length Calibration', options));

            // G28 homes and M27 parks - all three axes are somewhere this
            // post's tracker does not know. null forces _motionCoords to
            // re-emit every word on the next move (it treats null/undefined
            // as "changed"); leaving stale numbers here silently suppresses
            // an axis word on the first rapid after the change.
            // REVIEW - Would it be safer to add a safety Zheight movement to XY before plunging down? Splitting this movement to avoid crashed during a straight line to the previous/next position?
            this.currentPosition = { x: null, y: null, z: null, a: null };
            return lines;
        }

        generateInitialTool(tool, options = {}) {
            const n = tool?.number ?? options.toolNumber ?? 1;
            this.currentToolNumber = n;
            // Carvera firmware ignores TLO without an M6 before first motion.
            // The ATC/MTC branch belongs to a CHANGE; the initial load is the
            // bare selection either way.
            return `M6 T${n}`;
        }
    }

    window.MakeraPostProcessor = MakeraPostProcessor;
})();