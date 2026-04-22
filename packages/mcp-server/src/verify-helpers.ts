/**
 * Pure extraction helpers shared by the inspection tools (describe_geometry,
 * check_collisions, validate_joints) and the aggregate `verify_shape` tool.
 *
 * Each `extract*` function operates on the live `parts: ExecutedPart[]` array
 * returned by `executeShapeFile` and returns a STRUCTURED report object — no
 * text formatting, no MCP response shape. The corresponding `format*` function
 * turns that report into the same human-readable text the individual tools
 * have always produced.
 *
 * Splitting extract from format gives `verify_shape` two wins:
 *   1. One execution can feed multiple checks — no need to re-run the script
 *      4 separate times for the four inspection tools.
 *   2. The structured report shape is the natural API for an aggregate JSON
 *      response; the individual tools layer their text formatting on top.
 *
 * IMPORTANT: callers must own the ExecutedPart array's lifetime. These helpers
 * read `part.shape` (live OCCT handle) and `part.vertices` (typed-array mesh
 * data) — they do NOT free the underlying OCCT shapes. Anything the helper
 * itself allocates (face / edge sub-handles fetched from `shape.faces`, the
 * intersection solid in `extractCollisions`, etc.) IS deleted before return.
 */

import type { ExecutedPart } from "@shapeitup/core";

// ---------------------------------------------------------------------------
// describe_geometry
// ---------------------------------------------------------------------------

export type GeometryFormat = "summary" | "full";
export type GeometryFacesFilter = "all" | "planar" | "curved";
export type GeometryEdgesFilter = "all" | "outer" | "none";

export interface GeometryFaceRecord {
  part: string;
  id: number;
  type?: string;
  normal?: [number, number, number];
  normalDir?: string;
  centroid?: [number, number, number];
  area?: number;
}
export interface GeometryEdgeRecord {
  part: string;
  id: number;
  type?: string;
  start?: [number, number, number];
  end?: [number, number, number];
  length?: number;
}
export interface GeometryBoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}
export interface GeometrySummary {
  partNames: string[];
  faceCount: number;
  edgeCount?: number;
  facesByType: Record<string, number>;
  facesByNormalDir: Record<string, number>;
  edgesByType?: Record<string, number>;
  truncated?: { faces: boolean; edges: boolean };
}
export interface GeometryReport {
  format: GeometryFormat;
  /** True when the requested format was 'full' but auto-downgraded to summary
   * because the per-record budget (FULL_TOKEN_BUDGET) would have been blown. */
  forcedDowngrade: boolean;
  /** Effective filter values after defaulting (handy for the formatter header). */
  facesFilter: GeometryFacesFilter;
  edgesFilter: GeometryEdgesFilter;
  limit: number;
  summary: GeometrySummary;
  boundingBox?: GeometryBoundingBox;
  faces?: GeometryFaceRecord[];
  edges?: GeometryEdgeRecord[];
  warning?: string;
}

export interface ExtractGeometryOptions {
  /** Restrict to the named part. Undefined → every part. */
  partName?: string;
  format?: GeometryFormat;
  faces?: GeometryFacesFilter;
  edges?: GeometryEdgesFilter;
  /** Hard cap on face/edge records returned in `format: 'full'`. Default 50. */
  limit?: number;
  /** Replicad module reference used to call `measureArea`. */
  replicad?: any;
}

export interface ExtractGeometryResult {
  /** True when extraction succeeded (every input was valid). */
  ok: boolean;
  /** Set when `partName` didn't match any part. */
  error?: string;
  report?: GeometryReport;
}

const round3 = (n: number): number =>
  (typeof n === "number" && isFinite(n)) ? Math.round(n * 1000) / 1000 : n;
const round3pt = (p: { x: number; y: number; z: number }): [number, number, number] =>
  [round3(p.x), round3(p.y), round3(p.z)];

const quantizeNormal = (nx: number, ny: number, nz: number): string => {
  const thresh = 0.5;
  const parts: string[] = [];
  if (Math.abs(nx) >= thresh) parts.push(nx > 0 ? "+X" : "-X");
  if (Math.abs(ny) >= thresh) parts.push(ny > 0 ? "+Y" : "-Y");
  if (Math.abs(nz) >= thresh) parts.push(nz > 0 ? "+Z" : "-Z");
  if (parts.length === 0) return "oblique";
  return parts.join("");
};

/**
 * Extract face/edge records + bounding box from one or more rendered parts.
 * Mirror of the inline implementation that previously lived inside the
 * `describe_geometry` tool handler. Pure: only reads the parts, frees its own
 * face/edge sub-handles before returning.
 */
