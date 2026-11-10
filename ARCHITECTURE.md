# EasyCAM5000 Architecture

Repository layout, local setup, the documentation pages and debugging. For what the apps *do*, see the [suite README](./README.md) and the per-app READMEs.

## Shape of the project

One shared engine at the repository root. Each app is a thin directory that supplies a UI, an operation set, and a profile JSON - no app owns any geometry, toolpath or export code.

A job moves through the same pipeline in both apps, and every stage's output is a renderer layer you can toggle:

```
file → parse → primitives → geometry (offsets) → toolpath plans → G-code / SVG / PNG
```

Operations are declarative. `ui/profile-trace.json` and `ui/profile-shape.json` name each operation's type, handler class, machine classes, file extensions, parameters and stage chain; `ui/ui-operation-registry.js` answers every question about an operation type from them.

## Directories at a glance

| Directory | Role |
|---|---|
| `core/` | Engine: operation state, parameters, pipeline context, ingest, controller, custom files |
| `parsers/` | Gerber, Excellon, SVG, STL → primitives |
| `geometry/` | Clipper2 booleans, offsets, arc reconstruction, v-carve, the 3D field pipeline, the worker |
| `operations/` | One handler per operation type |
| `toolpath/` | Geometry → machine motion (translate, optimize, process) |
| `export/` | G-code generation, post-processor setups and their logic, laser SVG/PNG and laser profiles, ZIP output |
| `renderer/` | 2D canvas renderer |
| `renderer3d/` | 3D preview (ES modules + three.js, dynamic import only) |
| `ui/` | Shared UI: registry, parameter forms, modals, status, tooltips, the two app profiles |
| `tools/` | The default tool library and the module that checks and serves it |
| `input/` | Pointer, keyboard, undo/redo |
| `utils/` | Transform maths, scene graph, SVG canvas export |
| `easytrace5000/` - `easyshape5000/` | The two apps: controller, UI, panels, `index.html`, `doc/` |
| `themes/` - `language/` - `css/` | Palettes and their loader, language packs, stylesheets |
| `.github/scripts/` | The production build and the generators for documentation, icons and the theme |

Configuration lives in `config.js` (engine constants, defaults and the Machine Settings schema), the two app profile JSONs (operations, parameters, and their deltas over that schema), `export/processors/*.json` (one setup per post-processor), `export/profiles/*.json` (one profile per laser program) and `tools/tools.json` (the default tool library). The data formats have references of their own: [themes/README.md](./themes/README.md), [tools/README.md](./tools/README.md), [export/processors/README.md](./export/processors/README.md), [export/profiles/README.md](./export/profiles/README.md), [language/README.md](./language/README.md), and [core/CUSTOM.md](./core/CUSTOM.md).

## Full repository tree

<details>
<summary><b>View full project structure</b></summary>

