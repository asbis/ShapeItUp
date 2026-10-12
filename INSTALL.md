# ShapeItUp — Install Prompt for AI Agents

> **For humans:** paste the whole of this file into any agentic CLI
> (Claude Code, Cursor agent, Gemini, Mistral Vibe, Codex, etc.) and tell it to follow
> the instructions. The agent will detect your MCP clients and register
> ShapeItUp with your explicit approval.

---

You are installing the **ShapeItUp MCP server** for the user. ShapeItUp is a
scripted-CAD tool that lets users (and you) create 3D models from TypeScript
and visually verify them. This file is the single source of truth for how to
register the server with every MCP client.

## The server

| Field | Value |
|---|---|
| Name | `shapeitup` |
| Transport | stdio |
| Command | `npx` |
| Args | `["-y", "@shapeitup/mcp-server"]` |
| Skill source | `https://raw.githubusercontent.com/asbis/ShapeItUp/master/skills/shapeitup/SKILL.md` |

Node 20+ is required. The `npx -y @shapeitup/mcp-server` form auto-fetches the
latest published version on first run and caches it; no manual install needed.

## Procedure

Follow these steps in order. **Ask the user before each file write** — never
modify their shell config, MCP client config, or home directory without an
explicit OK. Summarize each diff before applying it.

### Step 1 — Detect which MCP clients the user has

Check for each of these (absence of one is fine — just skip that client):

- **Claude Code CLI**: `which claude` succeeds, OR `~/.claude.json` exists,
  OR `~/.claude/` exists.
- **Codex** (CLI, IDE extension or ChatGPT desktop app — they share one
  config): `which codex` succeeds, OR `~/.codex/` exists.
- **Cursor**: `~/.cursor/mcp.json` exists, OR the Cursor app is installed
  (`/Applications/Cursor.app` on macOS, `%LOCALAPPDATA%\Programs\cursor` on
  Windows).
- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`
  on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
- **Gemini CLI**: `which gemini` succeeds, OR `~/.gemini/` exists.
- **Mistral Vibe** (CLI or VS Code extension): `which vibe` succeeds, OR
  `~/.vibe/` exists (`$VIBE_HOME` instead of `~/.vibe` when it is set).
- **VS Code / Copilot Agent Mode**: if the ShapeItUp VS Code extension is
  installed, the MCP server is already registered via the native provider API
  — **skip this client**, no action needed.

Report back which clients you found before proceeding.

### Step 2 — Register for each detected client

For each client the user wants to register (ask them), do the following:

#### Claude Code CLI

Preferred: install the plugin. It brings the MCP server and the skill
together, and `claude plugin marketplace update` keeps both current, so you
can skip this client in Step 3.

```bash
claude plugin marketplace add asbis/ShapeItUp
claude plugin install shapeitup@shapeitup
```

If `claude mcp list` already shows a `shapeitup` server, the user added it by
hand earlier. Ask whether to keep that one or switch to the plugin; with both,
every tool is listed twice. `claude mcp remove shapeitup` removes the old one.

If `claude plugin` isn't available (older Claude Code), register the server
alone:

```bash
claude mcp add shapeitup -s user -- npx -y @shapeitup/mcp-server
```

Fallback if `claude mcp add` isn't available either: merge this into `~/.claude.json`:

```json
{
  "mcpServers": {
    "shapeitup": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@shapeitup/mcp-server"]
    }
  }
}
```

**Never overwrite the whole file** — read existing JSON, merge the
`mcpServers.shapeitup` entry, write back. If the file is malformed, stop and
tell the user.

#### Codex

Preferred: use the CLI.

```bash
codex mcp add shapeitup -- npx -y @shapeitup/mcp-server
```

Then open `~/.codex/config.toml` and make sure the `[mcp_servers.shapeitup]`
table carries both timeouts. Add the two keys if they are missing; leave
everything else in the file alone:

```toml
[mcp_servers.shapeitup]
command = "npx"
args = ["-y", "@shapeitup/mcp-server"]
startup_timeout_sec = 60
tool_timeout_sec = 180
```

Fallback if `codex` isn't on the PATH (the desktop app alone doesn't add it):
append that table to `~/.codex/config.toml`, creating the file if missing. If
the file already has a `[mcp_servers.shapeitup]` table, edit it instead —
TOML rejects a table defined twice.

Keep both timeouts. Codex gives a server 10 s to start by default, which is
shorter than the first `npx` download, and a tool 60 s, which a cold render of
complex geometry can exceed. Tell the user to restart Codex.

#### Cursor

Merge into `~/.cursor/mcp.json` (create if missing):

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

#### Claude Desktop

Merge into the platform-specific config file listed in Step 1. Same shape as
the Cursor snippet. Then tell the user to restart Claude Desktop.

#### Gemini CLI

Preferred: install the extension from GitHub, which `gemini extensions update`
can then keep current.

```bash
gemini extensions install https://github.com/asbis/ShapeItUp
```

Fallback if that fails: create `~/.gemini/extensions/shapeitup/gemini-extension.json`:

```json
{
  "name": "shapeitup",
  "version": "1.0.0",
  "description": "ShapeItUp CAD — scripted 3D modeling with Replicad",
  "mcpServers": {
    "shapeitup": {
      "command": "npx",
      "args": ["-y", "@shapeitup/mcp-server"]
    }
  }
}
```

#### Mistral Vibe

The config is TOML. If `~/.vibe/config.toml` already has an `[[mcp_servers]]`
entry with `name = "shapeitup"`, skip this client. Otherwise append (create the
file if missing; never rewrite what is already there):

```toml
[[mcp_servers]]
name = "shapeitup"
transport = "stdio"
command = "npx"
args = ["-y", "@shapeitup/mcp-server"]
startup_timeout_sec = 60
```

If the file declares `mcp_servers = [...]` as an inline array instead, add the
same fields to that array as an inline table rather than appending, since TOML
does not allow both forms. Keep `startup_timeout_sec`: Vibe's default of 10 s
is shorter than the first `npx` download. Tell the user to run `/reload` in Vibe.

### Step 3 — Install the Claude Code skill (optional but recommended)

If Claude Code is present and you registered the server with `claude mcp add`
rather than the plugin, fetch `SKILL.md` from the URL in the table above
and write it to `~/.claude/skills/shapeitup/SKILL.md`. This gives Claude a
full Replicad API reference when working on `.shape.ts` files. Ask first.

```bash
mkdir -p ~/.claude/skills/shapeitup
curl -fsSL https://raw.githubusercontent.com/asbis/ShapeItUp/master/skills/shapeitup/SKILL.md \
  -o ~/.claude/skills/shapeitup/SKILL.md
```

If Mistral Vibe is present, the same file works there unchanged: write it to
`~/.vibe/skills/shapeitup/SKILL.md` (ask first). Vibe picks it up on `/reload`.

If Codex is present, write the same file to `~/.agents/skills/shapeitup/SKILL.md`
(ask first). That is Codex's user-level skills directory; it picks up new
skills without a restart.

### Step 4 — Verify

After registration:

1. For CLI clients, ask the user to restart their agent session (or run
   `claude mcp list` / `codex mcp list` to confirm `shapeitup` is listed).
2. Tell the user to try a prompt like: *"Use the ShapeItUp MCP to create a
   simple 20mm cube and render it."* If the agent reports that the `shapeitup`
   tools are available, installation succeeded.

### Step 5 — Report back

Summarize what you did: which clients you registered, which you skipped, and
whether the skill was installed. If any step failed, report the error verbatim
so the user can troubleshoot.

---

## Uninstall

To remove ShapeItUp from an MCP client, delete the `shapeitup` entry from the
relevant config file (for Codex, the `[mcp_servers.shapeitup]` table in
`~/.codex/config.toml`), or run `claude plugin uninstall shapeitup@shapeitup`
(or `claude mcp remove shapeitup`) for Claude Code,
`gemini extensions uninstall shapeitup` for Gemini CLI and
`vibe mcp remove shapeitup` for Mistral Vibe. No global state is left
behind beyond those config entries and the optional skill files at
`~/.claude/skills/shapeitup/`, `~/.vibe/skills/shapeitup/` and
`~/.agents/skills/shapeitup/`.
