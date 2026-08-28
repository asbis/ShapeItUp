/**
 * Unit tests for the pure half of face picking — the part that decides WHICH
 * face a triangle belongs to, and how to say it.
 *
 * The raycast half is not tested here: it needs a GPU-less THREE scene and
 * would mostly assert that three.js works. What is worth pinning down is the
 * span lookup, because it is the one place where an off-by-one silently
 * highlights the neighbouring face instead of failing.
 */
import { describe, it, expect } from "vitest";
import {
  edgePointAndLength,
  edgeIndexForPoint,
  edgesInPlane,
  faceBounds,
  tangentChain,
  describeKind,
  describePlacement,
  faceIndexForTriangle,
  formatFaceArea,
  formatTriple,
} from "./selection";

// Three faces: 2 triangles, 1 triangle, 3 triangles — in index units, so
// counts are 6, 3 and 9, and triangle numbers run 0..1, 2, 3..5.
const GROUPS = new Uint32Array([0, 6, 6, 3, 9, 9]);

describe("faceIndexForTriangle", () => {
  it("maps every triangle to the face that owns it", () => {
    expect([0, 1, 2, 3, 4, 5].map((t) => faceIndexForTriangle(GROUPS, t)))
      .toEqual([0, 0, 1, 2, 2, 2]);
  });

  it("finds both boundaries of a span, not just its interior", () => {
    // The classic binary-search bug lands exactly here.
    expect(faceIndexForTriangle(GROUPS, 1)).toBe(0); // last triangle of face 0
    expect(faceIndexForTriangle(GROUPS, 2)).toBe(1); // only triangle of face 1
    expect(faceIndexForTriangle(GROUPS, 3)).toBe(2); // first triangle of face 2
  });

  it("returns -1 past the end rather than clamping to the last face", () => {
    // Clamping would highlight a real face for a hit that belongs to none —
    // a wrong answer is worse here than no answer.
    expect(faceIndexForTriangle(GROUPS, 6)).toBe(-1);
    expect(faceIndexForTriangle(GROUPS, 999)).toBe(-1);
  });

  it("handles a single-face shape", () => {
    expect(faceIndexForTriangle(new Uint32Array([0, 3]), 0)).toBe(0);
    expect(faceIndexForTriangle(new Uint32Array([0, 3]), 1)).toBe(-1);
  });

  it("handles an empty group list", () => {
    expect(faceIndexForTriangle(new Uint32Array([]), 0)).toBe(-1);
  });
});

describe("describePlacement", () => {
  const plane = (normal: [number, number, number], center: [number, number, number]) =>
    ({ kind: "PLANE", normal, center }) as const;

  it("names the plane a replicad selector would use", () => {
    expect(describePlacement(plane([0, 0, 1], [0, 0, 6]))).toBe("Lies in XY at Z = 6");
    expect(describePlacement(plane([0, -1, 0], [0, -30, 4]))).toBe("Lies in XZ at Y = -30");
    expect(describePlacement(plane([1, 0, 0], [45, 0, 0]))).toBe("Lies in YZ at X = 45");
  });

  it("reads a normal pointing either way along an axis as the same plane", () => {
    expect(describePlacement(plane([0, 0, -1], [0, 0, 0]))).toBe("Lies in XY at Z = 0");
  });

  it("says nothing about an oblique plane", () => {
    // A 45° fillet face has no `inPlane` shorthand; claiming one would be a lie.
    expect(describePlacement(plane([0, -0.707, 0.707], [0, -28.5, 4.5]))).toBeNull();
  });

  it("says nothing about a curved face", () => {
    expect(describePlacement({ kind: "CYLINDRE", normal: [0, 0, 1], center: [0, 0, 0] }))
      .toBeNull();
    expect(describePlacement({ kind: "PLANE", center: [0, 0, 0] })).toBeNull();
  });

  it("drops the decimal on a whole millimetre but keeps a real fraction", () => {
    expect(describePlacement(plane([0, 0, 1], [0, 0, 6]))).toContain("Z = 6");
    expect(describePlacement(plane([0, 0, 1], [0, 0, 6.25]))).toContain("Z = 6.25");
    // -0 is a zero, not a measurement that happens to be negative.
    expect(describePlacement(plane([0, 0, 1], [0, 0, -0]))).toContain("Z = 0");
  });
});

describe("formatting", () => {
  it("switches units where the number stops being readable", () => {
    expect(formatFaceArea(37.3)).toBe("37.30 mm²");
    expect(formatFaceArea(3730)).toBe("37.30 cm²");
    expect(formatFaceArea(NaN)).toBe("—");
  });

  it("never renders a negative zero", () => {
    expect(formatTriple([-0, 30, 28.5])).toBe("0.0, 30.0, 28.5");
  });

  it("falls back to a generic label for an unknown surface type", () => {
    expect(describeKind("PLANE")).toBe("Planar face");
    expect(describeKind("CYLINDRE")).toBe("Cylindrical face");
    expect(describeKind("SOME_FUTURE_OCCT_TYPE")).toBe("Face");
  });
});

