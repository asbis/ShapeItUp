/**
 * Bearing block — a box with a press-fit ball-bearing pocket on the top face,
 * rendered alongside the bearing body so you can sanity-check the fit.
 *
 * Swap `bearingSize` to any key of BALL_BEARING ("608", "625", "626", ...).
 */
import { drawRoundedRectangle } from "replicad";
import { bearings } from "shapeitup";

export const params = {
  width: 40,
  depth: 30,
  height: 20,
  bearingSize: "608",
};

export default function main({
  width,
  depth,
  height,
  bearingSize,
}: typeof params) {
  // Block body, Z from 0 to height.
  const block = drawRoundedRectangle(width, depth, 2)
    .sketchOnPlane("XY")
    .extrude(height);

  // seat() returns a cut-tool with the pocket top at Z=0, cavity into -Z.
  // Translate it so Z=0 sits at the top face of the block, centered in XY.
  const seatCutter = bearings.seat(bearingSize).translate(0, 0, height);
  const drilled = block.cut(seatCutter);

  // Visualise the bearing seated in the pocket. body() occupies Z ∈ [0, w];
  // read the actual width from the bounding box so we stay in sync with the
  // standards table without hardcoding.
  const bodyRaw = bearings.body(bearingSize);
  const bearingWidth = bodyRaw.boundingBox.depth;
  const bearingBody = bodyRaw.translate(0, 0, height - bearingWidth);

  return [
    { shape: drilled, name: "block", color: "#8899aa" },
    { shape: bearingBody, name: "bearing", color: "#d4a017" },
  ];
}
