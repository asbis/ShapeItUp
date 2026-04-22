/**
 * Hole library — cut-tool shapes for common mechanical features.
 *
 * Every function returns a Shape3D that the caller passes to `.cut()`. The
 * tool is oriented so its axis is Z, the top (entry) of the hole sits at Z=0,
 * and the tool extends into -Z. Users translate directly to the hole location:
 *
 *   plate.cut(holes.through("M3").translate(10, 10, plateTopZ))
 *
 * All directional functions accept an optional `axis` parameter specifying
 * which face the hole OPENS ON — the body always penetrates in the OPPOSITE
 * direction (into the material):
 *   "+Z" (default) opens on top, drills down     — body Z ∈ [-depth, 0]
 *   "-Z"           opens on bottom, drills up    — body Z ∈ [0, depth]
 *   "+X"           opens on +X face, drills -X   — body X ∈ [-depth, 0]
 *   "-X"           opens on -X face, drills +X   — body X ∈ [0, depth]
 *   "+Y"           opens on +Y face, drills -Y   — body Y ∈ [-depth, 0]
 *   "-Y"           opens on -Y face, drills +Y   — body Y ∈ [0, depth]
 *
 * Example — drilling through a wall whose +X face is at X=5:
 *   plate.cut(holes.through("M4", { depth: 10, axis: "+X" }).translate(5, y, z))
 *                                                                     ^ wall's +X face
 * The cutter's opening lands at X=5 and the body extends to X=-5, so the
 * whole wall thickness (X ∈ [0, 5]) is drilled out.
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
  CUT_EPSILON,
  type FitStyle,
  type MetricSize,
  parseScrewDesignator,
  assertPositiveFinite,
  assertSupportedSize,
} from "./standards";
import { pushRuntimeWarning, claimAmbiguousRawWarning } from "./warnings";

/**
 * Raw diameters that equal a nominal metric size (M3, M4, M5, M6, M8, M10, M12).
 * When a user passes `holes.through(4, ...)` they usually want the ISO-273
 * clearance hole (~4.5mm for M4), not a literal 4mm cylinder. Because the
 * string and numeric paths produce different diameters by design, silently
 * accepting an integer is a footgun. Emit a one-shot advisory warning so the
 * user can either switch to the string form or pass `{ raw: true }` (or a
 * non-integer) to document the intent. See Issue #7.
 */
const AMBIGUOUS_RAW_DIAMETERS = new Set([3, 4, 5, 6, 8, 10, 12]);

function warnAmbiguousRawDiameter(
  fnName: string,
  size: number,
  fit: FitStyle | undefined,
  effectiveFit: FitStyle,
  raw?: boolean,
): void {
  // Explicit `{ raw: true }` is the intent-declaring escape hatch — the user
  // has asserted they want the literal diameter, so silently skip the advisory.
  if (raw === true) return;
  if (!Number.isInteger(size)) return; // non-integer diameters (e.g. 8.2) disambiguate intent
  if (!AMBIGUOUS_RAW_DIAMETERS.has(size)) return;
  if (!claimAmbiguousRawWarning(size)) return; // at most once per run per size
  const key = `M${size}` as MetricSize;
  const spec = SOCKET_HEAD[key];
  if (!spec) return;
  const allowance = FIT[fit ?? effectiveFit];
  const specDiameter = spec.shaft + allowance * 2;
  pushRuntimeWarning(
    `${fnName}: received raw diameter ${size}mm — did you mean ${fnName}('${key}')? ` +
      `String form applies ISO clearance fit (~${specDiameter.toFixed(2)}mm for '${fit ?? effectiveFit}' fit). ` +
      `Pass \`{ raw: true }\` to treat the numeric diameter as intentional and suppress this advisory.`,
  );
}

/**
 * Axis specifier for hole orientation.
 *
 * **Semantic: axis names the face the hole opens ON, not the direction the
 * drill bit points.** `"+X"` means the hole enters through the +X face of
 * your part — i.e. after `.translate(x,y,z)` the cutter's opening sits at
 * that point and the body extends in the OPPOSITE direction (into -X),
 * penetrating into the material.
 *
 * Per-axis geometry (tool in its pre-translate local frame):
 *   "+Z"  opening at Z=0,  body Z ∈ [-depth, 0]   (drill points down)
 *   "-Z"  opening at Z=0,  body Z ∈ [0, depth]    (drill points up)
 *   "+X"  opening at X=0,  body X ∈ [-depth, 0]   (drill points -X)
 *   "-X"  opening at X=0,  body X ∈ [0, depth]    (drill points +X)
 *   "+Y"  opening at Y=0,  body Y ∈ [-depth, 0]   (drill points -Y)
 *   "-Y"  opening at Y=0,  body Y ∈ [0, depth]    (drill points +Y)
 *
 * Per-axis mnemonic — "drill enters from the named face, body penetrates opposite":
 *   "+X"  drill enters from the +X-facing side; body penetrates toward -X
 *   "-X"  drill enters from the -X-facing side; body penetrates toward +X
 *   "+Y"  drill enters from the +Y-facing side; body penetrates toward -Y
 *   "-Y"  drill enters from the -Y-facing side; body penetrates toward +Y
 *   "+Z"  drill enters from the +Z-facing side (top); body penetrates toward -Z
 *   "-Z"  drill enters from the -Z-facing side (bottom); body penetrates toward +Z
 *
 * So for a wall with its +X face at X=`thickness`, `axis: "+X"` plus
 * `.translate(thickness, y, z)` drills a hole INTO the wall from the +X
 * side — exactly matching engineering intuition.
 */
export type HoleAxis = "+Z" | "-Z" | "+X" | "-X" | "+Y" | "-Y";

