/*!
 * @file        language/comparator/comparator.js
 * @description Comparison and editing engine for EasyCAM5000 i18n language packs
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  // The apps' own pack rules (language/pack-rules.js): a pack with no
  // warnings here is one the apps accept.
  const Rules = window.PackRules;
  const PROBLEM_TEXT = {
    notText: () => 'Not text: a string, or a plural object.',
    plural: () => 'Not a plural object: zero, one, two, few, many or other, each a string, other required.',
    pluralNoCount: () => 'A plural object needs {count} in the source text.',
    empty: () => 'Empty: no translation. Export leaves the key out, and the app shows English.',
    tokens: problem => `Keep exactly these tokens: ${problem.expected.join(' ')}`,
    slots: problem => `Keep these tags: ${problem.expected.map(slot => slot.endsWith('/') ? `<${slot}>` : `<${slot}>…</${slot}>`).join(' ')}`
  };

  const storage = (() => {
    const mem = new Map();
    return {
      get(key) {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return mem.get(key) ?? null;
        }
      },
      set(key, val) {
        try {
          window.localStorage.setItem(key, val);
        } catch {
          mem.set(key, String(val));
        }
      },
      remove(key) {
        try {
          window.localStorage.removeItem(key);
        } catch {
          mem.delete(key);
        }
      }
    };
  })();

  class I18nComparator {
    constructor() {
      this.leftData = {};
      this.rightData = {};
      this.flatLeft = {};
      this.flatRight = {};
      this.originalRight = {};
      this.modifiedKeys = new Set();
      this.allKeys = [];
      this.selectedKey = null;
      this.leftDir = 'ltr';
      this.rightDir = 'ltr';
      this.rightLocale = 'en';
      this.dom = {};
      this.cacheDom();
      this.bindEvents();
      this.init();
    }

    cacheDom() {
      this.dom.selLeft = document.getElementById('sel-left');
      this.dom.selRight = document.getElementById('sel-right');
      this.dom.fileLeft = document.getElementById('file-left');
      this.dom.fileRight = document.getElementById('file-right');
      this.dom.zoneLeft = document.getElementById('zone-left');
      this.dom.zoneRight = document.getElementById('zone-right');
      this.dom.thLeft = document.getElementById('th-left');
      this.dom.thRight = document.getElementById('th-right');
      this.dom.filterMode = document.getElementById('filter-mode');
      this.dom.searchInput = document.getElementById('search-input');
      this.dom.gridBody = document.getElementById('grid-body');
      this.dom.stats = document.getElementById('stats');
      this.dom.errorBar = document.getElementById('error-bar');
      this.dom.btnFontDec = document.getElementById('btn-font-dec');
      this.dom.btnFontInc = document.getElementById('btn-font-inc');
      this.dom.btnFontRst = document.getElementById('btn-font-rst');
      this.dom.btnExportFull = document.getElementById('btn-export-full');
      this.dom.btnExportDiff = document.getElementById('btn-export-diff');
      this.dom.btnHelp = document.getElementById('btn-help');
      this.dom.modalWelcome = document.getElementById('modal-welcome');
      this.dom.modalWelcomeClose = document.getElementById('modal-welcome-close');
    }

    bindEvents() {
      this.dom.selLeft.addEventListener('change', () => this.loadSelected('left'));
      this.dom.selRight.addEventListener('change', () => this.loadSelected('right'));

      this.attachFileInput(this.dom.fileLeft, 'left');
      this.attachFileInput(this.dom.fileRight, 'right');

      this.setupDropZone(this.dom.zoneLeft, 'left');
      this.setupDropZone(this.dom.thLeft, 'left');
      this.setupDropZone(this.dom.zoneRight, 'right');
      this.setupDropZone(this.dom.thRight, 'right');

      this.dom.filterMode.addEventListener('change', () => this.render());
      this.dom.searchInput.addEventListener('input', () => this.render());

      this.dom.btnFontDec.addEventListener('click', () => this.adjustFontSize(-1));
      this.dom.btnFontInc.addEventListener('click', () => this.adjustFontSize(1));
      this.dom.btnFontRst.addEventListener('click', () => this.setFontSize(13));

      if (this.dom.btnExportFull)  this.dom.btnExportFull.addEventListener('click', () => this.exportJson(false));
      if (this.dom.btnExportDiff)  this.dom.btnExportDiff.addEventListener('click', () => this.exportJson(true));

      if (this.dom.btnHelp && this.dom.modalWelcome) {
        this.dom.btnHelp.addEventListener('click', () => this.showModal(true));
        this.dom.modalWelcomeClose.addEventListener('click', () => this.showModal(false));
        this.dom.modalWelcome.addEventListener('click', (e) => {
          if (e.target === this.dom.modalWelcome) this.showModal(false);
        });
      }

      window.addEventListener('keydown', (e) => this.handleKeyboardNav(e));
      window.addEventListener('mousemove', () => {
        if (document.body.classList.contains('is-keyboard-nav')) document.body.classList.remove('is-keyboard-nav');
      }, { passive: true });
    }

    async init() {
      this.initFontSize();
      this.checkWelcomeNotice();

      const params = new URLSearchParams(window.location.search);
      const left = params.get('left');
      const right = params.get('right');
      const key = params.get('key');
      const filter = params.get('filter');

      if (left) this.ensureOption(this.dom.selLeft, left);
      if (right) this.ensureOption(this.dom.selRight, right);
      if (filter) this.dom.filterMode.value = filter;
      if (key) this.selectedKey = key;

      await Promise.all([
        this.loadSelected('left', false),
        this.loadSelected('right', false)
      ]);

      this.rebuildComparison();
    }

    checkWelcomeNotice() {
      if (!storage.get('i18n_comparator_welcome_seen') && this.dom.modalWelcome) {
        this.showModal(true);
      }
    }

    showModal(visible) {
      if (!this.dom.modalWelcome) return;
      this.dom.modalWelcome.style.display = visible ? 'flex' : 'none';
      if (!visible) storage.set('i18n_comparator_welcome_seen', '1');
    }

    showError(msg) {
      if (!msg) {
        this.dom.errorBar.style.display = 'none';
        this.dom.errorBar.textContent = '';
        return;
      }
      this.dom.errorBar.style.display = 'block';
      this.dom.errorBar.textContent = msg;
    }

    isPluralNode(val) {
      return Rules.isPlural(val);
    }

    flatten(obj, prefix = '') {
      const res = {};
      for (const [k, v] of Object.entries(obj)) {
        // Notes (_) and the pack's identity (meta) are not text to translate.
        if (k.startsWith('_') || (!prefix && k === 'meta')) continue;
        const path = prefix ? `${prefix}.${k}` : k;
        if (this.isPluralNode(v)) {
          res[path] = { ...v };
        } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          Object.assign(res, this.flatten(v, path));
        } else {
          res[path] = v === null ? '' : String(v);
        }
      }
      return res;
    }

    unflatten(flatObj) {
      const root = {};
      for (const [path, val] of Object.entries(flatObj)) {
        const parts = path.split('.');
        let curr = root;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (!curr[p] || typeof curr[p] !== 'object') curr[p] = {};
          curr = curr[p];
        }
        curr[parts[parts.length - 1]] = this.isPluralNode(val) ? { ...val } : val;
      }
      return root;
    }

    /** The apps' checks of one string, in words; the target's locale picks its plural forms. */
    validateKey(leftVal, rightVal, locale) {
      if (leftVal === undefined || rightVal === undefined || !Rules.isText(leftVal)) return [];
      const warnings = Rules.compareText(leftVal, rightVal).map(problem => (PROBLEM_TEXT[problem.code] || (() => problem.code))(problem));
      if (Rules.isPlural(rightVal)) {
        const missing = Rules.requiredForms(locale).filter(form => !Object.hasOwn(rightVal, form));
        if (missing.length) warnings.push(`Plural forms ${locale} uses, missing: ${missing.join(', ')} (other shows instead)`);
      }
      return warnings;
    }

    resolvePath(filename) {
      if (!filename) return '';
      if (filename.startsWith('blob:') || filename.startsWith('data:') || filename.startsWith('/') || filename.startsWith('./') || filename.startsWith('../')) {
        return filename;
      }
      return `../${filename}`;
    }

    async fetchPack(filename) {
      const path = this.resolvePath(filename);
      try {
        const resp = await fetch(path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
      } catch (err) {
        this.showError(`Failed to fetch '${path}': ${err.message}. Use local file inputs if running on file://.`);
        return {};
      }
    }

    ensureOption(selectEl, value) {
      if (!Array.from(selectEl.options).some(o => o.value === value)) selectEl.add(new Option(value, value));
      selectEl.value = value;
    }

    attachFileInput(fileInput, side) {
      fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const cleanText = evt.target.result.trim().replace(/^\uFEFF/, '');
            const data = JSON.parse(cleanText);
            const sel = side === 'left' ? this.dom.selLeft : this.dom.selRight;
            this.ensureOption(sel, file.name);
            this.applyLoadedData(side, data, file.name);
          } catch (err) {
            this.showError(`JSON Parse error in ${file.name}: ${err.message}`);
          }
        };
        reader.readAsText(file);
      });
    }

    setupDropZone(dropZone, side) {
      dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drop-active');
      });

      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });

      dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drop-active');
      });

      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drop-active');

        const file = e.dataTransfer?.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const cleanText = evt.target.result.trim().replace(/^\uFEFF/, '');
            const data = JSON.parse(cleanText);
            const sel = side === 'left' ? this.dom.selLeft : this.dom.selRight;
            this.ensureOption(sel, file.name);
            this.applyLoadedData(side, data, file.name);
          } catch (err) {
            this.showError(`Error reading dropped file ${file.name}: ${err.message}`);
          }
        };
        reader.readAsText(file);
      });
    }

    async loadSelected(side, triggerRebuild = true) {
      const selectEl = side === 'left' ? this.dom.selLeft : this.dom.selRight;
      const filename = selectEl.value;
      const data = await this.fetchPack(filename);
      this.applyLoadedData(side, data, filename, triggerRebuild);
    }

    applyLoadedData(side, data, filename, triggerRebuild = true) {
      this.showError(null);
      const cleanName = filename.replace(/^.*[\\/]/, '');
      if (side === 'left') {
        this.leftData = data;
        this.dom.thLeft.textContent = cleanName;
      } else {
        this.rightData = data;
        this.dom.thRight.textContent = cleanName;
        this.rightLocale = data.meta?.locale || cleanName.split('.')[0] || 'en';
        this.loadDraft();
      }

      if (triggerRebuild) this.rebuildComparison();
    }

    getDraftStorageKey() {
      return `i18n_draft_${this.rightLocale}`;
    }

    saveDraft() {
      if (!this.rightLocale) return;
      const draft = {};
      for (const key of this.modifiedKeys) {
        draft[key] = this.flatRight[key];
      }
      storage.set(this.getDraftStorageKey(), JSON.stringify(draft));
    }

    loadDraft() {
      this.flatRight = this.flatten(this.rightData);
      this.originalRight = JSON.parse(JSON.stringify(this.flatRight));
      this.modifiedKeys.clear();

      const rawDraft = storage.get(this.getDraftStorageKey());
      if (!rawDraft) return;

      try {
        const draft = JSON.parse(rawDraft);
        for (const [k, v] of Object.entries(draft)) {
          this.flatRight[k] = v;
          this.modifiedKeys.add(k);
        }
      } catch {
        storage.remove(this.getDraftStorageKey());
      }
    }

    rebuildComparison() {
      this.leftDir = this.leftData.meta?.dir === 'rtl' ? 'rtl' : 'ltr';
      this.rightDir = this.rightData.meta?.dir === 'rtl' ? 'rtl' : 'ltr';

      this.dom.thLeft.className = this.leftDir === 'rtl' ? 'col-dir-rtl' : 'col-dir-ltr';
      this.dom.thRight.className = this.rightDir === 'rtl' ? 'col-dir-rtl' : 'col-dir-ltr';

      this.flatLeft = this.flatten(this.leftData);
      if (!this.modifiedKeys.size) {
        this.flatRight = this.flatten(this.rightData);
        this.originalRight = JSON.parse(JSON.stringify(this.flatRight));
      }

      const seen = new Set();
      this.allKeys = [];
      for (const k of Object.keys(this.flatLeft)) {
        seen.add(k);
        this.allKeys.push(k);
      }
      for (const k of Object.keys(this.flatRight)) {
        if (!seen.has(k)) {
          seen.add(k);
          this.allKeys.push(k);
        }
      }

      // G-code comments are worded from en.json alone: nothing to translate.
      this.allKeys = this.allKeys.filter(key => !Rules.isEnglishOnly(key));

      this.syncUrl();
      this.render();
    }

    syncUrl() {
      const url = new URL(window.location);
      url.searchParams.set('left', this.dom.selLeft.value);
      url.searchParams.set('right', this.dom.selRight.value);
      url.searchParams.set('filter', this.dom.filterMode.value);
      if (this.selectedKey) url.searchParams.set('key', this.selectedKey);
      else url.searchParams.delete('key');
      window.history.replaceState(null, '', url.toString());
    }

    selectRow(key, scroll = false) {
      this.selectedKey = key;
      document.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
      const tr = document.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
      if (tr) {
        tr.classList.add('selected');
        if (scroll) tr.scrollIntoView({ block: 'center' });
      }
      this.syncUrl();
    }

    handleKeyboardNav(e) {
      if (['ArrowDown', 'ArrowUp'].includes(e.key) && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        document.body.classList.add('is-keyboard-nav');
        const rows = Array.from(this.dom.gridBody.querySelectorAll('tr'));
        if (!rows.length) return;
        e.preventDefault();
        let idx = rows.findIndex(r => r.dataset.key === this.selectedKey);
        if (e.key === 'ArrowDown') idx = idx < rows.length - 1 ? idx + 1 : 0;
        else idx = idx > 0 ? idx - 1 : rows.length - 1;
        this.selectRow(rows[idx].dataset.key, true);
      }
    }

    updateValue(key, val) {
      const isDifferent = JSON.stringify(val) !== JSON.stringify(this.originalRight[key]);
      if (isDifferent) {
        this.flatRight[key] = val;
        this.modifiedKeys.add(key);
      } else {
        this.flatRight[key] = this.originalRight[key];
        this.modifiedKeys.delete(key);
      }
      this.saveDraft();
      this.renderRowOnly(key);
      this.updateStats();
    }

    revertKey(key) {
      if (!this.modifiedKeys.has(key)) return;
      if (this.originalRight[key] !== undefined) this.flatRight[key] = JSON.parse(JSON.stringify(this.originalRight[key]));
      else delete this.flatRight[key];
      this.modifiedKeys.delete(key);
      this.saveDraft();
      this.renderRowOnly(key);
      this.updateStats();
    }

    renderRowOnly(key) {
      const tr = this.dom.gridBody.querySelector(`tr[data-key="${CSS.escape(key)}"]`);
      if (!tr) return;
      const replacement = this.buildRow(key);
      tr.replaceWith(replacement);
      if (key === this.selectedKey) replacement.classList.add('selected');
    }

    render() {
      const filter = this.dom.filterMode.value;
      const search = this.dom.searchInput.value.trim().toLowerCase();

      this.dom.gridBody.innerHTML = '';
      const fragment = document.createDocumentFragment();

      let renderedCount = 0;
      let missingRightCount = 0;
      let mismatchCount = 0;

      for (const key of this.allKeys) {
        const hasLeft = Object.prototype.hasOwnProperty.call(this.flatLeft, key);
        const hasRight = Object.prototype.hasOwnProperty.call(this.flatRight, key);
        const leftVal = hasLeft ? this.flatLeft[key] : undefined;
        const rightVal = hasRight ? this.flatRight[key] : undefined;

        if (!hasRight) missingRightCount++;

        const warnings = this.validateKey(leftVal, rightVal, this.rightLocale);
        const hasWarning = warnings.length > 0;
        if (hasWarning) mismatchCount++;

        const leftStr = this.serializeForSearch(leftVal);
        const rightStr = this.serializeForSearch(rightVal);

        if (filter === 'missing-right' && hasRight) continue;
        if (filter === 'missing-left' && hasLeft) continue;
        if (filter === 'diff' && leftStr === rightStr) continue;
        if (filter === 'warnings' && !hasWarning) continue;
        if (filter === 'modified' && !this.modifiedKeys.has(key)) continue;

        if (search) {
          const matchKey = key.toLowerCase().includes(search);
          const matchLeft = hasLeft && leftStr.toLowerCase().includes(search);
          const matchRight = hasRight && rightStr.toLowerCase().includes(search);
          if (!matchKey && !matchLeft && !matchRight) continue;
        }

        fragment.appendChild(this.buildRow(key, warnings));
        renderedCount++;
      }

      this.dom.gridBody.appendChild(fragment);
      this.dom.stats.textContent = `Showing ${renderedCount} / ${this.allKeys.length} keys | Missing: ${missingRightCount} | Warnings: ${mismatchCount} | Modified: ${this.modifiedKeys.size}`;

      if (this.selectedKey) this.selectRow(this.selectedKey, true);
    }

    updateStats() {
      const missingRightCount = this.allKeys.filter(k => !Object.prototype.hasOwnProperty.call(this.flatRight, k)).length;
      this.dom.stats.textContent = `Total: ${this.allKeys.length} | Missing: ${missingRightCount} | Modified: ${this.modifiedKeys.size}`;
    }

    serializeForSearch(val) {
      if (val === undefined || val === null) return '';
      if (typeof val === 'string') return val;
      if (this.isPluralNode(val)) return Object.values(val).join(' ');
      return JSON.stringify(val);
    }

    buildRow(key, warnings = null) {
      const hasLeft = Object.prototype.hasOwnProperty.call(this.flatLeft, key);
      const hasRight = Object.prototype.hasOwnProperty.call(this.flatRight, key);
      const leftVal = hasLeft ? this.flatLeft[key] : undefined;
      const rightVal = hasRight ? this.flatRight[key] : undefined;

      if (!warnings) warnings = this.validateKey(leftVal, rightVal, this.rightLocale);

      const tr = document.createElement('tr');
      tr.dataset.key = key;
      if (this.modifiedKeys.has(key)) tr.classList.add('row-modified');

      tr.addEventListener('click', () => {
        document.body.classList.remove('is-keyboard-nav');
        this.selectRow(key);
      });

      const tdKey = document.createElement('td');
      tdKey.className = 'key-cell';
      tdKey.textContent = key;

      if (this.modifiedKeys.has(key)) {
        const revBtn = document.createElement('button');
        revBtn.type = 'button';
        revBtn.className = 'btn-revert';
        revBtn.title = 'Revert key changes';
        revBtn.textContent = '↶';
        revBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.revertKey(key);
        });
        tdKey.appendChild(revBtn);
      }
      tr.appendChild(tdKey);

      const tdLeft = document.createElement('td');
      tdLeft.className = this.leftDir === 'rtl' ? 'col-dir-rtl' : 'col-dir-ltr';
      if (!hasLeft) tdLeft.innerHTML = '<span class="missing">[MISSING]</span>';
      else this.renderStaticCell(tdLeft, leftVal);
      tr.appendChild(tdLeft);

      const tdRight = document.createElement('td');
      tdRight.className = this.rightDir === 'rtl' ? 'col-dir-rtl' : 'col-dir-ltr';
      if (!hasRight) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn-add-translation';
        addBtn.textContent = '+ Add Translation';
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const initialVal = this.isPluralNode(leftVal) ? Object.fromEntries(Object.keys(leftVal).map(k => [k, ''])) : '';
          this.updateValue(key, initialVal);
        });
        tdRight.appendChild(addBtn);
      } else {
        this.renderEditableCell(tdRight, key, rightVal);
        if (warnings.length) {
          for (const w of warnings) {
            const badge = document.createElement('div');
            badge.className = 'badge';
            badge.textContent = w;
            tdRight.appendChild(badge);
          }
        }
      }
      tr.appendChild(tdRight);

      return tr;
    }

    renderStaticCell(td, val) {
      if (typeof val === 'string') {
        td.textContent = val;
      } else if (this.isPluralNode(val)) {
        for (const [form, str] of Object.entries(val)) {
          const line = document.createElement('div');
          line.className = 'plural-line';
          line.textContent = `[${form}] ${str}`;
          td.appendChild(line);
        }
      }
    }

    renderEditableCell(td, key, val) {
      if (typeof val === 'string') {
        const input = document.createElement('textarea');
        input.className = 'cell-editor';
        input.value = val;
        input.dir = this.rightDir;
        input.setAttribute('aria-label', key);
        input.addEventListener('change', () => this.updateValue(key, input.value));
        td.appendChild(input);
      } else if (this.isPluralNode(val)) {
        const container = document.createElement('div');
        container.className = 'plural-editor-container';
        const required = Rules.requiredForms(this.rightLocale);
        const targetForms = Rules.PLURAL_FORMS.filter(form => required.includes(form) || Object.hasOwn(val, form));
        for (const form of targetForms) {
          const row = document.createElement('div');
          row.className = 'plural-editor-row';
          const label = document.createElement('span');
          label.className = 'plural-label';
          label.textContent = form;
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'plural-input';
          input.dir = this.rightDir;
          input.value = val[form] || '';
          input.setAttribute('aria-label', `${key} [${form}]`);
          input.addEventListener('change', () => {
            const copy = { ...val, [form]: input.value };
            this.updateValue(key, copy);
          });
          row.appendChild(label);
          row.appendChild(input);
          container.appendChild(row);
        }
        td.appendChild(container);
      }
    }

    exportJson(diffOnly = false) {
      const cleanTargetName = this.dom.selRight.value.replace(/^.*[\\/]/, '');
      const filename = diffOnly ? `${this.rightLocale}.diff.json` : cleanTargetName.endsWith('.json') ? cleanTargetName : `${this.rightLocale}.json`;
      // Keys in the source pack's order, then the target's own, so a pack
      // diffs cleanly against English. A blank value is no translation:
      // it is left out, and the app shows English.
      const flat = {};
      for (const key of this.allKeys) {
        if (!Object.hasOwn(this.flatRight, key) || (diffOnly && !this.modifiedKeys.has(key))) continue;
        if (!Rules.isBlank(this.flatRight[key])) flat[key] = this.flatRight[key];
      }
      const outputObject = {};
      if (!diffOnly && this.rightData._projectInfo) outputObject._projectInfo = this.rightData._projectInfo;
      outputObject.meta = diffOnly
        ? { locale: this.rightLocale, dir: this.rightDir }
        : { ...(this.rightData.meta || {}), locale: this.rightLocale, dir: this.rightDir };
      Object.assign(outputObject, this.unflatten(flat));
      const blob = new Blob([JSON.stringify(outputObject, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = url;
      downloadAnchor.download = filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    initFontSize() {
      const sz = parseInt(storage.get('i18n_font_size') || '15', 10);
      this.setFontSize(sz);
    }

    setFontSize(px) {
      const clamped = Math.max(12, Math.min(26, px));
      document.documentElement.style.setProperty('--font-size', `${clamped}px`);
      storage.set('i18n_font_size', String(clamped));
    }

    adjustFontSize(delta) {
      const current = parseInt(storage.get('i18n_font_size') || '15', 10);
      this.setFontSize(current + delta);
    }
  }

  document.addEventListener('DOMContentLoaded', () => { window.comparatorApp = new I18nComparator(); });
})();