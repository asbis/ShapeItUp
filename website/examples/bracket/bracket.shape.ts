// An L-bracket. Try it: click the top face of the upright in the viewer,
// press Fillet, drag the arrow, Apply — the call is written into this file.
import { draw, drawRoundedRectangle } from "replicad";
import { holes, patterns, placeOn, shape3d } from "shapeitup";

export const params = {
  width: 60,
  depth: 40,
  height: 50,
  thickness: 5,
  gusset: 24,
  holeInset: 15,
};

export default function main({ width, depth, height, thickness, gusset, holeInset }: typeof params) {
  // Base leg lies on the bed and runs out towards -Y.
  const base = drawRoundedRectangle(width, depth, 3)
    .sketchOnPlane("XY")
    .extrude(thickness)
    .translate(0, -depth / 2, 0);

  // Upright leg stands along the back edge, Y = -thickness..0.
  const upright = drawRoundedRectangle(width, height, 3)
    .sketchOnPlane("XY")
    .extrude(thickness)
    .rotate(90, [0, 0, 0], [1, 0, 0])
    .translate(0, 0, height / 2);

  // Two triangular gussets tie the legs together at the outer edges.
  const rib = placeOn(
    draw([0, 0]).lineTo([-gusset, 0]).lineTo([0, gusset]).close(),
    "YZ",
    { into: "+X", distance: thickness },
  );
  const ribs = [-width / 2 + 3, width / 2 - 3 - thickness].map((x) =>
    rib.clone().translate(x, -thickness, thickness),
  );

  let bracket = shape3d(base.fuse(upright).fuse(ribs[0]).fuse(ribs[1]));

  // Counterbored M4 holes down through the base…
  bracket = patterns.cutAt(
    bracket,
    () => holes.counterbore("M4", { plateThickness: thickness }).translate(0, -depth * 0.62, thickness),
    patterns.grid(2, 1, width - 2 * holeInset, 1),
  );
  // …and M4 clearance holes through the upright.
  bracket = patterns.cutAt(
    bracket,
    () => holes.through("M4", { depth: thickness + 2, axis: "-Y" }).translate(0, -thickness, height * 0.62),
    patterns.grid(2, 1, width - 2 * holeInset, 1),
  );

  return bracket;
}
