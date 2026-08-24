/*!
 * @file        parser/parser-gerber.js
 * @description Gerber parsing module (RS-274X)
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
    const PRECISION = C.precision.coordinate;
    const formatConfig = C.formats.gerber;

    class GerberParser extends ParserCore {
        constructor(options = {}) {
            super({
                units: formatConfig.defaultUnits,
                format: formatConfig.defaultFormat,
                ...options
            });

            // Gerber-specific state
            this.state = {
                position: { x: 0, y: 0 },
                aperture: null,
                apertures: new Map(),
                macros: new Map(),
                interpolation: 'linear',
                polarity: 'dark',
                inRegion: false,
                regionPoints: [],
                currentNetName: null,
                units: this.options.units,
                format: { ...this.options.format }
            };

            // Results
            this.layers = {
                polarity: 'positive',
                units: this.options.units,
                bounds: null,
                apertures: [],
                objects: []
            };
        }

        parse(content) {
            try {
                this.debug('Starting Gerber parse');

                // Reset state
                this.reset();

                // Tokenize into commands
                const commands = this.tokenize(content);
                this.debug(`Tokenized ${commands.length} commands`);

                // Execute commands sequentially
                this.executeCommands(commands);

                // Finalize
                this.finalizeParse();
                this.debug(`Parse complete: ${this.layers.objects.length} objects created`);
                this.logStatistics();

                return {
                    success: true,
                    layers: this.layers,
                    errors: this.errors,
                    warnings: this.warnings
                };

            } catch (error) {
                this.errors.push(`Parse error: ${error.message}`);
                return {
                    success: false,
                    layers: this.layers,
                    errors: this.errors,
                    warnings: this.warnings
                };
            }
        }

        reset() {
            this.state = {
                position: { x: 0, y: 0 },
                aperture: null,
                apertures: new Map(),
                macros: new Map(),
                interpolation: 'linear',
                polarity: 'dark',
                inRegion: false,
                regionPoints: [],
                currentNetName: null,
                units: this.options.units,
                format: { ...this.options.format }
            };

            this.layers = {
                polarity: 'positive',
                units: this.options.units,
                bounds: null,
                apertures: [],
                objects: []
            };

            this.errors = [];
            this.warnings = [];
            this.stats = {
                linesProcessed: 0,
                objectsCreated: 0,
                coordinatesParsed: 0,
                commandsProcessed: 0
            };
        }

        tokenize(content) {
            const commands = [];
            let currentBlock = '';
            let inExtended = false;
            let lineNumber = 1;

            for (let i = 0; i < content.length; i++) {
                const char = content[i];

                if (char === '\n') {
                    lineNumber++;
                    this.stats.linesProcessed++;
                }

                if (char === '%') {
                    if (inExtended && currentBlock.trim()) {
                        commands.push(this.parseExtendedCommand(currentBlock.trim(), lineNumber));
                        currentBlock = '';
                    }
                    inExtended = !inExtended;
                } else if (char === '*' && !inExtended) {
                    if (currentBlock.trim()) {
                        const cmds = this.parseStandardCommand(currentBlock.trim(), lineNumber);
                        commands.push(...cmds);
                    }
                    currentBlock = '';
                } else if (char !== '\r' && char !== '\n') {
                    currentBlock += char;
                }
            }

            return commands;
        }

        parseExtendedCommand(block, lineNumber) {
            // Aperture Macro Definition
            // Handles both single-line (EasyEDA) and multi-line (KiCad) formats
            if (block.startsWith('AM')) {
                // Use [\s\S]* to match across newlines
                const match = block.match(/^AM([A-Za-z_][A-Za-z0-9_]*)\*([\s\S]*)/);
                if (match) {
                    const macroName = match[1];
                    // Clean up content: remove trailing asterisks and whitespace
                    let macroContent = match[2].trim();
                    // Remove trailing * if present (common in single-line macros)
                    if (macroContent.endsWith('*')) {
                        macroContent = macroContent.slice(0, -1);
                    }

                    this.state.macros.set(macroName, { 
                        name: macroName, 
                        content: macroContent 
                    });
                    this.debug(`Defined Macro: ${macroName} (${macroContent.length} chars)`);
                    return { type: 'MACRO_DEF', params: { name: macroName }, line: lineNumber };
                }
            }

            // Aperture Definition - check macro shapes before standard shapes to prevent partial matches (e.g., 'R' from 'RoundRect')
            if (block.startsWith('AD')) {
                const dCode = block.match(/^ADD(\d+)/);
                if (!dCode) {
                    this.warnings.push(`Line ${lineNumber}: Invalid aperture definition: ${block}`);
                    return { type: 'UNKNOWN', params: { content: block }, line: lineNumber };
                }

                const code = `D${dCode[1]}`;
                const afterDCode = block.slice(dCode[0].length);

                // Try to match standard shapes first (single letter followed by comma)
                const stdMatch = afterDCode.match(/^([CROP]),(.*)$/);
                if (stdMatch) {
                    const shapeChar = stdMatch[1];
                    const paramStr = stdMatch[2].replace(/\*$/, ''); // Remove trailing *
                    return {
                        type: 'DEFINE_APERTURE',
                        params: {
                            code: code,
                            shape: this.getApertureShape(shapeChar),
                            parameters: this.parseApertureParameters(paramStr)
                        },
                        line: lineNumber
                    };
                }

                // Try macro shapes (word followed by comma)
                const macroMatch = afterDCode.match(/^([A-Za-z_][A-Za-z0-9_]*),(.*)$/);
                if (macroMatch) {
                    const macroName = macroMatch[1];
                    const paramStr = macroMatch[2].replace(/\*$/, ''); // Remove trailing *

                    if (this.state.macros.has(macroName)) {
                        return {
                            type: 'DEFINE_APERTURE',
                            params: {
                                code: code,
                                shape: 'macro',
                                macroName: macroName,
                                variables: this.parseApertureParameters(paramStr)
                            },
                            line: lineNumber
                        };
                    } else {
                        this.warnings.push(`Line ${lineNumber}: Undefined macro '${macroName}' in aperture ${code}`);
                    }
                }

                // Handle apertures without parameters (e.g., %ADD10C*%)
                const noParamMatch = afterDCode.match(/^([CROP])\*?$/);
                if (noParamMatch) {
                    return {
                        type: 'DEFINE_APERTURE',
                        params: {
                            code: code,
                            shape: this.getApertureShape(noParamMatch[1]),
                            parameters: []
                        },
                        line: lineNumber
                    };
                }

                this.warnings.push(`Line ${lineNumber}: Could not parse aperture definition: ${block}`);
            }

            if (block.startsWith('FS')) {
                const match = block.match(/FS([LT])([AI])X(\d)(\d)Y(\d)(\d)/);
                if (match) {
                    return { 
                        type: 'SET_FORMAT', 
                        params: { 
                            leadingZeros: match[1] === 'L' ? 'omit' : 'keep',
                            coordinates: match[2] === 'A' ? 'absolute' : 'incremental',
                            xInteger: parseInt(match[3]), 
                            xDecimal: parseInt(match[4]), 
                            yInteger: parseInt(match[5]), 
                            yDecimal: parseInt(match[6]) 
                        }, 
                        line: lineNumber 
                    };
                }
            }

            if (block.startsWith('MO')) {
                return { type: 'SET_UNITS', params: { units: block.includes('MM') ? 'mm' : 'inch' }, line: lineNumber };
            }

            if (block.startsWith('LP')) {
                return { type: 'SET_POLARITY', params: { polarity: block.includes('D') ? 'dark' : 'clear' }, line: lineNumber };
            }

            // Gerber X2 object attributes - %TO.field,value*%
            // TO.N = net name, TO.C = component refdes, TO.P = pin
            // Track TO.N (net name) to annotate subsequent primitives.
            // This gives free net identification for copper pour detection
            // (e.g., %TO.N,GND*% before a pour region means it's a ground pour).
            if (block.startsWith('TO')) {
                const toMatch = block.match(/^TO\.([A-Za-z]+),?(.*?)$/);
                if (toMatch) {
                    const field = toMatch[1];
                    const value = toMatch[2] ? toMatch[2].replace(/\*$/, '') : '';

                    if (field === 'N') {
                        // Net name attribute - applies to all subsequent objects until cleared by %TO*% or changed by another %TO.N,...*%
                        this.state.currentNetName = value || null;
                        this.debug(`Net attribute set: ${value || '(cleared)'}`);
                    }

                    return {
                        type: 'SET_ATTRIBUTE',
                        params: { attributeType: 'object', field: field, value: value },
                        line: lineNumber
                    };
                }

                // %TO*% with no field clears all object attributes
                if (block === 'TO' || block === 'TO*') {
                    this.state.currentNetName = null;
                    return {
                        type: 'SET_ATTRIBUTE',
                        params: { attributeType: 'object', field: null, value: null },
                        line: lineNumber
                    };
                }
            }

            // Also handle TD (delete attribute) which KiCad emits between objects
            if (block.startsWith('TD')) {
                this.state.currentNetName = null;
                return {
                    type: 'CLEAR_ATTRIBUTE',
                    params: {},
                    line: lineNumber
                };
            }

            return { type: 'UNKNOWN', params: { content: block }, line: lineNumber };
        }

        parseApertureParameters(paramStr) {
            if (!paramStr || paramStr.trim() === '') return [];
            return paramStr.split('X').map(p => {
                const val = parseFloat(p);
                return isNaN(val) ? 0 : val;
            });
        }

        parseStandardCommand(block, lineNumber) {
            const commands = [];
            let remaining = block;

            // Ignore G04 comments completely
            if (remaining.startsWith('G04')) {
                return commands;
            }

            // Extract G-codes
            if (remaining.includes('G36')) {
                commands.push({ type: 'START_REGION', params: {}, line: lineNumber });
                remaining = remaining.replace('G36', '').trim();
            }

            if (remaining.includes('G37')) {
                commands.push({ type: 'END_REGION', params: {}, line: lineNumber });
                remaining = remaining.replace('G37', '').trim();
            }

            if (remaining.includes('G01')) {
                commands.push({ type: 'SET_INTERPOLATION', params: { mode: 'linear' }, line: lineNumber });
                remaining = remaining.replace('G01', '').trim();
            }

            if (remaining.includes('G02')) {
                commands.push({ type: 'SET_INTERPOLATION', params: { mode: 'cw_arc' }, line: lineNumber });
                remaining = remaining.replace('G02', '').trim();
            }

            if (remaining.includes('G03')) {
                commands.push({ type: 'SET_INTERPOLATION', params: { mode: 'ccw_arc' }, line: lineNumber });
                remaining = remaining.replace('G03', '').trim();
            }

            // Extract coordinates
            const coords = this.extractCoordinates(remaining);

            // Extract D-code operation
            let operation = null;
            if (remaining.includes('D01')) {
                operation = 'DRAW';
            } else if (remaining.includes('D02')) {
                operation = 'MOVE';
            } else if (remaining.includes('D03')) {
                operation = 'FLASH';
            } else if (remaining.match(/D(\d{2,})/)) {
                const match = remaining.match(/D(\d{2,})/);
                const dCode = parseInt(match[1]);
                if (dCode >= 10) {
                    commands.push({
                        type: 'SELECT_APERTURE',
                        params: { aperture: `D${match[1]}` },
                        line: lineNumber
                    });
                }
            }

            // Create operation command
            if (coords || operation) {
                commands.push({
                    type: 'COORD_ACTION', // Use a single generic action
                    params: coords || {},
                    operation: operation, // Passes 'DRAW', 'MOVE', 'FLASH', or null
                    line: lineNumber
                });
            }

            // Handle M-codes
            if (remaining.startsWith('M02') || remaining.startsWith('M00') || remaining.startsWith('M30')) {
                commands.push({ type: 'EOF', params: {}, line: lineNumber });
            }

            return commands;
        }

        /**
         * Parses aperture macro content into executable primitive list
         */
        parseMacroContent(content) {
            const primitives = [];
            if (!content || content.trim() === '') return primitives;

            // Split by '*' to get individual statements
            // Handle both formats: newline-separated and single-line
            const statements = content
                .split('*')
                .map(s => s.trim())
                .filter(s => {
                    if (!s) return false;
                    // Filter out comments (lines starting with 0 followed by space)
                    if (/^0\s/.test(s)) return false;
                    // Filter out empty lines and pure whitespace
                    if (/^\s*$/.test(s)) return false;
                    return true;
                });

            for (const statement of statements) {
                // Handle variable assignments ($N=expression)
                if (statement.includes('=') && statement.startsWith('$')) {
                    // Variable assignment - store for later use
                    // (Currently not fully implemented, but don't crash)
                    continue;
                }

                // Parse primitive: code,params...
                const parts = statement.split(',');
                const code = parseInt(parts[0]);

                if (isNaN(code)) {
                    this.debug(`Skipping non-numeric macro statement: ${statement}`);
                    continue;
                }

                primitives.push({
                    code: code,
                    params: parts.slice(1).map(p => p.trim())
                });
            }

            return primitives;
        }

        /**
         * Evaluates a macro parameter expression, substituting variables
         */
        evaluateMacroParam(param, variables) {
            if (typeof param === 'number') return param;

            let expr = String(param);

            // Sanitize 'X' or 'x' into standard multiplication operators
            expr = expr.replace(/[xX]/g, '*');

            // Substitute $N variables
            expr = expr.replace(/\$(\d+)/g, (match, num) => {
                const idx = parseInt(num) - 1;
                return variables[idx] !== undefined ? variables[idx] : 0;
            });

            // Handle simple arithmetic: +, -, *, /
            // Use Function for safe evaluation of numeric expressions
            try {
                // Only allow numbers, operators, parentheses, and whitespace
                if (!/^[\d\s.+\-*/()]+$/.test(expr)) {
                    return parseFloat(expr) || 0;
                }
                return Function('"use strict"; return (' + expr + ')')();
            } catch (e) {
                return parseFloat(expr) || 0;
            }
        }

        /**
         * Executes macro primitives and returns polygon points
         */
        executeMacro(macro, variables, position) {
            const primitives = this.parseMacroContent(macro.content);
            const shapes = [];

            if (primitives.length === 0) {
                this.warnings.push(`Macro ${macro.name} has no valid primitives`);
                return shapes;
            }

            for (const prim of primitives) {
                const params = prim.params.map(p => this.evaluateMacroParam(p, variables));

                switch (prim.code) {
                    case 1: // Circle: exposure, diameter, centerX, centerY [, rotation]
                        if (params[0] === 1) {
                            const diameter = params[1];
                            const cx = (params[2] || 0);
                            const cy = (params[3] || 0);
                            const rotation = params[4] || 0;

                            let rx = cx, ry = cy;
                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);
                                rx = cx * cos - cy * sin;
                                ry = cx * sin + cy * cos;
                            }

                            shapes.push({
                                type: 'circle',
                                x: position.x + rx,
                                y: position.y + ry,
                                radius: diameter / 2
                            });
                        }
                        break;

                    case 4: // Outline: exposure, numVertices, x0,y0, x1,y1, ..., rotation
                        if (params[0] === 1) {
                            const numVertices = Math.floor(params[1]);
                            const rotation = params[4 + numVertices * 2] || 0;
                            const points = [];

                            for (let i = 0; i <= numVertices; i++) {
                                const px = params[2 + i * 2];
                                const py = params[3 + i * 2];
                                if (px !== undefined && py !== undefined) {
                                    let rx = px, ry = py;
                                    if (rotation !== 0) {
                                        const rad = rotation * Math.PI / 180;
                                        const cos = Math.cos(rad);
                                        const sin = Math.sin(rad);
                                        rx = px * cos - py * sin;
                                        ry = px * sin + py * cos;
                                    }
                                    points.push({
                                        x: position.x + rx,
                                        y: position.y + ry
                                    });
                                }
                            }
                            if (points.length >= 3) {
                                const first = points[0];
                                const last = points[points.length - 1];
                                if (Math.abs(first.x - last.x) > 0.0001 || Math.abs(first.y - last.y) > 0.0001) {
                                    points.push({ ...first });
                                }
                                shapes.push({ type: 'polygon', points: points });
                            }
                        }
                        break;

                    case 5: // Polygon: exposure, numVertices, centerX, centerY, diameter, rotation
                        if (params[0] === 1) {
                            const numVertices = Math.floor(params[1]);
                            const px = (params[2] || 0);
                            const py = (params[3] || 0);
                            const diameter = (params[4] || 0);
                            const rotation = params[5] || 0;

                            let cx = px, cy = py;
                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);
                                cx = px * cos - py * sin;
                                cy = px * sin + py * cos;
                            }

                            cx += position.x;
                            cy += position.y;
                            const radius = diameter / 2;
                            const points = [];
                            const rotRad = rotation * Math.PI / 180;

                            for (let i = 0; i < numVertices; i++) {
                                const angle = rotRad + (2 * Math.PI * i / numVertices);
                                points.push({
                                    x: cx + radius * Math.cos(angle),
                                    y: cy + radius * Math.sin(angle)
                                });
                            }
                            points.push({ ...points[0] }); // Close
                            shapes.push({ type: 'polygon', points: points });
                        }
                        break;

                    case 20: // Vector Line: exposure, width, startX, startY, endX, endY, rotation
                        if (params[0] === 1) {
                            const width = params[1];
                            const px1 = params[2] || 0;
                            const py1 = params[3] || 0;
                            const px2 = params[4] || 0;
                            const py2 = params[5] || 0;
                            const rotation = params[6] || 0;

                            let rx1 = px1, ry1 = py1, rx2 = px2, ry2 = py2;
                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);
                                rx1 = px1 * cos - py1 * sin;
                                ry1 = px1 * sin + py1 * cos;
                                rx2 = px2 * cos - py2 * sin;
                                ry2 = px2 * sin + py2 * cos;
                            }

                            shapes.push({
                                type: 'line',
                                start: { x: position.x + rx1, y: position.y + ry1 },
                                end: { x: position.x + rx2, y: position.y + ry2 },
                                width: width
                            });
                        }
                        break;

                    case 21: // Center Line (rectangle): exposure, width, height, centerX, centerY, rotation
                        if (params[0] === 1) {
                            const w = (params[1] || 0);
                            const h = (params[2] || 0);
                            const px = (params[3] || 0);
                            const py = (params[4] || 0);
                            const rotation = params[5] || 0;

                            let cx = px, cy = py;
                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);
                                cx = px * cos - py * sin;
                                cy = px * sin + py * cos;
                            }

                            cx += position.x;
                            cy += position.y;

                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);
                                const hw = w / 2, hh = h / 2;
                                const corners = [
                                    { x: -hw, y: -hh },
                                    { x: hw, y: -hh },
                                    { x: hw, y: hh },
                                    { x: -hw, y: hh }
                                ];
                                const points = corners.map(c => ({
                                    x: cx + c.x * cos - c.y * sin,
                                    y: cy + c.x * sin + c.y * cos
                                }));
                                points.push({ ...points[0] });
                                shapes.push({ type: 'polygon', points: points });
                            } else {
                                shapes.push({
                                    type: 'rectangle',
                                    x: cx - w / 2,
                                    y: cy - h / 2,
                                    width: w,
                                    height: h
                                });
                            }
                        }
                        break;

                    case 22: // Lower-Left Line (rectangle): exposure, width, height, lowerLeftX, lowerLeftY, rotation
                        if (params[0] === 1) {
                            const w = (params[1] || 0);
                            const h = (params[2] || 0);
                            const llx = (params[3] || 0);
                            const lly = (params[4] || 0);
                            const rotation = params[5] || 0;

                            if (rotation !== 0) {
                                const rad = rotation * Math.PI / 180;
                                const cos = Math.cos(rad);
                                const sin = Math.sin(rad);

                                const corners = [
                                    { x: llx, y: lly },
                                    { x: llx + w, y: lly },
                                    { x: llx + w, y: lly + h },
                                    { x: llx, y: lly + h }
                                ];

                                const points = corners.map(c => ({
                                    x: position.x + (c.x * cos - c.y * sin),
                                    y: position.y + (c.x * sin + c.y * cos)
                                }));
                                points.push({ ...points[0] });
                                shapes.push({ type: 'polygon', points: points });
                            } else {
                                shapes.push({
                                    type: 'rectangle',
                                    x: position.x + llx,
                                    y: position.y + lly,
                                    width: w,
                                    height: h
                                });
                            }
                        }
                        break;

                    default:
                        this.debug(`Unhandled macro primitive code: ${prim.code}`);
                }
            }

            return shapes;
        }

        /**
         * Converts macro shapes to flash polygon points
         */
        macroShapesToPolygon(shapes, position) {
            // For RoundRect-style macros, tessellate circles and combine
            const allPoints = [];

            // If it's a simple case (circles at corners + lines), build rounded rect directly
            const circles = shapes.filter(s => s.type === 'circle');
            const lines = shapes.filter(s => s.type === 'line');
            const polygons = shapes.filter(s => s.type === 'polygon');

            // Obround Macro Pattern (2 Circles + 1 Line)
            if (circles.length === 2 && lines.length === 1) {
                const c1 = circles[0];
                const c2 = circles[1];
                const dx = c2.x - c1.x;
                const dy = c2.y - c1.y;
                const angle = Math.atan2(dy, dx);
                const radius = Math.max(c1.radius, c2.radius);

                let arc1Id = null;
                let arc2Id = null;
                if (window.globalCurveRegistry) {
                    arc1Id = window.globalCurveRegistry.register({
                        type: 'arc', center: { x: c2.x, y: c2.y }, radius: radius,
                        startAngle: angle - Math.PI / 2, endAngle: angle + Math.PI / 2,
                        clockwise: false, source: 'macro_obround_cap2'
                    });
                    arc2Id = window.globalCurveRegistry.register({
                        type: 'arc', center: { x: c1.x, y: c1.y }, radius: radius,
                        startAngle: angle + Math.PI / 2, endAngle: angle + 3 * Math.PI / 2,
                        clockwise: false, source: 'macro_obround_cap1'
                    });
                }

                // Exactly 4 boundary points; the arcs connect them.
                const p1 = { x: c2.x + radius * Math.cos(angle - Math.PI/2), y: c2.y + radius * Math.sin(angle - Math.PI/2), curveId: arc1Id };
                const p2 = { x: c2.x + radius * Math.cos(angle + Math.PI/2), y: c2.y + radius * Math.sin(angle + Math.PI/2), curveId: arc1Id };
                const p3 = { x: c1.x + radius * Math.cos(angle + Math.PI/2), y: c1.y + radius * Math.sin(angle + Math.PI/2), curveId: arc2Id };
                const p4 = { x: c1.x + radius * Math.cos(angle - Math.PI/2), y: c1.y + radius * Math.sin(angle - Math.PI/2), curveId: arc2Id };

                const points = [p1, p2, p3, p4];
                const arcSegments = [
                    { startIndex: 0, endIndex: 1, center: { x: c2.x, y: c2.y }, radius: radius, startAngle: angle - Math.PI/2, endAngle: angle + Math.PI/2, clockwise: false, curveId: arc1Id },
                    { startIndex: 2, endIndex: 3, center: { x: c1.x, y: c1.y }, radius: radius, startAngle: angle + Math.PI/2, endAngle: angle + 3 * Math.PI/2, clockwise: false, curveId: arc2Id }
                ];

                return { shape: 'polygon', points, arcSegments };
            }

            // Rounded Rectangle Macro Pattern (4 Circles + 4 Lines or 1 Poly)
            if (circles.length === 4 && (lines.length === 4 || polygons.length === 1)) {
                // Sort circles by angle from center to get corner order
                const cx = circles.reduce((sum, c) => sum + c.x, 0) / 4;
                const cy = circles.reduce((sum, c) => sum + c.y, 0) / 4;

                const getAngle = (c) => {
                    let a = Math.atan2(c.y - cy, c.x - cx);
                    if (a < 0) a += 2 * Math.PI;
                    return a;
                };
                const sortedCircles = circles.slice().sort((a, b) => getAngle(a) - getAngle(b));

                const radius = circles[0].radius;
                const points = [];
                const arcSegments = [];

                // Build rounded rectangle by going around corners
                for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
                    const circle = sortedCircles[cornerIdx];

                    // Determine which quadrant arc to draw
                    const dx = circle.x - cx;
                    const dy = circle.y - cy;

                    // Arc from edge coming in to edge going out
                    let startAngle, endAngle;
                    if (dx > 0 && dy > 0) { // Top-right
                        startAngle = 0;
                        endAngle = Math.PI / 2;
                    } else if (dx < 0 && dy > 0) { // Top-left
                        startAngle = Math.PI / 2;
                        endAngle = Math.PI;
                    } else if (dx < 0 && dy < 0) { // Bottom-left
                        startAngle = Math.PI;
                        endAngle = 3 * Math.PI / 2;
                    } else { // Bottom-right
                        startAngle = 3 * Math.PI / 2;
                        endAngle = 2 * Math.PI;
                    }

                    // Register corner arcs
                    let arcId = null;
                    if (window.globalCurveRegistry) {
                        arcId = window.globalCurveRegistry.register({
                            type: 'arc', center: { x: circle.x, y: circle.y }, radius: radius,
                            startAngle: startAngle, endAngle: endAngle, clockwise: false, source: 'macro_roundrect_corner'
                        });
                    }

                    const pStart = { x: circle.x + radius * Math.cos(startAngle), y: circle.y + radius * Math.sin(startAngle), curveId: arcId };
                    const pEnd = { x: circle.x + radius * Math.cos(endAngle), y: circle.y + radius * Math.sin(endAngle), curveId: arcId };

                    const startIndex = points.length;
                    points.push(pStart, pEnd);
                    const endIndex = points.length - 1;

                    arcSegments.push({ startIndex, endIndex, center: {x: circle.x, y: circle.y}, radius, startAngle, endAngle, clockwise: false, curveId: arcId });
                }

                return { shape: 'polygon', points, arcSegments };
            }

            // Raw Polygon Fallback
            if (polygons.length > 0) {
                return polygons[0].points;
            }

            // Create bounding box
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const shape of shapes) {
                if (shape.type === 'circle') {
                    minX = Math.min(minX, shape.x - shape.radius);
                    minY = Math.min(minY, shape.y - shape.radius);
                    maxX = Math.max(maxX, shape.x + shape.radius);
                    maxY = Math.max(maxY, shape.y + shape.radius);
                }
            }

            if (isFinite(minX)) {
                return [
                    { x: minX, y: minY },
                    { x: maxX, y: minY },
                    { x: maxX, y: maxY },
                    { x: minX, y: maxY }
                ];
            }

            return null;
        }

        extractCoordinates(text) {
            const coords = {};

            // Allow optional decimal values
            const xMatch = text.match(/X([+-]?(?:\d+\.?\d*|\.\d+))/i);
            if (xMatch) coords.x = xMatch[1];

            const yMatch = text.match(/Y([+-]?(?:\d+\.?\d*|\.\d+))/i);
            if (yMatch) coords.y = yMatch[1];

            const iMatch = text.match(/I([+-]?(?:\d+\.?\d*|\.\d+))/i);
            if (iMatch) coords.i = iMatch[1];

            const jMatch = text.match(/J([+-]?(?:\d+\.?\d*|\.\d+))/i);
            if (jMatch) coords.j = jMatch[1];

            return Object.keys(coords).length > 0 ? coords : null;
        }

        executeCommands(commands) {
            for (const command of commands) {
                this.executeCommand(command);
                this.stats.commandsProcessed++;
            }

            // Handle unclosed region
            if (this.state.inRegion && this.state.regionPoints.length > 0) {
                this.warnings.push('File ended with unclosed region');
                this.finalizeRegion();
            }
        }

        executeCommand(command) {
            switch (command.type) {
                case 'SET_FORMAT':
                    this.state.format.integer = command.params.xInteger;
                    this.state.format.decimal = command.params.xDecimal;

                    // 'keep' leading zeros = 'trailing' zero suppression
                    this.state.format.zeroSuppression = command.params.leadingZeros === 'keep' ? 'trailing' : 'leading';

                    this.debug(`Format set to ${this.state.format.integer}.${this.state.format.decimal}`);
                    break;

                case 'SET_UNITS':
                    this.state.units = command.params.units;
                    this.layers.units = this.state.units;
                    this.debug(`Units set to ${this.state.units}`);
                    break;

                case 'SET_POLARITY':
                    this.state.polarity = command.params.polarity;
                    this.debug(`Polarity set to ${this.state.polarity}`);
                    break;

                case 'SET_INTERPOLATION':
                    this.state.interpolation = command.params.mode;
                    break;

                case 'DEFINE_APERTURE':
                    this.state.apertures.set(command.params.code, command.params);
                    break;

                case 'SELECT_APERTURE':
                    this.state.aperture = command.params.aperture;
                    break;

                case 'START_REGION':
                    if (!this.state.inRegion) {
                        this.state.inRegion = true;
                        this.state.regionPoints = [];
                    }
                    break;

                case 'END_REGION':
                    if (this.state.inRegion) {
                        this.finalizeRegion();
                        this.state.inRegion = false;
                        this.state.regionPoints = [];
                    }
                    break;

                case 'COORD_ACTION': {
                    // Update the modal state if a new D-code is explicitly provided on this line
                    if (command.operation) {
                        this.state.operationMode = command.operation;
                    }

                    // Default to DRAW if no operation has ever been specified
                    const opMode = this.state.operationMode || 'DRAW';
                    const pos = this.parsePosition(command.params);

                    if (opMode === 'FLASH') {
                        this.createFlash(pos);
                        this.state.position = pos;
                    } 
                    else if (opMode === 'MOVE') {
                        if (this.state.inRegion && this.state.regionPoints.length === 0) {
                            this.state.regionPoints.push(pos);
                        }
                        this.state.position = pos;
                    } 
                    else if (opMode === 'DRAW') {
                        if (!this.state.inRegion) {
                            // Check for Old zero-length trace segments there used were considered Flashes
                            const strictEpsilon = C.precision.epsilon; 
                            const isZeroLengthDraw = Math.abs(this.state.position.x - pos.x) <= strictEpsilon &&
                                                    Math.abs(this.state.position.y - pos.y) <= strictEpsilon;

                            if (isZeroLengthDraw) {
                                this.debug(`Detected strict zero-length draw at (${pos.x}, ${pos.y}). Treating as a flash.`);
                                this.createFlash(pos);
                                this.state.position = pos;
                                break;
                            }

                            // Parse arc offsets if present
                            let arcData = null;
                            if (command.params.i !== undefined || command.params.j !== undefined) {
                                arcData = {};
                                if (command.params.i !== undefined) {
                                    arcData.i = this.parseCoordinateValue(command.params.i, this.state.format);
                                    this.stats.coordinatesParsed++;
                                }
                                if (command.params.j !== undefined) {
                                    arcData.j = this.parseCoordinateValue(command.params.j, this.state.format);
                                    this.stats.coordinatesParsed++;
                                }
                            }

                            this.createTrace(this.state.position, pos, arcData);
                        } else {
                            if (this.state.regionPoints.length === 0) {
                                this.state.regionPoints.push({ ...this.state.position });
                            }

                            const regionPt = { ...pos };

                            // Extract arc data for region vertices (same logic as the non-region branch)
                            if (command.params.i !== undefined || command.params.j !== undefined) {
                                const arcI = command.params.i !== undefined
                                    ? this.parseCoordinateValue(command.params.i, this.state.format) : 0;
                                const arcJ = command.params.j !== undefined
                                    ? this.parseCoordinateValue(command.params.j, this.state.format) : 0;
                                this.stats.coordinatesParsed += (command.params.i !== undefined ? 1 : 0)
                                                            + (command.params.j !== undefined ? 1 : 0);

                                if (this.state.interpolation === 'cw_arc' || this.state.interpolation === 'ccw_arc') {
                                    const isCW = this.state.interpolation === 'cw_arc';
                                    const start = this.state.position;
                                    const center = { x: start.x + arcI, y: start.y + arcJ };
                                    const radius = Math.hypot(arcI, arcJ);
                                    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
                                    const endAngle = Math.atan2(pos.y - center.y, pos.x - center.x);

                                    if (window.globalCurveRegistry) {
                                        const curveId = window.globalCurveRegistry.register({
                                            type: 'arc',
                                            center: { x: center.x, y: center.y },
                                            radius: radius,
                                            startAngle: startAngle,
                                            endAngle: endAngle,
                                            clockwise: isCW,
                                            source: 'gerber_region'
                                        });

                                        if (curveId) {
                                            regionPt.curveId = curveId;
                                            // Tag the preceding point (arc start) so the segment is bounded
                                            const lastPt = this.state.regionPoints[this.state.regionPoints.length - 1];
                                            if (lastPt && !lastPt.curveId) {
                                                lastPt.curveId = curveId;
                                            }
                                        }
                                    }
                                }
                            }

                            this.state.regionPoints.push(regionPt);
                        }
                        this.state.position = pos;
                    }
                    break;
                }

                case 'EOF':
                    this.debug('End of file');
                    break;
            }
        }

        parsePosition(params) {
            const newPos = { ...this.state.position };

            if (params.x !== undefined) {
                newPos.x = this.parseCoordinateValue(params.x, this.state.format);
                this.stats.coordinatesParsed++;
            }

            if (params.y !== undefined) {
                newPos.y = this.parseCoordinateValue(params.y, this.state.format);
                this.stats.coordinatesParsed++;
            }

            return newPos;
        }

        finalizeRegion() {
            if (this.state.regionPoints.length < 3) {
                this.warnings.push(`Region with only ${this.state.regionPoints.length} points discarded`);
                return;
            }

            // ── Pass 1: Deduplicate consecutive near-identical vertices ──
            // Dense KiCad pour polygons have vertices <1μm apart at curve transitions. Without deduplication these create degenerate zero-length edges that confuse downstream boolean operations.
            const rawPoints = this.state.regionPoints;
            const deduped = [rawPoints[0]];

            for (let i = 1; i < rawPoints.length; i++) {
                const prev = deduped[deduped.length - 1];
                const curr = rawPoints[i];
                const dx = curr.x - prev.x;
                const dy = curr.y - prev.y;
                if (dx * dx + dy * dy > PRECISION * PRECISION || curr.curveId > 0 || prev.curveId > 0) {
                    deduped.push(curr);
                }
            }

            if (deduped.length < 3) {
                this.warnings.push(`Region collapsed to ${deduped.length} points after deduplication (from ${rawPoints.length})`);
                return;
            }

            if (rawPoints.length !== deduped.length) {
                this.debug(`Region vertex deduplication: ${rawPoints.length} → ${deduped.length} points`);
            }

            // ── Pass 2: Remove spike artifacts ──
            // Detect vertices where the polygon reverses direction within a precision-bound corridor (sawtooth patterns from ECAD export noise).
            //
            // RELAXED GATE: The dot-product threshold is now configurable via cosAngleGate. The original code used 0 (catches only >90° reversals).
            // A positive value like 0.25 catches shallower zigzags (~75°+) that KiCad's polygon approximation routinely produces. The perpendicular deviation test still protects intentional sharp features.
            const spikeTolerance = PRECISION * 4;
            const { points: cleaned, removed: spikesRemoved } = this.removeSpikeVertices(deduped, spikeTolerance);

            if (spikesRemoved > 0) {
                this.debug(`Region spike removal: ${deduped.length} → ${cleaned.length} points (${spikesRemoved} spikes removed)`);
            }

            if (cleaned.length < 3) {
                this.warnings.push(`Region collapsed to ${cleaned.length} points after spike removal (from ${rawPoints.length})`);
                return;
            }

            // ── Pass 3: Ramer-Douglas-Peucker simplification ──
            // REVIEW - Consider moving this to the plotter, for a lossless pipeline simplification and spike removal should be user managed during geometry generation. Parser shouldn't be making decisions.
            // Collapses near-collinear vertex runs and over-tessellated curve approximations that the spike detector doesn't catch (forward-progressing zigzags where dot > 0). This is the industry-standard algorithm for polyline simplification in GIS/CNC/CAD.
            // Tolerance rationale: the smallest meaningful PCB feature (trace-to-trace clearance) is typically ≥ 0.1mm.
            // A simplification tolerance of 0.005-0.01mm is invisible on copper but eliminates thousands of noise vertices that otherwise get amplified into sawtooth artifacts by the Clipper offset pipeline.
            const rdpTolerance = C.precision.rdpSimplification;
            // Arc endpoints must survive: a curveId point is the anchor the
            // reconstructor matches against, and losing one silently converts
            // an arc into a chord.
            const protectedIdx = new Set();
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i].curveId > 0) protectedIdx.add(i);
            }
            // Squared tolerance - GeometryUtils takes the square.
            const { points: simplified } = GeometryUtils.simplifyPolyline2D(
                cleaned, rdpTolerance * rdpTolerance, protectedIdx);

            if (simplified.length < 3) {
                this.warnings.push(`Region collapsed to ${simplified.length} points after RDP simplification`);
                return;
            }

            if (cleaned.length !== simplified.length) {
                this.debug(`Region RDP simplification: ${cleaned.length} → ${simplified.length} points (tolerance: ${rdpTolerance.toFixed(4)}mm)`);
            }

            let finalPoints = simplified;

            // ── Close region if needed ──
            const first = finalPoints[0];
            const last = finalPoints[finalPoints.length - 1];

            if (Math.abs(first.x - last.x) > PRECISION || Math.abs(first.y - last.y) > PRECISION) {
                finalPoints.push({ ...first });
            }

            // Build arcSegments array from curveId-tagged vertices
            const arcSegments = [];
            const uniqueCurveIds = new Set();

            for (let i = 1; i < finalPoints.length; i++) {
                const pt = finalPoints[i];
                if (pt.curveId && pt.curveId > 0 && window.globalCurveRegistry) {
                    const curve = window.globalCurveRegistry.getCurve(pt.curveId);
                    if (curve) {
                        arcSegments.push({
                            startIndex: i - 1,
                            endIndex: i,
                            center: curve.center,
                            radius: curve.radius,
                            startAngle: curve.startAngle,
                            endAngle: curve.endAngle,
                            clockwise: curve.clockwise,
                            curveId: pt.curveId
                        });
                        uniqueCurveIds.add(pt.curveId);
                    }
                }
            }

            // Create contours structure
            const contours = [{
                points: finalPoints,
                nestingLevel: 0,
                isHole: false,
                parentId: null,
                arcSegments: arcSegments,
                curveIds: Array.from(uniqueCurveIds)
            }];

            const region = {
                type: 'region',
                points: finalPoints,
                polarity: this.state.polarity,
                netName: this.state.currentNetName || null,
                contours: contours
            };

            this.layers.objects.push(region);
            this.stats.objectsCreated++;
            this.debug(`Created region with ${finalPoints.length} points`);
        }

        /**
         * Iteratively removes spike vertices from a polygon.
         *
         * A spike at vertex B (in sequence A→B→C) is detected when BOTH:
         *   1. dot(AB, BC) < 0 - the path reverses direction at B
         *      (the angle between consecutive edge vectors exceeds 90°)
         *   2. perpDistance(B, line AC) < tolerance - the reversal's deviation
         *      is below the precision-derived threshold
         *
         * Condition 1 guarantees that smooth curves, gentle corners, and pad clearance boundaries (which all have dot ≥ 0) are never touched.
         * Condition 2 guarantees that intentional sharp features with significant deviation (like thermal relief slots) are preserved.
         * Iterative passes handle cascading spikes: removing one spike makes its former neighbors adjacent, which may form a new spike.
         * Converges when no spikes are found in a pass.
         * @param {Array} points - Polygon vertices [{x, y}, ...].
         * @param {number} tolerance - Max perpendicular deviation in mm (from coordinate precision).
         * @returns {{ points: Array, removed: number }}
         */
        removeSpikeVertices(points, tolerance) {
            if (points.length <= 4) return { points, removed: 0 };

            const tolSq = tolerance * tolerance;
            let current = points;
            let removedTotal = 0;

            // Cap iterations to guarantee termination. In practice converges in 1-3 passes - each pass can only expose spikes that were previously shielded by an adjacent spike.
            const maxPasses = 8;

            for (let pass = 0; pass < maxPasses; pass++) {
                const n = current.length;
                const result = [current[0]];
                let removedThisPass = 0;

                for (let i = 1; i < n - 1; i++) {
                    // Use the already-filtered previous point so cascading spikes within a single pass are caught immediately
                    const A = result[result.length - 1];
                    const B = current[i];
                    const C = current[i + 1];

                    // Never remove vertices that belong to a registered analytic curve
                    if (B.curveId && B.curveId > 0) {
                        result.push(B);
                        continue;
                    }

                    const abx = B.x - A.x, aby = B.y - A.y;
                    const bcx = C.x - B.x, bcy = C.y - B.y;

                    // Test 1: Direction reversal - dot(AB, BC) < 0 means the angle between consecutive edges exceeds 90°.
                    // Smooth curves and legitimate corners have dot ≥ 0.
                    const dot = abx * bcx + aby * bcy;

                    if (dot < 0) {
                        // Test 2: Perpendicular deviation of B from line AC.
                        // Uses the cross product formula: height = |AC x AB| / |AC|
                        // Squared comparison avoids sqrt.
                        const acx = C.x - A.x, acy = C.y - A.y;
                        const acLenSq = acx * acx + acy * acy;

                        let deviationSq;
                        if (acLenSq < 1e-20) {
                            // A and C essentially coincide - full spike
                            deviationSq = abx * abx + aby * aby;
                        } else {
                            const cross = acx * aby - acy * abx;
                            deviationSq = (cross * cross) / acLenSq;
                        }

                        if (deviationSq < tolSq) {
                            removedThisPass++;
                            continue; // Skip vertex B
                        }
                    }

                    result.push(B);
                }

                result.push(current[n - 1]);
                removedTotal += removedThisPass;

                if (removedThisPass === 0) break; // Converged
                current = result;
            }

            return { points: current, removed: removedTotal };
        }

        createTrace(start, end, arcData = null) {
            if (!this.state.aperture) {
                this.warnings.push(`Draw operation without aperture at (${end.x}, ${end.y})`);
                return;
            }

            const aperture = this.state.apertures.get(this.state.aperture);
            if (!aperture) {
                this.warnings.push(`Undefined aperture ${this.state.aperture}`);
                return;
            }

            let traceWidth = formatConfig.defaultAperture;
            if (aperture.parameters && aperture.parameters.length > 0) {
                traceWidth = aperture.parameters[0];
            }

            const trace = {
                type: 'trace',
                start: { ...start },
                end: { ...end },
                width: traceWidth,
                aperture: this.state.aperture,
                polarity: this.state.polarity,
                netName: this.state.currentNetName || null,
                interpolation: this.state.interpolation
            };

            // Add arc data if present
            if (arcData && (this.state.interpolation === 'cw_arc' || this.state.interpolation === 'ccw_arc')) {
                trace.arc = arcData;
                trace.clockwise = this.state.interpolation === 'cw_arc';
                this.debug(`Created arc trace with offsets i=${arcData.i}, j=${arcData.j}`);
            }

            this.layers.objects.push(trace);
            this.stats.objectsCreated++;
        }

        createFlash(position) {
            if (!this.state.aperture) {
                this.warnings.push(`Flash operation without aperture at (${position.x}, ${position.y})`);
                return;
            }

            const aperture = this.state.apertures.get(this.state.aperture);
            if (!aperture) {
                this.warnings.push(`Undefined aperture ${this.state.aperture}`);
                return;
            }

            const flash = {
                type: 'flash',
                position: { ...position },
                aperture: this.state.aperture,
                polarity: this.state.polarity,
                netName: this.state.currentNetName || null,
                shape: aperture.shape
            };

            switch (aperture.shape) {
                case 'circle':
                    flash.radius = ((aperture.parameters[0] || 0) / 2);
                    flash.parameters = aperture.parameters.map(p => p);
                    break;

                case 'rectangle':
                case 'obround':
                    flash.width = (aperture.parameters[0] || 0);
                    flash.height = (aperture.parameters[1] !== undefined ? aperture.parameters[1] : aperture.parameters[0] || 0);
                    flash.parameters = aperture.parameters.map(p => p);
                    break;

                case 'macro':
                    // Execute the macro with provided variables
                    const macro = this.state.macros.get(aperture.macroName);
                    if (!macro) {
                        this.warnings.push(`Undefined macro: ${aperture.macroName}`);
                        return;
                    }

                    const macroShapes = this.executeMacro(macro, aperture.variables || [], position);

                    if (macroShapes.length === 0) {
                        this.warnings.push(`Macro ${aperture.macroName} produced no geometry`);
                        return;
                    }

                    const polyData = this.macroShapesToPolygon(macroShapes, position);

                    if (polyData) {
                        if (Array.isArray(polyData)) {
                             if (polyData.length >= 3) {
                                 flash.shape = 'polygon';
                                 flash.points = polyData;
                             }
                        } else {
                             flash.shape = polyData.shape || 'polygon';
                             flash.points = polyData.points;
                             flash.arcSegments = polyData.arcSegments;
                        }
                    } else {
                        // Fallback to circles if polygon conversion failed
                        const circles = macroShapes.filter(s => s.type === 'circle');
                        if (circles.length > 0) {
                            // Use first circle as approximation
                            flash.shape = 'circle';
                            flash.position = { x: circles[0].x, y: circles[0].y };
                            flash.radius = circles[0].radius;
                        } else {
                            this.warnings.push(`Could not convert macro ${aperture.macroName} to geometry`);
                            return;
                        }
                    }
                    break;

                default:
                     this.warnings.push(`Unsupported flash shape: ${aperture.shape}`);
                     return;
            }

            this.layers.objects.push(flash);
            this.stats.objectsCreated++;
        }

        finalizeParse() {
            // Remove duplicate traces
            this.layers.objects = this.removeDuplicateTraces(this.layers.objects);

            // Export apertures
            const apertureMap = new Map();
            this.layers.objects.forEach(obj => {
                if (obj.aperture) {
                    const aperture = this.state.apertures.get(obj.aperture);
                    if (aperture) {
                        apertureMap.set(aperture.code, aperture);
                    }
                }
            });

            this.layers.apertures = Array.from(apertureMap.values());

            // Calculate bounds
            this.layers.bounds = this.calculateBounds(this.layers.objects);

            // Mark the output with the parsed unit so it can be handled by the plotter
            this.layers.units = this.state.units;
        }

        getApertureShape(char) {
            switch (char) {
                case 'C': return 'circle';
                case 'R': return 'rectangle';
                case 'O': return 'obround';
                case 'P': return 'polygon';
                default: return 'unknown';
            }
        }
    }

    window.GerberParser = GerberParser;
})();