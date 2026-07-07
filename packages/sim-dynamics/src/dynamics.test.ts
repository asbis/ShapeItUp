import { describe, it, expect } from "vitest";
import { runDynamics, type MeshData } from "./dynamics";
import type { SimSpec } from "@shapeitup/sim";

// Axis-aligned box mesh in world mm: 8 corners, 12 triangles.
function boxMesh(cx: number, cy: number, cz: number, w: number, d: number, h: number): MeshData {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - d / 2, y1 = cy + d / 2;
  const z0 = cz - h / 2, z1 = cz + h / 2;
  const vertices = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // bottom
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // top
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom
    4, 5, 6, 4, 6, 7, // top
    0, 1, 5, 0, 5, 4, // front
    1, 2, 6, 1, 6, 5, // right
    2, 3, 7, 2, 7, 6, // back
    3, 0, 4, 3, 4, 7, // left
  ]);
  return { vertices, indices };
}

const boxAabb = (cx: number, cy: number, cz: number, w: number, d: number, h: number) => ({
  min: [cx - w / 2, cy - d / 2, cz - h / 2] as [number, number, number],
  max: [cx + w / 2, cy + d / 2, cz + h / 2] as [number, number, number],
});

describe("runDynamics", () => {
  it("a dynamic box falls under gravity and settles on a static floor", async () => {
    // Floor top at z=0; box centre starts 100 mm up (bottom at z=90).
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
    const meshes = new Map<string, MeshData>([
      ["floor", boxMesh(0, 0, -10, 400, 400, 20)],
      ["box", boxMesh(0, 0, 100, 20, 20, 20)],
    ]);

    const result = await runDynamics(spec, meshes);

    const zAt = (frameIdx: number) => result.frames[frameIdx].poses["box"][2];
    expect(zAt(0)).toBeCloseTo(0, 1); // starts at rest (identity transform)
    const finalZ = zAt(result.frames.length - 1);
    // Box centre falls from z=100 toward z=10 (resting on the floor), so the
    // transform's z-translation lands near −90 mm.
    expect(finalZ).toBeLessThan(-60);
    expect(finalZ).toBeGreaterThan(-100);

    // Settled: the last 10 frames barely move.
    const n = result.frames.length;
    const late = result.frames.slice(n - 10).map((f) => f.poses["box"][2]);
    expect(Math.max(...late) - Math.min(...late)).toBeLessThan(2);
  });

  it("a kinematic body follows its actuator profile despite gravity", async () => {
    // A kinematic slider moving +X at 100 mm/s is immune to gravity.
    const spec: SimSpec = {
      duration: 1,
      timestep: 1 / 120,
      gravity: [0, 0, -9810],
      bodies: [{ id: "slider", kind: "kinematic", aabb: boxAabb(0, 0, 0, 20, 20, 20) }],
      joints: [{ id: "j", body: "slider", type: "prismatic", anchor: [0, 0, 0], axis: [1, 0, 0] }],
      actuators: [{ id: "a", joint: "j", profile: { kind: "velocity", v: 100 } }],
    };
    const meshes = new Map<string, MeshData>([["slider", boxMesh(0, 0, 0, 20, 20, 20)]]);

    const result = await runDynamics(spec, meshes);
    const last = result.frames[result.frames.length - 1].poses["slider"];
    expect(last[0]).toBeGreaterThan(90); // ~100 mm of +X travel
    expect(last[0]).toBeLessThan(110);
    expect(Math.abs(last[2])).toBeLessThan(1); // no gravity drop
  });
});
