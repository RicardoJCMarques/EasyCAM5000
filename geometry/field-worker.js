/*!
 * @file        geometry/field-worker.js
 * @description Classic Web Worker: slices a mesh into a Heightmap/CylMap
 *              and runs the relief/rotary generator off the main thread,
 *              plus the per-primitive V-Carve fan-out.
 *
 *              The geometry modules are worker-clean by design (guarded
 *              CAMConfig, no DOM); FieldPaths.toPrimitive falls back to
 *              plain objects here, which are flattened into transferable
 *              { positions, properties } records. The main thread
 *              (FieldOperationHandler) rehydrates Polyline3DPrimitives;
 *              the field container is rebuilt through
 *              FieldSpace.rehydrate, the mirror of the serialize() call
 *              below.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * If ever bundled by build, worker-src 'self' in the HTML may need changing.
 */

'use strict';

let modulesLoaded = false;

/**
 * Deferred module load. A classic worker runs top-level importScripts
 * before any message can arrive, which is why every module's
 *   const debugState = ROOT.CAMConfig?.defaults?.debug || { enabled:false }
 * used to capture a dead literal. Loading on the FIRST JOB instead lets
 * the job's config snapshot become self.CAMConfig first, so those same
 * snapshots bind to a live object - and ReliefGenerator's
 * constants.rotary read stops being a load-order gamble.
 */
function ensureModules(constants, debug) {
    if (!modulesLoaded) {
        self.CAMConfig = {
            constants: constants || {},
            defaults: { debug: debug || { enabled: false } }
        };
        importScripts(
            'delaunator.5.0.0.min.js',
            '../utils/transform-math-3d.js',
            'geometry-utils-vcarve.js',
            'geometry-utils-toolprofile.js',
            'geometry-utils-field.js',
            'geometry-utils-fieldpaths.js',
            'geometry-utils-heightmap.js',
            'geometry-utils-cylmap.js',
            'geometry-utils-fieldpipeline.js',
            // geometry-utils-sections.js is intentionally absent: SectionSlicer
            // is validation-only (stage 2) and envelopeTop has no caller, so
            // importing it costs a fetch + parse per worker boot for nothing.
            // Re-add it with the survey stage.
            // REVIEW - Does this affect built deployment bundles?
            // 'geometry-utils-sections.js',
            'geometry-utils-relief.js',
            'geometry-utils-rotary.js'
        );
        modulesLoaded = true;
        return;
    }
    // MUTATE, never replace: the modules alias these exact objects.
    // Reassigning defaults.debug would strand every snapshot on the old
    // object and the toggle would die again. Constants arrive only on a
    // worker's FIRST job; debug rides every job.
    if (debug) Object.assign(self.CAMConfig.defaults.debug, debug);
    if (constants) Object.assign(self.CAMConfig.constants, constants);
}

/** Rebuilds packed loops into the {x,y} shape VCarveGenerator's
 *  prepareContours expects. Deliberately runs HERE and not on the main
 *  thread - the allocation is the whole reason the handler packs. */
function unpackLoops(packed) {
    if (!packed) return null;
    const { counts, flags, xy } = packed;
    const loops = [];
    let r = 0;
    for (let i = 0; i < counts.length; i++) {
        const n = counts[i];
        const pts = new Array(n);
        for (let j = 0; j < n; j++) {
            pts[j] = { x: xy[r], y: xy[r + 1] };
            r += 2;
        }
        loops.push({ points: pts, isHole: flags[i] === 1 });
    }
    return loops;
}

/** Flattens generator output (plain-object toPrimitive fallback) into
 *  transferable records. */
function flattenPrimitives(prims, transfer) {
    const out = [];
    for (const p of prims) {
        let positions;
        if (p.positions) {
            positions = p.positions; // packed primitive present
        } else {
            const pts = p.contours[0].points;
            positions = new Float32Array(pts.length * 3);
            for (let i = 0; i < pts.length; i++) {
                positions[i * 3]     = pts[i].x;
                positions[i * 3 + 1] = pts[i].y;
                positions[i * 3 + 2] = pts[i].z ?? 0;
            }
        }
        out.push({ positions, properties: p.properties });
        transfer.push(positions.buffer);
    }
    return out;
}

