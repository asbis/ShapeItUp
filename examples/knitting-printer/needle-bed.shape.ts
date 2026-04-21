// Needle bed — block of plastic/metal with 20 parallel grooves ("tricks") that
// each capture one needle. Grooves are open on top and at the +Y end (where the
// hooks emerge). Mounted to chassis with 4× M4 bolts.
//
// Local frame: bed centered on X=0, Y=0. Top face at Z=0, body at Z∈[-bedHeight, 0].
// Grooves run along +Y, distributed along X at SPEC.needlePitch.

import { drawRectangle } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import { SPEC, COLORS, X_NEEDLE_OFFSET } from "./constants";

export const params = {
  length: SPEC.bedLength,
  width: SPEC.bedWidth,
  height: SPEC.bedHeight,
  trickWidth: SPEC.trickWidth,
  trickDepth: SPEC.trickDepth,
  trickLength: SPEC.trickLength,
  needleCount: SPEC.needleCount,
};

export function makeNeedleBed(p: typeof params = params) {
  let bed = shape3d(
    drawRectangle(p.length, p.width)
      .sketchOnPlane("XY")
      .extrude(-p.height)
  );

  // Cut needle tricks (grooves) — open at +Y end, sized to fit needle stem
  // with 0.2mm clearance per side.
  const trickToolFactory = () =>
    shape3d(
      drawRectangle(p.trickWidth, p.trickLength)
        .sketchOnPlane("XY")
        .extrude(-p.trickDepth)
    ).translate(0, p.width / 2 - p.trickLength / 2 + 5, 0);
  // ↑ groove pushed slightly past +Y face so needle hook can emerge

  // 20 grooves at the right pitch. Build placements explicitly using the
  // X_NEEDLE_OFFSET helper so we know exactly where every needle sits.
  const placements = Array.from({ length: p.needleCount }, (_, i) => ({
    translate: [X_NEEDLE_OFFSET(i), 0, 0] as [number, number, number],
  }));
  bed = patterns.cutAt(bed, trickToolFactory, placements);

  // 4× M4 mounting bolts to chassis (countersunk from top to keep needles flat)
  const boltPlacements = [
    [-(p.length / 2) + SPEC.bedMountInsetX,  (p.width / 2) - SPEC.bedMountInsetY],
    [ (p.length / 2) - SPEC.bedMountInsetX,  (p.width / 2) - SPEC.bedMountInsetY],
    [-(p.length / 2) + SPEC.bedMountInsetX, -(p.width / 2) + SPEC.bedMountInsetY],
    [ (p.length / 2) - SPEC.bedMountInsetX, -(p.width / 2) + SPEC.bedMountInsetY],
  ].map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] }));

  bed = patterns.cutAt(
    bed,
    () => holes.countersink(SPEC.bedMountBolt, { plateThickness: p.height }).translate(0, 0, 0),
    boltPlacements
  );

  return bed;
}

export default function main() {
  return [
    { shape: makeNeedleBed(), name: "needle-bed", color: COLORS.aluminum },
  ];
}
