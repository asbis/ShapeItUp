/**
 * Tests for the parameter writeback splice.
 *
 * The load-bearing property is that a successful edit changes ONLY the value
 * literal: `applyEdit(src, edit)` must differ from `src` in exactly that range.
 * Several tests assert on the full rebuilt source rather than the offsets, so a
 * regression shows up as a readable diff instead of two numbers.
 */
import { describe, it, expect } from "vitest";
import {
  computeParamEdit,
  findParamSlots,
  listNumericParams,
  parseNumericLiteral,
  formatNumber,
  type ParamEdit,
} from "./param-edit.js";

function applyEdit(src: string, edit: ParamEdit): string {
  return src.slice(0, edit.start) + edit.text + src.slice(edit.end);
}

/** Apply and assert success in one step — most tests only care about the result. */
function edited(src: string, name: string, value: number): string {
  const r = computeParamEdit(src, name, value);
  if (!r.ok) throw new Error(`expected an edit, got ${r.reason}`);
  return applyEdit(src, r.edit);
}

const BASIC = `import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, depth: 50, height: 30 };

export default function main({ width, depth, height }: typeof params) {
  return drawRoundedRectangle(width, depth, 5).sketchOnPlane("XY").extrude(height);
}
`;

describe("computeParamEdit", () => {
  it("replaces exactly the value literal and nothing else", () => {
    const r = computeParamEdit(BASIC, "depth", 65);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(BASIC.slice(r.edit.start, r.edit.end)).toBe("50");
    expect(applyEdit(BASIC, r.edit)).toBe(BASIC.replace("depth: 50", "depth: 65"));
  });

  it("edits the first and last key as readily as a middle one", () => {
    expect(edited(BASIC, "width", 90)).toContain("{ width: 90, depth: 50");
    expect(edited(BASIC, "height", 12)).toContain("height: 12 }");
  });

  it("writes negative and fractional values", () => {
    const src = "export const params = { offset: 0, scale: 1 };";
    expect(edited(src, "offset", -12.5)).toContain("offset: -12.5");
    expect(edited(src, "scale", 0.25)).toContain("scale: 0.25");
  });

  it("reports unchanged rather than dirtying the file", () => {
    const r = computeParamEdit(BASIC, "width", 80);
    expect(r).toEqual({ ok: false, reason: "unchanged" });
  });

  it("distinguishes its failure modes", () => {
    expect(computeParamEdit("const x = 1;", "width", 5)).toEqual({
      ok: false,
      reason: "no-params-declaration",
    });
    expect(computeParamEdit(BASIC, "nope", 5)).toEqual({
      ok: false,
      reason: "param-not-found",
    });
    expect(computeParamEdit(BASIC, "width", NaN)).toEqual({
      ok: false,
      reason: "not-a-numeric-literal",
    });
  });

  it("refuses to rewrite a computed value", () => {
    const src = `export const params = { wall: 3, outer: 40, inner: outer - 2 * wall };`;
    expect(computeParamEdit(src, "inner", 30)).toEqual({
      ok: false,
      reason: "not-a-numeric-literal",
    });
    // ...but its plain-number siblings stay editable.
    expect(edited(src, "wall", 4)).toContain("wall: 4");
  });

  it("refuses non-numeric values", () => {
    const src = `export const params = { finish: "satin", useHeatSet: true, n: 4 };`;
    for (const name of ["finish", "useHeatSet"]) {
      expect(computeParamEdit(src, name, 1)).toEqual({
        ok: false,
        reason: "not-a-numeric-literal",
      });
    }
    expect(edited(src, "n", 6)).toContain("n: 6");
  });
});

