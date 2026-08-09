/*!
 * @file        geometry/geometry-arc-reconstructor.js
 * @description Custom built system to recover arcs after Clipper2 booleans
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
    const PRECISION = C.precision.coordinate;
    const debugState = window.CAMConfig.defaults.debug;

    class ArcReconstructor {
        constructor(options = {}) {
            this.options = {
                scale: options.scale
            };

            // Simplified thresholds
            const arcConfig = C.geometry.arcReconstruction;
            this.minArcPoints = arcConfig.minArcPoints;

            // Use global registry
            this.registry = window.globalCurveRegistry;
            if (!this.registry) {
                throw new Error('[ArcReconstructor] Global curve registry not found! Arc reconstruction isn\'t possible without it.');
            }

            // Statistics
            this.stats = {
                reconstructed: 0,
                partialArcs: 0,
                fullCircles: 0,
                pathsWithCurves: 0,
                groupsFound: 0,
                wrappedGroups: 0
            };
        }

        // Clear all registered curves
        clear() {
            this.stats = {
                reconstructed: 0,
                partialArcs: 0,
                fullCircles: 0,
                pathsWithCurves: 0,
                groupsFound: 0,
                wrappedGroups: 0
            };
            this.debug('Stats reset');
        }

        // Get curve by ID from global registry
        getCurve(id) {
            return this.registry.getCurve(id);
        }

        // Main reconstruction method - process fused primitives
        processForReconstruction(primitives) {
            this.debug(`processForReconstruction() called with ${primitives ? primitives.length : 0} primitives.`);
            if (!primitives || primitives.length === 0) return primitives;

            const reconstructed = [];
            for (const primitive of primitives) {
                // Check if this is a composite primitive with arcs
                if (primitive.type === 'path' && this.hasAnyCurveData(primitive)) {
                    reconstructed.push(...this.reconstructPrimitive(primitive));
                } else {
                    reconstructed.push(primitive);
                }
            }

            if (debugState.enabled) {
                const holes = reconstructed.filter(p => p.properties?.isHole).length;
                console.log(`[ArcReconstructor] Results: ${primitives.length} → ${reconstructed.length} primitives (${holes} holes)`);
                console.log(`[ArcReconstructor] Full circles: ${this.stats.fullCircles}, Partial arcs: ${this.stats.partialArcs}`);
            }

            return reconstructed;
        }

        hasAnyCurveData(primitive) {
            if (!primitive.contours) return false;
            return primitive.contours.some(c =>
                (c.curveIds && c.curveIds.length > 0) ||
                (c.arcSegments && c.arcSegments.length > 0) ||
                (c.points && c.points.some(p => p.curveId > 0))
            );
        }

        reconstructPrimitive(primitive) {
            if (!primitive.contours || primitive.contours.length === 0) return [primitive];

            this.stats.pathsWithCurves++;
            const isClosed = primitive.closed !== false;
            const isLoneContour = primitive.contours.length === 1;

            const reconstructedContours = [];

            for (const contour of primitive.contours) {
                if (!contour.points || contour.points.length < 3) {
                    reconstructedContours.push(contour);
                    continue;
                }

                this.recoverLostMetadata(contour.points, isClosed);
                const groups = this.groupPointsWithGaps(contour.points, isClosed);

                // A circular HOLE is as much a circle as a lone outer ring, so the
                // promotion runs per contour. Alone it becomes a CirclePrimitive;
                // inside a compound the ring stays a contour carrying one 2*PI arc,
                // which the translator emits as a single G2/G3.
                // REVIEW - This may be true but arc and analtic circle offsets are very different.
                const ring = (groups.length === 1 && groups[0].type === 'curve')
                    ? GeometryUtils.analyzeCircleRing(groups[0].points)
                    : null;

                if (ring && ring.isFullCircle) {
                    this.stats.fullCircles++;
                    this.stats.reconstructed++;

                    if (isLoneContour) {
                        return [this.attemptFullCircleReconstruction(ring, primitive)];
                    }
                    reconstructedContours.push(this.fullCircleContour(contour, groups[0], ring));
                    continue;
                }

                if (ring) {
                    this.debug(`Full circle rejected (${ring.reason}): id=${ring.curveId ?? 'none'} ` +
                        `pts=${groups[0].points.length} sweep=${(ring.closedSweep ?? 0).toFixed(5)} ` +
                        `endGap=${(ring.endGap ?? 0).toFixed(5)} chord=${(ring.chord ?? 0).toFixed(5)}`);
                }

                const reconstructed = this.reconstructSingleContour(contour, isClosed, groups);
                if (reconstructed) reconstructedContours.push(reconstructed);
            }

            if (reconstructedContours.length === 0) return [primitive];

            return [new PathPrimitive(reconstructedContours, {
                ...primitive.properties,
                hasDetectedArcs: reconstructedContours.some(c => c.arcSegments && c.arcSegments.length > 0)
            })];
        }

        reconstructSingleContour(contour, isClosed, precomputedGroups = null) {
            if (!contour.points || contour.points.length < 3) return contour;

            const originalPointCount = contour.points.length;
            let groups = precomputedGroups;
            if (!groups) {
                this.recoverLostMetadata(contour.points, isClosed);
                groups = this.groupPointsWithGaps(contour.points, isClosed);
            }

            const newPoints = [];
            const detectedArcSegments = [];

            for (const group of groups) {
                if (group.type === 'curve' && group.points.length >= this.minArcPoints) {
                    const curveData = this.getCurve(group.curveId);

                    if (curveData) {
                        const arcFromPoints = this.calculateArcFromPoints(group.points, curveData);

                        if (arcFromPoints && this.isArcWorthReconstruction(arcFromPoints, group.points)) {
                            // Extract exact endpoints from the group body
                            const startPoint = group.points[0];
                            const endPoint = group.points[group.points.length - 1];

                            newPoints.push(startPoint);
                            const arcStartIdx = newPoints.length - 1;

                            this.stats.partialArcs++;
                            newPoints.push(endPoint);

                            const arcEndIdx = newPoints.length - 1;

                            detectedArcSegments.push({
                                startIndex: arcStartIdx,
                                endIndex: arcEndIdx,
                                center: arcFromPoints.center,
                                radius: arcFromPoints.radius,
                                startAngle: arcFromPoints.startAngle,
                                endAngle: arcFromPoints.endAngle,
                                sweepAngle: arcFromPoints.sweepAngle,
                                clockwise: arcFromPoints.clockwise,
                                curveId: group.curveId
                            });
                        } else {
                            for (const p of group.points) {
                                newPoints.push({ x: p.x, y: p.y });
                            }
                        }
                    } else {
                        for (const p of group.points) {
                            newPoints.push({ x: p.x, y: p.y });
                        }
                    }
                } else {
                    // For straight groups, dedup the first point against the last in newPoints
                    const groupPts = group.points;
                    let startIdx = 0;
                    if (newPoints.length > 0 && groupPts.length > 0) {
                        const last = newPoints[newPoints.length - 1];
                        const first = groupPts[0];
                        const dx = last.x - first.x;
                        const dy = last.y - first.y;
                        if ((dx * dx + dy * dy) <= 1e-9) {
                            startIdx = 1; // skip duplicate point
                        }
                    }
                    for (let i = startIdx; i < groupPts.length; i++) {
                        newPoints.push(groupPts[i]);
                    }
                }
            }

            // Deduplicate adjacent points and remap arc indices
            const dedupedPoints = [newPoints[0]];
            const indexRemap = [0];

            // Protect arc endpoints from deduplication so 360-degree sweeps survive
            const protectedIndices = new Set();
            detectedArcSegments.forEach(arc => {
                protectedIndices.add(arc.startIndex);
                protectedIndices.add(arc.endIndex);
            });

            // Preserve protected indices
            for (let j = 1; j < newPoints.length; j++) {
                const prev = dedupedPoints[dedupedPoints.length - 1];
                const curr = newPoints[j];
                const dx = prev.x - curr.x;
                const dy = prev.y - curr.y;

                // REVIEW - Connect to config 1e-9 epsilon?
                if ((dx * dx + dy * dy) > 1e-9 || protectedIndices.has(j)) {
                    indexRemap.push(dedupedPoints.length);
                    dedupedPoints.push(curr);
                } else {
                    indexRemap.push(dedupedPoints.length - 1);
                }
            }

            const remappedArcs = detectedArcSegments.map(arc => {
                const newStart = indexRemap[arc.startIndex];
                const newEnd = indexRemap[arc.endIndex];
                if (newStart >= 0 && newEnd >= 0) {
                    return { ...arc, startIndex: newStart, endIndex: newEnd };
                }
                return null;
            }).filter(Boolean);

            if (debugState.enabled && remappedArcs.length > 0) {
                if (dedupedPoints.length >= originalPointCount) {
                    console.warn(`[ArcReconstructor] Point count not reduced: ${originalPointCount} -> ${dedupedPoints.length}. Acceptable if arcs had few segments.`);
                } else {
                    this.debug(`Point count reduced: ${originalPointCount} -> ${dedupedPoints.length}`);
                }
            }

            if (remappedArcs.length > 0) {
                this.stats.reconstructed += remappedArcs.length;
            }

            // Return reconstructed contour
            // TODO [ARC-ENCODING] - chord-only output: two points per arc.
            return {
                points: dedupedPoints,
                isHole: contour.isHole || false,
                nestingLevel: contour.nestingLevel || 0,
                parentId: contour.parentId || null,
                arcSegments: remappedArcs,
                curveIds: Array.from(new Set(remappedArcs.map(s => s.curveId)))
            };
        }

        // Group points with strict 1-point gap tolerance for intersection artifacts
        groupPointsWithGaps(points, isClosed = false) {
            if (!points || points.length === 0) return [];

            const groups = [];

            // Start the first group
            let currentCurveId = points[0].curveId > 0 ? points[0].curveId : null;
            let currentGroup = {
                type: currentCurveId ? 'curve' : 'straight',
                curveId: currentCurveId,
                points: [points[0]],
                indices: [0]
            };

            for (let i = 1; i < points.length; i++) {
                const point = points[i];
                const curveId = point.curveId > 0 ? point.curveId : null;

                // Case 1: Direct Match - Continue the group
                if (curveId === currentGroup.curveId) {
                    currentGroup.points.push(point);
                    currentGroup.indices.push(i);
                    continue;
                } 

                // Case 2: Mismatch - Strict 1-point bridge, and it stays at 1.
                // Clipper drops the Z word on the vertices it CREATES at an
                // intersection, which is at most one per crossing. A wider
                // bridge would span a genuine boolean seam and try to rebuild
                // an arc across geometry that is no longer on the curve.
                if (currentGroup.curveId) {
                    const nextIndex = i + 1;

                    // Check exactly one point ahead
                    if (nextIndex < points.length) {
                        const nextPoint = points[nextIndex];
                        const nextId = nextPoint.curveId > 0 ? nextPoint.curveId : null;

                        // If the valid ID resumes immediately after this point
                        if (nextId === currentGroup.curveId) {
                            // It's an intersection artifact. Absorb it and the next point.
                            currentGroup.points.push(point);      // The artifact (no ID)
                            currentGroup.points.push(nextPoint);  // The resumption (valid ID)
                            currentGroup.indices.push(i);
                            currentGroup.indices.push(nextIndex);

                            // Skip the next point in the loop since it was just processed
                            i++; 
                            continue;
                        }
                    }
                }
        
                // Case 3: Genuine break or >1 point gap - Finalize current and start new
                groups.push(currentGroup);
                currentGroup = {
                    type: curveId ? 'curve' : 'straight',
                    curveId: curveId,
                    points: [point],
                    indices: [i]
                };
            }

            // Add the last group
            if (currentGroup) {
                groups.push(currentGroup);
            }

            // Case 4: Closed Loop Wrap-Around Merge
            // If the path is closed, the start and end might be the same broken curve
            if (isClosed && groups.length > 1) {
                const firstGroup = groups[0];
                const lastGroup = groups[groups.length - 1];

                if (firstGroup.type === 'curve' && 
                    lastGroup.type === 'curve' && 
                    firstGroup.curveId === lastGroup.curveId) {

                    // Merge first group points into the last group
                    lastGroup.points.push(...firstGroup.points);
                    lastGroup.indices.push(...firstGroup.indices);

                    // Remove the now-merged first group
                    groups.shift();
                    this.stats.wrappedGroups++;
                }
            }

            if (debugState.enabled && groups.length > 1) {
                const curveGroups = groups.filter(g => g.type === 'curve');
                if (curveGroups.length > 1) {
                    console.warn(`[ArcReconstructor] Fragmentation Alert: Path split into ${groups.length} groups. Curve fragments: ${curveGroups.length}. This indicates Clipper generated >1 point gaps.`);
                    curveGroups.forEach((g, idx) => {
                        console.log(`   Fragment ${idx}: ${g.points.length} points, ID: ${g.curveId}`);
                    });
                }
            }

            this.stats.groupsFound += groups.length;
            return groups;
        }

        /**
         * Lone circular contour -> analytic CirclePrimitive. `ring` comes from
         * GeometryUtils.analyzeCircleRing and has already passed provenance,
         * sweep and closure; this only builds the primitive.
         */
        attemptFullCircleReconstruction(ring, primitive) {
            return new CirclePrimitive(ring.center, ring.radius, {
                ...primitive.properties,
                reconstructed: true,
                originalCurveId: ring.curveId
            });
        }

        /**
         * Circular contour inside a compound. Two coincident points plus one
         * arc of exactly +/-2*PI: the translator's per-segment loop emits that
         * as a single arc command, and the canvas renderer draws it as a full
         * circle. Keeping it a contour preserves the compound's hole topology.
         */
        fullCircleContour(contour, group, ring) {
            const start = group.points[0];
            const startAngle = Math.atan2(start.y - ring.center.y, start.x - ring.center.x);
            const sweep = ring.clockwise ? -2 * Math.PI : 2 * Math.PI;

            return {
                points: [{ x: start.x, y: start.y }, { x: start.x, y: start.y }],
                isFullCircle: true,
                isHole: contour.isHole || false,
                nestingLevel: contour.nestingLevel || 0,
                parentId: contour.parentId || null,
                arcSegments: [{
                    startIndex: 0,
                    endIndex: 1,
                    center: ring.center,
                    radius: ring.radius,
                    startAngle,
                    endAngle: startAngle,
                    sweepAngle: sweep,
                    clockwise: ring.clockwise,
                    curveId: ring.curveId
                }],
                curveIds: [ring.curveId]
            };
        }

        /**
         * Determines if a detected arc is worth reconstructing.
         * Tiny, nearly-flat arcs are left as linear segments so downstream simplification (DP) can handle them if need be.
         */
        isArcWorthReconstruction(arcParams, points) {
            const minSweepDeg = 2.0;
            const minChordLen = 0.01;

            // Dynamic ratio: scales with the radius so large arcs are preserved while tiny artifacts are flattened.
            const maxFlatnessRatio = 1 + (PRECISION / Math.max(1, arcParams.radius));

            const absSweep = Math.abs(arcParams.sweepAngle);

            if (absSweep < (minSweepDeg * Math.PI / 180)) {
                this.debug(`Arc Rejected: Sweep too small (${absSweep.toFixed(2)}° < ${minSweepDeg}°)`, { curveId: arcParams.curveId });
                return false;
            }

            // A near-2*PI sweep has a near-zero chord, so the chord and flatness
            // gates below must not fire.
            // REVIEW - This could have unnintended consequences.
            const isFullCircle =
                Math.abs(absSweep - 2 * Math.PI) <= (2 * Math.PI) / Math.max(2, points.length);

            const p0 = points[0];
            const pN = points[points.length - 1];
            const dx = pN.x - p0.x;
            const dy = pN.y - p0.y;
            const chordLen = Math.sqrt(dx * dx + dy * dy);

            if (!isFullCircle && chordLen < minChordLen) {
                this.debug(`Arc Rejected: Chord too short (${chordLen.toFixed(4)} < ${minChordLen})`, { curveId: arcParams.curveId });
                return false;
            }

            if (!isFullCircle) {
                const arcLen = arcParams.radius * absSweep;
                if (chordLen > 0 && (arcLen / chordLen) < maxFlatnessRatio) {
                    this.debug(`Arc Rejected: Arc too flat (Ratio: ${(arcLen / chordLen).toFixed(3)} < ${maxFlatnessRatio})`, { curveId: arcParams.curveId });
                    return false;
                }
            }

            return true;
        }

        // Calculate arc parameters detecting actual point traversal
        calculateArcFromPoints(points, curveData) {
            if (points.length < 2) return null;

            const startPoint = points[0];
            const endPoint = points[points.length - 1];

            const startAngle = Math.atan2(
                startPoint.y - curveData.center.y, 
                startPoint.x - curveData.center.x
            );
            const endAngle = Math.atan2(
                endPoint.y - curveData.center.y, 
                endPoint.x - curveData.center.x
            );

            // Detect actual traversal by checking angular progression
            let actuallyClockwise = false;

            if (points.length >= 3) {
                // Check multiple sample points for robustness
                const sampleCount = Math.min(5, points.length);
                let cwVotes = 0;
                let ccwVotes = 0;

                for (let i = 1; i < sampleCount; i++) {
                    const idx = Math.floor((i / sampleCount) * points.length);
                    if (idx >= points.length) continue;

                    const prevIdx = Math.floor(((i - 1) / sampleCount) * points.length);

                    const angle1 = Math.atan2(
                        points[prevIdx].y - curveData.center.y,
                        points[prevIdx].x - curveData.center.x
                    );
                    const angle2 = Math.atan2(
                        points[idx].y - curveData.center.y,
                        points[idx].x - curveData.center.x
                    );

                    // Check if going CW or CCW between these points
                    let angleDelta = angle2 - angle1;

                    // Normalize to [-π, π]
                    while (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
                    while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

                    // Y-up: positive delta = CCW, negative delta = CW
                    if (angleDelta > 0) {
                        ccwVotes++;
                    } else if (angleDelta < 0) {
                        cwVotes++;
                    }
                }

                actuallyClockwise = cwVotes > ccwVotes;

            } else {
                // 2-point arc: use shortest path
                let angleDiff = endAngle - startAngle;
                while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
                
                // Y-up: negative diff = CW
                actuallyClockwise = angleDiff < 0;
            }

            // Calculate sweep angle
            let sweepAngle = endAngle - startAngle;

            if (actuallyClockwise) {
                // Y-up standard: CW = negative sweep
                if (sweepAngle > 0) sweepAngle -= 2 * Math.PI;
            } else {
                // Y-up standard: CCW = positive sweep
                if (sweepAngle < 0) sweepAngle += 2 * Math.PI;
            }

            if (curveData.clockwise !== actuallyClockwise) {
                this.debug(`Corrected: ${curveData.clockwise ? 'CW' : 'CCW'} → ${actuallyClockwise ? 'CW' : 'CCW'}`);
            }

            return {
                center: curveData.center,
                radius: curveData.radius,
                startAngle: startAngle,
                endAngle: endAngle,
                sweepAngle: sweepAngle,
                clockwise: actuallyClockwise
            };
        }

        /**
         * Checks if a point geometrically belongs to a registered curve.
         * Performs a radius check and, if angle data is available, a sweep check to prevent false positives on arcs that share the same center/radius.
         * NOTICE: There's a risk this can cause arc-arc edge point collision metadata recovery checks to become greedy when arc points overlap the next linear segment points and they mathematically are within the tolerance assigned.
         */
        pointBelongsToCurve(point, curveData, tolerance) {
            if (!curveData || !curveData.center || !curveData.radius) return false;

            // Radius Check
            const dist = Math.hypot(point.x - curveData.center.x, point.y - curveData.center.y);
            if (Math.abs(dist - curveData.radius) > tolerance) return false;

            if (curveData.type === 'circle') return true;

            // Sweep Check
            if (curveData.startAngle !== undefined && curveData.endAngle !== undefined) {
                const pointAngle = Math.atan2(point.y - curveData.center.y, point.x - curveData.center.x);

                // Utility to strictly normalize any angular difference to a positive 0-2PI range.
                const normalizeDiff = (angle) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

                // Calculate the positive angular distances from the start angle
                let totalSweep = normalizeDiff(curveData.endAngle - curveData.startAngle);
                let pointSweep = normalizeDiff(pointAngle - curveData.startAngle);

                // If the arc is Clockwise, the logical sweep goes in the negative direction.
                // Subtract 2PI to get the correct negative sweep value.
                if (curveData.clockwise) {
                    if (totalSweep > 0) totalSweep -= 2 * Math.PI;
                    if (pointSweep > 0) pointSweep -= 2 * Math.PI;
                }

                const angularTolerance = tolerance / curveData.radius; // Convert linear tolerance to radians

                // Compare the signed point sweep against the signed total sweep
                if (curveData.clockwise) {
                    // CW: sweeps are negative. pointSweep must be >= totalSweep (more negative) and <= 0
                    return pointSweep >= (totalSweep - angularTolerance) && pointSweep <= angularTolerance;
                } else {
                    // CCW: sweeps are positive. pointSweep must be >= 0 and <= totalSweep
                    return pointSweep >= -angularTolerance && pointSweep <= (totalSweep + angularTolerance);
                }
            }

            return true;
        }

        /**
         * Pre-grouping metadata recovery pass.
         * Scans contour points for untagged vertices adjacent to tagged ones.
         * If the untagged vertex geometrically belongs to the neighbor's curve, it reclaims it by assigning the curveId. This repairs Z-metadata lost at Clipper2 intersection vertices where different shapes meet.
         * Uses forward + backward passes so both arc boundaries are recovered regardless of which direction the loss occurred.
         */
        recoverLostMetadata(contourPoints, isClosed) {
            if (!contourPoints || contourPoints.length < 3) return contourPoints;

            const len = contourPoints.length;
            let recovered = 0;

            // Snapshot original curve IDs to prevent cascading recovery.
            const originalIds = new Array(len);
            for (let i = 0; i < len; i++) {
                originalIds[i] = contourPoints[i].curveId || 0;
            }

            // Single bidirectional pass: only recover a point when BOTH its
            // original neighbors share the same curveId.  This prevents
            // greedy boundary extension at arc-to-straight transitions
            // (where only one neighbor is tagged) while still healing
            // internal single-point losses within an arc run.
            for (let i = 0; i < len; i++) {
                const current = contourPoints[i];
                if (current.curveId > 0) continue; // Already tagged

                const prevIdx = (i - 1 + len) % len;
                const nextIdx = (i + 1) % len;

                // Don't wrap on open paths
                if (!isClosed && (i === 0 || i === len - 1)) continue;

                // Use originalIds to prevent the cascade
                const prevId = originalIds[prevIdx];
                const nextId = originalIds[nextIdx];

                // Both neighbors must be originally tagged with the SAME curve
                if (prevId > 0 && prevId === nextId) {
                    const curveData = this.getCurve(prevId);
                    if (curveData && this.pointBelongsToCurve(current, curveData, PRECISION)) {
                        current.curveId = prevId;
                        recovered++;
                    }
                }
            }

            if (recovered > 0) {
                this.debug(`Metadata recovery: reclaimed ${recovered} point(s)`);
            }

            return contourPoints;
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            data ? console.log(`[ArcReconstructor] ${message}`, data)
                 : console.log(`[ArcReconstructor] ${message}`);
        }
    }

    window.ArcReconstructor = ArcReconstructor;
})();