# Loadtest processes

The standalone experimental servers live here: `src/spike.ts` is the historical
nested-map candidate, `src/spike-writer-kv.ts` is the writer-register candidate,
and `src/benchmark.ts` wraps the production server with an isolated SQLite store.
Importing any of these entry points starts its server process. The production
server package contains no benchmark entry point.

From the repository root, `pnpm loadtest` runs the production workload.
`pnpm --filter @whiteboard/loadtest spike:writer` runs the writer candidate and
`pnpm --filter @whiteboard/loadtest spike` runs the historical nested-map candidate.
These are long workloads; use the bounded entry-point tests for startup checks:

```sh
pnpm exec vitest run packages/loadtest/src/server-entry.test.ts
```

Those tests start one idle server at a time on an ephemeral port, request IPC
samples, reset counters, obtain an empty document snapshot, and require clean
shutdown. They also start frozen writer and production children and trace their
actual model imports. They do not start clients or workload coordinators.

The writer/production coordinator explicitly calls the side-effect-free
`src/source-inputs.ts` helper to capture source text and SHA-256 hashes before
forking. The production capture includes every non-test server module, including
`update-limits.ts`; both captures include the helper, model sources, spike model
sources, relevant package manifests, and lockfile. Child entry paths refer to
this captured tree. Workspace dependency links resolve to captured packages;
unused workspace packages are omitted. External dependency links use the
installed versions pinned by the captured lockfile, so keep the installation
unchanged during a measured run. Outputs are under ignored `results/` paths.
Production session tokens stay in private IPC messages and are omitted from
recorded ready events.
