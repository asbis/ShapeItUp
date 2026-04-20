/**
 * In-process CAD engine for the MCP server.
 *
 * Wraps @shapeitup/core with three extras the MCP surface needs:
 *   1. Lazy OCCT initialization (30 MB WASM — only pay cost on first use).
 *   2. esbuild bundling of .shape.ts files so we can resolve local imports
 *      the same way the VSCode extension does at runtime.
 *   3. Per-execution status caching + writing to shapeitup-status.json so the
 *      on-disk format is byte-identical to what the extension writes — both
 *      clients (MCP and VSCode) stay interchangeable.
 *
 * All MCP tools that used to round-trip through VSCode (get_render_status,
 * export_shape, render_preview, open_shape) now go through here. The VSCode
 * extension is still useful for live visual feedback but is no longer on the
 * critical path.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import {
  BUNDLE_EXTERNALS,
  extractParamsStatic,
  initCore,
  hasSucceededBefore,
  resetWedgeTracking,
  type Core,
  type ExecutedPart,
} from "@shapeitup/core";
import * as esbuild from "esbuild-wasm";

// esbuild-wasm requires a one-shot initialize() before the first build().
// Cross-platform via WASM — avoids shipping native binaries in the VSIX at the
// cost of ~2-3x slower bundling, which is fine for runtime .shape.ts bundles.
let esbuildInitPromise: Promise<void> | null = null;
function ensureEsbuild(): Promise<void> {
  if (!esbuildInitPromise) {
    esbuildInitPromise = esbuild.initialize({}).catch((e) => {
      esbuildInitPromise = null;
      throw e;
    });
  }
  return esbuildInitPromise;
}
import { loadOCCTNode } from "./node-loader.js";
import { loadManifoldNode } from "./manifold-node-loader.js";

export interface EngineStatus {
  success: boolean;
  fileName?: string;
  error?: string;
  /**
   * One-line actionable suggestion for failure cases — e.g. "fillet radius is
   * larger than the smallest edge, try 0.5 and apply before boolean cuts".
   * Populated only on failure, only when we recognize the OCCT/Replicad
   * signature (otherwise undefined — we don't invent guesses).
   */
  hint?: string;
  operation?: string;
  stack?: string;
  stats?: string;
  partCount?: number;
  partNames?: string[];
  boundingBox?: { x: number; y: number; z: number };
  currentParams?: Record<string, number>;
  /**
   * Parameter names statically extracted from the script's
   * `export const params = {...}` declaration. Populated from the raw source
   * BEFORE esbuild/OCCT run, so it survives bundle failures and WASM crashes
   * where `currentParams` would be missing. Empty array means "no params
   * declaration found" (or unparseable form); the declaration itself may
   * still be valid at runtime. Prefer `currentParams` when both are set —
   * it includes the actual values, not just the names.
   */
  declaredParams?: string[];
  timings?: Record<string, number>;
  warnings?: string[];
  /**
   * False when BRepCheck flagged at least one rendered part as invalid
   * (non-manifold shell, self-intersection, open topology). When false, the
   * formatted status headline flips from "Render SUCCESS" to
   * "Render COMPLETED WITH GEOMETRY ERRORS" and per-part volume/area/mass
   * are omitted for the affected parts. Absent means "not checked" and is
   * treated as valid by downstream code.
   */
  geometryValid?: boolean;
  /**
   * Part names that specifically failed BRepCheck. Used by consumers that
   * want to render a per-part error list without re-parsing the `warnings`
   * strings. Subset of `partNames`.
   */
  geometryErrorParts?: string[];
  properties?: ShapeProperties;
  /**
   * Material as declared by the script (`export const material`). Surfaces
   * the density used for mass derivation so consumers can display it.
   * Undefined when the script didn't declare a (valid) material.
   */
  material?: { density: number; name?: string };
  /**
   * Bug #1: true when this execution triggered a `resetCore()` because the
   * caught exception looked WASM-level (OCCT pointer throw, memory OOB, null
   * object, etc.). Surfaced in the user-facing text so downstream tools can
   * warn the agent that the NEXT call will pay ~500ms of OCCT re-init.
   */
  engineReset?: boolean;
  timestamp: string;
}

export interface ShapeProperties {
  parts?: Array<{
    name: string;
    volume?: number;
    surfaceArea?: number;
    centerOfMass?: [number, number, number];
    boundingBox?: { x: number; y: number; z: number };
    /** Mass in grams — present only when the script supplied a material density. */
    mass?: number;
    /** Per-part print quantity (propagated from `PartInput.qty`). */
    qty?: number;
    /** Per-part material override (propagated from `PartInput.material`). */
    material?: { density: number; name?: string };
  }>;
  totalVolume?: number;
  totalSurfaceArea?: number;
  centerOfMass?: [number, number, number];
  /**
   * Aggregate mass in grams across all parts. Only present when EVERY part
   * has a mass (i.e. material was declared AND every part has a valid volume).
   */
  totalMass?: number;
}

