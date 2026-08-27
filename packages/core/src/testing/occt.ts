/**
 * Real OCCT, loaded in Node, for tests that need actual geometry rather than
 * a duck-typed mock.
 *
 * Most of core's tests mock `mesh()` because they're testing policy (tolerance
 * choice, warning routing, part normalisation) and a 1.5 s WASM boot per file
 * would be pure tax. A few — face picking above all — are testing claims ABOUT
 * OCCT, and a mock could only ever confirm the assumption it was written from.
 *
 * This mirrors the loader in `packages/mcp-server/src/node-loader.ts`. It is
 * duplicated rather than shared because core must not depend on the MCP server,
 * and lifting it into a package of its own would be a lot of ceremony for
 * thirty lines that exist only for tests.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export async function loadOCCTForTest(): Promise<any> {
  const req = createRequire(import.meta.url);
  const loaderPath = req.resolve("replicad-opencascadejs/src/replicad_single.js");
  const wasmPath = join(dirname(loaderPath), "replicad_single.wasm");

  // Strip the ESM default export so the body can run inside `new Function`,
  // and inject __dirname/__filename — the Emscripten loader's Node branch
  // reads both at parse time, where a Function body has no CJS module scope.
  const loaderCode = readFileSync(loaderPath, "utf-8").replace(
    /export\s+default\s+Module\s*;?\s*$/,
    "",
  );
  const initFn = new Function(
    "__dirname",
    "__filename",
    `${loaderCode}\nreturn Module;`,
  )(dirname(loaderPath), loaderPath);

  return initFn({
    wasmBinary: readFileSync(wasmPath),
    locateFile: (f: string) => (f.endsWith(".wasm") ? wasmPath : f),
    // OCCT chatters on stdout; tests don't need it.
    print: () => {},
    printErr: () => {},
  });
}
