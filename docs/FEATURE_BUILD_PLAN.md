# Feature build plan: text in shapes, Excalidraw import, Google sign-in, people on the board

Written 2026-09-30 against commit `fed369b`. This plan is for an AI agent to implement. It is grounded in the current code; every file reference was checked. Read "Working rules" and "Order and prerequisites" before starting any feature.

## Working rules for the implementing agent

- Implement the features in the order given. Each later feature depends on the earlier ones.
- Finish `docs/REVIEW_FINDINGS.md` Tier 1 items 1, 2, 3, 4 and Tier 2 item 10 first. The reasons are listed under "Order and prerequisites". Do not skip this.
- Establish a green baseline before each feature: `pnpm typecheck`, `pnpm test`. After each step: the same, plus the browser suite that covers the feature (`pnpm test:app`, which needs port 3001 free; stop the local deployment with `launchctl bootout gui/$(id -u)/com.threejs-whiteboard.local` first).
- One commit per numbered step. Reference the feature and step in the commit message (for example `F1.3`).
- The document model is the contract. Every model change goes through `assertValidElement` in `packages/model/src/schema.ts`, gets a unit test in `packages/model/test`, and is added to the fuzz generator in `packages/model/test/fuzz.test.ts` so convergence is checked with the new shapes.
- Keep `SCHEMA_VERSION` at 2 (`packages/model/src/document.ts:26`). All changes below are additive and backward compatible with existing schema-2 boards: an existing board must open unchanged after every step. Bumping the schema would make every existing board unopenable (`document.ts:96` rejects other versions).
- No new dependency without a note in `docs/DEPENDENCY_VERIFICATION.md` (license, version, why). The license audit allowlist must accept it.
- Keep README.md and `packages/server/README.md` truthful in the same commit as the behaviour change.
- Never commit secrets. Google client credentials go in environment variables or the private data directory, never in the repo.
- Do not touch `docs/benchmarks`, `packages/loadtest/results`, or `packages/model/reports`.

## Order and prerequisites

| Feature | Depends on | Why |
|---|---|---|
| F1 Text inside shapes | REVIEW_FINDINGS item 2 (quarantine invalid records) | During rollout, an old client that has not reloaded will see shape records with non-empty `props` and, today, would throw forever on `readAll`. With item 2 fixed it skips them until reload. |
| F2 Excalidraw import | F1 (bound text), REVIEW_FINDINGS item 10 (image header parsing), item 3 (update size cap) | Imported text bound to shapes needs F1. Imported files carry arbitrary images and can be large. |
| F3 Google sign-in | REVIEW_FINDINGS item 1 (server crash), item 4 (CORS origins and token exposure) | Do not add a second credential path while the token is still returned to any allowed origin. |
| F4 People on the board | F3 (display names and avatars), REVIEW_FINDINGS item 9 (member removal, member listing) | Person elements reference users; the board needs a member list route and revocation before it advertises people. |

Estimated size: F1 about 2 days, F2 about 3 days, F3 about 2 days, F4 about 3 days for an agent, including tests.

---

## F1. Text inside shapes

### Goal

A rectangle or ellipse can carry a text block, edited with the same native editor as sticky notes, laid out inside the shape with padding, vertically centred by default, exported identically to PNG, SVG and PDF, and following the shape when it moves, resizes or rotates. Sticky notes stay as they are.

### Current state

- `packages/model/src/types.ts:17-19`: `rect` and `ellipse` props are `Record<string, never>`; `schema.ts:55` enforces "shape props must be empty".
- Sticky notes already do everything needed: `TextProps` (`text`, `align`, `autoSize`), layout via `textLayout` in `packages/model/src/text-layout.ts:186` with `STICKY_TEXT_INSET = 12`, rendering in `packages/renderer/src/index.ts:317-364` (`createText`, gated on `type === 'text' || type === 'sticky'`), SVG in `packages/model/src/svg.ts:27-40`, editing in `packages/app/src/text-editor.ts` (`TextElement` is `text | sticky`), double-click to edit in `packages/app/src/controller.ts:269-272`, and the text index in `renderer/src/index.ts:178`.
- Sticky text is top-aligned; there is no vertical alignment anywhere.

### Design

Extend, do not fork. Shape props become "empty or a text block":

