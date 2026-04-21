// Pinch valve driven by an SG90 hobby microservo.
// Tube (silicone, Ø7mm OD) is pinched against an anvil by an eccentric cam
// mounted on the servo shaft. Fully open: ~8.5mm gap. Fully pinched: 2.5mm gap.
//
// SG90 datasheet dimensions (TowerPro): 22.7 L x 12.1 W x 22.6 H mm body,
// 32.4 mm long mounting flange (4.85 each side, 2.4 thick) at Z=15.9 from base,
// shaft Ø5.4 offset 2.5mm from body center toward the upper-body end.
//
// Assembly (top-mount, no bottom cover):
//   1. Remove the lid (4 M3 screws).
//   2. Drop the servo into the base from above. Body slides down through the
//      flange-wide opening; flange catches on the body-wide ledge inside.
//      Wire routes out the side slot.
//   3. Press cam onto the spline shaft and secure with the OEM horn screw
//      through the cam's center bore.
//   4. Lay the silicone tube into the base groove.
//   5. Replace the lid; M3 screws thread directly into the printed plastic.
//      The lid clamps the tube AND its cam-clearance pocket leaves only
//      ~0.5mm of vertical play, so the cam can't rise out of the cavity.

import {
  drawRectangle, drawRoundedRectangle, sketchCircle, makeCylinder,
  type Shape3D,
} from "replicad";
import { holes, shape3d } from "shapeitup";

export const params = {
  // tube
  tubeOD: 7,
  tubePinchGap: 2.5,
  tubeChannelLength: 60,

  // SG90 servo (per user measurements: body 22.4 long, shaft 6.25mm from one
  // body end → shaft is offset 4.95mm from the body's geometric center)
  servoBodyL: 22.4,
  servoBodyW: 12.1,
  servoBodyH: 22.6,
  servoFlangeL: 32.4,
  servoFlangeT: 2.4,
  servoFlangeZ: 15.9,
  servoShaftDia: 4.76,       // measured spline diameter (was 5.4 — datasheet nominal)
  servoShaftAboveBody: 3.3,  // spline portion above the gear cap (per measurement)
  servoShaftYOffset: 4.95,   // shaft offset from body center along Y
  // SG90 has TWO concentric posts above the body: a Ø7 cylindrical "gear cap"
  // boss (about 5mm tall) at the bottom, then the smaller Ø4.76 splined output
  // shaft (about 3.3mm tall) on top. Total stack ~8.3mm above body.
  servoGearCapDia: 7.0,
  servoGearCapH: 5.0,
  servoScrewHeadDia: 7.0,    // OEM horn screw head — generous so any common size fits
  servoScrewHeadDepth: 2.5,  // recess depth at cam top for the screw head

  // cam (eccentric disc)
  camRBase: 13,
  camEccentricity: 3,
  camThickness: 10,
  camAngleDeg: 0, // 0 = pinched, 180 = open

  // print fits
  fitClearance: 0.4,
  shaftBoreClearance: 0.3,
  camTopGap: 0.5, // vertical play above the cam — keep small so cam can't rise

  // pinch zone — when the Ø7 tube is squashed to a 2.5mm gap it flattens
  // perpendicular to the squeeze. Estimated flat height ~9.4mm, so widen
  // the channel in Z (and a bit in Y on either side of the cam contact)
  // to give the tube room to balloon.
  pinchSlotZ: 10.5,        // total Z height of the channel inside the pinch zone
  pinchZoneHalfY: 12,      // half-length of the expanded section along the tube

  // structure
  // Negative baseFloorThickness sinks the servo BELOW the base bottom — the
  // lower 1.4mm of the body sticks through. Trades a flush-bottom appearance
  // for a 5.4mm shorter assembly: the cam ends up lower, so the lid fits
  // flush without needing a deeper cam-clearance pocket.
  baseFloorThickness: -1.4,
  lidThickness: 8,
};

export const material = "PLA";

