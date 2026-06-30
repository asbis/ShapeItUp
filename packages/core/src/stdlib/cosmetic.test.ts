import { describe, it, expect, vi } from "vitest";

/**
 * Cosmetic helpers wrap Replicad's `shape.fillet` / `shape.chamfer` with
 * canned finder recipes and a no-throw error path. Tests use a mock
 * Shape3D so we can assert the recipe (fillet vs. chamfer, finder
 * call sequence) without driving WASM/OCCT.
 */

interface MockFinder {
  calls: Array<{ method: string; arg?: unknown }>;
  inDirection(dir: string): MockFinder;
  inPlane(plane: string, offset?: number): MockFinder;
  ofCurveType(type: string): MockFinder;
}

function mockFinder(): MockFinder {
  const calls: MockFinder["calls"] = [];
  const f: MockFinder = {
    calls,
    inDirection(dir) { calls.push({ method: "inDirection", arg: dir }); return f; },
    inPlane(plane, offset) { calls.push({ method: "inPlane", arg: { plane, offset } }); return f; },
    ofCurveType(type) { calls.push({ method: "ofCurveType", arg: type }); return f; },
  };
  return f;
}

interface MockShape {
  filletCalls: Array<{ radius: number; finder?: MockFinder }>;
  chamferCalls: Array<{ distance: number; finder?: MockFinder }>;
  failOn?: "fillet" | "chamfer";
  fillet(radius: number, finderFn?: (e: MockFinder) => MockFinder): MockShape;
  chamfer(distance: number, finderFn?: (e: MockFinder) => MockFinder): MockShape;
}

function mockShape(failOn?: "fillet" | "chamfer"): MockShape {
  const self: MockShape = {
    filletCalls: [],
    chamferCalls: [],
    failOn,
    fillet(radius, finderFn) {
      if (self.failOn === "fillet") throw new Error("no edges matched");
      const finder = finderFn ? finderFn(mockFinder()) : undefined;
      self.filletCalls.push({ radius, finder });
      return self;
    },
    chamfer(distance, finderFn) {
      if (self.failOn === "chamfer") throw new Error("no edges matched");
      const finder = finderFn ? finderFn(mockFinder()) : undefined;
      self.chamferCalls.push({ distance, finder });
      return self;
    },
  };
  return self;
}

// Replicad's EdgeFinder is only re-exported by cosmetic.ts for typed-import
// jump-to-source — the helpers never instantiate it. Stub the class so
// the import resolves under vitest.
vi.mock("replicad", async () => {
  const actual = await vi.importActual<any>("replicad");
  return {
    ...actual,
    EdgeFinder: class { /* stub */ },
  };
});

import {
  softenVerticalEdges,
  softenTopEdges,
  bottomChamfer,
  softenAllEdges,
  softenCircularEdges,
} from "./cosmetic";

describe("cosmetic — fillet / chamfer recipes", () => {
  it("softenVerticalEdges calls fillet with inDirection('Z')", () => {
    const s = mockShape();
    softenVerticalEdges(s as any, 2);
    expect(s.filletCalls).toHaveLength(1);
    expect(s.filletCalls[0].radius).toBe(2);
    expect(s.filletCalls[0].finder!.calls).toEqual([
      { method: "inDirection", arg: "Z" },
    ]);
  });

  it("softenTopEdges calls fillet with inPlane('XY', topZ)", () => {
    const s = mockShape();
    softenTopEdges(s as any, 10, 0.5);
    expect(s.filletCalls).toHaveLength(1);
    expect(s.filletCalls[0].radius).toBe(0.5);
    expect(s.filletCalls[0].finder!.calls).toEqual([
      { method: "inPlane", arg: { plane: "XY", offset: 10 } },
    ]);
  });

  it("bottomChamfer calls chamfer with inPlane('XY', bottomZ) — defaults to 0", () => {
    const s = mockShape();
    bottomChamfer(s as any, 0.4);
    expect(s.chamferCalls).toHaveLength(1);
    expect(s.chamferCalls[0].distance).toBe(0.4);
    expect(s.chamferCalls[0].finder!.calls).toEqual([
      { method: "inPlane", arg: { plane: "XY", offset: 0 } },
    ]);
  });

  it("bottomChamfer accepts an explicit bottomZ", () => {
    const s = mockShape();
    bottomChamfer(s as any, 0.4, -5);
    expect(s.chamferCalls[0].finder!.calls).toEqual([
      { method: "inPlane", arg: { plane: "XY", offset: -5 } },
    ]);
  });

  it("softenAllEdges calls fillet WITHOUT a finder", () => {
    const s = mockShape();
    softenAllEdges(s as any, 1);
    expect(s.filletCalls).toHaveLength(1);
    expect(s.filletCalls[0].finder).toBeUndefined();
  });

  it("softenCircularEdges calls fillet with ofCurveType('CIRCLE')", () => {
    const s = mockShape();
    softenCircularEdges(s as any, 0.3);
    expect(s.filletCalls).toHaveLength(1);
    expect(s.filletCalls[0].finder!.calls).toEqual([
      { method: "ofCurveType", arg: "CIRCLE" },
    ]);
  });

  it("returns the input shape unchanged when the finder matches nothing", () => {
    const s = mockShape("fillet");
    const out = softenVerticalEdges(s as any, 1);
    expect(out).toBe(s);
  });

  it("returns the input shape unchanged when chamfer fails too", () => {
    const s = mockShape("chamfer");
    const out = bottomChamfer(s as any, 0.4);
    expect(out).toBe(s);
  });
});
