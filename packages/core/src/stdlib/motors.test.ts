import { describe, it, expect, vi } from "vitest";

// The `_mountPlate` helpers internally call `cylinder(...)` (which calls
// replicad's `makeCylinder`) and fuse the results. Stub those in replicad so
// the test exercises the builder's decisions — validation, bolt-pattern
// coordinates, fuse sequencing — without needing OCCT/WASM.
//
// The stub returns a "mock shape" that records every .fuse, .translate, and
// .rotate call. `makeCylinder` captures (radius, height, base, direction) so
// we can assert the bolt-pattern geometry is correct.
type CylCall = {
  radius: number;
  height: number;
  base: [number, number, number];
  direction: [number, number, number];
};

const cylCalls: CylCall[] = [];
const fuseCalls: any[] = [];

function mockShape(): any {
  const self: any = {
    __mock: true,
    fuse(other: any) {
      fuseCalls.push(other);
      return self;
    },
    translate(_x: number, _y: number, _z: number) {
      return self;
    },
    rotate(_angle: number, _origin: any, _direction: any) {
      return self;
    },
  };
  return self;
}

vi.mock("replicad", () => ({
  makeCylinder: (
    radius: number,
    height: number,
    base: [number, number, number],
    direction: [number, number, number],
  ) => {
    cylCalls.push({ radius, height, base, direction });
    return mockShape();
  },
  drawRectangle: () => ({
    sketchOnPlane: () => ({
      extrude: () => mockShape(),
    }),
  }),
}));

import {
  nema17_mountPlate,
  nema23_mountPlate,
  nema14_mountPlate,
  nema17,
  nema23,
  nema14,
} from "./motors";

describe("motors._mountPlate — bolt-pattern geometry", () => {
  it("nema17_mountPlate emits 4 M3-clearance bolt holes on a 31 mm square pattern", () => {
    cylCalls.length = 0;
    fuseCalls.length = 0;
    nema17_mountPlate({ thickness: 5 });

    // Expect 5 cylinders: 1 central shaft bore + 4 bolt holes. No boss
    // recess when `boss` is omitted.
    expect(cylCalls).toHaveLength(5);

    // Central shaft: diameter = NEMA17.pilotDia (22 mm) → radius 11.
    const shaft = cylCalls[0];
    expect(shaft.radius).toBe(11);

    // Bolt holes: radius = M3 shaft (3 mm) + clearance allowance (0.2 mm) → 3.4 / 2 = 1.7.
    const boltRadii = cylCalls.slice(1).map((c) => c.radius);
    expect(new Set(boltRadii)).toEqual(new Set([1.7]));

    // Bolt X/Y positions sit on the ±15.5 mm square (half of 31).
    const boltXY = cylCalls.slice(1).map((c) => [c.base[0], c.base[1]] as const);
    expect(new Set(boltXY.map((p) => `${p[0]},${p[1]}`))).toEqual(
      new Set(["15.5,15.5", "15.5,-15.5", "-15.5,15.5", "-15.5,-15.5"]),
    );
  });

  it("adds a 6th cylinder for the boss recess when `boss: true`", () => {
    cylCalls.length = 0;
    nema17_mountPlate({ thickness: 5, boss: true });
    expect(cylCalls).toHaveLength(6);
    // Boss sits at pilotDia/2 = 11 like the shaft, but its height equals
    // bossDepth + overcut (default 2 + 0.2 = 2.2 mm) — much shorter than the
    // 5 + 0.4 = 5.4 mm shaft bore.
    const boss = cylCalls[cylCalls.length - 1];
    expect(boss.radius).toBe(11);
    expect(boss.height).toBeCloseTo(2.2, 5);
  });

  it("NEMA 23 uses 47.14 mm pitch and M4 clearance; NEMA 14 uses 26 mm pitch", () => {
    cylCalls.length = 0;
    nema23_mountPlate({ thickness: 6 });
    const n23BoltXY = cylCalls
      .slice(1)
      .map((c) => [c.base[0], c.base[1]] as const);
    // half of 47.14 = 23.57
    expect(n23BoltXY.some((p) => Math.abs(p[0] - 23.57) < 1e-9 && Math.abs(p[1] - 23.57) < 1e-9)).toBe(true);

    cylCalls.length = 0;
    nema14_mountPlate({ thickness: 4 });
    const n14BoltXY = cylCalls.slice(1).map((c) => [c.base[0], c.base[1]] as const);
    // half of 26 = 13
    expect(n14BoltXY.some((p) => p[0] === 13 && p[1] === 13)).toBe(true);
  });

  it("rejects bad inputs with readable errors", () => {
    expect(() => nema17_mountPlate({ thickness: 0 })).toThrow(/thickness/);
    expect(() =>
      nema17_mountPlate({ thickness: 5, boss: true, bossDepth: 10 }),
    ).toThrow(/bossDepth/);
  });
});

// ---------------------------------------------------------------------------
// motors.nema{17,23,14}.boltPattern — four bolt-circle centres as Placements
// ---------------------------------------------------------------------------

