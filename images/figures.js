/*!
 * @file        images/figures.js
 * @description Inlines standalone SVG files so they inherit the page theme
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * An <img src="x.svg"> is an isolated document: it cannot read the page's
 * custom properties or its data-theme attribute, so a themed figure has to be
 * part of the DOM. This fetches each placeholder's file and injects it.
 *
 *   <div class="doc-figure" data-figure="fig-trace-tree.svg"></div>
 *
 * data-figure-base overrides the directory, for pages at other depths:
 *
 *   <div class="doc-figure" data-figure="x.svg" data-figure-base="/images/doc/"></div>
 *
 * The build inlines the same files into the same placeholders, so a built page
 * never runs this. Loading it twice is harmless - a filled placeholder is
 * skipped.
 */

(function () {
    'use strict';

    // fetch() resolves against the PAGE, not this file. currentScript is only
    // set while this file's top level runs, so the base is captured here.
    const DEFAULT_BASE = new URL('doc/', document.currentScript.src).href;
    const SELECTOR = '[data-figure]';

    /**
     * Strips anything that has no business in an inlined document fragment.
     * These files are ours, but they are still fetched at runtime.
     */
    function sanitize(svg) {
        svg.querySelectorAll('script, foreignObject, metadata').forEach(n => n.remove());
        svg.querySelectorAll('*').forEach(node => {
            [...node.attributes].forEach(attr => {
                if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
            });
        });
        return svg;
    }

    async function loadFigure(host) {
        if (host.querySelector("svg")) {
            host.removeAttribute("data-figure-pending");
            return; // already inlined by the build
        }
        const file = host.dataset.figure;
        if (!file) return;
        const base = host.dataset.figureBase || DEFAULT_BASE;
        try {
            const response = await fetch(base + file);
            if (!response.ok) throw new Error(response.status + " " + response.statusText);
            const doc = (new DOMParser).parseFromString(await response.text(), "image/svg+xml");
            const svg = doc.querySelector("svg");
            if (!svg || doc.querySelector("parsererror")) throw new Error("not a valid SVG");
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            host.appendChild(sanitize(document.importNode(svg, true)));
            host.removeAttribute("data-figure-pending");
        } catch (error) {
            host.setAttribute("data-figure-failed", "");
            console.warn("[figures] could not load " + file + ":", error.message);
        }
    }

    function init() {
        document.querySelectorAll(SELECTOR).forEach(host => {
            if (host.querySelector("svg")) return; // skip pending marker if already inlined
            host.setAttribute("data-figure-pending", "");
            loadFigure(host);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();