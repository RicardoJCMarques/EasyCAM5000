/*!
 * @file        export/processors/grbl-processor.js
 * @description GRBL post-processing module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class GRBLPostProcessor extends BasePostProcessor {
        constructor() {
            super('GRBL', {
                label: 'Grbl',
                fileExtension: '.nc',
                supportsToolChange: false, // REVIEW - Consider a manual tool change macro. Stops spindle, goes to origin, raises Z, allows change, probe? raise again, finally allows resume? Makera has a similar system?
                supportsArcCommands: true,
                supportsCannedCycles: false,
                // 4th axis: classic Grbl 1.1 is strictly XYZ - no A word, no
                // G93. It still runs rotary work by axis replacement: wire the
                // rotary to the Y driver and set $101 so 1 "mm" of Y is 1mm of
                // arc at the reference radius. That IS 'wrapped-linear' - the
                // developed strip needs no conversion whatsoever.
                rotary: {
                    routes: ['wrapped-linear'],
                    axisWords: [],
                    inverseTime: false,
                    continuous: true
                },
                useM6: false,
                supportsToolLengthComp: false,
                pauseAfterToolChange: false,
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 0,
                spindleDecimals: 0,
                modalCommands: true,
                maxSpindleSpeed: 30000,
                maxRapidRate: 2000,
                defaults: {
                    startCode: 'T1\n',
                    endCode: 'M5\nG0 X0Y0\nM2',
                }
            });
        }
    }

    window.GRBLPostProcessor = GRBLPostProcessor;
})();