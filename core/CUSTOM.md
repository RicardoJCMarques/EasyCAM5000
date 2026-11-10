# Custom files

Users can use their own personal theme, post-processor setup, laser profile, tool library or language pack by dropping a JSON file onto either app. Each file is checked against [`file-validation.json`](./file-validation.json), put in use, and kept in the browser's local storage. Nothing is uploaded anywhere.

## Adding a file

* Drop one or more `.json` files anywhere on either app while no dialog is open.
* A report lists each file: what it added and where to find it, or every reason it was refused. A file with any problem is refused whole, and nothing of it is used or stored.
* One file of each kind is kept. A new one replaces the previous file of its kind, or an earlier copy of itself.
* A file takes effect as soon as it is added:

| `meta.kind` | Holds | Start from | On adding |
|---|---|---|---|
| `theme` | a theme | any theme in [`themes/`](../themes/) | applied, and saved as the chosen theme |
| `setup` | a post-processor setup | any setup in [`export/processors/`](../export/processors/) | listed under Machine Settings > Post-Processor |
| `laserProfile` | a laser profile | any profile in [`export/profiles/`](../export/profiles/) | listed under Machine Settings > Laser Software (EasyTrace5000) |
| `toolLibrary` | a whole tool library | [`tools/tools.json`](../tools/tools.json) | replaces the built-in library in every tool picker |
| `language` | a language pack | [`language/en.json`](../language/en.json) | the interface switches to it, and it is saved as the chosen language |

* A setup or laser profile that replaces the one chosen in Machine Settings becomes the choice.
* A custom theme or language pack stays while it is the one chosen. The welcome screen pickers list it, marked Custom; once another is chosen, it is removed the next time the page loads.
* A custom setup, laser profile or tool library in use shows as Custom on the welcome screen, and clicking it there removes it. A saved choice of it falls back to a built-in one.

Geometry is never mistaken for a custom file: only `.json` files are taken, and no geometry format uses that extension. When a drop also holds other files (a project folder, say), a JSON file counts as a custom file only if it declares `meta.kind`. Any other JSON goes on to the geometry import, which skips it.

## What every file needs

```json
{
  "meta": { "kind": "setup" }
}
```

* `meta.kind` names what the file holds. `meta` may also hold `app`, which is ignored; a language pack's `meta` holds the pack's own keys (below).
* Top-level keys that start with `_` are notes and are skipped.
* At most 1 MiB.
* Ids are 2 to 32 lowercase letters, digits or dashes, start with a letter, and are not ids a shipped item already uses. A language pack's id is its locale.

The shipped files carry their `meta.kind`, so the quickest way to a valid file is to copy one, give it an id and a label of its own, and edit it.

## Kind by kind

### Themes

Copy a shipped theme, give it a new `id`, and add a `label`: the name the picker shows. Shipped themes have no label, because the language pack names them.

* `colors` declares exactly the keys the shipped themes declare, each in the same form: a 6-digit hex colour, or an `rgb()` / `hsl()` colour where the shipped themes use one (the two scrims).
* `tokens` may only set custom properties the page already declares, such as `--radius` from `css/base.css`, and no value may load anything: no `url()`, `image-set()`, `image()`, `element()`, `@import` or `expression()`.
* `base` is `dark` or `light`.

Pages without the apps (the landing page, the docs) show the default theme while a custom one is chosen. More in [`themes/README.md`](../themes/README.md).

### Language packs

Copy `language/en.json`, then set its `meta`:

```json
"meta": { "kind": "language", "locale": "nl", "name": "Nederlands", "dir": "ltr", "fallback": null }
```

* `locale` is a language tag no shipped pack uses, written in its canonical form. To try changes to a shipped language, use a private tag such as `de-x-test` or `pt-x-shop`: its base language is found without a `fallback`.
* `name` is the language's own name, as the picker shows it.
* `dir` is `ltr` or `rtl`. `fallback` names a shipped pack to try before the base language and English, or is `null`.
* Every string keeps the `{tokens}` and `<tags>` of its English text, a plural object is allowed where the English text receives a `{count}`, and an empty string is refused: leave the key out instead. The rules: [`language/README.md`](../language/README.md).
* Keys the pack leaves out fall back along that chain, to English in the end. Keys en.json does not have are ignored. The report lists both.

The [comparator](../language/comparator/README.md) runs the same checks while you edit.

### Post-processor setups

