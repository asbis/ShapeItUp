import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import {
  createEdgeHighlightMaterial,
  createEdgeMaterial,
  createHighlightMaterial,
  createModelMaterial,
} from "./theme";

export function buildMesh(
  vertices: Float32Array,
  normals: Float32Array,
  triangles: Uint32Array,
  color?: number | string
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(triangles, 1));

  return new THREE.Mesh(geometry, createModelMaterial(color));
}

export function buildEdges(edgeVertices: Float32Array): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(edgeVertices, 3)
  );

  return new THREE.LineSegments(geometry, createEdgeMaterial());
}

/**
 * Build an overlay mesh covering one face's triangles.
 *
 * Copies the span into its own small geometry rather than re-grouping the
 * part's geometry with a second material. Re-grouping would mean touching the
 * model's own buffers on every pointer move; this touches nothing the renderer
 * already uploaded, and a face is a few hundred triangles at most.
 *
 * `start` and `count` are index units into `triangles` — the same units
 * replicad's faceGroups use.
 */
export function buildFaceHighlight(
  vertices: Float32Array,
  triangles: Uint32Array,
  start: number,
  count: number,
  mode: "hover" | "select",
): THREE.Mesh {
  // Flatten to non-indexed: the span references vertices scattered through the
  // full buffer, so an indexed copy would have to carry the whole vertex array
  // along with it.
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = triangles[start + i] * 3;
    positions[i * 3] = vertices[v];
    positions[i * 3 + 1] = vertices[v + 1];
    positions[i * 3 + 2] = vertices[v + 2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mesh = new THREE.Mesh(geometry, createHighlightMaterial(mode));
  // Never let the overlay itself be a raycast target — it sits in front of the
  // very face it describes, so it would shadow every subsequent pick.
  mesh.raycast = () => {};
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Overlay for the edges an operation is about to modify.
 *
 * A `LineSegments2` rather than a plain `LineSegments`, because the whole
 * point is to be thicker than the model's own hairline edges and WebGL will
 * not draw a line wider than 1 px. See createEdgeHighlightMaterial.
 *
 * `positions` is in LineSegments pair layout — the same layout replicad's
 * `meshEdges().lines` already uses, so spans can be handed straight through.
 */
export function buildEdgeHighlight(
  positions: Float32Array,
  mode: "hover" | "select" = "select",
): LineSegments2 {
  const geometry = new LineSegmentsGeometry();
  // setPositions wants a plain array-like of xyz; a Float32Array qualifies.
  geometry.setPositions(positions as unknown as number[]);
  const lines = new LineSegments2(geometry, createEdgeHighlightMaterial(mode));
  // Never a raycast target: it sits on top of the very edge it describes.
  lines.raycast = () => {};
  lines.renderOrder = 2;
  // LineSegments2 computes a bounding sphere lazily and warns without one when
  // frustum culling runs; the overlay is small and always near the model, so
  // skipping the test is cheaper than maintaining it.
  lines.frustumCulled = false;
  return lines;
}
