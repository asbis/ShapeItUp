import { drawRoundedRectangle, sketchCircle } from "replicad";

/**
 * Reusable mounting plate with configurable holes.
 *   import { makePlate } from "./plate.shape"
 */
export function makePlate(
  width = 80,
  height = 50,
  thickness = 5,
  holeRadius = 5,
  cornerRadius = 3
) {
  let plate = drawRoundedRectangle(width, height, cornerRadius)
    .sketchOnPlane("XY")
    .extrude(thickness);

  // Four corner mounting holes
  const hx = width / 2 - 12;
  const hy = height / 2 - 10;
  const positions = [
    [hx, hy],
    [-hx, hy],
    [-hx, -hy],
    [hx, -hy],
  ];

  for (const [x, y] of positions) {
    const hole = sketchCircle(holeRadius).extrude(thickness).translate(x, y, 0);
    plate = plate.cut(hole) as any;
  }

  return plate;
}

export default function main() {
  return makePlate();
}
