# EasyTrace5000 — Browser-Based PCB CAM

![Status: v1.6.0](https://img.shields.io/badge/status-v1.6.0-green.svg)
![Part of: EasyCAM5000](https://img.shields.io/badge/suite-EasyCAM5000-blue.svg)
![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)

EasyTrace5000 converts PCB fabrication files (Gerber, Excellon, SVG) into G-code
for CNC milling, and into precision SVG/PNG for laser and vinyl work. It runs
entirely in your browser — no installation, no accounts, no cloud processing.
Your files never leave your machine.

**[→ Open the workspace ←](https://cam.eltryus.design/easytrace5000/)**

| Documentation | |
|---|---|
| [CNC guide](https://cam.eltryus.design/easytrace5000/doc/cnc) | Full milling walkthrough, start to G-code |
| [Laser guide](https://cam.eltryus.design/easytrace5000/doc/laser) | The fiber/UV pipeline, clearing strategies, export |
| [Operations](https://cam.eltryus.design/easytrace5000/doc/operations) | What each operation does and when to reach for it |
| [Parameters](https://cam.eltryus.design/easytrace5000/doc/parameters) | Every field, what it changes, and sensible values |
| [Accessibility](https://cam.eltryus.design/easytrace5000/doc/accessibility) | Keyboard controls, screen readers, WCAG status |

Part of the **[EasyCAM5000 suite](../README.md)** — the shared geometry engine,
the post-processor table and licensing live there. Doing general CNC routing
from SVG or STL rather than PCB work? That's
**[EasyShape5000](../easyshape5000/README.md)**.

---

## How it works

A non-destructive, stage-based process. Each stage's output is its own renderer
layer that you can toggle independently, and re-running a stage never destroys
the one before it.

1. **Source** — add Gerber, Excellon or SVG files to their operation.
2. **Board placement & machine settings** — origin, rotation, mirroring, and the machine parameters that affect every output file.
3. **Offset (geometry)** — tool, passes, stepover → *Generate Offsets*.
4. **Preview (strategy)** — depths, feeds → *Generate Preview*, a tool-reach simulation stroked at the real tool diameter. *The laser pipeline skips this stage.*
5. **Export** — order operations in the Operations Manager → *Calculate Toolpaths* → export G-code, or SVG/PNG for laser.

Full walkthroughs are in the [CNC](https://cam.eltryus.design/easytrace5000/doc/cnc)
and [Laser](https://cam.eltryus.design/easytrace5000/doc/laser) guides.

## Operations

* **Isolation Routing** — multi-pass trace isolation with external offsets and cut-in resolution.
* **Copper Clearing** — internal pocketing for large copper areas.
* **Drilling** — automatic peck-or-mill strategy selection per hole size, with slot support and a per-diameter tool table.
* **Board Cutout** — cut-side control, optional holding tabs, and a closure prompt for outlines that don't quite close.
* **Solderpaste Stencil** — apertures ready to laser or drag-knife cut, with drill-pad exclusion, registration holes and an optional corner radius for vinyl cutters.

Every operation runs on the suite's lossless-arc geometry engine: analytic
parsing, Clipper2 (WebAssembly) booleans, and G2/G3 arc reconstruction from
post-boolean data — so exported arcs are real arcs, not polylines pretending.

### Output targets

| Operation | CNC router | Laser | Drag knife |
|---|---|---|---|
| Isolation | ✓ | ✓ | |
| Copper clearing | ✓ | ✓ | |
| Cutout | ✓ | ✓ | |
| Drilling | ✓ | ✓ | |
| Stencil | ✓ | | ✓ |

Machine class is set per operation, not per session — a job can mill its drills
and cutout while lasering its isolation.

## The laser pipeline (beta)

Generates isolation halos around copper, then clears them with concentric
offsets, solid fills, or directional hatch at an angle and pass count you
choose. Exports high-DPI PNG or hairline-stroke SVG with colour-coded layers,
ready for LightBurn or EZCAD, and fuses colinear hatch segments to cut travel
time.

Still in testing — check exported files in your laser software before firing.

## File compatibility

Developed and tested against **KiCad** and **EasyEDA** output.

* **Gerber** — `.gbr` `.ger` `.gtl` `.gbl` `.gts` `.gbs` `.gko` `.gm1`
* **Excellon** — `.drl` `.xln` `.txt` `.drill` `.exc`
* **SVG** — full path spec; Béziers are parsed analytically but interpolated to line segments before offsetting.

> Exporting Gerber with Protel file extensions lets drag-and-drop auto-assign
> each file to the operation that expects it.

## Accessibility

Full keyboard operability using a focus-zone strategy (`F6` cycles toolbar →
tree → canvas → properties), a roving-tabindex operations tree, focus-trapped
modals with keyboard-reorderable export lists, and `aria-live` status
announcements. Targeting WCAG 2.1 Level AA; see the
[accessibility guide](https://cam.eltryus.design/easytrace5000/doc/accessibility)
for the complete shortcut list and current per-guideline status.

## Not yet

* **Multi-sided PCB support** — one side per project today.
* **Analytic Bézier offsetting** — Béziers are interpolated before offsetting and booleans.
* **Arc-to-arc reconstruction edge case** — where two arcs meet, both want the shared endpoint and one loses it.
* **3D preview of laser geometry** — the 3D view doesn't draw it yet, and doesn't honour board mirror/rotation. Exported files are unaffected.

## Debugging

Verbose logging can also be toggled from the Visualization options panel.

Most modules carry a `debug(message, data)` method gated on the same flag, so
turning debug on gives you the whole pipeline rather than one layer of it.

## Development

App-specific code lives in this directory; everything else is shared with
EasyShape5000 and sits at the repository root.

```
easytrace5000/
├── cam-easytrace5000.js       Controller - file handling, export, orchestration
├── ui-core-trace.js           UI orchestrator - panels, fusion, board transforms, layers
├── ui-nav-tree-panel.js       Operations tree (left sidebar)
├── ui-trace-operation-panel.js  Parameter panel (right sidebar)
├── index.html                 App entry
└── doc/                       Documentation pages + ACCESSIBILITY.md
```

Operation types, parameters and stage chains are declared in
`../ui/profile-trace.json`, not in code. See
[ARCHITECTURE.md](../ARCHITECTURE.md) for the full repository layout, local
setup and the production build.

## License

AGPL-3.0-or-later. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