export function extractGeometry(
  parts: ExecutedPart[],
  opts: ExtractGeometryOptions = {},
): ExtractGeometryResult {
  const effectiveFormat: GeometryFormat = opts.format ?? "summary";
  const effectiveFaces: GeometryFacesFilter = opts.faces ?? "all";
  const effectiveEdges: GeometryEdgesFilter = opts.edges ?? "none";
  const effectiveLimit =
    typeof opts.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 50;

  let targets: ExecutedPart[];
  if (opts.partName !== undefined) {
    const found = parts.find((p) => p.name === opts.partName);
    if (!found) {
      return {
        ok: false,
        error: `No part named "${opts.partName}". Available: ${parts.map((p) => p.name).join(", ") || "(none)"}`,
      };
    }
    targets = [found];
  } else {
    targets = parts.slice();
  }

  const measureArea = opts.replicad?.measureArea;

  const faceRecords: GeometryFaceRecord[] = [];
  const edgeRecords: GeometryEdgeRecord[] = [];
  const faceTypeCounts: Record<string, number> = {};
  const faceNormalCounts: Record<string, number> = {};
  const edgeTypeCounts: Record<string, number> = {};

  let totalFacesSeen = 0;
  let totalEdgesSeen = 0;
  let facesTruncated = false;
  let edgesTruncated = false;
  let globalMinX = Infinity, globalMinY = Infinity, globalMinZ = Infinity;
  let globalMaxX = -Infinity, globalMaxY = -Infinity, globalMaxZ = -Infinity;

  for (const part of targets) {
    const v = part.vertices;
    if (v && v.length >= 3) {
      for (let i = 0; i < v.length; i += 3) {
        if (v[i] < globalMinX) globalMinX = v[i];
        if (v[i] > globalMaxX) globalMaxX = v[i];
        if (v[i + 1] < globalMinY) globalMinY = v[i + 1];
        if (v[i + 1] > globalMaxY) globalMaxY = v[i + 1];
        if (v[i + 2] < globalMinZ) globalMinZ = v[i + 2];
        if (v[i + 2] > globalMaxZ) globalMaxZ = v[i + 2];
      }
    }
  }

  for (const part of targets) {
    const shape: any = part.shape;
    let faceList: any[] = [];
    try {
      faceList = shape.faces ?? [];
    } catch {
      faceList = [];
    }
    for (let i = 0; i < faceList.length; i++) {
      const f = faceList[i];
      totalFacesSeen++;
      let type: string | undefined;
      try {
        const t = f.geomType;
        if (typeof t === "string") type = t;
      } catch { /* ignore — geomType is optional */ }

      const isPlanar = type === "PLANE";
      if (effectiveFaces === "planar" && !isPlanar) { try { f.delete?.(); } catch { /* swallow */ } continue; }
      if (effectiveFaces === "curved" && isPlanar) { try { f.delete?.(); } catch { /* swallow */ } continue; }

      if (type) faceTypeCounts[type] = (faceTypeCounts[type] ?? 0) + 1;

      let centroid: [number, number, number] | undefined;
      try {
        const c = f.center;
        if (c && typeof c.x === "number" && typeof c.y === "number" && typeof c.z === "number") {
          centroid = round3pt(c);
        }
        try { c?.delete?.(); } catch { /* swallow cleanup */ }
      } catch { /* center may not be available */ }

      let normal: [number, number, number] | undefined;
      let normalDir: string | undefined;
      try {
        if (typeof f.normalAt === "function") {
          const n = f.normalAt();
          if (n && typeof n.x === "number" && typeof n.y === "number" && typeof n.z === "number") {
            normal = round3pt(n);
            normalDir = quantizeNormal(n.x, n.y, n.z);
            faceNormalCounts[normalDir] = (faceNormalCounts[normalDir] ?? 0) + 1;
          }
          try { n?.delete?.(); } catch { /* swallow */ }
        }
      } catch { /* face has no normal */ }

      let area: number | undefined;
      try {
        if (typeof measureArea === "function") {
          const a = measureArea(f);
          if (typeof a === "number" && isFinite(a)) area = round3(a);
        }
      } catch { /* surface type unsupported */ }

      if (effectiveFormat === "full") {
        if (faceRecords.length < effectiveLimit) {
          faceRecords.push({
            part: part.name,
            id: i,
            type,
            normal,
            normalDir,
            centroid,
            area,
          });
        } else {
          facesTruncated = true;
        }
      }

      try { f.delete?.(); } catch { /* swallow */ }
    }

    if (effectiveEdges !== "none") {
      let edgeList: any[] = [];
      try {
        edgeList = shape.edges ?? [];
      } catch {
        edgeList = [];
      }
      for (let i = 0; i < edgeList.length; i++) {
        const e = edgeList[i];
        totalEdgesSeen++;
        let type: string | undefined;
        try {
          const t = e.geomType;
          if (typeof t === "string") type = t;
        } catch { /* swallow */ }
        if (type) edgeTypeCounts[type] = (edgeTypeCounts[type] ?? 0) + 1;

        let start: [number, number, number] | undefined;
        let end: [number, number, number] | undefined;
        let length: number | undefined;
        try {
          const s = e.startPoint;
          if (s && typeof s.x === "number") start = round3pt(s);
          try { s?.delete?.(); } catch { /* swallow */ }
        } catch { /* swallow */ }
        try {
          const ep = e.endPoint;
          if (ep && typeof ep.x === "number") end = round3pt(ep);
          try { ep?.delete?.(); } catch { /* swallow */ }
        } catch { /* swallow */ }
        try {
          const l = e.length;
          if (typeof l === "number" && isFinite(l)) length = round3(l);
        } catch { /* swallow */ }

        if (effectiveFormat === "full") {
          if (edgeRecords.length < effectiveLimit) {
            edgeRecords.push({ part: part.name, id: i, type, start, end, length });
          } else {
            edgesTruncated = true;
          }
        }

        try { e.delete?.(); } catch { /* swallow */ }
      }
    }
  }

  // Token guard — same threshold the inline implementation used.
  const FULL_TOKEN_BUDGET = 20_000;
  const approxTokens = (faceRecords.length + edgeRecords.length) * 40;
  let warning: string | undefined;
  let forcedDowngrade = false;
  if (effectiveFormat === "full" && approxTokens > FULL_TOKEN_BUDGET) {
    warning =
      `Response would exceed ~${FULL_TOKEN_BUDGET.toLocaleString()}-token budget ` +
      `(estimated ${approxTokens.toLocaleString()} tokens for ${faceRecords.length} faces + ${edgeRecords.length} edges). ` +
      `Auto-downgraded to summary. Re-run with a smaller \`limit\` (current ${effectiveLimit}) or a tighter \`faces\`/\`edges\` filter to get full arrays.`;
    forcedDowngrade = true;
  }

  const boundingBox: GeometryBoundingBox | undefined = globalMinX !== Infinity
    ? {
        min: [round3(globalMinX), round3(globalMinY), round3(globalMinZ)],
        max: [round3(globalMaxX), round3(globalMaxY), round3(globalMaxZ)],
        size: [
          round3(globalMaxX - globalMinX),
          round3(globalMaxY - globalMinY),
          round3(globalMaxZ - globalMinZ),
        ],
      }
    : undefined;

  const summary: GeometrySummary = {
    partNames: targets.map((p) => p.name),
    faceCount: totalFacesSeen,
    edgeCount: effectiveEdges === "none" ? undefined : totalEdgesSeen,
    facesByType: faceTypeCounts,
    facesByNormalDir: faceNormalCounts,
    edgesByType: effectiveEdges === "none" ? undefined : edgeTypeCounts,
    truncated: effectiveFormat === "full" && !forcedDowngrade
      ? { faces: facesTruncated, edges: edgesTruncated }
      : undefined,
  };

  const report: GeometryReport = {
    format: effectiveFormat,
    forcedDowngrade,
    facesFilter: effectiveFaces,
    edgesFilter: effectiveEdges,
    limit: effectiveLimit,
    summary,
    boundingBox,
    faces:
      effectiveFormat === "full" && !forcedDowngrade ? faceRecords : undefined,
    edges:
      effectiveFormat === "full" && !forcedDowngrade && effectiveEdges !== "none"
        ? edgeRecords
        : undefined,
    warning,
  };

  return { ok: true, report };
}

