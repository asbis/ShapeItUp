/**
 * Pattern helpers — generate arrays of placements (position + optional
 * rotation), then apply them to a shape in one of two ways:
 *
 *   spread(shape, placements)       → fuse N copies of a positive shape
 *   cutAt(target, tool, placements) → cut N copies of a cut tool
 *
 * Patterns return plain data (arrays of {translate, rotate?, axis?}) so
 * users can build their own application logic for unusual cases (e.g.
 * varying hole sizes per position).
 */

import type { Shape3D } from "replicad";
import type { Point3 } from "./standards";

/** A single placement in a pattern: translation + optional rotation around an axis. */
export interface Placement {
  /** World-space translation applied to the shape. */
  translate: Point3;
  /** Optional rotation, in degrees. Omit for translate-only placements. */
  rotate?: number;
  /** Rotation axis. Defaults to [0, 0, 1] (+Z). Ignored if `rotate` is undefined. */
  axis?: Point3;
}

/**
 * Apply a single placement to a shape: rotate (around the origin) first,
 * then translate. Useful when composing patterns manually.
 */
export function applyPlacement(shape: Shape3D, p: Placement): Shape3D {
  let result = shape;
  if (p.rotate !== undefined) {
    result = result.rotate(p.rotate, [0, 0, 0], p.axis ?? [0, 0, 1]);
  }
  result = result.translate(p.translate[0], p.translate[1], p.translate[2]);
  return result;
}

/**
 * N evenly-spaced points around a circle. Default plane is XY (axis = Z) —
 * pass `axis: "X"` or `"Y"` to rotate the pattern into a different plane.
 *
 *   polar(6, 20)                        // 6 positions on a 20mm-radius circle
 *   polar(4, 15, { startAngle: 45 })    // first point at 45°
 *   polar(6, 25, { orientOutward: true }) // each copy rotated to face +X outward
 *
 * @param n Number of positions (≥ 1).
 * @param radius Circle radius in mm.
 * @param opts.startAngle Angle of the first position in degrees (default 0 = +X).
 * @param opts.axis "X", "Y", or "Z" (default "Z"). Sets the pattern's normal.
 * @param opts.orientOutward If true, each placement rotates its shape so that
 *   its local +X axis points outward from the center (useful when the shape
 *   itself has an intrinsic "outward" direction — e.g. a spoke, a mounting tab).
 */
export function polar(
  n: number,
  radius: number,
  opts: {
    startAngle?: number;
    axis?: "X" | "Y" | "Z";
    orientOutward?: boolean;
  } = {}
): Placement[] {
  if (n < 1) throw new Error(`polar: n must be >= 1, got ${n}`);
  const start = opts.startAngle ?? 0;
  const axis = opts.axis ?? "Z";
  const placements: Placement[] = [];
  for (let i = 0; i < n; i++) {
    const angleDeg = start + (360 * i) / n;
    const a = (angleDeg * Math.PI) / 180;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    let translate: Point3;
    let rotAxis: Point3 = [0, 0, 1];
    if (axis === "Z") {
      translate = [c, s, 0];
      rotAxis = [0, 0, 1];
    } else if (axis === "Y") {
      translate = [c, 0, s];
      rotAxis = [0, 1, 0];
    } else {
      translate = [0, c, s];
      rotAxis = [1, 0, 0];
    }
    const placement: Placement = { translate };
    if (opts.orientOutward) {
      placement.rotate = angleDeg;
      placement.axis = rotAxis;
    }
    placements.push(placement);
  }
  return placements;
}

/**
 * 2D grid of placements on the XY plane, centered on the origin.
 *
 *   grid(3, 4, 10)       // 3×4 grid, 10mm spacing both axes
 *   grid(3, 4, 10, 15)   // 3×4 grid, 10mm along X, 15mm along Y
 *
 * For a 1-column or 1-row grid the corresponding spacing is still required
 * (and ignored on the singleton axis).
 *
 * @param nx Number of columns along X (≥ 1).
 * @param ny Number of rows along Y (≥ 1).
 * @param dx Column spacing in mm.
 * @param dy Row spacing in mm. Defaults to `dx`.
 */
