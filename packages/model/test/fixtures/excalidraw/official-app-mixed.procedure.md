# Genuine mixed-scene capture — preparation only

Status: CAPTURED after root browser release. Final original.excalidraw is an unchanged official-app download. See provenance.json and actions.json for actual execution; the steps below were the preparation plan and differ slightly from the observed native placement. Headless File System Access required the documented browser-capability fallback; failed attempts are retained.

## Input and provenance boundaries

Use the official https://excalidraw.com app in a new Playwright browser and fresh nonpersistent context (English locale, fixed 1440x1000 viewport, no prior storage state). Do not open an existing user browser/profile. All scene elements must be created by visible toolbar/native keyboard/mouse actions, with no JSON import, app API injection, internal element constructors, or fabricated download. The scene is synthetic test content, but the exported document must be genuine official-app output. No sharing, publishing, login, or private user content.

Upload the existing synthetic repository fixture packages/server/test/fixtures/assets/legacy-image-1.png through the official image file-input UI. Record its SHA-256 and origin; it is test content, not an upstream image. Copy it under this ignored evidence directory for stable capture provenance; never edit its tracked source.

## Planned visible UI sequence

1. Load blank official app, inspect toolbar labels and screenshot the fresh state. Record observation time, URL, browser version, document title, observed script URLs/build identifiers, document response hash and loaded main script hashes. An upstream HEAD commit is not automatically the deployed app version.
2. Rectangle: native drag at roughly (350,220) to (560,330). Native double-click inside, type a short two-line bound label, finish editing with Escape. Confirm exported text has containerId and reciprocal rectangle boundElements, rather than assuming binding from a screenshot.
3. Ellipse at (680,210) to (870,330), then diamond at (970,210) to (1100,330). Native drag tools from observed toolbar labels.
4. Free text at (360,440), typed natively, including a small Japanese sample and a trailing newline only if the official editor retains it. No unsupported script injection.
5. Arrow: drag from rectangle edge to ellipse edge and verify startBinding/endBinding in the actual export. If not bound, adjust arrow endpoints through native handles and re-export; never patch output bytes.
6. Freedraw: draw a bounded six-segment native mouse path at (350,610). Line: native drag at (650,580) to (870,650).
7. Image: select image tool or its More tools item, attach the local synthetic PNG through its file input, and place/size it in a clear region through native mouse actions.
8. Frame, if the observed tool is available and bounded: native drag around a small disjoint scene region, give it a native name if available. If unsupported/unavailable, record the omission honestly.
9. Deselect and capture a full screenshot. Inspect it manually. Save with the official Save to disk / Save as menu action or its native shortcut. Prefer Playwright's genuine download event; if the app selects File System Access instead, inspect the visible UI and use its provided download fallback. Do not replace the save implementation or generate JSON externally.
10. Retain downloaded .excalidraw bytes unchanged as original.excalidraw. Record original filename, byte length, SHA-256, type/version/source, element-type counts, bindings, bound labels, files entries and decoded uploaded-image hash. Analysis output is separate and must not reserialize the original fixture.
11. Retain automation script, chronological native action log, Playwright trace (screenshots/snapshots), visual scene screenshot, relevant build metadata and provenance.json. State explicitly that UI was machine driven. Record any omitted or unsuccessful tool/actions. Optionally reopen the unchanged saved file in another new official-app context via native Open to confirm it is usable; this is validation, not fabrication.

## Primary source references consulted

- https://docs.excalidraw.com/docs/codebase/json-schema/ — local .excalidraw type/version/source/elements/appState/files and clipboard envelope distinction.
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/Toolbar.tsx — rectangle/diamond/ellipse/arrow/line/free draw/text toolbar and image/frame extra-tools UI. These sources guide discovery; current deployed UI must still be observed.
- https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/actions/actionExport.tsx — official save action delegates to saveAsJSON. Never substitute a programmatic constructor for UI save.

## Failure handling

If official app navigation or required assets fail, retain exact URL/status/error and screenshot/trace. Do not call synthetic factories or the existing single-text legacy fixture a genuine mixed export. Only after a concrete access failure, propose a pinned official checkout locally built and captured through the same fresh UI workflow; no dependency/install or browser fallback execution without root coordination.
