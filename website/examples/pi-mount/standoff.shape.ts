// One component: a hex standoff with a threaded-insert pocket on top.
// Open this tab on its own and it renders on its own.
import { drawPolysides, drawCircle } from "replicad";
import { shape3d } from "shapeitup";

export const params = { height: 10, across: 6, bore: 2.7 };

export function makeStandoff(height: number, across = 6, bore = 2.7) {
  const hex = drawPolysides(across / Math.sqrt(3), 6).sketchOnPlane("XY").extrude(height);
  const hole = drawCircle(bore / 2).sketchOnPlane("XY").extrude(height + 2).translate(0, 0, -1);
  return shape3d(hex.cut(hole));
}

export default function main({ height, across, bore }: typeof params) {
  return makeStandoff(height, across, bore);
}
