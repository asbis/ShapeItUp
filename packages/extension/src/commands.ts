import * as vscode from "vscode";
import type { ViewerProvider } from "./viewer-provider";
import { exportToFile } from "./export";

export function registerCommands(
  context: vscode.ExtensionContext,
  viewer: ViewerProvider
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("shapeitup.exportSTEP", async () => {
      await exportToFile(viewer, "step");
    }),

    vscode.commands.registerCommand("shapeitup.exportSTL", async () => {
      await exportToFile(viewer, "stl");
    }),

    vscode.commands.registerCommand("shapeitup.newShape", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Shape file name (without extension)",
        placeHolder: "my-part",
        validateInput: (v) =>
          /^[a-zA-Z0-9_-]+$/.test(v) ? null : "Use only letters, numbers, dashes, underscores",
      });
      if (!name) return;

      const folder =
        vscode.workspace.workspaceFolders?.[0]?.uri ??
        vscode.Uri.file(process.cwd());
      const fileUri = vscode.Uri.joinPath(folder, `${name}.shape.ts`);

      const template = `import { drawRectangle } from "replicad";

export default function main() {
  // Create your shape here
  const shape = drawRectangle(50, 30).sketchOnPlane("XY").extrude(10);
  return shape;
}
`;

      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(template, "utf-8")
      );
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    })
  );
}
