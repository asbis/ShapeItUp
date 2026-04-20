/**
 * Bearing library — seat cutters and bearing visualizations.
 *
 * `bearings.seat("608")` returns a cut-tool Shape3D sized for a press-fit
 * bearing pocket. `bearings.body("608")` returns a representative solid for
 * visualization/assembly.
 *
 * All seats are axis-aligned with Z: the top of the pocket lies at Z=0 and
 * the cavity extends into -Z. Users translate/rotate the cut tool to the
 * target location before calling `.cut()` on their part.
 */

import { makeCylinder, type Shape3D } from "replicad";
import { BALL_BEARING, LINEAR_BEARING } from "./standards";
import { applyAxis, type HoleAxis } from "./holes";

/** Clearance behind the bearing back so the cut-tool doesn't coplanar-fail. */
const POCKET_BACK_CLEARANCE = 0.2;
/** Default straight-through depth when the caller wants a through-hole. */
const DEFAULT_THROUGH_DEPTH = 50;
/** Shoulder width: the radial lip that stops the bearing from going deeper.
 *  3mm (per side) matches the common "bearing sits on a 3mm shelf" rule. */
const SHOULDER_WIDTH = 3;

/**
 * Fit preset or explicit radial allowance for bearing pockets.
 *
 * The allowance is added to the nominal bearing radius on both sides, so pocket
 * diameter = `bearing OD + 2 · allowance`. Positive values widen the pocket
 * (drop-in/rotating fit); negative values produce interference.
 *
 * | preset | radial allowance | usage |
 * |--------|-----------------:|-------|
 * | `"slip"` (default) | `+0.10 mm` | FDM drop-in — no reaming, bearing can be pressed in by hand |
 * | `"press"`          | ` 0.00 mm` | Nominal — requires light reaming / sanding on FDM |
 * | `"interference"`   | `−0.05 mm` | Heated-in metal inserts or CNC-machined pockets |
 * | `number`           | as-is      | Raw radial override in mm |
 */
export type BearingFit = "slip" | "press" | "interference" | number;

function normalizeFit(fit: BearingFit | undefined): number {
  if (typeof fit === "number") return fit;
  switch (fit) {
    case "press":
      return 0.0;
    case "interference":
      return -0.05;
    case "slip":
    case undefined:
      return 0.1;
    default: {
      const _exhaustive: never = fit;
      throw new Error(`Unknown bearing fit preset: ${_exhaustive}`);
    }
  }
}

function ballBearing(designation: string) {
  const spec = BALL_BEARING[designation];
  if (!spec) {
    const avail = Object.keys(BALL_BEARING).join(", ");
    throw new Error(
      `Unknown ball bearing "${designation}". Available: ${avail}`
    );
  }
  return spec;
}

function linearBearing(designation: string) {
  const spec = LINEAR_BEARING[designation];
  if (!spec) {
    const avail = Object.keys(LINEAR_BEARING).join(", ");
    throw new Error(
      `Unknown linear bearing "${designation}". Available: ${avail}`
    );
  }
  return spec;
}

/**
 * Cut-tool for a ball-bearing pocket. Axis is Z; pocket top at Z=0, cavity
 * extends into -Z. Designation like "608", "625".
 *
 * With `throughHole: false` (default) the pocket has a shoulder step at
 * `depth = bearing width` so the bearing's back rests against the shelf; a
 * narrower relief bore (OD − 2·SHOULDER_WIDTH mm) runs deeper to clear the
 * shaft. With `throughHole: true` the pocket is a straight cylinder all the
 * way through.
 *
 * The pocket diameter is `od + 2 · allowance` where `allowance` comes from
 * the `fit` option. See {@link BearingFit}:
 *
 * | preset | radial allowance | usage |
 * |--------|-----------------:|-------|
 * | `"slip"` (DEFAULT) | `+0.10 mm` | FDM drop-in, no reaming needed |
 * | `"press"`          | ` 0.00 mm` | Nominal, needs finishing on FDM |
 * | `"interference"`   | `−0.05 mm` | Heated-in inserts / CNC pockets |
 * | `number`           | as-is      | Raw radial override in mm |
 *
 * **Migration note (v2 breaking change).** The default changed to slip-fit.
 * Previous behavior was press-fit (`-0.05 mm` interference) which requires
 * reaming on FDM and silently produced unachievable parts. Pass
 * `fit: "interference"` to restore the prior behavior — appropriate for
 * heated-in metal-inserted applications only.
 *
 * @param designation Bearing code from BALL_BEARING (e.g. `"608"`, `"625"`).
 * @param opts.throughHole When true, the pocket is a straight cylinder with
 *   no shoulder. Default false.
 * @param opts.depth Override the straight-through depth (mm). Used as the
 *   through-hole height when `throughHole: true`, and as the relief-bore
 *   length when `throughHole: false`. Default 50mm.
 * @param opts.fit Fit preset or raw radial allowance in mm. Default `"slip"`
 *   (+0.10 mm, FDM drop-in).
 * @param opts.axis Pocket direction (default `"+Z"` — cavity opens upward,
 *   tool extends into -Z). Pass `"+X"`/`"-X"`/`"+Y"`/`"-Y"`/`"-Z"` for a
 *   sideways or upward-facing pocket. The axis rotation happens around the
 *   origin — callers typically `.translate()` the returned tool to the
 *   bearing center AFTER the axis has been applied (same contract as
 *   `holes.*`).
 * @returns Shape3D cut-tool positioned at the origin, oriented by `axis`
 *   (default +Z).
 */
