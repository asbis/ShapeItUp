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
import * as replicad from "replicad";
import type { Point3 } from "./standards";
import { nextCutAtCallIndex, pushCutAtOutcome, pushRuntimeWarning } from "./warnings";

/**
 * Stamp `__generated__` onto a placement array so `cutAt` knows these came
 * from one of the built-in pattern generators (polar/grid/linear/etc.).
 * Generator-produced misses stay warnings — users may have computed the
 * geometry from live parameters and a runtime "just a warning" is right.
 * User-assembled explicit placements arrays are treated as assertions: a
 * miss means a typo or bad math, which `cutAt` promotes to a thrown error.
 *
 * Non-enumerable so the marker doesn't leak into `JSON.stringify`, tests
 * that snapshot placements, or downstream code that iterates keys.
 */
function markGenerated<T extends Placement[]>(arr: T): T {
  Object.defineProperty(arr, "__generated__", { value: true, enumerable: false });
  return arr;
}

/**
 * Extract a shape's axis-aligned bounding box as `[[minX,minY,minZ],[maxX,maxY,maxZ]]`.
 * Returns undefined if the shape doesn't expose a readable bbox (e.g. the
 * Replicad backend returned a degenerate result). Callers treat undefined
 * as "can't tell" and skip the no-op check rather than flagging a false
 * positive.
 */
function readBounds(shape: Shape3D): [[number, number, number], [number, number, number]] | undefined {
  try {
    const bb = (shape as any).boundingBox;
    if (!bb) return undefined;
    const bounds = bb.bounds;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !Array.isArray(bounds[0]) ||
      !Array.isArray(bounds[1]) ||
      bounds[0].length !== 3 ||
      bounds[1].length !== 3
    ) {
      return undefined;
    }
    return bounds as [[number, number, number], [number, number, number]];
  } catch {
    return undefined;
  }
}

/**
 * Best-effort volume read. Returns undefined if measurement is unavailable
 * (kernel-free mock in tests) or if the call throws — callers treat undefined
 * as "can't tell" and skip the corresponding no-op check rather than risking
 * a false positive. The measurement handle, when returned, must be deleted
 * to avoid OCCT memory leaks (same contract as in core/index.ts).
 */
function readVolume(shape: Shape3D): number | undefined {
  try {
    const measure = (replicad as any).measureShapeVolumeProperties;
    if (typeof measure !== "function") return undefined;
    const props = measure(shape);
    if (!props || typeof props.volume !== "number" || !Number.isFinite(props.volume)) {
      try { props?.delete?.(); } catch {}
      return undefined;
    }
    const v = props.volume;
    try { props.delete?.(); } catch {}
    return v;
  } catch {
    return undefined;
  }
}

/**
 * True if two AABBs are strictly disjoint on at least one axis. Shared
 * faces (one box's max == other's min) count as overlap to avoid flagging
 * grazing cuts as no-ops.
 */
function bboxDisjoint(
  a: [[number, number, number], [number, number, number]],
  b: [[number, number, number], [number, number, number]]
): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[1][i] < b[0][i] || b[1][i] < a[0][i]) return true;
  }
  return false;
}

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
  // Silent-no-op guard: a zero-radius polar pattern without orientOutward
  // places every copy at the same angle (startAngle) at the origin — so all
  // N copies coincide exactly. Users who reach for `radius: 0` almost always
  // want `orientOutward: true` (rotational-only pattern, e.g. spokes of a
  // hub). Warn — don't throw — because a handful of legitimate users want
  // stacked identical copies for manual post-processing.
  if (radius === 0 && opts.orientOutward !== true) {
    pushRuntimeWarning(
      `patterns.polar(n, 0, { orientOutward: false }) is a no-op — all ${n} copies land at the same angle. Did you mean { orientOutward: true }?`
    );
  }
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
  return markGenerated(placements);
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
  return markGenerated(placements);
}

