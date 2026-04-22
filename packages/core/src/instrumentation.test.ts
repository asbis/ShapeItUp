import { describe, it, expect, beforeEach } from "vitest";
import { beginInstrumentation, instrumentReplicadExports } from "./instrumentation";
import {
  drainExtrudeHints,
  drainRuntimeWarnings,
  resetRuntimeWarnings,
} from "./stdlib/warnings";

// ---------------------------------------------------------------------------
// These tests verify the pre-OCCT validation hooks (Bugs #7 + #8).
//
// `instrumentReplicadExports` wraps free functions in-place and walks class
// prototypes to wrap methods. Each wrapper runs an optional validator BEFORE
// calling the original. Validators throw readable TypeErrors for degenerate
// inputs so the agent gets actionable feedback instead of an opaque OCCT
// pointer exception.
// ---------------------------------------------------------------------------

describe("instrumentation — free-function validators (Bug #7)", () => {
  beforeEach(() => beginInstrumentation());

  function makeStub() {
    // Bare function so instrumentReplicadExports treats it as a free export,
    // not a class (no usable prototype methods).
    const fn: any = (...args: any[]) => ({ _called: args });
    // Ensure no prototype-method detection fires: the default Function.prototype
    // only owns `constructor`, which the wrapper filters out. Good enough.
    return fn;
  }

  it("drawRectangle rejects zero width", () => {
    const exports: any = { drawRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRectangle(0, 10)).toThrow(
      /drawRectangle: width must be a finite positive number/,
    );
  });

  it("drawRectangle rejects negative height", () => {
    const exports: any = { drawRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRectangle(10, -5)).toThrow(
      /drawRectangle: height must be a finite positive number/,
    );
  });

  it("drawRectangle accepts positive dimensions", () => {
    const exports: any = { drawRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRectangle(10, 5)).not.toThrow();
  });

  it("drawCircle rejects NaN radius", () => {
    const exports: any = { drawCircle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawCircle(NaN)).toThrow(
      /drawCircle: radius must be a finite positive number/,
    );
  });

  it("drawRoundedRectangle rejects radius > half min side", () => {
    const exports: any = { drawRoundedRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRoundedRectangle(10, 20, 6)).toThrow(
      /radius 6 exceeds half the shorter side/,
    );
  });

  it("drawRoundedRectangle rejects radius == half min side (square — degenerates to circle)", () => {
    const exports: any = { drawRoundedRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRoundedRectangle(10, 10, 5)).toThrow(
      /degenerates to a circle.*drawCircle\(5\)/s,
    );
  });

  it("drawRoundedRectangle rejects radius == half min side (rectangle — degenerates to stadium)", () => {
    const exports: any = { drawRoundedRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRoundedRectangle(10, 20, 5)).toThrow(
      /stadium/,
    );
  });

  it("drawRoundedRectangle accepts radius just below half min side (not degenerate)", () => {
    const exports: any = { drawRoundedRectangle: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawRoundedRectangle(10, 10, 4.99)).not.toThrow();
  });

  it("drawPolysides rejects non-integer sides", () => {
    const exports: any = { drawPolysides: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawPolysides(5, 2.5)).toThrow(
      /sides must be an integer >= 3/,
    );
  });

  it("drawPolysides rejects sides < 3", () => {
    const exports: any = { drawPolysides: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.drawPolysides(5, 2)).toThrow(
      /sides must be an integer >= 3/,
    );
  });

  it("makeCone rejects r1=r2=0", () => {
    const exports: any = { makeCone: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.makeCone(0, 0, 5)).toThrow(
      /r1 and r2 cannot both be zero/,
    );
  });

  it("makeCone accepts r1=0, r2>0 (open cone)", () => {
    const exports: any = { makeCone: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.makeCone(0, 5, 10)).not.toThrow();
  });

  it("makeSphere rejects Infinity radius", () => {
    const exports: any = { makeSphere: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.makeSphere(Infinity)).toThrow(
      /radius must be a finite positive number/,
    );
  });

  it("makeBox rejects zero depth in number form", () => {
    const exports: any = { makeBox: makeStub() };
    instrumentReplicadExports(exports);
    expect(() => exports.makeBox(10, 10, 0)).toThrow(
      /depth must be a finite positive number/,
    );
  });

  it("makeBox skips validation for point-point form", () => {
    const exports: any = { makeBox: makeStub() };
    instrumentReplicadExports(exports);
    // Two-point form — neither argument is a bare number, so we don't check.
    expect(() => exports.makeBox([0, 0, 0], [10, 10, 10])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Prototype-method validators: fillet, chamfer, shell, extrude (Sketch/Sketches),
// revolve, scale, translate family.
// ---------------------------------------------------------------------------

describe("instrumentation — prototype method validators", () => {
  beforeEach(() => beginInstrumentation());

  /**
   * Build a fake replicad-like class namespace so instrumentPrototype finds
   * methods to wrap. We give each class a prototype with methods we want
   * guarded, then feed it through instrumentReplicadExports. The class
   * constructor itself doesn't matter — it just needs `prototype` with
   * named function properties.
   */
  function makeShape3DExports() {
    function Solid(this: any) {}
    (Solid as any).prototype.fillet = function (this: any, _r: any, _f?: any) {
      return { _after: "fillet" };
    };
    (Solid as any).prototype.chamfer = function (this: any, _r: any, _f?: any) {
      return { _after: "chamfer" };
    };
    (Solid as any).prototype.shell = function (this: any, _t: any, _f?: any) {
      return { _after: "shell" };
    };
    (Solid as any).prototype.scale = function (this: any, _factor: any) {
      return { _after: "scale" };
    };
    (Solid as any).prototype.translate = function (
      this: any,
      _x: any,
      _y?: any,
      _z?: any,
    ) {
      return { _after: "translate" };
    };
    (Solid as any).prototype.translateX = function (this: any, _d: any) {
      return { _after: "translateX" };
    };

    function Sketch(this: any) {}
    (Sketch as any).prototype.extrude = function (this: any, _d: any) {
      return { _after: "extrude" };
    };
    (Sketch as any).prototype.revolve = function (
      this: any,
      _axis?: any,
      _cfg?: any,
    ) {
      return { _after: "revolve" };
    };

    return { Solid, Sketch } as any;
  }

  it("fillet: plain number radius >= minimum edge length throws readable error (Bug #8)", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    // Simulate a 20x20x10 box's twelve edges: 4 of each of the three lengths.
    const edges = [
      ...Array(4).fill({ length: 20 }),
      ...Array(4).fill({ length: 20 }),
      ...Array(4).fill({ length: 10 }),
    ];
    Object.defineProperty(box, "edges", { get: () => edges });

    expect(() => box.fillet(15)).toThrow(
      /radius 15mm exceeds minimum edge length 10.00mm/,
    );
    // Suggestion should be roughly 45% of the smallest edge = 4.50.
    expect(() => box.fillet(15)).toThrow(/try 4\.50/);
  });

  it("fillet: radius < min edge length passes through", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 10 }, { length: 20 }],
    });

    const result = box.fillet(4);
    expect(result).toEqual({ _after: "fillet" });
  });

  it("fillet: with filter callback skips the pre-check (filter may exclude short edges)", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 1 }],
    });

    // 100 >> 1 but filter is present AND EdgeFinder is NOT exposed by the
    // mock — the guard can't evaluate the selector, so it defers to OCCT.
    // This matches the prior behaviour (pre-filter-aware guard) as a
    // backstop for test mocks and replicad stubs without EdgeFinder.
    expect(() => box.fillet(100, () => ({}))).not.toThrow();
  });

  it("fillet: non-number radius (config object) is left for OCCT to handle", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 1 }],
    });

    // A FaceFinder-style config would trigger OCCT's own handling.
    expect(() => box.fillet({ radius: 100 } as any)).not.toThrow();
  });

  it("chamfer: same guard as fillet", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 5 }, { length: 5 }],
    });

    expect(() => box.chamfer(10)).toThrow(
      /chamfer: radius 10mm exceeds minimum edge length 5\.00mm/,
    );
  });

  // -------------------------------------------------------------------------
  // Filter-aware fillet/chamfer guard.
  //
  // External engineer report: `box.fillet(10, e => e.inDirection("Z"))` on a
  // 3mm-thick box raised an opaque OCCT pointer exception + WASM re-init,
  // while plain `box.fillet(10)` on the same geometry caught the issue via
  // the min-edge-length guard. Root cause: the guard skipped ALL filtered
  // calls, so a filter selecting only short edges bypassed the check.
  //
  // Fix: when a filter callback is present AND replicad exposes EdgeFinder
  // (the real module always does), evaluate the selector against the shape
  // and min-length-check only the filtered subset.
  // -------------------------------------------------------------------------

  /**
   * Build an exports record that includes a minimal EdgeFinder-shaped mock.
   * The mock's filter methods are no-ops that return `this` so the user's
   * chain (e.g. `e.inDirection("Z").ofLength(...)`) works; `find(shape)`
   * returns whichever edge subset the caller pre-installed on the mock via
   * the `programEdges` helper.
   */
  function makeShape3DExportsWithFinder() {
    const exports: any = makeShape3DExports();
    let programmedEdges: any[] | null = null;
    let shouldThrow = false;
    class EdgeFinder {
      // Each chainable filter just returns the same finder. The test decides
      // what edges `find` will produce — the selector logic itself lives in
      // real replicad and isn't what we're validating here.
      inDirection(_: any) { return this; }
      ofLength(_: any) { return this; }
      ofCurveType(_: any) { return this; }
      parallelTo(_: any) { return this; }
      inPlane(_: any, __?: any) { return this; }
      find(_shape: any) {
        if (shouldThrow) throw new Error("finder failed to evaluate");
        return programmedEdges ?? [];
      }
    }
    exports.EdgeFinder = EdgeFinder;
    return {
      exports,
      programEdges: (edges: any[] | null) => { programmedEdges = edges; },
      programThrow: (v: boolean) => { shouldThrow = v; },
    };
  }

  it("fillet: filtered subset excludes short edges → radius OK → no throw", () => {
    const { exports, programEdges } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    // Shape has twelve edges — four 3mm (thickness) and eight 50mm.
    const shortEdges = Array(4).fill({ length: 3 });
    const longEdges = Array(8).fill({ length: 50 });
    Object.defineProperty(box, "edges", {
      get: () => [...shortEdges, ...longEdges],
    });
    // User filter selects ONLY long edges (e.g. the axial ones on a plate).
    programEdges(longEdges);

    // Radius 10 exceeds the 3mm short edges — but those aren't in the
    // filtered subset. Previously this would have been skipped entirely
    // (unsafe when the filter selects SHORT edges); now we correctly see
    // "filtered min = 50, 10 < 50, pass through".
    expect(() => box.fillet(10, (e: any) => e.inDirection("Z"))).not.toThrow();
  });

  it("fillet: filtered subset DOES contain short edges → radius too large → throws with filtered-edge wording", () => {
    const { exports, programEdges } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    // 3mm-thick plate: four 3mm edges (thickness) + eight 50mm edges
    // (length/width). The reported bug: user asks for a 10mm fillet on the
    // thickness-direction edges.
    const shortEdges = Array(4).fill({ length: 3 });
    const longEdges = Array(8).fill({ length: 50 });
    Object.defineProperty(box, "edges", {
      get: () => [...shortEdges, ...longEdges],
    });
    // Filter selects the short (thickness-direction) edges — the exact
    // scenario that previously reached OCCT as a pointer exception.
    programEdges(shortEdges);

    expect(() =>
      box.fillet(10, (e: any) => e.inDirection("Z")),
    ).toThrow(/fillet: radius 10mm exceeds minimum filtered edge length 3\.00mm/);
    // And make sure the suggestion is still present — agents rely on the
    // "try X" value to self-correct.
    expect(() =>
      box.fillet(10, (e: any) => e.inDirection("Z")),
    ).toThrow(/try 1\.35/);
  });

  it("fillet: filter returns an empty edge set → runtime warning (not a throw)", () => {
    // Was a throw. Agents routinely wrap .fillet() in try/catch per the
    // skill docs, and the TypeError got swallowed silently — the resulting
    // shape looked "fine" but had no fillets. Now we push a runtime warning
    // and let the original op run (OCCT no-ops on an empty edge subset).
    const { exports, programEdges } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);
    resetRuntimeWarnings();

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 10 }, { length: 20 }],
    });
    programEdges([]); // selector excluded everything

    expect(() =>
      box.fillet(5, (e: any) => e.inDirection("Z")),
    ).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fillet: filter matched 0 edges/);
  });

  it("fillet: no filter + all edges short → unchanged behaviour (guard still fires)", () => {
    const { exports } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 3 }, { length: 3 }, { length: 3 }, { length: 3 }],
    });

    // With NO filter, the guard still inspects all edges. Error wording
    // uses the unfiltered "edge length" phrasing to stay identical to the
    // pre-fix message (no spurious test churn).
    expect(() => box.fillet(5)).toThrow(
      /fillet: radius 5mm exceeds minimum edge length 3\.00mm/,
    );
  });

  // -------------------------------------------------------------------------
  // Fix A (Bug #2): fillet guard must fire for the no-filter case when a
  // thin wall (bounding-box min dimension) can't physically accept the
  // requested radius, even when individual edge lengths are long enough.
  //
  // External engineer report: L-bracket with thickness=4, filletOuter=6 →
  // raw OCCT pointer exception. The 50mm-long vertical edges pass the
  // min-edge-length check, but the 4mm wall-width can't accept a 6mm
  // radius. Wall-thickness proxy = shape bounding-box minimum dimension.
  // -------------------------------------------------------------------------

  it("fillet: thin-wall shape (4mm), radius 6, no filter → wall-thickness error", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    // Long edges along the bracket's arms (50mm), but the plate is 4mm thick
    // overall — the bounding-box minimum dimension picks up the thin wall.
    Object.defineProperty(box, "edges", {
      get: () => [
        { length: 50 }, { length: 50 }, { length: 50 }, { length: 50 },
        { length: 30 }, { length: 30 }, { length: 30 }, { length: 30 },
      ],
    });
    Object.defineProperty(box, "boundingBox", {
      get: () => ({ width: 50, height: 30, depth: 4 }),
    });

    expect(() => box.fillet(6)).toThrow(
      /fillet: radius 6mm exceeds wall thickness 4\.00mm/,
    );
    // Suggestion should be ~45% of the wall thickness = 1.80.
    expect(() => box.fillet(6)).toThrow(/try 1\.80/);
  });

  it("fillet: thin-wall shape (4mm), radius 0.5, no filter → passes", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 50 }, { length: 30 }],
    });
    Object.defineProperty(box, "boundingBox", {
      get: () => ({ width: 50, height: 30, depth: 4 }),
    });

    // 0.5 < 4 (wall) AND 0.5 < 30 (min edge) — both checks pass.
    expect(() => box.fillet(0.5)).not.toThrow();
  });

  it("fillet: tall box (all dims > radius), radius 6, no filter → passes", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 50 }, { length: 30 }, { length: 20 }],
    });
    // 20mm cube-ish shape — radius 6 fits comfortably in every direction.
    Object.defineProperty(box, "boundingBox", {
      get: () => ({ width: 50, height: 30, depth: 20 }),
    });

    expect(() => box.fillet(6)).not.toThrow();
  });

  it("chamfer: thin-wall shape (4mm), radius 6, no filter → wall-thickness error", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 50 }, { length: 30 }],
    });
    Object.defineProperty(box, "boundingBox", {
      get: () => ({ width: 50, height: 30, depth: 4 }),
    });

    expect(() => box.chamfer(6)).toThrow(
      /chamfer: radius 6mm exceeds wall thickness 4\.00mm/,
    );
  });

  // -------------------------------------------------------------------------
  // W2: empty-finder errors for chamfer + shell (fillet tested above).
  // -------------------------------------------------------------------------

  it("chamfer: filter returns an empty edge set → runtime warning (not a throw)", () => {
    // Same rationale as the fillet empty-filter test above — agents wrap
    // chamfer in try/catch, so a throw vanished silently. Warning surfaces
    // through engine.warnings[] regardless.
    const { exports, programEdges } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);
    resetRuntimeWarnings();

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 10 }, { length: 20 }],
    });
    programEdges([]);

    expect(() =>
      box.chamfer(5, (e: any) => e.inDirection("Z")),
    ).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/chamfer: filter matched 0 edges/);
  });

  it("shell: face-filter matches 0 faces → runtime warning (not a throw)", () => {
    // Converted from throw to warning alongside fillet/chamfer for
    // consistency: a try/catch on .shell() would have silently produced a
    // solid with no cavity.
    const { exports } = makeShape3DExportsWithFinder();
    // Add a FaceFinder mock matching our EdgeFinder pattern so shell's
    // guard can evaluate the user selector.
    let programmedFaces: any[] = [];
    class FaceFinder {
      inPlane(_: any, __?: any) { return this; }
      parallelTo(_: any) { return this; }
      ofSurfaceType(_: any) { return this; }
      find(_shape: any) { return programmedFaces; }
    }
    exports.FaceFinder = FaceFinder;
    instrumentReplicadExports(exports);
    resetRuntimeWarnings();

    const box = new exports.Solid();
    // Fake faces — just need a non-empty array so the guard doesn't bail
    // on an "unusual shape" fast path.
    Object.defineProperty(box, "faces", {
      get: () => [{}, {}, {}, {}, {}, {}],
    });

    // User filter matches no faces (wrong plane offset, etc).
    expect(() =>
      box.shell(2, (f: any) => f.inPlane("XY", 999)),
    ).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/shell: face-filter matched 0 faces/);
  });

  it("fillet: unfiltered call on a shape with zero edges → runtime warning", () => {
    // A zero-edge shape (e.g. an empty compound left over from a boolean
    // that consumed everything) used to hit the "skip" bail and no-op
    // silently. We now emit a warning so the agent learns the op did
    // nothing. Shape with .edges returning [] triggers the sentinel.
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);
    resetRuntimeWarnings();

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", { get: () => [] });

    expect(() => box.fillet(2)).not.toThrow();
    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fillet\(2\) called on a shape with no edges/);
  });

  it("shell: face-filter matches at least one face → no throw", () => {
    const { exports } = makeShape3DExportsWithFinder();
    let programmedFaces: any[] = [{ _isFace: true }];
    class FaceFinder {
      inPlane(_: any, __?: any) { return this; }
      parallelTo(_: any) { return this; }
      ofSurfaceType(_: any) { return this; }
      find(_shape: any) { return programmedFaces; }
    }
    exports.FaceFinder = FaceFinder;
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "faces", {
      get: () => [{}, {}, {}, {}, {}, {}],
    });

    expect(() =>
      box.shell(2, (f: any) => f.inPlane("XY", 0)),
    ).not.toThrow();
  });

  it("fillet: filter throws when evaluated → guard defers to OCCT silently", () => {
    const { exports, programThrow } = makeShape3DExportsWithFinder();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    Object.defineProperty(box, "edges", {
      get: () => [{ length: 3 }, { length: 50 }],
    });
    programThrow(true);

    // If EdgeFinder.find throws (internal state issue, unsupported input,
    // etc.) we'd rather defer to OCCT than mask the real error with a
    // bogus pre-check failure. 100 >> 3 so the UNFILTERED guard WOULD
    // have thrown — assert it does NOT, proving we deferred.
    expect(() =>
      box.fillet(100, (e: any) => e.inDirection("Z")),
    ).not.toThrow();
  });

  it("shell: negative thickness throws", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    expect(() => box.shell(-2)).toThrow(
      /shell: thickness must be a finite positive number/,
    );
  });

  it("scale: factor 0 throws", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    expect(() => box.scale(0)).toThrow(
      /scale: factor must be a finite non-zero number/,
    );
  });

  it("translateX: NaN distance throws", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    expect(() => box.translateX(NaN)).toThrow(
      /translateX: distance must be a finite number/,
    );
  });

  it("translate: 3-number form rejects Infinity", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const box = new exports.Solid();
    expect(() => box.translate(1, 2, Infinity)).toThrow(
      /translate: z must be a finite number/,
    );
  });

  it("Sketch.extrude: collapsed blueprint (width=0) throws (Bug #7)", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    // Simulate a sketch that came from drawRectangle(0, 10).
    Object.defineProperty(sketch, "blueprint", {
      get: () => ({ boundingBox: { width: 0, height: 10 } }),
    });

    expect(() => sketch.extrude(5)).toThrow(
      /Sketch has zero dimension.*width=0.*height=10/s,
    );
  });

  it("Sketch.extrude: zero distance throws", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    Object.defineProperty(sketch, "blueprint", {
      get: () => ({ boundingBox: { width: 10, height: 10 } }),
    });

    expect(() => sketch.extrude(0)).toThrow(
      /extrude: distance must be a finite non-zero number/,
    );
  });

  it("Sketch.extrude: valid sketch + distance passes through", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    Object.defineProperty(sketch, "blueprint", {
      get: () => ({ boundingBox: { width: 10, height: 20 } }),
    });

    const result = sketch.extrude(5);
    expect(result).toEqual({ _after: "extrude" });
  });

  it("Sketch.extrude: negative distance is allowed through (Fix 2 — replicad accepts it natively)", () => {
    // Replicad's Sketch.extrude accepts negative distances — the sign flips
    // the extrude direction along the plane's normal. Instrumentation must
    // NOT intercept a legal replicad call with a false-premise "distance
    // must be positive" error; the previous guard rested on a misdiagnosed
    // WASM pointer exception that didn't actually reproduce.
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    Object.defineProperty(sketch, "blueprint", {
      get: () => ({ boundingBox: { width: 10, height: 20 } }),
    });

    expect(() => sketch.extrude(-15)).not.toThrow();
  });

  it("Sketch.revolve: angle in radians (> 1000 deg) throws with units hint", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    expect(() => sketch.revolve(undefined, { angle: 6.28 * 1000 })).toThrow(
      /did you mean radians\?/,
    );
  });

  it("Sketch.revolve: non-finite angle throws", () => {
    const exports: any = makeShape3DExports();
    instrumentReplicadExports(exports);

    const sketch = new exports.Sketch();
    expect(() => sketch.revolve(undefined, { angle: NaN })).toThrow(
      /angle must be a finite number/,
    );
  });

  // -------------------------------------------------------------------------
  // Fix C — sketchOnPlane("-XY") friendly error.
  //
  // Users intuitively reach for "-XY"/"-XZ"/"-YZ" to flip a sketch to the
  // back of a plane; Replicad only accepts "YX"/"ZX"/"ZY" for that. Before
  // this guard, the negated forms raised an opaque "Invalid plane name" from
  // deep inside OCCT. The instrumentation intercepts the call and throws a
  // TypeError naming the correct swap.
  // -------------------------------------------------------------------------
  function makeDrawingExports() {
    function Drawing(this: any) {}
    (Drawing as any).prototype.sketchOnPlane = function (
      this: any,
      _plane: any,
      _origin?: any,
    ) {
      // Real replicad returns a Sketch; for the test a marker is enough.
      return { _sketched: true };
    };
    return { Drawing } as any;
  }

  it("sketchOnPlane: '-XY' throws a friendly error pointing at 'YX'", () => {
    const exports: any = makeDrawingExports();
    instrumentReplicadExports(exports);

    const d = new exports.Drawing();
    expect(() => d.sketchOnPlane("-XY")).toThrow(
      /does not accept negated plane names \("-XY"\)/,
    );
    expect(() => d.sketchOnPlane("-XY")).toThrow(/Use "YX"/);
  });

  it("sketchOnPlane: '-XZ' maps to 'ZX' in the error message", () => {
    const exports: any = makeDrawingExports();
    instrumentReplicadExports(exports);

    const d = new exports.Drawing();
    expect(() => d.sketchOnPlane("-XZ")).toThrow(/Use "ZX"/);
  });

  it("sketchOnPlane: '-YZ' maps to 'ZY' in the error message", () => {
    const exports: any = makeDrawingExports();
    instrumentReplicadExports(exports);

    const d = new exports.Drawing();
    expect(() => d.sketchOnPlane("-YZ")).toThrow(/Use "ZY"/);
  });

  it("sketchOnPlane: valid plane names ('XY', 'YX', 'XZ', 'ZX', 'YZ', 'ZY') pass through", () => {
    const exports: any = makeDrawingExports();
    instrumentReplicadExports(exports);

    const d = new exports.Drawing();
    for (const plane of ["XY", "XZ", "YZ", "YX", "ZX", "ZY"]) {
      expect(() => d.sketchOnPlane(plane)).not.toThrow();
    }
  });

  it("sketchOnPlane: non-string argument (Plane object) is NOT rejected by the guard", () => {
    // The guard targets the "-XY"/"-XZ"/"-YZ" string form ONLY; a Plane
    // object or any other shape must defer to Replicad's own handling so
    // we don't mask legitimate API usage.
    const exports: any = makeDrawingExports();
    instrumentReplicadExports(exports);

    const d = new exports.Drawing();
    expect(() => d.sketchOnPlane({ _plane: "custom" } as any)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Fix 3 — pen axis-mapping warning false positive.
  //
  // Drawings produced by coordinate-centered primitives (drawRectangle,
  // drawCircle, drawRoundedRectangle, drawEllipse, drawPolysides) must NOT
  // trip the pen-axis warning because those primitives don't involve the pen
  // at all. Prior to the CENTERED_DRAWINGS tag, the bbox-inspection fallback
  // returned false on a stubbed drawing (no blueprint accessor), and the
  // warning fired on every centered-primitive → sketchOnPlane("XZ") chain.
  // -------------------------------------------------------------------------
  function makePrimitivePlusDrawingExports() {
    // A minimal replicad-shaped exports bundle: a Drawing class whose
    // sketchOnPlane returns a Sketch marker, plus free-function primitives
    // that return a stubbed Drawing instance (so instrumentation's post-hook
    // can tag it). Drawing also stubs a handful of pen-axis methods so Fix 6
    // tests can exercise the PEN_AXIS_DRAWINGS tagging path via hLine/vLine.
    // Each pen-axis method returns the SAME receiver (not a fresh instance)
    // to mimic replicad's chainable-builder pattern — the tagger adds both
    // self and result to the set anyway, so this just keeps the test concise.
    function Drawing(this: any) {}
    (Drawing as any).prototype.sketchOnPlane = function (
      this: any,
      _plane: any,
      _origin?: any,
    ) {
      return { _sketched: true };
    };
    (Drawing as any).prototype.lineTo = function (this: any, _p: any) {
      return this;
    };
    (Drawing as any).prototype.close = function (this: any) {
      return this;
    };
    (Drawing as any).prototype.hLine = function (this: any, _d: any) {
      return this;
    };
    (Drawing as any).prototype.vLine = function (this: any, _d: any) {
      return this;
    };
    function makeDrawingResult() {
      return new (Drawing as any)();
    }
    // Bare stub functions — no prototype methods, so instrumentation treats
    // them as free exports and wraps them for post-hooks.
    const drawRectangle = ((_w: number, _h: number) =>
      makeDrawingResult()) as any;
    const drawCircle = ((_r: number) => makeDrawingResult()) as any;
    const drawRoundedRectangle = ((_w: number, _h: number, _r?: number) =>
      makeDrawingResult()) as any;
    return { Drawing, drawRectangle, drawCircle, drawRoundedRectangle } as any;
  }

  it("drawRectangle().sketchOnPlane('XZ') does NOT emit the pen-axis warning", () => {
    resetRuntimeWarnings();
    const exports: any = makePrimitivePlusDrawingExports();
    instrumentReplicadExports(exports);

    const dr = exports.drawRectangle(10, 20);
    dr.sketchOnPlane("XZ");

    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => /pen hLine\/vLine/.test(w))).toBe(false);
  });

  it("drawCircle().sketchOnPlane('ZX') does NOT emit the pen-axis warning", () => {
    resetRuntimeWarnings();
    const exports: any = makePrimitivePlusDrawingExports();
    instrumentReplicadExports(exports);

    const dr = exports.drawCircle(5);
    dr.sketchOnPlane("ZX");

    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => /pen hLine\/vLine/.test(w))).toBe(false);
  });

  it("drawing with only absolute lineTo on non-XY plane does NOT emit the pen-axis warning", () => {
    // Fix 6: a drawing built entirely from absolute-coordinate `.lineTo([x,y])`
    // calls (no hLine/vLine/polarLine/tangentArc/etc.) has no pen-axis state
    // to be confused about — the advisory is noise on these. PEN_AXIS_DRAWINGS
    // stays empty for this receiver so the gate short-circuits.
    resetRuntimeWarnings();
    const exports: any = makePrimitivePlusDrawingExports();
    instrumentReplicadExports(exports);

    const dr = new exports.Drawing();
    dr.lineTo([10, 0]).lineTo([10, 10]).close().sketchOnPlane("XZ");

    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => /pen hLine\/vLine/.test(w))).toBe(false);
  });

  it("drawing with hLine/vLine on non-XY plane DOES emit the pen-axis warning", () => {
    // Fix 6: hLine/vLine/polarLine/tangentArc/etc. are pen-axis methods —
    // their meaning depends on which plane the drawing lands on. When a
    // non-XY plane is chosen AND a pen-axis method was used, the advisory
    // becomes genuinely actionable, so PEN_AXIS_DRAWINGS tags the receiver
    // and the non-XY sketchOnPlane hook fires.
    resetRuntimeWarnings();
    const exports: any = makePrimitivePlusDrawingExports();
    instrumentReplicadExports(exports);

    const dr = new exports.Drawing();
    dr.hLine(5).vLine(5).close().sketchOnPlane("XZ");

    const warnings = drainRuntimeWarnings();
    expect(warnings.some((w) => /pen hLine\/vLine/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 + Fix 2 — extrude-hint dedup and sketchOnPlane origin-offset shift.
//
// These drive the warnings.ts enqueue/drain pair via the full instrumentation
// pipeline (sketchOnPlane post-hook → extrude pre-validator → drain). Going
// through the pipeline matters because `enqueueExtrudeHint` uses the caller's
// stack to distinguish user-origin from stdlib-origin calls; calling it
// directly from a test would (correctly) flag the test file's frame as
// non-stdlib, but ALSO include warnings.ts's own frame — which matches
// `/stdlib/` and drops the hint. Going through instrumentation puts the
// caller in `validateSketchExtrude` (which is in `src/instrumentation.ts`,
// not `/stdlib/`) so the stdlib check runs as it would in production.
// ---------------------------------------------------------------------------
describe("extrude hints — dedup and origin shift", () => {
  beforeEach(() => {
    beginInstrumentation();
    resetRuntimeWarnings();
  });

  function makeSketchExports() {
    // Minimal replicad-shaped bundle exercising the sketchOnPlane → Sketch
    // .extrude path. Drawing returns a Sketch marker; Sketch.extrude returns
    // a fresh Shape marker. The pre-extrude validator inspects blueprint
    // dimensions — we provide a stub blueprint with positive w/h so it
    // doesn't throw on degenerate-dimension checks.
    function Sketch(this: any) {}
    (Sketch as any).prototype.extrude = function (_len: number) {
      return { _extruded: true };
    };
    // stub blueprint accessor so validateSketchExtrude's degenerate-dim
    // check sees positive dimensions and passes.
    Object.defineProperty((Sketch as any).prototype, "blueprint", {
      get() {
        return { boundingBox: { width: 10, height: 10 } };
      },
    });
    function Drawing(this: any) {}
    (Drawing as any).prototype.sketchOnPlane = function (
      this: any,
      _plane: any,
      _origin?: any,
    ) {
      return new (Sketch as any)();
    };
    return { Drawing, Sketch } as any;
  }

  it("20 identical extrudes collapse to one emitted hint per (plane, length)", () => {
    // Simulate a knitting-needle assembly: 20 parts each built with the
    // same sketchOnPlane("XZ").extrude(1.6) pattern. Prior to dedup the
    // drainer emitted 20 copies of the same multi-line advisory.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    for (let i = 0; i < 20; i += 1) {
      d.sketchOnPlane("XZ").extrude(1.6);
    }
    // Final bbox covers the predicted Y ∈ [-1.6, 0] region fully.
    const finalBboxes = [
      { min: [-5, -1.6, -5] as [number, number, number], max: [5, 0, 5] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/sketchOnPlane\('XZ'\)\.extrude\(1\.6\)/);
  });

  it("different (plane, length) pairs emit independently", () => {
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    d.sketchOnPlane("XZ").extrude(1.6);
    d.sketchOnPlane("XZ").extrude(1.6); // dup — collapses
    d.sketchOnPlane("XZ").extrude(3.0); // distinct length
    d.sketchOnPlane("YZ").extrude(1.6); // distinct plane
    // Broad final bbox keeps every prediction covered.
    const finalBboxes = [
      { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(3);
  });

  it("sketchOnPlane('YZ', -T/2).extrude(T) is NOT warned about (centered)", () => {
    // The tester's reported false positive. YZ extrudes natively along
    // +X into [0, T]; the -T/2 origin offset lands the sketch plane at
    // X=-T/2, so the extrude runs X ∈ [-T/2, T/2] — centered. The drain
    // silence the hint because the shifted interval has |center| ≈ 0.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    const T = 10;
    d.sketchOnPlane("YZ", -T / 2).extrude(T);
    const finalBboxes = [
      { min: [-T / 2, -5, -5] as [number, number, number], max: [T / 2, 5, 5] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(0);
  });

  it("non-centering origin offset still checks the shifted interval against the bbox", () => {
    // A +10 origin shift on YZ/length=4: un-shifted prediction is X ∈ [0, 4];
    // shifted is X ∈ [10, 14] (center=12, not centered). Final bbox at
    // X ∈ [0, 4] → no overlap with shifted interval → no warning. This
    // pins the shift math: without it the overlap check would compare the
    // un-shifted [0, 4] and fire a false positive.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    d.sketchOnPlane("YZ", 10).extrude(4);
    const finalBboxes = [
      { min: [0, -2, -2] as [number, number, number], max: [4, 2, 2] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(0);
  });

  it("origin offset given as [x,y,z] tuple shifts on the plane's normal axis", () => {
    // For plane YZ the normal axis is X; a [-T/2, 0, 0] origin should
    // shift the predicted X interval by -T/2, landing centered. The
    // centering branch silences the hint.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    const T = 4;
    d.sketchOnPlane("YZ", [-T / 2, 0, 0]).extrude(T);
    const finalBboxes = [
      { min: [-T / 2, -2, -2] as [number, number, number], max: [T / 2, 2, 2] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(0);
  });

  it("origin offset of 0 still warns for the classic un-translated case", () => {
    // Sanity: the no-offset case must still produce its hint. Without this
    // guardrail we could silently regress Issue #1 while fixing the false
    // positive.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    d.sketchOnPlane("XZ").extrude(20);
    const finalBboxes = [
      { min: [-25, -20, -15] as [number, number, number], max: [25, 0, 15] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/Y ∈ \[-20, 0\]/);
  });

  it("Fix 4: any non-trivial origin offset is an opt-in signal — no hint emitted", () => {
    // Fix 4: passing a non-zero `origin` to `sketchOnPlane` is the user's
    // affirmative "I know where this slab will land" statement. The extrude
    // hint exists to catch the oblivious case where the user didn't realise
    // the plane's normal direction; once they offset the origin, firing the
    // advisory anyway is pure noise (the top signal-to-noise complaint from
    // the external-agent stress tests). The enqueue-side gate drops the
    // hint before it ever reaches the drain queue, regardless of whether
    // the shifted interval still overlaps the final bbox.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    d.sketchOnPlane("YZ", -20).extrude(20);
    const finalBboxes = [
      { min: [-20, -5, -5] as [number, number, number], max: [0, 5, 5] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(0);
  });

  it("opaque Plane-object origin drops the hint rather than lying", () => {
    // A non-number / non-tuple origin means the sketchOnPlane received a
    // Plane object whose origin we can't decode. validateSketchExtrude
    // should skip enqueueExtrudeHint entirely for "opaque" origins, so no
    // hint appears at drain time regardless of the final bbox.
    const exports: any = makeSketchExports();
    instrumentReplicadExports(exports);
    const d = new exports.Drawing();
    d.sketchOnPlane("XZ", { _opaque: true }).extrude(5);
    const finalBboxes = [
      { min: [-5, -5, -5] as [number, number, number], max: [5, 0, 5] as [number, number, number] },
    ];
    const msgs = drainExtrudeHints(finalBboxes);
    expect(msgs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BRepCheck → geometryValid pipeline (Bug #4)
// ---------------------------------------------------------------------------

describe("validate — geometry issue structure (Bug #4)", () => {
  it("hasGeometryErrors returns true when any issue has severity:error", async () => {
    const { hasGeometryErrors } = await import("./validate");
    expect(
      hasGeometryErrors([
        { part: "a", severity: "warning", reason: "check-threw", message: "x" },
      ]),
    ).toBe(false);
    expect(
      hasGeometryErrors([
        { part: "a", severity: "error", reason: "non-manifold", message: "x" },
      ]),
    ).toBe(true);
  });

  it("partsWithErrors collects only error-severity part names", async () => {
    const { partsWithErrors } = await import("./validate");
    const names = partsWithErrors([
      { part: "a", severity: "error", reason: "non-manifold", message: "x" },
      { part: "b", severity: "warning", reason: "check-threw", message: "y" },
      { part: "a", severity: "warning", reason: "check-threw", message: "z" },
    ]);
    expect([...names]).toEqual(["a"]);
  });
});

// ---------------------------------------------------------------------------
// assertSupportedSize — Bug #7 (Part B)
// ---------------------------------------------------------------------------

describe("assertSupportedSize", () => {
  it("throws a helpful error for unknown size with Supported list", async () => {
    const { assertSupportedSize } = await import("./stdlib/standards");
    const table: Record<string, unknown> = { M3: {}, M4: {}, M5: {} };
    expect(() => assertSupportedSize("M99", table, "socket-head")).toThrow(
      /Unknown metric size 'M99' for socket-head\. Supported: M3, M4, M5\./,
    );
  });

  it("throws for non-string input", async () => {
    const { assertSupportedSize } = await import("./stdlib/standards");
    const table: Record<string, unknown> = { M3: {}, M4: {} };
    expect(() => assertSupportedSize(42, table, "socket-head")).toThrow(
      /Unknown metric size '42' for socket-head/,
    );
  });

  it("passes silently for a known size", async () => {
    const { assertSupportedSize } = await import("./stdlib/standards");
    const table: Record<string, unknown> = { M3: {}, M4: {}, M5: {} };
    expect(() => assertSupportedSize("M4", table, "socket-head")).not.toThrow();
  });
});
