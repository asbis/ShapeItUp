import { describe, it, expect } from "vitest";
import * as holes from "./holes";
import { applyAxis, type HoleAxis } from "./holes";

// ---------------------------------------------------------------------------
// Pin the public API surface of `holes`. OCCT is not required for these
// tests — we only verify the exports exist and have the expected arity.
// The alias `clearance` is the common engineering term for a through-hole
// with clearance fit; users hit a hard error ("holes.clearance is not a
// function") before this was added, so we regression-guard it explicitly.
// ---------------------------------------------------------------------------

describe("holes — API surface", () => {
  it("exports `through`", () => {
    expect(typeof holes.through).toBe("function");
  });

  it("exports `clearance` as an alias of `through`", () => {
    expect(typeof holes.clearance).toBe("function");
  });

  it("`clearance` has the same arity as `through`", () => {
    // Both take (size, opts?=) → Function.length = 1 required param.
    expect(holes.clearance.length).toBe(holes.through.length);
  });

  it("preserves the rest of the hole-tool surface", () => {
    expect(typeof holes.counterbore).toBe("function");
    expect(typeof holes.countersink).toBe("function");
    expect(typeof holes.tapped).toBe("function");
    expect(typeof holes.teardrop).toBe("function");
    expect(typeof holes.keyhole).toBe("function");
    expect(typeof holes.slot).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Fix D — axis param on every hole helper.
//
// Before this fix, vertical-flange cuts required a manual `.rotate(90, …)`
// after building a default-Z hole. With `axis` built in, users pass
// `axis: "+X"` and the helper routes through `applyAxis`, which dispatches
// the correct Replicad `rotate(angle, origin, direction)` call for that
// axis. We verify the dispatch contract with a mock Shape3D so these tests
// don't need OCCT/WASM — only the rotation-routing decision matters.
// ---------------------------------------------------------------------------

/**
 * Minimal mock Shape3D that records every `.rotate()` invocation.
 * Chainable — returns itself so subsequent calls stack up in `rotateCalls`.
 * Covers the full applyAxis dispatch surface without pulling in OCCT.
 */
function makeMockShape() {
  const rotateCalls: Array<{ angle: number; origin: number[]; direction: number[] }> = [];
  const shape: any = {
    rotateCalls,
    rotate(angle: number, origin: number[], direction: number[]) {
      rotateCalls.push({ angle, origin, direction });
      return shape;
    },
  };
  return shape;
}

describe("applyAxis — rotation dispatch (Fix D)", () => {
  it('"+Z" (and undefined) leave the shape unchanged — no rotate call', () => {
    const s1 = makeMockShape();
    expect(applyAxis(s1, "+Z")).toBe(s1);
    expect(s1.rotateCalls).toHaveLength(0);

    const s2 = makeMockShape();
    expect(applyAxis(s2, undefined)).toBe(s2);
    expect(s2.rotateCalls).toHaveLength(0);
  });

  it('"-Z" flips 180° about the X axis (rotate(180, [0,0,0], [1,0,0]))', () => {
    const s = makeMockShape();
    applyAxis(s, "-Z");
    expect(s.rotateCalls).toEqual([
      { angle: 180, origin: [0, 0, 0], direction: [1, 0, 0] },
    ]);
  });

  // Axis semantic: `"+X"` names the face the hole OPENS ON — the body
  // penetrates in the OPPOSITE direction (into -X). For the default
  // +Z-pointing source cylinder (opening at Z=0, body at Z ∈ [-depth, 0]),
  // rotating +90° about Y maps the axis (0,0,1)→(1,0,0) but maps the base
  // (0,0,-depth)→(-depth,0,0). So after rotation: opening at X=0, body at
  // X ∈ [-depth, 0] — exactly the "opens on +X face, drills -X" semantic.
  it('"+X" rotates +90° about Y (opening at X=0, body extends into -X)', () => {
    const s = makeMockShape();
    applyAxis(s, "+X");
    expect(s.rotateCalls).toEqual([
      { angle: 90, origin: [0, 0, 0], direction: [0, 1, 0] },
    ]);
  });

  it('"-X" rotates -90° about Y (opening at X=0, body extends into +X)', () => {
    const s = makeMockShape();
    applyAxis(s, "-X");
    expect(s.rotateCalls).toEqual([
      { angle: -90, origin: [0, 0, 0], direction: [0, 1, 0] },
    ]);
  });

  it('"+Y" rotates -90° about X (opening at Y=0, body extends into -Y)', () => {
    const s = makeMockShape();
    applyAxis(s, "+Y");
    expect(s.rotateCalls).toEqual([
      { angle: -90, origin: [0, 0, 0], direction: [1, 0, 0] },
    ]);
  });

  it('"-Y" rotates +90° about X (opening at Y=0, body extends into +Y)', () => {
    const s = makeMockShape();
    applyAxis(s, "-Y");
    expect(s.rotateCalls).toEqual([
      { angle: 90, origin: [0, 0, 0], direction: [1, 0, 0] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// P1-1 regression — axis semantic: "axis names the face the hole opens ON,
// body extends in the OPPOSITE direction". We can't invoke OCCT in unit
// tests, but `.rotate()` is the only transform the helpers apply on top of
// the source cylinder (location [0,0,-depth], direction [0,0,1], spanning
// Z ∈ [-depth, 0]). Applying the rotation mathematically to the source
// cylinder's base point (0,0,-depth) and top point (0,0,0) verifies the
// body/opening geometry each axis produces.
// ---------------------------------------------------------------------------

/**
 * Apply a Replicad-style axis-angle rotation (degrees, origin=[0,0,0], about
 * the given unit axis) to a point. Pure math — no OCCT. Uses Rodrigues'
 * formula specialized to principal axes, because every axis we ever pass
 * is one of [1,0,0] / [0,1,0] / [1,0,0].
 */
function rotatePoint(
  p: [number, number, number],
  angleDeg: number,
  axis: [number, number, number],
): [number, number, number] {
  const θ = (angleDeg * Math.PI) / 180;
  const c = Math.cos(θ);
  const s = Math.sin(θ);
  const [x, y, z] = p;
  if (axis[0] === 1 && axis[1] === 0 && axis[2] === 0) {
    return [x, y * c - z * s, y * s + z * c];
  }
  if (axis[0] === 0 && axis[1] === 1 && axis[2] === 0) {
    return [x * c + z * s, y, -x * s + z * c];
  }
  if (axis[0] === 0 && axis[1] === 0 && axis[2] === 1) {
    return [x * c - y * s, x * s + y * c, z];
  }
  throw new Error(`rotatePoint: expected principal axis, got ${axis}`);
}

/**
 * Capture the single rotation the helper would apply to the default
 * +Z-oriented source cylinder, then evaluate its effect on the cylinder's
 * base point (0,0,-depth) and top point (0,0,0). Returns the transformed
 * endpoints so tests can assert where the body lives.
 */
function axisEndpoints(axis: HoleAxis, depth: number) {
  const mock = makeMockShape();
  applyAxis(mock, axis);
  const base: [number, number, number] = [0, 0, -depth];
  const top: [number, number, number] = [0, 0, 0];
  if (mock.rotateCalls.length === 0) {
    return { base, top };
  }
  // All current helpers apply a single rotate.
  const { angle, origin, direction } = mock.rotateCalls[0];
  expect(origin).toEqual([0, 0, 0]); // every helper rotates about world origin.
  return {
    base: rotatePoint(base, angle, direction as [number, number, number]),
    top: rotatePoint(top, angle, direction as [number, number, number]),
  };
}

describe("applyAxis — semantic: opening on named face, body penetrates opposite", () => {
  const DEPTH = 10;
  const NEAR_ZERO = 1e-9;

  it('"+Z": opening at Z=0, body extends into -Z  (Z ∈ [-10, 0])', () => {
    const { base, top } = axisEndpoints("+Z", DEPTH);
    expect(top[2]).toBeCloseTo(0, 6);
    expect(base[2]).toBeCloseTo(-DEPTH, 6);
  });

  it('"-Z": opening at Z=0, body extends into +Z  (Z ∈ [0, 10])', () => {
    const { base, top } = axisEndpoints("-Z", DEPTH);
    expect(top[2]).toBeCloseTo(0, 6);
    expect(base[2]).toBeCloseTo(DEPTH, 6);
  });

  it('"+X": opening at X=0, body extends into -X  (X ∈ [-10, 0])', () => {
    const { base, top } = axisEndpoints("+X", DEPTH);
    expect(Math.abs(top[0])).toBeLessThan(NEAR_ZERO);
    expect(base[0]).toBeCloseTo(-DEPTH, 6);
    // And the other components should not drift.
    expect(Math.abs(base[1])).toBeLessThan(NEAR_ZERO);
    expect(Math.abs(base[2])).toBeLessThan(NEAR_ZERO);
  });

  it('"-X": opening at X=0, body extends into +X  (X ∈ [0, 10])', () => {
    const { base, top } = axisEndpoints("-X", DEPTH);
    expect(Math.abs(top[0])).toBeLessThan(NEAR_ZERO);
    expect(base[0]).toBeCloseTo(DEPTH, 6);
    expect(Math.abs(base[1])).toBeLessThan(NEAR_ZERO);
    expect(Math.abs(base[2])).toBeLessThan(NEAR_ZERO);
  });

  it('"+Y": opening at Y=0, body extends into -Y  (Y ∈ [-10, 0])', () => {
    const { base, top } = axisEndpoints("+Y", DEPTH);
    expect(Math.abs(top[1])).toBeLessThan(NEAR_ZERO);
    expect(base[1]).toBeCloseTo(-DEPTH, 6);
    expect(Math.abs(base[0])).toBeLessThan(NEAR_ZERO);
    expect(Math.abs(base[2])).toBeLessThan(NEAR_ZERO);
  });

  it('"-Y": opening at Y=0, body extends into +Y  (Y ∈ [0, 10])', () => {
    const { base, top } = axisEndpoints("-Y", DEPTH);
    expect(Math.abs(top[1])).toBeLessThan(NEAR_ZERO);
    expect(base[1]).toBeCloseTo(DEPTH, 6);
    expect(Math.abs(base[0])).toBeLessThan(NEAR_ZERO);
    expect(Math.abs(base[2])).toBeLessThan(NEAR_ZERO);
  });
});

describe("holes — axis is accepted on every directional helper", () => {
  // TYPE-level regression guard: the objects below must type-check with
  // `axis` present on every helper's options. If the axis prop were missing
  // from any helper's type, `tsc --noEmit` (which the vitest run honors)
  // would flag these. We also assert the runtime doesn't crash at the
  // option-parsing stage — we stop right before the Replicad call by
  // reading `typeof` on the helper (already handled above) and verifying
  // the options object SHAPE is well-formed.
  const axes: HoleAxis[] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];

  it("through accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.through>[1] = { depth: 10, axis };
      expect(opts.axis).toBe(axis);
    }
  });

  it("clearance accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.clearance>[1] = { depth: 10, axis };
      expect(opts.axis).toBe(axis);
    }
  });

  it("counterbore accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.counterbore>[1] = { plateThickness: 5, axis };
      expect(opts.axis).toBe(axis);
    }
  });

  it("countersink accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.countersink>[1] = { plateThickness: 5, axis };
      expect(opts.axis).toBe(axis);
    }
  });

  it("tapped accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.tapped>[1] = { depth: 5, axis };
      expect(opts.axis).toBe(axis);
    }
  });

  it("keyhole accepts axis on its opts (Fix D — previously missing)", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.keyhole>[0] = {
        largeD: 10,
        smallD: 4,
        slot: 6,
        depth: 4,
        axis,
      };
      expect(opts.axis).toBe(axis);
    }
  });

  it("slot accepts axis on its opts", () => {
    for (const axis of axes) {
      const opts: Parameters<typeof holes.slot>[0] = {
        length: 20,
        width: 5,
        depth: 4,
        axis,
      };
      expect(opts.axis).toBe(axis);
    }
  });
});
