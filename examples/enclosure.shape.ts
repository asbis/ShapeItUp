import { drawRoundedRectangle, sketchCircle } from "replicad";

// Export params for live sliders in the viewer
export const params = {
  width: 80,
  height: 50,
  depth: 30,
  wall: 2,
  cornerRadius: 5,
  screwHoleRadius: 2,
};

export default function main({
  width,
  height,
  depth,
  wall,
  cornerRadius,
  screwHoleRadius,
}: typeof params) {
  // Outer shell
  const outer = drawRoundedRectangle(width, height, cornerRadius)
    .sketchOnPlane("XY")
    .extrude(depth);

  // Inner cutout (hollow)
  const inner = drawRoundedRectangle(width - wall * 2, height - wall * 2, cornerRadius - wall)
    .sketchOnPlane("XY", [0, 0, wall])
    .extrude(depth);

  let enclosure = outer.cut(inner);

  // Screw holes in 4 corners
  const hx = width / 2 - wall * 2.5;
  const hy = height / 2 - wall * 2.5;
  for (const [x, y] of [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]) {
    const hole = sketchCircle(screwHoleRadius)
      .extrude(wall + 1)
      .translate(x, y, -0.5);
    enclosure = enclosure.cut(hole) as any;
  }

  return enclosure;
}