```text
/
├── index.html                              # Suite landing page
├── 404.html                                # Error page
├── config.js                               # Constants, defaults and the Machine Settings schema (constants frozen at runtime)
├── README.md - CHANGELOG.md - LICENSE      # Overview, history, AGPL-3.0-or-later
├── ARCHITECTURE.md - CONTRIBUTING.md       # This file, contribution policy
├── SECURITY.md - SUPPORT.md                # Disclosure policy, where to get help
├── CODE_OF_CONDUCT.md - CITATION.cff       # Contributor Covenant, citation metadata
├── NOTICE                                  # Third-party attributions
├── fiveserver.config.js                    # Local dev server config (VS Code Five Server)
├── context-gen.js                          # Dev aid: writes PROJECT_CONTEXT.txt (symbol/dependency index)
├── file-bundle.js                          # Dev aid: writes FILE_BUNDLE.txt (source packed into one file)
│
├── core/
│   ├── cam-core.js                         # Engine facade - settings, pipeline execution, export planning
│   ├── cam-controller.js                   # Shared controller base - init, profile loading, WASM, file intake, export coordination
│   ├── operation-store.js                  # Operation lifetime, revision stamps, artifact staleness, invalidation
│   ├── parameter-store.js                  # Parameter definitions, validation, per-operation state
│   ├── pipeline-context.js                 # Tool descriptors, compiled parameters, depth levels, frozen run context
│   ├── operation-ingest.js                 # File to primitives - parse, plot, classify, composite, analyse, bound
│   ├── custom-files.js                     # User-added JSON files - check, use, store (one per kind), remove, restore at startup
│   ├── file-rules.js                       # The rules engine those checks run on, and a lint of the rules file
│   ├── file-validation.json                # The rules every custom file must pass
│   └── CUSTOM.md                           # Custom files: kinds, rules, storage, startup
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
│   ├── geometry-arc-reconstructor.js       # Recovers true arcs after Clipper2 booleans
│   ├── geometry-curve-registry.js          # Curve metadata store that makes arc reconstruction possible
│   ├── geometry-utils.js                   # General helpers - winding, bounds, stroke expansion, simplification
│   ├── geometry-utils-points.js            # Point and bounds helpers, primitive hit tests
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
│   ├── geometry-utils-sections.js          # Cross-section stack (only a debug cross-check calls it)
│   └── field-worker.js                     # Web Worker: mesh slicing, relief/rotary generation, V-Carve fan-out
│
├── operations/
│   ├── base-operation-handler.js           # Contract every operation type implements
│   ├── offset-operation-handler.js         # Shared offset pipeline for all contour-based operations
│   ├── drill-operation-handler.js          # Drill strategy planning, SVG classification, shape recovery, drill table
│   ├── field-operation-handler.js          # Shared layer for the 3D handlers, the worker pool client, workholding and the indexed blank
│   ├── trace-isolation-handler.js          # Isolation routing - external offsets around copper
│   ├── trace-clearing-handler.js           # Copper clearing - always-internal offsets
│   ├── trace-cutout-handler.js             # Board cutout - cut side, closure detection, tabs
│   ├── trace-stencil-handler.js            # Solder stencil apertures with drill-pad exclusion
│   ├── shape-profile-handler.js            # Profile cut - cut side and holding tabs
│   ├── shape-pocket-handler.js             # Pocket clearing - internal offsets by stepover
│   ├── shape-engrave-handler.js            # Zero-offset centerline engraving, open and closed paths
│   ├── shape-vcarve-handler.js             # V-Carve - medial-axis paths with multi-region worker fan-out
│   ├── shape-relief-handler.js             # Relief - heightmap-driven roughing and finishing rasters
│   ├── shape-rotary-handler.js             # Continuous rotary - surfacing in developed coordinates
│   ├── shape-rotary-indexed-handler.js     # Indexed 3+1 - N flat reliefs at fixed A angles
│   └── shape-pattern-handler.js            # Pattern generator (stub, not loaded)
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
│   ├── gcode-generator.js                  # Plans → G-code; builds each post from its setup and logic
│   ├── graphics-exporter.js                # Laser SVG/PNG with colour-mapped passes and heat sorting
│   ├── zip-writer.js                       # ZIP container (store, no compression) for multi-file exports
│   ├── profiles/
│   │   ├── README.md                       # Laser profile format, parameters, custom profiles
│   │   └── <id>.json                       # One profile per program: generic, lasergrbl, xtoolstudio, lightburn, rdworks
│   └── processors/
│       ├── README.md                       # CNC setup format, flags, logic, custom setups
│       ├── <id>.json                       # One default machine setup per post: grbl, makera, grblhal, uccnc, marlin, mach3, linuxcnc, fanuc, winpcnc, roland
│       ├── base-processor.js               # The rs274 logic every G-code setup builds on
│       ├── makera-processor.js             # Makera overrides
│       ├── fanuc-processor.js              # Fanuc overrides
│       ├── winpcnc-processor.js            # WinPC-NC overrides (DIN/ISO interpreter)
│       └── roland-processor.js             # RML logic (Roland RML-1)
│
├── renderer/
│   ├── renderer-core.js                    # Canvas, view state, layer registry, transforms, culling
│   ├── renderer-layer.js                   # Layer ordering, batched draw passes
│   ├── renderer-primitives.js              # Primitive drawing and tool-relation colouring
│   └── renderer-overlay.js                 # Grid, rulers, origin, scale indicator, stats
│
├── renderer3d/                             # ES modules, dynamic import only, never in the classic bundle
│   ├── renderer3d-core.js                  # Entry point - scene, camera, resize, dispose, sub-layers, ground grid
│   ├── renderer3d-geometry.js              # 2D geometry mirrored into 3D with status colour parity
│   ├── renderer3d-toolpath.js              # Plans → line geometry; owns the rotary/indexed display wrap
│   ├── renderer3d-stock.js                 # Stock box, model mesh, rotary and indexed blanks, rotary envelope
│   ├── renderer3d-workholding.js           # Chuck and tailstock on the rotary axis
│   ├── renderer3d-transform-cue.js         # Arrow for a focused Shape Transform field
│   ├── renderer3d-orientation.js           # Corner axis cue, axis transform cues
│   ├── renderer3d-simulator.js             # Playback motion table (built, not yet wired to the UI)
│   ├── renderer3d-orbit-tool.js            # Orbit/pan/dolly camera tool on the shared input stack
│   └── three.*.min.js                      # three.js WebGPU build (vendored)
│
├── ui/
│   ├── ui-operation-registry.js            # Single source of truth for what an operation TYPE is
│   ├── ui-input-renderer.js                # Schema-driven parameter form rendering, visibility, and option gates
│   ├── ui-base-app.js                      # Shared app UI base - renderer, viewport, status, theme, Machine Settings
│   ├── ui-base-operation-panel.js          # Shared parameter panel - stage dispatch, generation, actions
│   ├── ui-modal-manager.js                 # Modal lifecycle, stack, hash routing, focus trap + modal view binding
│   ├── ui-status-manager.js                # Status bar, log panel, progress overlay and footer bar
│   ├── ui-controls.js                      # Collapsibles, sidebar and form keyboard navigation, trees, visualization toggles
│   ├── ui-tooltip.js                       # Tooltip system (exports a singleton, not a class)
│   ├── profile-trace.json                  # EasyTrace5000 operation types, parameters and stage chains
│   └── profile-shape.json                  # EasyShape5000 operation types, parameters and stage chains
│
├── tools/
│   ├── tools.json                          # Default tool library (schema in its _schema block)
│   ├── tool-library.js                     # Tool validation, lookup, sizing, custom library replacement
│   └── README.md                           # Fields, how the apps use them, custom libraries
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
│   ├── transform-math-3d.js                # Single source of truth for 3D rotation math and mesh placement
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
│   ├── cam-easyshape5000.js                # Controller - scene, history, mutations, keyboard
│   ├── ui-core-shape.js                    # UI orchestrator - panels, layers, transforms, selection
│   ├── ui-nav-scene-panel.js               # Scene graph tree (left sidebar)
│   ├── ui-shape-buckets-panel.js           # Operation buckets and their stage nodes
│   ├── ui-shape-operation-panel.js         # Staged parameter panel (right sidebar)
│   ├── README.md                           # App overview
│   └── doc/
│       ├── index.html                      # Documentation entry
│       ├── guide.html                      # Workflow guide
│       ├── operations.html                 # Operation reference
│       ├── parameters.html                 # Parameter reference
│       ├── accessibility.html              # Generated from ACCESSIBILITY.md
│       └── ACCESSIBILITY.md                # Keyboard controls, screen readers, WCAG status
│
├── css/
│   ├── base.css                            # Reset, variables, typography, utilities
│   ├── components.css                      # Buttons, inputs, tooltips, badges, dropdowns
│   ├── layout-shared.css                   # Toolbar, workspace grid, sidebars, footer, status bar
│   ├── layout-easytrace5000.css            # Operation tree, file nodes, upload zones
│   ├── layout-easyshape5000.css            # Scene tree, operation palette, staged parameter forms
│   ├── modals.css                          # Modal system - base structure and per-modal layouts
│   ├── theme.css                           # :root block GENERATED from themes/dark.json by sync-theme.js
│   └── doc.css                             # Documentation and landing page styles
│
├── themes/
│   ├── theme-loader.js                     # Runtime theme registration, application and switching
│   ├── dark.json                           # Default palette; the key set every theme must match
│   ├── light.json                          # Light theme
│   ├── hc-dark.json - hc-light.json        # High-contrast variants
│   └── README.md                           # Theme contract, prefixes, custom themes
│
├── language/
│   ├── README.md                           # How packs are used, what a translation keeps, reviewing a language
│   ├── language-manager.js                 # Pack loading, lookup with fallbacks, plurals, lists, static markup
│   ├── language-pack-rules.js              # The rules a pack keeps - shared by the apps, the custom-file check and the comparator
│   ├── en.json                             # English - the complete reference every other pack is checked against
│   ├── <locale>.json                       # Translations (a missing key shows English); registered when constants.languages lists the locale
│   └── comparator/                         # Pack comparator, live at /language/comparator/
│
├── examples/
│   ├── exampleSMD1/                        # Sample SMD board (CC BY-NC)
│   ├── exampleThroughHole1/                # Sample through-hole board (CC0)
│   ├── temp/                               # EasyShape5000 examples (All rights reserved until proven otherwise)
│   ├── LineTest.svg                        # Precision test pattern (CC BY-NC)
│   └── 100mmSquare.svg                     # 100×100 mm square for steps/mm verification
│
├── images/                                 # Screenshots, favicons, social cards, sponsors
│   ├── figures.js                          # Loads doc figures in source (build.js inlines them in dist)
│   ├── doc/                                # Documentation figures (fig-*.svg)
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
        ├── build-doc-params.js             # config.js + profiles + en.json → the parameters.html tables
        ├── sync-theme.js                   # dark.json → css/theme.css, with a light/dark key-parity gate
        └── sync-accessibility.js           # ACCESSIBILITY.md → accessibility.html
```

