# Changelog

## 1.5.0 (2026-04-21)

Headless, standalone-ready MCP server. API-compatible for MCP clients; the
extension-side IPC protocol changed, so linking against older extensions will
not work (extension 1.7.0+ required).

### Changed
- WebSocket subscriber bridge replaces the previous global-storage-directory
  IPC. Extensions connect as subscribers; the MCP server is authoritative.
- Fully headless render path via `@resvg/resvg-wasm` — no VSCode webview needed
  for `render_preview`. Runs under `npx`, CI, Docker.
- Standalone in-process app launcher. `open_shape` now detects and launches
  ported host apps (VSCode, Cursor, etc.) without the extension as proxy.
- Ported app detection via `@shapeitup/shared` types — works whether the user
  has the VSCode extension installed or not.
- `assertWorkspaceOwned` gate removed. MCP server operates in any directory a
  client hands it, gated only by the tool handler's own validation.

### Fixed
- `#!/usr/bin/env node` shebang is now present on the built `dist/index.js` so
  `npx -y @shapeitup/mcp-server` works on Linux/macOS without a wrapper.
- `ws` moved to `devDependencies` — it is bundled into `dist/index.js` and no
  longer needs to be resolved from consumer `node_modules`.
- Runtime WASM deps (`@resvg/resvg-wasm`, `esbuild-wasm`, `manifold-3d`,
  `replicad-opencascadejs`) correctly declared under `dependencies` so `npm
  install` / `npx` resolves them on the consumer side.
