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

import { drawRectangle, measureArea, type Shape3D } from "replicad";
import { pushRuntimeWarning } from "./warnings";

/**
 * 3-vector tuple used by the print-orientation helpers below.
 *
 * Replicad's face normals come back as `Vector` objects (x/y/z accessors).
 * Keeping a small `Vec3 = [number, number, number]` alias lets the geometry
 * helpers stay arithmetic-only and not depend on the `Vector` WASM wrapper.
 */
type Vec3 = [number, number, number];

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

// ---------------------------------------------------------------------------
// Print-bed orientation helpers — `flatForPrint` + `layoutOnBed`.
//
// Agents designing a multi-part assembly want to re-pose every part into its
// print orientation (largest flat face down on the bed) and pack the lot onto
// a single bed for export. The joint-based `part()/mate()/assemble()` API
// already handles assembly poses; these helpers do the inverse — drop an
// assembled Shape3D into a print pose, then shelf-pack several print poses
// into a build-plate layout.
//
// Destructive-transform note: Replicad's `.rotate()` and `.translate()` DELETE
// the input handle (memory: "Replicad translate/rotate consume input"). Every
// helper here calls `.clone()` before touching the caller's shape, so the
// caller's reference survives the call and can be used again (e.g. reused as
// an assembly sub-part AND laid out on a bed in the same script).
// ---------------------------------------------------------------------------

/**
 * Read a shape's bounding-box min/max as plain `[x,y,z]` tuples, or `null`
 * when the bbox is unreadable for any reason. Mirrors the defensive pattern
 * in `readPlateTopZ` above — OCCT boundary calls must not throw into helper
 * code that's supposed to "fail graceful".
 */
function readBboxBounds(
  shape: Shape3D,
): { min: Vec3; max: Vec3 } | null {
  try {
    const bb = (shape as any).boundingBox;
    if (!bb) return null;
    const bounds = bb.bounds;
    if (
      !Array.isArray(bounds) ||
      bounds.length !== 2 ||
      !Array.isArray(bounds[0]) ||
      !Array.isArray(bounds[1]) ||
      bounds[0].length !== 3 ||
      bounds[1].length !== 3
    ) {
      return null;
    }
    const min: Vec3 = [bounds[0][0], bounds[0][1], bounds[0][2]];
    const max: Vec3 = [bounds[1][0], bounds[1][1], bounds[1][2]];
    for (const v of [...min, ...max]) {
      if (!Number.isFinite(v)) return null;
    }
    return { min, max };
  } catch {
    return null;
  }
}

/** Clone a shape if the handle supports it; otherwise return it as-is. */
function safeClone(shape: Shape3D): Shape3D {
  try {
    const maybe = (shape as any).clone;
    if (typeof maybe === "function") return maybe.call(shape);
  } catch {
    // fall through — caller accepts mutation risk if clone is unavailable
  }
  return shape;
}

/** Read a `Vector`-like object as a plain `[x,y,z]` tuple, or null if malformed. */
function vectorToVec3(v: unknown): Vec3 | null {
  if (!v || typeof v !== "object") return null;
  const { x, y, z } = v as { x?: unknown; y?: unknown; z?: unknown };
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  ) {
    return null;
  }
  return [x, y, z];
}

/** Length of a 3-vector. */
function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Normalize a 3-vector. Returns `null` when the vector is (near) zero. */
function vnorm(v: Vec3): Vec3 | null {
  const L = vlen(v);
  if (!(L > 1e-9)) return null;
  return [v[0] / L, v[1] / L, v[2] / L];
}

/** Dot product of two 3-vectors. */
function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Cross product of two 3-vectors. */
function vcross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Compute the planar-face "area proxy" used to pick the largest print-down
 * face. Prefers Replicad's `measureArea(face)` when importable, but gracefully
 * falls back to the face's outerWire 2D bounding-box area when the measure
 * helper is missing or throws — we don't want a single measurement failure
 * to crash the orientation pass.
 *
 * Exported-internal (not re-exported from index.ts) so the companion test can
 * stub face objects without pulling OCCT.
 */
