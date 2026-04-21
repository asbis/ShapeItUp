import { drawRoundedRectangle, makeBox, makeCylinder, type Shape3D } from "replicad";
import { shape3d, holes, patterns } from "shapeitup";
import {
  NEEDLE_COUNT, PITCH,
  SOLENOID_BODY_LENGTH, SOLENOID_BODY_DIAMETER,
  SOLENOID_PLUNGER_DIAMETER, SOLENOID_PITCH, SOLENOID_BANK_LENGTH,
  COLORS,
} from "./constants";

// 20-solenoid needle-selector bank. Plunger axis = +Y (pushes needle tail
// forward to advance the needle for the current pass). Solenoid body
// socketed from the -Y face; plunger escape hole on the +Y face.
//
// Local frame:
//   X: ±SOLENOID_BANK_LENGTH/2
//   Y: bar depth (centered)
//   Z: 0 (bottom, sits on chassis) → height.

const BAR_DEPTH_Y = SOLENOID_BODY_LENGTH + 6;
const BAR_HEIGHT_Z = SOLENOID_BODY_DIAMETER + 10;

export const params = {
  length: SOLENOID_BANK_LENGTH,
  depth: BAR_DEPTH_Y,
  height: BAR_HEIGHT_Z,
  solenoidBodyD: SOLENOID_BODY_DIAMETER,
  solenoidBodyL: SOLENOID_BODY_LENGTH,
  plungerD: SOLENOID_PLUNGER_DIAMETER,
  pitch: SOLENOID_PITCH,
  count: NEEDLE_COUNT,
};
export const material = "PETG";

export function makeSolenoidBank(opts: Partial<typeof params> = {}): Shape3D {
  const p = { ...params, ...opts };

  let bar = shape3d(
    drawRoundedRectangle(p.length, p.depth, 3)
      .sketchOnPlane("XY", [0, 0, 0])
      .extrude(p.height),
  );

  // Row of solenoid pockets — ø(body+0.4) slip-fit bore opening on the
  // -Y face. Each pocket extends along +Y into the bar.
  const solZ = p.height / 2;

  const pocketFactory = () => makeCylinder(
    p.solenoidBodyD / 2 + 0.2,
    p.solenoidBodyL + 1,
    [0, -p.solenoidBodyL / 2 - 0.5, 0],
    [0, 1, 0],
  );
  // Plunger escape hole at the front of each pocket.
  const plungerEscapeFactory = () => makeCylinder(
    p.plungerD / 2 + 0.25,
    6,
    [0, p.depth / 2 - 4, 0],
    [0, 1, 0],
  );

  const xShift = -(p.count - 1) * p.pitch / 2;
  const pocketPlacements = patterns.linear(p.count, [p.pitch, 0, 0]).map((pl) => ({
    ...pl,
    translate: [pl.translate[0] + xShift, 0, solZ] as [number, number, number],
  }));

  bar = patterns.cutAt(bar, pocketFactory, pocketPlacements);
  bar = patterns.cutAt(bar, plungerEscapeFactory, pocketPlacements);

  // Wire-exit slot on the back face (one long slot across, so solenoid
  // leads can be wrangled out).
  const wireSlot = makeBox(
    [-p.length / 2 + 6, -p.depth / 2 - 0.5, p.height - 6],
    [ p.length / 2 - 6, -p.depth / 2 + 2,   p.height - 2],
  );
  bar = bar.cut(wireSlot);

  // Base mounting — 4× M3 through.
  const mountX = p.length / 2 - 10;
  const mountY = p.depth / 2 - 4;
  for (const [bx, by] of [
    [-mountX, -mountY], [mountX, -mountY],
    [-mountX,  mountY], [mountX,  mountY],
  ] as [number, number][]) {
    const h = holes.through("M3", { depth: p.height + 2, axis: "+Z" })
      .translate(bx, by, p.height);
    bar = bar.cut(h);
  }

  return bar;
}

// Mock solenoid for assembly visualization.
export function makeSolenoidBody(): Shape3D {
  const body = makeCylinder(SOLENOID_BODY_DIAMETER / 2, SOLENOID_BODY_LENGTH, [0, 0, 0], [0, 1, 0]);
  const plunger = makeCylinder(SOLENOID_PLUNGER_DIAMETER / 2, 8, [0, SOLENOID_BODY_LENGTH, 0], [0, 1, 0]);
  return body.fuse(plunger);
}

export default function main(p: typeof params) {
  return [{ shape: makeSolenoidBank(p), name: "solenoid-bank", color: COLORS.solMount }];
}
