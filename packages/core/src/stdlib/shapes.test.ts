import { describe, it, expect, vi } from "vitest";

// Mock `replicad` so `box()` can be exercised without OCCT/WASM. We only
// care that the right corners are forwarded to `makeBox`; the return value
// is just a sentinel so the test can distinguish it. `prism()` doesn't go
// through replicad — it calls methods on the `profile` object the caller
// supplies, which these tests stub directly.
//
// For the `rounded` path we also need `drawRoundedRectangle(w, h, r)` to
// return a chainable stub that supports `.sketchOnPlane(plane).extrude(d)`
// followed by a `.translate(x, y, z)` on the resulting Shape3D — matching
// the real Replicad API surface `box()` touches.
vi.mock("replicad", () => ({
  makeBox: (from: [number, number, number], to: [number, number, number]) => ({
    __mockBox: true,
    from,
    to,
  }),
  drawRoundedRectangle: (w: number, h: number, r: number) => ({
    __rounded: true,
    w,
    h,
    r,
    sketchOnPlane(plane: string) {
      return {
        __sketch: true,
        plane,
        extrude(d: number) {
          return {
            __extruded: true,
            plane,
            distance: d,
            shape: { w, h, r },
            translate(tx: number, ty: number, tz: number) {
              return {
                __translated: true,
                plane,
                distance: d,
                shape: { w, h, r },
                translate: [tx, ty, tz],
              };
            },
          };
        },
      };
    },
  }),
}));

import { box, prism } from "./shapes";

// ---------------------------------------------------------------------------
// `box` — corner-to-corner validation + makeBox pass-through.
// ---------------------------------------------------------------------------

describe("shapes.box", () => {
  it("forwards both corners to makeBox when `to > from` on every axis", () => {
    const b = box({ from: [0, 0, 0], to: [40, 20, 10] }) as any;
    expect(b.__mockBox).toBe(true);
    expect(b.from).toEqual([0, 0, 0]);
    expect(b.to).toEqual([40, 20, 10]);
  });

  it("throws naming the offending axis when `to <= from`", () => {
    // Y is inverted — message must call out Y specifically.
    expect(() => box({ from: [0, 10, 0], to: [5, 10, 5] })).toThrow(/axis|zero-thickness/);
    expect(() => box({ from: [0, 10, 0], to: [5, 10, 5] })).toThrow(/\.Y/);
    // Swapped X corner — message must call out X.
    expect(() => box({ from: [5, 0, 0], to: [1, 10, 10] })).toThrow(/\.X/);
  });

  it("rejects malformed corners", () => {
    expect(() => box({ from: [0, 0] as any, to: [1, 1, 1] })).toThrow(/from/);
    expect(() => box({ from: [0, 0, Number.NaN], to: [1, 1, 1] })).toThrow(/from/);
  });

  it("omitted / zero `rounded` takes the fast makeBox path with hard corners", () => {
    const hard = box({ from: [0, 0, 0], to: [40, 20, 10] }) as any;
    expect(hard.__mockBox).toBe(true);
    const zero = box({ from: [0, 0, 0], to: [40, 20, 10], rounded: 0 }) as any;
    expect(zero.__mockBox).toBe(true);
  });

  it("`rounded > 0` builds a drawRoundedRectangle(dx, dy, r) extrusion translated to the from/to box", () => {
    // 40×20×10 block with a 3 mm fillet on the four vertical edges. The
    // bounding box should remain [0,0,0]→[40,20,10] (rounding only removes
    // corner material — it never shrinks the overall extent), which means
    // the extruded rounded profile must be translated to the box centre on
    // X/Y and to from.Z on the Z axis.
    const b = box({ from: [0, 0, 0], to: [40, 20, 10], rounded: 3 }) as any;
    expect(b.__translated).toBe(true);
    expect(b.plane).toBe("XY");
    expect(b.distance).toBe(10);
    expect(b.shape).toEqual({ w: 40, h: 20, r: 3 });
    // Centre of [0..40] × [0..20] is (20, 10); near face sits at z = from.Z = 0.
    expect(b.translate).toEqual([20, 10, 0]);
  });

  it("`rounded` respects non-origin from (centre + z-offset follow)", () => {
    const b = box({ from: [-10, -10, 5], to: [10, 10, 12], rounded: 2 }) as any;
    expect(b.__translated).toBe(true);
    expect(b.shape).toEqual({ w: 20, h: 20, r: 2 });
    expect(b.distance).toBe(7);
    // Centre of X: (-10+10)/2 = 0; Y: same; Z lands at from.Z = 5.
    expect(b.translate).toEqual([0, 0, 5]);
  });

  it("rejects a negative or non-finite `rounded`", () => {
    expect(() => box({ from: [0, 0, 0], to: [10, 10, 5], rounded: -1 })).toThrow(/rounded/);
    expect(() =>
      box({ from: [0, 0, 0], to: [10, 10, 5], rounded: Number.NaN }),
    ).toThrow(/rounded/);
  });

  it("rejects `rounded >= min(dx, dy) / 2` — a fillet that large degenerates the profile", () => {
    // dx = 20, dy = 6 → max allowed radius is 3 (exclusive). r=3 must throw
    // (strict <), and r=5 must clearly throw.
    expect(() => box({ from: [0, 0, 0], to: [20, 6, 10], rounded: 3 })).toThrow(RangeError);
    expect(() => box({ from: [0, 0, 0], to: [20, 6, 10], rounded: 5 })).toThrow(/rounded/);
  });
});

