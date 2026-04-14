import { drawRectangle, sketchCircle } from "replicad";

export default function main() {
  // A simple box with a center hole and rounded edges
  const box = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  const hole = sketchCircle(8).extrude(20);
  return box.cut(hole).fillet(2);
}
