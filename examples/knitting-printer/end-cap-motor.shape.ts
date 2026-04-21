// End cap (motor side) — vertical wall at -X end of chassis. Holds:
//   • two 8mm linear rails (front + rear)
//   • NEMA17 stepper face-mounted with shaft pointing into the machine (+X)
//   • base flange that bolts to chassis (4× M5)
//
// Local frame: cap stands upright. Origin at the centre of the wall's bottom
// edge. Wall extends +Z (up). Bolt-flange spreads ±Y. Front face at X=0,
// motor mounted on -X face.

import { drawRectangle } from "replicad";
import { shape3d, holes, patterns, standards } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  width: SPEC.endCapWidth,
  height: SPEC.endCapHeight,
  thk: SPEC.endCapThk,
  chassisFlangeLen: SPEC.endCapWidth + 16,
  chassisFlangeThk: SPEC.chassisHeight,
};

export function makeEndCapMotor(p: typeof params = params) {
  // Vertical wall: spans Y across, Z up, narrow X (the "thickness" axis).
  let wall = shape3d(
    drawRectangle(p.thk, p.width)
      .sketchOnPlane("XY")
      .extrude(p.height)
  );

  // Horizontal flange at the bottom for chassis bolts (extends -X away from wall)
  const flange = shape3d(
    drawRectangle(p.chassisFlangeLen, p.width)
      .sketchOnPlane("XY")
      .extrude(-p.chassisFlangeThk)
      .translate(-p.chassisFlangeLen / 2 + p.thk / 2, 0, 0.1)
  );
  wall = wall.fuse(flange);

  // 2× rail bores — front rail at +Y, rear rail at -Y, both at SPEC.railZ
  const railTool = () =>
    holes.through(SPEC.railDia + 0.2, { depth: p.thk + 2, axis: "+X" })
      .translate(p.thk / 2 + 1, 0, 0);
  const railPlacements = [
    { translate: [0,  SPEC.railSpacingY / 2, SPEC.railZ] as [number, number, number] },
    { translate: [0, -SPEC.railSpacingY / 2, SPEC.railZ] as [number, number, number] },
  ];
  wall = patterns.cutAt(wall, railTool, railPlacements);

  // Central NEMA17 shaft clearance + 4× M3 motor mount bolt circle.
  // Motor sits on -X face, shaft pokes into +X. Bolt pattern is square at
  // standards.NEMA17.boltPitch (= 31 mm).
  const motorZ = SPEC.beltZ;
  const shaftClearance = holes
    .through(standards.NEMA17.pilotDia + 0.3, { depth: p.thk + 2, axis: "+X" })
    .translate(p.thk / 2 + 1, 0, motorZ);
  wall = wall.cut(shaftClearance);

  const motorBoltPitch = standards.NEMA17.boltPitch / 2;
  const motorBoltPlacements = [
    [ motorBoltPitch,  motorBoltPitch],
    [ motorBoltPitch, -motorBoltPitch],
    [-motorBoltPitch,  motorBoltPitch],
    [-motorBoltPitch, -motorBoltPitch],
  ].map(([y, z]) => ({
    translate: [0, y, motorZ + z] as [number, number, number],
  }));
  wall = patterns.cutAt(
    wall,
    () => holes.through("M3", { depth: p.thk + 2, axis: "+X" })
      .translate(p.thk / 2 + 1, 0, 0),
    motorBoltPlacements
  );

  // 4× M5 chassis bolts through flange
  const flangeBoltX1 = -p.chassisFlangeLen / 2 + p.thk / 2 + 8;
  const flangeBoltX2 = p.thk / 2 - 4;
  const flangeBoltY  = p.width / 2 - 8;
  const chassisBoltPlacements = [
    { translate: [flangeBoltX1,  flangeBoltY, 0] as [number, number, number] },
    { translate: [flangeBoltX1, -flangeBoltY, 0] as [number, number, number] },
    { translate: [flangeBoltX2,  flangeBoltY, 0] as [number, number, number] },
    { translate: [flangeBoltX2, -flangeBoltY, 0] as [number, number, number] },
  ];
  wall = patterns.cutAt(
    wall,
    () => holes.through("M5", { depth: p.chassisFlangeThk + 2 }),
    chassisBoltPlacements
  );

  return wall;
}

export default function main() {
  return [
    { shape: makeEndCapMotor(), name: "end-cap-motor", color: COLORS.printedDark },
  ];
}
