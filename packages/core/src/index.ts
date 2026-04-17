/**
 * @shapeitup/core — environment-agnostic CAD pipeline.
 *
 * Both the VSCode webview worker and the MCP server import this module so
 * they share a single OCCT+Replicad execution path. The caller hands us either
 * a browser WASM URL pair or a Node wasm directory; everything after that
 * (script execution, tessellation, measurement, export) is identical.
 */

import type { ParamDef } from "@shapeitup/shared";
import { executeScript } from "./executor";
import { normalizeParts, tessellatePart, type PartInput, type TessellatedPart } from "./tessellate";
import { exportShapes } from "./exporter";
import { validateParts } from "./validate";
import { resolveWasmException } from "./wasm-exception";
import {
  beginInstrumentation,
  getTimings,
  instrumentReplicadExports,
} from "./instrumentation";
import { shapeitupStdlib } from "./stdlib";

export type { PartInput, TessellatedPart } from "./tessellate";
export { exportShapes } from "./exporter";
export { resolveWasmException } from "./wasm-exception";

/**
 * How core obtains the OCCT handle. Callers supply a loader function that
 * returns the initialized `oc` object — this keeps Node-specific imports
 * (fs/path/module) out of the browser bundle, and vice versa. The worker and
 * the MCP server each own their loader implementation; core stays pure.
 */
export type OcctLoader = () => Promise<any>;

export interface ExecutedPart extends TessellatedPart {
  /**
   * Live OCCT shape reference. Do NOT serialize or transfer — it's an FFI
   * handle. Kept so the caller can feed it to exportShapes() without
   * re-executing the script.
   */
  shape: any;
}

export interface ExecutionResult {
  parts: ExecutedPart[];
  params: ParamDef[];
  execTimeMs: number;
  tessTimeMs: number;
  timings: Record<string, number>;
  warnings: string[];
  /**
   * Optional material declared by the script (`export const material = { density, name? }`).
   * `density` is grams per cubic centimeter. Only present when the script
   * exported a valid positive density — callers can treat presence as
   * "use this to derive mass". Absent otherwise.
   */
  material?: { density: number; name?: string };
}

export interface Core {
  /** Execute a user script. Cleans up previous shapes automatically. */
  execute(js: string, paramOverrides?: Record<string, number>): Promise<ExecutionResult>;
  /**
   * Export the most recently executed parts to STEP/STL. If `partName` is
   * provided, export only the part whose name matches (exact match). Throws
   * if no part matches — the error lists available names.
   */
  exportLast(format: "step" | "stl", partName?: string): Promise<ArrayBuffer>;
  /** Access the raw replicad module (for advanced callers — validate, getOC, etc.). */
  replicad(): any;
  /**
   * Resolve a caught exception into a human-readable message. Transparent for
   * normal `Error` objects; only does work when the value is a raw WASM
   * pointer. Uses the cached OCCT module — callers don't have to thread `oc`.
   */
  resolveError(e: unknown): string;
  /** Free OCCT handles from the last execution. Called automatically on each execute(). */
  cleanup(): void;
}

/**
 * Initialize OCCT + Replicad and return a Core handle. Heavy: loads a 30 MB
 * WASM and parses ~1 MB of JS loader code. Call once per process and cache
 * the result — every .execute() call reuses the same OCCT instance.
 */
export async function initCore(loadOcct: OcctLoader): Promise<Core> {
  const oc = await loadOcct();

  const replicad = await import("replicad");
  replicad.setOC(oc);

  const replicadExports: Record<string, any> = { ...replicad };
  instrumentReplicadExports(replicadExports);

  let lastParts: PartInput[] = [];

  function cleanup() {
    for (const part of lastParts) {
      try {
        if (part.shape && typeof part.shape.delete === "function") {
          part.shape.delete();
        }
      } catch {}
    }
    lastParts = [];
  }

  async function execute(
    js: string,
    paramOverrides?: Record<string, number>
  ): Promise<ExecutionResult> {
    cleanup();
    beginInstrumentation();
    const execStart = performance.now();

    const gc = replicadExports.localGC ? replicadExports.localGC() : null;
    const cleanupGC = gc ? gc[1] : () => {};

    let result: any;
    let params: ParamDef[];
    let material: { density: number; name?: string } | undefined;
    try {
      const execResult = executeScript(js, replicadExports, shapeitupStdlib, paramOverrides);
      result = execResult.result;
      params = execResult.params;
      material = execResult.material;
    } catch (err) {
      cleanupGC();
      // If the user script threw a raw WASM pointer, wrap it in an Error with
      // a resolved message so downstream catch blocks don't have to re-handle
      // the numeric case. Preserve the original operation tag so
      // inferErrorHint can still branch on it.
      if (!(err instanceof Error)) {
        const message = resolveWasmException(err, oc);
        const wrapped = new Error(message);
        const op = (err as any)?.operation;
        if (op) (wrapped as any).operation = op;
        throw wrapped;
      }
      throw err;
    }

    const parts = normalizeParts(result);
    lastParts = parts;
    const execTime = performance.now() - execStart;

    const warnings = validateParts(parts, replicad);

    const tessStart = performance.now();
    const tessellated: TessellatedPart[] = parts.map((p) => tessellatePart(p));
    const tessTime = performance.now() - tessStart;

    // Geometric properties — exact values from OCCT's GProp_GProps, not mesh.
    for (let i = 0; i < parts.length; i++) {
      const shape = parts[i].shape;
      const t = tessellated[i];
      try {
        const volProps = replicadExports.measureShapeVolumeProperties?.(shape);
        if (volProps) {
          t.volume = volProps.volume;
          t.centerOfMass = volProps.centerOfMass;
          try { volProps.delete?.(); } catch {}
        }
      } catch {}
      try {
        const surfProps = replicadExports.measureShapeSurfaceProperties?.(shape);
        if (surfProps) {
          t.surfaceArea = surfProps.area;
          try { surfProps.delete?.(); } catch {}
        }
      } catch {}
      // Derive mass only when we have both a volume and a positive density.
      // volume is in mm³; density is in g/cm³; so divide by 1000 to convert.
      if (material && typeof t.volume === "number") {
        t.mass = (material.density * t.volume) / 1000;
      }
    }

    cleanupGC();

    const executed: ExecutedPart[] = tessellated.map((t, i) => ({
      ...t,
      shape: parts[i].shape,
    }));

    return {
      parts: executed,
      params,
      execTimeMs: Math.round(execTime),
      tessTimeMs: Math.round(tessTime),
      timings: getTimings(),
      warnings,
      material,
    };
  }

  async function exportLast(
    format: "step" | "stl",
    partName?: string
  ): Promise<ArrayBuffer> {
    if (lastParts.length === 0) {
      throw new Error("No shapes to export. Execute a script first.");
    }
    let toExport = lastParts;
    if (partName !== undefined) {
      toExport = lastParts.filter((p) => p.name === partName);
      if (toExport.length === 0) {
        const available = lastParts.map((p) => p.name).join(", ");
        throw new Error(
          `No part named "${partName}" found. Available parts: ${available}`
        );
      }
    }
    return exportShapes(toExport, format, replicad);
  }

  return {
    execute,
    exportLast,
    replicad: () => replicad,
    resolveError: (e: unknown) => resolveWasmException(e, oc),
    cleanup,
  };
}
