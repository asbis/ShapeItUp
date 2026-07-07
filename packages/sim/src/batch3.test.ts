import { describe, it, expect } from "vitest";
import { KinematicSim } from "./kinematics";
import { validateSimSpecInput } from "./schema";
import type { Aabb, SimSpec } from "./types";
import type { Vec3 } from "./transform";

const unitAabb: Aabb = { min: [0, 0, 0], max: [1, 1, 1] };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("four-bar linkage solver", () => {
  // Ground A=(0,0,0), D=(100,0,0). Crank 30 (A→B), coupler 80 (B→C), rocker 50 (D→C).
  const spec: SimSpec = {
    duration: 1,
    timestep: 0.25,
    bodies: [
      { id: "crank", kind: "kinematic", aabb: unitAabb },
      { id: "coupler", kind: "kinematic", aabb: unitAabb },
      { id: "rocker", kind: "kinematic", aabb: unitAabb },
    ],
    joints: [],
    actuators: [],
    linkages: [
      {
        kind: "fourBar",
        ground: [[0, 0, 0], [100, 0, 0]],
        crank: { body: "crank", length: 30 },
        coupler: { body: "coupler", length: 80 },
        rocker: { body: "rocker", length: 50 },
        driver: { kind: "keyframes", points: [{ t: 0, q: 20 }, { t: 1, q: 70 }] },
        unit: "deg",
      },
    ],
    markers: [
      { name: "Bcrank", body: "crank", point: [30, 0, 0] }, // crank tip
      { name: "Bcoup", body: "coupler", point: [0, 0, 0] }, // coupler near pin
      { name: "Ccoup", body: "coupler", point: [80, 0, 0] }, // coupler far pin
      { name: "Crock", body: "rocker", point: [50, 0, 0] }, // rocker far pin
      { name: "Drock", body: "rocker", point: [0, 0, 0] }, // rocker ground pin
    ],
  };

  it("keeps the loop closed and every link rigid throughout the motion", () => {
    const sim = new KinematicSim(spec);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const m = sim.markersAt(t);
      // Loop closure: shared pins coincide.
      expect(dist(m.get("Bcrank")!, m.get("Bcoup")!)).toBeCloseTo(0, 4); // B
      expect(dist(m.get("Ccoup")!, m.get("Crock")!)).toBeCloseTo(0, 4); // C
      // Links never stretch.
      expect(dist(m.get("Bcoup")!, m.get("Ccoup")!)).toBeCloseTo(80, 4);
      expect(dist(m.get("Drock")!, m.get("Crock")!)).toBeCloseTo(50, 4);
    }
    // And the coupler pin C actually travels.
    const sim2 = new KinematicSim(spec);
    expect(dist(sim2.markersAt(0).get("Ccoup")!, sim2.markersAt(1).get("Ccoup")!)).toBeGreaterThan(5);
  });

  it("validates a fourBar block", () => {
    expect(validateSimSpecInput({ bodies: { crank: "kinematic" }, linkages: (spec.linkages as any) }).ok).toBe(true);
    // Missing a required length → rejected.
    expect(validateSimSpecInput({ bodies: {}, linkages: [{ kind: "fourBar", ground: [[0, 0, 0], [1, 0, 0]], crank: { body: "c" }, coupler: { body: "k", length: 1 }, rocker: { body: "r", length: 1 }, driver: { kind: "velocity", v: 1 } }] }).ok).toBe(false);
  });
});

