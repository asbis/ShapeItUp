/**
 * Tessellate one or more Replicad shapes into flat arrays for Three.js.
 */

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
}

/**
 * Normalize the result from main() into a consistent array of PartInputs.
 * Supports:
 *   - Single shape
 *   - Array of shapes
 *   - Array of { shape, name?, color? }
 */
export function normalizeParts(result: any): PartInput[] {
  if (!result) throw new Error("Script returned nothing");

  // Single shape
  if (!Array.isArray(result)) {
    if (typeof result.mesh !== "function") {
      throw new Error("Script must return a Shape3D (with .mesh() method)");
    }
    return [{ shape: result, name: "shape", color: null }];
  }

  // Array
  return result.map((item: any, i: number) => {
    // { shape, name?, color? } object
    if (item && item.shape && typeof item.shape.mesh === "function") {
      return {
        shape: item.shape,
        name: item.name || `part-${i + 1}`,
        color: item.color || null,
      };
    }
    // Plain shape
    if (item && typeof item.mesh === "function") {
      return { shape: item, name: `part-${i + 1}`, color: null };
    }
    throw new Error(`Item ${i} is not a valid Shape3D`);
  });
}

export function tessellatePart(part: PartInput): TessellatedPart {
  const meshData = part.shape.mesh({ tolerance: 0.1, angularTolerance: 0.3 });

  const vertices = new Float32Array(meshData.vertices);
  const normals = new Float32Array(meshData.normals);
  const triangles = new Uint32Array(meshData.triangles);

  let edgeVertices: Float32Array;
  try {
    const edgeData = part.shape.meshEdges({ tolerance: 0.1 });
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
