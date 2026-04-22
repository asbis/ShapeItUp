/**
 * shapes.ts — axis-explicit primitive solid builders.
 *
 * Two helpers that cover the "I just want a box / a prism along some axis"
 * case without forcing users to reason about Replicad's plane-native
 * extrude-direction quirks (see `placement.ts` for the full writeup).
 *
 *   box({ from: [0, 0, 0], to: [40, 20, 10] })               // axis-aligned block
 *   prism({ profile: drawCircle(5), along: "+Y", length: 30 })
 */

import {
  drawRectangle,
  drawRoundedRectangle,
  makeBox,
  type DrawingInterface,
  type Shape3D,
} from "replicad";
import type { Point3 } from "./standards";

// ── box ────────────────────────────────────────────────────────────────────

/** Corner-to-corner box options. Both corners are inclusive world-space points. */
export interface BoxOpts {
  /** Lower-corner in world coords `[x, y, z]`. Must be strictly less than `to` on every axis. */
  from: Point3;
  /** Upper-corner in world coords `[x, y, z]`. Every component must exceed `from`. */
  to: Point3;
  /**
   * Optional fillet radius (mm) applied to the four vertical (Z-parallel) edges
   * of the box — the typical "rounded slab / rounded pad" shape. Must be a
   * finite non-negative number strictly less than half the shorter in-plane
   * edge (`min(dx, dy) / 2`). When omitted or 0 the box has hard corners and
   * the helper falls back to Replicad's plain `makeBox`.
   */
  rounded?: number;
}

/**
 * Axis-aligned box defined by two opposite corners — wraps Replicad's
 * `makeBox([x0,y0,z0], [x1,y1,z1])` with up-front validation so a swapped
 * corner (or a zero-size axis) produces a readable error instead of an
 * opaque OCCT pointer exception.
 *
 *   box({ from: [0, 0, 0], to: [40, 20, 10] })                 // 40×20×10 block, corner at origin
 *   box({ from: [-10, -10, 0], to: [10, 10, 5] })              // centered 20×20 pad 5 mm tall
 *   box({ from: [0, 0, 0], to: [40, 20, 10], rounded: 3 })     // same block, 3 mm vertical-edge fillets
 *
 * When `rounded` is set the four vertical (Z-parallel) edges are filleted —
 * the overall bounding box is unchanged (rounding only removes material from
 * the corners, never adds). Rounding the top/bottom Z-faces is not supported
 * here; use Replicad's `.fillet()` on picked edges for that.
 *
 * @throws TypeError if `to[i] <= from[i]` on any axis (the error names which axis).
 * @throws RangeError if `rounded` is negative or >= min(dx, dy) / 2.
 */
export function box(opts: BoxOpts): Shape3D {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(`box: opts must be { from: [x,y,z], to: [x,y,z], rounded? }, got ${String(opts)}.`);
  }
  const { from, to, rounded } = opts;
  const assertPoint = (label: string, p: unknown): void => {
    if (
      !Array.isArray(p) ||
      p.length !== 3 ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      !Number.isFinite(p[2])
    ) {
      throw new TypeError(
        `box: ${label} must be a 3-element array of finite numbers [x, y, z], got ${JSON.stringify(p)}.`,
      );
    }
  };
  assertPoint("from", from);
  assertPoint("to", to);
  const axes = ["X", "Y", "Z"] as const;
  for (let i = 0; i < 3; i++) {
    if (to[i] <= from[i]) {
      throw new RangeError(
        `box: to.${axes[i]} (${to[i]}) must be greater than from.${axes[i]} (${from[i]}) — ` +
          `swapped corners or zero-thickness axis.`,
      );
    }
  }

  // Fast path — no rounding requested, delegate straight to OCCT's primitive.
  if (rounded === undefined || rounded === 0) {
    return makeBox(from as [number, number, number], to as [number, number, number]) as Shape3D;
  }

  if (typeof rounded !== "number" || !Number.isFinite(rounded) || rounded < 0) {
    throw new TypeError(
      `box: rounded must be a finite non-negative number, got ${String(rounded)}.`,
    );
  }
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const maxRadius = Math.min(dx, dy) / 2;
  if (rounded >= maxRadius) {
    throw new RangeError(
      `box: rounded (${rounded}) must be strictly less than half the shorter in-plane edge ` +
        `(min(dx=${dx}, dy=${dy}) / 2 = ${maxRadius}). Use a smaller radius or enlarge the box.`,
    );
  }

  // drawRoundedRectangle(w, h, r) is centred on the sketch-plane origin; sketch
  // on XY, extrude along +Z for dz, then translate the centre to land the
  // extruded body's bounding box exactly on [from, to] (near face at
  // z = from[2], far face at z = from[2] + dz = to[2]).
  const cx = (from[0] + to[0]) / 2;
  const cy = (from[1] + to[1]) / 2;
  const extruded = drawRoundedRectangle(dx, dy, rounded)
    .sketchOnPlane("XY")
    .extrude(dz) as unknown as Shape3D;
  return extruded.translate(cx, cy, from[2]);
}

