/**
 * Mistral Vibe keeps its MCP servers as `[[mcp_servers]]` tables in TOML, at
 * `$VIBE_HOME/config.toml` (default `~/.vibe/config.toml`), and its skills
 * under `$VIBE_HOME/skills/<name>/SKILL.md`. Every other client we support
 * uses JSON, so this is the one config we edit as text.
 *
 * This is not a TOML parser. It recognizes table headers, which is all it
 * takes to find one array-of-tables entry, append one, or cut one out without
 * touching a byte of anything else in the file. Appending is always valid
 * TOML — an `[[mcp_servers]]` header at the end of a file adds an element no
 * matter what precedes it — except when the file already declares
 * `mcp_servers = [...]` inline; `usesInlineMcpServers` detects that case so
 * callers can refuse to write.
 */

import * as path from "path";
import * as os from "os";

export const VIBE_SERVER_NAME = "shapeitup";

/**
 * The entry we append. `startup_timeout_sec` is not decoration: Vibe's default
 * is 10 s, and the first `npx -y` run downloads the package (~17 s measured
 * from an empty npm cache), so without it a fresh install times out on its
 * very first launch.
 */
export const VIBE_ENTRY = [
  "[[mcp_servers]]",
  `name = "${VIBE_SERVER_NAME}"`,
  `transport = "stdio"`,
  `command = "npx"`,
  `args = ["-y", "@shapeitup/mcp-server"]`,
  "startup_timeout_sec = 60",
].join("\n");

export function vibeHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return env.VIBE_HOME || path.join(home, ".vibe");
}

export function vibeConfigPath(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(vibeHome(env, home), "config.toml");
}

export function vibeSkillDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  return path.join(vibeHome(env, home), "skills", VIBE_SERVER_NAME);
}

// `[table]` or `[[array.of.tables]]`, keys bare or quoted. Requiring a key
// character set keeps array values that start a line (`  [1, 2]`) from
// reading as headers.
const HEADER = /^\s*(\[\[|\[)\s*([A-Za-z0-9_\-."' ]+?)\s*(\]\]|\])\s*(#.*)?$/;
const NAME_IS_OURS = new RegExp(`^\\s*name\\s*=\\s*(["'])${VIBE_SERVER_NAME}\\1\\s*(#.*)?$`);
const INLINE_MCP_SERVERS = /^\s*mcp_servers\s*=/m;

interface Header {
  line: number;
  arrayOfTables: boolean;
  key: string;
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function headers(lines: string[]): Header[] {
  const out: Header[] = [];
  // Delimiter of the multi-line string we are inside, if any: a line of
  // prompt text that happens to start with `[` is not a table.
  let open: string | undefined;
  lines.forEach((line, i) => {
    const startedInside = open !== undefined;
    for (const delim of ['"""', "'''"]) {
      if (open && open !== delim) continue;
      if ((line.split(delim).length - 1) % 2 === 1) open = open ? undefined : delim;
    }
    if (startedInside || open) return;
    const m = HEADER.exec(line);
    if (!m) return;
    const arrayOfTables = m[1] === "[[";
    if (arrayOfTables !== (m[3] === "]]")) return;
    out.push({ line: i, arrayOfTables, key: m[2].replace(/\s*\.\s*/g, ".") });
  });
  return out;
}

/**
 * Line range `[start, end)` of our `[[mcp_servers]]` entry, including any
 * `[mcp_servers.*]` sub-tables that belong to it. Trailing blank and comment
 * lines are left out of the range: a comment directly above the next header
 * describes that header, not us.
 */
export function findVibeEntry(text: string): { start: number; end: number } | undefined {
  const lines = splitLines(text);
  const hs = headers(lines);
  for (let h = 0; h < hs.length; h++) {
    if (!hs[h].arrayOfTables || hs[h].key !== "mcp_servers") continue;
    let next = h + 1;
    // Our own keys run up to the next header; `name` lives there, not in a
    // sub-table (an env var called `name` must not count).
    const ownEnd = next < hs.length ? hs[next].line : lines.length;
    const ours = lines.slice(hs[h].line + 1, ownEnd).some((l) => NAME_IS_OURS.test(l));
    while (next < hs.length && !hs[next].arrayOfTables && hs[next].key.startsWith("mcp_servers.")) {
      next++;
    }
    if (!ours) continue;
    let end = next < hs.length ? hs[next].line : lines.length;
    while (end > hs[h].line + 1 && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
    return { start: hs[h].line, end };
  }
  return undefined;
}

export function usesInlineMcpServers(text: string): boolean {
  return INLINE_MCP_SERVERS.test(text);
}

/**
 * Whether `config.toml` registers ShapeItUp. Read-only, so it accepts the
 * inline form too: there we can't edit, but we can still report "installed".
 */
export function hasVibeEntry(text: string): boolean {
  if (findVibeEntry(text)) return true;
  if (!usesInlineMcpServers(text)) return false;
  return new RegExp(`\\bname\\s*=\\s*(["'])${VIBE_SERVER_NAME}\\1`).test(text);
}

/** `text` with our entry appended. Callers check `usesInlineMcpServers` first. */
export function withVibeEntry(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entry = VIBE_ENTRY.split("\n").join(eol) + eol;
  if (text.trim() === "") return entry;
  return text.replace(/(\r?\n)*$/, "") + eol + eol + entry;
}

/** `text` with our entry removed, or undefined if there is none to remove. */
export function withoutVibeEntry(text: string): string | undefined {
  const range = findVibeEntry(text);
  if (!range) return undefined;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = splitLines(text);
  let { start, end } = range;
  // Take one separating blank line with us so removal doesn't leave a gap.
  if (start > 0 && lines[start - 1].trim() === "") start--;
  else if (end < lines.length && lines[end].trim() === "") end++;
  lines.splice(start, end - start);
  return lines.join(eol);
}
