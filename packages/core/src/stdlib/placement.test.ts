import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { extrudeCentered } from "./placement";
import { initCore } from "../index.js";
import { loadOCCTForTest } from "../testing/occt.js";

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

// ---------------------------------------------------------------------------
// The extrude-plane hint recommends placeOn — so placeOn must never raise it.
//
// It used to, but only in shipped builds. The hint decided "is this the user's
// extrude?" by looking for a `/stdlib/` frame in the call stack, which is there
// when core runs from source (as here) and gone once it is bundled into the
// worker, the MCP server, or the website. The stub below gives every stack the
// single-file shape a bundle has, so these tests fail the way users saw it.
// ---------------------------------------------------------------------------

describe("extrude-plane hint vs. the stdlib helpers it recommends (real OCCT)", () => {
  let core: Awaited<ReturnType<typeof initCore>>;
  const realPrepare = Error.prepareStackTrace;

  beforeAll(async () => {
    core = await initCore(loadOCCTForTest);
  }, 120_000);

  afterEach(() => {
    Error.prepareStackTrace = realPrepare;
  });

  function asBundled() {
    Error.prepareStackTrace = (err) => `${err}\n    at main (bundle.js:1:1)`;
  }

  const HINT = /bounding box will be/;

  async function warningsFor(body: string) {
    asBundled();
    const r = await core.execute(`
      const { draw, drawRectangle } = __replicad__;
      const { placeOn, extrudeCentered } = __shapeitup__;
      function main() { ${body} }
    `);
    return r.warnings;
  }

  it("still fires for the user's own sketchOnPlane('YZ').extrude (the stub keeps the hint live)", async () => {
    const warnings = await warningsFor(
      `return draw([0, 0]).lineTo([-24, 0]).lineTo([0, 24]).close().sketchOnPlane("YZ").extrude(5);`,
    );
    expect(warnings.some((w) => HINT.test(w))).toBe(true);
  });

  it("does not fire for placeOn — the bracket example's gusset rib", async () => {
    const warnings = await warningsFor(
      `return placeOn(draw([0, 0]).lineTo([-24, 0]).lineTo([0, 24]).close(), "YZ", { into: "+X", distance: 5 });`,
    );
    expect(warnings.filter((w) => HINT.test(w))).toEqual([]);
  });

  it("does not fire for extrudeCentered", async () => {
    const warnings = await warningsFor(
      `return extrudeCentered(drawRectangle(40, 20).sketchOnPlane("XZ"), 10);`,
    );
    expect(warnings.filter((w) => HINT.test(w))).toEqual([]);
  });
});