/**
 * Remap a list of XY-plane placements onto the YZ or XZ plane. The existing
 * 2D pattern builders (`grid`, `polar`, `linear`) emit placements in the XY
 * plane; `onPlane` is a composable post-processor that rotates those
 * placements into one of the other principal planes without changing how
 * the original pattern was described.
 *
 * Mapping (translation coords):
 *   - `"XY"` — identity (returns placements unchanged).
 *   - `"YZ"` — `[x, y, z]` → `[0, x, y]` (the plane normal is +X).
 *   - `"XZ"` — `[x, y, z]` → `[x, 0, y]` (the plane normal is +Y).
 *
 * Any `rotate` value is preserved, and `axis` (if present) is remapped with
 * the same rule so a rotation that was "around the plane's normal" stays
 * that way after the remap.
 *
 * Example — drill a YZ-facing vent array into a PCB enclosure side wall:
 *
 *   patterns.cutAt(
 *     enclosure,
 *     () => cylinder({ diameter: 3, length: 10, axis: "X" }).translate(-5, 0, 0),
 *     patterns.onPlane(patterns.grid(5, 3, 6, 6), "YZ").map(p => ({
 *       ...p,
 *       translate: [wallX, p.translate[1], p.translate[2] + wallZ],
 *     })),
 *   );
 *
 * @param placements Placements to remap (typically from `grid`/`polar`/`linear`).
 * @param plane Target plane: `"XY"`, `"YZ"`, or `"XZ"`.
 */
export function onPlane(
  placements: Placement[],
  plane: "XY" | "YZ" | "XZ"
): Placement[] {
  if (plane !== "XY" && plane !== "YZ" && plane !== "XZ") {
    throw new Error(
      `patterns.onPlane: unknown plane "${plane}". Expected "XY", "YZ", or "XZ".`
    );
  }
  if (plane === "XY") return placements;

  const remap = (pt: Point3): Point3 =>
    plane === "YZ" ? [0, pt[0], pt[1]] : [pt[0], 0, pt[1]];

  const mapped = placements.map((p) => {
    const out: Placement = { translate: remap(p.translate) };
    if (p.rotate !== undefined) out.rotate = p.rotate;
    if (p.axis !== undefined) out.axis = remap(p.axis);
    return out;
  });
  // `.map()` produces a fresh array that has lost the source's `__generated__`
  // marker (non-enumerable properties aren't copied). Re-apply so a generator
  // → onPlane pipeline still marks downstream as generator-produced.
  return markGenerated(mapped);
}

/**
 * Rectangular grid placed directly on a named principal plane — shorthand
 * for `onPlane(grid(nx, ny, dx, dy), plane)`. The grid is centered on the
 * plane's origin by default (matches `grid`'s own centering behaviour); pass
 * `centered: false` to anchor the first placement at the plane origin
 * instead.
 *
 *   // 4×3 vent pattern on the XZ wall of an enclosure, 8 mm × 6 mm spacing:
 *   patterns.rectOnPlane({ plane: "XZ", nx: 4, ny: 3, dx: 8, dy: 6 })
 *
 *   // Uncentered 2×2 grid anchored at the YZ-plane origin:
 *   patterns.rectOnPlane({ plane: "YZ", nx: 2, ny: 2, dx: 5, dy: 5, centered: false })
 *
 * Implementation composes {@link grid} + {@link onPlane} so any future
 * improvement to either helper (e.g. hex-offset rows on `grid`) propagates
 * here automatically.
 *
 * @param opts.plane Principal plane: `"XY" | "YZ" | "XZ"`.
 * @param opts.nx Number of columns along the plane's first axis (≥ 1).
 * @param opts.ny Number of rows along the plane's second axis (≥ 1).
 * @param opts.dx Spacing along the plane's first axis (mm).
 * @param opts.dy Spacing along the plane's second axis (mm).
 * @param opts.centered Default `true` — matches `grid`'s built-in centering.
 *   Pass `false` to anchor the first cell at `[0, 0]` on the plane.
 */
