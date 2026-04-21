# Changelog

All notable changes to the ShapeItUp VS Code extension. The MCP server tracks
its own versions in `packages/mcp-server/CHANGELOG.md`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the
project follows semantic versioning at the extension level.

## [1.7.0] - 2026-04-21

Extension `1.7.0` / mcp-server `1.6.0` — MCP-first standalone architecture.

### Changed
- **Headless-first rendering.** `render_preview` now ships SVG + resvg-wasm as
  the default path — the VSCode extension is no longer required to produce an
  image for agents. Runs cleanly under `npx`, CI, Docker.
- **WebSocket subscriber IPC replaces the file-based bridge.** Extensions
  connect as subscribers to the MCP server; the server is authoritative and
  routes to the active editor session. Cross-workspace and multi-window
  routing are now first-class.
- **README rewrite** — MCP is the primary install path; the VSCode extension
  is presented as an optional viewer rather than the front door.
- **`assertWorkspaceOwned` removed** — MCP operates in any directory a client
  hands it, gated only by per-tool validation.

### Added
- `list_installed_apps` ported into `mcp-server` so ported host detection
  (VSCode/Cursor/etc.) works standalone.
- `verify_shape` MCP tool — single-execution multi-check inspection.
- Extension-host WASM byte cache eliminates worker cold-start fetches.
- MCP engine mesh-result cache: `render_preview`, `check_collisions`, and
  friends reuse tessellation across tools.
- `esbuild` bundle cache in the MCP server engine (with new-import
  invalidation bug fix).
- `format` parameter on `check_collisions` and `sweep_check`
  (`summary` / `full` / `ids`) — lazy/cheap collision reports for agents.
- Auto-upgrade `meshQuality` to `final` when `renderMode=ai` so AI screenshots
  are always high-quality.
- `jointAt` alias, `part.group` field, BOM dedupe, collage layout polish, and
  `minFeature` threshold on diagnostics.

### Fixed
- Wrap `extrude` / `shell` / `sweep_check` / `fillet` errors with actionable
  hints surfaced back through MCP.
- Screenshot-ready event handshake (replaces 500ms sleep).
- `fs.watch` + 250ms backstop in `waitForResult` (replaces 100ms poll).
- Deduplicated `validate_script` tool registration.
- MCP packaging for `npx`: shebang on `dist/index.js`, `ws` moved to
  `devDependencies`, runtime WASM deps in `dependencies`.
- Silent wrong-`main` detection in multi-file `.shape.ts` bundles.
- Locale-safe mm labels; trimetric iso camera; corner gnomon.

---

## [1.5.2] — 2026-04-21

Stability pass after v1.5 shipped.

### Fixed
- Lint cleanup across stdlib + MCP.
- Multi-part assembly regression on developer feedback.
- Boolean-loop pitfall detector extended to `while` / `forEach` / `reduce` +
  `.intersect`.
- Raise preview deflection to 4.5× + lift outer cap to 5.0 mm for perf.

## [1.5.1] — 2026-04-21

### Added
- FDM printability warnings on `threads.*` helpers.
- New `holes.threaded` stdlib helper.
- Per-part `printability` field on MCP responses.
- `export_shape` surfaces printability warnings.
- Threaded-vs-tapped side-by-side example.

### Changed
- `SKILL.md` restructured for clearer stdlib discovery.

## [1.5.0] — 2026-04-21

MCP tool surface + stdlib expansion driven by external-agent testing.

### Added
- **`sweep_check` MCP tool** — sweep-based collision detection with enriched
  output and `z<0` warning, plus a fillet-after-boolean rule.
- **BOM sidecar** on `export_shape`.
- **Multi-angle collage** on `render_preview`.
- **Stdlib — print orientation.** `flatForPrint`, `layoutOnBed`.
- **Stdlib — assembly primitives.** `pin`, `pivot`, `cradle`, `band_post`,
  `teeBar`, plus `SPORTS_BALLS` standards.
- `Part.mirror` + `symmetricPair` for mirrored assemblies.

