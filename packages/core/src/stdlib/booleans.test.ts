/**
 * joinBodies / cutBodies / intersectBodies against real OCCT.
 *
 * Volumes are checked against hand-computed expectations, not snapshots: the
 * failures worth catching here are geometric — a union that merged nothing, a
 * cut that removed nothing, an intersect that returned an empty solid — and
 * every one of those produces a perfectly stable snapshot.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadOCCTForTest } from "../testing/occt.js";
import { resetRuntimeWarnings, drainRuntimeWarnings } from "./warnings.js";

let rc: typeof import("replicad");
let joinBodies: typeof import("./booleans.js").joinBodies;
let cutBodies: typeof import("./booleans.js").cutBodies;
let intersectBodies: typeof import("./booleans.js").intersectBodies;

beforeAll(async () => {
  const oc = await loadOCCTForTest();
  rc = await import("replicad");
  rc.setOC(oc);
  ({ joinBodies, cutBodies, intersectBodies } = await import("./booleans.js"));
}, 120_000);

beforeAll(() => resetRuntimeWarnings());

const vol = (s: any) => rc.measureVolume(s);

/** A 20 mm cube with its low corner at the origin. */
const cube = (x = 0, y = 0, z = 0, size = 20) =>
  rc.drawRectangle(size, size)
    .sketchOnPlane("XY", z)
    .extrude(size)
    .translate(x + size / 2, y + size / 2, 0) as any;

// Two cubes sharing a 20x20x10 slab: the second starts half a cube up.
const OVERLAP = 20 * 20 * 10;
const CUBE = 20 * 20 * 20;

describe("joinBodies", () => {
  it("unions overlapping bodies and reports the shared volume once", () => {
    const out = joinBodies(cube(), cube(0, 0, 10));
    expect(vol(out)).toBeCloseTo(2 * CUBE - OVERLAP, 1);
  });

  it("takes a list of tools", () => {
    const out = joinBodies(cube(), [cube(0, 0, 10), cube(0, 0, -10)]);
    expect(vol(out)).toBeCloseTo(3 * CUBE - 2 * OVERLAP, 1);
  });

  it("warns when the bodies never touch, which the core's fuse guard cannot see", () => {
    resetRuntimeWarnings();
    const out = joinBodies(cube(), cube(100, 0, 0));
    // The union still happens — OCCT returns a compound of two lumps, and the
    // volumes add exactly, which is precisely the signature being detected.
    expect(vol(out)).toBeCloseTo(2 * CUBE, 1);
    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => w.includes("do not touch"))).toBe(true);
  });

  it("names the one tool that missed, in a list where the others landed", () => {
    // The failure the aggregate check could not see: two tools overlap and
    // one does not, so the total volume is NOT the sum of the inputs, and a
    // whole-operation equality test passes while a body sits unmerged.
    resetRuntimeWarnings();
    let stats: any;
    joinBodies(cube(), [cube(0, 0, 10), cube(0, 0, -10), cube(100, 0, 0)], {
      onStats: (s) => (stats = s),
    });
    expect(stats.disjointTools).toEqual([2]);
    const warnings = drainRuntimeWarnings().filter((w) => w.startsWith("joinBodies"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("tool 3 does not touch");
  });

  it("stays quiet when the bodies genuinely merge", () => {
    resetRuntimeWarnings();
    joinBodies(cube(), cube(0, 0, 10));
    expect(drainRuntimeWarnings().filter((w) => w.startsWith("joinBodies"))).toEqual([]);
  });
});

describe("cutBodies", () => {
  it("subtracts the shared volume", () => {
    const out = cutBodies(cube(), cube(0, 0, 10));
    expect(vol(out)).toBeCloseTo(CUBE - OVERLAP, 1);
  });

  it("subtracts every tool in a list", () => {
    const out = cutBodies(cube(), [cube(0, 0, 10), cube(0, 0, -12)]);
    expect(vol(out)).toBeCloseTo(CUBE - OVERLAP - 20 * 20 * 8, 1);
  });

  it("warns when the tool consumes the whole target", () => {
    resetRuntimeWarnings();
    // A 40 mm cube centred on the 20 mm one swallows it entirely.
    const out = cutBodies(cube(), cube(-10, -10, -10, 40));
    expect(vol(out)).toBeLessThan(1e-6);
    expect(drainRuntimeWarnings().some((w) => w.includes("entire target"))).toBe(true);
  });
});

