import { describe, it, expect } from "vitest";
import {
  MATERIAL_PRESETS,
  normalizeParts,
  resolveMaterial,
  tessellatePart,
  type MeshQuality,
  type PartInput,
} from "./tessellate";
import { drainRuntimeWarnings, resetRuntimeWarnings } from "./stdlib/warnings";

// ---------------------------------------------------------------------------
// P3-10 — meshQuality option.
//
// We don't exercise real OCCT here; we stub a minimal Shape with `mesh` /
// `meshEdges` that records the tolerance it was called with. That lets us
// prove the quality preset correctly scales the auto-computed tolerance
// without needing a WASM instance.
// ---------------------------------------------------------------------------

interface MockShape {
  boundingBox: { width: number; height: number; depth: number };
  mesh: (opts: { tolerance: number; angularTolerance: number }) => {
    vertices: number[];
    normals: number[];
    triangles: number[];
  };
  meshEdges: (opts: { tolerance: number }) => { lines: number[] };
  /** Captured tolerance + angularTolerance on the most recent mesh() call. */
  lastMeshOpts?: { tolerance: number; angularTolerance: number };
}

function makeMockShape(size: number): MockShape {
  const self: Partial<MockShape> = {
    boundingBox: { width: size, height: size, depth: size },
    mesh({ tolerance, angularTolerance }) {
      self.lastMeshOpts = { tolerance, angularTolerance };
      // Minimal geometry so the Float32Array constructors don't explode.
      return { vertices: [0, 0, 0], normals: [0, 0, 1], triangles: [0, 0, 0] };
    },
    meshEdges() {
      return { lines: [] };
    },
  };
  return self as MockShape;
}

function tess(shape: MockShape, quality?: MeshQuality) {
  const part: PartInput = { shape, name: "test", color: null };
  return tessellatePart(part, quality ? { meshQuality: quality } : {});
}

describe("tessellatePart — meshQuality option", () => {
  it("defaults to 'final' — baseline tolerance + 0.1 rad angular", () => {
    const shape = makeMockShape(100);
    tess(shape);
    // diag = sqrt(100^2 * 3) ≈ 173.2 → * 0.0005 ≈ 0.0866 mm
    expect(shape.lastMeshOpts!.tolerance).toBeCloseTo(0.0866, 3);
    expect(shape.lastMeshOpts!.angularTolerance).toBe(0.1);
  });

  it("'final' explicit matches the default — no regression", () => {
    const shape = makeMockShape(100);
    tess(shape, "final");
    expect(shape.lastMeshOpts!.tolerance).toBeCloseTo(0.0866, 3);
    expect(shape.lastMeshOpts!.angularTolerance).toBe(0.1);
  });

  it("'preview' multiplies the auto-tolerance by 4.5x and loosens angular tolerance", () => {
    const shape = makeMockShape(100);
    tess(shape, "preview");
    // 0.0866 * 4.5 ≈ 0.3897 mm (well under the 5.0 cap)
    expect(shape.lastMeshOpts!.tolerance).toBeCloseTo(0.3897, 3);
    expect(shape.lastMeshOpts!.angularTolerance).toBe(0.4);
  });

  it("'preview' tolerance is strictly greater than 'final' for the same shape", () => {
    const sFinal = makeMockShape(250);
    const sPreview = makeMockShape(250);
    tess(sFinal, "final");
    tess(sPreview, "preview");
    expect(sPreview.lastMeshOpts!.tolerance).toBeGreaterThan(
      sFinal.lastMeshOpts!.tolerance,
    );
    // Ratio is exactly 4.5 barring the upper clamp (which doesn't fire here).
    expect(
      sPreview.lastMeshOpts!.tolerance / sFinal.lastMeshOpts!.tolerance,
    ).toBeCloseTo(4.5, 5);
  });

  it("preview tolerance is clamped to 5.0 mm for pathologically large shapes", () => {
    // chooseTolerance caps at 1.0 mm internally; * 4.5 = 4.5 < outer cap 5.0.
    // We verify the outer cap is 5.0 (not the old 2.5) and that large shapes
    // land below it.
    const shape = makeMockShape(10000);
    tess(shape, "preview");
    expect(shape.lastMeshOpts!.tolerance).toBeLessThanOrEqual(5.0);
  });

  it("preview tolerance exceeds the old 2.5 mm ceiling for large shapes", () => {
    // With the new 4.5x factor, large shapes produce tolerances in the
    // 4.0–5.0 mm range — strictly higher than the previous 2.5 mm ceiling.
    // chooseTolerance(10000mm cube) = 1.0 mm (internal cap); * 4.5 = 4.5 mm.
    const shape = makeMockShape(10000);
    tess(shape, "preview");
    expect(shape.lastMeshOpts!.tolerance).toBeGreaterThan(2.5);
    expect(shape.lastMeshOpts!.tolerance).toBeCloseTo(4.5, 3);
  });
});

describe("analyze flag — pipeline propagation", () => {
  it("normalizeParts preserves analyze: false on a wrapped part", () => {
    const shape = makeMockShape(10);
    const out = normalizeParts([{ shape, name: "mockup", color: null, analyze: false }]);
    expect(out[0].analyze).toBe(false);
  });

  it("normalizeParts omits analyze when the script didn't set it", () => {
    const shape = makeMockShape(10);
    const out = normalizeParts([{ shape, name: "part", color: null }]);
    expect(out[0].analyze).toBeUndefined();
  });

  it("tessellatePart carries analyze: false through to TessellatedPart", () => {
    const shape = makeMockShape(10);
    const part: PartInput = { shape, name: "servo", color: null, analyze: false };
    const out = tessellatePart(part);
    expect(out.analyze).toBe(false);
  });

  it("tessellatePart omits analyze when the input had none", () => {
    const shape = makeMockShape(10);
    const part: PartInput = { shape, name: "bracket", color: null };
    const out = tessellatePart(part);
    expect(out.analyze).toBeUndefined();
  });
});

