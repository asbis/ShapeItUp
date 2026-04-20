/**
 * Fastener library — canonical hardware shapes for assemblies.
 *
 * ## Which namespace do I want?
 *
 *   screws.*  — cosmetic fasteners with plain cylinder shafts. Fast, returns
 *               Shape3D, composable with any B-Rep operation. Use for layout,
 *               assembly, and anywhere the thread form is not visually
 *               important. Matches the Fusion/SolidWorks default.
 *   bolts.*   — real threaded fasteners. Heads + helical ridges. Use for STEP
 *               export, 3D-print previews, or wherever the thread visual
 *               matters. Returns Shape3D for external fasteners (B-Rep
 *               compound) and MeshShape for nuts (internal threads require
 *               the Manifold mesh kernel — OCCT boolean is too slow on WASM).
 *
 * ## Quick reference
 *
 *   screws.socket("M3x10")   → Shape3D   socket-head cap screw, plain shaft
 *   screws.button("M4x8")    → Shape3D   button-head cap screw, plain shaft
 *   screws.flat("M5x12")     → Shape3D   flat-head (countersunk), plain shaft
 *   screws.hex("M6x20")      → Shape3D   hex-head bolt, plain shaft
 *   screws.nut("M3")         → Shape3D   hex nut, clean bore
 *
 *   bolts.socket("M3x10")    → Shape3D   socket-head cap screw, threaded
 *   bolts.button("M4x8")     → Shape3D   button-head cap screw, threaded
 *   bolts.flat("M5x12")      → Shape3D   flat-head (countersunk), threaded
 *   bolts.hex("M6x20")       → Shape3D   hex-head bolt, threaded
 *   bolts.nut("M3")          → MeshShape nut with real internal threads
 *
 *   washers.flat("M3")       → Shape3D   DIN 125 flat washer (no threads)
 *   inserts.heatSet("M3")    → Shape3D   heat-set insert body
 *   inserts.pocket("M3")     → Shape3D   cut-tool for heat-set pocket
 *
 * ## Orientation (all factories)
 *
 *   - Central axis is world Z.
 *   - "Top" face (head or nut top) sits at Z = 0.
 *   - Shaft extends into −Z (for screws/bolts); body extends into −Z (nuts).
 *
 * ## Flipping orientation — `{ headAt: "+Z" }`
 *
 * Every bolt/screw factory accepts an optional `{ headAt }` that picks which
 * side of `Z=0` the head lives on:
 *
 *   - `"-Z"` (default) — head body at Z ∈ [−headH, 0], shaft into −Z. This is
 *     the cut-tool-friendly convention used everywhere else in the stdlib.
 *   - `"+Z"` — shape is rotated 180° about the world +X axis through the
 *     origin. Head body ends up at Z ∈ [0, +headH] and the shaft extends up
 *     into +Z. Useful when you want `.translate(0, 0, plateThickness)` to
 *     seat the drive side at the top of a plate (the reviewer's "bolt on
 *     top of plate" mental model) without doing the flip manually.
 *
 * For the even-less-fiddly version see {@link seatedOnPlate}, which
 * computes the seating translation (and rotation for non-Z axes) automatically.
 *
 * ## Mixing mesh and B-Rep
 *
 * `bolts.nut("M3")` returns a `MeshShape` — it can only fuse/cut with other
 * MeshShapes. If you need to combine it with a Shape3D plate, convert the
 * plate first: `plate.meshShape({ tolerance: 0.01 }).cut(nut)`.
 */

import {
  draw,
  drawCircle,
  drawPolysides,
  makeCompound,
  makeCylinder,
  type MeshShape,
  type Shape3D,
} from "replicad";
import {
  SOCKET_HEAD,
  BUTTON_HEAD,
  FLAT_HEAD,
  HEX_HEAD,
  HEX_NUT,
  FLAT_WASHER,
  HEAT_SET_INSERT,
  FIT,
  type MetricSize,
  parseScrewDesignator,
  assertSupportedSize,
} from "./standards";
import { metric as threadedShaft, metricMesh, tapInto } from "./threads";
import { applyAxis, type HoleAxis } from "./holes";

