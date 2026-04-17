import * as vscode from "vscode";
import type { ViewerProvider } from "./viewer-provider";

export function createFileWatcher(
  context: vscode.ExtensionContext,
  viewer: ViewerProvider
) {
  // Watch for .shape.ts file saves
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.shape.ts");

  // Debounce mechanism
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  const onFileChange = (uri: vscode.Uri) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      // Only auto-execute if the file is currently open in an editor
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri.toString()
      );
      if (editor) {
        viewer.executeScript(editor.document);
      }
    }, 300);
  };

  watcher.onDidChange(onFileChange);
  watcher.onDidCreate(onFileChange);

  // NOTE: onDidSaveTextDocument is handled in extension.ts — registering it
  // here too caused every save to fire executeScript twice (and the status
  // file to be written twice). Keep only the watcher-based change detection
  // here; saves are covered by the sibling handler.

  context.subscriptions.push(watcher);
}
