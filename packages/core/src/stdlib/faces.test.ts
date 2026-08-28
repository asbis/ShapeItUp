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
let filletFace: typeof import("./faces.js").filletFace;
let chamferFace: typeof import("./faces.js").chamferFace;
let filletEdge: typeof import("./faces.js").filletEdge;
let chamferEdge: typeof import("./faces.js").chamferEdge;
let probeMaxRadius: typeof import("./faces.js").probeMaxRadius;
let shellFace: typeof import("./faces.js").shellFace;
let probeMaxShell: typeof import("./faces.js").probeMaxShell;

beforeAll(async () => {
  const oc = await loadOCCTForTest();
  rc = await import("replicad");
  rc.setOC(oc);
  ({
    extrudeFace,
    filletFace,
    chamferFace,
    filletEdge,
    chamferEdge,
    probeMaxRadius,
    shellFace,
    probeMaxShell,
  } = await import("./faces.js"));
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

describe("filletFace / chamferFace", () => {
  const area = (s: any) => rc.measureShapeSurfaceProperties(s).area;

  it("rounds the edges around the picked face", () => {
    const before = build();
    const after = filletFace(build(), top, 2);
    // A fillet removes material from a convex edge, so the volume drops — and
    // it must actually drop, or the operation silently did nothing.
    expect(vol(after)).toBeLessThan(vol(before) - 1);
    expect(vol(after)).toBeGreaterThan(vol(before) * 0.9);
  });

  it("chamfers the same edges", () => {
    const after = chamferFace(build(), top, 1);
    expect(vol(after)).toBeLessThan(BASE_VOLUME - 1);
  });

  it("rounds the hole rim as well as the outer boundary", () => {
    // The picked face's boundary is its outer wire PLUS the wire of every hole
    // in it. This test discriminates: an implementation that read only the
    // outer wire would leave the bore's rim sharp, and the material it removed
    // would fall short by the bore's contribution.
    //
    //   outer perimeter  = 2(80+60) - 8r_corner + 2*pi*r_corner, r_corner = 6
    //                    = 280 - 48 + 37.70 = 269.70 mm
    //   bore rim         = 2*pi*6            =  37.70 mm
    //   an r=2 fillet removes (1 - pi/4)r^2  =   0.8584 mm^2 per mm of edge
    const R = 2;
    const perMm = (1 - Math.PI / 4) * R * R;
    const outerPerimeter = 2 * (80 + 60) - 8 * 6 + 2 * Math.PI * 6;
    const boreRim = 2 * Math.PI * 6;

    const removed = BASE_VOLUME - vol(filletFace(build(), top, R));

    // Both wires: within a few percent of the closed-form prediction.
    expect(removed).toBeCloseTo(perMm * (outerPerimeter + boreRim), 0);
    // And clearly MORE than the outer wire alone would account for, so the
    // test fails if the inner wires are ever dropped.
    expect(removed).toBeGreaterThan(perMm * outerPerimeter * 1.05);
  });

  it("declines a radius OCCT cannot apply, without breaking the shape", () => {
    resetRuntimeWarnings();
    // Far wider than the 8 mm plate is thick.
    const out = filletFace(build(), top, 50);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    const w = drainRuntimeWarnings().join(" ");
    expect(w).toMatch(/^filletFace:/);
    // This test loads replicad directly, without initCore, so core's own
    // fillet guard is not installed and OCCT's bare pointer comes through.
    // That is the path the generic hint exists for.
    //
    // In the running app the guard IS installed and produces something far
    // better — "radius 40mm exceeds minimum filtered edge length 9.42mm.
    // Reduce radius (try 4.24)" — which the helper passes through untouched.
    // Verified in the viewer; the branch is asserted below.
    expect(w).toMatch(/OCCT error \d+/);
    expect(w).toMatch(/probably too large for the surrounding material/);
  });

  it("passes a self-explaining fillet error through instead of burying it", () => {
    // Appending a vaguer sentence to a message that already names the fix
    // makes it worse, so the generic hint is added only for a bare pointer.
    //
    // The failure has to come from `.fillet` itself, not from the selector —
    // those are different catch blocks, and only this one formats the hint.
    resetRuntimeWarnings();
    const shape: any = build();
    const real = shape.fillet.bind(shape);
    shape.fillet = () => {
      throw new Error(
        "radius 40mm exceeds minimum filtered edge length 9.42mm. Reduce radius (try 4.24).",
      );
    };
    const out = filletFace(shape, top, 40);
    shape.fillet = real;

    expect(out).toBe(shape);
    const w = drainRuntimeWarnings().join(" ");
    expect(w).toMatch(/^filletFace: radius 40mm exceeds/);
    expect(w).toMatch(/Reduce radius \(try 4\.24\)/);
    expect(w).not.toMatch(/probably too large/);
  });

  it("declines a negative size", () => {
    resetRuntimeWarnings();
    expect(vol(filletFace(build(), top, -2))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/negative radius/);
    resetRuntimeWarnings();
    expect(vol(chamferFace(build(), top, -1))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/negative setback/);
  });

  it("treats zero as a no-op", () => {
    resetRuntimeWarnings();
    expect(vol(filletFace(build(), top, 0))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings()).toHaveLength(0);
  });

  it("declines an ambiguous or empty selector", () => {
    resetRuntimeWarnings();
    expect(vol(filletFace(build(), (f: any) => f.parallelTo("XY"), 1))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/matched 2 faces/);
    resetRuntimeWarnings();
    expect(vol(filletFace(build(), (f: any) => f.inPlane("XY", 999), 1))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/no face matched/);
  });

  it("takes only the boundary, not every edge the plane predicate would catch", () => {
    // This is the whole reason the helper reads the face's wires instead of
    // taking an EdgeFinder. On a plate whose top is ALREADY filleted,
    // `EdgeFinder.inPlane("XY", z)` also returns the arcs that merely start in
    // that plane and curve away — and OCCT then rejects the operation.
    const once = filletFace(build(), top, 1);
    const topOfOnce = (f: any) => f.inPlane("XY", 8);
    resetRuntimeWarnings();
    const twice = filletFace(once, topOfOnce, 0.4);
    // It may or may not be geometrically possible; what must NOT happen is a
    // throw, and the shape must survive either way.
    expect(Number.isFinite(vol(twice))).toBe(true);
  });
});

describe("filletEdge / chamferEdge", () => {
  // The plate's top-front straight edge: x on the centre line, y at half the
  // depth, z at the thickness. Verified against OCCT to match exactly one edge.
  const frontTop = (f: any) => f.containsPoint([0, -30, 8]);

  /** The same plate, but with a SHARP outline — no tangent neighbours. */
  const sharp = () => {
    const p = rc.drawRectangle(80, 60).sketchOnPlane().extrude(8) as any;
    return p.cut(rc.drawCircle(6).sketchOnPlane("XY", -1).extrude(10) as any);
  };
  const sharpEdge = (f: any) => f.containsPoint([0, -30, 8]);
  const perMm = (r: number) => r * r * (1 - Math.PI / 4);

  it("rounds exactly one edge when its neighbours meet it at an angle", () => {
    const removed = vol(sharp()) - vol(filletEdge(sharp(), sharpEdge, 2));
    // One 80 mm edge, (1 - pi/4)r^2 per mm. Verified against a plain box,
    // where the same formula matches to three decimal places.
    expect(removed).toBeCloseTo(perMm(2) * 80, 0);
  });

  it("chamfers exactly one edge", () => {
    const removed = vol(sharp()) - vol(chamferEdge(sharp(), sharpEdge, 1));
    // A 45-degree chamfer of setback c removes c^2/2 per mm.
    expect(removed).toBeCloseTo(((1 * 1) / 2) * 80, 0);
  });

  it("carries across edges that meet smoothly — OCCT's rule, not ours", () => {
    // On a ROUNDED outline the straight edges are tangent to the corner arcs,
    // and OCCT propagates the fillet all the way around the loop. Picking one
    // 68 mm edge removes what the whole 269.7 mm boundary would, not what that
    // edge alone would.
    //
    // This is standard CAD behaviour and not something to work around; it is
    // here so the number is on record, because the viewer has to PREVIEW it —
    // highlighting only the clicked edge would be a lie on any rounded part.
    const removed = BASE_VOLUME - vol(filletEdge(build(), frontTop, 2));
    const oneEdge = perMm(2) * 68;
    const wholeLoop = perMm(2) * (2 * (80 + 60) - 8 * 6 + 2 * Math.PI * 6);
    expect(removed).toBeGreaterThan(oneEdge * 3);
    expect(removed).toBeCloseTo(wholeLoop, -1);
  });

  it("follows the parameters when the point is recomputed from them", () => {
    // The whole reason the coordinates are written as expressions. A deeper
    // plate puts that edge somewhere else, and a point rebuilt from the new
    // values still finds it.
    const deeper = rc.drawRectangle(80, 90).sketchOnPlane().extrude(8) as any;
    const withBore = deeper.cut(rc.drawCircle(6).sketchOnPlane("XY", -1).extrude(10) as any);
    const at45 = (f: any) => f.containsPoint([0, -45, 8]);
    const removed = vol(withBore) - vol(filletEdge(withBore, at45, 2));
    expect(removed).toBeCloseTo(perMm(2) * 80, 0);
  });

  it("declines a point that lands on nothing, and explains why", () => {
    resetRuntimeWarnings();
    // The failure a frozen coordinate produces once the model has moved.
    const out = filletEdge(build(), (f: any) => f.containsPoint([0, -45, 8]), 2);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(
      /no edge contains that point.*express them with the model's parameters/,
    );
  });

  it("declines a point that lies on more than one edge", () => {
    resetRuntimeWarnings();
    // A corner: two edges meet there, and rounding both is not what one click
    // asked for.
    const out = filletEdge(build(), (f: any) => f.containsPoint([34, -30, 8]), 1);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/lies on \d+ edges/);
  });

  it("declines a negative size and treats zero as a no-op", () => {
    resetRuntimeWarnings();
    expect(vol(filletEdge(build(), frontTop, -2))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/negative radius/);
    resetRuntimeWarnings();
    expect(vol(filletEdge(build(), frontTop, 0))).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings()).toHaveLength(0);
  });

  it("declines a size OCCT cannot apply without breaking the shape", () => {
    resetRuntimeWarnings();
    const out = filletEdge(build(), frontTop, 50);
    expect(vol(out)).toBeCloseTo(BASE_VOLUME, 1);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/^filletEdge:/);
  });
});

