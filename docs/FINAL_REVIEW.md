# Implementation review

Baseline: `ee372ddafd4744f67e1e1b0d467ebf2f608c968b`, the initial research commit. This historical review was recorded with the initial implementation in commit `fed369b`. Its comparison used `git diff ee372dd --` including all new implementation files, made visible with intent-to-add; a tracked-only empty diff was not used. Later implementation changes are tracked separately in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Specification: [BUILD_PLAN.md](BUILD_PLAN.md). Two independent agents reviewed standards and specification in parallel.

## Standards

No AGENTS.md, STANDARDS, CONTRIBUTING, or other documented coding-style rules were found. No hard standards violations can be cited. TypeScript/CI checks are validated separately.

Two non-blocking maintenance observations remain: pointer-to-world arithmetic is repeated in the controller, image placement and awareness code; export test comparators repeat pixel-neighborhood/ink-bound mechanics. Shared helpers may help future changes, but no speculative abstraction or broad refactor is required for deployment.

Result: **0 documented-standard breaches, 2 maintenance observations.**

## Specification

1. **P1, fixed and verified:** Phase 5 requires a router that “maps board_id → shard.” The application initially opened `/collaboration` without its board ID, although multi-shard routing rejects keyless sockets. The app now supplies `?boardId=...`; `pnpm test:routed` exercises actual board editing and reloads on two separate owners and checks owner/non-owner connection counts.
2. **P1, fixed and verified:** Phase 2 requires “auto-size,” and §3.2 derives autosized text geometry from text. Primary-only metrics initially differed from Troika's carried fallback font after Japanese text, so long Latin suffixes could exceed bounds or clip in exports. Shared shipped-font metrics, fallback carry across lines, generated ligature/position data and pure SVG positioning now match all 26 actual Troika width cases. Native IME/caret/reopen and mixed PNG/SVG/PDF regressions pass; repeated ligatures have identical export ink bounds within unchanged foreground tolerances. The follow-up shared-atlas cold/warm regression also passes on-screen, off-screen and with presence labels. [TEXT_LAYOUT_REPORT.md](TEXT_LAYOUT_REPORT.md) explicitly records that the unchanged plaintext editor can temporarily use different native typography; no native glyph-pixel parity is claimed.

No additional actionable missing implementation or unrequested v1 scope was found in the reviewed document/history, authentication, image/clipboard, export, persistence, routing/drain or backup paths. Final S3 and deployment were explicitly pending during review, not presumed complete.

Result: **2 functional integration findings; both resolved with regression evidence.**

## Additional correctness review

Review-driven regression checks also cover an unchanged native draft overwriting peer text, delayed navigation responses, minimap resize, editor downgrade/cache reset and regrant, PNG connector caps/joins, opaque export alpha, PDF font loading/retry, and deployment readiness that previously could accept another process on the same port. The session review added immediate same-process passive logout invalidation and an exact signed-expiry timer; cross-owner invalidation limitations are documented in the server operations guide.

The final export regression also exposed shared Troika glyph metadata becoming visible before SDF atlas generation finished in another document renderer or presence label. A bounded shared readiness gate now covers both sources, preserves cancellation/disposal behavior, and passes three lifecycle unit tests plus cold/warm on-screen/off-screen/presence browser checks. [Failure and regression evidence](benchmarks/phase4/mixed-text-layout/png-atlas-readiness.md). The source-frozen final suite passes 85 unit/integration tests and 51 application browser tests with PDF raster inspection and the Mac performance gate enabled; separate S4 and two-owner routing suites also pass.
