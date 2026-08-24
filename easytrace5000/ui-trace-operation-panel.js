/*!
 * @file        easytrace5000/ui-trace-operation-panel.js
 * @description Parameter input builder (right sidebar)
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    class TraceOperationPanel extends BaseOperationPanel {
        constructor(ui) {
            super(ui);
            this.core = ui.core;
        }

        // ═══════════════════════════════════════════════════════════════
        // Hook Overrides
        // ═══════════════════════════════════════════════════════════════

        getIdPrefix() { return 'prop-'; }

        getFormContainer() { return document.getElementById('property-form'); }

        getPipelineType() {
            return this.ui.ctrl.pipelineState?.type || 'cnc';
        }

        init(toolLibrary, parameterManager) {
            this.toolLibrary = toolLibrary;
            this.initBase(this.core, parameterManager || new ParameterManager(), this.ui.ctrl.appProfile, this.ui.lang);
            this.debug('Initialized');
        }

        checkInvalidation(paramName) {
            const operation = this.resolveCurrentOperation();
            if (!operation) return;

            const paramDef = this.parameterManager.parameterDefinitions[paramName];
            if (!paramDef || (paramDef.stage !== 'geometry' && paramDef.stage !== 'strategy')) return;
            if (paramDef.invalidates === false) return;

            if (!this.ui.ctrl.core?.isExportReady(operation)) return;

            this.core.invalidateOperationState(operation.id);
            operation.isInvalidated = true;
            operation.invalidatedReason = `'${paramDef.label || paramName}' changed after generation - regenerate before exporting.`;
            if (this.ui.navTreePanel) {
                const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
            }
            this.ui.setStatus(operation.invalidatedReason, 'warning');
        }

        /**
         * A tooling change can move the mode, which changes which fields
         * exist and whether Generate is allowed - all of it rebuilds here.
         */
        refreshOperationPanel(operation) {
            const container = this.getFormContainer();
            if (container && operation) {
                this.showOperationProperties(container, operation, this.currentStage);
            }
        }

        returnFocusToTree() {
            const selected = document.querySelector(
                '.file-node-content.selected, .geometry-node-content.selected, .geometry-node.selected'
            );
            if (selected) {
                const focusTarget = selected.querySelector('.file-node-content, .geometry-node-content') || selected;
                focusTarget.setAttribute('tabindex', '0');
                focusTarget.focus();
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // showOperationProperties
        // ═══════════════════════════════════════════════════════════════

        showOperationProperties(container, operation, stage = 'geometry') {
            if (!operation) {
                this.clearProperties();
                if (container) container.innerHTML = '';
                return;
            }

            const isSameOperation = this.currentOperationId === operation.id;

            if (!isSameOperation) {
                // Switching operations: save outgoing, load incoming
                if (this.currentOperationId) this.saveCurrentState();
                this.currentOperationId = operation.id;
                this.parameterManager.loadFromOperation(operation);
            }

            // Remap CNC stages to laser/stencil equivalents
            const isLaser = this.ui.ctrl.isLaserPipeline?.() || false;

            // Remap CNC-originated stages to laser/stencil equivalents
            const isStencil = operation.type === 'stencil';
            if ((isLaser || isStencil) && (stage === 'strategy' || stage === 'machine')) {
                stage = this.core.isExportReady?.(operation) ? 'export_summary' : 'geometry';
            }

            this.currentStage = stage;

            // Export summary is display-only (no editable parameters)
            if (stage === 'export_summary') {
                this.renderExportSummary(container, operation);
                return;
            }

            container.innerHTML = '';

            // Header
            const titleEl = document.getElementById('inspector-title');
            if (titleEl) {
                // Capitalize operation type (e.g. "Isolation: filename.gbr")
                const capType = operation.type.charAt(0).toUpperCase() + operation.type.slice(1);
                titleEl.textContent = `${capType} - ${operation.file.name}`;
            }

            // Invalidation warning
            if (operation.isInvalidated) {
                container.appendChild(this.createInvalidationPanel(operation));
            }

            // Geometry summary (source stage only)
            if (stage === 'geometry') {
                const summary = this.createGeometrySummary(operation);
                if (summary) container.appendChild(summary);
            }

            // Show warnings if any
            if (operation.warnings?.length > 0) {
                container.appendChild(this.createWarningPanel(
                    operation.warnings.map(w => typeof w === 'string' ? { message: w } : w)
                ));
            }

            // Parameter form
            // Conditionals cross stages: drill's strategy controls are gated on
            // millHoles, which lives in the geometry bag. A stage-scoped read
            // resolves the gate to undefined and hides every dependent field.
            // Use getAllParameters so cross-stage conditionals (e.g. millHoles gating drillMultiDepth) evaluate correctly
            const values = this.parameterManager.getAllParameters(operation.id);
            this.renderParameterForm(container, operation.type, stage, values);

            // Drill tooling, immediately above the action button: it reports what
            // the button will cut with, and it gates whether the button is
            // allowed to run at all. Field visibility is the profile's job
            // (conditional "!drillMultiTool"), not this method's.
            if ('drill' === operation.type && 'geometry' === stage) {
                container.appendChild(this.createDrillToolingCard(operation, values));
            }

            // Add action button
            const actionInfo = this.getActionButtonInfo(stage, operation.type);
            if (actionInfo) container.appendChild(this.createActionButton(actionInfo.text, actionInfo.disabled, actionInfo.title));

            // Disable Drill Exclude if no drill operation is loaded
            if (operation.type === 'stencil' && stage === 'geometry') {
                const hasDrill = this.core.operations.some(op => op.type === 'drill' && op.primitives?.length > 0);
                const excludeInput = document.getElementById('prop-stencilExcludeDrillPads');
                if (excludeInput) {
                    excludeInput.disabled = !hasDrill;
                    const wrapper = excludeInput.closest('.checkbox-label');
                    if (wrapper) {
                        wrapper.style.opacity = hasDrill ? '1' : '0.5';
                        wrapper.title = hasDrill ? '' : 'No drill operations loaded. Add a drill file first.';
                    }
                }
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Action Dispatch
        // ═══════════════════════════════════════════════════════════════

        resolveCurrentOperation() {
            return this.core.getOperation(this.currentOperationId);
        }

        resolveOperationType(operation) {
            return operation?.type || '';
        }

        getSpinnerLabel(stage, opType) {
            if (stage === 'geometry') return 'Generating... pass 1';
            if (stage === 'strategy') return 'Generating toolpath preview...';
            return null;
        }

        async onGenerationSuccess(opId, operation) {
            const isLaser = this.ui.ctrl.isLaserPipeline?.() || false;
            const isStencil = operation.type === 'stencil';

            if (isLaser || isStencil) {
                if (isLaser) {
                    this.ui.renderer?.setOptions({ showPreviews: true });
                    const toggle = document.getElementById('show-previews');
                    if (toggle) toggle.checked = true;
                }
            }

            if (this.ui.navTreePanel) {
                const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
            }
            await this.ui.updateRendererAsync();
        }

        onGenerationFailure(opId, operation, stage) {
            const container = this.getFormContainer();
            if (container) this.showOperationProperties(container, operation, stage);
        }

        async onPreviewSuccess(opId, operation) {
            this.ui.renderer.setOptions({ showPreviews: true });
            const toggle = document.getElementById('show-previews');
            if (toggle) toggle.checked = true;

            if (this.ui.navTreePanel) {
                const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
            }
            await this.ui.updateRendererAsync();
        }

        onStageTransition(newStage) {
            const operation = this.resolveCurrentOperation();
            const container = this.getFormContainer();
            if (container && operation) {
                this.showOperationProperties(container, operation, newStage);
            }
        }

        onExportStage(opId, operation) {
            const ctrl = this.ui.ctrl;
            if (ctrl?.modalManager) {
                const readyOps = this.core.operations.filter(o => this.core.isExportReady(o));
                if (readyOps.length === 0) {
                    this.ui.setStatus('No operations ready. Generate paths first.', 'warning');
                    return;
                }
                ctrl.modalManager.showModal('exportManager', {
                    operations: readyOps,
                    highlightOperationId: operation.id
                });
            }
        }

        switchToStageAndRender(newStage) {
            this.currentStage = newStage;
            const operation = this.resolveCurrentOperation();
            const container = this.getFormContainer();
            if (container && operation) {
                this.showOperationProperties(container, operation, newStage);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Action Button Text
        // ═══════════════════════════════════════════════════════════════

        getActionButtonInfo(stage, opType) {
            const text = (() => {
                // Stencil - always 2-stage regardless of pipeline
                if (opType === 'stencil') {
                    if (stage === 'geometry') return 'Generate Stencil';
                    if (stage === 'export_summary') return 'Export Manager';
                    return null;
                }

                const isLaser = this.ui.ctrl.isLaserPipeline?.() || false;

                // Laser stages
                if (isLaser) {
                    if (stage === 'geometry') {
                        if (opType === 'cutout') return 'Generate Laser Cut Path';
                        if (opType === 'drill') return 'Generate Drill Marks';
                        return 'Generate Laser Paths';
                    }
                    return stage === 'export_summary' ? 'Export Manager' : null;
                }
                // CNC stages
                if (stage === 'geometry') {
                    if (opType === 'drill') return 'Generate Drill Strategy';
                    if (opType === 'cutout') return 'Generate Cutout Path';
                    return 'Generate Offsets';
                }
                if (stage === 'strategy') return 'Generate Preview';
                if (stage === 'machine') return 'Export Manager';
                return null;
            })();

            if (!text) return null;

            // Multi-tool with an unanswered row would generate paths against a
            // cutter nobody chose. The card above names the sizes; the button
            // carries the reason on hover so a disabled button is never a dead
            // end with no explanation.
            if ('drill' === opType && 'geometry' === stage) {
                const operation = this.resolveCurrentOperation();
                const settings = operation ? this.parameterManager.getAllParameters(operation.id) : null;
                const info = operation ? DrillHandler.describeTable(operation, settings) : null;
                if (info && 'perSize' === info.mode) {
                    const count = info.numbers.length;
                    return {
                        text: count > 0 ? `${text} (${count} tool${count > 1 ? 's' : ''})` : text,
                        disabled: !info.complete,
                        title: info.complete ? '' : info.reason
                    };
                }
            }
            return { text, disabled: false };
        }

        // ═══════════════════════════════════════════════════════════════
        // Panels
        // ═══════════════════════════════════════════════════════════════

        createInvalidationPanel(operation) {
            const template = document.getElementById('invalidation-panel-template');
            // REVIEW - What is this checking for?
            if (!template) return document.createElement('div');

            const panelNode = template.content.cloneNode(true);
            const panel = panelNode.querySelector('.invalidation-panel');
            const msg = panel.querySelector('.warning-message');
            const redoBtn = panel.querySelector('.invalidation-redo-btn');

            msg.textContent = operation.invalidatedReason || 'Global machine settings have changed. Existing geometry must be regenerated.';

            redoBtn.onclick = async () => {
                this.core.resetOperationState(operation.id);

                const layerKeys = Array.from(this.ui.renderer.layers.keys())
                    .filter(key => key.includes(`_${operation.id}_`));
                layerKeys.forEach(key => this.ui.renderer.layers.delete(key));

                if (this.ui.navTreePanel) {
                    const fileNode = this.ui.navTreePanel.getNodeByOperationId(operation.id);
                    if (fileNode) this.ui.navTreePanel.updateFileGeometries(fileNode.id, operation);
                }

                await this.ui.updateRendererAsync();
                this.switchToStageAndRender('geometry');
                this.ui.setStatus('Invalid geometry cleared. Ready to regenerate.', 'success');
            };

            return panel;
        }

        /**
         * Creates a read-only geometry summary panel showing source geometry info.
         * Visible for all operation types when source geometry stage is selected.
         */
        createGeometrySummary(operation) {
            const summary = this.core.getGeometrySummary(operation);
            if (!summary || summary.totalCount === 0) return null;

            const section = document.createElement('div');
            section.className = 'property-section geometry-summary';

            const h3 = document.createElement('h3');
            h3.textContent = 'Source Geometry';
            section.appendChild(h3);

            const info = document.createElement('div');
            info.className = 'geometry-summary-info';

            // Total count
            const totalLine = document.createElement('div');
            totalLine.className = 'summary-line';
            totalLine.innerHTML = `<strong>Primitives:</strong> ${summary.totalCount}`;
            if (summary.source === 'svg') {
                totalLine.innerHTML += ' <span class="badge badge--info">SVG</span>';
            }
            info.appendChild(totalLine);

            // Type breakdown (compact)
            if (Object.keys(summary.byType).length > 1 || !summary.isDrill) {
                const typeEntries = Object.entries(summary.byType)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
                    .join(', ');
                const typeLine = document.createElement('div');
                typeLine.className = 'summary-line summary-secondary';
                typeLine.textContent = typeEntries;
                info.appendChild(typeLine);
            }

            // Drill-specific: hole/slot breakdown by size
            if (summary.isDrill && summary.drillSummary) {
                const ds = summary.drillSummary;

                if (ds.holes.length > 0) {
                    const holesLine = document.createElement('div');
                    holesLine.className = 'summary-line';
                    holesLine.innerHTML = `<strong>Holes:</strong> ${ds.holes.map(h => `⌀${h.diameter.toFixed(3)}mm x ${h.count}`).join(', ')}`;
                    info.appendChild(holesLine);
                }

                if (ds.slots.length > 0) {
                    const slotsLine = document.createElement('div');
                    slotsLine.className = 'summary-line';
                    slotsLine.innerHTML = `<strong>Slots:</strong> ${ds.slots.map(s => `${s.width.toFixed(3)}x${s.length.toFixed(3)}mm x ${s.count}`).join(', ')}`;
                    info.appendChild(slotsLine);
                }

                if (ds.totalRejected > 0) {
                    const rejLine = document.createElement('div');
                    rejLine.className = 'summary-line summary-warning';
                    rejLine.innerHTML = `<strong>Rejected:</strong> ${ds.totalRejected} unsupported shape${ds.totalRejected > 1 ? 's' : ''}`;
                    info.appendChild(rejLine);
                }
            }

            if (summary.isDrill && !summary.drillSummary && summary.byRole) {
                const roleEntries = Object.entries(summary.byRole)
                    .map(([role, count]) => `${count} ${role.replace('drill_', '').replace('_', ' ')}${count > 1 ? 's' : ''}`)
                    .join(', ');
                const roleLine = document.createElement('div');
                roleLine.className = 'summary-line';
                roleLine.innerHTML = `<strong>Features:</strong> ${roleEntries}`;
                info.appendChild(roleLine);
            }

            // Generated output stats
            const hasOutput = (operation.offsets?.length > 0) || operation.stencilMetadata;
            if (hasOutput) {
                const divider = document.createElement('div');
                divider.style.margin = 'var(--spacing-md) 0';
                divider.style.borderTop = '1px dashed var(--color-border-primary)';
                info.appendChild(divider);

                const outTitle = document.createElement('div');
                outTitle.className = 'summary-line';
                outTitle.innerHTML = '<strong>Generated Output:</strong>';
                info.appendChild(outTitle);

                // Stencil-specific stats
                if (operation.type === 'stencil') {
                    const count = operation.offsets?.[0]?.primitives?.length || 0;
                    const skipped = operation.stencilMetadata?.skippedPads || 0;
                    const genLine = document.createElement('div');
                    genLine.className = 'summary-line';
                    genLine.textContent = `Apertures: ${count}`;
                    info.appendChild(genLine);
                    if (skipped > 0) {
                        const skipLine = document.createElement('div');
                        skipLine.className = 'summary-line summary-warning';
                        skipLine.textContent = `Skipped (Overlapping): ${skipped}`;
                        info.appendChild(skipLine);
                    }
                } else {
                    const total = operation.offsets.reduce((sum, off) => sum + (off.primitives?.length || 0), 0);
                    const outLine = document.createElement('div');
                    outLine.className = 'summary-line';
                    outLine.innerHTML = `<strong>Paths Generated:</strong> ${total}`;
                    info.appendChild(outLine);

                    // Show achieved offset width if tracked
                    const firstMeta = operation.offsets[0]?.metadata;
                    if (firstMeta?.actualWidth > 0) {
                        const widthLine = document.createElement('div');
                        widthLine.className = 'summary-line';
                        const actual = firstMeta.actualWidth.toFixed(3);
                        widthLine.innerHTML = firstMeta.targetWidth
                            ? `<strong>Achieved Width:</strong> ${actual}mm (target: ${firstMeta.targetWidth.toFixed(3)}mm)`
                            : `<strong>Clearing Depth:</strong> ${actual}mm`;
                        info.appendChild(widthLine);
                    }

                    // If the boolean engine collapsed everything to nothing
                    if (total === 0) {
                        const errLine = document.createElement('div');
                        errLine.className = 'summary-line summary-warning';
                        errLine.textContent = '0 paths generated. Tool diameter or offset may be too large.';
                        info.appendChild(errLine);
                    }
                }
            }

            section.appendChild(info);
            return section;
        }

        renderExportSummary(container, operation) {
            const title = document.getElementById('inspector-title');
            if (!container || !title) return;

            title.textContent = operation.file.name;
            container.innerHTML = '';

            // Summary section
            const isStencil = operation.type === 'stencil';

            const section = document.createElement('div');
            section.className = 'property-section';

            const h3 = document.createElement('h3');
            h3.textContent = isStencil ? 'Stencil Export Summary' : 'Laser Export Summary';
            section.appendChild(h3);

            const params = this.parameterManager.getAllParameters(operation.id) || {};
            const strategy = isStencil ? 'stencil' : (params.laserClearStrategy || 'offset');
            const offsetCount = operation.offsets?.length || 0;
            const primCount = operation.offsets?.reduce((sum, o) => sum + (o.primitives?.length || 0), 0) || 0;

            let html = `
                <div><strong>Operation:</strong> ${operation.type}</div>
                <div><strong>Strategy:</strong> ${strategy}</div>
                <div><strong>Passes:</strong> ${offsetCount}</div>
                <div><strong>Path count:</strong> ${primCount}</div>
            `;

            // Carry skipped pad metrics forward so they aren't hidden on the previous tab
            if (isStencil) {
                const skipped = operation.offsets?.[0]?.metadata?.skippedPads || operation.stencilMetadata?.skippedPads || 0;
                if (skipped > 0) {
                    html += `<div style="color: var(--color-warning); margin-top: var(--spacing-sm);"><strong>Overlapping Pads Skipped:</strong> ${skipped}</div>`;
                }
            }

            const summary = document.createElement('div');
            summary.className = 'exporter-summary-info';
            summary.innerHTML = html;
            section.appendChild(summary);
            container.appendChild(section);

            // Action button
            const actionInfo = this.getActionButtonInfo('export_summary', operation.type);
            if (actionInfo) container.appendChild(this.createActionButton(actionInfo.text, actionInfo.disabled));
        }
    }

    window.TraceOperationPanel = TraceOperationPanel;
})();