describe("probeMaxRadius", () => {
  /**
   * The contract is not "returns a plausible number" — it is that the number
   * WORKS and that a step beyond it does not. Anything weaker would let the UI
   * clamp a drag to a value OCCT still refuses, which is the whole failure
   * this exists to prevent.
   */
  const top = (f: any) => f.inPlane("XY", 8);

  it("returns a radius that actually fillets", () => {
    const max = probeMaxRadius(build(), top, "face", 40);
    expect(max).toBeGreaterThan(0);
    // The edges must come from the SAME shape instance being filleted —
    // `inList` matches objects, not geometry.
    const s = build();
    expect(() => s.fillet(max, (e: any) => e.inList(boundaryOf(s)))).not.toThrow();
    // Sanity: the plate is 8 mm thick, so the ceiling is in that neighbourhood
    // rather than an arbitrary large number.
    expect(max).toBeLessThan(12);
    expect(max).toBeGreaterThan(3);
  });

  it("finds a ceiling that a clear step beyond genuinely fails", () => {
    const max = probeMaxRadius(build(), top, "face", 40);
    let threw = false;
    try {
      const s = build();
      s.fillet(max * 1.5, (e: any) => e.inList(boundaryOf(s)));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("tracks the material, not a constant", () => {
    // Two thicknesses of the same outline: the ceiling must move with them.
    // The minimum-edge-length heuristic this replaces returned the same
    // number for both, which is why it was not usable.
    const thin = probeMaxRadius(plateOfThickness(4), (f: any) => f.inPlane("XY", 4), "face", 40);
    const thick = probeMaxRadius(plateOfThickness(16), (f: any) => f.inPlane("XY", 16), "face", 40);
    expect(thick).toBeGreaterThan(thin * 1.5);
  });

  it("returns 0 when the selector finds nothing", () => {
    expect(probeMaxRadius(build(), (f: any) => f.inPlane("XY", 999), "face", 40)).toBe(0);
  });

  it("returns 0 for an ambiguous selector rather than probing one of them", () => {
    expect(probeMaxRadius(build(), (f: any) => f.parallelTo("XY"), "face", 40)).toBe(0);
  });

  it("never exceeds the bracket it was given", () => {
    // The caller's bracket is a promise about the search space, not a hint.
    const capped = probeMaxRadius(build(), top, "face", 1.5);
    expect(capped).toBeLessThanOrEqual(1.5);
    expect(capped).toBeGreaterThan(0);
  });

  it("refuses a nonsensical bracket", () => {
    expect(probeMaxRadius(build(), top, "face", 0)).toBe(0);
    expect(probeMaxRadius(build(), top, "face", NaN)).toBe(0);
  });

  it("probes a single edge too", () => {
    const max = probeMaxRadius(
      build(),
      (e: any) => e.containsPoint([0, -30, 8]),
      "edge",
      40,
    );
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(12);
  });
});

/** The boundary edges of the plate's top face, for verifying a probed radius. */
function boundaryOf(shape: any): any[] {
  const f = new rc.FaceFinder().inPlane("XY", 8).find(shape, { unique: true });
  return [...f.clone().outerWire().edges, ...f.innerWires().flatMap((w: any) => w.edges)];
}

/** The same plate at another thickness. */
function plateOfThickness(t: number): any {
  const p = rc.drawRoundedRectangle(80, 60, 6).sketchOnPlane().extrude(t) as any;
  return p.cut(rc.drawCircle(6).sketchOnPlane("XY", -1).extrude(t + 2) as any);
}

describe("shellFace", () => {
  /** A plain 40 x 30 x 10 block, so the cavity volume is arithmetic. */
  const block = () => rc.drawRectangle(40, 30).sketchOnPlane().extrude(10) as any;
  const blockTop = (f: any) => f.inPlane("XY", 10);

  it("hollows the solid and leaves the picked face open", () => {
    const out = shellFace(block(), blockTop, 2);
    // Walls 2mm, top open: the cavity is 36 x 26 x 8, reaching the top face.
    expect(vol(out)).toBeCloseTo(40 * 30 * 10 - 36 * 26 * 8, 3);
  });

  it("opens every face the selector matches, not just one", () => {
    // A tube — open at both ends. More than one match is legitimate here,
    // unlike the other operations in this module, because an enclosure open
    // at both ends is a real part.
    // `.either([...])` on the bare finder. Chaining it after a constraint
    // ANDs instead, which is how the first draft of this test asked for the
    // faces that are simultaneously at z=10 and z=0 and got none.
    const out = shellFace(block(), (f: any) => f.either([
      (g: any) => g.inPlane("XY", 10),
      (g: any) => g.inPlane("XY", 0),
    ]), 2);
    // Cavity now runs clean through: 36 x 26 x 10.
    expect(vol(out)).toBeCloseTo(40 * 30 * 10 - 36 * 26 * 10, 3);
  });

  it("warns and changes nothing when the selector matches no face", () => {
    resetRuntimeWarnings();
    const s = block();
    const out = shellFace(s, (f: any) => f.inPlane("XY", 999), 2);
    expect(vol(out)).toBeCloseTo(40 * 30 * 10, 3);
    const w = drainRuntimeWarnings();
    expect(w.join(" ")).toMatch(/no face matched/);
  });

  it("warns and changes nothing when OCCT refuses the thickness", () => {
    resetRuntimeWarnings();
    const out = shellFace(block(), blockTop, 40);
    expect(vol(out)).toBeCloseTo(40 * 30 * 10, 3);
    expect(drainRuntimeWarnings().join(" ")).toMatch(/refused a 40mm wall/);
  });

  it("treats a zero or negative wall as a no-op rather than an error", () => {
    expect(vol(shellFace(block(), blockTop, 0))).toBeCloseTo(40 * 30 * 10, 3);
    expect(vol(shellFace(block(), blockTop, -3))).toBeCloseTo(40 * 30 * 10, 3);
  });
});

describe("probeMaxShell", () => {
  const block = () => rc.drawRectangle(40, 30).sketchOnPlane().extrude(10) as any;
  const blockTop = (f: any) => f.inPlane("XY", 10);

  it("returns a thickness that actually shells", () => {
    const max = probeMaxShell(block(), blockTop, 10);
    expect(max).toBeGreaterThan(0);
    const out = shellFace(block(), blockTop, max);
    expect(vol(out)).toBeLessThan(40 * 30 * 10);
  });

  it("finds the limit the bounding-box rule got wrong", () => {
    // The rule this replaced refused anything over 50% of the smallest
    // dimension — 5.0 on this block. OCCT succeeds to just under 10, because
    // the top face is removed and Z is therefore offset from one side only.
    // Half the usable range used to be unreachable.
    const max = probeMaxShell(block(), blockTop, 10);
    expect(max).toBeGreaterThan(9);
    // And 6 — squarely inside the old refusal — must genuinely work.
    expect(vol(shellFace(block(), blockTop, 6))).toBeLessThan(40 * 30 * 10);
  });

  it("reports a clear step past the limit as unusable", () => {
    const max = probeMaxShell(block(), blockTop, 10);
    resetRuntimeWarnings();
    const out = shellFace(block(), blockTop, max + 0.5);
    expect(vol(out)).toBeCloseTo(40 * 30 * 10, 3);
    drainRuntimeWarnings();
  });

  it("refuses a selector that opens nothing, rather than measuring a closed shell", () => {
    // A finder matching no face does not fail — replicad builds a CLOSED
    // shell, a different operation with a much lower limit (measured: exactly
    // 5.0 on this block, against 9.9 with the top open). Returning that would
    // be a correct number for an operation the user did not ask for.
    expect(probeMaxShell(block(), (f: any) => f.inPlane("XY", 999), 10)).toBe(0);
  });

  it("and the closed-shell limit really is the 50% figure — on a CLOSED shell", () => {
    // The evidence that the old rule was not wrong so much as over-applied:
    // half the smallest dimension is exactly right when no face is removed,
    // and half the truth when one is.
    const s = block();
    expect(() => s.shell(5.0, (f: any) => f.inPlane("XY", 999))).not.toThrow();
    expect(() => block().shell(5.1, (f: any) => f.inPlane("XY", 999))).toThrow();
  });
});

describe("why the shell limit has to be measured", () => {
  // One box, one removed face, two corner treatments. The bounding box is
  // identical in both cases — 60 x 45 x 24 — so any rule derived from it must
  // give the same answer for both. The truth differs by more than 4x.
  const rounded = () => rc.drawRoundedRectangle(60, 45, 5).sketchOnPlane("XY").extrude(24) as any;
  const sharp = () => rc.drawRectangle(60, 45).sketchOnPlane("XY").extrude(24) as any;
  const openTop = (f: any) => f.inPlane("XY", 24);

  it("rounded corners cap it far below half the smallest dimension", () => {
    // The inward offset eats the r5 corner before it touches any wall, so the
    // limit is the CORNER RADIUS. The rule this replaced allowed 12mm here.
    const max = probeMaxShell(rounded(), openTop, 24);
    expect(max).toBeGreaterThan(4.5);
    expect(max).toBeLessThan(5.1);
    expect(() => rounded().shell(12, openTop)).toThrow();
  });

  it("sharp corners allow far more than it", () => {
    // Same bounding box, no corner to eat: the limit is now most of the
    // height. The old rule refused everything from 12 up, all of which works.
    const max = probeMaxShell(sharp(), openTop, 24);
    expect(max).toBeGreaterThan(20);
    expect(() => sharp().shell(20, openTop)).not.toThrow();
  });
});