export function seat(
  designation: string,
  opts?: {
    throughHole?: boolean;
    depth?: number;
    fit?: BearingFit;
    axis?: HoleAxis;
  }
): Shape3D {
  const spec = ballBearing(designation);
  const allowance = normalizeFit(opts?.fit);
  const pocketRadius = (spec.od + allowance * 2) / 2;

  if (opts?.throughHole) {
    const depth = opts.depth ?? DEFAULT_THROUGH_DEPTH;
    // Cylinder axis +Z; translate so top face sits at Z=0 → cavity into -Z.
    const tool = makeCylinder(pocketRadius, depth, [0, 0, -depth], [0, 0, 1]);
    return applyAxis(tool, opts.axis);
  }

  // Stepped pocket: full-width pocket at the seat, fused with a narrower
  // relief bore extending deeper. The "shoulder" is the resulting step.
  const seatHeight = spec.width + POCKET_BACK_CLEARANCE;
  const pocket = makeCylinder(
    pocketRadius,
    seatHeight,
    [0, 0, -seatHeight],
    [0, 0, 1]
  );

  const reliefRadius = Math.max(pocketRadius - SHOULDER_WIDTH, spec.id / 2);
  const reliefDepth = opts?.depth ?? DEFAULT_THROUGH_DEPTH;
  const relief = makeCylinder(
    reliefRadius,
    reliefDepth,
    [0, 0, -reliefDepth],
    [0, 0, 1]
  );

  const tool = pocket.fuse(relief);
  return applyAxis(tool, opts?.axis);
}

/**
 * Positive visualization of a deep-groove ball bearing — a ring-shaped solid
 * with outer race, inner race, and a thin web between them (no ball detail).
 *
 * Placed upright: centered at the origin with the bore along +Z, occupying
 * Z ∈ [0, width]. Color is the caller's responsibility.
 *
 * @param designation Bearing code from BALL_BEARING (e.g. `"608"`).
 * @returns Shape3D ring (solid with a central bore).
 */
export function body(designation: string): Shape3D {
  const spec = ballBearing(designation);
  const outer = makeCylinder(spec.od / 2, spec.width, [0, 0, 0], [0, 0, 1]);
  const bore = makeCylinder(spec.id / 2, spec.width, [0, 0, 0], [0, 0, 1]);
  return outer.cut(bore);
}

/**
 * Cut-tool for a linear bearing (LMxUU) pocket. Axis Z by default; pocket top
 * at Z=0, cavity extends into -Z for `length` mm (from LINEAR_BEARING).
 *
 * No shoulder — linear bearings are typically held by retaining rings or
 * pressed in at both ends, so the pocket is a straight bore of
 * `od + 2 · allowance` (see `fit`).
 *
 * **Migration note (v2 breaking change).** The default changed to slip-fit
 * (`+0.10 mm` radial). Previous behavior was press-fit (`−0.05 mm`
 * interference) which is unachievable on FDM without reaming. Pass
 * `fit: "interference"` to restore the prior behavior.
 *
 * @param designation Bearing code from LINEAR_BEARING (e.g. `"LM8UU"`).
 * @param opts.fit Fit preset or raw radial allowance in mm. Default `"slip"`
 *   (+0.10 mm, FDM drop-in). See {@link BearingFit}.
 * @param opts.axis Pocket direction (default `"+Z"`). Pass "+X"/"-X"/"+Y"/
 *   "-Y"/"-Z" for a horizontal or upward-facing bore. Rotation happens
 *   around the origin — translate to the bearing center AFTER axis.
 * @returns Shape3D cut-tool for the bearing pocket.
 */
export function linearSeat(
  designation: string,
  opts?: { fit?: BearingFit; axis?: HoleAxis }
): Shape3D {
  const spec = linearBearing(designation);
  const allowance = normalizeFit(opts?.fit);
  const pocketRadius = (spec.od + allowance * 2) / 2;
  const tool = makeCylinder(
    pocketRadius,
    spec.length,
    [0, 0, -spec.length],
    [0, 0, 1]
  );
  return applyAxis(tool, opts?.axis);
}

/**
 * Positive visualization of a linear bearing (LMxUU) — a cylindrical outer
 * shell with an axial bore sized for the rod. Placed upright with the bore
 * along +Z, occupying Z ∈ [0, length].
 *
 * @param designation Bearing code from LINEAR_BEARING (e.g. `"LM8UU"`).
 * @returns Shape3D tube (outer cylinder minus rod bore).
 */
export function linearBody(designation: string): Shape3D {
  const spec = linearBearing(designation);
  const outer = makeCylinder(spec.od / 2, spec.length, [0, 0, 0], [0, 0, 1]);
  const bore = makeCylinder(spec.id / 2, spec.length, [0, 0, 0], [0, 0, 1]);
  return outer.cut(bore);
}
