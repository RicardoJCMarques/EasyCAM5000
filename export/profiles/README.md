# Laser profiles

A laser profile shapes the SVG and PNG files EasyTrace5000 writes for a laser program: how paths are grouped, the order they are written in (although most programs enforce nearest-neighbour), and which colours mark which geometry. Machine Settings > Laser Software picks one; [`graphics-exporter.js`](../graphics-exporter.js) (`GraphicsExporter`) reads it. EasyShape5000 doesn't have laser compatible operations.

## Shipped profiles

| id | Program | Maturity |
|---|---|---|
| `generic` | any program that reads plain SVG | less-experimental |
| `lasergrbl` | LaserGRBL | very-experimental |
| `xtoolstudio` | xTool Studio | less-experimental |
| `lightburn` | LightBurn | very-experimental |
| `rdworks` | RDWorks / Ruida | very-experimental |

`id` is what Machine Settings stores (`laser.activeProfile`): never rename one.

## A profile file

```json
{
  "meta": { "kind": "laserProfile", "app": "EasyTrace5000" },
  "id": "lightburn",
  "label": "LightBurn",
  "maturity": "very-experimental",
  "palette": null,
  "paletteLumping": false,
  "parameters": [
    { "name": "svgGrouping", "type": "select", "category": "laser", "default": "none", "options": [{ "value": "none" }, { "value": "layer" }, { "value": "group" }, { "value": "color" }] },
    { "name": "reverseCutOrder", "type": "checkbox", "category": "laser", "default": true },
    { "name": "heatManagement", "type": "select", "category": "laser", "default": "standard", "options": [{ "value": "off" }, { "value": "standard" }] },
    { "name": "colorPerPass", "type": "checkbox", "category": "laser", "default": true },
    { "name": "layerColors", "type": "colorgrid", "category": "laser", "default": { "isolation": "#ff0000", "drill": "#0000ff", "clearing": "#00ff00", "cutout": "#000000", "stencil": "#860694" } }
  ]
}
```

| Key | |
|---|---|
| `label` | The name the picker shows, as written in every language. `generic` has none: a common word, captioned by `params.activeProfile.options.generic` in the language pack. |
| `maturity` | As for post-processors: a level of `devices.maturity.<level>`, or `null` once verified. |
| `palette` | `null`, or up to 256 unique 6-digit hex colours: the colours the program maps to cut settings. With *Unique Color Per Isolation/Clearing Pass* on, passes take them in order; without a palette, each pass gets a hue of its layer colour. |
| `paletteLumping` | With a palette, passes past its end all take its last colour; otherwise they start again from the first. Needs a palette. |
| `parameters` | The five settings below, each exactly once. Their defaults are what Machine Settings starts at for this profile. |

| Parameter | Type | What it sets |
|---|---|---|
| `svgGrouping` | select: `none`, `layer`, `group`, `color` | How paths are grouped in the SVG. The program decides what it reads: some import layers, some groups, some only colour. |
| `reverseCutOrder` | checkbox | Layers last to first, for a program that processes the file bottom-up. |
| `heatManagement` | select: `off`, `standard` | Reorders passes so consecutive cuts are not adjacent, giving the material time to cool. |
| `colorPerPass` | checkbox | A colour of its own for each isolation and clearing pass. |
| `layerColors` | colorgrid | The colour of each operation type: `isolation`, `drill`, `clearing`, `cutout`, `stencil`. |

A select may offer fewer options than these, and its `default` is one of them. Each parameter keeps the `name`, `type` and `category` shown. The operator's changes are stored per profile under `laserSettings.<id>`; captions are `params.<name>` in the language pack.

## Adding a shipped profile

1. Copy a profile to `export/profiles/<id>.json` and edit it.
2. List the id in `CAMConfig.constants.laserProfiles` (`config.js`), in the order the picker shows them. The build stops when a listed id has no file; in `dist/` the profiles are embedded in `core/cam-controller.js`.
3. Give it a `label`, or, for a common-word name, a caption under `params.activeProfile.options.<id>` in `language/en.json`.
4. Add it to the table above.
5. Export a board with every operation and open the files in the program before anyone fires a laser at them.

## Custom profiles

A user can add a profile without code: a copy with an id and a label of its own, dropped onto EasyTrace5000 ([`core/CUSTOM.md`](../../core/CUSTOM.md)). Without a label, the picker shows its id. It is checked against `kinds.laserProfile` in [`core/file-validation.json`](../../core/file-validation.json):

* The keys above and no others; `meta.kind` is `laserProfile`.
* `id` follows the custom-file id rule and is not a shipped id.
* The five parameters, each once, with hex colours, and a select's `default` among its options.
* Unique `palette` colours, and `paletteLumping` only with a palette.

It appears under Machine Settings > Laser Software, marked "(Custom)". One is kept at a time: a new one replaces it, and becomes the choice if the one it replaced was chosen. Clicking it on the welcome screen removes it; a saved choice of a profile that is gone falls back to a built-in one.