```ts
// types.ts
export interface ShapeTextProps extends TextProps { verticalAlign: 'top' | 'middle' | 'bottom' }
export interface PropsByType {
  rect: Record<string, never> | ShapeTextProps;
  ellipse: Record<string, never> | ShapeTextProps;
  ...
}
```

`autoSize` is always `false` for shape text (the shape owns its box; text wraps inside). Introduce one helper used everywhere instead of the scattered `type === 'text' || type === 'sticky'` checks:

```ts
// text-layout.ts
export function textBlock(element: Element): (TextProps & { verticalAlign: 'top'|'middle'|'bottom'; inset: number }) | null
```

returning the block for `text` (inset 0, top), `sticky` (inset 12, top), and `rect`/`ellipse` with non-empty props (inset 12 for rect, and for ellipse an inset that keeps the text box inside the inscribed rectangle: `w * (1 - 1/√2) / 2` horizontally and the same for height, minimum 12), or `null`.

### Steps

**F1.1 Model.** Extend `PropsByType`, add `ShapeTextProps`, add `textBlock()`. In `assertValidElement`, for `rect`/`ellipse` accept either `{}` or a valid text block with `autoSize === false` and a valid `verticalAlign`. Extend `textLayout` to take the vertical alignment into account: compute the total line height (`lines.length * fontSize * TEXT_LINE_HEIGHT`) and offset `y` by `(innerHeight - total) / 2` or `innerHeight - total`. Keep sticky and text results byte-identical (add a regression test that snapshots current layouts before you change anything). Add `createElement` defaults: shapes still default to `{}`. Add `setShapeText(id, text)` on `BoardDocument` that patches props to the block form (empty text removes the block back to `{}` so an empty shape is still the canonical empty shape). Unit tests: validation of all accepted and rejected forms, layout for the three vertical alignments, ellipse inset, round-trip through `elementToYMap`/`readElement`, fuzz generator extended with shape text.

**F1.2 Renderer.** Replace the two `type` checks at `packages/renderer/src/index.ts:178` and `:317` with `textBlock(element) !== null`. In `createText` (`:330-364`) use the block's inset and the layout's vertical offset. Ensure the text mesh renders above the shape fill: shape batches and text use `renderOrder`/depth from `rank`; text must use the shape's own rank plus a small epsilon so it never z-fights with the fill or gets covered by the next shape. Check `packages/renderer/src/index.ts:134` for how depth is computed and reuse the same mapping the sticky path uses. Browser test in `tests/app/text-layout.spec.ts`: a rect with centred text renders the glyphs inside the rect bounds on both the live canvas and the PNG export (pixel probe at the rect centre is text colour, probe at the inset margin is fill colour).

**F1.3 SVG and PDF.** In `packages/model/src/svg.ts:27-40, 60-62`, emit the `<text>` block after the rect or ellipse using `textBlock()` and the vertical offset. PDF goes through the same SVG (`packages/app/src/export.ts`), so it inherits the change; extend `collectExportFonts` to scan shape text so the font coverage check sees it (it currently walks `text | sticky` only; grep for the type checks in `export.ts`). Test: `tests/app/export.spec.ts` compares the SVG text position with the PNG glyph position for a centred shape label, the same way it already does for stickies.

**F1.4 Editing.** In `packages/app/src/text-editor.ts`, widen `TextElement` to any element with a `textBlock`, use the block's inset and vertical alignment for the overlay position (`:92-106`), and commit through `setShapeText`. In `packages/app/src/controller.ts:269-272` (double-click) and `:121-123` (text tool click on an existing element), open the editor for a rect or ellipse too. A shape with an empty block shows a placeholder only while editing. Escape and blur behave exactly as for stickies. Add `verticalAlign` and `align` controls to the style panel in `packages/app/src/App.tsx` (they appear when the selection contains a shape with text or a sticky). Keyboard: pressing Enter with a single shape selected starts editing it (the same shortcut Excalidraw and tldraw use). Browser test in `tests/app/text.spec.ts`: double-click a rect, type, commit, reload, the text persists; IME composition inside a shape works like the existing sticky case; one undo step per edit.

