/**
 * Cached loader for the MuJoCo WASM module — works in BOTH Node (MCP) and the
 * VS Code webview (viewer).
 *
 * `@mujoco/mujoco` default-exports an Emscripten module factory; calling it
 * returns a Promise that resolves once the (10 MB) `.wasm` is fetched and the
 * runtime is initialised. Like the Rapier engine caches `RAPIER.init()`, we
 * memoise the first call.
 *
 * Two environments, one code path:
 *  - **Node/MCP**: dynamically import the npm package `@mujoco/mujoco` (an
 *    OPTIONAL dependency, so nothing loads until a run actually selects MuJoCo).
 *  - **Webview/viewer**: the Emscripten glue can't be bundled into the IIFE
 *    viewer (it uses `import.meta`/`require`), so the extension copies `mujoco.js`
 *    + `mujoco.wasm` into `dist` and hands us webview URIs via a global; we import
 *    the glue from its URL and point Emscripten's `locateFile` at the `.wasm` URI.
 *
 * The import specifier is a VARIABLE on purpose: esbuild only bundles dynamic
 * imports with string-literal arguments, so a variable leaves `import(spec)` as a
 * runtime import — keeping the un-bundleable glue out of every bundle.
 */
export type MujocoModule = Awaited<ReturnType<typeof import("@mujoco/mujoco").default>>;
type MujocoFactory = typeof import("@mujoco/mujoco").default;

interface MujocoConfig {
  /** Webview URL of `mujoco.js` (the Emscripten glue) — set only in the viewer. */
  mujocoLoaderUrl?: string;
  /** Webview URL of `mujoco.wasm` — passed to Emscripten's locateFile. */
  mujocoWasmUrl?: string;
}

let modulePromise: Promise<MujocoModule> | null = null;

export function loadMujocoModule(): Promise<MujocoModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const cfg = (globalThis as { __SHAPEITUP_CONFIG__?: MujocoConfig }).__SHAPEITUP_CONFIG__;
      // Webview → the glue's URL; Node → the npm package (resolved from node_modules).
      const specifier: string = cfg?.mujocoLoaderUrl ?? "@mujoco/mujoco";

      let factory: MujocoFactory;
      try {
        const mod = (await import(/* @vite-ignore */ specifier)) as { default: MujocoFactory };
        factory = mod.default;
      } catch (err) {
        throw new Error(
          "The MuJoCo engine requires the '@mujoco/mujoco' module. In Node install the optional " +
            "package (npm i @mujoco/mujoco); in the viewer ensure mujoco.js/.wasm were copied to dist. " +
            "Or omit `engine: \"mujoco\"` to use the default engine. " +
            `Underlying error: ${(err as Error).message}`,
        );
      }

      // In the webview the `.wasm` sits at a webview URI, not beside the glue —
      // point Emscripten at it. In Node the global is absent and Emscripten finds
      // mujoco.wasm next to its own module as usual.
      const wasmUrl = cfg?.mujocoWasmUrl;
      const opts = wasmUrl
        ? { locateFile: (path: string) => (path.endsWith(".wasm") ? wasmUrl : path) }
        : undefined;
      return factory(opts);
    })();
  }
  return modulePromise;
}
