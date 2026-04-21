/**
 * ShapeItUp safety patch for non-fuse-safe thread Compounds.
 *
 * `threads.metric(...)`, `threads.external(...)`, and `threads.leadscrew(...)`
 * return a `Compound` built by lofting one solid per helix turn (see
 * `threads.ts` for the rationale). That Compound is intentionally NOT fused —
 * fusing N turns pairwise in OCCT is super-linear, and the per-turn loops
 * overlap by a small INTERFERENCE band that OCCT's boolean cannot cleanly
 * merge with another solid. Attempting `head.fuse(thread)` or
 * `plate.cut(thread)` on one of these Compounds crashes OCCT deep inside
 * `BRepCheck_Analyzer` with a cryptic non-manifold-seam error.
 *
 * To turn the crash into a clear, call-site error, we tag every returned
 * Compound with a non-enumerable marker property, then patch the
 * `_3DShape.prototype.fuse` / `.cut` methods (the shared base of Compound,
 * Solid, CompSolid — see replicad.d.ts:60, 406, 2324) to throw a helpful
 * message naming the fuse-safe alternatives when either operand carries the
 * marker.
 *
 * Like `finder-patch.ts`, this is idempotent: applying it twice is a no-op
 * (we sentinel the patched methods with `__shapeitupThreadGuard`). The
 * patch only mutates class prototypes on the replicad module — safe to call
 * at module load before OCCT is instantiated.
 */

import * as replicad from "replicad";
import { pushRuntimeWarning } from "./warnings";

/**
 * Non-enumerable marker attached to every non-fuse-safe thread Compound.
 * Non-enumerable so `Object.keys(shape)` and JSON serialization don't see it;
 * the property name is namespaced to avoid collision with any Replicad
 * internal (they use `_`-prefixed names).
 */
export const THREAD_COMPOUND_MARKER = "__shapeItUpNonFuseSafeThread" as const;

/**
 * Tag a Compound as a non-fuse-safe thread. Safe to call on any object
 * (no-ops on null/undefined). Uses `Object.defineProperty` so the marker is
 * non-enumerable and won't leak into enumeration-based clones.
 */
