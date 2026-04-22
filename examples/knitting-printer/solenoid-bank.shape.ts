// Solenoid bank — 20 small push-solenoids mounted under the needle bed, one
// per needle. When energised, the plunger pushes a selector jack UP into the
// needle butt, deflecting that needle out of the cam track (miss stitch) or
// into it (knit). Inspired by Knitic's 16-solenoid Brother-930 hack, scaled
// down to one per needle for this 20-needle test rig.
//
// Returns the bracket + 20 solenoid bodies + 20 plungers as a single fused
// shape for this part file; assembly.shape.ts imports the factory to position
// it below the bed. Each solenoid body is cylindrical with its plunger on top.

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, cylinder, patterns, holes } from "shapeitup";
import {
  N_NEEDLES, NEEDLE_PITCH, FIRST_NEEDLE_X,
  SOL_BODY_DIAMETER, SOL_BODY_LENGTH,
  SOL_PLUNGER_DIAMETER, SOL_PLUNGER_LENGTH,
  SOL_BANK_TOP_Z, SOL_BANK_BRACKET_T,
  BED_LENGTH, BED_WIDTH,
  C_SOLENOID, C_SOL_BRACKET,
} from "./constants";

export function makeSolenoidBracket(): Shape3D {
  // Bracket: flat plate holding all solenoids. Sits under the bed.
  const brW = BED_WIDTH - 10;
  const brL = BED_LENGTH - 4;
  const brZ_TOP = SOL_BANK_TOP_Z;
  let bracket = shape3d(
    drawRoundedRectangle(brL, brW, 3)
      .sketchOnPlane("XY", [0, 0, brZ_TOP - SOL_BANK_BRACKET_T / 2])
      .extrude(SOL_BANK_BRACKET_T)
  );
  // 20 pass-through holes for each solenoid body — raw 10.5 mm
  bracket = patterns.cutAt(
    bracket,
    () => holes.through(SOL_BODY_DIAMETER + 0.5, { depth: SOL_BANK_BRACKET_T + 2, raw: true }),
    Array.from({ length: N_NEEDLES }, (_, i) => ({
      translate: [FIRST_NEEDLE_X + i * NEEDLE_PITCH, 0, brZ_TOP] as [number, number, number],
    })),
  );
  return bracket;
}

export function makeSolenoidBody(): Shape3D {
  // Body hangs downward from its top anchor. Top at origin, extends into -Z
  // (stdlib convention for top-anchored cylinder: see get_api_reference('stdlib')).
  return cylinder({
    top: [0, 0, 0],
    length: SOL_BODY_LENGTH,
    diameter: SOL_BODY_DIAMETER,
  });
}

export function makeSolenoidPlunger(): Shape3D {
  // Plunger protrudes UP from its bottom anchor. Bottom at origin, extends +Z.
  return cylinder({
    bottom: [0, 0, 0],
    length: SOL_PLUNGER_LENGTH,
    diameter: SOL_PLUNGER_DIAMETER,
  });
}

export default function main() {
  const parts: { shape: Shape3D; name: string; color: string }[] = [
    { shape: makeSolenoidBracket(), name: "sol-bracket", color: C_SOL_BRACKET },
  ];
  // Bracket top is at SOL_BANK_TOP_Z; bracket bottom = top - BRACKET_T. Body
  // top anchor lives at bracket bottom; body extends -Z down from there.
  const bodyTopZ = SOL_BANK_TOP_Z - SOL_BANK_BRACKET_T;
  // Plunger bottom anchor at body top (extended-state snapshot).
  const plungerBottomZ = bodyTopZ;
  for (let i = 0; i < N_NEEDLES; i++) {
    const x = FIRST_NEEDLE_X + i * NEEDLE_PITCH;
    parts.push({
      shape: makeSolenoidBody().translate(x, 0, bodyTopZ),
      name: `sol-body-${i}`, color: C_SOLENOID,
    });
    parts.push({
      shape: makeSolenoidPlunger().translate(x, 0, plungerBottomZ),
      name: `sol-plunger-${i}`, color: C_SOLENOID,
    });
  }
  return parts;
}
