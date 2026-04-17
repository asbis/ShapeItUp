/**
 * NEMA 17 stepper + flexible shaft coupler + 8mm leadscrew assembly.
 *
 * Every part is BUILT AT THE ORIGIN (its local frame) and declares named
 * joints describing where other parts connect. `assemble()` walks the mate
 * graph and positions each part in world space.
 *
 * Compare `leadscrew-assembly-v1-no-joints.shape.ts` for the pre-joints
 * approach — that version does the same thing via cascading bottom/top-Z
 * constants.
 *
 *   +Z  ─── leadscrew (150 mm × Ø8, mated onto coupler top)
 *           coupler    (25 mm × Ø20, Ø5 bore below, Ø8 bore above)
 *           mount plate (70×70×5, NEMA 17 bolt pattern)
 *           motor shaft (24 mm × Ø5, exits top of motor body)
 *   0  ─── motor body  (42×42×40)
 */

import { drawRectangle, drawRoundedRectangle } from "replicad";
import {
  assemble,
  boreAt,
  cylinder,
  entries,
  faceAt,
  holes,
  mate,
  part,
  patterns,
  shaftAt,
  shape3d,
} from "shapeitup";

// ── NEMA 17 stepper ──────────────────────────────────────────────────────
const MOTOR_BODY = 42;
const MOTOR_HEIGHT = 40;
const MOTOR_SHAFT_DIA = 5;
const MOTOR_SHAFT_LENGTH = 24;
const MOTOR_BOLT_PITCH = 31;
const MOTOR_PILOT_DIA = 22;

// ── Coupler ──────────────────────────────────────────────────────────────
const COUPLER_OD = 20;
const COUPLER_LENGTH = 25;
const COUPLER_BORE_MOTOR = 5;
const COUPLER_BORE_LEADSCREW = 8;
const COUPLER_MOTOR_BORE_DEPTH = COUPLER_LENGTH / 2;

// ── Leadscrew ────────────────────────────────────────────────────────────
const LEADSCREW_DIA = 8;
const LEADSCREW_LENGTH = 150;

// ── Mount plate ──────────────────────────────────────────────────────────
const PLATE_SIZE = 70;
const PLATE_THICKNESS = 5;
const PLATE_CORNER_R = 4;
const MOUNT_SCREW = "M3";

const EPS_FIT = 0.2;

export default function main() {
  // ── Motor — body + shaft built at origin ────────────────────────────────
  const motorBody = shape3d(
    drawRectangle(MOTOR_BODY, MOTOR_BODY).sketchOnPlane("XY").extrude(MOTOR_HEIGHT)
  );
  const motorShaft = cylinder({
    bottom: [0, 0, MOTOR_HEIGHT],
    length: MOTOR_SHAFT_LENGTH,
    diameter: MOTOR_SHAFT_DIA,
  });
  const motor = part({
    shape: motorBody.fuse(motorShaft),
    name: "motor",
    color: "#2b2b2b",
    joints: {
      mountFace: faceAt(MOTOR_HEIGHT),
      shaftTip:  shaftAt(MOTOR_HEIGHT + MOTOR_SHAFT_LENGTH, MOTOR_SHAFT_DIA),
    },
  });

  // ── Mount plate — built at origin, Z ∈ [0, PLATE_THICKNESS] ─────────────
  let plateShape = shape3d(
    drawRoundedRectangle(PLATE_SIZE, PLATE_SIZE, PLATE_CORNER_R)
      .sketchOnPlane("XY")
      .extrude(PLATE_THICKNESS)
  );
  plateShape = plateShape.cut(
    cylinder({
      bottom: [0, 0, -0.1],
      length: PLATE_THICKNESS + 0.2,
      diameter: MOTOR_PILOT_DIA,
    })
  );
  plateShape = patterns.cutAt(
    plateShape,
    () =>
      holes
        .counterbore(MOUNT_SCREW, { plateThickness: PLATE_THICKNESS })
        .translate(0, 0, PLATE_THICKNESS),
    patterns.grid(2, 2, MOTOR_BOLT_PITCH, MOTOR_BOLT_PITCH)
  );
  const plate = part({
    shape: plateShape,
    name: "mount-plate",
    color: "#8899aa",
    joints: {
      motorFace: faceAt(0, { axis: "-Z" }),
    },
  });

  // ── Coupler — built at origin, Z ∈ [0, COUPLER_LENGTH] ──────────────────
  // `motorEnd` sits at the BOTTOM of the motor-side bore so the shaft tip
  // lands there (shaft fills the full motor-bore depth).
  const couplerOuter = cylinder({
    bottom: [0, 0, 0],
    length: COUPLER_LENGTH,
    diameter: COUPLER_OD,
  });
  const motorBore = cylinder({
    bottom: [0, 0, -0.05],
    length: COUPLER_MOTOR_BORE_DEPTH + 0.1,
    diameter: COUPLER_BORE_MOTOR + 0.1,
  });
  const leadscrewBore = cylinder({
    bottom: [0, 0, COUPLER_MOTOR_BORE_DEPTH],
    length: COUPLER_LENGTH - COUPLER_MOTOR_BORE_DEPTH + 0.1,
    diameter: COUPLER_BORE_LEADSCREW + 0.1,
  });
  const coupler = part({
    shape: couplerOuter.cut(motorBore).cut(leadscrewBore),
    name: "coupler",
    color: "#b5651d",
    joints: {
      // Default axis for boreAt is -Z (opens downward). The motorEnd bore
      // accepts a shaft coming up from below, so the outward direction is -Z.
      motorEnd:     boreAt(COUPLER_MOTOR_BORE_DEPTH, COUPLER_BORE_MOTOR),
      // Leadscrew bore opens upward — override axis.
      leadscrewEnd: boreAt(COUPLER_LENGTH, COUPLER_BORE_LEADSCREW, { axis: "+Z" }),
    },
  });

  // ── Leadscrew ───────────────────────────────────────────────────────────
  const leadscrew = part({
    shape: cylinder({
      bottom: [0, 0, 0],
      length: LEADSCREW_LENGTH,
      diameter: LEADSCREW_DIA,
    }),
    name: "leadscrew",
    color: "#c0c4c8",
    joints: {
      bottom: shaftAt(0, LEADSCREW_DIA, { axis: "-Z" }),
    },
  });

  // ── Assembly ────────────────────────────────────────────────────────────
  const positioned = assemble(
    [motor, plate, coupler, leadscrew],
    [
      mate(motor.joints.mountFace, plate.joints.motorFace),
      mate(motor.joints.shaftTip, coupler.joints.motorEnd),
      mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: EPS_FIT }),
    ]
  );

  return entries(positioned);
}
