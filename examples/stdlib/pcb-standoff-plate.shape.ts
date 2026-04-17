/**
 * Baseplate with a rectangular grid of M3 heat-set insert pockets for
 * mounting a PCB. Plus four M5 counterbored corner mount holes so the plate
 * itself bolts to a chassis.
 *
 * Demonstrates `patterns.grid` + `patterns.cutAt` for two independent
 * patterns applied to the same part.
 */
import { drawRoundedRectangle } from "replicad";
import { holes, inserts, patterns, shape3d } from "shapeitup";

export const params = {
  width: 100,
  depth: 80,
  thickness: 5,
  pcbSpacingX: 50,   // distance between PCB mount holes along X
  pcbSpacingY: 40,   // distance between PCB mount holes along Y
  chassisHoleInset: 8,
};

export default function main({
  width,
  depth,
  thickness,
  pcbSpacingX,
  pcbSpacingY,
  chassisHoleInset,
}: typeof params) {
  let plate = shape3d(
    drawRoundedRectangle(width, depth, 4).sketchOnPlane("XY").extrude(thickness)
  );

  // PCB mount pattern — 2×2 grid of heat-set inserts on the TOP face.
  // Standard cut-tool convention: top at Z=0 extending -Z. Translate up by
  // `thickness` so the pocket cuts downward from the top face of the plate.
  plate = patterns.cutAt(
    plate,
    () => inserts.pocket("M3").translate(0, 0, thickness),
    patterns.grid(2, 2, pcbSpacingX, pcbSpacingY),
  );

  // Chassis mount — 4 corner counterbored M5 through-holes.
  // grid(2, 2, dx, dy) centered on the origin lands one hole in each corner.
  plate = patterns.cutAt(
    plate,
    () => holes.counterbore("M5", { plateThickness: thickness }).translate(0, 0, thickness),
    patterns.grid(2, 2, width - 2 * chassisHoleInset, depth - 2 * chassisHoleInset),
  );

  return plate;
}
