import { describe, it, expect } from "vitest";
import { evaluateProfile } from "./actuators";
import {
  overlapVolume,
  transformAabb,
  isAcceptedPair,
} from "./collision";
import {
  apply,
  rotationAbout,
  translation,
  compose,
  type Vec3,
} from "./transform";
import { mmToSi, siToMm, MM_TO_M } from "./units";
import { KinematicSim } from "./kinematics";
import type { SimSpec } from "./types";

describe("actuator profiles", () => {
  it("velocity ramps linearly after its delay", () => {
    const p = { kind: "velocity", v: 40, delayMs: 100 } as const;
    expect(evaluateProfile(p, 0)).toBe(0);
    expect(evaluateProfile(p, 0.1)).toBeCloseTo(0); // still at delay boundary
    expect(evaluateProfile(p, 0.6)).toBeCloseTo(40 * 0.5); // 0.5s of motion
  });

  it("solenoid position profile: response lag then finite pull-in", () => {
    // Seats at 6mm, 8ms coil lag, 12ms pull-in.
    const p = {
      kind: "position",
      target: 6,
      rampMs: 12,
      delayMs: 8,
    } as const;
    expect(evaluateProfile(p, 0)).toBe(0); // hasn't fired
    expect(evaluateProfile(p, 0.008)).toBe(0); // just at end of lag
    expect(evaluateProfile(p, 0.014)).toBeCloseTo(3); // halfway through ramp
    expect(evaluateProfile(p, 0.02)).toBeCloseTo(6); // fully seated
    expect(evaluateProfile(p, 1)).toBeCloseTo(6); // holds
  });

  it("smooth easing stays within [from, target] and hits endpoints", () => {
    const p = {
      kind: "position",
      target: 10,
      rampMs: 10,
      easing: "smooth",
    } as const;
    const mid = evaluateProfile(p, 0.005);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(10);
    expect(evaluateProfile(p, 0.01)).toBeCloseTo(10);
  });

  it("keyframes interpolate piecewise-linearly and clamp at ends", () => {
    const p = {
      kind: "keyframes" as const,
      points: [
        { t: 0, q: 0 },
        { t: 1, q: 10 },
        { t: 2, q: 5 },
      ],
    };
    expect(evaluateProfile(p, -1)).toBe(0);
    expect(evaluateProfile(p, 0.5)).toBeCloseTo(5);
    expect(evaluateProfile(p, 1.5)).toBeCloseTo(7.5);
    expect(evaluateProfile(p, 99)).toBe(5);
  });

  it("sine oscillates about its offset", () => {
    const p = { kind: "sine", amplitude: 2, freq: 1, offset: 5 } as const;
    expect(evaluateProfile(p, 0)).toBeCloseTo(5);
    expect(evaluateProfile(p, 0.25)).toBeCloseTo(7); // quarter period → +amp
  });
});

describe("transforms", () => {
  it("prismatic translation moves a point along the axis", () => {
    const tf = translation([5, 0, 0]);
    expect(apply(tf, [1, 2, 3])).toEqual([6, 2, 3]);
  });

  it("revolute rotation about an off-origin anchor keeps the anchor fixed", () => {
    const anchor: Vec3 = [10, 0, 0];
    const tf = rotationAbout(anchor, [0, 0, 1], Math.PI / 2);
    // The anchor point is invariant under rotation about itself.
    const movedAnchor = apply(tf, anchor);
    expect(movedAnchor[0]).toBeCloseTo(10);
    expect(movedAnchor[1]).toBeCloseTo(0);
    // A point +1 in X from the anchor swings to +1 in Y.
    const p = apply(tf, [11, 0, 0]);
    expect(p[0]).toBeCloseTo(10);
    expect(p[1]).toBeCloseTo(1);
  });

  it("compose applies the right-hand transform first", () => {
    const t = compose(translation([0, 0, 5]), rotationAbout([0, 0, 0], [0, 0, 1], Math.PI));
    const p = apply(t, [1, 0, 0]); // rotate 180° about Z → (-1,0,0), then +5 in Z
    expect(p[0]).toBeCloseTo(-1);
    expect(p[2]).toBeCloseTo(5);
  });
});