describe("computeParamEdit — things that hide a false match", () => {
  it("ignores a key that only appears in a comment", () => {
    const src = [
      "export const params = {",
      "  // width: 999 — the old value, kept for reference",
      "  width: 80,",
      "  /* depth: 111 */",
      "  depth: 50,",
      "};",
    ].join("\n");
    const out = edited(src, "width", 85);
    expect(out).toContain("// width: 999 — the old value, kept for reference");
    expect(out).toContain("width: 85,");
    expect(edited(src, "depth", 55)).toContain("/* depth: 111 */");
  });

  it("ignores a key that only appears inside a string", () => {
    const src = `export const params = { label: "width: 999", width: 80 };`;
    const out = edited(src, "width", 12);
    expect(out).toBe(`export const params = { label: "width: 999", width: 12 };`);
  });

  it("ignores a same-named key nested one level down", () => {
    const src = [
      "export const params = {",
      "  width: 80,",
      "  bolt: { width: 3, length: 12 },",
      "};",
    ].join("\n");
    const out = edited(src, "width", 90);
    expect(out).toContain("width: 90,");
    expect(out).toContain("bolt: { width: 3, length: 12 }");
  });

  it("ignores a declaration that is itself commented out", () => {
    const src = [
      "// export const params = { width: 1 };",
      "export const params = { width: 80 };",
    ].join("\n");
    const out = edited(src, "width", 42);
    expect(out).toContain("// export const params = { width: 1 };");
    expect(out).toContain("export const params = { width: 42 };");
  });

  it("ignores a params object declared inside a function", () => {
    const src = [
      "function helper() {",
      "  const params = { width: 1 };",
      "  return params;",
      "}",
      "export const params = { width: 80 };",
    ].join("\n");
    const out = edited(src, "width", 42);
    expect(out).toContain("const params = { width: 1 };");
    expect(out).toContain("export const params = { width: 42 };");
  });

  it("handles a template literal containing braces", () => {
    const src = "export const params = { tag: `w=${1 + 1}`, width: 80 };";
    expect(edited(src, "width", 5)).toBe(
      "export const params = { tag: `w=${1 + 1}`, width: 5 };",
    );
  });
});

describe("computeParamEdit — declaration shapes", () => {
  it("accepts a trailing comma and multiline formatting", () => {
    const src = ["export const params = {", "  width: 80,", "  depth: 50,", "};"].join("\n");
    expect(edited(src, "depth", 51)).toBe(
      ["export const params = {", "  width: 80,", "  depth: 51,", "};"].join("\n"),
    );
  });

  it("accepts quoted keys", () => {
    const src = `export const params = { "wall-thickness": 3, depth: 50 };`;
    expect(edited(src, "wall-thickness", 4)).toContain(`"wall-thickness": 4`);
  });

  it("accepts a type annotation on the declaration", () => {
    const src = `export const params: Params = { width: 80 };`;
    expect(edited(src, "width", 90)).toBe(`export const params: Params = { width: 90 };`);
  });

  it("accepts numeric separators and rewrites them as a plain number", () => {
    const src = "export const params = { steps: 1_000 };";
    const slots = findParamSlots(src)!;
    expect(slots[0]!.numeric).toBe(1000);
    expect(edited(src, "steps", 2000)).toBe("export const params = { steps: 2000 };");
  });

  it("skips a spread without losing the keys around it", () => {
    const src = "export const params = { ...defaults, width: 80, depth: 50 };";
    expect(listNumericParams(src)).toEqual(["width", "depth"]);
    expect(edited(src, "depth", 55)).toContain("...defaults, width: 80, depth: 55");
  });

  it("returns no declaration for an unbalanced object", () => {
    expect(computeParamEdit("export const params = { width: 80", "width", 5)).toEqual({
      ok: false,
      reason: "no-params-declaration",
    });
  });
});

describe("findParamSlots / listNumericParams", () => {
  it("reports which params a slider may write", () => {
    const src = [
      "export const params = {",
      "  width: 80,",
      "  derived: width * 2,",
      '  finish: "satin",',
      "  depth: 50,",
      "};",
    ].join("\n");
    expect(listNumericParams(src)).toEqual(["width", "depth"]);
  });

  it("gives ranges that slice back to the original text", () => {
    const slots = findParamSlots(BASIC)!;
    expect(slots.map((s) => s.name)).toEqual(["width", "depth", "height"]);
    for (const s of slots) expect(BASIC.slice(s.valueStart, s.valueEnd)).toBe(s.raw);
  });

  it("returns null when there is nothing to read", () => {
    expect(findParamSlots("const x = 1;")).toBeNull();
    expect(listNumericParams("const x = 1;")).toEqual([]);
  });
});

describe("parseNumericLiteral", () => {
  it("accepts the forms a parameter is actually written in", () => {
    expect(parseNumericLiteral("80")).toBe(80);
    expect(parseNumericLiteral("-12.5")).toBe(-12.5);
    expect(parseNumericLiteral("+3")).toBe(3);
    expect(parseNumericLiteral("0.25")).toBe(0.25);
    expect(parseNumericLiteral(".5")).toBe(0.5);
    expect(parseNumericLiteral("1e3")).toBe(1000);
    expect(parseNumericLiteral("1_000")).toBe(1000);
  });

  it("rejects other bases, bigint and non-numbers", () => {
    for (const raw of ["0x1F", "0b101", "0o17", "10n", "true", '"80"', "width", ""]) {
      expect(parseNumericLiteral(raw)).toBeNull();
    }
  });
});