export function rectOnPlane(opts: {
  plane: "XY" | "YZ" | "XZ";
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  centered?: boolean;
}): Placement[] {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(
      `patterns.rectOnPlane: opts must be { plane, nx, ny, dx, dy }, got ${String(opts)}.`,
    );
  }
  const { plane, nx, ny, dx, dy } = opts;
  const centered = opts.centered ?? true;
  // Delegate argument validation to `grid` — it already enforces nx/ny >= 1
  // and inherits the usual NaN-vs-finite coverage via arithmetic. `onPlane`
  // throws on unknown plane strings.
  const base = grid(nx, ny, dx, dy);
  if (!centered) {
    // `grid` is always centered; shift each placement back by `(nx-1)/2 * dx`
    // (and similarly on Y) to land the first cell at the plane-origin before
    // we delegate to `onPlane`. Done pre-remap so the shift uses grid's native
    // XY axes — `onPlane` then maps the whole pattern into the target plane.
    const shiftX = ((nx - 1) / 2) * dx;
    const shiftY = ((ny - 1) / 2) * dy;
    for (const p of base) {
      p.translate = [
        p.translate[0] + shiftX,
        p.translate[1] + shiftY,
        p.translate[2],
      ];
    }
  }
  // `onPlane` already re-marks its mapped output and identity-returns the
  // already-marked array for XY. Mark explicitly for the XY path too, in case
  // a future onPlane refactor changes the identity contract.
  return markGenerated(onPlane(base, plane));
}

/**
 * N placements along a direction vector.
 *
 * Default layout begins at the origin:
 *
 *   linear(5, [10, 0, 0])                    // (0,0,0), (10,0,0), …, (40,0,0)
 *   linear(3, [0, 15, 0])                    // 3 positions along +Y
 *
 * Pass `{ centered: true }` to shift the whole run so it's symmetric about
 * the origin (matches `grid`, which is already centered):
 *
 *   linear(4, [10, 0, 0], { centered: true }) // (-15,0,0), (-5,0,0), (5,0,0), (15,0,0)
 *
 * @param n Number of positions (≥ 1).
 * @param step Per-step translation (multiplied by the position index).
 * @param opts.centered When true, offsets every placement by `-((n-1)/2)*step`
 *   so the pattern is symmetric about the origin. Default `false` so existing
 *   callers are unaffected.
 */
export function linear(
  n: number,
  step: Point3,
  opts: { centered?: boolean } = {}
): Placement[] {
  if (n < 1) throw new Error(`linear: n must be >= 1, got ${n}`);
  // Centering offset: shifts every placement by `-((n-1)/2)*step` so indices
  // `0..n-1` land symmetric about the origin. For odd n the middle index
  // lands exactly at 0; for even n placements straddle 0 with half-step gaps.
  const shift = opts.centered === true ? (n - 1) / 2 : 0;
  // Normalize `-0` → `+0` on zero components. `step[i] * k` yields `-0` when
  // either operand is -0 OR when step[i] is 0 and k is negative (IEEE-754).
  // Downstream translate math doesn't care, but test assertions and JSON
  // round-trips surface the sign — normalize here so the pattern data is
  // clean.
  const norm = (v: number): number => (v === 0 ? 0 : v);
  const placements: Placement[] = [];
  for (let i = 0; i < n; i++) {
    const k = i - shift;
    placements.push({
      translate: [norm(step[0] * k), norm(step[1] * k), norm(step[2] * k)],
    });
  }
  return markGenerated(placements);
}

/**
 * `count` evenly-spaced placements along a single world axis between `start`
 * and `end` (inclusive endpoints). Complements {@link linear}, which takes a
 * step vector from the origin — `linearAlongAxis` takes the interval instead,
 * matching how users describe "6 holes from x=10 to x=90".
 *
 *   linearAlongAxis(1, 0, 10, "X")  // midpoint only → [{ translate: [5, 0, 0] }]
 *   linearAlongAxis(3, 0, 10, "X")  // [0,0,0], [5,0,0], [10,0,0]
 *   linearAlongAxis(5, -20, 20, "Y")  // 5 positions along Y from -20 to +20
 *
 * @param count Number of positions (≥ 1). When 1, the single placement lands
 *   at the midpoint of [start, end] (the most common "just center it"
 *   degenerate case).
 * @param start Axis coordinate of the first placement.
 * @param end Axis coordinate of the last placement.
 * @param axis World axis the line runs along: "X" | "Y" | "Z".
 */
