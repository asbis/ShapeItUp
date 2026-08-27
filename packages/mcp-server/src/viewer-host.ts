/**
 * Browser viewer host — the MCP server's own copy of the live 3D preview.
 *
 * Historically the only interactive viewer was the VSCode webview, reachable
 * over the SubscriberBus. This module runs the SAME viewer bundle over plain
 * HTTP inside this process, so any browser (notably the Claude Code browser
 * pane) is a first-class viewer target with no editor involved.
 *
 * It registers as a LOCAL bus subscriber, which means every existing
 * `publishEvent` call site — set_render_mode, toggle_dimensions, open_shape —
 * reaches browser viewers with no changes at those call sites.
 */
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild-wasm";
import { ViewerHost, type ViewerAssetName, type ViewerAssetResolver } from "@shapeitup/serve";
import { shapeBundleOptions } from "@shapeitup/shared";
import { ensureEsbuild } from "./engine.js";
import { getSubscriberBus, defaultGlobalStorageDir } from "./subscriber-bus.js";
import type { LocalSubscription } from "./subscriber-bus.js";

const MCP_SERVER_VERSION: string = process.env.SHAPEITUP_MCP_VERSION ?? "0.0.0-dev";

/**
 * Bundle with `esbuild-wasm`, the flavour this package already ships.
 * Native esbuild can't be bundled into the published npm package, so the
 * ViewerHost takes this injected rather than importing one itself.
 */
async function bundleWithWasm(absPath: string): Promise<string> {
  await ensureEsbuild();
  const dir = dirname(absPath);
  const result = await esbuild.build(
    shapeBundleOptions(absPath, dir, join) as esbuild.BuildOptions & { write: false },
  );
  return result.outputFiles![0].text;
}

/**
 * Locate the browser assets the viewer page fetches.
 *
 * Two layouts to satisfy, and they are genuinely different:
 *
 *   VSIX      — everything co-located: `mcp-server.mjs` sits in `extension/dist`
 *               next to viewer.js, worker.js and all the .wasm files.
 *   npm       — `dist/` carries only the two browser bundles we build
 *               (viewer.js + worker.js, ~1.3 MB gzipped). The WASM comes from
 *               `replicad-opencascadejs` / `manifold-3d` / `@mujoco/mujoco`,
 *               which npm has already installed as ordinary dependencies.
 *               Copying them into the tarball would add ~7 MB gzipped of exact
 *               duplicates of files that are on disk anyway.
 *
 * `SHAPEITUP_VIEWER_DIST` overrides everything, for a dev checkout or an
 * unusual install layout.
 */
const NODE_MODULE_ASSETS: Partial<Record<ViewerAssetName, string>> = {
  "replicad_single.js": "replicad-opencascadejs/src/replicad_single.js",
  "replicad_single.wasm": "replicad-opencascadejs/src/replicad_single.wasm",
  "manifold.js": "manifold-3d/manifold.js",
  "manifold.wasm": "manifold-3d/manifold.wasm",
  "mujoco.js": "@mujoco/mujoco/dist/mujoco.js",
  "mujoco.wasm": "@mujoco/mujoco/dist/mujoco.wasm",
};

// The bundler's banner injects `createRequire`; a hoisted ESM import of it
// would collide. Same reasoning as node-loader.ts.
declare const require: NodeJS.Require;

export function createAssetResolver(): ViewerAssetResolver {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [process.env.SHAPEITUP_VIEWER_DIST, here].filter((r): r is string => !!r);
  const { createRequire } = require("module") as typeof import("node:module");
  const req = createRequire(import.meta.url);

  return (name) => {
    for (const root of roots) {
      const p = join(root, name);
      if (existsSync(p)) return p;
    }
    const spec = NODE_MODULE_ASSETS[name];
    if (!spec) return undefined;
    try {
      // `.wasm` isn't resolvable as a module in every Node version — resolve
      // the sibling .js and swap the extension.
      if (spec.endsWith(".wasm")) {
        const js = req.resolve(spec.replace(/\.wasm$/, ".js"));
        const wasm = js.replace(/\.js$/, ".wasm");
        return existsSync(wasm) ? wasm : undefined;
      }
      return req.resolve(spec);
    } catch {
      return undefined;
    }
  };
}

let host: ViewerHost | null = null;
let subscription: LocalSubscription | null = null;

export function getViewerHost(): ViewerHost | null {
  return host;
}

export interface StartViewerResult {
  url: string;
  port: number;
  file: string;
  /** Viewers already attached — 0 on a cold start, until a browser opens the URL. */
  clients: number;
  alreadyRunning: boolean;
}

/**
 * Start (or re-target) the browser viewer. Idempotent: a second call with a
 * different file swaps the file over rather than binding a second port.
 */
export async function startViewer(
  filePath: string,
  port?: number,
): Promise<StartViewerResult> {
  const alreadyRunning = host !== null;
  if (!host) {
    host = new ViewerHost({
      resolveAsset: createAssetResolver(),
      port,
      bundle: bundleWithWasm,
      log: (line) => process.stderr.write(`[shapeitup-viewer] ${line}\n`),
    });
    await host.start();
    attachToBus();
  }

  await host.setFile(filePath);
  return {
    url: host.url,
    port: host.port,
    file: host.file!,
    clients: host.clientCount,
    alreadyRunning,
  };
}

export function stopViewer(): void {
  subscription?.dispose();
  subscription = null;
  host?.stop();
  host = null;
}

/**
 * Mirror the bus events the VSCode extension handles (see
 * `extension.ts:handleBusEvent`) onto browser viewers. Keeping the two
 * handlers behaviourally identical is what lets a tool like `set_render_mode`
 * stay unaware of which viewer is attached.
 */
function attachToBus(): void {
  if (subscription) return;
  const bus = getSubscriberBus(defaultGlobalStorageDir(), MCP_SERVER_VERSION);
  // The viewer host is not scoped to a workspace: it serves whatever file it
  // was pointed at. An empty roots list means untargeted publishes reach it
  // while `targetWorkspaceRoot`-scoped ones (which are meant for a specific
  // editor window) do not.
  subscription = bus.addLocalSubscriber([], (msg, reply) => {
    const h = host;
    if (!h) {
      reply(false, "viewer host stopped");
      return;
    }
    try {
      switch (msg.event) {
        case "set-render-mode":
          h.sendViewerCommand("set-render-mode", { mode: msg.mode });
          reply(true);
          return;
        case "toggle-dimensions":
          h.sendViewerCommand("toggle-dimensions", { show: msg.show });
          reply(true);
          return;
        case "open-shape":
          if (typeof msg.filePath !== "string") {
            reply(false, "missing filePath");
            return;
          }
          void h.setFile(msg.filePath).then(
            () => reply(true),
            (e: any) => reply(false, String(e?.message ?? e)),
          );
          return;
        case "app-opened":
          reply(true);
          return;
        default:
          // Match the extension: ok=false lets publishAndAwait callers detect
          // version skew, and is silently dropped for fire-and-forget events.
          reply(false, `unknown event: ${msg.event}`);
      }
    } catch (e: any) {
      reply(false, String(e?.message ?? e));
    }
  });
}
