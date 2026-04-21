/**
 * Motor builders — pre-assembled NEMA stepper parts with joints ready to mate.
 *
 * Layout convention — motor body at local Z = [0, HEIGHT], shaft on TOP
 * extending Z = [HEIGHT, HEIGHT + SHAFT_LENGTH]. Mount face is at the
 * BOTTOM of the body.
 *
 *     shaftTip  ─── (0, 0, HEIGHT + SHAFT_LENGTH)   axis "+Z"
 *                ╷
 *                │  shaft (Ø spec.shaft)
 *                ╵
 *     (motor top face, Z = HEIGHT)
 *       ╔═══════════╗
 *       ║  body     ║
 *       ║  42×42    ║
 *       ╚═══════════╝
 *     mountFace ─── (0, 0, 0)   axis "-Z"
 *
 * This convention matches the common 3D-printer arrangement where a motor
 * sits ATOP a plate (cap / bracket) with its shaft extending upward. The
 * mount face's axis points -Z because the mating partner (the plate) sits
 * BELOW the motor — axes become anti-parallel in the mate, no rotation.
 *
 * For the inverse arrangement (motor hanging below a plate, shaft through
 * a pilot hole and extending above), rotate the motor 180° before mating:
 *
 *     const hangingMotor = motors.nema17().rotate(180, "+X");
 *
 * Raw dimensions live in `standards.ts` (NEMA17 / NEMA23 / NEMA14) if you
 * need the bolt pitch for your own pattern, etc.
 */

import { drawRectangle } from "replicad";
import { Part, type Axis, normalizeAxis } from "./parts";
import { shape3d } from "./placement";
import { cylinder } from "./cylinder";
import {
  NEMA17,
  NEMA23,
  NEMA14,
  SOCKET_HEAD,
  FIT,
  type NemaMotorSpec,
  type Point3,
} from "./standards";
import type { Placement } from "./patterns";
import type { Shape3D } from "replicad";

export interface NemaBuilderOpts {
  /** Override the spec's default exposed shaft length (mm). */
  shaftLength?: number;
  /** Override the default part name. */
  name?: string;
  /** Override the default color (a dark anodized gray). */
  color?: string;
  /**
   * Direction the motor shaft points. Default `"+Z"` (matches the historical
   * hard-coded behaviour — body at z∈[0, H], shaft on top pointing +Z). Pass
   * one of the 6 signed axes to rotate the entire motor so the shaft exits
   * along the chosen axis. The rotation is applied at the world origin via
   * `Part.rotate`, so both the `shaftTip` and `mountFace` joints are carried
   * along automatically — no manual joint touch-ups required.
   *
   *   motors.nema17({ direction: "+X" })      // shaft points +X
   *   motors.nema17({ direction: "-Y" })      // shaft points -Y
   */
  direction?: Axis;
}

function buildNema(spec: NemaMotorSpec, defaultName: string, opts: NemaBuilderOpts = {}): Part {
  const shaftLength = opts.shaftLength ?? spec.shaftLength;
  const body = shape3d(
    drawRectangle(spec.body, spec.body).sketchOnPlane("XY").extrude(spec.height)
  );
  const shaft = cylinder({
    bottom: [0, 0, spec.height],
    length: shaftLength,
    diameter: spec.shaft,
  });
  const motor = new Part(body.fuse(shaft), {
    name: opts.name ?? defaultName,
    color: opts.color ?? "#2b2b2b",
  })
    .addJoint("mountFace", [0, 0, 0], { axis: "-Z", role: "face" })
    .addJoint("shaftTip", [0, 0, spec.height + shaftLength], {
      axis: "+Z",
      role: "male",
      diameter: spec.shaft,
    });

  // `direction` rotates the whole motor (body + shaft + joints) so the shaft
  // points the requested axis instead of the hard-coded +Z. Using Part.rotate
  // (not Shape3D.rotate) keeps joint positions and axes in sync via the Part
  // transform propagation — see parts.ts line 305 + the `joints` getter.
  //
  // Rotation table mirrors holes.applyAxis exactly: same input frame
  // (something-points-along-+Z) → same target axis. Part.rotate takes a
  // rotation axis (not a final-direction axis), so we pick the axis/angle
  // pair that rotates the +Z-pointing shaft to the requested direction.
  const direction = opts.direction ?? "+Z";
  return applyDirection(motor, direction);
}

/**
 * Rotate a Part whose shaft initially points +Z so the shaft ends up pointing
 * `direction`. Identity for "+Z". All six string axes map to a single
 * Part.rotate call about the world origin — the same table `holes.applyAxis`
 * uses for rotating cut tools, adapted to Part's (angle, axis) signature.
 */
