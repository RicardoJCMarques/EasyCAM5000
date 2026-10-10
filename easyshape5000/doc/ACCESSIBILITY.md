# EasyShape5000 Accessibility Guide

Keyboard navigation, screen reader support, and WCAG compliance

EasyShape5000 is designed to be usable with keyboard-only navigation and compatible with assistive technologies. This document details keyboard controls, focus management, and WCAG 2.1 compliance efforts.

## Table of Contents

- [Keyboard Navigation Overview](#keyboard-navigation-overview)
- [Zone-Specific Controls](#zone-specific-controls)
- [The 3D Viewport](#the-3d-viewport)
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
| `F6` | Cycle focus forward through zones: **Toolbar** → **Scene & Operations** → **Canvas** → **Settings** |
| `Shift` + `F6` | Cycle focus backward through zones |
| `Tab` | Move focus to the next interactive element within the current zone |
| `Shift` + `Tab` | Move focus to the previous interactive element |
| `F1` | Open the Help & Shortcuts modal |
| `F2` | Toggle between the 2D canvas and the 3D view |
| `Ctrl` + `Alt` + `D` | Toggle verbose debug logging |

> **Note:** A **Skip Link** is available on the first `Tab` press after page load to jump directly to the Canvas. Each `F6` press announces the zone it landed in through the status region, which matters here because the left sidebar holds two independent panels.

### Editing and Selection

These apply wherever focus is, except inside a text field.

| Key | Action |
| :--- | :--- |
| `Ctrl` + `Z` | Undo |
| `Ctrl` + `Shift` + `Z` / `Ctrl` + `Y` | Redo |
| `Ctrl` + `A` | Select every top-level object in the scene |
| `Ctrl` + `G` | Group the selection |
| `Ctrl` + `Shift` + `G` | Ungroup the selection |
| `Delete` / `Backspace` | Delete the selected shapes |
| `I` | Open the Add Files dialog |

Single-key shortcuts are scoped. Inside the scene tree or the operations panel, `Delete` removes the focused node rather than the canvas selection. Inside a property row in the right sidebar, no single-key shortcut fires at all, so a stray keystroke while arrowing a form cannot destroy work.

---

## Zone-Specific Controls

Each zone has specific interactions once it receives focus.

### Toolbar

| Key | Action |
| :--- | :--- |
| `Tab` / `Shift` + `Tab` | Navigate between buttons and menu items |
| `Enter` / `Space` | Activate the focused button or open a dropdown |
| `↑` / `↓` | Move between items in an open dropdown |
| `Escape` | Close an open dropdown and return focus to its button |

### Scene Tree (Left Sidebar, upper panel)

The scene tree is an ARIA tree with a **roving tabindex**. Press `Tab` to enter it, then use arrow keys. Groups nest to any depth; the tree reports each item's level and position in its branch.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` | Move focus to the previous or next visible item |
| `→` | Expand a collapsed group |
| `←` | Collapse an expanded group, or move focus to the parent |
| `Home` / `End` | Jump to the first or last item in the tree |
| `Enter` / `Space` | Select the focused item |
| `Shift` / `Ctrl` + `Enter` | Extend or toggle the selection |
| `Delete` / `Backspace` | Remove the focused item |
| `V` | Toggle visibility of the focused item |
| `L` | Toggle lock on the focused item |

Row buttons are reachable by their shortcut key rather than by `Tab`, so a hundred-shape file does not add three hundred tab stops to the sidebar.

### Operations Panel (Left Sidebar, lower panel)

Each operation is a bucket. Its header is a tree item, and every artifact it has produced - Offsets, Preview, Toolpaths - is a child tree item with its own visibility toggle.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` | Move focus through bucket headers and stage nodes |
| `→` | Move focus from a bucket header to its first stage node |
| `←` | Move focus from a stage node back to its bucket header |
| `Home` / `End` | Jump to the first or last item in the panel |
| `Enter` / `Space` | Select the focused bucket or stage and open its properties |
| `Delete` / `Backspace` | Delete the focused bucket, or clear the focused stage |
| `V` | Toggle visibility of the focused bucket or stage |

An invalidated stage is marked visually with a strikethrough and announced as invalidated, so the state does not depend on colour alone.

### Canvas Controls

These controls are active when the **Canvas** zone has focus.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` / `←` / `→` | Pan the view |
| `Shift` + `Arrow` | Pan faster |
| `+` / `-` | Zoom in / Zoom out |
| `Home` / `F` / `=` | Fit all geometry to view |
| `G` | Toggle Grid visibility |
| `F2` | Switch between the 2D canvas and the 3D view |

### Property Panel (Right Sidebar)

This panel handles parameter inputs for the selected stage node. The fields it shows change with the stage, so the same keys apply throughout.

| Key | Action |
| :--- | :--- |
| `Tab` | Move to next field or button |
| `Shift` + `Tab` | Move to previous field |
| `↓` / `↑` | Navigate focus between property rows (Grid Navigation) |
| `Enter` | Enter "Edit Mode" on a focused row |
| `↓` / `↑` *(in a number field)* | Step the value, as a number input normally would |
| `Escape` | Cancel the edit and return focus to the row |

Help text is attached to each field as its description rather than to a separate button, so a screen reader reads it when the field takes focus. The `?` icon beside a label is decorative and is not a tab stop.

---

## The 3D Viewport

Unlike EasyTrace5000, where 3D is an optional preview, three EasyShape operations are three-dimensional by definition: **V-Carve**, **Relief** and **Rotary**. Generating one switches the workspace to the 3D view automatically, because there is no 2D contour that represents its output.

The camera is fully keyboard-operable once the viewport has focus. Press `F2` to enter 3D, then `F6` until focus reaches the viewport.

| Key | Action |
| :--- | :--- |
| `↑` / `↓` / `←` / `→` | Orbit the camera |
| `Shift` + arrow keys | Pan the camera target |
| `+` / `-` | Zoom in / Zoom out |
| `Page Up` / `Page Down` | Zoom in / Zoom out |
| `Home` / `F` | Fit the model to the view |
| `F2` | Return to the 2D canvas |

The viewport is exposed as a labelled region so its purpose and its key bindings are announced on entry. What it does not yet have is a text equivalent of what it draws - see [Known Limitations](#known-limitations).

---

## Modals & Dialogs

When a modal is open, focus is trapped within it until it closes, and global navigation keys (`F6`) are disabled. Closing a modal returns focus to the element that opened it. Where a modal's body scrolls, focus lands on the scrollable body so the arrow keys and `Page Up` / `Page Down` work immediately.

### General Navigation

| Key | Action |
| :--- | :--- |
| `Tab` | Cycle forward through inputs and buttons |
| `Shift` + `Tab` | Cycle backward through inputs and buttons |
| `↑` / `↓` | Scroll the body of a long modal |
| `Escape` | Close the modal or cancel the current action |

### Confirmations

Deleting a shape is undoable with `Ctrl` + `Z` and happens immediately. Deleting an **operation** is not undoable, so it asks first. The confirmation is an alert dialog, its buttons are reachable by `Tab`, `Escape` cancels, and focus returns to the node you were on either way.

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
- Long-running generation reports progress through the same region, so a background job is audible rather than silent.
- The status log holds the full history and is reachable from the keyboard: `Tab` to the chevron at the left of the status bar and press `Enter`.

### Semantic Structure

- Main landmarks: `<header>` (toolbar), `<main>` (canvas), `<aside>` (sidebars), `<footer>` (status bar)
- Both left-hand panels are ARIA trees, each with its own label, and the tree role is dropped while a panel is empty so it never claims children it does not have
- Headings hierarchy maintained within sections
- Form labels associated with inputs via `for`/`id`, and help text via `aria-describedby`

### Button Labels

All icon-only buttons include `aria-label` attributes describing their function:
- "Fit to View", "Zoom In", "Zoom Out"
- "Toggle Visibility", "Delete", etc.

### SVG Icons

Decorative icons are marked `aria-hidden="true"` as they enter the page, including icons injected into tree rows and stage nodes after load. Icons that carry meaning on their own are given an accessible name instead.

---

## WCAG 2.1 Compliance

EasyShape5000 targets **WCAG 2.1 Level AA** compliance. While the application is fully functional for keyboard users, some visual aspects (such as the 3D viewport) have inherent limitations.

### Implemented Guidelines

| Guideline | Description | Status | Implementation Notes |
|-----------|-------------|--------|----------------------|
| **1.1.1** | Non-text Content | ✓ | Icon-only buttons include `aria-label` attributes; decorative icons use `aria-hidden="true"`. |
| **1.3.1** | Info and Relationships | ✓ | Semantic HTML5 landmarks and ARIA tree roles for both left-hand panels, including group nesting, level, and position in set. |
| **1.3.2** | Meaningful Sequence | ✓ | DOM order matches the visual layout; focus order flows logically through sidebars and canvas. |
| **1.4.1** | Use of Color | ✓ | Invalidated stages carry a strikethrough and hidden text alongside the colour change; status messages use text labels as well as colour. |
| **1.4.13**| Content on Hover/Focus| ✓ | Tooltips are persistent on focus, hoverable, dismissible with `Escape`, and do not obscure active content. |
| **2.1.1** | Keyboard | ✓ | All interactive elements - buttons, inputs, both trees, the 2D canvas and the 3D camera - are keyboard accessible. |
| **2.1.2** | No Keyboard Trap | ✓ | Modal dialogs trap focus intentionally while open but release it correctly upon closing. |
| **2.1.4** | Character Key Shortcuts| ✓ | Single-key shortcuts are scoped to the region that owns them and are disabled entirely inside forms and text entry. |
| **2.2.2** | Pause, Stop, Hide | ✓ | No content moves or auto-updates indefinitely; motion is suppressed under `prefers-reduced-motion`. |
| **2.4.1** | Bypass Blocks | ✓ | A "Skip to Canvas" link appears on the first Tab press. |
| **2.4.3** | Focus Order | ✓ | Panels keep a roving tabindex that follows selection and survives a tree rebuild; closing a modal returns focus to the triggering element. |
| **2.4.6** | Headings and Labels | ✓ | Descriptive headings identify all major workspace sections; inputs have associated `<label>` elements. |
| **2.4.7** | Focus Visible | ✓ | High-contrast CSS focus rings (`:focus-visible`) appear on all interactive elements. |
| **2.5.3** | Label in Name | ✓ | Accessible names match visible text; `aria-label` is used only for icon-only controls, where it matches the visual tooltip. |
| **2.5.8** | Target Size (Minimum) | ✓ | Icon buttons are at least 28 by 28 CSS pixels. |
| **3.2.1** | On Focus | ✓ | Focusing an input or a tree item never triggers a context change. |
| **3.2.2** | On Input | ✓ | Parameter changes update the preview or require explicit confirmation; no unexpected page reloads. |
| **3.3.1** | Error Identification | ✓ | Invalid parameters are marked `aria-invalid` and described in the status region. |
| **3.3.4** | Error Prevention | ✓ | Shape edits are undoable; deleting an operation, which is not, requires confirmation. |
| **4.1.2** | Name, Role, Value | ✓ | Custom controls use correct ARIA roles, and expanded, selected and level state is kept in sync with the DOM. |
| **4.1.3** | Status Messages | ✓ | Dynamic updates are announced through polite and assertive live regions. |

### Partial or Planned Support

| Guideline | Description | Status | Notes |
|-----------|-------------|--------|-------|
| **1.1.1** | Non-text Content (3D view) | Partial | The 3D view is a WebGPU canvas with no non-visual equivalent. A text readout of toolpath metrics on each stage node - depth range, bounding box, pass count, travel distance, estimated time - is planned and matters more here than in EasyTrace5000, because three operation types render only in 3D. |
| **1.4.3** | Contrast (Minimum) | Partial | Most default text meets 4.5:1, but some secondary and hint text in both themes does not. Dedicated high-contrast themes are in development. |
| **1.4.10**| Reflow | Partial | The workspace is laid out for a landscape viewport and does not reflow to a single column; below roughly 768 CSS pixels a warning bar appears instead. Because browser zoom narrows the viewport as it magnifies, this is reached at high zoom on a wide display. Collapsible side panels are planned. In the meantime, text-only zoom or operating-system display scaling magnifies without narrowing the viewport. |
| **1.4.11**| Non-text Contrast | Partial | Some UI borders and disabled states in the default themes may fall below 3:1. |
| **1.2.x** | Time-based Media | N/A | The application does not contain audio or video content. |

---

## Known Limitations

1. **3D view**: V-Carve, Relief and Rotary render only in 3D. The camera is keyboard-operable, but the geometry it draws has no text equivalent yet, so a non-visual user can generate and export these operations without being able to inspect them. This is the largest open gap and is tracked as planned work.

2. **Canvas interaction**: The 2D canvas preview is visual-only. Object data is available through the scene tree and the property panel, but spatial relationships require visual inspection.

3. **Narrow viewports and high zoom**: See guideline 1.4.10 above. Rotating a tablet to landscape, or widening the window, restores the full workspace.

4. **Per-operation announcements**: Generation messages name the stage but not yet which operation produced them, which is ambiguous when several are queued.

5. **Drag-and-drop file upload**: Requires a pointer. Alternative: activate the drop zones with `Enter`, or use the import button and the `I` shortcut.

6. **Moving shapes on the canvas**: Dragging is pointer-driven. The X, Y and rotation fields in the property panel are the keyboard equivalent.

7. **Touch devices**: Touch zoom, pan and orbit work, but keyboard navigation is the primary accessibility path.

8. **Audio**: EasyShape5000 produces no sound. Every state change is reported as text, so no information is conveyed by audio alone.

9. **EasyTrace5000**: This guide covers EasyShape5000 only.

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
