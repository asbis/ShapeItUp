import { describe, it, expect } from "vitest";
import { evaluateProfile } from "./actuators";
import { KinematicSim } from "./kinematics";
import { resolveSimSpec, type SimSpecInput } from "./resolve";
import type { Aabb, SimSpec } from "./types";
import type { Vec3 } from "./transform";

const unitAabb: Aabb = { min: [0, 0, 0], max: [1, 1, 1] };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("new actuator profiles", () => {
  it("firstOrder: dead time then exponential approach (~63% @1τ, ~95% @3τ)", () => {
    const p = { kind: "firstOrder", target: 10, tauMs: 100, deadMs: 50 } as const;
    expect(evaluateProfile(p, 0.05)).toBe(0); // still in dead time
    expect(evaluateProfile(p, 0.15)).toBeCloseTo(10 * (1 - Math.exp(-1)), 4); // 1τ after dead
    expect(evaluateProfile(p, 0.35)).toBeCloseTo(10 * (1 - Math.exp(-3)), 4); // 3τ
  });

  it("slew: constant-rate move that clamps at the target", () => {
    const p = { kind: "slew", target: 10, rate: 100 } as const;
    expect(evaluateProfile(p, 0.05)).toBeCloseTo(5); // 100*0.05
    expect(evaluateProfile(p, 0.2)).toBeCloseTo(10); // clamped
  });

  it("servo: rate-limited at slewDegPerS", () => {
    const p = { kind: "servo", target: 90, slewDegPerS: 180 } as const;
    expect(evaluateProfile(p, 0.25)).toBeCloseTo(45);
    expect(evaluateProfile(p, 1)).toBeCloseTo(90);
  });

  it("keyframe interp: smoothstep eases, cubic passes through the points", () => {
    const smooth = { kind: "keyframes" as const, interp: "smoothstep" as const, points: [{ t: 0, q: 0 }, { t: 1, q: 10 }] };
    expect(evaluateProfile(smooth, 0.25)).toBeLessThan(2.5); // eased in slower than linear's 2.5
    const cubic = { kind: "keyframes" as const, interp: "cubic" as const, points: [{ t: 0, q: 0 }, { t: 1, q: 10 }, { t: 2, q: 0 }] };
    expect(evaluateProfile(cubic, 1)).toBeCloseTo(10); // interpolates the keyframe exactly
    expect(evaluateProfile(cubic, 0)).toBeCloseTo(0);
    expect(evaluateProfile(cubic, 2)).toBeCloseTo(0);
  });
});

describe("revolute unit: deg", () => {
  it("a deg-declared revolute rotates by degrees, not radians", () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 0.5,
      bodies: [{ id: "crank", kind: "kinematic", aabb: unitAabb }],
      joints: [{ id: "j", body: "crank", type: "revolute", anchor: [0, 0, 0], axis: [0, 0, 1], unit: "deg" }],
      actuators: [{ id: "j", joint: "j", profile: { kind: "keyframes", points: [{ t: 0, q: 0 }, { t: 1, q: 90 }] } }],
      markers: [{ name: "tip", body: "crank", point: [30, 0, 0] }],
    };
    const sim = new KinematicSim(spec);
    // 90° (not 90 rad): (30,0,0) → (0,30,0).
    const tip = sim.markersAt(1).get("tip")!;
    expect(tip[0]).toBeCloseTo(0);
    expect(tip[1]).toBeCloseTo(30);
  });
});

describe("markers + pose tracks", () => {
  it("markersAt reports a marker's world position on a moving body", () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 0.5,
      bodies: [{ id: "slider", kind: "kinematic", aabb: unitAabb }],
      joints: [{ id: "j", body: "slider", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      actuators: [{ id: "j", joint: "j", profile: { kind: "velocity", v: 10 } }],
      markers: [{ name: "m", body: "slider", point: [0, 5, 0] }],
    };
    const sim = new KinematicSim(spec);
    expect(sim.markersAt(0).get("m")).toEqual([0, 5, 0]);
    const at1 = sim.markersAt(1).get("m")!;
    expect(at1[0]).toBeCloseTo(10); // slid +10 in x
    expect(at1[1]).toBeCloseTo(5);
  });

  it("a pose track drives a body directly (position lerp + orientation slerp)", () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 0.5,
      bodies: [{ id: "coupler", kind: "kinematic", aabb: unitAabb }],
      joints: [],
      actuators: [],
      poses: [
        {
          body: "coupler",
          samples: [
            { t: 0, position: [0, 0, 0] },
            { t: 1, position: [10, 0, 0], axisAngle: { axis: [0, 0, 1], deg: 90 } },
          ],
        },
      ],
      markers: [{ name: "c", body: "coupler", point: [2, 0, 0] }],
    };
    const sim = new KinematicSim(spec);
    // Midway: position lerps to (5,0,0), rotation slerps to 45°.
    const mid = sim.markersAt(0.5).get("c")!;
    expect(mid[0]).toBeCloseTo(5 + 2 * Math.cos(Math.PI / 4), 4);
    expect(mid[1]).toBeCloseTo(2 * Math.sin(Math.PI / 4), 4);
  });
});

