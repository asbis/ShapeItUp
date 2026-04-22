import type { PartInput } from "./tessellate";

/**
 * Structured result of BRepCheck analysis on a single rendered part.
 *
 * Severity is used to decide whether the render as a whole failed:
 *   - "error"   → geometry is genuinely invalid (non-manifold shell, bad
 *                 topology, self-intersection). Volume / area / mass MUST NOT
 *                 be measured because OCCT returns garbage numbers for these
 *                 shapes (see Bug #4 — shell-on-revolve reported 1.4x the
 *                 correct volume because of duplicated faces).
 *   - "warning" → the analyzer itself threw. We can't prove the shape is bad
 *                 but we can't prove it's good either. Surface the message so
 *                 the agent sees it, but don't withhold measurements.
 */
export interface GeometryIssue {
  part: string;
  severity: "error" | "warning";
  reason: "non-manifold" | "check-threw";
  message: string;
  /**
   * Raw heuristic probe values used to classify the failure. Present on every
   * "error"-severity issue so agents can reason about *why* a particular
   * classification was picked rather than trusting an opaque label.
   *
   *   - `volume`      – `measureShapeVolumeProperties(shape).volume`, or NaN if
   *                     the measurement itself failed.
   *   - `bboxVolume`  – product of bounding-box extents (0 if no bbox).
   *   - `shellCount`  – TopAbs_SHELL count, or -1 if OCCT primitives were
   *                     missing from the kernel handle.
   *
   * Absent on "warning"/check-threw issues — those never ran the probes.
   */
  diagnostics?: {
    volume: number;
    bboxVolume: number;
    shellCount: number;
  };
}

/**
 * The failure modes we try to distinguish in the error message. The analyzer
 * itself only returns a single boolean, so we use cheap heuristics (volume
 * relative to bbox volume, shell count) to pick the single MOST LIKELY cause
 * when we have concrete evidence — and deliberately fall back to `"unknown"`
 * rather than guessing when no evidence fits, because a wrong classification
 * (previously: bare "self-intersection" fallback) sends agents chasing
 * non-existent sketch self-intersections when the real issue is something
 * else OCCT doesn't give us visibility into.
 *
 * `"self-intersection"` is only used when OCCT itself surfaced an exception
 * string that names it (or a closely-related `BRep_API` failure) — never as a
 * guess.
 */
export type FailureKind =
  | "open-shell"
  | "non-manifold"
  | "self-intersection"
  | "unknown";

/** Relative-volume threshold below which we flag "likely open shell". */
const OPEN_SHELL_VOLUME_FRACTION = 1e-4;

/**
 * Attempt to read a usable AABB off a replicad Shape. Shapes expose
 * `.boundingBox` lazily; it may throw on invalid geometry, hence the try/catch.
 * Returns null if the box can't be determined.
 */