describe("intersectBodies", () => {
  it("keeps only the shared volume", () => {
    const out = intersectBodies(cube(), cube(0, 0, 10));
    expect(vol(out)).toBeCloseTo(OVERLAP, 1);
  });

  it("intersects successively across a list", () => {
    const out = intersectBodies(cube(), [cube(0, 0, 10), cube(0, 0, 15)]);
    expect(vol(out)).toBeCloseTo(20 * 20 * 5, 1);
  });

  it("returns the target unchanged, and says so, when there is no overlap", () => {
    resetRuntimeWarnings();
    const target = cube();
    const out = intersectBodies(target, cube(100, 0, 0));
    // An empty solid renders as nothing at all, which reads as a crash rather
    // than as a result — so the target comes back and the warning explains.
    expect(vol(out)).toBeCloseTo(CUBE, 1);
    expect(drainRuntimeWarnings().some((w) => w.includes("do not overlap"))).toBe(true);
  });
});

describe("the delta handed to the viewer", () => {
  it("is the material a join ADDS, not the whole tool", () => {
    let mode: string | undefined;
    let delta: any;
    joinBodies(cube(), cube(0, 0, 10), {
      onDelta: (d, m) => {
        delta = d;
        mode = m;
      },
    });
    expect(mode).toBe("added");
    // The tool is a full cube, but only the half that was not already inside
    // the target is new material.
    expect(vol(delta)).toBeCloseTo(CUBE - OVERLAP, 1);
  });

  it("is the material a cut REMOVES", () => {
    let mode: string | undefined;
    let delta: any;
    cutBodies(cube(), cube(0, 0, 10), {
      onDelta: (d, m) => {
        delta = d;
        mode = m;
      },
    });
    expect(mode).toBe("removed");
    expect(vol(delta)).toBeCloseTo(OVERLAP, 1);
  });

  it("is the material an intersect DISCARDS", () => {
    let mode: string | undefined;
    let delta: any;
    intersectBodies(cube(), cube(0, 0, 10), {
      onDelta: (d, m) => {
        delta = d;
        mode = m;
      },
    });
    expect(mode).toBe("removed");
    expect(vol(delta)).toBeCloseTo(CUBE - OVERLAP, 1);
  });
});

describe("measurements", () => {
  it("reports what the operation moved, so the UI need not measure again", () => {
    let stats: any;
    cutBodies(cube(), cube(0, 0, 10), { onStats: (s) => (stats = s) });
    expect(stats.op).toBe("cut");
    expect(stats.targetVolume).toBeCloseTo(CUBE, 1);
    expect(stats.resultVolume).toBeCloseTo(CUBE - OVERLAP, 1);
    expect(stats.deltaVolume).toBeCloseTo(OVERLAP, 1);
  });

  it("flags a disjoint join and an empty intersect in the stats, not only the text", () => {
    let joined: any;
    joinBodies(cube(), cube(100, 0, 0), { onStats: (s) => (joined = s), silent: true });
    expect(joined.disjoint).toBe(true);

    let crossed: any;
    intersectBodies(cube(), cube(100, 0, 0), { onStats: (s) => (crossed = s), silent: true });
    expect(crossed.empty).toBe(true);
  });
});

describe("degenerate input", () => {
  it("returns the target untouched when there are no tools", () => {
    const target = cube();
    expect(intersectBodies(target, [])).toBe(target);
    expect(joinBodies(target, [])).toBe(target);
    expect(cutBodies(target, [])).toBe(target);
  });

  it("honours silent", () => {
    resetRuntimeWarnings();
    joinBodies(cube(), cube(100, 0, 0), { silent: true });
    expect(drainRuntimeWarnings().filter((w) => w.startsWith("joinBodies"))).toEqual([]);
  });
});
