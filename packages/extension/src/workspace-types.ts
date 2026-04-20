/**
 * Workspace type-stub installation helpers.
 *
 * Extracted from extension.ts so the pure-fs logic can be unit-tested under
 * vitest (which has no `vscode` module available). The extension activation
 * code wraps these with `vscode.workspace.findFiles` + the output channel.
 *
 * Behavior: given a workspace root and the extension's bundled typings
 * directory, write lightweight `node_modules/shapeitup` and
 * `node_modules/replicad` stubs so TypeScript's default module resolution
 * finds types from any `.shape.ts` in any subfolder, with zero tsconfig.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Write a stub package (recursive copy of the bundled typings directory) at
 * `<wsRoot>/node_modules/<name>/`. Returns true when the stub was (re)written.
 *
 * Skipped when the existing destination looks up-to-date: same `index.d.ts`
 * size AND a `package.json` containing our "bundled" marker. The marker is
 * how we avoid clobbering a real npm install that happens to match sizes.
 */
export function installStub(
  wsRoot: string,
  name: string,
  srcDir: string
): boolean {
  const destDir = path.join(wsRoot, "node_modules", name);
  const srcIndex = path.join(srcDir, "index.d.ts");
  const destIndex = path.join(destDir, "index.d.ts");

  if (!fs.existsSync(srcIndex)) return false;

  // Cheap content-equality check: index.d.ts size match + package.json marker.
  // For generated .d.ts the size changes whenever the stdlib API changes.
  const destPkg = path.join(destDir, "package.json");
  let sameSize = false;
  try {
    if (fs.existsSync(destIndex)) {
      const srcStat = fs.statSync(srcIndex);
      const destStat = fs.statSync(destIndex);
      sameSize = srcStat.size === destStat.size;
    }
  } catch {
    sameSize = false;
  }

  if (sameSize && fs.existsSync(destPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(destPkg, "utf-8"));
      // Our stubs always carry a "bundled" version tag — anything else we
      // treat as a real install and leave untouched.
      if (typeof pkg.version === "string" && pkg.version.includes("bundled")) {
        return false;
      }
      if (!String(pkg.version || "").includes("bundled")) {
        return false;
      }
    } catch {
      // Unparseable — fall through and rewrite to recover.
    }
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });

  // Always overwrite package.json with our bundled marker so future
  // activations can detect it's our stub and avoid pointless rewrites.
  const pkg = {
    name,
    version: "0.0.0-bundled",
    types: "./index.d.ts",
  };
  fs.writeFileSync(destPkg, JSON.stringify(pkg, null, 2) + "\n");

  return true;
}

/**
 * True when the workspace's package.json declares `replicad` as a runtime or
 * dev dependency. Used to avoid shadowing a real install with our stub.
 * Returns false on any missing/parse error — safe default is to install the
 * stub (the user clearly doesn't have replicad yet).
 */
export function workspaceHasReplicadDependency(wsRoot: string): boolean {
  const pkgPath = path.join(wsRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const deps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };
    return Object.prototype.hasOwnProperty.call(deps, "replicad");
  } catch {
    return false;
  }
}

/**
 * Write the minimal `.shape.ts`-friendly tsconfig.json at the workspace root
 * only when none exists. Returns true when we actually wrote the file.
 *
 * The config is intentionally permissive (strict: false, noImplicitAny:
 * false) because .shape.ts files are short scripts, not production modules.
 * skipLibCheck: true avoids noise from the bundled replicad typings.
 */
export function ensureMinimalTsconfig(wsRoot: string): boolean {
  const tsconfigPath = path.join(wsRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) return false;

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      strict: false,
      noImplicitAny: false,
      skipLibCheck: true,
    },
    include: ["**/*.shape.ts"],
  };
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");
  return true;
}