</details>

## Running locally

The apps fetch modules and JSON at runtime, so opening `index.html` from the file system fails on CORS. You need a local server.

```bash
git clone https://github.com/RicardoJCMarques/EasyCAM5000.git
cd EasyCAM5000
npx serve                # or: python -m http.server 8000
```

Then open `easytrace5000/` or `easyshape5000/` under the served address. A [Five Server](https://github.com/yandeu/five-server-vscode) config (`fiveserver.config.js`) is included for VS Code and serves on `:5500`.

There is no build step for development - the apps load the source files
directly, so a plain refresh picks up every change.

## Production build

```bash
node .github/scripts/build.js --src . --dist ./dist            # plain
node .github/scripts/build.js --src . --dist ./dist --minify   # what CI deploys
```

`dist/` inlines CSS, embeds the default JSONs (language, tools, setups, laser profiles, custom-file rules, profiles) into their modules, bundles each app's scripts into one file, inlines the field worker's dependencies, and flattens the 3D preview into a single ES module. Language packs, English included, also ship as files: the apps fetch a translation when it is chosen, and the comparator reads them all. Deployment runs the same command from `.github/workflows/publish.yml`, so a local `--minify` build reproduces the deployed artifact.

Three states have to work: raw source, plain `dist/`, and minified `dist/`. Test production-only problems against `dist/`, not the source tree.

`node .github/scripts/build.js --help` lists the flags.

## Documentation pages

The site's documentation lives in each app's `doc/` folder, in English. Most pages are hand-written HTML; two are script generated and must not be edited by hand:

* `parameters.html` - the tables between the `PARAMS-TOC` and `PARAMS` markers come from `config.js` (Machine Settings), the app profile (operation parameters) and `language/en.json` (every caption). Run `node .github/scripts/build-doc-params.js` after changing any of them; it fails when en.json lacks a caption the tables need.
* `accessibility.html` - generated whole from `ACCESSIBILITY.md` by `node .github/scripts/sync-accessibility.js`. Edit the Markdown.

Pages share `css/doc.css`, the theme loader and `images/figures.js`, which loads
`<div class="doc-figure" data-figure="fig-*.svg">` placeholders from `images/doc/`.

## Debugging

<kbd>Ctrl+Alt+D</kbd>, or the Verbose Debug toggle in the Visualization panel's Log section, turns on verbose logging. Most modules carry a `debug(message, data)` method gated on the same flag, so turning it on gives you the whole pipeline rather than one layer of it.