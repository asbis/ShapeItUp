// Idler-side end cap — mirror partner to the motor cap. Same L-bracket
// footprint, but instead of a NEMA17 pattern, it has a single central idler
// shaft bore (for a 608 ball bearing + idler pulley).

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, holes } from "shapeitup";
import {
  ENDCAP_WALL_W, ENDCAP_WALL_H, ENDCAP_WALL_T,
  ENDCAP_BASE_W, ENDCAP_BASE_L, ENDCAP_BASE_T,
  RAIL_DIAMETER, RAIL_Z, RAIL_Y_FRONT, RAIL_Y_BACK,
  CHASSIS_TOP_Z,
  C_ENDCAP,
} from "./constants";

export function makeEndCapIdler(): Shape3D {
  // The idler end-cap is this cap mirrored: wall at +X end of base.
  const baseZMid = CHASSIS_TOP_Z + ENDCAP_BASE_T / 2;
  const wallXMid = ENDCAP_BASE_L / 2 - ENDCAP_WALL_T / 2;
  const wallZMid = CHASSIS_TOP_Z + ENDCAP_BASE_T + ENDCAP_WALL_H / 2;

  const base = shape3d(
    drawRoundedRectangle(ENDCAP_BASE_L, ENDCAP_BASE_W, 2)
      .sketchOnPlane("XY", [0, 0, baseZMid])
      .extrude(ENDCAP_BASE_T)
  );
  let wall = shape3d(
    drawRoundedRectangle(ENDCAP_WALL_T, ENDCAP_WALL_W, 2)
      .sketchOnPlane("XY", [wallXMid, 0, wallZMid])
      .extrude(ENDCAP_WALL_H)
  );

  // Rail pass-through bores (same convention — cutter axis +X opens on the
  // wall's +X face). The rails push into the wall from the bed side.
  for (const yRail of [RAIL_Y_FRONT, RAIL_Y_BACK]) {
    wall = wall.cut(
      holes.through(RAIL_DIAMETER + 0.4, {
        depth: ENDCAP_WALL_T + 2, axis: "+X", raw: true,
      }).translate(wallXMid + ENDCAP_WALL_T / 2, yRail, RAIL_Z),
    );
  }

  // Single Ø8 idler shaft bore at motor-height (so the belt runs flat).
  const idlerZ = CHASSIS_TOP_Z + ENDCAP_BASE_T + 30;
  wall = wall.cut(
    holes.through(8.5, {
      depth: ENDCAP_WALL_T + 2, axis: "+X", raw: true,
    }).translate(wallXMid + ENDCAP_WALL_T / 2, 0, idlerZ),
  );

  return base.fuse(wall);
}

export default function main() {
  return [{ shape: makeEndCapIdler(), name: "end-cap-idler", color: C_ENDCAP }];
}
