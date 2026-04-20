import { describe, it, expect } from "vitest";
import { tessellatePart, type MeshQuality, type PartInput } from "./tessellate";

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

  it("'preview' multiplies the auto-tolerance by 2.5x and loosens angular tolerance", () => {
    const shape = makeMockShape(100);
    tess(shape, "preview");
    // 0.0866 * 2.5 ≈ 0.2165 mm
    expect(shape.lastMeshOpts!.tolerance).toBeCloseTo(0.2165, 3);
    expect(shape.lastMeshOpts!.angularTolerance).toBe(0.25);
  });

  it("'preview' tolerance is strictly greater than 'final' for the same shape", () => {
    const sFinal = makeMockShape(250);
    const sPreview = makeMockShape(250);
    tess(sFinal, "final");
    tess(sPreview, "preview");
    expect(sPreview.lastMeshOpts!.tolerance).toBeGreaterThan(
      sFinal.lastMeshOpts!.tolerance,
    );
    // Ratio is exactly 2.5 barring the upper clamp (which doesn't fire here).
    expect(
      sPreview.lastMeshOpts!.tolerance / sFinal.lastMeshOpts!.tolerance,
    ).toBeCloseTo(2.5, 5);
  });

  it("preview tolerance is clamped to 2.5 mm for pathologically large shapes", () => {
    // A 10 m cube (10000 mm) — diag * 0.0005 * 2.5 would blow past the cap.
    const shape = makeMockShape(10000);
    tess(shape, "preview");
    // Auto-tolerance clamps chooseTolerance at 1.0 internally; * 2.5 = 2.5.
    expect(shape.lastMeshOpts!.tolerance).toBeLessThanOrEqual(2.5);
  });
});
