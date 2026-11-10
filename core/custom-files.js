/*!
 * @file        core/custom-files.js
 * @description Custom files: themes, language packs, post-processors, laser profiles and tool libraries a user adds as JSON.
 *              Each is checked by core/file-rules.js, put in use, then stored, one per kind
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
  const { read, shown, join, typeMatches } = ROOT.FileRules;

  // Held in a constant, not written into fetch(): build.js embeds the rules
  // in dist, deletes the file, and checks every fetch('…json') literal.
  const RULES_URL = '../core/file-validation.json';
  const PREFIX = `${C.storageKeys.custom}:`;
  // Keys a missing or extra list names before it ends in an ellipsis; the
  // console gets the whole list.
  const LIST_LIMIT = 12;
  const HEX = /^#[0-9a-f]{6}$/i;
  const COLOR_FUNCTION = /^(rgb|hsl)a?\(/i;
  // What a theme token may not contain: anything that loads a resource.
  const LOADS = /url\(|image-set\(|image\(|element\(|@import|expression\(/i;
  // The kinds restored here. Themes and language packs are read by their
  // owners as they load, before the app starts (theme-loader.js,
  // language-manager.js).
  const RESTORED = ['setup', 'laserProfile', 'toolLibrary'];
  // The setting that picks the device of each kind.
  const CHOICE = { setup: 'gcode.postProcessor', laserProfile: 'laser.activeProfile' };
  // A fault in the checker, not in the file: a stored file it stops is kept.
  const CHECK_FAILED = 'customFiles.problems.checkFailed';
  // Problems a shipped file has by design: shipped ids are stored in
  // settings and may predate the custom-id pattern (xtoolstudio), and a
  // shipped pack's tag is a shipped one.
  const SHIPPED_EXEMPT = new Set(['customFiles.problems.pattern.id', 'customFiles.problems.format.shippedLocale']);

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

  // The rules' format checks: each needs the page (CSS, the DOM, the language list).
  const FORMATS = {
    color(value, fail) {
      if (!CSS.supports('color', value)) fail('format.color', { value });
    },

    cssValue(value, fail) {
      if (LOADS.test(value)) fail('format.cssValue');
    },

    declaredProperty(value, fail) {
      if (getComputedStyle(document.documentElement).getPropertyValue(`--${value}`) === '') {
        fail('format.declaredProperty', { value });
      }
    },

    customLocale(value, fail) {
      let canonical = null;
      try {
        canonical = Intl.getCanonicalLocales(value)[0];
      } catch {
        // Not a well-formed language tag
      }
      // The tag is the pack's id and its storage key, so it is kept in the
      // one form match() resolves to.
      if (canonical === null) fail('format.locale', { value });
      else if (canonical !== value) fail('format.localeForm', { value, canonical });
      else if (ROOT.i18n.isShipped(value)) fail('format.shippedLocale', { value });
    },

    // A shipped pack only: the one custom pack's fallback could name no
    // other custom pack than the one it replaces.
    listedLocale(value, fail) {
      if (!Object.hasOwn(C.languages, value)) fail('format.listedLocale', { value });
    }
  };

  class CustomFiles {
    /**
     * @param {CamCore} core - with its post-processors, laser profiles and tool library in
     *  place: the ids they hold now are the built-ins.
     * @param {{onToolLibraryChange?: (previous: Map<string, Object>) => number}} [hooks] -
     *  called after the tool library is swapped, with the replaced library's tools by id;
     *  returns how many operations it marked for regeneration
     */
    constructor(core, hooks = {}) {
      this.core = core;
      this.rules = null;
      this.engine = null;
      this.builtIn = { setup: new Set(C.setups), laserProfile: new Set(C.laserProfiles) };
      // The file each entry register() put in place came from, by `kind:id`.
      this.registered = new Map();
      this.onToolLibraryChange = hooks.onToolLibraryChange ?? null;
    }

    /** Custom files travel as .json; geometry files never do. */
    static accepts(file) {
      return /\.json$/i.test(file.name);
    }

    /**
     * Whether a JSON file says it is a custom file. Asked of a batch that
     * brings other files too: a project folder can hold JSON of its own
     * (an EDA source, a package.json) that is none of this importer's
     * business and goes on with the geometry, to be counted as skipped.
     * An oversized file is only sniffed, never parsed, so importFiles can
     * refuse it as too large instead of it being counted as skipped.
     * @param {File} file
     * @returns {Promise<boolean>}
     */
    async declares(file) {
      await this.load();
      if (!CustomFiles.accepts(file)) return false;
      if (file.size > this.rules.maxBytes) {
        return /"meta"\s*:\s*\{[^{}]*"kind"\s*:/.test(await file.slice(0, 4096).text());
      }
      try {
        const data = JSON.parse(await file.text());
        return isObject(data) && isObject(data.meta) && typeof data.meta.kind === 'string';
      } catch {
        return false;
      }
    }

    /**
     * The stored records of one kind. A record that does not parse is
     * skipped: importing the file again replaces it.
     * @param {string} kind
     * @returns {Array<{key: string, id: string, source: string, importedAt: string, data: Object}>}
     */
    static stored(kind) {
      const prefix = `${PREFIX}${kind}:`;
      const records = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(prefix)) continue;
          try {
            const record = JSON.parse(localStorage.getItem(key));
            if (isObject(record?.data)) records.push({ ...record, key, id: key.slice(prefix.length) });
          } catch {
            // Unreadable record
          }
        }
      } catch {
        // Storage blocked (private mode, sandboxed frame)
      }
      return records;
    }

    /**
     * The one stored record of a kind, or null, read synchronously so the
     * theme and language owners can register theirs while they load.
     * Storage holds more only when two tabs imported at once: the newest
     * stays and the rest go.
     * @param {string} kind
     * @returns {?Object} a record as stored() gives it
     */
    static slot(kind) {
      const [newest = null, ...older] = CustomFiles.stored(kind)
        .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
      for (const record of older) CustomFiles.discard(kind, record.id);
      return newest;
    }

    /**
     * Deletes a stored record. Static for the theme and language owners,
     * which delete theirs as they load once it is no longer the one chosen.
     * @param {string} kind
     * @param {string} id
     */
    static discard(kind, id) {
      try {
        localStorage.removeItem(`${PREFIX}${kind}:${id}`);
      } catch {
        // Storage blocked: nothing was stored to delete
      }
    }

    /** The rules: embedded by build.js in dist, fetched in source. */
    async load() {
      if (this.rules) return this.rules;
      let rules;
      if (typeof EMBEDDED_FILE_VALIDATION !== 'undefined') {
        rules = EMBEDDED_FILE_VALIDATION;
      } else {
        const response = await fetch(RULES_URL);
        if (!response.ok) throw new Error(`[CustomFiles] ${RULES_URL}: HTTP ${response.status}`);
        rules = await response.json();
      }
      // Callers that waited on the same fetch set up once.
      if (!this.rules) {
        this.rules = rules;
        this.engine = new ROOT.FileRules(rules, {
          formats: FORMATS,
          references: {
            theme: (value, path, ctx) => this.compareTheme(value, path, ctx),
            language: (value, path, ctx) => this.compareLanguage(value, ctx)
          },
          logic: {
            definition: name => ROOT.PostLogic.get(name)?.setupSchema ?? null,
            names: () => [...ROOT.PostLogic.keys()]
          }
        });
      }
      return this.rules;
    }

    // ────────────────────────────────────────────────────────────────────
    // Startup
    // ────────────────────────────────────────────────────────────────────

    /**
     * Debug only: the rules pass their lint, and every shipped setup, laser
     * profile and language pack passes the checks a custom copy of it must,
     * so a rule, flag or en.json change that breaks one shows here, not as
     * a user's refused file.
     */
    async checkShipped() {
      await this.load();
      for (const fault of this.engine.lint(ROOT.i18n.packs.get('en'))) console.error(`[CustomFiles] Rules: ${fault}`);
      const shipped = [
        ...C.setups.map(id => ['setup', id, () => this.core.gcodeGenerator.setups.get(id)]),
        ...C.laserProfiles.map(id => ['laserProfile', id, () => this.core.graphicsExporter.getProfileInfo(id)]),
        ...Object.keys(C.languages).filter(locale => locale !== 'en').map(locale => ['language', locale, () => ROOT.i18n.loadPack(locale)])
      ];
      for (const [kind, id, get] of shipped) {
        try {
          const { problems, notes } = await this.check(kind, await get());
          for (const problem of problems) {
            if (!SHIPPED_EXEMPT.has(problem.key)) console.error(`[CustomFiles] ${kind} ${id}:`, problem.key, problem.values ?? '');
          }
          for (const note of notes) this.debug(`${kind} ${id}: ${note.key}`, note.values ?? null);
        } catch (error) {
          console.error(`[CustomFiles] ${kind} ${id} could not be checked:`, error);
        }
      }
    }

    /**
     * Registers the stored post-processor, laser profile and tool library.
     * Each is checked again: the rules can change between versions, and
     * these kinds decide what reaches the machine. A file the rules now
     * refuse would be refused at every start, so it is deleted, with a
     * note; one the app failed on is kept for the next start. Runs after
     * the built-ins exist and before loadSettings, which seeds each
     * registered device's settings.
     * @returns {Promise<Object[]>} notes for the startup status line
     */
    async restore() {
      const notes = [];
      try {
        await this.load();
      } catch (error) {
        console.error(error);
        return [{ key: 'customFiles.restore.noRules' }];
      }
      for (const kind of RESTORED) {
        const record = CustomFiles.slot(kind);
        if (!record) continue;
        const named = { kind: { key: `customFiles.kinds.${kind}` }, id: record.id };
        if (this.isBuiltIn(kind, record.id)) {
          CustomFiles.discard(kind, record.id);
          notes.push({ key: 'customFiles.restore.superseded', values: named });
          continue;
        }
        const checked = await this.check(kind, record.data);
        let fault = checked.problems.find(problem => problem.key === CHECK_FAILED) ?? null;
        if (!fault && checked.problems.length > 0) {
          CustomFiles.discard(kind, record.id);
          notes.push({ key: 'customFiles.restore.refused', values: { ...named, reason: checked.problems[0], count: checked.problems.length } });
          continue;
        }
        if (!fault) {
          try {
            await this.register(kind, checked.entry, record.source);
          } catch (error) {
            // One stored file that fails to register must not end the start.
            console.error(`[CustomFiles] Restoring ${kind} ${record.id} failed:`, error);
            this.registered.delete(`${kind}:${checked.entry.id}`);
            fault = { key: 'customFiles.problems.registerFailed', values: { error: error.message } };
          }
        }
        if (fault) notes.push({ key: 'customFiles.restore.failed', values: { ...named, reason: fault } });
      }
      this.debug(`Restored custom files, ${notes.length} note(s)`);
      return notes;
    }

    /**
     * Startup notes for a stored post or laser profile choice that is not
     * registered - a custom file that did not restore, cleared storage -
     * and so resolved past for this session. Storage keeps the choice: it
     * returns with its device.
     * @returns {Object[]} notes for the startup status line
     */
    reconcile() {
      const notes = [];
      const check = (path, kind) => {
        const id = read(this.core.userSettings, path);
        if (id === undefined || this.core.settingSources[path] === 'user') return;
        notes.push({
          key: 'customFiles.restore.fallback',
          values: { kind: { key: `customFiles.kinds.${kind}` }, id: String(id), fallback: read(this.core.settings, path) }
        });
      };
      check(CHOICE.setup, 'setup');
      check(CHOICE.laserProfile, 'laserProfile');
      return notes;
    }

    // ────────────────────────────────────────────────────────────────────
    // Import
    // ────────────────────────────────────────────────────────────────────

    /**
     * Takes the custom files out of a batch and imports them. A batch of
     * JSON only is all custom files; in a mixed batch only JSON that
     * declare meta.kind are taken: a project folder can hold JSON of its
     * own (an EDA source, a package.json) that goes on with the geometry,
     * to be counted as skipped.
     * @param {File[]} files
     * @returns {Promise<{results: Object[], rest: File[]}>} results as importFiles gives them
     */
    async take(files) {
      let custom = files.filter(file => CustomFiles.accepts(file));
      if (custom.length < files.length) {
        const declared = await Promise.all(custom.map(file => this.declares(file)));
        custom = custom.filter((file, i) => declared[i]);
      }
      return {
        results: custom.length > 0 ? await this.importFiles(custom) : [],
        rest: files.filter(file => !custom.includes(file))
      };
    }

    /**
     * Checks, puts in use and stores each file, in order: one slot per
     * kind, so a later file of a kind replaces an earlier one. A file with
     * any problem is refused whole: nothing of it is used or stored.
     * @param {File[]} files
     * @returns {Promise<Array<{source: string, kind: string|null,
     *  entry: ?{id: string, label: string, replaced: boolean, previous: ?string},
     *  problems: Object[], notes: Object[]}>>} one result per file; entry is null for a
     *  refused file, replaced marks a new copy of the same entry, previous names the one
     *  it displaced; problems and notes are message descriptors
     */
    async importFiles(files) {
      await this.load();
      const results = [];
      for (const file of files) results.push(await this.importFile(file));
      return results;
    }

    async importFile(file) {
      const result = { source: file.name, kind: null, entry: null, problems: [], notes: [] };
      const refuse = (code, values = {}) => {
        result.problems.push({ key: `customFiles.problems.${code}`, values });
        return result;
      };
      if (file.size > this.rules.maxBytes) {
        return refuse('tooLarge', { size: Math.ceil(file.size / 1024), max: this.rules.maxBytes / 1024 });
      }
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch (error) {
        return refuse('json', { error: error.message });
      }
      const kind = isObject(data) && isObject(data.meta) ? data.meta.kind : undefined;
      if (!Object.hasOwn(this.rules.kinds, kind ?? '')) {
        const kinds = { list: Object.keys(this.rules.kinds), type: 'unit' };
        return kind === undefined ? refuse('kindMissing', { kinds }) : refuse('kind', { kind: shown(kind), kinds });
      }
      result.kind = kind;
      const { entry, problems, notes } = await this.check(kind, data);
      result.notes.push(...notes);
      if (this.isBuiltIn(kind, entry.id)) {
        problems.push({ key: 'customFiles.problems.builtIn', values: { id: entry.id, kind: { key: `customFiles.kinds.${kind}` } } });
      }
      if (problems.length > 0) {
        result.problems.push(...problems);
        return result;
      }
      // One slot per kind: whatever held it leaves once this file is in use.
      const held = this.occupants(kind);
      const previous = held.filter(id => id !== entry.id);
      const stored = CustomFiles.stored(kind);
      let invalidated;
      try {
        invalidated = await this.register(kind, entry, file.name);
        for (const id of previous) this.evict(kind, id, entry.id);
      } catch (error) {
        console.error(`[CustomFiles] Putting ${file.name} in use failed:`, error);
        return refuse('registerFailed', { error: error.message });
      }
      // In use before stored: a file the browser cannot keep still works
      // until the page closes.
      for (const record of stored) CustomFiles.discard(kind, record.id);
      try {
        localStorage.setItem(`${PREFIX}${kind}:${entry.id}`, JSON.stringify({ source: file.name, importedAt: new Date().toISOString(), data }));
      } catch (error) {
        result.notes.push({ key: 'customFiles.notes.notStored', values: { error: error.message } });
      }
      if (invalidated > 0) result.notes.push({ key: 'messages.operations.toolsChanged', values: { count: invalidated } });
      result.entry = { id: entry.id, label: entry.label ?? file.name, replaced: held.includes(entry.id), previous: previous[0] ?? null };
      this.debug(`Imported ${kind} ${entry.id} from ${file.name}${previous.length > 0 ? `, in place of ${previous.join(', ')}` : ''}`);
      return result;
    }

    /**
     * The custom entries of a kind in use now: the slot, so one at most.
     * Read from the owners rather than storage, which may be blocked.
     * @param {string} kind
     * @returns {string[]} ids; the tool library's is 'library'
     */
    occupants(kind) {
      const custom = (ids, builtIn) => ids.filter(id => !builtIn.has(id));
      switch (kind) {
        case 'theme':
          return custom(ROOT.ThemeLoader.list().map(theme => theme.id), ROOT.ThemeLoader.builtIn);
        case 'language':
          return [...ROOT.i18n.custom.keys()];
        case 'setup':
          return custom(this.core.gcodeGenerator.getAllProcessorDescriptors().map(d => d.id), this.builtIn.setup);
        case 'laserProfile':
          return custom(this.core.graphicsExporter.getAllProfileDescriptors().map(d => d.id), this.builtIn.laserProfile);
        case 'toolLibrary':
          return this.registered.has('toolLibrary:library') ? ['library'] : [];
      }
      return [];
    }

    /**
     * Takes an entry a new file displaced out of use. A post or laser
     * profile choice that named it moves to the new entry, which holds the
     * slot now; a theme or language was already replaced on screen by
     * register(). Its storage record is the caller's.
     * @param {string} kind
     * @param {string} id - the displaced entry
     * @param {string} successor - the new entry's id
     */
    evict(kind, id, successor) {
      this.registered.delete(`${kind}:${id}`);
      switch (kind) {
        case 'theme':
          ROOT.ThemeLoader.unregister(id);
          break;
        case 'language':
          ROOT.i18n.unregister(id);
          break;
        case 'setup':
          if (this.chosen(CHOICE.setup, id)) this.core.setSetting(CHOICE.setup, successor);
          this.core.gcodeGenerator.unregister(id);
          break;
        case 'laserProfile':
          if (this.chosen(CHOICE.laserProfile, id)) this.core.setSetting(CHOICE.laserProfile, successor);
          this.core.graphicsExporter.unregisterProfile(id);
          break;
      }
    }

    /**
     * The custom file an entry in use came from, or null for a shipped
     * one: a post or laser profile by its id, the tool library as
     * 'library'.
     * @param {string} kind
     * @param {?string} id
     * @returns {?string} the file's name
     */
    sourceOf(kind, id) {
      return this.registered.get(`${kind}:${id}`) ?? null;
    }

    /**
     * Whether an id is already used by a shipped item of its kind. A
     * language's tag is checked by its format rule instead, and the tool
     * library has a single slot.
     */
    isBuiltIn(kind, id) {
      if (kind === 'theme') return ROOT.ThemeLoader.builtIn.has(id);
      if (kind === 'setup' || kind === 'laserProfile') return this.builtIn[kind].has(id);
      return false;
    }

    /** Whether the operator's choice at `path`, or the value in effect there, is `id`. */
    chosen(path, id) {
      return read(this.core.userSettings, path) === id || read(this.core.settings, path) === id;
    }

    // ────────────────────────────────────────────────────────────────────
    // Checking
    // ────────────────────────────────────────────────────────────────────

    /**
     * Runs one kind's rules over a parsed file (core/file-rules.js), then
     * what the rules file cannot say: a setup against Machine Settings, a
     * tool library through a trial import.
     * @returns {Promise<{entry: {id: string, label: ?string, file: Object},
     *  problems: Object[], notes: Object[]}>}
     */
    async check(kind, data) {
      const ctx = { problems: [], notes: [], reference: null, english: null };
      if (kind === 'theme') {
        try {
          ctx.reference = await ROOT.ThemeLoader.reference();
        } catch (error) {
          ctx.problems.push({ key: 'customFiles.problems.reference.unavailable', values: { error: error.message } });
        }
      }
      if (kind === 'language') ctx.english = ROOT.i18n.packs.get('en');
      try {
        this.engine.check(kind, data, ctx);
        // A broken rule leaves the shape whole, so the setup still builds
        // and the rest is checked too.
        if (kind === 'setup' && ctx.problems.every(problem => problem.key.startsWith('customFiles.rules.'))) this.checkSetup(data, ctx);
      } catch (error) {
        // A fault in the checker refuses this file; it must not end the import or the start.
        console.error(`[CustomFiles] Checking a ${kind} failed:`, error);
        ctx.problems.push({ key: CHECK_FAILED, values: { error: error.message } });
      }
      if (kind === 'toolLibrary' && ctx.problems.length === 0) {
        // A trial import on a scratch library: the live one changes only
        // once the file is in use.
        try {
          const outcome = new ROOT.ToolLibrary().importTools(data);
          for (const failure of outcome.failed) {
            ctx.notes.push({ key: 'customFiles.notes.toolLeftOut', values: { id: failure.id, reason: failure.reason } });
          }
          if (outcome.imported.length === 0) ctx.problems.push({ key: 'customFiles.problems.noTools' });
        } catch (error) {
          ctx.problems.push({ key: 'customFiles.problems.tools', values: { reason: error.i18n ?? error.message } });
        }
      }
      return { entry: this.entryOf(kind, data), problems: ctx.problems, notes: ctx.notes };
    }

    /**
     * What a file stores: itself, under the id its kind names (`x-id`), or
     * 'library' for the one tool library. The label is the entry's own
     * name, or null where the kind has none.
     */
    entryOf(kind, data) {
      const spec = this.rules.kinds[kind];
      const id = spec['x-id'] ? read(data, spec['x-id']) : 'library';
      const label = kind === 'language' ? data.meta?.name : data.label;
      return { id: String(id), label: typeof label === 'string' ? label : null, file: data };
    }

    /**
     * What the rules file cannot say about a setup, checked once its shape
     * passed. Its label is its own: the label names it in the picker, in
     * "Set by" notes and in the program header, so no two setups share
     * one, shipped or custom. Every default and lock names a setting this
     * setup uses - a Machine Settings field other than the post picker
     * and the laser's, or one of its logic's parameters - and holds a
     * value that field accepts: its type and range, one of its options,
     * and for a picker one this setup offers. The fields are the base
     * schema, not this app's: both apps restore the same stored setup, so
     * a field one app's profile removes must not refuse it, and so delete
     * it, there.
     */
    checkSetup(data, ctx) {
      const desc = new (ROOT.PostLogic.get(data.logic))(data).descriptor;
      const label = data.label.trim().toLowerCase();
      for (const other of this.core.gcodeGenerator.getAllProcessorDescriptors()) {
        if (other.id !== data.id && other.label.trim().toLowerCase() === label) {
          ctx.problems.push({ key: 'customFiles.problems.labelTaken', values: { path: 'label', label: data.label, id: other.id } });
        }
      }
      const fields = {};
      for (const [path, def] of Object.entries(ROOT.CAMConfig.machineParameters)) {
        if (def.type && path !== CHOICE.setup && !def.classes?.includes('laser')) {
          fields[path.slice(path.lastIndexOf('.') + 1)] = def;
        }
      }
      for (const parameter of desc.parameters) fields[parameter.name] = parameter;
      const misfit = (def, value, offered) => {
        const type = name => ({ code: 'type', values: { expected: { key: `customFiles.types.${name}` } } });
        switch (def.type) {
          case 'checkbox':
            return typeof value === 'boolean' ? null : type('boolean');
          case 'number':
            if (value === null && def.nullable) return null;
            if (!typeMatches(value, 'number')) return type('number');
            if (def.min !== undefined && value < def.min) return { code: 'minimum', values: { limit: def.min } };
            if (def.max !== undefined && value > def.max) return { code: 'maximum', values: { limit: def.max } };
            return null;
          case 'select': {
            const values = offered ?? def.options.map(option => option.value);
            return values.includes(value) ? null : { code: 'enum', values: { expected: { list: values.map(shown), type: 'unit' } } };
          }
          default:
            return typeof value === 'string' ? null : type('string');
        }
      };
      for (const table of ['defaults', 'locks']) {
        for (const [leaf, value] of Object.entries(data[table])) {
          const path = `${table}.${leaf}`;
          const def = fields[leaf];
          const offered = def?.source ? this.core.offeredValues(def.source, desc) : null;
          if (!def || def.capability && !desc.capabilities[def.capability] || offered?.length === 0) {
            ctx.problems.push({ key: 'customFiles.problems.unused', values: { path } });
            continue;
          }
          const problem = misfit(def, value, offered);
          if (problem) ctx.problems.push({ key: `customFiles.problems.${problem.code}`, values: { path, ...problem.values } });
        }
      }
    }

    /**
     * The theme reference: a theme's colours against a shipped theme's.
     * The same keys, and each value in the form the shipped themes use -
     * 6-digit hex where the reference is hex, an rgb()/hsl() function
     * where it is not (the scrims).
     */
    compareTheme(value, path, ctx) {
      if (!ctx.reference) return;
      if (!isObject(value)) {
        ctx.problems.push({ key: 'customFiles.problems.type', values: { path, expected: { key: 'customFiles.types.object' } } });
        return;
      }
      const expected = this.leaves(ctx.reference.colors);
      const actual = this.leaves(value);
      this.reportKeys([...expected.keys()].filter(key => !actual.has(key)), path, ctx.problems, 'customFiles.problems.reference.missing');
      this.reportKeys([...actual.keys()].filter(key => !expected.has(key)), path, ctx.problems, 'customFiles.problems.reference.extra');
      for (const [key, sample] of expected) {
        if (!actual.has(key)) continue;
        const color = actual.get(key);
        const hex = HEX.test(sample);
        const fits = typeof color === 'string' && (hex ? HEX.test(color) : COLOR_FUNCTION.test(color) && CSS.supports('color', color));
        if (!fits) {
          ctx.problems.push({
            key: hex ? 'customFiles.problems.reference.hex' : 'customFiles.problems.reference.colorFunction',
            values: { path: join(path, key), value: shown(color) }
          });
        }
      }
    }

    /**
     * The language reference: a pack against en.json (PackRules). Each
     * string keeps the English {tokens} and slot tags. A key the pack
     * leaves out shows in English, as in a shipped translation, and a key
     * en.json lacks is ignored: both are noted, neither refuses the pack.
     */
    compareLanguage(pack, ctx) {
      if (!ctx.english) return;
      const result = ROOT.PackRules.comparePack(ctx.english, pack);
      for (const { path, code, expected } of result.problems) {
        switch (code) {
          case 'group':
            ctx.problems.push({ key: 'customFiles.problems.type', values: { path, expected: { key: 'customFiles.types.object' } } });
            break;
          case 'tokens':
            ctx.problems.push({ key: 'customFiles.problems.language.tokens', values: { path, expected: { list: expected, type: 'unit' } } });
            break;
          case 'slots':
            ctx.problems.push({ key: 'customFiles.problems.language.slots', values: { path, expected: { list: expected.map(slot => `<${slot}>`), type: 'unit' } } });
            break;
          default:
            ctx.problems.push({ key: `customFiles.problems.language.${code}`, values: { path } });
        }
      }
      this.reportKeys(result.missing, '/', ctx.notes, 'customFiles.notes.missingKeys');
      this.reportKeys(result.extra, '/', ctx.notes, 'customFiles.notes.extraKeys');
      this.reportKeys(result.pluralForms, '/', ctx.notes, 'customFiles.notes.pluralForms', { forms: { list: result.forms, type: 'unit' } });
    }

    /** Every non-object value under `object`, by dotted path. */
    leaves(object, prefix = '', out = new Map()) {
      for (const [key, value] of Object.entries(object)) {
        const at = join(prefix, key);
        if (isObject(value)) this.leaves(value, at, out);
        else out.set(at, value);
      }
      return out;
    }

    /** One problem or note for a list of keys, shortened; the console gets the whole list. */
    reportKeys(keys, path, sink, key, values = {}) {
      if (keys.length === 0) return;
      const named = keys.length > LIST_LIMIT ? [...keys.slice(0, LIST_LIMIT), '…'] : keys;
      sink.push({ key, values: { path, count: keys.length, keys: { list: named, type: 'unit' }, ...values } });
      if (keys.length > LIST_LIMIT) console.warn(`[CustomFiles] ${key}:\n${keys.join('\n')}`);
    }

    // ────────────────────────────────────────────────────────────────────
    // Registration
    // ────────────────────────────────────────────────────────────────────

    /**
     * Hands a checked entry to the module that owns its kind.
     * @param {string} kind
     * @param {{id: string, file: Object}} entry - as check() gives it
     * @param {string} source - the name of the file it came from
     * @returns {Promise<number>} operations a tool library swap marked for regeneration
     */
    async register(kind, { id, file }, source) {
      const core = this.core;
      this.registered.set(`${kind}:${id}`, source);
      switch (kind) {
        case 'theme':
          // In use as soon as it is added: applied, and saved as the choice.
          ROOT.ThemeLoader.register(id, file);
          await ROOT.ThemeLoader.applyTheme(id);
          return 0;
        case 'language':
          // In use as soon as it is added: the page rewords, and the choice
          // is saved. A new copy of the pack on screen rewords in register().
          await ROOT.i18n.register(file);
          if (ROOT.i18n.locale !== id) await ROOT.i18n.setLocale(id);
          return 0;
        case 'setup': {
          // A custom setup always shows as Custom, whatever maturity the
          // file it was copied from carries.
          const post = core.gcodeGenerator.register({ ...file, maturity: 'custom' });
          // A new copy of the setup in use, or of the one the operator
          // chose before it was available, changes the program at once.
          if (this.chosen(CHOICE.setup, id)) {
            core.store.invalidateIndexedOperations(post.descriptor.label);
            core.commitSettings(CHOICE.setup);
          }
          return 0;
        }
        case 'laserProfile':
          core.graphicsExporter.registerProfile({ ...file, maturity: 'custom' });
          if (this.chosen(CHOICE.laserProfile, id)) core.commitSettings(CHOICE.laserProfile);
          return 0;
        case 'toolLibrary': {
          const previous = core.toolLibrary.toolsById;
          core.toolLibrary.replace(file);
          core.bumpSettingsRevision({ category: 'tools' });
          return this.onToolLibraryChange?.(previous) ?? 0;
        }
      }
      return 0;
    }

    /**
     * Stops using a stored custom file: deletes its record and takes its
     * entry out of use. A setup or laser profile is unregistered, and a
     * choice that named it resolves past it to a built-in one - storage
     * keeps the choice, so importing the file again brings it back, as at
     * startup. The tool library goes back to the built-in one.
     * @param {'setup'|'laserProfile'|'toolLibrary'} kind
     * @param {string} id - 'library' for the tool library
     * @returns {Promise<number>} operations the library swap marked for regeneration
     */
    async remove(kind, id) {
      const core = this.core;
      CustomFiles.discard(kind, id);
      this.registered.delete(`${kind}:${id}`);
      switch (kind) {
        case 'setup':
          core.gcodeGenerator.unregister(id);
          // A choice that named the entry resolves again; any other is left alone.
          if (this.chosen(CHOICE.setup, id)) core.commitSettings(CHOICE.setup);
          return 0;
        case 'laserProfile':
          core.graphicsExporter.unregisterProfile(id);
          if (this.chosen(CHOICE.laserProfile, id)) core.commitSettings(CHOICE.laserProfile);
          return 0;
        case 'toolLibrary': {
          const previous = core.toolLibrary.toolsById;
          await core.toolLibrary.restoreBuiltIn();
          core.bumpSettingsRevision({ category: 'tools' });
          return this.onToolLibraryChange?.(previous) ?? 0;
        }
      }
      return 0;
    }

    debug(message, data = null) {
      if (!debugState.enabled) return;
      data !== null ? console.log(`[CustomFiles] ${message}`, data) : console.log(`[CustomFiles] ${message}`);
    }
  }

  ROOT.CustomFiles = CustomFiles;
})();
