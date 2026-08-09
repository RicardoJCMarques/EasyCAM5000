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

(function() {
    'use strict';

    const PRECISION = window.CAMConfig.constants.precision.coordinate;

    class TraceStencilHandler extends BaseOperationHandler {

        async orchestrateGeneration(operation, params, core, options = {}) {
            const token = this.beginRun(operation, options, core);

            // Compile parameters
            const opParams = core.compileOperationParams(operation, params);
            await this.generateGeometry(operation, { ...params, ...opParams });

            if (this.isStale(operation, token)) {
                return { success: false, message: 'Generation superseded by a newer request', status: 'warning' };
            }

            const count = operation.offsets?.[0]?.primitives?.length || 0;
            const skipped = operation.offsets?.[0]?.metadata?.skippedPads || operation.stencilMetadata?.skippedPads || 0;

            if (count === 0) {
                const msg = skipped > 0
                    ? `No apertures generated (${skipped} overlapping pads skipped)`
                    : 'No apertures generated (all filtered out)';
                return { success: false, message: msg, status: 'warning' };
            }

            // CORE handles its own state
            operation.exportReady = true;
            operation.exportMetadata = {
                generatedAt: Date.now(),
                sourceOffsets: operation.offsets?.length || 0,
                strategy: 'stencil'
            };

            let msg = `Generated ${count} stencil aperture(s)`;
            if (skipped > 0) msg += ` (${skipped} overlapping pads skipped)`;
            return { success: true, message: msg, status: 'success' };
        }

        async generateGeometry(operation, settings) {
            // Clone to prevent mutating shared state
            settings = { ...settings };

            this.debug('=== STENCIL GEOMETRY GENERATION ===');

            if (!operation.primitives || operation.primitives.length === 0) {
                return [];
            }
            let primitivesToProcess;

            // Filter out non-pad geometry (traces, solid pours)
            if (settings.stencilIgnoreRegions) {
                primitivesToProcess = operation.primitives.filter(prim => {
                    const props = prim.properties || {};
                    if (props.isFlash || props.isPad) return true;
                    if (prim.type === 'circle' || prim.type === 'rectangle' || prim.type === 'obround') return true;
                    if (props.isTrace || props.stroke) return false;
                    if (prim.type === 'path' && props.fill && !props.isFlash) return false;
                    return false;
                });
                this.debug(`Filtered primitives: ${operation.primitives.length} → ${primitivesToProcess.length}`);
            } else {
                primitivesToProcess = [...operation.primitives];
            }

            // Filter out pads that sit over drill holes
            let skippedDueToDrill = 0;
            if (settings.stencilExcludeDrillPads && primitivesToProcess.length > 0) {
                const drillHoles = [];
                for (const op of this.core.operations) {
                    if (op.type !== 'drill' || !op.primitives) continue;
                    for (const prim of op.primitives) {
                        if (prim.properties?.role === 'drill_hole' && prim.center && prim.radius) {
                            drillHoles.push({ x: prim.center.x, y: prim.center.y, r: prim.radius });
                        }
                    }
                }

                if (drillHoles.length > 0) {
                    const beforeCount = primitivesToProcess.length;
                    primitivesToProcess = primitivesToProcess.filter(prim => {
                        const rep = GeometryUtils.getRepresentativePoint(prim);
                        if (!rep) return true;

                        for (const hole of drillHoles) {
                            const dist = Math.hypot(rep.x - hole.x, rep.y - hole.y);
                            const bounds = prim.getBounds();
                            const padRadius = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
                            if (dist < padRadius * 0.8) {
                                return false; // Pad overlaps a hole, discard it
                            }
                        }
                        return true;
                    });

                    skippedDueToDrill = beforeCount - primitivesToProcess.length;
                    this.debug(`Drill hole exclusion: ${beforeCount} → ${primitivesToProcess.length}`);
                }
            }

            // Emit Warnings and Abort if Empty
            if (!operation.warnings) operation.warnings = [];

            // Clear previous instances of this specific generation warning
            operation.warnings = operation.warnings.filter(w => {
                const msg = typeof w === 'string' ? w : w.message;
                return !msg.includes('stencil pad(s) because they overlapped');
            });

            if (skippedDueToDrill > 0) {
                operation.warnings.push({
                    message: `Excluded ${skippedDueToDrill} stencil pad(s) because they overlapped with through-holes.`,
                    severity: 'info'
                });
            }

            if (primitivesToProcess.length === 0) {
                this.debug('No valid stencil pads remaining. Aborting generation.');
                operation.offsets = []; // Clear any previous offsets
                operation.stencilMetadata = { skippedPads: skippedDueToDrill };

                // Clear any leftover stencil generation warnings from previous runs to keep properties clean
                if (operation.warnings) {
                    operation.warnings = operation.warnings.filter(w => {
                        const msg = typeof w === 'string' ? w : w.message;
                        return !msg.includes('stencil pad');
                    });
                }

                return []; // Early exit!
            }

            let processedGeometry = [];
            const offsetDist = settings.stencilOffset || 0;

            // Apply Aperture Shrink/Expand
            if (Math.abs(offsetDist) > PRECISION && this.core.geometryOffsetter) {
                this.debug(`Applying stencil offset: ${offsetDist.toFixed(3)}mm`);

                const onProgress = operation._onProgress || null;
                const padCount = primitivesToProcess.length;
                let padIdx = 0;

                for (const prim of primitivesToProcess) {
                    if (onProgress && padIdx > 0 && padIdx % 32 === 0) {
                        onProgress({ frac: padIdx / padCount, label: `Stencil ${padIdx}/${padCount} apertures` });
                        await new Promise(resolve => {
                            const ch = new MessageChannel();
                            ch.port1.onmessage = () => resolve();
                            ch.port2.postMessage(null);
                        });
                    }
                    padIdx++;

                    const offsetResult = await this.core.geometryOffsetter.offsetBoundary(prim, offsetDist);
                    if (offsetResult) {
                        if (Array.isArray(offsetResult)) {
                            processedGeometry.push(...offsetResult);
                        } else {
                            processedGeometry.push(offsetResult);
                        }
                    }
                }

                if (processedGeometry.length > 1 && this.core.geometryProcessor) {
                    try {
                        processedGeometry = await this.core.geometryProcessor.unionGeometry(processedGeometry);
                    } catch (e) {
                        this.debug(`Union after offset failed: ${e.message}, using raw offset results`);
                    }
                }
            } else {
                for (const prim of primitivesToProcess) {
                    if (prim.type === 'path') {
                        processedGeometry.push(prim);
                    } else {
                        const pathPrim = GeometryUtils.primitiveToPath(prim);
                        if (pathPrim) {
                            processedGeometry.push(pathPrim);
                        }
                    }
                }
            }

            // Add registration holes
            if (settings.stencilAddRegHoles) {
                const bounds = this.core.scene?.getBoardBounds?.() || operation.bounds;
                if (bounds && isFinite(bounds.minX)) {
                    const margin = settings.stencilRegMargin || 5.0;
                    const radius = (settings.stencilRegDiameter || 3.0) / 2;

                    const corners = [
                        { x: bounds.minX - margin, y: bounds.minY - margin },
                        { x: bounds.maxX + margin, y: bounds.minY - margin },
                        { x: bounds.minX - margin, y: bounds.maxY + margin },
                        { x: bounds.maxX + margin, y: bounds.maxY + margin }
                    ];

                    for (const center of corners) {
                        const regHole = new CirclePrimitive(center, radius, {
                            polarity: 'dark',
                            isRegistration: true,
                            role: 'registration_hole',
                            operationId: operation.id
                        });
                        processedGeometry.push(regHole);
                    }
                    this.debug(`Added 4 registration holes (r=${radius.toFixed(2)}mm, margin=${margin}mm)`);
                } else {
                    console.warn('[StencilHandler] Cannot add registration holes: board bounds not available');
                }
            }

            // Tag as stencil geometry
            processedGeometry.forEach(p => {
                if (!p.properties) p.properties = {};
                p.properties.operationType = 'stencil';
                p.properties.operationId = operation.id;
                p.properties.fill = false;
                p.properties.stroke = true;
                p.properties.strokeWidth = 1;
                p.properties.isOffset = true;
                p.properties.offsetType = 'external';
            });

            operation.offsets = [{
                distance: offsetDist,
                pass: 1,
                type: 'stencil',
                primitives: processedGeometry,
                metadata: {
                    strategy: 'offset',
                    isStencil: true,
                    finalCount: processedGeometry.length,
                    generatedAt: Date.now(),
                    skippedPads: skippedDueToDrill
                }
            }];

            operation.stencilMetadata = { skippedPads: skippedDueToDrill };

            this.debug(`Stencil generation complete: ${processedGeometry.length} primitives`);
            this.debug('=== STENCIL GEOMETRY COMPLETE ===');
            return operation.offsets;
        }
    }

    window.TraceStencilHandler = TraceStencilHandler;
})();