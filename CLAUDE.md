# ShapeItUp — Project Context for Claude

## What is this?

ShapeItUp is a scripted CAD tool built as a VS Code extension. Users write `.shape.ts` TypeScript files using the Replicad library (OpenCascade WASM), and the extension renders them in a Three.js 3D viewer. It includes an MCP server so Claude Code can create, modify, and visually verify CAD models.

## Tech Stack

- **TypeScript** — everything (extension, viewer, worker, MCP server, shape scripts)
- **Replicad** (npm: `replicad`) — CAD library wrapping OpenCascade compiled to WASM
- **Three.js** — 3D rendering in VS Code webview
- **esbuild** — builds all packages + bundles `.shape.ts` files at runtime (resolves local imports)
- **pnpm** workspaces — monorepo package management
- **Node 24+** required

## Architecture

```
Extension Host (Node.js)     Webview (Browser)           Web Worker (Browser)
┌──────────────────┐        ┌─────────────────┐        ┌──────────────────┐
│ File watcher      │──────→│ Three.js viewer  │──────→│ OCCT WASM        │
│ esbuild bundler   │       │ Orbit controls   │       │ Replicad         │
│ Export to disk    │←──────│ Edge rendering   │←──────│ Script execution │
│ MCP bridge        │       │ Params sliders   │       │ Tessellation     │
└──────────────────┘        └─────────────────┘        └──────────────────┘
```

**Script execution flow:**
1. User saves `part.shape.ts`
2. Extension host bundles it with `esbuild.build()` (resolves local imports, keeps `replicad` external)
3. Sends bundled JS to webview via postMessage
4. Webview forwards to Web Worker
5. Worker rewrites `import {...} from "replicad"` → destructures from pre-loaded module
6. Worker executes script, calls `main()`, gets Shape3D (or array of parts)
7. Worker tessellates → mesh arrays (vertices, normals, triangles, edges)
8. Posts arrays as Transferable buffers back to webview
9. Webview builds THREE.BufferGeometry + LineSegments, renders

## Project Structure

```
packages/
  extension/     — VS Code extension host (commands, file watching, webview provider)
  viewer/        — Three.js 3D viewer (runs in webview)
  worker/        — OCCT WASM + Replicad script execution (runs in web worker)
  mcp-server/    — Claude Code MCP server (stdio)
  serve/         — Standalone HTTP+WS viewer host (browser instead of webview)
  shared/        — Shared types, message defs, viewer HTML template, bundle spec
examples/        — Example .shape.ts files
skills/          — Claude Code skill (skills/<name>/SKILL.md layout)
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/extension/src/viewer-provider.ts` | Webview host: message bridge, screenshot capture, script bundling |
| `packages/shared/src/viewer-html.ts` | The viewer page template — shared by BOTH hosts, so they can't drift |
| `packages/shared/src/bundle-spec.ts` | Synthetic-wrapper + esbuild options every `.shape.ts` bundler must agree on |
| `packages/serve/src/host.ts` | `ViewerHost`: HTTP static + `/ws`, file watch, live reload |
| `packages/mcp-server/src/viewer-host.ts` | Singleton `ViewerHost` + local bus subscriber (browser viewers) |
| `packages/extension/src/extension.ts` | Extension entry, commands, auto-preview, MCP bridge |
| `packages/viewer/src/index.ts` | Three.js scene, parts panel, section plane, measure tool, params UI |
| `packages/worker/src/executor.ts` | Import rewriting + script execution sandbox |
| `packages/worker/src/index.ts` | WASM loading, GC, tessellation orchestration |
| `packages/mcp-server/src/tools.ts` | All MCP tool definitions + API reference content |
| `skills/shapeitup/SKILL.md` | Replicad API reference loaded by `/shapeitup` skill |
| `esbuild.config.mjs` | Single build script for all 4 packages |

## Build & Run

```bash
pnpm install
pnpm build          # builds all 4 packages
pnpm dev            # watch mode
# Press F5 in VS Code to launch Extension Development Host
```

Build outputs go to `packages/extension/dist/` (all bundles + WASM in one place).

## Shape File Convention

Files use `.shape.ts` extension. Must export a default `main()` function.

**With parameters (preferred — gives user live sliders):**
```typescript
import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, height: 50, depth: 30 };

export default function main({ width, height, depth }: typeof params) {
  return drawRoundedRectangle(width, height, 5).sketchOnPlane("XY").extrude(depth);
}
```

**Multi-part assemblies:**
```typescript
return [
  { shape: base, name: "base", color: "#8899aa" },
  { shape: bolt, name: "bolt", color: "#aa8855" },
];
```

**Multi-file imports:**
```typescript
import { makeBolt } from "./bolt.shape";
```

