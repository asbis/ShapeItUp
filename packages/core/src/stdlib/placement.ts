/**
 * Placement and type-narrowing helpers for the ShapeItUp stdlib.
 *
 * These are small utilities that remove the most common ergonomic papercuts
 * when composing cut tools with user plates.
 */

import type { Shape3D } from "replicad";

/**
 * Flip a cut-tool shape so it opens upward from Z=0 instead of downward — the
 * conventional way to place a pocket/hole on the BACK face of a plate.
 *
 * Standard (front-face) usage:
 *   plate.cut(holes.counterbore("M3", { plateThickness: 6 }).translate(x, y, 6))
 *
 * Back-face usage (e.g. heat-set insert pockets on the underside of a plate
 * whose bottom sits at Z=0):
 *   plate.cut(fromBack(inserts.pocket("M3")).translate(x, y, 0))
 *
 * Under the hood this is `tool.mirror("XY", [0, 0, 0])` — a reflection across
 * the XY plane that flips the tool's axis from -Z to +Z so it cuts inward
 * from the bottom face of the plate.
 *
 * @param tool A cut-tool Shape3D oriented per the stdlib convention (axis
 *   +Z, top at Z=0, extending into -Z).
 * @returns A new Shape3D with the tool flipped so it extends into +Z from
 *   Z=0 instead.
 */
export function fromBack(tool: Shape3D): Shape3D {
  return tool.mirror("XY", [0, 0, 0]);
}

/**
 * Type-narrowing cast from replicad's over-wide return union to Shape3D.
 *
 * Replicad's published `.d.ts` types `.extrude()` (and several sibling ops)
 * as `Shell | Solid | CompSolid | Compound | Vertex | Edge | Wire | Face` —
 * too wide to call `.cut()` or `.fuse()` on without a cast. Runtime always
 * returns a Solid.
 *
 * Wrap the extrude chain with this helper instead of sprinkling `as Shape3D`
 * in every example:
 *
 *   import { shape3d } from "shapeitup";
 *   const plate = shape3d(drawRectangle(60, 40).sketchOnPlane("XY").extrude(5));
 *   plate.cut(hole);  // OK — plate is typed Shape3D
 *
 * @param s Any value returned from a replicad extrude/revolve/loft chain.
 * @returns The same value, typed as Shape3D.
 */
export function shape3d(s: unknown): Shape3D {
  return s as Shape3D;
}
