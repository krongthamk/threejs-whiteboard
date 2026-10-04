# Dependency verification

Checked on 2026-09-29.

Finding 28 update — 2026-10-05: model element creation and duplication now use
the platform's `crypto.randomUUID()`. The direct `nanoid` 5.1.6 dependency and
its lockfile entries are removed; caller-supplied and historical element IDs
remain unchanged. The separate `nanoid` 3.3.19 entry remains a PostCSS transitive
dependency. This change adds no dependency.

Hocuspocus server, provider, and database extension are pinned to **4.7.0**.
The [official v4.7.0 release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
explicitly includes [PR #1152](https://github.com/ueberdosis/hocuspocus/pull/1152),
which fixes [issue #1151](https://github.com/ueberdosis/hocuspocus/issues/1151).
The release tag is `6ddc75775b22fea83fab15cb7c8f9c84a45556f6`; the PR was merged as
`7fb9086` on 2026-09-09. `npm view @hocuspocus/provider@4.7.0 version gitHead`
returned that release version and full tag hash. The exact `4.7.0` database
extension also exists in the registry. npm returned Yjs `13.6.33` and ws `8.22.0`.

The defect is specifically Redis sync-reply routing: replies must reach their
requesting replica rather than every replica. The initial deployment uses one
authoritative process per board and no Redis. This pin is not a claim that HA
has been validated; three-replica regression testing remains mandatory before
enabling Redis. Every replica must use the same patched version.

## Phase 3 recheck — 2026-09-29

The root agent repeated registry and primary-source checks before Phase 3:
`npm view @hocuspocus/server version` returned `4.7.0`, and
`npm view troika-three-text version` returned `0.52.5`. The
[official Hocuspocus release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
remains the latest release and explicitly includes PR #1152. Our pinned-version
integration and load tests cover the exercised behaviors; this does not establish
that every upstream regression is absent.

The [official Troika text README](https://github.com/protectwise/troika/tree/main/packages/troika-three-text)
states that `.woff` fonts are supported and `.woff2` is unsupported. The
[tldraw licensing page](https://tldraw.dev/community/license) still distinguishes
development defaults from a production license key requirement. This project
does not import tldraw code. `@y/hub` is unnecessary for the selected single-node
deployment and remains excluded; its license/stability must be checked if a
future HA design proposes it. `better-sqlite3` is pinned to `13.0.3`; its native
module was built and loaded successfully on the selected Mac with Node 26.8.1.

## Phase 5 recheck — 2026-09-29

Repeated registry queries during the production acceptance run again returned
Hocuspocus `4.7.0` and Troika `0.52.5`. The
[official Hocuspocus release](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.7.0)
still displays Latest and includes PR #1152. The
[official Troika font documentation](https://protectwise.github.io/troika/troika-three-text/#font)
continues to list TTF/OTF/WOFF and explicitly excludes WOFF2. The
[tldraw licensing page](https://tldraw.dev/community/license) still limits its
default terms to development and requires an active trial, commercial, or hobby
key in production. No tldraw or `@y/hub` dependency was introduced. Local
regression and load evidence supports only its stated tested scope; no claim
that every possible upstream regression is absent is made.
