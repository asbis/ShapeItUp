import { drawRoundedRectangle, makeBox, makeCylinder, type Shape3D } from "replicad";
import { shape3d, holes } from "shapeitup";
import {
  CARRIAGE_LENGTH, CARRIAGE_WALL, CAM_PLATE_THICKNESS,
  RAIL_DIAMETER, RAIL_Y_BEHIND_BED, RAIL_Z_LOWER, RAIL_Z_UPPER,
  BUTT_HEIGHT,
  COLORS,
} from "./constants";

// Carriage local frame:
//   origin at CENTER of bottom face (mates to cam-plate top)
//   X: ±CARRIAGE_LENGTH/2 (direction of travel)
//   Y: front edge at +14 (covers the cam slot),
//      back edge at RAIL_Y_BEHIND_BED - 5 = -35 (behind the rails)
//   Z: 0 (bottom) → totalHeight (top). Bed frame Z of bottom = BUTT_HEIGHT + CAM_PLATE_THICKNESS
//
// Rail through-holes are along X. In carriage-local Z:
//   rail bore Z = (absolute rail Z) - (carriage bottom Z in bed frame)
//               = RAIL_Z_{LOWER|UPPER} - (BUTT_HEIGHT + CAM_PLATE_THICKNESS)
// which we compute as RAIL_Z_LOCAL_{LOWER|UPPER}.

export const params = {
  length: CARRIAGE_LENGTH,
  frontY: 14,          // front face Y in carriage frame
  backY: -40,          // back face Y in carriage frame (behind rails)
  totalHeight: RAIL_Z_UPPER - (BUTT_HEIGHT + CAM_PLATE_THICKNESS) + 8, // cover upper rail
  railHoleClearance: 0.3,
};
export const material = "PETG";

export function makeCarriage(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };
  const depth = p.frontY - p.backY;
  const yCenter = (p.frontY + p.backY) / 2;

  // Rail Z in carriage-local frame: subtract carriage-bottom global Z.
  const carriageBottomGlobalZ = BUTT_HEIGHT + CAM_PLATE_THICKNESS;
  const railZLowerLocal = RAIL_Z_LOWER - carriageBottomGlobalZ;   // 10.5
  const railZUpperLocal = RAIL_Z_UPPER - carriageBottomGlobalZ;   // 24.5

  // Main body (rounded box).
  let body = shape3d(
    drawRoundedRectangle(p.length, depth, 4)
      .sketchOnPlane("XY", [0, yCenter, 0])
      .extrude(p.totalHeight),
  );

  // Rail bores — through-holes along X at the rear (y = RAIL_Y_BEHIND_BED).
  const bore = (z: number) =>
    makeCylinder(
      RAIL_DIAMETER / 2 + p.railHoleClearance,
      p.length + 20,
      [-(p.length + 20) / 2, RAIL_Y_BEHIND_BED, z],
      [1, 0, 0],
    );
  body = body.cut(bore(railZLowerLocal)).cut(bore(railZUpperLocal));

  // Hollow pocket in the interior to save material, leaving thicker rear
  // section around the rail bores and a full floor under the cam zone.
  const innerLen = p.length - CARRIAGE_WALL * 2 - 4;
  const pocket = makeBox(
    [-innerLen / 2, yCenter - 8, CARRIAGE_WALL],
    [ innerLen / 2, yCenter + 10, p.totalHeight - CARRIAGE_WALL],
  );
  body = body.cut(pocket);

  // Cam-plate mount — 4× M3 clearance holes through the floor.
  const mountY1 = +p.frontY - 5;
  const mountY2 = -6;
  for (const [hx, hy] of [
    [-p.length / 2 + 10, mountY1],
    [ p.length / 2 - 10, mountY1],
    [-p.length / 2 + 10, mountY2],
    [ p.length / 2 - 10, mountY2],
  ] as [number, number][]) {
    const h = holes.through("M3", { depth: CARRIAGE_WALL + 2 }).translate(hx, hy, CARRIAGE_WALL + 0.5);
    body = body.cut(h);
  }

  // Belt-clamp boss on the -Y face, at lower-rail Z (so belt runs horizontally).
  const boss = makeBox(
    [-7, p.backY - 6, railZLowerLocal - 6],
    [ 7, p.backY,      railZLowerLocal + 6],
  );
  body = body.fuse(boss);
  const beltTeethSlot = makeBox(
    [-5, p.backY - 7, railZLowerLocal - 1.0],
    [ 5, p.backY + 3, railZLowerLocal + 1.0],
  );
  body = body.cut(beltTeethSlot);
  // Two M3 clamp holes (belt pinched between carriage body and an M3 washer stack).
  for (const sx of [-1, 1]) {
    const h = holes.through("M3", { depth: 12, axis: "+Y" }).translate(sx * 3.5, p.backY, railZLowerLocal);
    body = body.cut(h);
  }

  // Yarn-carrier mount tab: a stub extending +Y under the cam plate region
  // with an M3 thru so the yarn-arm clamps to it.
  const yarnTab = makeBox(
    [-25, p.frontY - 2, 0],
    [ 25, p.frontY + 8, 4],
  );
  body = body.fuse(yarnTab);
  for (const sx of [-18, 18]) {
    const h = holes.through("M3", { depth: 6 }).translate(sx, p.frontY + 3, 4);
    body = body.cut(h);
  }

  return body;
}

export default function main(p: typeof params) {
  return [{ shape: makeCarriage(p), name: "carriage", color: COLORS.carriage }];
}
