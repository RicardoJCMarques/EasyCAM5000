/*!
 * @file        export/processors/fanuc-processor.js
 * @description Fanuc variant post-processing module
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
     * Fanuc Post-Processor
     *
     * Targets Fanuc 0i-MF / 30i-class machining centres and the many
     * controls that clone their dialect.
     *
     * Differences from the GRBL-family posts that drive the overrides below:
     *   - DECIMAL POINTS ARE MANDATORY on dimensional words. A value with no
     *     point is read in least-input increments: X1 means 0.001mm, not 1mm.
     *     This is the single most destructive Fanuc formatting trap, and the
     *     base formatters strip trailing zeros ("1"), so every dimensional
     *     formatter is wrapped.
     *   - Programs are delimited by '%' and must open with an O-number.
     *   - Comments are parenthesised, cannot nest, and reject characters
     *     outside the control's set.
     *   - G04 P is MILLISECONDS (integer, no decimal point).
     *   - Modal state SURVIVES program end: the safe-start block must clear
     *     comp and cycles (G40 G49 G80) rather than assume a clean control.
     *   - Retracts use G91 G28 (machine coordinates): a G90 G0 Z is relative
     *     to the active work offset and can drive into the part.
     *
     * Not implemented (the control supports them; EasyShape5000 has no
     * geometry that produces them yet):
     *   - G07.1 / G107 cylindrical interpolation. This is the 'cyl-interp'
     *     route: the post would emit Cartesian X/Y and the CONTROL wraps,
     *     needing an activation block carrying the cylinder radius. It is
     *     deliberately absent from rotary.routes - declaring it would let the
     *     UI select a route that emits no activation block, which moves the
     *     linear axis instead of rotating. Leave it out until it is written.
     *   - G43.4 / G43.5 TCPC. Only meaningful once tool-orientation vectors
     *     exist; the rotary pipeline emits tool-tip positions, not vectors.
     *   - G12.1 / G13.1 polar interpolation (mill-turn face work).
     *   - G41/G42 cutter comp: all offsetting is done in CAM.
     */
    class FanucPostProcessor extends BasePostProcessor {
        constructor() {
            super('Fanuc', {
                label: 'Fanuc (Radioactive)',
                fileExtension: '.nc',
                commentStyle: 'parenthesis',
                supportsToolChange: true,
                supportsArcCommands: true,
                supportsCannedCycles: true,
                useM6: true,
                supportsToolLengthComp: true,
                pauseAfterToolChange: false,
                arcFormat: 'IJ',
                coordinateDecimals: 4,
                rotaryDecimals: 4,
                feedDecimals: 1,
                spindleDecimals: 0,
                modalCommands: true,
                // N-numbering: real, and on by default. Fanuc operators edit at
                // the control and search by block number; an unnumbered program
                // is painful to work with. Steps of 5 leave room to insert.
                lineNumbering: true,
                lineNumberStart: 5,
                lineNumberStep: 5,
                lineNumberMax: 999999,
                maxSpindleSpeed: 24000,
                maxRapidRate: 10000,
                // 4th axis: A (about X) and B (about Y) are the words the
                // rotary geometry can produce; C would need a table about Z,
                // which the CylMap slicer cannot express. G93 is native and is
                // the only correct feed mode for mixed linear/rotary motion -
                // the control cannot synchronise mm with degrees under G94.
                rotary: {
                    routes: ['a-word', 'wrapped-linear'],
                    axisWords: ['A', 'B'],
                    inverseTime: true,
                    // Fanuc alarms on F overflow under G93; microscopic
                    // segments are exactly what a relief raster produces.
                    maxInverseTime: 9999.99,
                    continuous: true,
                    // 0: a machining-centre rotary has a hydraulic/pneumatic
                    // clamp and exact-stop. Raise in Machine Settings if the
                    // table is belt-driven.
                    indexDwell: 0
                },
                defaults: {
                    // generateHeader/generateFooter emit the whole safe-start
                    // and park sequence. These are the user's EXTRAS, appended
                    // inside the correct place in each sequence.
                    startCode: '',
                    endCode: ''
                },
                customParameters: [
                    {
                        key: 'fanucProgramNumber',
                        label: 'Program Number (O)',
                        type: 'number',
                        category: 'machine',
                        default: 1000, min: 1, max: 9999, step: 1
                    },
                    {
                        key: 'fanucProgramName',
                        label: 'Program Name (comment on O-line)',
                        type: 'text',
                        category: 'machine',
                        default: 'EASYSHAPE5000'
                    },
                    {
                        key: 'fanucWorkOffset',
                        label: 'Work Offset',
                        type: 'select',
                        category: 'machine',
                        options: [
                            { value: 'G54', label: 'G54' }, { value: 'G55', label: 'G55' },
                            { value: 'G56', label: 'G56' }, { value: 'G57', label: 'G57' },
                            { value: 'G58', label: 'G58' }, { value: 'G59', label: 'G59' }
                        ],
                        default: 'G54'
                    },
                    {
                        key: 'fanucRotaryUnwind',
                        label: 'Rotary Position at Program End',
                        type: 'select',
                        category: 'machine',
                        options: [
                            { value: 'none', label: 'Leave where it stops (no motion)' },
                            { value: 'g92',  label: 'Zero in place (G92) - no motion' },
                            { value: 'g28',  label: 'Home the rotary (G28) - unwinds fully' }
                        ],
                        default: 'none'
                    }
                ]
            });
        }

        // ════════════════════════════════════════════════════════════
        // Formatting - the decimal-point rule
        // ════════════════════════════════════════════════════════════

        /**
         * Appends a decimal point when the base formatter stripped it.
         * Applied ONLY to dimensional words (X Y Z A B C I J K R Q F).
         * Address words (N O T S M G H D L, and G04's P in ms) must stay
         * integers - 'T01.' and 'S12000.' are syntax errors.
         */
        _pt(text) {
            if (text === '' || text === null || text === undefined) return text;
            return text.indexOf('.') >= 0 ? text : text + '.';
        }

        formatCoordinate(value) {
            return this._pt(super.formatCoordinate(value));
        }

        formatAngle(value) {
            return this._pt(super.formatAngle(value));
        }

        formatFeed(value, inverseTime = false) {
            return this._pt(super.formatFeed(value, inverseTime));
        }

        /** G04 P - milliseconds, integer, NO decimal point. */
        formatDwell(seconds) {
            return Math.round(seconds * 1000);
        }

        /**
         * Fanuc comments cannot nest and an unbalanced '(' aborts the block.
         * The pipeline's own header text contains parentheses (the 4th-axis
         * disclosure line does), so stripping is not optional.
         */
        sanitizeComment(text) {
            return String(text)
                .replace(/[()]/g, '')
                .replace(/[^\x20-\x7E]/g, '')
                .trim();
        }

        formatComment(text, options) {
            if (!options?.includeComments || !text) return '';
            const clean = this.sanitizeComment(text);
            return clean ? `(${clean})` : '';
        }

        // ════════════════════════════════════════════════════════════
        // Program structure
        // ════════════════════════════════════════════════════════════

        generateHeader(options) {
            const c = options.comments || {};
            const lines = [];

            // Tape start + O-number. The control rejects a program that has
            // neither; DNC drip-feed needs the '%' specifically.
            lines.push('%');
            const prog = Math.min(9999, Math.max(1,
                parseInt(options.fanucProgramNumber, 10) || 1000));
            const name = this.sanitizeComment(
                (options.fanucProgramName || 'EASYSHAPE5000').toUpperCase());
            lines.push(`O${String(prog).padStart(4, '0')}${name ? ` (${name})` : ''}`);

            if (options.includeComments && options.commentBlock) {
                options.commentBlock.forEach(line => {
                    const cm = this.formatComment(line, options);
                    if (cm) lines.push(cm);
                });
                lines.push('');
            }

            const isInch = options.units === 'inch' || options.units === 'in';
            this.modalState.units = isInch ? 'G20' : 'G21';
            this.outputScale = isInch ? (1 / 25.4) : 1.0;

            // Safe start. Fanuc keeps modal state ACROSS program ends, so a
            // stale G41/G43/G81 from whatever ran last is live until cleared.
            const wcs = options.fanucWorkOffset || 'G54';
            lines.push(`${this.modalState.coordinateMode} ${this.modalState.units} ` +
                       `${this.modalState.plane} G40 G49 G80`);
            lines.push(`${this.modalState.feedRateMode} ${wcs}`);
            lines.push('');

            if (options.coolant === 'mist') {
                lines.push(this.appendComment('M07', c.coolantMist, options));
            } else if (options.coolant === 'flood') {
                lines.push(this.appendComment('M08', c.coolantFlood, options));
            }

            let startCode = options.startCode || '';
            startCode = startCode.replace(/{toolNumber}/g, options.toolNumber ?? 1);
            if (startCode.trim()) lines.push(startCode);

            return lines.join('\n');
        }

        generateFooter(options) {
            const c = options.comments || {};
            const lines = [''];

            lines.push(this.appendComment('M05', c.spindleStop, options));
            this.currentSpindle = 0;
            if (options.coolant && options.coolant !== 'none') {
                lines.push(this.appendComment('M09', c.coolantOff, options));
            }

            // Machine-coordinate park. G91 G28 is the only retract that is
            // independent of the active work offset.
            lines.push(this.appendComment('G91 G28 Z0.', c.retractSafeZ, options));
            lines.push('G28 X0. Y0.');

            // Rotary end position. Accumulated A can reach tens of thousands
            // of degrees on a spiral finish, so G28 (which unwinds every one
            // of them) is opt-in, not default. G92 zeroes in place with no
            // motion but shifts the offset for whatever runs next.
            // rotaryWordUsed, not rotaryAxisWord: the latter is per-plan and
            // is null by the time the footer runs (the trailing retract plan
            // carries no rotary metadata), which made this whole block dead.
            const word = this.rotaryWordUsed;
            const unwind = options.fanucRotaryUnwind || 'none';
            if (word && unwind !== 'none' && this.currentPosition.a) {
                lines.push(unwind === 'g28'
                    ? this.appendComment(`G28 ${word}0.`,
                        c.rotaryUnwind || 'Home rotary axis', options)
                    : this.appendComment(`G92 ${word}0.`,
                        c.rotaryZero || 'Zero rotary in place', options));
                this.currentPosition.a = 0;
            }

            lines.push('G90');

            if (options.endCode && options.endCode.trim()) lines.push(options.endCode);

            lines.push('M30');
            lines.push('%');
            return lines.join('\n');
        }

        // ════════════════════════════════════════════════════════════
        // Tool change - DRAFT
        //
        // When it IS wired, note the ordering below is load-bearing:
        //   G40 G80  cancel comp and any live cycle
        //   G91 G28 Z0.  retract in MACHINE Z, clear of the part
        //   G90 G49  drop the OLD tool's length offset BEFORE the swap -
        //            a live H with the wrong tool in the spindle is the
        //            classic Z crash
        //   T.. M06  swap
        //   G43 H.. Z..  apply the NEW offset on the way down
        // ════════════════════════════════════════════════════════════

        generateToolChange(tool, options) {
            const c = options.comments || {};
            const lines = [''];
            const num = tool.number || options.toolNumber || 1;
            const tn = String(num).padStart(2, '0');

            this.pushCommentLine(lines,
                (c.toolChange || 'Tool change: {name}').replace('{name}', tool.name || tool.id),
                options);
            this.pushCommentLine(lines,
                (c.toolDiameter || 'Diameter: {diameter}mm').replace('{diameter}', tool.diameter),
                options);

            const stop = this.setSpindle(0, 0, options);
            if (stop) lines.push(stop);
            else if (this.currentSpindle > 0) {
                lines.push(this.appendComment('M05', c.spindleStop, options));
                this.currentSpindle = 0;
            }
            if (options.coolant && options.coolant !== 'none') {
                lines.push(this.appendComment('M09', c.coolantOff, options));
            }

            lines.push('G40 G80');
            lines.push(this.appendComment('G91 G28 Z0.', c.retractSafeZ, options));
            lines.push('G90 G49');
            lines.push('');

            // Simple T/M06 pair. Machines with a carousel run faster if the
            // next tool is pre-staged on an earlier block, but that needs
            // lookahead the generator does not have - this works everywhere.
            lines.push(`T${tn} M06`);

            if (this.config.supportsToolLengthComp) {
                // Track the REAL number, not the formatted string: currentPosition
                // is compared numerically in generateRapid/generateLinear, and a
                // string there makes every Math.abs() NaN, which silently
                // suppresses the next Z word.
                const safeZ = options.safeZ ?? this.config.safetyHeight;
                lines.push(this.appendComment(
                    `G43 H${tn} Z${this.formatCoordinate(safeZ)}`, c.toolLengthComp, options));
                this.currentPosition.z = safeZ;
            }

            if (this.config.pauseAfterToolChange) {
                lines.push(this.appendComment('M00', c.toolChangePause, options));
            }
            lines.push('');

            const rpm = tool.spindleSpeed || options.spindleSpeed || 12000;
            const start = this.setSpindle(rpm, tool.spindleDwell || 0, options);
            if (start) lines.push(start);

            if (options.coolant === 'mist') {
                lines.push(this.appendComment('M07', c.coolantMist, options));
            } else if (options.coolant === 'flood') {
                lines.push(this.appendComment('M08', c.coolantFlood, options));
            }

            lines.push('');
            return lines.join('\n');
        }
    }

    window.FanucPostProcessor = FanucPostProcessor;
})();