# Final verification on the accepted Mac

**Evidence retention (October 2026):** Measurements below describe the original historical runs. Generated logs, raw latency/sample files, screenshots, PDFs and auxiliary JSON are no longer tracked. The audit-linked summary JSON and font metrics evidence remain; new run outputs stay local and ignored. Historical measurements were not rerun by this cleanup.

Recorded 2026-09-30 local (2026-09-29 UTC), Apple M1 Pro / 8 logical cores / 32 GiB, Chrome 154 hardware-accelerated through ANGLE Metal. [Source SHA-256 manifest](sources.json) covers 58 runtime/toolchain files, verified unchanged after the runs and local deployment. The runtime remained frozen for the independent full-duration server run.

| Check | Final result | Retained evidence / historical outputs |
| --- | --- | --- |
| TypeScript | Pass | Historical log removed |
| Complete unit/integration suite | 85/85, 12 files, 93.89 s | [JSON](unit.json); historical log removed |
| Complete application suite, PDF raster inspection and performance enabled | 51/51, 129.35 s, no skips/retries | JSON; historical log removed |
| S4 prototype | 8/8, 10.7 s | JSON; historical log removed |
| Actual two-owner routed browser | 1/1, 5.7 s | JSON; historical log removed |
| Application 5,000-shape gate | 60.002 fps, 360 frames, zero page errors | [measurement](../phase1/application-performance.json) |
| S1 mixed/20k shapes/500 texts/culling | All gates pass, approximately 60 fps, nine correctness assertions | [measurement](../s1/s1-results.json); historical log removed |
| Mixed renderer +16 images +40 peers | 60.0024 fps, 600 frames, 21 assertions, zero errors/external requests | Historical measurement/log removed |
| Dependency license audit | Pass | Historical log removed |
| Production Vite build, test hooks disabled | Pass | Historical log removed |
| Final exact-source production S3 | 30 minutes, all 360,000 acknowledgements, p95 36.89 ms, CPU max 40.73%, reviewed memory gate and persisted convergence pass | [full report](../../history/2026-09-29/S3_LOAD_REPORT.md) |
| Actual launch-agent deployment, UI smoke and redeployment | Pass, exact welcome-board export preserved | [deployment evidence](../deployment/) |

The commands were `pnpm typecheck`; `pnpm exec vitest run --reporter=default --reporter=json --outputFile=docs/benchmarks/final/unit.json`; `VERIFY_PDF=1 RUN_APP_BENCHMARK=1 pnpm test:app`; `pnpm test:browser`; `pnpm test:routed`; `node spikes/renderer/run-benchmark.mjs`; `MEDIA_BENCHMARK=1 node spikes/renderer/run-media-checks.mjs`; `node scripts/license-audit.mjs`; and `VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build`. Playwright was invoked with the equivalent config and `list,json` reporters to retain machine-readable results. GPU suites ran serially, without a competing managed browser or unit suite during timed frames. The separate 40-client production load was active, so these are measurements of the actual concurrent host workload, not an idle-machine claim.

The passing full-duration production S3 has its own source archive, server/client processes, persisted convergence check and memory analysis in [S3_LOAD_REPORT.md](../../history/2026-09-29/S3_LOAD_REPORT.md). Short smoke and passing earlier source versions do not substitute for it. Prior performance references were reviewed separately; their generated files are no longer tracked.