function planarFaceAreaProxy(face: any): number {
  // Primary: replicad's dedicated area measurement. Wrapped in try/catch
  // because the OCCT call occasionally throws on degenerate faces. The
  // `typeof measureArea === "function"` guard is defensive against mocked
  // test environments where the module export might be stubbed.
  try {
    if (typeof measureArea === "function") {
      const a = measureArea(face);
      if (typeof a === "number" && Number.isFinite(a) && a > 0) return a;
    }
  } catch {
    // fall through to the outerWire-bbox proxy
  }
  // Fallback proxy: outerWire 2D bbox area. Strictly an upper bound on the
  // true face area (a circle of radius r has bbox area (2r)² ≈ 1.27× the
  // circle area), but monotone enough for picking the "largest" face among
  // candidates of similar shape. Accept that a roughly-circular face may
  // out-rank an equal-area square here — the downstream rotation still lands
  // a reasonable face on the bed.
  try {
    const outer = typeof face?.outerWire === "function" ? face.outerWire() : null;
    const bb = outer?.boundingBox;
    const b = bb?.bounds;
    if (
      Array.isArray(b) &&
      Array.isArray(b[0]) &&
      Array.isArray(b[1]) &&
      b[0].length >= 2 &&
      b[1].length >= 2
    ) {
      const w = Math.abs(b[1][0] - b[0][0]);
      const h = Math.abs(b[1][1] - b[0][1]);
      const a = w * h;
      if (Number.isFinite(a) && a > 0) return a;
    }
  } catch {
    // fall through
  }
  return 0;
}

/**
 * Rotation that aligns unit vector `from` with unit vector `to`. Returns
 * `{ angle, axis }` in degrees + a unit-axis tuple, or `null` when the two
 * vectors are already aligned (no rotation needed).
 *
 * Antiparallel case: we pick ANY axis orthogonal to `from` for the 180° flip.
 * For our use case `from` is a planar-face normal and `to = [0,0,-1]`, so the
 * antiparallel case fires exactly when the chosen face's normal already
 * points straight up — rotating 180° about X places it on the bed.
 */
function rotationAligning(
  from: Vec3,
  to: Vec3,
): { angleDeg: number; axis: Vec3 } | null {
  const d = Math.max(-1, Math.min(1, vdot(from, to)));
  // Already aligned (within ~0.06°): no rotation needed.
  if (d > 1 - 1e-6) return null;
  // Antiparallel: 180° about any axis perpendicular to `from`. Pick an axis
  // with the smallest absolute component in `from` to avoid near-zero cross.
  if (d < -1 + 1e-6) {
    const ax = Math.abs(from[0]);
    const ay = Math.abs(from[1]);
    const az = Math.abs(from[2]);
    const helper: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    const perp = vnorm(vcross(from, helper));
    // Extremely defensive: if even that cross degenerates, bail out — caller
    // treats a null return as "no rotation needed".
    if (!perp) return null;
    return { angleDeg: 180, axis: perp };
  }
  const axis = vnorm(vcross(from, to));
  if (!axis) return null;
  const angleDeg = (Math.acos(d) * 180) / Math.PI;
  return { angleDeg, axis };
}

/**
 * flatForPrint() — orient a shape for 3D printing.
 *
 * Rotates the shape so its largest planar face sits flat on the XY plane
 * (that face's outward normal points to -Z), then translates the rotated
 * shape so its bounding-box bottom sits at Z=0. The input shape is cloned;
 * the caller's reference is not consumed (see "destructive transforms" note
 * at the top of this section).
 *
 * Face selection uses area (via Replicad's `measureArea` when available,
 * with an outerWire-bbox fallback — see `planarFaceAreaProxy`). Only faces
 * whose `.geomType === "PLANE"` are considered — curved faces can't sit
 * flat. If the shape has no planar faces (all curved), the rotation step is
 * skipped and a runtime warning is emitted; the returned shape is still
 * translated to `zMin = 0` so the caller can proceed to `layoutOnBed` in
 * the usual way.
 *
 * Emits `pushRuntimeWarning` on both success (agents can't see the visual
 * result, so a positive confirmation matters) and failure. Any OCCT boundary
 * error is caught and converted to a warning — the pipeline never throws.
 *
 * @param shape Shape3D to reorient.
 * @returns New Shape3D ready for print-bed placement. Input is unchanged (cloned).
 */