/**
 * Render the `GeometryReport` to the same text payload `describe_geometry`
 * produced before the refactor: a one-line header followed by JSON-pretty
 * payload object. `sourceLabel` is what the header echoes (e.g. file
 * basename) so callers control the provenance string.
 */
export function formatGeometryReport(
  report: GeometryReport,
  sourceLabel: string,
): string {
  const targetsLabel = report.summary.partNames.join(", ") || "(none)";
  const targetCount = report.summary.partNames.length;
  const formatLabel = report.forcedDowngrade
    ? "summary (auto-downgraded)"
    : report.format;
  const header = [
    `describe_geometry: ${targetCount} part${targetCount === 1 ? "" : "s"} (${targetsLabel}) from ${sourceLabel}`,
    `format=${formatLabel}, faces=${report.facesFilter}, edges=${report.edgesFilter}, limit=${report.limit}`,
  ].join("\n");

  const payload: any = {
    summary: report.summary,
    boundingBox: report.boundingBox,
  };
  if (report.faces !== undefined) payload.faces = report.faces;
  if (report.edges !== undefined) payload.edges = report.edges;
  if (report.warning) payload.warning = report.warning;

  return `${header}\n${JSON.stringify(payload, null, 2)}`;
}

// ---------------------------------------------------------------------------
// check_collisions
// ---------------------------------------------------------------------------

export interface CollisionRegion {
  min: [number, number, number];
  max: [number, number, number];
  /** Per-axis overlap extents (max - min) in mm. Saves callers the mental
   *  arithmetic of subtracting the bbox corners to size clearance cuts. */
  depths: { x: number; y: number; z: number };
}