function parseWithLength(spec: string): { size: MetricSize; length: number } {
  const parsed = parseScrewDesignator(spec);
  if (parsed.length === undefined) {
    throw new Error(
      `Screw designator "${spec}" needs a length, e.g. "${parsed.size}x10".`,
    );
  }
  return { size: parsed.size, length: parsed.length };
}

// ── Orientation option (headAt) ────────────────────────────────────────────

/**
 * Options accepted by every bolt/screw factory. `headAt` picks which side of
 * Z=0 the head lives on (see module-level Orientation docblock).
 */
export interface FastenerOrientOpts {
  /**
   * `"-Z"` (default) keeps the stdlib-wide convention: head body at
   * Z ∈ [−headH, 0], shaft into −Z. `"+Z"` rotates the assembled fastener
   * 180° about the world +X axis through the origin, putting the head body
   * at Z ∈ [0, +headH] with the shaft extending into +Z. The rotation is
   * intentionally applied after the whole fastener is built so head /
   * shaft / recess stay coherent relative to each other.
   */
  headAt?: "+Z" | "-Z";
}

function assertHeadAt(opts: FastenerOrientOpts | undefined, fn: string): "+Z" | "-Z" {
  const raw = opts?.headAt;
  if (raw === undefined) return "-Z";
  if (raw !== "+Z" && raw !== "-Z") {
    throw new Error(
      `${fn}: headAt must be "+Z" or "-Z", got ${JSON.stringify(raw)}. ` +
        `Default is "-Z" (head body in −Z, shaft into −Z).`,
    );
  }
  return raw;
}

/**
 * Apply the `{ headAt }` flip to a just-built fastener. The input shape is
 * locally owned by the factory that calls this, so the in-place rotate is
 * safe (no clone needed — see `project_replicad_destructive_translate` note).
 *
 * Rotation: `.rotate(180, [0,0,0], [1,0,0])` — 180° about the world +X axis
 * through the origin. Geometrically this maps `(x, y, z) → (x, −y, −z)`, so
 * a bolt with head at Z ∈ [−headH, 0] and shaft at Z ∈ [−headH−L, −headH]
 * becomes head at Z ∈ [0, +headH] and shaft at Z ∈ [+headH, +headH+L]. Trace
 * for M3×10 (headH ≈ 3): head [−3, 0] → [0, 3]; shaft [−13, −3] → [3, 13].
 * Shape stays coherent — no double-negative — because every internal cut
 * (hex recess, cone, thread) is applied before the rotation.
 */
function applyHeadAt<S extends { rotate(angle: number, position?: [number, number, number], direction?: [number, number, number]): S }>(
  shape: S,
  headAt: "+Z" | "-Z",
): S {
  if (headAt === "-Z") return shape;
  return shape.rotate(180, [0, 0, 0], [1, 0, 0]);
}

// ── Head builders (shared between screws.* and bolts.*) ────────────────────
//
// Each returns a `Shape3D` positioned so the head's top face sits at Z=0 and
// its bottom face sits at `shaftStartZ` (a negative value). The caller glues
// on a shaft of their choice at that Z.

function socketHeadBody(size: MetricSize): { head: Shape3D; shaftStartZ: number } {
  assertSupportedSize(size, SOCKET_HEAD, "socket-head");
  const s = SOCKET_HEAD[size];
  const head = makeCylinder(s.headD / 2, s.headH, [0, 0, -s.headH], [0, 0, 1]);
  const recessDepth = s.headH * 0.6;
  const recess = drawPolysides(s.hex / Math.sqrt(3), 6)
    .sketchOnPlane("XY")
    .extrude(-recessDepth)
    .asShape3D();
  let body: Shape3D = head;
  try { body = head.cut(recess); } catch {}
  return { head: body, shaftStartZ: -s.headH };
}

