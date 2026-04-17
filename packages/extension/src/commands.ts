import * as vscode from "vscode";
import type { ViewerProvider } from "./viewer-provider";
import { exportToFile } from "./export";
import { exportAndOpen, findAppById, resetLaunchPrefs } from "./open-in-app";
import { getDetectedApps, rescanApps, type AppId } from "./app-detector";
import { outputChannel } from "./extension";

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

    vscode.commands.registerCommand(
      "shapeitup.openInApp",
      async (appId?: AppId) => {
        let app = appId ? findAppById(appId) : undefined;
        if (!app) {
          const detected = getDetectedApps();
          if (detected.length === 0) {
            vscode.window.showInformationMessage(
              "ShapeItUp: no compatible 3D apps detected on this machine. Install PrusaSlicer, Bambu Studio, OrcaSlicer, Cura, FreeCAD, or Fusion 360."
            );
            return;
          }
          const picked = await vscode.window.showQuickPick(
            detected.map((a) => ({
              label: a.name,
              description: `Export as ${a.preferredFormat.toUpperCase()}`,
              app: a,
            })),
            { placeHolder: "Open rendered shape in…" }
          );
          if (!picked) return;
          app = picked.app;
        }
        await exportAndOpen(viewer, app, context, outputChannel);
      }
    ),

    vscode.commands.registerCommand("shapeitup.resetLaunchPrefs", async () => {
      await resetLaunchPrefs(context);
      vscode.window.showInformationMessage(
        "ShapeItUp: cleared saved launch preferences. You'll be prompted again next time."
      );
    }),

    vscode.commands.registerCommand("shapeitup.rescanApps", () => {
      const apps = rescanApps();
      viewer.sendInstalledApps(apps);
      vscode.window.showInformationMessage(
        `ShapeItUp: detected ${apps.length} compatible app${apps.length === 1 ? "" : "s"}${apps.length ? ` (${apps.map((a) => a.name).join(", ")})` : ""}.`
      );
    }),

    vscode.commands.registerCommand("shapeitup.newShape", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Shape file name (without extension)",
        placeHolder: "my-part",
        validateInput: (v) =>
          /^[a-zA-Z0-9_-]+$/.test(v)
            ? null
            : "Use only letters, numbers, dashes, underscores",
      });
      if (!name) return;

      const folder =
        vscode.workspace.workspaceFolders?.[0]?.uri ??
        vscode.Uri.file(process.cwd());
      const fileUri = vscode.Uri.joinPath(folder, `${name}.shape.ts`);

      const template = `import { drawRectangle } from "replicad";

export const params = {
  width: 50,
  height: 30,
  depth: 10,
};

export default function main({ width, height, depth }: typeof params) {
  const shape = drawRectangle(width, height).sketchOnPlane("XY").extrude(depth);
  return shape;
}
`;

      await vscode.workspace.fs.writeFile(
        fileUri,
        Buffer.from(template, "utf-8")
      );
      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("shapeitup.setupProject", () => {
      vscode.window.showInformationMessage(
        "ShapeItUp provides replicad types automatically. If you want full autocomplete, run: npm install replicad"
      );
    })
  );
}