export function linearAlongAxis(
  count: number,
  start: number,
  end: number,
  axis: "X" | "Y" | "Z",
): Placement[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`linearAlongAxis: count must be an integer >= 1, got ${count}`);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(
      `linearAlongAxis: start and end must be finite numbers, got (${start}, ${end})`,
    );
  }
  if (axis !== "X" && axis !== "Y" && axis !== "Z") {
    throw new Error(`linearAlongAxis: axis must be "X", "Y", or "Z", got ${JSON.stringify(axis)}`);
  }

  const placements: Placement[] = [];
  if (count === 1) {
    const mid = (start + end) / 2;
    const t: Point3 = [
      axis === "X" ? mid : 0,
      axis === "Y" ? mid : 0,
      axis === "Z" ? mid : 0,
    ];
    placements.push({ translate: t });
    return markGenerated(placements);
  }
  const step = (end - start) / (count - 1);
  for (let i = 0; i < count; i++) {
    const v = start + step * i;
    placements.push({
      translate: [
        axis === "X" ? v : 0,
        axis === "Y" ? v : 0,
        axis === "Z" ? v : 0,
      ],
    });
  }
  return markGenerated(placements);
}

/**
 * Fuse N copies of the shape produced by `makeShape()`, one per placement.
 * Used with positive shapes (screw heads, spokes, motor mounts) to build
 * a patterned part.
 *
 *   patterns.spread(
 *     () => screws.socket("M3x10"),
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
 * Shorthand for cutting a single tool into the TOP face of a plate.
 *
 * The plate's top-face Z is inferred from its bounding-box Z-max, and the
 * tool is translated to `(xy[0], xy[1], plateTopZ)` before cutting. This
 * removes the #1 boilerplate redundancy in the plate-with-counterbore idiom:
 *
 *   // Before (thickness appears twice — easy to drift):
 *   plate.cut(holes.counterbore("M3", { plateThickness: t }).translate(x, y, t))
 *
 *   // After:
 *   patterns.cutTop(plate, () => holes.counterbore("M3", { plateThickness: t }), [x, y])
 *
 * ### IMPORTANT — this does NOT infer the tool's internal depth.
 *
 * The factory still owns the tool's own geometry (e.g. `holes.counterbore`'s
 * `plateThickness` option). `cutTop` ONLY positions the tool at the top
 * face — it does not compute counterbore depth or shaft length for you.
 * If you want the shaft to span the plate, pass the matching thickness into
 * the factory yourself.
 *
 * @param plate Target Shape3D (must expose a readable bounding box).
 * @param toolFactory Factory that returns a fresh cut-tool Shape3D each call.
 *   Must be a function — passing a Shape3D directly throws TypeError for the
 *   same consumed-handle reason `cutAt` documents.
 * @param xy World-space `[x, y]` position at the plate's top face.
 * @returns New Shape3D with the tool cut from the top face.
 */
export function cutTop(
  plate: Shape3D,
  toolFactory: () => Shape3D,
  xy: [number, number]
): Shape3D {
  if (typeof toolFactory !== "function") {
    throw new TypeError(
      "patterns.cutTop: `toolFactory` must be a factory function `() => Shape3D`, not a Shape3D directly. " +
        "Wrap your tool creation in `() => ...` so each cut gets a fresh OCCT handle."
    );
  }
  const bounds = readBounds(plate);
  if (!bounds) {
    throw new Error(
      "patterns.cutTop: cannot read plate bounding box — pass a solid Shape3D with a readable boundingBox."
    );
  }
  const zTop = bounds[1][2];
  const tool = toolFactory().translate(xy[0], xy[1], zTop);
  return plate.cut(tool);
}

