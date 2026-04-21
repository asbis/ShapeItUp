/**
 * Placement and type-narrowing helpers for the ShapeItUp stdlib.
 *
 * These are small utilities that remove the most common ergonomic papercuts
 * when composing cut tools with user plates.
 */

import type { DrawingInterface, Shape3D } from "replicad";
import { getSketchPlane } from "../instrumentation";

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

// ---------------------------------------------------------------------------
// placeOn — sketchOnPlane + extrude with an explicit, predictable half-space.
//
// The #1 silent-surprise bug in Replicad for both humans and AI agents:
//
//   drawRect(40, 50).sketchOnPlane("XZ").extrude(20)
//
// looks like "a 40×50 slab 20mm thick on the XZ plane", but actually produces
// a solid whose bounding box is Y ∈ [−20, 0] — grown into the NEGATIVE plane
// normal. A downstream `cut` placed at Y=0 then silently removes no material,
// and the user/agent hunts the problem for 20 minutes.
//
// `placeOn` takes the plane + the half-space you want the extrude to occupy,
// validates the pairing statically, builds the extrude, and translates the
// result so its bounding box lands in [0, distance] along the requested axis.
// If the requested axis doesn't match the plane's normal axis, it throws at
// call time — no silent wrong placement, no runtime warning to miss.
//
// Plane → native extrude direction (hand-verified against replicad's
// `Plane` default-normal convention and `warnings.ts#emitExtrudePlaneHint`,
// which is the authoritative mapping used elsewhere in the stdlib):
//
//   XY → +Z    YX → −Z
//   XZ → −Y    ZX → +Y
//   YZ → +X    ZY → −X
//
// "native sign" below is the sign of the native extrude direction on the
// named axis — +1 means positive-length extrudes grow into [0, +L], −1 means
// they grow into [−L, 0]. `placeOn` then translates to land the bbox in
// [0, distance] (`into` on the positive half) or [−distance, 0] (negative
// half), regardless of the native direction.
// ---------------------------------------------------------------------------

/** The six supported sketch plane names in Replicad. */
export type PlaneName = "XY" | "YX" | "XZ" | "ZX" | "YZ" | "ZY";

/** A signed world axis, naming a half-space along that axis. */
export type SignedAxis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

interface PlaneAxisEntry {
  /** Which world axis the native extrude grows along. */
  axis: "X" | "Y" | "Z";
  /** +1 → native extrude is [0, +L]; −1 → native extrude is [−L, 0]. */
  nativeSign: 1 | -1;
}

/**
 * Plane → native extrude direction. Authoritative source: hand-verified
 * against `warnings.ts#emitExtrudePlaneHint` (which is itself verified against
 * Replicad behaviour in packages/core/src/tests/). If this ever drifts, the
 * extrude-plane hint and this table must be updated together — both rely on
 * the same convention.
 */
const PLANE_AXIS: Record<PlaneName, PlaneAxisEntry> = {
  XY: { axis: "Z", nativeSign: 1 },
  YX: { axis: "Z", nativeSign: -1 },
  XZ: { axis: "Y", nativeSign: -1 },
  ZX: { axis: "Y", nativeSign: 1 },
  YZ: { axis: "X", nativeSign: 1 },
  ZY: { axis: "X", nativeSign: -1 },
};

/** Expected valid `into` values per plane, for error messages. */
const VALID_INTO_FOR_PLANE: Record<PlaneName, [SignedAxis, SignedAxis]> = {
  XY: ["+Z", "-Z"],
  YX: ["+Z", "-Z"],
  XZ: ["+Y", "-Y"],
  ZX: ["+Y", "-Y"],
  YZ: ["+X", "-X"],
  ZY: ["+X", "-X"],
};

function isPlaneName(s: string): s is PlaneName {
  return s === "XY" || s === "YX" || s === "XZ" || s === "ZX" || s === "YZ" || s === "ZY";
}

function isSignedAxis(s: string): s is SignedAxis {
  return (
    s === "+X" || s === "-X" || s === "+Y" || s === "-Y" || s === "+Z" || s === "-Z"
  );
}

