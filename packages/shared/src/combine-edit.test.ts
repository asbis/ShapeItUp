/**
 * computeCombineEdit — the source rewrite behind the viewer's Combine.
 *
 * Every case that produces edits also runs the result through esbuild, because
 * the failure that matters here is not a wrong-looking string but a `.shape.ts`
 * that no longer parses. An array element removed without its comma reads fine
 * in a diff and is a syntax error.
 */
import { describe, it, expect } from "vitest";
import { transformSync } from "esbuild";
import { computeCombineEdit, applyEdits, type CombineRequest } from "./combine-edit.js";

const TWO_NAMED = `import { drawRectangle } from "replicad";

export const params = { w: 40, t: 8 };

export default function main({ w, t }: typeof params) {
  const base = drawRectangle(w, w).sketchOnPlane("XY").extrude(t);
  const boss = drawRectangle(10, 10).sketchOnPlane("XY", t - 2).extrude(10);
  return [
    { shape: base, name: "base", color: "#888" },
    { shape: boss, name: "boss", color: "#c33" },
  ];
}
`;

/** Parse the result the way the bundler will. Throws on a syntax error. */
function parses(src: string): boolean {
  transformSync(src, { loader: "ts" });
  return true;
}

function run(source: string, req: CombineRequest) {
  const r = computeCombineEdit(source, req);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason} (${r.detail ?? ""})`);
  return { ...r, out: applyEdits(source, r.edits) };
}

describe("the basic combine", () => {
  it("wraps the target, drops the tool's entry, and imports the helper", () => {
    const { out, removed, addedImport } = run(TWO_NAMED, {
      op: "join",
      targetName: "base",
      toolNames: ["boss"],
    });
    expect(out).toContain(`{ shape: joinBodies(base, boss), name: "base", color: "#888" },`);
    expect(out).not.toContain(`name: "boss"`);
    expect(out).toContain(`import { joinBodies } from "shapeitup";`);
    expect(removed).toEqual(["boss"]);
    expect(addedImport).toBe(true);
    expect(parses(out)).toBe(true);
  });

  it("names the right helper for each operation", () => {
    for (const [op, helper] of [
      ["join", "joinBodies"],
      ["cut", "cutBodies"],
      ["intersect", "intersectBodies"],
    ] as const) {
      const { out } = run(TWO_NAMED, { op, targetName: "base", toolNames: ["boss"] });
      expect(out).toContain(`${helper}(base, boss)`);
    }
  });

  it("keeps the tool's own const, which nothing else needed to change", () => {
    const { out } = run(TWO_NAMED, { op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(out).toContain("const boss = drawRectangle(10, 10)");
  });

  it("passes several tools as a list", () => {
    const three = TWO_NAMED.replace(
      `    { shape: boss, name: "boss", color: "#c33" },\n`,
      `    { shape: boss, name: "boss", color: "#c33" },\n    { shape: boss, name: "rib", color: "#3c3" },\n`,
    );
    const { out, removed } = run(three, {
      op: "cut",
      targetName: "base",
      toolNames: ["boss", "rib"],
    });
    expect(out).toContain("cutBodies(base, [boss, boss])");
    expect(removed).toEqual(["boss", "rib"]);
    expect(parses(out)).toBe(true);
  });
});

describe("Keep Tools", () => {
  it("leaves the entry alone when the tool is already a name", () => {
    const { out, removed, hoisted } = run(TWO_NAMED, {
      op: "join",
      targetName: "base",
      toolNames: ["boss"],
      keepTools: true,
    });
    expect(out).toContain(`joinBodies(base, boss)`);
    expect(out).toContain(`{ shape: boss, name: "boss", color: "#c33" },`);
    expect(removed).toEqual([]);
    expect(hoisted).toEqual([]);
    expect(parses(out)).toBe(true);
  });

  it("hoists an inline expression rather than evaluating it twice", () => {
    const inline = TWO_NAMED.replace(
      `{ shape: boss, name: "boss", color: "#c33" },`,
      `{ shape: boss.translate(5, 0, 0), name: "boss", color: "#c33" },`,
    );
    const { out, hoisted } = run(inline, {
      op: "cut",
      targetName: "base",
      toolNames: ["boss"],
      keepTools: true,
    });
    expect(hoisted).toEqual(["boss"]);
    // One evaluation, named, used by both the call and the surviving entry.
    // Indented to match the statement it sits above. A const flush against the
    // margin, with the return it precedes shoved out by the leftover indent,
    // is what the first version wrote.
    expect(out).toContain("\n  const boss2 = boss.translate(5, 0, 0);\n  return [");
    expect(out).toContain("cutBodies(base, boss2)");
    expect(out).toContain(`{ shape: boss2, name: "boss", color: "#c33" },`);
    expect(out.match(/boss\.translate/g)?.length).toBe(1);
    expect(parses(out)).toBe(true);
  });

  it("puts the hoisted const above the statement that holds the parts list", () => {
    const viaConst = TWO_NAMED.replace(
      `{ shape: boss, name: "boss", color: "#c33" },`,
      `{ shape: boss.translate(5, 0, 0), name: "boss", color: "#c33" },`,
    )
      .replace("  return [", "  const parts = [")
      .replace("  ];\n}", "  ];\n  return parts;\n}");
    const { out } = run(viaConst, {
      op: "join",
      targetName: "base",
      toolNames: ["boss"],
      keepTools: true,
    });
    expect(out).toContain("\n  const boss2 = boss.translate(5, 0, 0);\n  const parts = [");
    const hoistAt = out.indexOf("const boss2 =");
    const listAt = out.indexOf("const parts = [");
    expect(hoistAt).toBeGreaterThan(-1);
    // Above its own use, not inside the array it is used from.
    expect(hoistAt).toBeLessThan(listAt);
    expect(parses(out)).toBe(true);
  });
});

describe("removing an entry without breaking the array", () => {
  it("takes the trailing comma when there is one", () => {
    const { out } = run(TWO_NAMED, { op: "cut", targetName: "boss", toolNames: ["base"] });
    expect(out).not.toContain(",\n    ,");
    expect(parses(out)).toBe(true);
  });

  it("takes the LEADING comma when the entry is last and has none trailing", () => {
    const noTrailing = TWO_NAMED.replace(
      `    { shape: boss, name: "boss", color: "#c33" },\n`,
      `    { shape: boss, name: "boss", color: "#c33" }\n`,
    );
    const { out } = run(noTrailing, { op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(out).not.toMatch(/,\s*\]/);
    expect(parses(out)).toBe(true);
  });

  it("closes up a one-line array without leaving a hole", () => {
    const oneLine = `import { drawRectangle } from "replicad";
