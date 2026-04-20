import * as vscode from "vscode";
import * as path from "path";
import { ViewerProvider } from "./viewer-provider";
import { registerCommands } from "./commands";
import { createFileWatcher } from "./file-watcher";
import { getDetectedApps, getDetectedAppsAsync, warmAppCache, type AppId } from "./app-detector";
import { exportAndOpen, findAppById, openFileInApp, resolveLaunchMode } from "./open-in-app";
import {
  installStub,
  workspaceHasReplicadDependency,
  ensureMinimalTsconfig,
} from "./workspace-types";

let viewerProvider: ViewerProvider;
export const outputChannel = vscode.window.createOutputChannel("ShapeItUp");

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine("ShapeItUp activating...");
  viewerProvider = new ViewerProvider(context, outputChannel);

  // Kick off installed-app detection now so the first MCP call hits a warm
  // cache. Windows fs scans + the Fusion reg query can take a few seconds
  // together — doing it here offloads that from the MCP request path.
  warmAppCache();

  // Register as a panel view (appears in the bottom panel area)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "shapeitup.viewer",
      viewerProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  registerCommands(context, viewerProvider);
  createFileWatcher(context, viewerProvider);

  // Register MCP server via VS Code's native provider API. This gives
  // Copilot / Agent Mode zero-click access. We no longer silently write to
  // ~/.claude.json, ~/.claude/skills/, or ~/.gemini/ on activation — those
  // global writes broke user config on extension upgrades and violated consent.
  // Users opt in via the `shapeitup.installMcpServer` command / walkthrough.
  registerMcpServerForCopilot(context, outputChannel);

  // Install lightweight node_modules stubs so `import from "shapeitup"` and
  // `import from "replicad"` resolve from ANY `.shape.ts` — including files
  // nested in arbitrary subfolders, which the older paths-based tsconfig
  // couldn't cover. Cheap no-op for workspaces with no .shape.ts files.
  ensureWorkspaceTypes(context, outputChannel).catch((e) => {
    outputChannel.appendLine(`[types] ensureWorkspaceTypes failed: ${e?.message ?? e}`);
  });

  // Consent-based install command for Claude Code / Cursor / Claude Desktop /
  // Gemini CLI. Surfaces the one-shot AI install prompt that users can paste
  // into any agentic CLI.
  context.subscriptions.push(
    vscode.commands.registerCommand("shapeitup.installMcpServer", () =>
      showMcpInstallOptions(context, outputChannel),
    ),
    vscode.commands.registerCommand("shapeitup.uninstallMcpServer", () =>
      uninstallMcpServer(outputChannel),
    ),
  );

  // Manual preview command (still useful for opening the panel tab)
  context.subscriptions.push(
    vscode.commands.registerCommand("shapeitup.preview", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.endsWith(".shape.ts")) {
        vscode.window.showWarningMessage(
          "Open a .shape.ts file to preview it."
        );
        return;
      }
      viewerProvider.executeScript(editor.document);
    })
  );

  // Auto-preview when switching to a .shape.ts file (debounced, deduplicated)
  let autoPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPreviewedFile = "";
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.fileName.endsWith(".shape.ts")) {
        const fileName = editor.document.fileName;

        // Skip if same file already previewed (avoid spam on panel focus changes)
        if (fileName === lastPreviewedFile) return;

        if (autoPreviewTimer) clearTimeout(autoPreviewTimer);
        autoPreviewTimer = setTimeout(() => {
          lastPreviewedFile = fileName;
          outputChannel.appendLine(`[auto] Switched to ${fileName}`);
          viewerProvider.executeScript(editor.document);
        }, 500);
      }
    })
  );

  // Re-preview on save (even if same file)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.fileName.endsWith(".shape.ts")) {
        lastPreviewedFile = ""; // allow re-render
        viewerProvider.executeScript(doc);
      }
    })
  );

  // Also auto-preview the currently open file on activation
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.fileName.endsWith(".shape.ts")) {
    viewerProvider.executeScript(activeEditor.document);
  }

  // AI-facing commands (triggered by MCP server via command files)
  context.subscriptions.push(
    vscode.commands.registerCommand("shapeitup.screenshot", async () => {
      const filePath = await viewerProvider.captureScreenshot();
      if (filePath) {
        outputChannel.appendLine(`[ai] Screenshot: ${filePath}`);
      }
    }),
    vscode.commands.registerCommand("shapeitup.setRenderMode", (mode: string) => {
      viewerProvider.sendViewerCommand("set-render-mode", { mode });
      outputChannel.appendLine(`[ai] Render mode: ${mode}`);
    }),
    vscode.commands.registerCommand("shapeitup.toggleDimensions", (show?: boolean) => {
      viewerProvider.sendViewerCommand("toggle-dimensions", { show });
      outputChannel.appendLine(`[ai] Dimensions: ${show}`);
    })
  );

  // Heartbeat so the MCP server can detect if no extension is running and
  // fail fast instead of blocking for 10–30s. Written every 2s.
  //
  // Multi-window cross-talk fix: each window writes a per-pid heartbeat
  // (`shapeitup-heartbeat-<pid>.json`) so the MCP server can enumerate every
  // live window and pick the ONE whose workspace actually owns a given file.
  // The legacy `shapeitup-heartbeat.json` is still written (last-write-wins
  // across windows) for back-compat with older MCP binaries that only know
  // about the single-file form.
  {
    const fs = require("fs");
    const legacyHbPath = path.join(context.globalStorageUri.fsPath, "shapeitup-heartbeat.json");
    const pidHbPath = path.join(context.globalStorageUri.fsPath, `shapeitup-heartbeat-${process.pid}.json`);
    const writeHb = () => {
      try {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        // Include workspaceRoots so the MCP server (whose process.cwd() is the
        // extension's install dir, not the user's workspace) can default
        // create_shape / list_shapes to the right place. See tools.ts
        // getDefaultDirectory().
        const workspaceRoots =
          vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
        const payload = JSON.stringify({ timestamp: Date.now(), pid: process.pid, workspaceRoots });
        fs.writeFileSync(pidHbPath, payload);
        fs.writeFileSync(legacyHbPath, payload);
      } catch {}
    };
    writeHb();
    const hbInterval = setInterval(writeHb, 2000);
    context.subscriptions.push({
      dispose: () => {
        clearInterval(hbInterval);
        // Clean up our own pid file on deactivation so stale heartbeats don't
        // confuse the MCP server next time it starts.
        try { fs.unlinkSync(pidHbPath); } catch {}
      },
    });
  }

  // Watch for MCP command files (allows MCP server to trigger extension actions)
  const commandFile = path.join(context.globalStorageUri.fsPath, "mcp-command.json");
  const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
  const claimDir = path.join(context.globalStorageUri.fsPath, "mcp-claims");
  try {
    require("fs").mkdirSync(claimDir, { recursive: true });
  } catch {}
  const seenCommandIds = new Set<string>();
  const writeResult = async (id: string | undefined, payload: Record<string, any>) => {
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(resultFile),
        Buffer.from(JSON.stringify({ _id: id, ...payload }), "utf-8")
      );
    } catch {}
  };

  // Cross-window arbitration: every VSCode window with the extension watches
  // the same globalStorage command file. Without a claim, both windows race
  // and the wrong one's viewer can screenshot stale geometry under the right
  // filename (the cross-workspace render_preview bug). Whichever window first
  // creates `<id>.lock` services the command; losers return silently.
  //
  // Two layers of gating:
  //
  // 1. EXPLICIT targetWorkspaceRoot (preferred, new). The MCP server reads all
  //    per-pid heartbeats, picks the single workspace that owns cmd.filePath,
  //    and embeds `targetWorkspaceRoot`. Windows whose workspace folders don't
  //    include that root drop out IMMEDIATELY — no lock race, no side effects.
  //    This eliminates the multi-window cross-talk bug where a non-owning
  //    window's viewer would still process the command's side effects because
  //    it happened to be priority 1 in the legacy arbitration.
  //
  // 2. FALLBACK priority-based arbitration (legacy, for older MCP clients that
  //    don't supply targetWorkspaceRoot):
  //      priority 0 — file is in this window's workspace (claim immediately)
  //      priority 1 — no filePath OR no workspace folders (neutral)
  //      priority 2 — has workspaces but file is outside all of them (skip)
  const isWorkspaceMatch = (root: string): boolean => {
    const normalized = path.resolve(root).toLowerCase();
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    return wsFolders.some((ws) => {
      const wsRoot = path.resolve(ws.uri.fsPath).toLowerCase();
      return normalized === wsRoot;
    });
  };

  const arbitrate = async (id: string, cmd: any): Promise<boolean> => {
    const fs = require("fs");
    const wsFolders = vscode.workspace.workspaceFolders ?? [];

    // Layer 1: explicit targetWorkspaceRoot from MCP.
    //
    // When set, this window is ONLY allowed to handle the command if one of
    // its workspace folders matches the target. We still pass through the
    // lock race so two windows whose workspace folders both match the target
    // (pathological: same workspace opened twice) don't double-execute.
    // Windows whose folders don't match return false immediately — no race,
    // no viewer side effects.
    if (typeof cmd?.targetWorkspaceRoot === "string" && cmd.targetWorkspaceRoot.length > 0) {
      if (!isWorkspaceMatch(cmd.targetWorkspaceRoot)) {
        return false;
      }
      // Match — fall through to the lock race with priority 0 so we claim
      // immediately (no delay, no fallback bidding from other windows).
      const claimPath = path.join(claimDir, `${id}.lock`);
      try {
        fs.writeFileSync(claimPath, `${process.pid}\n0\n`, { flag: "wx" });
        setTimeout(() => {
          try { fs.unlinkSync(claimPath); } catch {}
        }, 60_000);
        return true;
      } catch {
        return false;
      }
    }

    // Layer 2: legacy priority-based arbitration.
    let priority = 1;
    if (cmd?.filePath && typeof cmd.filePath === "string" && wsFolders.length > 0) {
      const fp = path.resolve(cmd.filePath).toLowerCase();
      const inWs = wsFolders.some((ws) => {
        const root = path.resolve(ws.uri.fsPath).toLowerCase();
        return fp === root || fp.startsWith(root + path.sep);
      });
      priority = inWs ? 0 : 2;
    }
    // Bug #1(c) fix: if this window has workspaces but none of them owns
    // cmd.filePath, drop out of the race entirely instead of waiting and
    // potentially winning the claim (which would silently render into the
    // wrong workspace under a synthesized filename). A window that sees no
    // cmd.filePath OR has no workspace folders still participates as a
    // neutral bidder — that's the "lightweight MCP client" case.
    if (priority === 2) {
      return false;
    }
    if (priority > 0) {
      await new Promise((r) => setTimeout(r, priority * 150));
    }
    const claimPath = path.join(claimDir, `${id}.lock`);
    try {
      fs.writeFileSync(claimPath, `${process.pid}\n${priority}\n`, { flag: "wx" });
      // Best-effort GC so the claims dir doesn't grow without bound.
      setTimeout(() => {
        try { fs.unlinkSync(claimPath); } catch {}
      }, 60_000);
      return true;
    } catch {
      return false;
    }
  };

  // Serialize command processing: concurrent render/screenshot/export calls
  // race on webview state (pendingScreenshotResolve, render mode, camera) and
  // cause one to hang forever. A FIFO queue prevents this.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    queue = queue.then(fn, fn);
  };

  const commandWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, "mcp-command.json")
  );
  commandWatcher.onDidChange(async () => {
    let cmd: any;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(commandFile));
      cmd = JSON.parse(Buffer.from(data).toString("utf-8"));
    } catch {
      return;
    }

    // Dedup: file watcher double-fires on a single write. Use the _id written
    // by the MCP server (prefixed with pid+time so it's unique across restarts).
    const id: string | undefined = cmd?._id;
    if (id) {
      if (seenCommandIds.has(id)) return;
      seenCommandIds.add(id);
      // Bounded memory: only keep the last ~200 ids.
      if (seenCommandIds.size > 200) {
        const first = seenCommandIds.values().next().value;
        if (first) seenCommandIds.delete(first);
      }
    }

    enqueue(async () => {
      try {
        if (id) {
          const won = await arbitrate(id, cmd);
          if (!won) {
            // Another window owns this command — don't write a result, don't
            // log loudly (this is the normal case in multi-window setups).
            return;
          }
        }
        await handleCommand(cmd, id);
      } catch (e: any) {
        outputChannel.appendLine(`[ai] command error: ${e?.message ?? e}`);
        await writeResult(id, { error: String(e?.message ?? e) });
      }
    });
  });
  context.subscriptions.push(commandWatcher);

  async function handleCommand(cmd: any, id: string | undefined) {
    if (cmd.command === "open-shape") {
      outputChannel.appendLine(`[ai] Opening ${cmd.filePath}`);
      const doc = await vscode.workspace.openTextDocument(cmd.filePath);
      lastPreviewedFile = doc.fileName;
      await vscode.window.showTextDocument(doc, { preview: false });

      // Make sure the preview panel is open before dispatching the script —
      // agent workflows often run without any visible viewer, and executeScript
      // silently no-ops if there's no webview to receive it.
      await viewerProvider.ensureWebview();
      viewerProvider.executeScript(doc);

      const fs = require("fs");
      const statusPath = path.join(context.globalStorageUri.fsPath, "shapeitup-status.json");
      const startTime = Date.now();
      try { fs.unlinkSync(statusPath); } catch {}

      let renderDone = false;
      while (Date.now() - startTime < 8000) {
        await new Promise((r) => setTimeout(r, 100));
        if (fs.existsSync(statusPath)) {
          try {
            const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
            if (status.timestamp && new Date(status.timestamp).getTime() > startTime) {
              await writeResult(id, { renderStatus: status });
              renderDone = true;
              break;
            }
          } catch {}
        }
      }
      if (!renderDone) {
        await writeResult(id, {
          renderStatus: { success: false, error: "Render timed out after 8 seconds", fileName: cmd.filePath },
        });
      }
    } else if (cmd.command === "render-preview") {
      outputChannel.appendLine(`[ai] render-preview: file=${cmd.filePath || "<last>"} mode=${cmd.renderMode}, dims=${cmd.showDimensions}, axes=${!!cmd.showAxes}, camera=${cmd.cameraAngle || "isometric"}, size=${cmd.width || "auto"}x${cmd.height || "auto"}${cmd.meshQuality ? `, meshQuality=${cmd.meshQuality}` : ""}`);

      // P3-9 render-timeout diagnostic heartbeat. The MCP-side timeout fires
      // at 60s by default; past 30s we start heartbeating into the output
      // channel so a user chasing a pathological render sees *something* —
      // empty progress is the worst failure mode because there's nothing to
      // paste into a bug report. Cleared on every exit path (success, error,
      // unhandled throw); one heartbeat per 10s.
      const renderStartedAt = Date.now();
      const renderFile = cmd.filePath || "<last>";
      let heartbeatCount = 0;
      const heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - renderStartedAt;
        if (elapsedMs < 30_000) return; // wait until pathological
        heartbeatCount++;
        outputChannel.appendLine(
          `[ai] render-preview heartbeat: file=${renderFile} executionMs=${elapsedMs} ` +
            `beat=${heartbeatCount} — render has not completed yet. If this persists past 60s the MCP ` +
            `render_preview will time out; paste this line into the bug report.`
        );
      }, 10_000);

      const ready = await viewerProvider.ensureWebview();
      if (!ready) {
        clearInterval(heartbeat);
        await writeResult(id, { error: "Viewer webview could not be opened — the extension host may be unresponsive." });
        return;
      }

      // If MCP passed an explicit file path, make sure that's what's loaded in
      // the viewer before capturing. The engine in the MCP process already
      // renders in Node; we re-render here so the user's visible viewer shows
      // the same shape they're about to screenshot.
      //
      // Bug C: replace the status-file polling loop with an in-process
      // handshake. The old loop waited for `shapeitup-status.json.timestamp >
      // startTime`, but that file was already written by the MCP engine
      // BEFORE this handler even ran — the loop always timed out, then fell
      // through to a 500ms sleep and captured whatever was on screen (often
      // the PREVIOUS shape). Armed BEFORE executeScript dispatch so fast
      // renders can't beat us to the render-success message.
      if (cmd.filePath) {
        try {
          const doc = await vscode.workspace.openTextDocument(cmd.filePath);
          lastPreviewedFile = doc.fileName;
          // `cmd.params` (optional) is the ephemeral param override map set by
          // tune_params so the viewer re-renders the same configuration the
          // MCP engine just computed. Absent on normal render_preview calls.
          viewerProvider.armPendingRender();
          viewerProvider.executeScript(doc, cmd.params, cmd.meshQuality);
          try {
            await viewerProvider.awaitNextRender(8000);
          } catch (e: any) {
            outputChannel.appendLine(`[ai] render-preview: awaitNextRender failed — ${e?.message ?? e}`);
          }
        } catch (e: any) {
          outputChannel.appendLine(`[ai] render-preview: failed to load ${cmd.filePath}: ${e?.message ?? e}`);
        }
      }

      // Reset the per-part warning buffer before dispatching — any mismatches
      // for focusPart/hideParts reported by the viewer during this screenshot
      // call will land here and get surfaced to the MCP response.
      viewerProvider.resetPartWarnings();

      viewerProvider.sendViewerCommand("prepare-screenshot", {
        renderMode: cmd.renderMode || "ai",
        showDimensions: !!cmd.showDimensions,
        showAxes: !!cmd.showAxes,
        cameraAngle: cmd.cameraAngle || "isometric",
        focusPart: cmd.focusPart,
        hideParts: cmd.hideParts,
      });

      await new Promise((r) => setTimeout(r, 500));

      // Prefer a workspace-local dir so sandboxed agents can read the PNG with
      // a relative path; fall back to globalStorage when no workspace is open.
      // Note: avoid a dot-prefixed dir — AI agent tools (Claude Code / Gemini
      // CLI Read) hide dotfiles by default, which would break the
      // "render preview → read PNG → self-correct" loop.
      //
      // Bug #1/#12 fix: when MCP provides `cmd.outputPath`, honor it verbatim
      // — the MCP side knows the exact shape being rendered and which
      // workspace owns it, whereas this window's `workspaceFolders[0]` can
      // disagree with the owning workspace in multi-window setups. The old
      // synthesis path is preserved only as a fallback for legacy callers.
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let outputDir: string | undefined;
      let explicitOutputPath: string | undefined;
      if (typeof cmd.outputPath === "string" && cmd.outputPath.length > 0) {
        explicitOutputPath = cmd.outputPath;
        outputDir = path.dirname(cmd.outputPath);
        try {
          const fs = require("fs");
          fs.mkdirSync(outputDir, { recursive: true });
          const gitignorePath = path.join(outputDir, ".gitignore");
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, "*\n");
          }
        } catch {}
      } else if (wsRoot) {
        outputDir = path.join(wsRoot, "shapeitup-previews");
        try {
          const fs = require("fs");
          fs.mkdirSync(outputDir, { recursive: true });
          const gitignorePath = path.join(outputDir, ".gitignore");
          if (!fs.existsSync(gitignorePath)) {
            fs.writeFileSync(gitignorePath, "*\n");
          }
        } catch {}
      }

      const screenshotPath = await viewerProvider.captureScreenshot(
        outputDir,
        cmd.cameraAngle,
        cmd.width,
        cmd.height,
        explicitOutputPath
      );

      // Always restore user's dark mode + hide dimensions, even on failure.
      // Axes default to visible in the interactive viewer, so restore them at
      // default scale regardless of what the screenshot asked for.
      viewerProvider.sendViewerCommand("set-render-mode", { mode: "dark" });
      viewerProvider.sendViewerCommand("toggle-dimensions", { show: false });
      viewerProvider.sendViewerCommand("toggle-axes", { show: true, scaleToModel: false });
      // Unconditionally restore every part to visible — focusPart/hideParts
      // are transient for the screenshot and must not leak into the
      // interactive viewer's state.
      viewerProvider.sendViewerCommand("restore-part-visibility", {});

      const partWarnings = viewerProvider.drainPartWarnings();

      if (screenshotPath) {
        await writeResult(id, { screenshotPath, partWarnings });
        const displayPath =
          wsRoot && screenshotPath.startsWith(wsRoot)
            ? path.relative(wsRoot, screenshotPath).split(path.sep).join("/")
            : screenshotPath;
        outputChannel.appendLine(`[ai] Screenshot saved: ${displayPath}`);
      } else {
        // P3-9: final diagnostic line on screenshot failure. Paste-ready
        // for a bug report: file path + elapsed ms + heartbeat count make
        // it easy to distinguish "worker deadlocked" from "renderer crashed".
        const elapsedMs = Date.now() - renderStartedAt;
        outputChannel.appendLine(
          `[ai] render-preview timeout-diagnostic: file=${renderFile} executionMs=${elapsedMs} ` +
            `heartbeats=${heartbeatCount} — capture returned no path. ` +
            `Viewer webview may be closed, worker may have crashed, or OCCT is wedged.`
        );
        await writeResult(id, {
          error: "Screenshot capture timed out — the viewer webview may be closed or the worker may have crashed.",
          partWarnings,
        });
        outputChannel.appendLine("[ai] Screenshot failed (timeout)");
      }
      clearInterval(heartbeat);
    } else if (cmd.command === "screenshot") {
      const screenshotPath = await viewerProvider.captureScreenshot(cmd.outputDir);
      if (screenshotPath) {
        await writeResult(id, { screenshotPath });
      } else {
        await writeResult(id, { error: "Screenshot capture timed out" });
      }
    } else if (cmd.command === "export-shape") {
      outputChannel.appendLine(`[ai] Export: ${cmd.format} → ${cmd.outputPath || "dialog"}${cmd.openIn ? ` (open in ${cmd.openIn})` : ""}`);

      if (cmd.outputPath) {
        const data = await viewerProvider.requestExport(cmd.format);
        if (data) {
          const fs = require("fs");
          fs.writeFileSync(cmd.outputPath, Buffer.from(data));
          outputChannel.appendLine(`[ai] Exported to ${cmd.outputPath}`);

          // Optional: launch the exported file in the requested app.
          if (cmd.openIn) {
            const app = findAppById(cmd.openIn as AppId);
            if (!app) {
              await writeResult(id, {
                exportPath: cmd.outputPath,
                openInError: `${cmd.openIn} is not installed or was not detected. Run list_installed_apps to see available apps.`,
              });
            } else {
              try {
                // MCP path is non-interactive: use the stored preference or fall back to "reuse".
                const mode = await resolveLaunchMode(app, context, false);
                await openFileInApp(cmd.outputPath, app, outputChannel, mode);
                await writeResult(id, { exportPath: cmd.outputPath, openedIn: app.name });
              } catch (e: any) {
                await writeResult(id, { exportPath: cmd.outputPath, openInError: e?.message ?? String(e) });
              }
            }
          } else {
            await writeResult(id, { exportPath: cmd.outputPath });
          }
        } else {
          await writeResult(id, { error: "Export timed out — no shape loaded, or the worker did not reply." });
        }
      } else {
        if (cmd.format === "step") {
          vscode.commands.executeCommand("shapeitup.exportSTEP");
        } else {
          vscode.commands.executeCommand("shapeitup.exportSTL");
        }
        await writeResult(id, { error: "Interactive export requires a UI dialog — MCP clients should pass outputPath." });
      }
    } else if (cmd.command === "list-installed-apps") {
      // Async path is important here: on a cold cache the Windows scan can
      // take several seconds. With the 10s ceiling inside detectWindowsAsync
      // we're guaranteed to return within the MCP timeout.
      const detected = await getDetectedAppsAsync();
      const apps = detected.map((a) => ({
        id: a.id,
        name: a.name,
        preferredFormat: a.preferredFormat,
      }));
      await writeResult(id, { apps });
    } else if (cmd.command === "open-in-app") {
      const app = findAppById(cmd.appId as AppId);
      if (!app) {
        await writeResult(id, { error: `App not detected: ${cmd.appId}` });
      } else {
        try {
          // This IPC command is only sent by the MCP server — don't prompt.
          const exportPath = await exportAndOpen(viewerProvider, app, context, outputChannel, { interactive: false });
          if (exportPath) {
            await writeResult(id, { exportPath, openedIn: app.name });
          } else {
            await writeResult(id, { error: "Export failed — no shape loaded, or the worker did not reply." });
          }
        } catch (e: any) {
          await writeResult(id, { error: e?.message ?? String(e) });
        }
      }
    } else if (cmd.command === "set-render-mode") {
      viewerProvider.sendViewerCommand("set-render-mode", { mode: cmd.mode });
      await writeResult(id, { ok: true });
    } else if (cmd.command === "toggle-dimensions") {
      viewerProvider.sendViewerCommand("toggle-dimensions", { show: cmd.show });
      await writeResult(id, { ok: true });
    }
  }

  outputChannel.appendLine("ShapeItUp activated");
}