export interface ExecuteOutcome {
  status: EngineStatus;
  /** Live OCCT shapes — valid until the next execute() call. */
  parts?: ExecutedPart[];
}

let corePromise: Promise<Core> | null = null;
let lastParts: ExecutedPart[] = [];
let lastFileName: string | undefined;

/**
 * Where do we find the WASM binary? In the installed VSCode extension it
 * lives next to the bundled mcp-server.js (esbuild.config.mjs copies it to
 * extension/dist). For the standalone npm bin it lives inside node_modules.
 * Core's Node loader handles both — we just pass the dir when we know it,
 * or let it resolve via require.resolve.
 */
function locateWasmDir(): string | undefined {
  // Co-located next to the bundled mcp-server (extension dist). This is the
  // hot path for users who install via the VSCode extension — require.resolve
  // would fail there because esbuild has flattened node_modules.
  try {
    const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const local = join(here, "replicad_single.wasm");
    if (existsSync(local)) return here;
  } catch {}
  // Standalone install — let core resolve via require.resolve.
  return undefined;
}

export async function getCore(): Promise<Core> {
  if (!corePromise) {
    const wasmDir = locateWasmDir();
    // Pass a Manifold loader alongside OCCT — without it, `threads.tapInto()`
    // and any other helper that calls `getManifold()` crashes with "manifold
    // has not been loaded" the moment the MCP engine runs a script that
    // touches internal/tapped threads. The worker path already does this
    // (packages/worker/src/index.ts); before this change the MCP path
    // silently omitted it, making internal threads unusable headless.
    //
    // Manifold load failures are non-fatal: we fall back to OCCT-only and log
    // to stderr so the MCP protocol stream stays clean. Scripts that need
    // Manifold will still see the original "manifold has not been loaded"
    // error from getManifold() — better than crashing the whole engine on
    // init when most scripts don't use threads at all.
    corePromise = initCore(
      () => loadOCCTNode(wasmDir),
      () => loadManifoldNode(wasmDir).catch((e) => {
        process.stderr.write(
          `[mcp-engine] Manifold loader failed — threads.tapInto and other ` +
          `mesh-native helpers will be unavailable in MCP context: ` +
          `${e?.message ?? e}\n`,
        );
        return null;
      }),
    );
  }
  return corePromise;
}

/**
 * Drop the cached core + any cached shape references so the next getCore()
 * call reinitializes OCCT from scratch. Called from tool error paths when we
 * detect a WASM "memory access out of bounds" — the OCCT heap is poisoned
 * after that, so every subsequent call would crash until the process is
 * restarted. Reloading the WASM module is the only reliable recovery.
 *
 * Note: lastParts references are stale handles into the old (poisoned) heap
 * after a reset. Clearing them prevents getLastParts() consumers from feeding
 * zombie pointers into the freshly-booted OCCT.
 */
export function resetCore(): void {
  corePromise = null;
  lastParts = [];
  lastFileName = undefined;
  // Bug #8: the wedge-detection heuristic treats a post-success pointer throw
  // as "heap corruption — retry". After we reset the core, the freshly-booted
  // OCCT instance hasn't succeeded yet, so a first-render failure on it
  // should fall back to the user-oriented "check imports" hint (it's no longer
  // the wedged-heap signature).
  resetWedgeTracking();
}

export function getLastParts(): ExecutedPart[] {
  return lastParts;
}

export function getLastFileName(): string | undefined {
  return lastFileName;
}

/**
 * Bundle a .shape.ts file's raw source (reading it from disk) and execute it
 * via core. Writes shapeitup-status.json to globalStorageDir on completion
 * so both success and failure states are observable by other processes.
 */
