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

describe("copying", () => {
  it("leaves the original alone and writes a second entry below it", () => {
    const { out, copiedAs } = run(SOURCE, {
      partName: "base",
      translate: [30, 0, 0],
      copyAs: "base copy",
    });
    expect(copiedAs).toBe("base copy");
    // The body that was dragged from is untouched.
    expect(out).toContain('{ shape: base, name: "base", color: "#888" },');
    expect(out).toContain('{ shape: base.clone().translate(30, 0, 0), name: "base copy", color: "#888" },');
    expect(parses(out)).toBe(true);
  });

  it("carries the rest of the entry across rather than rebuilding it", () => {
    // colour, quantity and material are none of this module's business — a
    // copy that dropped them would be a different body wearing the same shape.
    const rich = SOURCE.replace(
      '{ shape: base, name: "base", color: "#888" },',
      '{ shape: base, name: "base", color: "#888", qty: 4, material: { density: 1.24 } },',
    );
    const { out } = run(rich, { partName: "base", translate: [1, 0, 0], copyAs: "b2" });
    expect(out).toContain('name: "b2", color: "#888", qty: 4, material: { density: 1.24 } }');
    expect(parses(out)).toBe(true);
  });

  it("lines the copy up with the entry it came from", () => {
    const { out } = run(SOURCE, { partName: "base", translate: [1, 0, 0], copyAs: "b2" });
    expect(out).toMatch(/\n {4}\{ shape: base\.clone\(\)\.translate\(1, 0, 0\), name: "b2"/);
  });

  it("adds the comma the last entry was missing", () => {
    const noTrailing = SOURCE.replace(
      '    { shape: base, name: "base", color: "#888" },\n',
      '    { shape: base, name: "base", color: "#888" }\n',
    );
    const { out } = run(noTrailing, { partName: "base", translate: [1, 0, 0], copyAs: "b2" });
    expect(parses(out)).toBe(true);
    expect(out).toContain('{ shape: base, name: "base", color: "#888" },');
  });

  it("hoists an inline expression so the two entries share one solid", () => {
    const inline = SOURCE.replace("{ shape: base,", '{ shape: base.mirror("XZ"),');
    const { out, hoistedAs } = run(inline, {
      partName: "base",
      translate: [5, 0, 0],
      copyAs: "b2",
    });
    expect(hoistedAs).toBe("base2");
    expect(out).toContain('const base2 = base.mirror("XZ");');
    expect(out).toContain('{ shape: base2, name: "base"');
    expect(out).toContain('{ shape: base2.clone().translate(5, 0, 0), name: "b2"');
    // Built once, used by both.
    expect(out.match(/base\.mirror/g)?.length).toBe(1);
    expect(parses(out)).toBe(true);
  });

  it("copies a turn as readily as a move", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      rotate: { angle: 180, axis: [0, 0, 1], pivot: "self" },
      copyAs: "mirrored",
    });
    expect(out).toContain('{ shape: base.clone().rotate(180, base.boundingBox.center, [0, 0, 1]), name: "mirrored"');
    expect(parses(out)).toBe(true);
  });

  it("clones, because replicad's transforms delete the shape they are given", () => {
    // `.translate` ends with `this.delete()`. Without the clone the original
    // entry — evaluated first, but read again at tessellation — points at a
    // freed solid, and the render dies on a line that looks fine.
    const { out } = run(SOURCE, { partName: "base", translate: [1, 0, 0], copyAs: "b2" });
    expect(out).toContain("base.clone().translate(1, 0, 0)");
  });

  it("refuses a name the file already gives to a body", () => {
    // Two entries answering to one name is a model where every later lookup —
    // this editor's included — becomes a coin flip.
    const r = computeTransformEdit(SOURCE, {
      partName: "base",
      translate: [1, 0, 0],
      copyAs: "base",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("name-taken");
  });

  it("does not count a name that only appears in a comment as taken", () => {
    const decoy = SOURCE.replace(
      "export default function main",
      '// { shape: x, name: "b2" }\nexport default function main',
    );
    const r = computeTransformEdit(decoy, {
      partName: "base",
      translate: [1, 0, 0],
      copyAs: "b2",
    });
    expect(r.ok).toBe(true);
  });
});

describe("cloning a move that is not a copy", () => {
  it("leaves the common case clean — nothing else names the body", () => {
    // `base` appears in its own declaration and inside the entry being edited,
    // and `name: "base"` is a string. None of those is a later read.
    const { out } = run(SOURCE, { partName: "base", translate: [1, 0, 0] });
    expect(out).toContain("base.translate(1, 0, 0)");
    expect(out).not.toContain(".clone()");
  });

  it("clones when a later line still needs the body", () => {
    const shared = SOURCE.replace(
      '    { shape: base, name: "base", color: "#888" },\n',
      '    { shape: base, name: "base", color: "#888" },\n' +
        '    { shape: base.fuse(base), name: "twin", color: "#888" },\n',
    );
    const { out } = run(shared, { partName: "base", translate: [1, 0, 0] });
    // Transforming `base` in place would delete it before `twin` is built.
    expect(out).toContain("base.clone().translate(1, 0, 0)");
    expect(parses(out)).toBe(true);
  });

  it("does not clone a hoisted const, which nothing else can name", () => {
    const inline = SOURCE.replace("{ shape: base,", '{ shape: base.mirror("XZ"),');
    const { out } = run(inline, {
      partName: "base",
      rotate: { angle: 10, axis: [0, 0, 1], pivot: "self" },
    });
    expect(out).toContain("base2.rotate(10, base2.boundingBox.center, [0, 0, 1])");
    expect(out).not.toContain("base2.clone()");
  });
});