export default function main() {
  const a = drawRectangle(1, 1).sketchOnPlane("XY").extrude(1);
  const b = drawRectangle(2, 2).sketchOnPlane("XY").extrude(1);
  return [{ shape: a, name: "a" }, { shape: b, name: "b" }];
}
`;
    const { out } = run(oneLine, { op: "join", targetName: "a", toolNames: ["b"] });
    expect(out).toContain("return [{ shape: joinBodies(a, b), name: \"a\" }];");
    expect(parses(out)).toBe(true);
  });

  it("does not leave a blank line where the entry was", () => {
    const { out } = run(TWO_NAMED, { op: "join", targetName: "base", toolNames: ["boss"] });
    expect(out).not.toMatch(/\n[ \t]*\n[ \t]*\];/);
    expect(parses(out)).toBe(true);
  });
});

describe("the import", () => {
  it("joins an existing shapeitup import instead of adding a second line", () => {
    const withImport = TWO_NAMED.replace(
      `import { drawRectangle } from "replicad";`,
      `import { drawRectangle } from "replicad";\nimport { holes } from "shapeitup";`,
    );
    const { out } = run(withImport, { op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(out).toContain(`import { holes, cutBodies } from "shapeitup";`);
    expect(out.match(/from "shapeitup"/g)?.length).toBe(1);
    expect(parses(out)).toBe(true);
  });

  it("does not re-import a helper that is already in scope", () => {
    const withImport = TWO_NAMED.replace(
      `import { drawRectangle } from "replicad";`,
      `import { drawRectangle } from "replicad";\nimport { cutBodies } from "shapeitup";`,
    );
    const r = computeCombineEdit(withImport, {
      op: "cut",
      targetName: "base",
      toolNames: ["boss"],
    });
    expect(r.ok && r.addedImport).toBe(false);
  });
});

describe("refusals", () => {
  const bad = (req: CombineRequest) => {
    const r = computeCombineEdit(TWO_NAMED, req);
    return r.ok ? "ok" : r.reason;
  };

  it("refuses to combine a body with itself", () => {
    expect(bad({ op: "join", targetName: "base", toolNames: ["base"] })).toBe("self-combine");
  });

  it("refuses with no tools", () => {
    expect(bad({ op: "join", targetName: "base", toolNames: [] })).toBe("no-tools");
  });

  it("reports a name the file does not declare", () => {
    const r = computeCombineEdit(TWO_NAMED, {
      op: "join",
      targetName: "base",
      toolNames: ["nope"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("part-not-found");
      expect(r.detail).toBe("nope");
    }
  });

  it("does not mistake a part name inside a comment or string for a declaration", () => {
    const decoy = TWO_NAMED.replace(
      "export default function main",
      `// { shape: fake, name: "ghost" }\nconst note = '{ shape: fake, name: "ghost" }';\nexport default function main`,
    );
    expect(
      (computeCombineEdit(decoy, { op: "join", targetName: "base", toolNames: ["ghost"] }) as any)
        .reason,
    ).toBe("part-not-found");
  });
});
