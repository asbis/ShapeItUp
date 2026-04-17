/**
 * Node-side OCCT WASM loader. Reads the Emscripten loader + wasm binary
 * straight from node_modules via fs and eval's the loader code in-process.
 *
 * `wasmDir` lets callers override the search path — used by the VSCode-bundled
 * copy of the MCP server, which ships the .wasm alongside the bundle rather
 * than under node_modules/.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Not an `import { createRequire } from "node:module"` — the bundler's banner
// already injects `createRequire` at the top of the bundle, and hoisted ESM
// imports collide with it. Using require("module") instead keeps both paths
// (banner-bundled and raw tsc output) happy.
declare const require: NodeJS.Require;

export async function loadOCCTNode(wasmDir?: string): Promise<any> {
  const { createRequire } = require("module") as typeof import("node:module");
  const req = createRequire(import.meta.url);

  let loaderPath: string;
  let wasmPath: string;
  if (wasmDir && existsSync(join(wasmDir, "replicad_single.wasm"))) {
    loaderPath = join(wasmDir, "replicad_single.js");
    wasmPath = join(wasmDir, "replicad_single.wasm");
  } else {
    loaderPath = req.resolve("replicad-opencascadejs/src/replicad_single.js");
    wasmPath = join(dirname(loaderPath), "replicad_single.wasm");
  }

  let loaderCode = readFileSync(loaderPath, "utf-8");
  loaderCode = loaderCode.replace(/export\s+default\s+Module\s*;?\s*$/, "");

  // The Emscripten loader's Node branch uses __dirname/__filename at parse
  // time (not lazily), so running it inside a `new Function()` — which has no
  // CJS module scope — throws ReferenceError. Inject them as formal params.
  // Values don't really matter since we pass `wasmBinary` directly and
  // override `locateFile`; we just need them to exist.
  const loaderDir = dirname(loaderPath);
  const initFn = new Function("__dirname", "__filename", `
    ${loaderCode}
    return Module;
  `)(loaderDir, loaderPath);

  if (!initFn || typeof initFn !== "function") {
    throw new Error("WASM loader did not produce a Module function");
  }

  const wasmBinary = readFileSync(wasmPath);
  return initFn({
    wasmBinary,
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmPath;
      return filename;
    },
    // OCCT writes transfer/export stats to stdout. In an MCP stdio server,
    // stdout IS the JSON-RPC channel — any unstructured print corrupts the
    // stream and breaks the client. Funnel both to stderr where it's visible
    // for debugging but doesn't interfere with protocol traffic.
    print: (msg: string) => process.stderr.write(msg + "\n"),
    printErr: (msg: string) => process.stderr.write(msg + "\n"),
  });
}
