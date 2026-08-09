/*!
 * @file        parser/parser-excellon.js
 * @description Excellon parsing module
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const C = window.CAMConfig.constants;
    const D = window.CAMConfig.defaults;
    const formatConfig = C.formats.excellon;

    class ExcellonParser extends ParserCore {
        constructor(options = {}) {
            super({
                units: 'mm',
                format: { integer: 2, decimal: 4 },
                ...options
            });

            this.tools = new Map();
            this.currentTool = null;
            this.inHeader = false;
            this.headerEnded = false;

            // Core coordinate state: tracks the tool's absolute position
            this.state = {
                position: { x: 0, y: 0 }
            };

            // Modal state for M15/M16 slot processing
            this.slotState = {
                inSlot: false,
                startPos: null
            };

            this.drillData = {
                units: 'mm',
                format: this.options.format,
                tools: [],
                holes: [],
                bounds: null,
                stats: {}
            };
        }

        parse(content) {
            try {
                this.debug('Excellon parse (strict)');
                this.reset();

                const lines = content
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n')
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => {
                        if (line.length === 0) return false;
                        // Keep FILE_FORMAT comments
                        if (line.match(/^;FILE_FORMAT=/i)) return true;
                        // Skip other comments
                        if (line.match(/^;/)) return false;
                        return true;
                    });

                this.debug(`Processing ${lines.length} lines`);

                lines.forEach((line, index) => {
                    this.processLine(line, index + 1);
                    this.stats.linesProcessed++;
                });

                this.finalizeParse();

                this.debug(`Complete: ${this.drillData.holes.length} holes, ${this.tools.size} tools`);
                this.logStatistics();

                return {
                    success: this.errors.length === 0,
                    drillData: this.drillData,
                    errors: this.errors,
                    warnings: this.warnings,
                    coordinateValidation: this.coordinateValidation
                };

            } catch (error) {
                this.errors.push(`Fatal: ${error.message}`);
                console.error('[Excellon] Parse error:', error);
                return {
                    success: false,
                    drillData: this.drillData,
                    errors: this.errors,
                    warnings: this.warnings,
                    coordinateValidation: this.coordinateValidation
                };
            }
        }

        reset() {
            this.tools.clear();
            this.currentTool = null;
            this.inHeader = false;
            this.headerEnded = false;

            this.formatExplicitlySet = false;

            this.errors = [];
            this.warnings = [];

            this.state = {
                position: { x: 0, y: 0 }
            };

            this.slotState = {
                inSlot: false,
                startPos: null
            };

            this.stats = {
                linesProcessed: 0,
                objectsCreated: 0,
                coordinatesParsed: 0,
                commandsProcessed: 0
            };

            this.coordinateValidation = {
                coordinateRange: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
                suspiciousCoordinates: []
            };

            this.drillData = {
                units: 'mm',
                format: this.options.format,
                tools: [],
                holes: [],
                bounds: null,
                stats: {}
            };
        }

        processLine(line, lineNumber) {
            this.stats.commandsProcessed++;

            // Header/Metadata Commands (Always processed)
            if (line.startsWith(';FILE_FORMAT=')) {
                this.parseFileFormat(line);
                return;
            } else if (line === 'M48') {
                this.inHeader = true;
                this.debug('Header start');
                return;
            } else if (line === '%') {
                if (!this.headerEnded) {
                    this.inHeader = !this.inHeader;
                    if (!this.inHeader) this.headerEnded = true;
                    this.debug(`Header ${this.headerEnded ? 'end' : 'start'}`);
                }
                return;
            } else if (line === 'M30' || line === 'M00') {
                this.debug('End of file');
                return;
            } else if (line.startsWith('METRIC') || line === 'M71') {
                this.options.units = 'mm';
                this.drillData.units = 'mm';

                // Catch suppression mode
                if (line.includes('LZ')) this.options.zeroSuppression = 'trailing';
                else if (line.includes('TZ')) this.options.zeroSuppression = 'leading';

                // Catch explicit format definitions like "000.000"
                const formatMatch = line.match(/(0+)\.(0+)/);
                if (formatMatch) {
                    this.options.format = { 
                        integer: formatMatch[1].length, 
                        decimal: formatMatch[2].length 
                    };
                    this.drillData.format = this.options.format;
                    this.formatExplicitlySet = true;
                    this.debug(`Explicit format extracted: ${this.options.format.integer}.${this.options.format.decimal}`);
                } else if (!this.formatExplicitlySet) {
                    this.options.format = { integer: 3, decimal: 3 };
                    this.drillData.format = this.options.format;
                    const warnMsg = "No explicit format found. Defaulting to 3.3 (Metric). If holes/slots are misaligned, the file might use a different format.";
                    this.warnings.push(warnMsg);
                    console.warn(`[ExcellonParser] Line ${lineNumber}: ${warnMsg}`);
                }

                this.debug('Units: mm');
                return;
            } else if (line.startsWith('INCH') || line === 'M72') {
                this.options.units = 'inch';
                this.drillData.units = 'inch';

                // Catch suppression mode
                if (line.includes('LZ')) this.options.zeroSuppression = 'trailing';
                else if (line.includes('TZ')) this.options.zeroSuppression = 'leading';

                if (!this.formatExplicitlySet) {
                    this.options.format = { integer: 2, decimal: 5 };
                    this.drillData.format = this.options.format;
                    const warnMsg = "No explicit format found. Defaulting to 2.5 (Inch). If holes/slots are misaligned, the file might use a different format.";
                    this.warnings.push(warnMsg);
                    console.warn(`[ExcellonParser] Line ${lineNumber}: ${warnMsg}`);
                }

                this.debug('Units: inch');
                return;
            } else if (line.startsWith('FMAT')) {
                this.parseFormat(line, lineNumber);
                return;
            } else if (line.match(/^T\d+.*C/i)) {
                this.parseToolDefinition(line, lineNumber);
                return;
            }

            // Modal/Action Commands (Processed after header ends)
            if (this.headerEnded) {
                if (line.match(/^T\d+$/)) {
                    this.selectTool(line, lineNumber);
                    return;
                }

                if (line === 'M15') {
                    this.handleM15();
                    return;
                }

                if (line === 'M16') {
                    this.handleM16(lineNumber);
                    return;
                }

                // Coordinate Handling (G-codes, Drills, Slots)
                const coordinates = this.extractCoordinatesFromLine(line, lineNumber);

                // If coordinates found, update the core position
                if (coordinates) {
                    this.state.position = coordinates;
                }

                // Check for drill/slot operation on the line (G85, or implicit X/Y move)
                this.processDrillOrSlotCommand(line, lineNumber);
            }
        }

        // Header Parsing Helpers

        parseFileFormat(line) {
            const match = line.match(/FILE_FORMAT[=\s]+(\d+):(\d+)/i);
            if (match) {
                this.formatExplicitlySet = true;

                const intDigits = parseInt(match[1]);
                const decDigits = parseInt(match[2]);
                this.options.format = { integer: intDigits, decimal: decDigits };
                this.drillData.format = this.options.format;
                this.debug(`Format: ${intDigits}.${decDigits} (from FILE_FORMAT comment)`);
            }
        }

        parseFormat(line, lineNumber) {
            const match = line.match(/FMAT,?(\d)/);
            if (match) {
                this.formatExplicitlySet = true;

                const code = parseInt(match[1]);
                if (code === 1) {
                    this.options.format = { integer: 2, decimal: 3 };
                } else if (code === 2) {
                    this.options.format = { integer: 2, decimal: 4 };
                } else {
                    this.warnings.push(`Line ${lineNumber}: Unknown FMAT ${code}`);
                }
                this.drillData.format = this.options.format;
                this.debug(`Format: ${this.options.format.integer}.${this.options.format.decimal}`);
            }
        }

        parseToolDefinition(line, lineNumber) {
            const match = line.match(/^T(\d+).*?C([0-9.]+)/i);
            if (!match) {
                this.errors.push(`Line ${lineNumber}: Invalid tool syntax "${line}"`);
                return;
            }

            const number = parseInt(match[1]);
            const toolKeyPadding = formatConfig.toolKeyPadding;
            const toolKey = `T${number.toString().padStart(toolKeyPadding, '0')}`;
            let diameter = parseFloat(match[2]);

            if (!isFinite(diameter) || diameter <= 0) {
                this.errors.push(`Line ${lineNumber}: Invalid diameter "${match[2]}"`);
                return;
            }

            const tool = {
                number: number,
                key: toolKey,
                diameter: diameter,
                originalDiameter: diameter,
                originalUnits: this.options.units
            };

            this.tools.set(toolKey, tool);
            this.drillData.tools.push(tool);
            this.debug(`Tool ${toolKey}: ⌀${diameter.toFixed(3)} (native units)`);
        }

        selectTool(line, lineNumber) {
            const match = line.match(/^T(\d+)$/);
            if (!match) return;

            const number = parseInt(match[1]);

            if (number === 0) {
                this.debug('T0: Deselect');
                this.currentTool = null;
                return;
            }

            const toolKeyPadding = formatConfig.toolKeyPadding;
            const toolKey = `T${number.toString().padStart(toolKeyPadding, '0')}`;

            if (!this.tools.has(toolKey)) {
                this.errors.push(`Line ${lineNumber}: Tool ${toolKey} undefined`);
                this.currentTool = null;
                return;
            }

            this.currentTool = toolKey;
            const tool = this.tools.get(toolKey);
            this.debug(`Select ${toolKey}: ⌀${tool.diameter.toFixed(3)}mm`);
        }

        // Modal & Action Handlers

        handleM15() {
            this.debug('Start Slot/Route (M15)');
            this.slotState.inSlot = true;

            // Capture the current position (set by a preceding G00/G01) as the slot start
            this.slotState.startPos = { ...this.state.position }; 
            this.debug(`M15: Captured StartPos: (${this.slotState.startPos.x.toFixed(3)}, ${this.slotState.startPos.y.toFixed(3)})`);
        }

        handleM16(lineNumber) {
            this.debug('End Slot/Route (M16)');
            if (this.slotState.inSlot && this.slotState.startPos && this.currentTool) {
                // The current position (set by a preceding G01 move) is the slot end
                const endPos = { ...this.state.position };
                this.debug(`M16: Final EndPos: (${endPos.x.toFixed(3)}, ${endPos.y.toFixed(3)})`);
                this.createSlotOperation(this.slotState.startPos, endPos, lineNumber);
            } else {
                this.warnings.push(`Line ${lineNumber}: M16 found without active slot or tool.`);
            }
            this.slotState.inSlot = false;
            this.slotState.startPos = null;
        }

        processDrillOrSlotCommand(line, lineNumber) {
            if (!this.currentTool) {
                if (line.match(/[XY]/)) {
                    this.warnings.push(`Line ${lineNumber}: Coordinate command without selected tool, ignoring.`);
                }
                return;
            }

            // Check for G85 slot command
            if (line.includes('G85')) {
                this.parseG85Slot(line, lineNumber);
                return;
            }

            // Standard drill operation (Txx + X/Y) or implicit G01/G00 move
            if (line.match(/[XY]/)) {
                if (!this.slotState.inSlot && !line.match(/^G\d+/)) {
                    // Standard drill hit. Position is already updated by extractCoordinatesFromLine.
                    this.createDrillOperation(this.state.position);
                }
            }
        }

        parseG85Slot(line, lineNumber) {
            const tool = this.tools.get(this.currentTool);
            // G85 format: Xstart Ystart G85 Xend Yend
            const slotMatch = line.match(/X([+-]?(?:\d+\.?\d*|\.\d+))\s*Y([+-]?(?:\d+\.?\d*|\.\d+))\s*G85\s*X([+-]?(?:\d+\.?\d*|\.\d+))\s*Y([+-]?(?:\d+\.?\d*|\.\d+))/i);

            if (slotMatch) {
                try {
                    const startCoords = {
                        x: this.parseCoordinateValue(slotMatch[1], this.options.format),
                        y: this.parseCoordinateValue(slotMatch[2], this.options.format)
                    };
                    const endCoords = {
                        x: this.parseCoordinateValue(slotMatch[3], this.options.format),
                        y: this.parseCoordinateValue(slotMatch[4], this.options.format)
                    };

                    this.updateCoordinateRange(startCoords);
                    this.updateCoordinateRange(endCoords);

                    this.drillData.holes.push({
                        type: 'slot',
                        start: startCoords,
                        end: endCoords,
                        tool: this.currentTool,
                        diameter: tool.diameter,
                        plated: true
                    });

                    this.stats.objectsCreated++;
                    this.stats.coordinatesParsed += 4;
                    this.debug(`Created G85 slot data: {type: 'slot', start: (${startCoords.x.toFixed(3)}, ${startCoords.y.toFixed(3)}), end: (${endCoords.x.toFixed(3)}, ${endCoords.y.toFixed(3)}), diameter: ${tool.diameter.toFixed(3)}}`);

                } catch (error) {
                    this.errors.push(`Line ${lineNumber}: Error parsing slot coordinates - ${error.message}`);
                }
            } else {
                this.errors.push(`Line ${lineNumber}: Malformed G85 slot command: "${line}"`);
            }
        }

        createDrillOperation(position) {
            const tool = this.tools.get(this.currentTool);

            this.drillData.holes.push({
                type: 'hole',
                position: position,
                tool: this.currentTool,
                diameter: tool.diameter,
                plated: true
            });

            this.stats.objectsCreated++;
            this.debug(`Created drill hole data: {type: 'hole', pos: (${position.x.toFixed(3)}, ${position.y.toFixed(3)}), diameter: ${tool.diameter.toFixed(3)}}`);
        }

        createSlotOperation(start, end, lineNumber) {
            if (!this.currentTool) {
                this.errors.push(`Line ${lineNumber}: No tool selected for slot operation.`);
                return;
            }

            const tool = this.tools.get(this.currentTool);
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const length = Math.sqrt(dx * dx + dy * dy);

            this.drillData.holes.push({
                type: 'slot',
                start: start,
                end: end,
                tool: this.currentTool,
                diameter: tool.diameter,
                plated: true
            });

            this.stats.objectsCreated++;
            this.stats.coordinatesParsed += 2; 

            this.debug(`Created M15/M16 slot data: {type: 'slot', start: (${start.x.toFixed(3)}, ${start.y.toFixed(3)}), end: (${end.x.toFixed(3)}, ${end.y.toFixed(3)}), diameter: ${tool.diameter.toFixed(3)}, length: ${length.toFixed(3)}}`);
        }

        // Coordinate Parsing

        extractCoordinatesFromLine(line, lineNumber) {
            const xMatch = line.match(/X([+-]?(?:\d+\.?\d*|\.\d+))/i);
            const yMatch = line.match(/Y([+-]?(?:\d+\.?\d*|\.\d+))/i);

            if (!xMatch && !yMatch) {
                return null;
            }

            try {
                // Start with the last known position, only update if coordinate is present
                const coordinates = { ...this.state.position };

                if (xMatch) {
                    coordinates.x = this.parseCoordinateValue(xMatch[1], this.options.format);
                    this.stats.coordinatesParsed++;
                }

                if (yMatch) {
                    coordinates.y = this.parseCoordinateValue(yMatch[1], this.options.format);
                    this.stats.coordinatesParsed++;
                }

                this.updateCoordinateRange(coordinates);

                // Return the newly parsed coordinates (which will become the new state)
                return coordinates; 

            } catch (error) {
                this.errors.push(`Line ${lineNumber}: ${error.message}`);
                return null;
            }
        }

        finalizeParse() {
            if (this.tools.size === 0 && this.drillData.holes.length > 0) {
                this.errors.push('Holes found but no tools defined');
            }

            this.calculateDrillBounds();
            this.validateCoordinateConsistency();
            this.generateDrillStats();

            this.drillData.units = this.options.units;
        }

        calculateDrillBounds() {
            if (this.drillData.holes.length === 0) {
                this.drillData.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
                return;
            }

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            this.drillData.holes.forEach(item => {
                const radius = item.diameter / 2;

                switch (item.type) {
                    case 'hole':
                        // Handle standard circular holes which have a 'position' property
                        if (item.position) {
                            minX = Math.min(minX, item.position.x - radius);
                            minY = Math.min(minY, item.position.y - radius);
                            maxX = Math.max(maxX, item.position.x + radius);
                            maxY = Math.max(maxY, item.position.y + radius);
                        }
                        break;

                    case 'slot':
                        // Handle slots which have 'start' and 'end' properties
                        if (item.start && item.end) {
                            minX = Math.min(minX, item.start.x - radius, item.end.x - radius);
                            minY = Math.min(minY, item.start.y - radius, item.end.y - radius);
                            maxX = Math.max(maxX, item.start.x + radius, item.end.x + radius);
                            maxY = Math.max(maxY, item.start.y + radius, item.end.y + radius);
                        }
                        break;
                }
            });

            if (!isFinite(minX)) {
                this.drillData.bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            } else {
                this.drillData.bounds = { minX, minY, maxX, maxY };
            }
        }

        validateCoordinateConsistency() {
            if (this.drillData.holes.length === 0) return;

            const range = this.coordinateValidation.coordinateRange;
            const width = range.maxX - range.minX;
            const height = range.maxY - range.minY;

            if (width > 1000 || height > 1000) {
                this.warnings.push(`Large board: ${width.toFixed(1)}x${height.toFixed(1)}mm`);
            }
        }

        generateDrillStats() {
            const toolUsage = new Map();
            this.drillData.holes.forEach(hole => {
                toolUsage.set(hole.tool, (toolUsage.get(hole.tool) || 0) + 1);
            });

            this.drillData.stats = {
                totalHoles: this.drillData.holes.length,
                toolCount: this.tools.size,
                toolUsage: Object.fromEntries(toolUsage)
            };
        }
    }

    window.ExcellonParser = ExcellonParser;
})();