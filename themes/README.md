# Themes

The colour palettes of both apps and the documentation pages, and the loader that applies them.

| File | |
|---|---|
| `dark.json` | The default theme. [`css/theme.css`](../css/theme.css) is generated from it, so a page on the default theme fetches no theme file. |
| `light.json` · `hc-dark.json` · `hc-light.json` | The other shipped themes, fetched the first time they are chosen. |
| `theme-loader.js` | `ThemeLoader`: registers, lists and applies themes. The doc pages load it on its own. |

## The contract

* **Complete.** Every theme declares every `colors` key `dark.json` declares, and no others. A theme is written as inline custom properties on `<html>` over `theme.css`, so a key it lacked would quietly show the default's colour.
* **Opaque.** Colours are 6-digit hex. The two scrims (`semantic.scrim`, `semantic.scrimStrong`) are the only translucent values, written as `rgba()`.
* **`base`** is `dark` or `light`, applied as `data-theme-base`. CSS that needs a light/dark branch keys on `data-theme-base`, never on a theme id.
* **`tokens`** (optional) overrides structural custom properties such as `--radius`, `--shadow-*` and `--font-size-*`, written without a prefix.
* **Names.** Shipped themes carry no `label`; the picker names them from the language pack (`params.theme.options.<id>`). A theme with a `label` shows it as written, which is how custom themes are named.
* **`meta.kind`** is `theme`. The loader ignores it; it is there so that a copy of a shipped theme is already most of a valid custom file.

Each colour group maps to a custom-property prefix. Nested keys join with `-` and camelCase turns into kebab-case, so `colors.operations.peckMarkGood` becomes `--color-operation-peck-mark-good`.

| Group | Prefix |
|---|---|
| `background` | `--color-bg-` |
| `text` | `--color-text-` |
| `border` | `--color-border-` |
| `accent` | `--color-accent-` |
| `semantic` | `--color-` |
| `operations` | `--color-operation-` |
| `render2d` | `--color-render2d-` |
| `render3d` | `--color-render3d-` |
| `debug` | `--color-debug-` |
| `geometry` | `--color-geometry-` |
| `primitives` | `--color-primitive-` |
| `bw` | `--color-bw-` |
| `pipelines` | `--color-pipeline-` |
| `interaction` | `--color-interaction-` |

The mapping is written twice, in `ThemeLoader` (`GROUPS`) and in `.github/scripts/sync-theme.js`. Keep the two equal.

## How a theme is applied

`ThemeLoader.applyTheme(id)` fetches the file on first use, removes the properties the previous theme wrote, writes the new ones, sets `data-theme` and `data-theme-base`, updates `<meta name="theme-color">`, saves the choice and dispatches a `themechange` event on `window`. The choice is saved as `cam-theme` in local storage, which every page of the site shares. Code that caches a resolved colour listens for `themechange`.

Every theme but the default is a fetch, and fetches are slow off localhost: a control that switches themes disables itself until `applyTheme` resolves.

`theme.css` hides the page until `<html>` carries `data-theme`. Every page currently writes `data-theme="dark"` in its markup, so that guard never applies, and a saved non-default theme replaces the dark default when its file arrives.

## Changing a shipped theme

1. Edit the JSON. After editing `dark.json`, run `node .github/scripts/sync-theme.js`: it rewrites the generated `:root` block of `theme.css` (never edit that block by hand) and checks `light.json`'s keys against `dark.json`. The high-contrast themes are not checked yet: compare their keys by hand, or read the `parity` entries of the generated context.
2. To ship a new theme, add `themes/<id>.json`, register it in the `ThemeLoader` constructor (`this.register('<id>', '/themes/<id>.json')`), name it in `language/en.json` under `params.theme.options.<id>`, and run `sync-theme.js`.
3. Look at both apps and a doc page in the theme: text, borders, canvas colours and the 3D view.

## Custom themes

A user can add a theme by dropping a JSON file onto either app ([`core/CUSTOM.md`](../core/CUSTOM.md)). Start from a copy of a shipped theme:

```json
{
  "meta": { "kind": "theme" },
  "id": "workshop",
  "label": "Workshop",
  "base": "dark",
  "tokens": {},
  "colors": { "background": { "primary": "#1b1d21" } }
}
```

`colors` above is cut short; a real file keeps every group and key of the theme it was copied from. The file is checked before it is used:

* `id` follows the custom-file id rule and is not a shipped id. `label` is 1 to 60 characters. `base` is `dark` or `light`. `description`, `author`, `license` and `homepage` are optional, and no other top-level keys are allowed.
* `colors` is compared with a shipped theme (`ThemeLoader.reference()`: the first one already loaded, otherwise the first that has a file). It needs the same keys, each in the same form: 6-digit hex where the shipped theme uses hex, an `rgb()` / `hsl()` colour where it does not.
* `tokens` keys must name custom properties the page already declares (`css/base.css` or `css/theme.css`), and no value may load a resource (`url()`, `image-set()`, `image()`, `element()`, `@import`, `expression()`).

A theme that passes is applied at once, saved as the chosen theme and stored as `cam-custom:theme:<id>`. It is listed in the theme picker on the welcome screen. One custom theme is kept: a new one replaces it, and it is removed the next time the page loads once another theme is chosen. Pages without the apps (the landing page, the docs) show the default theme in its place.