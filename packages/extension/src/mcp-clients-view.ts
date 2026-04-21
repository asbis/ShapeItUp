/**
 * Tree view of MCP clients under the ShapeItUp sidebar. Passive discovery
 * surface: detects which AI clients are installed on the user's machine and
 * whether ShapeItUp is registered with each, with a click-to-install action
 * per row. Read-only detection — we never write config without explicit user
 * action (that lives in `shapeitup.installMcpServer`).
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

type Status = "registered" | "available" | "not-installed";

interface ClientInfo {
  id: string;
  label: string;
  status: Status;
  detail: string;
  installCommandId?: string;
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function hasShapeitupEntry(file: string): boolean {
  const c = readJson(file);
  return !!c?.mcpServers?.shapeitup;
}

function detectClients(): ClientInfo[] {
  const home = os.homedir();
  const platform = process.platform;

  // VS Code Copilot Agent Mode — we register via the native provider API on
  // activation, so if that API exists in this VS Code version, we consider it
  // registered (the provider lives for the session).
  const copilotAvailable = !!(vscode.lm as any)?.registerMcpServerDefinitionProvider;

  const claudeJson = path.join(home, ".claude.json");
  const cursorMcp = path.join(home, ".cursor", "mcp.json");
  const claudeDesktop = platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : platform === "win32"
    ? path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
    : path.join(home, ".config", "Claude", "claude_desktop_config.json");
  const geminiManifest = path.join(home, ".gemini", "extensions", "shapeitup", "gemini-extension.json");

  const hasClaudeCli =
    fs.existsSync(claudeJson) ||
    fs.existsSync(path.join(home, ".claude")) ||
    fs.existsSync(path.join(home, ".local", "bin", "claude")) ||
    fs.existsSync("/usr/local/bin/claude") ||
    fs.existsSync("/opt/homebrew/bin/claude");

  const hasCursor =
    fs.existsSync(cursorMcp) ||
    fs.existsSync(path.join(home, ".cursor")) ||
    (platform === "darwin" && fs.existsSync("/Applications/Cursor.app"));

  const hasClaudeDesktop =
    fs.existsSync(claudeDesktop) ||
    (platform === "darwin" && fs.existsSync("/Applications/Claude.app"));

  const hasGemini =
    fs.existsSync(path.join(home, ".gemini")) ||
    fs.existsSync(path.join(home, ".local", "bin", "gemini")) ||
    fs.existsSync("/usr/local/bin/gemini") ||
    fs.existsSync("/opt/homebrew/bin/gemini");

  return [
    {
      id: "copilot",
      label: "VS Code Copilot (Agent Mode)",
      status: copilotAvailable ? "registered" : "not-installed",
      detail: copilotAvailable
        ? "Registered automatically via VS Code's native MCP API"
        : "Upgrade VS Code to 1.102+ for native MCP support",
    },
    {
      id: "claude",
      label: "Claude Code",
      status: !hasClaudeCli
        ? "not-installed"
        : hasShapeitupEntry(claudeJson)
        ? "registered"
        : "available",
      detail: !hasClaudeCli
        ? "Not detected on this machine"
        : hasShapeitupEntry(claudeJson)
        ? "~/.claude.json has shapeitup entry"
        : "Click to copy `claude mcp add` command",
      installCommandId: "shapeitup.installMcpServer",
    },
    {
      id: "cursor",
      label: "Cursor",
      status: !hasCursor
        ? "not-installed"
        : hasShapeitupEntry(cursorMcp)
        ? "registered"
        : "available",
      detail: !hasCursor
        ? "Not detected on this machine"
        : hasShapeitupEntry(cursorMcp)
        ? "~/.cursor/mcp.json has shapeitup entry"
        : "Click to open Cursor install deep-link",
      installCommandId: "shapeitup.installMcpServer",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      status: !hasClaudeDesktop
        ? "not-installed"
        : hasShapeitupEntry(claudeDesktop)
        ? "registered"
        : "available",
      detail: !hasClaudeDesktop
        ? "Not detected on this machine"
        : hasShapeitupEntry(claudeDesktop)
        ? "claude_desktop_config.json has shapeitup entry"
        : "Click to copy JSON snippet",
      installCommandId: "shapeitup.installMcpServer",
    },
    {
      id: "gemini",
      label: "Gemini CLI",
      status: !hasGemini
        ? "not-installed"
        : fs.existsSync(geminiManifest)
        ? "registered"
        : "available",
      detail: !hasGemini
        ? "Not detected on this machine"
        : fs.existsSync(geminiManifest)
        ? "~/.gemini/extensions/shapeitup/ exists"
        : "Click to copy AI install prompt",
      installCommandId: "shapeitup.installMcpServer",
    },
  ];
}

class McpClientItem extends vscode.TreeItem {
  constructor(public readonly info: ClientInfo) {
    super(info.label, vscode.TreeItemCollapsibleState.None);
    this.description = info.status === "registered"
      ? "installed"
      : info.status === "available"
      ? "not installed"
      : "—";
    this.tooltip = info.detail;
    this.iconPath = new vscode.ThemeIcon(
      info.status === "registered"
        ? "pass-filled"
        : info.status === "available"
        ? "circle-large-outline"
        : "circle-slash",
      info.status === "registered"
        ? new vscode.ThemeColor("testing.iconPassed")
        : undefined,
    );
    if (info.status === "available" && info.installCommandId) {
      this.command = {
        command: info.installCommandId,
        title: "Install",
      };
      this.contextValue = "installable";
    }
  }
}

class McpClientsProvider implements vscode.TreeDataProvider<McpClientItem> {
  private emitter = new vscode.EventEmitter<McpClientItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh() {
    this.emitter.fire(undefined);
  }

  getTreeItem(el: McpClientItem): vscode.TreeItem {
    return el;
  }

  getChildren(): McpClientItem[] {
    return detectClients().map((c) => new McpClientItem(c));
  }
}

export function registerMcpClientsView(context: vscode.ExtensionContext) {
  const provider = new McpClientsProvider();
  const view = vscode.window.createTreeView("shapeitup.mcpClients", {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view);
  context.subscriptions.push(
    vscode.commands.registerCommand("shapeitup.refreshMcpClients", () => provider.refresh()),
  );

  // Refresh when the view becomes visible so stale "available" rows flip to
  // "registered" after the user completes an install in another window.
  context.subscriptions.push(
    view.onDidChangeVisibility((e) => {
      if (e.visible) provider.refresh();
    }),
  );
}

/**
 * Detect and offer to repair broken `shapeitup` MCP entries left behind by
 * pre-1.3 versions. Those versions wrote a versioned extension path into
 * ~/.claude.json / ~/.cursor/mcp.json / Claude Desktop config and Gemini
 * manifests; after the extension upgrades or is uninstalled, the path goes
 * stale and the client logs "Failed to reconnect". We rewrite the entry to
 * `npx -y @shapeitup/mcp-server` — but only with explicit consent, and only
 * when the existing entry actually points at a non-existent path so we never
 * clobber a hand-tuned setup.
 */