**F1.5 Hit testing, selection, clipboard.** No change to hit testing (the shape's box is the target). `packages/app/src/clipboard-model.ts` validates through `assertValidElement`, so shape text pastes without change; add a unit test. Update `README.md` "Editing and export" to say shapes carry text and double-click edits it.

### Acceptance

- A rect or ellipse with text renders identically in the canvas, PNG at 1x and 2x, SVG and PDF, within the existing tolerances used for stickies.
- Existing boards open unchanged; `pnpm test` fuzz converges with shape text in the generator.
- `pnpm typecheck`, `pnpm test`, `pnpm test:app` green.

### Decisions already made (change only with a reason)

- No schema bump. Empty text collapses back to `{}`.
- Ellipse text is laid out in the inscribed rectangle, not the bounding box.
- Diamond and other new shape types are out of scope; F2 maps Excalidraw diamonds to rectangles.

---

## F2. Import .excalidraw documents

### Goal

Open an existing `.excalidraw` file (and the same JSON pasted from the Excalidraw clipboard) into the current board as native elements, with images uploaded to the board's private asset store, preserving position, size, rotation, z-order, colours, text, bound text inside shapes, and arrow bindings. Lossy conversions are reported to the user in one summary, not silently dropped.

### Excalidraw format (what the importer must handle)

A `.excalidraw` file is JSON: `{ type: "excalidraw", version: 2, source, elements: [...], appState, files: { [fileId]: { mimeType, id, dataURL, created } } }`. The clipboard form is `{ type: "excalidraw/clipboard", elements, files }`. Element fields common to all: `id`, `type`, `x`, `y`, `width`, `height`, `angle` (radians), `strokeColor`, `backgroundColor` (`"transparent"` is common), `fillStyle` (`hachure` | `cross-hatch` | `solid` | `zigzag`), `strokeWidth`, `strokeStyle` (`solid` | `dashed` | `dotted`), `roughness`, `opacity` (0-100), `groupIds`, `frameId`, `roundness`, `isDeleted`, `boundElements` (`[{ id, type: 'text' | 'arrow' }]`), `link`, `locked`, `version`, `versionNonce`, `seed`. Per type:

| Excalidraw type | Fields | Maps to |
|---|---|---|
| `rectangle` | above | `rect` |
| `ellipse` | above | `ellipse` |
| `diamond` | above | `rect` (lossy; reported) |
| `text` | `text`, `fontSize`, `fontFamily` (number), `textAlign`, `verticalAlign`, `containerId`, `originalText`, `lineHeight` | `text` when `containerId` is null; otherwise merged into the container shape as its text block (F1) |
| `freedraw` | `points: [[x,y],...]` relative to `x,y`, `pressures: number[]`, `simulatePressure` | `stroke` with `[x, y, pressure]` triples; pressure 0.5 when `pressures` is empty |
| `line` | `points`, `startBinding`/`endBinding` (usually null) | `stroke` with pressure 0.5 (lossy for curved/rounded lines; reported) |
| `arrow` | `points`, `startBinding: { elementId, focus, gap }`, `endBinding`, `startArrowhead`, `endArrowhead`, `elbowed` | `connector`, `kind: 'elbow'` when `elbowed`, else `'straight'` for 2 points and `'curve'` for more |
| `image` | `fileId`, `scale`, `status` | `image` after uploading `files[fileId]` |
| `frame`, `magicframe` | `name` | `rect` with transparent fill and the name as text (reported) |
| `embeddable`, `iframe` | `link` | skipped, reported |

Font family numbers: 1 Virgil/Excalifont (hand-drawn), 2 Helvetica, 3 Cascadia (mono), 5 Excalifont, 6 Nunito, 7 Lilita One, 8 Comic Shanns. Map 3 to `IBM Plex Mono`, everything else to `Inter`, and report hand-drawn fonts as substituted.

Excalidraw `strokeWidth` is 1, 2 or 4 in its units; keep the number. `opacity` divides by 100. `backgroundColor: "transparent"` needs a transparent fill in this model, which does not exist yet (see F2.1).

Bindings: Excalidraw's `focus` (-1..1 along the shape's edge) and `gap` do not map to this model's `nx, ny` (0..1 normalized point on the target box). Compute the arrow endpoint in absolute coordinates, project it onto the target's box to get `nx, ny` (clamp 0..1), and set `fallback` to the absolute point. Elbow arrows whose target is missing become point-bound.

### Steps

