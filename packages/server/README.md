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
supply a password (at least 12 characters) without printing it. Use
`provision --reset-password <username>` to replace a password and revoke all of
that account's sessions, or `provision --revoke-sessions <username>` to revoke
sessions without changing its password. There is no public
signup or anonymous board access. Account names are unique, case-sensitive,
2–80 Unicode letters/numbers or `_.@-`.

`WHITEBOARD_DATA_DIR` selects the data directory (default `data` relative to the
server package when run through pnpm). It contains `whiteboard.sqlite`, `assets/`,
and a generated mode-0600 `session-secret`. Keep the secret stable across restarts;
`WHITEBOARD_SESSION_SECRET` can supply at least 32 characters instead. `HOST`,
`PORT`, `WHITEBOARD_WEBSOCKET_PATH`, `WHITEBOARD_ORIGINS` (comma separated), and
`WHITEBOARD_SECURE_COOKIES=1` configure deployment. Without static serving,
default browser origins are localhost and 127.0.0.1 on ports 4173, 5173, 5174,
and 3001. With `WHITEBOARD_STATIC_DIR`, defaults include only the loopback server
port (normally 3001). The local deployment helper explicitly sets
`WHITEBOARD_ORIGINS=http://127.0.0.1:3001,http://localhost:3001`. TLS termination
deployments must set their real browser origin and secure cookies.

## HTTP contract

Errors are `{ "error": "message" }`. Session responses are
`{ user: { id, username }, expiresAt }`; `expiresAt` is Unix milliseconds.
The session token lasts 12 hours, is signed, and is checked against SQLite on
every authenticated request and collaboration message. Both sign-in and restored
session JSON omit the token, including responses to Bearer clients. Browsers use
the HttpOnly, SameSite=Lax cookie for HTTP and WebSocket authentication; application
JavaScript does not receive the credential. Explicit non-browser tools can use
the sign-in response's Set-Cookie header, and existing Bearer authentication remains
supported. Do not put tokens in URLs or localStorage.

Board responses use `{ board: { id, title, role, updatedAt } }`, where `role` is
`owner`, `editor`, or `viewer`, and `updatedAt` is Unix milliseconds.

| Method and path | Body / result |
| --- | --- |
| `POST /api/session` | `{username,password}` → session + cookie |
| `GET /api/session` | Current identity and expiry; no token |
| `POST /api/session/logout` | Revokes session and clears cookie; 204 |
| `GET /api/boards` | `{boards: Board[]}`; membership only |
| `POST /api/boards` | `{title}` → 201 `{board}`; caller becomes owner |
| `GET /api/boards/:id` | `{board}` |
| `PATCH /api/boards/:id` | `{title}` → `{board}`; owner/editor |
| `POST /api/boards/:id/members` | `{username,role:'editor'|'viewer'}`; owner only; 204 |
| `DELETE /api/boards/:id/members/:username` | Removes access; owner only; owner membership is protected; 204 |
| `POST /api/boards/:id/assets` | Raw PNG/JPEG/WebP bytes and Content-Type, at most 20 MiB; owner/editor |
| `GET /api/boards/:id/assets/:assetId` | Authenticated image bytes; board membership required |
| `POST /api/boards/:id/assets/copy` | `{sourceBoardId,assetId}`; source read + target edit permission |
| `GET /api/metrics` | Per-board connections, updates/awareness rates, persistence totals/latency, compactions, and storage; membership only |
| `GET /health`, `GET /ready` | Liveness and readiness; readiness becomes 503 during drain or a document persistence failure |

Upload and copy return 201 `{assetId,mimeType,url}`. An asset copy creates a new
board-scoped reference to the same immutable stored bytes. SVG uploads are not
accepted. Cookie-authenticated mutations require an allowed Origin; explicit
Bearer requests support CLI clients without ambient cookies. Browser WebSocket
Origin is checked as well. Unknown boards and boards outside membership both
return 404.

## Collaboration and persistence

Connect to `/collaboration` with the board ID as Hocuspocus document name. Browser
providers send an empty authentication token and the browser supplies the session
cookie; explicit tools may still pass their signed token. Viewers are read-only. Membership
and session revocation are rechecked before each message, including after an
already authenticated session changes. Awareness remains ephemeral.

Browser connections also send `expectedUserId` for the account that owns their
local cache. The server compares this noncredential hint with the authenticated
user before loading or synchronizing the document. If another tab has switched
the cookie to a different account, authentication fails with
`session-identity-changed`; the app stops reconnecting, shows the account change,
and keeps that original account's local work. Explicit tools may omit this hint.

Each Yjs document update is appended to a transactionally committed SQLite log.
Snapshots compact at 5 MiB or 10,000 updates, retaining original client clocks;
the update log is garbage-collected in the same SQLite transaction. Hocuspocus's
SyncStatus acknowledgement means server document application, not a documented
disk-fsync acknowledgement. No client should interpret that protocol response
as a separate durable-commit receipt.

A failed log append, snapshot encode, or compaction is logged with the board ID.
The server stays alive, retains the affected document in memory, marks readiness
503, and resets all its connections with reason `persistence-failed`. For this
reason clients retain their Y.Doc and IndexedDB cache and let the provider
reconnect. Before accepting that reconnect, the server retries saving the full
retained document: replaying an already applied update alone would not trigger
another save. A successful snapshot clears the failure and restores readiness;
an unavailable store keeps the document loaded and refuses synchronization.
Unexpected unhandled promise rejections are logged and begin the normal drain.

