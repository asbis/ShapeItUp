import { sketchCircle, drawPolysides } from "replicad";

/**
 * Reusable bolt generator. Import this in other files:
 *   import { makeBolt } from "./bolt.shape"
 */
export function makeBolt(diameter = 8, length = 30, headHeight = 5) {
  const headRadius = diameter * 0.9;
  const head = drawPolysides(headRadius, 6)
    .sketchOnPlane("XY")
    .extrude(headHeight);

  const shaft = sketchCircle(diameter / 2)
    .extrude(length)
    .translateZ(-length);

  return head.fuse(shaft);
}

// When opened directly, show a default bolt
export default function main() {
  return makeBolt();
}
