import * as vscode from "vscode";
import * as path from "path";
import { ViewerProvider } from "./viewer-provider";
import { registerCommands } from "./commands";
import { createFileWatcher } from "./file-watcher";
import { getDetectedApps, getDetectedAppsAsync, warmAppCache, type AppId } from "./app-detector";
import { exportAndOpen, findAppById, openFileInApp, resolveLaunchMode } from "./open-in-app";

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

  // Register MCP server so Claude Code / Copilot can discover it automatically
  registerMcpServer(context, outputChannel);

  // Install the `/shapeitup` Claude Code skill (Replicad API reference)
  installClaudeSkill(context, outputChannel);

  // Install the Gemini CLI extension (bundles MCP server + skill)
  installGeminiExtension(context, outputChannel);

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
  let setupPromptShown = false;
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

        // Provide replicad types for editor autocomplete (no npm install)
        if (!setupPromptShown) {
          const fs = require("fs");
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (folder) {
            setupPromptShown = true;
            provideReplicadTypes(folder, context.extensionPath, outputChannel);
          }
        }
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
  {
    const fs = require("fs");
    const hbPath = path.join(context.globalStorageUri.fsPath, "shapeitup-heartbeat.json");
    const writeHb = () => {
      try {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        // Include workspaceRoots so the MCP server (whose process.cwd() is the
        // extension's install dir, not the user's workspace) can default
        // create_shape / list_shapes to the right place. See tools.ts
        // getDefaultDirectory().
        const workspaceRoots =
          vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
        fs.writeFileSync(
          hbPath,
          JSON.stringify({ timestamp: Date.now(), pid: process.pid, workspaceRoots })
        );
      } catch {}
    };
    writeHb();
    const hbInterval = setInterval(writeHb, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(hbInterval) });
  }

  // Watch for MCP command files (allows MCP server to trigger extension actions)
  const commandFile = path.join(context.globalStorageUri.fsPath, "mcp-command.json");
  const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
  const seenCommandIds = new Set<string>();
  const writeResult = async (id: string | undefined, payload: Record<string, any>) => {
    try {
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(resultFile),
        Buffer.from(JSON.stringify({ _id: id, ...payload }), "utf-8")
      );
    } catch {}
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
      outputChannel.appendLine(`[ai] render-preview: file=${cmd.filePath || "<last>"} mode=${cmd.renderMode}, dims=${cmd.showDimensions}, axes=${!!cmd.showAxes}, camera=${cmd.cameraAngle || "isometric"}, size=${cmd.width || "auto"}x${cmd.height || "auto"}`);

      const ready = await viewerProvider.ensureWebview();
      if (!ready) {
        await writeResult(id, { error: "Viewer webview could not be opened — the extension host may be unresponsive." });
        return;
      }

      // If MCP passed an explicit file path, make sure that's what's loaded in
      // the viewer before capturing. The engine in the MCP process already
      // renders in Node; we re-render here so the user's visible viewer shows
      // the same shape they're about to screenshot.
      if (cmd.filePath) {
        try {
          const doc = await vscode.workspace.openTextDocument(cmd.filePath);
          lastPreviewedFile = doc.fileName;
          // `cmd.params` (optional) is the ephemeral param override map set by
          // tune_params so the viewer re-renders the same configuration the
          // MCP engine just computed. Absent on normal render_preview calls.
          viewerProvider.executeScript(doc, cmd.params);
          // Wait briefly for the render to complete before capturing.
          const startTime = Date.now();
          const statusPath = path.join(context.globalStorageUri.fsPath, "shapeitup-status.json");
          const fs = require("fs");
          while (Date.now() - startTime < 8000) {
            await new Promise((r) => setTimeout(r, 100));
            if (fs.existsSync(statusPath)) {
              try {
                const s = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
                if (s.timestamp && new Date(s.timestamp).getTime() > startTime) break;
              } catch {}
            }
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
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      let outputDir: string | undefined;
      if (wsRoot) {
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
        cmd.height
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
        await writeResult(id, {
          error: "Screenshot capture timed out — the viewer webview may be closed or the worker may have crashed.",
          partWarnings,
        });
        outputChannel.appendLine("[ai] Screenshot failed (timeout)");
      }
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
 * Register the ShapeItUp MCP server for Claude Code.
 *
 * Claude Code reads user-scope MCP servers from ~/.claude.json. We write there
 * directly, which works for both the Claude Code VS Code extension and the
 * standalone native CLI install (e.g. `~/.local/bin/claude` on macOS). We do
 * NOT gate on `vscode.extensions.getExtension("anthropic.claude-code")` because
 * many users install Claude Code as a CLI only — gating on the VS Code
 * extension silently skips MCP setup for them.
 *
 * For GitHub Copilot, we also register via the lm API when available.
 */
function registerMcpServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
) {
  const fs = require("fs");
  const os = require("os");

  const mcpServerPath = path.join(
    context.extensionPath,
    "dist",
    "mcp-server.mjs"
  );

  // Register via VS Code API for GitHub Copilot compatibility
  try {
    // Older VS Code versions don't expose this API — check dynamically.
    if ((vscode.lm as any)?.registerMcpServerDefinitionProvider) {
      const provider = (vscode.lm as any).registerMcpServerDefinitionProvider("shapeitup-mcp", {
        provideMcpServerDefinitions: () => {
          return [
            new (vscode as any).McpStdioServerDefinition(
              "shapeitup",
              "ShapeItUp CAD",
              "node",
              [mcpServerPath]
            ),
          ];
        },
      });
      context.subscriptions.push(provider);
      output.appendLine("[mcp] Registered MCP server via VS Code API (Copilot)");
    }
  } catch {
    // API not available — that's fine
  }

  // Detect Claude Code (VS Code extension OR native CLI install).
  const hasClaudeVscode = !!vscode.extensions.getExtension("anthropic.claude-code");
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");
  const hasClaudeCli =
    fs.existsSync(claudeJsonPath) ||
    fs.existsSync(path.join(os.homedir(), ".claude")) ||
    fs.existsSync(path.join(os.homedir(), ".local", "bin", "claude")) ||
    fs.existsSync("/usr/local/bin/claude") ||
    fs.existsSync("/opt/homebrew/bin/claude");

  if (!hasClaudeVscode && !hasClaudeCli) {
    output.appendLine("[mcp] Claude Code not detected — skipping ~/.claude.json registration");
    return;
  }

  try {
    let config: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      try {
        config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
      } catch (parseErr: any) {
        output.appendLine(`[mcp] ~/.claude.json is not valid JSON — aborting to avoid data loss: ${parseErr.message}`);
        return;
      }
    }

    config.mcpServers = config.mcpServers || {};

    const existing = config.mcpServers.shapeitup;
    if (existing && existing.args?.[0] === mcpServerPath) {
      output.appendLine("[mcp] Claude Code MCP server already configured");
      return;
    }

    config.mcpServers.shapeitup = {
      type: "stdio",
      command: "node",
      args: [mcpServerPath],
    };

    fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2) + "\n");
    output.appendLine(`[mcp] Registered MCP server in ~/.claude.json → ${mcpServerPath}`);
  } catch (e: any) {
    output.appendLine(`[mcp] Failed to configure Claude Code MCP: ${e.message}`);
  }
}

