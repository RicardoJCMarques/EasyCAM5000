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
    // REVIEW - field-worker likely won't change places, why keep this here?
    paths: {
        fieldWorker: '../geometry/field-worker.js'
    },

    // ╔═══════════════════════════════════════════════════════════════════════╗
    // ║ MACHINE PARAMETERS                                                    ║
    // ║ Global settings form. The KEY is the settings path; the last segment  ║
    // ║ is the parameter name, used for the en.json lookup, the DOM id and    ║
    // ║ `conditional`. A post's or laser profile's own settings are not here  ║
    // ║ - they come from its descriptor and are keyed by owner automatically. ║
    // ║ An app removes an entry by setting it to null in its profile's        ║
    // ║ machineParameters block.                                              ║
    // ╚═══════════════════════════════════════════════════════════════════════╝
    machineParameters: {
        "gcode.postProcessor":      { default: "grbl", type: "select", category: "post", source: "processors", classes: ["router"] },
        "gcode.userStartCode":      { default: "", type: "textarea", rows: 5, category: "post", resolver: "startCode", classes: ["router"] },
        "gcode.userEndCode":        { default: "", type: "textarea", rows: 5, category: "post", resolver: "endCode", classes: ["router"] },
        "gcode.units":              { default: "mm", type: "select", category: "post", capability: "supportsUnits", classes: ["router"],
                                      options: [{ value: "mm", label: "Millimeters (G21)" }, { value: "inch", label: "Inches (G20)" }] },
        "gcode.lineNumbers":        { default: false, type: "checkbox", category: "post", capability: "supportsLineNumbers", classes: ["router"] },
        "gcode.lineNumberStep":     { default: 10, type: "number", category: "post", capability: "supportsLineNumbers", classes: ["router"],
                                      conditional: "lineNumbers", min: 1, max: 1000, step: 1, unit: "step" },
        "gcode.toolLengthCompMode": { default: "", type: "select", category: "post", source: "tlcModes", classes: ["router"] }, // '' = use the active post's declared default. Only a value the post cannot emit gets overwritten.

        "machine.stock.thickness": { default: 1.8, type: "number", category: "stock", min: 0.1, step: 0.1, unit: "mm" },
        "machine.stock.width": { default: 200, type: "number", category: "stock", min: 1, step: 1, unit: "mm" },
        "machine.stock.length": { default: 150, type: "number", category: "stock", min: 1, step: 1, unit: "mm" },
        "machine.stock.margin": { default: 0, type: "number", category: "stock", min: 0, step: 1, unit: "mm" }, // Clearance kept around the geometry when fitting stock to it.
        "machine.stock.material": { default: "fr", type: "select", category: "stock", options: [
            { value: "fr", label: "FR" },
            { value: "plywood", label: "Plywood" },
            { value: "mdf", label: "MDF" },
            { value: "hardwood", label: "Hardwood" },
            { value: "softwood", label: "Softwood" },
            { value: "acrylic", label: "Acrylic" },
            { value: "aluminum", label: "Aluminum (soft)" },
            { value: "foam", label: "Foam / Modeling Board" },
            { value: "custom", label: "Custom" }
        ] },
        "machine.stock.zeroReference": { default: "material", type: "select", category: "stock", options: [
            { value: "material", label: "Material Surface (Top)" },
            { value: "bed", label: "Machine Bed (Spoilboard)" }
        ] },

        "machine.heights.safeZ":    { default: 5, type: "number", category: "heights", step: 0.5, unit: "mm", classes: ["router"] },
        "machine.heights.travelZ":  { default: 2, type: "number", category: "heights", step: 0.5, unit: "mm", classes: ["router"] },
        "machine.speeds.rapidFeed": { default: 1000, type: "number", category: "heights", step: 100, unit: "mm/min", classes: ["router"] },
        "machine.coolant":          { default: "none", type: "select", category: "heights", capability: "supportsCoolant", classes: ["router"],
                                      options: [{ value: "none", label: "None" }, { value: "mist", label: "Mist" }, { value: "flood", label: "Flood" }] },
        "machine.vacuum":           { default: false, type: "checkbox", category: "heights", capability: "supportsCoolant", classes: ["router"] },

        "machine.heights.feedHeight":     { default: 1 }, // Clearance above Z0 where the G0→G1 handoff occurs.
        "machine.heights.maxSafeDepth":   { default: -10.1 }, // Negative Z limit. Deeper values raise a warning at generation.
        "machine.speeds.maxFeed":         { default: 2000 },

        "gcode.rotaryRoute": { default: "", type: "select", category: "rotary", source: "rotaryRoutes", classes: ["router"] },

        "gcode.indexDwell":  { default: "", type: "number", category: "rotary", nullable: true, min: 0, max: 5, step: 0.1, unit: "s", placeholder: "Auto", classes: ["router"] }, // Rotary index settling dwell, SECONDS. '' = the post's declared value.

        "laser.activeProfile": { default: "xToolStudio", type: "select", category: "laser", source: "laserProfiles", classes: ["laser"] },
        "laser.spotSize":      { default: 0.02, type: "number", category: "laser", min: 0.01, max: 1, step: 0.01, unit: "mm", classes: ["laser"] },
        "laser.exportFormat":  { default: "svg", type: "select", category: "laser", classes: ["laser"],
                                 options: [{ value: "svg", label: "SVG - Vector" }, { value: "png", label: "PNG - Raster Image" }] },
        "laser.exportDPI":     { default: 1000, type: "number", category: "laser", conditional: "exportFormat:png",
                                 classes: ["laser"], min: 100, max: 4000, step: 100, unit: "DPI" },
        "laser.exportPadding": { default: 5.0 }
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
            rdpSimplification: 1e-4, // 2D polyline RDP tolerance.
            scalarField: 1e-4 // Height/radius comparison threshold for Float32 terrain fields.
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
        pipeline: { machineClass: 'router', classByType: null },

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

        // Namespace roots for per-device settings. Filled by loadSettings from
        // each registered post-processor and laser profile - the device owns
        // its own settings, so adding one must not need an edit here. The empty
        // objects are the roots setSetting writes into.
        // REVIEW - Why not default these next to setSetting directly?
        processorSettings: {},
        laserSettings: {},

        // ====================================================================
        // G-CODE GENERATION
        // ====================================================================
        gcode: {
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
        // ====================================================================
        geometry: {
            decimals: {
                coordinates: 3
            },
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

            // combo → action name. Handlers are registered in code; which key
            // runs them is data. This is the VOCABULARY, not a per-app list:
            // an entry whose action no app registers is skipped by applyTable,
            // so a verb one app lacks costs nothing and arrives free the day
            // it gains it. Only bindings unique to one app belong in a profile.
            shortcuts: [
                // View
                { combo: "F2", action: "toggle3D" },
                { combo: "f", action: "zoomFit" },
                { combo: "Home", action: "zoomFit" },
                { combo: "=", action: "zoomFit" },
                { combo: "+", action: "zoomIn", shiftOptional: true },
                { combo: "-", action: "zoomOut" },
                { combo: "g", action: "toggleGrid" },
                { combo: "w", action: "toggleWireframe" },
                // Global
                { combo: "Escape", action: "escape" },
                { combo: "F1", action: "showHelp" },
                { combo: "ctrl+alt+d", action: "toggleVerboseDebug", mod: true, alt: true },
                { combo: "F6", action: "cycleFocusZone", shiftOptional: true },
                // Editing
                { combo: "ctrl+z", action: "undo", mod: true },
                { combo: "ctrl+shift+z", action: "redo", mod: true },
                { combo: "ctrl+y", action: "redo", mod: true },
                { combo: "ctrl+g", action: "group", mod: true },
                { combo: "ctrl+shift+g", action: "ungroup", mod: true },
                { combo: "ctrl+a", action: "selectAll", mod: true },
                // Destructive: the tree owns Delete for the focused node, so
                // the global selection delete must stay out of it.
                { combo: "Delete", action: "deleteSelection", allowInTree: false },
                { combo: "Backspace", action: "deleteSelection", allowInTree: false },
                // Files & origin
                { combo: "i", action: "addFiles", allowInTree: false },
                { combo: "b", action: "bottomLeftOrigin" },
                { combo: "o", action: "offsetOrigin" },
                { combo: "c", action: "centerOrigin" },
                // Pan. shiftOptional because the handler reads e.shiftKey.
                { combo: "ArrowLeft", action: "pan", args: [1, 0], allowInTree: false, shiftOptional: true },
                { combo: "ArrowRight", action: "pan", args: [-1, 0], allowInTree: false, shiftOptional: true },
                { combo: "ArrowUp", action: "pan", args: [0, 1], allowInTree: false, shiftOptional: true },
                { combo: "ArrowDown", action: "pan", args: [0, -1], allowInTree: false, shiftOptional: true }
            ],

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

            logHistoryMax: 500
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