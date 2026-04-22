// Carriage — block that rides on the two parallel rails, holds the cam plate
// underneath (assembly responsibility) and the yarn-carrier in front. Two
// LM8UU-sized through-bores run along +X at the rail Y positions, and two
// cam-plate mounting holes open on the underside.
//
// Origin at carriage's geometric center; bottom at Z=CARRIAGE_Z_BOTTOM.

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import {
  CARRIAGE_LENGTH, CARRIAGE_WIDTH, CARRIAGE_THICKNESS, CARRIAGE_Z_BOTTOM,
  RAIL_DIAMETER, RAIL_Z, RAIL_Y_FRONT, RAIL_Y_BACK,
  C_CARRIAGE,
} from "./constants";

export function makeCarriage(): Shape3D {
  const cZ = CARRIAGE_Z_BOTTOM + CARRIAGE_THICKNESS / 2;
  let body = shape3d(
    drawRoundedRectangle(CARRIAGE_LENGTH, CARRIAGE_WIDTH, 4)
      .sketchOnPlane("XY", [0, 0, cZ])
      .extrude(CARRIAGE_THICKNESS)
  );

  // Two rail through-bores running +X all the way through the carriage, at
  // the rail Y/Z positions. Clearance diameter = rail + 1 mm so an LM8UU
  // cartridge bearing can be pressed in from each end later. The hole opens
  // on the +X face (translate X = +CARRIAGE_LENGTH/2) with axis "+X", so the
  // cutter body extends in -X through the entire carriage thickness.
  const bore = (y: number) =>
    holes.through(RAIL_DIAMETER + 1, {
      depth: CARRIAGE_LENGTH + 2,
      axis: "+X",
      raw: true,
    }).translate(CARRIAGE_LENGTH / 2, y, RAIL_Z);
  body = body.cut(bore(RAIL_Y_FRONT));
  body = body.cut(bore(RAIL_Y_BACK));

  // Two M3 counterbored mounting holes on top — belt clamp / sensor flag mount.
  body = patterns.cutAt(
    body,
    () => holes.counterbore("M3", { plateThickness: CARRIAGE_THICKNESS }),
    patterns.grid(2, 1, 30, 0).map(p => ({
      ...p,
      translate: [p.translate[0], p.translate[1], CARRIAGE_Z_BOTTOM + CARRIAGE_THICKNESS] as [number, number, number],
    })),
  );

  return body;
}

export default function main() {
  return [{ shape: makeCarriage(), name: "carriage", color: C_CARRIAGE }];
}