function buttonHeadBody(size: MetricSize): { head: Shape3D; shaftStartZ: number } {
  const b = BUTTON_HEAD[size];
  if (!b) throw new Error(`No button-head spec for ${size}.`);
  const head = makeCylinder(b.headD / 2, b.headH, [0, 0, -b.headH], [0, 0, 1]);
  const recessDepth = b.headH * 0.5;
  const recess = drawPolysides(b.hex / Math.sqrt(3), 6)
    .sketchOnPlane("XY")
    .extrude(-recessDepth)
    .asShape3D();
  let body: Shape3D = head;
  try { body = head.cut(recess); } catch {}
  return { head: body, shaftStartZ: -b.headH };
}

function hexHeadBody(size: MetricSize): { head: Shape3D; shaftStartZ: number } {
  const h = HEX_HEAD[size];
  if (!h) throw new Error(`No hex-head spec for ${size}.`);
  // drawPolysides(radius, 6) takes the circumscribed (outer) radius.
  // Bolts are specified across-flats (inscribed), so outerR = AF/√3.
  const outerR = h.acrossFlats / Math.sqrt(3);
  const head = drawPolysides(outerR, 6)
    .sketchOnPlane("XY")
    .extrude(-h.headH)
    .asShape3D();
  return { head, shaftStartZ: -h.headH };
}

/**
 * Flat-head builds head AND shaft in one revolve (avoids a fragile
 * head/shaft fuse at the cone-to-cylinder transition). So it doesn't fit
 * the head-only pattern — we special-case it in the factories below.
 */
function flatHeadFull(size: MetricSize, length: number, includeShaft: boolean): Shape3D {
  const f = FLAT_HEAD[size];
  if (!f) throw new Error(`No flat-head spec for ${size}.`);
  const headR = f.headD / 2;
  const coneDepth = headR; // 90° included cone → depth = radius
  const shaftR = f.shaft / 2;
  const profile = includeShaft
    ? draw([0, 0])
        .hLine(headR)
        .lineTo([shaftR, -coneDepth])
        .lineTo([shaftR, -coneDepth - length])
        .hLine(-shaftR)
        .close()
    : draw([0, 0])
        .hLine(headR)
        .lineTo([shaftR, -coneDepth])
        .hLine(-shaftR)
        .close();
  let body = profile
    .sketchOnPlane("XZ")
    .revolve([0, 0, 1], { origin: [0, 0, 0] })
    .asShape3D();
  const recessDepth = Math.min(coneDepth * 0.6, 2);
  const recess = drawPolysides(f.hex / Math.sqrt(3), 6)
    .sketchOnPlane("XY")
    .extrude(-recessDepth)
    .asShape3D();
  try { body = body.cut(recess); } catch {}
  return body;
}

function plainShaft(size: MetricSize, length: number, startZ: number): Shape3D {
  assertSupportedSize(size, SOCKET_HEAD, "socket-head");
  const shaftR = SOCKET_HEAD[size].shaft / 2;
  return makeCylinder(shaftR, length, [0, 0, startZ - length], [0, 0, 1]);
}

// ── seatedOnPlate — place a fastener so its head seats on a plate face ─────

/** Signed-axis argument accepted by {@link seatedOnPlate}. */
export type SeatAxis = "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y";

const SEAT_AXIS_VALUES: SeatAxis[] = ["+Z", "-Z", "+X", "-X", "+Y", "-Y"];

function isSeatAxis(x: unknown): x is SeatAxis {
  return typeof x === "string" && (SEAT_AXIS_VALUES as string[]).includes(x);
}

/**
 * Read a 3D bounding box into `{min, max}` vectors. Returns undefined when
 * the bbox is missing or malformed; callers treat that as a degenerate shape
 * and throw with a user-friendly message.
 */
