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
