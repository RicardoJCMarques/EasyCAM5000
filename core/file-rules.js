/*!
 * @file        core/file-rules.js
 * @description The custom-file rules engine: checks parsed JSON against core/file-validation.json
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

  // The rules file's _readme: problems are worded from en.json
  // customFiles.problems.*, and a rule's message is customFiles.rules.<id>.
  const PROBLEMS = 'customFiles.problems.';
  const RULES = 'customFiles.rules.';
  const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
  // What an x-rules entry is made of. _keywords names x-rules but not
  // its parts, so the lint takes them from here, beside holds().
  const RULE_KEYS = new Set(['id', 'if', 'then']);
  const CONDITIONS = new Set(['all', 'any', 'not', 'path', 'is', 'isNot', 'hasAny', 'notEmpty', 'isPath', 'inPath', 'atMostPath', 'belowPath']);

  const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const isObject = value => typeOf(value) === 'object';
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  class FileRules {
    /**
     * @param {Object} rules - core/file-validation.json as loaded
     * @param {Object} [hooks] - the checks the rules leave to code
     * @param {Object<string, function(string, function): void>} [hooks.formats] - one per
     *  format name, given the value and fail(code, values)
     * @param {Object<string, function(*, string, Object): void>} [hooks.references] - one per
     *  x-reference name, given the value, its path and the check's context
     * @param {{definition: function(*): ?string, names: function(): string[]}} [hooks.logic] -
     *  the definition a setup's logic is checked against, null for a logic there is not, and
     *  the logics there are
     */
    constructor(rules, { formats = {}, references = {}, logic = null } = {}) {
      this.rules = rules;
      this.formats = formats;
      this.references = references;
      this.logic = logic;
    }

    /**
     * Runs one kind's rules over a parsed file. Every departure is pushed to
     * ctx.problems, so a report lists them all at once.
     * @param {string} kind - a key of rules.kinds
     * @param {*} data
     * @param {Object} [ctx] - collects problems and notes; a reference check may read more of it
     * @returns {Object} ctx
     */
    check(kind, data, ctx = {}) {
      ctx.root = data;
      ctx.problems ??= [];
      ctx.notes ??= [];
      this.validate(data, this.rules.kinds[kind], '', ctx);
      return ctx;
    }

    /**
     * Checks `value` against one spec. A node that fails its type is not
     * looked into further.
     */
    validate(value, spec, path, ctx) {
      spec = this.resolve(spec);
      // A setup is checked against the definition its logic names: each
      // logic family declares its own flags.
      if (spec['x-logic']) {
        const logic = value?.[spec['x-logic']];
        const definition = this.logic?.definition(logic) ?? null;
        if (definition === null) {
          ctx.problems.push({
            key: `${PROBLEMS}logic`,
            values: { path: FileRules.join(path, spec['x-logic']), value: FileRules.shown(logic), expected: { list: this.logic?.names() ?? [], type: 'unit' } }
          });
          return;
        }
        return this.validate(value, { $ref: `#/definitions/${definition}` }, path, ctx);
      }
      const fail = (code, values = {}) => {
        ctx.problems.push({ key: `${PROBLEMS}${code}`, values: { path: path || '/', ...values } });
      };
      if (Object.hasOwn(spec, 'const') && !same(value, spec.const)) {
        return fail('const', { expected: FileRules.shown(spec.const) });
      }
      if (spec.enum && !spec.enum.some(option => same(option, value))) {
        return fail('enum', { expected: { list: spec.enum.map(FileRules.shown), type: 'unit' } });
      }
      if (spec.type && !FileRules.typeMatches(value, spec.type)) {
        const types = [].concat(spec.type).map(type => ({ key: `customFiles.types.${type}` }));
        return fail('type', { expected: { list: types, type: 'disjunction' } });
      }
      const before = ctx.problems.length;
      switch (typeOf(value)) {
        case 'string':
          this.validateString(value, spec, fail);
          break;
        case 'number':
          this.validateNumber(value, spec, fail);
          break;
        case 'array':
          this.validateArray(value, spec, path, ctx, fail);
          break;
        case 'object':
          this.validateObject(value, spec, path, ctx, fail);
          break;
      }
      // A shipped file stands in for a spec. It runs on null too: a
      // reference spec declares no type to refuse it with.
      const reference = spec['x-reference'];
      if (reference) {
        if (!this.references[reference]) throw new Error(`[FileRules] Unknown x-reference '${reference}' in the rules`);
        this.references[reference](value, path, ctx);
      }
      // Cross-key rules only read a node whose own keys passed: a wrong
      // type would make them report the same mistake a second time.
      if (value !== null && spec['x-rules'] && ctx.problems.length === before) this.applyRules(value, spec, path, ctx);
    }

    /** A spec with its $ref expanded; keys beside the $ref win. */
    resolve(spec) {
      if (!spec.$ref) return spec;
      const { $ref, ...local } = spec;
      const target = this.rules.definitions[$ref.replace('#/definitions/', '')];
      if (!target) throw new Error(`[FileRules] Unknown $ref '${$ref}' in the rules`);
      return { ...this.resolve(target), ...local };
    }

    validateString(value, spec, fail) {
      if (spec.minLength != null && value.length < spec.minLength) fail('minLength', { limit: spec.minLength });
      if (spec.maxLength != null && value.length > spec.maxLength) fail('maxLength', { limit: spec.maxLength });
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        fail(`pattern.${spec['x-message'] ?? 'default'}`, { value });
      }
      if (spec.format) {
        if (!this.formats[spec.format]) throw new Error(`[FileRules] Unknown format '${spec.format}' in the rules`);
        this.formats[spec.format](value, fail);
      }
      const allowed = spec['x-placeholders'];
      if (allowed) {
        for (const [, name] of value.matchAll(/\{(\w+)\}/g)) {
          if (!allowed.includes(name)) {
            fail('placeholder', { name: `{${name}}`, expected: { list: allowed.map(n => `{${n}}`), type: 'unit' } });
          }
        }
      }
    }

    validateNumber(value, spec, fail) {
      if (spec.minimum != null && value < spec.minimum) fail('minimum', { limit: spec.minimum });
      if (spec.maximum != null && value > spec.maximum) fail('maximum', { limit: spec.maximum });
      if (spec.exclusiveMinimum != null && value <= spec.exclusiveMinimum) fail('exclusiveMinimum', { limit: spec.exclusiveMinimum });
    }

    validateArray(value, spec, path, ctx, fail) {
      if (spec.minItems != null && value.length < spec.minItems) fail('minItems', { limit: spec.minItems });
      if (spec.maxItems != null && value.length > spec.maxItems) fail('maxItems', { limit: spec.maxItems });
      if (spec.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
      if (spec.items) value.forEach((item, i) => this.validate(item, spec.items, `${path}[${i}]`, ctx));
      const byName = spec['x-byName'];
      if (!byName) return;
      const seen = new Set();
      value.forEach((item, i) => {
        const name = isObject(item) ? item.name : undefined;
        const at = `${path}[${i}]`;
        if (typeof name !== 'string' || !Object.hasOwn(byName, name)) {
          ctx.problems.push({ key: `${PROBLEMS}byName.unknown`, values: { path: at, expected: { list: Object.keys(byName), type: 'unit' } } });
        } else if (seen.has(name)) {
          ctx.problems.push({ key: `${PROBLEMS}byName.duplicate`, values: { path: at, name } });
        } else {
          seen.add(name);
          this.validate(item, byName[name], FileRules.join(path, name), ctx);
        }
      });
      for (const name of Object.keys(byName)) {
        if (!seen.has(name)) ctx.problems.push({ key: `${PROBLEMS}required`, values: { path: FileRules.join(path, name) } });
      }
    }

    validateObject(value, spec, path, ctx, fail) {
      const properties = spec.properties ?? {};
      // Top-level keys starting with _ are notes, in every kind.
      const keys = Object.keys(value).filter(key => !(value === ctx.root && key.startsWith('_')));
      for (const key of spec.required ?? []) {
        if (!Object.hasOwn(value, key)) ctx.problems.push({ key: `${PROBLEMS}required`, values: { path: FileRules.join(path, key) } });
      }
      if (spec.minProperties != null && keys.length < spec.minProperties) fail('minProperties', { limit: spec.minProperties });
      for (const key of keys) {
        const at = FileRules.join(path, key);
        if (spec.propertyNames) this.validate(key, spec.propertyNames, at, ctx);
        if (Object.hasOwn(properties, key)) {
          this.validate(value[key], properties[key], at, ctx);
        } else if (spec.additionalProperties === false) {
          ctx.problems.push({ key: `${PROBLEMS}unknown`, values: { path: at } });
        } else if (isObject(spec.additionalProperties)) {
          this.validate(value[key], spec.additionalProperties, at, ctx);
        }
      }
    }

    // ────────────────────────────────────────────────────────────────────
    // Cross-key rules
    // ────────────────────────────────────────────────────────────────────

    /** Cross-key rules, on a node whose own keys passed. */
    applyRules(value, spec, path, ctx) {
      for (const rule of spec['x-rules']) {
        if (rule.if && !this.holds(rule.if, value)) continue;
        if (!this.holds(rule.then, value)) ctx.problems.push({ key: `${RULES}${rule.id}`, values: { path: path || '/' } });
      }
    }

    holds(condition, object) {
      if (condition.all) return condition.all.every(c => this.holds(c, object));
      if (condition.any) return condition.any.some(c => this.holds(c, object));
      if (condition.not) return !this.holds(condition.not, object);
      const value = FileRules.read(object, condition.path);
      if (Object.hasOwn(condition, 'is')) return value === condition.is;
      if (Object.hasOwn(condition, 'isNot')) return value !== condition.isNot;
      if (condition.hasAny) return Array.isArray(value) && condition.hasAny.some(item => value.includes(item));
      if (condition.notEmpty) return value != null && value.length > 0;
      if (condition.isPath) return same(value, FileRules.read(object, condition.isPath));
      if (condition.inPath) return FileRules.readAll(object, condition.inPath).some(item => same(item, value));
      if (condition.atMostPath || condition.belowPath) {
        // An unset value takes the post's default, so there is nothing to compare.
        const other = FileRules.read(object, condition.atMostPath ?? condition.belowPath);
        if (value == null || other == null) return true;
        return condition.atMostPath ? value <= other : value < other;
      }
      throw new Error(`[FileRules] Unknown rule condition ${JSON.stringify(condition)}`);
    }

    // ────────────────────────────────────────────────────────────────────
    // Lint
    // ────────────────────────────────────────────────────────────────────

    /**
     * Debug: the rules file against its own vocabulary. Every spec key is
     * one _keywords names (an entry may name several, split on ' / ') or a
     * note starting with _; every type, format, x-reference, $ref and
     * logic definition exists; every x-rules part is one holds() reads;
     * every x-message and rule id has its message. dist strips _keywords,
     * so there the lint has nothing to read and finds nothing.
     * @param {?Object} [english] - en.json, for the messages
     * @returns {string[]} what is wrong, each led by where
     */
    lint(english = null) {
      const faults = [];
      if (!isObject(this.rules._keywords)) return faults;
      const keywords = new Set(Object.keys(this.rules._keywords).flatMap(entry => entry.split(' / ')));
      const definitions = this.rules.definitions ?? {};
      const message = (key, at) => {
        if (english && typeof FileRules.read(english, key) !== 'string') faults.push(`${at}: en.json has no ${key}`);
      };
      const condition = (node, at) => {
        if (!isObject(node)) {
          faults.push(`${at}: a condition is an object`);
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          if (key.startsWith('_')) continue;
          if (!CONDITIONS.has(key)) faults.push(`${at}.${key}: not a condition holds() reads`);
          else if (key === 'all' || key === 'any') value.forEach((part, i) => condition(part, `${at}.${key}[${i}]`));
          else if (key === 'not') condition(value, `${at}.not`);
        }
      };
      const spec = (node, at) => {
        if (!isObject(node)) {
          faults.push(`${at}: a spec is an object`);
          return;
        }
        for (const [key, value] of Object.entries(node)) {
          if (key.startsWith('_')) continue;
          const here = `${at}.${key}`;
          if (!keywords.has(key)) {
            faults.push(`${here}: not a keyword _keywords names`);
            continue;
          }
          switch (key) {
            case 'properties':
            case 'x-byName':
              for (const [name, child] of Object.entries(value)) spec(child, `${here}.${name}`);
              break;
            case 'items':
            case 'propertyNames':
              spec(value, here);
              break;
            case 'additionalProperties':
              if (isObject(value)) spec(value, here);
              break;
            case 'type':
              for (const type of [].concat(value)) {
                if (!TYPES.has(type)) faults.push(`${here}: no type '${type}'`);
              }
              break;
            case 'pattern':
              try {
                new RegExp(value);
              } catch (error) {
                faults.push(`${here}: ${error.message}`);
              }
              break;
            case 'format':
              if (!this.formats[value]) faults.push(`${here}: no format '${value}'`);
              break;
            case 'x-reference':
              if (!this.references[value]) faults.push(`${here}: no reference '${value}'`);
              break;
            case '$ref':
              if (!Object.hasOwn(definitions, String(value).replace('#/definitions/', ''))) faults.push(`${here}: no definition ${value}`);
              break;
            case 'x-message':
              message(`${PROBLEMS}pattern.${value}`, here);
              break;
            case 'x-rules':
              value.forEach((rule, i) => {
                const where = `${here}[${i}]`;
                for (const part of Object.keys(rule)) {
                  if (!part.startsWith('_') && !RULE_KEYS.has(part)) faults.push(`${where}.${part}: not a part of a rule`);
                }
                message(`${RULES}${rule.id}`, where);
                if (rule.if) condition(rule.if, `${where}.if`);
                condition(rule.then, `${where}.then`);
              });
              break;
          }
        }
      };
      for (const [kind, node] of Object.entries(this.rules.kinds)) spec(node, `kinds.${kind}`);
      for (const [name, node] of Object.entries(definitions)) spec(node, `definitions.${name}`);
      for (const name of this.logic?.names() ?? []) {
        const definition = this.logic.definition(name);
        if (!Object.hasOwn(definitions, definition)) faults.push(`logic ${name}: no definition '${definition}'`);
      }
      return faults;
    }

    // ────────────────────────────────────────────────────────────────────
    // Helpers, shared with CustomFiles
    // ────────────────────────────────────────────────────────────────────

    /** The value at a dotted path; numeric segments index arrays. */
    static read(object, path) {
      return path.split('.').reduce((node, key) => node == null ? undefined : node[key], object);
    }

    /** Every value at a dotted path where * stands for each array item. */
    static readAll(object, path) {
      return path.split('.').reduce((nodes, key) => nodes.flatMap(node => {
        if (key === '*') return Array.isArray(node) ? node : [];
        return node == null || node[key] === undefined ? [] : [node[key]];
      }), [object]);
    }

    /** Whether a value is of a rules type, or of one in a list of them. */
    static typeMatches(value, type) {
      return [].concat(type).some(t => {
        if (t === 'integer') return Number.isInteger(value);
        if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
        return typeOf(value) === t;
      });
    }

    static join(path, key) {
      return path ? `${path}.${key}` : key;
    }

    /** A value as a problem quotes it. */
    static shown(value) {
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
  }

  ROOT.FileRules = FileRules;
})();
