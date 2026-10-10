# EasyShape5000 - Browser-Based CNC Router CAM

![Status: v1.4.0](https://img.shields.io/badge/status-v1.4.0-green.svg)
![Part of: EasyCAM5000](https://img.shields.io/badge/suite-EasyCAM5000-blue.svg)
![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)

EasyShape5000 is a CAM tool for CNC routers, covering everything from flat SVG cutting to 3D surfacing and 4th-axis work. Import vectors or meshes, assign operations per shape, export G-code - entirely in your browser. No installation, no accounts, no cloud processing.

**[→ Launch the application ←](https://cam.eltryus.design/easyshape5000/)**

| Documentation | |
|---|---|
| [Workflow guide](https://cam.eltryus.design/easyshape5000/doc/guide) | Import to G-code, both the 2D and 3D paths |
| [Operations](https://cam.eltryus.design/easyshape5000/doc/operations) | What each operation does and when to reach for it |
| [Parameters](https://cam.eltryus.design/easyshape5000/doc/parameters) | Every field, what it changes, and sensible values |

Part of the **[EasyCAM5000 suite](../README.md)** - the shared geometry engine, the post-processor table and licensing live there. Working on PCBs? That's **[EasyTrace5000](../easytrace5000/README.md)**.

EasyShape5000 grew out of noticing that EasyTrace was producing better toolpaths than Easel. Where EasyTrace gives each operation one implicit bucket and files go straight into it, EasyShape5000 builds a **scene graph** from your imports and assigns **explicit per-shape operation buckets** - every shape carries its own operations and parameters.

---

## How it works

**2D operations** (profile, pocket, drill, engrave, v-carve) follow the scene path: import an SVG → arrange and transform shapes in the scene graph → assign an operation bucket per shape → set parameters → *Generate* → preview → export through the Operations Manager.

**Field operations** (3D relief, rotary) attach a mesh to the operation instead of scene geometry: import an STL → set blank, resolution and tool parameters → *Generate*. The model is re-sliced on demand at every generation, so changing resolution or orientation always takes effect. Slicing and path generation run in a worker pool, with a 3D preview of stock, model and toolpaths.

## Operations

**2.5D**

* **Profile Cut** - outside, inside or on-line contours, with nesting detection and optional holding tabs.
* **Pocket Clearing** - concentric inward offsets by stepover; nested shapes become holes automatically.
* **Drilling** - automatic peck-or-mill selection for circles and obround slots, with a per-diameter tool table.
* **Engraving** - follows paths at a fixed depth, open or closed, no offset applied.

**3D**

* **V-Carve** - medial-axis engraving with per-point depth, flat-floor regions where the bit bottoms out, and multi-region worker fan-out. The axis is the Voronoi dual of a Delaunay triangulation of the sampled boundary, not a wavefront approximation.
* **3D Relief** - heightmap-driven roughing and finishing rasters from an STL, with ball, flat, bull-nose and tapered tool profiles, spiral or raster finishing, and boundary rollover control.
* **Rotary (4th axis)** - continuous cylindrical surfacing in developed coordinates, exported via A-word, inverse-time or wrapped-linear routes depending on your controller.
* **Indexed 3+1** - N flat reliefs at fixed A angles joined by pure positioning moves. The complement to continuous rotary: it reaches undercuts and flats that a wrapped path can't.

## Scene and canvas

* Hierarchical groups and shapes; group/ungroup (<kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd>); per-node lock and visibility; full undo/redo for every structural mutation.
* Per-shape transforms - translate, rotate, scale, mirror X and Y independently - correctly composed inside rotated groups.
* Click, shift-toggle, ctrl-add and marquee selection; alt-click selects leaf shapes inside groups; wheel zoom at cursor, middle/right-drag pan, two-finger pinch.
* A 3D view (icon or <kbd>F2</kbd>) for toolpaths, stock and model, sharing the same theme colours as the 2D canvas.

## File compatibility

* **SVG** - full path spec: lines, arcs, quadratic and cubic Béziers. Group hierarchies are preserved. Béziers are interpolated to line segments before offsetting.
* **STL** - binary and ASCII, for relief, rotary and indexed operations.

## Debugging

Verbose logging can also be toggled from the Visualization options panel.

Most modules carry a `debug(message, data)` method gated on the same flag, so turning debug on gives you the whole pipeline rather than one layer of it.

## Development

App-specific code lives in this directory; everything else is shared with EasyTrace5000 and sits at the repository root.

```
easyshape5000/
├── cam-easyshape5000.js         Controller - scene, history, mutations, modals, keyboard
├── ui-core-shape.js             UI orchestrator - panels, layers, transforms, selection
├── ui-nav-scene-panel.js        Scene graph tree (left sidebar)
├── ui-shape-buckets-panel.js    Operation buckets and their stage nodes
├── ui-shape-operation-panel.js  Staged parameter panel (right sidebar)
├── index.html                   App entry
└── doc/                         Documentation pages
```

Operation types, parameters and stage chains are declared in `../ui/profile-shape.json`, not in code. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full repository layout, local setup and the production build.

## License

AGPL-3.0-or-later. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