**F2.1 Transparent fills.** The model has no transparent fill (`fill` is any string; renderer and SVG always paint it). Add support for `fill: 'none'`: `packages/renderer/src/shapes.ts` skips or zero-alphas the fill instance while keeping the stroke, `packages/model/src/svg.ts` emits `fill="none"`, the hit test keeps the box as the target (Excalidraw hit-tests the stroke only for transparent shapes; this model keeps the box, which is simpler and what stickies do). Add a "No fill" swatch to the style panel. Test in `tests/app/export.spec.ts`: a rect with `fill: 'none'` over a coloured rect shows the lower colour at its centre in PNG and SVG.

**F2.2 Pure converter in the model package.** New file `packages/model/src/excalidraw.ts` exporting:

```ts
export interface ExcalidrawImport {
  elements: Element[];                      // valid, geometry derived, fresh ids, fractional indexes in source z-order
  images: { elementId: string; mimeType: string; bytes: Uint8Array; naturalW: number; naturalH: number }[];
  report: { imported: number; skipped: { id: string; type: string; reason: string }[]; substituted: string[] };
}
export function importExcalidraw(json: unknown, options: { newId(): string; firstIndex: string | null; maxElements?: number }): ExcalidrawImport
```

Rules: reject anything that is not `type: "excalidraw"` or `"excalidraw/clipboard"`; skip `isDeleted`; cap at `MAX_CLIPBOARD_ELEMENTS` (10,000, reuse from `clipboard-model.ts`) and a 50 MiB source size; decode `dataURL` base64 to bytes and read dimensions with the header parser from REVIEW_FINDINGS item 10 (reject SVG and GIF data URLs, report them); keep original coordinates (the app decides whether to offset); allocate indexes with `generateNKeysBetween(firstIndex, null, n)` from `fractional-indexing` in array order; resolve `containerId` text into the container's text block (F1) with `verticalAlign` mapped; resolve arrow bindings as described; validate every output element with `assertValidElement`; never throw on a single bad element, skip it and report. Unit tests in `packages/model/test/excalidraw.test.ts` with fixture files under `packages/model/test/fixtures/`: a hand-made minimal document covering every type, a real export from the Excalidraw app (make one with rectangle + bound text, arrow between two shapes, freedraw, an embedded PNG, a diamond, a frame), an `excalidraw/clipboard` payload, a file with `isDeleted` elements, a file with a missing `files` entry, a malformed file.

**F2.3 App glue.** In `packages/app/src/assets.ts` (which already owns file drop, paste and upload) add `importExcalidrawFile(file: File)`: parse, call the converter, upload each image through `api.uploadAsset` (sequentially, the same way image drops do at `assets.ts:96-104`), set `props.assetId` on the corresponding image elements, then insert all elements in one `board.transact` so the import is one undo step. Offset the imported bounds so their top-left lands at the current viewport's top-left plus 40 px only when the imported bounds do not intersect the current viewport; otherwise keep original coordinates. Select the imported elements and `zoomToFit` them. Show the report in a dismissible notice (count imported, count skipped with reasons, fonts substituted). Entry points: the existing "Add images" file input gains `.excalidraw,application/json` in `accept`; dropping a `.excalidraw` file on the canvas; pasting Excalidraw clipboard JSON (detect `type: "excalidraw/clipboard"` in the paste handler before the whiteboard envelope check at `clipboard-model.ts:28`). Read-only users get the existing read-only message.

**F2.4 Limits and safety.** Enforce the source size cap before parsing. Images go through the same server checks as drops (magic bytes, 20 MiB, header dimensions). Total import is rejected up front if more than 10,000 elements or more than 100 images; say so. Because the whole import is one Yjs transaction, confirm it stays under the update size cap from REVIEW_FINDINGS item 3; if a file would exceed it, split the insert into batches of 500 elements, each its own transaction, and document that undo then takes several steps.

**F2.5 Tests and docs.** Browser test `tests/app/import.spec.ts`: import the real fixture through the file input, assert element count, that the bound text sits inside its rect, that the arrow follows its target when the target is moved, that the image renders, and that reload persists everything. README: add "Import from Excalidraw" with the supported and lossy mappings table.

### Acceptance

- The real fixture imports with zero skipped elements except the ones the table calls lossy, and the report lists exactly those.
- Import is one undo step (or documented batches).
- Existing boards and clipboard behaviour unchanged.

