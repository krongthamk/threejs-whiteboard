# Vercel frontend deployment

The repository-root `vercel.json` explicitly deploys only `packages/app` as a
Vite service. This prevents Vercel's workspace detection from treating
`packages/server` as a Node service and failing with:

```text
Service "server" detected framework "node" in "packages/server" and must specify an "entrypoint" for runtime "node".
```

## Project settings

- Keep the Vercel project's **Root Directory** at the repository root (`.`).
- Use Node.js 24.x, which is allowed by the repository's `engines` setting.
- The service configuration installs with `pnpm install --frozen-lockfile`, builds
  only `@whiteboard/app` with production test hooks disabled, and publishes
  `packages/app/dist`.
- `/board/:path*` serves `index.html`, so refreshing a board URL loads the app.
  API paths are not rewritten to the app's HTML.

Commit the configuration and redeploy. See Vercel's
[service configuration](https://vercel.com/docs/services/config-reference) and
[service routing](https://vercel.com/docs/services/routing) documentation.

## Demo behavior

The configured build sets `VITE_DEMO=1` and `VITE_TEST_HOOKS=0`. No environment
variables, OAuth credentials, API server, Render service, or persistent disk need
to be configured. Visiting the app opens a local board directly without sign-in.

- Boards and images are saved only in the current browser's IndexedDB. Titles and
  board IDs are listed in localStorage, separate from the private app's cache.
- **Saved in this browser** appears after the IndexedDB transaction completes.
  A failed write displays **Changes not saved** and keeps pending changes in memory
  for the next save attempt. Export before reloading if storage is unavailable.
- **Share → Open another tab** demonstrates anonymous live editing, cursors,
  selections, and independent undo using BroadcastChannel. Both tabs must use the
  same browser profile and exact site origin.
- Links do not transfer a board to another browser or device. Such visitors see an
  explanation instead of a sign-in form or a misleading empty copy.
- Clearing site data or using a new preview domain starts a separate workspace.
  Private browsing may delete work when its windows close. PNG/SVG/PDF exports
  preserve the drawing but are not editable backups.
- Image imports accept PNG, JPEG, and WebP up to 20 MiB each. Image and Excalidraw
  imports enforce a 64 MiB board budget; available browser storage can be smaller.

Cross-device collaboration is a later step: it needs a shared relay or signaling
service. This deployment has no backend connection or cloud persistence.

## Check before deployment

```sh
pnpm typecheck
pnpm test
pnpm test:demo
pnpm build:demo
```

`test:demo` uses Chrome and starts only a static preview server. It checks reloads,
images, same-browser collaboration and undo, failed saves, isolation between
browser profiles, and desktop/mobile controls. The build command checks that
production output does not expose test hooks.

The original private app can still be run separately with `pnpm dev` and
`pnpm server`; see its [server operations guide](../packages/server/README.md).
That mode is not deployed by this Vercel configuration.
