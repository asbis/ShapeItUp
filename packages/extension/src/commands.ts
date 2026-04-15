import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
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

      // Auto-setup project if tsconfig/types are missing
      await ensureProjectSetup(folder);

      const doc = await vscode.workspace.openTextDocument(fileUri);
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand("shapeitup.setupProject", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!folder) {
        vscode.window.showWarningMessage("Open a folder first.");
        return;
      }
      await ensureProjectSetup(folder);
      vscode.window.showInformationMessage(
        "ShapeItUp: Project configured — replicad types installed."
      );
    })
  );
}

/**
 * Ensure the current project has replicad types so .shape.ts files
 * don't show "Cannot find module 'replicad'" errors in the editor.
 */
async function ensureProjectSetup(folder: vscode.Uri) {
  const folderPath = folder.fsPath;

  // Check if replicad is already installed
  const nodeModulesReplicad = path.join(
    folderPath,
    "node_modules",
    "replicad"
  );
  if (fs.existsSync(nodeModulesReplicad)) return;

  // Check if package.json exists
  const pkgPath = path.join(folderPath, "package.json");
  const hasPkg = fs.existsSync(pkgPath);

  if (!hasPkg) {
    // Create a minimal package.json
    const pkg = {
      private: true,
      dependencies: {
        replicad: "^0.23.0",
      },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  } else {
    // Add replicad to existing package.json if not there
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      if (!pkg.dependencies?.replicad && !pkg.devDependencies?.replicad) {
        pkg.dependencies = pkg.dependencies || {};
        pkg.dependencies.replicad = "^0.23.0";
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      } else {
        return; // already has replicad
      }
    } catch {
      return;
    }
  }

  // Create tsconfig.json if missing (with strict: false for .shape.ts convenience)
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

  // Run npm install to get the types
  const terminal = vscode.window.createTerminal({
    name: "ShapeItUp Setup",
    cwd: folderPath,
  });
  terminal.sendText("npm install --save replicad && exit");
  terminal.show();
}