function applyDirection(p: Part, direction: Axis): Part {
  switch (direction) {
    case "+Z":
      return p;
    case "-Z":
      // 180° about +X flips +Z → -Z (the motor hangs upside-down).
      return p.rotate(180, "+X");
    case "+X":
      // +90° about +Y sweeps +Z into +X.
      return p.rotate(90, "+Y");
    case "-X":
      return p.rotate(-90, "+Y");
    case "+Y":
      // -90° about +X sweeps +Z into +Y.
      return p.rotate(-90, "+X");
    case "-Y":
      return p.rotate(90, "+X");
    default:
      // Arbitrary Vec3 directions aren't supported — NEMA motors live on
      // principal axes by convention and a runtime typo here should be
      // loud, not silent. Fall back to the caller's input so Part.rotate
      // surfaces the exact complaint if direction is malformed.
      return p.rotate(0, direction);
  }
}

/**
 * Plane on which to emit a NEMA bolt-pattern. Default `"XY"` — the four
 * bolt centres live on the plane's two axes at `±spec.boltPitch / 2` each.
 * Pass `"YZ"` or `"XZ"` to emit them on the corresponding principal plane.
 */
type NemaBoltPatternPlane = "XY" | "YZ" | "XZ";

/**
 * Emit the four bolt-circle centres of a NEMA motor as a `Placement[]`. The
 * pattern lives on the chosen principal plane centred at the origin, with
 * the four points at `(±p/2, ±p/2)` (where `p = spec.boltPitch`). Useful for
 * stamping mount holes onto a plate that is not itself on the XY plane —
 * e.g. the side wall of an enclosure — without reaching for the full
 * `_mountPlate` cutter.
 *
 *   plate.cut(
 *     patterns.spread(
 *       () => holes.through("M3"),
 *       motors.nema17.boltPattern(),          // XY plane by default
 *     ),
 *   );
 *
 *   // Same pattern on a vertical YZ wall:
 *   motors.nema17.boltPattern("YZ");
 */
function nemaBoltPattern(spec: NemaMotorSpec, plane: NemaBoltPatternPlane = "XY"): Placement[] {
  const half = spec.boltPitch / 2;
  // Build the pattern on the XY plane first so we can delegate the plane
  // remap to the exact same mapping table `patterns.onPlane` uses — any
  // future change there (e.g. handedness of YZ) flows through automatically.
  const base: Placement[] = [
    { translate: [+half, +half, 0] },
    { translate: [+half, -half, 0] },
    { translate: [-half, +half, 0] },
    { translate: [-half, -half, 0] },
  ];
  if (plane === "XY") return base;
  // Inline the `patterns.onPlane` remap table rather than importing it to
  // keep this module free of a runtime dependency on the patterns module
  // (which would be a circular-import hazard once both modules re-export
  // shared types through ./index.ts).
  const remap = (pt: Point3): Point3 =>
    plane === "YZ" ? [0, pt[0], pt[1]] : [pt[0], 0, pt[1]];
  return base.map((p) => ({ translate: remap(p.translate) }));
}

/**
 * Callable-with-attached-method handle for a NEMA motor. Calling it returns
 * the full `Part` (body + shaft + joints); `.boltPattern` emits the four
 * bolt centres as a `Placement[]` for callers who only want the hole
 * pattern. Defined as an interface + assembled at export time so
 * `motors.nema17(opts)` / `motors.nema17.boltPattern()` coexist with full
 * type safety and zero runtime overhead on the "build the part" path.
 */
export interface NemaMotor {
  (opts?: NemaBuilderOpts): Part;
  /**
   * Four bolt-circle centres as placements on the requested plane. Default
   * plane is `"XY"`. The pattern is centred on the origin — translate the
   * result to offset it onto a specific location on your plate.
   */
  boltPattern: (plane?: NemaBoltPatternPlane) => Placement[];
}

function makeNema(spec: NemaMotorSpec, defaultName: string): NemaMotor {
  // `(opts) => buildNema(...)` is a plain arrow function, which lets us
  // attach `.boltPattern` as an ordinary own-property. Two upsides over
  // `Object.assign`: the attached property keeps its JSDoc in tooltips, and
  // the function's `.name` survives for stack traces.
  const fn = ((opts: NemaBuilderOpts = {}) =>
    buildNema(spec, defaultName, opts)) as NemaMotor;
  fn.boltPattern = (plane: NemaBoltPatternPlane = "XY") => nemaBoltPattern(spec, plane);
  return fn;
}