describe("acceptance: four-bar loop closure via pose track + markers", () => {
  // A crank rotates 0→90° (deg unit). A coupler is driven by a pose track whose
  // samples place its near pin exactly on the crank tip at t=0 and t=1. We assert
  // (a) loop closure: the coupler's near marker coincides with the crank tip at
  // the sample times, and (b) the link is rigid: the coupler's two markers keep a
  // constant separation throughout.
  const r = 30; // crank length
  const Lc = 20; // coupler length
  const spec: SimSpec = {
    duration: 1,
    timestep: 0.25,
    bodies: [
      { id: "crank", kind: "kinematic", aabb: unitAabb },
      { id: "coupler", kind: "kinematic", aabb: unitAabb },
    ],
    joints: [{ id: "cj", body: "crank", type: "revolute", anchor: [0, 0, 0], axis: [0, 0, 1], unit: "deg" }],
    actuators: [{ id: "cj", joint: "cj", profile: { kind: "keyframes", points: [{ t: 0, q: 0 }, { t: 1, q: 90 }] } }],
    poses: [
      {
        body: "coupler",
        samples: [
          { t: 0, position: [r, 0, 0] }, // crank tip at θ=0
          { t: 1, position: [0, r, 0] }, // crank tip at θ=90°
        ],
      },
    ],
    markers: [
      { name: "tip", body: "crank", point: [r, 0, 0] }, // pin on the crank
      { name: "B", body: "coupler", point: [0, 0, 0] }, // near pin on the coupler
      { name: "C", body: "coupler", point: [Lc, 0, 0] }, // far pin on the coupler
    ],
  };

  it("loop stays closed at the sample times and the link never stretches", () => {
    const sim = new KinematicSim(spec);
    for (const t of [0, 1]) {
      const m = sim.markersAt(t);
      // Loop closure: coupler near pin sits on the crank tip.
      expect(dist(m.get("tip")!, m.get("B")!)).toBeCloseTo(0, 4);
    }
    // Rigid link: B–C separation is exactly Lc at every sampled time.
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const m = sim.markersAt(t);
      expect(dist(m.get("B")!, m.get("C")!)).toBeCloseTo(Lc, 4);
    }
    // And the mechanism actually moved.
    expect(dist(sim.markersAt(0).get("C")!, sim.markersAt(1).get("C")!)).toBeGreaterThan(1);
  });
});

describe("resolveSimSpec: poses + markers passthrough and validation", () => {
  const parts = [
    { name: "crank", aabb: unitAabb },
    { name: "coupler", aabb: unitAabb },
  ];
  it("passes valid poses/markers through and drops stale ones with warnings", () => {
    const input: SimSpecInput = {
      bodies: { crank: "kinematic", coupler: "kinematic" },
      poses: [
        { body: "coupler", samples: [{ t: 0, position: [0, 0, 0] }] },
        { body: "ghost", samples: [{ t: 0, position: [0, 0, 0] }] },
      ],
      markers: [
        { name: "ok", body: "crank", point: [1, 0, 0] },
        { name: "bad", body: "nope", point: [0, 0, 0] },
      ],
    };
    const { spec, warnings } = resolveSimSpec(input, parts);
    expect(spec.poses?.map((p) => p.body)).toEqual(["coupler"]);
    expect(spec.markers?.map((m) => m.name)).toEqual(["ok"]);
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(warnings.some((w) => w.includes("bad"))).toBe(true);
  });

  it("warns when a body has both a pose track and a joint (track wins)", () => {
    const input: SimSpecInput = {
      bodies: { coupler: "kinematic" },
      joints: [{ id: "j", body: "coupler", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      poses: [{ body: "coupler", samples: [{ t: 0, position: [0, 0, 0] }] }],
    };
    const { warnings } = resolveSimSpec(input, [{ name: "coupler", aabb: unitAabb }]);
    expect(warnings.some((w) => w.includes("pose track wins") || w.includes("pose track AND"))).toBe(true);
  });
});