### Fixed
- Multi-file `.shape.ts` bundles no longer silently pick the wrong `main()`.
- MCP refuses duplicated-segment paths; records `lastScreenshot`.
- `patterns.polar(n, 0)` warns; SKILL.md hole-axis clarifications.

## [1.4.2] — 2026-04-21

### Fixed
- Refresh lockfile for `@resvg/resvg-wasm` in extension deps.

## [1.4.1] — 2026-04-20

### Added
- Headless SVG wireframe fallback for `render_preview` (rasterized to PNG so
  agents see the image inline).

## [1.4.0] — 2026-04-20

### Added
- Auto-bootstrap fresh projects with type stubs (skips when `replicad` is a
  pnpm symlink).
- `threads.externalMesh` / `threads.internalMesh` for custom diameters.
- `describe_geometry` MCP tool; persistent `tune_params`; inline `tune_params`;
  `holes` raw opt-out; stack filter; alloys; `matchType` cleanup.
- `placeOn` stdlib wrapper for direction-safe `sketchOnPlane.extrude`.
- User `.shape.ts` paths + lines in runtime error stacks.

### Changed
- `showAxes` on by default.
- Defer extrude-plane warnings until final bbox is known; suppress ones
  originating inside stdlib helpers.

## [1.3.3] — 2026-04-20

### Added
- Auto-migrate stale pre-1.3 MCP entries with user consent.

## [1.3.2] — 2026-04-20

### Fixed
- Activate extension when MCP clients view is opened.

## [1.3.1] — 2026-04-20

### Added
- MCP clients sidebar view + first-run nudge for discoverability.

## [1.3.0] — 2026-04-20

### Changed
- **MCP install UX refactor.** Clearer client setup surface.
- Swap to `esbuild-wasm` for cross-platform parity.

## [1.2.0] — 2026-04-20

Robustness sweep + production threads.

### Added
- **Helical threads** (metric + trapezoidal), loft-per-turn + Manifold
  `tapInto` for production-ready geometry.
- Pre-OCCT validators, runtime instrumentation.
- M10 / M12 + hex-head fasteners.
- `gears.spurInvolute` stdlib module.
- Runtime warnings module + static param extraction.
- `holes.throughAt` / `tappedAt` / `counterboreAt`; document hole
  axis/anchor conventions.
- Strict mode via config export; per-part stats gated behind `partStats`.

### Changed
- Split fasteners into `screws` (cosmetic) vs `bolts` (threaded) namespaces.
- WASM reset + multi-window routing + streaming render.

### Fixed
- Warn on non-XY `sketchOnPlane` extrude direction; suppress pen-axis hint
  when centered.
- Extrude-without-`sketchOnPlane`, `read_shape` resolvedPath, tighter
  `signaturesOnly`, finder `matchType`.

## [1.1.0] — 2026-04-17

Stdlib is born: extracted `@shapeitup/core` and introduced Phase 1–2 helpers.

### Added
- **`@shapeitup/core`** shared CAD pipeline extracted from the extension.
- **Phase 1 stdlib** — `holes`, `fasteners`, print hints, `bearings`,
  `extrusions` modules; standards table + `shapeitup` import source.
- **Phase 2 stdlib** — `patterns` (polar, grid, linear + `spread`/`cutAt`);
  parts + joints + mates assembly API; insertion-mate, `debugJoints`,
  `highlightJoints`; standard part builders (motors, couplers); subassemblies
  (Parts composed of Parts).
- **Phase 1.5** ergonomic polish — `fromBack`, `shape3d`, bottom camera
  preset.
- Export-and-open-in external 3D app integration.
- Harden MCP IPC; wire engine-backed tools into the viewer.

### Changed
- Reorganize `SKILL.md` with TOC and expanded API reference.
- Trim example set to assembly + bracket.
- Mark `shapeitup` as external in runtime esbuild bundlers.

### Fixed
- File-watcher no longer double-fires on save.
- Linear-rail shape reuse, teardrop tool, bracket extrude bugs.

## [1.0.3] — 2026-04-16

### Added
- `makeEllipsoid` helper; organic-shape docs + error messages.

## [1.0.2] — 2026-04-16

### Added
- Auto-install the `/shapeitup` Claude Code skill on activation.

