/**
 * Pin library — mechanism-grade positive shapes for shafts, pivots, and
 * cross-pins. Every factory returns a Shape3D oriented so its axis is +Z by
 * default; pass `axis` to reorient onto any world axis.
 *
 * Geometry convention (before `applyAxis`):
 *   - Shaft base sits at local origin (0, 0, 0).
 *   - Shaft extends along +Z.
 *   - For `pin({ headDia })`, the head sits on TOP of the shaft (max Z end).
 *   - Tip chamfer is applied to the far end (top / head end).
 *
 * These helpers are the building blocks for hinges, catapults, and any other
 * mechanism that needs a round shaft fitting into a matching round bore.
 * Pair with `holes.through(...)` or the `pivot(...)` helper for the matching
 * bore geometry.
 */

import { makeCylinder, type Shape3D } from "replicad";
import { applyAxis, type HoleAxis } from "./holes";
import {
  SOCKET_HEAD,
  FIT,
  type FitStyle,
  assertPositiveFinite,
  assertSupportedSize,
  parseScrewDesignator,
} from "./standards";

/**
 * Axis specifier for pin orientation. Same semantics as `HoleAxis` — names the
 * direction the pin's tip points (for `pin`) or the direction the main shaft
 * runs (for `teeBar`). Default `"+Z"`.
 *
 * Re-export of `HoleAxis` under a neutral name so user code can write
 * `pins.pin({ ..., axis: "+Y" })` without confusingly importing a Hole type.
 */
export type PinAxis = HoleAxis;

/** Default tip chamfer applied to the far (tip) end of a {@link pin}. */
const DEFAULT_TIP_CHAMFER = 0.3;
/** Default head thickness for a pin when `headDia` is provided without `headThk`. */
const DEFAULT_HEAD_THICKNESS = 2.0;

/**
 * Options for {@link pin}.
 */
export interface PinOpts {
  /** Shaft diameter in mm. Must be > 0. */
  diameter: number;
  /** Shaft length (along the pin axis) in mm. Must be > 0. */
  length: number;
  /**
   * Optional head/shoulder diameter in mm. When present, a short cylinder of
   * this diameter × `headThk` is fused to the top (far-Z) end of the shaft,
   * giving the pin a shoulder that prevents it falling through a matching
   * bore. Must be strictly greater than `diameter`.
   */
  headDia?: number;
  /** Head thickness in mm when `headDia` is given (default 2). Must be > 0. */
  headThk?: number;
  /** Axis the pin points along (default `"+Z"`). See {@link PinAxis}. */
  axis?: PinAxis;
  /**
   * Tip chamfer in mm applied to the far (tip) end of the shaft (default 0.3).
   * Set to `0` to skip chamfering — useful when the chamfer fails on degenerate
   * edge selections (e.g. very short pins where the top edge isn't readable).
   * If the chamfer op throws, the pin is returned uncharmfered rather than
   * propagating an opaque OCCT failure.
   */
  chamfer?: number;
}

/**
 * Round pin — a plain cylindrical shaft, optionally with a shoulder/head on
 * the far end and a tip chamfer for easy insertion.
 *
 * @remarks ANCHOR
 *   Origin: shaft base sits at local (0, 0, 0).
 *   Extent: shaft extends from origin along `axis` (default +Z) for `length` mm.
 *   Head (if present): sits on the far end, centred on the axis, extending
 *     a further `headThk` mm past the shaft tip.
 *
 * @example
 * // Plain 6 mm × 20 mm pin pointing +Z:
 * const p = pins.pin({ diameter: 6, length: 20 });
 *
 * @example
 * // Shouldered hinge pin pointing +Y (base at origin, tip at +Y):
 * const hinge = pins.pin({ diameter: 4, length: 18, headDia: 7, axis: "+Y" });
 *
 * @param opts See {@link PinOpts}.
 * @returns Shape3D pin (shaft + optional head, with tip chamfer applied).
 */