### Decisions already made

- Import merges into the current board; it does not create a new board. A "New board from file" button on the boards page can call the same code after creating a board, and is optional.
- Groups are not imported (the model has no groups). Report the count of groups dropped.
- Hand-drawn stroke style (`roughness`) and hatched fills are dropped; the report says so once.
- Excalidraw ids are not preserved; a second import of the same file creates duplicates. This matches paste semantics.

---

## F3. Google sign-in

### Goal

Users can sign in with a Google account in addition to the operator-provisioned password accounts. The operator controls who may sign in (allowed domains and/or allowed e-mail addresses). A Google user's display name and profile picture become part of their account and are used in presence labels and in F4. Existing password accounts keep working. No public registration.

### Current state

- Accounts: `packages/server/src/store.ts:22` `users(id, username UNIQUE, password_hash NOT NULL)`; `createUser` at `:32`; `login` at `:39-47` creates a session row and signs the token; `authenticate` at `:55-66`.
- Routes: `packages/server/src/server.ts:77` `POST /api/session` (password), `:94` `GET /api/session`, `:95` logout. Cookie attributes at `:43`. Origin allowlist at `:21, 66-76`.
- Client: `packages/app/src/api.ts` `User` already has optional `name` and `color`; `packages/app/src/account.tsx` `SignIn` form; presence uses `session.user.name ?? username` (`collaboration.ts:63`).
- Config: `packages/server/src/config.ts` reads env; deploy writes the launch agent env in `scripts/deploy-local.ts:109`.
- Provisioning: `packages/server/src/provision.ts`.

### Design

Server-side OpenID Connect authorization-code flow with PKCE. No new runtime dependency: the token exchange is a `fetch` to Google's token endpoint over TLS with the client secret, and OpenID Connect Core 3.1.3.7 permits skipping the ID token signature check when the token was received directly from the token endpoint over TLS, provided `iss`, `aud`, `exp`, and `nonce` are validated. Do validate all four. If you prefer signature verification anyway, use `jose` (MIT) with Google's JWKS and add it to `docs/DEPENDENCY_VERIFICATION.md`.

Account linking: a new `identities` table maps `(provider, subject)` to a user. On first Google sign-in with an allowed e-mail, create a user whose `username` is the e-mail address and whose `password_hash` is NULL. If a password user with that username already exists, link the identity to it (the operator provisioned the same address on purpose). Password login must reject NULL-hash users with the same timing as a wrong password (run the dummy scrypt).

Profile picture: fetch the `picture` URL server-side at sign-in, validate it is `image/png` or `image/jpeg` under 2 MiB, store it in the assets directory under a random key, and record it on the user. Serve it at `GET /api/users/:id/avatar` to any authenticated user. Never hotlink Google's URL from the client (privacy, CSP, URL expiry). Refresh it when a sign-in sees a different `picture` URL or the stored copy is older than 7 days.

### Steps

**F3.1 Store migration.** Add `PRAGMA user_version`. Migration 1 (run once, in a transaction): rebuild `users` with `password_hash TEXT NULL`, add `display_name TEXT`, `avatar_key TEXT`, `avatar_updated_at INTEGER`; create `identities(provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), email TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(provider, subject))`; create `oauth_states(state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_path TEXT NOT NULL, expires_at INTEGER NOT NULL)`. Add store methods: `createSession(userId)` (extracted from `login`), `userByIdentity(provider, subject)`, `linkIdentity(...)`, `createExternalUser(username, displayName)`, `setAvatar(userId, key)`, `userProfile(userId)`. Backup/restore (`operations.ts`) already copies the whole database and assets directory, so avatars ride along; add a test that a restored backup still serves the avatar. Unit tests for the migration on a database created by the current schema.

**F3.2 Config.** In `config.ts`: `WHITEBOARD_GOOGLE_CLIENT_ID`, `WHITEBOARD_GOOGLE_CLIENT_SECRET` (or `WHITEBOARD_GOOGLE_CLIENT_SECRET_FILE` pointing into the data directory, mode 0600, preferred for the launch agent), `WHITEBOARD_PUBLIC_URL` (the origin users see, used to build the redirect URI `${PUBLIC_URL}/api/auth/google/callback`), `WHITEBOARD_GOOGLE_ALLOWED_DOMAINS` (comma list matched against the `hd` claim and the e-mail domain), `WHITEBOARD_GOOGLE_ALLOWED_EMAILS` (comma list). Google sign-in is enabled only when client id, secret and public URL are all set, and at least one allowlist is non-empty; otherwise the routes return 404 and the button is hidden. `GET /api/config` (unauthenticated, no secrets) returns `{ googleSignIn: boolean }` so the client can show the button.

