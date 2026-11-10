# Pack comparator

A page for reviewing and editing language packs side by side with English. It runs the apps' own pack rules ([`../pack-rules.js`](../pack-rules.js)), so a pack it shows no warnings for is one the apps accept.

**Live:** <https://cam.eltryus.design/language/comparator/>. It is a development aid: the page asks search engines not to index it, and the sitemap leaves it out.

## Using it

* Pick a pack in each column header, or drop a JSON file onto a column. The address preselects them and keeps your place: `?left=en.json&right=de.json`, plus `filter` and `key`.
* Edit in the right column. A plural shows one field per form the target language uses.
* Badges show what the apps would refuse or ignore: changed tokens or tags, empty values, a plural where the source text has no `{count}`, plural forms the language uses but the pack lacks.
* Edits are kept in this browser as a draft for each target language, until reverted with ↶.
* **Export Diff** downloads only the edited keys. **Export Full** downloads the whole pack in English key order, without empty values. A pack exported from the live page lacks the `_projectInfo` notes the build strips: keep the repository copy's.
* Not listed: `meta`, the pack's identity, and `output.gcode`, since G-code comments are always English.

## Locally

Serve the repository ([`ARCHITECTURE.md`](../../ARCHITECTURE.md#running-locally)) and open `/language/comparator/`. From `file://` the presets cannot load, but dropped files still work.

| File | |
|---|---|
| `index.html` | The page and its help dialog. It loads no app code but `../pack-rules.js`. |
| `comparator.js` | `I18nComparator`: loading, the grid, drafts, export. |
| `comparator.css` | Its own styles. |
