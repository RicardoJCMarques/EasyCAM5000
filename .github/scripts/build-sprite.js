/*!
 * @file        .github/scripts/build-sprite.js
 * @description Sprite build script - Bundles individual .svg icons for embbedding
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.resolve(__dirname, '../../images/icons');
const OUTPUT_FILE = path.join(ICONS_DIR, 'sprite.svg');

function buildSprite() {
    console.log('Building local SVG sprite...');

    if (!fs.existsSync(ICONS_DIR)) {
        console.error(`Error: Icons directory not found at ${ICONS_DIR}`);
        return;
    }

    const files = fs.readdirSync(ICONS_DIR)
        .filter(f => f.startsWith('icon-') && f.endsWith('.svg'))
        .sort();

    const symbols = [];
    // Attributes to keep from the root <svg> tag
    const allowedAttrs = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];

    for (const file of files) {
        const filePath = path.join(ICONS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const id = file.replace('.svg', '');

        // Extract viewBox
        const vbMatch = content.match(/viewBox=["']([^"']+)["']/);
        const viewBox = vbMatch ? vbMatch[1] : '0 0 24 24';

        // Extract attributes from the root <svg> tag
        const svgTagMatch = content.match(/<svg([^>]*)>/i);
        let gAttrs = '';

        if (svgTagMatch) {
            allowedAttrs.forEach(attr => {
                const attrMatch = svgTagMatch[1].match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
                if (attrMatch) gAttrs += ` ${attr}="${attrMatch[1]}"`;
            });
        }

        // Shadow DOM Fallbacks: Ensure the stroke/fill inherit correctly if the original SVG was missing them
        if (!gAttrs.includes('fill=')) gAttrs += ' fill="none"';
        if (!gAttrs.includes('stroke=')) gAttrs += ' stroke="currentColor"';
        if (!gAttrs.includes('stroke-width=')) gAttrs += ' stroke-width="2"';
        if (!gAttrs.includes('stroke-linecap=')) gAttrs += ' stroke-linecap="round"';
        if (!gAttrs.includes('stroke-linejoin=')) gAttrs += ' stroke-linejoin="round"';

        // Extract inner content
        const innerMatch = content.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
        if (!innerMatch) continue;

        const inner = innerMatch[1].trim();

        // Wrap the inner content in a <g> tag to pass down the presentation attributes
        symbols.push(`  <symbol id="${id}" viewBox="${viewBox}">\n    <g${gAttrs}>\n      ${inner}\n    </g>\n  </symbol>`);
    }

    if (symbols.length === 0) {
        console.log('No valid icon SVGs found.');
        return;
    }

    const spriteContent = `<svg id="cam-icon-sprite" aria-hidden="true" style="position: absolute; width: 0; height: 0; visibility: hidden;">\n${symbols.join('\n')}\n</svg>`;

    fs.writeFileSync(OUTPUT_FILE, spriteContent);
    console.log(`Successfully bundled ${symbols.length} icons into sprite.svg`);
}

buildSprite();