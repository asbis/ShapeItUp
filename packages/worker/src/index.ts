/**
 * ShapeItUp Web Worker (webview context).
 *
 * Thin adapter over @shapeitup/core. The worker's job is postMessage plumbing:
 * it receives execute/export commands from the viewer, delegates to core, and
 * ships the resulting mesh data back as Transferable buffers.
 */

import { initCore, type Core, type MeshQuality } from "@shapeitup/core";
import { loadManifoldBrowser, loadOCCTBrowser } from "./browser-loader";

let core: Core | null = null;
let executing = false;
/**
 * Bug #2: the viewer's 15s watchdog terminates + restarts the worker on a
 * stuck render. The extension host typically sends the next `execute-script`
 * BEFORE the new worker has finished its async `initCore()` — and the old
 * behavior ("received 'execute' before 'init'") errored out, producing
 * phantom failures on every subsequent render. We now buffer the newest
 * pending execute (single-slot, latest-wins — an older request is stale once
 * a newer one arrives) and drain it as soon as init completes.
 */
let pendingExecute: {
  js: string;
  paramOverrides?: Record<string, number>;
  meshQuality?: MeshQuality;
} | null = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init": {
        // Cached-bytes fast path: extension shipped pre-read OCCT (and
        // optionally Manifold) bytes. The browser-loader uses `wasmBinary`
        // to skip Emscripten's internal fetch entirely, eliminating the
        // ~2s respawn cold cost. URL fields stay populated as a fallback
        // for any sidecar locateFile resolution.
        const occtCached = msg.occt?.loaderJs && msg.occt?.wasmBytes ? msg.occt : undefined;
        const manifoldCached =
          msg.manifold?.loaderJs && msg.manifold?.wasmBytes ? msg.manifold : undefined;
        if (!occtCached && !msg.wasmLoaderUrl) {
          // The viewer must supply at least one path — bytes or URLs.
          // eslint-disable-next-line no-console
          console.warn(
            "[shapeitup worker] init missing both cached OCCT bytes and fallback URLs",
          );
        }
        core = await initCore(
          () => loadOCCTBrowser(msg.wasmLoaderUrl, msg.wasmUrl, occtCached),
          manifoldCached || (msg.manifoldLoaderUrl && msg.manifoldWasmUrl)
            ? () =>
                loadManifoldBrowser(
                  msg.manifoldLoaderUrl,
                  msg.manifoldWasmUrl,
                  manifoldCached,
                )
            : undefined,
        );
        self.postMessage({ type: "ready" });
        // Drain any execute that arrived while we were initializing. Only the
        // most recent survives — older ones are superseded (the extension
        // dispatches on file-switch / save, so the newer request is the one
        // the user actually wants). If draining throws, the outer catch will
        // still post a proper error back to the viewer.
        if (pendingExecute) {
          const queued = pendingExecute;
          pendingExecute = null;
          await executeUserScript(queued.js, queued.paramOverrides, queued.meshQuality);
        }
        break;
      }
      case "execute":
        if (executing) return;
        if (!core) {
          // Init not finished yet — buffer this execute (single-slot, latest
          // wins). The init branch drains the buffer on `ready`. A Web Worker
          // can't observe its own termination, so "destroyed" is covered by
          // the fact that `worker.terminate()` in the viewer simply stops
          // delivering messages — no error path to report.
          pendingExecute = {
            js: msg.js,
            paramOverrides: msg.paramOverrides,
            meshQuality: msg.meshQuality,
          };
          return;
        }
        await executeUserScript(msg.js, msg.paramOverrides, msg.meshQuality);
        break;
      case "export":
        await handleExport(msg.format);
        break;
    }
  } catch (err: any) {
    executing = false;
    let message = err.message || String(err);
    // Preserve the original text for error-class detection (we enrich
    // `message` with diagnostic prose below, but the viewer's respawn
    // heuristic matches a specific substring).
    const isOob = /memory\s+access\s+out\s+of\s+bounds|RuntimeError:/i.test(message);
    if (/^\d+$/.test(message)) {
      message = `OpenCascade operation failed (error code ${message}). This usually means a geometry operation like fillet, chamfer, or boolean failed. Try reducing fillet radii, simplifying geometry, or checking for zero-thickness walls.`;
    } else if (/deleted|disposed|invalid\s+object/i.test(message)) {
      message = `${message}\n\nThis usually means a shape was used after it was consumed by another operation. Common causes:\n- loftWith() consumes (deletes) its input sketches — recreate them if needed after lofting\n- Shapes from a previous execution were cleaned up — store intermediate results in variables\n- A boolean or fillet operation destroyed the shape internally`;
    } else if (isOob) {
      message = `${message}\n\nWASM memory error — the OpenCascade kernel crashed. Common causes:\n- Fillet on complex geometry (many bezier segments)\n- Boolean operation on incompatible/degenerate geometry\n- Too many intermediate shapes without cleanup (use localGC)`;
    }
    if (err.operation) {
      message = `${message}\n\nFailed during: ${err.operation}`;
    }
    self.postMessage({
      type: "error",
      message,
      stack: err.stack,
      operation: err.operation,
    });
    // Explicit restart signal: once the WASM heap is corrupted every
    // subsequent OCCT call would crash in the same way until the worker is
    // terminated. The viewer already observes the "memory access out of
    // bounds" substring in `message` and calls respawnWorker(), so this
    // message is belt-and-braces — but it also gives the extension host
    // (viewer-provider) a clean signal to log without string-matching the
    // error text.
    if (isOob) {
      self.postMessage({ type: "needs-worker-restart", reason: message });
    }
  }
};

async function executeUserScript(
  js: string,
  paramOverrides?: Record<string, number>,
  meshQuality?: MeshQuality,
) {
  if (!core) {
    // Bug #2: with the pending-execute queue in place the only way to reach
    // this branch is internal programmer error. Preserve the old message for
    // existing log-grep workflows.
    throw new Error("Worker received 'execute' before 'init' completed");
  }
  executing = true;
  try {
    const result = await core.execute(js, paramOverrides, {
      onStart: (totalParts) => {
        self.postMessage({ type: "mesh-start", totalParts });
      },
      onPart: (part, index, total) => {
        self.postMessage(
          { type: "mesh-part", index, total, part },
          [
            part.vertices.buffer,
            part.normals.buffer,
            part.triangles.buffer,
            part.edgeVertices.buffer,
          ] as any,
        );
      },
      // P3-10: optional tessellation-quality knob. Undefined means "let core
      // auto-degrade based on part count" — preserves the pre-P3-10 default.
      meshQuality,
    });

    self.postMessage({
      type: "mesh-done",
      params: result.params,
      execTimeMs: result.execTimeMs,
      tessTimeMs: result.tessTimeMs,
      timings: result.timings,
      warnings: result.warnings,
      geometryValid: result.geometryValid,
    });
  } finally {
    executing = false;
  }
}

async function handleExport(format: "step" | "stl") {
  if (!core) throw new Error("Worker received 'export' before 'init' completed");
  const data = await core.exportLast(format);
  self.postMessage({ type: "export-result", format, data }, [data] as any);
}
