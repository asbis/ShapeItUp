import { describe, it, expect } from "vitest";
import { validateSimSpecInput } from "./schema";
import { evaluateAssertions } from "./assertions";
import { KinematicSim } from "./kinematics";
import type { Aabb, SimSpec } from "./types";

const unitAabb: Aabb = { min: [0, 0, 0], max: [1, 1, 1] };

describe("validateSimSpecInput", () => {
  it("accepts a well-formed block", () => {
    const r = validateSimSpecInput({
      bodies: { carriage: "kinematic", "needle-*": "kinematic" },
      joints: [{ id: "drive", body: "carriage", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      actuators: [{ id: "drive", joint: "drive", profile: { kind: "velocity", v: 200 } }],
      acceptedPairs: [["needle-*", "bed"]],
      duration: 1.5,
    });
    expect(r.ok).toBe(true);
  });

  it("gives an actionable, path-anchored error when joints is not an array", () => {
    const r = validateSimSpecInput({ bodies: { a: "static" }, joints: { nope: true } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("joints"))).toBe(true);
  });

  it("flags a bad profile kind and a bad body kind", () => {
    const r = validateSimSpecInput({
      bodies: { a: "wobbly" },
      actuators: [{ id: "x", joint: "j", profile: { kind: "teleport", target: 5 } }],
    });
    expect(r.ok).toBe(false);
  });

  it("accepts the new Batch-1 features (pose tracks, deg unit, firstOrder, markers, assertions)", () => {
    const r = validateSimSpecInput({
      bodies: { crank: "kinematic", coupler: "kinematic" },
      joints: [{ id: "j", body: "crank", type: "revolute", anchor: [0, 0, 0], axis: [0, 0, 1], unit: "deg" }],
      actuators: [{ id: "j", joint: "j", profile: { kind: "firstOrder", target: 8, tauMs: 20, deadMs: 5 } }],
      poses: [{ body: "coupler", samples: [{ t: 0, position: [0, 0, 0], axisAngle: { axis: [0, 0, 1], deg: 90 } }] }],
      markers: [{ name: "tip", body: "crank", point: [30, 0, 0] }],
      assertions: [{ name: "link", kind: "markerDistance", markerA: "tip", markerB: "tip", equals: 0, tol: 1 }],
    });
    expect(r.ok).toBe(true);
  });
});

describe("evaluateAssertions", () => {
  // A slider moving +X at 10 mm/s with two rigidly-attached markers 5 mm apart.
  const spec: SimSpec = {
    duration: 1,
    timestep: 0.25,
    bodies: [{ id: "slider", kind: "kinematic", aabb: unitAabb }],
    joints: [{ id: "j", body: "slider", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
    actuators: [{ id: "j", joint: "j", profile: { kind: "velocity", v: 10 } }],
    markers: [
      { name: "m1", body: "slider", point: [0, 0, 0] },
      { name: "m2", body: "slider", point: [5, 0, 0] },
    ],
    assertions: [
      { name: "rigid", kind: "markerDistance", markerA: "m1", markerB: "m2", equals: 5, tol: 0.1 },
      { name: "wrong", kind: "markerDistance", markerA: "m1", markerB: "m2", equals: 3, tol: 0.1 },
      { name: "arrives", kind: "markerReaches", marker: "m1", point: [10, 0, 0], tol: 0.5, byMs: 1000 },
      { name: "no-hit", kind: "noCollision", a: "slider", b: "ghost" },
    ],
  };

  it("evaluates distance/reaches/noCollision to the right verdicts", () => {
    const result = new KinematicSim(spec).run();
    const res = Object.fromEntries(evaluateAssertions(spec, result).map((r) => [r.name, r]));
    expect(res.rigid.pass).toBe(true); // 5 mm apart throughout
    expect(res.wrong.pass).toBe(false); // observed 5, wanted 3
    expect(res.arrives.pass).toBe(true); // m1 reaches x=10 by t=1
    expect(res["no-hit"].pass).toBe(true); // no other body to collide with
  });
});
