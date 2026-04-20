/**
 * Cradles + anchors — mechanism primitives for ball-cup sockets and rubber-
 * band retention posts. Used for tennis-ball throwers, catapults, and any
 * mechanism that needs to retain a spherical object or anchor an elastic
 * element.
 *
 * Orientation convention:
 *   - `cradle` — the CUP OPENING faces `axis` (default +Z). Before rotation,
 *     the opening is on the +Z hemisphere and the closed/retaining part sits
 *     on the -Z hemisphere.
 *   - `band_post` — the post base sits at the local origin; the mushroom
 *     head sits at the far end along `axis` (default +Z).
 */

import { makeSphere, drawRectangle, type Shape3D } from "replicad";
import { applyAxis, type HoleAxis } from "./holes";
import { assertPositiveFinite } from "./standards";
import { cylinder } from "./cylinder";

/** Default minimum wall thickness for a {@link cradle}. */
const DEFAULT_CRADLE_WALL = 3.0;
/** Default fraction of the sphere retained by a {@link cradle}. */
const DEFAULT_CAPTURE_PERCENT = 0.5;
/** Minimum acceptable wall thickness — anything thinner prints unreliably. */
const MIN_WALL_THICKNESS = 0.4;
/** Default head thickness for a {@link band_post}. */
const DEFAULT_BAND_HEAD_THICKNESS = 2.0;

/** Axis specifier for cradle/band-post orientation. Alias of {@link HoleAxis}. */
export type CradleAxis = HoleAxis;

/**
 * Options for {@link cradle}.
 */
export interface CradleOpts {
  /** Diameter of the ball the cradle should cradle (mm). Must be > 0. */
  ballDiameter: number;
  /** Wall thickness around the cradle (mm, default 3). Must be >= 0.4. */
  wall?: number;
  /**
   * Fraction of the sphere that remains enclosed by the cup, 0..1. Default
   * 0.5 (hemisphere cup). Smaller values produce a shallower saucer; values
   * approaching 1 approach a fully enclosing sphere with a small hole at
   * the top. Clamped to [0, 1].
   */
  capturePercent?: number;
  /**
   * Direction the cup opening faces (default "+Z"). See {@link CradleAxis}.
   * The cup retains the ball on the SIDE OPPOSITE this axis, so a `"+Z"`
   * cradle sits on the ground with its ball-catching hollow opening upward.
   */
  axis?: CradleAxis;
}

/**
 * Ball cup — a hollow hemispherical (or near-hemispherical) cradle sized to
 * loosely retain a ball of the given diameter. Ideal for tennis-ball throwers,
 * marble runs, or any mechanism where a spherical payload needs a shaped
 * resting surface.
 *
 * Geometry (before `applyAxis`):
 *   - Outer: sphere centred at origin, radius `ballR + wall`.
 *   - Inner cavity: sphere centred at origin, radius `ballR * 0.99` (tiny
 *     radial clearance so the ball fits freely without contact drag).
 *   - Opening cap: a generous box cut above the plane Z = cutZ, where
 *     `cutZ = outerR - 2·outerR·capturePercent`. So `capturePercent = 0.5`
 *     (default) cuts at Z = 0 → hemispherical cup. `capturePercent = 0` cuts
 *     at Z = outerR → nothing removed above top (flat lid — useless, so we
 *     still cut the inner cavity but leave an (almost) full sphere around
 *     it). `capturePercent = 1` cuts at Z = -outerR → no sphere retained.
 *
 * @remarks
 * For FDM printing, the cup opens upward by default (+Z axis). This means
 * the cavity's hemispherical roof is printed with support material;
 * reorienting to `"-Z"` puts the opening on the bottom and prints the roof
 * as a 45°-or-shallower dome, which FDM handles better.
 *
 * @example
 * // Cradle for a 67 mm tennis ball, 4 mm wall, shallow saucer (40% retained).
 * const cup = cradles.cradle({
 *   ballDiameter: 67, wall: 4, capturePercent: 0.4,
 * });
 *
 * @param opts See {@link CradleOpts}.
 * @returns Shape3D of the cradle body with the cup cavity hollowed out.
 */
