/**
 * Hole library — cut-tool shapes for common mechanical features.
 *
 * Every function returns a Shape3D that the caller passes to `.cut()`. The
 * tool is oriented so its axis is Z, the top (entry) of the hole sits at Z=0,
 * and the tool extends into -Z. Users translate directly to the hole location:
 *
 *   plate.cut(holes.through("M3").translate(10, 10, 0))
 *
 * Dimensions (clearance, tap-drill, head sizes) come from `./standards.ts` so
 * every hole stays consistent with its matching fastener.
 */

import {
  draw,
  drawCircle,
  drawRectangle,
  makeCylinder,
  type Shape3D,
} from "replicad";
import {
  SOCKET_HEAD,
  FLAT_HEAD,
  FIT,
  type FitStyle,
  type MetricSize,
  parseScrewDesignator,
} from "./standards";

/**
 * Resolve a fit allowance (radial, mm) from a FitStyle name. Defaults to
 * clearance for through-holes when the user doesn't specify.
 */
function fitAllowance(style: FitStyle | undefined, fallback: FitStyle): number {
  return FIT[style ?? fallback];
}

/**
 * Through clearance hole. Pass a metric screw designator (`"M3"`) to get a
 * clearance-sized hole, or a raw number (mm) for a plain cylindrical hole of
 * that diameter. Default depth: 50 mm (use `opts.depth` to match your plate).
 *
 * @param size Metric designator (`"M3"`) or explicit diameter in mm.
 * @param opts.depth Overall tool length in mm (default 50).
 * @param opts.fit Fit style for metric sizes (default `"clearance"`).
 * @returns Cut-tool Shape3D, axis=Z, top at Z=0, extends into -Z.
 */
export function through(
  size: MetricSize | number,
  opts: { depth?: number; fit?: FitStyle } = {}
): Shape3D {
  const depth = opts.depth ?? 50;
  let diameter: number;
  if (typeof size === "number") {
    diameter = size;
  } else {
    const spec = SOCKET_HEAD[size];
    const allowance = fitAllowance(opts.fit, "clearance");
    diameter = spec.shaft + allowance * 2;
  }
  // makeCylinder(radius, height, location, direction) — location is the base
  // of the cylinder. Put base at -depth so the top sits at Z=0.
  return makeCylinder(diameter / 2, depth, [0, 0, -depth], [0, 0, 1]);
}

/**
 * Counterbored hole — clearance shaft through the plate plus a flat-bottomed
 * pocket sized for a socket-head cap screw head. Total cut depth = the
 * plate thickness; the pocket depth = `SOCKET_HEAD[size].headH + 0.2 mm`.
 *
 * @param spec Metric screw designator, e.g. `"M3"` (length component ignored).
 * @param opts.plateThickness Plate thickness in mm — the clearance shaft spans this.
 * @param opts.fit Fit style for the shaft (default `"clearance"`).
 * @returns Cut-tool Shape3D, top of pocket at Z=0.
 */
export function counterbore(
  spec: string,
  opts: { plateThickness: number; fit?: FitStyle }
): Shape3D {
  const { size } = parseScrewDesignator(spec);
  const head = SOCKET_HEAD[size];
  const allowance = fitAllowance(opts.fit, "clearance");
  const shaftD = head.shaft + allowance * 2;
  const pocketD = head.headD + 0.3; // slight clearance for the head OD
  const pocketH = head.headH + 0.2;
  const { plateThickness } = opts;

  // Pocket: sits at the top (top face at Z=0, bottom at Z=-pocketH).
  const pocket = makeCylinder(
    pocketD / 2,
    pocketH,
    [0, 0, -pocketH],
    [0, 0, 1]
  );
  // Shaft: runs the full plate thickness. Slight overlap into the pocket to
  // guarantee a clean boolean.
  const shaft = makeCylinder(
    shaftD / 2,
    plateThickness + 0.01,
    [0, 0, -plateThickness],
    [0, 0, 1]
  );
  return pocket.fuse(shaft);
}

