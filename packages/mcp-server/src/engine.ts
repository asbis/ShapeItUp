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

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, basename, resolve, join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
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

// ---------------------------------------------------------------------------
// Bundle cache — avoids re-running esbuild.build() on unchanged inputs.
// Keyed by the normalized absolute path of the entry file.
// LRU eviction capped at MAX_BUNDLE_CACHE_SIZE entries.
// ---------------------------------------------------------------------------

export interface BundleCacheEntry {
  /** Bundled JS output text. */
  js: string;
  /** Text of the entry file at the time of caching (read from disk). */
  entryContent: string;
  /** Normalized absolute path of the entry file (the map key). */
  entryPath: string;
  /** Absolute input path -> mtimeMs for every file esbuild pulled in. */
  inputMtimes: Record<string, number>;
}

const MAX_BUNDLE_CACHE_SIZE = 32;
/** Module-level LRU bundle cache (persists across tool calls in the same process). */
const bundleCache = new Map<string, BundleCacheEntry>();

/** Clear the bundle cache. Exported for test isolation. */
export function clearBundleCache(): void {
  bundleCache.clear();
}

/**
 * Scan entry source for local `import ... from './...'` statements and return
 * the set of relative specifiers that resolve to local files. Used by
 * checkBundleCache to detect new imports not yet tracked in inputMtimes.
 *
 * Exported for unit testing.
 */
export function extractLocalImportSpecifiers(source: string): string[] {
  // Match both: import ... from './path' and import './path' (side-effect imports)
  const re = /\bfrom\s+['"](\.[^'"]+)['"]/g;
  const sideEffect = /\bimport\s+['"](\.[^'"]+)['"]/g;
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  while ((m = sideEffect.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/** Result of {@link scanImportBindings} — one entry per LOCAL binding. */
export interface ImportBinding {
  /** Name used in the importing file (after any `as` rename). */
  binding: string;
  /** Relative specifier of the source module (e.g. `"./constants"`). */
  source: string;
  /** 1-based line number of the import statement in the source text. */
  line: number;
}

/**
 * Scan source for every local binding introduced by a named or default
 * import, returning `{ binding, source, line }` triples. Used by
 * {@link inferErrorHint} to enrich "X is not defined" errors with the
 * origin of the symbol (so the fix hint can name the actual import line
 * instead of just pointing at the throw site).
 *
 * Only RELATIVE imports are tracked — package imports don't help diagnose
 * the "I forgot to export it" / "I renamed the export" failure modes. The
 * scanner handles:
 *
 *   import { A, B as C } from "./foo";    // named with optional rename
 *   import D from "./bar";                 // default
 *   import D, { E } from "./baz";          // default + named
 *
 * Namespace imports (`import * as X from "..."`) are NOT included — those
 * never produce a bare "X is not defined" error shape; they fail with a
 * different property-access trace.
 *
 * Exported for unit testing.
 */
export function scanImportBindings(source: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  // Scan every `import ... from "<spec>"` statement regardless of specifier,
  // then filter to relative specifiers. Doing the broad scan first avoids
  // the greedy-backtracking trap where a lazy `[\s\S]*?` slurps across
  // multiple imports when the first specifier isn't relative but a later
  // one is (the regex engine backtracks past the non-matching `from` and
  // mis-attributes the first import's bindings to the second specifier).
  const re = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const bindingText = m[1].trim();
    const specifier = m[2];
    // Only track LOCAL (relative) imports — package imports can't be
    // diagnosed by "module doesn't export this symbol" hints.
    if (!specifier.startsWith(".")) continue;
    const line = source.slice(0, m.index).split("\n").length;

    // Pull the optional default-binding identifier that appears before any
    // `{...}` clause: `D` or `D, {...}`. The `!startsWith('{')` guard stops
    // us from treating the opening of a named-only import as a default.
    const defaultMatch = bindingText.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (defaultMatch && !bindingText.startsWith("{")) {
      out.push({ binding: defaultMatch[1], source: specifier, line });
    }

    // Extract the named-bindings block `{ A, B as C }`.
    const namedMatch = bindingText.match(/\{([^}]*)\}/);
    if (namedMatch) {
      for (const raw of namedMatch[1].split(",")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        // `Foo` or `Foo as Bar` → local name is the last token.
        const parts = trimmed.split(/\s+as\s+/).map((s) => s.trim());
        const local = parts[1] ?? parts[0];
        if (local) out.push({ binding: local, source: specifier, line });
      }
    }
  }
  return out;
}

/**
 * Walk an esbuild metafile.inputs graph starting at `entryKey` (the metafile
 * key for the wrapper / entry), chasing `imports[].path` recursively so that
 * TRANSITIVE dependencies land in the returned set along with direct ones.
 * Returns the set of absolute paths for every real file reachable through the
 * graph — excludes the synthetic wrapper stub and the entry file itself (the
 * entry is already covered by `entryContent` equality).
 *
 * `metafileInputs` is shape `{ [relPath]: { imports: [{ path }], ... } }`.
 * Paths inside the metafile are relative to `absWorkingDir`, except when they
 * are already absolute (e.g. the wrapper's `import * as __e from "<absPath>"`
 * which esbuild echoes back as-is). We resolve each to an absolute form so
 * the returned set is suitable for `statSync` without further normalization.
 *
 * Uses a `visited` set to tolerate cycles. Exported for unit testing.
 */
export function collectBundleInputsRecursive(
  metafileInputs: Record<string, { imports?: Array<{ path?: string }> }>,
  entryKey: string,
  absWorkingDir: string,
  entryAbsPath: string,
): string[] {
  const out = new Set<string>();
  const visited = new Set<string>();

  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(absWorkingDir, p));
  const isWrapper = (abs: string): boolean =>
    abs.toLowerCase().includes("__shapeitup_wrapper__");
  const isEntry = (abs: string): boolean => abs.toLowerCase() === entryAbsPath.toLowerCase();

  const walk = (nodeKey: string): void => {
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);
    const node = metafileInputs[nodeKey];
    if (!node) return;
    for (const imp of node.imports ?? []) {
      if (!imp?.path) continue;
      const childKey = imp.path;
      const childAbs = toAbs(childKey);
      if (!isWrapper(childAbs) && !isEntry(childAbs)) {
        out.add(childAbs);
      }
      walk(childKey);
    }
  };

  walk(entryKey);
  return [...out];
}

/**
 * Check if a cached bundle entry is still valid for the given entry source.
 * Returns null if the cache is reusable, or a short human-readable reason
 * string if it must be invalidated.
 *
 * Also detects the "new-import bug": if the entry source contains local import
 * specifiers that resolve to absolute paths NOT in `inputMtimes`, those files
 * were added after the last bundle and we must miss.
 *
 * Exported for unit testing.
 */
