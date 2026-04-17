import type { PartInput } from "./tessellate";

/**
 * Run BRepCheck_Analyzer on each rendered part to catch invalid geometry
 * (self-intersections, non-manifold shells, open wires, bad curves, etc.).
 */
export function validateParts(
  parts: PartInput[],
  replicad: any
): string[] {
  if (!replicad || typeof replicad.getOC !== "function") return [];
  let oc: any;
  try {
    oc = replicad.getOC();
  } catch {
    return [];
  }
  if (!oc || typeof oc.BRepCheck_Analyzer !== "function") return [];

  const warnings: string[] = [];
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
        warnings.push(
          `Part "${part.name}" fails geometry validation. Likely self-intersection, non-manifold topology, or open shell — STEP/STL export may fail or produce incorrect geometry.`
        );
      }
    } catch (err: any) {
      warnings.push(
        `Part "${part.name}" could not be validated: ${err?.message || err}`
      );
    } finally {
      try {
        analyzer.delete?.();
      } catch {}
    }
  }
  return warnings;
}