/**
 * Shorthand for cutting a single tool into the BOTTOM face of a plate.
 *
 * Mirror of {@link cutTop}: plate's bottom-face Z is inferred from its
 * bounding-box Z-min, and the tool is translated to
 * `(xy[0], xy[1], plateBottomZ)` before cutting. Typical use is a heat-set
 * insert pocket opening on the underside:
 *
 *   patterns.cutBottom(plate, () => inserts.pocket("M3"), [x, y])
 *
 * Same caveat as `cutTop`: the tool's internal geometry (depth, etc.) is
 * NOT inferred — this helper ONLY positions the tool at the bottom face.
 *
 * @param plate Target Shape3D (must expose a readable bounding box).
 * @param toolFactory Factory that returns a fresh cut-tool Shape3D each call.
 * @param xy World-space `[x, y]` position at the plate's bottom face.
 * @returns New Shape3D with the tool cut from the bottom face.
 */
export function cutBottom(
  plate: Shape3D,
  toolFactory: () => Shape3D,
  xy: [number, number]
): Shape3D {
  if (typeof toolFactory !== "function") {
    throw new TypeError(
      "patterns.cutBottom: `toolFactory` must be a factory function `() => Shape3D`, not a Shape3D directly. " +
        "Wrap your tool creation in `() => ...` so each cut gets a fresh OCCT handle."
    );
  }
  const bounds = readBounds(plate);
  if (!bounds) {
    throw new Error(
      "patterns.cutBottom: cannot read plate bounding box — pass a solid Shape3D with a readable boundingBox."
    );
  }
  const zBot = bounds[0][2];
  const tool = toolFactory().translate(xy[0], xy[1], zBot);
  return plate.cut(tool);
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
 * @param opts.name Optional tag shown in no-op warnings (e.g.
 *   `"motor-mount-holes"`). When several `cutAt` calls appear in one script,
 *   a bare warning forces the engineer to search; the tag identifies the
 *   offender directly. If omitted, the call's 1-based ordinal is shown
 *   instead (`"patterns.cutAt call #3: …"`).
 * @returns New Shape3D with all N cuts applied in sequence.
 */
export function cutAt(
  target: Shape3D,
  makeTool: () => Shape3D,
  placements: Placement[],
  opts: { name?: string } = {}
): Shape3D {
  // P3-7 runtime guard: users sometimes pass a Shape3D directly instead of a
  // factory. The type-level contract (() => Shape3D) catches the common case,
  // but plain JS callers and `as any` escapes slip through. A shared shape
  // here silently produces a deleted-OCCT-handle crash after the first
  // placement (because replicad's translate/rotate consume the input); reject
  // fast with an explanation that tells the user exactly how to fix it.
  if (typeof makeTool !== "function") {
    throw new TypeError(
      "patterns.cutAt: the `toolFactory` argument must be a factory function `() => Shape3D`, not a Shape3D directly. " +
        "Replicad's OCCT handles are consumed by translate/rotate, so a shared shape would be deleted after the first placement. " +
        "Wrap your tool creation in `() => ...`: e.g. `patterns.cutAt(plate, () => holes.through('M4'), placements)`."
    );
  }
  // Attribution prefix for any warning emitted by this call. Prefer the
  // caller-supplied name (cheap to add, turns a search into a direct hit);
  // fall back to the per-execution call ordinal so unnamed calls are still
  // disambiguated. Always consume the counter even when a name is provided,
  // so subsequent unnamed calls keep their numbering stable.
  const callIndex = nextCutAtCallIndex();
  const label = opts.name
    ? `patterns.cutAt "${opts.name}"`
    : `patterns.cutAt call #${callIndex}`;
  // Silent-no-op guard: a placed tool whose AABB is strictly disjoint from
  // the target's AABB can't intersect the target, so the cut is guaranteed
  // to do nothing. Read bounds up-front (target's AABB is stable across
  // cuts) and per-placement (each tool is a fresh handle). Warn once at
  // the end — we don't want to spam the user with one line per bad
  // placement. Bounds read is best-effort; on failure we silently skip
  // the check rather than risk false positives.
  const targetBounds = readBounds(target);
  let disjointCount = 0;
  let checkedCount = 0;
  // Track which placements failed the bbox-overlap check so the warning
  // can name them directly — "indices [0, 3, 4]" is far more actionable
  // than a bare "2 of 4 were outside" count. The index is the position in
  // the caller-supplied `placements` array (0-based, matching how users
  // would index into it themselves).
  const failedIndices: number[] = [];
  // Cache the first observed tool bbox. When the post-cut volume guard
  // fires, we want to show the user where the cutter actually sat relative
  // to the target — without this, "no material removal" tells them the
  // symptom but not why. First-placement bounds are representative for
  // most patterns (linear/grid/polar copies share a shape, only translate
  // changes); showing one is strictly more helpful than showing none.
  let firstToolBounds:
    | [[number, number, number], [number, number, number]]
    | undefined;

  // Snapshot the input volume for the post-cut no-op guard. Bbox-overlap is
  // necessary for a cut to remove material but not sufficient — the tool may
  // still sit entirely outside the solid's actual geometry (a common source
  // of confusion is `sketchOnPlane("XZ").extrude(L)` growing toward -Y when
  // the user expected +Y, so tools placed at positive Y never intersect the
  // plate). When bboxes overlap, only a volume measurement can catch this.
  const inputVolume = readVolume(target);

  let result = target;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    // The bbox check MUST read bounds AFTER applyPlacement has baked in the
    // placement's rotate+translate, so the AABB we compare is world-space
    // (the same space targetBounds lives in). If the factory itself returns
    // a shape that's already been rotated/translated, Replicad's boundingBox
    // getter recomputes via BRepBndLib::Add on the current TopoDS_Shape —
    // so it reflects any transforms already baked in. Reading before
    // applyPlacement (or from a local pre-transform pose) would miss this
    // entirely — a rotated cylinder's world AABB is very different from
    // its unrotated pose's AABB.
    const placedTool = applyPlacement(makeTool(), p);
    if (targetBounds) {
      const toolBounds = readBounds(placedTool);
      if (toolBounds) {
        checkedCount++;
        if (!firstToolBounds) firstToolBounds = toolBounds;
        if (bboxDisjoint(targetBounds, toolBounds)) {
          disjointCount++;
          failedIndices.push(i);
        }
      }
    }
    result = result.cut(placedTool);
  }

  // Render a list of failing placement indices for the warning body. Cap
  // at 10 to keep warnings readable; when truncated we show the first 8
  // plus a "… N more" tail so users see both the head of the list and the
  // rough scale of the problem.
  const formatFailedIndices = (indices: number[]): string =>
    indices.length <= 10
      ? `[${indices.join(", ")}]`
      : `[${indices.slice(0, 8).join(", ")}, ... ${indices.length - 8} more]`;

  // Severity promotion (P9): generator-produced placement arrays carry a
  // non-enumerable `__generated__` marker (see markGenerated in this file).
  // Arrays built by hand (e.g. user-listed `[{ translate: [...] }, ...]`)
  // don't have the marker — those are treated as explicit assertions, so a
  // miss indicates a typo or bad math that should fail the render loudly
  // rather than silently warn. Generator misses stay warnings because users
  // often compute placements from live params and a warning is the right
  // severity for "your math puts some copies outside the target".
  const isExplicit = !(placements as any).__generated__;

  if (checkedCount > 0 && disjointCount === checkedCount) {
    // When every placement fails, the index list is largely redundant
    // ("all of them") — but for small arrays it's still mildly useful as
    // a sanity check (did the count match what the caller passed in?).
    // Skip it for brevity once the user obviously needs to re-examine
    // placement coordinates rather than individual indices.
    const msg =
      `${label}: all ${checkedCount} tool placement${checkedCount === 1 ? "" : "s"} ` +
      `${checkedCount === 1 ? "was" : "were"} outside the target's bounding box — no material removed. ` +
      `Check placement coordinates against the target's position.`;
    if (isExplicit) {
      // Record the outcome BEFORE throwing so aggregate reporting still
      // includes the failed call (cutAt never returned a shape).
      pushCutAtOutcome(false);
      throw new Error(`[patterns.cutAt] ${msg}`);
    }
    pushRuntimeWarning(msg);
    pushCutAtOutcome(false);
  } else if (disjointCount > 0) {
    const msg =
      `${label}: ${disjointCount} of ${checkedCount} tool placements were outside the target's bounding box — ` +
      `those cuts removed no material. Failed placement indices: ${formatFailedIndices(failedIndices)}.`;
    if (isExplicit) {
      pushCutAtOutcome(false);
      throw new Error(`[patterns.cutAt] ${msg}`);
    }
    pushRuntimeWarning(msg);
    pushCutAtOutcome(false);
  }

  // Post-cut volume no-op guard. Only fires when we have BOTH a before and
  // after measurement AND neither bbox-disjoint warning fired (otherwise
  // we'd double-warn). Tolerance: 1e-6 mm³ — below OCCT's own measurement
  // noise floor on well-formed solids, so any real material removal beats it.
  let volumeGuardFired = false;
  if (
    disjointCount === 0 &&
    typeof inputVolume === "number" &&
    inputVolume > 0
  ) {
    const outputVolume = readVolume(result);
    if (
      typeof outputVolume === "number" &&
      Math.abs(outputVolume - inputVolume) < 1e-6
    ) {
      volumeGuardFired = true;
      // Per-axis diagnostic using the first observed tool bbox. When the
      // cutter and target overlap on every axis the hint is empty — the
      // no-op is caused by something subtler (interior placement, tolerance)
      // and pretending to point at an axis would mislead.
      let axisHint = "";
      if (targetBounds && firstToolBounds) {
        const axes = ["X", "Y", "Z"] as const;
        // Human-readable direction labels per axis. Matches the index-level
        // `directionalShiftHint` wording so the two warning paths read the
        // same way to engineers comparing raw `.cut()` vs `patterns.cutAt`.
        const labels: Record<"X" | "Y" | "Z", [string, string]> = {
          X: ["LEFT-OF", "RIGHT-OF"],
          Y: ["IN-FRONT-OF", "BEHIND"],
          Z: ["BELOW", "ABOVE"],
        };
        for (let i = 0; i < 3; i++) {
          const tMin = targetBounds[0][i];
          const tMax = targetBounds[1][i];
          const cMin = firstToolBounds[0][i];
          const cMax = firstToolBounds[1][i];
          if (cMax < tMin || cMin > tMax) {
            const axis = axes[i];
            const [lowLabel, highLabel] = labels[axis];
            const below = cMax < tMin;
            const direction = below ? lowLabel : highLabel;
            const gap = below ? tMin - cMax : cMin - tMax;
            const shiftSign = below ? "+" : "-";
            let shiftLine = "";
            if (Number.isFinite(gap) && gap > 0) {
              shiftLine =
                `\n  Cutter is ${direction} target. ` +
                `Translate the tool by ${shiftSign}${gap.toFixed(2)} mm on ${axis} ` +
                `(or adjust the placement sign) so its body overlaps the target.`;
            }
            axisHint =
              `\n  Target ${axis} ∈ [${tMin.toFixed(2)}, ${tMax.toFixed(2)}], ` +
              `cutter ${axis} ∈ [${cMin.toFixed(2)}, ${cMax.toFixed(2)}] — disjoint on ${axis} axis.` +
              shiftLine;
            break;
          }
        }
      }
      pushRuntimeWarning(
        `${label}: cut produced no material removal — input and output volumes are equal (V=${inputVolume.toFixed(2)} mm³).\n` +
          `Common causes:\n` +
          `  - the cutter solid is disjoint from the target (wrong Y/Z sign)\n` +
          `  - sketchOnPlane("XZ").extrude(L) grows toward -Y, not +Y — try sketchOnPlane("XZ").extrude(-L)\n` +
          `  - the cutter is inside the solid but smaller than the measurement tolerance` +
          axisHint
      );
      pushCutAtOutcome(false);
    } else if (
      typeof outputVolume === "number" &&
      outputVolume < inputVolume
    ) {
      // Material actually came off — record a success outcome so the
      // aggregate "N/M cutAt calls removed no material" summary in MCP
      // knows this call was healthy.
      pushCutAtOutcome(true);
    }
  }

  return result;
}