function readBoundingBox(shape: any):
  | { min: [number, number, number]; max: [number, number, number] }
  | null {
  try {
    const bb = shape?.boundingBox;
    if (!bb) return null;
    // replicad BoundingBox exposes `.bounds` → [[minX,minY,minZ],[maxX,maxY,maxZ]]
    if (Array.isArray(bb.bounds) && bb.bounds.length === 2) {
      const [mn, mx] = bb.bounds;
      if (Array.isArray(mn) && Array.isArray(mx) && mn.length === 3 && mx.length === 3) {
        return { min: [mn[0], mn[1], mn[2]], max: [mx[0], mx[1], mx[2]] };
      }
    }
    // Fallback: width/height/depth + center (rough).
    if (
      typeof bb.width === "number" &&
      typeof bb.height === "number" &&
      typeof bb.depth === "number" &&
      Array.isArray(bb.center) &&
      bb.center.length === 3
    ) {
      const [cx, cy, cz] = bb.center;
      return {
        min: [cx - bb.width / 2, cy - bb.height / 2, cz - bb.depth / 2],
        max: [cx + bb.width / 2, cy + bb.height / 2, cz + bb.depth / 2],
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Count TopAbs_SHELL sub-shapes on a wrapped OCCT shape. A well-formed solid
 * has exactly one outer shell (and optionally inner shells for cavities).
 * More than one DISJOINT shell suggests a non-manifold/disconnected result.
 *
 * Returns -1 if OCCT doesn't expose the primitives we need.
 */
function countShells(wrapped: any, oc: any): number {
  try {
    if (
      typeof oc.TopExp_Explorer !== "function" ||
      !oc.TopAbs_ShapeEnum ||
      typeof oc.TopAbs_ShapeEnum.TopAbs_SHELL === "undefined"
    ) {
      return -1;
    }
    const explorer = new oc.TopExp_Explorer(
      wrapped,
      oc.TopAbs_ShapeEnum.TopAbs_SHELL,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    let n = 0;
    try {
      while (explorer.More && explorer.More()) {
        n++;
        explorer.Next();
      }
    } finally {
      try { explorer.delete?.(); } catch {}
    }
    return n;
  } catch {
    return -1;
  }
}

/**
 * Best-effort volume read. Uses the same `measureShapeVolumeProperties` path
 * the rest of the pipeline uses. Returns NaN if the measurement fails — which
 * is itself a strong "open shell / degenerate" signal.
 */
function safeVolume(shape: any, replicad: any): number {
  try {
    const measure = replicad?.measureShapeVolumeProperties;
    if (typeof measure !== "function") return NaN;
    const props = measure(shape);
    const v = props?.volume;
    try { props?.delete?.(); } catch {}
    return typeof v === "number" && Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Compute bounding-box volume from an optional bbox. Returns 0 when the bbox
 * is unavailable or degenerate — callers treat 0 as "no usable bbox signal".
 */
function bboxVolumeOf(
  bbox: { min: [number, number, number]; max: [number, number, number] } | null,
): number {
  if (!bbox) return 0;
  const bx = Math.max(bbox.max[0] - bbox.min[0], 0);
  const by = Math.max(bbox.max[1] - bbox.min[1], 0);
  const bz = Math.max(bbox.max[2] - bbox.min[2], 0);
  return bx * by * bz;
}

/**
 * Decide the single most-likely failure mode given what we can cheaply
 * observe. Ordered so the strongest signal wins:
 *   1. Volume ≈ 0 relative to bbox volume → open shell / missing face.
 *   2. Shell count > 1                    → non-manifold / disconnected.
 *   3. Exception string names it          → self-intersection.
 *   4. Otherwise                          → "unknown" (no evidence).
 *
 * The final branch intentionally returns `"unknown"` instead of guessing —
 * historically this fell through to a bare `"self-intersection"` label which
 * sent agents chasing the wrong bug whenever OCCT failed for any other
 * reason (bad curves, tolerance issues, internal wires, ...).
 *
 * `exceptionMessage` is the message from the catch branch in `validateParts`
 * — when present and it contains concrete self-intersection evidence we
 * promote the classification accordingly. When absent (the IsValid_2()→false
 * path) the fallback MUST stay `"unknown"`.
 */
function classifyFailure(
  volume: number,
  bbox: { min: [number, number, number]; max: [number, number, number] } | null,
  shellCount: number,
  exceptionMessage?: string,
): { cls: FailureKind; shellCount: number } {
  if (bbox) {
    const bboxVol = bboxVolumeOf(bbox);
    if (bboxVol > 0) {
      if (!Number.isFinite(volume) || Math.abs(volume) / bboxVol < OPEN_SHELL_VOLUME_FRACTION) {
        return { cls: "open-shell", shellCount };
      }
    } else if (!Number.isFinite(volume) || volume === 0) {
      return { cls: "open-shell", shellCount };
    }
  } else if (!Number.isFinite(volume) || volume === 0) {
    return { cls: "open-shell", shellCount };
  }

  if (shellCount > 1) return { cls: "non-manifold", shellCount };

  if (exceptionMessage && hasSelfIntersectionEvidence(exceptionMessage)) {
    return { cls: "self-intersection", shellCount };
  }

  return { cls: "unknown", shellCount };
}

/**
 * True iff the exception string carries concrete evidence that OCCT itself
 * detected a self-intersection / BRep-API failure. Matching is case-insensitive
 * and handles the common spellings OCCT emits ("self-intersect", "self
 * intersecting", "BRep_API", "BRepAPI").
 */
function hasSelfIntersectionEvidence(msg: string): boolean {
  if (!msg) return false;
  if (/self[- ]?intersect/i.test(msg)) return true;
  if (/brep[_]?api/i.test(msg)) return true;
  return false;
}

/** Format a bbox suffix for error messages, or "" if no bbox is available. */
function formatLocation(
  bbox: { min: [number, number, number]; max: [number, number, number] } | null,
): string {
  if (!bbox) return "";
  const f = (n: number) => (Math.abs(n) < 1e-3 ? "0" : n.toFixed(1));
  return ` at bbox (${f(bbox.min[0])}..${f(bbox.max[0])}, ${f(bbox.min[1])}..${f(bbox.max[1])}, ${f(bbox.min[2])}..${f(bbox.max[2])})`;
}

/**
 * Format the classification into a human sentence. `diagnostics` is only
 * consulted for the "unknown" arm — it's what lets the agent reason about
 * *why* we couldn't classify, so the message has to carry it verbatim.
 */
function describeFailure(
  cls: FailureKind,
  shellCount: number,
  diagnostics?: { volume: number; bboxVolume: number; shellCount: number },
): string {
  switch (cls) {
    case "open-shell":
      return "likely open shell or missing face (volume near zero relative to bounding box)";
    case "non-manifold":
      return `likely disconnected/non-manifold geometry: ${shellCount} shells detected`;
    case "self-intersection":
      return "likely self-intersection — try reducing sketch complexity or filleting sharp concavities";
    case "unknown": {
      const volStr = diagnostics && Number.isFinite(diagnostics.volume)
        ? diagnostics.volume.toFixed(1)
        : "NaN";
      const bboxStr = diagnostics && Number.isFinite(diagnostics.bboxVolume)
        ? diagnostics.bboxVolume.toFixed(1)
        : "0";
      const shellStr = diagnostics ? String(diagnostics.shellCount) : String(shellCount);
      return `OCCT validation failed (BRepCheck). shellCount=${shellStr}, volume=${volStr}, bboxVolume=${bboxStr} — could not auto-classify. Check verify_shape output for specific failing faces/edges`;
    }
  }
}

/**
 * Run BRepCheck_Analyzer on each rendered part to catch invalid geometry
 * (self-intersections, non-manifold shells, open wires, bad curves, etc.).
 *
 * Returns an array of structured issues. Callers turn `severity:"error"`
 * entries into the authoritative "render has geometry errors" signal and
 * skip measurement on affected parts; `severity:"warning"` entries are
 * purely advisory.
 *
 * When a part fails, we attempt to NARROW the diagnosis — instead of the old
 * "likely A, B, or C" grab-bag message we pick the single most-probable cause
 * from volume-vs-bbox and shell-count heuristics and attach the part's bbox
 * so the LLM has a location hint to work with. When none of the heuristics
 * fire we report `"unknown"` with the raw probe values rather than guessing.
 */
export function validateParts(
  parts: PartInput[],
  replicad: any
): GeometryIssue[] {
  if (!replicad || typeof replicad.getOC !== "function") return [];
  let oc: any;
  try {
    oc = replicad.getOC();
  } catch {
    return [];
  }
  if (!oc || typeof oc.BRepCheck_Analyzer !== "function") return [];

  const issues: GeometryIssue[] = [];
  for (const part of parts) {
    const wrapped = part.shape?.wrapped;
    if (!wrapped) continue;

    let analyzer: any;
    try {
      analyzer = new oc.BRepCheck_Analyzer(wrapped, false, false);
    } catch {
      continue;
    }

    try {
      const valid =
        typeof analyzer.IsValid_2 === "function"
          ? analyzer.IsValid_2()
          : analyzer.IsValid_1?.(wrapped);

      if (valid === false || valid === 0) {
        // Narrow the diagnosis. All three probes are best-effort — if any
        // throws or returns unusable data we fall back to the more generic
        // branch in classifyFailure(). No exception string is available on
        // this path (IsValid_2 just returned false), so the classifier will
        // yield "unknown" whenever neither heuristic fires.
        const bbox = readBoundingBox(part.shape);
        const volume = safeVolume(part.shape, replicad);
        const shellCount = countShells(wrapped, oc);
        const bboxVolume = bboxVolumeOf(bbox);
        const { cls, shellCount: shells } = classifyFailure(
          volume,
          bbox,
          shellCount,
          undefined,
        );
        const diagnostics = { volume, bboxVolume, shellCount };
        const location = formatLocation(bbox);
        const cause = describeFailure(cls, shells, diagnostics);
        issues.push({
          part: part.name,
          severity: "error",
          reason: "non-manifold",
          message: `Part "${part.name}" fails geometry validation — ${cause}${location}. STEP/STL export may fail or produce incorrect geometry. Volume/area/mass have been omitted because OCCT measurements on invalid solids return inflated or nonsensical numbers.`,
          diagnostics,
        });
      }
    } catch (err: any) {
      issues.push({
        part: part.name,
        severity: "warning",
        reason: "check-threw",
        message: `Part "${part.name}" could not be validated: ${err?.message || err}`,
      });
    } finally {
      try {
        analyzer.delete?.();
      } catch {}
    }
  }
  return issues;
}

/** True if any issue in `issues` has `severity === "error"`. */
export function hasGeometryErrors(issues: GeometryIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

/** Return the set of part names that have at least one error-severity issue. */
export function partsWithErrors(issues: GeometryIssue[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    if (i.severity === "error") out.add(i.part);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Internal helpers exported for unit tests only. Not part of the public API.
// ---------------------------------------------------------------------------
export const __test__ = {
  classifyFailure,
  formatLocation,
  describeFailure,
  readBoundingBox,
  countShells,
  safeVolume,
  bboxVolumeOf,
  hasSelfIntersectionEvidence,
};
