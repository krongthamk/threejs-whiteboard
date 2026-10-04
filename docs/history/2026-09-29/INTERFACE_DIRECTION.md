> Historical snapshot from the 2026-09-29 build; not maintained. Later evidence-retention and link corrections are preserved. See the [current implementation status](../../IMPLEMENTATION_STATUS.md) for ongoing work.

# Editor interface direction

The subject is a shared working surface for a self-hosted team. Its primary job
is to let people put an idea on the board and keep working together. The canvas
is the main view. Tools, styles, presence, and exports should be reachable
without a dashboard or a separate creation wizard.

This is design preparation while Phase 0 gates run, not a claim that the editor
has been implemented.

## Tokens

| Role | Value | Use |
| --- | --- | --- |
| Canvas | `#f7f9fc` | Cool paper and sparse dot grid |
| Surface | `#ffffff` | Tool rail and compact panels |
| Ink | `#1d2b40` | Primary labels and default strokes |
| Muted ink | `#637187` | Secondary labels and hints |
| Selection | `#5267ce` | Active tool, focus, handles and selection |
| Boundary | `#dce3ec` | Panel borders and separators |
| Sticky | `#fff0ad` | Default note fill, echoing a real desk note |

Inter 400/500/600 provides readable labels and board titles. IBM Plex Mono 400
provides keyboard hints and zoom readouts. These are the shipped WOFF fonts.
Typography sizes are 12 px for hints, 14 px for controls, 18 px for the board title,
and user-selected document sizes. Controls have 44 px pointer targets even when
their visible icon is 20 px.

## Layout

The chosen layout puts drawing tools in a narrow vertical rail, properties in a
compact adjacent panel, and the board's identity across the top. This preserves
the center and bottom of the canvas for actual work. A horizontal bottom dock
was considered but would compete with the minimap, zoom controls and browser
touch affordances. A permanently expanded inspector was rejected because it
would waste canvas space when nothing is selected.

```text
┌ Board title / board switcher          connection   people   Export ┐
│                                                                   │
│ ┌────┐ ┌ properties, when relevant ┐                              │
│ │ ↖  │ └───────────────────────────┘                              │
│ │ □  │                                                            │
│ │ ○  │                 infinite working canvas                    │
│ │ ▧  │                                                            │
│ │ T  │                                                            │
│ │ ↗  │                                                            │
│ │ ✎  │                                                            │
│ └────┘                                                            │
│ Undo Redo                 contextual tool hint       minimap  Zoom │
└───────────────────────────────────────────────────────────────────┘
```

The signature is an instrument-like rail: each tool has a clear outline icon,
accessible name, shortcut hint, and a small selection indicator. Its spacing
and restrained blue focus state make it feel like a drawing instrument. The
canvas carries the personality through actual colored notes, marks and ideas;
decorative backgrounds and opening animations would compete with that work.

At narrow widths the properties panel becomes a dismissible bottom sheet,
the rail stays usable, and board/connection controls collapse without hiding
their accessible names. No motion is required to use any tool. Focus rings
remain visible and reduced-motion preferences are respected.

## Interaction language

- Tools use stable names: Select, Rectangle, Ellipse, Sticky note, Text,
  Connector, Draw, Eraser and Pan.
- An empty board says: “Choose a tool and make your first mark.” Keyboard hints
  appear with the relevant tool, without a tutorial covering the canvas.
- Connection status distinguishes Connecting, Live, Offline — changes stay on
  this device, and Reconnecting. Never show “Saved” before the persistence
  contract supports that claim.
- Export names the format and scope: PNG/SVG/PDF and Selection/Whole board,
  with scale and transparency only when relevant.
- Viewer access presents a clear “View only” state and disables editing controls.
- A remote text edit shows the person's name as a soft indicator. It does not
  imply an exclusive lock the model cannot enforce.
- Failures state the action and recovery, such as “Image upload failed. Retry.”
  They do not expose storage keys, WebSocket protocols or renderer internals.

Before finalizing the implementation, inspect real browser screenshots at
desktop and narrow viewport widths. Verify contrast, reachable controls,
keyboard focus, exported content and collaboration states using the finished
application, not this design note.
