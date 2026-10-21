# Backend deployment assessment — 2026-10-22

Deployment infrastructure has since been added in [deploy/](../deploy/README.md),
including a Node LTS image, Compose services, backup/restore jobs, systemd timers
and a Linux deployment verification workflow. The original assessment below is
historical; target-host access, configuration and acceptance remain required.

The backend is suitable for a private, single-server pilot after the hosting
configuration below is in place. It is not a turnkey remote production deployment:
this repository's deployment automation targets macOS launchd on loopback, and
the target server, TLS proxy, service supervision, backups and monitoring have
not been configured or tested. No remote deployment was performed during this review.

The browser demo is preserved separately at
[threejs-whiteboard-demo](https://github.com/krongthamk/threejs-whiteboard-demo),
starting from commit `7b2f1f290366ca9dda5abf24d8747ad99dc17c1f`.
Its runtime modules, build flags, scripts, tests and Vercel configuration have
been removed from the current application tree. Git history remains intact.
The demo repository is an independent repository with shared history, rather
than a GitHub fork-network relationship.

## What is implemented

- Password authentication with scrypt, signed database-backed sessions, secure
  cookie support, origin checks and bounded login attempts/concurrency.
- Owner/editor/viewer permissions on HTTP requests and collaboration traffic;
  session expiry, role changes and revocation checks.
- SQLite WAL with `synchronous=FULL`, transactional schema migration, an update
  log and compaction that preserves document clocks.
- Persistence-failure readiness reporting and recovery; SIGTERM/SIGINT draining.
- A built-in static frontend server, `/health`, `/ready`, and authenticated
  per-board metrics at `/api/metrics`.
- Database/asset/session-secret backups, verified restore, and offline asset
  garbage collection. These commands still need scheduling and off-host storage.
- Per-message and per-board collaboration limits, inbound queue bounds and slow
  consumer handling.

Implementation references: [configuration](../packages/server/src/config.ts),
[entry point](../packages/server/src/index.ts),
[HTTP and collaboration server](../packages/server/src/server.ts),
[persistence](../packages/server/src/store.ts), and
[operations](../packages/server/src/operations.ts).

## Requirements for the server

The resource figures below are an initial sizing recommendation for a small
private team, not a measured capacity guarantee. Final sizing depends on active
boards, concurrent editors, image volume and disk latency.

| Item | Requirement |
| --- | --- |
| Hosting | One always-running VPS/VM or one persistent container on a single host; start with one application process/replica. |
| OS and access | Maintained Linux distribution, for example Ubuntu 24.04 LTS, with SSH and permission to install a service, reverse proxy and certificates. Docker is optional; no Dockerfile is supplied. |
| Starting resources | 2 vCPU, 4 GiB RAM, 40 GiB SSD, with room for assets, logs and backup staging. Increase after measuring the actual workload. |
| Runtime | Choose a supported Node LTS release within the package engine range, plus pnpm 9.15.9. As of this review, Node 24 is LTS; this checkout and its existing CI have been tested on Node 26.8.1/26 instead. Validate the chosen LTS runtime before launch. |
| Installation | Full workspace install using `pnpm install --frozen-lockfile`. `tsx`, used by the server entry point, currently lives in root devDependencies; a production-only dependency install is insufficient. Install native dependencies on the target OS/architecture; do not copy macOS `node_modules` to Linux. |
| Native dependency | `better-sqlite3` must load successfully. If no compatible prebuilt binary is available, provide Python 3, make and a C/C++ compiler. |
| Durable storage | An absolute, private, service-writable data directory on local or single-host attached block storage. Preserve the database, WAL state, assets and session secret across restarts/redeployments. Do not place SQLite WAL on NFS/SMB/shared multi-host filesystems. |
| Public endpoint | A domain/subdomain with DNS pointing to the host and a valid HTTPS certificate with automatic renewal. Serve frontend, API and WebSocket endpoint under the same origin. |
| Network | Public HTTPS on 443; port 80 if used for HTTP redirect or certificate validation. Restrict SSH. Keep the application port 3001 private; same-host proxy can use loopback. |
| Proxy | Forward `/`, `/api/*` and `/collaboration` to the application. Support WebSocket upgrades and long-lived connections; allow at least 20 MiB request bodies for image uploads. Avoid caching authenticated API or avatar responses. |
| Process supervision | Dedicated unprivileged account; systemd or equivalent auto-start/restart and log rotation. Allow at least 30 seconds for graceful shutdown; default application drain is 5 seconds, followed by store/connection cleanup. |
| Backups | Scheduled application backup, private off-host retention, and a successful restore drill. Define acceptable data loss and recovery time; at minimum take daily backups and a fresh backup before upgrades. |
| Monitoring | Alert on `/ready` failures, process restarts, persistence errors, disk/inode exhaustion, CPU/RAM and backup failures. `/health` alone only establishes process responsiveness. |

The Node project's [release guidance](https://nodejs.org/en/about/previous-releases)
recommends supported LTS releases for production. SQLite documents the
[WAL single-host filesystem restriction](https://www.sqlite.org/wal.html).

The archived 40-client, 30-minute benchmark passed on an Apple M1 Pro with 32 GiB
RAM; it reported about 280 MiB peak server RSS. That is historical evidence for a
specific workload, not a certification of the current source on a small Linux
VPS. See the [load report](history/2026-09-29/S3_LOAD_REPORT.md) and
[operations report](../packages/server/OPERATIONS_REPORT.md).

## Environment and launch contract

Supply these through the service manager's environment. The application does
not automatically load a `.env` file. Replace the paths and example domain:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
WHITEBOARD_DATA_DIR=/var/lib/threejs-whiteboard
WHITEBOARD_STATIC_DIR=/opt/threejs-whiteboard/packages/app/dist
WHITEBOARD_ORIGINS=https://board.example.com
WHITEBOARD_SECURE_COOKIES=1
WHITEBOARD_TRUSTED_PROXY=1
WHITEBOARD_DRAIN_MS=5000
WHITEBOARD_GOOGLE_ENABLED=0
```

Use `WHITEBOARD_TRUSTED_PROXY=1` only when a controlled proxy is the only ingress
to port 3001 and supplies the actual client IP as the final `X-Forwarded-For`
hop. Otherwise leave it off. For a proxy in a different container, bind the app
to its private container interface and restrict published ports accordingly.

The server creates a private `session-secret` file under the data directory.
Keep it stable. The data directory should be mode 0700 and secrets mode 0600.
Google OAuth is optional and remains disabled; password accounts need no Google
credentials. To enable it later, use the
[Google operations guide](../packages/server/README.md#google-configuration).

Install and build from the repository root before the service starts:

```sh
pnpm install --frozen-lockfile
VITE_TEST_HOOKS=0 pnpm --filter @whiteboard/app build
node scripts/check-production-hooks.mjs
```

Provision the first account separately, as the service user and against the
same data directory:

```sh
WHITEBOARD_DATA_DIR=/var/lib/threejs-whiteboard pnpm --filter @whiteboard/server provision owner
```

This prints a generated password once; store it privately. Start the service
from the repository root with `pnpm server` and the environment above. The
service manager must make Node and pnpm available without an interactive shell.

For nginx, explicitly forward the WebSocket `Upgrade` and `Connection` headers
and configure an appropriate read timeout; see its
[WebSocket proxy documentation](https://nginx.org/en/docs/http/websocket.html).
Preserve the public host and forward the client IP. An HTTP-only port check is
insufficient: validate actual collaborative edits through HTTPS/WSS.

## Remaining launch gates and limitations

1. Configure the actual Linux service or container, persistent storage, DNS,
   HTTPS proxy, secure environment and first user. The macOS helper does not
   perform any of those remote-host steps.
2. Run install, typecheck, tests and startup on the selected supported LTS
   runtime/OS. Existing CI uses Node 26; add coverage for the deployed runtime.
3. Verify two independent browser sessions can sign in, share/edit a board,
   upload an image, reconnect, and retain the board after a service restart.
   Verify expired/revoked sessions and HTTPS cookie behavior through the proxy.
4. Schedule backups and demonstrate a restore on a fresh directory. Use the
   supplied backup CLI instead of copying only a live `whiteboard.sqlite` file.
5. Confirm sizing under expected load and configure resource/disk alerts.

There are no global account/board/image-storage quotas or aggregate connection
limits. The 64 MiB default board limit covers document bytes, not image blobs;
20 MiB is a per-image limit. Accumulated images and document history require
capacity monitoring. This is a private-team deployment model, not readiness for
unrestricted public signup or arbitrary tenant workloads.

Do not enable multiple hosts or generic round-robin app replicas. Shared
transactional persistence, board ownership and cross-process revocation need
further work for that deployment. An operator CLI revocation is observed by an
already-open passive socket on its next inbound packet or expiry; the separate
CLI cannot proactively disconnect it. The browser's Connected status is a
transport acknowledgement, not a separate disk-fsync receipt.

The removed Vercel configuration did not solve these storage/ownership
requirements. Current Vercel Functions do support WebSockets, but connections
can move between instances on reconnect and durable state must be external.
This backend needs architectural changes for that model; see
[Vercel's lifecycle and state guidance](https://vercel.com/docs/functions/websockets).

## Verification for this assessment

Verified on this Mac with Node 26.8.1 and pnpm 9.15.9, using a fresh installation
of a clean snapshot of the tracked application source:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed. |
| `pnpm typecheck` | Passed for the tracked source. |
| `pnpm test` | 858 tests passed in 69 files, including backend, migration, permission, persistence-failure, crash-recovery, backup/restore and model regression coverage. |
| Selected Playwright app tests | 18 passed: core editing, collaboration, session expiry/revocation, and static-server CSP/export behavior. |
| Production frontend build | Passed with `VITE_TEST_HOOKS=0`; the production-hook check passed. Vite still reports a large frontend bundle warning. |
| `node scripts/license-audit.mjs` | Passed after a fresh install. |
| `pnpm audit --prod --json` | No known vulnerabilities reported across 67 production dependencies at review time. |
| SQLite native module | Loaded successfully; bundled SQLite version 3.53.4. |

The browser command was:

```sh
WHITEBOARD_TEST_PORT=3019 pnpm exec playwright test --config playwright.app.config.ts tests/app/core.spec.ts tests/app/collaboration.spec.ts tests/app/session-expiry.spec.ts tests/app/static-server.spec.ts
```

Those browser tests use the repository's instrumented test build; the subsequent
production build was independently checked for test-hook removal. The existing
local service on port 3001 was left untouched. The complete browser suite,
30-minute load workload, remote TLS proxy, Linux host and Node 24 runtime were
not rerun/validated in this assessment.

The original working directory contains an untracked, unfinished
`packages/model/test/person.test.ts` that references an unimplemented `person`
element type and currently fails typechecking. It and the two untracked planning
documents were preserved and excluded from the release snapshot. The original
pnpm store was also missing package metadata for its license check; the clean
install's license check passed. Neither issue required modifying application code.

## Information needed to configure your host

Provide the hosting provider/plan, OS/version and CPU architecture, CPU/RAM and
available SSD capacity, SSH/service-management access, intended domain and DNS
access, existing proxy/container setup, expected simultaneous editors/active
boards, and backup destination/retention preference. If migrating existing data,
identify the current data-directory location; transfer it through the backup
and restore procedure. Do not paste passwords or private keys into this document.
