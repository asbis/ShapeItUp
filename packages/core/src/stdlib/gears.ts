/**
 * Gear library — parametric spur gears with involute tooth profiles.
 *
 * v1 scope: spur gears only. Rack and internal ring gears are deferred. No
 * root fillets — OCCT's `.fillet()` on the tiny inside corners between
 * adjacent teeth is unreliable, and users who need filleted roots can
 * post-process the returned shape themselves.
 *
 * All dimensions are in millimetres. Gears are built axis-aligned with +Z,
 * centred on the origin, bottom face at Z=0 and top face at Z=faceWidth.
 *
 * Involute geometry (standard, no external library):
 *   Rp = (module * teeth) / 2          pitch radius
 *   Rb = Rp * cos(pressureAngle)       base radius
 *   Ra = Rp + module                    addendum (tip) radius
 *   Rf = Rp - 1.25 * module             dedendum (root) radius
 *
 * The involute curve traced from the base circle is:
 *   x(t) = Rb * (cos(t) + t * sin(t))
 *   y(t) = Rb * (sin(t) - t * cos(t))
 * parameterised by the roll angle `t`. A point at parameter `t` sits at
 * radius `Rb * sqrt(1 + t²)` and POLAR ANGLE `t - atan(t)` (counterclockwise
 * from +X). In particular, t=0 lands on the +X axis and larger t sweeps
 * counterclockwise into the +Y half-plane.
 *
 * Tooth construction: we build a single tooth centred on the +X axis, then
 * clone-rotate it `teeth` times around Z. The right flank (positive-Y side)
 * is the raw involute curve rotated so the pitch-circle intersection sits at
 * polar angle `+halfToothAngleAtPitch`. The left flank is the right flank
 * mirrored across the X axis. The two flanks are joined by a straight line
 * at the tip (Ra) and the root arc is approximated by short straight lines
 * between adjacent teeth (good enough at 12+ flank samples; users who need
 * true root arcs can post-process).
 */

import { draw, drawCircle, type Shape3D } from "replicad";
import { assertPositiveFinite } from "./standards";
import { pushRuntimeWarning } from "./warnings";

/**
 * Number of points sampled along each involute flank (base → tip). 14 gives
 * visually smooth flanks at typical tooth counts (18–60 teeth, module 1–5);
 * higher counts cost profile-vertex count with no visible gain.
 */
const FLANK_SAMPLES = 14;

export interface SpurInvoluteOpts {
  /** Module (mm per tooth) — the standard ISO size parameter. */
  module: number;
  /** Number of teeth. Must be >= 6 (fewer teeth undercut severely). */
  teeth: number;
  /** Axial thickness of the gear (Z-extent) in mm. */
  faceWidth: number;
  /** Pressure angle in DEGREES. Defaults to 20°. */
  pressureAngle?: number;
  /** Shaft-bore diameter in mm. 0 or omitted means solid (no bore). */
  bore?: number;
  /** Optional raised hub diameter (mm). Requires `hubThickness`. */
  hubDiameter?: number;
  /** Optional raised hub thickness (mm). Requires `hubDiameter`. */
  hubThickness?: number;
  /** Backlash (mm, per flank). Subtracted from each flank of each tooth. */
  backlash?: number;
}

/**
 * Build an external spur gear with involute teeth.
 *
 * The gear is axis-aligned with +Z, centred on the origin, bottom face at
 * Z=0. Pass the returned shape to `.translate()` / `.rotate()` to position.
 *
 *   import { gears } from "shapeitup";
 *   export default function main() {
 *     return gears.spurInvolute({ module: 2, teeth: 18, faceWidth: 8, bore: 6 });
 *   }
 *
 * @returns a Shape3D (B-Rep solid).
 */
