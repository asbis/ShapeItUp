import { describe, it, expect, vi } from "vitest";

// `composeAssembly` never touches OCCT — it just composes plain functions.
// Stub `replicad` so importing the module (which re-exports symbols that
// reference `replicad`) doesn't pull the WASM-backed implementations into
// the vitest runtime. The tests below only exercise composeAssembly and
// never call the joint-based helpers, so the sentinel values are fine.
vi.mock("replicad", () => ({
  compoundShapes: (children: unknown[]) => ({ __mockCompound: true, children }),
  makeSphere: (r: number) => ({
    __mockSphere: true,
    r,
    clone() {
      return this;
    },
    translate() {
      return this;
    },
  }),
}));

import { composeAssembly, stack, stackOnZ } from "./assembly";
import { Part } from "./parts";

// A minimal shape-like stub — has `.clone()` (so normalizeMainResult accepts
// it) and records transform calls without invoking OCCT. Each clone returns
// a DISTINCT object so the test can assert that `transform` received a
// cloned copy and not the original handle.
function makeMockShape(label: string): any {
  const self: any = {
    __mockShape: true,
    label,
    clones: 0,
    clone() {
      self.clones += 1;
      // Return a sibling object (same prototype, fresh identity) so callers
      // can detect that a clone occurred.
      const child: any = { ...self, __isClone: true };
      child.clone = self.clone.bind(self);
      return child;
    },
  };
  return self;
}

describe("composeAssembly — param merging", () => {
  it("merges disjoint param dicts and dispatches main() to every child", () => {
    const bodyShape = makeMockShape("body");
    const camShape = makeMockShape("cam");
    const bodyMain = vi.fn((_p?: Record<string, number>) => bodyShape);
    const camMain = vi.fn((_p?: Record<string, number>) => camShape);

    const { main, params } = composeAssembly({
      parts: [
        { main: bodyMain, params: { bodyWidth: 80, bodyHeight: 40 } },
        { main: camMain, params: { camRadius: 10 } },
      ],
    });

    expect(params).toEqual({ bodyWidth: 80, bodyHeight: 40, camRadius: 10 });
    const result = main();
    expect(bodyMain).toHaveBeenCalledTimes(1);
    expect(camMain).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0].shape).toBe(bodyShape);
    expect(result[1].shape).toBe(camShape);
  });

  it("throws with a message naming BOTH parts when params collide", () => {
    // Named factories so the message quotes "makeBody" / "makeCam" rather
    // than an opaque index — mirrors the real SKILL.md pattern where users
    // declare `export function makeBody(...)`.
    function makeBody() {
      return makeMockShape("body");
    }
    function makeCam() {
      return makeMockShape("cam");
    }
    expect(() =>
      composeAssembly({
        parts: [
          { main: makeBody, params: { width: 80 } },
          { main: makeCam, params: { width: 12 } },
        ],
      }),
    ).toThrow(/"width".*"makeBody".*"makeCam"/);
  });
});

describe("composeAssembly — override dispatching", () => {
  it("passes only the keys each part declared to its sub-main", () => {
    const bodyMain = vi.fn((_p?: Record<string, number>) => makeMockShape("body"));
    const camMain = vi.fn((_p?: Record<string, number>) => makeMockShape("cam"));
    const { main } = composeAssembly({
      parts: [
        { main: bodyMain, params: { bodyWidth: 80 } },
        { main: camMain, params: { camRadius: 10 } },
      ],
    });
    main({ bodyWidth: 99, camRadius: 15, stray: 7 });
    expect(bodyMain).toHaveBeenCalledWith({ bodyWidth: 99 });
    expect(camMain).toHaveBeenCalledWith({ camRadius: 15 });
  });

  it("falls back to declared defaults for keys the caller didn't override", () => {
    const bodyMain = vi.fn((_p?: Record<string, number>) => makeMockShape("body"));
    const { main } = composeAssembly({
      parts: [{ main: bodyMain, params: { a: 1, b: 2 } }],
    });
    main({ a: 42 });
    expect(bodyMain).toHaveBeenCalledWith({ a: 42, b: 2 });
  });

  it("passes `undefined` to a child that declared no params at all", () => {
    const bodyMain = vi.fn((_p?: Record<string, number>) => makeMockShape("body"));
    const { main } = composeAssembly({
      parts: [{ main: bodyMain }],
    });
    main({ stray: 1 });
    expect(bodyMain).toHaveBeenCalledWith(undefined);
  });
});

