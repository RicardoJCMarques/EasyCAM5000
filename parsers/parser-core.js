/*!
 * @file        parsers/parser-core.js
 * @description Shared parsing infrastructure for all file formats
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
    const debugState = D.debug;
    const validationConfig = debugState.validation;

    class ParserCore {
        constructor(options = {}) {
            this.options = {
                units: 'mm',
                format: { integer: 3, decimal: 3 },
                ...options
            };

            // Common state
            this.errors = [];
            this.warnings = [];
            this.bounds = null;

            // Statistics
            this.stats = {
                linesProcessed: 0,
                objectsCreated: 0,
                coordinatesParsed: 0,
                commandsProcessed: 0
            };

            // Coordinate validation
            this.coordinateValidation = {
                coordinateRange: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
                suspiciousCoordinates: []
            };
        }

        // Common parsing utilities
        parseCoordinateValue(value, format) {
            if (typeof value === 'number') {
                return value;
            }

            let valueStr = String(value).trim();

            // Handle decimal notation
            if (valueStr.includes('.')) {
                let coord = parseFloat(valueStr);
                if (!Number.isFinite(coord)) {
                    throw new Error(`Invalid decimal coordinate: ${value}`);
                }
                return coord;
            }

            const negative = valueStr.startsWith('-');
            let absValue = valueStr.replace(/^[+-]/, '');

            const expectedLength = format.integer + format.decimal;
            const zeroSuppression = this.options.zeroSuppression || this.state?.format?.zeroSuppression || 'leading';

            if (zeroSuppression === 'trailing') {
                // Trailing zero suppression means the number MUST be padded to the right
                // e.g. "0221" -> "0221000" in 2.5 format
                while (absValue.length < expectedLength) {
                    absValue += '0';
                }
            } else {
                // Leading zero suppression means the number MUST be padded to the left
                // e.g. "221" -> "0000221" in 2.5 format
                while (absValue.length < expectedLength) {
                    absValue = '0' + absValue;
                }
            }

            let coord = parseInt(absValue, 10) / Math.pow(10, format.decimal);

            if (!Number.isFinite(coord)) {
                throw new Error(`Invalid formatted coordinate: ${value}`);
            }

            return negative ? -coord : coord;
        }

        updateCoordinateRange(coordinates) {
            const range = this.coordinateValidation.coordinateRange;
            range.minX = Math.min(range.minX, coordinates.x);
            range.minY = Math.min(range.minY, coordinates.y);
            range.maxX = Math.max(range.maxX, coordinates.x);
            range.maxY = Math.max(range.maxY, coordinates.y);
        }

        calculateBounds(objects) {
            if (!objects || objects.length === 0) {
                return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }

            let minX = Infinity, minY = Infinity;
            let maxX = -Infinity, maxY = -Infinity;

            objects.forEach(obj => {
                const bounds = this.getObjectBounds(obj);
                if (bounds) {
                    minX = Math.min(minX, bounds.minX);
                    minY = Math.min(minY, bounds.minY);
                    maxX = Math.max(maxX, bounds.maxX);
                    maxY = Math.max(maxY, bounds.maxY);
                }
            });

            if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
                const msg = '[Parser-Core] Non-finite geometry bounds - source produced NaN/Infinite coordinates (check transforms/units).';
                // REVIEW - This should be an explicit error?
                this.warnings.push(msg);
                console.warn(`[ParserCore] ${msg}`);
                return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
            }

            return { minX, minY, maxX, maxY };
        }

        getObjectBounds(obj) {
            switch (obj.type) {
                case 'region':
                    return GeometryUtils.boundsOfPoints(obj.points);
                case 'trace': {
                    const halfWidth = (obj.width || 0) / 2;
                    // SVG linear_path traces carry points; Gerber traces carry start/end
                    // REVIEW - why not standardize traces to have points? first point is start last point is end?
                    const b = obj.points && obj.points.length > 0
                        ? GeometryUtils.boundsOfPoints(obj.points)
                        : GeometryUtils.boundsOfPoints([obj.start, obj.end]);
                    if (!b) return null;
                    return {
                        minX: b.minX - halfWidth, minY: b.minY - halfWidth,
                        maxX: b.maxX + halfWidth, maxY: b.maxY + halfWidth
                    };
                }
                case 'flash': {
                    const radius = obj.radius ||
                        (Math.max(obj.width || 0, obj.height || 0) / 2) ||
                        ((obj.parameters && obj.parameters[0]) ? obj.parameters[0] / 2 : 0.5);
                    return {
                        minX: obj.position.x - radius, minY: obj.position.y - radius,
                        maxX: obj.position.x + radius, maxY: obj.position.y + radius
                    };
                }
                case 'hole':
                case 'drill': {
                    const radius = obj.diameter ? obj.diameter / 2 : 0.5;
                    return {
                        minX: obj.position.x - radius, minY: obj.position.y - radius,
                        maxX: obj.position.x + radius, maxY: obj.position.y + radius
                    };
                }
                default:
                    return null;
            }
        }

        calculateWinding(points) {
            if (typeof GeometryUtils !== 'undefined' && GeometryUtils.calculateWinding) {
                return GeometryUtils.calculateWinding(points);
            }
        }

        isClockwise(points) {
            if (typeof GeometryUtils !== 'undefined' && GeometryUtils.isClockwise) {
                return GeometryUtils.isClockwise(points);
            }
            return this.calculateWinding(points) < 0;
        }

        // Edge deduplication utilities
        createEdgeKey(p1, p2) {
            const edgeKeyDecimals = C.geometry.edgeKeyDecimals;
            const x1 = p1.x.toFixed(edgeKeyDecimals);
            const y1 = p1.y.toFixed(edgeKeyDecimals);
            const x2 = p2.x.toFixed(edgeKeyDecimals);
            const y2 = p2.y.toFixed(edgeKeyDecimals);
            return `${x1},${y1}-${x2},${y2}`;
        }

        buildEdgeMap(regions) {
            const edgeMap = new Map();

            regions.forEach((region, idx) => {
                if (!region.points || region.points.length < 2) return;

                for (let i = 0; i < region.points.length - 1; i++) {
                    const p1 = region.points[i];
                    const p2 = region.points[i + 1];
                    const edgeKey = this.createEdgeKey(p1, p2);
                    edgeMap.set(edgeKey, `region${idx}_edge${i}`);

                    // Store reverse edge for bidirectional matching
                    const reverseKey = this.createEdgeKey(p2, p1);
                    edgeMap.set(reverseKey, `region${idx}_edge${i}_reverse`);
                }
            });

            return edgeMap;
        }

        removeDuplicateTraces(objects) {
            const regions = objects.filter(obj => obj.type === 'region');
            if (regions.length === 0) return objects;

            const edgeMap = this.buildEdgeMap(regions);
            const kept = [];
            let removedCount = 0;

            objects.forEach(obj => {
                if (obj.type !== 'trace') {
                    kept.push(obj);
                    return;
                }

                const edgeKey = this.createEdgeKey(obj.start, obj.end);
                const reverseKey = this.createEdgeKey(obj.end, obj.start);

                if (edgeMap.has(edgeKey) || edgeMap.has(reverseKey)) {
                    removedCount++;
                    this.debug(`Removed duplicate trace: (${obj.start.x.toFixed(3)}, ${obj.start.y.toFixed(3)}) to (${obj.end.x.toFixed(3)}, ${obj.end.y.toFixed(3)})`);
                } else {
                    kept.push(obj);
                }
            });

            if (removedCount > 0) {
                this.debug(`Removed ${removedCount} duplicate traces`);

            }

            return kept;
        }

        // Logging utilities
        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[ParserCore] ${message}`, data)
                 : console.log(`[ParserCore] ${message}`);
        }

        logStatistics() {
            if (!debugState.enabled) return;

            this.debug('Parse Statistics:');
            this.debug(`  Lines processed: ${this.stats.linesProcessed}`);
            this.debug(`  Objects created: ${this.stats.objectsCreated}`);
            this.debug(`  Commands processed: ${this.stats.commandsProcessed}`);
            this.debug(`  Coordinates parsed: ${this.stats.coordinatesParsed}`);
        }
    }

    window.ParserCore = ParserCore;
})();