export async function executeShapeFile(
  filePath: string,
  globalStorageDir: string,
  paramOverrides?: Record<string, number>,
  /**
   * Tessellation-time policy override. Used by `export_shape` when the caller
   * asks for a BOM sidecar — BOM rows need real volume / mass, which cost the
   * ~200 ms/part OCCT measurement. Default undefined → `core.execute` picks
   * its own (currently `"bbox"`), so normal renders keep their fast path.
   */
  opts?: { partStats?: "none" | "bbox" | "full" }
): Promise<ExecuteOutcome> {
  const absPath = resolve(filePath);
  const status: EngineStatus = {
    success: false,
    fileName: absPath,
    timestamp: new Date().toISOString(),
  };

  if (!existsSync(absPath)) {
    status.error = `File not found: ${absPath}`;
    writeStatusFile(status, globalStorageDir);
    return { status };
  }

  // Static param extraction happens BEFORE esbuild/OCCT so the declared names
  // survive every downstream failure (bundle error, WASM crash, init failure).
  // Consumers that only need "which params does this script claim to have?"
  // (e.g. tune_params' Declared: ... warning line) read this field regardless
  // of success/failure. On the happy path, currentParams supersedes it.
  let code: string;
  try {
    code = readFileSync(absPath, "utf-8");
    status.declaredParams = extractParamsStatic(code);
  } catch (e: any) {
    status.error = `Failed to read file: ${e.message}`;
    writeStatusFile(status, globalStorageDir);
    return { status };
  }

  let js: string;
  try {
    await ensureEsbuild();
    const result = await esbuild.build({
      stdin: {
        contents: code,
        resolveDir: dirname(absPath),
        // Absolute path so the inline sourcemap's `sources[0]` points at the
        // real .shape.ts. Paired with the `//# sourceURL=` pragma we
        // prepend below, V8 resolves user-script stack frames to
        // `bracket.shape.ts:12:14` instead of `Object.<anonymous>:48:52`.
        sourcefile: absPath,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      external: [...BUNDLE_EXTERNALS],
      platform: "neutral",
      absWorkingDir: dirname(absPath),
      // Inline sourcemap (base64 data URL appended as
      // `//# sourceMappingURL=data:...`). V8 reads it automatically when the
      // `sourceURL` directive is present. No extra runtime deps — the
      // VM does the mapping.
      sourcemap: "inline",
      logLevel: "silent",
    });
    // Treat "Could not resolve" warnings as hard errors — a missing local
    // import silently tree-shakes when the symbol is unused, which hides typos
    // and missing files until runtime. Surface all resolution failures.
    const resolutionErrors = result.warnings.filter((w) =>
      w.text.includes("Could not resolve")
    );
    if (resolutionErrors.length > 0) {
      const msg = resolutionErrors.map((w) => w.text).join("\n");
      status.error = `Bundle failed (unresolved imports):\n${msg}`;
      writeStatusFile(status, globalStorageDir);
      return { status };
    }
    // Surface other warnings (non-fatal) in the status so the user sees them.
    if (result.warnings.length > 0) {
      status.warnings = result.warnings.map((w) => w.text);
    }
    js = result.outputFiles[0].text;
    // Prepend `//# sourceURL=file:///...` so the core executor can lift it
    // to the top of the `new Function()` wrapper. Couldn't add a parameter
    // to `core.execute()` (signature owned by another agent), so we ride it
    // through the JS text itself — executor.ts strips the leading comment
    // and re-emits it above the wrapper IIFE. Windows path separators are
    // normalised to forward slashes for the URL form.
    const fileURL = `file:///${absPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
    js = `//# sourceURL=${fileURL}\n${js}`;
  } catch (e: any) {
    status.error = `Bundle failed: ${e.message}`;
    writeStatusFile(status, globalStorageDir);
    return { status };
  }

  let core: Core;
  try {
    core = await getCore();
  } catch (e: any) {
    status.error = `OCCT init failed: ${e.message}`;
    writeStatusFile(status, globalStorageDir);
    return { status };
  }

  try {
    // Thread the caller's `partStats` override (when supplied) into core's
    // streaming options. Only `"full"` is observably more expensive, so
    // callers opt in explicitly — e.g. the BOM sidecar path in export_shape.
    const streaming = opts?.partStats ? { partStats: opts.partStats } : undefined;
    const result = await core.execute(js, paramOverrides, streaming);
    lastParts = result.parts;
    lastFileName = absPath;

    const totalVerts = result.parts.reduce((s, p) => s + p.vertices.length / 3, 0);
    const totalTris = result.parts.reduce((s, p) => s + p.triangles.length / 3, 0);
    const partLabel = result.parts.length > 1 ? ` | ${result.parts.length} parts` : "";
    const statsText = `${totalVerts} verts, ${totalTris} tris${partLabel} — ${result.execTimeMs}ms + ${result.tessTimeMs}ms`;

    const bbox = boundingBoxFromParts(result.parts);
    const properties = aggregateProperties(result.parts);

    const currentParams: Record<string, number> = {};
    for (const p of result.params) currentParams[p.name] = p.value;

    const geometryErrorParts = (result.geometryIssues ?? [])
      .filter((i) => i.severity === "error")
      .map((i) => i.part);
    const successStatus: EngineStatus = {
      success: true,
      fileName: absPath,
      stats: statsText,
      partCount: result.parts.length,
      partNames: result.parts.map((p) => p.name),
      boundingBox: bbox,
      currentParams,
      // Preserve the statically-extracted names even on success: consumers
      // that read the status file shouldn't have to choose between the two
      // sources depending on the success bit.
      declaredParams: status.declaredParams,
      timings: result.timings,
      warnings: result.warnings,
      geometryValid: result.geometryValid,
      geometryErrorParts: geometryErrorParts.length > 0 ? geometryErrorParts : undefined,
      properties,
      material: result.material,
      timestamp: new Date().toISOString(),
    };
    writeStatusFile(successStatus, globalStorageDir);
    return { status: successStatus, parts: result.parts };
  } catch (e: any) {
    // Route through core.resolveError so raw WASM exception pointers get
    // resolved to readable text (or at least a useful fallback) instead of
    // being stringified as a bare decimal like "8540320".
    status.error = core.resolveError(e);
    status.operation = e?.operation;
    status.stack = e?.stack;
    // Thread the user's `.shape.ts` source text (read into `code` above) into
    // the hint generator so source-aware branches (e.g. the sketchOnPlane
    // hint disambiguating draw()-without-close from sketchCircle() double-wrap)
    // can specialize. Fall back to `undefined` when the source isn't
    // available — hint generator just uses the generic multi-cause copy.
    status.hint = inferErrorHint(status.error, status.operation, status.stack, code);

    // Bug #1: OCCT exceptions (thread ops especially) poison the WASM heap —
    // Emscripten's handle table is corrupted on the C++-exception path, and
    // every subsequent call in this process dereferences garbage pointers.
    // Detect a WASM-level failure and drop the cached core so the next call
    // re-initializes OCCT from scratch. Pure user-error throws (e.g. "fillet
    // radius too large" as a JS Error) don't qualify — we only reset when the
    // signature matches something that could have corrupted the heap.
    const isRawPointerThrow = typeof e === "number" || typeof e === "bigint";
    const wasmSignaturePattern = /OCCT exception|memory access out of bounds|pointer|null object/i;
    const looksWasmLevel = isRawPointerThrow ||
      (typeof status.error === "string" && wasmSignaturePattern.test(status.error));
    if (looksWasmLevel) {
      resetCore();
      status.engineReset = true;
    }

    writeStatusFile(status, globalStorageDir);
    return { status };
  }
}

export async function exportLastToFile(
  format: "step" | "stl",
  outputPath: string,
  partName?: string
): Promise<void> {
  if (lastParts.length === 0) {
    throw new Error("No shape has been executed in this session — call open_shape, create_shape, or modify_shape first.");
  }
  const core = await getCore();
  const data = await core.exportLast(format, partName);
  mkdirSync(dirname(resolve(outputPath)), { recursive: true });
  writeFileSync(outputPath, Buffer.from(data));
}

function writeStatusFile(status: EngineStatus, dir: string) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shapeitup-status.json"), JSON.stringify(status));
  } catch {
    // Best effort — status file is observability, not correctness.
  }
}

