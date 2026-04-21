import { describe, it, expect, beforeEach, vi } from "vitest";
import * as patterns from "./patterns";
import { drainCutAtOutcomes, drainRuntimeWarnings, resetRuntimeWarnings } from "./warnings";

// Mock the `replicad` module used by patterns.ts for volume measurement.
// patterns.ts reads `measureShapeVolumeProperties` off the module; we stub
// it so tests can control input vs output volumes without touching WASM.
vi.mock("replicad", () => ({
  measureShapeVolumeProperties: (shape: any) =>
    typeof shape?.__volume === "number"
      ? { volume: shape.__volume, delete: () => {} }
      : undefined,
}));

// ---------------------------------------------------------------------------
// `patterns.onPlane` — composable plane remapper.
//
// Pure data-transform tests; no OCCT/Manifold involvement. Mirrors the style
// of `threads.test.ts` (pin public shape + verify the remap math).
// ---------------------------------------------------------------------------

describe("patterns.onPlane — plane remapper", () => {
  it("exports `onPlane`", () => {
    expect(typeof patterns.onPlane).toBe("function");
  });

  it("XY is identity — returns placements unchanged", () => {
    const src = patterns.grid(3, 2, 10, 5);
    const out = patterns.onPlane(src, "XY");
    expect(out).toBe(src); // same reference — identity, no allocation
    expect(out).toEqual(src);
  });

  it("YZ remap: [x, y, z] → [0, x, y] (normal = +X)", () => {
    // grid(3, 2, 10, 5) centered on origin:
    //   ix=[-10, 0, 10], iy=[-2.5, 2.5], z=0.
    const src = patterns.grid(3, 2, 10, 5);
    const out = patterns.onPlane(src, "YZ");
    expect(out).toHaveLength(6);

    // First cell in XY is (-10, -2.5, 0) → YZ should be (0, -10, -2.5).
    expect(out[0].translate).toEqual([0, -10, -2.5]);
    // Middle-top cell in XY is (0, 2.5, 0) → YZ should be (0, 0, 2.5).
    expect(out[4].translate).toEqual([0, 0, 2.5]);

    // All remapped points must have x=0 (live on the YZ plane).
    for (const p of out) {
      expect(p.translate[0]).toBe(0);
    }
  });

  it("XZ remap: [x, y, z] → [x, 0, y] (normal = +Y)", () => {
    const src = patterns.grid(3, 2, 10, 5);
    const out = patterns.onPlane(src, "XZ");
    expect(out).toHaveLength(6);

    // First cell (-10, -2.5, 0) → XZ (-10, 0, -2.5).
    expect(out[0].translate).toEqual([-10, 0, -2.5]);
    // All remapped points must have y=0 (live on the XZ plane).
    for (const p of out) {
      expect(p.translate[1]).toBe(0);
    }
  });

  it("throws with a helpful message for an unknown plane", () => {
    expect(() =>
      // @ts-expect-error — intentionally invalid plane to test validation
      patterns.onPlane(patterns.grid(2, 2, 10), "XW"),
    ).toThrow(/unknown plane "XW"/);
  });

  it("preserves `rotate` and remaps `axis` onto the new plane", () => {
    // polar(4, 10, { orientOutward: true }) emits placements with rotate
    // set and axis = [0, 0, 1] (Z-axis spin).
    const src = patterns.polar(4, 10, { orientOutward: true });
    const out = patterns.onPlane(src, "YZ");

    // rotate is preserved verbatim on each placement.
    for (let i = 0; i < src.length; i++) {
      expect(out[i].rotate).toBe(src[i].rotate);
      expect(out[i].axis).toBeDefined();
    }

    // Z-axis [0,0,1] remaps to [0,0,0] on YZ (lose the "around-Z" meaning,
    // but the mapping is consistent with translations). More interesting:
    // if we manually build a placement with axis=[1,0,0], YZ remap gives
    // [0,1,0].
    const custom = [
      { translate: [1, 2, 3] as [number, number, number], rotate: 45, axis: [1, 0, 0] as [number, number, number] },
    ];
    const [remapped] = patterns.onPlane(custom, "YZ");
    expect(remapped.translate).toEqual([0, 1, 2]);
    expect(remapped.rotate).toBe(45);
    expect(remapped.axis).toEqual([0, 1, 0]);

    const [remappedXZ] = patterns.onPlane(custom, "XZ");
    expect(remappedXZ.translate).toEqual([1, 0, 2]);
    expect(remappedXZ.axis).toEqual([1, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// `patterns.rectOnPlane` — composed grid + plane remap.
// ---------------------------------------------------------------------------

describe("patterns.rectOnPlane", () => {
  it("exports `rectOnPlane`", () => {
    expect(typeof patterns.rectOnPlane).toBe("function");
  });

  it("produces a centered nx*ny grid on the requested plane", () => {
    // 3 columns × 2 rows with 10×5 spacing → nx*ny = 6 placements.
    const out = patterns.rectOnPlane({
      plane: "XZ",
      nx: 3,
      ny: 2,
      dx: 10,
      dy: 5,
    });
    expect(out).toHaveLength(6);

    // XZ remap: base grid (XY) translate [x, y, 0] → [x, 0, y]. So every
    // placement should live on the XZ plane (y == 0) with the 2-axis
    // component coming from the original y.
    for (const p of out) {
      expect(p.translate[1]).toBe(0);
    }

    // Centered 3×2 grid values:
    //   X ∈ {-10, 0, 10},  originalY ∈ {-2.5, 2.5}
    // After XZ remap, Z picks up the originalY values.
    const xz = out.map((p) => [p.translate[0], p.translate[2]]);
    const expected = [
      [-10, -2.5], [0, -2.5], [10, -2.5],
      [-10, 2.5],  [0, 2.5],  [10, 2.5],
    ];
    expect(xz).toEqual(expected);
  });

  it("returns non-XY translate vectors for a YZ-plane rect", () => {
    const out = patterns.rectOnPlane({
      plane: "YZ",
      nx: 2,
      ny: 2,
      dx: 6,
      dy: 8,
    });
    // Every placement lives on the YZ plane (x == 0) and has at least one
    // non-zero component in Y or Z.
    for (const p of out) {
      expect(p.translate[0]).toBe(0);
      expect(p.translate[1] !== 0 || p.translate[2] !== 0).toBe(true);
    }
  });

  it("uncentered anchors the first cell at the plane-origin", () => {
    const out = patterns.rectOnPlane({
      plane: "XY",
      nx: 2,
      ny: 2,
      dx: 4,
      dy: 4,
      centered: false,
    });
    // First cell at [0, 0, 0], spacing 4 along both axes.
    expect(out.map((p) => p.translate)).toEqual([
      [0, 0, 0],
      [4, 0, 0],
      [0, 4, 0],
      [4, 4, 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// `patterns.cutAt` — runtime warnings for silent no-op cuts.
//
// Builds synthetic Shape3D stand-ins exposing just enough surface
// (boundingBox.bounds, .cut(), __volume) for the bbox and volume guards to
// operate. No OCCT/Manifold involvement.
// ---------------------------------------------------------------------------

type MockBounds = [[number, number, number], [number, number, number]];

/**
 * Construct a mock shape with a stable bounding box and a controllable
 * volume. `.cut(other)` returns a new mock shape whose volume is chosen by
 * the test (via `subtractVolume`) — default behaviour is "real cut removes
 * some material"; pass 0 to simulate a disjoint no-op.
 */
function mockShape(
  bounds: MockBounds,
  volume: number,
  cutStrategy: "real" | "noop" = "real",
): any {
  const self: any = {
    __volume: volume,
    boundingBox: { bounds },
    cut(_other: any) {
      const nextVol = cutStrategy === "noop" ? volume : Math.max(0, volume - 1);
      return mockShape(bounds, nextVol, cutStrategy);
    },
    translate(_x: number, _y: number, _z: number) {
      return self;
    },
    rotate(_angle: number, _origin: any, _axis: any) {
      return self;
    },
  };
  return self;
}

describe("patterns.cutAt — silent no-op guards", () => {
  beforeEach(() => {
    resetRuntimeWarnings();
  });

  it("emits no warning when cuts actually remove material", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "real");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("warns when every placement is outside the target bounding box (generator-produced)", () => {
    // Target at origin; tools placed far outside (cut is a no-op).
    // Use cut-strategy "noop" so .cut returns identical volume — matches
    // reality for disjoint cutters.
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    // Tool bounds start at x=100, so every placement remains disjoint.
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    // Use a pattern generator so the array carries the `__generated__` marker
    // — generator output keeps the warning severity (explicit placements
    // throw; tested separately below).
    patterns.cutAt(target, () => tool, patterns.linear(2, [0, 0, 0]));
    const warnings = drainRuntimeWarnings();
    // Bbox guard fires first — that's the one we care about here.
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some((w) => /outside the target's bounding box/.test(w))).toBe(true);
  });

  it("warns when cut is a no-op despite overlapping bboxes (volume-equal guard)", () => {
    // Bboxes overlap so the bbox-disjoint check passes, but .cut() returns
    // a shape with identical volume — the exact silent-no-op pathology the
    // user hit with an unexpectedly-signed extrude direction.
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    expect(() =>
      patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]),
    ).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/no material removal/);
    expect(warnings[0]).toMatch(/V=1000\.00 mm³/);
    expect(warnings[0]).toMatch(/sketchOnPlane\("XZ"\)\.extrude/);
  });

  it("volume-equal warning has no directional axisHint when bboxes overlap on every axis", () => {
    // Sanity-pin the patterns.cutAt axis-hint path: when every placement's
    // bbox overlaps the target (so the volume guard is the one that fires),
    // the `firstToolBounds`-based axisHint finds no disjoint axis and stays
    // empty. This documents the intended symmetry with the index-level
    // `axisDisjointHint` — the directional suffix only appears when there's
    // a real axis mismatch to report.
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/no material removal/);
    // With overlapping bboxes the directional hint MUST NOT be added.
    expect(warnings[0]).not.toMatch(/Cutter is (BELOW|ABOVE|LEFT-OF|RIGHT-OF|IN-FRONT-OF|BEHIND) target/);
  });

  it("skips the volume guard when the bbox-disjoint warning already fired", () => {
    // Don't double-warn when the bbox guard has already told the user why.
    // Use a generator-produced placement array so the miss stays a warning
    // rather than being promoted to a throw (P9 severity change).
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    patterns.cutAt(target, () => tool, patterns.linear(1, [0, 0, 0]));
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/outside the target's bounding box/);
    expect(warnings[0]).not.toMatch(/no material removal/);
  });

  it("prefixes warnings with the per-execution call ordinal when `name` is omitted", () => {
    // Three cutAt calls in one "script"; the third is a no-op. The emitted
    // warning must say `#3` so the engineer doesn't have to hunt.
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "real");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);

    // Two real cuts — drain their (empty) warning channel to keep state tidy
    // and advance the counter.
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    drainRuntimeWarnings();

    // Third call is disjoint — should warn as call #3. Use generator output
    // so the severity stays at warning (explicit arrays throw per P9).
    const noopTarget = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const farTool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    patterns.cutAt(noopTarget, () => farTool, patterns.linear(1, [0, 0, 0]));
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/^patterns\.cutAt call #3:/);
  });

  it("prefers the caller-supplied `name` over the call ordinal", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    // Generator output so the disjoint miss stays a warning.
    patterns.cutAt(target, () => tool, patterns.linear(1, [0, 0, 0]), {
      name: "motor-mount-holes",
    });
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/^patterns\.cutAt "motor-mount-holes":/);
    // Name replaces the ordinal; the "#N" tag must NOT leak into the message.
    expect(warnings[0]).not.toMatch(/call #\d+/);
  });

  it("volume-equal warning also carries the attribution prefix", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }], {
      name: "tapped-holes",
    });
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/^patterns\.cutAt "tapped-holes":/);
    expect(warnings[0]).toMatch(/no material removal/);
  });

  // -------------------------------------------------------------------------
  // Fix C — rotated cutter world-AABB regression.
  //
  // Reported case: `holes.counterbore("M3").rotate(90, ...).translate(...)`
  // passed through `cutAt` silently no-op'd against a motor-bracket vertical
  // plate with no warning. Root cause: if the disjoint check read bounds
  // from the *unplaced* tool (or the factory's pre-transform pose), a
  // rotated-and-translated cutter whose world AABB sits well outside the
  // target would look like it was still overlapping.
  //
  // The fix is an ordering contract: `readBounds(applyPlacement(makeTool(), p))`.
  // These two tests pin that contract with a bounds-aware mock that simulates
  // Replicad's behaviour where each rotate/translate returns a new shape
  // with a fresh world AABB.
  // -------------------------------------------------------------------------

  /**
   * Mock shape whose translate/rotate return a NEW shape with recomputed
   * bounds — closer to real OCCT than the static-bounds `mockShape`. Only
   * models 90° rotations about +X/+Y (enough to exercise the bbox ordering
   * contract without reimplementing general 3D rotation math).
   */
  function transformingMock(
    bounds: MockBounds,
    volume: number,
    cutStrategy: "real" | "noop" = "noop",
  ): any {
    const self: any = {
      __volume: volume,
      boundingBox: { bounds },
      cut(_other: any) {
        const nextVol = cutStrategy === "noop" ? volume : Math.max(0, volume - 1);
        return transformingMock(bounds, nextVol, cutStrategy);
      },
      translate(x: number, y: number, z: number) {
        const [[x0, y0, z0], [x1, y1, z1]] = bounds;
        const nextBounds: MockBounds = [
          [x0 + x, y0 + y, z0 + z],
          [x1 + x, y1 + y, z1 + z],
        ];
        return transformingMock(nextBounds, volume, cutStrategy);
      },
      rotate(angleDeg: number, _origin: any, axis: [number, number, number]) {
        const [[x0, y0, z0], [x1, y1, z1]] = bounds;
        const a = ((angleDeg % 360) + 360) % 360;
        const [ax, ay, az] = axis;
        if (a === 90 && ax === 1 && ay === 0 && az === 0) {
          // 90° around +X: (x,y,z) → (x, -z, y). AABB extents swap on Y↔Z
          // with the Z→-Z flip.
          const nextBounds: MockBounds = [
            [x0, -z1, y0],
            [x1, -z0, y1],
          ];
          return transformingMock(nextBounds, volume, cutStrategy);
        }
        if (a === 90 && ax === 0 && ay === 1 && az === 0) {
          // 90° around +Y: (x,y,z) → (z, y, -x).
          const nextBounds: MockBounds = [
            [z0, y0, -x1],
            [z1, y1, -x0],
          ];
          return transformingMock(nextBounds, volume, cutStrategy);
        }
        // Fallback — tests don't exercise this branch.
        return transformingMock(bounds, volume, cutStrategy);
      },
    };
    return self;
  }

  it("detects a rotated-and-translated cutter whose world AABB is disjoint from the target", () => {
    // Target: thin vertical plate, Y ∈ [0, 3] (the plate's thickness).
    const target = transformingMock(
      [[-30, 0, 0], [30, 3, 40]],
      1000,
      "noop",
    );

    // Cutter pre-placement: small cylinder at the origin, axis +Z,
    // bbox touches the plate if used as-is.
    const cutter = transformingMock([[-2, -2, -10], [2, 2, 0]], 10, "noop");

    // Mirrors the real-world misuse: tool already rotated + translated
    // inside the factory, and then the outer `applyPlacement` is identity.
    // After rotate(90°, +X): bbox ~ X∈[-2,2], Y∈[0,10], Z∈[-2,2].
    // After translate(0, 100, 20): bbox ~ X∈[-2,2], Y∈[100,110], Z∈[18,22]
    // — Y range is 100+ mm from the plate's Y∈[0,3], so strictly disjoint.
    const factory = () =>
      cutter.rotate(90, [0, 0, 0], [1, 0, 0]).translate(0, 100, 20);

    // Generator-produced so disjoint stays a warning (P9).
    patterns.cutAt(target, factory, patterns.linear(1, [0, 0, 0]));
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(
      warnings.some((w) => /outside the target's bounding box/.test(w)),
    ).toBe(true);
  });

  it("does not warn when a rotated cutter's world AABB overlaps the target", () => {
    // Same rotation but translate places the tool over the plate — no
    // false-positive warning should fire.
    const target = transformingMock(
      [[-30, 0, 0], [30, 3, 40]],
      1000,
      "real", // actual cut — volume drops, so volume guard is silent too
    );
    const cutter = transformingMock([[-2, -2, -10], [2, 2, 0]], 10, "real");

    // Rotate 90° around +X, then sit at Y=0 so the rotated cutter's Y range
    // [0, 10] overlaps the plate's Y range [0, 3].
    const factory = () =>
      cutter.rotate(90, [0, 0, 0], [1, 0, 0]).translate(0, 0, 20);

    patterns.cutAt(target, factory, [{ translate: [0, 0, 0] }]);
    const warnings = drainRuntimeWarnings();
    expect(warnings).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // P3-7 — factory-only runtime guard.
  //
  // The TypeScript signature `() => Shape3D` catches typed callers, but plain
  // JS and `as any` escapes slip through. If a user passes a shared shape
  // directly, replicad's destructive translate/rotate would delete the
  // OCCT handle after the first placement — a confusing mid-pattern crash.
  // Reject up front with a hint.
  // -------------------------------------------------------------------------
  it("throws a TypeError when `toolFactory` is a Shape3D, not a factory function", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "real");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    expect(() =>
      // @ts-expect-error — intentionally wrong shape to test the runtime guard
      patterns.cutAt(target, tool, [{ translate: [0, 0, 0] }]),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error — see above
      patterns.cutAt(target, tool, [{ translate: [0, 0, 0] }]),
    ).toThrow(/must be a factory function/);
  });

  // -------------------------------------------------------------------------
  // P9 — severity promotion for explicit (non-generator) placement arrays.
  //
  // Generator output (polar/grid/linear/...) is brand-marked `__generated__`
  // so a bbox miss stays a (loud) warning — users routinely compute copies
  // from live params and the math can legitimately drift outside. A
  // hand-authored `[{ translate: [...] }, ...]` is treated as an assertion:
  // a miss indicates a typo or sign error, which should fail the render
  // loudly so the engineer can't miss it in a 71-part assembly log.
  // -------------------------------------------------------------------------
  it("THROWS when every explicit placement misses the target bbox", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    expect(() =>
      patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]),
    ).toThrow(/\[patterns\.cutAt\]/);
    expect(() =>
      patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]),
    ).toThrow(/outside the target's bounding box/);
  });

  it("THROWS when some (but not all) explicit placements miss the target bbox", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    // Two tools at different world positions — one over the target, one far
    // outside. The .cut() path keeps volume identical (noop strategy), so
    // it's purely the bbox-disjoint path that fires.
    const farTool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    const nearTool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    // The mock's factory returns a single tool; to simulate per-placement
    // tool geometry we use a stateful factory.
    let callN = 0;
    const factory = () => (callN++ === 0 ? nearTool : farTool);
    expect(() =>
      patterns.cutAt(target, factory, [
        { translate: [0, 0, 0] },
        { translate: [0, 0, 0] },
      ]),
    ).toThrow(/\[patterns\.cutAt\]/);
  });

  it("does NOT throw when a generator placement array is all-disjoint — stays a warning", () => {
    // Identical geometry to the explicit-miss test above, but with a
    // generator-produced placement array → severity stays at warning.
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    expect(() =>
      patterns.cutAt(target, () => tool, patterns.linear(2, [0, 0, 0])),
    ).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => /outside the target's bounding box/.test(w))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // P9 — `__generated__` brand preservation through helper pipelines.
  //
  // Pattern-building helpers (`onPlane`, `rectOnPlane`) post-process
  // generator output with `.map(...)` which drops non-enumerable markers.
  // The wrappers must re-apply the brand so composed pipelines
  // (e.g. grid → onPlane) still classify as generator-produced.
  // -------------------------------------------------------------------------
  it("preserves the __generated__ brand through onPlane (XY identity)", () => {
    const src = patterns.grid(2, 2, 10);
    expect((src as any).__generated__).toBe(true);
    const out = patterns.onPlane(src, "XY");
    expect((out as any).__generated__).toBe(true);
  });

  it("preserves the __generated__ brand through onPlane (YZ remap)", () => {
    const src = patterns.grid(2, 2, 10);
    const out = patterns.onPlane(src, "YZ");
    expect((out as any).__generated__).toBe(true);
  });

  it("preserves the __generated__ brand through rectOnPlane", () => {
    const out = patterns.rectOnPlane({ plane: "XZ", nx: 3, ny: 2, dx: 5, dy: 5 });
    expect((out as any).__generated__).toBe(true);
  });

  it("marks polar / linear / linearAlongAxis output as generated", () => {
    expect((patterns.polar(4, 10) as any).__generated__).toBe(true);
    expect((patterns.linear(3, [5, 0, 0]) as any).__generated__).toBe(true);
    expect((patterns.linearAlongAxis(3, 0, 10, "X") as any).__generated__).toBe(true);
  });

  it("__generated__ marker is non-enumerable (does not pollute JSON)", () => {
    const src = patterns.grid(2, 2, 10);
    // The marker should NOT appear in JSON output — consumers shouldn't
    // see an implementation-detail flag bleed into user data.
    const json = JSON.parse(JSON.stringify(src));
    expect(json).toEqual(src.map((p) => ({ ...p })));
  });

  // -------------------------------------------------------------------------
  // P9 — `hasRemovedMaterial` / cutAt outcome buffer.
  //
  // Each cutAt call records whether material actually came off, and
  // `drainCutAtOutcomes()` returns the per-call list so MCP can aggregate.
  // -------------------------------------------------------------------------
  it("records a `true` outcome when cutAt removes material", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "real");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    expect(drainCutAtOutcomes()).toEqual([true]);
  });

  it("records a `false` outcome when cutAt is a volume no-op (overlapping bboxes)", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[-1, -1, 0], [1, 1, 5]], 10);
    patterns.cutAt(target, () => tool, [{ translate: [0, 0, 0] }]);
    drainRuntimeWarnings(); // drain the volume-guard warning we emit
    expect(drainCutAtOutcomes()).toEqual([false]);
  });

  it("records a `false` outcome from the bbox-disjoint warning branch (generator-produced)", () => {
    const target = mockShape([[-10, -10, 0], [10, 10, 5]], 1000, "noop");
    const tool = mockShape([[100, 100, 0], [110, 110, 5]], 10);
    patterns.cutAt(target, () => tool, patterns.linear(1, [0, 0, 0]));
    drainRuntimeWarnings();
    expect(drainCutAtOutcomes()).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// P3-6 — `cutTop` / `cutBottom` sugar for plate-face cuts.
//
// The helpers ONLY position the tool at the plate's top/bottom face —
// they don't infer the tool's own internal depth. Tests verify the
// translate-to-face math against a transformingMock whose cut() records
// the incoming tool's bounds so we can assert where the cut landed.
// ---------------------------------------------------------------------------

describe("patterns.cutTop / cutBottom — plate-face cut sugar", () => {
  /**
   * Mock plate + cut-tool factory. `cut()` records where the tool ended up
   * (via its world-AABB after translate) so the test can assert the
   * positioning math rather than caring about the final shape's volume.
   */
  function plateMock(bounds: MockBounds): any {
    const self: any = {
      lastCutToolBounds: undefined as MockBounds | undefined,
      boundingBox: { bounds },
      cut(tool: any) {
        self.lastCutToolBounds = tool.boundingBox?.bounds;
        return self;
      },
    };
    return self;
  }
  /**
   * Translating mock that recomputes bounds on translate (mirrors the real
   * OCCT behaviour where each translate returns a new shape with fresh
   * world-space AABB). Used as the factory output for the translate
   * positioning test.
   */
  function trackingTool(bounds: MockBounds): any {
    const self: any = {
      boundingBox: { bounds },
      translate(x: number, y: number, z: number) {
        const [[x0, y0, z0], [x1, y1, z1]] = bounds;
        return trackingTool([
          [x0 + x, y0 + y, z0 + z],
          [x1 + x, y1 + y, z1 + z],
        ]);
      },
    };
    return self;
  }

  it("exports cutTop and cutBottom", () => {
    expect(typeof patterns.cutTop).toBe("function");
    expect(typeof patterns.cutBottom).toBe("function");
  });

  it("cutTop translates the tool to the plate's top-face Z", () => {
    // Plate spans Z ∈ [0, 5] — top face is at Z=5.
    const plate = plateMock([[-30, -20, 0], [30, 20, 5]]);
    patterns.cutTop(plate, () => trackingTool([[-1, -1, -5], [1, 1, 0]]), [10, 7]);
    // Tool started at Z ∈ [-5, 0]; cutTop should translate by (10, 7, 5)
    // → final tool Z ∈ [0, 5], X ∈ [9, 11], Y ∈ [6, 8].
    expect(plate.lastCutToolBounds).toEqual([
      [9, 6, 0],
      [11, 8, 5],
    ]);
  });

  it("cutBottom translates the tool to the plate's bottom-face Z", () => {
    // Plate spans Z ∈ [2, 7] — bottom face is at Z=2 (NOT zero — verifies
    // we're reading min, not assuming 0).
    const plate = plateMock([[-30, -20, 2], [30, 20, 7]]);
    patterns.cutBottom(plate, () => trackingTool([[-1, -1, 0], [1, 1, 3]]), [-5, 4]);
    // Tool started Z ∈ [0, 3]; cutBottom translates by (-5, 4, 2)
    // → final tool Z ∈ [2, 5], X ∈ [-6, -4], Y ∈ [3, 5].
    expect(plate.lastCutToolBounds).toEqual([
      [-6, 3, 2],
      [-4, 5, 5],
    ]);
  });

  it("cutTop throws TypeError when toolFactory is a Shape3D, not a function", () => {
    const plate = plateMock([[-10, -10, 0], [10, 10, 5]]);
    const notAFactory = trackingTool([[-1, -1, 0], [1, 1, 5]]);
    expect(() =>
      // @ts-expect-error — intentionally wrong shape
      patterns.cutTop(plate, notAFactory, [0, 0]),
    ).toThrow(TypeError);
    expect(() =>
      // @ts-expect-error — see above
      patterns.cutTop(plate, notAFactory, [0, 0]),
    ).toThrow(/must be a factory function/);
  });

  it("cutBottom throws when plate has no readable bounding box", () => {
    const bad: any = { cut: () => bad };
    expect(() =>
      patterns.cutBottom(bad, () => trackingTool([[-1, -1, 0], [1, 1, 5]]), [0, 0]),
    ).toThrow(/cannot read plate bounding box/);
  });
});

// ---------------------------------------------------------------------------
// `patterns.linear` — optional symmetric-about-origin centering.
//
// Default (centered: false) is the existing zero-origin behaviour; the new
// `centered: true` shifts every placement by `-((n-1)/2) * step` so the run
// straddles the origin the same way `grid` does.
// ---------------------------------------------------------------------------

describe("patterns.linear — centered option", () => {
  it("defaults to uncentered (placements start at the origin)", () => {
    const out = patterns.linear(4, [10, 0, 0]);
    expect(out.map((p) => p.translate)).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
      [30, 0, 0],
    ]);
  });

  it("even n: centered placements straddle the origin with half-step gaps", () => {
    // 4 positions, step 10 — centered run spans [-15, +15] with half-steps.
    const out = patterns.linear(4, [10, 0, 0], { centered: true });
    expect(out.map((p) => p.translate)).toEqual([
      [-15, 0, 0],
      [-5, 0, 0],
      [5, 0, 0],
      [15, 0, 0],
    ]);
  });

  it("odd n: centered places the middle placement exactly on the origin", () => {
    const out = patterns.linear(3, [0, 8, 0], { centered: true });
    expect(out.map((p) => p.translate)).toEqual([
      [0, -8, 0],
      [0, 0, 0],
      [0, 8, 0],
    ]);
  });
});

