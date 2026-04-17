/**
 * Linear-rail carriage — a 60×40×30 block with two LM8UU press-fit pockets
 * side-by-side on X, rod axis along Y. A rod-clearance through-hole joins
 * them so the shaft can pass all the way through the carriage.
 *
 * Bearings are rendered in place for visual fit-check.
 */
import { drawRoundedRectangle, makeCylinder } from "replicad";
import { bearings } from "shapeitup";

export const params = {
  width: 60,
  depth: 40,
  height: 30,
  bearingSpacing: 35, // center-to-center distance on X
};

const BEARING = "LM8UU"; // change to LM6UU / LM10UU to suit your rod.
const ROD_DIA = 8; // matches LM8UU rod.
const ROD_CLEARANCE = 0.3; // radial slip fit for the rod.

/**
 * Rotate a seat/body whose axis is +Z (Z ∈ [-L, 0] for seat, [0, L] for body)
 * onto the +Y axis and recenter it on Y=0.
 *
 * Rotating -90° around +X maps (x,y,z) → (x, z, -y). Then we translate Y so
 * the cylinder is centered on the origin along Y.
 */
function alongYCentered(s: any, rawYStart: number, rawYEnd: number) {
  const rotated = s.rotate(-90, [0, 0, 0], [1, 0, 0]);
  // After rotation, Y spans [rawYStart, rawYEnd] (derive from the raw Z span).
  const midY = (rawYStart + rawYEnd) / 2;
  return rotated.translate(0, -midY, 0);
}

export default function main({
  width,
  depth,
  height,
  bearingSpacing,
}: typeof params) {
  // Block: Z ∈ [0, height], X ∈ [-width/2, +width/2], Y ∈ [-depth/2, +depth/2].
  const block = drawRoundedRectangle(width, depth, 3)
    .sketchOnPlane("XY")
    .extrude(height);

  // Read the LM8UU length from the bearing's own bounding box so we stay in
  // sync with the standards table without hardcoding.
  const rawBody = bearings.linearBody(BEARING); // Z ∈ [0, length]
  const bearingLen = rawBody.boundingBox.depth;

  // Seat pocket — rotate so axis is along +Y.
  // Before rotation: seat Z ∈ [-bearingLen, 0]. -90° around +X maps
  // (x,y,z) → (x, z, -y), so (0,0,-L) → (0,-L,0) → after rotation Y ∈ [-L, 0].
  const seatTool = alongYCentered(
    bearings.linearSeat(BEARING),
    -bearingLen,
    0
  ).translate(0, 0, height / 2);

  // Bearing body — same rotation. Before rotation: Z ∈ [0, bearingLen] →
  // after rotation Y ∈ [0, bearingLen].
  const bodyTool = alongYCentered(rawBody, 0, bearingLen).translate(
    0,
    0,
    height / 2
  );

  const leftSeat = seatTool.translate(-bearingSpacing / 2, 0, 0);
  const rightSeat = seatTool.translate(bearingSpacing / 2, 0, 0);

  // Rod-clearance through-hole: a cylinder along +Y spanning the whole block
  // depth plus a hair. makeCylinder axis +Y starting at Y=-depth/2-1.
  const rodHoleRadius = ROD_DIA / 2 + ROD_CLEARANCE;
  const rodHole = (cx: number) =>
    makeCylinder(
      rodHoleRadius,
      depth + 2,
      [cx, -depth / 2 - 1, height / 2],
      [0, 1, 0]
    );

  const carriage = block
    .cut(leftSeat)
    .cut(rightSeat)
    .cut(rodHole(-bearingSpacing / 2))
    .cut(rodHole(bearingSpacing / 2));

  const leftBody = bodyTool.translate(-bearingSpacing / 2, 0, 0);
  const rightBody = bodyTool.translate(bearingSpacing / 2, 0, 0);

  return [
    { shape: carriage, name: "carriage", color: "#556677" },
    { shape: leftBody, name: "bearing-left", color: "#c9a227" },
    { shape: rightBody, name: "bearing-right", color: "#c9a227" },
  ];
}
