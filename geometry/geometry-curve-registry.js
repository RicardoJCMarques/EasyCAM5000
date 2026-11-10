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

  const ROOT = globalThis;

  /**
   * Session-lifetime store: clear() has no call site, by design.
   * Generated geometry holds live curveIds (points[].curveId and every
   * arcSegment.curveId), in EasyShape across every bucket. Clearing while
   * any of it exists makes getCurve() miss, and those circles degrade to
   * polylines on the next preview, render or export. Growth is harmless:
   * identical curves dedupe through hashToId, and the 24-bit id space
   * (16.7M) outlasts any session. The only safe call site would be a
   * project reset that drops every operation and its offsets at once;
   * none exists.
   */
  class GlobalCurveRegistry {
    constructor() {
      this.registry = new Map();
      this.hashToId = new Map();
      this.nextId = 1;
      this.stats = {
        registered: 0,
        circles: 0,
        arcs: 0,
        endCaps: 0
      };
    }

    generateHash(metadata) {
      const hashPrecision = 1000; // centres, radii and angles round to 0.001
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
      if (metadata.isOffsetDerived) str += '_offset';

      // Return the unique string directly to eliminate any mathematical collisions
      return str;
    }

    register(metadata) {
      if (!metadata || !metadata.center || metadata.radius === undefined) return null // REVIEW - Useles safety check?

      // Default to CCW if not specified (safer for end-capsin)
      if (metadata.clockwise === undefined) metadata.clockwise = false;

      const hash = this.generateHash(metadata);

      if (this.hashToId.has(hash)) return this.hashToId.get(hash);

      const curveData = {
        ...metadata,
        clockwise: metadata.clockwise,
        isOffsetDerived: metadata.isOffsetDerived || false
      };

      const id = this.nextId++;
      this.registry.set(id, curveData);
      this.hashToId.set(hash, id);

      this.stats.registered++;
      if (metadata.type === 'circle') this.stats.circles++;
      else if (metadata.type === 'arc') this.stats.arcs++;
      if (metadata.source === 'end_cap' || metadata.source === 'arc_end_cap') this.stats.endCaps++;

      return id;
    }

    /**
     * The registry's only read path. Not a delegator: `this.registry` here
     * is this class's own private Map, not another object's API.
     */
    getCurve(id) {
      return this.registry.get(id);
    }

    getStats() {
      return {
        ...this.stats,
        registrySize: this.registry.size
      };
    }
  }

  ROOT.globalCurveRegistry = new GlobalCurveRegistry();
})();