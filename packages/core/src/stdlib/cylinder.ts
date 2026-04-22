/**
 * cylinder() — an orientation-consistent Shape3D cylinder factory.
 *
 * Replicad's built-in `makeCylinder(radius, height, location, direction)`
 * uses the cylinder's BASE as its `location` anchor and defaults to +Z,
 * whereas the rest of the stdlib's cut-tool convention puts the TOP at
 * Z=0. Mixing both conventions in one file trips up both humans and LLMs;
 * this helper uses a named-object API that makes the anchor explicit.
 *
 *   cylinder({ bottom: [0, 0, 0], length: 24, diameter: 5 })    // axis +Z, base at origin
 *   cylinder({ top: [0, 0, 0], length: 10, diameter: 3 })       // axis +Z, top at origin, extends -Z
 *   cylinder({ bottom: [0, 0, 0], length: 20, diameter: 6,
 *              direction: "+Y" })                                // rod along +Y
 */

import { makeCylinder, type Shape3D } from "replicad";
import { type Axis, normalizeAxis } from "./parts";
import type { Point3 } from "./standards";

export interface CylinderOpts {
  /** End-cap ANCHOR (not a midpoint): the center of the cylinder's bottom
   *  face sits at this world position; body extends `length` along `direction`.
   *  Mutually exclusive with `top`. */
  bottom?: Point3;
  /** End-cap ANCHOR (not a midpoint): the center of the cylinder's top face
   *  sits at this world position; body extends `length` OPPOSITE `direction`.
   *  Mutually exclusive with `bottom`. Combining `top` with an explicit
   *  `direction` throws — use `bottom` + `direction` for non-default axes. */
  top?: Point3;
  /** Axial length in mm. */
  length: number;
  /** Diameter in mm. (Caller decides which end is nominal — pass both bores separately and `fuse()` if needed.) */
  diameter: number;
  /** Axis direction. Default "+Z". */
  direction?: Axis;
}

/**
 * Build a cylinder with explicit top/bottom anchoring. Exactly one of
 * `top` or `bottom` must be provided. Direction defaults to +Z.
 */
export function cylinder(opts: CylinderOpts): Shape3D {
  const hasTop = opts.top !== undefined;
  const hasBottom = opts.bottom !== undefined;
  if (hasTop === hasBottom) {
    throw new Error(
      "cylinder: exactly one of { top, bottom } must be provided."
    );
  }
  // `top` is already direction-relative: it names the end OPPOSITE `direction`.
  // Combining `top` + explicit `direction` is ambiguous — "top at [0,0,0] with
  // direction -Z" reads as "high-Z end at origin, body hangs down" but resolves
  // to "body extends upward from origin" because of the direction-relative
  // definition. Refuse the combination; for a downward-hanging cylinder, use
  // `bottom` + `direction`.
  if (hasTop && opts.direction !== undefined) {
    throw new Error(
      "cylinder: `top` + `direction` is ambiguous — `top` already names the end opposite `direction`. " +
        "For a cylinder hanging from [0,0,0] downward, use `{ top: [0,0,0], length, diameter }` (default direction=+Z). " +
        "To change the axis, use `{ bottom, length, diameter, direction }` (e.g. `{ bottom: [0,0,0], length, diameter, direction: '-Z' }`)."
    );
  }
  const direction = normalizeAxis(opts.direction ?? "+Z");
  const radius = opts.diameter / 2;

  // makeCylinder(radius, height, base, direction) — base is the center of the
  // bottom face; the cylinder extends `height` mm along `direction` from there.
  let base: Point3;
  if (hasBottom) {
    base = opts.bottom!;
  } else {
    // top anchor → subtract length along direction to find the base.
    const t = opts.top!;
    base = [
      t[0] - direction[0] * opts.length,
      t[1] - direction[1] * opts.length,
      t[2] - direction[2] * opts.length,
    ];
  }
  return makeCylinder(radius, opts.length, base, direction);
}

/**
 * Alias for `cylinder()` — engineers describing motion hardware often reach
 * for "rod" or "shaft" before "cylinder". Identical options and return type;
 * pick whichever reads better at the call site.
 *
 *   rod({ from: [0, 0, 0], to: [100, 0, 0], diameter: 8 })  // NOT a separate signature — use cylinder with top/bottom + length
 *   rod({ bottom: [0, 0, 0], length: 100, diameter: 8, direction: "+X" })
 */
export const rod = cylinder;
