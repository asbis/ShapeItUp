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

// ── Cosmetic fasteners — screws.* ──────────────────────────────────────────

export const screws = {
  /** ISO 4762 socket-head cap screw with plain (unthreaded) shaft. */
  socket(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = socketHeadBody(size);
    return head.fuse(plainShaft(size, length, shaftStartZ));
  },
  /** ISO 7380 button-head cap screw with plain shaft. */
  button(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = buttonHeadBody(size);
    return head.fuse(plainShaft(size, length, shaftStartZ));
  },
  /** ISO 10642 flat-head (countersunk) cap screw with plain shaft. */
  flat(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    return flatHeadFull(size, length, /* includeShaft */ true);
  },
  /** ISO 4017 hex-head bolt with plain shaft. */
  hex(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = hexHeadBody(size);
    return head.fuse(plainShaft(size, length, shaftStartZ));
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
  socket(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    return threadedScrew(socketHeadBody, size, length);
  },
  /**
   * Button-head cap screw with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.buttonMesh} for fuse/cut workflows.
   */
  button(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    return threadedScrew(buttonHeadBody, size, length);
  },
  /**
   * Flat-head (countersunk) cap screw with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.flatMesh} for fuse/cut workflows.
   */
  flat(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const head = flatHeadFull(size, length, /* includeShaft */ false);
    const f = FLAT_HEAD[size]!;
    const shaft = threadedShaft(size, length).translate(0, 0, -f.headD / 2 - length);
    return makeCompound([head, shaft]) as Shape3D;
  },
  /**
   * Hex-head (ISO 4017) bolt with real helical thread.
   *
   * **Returns a Compound. Not fuse-safe.** See {@link bolts.socket} — use
   * {@link bolts.hexMesh} for fuse/cut workflows.
   */
  hex(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    return threadedScrew(hexHeadBody, size, length);
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
  socketMesh(spec: string): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = socketHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    return headMesh.fuse(threadMesh);
  },
  /**
   * Button-head cap screw as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.button}.
   */
  buttonMesh(spec: string): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = buttonHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    return headMesh.fuse(threadMesh);
  },
  /**
   * Hex-head bolt as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.hex}.
   */
  hexMesh(spec: string): MeshShape {
    const { size, length } = parseWithLength(spec);
    const { head, shaftStartZ } = hexHeadBody(size);
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, shaftStartZ - length);
    return headMesh.fuse(threadMesh);
  },
  /**
   * Flat-head cap screw as a `MeshShape` — fuse-safe counterpart to
   * {@link bolts.flat}. The head revolve already includes no shaft (we build
   * the thread separately), so the cone-to-shaft transition happens in the
   * Manifold mesh union instead of OCCT.
   */
  flatMesh(spec: string): MeshShape {
    const { size, length } = parseWithLength(spec);
    const head = flatHeadFull(size, length, /* includeShaft */ false);
    const f = FLAT_HEAD[size]!;
    const headMesh = head.meshShape({ tolerance: 0.01 });
    const threadMesh = metricMesh(size, length).translate(0, 0, -f.headD / 2 - length);
    return headMesh.fuse(threadMesh);
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