/**
 * Compute an axis-aligned bounding box from a flat [x,y,z,x,y,z,...] vertex
 * array. Returns undefined for empty/degenerate meshes so callers can choose
 * whether to emit a zero-size box or skip the field entirely.
 */
function boundingBoxFromVertices(v: Float32Array): { x: number; y: number; z: number } | undefined {
  if (v.length < 3) return undefined;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1];
    if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2];
    if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return {
    x: parseFloat((maxX - minX).toFixed(1)),
    y: parseFloat((maxY - minY).toFixed(1)),
    z: parseFloat((maxZ - minZ).toFixed(1)),
  };
}

function boundingBoxFromParts(parts: ExecutedPart[]): { x: number; y: number; z: number } {
  // Concatenate all parts' vertices into one flat view, then reuse the shared
  // helper. Because min/max over the union of point sets equals min/max over
  // the concatenated array, the WxHxD result is the correct assembly-wide
  // bounding box. The allocation is negligible next to tessellation itself.
  let total = 0;
  for (const p of parts) total += p.vertices.length;
  if (total === 0) return { x: 0, y: 0, z: 0 };
  const combined = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p.vertices, offset);
    offset += p.vertices.length;
  }
  return boundingBoxFromVertices(combined) ?? { x: 0, y: 0, z: 0 };
}

