import { describe, it, expect } from "vitest";
import { runMujoco } from "./mujoco";
import { buildMjcf } from "./mjcf";
import type { MeshData } from "./mesh";
import { apply, linkageTransforms, type SimSpec, type Transform, type Vec3 } from "@shapeitup/sim";

// World position of a body-local (rest-world) point from a recorded frame pose.
function worldPoint(pose: number[], local: Vec3): Vec3 {
  const tf: Transform = { t: [pose[0], pose[1], pose[2]], q: [pose[3], pose[4], pose[5], pose[6]] };
  return apply(tf, local);
}

const boxAabb = (cx: number, cy: number, cz: number, w: number, d: number, h: number) => ({
  min: [cx - w / 2, cy - d / 2, cz - h / 2] as Vec3,
  max: [cx + w / 2, cy + d / 2, cz + h / 2] as Vec3,
});

// An octahedron (|x|+|y|+|z| ≤ r) centred at (cx,cy,cz): 6 vertices. Its AABB is
// the full ±r cube, but its convex hull fills only ~1/6 of that — so it's the
// canonical shape for telling a hull collider apart from an AABB-box collider.
const octaMesh = (cx: number, cy: number, cz: number, r: number): MeshData => ({
  vertices: new Float32Array([
    cx + r, cy, cz, cx - r, cy, cz,
    cx, cy + r, cz, cx, cy - r, cz,
    cx, cy, cz + r, cx, cy, cz - r,
  ]),
  indices: new Uint32Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]),
});
const octaAabb = (cx: number, cy: number, cz: number, r: number) => boxAabb(cx, cy, cz, 2 * r, 2 * r, 2 * r);

const noMeshes = new Map<string, MeshData>();

describe("buildMjcf", () => {
  it("emits a well-formed kinematic tree with gravity, joints, and actuators", () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 120,
      gravity: [0, 0, -9810],
      bodies: [
        { id: "floor", kind: "static", aabb: boxAabb(0, 0, -10, 400, 400, 20) },
        { id: "arm", kind: "dynamic", aabb: boxAabb(20, 0, 0, 40, 4, 4) },
        { id: "car.riage", kind: "kinematic", aabb: boxAabb(0, 0, 50, 20, 20, 20) },
      ],
      joints: [{ id: "servo", body: "arm", type: "revolute", anchor: [0, 0, 0], axis: [0, 0, 1], unit: "deg" }],
      actuators: [{ id: "a", joint: "servo", profile: { kind: "position", target: 90, rampMs: 200 } }],
    };
    const build = buildMjcf(spec, noMeshes);
    // Gravity in metres, Z-up (no axis remap).
    expect(build.xml).toContain('gravity="0 0 -9.81"');
    expect(build.xml).toContain('type="hinge"');
    expect(build.xml).toContain("<position");
    expect(build.xml).toContain('mocap="true"');
    // The kinematic body is the sole mocap body → index 0.
    expect(build.mocapOrder).toEqual(["car.riage"]);
    // The "." in the id was sanitised for the MJCF name but still maps back.
    const mjName = build.mjNameBySimId.get("car.riage")!;
    expect(mjName).not.toContain(".");
    expect(build.simIdByMjName.get(mjName)).toBe("car.riage");
    expect(build.actuators).toHaveLength(1);
  });

  it("emits a mesh asset + mesh geom when tessellation is supplied", () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 240,
      bodies: [{ id: "blob", kind: "dynamic", aabb: octaAabb(0, 0, 0, 10) }],
      joints: [],
      actuators: [],
    };
    const meshes = new Map<string, MeshData>([["blob", octaMesh(0, 0, 0, 10)]]);
    const build = buildMjcf(spec, meshes);
    expect(build.xml).toContain("<asset>");
    expect(build.xml).toContain('<mesh name="blob_mesh"');
    expect(build.xml).toContain('type="mesh"');
    expect(build.xml).not.toContain('type="box"');
    // Vertices are body-local metres (the +X corner at r=10 mm → 0.01).
    expect(build.xml).toContain("0.01 0 0");
    // With no mesh, the same body falls back to a box.
    expect(buildMjcf(spec, noMeshes).xml).toContain('type="box"');
  });
});

