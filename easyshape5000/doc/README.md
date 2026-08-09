# EasyShape5000 - Browser-Based CNC Router CAM

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg) ![Status: v1.0](https://img.shields.io/badge/status-v1.0-green.svg) ![Tech: VanillaJS](https://img.shields.io/badge/tech-Vanilla_JS-yellow.svg)

EasyShape5000 is a browser-based CAM tool for CNC routers. Import SVG designs, assign per-shape operations (profile, pocket, drill), and export G-code. 100% client-side - no installation, no cloud, no accounts.

Part of the [Eltryus EasyCAM5000 Suite](../README.md), sharing its geometry engine, renderer, and export pipeline with [EasyTrace5000](../easytrace5000/README.md) (PCB fabrication).

**[→ Launch Application ←](https://cam.eltryus.design/easyshape5000/)** · **[Documentation](https://cam.eltryus.design/easyshape5000/doc/)** · **[Workflow Guide](https://cam.eltryus.design/easyshape5000/doc/guide)**

## Key Features

### Scene Graph
* Hierarchical tree of groups and shapes imported from SVG
* Group/ungroup with <kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd>
* Per-shape transforms: translate, rotate, scale, mirror (X/Y independent)
* Lock and visibility controls per node
* Full undo/redo for all structural mutations

### Operations
* **Profile Cut** - outside, inside, or on-line contour cutting with nesting detection and optional holding tabs
* **Pocket Clearing** - concentric inward offsets with configurable stepover; inner shapes become holes automatically
* **Drilling** - automatic peck-or-mill strategy selection for circles and obround slots
* **Engraving** - follow paths at fixed depth, no fill yet.
* **V-Carve** - 
* **3D Relief** - 
* **Pattern Generator** - (likely getting a spin-off UI)

### Canvas Interaction
* Click-select, shift-toggle, ctrl-add, marquee rectangle
* Drag-move with parent-space delta projection (correct inside rotated groups)
* Alt-click to bypass groups and select individual leaf shapes
* Scroll-wheel zoom at cursor position
* Middle/right-click pan, two-finger pinch zoom

### Export Pipeline
* Three-stage toolpath optimization: translation → staydown clustering + path ordering → machine processing
* Multi-depth pass generation with configurable entry strategies
* Holding tab Z-lifts for profile cuts
* Post-processors: GRBL (stable), grblHAL, Marlin, LinuxCNC, Mach3, UCCNC, Makera, Roland RML (experimental)

## Quick Start

1. **Import:** Drag an SVG onto the canvas or use Actions → Import SVG
2. **Select:** Click shapes on canvas or in the scene tree
3. **Assign:** Choose Profile, Pocket, or Drill from the right sidebar
4. **Configure:** Set tool, cut side, depth, stepover
5. **Generate:** Click Generate to compute offset geometry
6. **Preview:** Click Generate Preview for tool-reach visualization
7. **Export:** Open Export Manager → Calculate Toolpaths → Export Files

See the [Workflow Guide](https://cam.eltryus.design/easyshape5000/doc/guide) for a detailed walkthrough.

## File Compatibility

* **SVG** - full path spec: lines, arcs, quadratic/cubic Béziers. Group hierarchies preserved. Clones and clip paths not yet supported.
* **STL** - for 3D relief operations

Bézier curves are interpolated into line segments before offsetting. True analytic Bézier offsetting is not yet supported.

## How It Differs From EasyTrace5000

| | EasyTrace5000 | EasyShape5000 |
|---|---|---|
| **Purpose** | PCB fabrication | General CNC routing |
| **Input** | Gerber, Excellon, SVG | SVG |
| **Model** | File-per-operation | Scene graph, per-shape ops |
| **Transforms** | Board-level (rotation, mirror, origin) | Per-shape (translate, rotate, scale, mirror) |
| **Pipelines** | CNC + Laser | CNC (laser planned) |
| **Undo/Redo** | No | Full command history |
| **Grouping** | No | Yes (nested groups) |

## Current Limitations

* No laser export pipeline (CNC only)
* No automatic tool change (M6) - separate files per tool
* Pattern operation is not yet functional
* Touch pinch-to-zoom not available on the select tool (works during pan)
* Experimental post-processors need real-machine verification (inhereted from EasyTrace5000)

## Development

EasyShape5000 lives in the `easyshape5000/` directory. App-specific files:

```
easyshape5000/
├── cam-easyshape5000.js      Controller
├── ui-core-shape.js           UI orchestrator
├── ui-nav-scene-panel.js      Scene tree panel
├── ui-shape-buckets-panel.js  Operations bucket panel
├── ui-shape-operation-panel.js Operation parameter panel
├── index.html                 App entry point
└── doc/                       Documentation
```

All shared infrastructure (renderer, geometry engine, parsers, toolpath pipeline, export) lives in the repository root directories. See the [suite README](../README.md) for the full project structure.

```bash
# Serve locally
npx serve ..
# Navigate to http://localhost:3000/easyshape5000/
```

## License

AGPL-3.0-or-later. See [LICENSE](../LICENSE).
