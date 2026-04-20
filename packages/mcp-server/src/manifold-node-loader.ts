/**
 * Node-side Manifold WASM loader — parallel to node-loader.ts for OCCT.
 *
 * manifold.js ships as a proper ES module with `export default Module`, so we
 * load it via dynamic `import()` of its file:// URL (unlike OCCT's loader,
 * which only exists as a parse-time script and has to be eval'd). The wasm
 * binary is read from disk and handed to the Emscripten Module factory via
 * `wasmBinary` so Manifold never tries to resolve the .wasm itself — this
 * sidesteps the CJS require path inside manifold.js's Node branch, which
 * doesn't play nicely with the bundled MCP server.
 *
 * Falls back to node_modules/manifold-3d when no wasmDir is supplied (same
 * rule as loadOCCTNode: VSCode-bundled copy uses the co-located dist files,
 * standalone npm installs resolve through node_modules).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

declare const require: NodeJS.Require;

export async function loadManifoldNode(wasmDir?: string): Promise<any> {
  const { createRequire } = require("module") as typeof import("node:module");
  const req = createRequire(import.meta.url);

  let loaderPath: string;
  let wasmPath: string;
  if (wasmDir && existsSync(join(wasmDir, "manifold.wasm"))) {
    loaderPath = join(wasmDir, "manifold.js");
    wasmPath = join(wasmDir, "manifold.wasm");
  } else {
    loaderPath = req.resolve("manifold-3d/manifold.js");
    wasmPath = join(dirname(loaderPath), "manifold.wasm");
  }

  if (!existsSync(loaderPath) || !existsSync(wasmPath)) {
    throw new Error(
      `manifold loader/wasm not found (loader=${loaderPath}, wasm=${wasmPath})`,
    );
  }

  // Dynamic import of the ES module — no eval, no new Function() tricks.
  // esbuild keeps dynamic import() call strings as-is, so the bundled MCP
  // server resolves this at runtime against the real file URL.
  const loaderModule: any = await import(pathToFileURL(loaderPath).href);
  const initFn = loaderModule?.default;

  if (typeof initFn !== "function") {
    throw new Error(
      "manifold.js loaded but default export is not a Module factory",
    );
  }

  const wasmBinary = readFileSync(wasmPath);
  const instance = await initFn({
    wasmBinary,
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmPath;
      return filename;
    },
    // Same rationale as loadOCCTNode: MCP's stdout is the JSON-RPC channel,
    // so any Emscripten printf would corrupt the protocol. Funnel to stderr.
    print: (msg: string) => process.stderr.write(msg + "\n"),
    printErr: (msg: string) => process.stderr.write(msg + "\n"),
  });

  // Manifold requires an explicit setup() call after the Module resolves
  // (initializes TBB thread pool + JS-side helper functions). The browser
  // loader is handled by replicad internally; we need to invoke it here
  // because we're bypassing replicad's normal browser-path plumbing.
  if (typeof instance.setup === "function") {
    instance.setup();
  }

  return instance;
}
