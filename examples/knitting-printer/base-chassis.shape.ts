import { drawRoundedRectangle, makeBox, type Shape3D } from "replicad";
import { shape3d, holes } from "shapeitup";
import {
  BED_LENGTH, BED_DEPTH, END_CAP_LENGTH,
  BASE_LENGTH, BASE_DEPTH, BASE_THICKNESS,
  COLORS,
} from "./constants";

// Base chassis plate. Sits under the bed and end caps; carries the
// solenoid bank at its rear. Top surface at Z=0, bottom at Z=-thickness.
// The bed also has its bottom at Z=-12, so the top of this chassis is at
// Z=-12 (i.e. 12 mm below bed-top).
//
// Simplified mounting scheme — four M3 through-holes at each attached
// part's footprint. Stiffening ribs on the underside. Feet pads at corners.

export const params = {
  length: BASE_LENGTH,
  depth: BASE_DEPTH,
  thickness: BASE_THICKNESS,
  footPadR: 4,
};
export const material = "PETG";

export function makeBaseChassis(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };

  // Base plate — rounded, origin at center (top surface at Z=0).
  let base = shape3d(
    drawRoundedRectangle(p.length, p.depth, 8)
      .sketchOnPlane("XY", [0, 0, -p.thickness])
      .extrude(p.thickness),
  );

  // Underside stiffening ribs — three crosswise, two lengthwise.
  const ribH = 6;
  const ribW = 4;
  // Crosswise ribs (along Y).
  for (const xc of [-p.length / 3, 0, p.length / 3]) {
    const rib = makeBox(
      [xc - ribW / 2, -p.depth / 2 + 6, -p.thickness - ribH],
      [xc + ribW / 2,  p.depth / 2 - 6, -p.thickness],
    );
    base = base.fuse(rib);
  }
  // Lengthwise ribs (along X).
  for (const yc of [-p.depth / 3, p.depth / 3]) {
    const rib = makeBox(
      [-p.length / 2 + 8, yc - ribW / 2, -p.thickness - ribH],
      [ p.length / 2 - 8, yc + ribW / 2, -p.thickness],
    );
    base = base.fuse(rib);
  }

  // Mounting holes — through the plate top-down. Five groups:
  //  - Bed: 4 at corners of the bed footprint
  //  - Motor cap (left): 4 at motor-cap base footprint
  //  - Idler cap (right): 4 at idler-cap base footprint
  //  - Solenoid bank: 4 at solenoid-bank footprint
  const endCapX = BED_LENGTH / 2 + END_CAP_LENGTH / 2;  // cap center X when flush against bed
  const mountGroups: [number, number][][] = [
    // Bed mounts (corners, 6mm inset from bed edges).
    [
      [-BED_LENGTH / 2 + 10, -BED_DEPTH / 2 + 6],
      [ BED_LENGTH / 2 - 10, -BED_DEPTH / 2 + 6],
      [-BED_LENGTH / 2 + 10,  BED_DEPTH / 2 - 6],
      [ BED_LENGTH / 2 - 10,  BED_DEPTH / 2 - 6],
    ],
    // Motor cap (left) — cap bottom bolts at (bx, by) cap-local = [(6, yMin+6), (L-6, yMin+6), (6, yMax-6), (L-6, yMax-6)]
    [
      [-endCapX - END_CAP_LENGTH / 2 + 6, -60 + 6],
      [-endCapX + END_CAP_LENGTH / 2 - 6, -60 + 6],
      [-endCapX - END_CAP_LENGTH / 2 + 6,   5 - 6],
      [-endCapX + END_CAP_LENGTH / 2 - 6,   5 - 6],
    ],
    // Idler cap (right) — mirrored.
    [
      [ endCapX - END_CAP_LENGTH / 2 + 6, -60 + 6],
      [ endCapX + END_CAP_LENGTH / 2 - 6, -60 + 6],
      [ endCapX - END_CAP_LENGTH / 2 + 6,   5 - 6],
      [ endCapX + END_CAP_LENGTH / 2 - 6,   5 - 6],
    ],
    // Solenoid bank (positioned behind the bed — centered at Y = -BED_DEPTH/2 - 26/2 - 4 = -44).
    [
      [-90,       -44 - 9],
      [ 90,       -44 - 9],
      [-90,       -44 + 9],
      [ 90,       -44 + 9],
    ],
  ];
  for (const group of mountGroups) {
    for (const [hx, hy] of group) {
      const h = holes.through("M3", { depth: p.thickness + ribH + 2, axis: "+Z" })
        .translate(hx, hy, 0);
      base = base.cut(h);
    }
  }

  return base;
}

export default function main(p: typeof params) {
  return [{ shape: makeBaseChassis(p), name: "base-chassis", color: COLORS.base }];
}
