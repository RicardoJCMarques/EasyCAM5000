# Contributing to EasyCAM5000

**This project is closed to direct code contributions for now.**

## What actually helps

**Confirming a post-processor works on real hardware setups.** I only have access to GRBL, Roland and a Fanuc variant machine. Everything else in the [post-processor table](./README.md#post-processors) is either community-reported or completely untested, and silence reads the same as success. "grblHAL, tool change, ran clean" is what lets an *untested* tag come off.

**Bug reports with a file attached.** A reproduction beats a description every time. Laser and stencil output reports count - verifying SVG/PNG in LightBurn or EZCAD is something I can't do at scale.

## Where to put things

* [**Bug / accessibility / feature templates**](https://github.com/RicardoJCMarques/EasyCAM5000/issues/new/choose) - include the file that triggers it and console output from `enableTraceDebug()` or `enableShapeDebug()`.
* [**Discussions**](https://github.com/RicardoJCMarques/EasyCAM5000/discussions) - machine settings, post-processor choice, workflow questions, "is this output right".
* [**Private vulnerability reporting**](https://github.com/RicardoJCMarques/EasyCAM5000/security) - security problems only, never a public issue. See [SECURITY.md](./SECURITY.md).

## Coming later

Three areas will soon open to outside contributions once their formats are stable, and all three are better crowdsourced than written by one person:

* **Translations.** The string layer exists; only English is populated, and it's incomplete. Technical machining vocabulary is beyond what an LLM handles well - native speakers who run machines will be doing the real work here.
* **Custom Tool libraries.** Import/export is coming. Shareable libraries per machine, per vendor, per material.
* **Custom Themes.** Same shape: a JSON palette, importable.
* **Custom Post-Processors/Laser Profiles.** Also importable, to improve testing new machine/setups.

If you want to be pinged when one of those opens, say so in a Discussion (There's an issue asking for custom tools already. [#28](https://github.com/RicardoJCMarques/EasyCAM5000/issues/28))

## If you open a pull request anyway

I'll read it, and I may well use the idea - but expect it to be closed rather than merged while the refactoring continues, and please don't invest much time before asking in a Discussion first.

## Licensing

By submitting a pull request you agree to license your contribution under the GNU Affero General Public License v3.0 or later, and confirm you have the rights to submit all of it.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).