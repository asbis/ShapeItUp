// Cam plate — mounts under the carriage, slides along +X over the needle bed.
// A chevron-shaped groove cut through the plate captures the needle butts and
// pushes them along +Y (knit) then back to -Y (rest) as the carriage passes.
// Cam angle is 45 deg, within the ISO 40-50 deg range cited in textile refs.
//
// Local coords: cam centered at origin. Bottom at Z=CAM_Z_BOTTOM, top at
// Z=CAM_Z_TOP. Chevron apex at +Y (front), ends at -Y (back).

import { drawRoundedRectangle, draw, type Shape3D } from "replicad";
import { shape3d } from "shapeitup";
import {
  CAM_LENGTH, CAM_WIDTH, CAM_THICKNESS,
  CAM_Z_BOTTOM, CAM_Z_TOP,
  CAM_GROOVE_WIDTH, CAM_APEX_Y, CAM_END_Y,
  C_CAM,
} from "./constants";

export function makeCamPlate(): Shape3D {
  // Body — sketch sits AT CAM_Z_BOTTOM, extrude +Z by CAM_THICKNESS.
  let plate = shape3d(
    drawRoundedRectangle(CAM_LENGTH, CAM_WIDTH, 2)
      .sketchOnPlane("XY", [0, 0, CAM_Z_BOTTOM])
      .extrude(CAM_THICKNESS)
  );

  // Chevron-shaped groove (6-vertex band). Centerline goes:
  //   (-L/2, END_Y) -> (0, APEX_Y) -> (+L/2, END_Y)
  // Band thickness in Y = CAM_GROOVE_WIDTH.
  const t = CAM_GROOVE_WIDTH / 2;
  const endX = CAM_LENGTH / 2 - 1;   // keep 1 mm rim at each end

  // Walk the OUTER (back / -Y side) edge, then the INNER (front / +Y side) edge.
  const grooveProfile = draw([-endX, CAM_END_Y - t])
    .lineTo([0, CAM_APEX_Y - t])
    .lineTo([endX, CAM_END_Y - t])
    .lineTo([endX, CAM_END_Y + t])
    .lineTo([0, CAM_APEX_Y + t])
    .lineTo([-endX, CAM_END_Y + t])
    .close();

  const grooveTool = shape3d(
    grooveProfile
      .sketchOnPlane("XY", [0, 0, CAM_Z_BOTTOM - 0.1])
      .extrude(CAM_THICKNESS + 0.2)
  );

  plate = plate.cut(grooveTool);

  return plate;
}

export default function main() {
  return [{ shape: makeCamPlate(), name: "cam-plate", color: C_CAM }];
}
