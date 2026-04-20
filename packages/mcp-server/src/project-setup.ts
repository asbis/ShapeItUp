/**
 * Bootstrap a ShapeItUp project directory so `.shape.ts` files get correct
 * types in editors and AI agents don't waste cycles fighting phantom TS
 * import errors from `import { ... } from "replicad"`.
 *
 * What we write:
 *   <cwd>/node_modules/shapeitup/      — .d.ts stubs for the stdlib
 *   <cwd>/node_modules/replicad/       — hand-curated .d.ts shim for replicad
 *   <cwd>/tsconfig.json                — minimal config, only if missing
 *
 * What we DON'T do:
 *   - Run `npm install` or mutate package.json. The MCP server bundles replicad
 *     and OCCT at runtime; types are all the editor needs. A real install would
 *     be 30MB of WASM we already ship.
 *   - Touch existing tsconfig.json or a real replicad install.
 *
 * Source of stub files: the npm package ships a `dist/typings/` directory next
 * to `dist/index.js`. When running from the VS Code extension bundle, the same
 * files are at `dist/typings/` next to `dist/mcp-server.mjs` (esbuild.config.mjs
 * copies them into both places).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SetupResult {
  cwd: string;
  created: string[];
  skipped: string[];
  note?: string;
}

function locateBundledTypings(): string | undefined {
  // Bundled output lives at <pkg>/dist/index.js (npm) or
  // <extension>/dist/mcp-server.mjs. Typings live alongside either one.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "typings");
    if (existsSync(candidate)) return candidate;
  } catch {}
  return undefined;
}

/**
 * Has this cwd already been bootstrapped? Cheap check: look for the
 * "bundled" marker we leave in node_modules/shapeitup/package.json.
 */
export function isProjectBootstrapped(cwd: string): boolean {
  const marker = join(cwd, "node_modules", "shapeitup", "package.json");
  if (!existsSync(marker)) return false;
  try {
    const pkg = JSON.parse(readFileSync(marker, "utf-8"));
    return typeof pkg.version === "string" && pkg.version.includes("bundled");
  } catch {
    return false;
  }
}

function writeStub(cwd: string, name: string, srcDir: string, result: SetupResult) {
  const destDir = join(cwd, "node_modules", name);
  const destIndex = join(destDir, "index.d.ts");
  const srcIndex = join(srcDir, "index.d.ts");

  if (!existsSync(srcIndex)) return;

  if (existsSync(destIndex)) {
    // Don't clobber a real npm install — check for our "bundled" marker.
    try {
      const pkg = JSON.parse(readFileSync(join(destDir, "package.json"), "utf-8"));
      if (!String(pkg.version || "").includes("bundled")) {
        result.skipped.push(`node_modules/${name} (real install detected, left alone)`);
        return;
      }
      // Same-size short-circuit so repeated calls are effectively free.
      if (statSync(srcIndex).size === statSync(destIndex).size) {
        result.skipped.push(`node_modules/${name} (up-to-date)`);
        return;
      }
    } catch {
      // Fall through and rewrite on parse error.
    }
  }

  mkdirSync(destDir, { recursive: true });
  cpSync(srcDir, destDir, { recursive: true, force: true });
  writeFileSync(
    join(destDir, "package.json"),
    JSON.stringify({ name, version: "0.0.0-bundled", types: "./index.d.ts" }, null, 2) + "\n",
  );
  result.created.push(`node_modules/${name}/`);
}

function writeMinimalTsconfig(cwd: string, result: SetupResult) {
  const tsconfig = join(cwd, "tsconfig.json");
  if (existsSync(tsconfig)) {
    result.skipped.push("tsconfig.json (already exists)");
    return;
  }
  const body = {
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
  writeFileSync(tsconfig, JSON.stringify(body, null, 2) + "\n");
  result.created.push("tsconfig.json");
}

/**
 * Idempotent. Writes stubs + tsconfig as needed; never touches a real
 * node_modules or an existing tsconfig. Returns a structured diff so the
 * caller (tool response) can describe what changed.
 */
export function setupShapeProject(cwd: string): SetupResult {
  const absCwd = resolve(cwd);
  const result: SetupResult = { cwd: absCwd, created: [], skipped: [] };

  if (!existsSync(absCwd)) {
    result.note = `Directory does not exist: ${absCwd}`;
    return result;
  }

  const typingsDir = locateBundledTypings();
  if (!typingsDir) {
    result.note =
      "Bundled typings not found next to the MCP server. " +
      "Reinstall @shapeitup/mcp-server or the VS Code extension.";
    return result;
  }

  writeStub(absCwd, "shapeitup", join(typingsDir, "shapeitup"), result);
  writeStub(absCwd, "replicad", join(typingsDir, "replicad"), result);
  writeMinimalTsconfig(absCwd, result);

  return result;
}

/**
 * Called by mutating tools (create_shape / modify_shape) to bootstrap a
 * fresh project silently on first use. Returns a short human-readable line
 * to splice into the tool's response, or undefined when nothing was done.
 */
export function autoBootstrapIfNeeded(fileOrDir: string): string | undefined {
  // Walk up from the file/dir until we find a reasonable "project root".
  // Heuristic order: first ancestor with .git, then with package.json, then
  // the file's own directory. Never write above $HOME.
  const start = statSync(fileOrDir).isDirectory() ? fileOrDir : dirname(fileOrDir);
  let candidate = start;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/";
  while (candidate && candidate !== home && candidate !== "/") {
    if (existsSync(join(candidate, ".git")) || existsSync(join(candidate, "package.json"))) {
      break;
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (!candidate || candidate === home || candidate === "/") {
    candidate = start;
  }

  if (isProjectBootstrapped(candidate)) return undefined;

  const result = setupShapeProject(candidate);
  if (result.created.length === 0) return undefined;
  return `Bootstrapped ShapeItUp types at ${candidate} (${result.created.join(", ")}).`;
}
