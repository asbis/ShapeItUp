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
      if (
        (this && this[THREAD_COMPOUND_MARKER]) ||
        (other && other[THREAD_COMPOUND_MARKER])
      ) {
        throw new Error(GUARD_MESSAGE);
      }
      return original.call(this, other, ...rest);
    };
    (Klass.prototype[method] as any).__shapeitupThreadGuard = true;
  }
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
