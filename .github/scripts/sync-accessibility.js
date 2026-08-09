/*!
 * @file        .github/scripts/sync-accessibility.js
 * @description Syncs doc/ACCESSIBILITY.md to doc/accessibility.html
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const CONFIG = {
    input: 'easytrace5000/doc/ACCESSIBILITY.md',
    output: 'easytrace5000/doc/accessibility.html',
    cssPath: '../../css',
    themeScriptPath: '../../themes/theme-loader.js',
    githubUrl: 'https://github.com/RicardoJCMarques/EasyCAM5000',
    siteUrl: 'https://cam.eltryus.design'
};

/**
 * Helper: Turn "Keyboard Navigation" into "keyboard-navigation"
 */
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\s-]/g, '') // Remove non-word chars
        .trim()
        .replace(/\s+/g, '-');    // Replace spaces with dashes
}

/**
 * Formats HTML with robust hierarchical indentation.
 */
function formatAndIndent(html, baseSpaces) {
    const indentSize = 4;
    const basePadding = ' '.repeat(baseSpaces);

    // Tags that must sit on their own line to structure the document
    const blockTags = [
        'html', 'head', 'body', 
        'div', 'main', 'nav', 'header', 'footer', 'section', 'article', 'aside', 
        'ul', 'ol', 'li', 'dl', 'dt', 'dd', 
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 
        'blockquote', 'form', 'fieldset', 'figure', 'figcaption',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 
        'button'
    ];

    // Tags that must not be formatted internally
    const preserveTags = ['pre', 'script', 'style', 'textarea'];
    const placeholders = [];

    // Extract protected blocks (pre/script/etc) to avoid messing up their whitespace
    let protectedHtml = html.replace(new RegExp(`(<(${preserveTags.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\2>)`, 'gi'), (match) => {
        placeholders.push(match);
        return `___PLACEHOLDER_${placeholders.length - 1}___`;
    });

    // Flatten remaining HTML
    let cleanHtml = protectedHtml.replace(/\r\n|\r|\n/g, '');

    // Aggressively insert newlines around BLOCK tags
    // This ensures </li> always ends up on its own line, even if preceded by <code>...</code>
    const tagPattern = blockTags.join('|');
    const blockRegex = new RegExp(`(<\\/?(?:${tagPattern})(?:\\s+[^>]*)?>)`, 'gi');
    cleanHtml = cleanHtml.replace(blockRegex, '\n$1\n');

    // Split into lines and trim
    const tokens = cleanHtml.split('\n').map(line => line.trim()).filter(line => line.length > 0);

    // Indent
    let depth = 0;
    const voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'];

    let formatted = tokens.map(line => {
        const isClosing = line.match(/^<\//);
        const isOpening = line.match(/^<[a-zA-Z]/);
        const isSelfClosing = line.match(/\/>$/);

        let tagName = '';
        if (isOpening || isClosing) {
            const match = line.match(/^<\/?([a-zA-Z0-9-]+)/);
            if (match) tagName = match[1].toLowerCase();
        }

        const isBlock = blockTags.includes(tagName);
        const isVoid = voidTags.includes(tagName);

        // Decrease depth Before printing a closing block tag
        if (isClosing && isBlock) {
            depth = Math.max(0, depth - 1);
        }

        const output = basePadding + ' '.repeat(depth * indentSize) + line;

        // Increase depth After printing an opening block tag (that isn't self-closing or void)
        if (isOpening && isBlock && !isClosing && !isSelfClosing && !isVoid) {
            depth++;
        }

        return output;
    }).join('\n');

    // Restore protected blocks
    placeholders.forEach((content, index) => {
        // Indent the placeholder line itself to match flow, but NOT the internal content
        formatted = formatted.replace(`___PLACEHOLDER_${index}___`, content);
    });

    return formatted;
}

// Sidebar Parser (Extracts TOC)
function parseSidebar(mdContent) {
    const tocRegex = /## Table of Contents\s+([\s\S]*?)\s+---/;
    const match = mdContent.match(tocRegex);

    if (!match) {
        console.warn('Warning: No "Table of Contents" found.');
        return '';
    }

    const lines = match[1].split(/\r?\n/).filter(line => line.trim().length > 0);

    let html = '<ol>';
    lines.forEach(line => {
        const linkMatch = line.match(/-\s+\[(.*?)\]\((.*?)\)/);
        if (linkMatch) {
            const title = linkMatch[1];
            const slug = slugify(title);
            html += `<li><a href="#${slug}" draggable="false">${title}</a></li>`;
        }
    });
    html += '</ol>';
    return html;
}

// HTML Post-Processor (Injects IDs into Headings)
function injectHeadingIds(htmlContent) {
    return htmlContent.replace(/<h([2-6])>(.*?)<\/h\1>/g, (match, level, content) => {
        const textOnly = content.replace(/<[^>]*>/g, '');
        const slug = slugify(textOnly);
        return `<h${level} id="${slug}">${content}</h${level}>`;
    });
}

// HTML Template
const getTemplate = (sidebarHtml, mainBodyHtml, heroTitle, tagline) => `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
    <meta charset="UTF-8">
    <!--!
        @file        index.html
        @description EasyTrace5000 | Accessibility Information
        @author      Eltryus - Ricardo Marques
        @copyright   2025-2026 Eltryus - Ricardo Marques
        @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
        
        SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
        SPDX-License-Identifier: AGPL-3.0-or-later
    -->
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>EasyTrace5000 | Accessibility Information</title>

    <meta name="description" content="Accessibility information for EasyTrace5000. Details on keyboard navigation, focus management, screen reader support, and WCAG 2.1 compliance.">
    <meta name="author" content="Eltryus">
    <meta name="robots" content="index, follow">
    <meta name="theme-color" content="#1a1a1a">

    <link rel="canonical" href="${CONFIG.siteUrl}/easytrace5000/doc/accessibility">

    <meta property="og:type" content="article">
    <meta property="og:url" content="${CONFIG.siteUrl}/easytrace5000/doc/accessibility">
    <meta property="og:title" content="EasyTrace5000 | Accessibility">
    <meta property="og:description" content="Keyboard controls and accessibility compliance for EasyTrace5000.">
    <meta property="og:image" content="${CONFIG.siteUrl}/images/social-trace.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:site_name" content="Eltryus EasyCAM5000 Suite">
    <meta property="og:locale" content="en_US">

    <link rel="icon" type="image/png" href="../../images/favicon/favicon-96x96.png" sizes="96x96">
    <link rel="icon" type="image/svg+xml" href="../../images/favicon/favicon.svg">
    <link rel="shortcut icon" href="../../images/favicon/favicon.ico">
    <link rel="apple-touch-icon" sizes="180x180" href="../../images/favicon/apple-touch-icon.png">
    <link rel="manifest" href="../../images/favicon/site.webmanifest">

    <link rel="stylesheet" href="${CONFIG.cssPath}/base.css">
    <link rel="stylesheet" href="${CONFIG.cssPath}/components.css">
    <link rel="stylesheet" href="${CONFIG.cssPath}/theme.css">
    <link rel="stylesheet" href="${CONFIG.cssPath}/doc.css">

    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "TechArticle",
                "@id": "${CONFIG.siteUrl}/easytrace5000/doc/accessibility#article",
                "headline": "Accessibility Information for EasyTrace5000",
                "description": "Accessibility information for EasyTrace5000. Details on keyboard navigation, focus management, screen reader support, and WCAG 2.1 compliance.",
                "image": "${CONFIG.siteUrl}/images/social-trace.jpg",
                "url": "${CONFIG.siteUrl}/easytrace5000/doc/accessibility",
                "inLanguage": "en",
                "isPartOf": { "@id": "${CONFIG.siteUrl}/easytrace5000/doc/#docs" },
                "about": { "@id": "${CONFIG.siteUrl}/easytrace5000/#app" },
                "author": { "@id": "https://www.eltryus.design/#organization" },
                "publisher": { "@id": "https://www.eltryus.design/#organization" },
                "datePublished": "2025-01-16",
                "dateModified": "2026-05-16"
            },
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": "Eltryus EasyCAM5000 Suite", "item": "${CONFIG.siteUrl}/" },
                    { "@type": "ListItem", "position": 2, "name": "EasyTrace5000", "item": "${CONFIG.siteUrl}/easytrace5000/" },
                    { "@type": "ListItem", "position": 3, "name": "Documentation", "item": "${CONFIG.siteUrl}/easytrace5000/doc/" },
                    { "@type": "ListItem", "position": 4, "name": "Accessibility", "item": "${CONFIG.siteUrl}/easytrace5000/doc/accessibility" }
                ]
            }
        ]
    }
    </script>
</head>
<body>
    <!-- Skip link for keyboard accessibility -->
    <a href="#doc-content" class="skip-link" aria-label="Skip to main content">Skip to Main Content</a>

    <!-- Header -->
    <header class="doc-header">
        <div class="doc-brand">
            <a href="/" aria-label="EasyCAM5000 Homepage">EasyCAM5000</a>
        </div>

        <button class="doc-menu-toggle" aria-label="Toggle Navigation Menu" aria-expanded="false">
            <svg class="icon-menu" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
            <svg class="icon-close" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        </button>

        <nav class="doc-nav" aria-label="Main Navigation">
            <a href="/" draggable="false" aria-label="Return to Homepage">← Home</a>
            <a href="/easytrace5000/" draggable="false" aria-label="Launch Workspace">Launch App</a>
            <span class="separator" aria-hidden="true"></span>

            <a href="./" draggable="false" aria-label="Documentation Index">Docs</a>
            <a href="cnc" draggable="false" aria-label="CNC Milling Guide">CNC Guide</a>
            <a href="laser" draggable="false" aria-label="Laser Processing Guide">Laser Guide</a>
            <a href="operations" draggable="false" aria-label="Operation Reference">Operations</a>
            <a href="parameters" draggable="false" aria-label="Parameter Reference">Parameters</a>
            <a href="accessibility" class="active" draggable="false" aria-current="page" aria-label="Accessibility Statement">Accessibility</a>
            <span class="separator" aria-hidden="true"></span>
            <a href="https://github.com/RicardoJCMarques/EasyCAM5000" target="_blank" draggable="false" aria-label="GitHub Repository (opens in a new tab)">GitHub</a>

            <button id="theme-toggle" class="btn btn--icon" title="Toggle Theme" aria-label="Toggle Theme">
                <svg class="cam-icon" width="16" height="16"><use href="#icon-sun"></use></svg>
            </button>
        </nav>
    </header>

    <div class="doc-wrapper has-sidebar">
        <!-- Sidebar TOC -->
        <nav class="doc-sidebar" aria-label="Table of Contents">
            <h2>${heroTitle}</h2> ${sidebarHtml}
        </nav>

        <!-- Main Content -->
        <main id="doc-content" class="doc-main" aria-label="Main Content">
            <section class="hero hero--compact">
                <h1>${heroTitle}</h1>
                <p class="tagline">${tagline}</p>
            </section>

${mainBodyHtml}

        </main>
        <!-- Footer -->
        <footer class="doc-footer" aria-label="Footer">
            <p>
                <a href="#doc-content" draggable="false" aria-label="Scroll back to top">Back to Top</a> |
                <a href="${CONFIG.githubUrl}" target="_blank" draggable="false" aria-label="GitHub Repository (opens in a new tab)">GitHub</a> |
                <a href="/#support" draggable="false" aria-label="Support Development via Sponsorship">Support Development</a> |
                <a href="../../LICENSE" target="_blank" draggable="false" aria-label="AGPLv3 License (opens in a new tab)">AGPLv3 Licensed</a>
            </p>
        </footer>
    </div>

    <!-- Scripts -->
    <script defer src="${CONFIG.themeScriptPath}"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            // Load the SVG Sprite
            fetch('../../images/icons/sprite.svg')
                .then(response => {
                    if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
                    return response.text();
                })
                .then(svgText => {
                    const div = document.createElement('div');
                    div.innerHTML = svgText;
                    const svg = div.querySelector('svg');
                    if (svg) {
                        svg.setAttribute('aria-hidden', 'true');
                        svg.style.cssText = 'position: absolute; width: 0; height: 0; visibility: hidden;';
                        document.body.insertBefore(svg, document.body.firstChild);
                    }
                })
                .catch(err => console.warn('Failed to load icon sprite:', err));

            // Theme toggle logic
            const themeBtn = document.getElementById('theme-toggle');
            if (themeBtn && window.ThemeLoader) {
                const useEl = themeBtn.querySelector('use');
                const initialTheme = document.documentElement.getAttribute('data-theme') || 'dark';

                if (useEl) useEl.setAttribute('href', initialTheme === 'dark' ? '#icon-sun' : '#icon-moon');

                themeBtn.addEventListener('click', async () => {
                    const theme = await window.ThemeLoader.toggleTheme();
                    if (useEl) useEl.setAttribute('href', theme === 'dark' ? '#icon-sun' : '#icon-moon');
                });
            }

            // Mobile Menu Logic
            const menuBtn = document.querySelector('.doc-menu-toggle');
            const nav = document.querySelector('.doc-nav');

            if (menuBtn && nav) {
                const useEl = menuBtn.querySelector('use');
                menuBtn.addEventListener('click', () => {
                    const isExpanded = menuBtn.getAttribute('aria-expanded') === 'true';
                    menuBtn.setAttribute('aria-expanded', !isExpanded);
                    nav.classList.toggle('is-open');

                    if (useEl) useEl.setAttribute('href', !isExpanded ? '#icon-close' : '#icon-menu');
                });
            }
        });
    </script>
</body>`;

function main() {
    try {
        const mdContent = fs.readFileSync(path.resolve(CONFIG.input), 'utf8');

        // Split by double-newlines to get separate blocks
        const blocks = mdContent.split(/\r?\n\s*\r?\n/).filter(b => b.trim().length > 0);

        // Extract Hero Title (Block 0)
        const heroTitle = blocks[0].replace(/^#+\s*/, '').trim();

        // Extract Tagline (Block 1)
        const tagline = blocks[1].trim();

        // Prepare Body Content
        // Filter out any block that contains "Table of Contents" OR consists of just the horizontal rule "---" OR contains only markdown links formatted like [Title](#slug)
        const bodyBlocks = blocks.slice(2).filter(block => {
            const isTOCHeader = block.includes('## Table of Contents');
            const isHorizontalRule = block.trim() === '---';
            const isTOCList = block.trim().match(/^[-*]\s+\[.*\]\(#.*\)/m);

            return !isTOCHeader && !isHorizontalRule && !isTOCList;
        });

        const bodyMd = bodyBlocks.join('\n\n');

        // Convert remaining Markdown to HTML
        const tempFile = 'temp_acc_body.md';
        fs.writeFileSync(tempFile, bodyMd);
        const rawHtmlBody = execSync(`npx marked -i ${tempFile} --gfm --breaks`, { encoding: 'utf8' });
        fs.unlinkSync(tempFile);

        // Generate Sidebar and Post-Process Body
        const sidebarHtml = parseSidebar(mdContent);
        const finalHtmlBody = injectHeadingIds(rawHtmlBody);

        // Formatting & Indentation
        const indentedSidebar = formatAndIndent(sidebarHtml, 12);
        const indentedBody = formatAndIndent(finalHtmlBody, 12);

        // Write final file using the updated template
        const fullHtml = getTemplate(indentedSidebar, indentedBody, heroTitle, tagline);

        const outputDir = path.dirname(CONFIG.output);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        fs.writeFileSync(path.resolve(CONFIG.output), fullHtml);
        console.log(`✅ Success! Generated ${CONFIG.output}.`);

    } catch (error) {
        console.error('❌ Build failed:', error.message);
    }
}

main();