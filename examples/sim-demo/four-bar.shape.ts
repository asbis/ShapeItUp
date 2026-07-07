/**
 * Batch-3 demo — a four-bar linkage solved automatically.
 *
 * Run it: `run_simulation({ filePath: ".../four-bar.shape.ts" })`, or open it and
 * press ▶ Sim in the viewer. The crank oscillates 40°→140°→40°; the solver keeps
 * the loop closed (coupler + rocker follow) with no manual pose-track — the P0
 * fix. Two self-test assertions confirm the shared pin stays coincident and the
 * coupler never stretches.
 *
 * Convention: each link body is a bar from its LOCAL origin along +X of the
 * declared length. The solver rotates + translates each into place.
 */

import { drawRectangle } from "replicad";

// A flat bar spanning local x=[0, len], centred on y, 4 mm thick.
function bar(len: number, name: string, color: string) {
  return {
    shape: drawRectangle(len, 4).sketchOnPlane("XY").extrude(4).translate(len / 2, 0, 0),
    name,
    color,
  };
}

export default function main() {
  return [
    bar(30, "crank", "#d64545"),
    bar(90, "coupler", "#45a0d6"),
    bar(60, "rocker", "#d6b845"),
  ];
}

export const sim = {
  bodies: { crank: "kinematic", coupler: "kinematic", rocker: "kinematic" },
  linkages: [
    {
      kind: "fourBar",
      // Fixed pivots: crank rotates about A=(0,0,0); rocker about D=(100,0,0).
      ground: [[0, 0, 0], [100, 0, 0]],
      crank: { body: "crank", length: 30 },
      coupler: { body: "coupler", length: 90 },
      rocker: { body: "rocker", length: 60 },
      driver: { kind: "keyframes", points: [{ t: 0, q: 40 }, { t: 1, q: 140 }, { t: 2, q: 40 }] },
      unit: "deg", // crank angle authored in degrees
    },
  ],
  markers: [
    { name: "B_crank", body: "crank", point: [30, 0, 0] }, // crank tip
    { name: "B_coupler", body: "coupler", point: [0, 0, 0] }, // coupler near pin
    { name: "C_coupler", body: "coupler", point: [90, 0, 0] }, // coupler far pin
  ],
  assertions: [
    { name: "loop-closed", kind: "markerDistance", markerA: "B_crank", markerB: "B_coupler", equals: 0, tol: 0.5 },
    { name: "coupler-rigid", kind: "markerDistance", markerA: "B_coupler", markerB: "C_coupler", equals: 90, tol: 0.5 },
  ],
  duration: 2,
};
