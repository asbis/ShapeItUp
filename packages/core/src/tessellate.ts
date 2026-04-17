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

export function tessellatePart(part: PartInput): TessellatedPart {
  const tolerance = chooseTolerance(part.shape);
  const meshData = part.shape.mesh({ tolerance, angularTolerance: 0.3 });

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
