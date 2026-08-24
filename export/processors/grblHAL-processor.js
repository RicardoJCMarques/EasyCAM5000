/*!
 * @file        export/processors/grblHAL-processor.js
 * @description grblHAL post-processing module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class GrblHALPostProcessor extends BasePostProcessor {
        constructor() {
            super('grblHAL', {
                label: 'grblHAL (Experimental)',
                fileExtension: '.nc',
                supportsToolChange: true,
                supportsArcCommands: true,
                supportsCannedCycles: true,
                useM6: true,
                // grblHAL supports G43 H<n> only when a tool table is
                // configured and populated. An empty table silently applies
                // offset zero, so 'none' leads - the user opts in.
                toolLengthComp: { modes: ['none', 'table'], default: 'none' },
                // 4th axis: grblHAL builds can enable A/B/C. DRAFT -
                // inverseTime stays false until G93 is confirmed on the target
                // build. False is the safe direction (feeds pass as G94 mm/min:
                // honest at the blank surface, fast at depth), so
                // 'wrapped-linear' leads until verified.
                rotary: {
                    routes: ['wrapped-linear', 'a-word'],
                    axisWords: ['A', 'B'],
                    inverseTime: false,
                    continuous: true,
                    // Starting value for a belt-driven hobby rotary. Machine
                    // Settings overrides it - this is hardware, not firmware.
                    indexDwell: 0.3
                },
                pauseAfterToolChange: true,
                arcFormat: 'IJ',
                coordinateDecimals: 3,
                feedDecimals: 0,
                spindleDecimals: 0,
                modalCommands: true,
                maxSpindleSpeed: 30000,
                maxRapidRate: 5000,
                defaults: {
                    startCode: '',
                    endCode: 'M5\nG0 X0 Y0\nM2',
                }
            });
        }
    }

    window.GrblHALPostProcessor = GrblHALPostProcessor;
})();