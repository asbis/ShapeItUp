/**
 * Body-level boolean operations — the code half of the viewer's Combine.
 *
 * Fusion 360 calls this Modify -> Combine, and offers three operations over a
 * target body and one or more tool bodies: Join (union), Cut (subtract) and
 * Intersect (keep only the shared volume). It also offers a "Keep Tools"
 * checkbox, which decides whether the tools survive the operation as bodies of
 * their own.
 *
 * This module is the same three operations, written into your `.shape.ts`
 * instead of into a hidden feature tree. "Keep Tools" has no argument here
 * because it does not need one: a tool that should survive keeps its entry in
 * the returned parts list, and a tool that should not have its entry removed.
 * The file says which, so there is nothing to remember.
 *
 * ## Why these wrap `.fuse` / `.cut` / `.intersect` rather than replacing them
 *
 * A bare `a.fuse(b)` is perfectly good code and stays so. What it does not do
 * is tell you when it quietly did nothing useful, and boolean operations fail
 * quietly more often than any other kind: two bodies that were supposed to
 * overlap are 0.2 mm apart, and OCCT returns a valid, renderable, wrong shape
 * without complaint.
 *
 * The core already guards two of those cases at the prototype level — a `.cut`
 * that removes no material, and a `.fuse` whose tool was already inside the
 * target (see patchShapeCutNoOpGuard / patchShapeFuseNoOpGuard in core's
 * index.ts). This module deliberately does NOT repeat those checks; duplicated
 * warnings are worse than none, because the second one teaches the reader to
 * skim. What it adds is the three cases those guards cannot see:
 *
 *   - a Join of bodies that never touch, which succeeds and returns one
 *     "body" made of two separate lumps (volume = a + b exactly, so the fuse
 *     guard's equality test never fires),
 *   - a Cut that consumes the entire target,
 *   - an Intersect of bodies that do not overlap, which the core guards not at
 *     all and which yields an empty shape.
 *
 * Every one of those is decided by MEASURING the result, not by predicting it
 * from bounding boxes. A bounding-box test says two bodies might overlap; only
 * the volume says whether they did.
 */

import { measureVolume, type Shape3D } from "replicad";
import { pushRuntimeWarning } from "./warnings";

/** The three operations Fusion's Combine dialog offers. */
export type CombineOp = "join" | "cut" | "intersect";

/**
 * What the operation measured about itself.
 *
 * Handed to {@link CombineOptions.onStats} so a caller that is previewing
 * rather than rendering — the viewer — can say "removes 4 210 mm³" without
 * paying for a second round of measurement.
 */
export interface CombineStats {
  op: CombineOp;
  /** mm³ before the operation, or undefined when measurement was unavailable. */
  targetVolume?: number;
  /** mm³ after. */
  resultVolume?: number;
  /** |result - target|, the material the operation moved. */
  deltaVolume?: number;
  /** True when at least one tool merged nothing — it never touched the target. */
  disjoint?: boolean;
  /**
   * Which tools those were, by position in the list handed in.
   *
   * Positions rather than names because this module never sees names — the
   * caller that supplied the list is the one that can say "island".
   */
  disjointTools?: number[];
  /** True when the result has no volume left. */
  empty?: boolean;
}

export interface CombineOptions {
  /** Suppress the runtime warnings this module raises. */
  silent?: boolean;
  /**
   * Receives the material the operation added or removed, as a solid.
   *
   * Unlike the face operations, every combine can produce one cheaply: the
   * delta is a single extra boolean against the result, whatever the tool
   * count. Blue for added, red for removed — the viewer paints it, and it is
   * the fastest way to see that a cut is about to eat something it should not.
   */
  onDelta?: (delta: Shape3D, mode: "added" | "removed") => void;
  /** Receives the measurements behind the warnings. See {@link CombineStats}. */
  onStats?: (stats: CombineStats) => void;
}

/**
 * Relative tolerance for calling two volumes the same number.
 *
 * Relative, not absolute: the core's `.cut` guard compares against a fixed
 * 1e-6 mm³, which is right for asking "did anything at all change" but wrong
 * for asking "is this sum exact" on a 35 000 mm³ plate, where OCCT's own
 * measurement noise is larger than 1e-6. One part in 10⁴ is far below any
 * overlap a user could have meant and far above the noise.
 */
const VOLUME_REL_EPSILON = 1e-4;