A setup is a whole post-processor configuration: what the control accepts (`flags`), the Machine Settings values it starts with (`defaults`) and the ones it fixes (`locks`). It adds no code: its `logic` names one of the shipped program writers. The format and its checks: [`export/processors/README.md`](../export/processors/README.md#custom-setups).

### Laser profiles

A profile sets how EasyTrace5000's laser SVG and PNG files are grouped, ordered and coloured. The format and its checks: [`export/profiles/README.md`](../export/profiles/README.md#custom-profiles).

### Tool libraries

Copy `tools/tools.json` and edit its `tools`. Each tool is checked by the same rules as the built-in library ([`tools/README.md`](../tools/README.md)): a tool that fails is left out and named in the report, and a file with no valid tool is refused.

The library **replaces** the built-in one. List a tool for every operation you use, since an operation with no tool in the library has nothing to pick, and keep the ids of tools your saved work refers to.

## For developers

| Where | What |
|---|---|
| `core/custom-files.js` | `CustomFiles`: check, register, store, restore at startup, reconcile saved choices, remove |
| `core/file-rules.js` | `FileRules`: the rules engine, and a lint of the rules file against its own vocabulary |
| `core/file-validation.json` | Every rule, as data |
| `core/cam-controller.js` | `ingestFiles` hands each drop to `CustomFiles.take` |
| `ui/ui-base-app.js` · `ui/ui-modal-manager.js` | The report (`reportCustomFiles`); the welcome screen pickers and remove buttons |
| The owners | `ThemeLoader.register` / `unregister` / `reference`, `i18n.register` / `unregister`, `GCodeGenerator.register` / `unregister`, `GraphicsExporter.registerProfile` / `unregisterProfile`, `ToolLibrary.replace` / `restoreBuiltIn` |

### Storage

One local-storage key per kind, shared by both apps: `cam-custom:<kind>:<id>`, and `cam-custom:toolLibrary:library` for the tool library. The value is `{ source, importedAt, data }`, where `data` is the whole file, so a stored record can be checked on its own. A file is put in use before it is stored: one the browser will not store still works until the page closes, and the report says so.

### Startup

1. `core/file-rules.js` and `core/custom-files.js` load right after `config.js`, so `ThemeLoader` and `i18n` read their stored entry synchronously while they construct. These two kinds were checked when added and are not checked again. Each owner deletes its entry when it is not the saved choice. A page without `CustomFiles` (the landing page, the docs) offers the shipped themes only and deletes nothing.
2. `CamController.initialize` creates `CustomFiles` once the built-in posts, laser profiles and tools exist. With debug on, `checkShipped()` lints the rules file and checks every shipped setup, laser profile and language pack as a custom copy would be checked.
3. `restore()` checks the stored setup, laser profile and tool library **again** before registering them: they reach the machine, and the rules can change between versions. A stored file the rules now refuse, or whose id a shipped item now uses, is deleted with a note; one the app itself failed on is kept for the next start.
4. `loadSettings` runs next and seeds the settings of every registered device.
5. `reconcile()`: a saved setup or laser profile that is not registered falls back to a built-in one for this session. Nothing is saved, so the choice returns when its file does.
6. Notes from steps 3 and 5 are attached to the Ready status line and written to the log.

### The rules file

`file-validation.json` holds `maxBytes`, one spec per kind under `kinds`, and shared specs under `definitions`. It uses a subset of JSON Schema - `type`, `const` / `enum`, `minimum` / `maximum` / `exclusiveMinimum`, `minLength` / `maxLength` / `pattern`, `format`, `properties` / `required` / `additionalProperties` / `propertyNames` / `minProperties`, `items` / `minItems` / `maxItems` / `uniqueItems` and `$ref` - plus keywords of its own: `x-message`, `x-placeholders`, `x-byName`, `x-reference`, `x-logic`, `x-id` and `x-rules`. The `_keywords` block at the top of the file defines each one.

`x-rules` are checks across keys, read from the node that declares them:

```json
{
  "id": "useM6NeedsToolChange",
  "if": { "path": "flags.useM6", "is": true },
  "then": { "path": "flags.supportsToolChange", "is": true }
}
```

A rule passes when its `if` is false or its `then` is true; a rule without `if` always applies. Conditions: `all`, `any`, `not`, and on a `path`: `is`, `isNot`, `hasAny`, `notEmpty`, `isPath`, `inPath` (where `*` stands for each array item), `atMostPath` and `belowPath`. Rules only read a node whose own keys passed.

Every message is a key in `language/en.json`: `customFiles.problems.<keyword>`, `customFiles.problems.pattern.<x-message>`, `customFiles.problems.format.<format>`, and `customFiles.rules.<id>` for a rule.

### Changing the rules

* Loosening or tightening a value is a JSON edit; no code changes.
* A new rule needs a unique `id` and its message, `customFiles.rules.<id>`.
* A new flag goes into its logic's definition (`setup-rs274`, `setup-rml`), and into every shipped setup of that logic: every flag is required.
* A new `format` is code in `custom-files.js` (`FORMATS`); a new condition or keyword is code in `file-rules.js`. An unknown format, condition, reference or `$ref` throws, so a typo fails loudly, and with debug on the lint reports every key `_keywords` does not name and every message en.json lacks.
* Stored setups, laser profiles and tool libraries are checked at every start, so a stricter rule deletes a stored file that no longer passes, with a startup note. Say so in the changelog.

### Build

`build.js` embeds the rules into `core/custom-files.js` as `EMBEDDED_FILE_VALIDATION`, without the `_` keys, and leaves the JSON out of `dist/`. In source the module fetches it.
