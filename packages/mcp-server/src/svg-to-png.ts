/**
 * SVG → PNG rasterizer used by render_preview's headless fallback. Wraps
 * @resvg/resvg-wasm with lazy WASM init so we only pay the ~4 MB decode cost
 * on first use (the overwhelming majority of renders go through the VS Code
 * extension and never touch this path).
 *
 * Pure WASM — no native build deps, works cross-platform, ships inside the
 * npm package and the VSIX bundle. Externalized in esbuild.config.mjs so Node
 * resolves it from node_modules at runtime instead of trying to bundle the
 * WASM blob into a giant .js file.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await import("@resvg/resvg-wasm");
      // Resolve the wasm blob relative to the package. Using createRequire
      // keeps this working under both ESM (standalone npm install) and the
      // bundled extension context where require.resolve is still available
      // via the banner we inject in esbuild.config.mjs.
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      // Package name is "@resvg/resvg-wasm"; the wasm file ships alongside
      // the JS at index_bg.wasm.
      let wasmPath: string;
      try {
        const resolved = req.resolve("@resvg/resvg-wasm");
        wasmPath = join(dirname(resolved), "index_bg.wasm");
      } catch {
        // Last-resort path relative to this module (unlikely, but keeps the
        // failure mode diagnosable).
        wasmPath = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@resvg", "resvg-wasm", "index_bg.wasm");
      }
      const wasmBytes = readFileSync(wasmPath);
      await mod.initWasm(wasmBytes);
    })().catch((e) => {
      initPromise = null;
      throw e;
    });
  }
  return initPromise;
}

export async function svgToPng(svg: string, width?: number): Promise<Buffer> {
  await ensureInit();
  const mod = await import("@resvg/resvg-wasm");
  const resvg = new mod.Resvg(svg, {
    fitTo: width ? { mode: "width", value: width } : { mode: "original" },
    background: "white",
    font: { loadSystemFonts: false },
  });
  const png = resvg.render();
  return Buffer.from(png.asPng());
}
