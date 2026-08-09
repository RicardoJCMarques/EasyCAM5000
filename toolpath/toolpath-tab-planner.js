/*!
 * @file        toolpath/toolpath-tab-planner.js
 * @description Calculates tab positions for cutout polygons
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

    /**
     * Calculates and returns tab positions (start/end distances) along a closed contour.
     */
    class ToolpathTabPlanner {
        constructor(translator) {
            this.translator = translator;
        }

        /**
         * Main entry point. Calculates tab locations, splits the geometry, and returns a flat array of tagged motion commands (LINEAR or ARC) that the MachineProcessor will use to insert Z-moves.
         * @param {Object} geometrySource - The contour (must have points array and arcSegments)
         * @param {Object} context - The operation context
         * @returns {Array<MotionCommand>} Array of motion commands, tagged with isTab: boolean // Review -  description is outdated?
         */
        calculateTabPositions(geometrySource, context) {
            const tabWidth = context.strategy.cutout.tabWidth;
            const tabCount = context.strategy.cutout.tabs;

            // Pull the tool diameter from the context
            const toolDiameter = context.tool.diameter;

            if (tabCount <= 0 || !geometrySource.points) return []; // REVIEW - Change this to the begining of the method?

            // Add the tool diameter to the requested width to create the physical gap
            const compensatedTabWidth = tabWidth + toolDiameter;
            const totalLength = this.calculateTotalLength(geometrySource);
            if (totalLength <= PRECISION || totalLength < compensatedTabWidth * tabCount) {
                return [];
            }

            // Pass the compensated width down into the range calculator
            const tabRanges = this.calculateTabRanges(geometrySource, tabCount, compensatedTabWidth, totalLength);

            // Split Geometry using Tab Ranges (with transforms for correct G-code output)
            const motionCommands = this.splitGeometryByRanges(geometrySource, tabRanges, context.cutting.feedRate, context.transforms);

            return motionCommands;
        }

        /**
         * Determine tab locations along the path perimeter.
         */
        // TODO [TAB-BOUNDARY-WRAP] - When a tab wraps around the contour seam,
        // handleBoundary splits it into two sub-tabs. But the overlap check in the
        // equidistant placement loop runs BEFORE wrappedTabs are pushed into placedTabs,
        // so subsequent proposals don't see the split segments.

        // TODO [TAB-SPATIAL-DISTRIBUTION] - Priority 1 placement centers tabs on the
        // longest straight segments (sorted by length, not spatial position). Two adjacent
        // long segments get tabs back-to-back. Consider a minimum angular/distance
        // separation constraint between Priority 1 tabs.
        calculateTabRanges(geometrySource, tabCount, tabWidth, totalLength) {
            const tabHalfWidth = tabWidth / 2;
            let remainingTabs = tabCount;
            const placedTabs = [];

            const segments = this.mapSegmentsToDistance(geometrySource);

            // Find qualifying straight segments (linear and long enough)
            const straightSegments = segments
                .filter(s => s.type === 'linear' && s.length >= D.toolpath.tabs.minTabLength)
                .sort((a, b) => b.length - a.length);

            // Priority 1: Place tabs centered on longest straight segments
            const tabsOnStraight = Math.min(remainingTabs, straightSegments.length);
            for (let i = 0; i < tabsOnStraight; i++) {
                const segment = straightSegments[i];
                const centerDist = segment.startDistance + segment.length / 2;
                placedTabs.push({
                    start: centerDist - tabHalfWidth,
                    end: centerDist + tabHalfWidth
                });
                remainingTabs--;
            }

            // Priority 2: Equidistant placement for remaining tabs
            if (remainingTabs > 0) {
                const totalSlots = placedTabs.length + remainingTabs;
                const spacing = totalLength / totalSlots;

                for (let i = 0; i < totalSlots && remainingTabs > 0; i++) {
                    const centerDist = (spacing / 2) + (i * spacing);
                    const proposedStart = centerDist - tabHalfWidth;
                    const proposedEnd = centerDist + tabHalfWidth;

                    // Check overlap with already-placed tabs
                    const overlaps = placedTabs.some(tab =>
                        tab.start < proposedEnd + PRECISION &&
                        tab.end > proposedStart - PRECISION
                    );

                    if (!overlaps) {
                        const wrappedTabs = this.handleBoundary(
                            { start: proposedStart, end: proposedEnd },
                            totalLength
                        );
                        placedTabs.push(...wrappedTabs);
                        remainingTabs--;
                    }
                }
            }

            return placedTabs
                .filter(t => (t.end - t.start) > PRECISION)
                .sort((a, b) => a.start - b.start);
        }

        /**
         * Create new MotionCommand segments, splitting existing ones where a tab starts or ends.
         */
        splitGeometryByRanges(geometrySource, tabRanges, feedRate, transforms) {
            const points = geometrySource.points;
            const arcMap = new Map();
            if (geometrySource.arcSegments) {
                for (const arc of geometrySource.arcSegments) {
                    arcMap.set(arc.startIndex, arc);
                }
            }

            const motionCommands = [];
            const numPoints = points.length;
            const isPhysicallyClosed = ToolpathPlan.isClosedPoints(points);
            const segmentsToProcess = isPhysicallyClosed ? numPoints - 1 : numPoints;

            let currentPos = { ...points[0] };
            let currentDistance = 0;

            // Assume tabRanges are sorted by distance.

            for (let i = 0; i < segmentsToProcess; i++) {
                const nextI = (i + 1) % numPoints;
                const arc = arcMap.get(i);

                const segmentEndPos = points[nextI];
                const segmentStartDistance = currentDistance;
                let segmentLength = 0;

                // Calculate Segment Length and Arc Center
                let segData = null;
                if (arc) {
                    segData = this.getArcData(points[i], segmentEndPos, arc);
                    segmentLength = segData.length;
                } else {
                    segmentLength = Math.hypot(segmentEndPos.x - points[i].x, segmentEndPos.y - points[i].y);
                }

                const segmentEndDistance = currentDistance + segmentLength;

                let lastSplitDistance = segmentStartDistance;
                let lastSplitPos = currentPos;

                // Collect all split points on this segment (tab start and tab end points)
                const splitPoints = [];

                // Add all tab starts/ends that fall within this segment
                for (const tab of tabRanges) {
                    if (tab.start > segmentStartDistance && tab.start < segmentEndDistance) {
                        splitPoints.push({ dist: tab.start, type: 'start' });
                    }
                    if (tab.end > segmentStartDistance && tab.end < segmentEndDistance) {
                        splitPoints.push({ dist: tab.end, type: 'end' });
                    }
                }

                // Sort split points to iterate correctly
                splitPoints.sort((a, b) => a.dist - b.dist);

                for (const split of splitPoints) {
                    const splitDistance = split.dist;

                    // Check if the path is currently in a tab (distance-wise)
                    const isInTab = tabRanges.some(t => t.start <= lastSplitDistance + PRECISION && t.end >= splitDistance - PRECISION);

                    // Calculate Split Position
                    const distAlongSegment = splitDistance - segmentStartDistance;
                    const splitPos = this.getPointAlongSegment(points[i], segmentEndPos, arc, segData, distAlongSegment);

                    // Add the segment piece (from last split to current split)
                    if (splitDistance > lastSplitDistance + PRECISION) {
                         const newCmd = this.createSegmentCommand(lastSplitPos, splitPos, arc, segData, feedRate, isInTab, transforms);
                         motionCommands.push(newCmd);
                    }

                    lastSplitDistance = splitDistance;
                    lastSplitPos = splitPos;
                }

                // Define the remaining length before checking it
                const remainingLength = segmentEndDistance - lastSplitDistance;

                // Add the remaining segment (from the last split point to the end of the segment)
                if (remainingLength > PRECISION) {
                    const isInTab = tabRanges.some(t => t.start <= lastSplitDistance + PRECISION && t.end >= segmentEndDistance - PRECISION);

                    const finalCmd = this.createSegmentCommand(lastSplitPos, segmentEndPos, arc, segData, feedRate, isInTab, transforms);
                    motionCommands.push(finalCmd);
                }

                currentPos = segmentEndPos;
                currentDistance = segmentEndDistance;
            }

            return motionCommands;
        }

        // Geometric Utility Methods

        getArcData(startPoint, endPoint, arc) {
            const center = { x: arc.center.x, y: arc.center.y };
            const radius = Math.hypot(startPoint.x - center.x, startPoint.y - center.y); // REVIEW - Math.hypot are expensive, is this necessary? Not that this is called frequently
            const startAngle = Math.atan2(startPoint.y - center.y, startPoint.x - center.x);
            const endAngle = Math.atan2(endPoint.y - center.y, endPoint.x - center.x);

            const sweep = ToolpathPlan.normalizeArcSweep({
                 sweepAngle: arc.sweepAngle,
                 startAngle, endAngle,
                 clockwise: arc.clockwise,
                 chord: Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y), // REVIEW - Math.hypot are expensive, is this necessary? Not that this is called frequently
                 radius,
                 eps: PRECISION,
                 chordEps: PRECISION
             });

            return {
                center,
                radius,
                startAngle,
                endAngle,
                sweep,
                length: Math.abs(sweep * radius),
                clockwise: arc.clockwise
            };
        }

        getPointAlongSegment(startPoint, endPoint, arc, segData, distanceAlong) {
            if (distanceAlong < PRECISION) return startPoint;

            if (!arc) {
                // Linear Interpolation
                const dx = endPoint.x - startPoint.x;
                const dy = endPoint.y - startPoint.y;
                const len = Math.hypot(dx, dy);
                if (len < PRECISION) return startPoint;

                const ratio = Math.min(1.0, distanceAlong / len);
                return { x: startPoint.x + dx * ratio, y: startPoint.y + dy * ratio };
            } 
            else {
                // Angular Interpolation (Preserves Radius)
                if (!segData || segData.length < PRECISION) return startPoint;

                const ratio = Math.min(1.0, distanceAlong / segData.length);
                const targetAngle = segData.startAngle + (segData.sweep * ratio);

                return { 
                    x: segData.center.x + segData.radius * Math.cos(targetAngle), 
                    y: segData.center.y + segData.radius * Math.sin(targetAngle)
                };
            }
        }

        createSegmentCommand(startPos, endPos, arc, segData, feedRate, isTab, transforms) {
            let finalStart = startPos;
            let finalEnd = endPos;
            let finalCenter = arc ? segData.center : null;
            let isClockwise = arc ? segData.clockwise : false;

            // Apply transformations via the translator (mirrors, rotation)
            if (transforms && this.translator) {
                finalStart = this.translator.applyTransforms(startPos, transforms);
                finalEnd = this.translator.applyTransforms(endPos, transforms);

                if (arc) {
                    finalCenter = this.translator.applyTransforms(segData.center, transforms);

                    // Handle winding flips caused by mirroring
                    if (transforms.windingFlipped) {
                        isClockwise = !isClockwise;
                    }
                }
            }

            // Calculate I/J using the transformed coordinates
            const i_val = arc ? finalCenter.x - finalStart.x : null;
            const j_val = arc ? finalCenter.y - finalStart.y : null;
            const type = arc ? (isClockwise ? 'ARC_CW' : 'ARC_CCW') : 'LINEAR';

            const cmd = new MotionCommand(type, 
                { x: finalEnd.x, y: finalEnd.y }, // REVIEW - should this be { x: finalEnd.x, y: finalEnd.y, null }?
                { i: i_val, j: j_val, feed: feedRate }
            );

            cmd.metadata = cmd.metadata || {}; 
            cmd.metadata.isTab = isTab; 
            return cmd;
        }

        /**
         * Clamps tab boundaries to (0, totalLength) and splits tabs that wrap around the seam.
         */
        handleBoundary(tab, totalLength) {
            const newTabs = [];

            if (tab.start < 0) {
                newTabs.push({ start: tab.start + totalLength, end: totalLength });
                newTabs.push({ start: 0, end: tab.end });
            } else if (tab.end > totalLength) {
                 newTabs.push({ start: tab.start, end: totalLength });
                 newTabs.push({ start: 0, end: tab.end - totalLength });
            } else {
                newTabs.push(tab);
            }

            return newTabs.filter(t => (t.end - t.start) > PRECISION);
        }

        mapSegmentsToDistance(geometry) {
            const segments = [];
            const points = geometry.points;
            const arcMap = new Map();
            if (geometry.arcSegments) {
                for (const arc of geometry.arcSegments) {
                    arcMap.set(arc.startIndex, arc);
                }
            }

            const numPoints = points.length;
            const isPhysicallyClosed = ToolpathPlan.isClosedPoints(points);
            const segmentsToProcess = isPhysicallyClosed ? numPoints - 1 : numPoints;
            let currentDistance = 0;

            for (let i = 0; i < segmentsToProcess; i++) {
                const nextI = (i + 1) % numPoints;
                const arc = arcMap.get(i);
                const startPoint = points[i];
                const endPoint = points[nextI];

                let segmentLength = 0;
                let type = 'linear';

                if (arc) {
                    type = 'arc';
                    const segData = this.getArcData(startPoint, endPoint, arc);
                    segmentLength = segData.length;
                } else {
                    segmentLength = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
                }

                segments.push({
                    type: type,
                    index: i,
                    length: segmentLength,
                    startDistance: currentDistance,
                    endDistance: currentDistance + segmentLength
                });

                currentDistance += segmentLength;
            }

            return segments;
        }

        // REVIEW - Why keep this with mapSegmentsToDistance? Merge?
        calculateTotalLength(geometry) {
            const segments = this.mapSegmentsToDistance(geometry);
            if (segments.length === 0) return 0;
            return segments[segments.length - 1].endDistance;
        }
    }

    window.ToolpathTabPlanner = ToolpathTabPlanner;
})();