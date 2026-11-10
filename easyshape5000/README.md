# EasyShape5000 - Browser-Based CNC Router CAM

![Status: v1.7.0](https://img.shields.io/badge/status-v1.7.0-green.svg)
![Part of: EasyCAM5000](https://img.shields.io/badge/suite-EasyCAM5000-blue.svg)
![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)

EasyShape5000 is a CAM tool for CNC routers, covering everything from flat SVG cutting to 3D surfacing and 4th-axis work. Import vectors or meshes, assign operations per shape, export G-code - entirely in your browser. No installation, no accounts, no cloud processing.

**[→ Launch the application ←](https://cam.eltryus.design/easyshape5000/)**

| Documentation | |
|---|---|
| [Workflow guide](https://cam.eltryus.design/easyshape5000/doc/guide) | Import to G-code, both the 2D and 3D paths |
| [Operations](https://cam.eltryus.design/easyshape5000/doc/operations) | What each operation does and when to reach for it |
| [Parameters](https://cam.eltryus.design/easyshape5000/doc/parameters) | Every machine setting and operation field, what it changes, and its default |
| [Accessibility](https://cam.eltryus.design/easyshape5000/doc/accessibility) | Keyboard controls, screen readers, WCAG status |

Part of the **[EasyCAM5000 suite](../README.md)** - the shared geometry engine, the post-processor table and licensing live there. Working on PCBs? That's **[EasyTrace5000](../easytrace5000/README.md)**.

EasyShape5000 grew out of noticing that EasyTrace was producing better toolpaths than Easel. Where EasyTrace gives each operation one implicit bucket and files go straight into it, EasyShape5000 builds a **scene graph** from your imports and assigns **explicit per-shape operation buckets** - every shape carries its own operations and parameters.

---

## How it works

Every operation runs through the same stages as EasyTrace5000, each with its own form and its own layer: **XY Geometry**, **Z Strategy** (depths, entries, tabs), **Feeds & Toolpaths**, then **Output**, where the Export Manager orders the operations, places tool changes and writes the G-code.

* **Shape operations** (profile, pocket, drill, engrave, v-carve) work on scene geometry: import an SVG → arrange and transform shapes in the scene graph → assign an operation bucket per shape → run its stages.
* **Field operations** (3D relief, rotary, indexed 3+1) take one mesh from the scene: import an STL → place and orient it with the same transforms → set blank, resolution and tool parameters → generate. The model is sliced again at every generation, so a change of placement or resolution always takes effect. Slicing and path generation run in a worker pool.

V-carve, relief and rotary are 3D operations: their depths belong to the geometry, so they skip the Z Strategy stage.

## Operations

**2.5D**

* **Profile Cut** - outside, inside or on-line contours, with nesting detection and optional holding tabs.
* **Pocket Clearing** - concentric inward offsets by stepover; nested shapes become holes automatically.
* **Drilling** - automatic peck-or-mill selection for circles and obround slots, with a per-diameter tool table.
* **Engraving** - follows paths at a fixed depth, open or closed, no offset applied.

**3D**

* **V-Carve** - medial-axis engraving with per-point depth, flat-floor regions where the bit bottoms out, and multi-region worker fan-out. The axis is the Voronoi dual of a Delaunay triangulation of the sampled boundary, not a wavefront approximation.
* **3D Relief** - heightmap-driven roughing and finishing rasters from an STL, with an optional cross pass, ball, flat and bull-nose tool profiles, and boundary rollover control.
* **4th axis - Rotary Relief** - continuous cylindrical surfacing in developed coordinates, written as A/B words (in degrees or arc millimetres, with inverse-time feed where the controller has it) or by axis replacement, whichever your controller accepts.
* **4th axis - Indexed 3+1** - N flat reliefs at fixed A angles joined by pure positioning moves. The complement to continuous rotary: it reaches undercuts and flats that a wrapped path can't.

## Scene and canvas

* Hierarchical groups and shapes; group/ungroup (<kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd>); per-node lock and visibility; full undo/redo for every structural mutation.
* Per-shape transforms - offset, rotate, scale, mirror X and Y independently - correctly composed inside rotated groups. A mesh adds a Z offset and X/Y rotations. Selecting a rotary operation turns the scene to the rotary axis, where the mesh keeps a placement of its own: anchored by its chuck end (the end Machine Settings > Chuck Side names) or its centre, with offsets from that anchor.
* Click, shift-toggle, ctrl-add and marquee selection; alt-click selects leaf shapes inside groups; wheel zoom at cursor, middle/right-drag pan, two-finger pinch.
* A 3D view (icon or <kbd>F2</kbd>) for toolpaths, stock and model, sharing the same theme colours as the 2D canvas. On the rotary axis it also draws the chuck, the tailstock and a ground grid at the program's Z0, each switchable in Machine Settings.

## File compatibility

* **SVG** - full path spec: lines, arcs, quadratic and cubic Béziers. Group hierarchies are preserved. Béziers are interpolated to line segments before offsetting.
* **STL** - binary and ASCII, for relief, rotary and indexed operations.

## Custom files

Drop a JSON file onto the workspace to add a theme, a language pack, a post-processor setup or a whole tool library. Each file is checked and takes effect at once; one of each kind is kept, so a new one replaces the last, and a report says what it added and where to find it. A custom post-processor setup or tool library in use can be removed from the welcome screen. How to write one: [core/CUSTOM.md](../core/CUSTOM.md).

## Debugging

<kbd>Ctrl+Alt+D</kbd>, or the Verbose Debug toggle in the Visualization panel's Log section, turns on verbose logging. Most modules carry a `debug(message, data)` method gated on the same flag, so turning it on gives you the whole pipeline rather than one layer of it. The console commands are in [ARCHITECTURE.md](../ARCHITECTURE.md#debugging).

## Development

App-specific code lives in this directory; everything else is shared with EasyTrace5000 and sits at the repository root.

```
easyshape5000/
├── cam-easyshape5000.js         Controller - scene, history, mutations, 3D model layer, keyboard
├── ui-core-shape.js             UI orchestrator - panels, layers, transforms, selection
├── ui-nav-scene-panel.js        Scene graph tree (left sidebar)
├── ui-shape-buckets-panel.js    Operation buckets and their stage nodes
├── ui-shape-operation-panel.js  Staged parameter panel (right sidebar)
├── index.html                   App entry
└── doc/                         Documentation pages + ACCESSIBILITY.md
```

Operation types, parameters and stage chains are declared in `../ui/profile-shape.json`, not in code. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the full repository layout, local setup and the production build.

## License

AGPL-3.0-or-later. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
