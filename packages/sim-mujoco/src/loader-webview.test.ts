/**
 * Verifies the WEBVIEW loader path: when `globalThis.__SHAPEITUP_CONFIG__`
 * supplies a `mujocoLoaderUrl` (+ `mujocoWasmUrl`), the loader imports the
 * Emscripten glue from that URL (a variable-specifier dynamic import) and points
 * Emscripten's `locateFile` at the given `.wasm`. This is exactly what the viewer
 * does — we simulate it in Node by pointing the config at the real package files,
 * so everything but the browser environment itself is exercised here.
 *
 * Kept in its own file so the loader's module-level cache starts fresh and the
 * config is read before the first `loadMujocoModule()` call.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const boxAabb = (cx: number, cy: number, cz: number, w: number, d: number, h: number) => ({
  min: [cx - w / 2, cy - d / 2, cz - h / 2] as [number, number, number],
  max: [cx + w / 2, cy + d / 2, cz + h / 2] as [number, number, number],
});

describe("MuJoCo loader — webview (config-driven URL) path", () => {
  beforeAll(() => {
    const require = createRequire(import.meta.url);
    const mujocoJs = require.resolve("@mujoco/mujoco"); // exports "." → mujoco.js
    const pkgDir = dirname(mujocoJs);
    (globalThis as { __SHAPEITUP_CONFIG__?: unknown }).__SHAPEITUP_CONFIG__ = {
      // The glue is imported by URL (Node accepts a file:// URL); the .wasm is
      // located via a filesystem path (Node Emscripten reads it with fs).
      mujocoLoaderUrl: pathToFileURL(mujocoJs).href,
      mujocoWasmUrl: resolve(pkgDir, "mujoco.wasm"),
    };
  });

  it("loads the glue from the configured URL and runs a simulation", async () => {
    const { runMujoco } = await import("./mujoco");
    const result = await runMujoco(
      {
        duration: 1,
        timestep: 1 / 120,
        gravity: [0, 0, -9810],
        bodies: [
          { id: "floor", kind: "static", aabb: boxAabb(0, 0, -10, 400, 400, 20) },
          { id: "box", kind: "dynamic", aabb: boxAabb(0, 0, 100, 20, 20, 20) },
        ],
        joints: [],
        actuators: [],
      },
      new Map(),
    );
    // The box fell from the configured-URL-loaded engine and landed on the floor.
    const finalZ = result.frames[result.frames.length - 1].poses["box"][2];
    expect(finalZ).toBeLessThan(-60);
    expect(finalZ).toBeGreaterThan(-100);
  });
});
