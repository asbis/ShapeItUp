/**
 * L-bracket with horizontal teardrop cable/pin holes through the vertical
 * face. Teardrop holes print cleanly on FDM without supports because the
 * triangular roof replaces the un-bridgeable top of a circle.
 */
import { drawRectangle } from "replicad";
import { holes } from "shapeitup";

export const params = {
  baseLength: 60,
  uprightHeight: 40,
  depth: 30,
  thickness: 5,
  holeSize: 6, // mm diameter
};

export default function main({
  baseLength,
  uprightHeight,
  depth,
  thickness,
  holeSize,
}: typeof params) {
  // Horizontal base plate (XY at Z=0..thickness).
  const base = drawRectangle(baseLength, depth)
    .sketchOnPlane("XY")
    .extrude(thickness)
    .asShape3D();

  // Vertical plate, flush with the -X edge of the base. Sits on top of the
  // base (Z starts at `thickness` to avoid double-counting the shared
  // corner) and extends up by `uprightHeight`.
  const upright = drawRectangle(thickness, depth)
    .sketchOnPlane("XY", [-baseLength / 2 + thickness / 2, 0, 0])
    .extrude(thickness + uprightHeight)
    .asShape3D();

  let bracket = base.fuse(upright);

  // Two horizontal teardrop holes running along Y (axis = "Y"), through the
  // vertical plate. The vertical plate occupies X from
  //    -baseLength/2  .. -baseLength/2 + thickness
  // so we need the teardrop to span Y = -depth/2 .. +depth/2.
  // A teardrop with axis="Y" extrudes from 0 to +depth along Y; translate
  // to start at -depth/2. The tool's cross-section is centred on the X axis
  // (circle at x=0). Move it into the upright's midline along X.
  const holeLen = depth + 1; // overshoot for a clean boolean
  const xCentre = -baseLength / 2 + thickness / 2;
  const yStart = -depth / 2 - 0.5;
  const zLow = thickness + uprightHeight * 0.35;
  const zHigh = thickness + uprightHeight * 0.75;

  const hole1 = holes
    .teardrop(holeSize, { depth: holeLen, axis: "Y" })
    .translate(xCentre, yStart, zLow);
  const hole2 = holes
    .teardrop(holeSize, { depth: holeLen, axis: "Y" })
    .translate(xCentre, yStart, zHigh);

  bracket = bracket.cut(hole1).cut(hole2);
  return bracket;
}
