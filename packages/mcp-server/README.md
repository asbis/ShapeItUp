# @shapeitup/mcp-server

Model Context Protocol server for [ShapeItUp](https://github.com/asbis/ShapeItUp) — scripted CAD tools (Replicad / OpenCascade) for Claude Code, Cursor, Claude Desktop, Gemini CLI, and any other MCP client.

## Install

You don't. Use `npx`:

```bash
npx -y @shapeitup/mcp-server
```

## Register with your MCP client

### Claude Code

```bash
claude mcp add shapeitup -s user -- npx -y @shapeitup/mcp-server
```

### Cursor / Claude Desktop / Gemini CLI

Add this to your client's MCP config:

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

### One-shot AI install

Paste [INSTALL.md](https://github.com/asbis/ShapeItUp/blob/master/INSTALL.md) into any agentic CLI and it will detect your clients and register ShapeItUp with consent.

## What you get

Nine MCP tools for creating, modifying, rendering, and exporting 3D CAD models from TypeScript `.shape.ts` files. See the [main repo](https://github.com/asbis/ShapeItUp) for the full feature list.

## Requirements

- Node 20+
- macOS, Linux, or Windows (WASM — no native binaries)

## License

MIT
