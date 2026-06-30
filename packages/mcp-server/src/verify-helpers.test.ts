import { describe, it, expect } from "vitest";
import {
  extractGeometry,
  extractCollisions,
  extractJoints,
  formatGeometryReport,
  formatCollisionReport,
  formatJointReport,
  nameMatches,
  matchesAnyAcceptedPair,
} from "./verify-helpers.js";

// ---------------------------------------------------------------------------
// Mock part builders.
//
// These helpers fabricate `ExecutedPart`-shaped objects with just enough
// surface to exercise the extractors. Real OCCT shapes are heavyweight (WASM
// init); the helpers are pure code paths over the mock surface so we can keep
// these tests fast and deterministic.
// ---------------------------------------------------------------------------

/** Build a 3-vertex triangle's worth of mesh data so AABB calc works. */
function tri(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): Float32Array {
  return new Float32Array([x0, y0, z0, x1, y1, z1, x2, y2, z2]);
}

/** Mock shape that returns no faces/edges by default — extractGeometry's
 *  summary path can run without OCCT face iteration. */
function mockShape(overrides: any = {}): any {
  return {
    faces: [],
    edges: [],
    ...overrides,
  };
}

/** Construct a part with a unit-cube AABB centered at origin (no faces — the
 *  extractor reads only `vertices` for bbox + counts faces from `shape.faces`). */
function mockPart(name: string, opts: { aabb?: [number, number, number, number, number, number]; joints?: Record<string, any>; faces?: any[] } = {}): any {
  const [x0, y0, z0, x1, y1, z1] = opts.aabb ?? [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5];
  return {
    name,
    vertices: tri(x0, y0, z0, x1, y0, z0, x0, y1, z0).slice(0).map(() => 0).length === 0
      // Always supply a real Float32Array, never an empty one — the helpers
      // use vertex count > 0 to detect "tessellated" parts.
      ? new Float32Array([x0, y0, z0, x1, y1, z1])
      : new Float32Array([x0, y0, z0, x1, y1, z1]),
    shape: mockShape({ faces: opts.faces ?? [] }),
    joints: opts.joints,
  };
}

