/**
 * Headless SVG renderer — now the PRIMARY screenshot producer for
 * render_preview, preview_finder, preview_shape, tune_params, and open_shape's
 * optional capture. Produces a 4-pane (top / front / right / iso) SVG from
 * OCCT-tessellated geometry we already have in memory on every part:
 *   - per-part triangle mesh (`vertices` + `triangles` + per-part `color`)
 *   - silhouette edge polylines (`edgeVertices`)
 *
 * Shading model: flat lambertian. Each pane has a view-aligned light; the
 * iso pane has its own light keyed to the ~(1,1,1) view direction. Per
 * triangle we compute the surface normal, take max(0, N·L), and scale the
 * part's base RGB by `(ambient + diffuse * shading)`. Gives solid, legible
 * dimensional geometry without specular highlights or multi-light rigs.
 *
 * Triangles are sorted back-to-front (painter's algorithm) so overlapping
 * features composite correctly without a full z-buffer. Edges draw on top
 * as a thin black wireframe.
 *
 * Optional highlights: callers that want finder-style match overlays (pink
 * dots at match centroids) pass `{ highlights: [{ x, y, z }, ...] }`. Each
 * highlight is projected into all four panes.
 *
 * Pure string concatenation — no external dependencies. Ships inside the
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
  /**
   * Unit light direction in world space for this pane's lambertian shading.
   * For orthographic panes, the light is tilted ~35° off the camera axis so
   * faces head-on don't blow out to full intensity — you still see shading
   * falloff on oblique faces. The iso pane uses a diagonal world-space light
   * so its oblique faces remain differentiated.
   */
  light: [number, number, number];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
}

const VIEWS: View[] = [
  // Top: camera looks down −Z. Tilt light so +X and +Y faces get distinct tones.
  {
    name: "Top (XY)",
    project: (x, y, _z) => [x, -y],
    depth: (_x, _y, z) => -z,
    light: normalize([0.35, -0.35, 0.87]),
  },
  // Front: camera looks along +Y. Light up-and-right so top faces read light.
  {
    name: "Front (XZ)",
    project: (x, _y, z) => [x, -z],
    depth: (_x, y, _z) => y,
    light: normalize([0.35, -0.87, 0.35]),
  },
  // Right: camera looks along +X. Light forward-and-up.
  {
    name: "Right (YZ)",
    project: (_x, y, z) => [y, -z],
    depth: (x, _y, _z) => x,
    light: normalize([0.87, -0.35, 0.35]),
  },
  // Isometric: view direction ≈ −(1,1,1) (looking toward origin from +x,+y,+z).
  // Pick a diagonal light a bit to one side of the view axis so parallel
  // faces of a cube get three visibly different tones.
  {
    name: "Iso",
    project: (x, y, z) => {
      const a = Math.PI / 6; // 30°
      const u = x * Math.cos(a) - y * Math.cos(a);
      const v = -(z - x * Math.sin(a) - y * Math.sin(a));
      return [u, v];
    },
    depth: (x, y, z) => -(x + y + z),
    light: normalize([0.3, -0.5, 0.8]),
  },
];

interface Triangle {
  u1: number; v1: number;
  u2: number; v2: number;
  u3: number; v3: number;
  depth: number;
  fill: string; // already shaded hex color
}

const AMBIENT = 0.35;
const DIFFUSE = 0.65;
const DEFAULT_FILL = "#8899aa";
const HIGHLIGHT_FILL = "#ff2d95";

interface ProjectedPane {
  name: string;
  segments: Array<[number, number, number, number]>; // x1,y1,x2,y2
  /** Triangles pre-sorted back-to-front for painter's-algorithm compositing. */
  triangles: Triangle[];
  partBounds: Array<{ name: string; color: string | null; min: [number, number]; max: [number, number] }>;
  highlights: Array<[number, number]>;
  min: [number, number];
  max: [number, number];
}

/**
 * Parse a color spec into normalized [r, g, b] in 0..1. Accepts:
 *   - #rgb / #rrggbb
 *   - rgb(r, g, b) with 0..255 ints
 * Falls back to DEFAULT_FILL on anything unrecognized.
 */
