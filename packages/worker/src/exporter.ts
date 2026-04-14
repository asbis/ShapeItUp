import type { PartInput } from "./tessellate";

/**
 * Export shapes to STEP or STL format.
 * Accepts an array of parts for assembly export.
 */
export async function exportShapes(
  parts: PartInput[],
  format: "step" | "stl",
  replicadModule: any
): Promise<ArrayBuffer> {
  if (format === "step") {
    const stepParts = parts.map((p) => ({ shape: p.shape, name: p.name }));
    const blob: Blob = replicadModule.exportSTEP(stepParts);
    return blob.arrayBuffer();
  } else {
    return generateCombinedSTL(parts);
  }
}

/**
 * Generate binary STL from multiple shapes, concatenated into one file.
 */
function generateCombinedSTL(parts: PartInput[]): ArrayBuffer {
  // Collect all triangles from all parts
  const allTris: { nx: number; ny: number; nz: number; v: number[][] }[] = [];

  for (const part of parts) {
    const meshData = part.shape.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
    const verts = meshData.vertices as number[];
    const norms = meshData.normals as number[];
    const tris = meshData.triangles as number[];

    for (let t = 0; t < tris.length / 3; t++) {
      const i0 = tris[t * 3] * 3;
      const i1 = tris[t * 3 + 1] * 3;
      const i2 = tris[t * 3 + 2] * 3;

      allTris.push({
        nx: (norms[i0] + norms[i1] + norms[i2]) / 3,
        ny: (norms[i0 + 1] + norms[i1 + 1] + norms[i2 + 1]) / 3,
        nz: (norms[i0 + 2] + norms[i1 + 2] + norms[i2 + 2]) / 3,
        v: [
          [verts[i0], verts[i0 + 1], verts[i0 + 2]],
          [verts[i1], verts[i1 + 1], verts[i1 + 2]],
          [verts[i2], verts[i2 + 1], verts[i2 + 2]],
        ],
      });
    }
  }

  const bufferSize = 84 + allTris.length * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  const header = "ShapeItUp STL Export";
  for (let i = 0; i < 80; i++) {
    view.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
  }
  view.setUint32(80, allTris.length, true);

  let offset = 84;
  for (const tri of allTris) {
    view.setFloat32(offset, tri.nx, true); offset += 4;
    view.setFloat32(offset, tri.ny, true); offset += 4;
    view.setFloat32(offset, tri.nz, true); offset += 4;
    for (const v of tri.v) {
      view.setFloat32(offset, v[0], true); offset += 4;
      view.setFloat32(offset, v[1], true); offset += 4;
      view.setFloat32(offset, v[2], true); offset += 4;
    }
    view.setUint16(offset, 0, true); offset += 2;
  }

  return buffer;
}
