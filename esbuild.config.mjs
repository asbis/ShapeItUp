import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync, writeFileSync, rmSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// Read the mcp-server package.json version at build time so the value baked
// into the bundle always matches what npm publishes. Avoids a stale hardcoded
// string in index.ts and avoids a runtime readFileSync on every boot.
const mcpServerPkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "packages/mcp-server/package.json"), "utf8"),
).version;

const sharedConfig = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
};

// 1. Extension host (Node.js, CJS)
const extensionConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/extension/src/extension.ts")],
  outfile: resolve(__dirname, "packages/extension/dist/extension.js"),
  platform: "node",
  format: "cjs",
  external: ["vscode", "esbuild-wasm"],
};

// 2. Viewer (browser, IIFE)
const viewerConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/viewer/src/index.ts")],
  outfile: resolve(__dirname, "packages/extension/dist/viewer.js"),
  platform: "browser",
  format: "iife",
  globalName: "ShapeItUpViewer",
};

// 3. Worker (browser, IIFE)
const workerConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/worker/src/index.ts")],
  outfile: resolve(__dirname, "packages/extension/dist/worker.js"),
  platform: "browser",
  format: "iife",
  globalName: "ShapeItUpWorker",
  // replicad-opencascadejs is loaded at runtime via importScripts, not bundled
  external: ["replicad-opencascadejs"],
  // replicad has conditional requires for Node.js fs/path — stub them out for browser
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  alias: {
    fs: resolve(__dirname, "packages/worker/src/stubs/empty.ts"),
    path: resolve(__dirname, "packages/worker/src/stubs/empty.ts"),
  },
};

// replicad-opencascadejs ships a ~30 MB WASM loader that would blow up the
// bundle — keep it external so it loads from node_modules at runtime.
const mcpExternal = ["esbuild-wasm", "replicad-opencascadejs", "@resvg/resvg-wasm"];

// Compile-time constants injected into BOTH mcp-server bundles so the
// serverInfo advertised over MCP tracks packages/mcp-server/package.json
// without a runtime readFileSync.
const mcpDefine = {
  "process.env.SHAPEITUP_MCP_VERSION": JSON.stringify(mcpServerPkgVersion),
};

// 4. MCP Server (Node.js, ESM) — standalone
const mcpServerConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/mcp-server/src/index.ts")],
  outfile: resolve(__dirname, "packages/mcp-server/dist/index.js"),
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: mcpExternal,
  define: mcpDefine,
};

// 5. MCP Server copy bundled into extension dist (for auto-discovery).
// Emitted as .mjs/ESM so import.meta.url works for module resolution (the
// extension's own package.json is CJS, so we can't just set "type": "module").
const mcpServerExtConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/mcp-server/src/index.ts")],
  outfile: resolve(__dirname, "packages/extension/dist/mcp-server.mjs"),
  platform: "node",
  format: "esm",
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: mcpExternal,
  define: mcpDefine,
};

function copyWasmFiles() {
  const distDir = resolve(__dirname, "packages/extension/dist");
  mkdirSync(distDir, { recursive: true });

  // Copy replicad-opencascadejs WASM and JS loader to extension dist
  // Try multiple possible locations (pnpm hoists differently)
  const candidates = [
    resolve(__dirname, "node_modules/replicad-opencascadejs/src"),
    resolve(__dirname, "packages/worker/node_modules/replicad-opencascadejs/src"),
    resolve(__dirname, "node_modules/.pnpm/replicad-opencascadejs@0.23.0/node_modules/replicad-opencascadejs/src"),
  ];
  let replicadOcctDir = candidates.find((d) => existsSync(d)) || candidates[0];
  if (existsSync(replicadOcctDir)) {
    for (const file of ["replicad_single.js", "replicad_single.wasm"]) {
      const src = resolve(replicadOcctDir, file);
      if (existsSync(src)) {
        cpSync(src, resolve(distDir, file));
        console.log(`Copied ${file} to dist/`);
      }
    }
  } else {
    console.warn(
      "Warning: replicad-opencascadejs not found. Run pnpm install first."
    );
  }

  // Copy manifold-3d loader + WASM — used for mesh-level boolean ops on
  // thread ridges (OCCT's B-spline boolean is too slow in WASM for long
  // helical cuts).
  const manifoldCandidates = [
    resolve(__dirname, "node_modules/manifold-3d"),
    resolve(__dirname, "node_modules/.pnpm/manifold-3d@3.4.1/node_modules/manifold-3d"),
  ];
  const manifoldDir = manifoldCandidates.find((d) => existsSync(d));
  if (manifoldDir) {
    for (const file of ["manifold.js", "manifold.wasm"]) {
      const src = resolve(manifoldDir, file);
      if (existsSync(src)) {
        cpSync(src, resolve(distDir, file));
        console.log(`Copied ${file} to dist/`);
      }
    }
  } else {
    console.warn("Warning: manifold-3d not found — mesh-native threads disabled.");
  }
}

/**
 * Bundle type definitions used by `.shape.ts` autocomplete into the
 * extension's dist/typings/. On activation the extension copies these into
 * the user's workspace node_modules so TypeScript resolves `replicad` and
 * `shapeitup` imports from ANY subfolder without manual tsconfig setup.
 *
 * - replicad types: hand-curated shim at packages/extension/typings/replicad,
 *   copied verbatim.
 * - shapeitup types: generated from the live stdlib source via `tsc
 *   --emitDeclarationOnly` so the bundled .d.ts tracks the actual runtime
 *   API without a per-release sync step. The wrapper index.d.ts re-exports
 *   from the generated declarations, making the package self-contained.
 */
