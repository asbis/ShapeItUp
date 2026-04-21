import { drawRoundedRectangle, makeBox, makeCylinder, type Shape3D } from "replicad";
import { shape3d, holes, bearings } from "shapeitup";
import {
  END_CAP_LENGTH, RAIL_DIAMETER,
  RAIL_Y_BEHIND_BED, RAIL_Z_LOWER, RAIL_Z_UPPER,
  COLORS,
} from "./constants";

export const params = {
  length: END_CAP_LENGTH,
  yMin: -60,
  yMax: 5,
  height: 55,
  railY: RAIL_Y_BEHIND_BED,
  railZLower: RAIL_Z_LOWER,
  railZUpper: RAIL_Z_UPPER,
  railSocketDepth: 15,
  railDiameter: RAIL_DIAMETER,
  idlerY: -40,
  idlerZ: RAIL_Z_LOWER,
  idlerAxleDiameter: 8,
  bearingOD: 22,
};
export const material = "PETG";

export function makeIdlerEndCap(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };
  const width = p.yMax - p.yMin;
  const yCenter = (p.yMax + p.yMin) / 2;

  let cap = shape3d(
    drawRoundedRectangle(p.length, width, 3)
      .sketchOnPlane("XY", [p.length / 2, yCenter, 0])
      .extrude(p.height),
  );

  for (const z of [p.railZLower, p.railZUpper]) {
    const socket = holes.through(p.railDiameter + 0.2, { depth: p.railSocketDepth, axis: "-X" })
      .translate(0, p.railY, z);
    cap = cap.cut(socket);
  }

  const bearingPocket = makeCylinder(
    p.bearingOD / 2 + 0.15,
    9,
    [p.length + 0.5, p.idlerY, p.idlerZ],
    [-1, 0, 0],
  );
  cap = cap.cut(bearingPocket);

  const axleHole = makeCylinder(
    p.idlerAxleDiameter / 2 + 0.15,
    p.length + 2,
    [-1, p.idlerY, p.idlerZ],
    [1, 0, 0],
  );
  cap = cap.cut(axleHole);

  const beltCavity = makeBox(
    [0, p.idlerY - 6, p.idlerZ - 14],
    [p.length - 9.5, p.idlerY + 6, p.idlerZ + 14],
  );
  cap = cap.cut(beltCavity);

  // Base mounting — slotted along X (±1.5 mm travel) for belt tensioning.
  const baseBoltPositions: [number, number][] = [
    [6, p.yMin + 6], [p.length - 6, p.yMin + 6],
    [6, p.yMax - 6], [p.length - 6, p.yMax - 6],
  ];
  for (const [bx, by] of baseBoltPositions) {
    const slot = holes.slot({ length: 6, width: 3.4, depth: p.height + 2, axis: "+Z" })
      .translate(bx, by, p.height);
    cap = cap.cut(slot);
  }

  return cap;
}

export function makeIdlerBearing(): Shape3D {
  return bearings.body("608");
}

export default function main(p: typeof params) {
  return [{ shape: makeIdlerEndCap(p), name: "end-cap-idler", color: COLORS.endCap }];
}