// ── prism ──────────────────────────────────────────────────────────────────

/** Axis shorthand shared with `cylinder()`. */
export type PrismAxis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

/** Options for {@link prism}. */
export interface PrismOpts {
  /** A 2D `Drawing` (e.g. `drawRectangle`, `drawCircle`, `draw().close()`). */
  profile: DrawingInterface;
  /** Extrusion direction. Same union as `cylinder()`'s `direction`. Default `"+Z"`. */
  along?: PrismAxis;
  /** Axial length in mm (positive, finite). */
  length: number;
  /** Optional axial offset along `along`. Default 0 — prism spans `[0, length]` on the axis. */
  from?: number;
}

/**
 * Plane / extrude-sign / world-axis lookup per axis.
 *
 *   +Z → sketchOnPlane("XY"), extrude(+L), grows  +Z natively   → [0, +L]
 *   -Z → sketchOnPlane("XY"), extrude(-L), grows  -Z            → [-L, 0]
 *   +Y → sketchOnPlane("XZ"), extrude(-L), grows  +Y (XZ is -Y native) → [0, +L]
 *   -Y → sketchOnPlane("XZ"), extrude(+L), grows  -Y natively    → [-L, 0]
 *   +X → sketchOnPlane("YZ"), extrude(+L), grows  +X natively    → [0, +L]
 *   -X → sketchOnPlane("YZ"), extrude(-L), grows  -X             → [-L, 0]
 *
 * The "positive" axis forms always land the prism in `[0, +length]` on the
 * named axis; the "negative" forms land it in `[-length, 0]`. Adding `from`
 * shifts the whole interval along the axis by that scalar.
 */
const PRISM_AXIS: Record<
  PrismAxis,
  { plane: "XY" | "XZ" | "YZ"; sign: 1 | -1; worldAxis: 0 | 1 | 2 }
> = {
  "+Z": { plane: "XY", sign: 1,  worldAxis: 2 },
  "-Z": { plane: "XY", sign: -1, worldAxis: 2 },
  "+Y": { plane: "XZ", sign: -1, worldAxis: 1 },
  "-Y": { plane: "XZ", sign: 1,  worldAxis: 1 },
  "+X": { plane: "YZ", sign: 1,  worldAxis: 0 },
  "-X": { plane: "YZ", sign: -1, worldAxis: 0 },
};

/**
 * Extrude a 2D drawing along a named world axis, landing the result in a
 * predictable half-space on that axis.
 *
 * For `along: "+Z"` / `"+Y"` / `"+X"` (default `"+Z"`) the prism's bounding
 * box on the named axis is `[from, from + length]`. For the negative forms
 * it's `[from - length, from]`. No sign guessing — the helper does the
 * plane-and-translate math for you.
 *
 *   // 30 mm-tall pad on +Z (like sketchOnPlane("XY").extrude(30)):
 *   prism({ profile: drawRectangle(40, 20), along: "+Z", length: 30 })
 *
 *   // Sideways prism growing along +Y from the XZ plane:
 *   prism({ profile: drawCircle(5), along: "+Y", length: 50 })
 *
 *   // Start 10 mm in on the +X axis:
 *   prism({ profile: drawRectangle(10, 10), along: "+X", length: 25, from: 10 })
 *   //   → bbox X ∈ [10, 35]
 */
