import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync, renameSync } from "fs";
import { join, resolve, basename, dirname, isAbsolute, sep } from "path";
import { homedir } from "os";
import {
  executeShapeFile,
  exportLastToFile,
  getCore,
  getLastFileName,
  resetCore,
  type EngineStatus,
  type ShapeProperties,
} from "./engine.js";

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
 * Version tag appended to every response that routes through `formatStatusText`.
 * Read from `packages/extension/package.json` at MCP-server startup so agents
 * can tell at a glance which extension release they're talking to — hard bug
 * reports otherwise conflate "fixed on tip" with "old build still installed".
 *
 * Probes a few candidate locations for the package.json because the MCP server
 * ships bundled (dist/ layout is flat) but during `tsc --noEmit` / dev mode we
 * run from source. If we can't find it, fall back to `unknown` rather than
 * throwing — a missing version is informational, not load-bearing.
 */
const SHAPEITUP_VERSION: string = (() => {
  const candidates: string[] = [];
  try {
    // From compiled dist (packages/mcp-server/dist/*.js or bundled single file).
    candidates.push(join(__dirname, "..", "..", "extension", "package.json"));
    candidates.push(join(__dirname, "..", "..", "..", "extension", "package.json"));
    // From source tree (packages/mcp-server/src/tools.ts) during dev / tsc.
    candidates.push(join(__dirname, "..", "..", "..", "packages", "extension", "package.json"));
    // Bundled alongside in globalStorage layouts (defensive).
    candidates.push(resolve(process.cwd(), "packages", "extension", "package.json"));
  } catch {
    // __dirname shouldn't throw but be defensive — fall through to "unknown".
  }
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg && typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version;
        }
      }
    } catch {
      // ignore and try the next candidate
    }
  }
  return "unknown";
})();
const SHAPEITUP_VERSION_TAG = `\n[shapeitup v${SHAPEITUP_VERSION}]`;

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
  const hb = readHeartbeat();
  if (!hb) return false;
  return Date.now() - (hb.timestamp ?? 0) < 5000;
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
    await new Promise((r) => setTimeout(r, 100));
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
  const segments = resolve(absoluteDir).split(/[\\/]+/).filter(Boolean);
  const last = segments[segments.length - 1];
  const prev = segments[segments.length - 2];
  if (last && prev && last.toLowerCase() === prev.toLowerCase()) {
    return (
      `\nWarning: directory resolved to ${absoluteDir}. Note the path segment ` +
      `"${last}" appears twice — you may have intended directory: "." ` +
      `or a subdir. Passed through as-is.`
    );
  }
  return "";
}

