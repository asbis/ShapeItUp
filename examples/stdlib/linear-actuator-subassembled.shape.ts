/**
 * Same linear-actuator as `linear-actuator.shape.ts`, but built as
 * composed SUBASSEMBLIES:
 *
 *   driveHead    = motorCap + motor + coupler + leadscrew  (one module)
 *   bearingBlock = bearingCap + bearing                     (one module)
 *
 * The top-level assembly then stacks `driveHead`, `extrusion`, and
 * `bearingBlock` via the promoted joints on each subassembly. The same
 * 7 physical parts come out — but the top-level mate graph shrinks from
 * 6 mates to 2, and each subassembly is independently reusable.
 *
 * Compare with the flat version — the subassembly one is easier to
 * refactor (e.g. swap NEMA 17 for NEMA 23 by changing ONE line in
 * `makeDriveHead`, nothing downstream cares).
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
  shaftAt,
  shape3d,
  standards,
  subassembly,
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

function makeMotorCap() {
  let s = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R).sketchOnPlane("XY").extrude(CAP_THICKNESS)
  );
  s = s.cut(cylinder({ bottom: [0, 0, -0.1], length: CAP_THICKNESS + 0.2, diameter: standards.NEMA17.pilotDia }));
  s = patterns.cutAt(
    s,
    () =>
      holes.counterbore(standards.NEMA17.mountScrew, { plateThickness: CAP_THICKNESS }).translate(0, 0, CAP_THICKNESS),
    patterns.grid(2, 2, standards.NEMA17.boltPitch, standards.NEMA17.boltPitch)
  );
  s = cutCornerHoles(s);
  return part({
    shape: s,
    name: "motor-cap",
    color: "#8899aa",
    joints: {
      extrusionFace: faceAt(0, { axis: "-Z" }),
      motorFace:     faceAt(CAP_THICKNESS),
    },
  });
}

function makeBearingCap() {
  let s = shape3d(
    drawRoundedRectangle(CAP_SIZE, CAP_SIZE, CAP_CORNER_R).sketchOnPlane("XY").extrude(CAP_THICKNESS)
  );
  s = s.cut(fromBack(bearings.seat(BEARING)).translate(0, 0, 0));
  s = cutCornerHoles(s);
  return part({
    shape: s,
    name: "bearing-cap",
    color: "#8899aa",
    joints: {
      extrusionFace: faceAt(CAP_THICKNESS),
      pocketMouth:   faceAt(0, { axis: "-Z" }),
    },
  });
}

// ── Subassembly factories — each returns a Part with a single promoted joint
//    that the caller mates into the next level up. ────────────────────────

function makeDriveHead() {
  const motorCap = makeMotorCap();
  const motor = motors.nema17();
  const coupler = couplers.flexible();
  const leadscrew = part({
    shape: cylinder({ bottom: [0, 0, 0], length: LEADSCREW_LENGTH, diameter: LEADSCREW_DIA }),
    name: "leadscrew",
    color: "#c0c4c8",
    joints: { bottom: shaftAt(0, LEADSCREW_DIA, { axis: "-Z" }) },
  });

  return subassembly({
    parts: [motorCap, motor, coupler, leadscrew],
    mates: [
      mate(motorCap.joints.motorFace,   motor.joints.mountFace),
      mate(motor.joints.shaftTip,       coupler.joints.motorEnd),
      mate(coupler.joints.leadscrewEnd, leadscrew.joints.bottom, { gap: EPS_FIT }),
    ],
    name: "drive-head",
    // The ONE joint the drive head exposes: the face that bolts onto the
    // extrusion. motorCap is the root, so motorCap.joints.extrusionFace is
    // the natural interface (axis "-Z", at the bottom of the cap).
    promote: { extrusionFace: motorCap.joints.extrusionFace },
  });
}

function makeBearingBlock() {
  const bearingCap = makeBearingCap();
  const bearing = part({
    shape: bearings.body(BEARING),
    name: "bearing",
    color: "#6b7280",
    joints: { pocketSeat: faceAt(BEARING_WIDTH, { axis: "+Z" }) },
  });

  return subassembly({
    parts: [bearingCap, bearing],
    mates: [
      mate(bearingCap.joints.pocketMouth, bearing.joints.pocketSeat, { gap: -BEARING_WIDTH }),
    ],
    name: "bearing-block",
    promote: { extrusionFace: bearingCap.joints.extrusionFace },
  });
}

export default function main() {
  const extrusion = part({
    shape: extrusions.tSlot(EXTRUSION, EXTRUSION_LENGTH),
    name: "extrusion",
    color: "#b3b9be",
    joints: {
      topFace:    faceAt(EXTRUSION_LENGTH),
      bottomFace: faceAt(0, { axis: "-Z" }),
    },
  });

  const driveHead    = makeDriveHead();
  const bearingBlock = makeBearingBlock();

  // Top-level mate graph: 2 mates instead of 6. Each subassembly is a
  // black box with one joint exposed.
  const positioned = assemble(
    [extrusion, driveHead, bearingBlock],
    [
      mate(extrusion.joints.topFace,    driveHead.joints.extrusionFace),
      mate(extrusion.joints.bottomFace, bearingBlock.joints.extrusionFace),
    ]
  );

  // `entries()` automatically flattens subassemblies — all 7 physical parts
  // come out with their individual colors and names.
  return entries(positioned);
}
