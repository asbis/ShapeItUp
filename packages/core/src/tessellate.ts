export interface PartInput {
  shape: any;
  name: string;
  color: string | null;
}

export interface TessellatedPart {
  name: string;
  color: string | null;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edgeVertices: Float32Array;
  volume?: number;
  surfaceArea?: number;
  centerOfMass?: [number, number, number];
  /**
   * Derived mass in grams. Only populated when the script exports a
   * `material` with a positive `density` (g/cm³). Computed as
   * `density * volume / 1000` to convert mm³ → cm³.
   */
  mass?: number;
}

export function normalizeParts(result: any): PartInput[] {
  if (!result) throw new Error("Script returned nothing");

  if (!Array.isArray(result)) {
    // Sugar: allow returning a single {shape, name, color} object without
    // wrapping it in an array. Reuse the array branch by wrapping it.
    if (result && result.shape && typeof result.shape.mesh === "function") {
      return normalizeParts([result]);
    }
    if (typeof result.mesh === "function") {
      return [{ shape: result, name: "shape", color: null }];
    }
    const keys =
      typeof result === "object" ? ` Keys: [${Object.keys(result).join(", ")}]` : "";
    throw new Error(
      `main() must return one of: (a) a Shape3D, (b) a {shape, name, color} object, (c) an array of either. Got: ${typeof result}.${keys}`,
    );
  }

  return result.map((item: any, i: number) => {
    if (item && item.shape && typeof item.shape.mesh === "function") {
      return {
        shape: item.shape,
        name: item.name || `part-${i + 1}`,
        color: item.color || null,
      };
    }
    if (item && typeof item.mesh === "function") {
      return { shape: item, name: `part-${i + 1}`, color: null };
    }
    throw new Error(`Item ${i} is not a valid Shape3D`);
  });
}

/**
 * Pick a tessellation tolerance from the shape's bounding-box diagonal. A
 * fixed 0.1 mm tolerance makes 2 mm parts look faceted and makes 2 m parts
 * waste millions of triangles. Scaling by the diagonal keeps surface
 * smoothness roughly constant to the eye regardless of part size.
 *
 * Factor 0.0005 ≈ 0.05% of diagonal — e.g. a 100 mm diagonal yields 0.05 mm
 * tolerance (smoother than the old default), a 2 m diagonal yields 1 mm (far
 * coarser, fewer triangles). Clamped to [0.005, 1.0] so pathological inputs
 * (zero-size or astronomically large shapes) stay in a sensible range.
 */
function chooseTolerance(shape: any): number {
  try {
    const bb = shape.boundingBox;
    if (bb) {
      const w = bb.width ?? 0;
      const h = bb.height ?? 0;
      const d = bb.depth ?? 0;
      const diag = Math.sqrt(w * w + h * h + d * d);
      if (diag > 0) return Math.max(0.005, Math.min(1.0, diag * 0.0005));
    }
  } catch {}
  return 0.1;
}

/** Tessellation-quality preset. */
export type MeshQuality = "preview" | "final";

/**
 * How much per-part measurement work to do on the tessellation hot path.
 *
 * `"none"` — skip both `measureShapeVolumeProperties` and
 * `measureShapeSurfaceProperties`; omit volume / surfaceArea / centerOfMass
 * from the emitted part. Cheapest; use when the caller only needs geometry
 * for rendering.
 *
 * `"bbox"` (default) — still skip the two OCCT measurement calls, but derive
 * a centerOfMass from the shape's bounding-box centre so assemblies get a
 * usable aggregate CoM without paying the ~200 ms/part B-Rep cost. volume /
 * surfaceArea stay omitted.
 *
 * `"full"` — pre-partStats behaviour: call both measurement functions and
 * populate volume / surfaceArea / centerOfMass (plus mass if a material is
 * declared). Slowest; issue #6 measured ~2.5 s on a 14-part assembly.
 */
export type PartStatsLevel = "none" | "bbox" | "full";

/**
 * Per-quality multipliers applied to the auto-computed tolerance. `final`
 * is the baseline (1× — behaviour unchanged from before the quality knob
 * existed). `preview` multiplies by 2.5× — enough to cut triangle counts
 * by roughly an order of magnitude on complex shapes (meshing cost scales
 * inversely with tolerance²), while still looking reasonable on-screen for
 * assemblies with a lot of threaded / lofted geometry. Also loosens the
 * angular tolerance so helical surfaces don't pin runtime.
 */
const QUALITY_FACTOR: Record<MeshQuality, { linear: number; angular: number }> = {
  final: { linear: 1, angular: 0.1 },
  preview: { linear: 2.5, angular: 0.25 },
};

export interface TessellateOptions {
  /**
   * Mesh quality preset. `"final"` (default) preserves the pre-existing
   * tolerance behaviour. `"preview"` scales the tolerance ~2.5× (roughly
   * 10× faster tessellation on complex geometry, at the cost of visibly
   * coarser facets). Auto-degrading to preview for large assemblies is the
   * caller's policy decision — tessellatePart itself is neutral.
   */
  meshQuality?: MeshQuality;
  /**
   * How much per-part measurement work core should do AFTER tessellation.
   * See {@link PartStatsLevel} for the full semantics. Consumed by the
   * orchestration loop in `packages/core/src/index.ts`, not by
   * `tessellatePart` itself (which never calls measureShape*Properties) —
   * co-located here so callers configure all tess-time policy in one place.
   * Default is `"bbox"` (issue #6: skip 2.5 s of B-Rep measurement on a
   * 14-part assembly; derive CoM from the AABB centre instead).
   */
  partStats?: PartStatsLevel;
}

export function tessellatePart(part: PartInput, opts: TessellateOptions = {}): TessellatedPart {
  const quality: MeshQuality = opts.meshQuality ?? "final";
  const factor = QUALITY_FACTOR[quality] ?? QUALITY_FACTOR.final;
  // Apply the preset's linear multiplier to the auto-computed tolerance.
  // Clamp upper bound so pathologically-large shapes on `preview` don't
  // produce nearly-zero-triangle meshes that break the viewer.
  const tolerance = Math.min(2.5, chooseTolerance(part.shape) * factor.linear);
  // angularTolerance (radians) caps the angle between consecutive facet normals.
  // 0.1 rad ≈ 5.7° matches replicad's default and is tight enough that helical
  // surfaces (threads) tessellate smoothly. 0.3 rad — OCCT's coarse end —
  // produced visibly faceted threads on M3–M8.
  const meshData = part.shape.mesh({ tolerance, angularTolerance: factor.angular });

  const vertices = new Float32Array(meshData.vertices);
  const normals = new Float32Array(meshData.normals);
  const triangles = new Uint32Array(meshData.triangles);

  let edgeVertices: Float32Array;
  try {
    const edgeData = part.shape.meshEdges({ tolerance });
    edgeVertices = new Float32Array(edgeData.lines);
  } catch {
    edgeVertices = new Float32Array(0);
  }

  return {
    name: part.name,
    color: part.color,
    vertices,
    normals,
    triangles,
    edgeVertices,
  };
}
