/**
 * extrudeFace against real OCCT.
 *
 * Volumes are checked against independently computed expectations rather than
 * against snapshots, because the interesting failures here are geometric —
 * a hole paved over, a push that adds instead of removes — and a snapshot
 * would happily record any of them.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadOCCTForTest } from "../testing/occt.js";
import { resetRuntimeWarnings, drainRuntimeWarnings } from "./warnings.js";

let rc: typeof import("replicad");
let extrudeFace: typeof import("./faces.js").extrudeFace;

beforeAll(async () => {
  const oc = await loadOCCTForTest();
  rc = await import("replicad");
  rc.setOC(oc);
  ({ extrudeFace } = await import("./faces.js"));
}, 120_000);

/** 80 x 60 x 8 plate, corners rounded r6, with a central Ø12 through-hole. */
const build = () => {
  const plate = rc.drawRoundedRectangle(80, 60, 6).sketchOnPlane().extrude(8) as any;
  return plate.cut(rc.drawCircle(6).sketchOnPlane("XY", -1).extrude(10) as any);
};

// Area of that top face: the rectangle, less what the four r6 corners cut off,
// less the hole.
const TOP_AREA = 80 * 60 - 4 * (36 - 9 * Math.PI) - Math.PI * 36;
const BASE_VOLUME = TOP_AREA * 8;
const top = (f: any) => f.inPlane("XY", 8);
const vol = (s: any) => rc.measureVolume(s);

beforeAll(() => resetRuntimeWarnings());

describe("extrudeFace", () => {
  it("pulls a face outward and adds exactly that prism", () => {
    const out = extrudeFace(build(), top, 10);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME + 10 * TOP_AREA, 1);
  });

  it("keeps holes in the face instead of paving over them", () => {
    // The naive construction — extrude the outer wire and fuse — would give
    // BASE + 10 * (TOP_AREA + hole), i.e. a solid plug where the bore was.
    const out = extrudeFace(build(), top, 10);
    const paved = BASE_VOLUME + 10 * (TOP_AREA + Math.PI * 36);
    expect(vol(out)).toBeLessThan(paved - 1);
    // And the bore is still a bore, not a blind pocket: the through-hole's
    // cylindrical face survives, so the face count is unchanged.
    expect(new rc.FaceFinder().find(out).length).toBe(
      new rc.FaceFinder().find(build()).length,
    );
  });

  it("pushes a face inward on a negative distance", () => {
    const out = extrudeFace(build(), top, -3);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME - 3 * TOP_AREA, 1);
  });

  it("treats zero as a no-op rather than an error", () => {
    resetRuntimeWarnings();
    const out = extrudeFace(build(), top, 0);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings()).toHaveLength(0);
  });

  it("works on a face that is not axis-aligned with Z", () => {
    // The +X side wall: normal (1,0,0), so the prism grows along X.
    const side = (f: any) => f.inPlane("YZ", 40);
    const before = build();
    const sideArea = rc.measureShapeSurfaceProperties(
      new rc.FaceFinder().inPlane("YZ", 40).find(before, { unique: true }),
    ).area;
    const out = extrudeFace(build(), side, 5);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME + 5 * sideArea, 1);
  });

  it("declines an ambiguous selector instead of picking one at random", () => {
    resetRuntimeWarnings();
    // Every planar face parallel to XY: the top AND the bottom.
    const both = (f: any) => f.parallelTo("XY");
    const out = extrudeFace(build(), both, 5);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/matched 2 faces/);
  });

  it("declines when nothing matches, and says so", () => {
    resetRuntimeWarnings();
    const out = extrudeFace(build(), (f: any) => f.inPlane("XY", 999), 5);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/no face matched/);
  });

  it("declines a curved face rather than guessing a direction", () => {
    resetRuntimeWarnings();
    // The bore wall is a cylinder; "along its normal" has no single meaning.
    // A point on the Ø12 bore wall: radius 6 on the +X side, halfway up.
    const bore = (f: any) => f.containsPoint([6, 0, 4]);
    const out = extrudeFace(build(), bore, 5);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/only planar faces/);
  });

  it("survives a selector that throws", () => {
    resetRuntimeWarnings();
    const out = extrudeFace(build(), () => {
      throw new Error("bad selector");
    }, 5);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/could not evaluate/);
  });
});
