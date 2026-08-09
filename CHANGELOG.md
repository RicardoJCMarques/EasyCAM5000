# Changelog

All notable changes to the **EasyTrace5000** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.9] - 2026-08-09

### Added
- **3D Operations:** V-Carving and 3D Relief Maps (Flat and Cylindrical) have been added to EasyShape5000. Proceed with some caution.
- **3D Rendering:** 3D Frustrum to preview 3D geometry in all it's splendor. The UI and keyboard shortcuts will be tweaked in the future.
- **Engraving:** Just a simple, lossless, operation to turn svg geometry into toolpaths with EasyShape5000 (no fill option, yet but easy to add if requested as hatching patterns already exist for the laser pipeline).
- **Fanuc Post:** A VERY experimental post-processor draft for Fanuc variants controllers has been added. Proceed with extreme caution.

### Changed
- **EasyCAM5000:** Renaming the main repository as EasyCAM5000, it holds the original [EasyTrace5000](https://cam.eltryus.design/easytrace5000/) and now [EasyShape5000](https://cam.eltryus.design/easyshape5000/). With more to come.
- **3D Previews:** Toolpaths are now getting triggered before the old Calculate Toolpaths button in the export modal. But the new system needs fine tunning and tweaks to the workflow. (4th axis toolpaths are wack.)
- **State Manager:** The Status Log Manager got upgraded to also handle overlay spinner heartbeat messages.
- **Tool Library:** Upgraded with more options for new operations. Initial plumbing to allow custom tool files.

### Fixed
- **Excellon Parsing:** Small tweak for explicit format notation syntax. 
- **Tab Cut Direction:** Fixed tab passes being exported with the opposite cut direction/winding of other passes.
- **Gerber Arcs:** Some implicit arc syntax wasn't getting properly processed. [#24](https://github.com/RicardoJCMarques/EasyCAM5000/issues/24)

### Planned
- **3D Optimizations:** EVERYTHING needs optimization, especially Relief toolpaths. Warning that V-Carve geometry generation is quite slow.
- **Documentation:** Is a bit outdated now and needs a refresh. Especially EasyShape5000 and 3D operations.
- **Invert SVG:** Some fabrication files have the actual traces set as holes. A new flip toggle can be implemented.
- **Non-Conductive Copper:** Extend either isolation or clearing ops to allow for the efficient removal of non conductive copper up the cutout edge.

### Known Problems
- **Circle Stay-down:** Stay-down optimizations for full circles seems to be broken. May be related to rotate optimizations.
- **Mold Mode:** The inversion on 3D flat reliefs is sort of working but not in a usable way yet.
- **Themes & Colors:** Most transparency was removed from all rendering layers which caused colors to shift. Some things may look a bit off in the near future. Some changes have already been implemented to fix consistency between EasyTrace5000 and EasyShape5000.


## [1.4.2] - 2026-07-01

### Fixed
- **Tabs Are Back:** Tab toolpaths are correctly lifted/plunged again. Distribution still not great.
- **Tabs Width:** Tab physical length parameter is extended by tool diameter.
- **Absolute Z0:** EasyShape5000's toggle for Z0 on top or bottom of stock sets 0 corectly.
- **Doc CSS & SVG Sprite:** Deployment had a few quirks that have been taken care of.
- **ARIA Tags:** Attempt to fix some misplaced/wrong tags.

### Changed
- **Empty Buckets:** After offset and preview objects are deleted from a bucket, the bucket is also deleted automatically.
- **More EasyShape5000:** Propagated more references, started updating README for EasyCAM5000 renaming.

### Known Problems
- **Themes & Colors:** Most transparency was removed from all rendering layers which caused colors to shift. Some things may look a bit off in the near future.


## [1.4.1] - 2026-06-28

### Added
- **EasyShape5000 Example:** Included a temporary flat-pack coffee table example file.
- **404 page:** Because why not.

### Fixed
- **Toolpath Planning:** Complete rework of the optimization layer - EasyShape5000 highlighted too many problems in the old optimizations.
- **Symmetric Arc Beziers:** All translated symmetric arc Bezier curves now have proper center and edge points, everything lines up correctly.
- **SVG Parser:** Won't spitout svg's without size/unit attributes anymore, they'll fall through to defaults.

### Changed
- **SEO Stuff:** Trying to put the Optimization in SEO.
- **Propagate EasyShape5000:** Readying a transition to EasyCAM5000.

### Known Problems
- **Tabs Don't work:** Something is causing tabs to not be generated. Possibly just a wiring issue, TBD.
- **Themes & Colors:** Most transparency was removed from all rendering layers which caused colors to shift. Some things may look a bit off in the near future.


## [1.4.0] - 2026-06-22

### Added
- **EasyShape5000 Launch:** [Initial TEST release of EasyTrace5000's 2.5-3D CNC Routing sister app.](https://cam.eltryus.design/easyshape5000/) Same foundational systems but with it's own dedicated UI and operations.
- **Generation Feedback:** The spinner overlay now gives feedback on pass number so ongoing operations are more clearly either doing work or have indeed crashed.
- **Helper Button:** New explicit button next to the theme button that opens the F1 Helper Modal.

### Fixed
- **Improved Bezier Plotting:** Some CAD programs lazily export regular arcs and linear segments as beziers; sometimes these can be infered back instead of getting automatically tessellated (better quality offsets).
- **Add OP Files:** The + buttons to manually add files, through the file explorer, to individual operation are working again. [#19](https://github.com/RicardoJCMarques/EasyCAM5000/issues/19)
- **Laser Drilling:** Geometry is now correctly offset instead of generating a laser dot sized circle. [#20](https://github.com/RicardoJCMarques/EasyCAM5000/issues/20)

### Changed
- **Huge Backend Refactor:** With EasyShape5000 sharing most foundational sub-systems, it was necessary to split unique code blocks from all the shared ones. There shouldn't be any major changes to UI flow in EasyTrace5000. Included some explicit UI warnings.
 **Coordinate Rework:** Coordinates and transforms are now stored in matrices and there's a new scene manager (mostly because of EasyShape5000).
 **Transform Inputs:** Rotation and Scale (EasyShape5000) are now absolute and will always and explicitly show the value from default instead of being relative and reset to 0 on Apply.
 - **SVG Icons:** All icons have been extracted and now live as individual .svg files that are bundled into a sprite with the [build-sprite.js](https://github.com/RicardoJCMarques/EasyCAM5000/blob/main/.github/scripts/build-sprite.js) script.
- **Clipper2 WASM Test Page:** Spun off the test page developed during initial testing of the WASM version of Clipper2. It's now a split repo at [Clipper2-WASM-Example](https://github.com/RicardoJCMarques/Clipper2-WASM-Example).

### Known Problems
- **No Examples in EasyShape5000:** I can't include the examples I've been using because of licensing stuff I don't feel like dealing with right now lol. I'll add something later.
- **"Toolpath Optimizations":** Some optimizations that made sense in EasyTrace5000 are quite awful in EasyShape5000. To be reviewed ASAP.
- **Themes & Colors:** Most transparency was removed from all rendering layers which caused colors to shift. Some things may look a bit off in the near future.
- **Symmetric Arc Beziers:** Some centers seem to be snapping to a grid with less precision than they need (possibly not enough decimal points) which can distort small arcs in EasyTrace5000 (previously these arcs were just tessellated).


## [1.3.3] - 2026-05-15

### Fixed
- **Overwriting Geometry:** If Offset/Preview geometry objects exist, they are now replaced when new objects are created with different parameters. [#17](https://github.com/RicardoJCMarques/EasyCAM5000/issues/17)
- **Operation Warnings:** Some warnings wouldn't reset and could stack on themselves inside the parameter panel.

### Added
- **Op Keyboard Shortcuts:** Pressing 1-5 will select/cycle through existing geometry objects in each Operation. 1 for Isolation, etc.
- **Copy To Clipboard:** New button to copy the g-code inside the preview text-box to make copy-pasting easier.

### Changed
- **Operation Orchestration:** Some logic that was inside Controller and UI modules was transfered into the Core and Operation Handlers.
- **Export And Preview:** G-code/graphics export logic and preview generation was also moved from UI modules into the Core.
- **Small Cleanup:** Removed some old dead code and tweaked some inefficiencies.


## [1.3.2] - 2026-05-01

### Fixed
- **Geometry Transforms:** Rotation and mirroring won't break arc winding any more. [#15](https://github.com/RicardoJCMarques/EasyCAM5000/issues/15)
- **Drill Macros:** Hole and slot macros for drill operations are now mirroring agnostic and are hardcoded climb milling.
- **Tab Generation:** Was reinforced to handle mirroring without breaking arc winding for toolpaths at tab depth.
- **Visualization State:** Layer visibility is more persistant and won't reset/desync when geometry changes happen. [#14](https://github.com/RicardoJCMarques/EasyCAM5000/issues/14)
- **File Parsing:** Leading and Trailing zeros are recognized and handled correctly now. Arcs that share a center, winding and touch will be merged too.
- **Gerber Parsing:** Oval/Obround and other complex flashed pad macro shapes are properly processed. [#16](https://github.com/RicardoJCMarques/EasyCAM5000/issues/16)
- **Excellon Parsing:** More encoding formats are now supported.
- **Arc Rendering:** Small improvements during debug states.

### Added
- **Temp Offset Polygons:** A dedicated toggle was added to the advanced debug viz tools to see intermediary offset path polygons

### Known Bugs
- **Arc-Reconstruction:** Arc-Arc interactions, especially tangencial connections have 2-3x points fighting to keep z-height metadata in overlapping collisions. A small linear segment covers the gap that belongs to one of the arcs. When losing point remapping works, tangential circle joint should be removed.


## [1.3.1] - 2026-04-22

### Fixed
- **Arc Offsetting:** Source geometry that includes paths with arcs is now run through the main offset path instead of the minimalist analytic algorithm meant for straight segment paths only.
- **Unit Parsing:** New single-source of truth for project unit management and metric conversions.
- **SVG Arc Parsing:** SVG arc-winding direction setting during parsing.
- **SVG Nested Parsing:** SVG hole and complex nested path parsing.
- **Source Oversimplification:** Lowered source pre-processing Douglas-Peucker aggressiveness in some edge cases.
- **Overlapped Arc Points:** Arc-reconstruction can now recover arc start/end-points that lack metadata because they are shared with other geometry.
- **Clearing Operations:** Now work with more complex geometry with arcs. Needs more testing.

### Added
- **Skipped Warnings:** If all geometry is skipped in an operation (like through-hole stencils) a notice will inform that the operation ran as expected but created no geometry.
- **More Pre-processed Debug Viz:** Extended temporary offset polygons to also show up during Pre-Processed geometry viewing. May warrant it's own toggle in the future.


## [1.3.0] - 2026-04-12

### Changed
- **Operation Orchestration:** Large refactor of the core and controller files, split operation handlers allow easier additions and maintenance in the future.
- **NavTree Operations:** They are no longer collapsible. Instead, clicking on them triggers the file explorer to allow adding source geometry faster.

### Fixed
- **Default Dwell:** Base processor was scaling x1000 miliseconds values that were meant to be seconds. Now post-processors that need miliseconds do the overwritting.
- **Typos in Config.js:** Small typos causing big problems.


## [1.2.1] - 2026-04-06

### Fixed
- **Laser SVG Ordering:** Laser will move away from all source geometry to protect it from heat build-up.
- **Arc-Reconstruction:** Removed a silent error, fixed the underlying problem.
- **Gerber Comments:** Will now be ignored, as they should've been.


## [1.2.0] - 2026-04-05

### Added
- **Laser Control Profiles:** Since controller programs can be very picky with how the geometry is interpreted the new system can help diferentiate which parameters apply to what files.

### Fixed
- **Laser SVG Export:** Previous attempts at managing heat build-up broke most functionality unrelated to concentric offset strategy.
- **Reworked Config.js:** Preset values are now split into constants that are frozen and defaults that the tool can overwrite.
- **Canned Drill Cycles:** Updated UI and internal logic, needs further testing but G-codes are now exported "correctly".

### Changed
- **Tool Library:** Now the module only looks for tools.json, both externally during development and internally after building.


## [1.1.3] - 2026-03-30

### Added
- **SVG Drill Operation Logic:** Hole and slot shaped geometries can now be used to trigger Drill op macros. Round and obround shapes can be converted, others are ignored with a warning.
- **Multiple Individual Boards:** Cutout operations can now handle files with more than 1 polygon, including nested hole/islands (even from flat gerbers).
- **Open Cutout Polygon:** If a cutout path isn't closed and can't be closed just by the main stitching algorithm, a new screen let's the user try to close it with higher tolerances.
- **Warning Modal:** Can query the user about geometry choices (currently) that need to be made instead of automatically assuming anything.
- **Source Geometry Stats:** Can help understand changes requested by automatic checks in certain operations (like converting circles and obrounds in svg's).

### Fixed
- **Rotation + Viewport Culling:** Geometry will stop disappearing near the edges of the canvas viewport when rotation is applied. It was only taking mirroring into account.
- **ZoomToFit Improvements:** Now also accounts for rotation and also ignores the rulers dimensions when placing the board.
- **Webkit Export Safeguard:** Added a time delay between files to try and avoid triggering what should be "download spam" protections in Safari when exporting multiple files in very close succession.
- **Promote All Full Circles To Primitives:** An edge case could cause some reconstructed full arcs to be assumed as paths instead of circles. (Needs a thorough review.)

### Changed
- **Operation Export Order:** Reordered operations in the internal export logic. UI flow can also lock reordering when it's irrelevant, like for Laser pipeline.
- **Post-Processor Extensions:** The file name text-box in the Export Modal will show the correct file type connected to the selected post-processor.


## [1.1.2] - 2026-03-20

### Fixed
- **Offset Laser SVG Reordering:** The old "optimized" grouping was causing localized heat build-up and scorching. Each pass should finish before the next and starting from the smallest geometry.
- **Allow Drill Milling Of Undersized Tool With Plunge Entry:** The hole diameter minus tool size vs tolerance logic was only meant for helixes to avoid too deep and tight awkward helix commands.
- **Single File Export Toggle:** Implementation wasn't consistent with other modal toggles and could cause detection problems in stricter browsers.
- **Operational Parameter Checkbox Tooltips:** They weren't getting properly attached and the are now.

### Added
- **Soldermask Stencil Operation:** New operation that can read regular gerbers and soldermask layers, options to ignore regions, flashes with holes and include extra registration holes.
- **Soldermask Stencil Example:** SMD example now includes the .gbr file representing the soldermask stencil layer to be used to test the new Stencil Operation workflow.
- **Offset Laser SVG Order Flip Toggle:** This toggle can flip the order in which geometry is put into the svg in case a software starts processing from the wrong side.
- **Offset Laser SVG Unique Colors Per Layer Toggle:** This toggle can enforce individual colors per layer for softwares that process groups from it.

### Changed
- **Hid Number Of Passes/Offset In Drill Operations:** It's now automatically calculated to clear all the geometry and avoid risky central cores that can break end-mills once they get loose.
- **Hardcoded Drill Mill Stepover:** Since it's hidden from users now, it loads a more conservative 40% from config.js.
- **Single File Export Default:** Export Manager Modal now has single file export turned off by default, for safety.
- **New User Hint Animation:** Instead of holding static with 1 source geometry node highlight will now pulse every few seconds.


## [1.1.1] - 2026-03-17

### Added
- **UCCNC Post-Processor:** Extends standard grbl with canned drill cycles, draft tool changing logic, including tool length compensation.
- **More Split File Options:** Upgraded (and fixed) UI and logic to better support spliting operations into individual files and also spit drill files by hole/tool diameter.

### Fixed
- **Only Drill Pecks:** Drill Milling toggle Off state wasn't propagating correctly. Will now allow regular pecks.


## [1.1.0] - 2026-03-16

### Notice
- **Offset Strategy Within Laser Pipeline Has Been Confirmed As Working. Bumping To v1.1.0** Needs more testing until it's considered stable.

### Added
- **Makera Post-Processor:** Equivalent to standard grbl but with M6 T1 preamble. Contains draft tool-changing logic.
- **Heat Buildup Mitigation:** Initial draft of algorithm for geometry reordering and shuffling to minimize laser focusing too much in small localized areas.

### Fixed
- **Copper Pour Regions:** KiCAD and Fusion/Eagle copper pours should now interact correctly with all geometry. (EasyEDA pours TBD.)
- **Export G-code In Inches:** If a user selects G20 in the UI, the output files are scaled correctly to match now.
- **SVG Parsing:** Module now understands that l and m mean relative coordinates while L and M mean absolute coordinates. Plus extra improvements.
- **Gerber Parsing:** Module propagates geometry units and scale more thoroughly.
- **Minor Optimizations**

### Changed
- **Post-Processor Refactor:** Post-processor modules are not self-contained. They now store relevant defaults, profiles and everything they need so adding and managing modules gets more predictable.
- **Partial Cleanup Of Config.js**

### Deprecated
- **utils/unit-converter.js:** Was mostly useless so code was updated to remove it completely.

- **Known Bugs:** Canvas viewport culling doesn't update correctly when board is rotated. No logic to close opened cutout polygons.


## [1.0.9] - 2026-03-11

### Fixed
- **Winding Enforcement:** Winding is now set at the source to avoid having to check and fix it everywhere else.
- **Further Optimizations:** Removed useless winding checks and enforcements through-out.

### Changed
- **Spun Off Analytic Offsetting:** Analytic offsets has been stripped into a geometry-analytic and geometry-utils-math modules. Build.js ignores them during deployment.
- **Optimized Laser SVG File Size:** Moved to relative commands and stripped unnecessary leading and trailing 0's.

- **Known Bugs:** Some KiCAD copper pour regions aren't interacting with other geometry as expected.


## [1.0.8] - 2026-03-07

### Notice
- **Changes to the offset pipeline made everything slightly more accurate but slower, optimization to come**

### Added
- **Copper Pour Regions:** KiCAD and Fusion Copper Pour regions are now correctly parsed, plotted and processed in Copper Isolation Operations (Copper Clear works but is even slower).
- **New Tiny/Noisy/Collapsed Arc Safeguards:** More protections against small arcs with a tendency to collapse on themselves, plus less random unnecessarily small arcs.

### Fixed
- **Arc Definitions in Laser SVGs:** Offset Strategy Arcs in exported Laser SVGs will come out right now.
- **Clipper Wrapper and Arc Reconstruction Optimizations:** Older modules - newish logic.

### Changed
- **Removed Analytic Offsets:** Analytic offsets will be developed independently from the live tool. Clipper2 deals better with self-intersection artifacts, for now.
- **Another Attempt At SEO**


## [1.0.7] - 2026-03-02

### Added
- **1st Draft of Laser Pipeline:** All Laser operations are now available for testing. The automated Hybrid (Laser+CNC) pipeline is locked (or just not finished yet depending on how you look at it).
- **Source file Highlight:** Added small onboarding highlight animation on a timer to guide new users into triggering the workflow UI changes.

### Fixed
- **Boolean Add/Diff Arc Data Flaws:** Arc data should now be more consistently passed through Clipper2 Wrapper functions.

### Changed
- **Moved EasyTrace5000 out of Root:** Now the application itself is accessible through the [easytrace5000/](https://cam.eltryus.design/easytrace5000/) folder to try and appease crawler bots and get the subdomain listed again.
- **File Extensions are set automatically:** The User only needs to input the file name and the pipeline handles the file extensions.


## [1.0.6] - 2026-02-12

### Fixed
- **Full Refactor of Roland PostProcessor:** Complete rework of the RML-1 post-processor module. Should now have all required nuance to work with common Roland desktop CNCs.


## [1.0.5] - 2026-02-03

### Added
- **Accessibility Documentation:** Included a [new script](.github/scripts/sync-accessibility.js) that generates doc/accessibility.html from doc/ACCESSIBILITY.md
- **Narrow Screen Warnings:** Added @media triggered nag messages to the Welcome, Quickstart modals and Workspace about narrow screens breaking the UI.

### Fixed
- **Enforced Climb Cutting:** Mirroring addition broke cutting direction enforcement, now there's a single enforcement point before toolpath translation.
- **Improved Documentation:** Changed hierarchy to include a doc/ folder with other content articles inside of it, reworked CSS for consistency across all pages.
- **Improved Theme Loading:** Added a [new script](.github/scripts/sync-theme.js) to sync dark theme to theme.css and made both theme .jsons lazy load only when necessary.
- **Improved Responsive CSS:** Reworked tool and documentation responsive CSS for very small screens to handle mobile browser safety margins better.

### Removed
- **Nav-tree Object Tooltip:** It was inconsistent and mostly useless. May try to add object statistics another way in the future.

### Changed
- **Small README Re-write**
- **Minor SEO Updates**


## [1.0.4] - 2026-01-27

### Added
- **Reworked Tool Loading Logic:** Complete re-writting of js module loading and initialization logic (cut load times by 50-90%).
- **New Node Build.js Optimizer:** Further expands css, json and js loading to optimize the deployed files that reach web users.
- **Fixed Modal Flexibility:** All UI elements should now be fully usable on smaller screens, even **landscape** smarphones.
- **Couple More SEO Changes**


## [1.0.3] - 2026-01-25

### Added
- **Added Help Modal:** Pressing F1 or clicking the link in the Welcome modal opens the Help modal with starter tips and keyboard shortcuts/navigation.
- **Better ARIA Tags:** Improved Accessible Rich Internet Applications tags related to geometry object hierarchy and interaction.
- **Upgraded Gerber Parsing:** The Gerber Parsing Module can now handle more MACRO commands.
- **Improved HTML:** Fixed index.html following [W3's Validator](https://validator.w3.org/).
- **More SEO Changes**


## [1.0.2] - 2026-01-22

### Added
- **Improved UI Responsivenes:** Made the UI values more flexible. Workspace should be more usable even with smaller screens. (Not aiming at narrow smartphones, yet)
- **Fixed Marlin Post-processor:** Marlin has been flagged as Not supporting modal commands.
- **Added ARIA Tags:** Initial implementation of Accessible Rich Internet Applications tag management.
- **Fixed/Expanded Keyboard Shortcuts/Navigation:** See [Accessibility Documentation](docs/ACCESSIBILITY.md) for more details.
- **Added Favicons**
- **SEO Changes**


## [1.0.1] - 2026-01-16

### Added
- **Mirroring:** Added support for Horizontal (X) and Vertical (Y) board mirroring. Toggles under board rotation inside the Board Placement section.
- **Coordinate System:** Upgraded the transformation engine to support complex combinations of rotation and mirroring.


## [1.0.0] - 2026-01-12

### Initial Release
- **Core:** Fully functional CAM processor with support for Gerber (RS-274X), Excellon, and SVG files.
- **UI:** Responsive, browser-based workspace (Vanilla JS) with Dark/Light themes.
- **Geometry:** Integrated Clipper2 WASM engine for polygon offsetting and boolean operations.
- **Workflow:**
    - Isolation Routing (External offsets).
    - Copper Clearing (Pocketing).
    - Smart Drilling (Peck/Mill/Slot detection).
    - Board Cutout (Tab generation).
- **Visualization:** Custom 2D Canvas renderer with support for tens of thousands of primitives.
- **Export:** G-code generation for GRBL, Marlin, and experimental support for LinuxCNC/Mach3.