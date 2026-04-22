import { describe, it, expect } from "vitest";
import { emitAsciiSolid } from "./exporter";

type V3 = [number, number, number];
type Tri = { nx: number; ny: number; nz: number; v: [V3, V3, V3] };

describe("emitAsciiSolid", () => {
  it("wraps triangles in solid/endsolid blocks named after the part", () => {
    const tris: Tri[] = [
      { nx: 0, ny: 0, nz: 1, v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
    ];
    const out = emitAsciiSolid("base_plate", tris);
    expect(out.startsWith("solid base_plate\n")).toBe(true);
    expect(out.trimEnd().endsWith("endsolid base_plate")).toBe(true);
    expect((out.match(/facet normal/g) ?? []).length).toBe(1);
    expect((out.match(/^      vertex /gm) ?? []).length).toBe(3);
    expect(out).toContain("outer loop");
    expect(out).toContain("endloop");
    expect(out).toContain("endfacet");
  });

  it("formats normals and vertices as fixed-point 6-digit floats", () => {
    const tris: Tri[] = [
      { nx: 1, ny: 0, nz: 0, v: [[1.5, 2.5, 3.5], [4, 5, 6], [7, 8, 9]] },
    ];
    const out = emitAsciiSolid("x", tris);
    expect(out).toContain("facet normal 1.000000 0.000000 0.000000");
    expect(out).toContain("vertex 1.500000 2.500000 3.500000");
    expect(out).toContain("vertex 4.000000 5.000000 6.000000");
  });

  it("emits only the solid/endsolid wrapper when there are no triangles", () => {
    expect(emitAsciiSolid("empty", [])).toBe("solid empty\nendsolid empty\n");
  });

  it("produces one facet block per triangle in order", () => {
    const tris: Tri[] = [
      { nx: 0, ny: 0, nz: 1, v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] },
      { nx: 1, ny: 0, nz: 0, v: [[2, 0, 0], [2, 1, 0], [2, 0, 1]] },
    ];
    const out = emitAsciiSolid("two", tris);
    const facetIdx1 = out.indexOf("facet normal 0.000000 0.000000 1.000000");
    const facetIdx2 = out.indexOf("facet normal 1.000000 0.000000 0.000000");
    expect(facetIdx1).toBeGreaterThanOrEqual(0);
    expect(facetIdx2).toBeGreaterThan(facetIdx1);
  });
});
