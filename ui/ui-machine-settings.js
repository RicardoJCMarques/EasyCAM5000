/*!
 * @file        ui/ui-machine-settings.js
 * @description Shared machine configuration UI - post-processor selection,
 *              Roland profiles, laser settings, and global CNC parameters.
 * @author      Eltryus - Ricardo Marques
 * @copyright   2025-2026 Eltryus - Ricardo Marques
 * @see         {@link https://github.com/RicardoJCMarques/EasyCAM5000}
 *
 * SPDX-FileCopyrightText: 2025-2026 Eltryus - Ricardo Marques
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

(function() {
    'use strict';

    const D = window.CAMConfig.defaults;

    class MachineSettingsUI {
        constructor(ui) {
            this.ui = ui;
        }

        getOpPanel() {
            return this.ui.traceOperationPanel || this.ui.shapeOperationPanel || null;
        }

        getParamManager() {
            return this.getOpPanel()?.parameterManager
                || this.ui.ctrl?.parameterManager
                || null;
        }

        setup() {
            const loadedSettings = this.ui.core.settings;

            // --- Roland machine profiles ---
            const rolandProcessor = this.ui.ctrl.gcodeGenerator.getProcessor('roland');
            const ROLAND_PROFILES = rolandProcessor?.profiles || {};
            const rolandSettings = loadedSettings.processorSettings?.roland || {};

            // --- Post-Processor Dropdown ---
            const postProcessorSelect = document.getElementById('post-processor');
            const startCodeTA = document.getElementById('start-code-ta');
            const endCodeTA = document.getElementById('end-code-ta');

            const updateRolandSettings = (newSettings) => {
                const currentRoland = this.ui.core.settings.processorSettings?.roland || {};
                this.ui.core.updateSettings('processorSettings', {
                    roland: { ...currentRoland, ...newSettings }
                });
            };
            const initialRolandModel = rolandSettings.rolandModel || 'mdx50';
            const initialProfile = ROLAND_PROFILES[initialRolandModel] || ROLAND_PROFILES['custom'];

            if (postProcessorSelect) {
                postProcessorSelect.innerHTML = '';
                const generator = this.ui.ctrl.gcodeGenerator;
                const options = generator ? generator.getAllProcessorDescriptors() : [{ value: 'grbl', label: 'Grbl (Default)' }];
                options.forEach(opt => {
                    const optionEl = document.createElement('option');
                    optionEl.value = opt.value;
                    optionEl.textContent = opt.label;
                    postProcessorSelect.appendChild(optionEl);
                });
                postProcessorSelect.value = loadedSettings.gcode.postProcessor;

                postProcessorSelect.addEventListener('change', (e) => {
                    const newProcessor = e.target.value;
                    const wasProcessor = this.ui.core.settings.gcode.postProcessor;

                    this.ui.core.updateSettings('gcode', {
                        postProcessor: newProcessor,
                        userStartCode: undefined,
                        userEndCode: undefined
                    });

                    const generator = this.ui.ctrl.gcodeGenerator;
                    if (generator && startCodeTA && endCodeTA) {
                        startCodeTA.value = generator.resolveStartCode(newProcessor, undefined);
                        endCodeTA.value = generator.resolveEndCode(newProcessor, undefined);
                    }

                    this.updateProcessorFieldVisibility(newProcessor);

                    this.ui.ctrl.modalManager.clearExportPreview();

                    // core.updateSettings has just marked indexed operations
                    // stale; the tree and the canvas both read isInvalidated,
                    // so they have to be told. Guarded - EasyTrace has neither.
                    for (const b of (this.ui.opsPanel?.getAllBuckets?.() || [])) {
                        this.ui.opsPanel.updateBucketDOM(b, this.ui.core);
                    }
                    this.ui.rebuildLayers?.();

                    const paramMgr = this.getParamManager();
                    if (paramMgr) {
                        const isRoland = newProcessor === 'roland';
                        if (isRoland) {
                            const currentModel = rolandSettings.rolandModel || 'mdx50';
                            paramMgr.updateMachineConstraints(ROLAND_PROFILES[currentModel] || {}, 'roland');
                        } else {
                            paramMgr.updateMachineConstraints({}, newProcessor);
                        }
                    }

                    if (newProcessor !== wasProcessor) {
                        this.ui.setStatus(
                            `Switched to ${newProcessor}. Recalculate toolpaths to apply changes.`,
                            'warning'
                        );
                    }
                });
            }

            // --- Start/End Code ---
            if (startCodeTA) {
                const processor = loadedSettings.gcode.postProcessor;
                const generator = this.ui.ctrl.gcodeGenerator;
                startCodeTA.value = generator
                    ? generator.resolveStartCode(processor, loadedSettings.gcode.userStartCode)
                    : '';
                startCodeTA.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('gcode', { userStartCode: e.target.value });
                });
            }

            if (endCodeTA) {
                const processor = loadedSettings.gcode.postProcessor;
                const generator = this.ui.ctrl.gcodeGenerator;
                endCodeTA.value = generator
                    ? generator.resolveEndCode(processor, loadedSettings.gcode.userEndCode)
                    : '';
                endCodeTA.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('gcode', { userEndCode: e.target.value });
                });
            }

            // --- G-code Units ---
            const gcodeUnitsSelect = document.getElementById('gcode-units');
            if (gcodeUnitsSelect) {
                gcodeUnitsSelect.value = loadedSettings.gcode.units;
                gcodeUnitsSelect.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('gcode', { units: e.target.value });
                });
            }

            // --- Roland-specific fields ---
            const rolandModelSelect = document.getElementById('roland-machine-model');
            const rolandStepsInput = document.getElementById('roland-steps-per-mm');
            const rolandMaxFeedInput = document.getElementById('roland-max-feed');
            const rolandZModeSelect = document.getElementById('roland-z-mode');
            const rolandSpindleModeSelect = document.getElementById('roland-spindle-mode');
            const rolandSpindleInput = document.getElementById('roland-spindle-speed');

            if (rolandModelSelect) {
                rolandModelSelect.value = rolandSettings.rolandModel;
                rolandModelSelect.addEventListener('change', (e) => {
                    const modelId = e.target.value;
                    const profile = rolandProcessor?.profiles[modelId];
                    if (!profile) return;

                    const defaultRPM = profile.spindleFixed ||
                        (profile.spindleRange
                            ? Math.round((profile.spindleRange.min + profile.spindleRange.max) / 2)
                            : 10000);

                    if (rolandStepsInput) rolandStepsInput.value = profile.stepsPerMM;
                    if (rolandMaxFeedInput) rolandMaxFeedInput.value = profile.maxFeedXY;
                    if (rolandZModeSelect) rolandZModeSelect.value = profile.zMode;
                    if (rolandSpindleModeSelect) {
                        rolandSpindleModeSelect.value = profile.spindleMode;
                        rolandSpindleModeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (rolandSpindleInput) rolandSpindleInput.value = defaultRPM;

                    const initCmd = profile.initCommand || ';;^DF';
                    const endCmd = profile.endCommand || ';;^DF';
                    const newStartCode = `${initCmd}\nPA;`;
                    const newEndCode = endCmd;

                    if (startCodeTA) startCodeTA.value = newStartCode;
                    if (endCodeTA) endCodeTA.value = newEndCode;

                    updateRolandSettings({
                        rolandModel: modelId,
                        rolandStepsPerMM: profile.stepsPerMM,
                        rolandMaxFeed: profile.maxFeedXY,
                        rolandZMode: profile.zMode,
                        rolandSpindleMode: profile.spindleMode,
                        rolandSpindleSpeed: defaultRPM,
                    });
                    this.ui.core.updateSettings('gcode', {
                        userStartCode: newStartCode,
                        userEndCode: newEndCode
                    });

                    this.updateRolandProfileFields(profile);

                    const opPanel = this.getOpPanel();
                    opPanel?.parameterManager?.updateMachineConstraints(
                        profile,
                        this.ui.core.settings.gcode.postProcessor
                    );
                    opPanel?.refresh?.();

                    this.ui.setStatus(
                        `Roland profile: ${profile.label} (${profile.stepsPerMM} steps/mm, Z: ${profile.zMode})`, 'info'
                    );
                });
            }

            if (rolandStepsInput) {
                rolandStepsInput.value = rolandSettings.rolandStepsPerMM || initialProfile?.stepsPerMM || 100;
                rolandStepsInput.addEventListener('change', (e) => {
                    updateRolandSettings({ rolandStepsPerMM: parseInt(e.target.value) || 100 });
                });
            }

            if (rolandMaxFeedInput) {
                rolandMaxFeedInput.value = rolandSettings.rolandMaxFeed || initialProfile?.maxFeedXY || 60;
                rolandMaxFeedInput.addEventListener('change', (e) => {
                    updateRolandSettings({ rolandMaxFeed: parseFloat(e.target.value) || 60 });
                });
            }

            if (rolandZModeSelect) {
                rolandZModeSelect.value = rolandSettings.rolandZMode || initialProfile?.zMode || '3d';
                rolandZModeSelect.addEventListener('change', (e) => {
                    updateRolandSettings({ rolandZMode: e.target.value });
                });
            }

            if (rolandSpindleModeSelect) {
                rolandSpindleModeSelect.value = rolandSettings.rolandSpindleMode || initialProfile?.spindleMode || 'direct';
                rolandSpindleModeSelect.addEventListener('change', (e) => {
                    updateRolandSettings({ rolandSpindleMode: e.target.value });
                });
            }

            // --- Laser-specific fields ---
            const laserProfileSelect = document.getElementById('laser-profile-select');
            const laserSpotSizeInput = document.getElementById('laser-spot-size');
            const laserExportFormatSelect = document.getElementById('laser-export-format');
            const laserExportDpiInput = document.getElementById('laser-export-dpi');

            const laserSettings = loadedSettings.laser;

            const updateFormatDependentVisibility = (format) => {
                const isPng = format === 'png';
                const dpiField = document.getElementById('laser-dpi-sidebar-field');
                const pngWarning = document.getElementById('laser-png-sidebar-warning');
                if (dpiField) dpiField.style.display = isPng ? '' : 'none';
                if (pngWarning) pngWarning.style.display = isPng ? '' : 'none';
            };

            const laserOverrideContainer = document.getElementById('laser-override-container');
            const laserLockDefaults = document.getElementById('laser-lock-defaults');
            const svgGroupingSelect = document.getElementById('laser-svg-grouping');
            const reverseCutCheck = document.getElementById('laser-reverse-cut');
            const heatCheck = document.getElementById('laser-heat-management');
            const colorPassCheck = document.getElementById('laser-color-per-pass');
            const colorGridContainer = document.getElementById('laser-color-grid-container');

            if (laserLockDefaults) {
                laserLockDefaults.checked = laserSettings.profileLocked !== false;
                if (laserOverrideContainer) laserOverrideContainer.classList.toggle('is-locked-guardrail', laserLockDefaults.checked);

                laserLockDefaults.addEventListener('change', (e) => {
                    const isLocked = e.target.checked;
                    this.ui.core.updateSettings('laser', { profileLocked: isLocked });
                    if (laserOverrideContainer) laserOverrideContainer.classList.toggle('is-locked-guardrail', isLocked);

                    if (isLocked && laserProfileSelect) {
                        applyLaserProfile(laserProfileSelect.value, true);
                        this.invalidateLaserOperations('Reverted to profile defaults. Regeneration recommended.');
                    }
                });
            }

            const applyLaserProfile = (profileId, forceLock = false) => {
                const profile = laserSettings.profiles?.[profileId];
                if (!profile) return;

                if (forceLock && laserLockDefaults) {
                    laserLockDefaults.checked = true;
                    if (laserOverrideContainer) laserOverrideContainer.classList.add('is-locked-guardrail');
                    this.ui.core.updateSettings('laser', { profileLocked: true });
                }

                const isLocked = laserLockDefaults ? laserLockDefaults.checked : true;

                if (isLocked) {
                    this.ui.core.updateSettings('laser', {
                        activeProfile: profileId,
                        svgGrouping: profile.svgGrouping,
                        reverseCutOrder: profile.reverseCutOrder,
                        heatManagement: profile.heatManagement,
                        colorPerPass: profile.colorPerPass,
                        layerColors: { ...profile.layerColors }
                    });
                } else {
                    this.ui.core.updateSettings('laser', { activeProfile: profileId });
                }

                const activeState = this.ui.core.settings.laser;

                if (svgGroupingSelect) svgGroupingSelect.value = activeState.svgGrouping;
                if (reverseCutCheck) reverseCutCheck.checked = activeState.reverseCutOrder;
                if (heatCheck) heatCheck.checked = activeState.heatManagement !== 'off';
                if (colorPassCheck) colorPassCheck.checked = activeState.colorPerPass;

                const summaryLabel = document.getElementById('laser-profile-summary-label');
                if (summaryLabel) summaryLabel.textContent = profile.label;

                if (colorGridContainer && activeState.layerColors) {
                    colorGridContainer.innerHTML = '';
                    Object.entries(activeState.layerColors).forEach(([layerName, colorHex]) => {
                        const wrapper = document.createElement('div');
                        wrapper.className = 'laser-color-field';

                        const colorInput = document.createElement('input');
                        colorInput.type = 'color';
                        colorInput.value = colorHex;
                        colorInput.id = `laser-color-${layerName}`;

                        const label = document.createElement('label');
                        label.htmlFor = colorInput.id;
                        label.textContent = layerName.charAt(0).toUpperCase() + layerName.slice(1);

                        colorInput.addEventListener('change', (e) => {
                            const newColor = e.target.value;
                            profile.layerColors[layerName] = newColor;
                            const currentColors = this.ui.core.settings.laser.layerColors;
                            this.ui.core.updateSettings('laser', {
                                layerColors: { ...currentColors, [layerName]: newColor }
                            });
                            this.invalidateLaserOperations('Color override applied. Regeneration recommended.');
                        });

                        wrapper.appendChild(colorInput);
                        wrapper.appendChild(label);
                        colorGridContainer.appendChild(wrapper);
                    });
                }
            };

            const wireOverride = (el, settingKey, isCheckbox = false) => {
                if (el) el.addEventListener('change', (e) => {
                    const val = isCheckbox ? e.target.checked : e.target.value;
                    const finalVal = settingKey === 'heatManagement' ? (val ? 'standard' : 'off') : val;
                    this.ui.core.updateSettings('laser', { [settingKey]: finalVal });
                    this.invalidateLaserOperations(`${settingKey} overridden. Regeneration recommended.`);
                });
            };

            wireOverride(svgGroupingSelect, 'svgGrouping');
            wireOverride(reverseCutCheck, 'reverseCutOrder', true);
            wireOverride(heatCheck, 'heatManagement', true);
            wireOverride(colorPassCheck, 'colorPerPass', true);

            if (laserProfileSelect) {
                laserProfileSelect.innerHTML = '';
                const profiles = laserSettings.profiles || {};
                Object.entries(profiles).forEach(([id, profile]) => {
                    const opt = document.createElement('option');
                    opt.value = id;
                    opt.textContent = profile.label;
                    laserProfileSelect.appendChild(opt);
                });

                let initialLaserProfile = laserSettings.activeProfile || 'generic';
                if (!laserSettings.profiles[initialLaserProfile]) {
                    initialLaserProfile = 'generic';
                }
                laserProfileSelect.value = initialLaserProfile;

                applyLaserProfile(laserProfileSelect.value);

                laserProfileSelect.addEventListener('change', (e) => {
                    applyLaserProfile(e.target.value, true);
                    const profile = laserSettings.profiles?.[e.target.value];
                    this.ui.setStatus(`Laser profile: ${profile?.label || e.target.value}`, 'info');
                    this.invalidateLaserOperations('Laser profile changed. Regeneration recommended.');
                });
            }

            if (laserSpotSizeInput) {
                laserSpotSizeInput.value = laserSettings.spotSize;
                laserSpotSizeInput.addEventListener('change', (e) => {
                    const newSpotSize = parseFloat(e.target.value);
                    this.ui.core.updateSettings('laser', { spotSize: newSpotSize });
                    this.invalidateLaserOperations('Laser spot size changed. Please regenerate laser paths.');

                    const opPanel = this.getOpPanel();
                    const opId = opPanel?.currentOperationId;
                    if (opId) {
                        opPanel.parameterManager.setParameter(opId, 'geometry', 'laserSpotSize', newSpotSize);
                        const propInput = document.getElementById(`${opPanel.getIdPrefix()}laserSpotSize`);
                        if (propInput) propInput.value = newSpotSize;
                    }
                });
            }

            if (laserExportFormatSelect) {
                laserExportFormatSelect.value = laserSettings.exportFormat;
                laserExportFormatSelect.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('laser', { exportFormat: e.target.value });
                    updateFormatDependentVisibility(e.target.value);
                });
                updateFormatDependentVisibility(laserExportFormatSelect.value);
            }

            if (laserExportDpiInput) {
                laserExportDpiInput.value = laserSettings.exportDPI || 1000;
                laserExportDpiInput.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('laser', { exportDPI: parseInt(e.target.value, 10) || 1000 });
                });
            }

            // --- Universal fields ---
            const thicknessInput = document.getElementById('pcb-thickness');
            if (thicknessInput) {
                thicknessInput.value = loadedSettings.machine.pcb?.thickness ?? '';
                thicknessInput.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', {
                        pcb: { ...loadedSettings.machine.pcb, thickness: parseFloat(e.target.value) }
                    });
                });
            }

            const safeZInput = document.getElementById('safe-z');
            if (safeZInput) {
                safeZInput.value = loadedSettings.machine.heights.safeZ;
                safeZInput.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', {
                        heights: { ...loadedSettings.machine.heights, safeZ: parseFloat(e.target.value) }
                    });
                });
            }

            const travelZInput = document.getElementById('travel-z');
            if (travelZInput) {
                travelZInput.value = loadedSettings.machine.heights.travelZ;
                travelZInput.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', {
                        heights: { ...loadedSettings.machine.heights, travelZ: parseFloat(e.target.value) }
                    });
                });
            }

            const rapidFeedInput = document.getElementById('rapid-feed');
            if (rapidFeedInput) {
                rapidFeedInput.value = loadedSettings.machine.speeds.rapidFeed;
                rapidFeedInput.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', {
                        speeds: { ...loadedSettings.machine.speeds, rapidFeed: parseFloat(e.target.value) }
                    });
                });
            }

            const coolantSelect = document.getElementById('coolant-type');
            if (coolantSelect) {
                coolantSelect.value = loadedSettings.machine.coolant || 'none';
                coolantSelect.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', { coolant: e.target.value });
                });
            }

            const vacuumToggle = document.getElementById('vacuum-toggle');
            if (vacuumToggle) {
                vacuumToggle.checked = loadedSettings.machine.vacuum || false;
                vacuumToggle.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('machine', { vacuum: e.target.checked });
                });
            }

            // Apply initial visibility
            this.updateProcessorFieldVisibility(loadedSettings.gcode.postProcessor);
            this.updatePipelineFieldVisibility();
            if (initialProfile) this.updateRolandProfileFields(initialProfile);
        }

        // ═══════════════════════════════════════════════════════════════
        // Processor / Pipeline / Roland Visibility
        // ═══════════════════════════════════════════════════════════════

        updateProcessorFieldVisibility(processorName) {
            const isRoland = processorName === 'roland';
            const machineControls = document.getElementById('machine-controls');
            if (!machineControls) return;

            machineControls.querySelectorAll('[data-processor-group="gcode"]').forEach(el => {
                el.style.display = isRoland ? 'none' : '';
            });
            machineControls.querySelectorAll('[data-processor-group="roland"]').forEach(el => {
                el.style.display = isRoland ? '' : 'none';
            });

            this.updateRotaryRouteField(processorName);
            this.updateToolLengthCompField(processorName);
            this.updateProcessorCustomParameters(processorName);
        }

        /**
         * Tool-length-offset picker. Populated from the selected post's
         * declared modes and hidden when there is only one - a post that can
         * only do 'none' presents no decision.
         *
         * This is a MACHINE fact, not a job property: whether Z offsets live
         * in the control's tool table, are implied from the T word, are
         * probed at change time, or don't exist at all depends on how the
         * operator's spindle and holders are set up. Same shape as the 4th-
         * axis route picker, for the same reason.
         */
        updateToolLengthCompField(processorName) {
            const field = document.getElementById('tlc-mode-field');
            const select = document.getElementById('tlc-mode');
            if (!field || !select) return;

            const generator = this.ui.ctrl?.gcodeGenerator;
            const tlc = generator?.getProcessorInfo(processorName)?.capabilities?.toolLengthComp;
            const modes = tlc?.modes || ['none'];

            if (modes.length <= 1) {
                field.style.display = 'none';
                // Clear before returning. resolveTLCMode ignores an undeclared mode, so
                // nothing is emitted wrong - but leaving it makes settings and UI
                // disagree, and the next post that DOES declare it inherits silently.
                const stale = this.ui.core.settings.gcode.toolLengthCompMode;
                stale && !modes.includes(stale) && this.ui.core.updateSettings('gcode', { toolLengthCompMode: '' });
                return;
            }
            field.style.display = '';

            const LABELS = {
                'none':           'None - re-zero Z after each tool change',
                'table':          'Controller tool table (G43 H<n>)',
                'table-implicit': 'Controller tool table, H from T (T<n> M06 G43)',
                'probe':          'Measured at change time (controller macro)'
            };

            select.innerHTML = '';
            modes.forEach(m => {
                const o = document.createElement('option');
                o.value = m;
                o.textContent = LABELS[m] || m;
                select.appendChild(o);
            });

            const saved = this.ui.core.settings.gcode.toolLengthCompMode || '';
            const declared = modes.includes(saved);
            select.value = declared ? saved : (tlc?.default || modes[0]);

            // Only a value THIS post cannot emit is overwritten - '' survives
            // as "never chosen", which resolveTLCMode reads as the post default.
            if (saved && !declared) {
                this.ui.core.updateSettings('gcode', { toolLengthCompMode: '' });
            }

            if (!select.dataset.bound) {
                select.dataset.bound = '1';
                select.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('gcode', { toolLengthCompMode: e.target.value });
                    this.ui.ctrl.modalManager?.clearExportPreview?.();
                });
            }
        }

        /**
         * 4th-axis route picker. Populated from the selected post's declared
         * routes; hidden entirely on 3-axis posts. '' = auto (the post's
         * first/preferred route), which is what most users want - the control
         * exists for machines that support more than one encoding.
         */
        updateRotaryRouteField(processorName) {
            const section = document.getElementById('rotary-section');
            const field = document.getElementById('rotary-route-field');
            const select = document.getElementById('rotary-route');
            const dwellField = document.getElementById('index-dwell-field');
            const dwellInput = document.getElementById('index-dwell');
            if (!section || !field || !select) return;

            // This function is the SOLE owner of the rotary section's
            // visibility. updateProcessorFieldVisibility runs its
            // gcode/roland group pass first and would otherwise re-show the
            // section on a Roland job that happens to declare a route.
            if (processorName === 'roland') {
                section.style.display = 'none';
                this.publishRotaryGates(null);
                return;
            }

            const generator = this.ui.ctrl?.gcodeGenerator;
            const caps = generator?.getProcessorInfo(processorName)?.capabilities?.rotary;
            const routes = caps?.routes || [];

            if (routes.length === 0) {
                section.style.display = 'none';
                this.publishRotaryGates(caps);
                return;
            }
            section.style.display = '';
            field.style.display = '';

            // Index settle dwell. Only meaningful when an A/B word can be
            // emitted (indexed 3+1); wrapped-linear-only posts never index.
            // Blank = use the post's declared default, which is a starting
            // guess about the rotary HARDWARE, not the controller.
            if (dwellField && dwellInput) {
                const canIndex = routes.includes('a-word') && (caps.axisWords || []).length > 0;
                dwellField.style.display = canIndex ? '' : 'none';
                if (canIndex) {
                    dwellInput.placeholder = `Auto (${caps.indexDwell ?? 0}s)`;
                    const savedDwell = this.ui.core.settings.gcode.indexDwell;
                    dwellInput.value = (savedDwell === '' || savedDwell == null) ? '' : savedDwell;
                    if (!dwellInput.dataset.bound) {
                        dwellInput.dataset.bound = '1';
                        dwellInput.addEventListener('change', (e) => {
                            const v = e.target.value.trim();
                            this.ui.core.updateSettings('gcode',
                                { indexDwell: v === '' ? '' : Math.max(0, parseFloat(v) || 0) });
                        });
                    }
                }
            }

            const LABELS = {
                'a-word':         'Rotary word (A/B in degrees)',
                'wrapped-linear': 'Axis replacement (Y carries arc length)',
                'a-linear':       'Rotary word (A/B in arc mm)'
                // 'cyl-interp':     'Controller cylindrical interpolation' - Planned, not implemented
            };

            select.innerHTML = '';
            routes.forEach(r => {
                const o = document.createElement('option');
                o.value = r;
                o.textContent = LABELS[r] || r;
                select.appendChild(o);
            });

            const saved = this.ui.core.settings.gcode.rotaryRoute || '';
            const declared = routes.includes(saved);
            select.value = declared ? saved : routes[0];

            // One route = no decision to make so lock it
            select.disabled = routes.length === 1;

            // REVIEW - I don't like this data flow design, there has to be a better strategy than an empty ''.
            // '' means "never chosen" and must survive: buildToolpathContext
            // reads it as auto, and auto is what promotes indexed 3+1 to
            // 'a-word' on a post that lists wrapped-linear first. Only a value
            // this post cannot emit is overwritten.
            if (saved && !declared) {
                this.ui.core.updateSettings('gcode', { rotaryRoute: routes[0] });
            }

            this.publishRotaryGates(caps);

            if (!select.dataset.bound) {
                select.dataset.bound = '1';
                select.addEventListener('change', (e) => {
                    this.ui.core.updateSettings('gcode', { rotaryRoute: e.target.value });
                    this.publishRotaryGates(caps);
                    this.ui.ctrl.modalManager?.clearExportPreview?.();
                });
            }
        }

        /**
         * Publishes the 4th-axis capability gate to the parameter layer.
         *
         * Indexed 3+1 positions a real A/B word in absolute degrees. Axis
         * replacement repurposes the Y word as arc length, and indexed Y is
         * real cross-axis position - the two cannot coexist on one machine.
         *
         * Keyed on the user's PINNED route, not the resolved one: '' is auto,
         * and buildToolpathContext already promotes auto to 'a-word' for an
         * indexed op. Gating on the resolved route would disable indexed on
         * every post that lists wrapped-linear first (grblHAL, Makera, and
         * Fanuc list it for continuous-rotary feed safety, not because they
         * lack an A word).
         */
        publishRotaryGates(caps) {
            const paramMgr = this.getParamManager();
            if (!paramMgr) return;

            const routes = caps?.routes || [];
            const axisWords = caps?.axisWords || [];
            const post = this.ui.core.settings.gcode.postProcessor;
            const pinned = this.ui.core.settings.gcode.rotaryRoute || '';

            const declaresAWord = routes.includes('a-word') && axisWords.length > 0;
            const pinnedElsewhere = pinned !== '' && pinned !== 'a-word';

            paramMgr.setOptionGates({
                'rotary.indexed': {
                    ok: declaresAWord && !pinnedElsewhere,
                    reason: !declaresAWord
                        ? `'${post}' declares no A/B rotary word - it can only drive a 4th axis by axis replacement.`
                        : 'Machine rotary route is set to axis replacement, which carries arc length on the Y word.'
                }
            });

            this.getOpPanel()?.refresh?.();
        }

        /**
         * Renders a post's declared customParameters into the machine section.
         * Fanuc (O-number, work offset, rotary unwind) and Makera (tool-change
         * mode) both declare these and neither had a renderer, so every value
         * sat at its `||` fallback. Values live under settings.gcode.processorParams
         * keyed by parameter id and are spread flat into the export options.
         */
        updateProcessorCustomParameters(processorName) {
            const host = document.getElementById('processor-custom-params');
            if (!host) return;
            host.innerHTML = '';

            const generator = this.ui.ctrl?.gcodeGenerator;
            const params = generator?.getProcessorInfo(processorName)?.customParameters || [];
            if (params.length === 0) { host.style.display = 'none'; return; }
            host.style.display = '';

            // FLAT on settings.gcode, not a nested bag: generateCNCResults
            // spreads them straight into genOptions and the posts read them
            // off `options` (options.fanucWorkOffset, options.makeraToolChangeMode).
            // A nested store would need unwrapping in two more places.
            const store = this.ui.core.settings.gcode;
            const commit = (key, value) => {
                this.ui.core.updateSettings('gcode', { [key]: value });
            };

            for (const p of params) {
                const wrap = document.createElement('div');
                wrap.className = 'property-field';

                const label = document.createElement('label');
                label.setAttribute('for', `pp-${p.key}`);
                label.textContent = p.label || p.key;
                wrap.appendChild(label);

                const current = store[p.key] ?? p.default;
                let input;
                if (p.type === 'select') {
                    input = document.createElement('select');
                    for (const o of (p.options || [])) {
                        const opt = document.createElement('option');
                        opt.value = o.value;
                        opt.textContent = o.label;
                        input.appendChild(opt);
                    }
                    input.value = current;
                    input.addEventListener('change', (e) => commit(p.key, e.target.value));
                } else {
                    input = document.createElement('input');
                    input.type = (p.type === 'number') ? 'number' : 'text';
                    if (p.type === 'number') {
                        if (p.min != null)  input.min = p.min;
                        if (p.max != null)  input.max = p.max;
                        if (p.step != null) input.step = p.step;
                    }
                    input.value = current ?? '';
                    input.addEventListener('change', (e) => commit(p.key,
                        p.type === 'number' ? (parseFloat(e.target.value) || p.default)
                                            : e.target.value));
                }
                input.id = `pp-${p.key}`;
                wrap.appendChild(input);
                host.appendChild(wrap);
            }
        }

        updatePipelineFieldVisibility() {
            const ctrl = this.ui.ctrl;
            if (!ctrl) return;

            const pipelineType = ctrl.pipelineState?.type || 'cnc';
            const machineSection = document.querySelector('.sidebar-section.machine-section');
            if (!machineSection) return;
            machineSection.style.display = '';

            const machineControls = document.getElementById('machine-controls');
            if (!machineControls) return;

            const isCNC = pipelineType === 'cnc' || pipelineType === 'hybrid';
            const isLaser = ctrl.isLaserPipeline?.() || false;

            machineControls.querySelectorAll('[data-pipeline-group="cnc"]').forEach(el => {
                el.style.display = isCNC ? '' : 'none';
            });
            machineControls.querySelectorAll('[data-pipeline-group="laser"]').forEach(el => {
                el.style.display = isLaser ? '' : 'none';
            });
        }

        updateRolandProfileFields(profile) {
            const rolandStepsInput = document.getElementById('roland-steps-per-mm');
            const rolandMaxFeedInput = document.getElementById('roland-max-feed');
            const rolandSpindleModeSelect = document.getElementById('roland-spindle-mode');
            const rolandSpindleInput = document.getElementById('roland-spindle-speed');
            const rpmField = document.getElementById('roland-spindle-rpm-field');

            const isCustom = !profile || profile.label === 'Custom Machine';

            if (rolandStepsInput) rolandStepsInput.readOnly = !isCustom;

            if (rolandMaxFeedInput) {
                const lockFeed = !isCustom && (profile.maxFeedXY <= 15);
                rolandMaxFeedInput.readOnly = lockFeed;
            }

            if (rolandSpindleModeSelect) {
                const hasSpindleControl = profile.supportsRC !== false;
                const spindleSection = rolandSpindleModeSelect.closest('.property-field');
                if (spindleSection) spindleSection.style.display = hasSpindleControl ? '' : 'none';
            }

            if (rpmField && !profile.supportsRC) {
                rpmField.style.display = 'none';
            }

            if (rolandSpindleInput && profile.spindleRange) {
                rolandSpindleInput.min = profile.spindleRange.min;
                rolandSpindleInput.max = profile.spindleRange.max;
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // Laser Invalidation
        // ═══════════════════════════════════════════════════════════════

        invalidateLaserOperations(reasonMessage, affectedTypes = null) {
            let invalidated = false;

            this.ui.core.operations.forEach(op => {
                if (!this.ui.ctrl?.isLaserExportForOperation?.(op.type)) return;
                if (!this.ui.core.isExportReady(op)) return;
                if (affectedTypes && !affectedTypes.includes(op.type)) return;

                op.exportReady = false;
                if (op.preview) op.preview.ready = false;
                op.isInvalidated = true;
                op.invalidatedReason = reasonMessage;
                invalidated = true;

                const treePanel = this.ui.navTreePanel;
                if (treePanel) {
                    const fileNode = treePanel.getNodeByOperationId(op.id);
                    if (fileNode) treePanel.updateFileGeometries(fileNode.id, op);
                }
            });

            if (invalidated && reasonMessage) {
                this.ui.setStatus('Existing geometry invalidated. Please review operations.', 'warning');
            }
        }

        debug(message, data = null) {
            if (D.debug.enabled) {
                data !== null
                    ? console.log(`[MachineSettings] ${message}`, data)
                    : console.log(`[MachineSettings] ${message}`);
            }
        }
    }

    window.MachineSettingsUI = MachineSettingsUI;
})();