import { describe, it, expect } from "vitest";
import { extrudeCentered } from "./placement";

// Minimal Sketch stub: records the translate arguments the returned "solid"
// receives so we can verify extrudeCentered's shift math without touching
// OCCT/Manifold. The stub's `translate` returns a marker solid so the test
// can distinguish the post-translate result from the pre-translate extrude.
function makeSketchStub(distanceCaptured: number[], translates: Array<[number, number, number]>) {
  const solid = {
    translate(x: number, y: number, z: number) {
      translates.push([x, y, z]);
      return { __translated: true, x, y, z };
    },
  };
  return {
    extrude(d: number) {
      distanceCaptured.push(d);
      return solid;
    },
  };
}

describe("extrudeCentered (plane passed explicitly)", () => {
  it("XY plane: shifts by -distance/2 on Z", () => {
    const ds: number[] = [];
    const ts: Array<[number, number, number]> = [];
    const result = extrudeCentered(makeSketchStub(ds, ts), 20, { plane: "XY" }) as any;
    expect(ds).toEqual([20]);
    expect(ts).toEqual([[0, 0, -10]]);
    expect(result.__translated).toBe(true);
  });

  it("XZ plane: native [-L, 0] on Y → shift +L/2 to land at [-L/2, +L/2]", () => {
    // XZ has nativeSign=-1 on Y, so native bbox is Y ∈ [-20, 0]; we need
    // shift = +10 to recenter on origin.
    const ds: number[] = [];
    const ts: Array<[number, number, number]> = [];
    extrudeCentered(makeSketchStub(ds, ts), 20, { plane: "XZ" });
    expect(ts).toEqual([[0, 10, 0]]);
  });

  it("YZ plane: native [0, L] on X → shift -L/2 to recenter", () => {
    const ds: number[] = [];
    const ts: Array<[number, number, number]> = [];
    extrudeCentered(makeSketchStub(ds, ts), 20, { plane: "YZ" });
    expect(ts).toEqual([[-10, 0, 0]]);
  });

  it("throws on non-positive distance", () => {
    expect(() =>
      extrudeCentered(makeSketchStub([], []), 0, { plane: "XY" }),
    ).toThrow(/positive finite/);
    expect(() =>
      extrudeCentered(makeSketchStub([], []), -5, { plane: "XY" }),
    ).toThrow(/positive finite/);
  });

  it("throws when plane can't be inferred and no explicit plane given", () => {
    expect(() =>
      extrudeCentered(makeSketchStub([], []), 10),
    ).toThrow(/could not determine the sketch's plane/);
  });

  it("throws when sketch lacks extrude()", () => {
    expect(() =>
      extrudeCentered({} as any, 10, { plane: "XY" }),
    ).toThrow(/Sketch/);
  });
});
