# Whiteboard renderer

`render()` explicitly draws the current scene, including direct WebGL/layer changes. Animation loops should call `render(false)`: unchanged frames skip GPU work, while document/viewport/selection/live-stroke/presence updates and completed text/image loads request the next draw.

`createRenderer(options)` creates a disposable three.js projection of model elements. The model remains authoritative. `setElements` replaces the entire projection; `applyDiff(upserts, removedIds)` batches document changes until the next `render`/`whenReady` call.

```ts
const renderer = createRenderer({
  canvas,
  fontUrl: '/fonts/inter-latin-400-normal.woff',
  monoFontUrl: '/fonts/ibm-plex-mono-latin-400-normal.woff',
  grid: true,
})
renderer.resize(width, height)
renderer.setElements(documentElements)
renderer.setCamera({ x: 0, y: 0, zoom: 1 })
await renderer.whenReady()
renderer.render()
```

Camera `x`/`y` name the viewport center in document coordinates; positive document `y` points down. Zoom is clamped to 0.02–64. Camera changes do not rebuild shape or stroke geometry.

Opaque rectangles, ellipses, and stickies use one SDF `InstancedMesh` per type. Geometry-independent edits update instance attributes in place. Opaque strokes use shared model `perfect-freehand` outlines and earcut triangulation, packed in chunks of at most 256 strokes; chunks retain their member IDs across insertions and deletions, so an early eraser hit replaces only its containing chunk. Repacking a partially filled tail uses cached tessellations. Committing an opaque stroke after the document maximum and erasing opaque strokes rebuild only affected chunk geometry and connector dependents while still enumerating cached connector membership; insertion within the order, reordering, transparency/type changes, and depth exhaustion use the general ordered projection pass. Sparse depth ranks remain stable when element counts change and renormalize only when room for the text offset and depth precision runs out. Opaque shape batches rebuild only when their own membership changes; connector lines rebuild only when they or their bound targets change. Opaque arrowheads share one instanced mesh with stable recycled slots; changes upload only the affected transform and color ranges, and capacity grows geometrically. Translucent connectors retain individually ordered line and arrow meshes. `strokeChunkRebuilds` and `connectorRebuilds` expose cumulative invalidation counts. Transparent elements use individually ordered meshes so fractional document ordering survives across primitive types. This costs additional calls when a board contains many translucent elements; the S1 bulk benchmark uses opaque elements.

Text uses troika 0.52.5 and shared model font metrics/wrapping. An R-tree selects viewport candidates before a text mesh or layout task is created. No meshes are created for never-visible texts. Previously visible texts detach from the scene while off screen. Text below six screen pixels is hidden. Visible text is gated on `sync()` completion and has a temporary placeholder. `whenReady()` waits for pending layouts. Position, rotation, depth, opacity, and color updates retain the existing text handle. Only text, width, font size/family, alignment, auto-sizing, or primitive type changes request a replacement layout; the ready old mesh stays visible until the replacement sync succeeds. A failed replacement releases its new handle and preserves the ready old display while readiness reports the error. Removal and disposal cancel and release both handles. `textDisposals` counts released text meshes, allowing drag regressions to assert zero disposals.

Japanese input uses a lazy, locally shipped Noto Sans JP fallback; see [font provenance, coverage, and failure handling](./FONTS.md). Readiness rejects after a bounded font/layout timeout instead of leaving export waiting indefinitely.

The concrete `ThreeRenderer` also exposes `setEditingText(id | null)`, `getTextCaret(id, worldPoint)`, and `getTextSelectionRects(id, start, end)` for editor integration. Caret and selection offsets refer to the original document UTF-16 text, with the shared layout mapping accounting for inserted wrap breaks. Selection rectangles are world-space axis-aligned bounds. `getTextObject(id)` exposes the synchronized troika primitive when lower-level editing APIs are needed.

`setSelection({ outlines, frame, marquee })` projects local selection frames into the dedicated `selectionUI` layer. Frames use document coordinates and radians; their eight resize handles and rotation handle retain their screen size while zooming. The exported `selectionHandles(frame, zoom)` supplies the same hit positions to the controller. This state never enters model elements and `setElements` clears it.

`setLiveStroke(stroke | null)` updates a separate dynamic position buffer for the active pen gesture. It does not rebuild committed stroke chunks or insert an element into the projection. Buffer capacity grows geometrically and releases the old GPU buffer. The controller commits pressure-aware simplified input points once at pointerup, then clears this preview.

