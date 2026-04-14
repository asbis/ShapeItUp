import { draw, makeCylinder } from "replicad";

export default function main() {
  // L-shaped bracket with mounting holes
  const profile = draw()
    .hLine(60)
    .vLine(5)
    .hLine(-55)
    .vLine(35)
    .hLine(-5)
    .close();

  const bracket = profile.sketchOnPlane("XZ").extrude(30);

  // Mounting holes through the base
  const hole1 = makeCylinder(3, 30, [45, 0, 2.5], [0, 1, 0]);
  const hole2 = makeCylinder(3, 30, [15, 0, 2.5], [0, 1, 0]);

  // Mounting hole through the upright
  const hole3 = makeCylinder(3, 30, [2.5, 0, 25], [0, 1, 0]);

  // Chain booleans and fillet
  return bracket
    .cut(hole1)
    .cut(hole2)
    .cut(hole3)
    .fillet(2, (e: any) => e.inDirection("Y"));
}
