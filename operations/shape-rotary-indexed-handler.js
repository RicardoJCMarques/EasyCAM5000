/*!
 * @file        operations/shape-rotary-indexed-handler.js
 * @description Indexed 3+1 rotary handler - N ordinary flat reliefs at
 *              fixed A angles, joined by pure A positioning moves. The
 *              undercut/occlusion complement to continuous radial
 *              rotary: better overhang handling than axial relief
 *              without simultaneous 4-axis motion.
 *
 *              ── HOW IT WORKS ─────────────────────────────────────────
 *              Reached through ShapeRotaryHandler when the operation's
 *              rotaryKinematics param is 'indexed'. Each face k at angle
 *              θk is one standard `kind:'relief'` field job:
 *
 *                orient_k = R_axis(+θk) · visualOrient(axis, upright)
 *                offset_k = R_axis(+θk) · C_visual
 *
 *              where C_visual is the rotary-axis line's cross-section
 *              center (model bounds center + user axis offsets) in the
 *              laid-down (visual) frame, with ZERO axial component.
 *              HeightmapBuilder applies p' = orient·p - offset, so in
 *              every face's sliced frame:
 *
 *                x = axial position along the rotary axis (shared)
 *                y = 0 ON THE AXIS LINE (shared across all faces)
 *                z = 0 at the axis; face plane at exactly z = +apothem
 *
 *              The A move is therefore the ONLY thing that changes
 *              between faces, by construction. No internalOrient, no
 *              bSign: those exist for radial only because CylMapBuilder
 *              remaps the rotary axis onto its internal X. Indexed
 *              slices in world orientation and needs neither.
 *
 *              ── Z REFERENCE (shared across faces) ────────────────────
 *              genOptions.surfaceRefZ = apothem tells the generator that
 *              depth 0 is the BLANK FACE PLANE, not the model's highest
 *              point in this view (hm.zMin makes the absolute frame
 *              recoverable after normalize()). Without it, a face the
 *              model doesn't touch would carry a different Z0 than one
 *              it does - a physical gouge between faces. Operator
 *              contract: X0 anywhere on the axis, Y0 on the rotary
 *              centerline, Z0 touched off on ONE face top; every face
 *              shares it because the blank is centered on the axis.
 *
 *              ── SIGN CALIBRATION (two COUPLED flip points) ───────────
 *              A 4th-axis viewer/controller places a move at
 *              R_axis(-A)·(X,Y,Z): the table turns +A, so a fixed machine
 *              point sits at -A in the part frame. The A word is emitted
 *              verbatim as θk (a positive table position - what the
 *              operator dials), so A=θk presents the face whose REST
 *              normal is at -θk. Slicing therefore rotates by +θk to bring
 *              THAT face to +Z, and the viewer's R_axis(-θk) rotates it
 *              back onto the part: R(-θk)·R(+θk) = I, correct at EVERY
 *              angle. Slicing with -θk instead composes to R(-2θk) -
 *              identity at θk∈{0,180} (a 2-face job passes by luck) but
 *              wrong at 120/240, 90/270, etc.: faces pinned to the wrong
 *              position, some on their antipode.
 *
 *              This sign lives in TWO places that must move together: the
 *              rotAboutAxis call in buildFaceSliceOptions AND the
 *              R_axis(-A) wrap in the preview's walkPlans
 *              (renderer3d-toolpath.js). If a bench test shows a mirrored
 *              face, flip BOTH signs, never one. A emission stays
 *              verbatim - never "fix" it there.
 *
 *              ── PROPS STAMPED ON EVERY CHAIN ─────────────────────────
 *                props.indexed          → translator frame branch
 *                                         (identity mapPt, surfaceZ 0)
 *                props.indexA (deg)     → plan.metadata.indexedA →
 *                                         insertIndexMoves A rapids
 *                props.indexOrder       → metadata + _IX: groupKey →
 *                                         optimizer face ordering
 *                props.axisKind         → A vs B word
 *                props.indexedFaceOrder → optimizer groupRank mode
 *                props.indexedApothem   → preview wrap + export Z shift
 *                props.indexedClearRadius → index-move retract height
 *
 *              ── v1 SCOPE ─────────────────────────────────────────────
 *              Prismatic (flat-faced) blanks only - square/rect or an
 *              explicit angle list; a flat heightmap per face is EXACT.
 *              Round-stock pseudo-faces, residual-stock tracking and
 *              fixture collision are explicit non-goals. Collision v1
 *              (holder envelope) IS in scope: plain-data o.holder rides
 *              genOptions and the generator wraps the ToolProfile itself
 *              (closures can't cross postMessage).
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const T3D = () => window.Transform3D;

    class ShapeIndexedHandler extends FieldOperationHandler {

        passTypePrefix() { return 'indexed'; }
        pipelineLabel()  { return 'INDEXED'; }
        emptyMessage() {
            return 'No indexed paths generated - model may be flat, below ' +
                   'resolution, or entirely outside the face windows';
        }

        validateSource(operation) {
            if (!this.getMeshSource(operation)) {
                return {
                    success: false,
                    message: 'No indexed source - import an STL model for this operation',
                    status: 'warning'
                };
            }
            return null;
        }

        // ── Frame math ───────────────────────────────────────────────

        /**
         * Which GRID direction is the rotary axis in the sliced frame.
         *
         * HeightmapBuilder maps cols→x, rows→y with NO swap - unlike
         * CylMapBuilder, which remaps the rotary axis onto its internal
         * axial X. buildFaceSliceOptions composes rotAboutAxis(machineAxis,
         * θk) · visualOrient(machineAxis, upright); rotating ABOUT an axis
         * leaves that axis fixed, and visualOrient already put it on its own
         * world axis, so:
         *
         *   machineAxis 'x' (A word) → axis lies along grid x → COLUMNS
         *   machineAxis 'y' (B word) → axis lies along grid y → ROWS
         *
         * Every direction-sensitive option - the boundary band, the raster
         * direction - resolves through this. A literal 'x' here is always a
         * bug that only shows on B-axis jobs.
         */
        static axialGridAxis(machineAxis) {
            return (machineAxis === 'y') ? 'y' : 'x';
        }

        // ── Parameter resolution ─────────────────────────────────────

        /**
         * Post-capability precheck - advisory only. The machine pass
         * (insertIndexMoves) stays the authority at export; this puts the
         * same mismatch in the status bar at GENERATE time, before a full
         * slice+compensate pass on a job the post cannot emit.
         */
        postCapabilityWarning(machineAxis) {
            const gen = this.core?.gcodeGenerator;
            const postName = this.core?.settings?.gcode?.postProcessor;
            if (!gen?.getProcessorInfo || !postName) return null;
            const caps = gen.getProcessorInfo(postName)?.capabilities?.rotary;
            const routes = caps?.routes || [];
            const wantWord = (machineAxis === 'y') ? 'B' : 'A';
            if (routes.length === 0) {
                return `Post '${postName}' declares no 4th-axis routes - ` +
                    `G-code export will drop this operation.`;
            }
            if (routes.indexOf('a-word') < 0) {
                return `Indexed 3+1 needs the 'a-word' route (absolute degrees ` +
                    `on ${wantWord}); post '${postName}' declares ` +
                    `[${routes.join(', ')}] - export will drop this operation.`;
            }
            if ((caps.axisWords || []).indexOf(wantWord) < 0) {
                return `A rotary axis of ${machineAxis.toUpperCase()} needs the ` +
                    `'${wantWord}' word; post '${postName}' declares ` +
                    `[${(caps.axisWords || []).join(', ') || 'none'}] - ` +
                    `export will drop this operation.`;
            }
            return null;
        }

        /**
         * Face angle list (degrees, MACHINING ORDER - never sorted).
         * n evenly spaced faces, offset by indexedStartAngle so a 4-face job
         * can sit at ±45/±135 instead of 0/90/180/270. Negatives are emitted
         * verbatim on the A word - insertIndexMoves does not normalize, and
         * must not: -90 and 270 are the same face but different travel.
         * An explicit angle LIST needs a text-input field type first.
         */
        resolveFaceAngles(s) {
            const start = Number(s.indexedStartAngle) || 0;
            const n = Math.max(1, Math.round(Number(s.indexedFaceCount) || 2));
            const out = new Array(n);
            for (let k = 0; k < n; k++) out[k] = start + (360 / n) * k;
            return out;
        }

        /** Plain-data holder descriptor (postMessage-safe) or null.
         *  cuttingLength doubles as fluteLength until the library grows an
         *  explicit override. */
        buildHolder(settings) {
            if (settings.indexedCollisionGuard !== true) return null;
            const tool = this.core?.toolLibrary?.getTool?.(settings.tool);
            const g = tool?.geometry;
            if (!g) {
                this.debug('collisionGuard on but tool record unavailable - guard skipped');
                return null;
            }
            const fluteLength = g.fluteLength ?? g.cuttingLength;
            const { shankDiameter, holderDiameter, holderStickout } = g;
            if (!(fluteLength > 0) || !(shankDiameter > 0) ||
                !(holderDiameter > 0) || !(holderStickout > 0)) {
                this.debug('collisionGuard on but tool lacks holder fields ' +
                    '(need cuttingLength/fluteLength, shankDiameter, ' +
                    'holderDiameter, holderStickout) - guard skipped');
                return null;
            }
            return {
                fluteLength, shankDiameter, holderDiameter, holderStickout,
                margin: 0.5   // added to shank/holder radii in the envelope
            };
        }

        /**
         * One resolution pass per generation. Every key is schema-backed;
         * inline `??` values MATCH the schema and exist only for direct API
         * callers. Keys that differ IN KIND between kinematics carry an
         * indexed* name (indexedRoughStepdown is Z-per-layer,
         * rotaryRoughStepdown is radius-per-layer); everything else is
         * shared on the rotary* key.
         *
         * All prism geometry - Z datum, depth window, facet band, rotation
         * clearance, stub cap - comes from IndexedBlank, which surveys the
         * mesh ONCE and returns every number finite. Workholding comes from
         * the SAME resolver radial uses.
         */
        resolveIndexedParams(s, mesh, warnings, operation) {
            const machineAxis = (s.rotaryAxis === 'y') ? 'y' : 'x';
            const upright = (s.rotaryModelUp ?? 'upright') === 'upright';
            const visualOrient = FieldParams.visualOrient(machineAxis, upright);
            const angles = this.resolveFaceAngles(s);

            const capWarn = this.postCapabilityWarning(machineAxis);
            if (capWarn) warnings.push(capWarn);

            const axialAxis = ShapeIndexedHandler.axialGridAxis(machineAxis);
            const crossAxis = (axialAxis === 'x') ? 'y' : 'x';
            // Raster direction is SEMANTIC ('axial' | 'cross'); legacy
            // 'x'/'y' saved values map onto the same two intents.
            const rasterMode = s.indexedRasterAxis ?? 'axial';
            const rasterAxis = (rasterMode === 'cross' || rasterMode === 'y')
                ? crossAxis : axialAxis;

            const toolDiameter = s.toolDiameter || 3;
            const wh = FieldParams.workholding(s);

            const survey = IndexedBlank.survey(mesh.triangles, {
                machineAxis, visualOrient, angles,
                offB: s.rotaryAxisOffsetB ?? 0,
                offC: s.rotaryAxisOffsetC ?? 0
            });
            const resolveOpts = {
                angles,
                blankWidth: s.indexedBlankWidth,
                toolDiameter,
                coreRadius: wh.coreRadius,
                overcutUser: Number(s.indexedAxisOvercut) || 0,
                depthUser: s.indexedDepth
            };
            let prism = IndexedBlank.resolve(survey, resolveOpts);

            // Sticky derived width. A blank is a physical object: its
            // across-flats - and with it the Z datum the operator touched
            // off - must not shrink because the face count changed (the
            // tightest 8-prism IS wider than the tightest slab). An
            // explicit indexedBlankWidth wins outright; otherwise the
            // widest support this operation has ever derived is the floor.
            // Grow-only: a bigger mesh still grows it, a smaller one keeps
            // it - harmless, the blank merely exceeds the part.
            if (!(s.indexedBlankWidth > 0) && operation) {
                const sticky = operation._stickyBlankWidth || 0;
                if (sticky > prism.blankWidth + 1e-9) {
                    prism = IndexedBlank.resolve(survey,
                        { ...resolveOpts, blankWidth: sticky });
                }
                operation._stickyBlankWidth = Math.max(sticky, prism.blankWidth);
            }
            for (const issue of prism.issues) warnings.push(issue);

            // The severance over-cut lives OUTSIDE the silhouette and only
            // roughing masks that band, so a finishing-only job emits the
            // model surface and nothing else - which reads as "the faces
            // never separated".
            // TODO(rotary-mode-default) - 'finishing' is right for radial and
            // wrong for indexed, so this warning fires on every default
            // indexed job. A per-kinematics default needs getDefaults() to
            // take more than an operation type; splitting the key would
            // violate the profile's SPLIT RULE (pass mode does not differ in
            // kind between the two engines).
            // REVIEW - Default is set to finishing to help see toolpaths that follow the surface of the mesh with tool compensation as expected. Comment may be wrong, actual default can be changed?
            const mode = s.rotaryMode ?? 'finishing';
            if (mode === 'finishing') {
                warnings.push(`Finishing-only: the ${prism.overcut.toFixed(2)}mm ` +
                    `severance over-cut is never emitted - only roughing masks the ` +
                    `stock outside the silhouette. The faces will meet at the axis ` +
                    `instead of overlapping. Set the mode to roughing or both.`);
            }

            const holder = this.buildHolder(s);
            if (holder && holder.fluteLength < prism.apothem + prism.overcut - 1e-9) {
                warnings.push(`Flute ${holder.fluteLength}mm cannot reach the ` +
                    `rotation axis (${(prism.apothem + prism.overcut).toFixed(2)}mm ` +
                    `below the face plane). The holder envelope limits the tool ` +
                    `per-cell; expect uncut material near the centerline.`);
            }

            // LOCKED GRID. HeightmapBuilder derives auto cell size from the
            // ROTATED bounds, and a rectangular section at 45° has a bbox √2
            // larger than at 0° - so every face would quantize its end bands
            // differently ("end walls don't line up around the part"). One
            // size from orientation-invariant extents, passed explicitly.
            const gridMaxDim = s.rotaryGridMaxDim ?? 1024;
            const lockedCell = (s.rotaryCellSize > 0)
                ? s.rotaryCellSize
                : Math.max(0.005, Math.max(
                    survey.axialExt, 2 * prism.stockHalfSpan) / gridMaxDim);

            const C = window.CAMConfig.constants.rotary;
            return {
                machineAxis, upright, visualOrient, angles,
                axialAxis, crossAxis,
                Cvis: survey.Cvis,
                apothem: prism.apothem,
                blankWidth: prism.blankWidth,
                blankWidthDerived: prism.derivedBlank,
                clearRadius: prism.clearRadius,
                facetHalfWidth: prism.facetHalfWidth,
                // Grid half-width across the face: the facet this setup owns
                // plus the collar the tool centre needs to form its edge.
                crossGridHalf: prism.facetHalfWidth + toolDiameter / 2 + C.padSlackMm,
                coreRadius: prism.coreRadius,
                overcut: prism.overcut,
                totalDepth: prism.depthWindow,
                prism,
                holdingMode: wh.holdingMode, ends: wh.ends,
                faceOrder: s.indexedFaceOrder ?? 'sequential', // | 'phase'
                toolDiameter,
                toolShape: s.rotaryToolShape ?? 'ball',
                cornerRadius: s.rotaryCornerRadius ?? 0.5,
                mode,
                roughStepdown: s.indexedRoughStepdown ?? 1.5,
                roughStepoverPct: s.rotaryRoughStepoverPct ?? 45,
                roughStock: s.rotaryRoughStock ?? 0.3,
                finishStepoverPct: s.rotaryFinishStepoverPct ?? 10,
                crossFinish: s.indexedCrossFinish === true,
                rasterAxis,
                cellSize: lockedCell,
                gridMaxDim,
                simplifyTolerance: C.simplifyTolerance,
                minSegmentLength: C.minSegmentLength,
                holder
            };
        }

        // ── Job construction ─────────────────────────────────────────

        buildJobs(operation, settings, warnings) {
            const mesh = this.getMeshSource(operation);
            if (!mesh) return [];

            const ix = this.resolveIndexedParams(settings, mesh, warnings, operation);
            const genOptions = this.buildFaceGenOptions(ix);

            this.debug(`Faces: [${ix.angles.map(a => a.toFixed(1)).join(', ')}]° ` +
                `about ${ix.machineAxis.toUpperCase()} (axial grid=${ix.axialAxis}, ` +
                `raster=${ix.rasterAxis}), ${IndexedBlank.describe(ix.prism)}, ` +
                // Every plane the pipeline can write, in MACHINE Z (= face
                // value + apothem). Z0 is the rotation axis. A flat mesa in
                // the output sits at one of these.
                `planes[machineZ]: window=${(ix.apothem - ix.totalDepth).toFixed(2)} ` +
                `severance=${(-ix.overcut).toFixed(2)}, mode=${ix.mode}, ` +
                `${ix.holdingMode}, chuck=${ix.ends.chuck.mode}/tail=${ix.ends.tail.mode}, ` +
                `order=${ix.faceOrder}` +
                (ix.holder ? `, holder Ø${ix.holder.holderDiameter}mm` : ''));

            // The resolved bag rides the job rather than the handler: two
            // generations of the same operation can overlap, and instance
            // state would let the newer one's frame stamp the older one's
            // chains. Extra job fields are not posted to the worker.
            return ix.angles.map((_, k) => ({
                kind: 'relief',
                mesh,
                sliceOptions: this.buildFaceSliceOptions(ix, k),
                genOptions,
                ix,
                faceIndex: k
            }));
        }

        buildFaceSliceOptions(ix, k) {
            // SIGN CALIBRATION POINT - see file header. Rotate by +θk (NOT
            // -θk): a 4th-axis viewer/controller places a move at
            // R_axis(-A)·(X,Y,Z) and the A word is emitted verbatim as θk.
            // The preview's walkPlans wrap uses the SAME R_axis(-A) sense so
            // screen == G-code; flip together or not at all.
            const R = T3D().rotAboutAxis(ix.machineAxis, ix.angles[k]);

            // Grid reserved PER END from that end's own reach - the same
            // numbers the generator's axial window consumes, so the window
            // cannot clamp at the grid edge instead of forming the end wall.
            // Cross gets one cutting radius + slack for the dilated
            // silhouette collar; the outermost collar cell may clip at the
            // grid edge by ≤ 1 cell - bounded.
            const alongLow  = Math.max(0, ix.ends.chuck.reach) + window.CAMConfig.constants.rotary.padSlackMm;
            const alongHigh = Math.max(0, ix.ends.tail.reach)  + window.CAMConfig.constants.rotary.padSlackMm;
            // Grid must span the BLANK across the face, not just the model:
            // stock outside the silhouette is what the next face collides
            // with. The axis is at 0 in the cross direction by the offset
            // contract, so the band is symmetric. crossGridHalf is resolved
            // on the prism and is ALWAYS finite - the three-way facet width
            // used to arrive as null here and `> 0` read it as zero, leaving
            // every 2-face job with a model-width grid and no severance band.
            const across = ix.toolDiameter / 2 + window.CAMConfig.constants.rotary.padSlackMm;
            const expandTo = (ix.axialAxis === 'y')
                ? { minX: -ix.crossGridHalf, maxX: ix.crossGridHalf }
                : { minY: -ix.crossGridHalf, maxY: ix.crossGridHalf };
            const axialPad = (ix.axialAxis === 'y')
                ? { x0: across,   x1: across,    y0: alongLow, y1: alongHigh }
                : { x0: alongLow, x1: alongHigh, y0: across,   y1: across };

            return {
                // composeOrient, never a bare mul: visualOrient is null for
                // a lying-down model, and null = identity by contract.
                orient: FieldParams.composeOrient(R, ix.visualOrient),
                // Rotates WITH the frame: the axis lands at (y=0, z=0) in
                // every face's sliced coordinates → shared XY frame, face
                // plane at exactly z = +apothem (the surfaceRefZ contract).
                offset: T3D().applyVec(R, ix.Cvis),
                cellSize: ix.cellSize > 0 ? ix.cellSize : null,
                gridMaxDim: ix.gridMaxDim,
                padding: axialPad,
                expandTo
            };
        }

        /** Identical for every face - built once per generation. */
        buildFaceGenOptions(ix) {
            const d = ix.toolDiameter;
            return {
                toolDiameter: d,
                toolShape: ix.toolShape,
                cornerRadius: ix.cornerRadius,
                // 'literal' + surfaceRefZ is the multi-face Z contract:
                // depth 0 = blank face plane (z = apothem, absolute in the
                // sliced frame via hm.zMin), NOT the per-view model top.
                // 'scaled' would rescale each face independently - never
                // expose it for indexed.
                depthMapping: 'literal',
                surfaceRefZ: ix.apothem,
                totalDepth: ix.totalDepth,
                startDepth: 0,
                // Deepest legal tip position past the axis. Resolved ONCE,
                // in resolveIndexedParams; consumed verbatim.
                axialOvercut: ix.overcut,
                // Half-width of the facet this setup owns. Roughing clears
                // stock out to here; finishing stays on the silhouette.
                // Always finite - see IndexedBlank.resolve.
                axialFacetHalfWidth: ix.facetHalfWidth,
                invert: false,
                roughing: ix.mode !== 'finishing',
                finishing: ix.mode !== 'roughing',
                roughStepdown: ix.roughStepdown,
                roughStepover: d * (ix.roughStepoverPct / 100),
                roughStock: ix.roughStock,
                finishStepover: d * (ix.finishStepoverPct / 100),
                crossFinish: ix.crossFinish,
                rasterAxis: ix.rasterAxis,
                simplifyTolerance: ix.simplifyTolerance,
                minSegmentLength: ix.minSegmentLength,
                skipFloor: false,
                // AXIAL LIMITS - supersedes the isotropic boundary policy.
                // The pipeline computes model span, per-end reach window and
                // the composed end targets along this grid direction.
                // Chuck = LOW axial index, tail = HIGH.
                axial: {
                    axis: ix.axialAxis,
                    ends: ix.ends
                },
                // Core radius for the composed radial floor - a cylinder
                // about the rotation axis, paired with surfaceRefZ above,
                // which locates that axis at z = -apothem in every face's
                // frame. 0 means NO floor at all, not a plane at the axis.
                coreRadius: ix.coreRadius,
                // 0 = auto. The pipeline forces it to 1 under the axial
                // policy - its target carries a tool-reach cliff at the
                // collar boundary that bilinear upsampling would drag into
                // the emission mask. Left at 0 so plain relief (same
                // generator, no o.axial) still gets the auto speed-up.
                compLattice: 0,
                // Plain data by design - the generator wraps the profile
                // itself (closures die at the postMessage boundary).
                holder: ix.holder
            };
        }

        // ── Per-face stamping and caching ────────────────────────────

        onJobPrimitives(prims, job) {
            const ix = job.ix;
            const k = job.faceIndex;
            for (const prim of prims) {
                const props = prim.properties || (prim.properties = {});
                props.indexed = true;               // translator frame branch
                props.indexA = ix.angles[k];        // degrees, machine A/B word
                props.indexOrder = k;               // machining order, _IX: group
                props.axisKind = ix.machineAxis;    // 'x'→A word, 'y'→B word
                props.indexedFaceOrder = ix.faceOrder;
                // Preview contract: the rotation axis line sits at
                // (y=0, z=-apothem) below the face top in every face's
                // frame - the 3D walker needs the value to wrap.
                props.indexedApothem = ix.apothem;
                // Rotation clearance (radius from the axis) -
                // insertIndexMoves lifts every index move above this.
                props.indexedClearRadius = ix.clearRadius;
            }
        }

        /**
         * Face heightmaps are FACE-FRAME (axis-centered), not workspace
         * geometry. The base publishes face 0 as operation.fieldPrimitive and
         * keeps it off operation.primitives; this override only adds the
         * cross-face consistency check.
         */
        cacheFields(operation, ctx) {
            const ix = ctx.jobs[0].ix;

            // Per-face axial span check. With a locked cell size the three
            // numbers below are identical on every face unless the model is
            // not actually symmetric about the rotation axis.
            const axialOf = (hm) => hm && ((ix.axialAxis === 'y')
                ? [hm.originY, hm.originY + (hm.rows - 1) * hm.cellSize]
                : [hm.originX, hm.originX + (hm.cols - 1) * hm.cellSize]);

            const spans = ctx.containers.map(axialOf).filter(Boolean);
            if (spans.length > 1) {
                const lo = spans.map(s => s[0]), hi = spans.map(s => s[1]);
                const dLo = Math.max(...lo) - Math.min(...lo);
                const dHi = Math.max(...hi) - Math.min(...hi);
                const tol = 2 * (ix.cellSize > 0 ? ix.cellSize : 0.2);
                if (dLo > tol || dHi > tol) {
                    ctx.warnings.push(`Faces see different axial model extents ` +
                        `(chuck end varies ${dLo.toFixed(2)}mm, tail end ` +
                        `${dHi.toFixed(2)}mm) - end walls will not line up around ` +
                        `the part. Check the rotation axis and model orientation.`);
                }
            }

            // ── Section-stack smoke check (debug.sections) ───────────
            // Stage 1 of the migration: rebuild each face's top envelope
            // from ONE plane sweep and diff it against the heightmap the
            // face machined from. medianΔ absorbs the data-vs-absolute-Z
            // and cell-center conventions; maxDev is the real disagreement
            // (expect ~cell-sized values on smooth regions, larger only at
            // silhouette walls, where a half-cell shift meets a steep
            // slope). Persistently large maxDev on interior stations means
            // the sweep is NOT ready to replace fromMesh.
            if (window.CAMConfig.defaults.debug.sections === true) {
                try {
                    const mesh = this.getMeshSource(operation);
                    const hm0 = ctx.containers[0];
                    const axIsX = (ix.axialAxis === 'x');
                    const axOrigin = axIsX ? hm0.originX : hm0.originY;
                    const axCount = axIsX ? hm0.cols : hm0.rows;

                    const sec = window.SectionSlicer.fromMesh(mesh.triangles, {
                        orient: ix.visualOrient, origin: ix.Cvis,
                        uIsX: (ix.machineAxis === 'y'),
                        a0: axOrigin, pitch: ix.cellSize, count: axCount
                    });

                    const T = window.Transform3D;
                    const cu = (ix.machineAxis === 'y') ? 0 : 1; // cross-u world idx
                    ctx.containers.forEach((hm, k) => {
                        if (!hm) return;
                        const M = T.rotAboutAxis(ix.machineAxis, ix.angles[k]);
                        const rot = { uu: M[cu * 3 + cu], uv: M[cu * 3 + 2],
                                      vu: M[2 * 3 + cu],  vv: M[8] };
                        const crossO = axIsX ? hm.originY : hm.originX;
                        const crossN = axIsX ? hm.rows : hm.cols;

                        const dsRaw = [];
                        for (let st = 0; st < axCount; st++) {
                            const env = window.SectionSlicer.envelopeTop(
                                sec.stations[st],
                                { ...rot, u0: crossO, cell: hm.cellSize, cols: crossN });
                            let eMax = -Infinity, hMax = -Infinity;
                            for (let c = 0; c < crossN; c++) {
                                if (env.top[c] > eMax) eMax = env.top[c];
                                const i = axIsX ? (c * hm.cols + st) : (st * hm.cols + c);
                                if (hm.mask && !hm.mask[i]) continue;
                                if (hm.data[i] > hMax) hMax = hm.data[i];
                            }
                            // Absolute sliced Z on both sides: the heightmap
                            // is normalized against zMin, the sections are
                            // not. With that added, medianΔ should be ~0 and
                            // a nonzero median is itself the signal (a frame
                            // or datum mismatch) rather than a convention.
                            if (Number.isFinite(eMax) && Number.isFinite(hMax)) {
                                dsRaw.push(eMax - (hMax + (hm.zMin || 0)));
                            }
                        }
                        if (!dsRaw.length) {
                            console.log(`[SectionCheck] face ${k}: no overlap`);
                            return;
                        }
                        const ds = dsRaw.slice().sort((a, b) => a - b);
                        const med = ds[ds.length >> 1];
                        let maxDev = 0;
                        for (const v of dsRaw) {
                            const dev = Math.abs(v - med);
                            if (dev > maxDev) maxDev = dev;
                        }
                        console.log(`[SectionCheck] face ${k} ` +
                            `(${ix.angles[k].toFixed(1)}°): ${dsRaw.length}/` +
                            `${axCount} station(s), medianΔ=${med.toFixed(3)} ` +
                            `maxDev=${maxDev.toFixed(3)} (cell ` +
                            `${hm.cellSize.toFixed(3)})`);
                    });
                } catch (err) {
                    console.warn('[SectionCheck] failed:', err);
                }
            }

            super.cacheFields(operation, ctx);
        }

        buildSharedMetadata(ctx) {
            const hm = ctx.containers[0];
            const o = ctx.jobs[0].genOptions;
            const ix = ctx.jobs[0].ix;

            return {
                generatedAt: Date.now(),
                toolDiameter: o.toolDiameter,
                toolShape: o.toolShape,
                indexed: true,
                faceCount: ix.angles.length,
                indexedFaceOrder: ix.faceOrder,
                rotaryAxisKind: ix.machineAxis,
                blankWidth: ix.blankWidth,
                apothem: ix.apothem,
                // Preview frame - the indexed counterpart of continuous
                // rotary's rotaryFrame. refresh3D needs the VISUAL orient
                // plus the axis line's cross-section center to move the mesh
                // into the same frame the toolpaths are wrapped in. Slicing
                // subtracts Cvis outright, so exported paths are
                // AXIS-CENTERED: the mesh must be translated by
                // -axisCenter.b on the cross axis, unlike continuous rotary
                // which publishes a world axis and zeroes XY.
                //
                // The blank prism lives INSIDE this object, not at metadata
                // top level, so refresh3D reads one object and cannot
                // half-resolve a blank. clearRadius is the CIRCUMradius -
                // corner to axis, the same number insertIndexMoves lifts its
                // rotation moves above - not the apothem.
                indexedFrame: {
                    orient: ix.visualOrient,
                    machineAxis: ix.machineAxis,
                    apothem: ix.apothem,
                    axisCenter: {
                        b: ix.machineAxis === 'y' ? ix.Cvis[0] : ix.Cvis[1],
                        c: ix.Cvis[2]
                    },
                    clearRadius: ix.clearRadius,
                    faceCount: ix.angles.length,
                    startAngle: ix.angles[0] || 0,
                    gridCols: hm?.cols,
                    cellSize: hm?.cellSize,
                    originX: (ix.axialAxis === 'y') ? hm?.originY : hm?.originX
                },
                gridCols: hm?.cols,
                gridRows: hm?.rows,
                cellSize: hm?.cellSize,
                is3DToolpath: true
                // NOTE: no developedSpace, no refRadius - indexed plans
                // must NEVER route into convertDevelopedToRotary.
            };
        }
    }

    window.ShapeIndexedHandler = ShapeIndexedHandler;
})();
