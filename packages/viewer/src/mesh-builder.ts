import * as THREE from "three";
import { createModelMaterial, createEdgeMaterial } from "./theme";

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