function sameVolume(a: number, b: number): boolean {
  return Math.abs(a - b) <= VOLUME_REL_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Volume in mm³, or undefined when it cannot be had.
 *
 * Undefined means "cannot tell", and every caller here treats it as a reason
 * to stay quiet rather than to guess: a warning derived from a failed
 * measurement is worse than no warning, because it is indistinguishable from
 * one derived from a real problem.
 */
function volumeOf(shape: Shape3D): number | undefined {
  try {
    const v = measureVolume(shape);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function toolList(tools: Shape3D | Shape3D[]): Shape3D[] {
  return Array.isArray(tools) ? tools.filter(Boolean) : tools ? [tools] : [];
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim() || "unknown error";
}

/**
 * Fusion's Combine, as one function. The three named exports below are the
 * ones to call; this is what they share.
 */
function combine(
  op: CombineOp,
  target: Shape3D,
  tools: Shape3D | Shape3D[],
  opts: CombineOptions,
): Shape3D {
  const label = OP_LABEL[op];
  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`${label}: ${msg}`);
  };

  const list = toolList(tools);
  // No tools is not an error — it is what a viewer's selection looks like for
  // the instant between arming the command and picking the second body.
  if (list.length === 0) return target;

  const targetVolume = volumeOf(target);
  const toolVolumes = list.map(volumeOf);

  // Folded one tool at a time, and MEASURED at each step for a join.
  //
  // An aggregate check — "did the final volume equal the sum of all the
  // inputs" — only fires when EVERY tool is disjoint. Joining a plate with two
  // bosses that touch and one island that does not would pass it silently,
  // and the island is precisely the body the user needs to hear about. Per
  // step, each tool answers for itself.
  let result: Shape3D = target;
  const disjointTools: number[] = [];
  let running = targetVolume;
  try {
    for (let i = 0; i < list.length; i++) {
      const tool = list[i]!;
      const next: Shape3D =
        op === "join"
          ? result.fuse(tool)
          : op === "cut"
            ? result.cut(tool)
            : (result.intersect(tool) as Shape3D);
      if (op === "join") {
        const after = volumeOf(next);
        const toolVolume = toolVolumes[i];
        // Volume conserved exactly across a union can only mean the two share
        // no material: OCCT hands back a compound of separate lumps, which
        // renders but is one "body" in name only.
        if (
          running !== undefined &&
          after !== undefined &&
          toolVolume !== undefined &&
          sameVolume(after, running + toolVolume)
        ) {
          disjointTools.push(i);
        }
        running = after;
      }
      result = next;
    }
  } catch (err) {
    warn(`OCCT refused the operation — ${errText(err)}. The body is unchanged.`);
    return target;
  }

  // Already measured, step by step, for a join.
  const resultVolume = op === "join" ? running : volumeOf(result);
  const stats: CombineStats = {
    op,
    targetVolume,
    resultVolume,
    deltaVolume:
      targetVolume !== undefined && resultVolume !== undefined
        ? Math.abs(resultVolume - targetVolume)
        : undefined,
  };

  // --- The three checks the prototype-level guards cannot make -------------

  if (op === "intersect" && (resultVolume === undefined || resultVolume <= 0)) {
    // An empty intersect is not a shape anyone can render, measure or export,
    // so returning it would trade a clear warning for a confusing blank. The
    // target comes back untouched and the message says exactly why.
    stats.empty = true;
    opts.onStats?.(stats);
    warn(
      "the bodies do not overlap, so there is no shared volume to keep. " +
        "The target is unchanged.",
    );
    return target;
  }

  if (op === "cut" && resultVolume !== undefined && resultVolume <= 0) {
    stats.empty = true;
    warn("the tool removed the entire target body — nothing is left.");
  }

  if (disjointTools.length > 0) {
    stats.disjoint = true;
    stats.disjointTools = disjointTools;
    const all = disjointTools.length === list.length;
    const which = all
      ? "the bodies do not touch"
      : disjointTools.length === 1
        ? `tool ${disjointTools[0]! + 1} does not touch the target`
        : `tools ${disjointTools.map((i) => i + 1).join(", ")} do not touch the target`;
    warn(
      `${which}, so nothing was merged there — the result is one body made of ` +
        "separate lumps. Leave them as separate parts, or move them until they " +
        "overlap.",
    );
  }

  opts.onStats?.(stats);

  // --- The delta, for the viewer's blue/red ghost --------------------------

  if (opts.onDelta) {
    try {
      // One boolean against the RESULT, so the answer is exact for any number
      // of tools — rather than a per-tool union that would double-count
      // wherever two tools overlap each other.
      //
      // These `.cut`s go through the core's instrumented prototype and so
      // consume a "cut #N" ordinal. That is harmless where onDelta is
      // actually used — the viewer's preview runs after main() has returned,
      // so every cut the user could count has already been numbered.
      if (op === "join") {
        opts.onDelta(result.clone().cut(target.clone()), "added");
      } else {
        opts.onDelta(target.clone().cut(result.clone()), "removed");
      }
    } catch {
      // A ghost is a nicety. Losing it must not cost the operation.
    }
  }

  return result;
}

const OP_LABEL: Record<CombineOp, string> = {
  join: "joinBodies",
  cut: "cutBodies",
  intersect: "intersectBodies",
};

/**
 * Merge one or more tool bodies into a target — Fusion's Combine / Join.
 *
 * Warns when the bodies never touch, because a union that merged nothing is
 * the failure this is most often reached for by mistake.
 *
 * @example
 *   joinBodies(base, bracket)
 *   joinBodies(base, [leftRib, rightRib])
 */
export function joinBodies(
  target: Shape3D,
  tools: Shape3D | Shape3D[],
  opts: CombineOptions = {},
): Shape3D {
  return combine("join", target, tools, opts);
}

/**
 * Subtract one or more tool bodies from a target — Fusion's Combine / Cut.
 *
 * The core's `.cut` guard already reports a cut that removed nothing; this
 * adds the opposite case, a cut that removed everything.
 *
 * @example
 *   cutBodies(block, pocket)
 */
export function cutBodies(
  target: Shape3D,
  tools: Shape3D | Shape3D[],
  opts: CombineOptions = {},
): Shape3D {
  return combine("cut", target, tools, opts);
}

/**
 * Keep only the volume a target and its tools share — Fusion's Combine /
 * Intersect.
 *
 * Returns the target unchanged, with a warning, when there is no shared
 * volume: an empty solid renders as nothing at all, which reads as a crash
 * rather than as a result.
 *
 * @example
 *   intersectBodies(blank, envelope)
 */
export function intersectBodies(
  target: Shape3D,
  tools: Shape3D | Shape3D[],
  opts: CombineOptions = {},
): Shape3D {
  return combine("intersect", target, tools, opts);
}
