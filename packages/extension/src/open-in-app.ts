import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn } from "child_process";
import type { DetectedApp, AppId } from "./app-detector";
import { getDetectedApps } from "./app-detector";
import type { ViewerProvider } from "./viewer-provider";

export type LaunchMode = "reuse" | "new";

/**
 * Per-app CLI flag that makes the app hand a newly-spawned file off to an
 * already-running instance instead of starting a second window.
 * Currently only Cura documents this; the slicers based on Slic3r (PrusaSlicer,
 * Bambu Studio, OrcaSlicer) already reuse their window by default.
 */
const SINGLE_INSTANCE_FLAG: Partial<Record<AppId, string>> = {
  cura: "--single-instance",
};

function buildLaunchArgs(
  app: DetectedApp,
  filePath: string,
  mode: LaunchMode
): string[] {
  const flag = SINGLE_INSTANCE_FLAG[app.id];
  if (mode === "reuse" && flag) return [flag, filePath];
  return [filePath];
}

export async function openFileInApp(
  filePath: string,
  app: DetectedApp,
  output: vscode.OutputChannel,
  mode: LaunchMode = "reuse"
): Promise<void> {
  if (app.urlScheme) {
    const url = app.urlScheme.replace("%FILE%", encodeURIComponent(filePath));
    output.appendLine(`[open-in] ${app.name}: ${url}`);
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return;
  }

  if (!app.execPath) {
    throw new Error(`${app.name} has neither an exec path nor a URL scheme`);
  }

  const args = buildLaunchArgs(app, filePath, mode);
  output.appendLine(`[open-in] ${app.name}: spawn ${app.execPath} ${args.map((a) => `"${a}"`).join(" ")}`);
  const child = spawn(app.execPath, args, {
    detached: true,
    stdio: "ignore",
    // On Windows, don't create a console window for the spawned GUI app.
    windowsHide: true,
  });
  // Detach so the child outlives the VS Code extension host.
  child.unref();
  // The spawn itself is sync enough to return; errors surface via the 'error' event.
  child.on("error", (err) => {
    output.appendLine(`[open-in] ${app.name} spawn error: ${err.message}`);
    vscode.window.showErrorMessage(`ShapeItUp: failed to launch ${app.name}: ${err.message}`);
  });
}

/**
 * Decide whether to reuse an existing app window or open a new one.
 *
 * - Apps without a single-instance flag always use "reuse" (it's a no-op for them).
 * - If the user already answered the prompt for this app, use the stored value.
 * - In interactive mode, prompt with a QuickPick and persist the answer.
 * - In non-interactive mode (e.g., MCP without a stored pref), default to "reuse".
 */
export async function resolveLaunchMode(
  app: DetectedApp,
  context: vscode.ExtensionContext,
  interactive: boolean
): Promise<LaunchMode> {
  if (!SINGLE_INSTANCE_FLAG[app.id]) return "reuse";

  const storageKey = `shapeitup.launchMode.${app.id}`;
  const stored = context.globalState.get<LaunchMode>(storageKey);
  if (stored === "reuse" || stored === "new") return stored;

  if (!interactive) return "reuse";

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `Reuse existing ${app.name} window`,
        description: "Add this export to the currently open session",
        value: "reuse" as LaunchMode,
      },
      {
        label: `Always open a new ${app.name} window`,
        description: "Start a fresh instance each time",
        value: "new" as LaunchMode,
      },
    ],
    {
      placeHolder: `How should ShapeItUp launch ${app.name}?`,
      ignoreFocusOut: true,
    }
  );

  const choice: LaunchMode = picked?.value ?? "reuse";
  await context.globalState.update(storageKey, choice);
  return choice;
}

export async function resetLaunchPrefs(context: vscode.ExtensionContext) {
  for (const id of Object.keys(SINGLE_INSTANCE_FLAG) as AppId[]) {
    await context.globalState.update(`shapeitup.launchMode.${id}`, undefined);
  }
}

/**
 * Export the currently rendered shape and launch it in the chosen app.
 *
 * The output file is written next to the active .shape.ts file (if any), else
 * into the extension's global storage. Returns the exported path, or undefined
 * on failure.
 */
export async function exportAndOpen(
  viewer: ViewerProvider,
  app: DetectedApp,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  opts: { interactive?: boolean } = {}
): Promise<string | undefined> {
  const format = app.preferredFormat;
  const data = await viewer.requestExport(format);
  if (!data) {
    vscode.window.showErrorMessage(
      "ShapeItUp: No shape to export. Preview a .shape.ts file first."
    );
    return undefined;
  }

  const exportPath = chooseExportPath(format, context);
  try {
    fs.mkdirSync(path.dirname(exportPath), { recursive: true });
    fs.writeFileSync(exportPath, new Uint8Array(data));
  } catch (e: any) {
    vscode.window.showErrorMessage(`ShapeItUp: failed to write ${exportPath}: ${e.message}`);
    return undefined;
  }

  const mode = await resolveLaunchMode(app, context, opts.interactive ?? true);
  await openFileInApp(exportPath, app, output, mode);
  vscode.window.showInformationMessage(
    `ShapeItUp: Exported ${format.toUpperCase()} → ${app.name}`
  );
  return exportPath;
}

function chooseExportPath(
  format: "step" | "stl",
  context: vscode.ExtensionContext
): string {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (active && active.endsWith(".shape.ts")) {
    return active.replace(/\.shape\.ts$/, `.${format}`);
  }
  return path.join(context.globalStorageUri.fsPath, `export.${format}`);
}

export function findAppById(id: AppId): DetectedApp | undefined {
  return getDetectedApps().find((a) => a.id === id);
}