function assertPositiveFiniteLocal(fnName: string, label: string, n: unknown): asserts n is number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
    throw new Error(`${fnName}: ${label} must be a positive finite number, got ${String(n)}.`);
  }
}

export interface PlaceOnOpts {
  /**
   * The half-space the resulting solid should occupy. Must be a signed axis
   * matching the plane's normal axis (e.g. `"XY"` requires `"+Z"` or `"-Z"`).
   * Pairing `plane="XY"` with `into="+X"` throws — no silent wrong placement.
   */
  into: SignedAxis;
  /** Extrusion thickness in mm. Must be a positive finite number. */
  distance: number;
}

/**
 * Sketch a 2D drawing on a plane, extrude it, and place the result so its
 * bounding box occupies EXACTLY the half-space you named along the plane's
 * normal axis. Intended as the safe replacement for the common sequence:
 *
 *   drawing.sketchOnPlane(plane).extrude(distance)
 *
 * which — for every plane except "XY" — lands in a surprising half-space
 * (e.g. `sketchOnPlane("XZ").extrude(20)` gives Y ∈ [−20, 0], not Y ∈ [0, 20]
 * as most CAD authors expect).
 *
 * Usage:
 *
 *   // A 20mm-thick slab sitting above Y=0, sketched on XZ:
 *   placeOn(drawRect(40, 50), "XZ", { into: "+Y", distance: 20 });
 *   //   → bbox X ∈ [-20, 20], Y ∈ [0, 20], Z ∈ [-25, 25]
 *
 *   // A 10mm pad below Z=0, on the XY plane (flipping the default grow-up):
 *   placeOn(drawCircle(5), "XY", { into: "-Z", distance: 10 });
 *   //   → bbox Z ∈ [-10, 0]
 *
 * Validation (all thrown at call time, before hitting OCCT):
 *   - `plane` must be one of "XY" | "YX" | "XZ" | "ZX" | "YZ" | "ZY".
 *   - `into` must be a signed world axis ("+X" | "-X" | ... | "-Z").
 *   - `into`'s axis must match the plane's normal axis. E.g. plane "XY"
 *     extrudes along Z, so only "+Z" / "-Z" are legal; plane "XZ" extrudes
 *     along Y, so only "+Y" / "-Y"; etc. Mismatches throw with a message
 *     naming the valid values for the given plane.
 *   - `distance` must be positive and finite.
 *
 * Translation note: Replicad's `.translate()` CONSUMES its input (destroys
 * the OCCT handle). The extruded solid here is freshly built by the wrapper
 * itself, so it's locally owned — translating it in-place is safe and no
 * clone is needed.
 *
 * @param drawing A 2D `Drawing` or `DrawingInterface` (e.g. result of
 *   `drawRectangle`, `drawCircle`, `draw(...).close()`, etc).
 * @param plane Sketch plane name. One of "XY" | "YX" | "XZ" | "ZX" | "YZ" | "ZY".
 * @param opts `{ into, distance }` — see validation above.
 * @returns A Shape3D whose bounding box along the plane's normal axis is
 *   [0, distance] for a positive `into`, [-distance, 0] for a negative `into`.
 */
