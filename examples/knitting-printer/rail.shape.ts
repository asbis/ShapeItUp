import { makeCylinder, type Shape3D } from "replicad";
import { RAIL_DIAMETER, RAIL_LENGTH, COLORS } from "./constants";

// Linear-rod mock (Ø8 x 276 mm). Not printed — user supplies steel rod.
// Built along +X, centered at origin.
export const params = { length: RAIL_LENGTH, diameter: RAIL_DIAMETER };
export const material = "Steel";

export function makeRail(length: number = RAIL_LENGTH, diameter: number = RAIL_DIAMETER): Shape3D {
  return makeCylinder(diameter / 2, length, [-length / 2, 0, 0], [1, 0, 0]);
}

export default function main(p: typeof params) {
  return [{ shape: makeRail(p.length, p.diameter), name: "rail", color: COLORS.rail }];
}
