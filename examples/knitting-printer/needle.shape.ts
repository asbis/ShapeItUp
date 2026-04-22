// Latch needle (simplified) — straight stem along +Y, butt upstand near back end,
// shallow hook taper at front. Origin: needle back end at Y=0, stem resting
// in bed slot so stem-bottom at Z = -SLOT_DEPTH + 0.5 (floats 0.5 mm above slot floor).
// Built at origin — the assembly translates per-needle along X and Y.

import { drawRectangle, type Shape3D } from "replicad";
import { shape3d } from "shapeitup";
import {
  NEEDLE_LENGTH, NEEDLE_STEM_W, NEEDLE_STEM_H,
  BUTT_W, BUTT_H, BUTT_L, BUTT_Y_OFFSET,
  SLOT_DEPTH, C_NEEDLE,
} from "./constants";

export function makeNeedle(): Shape3D {
  // Stem rests inside the bed slot; its top face sits at Z = -(SLOT_DEPTH - NEEDLE_STEM_H)/2
  // Simpler: align stem top at Z = -0.5 (0.5 mm below bed top so butt upstand protrudes above).
  const stemTopZ = -0.5;
  const stemBottomZ = stemTopZ - NEEDLE_STEM_H;

  // Stem: extrude along +Y from Y=0 to Y=NEEDLE_LENGTH
  let stem = shape3d(
    drawRectangle(NEEDLE_STEM_W, NEEDLE_LENGTH)
      .sketchOnPlane("XY", [0, NEEDLE_LENGTH / 2, stemBottomZ])
      .extrude(NEEDLE_STEM_H)
  );

  // Butt: rectangular block standing UP from stem top, near back end (-Y side)
  const buttY = NEEDLE_LENGTH / 2 + BUTT_Y_OFFSET;  // still inside needle length
  const butt = shape3d(
    drawRectangle(BUTT_W, BUTT_L)
      .sketchOnPlane("XY", [0, buttY, stemTopZ])
      .extrude(BUTT_H)
  );

  // Hook: small round-ended bump at front end (Y = NEEDLE_LENGTH)
  const hookY = NEEDLE_LENGTH - 2;
  const hook = shape3d(
    drawRectangle(NEEDLE_STEM_W, 2)
      .sketchOnPlane("XY", [0, hookY + 1, stemTopZ])
      .extrude(NEEDLE_STEM_H * 0.8)
  );

  return stem.fuse(butt).fuse(hook);
}

export default function main() {
  return [{ shape: makeNeedle(), name: "needle", color: C_NEEDLE }];
}
