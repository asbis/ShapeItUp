/**
 * Heat-set insert enclosure base — rounded rectangle with 4 corner pockets
 * for brass heat-set inserts, plus rendered insert bodies and M3x12 socket
 * screws poised just above to show the full print-then-assemble story.
 */
import { drawRoundedRectangle } from "replicad";
import { inserts, screws } from "shapeitup";

export const params = {
  width: 80,
  depth: 50,
  thickness: 6,
  inset: 8,
};

export default function main({ width, depth, thickness, inset }: typeof params) {
  let base = drawRoundedRectangle(width, depth, 4)
    .sketchOnPlane("XY")
    .extrude(thickness)
    .asShape3D();

  const corners: [number, number][] = [
    [-width / 2 + inset, -depth / 2 + inset],
    [width / 2 - inset, -depth / 2 + inset],
    [-width / 2 + inset, depth / 2 - inset],
    [width / 2 - inset, depth / 2 - inset],
  ];

  // Cut heat-set pockets from the top face (Z=thickness).
  for (const [x, y] of corners) {
    base = base.cut(inserts.pocket("M3").translate(x, y, thickness));
  }

  // Build the insert bodies seated in each pocket — same translation as the
  // pocket means they share the top face.
  const insertBodies = corners.map(([x, y]) =>
    inserts.heatSet("M3").translate(x, y, thickness)
  );

  // Matching M3x12 socket-head screws, floating 8 mm above the inserts.
  const screwShapes = corners.map(([x, y]) =>
    screws.socketHead("M3x12").translate(x, y, thickness + 20)
  );

  return [
    { shape: base, name: "base", color: "#6d9dc5" },
    ...insertBodies.map((s, i) => ({
      shape: s,
      name: `insert-${i + 1}`,
      color: "#c9a94a",
    })),
    ...screwShapes.map((s, i) => ({
      shape: s,
      name: `screw-${i + 1}`,
      color: "#bbbbbb",
    })),
  ];
}

