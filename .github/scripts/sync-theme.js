/*!
 * @file        .github/scripts/sync-theme.js
 * @description Syncs dark.json with theme.css - must run manually on .json changes
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
            cssLines.push(`    --${newPrefix}: ${value};`);
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
        cssLines.push(`\n    /* ${title} Colors */`);
        flattenVars(map.prefix, colors[map.key]);
    }
});

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