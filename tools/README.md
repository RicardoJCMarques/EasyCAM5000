# Tool library

[`tools.json`](./tools.json) is the tool library both apps share. [`tool-library.js`](./tool-library.js) (`ToolLibrary`) loads it, checks every tool, and answers the lookups the parameter forms make.

## tools.json

```json
{
	"meta": { "kind": "toolLibrary" },
	"tools": [
		{
			"id": "em_0.1mm_flat",
			"type": "flat",
			"geometry": { "diameter": 0.1, "flutes": 2, "cuttingLength": 2.0, "shankDiameter": 3.175, "totalLength": 38 },
			"cutting": { "feedRate": 100, "plungeRate": 30, "spindleSpeed": 15000, "maxDepthPerPass": 0.03, "stepOver": 50 },
			"operations": ["isolation", "clearing", "profile", "pocket"]
		}
	]
}
```

* `version` is the schema version, `major.minor`. A library of another major version is refused; a minor version only adds optional fields.
* `tools` lists the tools in the order the pickers show them.
* `meta.kind` is read only when the file is added as a custom library.

The `_schema` block at the top of the file is the reference for every field, and `ToolLibrary.validateTool` enforces it.

| Field | |
|---|---|
| `id` | Unique, and never changed once shipped: profiles (`defaultTool`) and saved operations refer to tools by id. |
| `type` | `flat`, `ball`, `bull`, `corn`, `drill`, `vbit` or `taperedBall`. Decides the required geometry and the generated name. |
| `name` | Optional. Shown as written, in every language. Without it the name is generated from the type and geometry, in the interface language. |
| `geometry` | Millimetres and degrees. Always `diameter`, the widest cutting diameter. `bull` adds `cornerRadius`; `vbit` adds `tipDiameter` and `angle` (included); `taperedBall` adds `tipDiameter` and `halfAngle` (per side). Optional: `effectiveDiameter` (the width a tapered bit cuts at engraving depth, `tipDiameter` when absent), `flutes`, `pointAngle`, `cuttingLength`, `shankDiameter`, `totalLength`, and the pair `holderDiameter` + `holderStickout`, which also needs `shankDiameter` and `cuttingLength`. |
| `cutting` | Required: `feedRate` and `plungeRate` (mm/min), `spindleSpeed` (RPM). Optional: `maxDepthPerPass` (mm), `stepOver` (%), `peckDepth` (mm), `spindleDwell` (s). |
| `operations` | The operation types whose tool list includes this tool. |
| `toolNumber` | Optional changer slot: a positive integer, unique in the library. |

The built-in library must pass completely: one tool that fails stops startup, with the reason in the console.

## How the apps use it

* A tool picker lists the tools whose `operations` include that operation type. The default is the profile's `defaultTool` for the type, else the first tool listed.
* Choosing a tool seeds the operation's tool diameter (the effective width for isolation, clearing and engrave), the V-bit tip and angle, and the feeds and speeds from `cutting`.
* The tool number written to G-code is the one set on the operation or on its drill-table row. Nothing assigns one by itself.

## Custom libraries

A user can replace the library by dropping a JSON file onto either app ([`core/CUSTOM.md`](../core/CUSTOM.md)). Copy `tools.json` and edit `tools`.

* The file replaces the built-in library completely. List a tool for every operation you use, and keep the ids your saved work refers to.
* Each tool is checked like a built-in one. A tool that fails is left out and named in the report with its reason. A file with no valid tool is refused, and the current library stays.
* It is stored as `cam-custom:toolLibrary:library` and restored on every start.
* Operations already set up keep their values. If an operation's tool is not in the new library, pick a tool again before generating.

## Build

`build.js` embeds `tools.json` into `tool-library.js` as `EMBEDDED_TOOLS`, without the `_` keys, and leaves the JSON out of `dist/`. In source the module fetches it.