`setPresence(peers)` accepts `{clientId, name, color, cursor, selection, editingTextId?, viewport?}` records. It queues the latest snapshot; `render()` projects it at most once per frame, so hundreds of awareness callbacks do not rebuild the scene between frames. Presence statistics describe the last rendered snapshot. Up to 40 remote peers receive reusable cursor, name, selection, and editing primitives in `presence`. Labels use the same local Troika fonts; cursor and label sizes remain constant on screen. A multiple selection has one enclosing frame, bounding the geometry cost per peer. Cursor-only updates leave existing frame and label geometry unchanged. `viewport` remains metadata for application navigation. Names are plain text, limited to 80 characters; invalid colors fall back to blue. Label failures are bounded and counted by `presenceErrors`, and do not block document readiness or export. `pendingPresenceLabels` exposes their separate readiness. Call `setPresence([])` to clear peers on the next render; a complete document replacement clears presence immediately.

Image elements use `{assetId, naturalW, naturalH}` from the shared model. Pass `resolveAsset: assetId => urlOrPromise` in renderer options. The immutable asset URL must support normal browser fetch/CORS; bytes never enter the document. An image R-tree defers loading offscreen images. Visible images decode into shared, size-aware `ImageBitmap` thumbnails, capped by `maxDisplayImageSize` (default 2048 pixels on the longest edge) and the GPU limit. Offscreen textures are released. Copies of one asset share its texture, including alpha; transforms, opacity, and global fractional ordering match the other primitives.

`whenReady()` also waits for visible images and rejects visible image failures. `getImageError(id)` exposes the failure; missing resolvers, invalid data, and network/decode errors show an error placeholder. `imageLoadTimeoutMs` defaults to 15000 and also bounds asynchronous asset resolution. Pending work is cancelled on removal/disposal, and late decoded bitmaps are closed. The asset resolver retains ownership of any object URLs it returns.

PNG export decodes the original image bytes into a temporary full-source texture and restores the display thumbnail afterward. Source alpha and CSS-component compositing are preserved. `getMaxImageDimension()` reports the active GPU's texture dimension limit; validate uploads against it. Full-resolution export explicitly rejects larger decoded sources rather than silently lowering resolution. Per-image source tiling beyond that GPU limit is not implemented; output-canvas tiling remains supported.

`exportPng({ bounds, scale, transparent })` fits a cloned camera to document bounds, waits for export-visible text, renders through one reusable MSAA `WebGLRenderTarget` with tile edges capped at 4096 pixels and the GPU limit, reads pixels through reusable tile buffers, and returns a PNG blob. Context loss rejects the export with a retry message; temporary targets and listeners are released on success or failure. It hides grid, selection, presence, and the active pen stroke during export and restores the normal viewport afterward. Transparent readback is unpremultiplied before constructing `ImageData`. The application should feed a separate renderer only committed document elements for export, since ordinary `applyDiff` may also contain its transient shape/transform previews.

## Color policy

This is an unlit 2D compositor. It blends CSS/sRGB component values, matching browser SVG and Canvas 2D opacity. It deliberately bypasses the linear-light transfer locally when parsing CSS colors (`Color.setStyle(value, LinearSRGBColorSpace)`), selects `LinearSRGBColorSpace` output to avoid an extra transfer, and uses an RGBA8 render target with the same policy. Global three.js `ColorManagement` remains unchanged. Shapes, strokes, connectors, text, placeholders, and the background all follow this convention. Future image textures must retain their encoded component values (`NoColorSpace`) in this compositor.

The pixel regression checks 50% red over opaque blue as `[128, 0, 128, 255]` on screen and in PNG, including image textures. Transparent red exports as straight-alpha `[255, 0, 0, 128]`, including alpha embedded in an image source.

Run the isolated production benchmark and renderer regression checks with:

```sh
node spikes/renderer/run-benchmark.mjs
```

It builds a static Vite bundle, temporarily serves it on localhost port 4174, launches installed Chrome with the Mac GPU, writes artifacts under `spikes/renderer/artifacts`, and closes its browser/server. `CHECKS_ONLY=1` runs the narrow projection/export checks without repeating the frame benchmark.

Run `node spikes/renderer/run-media-checks.mjs` for image/presence regressions, or prefix it with `MEDIA_BENCHMARK=1` to include the mixed fixture with 40 moving peers and 16 images. It uses the same isolated port 4174. The [image and presence report](./MEDIA_PRESENCE_REPORT.md) records the measured scope and limitations.