export function deactivate() {}

/**
 * Register the ShapeItUp MCP server with VS Code's native provider API so
 * Copilot / Agent Mode discovers it without any user configuration. This is
 * the only silent registration path we keep — VS Code owns the consent UI
 * and scopes the server to the editor process, so a crash can't corrupt the
 * user's global Claude / Gemini config.
 *
 * For Claude Code, Cursor, Claude Desktop, and Gemini CLI users: see the
 * `ShapeItUp: Install MCP Server…` command (shapeitup.installMcpServer)
 * which shows the one-shot AI install prompt for consented setup.
 */
function registerMcpServerForCopilot(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
) {
  const mcpServerPath = path.join(context.extensionPath, "dist", "mcp-server.mjs");
  try {
    if ((vscode.lm as any)?.registerMcpServerDefinitionProvider) {
      const provider = (vscode.lm as any).registerMcpServerDefinitionProvider(
        "shapeitup-mcp",
        {
          provideMcpServerDefinitions: () => [
            new (vscode as any).McpStdioServerDefinition(
              "shapeitup",
              "ShapeItUp CAD",
              "node",
              [mcpServerPath],
            ),
          ],
        },
      );
      context.subscriptions.push(provider);
      output.appendLine("[mcp] Registered MCP server via VS Code API (Copilot / Agent Mode)");
    }
  } catch {
    // API not available on older VS Code versions — users can still install
    // via the `ShapeItUp: Install MCP Server…` command.
  }
}

