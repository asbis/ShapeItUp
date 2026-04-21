/**
 * plates.plate — rectangular plate with near face anchored at origin on the
 * named `normal` axis.
 *
 * `plate` delegates to `prism` (which owns the plane/sign math) with a
 * centred rectangle profile, so the test stubs the same plug points
 * `shapes.test.ts` stubs: `drawRectangle` returns a profile stub whose
 * `sketchOnPlane` / `extrude` calls are captured. No OCCT/WASM needed.
 */

import { describe, it, expect, vi } from "vitest";

type RectCall = { w: number; h: number };
type TranslateCall = [number, number, number];

const rectCalls: RectCall[] = [];
const extrudeCalls: number[] = [];
const planeCalls: string[] = [];
const postTranslateCalls: TranslateCall[] = [];
const rectTranslateCalls: Array<[number, number]> = [];

function makeExtrudedStub(): any {
  return {
    translate(x: number, y: number, z: number) {
      postTranslateCalls.push([x, y, z]);
      return this;
    },
  };
}

function makeSketchStub(): any {
  return {
    extrude(d: number) {
      extrudeCalls.push(d);
      return makeExtrudedStub();
    },
  };
}

function makeRectStub(w: number, h: number): any {
  const self: any = {
    __rect: true,
    w,
    h,
    sketchOnPlane(plane: string) {
      planeCalls.push(plane);
      return makeSketchStub();
    },
    translate(x: number, y: number) {
      rectTranslateCalls.push([x, y]);
      // Chain — the post-translate still needs `.sketchOnPlane(...)`.
      return self;
    },
  };
  return self;
}

vi.mock("replicad", () => ({
  drawRectangle: (w: number, h: number) => {
    rectCalls.push({ w, h });
    return makeRectStub(w, h);
  },
  makeBox: () => ({}),
}));

import { plate } from "./shapes";

function reset(): void {
  rectCalls.length = 0;
  extrudeCalls.length = 0;
  planeCalls.length = 0;
  postTranslateCalls.length = 0;
  rectTranslateCalls.length = 0;
}

describe("shapes.plate — all 6 normals", () => {
  // Expected plane + signed-extrude per normal axis, mirroring the PRISM_AXIS
  // table in shapes.ts. For +Z/−Y/+X the extrude sign is positive; for the
  // other three it's negative (so the body still lands in the named half-space).
  const cases: Array<{
    normal: "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";
    plane: "XY" | "XZ" | "YZ";
    sign: 1 | -1;
  }> = [
    { normal: "+Z", plane: "XY", sign: 1 },
    { normal: "-Z", plane: "XY", sign: -1 },
    { normal: "+Y", plane: "XZ", sign: -1 },
    { normal: "-Y", plane: "XZ", sign: 1 },
    { normal: "+X", plane: "YZ", sign: 1 },
    { normal: "-X", plane: "YZ", sign: -1 },
  ];

  for (const { normal, plane, sign } of cases) {
    it(`normal="${normal}" sketches on ${plane} and extrudes ${sign === 1 ? "+" : "-"}thickness`, () => {
      reset();
      plate({ size: [60, 40], thickness: 5, normal });
      // drawRectangle called once with the two in-plane dims.
      expect(rectCalls).toEqual([{ w: 60, h: 40 }]);
      // Centered by default — no post-rect translate.
      expect(rectTranslateCalls).toEqual([]);
      expect(planeCalls).toEqual([plane]);
      expect(extrudeCalls).toEqual([sign * 5]);
      // No `from` offset → no post-extrude translate.
      expect(postTranslateCalls).toEqual([]);
    });
  }

  it("default normal is '+Z'", () => {
    reset();
    plate({ size: [20, 10], thickness: 2 });
    expect(planeCalls).toEqual(["XY"]);
    expect(extrudeCalls).toEqual([2]);
  });

  it("center: false shifts the rectangle so the in-plane lower corner sits at origin", () => {
    reset();
    plate({ size: [60, 40], thickness: 5, normal: "+Z", center: false });
    expect(rectTranslateCalls).toEqual([[30, 20]]);
  });

  it("rejects bad inputs", () => {
    expect(() => plate({ size: [0, 10] as any, thickness: 5 })).toThrow(/size/);
    expect(() => plate({ size: [10, 10], thickness: 0 })).toThrow(/thickness/);
    expect(() =>
      plate({ size: [10, 10], thickness: 5, normal: "+Q" as any }),
    ).toThrow(/normal/);
    expect(() => plate(null as any)).toThrow(/opts/);
  });
});
