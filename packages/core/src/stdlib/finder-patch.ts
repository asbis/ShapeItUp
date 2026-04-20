/**
 * ShapeItUp compatibility patch for Replicad EdgeFinder/FaceFinder `.and()`.
 *
 * Replicad's `.and()` expects an array of predicate callbacks. But the natural
 * single-callback form `.inDirection("Z").and(e => e.containsPoint(p))` is
 * widely taught in docs and feels consistent with `.not()`. Without this patch
 * a single callback throws "findersList.forEach is not a function" from deep
 * inside Replicad.
 *
 * We coerce a single function argument to [fn] so both forms work. The patch
 * is idempotent — applying it twice is a no-op thanks to the `__shapeitupPatched`
 * sentinel — and safe to call before OCCT is loaded: we only mutate class
 * prototypes, which exist on the replicad module at import time.
 */

import * as replicad from "replicad";

let patched = false;

/**
 * Patch EdgeFinder.prototype.and / FaceFinder.prototype.and in-place to accept
 * a single callback in addition to the documented array form. Idempotent.
 *
 * Exported so tests can invoke it against a mock replicad module, but the
 * stdlib auto-applies it at module load via {@link ensureFinderAndPatched}.
 */
export function patchFinderAnd(mod: any): void {
  const classes = ["EdgeFinder", "FaceFinder"];
  for (const name of classes) {
    const Klass = mod?.[name];
    if (!Klass?.prototype) continue;
    const originalAnd = Klass.prototype.and;
    if (!originalAnd || (originalAnd as any).__shapeitupPatched) continue;
    Klass.prototype.and = function patchedAnd(findersList: any) {
      if (typeof findersList === "function") {
        return originalAnd.call(this, [findersList]);
      }
      return originalAnd.call(this, findersList);
    };
    (Klass.prototype.and as any).__shapeitupPatched = true;
  }
}

/**
 * Apply the finder `.and()` patch exactly once per process. Called from
 * `stdlib/index.ts` at module load — the replicad module is a singleton, so
 * patching the class prototypes once covers every subsequent Shape3D call.
 */
export function ensureFinderAndPatched(): void {
  if (patched) return;
  patched = true;
  patchFinderAnd(replicad);
}
