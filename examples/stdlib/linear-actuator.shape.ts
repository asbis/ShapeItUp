/**
 * Linear-actuator module — 2020 extrusion + NEMA 17 motor + leadscrew +
 * 608 idler bearing. Demonstrates the full Phase 2 stack: standard-part
 * builders (`motors.nema17`, `couplers.flexible`), patterns, the joints
 * API, and the insertion-mate convention for the bearing nested in a pocket.
 *
 *   +Z  ─── leadscrew (150 × Ø8)
 *           flexible coupler (Ø20 × 25)
 *           NEMA 17 motor (42 × 42 × 40, Ø5 × 24 shaft)
 *           motor-end cap (42 × 42 × 6 — plate on extrusion top)
 *           2020 extrusion (200 mm)
 *           bearing-end cap (42 × 42 × 6 — plate on extrusion bottom)
 *           608 bearing (Ø22 × 7, nested in cap pocket)
 *   0
 */

import { drawRoundedRectangle } from "replicad";
import {
  assemble,
  bearings,
  couplers,
  cylinder,
  entries,
  extrusions,
  faceAt,
  fromBack,
  holes,
  mate,
  motors,
  part,
  patterns,
  shape3d,
  standards,
} from "shapeitup";

const EXTRUSION = "2020";
const EXTRUSION_LENGTH = 200;

const CAP_SIZE = 42;
const CAP_THICKNESS = 6;
const CAP_CORNER_R = 3;
const CAP_CORNER_INSET = 4;
const CAP_CORNER_SCREW = "M5";

const BEARING = "608";
const BEARING_WIDTH = 7;

const LEADSCREW_DIA = 8;
const LEADSCREW_LENGTH = 150;

const EPS_FIT = 0.2;

// Helpers that both end-caps share.
function cutCornerHoles(plate: any) {
  const pitch = CAP_SIZE - 2 * CAP_CORNER_INSET;
  return patterns.cutAt(
    plate,
    () =>
      holes
        .counterbore(CAP_CORNER_SCREW, { plateThickness: CAP_THICKNESS })
        .translate(0, 0, CAP_THICKNESS),
    patterns.grid(2, 2, pitch, pitch)
  );
}

export default function main() {
  // ── Extrusion — root of the assembly, axis +Z ────────────────────────────
  const extrusion = part({
    shape: extrusions.tSlot(EXTRUSION, EXTRUSION_LENGTH),
    name: "extrusion",
    color: "#b3b9be",
    joints: {
      topFace:    faceAt(EXTRUSION_LENGTH),
      bottomFace: faceAt(0, { axis: "-Z" }),
    },
  });

  // ── Motor-end cap — pilot boss clearance + NEMA 17 bolt pattern ──────────
  let motorCapShape = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R).sketchOnPlane("XY").extrude(CAP_THICKNESS)
  );
  motorCapShape = motorCapShape.cut(
    cylinder({ bottom: [0, 0, -0.1], length: CAP_THICKNESS + 0.2, diameter: standards.NEMA17.pilotDia })
  );
  motorCapShape = patterns.cutAt(
    motorCapShape,
    () =>
      holes
        .counterbore(standards.NEMA17.mountScrew, { plateThickness: CAP_THICKNESS })
        .translate(0, 0, CAP_THICKNESS),
    patterns.grid(2, 2, standards.NEMA17.boltPitch, standards.NEMA17.boltPitch)
  );
  motorCapShape = cutCornerHoles(motorCapShape);
  const motorCap = part({
    shape: motorCapShape,
    name: "motor-cap",
    color: "#8899aa",
    joints: {
      extrusionFace: faceAt(0, { axis: "-Z" }),
      motorFace:     faceAt(CAP_THICKNESS),
    },
  });

  // ── Motor + coupler + leadscrew — standard parts ─────────────────────────
  const motor = motors.nema17();
  const coupler = couplers.flexible();
  const leadscrew = part({
    shape: cylinder({ bottom: [0, 0, 0], length: LEADSCREW_LENGTH, diameter: LEADSCREW_DIA }),
    name: "leadscrew",
    color: "#c0c4c8",
    joints: { bottom: faceAt(0, { axis: "-Z" }) },
  });

  // ── Bearing-end cap — 608 pocket on the BOTTOM face ──────────────────────
  let bearingCapShape = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R).sketchOnPlane("XY").extrude(CAP_THICKNESS)
  );
  bearingCapShape = bearingCapShape.cut(fromBack(bearings.seat(BEARING)).translate(0, 0, 0));
  bearingCapShape = cutCornerHoles(bearingCapShape);
  const bearingCap = part({
    shape: bearingCapShape,
    name: "bearing-cap",
    color: "#8899aa",
    joints: {
      extrusionFace: faceAt(CAP_THICKNESS),
      pocketMouth:   faceAt(0, { axis: "-Z" }),
    },
  });

  // ── 608 bearing body — axis +Z, top seats against pocket back wall ──────
  const bearing = part({
    shape: bearings.body(BEARING),
    name: "bearing",
    color: "#6b7280",
    joints: {
      pocketSeat: faceAt(BEARING_WIDTH, { axis: "+Z" }),
    },
  });

  // ── Assembly — every part at its local origin; mates resolve world pose ──
  const positioned = assemble(
    [extrusion, motorCap, motor, coupler, leadscrew, bearingCap, bearing],
    [
      mate(extrusion.joints.topFace,    motorCap.joints.extrusionFace),
      mate(motorCap.joints.motorFace,   motor.joints.mountFace),
      mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
      mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: EPS_FIT }),
      mate(extrusion.joints.bottomFace, bearingCap.joints.extrusionFace),
      // Insertion mate: negative gap pulls the bearing INTO the cap's pocket.
      mate(bearingCap.joints.pocketMouth, bearing.joints.pocketSeat, { gap: -BEARING_WIDTH }),
    ]
  );

  return entries(positioned);
}
