# EasyCAM5000 Architecture

Repository layout, local setup, and debugging. For what the apps *do*, see the
[suite README](./README.md) and the per-app READMEs.

## Shape of the project

One shared engine at the repository root. Each app is a thin directory that
supplies a UI, an operation set, and a profile JSON — no app owns any geometry,
toolpath or export code.

A job moves through five stages, and every stage's output is a renderer layer
you can toggle:

```
file → parse → primitives → geometry (offsets) → toolpath plans → G-code / SVG
```

Operations are declarative. `ui/profile-trace.json` and `ui/profile-shape.json`
name each operation's type, handler class, machine classes, parameters and stage
chain; `ui/ui-operation-registry.js` answers every question the rest of the app
used to answer with a hardcoded switch.

## Directories at a glance

| Directory | Role |
|---|---|
| `core/` | Engine: operation state, pipeline context, ingest, controller |
| `parsers/` | Gerber, Excellon, SVG, STL → primitives |
| `geometry/` | Clipper2 booleans, offsets, arc reconstruction, v-carve, the 3D field pipeline, the worker |
| `operations/` | One handler per operation type |
| `toolpath/` | Geometry → machine motion (translate, optimize, process) |
| `export/` | G-code generation, ten post-processors, laser SVG/PNG |
| `renderer/` | 2D canvas renderer |
| `renderer3d/` | 3D preview (ES modules + three.js, dynamic import only) |
| `ui/` | Shared UI: registry, parameters, modals, status, tools |
| `input/` | Pointer, keyboard, undo/redo |
| `utils/` | Transform maths, scene graph, SVG canvas export |
| `easytrace5000/` · `easyshape5000/` | The two apps: controller, UI, panels, `index.html`, `doc/` |
| `themes/` · `language/` · `css/` | Palettes, strings, stylesheets |
| `.github/scripts/` | Build and sync tooling |

Configuration lives in three places: `config.js` (engine constants and
defaults), `tools.json` (the default tool library), and the two profile JSONs.

## Full repository tree

<details>
<summary><b>View full project structure</b></summary>