/** V-Carve: one job = ONE primitive, polygonized and arc-densified by the
 *  handler (GeometryUtils is main-thread only) and packed into typed
 *  arrays. */
// REVIEW - Is this splitting closed primitives properly?
function runVCarve(id, data, transfer) {
    // NOT the stage scaler. STAGE_BANDS describes the FIELD pipeline
    // (slice → compensate → upsample → emit); V-Carve has none of those
    // stages and already sweeps a complete 0.05→0.85 of its own. Running
    // it through the scaler squeezes that into the compensate band, so a
    // glyph reports 30% the instant it starts and tops out at 79%.
    const genOptions = data.genOptions;
    genOptions.onProgress = (p) => self.postMessage({ id, progress: p });

    const loops = unpackLoops(data.prim) || [];
    const prim = {
        type: 'path',
        contours: loops.map(l => ({
            points: l.points, isHole: l.isHole, arcSegments: []
        })),
        properties: {}
    };
    if (genOptions.packedFloorLoops) {
        genOptions.floorLoops = unpackLoops(genOptions.packedFloorLoops);
        genOptions.packedFloorLoops = null;
    }
    const paths = VCarveGenerator.generateVCarvePaths(prim, genOptions);
    self.postMessage(
        { id, ok: true, primitives: flattenPrimitives(paths, transfer) },
        transfer
    );
}

self.onmessage = (e) => {
    const { id, kind, triangles, sliceOptions, genOptions,
            constants, debug } = e.data;
    try {
        ensureModules(constants, debug);   // inside try: import errors report per-job  
        const transfer = [];

        if (kind === 'vcarve') {
            runVCarve(id, e.data, transfer);
            return;
        }

        // Progress channel: functions can't cross postMessage, so the
        // callback is constructed HERE and injected. This is also the ONLY
        // place that sees both the slice call and the generate call, which
        // makes it the only place that can band them onto one bar - hence
        // makeStageScaler. Emitters tag themselves with a `stage`
        // ('slice' | 'compensate' | 'upsample' | 'emit'); untagged ticks
        // fall through to the compensate band.
        const post = (progress) => self.postMessage({ id, progress });
        const scaled = makeStageScaler(post);
        genOptions.onProgress = scaled;
        // Must be assigned AFTER the callback exists: functions can't cross
        // postMessage, so genOptions arrives without one and copying earlier
        // copies undefined and silently kills a heartbeat.
        if (sliceOptions) sliceOptions.onProgress = scaled;

        let container, record, primitives;

        switch (kind) {
            case 'rotary': {
                container = CylMapBuilder.fromMesh(triangles, sliceOptions);
                primitives = flattenPrimitives(
                    RotaryGenerator.generateRotaryPaths(container, genOptions), transfer);
                // Serialized AFTER generation: appliedDepth, appliedStock-
                // StartRadius and the generator's warnings are on meta by then.
                record = FieldSpace.serialize('cylmap', container);
                break;
            }
            case 'relief': {
                container = HeightmapBuilder.fromMesh(triangles, sliceOptions);
                primitives = flattenPrimitives(
                    ReliefGenerator.generateReliefPaths(container, genOptions), transfer);
                record = FieldSpace.serialize('heightmap', container);
                break;
            }
            default:
                throw new Error(`field-worker: unknown job kind '${kind}'`);
        }

        transfer.push(record.data.buffer);
        if (record.mask) transfer.push(record.mask.buffer);
        if (record.hull) transfer.push(record.hull.buffer);
        self.postMessage({ id, ok: true, field: record, primitives }, transfer);
    } catch (err) {
        // Anything reaching here came out of the slicer or a generator on
        // the same inputs the sync fallback would use, so re-running it on
        // the main thread throws again and pays the whole slice twice. The
        // handler reads `fatal` to skip that retry. A dead worker is a
        // different failure and arrives through onerror instead.
        self.postMessage({
            id, ok: false,
            error: err.message || String(err),
            stack: err.stack || null,
            fatal: true
        });
    }
};