function formatStatusText(status: EngineStatus): string {
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
    return `Render FAILED\nError: ${status.error}${hint}${operation}${stack}${resetNote}\nFile: ${status.fileName || "unknown"}\nTip: call get_preview to view the last successful render for visual comparison (the PNG is NOT overwritten on failure).\nTime: ${status.timestamp}${SHAPEITUP_VERSION_TAG}`;
  }
  const parts = status.partNames?.length ? `\nParts: ${status.partNames.join(", ")}` : "";
  const paramEntries = status.currentParams ? Object.entries(status.currentParams) : [];
  const currentParams = paramEntries.length
    ? `\nCurrent params: ${paramEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
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
  const properties = formatProperties(status.properties);
  const bbox = status.boundingBox
    ? `\nBounding box: ${status.boundingBox.x} x ${status.boundingBox.y} x ${status.boundingBox.z} mm`
    : "";
  const material = status.material
    ? `\nMaterial: ${status.material.name ? status.material.name + ", " : ""}density ${status.material.density} g/cm³`
    : "";
  const headline = geomInvalid ? "Render COMPLETED WITH GEOMETRY ERRORS" : "Render SUCCESS";
  if (geomInvalid) {
    // Hoist the warnings block above stats so the structural problem is the
    // first thing the reader sees, not an otherwise-normal-looking summary.
    return `${headline}\nFile: ${status.fileName || "unknown"}${warnings}\nStats: ${status.stats}${parts}${bbox}${material}${properties}${currentParams}${timings}\nTime: ${status.timestamp}${SHAPEITUP_VERSION_TAG}`;
  }
  return `${headline}\nFile: ${status.fileName || "unknown"}\nStats: ${status.stats}${parts}${bbox}${material}${properties}${currentParams}${timings}${warnings}\nTime: ${status.timestamp}${SHAPEITUP_VERSION_TAG}`;
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
 * Pure syntax + pitfall validator. Extracted from the `validate_syntax` /
 * `validate_script` MCP tools so unit tests can call it directly without
 * spinning up an MCP server. Returns the same text the tools emit, plus a
 * boolean signalling "hard parse failure" (so the caller can set isError on
 * the MCP envelope).
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
        if (!isFinite(r) || r <= 0) continue;
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

    // 6. .fuse(/.cut( inside a for-loop body — classic "slow pattern".
    //    Walk the raw code, track brace depth from the `for (...)` header
    //    to the matching `}`, and flag fuse/cut within.
    const forPattern = /\bfor\s*\([^)]*\)\s*\{/g;
    let forMatch: RegExpExecArray | null;
    let loopBoolSuggested = false;
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
      if (/\.\s*(fuse|cut)\s*\(/.test(body)) {
        loopBoolSuggested = true;
        break;
      }
    }
    if (loopBoolSuggested) {
      semanticWarnings.push(
        "Multiple 3D `fuse`/`cut` inside a loop is slow — consider combining in 2D first (with `drawing.fuse()` / `drawing.cut()`) then a single `.extrude()` at the end. See the `booleans` category in get_api_reference."
      );
    }

    // 7. `return positioned` without `.entries()`. In multi-part assemblies
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
 */
async function executeWithPersistedParams(
  absPath: string,
  callOverrides?: Record<string, number>,
): ReturnType<typeof executeShapeFile> {
  const merged = mergeSidecarOverrides(absPath, callOverrides);
  return executeShapeFile(absPath, GLOBAL_STORAGE, merged);
}

export function registerTools(server: McpServer) {
  server.tool(
    "create_shape",
    "Create a new .shape.ts CAD script file and execute it. Fails if file already exists — use modify_shape to update existing files. Path resolution precedence: absolute `directory` used as-is; relative `directory` probed against each heartbeat-reported VSCode workspace root (first match wins), else `process.cwd()`; omitted `directory` defaults to the first active VSCode workspace root (or cwd if no extension is running).",
    {
      name: z.string().describe("File name without extension (e.g., 'bracket')"),
      code: z.string().describe("TypeScript source code using Replicad API"),
      directory: z.string().optional().describe("Directory to create the file in. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first match wins), falling back to process.cwd(). When omitted, defaults to the active VSCode workspace root."),
      overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file (default: false)"),
    },
    safeHandler("create_shape", async ({ name, code, directory, overwrite }) => {
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
      const doubledWarning = directory ? detectPathDoubling(dir) : "";
      const actionWord = contentIdenticalNoOp
        ? "Unchanged (content-identical re-create)"
        : overwrite ? "Overwrote" : "Created";
      const prefix = `${actionWord} ${filePath}${cwdNote}${doubledWarning}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status) }],
        isError: !status.success,
      };
    })
  );

  server.tool(
    "open_shape",
    "Execute an existing .shape.ts file and (if VSCode is open) also bring it up in the viewer. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd().",
    {
      filePath: z.string().describe("Path to the .shape.ts file to execute. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
    },
    safeHandler("open_shape", async ({ filePath }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }

      const { status } = await executeWithPersistedParams(absPath);
      notifyExtensionOfShape(absPath);

      return {
        content: [{ type: "text" as const, text: formatStatusText(status) }],
        isError: !status.success,
      };
    })
  );

  server.tool(
    "modify_shape",
    "Overwrite an existing .shape.ts file with new code and execute it. Relative paths probe each open VSCode workspace (first match wins), else fall back to process.cwd().",
    {
      filePath: z.string().describe("Path to the .shape.ts file. Absolute paths pass through; relative paths are resolved by probing each heartbeat-reported VSCode workspace root (first existing match wins), else anchored to process.cwd()."),
      code: z.string().describe("New TypeScript source code"),
    },
    safeHandler("modify_shape", async ({ filePath, code }) => {
      const absPath = resolveShapePath(filePath);
      if (!existsSync(absPath)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${absPath}` }],
          isError: true,
        };
      }
      writeFileSync(absPath, code, "utf-8");

      const { status } = await executeWithPersistedParams(absPath);
      notifyExtensionOfShape(absPath);

      const prefix = `Updated ${absPath}\n`;
      return {
        content: [{ type: "text" as const, text: prefix + formatStatusText(status) }],
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
    "Export the last executed shape to STEP or STL. Optionally pass `filePath` to execute and export a specific file in one call. For multi-part assemblies, pass `partName` to export a single named part instead of the whole assembly.",
    {
      format: z.enum(["step", "stl"]).describe("'step' for CNC/manufacturing or CAD, 'stl' for 3D printing"),
      outputPath: z.string().optional().describe("Output file path. Auto-derived from the source .shape.ts filename if omitted."),
      filePath: z.string().optional().describe("Optional .shape.ts path to execute first. Defaults to the last-executed shape."),
      partName: z.string().optional().describe("For multi-part assemblies: export only the part whose name matches exactly (e.g., 'bolt'). If omitted, the full assembly is exported."),
      openIn: z
        .enum(["prusaslicer", "cura", "bambustudio", "orcaslicer", "freecad", "fusion360"])
        .optional()
        .describe("If set, open the exported file in this app after saving. Requires VSCode + the extension."),
    },
    safeHandler("export_shape", async ({ format, outputPath, filePath, partName, openIn }) => {
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
      // OCCT state between the last render and now.
      const { status } = await executeWithPersistedParams(source);
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

      return {
        content: [{ type: "text" as const, text: `Exported to: ${savePath}\nFormat: ${format.toUpperCase()}\nSize: ${sizeStr}\nSource: ${source}${contentsLine}${openLine}${multiPartWarning}` }],
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

  // Shared implementation for validate_syntax (and backward-compat alias validate_script).
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
    "Validate TypeScript syntax and detect 6 common CAD pitfalls (sketch mischain, missing sketchOnPlane, unclosed pen, non-uniform scale, oversized fillet, booleans in loop). Does NOT verify imports, types, or runtime behavior — for that, call create_shape or modify_shape.",
    validateSyntaxSchema,
    safeHandler("validate_syntax", validateSyntaxImpl)
  );

  // Backward-compat alias — kept so existing MCP clients calling validate_script continue to work.
  // Deprecated: prefer validate_syntax.
  server.tool(
    "validate_script",
    "[Deprecated — use validate_syntax] Validate TypeScript syntax and detect 6 common CAD pitfalls. Does NOT verify imports, types, or runtime behavior.",
    validateSyntaxSchema,
    safeHandler("validate_script", validateSyntaxImpl)
  );

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
              const result = await waitForResult(cmdId, 60_000);
              if (!result) {
                const reason = lastWaitTimeoutReason === "slow"
                  ? "extension is alive but render exceeded 60s"
                  : "extension stopped responding";
                screenshotWarning = `\n(Screenshot skipped: ${reason}.)`;
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
    "Capture a PNG screenshot of the current shape. Requires VSCode + the ShapeItUp extension to be running (the extension renders via its webview, which works regardless of window size — the canvas is temporarily resized to the requested resolution). Preview PNGs are written to `{workspace}/shapeitup-previews/` — Read the returned absolute path to view the image. For headless verification without VSCode, use get_render_status which returns volume, surface area, center of mass, and bounding box. Pass `finder` to paint pink highlight spheres on the matched edges/faces in the screenshot (for just a text match count with no PNG, use `preview_finder`). Pass `meshQuality: 'preview'` to speed up first-render on large assemblies at the cost of coarser facets; defaults to auto-degrade (preview for 15+ parts, final otherwise).",
    {
      filePath: z.string().optional().describe("Optional .shape.ts to execute first. Defaults to the last-executed shape."),
      cameraAngle: z
        .enum(["isometric", "top", "bottom", "front", "right", "back", "left"])
        .optional()
        .describe("Camera angle preset (default: 'isometric')"),
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
      inline: z.boolean().optional().describe("When true, also returns the rendered PNG inline as base64 image content on top of the usual text + file path — saves an extra `get_preview` round trip. The PNG is still written to disk. Skipped inline if the file exceeds 10 MB. Default false."),
    },
    safeHandler("render_preview", async ({ filePath, cameraAngle, showDimensions, showAxes, renderMode, width, height, timeoutMs, focusPart, hideParts, finder, partName, partIndex, meshQuality, inline }) => {
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
        return {
          content: [{
            type: "text" as const,
            text: `render_preview requires the VSCode extension to be running. Open VSCode with the ShapeItUp extension and retry.\n\nFor headless verification, use get_render_status — it returns volume, surface area, center of mass, and bounding box without needing a screenshot.`,
          }],
          isError: true,
        };
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
        const { status: preStatus, parts } = await executeWithPersistedParams(source);
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
      const angleForName = cameraAngle || "isometric";
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
          cameraAngle: cameraAngle || "isometric",
          width: width || 1280,
          height: height || 960,
          focusPart,
          hideParts,
          // P3-10: forward the user's quality preference (undefined → the
          // core auto-degrades based on part count).
          meshQuality,
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
          return {
            content: [{ type: "text" as const, text: `Screenshot failed: ${result.error}` }],
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
            statusText = `\nStats: ${status.stats}${formatProperties(status.properties)}`;
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
            const angle = cameraAngle || "isometric";
            const renamedPath = join(dirname(screenshotPath), `shapeitup-preview-${userBase}-finder-${angle}.png`);
            if (renamedPath !== screenshotPath) {
              renameSync(screenshotPath, renamedPath);
              screenshotPath = renamedPath;
            }
          } catch {
            // keep raw screenshotPath
          }
        }

        const finderLine = finder !== undefined && finder.trim().length > 0
          ? `\nFinder: ${finder}${finderAppliedLine}${finderWarnLine}`
          : "";

        const textBlock = {
          type: "text" as const,
          text: `Screenshot saved to: ${screenshotPath}\nRender mode: ${renderMode || "ai"}, Camera: ${cameraAngle || "isometric"}, Axes: ${showAxes !== false ? "ON" : "OFF"}, Size: ${width || 1280}x${height || 960}\nFile: ${source}${partsLine}${partWarnLine}${finderLine}${statusText}\nUse the Read tool to view this image. Or call the \`get_preview\` MCP tool to receive the PNG data inline without needing filesystem access.`,
        };

        // Bug #8: when inline is requested, read the PNG off disk and append
        // it as an image content block so the caller gets bytes + path in a
        // single round trip. Mirrors get_preview's 10 MB size guard to avoid
        // blowing past MCP response limits.
        if (inline === true) {
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
      if (!existsSync(statusFile)) {
        return {
          content: [{ type: "text" as const, text: "No render status available. Call create_shape, open_shape, or modify_shape first." }],
        };
      }
      try {
        const status: EngineStatus = JSON.parse(readFileSync(statusFile, "utf-8"));
        return {
          content: [{ type: "text" as const, text: formatStatusText(status) }],
          // Render failures are an expected state, not tool errors.
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not read render status." }],
          isError: true,
        };
      }
    })
  );

  server.tool(
    "preview_finder",
    "Preview which edges/faces a Replicad EdgeFinder or FaceFinder matches on a shape — WITHOUT editing the user's script. Runs the given .shape.ts file (or an inline `code` snippet), applies the finder to the resulting shape, and reports how many entities matched plus their locations. `EdgeFinder` and `FaceFinder` are implicitly in scope — pass a plain TS finder expression (same DSL you'd use in a fillet/chamfer/shell call), e.g. `new EdgeFinder().inDirection(\"Z\")` or `new FaceFinder().inPlane(\"XY\", 10)`. Supports the full finder DSL: `.and`, `.or`, `.not`, `.inDirection`, `.inPlane`, `.ofLength`, `.containsPoint`, etc. If the VSCode extension is running, also renders the highlighted preview in the viewer (pink spheres at each match); otherwise just returns the text report. Pass either `filePath` (existing shape) or `code` (inline snippet) — they are mutually exclusive. Debugging a script that crashes BEFORE the finder target exists: pass a modified snippet via `code` with the failing op commented out or stubbed — the finder then runs against the shape at whatever earlier point you choose.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file whose shape the finder should be applied to. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first existing match wins), else anchor to process.cwd(). Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — must include an `export default` main() function returning a Shape3D or array of parts. Written to a throwaway temp file, executed, and deleted afterwards. Use `workingDir` to make local `./` imports resolve. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in when `code` is provided. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work)."),
      finder: z.string().describe("TS expression producing an EdgeFinder or FaceFinder, e.g. 'new EdgeFinder().inDirection(\"Z\").ofLength(l => l > 10)'"),
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

      // Step 1: execute the user's script to get the live OCCT parts.
      const { status, parts } = await executeWithPersistedParams(absPath);
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
    "Detects pairwise intersections between named parts in a multi-part assembly. AABB prefilter skips obviously-disjoint pairs; remaining pairs are tested with Replicad's 3D intersect (which can fail on complex curved solids — those pairs are reported as 'intersect failed' rather than silently ignored). Tolerance filters out numerical-noise contacts (default 0.001 mm³); very large assemblies (100+ parts) will be slow because work grows as N². Pass either `filePath` (existing shape) or `code` (inline snippet) — they are mutually exclusive.",
    {
      filePath: z.string().optional().describe("Path to the .shape.ts file to check for part collisions. Absolute paths pass through; relative paths probe each heartbeat-reported VSCode workspace root (first existing match wins), else anchor to process.cwd(). Mutually exclusive with `code`."),
      code: z.string().optional().describe("Inline .shape.ts source — must include an `export default` main() function returning an array of parts. Written to a throwaway temp file, executed, and deleted afterwards. Use `workingDir` to make local `./` imports resolve. Mutually exclusive with `filePath`."),
      workingDir: z.string().optional().describe("Directory to write the temp snippet file in when `code` is provided. When set, relative imports (`./foo.shape`) resolve against this directory. Defaults to a private globalStorage path (isolated; relative imports won't work)."),
      tolerance: z.number().optional().describe("Minimum intersection volume in mm³ to count as a collision. Defaults to 0.001 — filters out numerical-noise overlaps on touching-but-not-overlapping parts. Negative values are clamped to 0."),
    },
    safeHandler("check_collisions", async ({ filePath, code, workingDir, tolerance }) => {
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
      // error hint (fillet too large, wire not closed, etc.).
      const { status, parts } = await executeWithPersistedParams(absPath);
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

      const collisions: Array<{ a: string; b: string; volume: number }> = [];
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
            let volProps: any = null;
            try {
              volProps = measureVol?.(overlapShape);
              if (volProps && typeof volProps.volume === "number") {
                volume = volProps.volume;
              }
            } catch (e: any) {
              failures.push({ a: labelFor(i), b: labelFor(j), error: `volume measurement failed: ${e?.message ?? e}` });
              continue;
            } finally {
              try { volProps?.delete?.(); } catch {}
            }

            if (volume > tol) {
              collisions.push({ a: labelFor(i), b: labelFor(j), volume });
            }
          } finally {
            // CRITICAL: always delete the overlap solid, even on measurement
            // failure, to avoid leaking WASM handles.
            try { overlapShape?.delete?.(); } catch {}
          }
        }
      }

      // Step 5: format the summary.
      const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
      const pairWord = (n: number) => `${n} pair${n === 1 ? "" : "s"}`;

      // Full pair accounting — always show total/skipped/tested so callers
      // never see a bare "1 pair" and wonder where the other 5 went. Bug #3:
      // for a 4-part assembly where 5 of 6 pairs are AABB-prefiltered, the
      // previous "all 1 tested pair clear" phrasing made the tool look broken.
      const accounting: string[] = [
        `Checked ${parts.length} parts \u2192 ${pairWord(totalPairs)} total.`,
      ];
      if (skippedByAABB > 0) {
        accounting.push(`  - ${pairWord(skippedByAABB)} skipped by AABB prefilter (non-overlapping bounding boxes).`);
      }
      if (tested > 0) {
        const testedSuffix = collisions.length === 0 && failures.length === 0
          ? " \u2014 all clear"
          : "";
        accounting.push(`  - ${pairWord(tested)} tested for 3D intersection${testedSuffix}.`);
      }

      const sections: string[] = [accounting.join("\n")];

      if (collisions.length > 0) {
        const lines = collisions.map((c) => `  - ${c.a} \u2194 ${c.b}: ${fmt(c.volume)} mm\u00b3 overlap`);
        sections.push(`\nCollisions:\n${lines.join("\n")}`);
      }

      if (failures.length > 0) {
        const lines = failures.map((f) => `  - ${f.a} \u2194 ${f.b}: ${f.error}`);
        sections.push(`\nIntersect failures (retry with mold-cut or report to developer):\n${lines.join("\n")}`);
      }

      if (degenerateWarnings.length > 0) {
        sections.push(`\nWarnings:\n${degenerateWarnings.join("\n")}`);
      }

      // All-clear footer when nothing collided, nothing failed, and at least
      // one pair was actually tested (otherwise the AABB prefilter skipped
      // everything and "no collisions detected" would be misleading).
      if (collisions.length === 0 && failures.length === 0 && skippedByAABB < totalPairs) {
        sections.push(`\nNo collisions detected.`);
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

        // Step 1: execute the user's script.
        const { status, parts } = await executeWithPersistedParams(absPath);
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

function formatProperties(props: ShapeProperties | undefined): string {
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
    for (const p of props.parts) {
      const bits: string[] = [];
      if (typeof p.volume === "number") bits.push(`V=${fmt(p.volume)}mm³`);
      if (typeof p.surfaceArea === "number") bits.push(`A=${fmt(p.surfaceArea)}mm²`);
      if (typeof p.mass === "number") bits.push(`mass=${fmt(p.mass)}g`);
      if (p.centerOfMass) bits.push(`CoM=${fmtPt(p.centerOfMass)}`);
      if (p.boundingBox) bits.push(`bbox=${fmt(p.boundingBox.x)}x${fmt(p.boundingBox.y)}x${fmt(p.boundingBox.z)}`);
      if (bits.length) lines.push(`  - ${p.name}: ${bits.join(", ")}`);
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
  const sigWithReturn = /^\.?[A-Za-z_][\w.]*\s*\(([^()]|\([^()]*\))*\)\s*(?:→|=>|:)\s*\S/;
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
      if (isTopLevelDeclaration(line)) {
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
import { holes, screws, bolts, washers, inserts, bearings, extrusions, patterns, printHints, motors, couplers, threads, fromBack, shape3d, part, faceAt, shaftAt, boreAt, mate, assemble, subassembly, stackOnZ, entries, debugJoints, highlightJoints, cylinder, standards } from "shapeitup";
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
holes.teardrop(size, { depth, axis? })                     // horizontal hole, FDM-printable (axis: "+X"|"+Y")
holes.keyhole({ largeD, smallD, slot, depth, axis? })      // hang-on-screw mount
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
| \`faceAt(z)\` | \`"face"\` | \`"+Z"\` |
| \`shaftAt(z, diameter)\` | \`"male"\` | \`"+Z"\` |
| \`boreAt(z, diameter)\` | \`"female"\` | \`"-Z"\` |

Pass \`{ axis: "-Z" }\` (or any other) to override the default.

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

Real helical threads via OCCT sweep. Mostly useful for STEP export,
visual fidelity, and large printable threads (jar lids, leadscrews, M8+).
**Small threads (M2–M5) don't survive FDM printing reliably** — use
\`inserts.pocket\` + heat-set inserts instead.

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
