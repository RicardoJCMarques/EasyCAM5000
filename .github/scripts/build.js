/*!
 * @file        .github/scripts/build.js
 * @description Production build script - CSS inlining, JSON embedding, JS bundling
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
    // Define your app entry points here
    apps: [
        {
            name: 'EasyTrace5000',
            html: 'easytrace5000/index.html',
            jsBundle: 'easytrace5000/easytrace5000.js'
        },
        {
            name: 'EasyShape5000',
            html: 'easyshape5000/index.html',
            jsBundle: 'easyshape5000/easyshape5000.js'
        }
    ],

    // Files/folders to exclude from dist
    excludePatterns: [
        '.git',
        '.github',
        '.gitignore',
        'NOTICE',
        'node_modules',
        'dist',
        'scripts',
        '*.md',
        'CITATION.cff',
        '.DS_Store',
        'docs',
        'extras',
        'fiveserver.config.js',
        'licensepasta.txt',
        'other',
        'project.config.js',
        'context-gen.js',
        'PROJECT_CONTEXT_easycam5000.txt',
        'file-bundle.js',
        'FILE_BUNDLE_easycam5000.txt',
        'package.json',
        'package-lock.json',
        // Analytic offsetting files
        'geometry-offsetter-analytic.js',
        'geometry-utils-math.js',
        // Inactive stubs
        'shape-pattern-handler.js'
    ],

    // ESM 3D preview stack. esbuild bundles the entry point plus every
    // renderer3d-* sibling AND the vendored three files into one module at
    // the SAME path, so the dynamic import specifier never changes and the
    // importmap becomes unnecessary in dist.
    renderer3d: {
        dir: 'renderer3d',
        entry: 'renderer3d/renderer3d-core.js',
        alias: {
            'three': 'renderer3d/three.core.min.js',
            'three/webgpu': 'renderer3d/three.webgpu.min.js',
            'three/tsl': 'renderer3d/three.tsl.min.js'
        }
    },

    // Files to explicitly protect from deletion (used by unbundled docs, etc)
    preserveFiles: [
        'themes/theme-loader.js',
    ],

    // Embedded assets
    embedLanguage: 'language/en.json',
    embedTools: 'tools.json',

    // Profiles to inject directly into the JS controllers
    appProfiles: [
        { path: 'ui/profile-trace.json', target: 'easytrace5000/cam-easytrace5000.js', varName: 'EMBEDDED_PROFILE_TRACE' },
        { path: 'ui/profile-shape.json', target: 'easyshape5000/cam-easyshape5000.js', varName: 'EMBEDDED_PROFILE_SHAPE' }
    ],

    embedLaserProfiles: 'export/laser-profiles.json'
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function stripComments(content, fileType, keep = false) {
    // Remove comment new lines
    content = content.replace(/\r\n?/g, '\n');

    if (keep) return content.trim();

    // Remove block comments (/* ... */) - works for both JS and CSS
    content = content.replace(/\/\*[\s\S]*?\*\//g, '');

    // Note: Trailing comments survive on purpose: stripping them safely needs a tokenizer, and terser handles them under --minify.
    if (fileType === 'js') {
        content = content.replace(/^[ \t]*\/\/.*$/gm, '');
    }

    // Remove excessive blank lines (more than 2 consecutive)
    content = content.replace(/\n{3,}/g, '\n\n');

    return content.trim();
}

function log(msg) {
    console.log(`[build] ${msg}`);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function copyRecursive(src, dest, excludes = []) {
    if (!fs.existsSync(src)) return;

    const basename = path.basename(src);

    // Check exclusions before stat
    for (const pattern of excludes) {
        if (pattern.startsWith('*')) {
            if (basename.endsWith(pattern.slice(1))) return;
        } else if (basename === pattern) {
            return;
        }
    }

    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
        ensureDir(dest);
        for (const child of fs.readdirSync(src)) {
            copyRecursive(path.join(src, child), path.join(dest, child), excludes);
        }
    } else {
        fs.copyFileSync(src, dest);
    }
}

function readFile(filepath) {
    return fs.existsSync(filepath) ? fs.readFileSync(filepath, 'utf8') : '';
}

function writeFile(filepath, content) {
    ensureDir(path.dirname(filepath));
    fs.writeFileSync(filepath, content);
}

/**
 * Every embed step rewrites a module with a regex and then DELETES the file
 * it embedded. A regex that stops matching is invisible: the rewrite no-ops,
 * the input is removed anyway, and dist ships a module that fetches a 404 -
 * or, for a profile, an app that cannot start. Nothing may delete an input it
 * has not proved it consumed.
 */
function mustReplace(content, pattern, replacement, what) {
    const out = content.replace(pattern, replacement);
    if (out === content) {
        throw new Error(`${what}: pattern did not match - refusing to delete the source it embeds`);
    }
    return out;
}

function deleteFile(filepath) {
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
}

function deleteDir(dirpath) {
    if (fs.existsSync(dirpath)) {
        fs.rmSync(dirpath, { recursive: true, force: true });
    }
}

