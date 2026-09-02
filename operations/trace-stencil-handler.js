/*!
 * @file        operations/trace-stencil-handler.js
 * @description Solder stencil aperture generation with drill pad exclusion
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

!function () {
    'use strict';
    const PRECISION = window.CAMConfig.constants.precision.coordinate;

    /**
     * Solder-stencil apertures. An aperture is a hole, so the geometry is an
     * internal offset and the whole shared offset pipeline applies; only the
     * pad filtering, the pass distance and the corner opening are its own.
     */
    class TraceStencilHandler extends OffsetOperationHandler {

        // Offset pipeline hooks

        isInternalOffset() { return this._stencil?.total < 0; }
        isOnLine() { return false; }

        /**
         * Collapse is a real outcome on a fine-pitch pad and the run reports
         * it; the guard would silently drop the cutter compensation instead.
         */
        shouldGuardCircleCollapse() { return false; }

        shouldSkipPrimitive(primitive) { return !!this._skip?.has(primitive); }

        /**
         * One pass. Only read when there is no corner radius - with one,
         * offsetSinglePrimitive drives both steps itself.
         */
        passDistance(passIndex) { return 0 === passIndex ? this._stencil.total : null; }

        /**
         * Three independent facts, and they compose in ONE order:
         *   margin  the paste margin, sizing the OPENING
         *   radius  the radius that opening's corners must have
         *   comp    the cutter inset, a machine fact, applied LAST
         * offsetPathViaBoolean only rounds the OUTSIDE of a turn, so an
         * inward offset leaves convex corners sharp: the rounding has to be
         * a grow. Doing it after the cutter inset (or folding the inset into
         * the distance) rounds the TOOL PATH, and the cut aperture comes out
         * at radius + comp. Shrink past the target, then grow back to it.
         */
        resolveStencilOffsets(operation, settings) {
            const isRouter = 'router' === this.core.machineClassOf(operation);
            const comp = isRouter ? (settings.toolDiameter || 0) / 2 : 0;
            // CNC routers ignore corner radius even if it's set
            const radius = isRouter ? 0 : Math.max(0, settings.stencilCornerRadius || 0);
            const margin = settings.stencilOffset || 0;
            return { comp, radius, margin, shrink: margin - radius, grow: radius - comp, total: margin - comp };
        }


        async offsetSinglePrimitive(primitive, distance) {
            const o = this._stencil;
            const collect = r => Array.isArray(r) ? r : r ? [r] : [];

            // A registration hole is a locating feature, not an aperture: the
            // paste margin and the corner radius do not apply to it, only the
            // cutter radius.
            if ('registration_hole' === primitive.properties?.role) {
                return o.comp > PRECISION ? super.offsetSinglePrimitive(primitive, -o.comp) : primitive;
            }

            if (o.radius <= PRECISION) return super.offsetSinglePrimitive(primitive, distance);

            const shrunk = Math.abs(o.shrink) <= PRECISION
                ? [primitive]
                : collect(await super.offsetSinglePrimitive(primitive, o.shrink));

            // Too small to survive the shrink: cut it square rather than let
            // the opening delete a fine-pitch pad.
            if (0 === shrunk.length) {
                this._squareCornered++;
                return super.offsetSinglePrimitive(primitive, o.total);
            }
            if (Math.abs(o.grow) <= PRECISION) return shrunk;

            const out = [];
            for (const piece of shrunk) out.push(...collect(await super.offsetSinglePrimitive(piece, o.grow)));
            return out;
        }

        // Stencil specifics

        /**
         * Four corner pins, outside the board by `margin`. Nominal size: the
         * offset pass compensates them for the cutter.
         */
        buildRegistrationHoles(operation, settings) {
            if (!settings.stencilAddRegHoles) return [];
            const bounds = this.core.scene?.getBoardBounds?.() || operation.bounds;
            if (!bounds || !isFinite(bounds.minX)) {
                operation.warnings.push({ message: 'Registration holes skipped - no board bounds available.', severity: 'warning' });
                return [];
            }
            const margin = settings.stencilRegMargin || 5;
            const radius = (settings.stencilRegDiameter || 3) / 2;
            return [
                { x: bounds.minX - margin, y: bounds.minY - margin },
                { x: bounds.maxX + margin, y: bounds.minY - margin },
                { x: bounds.minX - margin, y: bounds.maxY + margin },
                { x: bounds.maxX + margin, y: bounds.maxY + margin }
            ].map(center => new CirclePrimitive(center, radius, {
                polarity: 'dark', isRegistration: true, role: 'registration_hole', operationId: operation.id
            }));
        }

        /**
         * Aperture styling and the metadata the panel summaries read.
         */
        finishStencil(operation, settings) {
            const record = operation.offsets?.[0];
            if (!record) return;

            // Apertures are openings, so they draw as outlines, not fills.
            for (const p of record.primitives) {
                p.properties ||= {};
                p.properties.operationType = 'stencil';
                p.properties.operationId = operation.id;
                p.properties.fill = false;
                p.properties.stroke = true;
                p.properties.strokeWidth = 0;
            }

            record.type = 'stencil';
            record.metadata = {
                ...record.metadata,
                strategy: 'offset',
                isStencil: true,
                finalCount: record.primitives.length,
                toolDiameter: settings.toolDiameter || 0,
                cornerRadius: this._stencil.radius,
                actualWidth: Math.abs(this._stencil.total),
                skippedPads: operation.stencilMetadata?.skippedPads || 0
            };

            if (this._squareCornered > 0) {
                operation.warnings.push({
                    message: `${this._squareCornered} aperture(s) too small for a ${this._stencil.radius.toFixed(2)}mm corner radius - left square.`,
                    severity: 'info'
                });
            }
        }

        /**
         * Primitives the offset pass must ignore: non-pad geometry when the
         * user asked for it, and pads sitting over a through-hole.
         * @returns {{skip: Set, skippedPads: number}}
         */
        buildSkipSet(operation, settings) {
            const skip = new Set();
            const source = operation.primitives || [];

            if (settings.stencilIgnoreRegions) {
                for (const prim of source) {
                    if (prim.properties?.isRegistration || 'registration_hole' === prim.properties?.role) continue;
                    const props = prim.properties || {};
                    const isPad = props.isFlash || props.isPad || 'circle' === prim.type || 'rectangle' === prim.type || 'obround' === prim.type;
                    if (!isPad) skip.add(prim);
                }
            }

            let skippedPads = 0;
            if (settings.stencilExcludeDrillPads) {
                const holes = [];
                for (const op of this.core.operations) {
                    if ('drill' !== op.type || !op.primitives) continue;
                    for (const prim of op.primitives) {
                        if ('drill_hole' === prim.properties?.role && prim.center && prim.radius) holes.push({ x: prim.center.x, y: prim.center.y });
                    }
                }
                if (holes.length > 0) {
                    for (const prim of source) {
                        if (prim.properties?.isRegistration || 'registration_hole' === prim.properties?.role || skip.has(prim)) continue;
                        const rep = GeometryUtils.getRepresentativePoint(prim);
                        if (!rep) continue;
                        const b = prim.getBounds();
                        const padRadius = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
                        for (const hole of holes) {
                            if (Math.hypot(rep.x - hole.x, rep.y - hole.y) < 0.8 * padRadius) { skip.add(prim); skippedPads++; break; }
                        }
                    }
                }
            }
            return { skip, skippedPads };
        }

        // Entry points

        async generateGeometry(operation, settings) {
            const source = operation.primitives || [];
            const regHoles = this.buildRegistrationHoles(operation, settings);
            operation.primitives = regHoles.length > 0 ? [...source, ...regHoles] : source;

            try {
                const { skip, skippedPads } = this.buildSkipSet(operation, settings);
                this._skip = skip;
                this._stencil = this.resolveStencilOffsets(operation, settings);
                this._squareCornered = 0;

                const OWN = ['stencil pad(s) because they overlapped', 'corner radius', 'Registration holes skipped'];
                operation.warnings = (operation.warnings || []).filter(w => {
                    const msg = 'string' == typeof w ? w : w.message;
                    return !OWN.some(token => msg.includes(token));
                });
                if (skippedPads > 0) operation.warnings.push({
                    message: `Excluded ${skippedPads} stencil pad(s) because they overlapped with through-holes.`,
                    severity: 'info'
                });
                // A cutter cannot leave a corner tighter than its own radius.
                if (this._stencil.radius > PRECISION && this._stencil.grow < -PRECISION) {
                    operation.warnings.push({
                        message: `Corner radius ${this._stencil.radius.toFixed(2)}mm is below the cutter radius ${this._stencil.comp.toFixed(2)}mm - apertures will come out with ${this._stencil.comp.toFixed(2)}mm corners.`,
                        severity: 'warning'
                    });
                }

                operation.stencilMetadata = { skippedPads };
                if ((operation.primitives?.length || 0) - skip.size <= 0) {
                    operation.offsets = [];
                    return [];
                }

                await super.generateGeometry(operation, settings);
            } finally {
                operation.primitives = source;
            }

            this.finishStencil(operation, settings);
            return operation.offsets;
        }

        async orchestrateGeneration(operation, params, core, options = {}) {
            if ("router" === core.machineClassOf(operation) && !(params.toolDiameter > 0)) {
                return {
                    success: false,
                    status: 'warning',
                    message: 'CNC stencil milling requires a valid tool diameter. Select a tool in the Geometry stage.'
                };
            }
            const result = await super.orchestrateGeneration(operation, params, core, options);
            const count = operation.offsets?.[0]?.primitives?.length || 0;
            const skipped = operation.stencilMetadata?.skippedPads || 0;
            const suffix = skipped > 0 ? ` (${skipped} overlapping pads skipped)` : '';
            if (0 === count) return { success: false, status: 'warning', message: `No apertures generated${suffix || ' (all filtered out)'}` };
            return { ...result, success: true, status: 'success', message: `Generated ${count} stencil aperture(s)${suffix}` };
        }

    }
    window.TraceStencilHandler = TraceStencilHandler;
}();