// Carriage body — slides along X on twin 8mm rails. Holds the cam plate
// underneath (which engages needle butts) and a belt clamp on top.
//
// Local frame: carriage centered on origin. Top face at Z=carriageHeight,
// bottom face at Z=0. X is travel axis, Y is across the bed.

import { drawRoundedRectangle } from "replicad";
import { shape3d, holes, patterns, bearings } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  length: SPEC.carriageLength,
  width: SPEC.carriageWidth,
  height: SPEC.carriageHeight,
  wallThk: SPEC.carriageWallThk,
};

export function makeCarriage(p: typeof params = params) {
  // Solid body — bracket-like shape, hollow in middle to save mass.
  let body = shape3d(
    drawRoundedRectangle(p.length, p.width, 4)
      .sketchOnPlane("XY")
      .extrude(p.height)
  );

  // Hollow the centre (leave 4mm bottom + 4mm top + walls all around).
  const hollow = shape3d(
    drawRoundedRectangle(p.length - 2 * p.wallThk, p.width - 2 * p.wallThk, 2)
      .sketchOnPlane("XY")
      .extrude(p.height - 8)
      .translate(0, 0, 4)
  );
  body = body.cut(hollow);

  // Rail clearance — through-holes along X for the two 8mm rods to pass.
  // axis: "+X" cutters extend in -X from their translate point, so put the
  // translate at +length/2 + 1 to make the body cover the whole carriage.
  const bushingCenterZ = p.height / 2;
  const railThruHoleFront = holes.through(SPEC.railDia + SPEC.carriageRailGap, {
    depth: p.length + 2,
    axis: "+X",
  }).translate(p.length / 2 + 1, SPEC.railSpacingY / 2, bushingCenterZ);
  const railThruHoleRear = holes.through(SPEC.railDia + SPEC.carriageRailGap, {
    depth: p.length + 2,
    axis: "+X",
  }).translate(p.length / 2 + 1, -SPEC.railSpacingY / 2, bushingCenterZ);

  body = body.cut(railThruHoleFront).cut(railThruHoleRear);

  // Belt-clamp slot on top — two parallel ribs to pinch the GT2 belt.
  // Modeled here as a single rectangular slot through the top plate.
  const beltSlot = shape3d(
    drawRoundedRectangle(p.length - 12, SPEC.beltWidth + 1, 0.5)
      .sketchOnPlane("XY")
      .extrude(-3)
      .translate(0, 0, p.height + 0.1)
  );
  body = body.cut(beltSlot);

  // 4× M3 bolt holes on top plate to fasten cam-plate from below
  const camBoltX = (SPEC.camPlateLength / 2) - 6;
  const camBoltY = (SPEC.camPlateWidth / 2) - 6;
  const camBoltPlacements = [
    [ camBoltX,  camBoltY],
    [ camBoltX, -camBoltY],
    [-camBoltX,  camBoltY],
    [-camBoltX, -camBoltY],
  ].map(([x, y]) => ({ translate: [x, y, p.height] as [number, number, number] }));
  body = patterns.cutAt(
    body,
    () => holes.through("M3", { depth: 6 }),
    camBoltPlacements
  );

  return body;
}

export default function main() {
  return [
    { shape: makeCarriage(), name: "carriage", color: COLORS.printedAccent },
  ];
}
