import { describe, it, expect } from "vitest";
import { resolveSimSpec, isSimSpecInput, type SimSpecInput } from "./resolve";
import { KinematicSim } from "./kinematics";
import type { Aabb } from "./types";
import type { Vec3 } from "./transform";

const aabb = (min: Vec3, max: Vec3): Aabb => ({ min, max });

describe("isSimSpecInput", () => {
  it("accepts a block with a bodies map, rejects junk", () => {
    expect(isSimSpecInput({ bodies: { a: "static" } })).toBe(true);
    expect(isSimSpecInput(undefined)).toBe(false);
    expect(isSimSpecInput({})).toBe(false);
    expect(isSimSpecInput({ bodies: null })).toBe(false);
    expect(isSimSpecInput([])).toBe(false);
  });
});

describe("resolveSimSpec", () => {
  it("expands body globs, defaults unmatched parts to static, drops stale joints", () => {
    const input: SimSpecInput = {
      bodies: { "needle-*": "kinematic" },
      joints: [
        { id: "j", body: "needle-1", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
        { id: "ghost", body: "missing", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
      ],
      actuators: [{ id: "a", joint: "j", profile: { kind: "velocity", v: 1 } }],
    };
    const parts = [
      { name: "bed", aabb: aabb([0, 0, 0], [1, 1, 1]) },
      { name: "needle-1", aabb: aabb([0, 0, 0], [1, 1, 1]) },
    ];
    const { spec, warnings } = resolveSimSpec(input, parts);
    expect(spec.bodies.find((b) => b.id === "bed")!.kind).toBe("static");
    expect(spec.bodies.find((b) => b.id === "needle-1")!.kind).toBe("kinematic");
    expect(spec.joints.map((j) => j.id)).toEqual(["j"]); // stale "ghost" dropped
    expect(warnings.some((w) => w.includes("ghost"))).toBe(true);
  });
});

describe("carriage-needles demo scenario", () => {
  // AABBs computed directly from carriage-needles.shape.ts geometry (mm).
  const NEEDLE_XS = [-40, -20, 0, 20, 40];
  const parts = [
    { name: "bed", aabb: aabb([-110, -20, -10], [110, 20, 0]) },
    { name: "carriage", aabb: aabb([-132, -23, 18], [-108, 23, 34]) },
    ...NEEDLE_XS.map((x, i) => ({
      name: `needle-${i + 1}`,
      aabb: aabb([x - 2, -4, -11], [x + 2, 4, 15]),
    })),
  ];

  const input: SimSpecInput = {
    bodies: { carriage: "kinematic", "needle-*": "kinematic" },
    joints: [
      { id: "drive", body: "carriage", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] },
      { id: "sol-2", body: "needle-2", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
      { id: "sol-4", body: "needle-4", type: "prismatic", anchor: [0, 0, 0], axis: [0, 0, 1] },
    ],
    actuators: [
      { id: "drive", joint: "drive", profile: { kind: "velocity", v: 200 } },
      { id: "sol-2", joint: "sol-2", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },
      { id: "sol-4", joint: "sol-4", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },
    ],
    acceptedPairs: [["needle-*", "bed"]],
    duration: 1.5,
  };

  it("the sweeping carriage collides with ONLY the two raised needles", () => {
    const { spec } = resolveSimSpec(input, parts);
    const result = new KinematicSim(spec).run();
    const hitNeedles = new Set(
      result.collisions
        .filter((c) => c.a === "carriage" || c.b === "carriage")
        .map((c) => (c.a === "carriage" ? c.b : c.a)),
    );
    expect(hitNeedles).toEqual(new Set(["needle-2", "needle-4"]));
    // The lowered needles pass cleanly under the carriage.
    expect(hitNeedles.has("needle-1")).toBe(false);
    expect(hitNeedles.has("needle-3")).toBe(false);
    expect(hitNeedles.has("needle-5")).toBe(false);
  });

  it("needle-2 is struck before needle-4 (carriage reaches −20 before +20)", () => {
    const { spec } = resolveSimSpec(input, parts);
    const result = new KinematicSim(spec).run();
    const t2 = result.collisions.find((c) => c.a === "needle-2" || c.b === "needle-2")!.tStart;
    const t4 = result.collisions.find((c) => c.a === "needle-4" || c.b === "needle-4")!.tStart;
    expect(t2).toBeLessThan(t4);
  });
});