describe("composeAssembly — transform + cloning", () => {
  it("invokes transform on each produced entry, after cloning the shape", () => {
    const orig = makeMockShape("body");
    const bodyMain = vi.fn(() => orig);
    const seen: any[] = [];
    const transform = vi.fn((p: any) => {
      seen.push(p.shape);
      return { ...p, name: "body-transformed" };
    });
    const { main } = composeAssembly({
      parts: [{ main: bodyMain, params: { w: 1 }, transform }],
    });
    const [out] = main();
    expect(transform).toHaveBeenCalledTimes(1);
    expect(out.name).toBe("body-transformed");
    // The clone counter must have incremented — transform received a fresh
    // handle, not the caller's original.
    expect(orig.clones).toBe(1);
    expect(seen[0]).not.toBe(orig);
    expect(seen[0].__isClone).toBe(true);
  });
});

describe("composeAssembly — normalization of main() return shapes", () => {
  it("accepts a raw Shape3D", () => {
    const s = makeMockShape("raw");
    const { main } = composeAssembly({ parts: [{ main: () => s }] });
    const result = main();
    expect(result).toHaveLength(1);
    expect(result[0].shape).toBe(s);
  });

  it("accepts a single { shape, name, color } object and preserves metadata", () => {
    const s = makeMockShape("wrapped");
    const { main } = composeAssembly({
      parts: [{ main: () => ({ shape: s, name: "body", color: "#abc123", qty: 3 }) }],
    });
    const [out] = main();
    expect(out.shape).toBe(s);
    expect(out.name).toBe("body");
    expect(out.color).toBe("#abc123");
    expect(out.qty).toBe(3);
  });

  it("accepts an array of mixed raw / wrapped entries", () => {
    const a = makeMockShape("a");
    const b = makeMockShape("b");
    const { main } = composeAssembly({
      parts: [{ main: () => [a, { shape: b, name: "B" }] }],
    });
    const result = main();
    expect(result).toHaveLength(2);
    expect(result[0].shape).toBe(a);
    expect(result[1].shape).toBe(b);
    expect(result[1].name).toBe("B");
  });
});

describe("composeAssembly — input validation", () => {
  it("throws on empty parts array", () => {
    expect(() => composeAssembly({ parts: [] })).toThrow(/non-empty/);
  });

  it("throws when main is not a function", () => {
    expect(() =>
      composeAssembly({ parts: [{ main: "not-a-function" as any }] }),
    ).toThrow(/main must be a function/);
  });

  it("throws when transform is not a function", () => {
    expect(() =>
      composeAssembly({
        parts: [{ main: () => makeMockShape("x"), transform: 42 as any }],
      }),
    ).toThrow(/transform must be a function/);
  });

  it("throws when params is not a plain object", () => {
    expect(() =>
      composeAssembly({
        parts: [{ main: () => makeMockShape("x"), params: [1, 2] as any }],
      }),
    ).toThrow(/params must be a plain object/);
  });
});

// ---------------------------------------------------------------------------
// `stack` / `stackOnZ` — bbox-driven stacking along a principal axis.
//
// Build Parts backed by a BoxMock Shape3D stand-in that tracks its own
// bounding box through .translate() / .clone() calls. No OCCT involvement;
// the math under test is pure TypeScript.
// ---------------------------------------------------------------------------

type Bounds3 = [[number, number, number], [number, number, number]];

/**
 * Axis-aligned mock box with a bounding box that moves under .translate().
 * Implements only the surface area stack() needs: `clone`, `translate`,
 * and `boundingBox.bounds`. .rotate() is a no-op (stack doesn't use it).
 */
function boxShape(min: [number, number, number], max: [number, number, number]): any {
  const self: any = {
    __boxMock: true,
    boundingBox: { bounds: [min.slice(), max.slice()] as Bounds3 },
    clone() {
      return boxShape(
        self.boundingBox.bounds[0] as [number, number, number],
        self.boundingBox.bounds[1] as [number, number, number],
      );
    },
    translate(dx: number, dy: number, dz: number) {
      const [mn, mx] = self.boundingBox.bounds;
      return boxShape(
        [mn[0] + dx, mn[1] + dy, mn[2] + dz],
        [mx[0] + dx, mx[1] + dy, mx[2] + dz],
      );
    },
    rotate() {
      return self;
    },
    mirror() {
      return self;
    },
  };
  return self;
}

