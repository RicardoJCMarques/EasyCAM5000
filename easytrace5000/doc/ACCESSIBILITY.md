# EasyTrace5000 Accessibility Guide

Keyboard navigation, screen reader support, and WCAG compliance

EasyTrace5000 is designed to be usable with keyboard-only navigation and compatible with assistive technologies. This document details keyboard controls, focus management, and WCAG 2.1 compliance efforts.

## Table of Contents

- [Keyboard Navigation Overview](#keyboard-navigation-overview)
- [Zone-Specific Controls](#zone-specific-controls)
- [Modals & Dialogs](#modals--dialogs)
- [Screen Reader Support](#screen-reader-support)
- [WCAG 2.1 Compliance](#wcag-21-compliance)
- [Known Limitations](#known-limitations)
- [Reporting Issues](#reporting-issues)

---

## Keyboard Navigation Overview

The interface is designed for full keyboard operability using a **Focus Zone** strategy. This reduces repetitive tabbing by allowing users to jump between major workspace areas.

### Global Navigation

These shortcuts work globally to navigate the application structure.

| Key | Action |
| :--- | :--- |
| `F6` | Cycle focus forward through zones: **Toolbar** → **Operations Tree** → **Canvas** → **Properties Panel** |
| `Shift` + `F6` | Cycle focus backward through zones |
| `Tab` | Move focus to the next interactive element within the current zone |
| `Shift` + `Tab` | Move focus to the previous interactive element |
| `F1` | Open the Help & Shortcuts modal |
| `F2` | Toggle between the 2D canvas and the 3D toolpath view |
| `1` - `5` | Cycle selection through a category's files and artifacts (`1`: Isolation → `5`: Stencil), announcing the category |
| `Delete` / `Backspace` | Delete the current selection (outside the tree) |
| `I` | Open the Add Files dialog |
| `Ctrl` + `Alt` + `D` | Toggle verbose debug logging |

> **Note:** A **Skip Link** is available on the first `Tab` press after page load to jump directly to the Canvas. Each `F6` press announces the zone it landed in through the status region.

---

## Zone-Specific Controls

Each zone has specific interactions once it receives focus.

### Toolbar & Sidebar Headers

| Key | Action |
| :--- | :--- |
| `Tab` / `Shift` + `Tab` | Navigate between buttons and menu items |
| `←` / `→` | Navigate horizontally between toolbar buttons |
| `Enter` / `Space` | Activate the focused button or toggle a dropdown |
| `Escape` | Close an open dropdown menu |

### Operations Tree (Left Sidebar)

The tree uses a **roving tabindex** pattern. Press `Tab` to enter the tree list, then use arrow keys to navigate.

Each operation category holds a source file, and each generated artifact - Offsets, Preview, Toolpaths - appears as its own child node with its own visibility toggle.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` | Move focus to the previous or next visible item |
| `→` | Expand a category/file, or move focus to the first child |
| `←` | Collapse a category/file, or move focus to the parent |
| `Home` / `End` | Jump to the first or last item in the tree |
| `Enter` / `Space` | Select the item (opens properties) or toggle category expansion |
| `Delete` / `Backspace` | Remove the focused file or artifact node |
| `V` | Toggle visibility of the selected layer |

### Canvas Controls

These controls are active when the **Canvas** zone has focus.

**View Manipulation**

| Key | Action |
| :--- | :--- |
| `↑` / `↓` / `←` / `→` | Pan the view |
| `Shift` + `Arrow` | Pan faster |
| `+` / `-` | Zoom in / Zoom out |
| `Home` / `F` / `=` | Fit all geometry to view |
| `F2` | Switch between the 2D canvas and the 3D toolpath view |

**Display & Tools**

| Key | Action |
| :--- | :--- |
| `W` | Toggle Wireframe mode |
| `G` | Toggle Grid visibility |
| `B` | Set Origin to Bottom-Left (Preview) |
| `C` | Set Origin to Center (Preview) |
| `O` | Save/Confirm current origin position |

**3D View**

These apply once the 3D viewport has focus. Press `F2` to enter 3D, then `F6` until focus reaches the viewport.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` / `←` / `→` | Orbit the camera |
| `Shift` + `Arrow` | Pan the camera target |
| `+` / `-` | Zoom in / Zoom out |
| `Page Up` / `Page Down` | Zoom in / Zoom out |
| `Home` / `F` | Fit the model to the view |
| `F2` | Return to the 2D canvas |

### Property Panel (Right Sidebar)

This panel handles parameter inputs for the selected stage node. The fields it shows change with the stage, so the same keys apply throughout.

| Key | Action |
| :--- | :--- |
| `Tab` | Move to next field, button, or help icon |
| `Shift` + `Tab` | Move to previous field |
| `↓` / `↑` | Navigate focus between property rows (Grid Navigation) |
| `Enter` | Enter "Edit Mode" on a focused row |
| `Enter` *(while editing)* | Commit change and move to next field |
| `Escape` | Cancel edit/tooltip and return focus to the row |

---

## Modals & Dialogs

When a modal is open, focus is trapped within it until it closes, and global navigation keys (`F6`) are disabled. Closing a modal returns focus to the element that opened it. Where a modal's body scrolls, focus lands on the scrollable body so the arrow keys and `Page Up` / `Page Down` work immediately.

### General Navigation

| Key | Action |
| :--- | :--- |
| `Tab` | Cycle forward through inputs and buttons |
| `Shift` + `Tab` | Cycle backward through inputs and buttons |
| `Escape` | Close the modal or cancel the current action |
| `↑` / `↓` | Scroll the body of a long modal |

### Confirmations

EasyTrace5000 has no undo. Deleting an operation or a generated artifact therefore asks first. The confirmation is an alert dialog, its buttons are reachable by `Tab`, `Escape` cancels, and focus returns to the tree node you were on either way.

### Sortable Lists (Export Manager)

The Export Manager's operation list is drag-and-drop, with a full keyboard equivalent:

| Key | Action |
| :--- | :--- |
| `Space` | **Grab** the focused item for reordering |
| `↑` / `↓` | Move the grabbed item up or down the list |
| `Space` | **Drop** the item in its new position |
| `Escape` | Cancel the grab action and reset position |

### Drill Tooling Table

The per-diameter drill table is a modal grid. `Tab` moves between cells and `Escape` closes the modal. Every input and dropdown carries an accessible name that names both its hole diameter and its column, so a cell is never announced as a bare number.

---

## Screen Reader Support

### Live Regions

- **Status region**: a polite region carries ordinary progress and completion messages; a separate assertive region carries errors, so urgency is not lost.
- The visible status text is not itself a live region. Its idle state, which restores a few seconds after every message, is therefore silent rather than being re-announced.
- Status messages announce file loading, generation progress, stage completion, and errors
- Long-running generation reports progress through the same region, so a background job is audible rather than silent
- The status log holds the full history and is reachable from the keyboard: `Tab` to the chevron at the left of the status bar and press `Enter`.

### Semantic Structure

- Main landmarks: `<header>` (toolbar), `<main>` (canvas), `<aside>` (sidebars), `<footer>` (status bar)
- Headings hierarchy maintained within sections
- Form labels associated with inputs via `for`/`id`

### Button Labels

All icon-only buttons include `aria-label` attributes describing their function:
- "Fit to View", "Zoom In", "Zoom Out"
- "Toggle Visibility", "Delete", etc.

### SVG Icons

Decorative icons are marked `aria-hidden="true"` as they enter the page, including icons injected into tree nodes and stage nodes after load. Icons that carry meaning on their own are given an accessible name instead.

---

## WCAG 2.1 Compliance

EasyTrace5000 targets **WCAG 2.1 Level AA** compliance. While the application is fully functional for keyboard users, some visual aspects (such as complex canvas geometry) have inherent limitations.

### Implemented Guidelines

| Guideline | Description | Status | Implementation Notes |
|-----------|-------------|--------|----------------------|
| **1.1.1** | Non-text Content | ✓ | Icon-only buttons include `aria-label` attributes; decorative icons use `aria-hidden="true"`. Documentation figures carry a `<title>` and a caption. |
| **1.3.1** | Info and Relationships | ✓ | Semantic HTML5 landmarks (`<main>`, `<aside>`, `<nav>`) and proper ARIA tree roles for the Operations panel. |
| **1.3.2** | Meaningful Sequence | ✓ | DOM order matches the visual layout; focus order flows logically through sidebars and canvas. |
| **1.4.1** | Use of Color | ✓ | Status messages (Success/Error) use both text labels and color indicators. |
| **1.4.13**| Content on Hover/Focus| ✓ | Custom `TooltipManager` ensures tooltips are persistent on focus, hoverable, and do not obscure active content. |
| **2.1.1** | Keyboard | ✓ | All interactive elements (buttons, inputs, tree nodes, canvas) are keyboard accessible. |
| **2.1.2** | No Keyboard Trap | ✓ | Modal dialogs trap focus intentionally while open but release it correctly upon closing. |
| **2.1.4** | Character Key Shortcuts| ✓ | Single-key shortcuts are scoped to the region that owns them and are disabled entirely inside forms and text entry. |
| **2.4.1** | Bypass Blocks | ✓ | A "Skip to Canvas" link appears on the first Tab press. |
| **2.4.3** | Focus Order | ✓ | Modals and panels manage focus logically; closing a modal returns focus to the triggering element. |
| **2.4.6** | Headings and Labels | ✓ | Descriptive headings identify all major workspace sections; inputs have associated `<label>` elements. |
| **2.4.7** | Focus Visible | ✓ | High-contrast CSS focus rings (`:focus-visible`) appear on all interactive elements. |
| **2.5.3** | Label in Name | ✓ | Accessible names match visible text. Navigation links rely on their visible text; `aria-label` is used only for icon-only controls, where it matches the visual tooltip. |
| **3.2.1** | On Focus | ✓ | Focusing on input fields or tree items never triggers a context change (submit/navigation). |
| **3.2.2** | On Input | ✓ | Parameter changes update the preview or require explicit confirmation; no unexpected page reloads. |
| **4.1.2** | Name, Role, Value | ✓ | Custom controls (Tree View, Toggles) use correct ARIA roles (`tree`, `treeitem`, `button`). |
| **4.1.3** | Status Messages | ✓ | Dynamic updates (file loading, generation progress, success messages) are announced via `aria-live` regions. |

### Partial or Planned Support

| Guideline | Description | Status | Notes |
|-----------|-------------|--------|-------|
| **1.4.3** | Contrast (Minimum) | Partial | Most default text meets 4.5:1, but some secondary and hint text in both themes does not. Dedicated high-contrast themes are in development. |
| **1.4.10**| Reflow | Partial | The workspace is laid out for a landscape viewport and does not reflow to a single column; below roughly 768 CSS pixels a warning bar appears instead. Because browser zoom narrows the viewport as it magnifies, this is reached at high zoom on a wide display. Collapsible side panels are planned. In the meantime, text-only zoom or operating-system display scaling magnifies without narrowing the viewport. |
| **1.4.11**| Non-text Contrast | Partial | Some UI borders and disabled states in the default theme may fall below 3:1. High Contrast themes are supported by the engine and are currently in development. |
| **1.1.1** | Non-text Content (3D view) | Partial | The 3D toolpath view is a WebGPU canvas with no non-visual equivalent. Toolpath statistics - pass count, estimated time, travel distance - appear as text on the Toolpaths node in the operations tree and in the Export Manager. Nothing in the workflow requires the 3D view. |
| **1.2.x** | Time-based Media | N/A | The application does not contain audio or video content. |

---

## Known Limitations

1. **Canvas interaction**: The 2D canvas preview is visual-only. Geometry data is available via the operations tree, but spatial relationships require visual inspection.

2. **3D view**: The 3D toolpath view is visual-only, though the camera is fully keyboard-operable. Nothing in the workflow requires it: an operation can be generated, exported and cut without ever opening it.

3. **Complex geometry feedback**: When generating offsets or toolpaths, detailed geometric results are shown visually but not fully announced to screen readers beyond progress and success/failure status.

4. **Drag-and-drop file upload**: Requires a pointer. Alternative: click the drop zones, or use the file input buttons in the operations tree.

5. **Touch devices**: Touch zoom/pan works but keyboard navigation is the primary accessibility path.

6. **Color-coded warnings**: Drill operation warnings use color coding (green/yellow/red). Status messages provide text descriptions of the same information.

7. **Narrow viewports and high zoom**: See guideline 1.4.10 above. Rotating a tablet to landscape, or widening the window, restores the full workspace.

8. **Audio**: EasyTrace5000 produces no sound. Every state change is reported as text, so no information is conveyed by audio alone.

9. **EasyShape5000**: This guide covers EasyTrace5000 only.

---

## Reporting Issues

If you encounter accessibility barriers, please report them via **GitHub Issues**.

There's a dedicated template available for these reports to ensure the necessary technical details are included.

1. Go to the [New Issue page](https://github.com/RicardoJCMarques/EasyCAM5000/issues/new/choose)
2. Select the **Accessibility Report** template
3. Fill in the required details (Browser, OS, Assistive Technology)

---

## Resources

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
- [WebAIM Keyboard Testing](https://webaim.org/techniques/keyboard/)