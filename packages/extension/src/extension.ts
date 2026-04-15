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
  const commandWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(context.globalStorageUri, "mcp-command.json")
  );
  commandWatcher.onDidChange(async () => {
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(commandFile));
      const cmd = JSON.parse(Buffer.from(data).toString("utf-8"));
      if (cmd.command === "screenshot") {
        const screenshotPath = await viewerProvider.captureScreenshot(cmd.outputDir);
        // Write result back
        const resultFile = path.join(context.globalStorageUri.fsPath, "mcp-result.json");
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(resultFile),
          Buffer.from(JSON.stringify({ screenshotPath }), "utf-8")
        );
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
 * Register the ShapeItUp MCP server via the VS Code API.
 * This allows Claude Code and GitHub Copilot to discover it automatically —
 * no manual settings.json editing needed.
 */
function registerMcpServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
) {
  // Check if the VS Code MCP API is available (requires VS Code 1.99+)
  if (!vscode.lm?.registerMcpServerDefinitionProvider) {
    output.appendLine("[mcp] VS Code MCP API not available — manual setup required");
    return;
  }

  const mcpServerPath = path.join(
    context.extensionPath,
    "dist",
    "mcp-server.js"
  );

  try {
    const provider = vscode.lm.registerMcpServerDefinitionProvider("shapeitup-mcp", {
      provideMcpServerDefinitions: () => {
        return [
          new vscode.McpStdioServerDefinition(
            "shapeitup",
            "ShapeItUp CAD",
            "node",
            [mcpServerPath]
          ),
        ];
      },
    });
    context.subscriptions.push(provider);
    output.appendLine("[mcp] MCP server registered via VS Code API");
  } catch (e: any) {
    output.appendLine(`[mcp] Failed to register MCP server: ${e.message}`);
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
          replicad: [path.join(typingsPath, "replicad")],
        },
      },
      include: ["**/*.shape.ts"],
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
    output.appendLine("[setup] Created tsconfig.json with replicad types from extension");
  } else {
    // tsconfig.json exists — check if it already has replicad paths
    try {
      const existing = JSON.parse(fs.readFileSync(tsconfigPath, "utf-8"));
      if (!existing.compilerOptions?.paths?.replicad) {
        // Add paths to existing tsconfig without overwriting other settings
        existing.compilerOptions = existing.compilerOptions || {};
        existing.compilerOptions.paths = existing.compilerOptions.paths || {};
        existing.compilerOptions.paths.replicad = [path.join(typingsPath, "replicad")];
        fs.writeFileSync(tsconfigPath, JSON.stringify(existing, null, 2) + "\n");
        output.appendLine("[setup] Added replicad type paths to existing tsconfig.json");
      }
    } catch {
      // Can't parse existing tsconfig — leave it alone
    }
  }
}
