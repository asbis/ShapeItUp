/**
 * ShapeItUp Web Worker
 */

import { executeScript } from "./executor";
import { normalizeParts, tessellatePart } from "./tessellate";
import type { PartInput, TessellatedPart } from "./tessellate";
import { exportShapes } from "./exporter";

let replicadModule: any = null;
let replicadExports: Record<string, any> = {};
let lastParts: PartInput[] = [];
let lastJs: string = "";
let executing = false;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init":
        await initOCCT(msg.wasmLoaderUrl, msg.wasmUrl);
        break;
      case "execute":
        // Skip if already executing (rapid file switches)
        if (executing) return;
        lastJs = msg.js;
        await executeUserScript(msg.js, msg.paramOverrides);
        break;
      case "export":
        await handleExport(msg.format);
        break;
    }
  } catch (err: any) {
    executing = false;
    // OCCT throws integer error codes (WASM pointers) — translate to useful messages
    let message = err.message || String(err);
    if (/^\d+$/.test(message)) {
      message = `OpenCascade operation failed (error code ${message}). This usually means a geometry operation like fillet, chamfer, or boolean failed. Try reducing fillet radii, simplifying geometry, or checking for zero-thickness walls.`;
    } else if (/deleted|disposed|invalid\s+object/i.test(message)) {
      message = `${message}\n\nThis usually means a shape was used after it was consumed by another operation. Common causes:\n- loftWith() consumes (deletes) its input sketches — recreate them if needed after lofting\n- Shapes from a previous execution were cleaned up — store intermediate results in variables\n- A boolean or fillet operation destroyed the shape internally`;
    } else if (/memory\s+access\s+out\s+of\s+bounds|RuntimeError:/i.test(message)) {
      message = `${message}\n\nWASM memory error — the OpenCascade kernel crashed. Common causes:\n- Fillet on complex geometry (many bezier segments)\n- Boolean operation on incompatible/degenerate geometry\n- Too many intermediate shapes without cleanup (use localGC)`;
    }
    self.postMessage({
      type: "error",
      message,
      stack: err.stack,
    });
  }
};

async function initOCCT(wasmLoaderUrl: string, wasmUrl: string) {
  // Retry fetch up to 3 times (handles 408 timeouts on rapid reloads)
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(wasmLoaderUrl);
      if (response.ok) break;
    } catch {}
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!response || !response.ok) {
    throw new Error(`Failed to fetch WASM loader after 3 attempts: ${response?.status || "network error"}`);
  }
  let loaderCode = await response.text();
  loaderCode = loaderCode.replace(/export\s+default\s+Module\s*;?\s*$/, "");

  const initFn = new Function(`
    ${loaderCode}
    return Module;
  `)();

  if (!initFn || typeof initFn !== "function") {
    throw new Error("WASM loader did not produce a Module function");
  }

  const oc = await initFn({
    locateFile: (filename: string) => {
      if (filename.endsWith(".wasm")) return wasmUrl;
      return filename;
    },
  });

  const replicad = await import("replicad");
  replicad.setOC(oc);

  replicadModule = replicad;
  replicadExports = { ...replicad };

  self.postMessage({ type: "ready" });
}

/** Clean up previously created shapes to prevent WASM memory corruption */
function cleanupLastParts() {
  for (const part of lastParts) {
    try {
      if (part.shape && typeof part.shape.delete === "function") {
        part.shape.delete();
      }
    } catch {
      // Already deleted or invalid — ignore
    }
  }
  lastParts = [];
}

async function executeUserScript(js: string, paramOverrides?: Record<string, number>) {
  executing = true;

  // Clean up previous shapes before creating new ones
  cleanupLastParts();

  const execStart = performance.now();

  // Use localGC to track and clean up intermediate shapes
  const gc = replicadExports.localGC
    ? replicadExports.localGC()
    : null;
  const register = gc ? gc[0] : (v: any) => v;
  const cleanup = gc ? gc[1] : () => {};

  let result: any;
  let params: any[];

  try {
    const execResult = executeScript(js, replicadExports, paramOverrides);
    result = execResult.result;
    params = execResult.params;
  } catch (err) {
    cleanup();
    executing = false;
    throw err;
  }

  const parts = normalizeParts(result);
  lastParts = parts;
  const execTime = performance.now() - execStart;

  const tessStart = performance.now();
  const tessellated: TessellatedPart[] = parts.map((p) => tessellatePart(p));
  const tessTime = performance.now() - tessStart;

  // Clean up intermediates (but NOT the final shapes — we need those for export)
  cleanup();

  const transferables: ArrayBuffer[] = [];
  for (const t of tessellated) {
    transferables.push(
      t.vertices.buffer,
      t.normals.buffer,
      t.triangles.buffer,
      t.edgeVertices.buffer
    );
  }

  self.postMessage(
    {
      type: "mesh-result",
      parts: tessellated,
      params,
      execTimeMs: Math.round(execTime),
      tessTimeMs: Math.round(tessTime),
    },
    transferables as any
  );

  executing = false;
}

async function handleExport(format: "step" | "stl") {
  if (lastParts.length === 0) {
    throw new Error("No shapes to export. Execute a script first.");
  }

  const data = await exportShapes(lastParts, format, replicadModule);

  self.postMessage(
    { type: "export-result", format, data },
    [data] as any
  );
}