/**
 * Countersunk hole — clearance shaft through the plate plus a 90° cone flare
 * sized to the ISO 10642 head OD. Cone depth = headD/2 (90° included angle).
 *
 * @param spec Metric screw designator, e.g. `"M4"`.
 * @param opts.plateThickness Plate thickness in mm.
 * @param opts.fit Fit style for the shaft (default `"clearance"`).
 * @returns Cut-tool Shape3D, top of countersink at Z=0.
 */
export function countersink(
  spec: string,
  opts: { plateThickness: number; fit?: FitStyle }
): Shape3D {
  const { size } = parseScrewDesignator(spec);
  const flat = FLAT_HEAD[size];
  if (!flat) {
    throw new Error(
      `countersink: no flat-head spec for ${size}. Available: ${Object.keys(FLAT_HEAD).join(", ")}`
    );
  }
  const allowance = fitAllowance(opts.fit, "clearance");
  const shaftD = flat.shaft + allowance * 2;
  const headR = flat.headD / 2;
  // 90° included angle → depth equals radius.
  const coneDepth = headR;
  const { plateThickness } = opts;

  // Build the cone by revolving a 2D profile in the XZ plane. We sketch the
  // axial half-profile (x >= 0) and spin it around Z.
  //
  // Profile (XZ plane, x = radius, y = z in world):
  //   start  (0, 0)
  //   out to (headR, 0)       -- top of countersink at Z=0
  //   down   (shaftD/2, -coneDepth)
  //   down   (shaftD/2, -plateThickness)
  //   in     (0, -plateThickness)
  //   close back to (0, 0)
  const profile = draw([0, 0])
    .hLine(headR)
    .lineTo([shaftD / 2, -coneDepth])
    .lineTo([shaftD / 2, -plateThickness])
    .hLine(-shaftD / 2)
    .close();

  return profile
    .sketchOnPlane("XZ")
    .revolve([0, 0, 1], { origin: [0, 0, 0] })
    .asShape3D();
}

/**
 * Tapped hole — a cylinder of `SOCKET_HEAD[size].tapDrill` diameter. Threads
 * are implicit (user taps them in metal) or irrelevant (printed threads are
 * unreliable — prefer `inserts.pocket` for FDM).
 *
 * @param size Metric designator, e.g. `"M3"`.
 * @param opts.depth Tap depth in mm (measured from Z=0 into -Z).
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function tapped(size: MetricSize, opts: { depth: number }): Shape3D {
  const { depth } = opts;
  const diameter = SOCKET_HEAD[size].tapDrill;
  return makeCylinder(diameter / 2, depth, [0, 0, -depth], [0, 0, 1]);
}

/**
 * Teardrop hole — a horizontal-axis hole that prints cleanly on FDM with no
 * supports. Cross-section is a circle fused with a triangular tip pointing in
 * the +Z direction, giving a 45° roof that FDM handles without drooping.
 *
 * The hole is extruded along the chosen `axis`. Default axis = `"Y"` (so the
 * hole runs parallel to Y, usable as a cross-hole through a vertical face in
 * the XZ plane). Pass `axis: "X"` to run the hole along X instead.
 *
 * @param size Metric designator (applies clearance fit) or raw diameter in mm.
 * @param opts.depth Length of the hole along its axis in mm.
 * @param opts.axis `"X"` or `"Y"` (default `"Y"`).
 * @returns Cut-tool Shape3D positioned with its entry face at the origin.
 */
