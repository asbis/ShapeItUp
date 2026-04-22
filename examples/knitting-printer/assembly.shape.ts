// Mini flatbed knitting-printer — full assembly.
// 20-needle single-bed, 3D-printable concept rig. Every part lives in its
// own .shape.ts file and is composed here with explicit world-space translations.
// See constants.ts for the axis convention and every shared dimension.

import { type Shape3D, makeCylinder, makeBox } from "replicad";
import {
  N_NEEDLES, NEEDLE_PITCH, FIRST_NEEDLE_X, NEEDLE_LENGTH, NEEDLE_REST_Y,
  RAIL_LENGTH, RAIL_Y_FRONT, RAIL_Y_BACK, RAIL_Z,
  MOTOR_FACE_X, IDLER_FACE_X,
  ENDCAP_BASE_L, ENDCAP_WALL_T,
  CAM_Z_BOTTOM, CAM_Z_TOP, CAM_END_Y,
  CARRIAGE_Z_BOTTOM, CARRIAGE_LENGTH, CARRIAGE_THICKNESS,
  CHASSIS_TOP_Z,
  PULLEY_DIAMETER, PULLEY_WIDTH, BELT_THICKNESS, BELT_WIDTH,
  C_RAIL, C_NEEDLE, C_MOTOR, C_PULLEY, C_BELT, C_CARRIAGE,
} from "./constants";
import { makeNeedle } from "./needle.shape";
import { makeNeedleBed } from "./needle-bed.shape";
import { makeCamPlate } from "./cam-plate.shape";
import { makeCarriage } from "./carriage.shape";
import { makeRail } from "./rail.shape";
import { makeSolenoidBracket, makeSolenoidBody, makeSolenoidPlunger } from "./solenoid-bank.shape";
import { makeEndCapMotor } from "./end-cap-motor.shape";
import { makeEndCapIdler } from "./end-cap-idler.shape";
import { makeChassis } from "./base-chassis.shape";
import { makeYarnCarrier } from "./yarn-carrier.shape";
import {
  SOL_BODY_DIAMETER, SOL_BODY_LENGTH,
  SOL_PLUNGER_DIAMETER, SOL_PLUNGER_LENGTH,
  SOL_BANK_TOP_Z, SOL_BANK_BRACKET_T,
  C_SOLENOID, C_SOL_BRACKET,
} from "./constants";

// Carriage parked at X = +18 (not at centre — makes cam engagement visible in
// the render; real machine travels the full rail span).
const CARRIAGE_X = 18;

type Part = { shape: Shape3D; name: string; color: string };