**F3.3 Routes.** In `server.ts`:
- `GET /api/auth/google/start?return=/board/x`: validate `return` is a same-origin absolute path (starts with `/`, no `//`, no scheme), generate `state` (32 random bytes), `nonce`, PKCE `code_verifier` and S256 challenge, store them in `oauth_states` with a 10-minute expiry, and 302 to `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`, `response_type=code`, `scope=openid email profile`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, `prompt=select_account`, and `hd` when exactly one domain is allowed. This is a top-level navigation, so the Origin check does not apply; it must not require a session.
- `GET /api/auth/google/callback?code&state`: look up and delete the state row (single use; expired is 400); POST to `https://oauth2.googleapis.com/token` with `code`, `client_id`, `client_secret`, `redirect_uri`, `grant_type=authorization_code`, `code_verifier`; parse `id_token` (base64url JSON, no library); verify `iss` is `https://accounts.google.com` or `accounts.google.com`, `aud` equals the client id, `exp` in the future, `nonce` matches, `email_verified === true`; apply the allowlists (`hd` or e-mail domain, or exact e-mail); find or create the user and link the identity; fetch and store the avatar (best effort, failures only logged); `createSession`; set the same cookie as password login (`server.ts:43`); 302 to the return path. Any failure renders a small HTML page with a plain message and a link back to `/`, never the raw error. Apply the existing per-address login throttle to both routes.
- `GET /api/session` response gains `user.name` (display name) and `user.avatarUrl` (`/api/users/:id/avatar` or null). Keep the token removal from REVIEW_FINDINGS item 4.
- `GET /api/users/:id/avatar`: authenticated; 404 when none; `Cache-Control: private, max-age=3600`; `X-Content-Type-Options: nosniff`.
- `POST /api/session` (password): when the user row has a NULL hash, run the dummy scrypt and return 401 like a wrong password.
- Logout is unchanged (it deletes the session row; Google tokens are never stored).

**F3.4 Client.** `api.ts`: add `config()`, extend `User` with `avatarUrl`. `account.tsx`: below the password form show "Continue with Google" (a plain link to `/api/auth/google/start?return=<current path>`), only when `config.googleSignIn` is true; on return the existing `api.session()` bootstrap picks up the cookie. Presence: `collaboration.ts:63` already prefers `name`; nothing else to do. Show the avatar in the account header next to Sign out.

**F3.5 Provisioning and operations.** `provision.ts`: add `--google <email>` to pre-create an external user (NULL hash) so an operator can share a board with someone before their first sign-in; the identity links on first sign-in by e-mail match. Document the Google Cloud console steps in `packages/server/README.md`: create an OAuth client of type Web application, add `${PUBLIC_URL}/api/auth/google/callback` as an authorized redirect URI (Google accepts `http://localhost:3001/...` and `http://127.0.0.1:3001/...` for local use), set the OAuth consent screen to Internal for a Workspace domain or External with the allowlist for personal accounts, and put the secret in the data directory file. `scripts/deploy-local.ts:109` passes the new env through the launch agent and never prints the secret.

**F3.6 Tests.** `packages/server/src/server.test.ts`: run a fake Google in-process (an `http` server on port 0 that serves `/token` returning a crafted `id_token`) and point the server at it through a `WHITEBOARD_GOOGLE_ISSUER_OVERRIDE` env that is only honoured when `NODE_ENV === 'test'`; test the happy path, a bad `state`, a replayed `state`, a wrong `nonce`, a wrong `aud`, an expired token, an unverified e-mail, a disallowed domain, account linking to an existing password user, avatar fetch failure not blocking sign-in, and that a NULL-hash user cannot password-login. Browser test in `tests/app/collaboration.spec.ts`: the presence label shows the display name. Add the fake Google to `scripts/app-test-server.ts` so `pnpm test:app` can exercise the button.