export default function main(p: typeof params) {
  // ---- Z layout ----
  const SERVO_BOTTOM_Z = p.baseFloorThickness;
  const SERVO_FLANGE_BOTTOM_Z = SERVO_BOTTOM_Z + p.servoFlangeZ;
  const SERVO_FLANGE_TOP_Z = SERVO_FLANGE_BOTTOM_Z + p.servoFlangeT;
  const SERVO_TOP_Z = SERVO_BOTTOM_Z + p.servoBodyH;

  // Cam sits directly on the body top — the gear-cap pocket on the cam's
  // bottom face accommodates the Ø7 boss that surrounds the spline shaft.
  const CAM_BOTTOM_Z = SERVO_TOP_Z;
  const CAM_TOP_Z = CAM_BOTTOM_Z + p.camThickness;
  const TUBE_CENTER_Z = (CAM_BOTTOM_Z + CAM_TOP_Z) / 2;
  const BASE_TOP_Z = TUBE_CENTER_Z;

  // ---- X-Y layout ----
  const CAM_MAX_REACH = p.camRBase + p.camEccentricity; // 16
  const ANVIL_X = CAM_MAX_REACH + p.tubePinchGap;       // 18.5
  const TUBE_CENTER_X = ANVIL_X - p.tubeOD / 2;         // 15
  const CAM_POCKET_R = CAM_MAX_REACH + 1.0;             // 17

  const BASE_X_MIN = -20;
  const BASE_X_MAX = +30;
  const BASE_Y_HALF = 25;
  const BASE_X = BASE_X_MAX - BASE_X_MIN;
  const BASE_Y = BASE_Y_HALF * 2;
  const BASE_CX = (BASE_X_MIN + BASE_X_MAX) / 2;

  // 4 corner bolts — clear of the cam pocket (R=17 from origin) and tube
  const lidBoltPositions: [number, number][] = [
    [BASE_X_MIN + 5, -BASE_Y_HALF + 5],
    [BASE_X_MIN + 5, +BASE_Y_HALF - 5],
    [BASE_X_MAX - 5, -BASE_Y_HALF + 5],
    [BASE_X_MAX - 5, +BASE_Y_HALF - 5],
  ];

  // ---- BASE ----
  let base: Shape3D = shape3d(
    drawRoundedRectangle(BASE_X, BASE_Y, 4)
      .sketchOnPlane("XY", [BASE_CX, 0, 0])
      .extrude(BASE_TOP_Z),
  );

  // Lower body cavity — closed at the bottom (sits on the floor at Z=4).
  // The body rests on this floor, flange seats on the ledge at top of this cavity.
  const lowerBody = shape3d(
    drawRectangle(p.servoBodyW + 2 * p.fitClearance, p.servoBodyL + 2 * p.fitClearance)
      .sketchOnPlane("XY", [0, -p.servoShaftYOffset, 0])
      .extrude(SERVO_FLANGE_BOTTOM_Z - SERVO_BOTTOM_Z + 0.2),
  );
  base = base.cut(lowerBody.translate(0, 0, SERVO_BOTTOM_Z));

  // Cam swing pocket — round, R=17, opens up through the top so cam can rotate.
  // (Cam pocket alone won't pass the flange because the flange's -Y end at
  // Y=-18.9 is just outside the R=17 cam pocket — see the flange entry slot below.)
  const camSwing = shape3d(
    sketchCircle(CAM_POCKET_R)
      .extrude(BASE_TOP_Z - SERVO_FLANGE_BOTTOM_Z + 0.2),
  );
  base = base.cut(camSwing.translate(0, 0, SERVO_FLANGE_BOTTOM_Z));

  // Flange-entry slot — flange-wide rectangle from the top down to the flange
  // seat. Combined with the cam pocket, this is the path the servo takes when
  // dropped in from above. Below the flange seat the cavity narrows back to
  // body-wide, so the flange catches and can't fall through.
  const flangeEntry = shape3d(
    drawRectangle(p.servoBodyW + 2 * p.fitClearance, p.servoFlangeL + 2 * p.fitClearance)
      .sketchOnPlane("XY", [0, -p.servoShaftYOffset, 0])
      .extrude(BASE_TOP_Z - SERVO_FLANGE_BOTTOM_Z + 0.2),
  );
  base = base.cut(flangeEntry.translate(0, 0, SERVO_FLANGE_BOTTOM_Z));

  // Tube channel — horizontal cylinder along Y. The +X face of this cut is
  // the anvil (at X = ANVIL_X). The -X side opens into the cam pocket.
  const tubeChannel = makeCylinder(
    p.tubeOD / 2 + 0.2,
    p.tubeChannelLength + 4,
    [TUBE_CENTER_X, -p.tubeChannelLength / 2 - 2, TUBE_CENTER_Z],
    [0, 1, 0],
  );
  base = base.cut(tubeChannel);

  // Pinch-zone expansion: a rectangular slot centered on the tube, only
  // active around the cam contact area. Gives the tube vertical room to
  // balloon when squashed (~9.4mm of Z spread for a 2.5mm pinch gap).
  // Outside this zone the channel stays round so the tube is well-guided.
  // sketchOnPlane("XZ", [x, y, z]) — middle arg is WORLD Y (the plane's Y
  // position), the third is WORLD Z. Rectangle drawn here extends in world
  // X and world Z. To get the slot centered at the tube's height, the Z
  // coordinate goes in the THIRD slot, not the second.
  const pinchSlotBase = shape3d(
    drawRectangle(p.tubeOD + 0.4, p.pinchSlotZ)
      .sketchOnPlane("XZ", [TUBE_CENTER_X, 0, TUBE_CENTER_Z])
      .extrude(p.pinchZoneHalfY * 2)
      .translate(0, p.pinchZoneHalfY, 0),
  );
  base = base.cut(pinchSlotBase);

  // Wire exit slot through the +Y wall (cable side of the actual SG90).
  // Spans the full lower-body Z range so the cable boss clears the wall
  // cleanly. Cuts ~15mm in Y from the wall so the boss fits inside it
  // — boss is ~5mm long, plus room for the cable to bend.
  const wireSlotW = 7;
  const wireSlotH = SERVO_FLANGE_BOTTOM_Z - SERVO_BOTTOM_Z + 2;
  const wireSlot = shape3d(
    drawRectangle(wireSlotW, wireSlotH)
      .sketchOnPlane("XZ", [0, 0, SERVO_BOTTOM_Z + wireSlotH / 2 - 1])
      .extrude(20)
      .translate(0, BASE_Y_HALF, 0),
  );
  base = base.cut(wireSlot);

  // Tap-drill sized holes for the M4 lid bolts. M4 machine screws self-tap
  // into PLA on first install — gives a strong, repeatable thread without
  // the slicer headaches of modeled helical geometry, and keeps the base
  // as a B-Rep so STEP export works.
  for (const [x, y] of lidBoltPositions) {
    base = base.cut(holes.tapped("M4", { depth: 10 }).translate(x, y, BASE_TOP_Z));
  }

  // ---- CAM ----
  const eRad = (p.camAngleDeg * Math.PI) / 180;
  const eX = p.camEccentricity * Math.cos(eRad);
  const eY = p.camEccentricity * Math.sin(eRad);

  let cam: Shape3D = shape3d(
    sketchCircle(p.camRBase).extrude(p.camThickness),
  ).translate(eX, eY, 0);

  // Bottom relief pocket for the Ø7 gear cap (5mm tall boss)
  const gearCapPocket = makeCylinder(
    p.servoGearCapDia / 2 + 0.3,
    p.servoGearCapH + 0.4,
    [0, 0, -0.1],
    [0, 0, 1],
  );
  cam = cam.cut(gearCapPocket);

  // Spline bore — snug fit on the actual Ø4.76 shaft.
  // Spans from just inside the cap pocket up to the spline tip.
  const splineBore = makeCylinder(
    p.servoShaftDia / 2 + p.shaftBoreClearance,
    p.servoShaftAboveBody + 0.5,
    [0, 0, p.servoGearCapH - 0.3],
    [0, 0, 1],
  );
  cam = cam.cut(splineBore);

  // Top counterbore for the horn screw head (wider than the spline bore).
  const screwHeadBore = makeCylinder(
    p.servoScrewHeadDia / 2 + 0.4,
    p.servoScrewHeadDepth + 0.1,
    [0, 0, p.camThickness - p.servoScrewHeadDepth + 0.01],
    [0, 0, 1],
  );
  cam = cam.cut(screwHeadBore);

  cam = cam.translate(0, 0, CAM_BOTTOM_Z);

  // ---- LID ----
  // Lid covers the top, holds the tube, and limits how far the cam can rise
  // (so the servo can't be pulled up out of the base cavity once assembled).
  let lid: Shape3D = shape3d(
    drawRoundedRectangle(BASE_X, BASE_Y, 4)
      .sketchOnPlane("XY", [BASE_CX, 0, 0])
      .extrude(p.lidThickness),
  );

  const lidTubeGroove = makeCylinder(
    p.tubeOD / 2 + 0.2,
    p.tubeChannelLength + 4,
    [TUBE_CENTER_X, -p.tubeChannelLength / 2 - 2, 0],
    [0, 1, 0],
  );
  lid = lid.cut(lidTubeGroove);

  // Mirror the base's pinch-zone expansion in the lid so the tube has
  // matching upward room when squashed. Local lid Z=0 sits at world
  // Z=BASE_TOP_Z = TUBE_CENTER_Z, so the slot is centered on lid Z=0.
  const pinchSlotLid = shape3d(
    drawRectangle(p.tubeOD + 0.4, p.pinchSlotZ)
      .sketchOnPlane("XZ", [TUBE_CENTER_X, 0, 0])
      .extrude(p.pinchZoneHalfY * 2)
      .translate(0, p.pinchZoneHalfY, 0),
  );
  lid = lid.cut(pinchSlotLid);

  // Cam clearance pocket — only as deep as needed (cam top + small gap),
  // leaves a thin ceiling above the cam so the cam (and servo) can't rise.
  const lidCamClearDepth = (CAM_TOP_Z - BASE_TOP_Z) + p.camTopGap;
  const lidCamClearance = shape3d(
    sketchCircle(CAM_POCKET_R).extrude(lidCamClearDepth),
  );
  lid = lid.cut(lidCamClearance.translate(0, 0, -0.1));

  // Counterbored M4 holes through the lid: the screw HEAD recesses into the
  // top of the lid (socket-head cap screws sit flush), the shaft passes
  // through with clearance, and the threads engage in the base below.
  // (Real threads in the lid would defeat the clamping action — counterbore
  // is the right pattern for a bolted joint.)
  for (const [x, y] of lidBoltPositions) {
    lid = lid.cut(
      holes.counterbore("M4", { plateThickness: p.lidThickness })
        .translate(x, y, p.lidThickness),
    );
  }

  lid = lid.translate(0, 0, BASE_TOP_Z);

  // ---- VISUALIZATION: tube cylinder ----
  const tubeViz = makeCylinder(
    p.tubeOD / 2,
    p.tubeChannelLength,
    [TUBE_CENTER_X, -p.tubeChannelLength / 2, TUBE_CENTER_Z],
    [0, 1, 0],
  );

  // ---- VISUALIZATION: detailed SG90 servo ----
  // Built per the TowerPro datasheet so misalignments become visually
  // obvious in the assembly. Shaft (Ø5.4) sits at world origin (0, 0).
  // Body center is offset by -servoShaftYOffset in Y, so the shaft's offset
  // within the body lands the shaft on the cam axis.
  //
  // Important features (besides body+flange+shaft):
  //   - Gear cap: ~Ø7 cylindrical boss on top of the body around the shaft.
  //     Cam can't fit OVER this; it must sit ABOVE it.
  //   - Cable exit: rectangular boss off one short end of the body.
  const bodyCY = -p.servoShaftYOffset;
  const CABLE_BOSS_W = 4;
  const CABLE_BOSS_L = 5;
  const CABLE_BOSS_H = 4;

  const sg90LowerBody = shape3d(
    drawRectangle(p.servoBodyW, p.servoBodyL)
      .sketchOnPlane("XY", [0, bodyCY, 0])
      .extrude(p.servoFlangeZ),
  );
  const sg90Flange = shape3d(
    drawRectangle(p.servoBodyW, p.servoFlangeL)
      .sketchOnPlane("XY", [0, bodyCY, p.servoFlangeZ])
      .extrude(p.servoFlangeT),
  );
  const sg90UpperBody = shape3d(
    drawRectangle(p.servoBodyW, p.servoBodyL)
      .sketchOnPlane("XY", [0, bodyCY, p.servoFlangeZ + p.servoFlangeT])
      .extrude(p.servoBodyH - p.servoFlangeZ - p.servoFlangeT),
  );
  const sg90GearCap = makeCylinder(
    p.servoGearCapDia / 2,
    p.servoGearCapH,
    [0, 0, p.servoBodyH],
    [0, 0, 1],
  );
  // Spline shaft sits ON TOP of the gear cap, not concentric with it
  const sg90Shaft = makeCylinder(
    p.servoShaftDia / 2,
    p.servoShaftAboveBody,
    [0, 0, p.servoBodyH + p.servoGearCapH],
    [0, 0, 1],
  );
  // Cable boss exits from +Y end of the body (the cable side per real SG90)
  const cableY = bodyCY + p.servoBodyL / 2;
  const sg90Cable = shape3d(
    drawRectangle(CABLE_BOSS_W, CABLE_BOSS_L)
      .sketchOnPlane("XY", [0, cableY + CABLE_BOSS_L / 2, 1])
      .extrude(CABLE_BOSS_H),
  );

  let sg90 = sg90LowerBody
    .fuse(sg90Flange)
    .fuse(sg90UpperBody)
    .fuse(sg90GearCap)
    .fuse(sg90Shaft)
    .fuse(sg90Cable);
  sg90 = sg90.translate(0, 0, SERVO_BOTTOM_Z);

  return [
    { shape: base, name: "base", color: "#4a6c8a" },
    { shape: cam, name: "cam", color: "#aa6633" },
    { shape: lid, name: "lid", color: "#5e8e8a" },
    { shape: tubeViz, name: "tube", color: "#d6c878" },
    { shape: sg90, name: "sg90", color: "#2a2a2a" },
  ];
}
