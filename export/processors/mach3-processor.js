/*!
 * @file        export/processors/mach3-processor.js
 * @description Mach3 post-processing module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class Mach3PostProcessor extends BasePostProcessor {
        constructor() {
            super('Mach3', {
                label: 'Mach3 (Experimental)',
                fileExtension: '.tap',
                supportsToolChange: true,
                supportsArcCommands: true,
                supportsCannedCycles: true,
                useM6: true,
                toolLengthComp: { modes: ['table', 'none'], default: 'table' },
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
                coordinateDecimals: 4,
                feedDecimals: 1,
                spindleDecimals: 0,
                modalCommands: true,
                lineNumbering: false, // To be implemented in the future
                maxSpindleSpeed: 24000,
                maxRapidRate: 5000,
                defaults: {
                    startCode: '',
                    endCode: 'M5\nG0 X0Y0\nM30',
                }
            });
        }
    }

    window.Mach3PostProcessor = Mach3PostProcessor;
})();