export function pin(opts: PinOpts): Shape3D {
  const {
    diameter,
    length,
    headDia,
    headThk = DEFAULT_HEAD_THICKNESS,
    axis,
    chamfer = DEFAULT_TIP_CHAMFER,
  } = opts;
  assertPositiveFinite("pins.pin", "diameter", diameter);
  assertPositiveFinite("pins.pin", "length", length);
  if (headDia !== undefined) {
    assertPositiveFinite("pins.pin", "headDia", headDia);
    assertPositiveFinite("pins.pin", "headThk", headThk);
    if (headDia <= diameter) {
      throw new Error(
        `pins.pin: headDia (${headDia}) must be strictly greater than diameter (${diameter}) to form a shoulder.`,
      );
    }
  }
  if (chamfer < 0 || !Number.isFinite(chamfer)) {
    throw new Error(
      `pins.pin: chamfer must be a finite non-negative number, got ${String(chamfer)}.`,
    );
  }

  // Build the raw shaft with its base at Z=0, extending +Z by `length`.
  const shaftR = diameter / 2;
  const shaft: Shape3D = makeCylinder(shaftR, length, [0, 0, 0], [0, 0, 1]);

  let body: Shape3D = shaft;

  // Fuse a shoulder/head on the far end when requested. The head is a short
  // cylinder sitting at Z=length (top of shaft), extending +Z by `headThk`.
  if (headDia !== undefined) {
    const headR = headDia / 2;
    const head: Shape3D = makeCylinder(
      headR,
      headThk,
      [0, 0, length],
      [0, 0, 1],
    );
    // `fuse` returns a new shape; both operands are freshly-built so no clones
    // are required. Replicad's `fuse` does not mutate its inputs.
    body = shaft.fuse(head);
  }

  // Tip chamfer — applied to the top (far-Z) edge. The head end is the tip
  // when no head is present; when a head IS present, the far end is the head's
  // top face, so chamfer there too. Either way the "far end" is at Z = (length
  // + headThk) when head present, else at Z = length.
  const tipZ = headDia !== undefined ? length + headThk : length;
  if (chamfer > 0) {
    // Chamfer can fail on finders that match no edges or on very thin
    // geometry. Failing silently (return the un-chamfered body) is safer than
    // a cryptic OCCT exception — the pin still works mechanically and the
    // caller sees a sensible shape.
    try {
      body = body.chamfer(chamfer, (e) => e.inPlane("XY", tipZ));
    } catch {
      // Swallow — chamfer is cosmetic here.
    }
  }

  return applyAxis(body, axis);
}

/**
 * Options for {@link pivot}.
 */
export interface PivotOpts {
  /**
   * Metric designator, e.g. `"M6"`. Reuses `parseScrewDesignator` — pass the
   * size only (no length suffix).
   */
  size: string;
  /**
   * Fit style for the matching bore. Default `"slip"` — gives a running fit
   * suitable for rotating hinge/pivot joints. `"press"` produces an
   * interference fit (pin must be pressed in); `"loose"` is for parts that
   * must self-align with generous play.
   */
  fit?: FitStyle;
  /** Overall pin length (mm). Must be > 0. */
  length: number;
}

/**
 * Matched pin / bore pair returned by {@link pivot}.
 *
 * The caller:
 *   1. Places the `pin` shape as the load-bearing rod (passes to an assembly
 *      or adds to a parts list).
 *   2. `.cut()`s the `hole` shape out of the surrounding wall/plate, translated
 *      to the pivot axis. The hole is a plain +Z cylinder, base at local
 *      origin, extending +Z by `length` — orient and translate as needed.
 *   3. Reads `clearance` to sanity-check the fit.
 */
export interface PivotPair {
  /** Round pin Shape3D, Ø = nominal metric size, axis = +Z by default. */
  pin: Shape3D;
  /**
   * Cylindrical bore Shape3D to `.cut()` from the surrounding wall. Sized to
   * `nominal + 2 * fitAllowance`, so the radial clearance equals the fit
   * allowance. Base at local origin, axis +Z, length = pin length.
   */
  hole: Shape3D;
  /**
   * Resulting radial clearance in mm (bore radius − pin radius). Negative for
   * a press fit. Use this in assembly logic to decide whether the pair should
   * be glued together (press) or left free to rotate (slip/loose).
   */
  clearance: number;
}

