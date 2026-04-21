# @shapeitup/mcp-server

MCP server for [ShapeItUp](https://github.com/asbis/ShapeItUp) — scripted CAD tools (Replicad / OpenCascade WASM) for Claude Code, Cursor, Claude Desktop, Gemini CLI, and any stdio MCP client. Fully headless, no VSCode required.

## Install

Don't — just point your MCP client at it:

```bash
npx -y @shapeitup/mcp-server
```

### Claude Code

```bash
claude mcp add shapeitup -- npx -y @shapeitup/mcp-server
```

### Cursor / Claude Desktop / generic MCP client

```json
{
  "mcpServers": {
    "shapeitup": {
      "command": "npx",
      "args": ["-y", "@shapeitup/mcp-server"]
    }
  }
}
```

- Cursor: `~/.cursor/mcp.json` (or Settings → MCP)
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

Node 20+ required. Works in Docker / CI (WASM, no native deps).

## What's in the box

25 MCP tools covering the full CAD loop:

- Authoring — `create_shape`, `modify_shape`, `read_shape`, `list_shapes`, `setup_shape_project`
- Rendering — `render_preview`, `preview_shape`, `get_preview`, `set_render_mode`, `toggle_dimensions`
- Verification — `verify_shape`, `check_collisions`, `sweep_check`, `describe_geometry`, `validate_joints`, `validate_syntax`
- Iteration — `tune_params`, `clear_params`, `get_render_status`
- Export & open — `export_shape`, `open_shape`, `list_installed_apps`, `preview_finder`
- Plus the `shapeitup` stdlib (holes, screws/bolts/washers/inserts, bearings, extrusions, patterns, threads, joints, assembly, printHints) importable from any `.shape.ts`.

## More

Full docs, architecture notes, and the optional VSCode live-viewer extension live in the [monorepo README](https://github.com/asbis/ShapeItUp#readme).

## License

MIT
