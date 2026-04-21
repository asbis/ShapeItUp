import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import WebSocket from "ws";
import { ViewerProvider } from "./viewer-provider";
import { registerCommands } from "./commands";
import { createFileWatcher } from "./file-watcher";
import { warmAppCache } from "./app-detector";
import {
  installStub,
  workspaceHasReplicadDependency,
  ensureMinimalTsconfig,
} from "./workspace-types";
import { registerMcpClientsView, showFirstRunNudgeIfNeeded } from "./mcp-clients-view";
import { getCachedWasmAssets } from "./wasm-cache";

let viewerProvider: ViewerProvider;
export const outputChannel = vscode.window.createOutputChannel("ShapeItUp");

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine("ShapeItUp activating...");
  viewerProvider = new ViewerProvider(context, outputChannel);

  // Kick off installed-app detection now so the first MCP call hits a warm
  // cache. Windows fs scans + the Fusion reg query can take a few seconds
  // together — doing it here offloads that from the MCP request path.
  warmAppCache();

  // Eagerly read OCCT + Manifold WASM assets into extension-host memory so
  // the FIRST worker spawn (and every subsequent respawn after a watchdog
  // restart) can skip the 1.2MB loader fetch + .wasm fetch. The viewer pulls
  // these via a `request-wasm-assets` message in viewer-provider.ts. This is
  // fire-and-forget — if the user opens a shape file before the read
  // resolves, the viewer falls back to URL fetch (the pre-cache path).
  const distDir = path.join(context.extensionUri.fsPath, "dist");
  getCachedWasmAssets(distDir).catch((e) => {
    outputChannel.appendLine(`[wasm-cache] preload failed: ${e?.message ?? e}`);
  });

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

  registerMcpClientsView(context);
  showFirstRunNudgeIfNeeded(context);

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
        // P11 fix: carry the extension version + viewer-ready flag so the MCP
        // server can render `[shapeitup mcp vX · ext vY]` footers and surface
        // the viewer state in get_render_status. Using the VSCode API's
        // `packageJSON.version` avoids a disk read on every 2s tick.
        const extensionVersion: string | undefined =
          (context.extension?.packageJSON?.version as string | undefined) ?? undefined;
        const viewerReady = !!viewerProvider.viewerReady;
        const payload = JSON.stringify({
          timestamp: Date.now(),
          pid: process.pid,
          workspaceRoots,
          extensionVersion,
          viewerReady,
        });
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

  // MCP subscriber bridge: connect to the MCP server's WebSocket listener
  // (advertised via `mcp-server-heartbeat-<pid>.json` in the same
  // globalStorage dir) and subscribe to fire-and-forget UI events. Routing
  // across multiple VSCode windows is handled server-side via the
  // `targetWorkspaceRoot` filter on `publishEvent` — this extension no
  // longer needs to arbitrate a claim-lock race against peer windows.
  installMcpSubscriber(context, viewerProvider, outputChannel);

  outputChannel.appendLine("ShapeItUp activated");
}

/**
 * WebSocket subscriber for the MCP server's event bus. Runs independently of
 * the viewer so the viewer can still render user-driven previews even while
 * the MCP server is disconnected (or not even running).
 *
 * Discovery: reads `mcp-server-heartbeat-<pid>.json` from globalStorage to
 * find the MCP server's `127.0.0.1:<port>` listener. Reconnects with
 * exponential backoff on close. When the heartbeat file is missing (MCP
 * server not running), the loop pauses for 5 s between probes.
 */
function installMcpSubscriber(
  context: vscode.ExtensionContext,
  viewer: ViewerProvider,
  output: vscode.OutputChannel,
) {
  const globalStorage = context.globalStorageUri.fsPath;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 2000;
  const MAX_BACKOFF_MS = 30_000;
  let disposed = false;

  const readMcpHeartbeat = (): { port: number; pid: number } | null => {
    try {
      if (!fs.existsSync(globalStorage)) return null;
      const now = Date.now();
      let freshest: { port: number; pid: number; timestamp: number } | null = null;
      for (const name of fs.readdirSync(globalStorage)) {
        if (!name.startsWith("mcp-server-heartbeat-") || !name.endsWith(".json")) continue;
        try {
          const raw = fs.readFileSync(path.join(globalStorage, name), "utf-8");
          const hb = JSON.parse(raw);
          if (
            typeof hb?.pid === "number" &&
            typeof hb?.port === "number" &&
            typeof hb?.timestamp === "number" &&
            now - hb.timestamp < 10_000
          ) {
            if (!freshest || hb.timestamp > freshest.timestamp) {
              freshest = { port: hb.port, pid: hb.pid, timestamp: hb.timestamp };
            }
          }
        } catch {}
      }
      return freshest ? { port: freshest.port, pid: freshest.pid } : null;
    } catch {
      return null;
    }
  };

  const scheduleReconnect = (delay: number) => {
    if (disposed) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  const connect = () => {
    if (disposed) return;
    const hb = readMcpHeartbeat();
    if (!hb) {
      // No MCP server running. Poll at a slow cadence — this is the normal
      // state when the user hasn't configured any MCP client.
      scheduleReconnect(5000);
      return;
    }

    const sock = new WebSocket(`ws://127.0.0.1:${hb.port}`);
    ws = sock;

    sock.on("open", () => {
      backoffMs = 2000; // reset backoff on successful connect
      const workspaceRoots =
        vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
      try {
        sock.send(JSON.stringify({ type: "hello", workspaceRoots }));
      } catch {}
      output.appendLine(
        `[mcp-bus] Subscribed to MCP server pid=${hb.pid} port=${hb.port}; roots=[${workspaceRoots.join(", ")}]`,
      );
    });

    sock.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString("utf-8"));
      } catch {
        return;
      }
      handleEvent(msg, sock, viewer, output);
    });

    const onClose = () => {
      if (ws === sock) ws = null;
      const next = Math.min(backoffMs, MAX_BACKOFF_MS);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      scheduleReconnect(next);
    };
    sock.on("close", onClose);
    sock.on("error", (err) => {
      output.appendLine(`[mcp-bus] socket error: ${(err as Error)?.message ?? err}`);
      try { sock.close(); } catch {}
    });
  };

  // Kick off the first connect attempt on the next tick so activation
  // finishes quickly — otherwise a slow loopback bind could block the
  // extension host for tens of ms.
  setImmediate(connect);

  context.subscriptions.push({
    dispose: () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch {}
    },
  });
}

