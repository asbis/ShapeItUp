/**
 * Mounts library — POSITIVE mating studs for hang-on-wall accessories.
 *
 * The inverse of `holes.keyhole(...)`: where that cuts a keyhole INTO a wall,
 * `mounts.keyhole(...)` builds the stud that hangs IN one. This is the single
 * most common pegboard/tool-wall accessory primitive and previously had to be
 * hand-rolled from two cylinders every time.
 *
 *   import { mounts } from "shapeitup";
 *   // Backplate with two studs that hang on a 2 mm steel wall's Ø9/Ø4 keyholes:
 *   let plate = drawRoundedRectangle(24, 60, 5).sketchOnPlane("XZ").extrude(6);
 *   plate = plate
 *     .fuse(mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, axis: "+Y" }))
 *     .fuse(mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, axis: "+Y" }).translate(0, 0, 45));
 *
 * MATING MODEL (matches the keyhole hang-on-screw principle):
 *   1. Insert — push the head through the wall's Ø`largeD` big hole.
 *   2. Lock   — slide the part DOWN one keyhole pitch; the neck rides into the
 *               Ø`smallD` slot and the head is trapped behind the plate.
 *
 * ORIENTATION: the stud is built with its NECK BASE at the origin, pointing
 * along `axis` (default "+Z") — i.e. `axis` names the direction the stud
 * penetrates INTO the wall. Build your part's back face at the origin plane and
 * the stud pokes out the back. For a wall behind a backplate in the XZ plane,
 * use `axis: "+Y"`.
 */
import { makeCylinder, type Shape3D } from "replicad";
import { assertPositiveFinite } from "./standards";
import type { HoleAxis } from "./holes";

/** Unit direction vector the stud points along, per axis. */
const AXIS_VEC: Record<HoleAxis, [number, number, number]> = {
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1],
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
};

export interface KeyholeMountOpts {
  /** Wall's keyhole big-hole Ø — the head must pass through it. */
  largeD: number;
  /** Wall's keyhole slot/small-hole Ø — the neck must fit (and lock) in it. */
  smallD: number;
  /** Wall plate thickness — sets the neck length so the head sits just behind. */
  plateThickness: number;
  /** Retaining-head thickness behind the plate (default 2.5 mm). */
  headThick?: number;
  /** Diametral clearance subtracted from `largeD` for the head (default 0.5). */
  headClear?: number;
  /** Diametral clearance subtracted from `smallD` for the neck (default 0.5). */
  neckClear?: number;
  /** Axial gap behind the plate so the part can slide down to lock (default 0.4). */
  backGap?: number;
  /** Direction the stud penetrates the wall (default "+Z"). */
  axis?: HoleAxis;
}

/**
 * Positive keyhole mounting stud — neck (fits the slot) + retaining head (sits
 * behind the plate). Pass the SAME `largeD`/`smallD` you would give the wall's
 * `holes.keyhole(...)`. Returns a Shape3D you `.fuse()` onto your part.
 *
 * @example
 * part.fuse(mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, axis: "+Y" }))
 */
export function keyhole(opts: KeyholeMountOpts): Shape3D {
  const {
    largeD,
    smallD,
    plateThickness,
    headThick = 2.5,
    headClear = 0.5,
    neckClear = 0.5,
    backGap = 0.4,
    axis = "+Z",
  } = opts;
  assertPositiveFinite("mounts.keyhole", "opts.largeD", largeD);
  assertPositiveFinite("mounts.keyhole", "opts.smallD", smallD);
  assertPositiveFinite("mounts.keyhole", "opts.plateThickness", plateThickness);
  assertPositiveFinite("mounts.keyhole", "opts.headThick", headThick);
  if (largeD <= smallD) {
    throw new RangeError(
      `mounts.keyhole: largeD (${largeD}) must be greater than smallD (${smallD}) — ` +
        `the head has to be wider than the neck to be trapped behind the plate.`,
    );
  }
  const vec = AXIS_VEC[axis];
  if (!vec) {
    throw new RangeError(
      `mounts.keyhole: unknown axis "${axis}". Use one of "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y".`,
    );
  }
  const neckR = (smallD - neckClear) / 2;
  const headR = (largeD - headClear) / 2;
  if (neckR <= 0 || headR <= 0) {
    throw new RangeError(
      `mounts.keyhole: clearances exceed the hole sizes (neckR=${neckR}, headR=${headR}). ` +
        `Lower neckClear/headClear or use larger largeD/smallD.`,
    );
  }
  const neckLen = plateThickness + backGap;
  const neck = makeCylinder(neckR, neckLen, [0, 0, 0], vec);
  const headBase: [number, number, number] = [vec[0] * neckLen, vec[1] * neckLen, vec[2] * neckLen];
  const head = makeCylinder(headR, headThick, headBase, vec);
  return neck.fuse(head) as Shape3D;
}

export interface MountPegOpts {
  /** Wall hole Ø the peg drops into (e.g. the grid's Ø4). */
  holeD: number;
  /** Wall plate thickness — sets the peg length. */
  plateThickness: number;
  /** Diametral clearance subtracted from `holeD` (default 0.5). */
  clear?: number;
  /** Axial gap behind the plate (default 0.4). */
  backGap?: number;
  /** Direction the peg penetrates the wall (default "+Z"). */
  axis?: HoleAxis;
}

/**
 * Plain anti-rotation peg — a headless stud that drops into a plain wall grid
 * hole to stop an accessory from swinging. Length = plateThickness + backGap.
 *
 * @example
 * part.fuse(mounts.peg({ holeD: 4, plateThickness: 2, axis: "+Y" }).translate(0, 0, -15))
 */
export function peg(opts: MountPegOpts): Shape3D {
  const { holeD, plateThickness, clear = 0.5, backGap = 0.4, axis = "+Z" } = opts;
  assertPositiveFinite("mounts.peg", "opts.holeD", holeD);
  assertPositiveFinite("mounts.peg", "opts.plateThickness", plateThickness);
  const vec = AXIS_VEC[axis];
  if (!vec) {
    throw new RangeError(
      `mounts.peg: unknown axis "${axis}". Use one of "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y".`,
    );
  }
  const r = (holeD - clear) / 2;
  if (r <= 0) {
    throw new RangeError(`mounts.peg: clear (${clear}) is >= holeD (${holeD}); the peg would be non-positive.`);
  }
  return makeCylinder(r, plateThickness + backGap, [0, 0, 0], vec) as Shape3D;
}
