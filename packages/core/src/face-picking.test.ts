/**
 * End-to-end guards for face picking data, run against real OCCT.
 *
 * The viewer pairs `faceGroups[i]` (a span of the triangle buffer) with
 * `faceInfo[i]` (the geometry of a B-Rep face) by INDEX. That pairing is an
 * observed property of replicad — `mesh()` and `new FaceFinder().find(shape)`
 * happen to enumerate faces in the same order — not a documented guarantee.
 *
 * So the test that matters is not "does the field exist" but "does group i
 * actually lie on face i". For planar faces that is decidable exactly: every
 * vertex of the group must satisfy `dot(v - center, normal) == 0`. If a
 * replicad upgrade ever reorders one of the two enumerations, this fails
 * loudly here instead of silently highlighting the wrong face in the UI.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "./index.js";
import { loadOCCTForTest } from "./testing/occt.js";

let core: Awaited<ReturnType<typeof initCore>>;

beforeAll(async () => {
  core = await initCore(loadOCCTForTest);
}, 120_000);

/** Run a script through the real pipeline and return its parts. */
async function run(script: string, partStats?: "none" | "bbox" | "full") {
  const result = await core.execute(script, undefined, partStats ? { partStats } : undefined);
  return result.parts;
}

// Plain JS, not `.shape.ts` source: `core.execute` takes already-transpiled
// code, and reaches replicad through the `__replicad__` binding the executor's
// IIFE provides. In a real file esbuild rewrites `import {...} from "replicad"`
// into exactly that; a test can address it directly and skip the bundler.
const BRACKET = `
  const { drawRoundedRectangle, drawCircle } = __replicad__;
  const params = { width: 80, depth: 60, height: 8 };
  function main({ width, depth, height }) {
    const plate = drawRoundedRectangle(width, depth, 6).sketchOnPlane().extrude(height);
    const hole = drawCircle(6).sketchOnPlane("XY", -1).extrude(height + 2);
    return plate.cut(hole);
  }
`;
describe("face picking data", () => {
  it("emits one descriptor per triangle-group", async () => {
    const [part] = await run(BRACKET);
    expect(part.faceGroups).toBeInstanceOf(Uint32Array);
    expect(part.faceGroups!.length % 2).toBe(0);
    expect(part.faceInfo).toBeDefined();
    expect(part.faceInfo!.length).toBe(part.faceGroups!.length / 2);
  });

  it("partitions the triangle buffer exactly — no gaps, no overlaps", async () => {
    // A gap means some triangle is unpickable; an overlap means one triangle
    // reports two different faces depending on which group you search first.
    const [part] = await run(BRACKET);
    const groups = part.faceGroups!;
    const spans: [number, number][] = [];
    for (let i = 0; i < groups.length; i += 2) spans.push([groups[i], groups[i + 1]]);
    spans.sort((a, b) => a[0] - b[0]);

    let cursor = 0;
    for (const [start, count] of spans) {
      expect(start).toBe(cursor);
      expect(count).toBeGreaterThan(0);
      cursor = start + count;
    }
    expect(cursor).toBe(part.triangles.length);
  });

  it("puts every vertex of a planar group on that face's plane", async () => {
    const [part] = await run(BRACKET);
    const groups = part.faceGroups!;
    const info = part.faceInfo!;
    let planarChecked = 0;

    for (let f = 0; f < info.length; f++) {
      const face = info[f];
      if (face.kind !== "PLANE" || !face.normal) continue;
      planarChecked++;
      const [cx, cy, cz] = face.center;
      const [nx, ny, nz] = face.normal;
      const start = groups[f * 2];
      const count = groups[f * 2 + 1];

      let worst = 0;
      for (let t = start; t < start + count; t++) {
        const v = part.triangles[t] * 3;
        const d = Math.abs(
          (part.vertices[v] - cx) * nx +
          (part.vertices[v + 1] - cy) * ny +
          (part.vertices[v + 2] - cz) * nz,
        );
        if (d > worst) worst = d;
      }
      // 1e-3 mm, not 0 — the mesh is Float32 while the face centre is Float64.
      expect(worst, `face ${f} (${face.kind}) group is off its own plane`).toBeLessThan(1e-3);
    }
    // Guard the guard: a shape whose planar faces all got skipped would pass
    // vacuously. The bracket has a top, a bottom and four sides.
    expect(planarChecked).toBeGreaterThanOrEqual(6);
  });

  it("reports areas that sum to the part's surface area", async () => {
    // "full" so `surfaceArea` is actually populated — the default is "bbox",
    // under which this test would pass without comparing anything.
    const [part] = await run(BRACKET, "full");
    const sum = part.faceInfo!.reduce((a, f) => a + (f.area ?? 0), 0);
    const total = part.surfaceArea;
    expect(typeof total).toBe("number");
    // Per-face areas and the whole-solid area are two different OCCT calls;
    // agreeing to 1 part in 10^6 means every face was measured exactly once.
    expect(Math.abs(sum - total!) / total!).toBeLessThan(1e-6);
  });

  it("gives each edge a span of the edge buffer", async () => {
    const [part] = await run(BRACKET);
    expect(part.edgeGroups).toBeInstanceOf(Uint32Array);
    const g = part.edgeGroups!;
    // edgeGroups are in POINT units, edgeVertices in floats — 3 per point.
    let last = 0;
    for (let i = 0; i < g.length; i += 2) {
      expect(g[i]).toBe(last);
      last = g[i] + g[i + 1];
    }
    expect(last * 3).toBe(part.edgeVertices.length);
  });
});
