// Latch needle — simplified geometry for visualization.
// Real latch needles are wire-formed steel; here we model the features that
// matter for assembly fit: stem sliding in groove, butt for cam engagement,
// hook + closed latch at the working end.
//
// Local frame: needle lies along +Y. Hook end at +Y, butt at -Y.
// Stem cross-section: stemWid (X) × stemThk (Z). Top face at Z=0.

import { drawRectangle } from "replicad";
import { shape3d, cylinder } from "shapeitup";
import { SPEC, COLORS } from "./constants";

export const params = {
  length: SPEC.needleLength,
  stemThk: SPEC.needleStemThk,
  stemWid: SPEC.needleStemWid,
  hookDia: SPEC.needleHookDia,
  hookWire: SPEC.needleHookWire,
  butt_h: SPEC.needleButtH,
  butt_l: SPEC.needleButtL,
};

export function makeNeedle(p: typeof params = params) {
  // Stem — centered on origin, extends -Z by stemThk so top face is Z=0.
  const stem = shape3d(
    drawRectangle(p.stemWid, p.length)
      .sketchOnPlane("XY")
      .extrude(-p.stemThk)
  );

  // Butt — raised square above the stem at the rear (-Y) end, fires up into cam.
  const buttY = -p.length / 2 + p.butt_l / 2 + 2;
  const butt = shape3d(
    drawRectangle(p.stemWid, p.butt_l)
      .sketchOnPlane("XY")
      .extrude(p.butt_h)
      .translate(0, buttY, 0)
  );

  // Hook — a short cylinder across the needle axis at the +Y tip (approximation
  // of the hooked wire). Use a ring by subtracting an inner cylinder.
  const hookCenterY = p.length / 2 - p.hookDia / 2;
  const outer = cylinder({
    diameter: p.hookDia + p.hookWire,
    length: p.hookWire * 2,
    bottom: -p.hookWire,
    direction: "+X",
  }).translate(0, hookCenterY, -p.stemThk / 2);
  const inner = cylinder({
    diameter: p.hookDia - p.hookWire,
    length: p.hookWire * 3,
    bottom: -p.hookWire * 1.5,
    direction: "+X",
  }).translate(0, hookCenterY, -p.stemThk / 2);
  const hook = shape3d(outer).cut(inner);

  // Latch — flat tab shown half-open above the stem (idle/raised state).
  const latch = shape3d(
    drawRectangle(p.stemWid * 0.7, SPEC.needleLatchLen)
      .sketchOnPlane("XY")
      .extrude(p.stemThk * 0.4)
      .translate(0, hookCenterY - SPEC.needleLatchLen / 2 - 1, 0)
  );

  return shape3d(stem).fuse(butt).fuse(hook).fuse(latch);
}

export default function main() {
  return [
    { shape: makeNeedle(), name: "needle", color: COLORS.steel },
  ];
}
