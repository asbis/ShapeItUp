/**
 * Round flange with a 6-bolt M4 circle on a 40mm PCD, plus a centered
 * bearing seat. The kind of part you'd bolt to the end of a tube or motor.
 *
 * Demonstrates `patterns.polar` + `patterns.cutAt` — the single-line way to
 * build a bolt circle.
 */
import { drawCircle } from "replicad";
import { bearings, holes, patterns, shape3d } from "shapeitup";

export const params = {
  outerD: 60,
  thickness: 5,
  boltCircleD: 40,
  boltCount: 6,
  bearing: "608",
};

export default function main({ outerD, thickness, boltCircleD, boltCount, bearing }: typeof params) {
  let flange = shape3d(
    drawCircle(outerD / 2).sketchOnPlane("XY").extrude(thickness)
  );

  // Central bearing seat (press-fit, stepped pocket by default).
  const seat = bearings.seat(bearing).translate(0, 0, thickness);
  flange = flange.cut(seat);

  // Bolt circle: 6 × M4 counterbored mounting holes. The factory (arrow fn)
  // is required — see patterns.cutAt docs for why.
  flange = patterns.cutAt(
    flange,
    () => holes.counterbore("M4", { plateThickness: thickness }).translate(0, 0, thickness),
    patterns.polar(boltCount, boltCircleD / 2),
  );

  return flange;
}
