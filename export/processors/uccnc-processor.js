/*!
 * @file        export/processors/uccnc-processor.js
 * @description UCCNC post-processing module
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
     * UCCNC Post-Processor
     *
     * Targets machines running UCCNC control software (cncdrive.com).
     * UCCNC is a Mach3-compatible controller with its own extensions.
     *
     * Key characteristics:
     *   - Standard G-code with parenthesis-style comments
     *   - G64 constant velocity / path blending mode
     *   - Full canned drilling cycles (G81, G82, G83, G73)
     *   - Tool change via T M6 with G43 Hxx tool length compensation
     *   - Dwell (G4 P) in MILLISECONDS (not seconds)
     *   - M30 program end with rewind
     *   - Helical arcs supported, XY plane (G17) circular interpolation
     */
    class UCCNCPostProcessor extends BasePostProcessor {
        constructor() {
            super('UCCNC', {
                label: 'UCCNC (Experimental)',
                fileExtension: '.nc',
                commentStyle: 'parenthesis',
                supportsToolChange: true,
                supportsArcCommands: true,
                supportsCannedCycles: true,
                useM6: true,
                supportsToolLengthComp: true,
                // 4th axis: drives A/B/C and supports G93 inverse time. DRAFT -
                // verify G93 on your build, and confirm the axis is configured
                // ROTATIONAL (degrees) rather than linear, or 'a-word' degrees
                // will be read as millimetres.
                rotary: {
                    routes: ['a-word', 'wrapped-linear'],
                    axisWords: ['A', 'B'],
                    inverseTime: true,
                    maxInverseTime: 9999.99,
                    continuous: true,
                    indexDwell: 0.3   // drives anything; overridden in Machine Settings
                },
                pauseAfterToolChange: true,
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 1,
                spindleDecimals: 0,
                modalCommands: true,
                lineNumbering: false, // To be implemented in the future
                maxSpindleSpeed: 24000,
                maxRapidRate: 5000,
                defaults: {
                    startCode: 'G64\nT1',
                    endCode: 'M5\nG0 X0 Y0\nM30',
                }
            });
        }

        // Needs dwell period in miliseconds
        formatDwell(seconds) {
            return Math.round(seconds * 1000);
        }

        /**
         * Override: Spindle control with millisecond dwell.
         */
        setSpindle(speed, dwell = 0, options = {}) {
            if (speed === this.currentSpindle) return null;

            const c = options.comments || {};
            this.currentSpindle = speed;
            const lines = [];

            if (speed > 0) {
                lines.push(this.appendComment(`M3 S${speed}`, c.spindleStart, options));
                if (dwell > 0) {
                    const ms = Math.round(dwell * 1000);
                    lines.push(this.appendComment(`G4 P${ms}`, c.spindleDwell, options));
                }
            } else {
                lines.push(this.appendComment('M5', c.spindleStop, options));
            }

            return lines.join('\n');
        }
    }

    window.UCCNCPostProcessor = UCCNCPostProcessor;
})();