/**
 * Per-execution runtime-warning buffer used by stdlib helpers to surface
 * advisory messages back through the engine's `warnings[]` channel.
 *
 * Examples: a `patterns.cutAt` placement whose tool doesn't overlap the
 * target's bounding box (silent no-op cut), or a heuristic check that a
 * boolean op produced no visible change. The stdlib helper pushes a string;
 * the engine drains after each execute() and merges into the result.
 *
 * Assumes serial execution (one script at a time). Reset at the start of
 * every execute() so stale warnings from a prior failed run never leak
 * forward.
 */

const buf: string[] = [];

export function pushRuntimeWarning(msg: string): void {
  buf.push(msg);
}

export function drainRuntimeWarnings(): string[] {
  const out = buf.slice();
  buf.length = 0;
  return out;
}

export function resetRuntimeWarnings(): void {
  buf.length = 0;
  resetCutAtCounter();
  resetCutCallCounter();
  resetFuseCallCounter();
}

// ---------------------------------------------------------------------------
// Per-execution counters for stdlib-warning attribution. When a user script
// calls the same helper multiple times (e.g. three `patterns.cutAt(...)` in
// one file), a bare "no material removed" warning forces the engineer to
// hunt. Prefix each warning with its call ordinal so the offending call is
// identifiable without a stack trace.
//
// Reset by resetRuntimeWarnings(), which core.execute() calls at the top of
// every run — same lifecycle as the warning buffer itself.
// ---------------------------------------------------------------------------

let cutAtCounter = 0;

/** Increment and return the next `patterns.cutAt` call ordinal (1-based). */
export function nextCutAtCallIndex(): number {
  cutAtCounter += 1;
  return cutAtCounter;
}

/** Reset the `cutAt` call ordinal. Called from resetRuntimeWarnings(). */
export function resetCutAtCounter(): void {
  cutAtCounter = 0;
}

// Parallel counter for plain `.cut()` calls (the prototype-patched guard in
// packages/core/src/index.ts). Same rationale as `cutAtCounter`: when a user
// has five `.cut()` calls in one script and one silently removes no material,
// identical warnings make the offender impossible to locate. Each guard
// invocation consumes one ordinal so warnings read "cut #3: ...".
let cutCallCounter = 0;

/** Increment and return the next plain `.cut()` call ordinal (1-based). */
export function nextCutCallIndex(): number {
  cutCallCounter += 1;
  return cutCallCounter;
}

/** Reset the plain `.cut()` call ordinal. Called from resetRuntimeWarnings(). */
export function resetCutCallCounter(): void {
  cutCallCounter = 0;
}

// Parallel counter for plain `.fuse()` calls. Same rationale as cutCallCounter.
let fuseCallCounter = 0;

/** Increment and return the next plain `.fuse()` call ordinal (1-based). */
export function nextFuseCallIndex(): number {
  fuseCallCounter += 1;
  return fuseCallCounter;
}

/** Reset the plain `.fuse()` call ordinal. Called from resetRuntimeWarnings(). */
export function resetFuseCallCounter(): void {
  fuseCallCounter = 0;
}