function aggregateProperties(parts: ExecutedPart[]): ShapeProperties {
  const perPart = parts.map((p) => {
    const bbox = boundingBoxFromVertices(p.vertices);
    return {
      name: p.name,
      volume: p.volume,
      surfaceArea: p.surfaceArea,
      centerOfMass: p.centerOfMass,
      // Skip the field entirely for empty/degenerate meshes so consumers don't
      // render a misleading "0x0x0".
      ...(bbox ? { boundingBox: bbox } : {}),
      ...(typeof p.mass === "number" ? { mass: p.mass } : {}),
      // Propagate optional BOM metadata from PartInput so consumers
      // (export_shape bom sidecar, future BOM-aware tools) don't have to
      // walk a second data source. Absent when the script didn't declare them.
      ...(typeof p.qty === "number" ? { qty: p.qty } : {}),
      ...(p.material ? { material: p.material } : {}),
    };
  });
  let totalVolume = 0;
  let totalSurfaceArea = 0;
  let hasVolume = false;
  let hasSurface = false;
  const weightedCoM: [number, number, number] = [0, 0, 0];
  // CoM denominator is tracked separately from totalVolume: only parts that
  // actually contributed a weighted centroid to the numerator may
  // contribute to the denominator. Otherwise a part with volume but no
  // CoM (e.g. a MeshShape whose tet-integration returned undefined, or
  // a BRepCheck-invalidated part) would pull the aggregate toward
  // (0,0,0) proportional to its volume share — silently misleading.
  // When ANY volumetric part lacks a CoM, we refuse to report the
  // aggregate at all; formatProperties (tools.ts) already omits the
  // "center of mass" line when centerOfMass is undefined.
  let comDenominator = 0;
  let anyVolumetricPartMissingCoM = false;
  // Aggregate mass only when EVERY part has one — a partial total would
  // mislead (e.g. "assembly weighs 50 g" when one part's mass is unknown).
  let totalMass = 0;
  let allHaveMass = parts.length > 0;
  for (const p of parts) {
    if (typeof p.volume === "number") {
      totalVolume += p.volume;
      hasVolume = true;
      if (p.centerOfMass) {
        weightedCoM[0] += p.centerOfMass[0] * p.volume;
        weightedCoM[1] += p.centerOfMass[1] * p.volume;
        weightedCoM[2] += p.centerOfMass[2] * p.volume;
        comDenominator += p.volume;
      } else if (p.volume > 0) {
        anyVolumetricPartMissingCoM = true;
      }
    }
    if (typeof p.surfaceArea === "number") {
      totalSurfaceArea += p.surfaceArea;
      hasSurface = true;
    }
    if (typeof p.mass === "number") {
      totalMass += p.mass;
    } else {
      allHaveMass = false;
    }
  }
  const centerOfMass: [number, number, number] | undefined =
    !anyVolumetricPartMissingCoM && comDenominator > 0
      ? [weightedCoM[0] / comDenominator, weightedCoM[1] / comDenominator, weightedCoM[2] / comDenominator]
      : undefined;
  return {
    parts: perPart,
    totalVolume: hasVolume ? totalVolume : undefined,
    totalSurfaceArea: hasSurface ? totalSurfaceArea : undefined,
    centerOfMass,
    totalMass: allHaveMass ? totalMass : undefined,
  };
}

/**
 * Turn a cryptic OCCT/Replicad error message into a one-line, actionable hint
 * about what the caller should change. Returns `undefined` when we don't
 * recognize the signature — we'd rather say nothing than mislead the agent.
 *
 * The `operation` parameter comes from `instrumentation.tagError` and holds
 * the outermost Replicad method that was in flight when the error fired
 * (e.g. "Solid.fillet", "drawCircle.fuse"). Stack is included in the
 * signature purely so we can extract concrete numbers (e.g. the radius that
 * a fillet was called with) for more specific hints.
 */