/** NEMA 17 stepper — 42×42 body, 31mm bolt pattern, Ø5 shaft. Most common size for 3D printers. */
export const nema17: NemaMotor = makeNema(NEMA17, "nema17-motor");

/** NEMA 23 stepper — 56.4×56.4 body, 47.14mm bolt pattern, Ø6.35 shaft. CNC / heavier linear stages. */
export const nema23: NemaMotor = makeNema(NEMA23, "nema23-motor");

/** NEMA 14 stepper — 35×35 body, 26mm bolt pattern, Ø5 shaft. Small extruder drives etc. */
export const nema14: NemaMotor = makeNema(NEMA14, "nema14-motor");

// ── Mount-plate cut tools ──────────────────────────────────────────────────
//
// These return cut-tool Shape3Ds (NOT Parts) for stamping a motor mounting
// pattern through a plate: 4 bolt-pattern clearance holes, a central shaft
// through-bore, and an optional shallow boss recess so the motor's pilot ring
// self-centers in the plate.
//
// Convention (matches holes.*): default axis "+Z" means the tool opens on the
// plate's +Z face and the body extends into -Z. To cut straight down through
// a plate whose top sits at Z=0 with a centered motor, call
// `plate.cut(motors.nema17_mountPlate({ thickness: plateT }))` — no translate
// needed for that common case. Pass `{ center }` to offset the pattern to a
// specific location on the plate.

/** Options shared by every NEMA `_mountPlate` cut tool. */
export interface NemaMountPlateOpts {
  /** Plate thickness in mm — the bolt-clearance holes cut through this much stock. */
  thickness: number;
  /** Direction the cut enters from. Same union as `holes.*` / `cylinder.direction`. Default `"+Z"`. */
  axis?: Axis;
  /** Optional `[x, y, z]` offset applied AFTER axis routing. Default `[0, 0, 0]`. */
  center?: Point3;
  /**
   * When true, cut a shallow circular recess around the shaft bore matching
   * the motor's pilot-boss OD so the motor self-centers. Depth defaults to
   * 2 mm; override via `bossDepth`. Default `false`.
   */
  boss?: boolean;
  /** Override boss recess depth (mm). Only used when `boss: true`. Default 2 mm. */
  bossDepth?: number;
  /** Override bolt fit allowance. Defaults to `"clearance"` (ISO 273 normal fit). */
  fit?: "clearance" | "slip" | "loose";
}

/**
 * Build a NEMA mount-plate cut tool from a spec. Produces a fused Shape3D:
 *   - 4 M-clearance through-holes on the spec's square bolt pattern,
 *   - 1 central shaft clearance bore (spec.pilotDia as the nominal diameter
 *     cut is +Y so a motor shaft freely passes through the plate),
 *   - optional shallow boss recess (radius = pilotDia/2) on the entry face.
 *
 * Internal — consumers call `nema17_mountPlate` etc.
 */