export function placeOn(
  drawing: DrawingInterface,
  plane: PlaneName,
  opts: PlaceOnOpts,
): Shape3D {
  const fn = "placeOn";

  // --- Plane validation -----------------------------------------------------
  if (typeof plane !== "string" || !isPlaneName(plane)) {
    throw new Error(
      `${fn}: plane must be one of "XY" | "YX" | "XZ" | "ZX" | "YZ" | "ZY", got ${JSON.stringify(plane)}.`,
    );
  }
  const entry = PLANE_AXIS[plane];

  // --- Opts validation ------------------------------------------------------
  if (opts == null || typeof opts !== "object") {
    throw new Error(
      `${fn}: opts must be an object like { into: "+Y", distance: 20 }, got ${String(opts)}.`,
    );
  }
  const { into, distance } = opts;
  if (typeof into !== "string" || !isSignedAxis(into)) {
    throw new Error(
      `${fn}: into must be one of "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z", got ${JSON.stringify(into)}.`,
    );
  }

  // --- Axis-mismatch guard (the whole point of this helper) -----------------
  const intoAxis = into[1] as "X" | "Y" | "Z";
  if (intoAxis !== entry.axis) {
    const valid = VALID_INTO_FOR_PLANE[plane];
    throw new Error(
      `${fn}: plane '${plane}' extrudes along ${entry.axis}; ` +
        `into='${into}' is invalid (valid for ${plane}: '${valid[0]}' | '${valid[1]}').`,
    );
  }

  assertPositiveFiniteLocal(fn, "opts.distance", distance);

  // --- Build the solid -------------------------------------------------------
  // Duck-type check: drawing must expose sketchOnPlane. Throwing a clear error
  // here beats a cryptic "sketchOnPlane is not a function" downstream.
  if (drawing == null || typeof (drawing as { sketchOnPlane?: unknown }).sketchOnPlane !== "function") {
    throw new Error(
      `${fn}: drawing must be a Replicad Drawing (e.g. drawRectangle(...), drawCircle(...), draw(...).close()); ` +
        `got ${drawing === null ? "null" : typeof drawing}.`,
    );
  }
  const sketch = drawing.sketchOnPlane(plane);
  // Replicad's `.extrude()` return union is wider than Shape3D (Shell | Solid
  // | CompSolid | Compound | Vertex | Edge | Wire | Face). At runtime a
  // Drawing-on-plane extrude always produces a Solid, so the cast is safe.
  const extruded = (sketch as unknown as { extrude: (d: number) => unknown })
    .extrude(distance) as Shape3D;

  // --- Translate the native bbox into the requested half-space --------------
  // Native bbox along entry.axis:
  //   nativeSign === +1  →  [0, +distance]
  //   nativeSign === -1  →  [-distance, 0]
  //
  // Requested bbox (from `into`):
  //   into starts with "+"  →  [0, +distance]
  //   into starts with "-"  →  [-distance, 0]
  //
  // Shift = requested_lo − native_lo along entry.axis. Zero when native
  // already matches (e.g. XY + "+Z", or XZ + "-Y"), ±distance otherwise.
  const wantPositive = into[0] === "+";
  const nativeLo = entry.nativeSign === 1 ? 0 : -distance;
  const wantLo = wantPositive ? 0 : -distance;
  const shift = wantLo - nativeLo;

  if (shift === 0) {
    return extruded;
  }

  // Translating the locally-owned `extruded` consumes its handle — fine
  // because we just built it and nothing outside this function holds a
  // reference. See `project_replicad_destructive_translate` memory note.
  const dx = entry.axis === "X" ? shift : 0;
  const dy = entry.axis === "Y" ? shift : 0;
  const dz = entry.axis === "Z" ? shift : 0;
  return extruded.translate(dx, dy, dz);
}

// ---------------------------------------------------------------------------
// extrudeCentered — extrude a sketch symmetrically about its plane.
//
// Ergonomic replacement for:
//
//   drawRect(40, 50).sketchOnPlane("XZ").extrude(20)   // Y ∈ [-20, 0] — surprise
//   → .translate(0, 10, 0)                              // manual re-centering
//
// `extrudeCentered(sketch, 20)` returns a solid whose bbox on the plane's
// normal axis is exactly [-distance/2, +distance/2], regardless of the plane.
// Also narrows the over-wide `Solid | Compound` extrude return type back to
// `Shape3D` so `.cut()` / `.fuse()` chains don't need an `as Shape3D` cast
// (Fix #10).
//
// Origin tagging: because this function lives in `/stdlib/`, the
// call-stack-based check in `warnings.ts#enqueueExtrudeHint` automatically
// tags the hint as `origin: "stdlib"` and `drainExtrudeHints` drops it. No
// explicit wrap needed — verified against the regex `/[\\/]stdlib[\\/]/` the
// enqueue helper uses. The separate pen-axis hint emitted by
// `sketchOnPlane` fires before this helper runs (the user already called
// `.sketchOnPlane(plane)` to build the Sketch), so extrudeCentered cannot
// suppress it.
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for the sketch-like inputs `extrudeCentered`
 * accepts. Matches replicad's `Sketch`, `Sketches`, `CompoundSketch`, and the
 * public `SketchInterface` — all expose `.extrude(d)` returning a 3D shape.
 */