### Acceptance

- With Google configured, a user on an allowed domain signs in, lands back on the board they started from, sees their name in presence, and their avatar in the header. A user outside the allowlist sees a clear refusal and no account is created.
- With Google not configured, nothing changes in the UI and the routes are 404.
- Backup and restore preserve identities and avatars.
- No token, secret or Google URL appears in logs or in any API response.

### Decisions already made

- No refresh tokens, no offline access, no Google API calls after sign-in except the one avatar fetch. Sessions remain the existing 12-hour signed sessions.
- Usernames for Google users are their e-mail addresses; the display name is shown everywhere a name is shown.
- Sign-in with Google is gated by an allowlist, consistent with "no public registration".

---

## F4. People on the board

### Goal

Board members can be placed on the whiteboard as first-class elements: a chip showing the person's avatar (from F3, or coloured initials for password accounts) and name. People can be tagged onto other elements, mentioned in text with `@`, and connected with connectors like any shape. Exports render them.

### Current state

- No `GET` members route; membership is written at `server.ts:114-126` only. Store has `role()` and `setMember`.
- Presence already carries `userId`, `name`, `color` (`collaboration.ts:8-11`), and `colorFor(id)` gives a stable colour per user (`:21-25`).
- Images are the only element that references external bytes, through `resolveAsset(assetId)` (`runtime.ts:13`, `renderer/src/images.ts:84-85`, `export.ts:111-113`).
- Connectors bind to any non-connector element (`geometry.ts:38`).

### Design

One new element type:

```ts
export interface PersonProps { userId: string; name: string; initials: string; hasAvatar: boolean; taggedElementId: string | null }
export interface PropsByType { ...; person: PersonProps }
```

- `name`, `initials` and `hasAvatar` are copied into the element at placement time so the board renders offline and after the user leaves; a background refresh updates them when the member list changes.
- `taggedElementId` links the chip to another element. When set, the chip is positioned relative to the tagged element's top-right corner and moves with it (like a bound connector endpoint), and deleting the tagged element deletes its tags. When null, the chip is free-standing.
- Default size 40 by 40 for an avatar-only chip; 40 high and `textSize(name) + 56` wide for a chip with the name. Rotation follows the tagged element.
- Avatar bytes come from `/api/users/:id/avatar` through a second resolver `resolveAvatar(userId)`; the person's colour comes from `colorFor(userId)` so canvas, SVG and presence agree.

Mentions: typing `@` inside any text editor (text, sticky, shape text) opens a member picker; choosing a member inserts `@Display Name` as plain text. Mentions do not change the model; they are text. A "Tag person" action in the selection toolbar creates a person element tagged to the selected element. This keeps the model small and keeps text plain for export.

### Steps

**F4.1 Members API.** `GET /api/boards/:id/members` (any member) returns `[{ id, username, name, avatarUrl, role }]`. `store.members(boardId)`. Add the route to the README table and `api.ts` (`members(id)`). Test in `server.test.ts`. Also expose `GET /api/users/:id/avatar` from F3 and `GET /api/users/:id` returning `{ id, username, name, avatarUrl }` for any authenticated user who shares at least one board with that user (query `members` for a common board), 404 otherwise.

**F4.2 Model.** Add `person` to `ElementType`, `TYPES`, `PersonProps`, validation (`userId` non-empty and at most 100 chars, `name` at most 80, `initials` 1 to 3 characters, `taggedElementId` null or non-empty), `createElement` defaults, and the fuzz generator. Geometry: `deriveElementGeometry` positions a tagged chip at the tagged element's top-right corner offset by `(-w/2, -h/2)` and copies its rotation, using the same map lookup pattern `resolveBinding` uses (this requires the element map; follow how connectors resolve at `geometry.ts:36-42` and how `HitIndex.dependents` tracks bindings so a tagged chip re-renders when its target moves). `delete(ids)` cascades to person elements whose `taggedElementId` is in `ids`. Clipboard: `preparePastedElements` remaps `taggedElementId` through `idMap` like connector bindings (`clipboard-model.ts:86-105`); a tag whose target is not in the paste becomes free-standing. Unit tests for all of it.

