// Base chassis — flat plate that everything mounts to. The bed sits on top
// (centered), end-caps bolt at each end, motor mount at -X end, fabric
// take-down brackets at -Y face (not modeled here; just bolt holes).
//
// Local frame: chassis centered on origin, top face at Z=0,
// body Z∈[-chassisHeight, 0]. Bed footprint is centered on origin.

import { drawRoundedRectangle } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  length: SPEC.chassisLength,
  width: SPEC.chassisWidth,
  height: SPEC.chassisHeight,
};

export function makeBaseChassis(p: typeof params = params) {
  let chassis = shape3d(
    drawRoundedRectangle(p.length, p.width, 6)
      .sketchOnPlane("XY")
      .extrude(-p.height)
  );

  // 4× M4 bolt holes for needle bed (matching needle-bed bolt pattern,
  // but cut all the way through chassis from top)
  const bedBoltPlacements = [
    [-(SPEC.bedLength / 2) + SPEC.bedMountInsetX,  (SPEC.bedWidth / 2) - SPEC.bedMountInsetY],
    [ (SPEC.bedLength / 2) - SPEC.bedMountInsetX,  (SPEC.bedWidth / 2) - SPEC.bedMountInsetY],
    [-(SPEC.bedLength / 2) + SPEC.bedMountInsetX, -(SPEC.bedWidth / 2) + SPEC.bedMountInsetY],
    [ (SPEC.bedLength / 2) - SPEC.bedMountInsetX, -(SPEC.bedWidth / 2) + SPEC.bedMountInsetY],
  ].map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] }));
  chassis = patterns.cutAt(
    chassis,
    () => holes.through("M4", { depth: p.height + 1 }),
    bedBoltPlacements
  );

  // 4× M5 bolt holes for end caps (one cluster at each end)
  const endCapInsetX = SPEC.endCapThk / 2 + 5;
  const endCapBoltPlacements = [
    [-(p.length / 2) + endCapInsetX,  (p.width / 2) - 12],
    [-(p.length / 2) + endCapInsetX, -(p.width / 2) + 12],
    [ (p.length / 2) - endCapInsetX,  (p.width / 2) - 12],
    [ (p.length / 2) - endCapInsetX, -(p.width / 2) + 12],
  ].map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] }));
  chassis = patterns.cutAt(
    chassis,
    () => holes.through("M5", { depth: p.height + 1 }),
    endCapBoltPlacements
  );

  // 4× M3 bolt holes for solenoid bank plate (behind the bed, -Y side).
  // Two rows tight against the rear edge so they fit on the 120mm-wide chassis.
  const solBoltYFront = -(SPEC.bedWidth / 2) - 8;
  const solBoltYBack  = -(p.width / 2) + 8;
  const solBoltPlacements = [
    [-SPEC.bedKnitLength / 2 + 5, solBoltYFront],
    [ SPEC.bedKnitLength / 2 - 5, solBoltYFront],
    [-SPEC.bedKnitLength / 2 + 5, solBoltYBack],
    [ SPEC.bedKnitLength / 2 - 5, solBoltYBack],
  ].map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] }));
  chassis = patterns.cutAt(
    chassis,
    () => holes.through("M3", { depth: p.height + 1 }),
    solBoltPlacements
  );

  return chassis;
}

export default function main() {
  return [
    { shape: makeBaseChassis(), name: "chassis", color: COLORS.aluminum },
  ];
}
