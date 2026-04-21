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
  mcp-server/    — Claude Code MCP server (stdio, 9 tools)
  shared/        — Shared TypeScript types and message definitions
examples/        — Example .shape.ts files
skill/           — Claude Code skill (Replicad API reference)
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/extension/src/viewer-provider.ts` | Webview HTML template, CSP, message bridge, screenshot capture |
| `packages/extension/src/extension.ts` | Extension entry, commands, auto-preview, MCP bridge |
| `packages/viewer/src/index.ts` | Three.js scene, parts panel, section plane, measure tool, params UI |
| `packages/worker/src/executor.ts` | Import rewriting + script execution sandbox |
| `packages/worker/src/index.ts` | WASM loading, GC, tessellation orchestration |
| `packages/mcp-server/src/tools.ts` | All MCP tool definitions + API reference content |
| `skill/SKILL.md` | Replicad API reference loaded by `/shapeitup` skill |
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

## MCP Server

Registered globally in `~/.claude/settings.json`. Provides 9 tools:
- `create_shape`, `modify_shape`, `read_shape`, `list_shapes`, `validate_syntax`
- `render_preview` (captures screenshot in AI high-contrast mode with dimensions)
- `set_render_mode`, `toggle_dimensions`
- `get_api_reference` (returns Replicad API docs by category)

## Publishing

- **GitHub**: https://github.com/asbis/ShapeItUp
- **VS Marketplace**: Published as `shapeitup.shapeitup-vscode`
- **npm**: `@shapeitup/mcp-server` — consumed by marketplace users via `npx -y @shapeitup/mcp-server` (the canonical install shape for Claude Code / Cursor / Desktop / Gemini).
- **Auto-deploy**: `.github/workflows/publish.yml` triggers on GitHub release creation. It builds, then (a) `pnpm --filter @shapeitup/mcp-server publish` to npm, and (b) `vsce publish` to the Marketplace. Uses `NPM_TOKEN` and `VSCE_PAT` secrets.
- **To release**: bump `packages/extension/package.json` version, commit, push, then `gh release create v0.x.x`.

### Any change under `packages/mcp-server/` MUST bump its own version

The release workflow publishes `@shapeitup/mcp-server` on every GitHub release, but **npm rejects republishing an existing version and the workflow step has `continue-on-error: true`** — so forgetting to bump `packages/mcp-server/package.json` causes a *silent* skip. Marketplace users stay on the old npm version while getting a freshly-published VSIX → drift between the bundled extension and the server they load via `npx`.

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