export interface CollisionRecord {
  /** Display label (may include `part-N:` index prefix when names duplicate). */
  a: string;
  b: string;
  /** Raw part name (for symmetric `acceptedPairs` matching). */
  rawA: string;
  rawB: string;
  volume: number;
  region?: CollisionRegion;
  center?: [number, number, number];
}

export interface CollisionFailure {
  a: string;
  b: string;
  error: string;
}

export interface CollisionReport {
  totalParts: number;
  totalPairs: number;
  testedPairs: number;
  skippedByAABB: number;
  /** Tolerance actually used (clamped to >= 0). */
  tolerance: number;
  /** Press-fit threshold actually used (clamped to >= tolerance). */
  pressFitThreshold: number;
  /** Real collisions (volume > pressFit, not in acceptedPairs), sorted desc. */
  real: CollisionRecord[];
  /** Press-fit collisions (volume <= pressFit, not in acceptedPairs), sorted desc. */
  pressFit: CollisionRecord[];
  /** Accepted collisions (per acceptedPairs), sorted desc. */
  accepted: CollisionRecord[];
  /** Pairs whose intersect/measure call threw. */
  failures: CollisionFailure[];
  /** Parts skipped from scan because they had no tessellated vertices. */
  degenerateWarnings: string[];
  /** True when no real collisions and no failures (regardless of accepted/press-fit). */
  ok: boolean;
  /** True when the assembly only had a single part (collision check was skipped). */
  skipped: boolean;
}

export interface ExtractCollisionsOptions {
  tolerance?: number;
  acceptedPairs?: Array<[string, string]>;
  pressFitThreshold?: number;
  /** Replicad module reference for `measureShapeVolumeProperties`. */
  replicad?: any;
}

// ---------------------------------------------------------------------------
// acceptedPairs wildcard matching — shared by extractCollisions and the
// in-lined check_collisions path in tools.ts (re-exported below).
//
// `*` matches any run of characters within a name. Exact-literal patterns
// still do an O(1) string compare; patterns with `*` compile to a RegExp
// once per pattern per call (the set is tiny — typically < 10 entries — so
// no further caching is warranted).
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  // Escape every RegExp metachar; `*` is separately carved out before we
  // reach here (it's the ONLY wildcard we honour).
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** True if `name` matches `pattern`. `*` in the pattern matches any run of chars. */
export function nameMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const re = new RegExp(
    "^" + pattern.split("*").map(escapeRegex).join(".*") + "$",
  );
  return re.test(name);
}

/**
 * Symmetric wildcard match over a list of accepted `[a, b]` patterns. A
 * collision pair `(x, y)` is accepted iff SOME `[a, b]` satisfies
 * `(a~x && b~y) || (a~y && b~x)`.
 *
 * Exported so the mirror implementation in `tools.ts` can share exactly
 * this logic — there's no benefit to maintaining two copies of the glob
 * semantics.
 */
export function matchesAnyAcceptedPair(
  x: string,
  y: string,
  patterns: ReadonlyArray<readonly [string, string]>,
): boolean {
  for (const [a, b] of patterns) {
    if ((nameMatches(a, x) && nameMatches(b, y)) || (nameMatches(a, y) && nameMatches(b, x))) {
      return true;
    }
  }
  return false;
}

const AABB_EPS = 1e-6;

interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

function aabbFromVertices(v: ArrayLike<number> | undefined): AABB | null {
  if (!v || v.length < 3) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < minX) minX = v[i];
    if (v[i] > maxX) maxX = v[i];
    if (v[i + 1] < minY) minY = v[i + 1];
    if (v[i + 1] > maxY) maxY = v[i + 1];
    if (v[i + 2] < minZ) minZ = v[i + 2];
    if (v[i + 2] > maxZ) maxZ = v[i + 2];
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function aabbsOverlap(a: AABB, b: AABB): boolean {
  return (
    a.maxX > b.minX + AABB_EPS && b.maxX > a.minX + AABB_EPS &&
    a.maxY > b.minY + AABB_EPS && b.maxY > a.minY + AABB_EPS &&
    a.maxZ > b.minZ + AABB_EPS && b.maxZ > a.minZ + AABB_EPS
  );
}

/**
 * Pairwise intersection scan. Same logic as the inline implementation in
 * `check_collisions` — AABB prefilter, 3D intersect on remaining pairs,
 * volume measurement, triage into real/press-fit/accepted buckets.
 *
 * The intersection solid is always `.delete()`'d; a per-pair try/finally
 * keeps WASM handle hygiene intact even when measurement throws.
 */
