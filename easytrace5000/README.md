# EasyTrace5000 - Browser-Based PCB CAM

![Status: v1.4](https://img.shields.io/badge/status-v1.4-green.svg) ![Part of: EasyCAM5000](https://img.shields.io/badge/suite-EasyCAM5000-blue.svg)

EasyTrace5000 converts PCB fabrication files (Gerber, Excellon, SVG) into G-code for CNC milling and precision SVG/PNG for laser processing. It runs entirely in your browser - no installation, accounts, or cloud processing.

Part of the **[EasyCAM5000 Suite](../README.md)** - see the suite README for the shared engine, tech stack, install/serve instructions, post-processor list, and license. Looking for general CNC routing from SVG/STL instead of PCB work? That's **[EasyShape5000](../easyshape5000/README.md)**.

**[→ Open Workspace ←](https://cam.eltryus.design/easytrace5000/)** ·
**[Documentation](https://cam.eltryus.design/easytrace5000/doc/)**
([CNC](https://cam.eltryus.design/easytrace5000/doc/cnc) ·
[Laser](https://cam.eltryus.design/easytrace5000/doc/laser) ·
[Operations](https://cam.eltryus.design/easytrace5000/doc/operations) ·
[Parameters](https://cam.eltryus.design/easytrace5000/doc/parameters))

## Workflow

A non-destructive, stage-based process; each stage's output has its own
renderer layer you can toggle.

1. **Source** - add Gerber/Excellon/SVG files to their operation.
2. **Board placement & machine settings** - origin, rotation/mirroring, machine parameters (these affect all output).
3. **Offset (geometry)** - tool, passes, stepover → *Generate Offsets*.
4. **Preview (strategy)** - depths, feeds → *Generate Preview* (tool-reach simulation). *The laser pipeline skips this stage.*
5. **Export** - order operations in the Operations Manager → *Calculate Toolpaths* → export G-code (or SVG/PNG for laser).

Full walkthroughs live in the **[CNC](https://cam.eltryus.design/easytrace5000/doc/cnc)** and **[Laser](https://cam.eltryus.design/easytrace5000/doc/laser)** guides.

## Operations

* **Isolation Routing** - multi-pass trace isolation with external offsets.
* **Copper Clearing** - internal pocketing for large copper areas.
* **Drilling** - smart peck-or-mill strategy selection with slot support.
* **Board Cutout** - path generation with optional holding tabs and a closure prompt for unclosed outlines.
* **Solderpaste Stencil** - aperture files ready to laser/vinyl cut, with drill-pad exclusion and registration holes.

Under the hood, all operations share the suite's lossless-arc geometry engine: analytic parsing, Clipper2 (WebAssembly) booleans, and G2/G3 arc reconstruction from post-boolean data - so exported arcs are real arcs.

## The Laser Pipeline (Beta)

Isolation halos around copper cleared via concentric offsets, solid fills, or directional hatch; exports high-DPI PNG or hairline-stroke SVG for LightBurn / EZCAD.

## File Compatibility

Developed and tested against files from **KiCad** and **EasyEDA**.

* **Gerber:** `.gbr`, `.ger`, `.gtl`, `.gbl`, `.gts`, `.gbs`, `.gko`, `.gm1`
* **Excellon:** `.drl`, `.xln`, `.txt`, `.drill`, `.exc`
* **SVG** - full path spec; Béziers are parsed analytically but interpolated to line segments before offsetting.

> Exporting Gerber with Protel file extensions lets drag-and-drop auto-assign files to the expected operation.