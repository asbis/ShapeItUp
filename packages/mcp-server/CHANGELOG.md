# Changelog

## 1.6.3 (2026-04-21)

Patch: unblock Claude Code after the 1.6.2 Gemini fix. 1.6.2's sanitizer
stripped `$schema` (intentional, for Gemini) without also normalizing the
draft-07 tuple syntax (`items: [schemaA, schemaB]`) that two tools emit
via `z.tuple([...])`. Without the `$schema` annotation, Claude's API
validator falls back to JSON Schema 2020-12, where `items: [array]` is
invalid — causing `tools.N.custom.input_schema: JSON schema is invalid`
errors on any session that loaded the ShapeItUp tool catalog.

### Fixed
- Sanitizer now rewrites draft-07 tuple items to uniform-array form:
  `{ items: <shared schema>, minItems: N, maxItems: N }` for homogeneous
  tuples, `{ minItems: N, maxItems: N }` for heterogeneous ones. Valid
  under both JSON Schema 2020-12 (Claude) AND OpenAPI 3.0 (Gemini).
- Affected tools: `check_collisions.acceptedPairs`, `verify_shape.
  collisionAcceptedPairs` (both `z.array(z.tuple([z.string(), z.string()]))`).
- Regression gate added: the tools/list integration test now asserts zero
  tuples remain in the emitted catalog on every CI run.

Users on 1.6.2 should upgrade — that version broke Claude Code.

## 1.6.2 (2026-04-21)

Patch: MCP tool schemas sanitized for strict clients (Gemini CLI).

### Fixed
- Gemini CLI now accepts the tool catalog. ShapeItUp's schemas previously
  emitted `$schema`, `propertyNames`, and object-valued `additionalProperties`
  (from `z.record(...)` params), all of which fail Gemini's OpenAPI-3.0-subset
  validator and caused "400 INVALID_ARGUMENT" on every request regardless of
  whether a tool was being called. A new sanitizer strips those fields
  universally; runtime validation is unchanged. Safe for all MCP clients —
  Claude Code, Cursor, and Claude Desktop continue to accept the simpler form.
- `check_collisions` and `preview_finder` descriptions trimmed under 900
  chars (previously 1229 / 1207) to fit Gemini's per-function 1024-char limit.
- Defense-in-depth: description truncation at emit-time caps any future tool
  description at 999 chars + ellipsis.

## 1.6.1 (2026-04-21)

Patch release. Shipped alongside extension `1.7.0` to unblock the VSIX
publish that failed on `1.6.0` due to `ws` being symlinked into the
pnpm store. mcp-server's own tarball was unaffected (`ws` was already
correctly classified).

### Fixed
- Extension VSIX packaging: `ws` moved from `dependencies` to
  `devDependencies` in `packages/extension/package.json` — it is
  bundled by the extension's esbuild output, so vsce's
  `npm list --production` audit no longer trips on pnpm symlinks to
  ws's dev deps.
- CI/publish smoke tests now accept the expected `timeout 10` kill
  (exit 124) when a valid `serverInfo`/`protocolVersion` response
  has already been captured. The server deliberately keeps the
  subscriber-bus WebSocket listener open, so a clean EOF exit is not
  expected.

## 1.6.0 (2026-04-21)

Headless, standalone-ready MCP server. API-compatible for MCP clients; the
extension-side IPC protocol changed, so linking against older extensions will
not work (extension 1.7.0+ required).

This version supersedes unreleased `1.5.x` internal tags — content unchanged,
version bump only to avoid a collision with the `v1.5.0` / `v1.5.2` tags that
had already been created on the remote.

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