```text
/
├── index.html                              # Suite landing page
├── 404.html                                # Error page
├── config.js                               # Configuration, constants and defaults (frozen at runtime)
├── tools.json                              # Default tool library
├── README.md · CHANGELOG.md · LICENSE      # Overview, history, AGPL-3.0-or-later
├── ARCHITECTURE.md · CONTRIBUTING.md       # This file, contribution policy
├── SECURITY.md · SUPPORT.md                # Disclosure policy, where to get help
├── CODE_OF_CONDUCT.md · CITATION.cff       # Contributor Covenant, citation metadata
├── NOTICE                                  # Third-party attributions
├── fiveserver.config.js                    # Local dev server config (VS Code Five Server)
├── context-gen.js                          # Dev aid: writes PROJECT_CONTEXT.txt (symbol/dependency index)
├── file-bundle.js                          # Dev aid: writes FILE_BUNDLE.txt (source packed into one file)
│
├── core/
│   ├── cam-core.js                         # Core engine facade - state, pipeline execution, shared infrastructure
│   ├── cam-controller.js                   # Shared controller base - init, profile loading, WASM, export coordination
│   ├── operation-store.js                  # Operation lifetime, revision stamps, artifact staleness, invalidation
│   ├── pipeline-context.js                 # Tool descriptors, compiled parameters, depth levels, frozen run context
│   └── operation-ingest.js                 # File to primitives - parse, plot, classify, composite, analyse, bound
│
├── parsers/
│   ├── parser-core.js                      # Shared parsing infrastructure for all formats
│   ├── parser-gerber.js                    # Gerber RS-274X parser
│   ├── parser-excellon.js                  # Excellon drill parser
│   ├── parser-svg.js                       # SVG parser - full path spec, analytic arcs and Béziers
│   ├── parser-stl.js                       # STL mesh parser (binary + ASCII); raw triangles, bypasses the plotter
│   ├── parser-plotter.js                   # Parsed objects → primitives; tessellates only what it must
│   └── primitives.js                       # Primitive data structures every stage passes around
│
├── geometry/
│   ├── clipper2z.js                        # Clipper2 WASM factory (vendored)
│   ├── clipper2z.wasm                      # Clipper2 WASM binary
│   ├── delaunator.5.0.0.min.js             # Delaunay triangulation (vendored; worker and main thread)
│   ├── geometry-clipper-wrapper.js         # Clipper2 intermediary - booleans, Z-metadata packing, native offsets
│   ├── geometry-processor.js               # Boolean orchestration - fuse, union, offset, difference
│   ├── geometry-offsetter.js               # Offsetting orchestrator - the inflating 2D pipeline
│   ├── geometry-offsetter-analytic.js      # Analytic path offsetting (in development, not wired)
│   ├── geometry-arc-reconstructor.js       # Recovers true arcs after Clipper2 booleans
│   ├── geometry-curve-registry.js          # Curve metadata store that makes arc reconstruction possible
│   ├── geometry-utils.js                   # General helpers - winding, bounds, stroke expansion, simplification
│   ├── geometry-utils-math.js              # Analytic offsetting math (in development, not wired)
│   ├── geometry-utils-tessellation.js      # Analytic curves → line segments; arc and Bézier sampling
│   ├── geometry-utils-topology.js          # Loop extraction, containment, compound contour resolution
│   ├── geometry-utils-hatching.js          # Scanline hatch fill generator for laser operations
│   ├── geometry-utils-vcarve.js            # Medial axis (Voronoi dual) for V-Carve centerline paths
│   ├── geometry-utils-toolprofile.js       # Tool-of-revolution tip profiles - single source for h(d)
│   ├── geometry-utils-field.js             # Scalar-field infrastructure shared by relief and rotary
│   ├── geometry-utils-heightmap.js         # Heightmap grid + on-demand mesh rasterization
│   ├── geometry-utils-cylmap.js            # Cylindrical radius map + mesh slicer - the rotary analogue
│   ├── geometry-utils-fieldpipeline.js     # The shared sequence every field-driven 3D operation runs
│   ├── geometry-utils-fieldpaths.js        # Raster engine over compensated fields - roughing and finishing
│   ├── geometry-utils-relief.js            # Relief / 2.5D mold - the planar adapter over FieldPipeline
│   ├── geometry-utils-rotary.js            # Rotary 4th axis - the cylindrical adapter over FieldPipeline
│   ├── geometry-utils-sections.js          # Cross-section stack for axis-based operations (no callers yet)
│   └── field-worker.js                     # Web Worker: mesh slicing, relief/rotary generation, V-Carve fan-out
│
├── operations/
│   ├── base-operation-handler.js           # Contract every operation type implements
│   ├── offset-operation-handler.js         # Shared offset pipeline for all contour-based operations
│   ├── drill-operation-handler.js          # Drill strategy planning, SVG classification, shape recovery
│   ├── field-operation-handler.js          # Shared layer for the 3D handlers + the worker pool client
│   ├── trace-isolation-handler.js          # Isolation routing - external offsets around copper
│   ├── trace-clearing-handler.js           # Copper clearing - always-internal offsets
│   ├── trace-cutout-handler.js             # Board cutout - cut side, closure detection, tabs
│   ├── trace-stencil-handler.js            # Solder stencil apertures with drill-pad exclusion
│   ├── shape-profile-handler.js            # Profile cut - cut side and holding tabs
│   ├── shape-pocket-handler.js             # Pocket clearing - internal offsets by stepover
│   ├── shape-drill-handler.js              # Drill for EasyShape5000 - thin extension of DrillHandler
│   ├── shape-engrave-handler.js            # Zero-offset centerline engraving, open and closed paths
│   ├── shape-vcarve-handler.js             # V-Carve - medial-axis paths with multi-region worker fan-out
│   ├── shape-relief-handler.js             # Relief - heightmap-driven roughing and finishing rasters
│   ├── shape-rotary-handler.js             # Continuous rotary - surfacing in developed coordinates
│   ├── shape-rotary-indexed-handler.js     # Indexed 3+1 - N flat reliefs at fixed A angles
│   └── shape-pattern-handler.js            # Pattern generator (stub, not functional)
│
├── toolpath/
│   ├── toolpath-primitives.js              # MotionCommand, ToolpathPlan, feed resolution
│   ├── toolpath-geometry-translator.js     # Annotated primitives → ToolpathPlans; primitive-driven dispatch
│   ├── toolpath-3d-translator.js           # 3D contour chains (v-carve, relief rasters) → plans
│   ├── toolpath-tab-planner.js             # Tab placement and geometry splitting for cutouts
│   ├── toolpath-optimizer.js               # Staydown clustering, path ordering, segment simplification
│   └── toolpath-machine-processor.js       # Rapids, plunges, entries, helical cycles, rotary routes
│
├── export/
│   ├── gcode-generator.js                  # Plans → G-code; processor registry and dispatch
│   ├── graphics-exporter.js                # Laser SVG/PNG with colour-mapped passes and heat sorting
│   └── processors/
│       ├── base-processor.js               # Post-processor contract and shared formatting
│       ├── grbl-processor.js               # GRBL
│       ├── grblHAL-processor.js            # grblHAL
│       ├── makera-processor.js             # Makera (Carvera)
│       ├── uccnc-processor.js              # UCCNC
│       ├── mach3-processor.js              # Mach3
│       ├── linuxcnc-processor.js           # LinuxCNC
│       ├── marlin-processor.js             # Marlin
│       ├── fanuc-processor.js              # Fanuc variants
│       ├── winpcnc-processor.js            # WinPC-NC (DIN/ISO interpreter)
│       └── roland-processor.js             # Roland RML-1
│
├── renderer/
│   ├── renderer-core.js                    # Canvas, view state, layer registry, transforms
│   ├── renderer-layer.js                   # Layer ordering, culling, batched draw passes
│   ├── renderer-primitives.js              # Primitive drawing and tool-relation colouring
│   └── renderer-overlay.js                 # Grid, rulers, origin, scale indicator, stats
│
├── renderer3d/                             # ES modules, dynamic import only, never in the classic bundle
│   ├── renderer3d-core.js                  # Entry point - scene, camera, resize, dispose, sub-layers
│   ├── renderer3d-geometry.js              # 2D geometry mirrored into 3D with status colour parity
│   ├── renderer3d-toolpath.js              # Plans → line geometry; owns the rotary/indexed display wrap
│   ├── renderer3d-stock.js                 # Stock box and heightmap surface mesh
│   ├── renderer3d-simulator.js             # Playback motion table (built, not yet wired to the UI)
│   ├── renderer3d-orbit-tool.js            # Orbit/pan/dolly camera tool on the shared input stack
│   └── three.*.min.js                      # three.js WebGPU build (vendored)
│
├── ui/
│   ├── ui-operation-registry.js            # Single source of truth for what an operation TYPE is
│   ├── ui-input-renderer.js                # 
│   ├── ui-base-app.js                      # Shared app UI base - renderer, viewport, status, theme
│   ├── ui-base-operation-panel.js          # Shared parameter panel - stage dispatch, generation, actions
│   ├── ui-modal-manager.js                 # All modals - export, drill tooling, welcome, quickstart, help
│   ├── ui-machine-settings.js              # Post-processor selection, Roland profiles, laser and CNC settings
│   ├── ui-status-manager.js                # Status bar, log panel, progress overlay and footer bar
│   ├── ui-controls.js                      # Focus zones, collapsibles, sidebar nav, visualization toggles
│   ├── ui-tooltip.js                       # Tooltip system (exports a singleton, not a class)
│   ├── tool-library.js                     # Tool definitions, sizing, import/export
│   ├── profile-trace.json                  # EasyTrace5000 operation types, parameters and stage chains
│   └── profile-shape.json                  # EasyShape5000 operation types, parameters and stage chains
│
├── input/
│   ├── input-manager.js                    # Pointer/wheel/keyboard normalization at capture phase
│   ├── tool-controller.js                  # Tool state machine with an override slot
│   ├── tools-common.js                     # PanZoomTool - shared across both apps
│   ├── tools-interactive.js                # SelectMoveTool - EasyShape5000 pick, drag, marquee
│   ├── keyboard-manager.js                 # Centralized shortcut routing, one document listener
│   ├── command-manager.js                  # Undo/redo history storing deltas, not snapshots
│   └── canvas-readout.js                   # Footer coordinate and zoom chip
│
├── utils/
│   ├── transform-math.js                   # Single source of truth for 2D affine transform math
│   ├── transform-math-3d.js                # Single source of truth for 3D rotation math
│   ├── coordinate-system.js                # Scene graph (nodes, groups, selection) and workspace transform
│   └── canvas-exporter.js                  # Canvas contents → optimized SVG (development aid)
│
├── easytrace5000/
│   ├── index.html                          # App entry
│   ├── cam-easytrace5000.js                # Controller - file handling, export, orchestration
│   ├── ui-core-trace.js                    # UI orchestrator - panels, fusion, board transforms, layers
│   ├── ui-nav-tree-panel.js                # Operations tree (left sidebar)
│   ├── ui-trace-operation-panel.js         # Parameter panel (right sidebar)
│   ├── README.md                           # App overview
│   └── doc/
│       ├── index.html                      # Documentation entry
│       ├── cnc.html                        # CNC pipeline walkthrough
│       ├── laser.html                      # Laser pipeline walkthrough
│       ├── operations.html                 # Operation reference
│       ├── parameters.html                 # Parameter reference
│       ├── accessibility.html              # Generated from ACCESSIBILITY.md
│       └── ACCESSIBILITY.md                # Keyboard controls, screen readers, WCAG status
│
├── easyshape5000/
│   ├── index.html                          # App entry
│   ├── cam-easyshape5000.js                # Controller - scene, history, mutations, modals, keyboard
│   ├── ui-core-shape.js                    # UI orchestrator - panels, layers, transforms, selection
│   ├── ui-nav-scene-panel.js               # Scene graph tree (left sidebar)
│   ├── ui-shape-buckets-panel.js           # Operation buckets and their stage nodes
│   ├── ui-shape-operation-panel.js         # Staged parameter panel (right sidebar)
│   ├── README.md                           # App overview
│   └── doc/
│       ├── index.html                      # Documentation entry
│       ├── guide.html                      # Workflow guide
│       ├── operations.html                 # Operation reference
│       └── parameters.html                 # Parameter reference
│
├── css/
│   ├── base.css                            # Reset, variables, typography, utilities
│   ├── components.css                      # Buttons, inputs, tooltips, badges, dropdowns
│   ├── layout-shared.css                   # Toolbar, workspace grid, sidebars, footer, status bar
│   ├── layout-easytrace5000.css            # Operation tree, file nodes, upload zones
│   ├── layout-easyshape5000.css            # Scene tree, operation palette, staged parameter forms
│   ├── modals.css                          # Modal system - base structure and per-modal layouts
│   ├── theme.css                           # GENERATED from themes/dark.json by sync-theme.js
│   └── doc.css                             # Documentation page styles
│
├── themes/
│   ├── theme-loader.js                     # Runtime theme application and switching
│   ├── dark.json                           # Reference palette schema
│   └── light.json                          # Must match dark.json's key set exactly
│
├── language/
│   ├── language-manager.js                 # Dotted-key string lookup with fallbacks
│   └── en.json                             # English strings (the only pack, incomplete)
│
├── examples/
│   ├── exampleSMD1/                        # Sample SMD board (CC BY-NC)
│   ├── exampleThroughHole1/                # Sample through-hole board (CC0)
│   ├── mesa/                               # EasyShape5000 example (All rights reserved until proven otherwise)
│   ├── LineTest.svg                        # Precision test pattern (CC BY-NC)
│   └── 100mmSquare.svg                     # 100×100 mm square for steps/mm verification
│
├── images/                                 # Screenshots, favicons, social cards
│   └── icons/                              # icon-*.svg sources + generated sprite.svg
│
└── .github/
    ├── workflows/publish.yml               # Build + FTP deploy on push to main
    ├── ISSUE_TEMPLATE/                     # Bug, feature and accessibility forms + config
    ├── PULL_REQUEST_TEMPLATE.md
    ├── FUNDING.yml
    └── scripts/
        ├── build.js                        # Production build - embed, bundle, minify, verify
        ├── build-sprite.js                 # icon-*.svg → sprite.svg
        ├── sync-theme.js                   # dark.json → css/theme.css, with a light/dark parity gate
        └── sync-accessibility.js           # ACCESSIBILITY.md → accessibility.html
```