export function grid(
  nx: number,
  ny: number,
  dx: number,
  dy?: number
): Placement[] {
  if (nx < 1 || ny < 1) throw new Error(`grid: nx and ny must be >= 1`);
  const spacingY = dy ?? dx;
  const x0 = -((nx - 1) * dx) / 2;
  const y0 = -((ny - 1) * spacingY) / 2;
  const placements: Placement[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      placements.push({
        translate: [x0 + ix * dx, y0 + iy * spacingY, 0],
      });
    }
  }
  return placements;
}

/**
 * N placements along a direction vector, starting at the origin.
 *
 *   linear(5, [10, 0, 0])  // 5 positions: (0,0,0), (10,0,0), ..., (40,0,0)
 *   linear(3, [0, 15, 0])  // 3 positions along +Y
 *
 * @param n Number of positions (≥ 1).
 * @param step Translation applied cumulatively at each step.
 */
export function linear(n: number, step: Point3): Placement[] {
  if (n < 1) throw new Error(`linear: n must be >= 1, got ${n}`);
  const placements: Placement[] = [];
  for (let i = 0; i < n; i++) {
    placements.push({
      translate: [step[0] * i, step[1] * i, step[2] * i],
    });
  }
  return placements;
}

/**
 * Fuse N copies of the shape produced by `makeShape()`, one per placement.
 * Used with positive shapes (screw heads, spokes, motor mounts) to build
 * a patterned part.
 *
 *   patterns.spread(
 *     () => screws.socketHead("M3x10"),
 *     patterns.polar(6, 20),
 *   )
 *
 * ### Why is this a factory, not a shape?
 *
 * Replicad's `.translate()` / `.rotate()` can share the underlying OCCT
 * handle with the source shape. Calling them N times on the same shape
 * then fusing/cutting the results invalidates the earlier copies ("this
 * object has been deleted"). Passing a factory guarantees every placement
 * gets a fresh handle.
 *
 * Returns a single fused Shape3D — adjacent copies may merge where they
 * touch. For patterns where copies must stay separate parts (e.g. for
 * multi-color rendering), apply placements manually with `applyPlacement`
 * and return the array to the viewer yourself.
 *
 * @param makeShape Factory that returns a fresh positive Shape3D each call.
 * @param placements Array of placements from `polar` / `grid` / `linear`.
 * @returns Single fused Shape3D containing all copies.
 */
export function spread(makeShape: () => Shape3D, placements: Placement[]): Shape3D {
  if (placements.length === 0) {
    throw new Error("patterns.spread: placements array is empty");
  }
  const [first, ...rest] = placements;
  let result = applyPlacement(makeShape(), first);
  for (const p of rest) {
    result = result.fuse(applyPlacement(makeShape(), p));
  }
  return result;
}

/**
 * Cut N copies of the shape produced by `makeTool()` from `target`, one per
 * placement. The common case for bolt circles, vent grids, PCB standoffs:
 *
 *   const plate = drawRoundedRectangle(80, 60, 3).sketchOnPlane("XY").extrude(5);
 *   const result = patterns.cutAt(
 *     plate,
 *     () => holes.counterbore("M3", { plateThickness: 5 }).translate(0, 0, 5),
 *     patterns.polar(6, 25),
 *   );
 *
 * ### Why is this a factory, not a shape?
 *
 * Replicad shares OCCT handles across `.translate()` / `.rotate()` calls;
 * reusing one tool across multiple cuts invalidates earlier copies. A
 * factory guarantees each placement gets a fresh handle. In practice the
 * factory is just an arrow function wrapping the tool expression.
 *
 * @param target Shape3D to cut from.
 * @param makeTool Factory that returns a fresh cut-tool Shape3D each call
 *   (axis +Z, top at Z=0). Include any per-tool translate() inside the
 *   factory — e.g. `() => holes.through("M3").translate(0, 0, thickness)`.
 * @param placements Array of placements from `polar` / `grid` / `linear`.
 * @returns New Shape3D with all N cuts applied in sequence.
 */
export function cutAt(
  target: Shape3D,
  makeTool: () => Shape3D,
  placements: Placement[]
): Shape3D {
  let result = target;
  for (const p of placements) {
    result = result.cut(applyPlacement(makeTool(), p));
  }
  return result;
}
