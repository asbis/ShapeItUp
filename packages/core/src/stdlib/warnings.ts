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
  resetAmbiguousRawSeen();
  resetCutAtOutcomes();
}

// Per-execute latch for the "raw diameter matches a metric nominal" advisory
// (holes.ts). When a user writes `holes.through(8, ...)` twenty times in one
// file we want exactly ONE warning, not twenty — the first is a useful nudge,
// the rest is noise that trains users to ignore warnings wholesale.
const ambiguousRawSeen = new Set<number>();

/** Returns true the FIRST time a given size is raised this run; false thereafter. */
export function claimAmbiguousRawWarning(size: number): boolean {
  if (ambiguousRawSeen.has(size)) return false;
  ambiguousRawSeen.add(size);
  return true;
}

/** Reset the ambiguous-raw-diameter latch. Called from resetRuntimeWarnings(). */
export function resetAmbiguousRawSeen(): void {
  ambiguousRawSeen.clear();
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
export function emitExtrudePlaneHint(
  plane: string,
  length: number,
  normalShift: number = 0,
): string | null {
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
  const [baseLo, baseHi] = effectiveSign === 1 ? [0, mag] : [-mag, 0];
  const shift = Number.isFinite(normalShift) ? normalShift : 0;
  const lo = baseLo + shift;
  const hi = baseHi + shift;

  // Translate suggestion: to center the bbox on the origin along the extrude
  // axis, shift by -(lo + hi) / 2 along that axis.
  const centerShift = -(lo + hi) / 2;
  const dx = entry.axis === "X" ? centerShift : 0;
  const dy = entry.axis === "Y" ? centerShift : 0;
  const dz = entry.axis === "Z" ? centerShift : 0;

  // Flip direction: `.extrude(-L)` inverts the effective sign, so the axis
  // interval becomes [0, L] when it was [-L, 0] and vice versa. We report the
  // label of the OPPOSITE half-space (`+Y` when native was `-Y`, etc.) so the
  // user can see at a glance where the flipped extrude points.
  const flippedSignSym: "+" | "-" = effectiveSign === 1 ? "-" : "+";
  const flippedAxisLabel = `${flippedSignSym}${entry.axis}`;
  const flippedLength = -length;

  extrudePlaneHintFired = true;
  return (
    `sketchOnPlane('${plane}').extrude(${length}): shape bounding box will be ` +
    `${entry.axis} ∈ [${lo}, ${hi}]. ` +
    `Option 1: .translate(${dx},${dy},${dz}) to center on origin. ` +
    `Option 2: .extrude(${flippedLength}) to flip toward ${flippedAxisLabel}. ` +
    `Option 3: placeOn(drawing, '${plane}', { into: '${flippedAxisLabel}', distance: ${mag} }) for explicit half-space control.`
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
  /**
   * Optional sketch-plane origin offset (2nd arg to `sketchOnPlane`). A scalar
   * offset shifts the predicted interval along the plane's normal axis; an
   * explicit [x,y,z] tuple does the same along that axis component. Omitted
   * (undefined) means "unknown / no shift". If the user passed a Plane object
   * we can't decode, `enqueueExtrudeHint` skips the hint entirely rather than
   * lying about the predicted interval — see that function's body.
   */
  originOffset?: number | [number, number, number];
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
export function enqueueExtrudeHint(
  plane: string,
  length: number,
  originOffset?: unknown,
): void {
  const predicted = getPredictedExtrudeBbox(plane, length);
  if (!predicted) return;

  // Decode the `sketchOnPlane` origin arg into something we can reason about.
  //   undefined             → no shift (sketch is on the plane through origin)
  //   number                → scalar offset along the plane's normal axis
  //   [x, y, z]             → explicit 3D offset; we pick the normal-axis
  //                            component only (the tangent components shift the
  //                            sketch IN the plane, which doesn't affect the
  //                            extrude's normal-axis interval)
  //   anything else (Plane) → unknowable; drop the hint rather than lie. The
  //                            2nd-arg to sketchOnPlane can be a full Plane
  //                            object, whose origin depends on the user's
  //                            construction — fabricating a predicted interval
  //                            from that would produce a worse false positive
  //                            than just staying silent.
  let normalizedOffset: number | [number, number, number] | undefined;
  if (originOffset === undefined) {
    normalizedOffset = undefined;
  } else if (typeof originOffset === "number" && Number.isFinite(originOffset)) {
    normalizedOffset = originOffset;
  } else if (
    Array.isArray(originOffset) &&
    originOffset.length === 3 &&
    originOffset.every((n) => typeof n === "number" && Number.isFinite(n))
  ) {
    normalizedOffset = [
      originOffset[0] as number,
      originOffset[1] as number,
      originOffset[2] as number,
    ];
  } else {
    // Opaque Plane object or otherwise undecodable — stay silent.
    return;
  }

  const stack = new Error().stack ?? "";
  // Match both POSIX `/stdlib/` and Windows `\stdlib\` path separators. V8's
  // `file:///C:/...` URL form normalises to forward slashes in the stack, so
  // a single `/` branch also handles Windows-style `file://` frames; the `\\`
  // branch handles native Node stack frames on Windows.
  //
  // Exclude this file's own frame from the detection — `warnings.ts` IS in
  // `/stdlib/`, and a naive test would tag every call as stdlib-origin and
  // drop every hint. Stripping `warnings.ts` frames leaves real callers
  // (`holes.ts`, `fasteners.ts`, etc.) visible; non-stdlib callers like
  // `validateSketchExtrude` in instrumentation.ts don't match either regex
  // so they fall through to "user".
  const stackWithoutSelf = stack
    .split("\n")
    .filter((line) => !/[\\/]stdlib[\\/]warnings\.(ts|js)/.test(line))
    .join("\n");
  const origin = /[\\/]stdlib[\\/]/.test(stackWithoutSelf) ? "stdlib" : "user";
  pendingExtrudeHints.push({
    plane,
    length,
    predicted,
    origin,
    originOffset: normalizedOffset,
  });
}

/**
 * Return the scalar shift (along the plane's normal axis) that the given
 * origin offset represents. A scalar `number` offset shifts directly along
 * the normal; a 3-tuple contributes only its component on the normal axis
 * (the in-plane components translate the sketch within the plane, which
 * doesn't move the extrude's normal-axis bbox interval). `undefined` means
 * no shift.
 */
function normalAxisShift(
  axis: "x" | "y" | "z",
  offset: number | [number, number, number] | undefined,
): number {
  if (offset === undefined) return 0;
  if (typeof offset === "number") return offset;
  const idx = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  return offset[idx] ?? 0;
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

  // Per-render dedup: 20 needles with identical `sketchOnPlane("XZ").extrude(1.6)`
  // previously pushed 20 hints that each survived the overlap check, emitting
  // the same multi-line advisory 20 times. Collapse by the (plane, length,
  // normalAxisShift) triple so genuinely different extrudes (different length,
  // or same geometry translated to a different origin offset) still warn
  // independently. Set stays local to this drain call so the next render starts
  // fresh — consistent with the per-execute lifecycle the rest of this module
  // uses.
  const seenKey = new Set<string>();

  for (const hint of hints) {
    // Stdlib-internal sketches (e.g. holes.countersink(), fasteners
    // .socketHeadBody()) legitimately sketch on XZ/ZX to revolve a profile.
    // The overlap criterion can't distinguish those from user footguns —
    // the revolved cutter's final bbox legitimately covers the predicted
    // region — so filter by callsite instead. Tagged at enqueue time.
    if (hint.origin === "stdlib") continue;
    const { axis, lo: baseLo, hi: baseHi } = hint.predicted;

    // Shift the predicted interval by the sketchOnPlane origin offset.
    // `sketchOnPlane("YZ", -T/2).extrude(T)` was previously warning about
    // X ∈ [0, T] (the pre-translate interval) even though the finished shape
    // actually sits at X ∈ [-T/2, T/2] — a centered slab, no footgun. The
    // shifted predicted interval reflects where the extrude will ACTUALLY land
    // on the plane's normal axis.
    const shift = normalAxisShift(axis, hint.originOffset);
    const lo = baseLo + shift;
    const hi = baseHi + shift;
    const width = hi - lo;
    if (!(width > 0)) continue;

    // Silence the hint when the SHIFTED prediction is already centered on
    // the origin. The warning exists to flag "your part ended up on ONE
    // half-space along the plane's normal, not centered as you probably
    // expected". If the user provided an explicit origin offset that lands
    // the interval symmetrically across zero, they clearly understand the
    // mechanics and don't need the nudge. Threshold: interval center within
    // 10% of its width from zero (tight enough that a raw sketchOnPlane(XZ)
    // extrude with lo=0, hi=L, center=L/2 → center/width = 0.5 stays FLAGGED,
    // loose enough to absorb float noise on a carefully centered offset).
    const center = (lo + hi) / 2;
    if (Math.abs(center) < width * 0.1) continue;

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

    // Dedup identical advisories. Key on the 4-tuple that determines the
    // emitted message — same plane, same length, and same effective origin
    // shift (rounded to a few decimals to absorb float noise from helpers
    // that compute -T/2 etc.).
    const key = `${hint.plane}|${hint.length}|${shift.toFixed(4)}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);

    // Reset the one-shot latch just so we reuse `emitExtrudePlaneHint` to build
    // the full message string; it would otherwise return null on a second call
    // in the same run. We reset BEFORE each emission so multiple distinct
    // (plane, length) pairs can each get their own message in one render —
    // the Set above is what enforces "at most once per pair", not the latch.
    resetExtrudePlaneHint();
    const msg = emitExtrudePlaneHint(hint.plane, hint.length, shift);
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

// Per-execution record of each `patterns.cutAt` call's material-removal
// outcome. `true` means the cut removed material (volume dropped), `false`
// means the call was a no-op (all placements outside bbox, or volumes
// unchanged). Aggregate reporting up the stack (`EngineStatus.hasRemovedMaterial`
// + `Cut material removal: …` line in the MCP status text) reads the array
// to summarise "all succeeded" vs "N/M failed".
//
// Not every cutAt call pushes an entry — calls where we can't measure
// volume (kernel-free mock paths, missing boundingBox) intentionally omit
// so we don't misattribute "unknown" as a failure.
let cutAtMaterialOutcomes: boolean[] = [];

/** Record whether a `patterns.cutAt` call removed material. */
export function pushCutAtOutcome(removed: boolean): void {
  cutAtMaterialOutcomes.push(removed);
}

/** Snapshot + clear the outcomes list. Called by core at drain time. */
export function drainCutAtOutcomes(): boolean[] {
  const out = cutAtMaterialOutcomes.slice();
  cutAtMaterialOutcomes.length = 0;
  return out;
}

/** Reset the outcomes list. Called from resetRuntimeWarnings(). */
export function resetCutAtOutcomes(): void {
  cutAtMaterialOutcomes.length = 0;
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
