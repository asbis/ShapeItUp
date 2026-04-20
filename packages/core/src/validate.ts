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
}

/**
 * Run BRepCheck_Analyzer on each rendered part to catch invalid geometry
 * (self-intersections, non-manifold shells, open wires, bad curves, etc.).
 *
 * Returns an array of structured issues. Callers turn `severity:"error"`
 * entries into the authoritative "render has geometry errors" signal and
 * skip measurement on affected parts; `severity:"warning"` entries are
 * purely advisory.
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
        issues.push({
          part: part.name,
          severity: "error",
          reason: "non-manifold",
          message: `Part "${part.name}" fails geometry validation. Likely self-intersection, non-manifold topology, or open shell — STEP/STL export may fail or produce incorrect geometry. Volume/area/mass have been omitted for this part because OCCT measurements on invalid solids return inflated or nonsensical numbers.`,
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