export function flatForPrint(shape: Shape3D): Shape3D {
  // Short-circuit: caller passed something without a clone/translate surface.
  // Defensive — real Shape3D always has these, but we don't want a stray
  // mock in user code to blow up the pipeline.
  if (!shape || typeof (shape as any).translate !== "function") {
    pushRuntimeWarning(
      `printHints.flatForPrint: input does not look like a Shape3D — returning unchanged.`,
    );
    return shape;
  }

  // Enumerate planar faces and score by area. Faces access is behind a try —
  // `.faces` is a getter that can throw on malformed compounds.
  let bestNormal: Vec3 | null = null;
  let bestArea = 0;
  let planarCount = 0;
  try {
    const faces = (shape as any).faces;
    if (Array.isArray(faces)) {
      for (const f of faces) {
        try {
          if (f?.geomType !== "PLANE") continue;
          planarCount += 1;
          const area = planarFaceAreaProxy(f);
          if (!(area > bestArea)) continue;
          // Read the face's outward normal. `normalAt()` with no argument
          // returns the normal at the face centre (or UV midpoint); replicad
          // flips it per `orientation` so it already points outward.
          const nRaw = typeof f.normalAt === "function" ? f.normalAt() : null;
          const n = vectorToVec3(nRaw);
          if (!n) continue;
          const nn = vnorm(n);
          if (!nn) continue;
          // Replicad's `normalAt()` returns the geometric normal WITHOUT
          // accounting for face orientation — compound shapes built from
          // boolean ops can have faces whose `orientation === "backward"`,
          // meaning the "outward" direction is actually -n. Flip when
          // orientation reads "backward" (per replicad.d.ts).
          const orientation = typeof f.orientation === "string" ? f.orientation : "forward";
          const outward: Vec3 =
            orientation === "backward" ? [-nn[0], -nn[1], -nn[2]] : nn;
          bestNormal = outward;
          bestArea = area;
        } catch {
          // per-face failure: skip and keep scoring the rest
        }
      }
    }
  } catch {
    // `.faces` threw — fall through, the null-normal branch below handles it
  }

  const working = safeClone(shape);

  // No planar face found — translate to zMin=0 and warn, matching the
  // documented fallback contract.
  if (!bestNormal) {
    const bb = readBboxBounds(working);
    if (bb) {
      const translated = (working as any).translate(0, 0, -bb.min[2]);
      pushRuntimeWarning(
        `printHints.flatForPrint: no planar faces found (scanned ${planarCount}) — ` +
          `translated to Z=0 but skipped rotation. Curved-only shapes may need manual orientation.`,
      );
      return translated as Shape3D;
    }
    pushRuntimeWarning(
      `printHints.flatForPrint: no planar faces found and bounding box unreadable — returning shape unchanged.`,
    );
    return working;
  }

  // Rotate so the best face's outward normal aligns with -Z (points down
  // into the bed).
  const rotation = rotationAligning(bestNormal, [0, 0, -1]);
  let rotated: Shape3D = working;
  try {
    if (rotation) {
      rotated = (working as any).rotate(
        rotation.angleDeg,
        [0, 0, 0],
        rotation.axis,
      ) as Shape3D;
    }
  } catch (err) {
    pushRuntimeWarning(
      `printHints.flatForPrint: rotation failed — ${errMsg(err)}. Returning un-rotated clone.`,
    );
    rotated = working;
  }

  // Translate the rotated shape so its bbox bottom sits at Z=0.
  const bb = readBboxBounds(rotated);
  if (!bb) {
    pushRuntimeWarning(
      `printHints.flatForPrint: post-rotation bbox unreadable — returning rotated shape without Z-zeroing.`,
    );
    return rotated;
  }
  const dz = -bb.min[2];
  try {
    const placed = (rotated as any).translate(0, 0, dz) as Shape3D;
    pushRuntimeWarning(
      `printHints.flatForPrint: oriented largest planar face (area≈${bestArea.toFixed(2)}mm²) ` +
        `down, translated bottom to Z=0 (Δz=${dz.toFixed(3)}).`,
    );
    return placed;
  } catch (err) {
    pushRuntimeWarning(
      `printHints.flatForPrint: Z-zero translate failed — ${errMsg(err)}. Returning rotated-only shape.`,
    );
    return rotated;
  }
}