function read3dBounds(
  shape: unknown,
): { min: [number, number, number]; max: [number, number, number] } | undefined {
  try {
    const bb = (shape as { boundingBox?: { bounds?: unknown } })?.boundingBox;
    const bounds = bb?.bounds as unknown;
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
    const [[x0, y0, z0], [x1, y1, z1]] = bounds as [
      [number, number, number],
      [number, number, number],
    ];
    if (
      !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) ||
      !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1)
    ) {
      return undefined;
    }
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  } catch {
    return undefined;
  }
}

/**
 * Rotation that takes the fastener's built-in +Z axis and aligns it with the
 * requested world axis. All rotations are about the origin — the fastener's
 * central axis passes through the origin by construction, so this pivots the
 * shape about that axis. Returns `undefined` for `"+Z"` (identity).
 */
function axisRotation(axis: SeatAxis):
  | { angle: number; direction: [number, number, number] }
  | undefined {
  switch (axis) {
    case "+Z": return undefined;                                      // identity
    case "-Z": return { angle: 180, direction: [1, 0, 0] };           // flip about X
    case "+X": return { angle: 90,  direction: [0, 1, 0] };           // +Z → +X
    case "-X": return { angle: -90, direction: [0, 1, 0] };           // +Z → -X
    case "+Y": return { angle: -90, direction: [1, 0, 0] };           // +Z → +Y
    case "-Y": return { angle: 90,  direction: [1, 0, 0] };           // +Z → -Y
  }
}

/** Index into a [x, y, z] tuple by axis letter. */
const AXIS_INDEX: Record<"X" | "Y" | "Z", 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

/**
 * Place a freshly-built fastener so its head-top face lands on the given
 * plate's seating surface.
 *
 * ### Contract
 *
 * - `plate` must be a Shape3D with a readable non-degenerate bounding box.
 * - `fastener` is expected in the stdlib's default `headAt: "-Z"` orientation
 *   (head body at Z ∈ [−headH, 0], shaft into −Z). The head-top face is at
 *   `fastener.boundingBox.max.z` in that convention.
 * - `axis` picks which face of the plate to seat on (default `"+Z"`, the
 *   top face). Positive axes use `plate.bbox.max.<axis>`; negative axes use
 *   `plate.bbox.min.<axis>`. For non-Z axes the fastener is rotated so its
 *   central axis aligns with the target world axis BEFORE being translated.
 *
 * ### Ownership & destructive transforms
 *
 * Replicad's `.translate()` and `.rotate()` CONSUME their input — they
 * destroy the OCCT handle on the operand. `seatedOnPlate` therefore expects
 * to OWN the `fastener` shape: pass a freshly-constructed fastener (e.g.
 * `bolts.socket("M3x10")` directly), or `.clone()` a shape you intend to
 * keep using elsewhere. The `plate` is only read (via `.boundingBox`) and
 * is NOT consumed. See the `project_replicad_destructive_translate` memory
 * note for the detailed rationale.
 *
 * ### Usage
 *
 * ```ts
 * // Bolt on top of plate, shaft pointing up:
 * const seated = seatedOnPlate(bolts.socket("M3x10"), plate);
 *
 * // Bolt installed through the −Y face of a vertical wall:
 * const side = seatedOnPlate(bolts.socket("M3x10"), wall, "-Y");
 * ```
 *
 * @param fastener A freshly-constructed fastener (default `headAt: "-Z"`).
 *   Will be consumed by rotate/translate.
 * @param plate A Shape3D whose bounding box provides the seating face.
 * @param axis Which face of the plate to seat on. Default `"+Z"` (top).
 * @returns The fastener translated (and for non-Z axes, rotated) so its
 *   head-top face sits flush on the chosen plate face.
 */
