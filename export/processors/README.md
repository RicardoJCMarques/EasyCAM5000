# Post-processors

A post-processor writes toolpath plans in one controller's dialect. Each is a **setup** (`<id>.json`: what the control accepts and the settings it starts with) run by a **logic** (the code that writes the words). [`gcode-generator.js`](../gcode-generator.js) (`GCodeGenerator`) owns the posts, decides when a tool change happens and drives the post. Both apps share every post.

## Shipped setups

| id | Name | Logic | File | Maturity | Tool change | Tool length modes | Rotary routes (words) |
|---|---|---|---|---|---|---|---|
| `grbl` | Grbl | `rs274` | `.nc` | - | no | none | wrapped-linear |
| `grblhal` | grblHAL | `rs274` | `.nc` | experimental | M6, then M0 | none, table | wrapped-linear, a-word (A, B) |
| `makera` | Makera (Carvera) | `makera` | `.cnc` | less-experimental | own sequence | probe, none | wrapped-linear, a-word (A) |
| `uccnc` | UCCNC | `rs274` | `.nc` | experimental | M6, then M0 | table, none | a-word, wrapped-linear (A, B), G93 |
| `mach3` | Mach3 | `rs274` | `.tap` | experimental | M6, then M0 | table, none | a-word, wrapped-linear (A, B), G93 |
| `linuxcnc` | LinuxCNC | `rs274` | `.ngc` | less-experimental | M6 | table, none | a-word, wrapped-linear (A, B), G93 |
| `marlin` | Marlin | `rs274` | `.gcode` | experimental | no | none | wrapped-linear |
| `fanuc` | Fanuc | `fanuc` | `.nc` | radioactive | own sequence | table, table-implicit, none | a-word, wrapped-linear (A, B), G93 |
| `winpcnc` | WinPC-NC | `winpcnc` | `.nc` | radioactive | own sequence | none | a-word, wrapped-linear (A, B) |
| `roland` | Roland (RML) | `rml` | `.rml` | very-experimental | no | - | - |

`id` is what Machine Settings stores: never rename one. Tool length modes and rotary routes are listed in the order the pickers show them; the defaults are the setup's `defaults.toolLengthCompMode` and `defaults.rotaryRoute`.

## A setup file

```json
{
  "meta": { "kind": "setup" },
  "id": "grblhal",
  "label": "grblHAL",
  "logic": "rs274",
  "maturity": "experimental",
  "flags": { "fileExtension": ".nc", "supportsToolChange": true, "useM6": true, "pauseAfterToolChange": true },
  "defaults": { "startCode": "", "endCode": "M5\nG0 X0 Y0\nM2", "toolLengthCompMode": "none" },
  "locks": {},
  "_notes": { "toolLengthComp": "Why none leads: an empty tool table applies offset zero." }
}
```

`flags` and `defaults` above are cut short: a real file declares every flag, and every default its logic requires.

| Key | |
|---|---|
| `label` | The name the picker shows, as written in every language. No two setups share one. |
| `logic` | The code that writes the program, and with it the flags the file must declare (below). |
| `maturity` | `less-experimental`, `experimental`, `very-experimental` or `radioactive`, or `null` once the post is verified. The picker appends it to the name and shows its note while the post is selected (`devices.maturity.<level>` in the language pack). |
| `flags` | What the control accepts. Every flag is required: no code fills in a missing one. |
| `defaults` | The value each Machine Settings field starts at while this setup is active, by field name. The operator may change it. |
| `locks` | Values the operator cannot change while this setup is active. A locked field shows "Set by *label*" and is never stored. |
| `_notes` | Notes for whoever edits the file. Every top-level key starting with `_` is skipped. |

### Logic

| `logic` | Class, file | Writes its own |
|---|---|---|
| `rs274` | `BasePostProcessor`, [`base-processor.js`](./base-processor.js) | nothing: the base every G-code logic builds on |
| `makera` | `MakeraPostProcessor`, `makera-processor.js` | header, footer, tool swap (ATC or manual) |
| `fanuc` | `FanucPostProcessor`, `fanuc-processor.js` | header, footer, tool change, number formats, dwell |
| `winpcnc` | `WinPCNCPostProcessor`, `winpcnc-processor.js` | header, footer, tool change, feeds, dwell, spindle, Latin-1 comments |
| `rml` | `RolandPostProcessor`, `roland-processor.js` | all of it: RML-1, not G-code |