export function teardrop(
  size: MetricSize | number,
  opts: { depth: number; axis?: "X" | "Y" }
): Shape3D {
  const axis = opts.axis ?? "Y";
  const { depth } = opts;
  let diameter: number;
  if (typeof size === "number") {
    diameter = size;
  } else {
    const spec = SOCKET_HEAD[size];
    diameter = spec.shaft + FIT.clearance * 2;
  }
  const r = diameter / 2;

  // Build the 2D cross-section in a plane normal to the extrusion axis. The
  // cross-section is drawn in local 2D coordinates where the local +Y will
  // map to world +Z (so the triangular tip points up — the printable roof).
  //
  // Shape: a full circle fused with an isoceles triangle whose apex sits at
  // local Y = 2r. The triangle's base sits at the circle equator (y = 0) so
  // the fused outline is: lower half of the circle plus two straight lines
  // meeting at the apex. This gives FDM a ~45° (actually arctan(2) ≈ 63°)
  // roof which prints cleanly without supports.
  const circle = drawCircle(r);
  const triangle = draw([r, 0])
    .lineTo([0, 2 * r])
    .lineTo([-r, 0])
    .close();
  const outline = circle.fuse(triangle);

  // Pick a plane where the sketch's local +Y maps to world +Z (so the apex
  // points up). Extrude along the chosen world axis.
  //
  //   axis = "Y" → sketch on XZ, extrude along +Y. Local X → world X, local Y → world Z.
  //   axis = "X" → sketch on YZ, extrude along +X. Local X → world Y, local Y → world Z.
  const plane = axis === "Y" ? "XZ" : "YZ";
  const sketch = outline.sketchOnPlane(plane);
  // Extrude full depth along the plane normal; the resulting solid sits in
  // the half-space axis >= 0. Users translate it to the target face.
  return sketch.extrude(depth).asShape3D();
}

/**
 * Keyhole — a large circle joined by a narrow slot to a small circle. Used
 * for hang-on-screw mounts where a screw head enters the large opening and
 * slides into the small round.
 *
 * Layout: large circle at (0, 0), small circle at (0, -(largeD/2 + smallD/2 + slot)),
 * connected by a slot of width `smallD`.
 *
 * @param opts.largeD Entry-hole diameter (big enough for the screw head).
 * @param opts.smallD Capture-hole diameter (matches the screw shaft clearance).
 * @param opts.slot Centre-to-centre offset between the two circles in mm.
 * @param opts.depth Hole depth in mm.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function keyhole(opts: {
  largeD: number;
  smallD: number;
  slot: number;
  depth: number;
}): Shape3D {
  const { largeD, smallD, slot, depth } = opts;
  const largeR = largeD / 2;
  const smallR = smallD / 2;

  const large = drawCircle(largeR);
  const small = drawCircle(smallR).translate(0, -slot);
  // Neck: rectangle wide = smallD, length = slot distance, centred between
  // the two circle centres at y = -slot/2.
  const neck = drawRectangle(smallD, slot).translate(0, -slot / 2);

  const profile = large.fuse(neck).fuse(small);
  return profile.sketchOnPlane("XY").extrude(-depth).asShape3D();
}

/**
 * Slotted hole — elongated hole with rounded ends, used for adjustment. The
 * overall length (tip-to-tip) is `length`; the width (hole diameter / radius
 * of the end-caps × 2) is `width`. The slot runs along the X axis.
 *
 * @param opts.length Overall length (tip to tip) in mm — must be >= `width`.
 * @param opts.width Slot width in mm (diameter of the rounded ends).
 * @param opts.depth Hole depth in mm.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function slot(opts: {
  length: number;
  width: number;
  depth: number;
}): Shape3D {
  const { length, width, depth } = opts;
  if (length < width) {
    throw new Error(
      `holes.slot: length (${length}) must be >= width (${width}).`
    );
  }
  const r = width / 2;
  // Centre-to-centre distance of the end caps.
  const centres = length - width;
  // If length == width, the slot degenerates to a single circle.
  const profile =
    centres === 0
      ? drawCircle(r)
      : drawCircle(r)
          .translate(-centres / 2, 0)
          .fuse(drawRectangle(centres, width))
          .fuse(drawCircle(r).translate(centres / 2, 0));
  return profile.sketchOnPlane("XY").extrude(-depth).asShape3D();
}