/**
 * Matched pin + bore pair for a pivot joint. Wraps {@link pin} and a plain
 * cylinder bore with ISO-style fit allowance so the two shapes can't drift
 * out of sync (e.g. someone tweaking the bore diameter and forgetting to
 * match the pin).
 *
 * @example
 * // M6 slip-fit pivot for a hinge:
 * const { pin, hole, clearance } = pins.pivot({ size: "M6", length: 25 });
 * // pin: place in assembly
 * // hole: bracket.cut(hole.translate(x, y, z))
 *
 * @param opts See {@link PivotOpts}.
 * @returns Matched {@link PivotPair}.
 */
export function pivot(opts: PivotOpts): PivotPair {
  const { size: spec, length, fit = "slip" } = opts;
  assertPositiveFinite("pins.pivot", "length", length);
  const { size } = parseScrewDesignator(spec);
  assertSupportedSize(size, SOCKET_HEAD, "socket-head");

  const nominalD = SOCKET_HEAD[size].shaft;
  const allowance = FIT[fit];
  const boreD = nominalD + allowance * 2;

  const pinShape = pin({ diameter: nominalD, length });
  const holeShape = makeCylinder(boreD / 2, length, [0, 0, 0], [0, 0, 1]);

  return {
    pin: pinShape,
    hole: holeShape,
    clearance: allowance,
  };
}

/**
 * Options for {@link teeBar}.
 */
export interface TeeBarOpts {
  /** Main-cylinder diameter (mm). Must be > 0. */
  mainDia: number;
  /** Main-cylinder length along +Z (mm). Must be > 0. */
  mainLen: number;
  /** Cross-cylinder diameter (mm). Must be > 0. */
  crossDia: number;
  /** Cross-cylinder total length along +X (mm). Centred on the main axis. Must be > 0. */
  crossLen: number;
  /**
   * Fractional position of the cross-bar along the main axis, 0..1. `1` (the
   * default) puts the cross at the very tip of the main cylinder; `0.5` puts
   * it dead-centre. Values outside [0, 1] are rejected.
   */
  crossAt?: number;
}

/**
 * T-shaped cross-pin — a main cylinder with a perpendicular cross bar fused
 * through it. Useful as a toggle / tommy-bar / cross-pin for hand tools or
 * as a retention pin for spring mechanisms.
 *
 * Geometry (before any future reorientation):
 *   - Main cylinder: base at (0, 0, 0), axis +Z, length `mainLen`.
 *   - Cross cylinder: axis +X, centred on the main axis at Z = `crossAt * mainLen`.
 *     Its extents: x ∈ [−crossLen/2, +crossLen/2], y = 0, z = crossAt·mainLen.
 *
 * @example
 * // T-handle for a hand tap wrench: 80 mm main shaft, 60 mm × 6 mm cross
 * // bar at the top.
 * const handle = pins.teeBar({ mainDia: 8, mainLen: 80, crossDia: 6, crossLen: 60 });
 *
 * @param opts See {@link TeeBarOpts}.
 * @returns Shape3D of the fused T.
 */
export function teeBar(opts: TeeBarOpts): Shape3D {
  const { mainDia, mainLen, crossDia, crossLen, crossAt = 1 } = opts;
  assertPositiveFinite("pins.teeBar", "mainDia", mainDia);
  assertPositiveFinite("pins.teeBar", "mainLen", mainLen);
  assertPositiveFinite("pins.teeBar", "crossDia", crossDia);
  assertPositiveFinite("pins.teeBar", "crossLen", crossLen);
  if (
    typeof crossAt !== "number" ||
    !Number.isFinite(crossAt) ||
    crossAt < 0 ||
    crossAt > 1
  ) {
    throw new Error(
      `pins.teeBar: crossAt must be a finite number in [0, 1], got ${String(crossAt)}.`,
    );
  }

  const mainR = mainDia / 2;
  const crossR = crossDia / 2;
  const main: Shape3D = makeCylinder(mainR, mainLen, [0, 0, 0], [0, 0, 1]);

  const crossZ = crossAt * mainLen;
  // Cross cylinder: makeCylinder(radius, height, base, direction). Base is
  // centred on the main axis, offset -crossLen/2 along +X so the cross is
  // symmetric about the main axis.
  const cross: Shape3D = makeCylinder(
    crossR,
    crossLen,
    [-crossLen / 2, 0, crossZ],
    [1, 0, 0],
  );

  // `fuse` does not mutate inputs — both operands are freshly-built locals.
  return main.fuse(cross);
}