function parseColor(spec: string | null | undefined): [number, number, number] {
  const fallback: [number, number, number] = [0x88 / 255, 0x99 / 255, 0xaa / 255];
  if (!spec) return fallback;
  const s = spec.trim().toLowerCase();
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].every((v) => Number.isFinite(v))) return [r / 255, g / 255, b / 255];
    } else if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].every((v) => Number.isFinite(v))) return [r / 255, g / 255, b / 255];
    }
    return fallback;
  }
  const m = s.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (m) {
    return [parseInt(m[1], 10) / 255, parseInt(m[2], 10) / 255, parseInt(m[3], 10) / 255];
  }
  return fallback;
}

function rgbToHex(r: number, g: number, b: number): string {
  const to255 = (v: number) => {
    const n = Math.max(0, Math.min(255, Math.round(v * 255)));
    return n.toString(16).padStart(2, "0");
  };
  return `#${to255(r)}${to255(g)}${to255(b)}`;
}

/**
 * Apply flat lambertian shading to a base RGB given a unit triangle normal
 * and unit light direction. Returns the shaded hex color ready for SVG.
 */
function shadeHex(
  baseRgb: [number, number, number],
  normal: [number, number, number],
  light: [number, number, number],
): string {
  const dot = normal[0] * light[0] + normal[1] * light[1] + normal[2] * light[2];
  // Two-sided shading: flip the normal when it faces away from the light so
  // interior tessellation winding inconsistencies don't produce pitch-black
  // triangles. The silhouette remains correct because the outline comes
  // from the edge wireframe, not the fills.
  const shading = Math.abs(dot);
  const factor = AMBIENT + DIFFUSE * shading;
  return rgbToHex(
    Math.min(1, baseRgb[0] * factor),
    Math.min(1, baseRgb[1] * factor),
    Math.min(1, baseRgb[2] * factor),
  );
}

