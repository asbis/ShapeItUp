/**
 * Linear-actuator module — 2020 extrusion + NEMA 17 motor + leadscrew +
 * 608 bearing, bolted end-to-end via two 42×42×6 end-caps. Modelled as a
 * scaled-down z-axis for a small 3D printer.
 *
 *   +Z  ─── motor shaft (24 mm × Ø5)
 *           motor body (42×42×40)
 *           motor end-cap (42×42×6, NEMA17 bolt pattern + M5 corner bolts + 22mm pilot)
 *           ┌─────────┐
 *           │         │
 *           │ 2020    │← 200mm
 *           │ extr.   │     (leadscrew threads through the center)
 *           │         │
 *           └─────────┘
 *           bearing end-cap (42×42×6, 608 pocket + M5 corner bolts)
 *   -Z  ─── 608 bearing (seated in bottom cap)
 *
 * Coupler joins the motor shaft to the 8mm leadscrew just above the motor
 * end-cap, same geometry as `leadscrew-assembly.shape.ts`.
 */

import { drawRectangle, drawRoundedRectangle, type Shape3D } from "replicad";
import {
  assemble,
  bearings,
  boreAt,
  cylinder,
  entries,
  extrusions,
  faceAt,
  fromBack,
  holes,
  mate,
  part,
  patterns,
  shaftAt,
  shape3d,
} from "shapeitup";

// ── Extrusion ────────────────────────────────────────────────────────────
const EXTRUSION_PROFILE = "2020";
const EXTRUSION_SIZE = 20;
const EXTRUSION_LENGTH = 200;

// ── End-cap plates (shared dims) ────────────────────────────────────────
const CAP_SIZE = 42;
const CAP_THICKNESS = 6;
const CAP_CORNER_R = 3;
const CAP_CORNER_INSET = 4;
const CAP_CORNER_SCREW = "M5";

// ── NEMA 17 stepper ──────────────────────────────────────────────────────
const MOTOR_BODY = 42;
const MOTOR_HEIGHT = 40;
const MOTOR_SHAFT_DIA = 5;
const MOTOR_SHAFT_LENGTH = 24;
const MOTOR_BOLT_PITCH = 31;
const MOTOR_PILOT_DIA = 22;
const MOTOR_MOUNT_SCREW = "M3";

// ── Coupler ──────────────────────────────────────────────────────────────
const COUPLER_OD = 20;
const COUPLER_LENGTH = 25;
const COUPLER_BORE_MOTOR = 5;
const COUPLER_BORE_LEADSCREW = 8;
const COUPLER_MOTOR_BORE_DEPTH = COUPLER_LENGTH / 2;

// ── Leadscrew ────────────────────────────────────────────────────────────
const LEADSCREW_DIA = 8;
const LEADSCREW_LENGTH = 150;

// ── Bearing ──────────────────────────────────────────────────────────────
const BEARING_DESIGNATION = "608";
const BEARING_OD = 22;
const BEARING_WIDTH = 7;

const EPS_FIT = 0.2;

// ── Helpers ──────────────────────────────────────────────────────────────

/** M5 corner-bolt placements on a CAP_SIZE × CAP_SIZE plate, inset by CAP_CORNER_INSET. */
const CORNER_PITCH = CAP_SIZE - 2 * CAP_CORNER_INSET;

function cornerPlacements() {
  return patterns.grid(2, 2, CORNER_PITCH, CORNER_PITCH);
}

/** Drill M5 corner through-holes + translate the tool to plate top (cuts down). */
function cutCornerHoles(plate: Shape3D): Shape3D {
  return patterns.cutAt(
    plate,
    () =>
      holes
        .through(CAP_CORNER_SCREW, { depth: CAP_THICKNESS + 1 })
        .translate(0, 0, CAP_THICKNESS + 0.5),
    cornerPlacements()
  );
}

