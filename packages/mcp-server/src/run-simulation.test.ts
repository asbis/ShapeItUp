/**
 * Integration test for the run_simulation pipeline: execute a real .shape.ts
 * headless through the engine, confirm the `export const sim` block is surfaced
 * on the ExecuteOutcome, then resolve + run it exactly as the MCP tool does and
 * assert the motion produces the expected collisions.
 *
 * This is the end-to-end proof that OCCT execution → AABB extraction → sim
 * resolution → kinematic run works in Node, not just in the unit tests.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeShapeFile } from "./engine";
import { KinematicSim, resolveSimSpec, isSimSpecInput, type Aabb } from "@shapeitup/sim";
import { runDynamics, type MeshData } from "@shapeitup/sim-dynamics";
import { runMujoco } from "@shapeitup/sim-mujoco";

// Mirrors the tool: rest-pose world AABB per part from tessellated vertices.
function partAabbs(parts: Array<{ name: string; vertices: Float32Array }>): Array<{ name: string; aabb: Aabb }> {
  const out: Array<{ name: string; aabb: Aabb }> = [];
  for (const p of parts) {
    const v = p.vertices;
    if (!v || v.length < 3) continue;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < minX) minX = v[i];
      if (v[i] > maxX) maxX = v[i];
      if (v[i + 1] < minY) minY = v[i + 1];
      if (v[i + 1] > maxY) maxY = v[i + 1];
      if (v[i + 2] < minZ) minZ = v[i + 2];
      if (v[i + 2] > maxZ) maxZ = v[i + 2];
    }
    out.push({ name: p.name, aabb: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } });
  }
  return out;
}

const CARRIAGE_NEEDLES = [
  `import { drawRectangle } from "replicad";`,
  `function box(w, d, h, cx, cy, z0) {`,
  `  return drawRectangle(w, d).sketchOnPlane("XY").extrude(h).translate(cx, cy, z0);`,
  `}`,
  `const XS = [-40, -20, 0, 20, 40];`,
  `export default function main() {`,
  `  const bed = box(220, 40, 10, 0, 0, -10);`,
  `  const carriage = box(24, 46, 16, -120, 0, 18);`,
  `  const needles = XS.map((x, i) => ({ shape: box(4, 8, 26, x, 0, -11), name: "needle-" + (i + 1), color: "#c9a24b" }));`,
  `  return [ { shape: bed, name: "bed", color: "#5a6270" }, { shape: carriage, name: "carriage", color: "#3d7bd6" }, ...needles ];`,
  `}`,
  `export const sim = {`,
  `  bodies: { carriage: "kinematic", "needle-*": "kinematic" },`,
  `  joints: [`,
  `    { id: "drive", body: "carriage", type: "prismatic", anchor: [0,0,0], axis: [1,0,0] },`,
  `    { id: "sol-2", body: "needle-2", type: "prismatic", anchor: [0,0,0], axis: [0,0,1] },`,
  `    { id: "sol-4", body: "needle-4", type: "prismatic", anchor: [0,0,0], axis: [0,0,1] },`,
  `  ],`,
  `  actuators: [`,
  `    { id: "drive", joint: "drive", profile: { kind: "velocity", v: 200 } },`,
  `    { id: "sol-2", joint: "sol-2", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },`,
  `    { id: "sol-4", joint: "sol-4", profile: { kind: "position", target: 8, delayMs: 100, rampMs: 40 } },`,
  `  ],`,
  `  acceptedPairs: [["needle-*", "bed"]],`,
  `  duration: 1.5,`,
  `};`,
].join("\n");

const DYNAMIC_FOURBAR = [
  `import { drawRectangle } from "replicad";`,
  `function bar(len, name, color) {`,
  `  return { shape: drawRectangle(len, 4).sketchOnPlane("XY").extrude(4).translate(len / 2, 0, 0), name, color };`,
  `}`,
  `export default function main() {`,
  `  return [ bar(30, "crank", "#d64545"), bar(90, "coupler", "#45a0d6"), bar(60, "rocker", "#d6b845") ];`,
  `}`,
  `export const sim = {`,
  `  engine: "mujoco",`,
  `  bodies: { crank: "kinematic", coupler: "dynamic", rocker: "dynamic" },`,
  `  gravity: [0, 0, -9810],`,
  `  timestep: 1 / 500,`,
  `  linkages: [{`,
  `    kind: "fourBar", dynamic: true,`,
  `    ground: [[0, 0, 0], [100, 0, 0]],`,
  `    crank: { body: "crank", length: 30 }, coupler: { body: "coupler", length: 90 }, rocker: { body: "rocker", length: 60 },`,
  `    driver: { kind: "keyframes", points: [{ t: 0, q: 40 }, { t: 1, q: 140 }, { t: 2, q: 40 }] }, unit: "deg",`,
  `  }],`,
  `  duration: 2,`,
  `};`,
].join("\n");

const NO_SIM = [
  `import { drawRectangle } from "replicad";`,
  `export default function main() { return drawRectangle(10, 10).sketchOnPlane("XY").extrude(5); }`,
].join("\n");

const DYNAMIC_DROP = [
  `import { drawRectangle } from "replicad";`,
  `function box(w, d, h, cx, cy, z0) {`,
  `  return drawRectangle(w, d).sketchOnPlane("XY").extrude(h).translate(cx, cy, z0);`,
  `}`,
  `export default function main() {`,
  `  const plate = box(200, 200, 10, 0, 0, -10);`, // top at z=0
  `  const cube = box(20, 20, 20, 0, 0, 100);`, //  bottom at z=90
  `  return [ { shape: plate, name: "plate" }, { shape: cube, name: "cube" } ];`,
  `}`,
  `export const sim = {`,
  `  mode: "dynamic",`,
  `  bodies: { plate: "static", cube: "dynamic" },`,
  `  gravity: [0, 0, -9810],`,
  `  duration: 2,`,
  `};`,
].join("\n");

describe("run_simulation headless integration", () => {
  const makeDirs = () => ({
    workdir: mkdtempSync(join(tmpdir(), "siu-sim-integ-")),
    storage: mkdtempSync(join(tmpdir(), "siu-sim-integ-storage-")),
  });

  it(
    "surfaces the sim block and simulates: carriage hits only the two raised needles",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "carriage-needles.shape.ts");
        writeFileSync(entryPath, CARRIAGE_NEEDLES);

        const outcome = await executeShapeFile(entryPath, storage);
        expect(outcome.status.success).toBe(true);
        expect(outcome.parts).toBeDefined();
        // The sim block flows through ExecuteOutcome.sim.
        expect(isSimSpecInput(outcome.sim)).toBe(true);
        if (!isSimSpecInput(outcome.sim)) throw new Error("sim block not surfaced");

        const { spec } = resolveSimSpec(
          outcome.sim,
          partAabbs(outcome.parts as Array<{ name: string; vertices: Float32Array }>),
        );
        const result = new KinematicSim(spec).run();

        const hitNeedles = new Set(
          result.collisions
            .filter((c) => c.a === "carriage" || c.b === "carriage")
            .map((c) => (c.a === "carriage" ? c.b : c.a)),
        );
        expect(hitNeedles).toEqual(new Set(["needle-2", "needle-4"]));
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "engine: mujoco — same OCCT pipeline runs on MuJoCo; carriage hits only the two raised needles",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "carriage-needles-mj.shape.ts");
        writeFileSync(entryPath, CARRIAGE_NEEDLES);

        const outcome = await executeShapeFile(entryPath, storage);
        expect(outcome.status.success).toBe(true);
        if (!isSimSpecInput(outcome.sim)) throw new Error("sim block not surfaced");

        const parts = outcome.parts as Array<{ name: string; vertices: Float32Array; triangles: Uint32Array }>;
        const { spec } = resolveSimSpec(outcome.sim, partAabbs(parts));
        // Feed REAL OCCT tessellation into MuJoCo (Phase 2 mesh-geom path — inline
        // vertices → convex hull), proving the whole OCCT → mesh → MuJoCo pipeline
        // and that the optional @mujoco/mujoco dynamic import resolves here.
        const meshes = new Map<string, MeshData>();
        for (const p of parts) {
          if (p.vertices?.length >= 9 && p.triangles?.length >= 3) {
            meshes.set(p.name, { vertices: p.vertices, indices: p.triangles });
          }
        }
        const result = await runMujoco(spec, meshes);

        const hitNeedles = new Set(
          result.collisions
            .filter((c) => c.a === "carriage" || c.b === "carriage")
            .map((c) => (c.a === "carriage" ? c.b : c.a)),
        );
        expect(hitNeedles).toEqual(new Set(["needle-2", "needle-4"]));
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "engine: mujoco — dynamic four-bar physics-solves the loop and reports a pin force",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "fourbar-dyn.shape.ts");
        writeFileSync(entryPath, DYNAMIC_FOURBAR);
        const outcome = await executeShapeFile(entryPath, storage);
        expect(outcome.status.success).toBe(true);
        if (!isSimSpecInput(outcome.sim)) throw new Error("sim block not surfaced");

        const parts = outcome.parts as Array<{ name: string; vertices: Float32Array; triangles: Uint32Array }>;
        const { spec } = resolveSimSpec(outcome.sim, partAabbs(parts));
        const meshes = new Map<string, MeshData>();
        for (const p of parts) {
          if (p.vertices?.length >= 9 && p.triangles?.length >= 3) {
            meshes.set(p.name, { vertices: p.vertices, indices: p.triangles });
          }
        }
        const result = await runMujoco(spec, meshes);
        // The whole OCCT → resolve → physics-linkage → pin-force path works.
        expect(result.pinForces).toBeDefined();
        expect(result.pinForces).toHaveLength(1);
        expect(result.pinForces![0].peakForceN).toBeGreaterThan(0);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "dynamics mode: real OCCT-tessellated cube falls onto a plate and settles",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "drop.shape.ts");
        writeFileSync(entryPath, DYNAMIC_DROP);

        const outcome = await executeShapeFile(entryPath, storage);
        expect(outcome.status.success).toBe(true);
        if (!isSimSpecInput(outcome.sim)) throw new Error("sim block not surfaced");

        const parts = outcome.parts as Array<{ name: string; vertices: Float32Array; triangles: Uint32Array }>;
        const { spec } = resolveSimSpec(outcome.sim, partAabbs(parts));

        // Feed REAL OCCT triangles into the physics engine (convex hull path).
        const meshes = new Map<string, MeshData>();
        for (const p of parts) {
          if (p.vertices?.length >= 9 && p.triangles?.length >= 3) {
            meshes.set(p.name, { vertices: p.vertices, indices: p.triangles });
          }
        }
        const result = await runDynamics(spec, meshes);

        const zStart = result.frames[0].poses["cube"][2];
        const zEnd = result.frames[result.frames.length - 1].poses["cube"][2];
        expect(zStart).toBeCloseTo(0, 1);
        // Cube bottom starts at z=100; it falls ~100 mm to rest on the plate top
        // (z=0), so the transform's z-translation lands near −100 (±~1 mm of
        // Rapier contact softness). A much larger drop would mean it tunneled
        // through the trimesh plate.
        expect(zEnd).toBeLessThan(-85);
        expect(zEnd).toBeGreaterThan(-112);
        // Came to rest (not still falling through): last 10 frames barely move.
        const n = result.frames.length;
        const late = result.frames.slice(n - 10).map((f) => f.poses["cube"][2]);
        expect(Math.max(...late) - Math.min(...late)).toBeLessThan(3);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "sim-as-function is re-evaluated with param overrides (sweepable without editing)",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "sweep.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export const params = { lift: 8 };`,
            `export default function main({ lift }) {`,
            `  return [{ shape: drawRectangle(10,10).sketchOnPlane("XY").extrude(10).translate(0,0,lift), name: "box" }];`,
            `}`,
            `export const sim = (p) => ({`,
            `  bodies: { box: "kinematic" },`,
            `  joints: [{ id: "j", body: "box", type: "prismatic", anchor: [0,0,0], axis: [0,0,1] }],`,
            `  actuators: [{ id: "j", joint: "j", profile: { kind: "position", target: p.lift, rampMs: 10 } }],`,
            `  duration: 0.1,`,
            `});`,
          ].join("\n"),
        );

        // Default params → target 8.
        const base = await executeShapeFile(entryPath, storage);
        expect((base.sim as any).actuators[0].profile.target).toBe(8);

        // Override lift → the sim function sees the merged param.
        const swept = await executeShapeFile(entryPath, storage, { lift: 20 });
        expect((swept.sim as any).actuators[0].profile.target).toBe(20);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "leaves sim undefined for a shape with no sim block",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "plain.shape.ts");
        writeFileSync(entryPath, NO_SIM);
        const outcome = await executeShapeFile(entryPath, storage);
        expect(outcome.status.success).toBe(true);
        expect(isSimSpecInput(outcome.sim)).toBe(false);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