export function extractCollisions(
  parts: ExecutedPart[],
  opts: ExtractCollisionsOptions = {},
): CollisionReport {
  const tol = Math.max(0, typeof opts.tolerance === "number" ? opts.tolerance : 0.001);
  const pressFit = Math.max(
    tol,
    typeof opts.pressFitThreshold === "number" ? opts.pressFitThreshold : 0.5,
  );

  const totalPairs = (parts.length * (parts.length - 1)) / 2;
  if (parts.length < 2) {
    return {
      totalParts: parts.length,
      totalPairs: 0,
      testedPairs: 0,
      skippedByAABB: 0,
      tolerance: tol,
      pressFitThreshold: pressFit,
      real: [],
      pressFit: [],
      accepted: [],
      failures: [],
      degenerateWarnings: [],
      ok: true,
      skipped: true,
    };
  }

  // Accepted-pair matcher with `*` wildcard support.
  //
  // Each side of an accepted pair can be a literal name (exact match, the old
  // behaviour) OR a glob-ish pattern with `*` acting as "any run of chars in a
  // name". Examples:
  //   ["needle", "needle-bed"]     — same as before (exact on both sides)
  //   ["needle-*", "needle-bed"]   — matches any part whose name starts with
  //                                  "needle-" paired with "needle-bed"
  //   ["bolt-*", "plate-*"]        — matches any bolt against any plate
  //
  // The match is symmetric: for a collision pair (x, y) we accept it iff SOME
  // configured pair `[a, b]` satisfies either `a~x && b~y` OR `a~y && b~x`.
  const acceptedPatterns: Array<[string, string]> = [];
  for (const pair of opts.acceptedPairs ?? []) {
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && typeof pair[1] === "string") {
      acceptedPatterns.push([pair[0], pair[1]]);
    }
  }
  const isAcceptedPair = (a: string, b: string): boolean =>
    matchesAnyAcceptedPair(a, b, acceptedPatterns);

  const boxes: Array<AABB | null> = parts.map((p) => aabbFromVertices(p.vertices));
  const nameCounts = new Map<string, number>();
  for (const p of parts) nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  const labelFor = (i: number): string =>
    (nameCounts.get(parts[i].name) ?? 0) > 1 ? `part-${i}:${parts[i].name}` : parts[i].name;

  const measureVol = opts.replicad?.measureShapeVolumeProperties;

  const collisions: CollisionRecord[] = [];
  const failures: CollisionFailure[] = [];
  const degenerateWarnings: string[] = [];
  let skippedByAABB = 0;
  let tested = 0;

  for (let i = 0; i < parts.length; i++) {
    const boxI = boxes[i];
    if (!boxI) {
      if (!degenerateWarnings.some((w) => w.includes(`[${i}]`))) {
        degenerateWarnings.push(`  - ${labelFor(i)} [${i}] has no tessellated vertices — skipped from collision scan.`);
      }
      continue;
    }
    for (let j = i + 1; j < parts.length; j++) {
      const boxJ = boxes[j];
      if (!boxJ) continue;

      if (!aabbsOverlap(boxI, boxJ)) {
        skippedByAABB++;
        continue;
      }

      tested++;

      let overlapShape: any = null;
      try {
        overlapShape = parts[i].shape.intersect(parts[j].shape);
      } catch (e: any) {
        failures.push({ a: labelFor(i), b: labelFor(j), error: e?.message ?? String(e) });
        continue;
      }

      try {
        let volume = 0;
        let overlapCenter: [number, number, number] | undefined;
        let volProps: any = null;
        try {
          volProps = measureVol?.(overlapShape);
          if (volProps && typeof volProps.volume === "number") {
            volume = volProps.volume;
          }
          if (volProps && volProps.centerOfMass && Array.isArray(volProps.centerOfMass)) {
            const c = volProps.centerOfMass;
            if (c.length >= 3 && c.every((n: any) => typeof n === "number" && isFinite(n))) {
              overlapCenter = [c[0], c[1], c[2]];
            }
          }
        } catch (e: any) {
          failures.push({ a: labelFor(i), b: labelFor(j), error: `volume measurement failed: ${e?.message ?? e}` });
          continue;
        } finally {
          try { volProps?.delete?.(); } catch { /* swallow */ }
        }

        if (volume > tol) {
          let region: CollisionRegion | undefined;
          try {
            const meshData: any = overlapShape.mesh?.({ tolerance: 0.1, angularTolerance: 0.3 });
            const verts: ArrayLike<number> | undefined = meshData?.vertices;
            if (verts && verts.length >= 3) {
              let mnx = Infinity, mny = Infinity, mnz = Infinity;
              let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
              for (let k = 0; k < verts.length; k += 3) {
                const x = verts[k], y = verts[k + 1], z = verts[k + 2];
                if (x < mnx) mnx = x; if (x > mxx) mxx = x;
                if (y < mny) mny = y; if (y > mxy) mxy = y;
                if (z < mnz) mnz = z; if (z > mxz) mxz = z;
              }
              if (isFinite(mnx)) {
                region = {
                  min: [mnx, mny, mnz],
                  max: [mxx, mxy, mxz],
                  depths: { x: mxx - mnx, y: mxy - mny, z: mxz - mnz },
                };
              }
            }
          } catch { /* region omission is non-fatal */ }
          collisions.push({
            a: labelFor(i),
            b: labelFor(j),
            rawA: parts[i].name,
            rawB: parts[j].name,
            volume,
            ...(region ? { region } : {}),
            ...(overlapCenter ? { center: overlapCenter } : {}),
          });
        }
      } finally {
        try { overlapShape?.delete?.(); } catch { /* swallow */ }
      }
    }
  }

  const accepted = collisions.filter((c) => isAcceptedPair(c.rawA, c.rawB));
  const unaccepted = collisions.filter((c) => !isAcceptedPair(c.rawA, c.rawB));
  const real = unaccepted
    .filter((c) => c.volume > pressFit)
    .sort((a, b) => b.volume - a.volume);
  const pressFitC = unaccepted
    .filter((c) => c.volume <= pressFit)
    .sort((a, b) => b.volume - a.volume);
  accepted.sort((a, b) => b.volume - a.volume);

  return {
    totalParts: parts.length,
    totalPairs,
    testedPairs: tested,
    skippedByAABB,
    tolerance: tol,
    pressFitThreshold: pressFit,
    real,
    pressFit: pressFitC,
    accepted,
    failures,
    degenerateWarnings,
    ok: real.length === 0 && failures.length === 0,
    skipped: false,
  };
}