/**
 * Install the `/shapeitup` Claude Code skill into ~/.claude/skills/shapeitup/.
 *
 * Claude Code auto-discovers user-level skills at ~/.claude/skills/<name>/SKILL.md.
 * The bundled SKILL.md is copied there on activation so users don't have to run
 * any manual `cp` command. We only write if the source is newer than the
 * destination (by mtime) to avoid pointless I/O on every activation.
 */
function installClaudeSkill(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
) {
  const fs = require("fs");
  const os = require("os");

  const src = path.join(context.extensionPath, "dist", "skill", "SKILL.md");
  if (!fs.existsSync(src)) {
    output.appendLine("[skill] Bundled SKILL.md not found — skipping skill install");
    return;
  }

  // Only install if the user has Claude Code (VS Code extension OR CLI install).
  const hasClaudeVscode = !!vscode.extensions.getExtension("anthropic.claude-code");
  const home = os.homedir();
  const hasClaudeCli =
    fs.existsSync(path.join(home, ".claude.json")) ||
    fs.existsSync(path.join(home, ".claude")) ||
    fs.existsSync(path.join(home, ".local", "bin", "claude")) ||
    fs.existsSync("/usr/local/bin/claude") ||
    fs.existsSync("/opt/homebrew/bin/claude");

  if (!hasClaudeVscode && !hasClaudeCli) {
    output.appendLine("[skill] Claude Code not detected — skipping skill install");
    return;
  }

  try {
    const skillDir = path.join(home, ".claude", "skills", "shapeitup");
    const dest = path.join(skillDir, "SKILL.md");

    const srcMtime = fs.statSync(src).mtimeMs;
    const destMtime = fs.existsSync(dest) ? fs.statSync(dest).mtimeMs : 0;
    if (destMtime >= srcMtime) {
      output.appendLine("[skill] /shapeitup skill already up-to-date");
      return;
    }

    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(src, dest);
    output.appendLine(`[skill] Installed /shapeitup skill → ${dest}`);
  } catch (e: any) {
    output.appendLine(`[skill] Failed to install /shapeitup skill: ${e.message}`);
  }
}

/**
 * Install the ShapeItUp Gemini CLI extension into ~/.gemini/extensions/shapeitup/.
 *
 * Gemini CLI auto-discovers extensions at ~/.gemini/extensions/<name>/, each
 * containing a gemini-extension.json manifest (which can declare MCP servers
 * just like Claude's ~/.claude.json mcpServers) and an optional skills/
 * subdirectory where SKILL.md files are auto-registered.
 *
 * We bypass `gemini extensions install` and write the three files directly —
 * same pattern as the Claude install above — so users don't need the gemini
 * CLI on PATH and don't have to run any manual command.
 */
