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

  const ext = format === "step" ? "step" : "stl";
  const filterLabel = format === "step" ? "STEP files" : "STL files";

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
