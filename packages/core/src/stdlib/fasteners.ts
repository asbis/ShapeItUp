/**
 * Fastener library — positive Shape3D representations of common hardware.
 *
 * Every factory returns the physical part oriented so:
 *   - The fastener's central axis is world Z.
 *   - The "top" face (where a wrench grabs the head, or the top of a nut/washer)
 *     sits at Z = 0.
 *   - The shaft (for screws) extends into -Z.
 *
 * Colors are left to the caller — users colour fasteners by wrapping them in
 * the `{ shape, name, color }` assembly form.
 */

import {
  draw,
  drawCircle,
  drawPolysides,
  makeCylinder,
  type Shape3D,
} from "replicad";
import {
  SOCKET_HEAD,
  BUTTON_HEAD,
  FLAT_HEAD,
  HEX_NUT,
  FLAT_WASHER,
  HEAT_SET_INSERT,
  FIT,
  type MetricSize,
  parseScrewDesignator,
} from "./standards";

/** Parse a designator that requires a length component, e.g. `"M3x10"`. */
function parseWithLength(spec: string): { size: MetricSize; length: number } {
  const parsed = parseScrewDesignator(spec);
  if (parsed.length === undefined) {
    throw new Error(
      `Screw designator "${spec}" needs a length, e.g. "${parsed.size}x10".`
    );
  }
  return { size: parsed.size, length: parsed.length };
}

export const screws = {
  /**
   * ISO 4762 socket-head cap screw. Head at Z=0, shaft extending into -Z.
   * The hex recess is cut into the top of the head for visual fidelity.
   *
   * @param spec Designator with length, e.g. `"M3x10"` (size × shaft length mm).
   * @returns Positive Shape3D of the screw.
   */
  socketHead(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const s = SOCKET_HEAD[size];
    // Head: cylinder, top at Z=0, bottom at Z=-headH.
    const head = makeCylinder(s.headD / 2, s.headH, [0, 0, -s.headH], [0, 0, 1]);
    // Shaft: cylinder starting at the bottom of the head, extending -length.
    const shaft = makeCylinder(
      s.shaft / 2,
      length,
      [0, 0, -s.headH - length],
      [0, 0, 1]
    );
    // Hex recess: cut a hex pocket into the top of the head.
    const recessDepth = s.headH * 0.6;
    const recess = drawPolysides(s.hex / Math.sqrt(3), 6)
      .sketchOnPlane("XY")
      .extrude(-recessDepth)
      .asShape3D();
    let body = head.fuse(shaft);
    try {
      body = body.cut(recess);
    } catch {
      // Hex recess is cosmetic — skip silently if the boolean can't be formed.
    }
    return body;
  },

  /**
   * ISO 7380 button-head cap screw. Low-profile domed head, hex recess.
   *
   * @param spec Designator with length, e.g. `"M4x8"`.
   * @returns Positive Shape3D of the screw.
   */
  buttonHead(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const b = BUTTON_HEAD[size];
    if (!b) {
      throw new Error(
        `buttonHead: no spec for ${size}. Available: ${Object.keys(BUTTON_HEAD).join(", ")}`
      );
    }
    const headR = b.headD / 2;
    const headH = b.headH;
    // Approximate the dome by revolving a rounded profile in XZ:
    //   (0, 0) -> (headR, 0) -> (headR, -headH/2) tangent-arc up to (0, headH*0.2?)
    // Simpler: build a cylinder head and round its top.
    // For v1 — use a short cylinder as the head; it reads as a button-head in
    // the viewer thanks to its low H/D ratio. Users who need a true dome can
    // replace the model at render time.
    const head = makeCylinder(headR, headH, [0, 0, -headH], [0, 0, 1]);
    const shaft = makeCylinder(
      b.shaft / 2,
      length,
      [0, 0, -headH - length],
      [0, 0, 1]
    );
    const recessDepth = headH * 0.5;
    const recess = drawPolysides(b.hex / Math.sqrt(3), 6)
      .sketchOnPlane("XY")
      .extrude(-recessDepth)
      .asShape3D();
    let body = head.fuse(shaft);
    try {
      body = body.cut(recess);
    } catch {}
    return body;
  },

  /**
   * ISO 10642 flat (countersunk) head cap screw. The head is an inverted cone
   * (90° included), built by revolving a 2D profile. Head top at Z=0.
   *
   * @param spec Designator with length, e.g. `"M5x12"`.
   * @returns Positive Shape3D of the screw.
   */
  flatHead(spec: string): Shape3D {
    const { size, length } = parseWithLength(spec);
    const f = FLAT_HEAD[size];
    if (!f) {
      throw new Error(
        `flatHead: no spec for ${size}. Available: ${Object.keys(FLAT_HEAD).join(", ")}`
      );
    }
    const headR = f.headD / 2;
    const coneDepth = headR; // 90° included cone → depth = radius
    const shaftR = f.shaft / 2;

    // Profile in XZ plane (x = radius, y = z in world). Covers the head
    // (inverted cone) AND the shaft, all in one revolution — avoids a fragile
    // fuse between head and shaft.
    //
    //   (0, 0)  -> top of head (axis)
    //   (headR, 0)  -> head rim (Z=0)
    //   (shaftR, -coneDepth)  -> transition from cone to shaft
    //   (shaftR, -coneDepth - length)  -> shaft tip
    //   back to (0, -coneDepth - length)  -> axis
    //   close up the axis to (0, 0)
    const profile = draw([0, 0])
      .hLine(headR)
      .lineTo([shaftR, -coneDepth])
      .lineTo([shaftR, -coneDepth - length])
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
    try {
      body = body.cut(recess);
    } catch {}
    return body;
  },
};

