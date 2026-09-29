# Whiteboard server

The private single-node server uses Hocuspocus 4.7.0, signed revocable sessions,
board membership, SQLite WAL persistence, and disk image storage. It listens on
`127.0.0.1:3001`; the app proxies `/api` and `/collaboration` to it.

From the repository root:

```sh
pnpm --filter @whiteboard/server provision alice
pnpm server
```

Provisioning prints a generated password once. Set `WHITEBOARD_PASSWORD` to
supply a password (at least 12 characters) without printing it. There is no public
signup or anonymous board access. Account names are unique, case-sensitive,
2–80 Unicode letters/numbers or `_.@-`.

`WHITEBOARD_DATA_DIR` selects the data directory (default `data` relative to the
server package when run through pnpm). It contains `whiteboard.sqlite`, `assets/`,
and a generated mode-0600 `session-secret`. Keep the secret stable across restarts;
`WHITEBOARD_SESSION_SECRET` can supply at least 32 characters instead. `HOST`,
`PORT`, `WHITEBOARD_WEBSOCKET_PATH`, `WHITEBOARD_ORIGINS` (comma separated), and
`WHITEBOARD_SECURE_COOKIES=1` configure deployment. Default browser origins are
localhost and 127.0.0.1 on ports 4173, 5173, 5174, and 3001. TLS termination deployments must
set the real browser origin and secure cookies.

## HTTP contract

Errors are `{ "error": "message" }`. Session responses are
`{ user: { id, username }, token, expiresAt }`; `expiresAt` is Unix milliseconds.
The session token lasts 12 hours, is signed, and is checked against SQLite on
every authenticated request and collaboration message. Browsers retain only
the HttpOnly, SameSite=Lax cookie; the returned token is for the provider's
in-memory authentication. Do not put tokens in URLs or localStorage.

Board responses use `{ board: { id, title, role, updatedAt } }`, where `role` is
`owner`, `editor`, or `viewer`, and `updatedAt` is Unix milliseconds.

| Method and path | Body / result |
| --- | --- |
| `POST /api/session` | `{username,password}` → session + cookie |
| `GET /api/session` | Current session; restores a provider token after reload |
| `POST /api/session/logout` | Revokes session and clears cookie; 204 |
| `GET /api/boards` | `{boards: Board[]}`; membership only |
| `POST /api/boards` | `{title}` → 201 `{board}`; caller becomes owner |
| `GET /api/boards/:id` | `{board}` |
| `PATCH /api/boards/:id` | `{title}` → `{board}`; owner/editor |
| `POST /api/boards/:id/members` | `{username,role:'editor'|'viewer'}`; owner only; 204 |
| `POST /api/boards/:id/assets` | Raw PNG/JPEG/WebP bytes and Content-Type, at most 20 MiB; owner/editor |
| `GET /api/boards/:id/assets/:assetId` | Authenticated image bytes; board membership required |
| `POST /api/boards/:id/assets/copy` | `{sourceBoardId,assetId}`; source read + target edit permission |
| `GET /api/metrics` | Per-board connections, updates/awareness rates, persistence totals/latency, compactions, and storage; membership only |
| `GET /health`, `GET /ready` | Liveness and readiness; readiness becomes 503 during drain |

Upload and copy return 201 `{assetId,mimeType,url}`. An asset copy creates a new
board-scoped reference to the same immutable stored bytes. SVG uploads are not
accepted. Cookie-authenticated mutations require an allowed Origin; explicit
Bearer requests support CLI clients without ambient cookies. Browser WebSocket
Origin is checked as well. Unknown boards and boards outside membership both
return 404.

## Collaboration and persistence

Connect to `/collaboration` with the board ID as Hocuspocus document name and the
session token as its authentication token. Viewers are read-only. Membership
and session revocation are rechecked before each message, including after an
already authenticated session changes. Awareness remains ephemeral.

Each Yjs document update is appended to a transactionally committed SQLite log.
Snapshots compact at 5 MiB or 10,000 updates, retaining original client clocks;
the update log is garbage-collected in the same SQLite transaction. Hocuspocus's
SyncStatus acknowledgement means server document application, not a documented
disk-fsync acknowledgement. No client should interpret that protocol response
as a separate durable-commit receipt.

`src/spike.ts` is the failed original Phase 0 nested-map transport benchmark;
`src/spike-writer-kv.ts` is the replacement in-memory candidate. Neither is a
production authentication or persistence implementation. See
`../../docs/S3_LOAD_REPORT.md` for final measured acceptance, preserved failures and scope limits.

## Routing, drain, and backup operations

`pnpm --filter @whiteboard/server router` starts the router on port 3000 and
forwards to the single authoritative local shard at 3001. `WHITEBOARD_SHARDS`
accepts JSON `[{"id":"local","url":"http://127.0.0.1:3001"}]`; `ROUTER_PORT`
changes the listener. Board API paths are routed by board ID. WebSocket URLs can
carry `?boardId=<uuid>` (no token in the URL); a routing key is mandatory with
multiple shards, and the server rejects document names that differ from it.
Rendezvous hashing gives stable ownership. An unhealthy owner yields 503; the
router never silently assigns a second owner. Add/remove shards only after
coordinated draining and reconnecting affected boards. Initial deployment is
one shard. Multiple same-host processes must share the configured SQLite/data
store; multi-host sharding needs shared transactional persistence before use.

