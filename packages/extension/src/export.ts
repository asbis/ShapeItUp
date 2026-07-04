import * as vscode from "vscode";
import type { ViewerProvider } from "./viewer-provider";
import type { ExportFormat } from "@shapeitup/shared";

export async function exportToFile(
  viewer: ViewerProvider,
  format: ExportFormat
) {
  const data = await viewer.requestExport(format);
  if (!data) {
    vscode.window.showErrorMessage(
      "ShapeItUp: No shape to export. Preview a .shape.ts file first."
    );
    return;
  }

  const ext = format;
  const filterLabel =
    format === "step" ? "STEP files" : format === "3mf" ? "3MF files" : "STL files";

  // Default to same directory as the active editor
  const defaultUri = vscode.window.activeTextEditor?.document.uri;
  const defaultDir = defaultUri
    ? vscode.Uri.joinPath(defaultUri, "..")
    : undefined;

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: defaultDir
      ? vscode.Uri.joinPath(defaultDir, `export.${ext}`)
      : undefined,
    filters: { [filterLabel]: [ext] },
  });

  if (!saveUri) return;

  await vscode.workspace.fs.writeFile(saveUri, new Uint8Array(data));
  vscode.window.showInformationMessage(
    `ShapeItUp: Exported to ${saveUri.fsPath}`
  );
}

/**
 * Split export: write EACH part of the assembly to its own file inside a
 * user-chosen folder. Best for 3D printing — every part becomes an
 * independent object the slicer can arrange. Falls back to a friendly
 * message when there's nothing to export.
 */
export async function exportSplitToFolder(
  viewer: ViewerProvider,
  format: ExportFormat
) {
  const items = await viewer.requestExportSplit(format);
  if (!items || items.length === 0) {
    vscode.window.showErrorMessage(
      "ShapeItUp: No parts to export. Preview a .shape.ts file first."
    );
    return;
  }

  // Default the picker to the active editor's directory.
  const defaultUri = vscode.window.activeTextEditor?.document.uri;
  const defaultDir = defaultUri
    ? vscode.Uri.joinPath(defaultUri, "..")
    : undefined;

  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: `Export ${items.length} parts here`,
    title: `Choose a folder for ${items.length} ${format.toUpperCase()} files`,
    defaultUri: defaultDir,
  });
  if (!picked || picked.length === 0) return;
  const folder = picked[0];

  const written: string[] = [];
  for (const item of items) {
    const target = vscode.Uri.joinPath(folder, `${item.name}.${format}`);
    await vscode.workspace.fs.writeFile(target, new Uint8Array(item.data));
    written.push(`${item.name}.${format}`);
  }

  vscode.window.showInformationMessage(
    `ShapeItUp: Exported ${written.length} parts (${format.toUpperCase()}) to ${folder.fsPath}`
  );
}