describe("formatNumber", () => {
  it("keeps integers integral", () => {
    expect(formatNumber(7)).toBe("7");
    expect(formatNumber(-12)).toBe("-12");
    expect(formatNumber(0)).toBe("0");
  });

  it("rounds away binary float noise from slider stepping", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(7.300000000000001)).toBe("7.3");
  });

  it("strips trailing zeros and never emits exponent notation", () => {
    expect(formatNumber(7.5)).toBe("7.5");
    expect(formatNumber(2.0)).toBe("2");
    expect(formatNumber(0.0000001)).toBe("0");
  });
});

describe("computeParamEdit — adversarial", () => {
  const ed = (s: string, n: string, v: number) => {
    const r = computeParamEdit(s, n, v);
    return r.ok ? applyEdit(s, r.edit) : `FAIL:${r.reason}`;
  };

  it("a decoy declaration with a prefixed name", () => {
    const s = `export const paramsDefaults = { width: 1 };\nexport const params = { width: 80 };`;
    expect(ed(s, "width", 9)).toBe(`export const paramsDefaults = { width: 1 };\nexport const params = { width: 9 };`);
  });
  it("division is not a comment", () => {
    const s = `export const params = { ratio: 10 / 2, width: 80 };`;
    expect(ed(s, "ratio", 5)).toBe("FAIL:not-a-numeric-literal");
    expect(ed(s, "width", 9)).toContain("ratio: 10 / 2, width: 9");
  });
  it("regex literal in a value", () => {
    const s = `export const params = { re: /a,b}/, width: 80 };`;
    // The brace inside the regex must not close the object early.
    expect(ed(s, "width", 9)).toContain("width: 9");
  });
  it("CRLF line endings", () => {
    const s = "export const params = {\r\n  width: 80,\r\n  depth: 50,\r\n};";
    expect(ed(s, "depth", 51)).toBe("export const params = {\r\n  width: 80,\r\n  depth: 51,\r\n};");
  });
  it("trailing same-line comment after the value", () => {
    const s = "export const params = {\n  width: 80, // mm\n};";
    expect(ed(s, "width", 81)).toBe("export const params = {\n  width: 81, // mm\n};");
  });
  it("a key literally named params", () => {
    const s = `export const params = { params: 3, width: 80 };`;
    expect(ed(s, "params", 4)).toContain("params: 4, width: 80");
  });
  it("empty object", () => {
    expect(ed("export const params = {};", "w", 1)).toBe("FAIL:param-not-found");
  });
  it("unicode + escaped quotes in a neighbouring string", () => {
    const s = `export const params = { note: "sier \\"width: 9\\" — ø", width: 80 };`;
    expect(ed(s, "width", 7)).toBe(`export const params = { note: "sier \\"width: 9\\" — ø", width: 7 };`);
  });
  it("array value containing braces and commas", () => {
    const s = `export const params = { holes: [{x:1},{x:2}], width: 80 };`;
    expect(listNumericParams(s)).toEqual(["width"]);
    expect(ed(s, "width", 7)).toContain("holes: [{x:1},{x:2}], width: 7");
  });
  it("arrow function value", () => {
    const s = `export const params = { fn: (a, b) => a + b, width: 80 };`;
    expect(ed(s, "width", 7)).toContain("width: 7");
  });
  it("nested template with a nested object inside the substitution", () => {
    const s = "export const params = { t: `${ {a:1}.a }`, width: 80 };";
    expect(ed(s, "width", 7)).toContain("width: 7");
  });
  it("property named export/const does not confuse the head match", () => {
    const s = `const o = { export: 1 };\nexport const params = { width: 80 };`;
    expect(ed(s, "width", 7)).toContain("export const params = { width: 7 }");
  });
  it("re-scanning after an edit is stable", () => {
    let s = "export const params = {\n  a: 1,\n  b: 2.5,\n  c: -3,\n};";
    const before = findParamSlots(s)!.map(x => x.name);
    for (const [n, v] of [["a", 10], ["b", 0.125], ["c", 99]] as const) s = ed(s, n, v as number);
    expect(findParamSlots(s)!.map(x => x.name)).toEqual(before);
    expect(s).toBe("export const params = {\n  a: 10,\n  b: 0.125,\n  c: 99,\n};");
  });
});
