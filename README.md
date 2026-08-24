# EasyCAM5000 - Browser-Based CAM Tools

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg) ![Status: Active](https://img.shields.io/badge/status-active-success.svg) ![Tech: VanillaJS](https://img.shields.io/badge/tech-Vanilla_JS-yellow.svg) ![Tech: WebAssembly](https://img.shields.io/badge/tech-WebAssembly-blueviolet.svg) ![Accessibility: WCAG 2.1 AA Partial](https://img.shields.io/badge/accessibility-WCAG_2.1_AA_partial-yellow.svg)


## The EasyCAM5000 Suite

EasyCAM5000 is collection of browser-based CAM tools built on one shared, open-source engine: parsing, an almost lossless-arc geometry pipeline, toolpath planning, and multi-dialect G-code posts. All running entirely client-side, with no installation, accounts or cloud processing. Each app wraps those foundations with a dedicated UI and operations list: **EasyTrace5000** for PCB fabrication files, **EasyShape5000** for general 2.5D/3D CNC routing from vector and mesh sources. More workflows are planned on the same foundation. Follow the links bellow and try them out.


## EasyTrace5000

EasyTrace5000 is a browser-based CAM workspace that converts standard fabrication files (Gerber, Excellon, SVG) into G-code for CNC milling and precision SVG/PNG files for Laser processing. It runs entirely client-side on any browser, removing the need for software installation or cloud processing. EasyTrace5000 is meant to be an alternative to FlatCAM.

<div align="center">
  <img src="./images/EasyTrace5000_workspace.webp" width="830" height="467" alt="EasyTrace5000 Workspace screenshot">
</div>

* **[Open EasyTrace5000](https://cam.eltryus.design/easytrace5000/)** - Runs entirely in your browser. No installation, accounts or cloud dependencies.
* **[Extra Documentation](https://cam.eltryus.design/easytrace5000/doc/)** - Guides for CNC milling and accessibility features, plus a laser pipeline preview.


## EasyShape5000

EasyShape5000 is a browser-based CAM workspace for CNC router milling of SVG and STL files. It ships four 2.5D operations (Profile, Pocket, Drilling, Engraving) and three 3D ones (V-Carve, Relief and 4th-axis Rotary — both continuous radial and indexed 3+1), with a 3D toolpath preview and playback. It shares all foundations with EasyTrace5000 but with it's own UI/tweaked work-flow and operation handlers. EasyShape5000 was born after I noticed I was getting better toolpaths from EasyTrace than from Easel and it grew into an alternative, dedicated app from there.

<div align="center">
  <img src="./images/EasyShape5000_workspace.webp" width="830" height="467" alt="EasyShape5000 Workspace screenshot">
</div>

* **[Open EasyShape5000](https://cam.eltryus.design/easyshape5000/)** - Runs entirely in your browser. No installation, accounts or cloud dependencies.
* **[Extra Documentation](https://cam.eltryus.design/easyshape5000/doc/)** - Guides for the new UI and it's own operations targeting 2.5-3D CNC milling.

## Key Features

* **Multi-Operation Workflow**
   A non-destructive workflow for common PCB CAM tasks:
   * **Isolation Routing:** Multi-pass trace isolation with external offsets.
   * **Drilling:** Smart peck-or-mill strategy selection with slot support.
   * **Copper Clearing:** Internal pocketing for large copper areas.
   * **Board Cutouts:** Path generation with optional tab placement.
   * **Solderpaste Stencil (New):** Ready to laser/vinyl cut files.

* **Advanced Geometry Engine**
   The first stage converts source files into offset *geometry*.
   * **Analytic Parsing:** Reads Gerber, Excellon and full SVG paths (including arcs and Béziers) and converts to geometry objects.
   * **Board Rotation/Mirroring:** Support for project rotation and horizontal/vertical mirroring. (No per object manipulation, yet)
   * **Clipper2 Engine:** Uses the WebAssembly compilation of Clipper2 for high-performance boolean operations.
   * **Arc Reconstruction:** Reconstructs true arcs (G2/G3) from polygonized post-Clipper2 data.
   * **Unified Offset Pipeline:** A single pipeline handles both external (isolation) and internal (clearing) multi-pass offsets.
   * **Smart Drill Strategy:** Analyzes drill hole/slot size against tool diameter and generates the required operational object.

* **Optimized Toolpath Pipeline**
   The final export stage converts geometry into smooth and efficient machine motion.
   * **Geometry Translation:** Translates geometry objects and their metadata into organized toolpath plans with proper entry/exit points.
   * **Toolpath Optimization:** Optionally restructures the toolpath plan to remove unnecessary movement:
      * **Staydown Clustering:** Geometrically analyzes paths and groups nearby cuts to minimize Z-axis retractions.
      * **Path Ordering:** Applies a nearest-neighbor algorithm to sort clusters and reduce rapid travel time.
      * **Segment Simplification:** Removes collinear points with angle-aware tolerance.
   * **Machine Processing:** Injects all necessary machine-specific commands:
      * Adds rapids, plunges, and retracts to safe/travel Z-heights.
      * Detects multi-depth passes on the same path to perform quick Z-plunges without retract.
      * Manages complex hole/slot entries (helix or plunge).
      * Handles Z-lifts for board tabs during cutout operations.

* **Laser Pipeline (Beta)**
   A dedicated export pipeline tailored for UV and fiber, currently open for testing.
   * **Smart Clearances:** Automatically generates isolation halos around conductive geometry that can then be cleared with a few different strategies.
   * **Clearing Strategies:** Choose between concentric offsets, solid filled regions, or highly optimized hatch generation (with adjustable orientation and passes).
   * **Precision Export:** Exports to high-DPI raster PNGs or true vector SVGs with enforced color coded hairline strokes and layers, ready for software like LightBurn or EZCAD.
  
* **Multi-Stage Canvas Renderer**
   * **Render optimization:** Provides smooth panning and zooming with batching, level of detail and viewport culling.
   * **Multi-Stage Visualization:** Clearly and distinctly renders **Source** (Gerber/SVG), **Offset** (generated paths), and **Preview** (tool-reach simulation) layers. Plus optional Debug features.
   * **Smart Drill Rendering:** Visually distinguishes source drill holes/slots, offset-stage peck marks, and final preview simulations with color-coded warnings for tool relation (exact/undersized/oversized).

* **Tool Changes:** Automatic tool changes (T/M6) are supported on posts that declare them — grblHAL, UCCNC, Mach3, LinuxCNC, Fanuc, WinPC-NC and Makera. GRBL, Marlin and Roland RML do not, so jobs using more than one tool must be exported as one file per tool on those controllers.

# Tech Stack

* **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3
* **Geometry Engine:** [Clipper2](https://github.com/AngusJohnson/Clipper2) via [WebAssembly](https://github.com/ErikSom/Clipper2-WASM)
* **Rendering:** Custom 2D Canvas-based layer renderer with an overlay system for grids, rulers, and origin points.
* **File Parsing:** Native parsers for Gerber (RS-274X), Excellon and SVG formats.
* **Toolpath Generation:** A three-stage pipeline (Translate, Optimize, Process) to convert geometry into machine-ready plans.
* **Post-Processors:** GRBL, grblHAL, Makera, UCCNC, Mach3, LinuxCNC, Marlin (all Less Experimental), Roland RML (Experimental) and Fanuc, WinPC-NC (Radioactive)

Note: Experimental post-processors need more testing. I only have access to GRBL and Roland machines. I have to assume things are working until someone tell me otherwise so please report issues so I know and can plan accordingly.

## File Compatibility

The application has been developed and tested with files generated from **KiCAD** and **EasyEDA**.

* **Gerber:** `.gbr`, `.ger`, `.gtl`, `.gbl`, `.gts`, `.gbs`, `.gko`, `.gm1`
* **Excellon:** `.drl`, `.xln`, `.txt`, `.drill`, `.exc`
* **SVG**
* **STL:** binary and ASCII (EasyShape5000 relief / rotary sources)

Note 1: Exporting Gerber files with Protel file extensions allows drag'n'drop to automatically assign files to the expected operation.

Note 2: The parser understands all SVG data including complex Bézier curves and creates the corresponding Cubic or Quadratic primitives. Bézier primitives are then interpolated by the plotter into line segments, as the geometry engine does not support analytic Bézier offsetting, yet.

## Usage

### Quick Start
1. **Load Files:** From the Quickstart screen, Drag-and-drop over the preview canvas or use "Add Files" button for each operation type
2. **Origin & Machine Settings:** Check origin and overall machine parameters for the project
3. **Select File:** Select a source file object from the Operation Navigation tree to expose related parameters
4. **Generate Offsets:** Set X&Y axis parameters: passes, stepover and click "Generate Offsets"
5. **Preview Toolpath:** Define Z axis parameters: cut depth, multi-pass, entry-type and click "Generate Preview"
6. **Export G-code:** Open Operations Manager, arrange sequence, confirm gcode parameters, preview & export
* **Laser:** Skips the Preview stage, review generated laser geometry and open the Export Manager to download your SVG or PNG.

## The Workflow

The application guides the user through a clear, non-destructive process. Each stage builds on the last, and its visibility can be toggled in the renderer. 

### Shared Preparation
* **Stage 1: Source (Load Geometry)**
  * **Action:** Add Gerber, Excellon or SVG files to the respective operation.
  * **Result:** The original source geometry is parsed, analyzed and displayed in the renderer.
* **Stage 2: Board Placement & Machine Settings**
  * **Action:** Double-check the origin, rotation/mirroring and base machine parameters.
  * **Result:** Sets the origin, transforms geometry and all machine settings that will affect all your output files.

---

### The CNC Workflow
* **Stage 3: Offset (Generate Geometry)**
  * **Action:** Configure X/Y parameters (tool diameter, passes, stepover) and click **"Generate Offsets"**.
  * **Result:** Generates new analytic boundaries for milling, or calculates smart peck/mill strategies for drilling.
* **Stage 4: Preview (Simulate Tool Reach)**
  * **Action:** Configure Z parameters (feed rate, plunge rate, cut depth) and click **"Generate Preview"**.
  * **Result:** Creates a visual simulation stroked with the tool's diameter, showing exactly what material will be removed.
* **Stage 5: G-code Export**
  * **Action:** Open the Operations Manager, check the operation order, and click **"Calculate Toolpaths"**.
  * **Result:** Translates the geometry into optimized machine motion and exports your final G-code file.

---

### The Laser Workflow (Beta)
* **Stage 3: Laser Path Generation**
  * **Action:** Configure laser parameters (spot size, clear strategy, hatch angle, isolation width) and click **"Generate Laser Paths"**.
  * **Result:** Generates precise 2D geometry - such as concentric offsets, solid fills, or directional hatch patterns.
* **Stage 4: Image Export**
  * **Action:** Open the Export Manager, arrange the operation sequence, assign layer colors, and click **"Export"**.
  * **Result:** Fuses colinear hatch segments to optimize laser travel time and exports your paths into precision vector (`.svg`) or high-resolution raster (`.png`) files.

---

## Accessibility

EasyTrace5000 supports keyboard-only navigation and screen readers. See the [Accessibility Documentation](doc/ACCESSIBILITY.md) for complete keyboard controls and shortcuts and WCAG 2.1 compliance details.

## Project Structure

<details>
<summary><b>View Project Structure</b></summary>

```text
/
├── index.html                            # Eltryus Cam Suite entry
│
├── 404.html                              # 
│
├── config.js                             # Configuration and defaults
│
├── cam-core.js                           # Foundation logic
├── cam-controller.js                     # 
│
├── css/
│   ├── base.css                          # Foundation styles (reset, variables, etc)
│   ├── canvas.css                        # Canvas-specific rendering styles
│   ├── components.css                    # Reusable UI components (buttons, inputs, etc)
│   ├── doc.css                           # 
│   ├── layout-easyshape5000.css          # 
│   ├── layout-easytrace5000              # 
│   ├── layout-shared.css                 # Layout structure (grid, toolbar, etc)
│   ├── modals.css                        # 
│   └── theme.css                         # Theme system fallback
│
├── easytrace5000/
│   ├── doc/
│   │   ├── css/
│   │   ├── ACCESSIBILITY.md              # Accessibility repository documentation
│   │   ├── accessibility.html            # Accessibility documentation page (converted from .md)
│   │   ├── index.html                    # Documentation entry
│   │   ├── cnc.html                      # CNC pipeline documentation
│   │   ├── laser.html                    # Lase pipeline documentation
│   │   ├── operations.html               # Operation documentation
│   │   └── parameters.html               # Parameter documentation
│   ├── cam-easytrace5000.js              # 
│   ├── ui-core-trace.js                  # 
│   ├── ui-tree-scene-panel.js            # 
│   ├── ui-trace-operation-panel.js       # 
│   └── index.html                        # 
│
├── easyshape5000/
│   ├── doc/
│   │   ├── css/
│   │   ├── index.html                    # Documentation entry
│   │   ├── guide.html                    # Work-flow guide
│   │   ├── operations.html               # Operation documentation
│   │   └── parameters.html               # Parameter documentation
│   ├── cam-easyshape5000.js              # 
│   ├── ui-core-shape.js                  # 
│   ├── ui-nav-scene-panel.js             # 
│   ├── ui-shape-buckets-panel.js         # 
│   ├── ui-shape-operation-panel.js       # 
│   └── index.html                        # Main EasyShape5000 entry
│
├── themes/
│   ├── theme-loader.js                   # Theme loading and switching utility
│   ├── light.json                        # Light Theme
│   └── dark.json                         # Dark Theme
│
├── utils/
│   ├── canvas-exporter.js                # SVG export of canvas contents
│   ├── coordinate-system.js              # 
│   └── transform-math.js                 # 
│
├── input/
│   ├── canvas-readout.js                 # 
│   ├── command-manager.js                # 
│   ├── input-manager.js                  # 
│   ├── keyboard-manager.js               # 
│   ├── tool-controller.js                # 
│   ├── tools-common.js                   # 
│   └── tools-interactive.js              # 
│
├── ui/
│   ├── ui-base-app.js                    # 
│   ├── ui-base-operation-panel.js        # 
│   ├── ui-parameter-manager.js           # Parameter validation
│   ├── ui-machine-settings.js            # 
│   ├── ui-controls.js                    # User interaction handlers
│   ├── ui-status-manager.js              # Status bar and log history manager
│   ├── ui-tooltip.js                     # Tooltip system
│   ├── ui-modal-manager.js               # Modal boxes
│   └── tool-library.js                   # Tool definitions
│
├── operations/
│   ├── base-operation-handler.js         # Base class for operation handlers
│   ├── drill-operation-handler.js        # Peck/mill drill handler
│   ├── offset-operation-handler.js       # Core offset generation logic
│   ├── shape-drill-handler.js            # 
│   ├── shape-engrave-handler.js          # 
│   ├── shape-pattern-handler.js          # 
│   ├── shape-pocket-handler.js           # 
│   ├── shape-profile-handler.js          # 
│   ├── shape-relief-handler.js           # 
│   ├── shape-vcarve-handler.js           # 
│   ├── trace-clearing-handler.js         # Copper clearing handler
│   ├── trace-cutout-handler.js           # Board cutout handler
│   ├── trace-isolation-handler.js        # Isolation routing handler
│   └── trace-stencil-handler.js          # Solderpaste stencil handler
│
├── geometry/
│   ├── clipper2z.js                      # Clipper2 WASM factory
│   ├── clipper2z.wasm                    # Clipper2 WASM binary
│   ├── geometry-clipper-wrapper.js       # Clipper2 interface
│   ├── geometry-arc-reconstructor.js     # Post Clipper2 arc recovery
│   ├── geometry-curve-registry.js        # Curve metadata tracking
│   ├── geometry-offsetter.js             # Path offsetting
│   ├── geometry-offsetter-analytic.js    # Analytic path offsetting (under developemnt)
│   ├── geometry-processor.js             # Boolean operations
│   ├── geometry-utils.js                 # Geometry accessory functions
│   ├── geometry-utils-hatching.js        # Laser Pipeline hatch pattern utils
│   ├── geometry-utils-heightmap.js       # 
│   ├── geometry-utils-math.js            # Analytic path offsetting math utils (under developemnt)
│   ├── geometry-utils-relief.js          # 
│   └── geometry-utils-vcarve.js          # 
│
├── parsers/
│   ├── parser-core.js                    # Base parser orchestration
│   ├── parser-gerber.js                  # Gerber RS-274X parser
│   ├── parser-excellon.js                # Excellon drill parser
│   ├── parser-svg.js                     # SVG parser
│   ├── parser-stl.js                     # STL parser
│   ├── parser-plotter.js                 # Geometry converter
│   └── primitives.js                     # Geometric data-structures
│
├── renderer/
│   ├── renderer-core.js                  # 2D Canvas renderer
│   ├── renderer-layer.js                 # Layer management
│   ├── renderer-overlay.js               # Grid/rulers/origin
│   └── renderer-primitives.js            # Geometry rendering
│
├── toolpath/
│   ├── toolpath-primitives.js            # Toolpath data structures
│   ├── toolpath-geometry-translator.js   # Offset to cutting paths
│   ├── toolpath-machine-processor.js     # Machine motion injection
│   ├── toolpath-optimizer.js             # Optimization algorithms
│   └── toolpath-tab-planner.js           # Cutout tab placement
│
├── export/
│   ├── graphics-exporter.js              # Image generation
│   ├── gcode-generator.js                # G-code generation
│   └── processors/                       # Post-processor modules
│       ├── base-processor.js
│       ├── grbl-processor.js
│       ├── makera-processor.js
│       ├── grblHAL-processor.js
│       ├── linuxcnc-processor.js
│       ├── UCCNC-processor.js
│       ├── mach3-processor.js
│       ├── marlin-processor.js
│       ├── uccnc-processor.js
│       └── roland-processor.js           # Independent RML module
│
├── language/
│   ├── language-manager.js               # Rudimentary multi-language system
│   └── en.json                           # English text strings
│
├── examples/
│   ├── mesa/                             # Placeholder example for EasyShape5000
│   ├── exampleSMD1/                      # Sample SMD board files
│   ├── exampleThroughHole1/              # Sample Through-hole board files
│   ├── LineTest.svg                      # Precision test pattern
│   └── 100mmSquare.svg                   # 100*100mm square to check steps/mm
│
└── images/                               # Thumbnails and icons and sharing stuff
```
</details>

## Running Locally

> **Note:** Because the application dynamically fetches internal modules and JSON files, **modern browsers will block these requests if you try to open `index.html` directly from your file system** due to CORS security policies. You *must* run a local web server. Production deployment uses `.github/scripts/build.js` to bundle assets, but this is handled automatically by CI and doesn't affect local usage/development.

1. Clone the repository:
```bash
   git clone https://github.com/RicardoJCMarques/Eltryus_CAM.git
```

2. Serve locally (required for WASM loading):
   - **VS Code:** Use [Five Server](https://github.com/yandeu/five-server-vscode) extension (A [fiveserver.config.js](fiveserver.config.js) file is included)
   - **Python:** `python -m http.server 8000`
   - **Node:** `npx serve`

3. Open `http://127.0.0.1:5500/` (The included fiveserver.config.js opens :5500 but use the one you set)

### Testing the Production Build (Optional)
```bash
node .github/scripts/build.js --src . --dist ./dist
```
Output in `./dist/` mirrors the deployed site (inlined CSS, embedded default JSONs and bundled JS).

### Debugging Notes
- **Local development:** Use source files directly (easier debugging, regular refresh/reloading works)
- **Production issues:** Test within `./dist/` output to reproduce online, post-build.js compacted behavior

## Testing & Debugging

```javascript
// Browser console commands
window.enablePCBDebug()                 // Enable verbose logging - Toggle in Visualization options too
window.pcbcam.getStats()                // Display pipeline statistics
```

## Known Issues & Limitations

**Current Limitations:**
* **Post-Processors:** Consider all non-grbl post-processors as experimental and to be used with caution until further notice.
* **Laser Pipeline (Beta):** The laser toolpath generation and export features are in active testing. Please verify all exported SVG/PNG files in your laser control software before firing.
* **Hybrid Pipeline Locked:** The ability to automatically mix CNC operations (like drilling) and Laser operations in a single workspace is currently locked while standalone laser operations are tested.
* **Bézier Offsetting:** While Bézier curves from SVGs are parsed analytically, they are interpolated (converted to line segments) by the plotter. True analytic offsetting and booleans of Béziers is not yet supported.

**Known Bugs:**
* **Arc-Reconstruction:** Arc-Arc interactions have overlapping edge points fighting to be attached to arcs and 1 always loses.
* **And the ones active in the Issue Tracker**

## Roadmap

- Tool library import/export
- Theme import/export
- Multi-lingual UI
- 3D G-code preview/simulation
- Multi-sided PCB support
- Service Worker for offline caching/work

## Development Tools

### Clipper2 Integration Test Suite
A standalone test page was created and used during initial development to test syntax of the WASM compilation factory wrapper. [It's living documentation on how to interact with the Clipper2 WASM library](https://github.com/RicardoJCMarques/Clipper2-WASM-Example).

* **Live website:** [ricardojcmarques.github.io/Clipper2-WASM-Example](https://ricardojcmarques.github.io/Clipper2-WASM-Example/)

## Support & Sponsorship

EasyTrace5000 is free, open-source software.

### Individual Support
If this tool saves you time or patience, contributions via Ko-fi help fund development time and hardware for testing.

[**>> Support Development on Ko-fi <<**](https://ko-fi.com/eltryus)

### Become a Sponsor
EasyTrace5000 offers visibility for manufacturers and industry partners on the application welcome screen and documentation. 

<table width="830px">
  <tr>
    <td align="center" width="33%">
      <a href="https://cam.eltryus.design/#support">
        <img src="https://placehold.co/250x125/f8f9fa/666666?text=Your+Logo&font=roboto" alt="Your Logo" />
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://cam.eltryus.design/#support">
        <img src="https://placehold.co/250x125/f8f9fa/666666?text=Your+Logo&font=roboto" alt="Your Logo" />
      </a>
    </td>
    <td align="center" width="33%">
      <a href="https://cam.eltryus.design/#support">
        <img src="https://placehold.co/250x125/f8f9fa/666666?text=Your+Logo&font=roboto" alt="Your Logo" />
      </a>
    </td>
  </tr>
</table>

[**Contact us regarding sponsorship →**](https://cam.eltryus.design/#support)

## License

Copyright (C) 2025-2026 Eltryus - Ricardo Marques

**This project uses multiple licenses.**

* **Software Source Code (The App):**
    The core application logic, UI, and algorithms are licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.
    See [`LICENSE`](./LICENSE) in the root directory.

* **Third-Party Libraries:**
    The `geometry/clipper2z` library (Clipper2 WASM) is subject to its own license terms.
    See the [license file](./geometry/LICENSE) located in the `geometry/` directory.

* **Example Files (Assets):**
    * `examples/exampleThroughHole1`: Released into the **[Public Domain (CC0)](./examples/exampleThroughHole1/LICENSE)**.
    * `examples/exampleSMD1` and `LineTest.svg`: Licensed under **[CC BY-NC (Attribution-NonCommercial)](./examples/LICENSE)**.
    * Other files: Check for specific license text within their respective directories.

**Trademarks**
The name "Eltryus" is a trademark. You may not use this name to endorse or promote products derived from this software without specific prior written permission, except as required to describe the origin of the software.

**Permissions & Obligations (AGPL)**
This means the software is free to use, modify, and distribute. However, if you run a modified version on a network server and allow users to interact with it, you must also make the modified source code openly available to all users interacting with it remotely.

**Key points:**
- ✅ Free to use, including commercial applications
- ✅ Modify and distribute as needed
- ✅ Must keep source open (AGPL v3)
- ❌ Cannot create closed-source derivatives

## Acknowledgments

- Angus Johnson for Clipper2 and Erik Sombroek for the WASM compilation 
- Open-source and Fab Lab / Makerspace community
- Krisjanis and Marcela for outstanding contributions to naming this thing
- Bonus points for Marcela for providing the through-hole example board

## Community & Contributing

While I'm not actively seeking major code contributions, please help me test it and let me know what is or isn't working so I can focus accordingly.

* **Contributing:** Please read our [Contribution Guidelines](.github/CONTRIBUTING.md) before submitting a Pull Request.
* **Code of Conduct:** This project adheres to a [Code of Conduct](.github/CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.
* **Changelog:** See [CHANGELOG.md](./CHANGELOG.md) for a history of changes and updates.

---

**Status**: Active Development | **Version**: 1.5.0 | **Platform**: Client-side Web