</details>

## Running locally

The apps fetch modules and JSON at runtime, so opening `index.html` from the
file system fails on CORS. You need a local server.

```bash
git clone https://github.com/RicardoJCMarques/EasyCAM5000.git
cd EasyCAM5000
npx serve                # or: python -m http.server 8000
```

Then open `easytrace5000/` or `easyshape5000/` under the served address. A
[Five Server](https://github.com/yandeu/five-server-vscode) config
(`fiveserver.config.js`) is included for VS Code and serves on `:5500`.

There is no build step for development — the apps load the source files
directly, so a plain refresh picks up every change.

## Production build

```bash
node .github/scripts/build.js --src . --dist ./dist            # plain
node .github/scripts/build.js --src . --dist ./dist --minify   # what CI deploys
```

`dist/` inlines CSS, embeds the default JSONs into their modules, bundles each
app's scripts into one file, inlines the field worker's dependencies, and
flattens the 3D preview into a single ES module. Deployment runs the same
command from `.github/workflows/publish.yml`, so a local `--minify` build
reproduces the deployed artifact.

Three states have to work: raw source, plain `dist/`, and minified `dist/`. Test
production-only problems against `dist/`, not the source tree.

`node .github/scripts/build.js --help` lists the flags.

## Debugging

Verbose logging can also be toggled from the Visualization options panel.

Most modules carry a `debug(message, data)` method gated on the same flag, so
turning debug on gives you the whole pipeline rather than one layer of it.