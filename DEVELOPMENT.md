# Development

Local dev loop for ShapeItUp. CLAUDE.md covers architecture; this file covers the day-to-day commands.

## One-time setup

```bash
pnpm install
pnpm build
```

Your global `~/.claude.json` may have `shapeitup` registered via `npx -y @shapeitup/mcp-server`. You do **not** need to edit it. The project-local `.claude/settings.json` already overrides it with the local build (`node ./packages/mcp-server/dist/index.js`) whenever `claude` runs inside this repo.

Verify with `/mcp` inside a Claude Code session started in this directory — the `shapeitup` entry should point at the local path, not `npx`.

## Iterating

| What you're editing | Command | Do you need to restart anything? |
|---|---|---|
| Extension / viewer / worker | `pnpm dev` (watch) then press **F5** in VS Code | F5 relaunches the Extension Development Host — no manual restart |
| MCP server (`packages/mcp-server/src/`) | `pnpm dev:mcp` (watch) | **Yes** — `/quit` Claude Code and restart. Stdio MCP processes don't hot-reload. |
| Stdlib (`packages/core/src/stdlib/`) | `pnpm dev` (rebuilds both the extension bundles *and* the mcp-server, since stdlib is bundled into both) | F5 for viewer changes; restart Claude for MCP changes |
| Skill docs (`skill/SKILL.md`) | `pnpm build` to copy into `dist/skill/` | Reinstall the skill (or reload Claude Code) to pick it up |

F5 alone works too — `.vscode/launch.json` runs `pnpm build` as a pre-launch task, so you don't need a separate dev server running if you just want a one-shot test.

## Testing

```bash
pnpm lint      # tsc -b across extension + mcp-server
pnpm test      # vitest run — 571+ tests
pnpm test:watch
```

## Releasing

Pre-flight check — catches the silent-skip failure mode that bit v1.1.0 → v1.5.2:

```bash
pnpm release:check
```

Checks:

1. Working tree is clean.
2. `packages/mcp-server/package.json` version is **not** already on npm (else the publish step is a silent no-op because of `continue-on-error: true` in the workflow).
3. `v${extension.version}` tag doesn't exist locally or on origin.
4. Warns if extension + mcp-server versions diverge (soft — they usually move in lockstep).
5. Warns if you're not on `master`.

After it's green:

```bash
gh release create v1.x.y   # triggers .github/workflows/publish.yml
```

The workflow publishes both to npm (`@shapeitup/mcp-server`) and to the VS Marketplace (`shapeitup.shapeitup-vscode`). Verify afterward:

```bash
npm view @shapeitup/mcp-server version   # must equal packages/mcp-server/package.json
```

### When to bump which version

- Touched anything under `packages/mcp-server/src/` or its bundled deps (`packages/core/`, `packages/shared/`) → bump **both** `packages/extension/package.json` and `packages/mcp-server/package.json` in the same commit. `pnpm release:check` will tell you if you forgot.
- Touched only extension/viewer/worker code (no mcp-server surface) → bumping only the extension version is fine, but keeping them in lockstep makes diagnostics easier.