## Two viewer hosts

The viewer (`packages/viewer`) is host-agnostic. It picks its transport at
runtime in `message-handler.ts`: `acquireVsCodeApi()` inside a webview, a
same-origin WebSocket otherwise. Both hosts speak the same `ExtToWebview`
messages, so nothing downstream of the transport knows which one it is on.

```
VSCode extension  ──postMessage──┐
                                 ├──► packages/viewer ──► worker ──► OCCT WASM
MCP server (HTTP) ──WebSocket ───┘
```

The HTTP host lives INSIDE the MCP server process and registers as a local
SubscriberBus subscriber (`bus.addLocalSubscriber`), so every existing
`publishEvent` call site — `set_render_mode`, `toggle_dimensions`,
`open_shape` — reaches browser viewers with no change at those call sites.
Start it with `open_viewer`, or standalone via `pnpm serve <file.shape.ts>`.

Two gotchas that cost real time when the HTTP host was built:
- **Asset URLs must be absolute.** The OCCT worker runs from a `blob:` URL, so
  relative URLs in `__SHAPEITUP_CONFIG__` resolve against the blob context and
  every fetch fails with "Failed to fetch OCCT loader".
- **`request-wasm-assets` must be answered.** The viewer blocks on
  "Loading ShapeItUp..." until it gets a reply. An empty `{type:"wasm-assets"}`
  is fine — the worker then fetches the wasm by URL itself.

## Viewer asset distribution

`open_viewer` serves eight browser assets. They are resolved individually
(`viewer-host.ts:createAssetResolver`), not from one directory, because the two
distribution channels lay them out differently:

| Asset | VSIX | npm (`@shapeitup/mcp-server`) |
|---|---|---|
| `viewer.js`, `worker.js` | `extension/dist/` | shipped in `dist/` (~1.3 MB gzipped) |
| `replicad_single.*` | `extension/dist/` | `node_modules/replicad-opencascadejs` |
| `manifold.*` | `extension/dist/` | `node_modules/manifold-3d` |
| `mujoco.*` | `extension/dist/` | `node_modules/@mujoco/mujoco` (optional) |

The npm package deliberately does NOT ship the `.wasm` files: those three
packages are already runtime dependencies, so npm puts the exact same bytes on
disk anyway. Copying them in would add ~7 MB gzipped of duplicates to every
install, including installs that never open a viewer. `SHAPEITUP_VIEWER_DIST`
overrides the search for unusual layouts.

MuJoCo is optional throughout — a 404 on `mujoco.wasm` just disables Sim.

**Anything under `packages/mcp-server/` that only workspace packages provide must
sit in `devDependencies`, not `dependencies`.** esbuild inlines them into
`dist/index.js`, and every `@shapeitup/*` workspace package is `private: true` —
a `workspace:*` entry in `dependencies` publishes a spec npm cannot resolve.

## Parameter writeback vs. the params sidecar