function projectParts(
  parts: ExecutedPart[],
  view: View,
  highlights: Array<{ x: number; y: number; z: number }>,
): ProjectedPane {
  const segments: ProjectedPane["segments"] = [];
  const triangles: Triangle[] = [];
  const partBounds: ProjectedPane["partBounds"] = [];
  let gminU = Infinity, gminV = Infinity, gmaxU = -Infinity, gmaxV = -Infinity;

  for (const part of parts) {
    const baseRgb = parseColor(part.color || DEFAULT_FILL);

    // Collect filled triangles per part with lambertian shading.
    const verts = part.vertices;
    const tris = part.triangles;
    if (verts && tris && tris.length >= 3) {
      for (let i = 0; i + 2 < tris.length; i += 3) {
        const a = tris[i] * 3, b = tris[i + 1] * 3, c = tris[i + 2] * 3;
        const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
        const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
        const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];

        // Compute surface normal via cross product. Skip degenerate
        // (zero-area / colinear) triangles whose normal is undefined.
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const nLen = Math.hypot(nx, ny, nz);
        if (!Number.isFinite(nLen) || nLen < 1e-12) continue;
        const normal: [number, number, number] = [nx / nLen, ny / nLen, nz / nLen];

        const [u1, v1] = view.project(ax, ay, az);
        const [u2, v2] = view.project(bx, by, bz);
        const [u3, v3] = view.project(cx, cy, cz);
        const dCx = (ax + bx + cx) / 3;
        const dCy = (ay + by + cy) / 3;
        const dCz = (az + bz + cz) / 3;

        triangles.push({
          u1, v1, u2, v2, u3, v3,
          depth: view.depth(dCx, dCy, dCz),
          fill: shadeHex(baseRgb, normal, view.light),
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

  const projectedHighlights: Array<[number, number]> = highlights.map((h) =>
    view.project(h.x, h.y, h.z),
  );

  // Painter's algorithm — furthest first, closest last (drawn on top).
  triangles.sort((a, b) => b.depth - a.depth);

  return {
    name: view.name,
    segments,
    triangles,
    partBounds,
    highlights: projectedHighlights,
    min: [gminU, gminV],
    max: [gmaxU, gmaxV],
  };
}

function renderPane(pane: ProjectedPane, originX: number, originY: number, paneSize: number, scale: number, _globalMin: [number, number]): string {
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

  // Shaded triangle fills, sorted back-to-front. Each triangle carries its
  // own pre-computed hex color (lambertian). Fully opaque so depth reads
  // clearly — the wireframe on top preserves silhouette legibility.
  if (pane.triangles.length) {
    const fills: string[] = [];
    for (const t of pane.triangles) {
      const x1 = (t.u1 * scale + tx).toFixed(1);
      const y1 = (t.v1 * scale + ty).toFixed(1);
      const x2 = (t.u2 * scale + tx).toFixed(1);
      const y2 = (t.v2 * scale + ty).toFixed(1);
      const x3 = (t.u3 * scale + tx).toFixed(1);
      const y3 = (t.v3 * scale + ty).toFixed(1);
      fills.push(`<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="${t.fill}"/>`);
    }
    lines.push(`<g stroke="none">${fills.join("")}</g>`);
  }

  // Edges — drawn on top of fills so the wireframe stays readable.
  const path: string[] = [];
  for (const [u1, v1, u2, v2] of pane.segments) {
    path.push(`M${(u1 * scale + tx).toFixed(1)} ${(v1 * scale + ty).toFixed(1)}L${(u2 * scale + tx).toFixed(1)} ${(v2 * scale + ty).toFixed(1)}`);
  }
  lines.push(`<path d="${path.join("")}" fill="none" stroke="#212529" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round"/>`);

  // Finder highlights (optional) — pink dots with a thin white halo so they
  // pop against both light fills and dark edges.
  if (pane.highlights.length) {
    const dots: string[] = [];
    for (const [u, v] of pane.highlights) {
      const cx = (u * scale + tx).toFixed(1);
      const cy = (v * scale + ty).toFixed(1);
      dots.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="white" opacity="0.75"/><circle cx="${cx}" cy="${cy}" r="3.5" fill="${HIGHLIGHT_FILL}"/>`);
    }
    lines.push(dots.join(""));
  }

  // Dimension labels (width × height in world units, rounded to 1 decimal).
  const wLabel = width.toFixed(1);
  const hLabel = height.toFixed(1);
  lines.push(`<text x="${originX + paneSize - 8}" y="${originY + paneSize - 8}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="10" fill="#868e96">${wLabel} × ${hLabel} mm</text>`);

  return lines.join("\n");
}

export interface RenderSvgOptions {
  /**
   * Optional world-space points to mark in every pane with a pink dot —
   * used by preview_finder / render_preview's finder mode to indicate
   * match locations on the 2D projection. Leave unset for plain renders.
   */
  highlights?: Array<{ x: number; y: number; z: number }>;
  /**
   * Optional headline text to display above the panes. Defaults to
   * `ShapeItUp headless wireframe — N part(s)`.
   */
  title?: string;
}

export interface RenderSvgResult {
  svg: string;
  summary: string;
}

export function renderPartsToSvg(
  parts: ExecutedPart[],
  options: RenderSvgOptions = {},
): RenderSvgResult {
  if (parts.length === 0) {
    return {
      svg: `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100"><text x="200" y="55" text-anchor="middle" font-family="system-ui" font-size="14" fill="#868e96">No parts to render</text></svg>`,
      summary: "No parts rendered.",
    };
  }

  const highlights = options.highlights ?? [];

  // Project into each view, find global scale so all 4 views fit uniformly.
  const panes = VIEWS.map((v) => projectParts(parts, v, highlights));
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
  const headline =
    options.title ??
    `ShapeItUp headless render — ${partCount} part${partCount === 1 ? "" : "s"}`;
  svg.push(`<text x="12" y="24" font-family="system-ui, -apple-system, sans-serif" font-size="14" fill="#212529" font-weight="600">${headline}</text>`);
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
  const hlNote = highlights.length > 0 ? `, ${highlights.length} finder highlight${highlights.length === 1 ? "" : "s"}` : "";
  const summary = `Rendered ${partCount} part${partCount === 1 ? "" : "s"}, ${totalSeg} edge segments${hlNote}, total volume ${totalVol.toFixed(0)} mm³.`;

  return { svg: svg.join("\n"), summary };
}
