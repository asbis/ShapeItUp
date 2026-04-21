// Cam plate — bolted underneath the carriage. The cam tracks (raise + stitch
// cams) deflect needle butts vertically as the carriage traverses, producing
// the knit/tuck/miss action. For this v1 we model:
//   • a flat plate
//   • two raise cams (V-shape ramps up to apex) machined on the bottom face
//
// The cam wedge cross-section: rises from 0 → camRiseHeight over camApproachLen
// then descends symmetrically.
//
// Local frame: plate centered on origin. Top face at Z=0 (mounts to carriage).
// Cam profile is on the BOTTOM face (Z = -camPlateThk down to apex).

import { drawRoundedRectangle, draw } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  length: SPEC.camPlateLength,
  width: SPEC.camPlateWidth,
  thk: SPEC.camPlateThk,
  apexHeight: SPEC.camRiseHeight,
  approachLen: SPEC.camApproachLen,
};

export function makeCamPlate(p: typeof params = params) {
  // Flat plate, top face at Z=0
  let plate = shape3d(
    drawRoundedRectangle(p.length, p.width, 4)
      .sketchOnPlane("XY")
      .extrude(-p.thk)
  );

  // Cam wedge — triangular cross-section sketched on XZ plane, extruded along Y.
  // Profile (in XZ): from (-half, 0) up to (0, apex) down to (half, 0).
  // Built so top of cam touches Z = -p.thk (bottom face of plate) and apex
  // protrudes downward by apexHeight.
  const half = p.approachLen;
  const apexZ = -p.thk - p.apexHeight;
  const baseZ = -p.thk;

  const camProfile = draw([-half, baseZ])
    .lineTo([0, apexZ])
    .lineTo([half, baseZ])
    .lineTo([-half, baseZ])
    .close();

  // Sketch on XZ plane, extrude along Y by camPlateWidth (cam runs full width).
  // sketchOnPlane("XZ").extrude(L) grows toward -Y; translate +width/2 to center.
  const cam = shape3d(
    camProfile.sketchOnPlane("XZ").extrude(p.width).translate(0, p.width / 2, 0)
  );
  plate = plate.fuse(cam);

  // 4× M3 mounting bolt clearance through the plate (matches the carriage)
  const boltX = p.length / 2 - 6;
  const boltY = p.width / 2 - 6;
  const boltPlacements = [
    [ boltX,  boltY],
    [ boltX, -boltY],
    [-boltX,  boltY],
    [-boltX, -boltY],
  ].map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] }));
  plate = patterns.cutAt(
    plate,
    () => holes.through("M3", { depth: p.thk + p.apexHeight + 2 }),
    boltPlacements
  );

  return plate;
}

export default function main() {
  return [
    { shape: makeCamPlate(), name: "cam-plate", color: COLORS.brass },
  ];
}