Releasing a slider commits its value to the `.shape.ts` (`param-changed` →
`computeParamEdit` → the host's writer). Two hosts, two mechanisms:

| | Serve host | VS Code host |
|---|---|---|
| Applies via | atomic write + mtime guard | `WorkspaceEdit` |
| Unsaved edits | invisible to it | composed with |
| Undo | none | Cmd-Z |
| Watcher echo | suppressed by content match | n/a — it doesn't save a visible doc |

`.shapeitup-params.json` is read by the MCP tools layer and by NOTHING else —
not the viewer, not either host, not the core. So the two paths diverge on
their own, before writeback enters the picture:

```
file declares gussetH: 45, sidecar pins gussetH: 120
  verify_shape / export_shape / render_preview -> bbox Z = 126
  the viewer, and open_viewer                  -> bbox Z = 51
```

Writeback is **off by default**, behind a "Save to file" switch in the
Parameters header (remembered per viewer in `localStorage`). A viewer that
shows a model and a viewer that edits your source are different promises, so
the destructive one is opt-in. Commit outcomes — saved, or declined and why —
appear in a status line pinned under that header.

Resolution is precedence, not detection: the file is the durable artifact and
the sidecar is a scratch overlay, so **committing a parameter clears its
sidecar pin**. Other pinned parameters are untouched — a commit says nothing
about them. Without this, a committed value is silently overridden in every
export.

The file FORMAT lives in `@shapeitup/shared/sidecar`, a Node-only subpath that
the barrel deliberately does not re-export (the barrel is imported by the
browser viewer). The merge PRECEDENCE stays in `mcp-server/tools.ts` — the
hosts have no business knowing it.

## MCP Server

Registered globally in `~/.claude/settings.json`. Viewer-related tools:
- `create_shape`, `modify_shape`, `read_shape`, `list_shapes`, `validate_syntax`
- `render_preview` (captures screenshot in AI high-contrast mode with dimensions)
- `set_render_mode`, `toggle_dimensions`
- `get_api_reference` (returns Replicad API docs by category)
- `open_viewer` / `close_viewer` (browser 3D viewer — no editor required)

## Publishing

- **GitHub**: https://github.com/asbis/ShapeItUp
- **VS Marketplace**: Published as `shapeitup.shapeitup-vscode`
- **npm**: `@shapeitup/mcp-server` — consumed by marketplace users via `npx -y @shapeitup/mcp-server` (the canonical install shape for Claude Code / Cursor / Desktop / Gemini).
- **Auto-deploy**: `.github/workflows/publish.yml` triggers on GitHub release creation (and `workflow_dispatch`). It builds/tests, then (a) publishes `@shapeitup/mcp-server` to npm and (b) `vsce publish` to the Marketplace.
- **npm auth = OIDC trusted publishing (no token).** The npm publish step runs `npm publish <tgz>` on `npm@latest` (needs ≥11.5.1) against the tarball `pnpm pack` produced, authenticating via OIDC — the job declares `permissions: id-token: write` and a Trusted Publisher (`asbis/ShapeItUp` + `publish.yml`) is configured on npmjs.com. There is **no `NPM_TOKEN` secret** (deleted 2026-06-30). Do NOT re-add `registry-url` to setup-node or a `NODE_AUTH_TOKEN` env — either blocks the OIDC path. `pnpm publish` can't do OIDC (it hits `ENEEDAUTH`), which is why the step uses `npm`. Marketplace still uses the `VSCE_PAT` secret. Full rationale: `~/.claude` memory `project_npm_oidc_publishing`.
- **To release**: bump versions (see below), commit, push, then either `gh release create v0.x.x` OR `gh workflow run publish.yml --ref master` (dispatch skips the tag-verify step and publishes whatever version is in `package.json`).

### Any change under `packages/mcp-server/` MUST bump its own version

The release workflow publishes `@shapeitup/mcp-server` on every GitHub release. npm rejects republishing an existing version, and the publish step has **no `continue-on-error`** — so forgetting to bump `packages/mcp-server/package.json` makes the whole run **fail loudly** (and, critically, the VS Marketplace step after it never runs). Either way you end up with drift or a failed deploy, so keep both versions moving in lockstep.

Checklist when touching anything under `packages/mcp-server/src/` or its deps (`packages/core/`, etc. that get bundled in):

1. Bump `packages/extension/package.json` version (drives the release tag).
2. Bump `packages/mcp-server/package.json` version in the same commit.
3. Both versions should usually move in lockstep to keep diagnostics sane.
4. After the release lands, verify `npm view @shapeitup/mcp-server version` matches.

A mismatch is the exact failure mode that bit us in v1.1.0 → v1.5.2: the extension bundled fine but `~/.claude.json` entries pointing at `npx -y @shapeitup/mcp-server` resolved to a stale published version.

## Known Issues / Gotchas

- **WASM memory**: OpenCascade shapes must be `.delete()`'d between executions or memory corrupts. The worker handles this via `cleanupLastParts()`.
- **Import rewriting**: The worker uses regex to rewrite `import {...} from "replicad"` to destructuring. `as` aliases are converted (`X as Y` → `X: Y`). `export { main as default }` blocks are stripped.
- **esbuild at runtime**: The extension uses esbuild at runtime (not just build time) to bundle `.shape.ts` files with local imports. esbuild must be included in the VSIX as a real dependency with its platform binary.
- **CSP**: The webview needs `'unsafe-eval'` (for `new Function()` in script execution) and `'wasm-unsafe-eval'` (for OCCT WASM).
- **Worker loading**: The worker runs from a blob URL (VSCode webview limitation). The WASM loader is fetched and eval'd because `importScripts` doesn't work with webview URIs or ESM exports.
- **Auto-preview debounce**: File switching is debounced (500ms) to prevent rapid WASM executions.

## Viewer Features

- Fusion 360-style dark theme with grid, axes, lighting
- Parts browser panel (show/hide per component, auto-opens for assemblies)
- Parameter sliders (auto-generated from `export const params`)
- Section/cross-section clip plane (X/Y/Z axis, draggable position)
- Click-to-measure (click two points, shows distance + ΔX/ΔY/ΔZ)
- Dimension overlay (bounding box X/Y/Z measurements)
- ViewCube (Top, Front, Right, Iso presets)
- Edge toggle, wireframe toggle
- STEP/STL export buttons
- AI render mode (white bg, vivid colors for screenshot analysis)
