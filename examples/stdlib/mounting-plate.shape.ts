/**
 * Mounting plate with 4 corner counterbored screw holes and a central slotted
 * hole for adjustment. Demonstrates `holes.counterbore` + `holes.slot`.
 */
import { drawRoundedRectangle } from "replicad";
import { holes } from "shapeitup";

export const params = {
  width: 60,
  height: 40,
  thickness: 5,
  screwSize: "M3",
};

export default function main({
  width,
  height,
  thickness,
  screwSize,
}: typeof params) {
  let plate = drawRoundedRectangle(width, height, 3)
    .sketchOnPlane("XY")
    .extrude(thickness)
    .asShape3D();

  // Four corner counterbored holes, inset 10 mm from each corner. Cut tool
  // has its top at Z=0 — translate so it sits at the top face (Z=thickness).
  const inset = 10;
  const corners: [number, number][] = [
    [-width / 2 + inset, -height / 2 + inset],
    [width / 2 - inset, -height / 2 + inset],
    [-width / 2 + inset, height / 2 - inset],
    [width / 2 - inset, height / 2 - inset],
  ];
  for (const [x, y] of corners) {
    const hole = holes
      .counterbore(screwSize, { plateThickness: thickness })
      .translate(x, y, thickness);
    plate = plate.cut(hole);
  }

  // Central slotted hole, 20 mm long, 4 mm wide, through the full thickness.
  const slot = holes
    .slot({ length: 20, width: 4, depth: thickness + 0.1 })
    .translate(0, 0, thickness);
  plate = plate.cut(slot);

  return plate;
}