export function seatedOnPlate<S extends Shape3D | MeshShape>(
  fastener: S,
  plate: Shape3D,
  axis: SeatAxis = "+Z",
): S {
  const fn = "seatedOnPlate";

  if (!isSeatAxis(axis)) {
    throw new Error(
      `${fn}: axis must be one of "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y", ` +
        `got ${JSON.stringify(axis)}.`,
    );
  }

  const plateBB = read3dBounds(plate);
  if (!plateBB) {
    throw new Error(
      `${fn}: plate has no readable boundingBox — pass a Shape3D (e.g. ` +
        `a finished extrude/revolve), not a Drawing or raw topology handle.`,
    );
  }
  const plateExtent = [
    plateBB.max[0] - plateBB.min[0],
    plateBB.max[1] - plateBB.min[1],
    plateBB.max[2] - plateBB.min[2],
  ];
  // A zero-thickness plate has no meaningful top/bottom face to seat on.
  // Reject degenerate bboxes up front with a clear message instead of
  // silently producing a coplanar fastener + plate.
  const EPS = 1e-9;
  if (plateExtent[0] < EPS || plateExtent[1] < EPS || plateExtent[2] < EPS) {
    throw new Error(
      `${fn}: plate boundingBox is degenerate (extents = ` +
        `[${plateExtent.map((n) => n.toFixed(4)).join(", ")}]). ` +
        `Pass a non-zero-volume Shape3D.`,
    );
  }

  // --- 1. Rotate the fastener to align its +Z axis with the target axis ---
  // This runs BEFORE we read the fastener bbox, because the bbox in the
  // pre-rotation local frame is not the bbox we need to translate on.
  const rot = axisRotation(axis);
  const oriented = (rot
    ? (fastener as unknown as {
        rotate: (a: number, p: [number, number, number], d: [number, number, number]) => S;
      }).rotate(rot.angle, [0, 0, 0], rot.direction)
    : fastener) as S;

  // --- 2. Read the rotated fastener's bbox along the target axis ---------
  const orientedBB = read3dBounds(oriented);
  if (!orientedBB) {
    throw new Error(
      `${fn}: fastener has no readable boundingBox — pass a fresh ` +
        `screws.*/bolts.* shape, not a Drawing or a raw topology handle.`,
    );
  }

  const axisLetter = axis[1] as "X" | "Y" | "Z";
  const axisIdx = AXIS_INDEX[axisLetter];
  const wantPositive = axis[0] === "+";

  // Plate seating face: max for +axis, min for -axis.
  const plateFace = wantPositive ? plateBB.max[axisIdx] : plateBB.min[axisIdx];

  // Fastener head-top face: after rotation the head-top sits at the extreme
  // of the target axis matching `wantPositive`. For +axis the head-top is at
  // bbox.max[axisIdx]; for -axis it's at bbox.min[axisIdx]. (The rotation
  // tables above were chosen so that "head points along +axis" holds.)
  const headTop = wantPositive ? orientedBB.max[axisIdx] : orientedBB.min[axisIdx];

  const shift = plateFace - headTop;
  if (shift === 0) return oriented;

  const dx = axisIdx === 0 ? shift : 0;
  const dy = axisIdx === 1 ? shift : 0;
  const dz = axisIdx === 2 ? shift : 0;
  return (oriented as unknown as {
    translate: (x: number, y: number, z: number) => S;
  }).translate(dx, dy, dz);
}

// ── Cosmetic fasteners — screws.* ──────────────────────────────────────────

