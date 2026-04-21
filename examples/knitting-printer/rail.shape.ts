// Linear rail — 8mm steel rod. Two of these in the machine: front + rear,
// horizontal along X, supported by the two end caps.
//
// Local frame: rod centered along X, top at Z=0 (so when assembled the
// centerline lands at the rail's intended Z by translating the whole rod up).

import { shape3d, cylinder } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  diameter: SPEC.railDia,
  length: SPEC.railLength,
};

export function makeRail(p: typeof params = params) {
  return shape3d(cylinder({
    diameter: p.diameter,
    length: p.length,
    bottom: -p.length / 2,
    direction: "+X",
  }));
}

export default function main() {
  return [
    { shape: makeRail(), name: "rail", color: COLORS.steel },
  ];
}