describe("runMujoco", () => {
  it("a dynamic box falls under gravity and settles on a static floor", async () => {
    const spec: SimSpec = {
      duration: 2,
      timestep: 1 / 120,
      gravity: [0, 0, -9810],
      bodies: [
        { id: "floor", kind: "static", aabb: boxAabb(0, 0, -10, 400, 400, 20) },
        { id: "box", kind: "dynamic", aabb: boxAabb(0, 0, 100, 20, 20, 20) },
      ],
      joints: [],
      actuators: [],
    };
    const result = await runMujoco(spec, noMeshes);

    const zAt = (i: number) => result.frames[i].poses["box"][2];
    expect(zAt(0)).toBeCloseTo(0, 1); // frame 0 is the identity delta
    const finalZ = zAt(result.frames.length - 1);
    // Centre falls from z=100 toward z=10 (resting on the floor) → delta ≈ −90.
    expect(finalZ).toBeLessThan(-60);
    expect(finalZ).toBeGreaterThan(-100);
    // Settled: the last 10 frames barely move.
    const late = result.frames.slice(-10).map((f) => f.poses["box"][2]);
    expect(Math.max(...late) - Math.min(...late)).toBeLessThan(2);
    // The landing was reported as a collision (box vs floor).
    expect(result.collisions.some((c) => (c.a === "box" && c.b === "floor") || (c.a === "floor" && c.b === "box"))).toBe(true);
  });

  it("a kinematic body follows its actuator profile despite gravity", async () => {
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 120,
      gravity: [0, 0, -9810],
      bodies: [{ id: "slider", kind: "kinematic", aabb: boxAabb(0, 0, 0, 20, 20, 20) }],
      joints: [{ id: "j", body: "slider", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      actuators: [{ id: "a", joint: "j", profile: { kind: "velocity", v: 100 } }],
    };
    const result = await runMujoco(spec, noMeshes);
    const last = result.frames[result.frames.length - 1].poses["slider"];
    expect(last[0]).toBeGreaterThan(90); // ~100 mm of +X travel
    expect(last[0]).toBeLessThan(110);
    expect(Math.abs(last[2])).toBeLessThan(1); // scripted → immune to gravity
  });

  it("a dynamic bar on a revolute joint swings down while its pivot stays put", async () => {
    const spec: SimSpec = {
      duration: 3,
      timestep: 1 / 120,
      gravity: [0, 0, -9810],
      bodies: [{ id: "bar", kind: "dynamic", aabb: { min: [0, -2, -2], max: [40, 2, 2] } }],
      joints: [{ id: "pin", body: "bar", type: "revolute", anchor: [0, 0, 0], axis: [0, 1, 0] }],
      actuators: [],
    };
    const result = await runMujoco(spec, noMeshes);
    // The pinned end stays at the anchor throughout (the constraint holds).
    for (const f of result.frames) {
      const pivot = worldPoint(f.poses["bar"], [0, 0, 0]);
      expect(Math.hypot(pivot[0], pivot[1], pivot[2])).toBeLessThan(5);
    }
    // The free end swings well below the pivot.
    const tipZ = result.frames.map((f) => worldPoint(f.poses["bar"], [40, 0, 0])[2]);
    expect(Math.min(...tipZ)).toBeLessThan(-20);
  });

  it("carriage-needles: a swept carriage hits only the two RAISED needles (all-kinematic)", async () => {
    // Mirrors examples/sim-demo/carriage-needles.shape.ts: a knitting carriage
    // sweeping +X over a needle bed. Needles 2 & 4 lift 8 mm into the carriage's
    // path; 1/3/5 stay low (3 mm clearance). This is the acid test for scripted-
    // vs-scripted contacts — MuJoCo culls DOF-less contacts, so it only works via
    // the weld-driven-dynamic trick.
    const bedAabb = boxAabb(0, 0, -5, 220, 40, 10); // top at z=0
    const carriageAabb = boxAabb(-120, 0, 26, 24, 46, 16); // underside z=18
    const NEEDLE_XS = [-40, -20, 0, 20, 40];
    const needleAabb = (x: number) => boxAabb(x, 0, 2, 4, 8, 26); // top at z=15

    const spec: SimSpec = {
      duration: 1.5,
      timestep: 1 / 240,
      gravity: [0, 0, -9810],
      bodies: [
        { id: "bed", kind: "static", aabb: bedAabb },
        { id: "carriage", kind: "kinematic", aabb: carriageAabb },
        ...NEEDLE_XS.map((x, i) => ({ id: `needle-${i + 1}`, kind: "kinematic" as const, aabb: needleAabb(x) })),
      ],
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
    };

    const result = await runMujoco(spec, noMeshes);
    const hit = (n: string) =>
      result.collisions.some((c) => (c.a === "carriage" && c.b === n) || (c.b === "carriage" && c.a === n));

    // The carriage strikes exactly the two raised needles…
    expect(hit("needle-2")).toBe(true);
    expect(hit("needle-4")).toBe(true);
    // …and glides over the three lowered ones.
    expect(hit("needle-1")).toBe(false);
    expect(hit("needle-3")).toBe(false);
    expect(hit("needle-5")).toBe(false);
    // The expected needle-in-bed overlap is suppressed, not reported.
    expect(result.collisions.some((c) => c.a === "bed" || c.b === "bed")).toBe(false);

    // Each real strike reports peak contact force + penetration (how hard/deep) —
    // data the kinematic and Rapier engines don't produce.
    for (const c of result.collisions) {
      expect(c.peakForceN).toBeGreaterThan(0);
      expect(c.peakPenetrationMm).toBeGreaterThan(0);
    }

    // The carriage's scripted sweep is exact (200 mm/s × 1.5 s = +300 mm).
    const cx = result.frames[result.frames.length - 1].poses["carriage"][0];
    expect(cx).toBeGreaterThan(295);
    expect(cx).toBeLessThan(305);
  });

  it("mesh geoms collide by convex hull, not AABB (tighter than box colliders)", async () => {
    // Two octahedra (r=10) at (0,0,0) and (18,18,0). Their AABBs overlap in the
    // [8,10]×[8,10] corner, but the hulls' nearest points ((5,5,0) and (13,13,0))
    // are ~11 mm apart — they do NOT touch. Static bodies (no motion, no gravity).
    const spec: SimSpec = {
      duration: 0.2,
      timestep: 1 / 240,
      gravity: [0, 0, 0],
      bodies: [
        { id: "a", kind: "kinematic", aabb: octaAabb(0, 0, 0, 10) },
        { id: "b", kind: "kinematic", aabb: octaAabb(18, 18, 0, 10) },
      ],
      joints: [],
      actuators: [],
    };
    const collidesWith = (meshes: Map<string, MeshData>) =>
      runMujoco(spec, meshes).then((r) =>
        r.collisions.some((c) => (c.a === "a" && c.b === "b") || (c.a === "b" && c.b === "a")),
      );

    // Box (AABB) colliders → the corner overlap is a (false) collision.
    expect(await collidesWith(noMeshes)).toBe(true);
    // Mesh (hull) colliders → the diamonds don't actually touch.
    const meshes = new Map<string, MeshData>([
      ["a", octaMesh(0, 0, 0, 10)],
      ["b", octaMesh(18, 18, 0, 10)],
    ]);
    expect(await collidesWith(meshes)).toBe(false);
  });

  it("a dynamic body rides a scripted kinematic parent while its own joint articulates", async () => {
    // A pendulum pinned to a carriage that sweeps +X at 100 mm/s. The pivot must
    // RIDE the carriage (parent), not stay grounded at the world anchor, while the
    // bar still swings under gravity — matching Rapier's parent-anchored joints.
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 240,
      gravity: [0, 0, -9810],
      bodies: [
        { id: "carriage", kind: "kinematic", aabb: boxAabb(0, 0, 0, 40, 40, 20) },
        // Resolved SimSpec carries `parent` per body (SimSpecInput.parents → here).
        { id: "pend", kind: "dynamic", aabb: { min: [-2, -2, -40], max: [2, 2, 0] }, parent: "carriage" },
      ],
      joints: [
        { id: "drive", body: "carriage", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] },
        { id: "pin", body: "pend", type: "revolute", anchor: [0, 0, 0], axis: [0, 1, 0] },
      ],
      actuators: [{ id: "drive", joint: "drive", profile: { kind: "velocity", v: 100 } }],
    };
    const result = await runMujoco(spec, noMeshes);
    const last = result.frames[result.frames.length - 1].poses["pend"];
    // Pivot = pendulum local [0,0,0] (its top) — rode the carriage toward x≈100.
    const pivot = worldPoint(last, [0, 0, 0]);
    expect(pivot[0]).toBeGreaterThan(50);
    // Still hangs roughly downward under gravity (tip below the pivot).
    const tip = worldPoint(last, [0, 0, -40]);
    expect(tip[2]).toBeLessThan(pivot[2] - 20);
  });

  it("four-bar linkage: the loop stays closed on MuJoCo (analytic solver → kinematic bodies)", async () => {
    // A link body is a bar from its local origin along +X of the declared length.
    const barAabb = (len: number) => boxAabb(len / 2, 0, 2, len, 4, 4);
    const spec: SimSpec = {
      duration: 2,
      timestep: 1 / 240,
      bodies: [
        { id: "crank", kind: "kinematic", aabb: barAabb(30) },
        { id: "coupler", kind: "kinematic", aabb: barAabb(90) },
        { id: "rocker", kind: "kinematic", aabb: barAabb(60) },
      ],
      joints: [],
      actuators: [],
      // The bars are pinned into a closed loop, so their overlaps at the shared
      // pins are expected — excluded so they don't read as collisions.
      acceptedPairs: [
        ["crank", "coupler"],
        ["coupler", "rocker"],
        ["crank", "rocker"],
      ],
      linkages: [
        {
          kind: "fourBar",
          ground: [
            [0, 0, 0],
            [100, 0, 0],
          ],
          crank: { body: "crank", length: 30 },
          coupler: { body: "coupler", length: 90 },
          rocker: { body: "rocker", length: 60 },
          driver: { kind: "keyframes", points: [{ t: 0, q: 40 }, { t: 1, q: 140 }, { t: 2, q: 40 }] },
          unit: "deg",
        },
      ],
    };
    const result = await runMujoco(spec, noMeshes);
    // Loop closed: the crank tip (local [30,0,0]) stays coincident with the
    // coupler's near pin (local [0,0,0]) throughout, and the coupler stays rigid.
    for (const f of result.frames) {
      const tip = worldPoint(f.poses["crank"], [30, 0, 0]);
      const pin = worldPoint(f.poses["coupler"], [0, 0, 0]);
      expect(Math.hypot(tip[0] - pin[0], tip[1] - pin[1], tip[2] - pin[2])).toBeLessThan(0.5);
      const near = worldPoint(f.poses["coupler"], [0, 0, 0]);
      const far = worldPoint(f.poses["coupler"], [90, 0, 0]);
      expect(Math.hypot(far[0] - near[0], far[1] - near[1], far[2] - near[2])).toBeGreaterThan(89.5);
    }
    // The crank actually swept (not frozen): its tip moved over the run.
    const tip0 = worldPoint(result.frames[0].poses["crank"], [30, 0, 0]);
    const tipMid = worldPoint(result.frames[Math.floor(result.frames.length / 2)].poses["crank"], [30, 0, 0]);
    expect(Math.hypot(tipMid[0] - tip0[0], tipMid[1] - tip0[1])).toBeGreaterThan(5);
  });

  it("dynamic four-bar: physics-solves the loop, follows the analytic path, reports pin force", async () => {
    const barAabb = (len: number) => boxAabb(len / 2, 0, 2, len, 4, 4);
    const lk = {
      kind: "fourBar" as const,
      dynamic: true,
      ground: [[0, 0, 0], [100, 0, 0]] as [Vec3, Vec3],
      crank: { body: "crank", length: 30 },
      coupler: { body: "coupler", length: 90 },
      rocker: { body: "rocker", length: 60 },
      driver: { kind: "keyframes" as const, points: [{ t: 0, q: 40 }, { t: 1, q: 140 }, { t: 2, q: 40 }] },
      unit: "deg" as const,
    };
    const spec: SimSpec = {
      duration: 2,
      timestep: 1 / 500,
      gravity: [0, 0, -9810],
      bodies: [
        { id: "crank", kind: "kinematic", aabb: barAabb(30) },
        { id: "coupler", kind: "kinematic", aabb: barAabb(90) },
        { id: "rocker", kind: "kinematic", aabb: barAabb(60) },
      ],
      joints: [],
      actuators: [],
      linkages: [lk],
    };
    const result = await runMujoco(spec, noMeshes);

    // The pin force is the payoff — under gravity the coupler↔rocker joint carries load.
    expect(result.pinForces).toBeDefined();
    expect(result.pinForces).toHaveLength(1);
    expect(result.pinForces![0].peakForceN).toBeGreaterThan(0);

    // Physics tracks the analytic four-bar within a couple mm (after a brief settle).
    for (let i = 100; i < result.frames.length; i += 50) {
      const f = result.frames[i];
      const T = linkageTransforms(lk, f.t);
      // Crank is prescribed → exact.
      const crankTip = worldPoint(f.poses["crank"], [30, 0, 0]);
      const B = apply(T.get("crank")!, [30, 0, 0]);
      expect(Math.hypot(crankTip[0] - B[0], crankTip[1] - B[1], crankTip[2] - B[2])).toBeLessThan(0.5);
      // Coupler far end (C) — physics — matches the analytic solution.
      const couplerC = worldPoint(f.poses["coupler"], [90, 0, 0]);
      const C = apply(T.get("coupler")!, [90, 0, 0]);
      expect(Math.hypot(couplerC[0] - C[0], couplerC[1] - C[1], couplerC[2] - C[2])).toBeLessThan(3);
      // Loop closed: coupler far end coincides with rocker far end.
      const rockerC = worldPoint(f.poses["rocker"], [60, 0, 0]);
      expect(Math.hypot(couplerC[0] - rockerC[0], couplerC[1] - rockerC[1], couplerC[2] - rockerC[2])).toBeLessThan(2);
    }
  });

  it("a position actuator drives a revolute joint to its target angle (90°)", async () => {
    const spec: SimSpec = {
      duration: 1.5,
      timestep: 1 / 120,
      gravity: [0, 0, 0],
      bodies: [{ id: "arm", kind: "dynamic", aabb: { min: [0, -2, -2], max: [40, 2, 2] } }],
      joints: [
        { id: "servo", body: "arm", type: "revolute", anchor: [0, 0, 0], axis: [0, 0, 1], unit: "deg", motor: { stiffness: 1e4, damping: 1e3 } },
      ],
      actuators: [{ id: "servo", joint: "servo", profile: { kind: "position", target: 90, rampMs: 200 } }],
    };
    const result = await runMujoco(spec, noMeshes);
    const tip = worldPoint(result.frames[result.frames.length - 1].poses["arm"], [40, 0, 0]);
    // Rotated ~90° about Z: free end near (0, 40, 0).
    expect(tip[1]).toBeGreaterThan(30); // swung toward +Y
    expect(Math.abs(tip[0])).toBeLessThan(12); // near the Y axis
  });
});
