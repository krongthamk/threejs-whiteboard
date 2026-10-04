# Cold PNG text readiness

The production `BoardExporter` initially exported a blank 5430 × 180 PNG when the main renderer was still generating the same text's glyphs. The immediate warm export contained 78,791 dark pixels. An offscreen document-text control exported correctly on both attempts. The failing state and images were inspected during that run; the generated outputs are no longer tracked.

Pinned Troika 0.52.5's `TextBuilder` inserts glyphs into its shared atlas cache before awaiting SDF generation. A second renderer can therefore finish its own text synchronization without those texels being ready. This was not a camera, LOD or bounding-box change.

The renderer now tracks document and presence text synchronization across instances. PNG export waits for current atlas work, including work whose original consumer was disposed. Completion releases the tracking; the configured font deadline rejects a waiting export and releases it too. Ordinary document rendering remains asynchronous. Presence labels remain excluded from PNG content.

Validation: Chrome production-bundle tests **4/4 passed in 21.0 seconds**, including the existing repeated-ligature PNG/SVG/PDF test and new cold/warm offscreen, onscreen and presence cases. Every cold/warm case produced **78,791 dark pixels**, with identical ink bounds **[61, 60, 5374, 128]**. Recorded initial states show one pending document sync for the onscreen case and one pending label sync for presence. Those JSON/PNG outputs are now untracked; these measurements record their original inspection.

Three focused unit tests pass: another mesh's atlas work delays readiness; consumer disposal does not prematurely release it; timeout rejects waiting exports and releases tracking. Typecheck and diff checks pass. The repeated-ligature result is recorded separately in [ligatures.json](ligatures.json): PNG/SVG/PDF ink bounds match; this does not claim exact pixel equality.