export default function main(): Part[] {
  const parts: Part[] = [];

  // 1. Chassis (root)
  parts.push({ shape: makeChassis(), name: "chassis", color: "#8c9196" });

  // 2. Needle bed, centred on origin.
  parts.push({ shape: makeNeedleBed(), name: "needle-bed", color: "#c2a878" });

  // 3. 20 needles — translate per-slot, aligned so the needle's Y-length
  // straddles Y=0 and butts sit at Y = NEEDLE_REST_Y.
  const needleTranslateY = NEEDLE_REST_Y - NEEDLE_LENGTH / 2;
  for (let i = 0; i < N_NEEDLES; i++) {
    const x = FIRST_NEEDLE_X + i * NEEDLE_PITCH;
    parts.push({
      shape: makeNeedle().translate(x, needleTranslateY, 0),
      name: `needle-${i}`, color: C_NEEDLE,
    });
  }

  // 4. Solenoid bank (bracket + 20 bodies + 20 plungers).
  parts.push({ shape: makeSolenoidBracket(), name: "sol-bracket", color: C_SOL_BRACKET });
  const solBodyTopZ = SOL_BANK_TOP_Z - SOL_BANK_BRACKET_T;
  for (let i = 0; i < N_NEEDLES; i++) {
    const x = FIRST_NEEDLE_X + i * NEEDLE_PITCH;
    parts.push({
      shape: makeSolenoidBody().translate(x, 0, solBodyTopZ),
      name: `sol-body-${i}`, color: C_SOLENOID,
    });
    parts.push({
      shape: makeSolenoidPlunger().translate(x, 0, solBodyTopZ),
      name: `sol-plunger-${i}`, color: C_SOLENOID,
    });
  }

  // 5. End caps. Each part's wall sits at local wallXMid (±12.5). Translate
  // the whole cap so its wall lands on MOTOR_FACE_X / IDLER_FACE_X.
  const wallLocalX_motor = -ENDCAP_BASE_L / 2 + ENDCAP_WALL_T / 2;   // -12.5
  const wallLocalX_idler =  ENDCAP_BASE_L / 2 - ENDCAP_WALL_T / 2;   // +12.5
  parts.push({
    shape: makeEndCapMotor().translate(MOTOR_FACE_X - wallLocalX_motor, 0, 0),
    name: "end-cap-motor", color: "#6d7178",
  });
  parts.push({
    shape: makeEndCapIdler().translate(IDLER_FACE_X - wallLocalX_idler, 0, 0),
    name: "end-cap-idler", color: "#6d7178",
  });

  // 6. Two rails, centred between the end caps.
  const railStartX = -RAIL_LENGTH / 2;   // -110: rail extends -110 to +110
  for (const [yRail, name] of [[RAIL_Y_FRONT, "rail-front"], [RAIL_Y_BACK, "rail-back"]] as const) {
    parts.push({
      shape: makeRail().translate(railStartX, yRail, RAIL_Z),  // cylinder axis sits at local Z=0; translate by RAIL_Z lands it on world Z=RAIL_Z
      name, color: C_RAIL,
    });
  }

  // 7. Carriage — parked along X at CARRIAGE_X.
  parts.push({
    shape: makeCarriage().translate(CARRIAGE_X, 0, 0),
    name: "carriage", color: C_CARRIAGE,
  });

  // 8. Cam plate — same X as carriage; shift Y so the chevron groove ends land
  // on the needle butts' rest Y (NEEDLE_REST_Y).
  const camShiftY = NEEDLE_REST_Y - CAM_END_Y;  // shift so CAM_END_Y maps to NEEDLE_REST_Y
  parts.push({
    shape: makeCamPlate().translate(CARRIAGE_X, camShiftY, 0),
    name: "cam-plate", color: "#b85a3c",
  });

  // 9. Cam mount — a small bridging block connecting the cam plate top to the
  // carriage underside. Just makes the visual look mechanically plausible.
  const mountZ0 = CAM_Z_TOP;
  const mountZ1 = CARRIAGE_Z_BOTTOM;
  const mountBlock = makeBox(
    [CARRIAGE_X - 20, -4, mountZ0],
    [CARRIAGE_X + 20,  4, mountZ1],
  );
  parts.push({ shape: mountBlock, name: "cam-mount", color: "#b85a3c" });

  // 10. Yarn carrier — rides with the carriage. Vertical arm hangs off the
  // carriage's +X face (armW/2 = 6 mm clearance); horizontal arm reaches +Y
  // over the needle hooks, ≈ 7 mm above the bed top.
  const yarnArmW = 12;
  parts.push({
    shape: makeYarnCarrier().translate(
      CARRIAGE_X + CARRIAGE_LENGTH / 2 + yarnArmW / 2,
      10,
      CARRIAGE_Z_BOTTOM + CARRIAGE_THICKNESS,
    ),
    name: "yarn-carrier", color: "#e0b05a",
  });

  // 11. NEMA17 body — bolted to motor end-cap on its -X face.
  const motorBody = makeBox(
    [MOTOR_FACE_X - ENDCAP_WALL_T / 2 - 40, -21, RAIL_Z - 21],
    [MOTOR_FACE_X - ENDCAP_WALL_T / 2,      21, RAIL_Z + 21],
  );
  parts.push({ shape: motorBody, name: "motor", color: C_MOTOR });

  // 12. Motor pulley (GT2 20T) on motor shaft, protruding into +X past the wall.
  const motorPulley = makeCylinder(
    PULLEY_DIAMETER / 2, PULLEY_WIDTH,
    [MOTOR_FACE_X + ENDCAP_WALL_T / 2 + 1, 0, RAIL_Z],
    [1, 0, 0],
  );
  parts.push({ shape: motorPulley, name: "pulley-motor", color: C_PULLEY });

  // 13. Idler pulley (same size) on idler shaft, protruding -X from idler wall.
  const idlerPulley = makeCylinder(
    PULLEY_DIAMETER / 2, PULLEY_WIDTH,
    [IDLER_FACE_X - ENDCAP_WALL_T / 2 - 1 - PULLEY_WIDTH, 0, RAIL_Z],
    [1, 0, 0],
  );
  parts.push({ shape: idlerPulley, name: "pulley-idler", color: C_PULLEY });

  // 14. Belt — two partial runs from each pulley up to the carriage's nearest
  // face (the carriage IS the belt clamp). Skipping the other half of each
  // loop keeps the render free of belt-through-carriage overlap.
  const beltYOff = PULLEY_DIAMETER / 2 + BELT_THICKNESS / 2;
  const beltZmid = RAIL_Z + beltYOff;  // show only the top run
  const carriageXMin = CARRIAGE_X - CARRIAGE_LENGTH / 2;
  const carriageXMax = CARRIAGE_X + CARRIAGE_LENGTH / 2;
  const beltLeft = makeBox(
    [MOTOR_FACE_X + ENDCAP_WALL_T / 2 + PULLEY_WIDTH / 2, -BELT_WIDTH / 2, beltZmid - BELT_THICKNESS / 2],
    [carriageXMin,                                          BELT_WIDTH / 2, beltZmid + BELT_THICKNESS / 2],
  );
  const beltRight = makeBox(
    [carriageXMax,                                          -BELT_WIDTH / 2, beltZmid - BELT_THICKNESS / 2],
    [IDLER_FACE_X - ENDCAP_WALL_T / 2 - PULLEY_WIDTH / 2,    BELT_WIDTH / 2, beltZmid + BELT_THICKNESS / 2],
  );
  parts.push({ shape: beltLeft as unknown as Shape3D, name: "belt-left", color: C_BELT });
  parts.push({ shape: beltRight as unknown as Shape3D, name: "belt-right", color: C_BELT });

  return parts;
}
