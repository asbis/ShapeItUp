// Base chassis — the machine's bottom plate. Everything attaches to this.
// Simple rounded-rectangle plate, top face at Z=CHASSIS_TOP_Z.

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import {
  CHASSIS_LENGTH, CHASSIS_WIDTH, CHASSIS_THICKNESS, CHASSIS_TOP_Z,
  BED_LENGTH, BED_WIDTH,
  MOTOR_FACE_X, IDLER_FACE_X,
  C_CHASSIS,
} from "./constants";

export function makeChassis(): Shape3D {
  // Top face at CHASSIS_TOP_Z; sketch at BOTTOM face, extrude +Z.
  let plate = shape3d(
    drawRoundedRectangle(CHASSIS_LENGTH, CHASSIS_WIDTH, 4)
      .sketchOnPlane("XY", [0, 0, CHASSIS_TOP_Z - CHASSIS_THICKNESS])
      .extrude(CHASSIS_THICKNESS)
  );

  // 4 × M3 bed mounting holes at bed-corner positions (match needle-bed holes).
  const inset = 6;
  const bedCorners: [number, number][] = [
    [-BED_LENGTH / 2 + inset, -BED_WIDTH / 2 + inset],
    [ BED_LENGTH / 2 - inset, -BED_WIDTH / 2 + inset],
    [-BED_LENGTH / 2 + inset,  BED_WIDTH / 2 - inset],
    [ BED_LENGTH / 2 - inset,  BED_WIDTH / 2 - inset],
  ];
  plate = patterns.cutAt(
    plate,
    () => holes.through("M3", { depth: CHASSIS_THICKNESS + 2 }),
    bedCorners.map(([x, y]) => ({ translate: [x, y, CHASSIS_TOP_Z] as [number, number, number] })),
  );

  // 4 × M3 end-cap mounting holes (2 per end-cap, at the mid of each end).
  const endcapHoles: [number, number][] = [
    [MOTOR_FACE_X + 10,  20],
    [MOTOR_FACE_X + 10, -20],
    [IDLER_FACE_X - 10,  20],
    [IDLER_FACE_X - 10, -20],
  ];
  plate = patterns.cutAt(
    plate,
    () => holes.through("M3", { depth: CHASSIS_THICKNESS + 2 }),
    endcapHoles.map(([x, y]) => ({ translate: [x, y, CHASSIS_TOP_Z] as [number, number, number] })),
  );

  return plate;
}

export default function main() {
  return [{ shape: makeChassis(), name: "chassis", color: C_CHASSIS }];
}