**F4.3 Renderer.** New `packages/renderer/src/people.ts` following `images.ts`: a circle mesh (a `CircleGeometry` with a `MeshBasicMaterial` texture from `resolveAvatar`, or the user colour with an initials Troika text when there is no avatar or the fetch fails), a white ring stroke, and a Troika name label to the right when the chip is wider than its height. Use the same lazy visibility, texture retention and disposal rules as images. Add `resolveAvatar?(userId): string | Promise<string>` to `RendererOptions`. Depth follows rank like every other element. Selection frame and hit testing use the element box, no change. Browser test: a chip renders with the avatar texture (probe pixel inside the circle) and a chip without avatar renders the colour.

**F4.4 SVG and PDF.** In `svg.ts`, emit `<clipPath>` with a circle plus `<image>` (bytes via a new `avatarUrl(userId)` option that mirrors `assetUrl`), or a `<circle fill=colour>` plus `<text>` initials, then the name `<text>`. `export.ts` collects avatars the same way it collects image assets (`:111-113`), through `resolveAvatar`; a missing avatar falls back to initials instead of failing the export (do not repeat REVIEW_FINDINGS item 45). Test in `tests/app/export.spec.ts`: SVG and PNG agree on the chip position and colour.

**F4.5 App: placing people.** New "People" dialog in `App.tsx` (button next to Share, visible to every member): lists members from F4.1 with avatar, name and role; clicking "Place on board" creates a free-standing person element at the viewport centre; dragging a row onto the canvas places it at the drop point. Selection toolbar gains "Tag person" when exactly one non-person, non-connector element is selected; it opens the same list and creates a tagged chip. Person elements can be moved, deleted, copied and connected like shapes; resizing is disabled (the frame shows no handles, the same way stickies may already restrict aspect; check `hit-test.ts` `selectionFrame`). A tagged chip cannot be moved independently; dragging it drags the tagged element. Read-only users see chips but cannot place them.

**F4.6 App: mentions.** In `text-editor.ts`, on input, when the character before the caret is `@` preceded by start-of-text or whitespace, open a small picker anchored to the caret (`getBoundingClientRect` of a collapsed range) listing members filtered by the typed prefix; arrow keys and Enter choose; Escape closes the picker without ending the edit (adjust the existing Escape handler at `:67` so it closes the picker first). Insert `@Name ` as plain text. No model change. Test in `tests/app/text.spec.ts`.

**F4.7 Refresh and lifecycle.** When the People dialog loads members, patch any person element whose `name`, `initials` or `hasAvatar` differ from the current member record (one transaction, origin `'system'` so it is not an undo step; check how `BoardDocument` scopes the UndoManager by origin). A person whose membership was removed (REVIEW_FINDINGS item 9) keeps rendering with the stored name; `/api/users/:id` returns 404 for non-shared users, so the avatar falls back to initials. Document this in the README.

**F4.8 Presence.** Optional: show the avatar in the remote cursor label (`packages/renderer/src/presence.ts:87, 122`) using the same avatar resolver. Keep it behind the same resolver so it works without F3 avatars.

### Acceptance

- A member can place themselves and any other member on the board, tag an element with a person, and connect a person to a shape; everything survives reload, undo, copy/paste across boards, and export to PNG, SVG and PDF.
- Moving or rotating a tagged element moves its chips; deleting it deletes them.
- `@` in any text editor offers members and inserts a plain mention.
- Boards with no F3 users work: chips render initials on the user's presence colour.

### Decisions already made

- Mentions are plain text. There is no per-user inbox or notification.
- Person elements do not resize. Avatar size is fixed at 40 board units; zoom scales it like everything else.
- Only board members can be placed. Placing a non-member is not offered; share the board first.

---

## Cross-cutting checklist (run after each feature)

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm test:app` green; `git status` clean after tests.
- [ ] Fuzz generator includes the new element shapes and converges.
- [ ] An existing board created before the change opens and exports unchanged (keep a fixture SQLite database from before F1 under `packages/server/test/fixtures/` and add a test that opens it).
- [ ] README, `packages/server/README.md` HTTP table, and `docs/DEPENDENCY_VERIFICATION.md` updated.
- [ ] Run the `code-reviewer` agent on the diff and the `adversarial-reviewer` agent on the new model surface (shape text validation, Excalidraw converter with hostile files, OAuth callback, person element cascades) before calling the feature done. Fix what they confirm.
