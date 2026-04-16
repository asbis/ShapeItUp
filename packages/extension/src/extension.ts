import * as vscode from "vscode";
import * as path from "path";
import { ViewerProvider } from "./viewer-provider";
import { registerCommands } from "./commands";
import { createFileWatcher } from "./file-watcher";

let viewerProvider: ViewerProvider;
export const outputChannel = vscode.window.createOutputChannel("ShapeItUp");

export function activate(context: vscode.ExtensionContext) {
  outputChannel.appendLine("ShapeItUp activating...");
  viewerProvider = new ViewerProvider(context, outputChannel);

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

  // Watch for MCP command files (allows MCP server to trigger extension actions)
  const commandFile = path.join(context.globalStorageUri.fsPath, "mcp-command.json");
  let lastCommandId = "";
  const commandWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, "mcp-command.json")
  );
  commandWatcher.onDidChange(async () => {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(commandFile));
      const cmd = JSON.parse(Buffer.from(data).toString("utf-8"));

      // Dedup: file watcher fires multiple times per write
      const cmdId = JSON.stringify(cmd);
      if (cmdId === lastCommandId) return;
      lastCommandId = cmdId;
      setTimeout(() => { lastCommandId = ""; }, 2000); // allow same command after 2s
      if (cmd.command === "open-shape") {
        // Open a .shape.ts file, render it, and wait for the result
        outputChannel.appendLine(`[ai] Opening ${cmd.filePath}`);
        try {
          const doc = await vscode.workspace.openTextDocument(cmd.filePath);
          // Set lastPreviewedFile BEFORE showing doc to prevent auto-preview from doubling
          lastPreviewedFile = doc.fileName;
          await vscode.window.showTextDocument(doc, { preview: false });

          viewerProvider.executeScript(doc);

          // Wait for render to complete (poll status file for up to 8 seconds)
          const fs = require("fs");
          const statusPath = path.join(context.globalStorageUri.fsPath, "shapeitup-status.json");
          const startTime = Date.now();
          let renderDone = false;

          // Clear old status so we know when new one arrives
          try { fs.unlinkSync(statusPath); } catch {}

          // Poll for new status (render writes it on success or error)
          while (Date.now() - startTime < 8000) {
            await new Promise((r) => setTimeout(r, 500));
            if (fs.existsSync(statusPath)) {
              try {
                const status = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
                if (status.timestamp && new Date(status.timestamp).getTime() > startTime) {
                  renderDone = true;
                  // Write result for the MCP server to read
                  const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
                  await vscode.workspace.fs.writeFile(
                    vscode.Uri.file(resultFile),
                    Buffer.from(JSON.stringify({ renderStatus: status }), "utf-8")
                  );
                  break;
                }
              } catch {}
            }
          }

          if (!renderDone) {
            const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(resultFile),
              Buffer.from(JSON.stringify({ renderStatus: { success: false, error: "Render timed out after 8 seconds", fileName: cmd.filePath } }), "utf-8")
            );
          }
        } catch (e: any) {
          outputChannel.appendLine(`[ai] open-shape error: ${e.message}`);
        }

      } else if (cmd.command === "render-preview") {
        // Combined command: switch mode, toggle dims, wait, screenshot, restore
        outputChannel.appendLine(`[ai] render-preview: mode=${cmd.renderMode}, dims=${cmd.showDimensions}`);

        // Step 1: Switch render mode
        viewerProvider.sendViewerCommand("set-render-mode", { mode: cmd.renderMode || "ai" });

        // Step 2: Toggle dimensions
        if (cmd.showDimensions) {
          viewerProvider.sendViewerCommand("toggle-dimensions", { show: true });
        }

        // Step 3: Wait for viewer to update (render frame + dimension sprites)
        await new Promise((r) => setTimeout(r, 800));

        // Step 4: Capture screenshot
        const screenshotPath = await viewerProvider.captureScreenshot();

        // Step 5: Restore dark mode
        viewerProvider.sendViewerCommand("set-render-mode", { mode: "dark" });
        if (cmd.showDimensions) {
          viewerProvider.sendViewerCommand("toggle-dimensions", { show: false });
        }

        // Step 6: Write result
        const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(resultFile),
          Buffer.from(JSON.stringify({ screenshotPath }), "utf-8")
        );
        outputChannel.appendLine(`[ai] Screenshot saved: ${screenshotPath}`);

      } else if (cmd.command === "screenshot") {
        const screenshotPath = await viewerProvider.captureScreenshot(cmd.outputDir);
        const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(resultFile),
          Buffer.from(JSON.stringify({ screenshotPath }), "utf-8")
        );
      } else if (cmd.command === "export-shape") {
        outputChannel.appendLine(`[ai] Export: ${cmd.format} → ${cmd.outputPath || "dialog"}`);
        const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");

        if (cmd.outputPath) {
          // Direct save — no dialog (for AI workflows)
          const data = await viewerProvider.requestExport(cmd.format);
          if (data) {
            const fs = require("fs");
            fs.writeFileSync(cmd.outputPath, Buffer.from(data));
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(resultFile),
              Buffer.from(JSON.stringify({ exportPath: cmd.outputPath }), "utf-8")
            );
            outputChannel.appendLine(`[ai] Exported to ${cmd.outputPath}`);
          } else {
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(resultFile),
              Buffer.from(JSON.stringify({ error: "No shape to export" }), "utf-8")
            );
          }
        } else {
          // Interactive — show save dialog
          if (cmd.format === "step") {
            vscode.commands.executeCommand("shapeitup.exportSTEP");
          } else {
            vscode.commands.executeCommand("shapeitup.exportSTL");
          }
        }

      } else if (cmd.command === "set-render-mode") {
        viewerProvider.sendViewerCommand("set-render-mode", { mode: cmd.mode });
      } else if (cmd.command === "toggle-dimensions") {
        viewerProvider.sendViewerCommand("toggle-dimensions", { show: cmd.show });
      }
    } catch {}
  });
  context.subscriptions.push(commandWatcher);

  outputChannel.appendLine("ShapeItUp activated");
}

export function deactivate() {}

/**
 * Register the ShapeItUp MCP server for Claude Code.
 *
 * Claude Code reads MCP servers from ~/.claude.json (NOT ~/.claude/settings.json).
 * The VS Code lm.registerMcpServerDefinitionProvider API only works for GitHub Copilot.
 * So we write directly to ~/.claude.json if Claude Code is installed.
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
    "mcp-server.js"
  );

  // Also register via VS Code API for GitHub Copilot compatibility
  try {
    if (vscode.lm?.registerMcpServerDefinitionProvider) {
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

  // Register for Claude Code by writing to ~/.claude.json
  const claudeCode = vscode.extensions.getExtension("anthropic.claude-code");
  if (!claudeCode) {
    output.appendLine("[mcp] Claude Code not installed — skipping MCP setup");
    return;
  }

  const claudeJsonPath = path.join(os.homedir(), ".claude.json");

  try {
    let config: any = {};
    if (fs.existsSync(claudeJsonPath)) {
      config = JSON.parse(fs.readFileSync(claudeJsonPath, "utf-8"));
    }

    config.mcpServers = config.mcpServers || {};

    // Check if already configured with the correct path
    const existing = config.mcpServers.shapeitup;
    if (
      existing &&
      existing.args?.[0] === mcpServerPath
    ) {
      output.appendLine("[mcp] Claude Code MCP server already configured");
      return;
    }

    // Add or update the ShapeItUp MCP server
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
