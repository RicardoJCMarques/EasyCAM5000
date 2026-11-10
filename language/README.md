# Language packs

The interface text of both apps: one JSON pack per language. [`language-manager.js`](./language-manager.js) (`ROOT.i18n`) loads them and words every string; [`pack-rules.js`](./pack-rules.js) (`PackRules`) holds the rules a pack must keep, shared by the apps, the custom-file check and the comparator.

| File | |
|---|---|
| `en.json` | English: the complete reference every pack is checked against. Its `_schema` block is the format, written for translators. |
| `<locale>.json` | A translation. A key it leaves out shows in English. |
| `language-manager.js` | Loading, lookup with fallbacks, plurals, lists, static markup. |
| `pack-rules.js` | Tokens, tags, plurals and empty values: what makes a string fit its English text. |
| [`comparator/`](./comparator/README.md) | A page for reviewing and editing packs side by side with English, live at <https://cam.eltryus.design/language/comparator/>. |
| [`RTL.md`](./RTL.md) | What right-to-left support will need. Not started. |

## How a pack is used

* `CAMConfig.constants.languages` in `config.js` lists the languages the picker offers, each named in its own language. A listed pack is fetched when it is chosen; `ar.json` ships unlisted until right-to-left support exists.
* A lookup walks a chain: the chosen pack, its `meta.fallback`, its base language when listed (`pt` for `pt-BR`), then English. In each pack, `apps.<app>.<key>` is tried before `<key>`, so the apps can word one thing differently.
* English is embedded in both apps; every pack, English included, also ships as a file.
* `?lang=<locale>` picks a language and saves it. `?lang=en-XA` shows a pseudo-locale for one visit: any text still plain on screen bypasses the pack.
* G-code comments (`output.gcode`) are always English: a control reads them. SVG comments follow the interface language.
* `[...i18n.reported]` in the console lists every missing key the session met.

## What a translation keeps

Each string keeps the shape of its English text. The details, with examples, are in en.json's `_schema`.

* **Tokens.** Every `{name}` and `{name:unit}`, written the same; their order is free. `{app}` may be added or left out. `{{name}}` prints `{name}` and takes no value.
* **Tags.** `<name>words</name>`: translate the words, keep the tags. `<name/>`: move it where the grammar needs it, never drop it. Text shown as markup keeps only `<strong>`, `<em>`, `<code>` and `<br/>`.
* **Plurals.** An object of the CLDR forms the language uses (`zero`, `one`, `two`, `few`, `many`, `other`; `other` is required), allowed wherever the English text receives `{count}`. A form may leave `{count}` out.
* **No empty strings.** Leave the key out and English shows.
* **Keys** say what the text is for, and never change once shipped. A key English lacks is a defect.

## Reviewing or adding a language

1. Open the comparator with the pack on the right, for example <https://cam.eltryus.design/language/comparator/?right=de.json>.
2. Work through *Missing on Target* and *Token / Tag Warnings*, then read the rest against the app in that language.
3. Export the pack and send it, for example in a [Discussion](https://github.com/RicardoJCMarques/EasyCAM5000/discussions).
4. To try it in the app first, give its `meta.locale` a private tag (`de-x-test`) and drop it onto either app as a custom file ([`core/CUSTOM.md`](../core/CUSTOM.md)).

A new language also needs its file, `language/<locale>.json`, whose `meta` gives `kind` (`language`), `locale` (the file name), `name`, `dir` and `fallback`, and an entry in `CAMConfig.constants.languages`. The build stops when a listed locale has no file.