export const screws = {
  /** ISO 4762 socket-head cap screw with plain (unthreaded) shaft. */
  socket(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = socketHeadBody(size);
    const body = head.fuse(plainShaft(size, length, shaftStartZ));
    return applyHeadAt(body, assertHeadAt(opts, "screws.socket"));
  },
  /** ISO 7380 button-head cap screw with plain shaft. */
  button(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = buttonHeadBody(size);
    const body = head.fuse(plainShaft(size, length, shaftStartZ));
    return applyHeadAt(body, assertHeadAt(opts, "screws.button"));
  },
  /** ISO 10642 flat-head (countersunk) cap screw with plain shaft. */
  flat(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const body = flatHeadFull(size, length, /* includeShaft */ true);
    return applyHeadAt(body, assertHeadAt(opts, "screws.flat"));
  },
  /** ISO 4017 hex-head bolt with plain shaft. */
  hex(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = hexHeadBody(size);
    const body = head.fuse(plainShaft(size, length, shaftStartZ));
    return applyHeadAt(body, assertHeadAt(opts, "screws.hex"));
  },
  /** DIN 934 hex nut with a clean cylindrical bore (no thread geometry). */
  nut(size: MetricSize): Shape3D {
    const n = HEX_NUT[size];
    if (!n) throw new Error(`No hex-nut spec for ${size}.`);
    const outerR = n.acrossFlats / Math.sqrt(3);
    const body = drawPolysides(outerR, 6)
      .sketchOnPlane("XY")
      .extrude(-n.height)
      .asShape3D();
    const hole = makeCylinder(
      n.shaft / 2,
      n.height + 0.02,
      [0, 0, -n.height - 0.01],
      [0, 0, 1],
    );
    return body.cut(hole);
  },
};

// ── Threaded fasteners — bolts.* ───────────────────────────────────────────

function threadedScrew(
  headBody: (size: MetricSize) => { head: Shape3D; shaftStartZ: number },
  size: MetricSize,
  length: number,
): Shape3D {
  const { head, shaftStartZ } = headBody(size);
  const shaft = threadedShaft(size, length).translate(0, 0, shaftStartZ - length);
  return makeCompound([head, shaft]) as Shape3D;
}

export const bolts = {
  /**
   * Socket-head cap screw with real helical thread on the shaft.
   *
   * **Returns a Compound. Not fuse-safe.** The head and threaded shaft are
   * combined via `makeCompound`, so any `bolts.socket(...).fuse(part)` will
   * fail BRepCheck with non-manifold seams along the thread root. For
   * fuse/cut workflows, use {@link bolts.socketMesh} which returns a
   * watertight `MeshShape`.
   */
  socket(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const body = threadedScrew(socketHeadBody, size, length);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.socket"));
  },
  /**
   * Button-head cap screw with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.buttonMesh} for fuse/cut workflows.
   */
  button(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const body = threadedScrew(buttonHeadBody, size, length);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.button"));
  },
  /**
   * Flat-head (countersunk) cap screw with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.flatMesh} for fuse/cut workflows.
   */
  flat(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const head = flatHeadFull(size, length, /* includeShaft */ false);
    const f = FLAT_HEAD[size]!;
    const shaft = threadedShaft(size, length).translate(0, 0, -f.headD / 2 - length);
    const body = makeCompound([head, shaft]) as Shape3D;
    return applyHeadAt(body, assertHeadAt(opts, "bolts.flat"));
  },
  /**
   * Hex-head (ISO 4017) bolt with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.hexMesh} for fuse/cut workflows.
   */
  hex(spec: string, opts?: FastenerOrientOpts): Shape3D {
    const { size, length } = parseWithLength(spec);
    const body = threadedScrew(hexHeadBody, size, length);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.hex"));
  },
  /**
   * Hex nut with real helical internal thread. Returns a `MeshShape` because
   * OCCT's B-spline boolean on internal threads is too slow on WASM — the
   * Manifold mesh kernel handles it in ~100ms instead of 15s+. To combine
   * with a Shape3D, convert the other side first:
   *   plate.meshShape({ tolerance: 0.01 }).cut(bolts.nut("M3"))
   */
  nut(size: MetricSize): MeshShape {
    const n = HEX_NUT[size];
    if (!n) throw new Error(`No hex-nut spec for ${size}.`);
    const outerR = n.acrossFlats / Math.sqrt(3);
    const body = drawPolysides(outerR, 6)
      .sketchOnPlane("XY")
      .extrude(-n.height)
      .asShape3D();
    return tapInto(body, size, n.height, [0, 0, 0]);
  },
  /**
   * Socket-head cap screw as a **Manifold `MeshShape`** — fuse-safe. Same
   * dimensions as {@link bolts.socket} but the head and threaded shaft are
   * fused in the Manifold kernel, so the result can be cleanly `.fuse()`d or
   * `.cut()` against other MeshShapes (or mesh-converted Shape3Ds).
   */
  socketMesh(spec: string, opts?: FastenerOrientOpts): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = socketHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    const body = headMesh.fuse(threadMesh);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.socketMesh"));
  },
  /**
   * Button-head cap screw as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.button}.
   */
  buttonMesh(spec: string, opts?: FastenerOrientOpts): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = buttonHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    const body = headMesh.fuse(threadMesh);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.buttonMesh"));
  },
  /**
   * Hex-head bolt as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.hex}.
   */
  hexMesh(spec: string, opts?: FastenerOrientOpts): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = hexHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    const body = headMesh.fuse(threadMesh);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.hexMesh"));
  },
  /**
   * Flat-head cap screw as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.flat}. The head revolve already includes no shaft (we build
   * the thread separately), so the cone-to-shaft transition happens in the
   * Manifold mesh union instead of OCCT.
   */
  flatMesh(spec: string, opts?: FastenerOrientOpts): MeshShape {
    const { size, length } = parseWithLength(spec);
    const head = flatHeadFull(size, length, /* includeShaft */ false);
    const f = FLAT_HEAD[size]!;
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, -f.headD / 2 - length);
    const body = headMesh.fuse(threadMesh);
    return applyHeadAt(body, assertHeadAt(opts, "bolts.flatMesh"));
  },
};