`rs274`, `makera`, `fanuc` and `winpcnc` read the flags below (definition `setup-rs274` in [`core/file-validation.json`](../../core/file-validation.json)). `rml` declares most of them fixed and adds `models`, one entry per Roland machine (definition `setup-rml`).

A logic is a class in `ROOT.PostLogic`, a map from logic name to class (`base-processor.js` creates it with `rs274`; each other file adds itself with `ROOT.PostLogic.set`). It names its definition in `static setupSchema`, lists its own settings in `static parameters`, and overrides methods only where its dialect differs from the base: `generateHeader` / `generateFooter`, `toolChangeRetract` / `toolChangeSwap`, `formatDwell`, `setSpindle`, `transliterate`.

### Fields

| Value | Meaning |
|---|---|
| `fileExtension` | Extension of the exported file: a dot and 1 to 5 letters or digits. |
| `commentStyle` | `parenthesis` or `semicolon`. |
| `supportsComments` | Write comments at all. |
| `supportsUnits`, `supportsCoolant`, `supportsLineNumbers` | Offer the Units (`G20` / `G21`), coolant and Line Numbers settings. |
| `lineNumberMax` | The highest `N`; numbering wraps to the step after it. |
| `modalCommands` | Leave out a motion word (`G0` to `G3`) that repeats the previous block's; `false` writes it on every line. |
| `coordinateDecimals`, `rotaryDecimals`, `feedDecimals`, `spindleDecimals` | Decimals (0 to 6) of X, Y, Z, I and J; of the rotary word; of F; of S. |
| `maxSpindleSpeed` | Higher `S` values are capped, with a warning. |
| `spindle` | `on` and `off`: the M words (`M3`, `M5`). `scale`: `null` writes RPM; a number writes a duty value that reaches it at `maxSpindleSpeed` (Marlin's 255). |
| `dwellUnit`, `dwellWord` | The dwell in `s` or `ms`, written as `G4 P` or `G4 F`. |
| `supportsArcCommands` | `G2` / `G3`; `false` writes arcs as short `G1` segments. `arcFormat` is `IJ`. |
| `supportsCannedCycles` | Drill cycles (`G81` / `G82` / `G83` / `G73`) are offered and written; otherwise drilling is written as plain moves. |
| `supportsToolChange` | Tool changes can be written; enables *Insert tool changes* in the Export Manager. |
| `useM6`, `pauseAfterToolChange` | The swap is `T{n} M6`; `M0` follows each swap, for a manual change. |
| `emitsInitialTool`, `initialToolUsesM6` | Write the first tool's T word at the start; write it as `M6 T{n}`. |
| `toolLengthComp` | The tool length modes Machine Settings offers. `none`: the operator re-zeros Z on the new bit. `table`: `G43 H{n}` after the swap. `table-implicit`: `T{n} M06 G43`, with no H word. `probe`: nothing extra, because the control's change macro measures the tool. |
| `supportsAbsoluteZ` | The control can run with Z0 fixed on the machine: offers Absolute Z. |
| `rotary` | The 4th axis. `routes`: `a-word` (A or B in degrees), `wrapped-linear` (Y carries millimetres of arc: the Y motor drives the rotary), `a-linear` (A or B carrying millimetres of arc); empty for no 4th axis. `axisWords`: `A`, `B`. `inverseTime`: `G93` exists. `maxInverseTime`: the control's F ceiling under `G93`. `continuous`: unlimited rotary travel. |

### Defaults and locks

Both name a setting by its field name: a Machine Settings field (`toolLengthCompMode`, `rotaryRoute`, `indexDwell`, `lineNumbers`, `lineNumberStep`, ...) or one of the logic's own settings, `startCode` and `endCode` included. An `rs274` family setup gives `startCode`, `endCode`, `toolLengthCompMode`, `indexDwell`, `lineNumbers` and `lineNumberStep`, and `rotaryRoute` when it declares rotary routes; an `rml` setup gives `startCode`, `endCode`, `rolandModel` and `rolandZMode`.

Start and end code hold printable ASCII and line breaks. `startCode` may use `{toolNumber}`; `endCode` may use `{safeZ}` and `{travelZ}`. Any other `{name}` is refused, since it would reach the program as written.

### Settings of its own

`static parameters` declares the settings a logic reads, by name: `startCode` and `endCode` for every logic, plus `makeraToolChangeMode`; `fanucProgramNumber`, `fanucProgramName`, `fanucWorkOffset` and `fanucRotaryUnwind`; `winpcProgramName`, `winpcFeedUnit` and `winpcAuxOutput`; `rolandModel` (one option per `flags.models` entry) and `rolandZMode`. They appear under the post picker in Machine Settings while the post is selected, are stored per post under `processorSettings.<id>`, are captioned by `params.<name>` in the language pack, and reach the post in its `options`.

### Comments

Comment text is keyed under `output.gcode` in `language/en.json` and always written in English: call `appendComment(line, key, options, values)` or `pushCommentLine(lines, key, options, values)`, never a literal. `sanitizeComment` folds every comment to printable ASCII, drops `! ~ ? %`, and turns `( )` into `[ ]` in parenthesis style. A control that reads more than ASCII overrides `transliterate` (WinPC-NC); nothing overrides `formatComment`.

## Adding a shipped setup

1. Copy a setup to `export/processors/<id>.json` and edit it. Write a new logic only if the dialect needs code (below).
2. List the id in `CAMConfig.constants.setups` (`config.js`), in the order Machine Settings shows them. The build stops when a listed id has no file; in `dist/` the setups are embedded in `core/cam-controller.js`.
3. Add it to the table above and to the root README.
4. Generate a program with every operation type and read it before any machine runs it.

A new logic: write `export/processors/<name>-processor.js`, a class extending `BasePostProcessor` with its `setupSchema` and `parameters`, published with `ROOT.PostLogic.set`. Add its `<script>` to both `easytrace5000/index.html` and `easyshape5000/index.html` after `base-processor.js`, caption its settings under `params.<name>` and any new comment under `output.gcode.comments` in `language/en.json`, and give it its own definition in `core/file-validation.json` if it reads flags the others do not.

## Custom setups

A user can add a variant of a shipped setup without code: a copy with an id and a label of its own, dropped onto either app ([`core/CUSTOM.md`](../../core/CUSTOM.md)). It changes what the control is told, never the code: its `logic` is one of the above. For an automatic changer, a copy of `grblhal.json` might set `pauseAfterToolChange` to `false`, make `table` the default tool length mode and park at Safe Z before the end:

```json
"defaults": {
  "endCode": "M5\nG0 Z{safeZ}\nG0 X0 Y0\nM30",
  "toolLengthCompMode": "table"
}
```

It is checked before it is kept:

* Every key its logic's definition lists, and no other.
* `id` follows the custom-file id rule and is not a shipped id. `label` is 1 to 60 characters and no other setup's, shipped or custom, ignoring case.
* Each default and lock names a setting this setup uses and holds a value that field accepts: its type and range, one of its options, and for a picker one this setup offers (a `toolLengthCompMode` from `flags.toolLengthComp`, a `rotaryRoute` from `flags.rotary.routes`).
* The rules across flags:

| Rule | |
|---|---|
| `toolChangeSwap` | `supportsToolChange` needs `useM6` or `pauseAfterToolChange`, or a tool change writes no swap. Makera writes its own. |
| `useM6NeedsToolChange` | `useM6` needs `supportsToolChange`. For an M6 on the first tool only, use `initialToolUsesM6`. |
| `pauseNeedsToolChange` | `pauseAfterToolChange` needs `supportsToolChange`. |
| `lengthCompNeedsSwap` | A tool length mode other than `none` needs `supportsToolChange` and `useM6` (Makera: its own swap). |
| `rotaryWords` | The `a-word` and `a-linear` routes need an entry in `rotary.axisWords`. |
| `rotaryRouteDefault` | Rotary routes need `defaults.rotaryRoute`, one of them. |
| `lineNumberRange` | `defaults.lineNumberStep` is below `flags.lineNumberMax`. |

A refused file lists every problem at once, each with its path:

```text
label: 'Grbl' is already the name of setup grbl. Give this one a name of its own.
defaults.toolLengthCompMode must be one of none, table.
```

A custom setup appears under Machine Settings > Post-Processor, marked "(Custom)". One is kept at a time: a new one replaces it, and becomes the choice if the one it replaced was chosen. Clicking it on the welcome screen removes it; a saved choice of a setup that is gone falls back to a built-in one.
