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
  resetNonXYPlaneHint();
  resetExtrudePlaneHint();
}

// One-shot latch for the "sketchOnPlane is not XY — pen axis mapping may
// surprise you" hint. The pen's hLine/vLine map to different world axes on
// each of the six planes (see skill/SKILL.md "Pen axis mapping"), and first-
// time users routinely expect hLine to walk along world X even on "ZX"/"ZY"
// (where it actually walks along world Z). We fire the hint at most once per
// execute() — any non-XY plane triggers it, then the latch suppresses the
// rest. Reset by resetRuntimeWarnings() so each run starts fresh.
let nonXYPlaneHintFired = false;

/** Returns true the FIRST time it's called per run; false thereafter. */
export function claimNonXYPlaneHint(): boolean {
  if (nonXYPlaneHintFired) return false;
  nonXYPlaneHintFired = true;
  return true;
}

/** Reset the non-XY plane hint latch. Called from resetRuntimeWarnings(). */
export function resetNonXYPlaneHint(): void {
  nonXYPlaneHintFired = false;
}

// One-shot latch for the "sketchOnPlane(non-XY).extrude(L) → non-centered
// bounding box" hint. Agents routinely write
//   drawRectangle(40, 50).sketchOnPlane("XZ").extrude(20)
// expecting a slab centered on the origin, but sketchOnPlane's extrude grows
// into the NEGATIVE normal of the chosen plane — for "XZ" that means world-Y
// ∈ [-20, 0], not Y ∈ [-10, 10]. A cut-tool placed at y=0 then silently
// removes no material. We emit a structured, actionable hint that names the
// exact resulting bbox interval and suggests the translate/plane swap. One
// hint per run so a script with 20 sketches doesn't spam the warnings panel.
let extrudePlaneHintFired = false;

/**
 * Returns a hint string naming the bbox axis and interval the user will
 * actually get for `sketchOnPlane(plane).extrude(length)`, or null if the
 * combination is "safe" (XY is the conventional default — the +Z grow-up
 * direction is almost always what the user wants, so don't warn).
 *
 * The latch is consumed exactly once per execute(), so repeat calls within
 * one run return null after the first successful hint. A length of 0 or a
 * non-string plane also returns null (the extrude validator throws on
 * length=0 independently, and non-string planes are Plane objects we can't
 * reason about statically).
 */
export function emitExtrudePlaneHint(plane: string, length: number): string | null {
  if (extrudePlaneHintFired) return null;
  if (typeof plane !== "string" || plane === "XY") return null;
  if (typeof length !== "number" || !Number.isFinite(length) || length === 0) return null;

  // Mapping table: sketchOnPlane(plane) with a POSITIVE extrude length grows
  // along the plane's normal direction per replicad's convention. Rows below
  // are hand-verified against the test in packages/core/src/tests/.
  //   XY → +Z   YX → -Z
  //   XZ → -Y   ZX → +Y
  //   YZ → +X   ZY → -X
  //
  // For each plane we record:
  //   axis    — which world axis the bbox grows along
  //   sign    — +1 means [0, L], -1 means [-L, 0] (before factoring the user's
  //             own sign on `length`, which we fold in below)
  const PLANE_AXIS: Record<string, { axis: "X" | "Y" | "Z"; sign: 1 | -1 }> = {
    XY: { axis: "Z", sign: 1 },
    YX: { axis: "Z", sign: -1 },
    XZ: { axis: "Y", sign: -1 },
    ZX: { axis: "Y", sign: 1 },
    YZ: { axis: "X", sign: 1 },
    ZY: { axis: "X", sign: -1 },
  };
  const entry = PLANE_AXIS[plane];
  if (!entry) return null;

  // Fold the user's sign into the effective direction: a negative length
  // flips the extrude back the other way, which is actually the idiomatic way
  // to "point the other direction" without changing the plane.
  const effectiveSign = entry.sign * (length < 0 ? -1 : 1);
  const mag = Math.abs(length);
  const [lo, hi] = effectiveSign === 1 ? [0, mag] : [-mag, 0];

  // Translate suggestion: to center the bbox on the origin along the extrude
  // axis, shift by -(lo + hi) / 2 = -effectiveSign * mag / 2 along that axis.
  const centerShift = -effectiveSign * (mag / 2);
  const dx = entry.axis === "X" ? centerShift : 0;
  const dy = entry.axis === "Y" ? centerShift : 0;
  const dz = entry.axis === "Z" ? centerShift : 0;

  extrudePlaneHintFired = true;
  return (
    `sketchOnPlane('${plane}').extrude(${length}): shape bounding box will be ` +
    `${entry.axis} ∈ [${lo}, ${hi}]. Use .translate(${dx},${dy},${dz}) to center, ` +
    `or sketchOnPlane('XY') if Z-extrusion is intended.`
  );
}

/** Reset the extrude-plane hint latch. Called from resetRuntimeWarnings(). */
export function resetExtrudePlaneHint(): void {
  extrudePlaneHintFired = false;
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