/**
 * Options for `layoutOnBed`.
 */
export interface LayoutOnBedOpts {
  /** Gap between neighbouring parts in mm. Default 5. */
  spacing?: number;
  /** X-axis wrap threshold in mm — packed parts wrap to a new Y-shelf past this. Default 220. */
  bedWidth?: number;
}

/**
 * layoutOnBed() — pack shapes onto a print bed.
 *
 * Places shapes on the XY plane using a shelf-pack algorithm: shapes are
 * added left-to-right, wrapping to a new Y-shelf when `bedWidth` is exceeded.
 * Each shape's Z position is preserved (no Z-translate is applied), so the
 * caller should pass shapes whose bottoms already sit at Z=0 — running each
 * shape through `flatForPrint` first guarantees that.
 *
 * Shelf-pack layout:
 *   - First shelf starts at (x=0, y=0).
 *   - Each shape's bbox min is shifted to `(cursorX, shelfY)`.
 *   - `cursorX` advances by `bboxWidth + spacing` after each shape.
 *   - If `cursorX + bboxWidth > bedWidth`, wrap: start a new shelf at
 *     `y = shelfY + currentShelfDepth + spacing`, `cursorX = 0`.
 *
 * Inputs are cloned — the caller's shape references survive the call. Any
 * shape whose bbox can't be read is placed at the current cursor position
 * without a reliable width contribution, and a runtime warning is emitted.
 *
 * @param shapes Shapes to pack. Order is preserved (no sorting optimisation —
 *   callers who want best-fit packing should sort before calling).
 * @param opts Layout options (see `LayoutOnBedOpts`).
 * @returns Array of new Shape3D in packed positions. Inputs are cloned.
 */
export function layoutOnBed(
  shapes: Shape3D[],
  opts: LayoutOnBedOpts = {},
): Shape3D[] {
  const spacing = opts.spacing ?? 5;
  const bedWidth = opts.bedWidth ?? 220;
  if (!Array.isArray(shapes) || shapes.length === 0) return [];

  const out: Shape3D[] = [];
  let cursorX = 0;
  let shelfY = 0;
  let shelfDepth = 0; // largest bbox-depth (Y extent) on the current shelf

  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    const bb = readBboxBounds(s);

    if (!bb) {
      pushRuntimeWarning(
        `printHints.layoutOnBed: shape[${i}] bounding box unreadable — placed at (${cursorX.toFixed(1)}, ${shelfY.toFixed(1)}) without width contribution.`,
      );
      // Best-effort placement: still clone + translate so downstream consumers
      // get a full array of parts even when one bbox is bad.
      try {
        const clone = safeClone(s);
        out.push((clone as any).translate(cursorX, shelfY, 0) as Shape3D);
      } catch {
        out.push(s);
      }
      continue;
    }

    const width = bb.max[0] - bb.min[0];
    const depth = bb.max[1] - bb.min[1];

    // Wrap to a new shelf? Only wrap if this isn't the first shape on the
    // current shelf (cursorX > 0) — an oversized solo shape should still get
    // placed, not endlessly wrapped.
    if (cursorX > 0 && cursorX + width > bedWidth) {
      shelfY += shelfDepth + spacing;
      cursorX = 0;
      shelfDepth = 0;
    }

    // Translate so bbox min X → cursorX, bbox min Y → shelfY. Z is preserved.
    const dx = cursorX - bb.min[0];
    const dy = shelfY - bb.min[1];
    const clone = safeClone(s);
    try {
      const placed = (clone as any).translate(dx, dy, 0) as Shape3D;
      out.push(placed);
    } catch (err) {
      pushRuntimeWarning(
        `printHints.layoutOnBed: shape[${i}] translate failed — ${errMsg(err)}. Using un-translated clone.`,
      );
      out.push(clone);
    }

    cursorX += width + spacing;
    if (depth > shelfDepth) shelfDepth = depth;
  }

  pushRuntimeWarning(
    `printHints.layoutOnBed: packed ${out.length} shapes (bedWidth=${bedWidth}mm, spacing=${spacing}mm).`,
  );
  return out;
}
