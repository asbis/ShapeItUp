import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync, watch as fsWatch } from "fs";
import { join, resolve, basename, dirname, isAbsolute, sep } from "path";
import { homedir } from "os";
import {
  appendScreenshotMetadata,
  canonicalParamsKey,
  executeShapeFile,
  exportLastToFile,
  getCore,
  getLastFileName,
  getLastParts,
  lookupMeshCache,
  populateMeshCache,
  readSourceForCacheKey,
  resetCore,
  type EngineStatus,
  type ShapeProperties,
} from "./engine.js";
import { autoBootstrapIfNeeded, setupShapeProject } from "./project-setup.js";
import { renderPartsToSvg } from "./svg-renderer.js";
import { svgToPng } from "./svg-to-png.js";
import {
  extractGeometry,
  extractCollisions,
  extractJoints,
  type GeometryFormat,
  type GeometryFacesFilter,
  type GeometryEdgesFilter,
} from "./verify-helpers.js";

/**
 * Shared globalStorage dir with the VSCode extension. Both processes write and
 * read `shapeitup-status.json` here, so MCP-driven renders and extension-driven
 * renders stay interchangeable. This is the only place we "touch" VSCode: it's
 * a file location, not a runtime dependency.
 */
const GLOBAL_STORAGE = join(
  homedir(),
  process.platform === "win32"
    ? "AppData/Roaming/Code/User/globalStorage/shapeitup.shapeitup-vscode"
    : ".config/Code/User/globalStorage/shapeitup.shapeitup-vscode"
);

// --- File-based IPC to the extension (optional, best-effort) ---
// Only used for UI-sync commands: set_render_mode, toggle_dimensions,
// list_installed_apps, open-in-app. If VSCode isn't running these report that
// honestly — everything else works without VSCode.

const ID_PREFIX = `${process.pid}-${Date.now().toString(36)}-`;
let commandCounter = 0;

// Extend-while-alive grace for waitForResult: if the nominal timeout expires
// but the extension heartbeat is still fresh, grant ONE additional window of
// this length before giving up. Matches the reality of cold OCCT renders —
// the extension is still working, MCP just needs to be patient. Granted at
// most once per waitForResult call, so a truly stuck render eventually fails.
const WAIT_GRACE_MS = 30_000;

// Set by waitForResult on the failing path so the caller can distinguish
// "extension crashed / disappeared" from "extension is alive but render is
// slower than the budget". Reset to null on every successful resolution.
// Module-level rather than a return-shape change to keep the diff minimal
// across the several callers (list_installed_apps, open-in-app, export_shape,
// preview_finder, render_preview).
let lastWaitTimeoutReason: "dead" | "slow" | null = null;

// Workspace-resolution note throttle. When `create_shape` (and any future
// handler with similar logic) falls back to the VSCode workspace because the
// shell cwd disagrees, we surface a one-liner telling the caller which dir
// was chosen. Emitting that line on every call is noise — agents learn it
// once and then every subsequent response carries a stale-feeling reminder.
// Keep a per-process Set of workspace roots we've already announced and
// suppress the note on repeat hits. Case-folded so Windows "C:\" vs "c:\"
// collide correctly.
const _emittedWorkspaceRoots = new Set<string>();

/**
 * P11 fix: MCP-server's OWN package.json version. When the server is installed
 * via `npx -y @shapeitup/mcp-server`, only its own dist/ + package.json ship —
 * the old probe for `packages/extension/package.json` always missed, which
 * gave agents an always-wrong `[shapeitup vunknown]` footer. This is the ONE
 * version that is always present: it's the package the user actually invoked.
 *
 * Note: this is just the MCP server's version. The extension's version is
 * reported separately via the heartbeat (see getViewerStatus / getVersionTag)
 * so the combined footer reflects both sides of the stack honestly.
 */
const MCP_SERVER_VERSION: string = (() => {
  // Candidates in order of likelihood for each install shape:
  //  1. Bundled dist (packages/mcp-server/dist/mcp-server.mjs → ../package.json)
  //  2. Dev / tsc (packages/mcp-server/src/tools.ts → ../package.json)
  //  3. Defensive fallback against process.cwd()
  const candidates: string[] = [];
  try {
    candidates.push(join(__dirname, "..", "package.json"));
    candidates.push(join(__dirname, "..", "..", "package.json"));
    candidates.push(resolve(process.cwd(), "packages", "mcp-server", "package.json"));
  } catch {
    // __dirname shouldn't throw but be defensive.
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (
          pkg &&
          typeof pkg.name === "string" &&
          pkg.name.includes("mcp-server") &&
          typeof pkg.version === "string" &&
          pkg.version.length > 0
        ) {
          return pkg.version;
        }
      }
    } catch {
      // ignore and try the next candidate
    }
  }
  return "unknown";
})();

/**
 * P11 fix: snapshot of viewer connectivity derived from live heartbeats.
 * Recomputed on each call (no module-level cache) so "disconnected" reflects
 * the current state — a user who closes VS Code between calls gets an
 * accurate footer on the next tool invocation rather than a cached "connected".
 */
export function getViewerStatus(): {
  alive: boolean;
  viewerReady: boolean;
  extensionVersion?: string;
} {
  const all = readAllHeartbeats();
  if (all.length === 0) {
    return { alive: false, viewerReady: false };
  }
  const now = Date.now();
  // Match isExtensionAlive()'s 15_000ms window so the two helpers agree on
  // liveness — a mismatch would let `get_render_status` report "connected"
  // while `render_preview` refuses because its check disagrees.
  const fresh = all.filter((hb) => now - (hb.timestamp ?? 0) < 15_000);
  const source = fresh.length > 0 ? fresh : all;
  // Prefer a heartbeat that actually reports viewerReady=true — in multi-window
  // setups the MCP-owning window is usually the one with an open viewer, not
  // the backgrounded one that briefly lost focus.
  const ready = source.find((hb) => hb.viewerReady === true);
  const pick = ready ?? source[0];
  const extensionVersion =
    source.find((hb) => typeof hb.extensionVersion === "string" && hb.extensionVersion.length > 0)?.extensionVersion;
  return {
    alive: fresh.length > 0,
    viewerReady: !!pick?.viewerReady,
    extensionVersion,
  };
}

/**
 * P11 fix: build the version footer live on each call. Never emits the literal
 * "unknown" — when the extension half of the stack is disconnected we say so
 * explicitly so agents don't chase phantom version drift in bug reports.
 *
 * Formats:
 *   happy path:      [shapeitup mcp v1.3.0 · ext v1.5.2]
 *   extension down:  [shapeitup mcp v1.3.0 · extension-disconnected]
 *   both unknown:    [shapeitup mcp vdev · extension-disconnected] — mcp
 *                    "unknown" falls back to "dev" so the footer never
 *                    contains the confusing literal word "unknown".
 */
export function getVersionTag(): string {
  const status = getViewerStatus();
  const mcpV = MCP_SERVER_VERSION !== "unknown" ? MCP_SERVER_VERSION : "dev";
  const extSuffix = status.alive && status.extensionVersion
    ? `\u00b7 ext v${status.extensionVersion}`
    : "\u00b7 extension-disconnected";
  return `\n[shapeitup mcp v${mcpV} ${extSuffix}]`;
}

/**
 * P11 fix: human-readable viewer-status block appended to get_render_status.
 * Three-state report: connected+ready, connected+loading, disconnected. The
 * extension-version line only appears when we have one — on pre-P11 extension
 * builds the heartbeat lacks it, and "Extension version: unknown" is worse
 * than silent.
 */
export function formatViewerBlock(): string {
  const s = getViewerStatus();
  let line: string;
  if (!s.alive) line = "disconnected";
  else if (s.viewerReady) line = "connected (ready)";
  else line = "connected (loading)";
  const versionLine = s.extensionVersion
    ? `\nExtension version: ${s.extensionVersion}`
    : "";
  return `\nViewer: ${line}${versionLine}`;
}

/**
 * P1 fix: when a webview-worker error message contains references to Node-only
 * globals (`require`, `__dirname`, `process.*`), append a one-line hint
 * reminding the caller that `.shape.ts` files run in BOTH the Node MCP engine
 * AND a Web Worker inside the viewer. ESM imports are the portable choice.
 *
 * Keeps the hint terse — full docs live in the skill; this is just enough
 * context for an agent that just hit the error to self-correct.
 */
function formatWorkerErrorMessage(
  message: string,
  stack?: string,
  operation?: string,
): string {
  const parts: string[] = [`Screenshot failed: ${message}`];
  if (operation) parts.push(`Operation: ${operation}`);
  if (stack) {
    const trimmed = stack
      .split("\n")
      .slice(0, 4)
      .map((l) => `  ${l.trim()}`)
      .filter((l) => l.trim().length > 2)
      .join("\n");
    if (trimmed.length > 0) parts.push(`Stack:\n${trimmed}`);
  }
  if (/require is not defined|__dirname|process\./.test(message)) {
    parts.push(
      "CommonJS restriction: `.shape.ts` files run in both Node (MCP) and a Web Worker (viewer). `require`, `__dirname`, `process.*`, and Node-only APIs are not available in the viewer — use ESM `import` instead.",
    );
  }
  return parts.join("\n");
}

/**
 * P1 fix: read shapeitup-viewer-error.json (written by viewer-provider.ts on
 * webview-worker error). Returns the payload when its timestamp is NEWER than
 * shapeitup-status.json's timestamp — that's the signal that the webview
 * picked up an error the engine never saw.
 */
function readViewerErrorIfNewer(globalStorage: string): { message: string; stack?: string; operation?: string; timestamp: number; fileName?: string } | null {
  try {
    const errPath = join(globalStorage, "shapeitup-viewer-error.json");
    if (!existsSync(errPath)) return null;
    const err = JSON.parse(readFileSync(errPath, "utf-8"));
    if (typeof err?.message !== "string" || typeof err?.timestamp !== "number") return null;
    const statusPath = join(globalStorage, "shapeitup-status.json");
    let statusTs = 0;
    try {
      const s = JSON.parse(readFileSync(statusPath, "utf-8"));
      const t = typeof s?.timestamp === "string" ? Date.parse(s.timestamp) : (typeof s?.timestamp === "number" ? s.timestamp : 0);
      if (Number.isFinite(t)) statusTs = t;
    } catch {}
    if (err.timestamp > statusTs) return err;
    return null;
  } catch {
    return null;
  }
}


function nextCommandId(): string {
  return ID_PREFIX + (++commandCounter);
}

function sendExtensionCommand(command: string, params: Record<string, any> = {}): string | undefined {
  try {
    mkdirSync(GLOBAL_STORAGE, { recursive: true });
    const cmdFile = join(GLOBAL_STORAGE, "mcp-command.json");
    const _id = nextCommandId();
    writeFileSync(cmdFile, JSON.stringify({ command, _id, ...params }));
    return _id;
  } catch {
    return undefined;
  }
}

function readExtensionResult(): any {
  try {
    const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
    if (existsSync(resultFile)) {
      const data = readFileSync(resultFile, "utf-8");
      return JSON.parse(data);
    }
  } catch {}
  return null;
}

function readHeartbeat(): { timestamp?: number; workspaceRoots?: string[] } | null {
  try {
    const hb = join(GLOBAL_STORAGE, "shapeitup-heartbeat.json");
    if (!existsSync(hb)) return null;
    return JSON.parse(readFileSync(hb, "utf-8"));
  } catch {
    return null;
  }
}

interface WindowHeartbeat {
  pid: number;
  timestamp: number;
  workspaceRoots: string[];
  /**
   * P11 fix: VSCode extension's package version (e.g. "1.5.2"). Optional so
   * older extension builds that don't include it still parse cleanly — the
   * consumer treats absence as "extension too old to report a version".
   */
  extensionVersion?: string;
  /**
   * P11 fix: whether the extension's webview is mounted AND its worker has
   * finished WASM init. Optional for back-compat; absence is reported as
   * "extension connected, viewer state unknown".
   */
  viewerReady?: boolean;
}

/**
 * Read all per-pid heartbeat files (`shapeitup-heartbeat-<pid>.json`). Each
 * VSCode window writes its own so the MCP server can enumerate live windows
 * and compute which ONE owns a given file. Stale heartbeats (> 10s old) are
 * filtered out so a crashed window doesn't get routed commands.
 *
 * Falls back to the legacy single-file heartbeat when no per-pid files exist,
 * so older extension builds stay functional — in that case we only know about
 * one window's worth of workspace roots.
 */
function readAllHeartbeats(): WindowHeartbeat[] {
  const out: WindowHeartbeat[] = [];
  try {
    if (!existsSync(GLOBAL_STORAGE)) return out;
    const now = Date.now();
    for (const name of readdirSync(GLOBAL_STORAGE)) {
      if (!name.startsWith("shapeitup-heartbeat-") || !name.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(GLOBAL_STORAGE, name), "utf-8"));
        if (
          typeof data?.timestamp === "number" &&
          typeof data?.pid === "number" &&
          Array.isArray(data?.workspaceRoots) &&
          now - data.timestamp < 10_000
        ) {
          out.push({
            pid: data.pid,
            timestamp: data.timestamp,
            workspaceRoots: data.workspaceRoots as string[],
            extensionVersion: typeof data?.extensionVersion === "string" ? data.extensionVersion : undefined,
            viewerReady: typeof data?.viewerReady === "boolean" ? data.viewerReady : undefined,
          });
        }
      } catch {}
    }
  } catch {}
  if (out.length === 0) {
    // Back-compat: older extensions only wrote the legacy single-file heartbeat.
    const legacy = readHeartbeat();
    if (legacy && typeof legacy.timestamp === "number" && Array.isArray(legacy.workspaceRoots)) {
      out.push({
        pid: -1,
        timestamp: legacy.timestamp,
        workspaceRoots: legacy.workspaceRoots,
      });
    }
  }
  return out;
}

function isExtensionAlive(): boolean {
  // Aggregate across per-pid heartbeats — multi-window setups often have one
  // stale window (minimized / background) alongside a fresh foreground one,
  // and we want ANY live window to count as "extension alive". Raised from
  // 5s to 15s because 5s fires false-negatives during momentary system stalls
  // (Docker/VM starts, browser GC, macOS App Nap on backgrounded VS Code).
  const all = readAllHeartbeats();
  const now = Date.now();
  if (all.length > 0) {
    return all.some((hb) => now - (hb.timestamp ?? 0) < 15_000);
  }
  const hb = readHeartbeat();
  if (!hb) return false;
  return now - (hb.timestamp ?? 0) < 15_000;
}

/**
 * Returns the list of VSCode workspace roots reported by the most recent
 * heartbeat, or an empty array when no extension is running / heartbeat is
 * missing. Unlike `isExtensionAlive()`, this does NOT require the heartbeat to
 * be fresh — multi-window VSCode setups can have stale heartbeats from a
 * window that lost focus but still own files the agent is working on. We
 * treat *any* heartbeat-reported workspace as a candidate for path resolution;
 * liveness is a separate concern enforced elsewhere (render tools, etc.).
 *
 * When per-pid heartbeats exist, aggregate workspace roots across ALL live
 * windows so path resolution can probe every workspace in the user's
 * multi-window setup (not just whichever window happened to write the legacy
 * single-file heartbeat last).
 */
function getHeartbeatWorkspaceRoots(): string[] {
  const all = readAllHeartbeats();
  if (all.length > 0) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const hb of all) {
      for (const root of hb.workspaceRoots) {
        const key = resolve(root).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(root);
        }
      }
    }
    return out;
  }
  const hb = readHeartbeat();
  return Array.isArray(hb?.workspaceRoots) ? (hb!.workspaceRoots as string[]) : [];
}

/**
 * Multi-window cross-talk fix: given an absolute file path, return the single
 * workspace root (from any live window's heartbeat) that CONTAINS the file.
 * Returns undefined when no live window owns the file — in that case callers
 * should NOT add a targetWorkspaceRoot hint and will fall back to the legacy
 * arbitration inside the extension.
 *
 * When multiple windows' workspaces contain the file (e.g. nested folders
 * opened in two windows), the deepest (longest path) match is returned — the
 * innermost workspace is the most specific owner.
 */
export function computeTargetWorkspaceRoot(filePath: string): string | undefined {
  if (!isAbsolute(filePath)) return undefined;
  const fp = resolve(filePath).toLowerCase();
  const all = readAllHeartbeats();
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const hb of all) {
    for (const root of hb.workspaceRoots) {
      const normalized = resolve(root).toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const withSep = normalized.endsWith(sep.toLowerCase()) || normalized.endsWith("/")
        ? normalized
        : normalized + sep.toLowerCase();
      const withFwdSep = normalized.endsWith("/") ? normalized : normalized + "/";
      if (fp === normalized || fp.startsWith(withSep) || fp.startsWith(withFwdSep)) {
        candidates.push(root);
      }
    }
  }
  if (candidates.length === 0) return undefined;
  // Pick the deepest (longest) match so nested workspaces resolve to the
  // inner workspace, not an outer wrapper. A file in `drivhus/ShapeItUp/x.ts`
  // should land at ShapeItUp, not drivhus.
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

/**
 * Verifies that a resolved shape path belongs to a workspace currently owned by
 * some live extension host. Returns null if ownership is fine, or an MCP error
 * response if the shape is in a workspace that no live host owns.
 *
 * This is the single source of truth — both render_preview and preview_finder
 * must call it for EVERY invocation, not only the explicit-filePath branch.
 * Uses readAllHeartbeats() so a multi-window setup is handled correctly: if
 * *any* live window owns the file we're fine. When there are no live windows
 * reporting workspace roots, we assume a single-window setup and defer to the
 * extension's own arbitration.
 */
function assertWorkspaceOwned(source: string): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const wsRoots = getHeartbeatWorkspaceRoots();
  if (wsRoots.length === 0) return null; // No heartbeat — assume single-window setup, extension will arbitrate
  const sourceAbs = resolve(source).toLowerCase();
  const inAnyWs = wsRoots.some((r) => {
    const rAbs = resolve(r).toLowerCase();
    return sourceAbs === rAbs || sourceAbs.startsWith(rAbs + sep.toLowerCase());
  });
  if (inAnyWs) return null;
  return {
    content: [{
      type: "text" as const,
      text: `Shape is in a workspace not owned by any live ShapeItUp window. Open the correct workspace in VSCode, or close the other window.\n\nShape is at ${source}\nLive workspace roots: ${wsRoots.join(", ") || "(none)"}`,
    }],
    isError: true,
  };
}

/**
 * Runs `op` with a resolved file path. If `code` is provided, writes it to a
 * temp .shape.ts in `workingDir` (or a private globalStorage path when
 * unspecified), runs `op` with that path, and always cleans up the temp file.
 * Otherwise uses `filePath` directly.
 *
 * Used by preview_shape, preview_finder, and check_collisions so they all
 * accept either `filePath` OR `code` — no need to preview_shape first and hope
 * the temp file survives long enough for the follow-up call.
 */
async function withShapeFile<T>(
  args: { filePath?: string; code?: string; workingDir?: string },
  op: (absPath: string) => Promise<T>,
): Promise<T> {
  if (args.code !== undefined) {
    let dir: string;
    if (args.workingDir !== undefined) {
      // Same rule as every other path arg: relative paths probe workspace roots.
      dir = resolveShapePath(args.workingDir);
    } else {
      // Default: isolated globalStorage snippets dir — matches preview_shape's
      // behavior when `workingDir` is omitted.
      dir = join(GLOBAL_STORAGE, "preview-snippets");
      mkdirSync(dir, { recursive: true });
    }
    const stamp = Date.now() + "-" + Math.floor(Math.random() * 100000);
    const tempPath = join(dir, `.shapeitup-snippet-${stamp}.shape.ts`);
    writeFileSync(tempPath, args.code, "utf-8");
    try {
      return await op(tempPath);
    } finally {
      try { unlinkSync(tempPath); } catch {}
    }
  }
  if (!args.filePath) throw new Error("Either `filePath` or `code` must be provided.");
  return op(resolveShapePath(args.filePath));
}

/**
 * Where should a `create_shape` / `list_shapes` call default to when the caller
 * doesn't pass a directory? `process.cwd()` is wrong: when VSCode or Claude
 * Code spawns the MCP stdio child, cwd is wherever node was launched from
 * (commonly the extension's install dir or the user's home), so files "leak"
 * outside the user's workspace. The VSCode extension writes its
 * workspaceRoots into the heartbeat — prefer the first one when fresh, and
 * fall back to cwd only if the extension isn't running at all.
 */
function getDefaultDirectory(): string {
  const hb = readHeartbeat();
  if (hb && Date.now() - (hb.timestamp ?? 0) < 5000) {
    const root = hb.workspaceRoots?.[0];
    if (root) return root;
  }
  return process.cwd();
}

/**
 * Resolve a user-supplied `filePath` argument to an absolute path. Unified
 * precedence for EVERY tool (create/modify/open/read/delete/list + all
 * render/preview variants):
 *   1. Absolute path — pass through `resolve()` unchanged.
 *   2. Relative path — probe each heartbeat-reported VSCode workspace root in
 *      order; the first one where `resolve(wsRoot, filePath)` exists wins.
 *      This means the agent doesn't need to know which VSCode window has
 *      focus: whichever workspace actually contains the file services the
 *      request. No-match falls through.
 *   3. Fallback — resolve against `process.cwd()`.
 *
 * Motivation: plain `resolve(filePath)` is wrong for stdio MCP children
 * because cwd is usually the extension's install dir / user's home, not the
 * workspace. A heartbeat-first policy that only consulted the FIRST workspace
 * (the previous implementation) broke multi-workspace setups where the file
 * lives in the second window. The `existsSync` probe disambiguates safely —
 * creating a NEW file in one workspace still works because only that workspace's
 * resolution will match on subsequent calls.
 */
function resolveShapePath(filePath: string): string {
  if (isAbsolute(filePath)) return resolve(filePath);
  const wsRoots = getHeartbeatWorkspaceRoots();
  for (const root of wsRoots) {
    const candidate = resolve(root, filePath);
    if (existsSync(candidate)) return candidate;
  }
  // No workspace owns the file. Fall back to cwd — callers will hit a
  // "File not found" check against the returned absolute path and can
  // disambiguate from there. We used to anchor to the first workspace root
  // here too, but that meant a typo like "test-feedback/foo.shape.ts"
  // (missing the `examples/` prefix) would deterministically resolve to
  // `<root>/test-feedback/foo.shape.ts` — wrong directory, confusing error.
  return resolve(process.cwd(), filePath);
}

async function waitForResult(commandId: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  let aliveChecks = 0;
  let deadline = start + timeoutMs;
  let graceGranted = false;
  lastWaitTimeoutReason = null;

  // T6.B: watch the parent directory for writes to mcp-result.json; race each
  // watch event against a 250ms safety backstop so we don't stall when the OS
  // fs.watch notification fires late or is suppressed (e.g. network drives).
  // We watch the DIRECTORY rather than the file so fs.watch doesn't error on a
  // not-yet-existing result file, and so we receive the event on every write
  // (file-watches on Linux can miss subsequent writes after a rename).
  const watchDir = GLOBAL_STORAGE;

  /**
   * Wait for EITHER a fs.watch change event on watchDir OR a 250ms timeout.
   * Returns a promise that resolves when either fires.
   */
  function waitForWriteOrBackstop(): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          try { watcher.close(); } catch {}
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(settle, 250);
      let watcher: ReturnType<typeof fsWatch>;
      try {
        watcher = fsWatch(watchDir, (_event: string, filename: string | null) => {
          if (filename === "mcp-result.json" || filename === null) settle();
        });
        watcher.on("error", settle);
      } catch {
        // fs.watch unavailable (e.g. Docker tmpfs) — fall through to backstop.
        clearTimeout(timer);
        setTimeout(resolve, 250);
      }
    });
  }

  while (true) {
    if (Date.now() >= deadline) {
      // Deadline reached. If the extension still looks alive AND we haven't
      // already extended once, grant a single grace window — a cold OCCT
      // render on complex geometry can legitimately overshoot the initial
      // budget while the extension is still making progress.
      if (!graceGranted && isExtensionAlive()) {
        graceGranted = true;
        deadline += WAIT_GRACE_MS;
        continue;
      }
      // Give up. Record why so the caller can shape the user-facing message.
      lastWaitTimeoutReason = isExtensionAlive() ? "slow" : "dead";
      return null;
    }
    // Wait for a write event or the 250ms backstop — whichever comes first.
    await waitForWriteOrBackstop();
    const result = readExtensionResult();
    if (result && result._id === commandId) {
      lastWaitTimeoutReason = null;
      return result;
    }
    // Cheap early exit: if the extension died mid-wait there's no point
    // holding open the full timeout. Only relevant BEFORE grace is granted;
    // once we've extended, we stop short-circuiting on liveness since the
    // heartbeat writer itself could be briefly delayed on a slow machine.
    if (!graceGranted && ++aliveChecks % 10 === 0 && !isExtensionAlive()) {
      lastWaitTimeoutReason = "dead";
      return null;
    }
  }
}

function extensionOfflineError(tool: string) {
  return {
    content: [{
      type: "text" as const,
      text: `${tool} requires the ShapeItUp VSCode extension to be running (it's a viewer-state command). Open VSCode with the extension installed, then retry.\n(No heartbeat at ${join(GLOBAL_STORAGE, "shapeitup-heartbeat.json")})`,
    }],
    isError: true,
  };
}

/**
 * Best-effort: when an MCP operation changes the current shape, poke the
 * extension so its live viewer re-renders the same file. Fires and forgets —
 * if VSCode isn't running, nothing happens and MCP still succeeds.
 *
 * The targetWorkspaceRoot hint routes the command to the single window whose
 * workspace owns the file — without it, multi-window setups silently process
 * the open-shape in every window that happens to read the command file.
 */
function notifyExtensionOfShape(filePath: string): void {
  if (isExtensionAlive()) {
    const targetWorkspaceRoot = computeTargetWorkspaceRoot(filePath);
    sendExtensionCommand("open-shape", { filePath, targetWorkspaceRoot });
  }
}

/**
 * Soft-warning detector for path-segment doubling in create_shape.
 *
 * When the MCP shell cwd's basename matches the user-supplied relative
 * `directory` arg (e.g. cwd = `ShapeItUp/examples`, `directory: "examples"`),
 * `resolveDirArg` probes each workspace root — none match, so the final path
 * resolves to `ShapeItUp/examples/examples`. That's almost never intentional.
 * Returns a leading-newline warning string ready to concatenate into the
 * response body, or `""` when no doubling is detected.
 *
 * Exported so the unit tests can exercise the detector without spinning up
 * the full MCP harness (executeShapeFile needs OCCT).
 */
export function detectPathDoubling(absoluteDir: string): string {
  const info = detectPathDoublingInfo(absoluteDir);
  if (!info) return "";
  return (
    `\nWarning: directory resolved to ${info.absoluteDir}. Note the path segment ` +
    `"${info.duplicatedSegment}" appears twice — you may have intended directory: "." ` +
    `or a subdir. Passed through as-is.`
  );
}

/**
 * Structured companion to `detectPathDoubling`. Returns `null` when no
 * duplication is detected; otherwise returns the resolved path and the
 * offending segment so callers can build a hard-refusal error message
 * (see `create_shape` / `allowPathDuplication`).
 */
export function detectPathDoublingInfo(
  absoluteDir: string,
): { absoluteDir: string; duplicatedSegment: string } | null {
  const resolved = resolve(absoluteDir);
  const segments = resolved.split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  const prev = segments[segments.length - 2];
  if (last && prev && last.toLowerCase() === prev.toLowerCase()) {
    return { absoluteDir: resolved, duplicatedSegment: last };
  }
  return null;
}

function formatRelativeTimestamp(epochMs: number): string {
  const delta = Date.now() - epochMs;
  if (!isFinite(delta) || delta < 0) return new Date(epochMs).toISOString();
  const s = Math.round(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function formatLastScreenshotLine(status: EngineStatus): string {
  const ls = status.lastScreenshot;
  if (!ls || !ls.path) return "";
  const when = typeof ls.timestamp === "number"
    ? ` (${formatRelativeTimestamp(ls.timestamp)})`
    : "";
  const mode = ls.renderMode ? `, mode=${ls.renderMode}` : "";
  const cam = ls.cameraAngle ? `, camera=${ls.cameraAngle}` : "";
  return `\nLast screenshot: ${ls.path}${when}${mode}${cam}`;
}

/**
 * Collapse consecutive duplicate strings into a single entry suffixed with
 * `(×N)`. Order-preserving: the first occurrence of each distinct line keeps
 * its position; the count is what varies. Used by the STEP/STL export
 * printability block so that 48 parts all flagged for the same boolean-
 * artefact reason emit one line, not 48 identical ones.
 */
function dedupLines(lines: string[]): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  const firstIndex = new Map<string, number>();
  for (const line of lines) {
    if (!firstIndex.has(line)) {
      firstIndex.set(line, out.length);
      out.push(line);
      counts.set(line, 1);
    } else {
      counts.set(line, (counts.get(line) ?? 1) + 1);
    }
  }
  return out.map((line) => {
    const n = counts.get(line) ?? 1;
    return n > 1 ? `${line} (\u00d7${n})` : line;
  });
}

function formatStatusText(status: EngineStatus, verbosity: "summary" | "full" = "summary"): string {
  const lastShot = formatLastScreenshotLine(status);
  if (!status.success) {
    const hint = status.hint ? `\nHint: ${status.hint}` : "";
    const operation = status.operation ? `\nFailed operation: ${status.operation}` : "";
    // Include the first few lines of the stack — enough to show which Replicad
    // / OCCT call blew up without dumping an unreadable wall of text. Agents
    // need this to know whether to back off the fillet, simplify geometry, etc.
    //
    // Filter out framework/bundler frames (mcp-server.mjs:NNN:NN, extension.mjs,
    // viewer.mjs, and anything under dist/ or node_modules/) — they're noise
    // the agent can't act on. Keep frames pointing to .shape.ts files
    // (attributed via sourceURL from commit 99bc307) plus Replicad/OCCT
    // internal calls, which name the actual geometry operation that failed.
    const FRAMEWORK_FRAME_RE = /(?:mcp-server|extension|viewer)\.mjs|[/\\]dist[/\\]|[/\\]node_modules[/\\]/i;
    const stack = status.stack
      ? `\nStack (top frames):\n${status.stack
          .split("\n")
          .slice(0, 6)
          .filter((l) => !FRAMEWORK_FRAME_RE.test(l))
          .map((l) => `  ${l.trim()}`)
          .filter((l) => l.trim().length > 2)
          .join("\n")}`
      : "";
    // Bug #1: when the engine detects a WASM-level failure it drops the cached
    // OCCT core so the next tool call boots a fresh one. Warn the caller that
    // their next render pays the re-init cost AND that this wasn't a "just
    // retry" situation — the heap was poisoned and has now been cleaned.
    const resetNote = status.engineReset
      ? `\nEngine was re-initialized after a WASM exception. Next call will take ~500ms.`
      : "";
    return `Render FAILED\nError: ${status.error}${hint}${operation}${stack}${resetNote}\nFile: ${status.fileName || "unknown"}\nTip: call get_preview to view the last successful render for visual comparison (the PNG is NOT overwritten on failure).${lastShot}\nTime: ${status.timestamp}${getVersionTag()}`;
  }
  const parts = status.partNames?.length ? `\nParts: ${status.partNames.join(", ")}` : "";
  const paramEntries = status.currentParams ? Object.entries(status.currentParams) : [];
  // Multi-file .shape.ts fix: when the entry file has no `export const params`
  // but the renderer still produced a non-empty params object, those entries
  // came from an imported module. Show them — but annotate that they're NOT
  // the sliders the entry file owns.
  const importedParamsWarning = status.importedParamsWarning
    ? `\nWarning: ${status.importedParamsWarning}`
    : "";
  const currentParams = paramEntries.length
    ? `\nCurrent params: ${paramEntries.map(([k, v]) => `${k}=${v}`).join(", ")}${importedParamsWarning}`
    : "";
  const timingEntries = status.timings
    ? Object.entries(status.timings).sort((a, b) => b[1] - a[1]).slice(0, 8)
    : [];
  const timings = timingEntries.length
    ? `\nTop operations (ms): ${timingEntries.map(([k, v]) => `${k}=${Math.round(v)}`).join(", ")}`
    : "";
  // Bug #4: when BRepCheck flagged a part as invalid, the render is NOT a
  // plain success — OCCT's volume/area on broken solids is garbage (e.g.
  // shell-on-revolve reported 1.4x the correct volume because duplicated
  // faces were counted twice). Flip the headline and hoist the warning
  // block above the stats so agents see the problem first.
  const geomInvalid = status.geometryValid === false;
  const warnings = Array.isArray(status.warnings) && status.warnings.length
    ? (geomInvalid
        ? `\nGeometry errors (part validation failed):\n - ${status.warnings.join("\n - ")}\nNote: Volume/area/mass omitted for invalid parts.`
        : `\nGeometry warnings:\n - ${status.warnings.join("\n - ")}`)
    : "";
  // P9: aggregate `patterns.cutAt` material-removal summary. Only rendered
  // when the script actually called cutAt (undefined → omitted entirely).
  // The engine promotes USER-EXPLICIT cutAt misses to thrown errors, so a
  // `false` here almost always means a generator-produced placement set
  // whose math landed outside the target — a warning, not a failure.
  let cutAtSummary = "";
  if (status.hasRemovedMaterial === true) {
    const count = status.cutAtCallCount ?? 0;
    cutAtSummary = `\nCut material removal: all succeeded${count ? ` (${count} call${count === 1 ? "" : "s"})` : ""}`;
  } else if (status.hasRemovedMaterial === false) {
    const failed = status.cutAtFailedCount ?? 0;
    const total = status.cutAtCallCount ?? 0;
    cutAtSummary = total > 0
      ? `\nCut material removal: ${failed}/${total} call${total === 1 ? "" : "s"} removed no material`
      : `\nCut material removal: one or more calls removed no material`;
  }
  const properties = formatProperties(status.properties, verbosity);
  const bbox = status.boundingBox
    ? `\nBounding box: ${status.boundingBox.x} x ${status.boundingBox.y} x ${status.boundingBox.z} mm`
    : "";
  const material = status.material
    ? `\nMaterial: ${status.material.name ? status.material.name + ", " : ""}density ${status.material.density} g/cm³`
    : "";

  // Geometry sanity: flag a single part that extends meaningfully below z=0.
  // When a mechanical design has a baseplate resting on the XY plane, a part
  // whose minimum z sits more than 1mm below the origin is almost always a
  // rotation-direction mistake or a pivot-point typo — but it renders the
  // same either way, so visual inspection alone won't catch it. 1mm tolerance
  // keeps ordinary -0.001 numerical dust from tripping the warning.
  //
  // Multi-part assemblies are excluded entirely: in practice every
  // non-trivial assembly uses SOME reference convention other than "every
  // part sits above Z=0" (bedplates, centred axles, floor-anchored frames).
  // The old 50%-systemic-convention heuristic still fired one-off warnings
  // in mixed cases and was pure noise. If `main()` returns an array, trust
  // the author's convention and skip the check.
  let belowZeroWarn = "";
  const partsList = status.properties?.parts;
  if (Array.isArray(partsList) && partsList.length === 1) {
    const p = partsList[0];
    const minZ = p.boundingBox?.min?.[2];
    if (typeof minZ === "number" && minZ < -1) {
      const depth = (-minZ).toFixed(1);
      belowZeroWarn =
        `\n\u26a0 Geometry: part '${p.name}' extends ${depth} mm below z=0. If it should rest on a baseplate (z=0), check your rotation direction or pivot point.`;
    }
  }

  const headline = geomInvalid ? "Render COMPLETED WITH GEOMETRY ERRORS" : "Render SUCCESS";
  if (geomInvalid) {
    // Hoist the warnings block above stats so the structural problem is the
    // first thing the reader sees, not an otherwise-normal-looking summary.
    return `${headline}\nFile: ${status.fileName || "unknown"}${warnings}\nStats: ${status.stats}${parts}${bbox}${material}${properties}${belowZeroWarn}${currentParams}${timings}${cutAtSummary}${lastShot}\nTime: ${status.timestamp}${getVersionTag()}`;
  }
  return `${headline}\nFile: ${status.fileName || "unknown"}\nStats: ${status.stats}${parts}${bbox}${material}${properties}${belowZeroWarn}${currentParams}${timings}${warnings}${cutAtSummary}${lastShot}\nTime: ${status.timestamp}${getVersionTag()}`;
}

/**
 * Shared helper used by `preview_finder` and `render_preview` to emit the
 * synthetic `.shape.ts` wrapper that feeds into the extension's render-preview
 * pipeline. The wrapper re-exports the user's `params` so sliders still work,
 * re-invokes their `main()` to produce the parts, picks the target part, then
 * hands it to the worker-injected `highlightFinder(shape, finder)` helper
 * (which paints pink spheres at each match; see packages/core/src/executor.ts).
 *
 * Both callers resolve partName → index *before* calling this — keeping the
 * wrapper itself free of any MCP-side state (no parts list to consult) and
 * making the rendered template purely mechanical. The helper does NOT write
 * the file; callers are responsible for writing + unlinking so they can wrap
 * the whole render call in try/finally.
 */
function buildFinderWrapperScript(
  sourcePath: string,
  finderExpr: string,
  partSelector: { index: number }
): string {
  const userBase = basename(sourcePath).replace(/\.shape\.ts$/, "");
  // Escape the finder expression for safe embedding in the template literal
  // below. Same escapes preview_finder used to apply inline.
  const escapedFinder = finderExpr
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `import * as __user__ from "./${userBase}.shape";
import { EdgeFinder, FaceFinder } from "replicad";

export const params: Record<string, number> = ((__user__ as any).params ?? {});

export default function main(p: Record<string, number>) {
  const userMain: any = (__user__ as any).default;
  if (typeof userMain !== "function") {
    throw new Error("Source file has no default export");
  }
  const result = userMain.length > 0 ? userMain(p) : userMain();
  const arr = Array.isArray(result) ? result : [{ shape: result, name: "shape" }];
  const target: any = arr[${partSelector.index}];
  const shape = (target && target.shape) ? target.shape : target;
  const finder: any = (${escapedFinder});
  return (highlightFinder as any)(shape, finder);
}
`;
}

/**
 * Lazy-loaded TypeScript compiler handle. We reach for it only to power the
 * AST-based `extrude()`-without-`sketchOnPlane()` check in `validateSyntaxPure`;
 * the regex passes don't need it. Kept behind an indirect `require` so esbuild
 * doesn't pull the entire compiler into the MCP server bundle — TS is resolved
 * at runtime from the user's node_modules (it's already reachable transitively
 * in this workspace). If the lookup fails (no TS installed), the AST check is
 * silently skipped and the existing regex-based pitfall #2 still fires on the
 * simple `drawXxx(...).extrude()` case.
 */
let _tsModule: typeof import("typescript") | null = null;
let _tsLoadAttempted = false;
function loadTypescript(): typeof import("typescript") | null {
  if (_tsModule) return _tsModule;
  if (_tsLoadAttempted) return null;
  _tsLoadAttempted = true;
  try {
    // Assemble the module name at runtime so esbuild treats this as a dynamic
    // require and does not inline the compiler source.
    const name = ["type", "script"].join("");
    _tsModule = require(name);
    return _tsModule;
  } catch {
    return null;
  }
}

/**
 * Pitfall #7 (AST-based): flag `.extrude(...)` calls whose receiver chain
 * traces back to a `drawXxx(...)` call without an intervening
 * `.sketchOnPlane()` or `.sketchOnFace()`.
 *
 * The regex-only pitfall #2 catches the inline case
 * (`drawRectangle(10,10).extrude(5)`) but misses the split-variable case:
 *
 *   const r = drawRectangle(10, 10);
 *   const s = r.extrude(5);   // r is a Drawing — extrude will throw
 *
 * Catching this by regex is fragile (we'd need to track identifier types
 * through reassignment). The AST walker follows variable initializers back
 * to the draw-factory root and reports when no sketchOnPlane/sketchOnFace
 * sits between the draw call and the extrude. Returns null when TypeScript
 * isn't reachable (so the caller can fall back quietly to the regex output).
 */
export function checkExtrudeWithoutSketchPlane(code: string): string | null {
  const tsMod = loadTypescript();
  if (!tsMod) return null;
  // Alias to a non-null const so the nested walkers keep type narrowing —
  // TypeScript otherwise re-widens `tsMod` back to `typeof ts | null` on
  // every closure boundary.
  const ts: typeof import("typescript") = tsMod;
  let source: import("typescript").SourceFile;
  try {
    source = ts.createSourceFile("__validate__.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return null;
  }

  const drawFactories = new Set([
    "drawRectangle", "drawRoundedRectangle", "drawCircle", "drawEllipse",
    "drawPolysides", "drawText", "draw",
  ]);

  // First pass: record the most recent initializer for every identifier
  // bound via `const/let/var` or top-level reassignment. We don't try to
  // model control flow — we just want a best-effort "what was this name
  // last assigned?". Matches the conservative tone of the other checks.
  const latestInit = new Map<string, import("typescript").Expression>();
  function collect(node: import("typescript").Node): void {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      latestInit.set(node.name.text, node.initializer);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      latestInit.set(node.left.text, node.right);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);

  // Given the receiver expression of a `.extrude(...)` call, walk backwards
  // through property accesses, call expressions, and identifier lookups.
  // Return true iff the chain originates at a drawXxx(...) call with no
  // sketchOnPlane / sketchOnFace in between. `seen` guards against
  // pathological cyclic assignments (`x = x.translate(…)`) — we stop after
  // the first revisit rather than looping forever.
  function chainStartsAtDrawWithoutSketch(
    expr: import("typescript").Expression,
    seen: Set<string>,
  ): boolean {
    let cur: import("typescript").Expression = expr;
    for (let guard = 0; guard < 64; guard++) {
      if (ts.isParenthesizedExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (ts.isCallExpression(cur)) {
        // X.method(...) — inspect the method name, then descend to X.
        if (ts.isPropertyAccessExpression(cur.expression)) {
          const methodName = cur.expression.name.text;
          if (methodName === "sketchOnPlane" || methodName === "sketchOnFace") {
            return false; // chain is already planar — safe.
          }
          cur = cur.expression.expression;
          continue;
        }
        // Bare Identifier(...) call — likely a factory. drawXxx without
        // a sketchOnPlane in the chain above means "needs sketch".
        if (ts.isIdentifier(cur.expression)) {
          return drawFactories.has(cur.expression.text);
        }
        // Anything else (computed callee, IIFE, etc.) — bail conservatively.
        return false;
      }
      if (ts.isPropertyAccessExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (ts.isIdentifier(cur)) {
        const name = cur.text;
        if (seen.has(name)) return false;
        seen.add(name);
        const init = latestInit.get(name);
        if (!init) return false;
        return chainStartsAtDrawWithoutSketch(init, seen);
      }
      return false;
    }
    return false;
  }

  let flagged = false;
  function scan(node: import("typescript").Node): void {
    if (flagged) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "extrude"
    ) {
      const receiver = node.expression.expression;
      if (chainStartsAtDrawWithoutSketch(receiver, new Set())) {
        flagged = true;
        return;
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(source);

  return flagged
    ? "extrude() called without prior sketchOnPlane() or sketchOnFace() — the 2D drawing must be placed on a 3D plane before extrusion"
    : null;
}

/**
 * Pitfall #8 (AST-based): flag DrawingPen bezier calls where two literal
 * `[x, y]` control points within the SAME call are byte-identical. OpenCascade
 * throws a low-level "Standard_ConstructionError" on degenerate curves with no
 * script-frame context, which is hell to diagnose from user-land. Catching the
 * equal-literals case statically saves the whole loop.
 *
 * Scope: bezierCurveTo, quadraticBezierCurveTo, cubicBezierCurveTo,
 * smoothSplineTo — these are the DrawingPen methods that accept two or more
 * `[x, y]` tuples (endpoint + control points). Non-literal arguments (variables,
 * computed expressions) pass through: we can't evaluate them statically, and
 * the stdlib has several helpers that compose bezier paths from parameters.
 *
 * Start-point degeneracy (where a literal equals the current pen position set
 * by `.moveTo(...)` / prior `.lineTo(...)`) would require tracking pen state
 * across the chain — deferred to a future iteration. One warning per file
 * (first match wins) to avoid flooding a chain of small bezier segments with
 * repeated warnings.
 *
 * Returns null when TypeScript isn't reachable, matching the pattern in
 * checkExtrudeWithoutSketchPlane so the caller can fall back quietly.
 */
export function checkBezierDegeneracy(code: string): string | null {
  const tsMod = loadTypescript();
  if (!tsMod) return null;
  const ts: typeof import("typescript") = tsMod;
  let source: import("typescript").SourceFile;
  try {
    source = ts.createSourceFile("__validate__.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return null;
  }

  const bezierMethods = new Set([
    "bezierCurveTo", "quadraticBezierCurveTo", "cubicBezierCurveTo", "smoothSplineTo",
  ]);

  // Whitespace-normalized canonical form of a literal [x, y] pair. Returns
  // null if the node isn't a 2-element array literal of numeric literals
  // (with optional unary minus) — those are the only shapes we compare.
  function canonicalPoint(node: import("typescript").Node): { key: string; x: number; y: number } | null {
    if (!ts.isArrayLiteralExpression(node)) return null;
    if (node.elements.length !== 2) return null;
    const nums: number[] = [];
    for (const el of node.elements) {
      let signed: number | null = null;
      if (ts.isNumericLiteral(el)) {
        signed = parseFloat(el.text);
      } else if (ts.isPrefixUnaryExpression(el) && el.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(el.operand)) {
        signed = -parseFloat(el.operand.text);
      }
      if (signed === null || !isFinite(signed)) return null;
      nums.push(signed);
    }
    const [x, y] = nums;
    return { key: `${x},${y}`, x, y };
  }

  let warning: string | null = null;
  function scan(node: import("typescript").Node): void {
    if (warning) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      bezierMethods.has(node.expression.name.text)
    ) {
      const literals: Array<{ key: string; x: number; y: number }> = [];
      for (const arg of node.arguments) {
        const pt = canonicalPoint(arg);
        if (pt) literals.push(pt);
      }
      for (let i = 0; i < literals.length && !warning; i++) {
        for (let j = i + 1; j < literals.length; j++) {
          if (literals[i].key === literals[j].key) {
            const { x, y } = literals[i];
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            warning =
              `line ${line}: bezier control point equals another control point at (${x}, ${y}). ` +
              `OCCT will throw a low-level exception on degenerate curves. ` +
              `Use a nearby but non-identical point (e.g., [${x + 0.01}, ${y}])`;
            break;
          }
        }
      }
    }
    if (!warning) ts.forEachChild(node, scan);
  }
  scan(source);
  return warning;
}

/**
 * Pitfall #9 (AST-based): flag `patterns.cutAt(target, <non-factory>, ...)`.
 * The runtime guard in `packages/core/src/stdlib/patterns.ts` (see `cutAt`)
 * throws a TypeError when the second argument isn't a function, because
 * Replicad's translate/rotate consume OCCT handles — a shared Shape3D passed
 * directly would be deleted after the first placement, causing a cryptic
 * WASM fault. We mirror that guard statically so callers get the fix hint
 * at validate time rather than at execution.
 *
 * Matches both `patterns.cutAt(...)` and chained forms like
 * `lib.patterns.cutAt(...)` (namespace stdlib imports). Only literal
 * arrow-function or function-expression second arguments are considered
 * safe — an identifier binding (`cutAt(plate, factory, ...)`) is skipped
 * conservatively because we can't tell whether `factory` is a function
 * without type resolution.
 *
 * Returns null when TypeScript isn't reachable, matching the lazy-load
 * pattern of the other AST checks.
 */
export function checkPatternsCutAtFactory(code: string): string | null {
  const tsMod = loadTypescript();
  if (!tsMod) return null;
  const ts: typeof import("typescript") = tsMod;
  let source: import("typescript").SourceFile;
  try {
    source = ts.createSourceFile("__validate__.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return null;
  }

  // True iff `expr` is a property-access chain ending in `.patterns.cutAt`.
  // Handles `patterns.cutAt` (root Identifier("patterns")) AND arbitrary
  // dotted prefixes like `lib.patterns.cutAt` / `a.b.patterns.cutAt`.
  function isPatternsCutAt(expr: import("typescript").Expression): boolean {
    if (!ts.isPropertyAccessExpression(expr)) return false;
    if (expr.name.text !== "cutAt") return false;
    const parent = expr.expression;
    if (ts.isIdentifier(parent)) return parent.text === "patterns";
    if (ts.isPropertyAccessExpression(parent)) return parent.name.text === "patterns";
    return false;
  }

  let warning: string | null = null;
  function scan(node: import("typescript").Node): void {
    if (warning) return;
    if (ts.isCallExpression(node) && isPatternsCutAt(node.expression)) {
      const factoryArg = node.arguments[1];
      if (factoryArg && !ts.isArrowFunction(factoryArg) && !ts.isFunctionExpression(factoryArg)) {
        warning =
          "patterns.cutAt: the tool argument must be a factory function (`() => makeTool()`), not a Shape directly — " +
          "Replicad's translate/rotate consume OCCT handles, so a shared tool is deleted after the first placement. " +
          "Wrap it: `patterns.cutAt(plate, () => holes.through('M4'), placements)`.";
        return;
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(source);
  return warning;
}

/**
 * Pitfall #10 (AST-based): flag `x.cut(x.something())` — passing a
 * boolean-op argument whose root identifier is the SAME as the receiver's.
 * Replicad's cut/fuse/intersect invalidate the receiver's OCCT handle; when
 * the tool expression walks off the same binding (often through a translate
 * or rotate, which also consume handles), the script crashes with a deleted-
 * handle fault that looks like a WASM memory error.
 *
 * Conservative: only flags plain Identifier roots on BOTH the receiver and
 * the argument. Computed receivers (`shapes[i].cut(...)`, `getTool().cut(...)`)
 * are skipped — we can't prove aliasing without full type resolution, and
 * a false-positive on an unrelated `shapes[i]` vs `shapes` would be worse
 * than missing some cases. Returns null when TypeScript isn't reachable.
 */
export function checkShapeReuseAfterBoolean(code: string): string | null {
  const tsMod = loadTypescript();
  if (!tsMod) return null;
  const ts: typeof import("typescript") = tsMod;
  let source: import("typescript").SourceFile;
  try {
    source = ts.createSourceFile("__validate__.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return null;
  }

  const boolMethods = new Set(["cut", "fuse", "intersect"]);

  // Walk a receiver/argument expression down to the root Identifier.
  // Only descends through PropertyAccess and Call chains (the common
  // translate/rotate/etc. method-chain shape); bails on anything else so
  // we stay conservative. Returns null if no plain Identifier root exists.
  function rootIdentifier(expr: import("typescript").Expression): string | null {
    let cur: import("typescript").Expression = expr;
    for (let guard = 0; guard < 64; guard++) {
      if (ts.isParenthesizedExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (ts.isPropertyAccessExpression(cur)) {
        cur = cur.expression;
        continue;
      }
      if (ts.isCallExpression(cur)) {
        // For calls, the receiver is what carries identity (`x.translate()`
        // keeps `x` as the root); a bare function call like `getTool()`
        // has no plain Identifier root, bail.
        if (ts.isPropertyAccessExpression(cur.expression)) {
          cur = cur.expression.expression;
          continue;
        }
        return null;
      }
      if (ts.isIdentifier(cur)) return cur.text;
      return null;
    }
    return null;
  }

  let warning: string | null = null;
  function scan(node: import("typescript").Node): void {
    if (warning) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      boolMethods.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const receiverRoot = rootIdentifier(receiver);
      if (receiverRoot) {
        for (const arg of node.arguments) {
          const argRoot = rootIdentifier(arg);
          if (argRoot && argRoot === receiverRoot) {
            warning =
              `Shape reuse after boolean op: \`${receiverRoot}.cut/fuse/intersect(${receiverRoot}.*)\` — ` +
              "Replicad's boolean ops invalidate the receiver's OCCT handle. " +
              `Clone before transforming: \`${receiverRoot}.cut(${receiverRoot}.clone().translate(...))\` ` +
              "or assign the transformed tool to a new variable first.";
            return;
          }
        }
      }
    }
    ts.forEachChild(node, scan);
  }
  scan(source);
  return warning;
}

/**
 * Compute the effective meshQuality to use for a render_preview call.
 *
 * Rule: when renderMode is "ai" (or absent — which defaults to "ai") AND
 * the caller did NOT explicitly supply meshQuality, force "final" so the AI
 * agent always analyses accurate geometry rather than a coarsely-faceted
 * preview mesh.
 *
 * When the caller explicitly passes meshQuality (even "preview") their
 * choice is respected — they opted in knowingly.
 *
 * Extracted so unit tests can verify the policy without spinning up the
 * full MCP server.
 */
export function computeEffectiveMeshQuality(
  renderMode: string | undefined,
  meshQuality: "preview" | "final" | undefined
): "preview" | "final" | undefined {
  if ((renderMode === "ai" || renderMode === undefined) && meshQuality === undefined) {
    return "final";
  }
  return meshQuality;
}

/**
 * Pure syntax + pitfall validator. Extracted from the `validate_syntax`
 * MCP tool so unit tests can call it directly without spinning up an MCP
 * server. Returns the same text the tool emits, plus a boolean signalling
 * "hard parse failure" (so the caller can set isError on the MCP envelope).
 *
 * Catches two classes of problem:
 *   1. Real JS syntax errors — evaluated via `new Function(stripped)` after a
 *      best-effort TypeScript-feature strip. Fatal; sets isError.
 *   2. Unknown `.method()` calls — compared against a hand-curated Replicad
 *      whitelist. Method calls whose receiver was imported from "shapeitup"
 *      are trusted unconditionally (so stdlib additions don't need to be
 *      mirrored here). Warnings only; isError stays false.
 *   3. Seven well-known CAD pitfalls (sketch mischain, missing sketchOnPlane,
 *      unclosed pen, non-uniform scale, oversized fillet, booleans in loop,
 *      and the AST-based variable-assigned `extrude` variant). Warnings only.
 */
export function validateSyntaxPure(code: string): { text: string; isError: boolean } {
  try {
    let stripped = code;
    stripped = stripped.replace(/^import\s+[\s\S]*?from\s*["'][^"']*["']\s*;?\s*$/gm, "");
    stripped = stripped.replace(/^import\s+["'][^"']*["']\s*;?\s*$/gm, "");
    stripped = stripped.replace(/^export\s+(default\s+)?/gm, "");
    stripped = stripped.replace(/:\s*typeof\s+\w+/g, "");
    stripped = stripped.replace(/(\w)\s*:\s*(?:string|number|boolean|any|void|never|unknown|null|undefined)(?:\[\])?\s*(?=[,)])/g, "$1");
    stripped = stripped.replace(/\bas\s+\w+/g, "");
    stripped = stripped.replace(/^(interface|type)\s+\w+[^=].*$/gm, "");
    stripped = stripped.replace(/(<\w[\w,\s]*>)\s*\(/g, "(");
    new Function(stripped);

    const knownMethods = new Set([
      "drawRectangle", "drawRoundedRectangle", "drawCircle", "drawEllipse", "drawPolysides", "drawText", "draw",
      "sketchCircle", "sketchRectangle", "makeCylinder", "makeSphere", "makeBox", "makeEllipsoid",
      "extrude", "revolve", "loftWith", "sweepSketch",
      "fuse", "cut", "intersect",
      "fillet", "chamfer", "shell", "draft",
      "translate", "translateX", "translateY", "translateZ", "rotate", "mirror", "scale",
      "sketchOnPlane", "sketchOnFace",
      "mesh", "meshEdges",
      "close", "hLine", "vLine", "lineTo", "line", "sagittaArcTo", "tangentArcTo", "threePointsArcTo",
      "cubicBezierCurveTo", "smoothSplineTo", "closeWithMirror", "done",
      "localGC", "exportSTEP",
    ]);

    // Bug #6: trust .method() calls whose receiver was imported from the
    // shapeitup stdlib. Otherwise every stdlib helper (bearings.body,
    // holes.through, patterns.grid, etc.) shows up as "unknown method" —
    // the whitelist above only covers Replicad surface methods, and growing
    // it per-stdlib-addition is a losing maintenance battle.
    //
    // Two import forms cover the ecosystem:
    //   import { bearings, holes as h } from "shapeitup"
    //   import * as lib from "shapeitup"
    // Parse both out of the ORIGINAL code (not `stripped` — the import
    // stripping earlier nuked the lines we need to read).
    const stdlibIdents = new Set<string>();
    const namedImport = /import\s*\{([^}]+)\}\s*from\s*["']shapeitup["']/g;
    for (const m of code.matchAll(namedImport)) {
      for (const piece of m[1].split(",")) {
        // `X as Y` — the LOCAL binding is Y; the original export name X
        // never appears as a .method() receiver in this file. Fall back
        // to the trimmed piece itself when there's no alias.
        const trimmed = piece.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+as\s+/);
        const name = (parts[1] ?? parts[0]).trim();
        if (name) stdlibIdents.add(name);
      }
    }
    const starImport = /import\s*\*\s*as\s+(\w+)\s+from\s*["']shapeitup["']/g;
    for (const m of code.matchAll(starImport)) {
      stdlibIdents.add(m[1]);
    }

    // Capture a (possibly dotted) receiver chain so stdlib calls are
    // trusted in full. For `lib.patterns.grid(`, the root identifier is
    // `lib` — if that's a stdlib namespace import, the WHOLE chain is
    // trusted (not just the outermost `.grid`). The receiver group allows
    // dots for that reason; the first segment is inspected for the stdlib
    // check.
    //
    // A second chain-continuation pass picks up method calls whose receiver
    // is a call expression (e.g. `drawCircle(5).fuse(x)`) — those can't be
    // stdlib roots, so they fall through to the whitelist check.
    const unknownMethods = new Set<string>();
    const skippedByReceiver = new Set<string>();
    const receiverCallPattern = /([A-Za-z_]\w*(?:\s*\.\s*\w+)*)\s*\.\s*(\w+)\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = receiverCallPattern.exec(code)) !== null) {
      const [, receiverChain, methodName] = match;
      const rootIdent = receiverChain.split(/\s*\.\s*/)[0];
      if (stdlibIdents.has(rootIdent)) {
        // Remember that this method name was seen on a stdlib receiver
        // somewhere — even if the SAME name later appears as a chain
        // continuation elsewhere in the file (edge case), we'd rather
        // under-warn than over-warn. Matches the conservative
        // "hints, not failures" posture of the other semantic checks.
        skippedByReceiver.add(methodName);
        continue;
      }
      if (!knownMethods.has(methodName)) unknownMethods.add(methodName);
    }
    // Chain-continuation pass: picks up `foo().bar()` — where `bar`'s
    // receiver is a call expression, not a plain identifier, so the
    // receiver pass above missed it. The lookbehind ensures we only match
    // `.bar(` right after `)` — not the `.bar` of an `x.bar(` we already
    // handled.
    const chainCallPattern = /(?<=\))\s*\.\s*(\w+)\s*\(/g;
    while ((match = chainCallPattern.exec(code)) !== null) {
      const methodName = match[1];
      if (skippedByReceiver.has(methodName)) continue;
      if (!knownMethods.has(methodName)) unknownMethods.add(methodName);
    }

    // --- Semantic checks (pitfall linter) -----------------------------
    // Regex-only, conservative. These warnings are hints, not failures:
    // the script may be intentional, and we prefer false-negatives to
    // false-positives. isError stays false regardless.
    const semanticWarnings: string[] = [];

    // 1. sketchCircle/sketchRectangle already return a Sketch — chaining
    //    .sketchOnPlane() on top throws at runtime. Easy to confuse with
    //    the draw* family since the names rhyme.
    const sketchMisChain = /\b(sketchCircle|sketchRectangle)\s*\([^)]*\)\s*\.\s*sketchOnPlane\s*\(/;
    if (sketchMisChain.test(code)) {
      semanticWarnings.push(
        "`sketchCircle`/`sketchRectangle` already return a Sketch — remove the `.sketchOnPlane()` call (pass `{ plane: ... }` as config to the sketch* function instead)."
      );
    }

    // 2. draw*(...).(...).extrude() without an intervening sketchOnPlane/
    //    sketchOnFace. Tolerate 2D ops (fuse, cut, offset, translate,
    //    rotate, mirror) in the chain — those are all legal on Drawings.
    //    Match is deliberately non-greedy and bounded to a single chain
    //    expression (method calls with balanced-ish parens).
    const drawExtrudePattern = /\b(drawRectangle|drawRoundedRectangle|drawCircle|drawEllipse|drawPolysides|drawText)\s*\(([^()]|\([^()]*\))*\)((?:\s*\.\s*(?:fuse|cut|intersect|offset|translate|rotate|mirror)\s*\(([^()]|\([^()]*\))*\))*)\s*\.\s*extrude\s*\(/;
    const drawExtrudeInlineHit = drawExtrudePattern.test(code);
    if (drawExtrudeInlineHit) {
      semanticWarnings.push(
        "Drawings must be placed on a plane before extruding — add `.sketchOnPlane(\"XY\")` between the draw call and `.extrude()`."
      );
    }

    // Pitfall #7 (AST): catches the split-variable case the inline regex
    // above cannot see — `const r = drawRectangle(10, 10); r.extrude(5);`.
    // Only runs if TypeScript is resolvable at runtime; returns null when
    // unavailable and we fall back to the inline regex alone. Skip when
    // pitfall #2 already fired on the same file — the two warnings describe
    // the same bug, and two bullets for one problem just clutters output.
    if (!drawExtrudeInlineHit) {
      const astWarning = checkExtrudeWithoutSketchPlane(code);
      if (astWarning) semanticWarnings.push(astWarning);
    }

    // 3. Non-uniform .scale(). Replicad's shape.scale is uniform-only.
    //    Flag array arg OR multiple numeric args (comma-separated).
    const scaleArrayPattern = /\.\s*scale\s*\(\s*\[/;
    const scaleMultiArgPattern = /\.\s*scale\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*[,)]/;
    if (scaleArrayPattern.test(code) || scaleMultiArgPattern.test(code)) {
      semanticWarnings.push(
        "`shape.scale()` is uniform-only — pass a single number. For non-uniform scaling use `makeEllipsoid(rx, ry, rz)` or draw the target shape in 2D."
      );
    }

    // 4. draw() pen-builder chain missing .close()/.done() before
    //    .sketchOnPlane() or .extrude(). Match `draw(` (not drawXxx —
    //    the (?![a-zA-Z]) guard ensures we don't catch drawRectangle),
    //    followed by any chain of method calls up to the first
    //    sketchOnPlane/extrude. Warn if that chain contains no
    //    close/done/closeWithMirror call.
    const penChainPattern = /\bdraw\s*\((?![a-zA-Z])([^()]|\([^()]*\))*\)((?:\s*\.\s*[a-zA-Z_]\w*\s*\(([^()]|\([^()]*\))*\))*?)\s*\.\s*(sketchOnPlane|extrude)\s*\(/g;
    let penMatch: RegExpExecArray | null;
    while ((penMatch = penChainPattern.exec(code)) !== null) {
      const chainMiddle = penMatch[2] || "";
      if (!/\.\s*(close|closeWithMirror|done)\s*\(/.test(chainMiddle)) {
        semanticWarnings.push(
          "A `draw()` pen chain needs `.close()` (for extrudable regions) or `.done()` (for open sweep paths) before sketching/extruding."
        );
        break; // one warning is enough
      }
    }

    // 5. Fillet/chamfer radius sanity check against observed dimensions.
    //    Collect numeric literals from shape-factory calls and extrude
    //    distances. Take min > 0 as "smallest significant" dimension.
    //    Warn if any fillet/chamfer radius literal exceeds half of that.
    const dims: number[] = [];
    const extractNums = (s: string) => {
      const nums: number[] = [];
      const re = /-?\d+(?:\.\d+)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) {
        const v = parseFloat(m[0]);
        if (isFinite(v) && v > 0) nums.push(v);
      }
      return nums;
    };
    const dimFnPattern = /\b(drawRectangle|drawRoundedRectangle|drawCircle|drawEllipse|sketchCircle|sketchRectangle|makeBox|makeCylinder|makeSphere|makeEllipsoid)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
    let dimMatch: RegExpExecArray | null;
    while ((dimMatch = dimFnPattern.exec(code)) !== null) {
      dims.push(...extractNums(dimMatch[2]));
    }
    const extrudePattern = /\.\s*extrude\s*\(\s*(-?\d+(?:\.\d+)?)/g;
    let eMatch: RegExpExecArray | null;
    while ((eMatch = extrudePattern.exec(code)) !== null) {
      const v = parseFloat(eMatch[1]);
      if (isFinite(v) && v > 0) dims.push(v);
    }
    if (dims.length > 0) {
      const smallest = Math.min(...dims);
      const filletChamferPattern = /\.\s*(fillet|chamfer)\s*\(\s*(-?\d+(?:\.\d+)?)/g;
      let fcMatch: RegExpExecArray | null;
      const flagged = new Set<string>();
      while ((fcMatch = filletChamferPattern.exec(code)) !== null) {
        const r = parseFloat(fcMatch[2]);
        if (!isFinite(r)) continue;
        if (r < 0) {
          const key = `neg:${fcMatch[1]}:${r}`;
          if (flagged.has(key)) continue;
          flagged.add(key);
          semanticWarnings.push(
            `Fillet/chamfer radius must be positive — \`.${fcMatch[1]}(${r})\` will throw at runtime.`
          );
          continue;
        }
        if (r === 0) continue; // zero radius is a no-op, not a bug
        if (r > smallest * 0.5) {
          const key = `${fcMatch[1]}:${r}:${smallest}`;
          if (flagged.has(key)) continue;
          flagged.add(key);
          semanticWarnings.push(
            `Fillet/chamfer radius ${r} may be too large for the smallest feature dimension (${smallest}) — OpenCascade often fails on radii larger than half the edge length.`
          );
        }
      }
    }

    // 5b. Bezier control-point degeneracy. Two identical literal [x, y] tuples
    //     in the same bezierCurveTo / quadraticBezierCurveTo / cubicBezierCurveTo
    //     / smoothSplineTo call produce a zero-length segment — OCCT throws a
    //     bare "Standard_ConstructionError" with no script context. AST-based
    //     so the warning reports the correct line number; non-literal args are
    //     skipped (we can't evaluate variables statically).
    const bezierWarning = checkBezierDegeneracy(code);
    if (bezierWarning) {
      semanticWarnings.push(bezierWarning);
    }

    // 5c. patterns.cutAt must be called with a factory function, not a bare
    //     Shape3D. The stdlib runtime guard throws a TypeError with the
    //     same fix hint (see packages/core/src/stdlib/patterns.ts cutAt);
    //     AST-based so we catch the split-variable `patterns.cutAt(plate,
    //     tool, placements)` case at validate time. Skips silently when
    //     TypeScript isn't resolvable.
    const cutAtWarning = checkPatternsCutAtFactory(code);
    if (cutAtWarning) {
      semanticWarnings.push(cutAtWarning);
    }

    // 5d. Shape reuse after a boolean — `x.cut(x.translate(...))` crashes
    //     because replicad's boolean ops consume the receiver's OCCT handle
    //     while translate/rotate consume their input too. Conservative AST
    //     check: only the plain-Identifier-on-both-sides case is flagged.
    const reuseWarning = checkShapeReuseAfterBoolean(code);
    if (reuseWarning) {
      semanticWarnings.push(reuseWarning);
    }

    // 6. Hand-rolled boolean loops — classic "slow pattern" that crosses the
    //    WASM boundary N times instead of once. Detects five variants:
    //    (a) for(...){...shape.cut/fuse/intersect...}
    //    (b) while(...){...shape.cut/fuse/intersect...}
    //    (c) arr.forEach(p => shape = shape.cut/fuse/intersect(p))
    //    (d) arr.reduce((acc, p) => acc.cut/fuse/intersect(p), shape)
    //    All recommend patterns.cutAt, which batches at the WASM boundary.
    const boolInLoopBody = /\.\s*(fuse|cut|intersect)\s*\(/;

    // (a) for-loop with brace-walk to extract body
    let loopBoolSuggested = false;
    let loopBoolKind = "";

    const forPattern = /\bfor\s*\([^)]*\)\s*\{/g;
    let forMatch: RegExpExecArray | null;
    while ((forMatch = forPattern.exec(code)) !== null) {
      let depth = 1;
      let i = forMatch.index + forMatch[0].length;
      const start = i;
      while (i < code.length && depth > 0) {
        const ch = code[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
      const body = code.slice(start, i);
      if (boolInLoopBody.test(body)) {
        loopBoolSuggested = true;
        loopBoolKind = "for";
        break;
      }
    }

    // (b) while-loop — same brace-walk approach
    if (!loopBoolSuggested) {
      const whilePattern = /\bwhile\s*\([^)]*\)\s*\{/g;
      let whileMatch: RegExpExecArray | null;
      while ((whileMatch = whilePattern.exec(code)) !== null) {
        let depth = 1;
        let i = whileMatch.index + whileMatch[0].length;
        const start = i;
        while (i < code.length && depth > 0) {
          const ch = code[i];
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          i++;
        }
        const body = code.slice(start, i);
        if (boolInLoopBody.test(body)) {
          loopBoolSuggested = true;
          loopBoolKind = "while";
          break;
        }
      }
    }

    // (c) .forEach(... => ...cut/fuse/intersect...)
    // Matches: arr.forEach(p => shape = shape.cut(p)) and arrow-body variants.
    if (!loopBoolSuggested) {
      const forEachBoolPattern = /\.forEach\s*\(\s*\w+\s*=>[^)]*\.\s*(fuse|cut|intersect)\s*\(/;
      if (forEachBoolPattern.test(code)) {
        loopBoolSuggested = true;
        loopBoolKind = "forEach";
      }
    }

    // (d) .reduce((acc, p) => acc.cut/fuse/intersect(p), ...)
    if (!loopBoolSuggested) {
      const reduceBoolPattern = /\.reduce\s*\(\s*\([^)]*\)\s*=>[^,)]*\.\s*(fuse|cut|intersect)\s*\(/;
      if (reduceBoolPattern.test(code)) {
        loopBoolSuggested = true;
        loopBoolKind = "reduce";
      }
    }

    if (loopBoolSuggested) {
      const construct = loopBoolKind === "forEach"
        ? "`.forEach` loop"
        : loopBoolKind === "reduce"
          ? "`.reduce` accumulator"
          : `\`${loopBoolKind}\` loop`;
      semanticWarnings.push(
        `slow pattern: hand-rolled ${construct} with \`.cut\`/\`.fuse\`/\`.intersect\` calls is 2–5× slower than \`patterns.cutAt(shape, () => makeTool(), placements)\` — it batches at the WASM boundary. See the \`patterns\` category in get_api_reference.`
      );
    }

    // 7. Fillet/chamfer after a boolean — boolean faces often fail to fillet.
    //    The OCCT surfaces generated by cut/fuse/intersect are knit together
    //    from fragments of the input solids; the shared edges tend to be
    //    short and the adjacent faces non-planar in combinations the fillet
    //    code can't round. Apply fillets BEFORE the boolean whenever the
    //    rounded edge will survive the cut/fuse — it almost always does.
    //    The regex tolerates intermediate non-fillet methods in the chain
    //    (.translate, .rotate, etc.) so `x.cut(y).translate(...).fillet(...)`
    //    still triggers, while `x.cut(y); z.fillet(...)` (separate chain)
    //    does not.
    const filletAfterBoolPattern = /\.(cut|fuse|intersect)\s*\([^)]*\)\s*(?:\.\s*\w+\s*\([^)]*\))*\s*\.\s*(fillet|chamfer)\s*\(/;
    if (filletAfterBoolPattern.test(code)) {
      semanticWarnings.push(
        "Applying .fillet() or .chamfer() after a boolean (.cut/.fuse/.intersect) often fails because boolean-generated faces are fragile. Apply fillets BEFORE the boolean when possible."
      );
    }

    // 8. `return positioned` without `.entries()`. In multi-part assemblies
    //    the stdlib's `assemble(...)` / sub-assembly builder returns a
    //    positioned-parts Map; the engine expects an iterable of
    //    [name, Part] entries. Returning the Map directly produces empty
    //    parts or a runtime type error, depending on the downstream call.
    //    The rule is deliberately soft — `positioned` is a plausible local
    //    variable name, so we phrase the warning as a "did you mean" hint.
    //    We exempt .entries() (the correct call) but flag other chains like
    //    .toArray() / .values() — those are either wrong or already a
    //    mistake worth surfacing.
    const returnPositionedPattern = /\breturn\s+positioned\s*(?!\s*\.\s*entries\b)/;
    if (returnPositionedPattern.test(code)) {
      semanticWarnings.push(
        "In multi-part assemblies, `return positioned` without `.entries()` returns a Map rather than an array. Did you mean `return positioned.entries()`?"
      );
    }

    // --- Assemble response --------------------------------------------
    const baseText = unknownMethods.size > 0
      ? `Syntax OK. Warning: unknown method(s) found: ${Array.from(unknownMethods).map(m => `.${m}()`).join(", ")}.`
      : "Syntax OK";
    const warningBlock = semanticWarnings.length > 0
      ? `\nSemantic warnings:\n${semanticWarnings.map(w => ` - ${w}`).join("\n")}`
      : "";
    return { text: baseText + warningBlock, isError: false };
  } catch (e: any) {
    return { text: `Syntax error: ${e.message}`, isError: true };
  }
}

/**
 * MCP tool response shape. Kept permissive — individual handlers return richer
 * shapes (image content, structured metadata) that all satisfy this base, and
 * `safeHandler` only cares about routing thrown errors into `{ content, isError }`.
 */
type ToolResponse = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
  // Optional absolute path surfaced by path-resolving handlers (read_shape,
  // and any future tool that accepts a relative filePath). Callers whose
  // state tracking keys on absolute paths (e.g. the Claude Code Edit tool)
  // can use this to align downstream operations with the path we actually
  // opened, instead of re-resolving the relative input themselves.
  resolvedPath?: string;
};

/**
 * Fix A (Bug #6): wrap every MCP tool handler so a plain JS exception
 * (TypeError, ReferenceError, anything thrown from inside the handler body)
 * becomes a structured tool-error response instead of propagating up and
 * killing the stdio channel.
 *
 * Before this fix, an uncaught throw inside any handler broke the MCP
 * connection — every subsequent call returned `MCP error -32000: Connection
 * closed`. The `executeShapeFile` catch covered WASM-level errors but plain
 * JS throws in the handler itself (a typo, a bad chained call, etc.) bypassed
 * it. Wrapping here puts the last-mile safety net directly at the handler
 * boundary, as close to the thrown exception as possible.
 *
 * The message preserves the tool name, error message, and a truncated stack
 * so the agent can self-correct without a stderr dive. Stack trimmed to 5
 * lines so we don't flood the tool response with framework internals.
 */
export function safeHandler<T>(
  name: string,
  fn: (args: T) => Promise<ToolResponse>,
): (args: T) => Promise<ToolResponse> {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error && typeof e.stack === "string" ? e.stack : undefined;
      const tail = stack ? `\n${stack.split("\n").slice(0, 5).join("\n")}` : "";
      return {
        content: [{
          type: "text" as const,
          text: `Tool "${name}" failed: ${msg}${tail}`,
        }],
        isError: true,
      };
    }
  };
}

/**
 * Fix B (Bug #5) core: compute the "Parts: …" line for a screenshot response
 * using the engine's just-rendered parts list as the sole source of truth.
 *
 * Before: the line said "Parts: lid (focused — other parts hidden)" whenever
 * the caller passed `focusPart`, regardless of whether the focus actually
 * happened. The viewer could emit a contradicting "focusPart ignored: not a
 * multi-part assembly" warning in the same response — two different checks
 * reading two different states.
 *
 * After: we check the actual rendered partNames array. If the focus/hide is
 * a no-op (single-part script, or the requested names aren't among the
 * rendered parts), we return "" and let whatever warning the viewer emitted
 * carry the message alone. No contradiction possible.
 *
 * Exported for unit testing. `focusedLabel` is the text inside the parens
 * after the focused part name — render_preview says "focused — other parts
 * hidden in screenshot", preview_shape just says "focused".
 */
export function computePartsLine(
  focusPart: string | undefined,
  hideParts: string[] | undefined,
  renderedPartNames: string[],
  focusedLabel: string,
): string {
  const isAssembly = renderedPartNames.length > 1;
  const focusHonored =
    !!focusPart && isAssembly && renderedPartNames.includes(focusPart);
  const hideHonored =
    !!hideParts &&
    hideParts.length > 0 &&
    isAssembly &&
    hideParts.some((n) => renderedPartNames.includes(n));

  if (focusHonored) {
    return `\nParts: ${focusPart} (${focusedLabel})`;
  }
  if (hideHonored) {
    const matched = hideParts!.filter((n) => renderedPartNames.includes(n));
    return `\nParts hidden: ${matched.join(", ")}`;
  }
  return "";
}

// --- Persisted param overrides -------------------------------------------
// `tune_params` with `persist: true` writes the override map to a
// `.shapeitup-params.json` sidecar next to the shape file(s). Subsequent
// executeShapeFile() calls merge those overrides in BEFORE any per-call
// overrides win — the precedence is defaults (from the script) → sidecar →
// call-time overrides. Namespaced by basename so multiple files in one dir
// coexist. Documented in the `clear_params` tool description for discoverability.

const SIDECAR_FILENAME = ".shapeitup-params.json";

type SidecarMap = Record<string, Record<string, number>>;

function readSidecar(dir: string): SidecarMap {
  try {
    const p = join(dir, SIDECAR_FILENAME);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as SidecarMap : {};
  } catch {
    return {};
  }
}

function writeSidecar(dir: string, map: SidecarMap): void {
  const p = join(dir, SIDECAR_FILENAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2), "utf-8");
}

/**
 * Look up persisted overrides for a given shape file and merge them UNDER the
 * caller-supplied overrides. Defaults (declared in the script) remain the
 * base layer — they're applied by the engine itself. Returns undefined only
 * when there's nothing to pass; callers then let `executeShapeFile` use
 * script defaults unchanged.
 */
function mergeSidecarOverrides(
  absPath: string,
  callOverrides?: Record<string, number>,
): Record<string, number> | undefined {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const sidecar = readSidecar(dir);
  const persisted = sidecar[base];
  if (!persisted && !callOverrides) return undefined;
  const merged: Record<string, number> = {};
  if (persisted) {
    for (const [k, v] of Object.entries(persisted)) {
      if (typeof v === "number") merged[k] = v;
    }
  }
  if (callOverrides) {
    for (const [k, v] of Object.entries(callOverrides)) {
      if (typeof v === "number") merged[k] = v;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Thin wrapper around `executeShapeFile` that silently applies any persisted
 * sidecar overrides before delegating to the engine. Callers that have their
 * own params to pass (e.g. `tune_params`) supply them via `callOverrides` —
 * those win over the sidecar. This keeps the new persistence behavior OUT of
 * engine.ts (single-responsibility: engine doesn't care about sidecars) and
 * OUT of every individual handler's call-site (no duplicate merge logic).
 *
 * Mesh-result cache: when source contents + merged params + meshQuality match
 * a prior successful execution, we serve the cached outcome WITHOUT live OCCT
 * shape handles (those are scrubbed before storage — see sanitizeOutcomeForCache
 * in engine.ts). Callers that need `parts[i].shape.intersect(...)` /
 * `.shape.faces` etc. (check_collisions, describe_geometry, preview_finder,
 * sweep_check, export_shape) MUST pass `force: true` so the cache is bypassed
 * and the engine re-runs end-to-end. The brief explicitly scopes this to the
 * mesh-only inspection path (render_preview is the canonical hot caller) —
 * `partStats: "full"` also forces, since cached entries were tessellated under
 * the default `"bbox"` fast path and don't carry the OCCT-measured volumes.
 */
async function executeWithPersistedParams(
  absPath: string,
  callOverrides?: Record<string, number>,
  /**
   * Forwarded to {@link executeShapeFile}. Only `export_shape`'s BOM sidecar
   * currently opts in to `"full"` — every other caller omits the arg so the
   * default fast path stays in play.
   *
   * `force: true` skips the mesh cache lookup and repopulates after the
   * underlying execute. Use this from any caller that downstream-derefs
   * `parts[i].shape` (live OCCT handle) — the cache layer scrubs those.
   */
  opts?: {
    partStats?: "none" | "bbox" | "full";
    force?: boolean;
    /**
     * When true, forwarded to `executeShapeFile` to bypass the *bundle* cache
     * (esbuild output). Distinct from `force`, which bypasses the *mesh*
     * cache (tessellated OCCT output). Either may be set independently.
     */
    forceBundleRebuild?: boolean;
  },
): ReturnType<typeof executeShapeFile> {
  const merged = mergeSidecarOverrides(absPath, callOverrides);
  const force = opts?.force === true;
  const forceBundleRebuild = opts?.forceBundleRebuild === true;
  // partStats === "full" path needs OCCT-measured volumes that cached entries
  // (tessellated at the default "bbox" level) don't carry. Treat as a force.
  const needsFreshMeasurement = opts?.partStats === "full";
  const paramsKey = canonicalParamsKey(merged);
  // Fixed bucket for now — the MCP engine doesn't surface a meshQuality
  // override; core auto-degrades on large assemblies. The extension-level
  // screenshot cache (planned in the brief) layers above this on a richer
  // key that includes meshQuality, renderMode, cameraAngle, etc.
  const meshQuality = "default";

  // `forceBundleRebuild` must also bypass the mesh cache: a mesh-cache hit
  // returns before `executeShapeFile` runs, which means the bundle cache is
  // never consulted and no "Cache invalidated: force=true" warning is
  // emitted. The whole point of forceBundleRebuild is to give MCP callers a
  // way to guarantee esbuild re-ran, so serving a stale mesh here would
  // silently defeat the flag.
  if (!force && !needsFreshMeasurement && !forceBundleRebuild) {
    const head = readSourceForCacheKey(absPath);
    if (head) {
      const hit = lookupMeshCache(absPath, head.sourceHash, paramsKey, meshQuality);
      if (hit) {
        process.stderr.write(
          `[mesh-cache] hit absPath=${absPath} hits=${hit.hitCount}\n`,
        );
        return hit.result;
      }
    }
  }

  // Only forward fields the engine actually reads. `force` is a mesh-cache
  // concept local to this wrapper; `forceBundleRebuild` is the engine-side
  // knob for the bundle cache.
  const outcome = await executeShapeFile(absPath, GLOBAL_STORAGE, merged, {
    partStats: opts?.partStats,
    forceBundleRebuild,
  });

  // Only cache successful outcomes. Re-read mtime/source AFTER execution so
  // the entry tracks what was actually rendered, not whatever the file looked
  // like before our pre-read above (the user could have edited mid-flight on
  // a slow render — better to cache the snapshot the engine actually saw).
  if (outcome.status.success && !needsFreshMeasurement) {
    const tail = readSourceForCacheKey(absPath);
    if (tail) {
      populateMeshCache(
        absPath,
        tail.sourceHash,
        tail.mtimeMs,
        paramsKey,
        meshQuality,
        outcome,
      );
    }
  }

  return outcome;
}

// ---------------------------------------------------------------------------
// Pure formatting helpers — exported for unit tests. These are the pure
// report-rendering functions used by check_collisions and sweep_check; they
// do NOT touch OCCT or the filesystem.
// ---------------------------------------------------------------------------

export type CollisionReportFormat = "summary" | "full" | "ids";

export type CollisionEntry = {
  a: string;
  b: string;
  volume: number;
  region?: {
    min: [number, number, number];
    max: [number, number, number];
    /** Per-axis overlap extents (max - min), mm. */
    depths: { x: number; y: number; z: number };
  };
  center?: [number, number, number];
  aabbVolA?: number;
  aabbVolB?: number;
};

function misplacedHint(c: CollisionEntry): string {
  const va = c.aabbVolA;
  const vb = c.aabbVolB;
  if (va === undefined || vb === undefined || va <= 0 || vb <= 0) return "";
  const smaller = Math.min(va, vb);
  const larger = Math.max(va, vb);
  if (smaller / larger >= 0.5) return "";
  const smallerName = va < vb ? c.a : c.b;
  return ` (${smallerName} likely misplaced)`;
}

/** Render the per-pair collision block for check_collisions. */
export function formatCollisionPairs(
  realC: CollisionEntry[],
  pressFitC: CollisionEntry[],
  acceptedC: CollisionEntry[],
  pressFit: number,
  reportFormat: CollisionReportFormat,
  accountingText: string,
): string {
  const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
  const fmtPt = (p: [number, number, number]) =>
    `(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})`;
  const fmtRange = (lo: number, hi: number) => `[${fmt(lo)}, ${fmt(hi)}]`;

  if (reportFormat === "ids") {
    const tuples = realC.map((c) => [c.a, c.b, parseFloat(fmt(c.volume))]);
    return JSON.stringify(tuples);
  }

  const sections: string[] = [accountingText];

  if (realC.length > 0 || pressFitC.length > 0 || acceptedC.length > 0) {
    if (realC.length > 0) {
      if (reportFormat === "full") {
        const lines: string[] = [];
        for (const c of realC) {
          lines.push(`  - ${c.a} \u2194 ${c.b}: ${fmt(c.volume)} mm\u00b3 overlap${misplacedHint(c)}`);
          if (c.region) {
            const r = c.region;
            lines.push(
              `    Region: x${fmtRange(r.min[0], r.max[0])} y${fmtRange(r.min[1], r.max[1])} z${fmtRange(r.min[2], r.max[2])} mm`,
            );
            lines.push(
              `    Overlap depth: X=${fmt(r.depths.x)}mm, Y=${fmt(r.depths.y)}mm, Z=${fmt(r.depths.z)}mm`,
            );
          }
          if (c.center) {
            lines.push(`    Center: ${fmtPt(c.center)} mm`);
          }
        }
        sections.push(`\nCollisions (sorted by volume desc):\n${lines.join("\n")}`);
      } else {
        const lines: string[] = [];
        const [worst, ...rest] = realC;
        lines.push(`  - ${worst.a} \u2194 ${worst.b}: ${fmt(worst.volume)} mm\u00b3 overlap${misplacedHint(worst)}`);
        if (worst.region) {
          const r = worst.region;
          lines.push(
            `    Region: x${fmtRange(r.min[0], r.max[0])} y${fmtRange(r.min[1], r.max[1])} z${fmtRange(r.min[2], r.max[2])} mm`,
          );
          lines.push(
            `    Overlap depth: X=${fmt(r.depths.x)}mm, Y=${fmt(r.depths.y)}mm, Z=${fmt(r.depths.z)}mm`,
          );
        }
        if (worst.center) {
          lines.push(`    Center: ${fmtPt(worst.center)} mm`);
        }
        for (const c of rest) {
          lines.push(`  - ${c.a} vs ${c.b} \u2014 ${fmt(c.volume)} mm\u00b3${misplacedHint(c)}`);
        }
        sections.push(`\nCollisions (sorted by volume desc):\n${lines.join("\n")}`);
      }
    }

    if (pressFitC.length > 0) {
      const lines = pressFitC.map(
        (c) => `  - ${c.a} \u2194 ${c.b}: ${fmt(c.volume)} mm\u00b3`,
      );
      sections.push(
        `\nNominal contact (volume \u2264 ${fmt(pressFit)} mm\u00b3 \u2014 press fits, touching interfaces):\n${lines.join("\n")}`,
      );
    }

    if (acceptedC.length > 0) {
      const volumes = acceptedC.map((c) => c.volume);
      const minV = Math.min(...volumes);
      const maxV = Math.max(...volumes);
      sections.push(
        `\nAccepted (pre-declared expected): ${acceptedC.length} pair${acceptedC.length === 1 ? "" : "s"}, volume ${fmt(minV)}\u2013${fmt(maxV)} mm\u00b3.`,
      );
    }
  }

  return sections.join("\n");
}

export type SweepCollisionEntry = {
  step: number;
  angle: number;
  pairA: string;
  pairB: string;
  volume: number;
};

/** Render the per-step collision block for sweep_check. */
export function formatSweepCollisions(
  collisions: SweepCollisionEntry[],
  angles: number[],
  sweepFormat: CollisionReportFormat,
): string {
  const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : x.toFixed(2));
  const fmtAngle = (a: number) => (Math.abs(a) >= 100 ? a.toFixed(1) : a.toFixed(2));
  const n = angles.length;

  if (sweepFormat === "ids") {
    const byStep = new Map<number, Array<[string, string, number]>>();
    for (const c of collisions) {
      const entry = byStep.get(c.step) ?? [];
      entry.push([c.pairA, c.pairB, parseFloat(fmt(c.volume))]);
      byStep.set(c.step, entry);
    }
    const tuples = Array.from(byStep.entries()).map(([step, pairs]) => [step, pairs]);
    return JSON.stringify(tuples);
  }

  const sections: string[] = [];
  const colidingSteps = new Set(collisions.map((c) => c.step));
  const firstCollide = n > 0
    ? Array.from({ length: n }, (_, i) => i).find((i) => colidingSteps.has(i))
    : undefined;

  if (firstCollide === undefined) {
    sections.push(`  \u2713 Clear through all ${n} steps (angles ${fmtAngle(angles[0])}\u00b0 \u2026 ${fmtAngle(angles[n - 1])}\u00b0)`);
  } else if (firstCollide > 0) {
    sections.push(
      `  \u2713 Clear through steps 0\u2013${firstCollide - 1} (angles ${fmtAngle(angles[0])}\u00b0 \u2026 ${fmtAngle(angles[firstCollide - 1])}\u00b0)`,
    );
  }

  if (sweepFormat === "full") {
    for (const c of collisions) {
      sections.push(
        `  \u2717 Step ${c.step} (angle ${fmtAngle(c.angle)}\u00b0): ${c.pairA} \u2194 ${c.pairB} ${fmt(c.volume)} mm\u00b3`,
      );
    }
  } else {
    // summary: per-step counts + worst step detail
    if (collisions.length > 0) {
      const stepCounts = new Map<number, number>();
      const stepVolumes = new Map<number, number>();
      for (const c of collisions) {
        stepCounts.set(c.step, (stepCounts.get(c.step) ?? 0) + 1);
        stepVolumes.set(c.step, (stepVolumes.get(c.step) ?? 0) + c.volume);
      }
      const sortedSteps = Array.from(stepCounts.keys()).sort((a, b) => a - b);
      for (const s of sortedSteps) {
        const cnt = stepCounts.get(s)!;
        sections.push(
          `  \u2717 Step ${s} (${fmtAngle(angles[s])}\u00b0): ${cnt} collision${cnt === 1 ? "" : "s"}`,
        );
      }
      let worstStep = sortedSteps[0];
      for (const s of sortedSteps) {
        if ((stepVolumes.get(s) ?? 0) > (stepVolumes.get(worstStep) ?? 0)) worstStep = s;
      }
      const worstPairs = collisions.filter((c) => c.step === worstStep);
      sections.push(`\n  Worst step: ${worstStep} (${fmtAngle(angles[worstStep])}\u00b0)`);
      for (const c of worstPairs) {
        sections.push(`    ${c.pairA} \u2194 ${c.pairB}: ${fmt(c.volume)} mm\u00b3`);
      }
    }
  }

  return sections.join("\n");
}

export function registerTools(server: McpServer) {
  server.tool(
    "setup_shape_project",
    "Bootstrap a folder so `.shape.ts` files get correct types in editors. Writes node_modules/shapeitup and node_modules/replicad type stubs + a minimal tsconfig.json if missing. Idempotent — safe to call repeatedly. Does NOT run npm install; replicad and OCCT are bundled inside this MCP server at runtime. Typically you don't need to call this manually: create_shape auto-bootstraps on first write.",
    {
      directory: z.string().optional().describe("Absolute path (defaults to current working directory)."),
    },
    safeHandler("setup_shape_project", async ({ directory = process.cwd() }) => {
      const r = setupShapeProject(directory);
      const parts: string[] = [`Project: ${r.cwd}`];
      if (r.created.length > 0) parts.push(`Created:\n  ${r.created.join("\n  ")}`);
      if (r.skipped.length > 0) parts.push(`Skipped:\n  ${r.skipped.join("\n  ")}`);
      if (r.note) parts.push(r.note);
      if (r.created.length === 0 && !r.note) parts.push("Nothing to do — project is already bootstrapped.");
      return {
        content: [{ type: "text" as const, text: parts.join("\n\n") }],
        isError: !!r.note && r.created.length === 0 && r.skipped.length === 0,
      };
    }),
  );

  server.tool(
    "create_shape",
    "Create a new .shape.ts CAD script file and execute it. Fails if file already exists — use modify_shape to update existing files. Path resolution precedence: absolute `directory` used as-is; relative `directory` probed against each heartbeat-reported VSCode workspace root (first match wins), else `process.cwd()`; omitted `directory` defaults to the first active VSCode workspace root (or cwd if no extension is running). Refuses to create a file when the resolved path contains a duplicated segment (e.g. `examples/examples/...`) unless `allowPathDuplication: true` is passed.",
    {
      name: z
        .string()
        .superRefine((n, ctx) => {
          // Reject callers passing a full filename — we append '.shape.ts'
          // ourselves and doubling produces e.g. `needle.shape.shape.ts`.
          // Check the most-specific suffix first so the suggested stem is
          // computed correctly regardless of which variant was passed.
          const match =
            /\.shape\.ts$/i.exec(n) ??
            /\.shape$/i.exec(n) ??
            /\.ts$/i.exec(n);
          if (match) {
            const stem = n.slice(0, match.index);
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Pass just the stem (e.g. 'needle'). I add '.shape.ts' automatically. Did you mean to pass '${stem}' instead of '${n}'?`,
            });
          }
        })
        .describe("File name without extension (e.g., 'bracket'). Do not include '.shape', '.ts', or '.shape.ts' — the tool appends '.shape.ts' automatically."),
      code: z.string().describe("TypeScript source code using Replicad API"),
      directory: z.string().optional().describe("Directory to create the file in. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first match wins), falling back to process.cwd(). When omitted, defaults to the active VSCode workspace root."),
      overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file (default: false)"),
      allowPathDuplication: z.boolean().optional().describe("Set to true to proceed (with a warning) when the resolved directory has a duplicated last-two segments (e.g. `.../examples/examples`). Default: false — the call refuses in that case and lists the recovery options. Absolute `directory` paths bypass this refusal regardless."),
      verbosity: z.enum(["summary", "full"]).optional().describe("Output verbosity for per-part stats. 'summary' (default) caps at 10 parts then prints a '… and N more' line — keeps the response inside the MCP token budget on large assemblies. 'full' dumps every part (may be large for 20+ part assemblies)."),
    },
    safeHandler("create_shape", async ({ name, code, directory, overwrite, allowPathDuplication, verbosity }) => {
      // Resolve `directory` with the same unified precedence as resolveShapePath:
      // absolute → use as-is; relative → probe each workspace root for an
      // existing directory; else anchor to cwd. For `create_shape` the
      // directory may not exist yet (new subfolder), so we also accept the
      // FIRST workspace root as a fallback when no probe matches — that
      // preserves the ergonomic "directory: 'examples/test'" pattern even when
      // `examples/test` is brand-new.
      const resolveDirArg = (d: string): string => {
        if (isAbsolute(d)) return resolve(d);
        const wsRoots = getHeartbeatWorkspaceRoots();
        for (const root of wsRoots) {
          const cand = resolve(root, d);
          if (existsSync(cand)) return cand;
        }
        // No existing match. If heartbeat reports at least one workspace,
        // prefer anchoring to the first one (the active VSCode window) —
        // otherwise cwd. This keeps create_shape usable for brand-new subdirs.
        if (wsRoots.length > 0) return resolve(wsRoots[0], d);
        return resolve(process.cwd(), d);
      };
      const dir = directory ? resolveDirArg(directory) : getDefaultDirectory();
      const filePath = join(dir, `${name}.shape.ts`);

      if (!code.trim() || !code.includes("function")) {
        return {
          content: [{ type: "text" as const, text: `Invalid code: must contain at least a function definition.` }],
          isError: true,
        };
      }

      // Bug A (strict mode): when `directory` is omitted, getDefaultDirectory()
      // prefers the VSCode heartbeat workspace over process.cwd(). If the two
      // disagree, we can't safely auto-resolve — the shell might be in
      // ShapeItUp/examples while VSCode is focused on a different workspace,
      // and silently writing to either is a footgun. Refuse with a hard error
      // BEFORE the write so the caller can disambiguate.
      if (!directory) {
        const defaultDir = resolve(getDefaultDirectory());
        const cwdAbs = resolve(process.cwd());
        if (defaultDir.toLowerCase() !== cwdAbs.toLowerCase()) {
          return {
            content: [{
              type: "text" as const,
              text: `create_shape: cannot auto-resolve directory because MCP shell cwd and VSCode workspace disagree.\n  shell cwd:         ${cwdAbs}\n  VSCode workspace:  ${defaultDir}\nPass 'directory' explicitly (either of the above, or any other path) to proceed.`,
            }],
            isError: true,
          };
        }
      }

      // Fix #4: hard refusal on duplicated-segment resolution. The previous
      // behaviour emitted a "path doubled" warning and created the file anyway
      // (e.g. cwd=examples + directory="examples" → `examples/examples/...`).
      // That near-universally surprised the caller — the warning was read as
      // advisory, not as a sign the path they wanted had slipped. Now we
      // refuse unless (a) `directory` is absolute (the caller is fully
      // explicit), or (b) `allowPathDuplication: true` is passed (opt-in).
      if (directory && !allowPathDuplication) {
        const dupInfo = detectPathDoublingInfo(dir);
        const dirWasAbsolute = isAbsolute(directory);
        if (dupInfo && !dirWasAbsolute) {
          return {
            content: [{
              type: "text" as const,
              text:
                `create_shape: refusing to create file at ${join(dupInfo.absoluteDir, `${name}.shape.ts`)} — the path segment "${dupInfo.duplicatedSegment}" appears twice in the resolved directory.\n` +
                `Resolved directory: ${dupInfo.absoluteDir}\n` +
                `Duplicated segment: "${dupInfo.duplicatedSegment}"\n` +
                `This usually means the MCP shell cwd is already inside "${dupInfo.duplicatedSegment}" and you passed directory: "${directory}" on top of it.\n` +
                `Recovery options:\n` +
                `  (a) Pass an absolute path, e.g. directory: "${dupInfo.absoluteDir}"\n` +
                `  (b) Pass allowPathDuplication: true to confirm the intent and proceed with just a warning.\n` +
                `  (c) Pass directory: "." if you meant to create the file at the current location.`,
            }],
            isError: true,
          };
        }
      }

      // Idempotent-retry shortcut: if the file already exists and the incoming
      // code is byte-identical, skip the error and treat this as a no-op
      // "content unchanged" success. Removes friction for agents that legitimately
      // call create_shape twice with the same payload (e.g. after a transient
      // timeout) — they'd otherwise see a misleading "file exists" error.
      let contentIdenticalNoOp = false;
      if (existsSync(filePath) && !overwrite) {
        let existing: string | null = null;
        try {
          existing = readFileSync(filePath, "utf-8");
        } catch {
          // Readback failed — fall through to the normal error path; we can't
          // prove the contents match so the safe default is to refuse.
        }
        if (existing !== null && existing === code) {
          contentIdenticalNoOp = true;
        } else {
          // Content differs (or unreadable). Enrich the refusal with the on-disk
          // size + mtime so an agent can decide whether to retry with overwrite
          // or switch to modify_shape.
          let sizeMtimeNote = "";
          try {
            const st = statSync(filePath);
            sizeMtimeNote = ` (${st.size} bytes, modified ${st.mtime.toISOString()})`;
          } catch {}
          return {
            content: [{ type: "text" as const, text: `File already exists: ${filePath}${sizeMtimeNote}\nUse modify_shape to update it, or pass overwrite: true to replace it.` }],
            isError: true,
          };
        }
      }

      mkdirSync(dirname(filePath), { recursive: true });
      // Skip the write when nothing would change — still execute below so the
      // caller gets stats back and the viewer stays in sync.
      if (!contentIdenticalNoOp) {
        writeFileSync(filePath, code, "utf-8");
      }

      // Auto-bootstrap types on first write in a fresh project so agents/
      // editors don't see phantom "Cannot find module 'replicad'" errors.
      // Cheap and idempotent — returns undefined after the first call.
      const bootstrapNote = autoBootstrapIfNeeded(filePath);

      const { status } = await executeWithPersistedParams(filePath);
      notifyExtensionOfShape(filePath);

      const cwd = process.cwd();
      const wsKey = resolve(dir).toLowerCase();
      const dirMatchesCwd = wsKey === resolve(cwd).toLowerCase();
      const shouldEmit = !dirMatchesCwd && !_emittedWorkspaceRoots.has(wsKey);
      if (shouldEmit) _emittedWorkspaceRoots.add(wsKey);
      const cwdNote = shouldEmit
        ? `\n(Resolved to VSCode workspace ${dir}; shell cwd is ${cwd}. Pass 'directory' explicitly to override.)`
        : "";

      // Fix #4 (companion): when a RELATIVE `directory` was passed and the
      // resolver fell back to the first workspace root (because no workspace
      // probe matched a real directory), emit an extra line calling out the
      // mismatch between the chosen workspace and the shell cwd. This does
      // NOT refuse — it's the broader "we chose a plausible path but you
      // should double-check" case. The user's saved memory about silent
      // workspace routing surprises (workspace_mismatch.md) is exactly what
      // this warning targets.
      let fallbackWarning = "";
      if (directory && !isAbsolute(directory)) {
        const wsRoots = getHeartbeatWorkspaceRoots();
        const probedMatch = wsRoots.some(
          (r) => existsSync(resolve(r, directory)),
        );
        if (!probedMatch && wsRoots.length > 0 && !dirMatchesCwd) {
          fallbackWarning =
            `\nNote: no VSCode workspace contained a pre-existing '${directory}' directory, so the resolver fell back to the first workspace root.\n` +
            `  chosen workspace: ${wsRoots[0]}\n` +
            `  shell cwd:        ${cwd}\n` +
            `  final path:       ${filePath}\n` +
            `If that wasn't your intent, pass an absolute 'directory' or set 'directory: "."' to anchor to shell cwd.`;
        }
      }

      const doubledWarning = directory ? detectPathDoubling(dir) : "";
      const actionWord = contentIdenticalNoOp
        ? "Unchanged (content-identical re-create)"
        : overwrite ? "Overwrote" : "Created";
      const bootstrapPrefix = bootstrapNote ? `${bootstrapNote}\n` : "";
      const prefix = `${bootstrapPrefix}${actionWord} ${filePath}${cwdNote}${fallbackWarning}${doubledWarning}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status, verbosity ?? "summary") }],
        isError: !status.success,
      };
    })
  );

  server.tool(
    "open_shape",
    "Execute an existing .shape.ts file and (if VSCode is open) also bring it up in the viewer. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd(). Pass `capture: true` to also take a screenshot (same path render_preview uses); a capture failure does not fail the whole call — it's reported as a warning line.",
    {
      filePath: z.string().describe("Path to the .shape.ts file to execute. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
      capture: z.boolean().optional().describe("If true, after opening, also capture a PNG screenshot (isometric, AI mode, default size) via the VSCode extension. Requires the extension. Capture failures are reported as warnings; the handler still reports the execution status as success."),
      verbosity: z.enum(["summary", "full"]).optional().describe("Output verbosity for per-part stats. 'summary' (default) caps at 10 parts. 'full' dumps every part."),
      forceBundleRebuild: z.boolean().optional().describe("If true, bypasses the bundled-script cache and re-invokes esbuild. Use only when you suspect the cache is stale; the cache normally handles this correctly via mtime tracking."),
    },
    safeHandler("open_shape", async ({ filePath, capture, verbosity, forceBundleRebuild }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      const { status } = await executeWithPersistedParams(
        absPath,
        undefined,
        forceBundleRebuild ? { forceBundleRebuild: true } : undefined,
      );
      notifyExtensionOfShape(absPath);

      let captureLine = "";
      let captureImage: { type: "image"; data: string; mimeType: string } | null = null;
      if (capture === true && status.success) {
        try {
          if (!isExtensionAlive()) {
            captureLine = "\nCapture: skipped — VSCode extension is not running.";
          } else {
            const previewsDir = join(dirname(absPath), "shapeitup-previews");
            const userBase = basename(absPath).replace(/\.shape\.ts$/, "");
            const outPath = join(previewsDir, `shapeitup-preview-${userBase}-isometric.png`);
            try { mkdirSync(previewsDir, { recursive: true }); } catch {}
            const cmdId = sendExtensionCommand("render-preview", {
              filePath: absPath,
              outputPath: outPath,
              targetWorkspaceRoot: computeTargetWorkspaceRoot(absPath),
              renderMode: "ai",
              showDimensions: true,
              showAxes: true,
              cameraAngle: "isometric",
              width: 1280,
              height: 960,
            });
            if (!cmdId) {
              captureLine = "\nCapture: failed to send command to extension.";
            } else {
              const result = await waitForResult(cmdId, 60_000);
              if (!result) {
                captureLine = "\nCapture: timed out after 60000ms (open_shape result still valid).";
              } else if (result.error) {
                // P1 fix: carry stack/operation through to open_shape's
                // capture line so the error matches what render_preview would
                // report for the same underlying failure.
                const sidecar = readViewerErrorIfNewer(GLOBAL_STORAGE);
                const stack: string | undefined =
                  typeof result.errorStack === "string" ? result.errorStack : sidecar?.stack;
                const op: string | undefined =
                  typeof result.errorOperation === "string" ? result.errorOperation : sidecar?.operation;
                let detail = result.error as string;
                if (op) detail += ` (operation: ${op})`;
                if (/require is not defined|__dirname|process\./.test(result.error as string)) {
                  detail += "\nCommonJS restriction: `.shape.ts` files run in both Node (MCP) and a Web Worker (viewer). `require`, `__dirname`, `process.*`, and Node-only APIs are not available in the viewer — use ESM `import` instead.";
                }
                if (stack) {
                  const trimmed = stack
                    .split("\n")
                    .slice(0, 3)
                    .map((l: string) => `  ${l.trim()}`)
                    .filter((l: string) => l.trim().length > 2)
                    .join("\n");
                  if (trimmed.length > 0) detail += `\n${trimmed}`;
                }
                captureLine = `\nCapture: failed — ${detail}`;
              } else if (result.screenshotPath && existsSync(result.screenshotPath)) {
                captureLine = `\nScreenshot: ${result.screenshotPath}`;
                try {
                  const st = statSync(result.screenshotPath);
                  if (st.size <= 10 * 1024 * 1024) {
                    captureImage = {
                      type: "image",
                      data: readFileSync(result.screenshotPath).toString("base64"),
                      mimeType: "image/png",
                    };
                  }
                } catch {
                  // inline read failed — path is still reported
                }
              } else {
                captureLine = "\nCapture: extension did not report a screenshot path.";
              }
            }
          }
        } catch (e: any) {
          captureLine = `\nCapture: unexpected failure — ${e?.message ?? e}`;
        }
      }

      const content: any[] = [{ type: "text" as const, text: formatStatusText(status, verbosity ?? "summary") + captureLine }];
      if (captureImage) content.push(captureImage);
      return {
        content,
        isError: !status.success,
      };
    })
  );

  server.tool(
    "modify_shape",
    "Overwrite an existing .shape.ts file with new code and execute it, OR (when `code` is omitted and `params` is provided) re-execute the file with ephemeral param overrides — skipping the disk write entirely. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd(). If both `code` and `params` are provided, `code` wins and `params` is reported as ignored.",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
      code: z.string().optional().describe("New TypeScript source code. Omit when you only want to re-run with different `params`."),
      params: z.record(z.string(), z.number()).optional().describe("Optional ephemeral param overrides. If `code` is NOT provided, the file on disk is untouched and only the overrides are applied for this execution. If `code` IS provided, `params` is ignored (note appears in response)."),
      verbosity: z.enum(["summary", "full"]).optional().describe("Output verbosity for per-part stats. 'summary' (default) caps at 10 parts. 'full' dumps every part."),
    },
    safeHandler("modify_shape", async ({ filePath, code, params, verbosity }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      if (code === undefined && params === undefined) {
        return {
          content: [{ type: "text" as const, text: "modify_shape: provide `code` (to overwrite the file) or `params` (to re-run with overrides), or both. To execute an existing file without changes, use open_shape." }],
          isError: true,
        };
      }

      let actionLabel: string;
      let paramsIgnoredNote = "";
      if (code !== undefined) {
        writeFileSync(absPath, code, "utf-8");
        actionLabel = "Updated";
        if (params !== undefined) {
          paramsIgnoredNote = "\nNote: `params` ignored — `code` was provided, so the file was overwritten and executed with its declared param defaults.";
        }
      } else {
        actionLabel = "Re-executed (file NOT modified) with params override";
      }

      const callOverrides = code === undefined ? params : undefined;
      const { status } = await executeWithPersistedParams(absPath, callOverrides);
      notifyExtensionOfShape(absPath);

      const prefix = `${actionLabel} ${absPath}${paramsIgnoredNote}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status, verbosity ?? "summary") }],
        isError: !status.success,
      };
    })
  );

  server.tool(
    "read_shape",
    "Read the contents of a .shape.ts file. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd().",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
    },
    safeHandler("read_shape", async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
          resolvedPath: absPath,
        };
      }
      const content = readFileSync(absPath, "utf-8");
      // Issue #7: surface the fully-resolved absolute path alongside the file
      // content. Callers that passed a relative path (e.g. "cad-review/x.shape.ts")
      // otherwise have no way to know which workspace root the probe matched —
      // and downstream tools whose state tracking keys on absolute paths (the
      // Claude Code Edit tool is one) would then refuse edits after a relative-
      // path read. Keeping `content` identical preserves the textual contract.
      return {
        content: [{ type: "text" as const, text: content }],
        resolvedPath: absPath,
      };
    })
  );

  server.tool(
    "delete_shape",
    "Delete a .shape.ts file. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd().",
    {
      filePath: z.string().describe("Path to the .shape.ts file to delete. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
    },
    safeHandler("delete_shape", async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      if (!absPath.endsWith(".shape.ts")) {
        return {
          content: [{ type: "text" as const, text: `Refusing to delete non-.shape.ts file: ${absPath}` }],
          isError: true,
        };
      }
      const { unlinkSync } = require("fs");
      unlinkSync(absPath);
      return { content: [{ type: "text" as const, text: `Deleted ${absPath}` }] };
    })
  );

  server.tool(
    "export_shape",
    "Export the last executed shape to STEP or STL. Optionally pass `filePath` to execute and export a specific file in one call. For multi-part assemblies, pass `partName` to export a single named part instead of the whole assembly. Pass `bom: true` to write a `*.bom.json` sidecar next to the exported file with per-part volume, mass, qty, material, and bounding box.",
    {
      format: z.enum(["step", "stl"]).describe("'step' for CNC/manufacturing or CAD, 'stl' for 3D printing"),
      outputPath: z.string().optional().describe("Output file path. Auto-derived from the source .shape.ts filename if omitted."),
      filePath: z.string().optional().describe("Optional .shape.ts path to execute first. Defaults to the last-executed shape."),
      partName: z.string().optional().describe("For multi-part assemblies: export only the part whose name matches exactly (e.g., 'bolt'). If omitted, the full assembly is exported."),
      openIn: z
        .enum(["prusaslicer", "cura", "bambustudio", "orcaslicer", "freecad", "fusion360"])
        .optional()
        .describe("If set, open the exported file in this app after saving. Requires VSCode + the extension."),
      bom: z.boolean().optional().describe("When true, also write a `*.bom.json` sidecar next to the exported file describing each part's volume_mm3, mass_g (if material declared), qty, material, and min/max bounding box. Basename tracks the source `.shape.ts` (one sidecar per export call, even when per-part STL files are written)."),
    },
    safeHandler("export_shape", async ({ format, outputPath, filePath, partName, openIn, bom }) => {
      // Figure out which file we're exporting. Precedence: explicit arg →
      // in-process last file → status file's fileName (set by VSCode/prior runs).
      let source: string | undefined = filePath ? resolveShapePath(filePath) : getLastFileName();
      if (!source) {
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) source = status.fileName;
        } catch {}
      }
      if (!source) {
        return {
          content: [{ type: "text" as const, text: "Nothing to export — call create_shape, open_shape, or modify_shape first, or pass filePath." }],
          isError: true,
        };
      }

      // Always re-execute — guarantees correctness even if something mutated
      // OCCT state between the last render and now. When `bom` is requested we
      // force `partStats: "full"` so the tessellation loop populates
      // volume/mass via OCCT measurement; otherwise the fast `"bbox"` default
      // stays in play (a BOM with every volume = undefined would be useless).
      // Force-bypass the mesh cache: exportLastToFile pulls live OCCT shapes
      // from core's per-process state (set by the most recent execute), and a
      // cache hit would leave that state pointing at a different file.
      const { status, parts: execParts } = await executeWithPersistedParams(
        source,
        undefined,
        bom === true ? { partStats: "full", force: true } : { force: true },
      );
      if (!status.success) {
        return {
          content: [{ type: "text" as const, text: `Cannot export — render failed.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      // If the caller asked for a specific part, validate up front and fail
      // with a helpful list of available names before we touch the filesystem.
      const availablePartNames = status.partNames ?? [];
      if (partName !== undefined && !availablePartNames.includes(partName)) {
        return {
          content: [{
            type: "text" as const,
            text: `No part named "${partName}" in ${source}. Available parts: ${availablePartNames.join(", ") || "(none)"}`,
          }],
          isError: true,
        };
      }

      // STL can't carry multi-part structure — all parts merge into a single
      // mesh and lose their names/colors. We still honour the caller's
      // request (the export itself succeeds), but append a one-time warning
      // pointing at the STEP + per-part STL alternatives so the caller
      // doesn't discover the loss of fidelity inside their slicer.
      let multiPartWarning = "";
      if (format === "stl" && !partName && availablePartNames.length > 1) {
        multiPartWarning = `\n\nWarning: exporting multi-part assembly (${availablePartNames.length} parts: ${availablePartNames.join(", ")}) to STL merges all parts into a single mesh — part names and colors are lost. Consider STEP format, or pass partName to export an individual part.`;
      }

      // Default output path: include the part name in the file name so
      // single-part exports don't collide with full-assembly exports.
      const defaultSuffix = partName ? `.${partName}.${format}` : `.${format}`;
      const savePath = outputPath || source.replace(/\.shape\.ts$/, defaultSuffix);
      try {
        await exportLastToFile(format, savePath, partName);
      } catch (e: any) {
        const errMsg = e?.message ?? String(e);
        // OOB = OCCT heap poisoned (see packages/core/src/index.ts's
        // patchShapeMeshLeak for the root-cause leak we now patch on init,
        // plus any user-script bug we haven't yet diagnosed). Reset so the
        // next tool call re-initializes a clean WASM instance instead of
        // crashing in the exact same spot.
        if (/memory\s+access\s+out\s+of\s+bounds/i.test(errMsg)) {
          resetCore();
          return {
            content: [{
              type: "text" as const,
              text: `Export failed: ${errMsg}\n\nWASM state was reset due to a memory error; next call will re-initialize OCCT.`,
            }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Export failed: ${errMsg}` }],
          isError: true,
        };
      }

      const fileSize = statSync(savePath).size;
      const sizeStr = fileSize > 1024 * 1024
        ? `${(fileSize / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(fileSize / 1024)}KB`;

      // Optional BOM sidecar. Mirrors the spec from cad-review-feedback:
      // one `*.bom.json` per export call, basenamed after the exported file's
      // source `.shape.ts`. For per-part STL flows (same call, one sidecar)
      // the sidecar still lives in the same directory as savePath. Omitted
      // for failed exports so we never ship a BOM describing a missing file.
      let bomLine = "";
      if (bom === true) {
        try {
          const props = (status as any).properties as ShapeProperties | undefined;
          const propsParts = (props?.parts ?? []) as NonNullable<ShapeProperties["parts"]>;
          const sourceBase = basename(source).replace(/\.shape\.ts$/, "");
          const bomPath = join(dirname(savePath), `${sourceBase}.bom.json`);

          type BomPartEntry = {
            name: string;
            qty: number;
            material?: { density: number; name?: string };
            volume_mm3?: number;
            mass_g?: number;
            boundingBox?: { min: [number, number, number]; max: [number, number, number] };
          };

          // Recompute per-part min/max AABB from the live vertex buffers. The
          // existing `properties.boundingBox` stores {x,y,z} *extent* — BOMs
          // need corners so downstream tooling (pack-on-bed, fit-in-box) can
          // check clearance against a print bed origin.
          const bboxFor = (i: number): BomPartEntry["boundingBox"] | undefined => {
            const v = execParts?.[i]?.vertices;
            if (!v || v.length < 3) return undefined;
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let j = 0; j < v.length; j += 3) {
              if (v[j] < minX) minX = v[j];
              if (v[j] > maxX) maxX = v[j];
              if (v[j + 1] < minY) minY = v[j + 1];
              if (v[j + 1] > maxY) maxY = v[j + 1];
              if (v[j + 2] < minZ) minZ = v[j + 2];
              if (v[j + 2] > maxZ) maxZ = v[j + 2];
            }
            const r = (n: number) => Math.round(n * 1000) / 1000;
            return { min: [r(minX), r(minY), r(minZ)], max: [r(maxX), r(maxY), r(maxZ)] };
          };

          // Filter to the same subset exportLastToFile wrote — when partName
          // is set, only that part's row appears; otherwise every part.
          const filtered = partName
            ? propsParts.filter((p) => p.name === partName)
            : propsParts;

          const bomParts: BomPartEntry[] = filtered.map((p, idx) => {
            const origIdx = partName
              ? propsParts.findIndex((q) => q.name === p.name)
              : idx;
            // Resolve effective material per the spec: per-part override wins,
            // otherwise inherit the script-level material from status.
            const effectiveMaterial = p.material ?? (status as any).material;
            const entry: BomPartEntry = {
              name: p.name,
              qty: typeof p.qty === "number" && p.qty > 0 ? p.qty : 1,
            };
            if (effectiveMaterial && typeof effectiveMaterial.density === "number") {
              entry.material = {
                density: effectiveMaterial.density,
                ...(effectiveMaterial.name ? { name: effectiveMaterial.name } : {}),
              };
            }
            if (typeof p.volume === "number" && Number.isFinite(p.volume)) {
              entry.volume_mm3 = Math.round(p.volume * 100) / 100;
              if (entry.material) {
                // mass_g = density(g/cm³) * volume(mm³) / 1000. Round to 0.01g
                // so slicer-bound JSON doesn't carry phoney precision.
                const raw = (entry.material.density * p.volume) / 1000;
                entry.mass_g = Math.round(raw * 100) / 100;
              }
            }
            const bb = bboxFor(origIdx);
            if (bb) entry.boundingBox = bb;
            return entry;
          });

          const totalMass = bomParts.reduce(
            (s, e) => s + (typeof e.mass_g === "number" ? e.mass_g * (e.qty ?? 1) : 0),
            0,
          );
          const everyHasMass = bomParts.length > 0 && bomParts.every((e) => typeof e.mass_g === "number");

          const bomDoc = {
            source: basename(source),
            exportedAt: new Date().toISOString(),
            format,
            parts: bomParts,
            ...(everyHasMass ? { totalMass_g: Math.round(totalMass * 100) / 100 } : {}),
          };
          writeFileSync(bomPath, JSON.stringify(bomDoc, null, 2), "utf-8");
          bomLine = `\nBOM: ${bomPath}`;
        } catch (e: any) {
          // Best-effort: a sidecar write failure never fails the export.
          bomLine = `\nBOM: write failed (${e?.message ?? e}) — main export succeeded.`;
        }
      }

      // open-in-app still needs the VSCode extension for app detection +
      // launching. Best-effort — never fails the export itself.
      let openLine = "";
      if (openIn) {
        if (!isExtensionAlive()) {
          openLine = `\nOpen-in skipped: VSCode extension not running. Launch the file manually: ${savePath}`;
        } else {
          const cmdId = sendExtensionCommand("open-in-app", { appId: openIn, exportPath: savePath });
          if (cmdId) {
            const result = await waitForResult(cmdId, 15000);
            if (result?.openedIn) openLine = `\nOpened in: ${result.openedIn}`;
            else if (result?.error) openLine = `\nOpen-in warning: ${result.error}`;
          }
        }
      }

      // Describe what was exported. Single-part exports (either because
      // partName was specified or the script only returned one part) show the
      // part name; full multi-part exports list the assembly contents.
      let contentsLine: string;
      if (partName) {
        contentsLine = `\nPart: ${partName} (single part from ${availablePartNames.length}-part assembly)`;
      } else if (availablePartNames.length > 1) {
        contentsLine = `\nParts: ${availablePartNames.join(", ")}`;
      } else if (availablePartNames.length === 1) {
        contentsLine = `\nPart: ${availablePartNames[0]}`;
      } else {
        contentsLine = "";
      }

      // Printability hand-off summary: before the slicer sees this STL/STEP,
      // surface any per-part concerns the engine already computed during
      // rendering (Task 1). Silent on clean exports — the normal response
      // stays unchanged when every part is manifold and above the nozzle
      // threshold. Only considers parts that actually made it into this
      // export (honours `partName` filtering) so a single-part export of a
      // clean part doesn't get warned about a different assembly member.
      let printabilityBlock = "";
      const props = status.properties;
      if (props?.parts && props.parts.length > 0) {
        // Threshold matches engine.ts aggregateProperties: sub-0.1 mm edges
        // are rare enough to be worth surfacing, sub-0.4 was just flagging
        // every boolean-cut artefact.
        const MIN_FEATURE_WARN_MM = 0.1;
        const exported = partName
          ? props.parts.filter((p) => p.name === partName)
          : props.parts;
        const flagged = exported.filter(
          (p) => p.printability && (p.printability.manifold === false || p.printability.issues.length > 0),
        );
        if (flagged.length > 0) {
          const rawLines: string[] = [];
          let sawSmallFeature = false;
          for (const p of flagged) {
            const pr = p.printability!;
            const reasons: string[] = [];
            if (pr.manifold === false) reasons.push("non-manifold geometry");
            if (pr.minFeatureSize_mm < MIN_FEATURE_WARN_MM) {
              reasons.push(
                `minFeature ${pr.minFeatureSize_mm.toFixed(2)} mm — likely boolean artefact, not a printability concern unless a real face is thin`,
              );
              sawSmallFeature = true;
            }
            if (reasons.length === 0 && pr.issues.length > 0) {
              reasons.push(pr.issues[0]);
            }
            rawLines.push(`  - ${p.name}: ${reasons.join("; ")}`);
            if (sawSmallFeature) {
              const attribution = pr.issues.length > 0
                ? `(${pr.issues[0]})`
                : `(source unknown \u2014 inspect faces near minimum feature)`;
              rawLines.push(`    ${attribution}`);
              sawSmallFeature = false;
            }
          }
          // Dedupe: when 48 parts hit the same boolean-artefact wording,
          // collapse them to one line with a "(×N)" suffix so the field
          // report stays readable. Order-preserving.
          const deduped = dedupLines(rawLines);
          const lines: string[] = ["", "\u26a0 Printability concerns before slicing:", ...deduped];
          if (flagged.some((p) => (p.printability?.minFeatureSize_mm ?? 1) < MIN_FEATURE_WARN_MM)) {
            lines.push("");
            lines.push(
              "If Cura/PrusaSlicer skips features or reports manifold errors, consider",
            );
            lines.push(
              "holes.threaded(size, {depth}) instead of threads.tapInto for M2–M5 sizes.",
            );
          }
          printabilityBlock = "\n" + lines.join("\n");
        }
      }

      return {
        content: [{ type: "text" as const, text: `Exported to: ${savePath}\nFormat: ${format.toUpperCase()}\nSize: ${sizeStr}\nSource: ${source}${contentsLine}${bomLine}${openLine}${multiPartWarning}${printabilityBlock}` }],
      };
    })
  );

  server.tool(
    "list_installed_apps",
    "List 3D apps detected on the user's machine (PrusaSlicer, Cura, Bambu Studio, OrcaSlicer, FreeCAD, Fusion 360). Requires VSCode extension — it owns the filesystem scanning logic.",
    {},
    safeHandler("list_installed_apps", async () => {
      if (!isExtensionAlive()) return extensionOfflineError("list_installed_apps");
      const cmdId = sendExtensionCommand("list-installed-apps", {});
      if (!cmdId) {
        return { content: [{ type: "text" as const, text: "Failed to send command to extension" }], isError: true };
      }
      const result = await waitForResult(cmdId, 15000);
      if (!result) {
        return { content: [{ type: "text" as const, text: "list_installed_apps timed out after 15s." }], isError: true };
      }
      const apps: Array<{ id: string; name: string; preferredFormat: string }> = result.apps || [];
      if (apps.length === 0) {
        return { content: [{ type: "text" as const, text: "No compatible 3D apps detected on this machine." }] };
      }
      const lines = apps.map((a) => `- ${a.id} (${a.name}) — preferred format: ${a.preferredFormat.toUpperCase()}`);
      return {
        content: [{ type: "text" as const, text: `Detected apps (pass the id to export_shape's openIn parameter):\n${lines.join("\n")}` }],
      };
    })
  );

  server.tool(
    "list_shapes",
    "Find all .shape.ts files in a directory. Relative `directory` probes each open VSCode workspace (first existing match wins), else falls back to process.cwd(). Omitted `directory` defaults to the first active VSCode workspace root.",
    {
      directory: z.string().optional().describe("Directory to search. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd(). Omitted defaults to the active VSCode workspace root."),
      recursive: z.boolean().optional().describe("Search subdirectories recursively (default: true). Set to false for top-level only."),
    },
    safeHandler("list_shapes", async ({ directory, recursive }) => {
      const usedDefault = !directory;
      // Unified precedence (same as resolveShapePath for filePath args): if
      // the caller passed a relative directory, probe each heartbeat-reported
      // workspace root for an existing match before falling back to cwd.
      const resolveListDir = (d: string): string => {
        if (isAbsolute(d)) return resolve(d);
        const wsRoots = getHeartbeatWorkspaceRoots();
        for (const root of wsRoots) {
          const cand = resolve(root, d);
          if (existsSync(cand)) return cand;
        }
        return resolve(process.cwd(), d);
      };
      const dir = directory ? resolveListDir(directory) : resolve(getDefaultDirectory());
      if (!existsSync(dir)) {
        return {
          content: [{ type: "text" as const, text: `Directory not found: ${dir}` }],
          isError: true,
        };
      }
      const depth = recursive === false ? 1 : 3;
      const files = findShapeFiles(dir, depth);
      // Always surface which directory was actually searched — when no
      // `directory` is passed, agents otherwise can't tell whether we used
      // the workspace root (extension alive) or process.cwd() (fallback).
      const source = usedDefault
        ? isExtensionAlive() ? " (default: active VSCode workspace)" : " (default: cwd — extension not running)"
        : "";
      const header = `Searched: ${dir}${source}\nFound: ${files.length} .shape.ts file${files.length === 1 ? "" : "s"}`;
      const body = files.length > 0 ? `\n\n${files.join("\n")}` : "";
      return {
        content: [{
          type: "text" as const,
          text: header + body,
        }],
      };
    })
  );

  // Thin wrapper around the pure `validateSyntaxPure` — kept separate so the
  // MCP `content: [...]` envelope lives here and the logic stays unit-testable.
  const validateSyntaxImpl = async ({ code }: { code: string }) => {
    const { text, isError } = validateSyntaxPure(code);
    if (isError) {
      return { content: [{ type: "text" as const, text }], isError: true };
    }
    return { content: [{ type: "text" as const, text }] };
  };

  const validateSyntaxSchema = {
    code: z.string().describe("TypeScript source code to validate"),
  };

  server.tool(
    "validate_syntax",
    "Validate TypeScript syntax and detect common CAD pitfalls (sketch mischain, missing sketchOnPlane, unclosed pen, non-uniform scale, oversized fillet, hand-rolled boolean loops including for/while/forEach/reduce with .cut/.fuse/.intersect, fillet-after-boolean). Does NOT verify imports, types, or runtime behavior — for that, call create_shape or modify_shape.",
    validateSyntaxSchema,
    safeHandler("validate_syntax", validateSyntaxImpl)
  );

  // Note: validate_script alias was removed in T6.C — it was a verbatim
  // duplicate of validate_syntax that wasted ~150 tokens of system prompt.
  // Use validate_syntax instead.

  server.tool(
    "preview_shape",
    "Execute a .shape.ts snippet WITHOUT writing it to the user's workspace — ideal for trying boolean-chain variations, sketch tweaks, or debugging steps while iterating. The snippet must have an `export default` main() returning a Shape3D or an array of parts (same contract as create_shape). The code is written to a throwaway temp file, executed through the same engine as create_shape, and deleted afterwards. By default the temp file lives in an isolated globalStorage path — local `./` imports cannot resolve from there. Pass `workingDir` (usually `.` or the workspace root) to have the temp file written there instead, which enables relative imports like `./bolt.shape` to resolve against your workspace. Set captureScreenshot:true to also render a PNG (requires the VSCode extension).",
    {
      code: z.string().describe("Full .shape.ts source — must include an `export default` main() function returning a Shape3D or array of parts. Pair with `workingDir` to enable local `./` imports."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work). Pass the workspace root — usually `.` or an absolute path — to make `./foo.shape` imports from your assembly work."),
      captureScreenshot: z.boolean().optional().describe("If true, also capture a PNG screenshot via the VSCode extension. Default: false. Requires the extension to be running."),
      focusPart: z.string().optional().describe("For multi-part assemblies only: name of a single part to display exclusively in the screenshot — all other parts are hidden. No-op on single-part shapes. Takes precedence over hideParts when both are supplied. The interactive viewer's part visibility is restored after the screenshot."),
      hideParts: z.array(z.string()).optional().describe("For multi-part assemblies only: list of part names to hide in the screenshot. Other parts remain visible. Ignored if focusPart is also set. The interactive viewer's part visibility is restored after the screenshot."),
    },
    safeHandler("preview_shape", async ({ code, workingDir, captureScreenshot, focusPart, hideParts }) => {
      // Cheap pre-flight: reject obvious non-starters before touching the engine.
      // Matches the lightweight check create_shape does — full parse happens in esbuild.
      if (!code || !code.trim()) {
        return {
          content: [{ type: "text" as const, text: "preview_shape: `code` is empty. Provide a full .shape.ts snippet with an `export default` main()." }],
          isError: true,
        };
      }
      if (!code.includes("function") && !/=>/.test(code)) {
        return {
          content: [{ type: "text" as const, text: "preview_shape: snippet must contain at least a function definition (regular or arrow). Did you forget the `export default function main(...)` wrapper?" }],
          isError: true,
        };
      }

      // Decide where the temp file lives. Default: isolated globalStorage path
      // — nothing leaks into the user's tree, but relative imports can't
      // resolve. Opt-in: caller passes `workingDir`, which anchors relative
      // imports via esbuild's resolveDir (engine uses dirname(absPath)).
      // pid+timestamp avoids collisions across concurrent calls in either dir.
      let tempPath: string;
      let usingWorkingDir = false;
      if (workingDir !== undefined) {
        // Reuse the same resolution rule as every other filePath arg: absolute
        // inputs pass through, relatives anchor against the active workspace
        // root (not cwd, which is wrong for stdio children). `.` therefore
        // means "the workspace root", which is the most useful default value
        // for the agent to pass.
        const resolvedDir = resolveShapePath(workingDir);
        if (!existsSync(resolvedDir)) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: workingDir does not exist: ${resolvedDir}. Pass a path to an existing directory (usually the workspace root) — preview_shape will not auto-create directories.`,
            }],
            isError: true,
          };
        }
        let st;
        try {
          st = statSync(resolvedDir);
        } catch (e: any) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: failed to stat workingDir ${resolvedDir}: ${e?.message ?? e}`,
            }],
            isError: true,
          };
        }
        if (!st.isDirectory()) {
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: workingDir is not a directory: ${resolvedDir}. Pass a directory path, not a file.`,
            }],
            isError: true,
          };
        }

        // Opportunistic cleanup of stale snippet files from prior runs that
        // died before the finally-unlink could fire (e.g. hard kill). Capped
        // to files older than an hour so we never nuke a concurrent in-flight
        // snippet. Best-effort; errors are swallowed.
        try {
          const oneHourMs = 60 * 60 * 1000;
          const now = Date.now();
          for (const entry of readdirSync(resolvedDir)) {
            if (!entry.startsWith(".shapeitup-snippet-") || !entry.endsWith(".shape.ts")) continue;
            const full = join(resolvedDir, entry);
            try {
              const est = statSync(full);
              if (now - est.mtimeMs > oneHourMs) unlinkSync(full);
            } catch {}
          }
        } catch {}

        // Leading dot keeps it out of most editor tree views; ts+pid suffix
        // prevents concurrent-call collisions.
        tempPath = join(resolvedDir, `.shapeitup-snippet-${Date.now()}-${process.pid}.shape.ts`);
        usingWorkingDir = true;
      } else {
        mkdirSync(join(GLOBAL_STORAGE, "preview-snippets"), { recursive: true });
        tempPath = join(
          GLOBAL_STORAGE,
          "preview-snippets",
          `snippet-${Date.now()}-${process.pid}.shape.ts`
        );
      }

      const wantScreenshot = captureScreenshot === true;
      let screenshotLine = "";
      let screenshotWarning = "";

      try {
        try {
          writeFileSync(tempPath, code, "utf-8");
        } catch (e: any) {
          // Permission / EROFS / disk full on the chosen dir. Surface it
          // clearly rather than crashing — same status-text convention as the
          // other soft failures in this tool.
          return {
            content: [{
              type: "text" as const,
              text: `preview_shape: failed to write temp snippet at ${tempPath}: ${e?.message ?? e}. Check that the directory is writable.`,
            }],
            isError: true,
          };
        }

        // Same path as create_shape — consistent status output + hints for free.
        const { status } = await executeShapeFile(tempPath, GLOBAL_STORAGE);

        // Screenshot branch: only when requested AND engine run succeeded AND the
        // extension is alive. The temp file MUST survive long enough for the
        // viewer to read it back, so we defer the unlink into the finally below.
        if (wantScreenshot && status.success) {
          if (!isExtensionAlive()) {
            screenshotWarning = "\n(Screenshot skipped: VSCode extension is not running.)";
          } else {
            // Bug #2: pin the previews dir to the tempfile's OWN dirname —
            // same canonical rule as render_preview and tune_params. Previously
            // this used readHeartbeat().workspaceRoots[0], which in
            // multi-window VSCode setups could point at a workspace that
            // doesn't own the snippet, landing the PNG in the wrong place.
            // Anchoring to dirname(tempPath) makes output a pure function of
            // the input: when `workingDir` was passed the PNG lands next to
            // the user's workspace; when it wasn't, the PNG lands alongside
            // the isolated globalStorage snippet (still readable via the
            // returned absolute path).
            const previewsDir = join(dirname(tempPath), "shapeitup-previews");
            // Deterministic snippet-based filename derived from the tempfile
            // basename (strip .shape.ts) so concurrent preview_shape calls
            // don't collide and each PNG is traceable to its snippet.
            const snippetBase = basename(tempPath).replace(/\.shape\.ts$/, "");
            const expectedOutputPath = join(previewsDir, `shapeitup-preview-${snippetBase}.png`);

            const cmdId = sendExtensionCommand("render-preview", {
              filePath: tempPath,
              outputPath: expectedOutputPath,
              targetWorkspaceRoot: computeTargetWorkspaceRoot(tempPath),
              renderMode: "ai",
              showDimensions: true,
              cameraAngle: "isometric",
              width: 1280,
              height: 960,
              focusPart,
              hideParts,
            });
            if (!cmdId) {
              screenshotWarning = "\n(Screenshot skipped: failed to send command to extension.)";
            } else {
              // Reviewer feedback: 60s timed out on a cold-cache enclosure
              // snippet where a proper render just needed a couple more seconds.
              // 120s matches the worker's own defensive ceiling for heavy
              // OCCT shells/offsets; callers can still override via timeoutMs
              // on the extension side. Only the inline-screenshot path gets
              // the bump — the text-only status path stays fast.
              const timeoutMs = 120_000;
              const result = await waitForResult(cmdId, timeoutMs);
              if (!result) {
                const reason = lastWaitTimeoutReason === "slow"
                  ? `Screenshot exceeded ${timeoutMs / 1000}s. Large enclosures can take longer on cold caches. Options: save the snippet to a file (cached across calls), lower the mesh quality via \`export const config = { meshQuality: 'preview' }\`, or pass a larger \`timeoutMs\`.`
                  : "extension stopped responding.";
                screenshotWarning = `\n(Screenshot skipped: ${reason})`;
              } else if (result.error) {
                screenshotWarning = `\n(Screenshot skipped: ${result.error})`;
              } else if (result.screenshotPath) {
                // Fix B (Bug #5): single-source-of-truth rule — derive from
                // status.partNames. See computePartsLine for rationale.
                const partsLine = computePartsLine(
                  focusPart,
                  hideParts,
                  status.partNames ?? [],
                  "focused",
                );
                const partWarnLine = Array.isArray(result.partWarnings) && result.partWarnings.length > 0
                  ? `\nPart warnings: ${result.partWarnings.join("; ")}`
                  : "";
                screenshotLine = `\nScreenshot: ${result.screenshotPath}${partsLine}${partWarnLine}`;
                // Fix #6: record the screenshot on the status file so
                // `get_render_status` can surface it. Snippet renders use
                // the tempPath as fileName — it's the only sensible label,
                // even though the snippet won't survive the tool call.
                try {
                  appendScreenshotMetadata(
                    {
                      timestamp: Date.now(),
                      path: result.screenshotPath,
                      renderMode: "ai",
                      cameraAngle: "isometric",
                      fileName: basename(tempPath),
                      sourceFile: tempPath,
                    },
                    GLOBAL_STORAGE,
                  );
                } catch {
                  // Best effort.
                }
              }
            }
          }
        }

        const header = usingWorkingDir
          ? `Snippet executed (not saved to disk)\nSnippet written to: ${tempPath}\n`
          : "Snippet executed (not saved to disk)\n";
        const body = formatStatusText(status) + screenshotLine + screenshotWarning;
        return {
          content: [{ type: "text" as const, text: header + body }],
          // A failed render is a tool error (the snippet didn't work). A missing
          // screenshot when render succeeded is just a warning — not isError.
          isError: !status.success,
        };
      } finally {
        // Always clean up the temp file — engine failures, screenshot timeouts,
        // and thrown exceptions all funnel through here.
        try { unlinkSync(tempPath); } catch {}
      }
    })
  );

  server.tool(
    "tune_params",
    "Re-execute an existing .shape.ts with ephemeral `params` overrides WITHOUT modifying the file — the file on disk is untouched. Returns the same stats as get_render_status (volume, surface area, bounding box, timings, warnings) so agents can binary-search a design constraint (target volume, bounding box, mass, fit tolerance) before committing the winning value with modify_shape. Pass `captureScreenshot: true` to also render a PNG of the tuned configuration via the VSCode extension. Pass `persist: true` to also write the override map to a `.shapeitup-params.json` sidecar next to the file so every later execution (render_preview, open_shape, export_shape, etc.) picks them up automatically; clear with `clear_params`.",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
      params: z.record(z.string(), z.number()).describe("Map of param name → override value. Only listed params are overridden; others fall back to the file's declared defaults. Values must be numbers."),
      captureScreenshot: z.boolean().optional().describe("If true, also capture a PNG screenshot of the tuned configuration via the VSCode extension. Default: false. Requires the extension to be running."),
      inline: z.boolean().optional().describe("When used with captureScreenshot, also return the PNG as an inline image content block (base64) so the agent can see it without a second get_preview call. Skipped silently if the PNG exceeds 10 MB. Default: false."),
      persist: z.boolean().optional().describe("If true AND the render succeeds, write the override map to `.shapeitup-params.json` next to the file so subsequent render_preview/open_shape/export_shape/etc. calls pick them up automatically. Default: false (stateless, legacy behavior). Precedence: script defaults < sidecar < call-time params. Clear with `clear_params`."),
    },
    safeHandler("tune_params", async ({ filePath, params, captureScreenshot, inline, persist }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      if (!absPath.endsWith(".shape.ts")) {
        return {
          content: [{ type: "text" as const, text: `tune_params only operates on .shape.ts files: ${absPath}` }],
          isError: true,
        };
      }

      // Summary of the overrides for the response header. Render this even on
      // failure so the agent can see what it just tried.
      const entries = Object.entries(params);
      const paramsSummary = entries.length > 0
        ? entries.map(([k, v]) => `${k}=${v}`).join(", ")
        : "(none)";

      // Honor any existing persisted sidecar as the middle layer — call-time
      // `params` still win at the top. This matters when an agent starts a
      // tuning session with `persist: true` on one param, then iterates on a
      // second param via plain `tune_params` calls: the first param stays
      // pinned in the sidecar, the second stays ephemeral, and the render
      // reflects both.
      const { status } = await executeWithPersistedParams(absPath, params);

      // Warn about keys that aren't declared in the script's `params` object.
      // The engine silently accepts unknown keys (they just don't do anything);
      // flagging them at the MCP layer is how the agent learns about a typo.
      //
      // Bug #7 fix: on render failure, `currentParams` is absent (the executor
      // never got far enough to populate it). Fall back to `declaredParams`,
      // which engine.ts now extracts statically from the source code before
      // esbuild runs — that way the "Declared: ..." line stays informative
      // when the user's script crashes the WASM heap, has a typo, etc.
      const declaredKeys = status.currentParams
        ? Object.keys(status.currentParams)
        : (status.declaredParams ?? []);
      const requestedKeys = Object.keys(params);
      const ignoredKeys = requestedKeys.filter((k) => !declaredKeys.includes(k));
      const warningLines: string[] = [];
      if (status.success && declaredKeys.length === 0 && requestedKeys.length > 0) {
        warningLines.push(
          "Note: this script doesn't declare any params — tune_params had no effect. Add `export const params = { ... }` to the file to make it tunable."
        );
      } else if (ignoredKeys.length > 0) {
        warningLines.push(
          `Note: ignored unknown param${ignoredKeys.length === 1 ? "" : "s"} (not declared in script's params): ${ignoredKeys.join(", ")}. Declared: ${declaredKeys.join(", ") || "(none)"}`
        );
      }

      const header = `Tuned (file NOT modified) with: ${paramsSummary}\n`;
      const warningBlock = warningLines.length > 0 ? warningLines.join("\n") + "\n" : "";
      let responseText = header + warningBlock + formatStatusText(status);

      // Persistence branch — write the sidecar AFTER a successful render so a
      // broken parameter set doesn't get locked in. Only the declared keys
      // are persisted (unknown-key warnings were surfaced above; persisting
      // them would be a trap). Existing entries for OTHER files in the same
      // directory are preserved. Skipped on empty `params` to avoid writing
      // an empty record.
      if (persist === true && status.success && entries.length > 0) {
        try {
          const dir = dirname(absPath);
          const base = basename(absPath);
          const existing = readSidecar(dir);
          const declaredSet = new Set(declaredKeys);
          const toPersist: Record<string, number> = { ...(existing[base] ?? {}) };
          for (const [k, v] of entries) {
            // Only persist declared keys — unknown keys were already flagged
            // as ignored; saving them would create phantom overrides that
            // never take effect.
            if (declaredSet.has(k) && typeof v === "number") {
              toPersist[k] = v;
            }
          }
          existing[base] = toPersist;
          writeSidecar(dir, existing);
          responseText += `\n(Persisted to ${join(dir, SIDECAR_FILENAME)}. Clear with clear_params.)`;
        } catch (e: any) {
          responseText += `\n(Persist failed: ${e?.message ?? e}. Render still succeeded.)`;
        }
      } else if (persist === true && !status.success) {
        responseText += "\n(Persist skipped: render failed; sidecar unchanged.)";
      }

      // Optional screenshot branch — only meaningful on a successful render
      // AND when the extension is running. Mirrors the preview_shape pattern
      // (warning, not isError, when the screenshot can't be produced).
      let capturedScreenshotPath: string | undefined;
      if (captureScreenshot === true && status.success) {
        if (!isExtensionAlive()) {
          responseText += "\n(Screenshot skipped: VSCode extension is not running.)";
        } else {
          // Pin output path to dirname(absPath)/shapeitup-previews — same
          // canonical rule as render_preview, so tune_params and render_preview
          // write to the same place for the same shape regardless of which
          // VSCode window is active.
          const previewsDir = join(dirname(absPath), "shapeitup-previews");
          const tuneBase = basename(absPath).replace(/\.shape\.ts$/, "");
          const tuneOutputPath = join(previewsDir, `shapeitup-preview-${tuneBase}-tuned-isometric.png`);
          const cmdId = sendExtensionCommand("render-preview", {
            filePath: absPath,
            outputPath: tuneOutputPath,
            targetWorkspaceRoot: computeTargetWorkspaceRoot(absPath),
            renderMode: "ai",
            showDimensions: true,
            cameraAngle: "isometric",
            width: 1280,
            height: 960,
            // Forwarded to the extension host, which threads it through
            // executeScript → viewer → worker so the PNG matches the tuned
            // configuration we just stat'd, not the file's defaults.
            params,
          });
          if (!cmdId) {
            responseText += "\n(Screenshot skipped: failed to send command to extension.)";
          } else {
            const result = await waitForResult(cmdId, 60_000);
            if (!result) {
              const reason = lastWaitTimeoutReason === "slow"
                ? "extension is alive but render exceeded 60s"
                : "extension stopped responding";
              responseText += `\n(Screenshot skipped: ${reason}.)`;
            } else if (result.error) {
              responseText += `\n(Screenshot skipped: ${result.error})`;
            } else if (result.screenshotPath) {
              responseText += `\nScreenshot: ${result.screenshotPath}`;
              capturedScreenshotPath = result.screenshotPath;
              // Fix #6: record the tune_params screenshot. Matches
              // render_preview / preview_shape so get_render_status always
              // reflects the most recent PNG regardless of which tool made it.
              try {
                appendScreenshotMetadata(
                  {
                    timestamp: Date.now(),
                    path: result.screenshotPath,
                    renderMode: "ai",
                    cameraAngle: "isometric",
                    fileName: basename(absPath),
                    sourceFile: absPath,
                  },
                  GLOBAL_STORAGE,
                );
              } catch {
                // Best effort.
              }
            }
          }
        }
      }

      const textBlock = { type: "text" as const, text: responseText };

      // Inline-image branch mirrors the render_preview pattern (~L2500–2531):
      // on success, read the PNG from disk and append a base64 image content
      // block so the caller gets bytes + path in a single round trip. 10 MB
      // ceiling matches get_preview / render_preview's inline guard. The
      // text block with the path is preserved either way so agents that
      // skip inline still have the filesystem reference.
      if (inline === true && capturedScreenshotPath) {
        try {
          const st = statSync(capturedScreenshotPath);
          if (st.size > 10 * 1024 * 1024) {
            return {
              content: [
                textBlock,
                {
                  type: "text" as const,
                  text: `\n(inline=true requested but PNG is ${(st.size / 1024 / 1024).toFixed(1)} MB, exceeding the 10 MB inline limit. Reduce width/height or use the Read tool on the saved path.)`,
                },
              ],
              isError: !status.success,
            };
          }
          const data = readFileSync(capturedScreenshotPath).toString("base64");
          return {
            content: [
              textBlock,
              { type: "image" as const, data, mimeType: "image/png" },
            ],
            isError: !status.success,
          };
        } catch (e: any) {
          return {
            content: [
              textBlock,
              {
                type: "text" as const,
                text: `\n(inline=true requested but failed to read PNG at ${capturedScreenshotPath}: ${e?.message ?? e}. Use the Read tool on the saved path instead.)`,
              },
            ],
            isError: !status.success,
          };
        }
      }

      return {
        content: [textBlock],
        isError: !status.success,
      };
    })
  );

  server.tool(
    "clear_params",
    "Clear persisted param overrides written by `tune_params({ persist: true })`. Persistence model: `tune_params` with `persist: true` writes a `.shapeitup-params.json` sidecar alongside the shape file; subsequent executions (render_preview, open_shape, export_shape, modify_shape, preview_finder, check_collisions) merge those overrides on top of the script's declared defaults. Call-time overrides always win over the sidecar. Pass `filePath` to remove a single file's entry (other files in the same directory keep theirs). Pass `all: true` to delete the sidecar entirely (requires either `filePath` OR `workingDir` to locate it — when only `all` is given without a locator, the current VSCode workspace root is used).",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file whose sidecar entry should be removed. Absolute or relative (probes workspace roots). Mutually exclusive with `all`."),
      all: z.boolean().optional().describe("When true, delete the entire sidecar in the resolved directory (all files' overrides). Use `filePath` or `workingDir` to pick the directory. Mutually exclusive with a bare `filePath` unless you want to clear the whole sidecar located at dirname(filePath)."),
      workingDir: z.string().optional().describe("Directory containing the `.shapeitup-params.json` sidecar. Only used with `all: true` when no `filePath` is supplied. Defaults to the active VSCode workspace root."),
    },
    safeHandler("clear_params", async ({ filePath, all, workingDir }) => {
      if (!filePath && !all) {
        return {
          content: [{ type: "text" as const, text: "clear_params: pass `filePath` (clear one entry) or `all: true` (delete the whole sidecar)." }],
          isError: true,
        };
      }

      // Resolve the sidecar directory. For a filePath, use its dirname; for a
      // plain `all: true`, honor workingDir or fall back to the workspace root.
      let sidecarDir: string;
      let targetBase: string | undefined;
      if (filePath) {
        const absPath = resolveShapePath(filePath);
        sidecarDir = dirname(absPath);
        targetBase = basename(absPath);
      } else if (workingDir) {
        sidecarDir = resolveShapePath(workingDir);
      } else {
        sidecarDir = getDefaultDirectory();
      }

      const sidecarPath = join(sidecarDir, SIDECAR_FILENAME);
      if (!existsSync(sidecarPath)) {
        return {
          content: [{ type: "text" as const, text: `No sidecar to clear — ${sidecarPath} doesn't exist.` }],
        };
      }

      if (all === true) {
        // Nuke the whole file. Simpler than rewriting to `{}` and surfaces
        // the removal clearly in a diff/listing.
        try {
          unlinkSync(sidecarPath);
          return {
            content: [{ type: "text" as const, text: `Deleted sidecar ${sidecarPath}.` }],
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to delete ${sidecarPath}: ${e?.message ?? e}` }],
            isError: true,
          };
        }
      }

      // Per-file removal. Rewrite the sidecar without the target key; if that
      // leaves it empty, delete the whole file so the directory stays tidy.
      try {
        const map = readSidecar(sidecarDir);
        if (!targetBase || !(targetBase in map)) {
          return {
            content: [{ type: "text" as const, text: `No entry for ${targetBase ?? filePath} in ${sidecarPath} — nothing to clear.` }],
          };
        }
        delete map[targetBase];
        if (Object.keys(map).length === 0) {
          unlinkSync(sidecarPath);
          return {
            content: [{ type: "text" as const, text: `Cleared entry for ${targetBase} and removed empty sidecar ${sidecarPath}.` }],
          };
        }
        writeSidecar(sidecarDir, map);
        return {
          content: [{ type: "text" as const, text: `Cleared entry for ${targetBase} in ${sidecarPath}. Remaining entries: ${Object.keys(map).join(", ")}.` }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to update ${sidecarPath}: ${e?.message ?? e}` }],
          isError: true,
        };
      }
    })
  );

  server.tool(
    "get_api_reference",
    "Get Replicad API reference. Call without category to list available categories, pass `search` to find the most relevant sections across all categories, or pass `signaturesOnly: true` to get just the method signatures (token-efficient lookup).",
    {
      category: z
        .enum(["overview", "drawing", "sketching", "solids", "booleans", "modifications", "transforms", "finders", "export", "examples", "stdlib"])
        .optional()
        .describe("API category. Omit to see the list of available categories."),
      search: z.string().optional().describe("Keyword / phrase to search for across all categories. Returns the most relevant sections instead of one full category. Can be combined with `category` to search within a single category."),
      signaturesOnly: z.boolean().optional().describe("Return only method signatures (lines with `→` or top-level function/method declarations) from the requested category. Strips examples and prose for a compact lookup. Requires `category`."),
    },
    safeHandler("get_api_reference", async ({ category, search, signaturesOnly }) => {
      if (search && search.trim().length > 0) {
        return { content: [{ type: "text" as const, text: searchApiReference(search, category) }] };
      }
      if (!category) {
        return {
          content: [{
            type: "text" as const,
            text: "Available API reference categories:\n- overview (start here)\n- drawing (2D shapes)\n- sketching (2D → 3D)\n- solids (3D operations)\n- booleans (cut, fuse, intersect)\n- modifications (fillet, chamfer, shell)\n- transforms (translate, rotate, mirror)\n- finders (edge/face selection)\n- export (STEP, STL)\n- examples (complete worked examples)\n- stdlib (mechanical/3D-print helpers: holes, screws, bearings, extrusions, print hints)\n\nCall get_api_reference with a category name for detailed docs, or pass `search` to search across all categories.",
          }],
        };
      }
      const body = getApiReference(category);
      if (signaturesOnly) {
        return { content: [{ type: "text" as const, text: extractSignatures(body, category) }] };
      }
      return { content: [{ type: "text" as const, text: body }] };
    })
  );

  server.tool(
    "render_preview",
    "Capture a PNG screenshot of the current shape. Requires VSCode + the ShapeItUp extension to be running (the extension renders via its webview, which works regardless of window size — the canvas is temporarily resized to the requested resolution). Preview PNGs are written to `{workspace}/shapeitup-previews/` — Read the returned absolute path to view the image. For headless verification without VSCode, use get_render_status which returns volume, surface area, center of mass, and bounding box. Pass `finder` to paint pink highlight spheres on the matched edges/faces in the screenshot (for just a text match count with no PNG, use `preview_finder`). Pass `meshQuality: 'preview'` to speed up first-render on large assemblies at the cost of coarser facets; defaults to auto-degrade (preview for 15+ parts, final otherwise). Pass `cameraAngle` as an array (e.g. ['isometric', 'front', 'right']) or `grid: true` to composite multiple angles into a single labelled collage PNG.",
    {
      filePath: z.string().optional().describe("Optional .shape.ts to execute first. Defaults to the last-executed shape."),
      cameraAngle: z
        .any()
        .optional()
        .superRefine((val, ctx) => {
          if (val === undefined) return;
          const presets = ["isometric", "iso", "top", "bottom", "front", "back", "left", "right"] as const;
          const isPreset = (x: unknown): x is (typeof presets)[number] =>
            typeof x === "string" && (presets as readonly string[]).includes(x);
          const describe = (x: unknown): string => {
            if (typeof x === "string") return JSON.stringify(x);
            try {
              return JSON.stringify(x);
            } catch {
              return String(x);
            }
          };
          const expected = `Expected one of [${presets.join(", ")}] or an array of 1–4 of these.`;
          if (typeof val === "string") {
            if (!isPreset(val)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${expected} Got ${describe(val)}.`,
              });
            }
            return;
          }
          if (Array.isArray(val)) {
            if (val.length < 1 || val.length > 4) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${expected} Got an array of length ${val.length}.`,
              });
              return;
            }
            const bad = val.filter((x) => !isPreset(x));
            if (bad.length > 0) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${expected} Got ${describe(val)} (invalid entries: ${bad.map(describe).join(", ")}).`,
              });
            }
            return;
          }
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${expected} Got ${describe(val)}.`,
          });
        })
        .describe("Camera angle preset (default: 'isometric'). Aliases: 'iso' → 'isometric'. Also accepts an array of 1–4 angles — each is captured separately and composited into one collage PNG (1×N strip for 2–3 angles, 2×2 grid for 4)."),
      grid: z
        .boolean()
        .optional()
        .describe("Shortcut for cameraAngle: ['isometric', 'front', 'right', 'top']. Ignored when an explicit cameraAngle array is also passed."),
      showDimensions: z.boolean().optional().describe("Overlay bounding-box dimensions (default: true)"),
      showAxes: z.boolean().optional().describe("Overlay X/Y/Z coordinate axes in the screenshot (default: true). Helpful for orienting symmetric or complex models. Pass false to suppress."),
      renderMode: z.enum(["ai", "dark"]).optional().describe("'ai' for high-contrast light background (default), 'dark' for dark mode"),
      width: z.number().optional().describe("Output width in pixels (default 1280)"),
      height: z.number().optional().describe("Output height in pixels (default 960)"),
      timeoutMs: z
        .number()
        .int()
        .min(10000)
        .optional()
        .describe("Upper bound in milliseconds before giving up. Default 60000 (60s). Cold OCCT renders on complex geometry may need more. Values above ~180000 are rarely useful."),
      focusPart: z.string().optional().describe("For multi-part assemblies only: name of a single part to display exclusively in the screenshot — all other parts are hidden. No-op on single-part shapes. Takes precedence over hideParts when both are supplied. The interactive viewer's part visibility is restored after the screenshot."),
      hideParts: z.array(z.string()).optional().describe("For multi-part assemblies only: list of part names to hide in the screenshot. Other parts remain visible. Ignored if focusPart is also set. The interactive viewer's part visibility is restored after the screenshot."),
      finder: z.string().optional().describe("Optional EdgeFinder/FaceFinder expression, e.g. 'new EdgeFinder().inDirection(\"Z\")'. When provided, the rendered screenshot shows pink highlight spheres at each matched entity — same as preview_finder, but the PNG is saved alongside other render_previews (not ephemeral)."),
      partName: z.string().optional().describe("With `finder` on a multi-part assembly: apply the finder to the part whose name matches exactly. Wins over partIndex when both are given. Ignored when `finder` isn't set."),
      partIndex: z.number().int().nonnegative().optional().describe("With `finder` on a multi-part assembly: 0-based index of the part to apply the finder to (default: 0). Ignored when `finder` isn't set or `partName` is provided."),
      meshQuality: z
        .enum(["preview", "final"])
        .optional()
        .describe("Tessellation-quality preset. `'final'` (default for <15-part assemblies) matches the pre-existing render quality. `'preview'` coarsens the mesh ~2.5× for faster first-render on large assemblies, at the cost of visibly chunkier facets — choose this for layout checks on 15+ part assemblies. If omitted, the extension auto-degrades to `'preview'` when the part count is >= 15 and uses `'final'` otherwise."),
      inline: z.boolean().optional().describe("Return the rendered PNG inline as base64 image content on top of the usual text + file path. Default true — agents see the image directly without an extra `get_preview` round trip. Skipped inline if the file exceeds 10 MB. Pass false to skip the base64 payload (saves ~30% response size) when you only need the path."),
      verbosity: z.enum(["summary", "full"]).optional().describe("Output verbosity for per-part stats in the status text. 'summary' (default) caps at 10 parts. 'full' dumps every part."),
      forceBundleRebuild: z.boolean().optional().describe("If true, bypasses the bundled-script cache and re-invokes esbuild. Use only when you suspect the cache is stale; the cache normally handles this correctly via mtime tracking."),
    },
    safeHandler("render_preview", async ({ filePath, cameraAngle, grid, showDimensions, showAxes, renderMode, width, height, timeoutMs, focusPart, hideParts, finder, partName, partIndex, meshQuality, inline, verbosity, forceBundleRebuild }) => {
      // Fix #4: normalize "iso" alias → "isometric" so downstream code and the
      // extension IPC only ever see the canonical preset name.
      const normalizeAngle = (a: string): string => (a === "iso" ? "isometric" : a);
      if (typeof cameraAngle === "string") {
        cameraAngle = normalizeAngle(cameraAngle) as typeof cameraAngle;
      } else if (Array.isArray(cameraAngle)) {
        cameraAngle = cameraAngle.map(normalizeAngle) as typeof cameraAngle;
      }

      // AI render mode quality guard: faceted preview meshes mislead an AI
      // agent doing visual analysis of the screenshot. When renderMode is
      // "ai" (the default) and the caller did NOT explicitly set meshQuality,
      // force "final" so the AI always sees accurate geometry.
      // If the caller explicitly passes meshQuality (including "preview") we
      // respect their choice — they know what they want.
      const effectiveMeshQuality = computeEffectiveMeshQuality(renderMode, meshQuality);
      if (effectiveMeshQuality !== meshQuality) {
        console.error(
          `[render] auto-upgrade meshQuality preview→final because renderMode=${renderMode ?? "ai"} (default)`
        );
      }

      // Resolve which file to render: explicit > engine's last-executed > status file.
      const explicitFilePath = filePath !== undefined && filePath !== null;
      let source: string | undefined = filePath ? resolveShapePath(filePath) : getLastFileName();
      if (!source) {
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) source = status.fileName;
        } catch {}
      }
      if (!source) {
        return {
          content: [{ type: "text" as const, text: "No shape to preview. Call create_shape, open_shape, or modify_shape first, or pass filePath." }],
          isError: true,
        };
      }

      if (!isExtensionAlive()) {
        // Headless fallback: render a 4-view SVG wireframe from the
        // OCCT-tessellated edges we already have. Not as pretty as the
        // Three.js viewer, but lets agents verify silhouette and proportions
        // without any running VS Code window.
        const parts = getLastParts();
        if (parts.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text:
                `render_preview: no tessellated parts available and VS Code extension isn't running. ` +
                `Run create_shape / modify_shape / open_shape first so the engine has geometry to render.`,
            }],
            isError: true,
          };
        }

        const svgOut = renderPartsToSvg(parts);
        const ts = Date.now();
        const previewsDir = join(GLOBAL_STORAGE, "shapeitup-previews");
        const svgPath = join(previewsDir, `headless-${ts}.svg`);
        const pngPath = join(previewsDir, `headless-${ts}.png`);
        try {
          mkdirSync(previewsDir, { recursive: true });
          writeFileSync(svgPath, svgOut.svg, "utf-8");
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Failed to write headless SVG preview: ${e.message}` }],
            isError: true,
          };
        }

        const liveRoots = getHeartbeatWorkspaceRoots();
        const rootHint = liveRoots.length > 0
          ? `\nFor the richer Three.js preview, focus a VS Code window with one of these workspaces open: ${liveRoots.join(", ")}`
          : "\nFor the richer Three.js preview, open the .shape.ts file in VS Code with the ShapeItUp extension.";

        // Rasterize the SVG → PNG so the agent gets a visible image in the
        // response, not just a file path. Resvg-wasm pays a ~4 MB first-call
        // init; after that each render is fast.
        let pngBuf: Buffer | null = null;
        let rasterError: string | null = null;
        try {
          pngBuf = await svgToPng(svgOut.svg, width ?? 800);
          writeFileSync(pngPath, pngBuf);
        } catch (e: any) {
          rasterError = e?.message ?? String(e);
        }

        const textBlock = {
          type: "text" as const,
          text:
            `Headless wireframe preview (VS Code extension not running).\n` +
            `${svgOut.summary}\n` +
            (pngBuf ? `PNG: ${pngPath}\nSVG: ${svgPath}` : `SVG: ${svgPath}\n(PNG rasterization failed: ${rasterError ?? "unknown"} — read the SVG directly.)`) +
            rootHint,
        };

        if (pngBuf && pngBuf.length < 10 * 1024 * 1024) {
          return {
            content: [
              textBlock,
              {
                type: "image" as const,
                data: pngBuf.toString("base64"),
                mimeType: "image/png",
              },
            ],
            isError: false,
          };
        }

        return { content: [textBlock], isError: false };
      }

      // Bug #10: hard pre-flight check for cross-workspace renders. If the
      // shape lives outside EVERY heartbeat-reported VSCode workspace, the
      // bundler will later fail with the misleading "Could not resolve
      // 'shapeitup'" — the real cause is that no open window owns this
      // folder, so nothing can serve the render. Refuse up front with an
      // actionable message instead of letting the bundler error bubble up.
      // Note: preview_shape deliberately skips this check — its snippets live
      // in an isolated globalStorage dir and have no user-visible workspace
      // context, so a hard refusal would break every snippet render.
      {
        const wsErr = assertWorkspaceOwned(source);
        if (wsErr) return wsErr;
      }

      // When no explicit filePath was passed, the default `source` came from
      // engine.getLastFileName() — which is the process-wide "last executed
      // shape", regardless of which window currently owns focus. In a
      // multi-window VSCode setup, that file may belong to a workspace that is
      // not the one the extension host will route this render to. Catching
      // that silently would produce "success" responses pointing at a PNG
      // captured by the wrong viewer. Refuse when the ambiguity is detectable
      // and tell the caller to pass filePath.
      if (!explicitFilePath) {
        const hbs = readAllHeartbeats();
        // Count live windows whose workspace roots actually contain `source`.
        const resolvedSource = resolve(source).toLowerCase();
        const ownedBy = hbs.filter((hb) =>
          hb.workspaceRoots.some((r) => {
            const rAbs = resolve(r).toLowerCase();
            return resolvedSource === rAbs || resolvedSource.startsWith(rAbs + sep.toLowerCase());
          }),
        );
        // Multi-window setup AND no window owns this file → the last-executed
        // shape lives in a workspace that no current window can render.
        if (hbs.length > 1 && ownedBy.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No default shape for this workspace — last-executed shape (${source}) lives in a workspace no live ShapeItUp window owns. Pass an explicit \`filePath\` or open the correct workspace.\n\nLive windows: ${hbs.map((h) => h.workspaceRoots.join(",")).join(" | ")}`,
            }],
            isError: true,
          };
        }
      }

      // --- Multi-angle collage branch -----------------------------------------
      // When the caller supplies an array of angles (or `grid: true`) we
      // capture each angle via the existing single-angle IPC, then composite
      // the intermediate PNGs into one labelled collage through resvg (same
      // path the headless fallback uses). Intermediate PNGs are deleted after
      // compositing so callers are left with a single file.
      //
      // Deliberately incompatible with `finder` — a finder collage would need
      // N wrapper files and its own stamping logic, and nobody's asked. Fail
      // loud if both are supplied.
      const gridDefault: Array<"isometric" | "front" | "right" | "top"> = [
        "isometric",
        "front",
        "right",
        "top",
      ];
      let angleList: string[] | undefined;
      if (Array.isArray(cameraAngle)) {
        angleList = cameraAngle;
      } else if (grid === true && cameraAngle === undefined) {
        angleList = gridDefault.slice();
      }
      if (angleList && angleList.length > 1) {
        if (finder !== undefined && finder.trim().length > 0) {
          return {
            content: [{
              type: "text" as const,
              text: "render_preview: multi-angle (array cameraAngle or grid:true) is not compatible with `finder`. Pass a single cameraAngle when using finder, or drop finder to build a collage.",
            }],
            isError: true,
          };
        }

        const perW = width || 1280;
        const perH = height || 960;
        const previewsDir = join(dirname(source), "shapeitup-previews");
        const userBase = basename(source).replace(/\.shape\.ts$/, "");
        const capturedPaths: string[] = [];
        const effectiveTimeout = timeoutMs ?? 60_000;

        try {
          for (const angle of angleList) {
            const outPath = join(previewsDir, `shapeitup-preview-${userBase}-collage-${angle}.png`);
            const cmdId = sendExtensionCommand("render-preview", {
              filePath: source,
              outputPath: outPath,
              targetWorkspaceRoot: computeTargetWorkspaceRoot(source),
              renderMode: renderMode || "ai",
              showDimensions: showDimensions !== false,
              showAxes: showAxes !== false,
              cameraAngle: angle,
              width: perW,
              height: perH,
              focusPart,
              hideParts,
              meshQuality: effectiveMeshQuality,
            });
            if (!cmdId) {
              return { content: [{ type: "text" as const, text: "Failed to send command to extension" }], isError: true };
            }
            const result = await waitForResult(cmdId, effectiveTimeout);
            if (!result) {
              return {
                content: [{ type: "text" as const, text: `render_preview (multi-angle): timed out on angle '${angle}' after ${effectiveTimeout}ms.` }],
                isError: true,
              };
            }
            if (result.error) {
              return {
                content: [{ type: "text" as const, text: `Screenshot failed for angle '${angle}': ${result.error}` }],
                isError: true,
              };
            }
            const capturedPath = result.screenshotPath;
            if (!capturedPath || typeof capturedPath !== "string" || !existsSync(capturedPath)) {
              return {
                content: [{ type: "text" as const, text: `render_preview (multi-angle): extension did not write a PNG for angle '${angle}' (expected at ${outPath}).` }],
                isError: true,
              };
            }
            capturedPaths.push(capturedPath);
          }

          // Layout: 2 → 1×2 strip, 3 → 1×3 strip, 4 → 2×2 grid.
          const n = capturedPaths.length;
          let cols: number, rows: number;
          if (n === 2) { cols = 2; rows = 1; }
          else if (n === 3) { cols = 3; rows = 1; }
          else if (n === 4) { cols = 2; rows = 2; }
          else { cols = n; rows = 1; } // fallback for 1 (shouldn't happen — single-angle path owns n=1)

          const labelH = 28; // px of space below each tile for the angle label
          const totalW = perW * cols;
          const totalH = (perH + labelH) * rows;

          // Build an SVG that references each captured PNG as base64. Fonts
          // are suppressed in svg-to-png.ts (font: { loadSystemFonts: false }),
          // so we use SVG's default font which renders as the platform generic
          // sans. Good enough for a small label — these aren't for print.
          let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
          svg += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">\n`;
          svg += `<rect width="${totalW}" height="${totalH}" fill="white"/>\n`;
          for (let i = 0; i < n; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * perW;
            const y = row * (perH + labelH);
            const b64 = readFileSync(capturedPaths[i]).toString("base64");
            svg += `<image x="${x}" y="${y}" width="${perW}" height="${perH}" xlink:href="data:image/png;base64,${b64}"/>\n`;
            const label = angleList[i];
            const labelX = x + perW / 2;
            const labelY = y + perH + labelH * 0.7;
            svg += `<text x="${labelX}" y="${labelY}" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#222">${label}</text>\n`;
          }
          svg += `</svg>\n`;

          const collagePath = join(previewsDir, `shapeitup-preview-${userBase}-collage.png`);
          let collageBytes: Buffer;
          try {
            collageBytes = await svgToPng(svg, totalW);
          } catch (e: any) {
            return {
              content: [{ type: "text" as const, text: `Collage rasterization failed: ${e?.message ?? e}. Intermediate PNGs: ${capturedPaths.join(", ")}` }],
              isError: true,
            };
          }
          try { mkdirSync(previewsDir, { recursive: true }); } catch {}
          writeFileSync(collagePath, collageBytes);

          // Clean up intermediates — the caller wanted a collage, not N files.
          for (const p of capturedPaths) {
            try { unlinkSync(p); } catch { /* best effort */ }
          }

          // Intentionally skip status-file writes here. The single-angle
          // branch currently doesn't append screenshot metadata to
          // shapeitup-status.json (there is no shared helper in this file),
          // so the collage branch follows suit — staying consistent beats
          // introducing a one-off observability write.

          const textBlock = {
            type: "text" as const,
            text: `Collage saved to: ${collagePath}\nLayout: ${cols}x${rows} (${angleList.join(", ")})\nRender mode: ${renderMode || "ai"}, Per-tile: ${perW}x${perH}, Total: ${totalW}x${totalH}\nFile: ${source}\nUse the Read tool to view this image.`,
          };
          if (inline !== false) {
            if (collageBytes.length > 10 * 1024 * 1024) {
              return {
                content: [
                  textBlock,
                  { type: "text" as const, text: `\n(collage is ${(collageBytes.length / 1024 / 1024).toFixed(1)} MB, exceeding the 10 MB inline limit. Use the Read tool on the saved path.)` },
                ],
              };
            }
            return {
              content: [
                textBlock,
                { type: "image" as const, data: collageBytes.toString("base64"), mimeType: "image/png" },
              ],
            };
          }
          return { content: [textBlock] };
        } catch (e: any) {
          // Best-effort cleanup on unexpected failures so we don't leak
          // half-rendered per-angle PNGs into the user's workspace.
          for (const p of capturedPaths) {
            try { unlinkSync(p); } catch {}
          }
          return {
            content: [{ type: "text" as const, text: `render_preview (multi-angle): unexpected failure: ${e?.message ?? e}` }],
            isError: true,
          };
        }
      }

      // Past this point, cameraAngle is either undefined or a single string.
      // Narrow the variable so the rest of the handler (which was written
      // before the union type) doesn't choke on the array branch.
      const singleAngle: string | undefined = Array.isArray(cameraAngle) ? cameraAngle[0] : cameraAngle;

      // --- Optional finder branch ---------------------------------------------
      // When `finder` is set, we don't ship the user's file to the extension as
      // usual; we generate a wrapper .shape.ts next to it that applies
      // highlightFinder() to the chosen part and render THAT. The wrapper is
      // cleaned up in a finally so we never leave droppings if the render
      // crashes. `buildFinderWrapperScript` is the shared helper also used by
      // preview_finder — keeping the wrapper contract in one place.
      let wrapperPath: string | undefined;
      let finderAppliedLine = "";
      let finderPartWarning: string | undefined;
      let renderFileArg = source;
      if (finder !== undefined && finder.trim().length > 0) {
        // Run the script once to resolve the target part + validate the finder
        // expression. Matches preview_finder: lets us produce clean error
        // messages ("no part named X", "finder failed to evaluate") *before*
        // burning a full extension render.
        const { status: preStatus, parts } = await executeWithPersistedParams(
          source,
          undefined,
          forceBundleRebuild ? { forceBundleRebuild: true } : undefined,
        );
        if (!preStatus.success || !parts || parts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Cannot render finder preview — script failed to render.\n${formatStatusText(preStatus)}` }],
            isError: true,
          };
        }

        let resolvedIdx: number;
        if (partName !== undefined) {
          if (parts.length === 1) {
            // Spec: single-part script + partName/partIndex passed → warn and
            // proceed (finder applies to the sole part).
            finderPartWarning = `partName='${partName}' ignored: script returned a single part ('${parts[0].name}'). Finder applied to it.`;
            resolvedIdx = 0;
          } else {
            const byName = parts.findIndex((p) => p.name === partName);
            if (byName < 0) {
              return {
                content: [{ type: "text" as const, text: `No part named "${partName}" in ${basename(source)}. Available parts: ${parts.map((p) => p.name).join(", ") || "(none)"}` }],
                isError: true,
              };
            }
            resolvedIdx = byName;
          }
        } else if (partIndex !== undefined) {
          if (parts.length === 1 && partIndex !== 0) {
            finderPartWarning = `partIndex=${partIndex} ignored: script returned a single part ('${parts[0].name}'). Finder applied to it.`;
            resolvedIdx = 0;
          } else if (partIndex >= parts.length) {
            return {
              content: [{ type: "text" as const, text: `partIndex ${partIndex} out of range — script returned ${parts.length} part${parts.length === 1 ? "" : "s"} (${parts.map((p) => p.name).join(", ")}).` }],
              isError: true,
            };
          } else {
            resolvedIdx = partIndex;
          }
        } else {
          resolvedIdx = 0;
        }

        // Pre-evaluate the finder expression with EdgeFinder/FaceFinder in
        // scope. Catches typos + undefined-method errors up-front so the MCP
        // response carries a clear message instead of a generic "script
        // failed" from the worker. Same sandbox pattern as preview_finder.
        try {
          const core = await getCore();
          const replicad: any = core.replicad();
          const EdgeFinder = replicad.EdgeFinder;
          const FaceFinder = replicad.FaceFinder;
          const fn = new Function("EdgeFinder", "FaceFinder", "replicad", `return (${finder});`);
          const finderObj = fn(EdgeFinder, FaceFinder, replicad);
          if (!finderObj || typeof finderObj.find !== "function") {
            return {
              content: [{ type: "text" as const, text: `Finder expression did not produce an EdgeFinder/FaceFinder (missing .find method).\nExpression: ${finder}` }],
              isError: true,
            };
          }
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Finder expression failed to evaluate: ${e?.message ?? e}\nExpression: ${finder}` }],
            isError: true,
          };
        }

        // Emit the "(applied to part N: <name>)" line for multi-part assemblies
        // — matches the spec's guidance for the default-partIndex case.
        if (parts.length > 1) {
          finderAppliedLine = `\nFinder applied to part ${resolvedIdx}: ${parts[resolvedIdx].name}`;
        }

        const stamp = Date.now().toString(36);
        const dir = dirname(source);
        wrapperPath = join(dir, `.shapeitup-finder-preview-${stamp}.shape.ts`);
        try {
          const wrapperSource = buildFinderWrapperScript(source, finder, { index: resolvedIdx });
          writeFileSync(wrapperPath, wrapperSource, "utf-8");
        } catch (e: any) {
          // Couldn't even stage the wrapper — no cleanup needed since
          // writeFileSync didn't succeed.
          wrapperPath = undefined;
          return {
            content: [{ type: "text" as const, text: `Failed to stage finder wrapper file: ${e?.message ?? e}` }],
            isError: true,
          };
        }
        renderFileArg = wrapperPath;
      }

      // Bug #1/#12 fix: MCP computes the exact PNG path here and hands it to
      // the extension, instead of letting captureScreenshot() synthesize one
      // from `this.lastExecutedFile` (which can be stale because executeScript
      // is fired without await). The PNG is pinned to the USER-visible
      // basename of `source`, placed in a shapeitup-previews/ sibling of the
      // shape file itself. Anchoring to dirname(source) — rather than the
      // heartbeat's workspace root — makes path resolution a pure function of
      // the input, immune to the active-window/heartbeat drift that caused
      // back-to-back calls to land in different directories.
      const previewsDir = join(dirname(source), "shapeitup-previews");
      const userBase = basename(source).replace(/\.shape\.ts$/, "");
      const angleForName = singleAngle || "isometric";
      const expectedOutputPath = join(previewsDir, `shapeitup-preview-${userBase}-${angleForName}.png`);

      try {
        const cmdId = sendExtensionCommand("render-preview", {
          filePath: renderFileArg,
          outputPath: expectedOutputPath,
          // Target the window whose workspace owns the SOURCE file (not the
          // possibly-synthetic wrapperPath). The wrapper is staged next to
          // source, so its owning workspace is identical; resolving off the
          // user-visible source path keeps the hint stable even when
          // preview_finder rewrites renderFileArg to a sibling wrapper.
          targetWorkspaceRoot: computeTargetWorkspaceRoot(source),
          renderMode: renderMode || "ai",
          showDimensions: showDimensions !== false,
          // Default flipped to ON — iso views on complex parts are otherwise
          // ambiguous. Only suppress when the caller explicitly passes false.
          showAxes: showAxes !== false,
          cameraAngle: singleAngle || "isometric",
          width: width || 1280,
          height: height || 960,
          focusPart,
          hideParts,
          // P3-10: forward the effective quality (auto-upgraded to "final" for
          // ai render mode when the caller didn't explicitly set meshQuality).
          meshQuality: effectiveMeshQuality,
        });
        if (!cmdId) {
          return { content: [{ type: "text" as const, text: "Failed to send command to extension" }], isError: true };
        }

        // The viewer does: execute script → render at requested size → capture.
        // 60s default covers cold OCCT init + render on complex geometry. Callers
        // can raise this via the tool's `timeoutMs` argument; waitForResult will
        // also extend once more (WAIT_GRACE_MS) if the extension is still alive
        // at the deadline, so truly-slow-but-responsive renders don't spuriously
        // fail.
        const effectiveTimeout = timeoutMs ?? 60_000;
        const result = await waitForResult(cmdId, effectiveTimeout);
        if (!result) {
          // Distinguish the two failure modes. `lastWaitTimeoutReason` is set by
          // waitForResult on the failing path.
          const totalWaitMs = effectiveTimeout + (lastWaitTimeoutReason === "slow" ? WAIT_GRACE_MS : 0);
          const msg = lastWaitTimeoutReason === "slow"
            ? `render_preview timed out after ${totalWaitMs}ms. The extension is still responsive but the render is taking longer than ${totalWaitMs}ms — consider passing a larger \`timeoutMs\`.`
            : `render_preview timed out after ${effectiveTimeout}ms. The extension appears to have crashed or was closed.`;
          return {
            content: [{ type: "text" as const, text: msg }],
            isError: true,
          };
        }
        if (result.error) {
          // P1 fix: surface stack + operation from the webview worker when
          // present, and add a CommonJS-restriction hint if the error mentions
          // Node-only globals. Also check for a fresher viewer-error sidecar
          // in case the command-file round trip dropped fields the webview
          // wrote synchronously.
          const sidecar = readViewerErrorIfNewer(GLOBAL_STORAGE);
          const msg = formatWorkerErrorMessage(
            result.error,
            result.errorStack ?? sidecar?.stack,
            result.errorOperation ?? sidecar?.operation,
          );
          return {
            content: [{ type: "text" as const, text: msg }],
            isError: true,
          };
        }

        // Bug #1/#12 verification: the extension must report where it actually
        // wrote the PNG, and that path must exist on disk. Previously the
        // response echoed a synthesized path that could point at a stale
        // cross-workspace file — now we require a real, existing path.
        if (!result.screenshotPath || typeof result.screenshotPath !== "string") {
          return {
            content: [{ type: "text" as const, text: `render_preview: extension did not return a screenshotPath. Expected PNG at ${expectedOutputPath}.` }],
            isError: true,
          };
        }
        if (!existsSync(result.screenshotPath)) {
          return {
            content: [{
              type: "text" as const,
              text: `render_preview: extension reported screenshotPath=${result.screenshotPath}, but that file does not exist. Expected path was ${expectedOutputPath}. The extension may be running an older bundle that ignores the MCP-supplied outputPath — reload VSCode and retry.`,
            }],
            isError: true,
          };
        }

        // Pull the latest render status so the response includes geometric props
        // AND the authoritative partNames list from the just-completed render.
        // Fix B (Bug #5): route the "Parts: …" line through computePartsLine
        // so the "(focused)" claim only prints when the engine's rendered
        // partNames actually contain the requested focus — otherwise the
        // viewer's "focusPart ignored" warning would contradict it.
        let statusText = "";
        let renderedPartNames: string[] = [];
        try {
          const status: EngineStatus = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.success) {
            statusText = `\nStats: ${status.stats}${formatProperties(status.properties, verbosity ?? "summary")}`;
          }
          if (Array.isArray(status.partNames)) renderedPartNames = status.partNames;
        } catch {}

        const partsLine = computePartsLine(
          focusPart,
          hideParts,
          renderedPartNames,
          "focused — other parts hidden in screenshot",
        );
        const partWarnLine = Array.isArray(result.partWarnings) && result.partWarnings.length > 0
          ? `\nPart warnings: ${result.partWarnings.join("; ")}`
          : "";
        const finderWarnLine = finderPartWarning ? `\nWarning: ${finderPartWarning}` : "";

        // For finder-wrapper renders, the extension names the PNG after the
        // wrapper (leading-dot ugly name). Rename it in place so the returned
        // path uses the user's shape basename — the screenshot still lives in
        // `{workspace}/shapeitup-previews/`, just with a human-readable name.
        // Best-effort: if rename fails, fall back to the raw extension path.
        let screenshotPath: string = result.screenshotPath;
        if (wrapperPath && screenshotPath && existsSync(screenshotPath)) {
          try {
            const userBase = basename(source).replace(/\.shape\.ts$/, "");
            const angle = singleAngle || "isometric";
            const renamedPath = join(dirname(screenshotPath), `shapeitup-preview-${userBase}-finder-${angle}.png`);
            if (renamedPath !== screenshotPath) {
              renameSync(screenshotPath, renamedPath);
              screenshotPath = renamedPath;
            }
          } catch {
            // keep raw screenshotPath
          }
        }

        // Fix #6: append screenshot metadata to shapeitup-status.json. The
        // VSCode extension deliberately does NOT write the status file on
        // render (it would clobber the engine's authoritative record), so
        // without this hop, `get_render_status` can never surface the fact
        // that a PNG was just produced. Additive only — other fields (stats,
        // warnings, geometryValid, etc.) are untouched, and subsequent
        // failed renders preserve this field (see engine.ts:writeStatusFile).
        try {
          appendScreenshotMetadata(
            {
              timestamp: Date.now(),
              path: screenshotPath,
              renderMode: renderMode || "ai",
              cameraAngle: singleAngle || "isometric",
              fileName: basename(source),
              sourceFile: source,
            },
            GLOBAL_STORAGE,
          );
        } catch {
          // Best effort — never block the response on observability.
        }

        const finderLine = finder !== undefined && finder.trim().length > 0
          ? `\nFinder: ${finder}${finderAppliedLine}${finderWarnLine}`
          : "";

        const textBlock = {
          type: "text" as const,
          text: `Screenshot saved to: ${screenshotPath}\nRender mode: ${renderMode || "ai"}, Camera: ${singleAngle || "isometric"}, Axes: ${showAxes !== false ? "ON" : "OFF"}, Size: ${width || 1280}x${height || 960}\nFile: ${source}${partsLine}${partWarnLine}${finderLine}${statusText}\nUse the Read tool to view this image. Or call the \`get_preview\` MCP tool to receive the PNG data inline without needing filesystem access.`,
        };

        // Bug #8: when inline is requested, read the PNG off disk and append
        // it as an image content block so the caller gets bytes + path in a
        // single round trip. Mirrors get_preview's 10 MB size guard to avoid
        // blowing past MCP response limits.
        // Default to inlining the PNG so agents see the image without an
        // extra get_preview round trip. Pass `inline: false` to opt out.
        if (inline !== false) {
          try {
            const st = statSync(screenshotPath);
            if (st.size > 10 * 1024 * 1024) {
              return {
                content: [
                  textBlock,
                  {
                    type: "text" as const,
                    text: `\n(inline=true requested but PNG is ${(st.size / 1024 / 1024).toFixed(1)} MB, exceeding the 10 MB inline limit. Reduce width/height or use the Read tool on the saved path.)`,
                  },
                ],
              };
            }
            const data = readFileSync(screenshotPath).toString("base64");
            return {
              content: [
                textBlock,
                { type: "image" as const, data, mimeType: "image/png" },
              ],
            };
          } catch (e: any) {
            return {
              content: [
                textBlock,
                {
                  type: "text" as const,
                  text: `\n(inline=true requested but failed to read PNG at ${screenshotPath}: ${e?.message ?? e}. Use the Read tool on the saved path instead.)`,
                },
              ],
            };
          }
        }

        return {
          content: [textBlock],
        };
      } finally {
        if (wrapperPath) {
          try { unlinkSync(wrapperPath); } catch {}
        }
      }
    })
  );

  server.tool(
    "get_preview",
    "Return the latest (or a specified) ShapeItUp preview PNG as inline MCP image content — base64 bytes delivered directly in the tool response, no filesystem Read required. Use this when your sandbox ignores `shapeitup-previews/` (gitignored) or restricts filesystem reads. Does NOT trigger a render — call `render_preview` first if no preview exists yet.",
    {
      filePath: z.string().optional().describe("Optional absolute path to a PNG. Defaults to the most recent ShapeItUp preview."),
      cameraAngle: z
        .enum(["isometric", "top", "bottom", "front", "right", "back", "left"])
        .optional()
        .describe("Used only when filePath is omitted, to pick `shapeitup-preview-<shape>-<angle>.png` instead of the generic latest preview."),
    },
    safeHandler("get_preview", async ({ filePath, cameraAngle }) => {
      // 1) Resolve target PNG. Precedence: explicit filePath → per-shape+angle
      // file in the shape's own shapeitup-previews/ → workspace "latest".
      //
      // The former GLOBAL_STORAGE fallback was removed — it routinely returned
      // stale PNGs from earlier sessions (persisted across workspace switches)
      // and silently broke the "render_preview → get_preview" loop. If no
      // workspace-local PNG exists, fail cleanly so the caller knows to run
      // render_preview first.
      let target: string | undefined;
      if (filePath) {
        target = resolveShapePath(filePath);
      } else {
        let shapeName: string | undefined;
        let shapeDir: string | undefined;
        try {
          const status = JSON.parse(readFileSync(join(GLOBAL_STORAGE, "shapeitup-status.json"), "utf-8"));
          if (status.fileName) {
            shapeName = basename(status.fileName).replace(/\.shape\.ts$/, "");
            shapeDir = dirname(status.fileName);
          }
        } catch {}
        const candidates: string[] = [];
        // Prefer the shape's own sibling previews dir (matches render_preview's
        // canonical output location). Fall back to the heartbeat workspace
        // only so existing callers that never called render_preview still see
        // something — but never globalStorage.
        if (shapeDir) {
          const localPreviewsDir = join(shapeDir, "shapeitup-previews");
          if (shapeName && cameraAngle) candidates.push(join(localPreviewsDir, `shapeitup-preview-${shapeName}-${cameraAngle}.png`));
          candidates.push(join(localPreviewsDir, "shapeitup-preview.png"));
        }
        const wsRoot = getDefaultDirectory();
        const wsPreviewsDir = join(wsRoot, "shapeitup-previews");
        if (shapeName && cameraAngle) candidates.push(join(wsPreviewsDir, `shapeitup-preview-${shapeName}-${cameraAngle}.png`));
        candidates.push(join(wsPreviewsDir, "shapeitup-preview.png"));
        target = candidates.find((p) => existsSync(p));
      }
      if (!target || !existsSync(target)) {
        return {
          content: [{ type: "text" as const, text: `No preview PNG found${target ? ` at ${target}` : ""}. Call render_preview first to generate one.` }],
          isError: true,
        };
      }
      try {
        const st = statSync(target);
        if (st.size > 10 * 1024 * 1024) {
          return {
            content: [{ type: "text" as const, text: `Preview PNG is ${(st.size / 1024 / 1024).toFixed(1)} MB (>10 MB limit for inline delivery). Call render_preview again with a smaller width/height.` }],
            isError: true,
          };
        }
        const buf = readFileSync(target);
        const data = buf.toString("base64");
        return {
          content: [
            { type: "image" as const, data, mimeType: "image/png" },
            { type: "text" as const, text: `Loaded: ${target}\nSize: ${(st.size / 1024).toFixed(1)} KB\nModified: ${st.mtime.toISOString()}` },
          ],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to read preview PNG at ${target}: ${e?.message ?? e}. Call render_preview to regenerate.` }],
          isError: true,
        };
      }
    })
  );

  server.tool(
    "set_render_mode",
    "Switch the interactive VSCode viewer between dark and AI mode. Requires VSCode extension — this is a UI-only setting.",
    {
      mode: z.enum(["ai", "dark"]).describe("'ai' for high-contrast light mode, 'dark' for normal dark mode"),
    },
    safeHandler("set_render_mode", async ({ mode }) => {
      if (!isExtensionAlive()) return extensionOfflineError("set_render_mode");
      const ok = !!sendExtensionCommand("set-render-mode", { mode });
      return {
        content: [{ type: "text" as const, text: ok ? `Render mode set to: ${mode}` : "Failed to send command" }],
        isError: !ok,
      };
    })
  );

  server.tool(
    "toggle_dimensions",
    "Show or hide dimension measurements on the VSCode viewer. Requires VSCode extension — UI-only setting. Omit `show` to toggle the current state.",
    {
      show: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .optional()
        .describe("true to show dimensions, false to hide. Omit to toggle the current state. Also accepts 'true'/'false' strings for clients that stringify booleans."),
    },
    safeHandler("toggle_dimensions", async ({ show }) => {
      if (!isExtensionAlive()) return extensionOfflineError("toggle_dimensions");
      const normalized: boolean | undefined =
        typeof show === "string" ? show === "true" : show;
      const ok = !!sendExtensionCommand("toggle-dimensions", { show: normalized });
      const stateLabel = normalized === undefined ? "toggled" : normalized ? "visible" : "hidden";
      return {
        content: [{ type: "text" as const, text: ok ? `Dimensions: ${stateLabel}` : "Failed to send command" }],
        isError: !ok,
      };
    })
  );

  server.tool(
    "get_render_status",
    "Get the result of the last shape render — whether it succeeded or failed, with stats, geometric properties (volume, area, center of mass, mass when material is exported), and bounding box. Reads the shared status file, which both MCP-driven and VSCode-driven renders write to. Includes currentParams — the resolved values of every exported param, so you don't need to re-read the file to inspect parameter state. For multi-part assemblies, returns per-part stats (name, volume, surface area, center of mass, bounding box, mass) — no separate list_parts tool needed.",
    {},
    safeHandler("get_render_status", async () => {
      const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
      // P11 fix: show the viewer connectivity block even when no render has
      // happened yet — agents that call get_render_status first need a way to
      // tell whether the extension is available before attempting renders.
      const viewerBlock = formatViewerBlock();
      if (!existsSync(statusFile)) {
        return {
          content: [{ type: "text" as const, text: `No render status available. Call create_shape, open_shape, or modify_shape first.${viewerBlock}` }],
        };
      }
      try {
        const status: EngineStatus = JSON.parse(readFileSync(statusFile, "utf-8"));
        return {
          content: [{ type: "text" as const, text: `${formatStatusText(status)}${viewerBlock}` }],
          // Render failures are an expected state, not tool errors.
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `Could not read render status.${viewerBlock}` }],
          isError: true,
        };
      }
    })
  );

  server.tool(
    "preview_finder",
    "Preview which edges/faces a Replicad EdgeFinder or FaceFinder matches on a shape — WITHOUT editing the user's script. Runs the given .shape.ts file (or an inline `code` snippet), applies the finder to the resulting shape, and reports how many entities matched plus their locations. The `finder` argument is a STRING of TS source code (not a Finder object) — `EdgeFinder` and `FaceFinder` are already in scope inside that string. Example: `finder: 'new EdgeFinder().inDirection(\"Z\")'` or `finder: 'new FaceFinder().inPlane(\"XY\", 10)'`. Supports the full finder DSL: `.and`, `.or`, `.not`, `.inDirection`, `.inPlane`, `.ofLength`, `.containsPoint`, etc. If the VSCode extension is running, also renders the highlighted preview in the viewer (pink spheres at each match); otherwise just returns the text report. Pass either `filePath` (existing shape) or `code` (inline snippet) — they are mutually exclusive. Debugging a script that crashes BEFORE the finder target exists: pass a modified snippet via `code` with the failing op commented out or stubbed — the finder then runs against the shape at whatever earlier point you choose.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file whose shape the finder should be applied to. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first existing match wins), else anchor to process.cwd(). Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — must include an `export default` main() function returning a Shape3D or array of parts. Written to a throwaway temp file, executed, and deleted afterwards. Use `workingDir` to make local `./` imports resolve. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in when `code` is provided. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work)."),
      finder: z.string().describe("TS source-code STRING (not a Finder object) that evaluates to an EdgeFinder or FaceFinder. Example: `'new EdgeFinder().inDirection(\"Z\").ofLength(l => l > 10)'`. The EdgeFinder / FaceFinder constructors are already in scope inside the string — do not import them."),
      partIndex: z.number().int().nonnegative().optional().describe("If the script returns a multi-part assembly, which part's shape to apply the finder to (default: 0). Ignored when `partName` is also provided."),
      partName: z.string().optional().describe("For multi-part assemblies: apply the finder to the part whose name matches exactly (e.g., 'bolt'). Takes precedence over `partIndex` when both are provided."),
    },
    safeHandler("preview_finder", async ({ filePath, code, workingDir, finder, partIndex, partName }) => {
      // Input validation: filePath and code are mutually exclusive, one required.
      if (filePath !== undefined && code !== undefined) {
        return {
          content: [{ type: "text" as const, text: "preview_finder: pass either `filePath` OR `code`, not both." }],
          isError: true,
        };
      }
      if (filePath === undefined && code === undefined) {
        return {
          content: [{ type: "text" as const, text: "preview_finder: provide either `filePath` (existing shape) or `code` (inline snippet)." }],
          isError: true,
        };
      }

      return withShapeFile({ filePath, code, workingDir }, async (absPath) => {
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      // Bug #10 / Issue #2: workspace-ownership check FIRST — before running the
      // engine or building any text report. If this check fires on call #2
      // after call #1 succeeded (because the heartbeat flipped to a different
      // window in between), we want both calls to refuse identically instead
      // of returning a match count + a stale PNG reference. Skip for inline
      // `code` snippets since they live in the isolated globalStorage dir.
      if (filePath !== undefined) {
        const wsErr = assertWorkspaceOwned(absPath);
        if (wsErr) return wsErr;
      }

      // Step 1: execute the user's script to get the live OCCT parts. Force-
      // bypass the mesh cache: we hand `target.shape` to a finder.find() call
      // below, which needs a live OCCT shape (cached entries scrub `.shape`).
      const { status, parts } = await executeWithPersistedParams(absPath, undefined, { force: true });
      if (!status.success || !parts || parts.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Cannot preview finder — script failed to render.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      // Resolve the target part: partName (if provided) wins over partIndex.
      let idx: number;
      if (partName !== undefined) {
        idx = parts.findIndex((p) => p.name === partName);
        if (idx < 0) {
          return {
            content: [{ type: "text" as const, text: `No part named "${partName}" in ${basename(absPath)}. Available parts: ${parts.map((p) => p.name).join(", ") || "(none)"}` }],
            isError: true,
          };
        }
      } else {
        idx = partIndex ?? 0;
      }
      if (idx >= parts.length) {
        return {
          content: [{ type: "text" as const, text: `partIndex ${idx} out of range — script returned ${parts.length} part${parts.length === 1 ? "" : "s"} (${parts.map((p) => p.name).join(", ")}).` }],
          isError: true,
        };
      }
      const target = parts[idx];
      const shape = target.shape;

      // Step 2: evaluate the finder expression with EdgeFinder/FaceFinder in scope.
      const core = await getCore();
      const replicad: any = core.replicad();
      const EdgeFinder = replicad.EdgeFinder;
      const FaceFinder = replicad.FaceFinder;
      if (!EdgeFinder || !FaceFinder) {
        return {
          content: [{ type: "text" as const, text: "Internal error: replicad EdgeFinder/FaceFinder exports not available." }],
          isError: true,
        };
      }

      let finderObj: any;
      try {
        // Construct a sandboxed expression. The finder string is user-supplied TS
        // but we're already executing user-supplied TS via create_shape/etc., so
        // this is not a new trust boundary.
        const fn = new Function("EdgeFinder", "FaceFinder", "replicad", `return (${finder});`);
        finderObj = fn(EdgeFinder, FaceFinder, replicad);
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to evaluate finder expression: ${e?.message ?? e}\nExpression: ${finder}` }],
          isError: true,
        };
      }

      if (!finderObj || typeof finderObj.find !== "function") {
        return {
          content: [{ type: "text" as const, text: `Finder expression did not produce an EdgeFinder/FaceFinder (missing .find method).\nExpression: ${finder}` }],
          isError: true,
        };
      }

      const isFace = finderObj instanceof FaceFinder;
      const entityKind = isFace ? "face" : "edge";

      let matches: any[];
      try {
        matches = finderObj.find(shape) || [];
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Finder .find() threw: ${e?.message ?? e}\nExpression: ${finder}` }],
          isError: true,
        };
      }

      // Step 3: build the text description — count + per-match location hints.
      const header = `Finder matched ${matches.length} ${entityKind}${matches.length === 1 ? "" : "s"} on part '${target.name}' of ${basename(absPath)}.`;
      const locationLines: string[] = [];
      const maxListed = 10;
      const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
      for (let i = 0; i < Math.min(matches.length, maxListed); i++) {
        const m = matches[i];
        let pt: any;
        try {
          if (typeof m.pointAt === "function") pt = m.pointAt(0.5);
          else if (m.center) pt = m.center;
        } catch {}
        const px = pt?.x ?? (Array.isArray(pt) ? pt[0] : undefined);
        const py = pt?.y ?? (Array.isArray(pt) ? pt[1] : undefined);
        const pz = pt?.z ?? (Array.isArray(pt) ? pt[2] : undefined);
        const loc = (typeof px === "number" && typeof py === "number" && typeof pz === "number")
          ? `at (${fmt(px)}, ${fmt(py)}, ${fmt(pz)})`
          : "(location unavailable)";
        let extra = "";
        try {
          if (!isFace && typeof m.length === "number") extra = `, length=${fmt(m.length)}mm`;
        } catch {}
        // P-5: edge-vs-seam classification. Replicad's Edge class does
        // not expose face adjacency (no `.adjacentFaces()` / `.faces`
        // accessor on `_1DShape<TopoDS_Edge>`), so we can't reliably
        // tell an outer-boundary edge from a seam left behind by a fuse.
        // Field is intentionally optional and stays unset for edges —
        // emitting `matchType=unknown` just adds noise to the report
        // without helping the agent. Keep the type union ready so the
        // day Replicad gains face-adjacency we can flip a literal here
        // to "outer"/"seam" without re-plumbing the emit path.
        let matchType: "outer" | "seam" | undefined;
        // intentionally not assigned for edges — Replicad doesn't expose face-adjacency yet.
        if (matchType !== undefined) {
          extra += `, matchType=${matchType}`;
        }
        // Face matches carry richer info — surface area (via the top-level
        // `measureArea` helper) and the outward normal at the face center
        // (via `.normalAt()` — optional argument, defaults to the face
        // centroid). Both are wrapped in try/catch: measureArea throws on
        // non-planar surfaces in some builds, and normalAt can return a
        // Vector that throws on `.x` access after the underlying TopoDS was
        // deleted. The per-field guards keep a single failure from nuking
        // the entire report — we simply omit the field.
        if (isFace) {
          try {
            if (typeof replicad.measureArea === "function") {
              const a = replicad.measureArea(m);
              if (typeof a === "number" && isFinite(a)) {
                extra += `, area=${fmt(a)}mm²`;
              }
            }
          } catch {}
          try {
            if (typeof m.normalAt === "function") {
              const n = m.normalAt();
              if (n && typeof n.x === "number" && typeof n.y === "number" && typeof n.z === "number") {
                extra += `, normal=(${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)})`;
              }
              try { n?.delete?.(); } catch {}
            }
          } catch {}
        }
        locationLines.push(`  [${i}] ${entityKind} ${loc}${extra}`);
        try { m.delete?.(); } catch {}
      }
      if (matches.length > maxListed) {
        locationLines.push(`  ... ${matches.length - maxListed} more`);
      }

      if (matches.length === 0) {
        const zeroHint = `\nThe finder matched nothing — double-check the filters (e.g. plane offset, direction axis, length constraint). ${isFace ? "FaceFinder" : "EdgeFinder"} DSL: .inDirection('X'|'Y'|'Z'), .inPlane('XY'|'XZ'|'YZ', offset?), .ofLength(n|fn), .containsPoint([x,y,z]), .atAngleWith(dir, deg), .parallelTo(plane), .not(f), .either([f1, f2]).`;

        // Edge-consuming-op hint: when the user's script contains
        // `.fillet()/.chamfer()/.shell()`, the targeted edge may have been
        // destroyed by the op itself. Surface this specifically since it's a
        // common gotcha — the finder's filters are fine but the edge it's
        // looking for no longer exists post-op. Read source from disk when we
        // have a filePath; otherwise reuse the inline `code` argument.
        let hintBlock = "";
        try {
          const scannedSource = code ?? readFileSync(absPath, "utf-8");
          if (/\.(fillet|chamfer|shell)\s*\(/.test(scannedSource)) {
            hintBlock =
              "\nFinder matched 0 edges. The script contains .fillet()/.chamfer()/.shell() operations — these consume edges. If your finder targets edges that exist BEFORE that operation, the target may no longer exist after the op completes. Try passing inline `code` with the op commented out to preview the pre-op geometry.";
          }
        } catch {
          // Can't read source — skip the hint rather than guess.
        }

        // No render-preview when there are no matches — the viewer would just
        // show the raw shape which is visually indistinguishable from "script
        // loaded fine".
        return {
          content: [{ type: "text" as const, text: header + zeroHint + hintBlock }],
        };
      }

      let text = `${header}\n${locationLines.join("\n")}`;

      // Step 4: optional highlighted preview in the VSCode viewer. Write a
      // synthetic wrapper .shape.ts next to the user's file (so local imports
      // resolve through esbuild's bundler), render-preview it, then clean up.
      // Note: the workspace-ownership check ran up-front (before we executed
      // the script), so if we got here the workspace is owned — both first
      // and second calls behave identically. Issue #2 fix.
      if (isExtensionAlive()) {
        const stamp = Date.now().toString(36);
        const dir = dirname(absPath);
        const previewPath = join(dir, `.shapeitup-finder-preview-${stamp}.shape.ts`);
        const wrapperSource = buildFinderWrapperScript(absPath, finder, { index: idx });
        // Pin the output PNG to the USER's shape basename, not the wrapper —
        // without an explicit outputPath the extension would synthesize a name
        // from `this.lastExecutedFile` (which is the wrapper), producing
        // `shapeitup-preview-.shapeitup-finder-preview-<stamp>-isometric.png`.
        const previewsDir = join(dir, "shapeitup-previews");
        const userBase = basename(absPath).replace(/\.shape\.ts$/, "");
        const finderOutputPath = join(previewsDir, `shapeitup-preview-${userBase}-finder-isometric.png`);
        try {
          writeFileSync(previewPath, wrapperSource, "utf-8");
          const cmdId = sendExtensionCommand("render-preview", {
            filePath: previewPath,
            outputPath: finderOutputPath,
            targetWorkspaceRoot: computeTargetWorkspaceRoot(previewPath),
            renderMode: "ai",
            showDimensions: false,
            cameraAngle: "isometric",
            width: 1280,
            height: 960,
          });
          if (cmdId) {
            const result = await waitForResult(cmdId, 30000);
            if (result?.screenshotPath) {
              text += `\n\nHighlighted preview: ${result.screenshotPath}\nUse the Read tool to view this image.`;
            } else if (result?.error) {
              text += `\n\n(Highlighted preview unavailable: ${result.error})`;
            }
          }
        } catch (e: any) {
          text += `\n\n(Highlighted preview skipped: ${e?.message ?? e})`;
        } finally {
          try { unlinkSync(previewPath); } catch {}
        }
      }

      return {
        content: [{ type: "text" as const, text }],
      };
      }); // close withShapeFile callback
    })
  );

  server.tool(
    "check_collisions",
    "Detects pairwise intersections between named parts in a multi-part assembly. AABB prefilter skips obviously-disjoint pairs; remaining pairs are tested with Replicad's 3D intersect (which can fail on complex curved solids — those pairs are reported as 'intersect failed' rather than silently ignored). Tolerance filters out numerical-noise contacts (default 0.001 mm³); very large assemblies (100+ parts) will be slow because work grows as N². Pass `acceptedPairs` to suppress EXPECTED intersections (needles resting in grooves, bolt shafts in through-holes) — accepted pairs are rolled into a summary count so unexpected bugs surface faster. Collisions with volume at or below `pressFitThreshold` are listed under 'Nominal contact' (press fits, touching interfaces) instead of the main 'Collisions' block. The main block is sorted by overlap volume descending so the biggest (most likely bug) is the first line. Pass either `filePath` (existing shape) or `code` (inline snippet) — they are mutually exclusive. Pass `params` to override numeric parameters for this single check (handy for sweeping a cam angle without editing persisted params). Pass `format: 'full'` for per-pair geometry; default summary keeps responses compact.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file to check for part collisions. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first existing match wins), else anchor to process.cwd(). Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — must include an `export default` main() function returning an array of parts. Written to a throwaway temp file, executed, and deleted afterwards. Use `workingDir` to make local `./` imports resolve. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in when `code` is provided. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work)."),
      params: z.record(z.string(), z.number()).optional().describe("Numeric param overrides applied to the shape's `export const params` for this single check. Same shape as tune_params accepts. Does NOT persist — merged with tune_params values for this execution only, so you can collision-check an articulation angle (e.g. `{ cam_angle_deg: 180 }`) without editing the shape."),
      tolerance: z.number().optional().describe("Minimum intersection volume in mm³ to count as a collision. Defaults to 0.001 — filters out numerical-noise overlaps on touching-but-not-overlapping parts. Negative values are clamped to 0."),
      acceptedPairs: z.array(z.tuple([z.string(), z.string()])).optional().describe("Pairs of part names whose intersection is EXPECTED and should not be flagged — e.g. [['needle','bed'], ['bolt','plate']]. Accepted pairs are rolled into a single-line summary count (with volume range) instead of listed individually. Order is symmetric: ['a','b'] also covers ['b','a']. When a name appears on multiple parts, every such pair is accepted."),
      pressFitThreshold: z.number().optional().describe("Volume threshold (mm³) at or below which a collision is classified as 'nominal contact' (press fit / touching interface) and listed in a compact section instead of the main Collisions block. Default 0.5 mm³. Set to 0 to disable the tag (every non-accepted collision is treated as real)."),
      format: z.enum(["summary", "full", "ids"]).optional().describe("Report verbosity. summary (default): count + worst pair detail + per-pair {a,b,volume}. full: per-pair with region+center geometry. ids: minimal [a,b,vol] tuples."),
    },
    safeHandler("check_collisions", async ({ filePath, code, workingDir, params, tolerance, acceptedPairs, pressFitThreshold, format }) => {
      // Input validation: filePath and code are mutually exclusive, one required.
      if (filePath !== undefined && code !== undefined) {
        return {
          content: [{ type: "text" as const, text: "check_collisions: pass either `filePath` OR `code`, not both." }],
          isError: true,
        };
      }
      if (filePath === undefined && code === undefined) {
        return {
          content: [{ type: "text" as const, text: "check_collisions: provide either `filePath` (existing shape) or `code` (inline snippet)." }],
          isError: true,
        };
      }

      return withShapeFile({ filePath, code, workingDir }, async (absPath) => {
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      // Step 1: execute the script to get live OCCT parts. Failure here is
      // surfaced via formatStatusText so the agent sees the engine's own
      // error hint (fillet too large, wire not closed, etc.). Force-bypass
      // the mesh cache: the per-pair intersect() below dereferences
      // `parts[i].shape` which the cache layer scrubs. When the caller passes
      // `params`, they're merged with persisted values for this one execution
      // so e.g. `{ cam_angle_deg: 180 }` can sweep an articulation without
      // touching tune_params.
      const { status, parts } = await executeWithPersistedParams(absPath, params, { force: true });
      if (!status.success || !parts) {
        return {
          content: [{ type: "text" as const, text: `Cannot check collisions — script failed to render.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      if (parts.length < 2) {
        return {
          content: [{ type: "text" as const, text: "Collision check skipped — file contains a single part. Collisions only apply to multi-part assemblies." }],
        };
      }

      const tol = Math.max(0, typeof tolerance === "number" ? tolerance : 0.001);
      // Press-fit threshold: below this volume a collision is expected to be a
      // contact fit (bearing in seat, pin in hole) rather than a real overlap
      // bug. Clamp to tol so it never falls below the "real collision" floor.
      const pressFit = Math.max(
        tol,
        typeof pressFitThreshold === "number" ? pressFitThreshold : 0.5,
      );
      // Build the accepted-pairs lookup with symmetric keys. The user passes
      // raw part names (the same names their `part({ name: "..." })` calls
      // used); we match against `parts[i].name`, not the indexed label that
      // duplicate-name disambiguation would produce — otherwise users of
      // `patterns.spread` (where 20 needles all carry name="needle") would
      // have to list 20 tuples instead of one.
      const pairKey = (a: string, b: string): string =>
        a < b ? `${a}|${b}` : `${b}|${a}`;
      const acceptedSet = new Set<string>();
      for (const pair of acceptedPairs ?? []) {
        if (Array.isArray(pair) && pair.length === 2) {
          acceptedSet.add(pairKey(pair[0], pair[1]));
        }
      }

      // Step 2: compute per-part AABBs from the tessellated vertex arrays.
      // Same math as engine.boundingBoxFromVertices but we keep the raw
      // min/max bounds instead of collapsing to width/height/depth — we need
      // them for overlap testing. A tiny epsilon on the overlap check keeps
      // perfectly-adjacent parts (shared face) out of the "maybe collide"
      // bucket cheaply. Parts with zero vertices get a null box and are
      // skipped with a warning.
      type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
      const boxes: Array<Box | null> = parts.map((p) => {
        const v = p.vertices;
        if (!v || v.length < 3) return null;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < v.length; i += 3) {
          if (v[i] < minX) minX = v[i];
          if (v[i] > maxX) maxX = v[i];
          if (v[i + 1] < minY) minY = v[i + 1];
          if (v[i + 1] > maxY) maxY = v[i + 1];
          if (v[i + 2] < minZ) minZ = v[i + 2];
          if (v[i + 2] > maxZ) maxZ = v[i + 2];
        }
        return { minX, minY, minZ, maxX, maxY, maxZ };
      });

      const AABB_EPS = 1e-6;
      const aabbsOverlap = (a: Box, b: Box): boolean =>
        a.maxX > b.minX + AABB_EPS && b.maxX > a.minX + AABB_EPS &&
        a.maxY > b.minY + AABB_EPS && b.maxY > a.minY + AABB_EPS &&
        a.maxZ > b.minZ + AABB_EPS && b.maxZ > a.minZ + AABB_EPS;

      // Duplicate-name detection — index prefix disambiguates in the report.
      const nameCounts = new Map<string, number>();
      for (const p of parts) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
      const labelFor = (i: number): string =>
        (nameCounts.get(parts[i].name) ?? 0) > 1 ? `part-${i}:${parts[i].name}` : parts[i].name;

      // Step 3: grab replicad for measureShapeVolumeProperties. Same pattern
      // as preview_finder.
      const core = await getCore();
      const replicad: any = core.replicad();
      const measureVol = replicad?.measureShapeVolumeProperties;

      const collisions: Array<{
        a: string;
        b: string;
        /** Raw part names (not labels) for acceptedPairs matching. */
        rawA: string;
        rawB: string;
        volume: number;
        region?: {
          min: [number, number, number];
          max: [number, number, number];
          depths: { x: number; y: number; z: number };
        };
        center?: [number, number, number];
        aabbVolA?: number;
        aabbVolB?: number;
      }> = [];

      const boxVolume = (b: Box): number =>
        Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY) * Math.max(0, b.maxZ - b.minZ);
      const failures: Array<{ a: string; b: string; error: string }> = [];
      const degenerateWarnings: string[] = [];
      let skippedByAABB = 0;
      let tested = 0;
      const totalPairs = (parts.length * (parts.length - 1)) / 2;

      for (let i = 0; i < parts.length; i++) {
        const boxI = boxes[i];
        if (!boxI) {
          // Record once per degenerate part, not once per pair — noise.
          if (!degenerateWarnings.some((w) => w.includes(`[${i}]`))) {
            degenerateWarnings.push(`  - ${labelFor(i)} [${i}] has no tessellated vertices — skipped from collision scan.`);
          }
          continue;
        }
        for (let j = i + 1; j < parts.length; j++) {
          const boxJ = boxes[j];
          if (!boxJ) continue; // degenerate; warning already recorded above

          if (!aabbsOverlap(boxI, boxJ)) {
            skippedByAABB++;
            continue;
          }

          tested++;

          // Step 4: attempt the 3D intersect. Per-pair try/catch — one failing
          // pair must not kill the scan. WASM handle hygiene: the overlap
          // solid (on success) goes through a finally that calls .delete()
          // with its own swallowing try/catch so cleanup can never throw.
          let overlapShape: any = null;
          try {
            overlapShape = parts[i].shape.intersect(parts[j].shape);
          } catch (e: any) {
            failures.push({ a: labelFor(i), b: labelFor(j), error: e?.message ?? String(e) });
            continue;
          }

          try {
            // Measure volume of the intersection solid. measureShapeVolumeProperties
            // can itself throw or return null for truly empty results — treat
            // a null/zero volume as "no collision" (intersect returned an
            // empty solid, the expected signal on non-overlapping inputs) but
            // a thrown error as a probe failure worth reporting.
            let volume = 0;
            let overlapCenter: [number, number, number] | undefined;
            let volProps: any = null;
            try {
              volProps = measureVol?.(overlapShape);
              if (volProps && typeof volProps.volume === "number") {
                volume = volProps.volume;
              }
              // Capture CoM before we delete volProps. The API returns a tuple
              // array (already plain numbers — no WASM handle attached) per
              // the core/index.ts reference around line 796, so we can keep
              // the reference after .delete().
              if (volProps && volProps.centerOfMass && Array.isArray(volProps.centerOfMass)) {
                const c = volProps.centerOfMass;
                if (c.length >= 3 && c.every((n: any) => typeof n === "number" && isFinite(n))) {
                  overlapCenter = [c[0], c[1], c[2]];
                }
              }
            } catch (e: any) {
              failures.push({ a: labelFor(i), b: labelFor(j), error: `volume measurement failed: ${e?.message ?? e}` });
              continue;
            } finally {
              try { volProps?.delete?.(); } catch {}
            }

            if (volume > tol) {
              // Compute the overlap region AABB by tessellating the
              // intersection solid. Cheap quality (final factor is fine since
              // the overlap is typically small) and wrapped so a tessellation
              // throw doesn't kill the whole collision — we just omit the
              // region field for that pair. We still emit the volume number
              // because that came from a separate OCCT call.
              let region: { min: [number, number, number]; max: [number, number, number]; depths: { x: number; y: number; z: number } } | undefined;
              try {
                const meshData: any = overlapShape.mesh?.({ tolerance: 0.1, angularTolerance: 0.3 });
                const verts: ArrayLike<number> | undefined = meshData?.vertices;
                if (verts && verts.length >= 3) {
                  let mnx = Infinity, mny = Infinity, mnz = Infinity;
                  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
                  for (let k = 0; k < verts.length; k += 3) {
                    const x = verts[k], y = verts[k + 1], z = verts[k + 2];
                    if (x < mnx) mnx = x; if (x > mxx) mxx = x;
                    if (y < mny) mny = y; if (y > mxy) mxy = y;
                    if (z < mnz) mnz = z; if (z > mxz) mxz = z;
                  }
                  if (isFinite(mnx)) {
                    region = {
                      min: [mnx, mny, mnz],
                      max: [mxx, mxy, mxz],
                      depths: { x: mxx - mnx, y: mxy - mny, z: mxz - mnz },
                    };
                  }
                }
              } catch {
                // Non-fatal — volume is still reported, region just omitted.
              }
              collisions.push({
                a: labelFor(i),
                b: labelFor(j),
                rawA: parts[i].name,
                rawB: parts[j].name,
                volume,
                ...(region ? { region } : {}),
                ...(overlapCenter ? { center: overlapCenter } : {}),
                aabbVolA: boxVolume(boxI),
                aabbVolB: boxVolume(boxJ),
              });
            }
          } finally {
            // CRITICAL: always delete the overlap solid, even on measurement
            // failure, to avoid leaking WASM handles.
            try { overlapShape?.delete?.(); } catch {}
          }
        }
      }

      // Step 5: triage collisions into three buckets BEFORE formatting, so the
      // accounting header can report "N real / M nominal / K accepted" instead
      // of a single flat count. Sorting each bucket by volume descending puts
      // the worst offender at the top of its block.
      const acceptedC = collisions.filter((c) =>
        acceptedSet.has(pairKey(c.rawA, c.rawB)),
      );
      const unacceptedC = collisions.filter(
        (c) => !acceptedSet.has(pairKey(c.rawA, c.rawB)),
      );
      const realC = unacceptedC
        .filter((c) => c.volume > pressFit)
        .sort((a, b) => b.volume - a.volume);
      const pressFitC = unacceptedC
        .filter((c) => c.volume <= pressFit)
        .sort((a, b) => b.volume - a.volume);
      acceptedC.sort((a, b) => b.volume - a.volume);

      // Step 6: format the summary.
      const pairWord = (n: number) => `${n} pair${n === 1 ? "" : "s"}`;

      // Full pair accounting — always show total/skipped/tested so callers
      // never see a bare "1 pair" and wonder where the other 5 went. Bug #3:
      // for a 4-part assembly where 5 of 6 pairs are AABB-prefiltered, the
      // previous "all 1 tested pair clear" phrasing made the tool look broken.
      const accounting: string[] = [
        `Checked ${parts.length} parts \u2192 ${pairWord(totalPairs)} total.`,
      ];
      // Reviewer feedback: "skipped by AABB prefilter" read like the tool had
      // ducked the work. Rephrase so the accounting makes it clear the prefilter
      // is a proof (disjoint AABBs → no intersection possible), not a shortcut.
      //   - skippedByAABB === totalPairs: every pair is AABB-disjoint, nothing
      //     was tested; collapse into one definitive "no overlap possible" line.
      //   - skippedByAABB > 0 && tested > 0: combined line naming the split so
      //     readers don't have to add the two bullets themselves.
      //   - skippedByAABB === 0: fall through to the original tested-line path,
      //     unchanged (we only touch the phrasing that sounded evasive).
      // "All clear" means no REAL collisions (accepted + press-fit don't count
      // against the user). Keeps the accounting headline trustworthy when the
      // user has declared expected overlaps.
      const noRealTrouble = realC.length === 0 && failures.length === 0;
      if (skippedByAABB > 0 && skippedByAABB === totalPairs) {
        accounting.push(`  - No overlap possible \u2014 all ${pairWord(totalPairs)} AABB-disjoint.`);
      } else if (skippedByAABB > 0 && tested > 0) {
        const allClear = noRealTrouble ? " \u2014 all tested pairs clear" : "";
        accounting.push(`  - ${pairWord(skippedByAABB)} AABB-disjoint (skipped); ${pairWord(tested)} tested${allClear}.`);
      } else if (skippedByAABB === 0 && tested > 0) {
        const testedSuffix = noRealTrouble ? " \u2014 all clear" : "";
        accounting.push(`  - ${pairWord(tested)} tested for 3D intersection${testedSuffix}.`);
      }

      const reportFormat: CollisionReportFormat = format ?? "summary";

      // Delegate pair rendering to the exported pure helper.
      let text = formatCollisionPairs(realC, pressFitC, acceptedC, pressFit, reportFormat, accounting.join("\n"));

      // For summary/full, append failures and warnings after the pairs block.
      if (reportFormat !== "ids") {
        const extra: string[] = [];

        if (failures.length > 0) {
          const lines = failures.map((f) => `  - ${f.a} \u2194 ${f.b}: ${f.error}`);
          extra.push(`\nIntersect failures (retry with mold-cut or report to developer):\n${lines.join("\n")}`);
        }

        if (degenerateWarnings.length > 0) {
          extra.push(`\nWarnings:\n${degenerateWarnings.join("\n")}`);
        }

        // All-clear footer when nothing collided, nothing failed, and at least
        // one pair was actually tested (otherwise the AABB prefilter skipped
        // everything and "no collisions detected" would be misleading).
        // Accepted and press-fit overlaps are NOT trouble — they get their own
        // sections above but don't invalidate the "no real collisions" state.
        if (
          realC.length === 0 &&
          failures.length === 0 &&
          skippedByAABB < totalPairs &&
          pressFitC.length === 0 &&
          acceptedC.length === 0
        ) {
          extra.push(`\nNo collisions detected.`);
        }

        if (extra.length > 0) text += extra.join("\n");
      }

      return {
        content: [{ type: "text" as const, text }],
      };
      }); // close withShapeFile callback
    })
  );

  server.tool(
    "validate_joints",
    "Best-effort validator for declared mate joints: executes the shape, looks for a `joints` map on each rendered part (the shape returned `{ shape, name, joints }` objects, or the stdlib `Part.joints` field survived to the render result), and measures each joint point's distance to the owning part's tessellated surface. Reports joints that float above the surface (> tolerance) or are buried inside the body. Returns a plain OK summary when no issues are found. NOTE: joint introspection depends on the executor passing `.joints` through — when it doesn't, the tool reports that cleanly rather than failing.",
    {
      path: z.string().describe("Path to the .shape.ts file to validate."),
      tolerance: z.number().optional().describe("Max acceptable joint-to-surface distance in mm. Default 0.1."),
    },
    safeHandler("validate_joints", async ({ path, tolerance }) => {
      const absPath = resolveShapePath(path);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      const tol = typeof tolerance === "number" && tolerance > 0 ? tolerance : 0.1;

      const { status, parts } = await executeWithPersistedParams(absPath);
      if (!status.success || !parts) {
        return {
          content: [{ type: "text" as const, text: `Cannot validate joints — script failed to render.\n${formatStatusText(status)}` }],
          isError: true,
        };
      }

      // TODO: this relies on the executor/engine preserving `.joints` on the
      // returned part objects. The current engine returns render-oriented
      // `{ name, shape, vertices, ... }` only — if user scripts return
      // `Part` instances (stdlib convention) and the executor passes them
      // through, `.joints` will be present here. When it isn't, report
      // cleanly rather than pretending validation ran.
      type JointInfo = { part: string; name: string; point: [number, number, number] };
      const joints: JointInfo[] = [];
      for (const p of parts) {
        const anyP = p as any;
        const jmap = anyP.joints;
        if (!jmap || typeof jmap !== "object") continue;
        for (const [jname, spec] of Object.entries(jmap)) {
          const s = spec as any;
          const pos = s?.position ?? s?.point ?? s?.origin;
          if (Array.isArray(pos) && pos.length >= 3 && pos.every((n: any) => typeof n === "number" && isFinite(n))) {
            joints.push({ part: p.name, name: jname, point: [pos[0], pos[1], pos[2]] });
          }
        }
      }

      if (joints.length === 0) {
        return {
          content: [{ type: "text" as const, text: `validate_joints: no introspectable joints found on any part. Either the assembly declares none, or the executor did not preserve .joints on the render result. Parts scanned: ${parts.map((p) => p.name).join(", ")}` }],
        };
      }

      // Compute per-part AABB + closest-vertex distance. Closest-vertex on a
      // tessellated mesh is a conservative UPPER bound on the true surface
      // distance (real OCCT distance would need BRepExtrema_DistShapeShape);
      // for the floating/buried detection we ALSO use the AABB
      // inside/outside test to distinguish the two cases. This is a heuristic
      // — a point inside the AABB but outside the solid reads as "buried"
      // here. Acceptable per the spec's "best-effort" allowance.
      type Box = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
      const boxByName = new Map<string, Box>();
      const vertsByName = new Map<string, ArrayLike<number>>();
      for (const p of parts) {
        const v = (p as any).vertices;
        if (!v || v.length < 3) continue;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < v.length; i += 3) {
          if (v[i] < minX) minX = v[i]; if (v[i] > maxX) maxX = v[i];
          if (v[i + 1] < minY) minY = v[i + 1]; if (v[i + 1] > maxY) maxY = v[i + 1];
          if (v[i + 2] < minZ) minZ = v[i + 2]; if (v[i + 2] > maxZ) maxZ = v[i + 2];
        }
        boxByName.set(p.name, { minX, minY, minZ, maxX, maxY, maxZ });
        vertsByName.set(p.name, v);
      }

      const warnings: string[] = [];
      for (const j of joints) {
        const verts = vertsByName.get(j.part);
        const box = boxByName.get(j.part);
        if (!verts || !box) {
          warnings.push(`joint "${j.name}" on "${j.part}": owning part has no tessellated geometry — cannot validate.`);
          continue;
        }
        // Min vertex-distance².
        let best = Infinity;
        for (let i = 0; i < verts.length; i += 3) {
          const dx = verts[i] - j.point[0];
          const dy = verts[i + 1] - j.point[1];
          const dz = verts[i + 2] - j.point[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < best) best = d2;
        }
        const dist = Math.sqrt(best);
        if (dist <= tol) continue;
        const inside =
          j.point[0] > box.minX && j.point[0] < box.maxX &&
          j.point[1] > box.minY && j.point[1] < box.maxY &&
          j.point[2] > box.minZ && j.point[2] < box.maxZ;
        const kind = inside ? "buried" : "floats";
        const prep = inside ? "inside body" : "off surface";
        warnings.push(`joint "${j.name}" on "${j.part}" ${kind} ${dist.toFixed(3)}mm ${prep}`);
      }

      const summary = `validate_joints: checked ${joints.length} joint${joints.length === 1 ? "" : "s"} across ${parts.length} part${parts.length === 1 ? "" : "s"} (tolerance=${tol}mm).`;
      if (warnings.length === 0) {
        return {
          content: [{ type: "text" as const, text: `${summary}\nOK — all joints are within tolerance of their owning part's surface.` }],
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `${summary}\nWarnings (${warnings.length}):\n${warnings.map((w) => `  - ${w}`).join("\n")}`,
        }],
      };
    })
  );

  server.tool(
    "verify_shape",
    "Single-call inspection bundle: executes the shape ONCE and runs any combination of geometry, collision, and joint checks against that single execution. Faster than calling describe_geometry → check_collisions → validate_joints separately (each of those re-executes the shape). Returns a structured JSON report with one section per requested check plus a top-level `ok` flag and `summary`. Pick `checks` to scope the work; per-check options are prefixed (geometryFormat, collisionTolerance, jointTolerance, etc.). Use the individual tools for one-off queries; use this when verifying an assembly comprehensively.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file. Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — written to a temp file, executed, then deleted. Use `workingDir` for relative-import resolution. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to host the inline snippet when `code` is provided. Defaults to a private globalStorage path."),
      params: z.record(z.string(), z.number()).optional().describe("Numeric param overrides applied to the shape's `export const params`. Same shape as tune_params accepts."),
      checks: z.array(z.enum(["geometry", "collisions", "joints"])).optional().describe("Which checks to run. Defaults to all three. Order doesn't matter; each runs against the same single execution."),
      // Geometry per-check options
      geometryFormat: z.enum(["summary", "full"]).optional().describe("Geometry report verbosity. summary (default): face/edge counts + bounding box. full: per-face / per-edge records (capped by geometryLimit)."),
      geometryFaces: z.enum(["all", "planar", "curved"]).optional().describe("Geometry face filter. Defaults to 'all'."),
      geometryEdges: z.enum(["all", "outer", "none"]).optional().describe("Geometry edge filter. Defaults to 'none' (faces-only is the common case)."),
      geometryLimit: z.number().int().positive().optional().describe("Hard cap on face/edge records in geometryFormat='full'. Default 50."),
      geometryPartName: z.string().optional().describe("Restrict the geometry check to a single named part. Undefined = every part."),
      // Collision per-check options
      collisionTolerance: z.number().optional().describe("Min intersection volume in mm³ to count as a collision. Default 0.001."),
      collisionAcceptedPairs: z.array(z.tuple([z.string(), z.string()])).optional().describe("Pairs of part names whose intersection is EXPECTED (e.g. needles in grooves). Symmetric. Accepted pairs are reported separately and do NOT flip ok=false."),
      collisionPressFitThreshold: z.number().optional().describe("Volume threshold (mm³) below which a collision is reported as 'press fit' (touching interface) instead of a real collision. Default 0.5."),
      // Joint per-check options
      jointTolerance: z.number().optional().describe("Max joint-to-surface distance in mm before a warning fires. Default 0.1."),
    },
    safeHandler("verify_shape", async (args) => {
      const {
        filePath, code, workingDir, params,
        checks, geometryFormat, geometryFaces, geometryEdges, geometryLimit, geometryPartName,
        collisionTolerance, collisionAcceptedPairs, collisionPressFitThreshold,
        jointTolerance,
      } = args;

      if (filePath !== undefined && code !== undefined) {
        return {
          content: [{ type: "text" as const, text: "verify_shape: pass either `filePath` OR `code`, not both." }],
          isError: true,
        };
      }
      if (filePath === undefined && code === undefined) {
        return {
          content: [{ type: "text" as const, text: "verify_shape: provide either `filePath` (existing shape) or `code` (inline snippet)." }],
          isError: true,
        };
      }

      const requested = (checks && checks.length > 0)
        ? Array.from(new Set(checks))
        : ["geometry", "collisions", "joints"] as const;
      const want = (k: "geometry" | "collisions" | "joints") =>
        (requested as readonly string[]).includes(k);

      return withShapeFile({ filePath, code, workingDir }, async (absPath) => {
        if (!existsSync(absPath)) {
          return {
            content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
            isError: true,
          };
        }

        const t0 = Date.now();
        // force:true — collisions need .shape.intersect(), geometry needs .shape.faces;
        // both deref live OCCT handles which the cache layer scrubs.
        const { status, parts } = await executeWithPersistedParams(absPath, params, { force: true });
        const executionMs = Date.now() - t0;

        if (!status.success || !parts) {
          const errReport = {
            ok: false,
            summary: { parts: 0, executionMs, totalMs: Date.now() - t0, issues: 1 },
            error: status.error ?? "shape execution failed",
            statusText: formatStatusText(status),
          };
          return {
            content: [{ type: "text" as const, text: `verify_shape: execution failed.\n${JSON.stringify(errReport, null, 2)}` }],
            isError: true,
          };
        }

        const core = await getCore();
        const replicad: any = core.replicad();

        const report: any = {
          ok: true,
          summary: { parts: parts.length, executionMs, totalMs: 0, issues: 0 },
        };

        if (want("geometry")) {
          const result = extractGeometry(parts, {
            partName: geometryPartName,
            format: geometryFormat as GeometryFormat | undefined,
            faces: geometryFaces as GeometryFacesFilter | undefined,
            edges: geometryEdges as GeometryEdgesFilter | undefined,
            limit: geometryLimit,
            replicad,
          });
          if (!result.ok) {
            report.geometry = { status: "error", error: result.error };
            report.ok = false;
            report.summary.issues++;
          } else {
            report.geometry = { status: "ok", report: result.report };
          }
        }

        if (want("collisions")) {
          const collisionReport = extractCollisions(parts, {
            tolerance: collisionTolerance,
            acceptedPairs: collisionAcceptedPairs,
            pressFitThreshold: collisionPressFitThreshold,
            replicad,
          });
          report.collisions = {
            status: collisionReport.skipped
              ? "skipped"
              : collisionReport.real.length > 0 || collisionReport.failures.length > 0
                ? "warning"
                : "ok",
            report: collisionReport,
          };
          if (collisionReport.real.length > 0 || collisionReport.failures.length > 0) {
            report.ok = false;
            report.summary.issues += collisionReport.real.length + collisionReport.failures.length;
          }
        }

        if (want("joints")) {
          const jointReport = extractJoints(parts, { tolerance: jointTolerance });
          report.joints = {
            status: !jointReport.introspectable
              ? "skipped"
              : jointReport.warnings.length > 0
                ? "warning"
                : "ok",
            report: jointReport,
          };
          if (jointReport.introspectable && jointReport.warnings.length > 0) {
            report.ok = false;
            report.summary.issues += jointReport.warnings.length;
          }
        }

        report.summary.totalMs = Date.now() - t0;
        const header = `verify_shape: ${report.ok ? "OK" : `${report.summary.issues} issue${report.summary.issues === 1 ? "" : "s"}`} (${parts.length} parts, ${report.summary.totalMs}ms total, ${executionMs}ms execution).`;

        return {
          content: [{ type: "text" as const, text: `${header}\n${JSON.stringify(report, null, 2)}` }],
        };
      });
    })
  );

  server.tool(
    "sweep_check",
    "Rotate a single named part through a range of angles around a pivot+axis and report any collisions it would make with the other parts at each step. Useful for articulated mechanisms (hinges, arms, linkages) where static collision checks miss motion conflicts. The moving part is cloned at every step so the original assembly is never mutated. Also reports the swept-volume AABB — the union of the moving part's axis-aligned bounds across every step — so you can size clearance envelopes. Pass either `filePath` or `code` (mutually exclusive, same rules as check_collisions). Pass `format: 'full'` for per-pair geometry; default summary keeps responses compact.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file to sweep. Absolute passes through; relative probes workspace roots. Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — written to a temp file, executed, then deleted. Use `workingDir` for relative-import resolution. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to host the inline snippet when `code` is provided. Defaults to a private globalStorage path."),
      moving: z.string().describe("Name of the part to rotate. Must match a name in the rendered assembly; `Part 'X' not found. Available: […]` is returned on a miss."),
      pivot: z.array(z.number()).length(3).describe("[x, y, z] pivot point for the rotation, in millimetres."),
      axis: z.array(z.number()).length(3).describe("[x, y, z] direction vector for the rotation axis. Need not be normalized."),
      range: z.array(z.number()).length(2).describe("[startDeg, endDeg] sweep range in degrees. Direction matters — [0, 90] sweeps positive, [0, -90] sweeps negative."),
      steps: z.number().int().positive().describe("Number of angle samples (inclusive endpoints). 8-24 is typical; more samples = finer resolution but linear slowdown."),
      tolerance: z.number().optional().describe("Minimum intersection volume in mm³ to count as a collision. Defaults to 0.001 — filters out numerical-noise touches. Negative values clamp to 0."),
      format: z.enum(["summary", "full", "ids"]).optional().describe("Report verbosity. summary (default): per-step counts only + worst step detail. full: per-step per-pair dump. ids: [step, [[a,b,vol],...]] tuples."),
    },
    safeHandler("sweep_check", async ({ filePath, code, workingDir, moving, pivot, axis, range, steps, tolerance, format }) => {
      if (filePath !== undefined && code !== undefined) {
        return {
          content: [{ type: "text" as const, text: "sweep_check: pass either `filePath` OR `code`, not both." }],
          isError: true,
        };
      }
      if (filePath === undefined && code === undefined) {
        return {
          content: [{ type: "text" as const, text: "sweep_check: provide either `filePath` (existing shape) or `code` (inline snippet)." }],
          isError: true,
        };
      }

      return withShapeFile({ filePath, code, workingDir }, async (absPath) => {
        if (!existsSync(absPath)) {
          return {
            content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
            isError: true,
          };
        }

        // Execute the script. Same path as check_collisions — failures surface
        // through formatStatusText so the agent sees the engine's own hints.
        // Force-bypass the mesh cache: the sweep loop calls
        // `movingPart.shape.clone().rotate(...).intersect(...)` per step, all
        // of which need a live OCCT shape (cached entries scrub `.shape`).
        const { status, parts } = await executeWithPersistedParams(absPath, undefined, { force: true });
        if (!status.success || !parts) {
          return {
            content: [{ type: "text" as const, text: `Cannot sweep — script failed to render.\n${formatStatusText(status)}` }],
            isError: true,
          };
        }

        if (parts.length < 1) {
          return {
            content: [{ type: "text" as const, text: "Sweep check skipped — file produced no parts." }],
          };
        }

        const movingIdx = parts.findIndex((p) => p.name === moving);
        if (movingIdx < 0) {
          const available = parts.map((p) => p.name).join(", ") || "(none)";
          return {
            content: [{ type: "text" as const, text: `Part '${moving}' not found. Available: [${available}]` }],
            isError: true,
          };
        }

        const tol = Math.max(0, typeof tolerance === "number" ? tolerance : 0.001);

        const core = await getCore();
        const replicad: any = core.replicad();
        const measureVol = replicad?.measureShapeVolumeProperties;

        const [startDeg, endDeg] = range as [number, number];
        const n = Math.max(2, Math.floor(steps));
        const angles: number[] = [];
        for (let s = 0; s < n; s++) {
          // Inclusive endpoints, matching the linspace convention the task spec
          // asked for. (n-1) denominator so angles[0] === startDeg and
          // angles[n-1] === endDeg exactly, no off-by-one on the report.
          angles.push(startDeg + ((endDeg - startDeg) * s) / (n - 1));
        }

        const movingPart = parts[movingIdx];
        const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : x.toFixed(2));
        const fmtAngle = (a: number) => (Math.abs(a) >= 100 ? a.toFixed(1) : a.toFixed(2));

        // Preflight: an assembly that already overlaps at the start position
        // makes the per-angle intersect()s fragile — OCCT will happily
        // boolean two solids that were colliding on input, and the resulting
        // volumes conflate "static overlap" with "sweep overlap". On real-
        // world assemblies it's usually the bug the user is actually hunting,
        // so surface pre-existing overlaps up front rather than making the
        // caller squint at noisy sweep output. Uses the same AABB-prefiltered
        // pairwise intersect that check_collisions / verify_shape use via
        // `extractCollisions` in verify-helpers.ts. `acceptedPairs` is left
        // undefined because sweep_check doesn't expose that argument today
        // (the sweep loop itself applies no pair-filter); when the tool grows
        // one, it should be threaded here too so expected static contact
        // isn't flagged as "pre-existing collision".
        const preflight = extractCollisions(parts, { tolerance: tol, replicad });
        if (preflight.real.length > 0) {
          const nPre = preflight.real.length;
          return {
            content: [{
              type: "text" as const,
              text: `sweep_check: assembly has ${nPre} pre-existing collision(s) at the start position — resolve static collisions before sweeping. Use check_collisions for details.\n${JSON.stringify({ preExistingCollisions: preflight.real }, null, 2)}`,
            }],
            isError: true,
          };
        }

        type Collision = { step: number; angle: number; pairA: string; pairB: string; volume: number };
        const collisions: Collision[] = [];
        const failures: Array<{ step: number; angle: number; pairB: string; error: string }> = [];

        // Swept envelope across EVERY step (clear or not) — the caller wants
        // the full reachable volume, not just the safe portion.
        let envMinX = Infinity, envMinY = Infinity, envMinZ = Infinity;
        let envMaxX = -Infinity, envMaxY = -Infinity, envMaxZ = -Infinity;

        const pivotT: [number, number, number] = [pivot[0], pivot[1], pivot[2]];
        const axisT: [number, number, number] = [axis[0], axis[1], axis[2]];

        for (let s = 0; s < n; s++) {
          const angle = angles[s];

          // CLONE BEFORE ROTATING. rotate() is destructive (deletes the input),
          // so we MUST operate on a fresh clone — never on movingPart.shape
          // itself, which is owned by the engine's parts list and will be
          // referenced again on the next step.
          let rotated: any = null;
          try {
            const cloned = movingPart.shape.clone();
            try {
              rotated = cloned.rotate(angle, pivotT, axisT);
            } catch (e: any) {
              // rotate threw — cloned was likely already consumed but try to
              // delete just in case, then record and move on.
              try { cloned.delete?.(); } catch {}
              failures.push({ step: s, angle, pairB: "(rotation)", error: e?.message ?? String(e) });
              continue;
            }
            // rotate consumed `cloned` — do NOT delete it separately. `rotated`
            // is the new handle we own and must delete in the outer finally.
          } catch (e: any) {
            failures.push({ step: s, angle, pairB: "(clone)", error: e?.message ?? String(e) });
            continue;
          }

          try {
            // Tessellate once per step to (a) update the swept envelope and
            // (b) let the agent see the reachable extents even on clear steps.
            try {
              const meshData: any = rotated.mesh?.({ tolerance: 0.1, angularTolerance: 0.3 });
              const verts: ArrayLike<number> | undefined = meshData?.vertices;
              if (verts && verts.length >= 3) {
                for (let k = 0; k < verts.length; k += 3) {
                  const x = verts[k], y = verts[k + 1], z = verts[k + 2];
                  if (x < envMinX) envMinX = x; if (x > envMaxX) envMaxX = x;
                  if (y < envMinY) envMinY = y; if (y > envMaxY) envMaxY = y;
                  if (z < envMinZ) envMinZ = z; if (z > envMaxZ) envMaxZ = z;
                }
              }
            } catch {
              // envelope is best-effort; one failed tessellation shouldn't
              // kill the whole sweep.
            }

            // Collision pass against every OTHER part. Per-pair try/catch so
            // one fragile intersect doesn't abort the sweep.
            for (let j = 0; j < parts.length; j++) {
              if (j === movingIdx) continue;
              const other = parts[j];
              let overlap: any = null;
              try {
                overlap = rotated.intersect(other.shape);
              } catch (e: any) {
                failures.push({ step: s, angle, pairB: other.name, error: e?.message ?? String(e) });
                continue;
              }
              try {
                let vol = 0;
                let volProps: any = null;
                try {
                  volProps = measureVol?.(overlap);
                  if (volProps && typeof volProps.volume === "number") vol = volProps.volume;
                } catch (e: any) {
                  failures.push({ step: s, angle, pairB: other.name, error: `volume measurement failed: ${e?.message ?? e}` });
                  continue;
                } finally {
                  try { volProps?.delete?.(); } catch {}
                }
                if (vol > tol) {
                  collisions.push({ step: s, angle, pairA: moving, pairB: other.name, volume: vol });
                }
              } finally {
                try { overlap?.delete?.(); } catch {}
              }
            }
          } finally {
            // Always delete the rotated clone — every step must release its
            // own WASM handle or the OCCT heap fills up quickly over a long
            // sweep.
            try { rotated?.delete?.(); } catch {}
          }
        }

        // ---- Formatting -------------------------------------------------
        const sweepFormat: CollisionReportFormat = format ?? "summary";
        const rangeHdr = `[${fmtAngle(startDeg)}\u00b0, ${fmtAngle(endDeg)}\u00b0]`;

        // ids format: delegate entirely to the pure helper, no header prose.
        if (sweepFormat === "ids") {
          return {
            content: [{ type: "text" as const, text: formatSweepCollisions(collisions, angles, "ids") }],
          };
        }

        // summary / full: header + pure formatting helper + envelope trailer.
        const headerLine = `Sweep check: '${moving}' rotating ${rangeHdr} in ${n} steps around [${fmt(pivot[0])},${fmt(pivot[1])},${fmt(pivot[2])}] axis [${fmt(axis[0])},${fmt(axis[1])},${fmt(axis[2])}]`;
        const collisionBlock = formatSweepCollisions(collisions, angles, sweepFormat);
        const sections: string[] = [headerLine];
        if (collisionBlock) sections.push(collisionBlock);

        if (failures.length > 0) {
          sections.push(`\nProbe failures (recorded, not counted as collisions):`);
          for (const f of failures) {
            sections.push(`  - Step ${f.step} (angle ${fmtAngle(f.angle)}\u00b0) vs ${f.pairB}: ${f.error}`);
          }
        }

        if (isFinite(envMinX)) {
          sections.push(
            `Swept envelope: x[${fmt(envMinX)}, ${fmt(envMaxX)}] y[${fmt(envMinY)}, ${fmt(envMaxY)}] z[${fmt(envMinZ)}, ${fmt(envMaxZ)}] mm`,
          );
        } else {
          sections.push(`Swept envelope: (unavailable \u2014 tessellation returned no vertices)`);
        }

        return {
          content: [{ type: "text" as const, text: sections.join("\n") }],
        };
      }); // close withShapeFile callback
    })
  );

  server.tool(
    "describe_geometry",
    "Enumerate the faces and/or edges of a rendered shape with per-entity geometry (normal, centroid, area, type; edges: start/end/length/type) plus a bounding box and a grouped-count `summary`. Use `format: 'summary'` (default) for a compact overview — counts per face type + per quantized normal direction + per edge type. Use `format: 'full'` to dump the raw per-entity arrays (respecting `limit`, default 50). Filter faces by `planar` / `curved` and edges by `outer` / `none`. Pass either `filePath` or inline `code` (mutually exclusive) — identical resolution rules as `preview_finder`. Useful before a chamfer/shell to confirm which faces/edges exist and their orientations.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file to describe. Absolute paths pass through; relative paths probe workspace roots. Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — executed in a temp file like preview_finder. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to write the inline snippet file in when `code` is provided. Defaults to a private globalStorage path."),
      partName: z.string().optional().describe("For multi-part assemblies: name of the part to describe. If omitted, every part is described."),
      format: z.enum(["summary", "full"]).optional().describe("'summary' (default) returns grouped counts only. 'full' returns the per-face/per-edge arrays up to `limit`."),
      faces: z.enum(["all", "planar", "curved"]).optional().describe("Face filter (default 'all'). 'planar' = only PLANE surface type; 'curved' = everything else."),
      edges: z.enum(["all", "outer", "none"]).optional().describe("Edge filter (default 'none'). 'all' = every edge; 'outer' = same as 'all' (Replicad doesn't expose seam/outer adjacency)."),
      limit: z.number().int().positive().optional().describe("Max entities per category in 'full' format (default 50). Truncation is flagged in summary.truncated."),
    },
    safeHandler("describe_geometry", async ({ filePath, code, workingDir, partName, format, faces, edges, limit }) => {
      if (filePath !== undefined && code !== undefined) {
        return {
          content: [{ type: "text" as const, text: "describe_geometry: pass either `filePath` OR `code`, not both." }],
          isError: true,
        };
      }
      if (filePath === undefined && code === undefined) {
        return {
          content: [{ type: "text" as const, text: "describe_geometry: provide either `filePath` (existing shape) or `code` (inline snippet)." }],
          isError: true,
        };
      }

      const effectiveFormat: "summary" | "full" = format ?? "summary";
      const effectiveFaces: "all" | "planar" | "curved" = faces ?? "all";
      const effectiveEdges: "all" | "outer" | "none" = edges ?? "none";
      const effectiveLimit = typeof limit === "number" && limit > 0 ? Math.floor(limit) : 50;

      return withShapeFile({ filePath, code, workingDir }, async (absPath) => {
        if (!existsSync(absPath)) {
          return {
            content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
            isError: true,
          };
        }

        // Step 1: execute the user's script. Force-bypass the mesh cache:
        // the per-part loop reads `part.shape.faces` / `part.shape.edges` to
        // walk the topology, both of which need a live OCCT shape (cached
        // entries scrub `.shape`).
        const { status, parts } = await executeWithPersistedParams(absPath, undefined, { force: true });
        if (!status.success || !parts || parts.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Cannot describe geometry — script failed to render.\n${formatStatusText(status)}` }],
            isError: true,
          };
        }

        // Resolve target parts: single-by-name or all.
        let targets: typeof parts;
        if (partName !== undefined) {
          const found = parts.find((p) => p.name === partName);
          if (!found) {
            return {
              content: [{ type: "text" as const, text: `No part named "${partName}" in ${basename(absPath)}. Available: ${parts.map((p) => p.name).join(", ") || "(none)"}` }],
              isError: true,
            };
          }
          targets = [found];
        } else {
          targets = parts;
        }

        // --- Helpers ------------------------------------------------------
        const round3 = (n: number): number =>
          (typeof n === "number" && isFinite(n)) ? Math.round(n * 1000) / 1000 : n;
        const round3pt = (p: { x: number; y: number; z: number }): [number, number, number] =>
          [round3(p.x), round3(p.y), round3(p.z)];

        // Quantize a normal vector to the 8-point compass. Any axis whose
        // magnitude is below 0.5 is treated as zero (so a mostly-+Z face with
        // negligible X/Y drift still groups under "+Z"). Faces with no dominant
        // direction return "oblique" so the summary doesn't falsely claim
        // alignment. The returned string is sorted by axis (X < Y < Z) so
        // "+X+Z" and "+Z+X" collapse to one bucket.
        const quantizeNormal = (nx: number, ny: number, nz: number): string => {
          const thresh = 0.5;
          const parts: string[] = [];
          if (Math.abs(nx) >= thresh) parts.push(nx > 0 ? "+X" : "-X");
          if (Math.abs(ny) >= thresh) parts.push(ny > 0 ? "+Y" : "-Y");
          if (Math.abs(nz) >= thresh) parts.push(nz > 0 ? "+Z" : "-Z");
          if (parts.length === 0) return "oblique";
          return parts.join("");
        };

        interface FaceRecord {
          part: string;
          id: number;
          type?: string;
          normal?: [number, number, number];
          normalDir?: string;
          centroid?: [number, number, number];
          area?: number;
        }
        interface EdgeRecord {
          part: string;
          id: number;
          type?: string;
          start?: [number, number, number];
          end?: [number, number, number];
          length?: number;
        }

        const core = await getCore();
        const replicad: any = core.replicad();
        const measureArea = replicad?.measureArea;

        const faceRecords: FaceRecord[] = [];
        const edgeRecords: EdgeRecord[] = [];
        const faceTypeCounts: Record<string, number> = {};
        const faceNormalCounts: Record<string, number> = {};
        const edgeTypeCounts: Record<string, number> = {};

        let totalFacesSeen = 0;
        let totalEdgesSeen = 0;
        let facesTruncated = false;
        let edgesTruncated = false;
        let globalMinX = Infinity, globalMinY = Infinity, globalMinZ = Infinity;
        let globalMaxX = -Infinity, globalMaxY = -Infinity, globalMaxZ = -Infinity;

        // Accumulate the per-part bounding box using the tessellated vertices
        // we already have (no need for OCCT's BoundingBox — vertex AABB is
        // already precise enough for this tool's "rough orientation" use case
        // and avoids handing a WrappingObj between worker hops). Matches the
        // pattern used by check_collisions.
        for (const part of targets) {
          const v = part.vertices;
          if (v && v.length >= 3) {
            for (let i = 0; i < v.length; i += 3) {
              if (v[i] < globalMinX) globalMinX = v[i];
              if (v[i] > globalMaxX) globalMaxX = v[i];
              if (v[i + 1] < globalMinY) globalMinY = v[i + 1];
              if (v[i + 1] > globalMaxY) globalMaxY = v[i + 1];
              if (v[i + 2] < globalMinZ) globalMinZ = v[i + 2];
              if (v[i + 2] > globalMaxZ) globalMaxZ = v[i + 2];
            }
          }
        }

        // --- Per-part iteration ------------------------------------------
        for (const part of targets) {
          const shape: any = part.shape;
          // FACES
          let faceList: any[] = [];
          try {
            faceList = shape.faces ?? [];
          } catch {
            faceList = [];
          }
          for (let i = 0; i < faceList.length; i++) {
            const f = faceList[i];
            totalFacesSeen++;
            let type: string | undefined;
            try {
              const t = f.geomType;
              if (typeof t === "string") type = t;
            } catch {}

            // Face filter: skip non-matching early (still count in total / type
            // summary? No — filtered entries shouldn't inflate counts either,
            // that would be confusing. Skip before any tallies.)
            const isPlanar = type === "PLANE";
            if (effectiveFaces === "planar" && !isPlanar) { try { f.delete?.(); } catch {}; continue; }
            if (effectiveFaces === "curved" && isPlanar) { try { f.delete?.(); } catch {}; continue; }

            if (type) faceTypeCounts[type] = (faceTypeCounts[type] ?? 0) + 1;

            // Centroid.
            let centroid: [number, number, number] | undefined;
            try {
              const c = f.center;
              if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.z === "number") {
                centroid = round3pt(c);
              }
              try { c?.delete?.(); } catch {}
            } catch {}

            // Normal (evaluated at the face center by default).
            let normal: [number, number, number] | undefined;
            let normalDir: string | undefined;
            try {
              if (typeof f.normalAt === "function") {
                const n = f.normalAt();
                if (n && typeof n.x === "number" && typeof n.y === "number" && typeof n.z === "number") {
                  normal = round3pt(n);
                  normalDir = quantizeNormal(n.x, n.y, n.z);
                  faceNormalCounts[normalDir] = (faceNormalCounts[normalDir] ?? 0) + 1;
                }
                try { n?.delete?.(); } catch {}
              }
            } catch {
              // Omit normal — don't fake it
            }

            // Area.
            let area: number | undefined;
            try {
              if (typeof measureArea === "function") {
                const a = measureArea(f);
                if (typeof a === "number" && isFinite(a)) area = round3(a);
              }
            } catch {
              // Some surface types throw; omit rather than invent a value.
            }

            if (effectiveFormat === "full") {
              if (faceRecords.length < effectiveLimit) {
                faceRecords.push({
                  part: part.name,
                  id: i,
                  type,
                  normal,
                  normalDir,
                  centroid,
                  area,
                });
              } else {
                facesTruncated = true;
              }
            }

            try { f.delete?.(); } catch {}
          }

          // EDGES
          if (effectiveEdges !== "none") {
            let edgeList: any[] = [];
            try {
              edgeList = shape.edges ?? [];
            } catch {
              edgeList = [];
            }
            for (let i = 0; i < edgeList.length; i++) {
              const e = edgeList[i];
              totalEdgesSeen++;
              let type: string | undefined;
              try {
                const t = e.geomType;
                if (typeof t === "string") type = t;
              } catch {}
              if (type) edgeTypeCounts[type] = (edgeTypeCounts[type] ?? 0) + 1;

              let start: [number, number, number] | undefined;
              let end: [number, number, number] | undefined;
              let length: number | undefined;
              try {
                const s = e.startPoint;
                if (s && typeof s.x === "number") start = round3pt(s);
                try { s?.delete?.(); } catch {}
              } catch {}
              try {
                const ep = e.endPoint;
                if (ep && typeof ep.x === "number") end = round3pt(ep);
                try { ep?.delete?.(); } catch {}
              } catch {}
              try {
                const l = e.length;
                if (typeof l === "number" && isFinite(l)) length = round3(l);
              } catch {}

              if (effectiveFormat === "full") {
                if (edgeRecords.length < effectiveLimit) {
                  edgeRecords.push({ part: part.name, id: i, type, start, end, length });
                } else {
                  edgesTruncated = true;
                }
              }

              try { e.delete?.(); } catch {}
            }
          }
        }

        // Token guard: in full mode, rough-estimate response size from the
        // face+edge record counts. Each record serializes to ~40 tokens when
        // JSON-stringified with the field set above; bail out and emit a
        // warning if the projection exceeds 20k tokens.
        const FULL_TOKEN_BUDGET = 20_000;
        const approxTokens = (faceRecords.length + edgeRecords.length) * 40;
        let tokenGuardNote: string | undefined;
        let forcedDowngrade = false;
        if (effectiveFormat === "full" && approxTokens > FULL_TOKEN_BUDGET) {
          tokenGuardNote =
            `Response would exceed ~${FULL_TOKEN_BUDGET.toLocaleString()}-token budget ` +
            `(estimated ${approxTokens.toLocaleString()} tokens for ${faceRecords.length} faces + ${edgeRecords.length} edges). ` +
            `Auto-downgraded to summary. Re-run with a smaller \`limit\` (current ${effectiveLimit}) or a tighter \`faces\`/\`edges\` filter to get full arrays.`;
          forcedDowngrade = true;
        }

        const boundingBox = globalMinX !== Infinity
          ? {
              min: [round3(globalMinX), round3(globalMinY), round3(globalMinZ)] as [number, number, number],
              max: [round3(globalMaxX), round3(globalMaxY), round3(globalMaxZ)] as [number, number, number],
              size: [
                round3(globalMaxX - globalMinX),
                round3(globalMaxY - globalMinY),
                round3(globalMaxZ - globalMinZ),
              ] as [number, number, number],
            }
          : undefined;

        const summary: any = {
          partNames: targets.map((p) => p.name),
          faceCount: totalFacesSeen,
          edgeCount: effectiveEdges === "none" ? undefined : totalEdgesSeen,
          facesByType: faceTypeCounts,
          facesByNormalDir: faceNormalCounts,
          edgesByType: effectiveEdges === "none" ? undefined : edgeTypeCounts,
          truncated: effectiveFormat === "full" && !forcedDowngrade
            ? { faces: facesTruncated, edges: edgesTruncated }
            : undefined,
        };

        const payload: any = {
          summary,
          boundingBox,
        };
        if (effectiveFormat === "full" && !forcedDowngrade) {
          payload.faces = faceRecords;
          if (effectiveEdges !== "none") payload.edges = edgeRecords;
        }
        if (tokenGuardNote) payload.warning = tokenGuardNote;

        // Serialize as pretty JSON so the agent can parse it programmatically
        // while still being readable in a transcript. Prefix with a one-line
        // header so the tool response is legible even without JSON tooling.
        const header = [
          `describe_geometry: ${targets.length} part${targets.length === 1 ? "" : "s"} (${targets.map((p) => p.name).join(", ")}) from ${basename(absPath)}`,
          `format=${forcedDowngrade ? "summary (auto-downgraded)" : effectiveFormat}, faces=${effectiveFaces}, edges=${effectiveEdges}, limit=${effectiveLimit}`,
        ].join("\n");
        return {
          content: [{ type: "text" as const, text: `${header}\n${JSON.stringify(payload, null, 2)}` }],
        };
      });
    })
  );
}

// Fix #1: large assemblies (Asbjørn's 86-part build) blow the MCP token cap
// when every part's per-row stats are emitted. Default to a 10-row cap;
// callers can opt into the full list with verbosity: "full".
const SUMMARY_PARTS_CAP = 10;

function formatProperties(
  props: ShapeProperties | undefined,
  verbosity: "summary" | "full" = "summary",
): string {
  if (!props) return "";
  const fmt = (n: number) =>
    Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
  const fmtPt = (p: [number, number, number]) =>
    `(${fmt(p[0])}, ${fmt(p[1])}, ${fmt(p[2])})`;

  const lines: string[] = [];
  if (typeof props.totalVolume === "number") {
    lines.push(`  volume: ${fmt(props.totalVolume)} mm³ (${fmt(props.totalVolume / 1000)} cm³)`);
  }
  if (typeof props.totalSurfaceArea === "number") {
    lines.push(`  surface area: ${fmt(props.totalSurfaceArea)} mm²`);
  }
  if (typeof props.totalMass === "number") {
    lines.push(`  mass: ${fmt(props.totalMass)} g`);
  }
  if (props.centerOfMass) {
    lines.push(`  center of mass: ${fmtPt(props.centerOfMass)} mm`);
  }
  if (props.parts && props.parts.length > 1) {
    const allParts = props.parts;
    const capped = verbosity === "summary" && allParts.length > SUMMARY_PARTS_CAP;
    const visible = capped ? allParts.slice(0, SUMMARY_PARTS_CAP) : allParts;
    for (const p of visible) {
      const bits: string[] = [];
      if (typeof p.volume === "number") bits.push(`V=${fmt(p.volume)}mm³`);
      if (typeof p.surfaceArea === "number") bits.push(`A=${fmt(p.surfaceArea)}mm²`);
      if (typeof p.mass === "number") bits.push(`mass=${fmt(p.mass)}g`);
      if (p.centerOfMass) bits.push(`CoM=${fmtPt(p.centerOfMass)}`);
      if (p.boundingBox) bits.push(`bbox=${fmt(p.boundingBox.x)}x${fmt(p.boundingBox.y)}x${fmt(p.boundingBox.z)}`);
      if (bits.length) lines.push(`  - ${p.name}: ${bits.join(", ")}`);
      // Printability: only surface the section when there's actually a
      // concern — clean parts (manifold + feature ≥ nozzle) stay silent so
      // the happy-path output isn't cluttered.
      const pr = p.printability;
      if (pr && (pr.manifold === false || pr.issues.length > 0)) {
        lines.push(
          `    printability: manifold=${pr.manifold}, minFeature=${pr.minFeatureSize_mm.toFixed(2)} mm`,
        );
        for (const issue of pr.issues) {
          lines.push(`      \u26a0 ${issue}`);
        }
      }
    }
    if (capped) {
      lines.push(`  … and ${allParts.length - SUMMARY_PARTS_CAP} more parts (use get_render_status for full list)`);
    }
  } else if (props.parts && props.parts.length === 1) {
    // Single-part renders skip the per-part stats row above (those are
    // redundant with the assembly-wide volume/area/mass), but we still want
    // to surface printability for the one part when it has concerns.
    const p = props.parts[0];
    const pr = p.printability;
    if (pr && (pr.manifold === false || pr.issues.length > 0)) {
      lines.push(
        `  printability: manifold=${pr.manifold}, minFeature=${pr.minFeatureSize_mm.toFixed(2)} mm`,
      );
      for (const issue of pr.issues) {
        lines.push(`    \u26a0 ${issue}`);
      }
    }
  }
  return lines.length ? `\nGeometric properties:\n${lines.join("\n")}` : "";
}

function findShapeFiles(dir: string, depth = 3): string[] {
  if (depth <= 0) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith(".shape.ts")) {
        results.push(full);
      } else if (stat.isDirectory()) {
        results.push(...findShapeFiles(full, depth - 1));
      }
    }
  } catch {}
  return results;
}

/**
 * Strip a category body down to honest-to-goodness signature lines — not
 * recipe prose and not every line that happens to contain a `(`.
 *
 * Tightened (P-3 fix) so the signatures-only view doesn't leak example
 * invocations like `console.log(debugJoints(positioned))` or bare
 * `mate(a.joints.x, b.joints.y)` — both matched the old "clean call" shape
 * even though they are recipe calls, not API signatures.
 *
 * A line qualifies if it matches ONE of:
 *
 *   - Heading (`#`..`####`) — kept as a section marker only.
 *   - Top-level declaration: `^(export )?(function|const|type|interface|class)\s+Name`.
 *     The leading-whitespace requirement keeps indented example assignments
 *     out (`  const sketch = drawCircle(5)` inside a fence).
 *   - Arrow-form signature: `name(args) → ReturnType` or
 *     `name(args): ReturnType` or `name(args) => ReturnType` — the three
 *     ways Replicad / the stdlib docs annotate a return shape.
 *   - Leading-dot chain signature followed by an arrow/colon: `.method(...)
 *     → Result` (used in finder DSL reference).
 *
 * Everything else is dropped. That includes:
 *   - `console.*(...)` / `return ...` / bare example calls without a
 *     `→` / `:` / `=>` return-type marker.
 *   - Lines containing recipe-shape method calls — `.translate(`,
 *     `.rotate(`, `.fuse(`, `.cut(`, `.fillet(`, `.extrude(`, etc. — when
 *     the line is not a signature declaration.
 *   - Indented `const`/`let`/`var` assignments inside code fences (examples).
 *
 * When a category has zero qualifying lines, the helper returns a short
 * note saying so rather than a misleading "here are the signatures" wrapper
 * around prose.
 */
export function extractSignatures(body: string, category: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  let inFence = false;

  // Strip leading bullet markers and wrapping backticks so the signature
  // pattern can match whether the author wrote ``- `foo(x)` `` or a bare
  // `foo(x)` line. Keep a version without a leading `-`/`*` but preserve
  // any inline code punctuation for kept output.
  const normalize = (raw: string): string =>
    raw.trim().replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim();

  // Declaration-form line (TS/JS). Matches `export function foo(…)`,
  // `class Foo`, `interface Foo`, `type Foo = …`, `const foo =` / `export
  // const foo =`. Must sit at column 0 — indented repeats inside code
  // fences are treated as examples, not API surface.
  const isTopLevelDeclaration = (rawLine: string): boolean =>
    /^(?:export\s+)?(?:function|const|class|interface|type)\s+\w/.test(rawLine);

  // Signature with a return-type marker (→ / : / =>). The marker is what
  // differentiates "signature" from "invocation" — a bare `foo(x)` could
  // be either, but `foo(x) → Bar` / `foo(x): Bar` / `foo(x) => Bar` can
  // only be documentation.
  //
  // Parens may nest one level deep (covers `foo(opts: { x: number })` and
  // `foo(x: Array<number>)` since `<` / `>` are just word-chars for us).
  const sigWithReturn = /^\.?[A-Za-z_][\w.]*\s*\(([^()]|\([^()]*\))*\)\s*(?:→|=>|:|—)\s*\S/;
  const isSignatureLine = (s: string): boolean => sigWithReturn.test(s);

  // Obvious non-signature shapes. Dropping these even if they accidentally
  // look like a signature keeps the output honest — erring on the side of
  // dropping prose over leaking it (per the P-3 brief).
  const looksLikeExampleCall = (s: string): boolean => {
    if (/^(console|return|let|var|throw|await|yield|if|for|while)\b/.test(s)) return true;
    // Indented `const`/`let`/`var` assignments — only `export const` /
    // top-level `const Name = …` should survive (handled by
    // isTopLevelDeclaration above; anything else is an example).
    if (/\.(translate|rotate|mirror|scale|fuse|cut|intersect|fillet|chamfer|shell|extrude|revolve|sketchOnPlane|sketchOnFace)\s*\(/.test(s)) {
      // A signature for `.fillet()` etc. would include `→`/`:`/`=>`.
      // Without that marker, it's a recipe invocation.
      if (!isSignatureLine(s)) return true;
    }
    return false;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) { inFence = !inFence; continue; }

    if (inFence) {
      // Top-level declarations only — indented repeats are examples.
      // Check example-call shape first: `const sketch = drawCircle(…).sketchOnPlane(…)`
      // parses as a `const` declaration but is a recipe, not an API signature.
      if (isTopLevelDeclaration(line) && !looksLikeExampleCall(line.trim())) {
        kept.push(line.trim());
        continue;
      }
      // Arrow-form annotations anywhere in a code fence are signatures.
      const nFence = normalize(line);
      if (!nFence) continue;
      if (isSignatureLine(nFence) && !looksLikeExampleCall(nFence)) {
        kept.push(nFence);
      }
      continue;
    }

    // Outside fences.
    if (/^#{1,4}\s/.test(line)) { kept.push(line); continue; }

    const n = normalize(line);
    if (!n) continue;
    if (isTopLevelDeclaration(n)) { kept.push(n); continue; }
    if (looksLikeExampleCall(n)) continue;
    if (isSignatureLine(n)) kept.push(n);
  }

  // Collapse consecutive blank sections and strip headings that now have no
  // body — a heading-only section is noise in signatures-only output.
  const collapsed: string[] = [];
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i];
    const isHeading = /^#{1,4}\s/.test(line);
    if (isHeading) {
      const next = kept[i + 1];
      const nextIsHeading = next && /^#{1,4}\s/.test(next);
      if (nextIsHeading || next === undefined) continue;
    }
    collapsed.push(line);
  }
  // Require at least one non-heading signature line; otherwise we have
  // nothing useful to show. Prose-heavy categories (finders recipes, the
  // overview) fall into this branch cleanly.
  const hasRealSignature = collapsed.some((l) => !/^#{1,4}\s/.test(l));
  const body2 = collapsed.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return hasRealSignature
    ? `# ${category} — signatures only\n\n${body2}`
    : `# ${category} — signatures only\n\n(No signature-shaped lines found in this category — the content is prose / recipes. Call get_api_reference without signaturesOnly for the full text.)`;
}

function getApiReference(category: string): string {
  const refs: Record<string, string> = {
    overview: `# ShapeItUp / Replicad API Overview

Files: *.shape.ts — export a default main() returning Shape3D.

PREFERRED pattern (with params for live sliders):
\`\`\`typescript
import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, height: 50, depth: 30 };

export default function main({ width, height, depth }: typeof params) {
  return drawRoundedRectangle(width, height, 5).sketchOnPlane("XY").extrude(depth);
}
\`\`\`

Multi-part assemblies:
\`\`\`typescript
return [
  { shape: base, name: "base", color: "#8899aa" },
  { shape: bolt, name: "bolt", color: "#aa8855" },
];
\`\`\`

Flow: Drawing (2D) → Sketch (on plane) → Shape3D (extrude/revolve/loft/sweep)

Coordinate system (units: millimeters):
  X = right, Y = forward (into the screen from the default iso view), Z = up.
\`\`\`
        Z (up)
        |
        |
        +------ X (right)
       /
      /
     Y (forward, away from camera)
\`\`\`
Planes and their extrude directions (verified from replicad source):
- "XY" — horizontal plane (top-down view). .extrude(d) goes +Z (up).
- "XZ" — vertical plane, faces the camera in "front" view. .extrude(d) goes -Y (TOWARD the camera). Normal = [0,-1,0].
- "YZ" — vertical plane, faces the camera in "right" view. .extrude(d) goes +X.
NOTE: replicad does NOT support "-XY"/"-XZ"/"-YZ" prefixes. Use the alternate plane names instead:
- "YX" (normal [0,0,-1]) extrudes -Z — use instead of "-XY"
- "ZX" (normal [0,1,0]) extrudes +Y — use instead of "-XZ" (or flip via negative extrude depth)
- "ZY" (normal [-1,0,0]) extrudes -X — use instead of "-YZ"
To cut a hole downward through a base, pass a negative extrude depth: .extrude(-depth), or use "YX" plane.

draw* vs sketch* — they look alike but return different things:
- drawCircle/drawRectangle/drawRoundedRectangle/drawEllipse/drawPolysides/drawText/draw()
    return a Drawing (2D, not placed). You MUST call .sketchOnPlane() before extruding.
    e.g. drawCircle(10).sketchOnPlane("XY").extrude(5)
- sketchCircle/sketchRectangle return a Sketch already placed via its config arg.
    Do NOT chain .sketchOnPlane() — it's already a Sketch. Go straight to extrude/revolve.
    e.g. sketchCircle(10, { plane: "XY" }).extrude(5)

Optional material for mass reporting:
  export const material = { density: 7.85, name: "steel" };  // g/cm³
Common densities (g/cm³): steel 7.85, aluminum 2.70, brass 8.50, ABS 1.04,
PLA 1.24, nylon 1.15, wood (pine) 0.50. When material is exported, get_render_status
returns mass alongside volume.

AI workflow: create_shape → get_render_status → render_preview (if visual check needed)

Categories: drawing, sketching, solids, booleans, modifications, transforms, finders, export, examples, stdlib`,
    drawing: `# Drawing API (2D Shapes)

All draw* functions return a **Drawing** — a 2D shape NOT yet placed on a plane.
You MUST call .sketchOnPlane("XY"|"XZ"|"YZ", origin?) before extruding/revolving.
(If you want a one-liner already placed on a plane, use sketchCircle/sketchRectangle
from the sketching category instead.)

## Factory Functions
- draw(origin?) → DrawingPen (freeform builder)
- drawRectangle(width, height) → Drawing
- drawRoundedRectangle(width, height, radius) → Drawing
- drawCircle(radius) → Drawing
- drawEllipse(xRadius, yRadius) → Drawing
- drawPolysides(radius, numSides) → Drawing
- drawText(text, { fontSize?, fontFamily? }) → Drawing

## DrawingPen Methods (chainable)
Lines: .lineTo([x,y]), .line(dx,dy), .vLine(d), .hLine(d), .polarLine(d, angle)
Arcs: .sagittaArcTo([x,y], sagitta), .tangentArcTo([x,y]), .threePointsArcTo([x,y], [mx,my])
Curves: .cubicBezierCurveTo([x,y], [cp1x,cp1y], [cp2x,cp2y]), .smoothSplineTo([x,y])
Close: .close(), .closeWithMirror(), .done()

## 2D Operations
.fuse(other), .cut(other), .intersect(other)
.offset(distance), .translate(dx,dy), .rotate(angle), .mirror(axis)`,
    sketching: `# Sketching (2D → 3D-ready)

A Sketch is a 2D shape placed on a plane — the input to extrude/revolve/loft/sweep.

Two ways to get one:
  1. From a Drawing (the draw* family): drawCircle(10).sketchOnPlane("XY", [0,0,0])
  2. Directly, via a sketch* convenience:  sketchCircle(10, { plane: "XY" })

The sketch* functions ALREADY return a Sketch — do NOT chain .sketchOnPlane() onto them.
sketchCircle(r).sketchOnPlane(...) throws at runtime.

Methods:
- drawing.sketchOnPlane(plane?, origin?) → Sketch
    plane: "XY" | "XZ" | "YZ" | "ZX" | "YX" | "ZY" | "front" | "back" | "left" | "right" | "top" | "bottom"
    (Note: "-XY"/"-XZ"/"-YZ" prefixes do NOT exist in replicad — use "YX"/"ZX"/"ZY" instead)
    origin: [x, y, z] — offsets the sketch along the plane normal, e.g. [0,0,20]
- drawing.sketchOnFace(face, scaleMode?) → Sketch
- sketchRectangle(w, h, config?) → Sketch
- sketchCircle(r, config?) → Sketch

Plane config for sketch*: { plane: "XY"|"XZ"|"YZ"|..., origin: [x,y,z] }

Plane orientation — what \`origin\` actually means:
The \`origin\` arg is NOT a 2D offset within the sketch plane — it is a full 3D point
that shifts the plane along its own normal. \`sketchOnPlane("XY", [0,0,20])\` places the
sketch on XY raised 20 mm in +Z. For "XZ" the normal is -Y (so [0,-20,0] shifts 20 mm
toward camera); for "YZ" the normal is +X. To translate within the plane, use \`drawing.translate(dx, dy)\` before \`sketchOnPlane\`, not the origin arg.

Pen axis mapping (sketchOnPlane):
  Plane  | pen h → world | pen v → world | extrudes toward
  XY     | +X            | +Y            | +Z
  YX     | +Y            | +X            | -Z
  XZ     | +X            | +Z            | -Y
  ZX     | +Z            | +X            | +Y
  YZ     | +Y            | +Z            | +X
  ZY     | +Z            | +Y            | -X

Example (non-XY): drawRoundedRectangle(60, 30).sketchOnPlane("XZ").extrude(20)
  → the 60mm side lies along world X, the 30mm side along world Z, extrude pushes 20mm toward -Y.
  → If you want the sketch's "h" to walk world Z instead, pick plane "ZX".

## Composition Patterns

All draw* factories return an origin-centered Drawing — most "constraint" questions
(center, edge-align, symmetry, radial patterns) reduce to plain 2D translate/cut.

Center one shape inside another — both are origin-centered, so a cut just works:
\`\`\`typescript
const base = drawRectangle(80, 50);
const hole = drawCircle(5);
const plate = base.cut(hole).sketchOnPlane("XY").extrude(10);
\`\`\`

Corner-relative placement — translate a pre-centered drawing by (halfW - inset, halfH - inset):
\`\`\`typescript
// 4mm bolt hole 5mm in from the +X/+Y corner of an 80x50 plate.
const hole = drawCircle(2).translate(80 / 2 - 5, 50 / 2 - 5);
\`\`\`

Symmetry via 2D mirror — \`closeWithMirror\` reflects the pen path across the X-axis and closes:
\`\`\`typescript
const halfProfile = draw().hLine(20).vLine(10).hLine(-15).closeWithMirror();
\`\`\`

N-fold radial patterning (bolt circles, cooling fins) — build the pattern in 2D, extrude once:
\`\`\`typescript
let plate = drawRectangle(100, 100);
for (let i = 0; i < 6; i++) {
  const angle = (i / 6) * 2 * Math.PI;
  const bolt = drawCircle(3).translate(40 * Math.cos(angle), 40 * Math.sin(angle));
  plate = plate.cut(bolt);
}
const part = plate.sketchOnPlane("XY").extrude(5);
\`\`\`

Sketch a feature on a raised plane — the \`origin\` arg of \`sketchOnPlane\` is a 3D point
that shifts the plane along its normal (see note above). A boss on top of a base:
\`\`\`typescript
const baseH = 10;
const boss = drawCircle(8).sketchOnPlane("XY", [0, 0, baseH]).extrude(5);
\`\`\``,
    solids: `# 3D Solid Operations

sketch.extrude(distance, config?) → Shape3D
sketch.revolve(axis?, config?) → Shape3D
sketch.loftWith(otherSketches, config?) → Shape3D
sketch.sweepSketch(profileFn, config?) → Shape3D

makeCylinder(radius, height, location?, direction?) → Shape3D
makeSphere(radius) → Shape3D
makeBox(corner1, corner2) → Shape3D
makeEllipsoid(rx, ry, rz) → Solid

For positioning tricks (centering, corner-relative, radial patterns) see "Composition Patterns" in the sketching category.`,
    booleans: `# Boolean Operations

shape.fuse(other) — union
shape.cut(tool) — subtraction
shape.intersect(other) — intersection

PREFER 2D booleans over 3D intersect — drawing.fuse/cut is far more robust.

## Patterned Features

For repeated features (N cooling fins, bolt-circle holes, ribs, teeth): combine
everything at the **Drawing (2D)** level with drawing.fuse/cut in a loop, THEN do
a single .sketchOnPlane().extrude() (or .revolve()) at the end. Each 3D fuse/cut
forces OCCT to rebuild the full solid topology, so N 3D ops cost O(N) solid
rebuilds. N 2D ops are cheap planar operations and a single extrude is one solid
build — often 10×+ faster, and far more robust on dense patterns. Only drop to
3D booleans when the features truly differ along the extrude axis (e.g. varying
heights or offset planes). See the "Cooling Fins" example in the examples category.`,
    modifications: `# Shape Modifications

shape.fillet(radius, finder?) → Shape3D
shape.chamfer(distance, finder?) → Shape3D
shape.shell(thickness, filter?) → Shape3D    — positional: filter is a callback
shape.shell({ thickness, filter }) → Shape3D — config: filter must be a FaceFinder INSTANCE
shape.draft(angle, faceFinder, neutralPlane?)

Apply fillets BEFORE boolean cuts. Use small radii (0.3-0.5mm) on complex geometry.

IMPORTANT: the shell config-object form does NOT accept a callback for \`filter\`. Use the positional form for callbacks — \`shape.shell(2, f => f.inPlane("XY", h))\` — or pass a \`new FaceFinder().inPlane(...)\` instance to the config form.`,
    transforms: `# Transformations

shape.translate(x, y, z), .translateX/Y/Z(d)
shape.rotate(angleDeg, position?, direction?)
shape.mirror(plane?, origin?)
shape.scale(factor, center?)  — uniform only

For non-uniform, use makeEllipsoid(rx, ry, rz) or draw directly in 2D.`,
    finders: `# Finders (selecting faces/edges)

EdgeFinder picks edges for fillet/chamfer; FaceFinder picks faces for shell/draft.
Pass a lambda \`e => e.method()\` (or \`f => f.method()\`) to the modification call — it receives a fresh finder.

## Common recipes

Vertical (Z-aligned) edges — outer corners of a vertical extrude:
\`shape.fillet(2, e => e.inDirection("Z"))\`

Top face of a part of height h — for shell, use the positional-callback form:
\`shape.shell(1, f => f.inPlane("XY", h))\` — callback works here, NOT inside { filter }

All circular edges (hole rims, cylinder caps):
\`shape.fillet(0.5, e => e.ofCurveType("CIRCLE"))\`

Circular edges of a specific radius r — \`ofLength\` matches circumference for circles (2*PI*r):
\`shape.fillet(0.3, e => e.ofCurveType("CIRCLE").ofLength(2 * Math.PI * r))\`

Edge at a specific corner (pick one vertex to round):
\`shape.fillet(3, e => e.containsPoint([x, y, z]))\`

All edges at Z=10 — e.g. top rim of a cylinder:
\`shape.fillet(1, e => e.inPlane("XY", 10))\`

Horizontal edges on the top face — combine with \`.and\`:
\`shape.fillet(1, e => e.inPlane("XY", h).and(e2 => e2.ofLength(edgeLen)))\`

All edges except the top — invert with \`.not\`:
\`shape.fillet(1, e => e.not(e2 => e2.inPlane("XY", h)))\`

Edges aligned with X or Y — either/or with \`.or\`:
\`shape.chamfer(0.5, e => e.inDirection("X").or(e2 => e2.inDirection("Y")))\`

Outer vertical edges only — exclude vertical edges created by internal boolean cuts
(filter Z-aligned edges to those whose length matches the full extrude height):
\`shape.fillet(1, e => e.inDirection("Z").and(e2 => e2.ofLength(height)))\`

Top rim of a cylinder / any circular top edge at Z=height:
\`shape.fillet(0.5, e => e.inPlane("XY", height).and(e2 => e2.ofCurveType("CIRCLE")))\`

Bolt-hole rims — circular edges whose circumference matches a given hole radius \`r\`:
\`shape.fillet(0.3, e => e.ofCurveType("CIRCLE").ofLength(2 * Math.PI * r))\`

Fillet everything EXCEPT the top opening (e.g. a shelled enclosure with an open top):
\`shape.fillet(1, e => e.not(e2 => e2.inPlane("XY", height)))\`

## Method reference

EdgeFinder + FaceFinder:
.inDirection(dir)                  — "X" | "Y" | "Z" | [x,y,z]
.inPlane(plane, origin?)           — "XY" | "XZ" | "YZ", optional offset
.parallelTo(plane)                 — plane name or a face
.containsPoint([x,y,z])
.atDistance(d, point?)
.atAngleWith(dir, angle?)
.and(fn), .or(fn), .not(fn)        — compose predicates

EdgeFinder only:
.ofLength(len)                     — length, or circumference for CIRCLE
.ofCurveType("CIRCLE" | "LINE" | "BSPLINE" | "BEZIER" | ...)

FaceFinder only:
.ofSurfaceType("PLANE" | "CYLINDER" | "SPHERE" | ...)

## Debugging

Before applying a fillet/chamfer, verify the selection:
- \`highlightFinder(shape, new EdgeFinder().inDirection("Z"))\` — highlights matched edges inline.
- Or call the \`preview_finder\` MCP tool to render a screenshot with the matched edges/faces highlighted. Use it whenever a finder might be ambiguous — much cheaper than a failed fillet on complex geometry.`,
    export: `# Export

export_shape tool:
- format: "step" (CAD/CNC) or "stl" (3D printing)
- outputPath: optional, auto-derived from source file name
- filePath: optional, defaults to last executed
- partName: optional — for multi-part assemblies (\`return [{ shape, name, color }, ...]\`),
    export ONLY the named component instead of the whole assembly.
- openIn: optional — launch in PrusaSlicer/Cura/Bambu/Orca/FreeCAD/Fusion

## Choosing format for assemblies

- **3D printing (STL)**: export each printable component SEPARATELY with \`partName\` —
    they almost always need different orientations on the build plate, and STL has no
    concept of named components anyway. One STL per part.
- **CAD / CNC (STEP)**: export the full assembly WITHOUT \`partName\`. STEP preserves
    the named components as a single structured file — that's what downstream CAD/CAM
    tools expect.

Example — pulling one part from a multi-part assembly for printing:
\`\`\`
export_shape({ filePath: "assembly.shape.ts", format: "stl", partName: "bolt" })
// → writes assembly.bolt.stl
\`\`\`

Runs fully in-process, no VSCode needed.`,
    examples: `# Example Shape Scripts

## Box with Hole and Fillets
\`\`\`typescript
import { drawRectangle, sketchCircle } from "replicad";
export default function main() {
  // drawRectangle returns a Drawing — must sketchOnPlane before extruding.
  let shape = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  shape = shape.fillet(2);
  // sketchCircle returns a Sketch directly (plane is passed via config).
  // Do NOT chain .sketchOnPlane() — it's already a Sketch.
  const hole = sketchCircle(8, { plane: "XY" }).extrude(20);
  return shape.cut(hole);
}
\`\`\`

## Cooling Fins (Patterned Feature)
Combine all N fins into the 2D cross-section first, then extrude once.
Doing this with N 3D .fuse() calls on an extruded cylinder is much slower —
OCCT rebuilds the solid topology on every call.
\`\`\`typescript
import { drawCircle, drawRectangle } from "replicad";

export const params = { finCount: 20, finThickness: 2, baseR: 15, finR: 30, height: 40 };

export default function main({ finCount, finThickness, baseR, finR, height }: typeof params) {
  let profile = drawCircle(baseR);
  for (let i = 0; i < finCount; i++) {
    const angle = (i / finCount) * 360;
    const fin = drawRectangle(finR * 2, finThickness).rotate(angle);
    profile = profile.fuse(fin); // cheap 2D boolean
  }
  return profile.sketchOnPlane("XY").extrude(height); // single solid build
}
\`\`\``,
    stdlib: `# ShapeItUp stdlib (\`import from "shapeitup"\`)

Mechanical / 3D-printing helpers layered on top of Replicad. Every function
returns a Replicad Shape3D (or Drawing, where noted), so results mix with any
other Replicad code. Dimensions come from ISO/DIN tables — don't hardcode.

\`\`\`typescript
import { holes, screws, bolts, washers, inserts, bearings, extrusions, patterns, printHints, motors, couplers, threads, fromBack, seatedOnPlate, shape3d, part, faceAt, shaftAt, boreAt, mate, assemble, subassembly, stackOnZ, entries, debugJoints, highlightJoints, cylinder, standards } from "shapeitup";
\`\`\`

**Convention for cut-tool shapes** (holes, bearing seats, insert pockets):
axis +Z, top of the tool at Z = 0, tool extends into -Z. Users translate the
tool to the target location and cut from their part:

\`\`\`typescript
plate.cut(holes.counterbore("M3", { plateThickness: 4 }).translate(10, 10, 4))
\`\`\`

**Convention for positive shapes** (screws, nuts, washers, bearing bodies — "nut" means \`screws.nut\`/\`bolts.nut\`, there's no separate \`nuts\` namespace):
top face at Z = 0, shaft/body extends into -Z. Colors left to the caller.

**Back-face cuts** — wrap a cut tool in \`fromBack(tool)\` to flip it so it
extends into +Z from Z=0 instead. Use for features that open on the bottom
face of a plate (heat-set inserts, access ports, etc):

\`\`\`typescript
plate.cut(fromBack(inserts.pocket("M3")).translate(x, y, 0))
\`\`\`

**Shape3D type-narrowing** — replicad's \`.extrude()\` returns a wide union
(\`Shell | Solid | …\`) that lacks \`.cut()\` / \`.fuse()\`. Wrap with
\`shape3d(...)\` to narrow, instead of writing \`as Shape3D\` everywhere:

\`\`\`typescript
const plate = shape3d(drawRectangle(60, 40).sketchOnPlane("XY").extrude(5));
plate.cut(hole);  // OK
\`\`\`

---

## holes — cut-tool shapes

\`\`\`typescript
holes.through(size, { depth?, fit?, axis? })               // clearance hole ("M3" or raw mm)
holes.clearance(size, { depth?, fit?, axis? })             // alias of through — same signature, common engineering term
holes.counterbore(spec, { plateThickness, fit?, axis? })   // socket-head pocket + shaft
holes.countersink(spec, { plateThickness, fit?, axis? })   // 90° flat-head flare + shaft
holes.tapped(size, { depth, axis? })                       // tap-drill sized (metal taps or skip — use inserts.pocket for FDM)
holes.threaded(size, { depth, axis? })                     // FDM: threaded hole — screw self-taps into tap-drill hole (preferred over modeled threads at M2–M5)
holes.teardrop(size, { depth, axis? })                     // horizontal hole, FDM-printable (axis: "+X"|"+Y")
holes.keyhole({ largeD, smallD, slot, depth, axis? })      // hang-on-screw mount
// axis names the face where the mouth opens; body penetrates opposite. Large circle centres on translate target; small-capture offsets along slot (rotated by axis). Example: wall.cut(holes.keyhole({ largeD: 10, smallD: 4, slot: 6, depth: 4, axis: '+X' }).translate(thickness, y, z))
holes.slot({ length, width, depth, axis? })                // elongated hole
\`\`\`

\`fit\` is a FitStyle: "press" | "slip" | "clearance" (default) | "loose".
\`size\` for through/teardrop accepts \`MetricSize\` strings ("M3") OR a raw diameter in mm.
\`spec\` for counterbore/countersink is a screw designator ("M3" — length ignored).
Supported metric sizes: M2, M2.5, M3, M4, M5, M6, M8, M10, M12. (Not every table covers every size — e.g. button/flat-head start at M3; heat-set inserts stop at M5. The helpers throw a readable "Unknown metric size" error with the supported list when the table misses a size.)
\`axis\` (default "+Z", extends toward -Z): one of "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y". Rotates the cutter so a single translate lands the hole on a vertical flange without manual \`.rotate(…)\`. Example: \`holes.through("M3", { depth: 8, axis: "+X" }).translate(0, 5, 10)\`. Teardrop uses its own "+X"/"+Y" axis set.

**String vs. raw diameter are NOT equivalent.** \`holes.through("M4", …)\` applies an ISO 273 clearance fit (~4.5mm for the default "clearance" fit style); \`holes.through(4, …)\` cuts a literal 4mm hole. Common nominal sizes (3, 4, 5, 6, 8, 10, 12) are easily confused — prefer the string form unless you specifically want a raw dimension. The stdlib emits a runtime warning when a raw integer matches a nominal size; pass a non-integer (e.g. \`4.0001\`) to suppress the warning when the literal diameter is intentional.

**Z-convention** — every hole tool spans \`Z ∈ [-depth, 0]\`: the entry face sits at Z=0 and the body extends into -Z. Translate by the plate's top-face Z so the mouth lands flush:

\`\`\`typescript
plate.cut(holes.through("M3", { depth: 10 }).translate(x, y, plateTop))
plate.cut(holes.counterbore("M3", { plateThickness: t }).translate(x, y, t))
\`\`\`

Forgetting this translate leaves the cutter below the plate and the boolean silently removes nothing. A "no material removal" warning from \`patterns.cutAt\` / \`.cut()\` usually means a missing or wrong-signed Z translate. For features that open on the BOTTOM face of a plate (heat-set inserts), wrap with \`fromBack(...)\` to flip the cutter into +Z.

---

## screws / bolts / washers / inserts — positive shapes

Two parallel fastener namespaces with identical method names. Pick by intent:

- \`screws.*\` = **cosmetic** (plain cylinder shafts, B-Rep Shape3D, fast, composable)
- \`bolts.*\`  = **threaded** (real helical geometry; \`bolts.nut\` returns MeshShape)

\`\`\`typescript
screws.socket("M3x10")     // ISO 4762 cap screw, plain shaft
screws.button("M4x8")      // ISO 7380 button-head
screws.flat("M5x12")       // ISO 10642 countersunk
screws.hex("M6x20")        // ISO 4017 hex bolt, plain shaft
screws.nut("M3")           // DIN 934 hex nut, clean bore

bolts.socket("M3x10")      // same four shapes, threaded shafts
bolts.button("M4x8")
bolts.flat("M5x12")
bolts.hex("M6x20")
bolts.nut("M3")            // MeshShape — see mesh/B-Rep note below

washers.flat("M3")         // DIN 125 flat washer
inserts.heatSet("M3")      // brass heat-set insert BODY
inserts.pocket("M3")       // CUT-TOOL for the pocket
\`\`\`

**Seating fasteners on a plate** — \`seatedOnPlate(fastener, plate, axis?)\` positions any fastener so its head-top face lands on the plate's surface along the given axis. \`axis\` ∈ \`"+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y"\` (default \`"+Z"\` — head atop plate). Works with \`bolts.*\`, \`screws.*\`, and the Mesh variants:

\`\`\`typescript
seatedOnPlate(bolts.socket("M6x20"), plate)       // head on plate top (+Z)
seatedOnPlate(screws.flat("M4x10"), plate, "-Z")  // head on plate bottom
seatedOnPlate(bolts.socket("M6x20"), wall, "+X")  // head on +X wall face
\`\`\`

Mixing mesh and B-Rep: \`bolts.nut\` is a MeshShape — it can only fuse/cut with other MeshShapes. Convert the Shape3D side first: \`plate.meshShape({ tolerance: 0.01 }).cut(bolts.nut("M3"))\`.

For 3D printing: use \`inserts.pocket\` + a real brass heat-set insert + \`screws.socket\` as the fastener. Printed threads under M5 are unreliable.

---

## bearings — seat cutters + bearing bodies

\`\`\`typescript
bearings.seat("608", { throughHole?, depth? })   // press-fit pocket, stepped shoulder by default
bearings.body("608")                              // ring-shape for visualization
bearings.linearSeat("LM8UU")                      // straight-bore linear-bearing pocket
bearings.linearBody("LM8UU")                      // linear-bearing outer shell
\`\`\`

Ball bearings: 623, 624, 625, 626, 608 (skate — most common), 6000, 6001, 6002.
Linear bearings: LM4UU, LM6UU, LM8UU, LM10UU, LM12UU.

\`bearings.seat\` uses \`FIT.press\` (slight interference) to grip the bearing. Default
is a stepped pocket with the bearing resting on a 3 mm shoulder; pass
\`{ throughHole: true }\` for a straight cylinder.

---

## patterns — placement arrays + single-call apply

\`\`\`typescript
patterns.polar(n, radius, { startAngle?, axis?: "X"|"Y"|"Z", orientOutward? })
patterns.grid(nx, ny, dx, dy?)                       // centered on origin
patterns.linear(n, [dx, dy, dz])                     // N copies along a vector

patterns.spread(makeShape, placements)               // fuse N copies (positive shape)
patterns.cutAt(target, makeTool, placements)         // cut N copies (cut-tool shape)
patterns.applyPlacement(shape, placement)            // low-level: apply one
\`\`\`

**Important**: \`spread\` and \`cutAt\` take a **factory** (\`() => Shape3D\`), not
a shape. Replicad shares OCCT handles across \`.translate()\`/\`.rotate()\` calls —
reusing one shape across multiple cuts invalidates earlier copies ("this
object has been deleted"). The factory guarantees a fresh handle per placement.

Generators return \`Placement[]\` — plain data (\`{ translate, rotate?, axis? }\`)
you can map, filter, or combine manually. Common uses:

\`\`\`typescript
// Bolt circle — 6 × M4 counterbored on a 40mm PCD
flange = patterns.cutAt(
  flange,
  () => holes.counterbore("M4", { plateThickness: 5 }).translate(0, 0, 5),
  patterns.polar(6, 20),
);

// PCB standoffs — 2×2 grid of M3 heat-set pockets
plate = patterns.cutAt(
  plate,
  () => inserts.pocket("M3").translate(0, 0, thickness),
  patterns.grid(2, 2, 50, 40),
);
\`\`\`

---

## extrusions — T-slot aluminum profiles

\`\`\`typescript
extrusions.tSlot("2020", 200)         // 200 mm length of 2020 profile (extrudes +Z)
extrusions.tSlotProfile("2020")       // 2D Drawing of the cross-section
extrusions.tSlotChannel("2020", 200)  // OUTER-envelope cut-tool for sliding-bracket fits
\`\`\`

Profiles: "2020", "3030", "4040". **v1 simplification**: the profile is a
quad-slot square (one rectangular slot per side) with a center hole — no
internal T-cavity. Good for visualization + mounting reference; not
STEP-accurate for manufacturing.

---

## Parts + joints — declarative assembly

For multi-part assemblies where bodies must mate face-to-face, use the
joints API: every part is built at its local origin, declares named
joints, and \`assemble()\` positions them via a mate graph.

\`\`\`typescript
const motor = part({
  shape: motorBody.fuse(shaft),
  name: "motor", color: "#2b2b2b",
  joints: {
    mountFace: faceAt(MOTOR_HEIGHT),                 // +Z face
    shaftTip:  shaftAt(MOTOR_HEIGHT + 24, 5),        // +Z shaft tip, Ø5
  },
});

const positioned = assemble(
  [motor, plate, coupler, leadscrew],
  [
    mate(motor.joints.mountFace,      plate.joints.motorFace),
    mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
    mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: 0.2 }),
  ],
);
return entries(positioned);
\`\`\`

**Joint shortcuts** — encode the "axis points outward" convention so you
don't have to pick +Z vs -Z manually:

| Helper | Role | Default axis |
|---|---|---|
| \`faceAt(z, { axis?, xy? })\` | \`"face"\` | \`"+Z"\` |
| \`shaftAt(z, diameter, { axis?, xy? })\` | \`"male"\` | \`"+Z"\` |
| \`boreAt(z, diameter, { axis?, xy? })\` | \`"female"\` | \`"-Z"\` |

Pass \`{ axis: "-Z" }\` (or any other) to override the default. \`xy?: [number, number]\` off-centres the joint within the Z plane — essential for multi-joint parts on vertical walls or corner pivots (e.g. \`faceAt(50, { axis: "+X", xy: [-30, 10] })\`).

**\`mate()\` pre-flight**: throws if male/female roles are incompatible, if
face/face is mixed with male/female, or if matched diameters differ by
> 0.01mm. Catches wrong-size bolts + misaligned conventions at declaration
time, before a silent interference.

**\`assemble(parts, mates)\`** picks \`parts[0]\` as the fixed root, BFS-walks
the mate graph, returns the parts in their final positions.
\`entries(positioned)\` converts to the \`{shape, name, color}[]\` return format.

**Simple coaxial stacks** don't need joint declarations — \`stackOnZ(parts, { gap? })\`
positions via bounding-box math and requires no joints.

**\`cylinder({...})\`** — orientation-explicit alternative to replicad's
\`makeCylinder\`. Takes named \`{ top | bottom, length, diameter, direction? }\`
so the anchor is unambiguous.

**Insertion mates** — when a part must nest INSIDE another (press-fit bearing
in a pocket, dowel in a blind hole), declare the moving joint at the FAR
end of the overlap region with axis pointing OUTWARD. With \`gap=0\`,
\`mate()\` puts the two joint origins at the same place; the bulk of the
moving part then extends BEHIND the joint into the host:

\`\`\`typescript
const bearing = part({
  shape: bearings.body("608"), name: "bearing", color: "#c0c4c8",
  joints: {
    pocketSeat: faceAt(BEARING_WIDTH, { axis: "-Z" }),   // top of bearing, axis back out of pocket
  },
});
const plate = part({
  shape: plateWithPocket, name: "plate", color: "#8899aa",
  joints: { pocketMouth: faceAt(PLATE_THICKNESS) },      // mouth at top face, axis +Z
});
// Bearing body ends up occupying Z ∈ [mouth - width, mouth] — nested in the pocket.
mate(plate.joints.pocketMouth, bearing.joints.pocketSeat);
\`\`\`

**Debugging joint positions** — two helpers for "where did this joint land?":

\`\`\`typescript
console.log(debugJoints(positioned));   // text dump of every joint → world pos + axis
return highlightJoints(positioned);     // viewer: renders parts + pink spheres at each joint
\`\`\`

\`highlightJoints\` is the fastest way to diagnose a misaligned mate.

See \`examples/stdlib/leadscrew-assembly.shape.ts\` for a full NEMA17 →
coupler → leadscrew assembly using this API.

---

## Standard part builders — motors, couplers

Pre-assembled \`Part\` builders with joints already declared. Skip the
manual body+shaft+joint boilerplate when a standard mechanical part will do:

\`\`\`typescript
const motor   = motors.nema17();           // Part with mountFace + shaftTip joints
const coupler = couplers.flexible();       // default 5mm↔8mm bore pair
\`\`\`

Motor layout — body at Z=[0, HEIGHT], shaft on top (Z=[HEIGHT, HEIGHT+SHAFT_LENGTH]),
\`mountFace\` at the BOTTOM (axis "-Z"), \`shaftTip\` at the shaft end (axis "+Z").
Fits a "motor on top of a cap with shaft extending up" case natively. For the
inverse, rotate: \`motors.nema17().rotate(180, "+X")\`.

| Builder | Size | Joints exposed |
|---|---|---|
| \`motors.nema17(opts?)\` | 42×42×40, Ø5 shaft | mountFace, shaftTip |
| \`motors.nema23(opts?)\` | 56.4×56.4×56, Ø6.35 shaft | mountFace, shaftTip |
| \`motors.nema14(opts?)\` | 35×35×28, Ø5 shaft | mountFace, shaftTip |
| \`couplers.flexible(opts?)\` | Ø20 × 25, 5→8 bores | motorEnd (female), leadscrewEnd (female) |

Raw dimensions live in \`standards.NEMA17\` / \`.NEMA23\` / \`.NEMA14\` /
\`.FLEXIBLE_COUPLER_5_8\` for user patterns:

\`\`\`typescript
patterns.grid(2, 2, standards.NEMA17.boltPitch, standards.NEMA17.boltPitch);
\`\`\`

See \`examples/stdlib/linear-actuator.shape.ts\` (155 lines, 7 parts — same
assembly that took 286 lines before these builders landed).

---

## Subassemblies — Parts made of Parts

\`subassembly({ parts, mates, name?, color?, promote?, root? })\` returns a
Part that behaves exactly like a single Part — it can be mated, translated,
rotated — but under the hood it composes other Parts and renders them all:

\`\`\`typescript
const driveHead = subassembly({
  parts: [motorCap, motor, coupler, leadscrew],
  mates: [
    mate(motorCap.joints.motorFace,   motor.joints.mountFace),
    mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
    mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: 0.2 }),
  ],
  name: "drive-head",
  // Joints to expose on the subassembly's boundary:
  promote: { extrusionFace: motorCap.joints.extrusionFace },
});

// Treat the subassembly as a single Part at the top level
const positioned = assemble([extrusion, driveHead, bearingBlock], [
  mate(extrusion.joints.topFace,    driveHead.joints.extrusionFace),
  mate(extrusion.joints.bottomFace, bearingBlock.joints.extrusionFace),
]);
return entries(positioned);   // entries() flattens subassemblies automatically
\`\`\`

\`promote\` maps new-joint-name → existing attached joint on a child. The
promoted joints become the only interface visible at the outer level.
Subassemblies compose recursively — a subassembly can be a child of another.

\`entries()\` detects subassemblies and yields one entry per leaf Part with
colors and names preserved from the child, so the viewer's parts panel
still shows individual components.

At scale the win is structural: the top-level mate graph shrinks (2 mates
instead of 6 in the example), each module is independently testable /
swappable (\`motors.nema17()\` → \`motors.nema23()\` inside \`makeDriveHead()\`
leaves the outer assembly untouched), and you can ship a library of reusable
modules.

See \`examples/stdlib/linear-actuator-subassembled.shape.ts\` for a full
comparison to the flat version.

---

## threads — helical metric + trapezoidal

> ⚠️ **FDM WARNING**: Modeled helical threads at M2–M5 (pitch < 1 mm) are
> below typical FDM nozzle resolution. Slicers (Cura, PrusaSlicer, Bambu
> Studio) produce unsliceable or non-watertight STLs at these sizes. For
> 3D printing, prefer \`holes.threaded(size, { depth })\` and let the screw
> self-tap into the tap-drill hole, OR \`inserts.pocket\` + a brass
> heat-set insert. Modeled threads are correct for STEP export to
> CNC/molding and for M6+ on FDM. Each \`threads.tapInto/metric/metricMesh/
> externalMesh/internalMesh\` call at M2–M5 emits a runtime warning
> redirecting you to the self-tap pathway.

Real helical threads via OCCT sweep. Mostly useful for STEP export,
visual fidelity, and large printable threads (jar lids, leadscrews, M8+).
**Small threads (M2–M5) don't survive FDM printing reliably** — use
\`holes.threaded\` (self-tap) or \`inserts.pocket\` + heat-set inserts instead.

**Compound vs. Mesh form.** \`threads.metric\` and \`threads.leadscrew\`
return a Compound (root cylinder + un-fused per-turn loops). That is fast
and correct for multi-part STEP export where the thread is its own named
part. It is **not fuse-safe**: OCCT's B-Rep boolean cannot merge the
per-turn loops with another solid and produces non-manifold seams —
\`head.fuse(threads.metric(...))\` will flunk BRepCheck. Whenever you want
to combine a thread with another solid, use the \`*Mesh\` variants which
route the union through the Manifold kernel (O(n log n), sub-second on
WASM). Matching \`bolts.*Mesh\` factories (\`bolts.socketMesh\`,
\`bolts.buttonMesh\`, \`bolts.hexMesh\`, \`bolts.flatMesh\`) return a
pre-fused MeshShape bolt so you can drop a complete bolt into a MeshShape
boolean directly.

\`\`\`typescript
// Compound form — STEP-friendly, NOT fuse-safe:
threads.metric("M5", 20)                           // ISO coarse (0.8mm pitch)
threads.metric("M5", 20, { pitch: "fine" })        // ISO fine (0.5mm)
threads.metric("M6", 30, { pitch: 1.5 })           // custom pitch

// Mesh form — fuse-safe (returns MeshShape):
threads.metricMesh("M8", 30)                       // same signature as .metric
threads.fuseThreaded(head, "M8", 30, [0, 0, -30])  // head: Shape3D or MeshShape

threads.tapHole("M5", 8)                           // cut-tool for a tapped hole
plate.cut(threads.tapHole("M5", 8).translate(x, y, plateTop))

// Modeled internal threads — real helical ridges, return fuse-safe MeshShape:
// ⚠️ FDM: M2–M5 modeled threads print poorly. For 3D printing, prefer
//         holes.threaded("M4", { depth }) + let the screw self-tap.
threads.tapInto(plate, "M5", 8, [x, y, plateTop])               // metric
threads.tapIntoTrap(plate, "TR8x8", 16, [x, y, plateTop])       // trapezoidal (leadscrew nuts)

// Chaining multiple taps — both accept Shape3D OR MeshShape:
let plate = shape
plate = threads.tapInto(plate, "M6", 15, p1)   // Shape3D → MeshShape
plate = threads.tapInto(plate, "M6", 15, p2)   // MeshShape → MeshShape (no crash)
return plate
// Output is always MeshShape; downstream .fuse/.cut must be Manifold-compatible.

threads.leadscrew("TR8x8", 150)                    // Compound (not fuse-safe)
threads.leadscrewMesh("TR8x8", 150)                // MeshShape (fuse-safe)

// Low-level:
threads.external({ diameter, pitch, length, profile?, starts? })
threads.internal({ diameter, pitch, length, profile?, starts? })
\`\`\`

**Cost**: a 20mm M3 thread adds ~3000 triangles. Plain \`cylinder()\` is
far cheaper if you don't need actual thread geometry.

---

## printHints — FDM print-cleanliness helpers

\`\`\`typescript
printHints.elephantFootChamfer(shape, 0.4)       // chamfer bottom edges (default 0.4 mm)
printHints.overhangChamfer(shape, 45)            // best-effort overhang chamfer (warn on fail)
printHints.firstLayerPad(shape, { padding?, thickness? })  // thin adhesion pad (manual brim)
\`\`\`

\`overhangChamfer\` is a v1 stub — returns the shape unchanged with a
\`console.warn\` on complex geometry. For known-good cases (simple brackets,
plates) it cuts a reasonable chamfer.

**Print orientation helpers** — re-orient a part for FDM printing and pack
multiple parts onto one build plate:

\`\`\`typescript
import { printHints } from "shapeitup";

const laidFlat = [bracket, lid, shaft].map(printHints.flatForPrint);
return printHints.layoutOnBed(laidFlat, { spacing: 5, bedWidth: 220 });
\`\`\`

\`flatForPrint(shape)\` picks the largest planar face, rotates its outward normal
to -Z, and translates so \`bbox.min.z === 0\`. \`layoutOnBed(shapes, { spacing,
bedWidth })\` shelf-packs on the XY plane, wrapping to a new Y-shelf when
\`bedWidth\` is exceeded. Both clone their inputs — the original assembly-posed
shapes survive unchanged, so you can use the same Part in \`assemble()\` AND
in a print-layout return from \`main()\` without double-transforming.

---

## pins — shafts, pivots, cross-pins (mechanism primitives)

\`\`\`typescript
pins.pin({ diameter, length, headDia?, headThk?, axis?, chamfer? })   // shaft, optional shoulder, tip chamfer
pins.pivot({ size, fit?, length })                                     // matched { pin, hole, clearance } pair for a hinge axle
pins.teeBar({ mainDia, mainLen, crossDia, crossLen, crossAt? })        // T-handle / cross-pin
\`\`\`

\`pins.pin\` — base at origin extending along \`axis\` (default \`"+Z"\`). Passing
\`headDia\` adds a shoulder at the far end so the pin can't fall through a
matching bore. \`pins.pivot\` wraps \`pin\` with a matching cylinder cut-tool sized
to the fit allowance (default \`"slip"\` for rotating joints) — keeps pin and bore
diameters in sync automatically. \`teeBar\`: main axis +Z, cross axis +X.

---

## cradles — ball cups and elastic anchors

\`\`\`typescript
cradles.cradle({ ballDiameter, wall?, capturePercent?, axis? })        // hollow cup sized for a sphere
cradles.band_post({ postR, hookR, height, headThk?, axis? })           // shaft + mushroom head, retains a rubber band
\`\`\`

\`capturePercent\` controls how much of the sphere wraps the ball: \`0.4\` is a
shallow saucer, \`0.5\` a hemisphere (default), values approaching \`1\` approach
a nearly-closed shell. For FDM, orient so the opening faces \`-Z\` — the cavity's
ceiling prints without support. Pair with \`standards.SPORTS_BALLS[...].diameter\`
for standard-sized payloads.

---

## standards.SPORTS_BALLS — ball dimension tables

\`\`\`typescript
standards.SPORTS_BALLS.tennis     // { diameter: 67,    name: "Tennis ball (ITF)" }
standards.SPORTS_BALLS.pingpong   // { diameter: 40,    name: "Table tennis ball" }
standards.SPORTS_BALLS.golf       // { diameter: 42.67, name: "Golf ball (R&A/USGA)" }
standards.SPORTS_BALLS.baseball   // { diameter: 73,    name: "Baseball (MLB)" }
standards.SPORTS_BALLS.soccer     // { diameter: 216,   name: "Soccer ball (FIFA size 5)" }
\`\`\`

---

## symmetricPair — mirrored part pairs

When an assembly uses a left/right pair of the same geometric part, build it
once at the origin and use \`symmetricPair(part, plane, opts?)\` to get
\`[left, right]\` with all joint positions and axes reflected. Joint roles
(male/female/face) are preserved across the mirror.

\`\`\`typescript
import { part, faceAt, symmetricPair } from "shapeitup";

const bracket = part({ shape: bracketShape, name: "bracket", joints: { ... } });
const [left, right] = symmetricPair(bracket, "YZ", { leftSuffix: "L", rightSuffix: "R" });
// left.joints.wallFaceL, right.joints.wallFaceR — no name collision in mates
\`\`\`

---

## Complete worked example

\`\`\`typescript
import { drawRoundedRectangle, type Shape3D } from "replicad";
import { holes, inserts, screws } from "shapeitup";

export const params = { width: 60, depth: 40, thickness: 5 };

export default function main({ width, depth, thickness }: typeof params) {
  const plate = drawRoundedRectangle(width, depth, 3)
    .sketchOnPlane("XY")
    .extrude(thickness) as Shape3D;

  // 4 corner counterbored M3 mounting holes.
  const inset = 6;
  const positions: [number, number][] = [
    [-width/2 + inset, -depth/2 + inset],
    [ width/2 - inset, -depth/2 + inset],
    [-width/2 + inset,  depth/2 - inset],
    [ width/2 - inset,  depth/2 - inset],
  ];
  let body = plate;
  for (const [x, y] of positions) {
    const cb = holes.counterbore("M3", { plateThickness: thickness }).translate(x, y, thickness);
    body = body.cut(cb);
  }
  return body;
}
\`\`\``,
  };
  return refs[category] || refs.overview;
}

// --- Keyword search over the API reference ---------------------------------

// Full category list kept in sync with the z.enum above. We can't introspect
// `getApiReference.refs` from out here, so we re-enumerate. If you add a
// category, add it here too.
const API_REFERENCE_CATEGORIES = [
  "overview", "drawing", "sketching", "solids", "booleans",
  "modifications", "transforms", "finders", "export", "examples", "stdlib",
] as const;

const SEARCH_STOPWORDS = new Set([
  "how", "to", "do", "a", "an", "the", "in", "with", "for", "of", "on",
  "and", "or", "is", "are", "be", "can", "i", "my", "it", "this", "that",
]);

function tokenizeSearch(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]+/g, ""))
    .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
}

interface RefSection {
  category: string;
  heading: string;
  body: string; // heading + body combined (what we display)
}

/**
 * Split a category body into sections. Each section is the top `# Title` block
 * plus any subsequent `## Subheading` blocks. If the body has no `##` headers,
 * the whole body is one section.
 */
function splitIntoSections(category: string, body: string): RefSection[] {
  const lines = body.split(/\r?\n/);
  const sections: RefSection[] = [];
  let currentHeading = category;
  let currentLines: string[] = [];

  const flush = () => {
    // Drop leading/trailing blank lines.
    while (currentLines.length && currentLines[0].trim() === "") currentLines.shift();
    while (currentLines.length && currentLines[currentLines.length - 1].trim() === "") currentLines.pop();
    if (currentLines.length === 0) return;
    sections.push({
      category,
      heading: currentHeading,
      body: currentLines.join("\n"),
    });
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      // New heading — flush the previous section.
      flush();
      currentHeading = m[2].trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  // Fallback: if we somehow produced nothing (body was empty of headers),
  // use a single-section blob split on double-newlines would over-fragment
  // code blocks, so just return the whole body.
  if (sections.length === 0 && body.trim().length > 0) {
    sections.push({ category, heading: category, body });
  }
  return sections;
}

// Lazily-built cache of all sections, keyed by category.
let _sectionCache: Map<string, RefSection[]> | null = null;
function getAllSections(): Map<string, RefSection[]> {
  if (_sectionCache) return _sectionCache;
  const cache = new Map<string, RefSection[]>();
  for (const cat of API_REFERENCE_CATEGORIES) {
    cache.set(cat, splitIntoSections(cat, getApiReference(cat)));
  }
  _sectionCache = cache;
  return cache;
}

function scoreSection(section: RefSection, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const headingLower = section.heading.toLowerCase();
  const bodyLower = section.body.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    // Count occurrences in body (includes heading line). Heading matches get a 3x boost on top.
    const bodyMatches = bodyLower.split(tok).length - 1;
    if (bodyMatches > 0) score += bodyMatches;
    if (headingLower.includes(tok)) score += 3;
  }
  return score;
}

function searchApiReference(query: string, scope?: string): string {
  const tokens = tokenizeSearch(query);
  const cache = getAllSections();
  const categoriesToSearch = scope ? [scope] : [...API_REFERENCE_CATEGORIES];
  const categoryList = API_REFERENCE_CATEGORIES.join(", ");

  if (tokens.length === 0) {
    return `No searchable keywords in "${query}" (all terms were stopwords or too short). Available categories: ${categoryList}. Try a more specific term.`;
  }

  const scored: Array<{ section: RefSection; score: number }> = [];
  for (const cat of categoriesToSearch) {
    const sections = cache.get(cat);
    if (!sections) continue;
    for (const section of sections) {
      const score = scoreSection(section, tokens);
      if (score > 0) scored.push({ section, score });
    }
  }

  if (scored.length === 0) {
    return `No matches for "${query}". Available categories: ${categoryList}. Try broader terms or call without \`search\` to see a category.`;
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5);

  const lines: string[] = [];
  lines.push(`Search results for "${query}"${scope ? ` in category ${scope}` : ""} — top ${top.length} of ${scored.length} match${scored.length === 1 ? "" : "es"}:`);
  lines.push("");
  top.forEach((hit, i) => {
    lines.push(`[${i + 1}] ${hit.section.category} › ${hit.section.heading} (score: ${hit.score})`);
    lines.push(hit.section.body);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}
