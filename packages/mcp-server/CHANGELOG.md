# Changelog

## 1.9.0 (2026-04-22)

Warning signal-to-noise overhaul and acceptedPairs UX from the 98-part
knitting-printer field report. Ships in lockstep with extension 1.10.0.

### Fixed
- `check_collisions` footer no longer leaks the previous shape's screenshot
  path onto `modify_shape`/`validate_syntax`/etc responses for a different
  shape. Emitted line now includes `file=<shape>` for disambiguation.
- `minZ < -0.05` float-dust threshold eliminates the `"extends 0.0 mm below
  z=0"` false-fire when a cutter uses `CUT_EPSILON` padding.
- Symmetric-about-z=0 bboxes (horizontal shafts/cylinders) no longer trigger
  the "extends below z=0" warning.
- Non-XY-plane pen-axis warning no longer fires on draws that only use
  absolute `.lineTo()` — scoped to drawings that actually called `hLine`,
  `vLine`, `vhLine`, `polarLine`, `polarLineTo`, `tangentArc`,
  `hSagittaArc`, or `vSagittaArc`.
- `sketchOnPlane("YZ"/"XZ", [non-zero…]).extrude(N)` no longer fires a
  "bbox off-origin" hint — passing a non-trivial origin is the opt-in.

### Changed
- `.extrude(-L)` is allowed. Removed the "distance must be positive" guard
  in `validateSketchExtrude`: replicad accepts it natively, and the old
  "flip the plane name" workaround silently swapped pen-axis semantics.
- `acceptedPairs` schema `.describe()` now documents the pre-existing `*`
  glob support — [`["needle-body-*", "needle-bed"]`] matches 20 literal
  pairs in one entry.
- `render_preview` part list: summary cap raised 10 → 25; auto-expands to
  200 when every part has a meaningful (non-`part_N`) name.

### Added
- `extractExpectedContactsStatic` in `@shapeitup/core` parses
  `export const expectedContacts = [["a","b"], ...]` from shape source.
  `check_collisions` merges these with user-supplied `acceptedPairs` so
  acceptance rules can live next to the code that produces the contact.

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
