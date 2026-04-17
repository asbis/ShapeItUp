/**
 * ShapeItUp Web Worker (webview context).
 *
 * Thin adapter over @shapeitup/core. The worker's job is postMessage plumbing:
 * it receives execute/export commands from the viewer, delegates to core, and
 * ships the resulting mesh data back as Transferable buffers.
 */

import { initCore, type Core } from "@shapeitup/core";
import { loadOCCTBrowser } from "./browser-loader";

let core: Core | null = null;
let executing = false;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init":
        core = await initCore(() => loadOCCTBrowser(msg.wasmLoaderUrl, msg.wasmUrl));
        self.postMessage({ type: "ready" });
        break;
      case "execute":
        if (executing) return;
        await executeUserScript(msg.js, msg.paramOverrides);
        break;
      case "export":
        await handleExport(msg.format);
        break;
    }
  } catch (err: any) {
    executing = false;
    let message = err.message || String(err);
    if (/^\d+$/.test(message)) {
      message = `OpenCascade operation failed (error code ${message}). This usually means a geometry operation like fillet, chamfer, or boolean failed. Try reducing fillet radii, simplifying geometry, or checking for zero-thickness walls.`;
    } else if (/deleted|disposed|invalid\s+object/i.test(message)) {
      message = `${message}\n\nThis usually means a shape was used after it was consumed by another operation. Common causes:\n- loftWith() consumes (deletes) its input sketches — recreate them if needed after lofting\n- Shapes from a previous execution were cleaned up — store intermediate results in variables\n- A boolean or fillet operation destroyed the shape internally`;
    } else if (/memory\s+access\s+out\s+of\s+bounds|RuntimeError:/i.test(message)) {
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
  }
};

async function executeUserScript(js: string, paramOverrides?: Record<string, number>) {
  if (!core) throw new Error("Worker received 'execute' before 'init' completed");
  executing = true;
  try {
    const result = await core.execute(js, paramOverrides);

    // Strip the live OCCT shape handle — not transferable; the viewer only
    // needs the tessellated mesh arrays.
    const tessellated = result.parts.map(({ shape: _shape, ...rest }) => rest);

    const transferables: ArrayBuffer[] = [];
    for (const t of tessellated) {
      transferables.push(
        t.vertices.buffer as ArrayBuffer,
        t.normals.buffer as ArrayBuffer,
        t.triangles.buffer as ArrayBuffer,
        t.edgeVertices.buffer as ArrayBuffer
      );
    }

    self.postMessage(
      {
        type: "mesh-result",
        parts: tessellated,
        params: result.params,
        execTimeMs: result.execTimeMs,
        tessTimeMs: result.tessTimeMs,
        timings: result.timings,
        warnings: result.warnings,
      },
      transferables as any
    );
  } finally {
    executing = false;
  }
}

async function handleExport(format: "step" | "stl") {
  if (!core) throw new Error("Worker received 'export' before 'init' completed");
  const data = await core.exportLast(format);
  self.postMessage({ type: "export-result", format, data }, [data] as any);
}