export function inferErrorHint(
  errorMessage: string | undefined,
  operation: string | undefined,
  stack: string | undefined,
  source?: string,
): string | undefined {
  if (!errorMessage) return undefined;
  const msg = errorMessage;
  const op = (operation ?? "").toLowerCase();
  const haystack = `${msg}\n${stack ?? ""}`;

  // why: the resolveWasmException fallback — emitted when OCCT threw a raw
  // pointer we couldn't decode. Two meaningfully different root causes:
  //
  //   1. Fresh heap, small pointer, first render of the process: the user's
  //      script has a real bug (bad import path, sketch reused after a
  //      consuming op). The existing "check your imports" advice is right.
  //
  //   2. Bug #8 / wedge detection: a SMALL pointer value (< 10000 — these
  //      look like tiny Emscripten offsets, not real heap addresses) AFTER a
  //      prior successful render is the signature of a poisoned handle
  //      table. Any script — even "return drawCircle(10).sketchOnPlane(...)"
  //      — would hit it. Steer toward "retry" rather than "check imports"
  //      which wastes the agent's effort editing files that aren't broken.
  const ptrMatch = msg.match(/OCCT exception \(pointer\s+(\d+)/);
  if (ptrMatch) {
    const ptr = Number(ptrMatch[1]);
    if (Number.isFinite(ptr) && ptr < 10000 && hasSucceededBefore()) {
      return `Heap appears corrupted from a prior failure — engine has been re-initialized; retry.`;
    }
    return `Low-level OCCT exception — most common cause is an invalid import path between .shape.ts files, or a shape being used after it was consumed (loft/fuse). Check your local imports exist and haven't been renamed; make sure you're not reusing a sketch after a loft.`;
  }

  // OCCT "not done" is the generic failure code. The operation tag tells us
  // whether it was a fillet/chamfer, shell, or something else, and we branch
  // the hint accordingly. Match StdFail_NotDone explicitly too — it's what
  // replicad surfaces when the wrapped OCCT call fails.
  const notDone = /BRep_API.*not done|StdFail_NotDone/i.test(msg);

  if (notDone && /fillet|chamfer/.test(op)) {
    // Try to pull a concrete radius number out of the operation / stack so
    // the agent gets "radius 5 is too large" instead of generic advice.
    const radius = extractNumberFromCall(haystack, /(?:fillet|chamfer)\s*\(\s*(-?\d+(?:\.\d+)?)/i);
    if (radius !== undefined) {
      return `Fillet/chamfer radius ${radius} is likely too large for the smallest edge — try a smaller value (e.g. ${suggestSmallerRadius(radius)}) or filter edges (.fillet(r, e => e.inDirection("Z"))). Also apply fillets BEFORE boolean cuts.`;
    }
    return `Fillet/chamfer failed — the radius is likely too large for the smallest edge, or the operation is being applied after boolean cuts that created tiny fragments. Try a smaller radius, filter edges (e.g. .fillet(r, e => e.inDirection("Z"))), or fillet BEFORE cutting.`;
  }

  // why: shell's face filter matched zero or multiple faces — a sharper
  // failure mode than thickness-vs-feature-size, so it gets a tighter hint
  // ahead of the generic shell case below.
  if (/shell/.test(op) && (/open face/i.test(msg) || /no open/i.test(msg) || /face.*not found/i.test(msg) || /filter/i.test(msg))) {
    return `Shell's face filter did not match exactly one open face (or matched none). Use preview_finder with your FaceFinder to verify the selection before shelling. Typical single-face filter for a vertical enclosure: filter: f => f.inPlane("XY", height) — where height is the top of the extrude.`;
  }

  // Shell is its own failure mode: wall thickness vs feature size, or a face
  // filter that matched zero/too many faces.
  if (notDone && /shell/.test(op)) {
    return `Shell failed — the wall thickness is likely too large relative to the feature size, or the open face has adjacent small faces. Try a smaller thickness and confirm the face filter matches exactly one face.`;
  }

  // why: Replicad's ObjectCache guard throws a plain `Error("This object has
  // been deleted")` when a sketch/shape handle is reused after a consuming
  // op (loft/fuse/cut destructively delete their inputs). This is a JS-side
  // throw — it's already an Error instance, so `resolveWasmException`
  // doesn't touch it and the bare message makes it past the generic loft
  // hint below. Catch it specifically when the operation name mentions loft
  // so the agent gets the reuse-is-the-bug answer instead of the generic
  // topology-mismatch advice.
  if (/loft/i.test(op) && /(?:object|shape|sketch)\s+(?:has\s+been|was|been)\s+deleted|deleted\s+(?:object|shape|sketch)/i.test(msg)) {
    return `The sketch was consumed by a previous loft operation and its handle is no longer valid. Recreate the sketch (draw... sketchOnPlane...) before lofting again. Replicad's loft/fuse/cut methods destructively delete their inputs — reassigning the result to the same variable helps avoid this class of bug.`;
  }

  // Loft pattern-matches on the operation name; the error text rarely
  // mentions "loft" directly so we keep the /loft/ check on `op` only.
  if (/loft/.test(op)) {
    return `Loft failed — input profiles must have similar topology (same number of segments). A rectangle (4 edges) and a circle (1 edge) won't loft directly. Approximate both with the same construction, or use drawPolysides() with matching side counts. Remember: loft CONSUMES its input sketches — recreate each profile fresh if you need to reuse them.`;
  }

  // why: revolve axis passes through the profile, axis is offset into the
  // solid, or angle was given in radians instead of degrees.
  if (/revolve/.test(op) && (/axis/i.test(msg) || /degenerate/i.test(msg) || /parameter/i.test(msg) || (/angle/i.test(msg) && /range/i.test(msg)))) {
    return `Revolve failed — check the axis: it must lie in the sketch plane AND be outside the profile (passing through the profile creates a self-intersecting solid). Default axis is Z through the origin. Angle is in DEGREES (0–360), not radians — revolve({ angle: 90 }) sweeps a quarter turn.`;
  }

  // why: inward offset larger than the smallest concave curvature radius —
  // geometrically impossible and OCCT reports it as a generic "not done".
  if ((/offset/.test(op) || /offset/i.test(msg)) && /fail|not done|construction/i.test(msg)) {
    return `Offset failed — an inward offset larger than the smallest concave curvature radius is geometrically impossible (it would collapse features). Use a smaller offset, or offset outward (positive distance) if that's what you meant.`;
  }

  // why: 3D intersect() is notoriously fragile on curved / non-convex solids —
  // OCCT often surfaces a "not done" / ConstructionError, or (worse) silently
  // returns empty geometry. When the failing op is specifically an intersect
  // we steer the agent toward the mold-cut workaround documented in SKILL.md
  // rather than the generic "reduce complexity" advice below.
  if (/intersect/.test(op) && (notDone || /Standard_ConstructionError/i.test(msg))) {
    return `intersect() is fragile on curved / non-convex solids and often fails silently or returns empty geometry. Try the mold-cut workaround: build an inverse mold with makeBox(big1, big2).cut(tool), then do shape.cut(mold) — this cuts away everything outside the tool volume. Prefer 2D booleans (drawing.intersect) when possible.`;
  }

  // why: self-intersecting geometry — sweep path too tight for cross-section,
  // loft profiles cross in 3D, or inward offset exceeds concave radius. Match
  // on msg OR stack so OCCT's "Self-intersecting wire" strings are caught
  // regardless of which operation tagged the error.
  if (/self[- ]?intersect/i.test(msg) || /self[- ]?intersect/i.test(stack ?? "")) {
    return `Geometry self-intersects. For sweeps: reduce cross-section size, soften sharp bends in the path, or set { frenet: true }. For lofts: check that profiles don't overlap in 3D space. For offsets: use a smaller offset distance (inward offsets are limited by concave feature radii).`;
  }

  // Generic OCCT "not done" without a known operation — least specific hint.
  if (notDone) {
    return `OpenCascade rejected the geometry. Try reducing complexity (simpler profile, fewer boolean ops before this step), or apply modifications before boolean cuts.`;
  }

  // Unclosed 2D profile — Replicad raises this when sketchOnPlane sees a wire
  // that wasn't terminated with .close() / .closeWithMirror() / .done().
  if (/wire is not closed|wire.*not closed/i.test(msg)) {
    return `The 2D profile isn't closed — add \`.close()\` to the drawing/pen chain before sketching on a plane.`;
  }

  // why: wire has disconnected edges or a profile self-overlaps at a vertex
  // — OCCT calls this non-manifold / wire-ordering and it shows up when
  // multiple disjoint paths are fused into one profile.
  if (/non[- ]?manifold/i.test(msg) || /wire.*order/i.test(msg) || /edge.*not.*connected/i.test(msg)) {
    return `Wire ordering or connectivity issue — a drawing may have disconnected edges, or a sketch may be self-overlapping at a vertex. Rebuild the profile using continuous chained calls on one draw() / drawing — avoid mixing multiple disjoint paths into one profile.`;
  }

  // Invalid geometric construction (zero-length edges, degenerate faces,
  // disjoint boolean operands, etc.).
  if (/Standard_ConstructionError/i.test(msg)) {
    return `OpenCascade could not construct the requested geometry. Check that all input dimensions are positive and non-zero, and that boolean operands overlap where expected.`;
  }

  // Null shape handed to an operation — usually means a cut consumed the
  // whole shape or a variable got reassigned/deleted.
  if (/Standard_NullObject/i.test(msg)) {
    return `An operation received a null shape — this often means a boolean cut consumed the shape entirely, or a variable was reassigned. Add \`console.log\` around the failing call to confirm the shape is still valid.`;
  }

  // Parameter-out-of-range: revolve angle in radians, fillet radius > edge,
  // extrude depth of zero, etc.
  if (/Standard_DomainError|parameter.*out of range/i.test(msg)) {
    return `A parameter is outside the valid range for this operation — check fillet/chamfer radii vs edge lengths, and revolve angles in degrees (not radians).`;
  }

  // main() returned something that isn't a Shape3D — usually a Drawing or
  // Sketch that forgot .sketchOnPlane().extrude().
  if (/Shape3D.*required|\.mesh is not a function/i.test(msg)) {
    return `The script returned something that isn't a 3D shape. Confirm \`main()\` returns the Shape3D (or an array of { shape, name, color }) rather than a Drawing or Sketch.`;
  }

  // ---------------------------------------------------------------------
  // TypeError post-analyzer. These mirror the static checks in
  // validate_script, so callers who run the script without validating
  // first still get the same actionable hint at runtime instead of a
  // bare "X is not a function" or the generic OCCT pointer catch-all.
  // Matched against msg only (stack can contain unrelated property names).
  // ---------------------------------------------------------------------

  // `filter.find is not a function` — shell({ filter: callback }) receives a
  // FaceFinder *instance* in the config-object form. Callbacks only work
  // with the positional form. Frequently hit because older skill docs
  // showed the wrong form.
  if (/filter\.find is not a function/i.test(msg)) {
    return `shell's config-object form expects \`filter\` to be a FaceFinder instance, not a callback. Use the positional form with a callback: \`shape.shell(thickness, f => f.inPlane("XY", height))\`, or build a FaceFinder first: \`shape.shell({ thickness, filter: new FaceFinder().inPlane("XY", height) })\`.`;
  }

  // `.extrude is not a function` — user called .extrude() on a raw Drawing.
  // Drawings need .sketchOnPlane() first; only Sketches extrude.
  if (/\.extrude is not a function/i.test(msg)) {
    return `Drawings must be placed on a plane before extruding. Add \`.sketchOnPlane("XY")\` between the draw* call and \`.extrude()\` — e.g. \`drawRectangle(10, 10).sketchOnPlane("XY").extrude(5)\`.`;
  }

  // `.sketchOnPlane is not a function` — two distinct root causes:
  //   (a) user chained `.sketchOnPlane()` onto a DrawingPen that never got
  //       `.close()` / `.done()` — e.g. `draw().hLine(20).vLine(10).sketchOnPlane("XY")`.
  //       A DrawingPen has no `.sketchOnPlane` method until it's converted to
  //       a Drawing via `.close()` / `.done()`.
  //   (b) user chained `.sketchOnPlane()` onto a `sketchCircle` / `sketchRectangle`
  //       — those functions already return a Sketch, which also lacks
  //       `.sketchOnPlane()`.
  // When we have access to the source code, grep for `draw(` / `.hLine(` /
  // `.vLine(` to disambiguate and emit only the relevant fix; otherwise list
  // both and let the user pick.
  if (/\.sketchOnPlane is not a function/i.test(msg)) {
    if (source && /\bdraw\s*\(|\.hLine\s*\(|\.vLine\s*\(|\.line\s*\(|\.polarLine\s*\(|\.bulgeArc\s*\(|\.smoothSpline\s*\(/.test(source)) {
      return `\`.sketchOnPlane\` is not a method on a DrawingPen — you need to close the pen chain first. Add \`.close()\` (for a closed profile) or \`.done()\` (for an open path) before \`.sketchOnPlane()\`: e.g. \`draw().hLine(20).vLine(10).hLine(-20).close().sketchOnPlane("XY")\`.`;
    }
    return `\`.sketchOnPlane\` is not a method on this receiver. Likely causes: (1) you wrote \`draw().hLine(...).vLine(...).sketchOnPlane(...)\` without closing — add \`.close()\` or \`.done()\` before \`.sketchOnPlane()\`; (2) you wrote \`sketchCircle(r).sketchOnPlane(...)\` — sketch* functions already return a Sketch, so drop the redundant \`.sketchOnPlane()\` call or pass the plane as a config arg (e.g. \`sketchCircle(r, { plane: "XY" })\`). Check which applies.`;
  }

  // Bug #4 fallout (standards typo). The Proxy guard in standards.ts now
  // throws a clean "Unknown key ... Did you mean ...?" TypeError, which
  // carries the identifier info we need for a useful hint. Older / deeper
  // paths can still surface as "Cannot read properties of undefined (reading
  // 'X')" — which is ALSO useful IFF the reading target (`X`) is a plausible
  // stdlib/standards identifier (alphabetic, camelCase). It is NOT useful
  // when X is a tuple index ('0', '1') or a bare method name like
  // 'translate' — that's the motor-bracket engineer's misread: passing
  // `[[x,y],...]` where `Placement[]` was required fires
  // "Cannot read properties of undefined (reading '0')", which has no typo
  // content at all and shouldn't mention standards.NEMA17.pilotDiameter.
  if (/Unknown key/i.test(msg) || /NaN.*not a number/i.test(msg)) {
    return `A numeric value came through as \`undefined\` or NaN. Common causes: a typo in a standards lookup (e.g. \`standards.NEMA17.pilotDiameter\` — the correct key is \`pilotDia\`), or an arithmetic expression that divided by zero. Log the value just before the failing call to pinpoint which.`;
  }
  // Only fire the typo hint for `cannot read properties of undefined (reading '…')`
  // when the property name looks like a named stdlib identifier — alphabetic,
  // at least 4 chars, not a common generic method like translate/rotate/etc.
  // that appears on every shape. This avoids hijacking tuple-index errors and
  // wrong-type-arg errors with a misleading "standards typo" suggestion.
  const readingMatch = msg.match(/cannot read propert.*of undefined \(reading '([^']+)'\)/i);
  if (readingMatch) {
    const prop = readingMatch[1];
    const looksLikeLookup =
      /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(prop) &&
      !/^(translate|rotate|mirror|scale|fuse|cut|intersect|extrude|sketchOnPlane|length|size|name|push|map|filter|forEach|slice|splice|concat|indexOf|includes|then|catch|finally)$/i.test(prop);
    if (looksLikeLookup) {
      return `A numeric value came through as \`undefined\` or NaN. Common causes: a typo in a standards lookup (e.g. \`standards.NEMA17.pilotDiameter\` — the correct key is \`pilotDia\`), or an arithmetic expression that divided by zero. Log the value just before the failing call to pinpoint which.`;
    }
    // Otherwise: fall through. A "reading '0'" or "reading 'translate'" error
    // almost always means a type mismatch (wrong shape of argument) — the
    // stdlib-typo hint would be actively misleading.
  }

  return undefined;
}

/**
 * Look for a concrete number passed into a specific call (e.g. fillet(5) or
 * chamfer(2.3)) anywhere in the error signature. Returns undefined if we
 * can't cheaply find one — the caller falls back to a generic hint.
 */
function extractNumberFromCall(haystack: string, pattern: RegExp): number | undefined {
  const m = haystack.match(pattern);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** Suggest a smaller radius that's roughly an order of magnitude down. */
function suggestSmallerRadius(r: number): string {
  if (r >= 10) return String(Math.round(r / 10));
  if (r >= 1) return "0.5";
  return "0.1";
}