// Deterministic build id. A wall-clock timestamp in every banner changes the
// content hash of every bundled artifact on every run, so the FTP deploy
// re-uploads both app bundles, the worker and every HTML file even when
// nothing changed. The commit is the only thing that should move the bytes.
const BUILD_ID = (() => {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
    try {
        return require('child_process')
            .execFileSync('git', ['rev-parse', '--short', 'HEAD'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
            .trim();
    } catch { return 'local'; }
})();

function buildHeader(title, subtitle, format = 'js') {
    const YEARS  = '2025-2026';
    const HOLDER = 'Eltryus - Ricardo Marques';
    const REPO   = 'https://github.com/RicardoJCMarques/EasyCAM5000';

    const heading = subtitle ? `${title} - ${subtitle}` : title;
    const timestamp = BUILD_ID;

    if (format === 'html') {
        return `<!--!
  ${heading}
  Copyright (C) ${YEARS} ${HOLDER}
  SPDX-License-Identifier: AGPL-3.0-or-later
  Source: ${REPO}
  Build: ${timestamp}
-->`;
    }

    return `/*!
 * ${heading}
 * Copyright (C) ${YEARS} ${HOLDER}
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * Source: ${REPO}
 * Build: ${timestamp}
 */\n\n`;
}

// ============================================================================
// BUILD STEPS
// ============================================================================

class Builder {
    constructor(srcDir, distDir, options = {}) {
        this.srcDir = path.resolve(srcDir);
        this.distDir = path.resolve(distDir);
        this.keepComments = options.keepComments === true;
        this.minifyMode = options.minifyMode || 'full';
        // The regex comment stripper cannot tell a comment from a '/*' inside
        // a string or regex literal. Under --minify terser removes comments
        // with a real tokenizer immediately afterwards, so running the regex
        // first takes that risk for no benefit. Only a plain dist needs it.
        this.keepJsComments = this.keepComments || options.willMinify === true;
        this.stats = { css: 0, js: 0, html: 0 };
        this.processedFiles = new Set();
    }

    /**
     * Every HTML in dist that is not an app entry. Hardcoding this list means
     * a new page keeps <link>s to stylesheets cleanup has already deleted:
     * an unstyled page in production and no build step that notices.
     */
    docPages() {
        const appHtml = new Set(CONFIG.apps.map(a => path.join(this.distDir, a.html)));
        const out = [];
        const walk = (dir) => {
            if (!fs.existsSync(dir)) return;
            for (const item of fs.readdirSync(dir)) {
                const p = path.join(dir, item);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (p.toLowerCase().endsWith('.html') && !appHtml.has(p)) out.push(p);
            }
        };
        walk(this.distDir);
        return out;
    }

    /** Bundle markers name files by repo path, not by the <script src> path. */
    repoPath(absPath) {
        return path.relative(this.distDir, absPath).split(path.sep).join('/');
    }

    run() {
        log(`Source: ${this.srcDir}`);
        log(`Output: ${this.distDir}`);

        this.cleanDist();
        this.copySource();

        // Assests to Embed
        this.embedLanguageJSON();
        this.embedToolsJSON();
        this.embedLaserProfilesJSON();
        this.embedAppProfiles();
        this.embedIconSprite();
        this.processApps();
        this.bundleFieldWorker();
        this.bundleRenderer3D();
        this.processDocPages();

        this.cleanup();
        this.verify();
        this.printStats();
    }

    cleanDist() {
        log('Cleaning dist folder...');
        deleteDir(this.distDir);
        ensureDir(this.distDir);
    }

    copySource() {
        log('Copying source files...');
        copyRecursive(this.srcDir, this.distDir, CONFIG.excludePatterns);
    }

    embedLanguageJSON() {
        log('Embedding language strings into language-manager.js...');

        const langPath = path.join(this.distDir, CONFIG.embedLanguage);
        const managerPath = path.join(this.distDir, 'language/language-manager.js');

                if (!fs.existsSync(langPath) || !fs.existsSync(managerPath)) {
            throw new Error(`embedLanguage: ${CONFIG.embedLanguage} or language/language-manager.js missing in dist`);
        }

        // v2 language packs have NO `strings` wrapper - namespaces are top
        // level. LanguageManager.load reads `data.strings || data`, and this
        // must agree with it: reading only `.strings` embeds {}, the rewritten
        // load() early-returns for 'en', en.json is deleted, and every
        // user-facing string in production silently falls through to its
        // inline English fallback.
        const langData = JSON.parse(readFile(langPath));
        const payload = langData.strings || langData;
        if (!Object.keys(payload).some(k => !k.startsWith('_'))) {
            throw new Error(`embedLanguage: ${CONFIG.embedLanguage} yielded no translatable keys - schema changed?`);
        }
        const langJSON = JSON.stringify(payload);
        let manager = readFile(managerPath);

        // Insert embedded strings after 'use strict'
        const embedCode = `\n    // BUILD: Embedded English strings\n    const EMBEDDED_STRINGS = ${langJSON};\n`;
        manager = mustReplace(manager, /\(function\(\)\s*\{\s*'use strict';/,
            `(function() {\n    'use strict';${embedCode}`, 'embedLanguage/iife');
        manager = mustReplace(manager, /this\.strings\s*=\s*\{\};/,
            `this.strings = EMBEDDED_STRINGS;`, 'embedLanguage/constructor');

        // Modify load() to skip fetch for English
        const oldLoad = /async load\(lang\s*=\s*['"]en['"]\)\s*\{[\s\S]*?try\s*\{[\s\S]*?const response = await fetch/;
        const newLoad = `async load(lang = 'en') {
            // Fast path: English is embedded
            if (lang === 'en') {
                this.isLoaded = true;
                this.debug('[Lang] Using embedded English strings.');
                return;
            }

            // Slow path: fetch other languages
            try {
                const response = await fetch`;

        manager = mustReplace(manager, oldLoad, newLoad, 'embedLanguage/load');

        writeFile(managerPath, manager);
        deleteFile(langPath);
        log(`  Embedded and removed en.json (${Object.keys(payload).length} namespaces)`);
    }

    embedToolsJSON() {
        log('Embedding tools.json into tool-library.js...');

        const toolsPath = path.join(this.distDir, CONFIG.embedTools);
        const libraryPath = path.join(this.distDir, 'ui/tool-library.js');

        if (!fs.existsSync(toolsPath) || !fs.existsSync(libraryPath)) {
            throw new Error(`embedTools: ${CONFIG.embedTools} or ui/tool-library.js missing in dist`);
        }

        const toolsData = JSON.parse(readFile(toolsPath));
        const toolsJSON = JSON.stringify(toolsData);
        let library = readFile(libraryPath);

        // Insert embedded constant (tool-library.js already checks for EMBEDDED_TOOLS natively)
        const embedCode = `\n    // BUILD: Embedded default tools\n    const EMBEDDED_TOOLS = ${toolsJSON};\n`;
        library = mustReplace(library, /\(function\(\)\s*\{\s*'use strict';/,
            `(function() {\n    'use strict';${embedCode}`, 'embedTools/iife');

        writeFile(libraryPath, library);
        deleteFile(toolsPath);
        log('  Embedded and removed tools.json');
    }

    embedLaserProfilesJSON() {
        log('Embedding laser-profiles.json into cam-controller.js...');

        const profilesPath = path.join(this.distDir, CONFIG.embedLaserProfiles);
        const controllerPath = path.join(this.distDir, 'core/cam-controller.js');

        if (!fs.existsSync(profilesPath) || !fs.existsSync(controllerPath)) {
            throw new Error(`embedLaserProfiles: ${CONFIG.embedLaserProfiles} or core/cam-controller.js missing in dist`);
        }

        const profilesData = JSON.parse(readFile(profilesPath));
        const profilesJSON = JSON.stringify(profilesData);
        let controller = readFile(controllerPath);

        const embedCode = `\n    // BUILD: Embedded laser profiles\n    const EMBEDDED_LASER_PROFILES = ${profilesJSON};\n`;
        controller = mustReplace(controller, /\(function\(\)\s*\{\s*'use strict';/,
            `(function() {\n    'use strict';${embedCode}`, 'embedLaserProfiles/iife');

        writeFile(controllerPath, controller);
        deleteFile(profilesPath);
        log('  Embedded and removed laser-profiles.json');
    }

    embedAppProfiles() {
        log('Embedding app profiles into controllers...');
        for (const profile of CONFIG.appProfiles) {
            const profilePath = path.join(this.distDir, profile.path);
            const targetPath = path.join(this.distDir, profile.target);

            if (!fs.existsSync(profilePath) || !fs.existsSync(targetPath)) {
                throw new Error(`appProfiles: ${profile.path} or ${profile.target} missing in dist`);
            }

            const profileData = JSON.parse(readFile(profilePath));
            // Strip metadata comments starting with _ or _comment
            const cleanObj = (obj) => {
                if (Array.isArray(obj)) return obj.map(cleanObj);
                if (obj !== null && typeof obj === 'object') {
                    return Object.fromEntries(
                        Object.entries(obj)
                            .filter(([k]) => !k.startsWith('_'))
                            .map(([k, v]) => [k, cleanObj(v)])
                    );
                }
                return obj;
            };
            const profileJSON = JSON.stringify(cleanObj(profileData));
            let targetContent = readFile(targetPath);

            const embedCode = `\n    // BUILD: Embedded App Profile\n    window.${profile.varName} = ${profileJSON};\n`;

            targetContent = mustReplace(
                targetContent,
                /\(function\(\)\s*\{\s*'use strict';/,
                `(function() {\n    'use strict';${embedCode}`,
                `appProfiles/${profile.varName}`
            );

            writeFile(targetPath, targetContent);
            deleteFile(profilePath); // Clean it up from the dist folder
            log(`  Embedded and removed ${profile.path}`);
        }
    }

    extractDependencies(htmlContent, htmlFilePath) {
        const css = [];
        const js = [];
        const htmlDir = path.dirname(htmlFilePath);

        // Map out every <!-- ... --> span so tags inside comments can be ignored
        const commentRanges = [];
        const commentRegex = /<!--[\s\S]*?-->/g;
        let c;
        while ((c = commentRegex.exec(htmlContent)) !== null) {
            commentRanges.push([c.index, c.index + c[0].length]);
        }
        const isCommented = (idx) => commentRanges.some(([s, e]) => idx >= s && idx < e);

        const cssRegex = /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
        let match;
        while ((match = cssRegex.exec(htmlContent)) !== null) {
            if (isCommented(match.index)) continue;
            css.push({ tag: match[0], relPath: match[1], absPath: path.resolve(htmlDir, match[1]) });
        }

        const jsRegex = /<script[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;
        while ((match = jsRegex.exec(htmlContent)) !== null) {
            if (isCommented(match.index)) continue;
            js.push({ tag: match[0], relPath: match[1], absPath: path.resolve(htmlDir, match[1]) });
        }

        return { css, js };
    }

    embedIconSprite() {
        log('Embedding icon sprite into HTML files...');

        const iconsDir = path.join(this.srcDir, 'images', 'icons');
        if (!fs.existsSync(iconsDir)) {
            log('  Warning: images/icons/ not found, skipping');
            return;
        }

        const symbols = [];
        const iconFiles = fs.readdirSync(iconsDir)
            .filter(f => f.startsWith('icon-') && f.endsWith('.svg'))
            .sort();

        for (const file of iconFiles) {
            const content = readFile(path.join(iconsDir, file));
            const id = file.replace('.svg', '');

            const vbMatch = content.match(/viewBox=["']([^"']+)["']/);
            const viewBox = vbMatch ? vbMatch[1] : '0 0 24 24';

            const svgTagMatch = content.match(/<svg([^>]*)>/i);
            let gAttrs = '';
            const allowedAttrs = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];

            if (svgTagMatch) {
                allowedAttrs.forEach(attr => {
                    const attrMatch = svgTagMatch[1].match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
                    if (attrMatch) gAttrs += ` ${attr}="${attrMatch[1]}"`;
                });
            }

            if (!gAttrs.includes('fill=')) gAttrs += ' fill="none"';
            if (!gAttrs.includes('stroke=')) gAttrs += ' stroke="currentColor"';
            if (!gAttrs.includes('stroke-width=')) gAttrs += ' stroke-width="2"';
            if (!gAttrs.includes('stroke-linecap=')) gAttrs += ' stroke-linecap="round"';
            if (!gAttrs.includes('stroke-linejoin=')) gAttrs += ' stroke-linejoin="round"';

            const innerMatch = content.match(/<svg[^>]*>([\s\S]*)<\/svg>/i);
            if (!innerMatch) continue;

            const inner = innerMatch[1].trim();
            symbols.push(`  <symbol id="${id}" viewBox="${viewBox}">\n    <g${gAttrs}>\n      ${inner}\n    </g>\n  </symbol>`);
        }

        if (symbols.length === 0) {
            log('  Warning: No icon SVGs found');
            return;
        }

        const spriteBlock = `<svg id="cam-icon-sprite" aria-hidden="true" style="position: absolute; width: 0; height: 0; visibility: hidden;">\n${symbols.join('\n')}\n</svg>`;

        // Remove sprite fetch call cleanly, accounting for nested parentheses inside .catch(...)
        const fetchScriptRegex = /[ \t]*(?:\/\/[^\r\n]*\r?\n[ \t]*)?fetch\(["'][^"']*images\/icons\/sprite\.svg["']\)[\s\S]*?\.catch\((?:[^()]|\([^()]*\))*\)\s*;?\r?\n?/g;

        // Inject into each app HTML
        for (const app of CONFIG.apps) {
            const htmlPath = path.join(this.distDir, app.html);
            if (!fs.existsSync(htmlPath)) continue;

            let html = readFile(htmlPath);

            // Inject sprite directly after <body> tag (supports attributes)
            html = html.replace(/<body\b[^>]*>/i, match => `${match}\n${spriteBlock}`);

            // Strip the inline fetch script
            html = html.replace(fetchScriptRegex, '');

            writeFile(htmlPath, html);
        }

        // Also inject into doc pages if they use icons
        for (const pagePath of this.docPages()) {
            let html = readFile(pagePath);
            if (html.includes('cam-icon')) {
                html = html.replace(/<body\b[^>]*>/i, match => `${match}\n${spriteBlock}`);
                
                // Strip the inline fetch script
                html = html.replace(fetchScriptRegex, '');
                
                writeFile(pagePath, html);
            }
        }

        log(`  Embedded ${symbols.length} icons as inline sprite`);
    }

    /**
     * Concatenate the field worker's importScripts dependencies into a
     * single self-contained dist/geometry/field-worker.js.
     */
    bundleFieldWorker() {
        const workerPath = path.join(this.distDir, 'geometry/field-worker.js');
        if (!fs.existsSync(workerPath)) return;

        let worker = readFile(workerPath);
        const m = worker.match(/importScripts\(([\s\S]*?)\);/);
        if (!m) return;

        // Strip line and block comments before extracting dependency file paths
        const cleanScriptArgs = m[1].replace(/\/\/[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const deps = [...cleanScriptArgs.matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);

        let inlinedBundle = '/* importScripts inlined by build */\n';
        for (const dep of deps) {
            const p = path.join(this.distDir, 'geometry', dep);
            if (!fs.existsSync(p)) {
                throw new Error(`field-worker importScripts dep not found in dist: ${dep}`);
            }
            inlinedBundle += `\n/*! --- ${this.repoPath(p)} --- */\n${stripComments(readFile(p), 'js', this.keepJsComments)}\n`;
        }

        // Inline dependencies inside ensureModules() where importScripts was,
        // ensuring self.CAMConfig is set before module IIFEs execute.
        worker = worker.replace(m[0], inlinedBundle);
        const finalContent = buildHeader('Field Worker', 'Bundled', 'js') + stripComments(worker, 'js', this.keepJsComments);
        writeFile(workerPath, finalContent);

        // Inlining succeeded - the standalone dep copies are now dead weight.
        for (const dep of deps) {
            deleteFile(path.join(this.distDir, 'geometry', dep));
        }
        log(`  Bundled field worker (${deps.length} deps inlined)`);
    }

    processApps() {
        log('Processing application entry points...');
        for (const app of CONFIG.apps) {
            const htmlPath = path.join(this.distDir, app.html);
            if (!fs.existsSync(htmlPath)) {
                throw new Error(`App entry point not found in dist: ${app.html}`);
            }

            let htmlContent = readFile(htmlPath).replace(/\0/g, '');

            // Strip the main header
            htmlContent = htmlContent.replace(/\s*<!--![\s\S]*?-->/g, '');

            // Strip <!-- AppName ... --> blocks (GPL prose)
            htmlContent = htmlContent.replace(/\s*<!--\s*Easy(?:Trace|Shape)5000[\s\S]*?-->/g, '');

            // Inject the new compact deployment header
            const htmlHeader = buildHeader(app.name, 'Main Workspace', 'html');
            if (htmlContent.match(/<!DOCTYPE[^>]*>/i)) {
                htmlContent = htmlContent.replace(/(<!DOCTYPE[^>]*>)/i, `$1\n${htmlHeader}\n`);
            } else {
                htmlContent = htmlHeader + '\n' + htmlContent; // Fallback
            }

            const deps = this.extractDependencies(htmlContent, htmlPath);

            let cssContents = buildHeader(app.name, 'Bundled Styles', 'css');
            for (const item of deps.css) {
                if (fs.existsSync(item.absPath)) {
                    cssContents += `/* ${this.repoPath(item.absPath)} */\n${stripComments(readFile(item.absPath), 'css', this.keepComments)}\n\n`;
                    this.processedFiles.add(item.absPath);
                    htmlContent = htmlContent.split(item.tag).join('');
                }
            }
            this.stats.css += cssContents.length;
            const styleTag = `\n    <style>\n${cssContents}    </style>\n`;
            htmlContent = htmlContent.replace('</head>', styleTag + '</head>');

            // REVIEW - Not very important but while this logic removes the comments, it doesn't remove the "new lines" where comments existed. (Everything is still handled by the deployment minifier)
            let jsContents = buildHeader(app.name, 'Bundled Logic', 'js');
            for (const item of deps.js) {
                if (!fs.existsSync(item.absPath)) {
                    throw new Error(`${app.html}: <script> ${item.relPath} not found in dist`);
                }
                let content = stripComments(readFile(item.absPath), 'js', this.keepJsComments);
                if (item.relPath.includes('clipper2z')) {
                    content = content.replace(/["'](\.?\/)?(geometry\/)?clipper2z\.wasm["']/g, '"../geometry/clipper2z.wasm"');
                }
                jsContents += `\n/*! --- ${this.repoPath(item.absPath)} --- */\n${content}\n`;
                this.processedFiles.add(item.absPath);
                htmlContent = htmlContent.split(item.tag).join('');
            }
            this.stats.js += jsContents.length;

            const bundleAbsPath = path.join(this.distDir, app.jsBundle);
            writeFile(bundleAbsPath, jsContents);

            let bundleRelPath = path.relative(path.dirname(htmlPath), bundleAbsPath).replace(/\\/g, '/');
            if (!bundleRelPath.startsWith('.')) bundleRelPath = './' + bundleRelPath;

            const bundleTag = `    \n    <script defer fetchpriority="high" src="${bundleRelPath}"></script>\n`;
            htmlContent = htmlContent.replace('</body>', `${bundleTag}</body>`);
            htmlContent = htmlContent.replace(/^\s*[\r\n]/gm, '');

            this.stats.html += htmlContent.length;
            writeFile(htmlPath, htmlContent);
            log(`  Processed ${app.html} -> generated ${app.jsBundle}`);
        }
    }

    processDocPages() {
        log('Processing documentation pages...');
        for (const pagePath of this.docPages()) {
            let htmlContent = readFile(pagePath).replace(/\0/g, '');

            // Inline doc figures so the built page needs no fetch.
            // Match any tag with data-figure regardless of attribute order or inner whitespace.
            const figureRegex = /<([a-z0-9]+)\b([^>]*?\bdata-figure=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
            htmlContent = htmlContent.replace(
                figureRegex,
                (match, tag, attrs, file, inner) => {
                    if (inner.includes('<svg')) return match;

                    let figurePath = path.join(this.srcDir, 'images', 'doc', file);
                    if (!fs.existsSync(figurePath)) {
                        const altPath = path.resolve(path.dirname(pagePath), file);
                        if (fs.existsSync(altPath)) {
                            figurePath = altPath;
                        } else {
                            console.warn(`  - Missing figure: ${file}`);
                            return match;
                        }
                    }

                    let svg = fs.readFileSync(figurePath, 'utf8')
                        .replace(/<\?xml[^>]*\?>\s*/i, '')
                        .replace(/<!DOCTYPE[^>]*>\s*/i, '')
                        .replace(/<metadata>[\s\S]*?<\/metadata>/gi, '')
                        .replace(/<script\b[\s\S]*?<\/script>/gi, '');

                    // Strip width and height only from the root <svg> element so child shapes (e.g. <rect>) retain dimensions
                    svg = svg.replace(/<svg\b([^>]*)>/i, (match, svgAttrs) => {
                        const cleanAttrs = svgAttrs.replace(/\s+(?:width|height)=["'][^"']*["']/gi, '');
                        return `<svg${cleanAttrs}>`;
                    });

                    // Strip data-figure-pending so inlined SVGs are immediately displayed
                    const cleanAttrs = attrs.replace(/\s*data-figure-pending(=["'][^"']*["'])?/gi, '');
                    return `<${tag}${cleanAttrs}>${svg}</${tag}>`;
                }
            );

            // Strip the original headers
            htmlContent = htmlContent.replace(/\s*<!--![\s\S]*?-->/g, '');
            htmlContent = htmlContent.replace(/\s*<!--\s*Easy(?:Trace|Shape)5000[\s\S]*?-->/g, '');

            // Inject the new compact deployment header
            const isLanding = path.basename(pagePath) === 'index.html' && path.dirname(pagePath) === this.distDir;
            const title = isLanding ? 'EasyCAM5000' : 'Documentation';
            const subtitle = isLanding ? 'Landing Page' : 'Manual';

            const htmlHeader = buildHeader(title, subtitle, 'html');
            if (htmlContent.match(/<!DOCTYPE[^>]*>/i)) {
                htmlContent = htmlContent.replace(/(<!DOCTYPE[^>]*>)/i, `$1\n${htmlHeader}\n`);
            } else {
                htmlContent = htmlHeader + '\n' + htmlContent;
            }

            const deps = this.extractDependencies(htmlContent, pagePath);

            let cssContents = buildHeader(title, 'Bundled Styles', 'css');
            for (const item of deps.css) {
                if (fs.existsSync(item.absPath)) {
                    cssContents += `/* ${this.repoPath(item.absPath)} */\n${stripComments(readFile(item.absPath), 'css', this.keepComments)}\n\n`;
                    htmlContent = htmlContent.split(item.tag).join('');
                }
            }

            if (deps.css.length > 0) {
                const styleTag = `\n    \n    <style>\n${cssContents}    </style>\n`;
                htmlContent = htmlContent.replace('</head>', styleTag + '</head>');
                log(` Inlined CSS for ${this.repoPath(pagePath)}`);
            }
            htmlContent = htmlContent.replace(/^\s*[\r\n]/gm, '');
            writeFile(pagePath, htmlContent);
        }
    }

    /**
     * One ESM file at the entry point's own path. Runs in BOTH dist states
     * so plain dist and minified dist have the same module graph - the three
     * states rule.
     */
    bundleRenderer3D() {
        const cfg = CONFIG.renderer3d;
        const dir = path.join(this.distDir, cfg.dir);
        if (!fs.existsSync(dir)) {
            log('  renderer3d/ not found, skipping 3D bundle');
            return;
        }

        let esbuild;
        try {
            esbuild = require('esbuild');
        } catch {
            throw new Error('renderer3d bundling needs esbuild:\n' +
                '  npm install esbuild --no-save');
        }

        const entry = path.join(this.distDir, cfg.entry);
        if (!fs.existsSync(entry)) throw new Error(`bundleRenderer3D: ${cfg.entry} not found in dist`);

        const alias = {};
        for (const [spec, rel] of Object.entries(cfg.alias)) {
            const target = path.join(this.distDir, rel);
            if (!fs.existsSync(target)) throw new Error(`bundleRenderer3D: alias target ${rel} not found in dist`);
            alias[spec] = target;
        }

        const result = esbuild.buildSync({
            entryPoints: [entry],
            bundle: true,
            format: 'esm',
            platform: 'browser',
            alias,
            legalComments: 'inline',
            write: false
        });

        const code = result.outputFiles[0].text;

        // Delete every other file in the directory BEFORE writing, so the bundle cannot be deleted by its own sweep.
        for (const f of fs.readdirSync(dir)) {
            const p = path.join(dir, f);
            if (p !== entry) deleteFile(p);
        }
        writeFile(entry, code);

        // The importmap only existed to resolve three/*; three is inlined now.
        for (const app of CONFIG.apps) {
            const htmlPath = path.join(this.distDir, app.html);
            if (!fs.existsSync(htmlPath)) continue;
            let html = readFile(htmlPath);
            html = html.replace(/[ \t]*<script type="importmap">[\s\S]*?<\/script>\r?\n?/g, '');
            writeFile(htmlPath, html);
        }

        log(`  Bundled renderer3d → ${cfg.entry} (${(code.length / 1024).toFixed(0)}KB)`);
    }

    cleanup() {
        log('Cleaning up bundled files and empty directories...');

        // CSS was inlined into all pages, safe to remove
        for (const filePath of this.processedFiles) {
            if (CONFIG.preserveFiles.some(p => filePath.endsWith(path.normalize(p)))) {
                log(`  Preserving ${path.basename(filePath)}`);
                continue;
            }
            deleteFile(filePath);
        }

        // Remove the icons directory since the sprite has been embedded into the HTML
        const iconsDir = path.join(this.distDir, 'images/icons');
        if (fs.existsSync(iconsDir)) {
            deleteDir(iconsDir);
            log('  Removed redundant images/icons directory');
        }

        // Clean any remaining empty directories
        const cleanEmptyDirs = (dir) => {
            if (!fs.existsSync(dir)) return;
            for (const item of fs.readdirSync(dir)) {
                const itemPath = path.join(dir, item);
                if (fs.statSync(itemPath).isDirectory()) {
                    cleanEmptyDirs(itemPath);
                    if (fs.readdirSync(itemPath).length === 0) {
                        fs.rmdirSync(itemPath);
                    }
                }
            }
        };

        cleanEmptyDirs(this.distDir);

        // Remove language folder if empty (en.json was deleted)
        const langDir = path.join(this.distDir, 'language');
        if (fs.existsSync(langDir) && fs.readdirSync(langDir).length === 0) deleteDir(langDir);
    }

    /**
     * Optional local minification (--minify).
     * It lives here so the deployment artifact can be reproduced and
     * tested locally.
     * Requires: npm install terser html-minifier-terser --no-save
     */
    async minify() {
        log('Minifying...');
        let terser, htmlMin;
        try {
            terser = require('terser');
            htmlMin = require('html-minifier-terser');
        } catch {
            throw new Error('--minify needs terser and html-minifier-terser:\n' +
                '  npm install terser html-minifier-terser --no-save');
        }

        const names = this.minifyMode === 'names';

        // /^!/ is what preserves the AGPL banner and the /*! --- path --- */ markers.
        // names mode keeps identifiers; compress still runs, so an unreferenced
        // helper inside an IIFE can be dropped.
        const jsOpts = {
            compress: true,
            mangle: !names,
            format: { comments: this.keepComments ? 'all' : /^!/ }
        };

        const jsTargets = [
            ...CONFIG.apps.map(a => a.jsBundle),
            'themes/theme-loader.js',
            'geometry/field-worker.js'
        ];

        if (fs.existsSync(path.join(this.distDir, 'images/figures.js'))) {
            jsTargets.push('images/figures.js');
        }

        // renderer3d is one ESM bundle by now; it still needs module:true.
        if (fs.existsSync(path.join(this.distDir, CONFIG.renderer3d.entry))) {
            jsTargets.push(CONFIG.renderer3d.entry);
        }

        for (const rel of jsTargets) {
            const p = path.join(this.distDir, rel);
            if (!fs.existsSync(p)) throw new Error(`minify: ${rel} not found in dist`);
            const out = await terser.minify(readFile(p), {
                ...jsOpts, module: rel.startsWith('renderer3d/')
            });
            writeFile(p, out.code);
        }
        log(`  Minified ${jsTargets.length} JS file(s)`);

        const walk = (dir, out = []) => {
            for (const item of fs.readdirSync(dir)) {
                const p = path.join(dir, item);
                if (fs.statSync(p).isDirectory()) walk(p, out);
                else out.push(p);
            }
            return out;
        };
        const all = walk(this.distDir);

        const jsonFiles = all.filter(f => f.endsWith('.json'));
        for (const p of jsonFiles) writeFile(p, JSON.stringify(JSON.parse(readFile(p))));
        log(`  Minified ${jsonFiles.length} JSON file(s)`);

        const htmlOpts = {
            collapseWhitespace: true,
            removeComments: true,
            ignoreCustomComments: [/^!/],
            caseSensitive: true,
            minifyCSS: true,
            minifyJS: names ? { mangle: false } : true
        };
        const htmlFiles = all.filter(f => f.endsWith('.html'));
        for (const p of htmlFiles) writeFile(p, await htmlMin.minify(readFile(p), htmlOpts));
        log(`  Minified ${htmlFiles.length} HTML file(s)`);
    }

    /**
     * dist/ must be self-contained. Every embed step deletes the file it
     * embedded, every bundling step deletes what it inlined, and all of it is
     * regex-driven - so the only check that means anything is whether the
     * output still points at something that is no longer there. This is what
     * catches a silently-failed embed, a deleted stylesheet an unlisted doc
     * page still links, and a wasm path the clipper rewrite missed.
     */
    verify() {
        log('Verifying dist references...');

        const walkAll = (dir, out = []) => {
            for (const item of fs.readdirSync(dir)) {
                const p = path.join(dir, item);
                if (fs.statSync(p).isDirectory()) walkAll(p, out);
                else out.push(p);
            }
            return out;
        };

        /*A commented-out <script> is not a reference. extractDependencies
        already knows this - it maps comment spans and skips matches inside
        them - and scanning the raw text here reported every disabled tag and
        every usage example in a file header as a missing file.*/
        const uncomment = (content, ext) => {
            if (ext === '.html') return content.replace(/<!--[\s\S]*?-->/g, '');
            return stripComments(content, ext === '.js' ? 'js' : 'css', false);
        };

        /*Doc pages link to clean URLs - href="guide", not "guide.html" - and
        the server resolves them. existsSync does not, so all 61 doc nav links
        read as broken. Resolve the way the host does before deciding.*/
        const resolves = (target) => fs.existsSync(target)
            || fs.existsSync(`${target}.html`)
            || fs.existsSync(path.join(target, 'index.html'));

        const problems = [];
        const seen = new Set();

        for (const file of walkAll(this.distDir)) {
            const ext = path.extname(file).toLowerCase();
            if (!['.html', '.js', '.css'].includes(ext)) continue;
            const content = uncomment(readFile(file), ext);
            const dir = path.dirname(file);

            const refs = [
                ...content.matchAll(/(?:src|href)\s*=\s*["']([^"'>]+)["']/gi),
                ...content.matchAll(/fetch\(\s*["']([^"']+\.(?:json|svg|wasm|txt))["']/gi),
                ...content.matchAll(/url\(\s*["']?([^"')]+\.(?:woff2?|ttf|otf|png|jpe?g|gif|webp|svg))["']?\s*\)/gi)
            ].map(m => m[1].split(/[?#]/)[0]).filter(Boolean);

            for (const ref of refs) {
                if (/^(?:https?:|data:|blob:|mailto:|javascript:|\/\/|#)/i.test(ref)) continue;
                const target = ref.startsWith('/')
                    ? path.join(this.distDir, ref)
                    : path.resolve(dir, ref);
                const key = `${file}>${target}`;
                if (seen.has(key)) continue;
                seen.add(key);
                if (!resolves(target)) problems.push(`${this.repoPath(file)} -> ${ref}`);
            }
        }

        if (problems.length) {
            throw new Error(`dist references ${problems.length} missing file(s):\n  ` + problems.join('\n  '));
        }
        log(`  ${seen.size} references resolve`);
    }

    printStats() {
        log('');
        log('Build complete!');
        log(`  CSS inlined: ${(this.stats.css / 1024).toFixed(1)}KB`);
        log(`  JS bundled:  ${(this.stats.js / 1024).toFixed(1)}KB`);
        log(`  HTML size:   ${(this.stats.html / 1024).toFixed(1)}KB`);
    }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
    const args = process.argv.slice(2);

    // Parse arguments
    let srcDir = '.';
    let distDir = './dist';
    let doMinify = false;
    let minifyMode = 'full';
    let keepComments = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--src' && args[i + 1]) srcDir = args[++i];
        else if (args[i] === '--dist' && args[i + 1]) distDir = args[++i];
        else if (args[i] === '--minify') doMinify = true;
        else if (args[i].startsWith('--minify=')) {
            doMinify = true;
            minifyMode = args[i].slice('--minify='.length);
            if (minifyMode !== 'full' && minifyMode !== 'names') {
                console.error(`Error: --minify must be 'full' or 'names', got '${minifyMode}'`);
                process.exit(1);
            }
        }
        else if (args[i].startsWith('--comments=')) {
            const mode = args[i].slice('--comments='.length);
            if (mode !== 'keep' && mode !== 'strip') {
                console.error(`Error: --comments must be 'keep' or 'strip', got '${mode}'`);
                process.exit(1);
            }
            keepComments = mode === 'keep';
        }
        else if (args[i] === '--help' || args[i] === '-h') {
            console.log(`
EasyCAM5000 Build Script

Usage: node build.js [options]

Options:
    --src <dir>       Source directory (default: current directory)
    --dist <dir>      Output directory (default: ./dist)
    --comments=MODE   strip (default) or keep. Keep produces a readable
                      bundle for review; deployment uses strip.
    --minify[=MODE]   full (default, deployment) or names. names keeps
                      identifiers readable while still compressing.
                      Needs: npm install terser html-minifier-terser --no-save
    --help, -h        Show this help

Examples:
    node build.js                                  # Build from . to ./dist
    node build.js --dist ./build                   # Build from . to ./build
    node build.js --comments=keep --dist ./llm     # Readable bundle
    node build.js --minify=names --dist ./llm      # Compressed, names intact
`);
            process.exit(0);
        }
    }

    // Validate source exists
    if (!fs.existsSync(srcDir)) {
        console.error(`Error: Source directory '${srcDir}' does not exist`);
        process.exit(1);
    }

    // Run build
    const builder = new Builder(srcDir, distDir, { keepComments, minifyMode, willMinify: doMinify });
    builder.run();
    if (doMinify) await builder.minify();
}

main().catch(err => {
    console.error(`[build] ${err.message}`);
    process.exit(1);
});