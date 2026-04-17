/**
 * L-bracket with horizontal teardrop cable/pin holes through the vertical
 * face. Teardrop holes print cleanly on FDM without supports because the
 * triangular roof replaces the un-bridgeable top of a circle.
 */
import { draw, type Shape3D } from "replicad";
import { holes } from "shapeitup";

export const params = {
  baseLength: 60,
  uprightHeight: 40,
  depth: 30,
  thickness: 5,
  holeSize: 6, // mm diameter
};

export default function main({
  baseLength,
  uprightHeight,
  depth,
  thickness,
  holeSize,
}: typeof params) {
  // Draw the L-bracket as a single closed profile in the XZ plane, then
  // extrude along +Y by `depth`. Building it this way (rather than fusing
  // two separate box extrusions) avoids the OCCT compound-solid result
  // that rejects subsequent boolean cuts.
  //
  // Profile, traced CCW starting at the outer -X -Z corner:
  //   (-L/2, 0)  → (L/2, 0)                       bottom of base
  //   (L/2, 0)   → (L/2, t)                       right edge of base
  //   (L/2, t)   → (-L/2 + t, t)                  top of base (right of upright)
  //   (-L/2+t,t) → (-L/2 + t, t + h)              right edge of upright
  //   (-L/2+t,t+h)→ (-L/2, t + h)                 top of upright
  //   close:     → (-L/2, 0)                      left edge of the upright down to the base
  const L = baseLength;
  const t = thickness;
  const h = uprightHeight;
  const profile = draw([-L / 2, 0])
    .hLine(L)                 // bottom of base
    .vLine(t)                 // right edge of base
    .hLine(-(L - t))          // top of base, stopping at the upright
    .vLine(h)                 // right edge of upright
    .hLine(-t)                // top of upright
    .close();                 // down the outer-left edge back to start

  // Cast to Shape3D: replicad's .extrude() types as an overly-wide union in
  // its published .d.ts, so `.cut()` on the raw result doesn't type-check.
  // Runtime always returns a Solid.
  let bracket = profile
    .sketchOnPlane("XZ", [0, -depth / 2, 0])
    .extrude(depth) as Shape3D;

  // Two horizontal teardrop holes running along Y (axis = "Y"), through the
  // vertical plate. The vertical plate occupies X from
  //    -baseLength/2  .. -baseLength/2 + thickness
  // so we need the teardrop to span Y = -depth/2 .. +depth/2.
  // A teardrop with axis="Y" extrudes from 0 to +depth along Y; translate
  // to start at -depth/2. The tool's cross-section is centred on the X axis
  // (circle at x=0). Move it into the upright's midline along X.
  const holeLen = depth + 1; // overshoot for a clean boolean
  const xCentre = -baseLength / 2 + thickness / 2;
  const yStart = -depth / 2 - 0.5;
  const zLow = thickness + uprightHeight * 0.35;
  const zHigh = thickness + uprightHeight * 0.75;

  const hole1 = holes
    .teardrop(holeSize, { depth: holeLen, axis: "Y" })
    .translate(xCentre, yStart, zLow);
  const hole2 = holes
    .teardrop(holeSize, { depth: holeLen, axis: "Y" })
    .translate(xCentre, yStart, zHigh);

  bracket = bracket.cut(hole1).cut(hole2);
  return bracket;
}