describe("edgesInPlane", () => {
  /**
   * A 10x10x10 box's edge buffer, hand-built: 12 edges, 2 points each.
   * Four of them lie in the top plane Z=10, four in the bottom Z=0, and four
   * verticals lie in neither.
   */
  function box(): any {
    const pts: number[] = [];
    const push = (a: number[], b: number[]) => pts.push(...a, ...b);
    // Top face (z = 10)
    push([0, 0, 10], [10, 0, 10]);
    push([10, 0, 10], [10, 10, 10]);
    push([10, 10, 10], [0, 10, 10]);
    push([0, 10, 10], [0, 0, 10]);
    // Bottom face (z = 0)
    push([0, 0, 0], [10, 0, 0]);
    push([10, 0, 0], [10, 10, 0]);
    push([10, 10, 0], [0, 10, 0]);
    push([0, 10, 0], [0, 0, 0]);
    // Verticals
    push([0, 0, 0], [0, 0, 10]);
    push([10, 0, 0], [10, 0, 10]);
    push([10, 10, 0], [10, 10, 10]);
    push([0, 10, 0], [0, 10, 10]);
    const groups = new Uint32Array(24);
    for (let i = 0; i < 12; i++) {
      groups[i * 2] = i * 2;
      groups[i * 2 + 1] = 2;
    }
    return { edgeVertices: new Float32Array(pts), edgeGroups: groups };
  }

  it("finds the edges that bound a face, not the ones that merely touch it", () => {
    // The four verticals each have ONE endpoint at z=10. An edge lies in a
    // plane only when EVERY point does — otherwise a fillet preview would
    // light up the whole box.
    expect(edgesInPlane(box(), "XY", 10)).toEqual([0, 1, 2, 3]);
    expect(edgesInPlane(box(), "XY", 0)).toEqual([4, 5, 6, 7]);
  });

  it("reads the offset along the right axis for each plane", () => {
    // YZ measures along X: the two verticals at x=0 plus the two horizontals
    // whose points all sit at x=0.
    expect(edgesInPlane(box(), "YZ", 0)).toEqual([3, 7, 8, 11]);
    expect(edgesInPlane(box(), "XZ", 0)).toEqual([0, 4, 8, 9]);
  });

  it("finds nothing in a plane the shape does not reach", () => {
    // replicad throws on an empty selector, so the UI has to be able to say so
    // before the user commits.
    expect(edgesInPlane(box(), "XY", 999)).toEqual([]);
  });

  it("tolerates the Float32 round trip the mesh made", () => {
    const b = box();
    // Nudge one point of the first edge by less than the tolerance.
    b.edgeVertices[2] = 10.001;
    expect(edgesInPlane(b, "XY", 10)).toContain(0);
    // And past it.
    b.edgeVertices[2] = 10.5;
    expect(edgesInPlane(b, "XY", 10)).not.toContain(0);
  });

  it("returns nothing for a part with no edge data", () => {
    expect(edgesInPlane({} as any, "XY", 0)).toEqual([]);
  });

  it("rejects a plane name it does not know", () => {
    expect(edgesInPlane(box(), "ZZ", 0)).toEqual([]);
  });
});

describe("edgesInPlane — scoped to one face", () => {
  /** Two 4x4 squares in the plane z = 10, sitting 20 mm apart in X. */
  function twoSquares(): any {
    const pts: number[] = [];
    const square = (x0: number) => {
      const p = [
        [x0, 0, 10], [x0 + 4, 0, 10],
        [x0 + 4, 0, 10], [x0 + 4, 4, 10],
        [x0 + 4, 4, 10], [x0, 4, 10],
        [x0, 4, 10], [x0, 0, 10],
      ];
      for (const q of p) pts.push(...q);
    };
    square(0);
    square(20);
    const groups = new Uint32Array(16);
    for (let i = 0; i < 8; i++) {
      groups[i * 2] = i * 2;
      groups[i * 2 + 1] = 2;
    }
    return { edgeVertices: new Float32Array(pts), edgeGroups: groups };
  }

  it("takes both squares when no face bounds are given", () => {
    expect(edgesInPlane(twoSquares(), "XY", 10)).toHaveLength(8);
  });

  it("takes only the picked one when bounds are given", () => {
    // Two bosses at the same height share a plane but not a boundary. Rounding
    // one must not light up the other.
    const near = { min: [-0.1, -0.1, 9.9], max: [4.1, 4.1, 10.1] } as const;
    expect(edgesInPlane(twoSquares(), "XY", 10, near as any)).toEqual([0, 1, 2, 3]);
    const far = { min: [19.9, -0.1, 9.9], max: [24.1, 4.1, 10.1] } as const;
    expect(edgesInPlane(twoSquares(), "XY", 10, far as any)).toEqual([4, 5, 6, 7]);
  });
});

