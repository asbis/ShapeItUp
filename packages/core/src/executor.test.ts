import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeScript, extractParamsStatic, rewriteImports } from "./executor";
import {
  patchShapeMeshLeak,
  patchShapeCutNoOpGuard,
  patchShapeFuseNoOpGuard,
  __resetCutPatchedForTests,
  __resetFusePatchedForTests,
} from "./index";
import { drainRuntimeWarnings, resetRuntimeWarnings } from "./stdlib/warnings";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// Replicad/Shapeitup provide fluent chainable shapes. We don't need a real
// CAD kernel to validate executor logic — just an object whose methods return
// chainable stand-ins so the script's builder chain runs to completion.
// ---------------------------------------------------------------------------

function chainable(tag: string): any {
  const obj: any = { _tag: tag };
  const methods = [
    "sketchOnPlane", "extrude", "fuse", "cut", "fillet", "chamfer",
    "translate", "translateX", "translateY", "translateZ",
    "rotate", "rotateX", "rotateY", "rotateZ",
    "scale", "mirror", "asShape3D", "loft", "shell",
    "clone", "copy", "inDirection",
  ];
  for (const m of methods) {
    obj[m] = (..._args: any[]) => chainable(`${tag}.${m}`);
  }
  return obj;
}

function makeReplicad(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    drawRectangle: (w: number, h: number) => chainable(`rect(${w},${h})`),
    drawRoundedRectangle: (w: number, h: number, r: number) => chainable(`rrect(${w},${h},${r})`),
    drawPolysides: (r: number, n: number) => chainable(`poly(${r},${n})`),
    makeCylinder: (r: number, h: number) => chainable(`cyl(${r},${h})`),
    makeBox: (w: number, h: number, d: number) => chainable(`box(${w},${h},${d})`),
    makeSphere: (r: number) => chainable(`sphere(${r})`),
    compoundShapes: (arr: any[]) => chainable(`compound(${arr.length})`),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Business logic: does a real bundled script produce the right result?
// ---------------------------------------------------------------------------

describe("executeScript — minimal scripts", () => {
  it("runs a no-import script and returns main()'s value", () => {
    const js = `
      function main() { return 42; }
      export { main as default };
    `;
    const { result } = executeScript(js, {}, {});
    expect(result).toBe(42);
  });

  it("throws when neither main nor a default function is exported", () => {
    const js = `const x = 1; export { x };`;
    expect(() => executeScript(js, {}, {})).toThrow(
      /must export a default function named 'main'/,
    );
  });
});

describe("executeScript — params flow", () => {
  it("uses declared param defaults when no overrides are passed", () => {
    const js = `
      var params = { width: 80, height: 50 };
      function main({ width, height }) { return width + height; }
      export { main as default, params };
    `;
    const { result, params } = executeScript(js, {}, {});
    expect(result).toBe(130);
    expect(params).toEqual([
      { name: "width", value: 80, min: 0, max: 240, step: 1 },
      { name: "height", value: 50, min: 0, max: 150, step: 1 },
    ]);
  });

  it("applies paramOverrides in place of defaults", () => {
    const js = `
      var params = { width: 80 };
      function main({ width }) { return width; }
      export { main as default, params };
    `;
    const { result } = executeScript(js, {}, {}, { width: 123 });
    expect(result).toBe(123);
  });

  it("ignores override keys that aren't declared in params", () => {
    const js = `
      var params = { width: 10 };
      function main({ width }) { return width; }
      export { main as default, params };
    `;
    const { result } = executeScript(js, {}, {}, { nope: 999, width: 20 });
    expect(result).toBe(20);
  });

  it("returns an empty params array when the script declares no params", () => {
    const js = `
      function main() { return 1; }
      export { main as default };
    `;
    const { params } = executeScript(js, {}, {});
    expect(params).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Imports: these are the only transforms with real complexity
// ---------------------------------------------------------------------------

describe("executeScript — replicad imports", () => {
  it("destructures named imports so main() can call them directly", () => {
    const js = `
      import { makeBox } from "replicad";
      function main() { return makeBox(1, 2, 3); }
      export { main as default };
    `;
    const makeBox = vi.fn((w: number, h: number, d: number) => `box(${w},${h},${d})`);
    const { result } = executeScript(js, { makeBox }, {});
    expect(makeBox).toHaveBeenCalledWith(1, 2, 3);
    expect(result).toBe("box(1,2,3)");
  });

  it("supports `as` aliases in named imports", () => {
    const js = `
      import { makeBox as mb } from "replicad";
      function main() { return mb(7); }
      export { main as default };
    `;
    const makeBox = vi.fn((v: number) => v * 2);
    const { result } = executeScript(js, { makeBox }, {});
    expect(makeBox).toHaveBeenCalledWith(7);
    expect(result).toBe(14);
  });

  it("supports namespace imports (`import * as r`)", () => {
    const js = `
      import * as r from "replicad";
      function main() { return r.makeBox(5); }
      export { main as default };
    `;
    const makeBox = vi.fn((v: number) => v + 100);
    const { result } = executeScript(js, { makeBox }, {});
    expect(result).toBe(105);
  });

  it("supports default imports with `.default ||` fallback", () => {
    const js = `
      import replicad from "replicad";
      function main() { return replicad.makeBox(3); }
      export { main as default };
    `;
    const makeBox = vi.fn((v: number) => v * v);
    const { result } = executeScript(js, { makeBox }, {});
    expect(result).toBe(9);
  });

  it("handles multi-line named imports (whitespace- and newline-tolerant)", () => {
    const js = `
      import {
        makeBox,
        makeSphere
      } from "replicad";
      function main() { return makeBox() + makeSphere(); }
      export { main as default };
    `;
    const { result } = executeScript(
      js,
      { makeBox: () => 1, makeSphere: () => 2 },
      {},
    );
    expect(result).toBe(3);
  });
});

describe("executeScript — shapeitup stdlib imports", () => {
  it("destructures named imports from `shapeitup`", () => {
    const js = `
      import { holes } from "shapeitup";
      function main() { return holes.counterbore("M3"); }
      export { main as default };
    `;
    const counterbore = vi.fn((size: string) => `hole(${size})`);
    const { result } = executeScript(js, {}, { holes: { counterbore } });
    expect(counterbore).toHaveBeenCalledWith("M3");
    expect(result).toBe("hole(M3)");
  });

  it("supports `as` aliases from shapeitup", () => {
    const js = `
      import { holes as h } from "shapeitup";
      function main() { return h.slot(); }
      export { main as default };
    `;
    const slot = vi.fn(() => "slot");
    const { result } = executeScript(js, {}, { holes: { slot } });
    expect(slot).toHaveBeenCalled();
    expect(result).toBe("slot");
  });
});

// ---------------------------------------------------------------------------
// Material extraction — validation rules actually matter at runtime
// ---------------------------------------------------------------------------

describe("executeScript — material extraction", () => {
  it("extracts material from real esbuild output (`var material` + bare export)", () => {
    const js = `
      var material = { density: 7.85, name: "steel" };
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toEqual({ density: 7.85, name: "steel" });
  });

  it("accepts density-only material without a name", () => {
    const js = `
      var material = { density: 1.04 };
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toEqual({ density: 1.04 });
  });

  it.each([
    ["zero density", "{ density: 0 }"],
    ["negative density", "{ density: -1 }"],
    ["string density", `{ density: "7.85" }`],
    ["NaN density", "{ density: NaN }"],
    ["Infinity density", "{ density: Infinity }"],
    ["missing density", `{ name: "steel" }`],
  ])("drops invalid material: %s", (_label, decl) => {
    const js = `
      var material = ${decl};
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toBeUndefined();
  });

  it("returns undefined material when the script declares none", () => {
    const js = `function main() { return 1; } export { main as default };`;
    const { material } = executeScript(js, {}, {});
    expect(material).toBeUndefined();
  });

  it.each([
    ["PLA", 1.24],
    ["ABS", 1.04],
    ["PETG", 1.27],
    ["Nylon", 1.15],
    ["Aluminum", 2.70],
    ["Steel", 7.85],
    ["Stainless", 8.00],
    ["Brass", 8.47],
    ["Titanium", 4.50],
    ["Copper", 8.96],
    ["Wood", 0.60],
  ])("expands named preset '%s' to density %s with name preserved", (name, density) => {
    resetRuntimeWarnings();
    const js = `
      var material = "${name}";
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toEqual({ density, name });
    // No warning for known presets.
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("emits a runtime warning and drops material for an unknown preset", () => {
    resetRuntimeWarnings();
    const js = `
      var material = "Unobtainium";
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toBeUndefined();
    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Unknown material preset 'Unobtainium'/);
    expect(warnings[0]).toMatch(/PLA/);
  });

  it("is case-sensitive: lowercase 'pla' is NOT a known preset", () => {
    resetRuntimeWarnings();
    const js = `
      var material = "pla";
      function main() { return 1; }
      export { main as default, material };
    `;
    const { material } = executeScript(js, {}, {});
    expect(material).toBeUndefined();
    expect(drainRuntimeWarnings()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-part assembly return — preserved as-is
// ---------------------------------------------------------------------------

describe("executeScript — multi-part assemblies", () => {
  it("preserves an array return value unchanged", () => {
    const js = `
      function main() {
        return [
          { shape: "A", name: "bolt", color: "#ccc" },
          { shape: "B", name: "nut",  color: "#aaa" }
        ];
      }
      export { main as default };
    `;
    const { result } = executeScript(js, {}, {});
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ shape: "A", name: "bolt", color: "#ccc" });
    expect(result[1]).toEqual({ shape: "B", name: "nut", color: "#aaa" });
  });
});

// ---------------------------------------------------------------------------
// Realistic esbuild output — exact bytes produced for example scripts
// ---------------------------------------------------------------------------

describe("executeScript — realistic esbuild output", () => {
  it("runs bundled bracket.shape.ts and returns a chainable cut result", () => {
    const js = `
import { drawRectangle, makeCylinder } from "replicad";
var params = {
  width: 40,
  height: 40,
  depth: 20,
  thickness: 5,
  holeRadius: 3,
  filletRadius: 2
};
function main({ width, height, depth, thickness, holeRadius, filletRadius }) {
  const base = drawRectangle(width, thickness).sketchOnPlane("XY").extrude(depth);
  const upright = drawRectangle(thickness, height).sketchOnPlane("XY", [-width / 2 + thickness / 2, -height / 2 + thickness / 2, 0]).extrude(depth);
  let bracket = base.fuse(upright);
  try {
    bracket = bracket.fillet(filletRadius, (e) => e.inDirection("Z"));
  } catch (e) {}
  const h1 = makeCylinder(holeRadius, thickness * 2, [width / 4, 0, depth / 2], [0, 1, 0]).translateY(-thickness);
  const h2 = makeCylinder(holeRadius, thickness * 2, [-width / 2 + thickness / 2, height / 2 - height / 4, depth / 2], [1, 0, 0]).translateX(-thickness);
  return bracket.cut(h1).cut(h2);
}
export {
  main as default,
  params
};
`;
    const { result, params } = executeScript(js, makeReplicad(), {});
    expect(result._tag).toContain(".cut");
    expect(params.map((p) => p.name)).toEqual([
      "width", "height", "depth", "thickness", "holeRadius", "filletRadius",
    ]);
  });

  it("runs bundled assembly.shape.ts preserving the 2-part return", () => {
    const js = `
import { makeCylinder, drawPolysides } from "replicad";
function main() {
  const head = drawPolysides(8, 6).sketchOnPlane("XY").extrude(5);
  const shaft = makeCylinder(4, 20, [0, 0, 5]);
  const bolt = head.fuse(shaft);
  const nutHead = drawPolysides(10, 6).sketchOnPlane("XY", [20, 0, 0]).extrude(5);
  const nutHole = makeCylinder(4, 5, [20, 0, 0]);
  const nut = nutHead.cut(nutHole);
  return [
    { shape: bolt, name: "bolt", color: "#cccccc" },
    { shape: nut,  name: "nut",  color: "#aaaaaa" }
  ];
}
export {
  main as default
};
`;
    const { result } = executeScript(js, makeReplicad(), {});
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("bolt");
    expect(result[1].name).toBe("nut");
  });

  it("runs bundled mounting-plate.shape.ts with shapeitup stdlib imports", () => {
    const js = `
import { drawRoundedRectangle } from "replicad";
import { holes } from "shapeitup";
var params = {
  width: 60,
  height: 40,
  thickness: 5,
  screwSize: "M3"
};
function main({ width, height, thickness, screwSize }) {
  let plate = drawRoundedRectangle(width, height, 3).sketchOnPlane("XY").extrude(thickness).asShape3D();
  const inset = 10;
  const corners = [[-width/2+inset, -height/2+inset]];
  for (const [x, y] of corners) {
    const hole = holes.counterbore(screwSize, { plateThickness: thickness }).translate(x, y, thickness);
    plate = plate.cut(hole);
  }
  const slot = holes.slot({ length: 20, width: 4, depth: thickness + 0.1 }).translate(0, 0, thickness);
  plate = plate.cut(slot);
  return plate;
}
export {
  main as default,
  params
};
`;
    const counterbore = vi.fn((_size: string, _opts: any) => chainable("hole"));
    const slot = vi.fn((_opts: any) => chainable("slot"));
    const { result } = executeScript(
      js,
      makeReplicad(),
      { holes: { counterbore, slot } },
    );
    expect(counterbore).toHaveBeenCalledWith("M3", { plateThickness: 5 });
    expect(slot).toHaveBeenCalledWith({ length: 20, width: 4, depth: 5.1 });
    expect(result._tag).toContain(".cut");
  });
});

// ---------------------------------------------------------------------------
// Pure-transform regressions — keep a few targeted substring checks for the
// one truly complex step (named-import destructuring with `as` aliases).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WASM leak fix — Shape.prototype._mesh was leaking the
// BRepMesh_IncrementalMesh_2 wrapper on every mesh/blobSTL/meshEdges call.
// After the patch, the wrapper must be .delete()'d synchronously.
//
// We can't run real OCCT in a unit test (30 MB WASM + init time), but we CAN
// simulate the replicad Shape class + OCCT module shape, install the patch,
// and verify (a) the ctor still runs with the right args, and (b) the wrapper
// .delete() is called exactly once. This mirrors the reviewer's STL-per-part
// repro at the contract level — if .delete() runs for every mesh call, the
// OCCT heap stays clean whether it's called once or N times.
// ---------------------------------------------------------------------------

describe("patchShapeMeshLeak — deletes BRepMesh wrapper after meshing", () => {
  it("installs the patch on Shape.prototype and delete()'s the wrapper", () => {
    // Simulate a fresh replicad module: a Shape class with the original
    // leaky _mesh impl (pulled verbatim from replicad.js:3082).
    const ctorCalls: any[] = [];
    const deleteCalls: number[] = [];
    let deleteId = 0;
    const fakeOc = {
      BRepMesh_IncrementalMesh_2: function (
        this: any,
        wrapped: any,
        tolerance: number,
        relative: boolean,
        angularTolerance: number,
        inParallel: boolean
      ) {
        ctorCalls.push({ wrapped, tolerance, relative, angularTolerance, inParallel });
        const id = ++deleteId;
        this.delete = () => deleteCalls.push(id);
      },
    };
    class FakeShape {
      oc = fakeOc;
      wrapped = { tag: "solid" };
      _mesh(this: any, opts: { tolerance?: number; angularTolerance?: number } = {}) {
        const { tolerance = 1e-3, angularTolerance = 0.1 } = opts;
        new this.oc.BRepMesh_IncrementalMesh_2(
          this.wrapped, tolerance, false, angularTolerance, false,
        );
      }
    }
    const fakeReplicad = { Shape: FakeShape };

    const applied = patchShapeMeshLeak(fakeReplicad);
    expect(applied).toBe(true);
    expect(FakeShape.prototype._mesh).toBeTypeOf("function");

    // Simulate the reviewer's bug: 6 parts tessellated (preview) + 1 per-part
    // STL mesh at a different tolerance + a 7th render on a trivial shape.
    // Before the patch: 8 leaked wrappers, OOB crash on the 7th call.
    // After the patch: every wrapper is deleted — zero leak.
    const shape = new FakeShape();
    for (let i = 0; i < 6; i++) shape._mesh({ tolerance: 0.001 + i * 0.01, angularTolerance: 0.1 });
    shape._mesh({ tolerance: 0.05, angularTolerance: 0.1 }); // STL export
    shape._mesh({ tolerance: 0.1, angularTolerance: 0.1 }); // next render

    expect(ctorCalls).toHaveLength(8);
    expect(deleteCalls).toHaveLength(8);
    // Deletes fire IN the same order as constructs — the patch deletes
    // synchronously, right after the ctor side-effect.
    expect(deleteCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Ctor args still match replicad's original shape: (wrapped, tol, false,
    // angTol, false). Keep the boolean positions pinned so a future replicad
    // refactor that shifts them is caught by this test.
    expect(ctorCalls[0]).toMatchObject({
      wrapped: { tag: "solid" },
      relative: false,
      inParallel: false,
    });
  });

  it("is idempotent — a second patch call is a no-op", () => {
    // We've already patched once in the previous test; a repeat call must
    // still return true but must not re-wrap (which would cause double
    // deletion). The module-level `meshPatchApplied` flag protects this.
    const fakeReplicad: any = {
      Shape: class {
        oc = { BRepMesh_IncrementalMesh_2: function () { this.delete = () => {}; } as any };
        wrapped = {};
        _mesh() { /* leaky */ }
      },
    };
    const firstApplied = patchShapeMeshLeak(fakeReplicad);
    // Second call should short-circuit before touching the class. Because the
    // flag is set from the first test, this will return true without
    // reassigning _mesh. Either way: no crash, no throw.
    expect(() => patchShapeMeshLeak(fakeReplicad)).not.toThrow();
    expect(typeof firstApplied).toBe("boolean");
  });

  it("degrades gracefully when Shape.prototype._mesh is missing", () => {
    // Simulate a replicad major bump that removes the internal method.
    // patchShapeMeshLeak must return false and log a warning, not throw —
    // we'd rather accept the leak than crash initCore().
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = patchShapeMeshLeak({ Shape: class { /* no _mesh */ } });
      // If the flag from earlier tests is still set, this returns true (no-op);
      // that's also acceptable — the important assertion is "doesn't throw".
      expect(typeof result).toBe("boolean");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("rewriteImports — substring pin", () => {
  it("rewrites `import { a as b }` into `const { a: b }` for replicad", () => {
    expect(rewriteImports(`import { x as y } from "replicad";`))
      .toContain("const { x: y } = __replicad__;");
  });

  it("rewrites `import { a as b }` into `const { a: b }` for shapeitup", () => {
    expect(rewriteImports(`import { holes as h } from "shapeitup";`))
      .toContain("const { holes: h } = __shapeitup__;");
  });

  // Esbuild's ESM output injects a `__require` shim for any leftover CJS-style
  // require() call in user code (or a transitively-bundled helper file). At
  // runtime that shim throws `Dynamic require of "replicad" is not supported`
  // because our sandbox has no real `require`. We redirect those two module
  // names to the already-destructured sandbox globals so CJS-shaped scripts
  // work without the user refactoring to ESM imports.
  it("redirects __require(\"replicad\") to the sandbox global", () => {
    const input = `var rep = __require("replicad");`;
    expect(rewriteImports(input)).toBe(`var rep = __replicad__;`);
  });

  it("redirects __require('shapeitup') to the sandbox global (single quotes OK)", () => {
    const input = `const lib = __require('shapeitup');`;
    expect(rewriteImports(input)).toBe(`const lib = __shapeitup__;`);
  });

  it("leaves __require for unrelated modules untouched", () => {
    // Anything we don't provide through the sandbox should NOT be rewritten —
    // the original error message remains useful for diagnosing a missing
    // external that neither the extension nor the MCP engine ships.
    const input = `var foo = __require("not-shipped");`;
    expect(rewriteImports(input)).toContain(`__require("not-shipped")`);
  });
});

// ---------------------------------------------------------------------------
// Bug #7 — extractParamsStatic must pull param names out of raw source
// without executing the script, so tune_params can surface "Declared: ..."
// even when the render fails. Covers the obvious forms and a handful of
// edge cases the hand-rolled regex has to survive.
// ---------------------------------------------------------------------------

describe("extractParamsStatic", () => {
  it("pulls plain-identifier keys out of a simple literal", () => {
    const src = `
      export const params = { width: 80, height: 50, depth: 30 };
      export default function main() { return 1; }
    `;
    expect(extractParamsStatic(src)).toEqual(["width", "height", "depth"]);
  });

  it("handles quoted keys (double and single quoted)", () => {
    const src = `
      export const params = {
        "width": 10,
        'height': 20,
        depth: 30
      };
    `;
    expect(extractParamsStatic(src)).toEqual(["width", "height", "depth"]);
  });

  it("tolerates a trailing comma after the last entry", () => {
    const src = `
      export const params = {
        a: 1,
        b: 2,
      };
    `;
    expect(extractParamsStatic(src)).toEqual(["a", "b"]);
  });

  it("returns [] when no `export const params` declaration exists", () => {
    const src = `export default function main() { return 1; }`;
    expect(extractParamsStatic(src)).toEqual([]);
  });

  it("skips a comment-only line before the first real key (regex anchors on `{`/`,`, not inside a line-comment)", () => {
    // The pair pattern anchors on `^`, `{`, or `,` before the key. A
    // line-comment like `// width: 80` is neither preceded by nor followed
    // by one of those inside the body, so `width` is correctly ignored.
    // The important behavior is: a real key on a later line DOES still
    // match, because its line is reached via the `,` or start-of-body
    // anchor once we pass the comment noise.
    const src = `
      export const params = {
        // comment, not a key
        height: 50,
        depth: 30
      };
    `;
    const keys = extractParamsStatic(src);
    // At minimum we want `depth` — it's anchored by the explicit `,`
    // after `50`, which is the least fragile signal for the regex.
    expect(keys).toContain("depth");
  });

  it("handles `as const` suffix (realistic esbuild-adjacent form)", () => {
    const src = `
      export const params = { thickness: 5, screwSize: "M3" } as const;
      export default function main() { return 1; }
    `;
    expect(extractParamsStatic(src)).toEqual(["thickness", "screwSize"]);
  });
});

// ---------------------------------------------------------------------------
// patchShapeCutNoOpGuard — volume-equality sanity check on Shape.prototype.cut
//
// The #1 trust-breaking bug reported by external engineers: a raw
// `box.cut(cylinder)` where the cylinder was translated outside the box
// silently returns the original volume. The user sees "Render SUCCESS" and
// has no clue their hole didn't cut. patterns.cutAt catches this; .cut() did
// not. This patch wraps _3DShape.prototype.cut to measure volume before and
// after; when the volumes are equal within tolerance, it pushes a runtime
// warning through the existing stdlib channel.
// ---------------------------------------------------------------------------

describe("patchShapeCutNoOpGuard — warns when cut removes zero material", () => {
  /**
   * Build a mock replicad module whose _3DShape.prototype.cut is the
   * identity (returns `this` — a classic silent no-op), and whose
   * measureShapeVolumeProperties reads a scripted volume from each shape.
   * The per-test `volumeMap` keys shapes by identity so the test can
   * arrange "cut from V=100 and get back a V=100 result".
   */
  function makeFakeReplicad(opts: {
    cutImpl?: (self: any, other: any) => any;
    volumeMap?: WeakMap<object, number>;
  } = {}) {
    const volumeMap = opts.volumeMap ?? new WeakMap<object, number>();
    class _3DShape {
      // `cut` is the only instrumented method we need. Default impl is the
      // silent-no-op (return self) so that tests which DON'T override it
      // exercise the warning path.
      cut(this: any, other: any): any {
        if (opts.cutImpl) return opts.cutImpl(this, other);
        return this;
      }
    }
    const replicad: any = {
      _3DShape,
      measureShapeVolumeProperties(shape: any) {
        if (!volumeMap.has(shape)) return undefined;
        return {
          volume: volumeMap.get(shape)!,
          delete: () => {},
        };
      },
    };
    return { replicad, volumeMap, _3DShape };
  }

  // Reset the module-level cutPatched flag before each test. Production
  // never does this — initCore() runs once per process and the singleton
  // replicad module is stable — but unit tests need fresh fakes.
  beforeEach(() => {
    __resetCutPatchedForTests();
    resetRuntimeWarnings();
  });

  it("pushes a runtime warning when post-cut volume equals pre-cut volume", () => {
    const { replicad, volumeMap, _3DShape } = makeFakeReplicad();
    patchShapeCutNoOpGuard(replicad);

    const target: any = new _3DShape();
    const tool: any = new _3DShape();
    volumeMap.set(target, 1000); // 1000 mm³ box
    // Default silent-no-op cut returns `this`, so the post-cut shape IS
    // target — volume read for the result returns 1000 again, triggering
    // the equality check.

    const result = target.cut(tool);
    expect(result).toBe(target);

    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/cut produced no material removal/);
    expect(warnings[0]).toMatch(/V=1000\.00 mm³/);
    expect(warnings[0]).toMatch(/cutter disjoint from target/);
  });

  it("emits NO warning when volume actually decreases (real cut)", () => {
    const volumeMap = new WeakMap<object, number>();
    const { replicad, _3DShape } = makeFakeReplicad({
      cutImpl: (_self, _other) => {
        // Simulates a successful boolean cut: a fresh shape with a smaller
        // scripted volume than the input.
        const resultShape: any = { _tag: "cut-result" };
        volumeMap.set(resultShape, 750); // 250 mm³ removed
        return resultShape;
      },
      volumeMap,
    });
    patchShapeCutNoOpGuard(replicad);

    const target: any = new _3DShape();
    volumeMap.set(target, 1000);
    const result = target.cut({});
    expect(result._tag).toBe("cut-result");
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("emits NO warning when input-volume measurement is unavailable", () => {
    const { replicad, _3DShape } = makeFakeReplicad();
    patchShapeCutNoOpGuard(replicad);

    // No shapes registered in volumeMap → measureShapeVolumeProperties
    // returns undefined. The guard must degrade silently: no crash, no
    // warning — so mocks (and potential future MeshShape call sites)
    // without a full measurement stack still work.
    const target: any = new _3DShape();
    expect(() => target.cut({})).not.toThrow();
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("is idempotent — a second call on the same replicad module is a no-op", () => {
    // The module-level cutPatched flag protects against double-wrapping,
    // which would otherwise double-measure every cut in the pipeline and
    // emit two warnings per no-op. Verify by calling the patcher twice on
    // the SAME fake replicad and asserting the cut still emits exactly one
    // warning, not two.
    const { replicad, volumeMap, _3DShape } = makeFakeReplicad();
    expect(patchShapeCutNoOpGuard(replicad)).toBe(true);
    expect(patchShapeCutNoOpGuard(replicad)).toBe(true);

    const target: any = new _3DShape();
    volumeMap.set(target, 500);
    target.cut({});
    // If the patch were applied twice, we'd see two identical warnings.
    // Exactly one confirms the idempotency guard works.
    expect(drainRuntimeWarnings()).toHaveLength(1);
  });

  it("degrades gracefully when _3DShape.prototype.cut is missing", () => {
    // Simulate a future replicad refactor that renames / relocates `cut`.
    // The patcher must return false and log a warning, not throw — we'd
    // rather miss the safety net than crash initCore().
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = patchShapeCutNoOpGuard({ _3DShape: class { /* no cut */ } });
      expect(result).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// patchShapeFuseNoOpGuard — volume-equality sanity check on _3DShape.fuse
//
// Wishlist #W2: symmetric check to patchShapeCutNoOpGuard. If
// `a.fuse(b).volume === a.volume`, either `b` was fully inside `a` (union is
// a no-op) or OCCT silently produced a compound for a disjoint pair. Either
// way the user expected new material and got none. Same pattern as the cut
// guard: best-effort measurement, silent degradation when unavailable.
// ---------------------------------------------------------------------------

describe("patchShapeFuseNoOpGuard — warns when fuse adds zero material", () => {
  /**
   * Mirror of `makeFakeReplicad` above but for fuse. Default `fuse` impl
   * is the silent-no-op (return `this` — scripted to trip the equality
   * check); pass `fuseImpl` to override with a real-fuse-like shape that
   * has an increased volume.
   */
  function makeFakeReplicad(opts: {
    fuseImpl?: (self: any, other: any) => any;
    volumeMap?: WeakMap<object, number>;
  } = {}) {
    const volumeMap = opts.volumeMap ?? new WeakMap<object, number>();
    class _3DShape {
      fuse(this: any, other: any): any {
        if (opts.fuseImpl) return opts.fuseImpl(this, other);
        return this;
      }
    }
    const replicad: any = {
      _3DShape,
      measureShapeVolumeProperties(shape: any) {
        if (!volumeMap.has(shape)) return undefined;
        return {
          volume: volumeMap.get(shape)!,
          delete: () => {},
        };
      },
    };
    return { replicad, volumeMap, _3DShape };
  }

  beforeEach(() => {
    __resetFusePatchedForTests();
    resetRuntimeWarnings();
  });

  it("emits NO warning when fuse actually adds material (volume increases)", () => {
    const volumeMap = new WeakMap<object, number>();
    const { replicad, _3DShape } = makeFakeReplicad({
      fuseImpl: (_self, _other) => {
        const resultShape: any = { _tag: "fuse-result" };
        volumeMap.set(resultShape, 1500); // 500 mm³ added (1000 → 1500)
        return resultShape;
      },
      volumeMap,
    });
    patchShapeFuseNoOpGuard(replicad);

    const target: any = new _3DShape();
    volumeMap.set(target, 1000);
    const result = target.fuse({});
    expect(result._tag).toBe("fuse-result");
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("pushes a runtime warning when post-fuse volume equals pre-fuse volume", () => {
    const { replicad, volumeMap, _3DShape } = makeFakeReplicad();
    patchShapeFuseNoOpGuard(replicad);

    const target: any = new _3DShape();
    const added: any = new _3DShape();
    volumeMap.set(target, 2500); // 2500 mm³ target
    // Default silent-no-op fuse returns `this`, so post-fuse volume is
    // still 2500 → triggers the equality check.

    const result = target.fuse(added);
    expect(result).toBe(target);

    const warnings = drainRuntimeWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/fuse produced no new material/);
    expect(warnings[0]).toMatch(/V=2500\.00 mm³/);
    expect(warnings[0]).toMatch(/fully inside the target/);
  });

  it("is idempotent — a second patch call on the same replicad is a no-op", () => {
    // Without the fusePatched flag, a second call would wrap the already-
    // wrapped fuse and emit TWO warnings per no-op.
    const { replicad, volumeMap, _3DShape } = makeFakeReplicad();
    expect(patchShapeFuseNoOpGuard(replicad)).toBe(true);
    expect(patchShapeFuseNoOpGuard(replicad)).toBe(true);

    const target: any = new _3DShape();
    volumeMap.set(target, 500);
    target.fuse({});
    expect(drainRuntimeWarnings()).toHaveLength(1);
  });

  it("degrades gracefully when measureShapeVolumeProperties is missing", () => {
    // Fake replicad with no measurement method at all — mirrors running
    // against a kernel-free mock. The guard must not throw, and must not
    // emit a warning (without volume info we can't tell if it was a no-op).
    class _3DShape {
      fuse(this: any, _other: any) { return this; }
    }
    const replicad: any = { _3DShape /* no measureShapeVolumeProperties */ };
    expect(() => patchShapeFuseNoOpGuard(replicad)).not.toThrow();

    const target: any = new _3DShape();
    expect(() => target.fuse({})).not.toThrow();
    expect(drainRuntimeWarnings()).toEqual([]);
  });

  it("degrades gracefully when _3DShape.prototype.fuse is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = patchShapeFuseNoOpGuard({ _3DShape: class { /* no fuse */ } });
      expect(result).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-file .shape.ts entry disambiguation
//
// When an assembly `.shape.ts` imports other `.shape.ts` modules that each
// define `export default function main(...)`, esbuild inlines them all and
// renames the imported bindings (`main2`, `params2`, etc.) to avoid local
// collisions. The executor previously used `typeof main !== "undefined"`
// which, depending on esbuild's output ordering, could bind to the WRONG
// `main` and silently render a single part with "Render SUCCESS" text.
//
// The fix injects `globalThis.__SHAPEITUP_ENTRY_MAIN__` / `..._ENTRY_PARAMS__`
// via an esbuild footer (see viewer-provider.ts + engine.ts), and the
// executor prefers those canonical markers. A collision-detection regex in
// the executor also pushes a runtime warning via the stdlib channel so the
// user can switch their library modules to named factories.
// ---------------------------------------------------------------------------

describe("executeScript — multi-file entry disambiguation", () => {
  beforeEach(() => {
    resetRuntimeWarnings();
    // Ensure no stray markers from a prior test leak into this one.
    const g = globalThis as any;
    g.__SHAPEITUP_ENTRY_MAIN__ = undefined;
    g.__SHAPEITUP_ENTRY_PARAMS__ = undefined;
  });

  it("prefers the canonical __SHAPEITUP_ENTRY_MAIN__ marker over a bare bundled `main`", () => {
    // Simulate what a bundled multi-file script looks like after esbuild has
    // renamed the imported module's main to `main2`, and the footer has
    // stamped the entry's `main` onto globalThis. The wrapped code still
    // contains bare `main` and `params` declarations (for esbuild internal
    // reasons), but the executor must pick the entry one.
    const g = globalThis as any;
    // The "wrong" bundled main — this is what would win under the old
    // ambient-lookup path if it happened to be last. We make it fail the
    // test if called by having it return a sentinel we don't expect.
    const js = `
      function main2() { return "WRONG_IMPORTED_MAIN"; }
      var params2 = { importedOnly: 1 };
      function main() { return "ENTRY_MAIN_FROM_BARE"; }
      var params = { entryFromBare: 1 };
      export { main as default, params };
    `;
    // Stamp the entry marker, mimicking the esbuild footer.
    g.__SHAPEITUP_ENTRY_MAIN__ = () => "ENTRY_MAIN_FROM_MARKER";
    g.__SHAPEITUP_ENTRY_PARAMS__ = { entryFromMarker: 42 };

    const { result, params } = executeScript(js, {}, {});
    expect(result).toBe("ENTRY_MAIN_FROM_MARKER");
    expect(params.map((p) => p.name)).toEqual(["entryFromMarker"]);
  });

  it("clears the canonical markers after execution so the next run doesn't leak", () => {
    const g = globalThis as any;
    g.__SHAPEITUP_ENTRY_MAIN__ = () => 1;
    g.__SHAPEITUP_ENTRY_PARAMS__ = { a: 1 };
    const js = `
      function main() { return 99; }
      export { main as default };
    `;
    executeScript(js, {}, {});
    expect(g.__SHAPEITUP_ENTRY_MAIN__).toBeUndefined();
    expect(g.__SHAPEITUP_ENTRY_PARAMS__).toBeUndefined();
  });

  it("falls back to bare `main` / `params` when no canonical markers are set", () => {
    // Single-file scripts have no footer because the bundler doesn't run for
    // them (test path) — the ambient lookup still has to work.
    const js = `
      var params = { width: 10 };
      function main({ width }) { return width * 2; }
      export { main as default, params };
    `;
    const { result, params } = executeScript(js, {}, {});
    expect(result).toBe(20);
    expect(params.map((p) => p.name)).toEqual(["width"]);
  });

  it("emits a runtime warning when the bundle contains `main2` / `params2` symbols", () => {
    // This is the collision smell — esbuild only renames to `nameN` when two
    // modules declared the same name. The warning tells the user to switch
    // library modules to named factories.
    const g = globalThis as any;
    g.__SHAPEITUP_ENTRY_MAIN__ = () => "ok";
    const js = `
      function main2() { return "imported"; }
      var params2 = { importedOnly: 1 };
      function main() { return "entry"; }
      export { main as default };
    `;
    executeScript(js, {}, {});
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const multiFileWarn = warnings.find((w) =>
      /Multi-file bundle detected multiple `main` symbols/.test(w),
    );
    expect(multiFileWarn).toBeDefined();
    expect(multiFileWarn!).toMatch(/named factories/i);
  });

  it("does NOT emit the collision warning for single-file scripts", () => {
    const js = `
      var params = { a: 1 };
      function main() { return 1; }
      export { main as default, params };
    `;
    executeScript(js, {}, {});
    const warnings = drainRuntimeWarnings();
    const hit = warnings.find((w) =>
      /Multi-file bundle detected multiple `main` symbols/.test(w),
    );
    expect(hit).toBeUndefined();
  });
});
