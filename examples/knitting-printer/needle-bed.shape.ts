// Needle bed — rectangular plate with 20 parallel slots running along +Y.
// Centered on origin, top face at Z=0, bottom at Z=-BED_THICKNESS.
// Slots run the full Y-length of the bed so the needle can slide back and forth.

import { drawRectangle, type Shape3D } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import {
  BED_LENGTH, BED_WIDTH, BED_THICKNESS,
  SLOT_WIDTH, SLOT_DEPTH,
  N_NEEDLES, NEEDLE_PITCH, FIRST_NEEDLE_X,
  C_BED,
} from "./constants";

export function makeNeedleBed(): Shape3D {
  let bed = shape3d(
    drawRectangle(BED_LENGTH, BED_WIDTH)
      .sketchOnPlane("XY", [0, 0, -BED_THICKNESS / 2])
      .extrude(BED_THICKNESS)
  );

  // 20 needle slots — each a thin rectangular pocket cut downward from the top face.
  // The slot runs the full BED_WIDTH (Y axis) so the needle can slide freely.
  for (let i = 0; i < N_NEEDLES; i++) {
    const x = FIRST_NEEDLE_X + i * NEEDLE_PITCH;
    const slot = shape3d(
      drawRectangle(SLOT_WIDTH, BED_WIDTH + 2)
        .sketchOnPlane("XY", [x, 0, -SLOT_DEPTH / 2])
        .extrude(SLOT_DEPTH)
    );
    bed = bed.cut(slot);
  }

  // 4 mounting holes (M3 clearance) at the corners — tie bed to chassis later.
  const inset = 6;
  const positions: [number, number][] = [
    [-BED_LENGTH / 2 + inset, -BED_WIDTH / 2 + inset],
    [ BED_LENGTH / 2 - inset, -BED_WIDTH / 2 + inset],
    [-BED_LENGTH / 2 + inset,  BED_WIDTH / 2 - inset],
    [ BED_LENGTH / 2 - inset,  BED_WIDTH / 2 - inset],
  ];
  bed = patterns.cutAt(
    bed,
    () => holes.through("M3", { depth: BED_THICKNESS + 2 }).translate(0, 0, 0),
    positions.map(([x, y]) => ({ translate: [x, y, 0] as [number, number, number] })),
  );

  return bed;
}

export default function main() {
  return [{ shape: makeNeedleBed(), name: "needle-bed", color: C_BED }];
}
