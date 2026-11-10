/*!
 * @file        language/language-manager.js
 * @description Language packs, lookup and formatting for every user-facing string
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
  const C = ROOT.CAMConfig.constants;
  const debugState = ROOT.CAMConfig.defaults.debug;
  const BASE_LOCALE = 'en';
  const PSEUDO_LOCALE = 'en-XA';
  const { FILL, SLOT } = ROOT.PackRules;
  // html(): the only tags a string may carry into innerHTML.
  const HTML_TAG = /&#60;(\/?)(strong|em|code)&#62;|&#60;br\/?&#62;/g;
  const escapeHTML = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  // en-XA keeps tokens and slot tags intact and accents every letter.
  const PSEUDO_KEEP = /(\{\w+(?::[^{}]+)?\}|<\/?\w+\/?>)|[A-Za-z]/g;
  const PSEUDO_PLAIN = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'];
  const PSEUDO_ACCENTED = [...'áƀçðéƒĝĥíĵķļɱñóþǫŕšţúṽŵẋýžÅƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞǪŔŠŢÚṼŴẊÝŽ'];
  const PSEUDO_MAP = Object.fromEntries(PSEUDO_PLAIN.map((c, i) => [c, PSEUDO_ACCENTED[i]]));

  /**
   * Main-thread only, published as the `i18n` singleton. Engine and worker
   * code never call it: they hand the UI message descriptors { key, values },
   * which format() words where they are shown. File text (G-code and SVG
   * comments) is read with t() like any other string.
   *
   * Every lookup walks the locale chain (requested locale, its sibling, its
   * base language, English) and, inside each locale, tries apps.<app>.<key>
   * before <key>. A key a translation lacks shows English; a key English
   * lacks is a defect, shown as the raw key and logged as an error.
   */
  class LanguageManager {
    constructor() {
      this.locale = BASE_LOCALE;
      this.chain = [BASE_LOCALE];
      this.packs = new Map();
      this.app = null;
      this.context = {};
      this.reported = new Set();
      this.intl = new Map();
      // False until init() has loaded a locale chain; see template().
      this.ready = false;
      if (typeof EMBEDDED_LANGUAGE !== 'undefined') this.packs.set(BASE_LOCALE, EMBEDDED_LANGUAGE);
      // The custom pack, kept by CustomFiles in its one slot: listed beside
      // the shipped packs and read from storage instead of fetched.
      this.custom = new Map();
      const record = ROOT.CustomFiles?.slot('language');
      if (record && this.isShipped(record.id)) {
        // A shipped pack took its tag: the stored copy can never load.
        ROOT.CustomFiles.discard('language', record.id);
      } else if (record) {
        this.custom.set(record.id, record.data);
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Loading
    // ────────────────────────────────────────────────────────────────────

    /**
     * Resolves the requested locale and makes it current. Throws when a
     * pack fails to load: English is embedded in dist and every listed
     * pack ships, so a failure is a defect.
     */
    async init() {
      await this.use(this.requestedLocale());
      // The custom pack stays while it is the language chosen: a load that
      // finds another choice deletes it.
      const saved = this.saved();
      for (const locale of [...this.custom.keys()]) {
        if (locale === saved) continue;
        this.unregister(locale);
        ROOT.CustomFiles?.discard('language', locale);
      }
      this.ready = true;
    }

    /**
     * Loads a locale's chain, then makes it the one every lookup walks and
     * stamps <html lang dir>. Nothing changes until every pack is in.
     * @param {string} locale
     */
    async use(locale) {
      const chain = this.chainFor(locale);
      for (let i = 0; i < chain.length; i++) {
        const pack = await this.loadPack(chain[i]);
        // A regional pack may name a sibling to try before the bare
        // language, e.g. pt-BR -> pt-PT.
        const sibling = pack.meta?.fallback;
        if (sibling && !chain.includes(sibling) && this.isListed(sibling)) chain.splice(i + 1, 0, sibling);
      }
      this.chain = chain;
      this.locale = chain[0];
      document.documentElement.lang = this.locale;
      // Right-to-left is out of scope until a pack needs it: dir is
      // stamped, but no stylesheet has direction-aware rules yet.
      document.documentElement.dir = this.packs.get(this.locale).meta.dir;
      this.debug(`Locale '${this.locale}', chain ${chain.join(' > ')}`);
    }

    /**
     * ?lang= wins and is remembered, then removed from the address bar;
     * otherwise the saved choice; otherwise English.
     */
    requestedLocale() {
      const url = new URL(location.href);
      const wanted = url.searchParams.get('lang');
      const fromUrl = wanted === null ? null : this.match(wanted);
      if (wanted !== null && !fromUrl) console.warn(`[Lang] '${wanted}' is not in CAMConfig.constants.languages`);
      if (!fromUrl) return this.match(this.saved()) || BASE_LOCALE;
      // The pseudo-locale is a per-visit test mode: never saved, and it
      // stays in the address bar.
      if (fromUrl !== PSEUDO_LOCALE) {
        this.save(fromUrl);
        url.searchParams.delete('lang');
        history.replaceState(history.state, '', url);
      }
      return fromUrl;
    }

    saved() {
      try {
        return localStorage.getItem(C.storageKeys.language);
      } catch {
        return null; // Storage blocked (private mode, sandboxed frame)
      }
    }

    save(locale) {
      try {
        localStorage.setItem(C.storageKeys.language, locale);
      } catch {
        // Storage blocked: the choice lasts for this page load only.
      }
    }

    /**
     * The shipped locale for a language tag: the tag itself when listed,
     * else the first listed locale of the same language (pt -> pt-PT).
     * @param {string|null} tag
     * @returns {string|null}
     */
    match(tag) {
      if (!tag) return null;
      let canonical;
      try {
        canonical = Intl.getCanonicalLocales(tag)[0];
      } catch {
        return null; // Not a well-formed language tag
      }
      if (canonical === PSEUDO_LOCALE || this.isListed(canonical)) return canonical;
      const language = canonical.split('-')[0];
      return [...Object.keys(C.languages), ...this.custom.keys()].find(code => code.split('-')[0] === language) ?? null;
    }

    /**
     * What a language picker offers, as [locale, name in that language]:
     * every listed pack, plus the pseudo-locale under debug or while it is
     * active.
     * @returns {Array<[string, string]>}
     */
    available() {
      const entries = [...Object.entries(C.languages), ...[...this.custom].map(([locale, pack]) => [locale, pack.meta.name])];
      if (debugState.enabled || this.locale === PSEUDO_LOCALE) entries.push([PSEUDO_LOCALE, 'Pseudo (en-XA)']);
      return entries;
    }

    isListed(locale) {
      return locale === BASE_LOCALE || Object.hasOwn(C.languages, locale) || this.custom.has(locale);
    }

    /** A pack that ships with the app: English, the pseudo-locale and every locale CAMConfig lists. */
    isShipped(locale) {
      return locale === BASE_LOCALE || locale === PSEUDO_LOCALE || Object.hasOwn(C.languages, locale);
    }

    /**
     * Offers a pack from a custom file in the language list. A new copy
     * of a pack the page uses takes over at once.
     * @param {Object} pack - a checked language file
     */
    async register(pack) {
      const locale = pack.meta.locale;
      this.custom.set(locale, pack);
      if (!this.packs.has(locale)) return;
      this.packs.set(locale, pack);
      if (this.chain.includes(locale)) await this.setLocale(this.locale);
    }

    /**
     * Withdraws a custom pack from the language list. When the chain
     * holds it, moving the page off it is the caller's.
     * @param {string} locale
     */
    unregister(locale) {
      this.custom.delete(locale);
      this.packs.delete(locale);
    }

    chainFor(locale) {
      const chain = [locale];
      const base = locale.split('-')[0];
      if (base !== locale && this.isListed(base)) chain.push(base);
      if (!chain.includes(BASE_LOCALE)) chain.push(BASE_LOCALE);
      return chain;
    }

    async loadPack(locale) {
      if (this.packs.has(locale)) return this.packs.get(locale);
      let pack;
      if (this.custom.has(locale)) {
        pack = this.custom.get(locale);
      } else if (locale === PSEUDO_LOCALE) {
        const english = await this.loadPack(BASE_LOCALE);
        pack = { ...this.pseudo(english), meta: { ...english.meta, locale } };
      } else {
        const response = await fetch(`../language/${locale}.json`);
        if (!response.ok) throw new Error(`[Lang] language/${locale}.json: HTTP ${response.status}`);
        pack = await response.json();
      }
      this.packs.set(locale, pack);
      return pack;
    }

    /**
     * Switches the interface language in place: loads the chain, rewords
     * the static markup and dispatches 'localechange' on window, where
     * each owner of script-built text renders it again. The choice is
     * saved; the pseudo-locale, a per-visit test mode, goes into the
     * address bar instead.
     * @param {string} locale
     */
    async setLocale(locale) {
      await this.use(locale);
      const url = new URL(location.href);
      url.searchParams.delete('lang');
      if (locale === PSEUDO_LOCALE) url.searchParams.set('lang', PSEUDO_LOCALE);
      else this.save(locale);
      history.replaceState(history.state, '', url);
      this.applyStaticText();
      window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: this.locale } }));
    }

    /** Scopes lookups to apps.<id> overrides and fills {app} in every string. */
    setApp(appName) {
      this.app = String(appName).toLowerCase().replace(/[^a-z0-9]/g, '');
      this.context.app = appName;
    }

    // ────────────────────────────────────────────────────────────────────
    // Lookup
    // ────────────────────────────────────────────────────────────────────

    /**
     * A key is a dotted path, or an array of segments when a segment can
     * itself contain a dot: option values such as '2.5d', unit ids.
     */
    segments(key) {
      return Array.isArray(key) ? key.map(String) : String(key).split('.');
    }

    keyName(key) {
      return Array.isArray(key) ? key.join('.') : String(key);
    }

    /** Own properties only, so a key like "toString" misses. */
    resolveIn(node, parts) {
      for (const part of parts) {
        if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return undefined;
        node = node[part];
      }
      return node;
    }

    /** @returns {{value: *, locale: string}|null} the first hit along the chain */
    lookup(key) {
      const parts = this.segments(key);
      // An empty string is no translation: the chain goes on to English.
      const found = value => value !== undefined && !ROOT.PackRules.isBlank(value);
      for (const locale of this.chain) {
        const pack = this.packs.get(locale);
        if (this.app) {
          const scoped = this.resolveIn(pack.apps?.[this.app], parts);
          if (found(scoped)) return { value: scoped, locale };
        }
        const value = this.resolveIn(pack, parts);
        if (found(value)) return { value, locale };
      }
      return null;
    }

    /** For optional variants a pack may define, such as artifacts.<a>.label3d. */
    has(key) {
      return this.ready && this.lookup(key) !== null;
    }

    /**
     * The string for `key`: its plural form picked by values.count, its
     * {tokens} filled from `values`, then from the app context.
     * @param {string|string[]} key
     * @param {Object|null} [values]
     * @returns {string}
     */
    t(key, values = null) {
      return this.fill(this.template(key, values), values, String, key);
    }

    /**
     * t() against the English pack alone, nested descriptors, plurals and lists included: the
     * file text a machine reads (GCodeGenerator.generate).
     */
    english(key, values = null) {
      const { chain, locale } = this;
      this.chain = [BASE_LOCALE];
      this.locale = BASE_LOCALE;
      try {
        return this.t(key, values);
      } finally {
        this.chain = chain;
        this.locale = locale;
      }
    }

    /**
     * The same string as markup, for code that builds innerHTML: text and
     * values are escaped; the string's <strong>, <em>, <code> and <br/>
     * survive. Everything else uses t().
     */
    html(key, values = null) {
      const markup = escapeHTML(this.template(key, values))
        .replace(HTML_TAG, (match, close, tag) => tag ? `<${close}${tag}>` : '<br>');
      return this.fill(markup, values, escapeHTML, key);
    }

    /** The string for `key` before its {tokens} are filled. */
    template(key, values) {
      // Before init() no pack is loaded (source has not even English), so
      // every key would read as missing; dist would answer from the
      // embedded pack. Refusing in both keeps the two builds alike.
      if (!this.ready) {
        this.fail('used before init()', key);
        return this.keyName(key);
      }
      const hit = this.lookup(key);
      if (!hit) {
        this.fail('missing', key);
        return this.keyName(key);
      }
      let text = hit.value;
      if (ROOT.PackRules.isPlural(text)) {
        text = this.pickPlural(text, values?.count, hit.locale, key);
      }
      if (typeof text !== 'string') {
        this.fail('not text', key);
        return this.keyName(key);
      }
      if (hit.locale === BASE_LOCALE && this.locale !== BASE_LOCALE) this.note('untranslated', key);
      return text;
    }

    /**
     * Words anything a sink may receive: a final string, a number, a
     * descriptor { key, values }, a list { list, type } ('conjunction' or
     * 'unit'), or an Error carrying a descriptor as `.i18n`. An Error
     * without one is a programming fault and shows its own message.
     */
    format(message) {
      if (message === null || message === undefined) return '';
      if (typeof message === 'string') return message;
      if (typeof message === 'number') return this.number(message);
      if (message instanceof Error) return message.i18n ? this.format(message.i18n) : message.message;
      if (Array.isArray(message.list)) return this.list(message.list.map(v => this.format(v)), message.type);
      return this.t(message.key, message.values);
    }

    // ────────────────────────────────────────────────────────────────────
    // Formatting
    // ────────────────────────────────────────────────────────────────────

    pickPlural(forms, count, locale, key) {
      if (typeof count !== 'number') {
        this.fail('plural without a numeric count', key);
        return forms.other;
      }
      if (count === 0 && forms.zero) return forms.zero;
      // A category the pack leaves out or empty shows other.
      return forms[this.intlFor('plural', locale).select(count)] || forms.other;
    }

    /**
     * Fills {tokens}. Numbers go through number(), arrays become "and" lists, descriptors and
     * lists are worded, strings are used as given, and a {name:unit} token writes the result
     * through quantities.<unit> {{name}} is a literal: it prints {name} and takes no value, for
     * text that names a token the operator types. html() passes its escaper so values arrive escaped.
     */
    fill(text, values, encode, key) {
      if (!text.includes('{')) return text;
      return text.replace(FILL, (token, literal, name, unit) => {
        if (literal) return encode(`{${literal}}`);
        const value = values && Object.hasOwn(values, name) ? values[name] : this.context[name];
        if (value === undefined || value === null) {
          this.fail(`no value for {${name}}`, key);
          return token;
        }
        let worded;
        if (typeof value === 'number') worded = this.number(value);
        else if (Array.isArray(value)) worded = this.list(value.map((v) => this.format(v)));
        else if (typeof value === 'object') worded = this.format(value);
        else worded = String(value);
        // quantities.<unit> holds {value} and nothing else ("{value}mm"), so spacing
        // and spelling change once per unit and language.
        return encode(unit
          ? this.template(['quantities', unit], null).replace('{value}', () => worded)
          : worded);
      });
    }

    /**
     * Every number on screen: '.' decimal, no grouping, at most six
     * decimals with trailing zeros dropped. A value that must show a fixed
     * precision arrives as a toFixed() string and is used as given.
     */
    number(value) {
      const text = value.toFixed(6).replace(/\.?0+$/, '');
      return text === '-0' ? '0' : text;
    }

    /** 'conjunction' joins prose ("a, b and c"); 'unit' joins values ("a, b, c" in English). */
    list(items, type = 'conjunction') {
      return this.intlFor('list', this.locale, type).format(items.map(String));
    }

    /** 24-hour HH:MM:SS, as the status log shows it. */
    time(date = new Date()) {
      return date.toTimeString().slice(0, 8);
    }

    intlFor(kind, locale, type = null) {
      const id = `${kind}|${locale}|${type}`;
      let instance = this.intl.get(id);
      if (!instance) {
        instance = kind === 'plural' ? new Intl.PluralRules(locale) : new Intl.ListFormat(locale, { type });
        this.intl.set(id, instance);
      }
      return instance;
    }

    /**
     * en-XA, the pseudo-locale (?lang=en-XA): every string accented,
     * bracketed and padded by about a third. Text still plain on screen
     * bypasses the pack; clipped brackets show a layout too tight for
     * longer languages. File text stays English.
     */
    pseudo(node, path = '') {
      if (typeof node === 'string') {
        const body = node.replace(PSEUDO_KEEP, (match, keep) => keep ?? PSEUDO_MAP[match]);
        return `[${body}${'~'.repeat(Math.ceil(node.length / 3))}]`;
      }
      if (node === null || typeof node !== 'object') return node;
      // File text is the root output section and its apps.<app> mirror,
      // not every key that happens to be named output.
      const isFileText = k => k === 'output' && (path === '' || /^apps\.[^.]+$/.test(path));
      return Object.fromEntries(Object.entries(node).map(([k, v]) =>
        [k, isFileText(k) ? v : this.pseudo(v, path ? `${path}.${k}` : k)]));
    }

    // ────────────────────────────────────────────────────────────────────
    // Static markup
    // ────────────────────────────────────────────────────────────────────

    /**
     * Applies the pack to static markup, <template> contents included:
     *   data-i18n="key"                             sets the text
     *   data-i18n-attr="title:key;aria-label:key"   sets each attribute
     * The markup's own English is authoring text and is always replaced.
     * An element with child elements is translated only when every child
     * is a data-i18n-slot (see fillSlots). data-i18n-help tooltips are
     * attached by BaseAppUI.initStaticTooltips.
     */
    applyStaticText(root = document) {
      for (const el of root.querySelectorAll('[data-i18n]')) {
        if (el.firstElementChild) this.fillSlots(el, el.dataset.i18n);
        else el.textContent = this.t(el.dataset.i18n);
      }
      for (const el of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.split(';')) {
          const [attr, key] = pair.split(':').map(s => s.trim());
          el.setAttribute(attr, this.t(key));
        }
      }
      for (const template of root.querySelectorAll('template')) {
        this.applyStaticText(template.content);
      }
    }

    /**
     * Rebuilds a sentence around its child elements, which keep their
     * attributes and listeners. In the string, <name>words</name> puts the
     * words inside the child marked data-i18n-slot="name", and <name/>
     * moves that child as it is. A string whose tags do not match the
     * slots one to one is a pack defect: it is logged and the markup is
     * left as it is, since rebuilding would drop the children.
     */
    fillSlots(el, key) {
      const slots = new Map();
      for (const child of el.children) {
        const name = child.dataset.i18nSlot;
        if (!name || slots.has(name)) {
          this.fail('child without a unique data-i18n-slot', key);
          return;
        }
        slots.set(name, child);
      }

      // Tags are read before {tokens} are filled, so a value can never
      // pose as a slot.
      const text = this.template(key, null);
      const parts = [];
      const used = new Set();
      let last = 0;
      for (const m of text.matchAll(SLOT)) {
        const name = m[1] ?? m[3];
        const slot = slots.get(name);
        if (!slot || used.has(name) || (m[2] !== undefined && slot.firstElementChild)) {
          this.fail('slots', key);
          return;
        }
        used.add(name);
        parts.push(this.fill(text.slice(last, m.index), null, String, key), { slot, words: m[2] });
        last = m.index + m[0].length;
      }
      if (used.size !== slots.size) {
        this.fail('slots', key);
        return;
      }
      parts.push(this.fill(text.slice(last), null, String, key));

      el.replaceChildren(...parts.map(part => {
        if (typeof part === 'string') return part;
        if (part.words !== undefined) part.slot.textContent = this.fill(part.words, null, String, key);
        return part.slot;
      }));
    }

    // ────────────────────────────────────────────────────────────────────
    // Diagnostics
    // ────────────────────────────────────────────────────────────────────

    /**
     * A pack or code defect: logged as an error once per key, debug or not.
     * `i18n.reported` is the running list of everything fail() and note()
     * have seen.
     */
    fail(kind, key) {
      const id = `${kind}: ${this.keyName(key)}`;
      if (this.reported.has(id)) return;
      this.reported.add(id);
      console.error(`[Lang] ${id}`);
    }

    /** Not a defect, e.g. a translation still in progress: logged while debug is on. */
    note(kind, key) {
      const id = `${kind}: ${this.keyName(key)}`;
      if (this.reported.has(id)) return;
      this.reported.add(id);
      if (debugState.enabled) console.warn(`[Lang] ${id}`);
    }

    debug(message, data = null) {
      if (!debugState.enabled) return;
      data ? console.log(`[LanguageManager] ${message}`, data)
           : console.log(`[LanguageManager] ${message}`);
    }
  }

  ROOT.i18n = new LanguageManager();
})();