function installGeminiExtension(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
) {
  const fs = require("fs");
  const os = require("os");

  const srcMcp = path.join(context.extensionPath, "dist", "mcp-server.mjs");
  const srcSkill = path.join(context.extensionPath, "dist", "skill", "SKILL.md");
  if (!fs.existsSync(srcMcp) || !fs.existsSync(srcSkill)) {
    output.appendLine("[gemini] Bundled mcp-server.mjs or SKILL.md missing — skipping");
    return;
  }

  const home = os.homedir();
  const hasGeminiCli =
    fs.existsSync(path.join(home, ".gemini")) ||
    fs.existsSync(path.join(home, ".gemini", "settings.json")) ||
    fs.existsSync(path.join(home, ".local", "bin", "gemini")) ||
    fs.existsSync("/usr/local/bin/gemini") ||
    fs.existsSync("/opt/homebrew/bin/gemini");

  if (!hasGeminiCli) {
    output.appendLine("[gemini] Gemini CLI not detected — skipping extension install");
    return;
  }

  try {
    const extDir = path.join(home, ".gemini", "extensions", "shapeitup");
    const skillDir = path.join(extDir, "skills", "shapeitup");
    const destSkill = path.join(skillDir, "SKILL.md");
    const manifestPath = path.join(extDir, "gemini-extension.json");

    fs.mkdirSync(skillDir, { recursive: true });

    // Point Gemini directly at the VSCode extension's dist/mcp-server.mjs.
    // Early versions copied the bundle to ~/.gemini/extensions/shapeitup/, but
    // that directory has no node_modules, so the server crashed at startup
    // trying to resolve its externalized deps (esbuild, replicad-opencascadejs)
    // and Gemini silently registered zero tools. Referencing the VSCode
    // install path means Node uses that location's node_modules — which is
    // guaranteed to exist because the user had to install the extension first.
    const version = context.extension?.packageJSON?.version ?? "0.0.0";
    const serverPath = path.join(context.extensionPath, "dist", "mcp-server.mjs");
    const manifest = {
      name: "shapeitup",
      version,
      description: "ShapeItUp CAD — scripted 3D modeling with Replicad",
      mcpServers: {
        shapeitup: {
          command: "node",
          args: [serverPath],
          cwd: context.extensionPath,
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const srcSkillMtime = fs.statSync(srcSkill).mtimeMs;
    const destSkillMtime = fs.existsSync(destSkill) ? fs.statSync(destSkill).mtimeMs : 0;
    if (destSkillMtime < srcSkillMtime) fs.copyFileSync(srcSkill, destSkill);

    // Clean up stale copies from earlier install versions that copied the
    // server binary here (now it lives only at the VSCode extension path).
    for (const stale of ["mcp-server.js", "mcp-server.mjs", "mcp-server.mjs.map", "mcp-server.js.map"]) {
      const p = path.join(extDir, stale);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }

    output.appendLine(`[gemini] Installed Gemini CLI extension → ${extDir} (server: ${serverPath})`);
  } catch (e: any) {
    output.appendLine(`[gemini] Failed to install Gemini CLI extension: ${e.message}`);
  }
}

/**
 * Ensure .shape.ts files get replicad type checking and autocomplete
 * by creating a tsconfig that points to our bundled type definitions.
 * No npm install, no node_modules, no package.json modifications.
 */
function provideReplicadTypes(
  folderPath: string,
  extensionPath: string,
  output: vscode.OutputChannel
) {
  const fs = require("fs");

  // Path to our bundled replicad types inside the extension
  const typingsPath = path.join(extensionPath, "typings");

  // Check if the project already has replicad installed (no need for our types)
  if (fs.existsSync(path.join(folderPath, "node_modules", "replicad"))) return;

  const tsconfigPath = path.join(folderPath, "tsconfig.json");

  const replicadTypePath = path.join(typingsPath, "replicad");

  if (!fs.existsSync(tsconfigPath)) {
    // No tsconfig.json — create one for .shape.ts files
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        typeRoots: [typingsPath],
        paths: {
          replicad: [replicadTypePath],
        },
      },
      include: ["**/*.shape.ts"],
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    output.appendLine("[setup] Created tsconfig.json with replicad types from extension");
  } else {
    // tsconfig.json exists — always update the replicad path to current extension version
    try {
      const existing = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
      existing.compilerOptions = existing.compilerOptions || {};
      existing.compilerOptions.paths = existing.compilerOptions.paths || {};
      const currentPath = existing.compilerOptions.paths.replicad?.[0];

      if (currentPath !== replicadTypePath) {
        existing.compilerOptions.typeRoots = [typingsPath];
        existing.compilerOptions.paths.replicad = [replicadTypePath];
        fs.writeFileSync(tsconfigPath, JSON.stringify(existing, null, 2) + "\n");
        output.appendLine("[setup] Updated replicad type paths in tsconfig.json to current extension version");
      }
    } catch {
      // Can't parse existing tsconfig — leave it alone
    }
  }
}