export function checkBundleCache(
  entry: BundleCacheEntry,
  liveCode: string,
  entryDir: string,
): string | null {
  if (entry.entryContent !== liveCode) {
    return "entry file content changed";
  }
  try {
    for (const [inputPath, recordedMtime] of Object.entries(entry.inputMtimes)) {
      const stat = statSync(inputPath);
      if (Math.abs(stat.mtimeMs - recordedMtime) > 1) {
        return `input mtime changed: ${inputPath}`;
      }
    }
  } catch (e: any) {
    return `stat failed: ${e?.message ?? String(e)}`;
  }
  // New-import bug fix: if the entry source now imports a local file that was
  // not in the last bundle's inputMtimes, the cache is stale.
  const localSpecs = extractLocalImportSpecifiers(liveCode);
  for (const spec of localSpecs) {
    // Resolve the specifier to an absolute path for lookup. Try common extensions.
    const candidates = [spec, `${spec}.ts`, `${spec}.shape.ts`].map((s) =>
      isAbsolute(s) ? s : resolve(entryDir, s),
    );
    const tracked = Object.keys(entry.inputMtimes);
    const inCache = candidates.some((c) =>
      tracked.some((t) => t.toLowerCase() === c.toLowerCase()),
    );
    if (!inCache) {
      return `new local import not in cache: ${spec}`;
    }
  }
  return null;
}

/**
 * Convert the internal bundle-cache invalidation reason string into a
 * user-facing warning line that MCP callers see in `status.warnings`.
 * Returns null for reasons that shouldn't produce a warning (cold start).
 *
 * Exported for unit testing.
 */
export function bundleCacheReasonToWarning(reason: string | null): string | null {
  if (reason === null) return null;
  // First-ever render of a file isn't an "invalidation" — there was nothing
  // to invalidate. Stay quiet; MCP callers only want to hear about rebuilds
  // that replaced a previous cached bundle.
  if (reason === "no cache entry") return null;

  // Expected-edit reasons: a user saving the .shape.ts file between
  // render_preview/modify_shape calls is the common case, not an anomaly.
  // Emitting "Cache invalidated: …" on every edit teaches callers to tune
  // out the warning, which hides the genuinely unexpected invalidations
  // below. Suppress these routine rebuilds silently — the cache did its job.
  if (reason === "entry file content changed") return null;
  if (/^input mtime changed:/.test(reason)) return null;
  if (/^new local import not in cache:/.test(reason)) return null;

  if (reason === "force=true") return "Cache invalidated: force=true";

  // Pass-through for unexpected reasons (e.g. "stat failed: EACCES …",
  // internal cache corruption, checksum mismatch) so they still reach the
  // caller — better to show something than to eat a real bug.
  return `Cache invalidated: ${reason}`;
}

/**
 * Evict the oldest entry when the cache exceeds MAX_BUNDLE_CACHE_SIZE.
 * Map insertion order == LRU order for our access pattern (we re-insert on
 * hit below, so the oldest entry is always the first one).
 */
function evictIfNeeded(): void {
  while (bundleCache.size >= MAX_BUNDLE_CACHE_SIZE) {
    const oldest = bundleCache.keys().next().value;
    if (oldest !== undefined) bundleCache.delete(oldest);
  }
}

/**
 * Scan the ENTRY source for imports of `main` / `params` from sibling .shape(.ts)
 * files and throw a clear user-facing error before esbuild runs. The worker's
 * executor strips `export { main as default }` from .shape.ts bundles, so these
 * imports silently fail with esbuild's generic "No matching export" — confusing
 * for both humans and AI agents. Only the entry is scanned: utility modules that
 * happen to export a symbol called `main` from non-`.shape` files are untouched.
 */
export function preflightShapeImports(
  sourceCode: string,
  filePath: string,
): { warnings: string[] } {
  const warnings: string[] = [];
  // Two import-binding forms to handle:
  //   import { a, b as c } from './x.shape'     — named
  //   import foo, { a } from './x.shape'        — default + named (NOT parsed
  //     here: the default-binding form is rare for .shape files; if we see
  //     `import main from './x.shape'` it's fine since `main` is the binding
  //     name, not `main`-the-export).
  const re = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]*\.shape(?:\.ts)?)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sourceCode)) !== null) {
    const imported = m[1];
    const source = m[2];
    const entries = imported
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const parts = s.split(/\s+as\s+/).map((x) => x.trim());
        return { exportName: parts[0], localName: parts[1] ?? parts[0] };
      });
    // Importing `main` from a sibling .shape.ts is a hard error: the
    // executor strips the default export before bundling so the symbol
    // simply doesn't exist at runtime.
    const badMain = entries.filter((e) => e.exportName === "main");
    if (badMain.length > 0) {
      throw new Error(
        `Cannot import 'main' from '${source}' in ${filePath}.\n\n` +
        `ShapeItUp reserves 'main' as a runtime entry point — the renderer invokes it, ` +
        `but other scripts cannot import it (the executor strips its export before bundling).\n\n` +
        `To reuse logic across scripts, export a named factory function:\n\n` +
        `  // in ${source}:\n` +
        `  export function makeEnclosure(opts) { /* ... */ }\n\n` +
        `  // in ${filePath}:\n` +
        `  import { makeEnclosure } from '${source}';\n` +
        `  export default function main() { return makeEnclosure({ ... }); }\n`
      );
    }
    // Importing `params` from a sibling is supported but fragile — esbuild
    // inlines both modules into one scope and renames colliding `params`
    // declarations, and slider overrides set via `tune_params` only mutate
    // the ENTRY file's `params` object. When we can detect this pattern we
    // surface a non-fatal warning with the factory-default-param fix, which
    // is the pattern that never breaks.
    const paramImports = entries.filter((e) => e.exportName === "params");
    if (paramImports.length > 0) {
      const localNames = paramImports.map((e) => `'${e.localName}'`).join(" / ");
      warnings.push(
        `Importing 'params' from '${source}' as ${localNames} is supported but ` +
        `fragile: slider overrides from 'tune_params' only apply to the entry file's ` +
        `own 'params', not to imported ones. Prefer the factory-with-default-params ` +
        `pattern: 'export function makeFoo(p = params) { ... }' inside '${source}', ` +
        `and call 'makeFoo()' (no arg) from the entry.`,
      );
    }
  }
  return { warnings };
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
  /**
   * Set when the entry `.shape.ts` declares no `export const params` but the
   * execution still returned a populated `params` object — meaning those
   * params were inlined from an imported module. Without this flag users
   * would see "Current params: {...}" in the render status and assume the
   * entry's sliders, when in fact no sliders apply. The formatter surfaces
   * this as a warning line alongside `Current params`.
   */
  importedParamsWarning?: string;
  /**
   * Aggregate outcome of `patterns.cutAt` material-removal checks.
   *   - `true`  — every cutAt call in the script removed material.
   *   - `false` — at least one cutAt call was a no-op (placements outside
   *     bbox, or volumes equal before/after).
   *   - `undefined` — the script didn't call `patterns.cutAt`, or none of the
   *     calls produced a measurable outcome (kernel-free mock paths).
   *
   * Formatted into a one-line summary by `formatStatusText` so agents see
   * "Cut material removal: all succeeded" or "2/5 calls removed no material".
   */
  hasRemovedMaterial?: boolean;
  /** Number of `patterns.cutAt` calls measured this run. 0 ⇔ absent. */
  cutAtCallCount?: number;
  /** Number of those calls that removed no material. */
  cutAtFailedCount?: number;
  timestamp: string;
  /**
   * Monotonic record of the most recent screenshot produced by `render_preview`,
   * `preview_shape` (with `captureScreenshot: true`), or `tune_params` (with
   * `captureScreenshot: true`). The extension host intentionally does NOT
   * overwrite the engine's authoritative status record on render — it's the
   * MCP server's job to append this metadata once the extension signals
   * render-complete. Kept PRESERVED across subsequent failed renders so a
   * later failure can't erase the "last known good screenshot" breadcrumb.
   */
  lastScreenshot?: {
    /** Epoch ms when the screenshot was captured. */
    timestamp: number;
    /** Absolute path to the PNG. */
    path: string;
    /** "ai" or "standard" / "dark" — render mode used. */
    renderMode?: string;
    /** "isometric" / "top" / "front" / ... — camera preset. */
    cameraAngle?: string;
    /** Source .shape.ts basename (no extension) when known. */
    fileName?: string;
    /** Absolute path to the source .shape.ts when known. */
    sourceFile?: string;
  };
}