function buildNemaMountPlate(
  spec: NemaMotorSpec,
  fnName: string,
  opts: NemaMountPlateOpts,
): Shape3D {
  if (!opts || typeof opts !== "object") {
    throw new TypeError(`${fnName}: opts must include at least { thickness }, got ${String(opts)}.`);
  }
  const { thickness } = opts;
  if (typeof thickness !== "number" || !Number.isFinite(thickness) || thickness <= 0) {
    throw new TypeError(`${fnName}: thickness must be a finite positive number, got ${String(thickness)}.`);
  }
  const fitStyle = opts.fit ?? "clearance";
  const boltSpec = SOCKET_HEAD[spec.mountScrew];
  const boltAllowance = FIT[fitStyle];
  const boltClearanceDia = boltSpec.shaft + boltAllowance * 2;

  // Slight overcut on bolt-holes + shaft bore (0.2 mm) so a boolean cut
  // doesn't leave a sliver on either face from float-precision Z coplanarity.
  // Holes span Z ∈ [-thickness - 0.2, 0.2], centered on the plate.
  const overcut = 0.2;
  const holeLength = thickness + overcut * 2;
  const halfPitch = spec.boltPitch / 2;

  // Build all cut shapes in the default +Z orientation (opening at Z=0,
  // body into -Z). Axis routing happens at the end via a single rotate so
  // every piece stays coplanar through the operation.
  const boltPositions: Array<[number, number]> = [
    [+halfPitch, +halfPitch],
    [+halfPitch, -halfPitch],
    [-halfPitch, +halfPitch],
    [-halfPitch, -halfPitch],
  ];
  // makeCylinder via `cylinder()` — base sits at the bottom of the hole so
  // the top face lands at Z = +overcut (slight pokethrough above the plate).
  let tool = cylinder({
    bottom: [0, 0, -thickness - overcut],
    length: holeLength,
    diameter: spec.pilotDia, // central shaft bore — pilot-boss-sized clearance
  });
  for (const [x, y] of boltPositions) {
    const bolt = cylinder({
      bottom: [x, y, -thickness - overcut],
      length: holeLength,
      diameter: boltClearanceDia,
    });
    tool = tool.fuse(bolt);
  }
  if (opts.boss === true) {
    const bossDepth = opts.bossDepth ?? 2;
    if (!Number.isFinite(bossDepth) || bossDepth <= 0) {
      throw new TypeError(`${fnName}: bossDepth must be a finite positive number, got ${String(bossDepth)}.`);
    }
    if (bossDepth >= thickness) {
      throw new RangeError(
        `${fnName}: bossDepth (${bossDepth}) must be less than plate thickness (${thickness}) — ` +
          `a full-depth boss is just a larger shaft bore; set 'boss: false' and widen 'pilotDia' instead.`,
      );
    }
    const boss = cylinder({
      bottom: [0, 0, -bossDepth],
      length: bossDepth + overcut,
      diameter: spec.pilotDia,
    });
    tool = tool.fuse(boss);
  }

  // Axis routing — same rotation table as holes.applyAxis. Inlined here to
  // avoid a cross-module dependency on the hole namespace for a 6-case switch.
  const axis = opts.axis ?? "+Z";
  const n = normalizeAxis(axis);
  if (!(n[0] === 0 && n[1] === 0 && n[2] === 1)) {
    // Only rotate when axis != +Z. Match holes.applyAxis exactly.
    if (n[0] === 0 && n[1] === 0 && n[2] === -1) {
      tool = tool.rotate(180, [0, 0, 0], [1, 0, 0]);
    } else if (n[0] === 1 && n[1] === 0 && n[2] === 0) {
      tool = tool.rotate(90, [0, 0, 0], [0, 1, 0]);
    } else if (n[0] === -1 && n[1] === 0 && n[2] === 0) {
      tool = tool.rotate(-90, [0, 0, 0], [0, 1, 0]);
    } else if (n[0] === 0 && n[1] === 1 && n[2] === 0) {
      tool = tool.rotate(-90, [0, 0, 0], [1, 0, 0]);
    } else if (n[0] === 0 && n[1] === -1 && n[2] === 0) {
      tool = tool.rotate(90, [0, 0, 0], [1, 0, 0]);
    }
    // Arbitrary non-axis-aligned vectors fall through without rotation —
    // these motor mount cutters are axis-aligned features by definition.
  }

  if (opts.center) {
    const [cx, cy, cz] = opts.center;
    if (![cx, cy, cz].every(Number.isFinite)) {
      throw new TypeError(`${fnName}: center must be three finite numbers, got ${JSON.stringify(opts.center)}.`);
    }
    tool = tool.translate(cx, cy, cz);
  }
  return tool;
}

/**
 * Cut tool for mounting a NEMA 17 (42×42 body, 31 mm bolt pitch, Ø22 boss,
 * Ø5 shaft / Ø22 pilot through-bore, M3 bolts).
 *
 *   plate.cut(motors.nema17_mountPlate({ thickness: 5 }))                 // down through
 *   plate.cut(motors.nema17_mountPlate({ thickness: 5, boss: true }))     // + 2 mm boss recess
 *   plate.cut(motors.nema17_mountPlate({ thickness: 5, axis: "+Y" }))     // sideways mount
 *
 * Default axis `"+Z"` puts the tool's entry face at `Z=0` with the body
 * extending into `-Z` (so `.cut(plate)` against a plate whose top sits at
 * `Z=0` works with no extra translate). Pass `center` to offset the pattern
 * to the desired position on the plate.
 */
export function nema17_mountPlate(opts: NemaMountPlateOpts): Shape3D {
  return buildNemaMountPlate(NEMA17, "motors.nema17_mountPlate", opts);
}

/** NEMA 23 variant — 56.4×56.4 body, 47.14 mm bolt pitch, Ø38.1 boss, M4 bolts. */
export function nema23_mountPlate(opts: NemaMountPlateOpts): Shape3D {
  return buildNemaMountPlate(NEMA23, "motors.nema23_mountPlate", opts);
}

/** NEMA 14 variant — 35×35 body, 26 mm bolt pitch, Ø22 boss, M3 bolts. */
export function nema14_mountPlate(opts: NemaMountPlateOpts): Shape3D {
  return buildNemaMountPlate(NEMA14, "motors.nema14_mountPlate", opts);
}