/**
 * Flip a HoleAxis sign: +X ↔ -X, +Y ↔ -Y, +Z ↔ -Z.
 */
function flipAxis(axis: HoleAxis): HoleAxis {
  switch (axis) {
    case "+X": return "-X";
    case "-X": return "+X";
    case "+Y": return "-Y";
    case "-Y": return "+Y";
    case "+Z": return "-Z";
    case "-Z": return "+Z";
  }
}

/**
 * Normalize `axis` + `drillDirection` into a single `axis` value.
 *
 * `drillDirection` is the inverse alias of `axis`: `drillDirection: "+X"` names
 * the direction the drill bit points (so the hole opens on -X), which equals
 * `axis: "-X"`. If both are provided we throw — they are inverse aliases and
 * specifying both is almost certainly a user error.
 *
 * Exported so other cut-tool factories (e.g. `bearings.seat`, `bearings.linearSeat`)
 * can mirror the same axis/drillDirection resolution rules without duplicating
 * the error message.
 */
export function resolveHoleAxis(
  fnName: string,
  axis: HoleAxis | undefined,
  drillDirection: HoleAxis | undefined,
): HoleAxis | undefined {
  if (axis !== undefined && drillDirection !== undefined) {
    throw new Error(
      `${fnName}: both 'axis' (${axis}) and 'drillDirection' (${drillDirection}) were provided. ` +
        `These are inverse aliases — 'axis' names the face the hole OPENS ON, ` +
        `while 'drillDirection' names where the drill bit POINTS. Pick one.`
    );
  }
  if (drillDirection !== undefined) return flipAxis(drillDirection);
  return axis;
}

/**
 * Rotate a Shape3D from the default +Z orientation to the given axis.
 * Returns the shape unchanged for "+Z".
 *
 * The source tool (before rotation) has its opening at Z=0 with the body
 * spanning Z ∈ [-depth, 0]. After rotation, the opening stays at the local
 * origin on the named face, and the body extends in the direction OPPOSITE
 * to the axis name:
 *   "+X" → rotate +90° about Y  → body at X ∈ [-depth, 0]   (drill -X)
 *   "-X" → rotate -90° about Y  → body at X ∈ [0,  depth]   (drill +X)
 *   "+Y" → rotate -90° about X  → body at Y ∈ [-depth, 0]   (drill -Y)
 *   "-Y" → rotate +90° about X  → body at Y ∈ [0,  depth]   (drill +Y)
 *   "-Z" → rotate 180° about X  → body at Z ∈ [0,  depth]   (drill +Z)
 *
 * Exported for unit testing — the hole helpers themselves need OCCT to run,
 * but the rotation-routing logic is pure (just `.rotate()` dispatch) and
 * can be tested against a mock Shape3D that records rotate calls.
 */
export function applyAxis(shape: Shape3D, axis: HoleAxis | undefined): Shape3D {
  switch (axis) {
    case "+Z":
    case undefined:
      return shape;
    case "-Z":
      return shape.rotate(180, [0, 0, 0], [1, 0, 0]);
    case "+X":
      // +90° about Y flips the +Z-pointing tool to -X, so opening at X=0
      // and body extends into -X (penetrates through the +X face).
      return shape.rotate(90, [0, 0, 0], [0, 1, 0]);
    case "-X":
      return shape.rotate(-90, [0, 0, 0], [0, 1, 0]);
    case "+Y":
      // -90° about X flips the +Z-pointing tool to -Y: opening at Y=0,
      // body extends into -Y (penetrates through the +Y face).
      return shape.rotate(-90, [0, 0, 0], [1, 0, 0]);
    case "-Y":
      return shape.rotate(90, [0, 0, 0], [1, 0, 0]);
    default:
      return shape;
  }
}

/**
 * Resolve a fit allowance (radial, mm) from a FitStyle name. Defaults to
 * clearance for through-holes when the user doesn't specify.
 */