export function prism(opts: PrismOpts): Shape3D {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(
      `prism: opts must be { profile, along, length, from? }, got ${String(opts)}.`,
    );
  }
  const { profile, along = "+Z", length, from = 0 } = opts;
  if (
    profile == null ||
    typeof (profile as { sketchOnPlane?: unknown }).sketchOnPlane !== "function"
  ) {
    throw new TypeError(
      `prism: profile must be a Replicad Drawing (drawRectangle / drawCircle / draw()...close()); ` +
        `got ${profile === null ? "null" : typeof profile}.`,
    );
  }
  if (typeof length !== "number" || !Number.isFinite(length) || length <= 0) {
    throw new TypeError(
      `prism: length must be a finite positive number, got ${String(length)}.`,
    );
  }
  if (typeof from !== "number" || !Number.isFinite(from)) {
    throw new TypeError(`prism: from must be a finite number, got ${String(from)}.`);
  }
  const entry = PRISM_AXIS[along];
  if (!entry) {
    throw new TypeError(
      `prism: along must be one of "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", got ${JSON.stringify(along)}.`,
    );
  }

  const sketch = profile.sketchOnPlane(entry.plane);
  // Replicad's `.extrude()` return union is wider than Shape3D; at runtime a
  // Drawing-on-plane extrude always yields a Solid, so the cast is safe.
  const extruded = (sketch as unknown as { extrude: (d: number) => unknown })
    .extrude(entry.sign * length) as Shape3D;

  // Post-extrude bbox on the named axis is [0, +length] for positive `along`,
  // [-length, 0] for negative. `from` shifts the whole interval — zero shift
  // short-circuits to avoid consuming the fresh extrude handle unnecessarily.
  if (from === 0) return extruded;
  const dx = entry.worldAxis === 0 ? from : 0;
  const dy = entry.worldAxis === 1 ? from : 0;
  const dz = entry.worldAxis === 2 ? from : 0;
  return extruded.translate(dx, dy, dz);
}

// ── plate ──────────────────────────────────────────────────────────────────

/** Options for {@link plate}. */
export interface PlateOpts {
  /** In-plane rectangle dimensions `[width, height]` in mm (both > 0, finite). */
  size: [number, number];
  /** Plate thickness along `normal` in mm (positive, finite). */
  thickness: number;
  /**
   * Which way the plate's outward ("near") face points. The near face lands
   * AT the origin on that axis; the body extends `thickness` into the axis's
   * interior. Default `"+Z"`.
   *
   * Example: `normal: "+Y"` puts the near face at y=0 and the body at y∈[0, t];
   * `normal: "-Y"` puts the near face at y=0 and the body at y∈[-t, 0].
   */
  normal?: PrismAxis;
  /**
   * When `true` (default), the plate is centered on the two IN-PLANE axes —
   * i.e. the bbox straddles the origin on the width/height directions. Set
   * `false` to anchor the lower in-plane corner at the origin.
   */
  center?: boolean;
}

/**
 * Rectangular plate of the given `size` and `thickness`, oriented so its near
 * face (the one pointed to by `normal`) sits AT the origin on that axis. This
 * matches the `holes.*` anchor convention — you can `plate.cut(holes.through(...))`
 * without any extra translate on the thickness axis.
 *
 *   // 60×40×5 plate centered on XY, top face (near face) at z=0, body in z∈[-5, 0]:
 *   plate({ size: [60, 40], thickness: 5, normal: "-Z" })
 *
 *   // Same plate but with body growing into +Z (near face at z=0, body in z∈[0, 5]):
 *   plate({ size: [60, 40], thickness: 5 })          // normal defaults to "+Z"
 *
 *   // Side wall standing on +Y: in-plane dims are X×Z, body extends y∈[0, 3]:
 *   plate({ size: [80, 40], thickness: 3, normal: "+Y" })
 *
 * Under the hood this delegates to {@link prism} with a centered rectangle
 * profile — {@link prism} owns the plane/sign table that maps each axis to
 * the right `sketchOnPlane` + extrude sign.
 *
 * @throws TypeError on non-finite / non-positive dimensions or unknown `normal`.
 */
export function plate(opts: PlateOpts): Shape3D {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(
      `plate: opts must be { size: [w, h], thickness, normal?, center? }, got ${String(opts)}.`,
    );
  }
  const { size, thickness, normal = "+Z", center = true } = opts;
  if (
    !Array.isArray(size) ||
    size.length !== 2 ||
    !Number.isFinite(size[0]) ||
    !Number.isFinite(size[1]) ||
    size[0] <= 0 ||
    size[1] <= 0
  ) {
    throw new TypeError(
      `plate: size must be [width, height] of two finite positive numbers, got ${JSON.stringify(size)}.`,
    );
  }
  if (typeof thickness !== "number" || !Number.isFinite(thickness) || thickness <= 0) {
    throw new TypeError(
      `plate: thickness must be a finite positive number, got ${String(thickness)}.`,
    );
  }
  if (!(normal in PRISM_AXIS)) {
    throw new TypeError(
      `plate: normal must be one of "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", got ${JSON.stringify(normal)}.`,
    );
  }
  const [w, h] = size;
  // drawRectangle is centered on the in-plane origin; translate afterwards if
  // the caller opted out of centering. Because prism picks the in-plane
  // sketch plane from `along`, `drawRectangle(w, h)` is automatically
  // interpreted in the right plane (XY / XZ / YZ) for each normal.
  const profile = center
    ? drawRectangle(w, h)
    : drawRectangle(w, h).translate(w / 2, h / 2);
  return prism({ profile, along: normal, length: thickness });
}