export interface ShapeProperties {
  parts?: Array<{
    name: string;
    volume?: number;
    surfaceArea?: number;
    centerOfMass?: [number, number, number];
    /**
     * Per-part bounding box. `x`/`y`/`z` remain the SIZE along each axis (back
     * compat with every consumer that read these before). `min`/`max` carry the
     * raw world-space corners so consumers that care about absolute position
     * (e.g. the "part extends below z=0" warning in formatStatusText) don't
     * have to re-derive them from the vertex array. Both corners are undefined
     * together when the mesh was empty/degenerate.
     */
    boundingBox?: {
      x: number;
      y: number;
      z: number;
      min?: [number, number, number];
      max?: [number, number, number];
    };
    /** Mass in grams — present only when the script supplied a material density. */
    mass?: number;
    /** Per-part print quantity (propagated from `PartInput.qty`). */
    qty?: number;
    /** Per-part material override (propagated from `PartInput.material`). */
    material?: { density: number; name?: string };
    /**
     * FDM-printability heuristics computed at render time from the
     * tessellated triangle mesh + BRepCheck's manifold flag. Lets downstream
     * tools (`get_render_status`, `export_shape`) warn the user before the
     * slicer silently drops sub-nozzle features.
     *
     * - `manifold`: BRepCheck's global validity flag applied per-part. OCCT
     *   validates the whole solid at once, so every part shares the value
     *   (all true when the assembly is clean, all false when it's not).
     * - `minFeatureSize_mm`: shortest triangle edge in this part's
     *   tessellation. The tessellator subdivides along real feature edges,
     *   so this tracks the smallest detail the user actually asked to print.
     * - `issues[]`: human-readable list of concerns. Empty on clean parts.
     */
    printability?: {
      manifold: boolean;
      minFeatureSize_mm: number;
      issues: string[];
    };
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

// ---------------------------------------------------------------------------
// Mesh-result cache.
//
// Every inspection tool (render_preview, check_collisions, describe_geometry,
// validate_joints, preview_finder, sweep_check) re-executes the user's script
// through executeShapeFile when invoked. For a 60-part assembly that's a 7–8 s
// OCCT round-trip — painful when the agent calls render_preview three times in
// a row to inspect different camera angles without changing source or params.
//
// The cache keys on (absPath, source-contents hash, sorted-params, meshQuality)
// and stores the result WITHOUT live OCCT shape handles. Live shapes belong to
// the WASM heap that OCCT manages — caching them across executions is a known
// corruption vector (see patchShapeMeshLeak + Bug #1 in executeShapeFile). We
// keep tessellated arrays (Float32/Uint32 views) + scalar status fields only;
// callers that need `.shape.intersect(...)` / `.shape.faces` bypass the cache
// via `executeWithPersistedParams({ force: true })`.
//
// Invalidation: entry-file mtime change (caught cheaply via stat, plus the
// content-hash fallback in the key), new params, explicit force, or engine
// reset. Local-import edits that don't touch the entry file are NOT auto-
// invalidated — by design (the brief's documented contract). Users editing a
// sibling .shape.ts can pass `force: true` or modify the entry timestamp.
// ---------------------------------------------------------------------------

export interface MeshCacheEntry {
  /**
   * Full outcome we'd hand back to the caller — EXCEPT `.shape` is stripped
   * from every ExecutedPart, because live OCCT handles mustn't survive
   * across executions (corrupts the WASM heap).
   */
  result: ExecuteOutcome;
  /** Hash of the entry file's source content at populate time. */
  sourceHash: string;
  /** fs mtimeMs when the entry was populated — fast invalidation check. */
  mtimeMs: number;
  /** Canonical JSON of sorted params (or `"{}"` when none). */
  paramsKey: string;
  /**
   * Mesh-quality bucket this entry was tessellated at. The MCP engine currently
   * lets core pick (auto-degrades on large assemblies), so the value is almost
   * always `"default"` — the field exists so an extension-level cache layer
   * (documented in the brief, not yet implemented here) has a hook point.
   */
  meshQuality: string;
  hitCount: number;
  lastUsed: number;
}

const meshCache = new Map<string, MeshCacheEntry>();
const MESH_CACHE_MAX = 16;

/**
 * Canonical JSON of a params record — sorted keys, NaN-safe, so equal logical
 * param sets always hash identically. Returns `"{}"` when the record is absent
 * or empty so the cache key stays stable across the undefined / empty-object
 * boundary.
 */
export function canonicalParamsKey(params?: Record<string, number>): string {
  if (!params) return "{}";
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "{}";
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = params[k];
  return JSON.stringify(out);
}

function computeMeshCacheKey(
  absPath: string,
  sourceHash: string,
  paramsKey: string,
  meshQuality: string,
): string {
  const h = createHash("sha256");
  h.update(absPath);
  h.update("|");
  h.update(sourceHash);
  h.update("|");
  h.update(paramsKey);
  h.update("|");
  h.update(meshQuality);
  return h.digest("hex");
}

function hashSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * Strip WASM-heap handles from an outcome so it's safe to retain across
 * executions. The original `parts` array is preserved by field so callers
 * that read `.name`, `.vertices`, `.volume`, etc. keep working — only
 * `.shape` goes missing.
 */
function sanitizeOutcomeForCache(outcome: ExecuteOutcome): ExecuteOutcome {
  if (!outcome.parts) return { status: outcome.status };
  const safeParts = outcome.parts.map((p) => {
    // Discard `.shape` — every other field (vertices/normals/triangles/
    // edgeVertices/volume/surfaceArea/centerOfMass/mass/qty/material) is
    // either a typed-array view over a detached buffer or a scalar, so it's
    // free of WASM references. We keep the typed-array views themselves:
    // they back onto ArrayBuffers owned by JS, not OCCT.
    const { shape: _shape, ...rest } = p;
    void _shape;
    return rest as Omit<ExecutedPart, "shape"> as ExecutedPart;
  });
  return { status: outcome.status, parts: safeParts };
}

/**
 * Find an existing cache entry whose key matches the provided triple AND
 * whose source-mtime still equals the on-disk entry file. Returns the entry
 * (with hitCount / lastUsed bumped) on hit, undefined otherwise.
 */
export function lookupMeshCache(
  absPath: string,
  sourceHash: string,
  paramsKey: string,
  meshQuality: string,
): MeshCacheEntry | undefined {
  const key = computeMeshCacheKey(absPath, sourceHash, paramsKey, meshQuality);
  const entry = meshCache.get(key);
  if (!entry) return undefined;
  // Double-guard: even though source content hashes into the key, a stale
  // mtime can only happen when someone externally mutated the file to the
  // same content (git checkout, touch). Content equality is enough for
  // correctness — we still refresh lastUsed so the LRU position is right.
  entry.hitCount += 1;
  entry.lastUsed = Date.now();
  return entry;
}

/**
 * Store an outcome under the computed cache key. Drops the oldest (by
 * lastUsed) entry when the cache would grow beyond MESH_CACHE_MAX. Only
 * successful outcomes are cached — a failed render is cheap to re-run (no
 * OCCT work happened) and we'd rather hit a transient-failure retry than
 * serve a stale "success" from before the caller's edit.
 */
export function populateMeshCache(
  absPath: string,
  sourceHash: string,
  mtimeMs: number,
  paramsKey: string,
  meshQuality: string,
  outcome: ExecuteOutcome,
): void {
  if (!outcome.status.success) return;
  const key = computeMeshCacheKey(absPath, sourceHash, paramsKey, meshQuality);
  const entry: MeshCacheEntry = {
    result: sanitizeOutcomeForCache(outcome),
    sourceHash,
    mtimeMs,
    paramsKey,
    meshQuality,
    hitCount: 0,
    lastUsed: Date.now(),
  };
  meshCache.set(key, entry);
  if (meshCache.size > MESH_CACHE_MAX) {
    evictOldest();
  }
}

/**
 * LRU eviction: drop the entry with the smallest `lastUsed` stamp. Cheap
 * enough at MESH_CACHE_MAX = 16 — O(n) per eviction, only on the rare
 * insert that overflows.
 */
function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestStamp = Infinity;
  for (const [k, v] of meshCache) {
    if (v.lastUsed < oldestStamp) {
      oldestStamp = v.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) meshCache.delete(oldestKey);
}

/**
 * Drop every cached mesh result. Called from resetCore() — after a WASM heap
 * reset the underlying parts are fine (no OCCT pointers inside), but the next
 * execute might legitimately produce different output (e.g. if the reset was
 * triggered by a now-fixed user script), so we'd rather re-tessellate than
 * serve pre-reset output for the same source+params.
 */
export function clearMeshCache(): void {
  meshCache.clear();
}

/** Observability hook for tests and logging. */
export function getMeshCacheSize(): number {
  return meshCache.size;
}

/**
 * Read the entry file's stat + content so the cache can key on both the
 * content hash (authoritative) and mtime (LRU bookkeeping). Returns
 * undefined when the file is missing or unreadable — callers fall back to a
 * fresh execute so the failure surfaces through executeShapeFile's own error
 * path rather than being masked by a cache-layer swallow.
 */
export function readSourceForCacheKey(
  absPath: string,
): { source: string; sourceHash: string; mtimeMs: number } | undefined {
  try {
    const source = readFileSync(absPath, "utf-8");
    const mtimeMs = statSync(absPath).mtimeMs;
    return { source, sourceHash: hashSource(source), mtimeMs };
  } catch {
    return undefined;
  }
}

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
  // Drop every memoised mesh too: even though cached parts contain no WASM
  // pointers, a reset usually means we just hit a poisoned-heap failure on
  // the same script — the FIX (re-init + re-execute) needs to actually run
  // again to land any user-side bug fix that motivated the reset.
  clearMeshCache();
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
  opts?: {
    partStats?: "none" | "bbox" | "full";
    /**
     * When true, skip the bundle cache entirely — always re-invoke esbuild.
     * Surfaces a `Cache invalidated: force=true` line in `status.warnings`.
     * Use only when you suspect the mtime-tracked cache is stale; normal
     * render paths get correct invalidation automatically.
     */
    forceBundleRebuild?: boolean;
  }
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
    // --- Bundle cache lookup ---
    const entryDir = dirname(absPath);
    const cached = bundleCache.get(absPath);
    // `forceBundleRebuild` short-circuits the cache check with a dedicated
    // reason so the MCP caller sees WHY their bypass took effect — same
    // shape as the mtime/content reasons the cache itself produces, but
    // unambiguous for the "I passed the flag on purpose" case.
    const invalidReason = opts?.forceBundleRebuild
      ? "force=true"
      : cached
        ? checkBundleCache(cached, code, entryDir)
        : "no cache entry";

    if (cached && invalidReason === null) {
      process.stderr.write(`[bundle-cache] hit absPath=${absPath}\n`);
      js = cached.js;
      // Re-insert to maintain LRU order (access = most-recent).
      bundleCache.delete(absPath);
      bundleCache.set(absPath, cached);
    } else {
    // Preflight: catch `import { main } from './other.shape'` (hard error) and
    // warn on `import { params } from './other.shape'` (supported but fragile —
    // tune_params slider overrides only reach the entry's own params object).
    const preflightResult = preflightShapeImports(code, absPath);
    await ensureEsbuild();
    // Multi-file .shape.ts disambiguation (v2).
    //
    // Previous approach was a bundle footer that read `params` / `main` as
    // bare identifiers in the final merged scope. When the entry imported
    // a sibling `.shape.ts` that ALSO exported `params`, esbuild's
    // collision-renaming could keep the imported module's `params` under
    // the bare name and rename the entry's to `params2` (output ordering
    // dependent). The footer then stamped the WRONG params onto globalThis —
    // slider values shown in the UI, but more importantly the params object
    // consumed by the executor, both diverged from the entry file's own
    // declaration.
    //
    // Synthetic wrapper approach (approach B from the design doc): we feed
    // esbuild a tiny stdin module that does
    //
    //   import * as __shapeitup_entry__ from "<absPath>";
    //   globalThis.__SHAPEITUP_ENTRY_MAIN__   = __shapeitup_entry__.default;
    //   globalThis.__SHAPEITUP_ENTRY_PARAMS__ = __shapeitup_entry__.params;
    //   export default __shapeitup_entry__.default;
    //   export const params   = __shapeitup_entry__.params;
    //   export const material = __shapeitup_entry__.material;
    //   export const config   = __shapeitup_entry__.config;
    //
    // The namespace import gives esbuild an unambiguous, dedicated binding
    // for the entry file's exports. No matter what gets renamed inside the
    // bundle, `__shapeitup_entry__.params` is ALWAYS the entry's own
    // `export const params` — the issue is structurally impossible to
    // re-introduce here.
    //
    // The re-exports keep back-compat with the executor's ambient lookups
    // for `material` and `config` (it reads them via `typeof foo !==
    // "undefined"` in the IIFE scope), so declaring them at top-level in
    // the bundle still works. `rewriteImports` strips the trailing
    // `export { ... }` block unchanged.
    const entryImportPath = absPath.replace(/\\/g, "/");
    const syntheticEntry =
      `import * as __shapeitup_entry__ from ${JSON.stringify(entryImportPath)};\n` +
      `try { globalThis.__SHAPEITUP_ENTRY_MAIN__ = __shapeitup_entry__.default; } catch (e) {}\n` +
      `try { globalThis.__SHAPEITUP_ENTRY_PARAMS__ = __shapeitup_entry__.params; } catch (e) {}\n` +
      // Sentinel: tells the executor this marker was set by a trusted wrapper
      // (vs leaked from a prior execution in the long-lived MCP-server process).
      // The executor reads and clears it together with MAIN/PARAMS.
      `try { globalThis.__SHAPEITUP_ENTRY_SENTINEL__ = true; } catch (e) {}\n` +
      `export default __shapeitup_entry__.default;\n` +
      `export const params = __shapeitup_entry__.params;\n` +
      `export const material = __shapeitup_entry__.material;\n` +
      `export const config = __shapeitup_entry__.config;\n`;
    const result = await esbuild.build({
      stdin: {
        contents: syntheticEntry,
        resolveDir: dirname(absPath),
        // IMPORTANT: this MUST differ from `absPath`. If we used the user's
        // real file path here, esbuild would conflate the stdin contents
        // with the entry it's trying to import (`import * from "./entry"`)
        // and short-circuit the bundle — the user's code gets tree-shaken
        // out and both `default` and `params` come back `undefined`.
        sourcefile: join(dirname(absPath), "__shapeitup_wrapper__.ts"),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
      external: [...BUNDLE_EXTERNALS],
      platform: "neutral",
      absWorkingDir: dirname(absPath),
      // With the synthetic-wrapper entry the user's file is resolved by its
      // absolute path (including the `.shape.ts` double-extension). esbuild
      // treats `.shape.ts` as an unknown loader because it dispatches on the
      // FULL extension — map it explicitly to the TS loader. `.ts` remains
      // the default. Imported sibling `.shape` files (the form without the
      // trailing `.ts`, common in the skill docs) resolve via esbuild's
      // module resolver and also need the loader override.
      loader: { ".shape.ts": "ts", ".shape": "ts" },
      // Inline sourcemap (base64 data URL appended as
      // `//# sourceMappingURL=data:...`). V8 reads it automatically when the
      // `sourceURL` directive is present. No extra runtime deps — the
      // VM does the mapping.
      sourcemap: "inline",
      metafile: true,
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
    // Combine esbuild warnings with any preflight warnings (e.g. importing
    // `params` from a sibling .shape.ts — supported but fragile).
    //
    // Filter out "Import 'X' will always be undefined" warnings for the
    // optional names the synthetic wrapper re-exports (`config`, `material`,
    // `params`). These fire on every file that doesn't declare one of them —
    // which is most of them — and the re-export pattern is deliberate (back-
    // compat with the executor's ambient `typeof foo !== "undefined"` lookup).
    const OPTIONAL_REEXPORT_NAMES = /Import "(config|material|params)" will always be undefined/;
    const filteredEsbuildWarnings = result.warnings.filter(
      (w) => !OPTIONAL_REEXPORT_NAMES.test(w.text),
    );
    const combinedWarnings = [
      ...preflightResult.warnings,
      ...filteredEsbuildWarnings.map((w) => w.text),
    ];
    if (combinedWarnings.length > 0) {
      status.warnings = combinedWarnings;
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

    // Populate cache from metafile. Walk `inputs[entry].imports[].path`
    // recursively so TRANSITIVE dependencies land in inputMtimes alongside
    // direct ones — a user editing `constants.ts` (imported by `body.shape.ts`,
    // imported by `assembly.shape.ts`) must invalidate the assembly's cache
    // entry even though esbuild lists `constants.ts` under `body.shape.ts`'s
    // imports, not the assembly's. The recursive walk closes that gap.
    //
    // The entry key in the metafile is the synthetic wrapper's relative path
    // (esbuild normalises it against absWorkingDir). We locate it by its
    // unique `__shapeitup_wrapper__` marker rather than string-matching a
    // computed relative form, because Windows/POSIX path joins diverge.
    const inputMtimes: Record<string, number> = {};
    try {
      const metafileInputs = result.metafile?.inputs ?? {};
      const wrapperKey = Object.keys(metafileInputs).find((k) =>
        k.toLowerCase().includes("__shapeitup_wrapper__"),
      );
      const absInputs = wrapperKey
        ? collectBundleInputsRecursive(metafileInputs, wrapperKey, entryDir, absPath)
        : // Fallback: no wrapper key (shouldn't happen with the synthetic-entry
          // config above, but keep the flat metafile walk as a safety net so a
          // future refactor that drops the wrapper doesn't silently lose
          // invalidation coverage).
          Object.keys(metafileInputs)
            .map((p) => (isAbsolute(p) ? p : resolve(entryDir, p)))
            .filter((abs) => !abs.toLowerCase().includes("__shapeitup_wrapper__"))
            .filter((abs) => abs.toLowerCase() !== absPath.toLowerCase());
      for (const abs of absInputs) {
        try {
          inputMtimes[abs] = statSync(abs).mtimeMs;
        } catch {
          // Can't stat an input — omit it; next run will fall through to rebundle.
        }
      }
    } catch {
      // Metafile walk failed entirely — leave inputMtimes empty.
    }

    process.stderr.write(`[bundle-cache] miss reason=${invalidReason} absPath=${absPath}\n`);

    // Surface the invalidation reason to MCP callers. Previously this was
    // only visible in the VS Code output-channel log, so an agent inspecting
    // the render response couldn't tell whether a dependency edit actually
    // busted the cache or whether it silently served a stale bundle.
    // Mapping:
    //   "force=true"                      → "Cache invalidated: force=true"
    //   "entry file content changed"      → no warning (user-edit: expected rebuild)
    //   "input mtime changed: <abs path>" → no warning (dep-edit: expected rebuild)
    //   "new local import not in cache…"  → no warning (dep-edit: expected rebuild)
    //   "no cache entry" (first render)   → no warning (cold start isn't an invalidation)
    //   "stat failed: …"                  → pass-through, prefixed (unexpected)
    const warningLine = bundleCacheReasonToWarning(invalidReason);
    if (warningLine) {
      status.warnings = [warningLine, ...(status.warnings ?? [])];
    }

    evictIfNeeded();
    bundleCache.set(absPath, {
      js,
      entryContent: code,
      entryPath: absPath,
      inputMtimes,
    });
    } // end else (cache miss)
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
    // Feed the per-part printability heuristic with the BRepCheck manifold
    // flag (shared across all parts — OCCT validates the whole solid) and the
    // already-drained runtime warnings. `result.warnings` mixes stdlib
    // advisories (e.g. `threads.tapInto at M2 produces sub-nozzle features`)
    // with validateParts's geometric checks; both are worth attributing to
    // any part whose name they mention.
    const properties = aggregateProperties(result.parts, {
      geometryValid: result.geometryValid,
      runtimeWarnings: result.warnings,
    });

    const currentParams: Record<string, number> = {};
    for (const p of result.params) currentParams[p.name] = p.value;

    // When the runtime `params` object carries KEYS that the entry file never
    // declared, those keys leaked in from an imported module's
    // `export const params` (esbuild inlines the sibling and its declaration
    // shows up in the merged scope). Surface this explicitly so
    // "Current params: {...}" in the formatted status isn't silently
    // misleading about where sliders actually bind.
    //
    // Three cases, only one warns:
    //   (a) Entry has NO `export const params` token at all.
    //       → Imports are an implementation detail; the user never claimed
    //         sliders for this file. Silent.
    //   (b) Entry has `export const params = {...}` (any form, including
    //       empty-object). Every runtime key is also a declared key.
    //       → Expected happy path. Silent.
    //   (c) Entry declared params, but runtime params has extra keys not in
    //       the declared set.
    //       → Imported module's params shadowed/merged with the local one.
    //         Warn so the user knows their declared sliders aren't the
    //         whole story.
    //
    // The `export const params` source-text probe is a cheap token check —
    // independent of `declaredParams` (which comes back `[]` both for
    // "declaration absent" and "declaration present but empty"), because
    // those two states want DIFFERENT warnings here.
    const entryHasParamsDeclaration = /\bexport\s+const\s+params\s*=/.test(code);
    const declaredSet = new Set(status.declaredParams ?? []);
    const runtimeKeys = Object.keys(currentParams);
    const extraKeys = runtimeKeys.filter((k) => !declaredSet.has(k));
    const importedParamsWarning =
      entryHasParamsDeclaration && extraKeys.length > 0
        ? `Entry file's 'export const params' does not declare [${extraKeys.join(", ")}]. Imported module's params are being merged into the slider set — consumers (tune_params UI, render status) may show keys that edits to this file cannot change.`
        : undefined;

    const geometryErrorParts = (result.geometryIssues ?? [])
      .filter((i) => i.severity === "error")
      .map((i) => i.part);
    // Aggregate patterns.cutAt outcomes → `hasRemovedMaterial` (tri-state).
    // Absent outcomes (no cutAt calls, or calls without a measurable volume)
    // collapse to `undefined` so the status-text formatter can skip the line
    // entirely on scripts that don't exercise this helper.
    const outcomes = result.cutAtOutcomes ?? [];
    const hasRemovedMaterial: boolean | undefined =
      outcomes.length === 0
        ? undefined
        : outcomes.every((o) => o === true);
    // Counts drive the "N/M calls removed no material" half of the
    // formatStatusText summary line. Kept alongside `hasRemovedMaterial` so
    // consumers that want the richer form don't have to re-derive it from
    // raw outcomes (not surfaced to the status file for privacy/size).
    const cutAtFailedCount = outcomes.filter((o) => !o).length;
    const cutAtCallCount = outcomes.length;
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
      // Merge runtime warnings from core.execute with any bundle-phase
      // warnings (preflight + esbuild) accumulated in `status.warnings`.
      // Without this merge, the preflight "Importing 'params' from sibling"
      // warning would be silently dropped on a successful render.
      warnings: [
        ...(status.warnings ?? []),
        ...((result.warnings as string[] | undefined) ?? []),
      ],
      geometryValid: result.geometryValid,
      geometryErrorParts: geometryErrorParts.length > 0 ? geometryErrorParts : undefined,
      properties,
      material: result.material,
      importedParamsWarning,
      hasRemovedMaterial,
      cutAtCallCount: cutAtCallCount > 0 ? cutAtCallCount : undefined,
      cutAtFailedCount: cutAtCallCount > 0 ? cutAtFailedCount : undefined,
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
    // Preserve the monotonic `lastScreenshot` breadcrumb across writes. The
    // engine owns everything ELSE in this file; screenshots are written out-
    // of-band by `appendScreenshotMetadata` after the extension finishes
    // capturing. Without this read-then-carry, a failed render (or any
    // other engine write) would erase the last-good screenshot path and
    // break `get_render_status`' ability to show "Last screenshot: ...".
    if (status.lastScreenshot === undefined) {
      try {
        const existing = JSON.parse(
          readFileSync(join(dir, "shapeitup-status.json"), "utf-8"),
        ) as EngineStatus;
        if (existing && existing.lastScreenshot) {
          status.lastScreenshot = existing.lastScreenshot;
        }
      } catch {
        // Missing / unreadable prior status — nothing to carry forward.
      }
    }
    writeFileSync(join(dir, "shapeitup-status.json"), JSON.stringify(status));
  } catch {
    // Best effort — status file is observability, not correctness.
  }
}

/**
 * Write screenshot metadata into `shapeitup-status.json` WITHOUT touching
 * any other field. Called by render_preview / preview_shape / tune_params
 * after the VSCode extension signals render-complete so that a subsequent
 * `get_render_status` can report the last screenshot path + timestamp.
 *
 * The extension host itself deliberately avoids writing the status file
 * (to preserve the engine's authoritative record); this helper closes the
 * loop on the MCP side. If the status file doesn't exist yet — e.g. the
 * user called render_preview before any engine-driven execute — we create
 * a minimal success-looking record with just `lastScreenshot` + a
 * timestamp so later readers don't see a naked file.
 */
export function appendScreenshotMetadata(
  meta: NonNullable<EngineStatus["lastScreenshot"]>,
  dir: string,
): void {
  try {
    mkdirSync(dir, { recursive: true });
    const statusPath = join(dir, "shapeitup-status.json");
    let current: EngineStatus;
    try {
      current = JSON.parse(readFileSync(statusPath, "utf-8")) as EngineStatus;
    } catch {
      // No prior status — seed a minimal record. success=true here would be
      // misleading (we haven't executed anything); leave it false so
      // get_render_status flags the situation as an empty-engine "screenshot
      // only" record.
      current = {
        success: false,
        timestamp: new Date().toISOString(),
      };
    }
    current.lastScreenshot = meta;
    writeFileSync(statusPath, JSON.stringify(current));
  } catch {
    // Best effort — same rationale as writeStatusFile.
  }
}

/**
 * Compute an axis-aligned bounding box from a flat [x,y,z,x,y,z,...] vertex
 * array. Returns undefined for empty/degenerate meshes so callers can choose
 * whether to emit a zero-size box or skip the field entirely.
 */
function boundingBoxFromVertices(v: Float32Array): {
  x: number;
  y: number;
  z: number;
  min: [number, number, number];
  max: [number, number, number];
} | undefined {
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
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

function boundingBoxFromParts(parts: ExecutedPart[]): { x: number; y: number; z: number } {
  // Concatenate all parts' vertices into one flat view, then reuse the shared
  // helper. Because min/max over the union of point sets equals min/max over
  // the concatenated array, the WxHxD result is the correct assembly-wide
  // bounding box. The allocation is negligible next to tessellation itself.
  // Note: the top-level `status.boundingBox` is intentionally the size-only
  // {x,y,z}; min/max are surfaced per-part via aggregateProperties instead.
  let total = 0;
  for (const p of parts) total += p.vertices.length;
  if (total === 0) return { x: 0, y: 0, z: 0 };
  const combined = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    combined.set(p.vertices, offset);
    offset += p.vertices.length;
  }
  const bb = boundingBoxFromVertices(combined);
  return bb ? { x: bb.x, y: bb.y, z: bb.z } : { x: 0, y: 0, z: 0 };
}

/**
 * Default FDM nozzle diameter (mm) used by the printability heuristic. A
 * 0.4 mm nozzle is the de-facto standard for desktop slicers (Cura /
 * PrusaSlicer / Bambu Studio ship it as the default profile). Features
 * narrower than this are rendered as thin zero-width extrusions or dropped
 * entirely — `threads.tapInto` at M2/M3 is the canonical offender.
 *
 * Hardcoded here rather than a parameter knob because the heuristic is
 * advisory: false positives on a 0.2 mm "detail nozzle" workflow are fine
 * (the user knows their nozzle), and a threshold that tracks the common
 * case catches the real bugs.
 */
const DEFAULT_NOZZLE_MM = 0.4;

/**
 * Threshold for "this edge lies on a smooth/tangent seam between two faces".
 * Empirical: cylinder/flat boolean cuts produce micro-seams where adjacent
 * triangle normals differ by ~3–15°. A sharp FDM feature edge (outer corner,
 * wall boundary) gets normals differing by 45°+ — a clean gap.
 *
 * dot(n1, n2) > 0.95 corresponds to an angle < ~18° — well clear of real
 * feature edges while still catching OCCT's boolean-tangent artefacts.
 */
const TANGENT_DOT_THRESHOLD = 0.95;

/**
 * Fallback minimum when every triangle edge in a part lies on a tangent
 * seam. 0.5 mm is the smallest feature the default 0.4 mm nozzle can still
 * render with acceptable fidelity, so using it as a floor means a
 * tangent-only mesh never forces a printability warning that isn't real.
 */
const TANGENT_FALLBACK_FLOOR_MM = 0.5;

/**
 * Per-triangle normal as the mean of its three vertex normals (which already
 * come smoothed from OCCT's tessellator). Using the triangle face normal via
 * cross product would be equivalent for flat facets but slightly different
 * across a curved/subdivided surface, and we want to measure the SMOOTHED
 * surface tangency that the slicer will see.
 */
function triangleMeanNormal(
  normals: Float32Array,
  triangles: Uint32Array,
  triIdx: number,
): [number, number, number] {
  const base = triIdx * 3;
  const i0 = triangles[base] * 3;
  const i1 = triangles[base + 1] * 3;
  const i2 = triangles[base + 2] * 3;
  const nx = (normals[i0]     + normals[i1]     + normals[i2])     / 3;
  const ny = (normals[i0 + 1] + normals[i1 + 1] + normals[i2 + 1]) / 3;
  const nz = (normals[i0 + 2] + normals[i1 + 2] + normals[i2 + 2]) / 3;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return [0, 0, 0];
  return [nx / len, ny / len, nz / len];
}

/**
 * Compute the shortest triangle edge length across a tessellated part,
 * ignoring edges that lie on smooth/tangent seams between two coplanar-ish
 * neighbours. OCCT booleans (cylinder cut against flat face near-tangentially)
 * produce 0.04–0.05 mm micro-edges that aren't real thin walls — they just
 * mark where the mesher subdivided along a curvature-smooth ridge. Treating
 * them as "smallest features" produces spurious sub-nozzle warnings on every
 * export.
 *
 * Algorithm: build a triangle-adjacency map keyed on canonical (min, max)
 * vertex-index pairs. For each edge, if exactly two triangles share it AND
 * their smoothed normals have dot > 0.95 (≤ ~18° angle), skip the edge —
 * it's a tangent seam, not a feature boundary. All other edges (including
 * boundary edges with only one incident triangle, which ARE real features
 * such as hole rims) participate in the min.
 *
 * Returns the shortest non-tangent edge; if every edge is tangent (unusual,
 * e.g. a perfectly smooth sphere with no sharp boundaries) returns
 * {@link TANGENT_FALLBACK_FLOOR_MM}. Returns +Infinity for empty meshes —
 * callers should check `Number.isFinite` before emitting.
 *
 * The `normals` arg is optional for back-compat with pre-normal tessellators
 * (tests that hand-craft a mesh without normals): omit it and the function
 * falls back to the naive shortest-edge loop.
 */
function minTriangleEdgeMm(
  vertices: Float32Array,
  triangles: Uint32Array,
  normals?: Float32Array,
): number {
  const triCount = triangles.length / 3;
  if (triCount === 0) return Infinity;

  // Flat path: no normals → can't classify tangent edges → return the raw
  // shortest edge. Preserves the previous contract for callers that don't
  // have normals handy (unit tests, old cached snapshots).
  if (!normals || normals.length < vertices.length) {
    let minSq = Infinity;
    for (let i = 0; i < triangles.length; i += 3) {
      const i0 = triangles[i] * 3;
      const i1 = triangles[i + 1] * 3;
      const i2 = triangles[i + 2] * 3;
      const x0 = vertices[i0], y0 = vertices[i0 + 1], z0 = vertices[i0 + 2];
      const x1 = vertices[i1], y1 = vertices[i1 + 1], z1 = vertices[i1 + 2];
      const x2 = vertices[i2], y2 = vertices[i2 + 1], z2 = vertices[i2 + 2];
      let dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
      let d = dx * dx + dy * dy + dz * dz;
      if (d < minSq) minSq = d;
      dx = x2 - x1; dy = y2 - y1; dz = z2 - z1;
      d = dx * dx + dy * dy + dz * dz;
      if (d < minSq) minSq = d;
      dx = x0 - x2; dy = y0 - y2; dz = z0 - z2;
      d = dx * dx + dy * dy + dz * dz;
      if (d < minSq) minSq = d;
    }
    return minSq === Infinity ? Infinity : Math.sqrt(minSq);
  }

  // Build edge → incident-triangle map. Canonical key is "minIdx:maxIdx"
  // so both (a,b) and (b,a) collapse to the same bucket.
  const edgeKey = (a: number, b: number): string =>
    a < b ? `${a}:${b}` : `${b}:${a}`;
  const edgeToTris = new Map<string, number[]>();
  const addEdge = (a: number, b: number, triIdx: number) => {
    const k = edgeKey(a, b);
    const list = edgeToTris.get(k);
    if (list) list.push(triIdx);
    else edgeToTris.set(k, [triIdx]);
  };
  for (let t = 0; t < triCount; t++) {
    const base = t * 3;
    const v0 = triangles[base];
    const v1 = triangles[base + 1];
    const v2 = triangles[base + 2];
    addEdge(v0, v1, t);
    addEdge(v1, v2, t);
    addEdge(v2, v0, t);
  }

  // Pre-compute per-triangle smoothed normals once; we'd otherwise recompute
  // them for every edge visit on shared triangles.
  const triNormals = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const [nx, ny, nz] = triangleMeanNormal(normals, triangles, t);
    const base = t * 3;
    triNormals[base] = nx;
    triNormals[base + 1] = ny;
    triNormals[base + 2] = nz;
  }

  let minSqFeature = Infinity;
  let minSqAny = Infinity;
  for (const [key, tris] of edgeToTris) {
    const [aStr, bStr] = key.split(":");
    const a = Number(aStr) * 3;
    const b = Number(bStr) * 3;
    const dx = vertices[a]     - vertices[b];
    const dy = vertices[a + 1] - vertices[b + 1];
    const dz = vertices[a + 2] - vertices[b + 2];
    const lenSq = dx * dx + dy * dy + dz * dz;
    if (lenSq < minSqAny) minSqAny = lenSq;

    let isTangent = false;
    if (tris.length === 2) {
      const tA = tris[0] * 3;
      const tB = tris[1] * 3;
      const dot =
        triNormals[tA]     * triNormals[tB] +
        triNormals[tA + 1] * triNormals[tB + 1] +
        triNormals[tA + 2] * triNormals[tB + 2];
      if (dot > TANGENT_DOT_THRESHOLD) isTangent = true;
    }
    // Boundary edges (tris.length === 1) and junction edges (length > 2) are
    // ALWAYS real features — a hole rim is a boundary edge, an edge shared
    // by three+ triangles is a non-manifold junction that's definitely not
    // a smooth seam. Only skip the classic two-triangle tangent case.
    if (!isTangent && lenSq < minSqFeature) minSqFeature = lenSq;
  }

  if (minSqFeature === Infinity) {
    // Every edge was tangent — degenerate case (pure sphere, etc.). Avoid a
    // false "sub-nozzle feature" warning by returning a safe floor that keeps
    // downstream printability thresholds quiet.
    return minSqAny === Infinity ? Infinity : Math.max(TANGENT_FALLBACK_FLOOR_MM, Math.sqrt(minSqAny));
  }
  return Math.sqrt(minSqFeature);
}

function aggregateProperties(
  parts: ExecutedPart[],
  opts?: { geometryValid?: boolean; runtimeWarnings?: string[] },
): ShapeProperties {
  const geometryValid = opts?.geometryValid !== false; // undefined/true → treat as valid
  const runtimeWarnings = opts?.runtimeWarnings ?? [];
  const perPart = parts.map((p) => {
    const bbox = boundingBoxFromVertices(p.vertices);
    // Per-part opt-out for printability analysis. Mockup / reference parts
    // (a servo body, a tube included only for collision checks) get
    // `analyze: false` in the script's return array — the user isn't
    // printing them, so minFeature + manifold warnings are noise. We still
    // emit the part in the BOM (volume/mass/bbox/qty/material preserved);
    // only the `printability` heuristic is skipped. ExecutedPart extends
    // TessellatedPart which propagates the flag from PartInput.
    const skipAnalysis = p.analyze === false;

    const base = {
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

    if (skipAnalysis) {
      // Omit `printability` entirely — consumers treat "no printability field"
      // as "not analyzed" (vs "analyzed and clean", which sets the field with
      // an empty issues[] array). The part still appears in every BOM/mass/
      // bbox rollup because we return it above.
      return base;
    }

    const minEdge = minTriangleEdgeMm(p.vertices, p.triangles, p.normals);
    const issues: string[] = [];
    if (!geometryValid) {
      issues.push("Non-manifold geometry — OCCT validation failed");
    }
    // Boolean operations routinely leave sub-mm sliver edges at cut/fuse
    // boundaries — firing a printability warning on every part that ever
    // called .cut() was pure noise (48 identical lines on the
    // knitting-printer review). Narrow the threshold to 1/4 of a typical
    // nozzle: below 0.1 mm is far enough past boolean-artefact territory
    // that it probably IS a genuinely thin face, and the rewording admits
    // the ambiguity instead of asserting "below nozzle" as a fact.
    const MIN_EDGE_WARN_MM = DEFAULT_NOZZLE_MM / 4;
    if (Number.isFinite(minEdge) && minEdge < MIN_EDGE_WARN_MM) {
      issues.push(
        `Minimum edge fragment ${minEdge.toFixed(2)} mm — likely boolean artefact, not a printability concern unless a real face is thin`,
      );
    }
    // Attribute any drained runtime warning that names this part or calls out
    // a threads.* helper (the known unsliceable offender at small metric
    // sizes). String-contains is enough for MVP — we only want to surface
    // hints the user already sees in the top-level warnings block.
    for (const w of runtimeWarnings) {
      if (typeof w !== "string") continue;
      const mentionsPart = p.name && w.includes(p.name);
      const mentionsThreads = w.includes("threads.");
      if (mentionsPart || mentionsThreads) {
        issues.push(w);
      }
    }
    const printability = {
      manifold: geometryValid,
      minFeatureSize_mm: Number.isFinite(minEdge) ? minEdge : 0,
      issues,
    };
    return { ...base, printability };
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

  // "X is not defined" — ReferenceError thrown by the JS runtime when a
  // bare identifier isn't bound in scope. When the identifier is one the
  // entry imports from a LOCAL module, the bug is almost always that the
  // module doesn't actually export that symbol (rename / typo / removed
  // export). Enrich the hint with the specific import location so the
  // agent knows where to look instead of only seeing the usage site.
  //
  // Guard: only fire the enrichment when the symbol truly appears in the
  // import list. A generic "X is not defined" with no matching import
  // entry gets the plain generic hint — misattributing to a LOCAL import
  // when the symbol came from a package (or was a typo the user expected
  // to resolve via `const X = ...`) would be actively misleading.
  const notDefined = msg.match(/(\w+) is not defined/);
  if (notDefined) {
    const symbol = notDefined[1];
    if (source) {
      const imports = scanImportBindings(source);
      const match = imports.find((b) => b.binding === symbol);
      if (match) {
        return `'${symbol}' is imported from '${match.source}' at line ${match.line} — check that module actually exports it (typo? rename? removed export?). Open '${match.source}' and confirm 'export const ${symbol} = ...' (or an equivalent named export) is present.`;
      }
    }
    return `'${symbol}' is not defined in the current scope. If you meant to import it, add an import statement at the top of the file; if it's a typo, fix the usage; if the symbol is expected to come from a sibling .shape.ts, confirm the export and the specifier path.`;
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
