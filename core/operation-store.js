/*!
 * @file        core/operation-store.js
 * @description Operation lifecycle, revision stamps, artifact staleness, and toolpath caching
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * 
 * Owns operation lifetime and artifact state: the operation list and its
 * index, per-stage revisions, artifact stamps, directional staleness and
 * per-operation toolpaths.
 *
 * Deliberately holds no reference to CamCore. Session-scoped answers it
 * cannot derive (the registry, the global settings revision, an operation's
 * machine class) arrive as hooks, so nothing here reads geometry, parsers,
 * tools, the scene, the DOM or storage.
 */

(function () {
    'use strict';

    const ROOT = globalThis;
    const debugState = ROOT.CAMConfig.defaults.debug;

    /**
     * Duck-typed rather than `instanceof File`: a source is a file when it
     * carries a size and a modification time. The global is browser-only and
     * this module must stay loadable anywhere.
     */
    function isFileLike(source) {
        return !!source && source.size !== undefined && source.lastModified !== undefined;
    }

    class OperationStore {
        /**
         * @param {Object} [hooks]
         * @param {() => number} [hooks.settingsRevision] current global revision
         * @param {(operation:Object) => string} [hooks.machineClassOf] stamp → override → session
         */
        constructor(hooks = {}) {
            this.operations = [];
            this.operationIndex = new Map();
            this.nextOperationId = 1;
            this.toolpaths = new Map();
            this.registry = null;

            this.stats = { totalPrimitives: 0, operations: 0 };

            this._settingsRevision = hooks.settingsRevision || (() => 0);
            this._machineClassOf = hooks.machineClassOf || (() => 'router');
            // createOperation stamps a class before any operation object exists,
            // so it needs the type-only rule rather than a fake operation.
            this._machineClassForType = hooks.machineClassForType || (() => 'router');
        }

        /* Wiring */

        setRegistry(registry) {
            this.registry = registry;
        }

        machineClassOf(operation) { return this._machineClassOf(operation); }
        machineClassForType(type) { return this._machineClassForType(type); }

        /* Operation CRUD */

        /**
         * Creates a new operation.
         * @param {string} operationType - 'isolation', 'clearing', 'profile', 'pocket', etc.
         * @param {Object} source - Either a File object or { label: string }
         * @returns {Object} The created operation, registered in store.operations[]
         */
        createOperation(operationType, source) {
            const isFile = isFileLike(source);
            const operation = {
                id: 'op_' + this.nextOperationId++,
                type: operationType,
                file: {
                    name: isFile ? source.name : source?.label || operationType,
                    content: null,
                    size: isFile ? source.size : 0,
                    lastModified: isFile ? source.lastModified : Date.now(),
                },
                primitives: isFile ? null : [],
                bounds: null,
                error: null,
                warnings: null,
                machineClass: this.machineClassForType(operationType),
                // Bumped by the panel when a parameter in that stage changes.
                // Artifacts record the values they were built from.
                revisions: { geometry: 0, strategy: 0, machine: 0, output: 0 },
                stamps: {},
                offsets: [],
                layerVisibility: {},
            };
            this.operations.push(operation);
            this.operationIndex.set(operation.id, operation);
            return operation;
        }

        /**
         * Splice an operation out but hand the caller everything needed to put it
         * back. The operation Object is returned by reference, so re-attaching
         * restores its parameters, offsets and preview without a rebuild.
         */
        detachOperation(operationId) {
            const index = this.operations.findIndex(op => op.id === operationId);
            if (index === -1) return null;
            const operation = this.operations[index];
            const toolpaths = this.toolpaths.get(operationId) || null;
            this.operationIndex.delete(operationId);
            this.operations.splice(index, 1);
            this.toolpaths.delete(operationId);
            this.updateStatistics();
            return { operation, index, toolpaths };
        }

        attachOperation(token) {
            if (!token?.operation) return false;
            const { operation, index, toolpaths } = token;
            this.operations.splice(Math.min(index, this.operations.length), 0, operation);
            this.operationIndex.set(operation.id, operation);
            if (toolpaths) this.toolpaths.set(operation.id, toolpaths);
            this.updateStatistics();
            return true;
        }

        resetOperationState(operationId) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;
            operation.offsets = [];
            operation.preview = null;
            operation.stamps = {};
            this.toolpaths.delete(operationId);
            operation.isInvalidated = false;
            operation.invalidatedReason = null;
            return true;
        }

        // O(1) operation lookup by ID. Returns undefined if not found.
        getOperation(id) {
            return this.operationIndex.get(id);
        }

        /**
         * Drops every operation and its derived state. nextOperationId is NOT
         * reset: a reused id would let a stale reference resolve to a new
         * operation instead of returning undefined.
         */
        clearAll() {
            this.operations.length = 0;
            this.operationIndex.clear();
            this.toolpaths.clear();
            this.updateStatistics();
        }

        /* Preview artifact */

        /**
         * Generates a CNC toolpath preview from existing offsets.
         * Collects all offset primitives, tags them as preview geometry,
         * and marks the operation export-ready.
         * @param {string} operationId
         * @returns {boolean} success
         */
        generateCNCPreview(operationId) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;
            if (!operation.offsets || operation.offsets.length === 0) {
                this.debug(`generateCNCPreview: no offsets for ${operationId}`);
                return false;
            }
            const firstOffset = operation.offsets[0];
            const toolDiameter = firstOffset.metadata?.toolDiameter;
            if (toolDiameter === undefined || toolDiameter <= 0) {
                this.debug(`generateCNCPreview: invalid tool diameter for ${operationId}`);
                return false;
            }

            const allPrimitives = [];
            operation.offsets.forEach((offset) => {
                offset.primitives.forEach((prim) => {
                    if (!prim.properties) prim.properties = {};
                    prim.properties.isPreview = true;

                    // Drill primitives carry the diameter of the bit assigned to
                    // THEIR row. preview.primitives alias these objects, so
                    // overwriting this erases the per-row cutter before the
                    // toolpath pass ever reads it.
                    if (prim.properties.toolDiameter === undefined) prim.properties.toolDiameter = toolDiameter;
                    allPrimitives.push(prim);
                });
            });

            operation.preview = {
                primitives: allPrimitives,
                metadata: {
                    generatedAt: Date.now(),
                    sourceOffsets: operation.offsets.length,
                    toolDiameter: toolDiameter
                },
                ready: true
            };

            // Automatically hide offset passes when preview is generated
            operation.layerVisibility ||= {};
            operation.layerVisibility.preview = true;
            operation.layerVisibility.offsets = false;
            if (operation.offsets) {
                operation.offsets.forEach((_, i) => {
                    operation.layerVisibility[`offset_${i}`] = false;
                });
            }
            return true;
        }

        /* Revisions & artifact stamps */

        /**
         * A parameter in `stage` changed. Everything downstream of that
         * stage is now potentially stale; isArtifactStale works it out on
         * read rather than a writer having to know the dependency graph.
         */
        bumpOperationRevision(operationId, stage) {
            const op = this.getOperation(operationId);
            if (!op || !stage) return;
            if (!op.revisions) op.revisions = {};
            op.revisions[stage] = (op.revisions[stage] || 0) + 1;
        }

        // The revision vector an artifact built NOW would be valid against.
        currentStamp(operationId) {
            const op = this.getOperation(operationId);
            return { ...(op?.revisions || {}), __settings: this._settingsRevision() };
        }

        // Records that `name` was just built from the current inputs.
        stampArtifact(operationId, name) {
            const op = this.getOperation(operationId);
            if (!op) return;
            if (!op.stamps) op.stamps = {};
            op.stamps[name] = this.currentStamp(operationId);
        }

        /**
         * Unstamped counts as stale: unknown must never read as fresh.
         * Artifact i is produced by the action on stages[i], so it depends on
         * stages[0..i] and on nothing after it: a feed-rate edit cannot move
         * an offset.
         */
        isArtifactStale(operation, name) {
            const stamp = operation?.stamps?.[name];
            if (!stamp) return true;
            if ((this._settingsRevision() || 0) > (stamp.__settings || 0)) return true;
            const cls = this.machineClassOf(operation);
            const stages = this.registry?.stagesFor(operation.type, cls) || [];
            const idx = (this.registry?.artifactsFor(operation.type, cls) || []).indexOf(name);
            const revisions = operation.revisions || {};
            for (const stage of idx === -1 ? stages : stages.slice(0, idx + 1)) {
                if ((revisions[stage] || 0) > (stamp[stage] || 0)) return true;
            }
            return false;
        }

        /**
         * Downstream artifacts are dropped silently; only the SOURCE artifact
         * going stale is a user-visible invalidation, because that is the one
         * the trees strike through and the canvas stops drawing. Returns true
         * only on that false → true transition, so a slider drag reports once.
         */
        refreshStaleFlags(operationId, reason = null) {
            const op = this.getOperation(operationId);
            if (!op?.offsets?.length) return false;
            const cls = this.machineClassOf(op);
            const artifacts = this.registry?.artifactsFor(op.type, cls) || ['offsets'];

            for (let i = artifacts.length - 1; i > 0; i--) {
                const name = artifacts[i];
                if (op.stamps?.[name] && this.isArtifactStale(op, name)) {
                    delete op.stamps[name];
                    if (name === 'toolpath') this.toolpaths.delete(op.id);
                    if (name === 'preview') op.preview = null;
                }
            }

            if (!this.isArtifactStale(op, artifacts[0])) return false;
            return this.invalidateOperationState(
                operationId,
                reason || 'Parameters changed after generation - regenerate before exporting.',
            );
        }

        /**
         * Marks generated offsets stale and retires everything downstream of
         * them: the preview stops counting as ready and the toolpaths are
         * dropped. The offsets stay, struck through, until regenerated.
         * @returns {boolean} true only on the fresh → stale transition
         */
        invalidateOperationState(operationId, reason) {
            const operation = this.getOperation(operationId);
            if (!operation?.offsets?.length || operation.isInvalidated) return false;
            if (operation.preview) operation.preview.ready = false;
            // Downstream artifacts can never outlive an invalidated upstream.
            if (operation.stamps) {
                delete operation.stamps.preview;
                delete operation.stamps.toolpath;
            }
            this.toolpaths.delete(operationId);
            operation.isInvalidated = true;
            operation.invalidatedReason = reason;
            return true;
        }

        /** Marks generated indexed 3+1 operations stale after a post change. */
        invalidateIndexedOperations(postProcessor) {
            for (const op of this.operations) {
                if (op.offsets?.length && op.offsets[0].metadata?.indexed === true) {
                    this.refreshStaleFlags(op.id, `Post-processor changed to '${postProcessor}'. Indexed 3+1 needs the a-word route - regenerate to re-check it.`);
                }
            }
        }

        /**
         * Deletes one artifact and everything downstream of it. A toolpath
         * cannot outlive the geometry it was built from, and preview.primitives
         * ARE the offset primitives tagged in place.
         */
        deleteOperationGeometry(operationId, geometryType) {
            const operation = this.getOperation(operationId);
            if (!operation) return false;

            if (geometryType === 'offsets_combined' || geometryType.startsWith('offset_')) {
                if (geometryType === 'offsets_combined') operation.offsets = [];
                else if (operation.offsets) operation.offsets.splice(parseInt(geometryType.split('_')[1]), 1);
                // Preview and toolpaths were built from the offsets that just changed.
                if (!operation.offsets?.length) this.resetOperationState(operationId);
                else if (operation.preview) this.deleteOperationGeometry(operationId, 'preview');
                else this.clearToolpaths(operationId);
                return true;
            }

            if ("preview" === geometryType) {
                operation.preview = null;
                operation.stamps && delete operation.stamps.preview;
                // Restore offsets visibility when preview is deleted
                if (operation.layerVisibility) {
                    operation.layerVisibility.offsets = true;
                    operation.offsets?.forEach((_, i) => {
                        operation.layerVisibility[`offset_${i}`] = true;
                    });
                }
                this.clearToolpaths(operationId);
                return true;
            }

            if (geometryType === 'toolpath') this.clearToolpaths(operationId);
            return true;
        }

        /* Per-operation toolpaths */
        setToolpaths(operationId, data) {
            this.toolpaths.set(operationId, data);
            const op = this.getOperation(operationId);
            if (!op) return;
            op.layerVisibility ||= {};
            // Same contract as the preview above. On a 3D chain the offsets ARE
            // the toolpath chains in the same frame, so both drawn is
            // overplotting; on 2D/2.5D the preview is the swath the toolpath
            // walks.
            op.layerVisibility.toolpath = true;
            op.layerVisibility.preview = false;
            const dim = this.registry?.dimensionFor(op.type, this.machineClassOf(op));
            if ("3d" === dim) op.layerVisibility.offsets = false;
        }

        getToolpaths(operationId) {
            return this.toolpaths.get(operationId) || null;
        }

        clearToolpaths(operationId) {
            this.toolpaths.delete(operationId);
            const op = this.getOperation(operationId);
            if (op?.stamps) delete op.stamps.toolpath;
        }

        /* Queries & statistics */

        /**
         * Terminal artifact present and not stale: toolpaths for a chain that
         * ends in G-code, offsets for one that ends in a vector file. One rule
         * for both, so a machine setting that moves geometry asks a laser or
         * knife job to regenerate the way it asks a CNC job to recalculate.
         * TODO(settings-scope) - settingsRevision is global: a CNC-only edit
         * (post, start code, safe Z) also stales laser and knife offsets, and
         * a stale terminal only drops out of the Export Manager list, with no
         * mark in the tree. Per-category revisions, then a stale mark.
         */
        isExportReady(op) {
            if (!op || op.isInvalidated) return false;
            const artifacts = this.registry?.artifactsFor(op.type, this.machineClassOf(op)) || [];
            if ('toolpath' === artifacts[artifacts.length - 1]) {
                return this.toolpaths.has(op.id) && !this.isArtifactStale(op, 'toolpath');
            }
            return op.offsets?.length > 0 && !this.isArtifactStale(op, 'offsets');
        }

        updateStatistics() {
            this.stats.operations = this.operations.length;
            this.stats.totalPrimitives = this.operations.reduce((sum, op) => sum + (op.primitives?.length || 0), 0);
        }

        getStats() {
            return { ...this.stats };
        }

        debug(message, data = null) {
            if (!debugState.enabled) return;
            if (data !== null) console.log(`[Store] ${message}`, data);
            else console.log(`[Store] ${message}`);
        }
    }

    ROOT.OperationStore = OperationStore;
})();
