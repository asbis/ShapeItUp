import { drawRoundedRectangle, makeBox, type Shape3D } from "replicad";
import { shape3d, holes } from "shapeitup";
import {
  END_CAP_LENGTH, RAIL_DIAMETER,
  RAIL_Y_BEHIND_BED, RAIL_Z_LOWER, RAIL_Z_UPPER,
  NEMA17_BOLT_PITCH, NEMA17_SHAFT_DIAMETER,
  COLORS,
} from "./constants";

// Motor-side end cap. Local frame:
//   X: 0 (inner face, toward carriage) → END_CAP_LENGTH (outer face, motor)
//   Y: body spans [yMin, yMax] — NOT centered (motor shaft offset behind bed)
//   Z: 0 (bottom / sits on base) → height
//
// The motor attaches to the +X face in the standard NEMA17 pattern, shaft
// axis = +X, pokes through the pilot hole into the machine interior where
// the GT2 pulley clamps to it. The belt runs along the carriage belt-clamp
// plane (same Y as RAIL_Y_BEHIND_BED - 10 = -40 in bed frame).

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
  motorY: -40,                 // belt plane — 10 mm behind the rails
  motorZ: RAIL_Z_LOWER,        // shaft height matches carriage belt clamp
  motorPilotDiameter: NEMA17_SHAFT_DIAMETER + 18, // ø23 pilot (clears 22mm boss)
  motorBoltPitch: NEMA17_BOLT_PITCH,
};
export const material = "PETG";

export function makeMotorEndCap(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };
  const width = p.yMax - p.yMin;
  const yCenter = (p.yMax + p.yMin) / 2;

  // Main block — origin at inner-face bottom, at Y=0 line.
  let cap = shape3d(
    drawRoundedRectangle(p.length, width, 3)
      .sketchOnPlane("XY", [p.length / 2, yCenter, 0])
      .extrude(p.height),
  );

  // Rail sockets on the inner (-X) face — blind bores into +X.
  // stdlib axis "-X" => opens at tool's X=0, body spans X ∈ [0, depth].
  for (const z of [p.railZLower, p.railZUpper]) {
    const socket = holes.through(p.railDiameter + 0.2, { depth: p.railSocketDepth, axis: "-X" })
      .translate(0, p.railY, z);
    cap = cap.cut(socket);
  }

  // Motor pilot hole (through, on +X face).
  const pilot = holes.through(p.motorPilotDiameter, { depth: p.length + 2, axis: "+X" })
    .translate(p.length, p.motorY, p.motorZ);
  cap = cap.cut(pilot);

  // NEMA17 bolt pattern: 4× M3 through-holes at 31 mm grid.
  const off = p.motorBoltPitch / 2;
  for (const [dy, dz] of [[-off, -off], [off, -off], [-off, off], [off, off]] as [number, number][]) {
    const h = holes.through("M3", { depth: p.length + 2, axis: "+X" })
      .translate(p.length, p.motorY + dy, p.motorZ + dz);
    cap = cap.cut(h);
  }

  // Base mounting — 4× M3 clearance, through top face, body into -Z.
  // axis "+Z" => opens on +Z face, body into -Z, so translate to z=height.
  const baseBolts: [number, number][] = [
    [6, p.yMin + 6], [p.length - 6, p.yMin + 6],
    [6, p.yMax - 6], [p.length - 6, p.yMax - 6],
  ];
  for (const [bx, by] of baseBolts) {
    const h = holes.through("M3", { depth: p.height + 2, axis: "+Z" })
      .translate(bx, by, p.height);
    cap = cap.cut(h);
  }

  // Cavity behind the motor shaft so the pulley has room to spin (Ø14 pulley + GT2 belt = ø16 envelope).
  const pulleyCavity = makeBox(
    [0, p.motorY - 12, p.motorZ - 12],
    [p.length - 3, p.motorY + 12, p.motorZ + 12],
  );
  cap = cap.cut(pulleyCavity);

  return cap;
}

export default function main(p: typeof params) {
  return [{ shape: makeMotorEndCap(p), name: "end-cap-motor", color: COLORS.endCap }];
}
