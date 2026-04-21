// End cap (idler side) — vertical wall at +X end of chassis. Holds:
//   • two 8mm linear rails (front + rear)
//   • 608 ball-bearing idler pulley pocket on the +X face
//   • base flange that bolts to chassis
//
// Mirrors end-cap-motor structurally.

import { drawRectangle } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  width: SPEC.endCapWidth,
  height: SPEC.endCapHeight,
  thk: SPEC.endCapThk,
  chassisFlangeLen: SPEC.endCapWidth + 16,
  chassisFlangeThk: SPEC.chassisHeight,
};

export function makeEndCapIdler(p: typeof params = params) {
  let wall = shape3d(
    drawRectangle(p.thk, p.width)
      .sketchOnPlane("XY")
      .extrude(p.height)
  );

  // Bottom flange (extends -X back toward chassis interior).
  // Overlap into wall by 0.1mm so OCCT's fuse produces a single solid
  // (touching-but-not-overlapping solids fuse as no-op).
  const flange = shape3d(
    drawRectangle(p.chassisFlangeLen, p.width)
      .sketchOnPlane("XY")
      .extrude(-p.chassisFlangeThk)
      .translate(p.chassisFlangeLen / 2 - p.thk / 2, 0, 0.1)
  );
  wall = wall.fuse(flange);

  // Rail bores
  const railTool = () =>
    holes.through(SPEC.railDia + 0.2, { depth: p.thk + 2, axis: "+X" })
      .translate(p.thk / 2 + 1, 0, 0);
  const railPlacements = [
    { translate: [0,  SPEC.railSpacingY / 2, SPEC.railZ] as [number, number, number] },
    { translate: [0, -SPEC.railSpacingY / 2, SPEC.railZ] as [number, number, number] },
  ];
  wall = patterns.cutAt(wall, railTool, railPlacements);

  // 608 bearing seat on the +X face for the idler pulley axle.
  // Build it directly along +X to avoid the rotation+offset gymnastics.
  // 608: OD 22, ID 8, W 7. Pocket = OD+0.05 press fit, depth=5.
  // Center axle through-hole = 8.2 (M8 clearance) all the way through.
  const bearingPocket = holes.through(22.05, { depth: 5, axis: "+X" })
    .translate(p.thk / 2 + 0.5, 0, SPEC.beltZ);
  const axleHole = holes.through("M8", { depth: p.thk + 4, axis: "+X" })
    .translate(p.thk / 2 + 1, 0, SPEC.beltZ);
  wall = wall.cut(bearingPocket).cut(axleHole);

  // 4× M5 chassis bolts
  const flangeBoltX1 = p.chassisFlangeLen / 2 - p.thk / 2 - 8;
  const flangeBoltX2 = -p.thk / 2 + 4;
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
    { shape: makeEndCapIdler(), name: "end-cap-idler", color: COLORS.printedDark },
  ];
}
