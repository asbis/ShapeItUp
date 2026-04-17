/**
 * NEMA 17 stepper + flexible shaft coupler + 8mm leadscrew assembly.
 *
 * Demonstrates a multi-part mechanical stack where four bodies must share a
 * single axis (+Z) and mate face-to-face without gaps or interference. The
 * motor mount plate uses `patterns.grid` + `holes.counterbore` for the NEMA 17
 * bolt pattern; the coupler is a revolved profile with two different bores.
 *
 *   +Z  ─── leadscrew (150 mm × Ø8, pressed into coupler top)
 *           coupler    (25 mm × Ø20, Ø5 bore below, Ø8 bore above)
 *           mount plate (70×70×5, NEMA 17 31 mm bolt pattern)
 *           motor shaft (24 mm × Ø5, exiting top of motor body)
 *   0  ─── motor body  (42×42×40)
 */

import { drawRectangle, drawRoundedRectangle, makeCylinder, type Shape3D } from "replicad";
import { holes, patterns, shape3d } from "shapeitup";

// ── NEMA 17 stepper reference dimensions ──────────────────────────────────
// Body is a square prism; shaft is a 5 mm D-shaft (we model it as a plain
// cylinder — the flat is cosmetic and complicates the coupler bore).
const MOTOR_BODY = 42;          // 42×42 mm face
const MOTOR_HEIGHT = 40;        // body depth along Z
const MOTOR_SHAFT_DIA = 5;      // D-shaft nominal diameter
const MOTOR_SHAFT_LENGTH = 24;  // exposed shaft length above body top face
const MOTOR_BOLT_PITCH = 31;    // 31 mm square bolt pattern
const MOTOR_PILOT_DIA = 22;     // raised pilot boss clearance on mount plate

// ── Flexible shaft coupler ────────────────────────────────────────────────
const COUPLER_OD = 20;
const COUPLER_LENGTH = 25;
const COUPLER_BORE_MOTOR = 5;     // matches motor shaft
const COUPLER_BORE_LEADSCREW = 8; // matches leadscrew

// ── Leadscrew ─────────────────────────────────────────────────────────────
const LEADSCREW_DIA = 8;
const LEADSCREW_LENGTH = 150;

// ── Mount plate ───────────────────────────────────────────────────────────
const PLATE_SIZE = 70;
const PLATE_THICKNESS = 5;
const PLATE_CORNER_R = 4;
const MOUNT_SCREW = "M3";

// ── Mate gaps (small visual separation to make touching faces readable) ──
const EPS_FIT = 0.2;

export default function main() {
  // Motor body: a 42×42×40 prism resting on the XY plane so its top face lies
  // at Z = MOTOR_HEIGHT. Axis of the output shaft is world Z.
  const motorBody = shape3d(
    drawRectangle(MOTOR_BODY, MOTOR_BODY).sketchOnPlane("XY").extrude(MOTOR_HEIGHT)
  );

  // Output shaft — exits the TOP face of the motor and extends +Z.
  //   base = MOTOR_HEIGHT, length = MOTOR_SHAFT_LENGTH.
  const motorShaft = makeCylinder(
    MOTOR_SHAFT_DIA / 2,
    MOTOR_SHAFT_LENGTH,
    [0, 0, MOTOR_HEIGHT],
    [0, 0, 1]
  );
  const motor = motorBody.fuse(motorShaft);

  // ── Mount plate ─────────────────────────────────────────────────────────
  // The plate sits flush with the top of the motor body (bottom face at
  // Z = MOTOR_HEIGHT, top at Z = MOTOR_HEIGHT + PLATE_THICKNESS).
  const plateBottomZ = MOTOR_HEIGHT;
  const plateTopZ = plateBottomZ + PLATE_THICKNESS;

  let plate = shape3d(
    drawRoundedRectangle(PLATE_SIZE, PLATE_SIZE, PLATE_CORNER_R)
      .sketchOnPlane("XY", [0, 0, plateBottomZ])
      .extrude(PLATE_THICKNESS)
  );

  // Central pilot clearance (shaft passes through here). Cut through the
  // plate entirely; top of the tool at the top face of the plate.
  const pilotHole = makeCylinder(
    MOTOR_PILOT_DIA / 2,
    PLATE_THICKNESS + 0.2,
    [0, 0, plateBottomZ - 0.1],
    [0, 0, 1]
  );
  plate = plate.cut(pilotHole);

  // 4× M3 counterbored holes on the 31 mm NEMA 17 bolt pattern. The cut tool
  // convention is top-at-Z=0 extending into -Z, so translate each copy up by
  // `plateTopZ` before cutting.
  plate = patterns.cutAt(
    plate,
    () =>
      holes
        .counterbore(MOUNT_SCREW, { plateThickness: PLATE_THICKNESS })
        .translate(0, 0, plateTopZ),
    patterns.grid(2, 2, MOTOR_BOLT_PITCH, MOTOR_BOLT_PITCH)
  );

  // ── Coupler ─────────────────────────────────────────────────────────────
  // Bottom face of the coupler sits EPS_FIT above the top of the mount plate
  // (the coupler clamps on the motor shaft, so it must clear the plate). It
  // extends +Z to bottomZ + COUPLER_LENGTH.
  const couplerBottomZ = plateTopZ + EPS_FIT;
  const couplerTopZ = couplerBottomZ + COUPLER_LENGTH;

  const couplerOuter = makeCylinder(
    COUPLER_OD / 2,
    COUPLER_LENGTH,
    [0, 0, couplerBottomZ],
    [0, 0, 1]
  );

  // Two bores, each half the coupler length. Lower bore (motor side) is Ø5
  // and runs from couplerBottomZ up to the midplane; upper bore (leadscrew
  // side) is Ø8 from the midplane up to the top. Small overlap into the
  // outer ends for a clean boolean.
  const midZ = couplerBottomZ + COUPLER_LENGTH / 2;
  const motorBore = makeCylinder(
    COUPLER_BORE_MOTOR / 2 + 0.05,
    COUPLER_LENGTH / 2 + 0.1,
    [0, 0, couplerBottomZ - 0.05],
    [0, 0, 1]
  );
  const leadscrewBore = makeCylinder(
    COUPLER_BORE_LEADSCREW / 2 + 0.05,
    COUPLER_LENGTH / 2 + 0.1,
    [0, 0, midZ],
    [0, 0, 1]
  );
  const coupler = couplerOuter.cut(motorBore).cut(leadscrewBore);

  // ── Leadscrew ───────────────────────────────────────────────────────────
  // Bottom of the leadscrew sits EPS_FIT above the top of the coupler.
  const leadscrewBottomZ = couplerTopZ + EPS_FIT;
  const leadscrew = makeCylinder(
    LEADSCREW_DIA / 2,
    LEADSCREW_LENGTH,
    [0, 0, leadscrewBottomZ],
    [0, 0, 1]
  );

  return [
    { shape: motor, name: "motor", color: "#2b2b2b" },
    { shape: plate, name: "mount-plate", color: "#8899aa" },
    { shape: coupler, name: "coupler", color: "#b5651d" },
    { shape: leadscrew, name: "leadscrew", color: "#c0c4c8" },
  ];
}
