/**
 * Tests for the Mistral Vibe config.toml helpers. The fixtures are shaped like
 * what Vibe itself writes (`vibe mcp add` emits multi-line arrays), plus the
 * neighbours an edit must not disturb: other servers, their sub-tables, and
 * comments that belong to the next section.
 */
import { describe, it, expect } from "vitest";
import { join } from "path";
import {
  VIBE_ENTRY,
  findVibeEntry,
  hasVibeEntry,
  usesInlineMcpServers,
  vibeConfigPath,
  vibeSkillDir,
  withVibeEntry,
  withoutVibeEntry,
} from "./vibe-config";

const OURS_AS_VIBE_WRITES_IT = `[[mcp_servers]]
name = "shapeitup"
startup_timeout_sec = 60.0
transport = "stdio"
command = "npx"
args = [
    "-y",
    "@shapeitup/mcp-server",
]
`;

const OTHER = `[[mcp_servers]]
name = "github"
transport = "streamable-http"
url = "https://example.com/mcp"

[mcp_servers.auth]
type = "static"
api_key_env = "GH_TOKEN"
`;

describe("paths", () => {
  it("defaults to ~/.vibe and honours VIBE_HOME", () => {
    expect(vibeConfigPath({}, "/home/u")).toBe(join("/home/u", ".vibe", "config.toml"));
    expect(vibeConfigPath({ VIBE_HOME: "/opt/vibe" }, "/home/u")).toBe(join("/opt/vibe", "config.toml"));
    expect(vibeSkillDir({}, "/home/u")).toBe(join("/home/u", ".vibe", "skills", "shapeitup"));
  });
});

describe("hasVibeEntry", () => {
  it("finds our entry in the form Vibe writes", () => {
    expect(hasVibeEntry(OURS_AS_VIBE_WRITES_IT)).toBe(true);
    expect(hasVibeEntry(`active_model = "devstral"\n\n${OTHER}\n${OURS_AS_VIBE_WRITES_IT}`)).toBe(true);
  });

  it("accepts single quotes and a trailing comment", () => {
    expect(hasVibeEntry(`[[mcp_servers]]\nname = 'shapeitup' # cad\ncommand = "npx"\n`)).toBe(true);
  });

  it("ignores other servers, lookalike names and other tables", () => {
    expect(hasVibeEntry("")).toBe(false);
    expect(hasVibeEntry(OTHER)).toBe(false);
    expect(hasVibeEntry(`[[mcp_servers]]\nname = "shapeitup-dev"\n`)).toBe(false);
    expect(hasVibeEntry(`[[agents]]\nname = "shapeitup"\n`)).toBe(false);
  });

  it("doesn't mistake a sub-table key for the server name", () => {
    const toml = `[[mcp_servers]]\nname = "other"\n\n[mcp_servers.env]\nname = "shapeitup"\n`;
    expect(hasVibeEntry(toml)).toBe(false);
  });

  it("ignores a header-looking line inside a multi-line string", () => {
    const toml = `system_prompt = """\n[[mcp_servers]]\nname = "shapeitup"\n"""\n`;
    expect(findVibeEntry(toml)).toBeUndefined();
  });

  it("reports the inline form as installed", () => {
    const inline = `mcp_servers = [{ name = "shapeitup", transport = "stdio", command = "npx" }]\n`;
    expect(usesInlineMcpServers(inline)).toBe(true);
    expect(hasVibeEntry(inline)).toBe(true);
    expect(findVibeEntry(inline)).toBeUndefined();
  });
});

describe("withVibeEntry", () => {
  it("writes just the entry into an empty or missing file", () => {
    expect(withVibeEntry("")).toBe(VIBE_ENTRY + "\n");
    expect(hasVibeEntry(withVibeEntry(""))).toBe(true);
  });

  it("appends after existing content, separated by one blank line", () => {
    const out = withVibeEntry(`active_model = "devstral"\n\n\n`);
    expect(out).toBe(`active_model = "devstral"\n\n${VIBE_ENTRY}\n`);
  });

  it("appends after a file with no trailing newline", () => {
    expect(withVibeEntry(OTHER.trimEnd())).toBe(`${OTHER.trimEnd()}\n\n${VIBE_ENTRY}\n`);
  });

  it("keeps CRLF files CRLF", () => {
    const out = withVibeEntry(`active_model = "devstral"\r\n`);
    expect(out).toBe(`active_model = "devstral"\r\n\r\n${VIBE_ENTRY.replace(/\n/g, "\r\n")}\r\n`);
  });

  it("asks for a startup timeout above Vibe's 10 s default", () => {
    const m = /startup_timeout_sec = (\d+)/.exec(VIBE_ENTRY);
    expect(Number(m?.[1])).toBeGreaterThan(10);
  });
});

describe("withoutVibeEntry", () => {
  it("returns undefined when there is nothing to remove", () => {
    expect(withoutVibeEntry(OTHER)).toBeUndefined();
  });

  it("round-trips an append", () => {
    const before = `active_model = "devstral"\n\n${OTHER}`;
    expect(withoutVibeEntry(withVibeEntry(before))).toBe(before);
  });

  it("empties a file that held only our entry", () => {
    expect(withoutVibeEntry(OURS_AS_VIBE_WRITES_IT)).toBe("");
  });

  it("removes our entry from between two others, leaving them intact", () => {
    const toml = `${OTHER}\n${OURS_AS_VIBE_WRITES_IT}\n[[mcp_servers]]\nname = "last"\n`;
    expect(withoutVibeEntry(toml)).toBe(`${OTHER}\n[[mcp_servers]]\nname = "last"\n`);
  });

  it("takes our own sub-tables with us", () => {
    const toml = `${OURS_AS_VIBE_WRITES_IT}\n[mcp_servers.env]\nDEBUG = "1"\n\n${OTHER}`;
    expect(withoutVibeEntry(toml)).toBe(OTHER);
  });

  it("leaves a comment that introduces the next section", () => {
    const toml = `${OURS_AS_VIBE_WRITES_IT}\n# Model settings\n[models]\nfoo = 1\n`;
    expect(withoutVibeEntry(toml)).toBe(`# Model settings\n[models]\nfoo = 1\n`);
  });
});
