/*!
* @file        .github/scripts/sync-theme.js
* @description Syncs dark.json into theme.css and checks every shipped theme - run manually on .json changes
* @author      Eltryus - Ricardo Marques
* @copyright   2025-2026 Eltryus - Ricardo Marques
* @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
*
* SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
* SPDX-License-Identifier: AGPL-3.0-or-later
*/

const fs = require('fs');
const path = require('path');

// Resolve paths relative to this script location (.github/scripts/)
const THEME_JSON_PATH = path.resolve(__dirname, '../../themes/dark.json');
const CSS_PATH = path.resolve(__dirname, '../../css/theme.css');

// Validation
if (!fs.existsSync(THEME_JSON_PATH)) {
  console.error(`❌ Error: Theme source not found at ${THEME_JSON_PATH}`);
  process.exit(1);
}
if (!fs.existsSync(CSS_PATH)) {
  console.error(`❌ Error: Target CSS not found at ${CSS_PATH}`);
  process.exit(1);
}

const themeData = JSON.parse(fs.readFileSync(THEME_JSON_PATH, 'utf8'));
const colors = themeData.colors;
let cssLines = [];

/**
 * Automatically converts JSON hierarchy to CSS kebab-case variables.
 */
function flattenVars(prefix, obj) {
  Object.entries(obj).forEach(([key, value]) => {
    // Convert JSON camelCase key to CSS kebab-case
    // e.g. "peckMarkGood" -> "peck-mark-good"
    const kebabKey = key.replace(/[A-Z]/g, m => "-" + m.toLowerCase());
    const newPrefix = prefix ? `${prefix}-${kebabKey}` : kebabKey;

    if (typeof value === 'object' && value !== null) {
      flattenVars(newPrefix, value);
    } else {
      cssLines.push(`  --${newPrefix}: ${value};`);
    }
  });
}

// Map JSON categories to their CSS variable prefixes
// Manually map the "Root" categories to ensure they match existing CSS usage
const mappings = [
  { key: 'background', prefix: 'color-bg' },
  { key: 'text', prefix: 'color-text' },
  { key: 'border', prefix: 'color-border' },
  { key: 'accent', prefix: 'color-accent' },
  { key: 'semantic', prefix: 'color' },
  { key: 'operations', prefix: 'color-operation' },
  { key: 'render2d', prefix: 'color-render2d' },
  { key: 'render3d', prefix: 'color-render3d' },
  { key: 'debug', prefix: 'color-debug' },
  { key: 'geometry', prefix: 'color-geometry' },
  { key: 'primitives', prefix: 'color-primitive' },
  { key: 'bw', prefix: 'color-bw' },
  { key: 'pipelines', prefix: 'color-pipeline' },
  { key: 'interaction', prefix: 'color-interaction' }
];

mappings.forEach(map => {
  if (colors[map.key]) {
    // Add a nice comment header
    const title = map.key.charAt(0).toUpperCase() + map.key.slice(1);
    cssLines.push(`\n  /* ${title} Colors */`);
    flattenVars(map.prefix, colors[map.key]);
  }
});

// Process top-level tokens if present (unprefixed CSS variables)
if (themeData.tokens && typeof themeData.tokens === 'object' && Object.keys(themeData.tokens).length > 0) {
  cssLines.push(`\n  /* Token Overrides */`);
  Object.entries(themeData.tokens).forEach(([key, value]) => {
    cssLines.push(`  --${key}: ${value};`);
  });
}

// Theme gate. Every shipped theme declares exactly dark.json's colour keys:
// the loader writes a theme over theme.css, so a key a theme lacks would show
// dark's value. Values are 6-digit hex - the palette is opaque by policy - and
// the two scrims are the one translucent exception. A shipped theme carries no
// label (the language pack captions it by id), so it needs that caption, and a
// token must be a property css/base.css declares.
const THEMES_DIR = path.resolve(__dirname, '../../themes');
const LANG_PATH = path.resolve(__dirname, '../../language/en.json');
const BASE_CSS_PATH = path.resolve(__dirname, '../../css/base.css');
const SCRIMS = new Set(['semantic.scrim', 'semantic.scrimStrong']);
const leavesOf = (obj, prefix = '', out = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') leavesOf(v, p, out);
    else out.set(p, v);
  }
  return out;
};
const reference = leavesOf(colors);
const captions = JSON.parse(fs.readFileSync(LANG_PATH, 'utf8')).params?.theme?.options ?? {};
const declared = new Set([...fs.readFileSync(BASE_CSS_PATH, 'utf8').matchAll(/--([\w-]+)\s*:/g)].map(m => m[1]));
const problems = [];
for (const file of fs.readdirSync(THEMES_DIR).filter(f => f.endsWith('.json')).sort()) {
  const id = path.basename(file, '.json');
  const where = `themes/${file}`;
  const theme = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, file), 'utf8'));
  if (theme.id !== id) problems.push(`${where}: id '${theme.id}' does not match the file name`);
  if (theme.base !== 'dark' && theme.base !== 'light') problems.push(`${where}: base must be 'dark' or 'light'`);
  if ('label' in theme) problems.push(`${where}: a shipped theme carries no label`);
  if (typeof captions[id] !== 'string') problems.push(`language/en.json: params.theme.options.${id} is missing`);
  for (const name of Object.keys(theme.tokens ?? {})) {
    if (!declared.has(name)) problems.push(`${where}: token '${name}' is not declared in css/base.css`);
  }
  const leaves = leavesOf(theme.colors ?? {});
  for (const [key, value] of leaves) {
    if (!reference.has(key)) {
      problems.push(`${where}: colors.${key} is not in dark.json`);
    } else if (SCRIMS.has(key) ? !/^(rgb|hsl)a?\(/i.test(value) : !/^#[0-9a-f]{6}$/i.test(value)) {
      problems.push(`${where}: colors.${key} "${value}" is not ${SCRIMS.has(key) ? 'an rgb()/hsl() colour' : 'a 6-digit hex colour'}`);
    }
  }
  for (const key of reference.keys()) {
    if (!leaves.has(key)) problems.push(`${where}: colors.${key} is missing`);
  }
}
if (problems.length) {
  for (const problem of problems) console.error(`❌ ${problem}`);
  process.exit(1);
}

// Read and Replace CSS File content
let cssContent = fs.readFileSync(CSS_PATH, 'utf8');

// This rewrites the FIRST :root body in theme.css wholesale. Nothing
// hand-written may live there - app-level maps belong in the per-app
// layout stylesheets.
const rootBlockRegex = /(:root\s*\{)([\s\S]*?)(\})/i;
const newRootBody = cssLines.join('\n') + '\n';

if (rootBlockRegex.test(cssContent)) {
  const updatedCss = cssContent.replace(rootBlockRegex, `$1${newRootBody}$3`);
  fs.writeFileSync(CSS_PATH, updatedCss, 'utf8');
  console.log(`✅ theme.css synced with dark.json (${cssLines.length} variables)`);
} else {
  console.error('❌ Error: Could not find :root { ... } block in theme.css');
  process.exit(1);
}