## [1.0.1] — 2026-04-16

### Fixed
- MCP registration for Claude Code CLI installs.

## [1.0.0] — 2026-04-16

Feature-complete release — the headline milestone for the extension-first
era. Consolidates the v0.x workflow + AI tooling into a stable surface.

## [0.9.0 – 0.9.8] — 2026-04-16

Screenshot + camera QoL sweep.

### Added
- Camera-angle control; timestamped screenshots; category listing.
- File sizes, named screenshots, recursive flag.

### Fixed
- `cameraAngle` no longer overridden by `request-screenshot`.
- Atomic prepare-screenshot command.
- Screenshots: unique per capture + stable per-shape + stable `latest`.
- Parallel screenshots, validate message, viewer state restore.
- `validate_script` multiline objects; consistent screenshot names.
- Tool-description polish to match actual behavior.

## [0.7.0 – 0.8.3] — 2026-04-16

WASM reliability + esbuild path hell on Windows.

### Added
- Auto-recover from WASM crashes; fix response format; fix esbuild cwd.

### Fixed
- WASM 408 timeout recovery; esbuild Windows path; cascading errors.
- Duplicate execution, respawn loop, esbuild path, `validate_script`.
- esbuild drive-letter handling; stdin + `resolveDir` instead of
  `absWorkingDir`.
- Stale render status; esbuild init race condition.

## [0.6.0 – 0.6.2] — 2026-04-15

### Added
- `export_shape` MCP tool; validate `create_shape` code; polish responses.
- Inline render status, direct export — reduce AI round-trips.

### Fixed
- Y-dimension visibility; fillet examples.

## [0.5.0 – 0.5.2] — 2026-04-15

AI workflow reliability pass driven by agent testing.

### Added
- Bounding-box text; `delete_shape` tool.

### Fixed
- AI-mode colors + lighting.

## [0.4.0] — 2026-04-15

### Changed
- Major MCP improvements based on AI agent testing feedback.

## [0.3.0 – 0.3.2] — 2026-04-15

### Added
- Single combined IPC command for `render_preview`; better dimensions.

### Fixed
- MCP auto-setup for Claude Code; secondary sidebar.
- MCP server bundled as self-contained CJS, no external deps.

## [0.2.0 – 0.2.2] — 2026-04-15

### Added
- 3D preview registered in secondary sidebar.
- Auto-register MCP server via VS Code API.
- `get_render_status` MCP tool so AI can check errors after rendering.

### Fixed
- Auto-preview spam; OCCT error messages.

## [0.1.1 – 0.1.9] — 2026-04-15

Hotfix parade after the initial release.

### Added
- GitHub Actions workflow for auto-publishing to VS Marketplace.
- Auto-setup: detect missing `replicad` types, offer to install (later made
  silent, then fully bundled with the extension).

### Fixed
- Lockfile mismatch.
- `moveView` command compatibility across VS Code versions.
- Switch from `esbuild` to `esbuild-wasm` for cross-platform compatibility;
  remove unneeded `wasmURL` option.
- Create `tsconfig.json` (not `tsconfig.shapeitup.json`) for type resolution.

## [0.1.0] — 2026-04-14

Initial release.

### Added
- Script-based CAD with `.shape.ts` files using Replicad (OpenCascade WASM).
- Live 3D preview in VS Code side panel with Three.js.
- Auto-preview when switching between shape files.
- Parameter sliders (export `params` object for interactive controls).
- Multi-file imports (use parts from other `.shape.ts` files).
- Multi-part assemblies with per-part colors.
- STEP and STL export via toolbar buttons.
- Section/cross-section view with clip plane.
- Click-to-measure tool (distance, ΔX/ΔY/ΔZ).
- Dimension overlay (bounding-box measurements).
- ViewCube for quick camera presets (Top, Front, Right, Iso).
- Parts browser panel with show/hide per component.
- Edge and wireframe toggle.
- Fusion 360-inspired dark theme.
- MCP server for Claude Code integration (9 tools).
- AI render mode (high-contrast for screenshot analysis).
- Replicad API skill for Claude Code (`/shapeitup`).
