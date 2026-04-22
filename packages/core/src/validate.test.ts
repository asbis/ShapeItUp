import { describe, it, expect } from "vitest";
import { validateParts, __test__ } from "./validate";
import type { PartInput } from "./tessellate";

// ---------------------------------------------------------------------------
// Unit coverage for Fix #5 — narrowed geometry-validation diagnostics.
//
// We don't have a real OCCT instance here. The kernel is mocked just far
// enough to make `validateParts` (a) decide the shape is invalid, (b) take
// the narrowing/classification path, and (c) embed the bbox suffix in the
// error message. classifyFailure() itself is also exercised directly since
// it's pure logic.
// ---------------------------------------------------------------------------

const { classifyFailure, formatLocation, describeFailure } = __test__;

function mockReplicad(opts: {
  volume: number;
  shellCount: number;
  isValid?: boolean;
}) {
  // Minimal subset of what validateParts touches on the `oc` handle.
  const oc: any = {
    BRepCheck_Analyzer: class {
      constructor(_w: any, _a: boolean, _b: boolean) {}
      IsValid_2() { return opts.isValid ?? false; }
      delete() {}
    },
    TopAbs_ShapeEnum: { TopAbs_SHELL: 4, TopAbs_SHAPE: 0 },
    TopExp_Explorer: class {
      private _remaining: number;
      constructor(_w: any, _t: number, _a: number) {
        this._remaining = opts.shellCount;
      }
      More() { return this._remaining > 0; }
      Next() { this._remaining--; }
      delete() {}
    },
  };
  return {
    getOC: () => oc,
    measureShapeVolumeProperties: (_s: any) => ({
      volume: opts.volume,
      delete() {},
    }),
  };
}

function mockShape(bbox: {
  min: [number, number, number];
  max: [number, number, number];
}): any {
  return {
    wrapped: {},
    boundingBox: { bounds: [bbox.min, bbox.max] },
  };
}

describe("classifyFailure — picks a single most-likely cause", () => {
  const bbox = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 10] as [number, number, number] };

  it("flags 'open-shell' when volume is near zero relative to bbox", () => {
    const r = classifyFailure(0, bbox, 1);
    expect(r.cls).toBe("open-shell");
  });

  it("flags 'open-shell' when volume is NaN (measurement failed)", () => {
    const r = classifyFailure(NaN, bbox, 1);
    expect(r.cls).toBe("open-shell");
  });

  it("flags 'non-manifold' when volume is healthy but shells > 1", () => {
    const r = classifyFailure(500, bbox, 3);
    expect(r.cls).toBe("non-manifold");
    expect(r.shellCount).toBe(3);
  });

  it("falls back to 'unknown' when no heuristic matches and no exception string", () => {
    const r = classifyFailure(500, bbox, 1);
    expect(r.cls).toBe("unknown");
  });

  it("promotes to 'self-intersection' when exception string names it", () => {
    const r = classifyFailure(500, bbox, 1, "Self-intersecting wire detected");
    expect(r.cls).toBe("self-intersection");
  });

  it("promotes to 'self-intersection' on 'BRep_API' evidence", () => {
    const r = classifyFailure(500, bbox, 1, "BRep_API: command not done");
    expect(r.cls).toBe("self-intersection");
  });
});

describe("formatLocation / describeFailure", () => {
  it("embeds bbox coordinates with 1-decimal formatting", () => {
    const loc = formatLocation({
      min: [0, -2.5, 0],
      max: [10.25, 2.5, 4.0],
    });
    expect(loc).toContain("bbox (");
    expect(loc).toContain("0..10.3");
    expect(loc).toContain("-2.5..2.5");
    expect(loc).toContain("0..4.0");
  });

  it("returns empty string when bbox unavailable", () => {
    expect(formatLocation(null)).toBe("");
  });

  it("describes non-manifold with the shell count", () => {
    expect(describeFailure("non-manifold", 4)).toContain("4 shells");
  });
});

describe("validateParts — emits narrowed error messages", () => {
  function makePart(): PartInput {
    return {
      shape: mockShape({ min: [0, 0, 0], max: [10, 10, 10] }),
      name: "widget",
      color: null,
    };
  }

  it("emits 'open shell' category and bbox location for a near-zero-volume part", () => {
    const rep = mockReplicad({ volume: 0, shellCount: 1, isValid: false });
    const issues = validateParts([makePart()], rep);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("error");
    expect(issues[0].message).toMatch(/open shell|missing face/i);
    expect(issues[0].message).toContain("bbox (");
    // And crucially — the old "Likely self-intersection, non-manifold
    // topology, OR open shell" grab-bag wording is gone.
    expect(issues[0].message).not.toMatch(/self-intersection, non-manifold/i);
  });

  it("emits 'disconnected/non-manifold' with shell count when shells > 1", () => {
    const rep = mockReplicad({ volume: 500, shellCount: 3, isValid: false });
    const issues = validateParts([makePart()], rep);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/non-manifold/i);
    expect(issues[0].message).toContain("3 shells");
  });

  it("emits 'unknown' with raw probe values when no heuristic fires", () => {
    // IsValid_2()→false but volume healthy, one shell, no exception string.
    // Used to mis-label as "self-intersection"; must now surface the three
    // probe numbers and steer at verify_shape instead of guessing.
    const rep = mockReplicad({ volume: 500, shellCount: 1, isValid: false });
    const issues = validateParts([makePart()], rep);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toMatch(/self-intersection/i);
    expect(issues[0].message).toMatch(/could not auto-classify/i);
    expect(issues[0].message).toContain("shellCount=1");
    expect(issues[0].message).toContain("volume=500.0");
    expect(issues[0].message).toContain("bboxVolume=1000.0");
    expect(issues[0].message).toMatch(/verify_shape/);
    expect(issues[0].diagnostics).toEqual({
      volume: 500,
      bboxVolume: 1000,
      shellCount: 1,
    });
  });

  it("attaches diagnostics to every error-severity issue", () => {
    const rep = mockReplicad({ volume: 0, shellCount: 1, isValid: false });
    const issues = validateParts([makePart()], rep);
    expect(issues).toHaveLength(1);
    expect(issues[0].diagnostics).toEqual({
      volume: 0,
      bboxVolume: 1000,
      shellCount: 1,
    });
  });

  it("does not emit anything for a valid part", () => {
    const rep = mockReplicad({ volume: 500, shellCount: 1, isValid: true });
    const issues = validateParts([makePart()], rep);
    expect(issues).toHaveLength(0);
  });
});
