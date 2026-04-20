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
export { extractParamsStatic } from "./executor";
import { normalizeParts, tessellatePart, type MeshQuality, type PartInput, type PartStatsLevel, type TessellatedPart } from "./tessellate";
import { exportShapes } from "./exporter";
import {
  validateParts,
  hasGeometryErrors,
  partsWithErrors,
  type GeometryIssue,
} from "./validate";
import {
  resolveWasmException,
  markExecutionSucceeded,
} from "./wasm-exception";
import {
  beginInstrumentation,
  getTimings,
  instrumentReplicadExports,
} from "./instrumentation";
import { shapeitupStdlib } from "./stdlib";
import {
  drainExtrudeHints,
  drainRuntimeWarnings,
  nextCutCallIndex,
  nextFuseCallIndex,
  pushRuntimeWarning,
  resetRuntimeWarnings,
} from "./stdlib/warnings";

export type { PartInput, TessellatedPart, MeshQuality, PartStatsLevel } from "./tessellate";
export { exportShapes } from "./exporter";

// Re-export the shared externals list so MCP's engine (which already imports
// from core) doesn't need a second import statement for this constant.
// The canonical definition lives in @shapeitup/shared so the extension can
// also consume it without pulling OCCT into its bundle.
export { BUNDLE_EXTERNALS } from "@shapeitup/shared";
export {
  resolveWasmException,
  hasSucceededBefore,
  markExecutionSucceeded,
  resetWedgeTracking,
} from "./wasm-exception";
export type { GeometryIssue } from "./validate";

/**
 * How core obtains the OCCT handle. Callers supply a loader function that
 * returns the initialized `oc` object — this keeps Node-specific imports
 * (fs/path/module) out of the browser bundle, and vice versa. The worker and
 * the MCP server each own their loader implementation; core stays pure.
 */
export type OcctLoader = () => Promise<any>;
/**
 * Optional manifold-3d loader. When provided, core wires replicad's
 * `setManifold()` so `MeshShape` booleans become available (used by the
 * mesh-native thread path). Failing to provide this is non-fatal — any
 * feature that needs Manifold will throw at use time.
 */
export type ManifoldLoader = () => Promise<any>;

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
  /**
   * Flattened, human-readable warning strings. Includes stdlib runtime
   * warnings AND geometry-issue messages (both severities). Preserved for
   * backward compatibility — callers that surface this field verbatim still
   * work unchanged.
   */
  warnings: string[];
  /**
   * False when BRepCheck flagged at least one part as non-manifold / invalid.
   * When false, affected parts have `volume`/`surfaceArea`/`mass` omitted —
   * OCCT's measurements on broken shapes are wildly wrong (see Bug #4:
   * shell-on-revolve reported 1.4x the correct volume because duplicate
   * faces were counted twice).
   */
  geometryValid: boolean;
  /** Structured list of per-part geometry issues (may be empty). */
  geometryIssues?: GeometryIssue[];
  /**
   * Optional material declared by the script (`export const material = { density, name? }`).
   * `density` is grams per cubic centimeter. Only present when the script
   * exported a valid positive density — callers can treat presence as
   * "use this to derive mass". Absent otherwise.
   */
  material?: { density: number; name?: string };
}

/**
 * Compute the center of mass of a triangle mesh via tetrahedron integration.
 *
 * Manifold exposes `volume()` and `surfaceArea()` on MeshShape but NOT
 * centroid/CoM, and `measureShapeVolumeProperties` only works on OCCT
 * B-Rep solids. We already have the tessellated mesh (vertices + triangles)
 * from the tessellation pass, so we can integrate directly: each triangle
 * (v0,v1,v2) forms a tetrahedron with apex at the origin, with signed
 * volume v0·(v1×v2)/6 and centroid (v0+v1+v2)/4. Summing centroid·volume
 * and dividing by total signed volume gives the solid's CoM — provided
 * the mesh is closed and outward-oriented (which Manifold guarantees).
 *
 * Returns undefined for empty / degenerate meshes (signed volume ~= 0,
 * which happens on open shells, zero-volume geometry, or bad input);
 * downstream consumers already treat centerOfMass as optional.
 *
 * `vertices` is a Float32Array of length 3N (xyz flat); `triangles` is a
 * Uint32Array of length 3M indexing into vertices/3. Mirrors the layout
 * produced by `tessellatePart` in tessellate.ts.
 */
