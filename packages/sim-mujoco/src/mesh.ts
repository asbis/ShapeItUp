/**
 * Per-body geometry handed to the engine. Identical shape to
 * `@shapeitup/sim-dynamics`'s MeshData, redeclared here so this package doesn't
 * pull in the Rapier dependency just for a type. Phase 2 will use `vertices`/
 * `indices` to emit real mesh geoms (and convex hulls) into MuJoCo's VFS; Phase
 * 1 only needs the AABB the resolver already put on each SimBody.
 */
export interface MeshData {
  /** Flattened world-space vertices (mm): [x,y,z, x,y,z, ...]. */
  vertices: Float32Array;
  /** Triangle indices into `vertices`. */
  indices: Uint32Array;
}