const fmtNum = (n: number) => (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2));
const pairWord = (n: number) => `${n} pair${n === 1 ? "" : "s"}`;

/**
 * Strip a trailing index suffix (`-0`, `-12`, `-a`) from a part name so
 * `solenoid-0`, `solenoid-1`, …, `solenoid-19` collapse to `solenoid`.
 */
function stripIndexSuffix(name: string): string {
  return name.replace(/-\d+$/, "").replace(/-[a-z]$/i, "");
}

function withinOnePercent(a: number, b: number): boolean {
  const denom = Math.max(Math.abs(a), Math.abs(b), 0.001);
  return Math.abs(a - b) / denom <= 0.01;
}

type SystematicGroup = {
  prefix: string;
  count: number;
  volume: number;
  depths: { x: number; y: number; z: number };
  dominantAxis: "X" | "Y" | "Z";
  dominantDepth: number;
  memberIndices: number[];
};

/**
 * Fold N≥3 pairs that share a common name prefix AND have identical
 * (within 1%) overlap volume + per-axis depth into a single "systematic
 * size/spacing mismatch" group. Matches the pre-pass in tools.ts
 * `formatCollisionPairs`; kept local to this file to avoid a circular
 * import (tools.ts already depends on verify-helpers.ts).
 */
function groupSystematicRecords(
  real: CollisionRecord[],
): { groups: SystematicGroup[]; groupedIndices: Set<number> } {
  const groups: SystematicGroup[] = [];
  const groupedIndices = new Set<number>();
  if (real.length < 3) return { groups, groupedIndices };

  for (let i = 0; i < real.length; i++) {
    if (groupedIndices.has(i)) continue;
    const seed = real[i];
    if (!seed.region) continue;
    const prefixA = stripIndexSuffix(seed.a);
    const prefixB = stripIndexSuffix(seed.b);
    if (prefixA !== prefixB) continue;
    const prefix = prefixA;

    const bucket: number[] = [i];
    for (let j = i + 1; j < real.length; j++) {
      if (groupedIndices.has(j)) continue;
      const cand = real[j];
      if (!cand.region) continue;
      if (stripIndexSuffix(cand.a) !== prefix) continue;
      if (stripIndexSuffix(cand.b) !== prefix) continue;
      if (!withinOnePercent(cand.volume, seed.volume)) continue;
      if (!withinOnePercent(cand.region.depths.x, seed.region.depths.x)) continue;
      if (!withinOnePercent(cand.region.depths.y, seed.region.depths.y)) continue;
      if (!withinOnePercent(cand.region.depths.z, seed.region.depths.z)) continue;
      bucket.push(j);
    }

    if (bucket.length < 3) continue;
    const d = seed.region.depths;
    let dominantAxis: "X" | "Y" | "Z" = "X";
    let dominantDepth = d.x;
    if (d.y > dominantDepth) { dominantAxis = "Y"; dominantDepth = d.y; }
    if (d.z > dominantDepth) { dominantAxis = "Z"; dominantDepth = d.z; }

    groups.push({
      prefix,
      count: bucket.length,
      volume: seed.volume,
      depths: { ...d },
      dominantAxis,
      dominantDepth,
      memberIndices: bucket,
    });
    for (const idx of bucket) groupedIndices.add(idx);
  }
  return { groups, groupedIndices };
}