export function markNonFuseSafeThread<T>(shape: T): T {
  if (shape == null) return shape;
  try {
    Object.defineProperty(shape as any, THREAD_COMPOUND_MARKER, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } catch {
    /* frozen/sealed shape — best-effort, the guard will simply not trip */
  }
  return shape;
}

const GUARD_MESSAGE =
  "Cannot fuse/cut a non-manifold thread Compound with a solid.\n" +
  "Use `threads.metricMesh(size, length)` for a fuse-safe mesh thread,\n" +
  "or `threads.fuseThreaded(head, size, length, position)` to build a\n" +
  "bolt directly. See stdlib docs on Compound vs. Mesh threads.";

// One-shot latch for the auto-promote advisory. Module-level (not
// per-execute) because the latch's purpose is to avoid repeating the same
// nudge N times within a single script — a fresh run will happen from a
// fresh process/worker in practice, and even when it doesn't the hint is
// still safely deduplicated by call-site count below.
const AUTO_PROMOTE_WARNED = new Set<string>();
const AUTO_PROMOTE_KEY = "fuse";
const AUTO_PROMOTE_MESSAGE =
  "Auto-promoted non-fuse-safe thread Compound to Manifold kernel; this is " +
  "slower than `threads.metricMesh()`. Consider switching for production.";

let patched = false;

/**
 * Patch `_3DShape.prototype.fuse` and `.cut` in-place so they throw a clear
 * error the moment a user tries to fuse/cut against a marked thread
 * Compound. Idempotent via the `__shapeitupThreadGuard` sentinel.
 *
 * Exported for testability; the stdlib auto-applies it at module load via
 * {@link ensureThreadGuardPatched}.
 */
export function patchThreadGuard(mod: any): void {
  // `_3DShape` is the shared base of Compound / Solid / CompSolid. Patching
  // it covers every concrete 3D shape class (see replicad.d.ts:60).
  const Klass = mod?._3DShape;
  if (!Klass?.prototype) return;
  for (const method of ["fuse", "cut"] as const) {
    const original = Klass.prototype[method];
    if (!original || (original as any).__shapeitupThreadGuard) continue;
    Klass.prototype[method] = function guarded(
      this: any,
      other: any,
      ...rest: unknown[]
    ) {
      const selfMarked = this && this[THREAD_COMPOUND_MARKER];
      const otherMarked = other && other[THREAD_COMPOUND_MARKER];
      if (selfMarked || otherMarked) {
        // `.cut()` preserves its historical throw: cutting with (or into) a
        // marked thread Compound has no well-defined semantics — the thread
        // is made of interfering loops whose boolean result is unstable —
        // and silently auto-promoting would hide a real modeling error.
        // Only `.fuse()` has a clean auto-promote path (Manifold union of
        // meshed operands) that preserves user intent.
        if (method !== "fuse") {
          throw new Error(GUARD_MESSAGE);
        }
        // Auto-promote: mesh both operands via their respective `meshShape`
        // (Shape3D) or identity (already-mesh) and fuse via Manifold. The
        // tolerance mirrors the one used by `threads.tapInto` for consistency
        // — 0.01 mm is below the visible threshold on printed parts.
        const promoted = tryAutoPromoteFuse(this, other);
        if (promoted !== undefined) {
          if (!AUTO_PROMOTE_WARNED.has(AUTO_PROMOTE_KEY)) {
            AUTO_PROMOTE_WARNED.add(AUTO_PROMOTE_KEY);
            pushRuntimeWarning(AUTO_PROMOTE_MESSAGE);
          }
          return promoted;
        }
        // Fall back to the original guard error if promotion isn't possible
        // (e.g. neither operand exposes `meshShape` / the mesh kernel isn't
        // loaded). Better to surface the clear message than crash in OCCT.
        throw new Error(GUARD_MESSAGE);
      }
      return original.call(this, other, ...rest);
    };
    (Klass.prototype[method] as any).__shapeitupThreadGuard = true;
  }
}

/**
 * Promote both operands to `MeshShape` and fuse via Manifold. Returns the
 * fused MeshShape, or undefined if promotion isn't possible (needed inputs
 * missing `meshShape()` and aren't already mesh). A caller that gets
 * undefined should fall back to the throw path — we never silently corrupt
 * geometry just to avoid an error.
 */
function tryAutoPromoteFuse(a: any, b: any): any | undefined {
  const MESH_TOLERANCE = 0.01;
  const toMesh = (s: any): any | undefined => {
    if (s == null) return undefined;
    // MeshShape has `.fuse()` but no `.meshShape()` — the duck-type below
    // is also how `threads.asMeshShape` distinguishes the two.
    if (typeof s.meshShape === "function") {
      try {
        return s.meshShape({ tolerance: MESH_TOLERANCE });
      } catch {
        return undefined;
      }
    }
    // Already a mesh (or mesh-like) — pass through.
    if (typeof s.fuse === "function") return s;
    return undefined;
  };
  const ma = toMesh(a);
  const mb = toMesh(b);
  if (!ma || !mb) return undefined;
  try {
    return ma.fuse(mb);
  } catch {
    return undefined;
  }
}

/**
 * Clear the one-shot auto-promote warning latch. Exported for tests so they
 * can assert the "warn once per run" contract without needing to reach into
 * the module's private state.
 */
export function resetAutoPromoteWarned(): void {
  AUTO_PROMOTE_WARNED.clear();
}

/**
 * Apply the thread-Compound fuse/cut guard exactly once per process. Called
 * from `stdlib/index.ts` at module load — the replicad module is a
 * singleton, so patching the class prototypes once covers every subsequent
 * call.
 */
export function ensureThreadGuardPatched(): void {
  if (patched) return;
  patched = true;
  patchThreadGuard(replicad);
}