export function cradle(opts: CradleOpts): Shape3D {
  const {
    ballDiameter,
    wall = DEFAULT_CRADLE_WALL,
    capturePercent = DEFAULT_CAPTURE_PERCENT,
    axis,
  } = opts;
  assertPositiveFinite("cradles.cradle", "ballDiameter", ballDiameter);
  if (
    typeof wall !== "number" ||
    !Number.isFinite(wall) ||
    wall < MIN_WALL_THICKNESS
  ) {
    throw new Error(
      `cradles.cradle: wall must be a finite number >= ${MIN_WALL_THICKNESS}mm for printable geometry, got ${String(wall)}.`,
    );
  }
  if (
    typeof capturePercent !== "number" ||
    !Number.isFinite(capturePercent) ||
    capturePercent < 0 ||
    capturePercent > 1
  ) {
    throw new Error(
      `cradles.cradle: capturePercent must be a finite number in [0, 1], got ${String(capturePercent)}.`,
    );
  }

  const ballR = ballDiameter / 2;
  const outerR = ballR + wall;
  // Tiny radial clearance so the ball doesn't bind on hemispheric contact
  // once printed. 1 % is ~0.3 mm for a tennis ball — well within FDM slop.
  const innerR = ballR * 0.99;

  // Build outer shell minus inner cavity → a hollow sphere.
  const outer: Shape3D = makeSphere(outerR);
  const inner: Shape3D = makeSphere(innerR);
  // `cut` returns a new shape and does not mutate inputs. Both operands are
  // freshly-built locals and go out of scope here.
  let body: Shape3D = outer.cut(inner);

  // Cut the opening cap. The cut plane Z = cutZ is positioned so that the
  // sphere "below" it (Z < cutZ) represents the retained fraction. At
  // capturePercent = 1, cutZ = -outerR (nothing retained above, everything
  // below which is the full sphere = full retention). At capturePercent = 0,
  // cutZ = +outerR (everything below which is the full sphere except the
  // infinitesimal top point — effectively the full sphere is kept, no opening
  // at all).
  //
  // So the natural direction is: `capturePercent` names the fraction of the
  // Z-extent REMAINING after the cut. Lower capturePercent → more of the top
  // gets chopped off → shallower saucer.
  //
  // We implement the cut with a big rectangular prism whose bottom face sits
  // at Z = cutZ and which extends well above outerR. Box side length = 4·outerR
  // so the cut covers the whole outer sphere in X/Y.
  //
  // capturePercent is validated > 0 below for the cut to make geometric sense.
  //
  // Special case: capturePercent = 1 means "retain everything" — skip the cut
  // entirely so we end up with a sealed hollow sphere (weird but geometrically
  // valid and the user asked for it).
  if (capturePercent < 1) {
    const cutZ = outerR - 2 * outerR * capturePercent;
    const boxSide = 4 * outerR;
    const boxHeight = 4 * outerR;
    // drawRectangle centres on the sketch-plane origin; sketchOnPlane "XY"
    // puts it at Z=0, extrude(boxHeight) extends to +Z. We then translate so
    // the bottom face sits at cutZ.
    const cap: Shape3D = drawRectangle(boxSide, boxSide)
      .sketchOnPlane("XY")
      .extrude(boxHeight)
      .asShape3D()
      .translate(0, 0, cutZ);
    body = body.cut(cap);
  }

  return applyAxis(body, axis);
}

/**
 * Options for {@link band_post}.
 */
export interface BandPostOpts {
  /** Shaft (post) radius in mm. Must be > 0. */
  postR: number;
  /**
   * Retaining head radius in mm. Must be strictly greater than `postR` —
   * the head's job is to keep a stretched rubber band from sliding up and
   * off the post.
   */
  hookR: number;
  /** Total height of the post (base to top of the head) in mm. Must be > 0. */
  height: number;
  /** Head (mushroom cap) thickness in mm. Default 2. Must be > 0. */
  headThk?: number;
  /** Axis the post points along (default "+Z"). */
  axis?: CradleAxis;
}

/**
 * Rubber-band anchor post — a cylindrical shaft with a wider "mushroom" cap
 * on top that stops a stretched elastic band from popping off. Use as a pull
 * anchor for rubber-band-powered mechanisms (catapults, spring launchers).
 *
 * Geometry (before `applyAxis`):
 *   - Base at local origin. Post axis along +Z.
 *   - Shaft: radius `postR`, extending from Z=0 to Z = height - headThk.
 *   - Head (mushroom): radius `hookR`, extending from the top of the shaft to
 *     Z = height.
 *
 * The total height matches `height` exactly — the head is subtracted from
 * the shaft extent, not added. So passing `height: 20, headThk: 3` gives a
 * 17 mm shaft + 3 mm head, total 20 mm.
 *
 * @example
 * // Rubber-band anchor for a small spring launcher:
 * const anchor = cradles.band_post({ postR: 2, hookR: 4, height: 12 });
 *
 * @param opts See {@link BandPostOpts}.
 * @returns Shape3D of the shaft + mushroom head.
 */
export function band_post(opts: BandPostOpts): Shape3D {
  const {
    postR,
    hookR,
    height,
    headThk = DEFAULT_BAND_HEAD_THICKNESS,
    axis,
  } = opts;
  assertPositiveFinite("cradles.band_post", "postR", postR);
  assertPositiveFinite("cradles.band_post", "hookR", hookR);
  assertPositiveFinite("cradles.band_post", "height", height);
  assertPositiveFinite("cradles.band_post", "headThk", headThk);
  if (hookR <= postR) {
    throw new Error(
      `cradles.band_post: hookR (${hookR}) must be strictly greater than postR (${postR}) — the head must overhang the shaft to retain a band.`,
    );
  }
  if (headThk >= height) {
    throw new Error(
      `cradles.band_post: headThk (${headThk}) must be less than height (${height}) — otherwise the shaft has zero length.`,
    );
  }

  // Use the stdlib's cylinder() wrapper (orientation-explicit) rather than
  // raw makeCylinder — consistent with the rest of the mechanism helpers and
  // easier to read at the call site.
  const shaftLen = height - headThk;

  const shaft: Shape3D = cylinder({
    bottom: [0, 0, 0],
    length: shaftLen,
    diameter: postR * 2,
    direction: "+Z",
  });
  const head: Shape3D = cylinder({
    bottom: [0, 0, shaftLen],
    length: headThk,
    diameter: hookR * 2,
    direction: "+Z",
  });

  const body: Shape3D = shaft.fuse(head);
  return applyAxis(body, axis);
}
