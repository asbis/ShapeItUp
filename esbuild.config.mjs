import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

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

// 4. MCP Server (Node.js, ESM) — standalone
const mcpServerConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/mcp-server/src/index.ts")],
  outfile: resolve(__dirname, "packages/mcp-server/dist/index.js"),
  platform: "node",
  format: "esm",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  external: ["esbuild"],
};

// 5. MCP Server copy bundled into extension dist (for auto-discovery)
// This must be fully self-contained — no external dependencies
const mcpServerExtConfig = {
  ...sharedConfig,
  entryPoints: [resolve(__dirname, "packages/mcp-server/src/index.ts")],
  outfile: resolve(__dirname, "packages/extension/dist/mcp-server.js"),
  platform: "node",
  format: "cjs",
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
}

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