Editor document updates, including queued offline edits during initial sync, are
validated on a disposable clone before reaching the live document or log. Invalid
registers, element values, or metadata reset the sender with reason
`invalid-document-update`; the client opens a fresh authoritative replica. Existing
malformed records remain quarantined while healthy edits and repairs are allowed.
Replacing an existing malformed record with different malformed content is rejected.

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
pnpm --filter @whiteboard/server operations prune-element <boardId> <elementId>
```

Backup uses SQLite's online backup API, then copies precisely the immutable
asset files referenced by that database snapshot. It records SHA256 for every
file and includes the mode 0600 session secret. Treat the backup as private user
data and credentials. Restore verifies hashes and SQLite integrity, refuses an
existing destination, and publishes the restored directory atomically. Point
`WHITEBOARD_DATA_DIR` at that fresh directory only while the old server is
stopped. No document/client clock reset occurs.

Run `prune-element` with the server stopped. It removes the specified element's
raw base and field records, writes a higher-clock deletion marker, and saves the
repaired snapshot while preserving unrelated records and Yjs history. This can
repair a malformed element without loading it into the editor. Reconnecting stale
replicas cannot restore the deleted base from their old snapshots.

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

Removing a member or changing a member's role invalidates that user's active board connections. Before
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

Provisioning account controls update the shared SQLite session rows. Existing
sockets observe an operator revocation on their next inbound packet or their
expiry timer; the separate provisioning process cannot proactively notify passive
subscriptions in the running server.

The initial deployment is one process. With multiple owners, an HTTP logout
handled by another process is visible on the next incoming packet or at expiry,
but proactive cross-process subscription invalidation is not implemented.
Multi-owner deployments must add shared revocation notifications before promising
immediate logout across all passive subscriptions.

## Collaboration resource limits

Each process enforces these positive integer settings before accepting an update:

| Environment setting | Default | Accounting |
| --- | ---: | --- |
| `WHITEBOARD_MAX_UPDATE_BYTES` | 4 MiB | Entire WebSocket message, plus an independent decoded document-update byte check |
| `WHITEBOARD_MAX_BOARD_BYTES` | 64 MiB | Stored document snapshot bytes plus uncompacted update-log bytes and the exact newly accepted delta |
| `WHITEBOARD_MAX_INBOUND_BYTES` | 8 MiB | Bytes waiting or processing per authenticated document connection; also at most 256 messages |
| `WHITEBOARD_MAX_BUFFERED_BYTES` | 1 MiB | WebSocket outbound `bufferedAmount` high-water mark |
| `WHITEBOARD_SLOW_SOCKET_GRACE_MS` | 3000 | Time allowed above the outbound high-water mark |
| `WHITEBOARD_MAX_CLOCK_GROWTH` | 1,000,000 | New Yjs logical ticks in one update and maximum unresolved struct/delete span |

WebSocket framing and the document address count toward the transport ceiling, so
an update just below 4 MiB can still exceed the transport limit. Board accounting
excludes assets and SQLite page/WAL overhead. A replay that adds neither structs
nor deletions uses no additional quota. The isolated validator captures the exact
Yjs update that live integration would emit; old deletion history in an offline
retry consumes no additional quota. A capacity refusal discards the proposed
staged state, so the next attempt starts from the saved live document. Compaction frees log capacity while
preserving original clocks. The store also checks append, board creation and
compaction atomically as defense against callers outside the transport.

Updates for each board are serialized through validation, live application and
persistence, preventing concurrent peers from independently passing the same
remaining-capacity check. A bounded walk of pinned Yjs v1 bytes checks safe ranges
before Yjs decodes or integrates them, including compressed GC/deleted spans. It
also limits each packet to 20,000 structs, client groups and deletion ranges,
200,000 encoded values, and 32 nested container levels. Legacy JSON embeds/formats
receive the same depth/value checks. Subdocuments are unsupported. Ordinary
compacted GC, delete-only updates, Unicode, shared types and a full 5,000-stroke
offline state remain compatible with these limits.

A retained isolated validator checks new records and affected projections without
rescanning all unchanged elements. Rejected validation destroys that staged state
and rebuilds it from the live document. Updates with unresolved structs or delete
sets are refused before live application, storage or broadcast; an honest offline
client can retry its complete state after missing dependencies arrive. Validators
are disposed when their live documents are destroyed and at shutdown.

Capacity refusal sends `{ "type": "board-full", "boardId": "…", "reason":
"board-full", "retryable": true, "maxBytes": 67108864 }`. Other resource refusals
send `type: "sync-rejected"` with reason `update-too-large` (not retryable),
`inbound-overload` (retryable), or `incomplete-update` (retryable), and `maxBytes`
when applicable. The document closes with code 4409 and that reason; a transport
payload violation closes the WebSocket with code 1009. These refusals leave
readiness healthy and preserve the client's local document/cache for export or
explicit recovery. They do not report a storage failure. Unsafe structural ranges
use the existing `invalid-document-update` authoritative-reset protocol.

Above the outbound high-water mark, stale awareness messages are dropped. Document
updates are also skipped to prevent further queue growth; if one was skipped, the
socket is terminated after the grace period even if it later drains, forcing a
fresh synchronization. A socket that remains above the mark is terminated too.
These network reconnects preserve the local cache. Control notices remain small
and can pass through while the grace timer is active.