function boxPart(
  min: [number, number, number],
  max: [number, number, number],
  name?: string,
): Part {
  return new Part(boxShape(min, max), { name });
}

/** Read the world-space bbox of a positioned Part. */
function bboxOf(p: Part): Bounds3 {
  return p.worldShape().boundingBox.bounds as Bounds3;
}

describe("stackOnZ — regression: behaves like the old +Z implementation", () => {
  it("stacks three unit cubes along +Z with zero gap", () => {
    const a = boxPart([0, 0, 0], [10, 10, 5]);
    const b = boxPart([0, 0, 0], [10, 10, 3]);
    const c = boxPart([0, 0, 0], [10, 10, 7]);
    const [a0, b0, c0] = stackOnZ([a, b, c]);
    expect(bboxOf(a0)).toEqual([[0, 0, 0], [10, 10, 5]]);
    expect(bboxOf(b0)[0][2]).toBeCloseTo(5);
    expect(bboxOf(b0)[1][2]).toBeCloseTo(8);
    expect(bboxOf(c0)[0][2]).toBeCloseTo(8);
    expect(bboxOf(c0)[1][2]).toBeCloseTo(15);
  });

  it("applies a uniform gap between parts", () => {
    const a = boxPart([0, 0, 0], [10, 10, 4]);
    const b = boxPart([0, 0, 0], [10, 10, 6]);
    const [, b0] = stackOnZ([a, b], { gap: 2 });
    expect(bboxOf(b0)[0][2]).toBeCloseTo(6); // 4 + 2
    expect(bboxOf(b0)[1][2]).toBeCloseTo(12); // 6 + 2 + 4
  });

  it("matches stack({ axis: '+Z' }) exactly (wrapper fidelity)", () => {
    const parts = [
      boxPart([0, 0, 0], [10, 10, 5]),
      boxPart([0, 0, 0], [10, 10, 3]),
      boxPart([0, 0, 0], [10, 10, 7]),
    ];
    const viaLegacy = stackOnZ(parts, { gap: 1.5 }).map(bboxOf);
    const viaGeneral = stack(parts, { axis: "+Z", gap: 1.5 }).map(bboxOf);
    expect(viaGeneral).toEqual(viaLegacy);
  });

  it("returns an empty array for empty input", () => {
    expect(stackOnZ([])).toEqual([]);
  });

  it("passes the first part through unchanged", () => {
    const a = boxPart([1, 2, 3], [11, 12, 13]);
    const [a0] = stackOnZ([a]);
    expect(a0).toBe(a);
  });
});