function formatSystematicGroupLines(g: SystematicGroup): string[] {
  return [
    `  - Systematic overlap: ${g.count} ${g.prefix}-* pairs, each ${fmtNum(g.volume)} mm\u00b3, ` +
      `overlap depth X=${fmtNum(g.depths.x)}mm Y=${fmtNum(g.depths.y)}mm Z=${fmtNum(g.depths.z)}mm (dominant axis: ${g.dominantAxis}).`,
    `    Design-class hint: identical overlap across ${g.count} pairs sharing prefix "${g.prefix}" suggests a size/spacing mismatch ` +
      `on the ${g.dominantAxis} axis — part extent exceeds pitch by ${fmtNum(g.dominantDepth)}mm. ` +
      `Fix by shrinking the ${g.prefix} body on ${g.dominantAxis} OR widening the ${g.dominantAxis}-pitch.`,
  ];
}

/**
 * Render the `CollisionReport` to the same text payload `check_collisions`
 * produced before the refactor.
 */
export function formatCollisionReport(report: CollisionReport): string {
  if (report.skipped) {
    return "Collision check skipped — file contains a single part. Collisions only apply to multi-part assemblies.";
  }

  const noRealTrouble = report.real.length === 0 && report.failures.length === 0;
  const accounting: string[] = [
    `Checked ${report.totalParts} parts \u2192 ${pairWord(report.totalPairs)} total.`,
  ];
  if (report.skippedByAABB > 0 && report.skippedByAABB === report.totalPairs) {
    accounting.push(`  - No overlap possible \u2014 all ${pairWord(report.totalPairs)} AABB-disjoint.`);
  } else if (report.skippedByAABB > 0 && report.testedPairs > 0) {
    const allClear = noRealTrouble ? " \u2014 all tested pairs clear" : "";
    accounting.push(`  - ${pairWord(report.skippedByAABB)} AABB-disjoint (skipped); ${pairWord(report.testedPairs)} tested${allClear}.`);
  } else if (report.skippedByAABB === 0 && report.testedPairs > 0) {
    const testedSuffix = noRealTrouble ? " \u2014 all clear" : "";
    accounting.push(`  - ${pairWord(report.testedPairs)} tested for 3D intersection${testedSuffix}.`);
  }

  const sections: string[] = [accounting.join("\n")];

  const collisions = [...report.real, ...report.pressFit, ...report.accepted];
  if (collisions.length > 0) {
    const fmtPt = (p: [number, number, number]) =>
      `(${fmtNum(p[0])}, ${fmtNum(p[1])}, ${fmtNum(p[2])})`;
    const fmtRange = (lo: number, hi: number) => `[${fmtNum(lo)}, ${fmtNum(hi)}]`;

    if (report.real.length > 0) {
      const lines: string[] = [];
      const { groups, groupedIndices } = groupSystematicRecords(report.real);
      for (const g of groups) lines.push(...formatSystematicGroupLines(g));
      for (let idx = 0; idx < report.real.length; idx++) {
        if (groupedIndices.has(idx)) continue;
        const c = report.real[idx];
        lines.push(`  - ${c.a} \u2194 ${c.b}: ${fmtNum(c.volume)} mm\u00b3 overlap`);
        if (c.region) {
          const r = c.region;
          lines.push(
            `    Region: x${fmtRange(r.min[0], r.max[0])} y${fmtRange(r.min[1], r.max[1])} z${fmtRange(r.min[2], r.max[2])} mm`,
          );
          lines.push(
            `    Overlap depth: X=${fmtNum(r.depths.x)}mm, Y=${fmtNum(r.depths.y)}mm, Z=${fmtNum(r.depths.z)}mm`,
          );
        }
        if (c.center) {
          lines.push(`    Center: ${fmtPt(c.center)} mm`);
        }
      }
      sections.push(`\nCollisions (sorted by volume desc):\n${lines.join("\n")}`);
    }

    if (report.pressFit.length > 0) {
      const lines = report.pressFit.map(
        (c) => `  - ${c.a} \u2194 ${c.b}: ${fmtNum(c.volume)} mm\u00b3`,
      );
      sections.push(
        `\nNominal contact (volume \u2264 ${fmtNum(report.pressFitThreshold)} mm\u00b3 \u2014 press fits, touching interfaces):\n${lines.join("\n")}`,
      );
    }

    if (report.accepted.length > 0) {
      const volumes = report.accepted.map((c) => c.volume);
      const minV = Math.min(...volumes);
      const maxV = Math.max(...volumes);
      sections.push(
        `\nAccepted (pre-declared expected): ${report.accepted.length} pair${report.accepted.length === 1 ? "" : "s"}, volume ${fmtNum(minV)}\u2013${fmtNum(maxV)} mm\u00b3.`,
      );
    }
  }

  if (report.failures.length > 0) {
    const lines = report.failures.map((f) => `  - ${f.a} \u2194 ${f.b}: ${f.error}`);
    sections.push(`\nIntersect failures (retry with mold-cut or report to developer):\n${lines.join("\n")}`);
  }

  if (report.degenerateWarnings.length > 0) {
    sections.push(`\nWarnings:\n${report.degenerateWarnings.join("\n")}`);
  }

  if (
    report.real.length === 0 &&
    report.failures.length === 0 &&
    report.skippedByAABB < report.totalPairs &&
    report.pressFit.length === 0 &&
    report.accepted.length === 0
  ) {
    sections.push(`\nNo collisions detected.`);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// validate_joints
// ---------------------------------------------------------------------------

export interface JointInfo {
  part: string;
  name: string;
  point: [number, number, number];
}

export interface JointWarning {
  joint: string;
  part: string;
  /** "buried" if the joint point is inside the part's AABB; "floats" otherwise.
   *  "no-geometry" when the owning part had no tessellated vertices. */
  kind: "buried" | "floats" | "no-geometry";
  /** Closest-vertex distance in mm (undefined when kind === "no-geometry"). */
  distanceMm?: number;
  message: string;
}

export interface JointReport {
  /** Tolerance actually used (clamped to >0 with default 0.1). */
  tolerance: number;
  partsScanned: number;
  /** True if no `joints` field surfaced on any part (and thus nothing was
   *  validated). The text formatter renders this as the "no introspectable
   *  joints found" message. */
  introspectable: boolean;
  partNames: string[];
  joints: JointInfo[];
  warnings: JointWarning[];
  ok: boolean;
}

export interface ExtractJointsOptions {
  tolerance?: number;
}

export function extractJoints(
  parts: ExecutedPart[],
  opts: ExtractJointsOptions = {},
): JointReport {
  const tol = typeof opts.tolerance === "number" && opts.tolerance > 0 ? opts.tolerance : 0.1;

  const joints: JointInfo[] = [];
  for (const p of parts) {
    const anyP = p as any;
    const jmap = anyP.joints;
    if (!jmap || typeof jmap !== "object") continue;
    for (const [jname, spec] of Object.entries(jmap)) {
      const s = spec as any;
      const pos = s?.position ?? s?.point ?? s?.origin;
      if (Array.isArray(pos) && pos.length >= 3 && pos.every((n: any) => typeof n === "number" && isFinite(n))) {
        joints.push({ part: p.name, name: jname, point: [pos[0], pos[1], pos[2]] });
      }
    }
  }

  const partNames = parts.map((p) => p.name);

  if (joints.length === 0) {
    return {
      tolerance: tol,
      partsScanned: parts.length,
      introspectable: false,
      partNames,
      joints: [],
      warnings: [],
      ok: true,
    };
  }

  const boxByName = new Map<string, AABB>();
  const vertsByName = new Map<string, ArrayLike<number>>();
  for (const p of parts) {
    const v = (p as any).vertices;
    const box = aabbFromVertices(v);
    if (!box) continue;
    boxByName.set(p.name, box);
    vertsByName.set(p.name, v);
  }

  const warnings: JointWarning[] = [];
  for (const j of joints) {
    const verts = vertsByName.get(j.part);
    const box = boxByName.get(j.part);
    if (!verts || !box) {
      warnings.push({
        joint: j.name,
        part: j.part,
        kind: "no-geometry",
        message: `joint "${j.name}" on "${j.part}": owning part has no tessellated geometry — cannot validate.`,
      });
      continue;
    }
    let best = Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const dx = verts[i] - j.point[0];
      const dy = verts[i + 1] - j.point[1];
      const dz = verts[i + 2] - j.point[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    const dist = Math.sqrt(best);
    if (dist <= tol) continue;
    const inside =
      j.point[0] > box.minX && j.point[0] < box.maxX &&
      j.point[1] > box.minY && j.point[1] < box.maxY &&
      j.point[2] > box.minZ && j.point[2] < box.maxZ;
    const kind: "buried" | "floats" = inside ? "buried" : "floats";
    const prep = inside ? "inside body" : "off surface";
    warnings.push({
      joint: j.name,
      part: j.part,
      kind,
      distanceMm: dist,
      message: `joint "${j.name}" on "${j.part}" ${kind} ${dist.toFixed(3)}mm ${prep}`,
    });
  }

  return {
    tolerance: tol,
    partsScanned: parts.length,
    introspectable: true,
    partNames,
    joints,
    warnings,
    ok: warnings.length === 0,
  };
}

/**
 * Render the `JointReport` to the same text payload `validate_joints`
 * produced before the refactor.
 */
export function formatJointReport(report: JointReport): string {
  if (!report.introspectable) {
    return `validate_joints: no introspectable joints found on any part. Either the assembly declares none, or the executor did not preserve .joints on the render result. Parts scanned: ${report.partNames.join(", ")}`;
  }
  const summary = `validate_joints: checked ${report.joints.length} joint${report.joints.length === 1 ? "" : "s"} across ${report.partsScanned} part${report.partsScanned === 1 ? "" : "s"} (tolerance=${report.tolerance}mm).`;
  if (report.warnings.length === 0) {
    return `${summary}\nOK — all joints are within tolerance of their owning part's surface.`;
  }
  return `${summary}\nWarnings (${report.warnings.length}):\n${report.warnings.map((w) => `  - ${w.message}`).join("\n")}`;
}
