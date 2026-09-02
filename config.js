/*!
 * @file        config.js
 * @description Centralized application configuration
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/*
 *
 * Architecture:
 *   config.constants - Frozen at runtime (Object.freeze). Algorithmic thresholds,
 *                      format specs, engine limits, UI schema. Never saved or exported.
 *   config.defaults  - Factory-reset values for all user-facing settings. Cloned by
 *                      SettingsManager on startup, overridable via JSON import.
 *   config.*()       - Helper methods (root level, read from both sections).
 */

// `window` does not exist in a Web Worker. field-worker.js does NOT load this
// file - it installs a function-stripped snapshot of `constants` from the job
// payload as self.CAMConfig before importScripts, so the worker-clean modules
// bind to a live object. The deep-freeze tail below resolves via globalThis.
(typeof self !== 'undefined' ? self : window).CAMConfig = {


    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║  ASSET PATHS                                                          ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    paths: {
        fieldWorker: '../geometry/field-worker.js'
    },

    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║  CONSTANTS                                                            ║
    // ║  Frozen at runtime. Changing these breaks math, crashes WASM, or      ║
    // ║  violates file format specs. Never persisted, exported, or imported.  ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    constants: {

        // ====================================================================
        // PRECISION
        //
        // Canonical tolerance values. Every module references these instead of
        // hardcoding numbers. When adding a new tolerance, check if an existing
        // one already covers the use case before creating a new entry.
        //
        // ====================================================================
        precision: {
            epsilon: 1e-9, // Floating-point near-zero. Guard divisions, cross-product zero checks.
            collinear: 1e-12, // Stricter near-zero for geometric collinearity where even tiny deviations matter.
            coordinate: 0.001, // Coordinate quantization grid. All coordinates snap to this resolution.
            rdpSimplification: 0.0001 // Douglas-Peucker polygon simplification.
        },

        // ====================================================================
        // 4TH AXIS
        // ====================================================================
        rotary: {
            // ── Generator tuning (ships in genOptions.tuning) ──
            edgeRunCells: 2, // Consecutive covered cells before a row's inward scan calls it the model edge. Rejects single-cell pinholes without trimming genuinely thin tips.
            minRadiusClip: 0.01, // Smallest radius any radial target holds.
            stubDefaultMm: 0.5, // Drive core radius when none is resolved.
            autoLipFraction: 0.1, // Rollover lip depth as a fraction of tool diameter when the user leaves it at 0.
            padSlackMm: 0.1, // Grid padding beyond the cutting reach.
            indexClearance: 2,

            // ── Slicer / chain post-filtering (ride genOptions) ──
            minRadialitySin2: 0.05, // Reject faces within ~13° of axial (0 = off).
            simplifyTolerance: 0.01,
            minSegmentLength:  0.2,

            // ── Export ──
            // Fallback inverse-time (G93) ceiling for posts that don't declare
            // their own. F = feed/length blows up on microscopic segments and
            // hard-alarms most controllers above ~1e4.
            maxInverseTime: 9999.99
        },

        // ====================================================================
        // V-Carving
        // ====================================================================
        vcarve: {
            // Junction-fan prune floors, in multiples of sampleSpacing.
            branchLengthFactor: 3,
            branchDepthFactor: 1.5,
            // Corner-hood gate: minimum SIGNED tangent-direction change across
            // the corner window for a boundary vertex to be a corner. Signed,
            // not per-vertex: 0.01mm tessellation on a 0.001mm coordinate grid
            // carries ~5deg of direction noise per chord, so single vertices on
            // a smooth wall clear any per-vertex threshold. Those spikes are
            // zero-mean and cancel across the window; a real corner does not.
            // Gates BOTH the resampler's keep decision and the spoke pass, which
            // have to agree or a kept corner never ramps. Deliberately not the
            // user's vcarveCornerAngle - that is contact separation for rib
            // classification, a different quantity at a different stage.
            resampleCornerAngle: 20,
            // Max angle (deg) a circumcentre may sit off a corner's bisector
            // and still be chosen as its spoke target.
            cornerRayMaxAngle: 45,
            // A vertex is a corner only when it owns this share of the ABSOLUTE
            // turn inside the window. A tessellated curve spreads its turn over
            // every sample in the window and fails; a corner concentrates it.
            cornerTurnShare: .5,
            // Corner window half-width, in multiples of sampleSpacing. THE knob
            // for false spokes: too small and a coarsely tessellated curve reads
            // as a run of corners, too large and a sharp apex between tight
            // fillets loses its ramp. Sweep this first.
            cornerWindow: 3,
            // Ring samples each way whose incident triangles are candidate spoke
            // targets. The apex's own ear can land outside the part, leaving it
            // with no candidate of its own.
            spokeSearchSpan: 2,
            // Circle fast path: max radial miss from the fitted circle as a
            // fraction of its radius. This IS the aspect gate: peak deviation
            // of a best-fit circle over an ellipse is (a - b)/2 at both axis
            // ends, so a band of tau*R accepts exactly a/b <= (1+tau)/(1-tau).
            // 0.02 => 1.041. Never floor this with sampleSpacing - that makes
            // the test absolute and size-independent, and small ellipses then
            // collapse to a single plunge while their larger twins do not.
            circleTolerance: 0.02,
            // Circumcentre ridge projection: max Newton-style steps onto the
            // locus equidistant from the two nearest boundary SEGMENTS. This is
            // a centring refinement only - clearance is exact wherever the point
            // ends up, so an unconverged step under-cuts by a hair and can never
            // gouge or step. 0 off.
            ridgeMaxSteps: 6,
            // Below this |n1 - n2| two contact normals are effectively parallel
            // (both contacts on one wall): no ridge here. Used to SELECT the
            // second contact, not to abort. ~20 deg apart.
            ridgeMinSeparation: .35,
            // Clearance grid cell, in multiples of sampleSpacing. Segments are
            // ~sampleSpacing long, so 2 keeps most segments in one or two cells.
            clearanceGridCell: 2,
            // Light x/y-only Laplacian over chain interiors after chaining;
            // t is re-queried from the relaxed positions afterwards.
            clearanceSmoothPasses: 2
        },

        // ====================================================================
        // GEOMETRY ENGINE
        // ====================================================================
        geometry: {
            segments: { // Pipeline tessellation only (Clipper input + arc reconstruction).
                // REVIEW - these should all be dynamic in terms of size, arcs are either reconstructed (needs highest tessellation values) or segments are simplified. Tessellation is temporary.
                targetLength: 0.01,
                minCircle: 256,
                maxCircle: 2048,
                minArc: 200,
                maxArc: 2048,
                minEndCap: 32,
                maxEndCap: 256,
                defaultMinSegments: 16,
                defaultFallbackSegments: { min: 32, max: 128 }
            },

            tessellation: {
                bezierSegments: 32,
                minEllipticalSegments: 8
            },

            arcReconstruction: {
                minArcPoints: 2   // Fewest tagged points before a curve run is arc-reconstruction viable.
            },

            curveRegistry: {
                hashPrecision: 1000
            },

            edgeKeyDecimals: 3
        },

        // ====================================================================
        // FILE FORMAT SPECIFICATIONS
        // ====================================================================
        formats: {
            excellon: {
                defaultFormat: { integer: 2, decimal: 4 },
                defaultUnits: 'mm',
                defaultToolDiameter: 1.0,
                minToolDiameter: 0.1,
                maxToolDiameter: 10.0,
                toolKeyPadding: 2
            },
            gerber: {
                defaultFormat: { integer: 3, decimal: 3 },
                defaultUnits: 'mm',
                defaultAperture: 0.1,
                minAperture: 0.01,
                maxAperture: 10.0
            },
            svg: {
                defaultStyles: {
                    fill: 'black',
                    fillOpacity: 1.0,
                    stroke: 'none',
                    strokeWidth: 1.0,
                    strokeOpacity: 1.0,
                    display: 'inline',
                    visibility: 'visible'
                }
            }
        },

        // ====================================================================
        // RENDERER ENGINE
        // ====================================================================
        renderer: {
            context: {
                alpha: false,
                desynchronized: true
            },
            lodThreshold: 1,
            zoom: {
                fitPadding: 1.1,
                fitPaddingWithOrigin: 1.35,
                factor: 1.2,
                min: 0.01,
                max: 3000
            },
            emptyCanvas: {
                originMarginLeft: 0.10,
                originMarginBottom: 0.12,
                defaultScale: 10
            },
            overlay: {
                gridLineWidth: 0.1,
                originStrokeWidth: 3,
                originOutlineWidth: 1,
                boundsLineWidth: 1,
                boundsDash: [2, 2],
                boundsMarkerSize: 5,
                boundsMarkerWidth: 2,
                rulerLineWidth: 1,
                rulerFont: '11px Arial',
                rulerCornerFont: '9px Arial',
                rulerCornerText: 'mm',
                rulerMinPixelStep: 50,
                rulerAlpha: 'CC',   // ruler backdrop opacity, hex 00-FF
                scaleIndicatorPadding: 10,
                scaleIndicatorBarHeight: 4,
                scaleIndicatorYOffset: 20,
                scaleIndicatorTargetPixels: 100,
                scaleIndicatorMinPixels: 50,
                scaleIndicatorEndCapWidth: 2,
                scaleIndicatorEndCapHeight: 4,
                scaleIndicatorFont: '11px Arial',
                statsX: 10,
                statsY: 50,
                statsLineHeight: 16,
                statsBGWidth: 200,
                statsFont: '12px monospace'
            },
            interaction: {
                cursorGrabbing: 'grabbing',
                cursorGrab: 'grab',
                coordPrecision: 2,
                zoomPrecision: 0
            },
            primitives: {
                offsetStrokeWidth: 1,
                centerMarkStrokeWidth: 3,
                sourceDrillStrokeWidth: 3,
                sourceDrillMarkSize: 0.2,
                sourceDrillMarkRatio: 0.4,
                peckMarkStrokeWidth: 3,
                peckMarkMarkSize: 0.2,
                peckMarkMarkRatio: 0.4,
                peckMarkDash: [0.15, 0.15],
                peckMarkRingFactor: 1.3,
                peckMarkLabelOffset: 0.3,
                reconstructedStrokeWidth: 2,
                reconstructedCenterSize: 2,
                reconstructedPathDash: [5, 5],
                defaultStrokeWidth: 0.1,
                debugPointSize: 4,
                debugFont: '11px monospace',
                debugLabelLineWidth: 2,
                debugArcStrokeWidth: 3,
                debugArcCenterSize: 4,
                debugContourStrokeWidth: 2,
                debugContourDash: [5, 5]
            }
        },

        // ====================================================================
        // STORAGE KEYS
        // ====================================================================
        storageKeys: {
            // Shared across all apps on this domain
            theme: 'cam-theme',
            machine: 'cam-machine-settings',

            // App-specific - call with app name from profile
            // e.g. storageKeys.forApp('easyshape5000').parameters
            forApp: function(appName) {
                const prefix = appName.toLowerCase().replace(/[^a-z0-9]/g, '');
                return {
                    settings: `${prefix}-settings`,
                    parameters: `${prefix}-parameters`,
                    pipeline: `${prefix}-pipeline`,
                    hideWelcome: `${prefix}-hide-welcome`
                };
            },
        },
    
    },


    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║  DEFAULTS                                                             ║
    // ║  Factory-reset values for all user-facing settings. SettingsManager   ║
    // ║  deep-clones this on startup, then merges localStorage and any        ║
    // ║  imported JSON over the clone. A bad value here produces suboptimal   ║
    // ║  but recoverable results - it never crashes the engine.               ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    defaults: {
        // REVIEW - Is this really necessary? Seems like an over complication?
        pipeline: { machineClass: 'router', classByType: null, laser: null },

        // ====================================================================
        // WORKERS
        // ====================================================================
        // Field worker pool size. Clamped to hardwareConcurrency - 1 at spawn
        // (FieldWorkerClient._poolSize), so this is a ceiling, not a demand.
        // Each worker importScripts the whole geometry stack, so it is a
        // memory/throughput trade:
        //   vcarve  - ONE JOB PER SHAPE; scales with pool size. A 200-glyph
        //             sign is the case that wants this raised.
        //   relief  - one job total. Never uses more than one worker.
        //   rotary  - one job total. Never uses more than one worker.
        // 0 = auto (hardwareConcurrency - 1, capped). Set a positive value only
        // to define a static pool for debugging or when memory-constrained.
        fieldWorkerPool: 0,

        // ====================================================================
        // MACHINE
        // ====================================================================
        machine: {
            pcb: {
                thickness: 1.8,
                minFeatureSize: 0.1
            },
            heights: {
                safeZ: 5.0,
                travelZ: 2.0,
                feedHeight: 1.0,    // Clearance above Z0 where G0→G1 handoff occurs.
                maxSafeDepth: -10.1 // Negative Z limit. Calculated values below this throw a warning. These checks get annoying in EasyShape5000 though.
            },
            speeds: {
                rapidFeed: 1000,
                maxFeed: 2000
            },
            coolant: 'none',
            vacuum: false
        },

        // ====================================================================
        // G-CODE GENERATION
        // ====================================================================
        gcode: {
            postProcessor: 'grbl',
            units: 'mm',
            // 4th-axis export route. '' means "not chosen yet" and only
            // survives until the machine-settings picker first renders, which
            // resolves it to the selected post's first declared route and
            // commits that concrete value. A saved route the current post does
            // not declare resolves the same way. There is no 'auto' route.
            // See BasePostProcessor.normalizeRotary for the route semantics.
            rotaryRoute: '',
            // '' = use the active post's declared default. Same contract as
            // rotaryRoute: only a value the post cannot emit gets overwritten.
            toolLengthCompMode: '',
            // Rotary index settling dwell, SECONDS. '' = use the selected
            // post's declared indexDwell. This is a property of the rotary
            // HARDWARE (belt vs geared/servo with a brake), not the
            // controller - one post drives both kinds, so the machine
            // setting has to be able to override the post's guess.
            indexDwell: '',
            // N words. The POST owns the dialect (start/step/max, which
            // characters must never be numbered); the USER owns whether.
            // Inert on GRBL and grblHAL (the parser strips them), honoured by
            // Fanuc, LinuxCNC, Mach3, UCCNC and WinPC-NC, and useful on any
            // sender that echoes the failing block back.
            lineNumbers: false,
            lineNumberStep: 10,
            decimals: {
                coordinates: 3,
                feedrate: 0,
                spindle: 0,
                arc: 3
            },

            optimization: {
                // Or-opt relocation refinement (refinePlanOrder /
                // refineRegionOrder). routeCost is O(blocks), so a pass is
                // O(blocks^3) - the budget is what bounds it, and the block
                // count is only a sanity ceiling. Over budget the greedy NN
                // order stands for whatever was not reached; it is correct,
                // just not polished, and the optimizer says so in its log.
                orOptMaxBlocks: 20000,
                orOptBudgetMs: 250
            }
        },

        // ====================================================================
        // LASER PIPELINE
        // ====================================================================
        laser: {
        // Global Machine & Pipeline Settings
            spotSize: 0.02,
            exportFormat: 'svg',
            exportDPI: 1000,
            exportPadding: 5.0,
            defaultClearStrategy: 'offset',

            svgGrouping: 'none',
            reverseCutOrder: false,
            heatManagement: 'standard',
            colorPerPass: false,

            // Active profile key - drives structural SVG decisions
            // REVIEW - isn't this pulled from profile.json?
            activeProfile: 'generic',

            // Profile definitions - each represents a laser control software target
            // REVIEW - Is it worth splitting these like "post-processors"? Maybe adding them to the profile-trace.json?
            profiles: {
                generic: {
                    label: 'Generic (Very Experimental)',
                    svgGrouping: 'layer',
                    reverseCutOrder: false,
                    heatManagement: 'standard', // Sort primitives smallest-first within each pass
                    colorPerPass: false, // Assign unique hue-rotated color per pass for color-mapped layers
                    layerColors: {
                        isolation: '#ff0000',
                        drill:     '#0000ff',
                        clearing:  '#00ff00',
                        cutout:    '#000000',
                        stencil:   '#860694'
                    }
                },
                lasergrbl: {
                    label: 'LaserGRBL (Very Experimental)',
                    svgGrouping: 'group',        // Standard SVG groups; LaserGRBL imports grouped geometry as separate operations
                    reverseCutOrder: false,
                    heatManagement: 'standard',
                    colorPerPass: false,
                    layerColors: {
                        isolation: '#ff0000',
                        drill:     '#0000ff',
                        clearing:  '#00ff00',
                        cutout:    '#000000',
                        stencil:   '#860694'
                    }
                },
                xToolStudio: {
                    label: 'xTool Studio (Less Experimental)',
                    svgGrouping: 'color',
                    reverseCutOrder: true,
                    heatManagement: 'standard',
                    colorPerPass: true,
                    paletteLumping: true,
                    // The exact 16 colors xCS maps to layers, ordered from Smallest/Delicate to Largest/Lumped
                    palette: [
                        '#EB3DBA', '#FE0002', '#FF7F56', '#E1C000', '#C29900', 
                        '#96D71D', '#00C715', '#00897B', '#2366FF', '#00BEFE', 
                        '#8170EF', '#A958FF', '#582FA8', '#D9D9D9', '#848B96',
                        '#000000'
                    ],
                    layerColors: {
                        isolation: '#FE0002',
                        drill:     '#2366FF',
                        clearing:  '#FE0002',
                        cutout:    '#2366FF',
                        stencil:   '#582FA8'
                    }
                },
                lightburn: {
                    label: 'LightBurn (Very Experimental)',
                    svgGrouping: 'none',           // LightBurn prefers flat geometry; it builds its own layer tree from colors
                    reverseCutOrder: true,         // LightBurn reads SVG bottom-to-top; reverse so first-in-file = first-cut
                    heatManagement: 'standard',    // Sort primitives smallest-first within each pass
                    colorPerPass: true,            // Assign unique hue-rotated color per pass
                    layerColors: {
                        isolation: '#ff0000',
                        drill:     '#0000ff',
                        clearing:  '#00ff00',
                        cutout:    '#000000',
                        stencil:   '#860694'
                    }
                },
                rdworks: {
                    label: 'RDWorks / Ruida (Very Experimental)',
                    svgGrouping: 'layer',          // RDWorks maps Inkscape layers to its own laser layers
                    reverseCutOrder: false,        // RDWorks processes layers top-to-bottom (standard DOM order)
                    heatManagement: 'off',         // RDWorks handles its own optimization internally
                    colorPerPass: false,           // Single color per layer; RDWorks assigns power/speed per layer, not per color // REVIEW - add a color per layer toggle?
                    layerColors: {
                        isolation: '#ff0000',
                        drill:     '#00ff00',
                        clearing:  '#0000ff',
                        cutout:    '#000000',
                        stencil:   '#ff00ff'
                    }
                }
            },

            // Runtime layer colors - synced from active profile on selection. // REVIEW - Should hatch have it's own dedicated color hardcoded here too?
            layerColors: {
                isolation: '#ff0000',
                drill:     '#0000ff',
                clearing:  '#00ff00',
                cutout:    '#000000',
                stencil:   '#860694'
            },

            // Operation-Specific Overrides
            operations: {
                isolation: { laserIsolationWidth: 0.4, laserStepOver: 10, laserClearStrategy: 'offset', laserHatchAngle: 0 },
                clearing: { laserClearingPadding: 1.0, laserStepOver: 10, laserClearStrategy: 'offset', laserHatchAngle: 0 },
                cutout: { laserCutSide: 'outside' },
                drill:  { laserCutSide: 'inside' }
            }
        },

        // ====================================================================
        // GEOMETRY PROCESSING
        // Tunable parameters affecting output quality, not correctness.
        // ====================================================================
        geometry: {
            offsetting: {
                miterLimit: 2.0
            }
        },

        // ====================================================================
        // TOOLPATH GENERATION
        // ====================================================================
        toolpath: {
            generation: {
                entry: {
                    helix: {
                        radiusFactor: 0.4,
                        pitch: 0.5,
                        segmentsPerRevolution: 16
                    },
                    // REVIEW - MachineProcessor tries to look up context.strategy.entryRampAngle? Disconnected for now anyway
                    ramp: {
                        defaultAngle: 10,
                        shallowDepthFactor: 0.1
                    }
                },
                // Only the commented-out helix constants lack readers. Kept so they are not re-invented as literals later.
                drilling: {
                    peckRapidClearance: 0.1,
                    // helixPitchFactor: 0.5,
                    // helixMaxDepthFactor: 3.0,
                    // helixSegmentsPerRev: 16,
                    // slotHelixSegments: 12,
                    // slotHelixMaxPitchFactor: 0.5,
                    minHelixDiameter: 0.1,
                    millMargin: 0.05, // Hole minus cutter below which milling a ring is not worth it and the feature is pecked at centre instead.
                    matchTolerance: 0.02 // |bit - hole| within which auto-match calls a library drill an exact fit for that hole.
                },
                rapidCost: {
                    // Flat surcharge on every rapid link. Constant across
                    // candidates, so it never changes the nearest-neighbour
                    // choice - what it does is make any staydown or 3D
                    // continuation link out-bid a rapid of any length.
                    baseCost: 10000
                },
                simplification: {
                    curveToleranceFallback: 0.001,
                    straightToleranceFallback: 0.005,
                    straightAngleThreshold: 1.0,
                    sharpAngleThreshold: 10.0,
                    sharpCornerTolerance: 0.00001,

                    // ── 3D chains (V-Carve skeletons, relief rasters) ──
                    // tolerance3D        max 3D deviation the RDP pass may introduce.
                    // minSegmentLength3D + collinearAngle3D drive a cheap O(n)
                    //   pre-pass that removes Voronoi micro-segments BEFORE RDP.
                    //   A point is collapsed only when its incoming segment is
                    //   shorter than minSegmentLength3D OR the turn is under
                    //   collinearAngle3D, AND the resulting deviation stays under
                    //   tolerance3D * preTolFactor. Total error is therefore
                    //   bounded by tolerance3D * (1 + preTolFactor).
                    tolerance3D: 0.01,
                    minSegmentLength3D: 0.02,
                    collinearAngle3D: 1.0,
                    preTolFactor: 0.25
                },

                // Single source of truth for the 3D toolpath layer.
                threeD: {
                    // Descents steeper than this angle from horizontal use
                    // plungeRate instead of feedRate. 45deg => |dz| > dxy.
                    descentFeedAngleDeg: 60,

                    // Retract only to feedHeight between chains of the same
                    // operation (nothing protrudes above stock top).
                    allowHop: true,

                    // Entry-depth penalty for 3D chains: mm of rapid travel
                    // charged per mm of depth at the approach end. A chain
                    // entered at its deep end either plunges into stock or
                    // climbs out of a junction, so it should be picked only
                    // when the travel saved is worth more than that. It biases,
                    // it does not forbid - by the time a deep-entry chain is
                    // the cheapest option left, its neighbours have usually
                    // already opened that junction. 0 = pure distance.
                    entryDepthCost: 10
                }
            },
            tabs: {
                minTabLength: 5
            }
        },

        // ====================================================================
        // EXPORT
        // ====================================================================
        export: {
            defaultBaseName: 'pcb-output',
            svg: {
                padding: 5,
                includeMetadata: true,
                useViewBox: true,
                embedStyles: true,
                styles: {
                    wireframeStrokeWidth: 0.05,
                    cutoutStrokeWidth: 0.1
                }
            }
        },

        // ====================================================================
        // RENDERING PREFERENCES
        // ====================================================================
        rendering: {
            defaultOptions: {
                showWireframe: false,
                showPads: true,
                blackAndWhite: false,
                showGrid: true,
                showOrigin: true,
                showBounds: false,
                showRulers: true,
                fuseGeometry: false,
                showRegions: true,
                showTraces: true,
                showDrills: true,
                showCutouts: true,
                showStats: false,
                debugPoints: false,
                debugArcs: false,
                showOffsets: true,
                showPreviews: true,
                showPreprocessed: false,
                enableArcReconstruction: false
            },
            // 3D preview (renderer3d/*). Those modules are ESM and
            // dynamically imported, so they read window.CAMConfig at module
            // load with this value duplicated as an inline fallback - keep
            // the two in sync the same way the worker-clean modules do.
            preview3D: {
                // mm per chord when linearizing an arc command or wrapping a
                // developed rotary segment. Preview fidelity and simulator
                // timing only; the exported arc is never touched.
                arcSegmentLength: 0.4,
                // Max deviation from the true arc, mm. Baked line geometry
                // cannot re-flatten on zoom the way ctx.arc() does, so this
                // is what stops circles reading as polygons when zoomed in.
                arcSagitta: 0.02
            },
            canvas: {
                defaultZoom: 10,
                zoomStep: 1.2,
                panSensitivity: 1.0,
                wheelZoomSpeed: 0.002,
                rulerSize: 20,
                rulerTickLength: 5,
                originMarkerSize: 10,
                originCircleSize: 3,
                wireframe: {
                    baseThickness: 0.08,
                    minThickness: 0.02,
                    maxThickness: 0.2
                }
            },
            grid: {
                enabled: true,
                minPixelSpacing: 40,
                steps: [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000],
            }
        },

        // ====================================================================
        // UI PREFERENCES
        // ====================================================================
        ui: {
            theme: 'dark',

            timing: {
                statusMessageDuration: 5000,
                modalAnimationDuration: 300,
                inputDebounceDelay: 300,
                renderThrottle: 16,
                propertyDebounce: 500,
                uiTransitionDelay: 125
            },

            tooltips: {
                enabled: true,
                positionPadding: 8,
                delayShow: 300,
                delayHide: 150
            },

            logHistoryMax: 500,

            // REVIEW - Dead Code?
            // visualization: {
            //     geometryStageTransition: {
            //         enabled: true,
            //         duration: 300
            //     }
            // }
        },

        // ====================================================================
        // DEBUG & DEVELOPMENT
        // ====================================================================
        debug: {
            enabled: false,
            // REVIEW - Many are disconnected? Worth connecting?
            logging: {
                operations: false,
                toolpaths: false,
                rendering: false,
                interactions: false,
                cache: false
            },
            visualization: {
                // REVIEW - Disconnected? Worth connecting?
                showBounds: false,
                showStats: false,
            }
        }
    },


    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║  HELPER METHODS                                                       ║
    // ║  Use explicit CAMConfig reference instead of 'this' to prevent        ║
    // ║  context loss if a module destructures the method off the object.     ║
    // ╚═══════════════════════════════════════════════════════════════════════╝

    // Currently empty

};


// ════════════════════════════════════════════════════════════════════════════
// RUNTIME FREEZE
//
// Deep-freeze the constants subtree. Accidental mutation throws in strict mode
// and silently fails in sloppy mode. Defaults are left mutable because
// SettingsManager clones and overrides them at startup.
//
// Uses globalThis for cross-environment compatibility (browser + Node/test).
// ════════════════════════════════════════════════════════════════════════════
(function deepFreeze(obj) {
    Object.freeze(obj);
    for (var i = 0, keys = Object.getOwnPropertyNames(obj); i < keys.length; i++) {
        var value = obj[keys[i]];
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
            deepFreeze(value);
        }
    }
})((typeof globalThis !== 'undefined' ? globalThis : window).CAMConfig.constants);