describe("stack — generalized axis + alignment", () => {
  it("stacks along +X with center transverse alignment", () => {
    // First part centred at (5, 5, 2.5); boxes of varying extents in YZ.
    const a = boxPart([0, 0, 0], [10, 10, 5]);
    const b = boxPart([0, -2, -1], [4, 6, 9]); // centre Y=2, Z=4
    const [, b0] = stack([a, b], { axis: "+X" });
    const bb = bboxOf(b0);
    // Axial: b's min-X must sit on a's max-X (10).
    expect(bb[0][0]).toBeCloseTo(10);
    expect(bb[1][0]).toBeCloseTo(14);
    // Transverse: b's Y-centre must match a's Y-centre (5). b's local Y
    // extent is 8 (from -2 to 6, centre 2) → shifted by +3.
    expect((bb[0][1] + bb[1][1]) / 2).toBeCloseTo(5);
    expect((bb[0][2] + bb[1][2]) / 2).toBeCloseTo(2.5);
  });

  it("stacks downward along -Z", () => {
    const a = boxPart([0, 0, 0], [10, 10, 4]);
    const b = boxPart([0, 0, 0], [10, 10, 6]);
    const [, b0] = stack([a, b], { axis: "-Z" });
    const bb = bboxOf(b0);
    // b's top face meets a's bottom face (0).
    expect(bb[1][2]).toBeCloseTo(0);
    expect(bb[0][2]).toBeCloseTo(-6);
  });

  it("-Z stack respects per-pair gap", () => {
    const a = boxPart([0, 0, 0], [10, 10, 4]);
    const b = boxPart([0, 0, 0], [10, 10, 6]);
    const [, b0] = stack([a, b], { axis: "-Z", gap: 3 });
    const bb = bboxOf(b0);
    // Top of b = 0 - 3 = -3; bottom = -3 - 6 = -9.
    expect(bb[1][2]).toBeCloseTo(-3);
    expect(bb[0][2]).toBeCloseTo(-9);
  });

  it("accepts a per-pair gap array", () => {
    const a = boxPart([0, 0, 0], [10, 10, 2]);
    const b = boxPart([0, 0, 0], [10, 10, 3]);
    const c = boxPart([0, 0, 0], [10, 10, 4]);
    // Gaps: 1 between a&b, 5 between b&c.
    const [, b0, c0] = stack([a, b, c], { gap: [1, 5] });
    expect(bboxOf(b0)[0][2]).toBeCloseTo(3); // 2 + 1
    expect(bboxOf(b0)[1][2]).toBeCloseTo(6);
    expect(bboxOf(c0)[0][2]).toBeCloseTo(11); // 6 + 5
    expect(bboxOf(c0)[1][2]).toBeCloseTo(15);
  });

  it("throws when the gap array length mismatches parts.length - 1", () => {
    const a = boxPart([0, 0, 0], [10, 10, 2]);
    const b = boxPart([0, 0, 0], [10, 10, 3]);
    const c = boxPart([0, 0, 0], [10, 10, 4]);
    expect(() => stack([a, b, c], { gap: [1, 2, 3] })).toThrow(
      /gap array length 3 does not match parts\.length - 1 = 2/,
    );
    expect(() => stack([a, b, c], { gap: [1] })).toThrow(/length 1/);
  });

  it("align: 'min' aligns transverse min faces of subsequent parts with the first", () => {
    const a = boxPart([0, 0, 0], [10, 20, 5]);
    // Smaller in XY, centred at its own origin.
    const b = boxPart([0, 0, 0], [4, 6, 3]);
    const [, bMin] = stack([a, b], { axis: "+Z", align: "min" });
    const [, bCenter] = stack([a, b], { axis: "+Z", align: "center" });
    const bbMin = bboxOf(bMin);
    const bbCenter = bboxOf(bCenter);
    // With align: "min", b's min-X/Y should line up at 0 / 0.
    expect(bbMin[0][0]).toBeCloseTo(0);
    expect(bbMin[0][1]).toBeCloseTo(0);
    // With align: "center", b's centre should sit at (5, 10, ...).
    expect((bbCenter[0][0] + bbCenter[1][0]) / 2).toBeCloseTo(5);
    expect((bbCenter[0][1] + bbCenter[1][1]) / 2).toBeCloseTo(10);
    // Concretely different placements.
    expect(bbMin[0][0]).not.toBeCloseTo(bbCenter[0][0]);
    expect(bbMin[0][1]).not.toBeCloseTo(bbCenter[0][1]);
  });

  it("align: 'max' aligns transverse max faces", () => {
    const a = boxPart([0, 0, 0], [10, 20, 5]);
    const b = boxPart([0, 0, 0], [4, 6, 3]);
    const [, bMax] = stack([a, b], { axis: "+Z", align: "max" });
    const bb = bboxOf(bMax);
    expect(bb[1][0]).toBeCloseTo(10);
    expect(bb[1][1]).toBeCloseTo(20);
  });

  it("does not mutate the input parts array", () => {
    const a = boxPart([0, 0, 0], [10, 10, 5]);
    const b = boxPart([0, 0, 0], [10, 10, 3]);
    const inputs = [a, b];
    const out = stack(inputs, { axis: "+Z", gap: 2 });
    expect(inputs).toEqual([a, b]);
    expect(out).not.toBe(inputs);
    // First part pointer-equal to input (passed through), second is new.
    expect(out[0]).toBe(a);
    expect(out[1]).not.toBe(b);
  });

  it("returns [] for empty input", () => {
    expect(stack([])).toEqual([]);
  });
});
