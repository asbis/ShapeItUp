import { draw, drawRoundedRectangle, type Shape3D } from "replicad";
import { shape3d } from "shapeitup";
import {
  CARRIAGE_LENGTH, CAM_PLATE_THICKNESS, CAM_TRACK_HEIGHT,
  BUTT_LENGTH, BUTT_LIFT_FULL,
  COLORS,
} from "./constants";

// Cam plate local frame:
//   centered at X=0 (direction of carriage travel)
//   Y=0 is the plate centerline (back half of bed when assembled)
//   bottom at Z=0, top at Z=CAM_PLATE_THICKNESS
//   the cam slot is cut into the bottom face, depth CAM_TRACK_HEIGHT
//
// Butt rest position in plate-local Y = -BUTT_LIFT_FULL/2
// Butt clear position in plate-local Y = +BUTT_LIFT_FULL/2
// Ramp half-length along X = BUTT_LIFT_FULL (gives 45° face)
//
// Track centerline seen from below (XY plane):
//
//    y_clear  ______/\______
//                  /  \
//                 /    \
//    y_rest  ___/      \____
//           -40  -14  0 +14  +40

export const params = {
  length: CARRIAGE_LENGTH,
  depth: 28,
  thickness: CAM_PLATE_THICKNESS,
  liftFull: BUTT_LIFT_FULL,
  slotWidth: BUTT_LENGTH + 0.3,
  trackHeight: CAM_TRACK_HEIGHT,
};
export const material = "PETG";

export function makeCamPlate(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };
  const rampHalf = p.liftFull;      // 45° ⇒ ΔX = ΔY
  const y_rest = -p.liftFull / 2;
  const y_clear = +p.liftFull / 2;
  const xL = -p.length / 2;
  const xR = +p.length / 2;
  const slotHi = p.slotWidth;

  let plate = shape3d(
    drawRoundedRectangle(p.length, p.depth, 3)
      .sketchOnPlane("XY", [0, 0, 0])
      .extrude(p.thickness),
  );

  // Chevron slot polygon (closed) — lower edge of the slot is the chevron,
  // upper edge is a parallel chevron offset by slotHi in +Y.
  const slot = draw([xL, y_rest])
    .lineTo([-rampHalf, y_rest])
    .lineTo([0, y_clear])
    .lineTo([ rampHalf, y_rest])
    .lineTo([xR, y_rest])
    .lineTo([xR, y_rest + slotHi])
    .lineTo([ rampHalf, y_rest + slotHi])
    .lineTo([0, y_clear + slotHi])
    .lineTo([-rampHalf, y_rest + slotHi])
    .lineTo([xL, y_rest + slotHi])
    .close();

  const slotSolid = shape3d(
    slot.sketchOnPlane("XY", [0, 0, 0]).extrude(p.trackHeight),
  );

  plate = plate.cut(slotSolid);
  return plate;
}

export default function main(p: typeof params) {
  return [{ shape: makeCamPlate(p), name: "cam-plate", color: COLORS.cam }];
}
