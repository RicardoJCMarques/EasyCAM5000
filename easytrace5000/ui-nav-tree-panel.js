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

            if (deleteBtn) deleteBtn.setAttribute('aria-label', `Delete ${operation.file.name}`);
            if (visBtn) visBtn.setAttribute('aria-label', `Toggle visibility of ${operation.file.name}`);

            // Visibility button
            if (visBtn) {
                const layerName = window.LayerNaming.source(operation.id);
                visBtn.dataset.layerName = layerName;

                // Paint the ICON, never `is-hidden`. Hiding the button removed
                // the only control that could bring the source back, and the
                // stencil block writes that same class for a different reason -
                // two writers, one class, and neither could tell which meaning
                // was in effect.
                const isVisible = operation.layerVisibility?.source !== false;
                visBtn.title = isVisible ? 'Hide' : 'Show';
                visBtn.querySelector('use')?.setAttribute('href', isVisible ? '#icon-eye' : '#icon-eye-off');

                visBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this.emit('action', { id: operation.id, action: 'visibility', artifactKey: 'source', layerName, element: visBtn });
                });
            }

            label.textContent = operation.file.name;
            label.title = operation.file.name;

            // Content click → select
            content.addEventListener('click', (e) => {
                if (!e.target.closest('.btn-icon')) {
                    this.selectFile(fileId, operation);
                }
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

            // Schedule onboarding suggestion (resets with each new file to handle multi-file loads)
            this.scheduleSuggestion();

            return fileId;
        }

        updateFileGeometries(fileId, operation) {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;

            const geometriesContainer = fileData.element.querySelector('.file-geometries');
            if (!geometriesContainer) return;

            geometriesContainer.innerHTML = '';
            fileData.geometries.clear();

            const isLaser = this.ui.ctrl.machineClassOf?.(operation) === 'laser';

            // Offset nodes
            if (operation.offsets && operation.offsets.length > 0) {
                const strategy = operation.offsets?.[0]?.metadata?.strategy
                    || operation.settings?.laserClearStrategy
                    || 'offset';

                    // Look inside the metadata object where cam-core stores the flag
                if (operation.offsets[0]?.metadata?.offset?.combined || isLaser) {
                    // Fetch the mathematical pass count, fallback to array length
                    const passes = operation.offsets[0]?.metadata?.offset?.passes || operation.offsets.length;
                    const totalPrimitives = operation.offsets.reduce((sum, off) => sum + (off.primitives?.length || 0), 0);
                    // Dynamically update the label so users know it's a combined multi-pass
                    const label = isLaser ? 'Laser Paths' : `Offsets (${passes} Passes)`;
                    this.addGeometryNode(fileId, 'offsets_combined', label, totalPrimitives, {
                        offset: operation.offsets[0].distance.toFixed(2),
                        combined: true,
                        passes: passes
                    });
                } else {
                    operation.offsets.forEach((offset, index) => {
                        let label;
                        if (isLaser) {
                            if (strategy === 'filled') label = 'Filled Region';
                            else if (strategy === 'hatch') label = `Hatch ${index + 1}`;
                            else label = `Laser Pass ${index + 1}`;
                        } else {
                            label = `Pass ${index + 1}`;
                        }
                        const count = offset.primitives?.length || 0;
                        this.addGeometryNode(fileId, `offset_${index}`, label, count, {
                            offset: offset.distance.toFixed(2)
                        });
                    });
                }
            }

            // Preview node - CNC only. In laser mode, offsets are the exportable result.
            // The preview.ready flag still exists internally for Export Manager compatibility.
            if (!isLaser && operation.preview && operation.preview.primitives) {
                this.addGeometryNode(fileId, 'preview', 'Preview',
                    operation.preview.primitives.length, {
                    generated: true,
                    sourceOffsets: operation.preview.metadata?.sourceOffsets || 0
                });
            }

            // Toolpath node - ONE per operation. executePipeline returns
            // machine-ready plans, not primitive groups and a relief job
            // produces hundreds of them.
            const toolpaths = this.core.getToolpaths?.(operation.id);
            if (toolpaths?.plans?.length) {
                const mins = Math.floor(toolpaths.metrics.estimatedTime / 60);
                const secs = Math.floor(toolpaths.metrics.estimatedTime % 60);
                this.addGeometryNode(fileId, 'toolpath', 'Toolpaths',
                    toolpaths.plans.length, {
                        estimatedTime: `${mins}:${String(secs).padStart(2, '0')}`,
                        distance: `${toolpaths.metrics.totalDistance.toFixed(0)}mm`
                    });
            }

            // Stencil source visibility
            const sourceVisBtn = fileData.element.querySelector('.file-node-content .visibility-btn');
            if (sourceVisBtn && operation.type === 'stencil') {
                const hasOffsets = operation.offsets && operation.offsets.length > 0;
                sourceVisBtn.classList.toggle('is-hidden', hasOffsets);

                // Pre-emptively sync the renderer layer to prevent flashing during the transition
                const layerName = `source_${operation.id}`;
                if (this.ui.renderer && this.ui.renderer.layers.has(layerName)) {
                    this.ui.renderer.layers.get(layerName).visible = !hasOffsets;
                }
            }

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

        addGeometryNode(fileId, geometryType, label, count, extraData = {}) {
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

            const baseType = geometryType.startsWith('offset') ? 'offset' :
                            geometryType === 'offsets_combined' ? 'offsets_combined' :
                            geometryType.startsWith('toolpath') ? 'toolpath' :
                            geometryType === 'preview' ? 'preview' : geometryType;

            // REVIEW - is this mapp still necessary? Icons are predictable.
            // Map base types to their predictable sprite IDs
            let iconId = 'icon-file'; // default fallback
            if (baseType === 'offsets_combined') iconId = 'icon-offset-combined';
            else if (baseType === 'offset') iconId = 'icon-offset-pass';
            else if (baseType === 'preview') iconId = 'icon-stage-preview';
            else if (baseType === 'toolpath') iconId = 'icon-toolpath';

            iconEl.innerHTML = `<svg class="cam-icon" width="14" height="14"><use href="#${iconId}"></use></svg>`;
            labelEl.textContent = label;

            // Invalidation styling takes priority
            if (fileData.operation.isInvalidated && (geometryType.startsWith('offset') || geometryType === 'offsets_combined')) {
                nodeElement.classList.add('is-invalidated');
                labelEl.style.textDecoration = 'line-through';
                labelEl.style.color = 'var(--color-error, #ff4444)';
                infoEl.textContent = 'Invalid';
                infoEl.style.color = 'var(--color-error, #ff4444)';
            } else if (extraData.offset) {
                infoEl.textContent = `${extraData.offset}mm`;
            } else {
                infoEl.textContent = '';
            }

            content.addEventListener('click', (e) => {
                if (!e.target.closest('.btn-icon')) {
                    this.selectGeometry(geometryId, fileData.operation, geometryType);
                }
            });

            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.emit('deleteGeometry', { fileId, geometryId });
                });
            }

            // A toolpath has no 2D layer - it is drawn by the 3D view - so its
            // eye writes straight to the operation's visibility record and
            // refresh3D filters the plan push on it.
            if (visBtn) {
                const operationId = fileData.operation.id;
                const artifactKey = NavTreePanel.artifactKeyOf(geometryType);

                // A toolpath has no 2D layer - it is drawn by the 3D view - so
                // layerName stays null there and the record alone drives it.
                let layerName = null;
                if (geometryType === "offsets_combined") {
                    layerName = window.LayerNaming.offsetCombined(operationId);
                } else if (geometryType.startsWith("offset_")) {
                    const passIndex = parseInt(geometryType.split("_")[1]);
                    layerName = window.LayerNaming.offsetPass(operationId, passIndex + 1);
                } else if (geometryType === "preview") {
                    layerName = window.LayerNaming.preview(operationId);
                }

                visBtn.dataset.layerName = layerName || "";
                visBtn.addEventListener("click", e => {
                    e.stopPropagation();
                    this.emit("action", {
                        id: operationId,
                        action: "visibility",
                        artifactKey: artifactKey,
                        layerName: layerName,
                        element: visBtn
                    });
                });

                // Paint from the persisted record. Reading renderer.options.show*
                // here made the icon report a GLOBAL toggle while the layer
                // followed a per-operation override, so a rebuild could leave
                // the two pointing opposite ways.
                const isVisible = fileData.operation.layerVisibility?.[artifactKey] !== false;
                visBtn.title = isVisible ? 'Hide' : 'Show';
                visBtn.querySelector('use')?.setAttribute('href', isVisible ? '#icon-eye' : '#icon-eye-off');
            }

            fileData.geometries.set(geometryId, {
                id: geometryId,
                type: geometryType,
                label: label,
                element: nodeElement,
                extraData: extraData
            });

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
            this.ui.ctrl.setViewportForNode?.(null, operation);
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
            const cls = this.ui.ctrl.machineClassOf?.(operation)
                || this.ui.ctrl.pipelineState?.machineClass || 'router';
            const pm = this.ui.ctrl.parameterManager;
            const stages = pm.getStages(operation.type, cls);
            const artifacts = pm.getArtifacts(operation.type, cls);

            const artifact = geometryType === 'toolpath' ? 'toolpath'
                           : geometryType === 'preview' ? 'preview'
                           : (geometryType.startsWith('offset') || geometryType === 'offsets_combined')
                               ? 'offsets' : null;

            const idx = artifact ? artifacts.indexOf(artifact) : -1;
            const stage = idx === -1 ? 'geometry' : (stages[idx + 1] || stages[stages.length - 1]);

            // Viewport follows the artifact, not a global mode.
            this.ui.ctrl.setViewportForNode?.(artifact, operation);

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
         * This used to open `const layer = layers.get(layerName); if (layer) {…}`
         * with the repaint and the persist both inside, so a click on a node
         * whose layer had not been built yet was swallowed whole - no toggle, no
         * icon change, and an open eye over geometry that was hidden.
         * @param {string} artifactKey - source/offsets/offset_N/preview/toolpath,
         *                               the same keyspace refresh3D and 
         *                               _push3DPlans read.
         * @param {string} layerName - the renderer layer, when one exists.
         */
        toggleLayerVisibility(button, artifactKey, layerName) {
            if (!artifactKey) return;

            const fileId = button.closest('.file-node')?.dataset.fileId;
            const operation = this.nodes.get(fileId)?.operation;
            if (!operation) return;

            operation.layerVisibility ||= {};
            const visible = operation.layerVisibility[artifactKey] === false;
            operation.layerVisibility[artifactKey] = visible;

            // Repaint unconditionally - the icon reports the record, not
            // whether a layer happened to exist at click time.
            button.title = visible ? 'Hide' : 'Show';
            button.querySelector('use')?.setAttribute('href', visible ? '#icon-eye' : '#icon-eye-off');

            const layer = layerName ? this.ui.renderer?.layers.get(layerName) : null;
            if (layer) layer.visible = visible;
            this.ui.renderer?.render();
            this.ui.ctrl.refresh3D?.();
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
                    const category = document.querySelector(`.operation-category[data-op-type="${operationType}"]`);
                    if (category) {
                        const filesContainer = category.querySelector('.category-files');
                        const categoryHeader = category.querySelector('.category-header');
                        if (categoryHeader && filesContainer && filesContainer.children.length === 0) {
                            categoryHeader.removeAttribute('aria-expanded');
                        }
                    }
                }
            }
        }

        removeGeometryNode(fileId, geometryId) {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;

            const geoData = fileData.geometries.get(geometryId);
            if (geoData?.element) {
                geoData.element.remove();
                fileData.geometries.delete(geometryId);

                const geometriesContainer = fileData.element.querySelector('.file-geometries');
                const fileContent = fileData.element.querySelector('.file-node-content');
                if (fileContent && geometriesContainer) {
                    if (geometriesContainer.children.length > 0) {
                        fileContent.setAttribute('aria-expanded', 'true');
                        this.updateGeometrySetInfo(fileId);
                    } else {
                        fileContent.removeAttribute('aria-expanded');
                    }
                }
            }
        }

        updateGeometrySetInfo(fileId) {
            const fileData = this.nodes.get(fileId);
            if (!fileData) return;
            const container = fileData.element.querySelector('.file-geometries');
            if (!container) return;
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

        setupKeyboardNavigation() {
            if (!this.treeContainer) return;

            // Set ARIA role on container
            this.treeContainer.setAttribute('role', 'tree');
            this.treeContainer.setAttribute('aria-label', 'Operations');

            // Setup categories with ARIA
            this.setupCategoryARIA();

            // Single keydown listener on tree container
            this.treeContainer.addEventListener('keydown', (e) => this.handleTreeKeydown(e));
        }

        setupCategoryARIA() {
            const categories = document.querySelectorAll('.operation-category');
            categories.forEach((category, index) => {
                const header = category.querySelector('.category-header');
                const filesContainer = category.querySelector('.category-files');
                const opType = category.dataset.opType;

                if (filesContainer) {
                    const filesId = `category-files-${opType}`;
                    filesContainer.id = filesId;
                    filesContainer.setAttribute('role', 'group');
                    if (header) {
                        header.setAttribute('role', 'button');
                        header.setAttribute('aria-label', `Add file to ${opType}`);
                        header.setAttribute('tabindex', index === 0 ? '0' : '-1');
                        header.setAttribute('aria-level', '1');
                        header.setAttribute('aria-controls', filesId);
                        header.removeAttribute('aria-expanded'); // Operations are no longer expandable. REVIEW IF THIS IS WORTH KEEPING?
                    }
                } else if (header) {
                    header.setAttribute('role', 'button');
                    header.setAttribute('aria-label', `Add file to ${opType}`);
                    header.setAttribute('tabindex', index === 0 ? '0' : '-1');
                    header.setAttribute('aria-level', '1');
                    header.removeAttribute('aria-expanded');
                }
            });
        }

        handleTreeKeydown(e) {
            const focused = document.activeElement;
            if (!focused) return;

            const isCategory = focused.classList.contains('category-header');
            const isFileContent = focused.classList.contains('file-node-content');
            const isGeometryContent = focused.classList.contains('geometry-node-content');

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    this.moveFocusDown(focused);
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    this.moveFocusUp(focused);
                    break;

                case 'ArrowRight':
                    e.preventDefault();
                    if (isFileContent) {
                        const firstGeo = focused.closest('.file-node')?.querySelector('.geometry-node-content');
                        if (firstGeo) this.setFocusOnItem(focused, firstGeo);
                    }
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    if (isGeometryContent) {
                        const parentFile = focused.closest('.file-node')?.querySelector('.file-node-content');
                        if (parentFile) this.setFocusOnItem(focused, parentFile);
                    } else if (isFileContent) {
                        const header = focused.closest('.operation-category')?.querySelector('.category-header');
                        if (header) this.setFocusOnItem(focused, header);
                    }
                    break;

                case 'Enter':
                case ' ':
                    e.preventDefault();
                    if (isCategory) {
                        this.emit('categoryClick', focused.closest('.operation-category').dataset.opType);
                    } else if (isFileContent) {
                        this.activateFileNode(focused);
                    } else if (isGeometryContent) {
                        this.activateGeometryNode(focused);
                    }
                    break;

                case 'Home':
                    e.preventDefault();
                    this.focusFirstItem();
                    break;

                case 'End':
                    e.preventDefault();
                    this.focusLastItem();
                    break;

                case 'Delete':
                    e.preventDefault();
                    this.handleDeleteOnFocused(focused, isFileContent, isGeometryContent);
                    break;

                case 'v':
                case 'V':
                    // Toggle visibility of focused item
                    if (isFileContent || isGeometryContent) {
                        e.preventDefault();
                        const visBtn = focused.querySelector('.visibility-btn');
                        if (visBtn) visBtn.click();
                    }
                    break;
            }
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
                if (cat.classList.contains('expanded')) {
                    cat.querySelectorAll('.file-node').forEach(fileNode => {
                        // Add file content
                        const fc = fileNode.querySelector('.file-node-content');
                        if (fc) {
                            items.push(fc);
                            // Add buttons within file node
                            fc.querySelectorAll('.btn-icon').forEach(btn => items.push(btn));
                        }

                        // Add geometry nodes and their buttons
                        fileNode.querySelectorAll('.geometry-node').forEach(gn => {
                            const gc = gn.querySelector('.geometry-node-content');
                            if (gc) {
                                items.push(gc);
                                gc.querySelectorAll('.btn-icon').forEach(btn => items.push(btn));
                            }
                        });
                    });
                }
            });
            return items;
        }

        moveFocusDown(current) {
            const items = this.getVisibleTreeItems();
            const i = items.indexOf(current);
            if (items[i + 1]) this.setFocusOnItem(current, items[i + 1]);
        }

        moveFocusUp(current) {
            const items = this.getVisibleTreeItems();
            const i = items.indexOf(current);
            if (items[i - 1]) this.setFocusOnItem(current, items[i - 1]);
        }

        setFocusOnItem(oldItem, newItem) {
            if (oldItem) oldItem.setAttribute('tabindex', '-1');
            if (newItem) { newItem.setAttribute('tabindex', '0'); newItem.focus(); }
        }

        focusFirstItem() {
            const items = this.getVisibleTreeItems();
            if (items[0]) this.setFocusOnItem(document.activeElement, items[0]);
        }

        focusLastItem() {
            const items = this.getVisibleTreeItems();
            if (items.length) this.setFocusOnItem(document.activeElement, items[items.length - 1]);
        }

        handleDeleteOnFocused(focused, isFileContent, isGeometryContent) {
            if (isFileContent) {
                const fileNode = focused.closest('.file-node');
                const nodeData = this.nodes.get(fileNode?.dataset.fileId);
                if (nodeData?.operation) {
                    // Store next focusable before deletion
                    const items = this.getVisibleTreeItems();
                    const idx = items.indexOf(focused);
                    const nextFocus = items[idx + 1] || items[idx - 1];
                    this.emit('action', { id: nodeData.operation.id, action: 'delete' });
                    // Restore focus
                    if (nextFocus && document.body.contains(nextFocus)) this.setFocusOnItem(null, nextFocus);
                }
            } else if (isGeometryContent) {
                const geoNode = focused.closest('.geometry-node');
                const fileNode = focused.closest('.file-node');
                const geometryId = geoNode?.dataset.geometryId;
                const fileId = fileNode?.dataset.fileId;
                if (fileId && geometryId) {
                    // Store next focusable
                    const items = this.getVisibleTreeItems();
                    const idx = items.indexOf(focused);
                    const nextFocus = items[idx + 1] || items[idx - 1];
                    this.emit('deleteGeometry', { fileId, geometryId });
                    if (nextFocus && document.body.contains(nextFocus)) this.setFocusOnItem(null, nextFocus);
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Onboarding highlight loop
        // ═══════════════════════════════════════════════════════════════

        scheduleSuggestion() {
            if (this.suggestionDismissed) return;
            if (this.suggestionTimer) clearTimeout(this.suggestionTimer);
            this.suggestionTimer = setTimeout(() => {
                this.suggestionTimer = null;
                this.startSuggestionCycle();
            }, 12500);
        }

        /**
         * Begins cycling the highlight across loaded file nodes (if no file has been selected yet).
         */
        startSuggestionCycle() {
            if (this.suggestionDismissed || this.suggestionInterval) return;

            // User already found the workflow on their own
            if (this.ui.TraceOperationPanel?.currentOperation) {
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

        // REVIEW - which version is more efficient for debug?
        // debug(message, data = null) {
        //     if (!debugState.enabled) return;
        //     data ? console.log(`[ArcReconstructor] ${message}`, data)
        //          : console.log(`[ArcReconstructor] ${message}`);
        // }
    }

    window.NavTreePanel = NavTreePanel;
})();