export function computeMeshCoM(
  vertices: Float32Array,
  triangles: Uint32Array,
): [number, number, number] | undefined {
  if (triangles.length < 3 || vertices.length < 9) return undefined;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let totalVol6 = 0; // accumulate 6*signed_volume to avoid per-tri /6 divisions
  for (let i = 0; i < triangles.length; i += 3) {
    const i0 = triangles[i] * 3;
    const i1 = triangles[i + 1] * 3;
    const i2 = triangles[i + 2] * 3;
    const x0 = vertices[i0], y0 = vertices[i0 + 1], z0 = vertices[i0 + 2];
    const x1 = vertices[i1], y1 = vertices[i1 + 1], z1 = vertices[i1 + 2];
    const x2 = vertices[i2], y2 = vertices[i2 + 1], z2 = vertices[i2 + 2];
    // 6 * signed volume of tetrahedron (origin, v0, v1, v2) = v0 · (v1 × v2)
    const v6 =
      x0 * (y1 * z2 - z1 * y2) +
      y0 * (z1 * x2 - x1 * z2) +
      z0 * (x1 * y2 - y1 * x2);
    // Tetrahedron centroid is (0 + v0 + v1 + v2) / 4; weighting by 6*vol
    // means the final divisor is 4 * totalVol6.
    cx += (x0 + x1 + x2) * v6;
    cy += (y0 + y1 + y2) * v6;
    cz += (z0 + z1 + z2) * v6;
    totalVol6 += v6;
  }
  if (!Number.isFinite(totalVol6) || Math.abs(totalVol6) < 1e-12) {
    return undefined;
  }
  const denom = 4 * totalVol6;
  return [cx / denom, cy / denom, cz / denom];
}

/**
 * Tracks whether the `_mesh` prototype patch has already been applied. The
 * replicad module is a singleton (ESM import caches), so a second initCore()
 * call would otherwise wrap the already-wrapped `_mesh` — technically safe,
 * but wasteful and confusing in stack traces.
 */
let meshPatchApplied = false;

/**
 * Replace Shape.prototype._mesh with a variant that deletes the
 * BRepMesh_IncrementalMesh_2 wrapper after the meshing side effect has run.
 * Exported for the test suite — production callers go through initCore().
 */
export function patchShapeMeshLeak(replicad: any): boolean {
  if (meshPatchApplied) return true;
  // Shape is replicad's base class for all 3D/topology wrappers — see
  // replicad.js line 2938. _3DShape, Face, Edge, Vertex, Wire, _1DShape
  // all inherit from it, so patching the base covers every caller.
  const ShapeCtor = replicad?.Shape;
  const proto = ShapeCtor?.prototype;
  if (!proto || typeof proto._mesh !== "function") {
    // Replicad internals moved — log once and skip. Better to leak than to
    // crash the whole extension because of a refactor in replicad.
    // eslint-disable-next-line no-console
    console.warn(
      "[shapeitup] Shape.prototype._mesh not found — leak fix skipped. " +
        "Replicad internals may have changed."
    );
    return false;
  }
  proto._mesh = function patchedMesh(
    this: { oc: any; wrapped: any },
    opts: { tolerance?: number; angularTolerance?: number } = {}
  ) {
    const tolerance = opts.tolerance ?? 1e-3;
    const angularTolerance = opts.angularTolerance ?? 0.1;
    const m = new this.oc.BRepMesh_IncrementalMesh_2(
      this.wrapped,
      tolerance,
      false,
      angularTolerance,
      false
    );
    // OCCT's meshing happens inside the ctor; the wrapper is done. Swallow
    // any delete failure — freeing an already-freed handle is rare (replicad
    // holds no other reference) but not worth crashing user renders over.
    try {
      m.delete();
    } catch {
      // best effort
    }
  };
  meshPatchApplied = true;
  return true;
}

/**
 * Tracks whether the `Shape.prototype.cut` no-op guard has already been wrapped.
 * Same rationale as `meshPatchApplied` — replicad is a singleton, so wrapping
 * twice would double-measure every cut in the pipeline.
 */
