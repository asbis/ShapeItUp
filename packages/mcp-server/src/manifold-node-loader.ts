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
 * Looks next to `wasmDir` (the VSIX), then next to this bundle (the npm
 * package ships manifold.js + manifold.wasm in its own dist/), then falls back
 * to node_modules/manifold-3d (a dev checkout, running from source).
 *
 * The npm package doesn't depend on manifold-3d: that package declares
 * esbuild-wasm and @gltf-transform/* as peer dependencies, which npm installs
 * automatically. Through ndarray-pixels they pull in the native sharp library,
 * and together they were ~17 MB of a ~38 MB first `npx` download, for a
 * half-megabyte wasm this server is the only user of.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const require: NodeJS.Require;

export async function loadManifoldNode(wasmDir?: string): Promise<any> {
  const { createRequire } = require("module") as typeof import("node:module");
  const req = createRequire(import.meta.url);

  const bundleDir = dirname(fileURLToPath(import.meta.url));
  const shippedDir = [wasmDir, bundleDir].find(
    (dir): dir is string => !!dir && existsSync(join(dir, "manifold.wasm")),
  );

  let loaderPath: string;
  let wasmPath: string;
  if (shippedDir) {
    loaderPath = join(shippedDir, "manifold.js");
    wasmPath = join(shippedDir, "manifold.wasm");
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
