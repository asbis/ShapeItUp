// Solenoid bank — 20 small tubular solenoids mounted in a row behind the
// needle bed (-Y side). When energized, each solenoid's plunger lifts the
// corresponding needle's butt up into the cam track for a "knit" pass;
// otherwise the butt sits below and the needle is missed.
//
// Local frame: bank centered on origin. Solenoids point +Y (toward the needle
// bed). Plunger tip at Y=0 retracted, Y=+plungerLen extended.
// Mounting plate at -Y end of the bank (Y = -solLen).

import { drawRoundedRectangle } from "replicad";
import { shape3d, cylinder, holes, patterns } from "shapeitup";
import { SPEC, COLORS, X_NEEDLE_OFFSET } from "./constants";

export const params = {
  count: SPEC.needleCount,
  solDia: SPEC.solDia,
  solLen: SPEC.solLen,
  plungerDia: SPEC.solPlungerDia,
  plungerLen: SPEC.solPlungerLen,
  plateThk: SPEC.solBankPlateThk,
  plateWidth: SPEC.solBankPlateWidth,
};

export function makeSolenoidBank(p: typeof params = params) {
  // Mounting plate (along X, behind solenoid bodies).
  const plateLen = SPEC.bedKnitLength + 20;
  let plate = shape3d(
    drawRoundedRectangle(plateLen, p.plateThk, 2)
      .sketchOnPlane("XY")
      .extrude(p.plateWidth)
      .translate(0, -p.solLen - p.plateThk / 2, -p.plateWidth / 2)
  );

  // 4× M3 mount bolt holes (matching chassis pattern from base-chassis.shape.ts)
  const boltY = -p.solLen - p.plateThk;
  const boltZRange = p.plateWidth / 2 - 4;
  const boltPlacements = [
    [-SPEC.bedKnitLength / 2 + 5,  boltZRange],
    [ SPEC.bedKnitLength / 2 - 5,  boltZRange],
    [-SPEC.bedKnitLength / 2 + 5, -boltZRange],
    [ SPEC.bedKnitLength / 2 - 5, -boltZRange],
  ].map(([x, z]) => ({ translate: [x, boltY, z] as [number, number, number] }));
  plate = patterns.cutAt(
    plate,
    () => holes.through("M3", { depth: p.plateThk + 2, axis: "+Y" })
      .translate(0, p.plateThk / 2 + 1, 0),
    boltPlacements
  );

  return plate;
}

// Single solenoid body builder — used 20× by the assembly.
export function makeSolenoidBody() {
  const body = shape3d(
    cylinder({
      diameter: SPEC.solDia,
      length: SPEC.solLen,
      bottom: -SPEC.solLen,
      direction: "+Y",
    })
  );
  // Plunger pokes out of +Y end (retracted = flush, extended = +plungerLen).
  // Modeled retracted here; assembly may translate the plunger up to lift a butt.
  const plunger = shape3d(
    cylinder({
      diameter: SPEC.solPlungerDia,
      length: SPEC.solPlungerLen,
      bottom: 0,
      direction: "+Y",
    })
  );
  return body.fuse(plunger);
}

export default function main() {
  // Show the mount plate + 20 solenoid bodies in their bank positions
  const plate = makeSolenoidBank();
  const solenoids = Array.from({ length: SPEC.needleCount }, (_, i) => {
    const x = X_NEEDLE_OFFSET(i);
    return {
      shape: makeSolenoidBody().translate(x, 0, 0),
      name: `solenoid-${i.toString().padStart(2, "0")}`,
      color: COLORS.solenoid,
    };
  });
  return [
    { shape: plate, name: "solenoid-plate", color: COLORS.printedDark },
    ...solenoids,
  ];
}