let cutPatched = false;
/**
 * Sibling flag for {@link patchShapeFuseNoOpGuard}. Separate from `cutPatched`
 * because the two patches can in principle be applied independently (tests
 * do this), but both must be idempotent on repeat calls.
 */
let fusePatched = false;

/**
 * Test-only: forget that we patched the cut prototype so a fresh fake
 * replicad module can be instrumented on the next `patchShapeCutNoOpGuard`
 * call. Production never calls this — initCore() runs once per process and
 * the singleton replicad module is stable. Exported explicitly (not via the
 * module index barrel) so it's easy to grep for accidental production use.
 */
export function __resetCutPatchedForTests(): void {
  cutPatched = false;
}

/** Test-only counterpart to {@link __resetCutPatchedForTests} for the fuse guard. */
export function __resetFusePatchedForTests(): void {
  fusePatched = false;
}

/**
 * Volume-equality tolerance below which a cut is treated as a no-op. Matches
 * the epsilon `patterns.cutAt` already uses for its post-cut volume check
 * (see packages/core/src/stdlib/patterns.ts). 1e-6 mm³ sits well below OCCT's
 * own measurement noise floor on well-formed solids, so any real material
 * removal beats it.
 */
const CUT_VOLUME_EPSILON = 1e-6;

/**
 * Best-effort AABB read used by the cut-no-op guard's axis diagnostic.
 * Mirrors the contract in stdlib/patterns.ts's `readBounds` — returns
 * undefined when the shape doesn't expose a usable bounding box (Replicad
 * backend degenerate result, MeshShape, test mocks that don't wire it up).
 * Callers treat undefined as "can't tell" and skip the axis suffix rather
 * than emitting a half-formed diagnostic.
 */
function readBoundsSafe(
  shape: any,
): [[number, number, number], [number, number, number]] | undefined {
  try {
    const bb = shape?.boundingBox;
    if (!bb) return undefined;
    const bounds = bb.bounds;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !Array.isArray(bounds[0]) ||
      !Array.isArray(bounds[1]) ||
      bounds[0].length !== 3 ||
      bounds[1].length !== 3
    ) {
      return undefined;
    }
    return bounds as [[number, number, number], [number, number, number]];
  } catch {
    return undefined;
  }
}

/**
 * Build an "X/Y/Z disjoint" suffix for the plain-.cut() no-op warning when
 * we can prove from the two AABBs that the cutter never touched the target.
 * Returns an empty string when the bboxes overlap on every axis (the cut is
 * a no-op for a reason other than bbox-disjointness — e.g. the tool sits
 * entirely inside the shape's interior or is smaller than the tolerance).
 * Returns an empty string when either bbox is unavailable.
 */
function axisDisjointHint(
  target: [[number, number, number], [number, number, number]] | undefined,
  tool: [[number, number, number], [number, number, number]] | undefined,
): string {
  if (!target || !tool) return "";
  const axes = ["X", "Y", "Z"] as const;
  for (let i = 0; i < 3; i++) {
    const tMin = target[0][i];
    const tMax = target[1][i];
    const cMin = tool[0][i];
    const cMax = tool[1][i];
    if (cMax < tMin || cMin > tMax) {
      return (
        ` Target ${axes[i]} ∈ [${tMin.toFixed(2)}, ${tMax.toFixed(2)}], ` +
        `cutter ${axes[i]} ∈ [${cMin.toFixed(2)}, ${cMax.toFixed(2)}] — disjoint on ${axes[i]} axis.`
      );
    }
  }
  return "";
}

/**
 * Best-effort volume read used by the cut-no-op guard. Mirrors the contract
 * in stdlib/patterns.ts — returns undefined if measurement is unavailable
 * (kernel-free mock in tests) or throws, and always releases the OCCT
 * measurement handle. Callers treat undefined as "can't tell" and skip the
 * warning rather than risk a false positive.
 */
