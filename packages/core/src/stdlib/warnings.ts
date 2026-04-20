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
  resetPendingExtrudeHints();
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

/**
 * Predicted bbox interval for `sketchOnPlane(plane).extrude(length)` on the
 * plane's normal axis. Returns null for the intuitive XY case (the +Z grow-up
 * direction is almost always what the user wants), or for any combination the
 * hint helper considers "safe". Computed from the same PLANE_AXIS mapping
 * table emitExtrudePlaneHint uses — the two helpers must agree so a "deferred"
 * hint and its final emitted message describe the same interval.
 */
export function getPredictedExtrudeBbox(
  plane: string,
  length: number,
): { axis: "x" | "y" | "z"; lo: number; hi: number } | null {
  if (typeof plane !== "string" || plane === "XY") return null;
  if (typeof length !== "number" || !Number.isFinite(length) || length === 0) return null;
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
  const effectiveSign = entry.sign * (length < 0 ? -1 : 1);
  const mag = Math.abs(length);
  const [lo, hi] = effectiveSign === 1 ? [0, mag] : [-mag, 0];
  return { axis: entry.axis.toLowerCase() as "x" | "y" | "z", lo, hi };
}

// Deferred-hint queue. Prior to this commit, the extrude-plane hint fired
// synchronously inside `validateSketchExtrude` — that meant every build of
// drawRect(…).sketchOnPlane("XZ").extrude(L) emitted "Y ∈ [-L, 0]" even after
// the user .translate()'d the part into +Y. The result was noise: the hint
// repeated after the user had already handled it, and real problems got
// drowned out.
//
// New flow: the instrumentation pre-hook calls `enqueueExtrudeHint` instead of
// pushing a warning, stashing the predicted problem region. The core engine
// calls `drainExtrudeHints(finalBboxes)` after parts are finalized; the drainer
// cross-checks each prediction against the actual final bbox and only emits
// the warning when the predicted interval is still substantially inside the
// final bbox. If the user translated the part out of the predicted region, the
// hint is silently discarded.
interface PendingExtrudeHint {
  plane: string;
  length: number;
  predicted: { axis: "x" | "y" | "z"; lo: number; hi: number };
  origin: "user" | "stdlib";
}

const pendingExtrudeHints: PendingExtrudeHint[] = [];

/**
 * Stash an extrude hint for later cross-check at drain time. No-op when
 * `getPredictedExtrudeBbox` returns null (XY plane, zero length, etc.).
 *
 * The hint is tagged `origin: "stdlib"` when the call stack shows any frame
 * from `/stdlib/` (e.g. `holes.countersink()` or `fasteners.socketHeadBody()`
 * which legitimately sketch on non-XY planes to revolve a profile). Those
 * are dropped silently at drain time — the bbox heuristic can't distinguish
 * an intentional stdlib revolve-profile extrude from a user footgun, so we
 * use the callsite instead. User-origin hints keep going through the normal
 * >50% overlap check in `drainExtrudeHints`.
 */
export function enqueueExtrudeHint(plane: string, length: number): void {
  const predicted = getPredictedExtrudeBbox(plane, length);
  if (!predicted) return;
  const stack = new Error().stack ?? "";
  // Match both POSIX `/stdlib/` and Windows `\stdlib\` path separators. V8's
  // `file:///C:/...` URL form normalises to forward slashes in the stack, so
  // a single `/` branch also handles Windows-style `file://` frames; the `\\`
  // branch handles native Node stack frames on Windows.
  const origin = /[\\/]stdlib[\\/]/.test(stack) ? "stdlib" : "user";
  pendingExtrudeHints.push({ plane, length, predicted, origin });
}

/** Reset the pending-hint queue. Called from resetRuntimeWarnings(). */
export function resetPendingExtrudeHints(): void {
  pendingExtrudeHints.length = 0;
}

/**
 * Drain the deferred extrude-hint queue, returning the subset whose prediction
 * STILL HOLDS against the final part bounding boxes. The caller feeds in the
 * final bbox(es) from the tessellated parts; for each pending hint we check
 * every bbox on the predicted axis and keep the hint iff at least one bbox
 * has substantial coverage of the predicted interval.
 *
 * Containment criterion: we keep the hint when the intersection between the
 * predicted interval [lo, hi] and the final bbox's axis range covers MORE
 * THAN 50% of the predicted interval's width (with a small absolute tolerance
 * of 1e-3 to absorb float noise). This catches:
 *   - extrude with no translate          — 100% coverage, warn  (test case 1)
 *   - extrude + translate halfway out    — 50% coverage, don't warn (case 2)
 *   - extrude + translate fully out      — 0% coverage, don't warn (case 3)
 * For assemblies: we warn if ANY part still covers >50% of the predicted
 * region — conservatively noisier than silencing on partial escape. Picked
 * 50% because it's the intuitive midpoint ("is the problem mostly still
 * there?") and because stricter thresholds (e.g. 80%) silence the case where
 * the user translated ~halfway and didn't notice they were still mostly in
 * the problem region.
 */
export function drainExtrudeHints(
  finalBboxes: Array<{ min: [number, number, number]; max: [number, number, number] }>,
): string[] {
  const out: string[] = [];
  const EPS = 1e-3;
  const COVERAGE_THRESHOLD = 0.5;
  const hints = pendingExtrudeHints.slice();
  pendingExtrudeHints.length = 0;
  for (const hint of hints) {
    // Stdlib-internal sketches (e.g. holes.countersink(), fasteners
    // .socketHeadBody()) legitimately sketch on XZ/ZX to revolve a profile.
    // The overlap criterion can't distinguish those from user footguns —
    // the revolved cutter's final bbox legitimately covers the predicted
    // region — so filter by callsite instead. Tagged at enqueue time.
    if (hint.origin === "stdlib") continue;
    const { axis, lo, hi } = hint.predicted;
    const width = hi - lo;
    if (!(width > 0)) continue;
    const idx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
    let keep = false;
    for (const bb of finalBboxes) {
      const bMin = bb.min?.[idx];
      const bMax = bb.max?.[idx];
      if (typeof bMin !== "number" || typeof bMax !== "number") continue;
      // Overlap = min(hi, bMax) - max(lo, bMin), clamped at 0.
      const overlap = Math.max(0, Math.min(hi, bMax) - Math.max(lo, bMin));
      if (overlap + EPS >= width * COVERAGE_THRESHOLD) {
        keep = true;
        break;
      }
    }
    if (!keep) continue;
    // Reset the one-shot latch just so we reuse `emitExtrudePlaneHint` to build
    // the full message string; it would otherwise return null on a second call
    // in the same run. We reset AFTER the fact to keep the latch semantics
    // (one emission per run) intact for any direct callers that still exist.
    resetExtrudePlaneHint();
    const msg = emitExtrudePlaneHint(hint.plane, hint.length);
    if (msg) out.push(msg);
  }
  return out;
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
