/**
 * Cosmetic / common-recipe fillets + chamfers.
 *
 * Every helper here wraps one of Replicad's `shape.fillet(...)` /
 * `shape.chamfer(...)` calls with a finder recipe that comes up over and
 * over in real designs (soften vertical corners of an extrusion, round
 * the top rim of a box, knock the bottom edges off a bracket so it
 * prints cleanly). Each helper:
 *
 *   1. Returns a new `Shape3D` — never mutates the input.
 *   2. Swallows OCCT "no edges matched" errors so a small radius applied
 *      to an oddly-shaped part doesn't crash the whole render; a runtime
 *      warning is emitted instead. Pass `opts.silent = true` to suppress.
 *   3. Composes naturally with the rest of the stdlib: chainable on
 *      anything that returns a `Shape3D`, including the output of
 *      `holes.through(...).translate(...)` etc.
 *
 * The selectors are intentionally tight (e.g. `softenVerticalEdges`
 * matches `inDirection("Z")` only — not 89° tilted edges) so the
 * recipes are predictable. For unusual cases, drop down to the raw
 * `shape.fillet(r, e => …)` finder DSL — see
 * `get_api_reference('finders')` for the recipe cookbook.
 */

import type { Shape3D } from "replicad";
import { EdgeFinder } from "replicad";
import { pushRuntimeWarning } from "./warnings";

/** Internal: best-effort attempt to apply a chamfer/fillet, with a
 *  graceful no-match path that emits a warning instead of throwing. */
function tryApply(
  label: string,
  shape: Shape3D,
  silent: boolean,
  fn: () => Shape3D,
): Shape3D {
  try {
    return fn();
  } catch (err) {
    if (!silent) {
      const msg = err instanceof Error ? err.message : String(err);
      pushRuntimeWarning(
        `cosmetic.${label}: could not apply — ${msg}. Returning shape unchanged.`,
      );
    }
    return shape;
  }
}

export interface CosmeticOptions {
  /** Suppress the no-match runtime warning. Default false. */
  silent?: boolean;
}

/**
 * Fillet every vertical (Z-aligned) edge by `radius`. The most common
 * "soften the outside corners of an extrusion" pattern — equivalent to
 * `shape.fillet(r, e => e.inDirection("Z"))` but with sane error
 * handling and a one-line API.
 *
 * For a box extruded along +Z this rounds the four vertical outside
 * corners. Internal vertical edges from boolean cuts (e.g. the walls
 * of a circular pocket) get caught too — `inDirection("Z")` doesn't
 * distinguish outer vs inner. Use the raw finder DSL with `.ofLength(h)`
 * to restrict to full-height edges if that bites.
 */
export function softenVerticalEdges(
  shape: Shape3D,
  radius: number,
  opts: CosmeticOptions = {},
): Shape3D {
  return tryApply("softenVerticalEdges", shape, opts.silent ?? false, () =>
    shape.fillet(radius, (e) => e.inDirection("Z")),
  );
}

/**
 * Fillet the edges sitting on the part's top face (plane `z = topZ`).
 * Useful for rounding the rim of a cylindrical post, the top edge of a
 * box, or any "round the upper outline" pattern.
 *
 * `topZ` is the Z coordinate of the top face. Pass the value you
 * extruded to (e.g. `plateT` for a plate at `Z ∈ [0, plateT]`).
 */
export function softenTopEdges(
  shape: Shape3D,
  topZ: number,
  radius: number,
  opts: CosmeticOptions = {},
): Shape3D {
  return tryApply("softenTopEdges", shape, opts.silent ?? false, () =>
    shape.fillet(radius, (e) => e.inPlane("XY", topZ)),
  );
}

/**
 * Chamfer the edges sitting on the part's bottom face (plane `z = bottomZ`,
 * default `0`) by `distance` mm. The canonical "knock the printed-bottom
 * elephant-foot off for cleaner first-layer adhesion" pattern.
 *
 * Distinct from `printHints.elephantFootChamfer`: that helper picks the
 * Z bound automatically from the shape's bounding box and uses a fixed
 * 0.4 mm default; `bottomChamfer` is the explicit-plane / explicit-size
 * version for cases where you know the Z. Pick one or the other; using
 * both stacks chamfers.
 */
export function bottomChamfer(
  shape: Shape3D,
  distance: number,
  bottomZ = 0,
  opts: CosmeticOptions = {},
): Shape3D {
  return tryApply("bottomChamfer", shape, opts.silent ?? false, () =>
    shape.chamfer(distance, (e) => e.inPlane("XY", bottomZ)),
  );
}

/**
 * Fillet every outer edge of the shape by `radius`. The "round every
 * corner" sledgehammer — handy for visual polish on simple parts; risky
 * on complex assemblies (a small radius on dozens of internal cut edges
 * is slow + sometimes non-manifold).
 *
 * Implementation: passes the bare shape to `shape.fillet(r)` without a
 * finder, which Replicad applies to every edge. Same finder-less call
 * site users would write by hand.
 */
export function softenAllEdges(
  shape: Shape3D,
  radius: number,
  opts: CosmeticOptions = {},
): Shape3D {
  return tryApply("softenAllEdges", shape, opts.silent ?? false, () =>
    shape.fillet(radius),
  );
}

/**
 * Fillet only the circular edges (hole rims, cylinder caps) by `radius`.
 * Mirrors the finders cookbook recipe `e.ofCurveType("CIRCLE")` — handy
 * when you want to soften every drilled rim without touching the prism's
 * straight edges.
 *
 * Replicad's `ofCurveType("CIRCLE")` also catches the round arcs of a
 * fillet-cut feature, so apply this BEFORE any other fillet (per the
 * "apply fillets BEFORE boolean cuts" rule in the modifications docs).
 */
export function softenCircularEdges(
  shape: Shape3D,
  radius: number,
  opts: CosmeticOptions = {},
): Shape3D {
  return tryApply("softenCircularEdges", shape, opts.silent ?? false, () =>
    shape.fillet(radius, (e) => e.ofCurveType("CIRCLE")),
  );
}

// Suppress unused-import warning on EdgeFinder — typed import kept so
// `tsserver` users get jump-to-source on the finder type when they
// open a `softenVerticalEdges` call site.
void EdgeFinder;