describe("motors.<nema>.boltPattern", () => {
  it("exposes boltPattern on each NEMA handle", () => {
    expect(typeof nema17.boltPattern).toBe("function");
    expect(typeof nema23.boltPattern).toBe("function");
    expect(typeof nema14.boltPattern).toBe("function");
  });

  it("emits 4 points at ±boltPitch/2 on each axis for NEMA 17 (default XY plane)", () => {
    const pts = nema17.boltPattern();
    expect(pts).toHaveLength(4);
    // NEMA 17 bolt pitch = 31 → half = 15.5. All four corners of the square.
    const xyPairs = new Set(pts.map((p) => `${p.translate[0]},${p.translate[1]}`));
    expect(xyPairs).toEqual(
      new Set(["15.5,15.5", "15.5,-15.5", "-15.5,15.5", "-15.5,-15.5"]),
    );
    // All points live on the XY plane (Z = 0).
    for (const p of pts) expect(p.translate[2]).toBe(0);
  });

  it("scales with the spec (NEMA 23 → 47.14 / 2 = 23.57)", () => {
    const pts = nema23.boltPattern();
    // Any corner should have |x| == 23.57 and |y| == 23.57.
    for (const p of pts) {
      expect(Math.abs(p.translate[0])).toBeCloseTo(23.57, 9);
      expect(Math.abs(p.translate[1])).toBeCloseTo(23.57, 9);
    }
  });

  it("remaps onto the YZ plane with x=0 and the pattern in Y/Z", () => {
    const pts = nema14.boltPattern("YZ");
    expect(pts).toHaveLength(4);
    // NEMA 14 bolt pitch = 26 → half = 13. On YZ plane every placement has
    // x == 0 and |y| == |z| == 13.
    for (const p of pts) {
      expect(p.translate[0]).toBe(0);
      expect(Math.abs(p.translate[1])).toBe(13);
      expect(Math.abs(p.translate[2])).toBe(13);
    }
  });

  it("remaps onto the XZ plane with y=0 and the pattern in X/Z", () => {
    const pts = nema17.boltPattern("XZ");
    expect(pts).toHaveLength(4);
    for (const p of pts) {
      expect(p.translate[1]).toBe(0);
      expect(Math.abs(p.translate[0])).toBe(15.5);
      expect(Math.abs(p.translate[2])).toBe(15.5);
    }
  });
});

// ---------------------------------------------------------------------------
// motors.nemaXX({ direction }) — shaft direction override.
//
// `direction` rotates the whole motor (body + shaft + joints) via Part.rotate.
// We can't assert on the shape (mock swallows rotate), but `Part.rotate` is a
// pure transform composition in parts.ts and `part.joints.*` returns
// world-space positions/axes — so the joint-getter math is testable against
// the real stdlib, no OCCT needed.
// ---------------------------------------------------------------------------

describe("motors.nema17 — direction override", () => {
  // NEMA 17: body height 40, default shaft length 24 → shaftTip local = [0, 0, 64].
  // mountFace local = [0, 0, 0] with axis "-Z".
  const tipLocalZ = 40 + 24;

  it("default direction is +Z (identity — joints unchanged)", () => {
    const m = nema17();
    expect(m.joints.shaftTip.position[0]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.position[1]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.position[2]).toBeCloseTo(tipLocalZ, 9);
    expect(m.joints.shaftTip.axis[0]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.axis[1]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.axis[2]).toBeCloseTo(1, 9);
  });

  it('direction: "+X" rotates shaft to point +X — tip at [+tipZ, 0, 0], mountFace at origin', () => {
    const m = nema17({ direction: "+X" });
    expect(m.joints.shaftTip.position[0]).toBeCloseTo(tipLocalZ, 9);
    expect(m.joints.shaftTip.position[1]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.position[2]).toBeCloseTo(0, 9);
    // Shaft tip axis should now be +X.
    expect(m.joints.shaftTip.axis[0]).toBeCloseTo(1, 9);
    expect(m.joints.shaftTip.axis[1]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.axis[2]).toBeCloseTo(0, 9);
    // Mount face stays at the origin (local [0, 0, 0]) and its outward axis
    // was "-Z" → after +90° about +Y it points -X.
    expect(m.joints.mountFace.position[0]).toBeCloseTo(0, 9);
    expect(m.joints.mountFace.position[1]).toBeCloseTo(0, 9);
    expect(m.joints.mountFace.position[2]).toBeCloseTo(0, 9);
    expect(m.joints.mountFace.axis[0]).toBeCloseTo(-1, 9);
    expect(m.joints.mountFace.axis[1]).toBeCloseTo(0, 9);
    expect(m.joints.mountFace.axis[2]).toBeCloseTo(0, 9);
  });

  it('direction: "-Y" rotates shaft to point -Y — tip at [0, -tipZ, 0] with axis -Y', () => {
    const m = nema17({ direction: "-Y" });
    expect(m.joints.shaftTip.position[0]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.position[1]).toBeCloseTo(-tipLocalZ, 9);
    expect(m.joints.shaftTip.position[2]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.axis[0]).toBeCloseTo(0, 9);
    expect(m.joints.shaftTip.axis[1]).toBeCloseTo(-1, 9);
    expect(m.joints.shaftTip.axis[2]).toBeCloseTo(0, 9);
    // mountFace "-Z" axis rotates to +Y under a +90° about +X rotation.
    expect(m.joints.mountFace.axis[0]).toBeCloseTo(0, 9);
    expect(m.joints.mountFace.axis[1]).toBeCloseTo(1, 9);
    expect(m.joints.mountFace.axis[2]).toBeCloseTo(0, 9);
  });
});