describe("collision primitives", () => {
  it("overlapVolume is zero for disjoint boxes, positive for overlap", () => {
    const a = { min: [0, 0, 0] as Vec3, max: [2, 2, 2] as Vec3 };
    const b = { min: [1, 1, 1] as Vec3, max: [3, 3, 3] as Vec3 };
    expect(overlapVolume(a, b)).toBeCloseTo(1); // 1×1×1
    const far = { min: [10, 10, 10] as Vec3, max: [11, 11, 11] as Vec3 };
    expect(overlapVolume(a, far)).toBe(0);
  });

  it("transformAabb recomputes the enclosing box after a rotation", () => {
    const box = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };
    const rotated = transformAabb(box, rotationAbout([0, 0, 0], [0, 0, 1], Math.PI / 4));
    // A 2×2×2 cube rotated 45° about Z widens to ~2√2 in X/Y.
    expect(rotated.max[0]).toBeCloseTo(Math.SQRT2, 5);
  });

  it("acceptedPairs globs match unordered", () => {
    const rules: Array<[string, string]> = [["needle-*", "bed"]];
    expect(isAcceptedPair(rules, "needle-3", "bed")).toBe(true);
    expect(isAcceptedPair(rules, "bed", "needle-12")).toBe(true);
    expect(isAcceptedPair(rules, "needle-3", "carriage")).toBe(false);
  });
});

describe("units bridge", () => {
  it("mm→SI is a pure scale when up-axis unchanged", () => {
    expect(mmToSi([1000, 2000, 3000])).toEqual([1, 2, 3]);
  });
  it("round-trips through Y-up remap", () => {
    const v: Vec3 = [12, -34, 56];
    const back = siToMm(mmToSi(v, { targetUp: "Y" }), { targetUp: "Y" });
    expect(back[0]).toBeCloseTo(12);
    expect(back[1]).toBeCloseTo(-34);
    expect(back[2]).toBeCloseTo(56);
  });
  it("Z-up→Y-up sends CAD +Z to Three +Y", () => {
    const r = mmToSi([0, 0, 1000], { targetUp: "Y" });
    expect(r[0]).toBeCloseTo(0);
    expect(r[1]).toBeCloseTo(1);
    expect(r[2]).toBeCloseTo(0);
  });
});

describe("KinematicSim — knitting carriage over a solenoid needle", () => {
  // Bed: static. Carriage: kinematic, slides +X at 200 mm/s, a 10mm cube
  // starting to the left of the needle. Needle: kinematic, a solenoid that
  // pushes it +Z into the carriage's path after a delay.
  const spec: SimSpec = {
    duration: 0.5,
    timestep: 0.005,
    bodies: [
      { id: "bed", kind: "static", aabb: { min: [-100, -5, -5], max: [100, 5, 0] } },
      { id: "carriage", kind: "kinematic", aabb: { min: [-60, -5, 5], max: [-50, 5, 15] } },
      { id: "needle", kind: "kinematic", aabb: { min: [-2, -2, 0], max: [2, 2, 4] } },
    ],
    joints: [
      { id: "drive", body: "carriage", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] },
      { id: "sol", body: "needle", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
    ],
    actuators: [
      { id: "drive", joint: "drive", profile: { kind: "velocity", v: 200 } },
      // Needle rises 8mm to reach the carriage's z-band [5,15] after 50ms lag.
      { id: "sol", joint: "sol", profile: { kind: "position", target: 8, rampMs: 20, delayMs: 50 } },
    ],
  };

  it("carriage advances and needle stays down during the coil lag", () => {
    const sim = new KinematicSim(spec);
    const early = sim.poseAt(0.02); // 20ms — within needle's 50ms lag
    expect(early.get("carriage")!.t[0]).toBeCloseTo(200 * 0.02); // 4mm
    expect(early.get("needle")!.t[2]).toBeCloseTo(0); // hasn't fired
  });

  it("detects the carriage/needle collision once both are in position", () => {
    const sim = new KinematicSim(spec);
    const result = sim.run();
    const hit = result.collisions.find(
      (c) => (c.a === "carriage" && c.b === "needle") || (c.a === "needle" && c.b === "carriage"),
    );
    expect(hit).toBeDefined();
    // Needle only clears z=5 after ~50ms lag + partial ramp; carriage reaches
    // the needle's x-band (~x=-2..2, i.e. +50mm travel) at ~0.25s. Contact is
    // in the second half of the run, not at t=0.
    expect(hit!.tStart).toBeGreaterThan(0.05);
  });

  it("is reproducible: two runs of the same spec give identical collisions", () => {
    const a = new KinematicSim(spec).run();
    const b = new KinematicSim(spec).run();
    expect(a.collisions).toEqual(b.collisions);
  });

  it("respects acceptedPairs to suppress an expected resting contact", () => {
    const withAccepted: SimSpec = {
      ...spec,
      acceptedPairs: [["carriage", "needle"]],
    };
    const result = new KinematicSim(withAccepted).run();
    expect(
      result.collisions.some(
        (c) => c.a === "needle" || c.b === "needle" ? (c.a === "carriage" || c.b === "carriage") : false,
      ),
    ).toBe(false);
  });
});
