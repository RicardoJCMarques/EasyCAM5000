/*!
 * @file        geometry/geometry-curve-registry.js
 * @description Curve Registry required for arc-reconstruction
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

    /**
     * Session-lifetime store, and it stays that way. clear() has no call site
     * BY DESIGN - this is a settled decision, not an oversight.
     *
     * Why not clear it: every curveId in the registry is a LIVE REFERENCE held
     * by already-generated geometry - operation.offsets[].primitives[]
     * .contours[].points[].curveId, and every arcSegment.curveId. In EasyShape
     * each bucket holds its own offsets but they all point at this one map.
     * Clearing while any bucket still has geometry makes getCurve() return
     * undefined, analyzeCircleRing report 'not-a-circle', and every circle in
     * that geometry silently degrade to a polyline on the next preview,
     * re-render or export. Wiring clear() to regeneration or scene-clear
     * re-creates exactly the class of bug the arc-reconstruction rework fixed.
     *
     * Why growth is not a problem: identical geometry dedupes through hashToId,
     * so replays cost nothing. Only genuinely new curves (new radius from a
     * tool or stepover change, a moved or scaled shape) allocate. Ids are
     * 24-bit in the Clipper Z word - 16.7M before collision, which a few
     * hundred new curves per generation will not approach in any real session.
     *
     * The ONLY safe call site is a true project reset that discards every
     * operation and all of its offsets in the same action. There is no such
     * entry point today. Do not add the call anywhere else.
     */
    class GlobalCurveRegistry {
        constructor() {
            this.registry = new Map();
            this.hashToId = new Map();
            this.offsetCurveMap = new Map();
            this.nextId = 1;

            // Statistics
            this.stats = {
                registered: 0,
                circles: 0,
                arcs: 0,
                endCaps: 0,
                offsetDerived: 0
            };
        }

        generateHash(metadata) {
            const hashPrecision = C.geometry.curveRegistry.hashPrecision;
            const roundedCenter = {
                x: Math.round(metadata.center.x * hashPrecision) / hashPrecision,
                y: Math.round(metadata.center.y * hashPrecision) / hashPrecision
            };
            const roundedRadius = Math.round(metadata.radius * hashPrecision) / hashPrecision;

            let str = `${metadata.type}_${roundedCenter.x}_${roundedCenter.y}_${roundedRadius}`;

            if (metadata.type === 'arc') {
                const roundedStartAngle = Math.round((metadata.startAngle || 0) * hashPrecision) / hashPrecision;
                const roundedEndAngle = Math.round((metadata.endAngle || Math.PI * 2) * hashPrecision) / hashPrecision;
                str += `_${roundedStartAngle}_${roundedEndAngle}`;
            }

            // Clockwise flag differentiates CW/CCW curves of the same geometry.
            // Required for ALL types so that reverseContourWinding() can register
            // flipped curves as distinct registry entries.
            str += `_${metadata.clockwise === true}`;

            // Include offset flag in hash to separate source from offset curves
            if (metadata.isOffsetDerived) {
                str += '_offset';
            }

            // Return the unique string directly to eliminate any mathematical collisions
            return str; 
        }

        register(metadata) {
            if (!metadata || !metadata.center || metadata.radius === undefined) {
                return null;
            }

            // Default to CCW if not specified (safer for end-capsin)
            if (metadata.clockwise === undefined) {
                metadata.clockwise = false;
            }

            const hash = this.generateHash(metadata);

            if (this.hashToId.has(hash)) {
                return this.hashToId.get(hash);
            }

            const curveData = {
                ...metadata,
                clockwise: metadata.clockwise,
                isOffsetDerived: metadata.isOffsetDerived || false
            };

            const id = this.nextId++;
            this.registry.set(id, curveData);
            this.hashToId.set(hash, id);

            // Track offset-derived curves
            if (metadata.isOffsetDerived) {
                this.offsetCurveMap.set(id, {
                    sourceId: metadata.sourceCurveId,
                    offsetDistance: metadata.offsetDistance
                });
                this.stats.offsetDerived++;
            }

            this.stats.registered++;
            if (metadata.type === 'circle') this.stats.circles++;
            else if (metadata.type === 'arc') this.stats.arcs++;
            if (metadata.source === 'end_cap' || metadata.source === 'arc_end_cap') this.stats.endCaps++;

            return id;
        }

        getCurve(id) {
            return this.registry.get(id);
        }

        /**
         * Records offset provenance WITHOUT touching the hashed record.
         * generateHash() folds isOffsetDerived into the key, so mutating a
         * stored curve after register() desynchronises hashToId permanently.
         */
        noteOffsetDerived(curveId, sourceCurveId, offsetDistance) {
            if (!curveId || !this.registry.has(curveId)) return;
            if (this.offsetCurveMap.has(curveId)) return;
            this.offsetCurveMap.set(curveId, { sourceId: sourceCurveId, offsetDistance });
            this.stats.offsetDerived++;
        }

        getOffsetInfo(curveId) {
            return this.offsetCurveMap.get(curveId);
        }

        /*
        clear() {
            this.registry.clear();
            this.hashToId.clear();
            this.offsetCurveMap.clear();
            this.nextId = 1;
            this.stats = {
                registered: 0,
                circles: 0,
                arcs: 0,
                endCaps: 0,
                offsetDerived: 0
            };
        }
        */

        getStats() {
            return {
                ...this.stats,
                registrySize: this.registry.size
            };
        }
    }

    window.GlobalCurveRegistry = GlobalCurveRegistry;             // The Blueprint
    window.globalCurveRegistry = new GlobalCurveRegistry();       // The Live Data Container
})();