/**
 * Headless SVG wireframe renderer for MCP render_preview fallback.
 *
 * We already have OCCT-tessellated edge vertices on `ExecutedPart.edgeVertices`
 * (pairs of xyz triples). Projecting those onto a 2D plane gives a clean
 * line-drawing view of the model — not as pretty as the Three.js viewer in
 * the VS Code extension, but more than enough for an AI agent to sanity-check
 * silhouette, proportions, and feature placement without needing the extension
 * to be running.
 *
 * Output: a four-pane SVG (top / front / right / isometric) per model. Each
 * pane auto-scales to fit, annotates the bounding box, and preserves relative
 * part sizes via a shared world-to-pane scale factor.
 *
 * Fix #9 (scoped): in addition to edges we now paint per-part, low-opacity
 * color fills behind the wireframe using each part's declared `color` (the
 * same field STEP export preserves). Triangles are projected from the
 * tessellated mesh and drawn back-to-front by view-space centroid depth so
 * overlaps in each orthographic view render correctly. This dramatically
 * improves legibility of thin features (needles, fins) that would otherwise
 * get lost in edge noise.
 *
 * No external dependencies — pure string concatenation. Ships inside the
 * bundled MCP server.
 */

import type { ExecutedPart } from "@shapeitup/core";

interface View {
  name: string;
  project: (x: number, y: number, z: number) => [number, number];
  /**
   * View-space depth used for back-to-front painter's-algorithm ordering.
   * LARGER value = further from the viewer. For axis-aligned orthographic
   * views this is the axis the camera looks along (negated when the camera
   * points in the negative direction).
   */
  depth: (x: number, y: number, z: number) => number;
}

const VIEWS: View[] = [
  // Top: camera looks down −Z so larger z = closer to the viewer → depth = −z.
  { name: "Top (XY)", project: (x, y, _z) => [x, -y], depth: (_x, _y, z) => -z },
  // Front: camera looks along +Y direction, larger y = further.
  { name: "Front (XZ)", project: (x, _y, z) => [x, -z], depth: (_x, y, _z) => y },
  // Right: camera looks along +X direction, larger x = further.
  { name: "Right (YZ)", project: (_x, y, z) => [y, -z], depth: (x, _y, _z) => x },
  // Isometric: view direction ≈ (1,1,1) so depth ∝ −(x+y+z).
  {
    name: "Iso",
    project: (x, y, z) => {
      const a = Math.PI / 6; // 30°
      const u = x * Math.cos(a) - y * Math.cos(a);
      const v = -(z - x * Math.sin(a) - y * Math.sin(a));
      return [u, v];
    },
    depth: (x, y, z) => -(x + y + z),
  },
];

interface Triangle {
  u1: number; v1: number;
  u2: number; v2: number;
  u3: number; v3: number;
  depth: number;
  color: string;
}

const FILL_OPACITY = 0.25;
const DEFAULT_FILL = "#8899aa";

interface ProjectedPane {
  name: string;
  segments: Array<[number, number, number, number]>; // x1,y1,x2,y2
  /** Triangles pre-sorted back-to-front for painter's-algorithm compositing. */
  triangles: Triangle[];
  partBounds: Array<{ name: string; color: string | null; min: [number, number]; max: [number, number] }>;
  min: [number, number];
  max: [number, number];
}

