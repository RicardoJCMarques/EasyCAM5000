/*!
 * @file        language/language-pack-rules.js
 * @description Language pack text rules, shared by the runtime, the custom-file check and the comparator
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  const ROOT = globalThis;
  const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
  const PLURAL_SET = new Set(PLURAL_FORMS);
  // Shared /g objects: matchAll() and replace() only. test() and exec() keep
  // state in lastIndex and would make the next caller skip matches.
  // A {{name}} literal, or a {name} / {name:unit} token.
  const FILL = /\{\{(\w+)\}\}|\{(\w+)(?::([^{}]+))?\}/g;
  // <name>words</name> or <name/>: a slot in static markup, or a tag html() keeps.
  const SLOT = /<(\w+)>([^<]*)<\/\1>|<(\w+)\/>/g;
  // Filled from the app context in every string, so a translation may add or drop it.
  const CONTEXT_TOKENS = new Set(['{app}']);
  const COUNT_TOKEN = /^\{count[:}]/;
  // G-code comments are worded from en.json alone (LanguageManager.english).
  const ENGLISH_ONLY = /^(?:apps\.[^.]+\.)?output\.gcode(?:\.|$)/;
  // Every category integers select below a million shows up by 200; the many
  // of es, fr, it and pt starts at a million and falls back to other.
  const SAMPLE_LIMIT = 200;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const join = (path, key) => path ? `${path}.${key}` : key;
  const formsCache = new Map();
  const PackRules = {
    PLURAL_FORMS,
    FILL,
    SLOT,

    isPlural(value) {
      return isObject(value) && typeof value.other === 'string' &&
        Object.entries(value).every(([form, text]) => PLURAL_SET.has(form) && typeof text === 'string');
    },

    isText(value) {
      return typeof value === 'string' || PackRules.isPlural(value);
    },

    /** No words to show: a lookup goes on down the locale chain. */
    isBlank(value) {
      return value === '' || (PackRules.isPlural(value) && value.other === '');
    },

    /** Worded from en.json alone (G-code comments): no translation of it is read. */
    isEnglishOnly(path) {
      return ENGLISH_ONLY.test(path);
    },

    /**
     * The placeholders a string carries as written ({name}, {name:unit},
     * {{name}}), their token names, and its slot and tag names, sorted with
     * repeats kept and '/' marking <name/>.
     * @param {string} text
     * @returns {{tokens: Set<string>, names: Set<string>, slots: string[]}}
     */
    shape(text) {
      const tokens = new Set();
      const names = new Set();
      for (const [, literal, name, unit] of text.matchAll(FILL)) {
        if (literal) {
          tokens.add(`{{${literal}}}`);
        } else {
          tokens.add(unit ? `{${name}:${unit}}` : `{${name}}`);
          names.add(name);
        }
      }
      return { tokens, names, slots: [...text.matchAll(SLOT)].map(m => m[1] ?? `${m[3]}/`).sort() };
    },

    /**
     * The plural categories a language uses: the ones Intl selects for its
     * integers, and other. Any other category is never chosen; zero is an
     * override for a count of 0 in every language.
     * @param {string} locale
     * @returns {string[]} in CLDR order
     */
    requiredForms(locale) {
      let forms = formsCache.get(locale);
      if (forms) return forms;
      const used = new Set(['other']);
      try {
        const rules = new Intl.PluralRules(locale);
        for (let n = 0; n <= SAMPLE_LIMIT; n++) used.add(rules.select(n));
      } catch {
        // Not a tag Intl reads: other is the only certain form
      }
      forms = PLURAL_FORMS.filter(form => used.has(form));
      formsCache.set(locale, forms);
      return forms;
    },

    /**
     * One translated value against its English text. Each form keeps every
     * English placeholder, unit and {{literal}} included, and adds none; {app}
     * is free either way and a plural form may drop {count}. Each form keeps
     * the English slots and tags as many times as English has them, and none
     * is empty.
     * @param {string|Object} reference - English text or plural forms
     * @param {*} value
     * @returns {Array<{code: string, expected?: string[]}>} empty when the value fits
     */
    compareText(reference, value) {
      const plural = PackRules.isPlural(value);
      if (typeof value !== 'string' && !plural) return [{ code: isObject(value) ? 'plural' : 'notText' }];
      const englishForms = typeof reference === 'string' ? [reference] : Object.values(reference);
      const english = englishForms.map(form => PackRules.shape(form));
      // A plural form is picked by values.count, which only a string written with {count} is given.
      if (plural && typeof reference === 'string' && !english[0].names.has('count')) return [{ code: 'pluralNoCount' }];
      const tokens = new Set(english.flatMap(shape => [...shape.tokens]));
      const slots = PackRules.shape(typeof reference === 'string' ? reference : reference.other).slots;
      const forms = plural ? Object.values(value) : [value];
      let tokensFit = true;
      let slotsFit = true;
      for (const form of forms) {
        if (form === '') continue;
        const shape = PackRules.shape(form);
        for (const token of tokens) {
          if (!shape.tokens.has(token) && !CONTEXT_TOKENS.has(token) && !(plural && COUNT_TOKEN.test(token))) tokensFit = false;
        }
        for (const token of shape.tokens) {
          if (!tokens.has(token) && !CONTEXT_TOKENS.has(token)) tokensFit = false;
        }
        if (shape.slots.join() !== slots.join()) slotsFit = false;
      }
      const problems = [];
      if (forms.includes('')) problems.push({ code: 'empty' });
      if (!tokensFit) problems.push({ code: 'tokens', expected: [...tokens] });
      if (!slotsFit) problems.push({ code: 'slots', expected: slots });
      return problems;
    },

    /**
     * A whole pack against en.json. problems are value faults (compareText's
     * codes, and 'group' where English has a group and the pack does not).
     * Keys the pack leaves out show in English and keys en.json lacks are
     * ignored: both come back listed, as do plurals that lack a category the
     * pack's language uses. Top-level meta and _ keys are not strings, and
     * G-code comments are English in every language: neither side reads them.
     * @param {Object} english
     * @param {Object} pack
     * @returns {{problems: Array<{path: string, code: string, expected?: string[]}>,
     *   missing: string[], extra: string[], pluralForms: string[], forms: string[]}}
     *   forms: the categories pluralForms is measured against
     */
    comparePack(english, pack) {
      const locale = pack?.meta?.locale;
      const forms = typeof locale === 'string' ? PackRules.requiredForms(locale) : ['other'];
      const result = { problems: [], missing: [], extra: [], pluralForms: [], forms };
      const skip = (path, key) => (!path && (key === 'meta' || key.startsWith('_'))) || ENGLISH_ONLY.test(join(path, key));
      const walk = (reference, mine, path) => {
        for (const [key, text] of Object.entries(reference)) {
          if (skip(path, key)) continue;
          const at = join(path, key);
          const value = mine[key];
          if (!Object.hasOwn(mine, key)) {
            result.missing.push(at);
          } else if (PackRules.isText(text)) {
            for (const problem of PackRules.compareText(text, value)) result.problems.push({ path: at, ...problem });
            if (PackRules.isPlural(value) && forms.some(form => !Object.hasOwn(value, form))) result.pluralForms.push(at);
          } else if (isObject(value) && !PackRules.isPlural(value)) {
            walk(text, value, at);
          } else {
            result.problems.push({ path: at, code: 'group' });
          }
        }
        for (const key of Object.keys(mine)) {
          if (!skip(path, key) && !Object.hasOwn(reference, key)) result.extra.push(join(path, key));
        }
      };
      if (isObject(english) && isObject(pack)) walk(english, pack, '');
      return result;
    }
  };

  ROOT.PackRules = PackRules;
})();