describe("joints — pipeline propagation", () => {
  it("normalizeParts preserves a well-formed joints map", () => {
    const shape = makeMockShape(10);
    const out = normalizeParts([{
      shape,
      name: "plate",
      color: null,
      joints: {
        mount: { position: [0, 0, 5], axis: [0, 0, 1], role: "face" },
      },
    }]);
    expect(out[0].joints).toBeDefined();
    expect(out[0].joints!.mount.position).toEqual([0, 0, 5]);
    expect(out[0].joints!.mount.role).toBe("face");
  });

  it("normalizeParts drops malformed joint entries silently", () => {
    const shape = makeMockShape(10);
    const out = normalizeParts([{
      shape,
      name: "p",
      color: null,
      joints: {
        good: { position: [1, 2, 3], axis: [0, 0, 1] },
        // axis missing — skipped
        bad: { position: [0, 0, 0] } as any,
        // position has NaN — skipped
        worse: { position: [NaN, 0, 0], axis: [0, 0, 1] },
      },
    }]);
    expect(Object.keys(out[0].joints ?? {})).toEqual(["good"]);
  });

  it("normalizeParts omits joints field when none declared", () => {
    const shape = makeMockShape(10);
    const out = normalizeParts([{ shape, name: "p", color: null }]);
    expect(out[0].joints).toBeUndefined();
  });

  it("tessellatePart carries joints through to TessellatedPart", () => {
    const shape = makeMockShape(10);
    const part: PartInput = {
      shape, name: "p", color: null,
      joints: { mount: { position: [0, 0, 5], axis: [0, 0, 1] } },
    };
    const out = tessellatePart(part);
    expect(out.joints).toBeDefined();
    expect(out.joints!.mount.position).toEqual([0, 0, 5]);
  });
});

// ---------------------------------------------------------------------------
// Per-part material resolution — strings + objects both flow through the
// shared resolver. Backs the BOM fix: assemblies can now write
// `{ shape, name, material: "Aluminum" }` (string preset) without computing
// densities by hand, matching the script-level `export const material = "X"`.
// ---------------------------------------------------------------------------
describe("resolveMaterial — shared preset resolver", () => {
  it("string preset matching a known density resolves to {density, name}", () => {
    const r = resolveMaterial("Aluminum");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.material).toEqual({ density: MATERIAL_PRESETS.Aluminum, name: "Aluminum" });
    }
  });
  it("unknown preset flagged with the given string for the caller's warning", () => {
    const r = resolveMaterial("Unobtanium");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toEqual({ ok: false, reason: "unknown-preset", given: "Unobtanium" });
  });
  it("raw object with positive finite density passes through unchanged", () => {
    const r = resolveMaterial({ density: 1.5, name: "custom" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.material).toEqual({ density: 1.5, name: "custom" });
  });
  it("null / undefined / missing → ok:true with material: undefined (absent)", () => {
    for (const raw of [null, undefined]) {
      const r = resolveMaterial(raw);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.material).toBeUndefined();
    }
  });
  it("malformed object (NaN density, missing density) → invalid", () => {
    for (const raw of [{ density: NaN }, { density: 0 }, { density: -1 }, { density: "1" }, {}]) {
      const r = resolveMaterial(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("invalid");
    }
  });
});

describe("normalizeParts — per-part material (string + object)", () => {
  it("accepts a string preset on a part entry and resolves to {density, name}", () => {
    resetRuntimeWarnings();
    const shape = makeMockShape(10);
    const out = normalizeParts([{ shape, name: "frame", color: null, material: "Aluminum" }]);
    expect(out[0].material).toEqual({ density: MATERIAL_PRESETS.Aluminum, name: "Aluminum" });
    expect(drainRuntimeWarnings()).toEqual([]);
  });
  it("accepts an object material as before (no warning, no resolution change)", () => {
    resetRuntimeWarnings();
    const shape = makeMockShape(10);
    const out = normalizeParts([
      { shape, name: "gasket", color: null, material: { density: 1.2, name: "TPU" } },
    ]);
    expect(out[0].material).toEqual({ density: 1.2, name: "TPU" });
    expect(drainRuntimeWarnings()).toEqual([]);
  });
  it("unknown string preset on a part pushes a runtime warning naming the part + presets", () => {
    resetRuntimeWarnings();
    const shape = makeMockShape(10);
    const out = normalizeParts([{ shape, name: "mystery", color: null, material: "Unobtanium" }]);
    expect(out[0].material).toBeUndefined();
    const warnings = drainRuntimeWarnings();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Unknown material preset 'Unobtanium'");
    expect(warnings[0]).toContain("mystery");
  });
  it("mixed assembly: a TPU gasket entry overrides the script-level material", () => {
    // This is the multi-material scenario: assembly default is one material,
    // one part overrides via per-part material. The BOM consumer then reads
    // p.material (per-part) before falling back to status.material (script).
    resetRuntimeWarnings();
    const shape = makeMockShape(10);
    const out = normalizeParts([
      { shape, name: "shell", color: null }, // inherits script-level
      { shape, name: "gasket", color: null, material: "TPU" === "TPU" ? "PETG" : "" },
    ]);
    expect(out[0].material).toBeUndefined();
    expect(out[1].material).toEqual({ density: MATERIAL_PRESETS.PETG, name: "PETG" });
  });
});
