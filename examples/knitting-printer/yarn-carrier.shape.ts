// Yarn carrier — small L-bracket that rides with the carriage and feeds yarn
// above the needle hooks. Vertical arm bolted to carriage's +Y face; horizontal
// arm extends over the bed and carries a yarn-feed eyelet.
// Origin at the TOP of the vertical arm (where it meets the carriage) at Z=0,
// centered in X. Assembly positions the carrier over the carriage.

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, holes } from "shapeitup";
import {
  YARN_ARM_L, YARN_ARM_T, YARN_ARM_H, YARN_EYELET_DIA,
  C_YARN,
} from "./constants";

export function makeYarnCarrier(): Shape3D {
  // Vertical arm: thin X×Z plate extending downward, 12 mm wide in X
  const armW = 12;
  const vert = shape3d(
    drawRoundedRectangle(armW, YARN_ARM_T, 1)
      .sketchOnPlane("XY", [0, 0, -YARN_ARM_H / 2])
      .extrude(YARN_ARM_H)
  );
  // Horizontal arm: extends in +Y from the bottom of the vertical arm
  const horiz = shape3d(
    drawRoundedRectangle(armW, YARN_ARM_L, 1)
      .sketchOnPlane("XY", [0, YARN_ARM_L / 2, -YARN_ARM_H + YARN_ARM_T / 2])
      .extrude(YARN_ARM_T)
  );
  let body = vert.fuse(horiz);

  // Yarn eyelet — Ø2.2 vertical through-hole at the end of the horizontal arm
  body = body.cut(
    holes.through(YARN_EYELET_DIA, {
      depth: YARN_ARM_T + 2, raw: true,
    }).translate(0, YARN_ARM_L - 3, -YARN_ARM_H + YARN_ARM_T + 0.01),
  );
  return body;
}

export default function main() {
  return [{ shape: makeYarnCarrier(), name: "yarn-carrier", color: C_YARN }];
}