/**
 * Match args[0] values that point inside a versioned shapeitup extension
 * folder (`.vscode/extensions/shapeitup.shapeitup-vscode-<version>/…`). Those
 * paths are inherently version-coupled: even if the folder still exists on
 * disk, the bundle is from a previous release and can't be trusted (e.g.
 * 1.1.0's mcp-server.mjs had a bare `import "esbuild"` that fails at runtime).
 */
function isVersionedExtensionPath(arg: string): boolean {
  return /[\\/]\.vscode[\\/]extensions[\\/]shapeitup\.shapeitup-vscode-[^\\/]+[\\/]/i.test(arg);
}

async function migrateStaleMcpEntriesIfNeeded(context: vscode.ExtensionContext) {
  // v2 bumps the gate so users who already dismissed v1 (when the detector
  // only caught deleted paths) get re-prompted for the broken-but-present
  // case.
  const KEY = "shapeitup.migrateStale.v2";
  if (context.globalState.get(KEY)) return;

  const home = os.homedir();
  const platform = process.platform;
  const candidates = [
    { label: "Claude Code (~/.claude.json)", file: path.join(home, ".claude.json") },
    { label: "Cursor (~/.cursor/mcp.json)", file: path.join(home, ".cursor", "mcp.json") },
    {
      label: "Claude Desktop",
      file: platform === "darwin"
        ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
        : platform === "win32"
        ? path.join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
        : path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    },
    {
      label: "Gemini CLI (~/.gemini/extensions/shapeitup)",
      file: path.join(home, ".gemini", "extensions", "shapeitup", "gemini-extension.json"),
    },
  ];

  const stale: Array<{ label: string; file: string; currentArg: string }> = [];
  for (const c of candidates) {
    if (!fs.existsSync(c.file)) continue;
    const cfg = readJson(c.file);
    const entry = cfg?.mcpServers?.shapeitup;
    if (!entry) continue;
    // Stale iff the entry uses `command: node` with an args[0] that is
    // either (a) a path that no longer exists, or (b) points inside a
    // versioned shapeitup extension folder — those bundles are frozen to a
    // specific release and may be present-but-broken after an upgrade. An
    // `npx -y @shapeitup/mcp-server` entry (the new canonical shape) is left
    // alone.
    const arg = Array.isArray(entry.args) ? entry.args[0] : undefined;
    if (
      entry.command === "node" &&
      typeof arg === "string" &&
      (!fs.existsSync(arg) || isVersionedExtensionPath(arg))
    ) {
      stale.push({ label: c.label, file: c.file, currentArg: arg });
    }
  }

  if (stale.length === 0) {
    await context.globalState.update(KEY, true);
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `ShapeItUp found ${stale.length} broken MCP entr${stale.length === 1 ? "y" : "ies"} ` +
      `pointing at a versioned extension bundle. ` +
      `Migrate to the npm-based install (npx -y @shapeitup/mcp-server)?`,
    "Migrate",
    "Show details",
    "Not now",
  );

  if (choice === "Show details") {
    const detail = stale.map((s) => `• ${s.label}\n  broken path: ${s.currentArg}`).join("\n\n");
    const next = await vscode.window.showInformationMessage(
      `Entries to migrate:\n\n${detail}`,
      { modal: true },
      "Migrate",
      "Cancel",
    );
    if (next !== "Migrate") return;
  } else if (choice !== "Migrate") {
    // "Not now" / dismissed — don't set the flag, ask again next activation.
    return;
  }

  const NEW_ENTRY = {
    type: "stdio" as const,
    command: "npx",
    args: ["-y", "@shapeitup/mcp-server"],
  };

  let migrated = 0;
  for (const s of stale) {
    try {
      const cfg = readJson(s.file);
      if (!cfg?.mcpServers?.shapeitup) continue;
      cfg.mcpServers.shapeitup = s.file.endsWith("gemini-extension.json")
        ? { command: "npx", args: ["-y", "@shapeitup/mcp-server"] }
        : NEW_ENTRY;
      fs.writeFileSync(s.file, JSON.stringify(cfg, null, 2) + "\n");
      migrated++;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to migrate ${s.label}: ${e.message}`);
    }
  }

  await context.globalState.update(KEY, true);
  if (migrated > 0) {
    vscode.window.showInformationMessage(
      `Migrated ${migrated} ShapeItUp MCP entr${migrated === 1 ? "y" : "ies"} to npx. ` +
        `Restart your AI client to pick up the change.`,
    );
  }
}

/**
 * One-time activation nudge. Fires on the first activation after install
 * (when no MCP client has a shapeitup entry yet) to point users at the
 * install flow. Stored in globalState so it never fires twice.
 */
export async function showFirstRunNudgeIfNeeded(context: vscode.ExtensionContext) {
  // Run the stale-entry migration first — if the user's broken 1.2.0 entry
  // gets repaired, the nudge becomes redundant.
  await migrateStaleMcpEntriesIfNeeded(context);

  const KEY = "shapeitup.firstRunNudge.v1";
  if (context.globalState.get(KEY)) return;

  const clients = detectClients();
  const anyRegistered = clients.some((c) => c.status === "registered" && c.id !== "copilot");
  if (anyRegistered) {
    await context.globalState.update(KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "ShapeItUp is installed. To use it with Claude Code, Cursor, or Gemini, install the MCP server.",
    "Install…",
    "Already done",
    "Don't show again",
  );
  if (choice === "Install…") {
    vscode.commands.executeCommand("shapeitup.installMcpServer");
  }
  if (choice) {
    await context.globalState.update(KEY, true);
  }
}