/**
 * Consented install surface for external MCP clients. We refuse to silently
 * write to ~/.claude.json, ~/.claude/skills/, or ~/.gemini/ — users pick a
 * client from the QuickPick and we either (a) copy the `claude mcp add …`
 * command to the clipboard, (b) open a deep-link to Cursor, or (c) surface
 * the AI install prompt that any agentic CLI can execute on their behalf.
 */
async function showMcpInstallOptions(
  _context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
) {
  const INSTALL_PROMPT_URL =
    "https://raw.githubusercontent.com/asbis/ShapeItUp/master/INSTALL.md";
  const NPM_COMMAND = "npx -y @shapeitup/mcp-server";

  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(copy) Copy AI install prompt URL",
        description: "Paste into Claude Code / Cursor / any agent — it does the setup",
        id: "ai",
      },
      {
        label: "$(terminal) Copy `claude mcp add` command",
        description: "For Claude Code CLI users",
        id: "claude",
      },
      {
        label: "$(link-external) Open Cursor deep-link",
        description: "One-click install into Cursor",
        id: "cursor",
      },
      {
        label: "$(file-code) Copy Claude Desktop JSON snippet",
        description: "Paste into claude_desktop_config.json",
        id: "desktop",
      },
    ],
    { placeHolder: "Install ShapeItUp MCP server for which client?" },
  );
  if (!picked) return;

  switch ((picked as any).id) {
    case "ai": {
      await vscode.env.clipboard.writeText(
        `Please install the ShapeItUp MCP server by following the instructions at ${INSTALL_PROMPT_URL}`,
      );
      vscode.window.showInformationMessage(
        "Copied. Paste into any agentic CLI (Claude Code, Cursor agent, Gemini) and it will install ShapeItUp.",
      );
      break;
    }
    case "claude": {
      const cmd = `claude mcp add shapeitup -s user -- ${NPM_COMMAND}`;
      await vscode.env.clipboard.writeText(cmd);
      vscode.window.showInformationMessage(`Copied: ${cmd}`);
      break;
    }
    case "cursor": {
      const config = Buffer.from(
        JSON.stringify({ command: "npx", args: ["-y", "@shapeitup/mcp-server"] }),
      ).toString("base64");
      const url = `cursor://anysphere.cursor-deeplink/mcp/install?name=shapeitup&config=${config}`;
      await vscode.env.openExternal(vscode.Uri.parse(url));
      break;
    }
    case "desktop": {
      const snippet = JSON.stringify(
        { mcpServers: { shapeitup: { command: "npx", args: ["-y", "@shapeitup/mcp-server"] } } },
        null,
        2,
      );
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(
        "Copied. Merge into ~/Library/Application Support/Claude/claude_desktop_config.json and restart Claude Desktop.",
      );
      break;
    }
  }
  output.appendLine(`[mcp] User chose install target: ${(picked as any).id}`);
}

