/**
 * Shaft coupler builders — pre-assembled Parts with joints ready to mate
 * between a motor shaft and a leadscrew / driven shaft.
 *
 * `flexible()` builds a jaw-style coupler (a plain cylinder with two bores —
 * motor side on the bottom, leadscrew side on top). It's dimensionally
 * accurate enough for visualization and clearance checks; the elastomer
 * spider and jaw teeth are not modelled (v1 simplification).
 *
 * Returned Part layout (local coords):
 *   - Body outer occupies Z = [0, length].
 *   - Motor bore (Ø motorBore) extends from z=0 to z=motorBoreDepth.
 *   - Leadscrew bore (Ø leadscrewBore) extends from z=motorBoreDepth to z=length.
 *
 * Joints (both "female", diameter-checked on mate):
 *   - `motorEnd`     at (0, 0, motorBoreDepth), axis "-Z" —
 *     the BOTTOM OF the motor bore. Mating a motor shaftTip with gap=0
 *     makes the shaft fill the bore to the back wall.
 *   - `leadscrewEnd` at (0, 0, length),        axis "+Z" —
 *     the mouth of the leadscrew bore (top face of the coupler).
 */

import { Part } from "./parts";
import { cylinder } from "./cylinder";
import {
  FLEXIBLE_COUPLER_5_8,
  FLEXIBLE_COUPLER_6_8,
  type FlexibleCouplerSpec,
} from "./standards";

export interface FlexibleCouplerOpts {
  /** Override the spec entirely — useful for sizes that aren't in the table. */
  spec?: FlexibleCouplerSpec;
  /** Override outer diameter. */
  od?: number;
  /** Override coupler length. */
  length?: number;
  /** Override motor-side bore diameter. */
  motorBore?: number;
  /** Override leadscrew-side bore diameter. */
  leadscrewBore?: number;
  /** Override how far the motor bore extends into the coupler. Default = length / 2. */
  motorBoreDepth?: number;
  /** Override the default part name. */
  name?: string;
  /** Override the default color. */
  color?: string;
}

const BORE_OVERSIZE = 0.05; // tiny clearance so boolean cuts close cleanly

/**
 * Build a flexible (jaw-style) shaft coupler. Pass a `FlexibleCouplerSpec`
 * via `opts.spec` for a non-standard size, or override individual
 * dimensions inline.
 *
 * Defaults to the 5mm-to-8mm configuration (NEMA 17 shaft → 8mm leadscrew).
 */
export function flexible(opts: FlexibleCouplerOpts = {}): Part {
  const spec = opts.spec ?? FLEXIBLE_COUPLER_5_8;
  const od = opts.od ?? spec.od;
  const length = opts.length ?? spec.length;
  const motorBore = opts.motorBore ?? spec.motorBore;
  const leadscrewBore = opts.leadscrewBore ?? spec.leadscrewBore;
  const motorBoreDepth = opts.motorBoreDepth ?? spec.motorBoreDepth;

  const outer = cylinder({
    bottom: [0, 0, 0],
    length,
    diameter: od,
  });
  const motorBoreTool = cylinder({
    bottom: [0, 0, -BORE_OVERSIZE],
    length: motorBoreDepth + BORE_OVERSIZE,
    diameter: motorBore + BORE_OVERSIZE * 2,
  });
  const leadscrewBoreTool = cylinder({
    bottom: [0, 0, motorBoreDepth],
    length: length - motorBoreDepth + BORE_OVERSIZE,
    diameter: leadscrewBore + BORE_OVERSIZE * 2,
  });

  return new Part(outer.cut(motorBoreTool).cut(leadscrewBoreTool), {
    name: opts.name ?? "coupler",
    color: opts.color ?? "#b5651d",
  })
    .addJoint("motorEnd", [0, 0, motorBoreDepth], {
      axis: "-Z",
      role: "female",
      diameter: motorBore,
    })
    .addJoint("leadscrewEnd", [0, 0, length], {
      axis: "+Z",
      role: "female",
      diameter: leadscrewBore,
    });
}

export { FLEXIBLE_COUPLER_5_8, FLEXIBLE_COUPLER_6_8 };
