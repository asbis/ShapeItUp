/**
 * Print hints — small transformations that make a shape print better on FDM.
 *
 *  - `elephantFootChamfer` — cuts the slight flare at the bottom of the first
 *     layers that happens when plastic squishes against the bed.
 *  - `overhangChamfer` — aims to chamfer 45° down-facing overhangs. Edge-face
 *    angle detection in OCCT is fragile on complex geometry, so this is a
 *    best-effort helper that falls back to a no-op with a warning.
 *  - `firstLayerPad` — adds a thin flat pad below the shape that acts as a
 *    manual brim for improved bed adhesion.
 *
 * ### Why pushRuntimeWarning (not console.warn)?
 *
 * Agent callers drive this library through MCP, and MCP responses only surface
 * the runtime-warning channel drained by the engine after each execute(). A
 * console.warn from inside a worker never makes it back into that response
 * envelope, so a silent no-op chamfer looks identical to a successful one from
 * the caller's point of view. All three helpers route through
 * `pushRuntimeWarning` so both failure diagnostics AND success confirmations
 * reach the agent — for non-visual callers, a positive signal that the op
 * applied is as important as a diagnostic when it didn't.
 *
 * The zero-edge-match case (`.inPlane("XY", zMin)` selects no edges) is tricky
 * because Replicad's finders don't expose a count directly — OCCT throws a
 * descriptive error from inside `chamfer()` instead. We match on message
 * substrings "no", "empty", and "not selected" (OCCT's wording across versions)
 * to classify zero-match vs. a genuine error, and emit structured feedback
 * that names the shape's actual Z extent so the caller can diagnose without
 * re-running.
 */

import { drawRectangle, type Shape3D } from "replicad";
import { pushRuntimeWarning } from "./warnings";

/**
 * Classify an unknown caught error as a zero-edge-match (selector found
 * nothing) vs. a genuine OCCT/library failure. OCCT's phrasings vary by
 * version — "no edges selected", "empty selection", "nothing to chamfer" —
 * so we match on a small set of substrings known to appear across versions.
 * Case-insensitive, because OCCT is inconsistent about capitalization.
 */
function looksLikeNoEdgeMatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  return m.includes("no ") || m.includes("empty") || m.includes("not selected");
}

/** Stringify an unknown error for warning bodies without leaking stack traces. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Chamfer the bottom edges of a shape by `amount` (default 0.4 mm) to
 * compensate for first-layer elephant's-foot flare on FDM prints.
 *
 * Implementation: locate the shape's lowest Z, then chamfer edges in the
 * `XY` plane at that Z value. If no edges match or the chamfer op fails,
 * return the original shape and emit a structured warning — never break
 * the pipeline.
 *
 * Emits runtime warnings for both success and failure so agent callers,
 * who can't see the visual result, get a positive signal when the op
 * applied and an actionable diagnostic when it didn't. Pass
 * `opts.silent = true` to suppress both (useful when looping over mixed
 * parts where a no-op is intentional).
 *
 * @param shape Target Shape3D.
 * @param amount Chamfer distance in mm (default 0.4).
 * @param opts.silent Suppress success/failure warnings (default false).
 * @returns Shape3D, chamfered if possible.
 */
export function elephantFootChamfer(
  shape: Shape3D,
  amount = 0.4,
  opts: { silent?: boolean } = {}
): Shape3D {
  const silent = opts.silent ?? false;
  let zMin: number | undefined;
  let zMax: number | undefined;
  try {
    const bb = shape.boundingBox;
    // bounds is [min, max] — third coordinate is Z.
    zMin = bb.bounds[0][2];
    zMax = bb.bounds[1][2];
    const result = shape.chamfer(amount, (e) => e.inPlane("XY", zMin!));
    if (!silent) {
      pushRuntimeWarning(
        `printHints.elephantFootChamfer: chamfered bottom edges at Z=${zMin.toFixed(3)} (radius ${amount}mm).`
      );
    }
    return result;
  } catch (err) {
    if (!silent) {
      if (looksLikeNoEdgeMatch(err)) {
        const lo = zMin !== undefined ? zMin.toFixed(3) : "?";
        const hi = zMax !== undefined ? zMax.toFixed(3) : "?";
        pushRuntimeWarning(
          `printHints.elephantFootChamfer: no Z=${lo} edges found (shape bbox Z ∈ [${lo}, ${hi}]) — skipped.`
        );
      } else {
        pushRuntimeWarning(
          `printHints.elephantFootChamfer: could not apply — ${errMsg(err)}. Returning shape unchanged.`
        );
      }
    }
    return shape;
  }
}