// ---------------------------------------------------------------------------
// `patterns.linearAlongAxis` — axis-interval placement helper.
// ---------------------------------------------------------------------------

describe("patterns.linearAlongAxis", () => {
  it("count=1 returns a single midpoint placement", () => {
    const out = patterns.linearAlongAxis(1, 0, 10, "X");
    expect(out).toHaveLength(1);
    expect(out[0].translate).toEqual([5, 0, 0]);
  });

  it("count=3 evenly spaces endpoints-inclusive over [0, 10] on X", () => {
    const out = patterns.linearAlongAxis(3, 0, 10, "X");
    expect(out).toHaveLength(3);
    expect(out[0].translate).toEqual([0, 0, 0]);
    expect(out[1].translate).toEqual([5, 0, 0]);
    expect(out[2].translate).toEqual([10, 0, 0]);
  });

  it("respects the requested axis (Y)", () => {
    const out = patterns.linearAlongAxis(3, -10, 10, "Y");
    expect(out.map((p) => p.translate)).toEqual([
      [0, -10, 0],
      [0, 0, 0],
      [0, 10, 0],
    ]);
  });

  it("rejects non-integer count and non-finite bounds", () => {
    expect(() => patterns.linearAlongAxis(0, 0, 10, "X")).toThrow(/count/);
    expect(() => patterns.linearAlongAxis(1.5, 0, 10, "X")).toThrow(/count/);
    expect(() =>
      patterns.linearAlongAxis(2, NaN, 10, "X"),
    ).toThrow(/finite/);
  });
});