describe("slider-crank linkage solver", () => {
  const spec: SimSpec = {
    duration: 1,
    timestep: 0.25,
    bodies: [
      { id: "crank", kind: "kinematic", aabb: unitAabb },
      { id: "coupler", kind: "kinematic", aabb: unitAabb },
      { id: "slider", kind: "kinematic", aabb: unitAabb },
    ],
    joints: [],
    actuators: [],
    linkages: [
      {
        kind: "sliderCrank",
        ground: [0, 0, 0],
        crank: { body: "crank", length: 30 },
        coupler: { body: "coupler", length: 80 },
        slider: { body: "slider", axis: [1, 0, 0] },
        driver: { kind: "keyframes", points: [{ t: 0, q: 30 }, { t: 1, q: 90 }] },
        unit: "deg",
      },
    ],
    markers: [
      { name: "Bcoup", body: "coupler", point: [0, 0, 0] },
      { name: "Ccoup", body: "coupler", point: [80, 0, 0] },
      { name: "sliderPin", body: "slider", point: [0, 0, 0] },
    ],
  };

  it("keeps the coupler rigid, C on its axis, and the slider tracking C's motion", () => {
    const sim = new KinematicSim(spec);
    // The slider translates from its rest (C at t=0), so its marker traces C's
    // DISPLACEMENT — verify that matches the coupler far pin's displacement.
    const c0 = sim.markersAt(0).get("Ccoup")!;
    for (const t of [0, 0.5, 1]) {
      const m = sim.markersAt(t);
      expect(dist(m.get("Bcoup")!, m.get("Ccoup")!)).toBeCloseTo(80, 4); // coupler rigid
      expect(Math.abs(m.get("Ccoup")![1])).toBeCloseTo(0, 4); // C stays on the X axis
      const c = m.get("Ccoup")!;
      const disp: Vec3 = [c[0] - c0[0], c[1] - c0[1], c[2] - c0[2]];
      expect(dist(m.get("sliderPin")!, disp)).toBeCloseTo(0, 4); // slider carries C's motion
    }
    // The slider actually moves.
    expect(Math.abs(sim.markersAt(1).get("sliderPin")![0])).toBeGreaterThan(1);
  });
});

describe("gear linkage solver", () => {
  const spec: SimSpec = {
    duration: 1,
    timestep: 0.25,
    bodies: [
      { id: "driver", kind: "kinematic", aabb: unitAabb },
      { id: "follower", kind: "kinematic", aabb: unitAabb },
    ],
    joints: [],
    actuators: [],
    linkages: [
      {
        kind: "gear",
        driver: { body: "driver", center: [0, 0, 0], profile: { kind: "velocity", v: 1 } },
        follower: { body: "follower", center: [50, 0, 0] },
        ratio: 2,
      },
    ],
    markers: [
      { name: "dm", body: "driver", point: [10, 0, 0] },
      { name: "fm", body: "follower", point: [60, 0, 0] }, // 10 mm from the follower centre
    ],
  };

  it("the follower rotates at -ratio × the driver angle", () => {
    const sim = new KinematicSim(spec);
    const t = 0.5; // driver angle θ = 0.5 rad
    const dm = sim.markersAt(t).get("dm")!;
    expect(dm[0]).toBeCloseTo(10 * Math.cos(0.5), 4);
    expect(dm[1]).toBeCloseTo(10 * Math.sin(0.5), 4);
    // Follower turns -2θ about (50,0,0): pin at (60,0,0)→(50+10cos(-1), 10sin(-1)).
    const fm = sim.markersAt(t).get("fm")!;
    expect(fm[0]).toBeCloseTo(50 + 10 * Math.cos(-1), 4);
    expect(fm[1]).toBeCloseTo(10 * Math.sin(-1), 4);
  });
});

describe("contact intervals", () => {
  it("records a separate window each time a part re-collides (out-and-back)", () => {
    // A 10-wide box sweeps out to x=100 and back; a static obstacle sits at x=40.
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 240,
      bodies: [
        { id: "mover", kind: "kinematic", aabb: { min: [-5, -5, -5], max: [5, 5, 5] } },
        { id: "obstacle", kind: "static", aabb: { min: [35, -5, -5], max: [45, 5, 5] } },
      ],
      joints: [{ id: "j", body: "mover", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      actuators: [{ id: "j", joint: "j", profile: { kind: "keyframes", points: [{ t: 0, q: 0 }, { t: 0.5, q: 100 }, { t: 1, q: 0 }] } }],
    };
    const result = new KinematicSim(spec).run();
    const pair = (result.contactIntervals ?? []).filter(
      (iv) => (iv.a === "mover" && iv.b === "obstacle") || (iv.a === "obstacle" && iv.b === "mover"),
    );
    expect(pair.length).toBe(2); // hit on the way out, and again on the return
    expect(pair[0].start).toBeLessThan(pair[1].start);
    // First contact (legacy collisions) still reports the earliest onset.
    expect(result.collisions.length).toBe(1);
    expect(result.collisions[0].tStart).toBeCloseTo(pair[0].start, 5);
  });
});