async function handleEvent(
  msg: any,
  sock: WebSocket,
  viewer: ViewerProvider,
  output: vscode.OutputChannel,
) {
  if (!msg || typeof msg.event !== "string") return;
  const { event, _id } = msg;
  const reply = (ok: boolean, error?: string) => {
    if (typeof _id !== "string") return;
    try { sock.send(JSON.stringify({ _id, ok, ...(error ? { error } : {}) })); } catch {}
  };

  try {
    if (event === "set-render-mode") {
      viewer.sendViewerCommand("set-render-mode", { mode: msg.mode });
      output.appendLine(`[mcp-bus] set-render-mode mode=${msg.mode}`);
      reply(true);
      return;
    }
    if (event === "toggle-dimensions") {
      viewer.sendViewerCommand("toggle-dimensions", { show: msg.show });
      output.appendLine(`[mcp-bus] toggle-dimensions show=${msg.show}`);
      reply(true);
      return;
    }
    if (event === "open-shape") {
      const filePath = msg.filePath;
      if (typeof filePath !== "string") {
        reply(false, "missing filePath");
        return;
      }
      output.appendLine(`[mcp-bus] open-shape ${filePath}`);
      const doc = await vscode.workspace.openTextDocument(filePath);
      await vscode.window.showTextDocument(doc, { preview: false });
      await viewer.ensureWebview();
      viewer.executeScript(doc);
      reply(true);
      return;
    }
    if (event === "app-opened") {
      output.appendLine(`[mcp-bus] app-opened app=${msg.appId} file=${msg.filePath}`);
      reply(true);
      return;
    }
    // Unknown events: reply with ok=false so publishAndAwait callers can
    // detect version skew. Silent on fire-and-forget messages (no _id).
    reply(false, `unknown event: ${event}`);
  } catch (e: any) {
    output.appendLine(`[mcp-bus] handler error for ${event}: ${e?.message ?? e}`);
    reply(false, e?.message ?? String(e));
  }
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

  // Warm the npx cache so the first MCP connect from the chosen client
  // doesn't have to download ~30 MB of replicad-opencascadejs inline —
  // Claude Code's connect timeout can fire before that finishes, surfacing
  // a spurious "failed" state even when the server is healthy.
  warmNpxMcpCache(output);
}

/**
 * Fire-and-forget prefetch of `@shapeitup/mcp-server` into the npx cache.
 * Runs detached so VS Code doesn't wait on it and the output stays quiet on
 * the happy path. We intentionally don't surface errors to the user — if the
 * prefetch fails, the real `npx` invocation from Claude/Cursor/etc. will try
 * again and the user sees the real error in their client.
 */
function warmNpxMcpCache(output: vscode.OutputChannel) {
  try {
    const { spawn } = require("child_process") as typeof import("child_process");
    const isWin = process.platform === "win32";
    // `npx --yes --package <pkg> -- node --version` forces npx to resolve and
    // install the package (populating its cache) but runs `node --version`
    // instead of the package's bin, so the command exits in milliseconds
    // once the download finishes rather than starting a stdio MCP server we
    // would then have to kill.
    const child = spawn(
      isWin ? "npx.cmd" : "npx",
      ["--yes", "--package", "@shapeitup/mcp-server", "--", "node", "--version"],
      {
        detached: true,
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      },
    );
    child.on("error", (err) => {
      output.appendLine(`[mcp] npx prefetch failed to spawn: ${err.message}`);
    });
    child.unref();
    output.appendLine("[mcp] Warming npx cache for @shapeitup/mcp-server in background.");
  } catch (e: any) {
    output.appendLine(`[mcp] npx prefetch skipped: ${e?.message ?? e}`);
  }
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

  type UninstallItem =
    | { label: string; mode: "json"; target: typeof targets[number] }
    | { label: string; mode: "dir"; target: string };
  const items: UninstallItem[] = [];
  for (const t of found) items.push({ label: t.label, target: t, mode: "json" });
  if (hasGemini) items.push({ label: `Gemini CLI (${geminiExt})`, target: geminiExt, mode: "dir" });
  if (hasSkill) items.push({ label: `Claude Code skill (${skill})`, target: skill, mode: "dir" });
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
      if (p.mode === "json") {
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
