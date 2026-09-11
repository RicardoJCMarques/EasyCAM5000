# EasyCAM5000 — Browser-Based CAM Tools

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)
![Status: Active](https://img.shields.io/badge/status-active-success.svg)
![Tech: VanillaJS](https://img.shields.io/badge/tech-Vanilla_JS-yellow.svg)
![Tech: WebAssembly](https://img.shields.io/badge/tech-WebAssembly-blueviolet.svg)
![Accessibility: WCAG 2.1 AA Partial](https://img.shields.io/badge/accessibility-WCAG_2.1_AA_partial-yellow.svg)

A suite of CAM tools that run entirely in your browser. No installation, no
accounts, no cloud processing — your files never leave your machine.

Both apps sit on one shared engine: analytic file parsing, a Clipper2/WASM
geometry pipeline that reconstructs true G2/G3 arcs after boolean operations,
three-stage toolpath planning, and ten G-code post-processors. Each app wraps
that engine in a UI and an operation set built for one kind of work.

---

## The apps

### EasyTrace5000 — PCB fabrication

Turns Gerber, Excellon and SVG into G-code for isolation milling, or into
precision SVG/PNG for laser and vinyl work. Meant as an alternative to FlatCAM.

<div align="center">
  <img src="./images/EasyTrace5000_workspace.webp" width="830" height="467" alt="EasyTrace5000 workspace screenshot">
</div>

**[Open EasyTrace5000 →](https://cam.eltryus.design/easytrace5000/)** ·
[Documentation](https://cam.eltryus.design/easytrace5000/doc/) ·
[Repository README](./easytrace5000/README.md)

Isolation routing · copper clearing · drilling · board cutout with tabs ·
solderpaste stencils · a fiber/UV laser pipeline (beta).

### EasyShape5000 — CNC routing

General routing from vector and mesh sources, from flat SVG cutting through
3D surfacing and 4th-axis work.

<div align="center">
  <img src="./images/EasyShape5000_workspace.webp" width="830" height="467" alt="EasyShape5000 workspace screenshot">
</div>

**[Open EasyShape5000 →](https://cam.eltryus.design/easyshape5000/)** ·
[Documentation](https://cam.eltryus.design/easyshape5000/doc/) ·
[Repository README](./easyshape5000/README.md)

Profile · pocket · drilling · engraving · v-carve · 3D relief · rotary
(continuous radial and indexed 3+1), with a 3D toolpath preview.

### Which one do I want?

|  | EasyTrace5000 | EasyShape5000 |
|---|---|---|
| **Input** | Gerber, Excellon, SVG | SVG, STL |
| **Model** | one file per operation | scene graph, per-shape operation buckets |
| **Transforms** | board-level (origin, rotation, mirror) | per-shape translate/rotate/scale/mirror, nested groups |
| **Undo/redo** | no | full command history |
| **Output** | G-code, plus SVG/PNG for laser | G-code |

---

## The shared engine

* **Parsing** — Gerber (RS-274X), Excellon, SVG (full path spec including arcs and Béziers), STL (binary and ASCII).
* **Geometry** — [Clipper2](https://github.com/AngusJohnson/Clipper2) via [WebAssembly](https://github.com/ErikSom/Clipper2-WASM) for booleans, with arc reconstruction from post-boolean data so exported arcs are real G2/G3 arcs rather than polylines.
* **Toolpaths** — translate geometry to motion, optimize (staydown clustering, nearest-neighbour ordering, angle-aware simplification), then inject machine specifics: rapids, plunges, helical and ramped entries, holding tabs, rotary routes.
* **Rendering** — a custom 2D canvas renderer with batching, level-of-detail and viewport culling, plus a three.js 3D preview for toolpaths and stock.
* **Frontend** — vanilla JavaScript (ES6+), HTML5, CSS3. No framework, and no build step for development.

### File support

| Format | Extensions | Used by |
|---|---|---|
| Gerber | `.gbr` `.ger` `.gtl` `.gbl` `.gts` `.gbs` `.gko` `.gm1` | EasyTrace5000 |
| Excellon | `.drl` `.xln` `.txt` `.drill` `.exc` | EasyTrace5000 |
| SVG | `.svg` | both |
| STL | `.stl` (binary and ASCII) | EasyShape5000 |

Developed and tested against **KiCad** and **EasyEDA** output. Exporting Gerber
with Protel extensions lets drag-and-drop auto-assign files to the right
operation. Bézier curves are parsed analytically but interpolated to line
segments before offsetting — analytic Bézier offsetting is not supported yet.

### Post-processors

| Post | Tool change (T/M6) | Confidence |
|---|---|---|
| GRBL | no | verified on hardware |
| Roland RML | no | verified on hardware |
| grblHAL | yes | community-reported |
| Makera (Carvera) | yes | community-reported |
| UCCNC | yes | community-reported |
| Mach3 | yes | community-reported |
| LinuxCNC | yes | community-reported |
| Marlin | no | community-reported |
| Fanuc | yes | untested — proceed with caution |
| WinPC-NC | yes | untested — proceed with caution |

I only have GRBL and Roland machines here, so everything below the first two
rows is untested by me. **Please report what does and doesn't work** — that is
the fastest way to move a row up this table. On posts without tool change, a job
using more than one tool exports as one file per tool.

---

## Documentation

Full walkthroughs, every operation and every parameter live on the site:

* [EasyTrace5000 docs](https://cam.eltryus.design/easytrace5000/doc/) — [CNC](https://cam.eltryus.design/easytrace5000/doc/cnc) · [Laser](https://cam.eltryus.design/easytrace5000/doc/laser) · [Operations](https://cam.eltryus.design/easytrace5000/doc/operations) · [Parameters](https://cam.eltryus.design/easytrace5000/doc/parameters)
* [EasyShape5000 docs](https://cam.eltryus.design/easyshape5000/doc/) — [Workflow](https://cam.eltryus.design/easyshape5000/doc/guide) · [Operations](https://cam.eltryus.design/easyshape5000/doc/operations) · [Parameters](https://cam.eltryus.design/easyshape5000/doc/parameters)

### Accessibility

EasyTrace5000 supports keyboard-only navigation and screen readers. See the
[accessibility guide](https://cam.eltryus.design/easytrace5000/doc/accessibility)
(source: [`easytrace5000/doc/ACCESSIBILITY.md`](./easytrace5000/doc/ACCESSIBILITY.md))
for the full shortcut list and current WCAG 2.1 status.

---

## For developers

One shared engine at the repository root; each app directory adds a UI, an
operation set and a profile. Repository layout, local setup, the production
build and the debug console commands are in
**[ARCHITECTURE.md](./ARCHITECTURE.md)**.

```bash
git clone https://github.com/RicardoJCMarques/EasyCAM5000.git
cd EasyCAM5000 && npx serve      # a local server is required; file:// will not work
```

---

## Status and known limitations

**Suite version 1.6.0** — see the [changelog](./CHANGELOG.md). Versions track the
suite as a whole; entries name the app they affect.

* **Verify your G-code before you cut.** This is hobbyist software written by one
  person. Dry-run new posts and new operations above the material first.
* **Experimental posts.** Anything below GRBL and Roland in the table above is
  unverified on real hardware.
* **Laser pipeline is beta.** Check exported SVG/PNG in your laser software
  before firing.
* **Bézier offsetting.** Béziers are parsed analytically but interpolated before
  offsetting; true analytic Bézier offsetting and booleans are not supported.
* **Arc reconstruction.** Arc-to-arc joins share an endpoint that both arcs want
  to claim, and one always loses.
* **3D preview.** It cannot draw laser geometry, and it does not yet honour board
  mirror/rotation — the exported G-code is unaffected.
* **Relief mold mode.** Inversion on flat reliefs works but is not usable yet.

Anything else lives in the [issue tracker](https://github.com/RicardoJCMarques/EasyCAM5000/issues).

## Roadmap

* Multi-lingual UI — the string layer exists, only English is populated
* Tool library and theme import/export
* Toolpath playback and material simulation in the 3D preview
* Multi-sided PCB support
* Service Worker for offline use

---

## Contributing

I am not actively seeking code contributions, but **testing reports are the most
useful thing anyone can send** — especially confirmation that a post-processor
works on real hardware.

* [Report a bug or request a feature](https://github.com/RicardoJCMarques/EasyCAM5000/issues/new/choose)
* [Ask a question](https://github.com/RicardoJCMarques/EasyCAM5000/discussions) — machine settings, posts, workflow
* [CONTRIBUTING.md](./CONTRIBUTING.md) · [SUPPORT.md](./SUPPORT.md) · [SECURITY.md](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

### Sponsorship

EasyCAM5000 is free software. If this tool saves you time or patience, [Github Sponsors](https://github.com/sponsors/RicardoJCMarques) and [Ko-fi contributions](https://ko-fi.com/eltryus)
fund development time and test hardware. Manufacturers and industry partners can
get visibility on the welcome screen and in the documentation.

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

---

## License

Copyright © 2025-2026 Eltryus — Ricardo Marques

The application is licensed under the **GNU Affero General Public License v3.0
or later** ([`LICENSE`](./LICENSE)). Free to use commercially, free to modify and
redistribute — but a modified version served over a network must make its source
available to the people using it.

Third-party components keep their own licenses, listed in [`NOTICE`](./NOTICE):
Clipper2 (Boost 1.0), three.js (MIT), delaunator (ISC).

Example files carry their own terms: `examples/exampleThroughHole1` is
[CC0](./examples/exampleThroughHole1/LICENSE); `examples/exampleSMD1` and
`LineTest.svg` are [CC BY-NC](./examples/LICENSE).

**Trademarks.** "Eltryus" is a trademark. You may not use the name to endorse or
promote derived products without written permission, beyond describing the
software's origin.

## Acknowledgments

* Angus Johnson for Clipper2, and Erik Sombroek for the WASM build
* The open-source and Fab Lab / Makerspace communities
* Krisjanis and Marcela, for outstanding contributions to naming this thing
* Marcela again, for the through-hole example board
* A [standalone Clipper2-WASM test page](https://github.com/RicardoJCMarques/Clipper2-WASM-Example) built during early development, still useful as living documentation for the library's API — [live version](https://ricardojcmarques.github.io/Clipper2-WASM-Example/)
