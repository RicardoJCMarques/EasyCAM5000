# Contributing to EasyCAM5000

**This project is closed to most code contributions for now.**

## What actually helps

**Confirming post-processors work on real hardware setups.** I only have access to GRBL plus limited access to a Roland MDX-50 and a Fanuc variant machine. Everything else in the [post-processor table](./README.md#post-processors) is community-reported and silence reads the same as success. "grblHAL, tool change, ran clean" is what lets an *experimental* tag come off.

**Bug reports with a file attached.** A reproduction beats a description every time. Laser and stencil output reports count - verifying SVG/PNG in LightBurn or EZCAD is something I can't do at scale.

## Where to put things

* [**Bug / accessibility / feature templates**](https://github.com/RicardoJCMarques/EasyCAM5000/issues/new/choose) - include the file that triggers it and the console output with verbose logging on (<kbd>Ctrl+Alt+D</kbd>, see [ARCHITECTURE.md](./ARCHITECTURE.md#debugging)).
* [**Discussions**](https://github.com/RicardoJCMarques/EasyCAM5000/discussions) - machine settings, post-processor choice, workflow questions, "is this output right".
* [**Private vulnerability reporting**](https://github.com/RicardoJCMarques/EasyCAM5000/security) - security problems only, never a public issue. See [SECURITY.md](./SECURITY.md).

## Open now

These need no code, and all of them are better crowdsourced than written by one person:

* **Translations.** Language packs begin as LLM translations, some vocabulary is beyond what an LLM handles well so they need native speakers who run machines. Review an existing pack or add a new one with the [i18n comparator](https://cam.eltryus.design/language/comparator/) - ([how](./language/comparator/README.md)); the rules are in [language/README.md](./language/README.md).
* **Post-processor setups and laser profiles.** A JSON file can describe your personal controller setup or laser program. Try tweaking existing files and report how it goes: [export/processors/README.md](./export/processors/README.md), [export/profiles/README.md](./export/profiles/README.md).
* **Themes.** Go crazy with theme styling [themes/README.md](./themes/README.md). How custom files work: [core/CUSTOM.md](./core/CUSTOM.md).

## If you open a pull request anyway

I'll read it and consider what to do with it. It must be using the latest version of the code as I can't be responsible for knowing what to keep in a conflic with other code. If it's based on an earlier version it is unlikely that I will merge it. Start a Discussion first before putting in time if there's something you'd like to see implemented.

## Licensing

By submitting a pull request you agree to license your contribution under the GNU Affero General Public License v3.0 or later and confirm you have the rights to submit all of it.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).