# S3 Hocuspocus load spike

Status: **Original Y.Map S3 failed. D3 was amended to writer-owned registers.
The replacement candidate passed the full 30-minute S3 gate. The
production-server 30-minute reference completed and passed its measured gates.
The final exact-source production run passed the full 30-minute gate, independent
raw-data verification, source audit and visual memory-trace review.**

The user selected this Mac as the initial deployment and benchmark target.
The server reports Apple M1 Pro, 8 logical cores, 32 GiB RAM, macOS Darwin
25.6.0, and Node v26.8.1. Both the clients and the server run locally; server
resources are measured independently in a dedicated child process.

## Reproduction

```sh
pnpm --filter @whiteboard/loadtest spike
```

The default is 1,800 seconds, 40 clients, 5 document operations per second per
client, and 20 awareness updates per second per client. A smoke run can override
`DURATION_SECONDS=10`; that cannot satisfy the duration or memory gate.

Raw samples are appended every five seconds to `packages/loadtest/results/*.ndjson`.
The completed report is the adjacent `.json`; every operation latency is saved
as a sorted array of little-endian float64 milliseconds in `.latencies.f64le`.
Results use a path relative to the package source, independent of launch cwd.
`pnpm --filter @whiteboard/loadtest verify results/<run>.json` independently
checks the raw latency p95, sample coverage and counters, memory slope, exact
workload, and all client/server hashes. Smoke runs correctly fail its duration
and memory assertions.

Original full run: `s3-2026-09-29T07-38-42.314Z`, server PID 44700, tool process
session 77933. The session exited 1 after the final synchronization timeout.
It is no longer running. The raw `.ndjson` and an explicit `.failure.json`
artifact preserve the evidence.

## Original run outcome

| Measurement | Observed result |
|---|---:|
| Configured workload | 40 clients, 5 ops/s, 20 Hz cursors, 1,800 seconds |
| Generated workload in last progress event | 360,000 operations; 1,440,000 cursors |
| Acknowledgements in that event | 344,900 (intermediate count, not a final total) |
| Last observed progress elapsed time | 1,817.112 seconds |
| Server CPU maximum observed sample | 17.36% of one logical core |
| Server RSS peak | 358.20 MiB |
| Post-warm-up RSS regression slope | +2.79 MiB/min |
| Post-warm-up used-heap regression slope | +3.83 MiB/min |
| Server samples retained | 326 |
| Final round-trip percentiles | Unavailable: successful completion was not reached |
| Final client/server convergence | Unverified: synchronization timed out |

The original harness retained latency observations in memory and wrote them
only after successful draining. Consequently there is no final latency file
for this failed baseline; no final percentile is inferred from the short
smoke runs. Future harness runs must persist partial data on failure.

The client process held 40 complete replicas and was observed at 3.53 GiB RSS
and 470% process CPU during late-run garbage collection pressure. Timing gaps
grew into seconds; the final raw server sample spans 78.47 seconds. These
long gaps also prevent the regular five-second sampling claim from holding
for the whole run. Separate storage diagnostics below independently reproduce
the retained metadata without awareness. The load run therefore fails both
the flat-memory requirement and successful acknowledgement/convergence checks.
The low server CPU samples do not turn the run into a pass.

## Measurement contract

- Each client owns an independent `Y.Doc`, Hocuspocus provider, and Node `ws`
  socket. All 40 edit the same board. Initialization and initial synchronization
  occur before the timed measurement.
- The board contains 32 elements per client, 1,280 total. The operation mix is
  60% replacement of pressure-aware, 48-point stroke geometry, 20% shape movement
  (`x` and `y` in one transaction), and 20% style changes. Reuse of a bounded
  element pool separates runtime leaks from expected growth of visible content.
  This does not prove constant memory for a board whose content grows forever.
- A monotonic deadline scheduler compensates for timer drift. The 30-minute run
  requires exactly 360,000 document operations and 1,440,000 cursor changes;
  final output also records achieved wall-clock rates and worst scheduling gap.
