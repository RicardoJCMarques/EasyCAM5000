/*!
 * @file        export/processors/marlin-processor.js
 * @description Marlin post-processing module
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

    class MarlinPostProcessor extends BasePostProcessor {
        constructor() {
            super('Marlin', {
                label: 'Marlin (Experimental)',
                fileExtension: '.gcode',
                commentStyle: 'semicolon',
                supportsToolChange: false,
                // Marlin's T word selects an EXTRUDER, not a cutter. Emitting
                // T1 here is not a no-op - it is a different command that
                // most CNC-flavoured builds will reject.
                emitsInitialTool: false,
                toolLengthComp: { modes: ['none'], default: 'none' },
                supportsArcCommands: true,
                supportsCannedCycles: false,
                // 4th axis: Marlin has no G93 and its extra-axis support is
                // build-dependent. Axis replacement (rotary on the Y driver,
                // steps/mm calibrated) is the only route worth declaring.
                rotary: {
                    routes: ['wrapped-linear'],
                    axisWords: [],
                    inverseTime: false,
                    continuous: true
                },
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 0,
                spindleDecimals: 0,
                modalCommands: false,
                maxSpindleSpeed: 255, // PWM range
                maxRapidRate: 1000,
                defaults: {
                    startCode: '',
                    endCode: 'M5\nG0 X0Y0\nM84',
                }
            });
        }

        // Read for undocumented options.useM3 flag to decide between using the Spindle (M3/M5) or a PWM Fan port (M106/M107)
        setSpindle(speed, dwell = 0, options = {}) {
            if (speed === this.currentSpindle) return null;

            const c = options.comments || {};
            this.currentSpindle = speed;
            const lines = [];

            if (speed > 0) {
                const pwmValue = Math.min(255, Math.round((speed / this.config.maxSpindleSpeed) * 255));
                const cmd = options.useM3 ? `M3 S${pwmValue}` : `M106 S${pwmValue}`;
                lines.push(this.appendComment(cmd, c.spindleStart, options));

                if (dwell > 0) {
                    lines.push(this.appendComment(`G4 P${this.formatDwell(dwell)}`, c.spindleDwell, options));
                }
            } else {
                const cmd = options.useM3 ? 'M5' : 'M107';
                lines.push(this.appendComment(cmd, c.spindleStop, options));
            }
            
            return lines.join('\n');
        }

        // Needs dwell period in miliseconds
        formatDwell(seconds) {
            return Math.round(seconds * 1000);
        }
    }

    ROOT.MarlinPostProcessor = MarlinPostProcessor;
})();