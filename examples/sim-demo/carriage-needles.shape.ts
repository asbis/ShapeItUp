/**
 * Phase-1 motion-simulation demo — a knitting-style carriage sweeping over a
 * needle bed.
 *
 * Watch it: open this file, then press ▶ Play on the timeline at the bottom.
 *
 * The mechanism: five needles sit in a static bed with their tops 3 mm BELOW
 * the sweeping carriage — so a needle at rest passes cleanly under it. Two
 * solenoids (needle-2 and needle-4) fire, lifting those needles 8 mm UP into
 * the carriage's path. As the carriage sweeps +X it collides with exactly the
 * two raised needles and glides over the three lowered ones — the essence of
 * pattern selection. Change which needles fire (see the `sim` block) and the
 * collision log updates.
 *
 * This is scripted ("kinematic") motion: no forces, just actuator profiles vs
 * time. The solenoid's `delayMs`/`rampMs` model its real response lag + finite
 * pull-in speed — tune them and check whether a needle seats before the cam
 * arrives.
 */

import { drawRectangle } from "replicad";

// A box spanning [−w/2,w/2]×[−d/2,d/2] in XY, extruded h in +Z from z0.
function box(w: number, d: number, h: number, cx: number, cy: number, z0: number) {
  return drawRectangle(w, d).sketchOnPlane("XY").extrude(h).translate(cx, cy, z0);
}

const NEEDLE_XS = [-40, -20, 0, 20, 40];

export default function main() {
  // Static bed: top face at z = 0.
  const bed = box(220, 40, 10, 0, 0, -10);

  // Carriage: a block whose underside sits at z = 18, starting to the left at
  // x = −120 and sweeping +X. 3 mm clearance above a resting needle (top z=15).
  const carriage = box(24, 46, 16, -120, 0, 18);

  // Needles: thin uprights resting in the bed, tops at z = 15.
  const needles = NEEDLE_XS.map((x, i) => ({
    shape: box(4, 8, 26, x, 0, -11),
    name: `needle-${i + 1}`,
    color: "#c9a24b",
  }));

  return [
    { shape: bed, name: "bed", color: "#5a6270" },
    { shape: carriage, name: "carriage", color: "#3d7bd6" },
    ...needles,
  ];
}

// ── Motion simulation ────────────────────────────────────────────────────────
// See @shapeitup/sim (SimSpecInput). Body kinds are matched by glob against the
// part names above; joints/actuators drive the kinematic bodies over time.
export const sim = {
  bodies: {
    carriage: "kinematic",
    "needle-*": "kinematic",
    // `bed` is unmatched → defaults to "static".
  },
  joints: [
    // Carriage slides along +X.
    { id: "drive", body: "carriage", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] },
    // Solenoids lift needle-2 and needle-4 along +Z.
    { id: "sol-2", body: "needle-2", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
    { id: "sol-4", body: "needle-4", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
  ],
  actuators: [
    // Sweep the full bed at 200 mm/s.
    { id: "drive", joint: "drive", profile: { kind: "velocity", v: 200 } },
    // Fire both solenoids early: 100 ms coil lag, 40 ms pull-in, 8 mm throw.
    { id: "sol-2", joint: "sol-2", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },
    { id: "sol-4", joint: "sol-4", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },
  ],
  // Needles rest partly inside the bed — that overlap is expected, not a crash.
  acceptedPairs: [["needle-*", "bed"]],
  duration: 1.5,
};
