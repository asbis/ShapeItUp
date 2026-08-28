/**
 * computeArrangeEdit — the source rewrite behind Mirror and Pattern.
 *
 * Every case that produces edits runs the result through esbuild, for the same
 * reason as the other editors: the failure that matters is a `.shape.ts` that
 * no longer parses, or one that parses and quietly builds the wrong thing.
 */
import { describe, it, expect } from "vitest";
import { transformSync } from "esbuild";
import { computeArrangeEdit, type ArrangeRequest } from "./arrange-edit.js";
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

const parses = (src: string) => (transformSync(src, { loader: "ts" }), true);

function run(source: string, req: ArrangeRequest) {
  const r = computeArrangeEdit(source, req);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return { ...r, out: applyEdits(source, r.edits) };
}

describe("mirror", () => {
  it("joins the reflection into one symmetric body", () => {
    const { out, needsImport } = run(SOURCE, {
      partName: "base",
      spec: { kind: "mirror", plane: "XZ" },
    });
    expect(out).toContain('shape: joinBodies(base, base.clone().mirror("XZ"))');
    expect(needsImport).toBe("joinBodies");
    expect(parses(out)).toBe(true);
  });

  it("clones, because .mirror consumes what it is called on", () => {
    // Without the clone the fuse reads a freed handle — the same trap the
    // Copy command hit, and the reason `.clone()` is not decoration.
    const { out } = run(SOURCE, { partName: "base", spec: { kind: "mirror", plane: "YZ" } });
    expect(out).toContain("base.clone().mirror");
  });

  it("writes a separate body when asked for one", () => {
    const { out, copiedAs } = run(SOURCE, {
      partName: "base",
      spec: { kind: "mirror", plane: "YZ" },
      asNewBody: "base mirrored",
    });
    expect(copiedAs).toBe("base mirrored");
    // The original is untouched — a left hand and a right hand.
    expect(out).toContain('{ shape: base, name: "base", color: "#888" },');
    expect(out).toContain('{ shape: base.clone().mirror("YZ"), name: "base mirrored", color: "#888" },');
    expect(parses(out)).toBe(true);
  });

  it("carries no coordinates at all", () => {
    // The point of mirror: a standard plane through the origin means the same
    // thing whatever the model becomes. Nothing here can go stale.
    const { out } = run(SOURCE, { partName: "base", spec: { kind: "mirror", plane: "XY" } });
    expect(out).not.toMatch(/mirror\("XY", *\[/);
    expect(out).toContain('mirror("XY")');
  });
});

describe("pattern", () => {
  it("writes a rectangular pattern as repeat + grid", () => {
    const { out, needsImport } = run(SOURCE, {
      partName: "base",
      spec: { kind: "grid", nx: 3, ny: 2, dx: 30, dy: 25, plane: "XY" },
    });
    expect(out).toContain("shape: patterns.repeat(base, patterns.grid(3, 2, 30, 25))");
    expect(needsImport).toBe("patterns");
    expect(parses(out)).toBe(true);
  });

  it("names a non-default plane and omits the default one", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      spec: { kind: "grid", nx: 2, ny: 2, dx: 10, dy: 10, plane: "XZ" },
    });
    expect(out).toContain('patterns.grid(2, 2, 10, 10, { plane: "XZ" })');
  });

  it("writes a circular pattern as repeat + polar", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      spec: { kind: "polar", count: 6, radius: 40, axis: "Z" },
    });
    expect(out).toContain("patterns.repeat(base, patterns.polar(6, 40))");
    expect(parses(out)).toBe(true);
  });

  it("names a non-default axis", () => {
    const { out } = run(SOURCE, {
      partName: "base",
      spec: { kind: "polar", count: 4, radius: 12.5, axis: "X" },
    });
    expect(out).toContain('patterns.polar(4, 12.5, { axis: "X" })');
  });

  it("uses repeat, not the spread form that frees the body", () => {
    // `spread(() => base, …)` is the call a reader writes first and it throws
    // "This object has been deleted" two placements later.
    const { out } = run(SOURCE, {
      partName: "base",
      spec: { kind: "grid", nx: 2, ny: 1, dx: 20, dy: 0, plane: "XY" },
    });
    expect(out).not.toContain("spread(");
    expect(out).toContain("patterns.repeat(");
  });

  it("refuses a pattern of one", () => {
    const r = computeArrangeEdit(SOURCE, {
      partName: "base",
      spec: { kind: "grid", nx: 1, ny: 1, dx: 10, dy: 10, plane: "XY" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("bad-spec");
  });

  it("refuses fractional counts", () => {
    const r = computeArrangeEdit(SOURCE, {
      partName: "base",
      spec: { kind: "polar", count: 2.5, radius: 10, axis: "Z" },
    });
    expect(r.ok).toBe(false);
  });
});

describe("hoisting", () => {
  it("lifts an inline expression so it is built once, not three times", () => {
    const inline = SOURCE.replace("{ shape: base,", '{ shape: base.mirror("XZ"),');
    const { out, hoistedAs } = run(inline, {
      partName: "base",
      spec: { kind: "polar", count: 5, radius: 20, axis: "Z" },
    });
    expect(hoistedAs).toBe("base2");
    expect(out).toContain('const base2 = base.mirror("XZ");');
    expect(out).toContain("patterns.repeat(base2, patterns.polar(5, 20))");
    expect(out.match(/base\.mirror/g)?.length).toBe(1);
    expect(parses(out)).toBe(true);
  });

  it("leaves a plain name alone", () => {
    const { hoistedAs } = run(SOURCE, { partName: "base", spec: { kind: "mirror", plane: "XZ" } });
    expect(hoistedAs).toBeUndefined();
  });
});

describe("refusals", () => {
  it("reports a name the file does not declare", () => {
    const r = computeArrangeEdit(SOURCE, {
      partName: "ghost",
      spec: { kind: "mirror", plane: "XZ" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("part-not-found");
  });

  it("refuses a new body under a name already in use", () => {
    const r = computeArrangeEdit(SOURCE, {
      partName: "base",
      spec: { kind: "mirror", plane: "XZ" },
      asNewBody: "base",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("name-taken");
  });
});