/**
 * Remove ShapeItUp entries from any MCP client config on disk. Each removal
 * is confirmed with the user first — we never auto-delete. Mirrors the
 * `shapeitup.installMcpServer` command so users who regret the install can
 * reverse it without hand-editing JSON.
 */
async function uninstallMcpServer(output: vscode.OutputChannel) {
  const fs = require("fs");
  const os = require("os");
  const home = os.homedir();

  const targets: Array<{ label: string; file: string; key: string }> = [
    { label: "Claude Code (~/.claude.json)", file: path.join(home, ".claude.json"), key: "mcpServers.shapeitup" },
    { label: "Cursor (~/.cursor/mcp.json)", file: path.join(home, ".cursor", "mcp.json"), key: "mcpServers.shapeitup" },
    {
      label: "Claude Desktop",
      file: process.platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      key: "mcpServers.shapeitup",
    },
  ];

  const found = targets.filter((t) => {
    if (!fs.existsSync(t.file)) return false;
    try {
      const c = JSON.parse(fs.readFileSync(t.file, "utf-8"));
      return !!c?.mcpServers?.shapeitup;
    } catch {
      return false;
    }
  });

  const geminiExt = path.join(home, ".gemini", "extensions", "shapeitup");
  const hasGemini = fs.existsSync(geminiExt);
  const skill = path.join(home, ".claude", "skills", "shapeitup");
  const hasSkill = fs.existsSync(skill);

  if (found.length === 0 && !hasGemini && !hasSkill) {
    vscode.window.showInformationMessage("No ShapeItUp MCP entries found to uninstall.");
    return;
  }

  const items = [
    ...found.map((t) => ({ label: t.label, target: t, kind: "json" as const })),
    ...(hasGemini ? [{ label: `Gemini CLI (${geminiExt})`, target: geminiExt, kind: "dir" as const }] : []),
    ...(hasSkill ? [{ label: `Claude Code skill (${skill})`, target: skill, kind: "dir" as const }] : []),
  ];
  const picks = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: "Select ShapeItUp entries to remove",
  });
  if (!picks || picks.length === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove ${picks.length} ShapeItUp entr${picks.length === 1 ? "y" : "ies"}?`,
    { modal: true },
    "Remove",
  );
  if (confirm !== "Remove") return;

  for (const p of picks) {
    try {
      if (p.kind === "json") {
        const t = p.target as typeof targets[number];
        const c = JSON.parse(fs.readFileSync(t.file, "utf-8"));
        if (c?.mcpServers?.shapeitup) {
          delete c.mcpServers.shapeitup;
          fs.writeFileSync(t.file, JSON.stringify(c, null, 2) + "\n");
          output.appendLine(`[mcp] Removed shapeitup from ${t.file}`);
        }
      } else {
        fs.rmSync(p.target as string, { recursive: true, force: true });
        output.appendLine(`[mcp] Removed ${p.target}`);
      }
    } catch (e: any) {
      output.appendLine(`[mcp] Failed to remove ${p.label}: ${e.message}`);
    }
  }
  vscode.window.showInformationMessage("ShapeItUp MCP entries removed.");
}

/**
 * Ensure every workspace that contains `.shape.ts` files has local stubs for
 * `shapeitup` and `replicad` under `<ws>/node_modules/`, plus a minimal
 * tsconfig.json if none exists. TypeScript's default resolution will find
 * these stubs from any depth of subfolder, so imports resolve without any
 * `paths` or `typeRoots` configuration.
 *
 * This is the universal type-resolution strategy for marketplace installs:
 * no npm install, no path mappings, zero config from the user's side. When
 * the workspace has no `.shape.ts` files we skip entirely (cost: one
 * findFiles call limited to 1 result).
 *
 * Idempotent: skips stub writes when the bundled source hasn't changed
 * (size-matched). Never overwrites a user-authored tsconfig.json or
 * package.json. Never stubs `replicad` when the workspace declares a real
 * dependency on it.
 */
async function ensureWorkspaceTypes(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const fs = require("fs");

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return;

  const extDistTypings = path.join(context.extensionUri.fsPath, "dist", "typings");
  const shapeitupSrcDir = path.join(extDistTypings, "shapeitup");
  const replicadSrcDir = path.join(extDistTypings, "replicad");
  if (!fs.existsSync(shapeitupSrcDir) || !fs.existsSync(replicadSrcDir)) {
    output.appendLine(`[types] bundled typings missing at ${extDistTypings} — skipping`);
    return;
  }

  for (const folder of folders) {
    const wsRoot = folder.uri.fsPath;

    // Cheap gate: only touch workspaces that actually have shape files.
    // Limit 1 short-circuits at the first hit.
    let hasShapeFile = false;
    try {
      const hits = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*.shape.ts"),
        "**/node_modules/**",
        1
      );
      hasShapeFile = hits.length > 0;
    } catch {
      hasShapeFile = false;
    }
    if (!hasShapeFile) continue;

    const installed: string[] = [];
    try {
      // shapeitup: always safe to stub — not on npm.
      if (installStub(wsRoot, "shapeitup", shapeitupSrcDir)) installed.push("shapeitup");

      // replicad: skip if the user declares a real dependency in their
      // package.json (either dependencies or devDependencies).
      if (!workspaceHasReplicadDependency(wsRoot)) {
        if (installStub(wsRoot, "replicad", replicadSrcDir)) installed.push("replicad");
      }

      // Minimal tsconfig only when none exists at the workspace root.
      if (ensureMinimalTsconfig(wsRoot)) installed.push("tsconfig.json");
    } catch (e: any) {
      output.appendLine(`[types] failed at ${wsRoot}: ${e?.message ?? e}`);
      continue;
    }

    if (installed.length > 0) {
      output.appendLine(
        `[types] installed ${installed.join(" + ")} at ${wsRoot}`
      );
    }
  }
}
