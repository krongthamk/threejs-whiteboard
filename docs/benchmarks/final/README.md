# Final verification on the accepted Mac

Recorded 2026-09-30 local (2026-09-29 UTC), Apple M1 Pro / 8 logical cores / 32 GiB, Chrome 154 hardware-accelerated through ANGLE Metal. [Source SHA-256 manifest](sources.json) covers 58 runtime/toolchain files, verified unchanged after the runs and local deployment. The runtime remained frozen for the independent full-duration server run.

| Check | Final result | Raw evidence |
| --- | --- | --- |
| TypeScript | Pass | [log](typecheck.log) |
| Complete unit/integration suite | 85/85, 12 files, 93.89 s | [JSON](unit.json), [log](unit.log) |
| Complete application suite, PDF raster inspection and performance enabled | 51/51, 129.35 s, no skips/retries | [JSON](app.json), [log](app.log) |
| S4 prototype | 8/8, 10.7 s | [JSON](s4.json), [log](s4.log) |
| Actual two-owner routed browser | 1/1, 5.7 s | [JSON](routed.json), [log](routed.log) |
| Application 5,000-shape gate | 60.002 fps, 360 frames, zero page errors | [measurement](../phase1/application-performance.json) |
| S1 mixed/20k shapes/500 texts/culling | All gates pass, approximately 60 fps, nine correctness assertions | [measurement](../../../spikes/renderer/artifacts/s1-results.json), [log](s1.log) |
| Mixed renderer +16 images +40 peers | 60.0024 fps, 600 frames, 21 assertions, zero errors/external requests | [measurement](../../../spikes/renderer/artifacts/media-presence-results.json), [log](media.log) |
| Dependency license audit | Pass | [log](license-audit.log) |
| Production Vite build, test hooks disabled | Pass | [log](build.log) |
| Final exact-source production S3 | 30 minutes, all 360,000 acknowledgements, p95 36.89 ms, CPU max 40.73%, reviewed memory gate and persisted convergence pass | [full report](../../S3_LOAD_REPORT.md) |
| Actual launch-agent deployment, UI smoke and redeployment | Pass, exact welcome-board export preserved | [deployment evidence](../deployment/) |

The commands were `pnpm typecheck`; `pnpm exec vitest run --reporter=default --reporter=json --outputFile=docs/benchmarks/final/unit.json`; `VERIFY_PDF=1 RUN_APP_BENCHMARK=1 pnpm test:app`; `pnpm test:browser`; `pnpm test:routed`; `node spikes/renderer/run-benchmark.mjs`; `MEDIA_BENCHMARK=1 node spikes/renderer/run-media-checks.mjs`; `node scripts/license-audit.mjs`; and `VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build`. Playwright was invoked with the equivalent config and `list,json` reporters to retain machine-readable results. GPU suites ran serially, without a competing managed browser or unit suite during timed frames. The separate 40-client production load was active, so these are measurements of the actual concurrent host workload, not an idle-machine claim.

The passing full-duration production S3 has its own source archive, server/client processes, persisted convergence check and memory analysis in [S3_LOAD_REPORT.md](../../S3_LOAD_REPORT.md). Short smoke and passing earlier source versions do not substitute for it. Prior performance references are retained in [pre-final-reference](pre-final-reference/).
