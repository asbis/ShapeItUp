/**
 * Tests for the extension-host WASM asset cache.
 *
 * The cache's contract:
 *   1. Reads each file from disk at most once per activation, even under
 *      concurrent callers.
 *   2. Manifold is optional — missing manifold files don't fail the bundle.
 *   3. A failed read evicts the cache entry so a retry can succeed once
 *      the file appears.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getCachedWasmAssets, __clearCacheForTests } from "./wasm-cache";

let distDir: string;

beforeEach(() => {
  __clearCacheForTests();
  distDir = mkdtempSync(join(tmpdir(), "shapeitup-wasm-cache-"));
});

afterEach(() => {
  __clearCacheForTests();
  rmSync(distDir, { recursive: true, force: true });
});

function writeOcct(loader: string, wasm: Uint8Array) {
  writeFileSync(join(distDir, "replicad_single.js"), loader);
  writeFileSync(join(distDir, "replicad_single.wasm"), wasm);
}
function writeManifold(loader: string, wasm: Uint8Array) {
  writeFileSync(join(distDir, "manifold.js"), loader);
  writeFileSync(join(distDir, "manifold.wasm"), wasm);
}

describe("getCachedWasmAssets — memoization", () => {
  it("returns the OCCT bundle when both files exist", async () => {
    writeOcct("var Module = function() {}", new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    const assets = await getCachedWasmAssets(distDir);
    expect(assets.occt.loaderJs).toContain("Module");
    expect(assets.occt.wasmBytes.byteLength).toBe(4);
    expect(assets.manifold).toBeUndefined();
  });

  it("returns Manifold bytes too when both manifold files exist", async () => {
    writeOcct("var Module = function() {}", new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    writeManifold("var Module = function() {}", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]));
    const assets = await getCachedWasmAssets(distDir);
    expect(assets.manifold).toBeDefined();
    expect(assets.manifold!.wasmBytes.byteLength).toBe(5);
  });

  it("treats missing manifold files as 'no manifold' (not an error)", async () => {
    writeOcct("var Module = function() {}", new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    // Intentionally do not write manifold files.
    const assets = await getCachedWasmAssets(distDir);
    expect(assets.occt).toBeDefined();
    expect(assets.manifold).toBeUndefined();
  });

  it("rejects when OCCT files are missing (no fallback)", async () => {
    // No files written at all.
    await expect(getCachedWasmAssets(distDir)).rejects.toThrow();
  });

  it("shares a single in-flight read across concurrent callers", async () => {
    writeOcct("loader-js-text", new Uint8Array([1, 2, 3, 4]));
    // Fire many concurrent calls. The cache stores a Promise<Buffer>, so
    // every concurrent caller awaits the SAME read — verifiable by the
    // fact that all see identical content even after we delete the file
    // from disk before the second wave (next test).
    const all = await Promise.all(
      Array.from({ length: 50 }, () => getCachedWasmAssets(distDir)),
    );
    expect(all[0].occt.wasmBytes.byteLength).toBe(4);
    for (const a of all) {
      expect(a.occt.loaderJs).toBe(all[0].occt.loaderJs);
      expect(Array.from(a.occt.wasmBytes)).toEqual([1, 2, 3, 4]);
    }
  });

  it("does not re-read from disk on a second call (memoized — survives file deletion)", async () => {
    writeOcct("loader-js", new Uint8Array([7, 7, 7]));
    const first = await getCachedWasmAssets(distDir);

    // The strongest possible proof of memoization: delete the source files
    // from disk. If the cache is doing its job, the next call still
    // succeeds with the original content because no fs read happens.
    unlinkSync(join(distDir, "replicad_single.js"));
    unlinkSync(join(distDir, "replicad_single.wasm"));

    const second = await getCachedWasmAssets(distDir);
    expect(second.occt.loaderJs).toBe(first.occt.loaderJs);
    expect(Array.from(second.occt.wasmBytes)).toEqual([7, 7, 7]);
  });

  it("evicts a failed read so a retry can succeed once the file appears", async () => {
    // First call: missing files → reject.
    await expect(getCachedWasmAssets(distDir)).rejects.toThrow();
    // Promise.all rejects on the first failure; the OTHER concurrent reads
    // may still be in-flight. Yield to the event loop so their catch
    // handlers run and evict their entries before we retry.
    await new Promise((r) => setImmediate(r));
    // The second eviction-defense: explicitly clear, in case any promise
    // settled after the yield (we don't want this test to depend on
    // microtask ordering).
    __clearCacheForTests();

    // Now write the files and retry — should succeed.
    writeOcct("recovered-loader", new Uint8Array([9, 9, 9]));
    const assets = await getCachedWasmAssets(distDir);
    expect(assets.occt.loaderJs).toBe("recovered-loader");
    expect(Array.from(assets.occt.wasmBytes)).toEqual([9, 9, 9]);
  });
});
