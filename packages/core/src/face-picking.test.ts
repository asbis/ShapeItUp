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

/**
 * The picked face's descriptor has to be enough to find that face again when
 * its plane is shared. An L-bracket whose two gussets run the full depth of
 * the base splits the base's top into three coplanar faces; the viewer names
 * whichever one was clicked by its plane plus a pin, and the worker picks the
 * pin using nothing but the descriptor's (Float32) centre and a point inside
 * the triangles the viewer drew.
 */
describe("picking one of several coplanar faces", () => {
  const L_BRACKET = `
    const { draw, drawRectangle } = __replicad__;
    const params = { width: 60, depth: 40, thickness: 5, wallH: 50 };
    function main({ width, depth, thickness, wallH }) {
      let shape = drawRectangle(width, depth).sketchOnPlane().extrude(thickness);
      shape = shape.fuse(
        drawRectangle(width, 5).sketchOnPlane().extrude(wallH).translate(0, depth / 2 - 2.5, 0),
      );
      for (const x of [-18, 18]) {
        const gusset = draw([-depth / 2, thickness])
          .lineTo([depth / 2 - 5, thickness])
          .lineTo([depth / 2 - 5, wallH - 10])
          .close()
          .sketchOnPlane("YZ")
          .extrude(4)
          .translate(x - 2, 0, 0);
        shape = shape.fuse(gusset);
      }
      return shape;
    }
  `;

  /** What the viewer's faceInteriorPoint computes: the largest triangle's centroid. */
  function interiorOf(part: any, f: number): [number, number, number] {
    const v = part.vertices, tri = part.triangles;
    const start = part.faceGroups[f * 2], count = part.faceGroups[f * 2 + 1];
    let best: [number, number, number] = [0, 0, 0], bestArea = 0;
    for (let t = start; t < start + count; t += 3) {
      const [a, b, c] = [tri[t] * 3, tri[t + 1] * 3, tri[t + 2] * 3];
      const u = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
      const w = [v[c] - v[a], v[c + 1] - v[a + 1], v[c + 2] - v[a + 2]];
      const area = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      if (area > bestArea) {
        bestArea = area;
        best = [(v[a] + v[b] + v[c]) / 3, (v[a + 1] + v[b + 1] + v[c + 1]) / 3, (v[a + 2] + v[b + 2] + v[c + 2]) / 3];
      }
    }
    return best;
  }

  it("pins each of the three and extrudes exactly that one", async () => {
    const [part] = await run(L_BRACKET, "full");
    const tops = part.faceInfo!
      .map((info, f) => ({ info, f }))
      .filter(({ info }) =>
        info.kind === "PLANE" && info.normal && info.normal[2] > 0.999 && Math.abs(info.center[2] - 5) < 1e-3,
      );
    expect(tops.length).toBe(3);
    const baseVol = part.volume!;

    for (const { info, f } of tops) {
      const r = await core.execute(L_BRACKET, undefined, {
        partStats: "full",
        previewOp: {
          op: "extrude",
          partName: null,
          target: {
            kind: "face",
            plane: "XY",
            offset: info.center[2],
            center: info.center,
            interior: interiorOf(part, f),
          },
          distance: 3,
        },
      });
      expect(r.previewTarget?.planeMatches).toBe(3);
      expect(r.previewTarget?.pin, `face ${f} got no pin`).toBeDefined();
      // Exactly this face's area, times the distance — not another's, and
      // not zero, which is what the unpinned selector produced.
      expect(r.parts[0]!.volume! - baseVol).toBeCloseTo(info.area! * 3, 0);
    }
  });
});