export default function main() {
  // ── Extrusion — axis +Z, Z ∈ [0, EXTRUSION_LENGTH] ──────────────────────
  const extrusion = part({
    shape: extrusions.tSlot(EXTRUSION_PROFILE, EXTRUSION_LENGTH),
    name: "extrusion",
    color: "#b3b9be",
    joints: {
      topFace:    faceAt(EXTRUSION_LENGTH),               // +Z face, outward +Z
      bottomFace: faceAt(0, { axis: "-Z" }),              // bottom face, outward -Z
    },
  });

  // ── Motor end-cap — 42×42×6, Z ∈ [0, CAP_THICKNESS] ─────────────────────
  // Built so its BOTTOM face mates to the extrusion top. Motor sits on the
  // cap's TOP face with its mounting holes on the NEMA17 31mm pattern.
  let motorCapShape = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R)
      .sketchOnPlane("XY")
      .extrude(CAP_THICKNESS)
  );
  // Central 22mm pilot-boss clearance hole (through).
  motorCapShape = motorCapShape.cut(
    cylinder({
      bottom: [0, 0, -0.1],
      length: CAP_THICKNESS + 0.2,
      diameter: MOTOR_PILOT_DIA,
    })
  );
  // NEMA17 bolt pattern — 4× M3 counterbored, heads on the TOP face (motor side).
  motorCapShape = patterns.cutAt(
    motorCapShape,
    () =>
      holes
        .counterbore(MOTOR_MOUNT_SCREW, { plateThickness: CAP_THICKNESS })
        .translate(0, 0, CAP_THICKNESS),
    patterns.grid(2, 2, MOTOR_BOLT_PITCH, MOTOR_BOLT_PITCH)
  );
  // 4× M5 corner through-holes (bolts cap to the extrusion end).
  motorCapShape = cutCornerHoles(motorCapShape);

  const motorCap = part({
    shape: motorCapShape,
    name: "motor-cap",
    color: "#8899aa",
    joints: {
      // Bottom face bolts to extrusion top — outward axis -Z.
      extrusionFace: faceAt(0, { axis: "-Z" }),
      // Top face is where the motor bolts on — outward +Z.
      motorFace:     faceAt(CAP_THICKNESS),
    },
  });

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
      // Bottom face bolts DOWN onto the motor cap's top face.
      mountFace: faceAt(0, { axis: "-Z" }),
      // Shaft tip points +Z, exits at Z=MOTOR_HEIGHT+SHAFT_LENGTH.
      shaftTip:  shaftAt(MOTOR_HEIGHT + MOTOR_SHAFT_LENGTH, MOTOR_SHAFT_DIA),
    },
  });

  // ── Coupler — Z ∈ [0, COUPLER_LENGTH], Ø20 with two bores ───────────────
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
      // motorEnd bore opens downward (-Z); place joint at the bore BOTTOM so
      // the motor shaft tip lands against it (shaft fills the full bore depth).
      motorEnd:     boreAt(COUPLER_MOTOR_BORE_DEPTH, COUPLER_BORE_MOTOR),
      leadscrewEnd: boreAt(COUPLER_LENGTH, COUPLER_BORE_LEADSCREW, { axis: "+Z" }),
    },
  });

  // ── Leadscrew — 150 mm × Ø8, built along +Z ─────────────────────────────
  const leadscrew = part({
    shape: cylinder({
      bottom: [0, 0, 0],
      length: LEADSCREW_LENGTH,
      diameter: LEADSCREW_DIA,
    }),
    name: "leadscrew",
    color: "#c0c4c8",
    joints: {
      // Top tip mates into the coupler's leadscrew-side bore (axis +Z out).
      top:    shaftAt(LEADSCREW_LENGTH, LEADSCREW_DIA),
      // Bottom tip points -Z.
      bottom: shaftAt(0, LEADSCREW_DIA, { axis: "-Z" }),
    },
  });

  // ── Bearing end-cap — 42×42×6 with a 608 pocket on its BOTTOM face ──────
  // The pocket opens on the outside (world-facing) face so the bearing is
  // press-fit from below. fromBack() flips the seat cut-tool so its pocket
  // opens into +Z from Z=0 — combined with translate(0, 0, 0) this cuts the
  // pocket into the bottom of the plate.
  let bearingCapShape = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R)
      .sketchOnPlane("XY")
      .extrude(CAP_THICKNESS)
  );
  bearingCapShape = bearingCapShape.cut(
    fromBack(bearings.seat(BEARING_DESIGNATION)).translate(0, 0, 0)
  );
  bearingCapShape = cutCornerHoles(bearingCapShape);

  const bearingCap = part({
    shape: bearingCapShape,
    name: "bearing-cap",
    color: "#8899aa",
    joints: {
      // Top face bolts UP onto the extrusion's bottom end — outward +Z.
      extrusionFace: faceAt(CAP_THICKNESS),
      // Pocket opens on the BOTTOM face (local z=0). Outward axis -Z.
      pocketMouth: faceAt(0, { axis: "-Z" }),
    },
  });

  // ── 608 bearing body — Ø22 × 7, built at origin along +Z ────────────────
  // Pocket opens on the cap's BOTTOM face (-Z). The bearing enters the
  // pocket from below, so its TOP (z=BEARING_WIDTH) is what seats against
  // the pocket's back wall. Axis on pocketSeat is +Z (outward from bearing
  // top) — mates anti-parallel with the cap's -Z mouth.
  const bearing = part({
    shape: bearings.body(BEARING_DESIGNATION),
    name: "bearing",
    color: "#6b7280",
    joints: {
      pocketSeat: faceAt(BEARING_WIDTH, { axis: "+Z" }),
    },
  });

  // ── Assembly ────────────────────────────────────────────────────────────
  //
  // Mate graph rooted at the extrusion. Two end-caps attach to the
  // extrusion's top/bottom faces, the motor bolts onto the motor-cap, the
  // coupler threads onto the motor shaft, the leadscrew screws into the
  // coupler, and the bearing nests INSIDE the bearing-cap's pocket via an
  // INSERTION mate (negative gap).
  const positioned = assemble(
    [extrusion, motorCap, motor, coupler, leadscrew, bearingCap, bearing],
    [
      mate(extrusion.joints.topFace,    motorCap.joints.extrusionFace),
      mate(motorCap.joints.motorFace,   motor.joints.mountFace),
      mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
      mate(coupler.joints.leadscrewEnd, leadscrew.joints.top, { gap: EPS_FIT }),
      mate(extrusion.joints.bottomFace, bearingCap.joints.extrusionFace),
      // Insertion mate: negative gap pulls the bearing INTO the cap's pocket
      // by its own width, so the bearing body overlaps with the (already-cut)
      // pocket cavity instead of sitting below it.
      mate(bearingCap.joints.pocketMouth, bearing.joints.pocketSeat, {
        gap: -BEARING_WIDTH,
      }),
    ]
  );

  return entries(positioned);
}