function projectParts(parts: ExecutedPart[], view: View): ProjectedPane {
  const segments: ProjectedPane["segments"] = [];
  const triangles: Triangle[] = [];
  const partBounds: ProjectedPane["partBounds"] = [];
  let gminU = Infinity, gminV = Infinity, gmaxU = -Infinity, gmaxV = -Infinity;

  for (const part of parts) {
    const fill = part.color || DEFAULT_FILL;

    // Collect filled triangles per part (Fix #9 silhouette tint).
    const verts = part.vertices;
    const tris = part.triangles;
    if (verts && tris && tris.length >= 3) {
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
        const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
        const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
        const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];
        const [u1, v1] = view.project(ax, ay, az);
        const [u2, v2] = view.project(bx, by, bz);
        const [u3, v3] = view.project(cx, cy, cz);
        const dCx = (ax + bx + cx) / 3;
        const dCy = (ay + by + cy) / 3;
        const dCz = (az + bz + cz) / 3;
        triangles.push({
          u1, v1, u2, v2, u3, v3,
          depth: view.depth(dCx, dCy, dCz),
          color: fill,
        });
      }
    }

    const ev = part.edgeVertices;
    let pminU = Infinity, pminV = Infinity, pmaxU = -Infinity, pmaxV = -Infinity;
    for (let i = 0; i < ev.length; i += 6) {
      const [u1, v1] = view.project(ev[i], ev[i + 1], ev[i + 2]);
      const [u2, v2] = view.project(ev[i + 3], ev[i + 4], ev[i + 5]);
      segments.push([u1, v1, u2, v2]);
      if (u1 < pminU) pminU = u1; if (u1 > pmaxU) pmaxU = u1;
      if (v1 < pminV) pminV = v1; if (v1 > pmaxV) pmaxV = v1;
      if (u2 < pminU) pminU = u2; if (u2 > pmaxU) pmaxU = u2;
      if (v2 < pminV) pminV = v2; if (v2 > pmaxV) pmaxV = v2;
    }
    if (pminU < Infinity) {
      partBounds.push({ name: part.name, color: part.color, min: [pminU, pminV], max: [pmaxU, pmaxV] });
      if (pminU < gminU) gminU = pminU;
      if (pminV < gminV) gminV = pminV;
      if (pmaxU > gmaxU) gmaxU = pmaxU;
      if (pmaxV > gmaxV) gmaxV = pmaxV;
    }
  }

  // Painter's algorithm — furthest first, closest last (drawn on top).
  triangles.sort((a, b) => b.depth - a.depth);

  return {
    name: view.name,
    segments,
    triangles,
    partBounds,
    min: [gminU, gminV],
    max: [gmaxU, gmaxV],
  };
}

function renderPane(pane: ProjectedPane, originX: number, originY: number, paneSize: number, scale: number, globalMin: [number, number]): string {
  const pad = 24;
  const inner = paneSize - pad * 2;
  const width = pane.max[0] - pane.min[0];
  const height = pane.max[1] - pane.min[1];
  // Center within pane using a shared scale so all 4 views are comparable.
  const offsetU = (inner - width * scale) / 2 - pane.min[0] * scale;
  const offsetV = (inner - height * scale) / 2 - pane.min[1] * scale;
  const tx = originX + pad + offsetU;
  const ty = originY + pad + offsetV;

  const lines: string[] = [];
  // Pane frame + label
  lines.push(`<rect x="${originX}" y="${originY}" width="${paneSize}" height="${paneSize}" fill="#f8f9fa" stroke="#cfd6dd" stroke-width="1"/>`);
  lines.push(`<text x="${originX + 8}" y="${originY + 18}" font-family="system-ui, -apple-system, sans-serif" font-size="12" fill="#495057">${pane.name}</text>`);

  // Bounding box of all parts combined, faint.
  const bboxX = pane.min[0] * scale + tx;
  const bboxY = pane.min[1] * scale + ty;
  const bboxW = width * scale;
  const bboxH = height * scale;
  lines.push(`<rect x="${bboxX.toFixed(1)}" y="${bboxY.toFixed(1)}" width="${bboxW.toFixed(1)}" height="${bboxH.toFixed(1)}" fill="none" stroke="#e0e4e8" stroke-width="0.5" stroke-dasharray="2,2"/>`);

  // Fix #9: per-part silhouette fill, sorted back-to-front. Grouped in one
  // <g> with the shared opacity so SVG renderers only apply alpha once per
  // layer (keeps output size manageable even for high-triangle assemblies).
  if (pane.triangles.length) {
    const fills: string[] = [];
    for (const t of pane.triangles) {
      const x1 = (t.u1 * scale + tx).toFixed(1);
      const y1 = (t.v1 * scale + ty).toFixed(1);
      const x2 = (t.u2 * scale + tx).toFixed(1);
      const y2 = (t.v2 * scale + ty).toFixed(1);
      const x3 = (t.u3 * scale + tx).toFixed(1);
      const y3 = (t.v3 * scale + ty).toFixed(1);
      fills.push(`<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="${t.color}"/>`);
    }
    lines.push(`<g fill-opacity="${FILL_OPACITY}" stroke="none">${fills.join("")}</g>`);
  }

  // Edges — drawn on top of fills so the wireframe stays readable.
  const path: string[] = [];
  for (const [u1, v1, u2, v2] of pane.segments) {
    path.push(`M${(u1 * scale + tx).toFixed(1)} ${(v1 * scale + ty).toFixed(1)}L${(u2 * scale + tx).toFixed(1)} ${(v2 * scale + ty).toFixed(1)}`);
  }
  lines.push(`<path d="${path.join("")}" fill="none" stroke="#212529" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"/>`);

  // Dimension labels (width × height in world units, rounded to 1 decimal).
  const wLabel = width.toFixed(1);
  const hLabel = height.toFixed(1);
  lines.push(`<text x="${originX + paneSize - 8}" y="${originY + paneSize - 8}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#868e96">${wLabel} × ${hLabel} mm</text>`);

  return lines.join("\n");
}

