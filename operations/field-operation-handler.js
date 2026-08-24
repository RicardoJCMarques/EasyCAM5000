/*!
 * @file        operations/field-operation-handler.js
 * @description The field operation layer - everything the three
 *              field-driven 3D handlers (relief, radial rotary, indexed
 *              3+1) share:
 *
 *              FieldWorkerClient      - the worker pool. Also used by
 *                                       ShapeVCarveHandler; its run()
 *                                       and warmUp() contract is fixed.
 *              FieldParams            - the single interpretation point
 *                                       for workholding, tuning and
 *                                       model/machine orientation.
 *              FieldOperationHandler  - orchestration skeleton: token,
 *                                       validation, the buildJobs()
 *                                       fan-out with per-job sync
 *                                       fallback, field caching, pass
 *                                       grouping and result messaging.
 *
 *              Subclasses implement buildJobs(), validateSource() and
 *              buildSharedMetadata(). One job or N, the flow is the same.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    // ─── Field worker pool ────────────────────────────────────────────
    // N workers (defaults to cores-1, capped). Jobs go to the least-busy
    // worker; per-primitive vcarve jobs and per-face indexed jobs
    // therefore parallelize across cores. A worker that errors rejects
    // only ITS jobs and leaves the pool; when the pool is empty the
    // client disables itself and the sync paths take over - nothing is
    // lost, only moved back to the main thread.
    const FieldWorkerClient = {
        _pool: null,        // null = untried, [] = disabled, [workers] = live
        _seq: 0,

        /**
         * Auto by default. navigator.hardwareConcurrency is universally
         * supported and browsers already clamp it (Safari caps at 8, some
         * report a privacy-reduced value), so it needs no ladder - but the
         * ceiling here is MEMORY, not threads: every field worker holds a
         * transferred mesh copy plus several full grids, so 16 of them on a
         * dense STL is gigabytes. V-carve jobs are small and saturate well
         * below the cap anyway.
         * CAMConfig.defaults.fieldWorkerPool > 0 forces an explicit size.
         */
        _poolSize() {
            const cfg = window.CAMConfig.defaults.fieldWorkerPool;
            if (cfg > 0) return cfg;
            const hw = navigator.hardwareConcurrency || 4;
            return Math.max(2, Math.min(hw - 1, 8));
        },

        _constantsCache: null,

        /**
         * Structured clone rejects functions, and CAMConfig.constants
         * carries at least one (storageKeys.forApp) - postMessage threw
         * "Function object could not be cloned" and every field job fell
         * back to the main thread. Strip rather than whitelist: a
         * whitelist goes stale the moment a worker module reads a new
         * key. Runs once per session; the result is shipped once per
         * worker, not once per job.
         */
        _constants() {
            if (this._constantsCache) return this._constantsCache;
            const strip = (v) => {
                if (typeof v === 'function' || v === undefined) return undefined;
                if (v === null || typeof v !== 'object') return v;
                if (Array.isArray(v)) return v.map(strip);
                const out = {};
                for (const k of Object.keys(v)) {
                    const c = strip(v[k]);
                    if (c !== undefined) out[k] = c;
                }
                return out;
            };
            this._constantsCache = strip(window.CAMConfig.constants);
            return this._constantsCache;
        },

        _spawn(url) {
            const entry = { worker: null, jobs: new Map() };
            const w = new Worker(url);
            w.onmessage = (e) => {
                const job = entry.jobs.get(e.data.id);
                if (!job) return;
                // Progress heartbeat: a liveness cue, not a terminal
                // message - the job entry stays live.
                if (e.data.progress) {
                    job.onProgress?.(e.data.progress);
                    return;
                }
                entry.jobs.delete(e.data.id);
                if (e.data.ok) {
                    job.resolve(e.data);
                } else {
                    const err = new Error(e.data.error);
                    // The main-thread stack ends at _spawn, which is where the
                    // worker was CREATED, not where it threw. Keep the worker's
                    // own stack or a module-level typo is unlocatable.
                    if (e.data.stack) err.stack = `${err.stack}\n--- worker ---\n${e.data.stack}`;
                    // Set by the worker on anything thrown out of the
                    // slicer or a generator: the same inputs on the main
                    // thread throw again, so the caller must not retry.
                    err.fatal = e.data.fatal === true;
                    job.reject(err);
                }
            };
            w.onerror = (e) => {
                console.warn('[FieldWorker] worker failed, removing from pool:',
                    e.message || e);
                for (const j of entry.jobs.values()) {
                    const err = new Error('field worker error');
                    err.fatal = false;   // transport failure - the sync path is valid
                    j.reject(err);
                }
                entry.jobs.clear();
                w.terminate();
                const i = this._pool.indexOf(entry);
                if (i >= 0) this._pool.splice(i, 1);
            };
            entry.worker = w;
            return entry;
        },

        /** Call once at app init (idle) so the first generation doesn't
         *  pay importScripts cold-start. Safe to skip - lazy init works. */
        warmUp() { this._get(); },

        _get() {
            if (this._pool !== null) return this._pool;
            try {
                const url = window.CAMConfig.paths.fieldWorker;
                const n = this._poolSize();
                this._pool = [];
                for (let i = 0; i < n; i++) this._pool.push(this._spawn(url));
            } catch (_) {
                this._pool = [];
            }
            return this._pool;
        },

        /**
         * @param {Object} job - { kind, ... } message fields. Known kinds:
         *   relief/rotary: { kind, mesh, sliceOptions, genOptions }
         *   vcarve:        { kind, prim, genOptions }
         * Fields outside that list (a resolved-params bag, a face index)
         * stay on the caller's side - only the ones below are posted.
         * @returns {Promise|null} null = pool unavailable, use sync path
         */
        run(job, onProgress = null) {
            const pool = this._get();
            if (pool.length === 0) return null;

            // Least-busy dispatch
            let entry = pool[0];
            for (const e of pool) if (e.jobs.size < entry.jobs.size) entry = e;

            const id = ++this._seq;
            // The worker defers importScripts to its first job and installs
            // this as self.CAMConfig BEFORE the modules load, so their
            // top-level debugState snapshots bind to a LIVE object; later
            // jobs mutate that same object, so a mid-session debug toggle
            // reaches every warm worker on its next job.
            const dbg = window.CAMConfig.defaults.debug;
            const msg = {
                id, kind: job.kind, genOptions: job.genOptions,
                debug: { enabled: dbg.enabled === true }
            };
            // Constants never change in a session and the tree is ~10KB of
            // UI strings the structured clone would re-walk on every job.
            // Message order per worker is guaranteed, so the first job to
            // reach it is the one that carries them.
            if (!entry.configSent) {
                msg.constants = this._constants();
                entry.configSent = true;
            }
            const transfer = [];
            if (job.mesh) {
                // Copy before transfer: the operation keeps its mesh intact,
                // which is also what makes an N-face fan-out over one mesh safe.
                msg.triangles = job.mesh.triangles.slice();
                msg.sliceOptions = job.sliceOptions;
                transfer.push(msg.triangles.buffer);
            }
            if (job.prim) msg.prim = job.prim; // plain data, structured clone
            // Caller-supplied transferables. postMessage's structured clone
            // runs SYNCHRONOUSLY on the calling thread, so a job that ships
            // thousands of {x,y} objects bills the main thread for the clone
            // AND blocks the dispatch of the next job. Anything packed into a
            // typed array (vcarve contours, floor loops) is listed here and
            // moves in O(1) instead. genOptions is walked by the clone, so
            // buffers nested inside it are transferred correctly too.
            if (job.transfer) transfer.push(...job.transfer);

            // No job deadline: long compensation runs are legitimate
            // (minutes on fine grids / deep windows), and timing out
            // triggers the sync fallback - DOUBLING the work on the main
            // thread. A genuinely dead worker still rejects via onerror
            // and leaves the pool; progress heartbeats are the liveness
            // signal instead.
            return new Promise((resolve, reject) => {
                entry.jobs.set(id, { resolve, reject, onProgress });
                entry.worker.postMessage(msg, transfer);
            });
        }
    };
    window.FieldWorkerClient = FieldWorkerClient; // vcarve handler uses it too

    // ════════════════════════════════════════════════════════════════
    // FieldParams - the shared parameter interpretation point.
    //
    // Radial and indexed read the SAME schema keys for workholding, so
    // they must read them through the same code or the two engines can
    // interpret one user choice two ways.
    // ════════════════════════════════════════════════════════════════
    const FieldParams = {

        /**
         * Null-safe rotation composition (null = identity - the builders
         * already treat an absent orient that way). A genuine product is
         * run through assertRotation so a reflection cannot slip into a
         * slice frame; a lone factor passes through, both suppliers being
         * pure rotations by construction. Without this, the DEFAULT radial
         * config (rotaryAxis 'x', model lying down) hands mul() two nulls.
         */
        composeOrient(a, b) {
            const T = window.Transform3D;
            if (a && b) return T.assertRotation(T.mul(a, b), 'field orient');
            return a || b || null;
        },

        /**
         * Workholding, both kinematics.
         *
         * Conventions: chuck = LOW end of the rotary axis, tail = HIGH.
         * Nothing downstream re-derives which end is which.
         *
         * coreRadius is the DRIVE STUB and it is never zero by accident.
         * Radial removal cannot reach the axis, so a cylinder of at least
         * this radius survives the whole machined length by construction -
         * it carries torque from the chuck and a tailstock centre bears on
         * it. It is in the maths for EVERY holding mode; zeroing it for a
         * cantilevered job commands the tool onto the axis and parts the
         * work off. A cantilevered job wants a SMALL stub (the schema
         * allows 0, floored by the generator) and finishes as a sandable nib.
         *
         * Each end resolves to TWO independent facts:
         *
         // REVIEW - These termination comments are a bit confusinng.
         *   material - what the target holds PAST the model edge.
         *     'stub'  the drive cylinder ('stop'); the zone is never
         *             machined, the low target just stops the compensator
         *             ramping off phantom stock.
         *     'lip'   per-line edge value - mm (mm is a DEPTH): an explicit
         *             separation groove past the edge.
         *     'free'  ('taper' mode) no band at all - the window extends
         *             kernelR + mm and the waste floor + tool profile form
         *             the falloff.
         *
         *   reach - how far past the model edge the tool CENTRE may travel.
         *     ONE number, consumed by the slicer padding AND the generator's
         *     machinable window. SIGNED on 'stop': negative trims the window
         *     inward (a slanted base, a slope the tip cannot enter cleanly),
         *     positive machines further out into the waste. Never re-floor
         *     it - that discards the whole negative half of the parameter.
         *
         * There is no 'blank' material. It meant "real stock continues here,
         * leave it", which on a between-centers job resolved for BOTH ends
         * and left everything past the model at full stock radius - the tool
         * snapping out to the blank instead of terminating.
         */
        // REVIEW - Some branch combinations generate perfectly acceptable
        //          geometry; only the ones that deform should be documented
        //          as incompatible rather than removed.
        // TODO(workholding-solid) - The end modes should stop being three
        // branches inside the pipeline and become ONE synthetic end solid
        // (cylinder / cone / prism) composed into the target before
        // rasterization, the way commercial rotary CAM expects fixture stubs
        // to already be part of the model. 'stop', 'lip' and 'taper'
        // are then three parameterizations of the same primitive, and a
        // model whose base is neither flat nor perpendicular to the axis
        // stops mattering because the STUB defines the end. It would also
        // make the workholding visible in the preview before cutting.
        // REVIEW - There used to be a termination with the reach set as "reach = kernelR + raw;" and it produced interesting termination geometry as the final fallback instead of just raw.
        //          Confirm in the future if it's worth implementing as an extra strategy.
        workholding(p) {
            const holdingMode = p.rotaryHoldingMode ?? 'between_centers';
            const toolD = Math.max(0.02, p.toolDiameter || 3);
            const kernelR = toolD / 2;
            // Tool-derived: a lip of 0 makes 'lip' indistinguishable
            // from an outward extension of the model's edge.
            const autoLip = toolD *
                (window.CAMConfig?.constants?.rotary?.autoLipFraction ?? 0.1);

            const end = (mode, mm) => {
                // profile-shape.json labels this end mode 'rollover'; the
                // pipeline calls the material it composes 'lip'. Renaming the
                // profile value would invalidate every saved parameter state
                // holding 'rollover', so the translation lives here.
                // REVIEW - Sounds like this is an easy syntax problem to fix somewhere else? Either rollover or lip should take precedence and all other mentions updated/removed?
                let m = mode || 'stop';
                if (m === 'rollover') m = 'lip';
                const raw = Number(mm) || 0;
                const len = Math.abs(raw);
                let material, reach, amount;
                if (m === 'lip') {
                    material = 'lip';
                    amount = (len > 0) ? len : autoLip;
                    reach = kernelR + amount;
                } else if (m === 'taper') {
                    // FREE END. No composed band: the window runs one
                    // cutting radius (+mm) past the model and the target out
                    // there is the waste floor, so the taper is the tool
                    // profile eroding the end wall - stub radius on radial,
                    // severance plane on indexed. Larger and smoother than
                    // the old explicit cone, which this replaces.
                    material = 'free';
                    amount = len;
                    reach = kernelR + len;
                } else { // 'stop'
                    material = 'stub';
                    amount = 0;
                    // NO tool-radius allowance: the window ends at the
                    // model's own axial extent, because that is where the
                    // chuck and the tailstock are. The allowance that lets
                    // a tool centre pass an edge to form a wall exists only
                    // in the CROSS direction (collarCells), where the
                    // neighbour is waste. Signed: negative trims inward.
                    reach = raw;
                }
                return { mode: m, mm: amount, material, reach };
            };

            return {
                holdingMode,
                coreRadius: p.rotaryMinRadius ?? 2,
                ends: {
                    chuck: end(p.rotaryChuckEndMode, p.rotaryChuckEndMm),
                    tail:  end(p.rotaryTailEndMode,  p.rotaryTailEndMm)
                }
            };
        },

        /**
         * Model → machine orientation (VISUAL). Lays an upright model down
         * along the machine's rotary axis, in WORLD coordinates. Null = the
         * model already lies along it.
         */
        visualOrient(machineAxis, upright) {
            if (!upright) return null;
            return (machineAxis === 'y')
                ? [1, 0, 0,   0, 0, 1,   0, -1, 0]   // R_x(-90°): +Z → +Y
                : [0, 0, 1,   0, 1, 0,  -1, 0, 0];   // R_y(+90°): +Z → +X
        },

        /**
         * Machine rotary axis → CylMapBuilder's internal axial X (INTERNAL).
         * A pure rotation, never a reflection: a reflection mirrors the
         * slicing frame, so θ runs opposite to the machine's right-hand-rule
         * B and the sign has to be undone at the machine boundary.
         *
         * CONSEQUENCE: no rotation maps +Y→+X while keeping +X→+Y, so the
         * sliced cross-u axis is -worldX for a B(y) job. cm.axisB is
         * therefore the NEGATED world coordinate of the axis line - see
         * axisBSign(). Cross-v stays +worldZ, so axisC needs no sign.
         *
         * Indexed slices in world orientation and needs NEITHER this nor
         * axisBSign - do not port them there.
         */
        internalOrient(machineAxis) {
            return (machineAxis === 'y')
                ? [0, 1, 0,  -1, 0, 0,   0, 0, 1]    // R_z(-90°): +Y → +X
                : null;
        },

        /** cm.axisB (sliced cross-u) ↔ world. See internalOrient. */
        axisBSign(machineAxis) {
            return (machineAxis === 'y') ? -1 : 1;
        }
    };
    window.FieldParams = FieldParams;

    const DEG = Math.PI / 180;

    // ════════════════════════════════════════════════════════════════
    // IndexedBlank - the 3+1 prism, resolved once per generation.
    //
    // ONE vertex pass produces every projection the geometry needs, and
    // ONE object derives every scalar from it. The pass works because the
    // face-normal projection is affine in the axis centre:
    //     nu·(u - cu) + nv·(v - cv) = (nu·u + nv·v) - (nu·cu + nv·cv)
    // so the per-face extremes can be accumulated alongside the bounds
    // that define the centre, instead of in a second pass after it.
    //
    // Nothing here returns a sentinel. Infinity (blankCircumRadius) and
    // null (facetHalfWidth) both used to escape into `> 0` tests
    // downstream and read as "disabled".
    // ════════════════════════════════════════════════════════════════
    const IndexedBlank = {

        /**
         * @param {Float32Array} triangles - 9 floats per triangle
         * @param {Object} o
         * @param {string} o.machineAxis     - 'x' (A word) | 'y' (B word)
         * @param {number[]|null} o.visualOrient - row-major 3x3, or null
         * @param {number[]} o.angles        - face angles, degrees
         * @param {number} o.offB, o.offC    - WORLD axis offsets
         * @returns {Object} survey - axis line, per-face support, extents
         */
        survey(triangles, o) {
            const m = o.visualOrient;
            const angles = o.angles;
            const n = angles.length;
            // cross-u is world Y for an A(x) job, world X for a B(y) job;
            // cross-v is world Z in both.
            const uIsX = (o.machineAxis === 'y');

            // Face normals in the visual frame: n_k = R(-θk)·ẑ. Routed
            // through Transform3D, never hand-derived: this is one of the
            // four coupled sign sites.
            const T = window.Transform3D;
            const nu = new Float64Array(n);
            const nv = new Float64Array(n);
            for (let k = 0; k < n; k++) {
                const d = T.applyVec(T.rotAboutAxis(o.machineAxis, -angles[k]), [0, 0, 1]);
                nu[k] = uIsX ? d[0] : d[1];
                nv[k] = d[2];
            }

            let minU = Infinity, maxU = -Infinity;
            let minV = Infinity, maxV = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            const pMax = new Float64Array(n).fill(-Infinity);
            const pMin = new Float64Array(n).fill(Infinity);

            for (let i = 0; i < triangles.length; i += 3) {
                let x = triangles[i], y = triangles[i + 1], z = triangles[i + 2];
                if (m) {
                    const ox = m[0] * x + m[1] * y + m[2] * z;
                    const oy = m[3] * x + m[4] * y + m[5] * z;
                    const oz = m[6] * x + m[7] * y + m[8] * z;
                    x = ox; y = oy; z = oz;
                }
                const u = uIsX ? x : y;
                const a = uIsX ? y : x;
                if (u < minU) minU = u; if (u > maxU) maxU = u;
                if (z < minV) minV = z; if (z > maxV) maxV = z;
                if (a < minA) minA = a; if (a > maxA) maxA = a;
                for (let k = 0; k < n; k++) {
                    const d = nu[k] * u + nv[k] * z;
                    if (d > pMax[k]) pMax[k] = d;
                    if (d < pMin[k]) pMin[k] = d;
                }
            }

            const cu = (minU + maxU) / 2 + (o.offB || 0);
            const cv = (minV + maxV) / 2 + (o.offC || 0);

            const perFace = new Array(n);
            let supportMax = 0, backMax = 0;
            for (let k = 0; k < n; k++) {
                const c = nu[k] * cu + nv[k] * cv;
                perFace[k] = pMax[k] - c;
                const back = -(pMin[k] - c);
                if (perFace[k] > supportMax) supportMax = perFace[k];
                if (back > backMax) backMax = back;
            }

            const halfU = Math.max(maxU - cu, cu - minU);
            const halfV = Math.max(maxV - cv, cv - minV);

            return {
                // Axis line in the VISUAL frame. The axial component is ZERO
                // by contract - it must pass through unshifted so every face
                // shares the same station index.
                Cvis: uIsX ? [cu, 0, cv] : [0, cu, cv],
                perFace, supportMax, backMax,
                halfU, halfV,
                crossHalfSpan: Math.max(halfU, halfV),
                modelCircumRadius: Math.hypot(halfU, halfV),
                // Rotation about the machine axis leaves this fixed, so it is
                // the same in every face's frame - which is what makes one
                // locked cell size possible.
                axialExt: maxA - minA
            };
        },

        /**
         * Every prism scalar, derived once. Warnings come out as issues[]
         * so the caller has one place to drain them.
         *
         * @param {Object} survey - from survey()
         * @param {Object} o
         * @param {number[]} o.angles
         * @param {number} o.blankWidth   - across flats; 0 = derive
         * @param {number} o.toolDiameter
         * @param {number} o.coreRadius   - requested drive stub
         * @param {number} o.overcutUser  - 0 = auto (one cutting radius)
         * @param {number} o.depthUser    - 0 = auto
         */
        resolve(survey, o) {
            const issues = [];
            const angles = o.angles;
            const toolD = Math.max(0.02, o.toolDiameter || 3);

            // Across-flats/2, and it IS the shared Z datum the operator
            // touches off. Deriving it from the model is a fallback, never
            // the intent - say so.
            const derived = !(o.blankWidth > 0);
            const apothem = derived ? survey.supportMax : o.blankWidth / 2;
            if (derived) {
                issues.push(`indexedBlankWidth not set - derived ` +
                    `${(2 * apothem).toFixed(2)}mm across flats from the model's own ` +
                    `face-normal support. The physical blank must be at least this ` +
                    `wide, and Z0 is its face top.`);
            } else if (survey.supportMax > apothem + 1e-6) {
                const worst = survey.perFace.reduce(
                    (b, v, i) => (v > survey.perFace[b] ? i : b), 0);
                issues.push(`Model reaches ${survey.supportMax.toFixed(2)}mm from the ` +
                    `axis on the ${angles[worst].toFixed(0)}° face, past the blank ` +
                    `apothem (${apothem.toFixed(2)}mm) - that material is TRUNCATED ` +
                    `to the face plane. Set indexedBlankWidth to at least ` +
                    `${(2 * survey.supportMax).toFixed(2)}mm.`);
            }

            // The widest angular gap owns both the corner and the facet.
            let gapMax = 0;
            if (angles.length >= 2) {
                const norm = angles.map(a => ((a % 360) + 360) % 360).sort((x, y) => x - y);
                gapMax = 360 - (norm[norm.length - 1] - norm[0]);   // wrap-around
                for (let i = 1; i < norm.length; i++) {
                    const g = norm[i] - norm[i - 1];
                    if (g > gapMax) gapMax = g;
                }
            } else {
                gapMax = 360;
            }
            const halfGap = (gapMax / 2) * DEG;
            const cosHalf = Math.cos(halfGap);

            // Cross half-width of the stock this setup can see. A gap >= 180
            // means the opposing faces tile the whole section, so this face
            // owns everything out to the stock's own extent - a FINITE
            // number, not the Infinity/null that read as "disabled".
            const stockHalfSpan = Math.max(apothem, survey.crossHalfSpan);
            const facetHalfWidth = (cosHalf <= 1e-6 || gapMax >= 180 - 1e-6)
                ? stockHalfSpan
                : Math.min(apothem * Math.tan(halfGap), stockHalfSpan);

            // Rotation clearance is the CORNER, not the apothem, and the
            // model may legitimately overhang the blank.
            const clearRadius = Math.max(
                survey.modelCircumRadius,
                cosHalf > 1e-6 ? apothem / cosHalf : stockHalfSpan);

            // Severance over-cut. Never gated on the core: the stub is a
            // cross-band about the axis, the over-cut deepens the waste
            // OUTSIDE it. Disjoint cells; a job can and should have both.
            const overcut = (o.overcutUser > 0) ? o.overcutUser : toolD / 2;
            const coreRadius = Math.min(Math.max(0, o.coreRadius ?? 0), apothem);
            if (coreRadius > 0 && coreRadius < toolD / 2) {
                issues.push(`Drive stub radius ${coreRadius.toFixed(2)}mm is under the ` +
                    `tool radius ${(toolD / 2).toFixed(2)}mm - the stub is formed as ` +
                    `the tool's offset of the core cylinder (safe, but wider than set).`);
            }

            // Depth WINDOW, not the floor: it bounds mapDepths' clamp and
            // nothing else. backMax is a vertex-cloud extent, so this is
            // generous by design.
            const maxDepth = apothem + Math.max(overcut, survey.backMax);
            let depthWindow = (o.depthUser > 0) ? o.depthUser : maxDepth;
            if (depthWindow > maxDepth + 1e-9) {
                issues.push(`indexedDepth clamped to ${maxDepth.toFixed(2)}mm below ` +
                    `the face plane.`);
                depthWindow = maxDepth;
            }
            if (depthWindow < apothem + overcut - 1e-6) {
                issues.push(`Depth window ${depthWindow.toFixed(2)}mm stops ` +
                    `${(apothem + overcut - depthWindow).toFixed(2)}mm short of the ` +
                    `severance depth - every surface past machine Z ` +
                    `${(apothem - depthWindow).toFixed(2)} is TRUNCATED to a flat ` +
                    `plane. Leave indexedDepth at 0 (auto) unless you are ` +
                    `deliberately limiting engagement.`);
            }

            return {
                apothem, blankWidth: 2 * apothem, derivedBlank: derived,
                gapMax, facetHalfWidth, stockHalfSpan, clearRadius,
                coreRadius, overcut, depthWindow,
                supportMax: survey.supportMax, backMax: survey.backMax,
                issues
            };
        },

        describe(p) {
            return `apothem=${p.apothem.toFixed(2)}mm` +
                `${p.derivedBlank ? '(derived)' : ''} ` +
                `facet=${p.facetHalfWidth.toFixed(2)}mm ` +
                `corner=${p.clearRadius.toFixed(2)}mm ` +
                `core=${p.coreRadius.toFixed(2)}mm ` +
                `overcut=${p.overcut.toFixed(2)}mm ` +
                `window=${p.depthWindow.toFixed(2)}mm (gap ${p.gapMax.toFixed(1)}°)`;
        }
    };
    window.IndexedBlank = IndexedBlank;

    // ════════════════════════════════════════════════════════════════
    // FieldOperationHandler
    // ════════════════════════════════════════════════════════════════

    class FieldOperationHandler extends BaseOperationHandler {

        // Descriptive-only for 3D chains: the optimizer routes is3DContour
        // groups via ordered3D/unordered3D and `continue`s before reading
        // policy. Kept for the day it branches on policy instead of flags.
        getToolpathPolicy() {
            return { staydownPartition: 'proximity' };
        }

        // ── Orchestration ────────────────────────────────────────────

        async orchestrateGeneration(operation, params, core, options = {}) {
            const guard = this.validateSource(operation);
            if (guard) return guard;

            // Monotonic per-operation token: each run stamps a new value; any
            // earlier run still in flight sees the mismatch and discards its
            // result instead of clobbering the newer field.
            const token = this.beginRun(operation, options, core);
            const opParams = core.compileOperationParams(operation, params);
            const merged = { ...params, ...opParams };

            await this.generateGeometry(operation, merged);

            if (this.isStale(operation, token)) {
                return {
                    success: false,
                    message: 'Generation superseded by a newer request',
                    status: 'warning'
                };
            }

            const total = operation.offsets?.reduce(
                (s, o) => s + (o.primitives?.length || 0), 0) || 0;

            // Builder, generator and resolver warnings, collected across
            // every job. Console output is dev-only and hidden behind the
            // generating overlay; this is the user-visible path, and it
            // lands in the status log automatically via setStatus. It must
            // fire on the EMPTY result too - that is the case the warnings
            // exist to explain.
            const warnings = operation._fieldWarnings || [];
            const suffix = warnings.length > 0 ? ` - ${warnings.join(' ')}` : '';

            if (total === 0) {
                return {
                    success: false,
                    message: this.emptyMessage() + suffix,
                    status: 'warning'
                };
            }

            const passes = operation.offsets.map(o => o.type).join(' + ');
            return {
                success: true,
                message: `Generated ${total} ${this.passTypePrefix()} path(s) ` +
                    `[${passes}]` + suffix,
                status: warnings.length > 0 ? 'warning' : 'success'
            };
        }

        // ── Generation - one job or N, the same flow ─────────────────

        async generateGeometry(operation, settings) {
            const label = this.pipelineLabel();
            const token = operation._genToken; // stamped by orchestrateGeneration
            this.debug(`=== ${label} PIPELINE START ===`);
            this.debug(`Operation: ${operation.id} (${operation.type})`);

            const warnings = [];
            operation._fieldWarnings = warnings;

            const jobs = this.buildJobs(operation, settings, warnings);
            if (!jobs || jobs.length === 0) {
                operation.offsets = [];
                return [];
            }

            const n = jobs.length;
            const prog = this.makeProgressAggregator(operation._onProgress || null, n);

            // Dispatch ALL jobs first - the least-busy pool parallelizes them.
            const pendings = jobs.map((job, k) => {
                const p = FieldWorkerClient.run(job, prog.tick(k));
                // Every job is dispatched before the first is awaited, so a
                // throw while awaiting job 0 leaves jobs 1..n-1 rejecting
                // into nothing and the real error gets buried under
                // "Uncaught (in promise)". The sink marks them handled; the
                // loop below still sees each rejection through its own
                // catch, because `p` is what it awaits.
                p?.catch(() => {});
                return p;
            });

            const containers = [];
            const allPrimitives = [];

            for (let k = 0; k < n; k++) {
                let res = null;
                if (pendings[k]) {
                    try {
                        res = await pendings[k];
                    } catch (err) {
                        // A generator/slicer error is deterministic - the sync
                        // path runs the same code on the same inputs and pays
                        // the whole slice a second time before throwing again.
                        if (err.fatal) throw err;
                        this.debug(`Job ${k}: worker unavailable (${err.message}) ` +
                            `- main-thread fallback`);
                    }
                }

                let container, primitives;
                if (res) {
                    container = FieldSpace.rehydrate(res.field);
                    primitives = this.rehydratePrimitives(res.primitives);
                    this.debug(`Job ${k}: worker → ${primitives.length} chain(s)`);
                } else {
                    const sync = this.runJobSync(jobs[k]);
                    container = sync.container;
                    primitives = sync.primitives;
                    this.debug(`Job ${k}: sync → ${primitives.length} chain(s)`);
                }

                // ONE token namespace (operation._genToken) - never a parallel
                // counter. Bail before mutating anything.
                if (this.isStale(operation, token)) {
                    this.debug(`${label} superseded mid-run - discarded`);
                    return operation.offsets || [];
                }

                for (const w of container.meta?.warnings || []) {
                    if (!warnings.includes(w)) warnings.push(w);
                }

                this.onJobPrimitives(primitives, jobs[k]);
                containers.push(container);
                allPrimitives.push(...primitives);
                prog.done(k);
            }

            const ctx = { containers, jobs, settings, warnings };
            this.cacheFields(operation, ctx);

            operation.offsets = this.groupByPass(
                allPrimitives, operation, this.buildSharedMetadata(ctx), settings);

            this.debug(`Generated ${allPrimitives.length} primitive(s) across ` +
                `${n} job(s), ${operation.offsets.length} pass group(s)`);
            this.debug(`=== ${label} PIPELINE COMPLETE ===`);
            return operation.offsets;
        }

        /**
         * Main-thread execution of the same job the worker would run -
         * same builders, same generators, same options. The triangle
         * buffer is safe to reuse: FieldWorkerClient.run() slices a copy
         * before transferring.
         */
        runJobSync(job) {
            const isRotary = job.kind === 'rotary';
            const container = isRotary
                ? CylMapBuilder.fromMesh(job.mesh.triangles, job.sliceOptions)
                : HeightmapBuilder.fromMesh(job.mesh.triangles, job.sliceOptions);
            const primitives = isRotary
                ? RotaryGenerator.generateRotaryPaths(container, job.genOptions)
                : ReliefGenerator.generateReliefPaths(container, job.genOptions);
            return { container, primitives };
        }

        /**
         * Aggregated progress across a parallel fan-out.
         *
         * Sums EVERY job's own partial. `done` advances in await order and
         * cannot describe concurrent work: reading (done + oneInFlight)/n
         * makes a 4-job bar oscillate inside [0, 0.25] for the whole long
         * phase, then snap 0.25 → 0.5 → 0.75 → 1.0 as the already-finished
         * promises resolve. The label reports the aggregate, not whichever
         * job ticked last - naming one branch of a parallel run is what
         * made it flicker.
         *
         * A single job passes the worker's structured tick through
         * untouched; the state manager owns the one formatter.
         */
        makeProgressAggregator(onProgress, n) {
            if (!onProgress || n === 1) {
                return { tick: () => onProgress, done: () => {} };
            }
            const frac = new Float64Array(n);
            let doneCount = 0;
            return {
                tick: (k) => (p) => {
                    frac[k] = Math.min(1, Math.max(0, p.frac || 0));
                    let sum = 0;
                    for (let i = 0; i < n; i++) sum += frac[i];
                    onProgress({
                        frac: Math.min(0.999, sum / n),
                        label: `Jobs ${doneCount}/${n} done - ${p.label || 'Working'}`
                    });
                },
                done: (k) => { frac[k] = 1; doneCount++; }
            };
        }

        /**
         * Worker records → packed 3D primitives.
         *
         * The worker has no primitives.js, so FieldPaths.toPrimitive falls
         * through to its plain-object branch and flattenPrimitives ships
         * { positions, properties } records. Those MUST be rebuilt into
         * Polyline3DPrimitives here: Toolpath3DTranslator.extractChains gates
         * on `type === 'path3d' && positions`, so a raw record falls to the
         * empty-contours branch and every chain is dropped with a console
         * warning.
         *
         * A non-finite coordinate is a hard failure, not something to
         * coerce: this path bypasses fromPoints (whose check the sync
         * fallback gets for free) and flattenPrimitives writes `z ?? 0`,
         * which passes NaN straight through. A NaN Z reaching the
         * translator lands at the blank surface (rotary) or the face plane
         * (indexed) - a silent blob, never an error.
         */
        rehydratePrimitives(list) {
            const out = [];
            for (const p of list) {
                const pos = p.positions;
                for (let i = 0; i < pos.length; i++) {
                    if (!Number.isFinite(pos[i])) {
                        const err = new Error(
                            `[${this.constructor.name}] non-finite coordinate from ` +
                            `the field worker - upstream generator bug. Geometry ` +
                            `discarded rather than shipped.`);
                        err.fatal = true;
                        throw err;
                    }
                }
                out.push(new Polyline3DPrimitive(pos, p.properties));
            }
            return out;
        }

        /** Container → pipeline primitive wrapper. */
        wrapField(container) {
            return (container instanceof CylMap)
                ? new CylMapPrimitive(container)
                : new HeightmapPrimitive(container);
        }

        /**
         * Publishes the representative field for this operation.
         *
         * NOT mirrored into operation.primitives: that array is source
         * geometry, rebuilt from the scene by OperationBucket.syncPrimitives
         * on every regeneration, and nothing renders a heightmap or cylmap
         * from it. operation.bounds is syncPrimitives' - a padded grid extent
         * is not the shape's footprint.
         */
        cacheFields(operation, ctx) {
            const container = ctx.containers[0];
            operation.fieldPrimitive = container ? this.wrapField(container) : null;
        }

        /**
         * Splits generator output into one offset group per machining pass
         * so the UI can toggle/delete them independently. Both groups are
         * flagged is3DToolpath; every primitive already carries
         * is3DContour + machiningPhase (the phase key Toolpath3DTranslator
         * ranks by).
         */
        groupByPass(primitives, operation, sharedMeta, settings) {
            const prefix = this.passTypePrefix();
            const roughing = primitives.filter(p => p.properties?.machiningPhase === 'roughing');
            const finishing = primitives.filter(p => p.properties?.machiningPhase !== 'roughing');

            const offsets = [];
            if (roughing.length > 0) {
                offsets.push({
                    id: `${prefix}_rough_${operation.id}`,
                    distance: 0,
                    pass: 1,
                    type: `${prefix}-roughing`,
                    primitives: roughing,
                    metadata: { ...sharedMeta, finalCount: roughing.length },
                    settings: { ...settings }
                });
            }
            if (finishing.length > 0) {
                offsets.push({
                    id: `${prefix}_finish_${operation.id}`,
                    distance: 0,
                    pass: offsets.length + 1,
                    type: `${prefix}-finishing`,
                    primitives: finishing,
                    metadata: { ...sharedMeta, finalCount: finishing.length },
                    settings: { ...settings }
                });
            }
            return offsets;
        }

        /** Shared mesh-source lookup (operation.sourceMesh). */
        getMeshSource(operation) {
            const m = operation.sourceMesh;
            return (m?.triangles?.length) ? m : null;
        }

        // ── Subclass contract ────────────────────────────────────────
        // buildJobs(operation, settings, warnings)
        //                     - the work, as [{ kind, mesh, sliceOptions,
        //                       genOptions, ...caller data }]. Return []
        //                       for "nothing to do". May push warnings.
        // validateSource(operation)
        //                     - guard result, or null to proceed. Settings
        //                       are not resolved yet; anything needing them
        //                       belongs in buildJobs.
        // buildSharedMetadata - offset-group metadata from
        //                       { containers, jobs, settings, warnings }.
        // onJobPrimitives     - per-job stamping hook (indexed faces).

        buildJobs() { throw new Error(`${this.constructor.name}.buildJobs() not implemented`); }
        validateSource() { throw new Error(`${this.constructor.name}.validateSource() not implemented`); }
        buildSharedMetadata() { return {}; }
        onJobPrimitives() {}
        passTypePrefix() { return 'field'; }
        emptyMessage() { return 'No paths generated'; }
        pipelineLabel() { return this.passTypePrefix().toUpperCase(); }
    }

    window.FieldOperationHandler = FieldOperationHandler;
})();