// ---------------------------------------------------------------------------
// `prism` — plane-selection + signed-extrude + post-translate math.
//
// Stub a Drawing whose `sketchOnPlane(plane)` records the plane and returns
// a sketch stub that records its `extrude(d)` distance and the post-extrude
// translate call (if any). Matches placement.test.ts's stubbing style.
// ---------------------------------------------------------------------------

function makeProfileStub() {
  const calls = {
    plane: undefined as string | undefined,
    distance: undefined as number | undefined,
    translate: undefined as [number, number, number] | undefined,
  };
  const extruded: any = {
    translate(x: number, y: number, z: number) {
      calls.translate = [x, y, z];
      return { __translated: true };
    },
  };
  const sketch = {
    extrude(d: number) {
      calls.distance = d;
      return extruded;
    },
  };
  const profile = {
    sketchOnPlane(plane: string) {
      calls.plane = plane;
      return sketch;
    },
  };
  return { profile, calls };
}

describe("shapes.prism — plane + sign mapping", () => {
  it("default +Z: sketchOnPlane('XY').extrude(+L), no translate", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, length: 10 });
    expect(calls.plane).toBe("XY");
    expect(calls.distance).toBe(10);
    expect(calls.translate).toBeUndefined();
  });

  it("-Z: sketchOnPlane('XY').extrude(-L) so the prism lands in Z∈[-L,0]", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, along: "-Z", length: 10 });
    expect(calls.plane).toBe("XY");
    expect(calls.distance).toBe(-10);
  });

  it("+Y: sketchOnPlane('XZ').extrude(-L) (XZ grows -Y natively, flip to land in +Y)", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, along: "+Y", length: 20 });
    expect(calls.plane).toBe("XZ");
    expect(calls.distance).toBe(-20);
  });

  it("-Y: sketchOnPlane('XZ').extrude(+L) (native -Y growth lands in Y∈[-L,0])", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, along: "-Y", length: 7 });
    expect(calls.plane).toBe("XZ");
    expect(calls.distance).toBe(7);
  });

  it("+X: sketchOnPlane('YZ').extrude(+L) native +X growth", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, along: "+X", length: 15 });
    expect(calls.plane).toBe("YZ");
    expect(calls.distance).toBe(15);
  });

  it("`from` translates along the named world axis only", () => {
    const { profile, calls } = makeProfileStub();
    prism({ profile: profile as any, along: "+X", length: 10, from: 5 });
    expect(calls.translate).toEqual([5, 0, 0]);

    const b = makeProfileStub();
    prism({ profile: b.profile as any, along: "-Y", length: 10, from: -3 });
    expect(b.calls.translate).toEqual([0, -3, 0]);
  });

  it("rejects bad inputs with readable errors", () => {
    const { profile } = makeProfileStub();
    expect(() =>
      prism({ profile: profile as any, along: "+XX" as any, length: 10 }),
    ).toThrow(/along/);
    expect(() =>
      prism({ profile: profile as any, length: 0 }),
    ).toThrow(/length/);
    expect(() =>
      prism({ profile: null as any, length: 10 }),
    ).toThrow(/profile/);
  });
});
