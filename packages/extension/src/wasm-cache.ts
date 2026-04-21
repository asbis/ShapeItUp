/**
 * WASM asset cache (extension host).
 *
 * The OCCT WASM kernel ships as a ~1.2MB JS loader + a ~12MB .wasm file. Every
 * worker (re)spawn used to re-fetch and re-evaluate both — a ~2 second cold
 * cost that hits whenever the watchdog respawns the worker after a memory
 * error or timeout.
 *
 * The extension host (Node.js) persists across webview reloads AND across
 * worker respawns, so reading the bytes ONCE here and shipping them through
 * the webview→worker init handshake eliminates the recurring fetch+eval cost.
 *
 * The cache lives for the lifetime of the extension activation. It memoizes
 * per (loaderFile, wasmFile) pair so manifold and OCCT can share the same
 * machinery.
 *
 * Trade-offs:
 * - Memory: ~13MB held in extension-host memory permanently. Acceptable —
 *   the alternative is paying the fetch cost on every respawn.
 * - First render is still cold: the extension kicks the load off eagerly on
 *   activation (see extension.ts), but if the user opens a shape file
 *   before the cache resolves, the worker falls back to URL fetch. This is
 *   the same cost the user paid before the cache existed.
 */

import * as fs from "fs/promises";
import * as path from "path";

/**
 * In-memory cache. Key is the absolute path of the asset file. Stored as a
 * Promise so concurrent callers share the same in-flight read instead of
 * racing to do the I/O twice.
 */
const cache = new Map<string, Promise<Buffer>>();

/**
 * Read a file once, memoize the resulting Buffer for the lifetime of the
 * extension activation. Concurrent callers awaiting the same path share the
 * same promise; later callers get the cached Buffer immediately.
 *
 * On read error, the failed promise is removed from the cache so a retry
 * can succeed (e.g. if the file appears later).
 */
async function readOnce(absPath: string): Promise<Buffer> {
  const existing = cache.get(absPath);
  if (existing) return existing;
  const promise = fs.readFile(absPath).catch((err) => {
    cache.delete(absPath);
    throw err;
  });
  cache.set(absPath, promise);
  return promise;
}

/**
 * Bundled WASM assets for one Emscripten kernel (OCCT or Manifold).
 *
 * `loaderJs` is the full Emscripten loader JS as text — the worker eval's
 * this directly, skipping the cold fetch. `wasmBytes` is the raw WASM binary;
 * the worker passes it to the Emscripten module factory as `wasmBinary` so
 * Emscripten skips its own internal `fetch(wasm)` call.
 */
export interface CachedWasmAssets {
  loaderJs: string;
  wasmBytes: Uint8Array;
}

/**
 * Bundled assets for the OCCT (replicad) kernel and the optional Manifold
 * kernel. Both are read from the extension's `dist/` directory, which the
 * build pipeline populates with `replicad_single.{js,wasm}` and
 * `manifold.{js,wasm}` (see esbuild.config.mjs's copyWasmFiles()).
 */
export interface AllWasmAssets {
  occt: CachedWasmAssets;
  /**
   * Manifold is optional: shapes that don't use mesh-native threads never
   * load it. If the bundled files are missing (older VSIX, partial install)
   * the field is undefined and the worker silently skips initialization.
   */
  manifold?: CachedWasmAssets;
}

/**
 * Fetch (and cache) every WASM asset the worker may need. Safe to call many
 * times — repeat calls within one activation reuse the in-memory Buffers.
 *
 * `distDir` is the extension's `dist/` directory (where esbuild writes its
 * output). The caller is responsible for resolving it from the extension's
 * own URI; this module is intentionally vscode-free for testability.
 */
export async function getCachedWasmAssets(distDir: string): Promise<AllWasmAssets> {
  const occtLoaderPath = path.join(distDir, "replicad_single.js");
  const occtWasmPath = path.join(distDir, "replicad_single.wasm");
  const manifoldLoaderPath = path.join(distDir, "manifold.js");
  const manifoldWasmPath = path.join(distDir, "manifold.wasm");

  const [occtLoader, occtWasm] = await Promise.all([
    readOnce(occtLoaderPath),
    readOnce(occtWasmPath),
  ]);
  const occt: CachedWasmAssets = {
    loaderJs: occtLoader.toString("utf-8"),
    wasmBytes: new Uint8Array(occtWasm),
  };

  // Manifold is best-effort: an older VSIX may ship without it, and shapes
  // that don't use mesh-native threads never need it. Treat any read error
  // as "no manifold" rather than failing the whole asset bundle.
  let manifold: CachedWasmAssets | undefined;
  try {
    const [manifoldLoader, manifoldWasm] = await Promise.all([
      readOnce(manifoldLoaderPath),
      readOnce(manifoldWasmPath),
    ]);
    manifold = {
      loaderJs: manifoldLoader.toString("utf-8"),
      wasmBytes: new Uint8Array(manifoldWasm),
    };
  } catch {
    manifold = undefined;
  }

  return { occt, manifold };
}

/**
 * Test-only: clear the in-memory cache. Production code should never need
 * this — the cache is bound to the extension activation lifetime.
 */
export function __clearCacheForTests(): void {
  cache.clear();
}
