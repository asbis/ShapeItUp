import { drawRectangle, makeCylinder, EdgeFinder } from "replicad";

export const params = {
  width: 40,
  height: 40,
  depth: 20,
  thickness: 5,
  holeRadius: 3,
  filletRadius: 2
};

export default function main({ width, height, depth, thickness, holeRadius, filletRadius }: typeof params) {
  // Base
  const base = drawRectangle(width, thickness).sketchOnPlane("XY").extrude(depth);
  
  // Upright
  const upright = drawRectangle(thickness, height)
    .sketchOnPlane("XY", [-width / 2 + thickness / 2, -height / 2 + thickness / 2, 0])
    .extrude(depth);

  let bracket = base.fuse(upright);

  // Fillet vertical edges
  try {
    bracket = bracket.fillet(filletRadius, e => e.inDirection("Z"));
  } catch (e) {
    console.warn("Fillet failed", e);
  }

  // Holes
  const h1 = makeCylinder(holeRadius, thickness * 2, [width / 4, 0, depth / 2], [0, 1, 0]).translateY(-thickness);
  const h2 = makeCylinder(holeRadius, thickness * 2, [-width / 2 + thickness / 2, height / 2 - height / 4, depth / 2], [1, 0, 0]).translateX(-thickness);

  return bracket.cut(h1).cut(h2);
}