export interface RenderSvgResult {
  svg: string;
  summary: string;
}

export function renderPartsToSvg(parts: ExecutedPart[]): RenderSvgResult {
  if (parts.length === 0) {
    return {
      svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><text x="200" y="55" text-anchor="middle" font-family="system-ui" font-size="14" fill="#868e96">No parts to render</text></svg>`,
      summary: "No parts rendered.",
    };
  }

  // Project into each view, find global scale so all 4 views fit uniformly.
  const panes = VIEWS.map((v) => projectParts(parts, v));
  const paneSize = 280;
  const pad = 24;
  const inner = paneSize - pad * 2;
  let scale = Infinity;
  for (const p of panes) {
    const w = p.max[0] - p.min[0];
    const h = p.max[1] - p.min[1];
    const s = Math.min(inner / Math.max(w, 0.001), inner / Math.max(h, 0.001));
    if (s < scale) scale = s;
  }
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  const totalW = paneSize * 2;
  const totalH = paneSize * 2 + 40; // +40 for title strip
  const svg: string[] = [];
  svg.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">`);
  svg.push(`<rect width="100%" height="100%" fill="white"/>`);

  const partCount = parts.length;
  const partList = parts.map((p) => p.name).join(", ");
  svg.push(`<text x="12" y="24" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#212529" font-weight="600">ShapeItUp headless wireframe — ${partCount} part${partCount === 1 ? "" : "s"}</text>`);
  svg.push(`<text x="12" y="36" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#868e96">${partList.length > 80 ? partList.slice(0, 77) + "…" : partList}</text>`);

  const positions = [
    [0, 40],
    [paneSize, 40],
    [0, paneSize + 40],
    [paneSize, paneSize + 40],
  ];
  panes.forEach((pane, i) => {
    svg.push(renderPane(pane, positions[i][0], positions[i][1], paneSize, scale, pane.min));
  });

  svg.push(`</svg>`);

  // One-line summary for the tool response.
  let totalVol = 0;
  let totalSeg = 0;
  for (const p of parts) {
    totalVol += p.volume ?? 0;
    totalSeg += p.edgeVertices.length / 6;
  }
  const summary = `Rendered ${partCount} part${partCount === 1 ? "" : "s"}, ${totalSeg} edge segments, total volume ${totalVol.toFixed(0)} mm³.`;

  return { svg: svg.join("\n"), summary };
}
