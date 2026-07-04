import { describe, it, expect } from "vitest";
import * as mounts from "./mounts";

// API-surface + validation tests. OCCT is NOT required — every assertion here
// either checks an export or hits a guard that throws BEFORE makeCylinder runs.

describe("mounts — API surface", () => {
  it("exports keyhole and peg factories", () => {
    expect(typeof mounts.keyhole).toBe("function");
    expect(typeof mounts.peg).toBe("function");
  });
});

describe("mounts.keyhole — validation (pre-OCCT)", () => {
  it("rejects largeD <= smallD (head must be wider than neck)", () => {
    expect(() => mounts.keyhole({ largeD: 4, smallD: 9, plateThickness: 2 })).toThrow(
      /greater than smallD/,
    );
  });

  it("rejects non-positive plate thickness", () => {
    expect(() => mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 0 })).toThrow();
  });

  it("rejects an unknown axis", () => {
    expect(() =>
      mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, axis: "+W" as never }),
    ).toThrow(/unknown axis/);
  });

  it("rejects clearances that exceed the hole sizes", () => {
    expect(() =>
      mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, neckClear: 5 }),
    ).toThrow(/clearances exceed/);
  });
});

describe("mounts.peg — validation (pre-OCCT)", () => {
  it("rejects clear >= holeD", () => {
    expect(() => mounts.peg({ holeD: 4, plateThickness: 2, clear: 4 })).toThrow(/non-positive/);
  });

  it("rejects an unknown axis", () => {
    expect(() =>
      mounts.peg({ holeD: 4, plateThickness: 2, axis: "Q" as never }),
    ).toThrow(/unknown axis/);
  });
});

describe("mounts.pegboardGrid — API + validation (pre-OCCT)", () => {
  const kh = { largeD: 9, smallD: 4, plateThickness: 2 };

  it("is exported", () => {
    expect(typeof mounts.pegboardGrid).toBe("function");
  });

  it("rejects non-integer or <1 cols/rows", () => {
    expect(() => mounts.pegboardGrid({ cols: 0, rows: 2, keyhole: kh })).toThrow(/integers/);
    expect(() => mounts.pegboardGrid({ cols: 2, rows: 1.5, keyhole: kh })).toThrow(/integers/);
  });

  it("requires exactly one of keyhole or peg", () => {
    expect(() => mounts.pegboardGrid({ cols: 2, rows: 2 })).toThrow(/exactly one/);
    expect(() =>
      mounts.pegboardGrid({ cols: 2, rows: 2, keyhole: kh, peg: { holeD: 4, plateThickness: 2 } }),
    ).toThrow(/exactly one/);
  });
});