describe("faceBounds", () => {
  it("boxes a face's triangles, with slack for float noise", () => {
    const part: any = {
      vertices: new Float32Array([0, 0, 5, 10, 0, 5, 10, 8, 5, 99, 99, 99]),
      triangles: new Uint32Array([0, 1, 2, 3, 3, 3]),
    };
    // Only the first triangle belongs to the face; the stray vertex must not
    // widen the box.
    const b = faceBounds(part, { start: 0, count: 3 } as any, 0.05);
    expect(b.min[0]).toBeCloseTo(-0.05);
    expect(b.max[0]).toBeCloseTo(10.05);
    expect(b.max[1]).toBeCloseTo(8.05);
    expect(b.min[2]).toBeCloseTo(4.95);
    expect(b.max[2]).toBeCloseTo(5.05);
  });
});

describe("edgeIndexForPoint", () => {
  // Three edges: 2, 4 and 2 points.
  const groups = new Uint32Array([0, 2, 2, 4, 6, 2]);

  it("maps every point to the edge that owns it", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((p) => edgeIndexForPoint(groups, p)))
      .toEqual([0, 0, 1, 1, 1, 1, 2, 2]);
  });

  it("returns -1 past the end rather than clamping", () => {
    expect(edgeIndexForPoint(groups, 8)).toBe(-1);
    expect(edgeIndexForPoint(new Uint32Array([]), 0)).toBe(-1);
  });
});

describe("edgePointAndLength", () => {
  it("takes the midpoint of a straight edge — the value most likely to bind", () => {
    // A single segment from (0,-30,8) to (60,-30,8). The midpoint is exactly
    // on the edge AND it is the round number a parameter can explain.
    const v = new Float32Array([0, -30, 8, 60, -30, 8]);
    const r = edgePointAndLength(v, 0, 2);
    expect(r.point).toEqual([30, -30, 8]);
    expect(r.length).toBeCloseTo(60);
  });

  it("takes a real vertex on a curve, not a midpoint off it", () => {
    // Pair layout: p0,p1, p1,p2. A midpoint between vertices would sit inside
    // the chord, where `containsPoint` would miss the true curve.
    const v = new Float32Array([0, 0, 0, 1, 1, 0, 1, 1, 0, 2, 0, 0]);
    const r = edgePointAndLength(v, 0, 4);
    expect(r.point).toEqual([1, 1, 0]);
    expect(r.length).toBeCloseTo(2 * Math.SQRT2);
  });
});

describe("tangentChain", () => {
  /**
   * Four segments forming a square outline: each meets the next at 90 degrees,
   * so nothing is tangent-continuous.
   */
  function squareLoop(): any {
    const pts = [
      0, 0, 0, 10, 0, 0,
      10, 0, 0, 10, 10, 0,
      10, 10, 0, 0, 10, 0,
      0, 10, 0, 0, 0, 0,
    ];
    const groups = new Uint32Array([0, 2, 2, 2, 4, 2, 6, 2]);
    return { edgeVertices: new Float32Array(pts), edgeGroups: groups };
  }

  /** Two collinear segments meeting end to end: one smooth chain. */
  function straightPair(): any {
    const pts = [0, 0, 0, 10, 0, 0, 10, 0, 0, 20, 0, 0];
    return { edgeVertices: new Float32Array(pts), edgeGroups: new Uint32Array([0, 2, 2, 2]) };
  }

  it("stops at a corner, so a boxy part rounds only what was clicked", () => {
    expect(tangentChain(squareLoop(), 0)).toEqual([0]);
    expect(tangentChain(squareLoop(), 2)).toEqual([2]);
  });

  it("carries across a smooth join, the way OCCT's fillet does", () => {
    // Measured on real geometry: filleting one edge of a ROUNDED outline
    // removes what the whole loop would, because the straights are tangent to
    // the corner arcs. Previewing only the clicked edge would be a lie.
    expect(tangentChain(straightPair(), 0)).toEqual([0, 1]);
    expect(tangentChain(straightPair(), 1)).toEqual([0, 1]);
  });

  it("is transitive across a chain of joins", () => {
    const pts = [0, 0, 0, 10, 0, 0, 10, 0, 0, 20, 0, 0, 20, 0, 0, 30, 0, 0];
    const part: any = {
      edgeVertices: new Float32Array(pts),
      edgeGroups: new Uint32Array([0, 2, 2, 2, 4, 2]),
    };
    expect(tangentChain(part, 0)).toEqual([0, 1, 2]);
  });

  it("does not join edges that merely pass near each other", () => {
    // Same directions, but no shared endpoint.
    const pts = [0, 0, 0, 10, 0, 0, 10, 5, 0, 20, 5, 0];
    const part: any = {
      edgeVertices: new Float32Array(pts),
      edgeGroups: new Uint32Array([0, 2, 2, 2]),
    };
    expect(tangentChain(part, 0)).toEqual([0]);
  });

  it("returns the edge itself when the part carries no edge data", () => {
    expect(tangentChain({} as any, 3)).toEqual([3]);
  });
});