export interface SketchLike {
  extrude(distance: number, config?: unknown): unknown;
}

/** Options for the `plane`-explicit overload of {@link extrudeCentered}. */
export interface ExtrudeCenteredOpts {
  /** Override the plane the sketch was built on. Required when the Sketch
   *  wasn't produced by an instrumented `.sketchOnPlane()` call (no WeakMap
   *  entry), or when you want to pin it explicitly. */
  plane?: PlaneName;
}

/**
 * Extrude a sketch by `distance` mm, symmetrically about the plane the sketch
 * was built on, and return a narrowed `Shape3D`.
 *
 * On XY this is equivalent to `sketch.extrude(distance).translate(0, 0, -distance/2)`.
 * On any other plane the translation is along the plane's normal axis (see
 * {@link PLANE_AXIS}). The result's bounding box on the normal axis is
 * always `[-distance/2, +distance/2]`.
 *
 *   // XZ plane — bbox Y ∈ [-10, 10] (instead of the default [-20, 0]):
 *   const plate = extrudeCentered(
 *     drawRectangle(40, 50).sketchOnPlane("XZ"),
 *     20,
 *   );
 *
 * Plane detection: the instrumentation layer threads the plane name from
 * `Drawing.sketchOnPlane(name)` to the returned Sketch via a WeakMap. This
 * helper reads that WeakMap. If the Sketch came from a source that bypasses
 * the instrumentation (a raw replicad export, a test stub, etc.), pass
 * `{ plane }` as the third argument to disambiguate.
 *
 * @param sketch A replicad `Sketch` / `Sketches` / `CompoundSketch` or any
 *   object implementing `SketchInterface` (exposes `.extrude(d)`).
 * @param distance Extrusion thickness in mm. Must be a positive finite number.
 * @param opts Optional `{ plane }` override. Required when the plane cannot
 *   be recovered from the sketch via the instrumentation WeakMap.
 * @returns A Shape3D centered on its plane's normal axis.
 */
export function extrudeCentered(
  sketch: SketchLike,
  distance: number,
  opts?: ExtrudeCenteredOpts,
): Shape3D {
  const fn = "extrudeCentered";
  assertPositiveFiniteLocal(fn, "distance", distance);
  if (sketch == null || typeof (sketch as { extrude?: unknown }).extrude !== "function") {
    throw new TypeError(
      `${fn}: sketch must be a replicad Sketch / Sketches / CompoundSketch ` +
        `(got ${sketch === null ? "null" : typeof sketch}). Build one with ` +
        `drawing.sketchOnPlane("XY") first.`,
    );
  }

  // --- Resolve plane: explicit opts override, else WeakMap, else error. ----
  let plane: PlaneName | undefined = opts?.plane;
  if (plane === undefined) {
    const recovered = getSketchPlane(sketch);
    if (typeof recovered === "string" && isPlaneName(recovered)) {
      plane = recovered;
    }
  }
  if (plane === undefined) {
    throw new Error(
      `${fn}: could not determine the sketch's plane automatically. ` +
        `Pass the plane explicitly: extrudeCentered(sketch, ${distance}, { plane: "XZ" }).`,
    );
  }
  const entry = PLANE_AXIS[plane];

  // --- Extrude (narrow replicad's Solid | Compound union to Shape3D) -------
  const extruded = sketch.extrude(distance) as Shape3D;

  // --- Translate to center on the plane's normal axis ----------------------
  // Native bbox on entry.axis: [0, +distance] when nativeSign=+1, else
  // [-distance, 0]. To land the bbox symmetric around 0, we want
  //   [-distance/2, +distance/2]
  // so the shift is -(native midpoint) = -(nativeSign * distance / 2).
  const shift = -entry.nativeSign * (distance / 2);
  if (shift === 0) return extruded;
  const dx = entry.axis === "X" ? shift : 0;
  const dy = entry.axis === "Y" ? shift : 0;
  const dz = entry.axis === "Z" ? shift : 0;
  return extruded.translate(dx, dy, dz);
}