function fitAllowance(style: FitStyle | undefined, fallback: FitStyle): number {
  return FIT[style ?? fallback];
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Through clearance hole. Pass a metric screw designator (`"M3"`) to get a
 * clearance-sized hole, or a raw number (mm) for a plain cylindrical hole of
 * that diameter. Default depth: 50 mm (use `opts.depth` to match your plate).
 *
 * @remarks ANCHOR
 *   Origin: tool opening sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: body extends in the opposite direction (into -Z by default).
 *   Translate target: place the tool opening at the plate's TOP surface.
 *   Example: plate.cut(holes.through("M5").translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: the returned cylinder spans `Z ∈ [-depth, 0]` — its
 * top face sits AT Z=0 and it extends DOWNWARD into -Z. This anchors the cut
 * tool so `.translate(x, y, plateTop)` puts the hole's mouth flush with the
 * plate's upper face. Translating by a smaller Z (or none) leaves the cutter
 * BELOW the plate, and the cut silently removes nothing. If you see a
 * `patterns.cutAt` or `.cut()` "no material removal" warning, first confirm
 * the `.translate(0, 0, Z)` places the cutter INTO the plate, not above or
 * below it.
 *
 * @example
 * // Horizontal hole through a vertical wall at X ∈ [0, 5]: translate to the
 * // wall's +X face (X=5); axis: "+X" drills into -X, penetrating the wall.
 * wall.cut(holes.through("M5", { depth: 10, axis: "+X" }).translate(5, y, z))
 *
 * @param size Metric designator (`"M3"`) or explicit diameter in mm.
 * @param opts.depth Overall tool length in mm (default 50).
 * @param opts.fit Fit style for metric sizes (default `"clearance"`).
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the hole OPENS ON; the body penetrates in the OPPOSITE direction. `"+X"` = opens on +X face, drills -X. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.raw Pass `{ raw: true }` to treat the numeric diameter as intentional and suppress the "did you mean Mxx?" advisory that fires when a bare integer matches a standard metric size (3, 4, 5, 6, 8, 10, 12). No effect when `size` is a string designator.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge — useful for precise mating surfaces where the cutter must terminate exactly at the target face. Default false (stdlib adds `CUT_EPSILON` on each end to avoid OCCT coincident-face failures).
 * @returns Cut-tool Shape3D, axis=Z, top at Z=0, extends into -Z.
 */
export function through(
  size: MetricSize | number,
  opts: {
    depth?: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
    drillDirection?: HoleAxis;
    raw?: boolean;
    strict?: boolean;
  } = {}
): Shape3D {
  const axis = resolveHoleAxis("holes.through", opts.axis, opts.drillDirection);
  const depth = opts.depth ?? 50;
  assertPositiveFinite("holes.through", "opts.depth", depth);
  let diameter: number;
  if (typeof size === "number") {
    assertPositiveFinite("holes.through", "size", size);
    warnAmbiguousRawDiameter("holes.through", size, opts.fit, "clearance", opts.raw);
    diameter = size;
  } else {
    assertSupportedSize(size, SOCKET_HEAD, "socket-head");
    const spec = SOCKET_HEAD[size];
    const allowance = fitAllowance(opts.fit, "clearance");
    diameter = spec.shaft + allowance * 2;
  }
  // Extend the cutter past both faces by CUT_EPSILON so coincident faces
  // don't produce non-manifold geometry. `strict: true` opts out.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const totalHeight = depth + eps * 2;
  // makeCylinder(radius, height, location, direction) — location is the base
  // of the cylinder. Put base at -depth - eps so the top sits at +eps.
  const tool = makeCylinder(diameter / 2, totalHeight, [0, 0, -depth - eps], [0, 0, 1]);
  return applyAxis(tool, axis);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Alias for `holes.through(size, { fit: "clearance" })` — matches the common
 * engineering term "clearance hole". Identical behaviour to `through`, but
 * the `fit` option defaults to `"clearance"` when unspecified (which is
 * already the default for `through`, so calls are fully interchangeable).
 *
 * @remarks ANCHOR
 *   Origin: tool opening sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: body extends in the opposite direction (into -Z by default).
 *   Translate target: place the tool opening at the plate's TOP surface.
 *   Example: plate.cut(holes.clearance("M5").translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: same as `through` — the cylinder spans `Z ∈ [-depth, 0]`
 * with its top face anchored at Z=0. Translate by `plateTop` to place the
 * hole's mouth flush with the plate's upper surface.
 *
 * @example
 * // Sideways clearance hole through a flange whose +Y face is at Y=5:
 * // translate to Y=5, axis "+Y" makes the hole drill into -Y.
 * flange.cut(holes.clearance("M4", { depth: 8, axis: "+Y" }).translate(x, 5, z))
 *
 * @param size Metric designator (`"M3"`) or explicit diameter in mm.
 * @param opts Same options as `holes.through`, including `axis` for non-vertical holes.
 * @param opts.raw Pass `{ raw: true }` to treat the numeric diameter as intentional and suppress the "did you mean Mxx?" advisory that fires when a bare integer matches a standard metric size.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge. Default false.
 * @returns Cut-tool Shape3D, axis=Z, top at Z=0, extends into -Z.
 */
export function clearance(
  size: MetricSize | number,
  opts: {
    depth?: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
    drillDirection?: HoleAxis;
    raw?: boolean;
    strict?: boolean;
  } = {}
): Shape3D {
  return through(size, { ...opts, fit: opts.fit ?? "clearance" });
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Counterbored hole — clearance shaft through the plate plus a flat-bottomed
 * pocket sized for a socket-head cap screw head. Total cut depth = the
 * plate thickness; the pocket depth = `SOCKET_HEAD[size].headH + 0.2 mm`.
 *
 * @remarks ANCHOR
 *   Origin: pocket opening sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: shaft+pocket extend in the opposite direction (into -Z by default).
 *   Translate target: place the pocket opening at the plate's TOP surface.
 *   Example: plate.cut(holes.counterbore("M5", { plateThickness: t }).translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: the pocket's top face is at Z=0 and the tool extends
 * downward into -Z (shaft spans `Z ∈ [-plateThickness, 0]`, pocket sits just
 * below Z=0). To cut a pocket from the TOP of a plate, translate by
 * `plateTop`: `plate.cut(holes.counterbore("M3", {plateThickness: t}).translate(x, y, t))`.
 * If you see "no material removal" warnings, check the translate places the
 * cutter INTO the plate, not above it.
 *
 * @example
 * // Counterbore in a vertical Y-flange (pocket opens on the +Y face at Y=5,
 * // shaft penetrates into -Y).
 * flange.cut(holes.counterbore("M4", { plateThickness: 5, axis: "+Y" }).translate(x, 5, z))
 *
 * @param spec Metric screw designator, e.g. `"M3"` (length component ignored).
 * @param opts.plateThickness Plate thickness in mm — the clearance shaft spans this.
 * @param opts.fit Fit style for the shaft (default `"clearance"`).
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the pocket OPENS ON; the shaft penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge on the shaft (the pocket depth is a functional dimension and is unaffected). Default false.
 * @returns Cut-tool Shape3D, top of pocket at Z=0.
 */
export function counterbore(
  spec: string,
  opts: {
    plateThickness: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
    drillDirection?: HoleAxis;
    strict?: boolean;
  }
): Shape3D {
  const axis = resolveHoleAxis("holes.counterbore", opts.axis, opts.drillDirection);
  assertPositiveFinite("holes.counterbore", "opts.plateThickness", opts.plateThickness);
  const { size } = parseScrewDesignator(spec);
  assertSupportedSize(size, SOCKET_HEAD, "socket-head");
  const head = SOCKET_HEAD[size];
  const allowance = fitAllowance(opts.fit, "clearance");
  const shaftD = head.shaft + allowance * 2;
  const pocketD = head.headD + 0.3; // slight clearance for the head OD
  const pocketH = head.headH + 0.2;
  const { plateThickness } = opts;

  // Pocket: sits at the top (top face at Z=0, bottom at Z=-pocketH). Pocket
  // depth is a functional dimension — intentionally NOT extended by the
  // through-cut epsilon (the pocket does not pass through).
  const pocket = makeCylinder(
    pocketD / 2,
    pocketH,
    [0, 0, -pocketH],
    [0, 0, 1]
  );
  // Shaft: runs the full plate thickness, extended past the bottom face by
  // CUT_EPSILON so coincident faces don't produce non-manifold geometry. The
  // original overlap into the pocket is preserved by starting at -plateThickness.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const shaft = makeCylinder(
    shaftD / 2,
    plateThickness + eps,
    [0, 0, -plateThickness - eps],
    [0, 0, 1]
  );
  const tool = pocket.fuse(shaft);
  return applyAxis(tool, axis);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Countersunk hole — clearance shaft through the plate plus a 90° cone flare
 * sized to the ISO 10642 head OD. Cone depth = headD/2 (90° included angle).
 *
 * @remarks ANCHOR
 *   Origin: flare opening sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: cone+shaft extend in the opposite direction (into -Z by default).
 *   Translate target: place the flare opening at the plate's TOP surface.
 *   Example: plate.cut(holes.countersink("M5", { plateThickness: t }).translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: the countersink's top (widest) face is at Z=0 and the
 * tool extends downward into -Z (bottom of the shaft at `Z = -plateThickness`).
 * Translate by `plateTop` so the flare sits flush with the plate's upper face:
 * `plate.cut(holes.countersink("M4", {plateThickness: t}).translate(x, y, t))`.
 *
 * @example
 * // Countersink into a vertical X-flange (flare opens on the +X face at X=5,
 * // shaft penetrates into -X).
 * flange.cut(holes.countersink("M4", { plateThickness: 5, axis: "+X" }).translate(5, y, z))
 *
 * @param spec Metric screw designator, e.g. `"M4"`.
 * @param opts.plateThickness Plate thickness in mm.
 * @param opts.fit Fit style for the shaft (default `"clearance"`).
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the flare OPENS ON; the shaft penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.strict When true, skip the `CUT_EPSILON` nudge that extends the shaft past the plate's back face (cone depth is a functional dimension and is unaffected). Default false.
 * @returns Cut-tool Shape3D, top of countersink at Z=0.
 */
export function countersink(
  spec: string,
  opts: {
    plateThickness: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
    drillDirection?: HoleAxis;
    strict?: boolean;
  }
): Shape3D {
  const axis = resolveHoleAxis("holes.countersink", opts.axis, opts.drillDirection);
  assertPositiveFinite("holes.countersink", "opts.plateThickness", opts.plateThickness);
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
  // 90° included angle → depth equals radius. Cone depth is a functional
  // dimension — NOT extended by the through-cut epsilon.
  const coneDepth = headR;
  const { plateThickness } = opts;
  // Extend the shaft past the plate's back face by CUT_EPSILON so coincident
  // faces don't produce non-manifold geometry. `strict: true` opts out.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const shaftBottomZ = -plateThickness - eps;

  // Build the cone by revolving a 2D profile in the XZ plane. We sketch the
  // axial half-profile (x >= 0) and spin it around Z.
  //
  // Profile (XZ plane, x = radius, y = z in world):
  //   start  (0, 0)
  //   out to (headR, 0)       -- top of countersink at Z=0
  //   down   (shaftD/2, -coneDepth)
  //   down   (shaftD/2, -plateThickness - eps)
  //   in     (0, -plateThickness - eps)
  //   close back to (0, 0)
  const profile = draw([0, 0])
    .hLine(headR)
    .lineTo([shaftD / 2, -coneDepth])
    .lineTo([shaftD / 2, shaftBottomZ])
    .hLine(-shaftD / 2)
    .close();

  const tool = profile
    .sketchOnPlane("XZ")
    .revolve([0, 0, 1], { origin: [0, 0, 0] })
    .asShape3D();
  return applyAxis(tool, axis);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Tapped hole — a cylinder of `SOCKET_HEAD[size].tapDrill` diameter. Threads
 * are implicit (user taps them in metal) or irrelevant (printed threads are
 * unreliable — prefer `inserts.pocket` for FDM).
 *
 * @remarks ANCHOR
 *   Origin: tap opening sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: body extends in the opposite direction (into -Z by default).
 *   Translate target: place the tap opening at the plate's TOP surface.
 *   Example: plate.cut(holes.tapped("M5", { depth: 8 }).translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: the cylinder spans `Z ∈ [-depth, 0]` — top face at
 * Z=0, extends downward into -Z. Translate by `plateTop` so the hole mouth
 * lands flush with the plate's upper surface.
 *
 * @example
 * // Tap into a flange whose +Y face is at Y=5: axis "+Y" opens the tap on
 * // the +Y face, drilling 6 mm into -Y (Y ∈ [-1, 5]).
 * flange.cut(holes.tapped("M3", { depth: 6, axis: "+Y" }).translate(x, 5, z))
 *
 * @param size Metric designator, e.g. `"M3"`.
 * @param opts.depth Tap depth in mm (measured from Z=0 into -Z).
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the tap OPENS ON; the body penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge — useful for precise mating surfaces. Default false.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function tapped(
  size: MetricSize,
  opts: {
    depth: number;
    axis?: HoleAxis;
    // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
    drillDirection?: HoleAxis;
    strict?: boolean;
  }
): Shape3D {
  const axis = resolveHoleAxis("holes.tapped", opts.axis, opts.drillDirection);
  const { depth } = opts;
  assertPositiveFinite("holes.tapped", "opts.depth", depth);
  assertSupportedSize(size, SOCKET_HEAD, "socket-head");
  const diameter = SOCKET_HEAD[size].tapDrill;
  // Extend past both faces by CUT_EPSILON so coincident faces don't produce
  // non-manifold geometry. `strict: true` opts out.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const totalHeight = depth + eps * 2;
  const tool = makeCylinder(diameter / 2, totalHeight, [0, 0, -depth - eps], [0, 0, 1]);
  return applyAxis(tool, axis);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Creates a cut-tool for a threaded hole — a tap-drill-diameter cylinder.
 * The screw self-taps into the printed plastic on first install.
 *
 * WHY NOT modeled threads? For M2–M5 on FDM, helical thread features are
 * below nozzle resolution and slice poorly. A tap-drill hole + self-tap
 * is stronger, smaller, and prints cleanly. For M6+ on FDM or for STEP
 * export to CNC/molding, use `threads.tapInto` directly for modeled helical
 * geometry.
 *
 * Internally delegates to {@link tapped} — this is a vocabulary-matching
 * alias so agents reaching for "threaded holes" discover the self-tap
 * pathway first. For explicit modeled helical threads (M6+ on FDM, or for
 * STEP export), use `threads.tapInto` directly.
 *
 * @example
 * const hole = holes.threaded("M4", { depth: 10 });
 * const plate = base.cut(hole.translate(x, y, topZ));
 *
 * @param size Metric designator, e.g. `"M4"`.
 * @param opts.depth Hole depth in mm.
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the hole OPENS ON; the body penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge. Default false.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function threaded(
  size: MetricSize,
  opts: {
    depth: number;
    axis?: HoleAxis;
    drillDirection?: HoleAxis;
    strict?: boolean;
  }
): Shape3D {
  return tapped(size, opts);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Teardrop hole — a horizontal-axis hole that prints cleanly on FDM with no
 * supports. Cross-section is a circle fused with a triangular tip pointing in
 * the +Z direction, giving a 45° roof that FDM handles without drooping.
 *
 * The hole is extruded along the chosen `axis`. Default axis = `"+Y"` (so the
 * hole runs parallel to Y, usable as a cross-hole through a vertical face in
 * the XZ plane). Pass `axis: "+X"` to run the hole along X instead.
 *
 * Legacy values `"X"` and `"Y"` are accepted for backward compatibility and
 * map to `"+X"` and `"+Y"` respectively.
 *
 * @remarks Z CONVENTION: entry face at the origin. For `axis: "+Y"` the tool
 * extends along -Y (sketch on XZ, extrude +depth picks the XZ-normal
 * direction); for `axis: "+X"` it extends along +X. The "teardrop tip" points
 * in +Z so FDM can print the hole without support. Translate to the face
 * you're cutting through — the entry face sits at the supplied coordinates.
 *
 * @param size Metric designator (applies clearance fit) or raw diameter in mm.
 * @param opts.depth Length of the hole along its axis in mm.
 * @param opts.axis `"+X"` or `"+Y"` (default `"+Y"`). Legacy: `"X"` → `"+X"`, `"Y"` → `"+Y"`.
 * @param opts.raw Pass `{ raw: true }` to treat the numeric diameter as intentional and suppress the "did you mean Mxx?" advisory that fires when a bare integer matches a standard metric size.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge. Default false.
 * @returns Cut-tool Shape3D positioned with its entry face at the origin.
 */
export function teardrop(
  size: MetricSize | number,
  opts: { depth: number; axis?: "+X" | "+Y" | "X" | "Y"; raw?: boolean; strict?: boolean }
): Shape3D {
  const rawAxis = opts.axis ?? "+Y";
  const axis: "+X" | "+Y" = rawAxis === "X" ? "+X" : rawAxis === "Y" ? "+Y" : rawAxis;
  const { depth } = opts;
  assertPositiveFinite("holes.teardrop", "opts.depth", depth);
  let diameter: number;
  if (typeof size === "number") {
    assertPositiveFinite("holes.teardrop", "size", size);
    warnAmbiguousRawDiameter("holes.teardrop", size, undefined, "clearance", opts.raw);
    diameter = size;
  } else {
    assertSupportedSize(size, SOCKET_HEAD, "socket-head");
    const spec = SOCKET_HEAD[size];
    diameter = spec.shaft + FIT.clearance * 2;
  }
  const r = diameter / 2;
  // Extend past both faces by CUT_EPSILON so coincident faces don't produce
  // non-manifold geometry. The cutter naturally spans [0, depth] along the
  // extrude axis; we extend to [-eps, depth+eps] so both ends overshoot.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const totalDepth = depth + eps * 2;

  // Build the teardrop as the 3D fusion of a circle-prism and a triangle-prism.
  // Earlier attempts fused the two in 2D (circle + triangle as Drawings, then
  // sketched + extruded once); that produced a degenerate outline that OCCT
  // extruded to an empty/invalid solid, so the downstream cut silently did
  // nothing. Building them as independent 3D solids and fusing in 3D is
  // robust — OCCT handles coplanar-face union of the circle's upper half and
  // the triangle's base without issue.
  //
  //   axis = "+Y" → sketch on XZ, extrude along +Y. Local X → world X, local Y → world Z.
  //   axis = "+X" → sketch on YZ, extrude along +X. Local X → world Y, local Y → world Z.
  const plane = axis === "+Y" ? "XZ" : "YZ";

  const circleSolid = drawCircle(r)
    .sketchOnPlane(plane)
    .extrude(totalDepth)
    .asShape3D();

  // Triangle: apex at (0, 2r), base corners DELIBERATELY below the circle's
  // equator at (±r, -r). The lower half of this triangle is hidden inside
  // the circle, so the visible silhouette is still a clean teardrop — but
  // the 3D fuse now has a volumetric overlap instead of two shared boundary
  // points. OCCT's boolean robustness drops sharply on shapes that only
  // touch at points, which is why the earlier shared-equator variants
  // produced shapes the downstream cut couldn't process.
  const triangleSolid = draw([r, -r])
    .lineTo([0, 2 * r])
    .lineTo([-r, -r])
    .close()
    .sketchOnPlane(plane)
    .extrude(totalDepth)
    .asShape3D();

  const fused = circleSolid.fuse(triangleSolid);
  // Translate by -eps along the extrude axis so the cutter spans
  // [-eps, depth+eps] — overshooting both the near and far faces.
  if (eps === 0) return fused;
  return axis === "+Y" ? fused.translate(0, -eps, 0) : fused.translate(-eps, 0, 0);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Keyhole — a large circle joined by a narrow slot to a small circle. Used
 * for hang-on-screw mounts where a screw head enters the large opening and
 * slides into the small round.
 *
 * Layout: large circle at (0, 0), small circle at (0, -(largeD/2 + smallD/2 + slot)),
 * connected by a slot of width `smallD`.
 *
 * @remarks ANCHOR
 *   Origin: keyhole mouth (both circles + neck) sits at local Z=0 (or on the
 *           named axis face after rotation). The LARGE circle is centred on
 *           the translate target; the small-circle capture is offset into -Y.
 *   Penetration: pocket extends in the opposite direction (into -Z by default).
 *   Translate target: place the keyhole mouth at the plate's TOP surface,
 *                     centred on the LARGE-circle position.
 *   Example: plate.cut(holes.keyhole({ largeD: 10, smallD: 4, slot: 6, depth: 4 }).translate(x, y, plateTopZ))
 *
 * @remarks Z CONVENTION: the profile is sketched on XY at Z=0 then extruded
 * by `-depth`, so the cut tool spans `Z ∈ [-depth, 0]` — top face at Z=0,
 * extending downward into -Z. Translate by `plateTop` to anchor the mouth
 * to the plate's upper surface. For vertical-flange mounts, pass `axis:
 * "+X"` (or "-X"/"+Y"/"-Y") to cut sideways instead of downward.
 *
 * @example
 * // Keyhole on a vertical wall whose +X face sits at X=thickness: the mouth
 * // opens on +X, pocket penetrates into -X so the screw enters from the wall's
 * // outside.
 * wall.cut(holes.keyhole({ largeD: 10, smallD: 4, slot: 6, depth: 4, axis: "+X" }).translate(thickness, y, z))
 *
 * @param opts.largeD Entry-hole diameter (big enough for the screw head).
 * @param opts.smallD Capture-hole diameter (matches the screw shaft clearance).
 * @param opts.slot Centre-to-centre offset between the two circles in mm.
 * @param opts.depth Hole depth in mm.
 * @param opts.axis Entry-face spec (default "+Z"). Names the face the mouth OPENS ON; the pocket penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.raw Pass `{ raw: true }` to treat the numeric diameters as intentional and suppress any "did you mean Mxx?" advisory (reserved for parity with other raw-diameter factories — keyhole currently consumes `largeD`/`smallD` as literal dimensions, but the flag is accepted so calls stay consistent with `through`/`clearance`).
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge. Default false.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function keyhole(opts: {
  largeD: number;
  smallD: number;
  slot: number;
  depth: number;
  axis?: HoleAxis;
  // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
  drillDirection?: HoleAxis;
  raw?: boolean;
  strict?: boolean;
}): Shape3D {
  const axis = resolveHoleAxis("holes.keyhole", opts.axis, opts.drillDirection);
  const { largeD, smallD, slot, depth } = opts;
  assertPositiveFinite("holes.keyhole", "opts.largeD", largeD);
  assertPositiveFinite("holes.keyhole", "opts.smallD", smallD);
  assertPositiveFinite("holes.keyhole", "opts.slot", slot);
  assertPositiveFinite("holes.keyhole", "opts.depth", depth);
  const largeR = largeD / 2;
  const smallR = smallD / 2;

  const large = drawCircle(largeR);
  const small = drawCircle(smallR).translate(0, -slot);
  // Neck: rectangle wide = smallD, length = slot distance, centred between
  // the two circle centres at y = -slot/2.
  const neck = drawRectangle(smallD, slot).translate(0, -slot / 2);

  const profile = large.fuse(neck).fuse(small);
  // Extend past both Z faces by CUT_EPSILON so coincident faces don't produce
  // non-manifold geometry. Sketch on the XY plane offset by +eps so the near
  // face sits at Z=+eps, then extrude by -(depth + 2*eps) so the far face
  // lands at Z=-depth-eps.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const totalDepth = depth + eps * 2;
  const tool = profile
    .sketchOnPlane("XY", [0, 0, eps])
    .extrude(-totalDepth)
    .asShape3D();
  return applyAxis(tool, axis);
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Slotted hole — elongated hole with rounded ends, used for adjustment. The
 * overall length (tip-to-tip) is `length`; the width (hole diameter / radius
 * of the end-caps × 2) is `width`. The slot runs along the X axis.
 *
 * @remarks ANCHOR
 *   Origin: slot mouth sits at local Z=0 (or on the named axis face after rotation).
 *   Penetration: pocket extends in the opposite direction (into -Z by default).
 *   Translate target: place the slot mouth at the plate's TOP surface.
 *   Example: plate.cut(holes.slot({ length: 20, width: 5, depth: 4 }).translate(x, y, plateTopZ))
 *
 * @remarks AXIS SEMANTICS
 *   Pre-rotation local coords: length runs along X, width along Y, depth into -Z.
 *   After applyAxis(axis), world dimensions become (verified against applyAxis
 *   rotation matrices in this file; "depth→±A" names the direction the pocket
 *   body extends, "cutter A∈[…]" gives the extent along that axis):
 *     axis="+Z":  length→X, width→Y, depth→-Z   (default; cutter z∈[-depth,0])
 *     axis="-Z":  length→X, width→Y, depth→+Z   (cutter z∈[0,depth])
 *     axis="+X":  length→Z, width→Y, depth→-X   (cutter x∈[-depth,0])
 *     axis="-X":  length→Z, width→Y, depth→+X   (cutter x∈[0,depth])
 *     axis="+Y":  length→X, width→Z, depth→-Y   (cutter y∈[-depth,0])
 *     axis="-Y":  length→X, width→Z, depth→+Y   (cutter y∈[0,depth])
 *   Note: the "length→" / "width→" entries name the WORLD AXIS the dimension
 *   aligns with after rotation; direction along that axis may be flipped but
 *   the extent is symmetric, so it doesn't affect where the slot lands.
 *
 * @remarks Z CONVENTION: the profile is sketched on XY at Z=0 then extruded
 * by `-depth`, so the cut tool spans `Z ∈ [-depth, 0]` — top face at Z=0,
 * extending downward into -Z. Translate by `plateTop` so the slot mouth
 * lands flush with the plate's upper surface; forgetting the translate
 * leaves the cutter below the plate and the cut removes nothing.
 *
 * @example
 * // Adjustment slot on a vertical Y-flange (opens on the +Y face at Y=t,
 * // pocket penetrates into -Y).
 * flange.cut(holes.slot({ length: 20, width: 5, depth: 4, axis: "+Y" }).translate(x, thickness, z))
 *
 * @param opts.length Overall length (tip to tip) in mm — must be >= `width`.
 * @param opts.width Slot width in mm (diameter of the rounded ends).
 * @param opts.depth Hole depth in mm.
 * @param opts.axis Entry-face spec (default `"+Z"`). Names the face the slot OPENS ON; the pocket penetrates in the OPPOSITE direction. See `HoleAxis` docstring for full semantics and the AXIS SEMANTICS table above for per-axis world-dimension mapping.
 * @param opts.drillDirection Inverse alias of `axis`: names the direction the drill bit points. `drillDirection: "+X"` is equivalent to `axis: "-X"`.
 * @param opts.strict When true, skip the `CUT_EPSILON` extend-past-both-faces nudge. Default false.
 * @returns Cut-tool Shape3D, top at Z=0.
 */
export function slot(opts: {
  length: number;
  width: number;
  depth: number;
  axis?: HoleAxis;
  // for users who prefer drill-direction semantics (Fusion/SolidWorks convention)
  drillDirection?: HoleAxis;
  strict?: boolean;
}): Shape3D {
  const axis = resolveHoleAxis("holes.slot", opts.axis, opts.drillDirection);
  const { length, width, depth } = opts;
  assertPositiveFinite("holes.slot", "opts.length", length);
  assertPositiveFinite("holes.slot", "opts.width", width);
  assertPositiveFinite("holes.slot", "opts.depth", depth);
  if (length < width) {
    const travelExample = Math.max(3, Math.round(width));
    throw new Error(
      `holes.slot: length (${length}) must be >= width (${width}). ` +
        `\`length\` is the TIP-TO-TIP overall length (including the rounded ends), ` +
        `not the extra travel beyond the round ends. ` +
        `For an M${Math.round(width - 0.4)}-ish bolt with ${travelExample}mm of travel, ` +
        `use length=${width + travelExample}, width=${width} ` +
        `(length = bolt_clearance_diameter + desired_travel).`
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
  // Extend past both Z faces by CUT_EPSILON so coincident faces don't produce
  // non-manifold geometry. Sketch on the XY plane offset by +eps so the near
  // face sits at Z=+eps, then extrude by -(depth + 2*eps) so the far face
  // lands at Z=-depth-eps.
  const eps = opts.strict ? 0 : CUT_EPSILON;
  const totalDepth = depth + eps * 2;
  const tool = profile
    .sketchOnPlane("XY", [0, 0, eps])
    .extrude(-totalDepth)
    .asShape3D();
  return applyAxis(tool, axis);
}

// ---------------------------------------------------------------------------
// Convenience wrappers — `*At(plate, size, { at: [x,y,z], ... })`
//
// The plain factories (`through`, `tapped`, `counterbore`) return a cut tool
// that the caller must translate AND then pass to `plate.cut(...)`. That's
// three chained calls for the common "hole at this coord on the top of this
// plate" idiom. The `*At` wrappers fold the translate + cut into one line:
//
//   const drilled = holes.throughAt(plate, "M5", { at: [x, y, plateTopZ] });
//
// They also validate that `at[2]` sits at (or very near) the plate's top-Z
// bounding-box face, warning the user when it doesn't — the #1 silent failure
// for this idiom is translating the cutter BELOW the plate, which removes no
// material and leaves the user puzzling over an unchanged model. Tolerance is
// plate-thickness / 100: any Z within 1% of the plate's Z extent is treated
// as "near the top" (covers floating-point drift from arithmetic on thickness
// values without admitting obvious bottom-face translates).
//
// Cloning note: `translate` consumes its input handle (Replicad's behaviour),
// but the cutter here is freshly built by the inner factory on every call, so
// the wrapper owns it exclusively — no clone needed. `plate.cut(cutter)`
// returns a new Shape3D without mutating `plate`, mirroring the plain-factory
// usage pattern already established by `patterns.cutTop`.
// ---------------------------------------------------------------------------

/**
 * Read the plate's top-Z bounding-box face plus its Z extent (thickness).
 * Returns undefined when the bbox isn't readable (caller falls back to
 * silently skipping the placement check). Mirrors `patterns.readBounds` —
 * re-implementing here avoids a cross-file import, and the logic is trivial
 * enough that duplication is cheaper than the coupling.
 */
function readPlateTopZ(plate: Shape3D): { topZ: number; thickness: number } | undefined {
  try {
    const bb = (plate as any).boundingBox;
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
    const zMin = bounds[0][2];
    const zMax = bounds[1][2];
    if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) return undefined;
    return { topZ: zMax, thickness: Math.max(zMax - zMin, 0) };
  } catch {
    return undefined;
  }
}

/** Warn when `at[2]` is not near the plate's top Z face. Silent when bbox is unreadable. */
function checkAtOnPlateTop(
  fnName: string,
  plate: Shape3D,
  at: [number, number, number],
): void {
  const bbox = readPlateTopZ(plate);
  if (!bbox) return;
  const { topZ, thickness } = bbox;
  // Use an absolute floor for very thin plates (thickness/100 would go to 0
  // for zero-thickness bbox reads); 1e-6 mm is well below any meaningful
  // engineering tolerance.
  const tol = Math.max(thickness / 100, 1e-6);
  if (Math.abs(at[2] - topZ) > tol) {
    pushRuntimeWarning(
      `${fnName}: 'at' Z=${at[2]} is not near plate top (top≈${topZ}, tol=${tol}). Verify coordinates.`,
    );
  }
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Convenience wrapper: builds a through-hole cutter and cuts it out of `plate`
 * at the given `at` coordinate in one call.
 *
 * Equivalent to:
 *   plate.cut(holes.through(size, opts).translate(at[0], at[1], at[2]))
 *
 * Emits a runtime warning (not an error) when `at[2]` is not near the plate's
 * top-Z bbox face — a common silent-failure source where the cutter lands
 * below the plate and removes no material.
 *
 * @param plate Target Shape3D (must expose a readable boundingBox for the
 *   top-Z validation; an unreadable bbox skips the check silently).
 * @param size Metric designator (`"M3"`) or explicit diameter in mm.
 * @param opts Same options as `holes.through` plus required `at: [x, y, z]`.
 * @returns New Shape3D with the through-hole cut from `plate`.
 */
export function throughAt(
  plate: Shape3D,
  size: MetricSize | number,
  opts: {
    depth?: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    drillDirection?: HoleAxis;
    strict?: boolean;
    at: [number, number, number];
  },
): Shape3D {
  const { at, ...throughOpts } = opts;
  checkAtOnPlateTop("holes.throughAt", plate, at);
  const cutter = through(size, throughOpts);
  return plate.cut(cutter.translate(at[0], at[1], at[2]));
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Convenience wrapper: builds a tapped-hole cutter and cuts it out of `plate`
 * at the given `at` coordinate in one call.
 *
 * Equivalent to:
 *   plate.cut(holes.tapped(size, opts).translate(at[0], at[1], at[2]))
 *
 * Emits a runtime warning (not an error) when `at[2]` is not near the plate's
 * top-Z bbox face.
 *
 * @param plate Target Shape3D (must expose a readable boundingBox).
 * @param size Metric designator (`"M3"`).
 * @param opts Same options as `holes.tapped` plus required `at: [x, y, z]`.
 * @returns New Shape3D with the tapped hole cut from `plate`.
 */
export function tappedAt(
  plate: Shape3D,
  size: MetricSize,
  opts: {
    depth: number;
    axis?: HoleAxis;
    drillDirection?: HoleAxis;
    strict?: boolean;
    at: [number, number, number];
  },
): Shape3D {
  const { at, ...tappedOpts } = opts;
  checkAtOnPlateTop("holes.tappedAt", plate, at);
  const cutter = tapped(size, tappedOpts);
  return plate.cut(cutter.translate(at[0], at[1], at[2]));
}

/**
 * Axis convention: `axis` names the FACE the hole opens on; the body extends in the OPPOSITE direction (e.g. `axis: "+X"` → opens on +X face, body extends into -X).
 *
 * Convenience wrapper: builds a counterbore cutter and cuts it out of `plate`
 * at the given `at` coordinate in one call.
 *
 * Equivalent to:
 *   plate.cut(holes.counterbore(size, opts).translate(at[0], at[1], at[2]))
 *
 * Emits a runtime warning (not an error) when `at[2]` is not near the plate's
 * top-Z bbox face.
 *
 * @param plate Target Shape3D (must expose a readable boundingBox).
 * @param size Metric screw designator, e.g. `"M3"`.
 * @param opts Same options as `holes.counterbore` plus required `at: [x, y, z]`.
 * @returns New Shape3D with the counterbored hole cut from `plate`.
 */
export function counterboreAt(
  plate: Shape3D,
  size: string,
  opts: {
    plateThickness: number;
    fit?: FitStyle;
    axis?: HoleAxis;
    drillDirection?: HoleAxis;
    strict?: boolean;
    at: [number, number, number];
  },
): Shape3D {
  const { at, ...counterboreOpts } = opts;
  checkAtOnPlateTop("holes.counterboreAt", plate, at);
  const cutter = counterbore(size, counterboreOpts);
  return plate.cut(cutter.translate(at[0], at[1], at[2]));
}
