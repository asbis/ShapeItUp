// Rail — smooth Ø8 steel-equivalent rail, LM8UU compatible. Extends along +X.
// Origin at rail's -X end at Z=0; translated per-rail by the assembly.

import { type Shape3D } from "replicad";
import { cylinder } from "shapeitup";
import { RAIL_DIAMETER, RAIL_LENGTH, C_RAIL } from "./constants";

export function makeRail(): Shape3D {
  return cylinder({
    bottom: [0, 0, 0],
    length: RAIL_LENGTH,
    diameter: RAIL_DIAMETER,
    direction: "+X",
  });
}

export default function main() {
  return [{ shape: makeRail(), name: "rail", color: C_RAIL }];
}
