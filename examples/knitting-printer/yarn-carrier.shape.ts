import { makeBox, makeCylinder, type Shape3D } from "replicad";
import { holes } from "shapeitup";
import { YARN_EYELET_ID, COLORS } from "./constants";

// Yarn carrier arm. Bolts to the carriage front tab (Z=+4, Y=+17 in
// carriage local). Extends forward to lay yarn into the needle hooks.
//
// Local frame:
//   origin at the CLAMP PLATE CENTER-BOTTOM (mates to carriage tab top).
//   X: the carriage clamp width
//   Y: extends +Y forward toward the bed front
//   Z: clamp at z ∈ [0, 4]; arm drops into -Z

export const params = {
  clampLenX: 50,
  clampDepthY: 10,
  clampThickZ: 4,
  stemDropZ: 20,         // how far the arm drops below the clamp
  reachY: 30,            // how far forward the eyelet sits from clamp front edge
  tipThickZ: 5,
  tipRadius: 5,
  eyeletID: YARN_EYELET_ID,
  clampHoleOffset: 18,   // must match carriage yarnTab bolt pattern
};
export const material = "PETG";

export function makeYarnCarrier(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };

  // Clamp plate.
  let arm = makeBox(
    [-p.clampLenX / 2, -p.clampDepthY / 2, 0],
    [ p.clampLenX / 2,  p.clampDepthY / 2, p.clampThickZ],
  );

  // Two M3 through-holes for the carriage tab bolts.
  for (const sx of [-1, 1]) {
    const h = holes.through("M3", { depth: p.clampThickZ + 2, axis: "+Z" })
      .translate(sx * p.clampHoleOffset, 0, p.clampThickZ);
    arm = arm.cut(h);
  }

  // Vertical stem down from the front of the clamp.
  const stem = makeBox(
    [-5, p.clampDepthY / 2 - 2, -p.stemDropZ],
    [ 5, p.clampDepthY / 2 + 3, 0],
  );
  arm = arm.fuse(stem);

  // Forward arm out to the eyelet.
  const forwardArm = makeBox(
    [-5, p.clampDepthY / 2 + 3, -p.stemDropZ - p.tipThickZ],
    [ 5, p.clampDepthY / 2 + 3 + p.reachY, -p.stemDropZ],
  );
  arm = arm.fuse(forwardArm);

  // Eyelet tip — a rounded disc with a through-hole.
  const tipCenterY = p.clampDepthY / 2 + 3 + p.reachY;
  const tipCenterZ = -p.stemDropZ - p.tipThickZ / 2;
  const tip = makeCylinder(p.tipRadius, p.tipThickZ, [0, tipCenterY, -p.stemDropZ - p.tipThickZ], [0, 0, 1]);
  arm = arm.fuse(tip);

  // Yarn through-hole (axis Z, polished the eyelet is printed as cylinder).
  const eye = makeCylinder(p.eyeletID / 2, p.tipThickZ + 2, [0, tipCenterY, -p.stemDropZ - p.tipThickZ - 1], [0, 0, 1]);
  arm = arm.cut(eye);

  return arm;
}

export default function main(p: typeof params) {
  return [{ shape: makeYarnCarrier(p), name: "yarn-carrier", color: COLORS.yarnArm }];
}