export function spurInvolute(opts: SpurInvoluteOpts): Shape3D {
  // --- Validation --------------------------------------------------------
  const fn = "gears.spurInvolute";
  assertPositiveFinite(fn, "module", opts.module);
  assertPositiveFinite(fn, "faceWidth", opts.faceWidth);
  if (!Number.isInteger(opts.teeth) || opts.teeth < 6) {
    throw new Error(
      `${fn}: teeth must be an integer >= 6 (got ${opts.teeth}). ` +
        `Gears with fewer than 6 teeth have severe undercut and are not supported.`
    );
  }

  const pressureAngleDeg = opts.pressureAngle ?? 20;
  if (
    typeof pressureAngleDeg !== "number" ||
    !Number.isFinite(pressureAngleDeg) ||
    pressureAngleDeg <= 0 ||
    pressureAngleDeg >= 45
  ) {
    throw new Error(
      `${fn}: pressureAngle must be between 0 and 45 degrees (got ${pressureAngleDeg}).`
    );
  }

  const backlash = opts.backlash ?? 0;
  if (
    typeof backlash !== "number" ||
    !Number.isFinite(backlash) ||
    backlash < 0
  ) {
    throw new Error(
      `${fn}: backlash must be a finite non-negative number (got ${backlash}).`
    );
  }

  // --- Geometry ---------------------------------------------------------
  const m = opts.module;
  const N = opts.teeth;
  const PA = (pressureAngleDeg * Math.PI) / 180;

  const Rp = (m * N) / 2; // pitch radius
  const Rb = Rp * Math.cos(PA); // base radius
  const Ra = Rp + m; // addendum (tip) radius
  const Rf = Math.max(0.001, Rp - 1.25 * m); // dedendum (root) radius

  // Sanity: if Rf somehow lands at or below 0 (absurd teeth count), bail.
  if (Rf <= 0) {
    throw new Error(
      `${fn}: degenerate geometry — dedendum radius ${Rf} <= 0. Increase teeth or module.`
    );
  }

  // Bore / hub sanity — warnings only, not errors.
  const bore = opts.bore ?? 0;
  if (bore > 0 && bore / 2 >= Rf) {
    pushRuntimeWarning(
      `${fn}: bore diameter ${bore}mm meets or exceeds the root radius (${(2 * Rf).toFixed(2)}mm) — tooth roots will be cut away.`
    );
  }

  const hubDiameter = opts.hubDiameter;
  const hubThickness = opts.hubThickness;
  const hasHub = hubDiameter !== undefined && hubThickness !== undefined;
  if ((hubDiameter !== undefined) !== (hubThickness !== undefined)) {
    throw new Error(
      `${fn}: hubDiameter and hubThickness must both be provided together (got ${hubDiameter}, ${hubThickness}).`
    );
  }
  if (hasHub) {
    assertPositiveFinite(fn, "hubDiameter", hubDiameter);
    assertPositiveFinite(fn, "hubThickness", hubThickness);
    if (hubDiameter! >= 2 * Rf) {
      pushRuntimeWarning(
        `${fn}: hubDiameter ${hubDiameter}mm reaches or passes the root circle (${(2 * Rf).toFixed(2)}mm) — hub will merge with tooth flanks.`
      );
    }
    if (bore > 0 && hubDiameter! <= bore) {
      pushRuntimeWarning(
        `${fn}: hubDiameter ${hubDiameter}mm is <= bore ${bore}mm — hub will be consumed by the bore cut.`
      );
    }
  }

  // --- Involute sampling -------------------------------------------------
  // tMax: where the involute reaches the addendum (tip) radius.
  // r(t) = Rb * sqrt(1 + t^2)  ⇒  tMax = sqrt((Ra/Rb)^2 - 1).
  // (Requires Ra > Rb; always true for standard pressure angles & teeth counts
  // that pass the teeth>=6 check above.)
  const tMax = Math.sqrt((Ra / Rb) ** 2 - 1);

  // Pressure-angle involute function: inv(PA) = tan(PA) - PA. This is the
  // polar angle (from tooth centreline) at which a raw involute — starting
  // tangent at t=0 on the +X axis — crosses the pitch circle.
  const invPA = Math.tan(PA) - PA;

  // Tooth thickness at the pitch circle, expressed as a half-angle (radians)
  // from the tooth centreline. Standard spur gear: full tooth thickness at
  // pitch is π*m/2 (equal to the gap), giving half-angle = π/(2N). Backlash
  // reduces tooth thickness by `backlash` per flank → angular reduction
  // `backlash / Rp` per flank.
  const halfToothAngleAtPitch = Math.PI / (2 * N) - backlash / Rp;
  if (halfToothAngleAtPitch <= 0) {
    throw new Error(
      `${fn}: backlash ${backlash}mm is too large for module ${m}/teeth ${N} — tooth thickness at pitch would be <= 0.`
    );
  }

  // Rotation applied to the raw involute to put the pitch-point on the
  // right flank at polar angle +halfToothAngleAtPitch. The raw involute's
  // pitch-point sits at polar angle `invPA`, so rotate by (halfToothAngle -
  // invPA).
  const flankRot = halfToothAngleAtPitch - invPA;

  // Starting parameter for the involute: if Rf >= Rb, we need to start the
  // flank where it crosses the dedendum (a portion of the base involute is
  // outside the root circle). If Rf < Rb (common for PA=20°), the involute
  // is only defined from Rb outward; we start at t=0 and bridge from Rb
  // down to Rf along a radial line.
  const tStart =
    Rf > Rb ? Math.sqrt((Rf / Rb) ** 2 - 1) : 0;

  // Build the right flank sampled base/root → tip as an array of [x,y].
  // Counterclockwise-sweeping curve in +Y half-plane after `flankRot`.
  const cosRot = Math.cos(flankRot);
  const sinRot = Math.sin(flankRot);
  const rightFlank: Array<[number, number]> = [];
  for (let i = 0; i <= FLANK_SAMPLES; i++) {
    const t = tStart + (i / FLANK_SAMPLES) * (tMax - tStart);
    const rx = Rb * (Math.cos(t) + t * Math.sin(t));
    const ry = Rb * (Math.sin(t) - t * Math.cos(t));
    // Apply flankRot (2D rotation around origin).
    const x = rx * cosRot - ry * sinRot;
    const y = rx * sinRot + ry * cosRot;
    rightFlank.push([x, y]);
  }

  // Left flank = right flank mirrored across X axis, reversed so it goes
  // tip → base (to trace the tooth outline counterclockwise).
  const leftFlankTipToBase: Array<[number, number]> = rightFlank
    .map(([x, y]) => [x, -y] as [number, number])
    .reverse();

  // Starting root point on the -Y side for tooth 0 (centreline = +X axis).
  // Sits at polar angle -(halfToothAngleAtPitch + invPA ... ) — simpler: use
  // the starting point of the left flank (which is on the -Y flank at
  // radius Rf-or-Rb) and angularly-mirror it to put the previous tooth's
  // gap midpoint on -X... actually we build the whole gear profile as one
  // closed polyline by walking tooth-by-tooth:
  //
  //   start:        left-flank-base of tooth 0 (radius Rf/Rb, -Y side)
  //   for each tooth k:
  //     up left flank tip → across tip → down right flank to base
  //     arc-ish (straight line at this sample density) from base of right
  //     flank to base of next tooth's left flank.
  //
  // The "arc" across the root gap is drawn as a polyline through `ROOT_ARC_SAMPLES`
  // intermediate points on the root circle so the gap looks circular rather
  // than a straight chord (noticeable for low teeth counts).

  // Angular position of the left-flank BASE point (polar angle, radians).
  // That's the polar angle of leftFlankTipToBase[last] (the base point).
  const baseLeft = leftFlankTipToBase[leftFlankTipToBase.length - 1];
  const baseLeftAngle = Math.atan2(baseLeft[1], baseLeft[0]);
  // By symmetry, the right-flank base is at angle +|baseLeftAngle|.
  const baseRightAngle = -baseLeftAngle;

  // Root gap spans from baseRight (end of current tooth) to the next tooth's
  // baseLeft rotated by toothStep. Sample the arc between them.
  const toothStep = (2 * Math.PI) / N;
  const ROOT_ARC_SAMPLES = 4; // intermediate points on root arc; tip straight-line segs come from flank samples

  // Build the full 2D profile counterclockwise. Per-tooth ordering:
  //   1. Root arc from previous tooth's right-flank base (above its centreline)
  //      to this tooth's left-flank base (below its centreline) — polar
  //      angle INCREASES.
  //   2. Left-flank base → tip (the mirrored, -Y flank in unrotated coords).
  //   3. Right-flank tip → base (the raw, +Y flank in unrotated coords).
  // At the tip the two flanks are joined by a straight chord (one segment,
  // negligible at 14+ flank samples).
  const profilePoints: Array<[number, number]> = [];
  for (let k = 0; k < N; k++) {
    const theta = k * toothStep;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const rotK = (p: [number, number]): [number, number] => [
      p[0] * c - p[1] * s,
      p[0] * s + p[1] * c,
    ];

    // Root arc leading INTO this tooth (from the previous tooth's right-flank
    // base, which sits at polar (theta - toothStep + baseRightAngle), sweeping
    // counterclockwise up to this tooth's left-flank base at (theta +
    // baseLeftAngle)). For k=0 we still emit the arc — it forms the first
    // points of the polyline; the final `.close()` on the pen will connect
    // back to the start automatically.
    const prevBaseAngle = theta - toothStep + baseRightAngle; // right flank of tooth k-1
    const currLeftBaseAngle = theta + baseLeftAngle; // left flank of tooth k
    // Rf is the same radius for both endpoints (root circle is concentric),
    // so the arc is simply a sweep of the angle between them at radius Rf.
    for (let i = 0; i <= ROOT_ARC_SAMPLES; i++) {
      const u = i / ROOT_ARC_SAMPLES;
      const a = prevBaseAngle + u * (currLeftBaseAngle - prevBaseAngle);
      // Skip the last point of the arc on all but the first tooth — it
      // coincides with the left-flank base point we're about to push.
      if (i === ROOT_ARC_SAMPLES) continue;
      profilePoints.push([Rf * Math.cos(a), Rf * Math.sin(a)]);
    }
    // Left flank base → tip (reverse of leftFlankTipToBase, i.e. rightFlank
    // mirrored across X).
    const leftBaseToTip = leftFlankTipToBase.slice().reverse();
    for (const p of leftBaseToTip) profilePoints.push(rotK(p));
    // Right flank tip → base (reverse of rightFlank).
    const rightTipToBase = rightFlank.slice().reverse();
    for (const p of rightTipToBase) profilePoints.push(rotK(p));
  }

  // --- Build the 2D profile and extrude ---------------------------------
  const start = profilePoints[0];
  const pen = draw(start);
  for (let i = 1; i < profilePoints.length; i++) {
    pen.lineTo(profilePoints[i]);
  }
  const profile = pen.close();

  let gear: Shape3D = profile
    .sketchOnPlane("XY")
    .extrude(opts.faceWidth) as unknown as Shape3D;

  // --- Optional bore ----------------------------------------------------
  if (bore > 0) {
    assertPositiveFinite(fn, "bore", bore);
    const boreCut = drawCircle(bore / 2)
      .sketchOnPlane("XY", [0, 0, -0.05])
      .extrude(opts.faceWidth + 0.1) as unknown as Shape3D;
    gear = gear.cut(boreCut);
  }

  // --- Optional hub -----------------------------------------------------
  if (hasHub) {
    const hub = drawCircle(hubDiameter! / 2)
      .sketchOnPlane("XY", [0, 0, opts.faceWidth])
      .extrude(hubThickness!) as unknown as Shape3D;
    // Cut the bore through the hub too so the shaft passes cleanly.
    if (bore > 0) {
      const hubBoreCut = drawCircle(bore / 2)
        .sketchOnPlane("XY", [0, 0, opts.faceWidth - 0.05])
        .extrude(hubThickness! + 0.1) as unknown as Shape3D;
      const boredHub = hub.cut(hubBoreCut);
      gear = gear.fuse(boredHub);
    } else {
      gear = gear.fuse(hub);
    }
  }

  return gear;
}
