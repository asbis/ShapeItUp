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

  // Auto-preview when switching to a .shape.ts file (debounced)
  let autoPreviewTimer: ReturnType<typeof setTimeout> | undefined;
  let setupPromptShown = false;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.fileName.endsWith(".shape.ts")) {
        if (autoPreviewTimer) clearTimeout(autoPreviewTimer);
        autoPreviewTimer = setTimeout(() => {
          outputChannel.appendLine(
            `[auto] Switched to ${editor.document.fileName}`
          );
          viewerProvider.executeScript(editor.document);
        }, 500);

        // Auto-install replicad types if missing (silent, no prompt)
        if (!setupPromptShown) {
          const fs = require("fs");
          const p = require("path");
          const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (
            folder &&
            !fs.existsSync(p.join(folder, "node_modules", "replicad"))
          ) {
            setupPromptShown = true;
            outputChannel.appendLine("[setup] Replicad types missing, installing...");
            autoInstallReplicad(folder, outputChannel);
          }
        }
      }
    })
  );

  // Also auto-preview the currently open file on activation
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && activeEditor.document.fileName.endsWith(".shape.ts")) {
    viewerProvider.executeScript(activeEditor.document);
  }

  // Move the ShapeItUp view to the secondary side bar (right side) on first run
  const movedKey = "shapeitup.movedToSecondarySideBar";
  if (!context.globalState.get(movedKey)) {
    vscode.commands.executeCommand("shapeitup.viewer.focus").then(() => {
      // Try different command names across VS Code versions
      vscode.commands
        .executeCommand("workbench.action.moveViewToSecondarySideBar")
        .then(
          () => {
            context.globalState.update(movedKey, true);
            outputChannel.appendLine("[init] Moved viewer to secondary side bar");
          },
          () => {
            // Fallback: try the auxiliary bar command (older VS Code versions)
            vscode.commands
              .executeCommand("workbench.action.moveViewToAuxiliaryBar")
              .then(
                () => {
                  context.globalState.update(movedKey, true);
                  outputChannel.appendLine("[init] Moved viewer to auxiliary bar");
                },
                () => {
                  // Neither command exists — just mark as done, user can move it manually
                  context.globalState.update(movedKey, true);
                  outputChannel.appendLine("[init] Could not auto-move viewer — drag it to the right side manually");
                }
              );
          }
        );
    });
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
 * Silently install replicad in a project so .shape.ts files get proper types.
 * Runs in the background — no terminal, no prompt.
 */
function autoInstallReplicad(folderPath: string, output: vscode.OutputChannel) {
  const fs = require("fs");
  const cp = require("child_process");

  // Create package.json if missing
  const pkgPath = path.join(folderPath, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(
      pkgPath,
      JSON.stringify({ private: true, dependencies: { replicad: "^0.23.0" } }, null, 2) + "\n"
    );
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (!pkg.dependencies?.replicad && !pkg.devDependencies?.replicad) {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies.replicad = "^0.23.0";
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      }
    } catch {
      return;
    }
  }

  // Create tsconfig.json if missing
  const tsconfigPath = path.join(folderPath, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ["**/*.shape.ts"],
    };
    fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
  }

  // Run npm install silently in the background
  cp.exec("npm install --save replicad", { cwd: folderPath }, (err: any) => {
    if (err) {
      output.appendLine(`[setup] Failed to install replicad: ${err.message}`);
    } else {
      output.appendLine("[setup] Replicad types installed successfully");
    }
  });
}
