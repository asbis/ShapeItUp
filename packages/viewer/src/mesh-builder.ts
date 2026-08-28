import * as THREE from "three";
import { THEME, createModelMaterial, createEdgeMaterial, createHighlightMaterial } from "./theme";

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
 * Drawn on top of the model's own black edge lines, so it needs both a
 * depthTest waiver and a high renderOrder — a highlighted edge that vanishes
 * behind the surface it belongs to would defeat the point, which is letting
 * the user count what they are about to round.
 */
export function buildEdgeHighlight(
  points: Float32Array,
  mode: "hover" | "select" = "select",
): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({
    color: mode === "select" ? THEME.edgeSelectColor : THEME.edgeHoverColor,
    depthTest: false,
    transparent: true,
    opacity: mode === "select" ? 0.95 : 0.7,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.raycast = () => {};
  lines.renderOrder = 2;
  return lines;
}
