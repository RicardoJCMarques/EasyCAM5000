/*!
 * @file        easytrace5000/ui-nav-tree-panel.js
 * @description EasyTrace5000 Operations tree navigation panel.
 *              Click handlers emit events via on()/emit() so cam-ui.js
 *              decides what mutations to run.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class NavTreePanel extends EventEmitter {
        constructor(ui) {
            // Event emitter
            super();

            this.ui = ui;
            this.core = ui.core;
            this.lang = ui.lang;
            this.nodes = new Map();
            this.selectedNode = null;
            this.nextNodeId = 1;
            this.initialized = false;
            this.treeContainer = null;

            // Onboarding (session-only)
            this.suggestionTimer = null;
            this.suggestionInterval = null;
            this.suggestionDismissed = false;
            this.highlightIndex = -1;
        }

        // ═══════════════════════════════════════════════════════════════
        // Initialization
        // ═══════════════════════════════════════════════════════════════

        init() {
            if (this.initialized) return;

            this.treeContainer = document.getElementById('operations-tree');
            this.setupCategories();
            this.setupKeyboardNavigation();

            this.initialized = true;
            this.debug('NavTreePanel initialized');
        }

        // ═══════════════════════════════════════════════════════════════
        // Categories
        // ═══════════════════════════════════════════════════════════════

        setupCategories() {
            document.querySelectorAll('.operation-category').forEach(category => {
                const header = category.querySelector('.category-header');
                const opType = category.dataset.opType;
                if (header) {
                    // Make the entire header trigger the file input
                    header.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.emit('categoryClick', opType);
                    });
                }
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // File nodes
        // ═══════════════════════════════════════════════════════════════

        addFileNode(operation) {
            const category = document.querySelector(`.operation-category[data-op-type="${operation.type}"] .category-files`);
            if (!category) {
                console.error(`[NavTreePanel] Category not found for operation type: ${operation.type}`);
                return null;
            }

            const fileId = `file_${this.nextNodeId++}`;
            const template = document.getElementById('file-node-template');
            if (!template) return null;

            const fileNode = template.content.cloneNode(true);
            const nodeElement = fileNode.querySelector('.file-node');

            nodeElement.dataset.fileId = fileId;
            nodeElement.dataset.operationId = operation.id;

            const content = nodeElement.querySelector('.file-node-content');
            const label = nodeElement.querySelector('.file-label');
            const deleteBtn = nodeElement.querySelector('.delete-btn');
            const visBtn = nodeElement.querySelector('.visibility-btn');

            // ARIA attributes for keyboard navigation
            content.setAttribute('role', 'treeitem');
            content.setAttribute('tabindex', '-1');
            content.setAttribute('aria-selected', 'false');
            content.setAttribute('aria-level', '2');

            // Setup geometries container with group role
            const geometriesContainer = nodeElement.querySelector('.file-geometries');
            if (geometriesContainer) geometriesContainer.setAttribute('role', 'group');

            if (deleteBtn) {
                deleteBtn.setAttribute('aria-label', `Delete ${operation.file.name}`);
                deleteBtn.setAttribute('tabindex', '-1');
            }
            if (visBtn) {
                visBtn.setAttribute('aria-label', `Toggle visibility of ${operation.file.name}`);
                visBtn.setAttribute('tabindex', '-1');
            }

            // Visibility button
            if (visBtn) {
                const layerName = window.LayerNaming.source(operation.id);
                visBtn.dataset.layerName = layerName;

                visBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this.emit('action', { id: operation.id, action: 'visibility', artifactKey: 'source', layerName, element: visBtn });
                });
            }

            label.textContent = operation.file.name;
            label.title = operation.file.name;

            // Content click → select
            content.addEventListener('click', (e) => {
                if (e.target.closest('.btn-icon')) return;
                this.setFocusOnItem(document.querySelector('#operations-tree [tabindex="0"]'), content);
                this.activateFileNode(content);
            });

            // Delete button
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.emit('action', { id: operation.id, action: 'delete' });
                });
            }

            this.nodes.set(fileId, {
                id: fileId,
                type: 'file',
                operation: operation,
                element: nodeElement,
                geometries: new Map()
            });

            category.appendChild(fileNode);
            this.updateFileGeometries(fileId, operation);

            // Onboarding suggestion, restarted by every new file so a
            // multi-file load waits for the last one.
            if (!this.suggestionDismissed) {
                clearTimeout(this.suggestionTimer);
                this.suggestionTimer = setTimeout(() => {
                    this.suggestionTimer = null;
                    this.startSuggestionCycle();
                }, 12500);
            }

            return fileId;
        }

        updateFileGeometries(fileId, operation) {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;
            const geometriesContainer = fileData.element.querySelector('.file-geometries');
            if (!geometriesContainer) return;
            geometriesContainer.innerHTML = '';
            fileData.geometries.clear();
            const isLaser = this.core.machineClassOf(operation) === 'laser';
            const mm = (distance) => `${distance.toFixed(2)}mm`;
            const offsets = operation.offsets || [];
            // Offset nodes. A laser operation always shows one combined node.
            if (offsets.length > 0 && (offsets[0].metadata?.offset?.combined || isLaser)) {
                const passes = offsets[0].metadata?.offset?.passes || offsets.length;
                const label = isLaser ? 'Laser Paths' : `Offsets (${passes} Passes)`;
                this.addGeometryNode(fileId, 'offsets_combined', label, mm(offsets[0].distance));
            } else {
                offsets.forEach((offset, index) => {
                    this.addGeometryNode(fileId, `offset_${index}`, `Pass ${index + 1}`, mm(offset.distance));
                });
            }
            // Preview node - CNC only. In laser mode, offsets are the exportable result.
            if (!isLaser && operation.preview?.primitives) this.addGeometryNode(fileId, 'preview', 'Preview');
            // Toolpath node - one per operation, however many plans it holds.
            if (this.core.store.getToolpaths(operation.id)?.plans?.length) { this.addGeometryNode(fileId, 'toolpath', 'Toolpaths'); }
            this.paintEyes(fileId);
            // Update aria-expanded based on populated geometries
            const fileContent = fileData.element.querySelector('.file-node-content');
            if (fileContent) {
                if (geometriesContainer.children.length > 0) {
                    fileContent.setAttribute('aria-expanded', 'true');
                } else {
                    fileContent.removeAttribute('aria-expanded');
                }
            }
        }

        addGeometryNode(fileId, geometryType, label, info = '') {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;
            const template = document.getElementById('geometry-node-template');
            if (!template) return;
            const geometryNode = template.content.cloneNode(true);
            const nodeElement = geometryNode.querySelector('.geometry-node');
            const geometryId = `geometry_${this.nextNodeId++}`;
            nodeElement.dataset.geometryId = geometryId;
            nodeElement.dataset.geometryType = geometryType;
            const content = nodeElement.querySelector('.geometry-node-content');
            const iconEl = nodeElement.querySelector('.geometry-icon');
            const labelEl = nodeElement.querySelector('.geometry-label');
            const infoEl = nodeElement.querySelector('.geometry-info');
            const visBtn = nodeElement.querySelector('.visibility-btn');
            const deleteBtn = nodeElement.querySelector('.delete-geometry-btn');
            // ARIA attributes for keyboard navigation
            content.setAttribute('role', 'treeitem');
            content.setAttribute('tabindex', '-1');
            content.setAttribute('aria-selected', 'false');
            content.setAttribute('aria-level', '3');
            nodeElement.querySelectorAll('.btn-icon').forEach((b) => b.setAttribute('tabindex', '-1'));
            // Same sprites as EasyShape's bucket tree: every offset node is the 'offsets' artifact.
            const iconId = this.core.registry.artifactIcon(geometryType.startsWith('offset') ? 'offsets' : geometryType);
            iconEl.innerHTML = `<svg class="cam-icon" width="14" height="14"><use href="#${iconId}"></use></svg>`;
            labelEl.textContent = label;
            // Invalidation styling takes priority
            if (fileData.operation.isInvalidated && geometryType.startsWith('offset')) {
                nodeElement.classList.add('is-invalidated');
                labelEl.style.textDecoration = 'line-through';
                labelEl.style.color = 'var(--color-error, #ff4444)';
                infoEl.textContent = 'Invalid';
                infoEl.style.color = 'var(--color-error, #ff4444)';
            } else {
                infoEl.textContent = info;
            }
            content.addEventListener('click', (e) => {
                if (e.target.closest('.btn-icon')) return;
                this.setFocusOnItem(document.querySelector('#operations-tree [tabindex="0"]'), content);
                this.activateGeometryNode(content);
            });
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.emit('deleteGeometry', { fileId, geometryId });
                });
            }
            // A toolpath has no 2D layer - it is drawn by the 3D view - so
            // layerName stays null there and the record alone drives it.
            if (visBtn) {
                const operationId = fileData.operation.id;
                const artifactKey = NavTreePanel.artifactKeyOf(geometryType);
                let layerName = null;
                if (geometryType === 'offsets_combined') {
                    layerName = window.LayerNaming.offsetCombined(operationId);
                } else if (geometryType.startsWith('offset_')) {
                    const passIndex = parseInt(geometryType.split('_')[1]);
                    layerName = window.LayerNaming.offsetPass(operationId, passIndex + 1);
                } else if (geometryType === 'preview') {
                    layerName = window.LayerNaming.preview(operationId);
                }
                visBtn.dataset.layerName = layerName || '';
                visBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.emit('action', { id: operationId, action: 'visibility', artifactKey, layerName, element: visBtn });
                });
            }
            fileData.geometries.set(geometryId, { id: geometryId, type: geometryType, label, element: nodeElement });
            const container = fileData.element.querySelector('.file-geometries');
            if (container) {
                container.appendChild(geometryNode);
                // Update aria-setsize and aria-posinset for all geometry siblings
                this.updateGeometrySetInfo(fileId);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Selection
        // ═══════════════════════════════════════════════════════════════

        selectFile(fileId, operation) {
            // Dismiss onboarding suggestion - user discovered the workflow
            this.dismissSuggestion();

            // Clear previous selections
            document.querySelectorAll('.file-node-content.selected, .geometry-node.selected').forEach(el => {
                el.classList.remove('selected');
            });
            document.querySelectorAll('[aria-selected="true"]').forEach(el => {
                el.setAttribute('aria-selected', 'false');
            });

            const fileData = this.nodes.get(fileId);
            if (fileData) {
                const content = fileData.element.querySelector('.file-node-content');
                if (content) {
                    content.classList.add('selected');
                    content.setAttribute('aria-selected', 'true');
                }
            }

            this.selectedNode = { type: 'file', id: fileId, operation };
            this.ui.ctrl.setViewportForNode(null, operation);
            this.emit('select', { id: fileId, kind: 'file', operation, stage: 'geometry' });
        }

        selectGeometry(geometryId, operation, geometryType) {
            // Clear previous selections
            document.querySelectorAll('.file-node-content.selected, .geometry-node.selected').forEach(el => {
                el.classList.remove('selected');
            });
            document.querySelectorAll('[aria-selected="true"]').forEach(el => {
                el.setAttribute('aria-selected', 'false');
            });

            const geometryNode = document.querySelector(`.geometry-node[data-geometry-id="${geometryId}"]`);
            if (geometryNode) {
                geometryNode.classList.add('selected');
                const content = geometryNode.querySelector('.geometry-node-content');
                if (content) content.setAttribute('aria-selected', 'true');
            }

            this.selectedNode = { type: 'geometry', id: geometryId, operation, geometryType };

            // Artifact node - the form that produces the NEXT artifact.
            // Same invariant the bucket tree uses: node i shows stages[i+1].
            const cls = this.ui.ctrl.core.machineClassOf(operation) || 'router';
            const pm = this.ui.ctrl.parameterStore;
            const stages = pm.getStages(operation.type, cls);
            const artifacts = pm.getArtifacts(operation.type, cls);

            const artifact = geometryType === 'toolpath' ? 'toolpath'
                           : geometryType === 'preview' ? 'preview'
                           : (geometryType.startsWith('offset') || geometryType === 'offsets_combined')
                               ? 'offsets' : null;

            const idx = artifact ? artifacts.indexOf(artifact) : -1;
            const stage = idx === -1 ? 'geometry' : (stages[idx + 1] || stages[stages.length - 1]);

            // Viewport follows the artifact, not a global mode.
            this.ui.ctrl.setViewportForNode(artifact, operation);

            this.emit('select', { id: geometryId, kind: 'geometry', operation, geometryType, stage });
        }

        cycleOperationCategory(opType) {
            const items = [];
            this.nodes.forEach((data) => {
                if (data.type !== 'file' || data.operation?.type !== opType) return;
                items.push({ kind: 'file', id: data.id, operation: data.operation });
                data.geometries.forEach((geo, geoId) => {
                    items.push({ kind: 'geometry', id: geoId, operation: data.operation, geometryType: geo.type });
                });
            });
            if (items.length === 0) return;

            const currentId = this.selectedNode?.id;
            const currentIndex = items.findIndex(item => item.id === currentId);
            const nextIndex = (currentIndex + 1) % items.length;
            const next = items[nextIndex];

            if (next.kind === 'file') this.selectFile(next.id, next.operation);
            else this.selectGeometry(next.id, next.operation, next.geometryType);
        }

        // ═══════════════════════════════════════════════════════════════
        // Layer visibility, removal
        // ═══════════════════════════════════════════════════════════════

        /**
         * The Record is the truth; the renderer layer is a consequence of it.
         * @param {string} artifactKey - source/offsets/offset_N/preview/toolpath,
         *                               the same keyspace refresh3D reads.
         * @param {string} layerName   - the renderer layer, when one exists.
         */
        toggleLayerVisibility(button, artifactKey, layerName) {
            if (!artifactKey) return;
            const fileId = button.closest('.file-node')?.dataset.fileId;
            const operation = this.nodes.get(fileId)?.operation;
            if (!operation) return;
            operation.layerVisibility ||= {};
            const visible = operation.layerVisibility[artifactKey] === false;
            operation.layerVisibility[artifactKey] = visible;
            // Repaint from the record, not from whether a layer happened to exist at click time.
            this.paintEyes(fileId);
            const layer = layerName ? this.ui.renderer?.layers.get(layerName) : null;
            if (layer) layer.visible = visible;
            this.ui.renderer?.render();
            this.ui.ctrl.refresh3D();
        }

        /** Paints every eye in one file node from its operation's visibility record. */
        paintEyes(fileId) {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;
            const record = fileData.operation.layerVisibility || {};
            const paint = (button, key) => {
                if (!button) return;
                const visible = record[key] !== false;
                button.title = visible ? 'Hide' : 'Show';
                button.querySelector('use')?.setAttribute('href', visible ? '#icon-eye' : '#icon-eye-off');
            };
            paint(fileData.element.querySelector('.file-node-content .visibility-btn'), 'source');
            for (const geo of fileData.geometries.values()) {
                paint(geo.element.querySelector('.visibility-btn'), NavTreePanel.artifactKeyOf(geo.type));
            }
        }

        /**
         * Artifact key for a tree node type. Per-pass offsets keep their own
         * key so a single pass can still be hidden; everything else collapses
         * onto the names the 3D push and the skill's contract already use.
         */
        static artifactKeyOf(geometryType) {
            if (geometryType === 'offsets_combined') return 'offsets';
            return geometryType;
        }

        removeFileNode(operationId) {
            let nodeToRemove = null;
            let operationType = null;

            this.nodes.forEach((node, id) => {
                if (node.operation?.id === operationId) {
                    nodeToRemove = id;
                    operationType = node.operation.type;
                }
            });

            if (nodeToRemove) {
                const nodeData = this.nodes.get(nodeToRemove);
                if (nodeData?.element) nodeData.element.remove();
                this.nodes.delete(nodeToRemove);

                if (this.selectedNode?.id === nodeToRemove) {
                    this.selectedNode = null;
                }

                // Update category aria-expanded if now empty
                if (operationType) {
                    this.syncCategoryExpanded(
                        document.querySelector(`.operation-category[data-op-type="${operationType}"]`)
                    );
                }
            }
        }

        updateGeometrySetInfo(fileId) {
            const fileData = this.nodes.get(fileId);
            // if (!fileData) return;
            const container = fileData.element.querySelector('.file-geometries');
            const contents = container.querySelectorAll('.geometry-node-content');
            contents.forEach((content, index) => {
                content.setAttribute('aria-setsize', contents.length.toString());
                content.setAttribute('aria-posinset', (index + 1).toString());
            });
        }

        // ═══════════════════════════════════════════════════════════════
        // Refresh
        // ═══════════════════════════════════════════════════════════════

        refreshTree() {
            document.querySelectorAll('.category-files').forEach(c => { c.innerHTML = ''; });
            this.nodes.clear();
            this.nextNodeId = 1;
            if (this.core && this.core.operations) {
                this.core.operations.forEach(op => { if (op.file) this.addFileNode(op); });
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Keyboard navigation
        // ═══════════════════════════════════════════════════════════════

        setFocusOnItem(prev, target) {
            if (prev && prev !== target) prev.setAttribute("tabindex", "-1");
            if (target) {
                target.setAttribute("tabindex", "0");
                target.focus();
            }
        }

        setupKeyboardNavigation() {
            if (!this.treeContainer) return;
            this.treeContainer.setAttribute("role", "tree");
            this.treeContainer.setAttribute("aria-label", "Operations");
            this.setupCategoryARIA();

            UIControls.setupTreeKeyboard(this.treeContainer, [
                { selector: ".category-header", onActivate: el => this.emit("categoryClick", el.closest(".operation-category")?.dataset.opType) },
                { selector: ".file-node-content", onActivate: el => this.activateFileNode(el) },
                { selector: ".geometry-node-content", onActivate: el => this.activateGeometryNode(el) }
            ], {
                onDelete: (id, focused) => {
                        const fileId = focused.closest('.file-node')?.dataset.fileId;
                        const operation = focused.classList.contains('file-node-content')
                            ? this.nodes.get(fileId)?.operation
                            : null;
                        const geometryId = focused.classList.contains('geometry-node-content')
                            ? focused.closest('.geometry-node')?.dataset.geometryId
                            : null;
                        if (!operation && !(fileId && geometryId)) return;
                        // The deleted row leaves the tree, so focus moves to a neighbour.
                        const items = this.getVisibleTreeItems();
                        const idx = items.indexOf(focused);
                        const nextFocus = items[idx + 1] || items[idx - 1];
                        if (operation) this.emit('action', { id: operation.id, action: 'delete' });
                        else this.emit('deleteGeometry', { fileId, geometryId });
                        if (nextFocus && document.body.contains(nextFocus)) this.setFocusOnItem(null, nextFocus);
                    },
                onKey: (key, id, focused) => {
                    if ("v" === key || "V" === key) {
                        const visBtn = focused.querySelector(".visibility-btn");
                        visBtn && !visBtn.disabled && visBtn.click();
                    }
                }
            });
        }


        setupCategoryARIA() {
            const categories = document.querySelectorAll('.operation-category');
            categories.forEach((category, index) => {
                const header = category.querySelector('.category-header');
                const filesContainer = category.querySelector('.category-files');
                const opType = category.dataset.opType;
                if (!header) return;

                // A tree may only own treeitems. role="button" here is what
                // makes the whole container fail aria-required-children.
                header.setAttribute('role', 'treeitem');
                header.setAttribute('aria-label', `Add file to ${opType}`);
                header.setAttribute('tabindex', index === 0 ? '0' : '-1');
                header.setAttribute('aria-level', '1');
                header.setAttribute('aria-selected', 'false');

                if (filesContainer) {
                    const filesId = `category-files-${opType}`;
                    filesContainer.id = filesId;
                    filesContainer.setAttribute('role', 'group');
                    header.setAttribute('aria-controls', filesId);
                    this.syncCategoryExpanded(category);
                } else {
                    header.removeAttribute('aria-expanded');
                }
            });
        }

        /**
         * A category with no files is a leaf; announcing it as collapsed
         * promises children that are not there.
         */
        syncCategoryExpanded(category) {
            const header = category?.querySelector('.category-header');
            const files = category?.querySelector('.category-files');
            if (!header) return;
            if (files && files.querySelector('.file-node')) header.setAttribute('aria-expanded', 'true');
            else header.removeAttribute('aria-expanded');
        }

        activateFileNode(fileContent) {
            const fileNode = fileContent.closest('.file-node');
            const fileId = fileNode?.dataset.fileId;
            const nodeData = this.nodes.get(fileId);
            if (nodeData?.operation) this.selectFile(fileId, nodeData.operation);
        }

        activateGeometryNode(geometryContent) {
            const geometryNode = geometryContent.closest('.geometry-node');
            const geometryId = geometryNode?.dataset.geometryId;
            const geometryType = geometryNode?.dataset.geometryType;

            // Find parent file node to get operation
            const fileNode = geometryNode.closest('.file-node');
            const fileId = fileNode?.dataset.fileId;
            const nodeData = this.nodes.get(fileId);
            if (nodeData?.operation) this.selectGeometry(geometryId, nodeData.operation, geometryType);
        }

        getVisibleTreeItems() {
            const items = [];
            document.querySelectorAll('.operation-category').forEach(cat => {
                const header = cat.querySelector('.category-header');
                if (header) items.push(header);

                // Categories render their files unconditionally. The only thing
                // that takes a node out of the sequence is CSS hiding it, so
                // that is what gets tested.
                cat.querySelectorAll('.file-node').forEach(fileNode => {
                    if (fileNode.offsetParent === null) return;

                    const fc = fileNode.querySelector('.file-node-content');
                    if (fc) items.push(fc);

                    fileNode.querySelectorAll('.geometry-node').forEach(gn => {
                        if (gn.offsetParent === null) return;
                        const gc = gn.querySelector('.geometry-node-content');
                        if (gc) items.push(gc);
                    });
                });
            });
            return items;
        }

        // ═══════════════════════════════════════════════════════════════
        // Onboarding highlight loop
        // ═══════════════════════════════════════════════════════════════

        /**
         * Begins cycling the highlight across loaded file nodes (if no file has been selected yet).
         */
        startSuggestionCycle() {
            if (this.suggestionDismissed || this.suggestionInterval) return;
            // Auto-updating motion with no stop control (WCAG 2.2.2). Users who
            // asked for less motion get none.
            if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
                this.dismissSuggestion();
                return;
            }
            const nodes = this.getHighlightableNodes();
            if (nodes.length === 0) return;
            this.highlightIndex = -1;
            this.cycleHighlight();
            this.suggestionInterval = setInterval(() => this.cycleHighlight(), 3250);
        }

        /**
         * Advances the highlight to the next file node with loaded primitives.
         */
        cycleHighlight() {
            if (this.suggestionDismissed) return;
            const nodes = this.getHighlightableNodes();
            if (nodes.length === 0) { this.dismissSuggestion(); return; }

            // Remove the highlight to trigger the CSS fade-out transition
            document.querySelectorAll('.file-node-content.onboarding-highlight')
                .forEach(el => el.classList.remove('onboarding-highlight'));

            // Wait for the fade-out to register
            setTimeout(() => {
                // Ensure the user hasn't click anything
                if (this.suggestionDismissed) return;
                this.highlightIndex = nodes.length === 1 ? 0 : (this.highlightIndex + 1) % nodes.length;
                nodes[this.highlightIndex].classList.add('onboarding-highlight');
            }, 300);
        }

        /**
         * Returns file-node-content elements for operations that have source geometry.
         */
        getHighlightableNodes() {
            const elements = [];
            this.nodes.forEach((data) => {
                if (data.type === 'file' && data.operation?.primitives?.length > 0) {
                    const content = data.element.querySelector('.file-node-content');
                    if (content) elements.push(content);
                }
            });
            return elements;
        }

        /**
         * Permanently disables the onboarding suggestion for this session.
         */
        dismissSuggestion() {
            if (this.suggestionDismissed) return;
            this.suggestionDismissed = true;
            if (this.suggestionTimer) { clearTimeout(this.suggestionTimer); this.suggestionTimer = null; }
            if (this.suggestionInterval) { clearInterval(this.suggestionInterval); this.suggestionInterval = null; }
            document.querySelectorAll('.file-node-content.onboarding-highlight')
                .forEach(el => el.classList.remove('onboarding-highlight'));
        }

        // ═══════════════════════════════════════════════════════════════
        // Utilities
        // ═══════════════════════════════════════════════════════════════

        selectGeometryByType(operationId, geometryType) {
            for (const [, fileData] of this.nodes) {
                if (fileData.operation?.id === operationId) {
                    for (const [geoId, geoData] of fileData.geometries) {
                        if (geoData.type === geometryType || 
                            ('offsets' === geometryType && (geoData.type === 'offsets_combined' || geoData.type.startsWith('offset_')))) {
                            this.selectGeometry(geoId, fileData.operation, geoData.type);
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        getNodeByOperationId(operationId) {
            for (const [, node] of this.nodes) {
                if (node.operation?.id === operationId) return node;
            }
            return null;
        }

        debug(message, data = null) {
            if (this.ui.debug) this.ui.debug(`[NavTreePanel] ${message}`, data);
        }
    }

    window.NavTreePanel = NavTreePanel;
})();