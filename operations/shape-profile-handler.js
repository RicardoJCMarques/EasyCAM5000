/*!
 * @file        operations/shape-profile-handler.js
 * @description Profile cut handler for EasyShape5000.
 *              Extends OffsetOperationHandler with cutSide control and
 *              holding tab support. Does NOT extend CutoutOperationHandler
 *              because cutout's classifyPrimitives (closure detection) is
 *              irrelevant - EasyShape primitives are already closed paths
 *              from SVG import.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
  'use strict';

  const ROOT = globalThis;

  class ShapeProfileHandler extends OffsetOperationHandler {
    // Orchestration
    async orchestrateGeneration(operation, params, core, options = {}) {
      const token = this.beginRun(operation, options, core);

      // Detect nested holes/islands
      const resolved = this.resolveSourceTopology(operation, params);
      if (resolved) operation.primitives = resolved;

      // Validate: profile requires closed geometry
      const openCount = this.countOpenPaths(operation);
      if (openCount > 0) {
        return {
          success: false,
          message: {
            key: 'messages.operations.profileOpenPaths',
            values: {count: openCount}
          },
          status: 'warning'
        };
      }

      const opParams = core.pipelineContext.compileOperationParams(operation, params);

      // Profile always produces a single offset pass per shape
      await this.generateGeometry(operation, {
        ...params,
        ...opParams,
        passes: 1,
        combineOffsets: false
      });

      if (this.isStale(operation, token)) {
        return {
          success: false,
          message: {key: 'messages.operations.superseded'},
          status: 'warning'
        };
      }

      const total = operation.offsets?.reduce(
        (s, o) => s + (o.primitives?.length || 0), 0
      ) || 0;

      if (total === 0) {
        return {
          success: false,
          message: {key: 'messages.operations.noProfile'},
          status: 'warning'
        };
      }

      return {
        success: true,
        message: {
          key: 'messages.operations.profileGenerated',
          values: {side: {key: ['params', 'cutSide', 'options', opParams.cutSide]}}
        },
        status: 'success'
      };
    }
  }

  ROOT.ShapeProfileHandler = ShapeProfileHandler;
})();