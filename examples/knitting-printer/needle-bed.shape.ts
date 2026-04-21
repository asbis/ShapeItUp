import { drawRoundedRectangle, makeBox, type Shape3D } from "replicad";
import { shape3d } from "shapeitup";
import {
  NEEDLE_COUNT, PITCH,
  BED_LENGTH, BED_DEPTH, BED_THICKNESS,
  GROOVE_WIDTH, GROOVE_DEPTH, GROOVE_LENGTH,
  GATE_PEG_WIDTH, GATE_PEG_HEIGHT,
  COLORS,
} from "./constants";

export const params = { previewIndex: 0 };
export const material = "PETG";

// Local frame: bed centered at X=0, front edge at +Y, top surface at Z=0,
// bottom at Z = -BED_THICKNESS.
//
//   +Y  (front, where needle hooks emerge)
//   ▲
//   │  [front half: gate-peg ridges hold the fabric down]
//   │  ───────────────────────────── y = +BED_DEPTH/2
//   │  │ pegs here (Z ∈ [0, 3])     │
//   │  │ ──────────────── y ≈ +5     │  <- groove y-range spans the whole bed,
//   │  │ butt-travel band (no pegs) │     but pegs live only in the front band
//   │  └────────────────── y = -GROOVE_LENGTH + BED_DEPTH/2
//   ▼  ───────────────────────────── y = -BED_DEPTH/2
//   -Y

export function makeNeedleBed(): Shape3D {
  let bed = shape3d(
    drawRoundedRectangle(BED_LENGTH, BED_DEPTH, 4)
      .sketchOnPlane("XY", [0, 0, -BED_THICKNESS])
      .extrude(BED_THICKNESS),
  );

  const grooveFrontY = BED_DEPTH / 2;
  const grooveBackY = grooveFrontY - GROOVE_LENGTH;
  // Split the groove length: front ~22 mm gets gate pegs (fabric support),
  // back ~26 mm is clean for cam-plate clearance over butt travel.
  const pegFrontY = grooveFrontY;
  const pegBackY = 5; // leaves y ∈ [grooveBackY, 5] clear for cam plate
  const butt_margin = 0.1;

  // 20 needle grooves (cut through top surface).
  for (let i = 0; i < NEEDLE_COUNT; i++) {
    const x = (i - (NEEDLE_COUNT - 1) / 2) * PITCH;
    const groove = makeBox(
      [x - GROOVE_WIDTH / 2, grooveBackY, -GROOVE_DEPTH],
      [x + GROOVE_WIDTH / 2, grooveFrontY + butt_margin, butt_margin],
    );
    bed = bed.cut(groove);
  }

  // 21 gate-peg ridges on top, between grooves, front half only.
  for (let i = 0; i <= NEEDLE_COUNT; i++) {
    const x = (i - NEEDLE_COUNT / 2) * PITCH;
    const peg = makeBox(
      [x - GATE_PEG_WIDTH / 2, pegBackY, 0],
      [x + GATE_PEG_WIDTH / 2, pegFrontY, GATE_PEG_HEIGHT],
    );
    bed = bed.fuse(peg);
  }

  return bed;
}

export default function main() {
  return [{ shape: makeNeedleBed(), name: "bed", color: COLORS.bed }];
}
