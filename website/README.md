# shapeitup.dev

The landing page and the in-browser playground.

```bash
pnpm build            # at the repo root — the playground ships extension/dist's viewer + kernels
pnpm website:dev      # builds website/dist and serves it on http://localhost:4321
pnpm website          # build only
```

| Path | What |
|---|---|
| `public/` | The landing page: hand-written HTML/CSS/JS, no framework, copied as-is |
| `public/img/` | Real renders from the viewer (see "Renders" below) |
| `src/playground.*` | The playground: an editor plus the real viewer in an iframe |
| `src/viewer-shim.js` | Injected into `viewer.html`; makes the playground the viewer's host |
| `examples/` | The playground's example projects; `index.json` sets order and entry file |

## How the playground works without a server

The viewer chooses its transport by checking for `acquireVsCodeApi()`. `viewer.html`
is rendered from the same `renderViewerHtml` template the two real hosts use, with
a shim that defines that function and forwards to the parent page. The parent then
acts as the host:

- **Bundling.** Sucrase strips types and turns each tab into a CommonJS module.
  The executor already rewrites `__require("replicad")` / `__require("shapeitup")`,
  so only local imports need resolving. That's how the 3-file example works
  without esbuild-wasm (14 MB).
- **Writeback.** Slider commits, face ops, combine, move/rotate, mirror and
  pattern go through the same pure functions from `@shapeitup/shared` that
  `packages/serve` uses to write files. Here the result goes into the editor
  instead.
- **Export.** STEP/STL/3MF are downloaded by the browser.

MuJoCo is not shipped (10 MB), so Sim is disabled in the playground.

## Renders

`public/img/*.webp` are screenshots taken by the viewer itself. With `pnpm website:dev`
running, open `/app/?example=bracket&capture=name` (optionally with `&mode=ai`,
`&angle=top`, `&w=`/`&h=`, or `&dims`). The first render is saved as
`public/img/name.png`. Crop it and convert it to webp before committing.

## Deploying

`vercel.json` expects the Vercel project's root directory to be `website/`. It
installs and builds from the repo root, because the playground needs the built
viewer.