- An operation's round trip begins before the Yjs document transaction and ends
  when the initiating provider receives the server's successful `SyncStatus`
  acknowledgement. The installed 4.7.0 server calls `readUpdate` before writing
  `SyncStatus(true)`; the provider decrements outstanding changes only on a true
  acknowledgement. This measures actual document application and return over
  WebSocket. It is not a stateless echo, persistence acknowledgement, or an
  all-peers delivery latency measurement.
- Server CPU is the child process's user plus system `process.cpuUsage()` delta
  divided by wall time. 100% means one logical core, not the entire 8-core host.
  The gate requires **every five-second CPU sample below 70%**, and reports the
  mean, p95, and maximum. No CPU affinity is claimed.
- RSS and heap memory are sampled every five seconds. Since "flat" has no
  numeric definition in the plan, the harness preregisters an absolute RSS
  regression slope below 1 MiB/min after a five-minute warm-up. The entire
  30-minute raw trace, first/last/peak RSS, and slope are retained for review;
  a numeric slope alone does not excuse evident monotonic or unbounded growth.
- Traffic counts aggregate WebSocket application payload bytes and messages in
  both directions. It excludes framing, TCP, TLS, and OS network overhead.
  Awareness messages are decoded by Hocuspocus message type. Server awareness
  input count is independently reported. The server may combine broadcasts;
  inbound and outbound message counts need not be equal.
- All document updates must be acknowledged with zero disconnects. At the end,
  canonical JSON hashes must match across all 40 clients and the server.
- The server is the Phase 0 in-memory transport spike. Authentication, SQLite,
  asset storage, backups, compaction, routing, and production observability are
  later-phase work. Phase 5 must rerun against that completed server.

## Preliminary smoke evidence

Corrected-timing 10-second smoke (`s3-2026-09-29T07-34-45.345Z`) completed with
2,000/2,000 acknowledged operations, 8,000 cursor updates, no disconnects, and
agreement of all client and server documents. p95 operation round trip was
34.87 ms; highest server CPU sample was 15.32% of one core. These values prove
the harness operates; they do not satisfy the 30-minute gate.

The first smoke is preserved under the originally mistaken nested result path.
It exposed ordinary `setInterval` drift and motivated the deadline scheduler.

## Dependency provenance

The server/provider pins and official proof that 4.7.0 contains the #1151 fix
are in [DEPENDENCY_VERIFICATION.md](./DEPENDENCY_VERIFICATION.md).

## Memory diagnosis during the run

The installed Hocuspocus defaults explicitly enable Yjs `gc: true`; no
`UndoManager` is attached to the server. Nevertheless, the timed run's heap
floor and RSS grew, as quantified above.

`node --import tsx packages/loadtest/src/diagnose-memory.ts` isolates the data
model without awareness, WebSocket, timers, or undo. Its exact-workload replay
uses the same 40 client IDs, 1,280 elements, and 360,000 stroke/move/style
operations as S3. The result is retained in
`packages/loadtest/results/yjs-exact-workload-diagnosis.json`:

| Point | Live elements | Live Item structs | Deleted Item structs | Encoded snapshot bytes |
|---|---:|---:|---:|---:|
| Initial | 1,280 | 14,080 | 0 | 412,976 |
| 60,000 operations | 1,280 | 14,080 | 72,000 | 1,984,630 |
| 180,000 operations | 1,280 | 14,080 | 216,000 | 3,273,430 |
| 360,000 operations | 1,280 | 14,080 | 432,000 | 5,206,670 |

Encoding and reloading each snapshot preserves the same struct count. A
single-property control remains at three structs after 100,000 writes, while
cycling 32 properties retains 100,064 structs. The companion
`yjs-metadata-diagnosis.json` contains that comparison.