function readVolumeSafe(shape: any, replicad: any): number | undefined {
  try {
    const measure = replicad?.measureShapeVolumeProperties;
    if (typeof measure !== "function") return undefined;
    const props = measure(shape);
    if (!props || typeof props.volume !== "number" || !Number.isFinite(props.volume)) {
      try { props?.delete?.(); } catch {}
      return undefined;
    }
    const v = props.volume;
    try { props.delete?.(); } catch {}
    return v;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `Shape.prototype.cut` with a volume-equality sanity check. The #1
 * trust-breaking bug an external engineer hit was a box.cut(cylinder) where
 * the cylinder had been translated outside the box — OCCT happily returns the
 * original box, nothing changed, user sees "Render SUCCESS", and the
 * holes.through() they placed silently did nothing.
 *
 * patterns.cutAt already has this check (see stdlib/patterns.ts line ~388) —
 * users who call raw `.cut()` deserve the same safety net.
 *
 * Implementation: before delegating to the original cut, snapshot `this`'s
 * volume; after the cut completes, compare. If the output volume is within
 * CUT_VOLUME_EPSILON of the input, push a runtime warning. Measurement is
 * best-effort: if either reading fails, the cut proceeds and no warning is
 * emitted (better to miss a warning than to crash on a mock or a MeshShape
 * that doesn't support measureShapeVolumeProperties).
 *
 * Exported for the test suite — production callers go through initCore().
 */
export function patchShapeCutNoOpGuard(replicad: any): boolean {
  if (cutPatched) return true;
  // `cut` lives on _3DShape (replicad.d.ts line 77). Solid / CompSolid /
  // Compound / Shell all inherit from _3DShape, so wrapping the base covers
  // every 3D cut call. MeshShape has its own cut() (line 1689) on an unrelated
  // class hierarchy and isn't patched — Manifold's boolean engine is solid,
  // and the user's complaint was about OCCT's raw .cut() anyway.
  const ShapeCtor = replicad?._3DShape;
  const proto = ShapeCtor?.prototype;
  if (!proto || typeof proto.cut !== "function") {
    // Replicad internals moved — skip silently. Leaking the warning is better
    // than crashing initCore() over a refactor we can recover from.
    // eslint-disable-next-line no-console
    console.warn(
      "[shapeitup] _3DShape.prototype.cut not found — cut no-op guard skipped. " +
        "Replicad internals may have changed."
    );
    return false;
  }
  const originalCut = proto.cut;
  proto.cut = function patchedCut(this: any, other: any, options?: any) {
    // Always consume a call ordinal so every .cut() on this core's prototype
    // gets a stable number — whether or not a warning fires. Attribution
    // only works if numbering is consistent across the whole run (otherwise
    // the user sees "cut #3" in the output but has no way to count to #3 in
    // their source).
    const callIdx = nextCutCallIndex();
    // Snapshot input volume BEFORE the cut. If measurement fails we still
    // run the cut (we just won't emit a warning). Using `this` here — the
    // target of the cut, i.e. the shape we're subtracting from.
    const inputVolume = readVolumeSafe(this, replicad);
    // Snapshot AABBs of target and tool up-front. Used only if the volume
    // check fires — then we can tell the user which axis is disjoint, which
    // is the single most common cause of a silent no-op cut. Reading bounds
    // after the cut would show the RESULT's bounds, not the cutter's.
    const targetBounds = readBoundsSafe(this);
    const toolBounds = readBoundsSafe(other);
    const result = originalCut.call(this, other, options);
    // Only check when we have a positive input volume (zero-volume input
    // means there's nothing to remove, and a measurement-failed input is
    // already signalling trouble upstream).
    if (typeof inputVolume === "number" && inputVolume > 0) {
      const outputVolume = readVolumeSafe(result, replicad);
      if (
        typeof outputVolume === "number" &&
        Math.abs(outputVolume - inputVolume) < CUT_VOLUME_EPSILON
      ) {
        const axisHint = axisDisjointHint(targetBounds, toolBounds);
        pushRuntimeWarning(
          `cut #${callIdx}: cut produced no material removal — ` +
            `input and output volumes are equal (V=${inputVolume.toFixed(2)} mm³). ` +
            `Common causes: cutter disjoint from target (wrong Y/Z sign), ` +
            `sketchOnPlane("XZ").extrude(L) grows toward -Y not +Y, ` +
            `cutter smaller than measurement tolerance.` +
            axisHint,
        );
      }
    }
    return result;
  };
  cutPatched = true;
  return true;
}

/**
 * Sibling to {@link patchShapeCutNoOpGuard} for `.fuse()`. If `a.fuse(b)`
 * returns a shape with the same volume as `a`, one of two things went
 * wrong:
 *   1. `b` was fully contained in `a` — the union is a no-op. The user
 *      almost certainly expected `b` to stick out / add material.
 *   2. `b` was disjoint from `a` but OCCT silently produced a compound
 *      shape (not a proper union). For disjoint solids, returning them
 *      as separate parts is the right model, not fuse.
 *
 * Either way, a silent-success fuse is a trust-breaking failure mode — the
 * user sees "Render SUCCESS" and no warning, but the part they tried to add
 * isn't there. We emit a runtime warning via the same stdlib channel as the
 * cut guard. As with the cut guard: never throws, degrades silently when
 * measurement is unavailable.
 *
 * Exported for the test suite — production callers go through initCore().
 */
export function patchShapeFuseNoOpGuard(replicad: any): boolean {
  if (fusePatched) return true;
  // `fuse` lives on _3DShape (same base as `cut`). Solid / CompSolid /
  // Compound / Shell all inherit from it. MeshShape has its own fuse() on
  // an unrelated class hierarchy — Manifold's boolean engine is solid and
  // the wishlist item specifically calls out OCCT's .fuse, so we don't
  // patch MeshShape.fuse.
  const ShapeCtor = replicad?._3DShape;
  const proto = ShapeCtor?.prototype;
  if (!proto || typeof proto.fuse !== "function") {
    // eslint-disable-next-line no-console
    console.warn(
      "[shapeitup] _3DShape.prototype.fuse not found — fuse no-op guard skipped. " +
        "Replicad internals may have changed.",
    );
    return false;
  }
  const originalFuse = proto.fuse;
  proto.fuse = function patchedFuse(this: any, other: any, options?: any) {
    // Consume a call ordinal on every .fuse(), mirroring the cut guard —
    // when a user has several .fuse() calls in one script and one silently
    // produces no new material, identical warnings make the offender
    // impossible to locate.
    const callIdx = nextFuseCallIndex();
    const inputVolume = readVolumeSafe(this, replicad);
    const result = originalFuse.call(this, other, options);
    if (typeof inputVolume === "number" && inputVolume > 0) {
      const outputVolume = readVolumeSafe(result, replicad);
      if (
        typeof outputVolume === "number" &&
        Math.abs(outputVolume - inputVolume) < CUT_VOLUME_EPSILON
      ) {
        pushRuntimeWarning(
          `fuse #${callIdx}: fuse produced no new material — ` +
            `input and output volumes are equal (V=${inputVolume.toFixed(2)} mm³). ` +
            `Common causes: ` +
            `the added solid is fully inside the target (union is a no-op), ` +
            `the added solid is disjoint from the target but compound-shape semantics ` +
            `hid the error (use .fuse for overlapping solids; for disjoint shapes, ` +
            `return them as separate parts).`,
        );
      }
    }
    return result;
  };
  fusePatched = true;
  return true;
}

export interface Core {
  /**
   * Execute a user script. Cleans up previous shapes automatically.
   *
   * Pass `streaming.onStart` to learn the part count before tessellation,
   * and `streaming.onPart` to receive each tessellated+measured part as
   * soon as it's ready. Together these enable progressive rendering: the
   * worker can postMessage per part so the viewer shows part 1 before part
   * N has finished meshing.
   */
  execute(
    js: string,
    paramOverrides?: Record<string, number>,
    streaming?: {
      onStart?: (totalParts: number) => void;
      onPart?: (part: TessellatedPart, index: number, total: number) => void;
      /**
       * Optional tessellation-quality hint. `"final"` (default) matches the
       * pre-existing behaviour. `"preview"` coarsens the mesh ~2.5× for
       * faster first-render on large assemblies (P3-10). Callers typically
       * pick this based on part count — e.g. auto-degrade to `"preview"`
       * when there are 15+ parts in the returned assembly.
       */
      meshQuality?: MeshQuality;
      /**
       * Issue #6: how much per-part measurement to do. Default is `"bbox"` —
       * fast CoM from the AABB centre, volume / surfaceArea omitted. Pass
       * `"full"` only when the caller actually needs the OCCT-measured
       * numbers (e.g. an aggregator computing total mass / CoM).
       */
      partStats?: PartStatsLevel;
    },
  ): Promise<ExecutionResult>;
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
export async function initCore(
  loadOcct: OcctLoader,
  loadManifold?: ManifoldLoader,
): Promise<Core> {
  // Load OCCT and (optionally) manifold-3d in parallel — both are
  // independent ~1-2s WASM fetches + initializations.
  const [oc, manifold] = await Promise.all([
    loadOcct(),
    loadManifold ? loadManifold() : Promise.resolve(null),
  ]);

  const replicad = await import("replicad");
  replicad.setOC(oc);
  if (manifold) replicad.setManifold(manifold);

  // Patch Shape.prototype._mesh to release the BRepMesh_IncrementalMesh_2
  // wrapper that replicad's own implementation leaks. Verified against
  // node_modules/replicad/dist/replicad.js line 3082:
  //
  //   _mesh({ tolerance = 1e-3, angularTolerance = 0.1 } = {}) {
  //     new this.oc.BRepMesh_IncrementalMesh_2(this.wrapped, tolerance, false,
  //                                            angularTolerance, false);
  //   }
  //
  // The OCCT constructor runs its incremental-meshing algorithm as a side
  // effect and writes the result onto the shape's internal triangulation;
  // the wrapper object itself is not needed after return. Replicad never
  // deletes it, so every mesh() call (used by tessellate.ts AND the STL
  // exporter AND meshEdges) leaks one emscripten-allocated object into the
  // OCCT heap. On multi-part exports this compounds until a later
  // allocation hits out-of-bounds and every subsequent OCCT call crashes.
  //
  // `_mesh` lives on the Shape base class (replicad.js line 2938); both
  // _3DShape and Face inherit from it, so patching the base covers every
  // call site (Shape#mesh at 3098, Shape#meshEdges at 3266 — which also
  // re-meshes via this.wrapped, though its own transient handles are
  // scoped under GCWithScope).
  patchShapeMeshLeak(replicad);

  // Wrap _3DShape.prototype.cut so raw .cut() calls pick up the same
  // silent-no-op detection that patterns.cutAt already provides. Without
  // this, a user who calls `box.cut(cylinder)` with a cylinder translated
  // outside the box sees "Render SUCCESS" and no warning — the #1
  // trust-breaking bug reported by external engineers. The guard emits a
  // runtime warning through the stdlib channel; it never throws, so
  // legitimate tolerance-sized cuts are not blocked.
  patchShapeCutNoOpGuard(replicad);
  // Symmetric guard for `.fuse()` — warns when a fuse didn't actually add
  // material (disjoint compound-shape fallback, or `b` fully inside `a`).
  // Same trust-breaking failure mode as the silent-no-op cut, same fix.
  patchShapeFuseNoOpGuard(replicad);

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
    paramOverrides?: Record<string, number>,
    streaming?: {
      onStart?: (totalParts: number) => void;
      onPart?: (part: TessellatedPart, index: number, total: number) => void;
      meshQuality?: MeshQuality;
      partStats?: PartStatsLevel;
    },
  ): Promise<ExecutionResult> {
    cleanup();
    beginInstrumentation();
    // Clear any stdlib runtime warnings left over from a prior failed run
    // so they don't leak into this execution's warnings[].
    resetRuntimeWarnings();
    const execStart = performance.now();

    const gc = replicadExports.localGC ? replicadExports.localGC() : null;
    const cleanupGC = gc ? gc[1] : () => {};

    let result: any;
    let params: ParamDef[];
    let material: { density: number; name?: string } | undefined;
    let scriptConfig: { strict?: boolean } | undefined;
    try {
      const execResult = executeScript(js, replicadExports, shapeitupStdlib, paramOverrides);
      result = execResult.result;
      params = execResult.params;
      material = execResult.material;
      scriptConfig = execResult.config;
    } catch (err) {
      cleanupGC();
      // If the user script threw a raw WASM pointer, wrap it in an Error with
      // a resolved message so downstream catch blocks don't have to re-handle
      // the numeric case. Preserve the original operation tag so
      // inferErrorHint can still branch on it, AND thread it into the
      // resolver so boolean/fillet failures get a hint targeted at the
      // actual failure mode instead of the generic "simplify geometry" line.
      if (!(err instanceof Error)) {
        const op = (err as any)?.operation;
        const message = resolveWasmException(err, oc, op);
        const wrapped = new Error(message);
        if (op) (wrapped as any).operation = op;
        throw wrapped;
      }
      throw err;
    }

    const parts = normalizeParts(result);
    lastParts = parts;
    const execTime = performance.now() - execStart;

    // Drain the deferred extrude-plane hints (Issue #1 follow-up). These were
    // enqueued synchronously at extrude time in instrumentation.ts, but only
    // emitted here IF the final part's bbox still covers the predicted problem
    // region. Users who extrude on "XZ" and then translate the part into +Y
    // space no longer get a stale warning about Y ∈ [-L, 0]. Read bboxes via
    // the existing `readBoundsSafe` helper (returns the
    // [[minx,miny,minz],[maxx,maxy,maxz]] tuple or undefined); if none of the
    // parts expose a bbox, the hint queue gets drained against an empty list
    // and every pending hint is silently discarded — better than emitting a
    // prediction we can't verify.
    const finalBboxes = parts
      .map((p) => readBoundsSafe(p.shape))
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((b) => ({ min: b[0], max: b[1] }));
    const extrudeHintMsgs = drainExtrudeHints(finalBboxes);
    for (const msg of extrudeHintMsgs) pushRuntimeWarning(msg);

    // Merge stdlib runtime warnings (e.g. patterns.cutAt no-op detection)
    // with the post-execution validateParts output. Keep runtime warnings
    // first — they reflect events that happened during the user's script
    // and are almost always more actionable than the geometric checks.
    const stdlibWarnings = drainRuntimeWarnings();

    // Feature #3 (strict mode): when the script exports
    // `export const config = { strict: true }`, a curated set of
    // silent-success warnings are promoted to hard errors. The patterns
    // below match the no-op guards emitted by the cut / fuse prototype
    // patches above and by the stdlib fillet/shell wrappers — these are
    // exactly the "render SUCCESS but nothing happened" failure modes
    // users asked to be loud about. Non-matching warnings still pass
    // through to `warnings[]` as before so the strict mode stays
    // surgical (doesn't upgrade, e.g., missing material hints).
    if (scriptConfig?.strict) {
      const STRICT_PATTERN =
        /cut produced no material|fuse produced no new material|\.fillet.*0 edges|fillet.*no edge|\.shell.*0 faces|subsumed fuse/i;
      const matched = stdlibWarnings.filter((w) => STRICT_PATTERN.test(w));
      if (matched.length > 0) {
        cleanupGC();
        throw new Error(
          `strict mode: ${matched.join("; ")}`,
        );
      }
    }

    const geometryIssues = validateParts(parts, replicad);
    const geometryValid = !hasGeometryErrors(geometryIssues);
    const invalidPartNames = partsWithErrors(geometryIssues);
    const warnings = [
      ...stdlibWarnings,
      ...geometryIssues.map((i) => i.message),
    ];
    streaming?.onStart?.(parts.length);

    const tessStart = performance.now();
    const tessellated: TessellatedPart[] = [];
    // P3-10 auto-degrade: if the caller didn't pick a quality explicitly,
    // fall back to "preview" when the assembly has >= 15 parts — at that
    // point first-render latency dominates perceived quality, and the 2.5×
    // coarser mesh is still easily good enough for layout/screenshot review.
    // Threshold picked from the render-timeout investigation: below 15
    // parts the tolerance bbox scaling already keeps worst-case render
    // under ~5s, but past 15 the per-part fixed costs stack up.
    //
    // Issue #6 extension: also degrade when the assembly projects to more
    // than ~50k triangles. We don't know the real triangle count until we
    // tessellate, but `parts.length * 5000` is a decent upper-bound rough
    // projection for moderately complex parts and matches the 15×5000 ≈
    // 75k implicit threshold from the original part-count rule. Keeping
    // the estimator simple and explicit (no bbox walk) makes the
    // degradation decision cheap and deterministic.
    const PROJECTED_TRIANGLE_BUDGET = 50_000;
    const projectedTriangles = parts.length * 5000;
    const shouldAutoDegrade =
      parts.length >= 15 || projectedTriangles > PROJECTED_TRIANGLE_BUDGET;
    const effectiveQuality: MeshQuality =
      streaming?.meshQuality ?? (shouldAutoDegrade ? "preview" : "final");
    // Issue #6: gate per-part B-Rep measurement. On a 14-part assembly the
    // two measureShape*Properties calls together spent ~2.5 s on the hot
    // path. Default `"bbox"` skips both and derives centerOfMass from the
    // AABB centre — that's still a useful approximation for assembly
    // aggregation, and per-part volume/surfaceArea rarely gets consumed.
    const partStats: PartStatsLevel = streaming?.partStats ?? "bbox";
    // Tessellate + measure + emit each part before moving to the next, so
    // `onPart` callers can stream to the viewer as the worker goes.
    for (let i = 0; i < parts.length; i++) {
      const shape = parts[i].shape;
      const t = tessellatePart(parts[i], { meshQuality: effectiveQuality });
      const partInvalid = invalidPartNames.has(parts[i].name);
      if (!partInvalid) {
        // Skip measurement for parts that failed BRepCheck — OCCT returns
        // inflated / nonsensical numbers on broken solids (duplicated faces
        // are counted twice, etc.).
        //
        // MeshShape (Manifold mesh — returned by threads.tapInto, bolts.nut,
        // bolts.*Mesh, etc.) is NOT an OCCT B-Rep solid, so
        // measureShapeVolumeProperties/measureShapeSurfaceProperties silently
        // fail and the per-part row comes back as bbox-only. Manifold exposes
        // `volume()` and `surfaceArea()` directly on MeshShape — detect the
        // duck-typed form and prefer them. Manifold does NOT expose
        // center-of-mass directly, but we already have the tessellated
        // triangle mesh in `t.vertices` / `t.triangles`, so compute CoM via
        // tetrahedron integration (signed volumes, apex at origin). This
        // keeps aggregate CoM meaningful for assemblies containing
        // MeshShape parts (e.g. threaded rods) rather than returning
        // undefined and forcing the aggregator to report "unavailable".
        const isMeshShape =
          typeof shape?.volume === "function" &&
          typeof shape?.surfaceArea === "function";
        if (partStats === "full") {
          if (isMeshShape) {
            try {
              const v = shape.volume();
              if (Number.isFinite(v)) t.volume = v;
            } catch {}
            try {
              const a = shape.surfaceArea();
              if (Number.isFinite(a)) t.surfaceArea = a;
            } catch {}
            const com = computeMeshCoM(t.vertices, t.triangles);
            if (com) t.centerOfMass = com;
          } else {
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
          }
          // Derive mass only when we have both a volume and a positive density.
          // volume is in mm³; density is in g/cm³; so divide by 1000 to convert.
          if (material && typeof t.volume === "number") {
            t.mass = (material.density * t.volume) / 1000;
          }
        } else if (partStats === "bbox") {
          // Cheap CoM: use the shape's AABB centre (O(1), no OCCT measure).
          // volume / surfaceArea / mass stay omitted — callers who need
          // exact numbers pass partStats: "full". Fall through silently if
          // the shape has no usable bbox (MeshShape duck-type, test mocks).
          const bounds = readBoundsSafe(shape);
          if (bounds) {
            t.centerOfMass = [
              (bounds[0][0] + bounds[1][0]) / 2,
              (bounds[0][1] + bounds[1][1]) / 2,
              (bounds[0][2] + bounds[1][2]) / 2,
            ];
          }
        }
        // partStats === "none": nothing to do. volume/surfaceArea/mass/CoM
        // all stay undefined on the emitted part.
      }
      tessellated.push(t);
      streaming?.onPart?.(t, i, parts.length);
    }
    const tessTime = performance.now() - tessStart;

    cleanupGC();

    const executed: ExecutedPart[] = tessellated.map((t, i) => ({
      ...t,
      shape: parts[i].shape,
    }));

    // Bug #8: remember that at least one execute() has completed on this OCCT
    // instance. Downstream hint logic uses this to distinguish "pointer N" on
    // a fresh heap (almost always a user-script / import bug) from "pointer N"
    // after a prior success (almost always wedged-heap corruption — the hint
    // should say "retry after reset", not "check your imports").
    markExecutionSucceeded();

    return {
      parts: executed,
      params,
      execTimeMs: Math.round(execTime),
      tessTimeMs: Math.round(tessTime),
      timings: getTimings(),
      warnings,
      geometryValid,
      geometryIssues: geometryIssues.length > 0 ? geometryIssues : undefined,
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