// ── Washers ────────────────────────────────────────────────────────────────

export const washers = {
  /**
   * DIN 125 flat washer. Top at Z=0, body extends into -Z.
   */
  flat(size: MetricSize): Shape3D {
    const w = FLAT_WASHER[size];
    if (!w) throw new Error(`No flat-washer spec for ${size}.`);
    const outer = drawCircle(w.od / 2);
    const inner = drawCircle(w.id / 2);
    const ring = outer.cut(inner);
    return ring.sketchOnPlane("XY").extrude(-w.thickness).asShape3D();
  },
};

// ── Heat-set inserts ───────────────────────────────────────────────────────

export const inserts = {
  /**
   * Brass heat-set threaded insert — physical body for visualization. Plain
   * cylinder at the standards-table OD and depth. Top at Z=0, extends -Z.
   */
  heatSet(size: MetricSize): Shape3D {
    const i = HEAT_SET_INSERT[size];
    if (!i) throw new Error(`No heat-set spec for ${size}.`);
    const body = makeCylinder(i.od / 2, i.depth, [0, 0, -i.depth], [0, 0, 1]);
    const bore = makeCylinder(
      i.thread === size ? SOCKET_HEAD[size].shaft / 2 : 1,
      i.depth + 0.02,
      [0, 0, -i.depth - 0.01],
      [0, 0, 1],
    );
    return body.cut(bore);
  },

  /**
   * Cut-tool for a heat-set insert pocket. Diameter = `od + |FIT.press| × 2`
   * (small interference so the melting brass grips the plastic).
   *
   * @param size Metric designator (e.g. `"M3"`).
   * @param opts.axis Pocket direction (default `"+Z"` — pocket opens upward,
   *   tool extends into -Z). Pass `"+X"`/`"-X"`/`"+Y"`/`"-Y"`/`"-Z"` for a
   *   sideways pocket (e.g. an insert installed through a vertical wall).
   *   Rotation happens around the origin — callers typically `.translate()`
   *   the returned tool to the insert center AFTER the axis has been applied
   *   (same contract as `holes.*`).
   */
  pocket(size: MetricSize, opts?: { axis?: HoleAxis }): Shape3D {
    const i = HEAT_SET_INSERT[size];
    if (!i) throw new Error(`No heat-set spec for ${size}.`);
    const pocketD = i.od + Math.abs(FIT.press) * 2;
    const tool = makeCylinder(pocketD / 2, i.depth, [0, 0, -i.depth], [0, 0, 1]);
    return applyAxis(tool, opts?.axis);
  },
};
