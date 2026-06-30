/**
 * Minimal 3MF (3D Manufacturing Format) writer.
 *
 * 3MF is the native container for Bambu Studio / OrcaSlicer and, unlike STL,
 * preserves per-part identity AND per-part color — the exact fidelity gap the
 * STL exporter warns about. A 3MF file is an OPC (ZIP) package containing:
 *
 *   [Content_Types].xml      — MIME map for the package
 *   _rels/.rels              — points at the root model part
 *   3D/3dmodel.model         — the XML mesh + build instructions
 *
 * This module is dependency-free on purpose: `exportShapes` runs in BOTH the
 * browser Web Worker (extension/viewer path) and Node (MCP server path), so we
 * cannot lean on a Node-only zip library. We emit a STORE-only (uncompressed)
 * ZIP, which every slicer + OS reads fine, using a hand-rolled CRC32 + local/
 * central-directory record builder. The only runtime dependency is TextEncoder,
 * which exists in both environments.
 */
import type { PartInput } from "./tessellate";

// Same tessellation tolerance the STL path uses, so 3MF and STL exports of the
// same model agree on facet density. (See exporter.ts:extractTriangles.)
const MESH_TOLERANCE = 0.05;
const MESH_ANGULAR_TOLERANCE = 0.1;

const DEFAULT_DISPLAY_COLOR = "#CCCCCCFF";

export function generate3MF(parts: PartInput[]): ArrayBuffer {
  const model = buildModelXml(parts);
  const files: ZipFile[] = [
    { name: "[Content_Types].xml", data: utf8(CONTENT_TYPES_XML) },
    { name: "_rels/.rels", data: utf8(RELS_XML) },
    { name: "3D/3dmodel.model", data: utf8(model) },
  ];
  return buildZip(files);
}

// --- 3MF model XML ----------------------------------------------------------

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
  `</Types>`;

const RELS_XML =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Target="/3D/3dmodel.model" Id="rel0" ` +
  `Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
  `</Relationships>`;

function buildModelXml(parts: PartInput[]): string {
  // Resource id 1 is the base-material group; objects start at id 2 so every
  // resource id stays unique (the 3MF spec requires it).
  const MATERIALS_ID = 1;
  const baseEntries: string[] = [];
  const objects: string[] = [];
  const items: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const objectId = i + 2;
    baseEntries.push(
      `<base name="${xmlAttr(part.name || `part_${i + 1}`)}" ` +
        `displaycolor="${toDisplayColor(part.color)}"/>`,
    );
    objects.push(
      `<object id="${objectId}" type="model" pid="${MATERIALS_ID}" pindex="${i}">` +
        `<mesh>${buildMeshXml(part)}</mesh>` +
        `</object>`,
    );
    items.push(`<item objectid="${objectId}"/>`);
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<resources>` +
    `<basematerials id="${MATERIALS_ID}">${baseEntries.join("")}</basematerials>` +
    objects.join("") +
    `</resources>` +
    `<build>${items.join("")}</build>` +
    `</model>`
  );
}

function buildMeshXml(part: PartInput): string {
  const meshData = part.shape.mesh({
    tolerance: MESH_TOLERANCE,
    angularTolerance: MESH_ANGULAR_TOLERANCE,
  });
  const verts = meshData.vertices as ArrayLike<number>;
  const tris = meshData.triangles as ArrayLike<number>;

  const vertexParts: string[] = [];
  for (let v = 0; v < verts.length; v += 3) {
    vertexParts.push(
      `<vertex x="${fnum(verts[v])}" y="${fnum(verts[v + 1])}" z="${fnum(verts[v + 2])}"/>`,
    );
  }

  const triangleParts: string[] = [];
  for (let t = 0; t + 2 < tris.length; t += 3) {
    triangleParts.push(
      `<triangle v1="${tris[t]}" v2="${tris[t + 1]}" v3="${tris[t + 2]}"/>`,
    );
  }

  return `<vertices>${vertexParts.join("")}</vertices><triangles>${triangleParts.join("")}</triangles>`;
}

/** Format a coordinate compactly: 6-dp max, trailing zeros trimmed. */
function fnum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  let s = n.toFixed(6);
  if (s.indexOf(".") >= 0) {
    s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s === "" || s === "-0" ? "0" : s;
}

/** Normalize a CSS-ish color to 3MF `#RRGGBBAA`. Falls back to grey. */
function toDisplayColor(color: string | null | undefined): string {
  if (!color) return DEFAULT_DISPLAY_COLOR;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim());
  if (!m) return DEFAULT_DISPLAY_COLOR;
  let hex = m[1];
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length === 6) hex += "FF";
  return `#${hex.toUpperCase()}`;
}

function xmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Minimal STORE-only ZIP (OPC container) ---------------------------------

interface ZipFile {
  name: string;
  data: Uint8Array;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function buildZip(files: ZipFile[]): ArrayBuffer {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    // Local file header (30 bytes) + name + data.
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    localChunks.push(local, file.data);

    // Central directory header (46 bytes) + name.
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + file.data.length;
  }

  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  // End of central directory record (22 bytes).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central dir
  ev.setUint16(8, files.length, true); // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const total =
    offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const chunk of localChunks) {
    out.set(chunk, p);
    p += chunk.length;
  }
  for (const chunk of centralChunks) {
    out.set(chunk, p);
    p += chunk.length;
  }
  out.set(eocd, p);
  return out.buffer;
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
