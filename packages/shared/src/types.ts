export interface ShapeMesh {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
}

export interface EdgeMesh {
  vertices: Float32Array;
}

export type ExportFormat = "step" | "stl";
