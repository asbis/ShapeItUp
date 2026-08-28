/**
 * Tests for selector synthesis and source rewriting.
 *
 * This is the module that edits a user's model by machine, so the tests lean
 * hard on the refusal paths: every case where the file is not shaped the way
 * we assumed must come back as a typed failure with the source untouched.
 */
import { describe, it, expect } from "vitest";
import {
  buildFaceOpCall,
  computeFaceOpEdit,
  synthesizeFaceSelector,
  type SelectableFace,
} from "./face-edit.js";

const planar = (
  normal: [number, number, number],
  center: [number, number, number],
): SelectableFace => ({ kind: "PLANE", normal, center });

/**
 * Apply a successful edit and return the resulting source — descending by
 * offset, which is the order the hosts are required to use.
 */
function apply(source: string, partName: string | null, call: string): string {
  const r = computeFaceOpEdit(source, partName, call);
  if (!r.ok) throw new Error(`expected an edit, got ${r.reason}`);
  let out = source;
  for (const e of [...r.edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

describe("synthesizeFaceSelector", () => {
  const params = { plateW: 90, plateD: 60, thickness: 6, gussetH: 45 };

  it("binds the offset to the parameter that equals it", () => {
    const r = synthesizeFaceSelector(planar([0, 0, 1], [0, 0, 6]), params);
    expect(r).toEqual({
      ok: true,
      selector: {
        code: '(f) => f.inPlane("XY", thickness)',
        plane: "XY",
        offsetExpr: "thickness",
        offset: 6,
        boundTo: "thickness",
        durable: true,
      },
    });
  });

  it("binds a negated offset", () => {
    const r = synthesizeFaceSelector(planar([0, 0, -1], [0, 0, -6]), params);
    expect(r.ok && r.selector.code).toBe('(f) => f.inPlane("XY", -thickness)');
    expect(r.ok && r.selector.boundTo).toBe("thickness");
  });

  it("picks the right plane from the normal", () => {
    expect(synthesizeFaceSelector(planar([0, 1, 0], [0, 45, 0]), params))
      .toMatchObject({ ok: true, selector: { code: '(f) => f.inPlane("XZ", gussetH)' } });
    expect(synthesizeFaceSelector(planar([1, 0, 0], [90, 0, 0]), params))
      .toMatchObject({ ok: true, selector: { code: '(f) => f.inPlane("YZ", plateW)' } });
  });

  it("falls back to a literal and says it is not durable", () => {
    // 30 is plateD / 2, but nothing here proves that rather than a coincidence.
    const r = synthesizeFaceSelector(planar([0, 1, 0], [0, 30, 0]), params);
    expect(r).toMatchObject({
      ok: true,
      selector: { code: '(f) => f.inPlane("XZ", 30)', offsetExpr: "30", durable: false },
    });
    expect(r.ok && "boundTo" in r.selector).toBe(false);
  });

  it("does not bind an offset of zero to a parameter that happens to be zero", () => {
    // A plane through the origin stays through the origin; binding it to
    // `someZeroParam` would move the selector the moment that param changed.
    const r = synthesizeFaceSelector(planar([0, 0, 1], [0, 0, 0]), { offset: 0 });
    expect(r).toMatchObject({
      ok: true,
      selector: { code: '(f) => f.inPlane("XY", 0)', durable: false },
    });
  });

  it("absorbs the Float32 round trip the mesh takes to the viewer", () => {
    const r = synthesizeFaceSelector(planar([0, 0, 1], [0, 0, 6.000000119]), params);
    expect(r.ok && r.selector.boundTo).toBe("thickness");
  });

  it("declines a face no inPlane selector can name", () => {
    expect(synthesizeFaceSelector(planar([0, -0.707, 0.707], [0, -28, 4]), params))
      .toEqual({ ok: false, reason: "not-axis-aligned" });
    expect(synthesizeFaceSelector({ kind: "CYLINDRE", normal: [1, 0, 0], center: [0, 0, 0] }, params))
      .toEqual({ ok: false, reason: "not-planar" });
    expect(synthesizeFaceSelector({ kind: "PLANE", center: [0, 0, 0] }, params))
      .toEqual({ ok: false, reason: "no-normal" });
  });
});

const MULTI = `import { drawRoundedRectangle } from "replicad";
export const params = { plateW: 90, thickness: 6 };
export default function main({ plateW, thickness }: typeof params) {
  const plate = drawRoundedRectangle(plateW, 60, 6).sketchOnPlane("XY").extrude(thickness);
  const web = drawRoundedRectangle(plateW, 45, 2).sketchOnPlane("XZ").extrude(thickness);
  return [
    { shape: plate.fillet(4, (e) => e.inPlane("XY", thickness)), name: "plate", color: "#7fa8d0" },
    { shape: web, name: "web", color: "#d0a87f" },
  ];
}
`;

const SINGLE = `import { drawCircle } from "replicad";
export const params = { d: 20, h: 8 };
export default function main({ d, h }: typeof params) {
  return drawCircle(d / 2).sketchOnPlane().extrude(h);
}
`;

describe("computeFaceOpEdit", () => {
  const CALL = 'extrudeFace($SHAPE, (f) => f.inPlane("XY", thickness), 5)';

  it("wraps the shape expression of the named part", () => {
    const out = apply(MULTI, "plate", CALL);
    expect(out).toContain(
      'shape: extrudeFace(plate.fillet(4, (e) => e.inPlane("XY", thickness)), (f) => f.inPlane("XY", thickness), 5), name: "plate"',
    );
    // The sibling part is untouched.
    expect(out).toContain('{ shape: web, name: "web", color: "#d0a87f" }');
  });

  it("wraps a bare shape expression when there is no part name", () => {
    const out = apply(SINGLE, null, CALL);
    expect(out).toContain(
      'return extrudeFace(drawCircle(d / 2).sketchOnPlane().extrude(h), (f) => f.inPlane("XY", thickness), 5);',
    );
  });

  it("reports the expression it wrapped, for a preview", () => {
    const r = computeFaceOpEdit(MULTI, "web", CALL);
    expect(r.ok && r.wrapped).toBe("web");
  });

  it("nests a second operation around the first", () => {
    // The point of wrapping rather than inserting: operations compose, and
    // the second one applies to the result of the first.
    const once = apply(SINGLE, null, CALL);
    const twice = apply(once, null, 'extrudeFace($SHAPE, (f) => f.inPlane("XY", 0), -2)');
    expect(twice).toContain("extrudeFace(extrudeFace(drawCircle(d / 2)");
  });

  it("is not fooled by a part name inside a string or a comment", () => {
    const tricky = `export default function main() {
  // { shape: decoy, name: "plate" }
  const label = '{ shape: decoy, name: "plate" }';
  return [{ shape: real, name: "plate" }];
}
`;
    const out = apply(tricky, "plate", CALL);
    expect(out).toContain("shape: extrudeFace(real,");
    expect(out).toContain('// { shape: decoy, name: "plate" }');
    expect(out).toContain(`const label = '{ shape: decoy, name: "plate" }';`);
  });

  it("refuses a part name that is not in the file", () => {
    expect(computeFaceOpEdit(MULTI, "flange", CALL)).toEqual({
      ok: false,
      reason: "part-not-found",
    });
  });

  it("refuses when two objects claim the same part name", () => {
    // Nothing in the geometry says which one the click meant.
    const dup = MULTI.replace('name: "web"', 'name: "plate"');
    expect(computeFaceOpEdit(dup, "plate", CALL)).toEqual({
      ok: false,
      reason: "unparseable",
    });
  });

  it("refuses an entry that names a part but declares no shape", () => {
    const noShape = `export default function main() {
  return [{ name: "plate", color: "#fff" }];
}
`;
    expect(computeFaceOpEdit(noShape, "plate", CALL)).toEqual({
      ok: false,
      reason: "part-has-no-shape",
    });
  });

  it("refuses a file with no return at all", () => {
    expect(computeFaceOpEdit("export const params = { a: 1 };\n", null, CALL)).toEqual({
      ok: false,
      reason: "no-return",
    });
  });

  it("ignores a return nested inside a callback", () => {
    // The map callback's `return` is at depth 2 and is not the model's result.
    const nested = `export default function main() {
  const parts = [1, 2].map((n) => {
    return n * 2;
  });
  return box(parts[0]);
}
`;
    const out = apply(nested, null, CALL);
    expect(out).toContain("return extrudeFace(box(parts[0]),");
    expect(out).toContain("return n * 2;");
  });

  it("takes the last top-level return, not an early guard", () => {
    const guarded = `export default function main({ empty }) {
  if (empty) return nothing();
  return realShape();
}
`;
    const out = apply(guarded, null, CALL);
    expect(out).toContain("return extrudeFace(realShape(),");
    expect(out).toContain("if (empty) return nothing();");
  });

  it("brings extrudeFace into scope when it is not imported", () => {
    // Without this the edit would replace a working model with a
    // ReferenceError, which is a worse outcome than refusing outright.
    const out = apply(MULTI, "plate", CALL);
    expect(out).toContain('import { extrudeFace } from "shapeitup";');
    // After the existing imports, not before them.
    expect(out.indexOf('from "replicad"')).toBeLessThan(
      out.indexOf('from "shapeitup"'),
    );
    const r = computeFaceOpEdit(MULTI, "plate", CALL);
    expect(r.ok && r.addedImport).toBe(true);
  });

  it("joins an existing shapeitup import instead of adding a second", () => {
    const withStdlib = MULTI.replace(
      'import { drawRoundedRectangle } from "replicad";',
      'import { drawRoundedRectangle } from "replicad";\nimport { holes } from "shapeitup";',
    );
    const out = apply(withStdlib, "plate", CALL);
    expect(out).toContain('import { holes, extrudeFace } from "shapeitup";');
    expect(out.match(/from "shapeitup"/g)).toHaveLength(1);
  });

  it("adds nothing when the helper is already imported", () => {
    const already = MULTI.replace(
      'import { drawRoundedRectangle } from "replicad";',
      'import { drawRoundedRectangle } from "replicad";\nimport { extrudeFace } from "shapeitup";',
    );
    const r = computeFaceOpEdit(already, "plate", CALL);
    expect(r.ok && r.addedImport).toBe(false);
    expect(r.ok && r.edits).toHaveLength(1);
  });

  it("recognises an aliased import by its local binding", () => {
    const aliased = MULTI.replace(
      'import { drawRoundedRectangle } from "replicad";',
      'import { pushFace as extrudeFace } from "shapeitup";',
    );
    const r = computeFaceOpEdit(aliased, "plate", CALL);
    expect(r.ok && r.addedImport).toBe(false);
  });

  it("is not fooled by an import written inside a doc comment", () => {
    const commented = `/**
 * Example: import { extrudeFace } from "shapeitup";
 */
export default function main() {
  return box(1);
}
`;
    const out = apply(commented, null, CALL);
    // The comment is not an import, so a real one still has to be added.
    expect(out.match(/^import \{ extrudeFace \} from "shapeitup";$/m)).not.toBeNull();
  });

  it("leaves the source untouched on every failure", () => {
    for (const name of ["flange", "nope"]) {
      const r = computeFaceOpEdit(MULTI, name, CALL);
      expect(r.ok).toBe(false);
    }
  });
});

describe("buildFaceOpCall — per-operation output", () => {
  const TOP: SelectableFace = { kind: "PLANE", center: [0, 0, 6], normal: [0, 0, 1] };

  /** Apply a built operation and return the resulting source. */
  function build(source: string, req: Parameters<typeof buildFaceOpCall>[1]): string {
    const r = buildFaceOpCall(source, req);
    if (!r.ok) throw new Error(`expected a build, got: ${r.reason}`);
    let out = source;
    for (const e of [...r.edits].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
  }

  it("names the same picked FACE for all three operations", () => {
    // fillet and chamfer act on the edges around the face, but they resolve
    // that boundary at build time from the face's own wires — so what goes in
    // the source is a FaceFinder, not an edge predicate.
    const out = build(SINGLE, { op: "fillet", partName: null, face: TOP, distance: 2 });
    expect(out).toContain(
      'return filletFace(drawCircle(d / 2).sketchOnPlane().extrude(h), (f) => f.inPlane("XY", 6), 2);',
    );
  });

  it("emits chamfer the same way", () => {
    const out = build(SINGLE, { op: "chamfer", partName: null, face: TOP, distance: 1 });
    expect(out).toContain('chamferFace(drawCircle(d / 2).sketchOnPlane().extrude(h), (f) => f.inPlane("XY", 6), 1);');
  });

  it("imports the helper each operation names", () => {
    const wanted = { extrude: "extrudeFace", fillet: "filletFace", chamfer: "chamferFace" } as const;
    for (const [op, fn] of Object.entries(wanted) as [keyof typeof wanted, string][]) {
      const out = build(SINGLE, { op, partName: null, face: TOP, distance: 2 });
      expect(out).toContain(`import { ${fn} } from "shapeitup";`);
    }
  });

  it("binds the offset to a parameter for all three operations", () => {
    const src = SINGLE.replace("{ d: 20, h: 8 }", "{ d: 20, h: 6 }");
    for (const op of ["extrude", "fillet", "chamfer"] as const) {
      const r = buildFaceOpCall(src, { op, partName: null, face: TOP, distance: 2 });
      expect(r.ok && r.applied).toContain('inPlane("XY", h)');
    }
  });

  it("needs no parentheses, because every template passes the shape as an argument", () => {
    // A suffix form (`$SHAPE.fillet(…)`) would bind to `squareOne()` alone here
    // and silently compute something else. Wrapping cannot.
    const ternary = `export default function main({ round }) {
  return round ? roundOne() : squareOne();
}
`;
    const out = build(ternary, { op: "fillet", partName: null, face: TOP, distance: 2 });
    expect(out).toContain("filletFace(round ? roundOne() : squareOne(), ");
  });

  it("passes a plain chain through untouched", () => {
    const ternary = `export default function main({ round }) {
  return round ? roundOne() : squareOne();
}
`;
    const out = build(ternary, { op: "extrude", partName: null, face: TOP, distance: 2 });
    expect(out).toContain("extrudeFace(round ? roundOne() : squareOne(), ");
  });

  it("refuses a negative fillet or chamfer but allows a negative extrude", () => {
    // Pushing a face in is meaningful; a negative radius is not.
    for (const op of ["fillet", "chamfer"] as const) {
      const r = buildFaceOpCall(SINGLE, { op, partName: null, face: TOP, distance: -2 });
      expect(r).toMatchObject({ ok: false });
      expect(!r.ok && r.reason).toMatch(/must be positive/);
    }
    const ex = buildFaceOpCall(SINGLE, { op: "extrude", partName: null, face: TOP, distance: -2 });
    expect(ex.ok).toBe(true);
  });

  it("refuses a zero distance for every operation", () => {
    for (const op of ["extrude", "fillet", "chamfer"] as const) {
      expect(buildFaceOpCall(SINGLE, { op, partName: null, face: TOP, distance: 0 })).toMatchObject({
        ok: false,
      });
    }
  });

  it("stacks operations, each applying to the result of the last", () => {
    const once = build(SINGLE, { op: "extrude", partName: null, face: TOP, distance: 5 });
    const twice = build(once, { op: "fillet", partName: null, face: TOP, distance: 1 });
    expect(twice).toContain("filletFace(extrudeFace(drawCircle(d / 2)");
    // One import statement, carrying both helpers.
    expect(twice.match(/from "shapeitup"/g)).toHaveLength(1);
    expect(twice).toContain('import { extrudeFace, filletFace } from "shapeitup";');
  });
});
