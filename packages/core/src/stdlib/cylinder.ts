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
  /** Anchor at the BASE of the cylinder (the end the axis extends away from). Mutually exclusive with `top`. */
  bottom?: Point3;
  /** Anchor at the TOP of the cylinder (the end opposite the axis). Mutually exclusive with `bottom`. */
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
