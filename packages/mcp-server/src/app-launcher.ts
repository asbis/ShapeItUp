/**
 * App launcher — ports the extension's `open-in-app.ts` subprocess-spawn
 * logic into the MCP server so `export_shape(openIn: ...)` can launch the
 * external app directly without involving VSCode. Pure Node built-ins; no
 * vscode / extension-host coupling.
 *
 * Exported as a small, testable API:
 *   - buildLaunchArgs(app, filePath, mode) — pure function, used by tests
 *   - openFileInApp(filePath, app, { mode, spawn? }) — spawns the child
 *     process detached. The `spawn` option is a hook for tests to stub
 *     child_process without mocking the module.
 */
import { spawn as realSpawn, type ChildProcess } from "child_process";
import type { AppId, DetectedApp } from "@shapeitup/shared";

export type LaunchMode = "reuse" | "new";

/**
 * Per-app CLI flag that makes the app hand a newly-spawned file off to an
 * already-running instance instead of starting a second window. Currently
 * only Cura documents this; other slicers already reuse their window by
 * default.
 */
const SINGLE_INSTANCE_FLAG: Partial<Record<AppId, string>> = {
  cura: "--single-instance",
};

export function buildLaunchArgs(
  app: DetectedApp,
  filePath: string,
  mode: LaunchMode,
): string[] {
  const flag = SINGLE_INSTANCE_FLAG[app.id];
  if (mode === "reuse" && flag) return [flag, filePath];
  return [filePath];
}

export interface OpenFileInAppOptions {
  mode?: LaunchMode;
  /**
   * Hook for tests — receives the same (command, args, options) as the real
   * `child_process.spawn`. Default: the real spawn().
   */
  spawn?: typeof realSpawn;
}

export interface OpenFileInAppResult {
  launched: boolean;
  command?: string;
  args?: string[];
  urlScheme?: string;
  error?: string;
}

/**
 * Launch `app` with `filePath`. Returns a result object describing what was
 * launched — callers can surface the command line in a diagnostic message
 * without re-deriving it.
 *
 * Fire-and-forget: the spawn is detached + unref'd so the child outlives the
 * MCP server. Errors are returned in the result (not thrown) so the caller
 * can decide whether to fail the whole export or just report a warning.
 *
 * URL-scheme apps (Fusion 360) can't be launched by the MCP server directly
 * without a user session — we report `launched: false` with a URL the caller
 * can surface to the agent. Historically that case was routed through VSCode
 * via `vscode.env.openExternal`; the standalone MCP path leaves it to the
 * user to click.
 */
export function openFileInApp(
  filePath: string,
  app: DetectedApp,
  opts: OpenFileInAppOptions = {},
): OpenFileInAppResult {
  const mode: LaunchMode = opts.mode ?? "reuse";
  const spawn = opts.spawn ?? realSpawn;

  if (app.urlScheme) {
    const url = app.urlScheme.replace("%FILE%", encodeURIComponent(filePath));
    return {
      launched: false,
      urlScheme: url,
      error:
        `${app.name} uses a URL scheme (${url}) — the standalone MCP server cannot open URL handlers directly. ` +
        `Click the URL, or open ${app.name} manually and load ${filePath}.`,
    };
  }

  if (!app.execPath) {
    return {
      launched: false,
      error: `${app.name} has neither an exec path nor a URL scheme`,
    };
  }

  const args = buildLaunchArgs(app, filePath, mode);

  let child: ChildProcess;
  try {
    child = spawn(app.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (e: any) {
    return {
      launched: false,
      command: app.execPath,
      args,
      error: e?.message ?? String(e),
    };
  }

  // Detach so the child outlives the MCP server process.
  try { child.unref(); } catch {}

  // 'error' events fire asynchronously if the executable can't be found. We
  // can't surface them synchronously here, but we can log to stderr so the
  // MCP server's debug log at least has a breadcrumb.
  child.on?.("error", (err) => {
    process.stderr.write(
      `[shapeitup-mcp] app-launcher: ${app.name} spawn error: ${err?.message ?? err}\n`,
    );
  });

  return {
    launched: true,
    command: app.execPath,
    args,
  };
}
