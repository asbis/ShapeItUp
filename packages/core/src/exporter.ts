import type { PartInput } from "./tessellate";

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

interface StlTri {
  nx: number; ny: number; nz: number;
  v: [[number, number, number], [number, number, number], [number, number, number]];
}

function extractTriangles(part: PartInput): StlTri[] {
  const meshData = part.shape.mesh({ tolerance: 0.05, angularTolerance: 0.1 });
  const verts = meshData.vertices as number[];
  const norms = meshData.normals as number[];
  const tris = meshData.triangles as number[];
  const out: StlTri[] = [];
  for (let t = 0; t < tris.length / 3; t++) {
    const i0 = tris[t * 3] * 3;
    const i1 = tris[t * 3 + 1] * 3;
    const i2 = tris[t * 3 + 2] * 3;
    out.push({
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
  return out;
}

function sanitizeSolidName(name: string | undefined, fallback: string): string {
  if (!name) return fallback;
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned || fallback;
}

function fmtStlFloat(n: number): string {
  return Number.isFinite(n) ? n.toFixed(6) : "0.000000";
}

export function emitAsciiSolid(name: string, tris: StlTri[]): string {
  const lines: string[] = [];
  lines.push(`solid ${name}`);
  for (const tri of tris) {
    lines.push(`  facet normal ${fmtStlFloat(tri.nx)} ${fmtStlFloat(tri.ny)} ${fmtStlFloat(tri.nz)}`);
    lines.push(`    outer loop`);
    for (const v of tri.v) {
      lines.push(`      vertex ${fmtStlFloat(v[0])} ${fmtStlFloat(v[1])} ${fmtStlFloat(v[2])}`);
    }
    lines.push(`    endloop`);
    lines.push(`  endfacet`);
  }
  lines.push(`endsolid ${name}`);
  return lines.join("\n") + "\n";
}

function generateAsciiMultiPartSTL(parts: PartInput[]): ArrayBuffer {
  const usedNames = new Set<string>();
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const base = sanitizeSolidName(parts[i].name, `part_${i + 1}`);
    let name = base;
    let suffix = 1;
    while (usedNames.has(name)) {
      name = `${base}_${++suffix}`;
    }
    usedNames.add(name);
    chunks.push(emitAsciiSolid(name, extractTriangles(parts[i])));
  }
  return new TextEncoder().encode(chunks.join("")).buffer as ArrayBuffer;
}

function generateBinarySTL(parts: PartInput[]): ArrayBuffer {
  const allTris: StlTri[] = [];
  for (const part of parts) {
    for (const tri of extractTriangles(part)) allTris.push(tri);
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

function generateCombinedSTL(parts: PartInput[]): ArrayBuffer {
  // Multi-part: emit ASCII multi-solid — most slicers (PrusaSlicer, Cura,
  // Bambu, Orca) recognize each `solid <name>` block as a separate object
  // so users can tune per-part settings. Binary STL can't express this.
  // Single-part stays binary for compactness.
  if (parts.length > 1) {
    return generateAsciiMultiPartSTL(parts);
  }
  return generateBinarySTL(parts);
}