export const nuts = {
  /**
   * DIN 934 hex nut. Top at Z=0, body extends into -Z. Through-hole matches
   * nominal shaft diameter.
   *
   * @param size Metric designator, e.g. `"M3"`.
   * @returns Positive Shape3D of the nut.
   */
  hex(size: MetricSize): Shape3D {
    const n = HEX_NUT[size];
    if (!n) {
      throw new Error(
        `nuts.hex: no spec for ${size}. Available: ${Object.keys(HEX_NUT).join(", ")}`
      );
    }
    // drawPolysides(radius, 6) — `radius` in replicad is the outer radius
    // (circumscribed circle). DIN hex nuts spec across-flats (inscribed-circle
    // diameter), so convert: radius = acrossFlats / sqrt(3).
    const outerR = n.acrossFlats / Math.sqrt(3);
    const body = drawPolysides(outerR, 6)
      .sketchOnPlane("XY")
      .extrude(-n.height)
      .asShape3D();
    const hole = makeCylinder(
      n.shaft / 2,
      n.height + 0.02,
      [0, 0, -n.height - 0.01],
      [0, 0, 1]
    );
    return body.cut(hole);
  },
};

export const washers = {
  /**
   * DIN 125 flat washer. Top at Z=0, body extends into -Z.
   *
   * @param size Metric designator, e.g. `"M3"`.
   * @returns Positive Shape3D of the washer.
   */
  flat(size: MetricSize): Shape3D {
    const w = FLAT_WASHER[size];
    if (!w) {
      throw new Error(
        `washers.flat: no spec for ${size}. Available: ${Object.keys(FLAT_WASHER).join(", ")}`
      );
    }
    const outer = drawCircle(w.od / 2);
    const inner = drawCircle(w.id / 2);
    const ring = outer.cut(inner);
    return ring.sketchOnPlane("XY").extrude(-w.thickness).asShape3D();
  },
};

export const inserts = {
  /**
   * Brass heat-set threaded insert — physical body for visualization. Plain
   * cylinder of the standards-table OD and depth. Top at Z=0, extends -Z.
   *
   * @param size Metric designator, e.g. `"M3"`.
   * @returns Positive Shape3D of the insert.
   */
  heatSet(size: MetricSize): Shape3D {
    const i = HEAT_SET_INSERT[size];
    if (!i) {
      throw new Error(
        `inserts.heatSet: no spec for ${size}. Available: ${Object.keys(HEAT_SET_INSERT).join(", ")}`
      );
    }
    const body = makeCylinder(
      i.od / 2,
      i.depth,
      [0, 0, -i.depth],
      [0, 0, 1]
    );
    // Punch a nominal-thread hole through the length for visual cue.
    const bore = makeCylinder(
      i.thread === size ? SOCKET_HEAD[size].shaft / 2 : 1,
      i.depth + 0.02,
      [0, 0, -i.depth - 0.01],
      [0, 0, 1]
    );
    return body.cut(bore);
  },

  /**
   * Cut-tool for a heat-set insert pocket. Diameter = `od + FIT.press` × 2
   * (small interference so the melting brass grips the plastic). Depth =
   * `HEAT_SET_INSERT[size].depth`. Use:
   *
   *   part.cut(inserts.pocket("M3").translate(x, y, 0))
   *
   * @param size Metric designator, e.g. `"M3"`.
   * @returns Cut-tool Shape3D, top at Z=0, extends into -Z.
   */
  pocket(size: MetricSize): Shape3D {
    const i = HEAT_SET_INSERT[size];
    if (!i) {
      throw new Error(
        `inserts.pocket: no spec for ${size}. Available: ${Object.keys(HEAT_SET_INSERT).join(", ")}`
      );
    }
    // FIT.press is negative (interference). Adding to diameter gives the
    // "melt-in" allowance. Spec text says "+ 0.1 mm" — we use 2*|press| on
    // the diameter which comes out to 0.1 mm for the default press fit.
    const pocketD = i.od + Math.abs(FIT.press) * 2;
    return makeCylinder(
      pocketD / 2,
      i.depth,
      [0, 0, -i.depth],
      [0, 0, 1]
    );
  },
};