function copyExtensionTypings() {
  const typingsSrc = resolve(__dirname, "packages/extension/typings");
  const typingsDest = resolve(__dirname, "packages/extension/dist/typings");
  mkdirSync(typingsDest, { recursive: true });

  // replicad: straight copy of the hand-curated shim.
  const replicadSrc = resolve(typingsSrc, "replicad");
  const replicadDest = resolve(typingsDest, "replicad");
  if (existsSync(replicadSrc)) {
    mkdirSync(replicadDest, { recursive: true });
    cpSync(resolve(replicadSrc, "index.d.ts"), resolve(replicadDest, "index.d.ts"));
    cpSync(resolve(replicadSrc, "package.json"), resolve(replicadDest, "package.json"));
    console.log("Copied replicad typings to dist/typings/replicad/");
  } else {
    console.warn("Warning: packages/extension/typings/replicad not found.");
  }

  // shapeitup: emit .d.ts for every stdlib source file via tsc, then write a
  // tiny wrapper + package.json around them.
  const stdlibSrc = resolve(__dirname, "packages/core/src/stdlib");
  const shapeitupDest = resolve(typingsDest, "shapeitup");
  const stdlibDestDir = resolve(shapeitupDest, "stdlib");
  if (existsSync(stdlibSrc)) {
    mkdirSync(stdlibDestDir, { recursive: true });

    const tmpTsconfig = resolve(__dirname, "packages/extension/.tsconfig.typings.tmp.json");
    const tsconfig = {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        strict: false,
        skipLibCheck: true,
        declaration: true,
        emitDeclarationOnly: true,
        noEmit: false,
        composite: false,
        incremental: false,
        outDir: stdlibDestDir,
        rootDir: stdlibSrc,
        lib: ["ES2022", "DOM"],
      },
      include: [stdlibSrc.replace(/\\/g, "/") + "/**/*.ts"],
      exclude: [stdlibSrc.replace(/\\/g, "/") + "/**/*.test.ts"],
    };
    writeFileSync(tmpTsconfig, JSON.stringify(tsconfig, null, 2));

    try {
      // --pretty false keeps the output parseable in CI logs.
      execSync(`node node_modules/typescript/bin/tsc --project ${tmpTsconfig} --pretty false`, {
        cwd: __dirname,
        stdio: "inherit",
      });
      console.log("Generated shapeitup stdlib declarations into dist/typings/shapeitup/stdlib/");
    } catch (e) {
      console.warn(`Warning: tsc failed to emit shapeitup stdlib declarations (${e?.message ?? e}). Falling back to re-export shim.`);
    } finally {
      try { rmSync(tmpTsconfig, { force: true }); } catch {}
    }

    // Wrapper index.d.ts — re-exports everything from the emitted stdlib.
    // Matches packages/extension/typings/shapeitup/index.d.ts but self-
    // contained (no relative path out to the core source).
    const wrapper = `// Auto-generated by ShapeItUp build. Do not edit.\n// Re-exports the stdlib declarations bundled alongside this file.\nexport * from "./stdlib/index";\n`;
    writeFileSync(resolve(shapeitupDest, "index.d.ts"), wrapper);

    const pkg = {
      name: "shapeitup",
      version: "0.0.0-bundled",
      types: "./index.d.ts",
    };
    writeFileSync(resolve(shapeitupDest, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    console.log("Wrote shapeitup wrapper package into dist/typings/shapeitup/");
  } else {
    console.warn("Warning: packages/core/src/stdlib not found — skipping shapeitup typings.");
  }
}

/**
 * Duplicate the bundled typings into packages/mcp-server/dist/typings/ so the
 * npm-published @shapeitup/mcp-server can bootstrap fresh projects without
 * depending on the VSIX install. The extension build already emits them into
 * packages/extension/dist/typings/ — this mirrors that output next to
 * packages/mcp-server/dist/index.js for the standalone install.
 */
function copyTypingsToMcpServer() {
  const src = resolve(__dirname, "packages/extension/dist/typings");
  const dest = resolve(__dirname, "packages/mcp-server/dist/typings");
  if (!existsSync(src)) {
    console.warn("Warning: extension/dist/typings not generated — mcp-server bootstrap will fail.");
    return;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true, force: true });
  console.log("Copied typings to packages/mcp-server/dist/typings/");
}

/**
 * Duplicate typings into the extension's dist as well (for the VSIX-bundled
 * mcp-server.mjs). Already lives at packages/extension/dist/typings thanks to
 * copyExtensionTypings() — nothing extra to do there.
 */

function copySkillFiles() {
  // Bundle the Claude Code skill with the extension so it can be installed
  // on activation (~/.claude/skills/shapeitup/SKILL.md).
  const src = resolve(__dirname, "skill/SKILL.md");
  const destDir = resolve(__dirname, "packages/extension/dist/skill");
  if (existsSync(src)) {
    mkdirSync(destDir, { recursive: true });
    cpSync(src, resolve(destDir, "SKILL.md"));
    console.log("Copied skill/SKILL.md to dist/skill/");
  } else {
    console.warn("Warning: skill/SKILL.md not found — skill will not be installable.");
  }
}

async function build() {
  copyWasmFiles();
  copySkillFiles();
  copyExtensionTypings();
  copyTypingsToMcpServer();

  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(viewerConfig),
      esbuild.context(workerConfig),
      esbuild.context(mcpServerConfig),
      esbuild.context(mcpServerExtConfig),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("Watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(viewerConfig),
      esbuild.build(workerConfig),
      esbuild.build(mcpServerConfig),
      esbuild.build(mcpServerExtConfig),
    ]);
    console.log("Build complete.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