This reproduces retained CRDT metadata independently of awareness. Deleting a
value allows its payload to be collected, but the struct retaining its sequence
position cannot always be coalesced with adjacent structs from other properties.
Ordinary `Y.encodeStateAsUpdate` snapshot compaction does not discard that
causal history. A fresh document reconstructed from visible JSON would change
identities and needs a deliberate offline/reconnect/undo migration protocol;
it is not a safe drop-in memory fix. This finding must be resolved or the
affected plan decision explicitly amended before claiming the Phase 0 gate.

This agrees with the [Yjs maintainer's explanation of alternating map
updates](https://discuss.yjs.dev/t/handling-slow-mergeupdates-on-server/1105) and
the [Yjs internals description](https://github.com/yjs/yjs/blob/main/INTERNALS.md).
The maintainer's [YKeyValue utility](https://github.com/yjs/y-utility) stores flat
key/value records in an array and does not support nested shared types. The
following experiments distinguish a single interleaved array from the adopted
writer-owned-array design. All failed baseline data remains available.

## Replacement storage and harness

The global flat-array experiment retained 20,000 deleted structs after 20,000
interleaved writes from 40 writers (23,240 total structs, 1.862 MB snapshot), taking
152.85 s wall time and 144.45 s aggregate CPU. It was stopped after preserving this
negative evidence. Its flat representation had 12,800 logical element fields;
the original 14,080 live structs also included 1,280 Y.Map container Items.

With one array owned by each actual writer client ID, a 360,000-operation
diagnostic plateaued at 4,120 retained / 2,040 deleted structs from 10,000 operations
onward. The final snapshot was 1,692,388 bytes; runtime 629.38 s and 604.99 s CPU cover
the entire in-process replay, not server-only CPU. This diagnostic used bare
field values. The transport replacement uses the actual stamped
`WriterBoardDocument` with its complete base/generation records, independent
property overrides, Lamport ledger, and default same-transaction clock mode.
There is no history capture in this load workload. The model semantic/history
evidence and lifecycle limits are in [D3_STORAGE_INVESTIGATION.md](D3_STORAGE_INVESTIGATION.md).

The replacement harness distributes 40 full independent Y.Doc/provider/socket
clients across 8 processes of 5 clients, each capped at 1 GiB V8 heap. The failed
baseline's single client process reached 3.53 GiB RSS and 470% CPU with 40 replicas;
its GC stalls cannot all be attributed to the server. Distributing client heaps
removes that artificial shared-heap bottleneck without reducing any client,
operation, cursor, payload, or acknowledgement requirement. The server remains
a separate ninth process. Deadline scheduling records actual elapsed rates,
exact final operation/cursor counts and maximum client scheduler delay. Gesture
latency ends only after every packet emitted by that gesture is acknowledged.

Replacement memory acceptance requires both RSS and used-heap absolute slopes
below 1 MiB/min after five-minute warmup, plus review of the full trace and retained
struct counts. Fixed 40 writers and 1,280 elements do not prove bounded memory
under indefinitely accumulating writers, generations, or native undo histories.
No writer retirement, document reset, or offline-update discard is performed.

The 10 s candidate smoke `s3-writer-2026-09-29T08-22-49.432Z` completed 2,000/2,000
gestures and 8,000 cursors, with no disconnects and all 40 clients/server agreeing.
p95 was 19.642 ms, maximum server CPU 14.875% of one core. The next full attempt
`s3-writer-2026-09-29T08-24-57.465Z` was interrupted by the environment/tool reset;
OS inspection confirmed its coordinator/workers gone and an orphan server,
which was stopped. Its `.interrupted.json` records 48,040 saved observed acks and
partial p95 = 20.665 ms; these are not final latency or gate results. The detached
replacement is `s3-writer-2026-09-29T08-45-53.680Z`, coordinator 61351/server 61353.

Each replacement run archives all relevant input source text and SHA256 hashes
at launch. Modules are loaded by the child processes at startup; source changes
during other implementation work cannot silently change the running workload.
Raw per-worker acknowledgement latencies checkpoint every 5 s even if a run fails.
Coordinator shutdown normally closes all eight workers and its owned server.

## Production-server acceptance run

The production harness (`PRODUCTION=1` or `pnpm loadtest`) uses the actual
`BoardDocument` and `createWhiteboardServer`: signed sessions, membership checked
on every packet, viewer enforcement, SQLite WAL with synchronous FULL update
commits, and snapshot/log compaction at 5 MiB or 10,000 updates. It also compares the
persisted SQLite projection hash with the live server and all 40 clients at the
end. Assets and routing have separate integration tests; neither is part of the
per-edit workload. The load user is a private benchmark owner shared by the 40
independent sockets. No session token is written to logs or result artifacts.

The 10 s production smoke `s3-production-2026-09-29T09-03-00.897Z` completed 2,000
acknowledged gestures/packets and 8,000 cursors with all live/persisted hashes
matching. p95 = 96.885 ms and maximum CPU 29.725% of one core. It correctly fails the
duration/memory assertions because it is only a smoke. The full production run
started as `s3-production-2026-09-29T09-06-44.867Z`, coordinator 67021/server 67023.
It overlaps the final nine minutes of the candidate run; frontend/model testing
also occurs on this Mac. Per-process CPU remains isolated, but scheduler and
memory pressure from concurrent work are part of the observed environment.
The history/backup drill finished before this production run started.

That first production attempt did **not** complete. The preserved
`s3-production-2026-09-29T09-06-44.867Z.failure-review.json` records simultaneous
client stalls, a later 4,799.853 s server sampling gap, disconnections, and a
coordinator timeout. Its 202,261 saved observed acknowledgements have partial
p95 19,133.96 ms; this is neither a final percentile nor an S3 pass.

The next attempt, `s3-production-2026-09-29T18-25-07.676Z`, used a frozen executable
source tree, task-scoped `caffeinate -i`, one outstanding server sample request,
and a strict 1,000 ms maximum client scheduler-gap check. It failed at 570.943 s,
with 105,960 saved acknowledgements and all eight clients' process schedulers
stalled 41,061–41,066 ms. The server sample gap was 45,739 ms. macOS power logs
record **Clamshell Sleep** at 01:33:57 +0700 and lid wake at 01:34:40; the task's
idle-sleep assertion was active. This laptop must remain open and awake for the
entire acceptance run. No system power settings or gate thresholds were relaxed.
Its failure-review artifact preserves the relevant power events and trace counts.

The failed run also exposed a harness cleanup defect: the scheduled end timeout
kept already-disconnected workers alive until minute 30. Both worker variants now
track and cancel that timer, and coordinator cleanup waits for exit with bounded
SIGTERM/SIGKILL escalation. These changes affect failure handling, not workload
cadence or measurements. Every retry retains its own source/archive attribution.

Post-archive server changes add explicit member-role reset notifications and
rejected-readonly-sync handling, tested with real WebSockets. The next full run
will include these changes; the workload still has fixed editor memberships.
Static SPA serving is disabled in load runs. Its path-containment/HTTP tests and
the office-NAT sign-in limiter regression cover their separate code paths.

After the user confirmed the Mac could remain open and awake, the next retry
started at **2026-09-29 18:46:25.827 UTC** as
`s3-production-2026-09-29T18-46-22.867Z` (coordinator 82623/server 82626).
The current production permission hooks are included in its frozen input tree.
The preceding 10 s smoke `s3-production-2026-09-29T18-42-33.366Z` passed all
smoke-applicable independent checks: 2,000 acknowledgements, 8,000 cursors,
matching live/persisted hashes, p95 32.59 ms, CPU maximum 27.48%, and clean exit
of all nine children. The 180-day churn drill completed before the final retry;
its assumptions, growth and recovery evidence are in
[the operations report](../packages/server/OPERATIONS_REPORT.md).

Two explicitly reviewed server changes were made **after** that archive:
HTTP logout immediately closes this process's passive subscriptions using the
revoked token, and each authenticated connection gets an expiry timer cleared
on disconnect. Both use the existing reset/close protocol, and focused real-socket
regressions pass. Neither adds periodic polling or changes the load's per-message
auth/sync logic. The frozen run does not exercise these post-archive control
changes. Model/font fixes are also still being finalized. Accordingly this run
is a production reference, not final-source Phase 5 acceptance: the full server
suite, a short production smoke and a new exact-source 30-minute run are required
after all runtime sources are locked, with all archives retained separately.

## Completed candidate result

`s3-writer-2026-09-29T08-45-53.680Z` completed successfully. Independent raw-file
verification passed every assertion, including exact counts, all client/server
hashes, archived source hashes, and all nine child processes exiting with code 0.
OS inspection confirmed no coordinator or server orphan remained.

| Measurement | Result |
| --- | ---: |
| Measured duration | 1,800.001 seconds |
| Gestures / packets acknowledged | 360,000 / 360,000 |
| Cursor updates | 1,440,000 |
| Disconnects | 0 |
| Round trip p50 / p95 / p99 | 7.13 / 28.25 / 61.76 ms |
| Maximum round trip | 1,124.22 ms |
| Server CPU mean / p95 / max, one core | 14.74% / 17.10% / 18.09% |
| RSS first / last / peak | 141.91 / 174.33 / 180.17 MiB |
| RSS slope after five minutes | −0.08287 MiB/min |
| Used-heap slope after five minutes | +0.004815 MiB/min |
| Retained / deleted structs, every warm sample | 3,240 / 1,600 |
| Client→server payload traffic | 313,444 bytes/s |
| Server→all-clients payload traffic | 11,813,042 bytes/s |
| Client awareness updates | 800/s |
| Maximum client scheduler delay | 815.56 ms |

The 361 samples cover the full interval; maximum sampling gap was 6.021 s,
including the first sample's scheduled-start idle time. Five-minute RSS medians
after warmup were 173.36, 175.37, 171.04, 170.45, 173.25 MiB; heap medians were 35.89,
38.21, 35.86, 33.99, 36.32 MiB. All warm retained/deleted struct counts were identical.
The adjacent `.trace-review.json` preserves these window checks. This supports
a flat-memory conclusion for the stated fixed-writer, bounded-content workload.
The maximum latency/scheduler delay are disclosed rather than hidden by p95.
The final production-server acceptance is documented below; this earlier
candidate result alone did not establish persistence-enabled performance.

[Candidate trace plot](../packages/loadtest/results/s3-writer-2026-09-29T08-45-53.680Z.png)
and [standalone PDF](../packages/loadtest/results/s3-writer-2026-09-29T08-45-53.680Z.pdf)
show the CPU, memory, retained metadata and all-acknowledgement latency CDF.

## Completed production reference

`s3-production-2026-09-29T18-46-22.867Z` completed all workload and independent
verification assertions. All nine child processes exited zero, and OS inspection
confirmed no coordinator/server orphan. It is a reference for its archived
source, **not final-source Phase 5 acceptance**, because the passive-session
controls and final model/font changes described above landed after its archive.

| Measurement | Result |
| --- | ---: |
| Measured duration | 1,800.003 seconds |
| Gestures / packets acknowledged | 360,000 / 360,000 |
| Cursor updates / disconnects | 1,440,000 / 0 |
| Round trip p50 / p95 / p99 / maximum | 17.24 / 35.45 / 51.22 / 151.31 ms |
| Server CPU mean / p95 / maximum, one core | 31.57% / 35.50% / 40.32% |
| RSS first / last / peak | 206.59 / 223.73 / 241.56 MiB |
| RSS / used-heap slope after warmup | −0.83722 / +0.09775 MiB/min |
| Warm retained / deleted structs | 3,363 / 1,720, every sample |
| Maximum client scheduler gap | 94.22 ms |
| Inbound / aggregate outbound payload bytes per second | 334,433 / 11,906,847 |
| Client awareness messages per second | 800 |
| Automatic SQLite compactions | 57 |

All 40 client hashes agree with the live server and reconstructed SQLite state.
The 361 samples cover the whole run, with maximum timestamp gap 5.080 seconds;
the first CPU interval is 6.032 seconds because it includes scheduled-start idle
time. The full repository unit checks shared this Mac during the final portion;
their actual scheduling/resource effects are retained in the trace.

Visual memory review includes the complete
[trace plot](../packages/loadtest/results/s3-production-2026-09-29T18-46-22.867Z.png)
and [PDF](../packages/loadtest/results/s3-production-2026-09-29T18-46-22.867Z.pdf),
plus `.trace-review.json`. After five-minute warmup:

| Minutes | RSS min / median (MiB) | Used heap min / median (MiB) |
| --- | ---: | ---: |
| 5–10 | 237.98 / 239.26 | 22.63 / 32.49 |
| 10–15 | 235.22 / 240.08 | 25.07 / 36.51 |
| 15–20 | 239.05 / 240.28 | 21.96 / 39.71 |
| 20–25 | 219.09 / 224.64 | 22.46 / 39.29 |
| 25–30, including final sample | 221.00 / 224.09 | 22.96 / 36.78 |

The first/last post-warmup samples are RSS 240.56→223.73 MiB and used heap
24.97→45.24 MiB. The heap endpoint increase is disclosed: those endpoints occupy
different phases of the visible allocation/collection sawtooth. Across the full
trace, sampled heap floors stay around 22–25 MiB and the initially rising medians
fall again; 122 adjacent sample pairs drop by at least 5 MiB. No instrumented
full-GC event is claimed, and no forced collection or discarded sample was used.
RSS has a downward step near minute 21, coinciding with other repository checks;
this timing does not establish their causal contribution. Fixed retained CRDT
counts, comparable heap floors, and the complete curve support no sustained
retained-memory growth in this bounded workload. The separate churn drill still
shows storage growth with new writers and generations, as documented.

## Final source-locked acceptance run

The final smoke `s3-production-2026-09-29T19-26-52.808Z` passed every
smoke-applicable independent assertion: 2,000 operations/acknowledgements, 8,000
cursors, no disconnects, matching 40-client/live/SQLite projections and all nine
children exiting zero. p95 was 24.82 ms, maximum server CPU 25.97%, and maximum
client scheduler gap 53.62 ms. Duration/memory acceptance is intentionally false
for that ten-second diagnostic.

The final full run, **`s3-production-2026-09-29T19-27-40.330Z`, passed**, starting at
**19:27:43.232 UTC**, coordinator 93813/server 93829 with task-scoped caffeinate
93828. Its source hashes exactly match the final smoke and matched the worktree
at launch and completion. The adjacent `.source-audit.json` traces the 13 local modules from
the server benchmark and production client worker, conservatively including
type-only imports and generated font metrics JSON. All are copied into the
executable input archive. There are no imports from the mutable app or renderer
and no dynamic imports in that local graph. Dependencies remain pinned through
the archived manifests/lockfile and installed modules; updates are frozen for
this run. The parent reported all 82 unit tests passing, including the 15 server
and static-serving tests, before launching this exact-source sequence.

Deployment/UI checks shared this Mac during the run. Actual per-process CPU,
scheduler gaps and all raw samples are retained, without removing their effects
or changing workload, latency, completeness or memory criteria.

| Measurement | Final result |
| --- | ---: |
| Measured duration | 1,800.001 seconds |
| Operations / acknowledgements / document packets | 360,000 / 360,000 / 360,000 |
| Cursor updates / disconnects | 1,440,000 / 0 |
| Round trip p50 / p95 / p99 / maximum | 18.07 / **36.89** / 55.22 / **1,179.97 ms** |
| Server CPU mean / p95 / maximum, one core | 32.86% / 36.87% / **40.73%** |
| Maximum client scheduler gap | 171.90 ms |
| RSS first / last / peak | 264.55 / 248.98 / 280.48 MiB |
| RSS / used-heap slope after five-minute warmup | **+0.23561 / +0.001261 MiB/min** |
| Warm retained / deleted structs | 3,363 / 1,720, every sample |
| Inbound / aggregate outbound payload bytes per second | 334,223 / 11,888,932 |
| Client awareness messages per second | 800 |
| Automatic SQLite compactions | 57 |

The latency maximum is a real tail outlier and remains in the raw observations
and plot. The unchanged latency gate is p95 below 150 ms; no maximum-latency
acceptance bound is substituted for it. Payload traffic excludes TCP/TLS and
WebSocket framing overhead.

The independent verifier returned every assertion true: raw latency-file
integrity and recomputed p95, raw sample identity and coverage, full duration,
exact workload and complete acknowledgements, scheduler cadence, server-observed
packet counts, every CPU sample below 70% of one core, both post-warmup absolute
memory slopes below 1 MiB/min, and matching projections from all 40 clients, the
live server and the reconstructed SQLite state. The shared 1,280-element hash is
`2ba91a14ba8df2c2a569af939abd78d9a674ab02f89a22164c13aa9174aa051d`.
The result includes all nine child exits with code zero and no failure event.
OS inspection confirmed the coordinator, server and sleep-prevention process
had exited. The frozen input tree remains intact and all archived source hashes
still match the worktree; no runtime source change needs an attribution exception.

The 361 samples cover the complete run. The maximum actual timestamp gap is
5.093 seconds; the first CPU interval is 6.050 seconds because it includes the
one-second scheduled-start idle period. SQLite recorded 360,080 updates, including
80 initialization updates before the measured counters were reset. At completion,
the remaining update log has 4,616 updates / 3,907,038 bytes, the stored snapshot
is 1,671,854 bytes, and the current encoded state is 1,673,486 bytes.

Visual review used the complete
[trace plot](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.png),
[standalone PDF](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.pdf)
and [window statistics](../packages/loadtest/results/s3-production-2026-09-29T19-27-40.330Z.trace-review.json).
Post-warmup five-minute windows are:

| Minutes | Samples | RSS min / median (MiB) | Used heap min / median (MiB) |
| --- | ---: | ---: | ---: |
| 5–10 | 60 | 238.22 / 241.85 | 32.18 / 44.29 |
| 10–15 | 60 | 242.98 / 243.78 | 32.82 / 50.67 |
| 15–20 | 60 | 242.70 / 243.93 | 31.13 / 47.87 |
| 20–25 | 60 | 243.25 / 244.02 | 32.85 / 49.09 |
| 25–30, including final samples | 62 | 239.98 / 248.07 | 31.75 / 46.82 |

RSS has modest upward drift, with a long middle plateau and a late step; it is
not numerically constant. The first and last post-warmup samples are RSS
238.83→248.98 MiB (+10.16 MiB) and used heap 36.33→52.42 MiB (+16.10 MiB).
The endpoints occupy different phases of the allocation/collection sawtooth:
heap floors remain around 31–33 MiB, window medians rise and fall, and 131 adjacent
sample pairs drop by at least 5 MiB. No instrumented full-GC event is claimed;
there was no forced collection, document reset, sample discard or trimming.
Window medians for heap capacity stay within 105.47–105.84 MiB and external memory
within 8.23–8.59 MiB. Every warm sample retains exactly 40 writer arrays and the
same 3,363 / 1,720 retained/deleted structs.

The full curve, stable heap floors, stable capacity/external memory and fixed
CRDT metadata support the declared memory gate for this fixed-writer, bounded
workload, beyond the numerical slope check alone. This does not establish
constant storage for indefinite writer turnover or lifecycle churn: the separate
180-day drill explicitly measures that growth. Together with the source audit,
complete workload, convergence and clean shutdown evidence, the final production
S3 acceptance gate is **passed**.
