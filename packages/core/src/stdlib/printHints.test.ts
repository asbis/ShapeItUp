import { describe, it, expect, beforeEach } from "vitest";
import * as printHints from "./printHints";
import { drainRuntimeWarnings, resetRuntimeWarnings } from "./warnings";

// ---------------------------------------------------------------------------
// API surface — pin the exported names so a rename or accidental deletion
// surfaces as a test failure. Rest of the suite exercises behaviour via a
// mock Shape3D (no OCCT required); these tests keep working even when the
// WASM bundle is absent.
// ---------------------------------------------------------------------------

describe("printHints — API surface", () => {
  it("exports flatForPrint", () => {
    expect(typeof printHints.flatForPrint).toBe("function");
  });
  it("exports layoutOnBed", () => {
    expect(typeof printHints.layoutOnBed).toBe("function");
  });
  it("preserves prior helpers (elephantFootChamfer / overhangChamfer / firstLayerPad)", () => {
    expect(typeof printHints.elephantFootChamfer).toBe("function");
    expect(typeof printHints.overhangChamfer).toBe("function");
    expect(typeof printHints.firstLayerPad).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Mock Shape3D helpers — record every .rotate() / .translate() / .clone()
// call and expose a configurable bounding box + face list. Mirrors the
// holes.test pattern so the suite runs without OCCT.
// ---------------------------------------------------------------------------

interface MockCall {
  kind: "rotate" | "translate" | "clone";
  args: unknown[];
}

interface MockShapeOpts {
  bounds: [[number, number, number], [number, number, number]];
  /** Face objects returned by the .faces accessor. */
  faces?: Array<{
    geomType?: string;
    orientation?: "forward" | "backward";
    normalAt?: () => { x: number; y: number; z: number } | null;
    /** Optional stubbed area used by the outerWire fallback path. */
    outerWire?: () => { boundingBox: { bounds: [[number, number], [number, number]] } };
  }>;
  /** Post-rotate bounds override (so tests can assert on a "rotated" shape's bbox). */
  postRotateBounds?: [[number, number, number], [number, number, number]];
  /** Post-translate delta accumulator (so chained translates are reflected in bounds). */
  applyTranslateToBounds?: boolean;
}

function makeMockShape(opts: MockShapeOpts) {
  const calls: MockCall[] = [];
  let bounds = opts.bounds;
  const shape: any = {
    calls,
    get boundingBox() {
      return { bounds };
    },
    get faces() {
      return opts.faces ?? [];
    },
    clone() {
      calls.push({ kind: "clone", args: [] });
      // Return a NEW mock that shares the call log + bounds — simulates a
      // proper replicad clone that carries the same geometry forward.
      return shape;
    },
    rotate(angle: number, origin: number[], direction: number[]) {
      calls.push({ kind: "rotate", args: [angle, origin, direction] });
      if (opts.postRotateBounds) bounds = opts.postRotateBounds;
      return shape;
    },
    translate(dx: number, dy: number, dz: number) {
      calls.push({ kind: "translate", args: [dx, dy, dz] });
      if (opts.applyTranslateToBounds ?? true) {
        bounds = [
          [bounds[0][0] + dx, bounds[0][1] + dy, bounds[0][2] + dz],
          [bounds[1][0] + dx, bounds[1][1] + dy, bounds[1][2] + dz],
        ];
      }
      return shape;
    },
  };
  return shape;
}

/** Build a mock planar face with a fixed outward normal + a stubbed area proxy. */
function makePlanarFace(
  normal: [number, number, number],
  outerBbox: [[number, number], [number, number]],
  orientation: "forward" | "backward" = "forward",
) {
  return {
    geomType: "PLANE" as const,
    orientation,
    normalAt: () => ({ x: normal[0], y: normal[1], z: normal[2] }),
    outerWire: () => ({ boundingBox: { bounds: outerBbox } }),
  };
}

// ---------------------------------------------------------------------------
// flatForPrint — core behaviour
//
// Strategy: build a 10×10×5 "plate" whose +Z face is the largest planar face.
// The expected rotation aligns +Z with -Z (a 180° flip about X). After the
// flip, the bbox min Z is -0 (was Z=0 pre-flip, flipped to 0) — but we
// construct a postRotateBounds that mimics the post-rotation geometry so the
// translate-to-zero step is observable.
// ---------------------------------------------------------------------------

describe("flatForPrint — behaviour", () => {
  beforeEach(() => {
    resetRuntimeWarnings();
  });

  it("picks the largest planar face and rotates its normal to -Z", () => {
    // A 10x10x5 slab with the large face at Z=5 pointing +Z (10x10 = 100 area)
    // and a side face at +X pointing +X (5x10 = 50 area). Expected: rotate
    // +Z → -Z = 180° about X (antiparallel branch picks a perp axis).
    const shape = makeMockShape({
      bounds: [[0, 0, 0], [10, 10, 5]],
      faces: [
        // +Z face — 10x10 large area (should win)
        makePlanarFace([0, 0, 1], [[0, 0], [10, 10]]),
        // +X face — 5x10 smaller
        makePlanarFace([1, 0, 0], [[0, 0], [5, 10]]),
      ],
      // Simulate post-180°-flip: bbox Z flips sign. Original Z ∈ [0, 5]
      // becomes Z ∈ [-5, 0].
      postRotateBounds: [[0, 0, -5], [10, 10, 0]],
    });

    const result = printHints.flatForPrint(shape as any);

    // Clone happened first (caller's shape must not be mutated).
    expect(shape.calls[0]).toEqual({ kind: "clone", args: [] });

    // A rotate call was recorded — the +Z vs -Z antiparallel case fires a
    // 180° rotation about an axis perpendicular to +Z (helper picks +X).
    const rotateCalls = shape.calls.filter((c: MockCall) => c.kind === "rotate");
    expect(rotateCalls).toHaveLength(1);
    const [angle, origin, direction] = rotateCalls[0].args as [number, number[], number[]];
    expect(angle).toBe(180);
    expect(origin).toEqual([0, 0, 0]);
    // Axis must be unit length and perpendicular to +Z.
    expect(Math.hypot(direction[0], direction[1], direction[2])).toBeCloseTo(1, 6);
    expect(direction[2]).toBeCloseTo(0, 6);

    // Final translate must zero the bottom — post-rotate min Z was -5,
    // so translate dz = +5.
    const translateCalls = shape.calls.filter((c: MockCall) => c.kind === "translate");
    expect(translateCalls).toHaveLength(1);
    expect(translateCalls[0].args).toEqual([0, 0, 5]);

    // Success warning emitted.
    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => w.includes("flatForPrint"))).toBe(true);

    expect(result).toBe(shape);
  });

  it("no planar faces — skips rotation, translates bottom to Z=0, warns", () => {
    // Cylinder-only shape: no planar faces. flatForPrint should skip the
    // rotation step, translate to Z=0, and emit a warning naming the
    // fallback path.
    const shape = makeMockShape({
      bounds: [[-2, -2, 3], [2, 2, 10]],
      faces: [
        // Curved faces only.
        { geomType: "CYLINDRE" },
        { geomType: "CYLINDRE" },
      ],
    });

    printHints.flatForPrint(shape as any);

    const rotateCalls = shape.calls.filter((c: MockCall) => c.kind === "rotate");
    expect(rotateCalls).toHaveLength(0);

    const translateCalls = shape.calls.filter((c: MockCall) => c.kind === "translate");
    expect(translateCalls).toHaveLength(1);
    // min Z was 3, so dz = -3.
    expect(translateCalls[0].args).toEqual([0, 0, -3]);

    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => w.includes("no planar faces"))).toBe(true);
  });

  it("face with orientation='backward' flips the normal direction", () => {
    // A face whose geometric normal is +Z but orientation is "backward"
    // means the outward direction is actually -Z — i.e. the face is
    // already pointing INTO the bed. No rotation needed.
    const shape = makeMockShape({
      bounds: [[0, 0, 0], [10, 10, 5]],
      faces: [
        makePlanarFace([0, 0, 1], [[0, 0], [10, 10]], "backward"),
      ],
    });

    printHints.flatForPrint(shape as any);
    const rotateCalls = shape.calls.filter((c: MockCall) => c.kind === "rotate");
    // Outward normal = -Z already, rotation-aligning with -Z returns null
    // (no rotation needed).
    expect(rotateCalls).toHaveLength(0);
    // Still translates bottom to Z=0: min Z was 0 so dz=0 (allow ±0 equality,
    // since `-min` of +0 is -0 under JS IEEE-754).
    const translateCalls = shape.calls.filter((c: MockCall) => c.kind === "translate");
    expect(translateCalls).toHaveLength(1);
    const [dx, dy, dz] = translateCalls[0].args as [number, number, number];
    expect(dx).toBe(0);
    expect(dy).toBe(0);
    expect(Math.abs(dz)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// layoutOnBed — shelf pack
//
// Three boxes: 50x50x10, 60x60x10, 200x40x10. With bedWidth=100 the third
// box wraps to a new shelf. Verify x/y packing positions and gap=5 default.
// ---------------------------------------------------------------------------

describe("layoutOnBed — shelf pack", () => {
  beforeEach(() => {
    resetRuntimeWarnings();
  });

  it("packs multiple shapes left-to-right, wrapping on bedWidth", () => {
    // Three shapes with known bboxes. The third forces a wrap at bedWidth=100.
    const s1 = makeMockShape({ bounds: [[0, 0, 0], [50, 50, 10]] });
    const s2 = makeMockShape({ bounds: [[0, 0, 0], [40, 40, 10]] });
    // Too wide for the remaining shelf; also too wide for its own shelf
    // at X=0 (120 > 100), but our policy is "place oversized solo shapes
    // anyway" — verify that behaviour.
    const s3 = makeMockShape({ bounds: [[0, 0, 0], [120, 30, 10]] });

    printHints.layoutOnBed([s1 as any, s2 as any, s3 as any], {
      spacing: 5,
      bedWidth: 100,
    });

    // s1: placed at (0, 0), min was (0,0,0) → translate (0,0,0).
    const t1 = s1.calls.filter((c: MockCall) => c.kind === "translate");
    expect(t1).toHaveLength(1);
    expect(t1[0].args).toEqual([0, 0, 0]);

    // After s1, cursorX = 50 + 5 = 55. s2 width 40 → 55+40 = 95 ≤ 100, fits.
    // s2 placed at (55, 0).
    const t2 = s2.calls.filter((c: MockCall) => c.kind === "translate");
    expect(t2).toHaveLength(1);
    expect(t2[0].args).toEqual([55, 0, 0]);

    // After s2, cursorX = 95 + 5 = 100. s3 width 120 → 100+120 = 220 > 100,
    // wrap to new shelf at y = 0 + 50 (s1 depth) + 5 = 55. s3 placed at (0, 55).
    const t3 = s3.calls.filter((c: MockCall) => c.kind === "translate");
    expect(t3).toHaveLength(1);
    expect(t3[0].args).toEqual([0, 55, 0]);

    // Summary warning was emitted.
    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => w.includes("layoutOnBed: packed 3"))).toBe(true);
  });

  it("returns [] for empty input without warning", () => {
    const result = printHints.layoutOnBed([]);
    expect(result).toEqual([]);
    const warnings = drainRuntimeWarnings();
    expect(warnings).toEqual([]);
  });

  it("shifts shape whose bbox min is not at origin so its min lands at cursor", () => {
    // Shape bbox min = (10, 20, 0), max = (40, 50, 5). Expected translate at
    // shelf origin: (dx, dy) = (0 - 10, 0 - 20) = (-10, -20).
    const s = makeMockShape({ bounds: [[10, 20, 0], [40, 50, 5]] });
    printHints.layoutOnBed([s as any], { spacing: 5, bedWidth: 100 });
    const t = s.calls.filter((c: MockCall) => c.kind === "translate");
    expect(t[0].args).toEqual([-10, -20, 0]);
  });
});