// ── wall ───────────────────────────────────────────────────────────────────

/** Options for {@link wall}. */
export interface WallOpts {
  /**
   * Outward-facing normal of the wall (which direction the "near" face points).
   * Same axis shorthand as {@link plate}'s `normal`. The wall body extends
   * `thickness` into the axis's interior (near face AT the origin on that axis).
   */
  axis: PrismAxis;
  /** Extent along `axis` in mm (positive, finite). */
  thickness: number;
  /** First transverse (in-plane) dimension in mm (positive, finite). */
  width: number;
  /** Second transverse (in-plane) dimension in mm (positive, finite). */
  height: number;
  /**
   * When `true`, anchor the "height" transverse axis at 0 (base sits at 0 on
   * the more-vertical transverse axis) instead of centering it. Default
   * `false` — both transverse axes are centered, matching `plate()`'s
   * default.
   *
   * Convention: for `axis` ∈ {"+X", "-X", "+Y", "-Y"} the wall's in-plane
   * axes are the remaining horizontal axis (width) + world Z (height), so
   * `baseAtZero: true` makes the wall's Z span `[0, height]`. For
   * `axis` ∈ {"+Z", "-Z"} (a flat slab on XY) there is no vertical
   * transverse axis, so `baseAtZero` is a no-op — the helper still accepts
   * the flag so call sites stay symmetric.
   */
  baseAtZero?: boolean;
}

/**
 * Vertical wall / panel — a plate whose outward normal is named by `axis`,
 * with the common "base sits at Z=0" anchoring option built in. Spares users
 * the `sketchOnPlane("YZ", -T/2).extrude(T)` incantation for end caps and
 * side panels.
 *
 *   // +X-facing end cap, 80 mm wide × 120 mm tall, 4 mm thick, base on ground:
 *   wall({ axis: "+X", thickness: 4, width: 80, height: 120, baseAtZero: true })
 *
 *   // Side panel facing -Y, centered vertically (default):
 *   wall({ axis: "-Y", thickness: 3, width: 100, height: 50 })
 *
 * `width` maps to the in-plane axis that isn't world-Z (X or Y depending on
 * `axis`); `height` maps to the other in-plane axis (world-Z for a
 * side-facing wall). For `axis: "+Z"` / `"-Z"` (a flat slab) width/height
 * map to X/Y respectively and `baseAtZero` is a no-op.
 *
 * @throws TypeError on bad axis / non-positive dimensions.
 */
export function wall(opts: WallOpts): Shape3D {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(
      `wall: opts must be { axis, thickness, width, height, baseAtZero? }, got ${String(opts)}.`,
    );
  }
  const { axis, thickness, width, height } = opts;
  const baseAtZero = opts.baseAtZero ?? false;
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
    throw new TypeError(`wall: width must be a finite positive number, got ${String(width)}.`);
  }
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    throw new TypeError(`wall: height must be a finite positive number, got ${String(height)}.`);
  }
  if (!(axis in PRISM_AXIS)) {
    throw new TypeError(
      `wall: axis must be one of "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", got ${JSON.stringify(axis)}.`,
    );
  }
  // Delegate to plate() for the plane/sign math (and shared thickness/axis
  // validation). `plate` is centered on both in-plane axes by default — then
  // for baseAtZero we shift the wall up by height/2 along world Z so the
  // wall's Z-min lands at 0. For the +Z/-Z axes (flat slab) the in-plane
  // axes are X & Y, so "height" isn't vertical and baseAtZero is a no-op.
  const slab = plate({ size: [width, height], thickness, normal: axis });
  if (!baseAtZero) return slab;
  const entry = PRISM_AXIS[axis];
  // worldAxis === 2 → axis is +Z or -Z → height is in-plane on X/Y, not Z.
  if (entry.worldAxis === 2) return slab;
  return slab.translate(0, 0, height / 2);
}
