/**
 * computeTransformEdit — the source rewrite behind the viewer's Move/Rotate.
 *
 * As with the combine editor, every case that produces edits also runs the
 * result through esbuild: the failure that matters is a `.shape.ts` that no
 * longer parses, or one that parses and now moves the wrong body.
 */
import { describe, it, expect } from "vitest";
import { transformSync } from "esbuild";
import { computeTransformEdit, needsParens, type TransformRequest } from "./transform-edit.js";
import { applyEdits } from "./combine-edit.js";

const SOURCE = `import { drawRectangle } from "replicad";

export const params = { w: 40, t: 8 };

export default function main({ w, t }: typeof params) {
  const base = drawRectangle(w, w).sketchOnPlane("XY").extrude(t);
  return [
    { shape: base, name: "base", color: "#888" },
  ];
}
`;

function parses(src: string): boolean {
  transformSync(src, { loader: "ts" });
  return true;
}

function run(source: string, req: TransformRequest) {
  const r = computeTransformEdit(source, req);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return { ...r, out: applyEdits(source, r.edits) };
}

describe("moving", () => {
  it("appends a translate with the numbers a person would have typed", () => {
    const { out } = run(SOURCE, { partName: "base", translate: [12, 0, -5] });
    expect(out).toContain("{ shape: base.translate(12, 0, -5), name: \"base\"");
    expect(parses(out)).toBe(true);
  });

  it("keeps a chained expression readable rather than bracketing it", () => {
    const chained = SOURCE.replace("{ shape: base,", "{ shape: base.mirror(\"XZ\"),");
    const { out, parenthesised } = run(chained, { partName: "base", translate: [1, 2, 3] });
    expect(parenthesised).toBe(false);
    expect(out).toContain("base.mirror(\"XZ\").translate(1, 2, 3)");
    expect(parses(out)).toBe(true);
  });

  it("refuses a move of nothing", () => {
    const r = computeTransformEdit(SOURCE, { partName: "base", translate: [0, 0, 0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no-change");
  });
});

describe("turning", () => {
  it("writes replicad's short form for the default axis through the origin", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      rotate: { angle: 45, axis: [0, 0, 1], pivot: "origin" },
    });
    // `rotate(angle)` already means "about +Z through the origin" — spelling
    // that out would put three zeroes in the file for no reader's benefit.
    expect(out).toContain("base.rotate(45)");
    expect(parses(out)).toBe(true);
  });

  it("spells out a non-default axis", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      rotate: { angle: -90, axis: [1, 0, 0], pivot: "origin" },
    });
    expect(out).toContain("base.rotate(-90, [0, 0, 0], [1, 0, 0])");
    expect(parses(out)).toBe(true);
  });

  it("writes a self-pivot as the EXPRESSION for it, not the coordinates", () => {
    const { out, hoistedAs } = run(SOURCE, {
      partName: "base",
      rotate: { angle: 30, axis: [0, 0, 1], pivot: "self" },
    });
    // Frozen coordinates would be correct today and silently wrong the moment
    // a parameter moved the body. This stays the body's centre whatever the
    // body becomes.
    expect(out).toContain("base.rotate(30, base.boundingBox.center, [0, 0, 1])");
    expect(out).not.toMatch(/rotate\(30, \[[\d.]/);
    // Already a name, so nothing had to be lifted.
    expect(hoistedAs).toBeUndefined();
    expect(parses(out)).toBe(true);
  });

  it("hoists an inline expression so a self-pivot need not build it twice", () => {
    const inline = SOURCE.replace("{ shape: base,", "{ shape: base.mirror(\"XZ\"),");
    const { out, hoistedAs } = run(inline, {
      partName: "base",
      rotate: { angle: 90, axis: [0, 1, 0], pivot: "self" },
    });
    expect(hoistedAs).toBe("base2");
    expect(out).toContain("const base2 = base.mirror(\"XZ\");");
    expect(out).toContain("base2.rotate(90, base2.boundingBox.center, [0, 1, 0])");
    // Built once, named twice.
    expect(out.match(/base\.mirror/g)?.length).toBe(1);
    expect(parses(out)).toBe(true);
  });

  it("rotates BEFORE it translates, which is the order the drag happened in", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      rotate: { angle: 90, axis: [0, 0, 1], pivot: "origin" },
      translate: [10, 0, 0],
    });
    expect(out).toContain("base.rotate(90).translate(10, 0, 0)");
    expect(parses(out)).toBe(true);
  });

  it("treats a rotation of nothing as no rotation", () => {
    const r = computeTransformEdit(SOURCE, {
      partName: "base",
      rotate: { angle: 0, axis: [0, 0, 1], pivot: "origin" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("parenthesising", () => {
  it("leaves plain chains alone", () => {
    for (const expr of [
      "base",
      "base.translate(1, 2, 3)",
      "holes.through(plate, { d: 5 })",
      "a.b.c().d",
      "plate.cut(bore(-1))",
      'draw().sketchOnPlane("XY").extrude(t)',
    ]) {
      expect(needsParens(expr), expr).toBe(false);
    }
  });

  it("brackets anything a suffix would bind to the wrong half of", () => {
    for (const expr of [
      "cond ? a : b",
      "a || b",
      "left.fuse(right).cut(hole) , other",
      "new Sketch(w).extrude(1)",
      "-plate",
      "a + b",
      "await build()",
    ]) {
      expect(needsParens(expr), expr).toBe(true);
    }
  });

  it("wraps the ternary in the file, not just in the abstract", () => {
    const ternary = SOURCE.replace("{ shape: base,", "{ shape: t > 4 ? base : base,");
    const { out, parenthesised } = run(ternary, { partName: "base", translate: [5, 0, 0] });
    expect(parenthesised).toBe(true);
    // Without the brackets this would move only the `else` branch.
    expect(out).toContain("(t > 4 ? base : base).translate(5, 0, 0)");
    expect(parses(out)).toBe(true);
  });

  it("does not bracket for an operator that is only inside a string", () => {
    expect(needsParens('label("a + b")')).toBe(false);
  });
});

describe("refusals", () => {
  it("reports a name the file does not declare", () => {
    const r = computeTransformEdit(SOURCE, { partName: "ghost", translate: [1, 0, 0] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("part-not-found");
  });
});
