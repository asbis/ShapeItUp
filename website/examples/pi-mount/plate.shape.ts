// A second component: the base plate, drilled for the board's hole pattern.
import { drawRoundedRectangle } from "replicad";
import { holes, patterns, shape3d } from "shapeitup";

export const params = { width: 100, depth: 80, thickness: 4, holesX: 58, holesY: 49 };

export function makePlate(width: number, depth: number, thickness: number, holesX: number, holesY: number) {
  let plate = shape3d(drawRoundedRectangle(width, depth, 6).sketchOnPlane("XY").extrude(thickness));
  // M2.5 clearance under each standoff.
  plate = patterns.cutAt(
    plate,
    () => holes.through("M2.5", { depth: thickness + 2 }).translate(0, 0, thickness),
    patterns.grid(2, 2, holesX, holesY),
  );
  // M4 counterbores in the corners so the plate itself can be screwed down.
  plate = patterns.cutAt(
    plate,
    () => holes.counterbore("M4", { plateThickness: thickness }).translate(0, 0, thickness),
    patterns.grid(2, 2, width - 14, depth - 14),
  );
  return plate;
}

export default function main({ width, depth, thickness, holesX, holesY }: typeof params) {
  return makePlate(width, depth, thickness, holesX, holesY);
}
