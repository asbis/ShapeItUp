/**
 * Tests for the Parameters panel helpers.
 *
 * The regression: a shape declaring `bearing: "608"` (the stdlib's own
 * flange example) crashed the viewer with "v.toFixed is not a function",
 * because every parameter was assumed to be a number.
 */
import { describe, it, expect } from "vitest";
import type { ParamDef } from "@shapeitup/shared";
import {
  formatParamValue,
  isNumericParam,
  numericDeclaredValues,
  paramLayoutMatches,
  paramStep,
} from "./params";

const flange: ParamDef[] = [
  { name: "outerD", value: 60, step: 1 },
  { name: "thickness", value: 5, step: 0.1 },
  { name: "bearing", value: "608" },
];

describe("formatParamValue", () => {
  it("formats numbers compactly", () => {
    expect(formatParamValue(60)).toBe("60");
    expect(formatParamValue(0.1 + 0.2)).toBe("0.3");
    expect(formatParamValue(1e-7)).toBe("0");
  });

  it("does not throw on strings or booleans", () => {
    expect(formatParamValue("608")).toBe('"608"');
    expect(formatParamValue("M4")).toBe('"M4"');
    expect(formatParamValue(true)).toBe("true");
  });
});

describe("isNumericParam", () => {
  it("gives only finite numbers an adjustable field", () => {
    expect(flange.map(isNumericParam)).toEqual([true, true, false]);
    expect(isNumericParam({ value: false })).toBe(false);
    expect(isNumericParam({ value: NaN })).toBe(false);
  });
});

describe("paramStep", () => {
  it("prefers the step the executor sent, else derives one", () => {
    expect(paramStep({ name: "a", value: 5, step: 1 })).toBe(1);
    expect(paramStep({ name: "a", value: 50 })).toBe(1);
    expect(paramStep({ name: "a", value: 5 })).toBe(0.1);
  });
});

describe("paramLayoutMatches", () => {
  it("matches the same names and kinds, whatever the values", () => {
    const moved = flange.map((p) => (p.name === "outerD" ? { ...p, value: 80 } : p));
    expect(paramLayoutMatches(flange, moved)).toBe(true);
  });

  it("rebuilds when a parameter changes kind", () => {
    const retyped = flange.map((p) => (p.name === "bearing" ? { ...p, value: 608 } : p));
    expect(paramLayoutMatches(flange, retyped)).toBe(false);
  });

  it("rebuilds when the set of names changes", () => {
    expect(paramLayoutMatches(flange, flange.slice(0, 2))).toBe(false);
  });
});

describe("numericDeclaredValues", () => {
  it("keeps numbers, prefers the declared value, and drops designators", () => {
    const params: ParamDef[] = [...flange, { name: "boltCount", value: 8, declared: 6 }];
    expect(numericDeclaredValues(params)).toEqual({ outerD: 60, thickness: 5, boltCount: 6 });
  });
});