SIGTERM/SIGINT make readiness false, reject new sessions and HTTP mutations,
leave existing collaboration sockets active for `WHITEBOARD_DRAIN_MS` (default
5000 ms), then close sockets and finish Hocuspocus store hooks. Clients retain their
Y.Doc and reconnect to resubmit unacknowledged edits. Stop admission at the proxy
before draining an owner; drain alone does not transfer its ownership.

```sh
pnpm --filter @whiteboard/server operations backup /absolute/new-backup-directory
pnpm --filter @whiteboard/server operations restore /absolute/backup /absolute/new-data-directory
```

Backup uses SQLite's online backup API, then copies precisely the immutable
asset files referenced by that database snapshot. It records SHA256 for every
file and includes the mode 0600 session secret. Treat the backup as private user
data and credentials. Restore verifies hashes and SQLite integrity, refuses an
existing destination, and publishes the restored directory atomically. Point
`WHITEBOARD_DATA_DIR` at that fresh directory only while the old server is
stopped. No document/client clock reset occurs.

`pnpm --filter @whiteboard/loadtest history` generates 100,000 schema2 updates,
compacts at the production thresholds, times reload plus full projection, and
performs a database+asset restore drill. Raw results stay in loadtest/results.
`pnpm loadtest` runs the full 40-client, 30-minute production-server S3 workload.
The production harness includes signed-token ACL checks on every packet, SQLite
WAL synchronous FULL persistence/compaction, and a final persisted-state hash.

## Serve the built app on this Mac

Set `WHITEBOARD_STATIC_DIR` to the absolute `packages/app/dist` directory after
building the app. Static serving is otherwise disabled, including in load tests.
The production server then serves the app, private API and `/collaboration` from
one origin. Both `http://localhost:3001` and `http://127.0.0.1:3001` are allowed by
default. For example, from the repository root:

```sh
pnpm build
WHITEBOARD_DATA_DIR=/absolute/private-data WHITEBOARD_PASSWORD=your-supplied-password pnpm --filter @whiteboard/server provision owner
WHITEBOARD_DATA_DIR=/absolute/private-data WHITEBOARD_STATIC_DIR=/absolute/threejs-whiteboard/packages/app/dist pnpm server
```

A supplied password is never printed; omit it to generate and print a new one
once. Keep account provisioning separate from normal startup. Root `/` and
`/board/:id` return the SPA index; missing bundle/font paths return404. HTML uses
`no-cache`, hashed Vite assets use an immutable one-year cache, and fonts use
correct font MIME types with a one-hour cache. ETags support revalidation; HEAD
requests return headers only. Decoded traversal, dotfiles, and symlinks escaping
the configured root are rejected. API, health, readiness and WebSocket routes
retain their own handlers. SIGTERM/SIGINT perform the readiness/drain sequence
above; there is no dependency on Vite preview for this deployment mode.

Sign-in throttling allows up to120 attempts per source address per minute, with
at most5 failed password attempts per account+address per minute. A successful
sign-in clears that account's failure counter. This accommodates40 distinct
accounts behind a shared office address without removing the aggregate ceiling.
These limits use the actual peer address; untrusted forwarded-IP headers are
not used. A deployment behind a shared reverse proxy should account for that
proxy's address when sizing the aggregate limit.

## Live permission changes

Changing a member's role invalidates that user's active board connections. Before
closing the document connection, the server sends a Hocuspocus stateless JSON
message: `{ "type": "permission-changed", "boardId": "…", "role": "viewer",
"resetRequired": true, "reason": "permissions-changed" }`. The role can be
`editor`, `viewer`, or `null` when access/session validation fails. The Hocuspocus
close reason is `permissions-changed`.

Clients must immediately disable editing, disconnect, discard that board's
local Y.Doc and IndexedDB cache, and reopen from authoritative storage with a new
replica. Re-authenticating the old replica preserves rejected local edits, which
could otherwise replay after a later role upgrade. A dirty readonly SyncStep2
or document update receives the same reset message with reason
`read-only-write-rejected`; this covers offline editor changes upon viewer
reconnection. The server rejects these packets before applying or persisting them.
Hocuspocus's negative SyncStatus alone does not provide this application behavior.

HTTP logout immediately invalidates all live connections carrying that exact
signed session token in this process. Other sessions for the same account stay
valid. Each connection also has one unref'ed expiry timer derived from its
authenticated signed `expiresAt`; it is cleared on disconnect. Passive sockets
therefore stop receiving updates at expiry without waiting for another inbound
packet. These events use `role: null` with reason `session-revoked` or
`session-expired` and the same authoritative-reset protocol.

The initial deployment is one process. With multiple owners, an HTTP logout
handled by another process is visible on the next incoming packet or at expiry,
but proactive cross-process subscription invalidation is not implemented.
Multi-owner deployments must add shared revocation notifications before promising
immediate logout across all passive subscriptions.