describe("extractGeometry — summary mode", () => {
  it("counts parts and computes a bounding box from vertex data", () => {
    const parts = [
      mockPart("A", { aabb: [0, 0, 0, 10, 5, 2] }),
      mockPart("B", { aabb: [-5, -5, -5, 0, 0, 0] }),
    ];
    const result = extractGeometry(parts);
    expect(result.ok).toBe(true);
    expect(result.report?.summary.partNames).toEqual(["A", "B"]);
    expect(result.report?.boundingBox?.min).toEqual([-5, -5, -5]);
    expect(result.report?.boundingBox?.max).toEqual([10, 5, 2]);
    expect(result.report?.boundingBox?.size).toEqual([15, 10, 7]);
  });

  it("defaults format to summary, faces to all, edges to none", () => {
    const parts = [mockPart("solo")];
    const result = extractGeometry(parts);
    expect(result.report?.format).toBe("summary");
    expect(result.report?.facesFilter).toBe("all");
    expect(result.report?.edgesFilter).toBe("none");
    // edges:'none' → edgesByType absent
    expect(result.report?.summary.edgesByType).toBeUndefined();
  });

  it("returns an error when partName doesn't match any part", () => {
    const parts = [mockPart("alpha"), mockPart("beta")];
    const result = extractGeometry(parts, { partName: "gamma" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("gamma");
    expect(result.error).toContain("alpha");
    expect(result.error).toContain("beta");
  });

  it("restricts to a named part when partName matches", () => {
    const parts = [
      mockPart("alpha", { aabb: [0, 0, 0, 1, 1, 1] }),
      mockPart("beta", { aabb: [10, 10, 10, 11, 11, 11] }),
    ];
    const result = extractGeometry(parts, { partName: "beta" });
    expect(result.ok).toBe(true);
    expect(result.report?.summary.partNames).toEqual(["beta"]);
    // bbox is JUST beta
    expect(result.report?.boundingBox?.min).toEqual([10, 10, 10]);
  });
});

describe("extractCollisions", () => {
  it("returns skipped:true for assemblies of < 2 parts", () => {
    const result = extractCollisions([mockPart("only")]);
    expect(result.skipped).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.totalPairs).toBe(0);
  });

  it("AABB prefilter skips obviously-disjoint pairs without calling intersect", () => {
    let intersectCalls = 0;
    const a = mockPart("a", { aabb: [0, 0, 0, 1, 1, 1] });
    a.shape.intersect = () => { intersectCalls++; return null; };
    const b = mockPart("b", { aabb: [100, 100, 100, 101, 101, 101] });
    const result = extractCollisions([a, b]);
    expect(result.totalPairs).toBe(1);
    expect(result.skippedByAABB).toBe(1);
    expect(result.testedPairs).toBe(0);
    expect(intersectCalls).toBe(0);
    expect(result.real).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("clamps negative tolerance to 0", () => {
    const result = extractCollisions(
      [mockPart("a"), mockPart("b", { aabb: [10, 10, 10, 11, 11, 11] })],
      { tolerance: -5 },
    );
    expect(result.tolerance).toBe(0);
  });

  it("pressFitThreshold can't be lower than tolerance", () => {
    const result = extractCollisions(
      [mockPart("a"), mockPart("b", { aabb: [10, 10, 10, 11, 11, 11] })],
      { tolerance: 1.0, pressFitThreshold: 0.1 },
    );
    expect(result.pressFitThreshold).toBe(1.0);
  });

  it("captures intersect failures rather than crashing", () => {
    const a = mockPart("a", { aabb: [0, 0, 0, 1, 1, 1] });
    a.shape.intersect = () => { throw new Error("boom"); };
    const b = mockPart("b", { aabb: [0.5, 0.5, 0.5, 1.5, 1.5, 1.5] });
    const result = extractCollisions([a, b]);
    expect(result.failures.length).toBe(1);
    expect(result.failures[0].error).toContain("boom");
    expect(result.ok).toBe(false);
  });

  it("populates per-axis depths on the collision region", () => {
    // Mock an intersection mesh so extractCollisions reaches the region
    // branch: cam↔lifter overlap spans [-6.71..6.71] x [5..9.5] y [0.5..7.5] z
    // → depths { x:13.42, y:4.5, z:7.0 } (the feedback example).
    // Use a plain number[] for the overlap mesh to avoid Float32Array
    // precision noise — extractCollisions copies vertex components verbatim,
    // and the test is about depth arithmetic, not representation.
    const overlapMesh = {
      vertices: [
        -6.71, 5.0, 0.5,
         6.71, 9.5, 7.5,
        -6.71, 9.5, 0.5,
      ],
    };
    const overlapShape = {
      mesh: () => overlapMesh,
      delete: () => { /* noop */ },
    };
    const a = mockPart("cam", { aabb: [-6.71, 5.0, 0.5, 6.71, 9.5, 7.5] });
    a.shape.intersect = () => overlapShape;
    const b = mockPart("lifter", { aabb: [-6.71, 5.0, 0.5, 6.71, 9.5, 7.5] });
    const fakeReplicad = {
      measureShapeVolumeProperties: () => ({
        volume: 42.1,
        centerOfMass: [0, 7.25, 4.0],
        delete: () => { /* noop */ },
      }),
    };
    const result = extractCollisions([a, b], { replicad: fakeReplicad });
    expect(result.real.length).toBe(1);
    const region = result.real[0].region;
    expect(region).toBeDefined();
    expect(region!.depths.x).toBeCloseTo(13.42, 2);
    expect(region!.depths.y).toBeCloseTo(4.5, 2);
    expect(region!.depths.z).toBeCloseTo(7.0, 2);
    expect(region!.min).toEqual([-6.71, 5.0, 0.5]);
    expect(region!.max).toEqual([6.71, 9.5, 7.5]);
  });

  it("acceptedPairs: literal pair is still exact-matched", () => {
    const overlapShape = { mesh: () => ({ vertices: [0, 0, 0, 1, 1, 1, 0, 1, 0] }), delete: () => {} };
    const a = mockPart("bolt", { aabb: [0, 0, 0, 1, 1, 1] });
    a.shape.intersect = () => overlapShape;
    const b = mockPart("plate", { aabb: [0, 0, 0, 1, 1, 1] });
    const fakeReplicad = {
      measureShapeVolumeProperties: () => ({ volume: 10, centerOfMass: [0, 0, 0], delete: () => {} }),
    };
    const result = extractCollisions([a, b], {
      replicad: fakeReplicad,
      acceptedPairs: [["bolt", "plate"]],
    });
    expect(result.accepted.length).toBe(1);
    expect(result.real.length).toBe(0);
    // Non-matching literal should NOT swallow the collision.
    const result2 = extractCollisions([a, b], {
      replicad: fakeReplicad,
      acceptedPairs: [["screw", "plate"]],
    });
    expect(result2.accepted.length).toBe(0);
    expect(result2.real.length).toBe(1);
  });

  it("acceptedPairs: `*` wildcard accepts matching names symmetrically", () => {
    const overlapShape = { mesh: () => ({ vertices: [0, 0, 0, 1, 1, 1, 0, 1, 0] }), delete: () => {} };
    const makeReplicad = () => ({
      measureShapeVolumeProperties: () => ({ volume: 10, centerOfMass: [0, 0, 0], delete: () => {} }),
    });
    const needleA = mockPart("needle-001", { aabb: [0, 0, 0, 1, 1, 1] });
    needleA.shape.intersect = () => overlapShape;
    const needleB = mockPart("needle-042", { aabb: [0, 0, 0, 1, 1, 1] });
    needleB.shape.intersect = () => overlapShape;
    const bed = mockPart("needle-bed", { aabb: [0, 0, 0, 1, 1, 1] });
    bed.shape.intersect = () => overlapShape;

    // One pattern covers all needle-*↔needle-bed intersections.
    const result = extractCollisions([needleA, needleB, bed], {
      replicad: makeReplicad(),
      acceptedPairs: [["needle-*", "needle-bed"]],
    });
    // Both needle-* ↔ needle-bed pairs accepted; needle-001↔needle-042 pair
    // (not covered) should land in `real`.
    expect(result.accepted.length).toBe(2);
    expect(result.real.length).toBe(1);
    expect(result.real[0].rawA).toMatch(/needle-0/);
    expect(result.real[0].rawB).toMatch(/needle-0/);
  });

  it("nameMatches + matchesAnyAcceptedPair handle edges correctly", () => {
    // Exact literals.
    expect(nameMatches("foo", "foo")).toBe(true);
    expect(nameMatches("foo", "foobar")).toBe(false);
    // Trailing / leading / middle wildcards.
    expect(nameMatches("foo-*", "foo-bar")).toBe(true);
    expect(nameMatches("foo-*", "foo-")).toBe(true); // `*` matches empty run
    expect(nameMatches("foo-*", "foo")).toBe(false); // literal hyphen required
    expect(nameMatches("*-bar", "foo-bar")).toBe(true);
    expect(nameMatches("*", "anything")).toBe(true);
    // Regex metachars in pattern are escaped, not interpreted.
    expect(nameMatches("a.b", "a.b")).toBe(true);
    expect(nameMatches("a.b", "aXb")).toBe(false);
    // Symmetric accept.
    const pats: Array<[string, string]> = [["bolt-*", "plate"]];
    expect(matchesAnyAcceptedPair("bolt-m3", "plate", pats)).toBe(true);
    expect(matchesAnyAcceptedPair("plate", "bolt-m3", pats)).toBe(true);
    expect(matchesAnyAcceptedPair("plate", "nut", pats)).toBe(false);
  });

  it("formatCollisionReport includes an 'Overlap depth' line per real collision", () => {
    const overlapMesh = {
      vertices: [
        0, 0, 0,
        2, 3, 5,
        0, 3, 0,
      ],
    };
    const overlapShape = { mesh: () => overlapMesh, delete: () => { /* noop */ } };
    const a = mockPart("block", { aabb: [0, 0, 0, 2, 3, 5] });
    a.shape.intersect = () => overlapShape;
    const b = mockPart("wedge", { aabb: [0, 0, 0, 2, 3, 5] });
    const fakeReplicad = {
      measureShapeVolumeProperties: () => ({
        volume: 17.0,
        centerOfMass: [1.0, 1.5, 2.5],
        delete: () => { /* noop */ },
      }),
    };
    const report = extractCollisions([a, b], { replicad: fakeReplicad });
    const text = formatCollisionReport(report);
    expect(text).toContain("Overlap depth: X=2.00mm, Y=3.00mm, Z=5.00mm");
  });

  // P2-4 design-class hint clustering — synthesize a CollisionReport and
  // format it directly. These tests don't go through extractCollisions
  // (which requires real/fake meshes); they verify the grouper + formatter
  // pathway.
  const mkRecord = (a: string, b: string, volume: number, depths = { x: 2, y: 3, z: 1 }): any => ({
    a, b, rawA: a, rawB: b, volume,
    region: { min: [0, 0, 0], max: [depths.x, depths.y, depths.z], depths },
    center: [depths.x / 2, depths.y / 2, depths.z / 2],
  });
  const mkReport = (real: any[]): any => ({
    totalParts: 10, totalPairs: 45, testedPairs: real.length, skippedByAABB: 0,
    tolerance: 0.01, pressFitThreshold: 1,
    real, pressFit: [], accepted: [], failures: [], degenerateWarnings: [],
    ok: false, skipped: false,
  });

  it("cross-prefix group fires when N≥3 pairs span two different indexed prefixes with identical overlap", () => {
    // knitting-printer v8 canonical repro: needle-* ↔ solenoid-* mirror pairs.
    const real = [
      mkRecord("needle-1", "solenoid-20", 100),
      mkRecord("needle-2", "solenoid-19", 100),
      mkRecord("needle-3", "solenoid-18", 100),
      mkRecord("needle-4", "solenoid-17", 100),
    ];
    const text = formatCollisionReport(mkReport(real));
    expect(text).toMatch(/Cross-pattern overlap: 4 needle-\* ↔ solenoid-\* pairs/);
    expect(text).toMatch(/two linear \/ grid patterns that share an axis but are misaligned/);
    // Each raw pair should have been GROUPED (not listed individually).
    expect(text).not.toMatch(/- needle-1 ↔ solenoid-20/);
  });

  it("one-to-many group fires when a singleton collides with N≥3 instances of a prefix", () => {
    // Typical repro: chassis colliding with every solenoid-* foot.
    const real = [
      mkRecord("base-chassis", "solenoid-1", 50),
      mkRecord("base-chassis", "solenoid-2", 50),
      mkRecord("base-chassis", "solenoid-3", 50),
      mkRecord("base-chassis", "solenoid-4", 50),
    ];
    const text = formatCollisionReport(mkReport(real));
    expect(text).toMatch(/Shared-surface overlap: base-chassis ↔ 4 solenoid-\* parts/);
    expect(text).toMatch(/every solenoid-\* instance dips into base-chassis/);
    expect(text).toMatch(/the whole solenoid array is offset, not just one instance/);
  });

  it("same-prefix pitch mismatch still fires first, and the rest go to other groupers", () => {
    // Mix both cases in one report: ensure same-prefix wins on its members,
    // cross-prefix wins on its members, both emit design-class hints.
    const real = [
      // Same-prefix (solenoid-* colliding with itself due to pitch overlap)
      mkRecord("solenoid-1", "solenoid-2", 120, { x: 4, y: 60, z: 1 }),
      mkRecord("solenoid-2", "solenoid-3", 120, { x: 4, y: 60, z: 1 }),
      mkRecord("solenoid-3", "solenoid-4", 120, { x: 4, y: 60, z: 1 }),
      // Cross-prefix (needle-* ↔ rail-*)
      mkRecord("needle-1", "rail-1", 10, { x: 2, y: 2, z: 2 }),
      mkRecord("needle-2", "rail-2", 10, { x: 2, y: 2, z: 2 }),
      mkRecord("needle-3", "rail-3", 10, { x: 2, y: 2, z: 2 }),
    ];
    const text = formatCollisionReport(mkReport(real));
    expect(text).toMatch(/Systematic overlap: 3 solenoid-\* pairs/);
    expect(text).toMatch(/Cross-pattern overlap: 3 needle-\* ↔ rail-\* pairs/);
  });
});

describe("extractJoints", () => {
  it("returns introspectable:false when no part declares joints", () => {
    const parts = [mockPart("a"), mockPart("b")];
    const result = extractJoints(parts);
    expect(result.introspectable).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("flags a joint floating off-surface", () => {
    const part = mockPart("frame", {
      aabb: [0, 0, 0, 10, 10, 10],
      joints: { hinge: { position: [50, 50, 50] } },
    });
    const result = extractJoints([part]);
    expect(result.introspectable).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].kind).toBe("floats");
    expect(result.warnings[0].message).toContain("off surface");
    expect(result.ok).toBe(false);
  });

  it("flags a joint buried inside the body", () => {
    const part = mockPart("frame", {
      aabb: [0, 0, 0, 10, 10, 10],
      joints: { core: { position: [5, 5, 5] } },
    });
    const result = extractJoints([part]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].kind).toBe("buried");
    expect(result.warnings[0].message).toContain("inside body");
  });

  it("accepts joints within tolerance of a vertex (ok:true)", () => {
    const part = mockPart("frame", {
      aabb: [0, 0, 0, 1, 1, 1],
      joints: { corner: { position: [0, 0, 0] } }, // exactly at a mock vertex
    });
    const result = extractJoints([part]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("supports `point` and `origin` aliases for the joint position", () => {
    const part = mockPart("frame", {
      aabb: [0, 0, 0, 1, 1, 1],
      joints: {
        a: { point: [0, 0, 0] },
        b: { origin: [1, 1, 1] },
      },
    });
    const result = extractJoints([part]);
    expect(result.joints.length).toBe(2);
    expect(result.joints.find((j) => j.name === "a")?.point).toEqual([0, 0, 0]);
    expect(result.joints.find((j) => j.name === "b")?.point).toEqual([1, 1, 1]);
  });

  it("custom tolerance is respected", () => {
    const part = mockPart("frame", {
      aabb: [0, 0, 0, 10, 10, 10],
      joints: { tip: { position: [10.05, 10, 10] } }, // 0.05 mm off the corner
    });
    // Default tolerance is 0.1 → no warning.
    expect(extractJoints([part]).warnings).toEqual([]);
    // Tighter tolerance → warning.
    expect(extractJoints([part], { tolerance: 0.01 }).warnings.length).toBe(1);
  });
});

describe("formatters — round-trip behaviour", () => {
  it("formatGeometryReport renders a header line + JSON payload", () => {
    const result = extractGeometry([mockPart("solo")]);
    const text = formatGeometryReport(result.report!, "solo.shape.ts");
    expect(text.split("\n")[0]).toContain("describe_geometry: 1 part");
    expect(text).toContain("solo.shape.ts");
    expect(text).toContain('"summary"');
  });

  it("formatCollisionReport says 'skipped' for single-part assemblies", () => {
    const report = extractCollisions([mockPart("solo")]);
    const text = formatCollisionReport(report);
    expect(text).toContain("Collision check skipped");
  });

  it("formatJointReport says 'no introspectable joints' when nothing declared", () => {
    const report = extractJoints([mockPart("a"), mockPart("b")]);
    const text = formatJointReport(report);
    expect(text).toContain("no introspectable joints");
  });
});