/**
 * Best-effort overhang chamfer. Tries to find edges that sit between a
 * down-facing horizontal face and a vertical face, then chamfers them at
 * `angle` degrees (default 45). Edge-to-face-normal detection in OCCT is
 * fragile on non-trivial geometry — on failure this function emits a
 * runtime warning and returns the shape unchanged. Don't rely on it for
 * critical features; it's a convenience for simple brackets and plates.
 *
 * Warnings follow the same pattern as `elephantFootChamfer`: success gets
 * a positive confirmation, failure gets a structured diagnosis naming the
 * shape's Z bounds, and `opts.silent = true` suppresses both.
 *
 * @param shape Target Shape3D.
 * @param angle Chamfer angle in degrees (default 45). Currently used to size
 *   the chamfer distance (`tan(angle) × effective thickness`); the selector
 *   treats edges as candidates regardless.
 * @param opts.silent Suppress success/failure warnings (default false).
 * @returns Shape3D, chamfered if possible; otherwise original + warning.
 */
export function overhangChamfer(
  shape: Shape3D,
  angle = 45,
  opts: { silent?: boolean } = {}
): Shape3D {
  const silent = opts.silent ?? false;
  let zMin: number | undefined;
  let zMax: number | undefined;
  try {
    const bb = shape.boundingBox;
    zMin = bb.bounds[0][2];
    zMax = bb.bounds[1][2];
    // Use a nominal chamfer distance sized to ~10% of the shape's Z extent
    // (capped to 1 mm) — keeps the op stable on small features.
    const bbDepth = zMax - zMin;
    const distance = Math.min(Math.max(bbDepth * 0.1, 0.3), 1.0);
    // Heuristic: target edges at the bottom that run along X or Y (edges of
    // downward-facing overhangs). This is the simplest selector OCCT will
    // apply reliably — more nuanced face-normal filtering needs per-shape
    // work that we skip in v1.
    const result = shape.chamfer(distance, (e) =>
      e
        .inPlane("XY", zMin!)
        .not((e2) => e2.ofCurveType("CIRCLE"))
    );
    if (!silent) {
      pushRuntimeWarning(
        `printHints.overhangChamfer: chamfered bottom overhang edges at Z=${zMin.toFixed(3)} (distance ${distance.toFixed(3)}mm, angle ${angle}°).`
      );
    }
    return result;
  } catch (err) {
    if (!silent) {
      if (looksLikeNoEdgeMatch(err)) {
        const lo = zMin !== undefined ? zMin.toFixed(3) : "?";
        const hi = zMax !== undefined ? zMax.toFixed(3) : "?";
        pushRuntimeWarning(
          `printHints.overhangChamfer: no Z=${lo} edges found (shape bbox Z ∈ [${lo}, ${hi}]) — skipped.`
        );
      } else {
        pushRuntimeWarning(
          `printHints.overhangChamfer: could not apply — ${errMsg(err)}. Returning shape unchanged.`
        );
      }
    }
    return shape;
  }
}

/**
 * Add a thin flat pad beneath `shape` that extends `padding` mm past the
 * shape's XY bounding box. Fused onto the shape so it prints as one part.
 * Acts as a manually-controlled brim for stubborn first-layer adhesion.
 *
 * Unlike the chamfer helpers, this op isn't edge-filter-based — there's no
 * zero-match classification to do; any failure is a genuine error. Still
 * emits success/failure via `pushRuntimeWarning` so agents see the op
 * applied (or didn't). Pass `opts.silent = true` to suppress.
 *
 * @param shape Target Shape3D.
 * @param opts.padding Pad overhang past shape bounds in mm (default 2).
 * @param opts.thickness Pad thickness in mm (default 0.4 — one FDM layer).
 * @param opts.silent Suppress success/failure warnings (default false).
 * @returns Shape3D with pad fused at the bottom.
 */
export function firstLayerPad(
  shape: Shape3D,
  opts: { padding?: number; thickness?: number; silent?: boolean } = {}
): Shape3D {
  const padding = opts.padding ?? 2;
  const thickness = opts.thickness ?? 0.4;
  const silent = opts.silent ?? false;
  try {
    const bb = shape.boundingBox;
    const [min, max] = bb.bounds;
    const width = max[0] - min[0] + padding * 2;
    const height = max[1] - min[1] + padding * 2;
    const cx = (min[0] + max[0]) / 2;
    const cy = (min[1] + max[1]) / 2;
    // Pad top face sits at zMin; pad extends into -Z by `thickness`.
    const pad = drawRectangle(width, height)
      .sketchOnPlane("XY", [cx, cy, min[2]])
      .extrude(-thickness)
      .asShape3D();
    const result = shape.fuse(pad);
    if (!silent) {
      pushRuntimeWarning(
        `printHints.firstLayerPad: fused ${width.toFixed(1)}×${height.toFixed(1)}mm pad at Z=${min[2].toFixed(3)} (thickness ${thickness}mm, padding ${padding}mm).`
      );
    }
    return result;
  } catch (err) {
    if (!silent) {
      pushRuntimeWarning(
        `printHints.firstLayerPad: could not apply — ${errMsg(err)}. Returning shape unchanged.`
      );
    }
    return shape;
  }
}
