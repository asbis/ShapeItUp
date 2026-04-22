// Motor-side end cap — L-shaped bracket, horizontal base sits on chassis,
// vertical wall holds one rail end + the NEMA17 pilot hole for a pulley shaft.
// Origin at its geometric center (X=MOTOR_FACE_X is applied by the assembly).
// The wall sits in the YZ plane; the base lies flat in XY.

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import {
  ENDCAP_WALL_W, ENDCAP_WALL_H, ENDCAP_WALL_T,
  ENDCAP_BASE_W, ENDCAP_BASE_L, ENDCAP_BASE_T,
  RAIL_DIAMETER, RAIL_Z, RAIL_Y_FRONT, RAIL_Y_BACK,
  CHASSIS_TOP_Z,
  C_ENDCAP,
} from "./constants";

export function makeEndCapMotor(): Shape3D {
  // Base Z ∈ [CHASSIS_TOP_Z, CHASSIS_TOP_Z + ENDCAP_BASE_T]. Wall sits on base.
  const baseZBottom = CHASSIS_TOP_Z;
  const wallXMid = -ENDCAP_BASE_L / 2 + ENDCAP_WALL_T / 2;  // wall at -X end of base
  const wallZBottom = CHASSIS_TOP_Z + ENDCAP_BASE_T;

  const base = shape3d(
    drawRoundedRectangle(ENDCAP_BASE_L, ENDCAP_BASE_W, 2)
      .sketchOnPlane("XY", [0, 0, baseZBottom])
      .extrude(ENDCAP_BASE_T)
  );
  let wall = shape3d(
    drawRoundedRectangle(ENDCAP_WALL_T, ENDCAP_WALL_W, 2)
      .sketchOnPlane("XY", [wallXMid, 0, wallZBottom])
      .extrude(ENDCAP_WALL_H)
  );

  // Rail pass-through bores (on the wall) — axis -X so the cutter extends
  // through the wall from its +X face (the face of the wall we see from the
  // bed side) toward -X.
  for (const yRail of [RAIL_Y_FRONT, RAIL_Y_BACK]) {
    wall = wall.cut(
      holes.through(RAIL_DIAMETER + 0.4, {
        depth: ENDCAP_WALL_T + 2,
        axis: "+X",
        raw: true,
      }).translate(wallXMid + ENDCAP_WALL_T / 2, yRail, RAIL_Z),
    );
  }

  // Center hole for the NEMA17 motor shaft + 4 × M3 corner-pattern mounting
  // holes (standard 31 mm NEMA17 pitch). Motor is bolted to the -X face of
  // the wall, shaft passes through via a Ø24 clearance pilot.
  const motorZ = wallZBottom + ENDCAP_WALL_H / 2;  // motor center vertically on wall
  wall = wall.cut(
    holes.through(24, {
      depth: ENDCAP_WALL_T + 2, axis: "+X", raw: true,
    }).translate(wallXMid + ENDCAP_WALL_T / 2, 0, motorZ),
  );
  // 4 × M3 NEMA17 bolts (31 mm pitch square). Cut explicitly — patterns.cutAt
  // mis-flags axis:"+X" cutters on wall-face patterns as "outside bbox".
  const BOLT_PITCH = 31;
  for (const dy of [-BOLT_PITCH / 2, BOLT_PITCH / 2]) {
    for (const dz of [-BOLT_PITCH / 2, BOLT_PITCH / 2]) {
      wall = wall.cut(
        holes.through("M3", { depth: ENDCAP_WALL_T + 2, axis: "+X" })
          .translate(wallXMid + ENDCAP_WALL_T / 2, dy, motorZ + dz),
      );
    }
  }

  return base.fuse(wall);
}

export default function main() {
  return [{ shape: makeEndCapMotor(), name: "end-cap-motor", color: C_ENDCAP }];
}
