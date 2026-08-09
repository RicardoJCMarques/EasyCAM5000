# EasyShape5000 - Browser-Based CNC Router CAM

![Status: v1.0](https://img.shields.io/badge/status-v1.0-green.svg) ![Part of: EasyCAM5000](https://img.shields.io/badge/suite-EasyCAM5000-blue.svg)

EasyShape5000 is a browser-based CAM tool for CNC routers, from flat SVG cutting to 3D surfacing. Import vectors or meshes, assign per-shape operations, and export G-code - entirely in your browser.

Part of the **[EasyCAM5000 Suite](../README.md)** - see the suite README for the shared engine, tech stack, install/serve instructions, post-processor list, and license. Working on PCBs? That's **[EasyTrace5000](../easytrace5000/README.md)**.

**[→ Launch Application ←](https://cam.eltryus.design/easyshape5000/)** ·
**[Documentation](https://cam.eltryus.design/easyshape5000/doc/)**
([Workflow](https://cam.eltryus.design/easyshape5000/doc/guide) ·
[Operations](https://cam.eltryus.design/easyshape5000/doc/operations) ·
[Parameters](https://cam.eltryus.design/easyshape5000/doc/parameters))

Unlike EasyTrace5000 (one implicit bucket per operation, files added directly), EasyShape5000 builds a **scene graph** from your imports and assigns **explicit per-shape operation buckets** - each shape carries its own operations and parameters.

## Workflow

**2D operations** (profile, pocket, drill, v-carve) follow the scene path: import SVG → arrange/transform shapes in the scene graph → assign an operation bucket per shape → set parameters → *Generate* → preview → export G-code through the Operations Manager.

**Field operations** (3D relief, rotary) attach a mesh or heightmap image to the operation instead of scene geometry: import an STL (or a grayscale image) → set blank/resolution/tool parameters → *Generate*. The model is sliced on demand at every generation, so resolution and orientation changes always take effect. Heavy slicing and path generation run in a worker pool, with a 3D preview of stock, model, and toolpaths.

## Operations

* **Profile Cut** - outside / inside / on-line contours with nesting detection and optional holding tabs.
* **Pocket Clearing** - concentric inward offsets with configurable stepover; nested shapes become holes automatically.
* **Drilling** - automatic peck-or-mill selection for circles and obround slots.
* **V-Carve** - medial-axis engraving with per-point depth, flat-floor areas, and multi-region worker fan-out.
* **3D Relief** - heightmap-driven roughing + finishing rasters from an STL or grayscale image, with ball/flat/bull/tapered tool profiles and boundary rollover control.
* **Rotary (4th axis)** - continuous cylindrical surfacing in developed coordinates, exported via A-word, inverse-time, or wrapped-linear routes depending on your controller.

## Scene & Canvas

* Hierarchical groups/shapes; group/ungroup (<kbd>Ctrl+G</kbd> / <kbd>Ctrl+Shift+G</kbd>); per-node lock and visibility; full undo/redo for structural mutations.
* Per-shape transforms: translate, rotate, scale, mirror (X/Y independent) - correctly composed inside rotated groups.
* Click/shift/ctrl/marquee selection; alt-click selects leaf shapes inside groups; wheel zoom at cursor, pan, pinch.

## File Compatibility

* **SVG** - full path spec (lines, arcs, quadratic/cubic Béziers); group hierarchies preserved. Clones and clip paths not yet supported. Béziers are interpolated to line segments before offsetting.
* **STL** - binary and ASCII, for relief and rotary operations.
* **Grayscale images** - as heightmap sources for relief (white = high). (Planned)