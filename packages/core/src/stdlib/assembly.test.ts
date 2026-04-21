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

import { composeAssembly } from "./assembly";

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
