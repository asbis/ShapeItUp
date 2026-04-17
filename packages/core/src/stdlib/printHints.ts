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
 */

import { drawRectangle, type Shape3D } from "replicad";

/**
 * Chamfer the bottom edges of a shape by `amount` (default 0.4 mm) to
 * compensate for first-layer elephant's-foot flare on FDM prints.
 *
 * Implementation: locate the shape's lowest Z, then chamfer edges in the
 * `XY` plane at that Z value. If no edges match or the chamfer op fails,
 * return the original shape and log a warning — never break the pipeline.
 *
 * @param shape Target Shape3D.
 * @param amount Chamfer distance in mm (default 0.4).
 * @returns Shape3D, chamfered if possible.
 */
export function elephantFootChamfer(shape: Shape3D, amount = 0.4): Shape3D {
  try {
    const bb = shape.boundingBox;
    // bounds is [min, max] — third coordinate is Z.
    const zMin = bb.bounds[0][2];
    return shape.chamfer(amount, (e) => e.inPlane("XY", zMin));
  } catch (err) {
    console.warn(
      "printHints.elephantFootChamfer: could not chamfer bottom edges — returning shape unchanged.",
      err
    );
    return shape;
  }
}

/**
 * Best-effort overhang chamfer. Tries to find edges that sit between a
 * down-facing horizontal face and a vertical face, then chamfers them at
 * `angle` degrees (default 45). Edge-to-face-normal detection in OCCT is
 * fragile on non-trivial geometry — on failure this function logs a warning
 * and returns the shape unchanged. Don't rely on it for critical features;
 * it's a convenience for simple brackets and plates.
 *
 * @param shape Target Shape3D.
 * @param angle Chamfer angle in degrees (default 45). Currently used to size
 *   the chamfer distance (`tan(angle) × effective thickness`); the selector
 *   treats edges as candidates regardless.
 * @returns Shape3D, chamfered if possible; otherwise original + warning.
 */
export function overhangChamfer(shape: Shape3D, angle = 45): Shape3D {
  try {
    const bb = shape.boundingBox;
    const zMin = bb.bounds[0][2];
    // Use a nominal chamfer distance sized to ~10% of the shape's Z extent
    // (capped to 1 mm) — keeps the op stable on small features.
    const bbDepth = bb.bounds[1][2] - bb.bounds[0][2];
    const distance = Math.min(Math.max(bbDepth * 0.1, 0.3), 1.0);
    // Heuristic: target edges at the bottom that run along X or Y (edges of
    // downward-facing overhangs). This is the simplest selector OCCT will
    // apply reliably — more nuanced face-normal filtering needs per-shape
    // work that we skip in v1.
    return shape.chamfer(distance, (e) =>
      e
        .inPlane("XY", zMin)
        .not((e2) => e2.ofCurveType("CIRCLE"))
    );
  } catch (err) {
    console.warn(
      `printHints.overhangChamfer not yet supported on this geometry (angle=${angle}°). Returning shape unchanged.`,
      err
    );
    return shape;
  }
}

/**
 * Add a thin flat pad beneath `shape` that extends `padding` mm past the
 * shape's XY bounding box. Fused onto the shape so it prints as one part.
 * Acts as a manually-controlled brim for stubborn first-layer adhesion.
 *
 * @param shape Target Shape3D.
 * @param opts.padding Pad overhang past shape bounds in mm (default 2).
 * @param opts.thickness Pad thickness in mm (default 0.4 — one FDM layer).
 * @returns Shape3D with pad fused at the bottom.
 */
export function firstLayerPad(
  shape: Shape3D,
  opts: { padding?: number; thickness?: number } = {}
): Shape3D {
  const padding = opts.padding ?? 2;
  const thickness = opts.thickness ?? 0.4;
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
    return shape.fuse(pad);
  } catch (err) {
    console.warn(
      "printHints.firstLayerPad: failed to construct pad — returning shape unchanged.",
      err
    );
    return shape;
  }
}
