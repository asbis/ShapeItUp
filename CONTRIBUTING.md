# Contributing to ShapeItUp

Thanks for your interest in contributing!

## Getting Started

```bash
git clone https://github.com/asbis/ShapeItUp.git
cd ShapeItUp
pnpm install
pnpm build
```

Press F5 in VS Code to launch the Extension Development Host.

## Development Workflow

```bash
pnpm dev    # watch mode -- auto-rebuilds all packages on file changes
```

The project uses a pnpm workspace with 5 packages:

| Package | What it does |
|---------|-------------|
| `packages/extension` | VS Code extension host -- commands, file watching, webview provider |
| `packages/viewer` | Three.js 3D viewer running in a webview |
| `packages/worker` | Web Worker that loads OCCT WASM and executes Replicad scripts |
| `packages/mcp-server` | MCP server for AI assistant integration |
| `packages/shared` | Shared TypeScript types and message definitions |

## Build System

All packages are bundled with a single `esbuild.config.mjs` at the root. It produces 4 bundles:

- `extension.js` -- Node.js, CJS (external: vscode, esbuild)
- `viewer.js` -- Browser, IIFE (bundles Three.js)
- `worker.js` -- Browser, IIFE (bundles Replicad)
- `mcp-server/dist/index.js` -- Node.js, ESM (external: esbuild)

## Adding a New Viewer Feature

1. Add HTML/CSS in `packages/extension/src/viewer-provider.ts` (the HTML template)
2. Add the Three.js logic in `packages/viewer/src/index.ts`
3. If it needs worker communication, update `packages/shared/src/messages.ts`

## Adding a New MCP Tool

1. Add the tool definition in `packages/mcp-server/src/tools.ts`
2. Update the API reference in the `getApiReference()` function
3. Update `skill/SKILL.md` with documentation
4. Copy the skill to `~/.claude/commands/shapeitup.md`

## Adding Examples

Create a new file in `examples/` with the `.shape.ts` extension. Follow the patterns in existing examples. Prefer using `export const params = {...}` for slider support.

## Code Style

- TypeScript throughout
- No semicolons in import-only files is fine, but prefer them in logic files
- Use `const` over `let` where possible
- Keep functions small and focused

## Submitting Changes

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Test by pressing F5 and verifying the viewer works
5. Submit a pull request
