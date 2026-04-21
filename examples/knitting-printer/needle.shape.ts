import { makeCylinder, makeBox, type Shape3D } from "replicad";
import {
  NEEDLE_LENGTH, NEEDLE_DIAMETER,
  BUTT_LENGTH, BUTT_THICKNESS, BUTT_HEIGHT, BUTT_FROM_BACK,
  GROOVE_DEPTH,
  COLORS,
} from "./constants";

export const params = { stroke: 0 };   // 0 = rest, BUTT_LIFT_FULL = cleared
export const material = "Steel";

// Mock latch needle, NOT a printable part — the user supplies real hobby
// latch needles. Built at its local origin so the assembly can translate +
// rotate it into place. Convention matches bed frame:
//   shaft axis = +Y
//   shaft top = Z=0 (sits flush in a groove of depth GROOVE_DEPTH)
//   back (tail) end at Y=0, hook end at Y=NEEDLE_LENGTH
//   butt projects UP (+Z) at y = BUTT_FROM_BACK
export function makeNeedle(yStroke: number = 0): Shape3D {
  const shaft = makeCylinder(NEEDLE_DIAMETER / 2, NEEDLE_LENGTH, [0, 0, -NEEDLE_DIAMETER / 2], [0, 1, 0]);
  const butt = makeBox(
    [-BUTT_THICKNESS / 2, BUTT_FROM_BACK - BUTT_LENGTH / 2, 0],
    [ BUTT_THICKNESS / 2, BUTT_FROM_BACK + BUTT_LENGTH / 2, BUTT_HEIGHT],
  );
  const needle = shaft.fuse(butt);
  return yStroke ? needle.translateY(yStroke) : needle;
}

export default function main({ stroke }: typeof params) {
  return [{ shape: makeNeedle(stroke), name: "needle", color: COLORS.needle }];
}
