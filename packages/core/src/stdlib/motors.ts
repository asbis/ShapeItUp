/**
 * Motor builders — pre-assembled NEMA stepper parts with joints ready to mate.
 *
 * Layout convention — motor body at local Z = [0, HEIGHT], shaft on TOP
 * extending Z = [HEIGHT, HEIGHT + SHAFT_LENGTH]. Mount face is at the
 * BOTTOM of the body.
 *
 *     shaftTip  ─── (0, 0, HEIGHT + SHAFT_LENGTH)   axis "+Z"
 *                ╷
 *                │  shaft (Ø spec.shaft)
 *                ╵
 *     (motor top face, Z = HEIGHT)
 *       ╔═══════════╗
 *       ║  body     ║
 *       ║  42×42    ║
 *       ╚═══════════╝
 *     mountFace ─── (0, 0, 0)   axis "-Z"
 *
 * This convention matches the common 3D-printer arrangement where a motor
 * sits ATOP a plate (cap / bracket) with its shaft extending upward. The
 * mount face's axis points -Z because the mating partner (the plate) sits
 * BELOW the motor — axes become anti-parallel in the mate, no rotation.
 *
 * For the inverse arrangement (motor hanging below a plate, shaft through
 * a pilot hole and extending above), rotate the motor 180° before mating:
 *
 *     const hangingMotor = motors.nema17().rotate(180, "+X");
 *
 * Raw dimensions live in `standards.ts` (NEMA17 / NEMA23 / NEMA14) if you
 * need the bolt pitch for your own pattern, etc.
 */

import { drawRectangle } from "replicad";
import { Part } from "./parts";
import { shape3d } from "./placement";
import { cylinder } from "./cylinder";
import { NEMA17, NEMA23, NEMA14, type NemaMotorSpec } from "./standards";

export interface NemaBuilderOpts {
  /** Override the spec's default exposed shaft length (mm). */
  shaftLength?: number;
  /** Override the default part name. */
  name?: string;
  /** Override the default color (a dark anodized gray). */
  color?: string;
}

function buildNema(spec: NemaMotorSpec, defaultName: string, opts: NemaBuilderOpts = {}): Part {
  const shaftLength = opts.shaftLength ?? spec.shaftLength;
  const body = shape3d(
    drawRectangle(spec.body, spec.body).sketchOnPlane("XY").extrude(spec.height)
  );
  const shaft = cylinder({
    bottom: [0, 0, spec.height],
    length: shaftLength,
    diameter: spec.shaft,
  });
  return new Part(body.fuse(shaft), {
    name: opts.name ?? defaultName,
    color: opts.color ?? "#2b2b2b",
  })
    .addJoint("mountFace", [0, 0, 0], { axis: "-Z", role: "face" })
    .addJoint("shaftTip", [0, 0, spec.height + shaftLength], {
      axis: "+Z",
      role: "male",
      diameter: spec.shaft,
    });
}

/** NEMA 17 stepper — 42×42 body, 31mm bolt pattern, Ø5 shaft. Most common size for 3D printers. */
export function nema17(opts: NemaBuilderOpts = {}): Part {
  return buildNema(NEMA17, "nema17-motor", opts);
}

/** NEMA 23 stepper — 56.4×56.4 body, 47.14mm bolt pattern, Ø6.35 shaft. CNC / heavier linear stages. */
export function nema23(opts: NemaBuilderOpts = {}): Part {
  return buildNema(NEMA23, "nema23-motor", opts);
}

/** NEMA 14 stepper — 35×35 body, 26mm bolt pattern, Ø5 shaft. Small extruder drives etc. */
export function nema14(opts: NemaBuilderOpts = {}): Part {
  return buildNema(NEMA14, "nema14-motor", opts);
}
