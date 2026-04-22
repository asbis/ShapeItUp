/**
 * Assembly — mate joints and resolve positions.
 *
 * The pipeline:
 *   1. Each part carries named joints (see `./parts.ts`).
 *   2. `mate(jointA, jointB, opts?)` produces a Mate descriptor (data).
 *   3. `assemble([parts], [mates])` walks the mate graph from a root part
 *      and computes each other part's world transform, returning parts in
 *      final position.
 *
 * `stackOnZ([parts], opts?)` is a shortcut for the common coaxial +Z stack
 * case — it positions parts by bounding-box math without requiring any
 * joint declarations.
 */

import { compoundShapes, makeSphere, type Shape3D } from "replicad";
import {
  Part,
  type AttachedJoint,
  type JointSpec,
  type MirrorPlane,
  type Vec3,
  translateTransform,
  rotateTransform,
  composeTransforms,
} from "./parts";
import type { Point3 } from "./standards";

// ── mate() — data descriptor with pre-flight validation ────────────────────

export interface MateOptions {
  /** Axial gap between the two mating faces, along joint A's outward axis. */
  gap?: number;
}

export interface Mate {
  a: AttachedJoint;
  b: AttachedJoint;
  gap: number;
}

/**
 * Describe a rigid constraint: joint `b`'s part will be positioned so that
 * `b`'s origin sits on `a`'s origin (plus an optional axial gap), with
 * `b`'s axis anti-parallel to `a`'s axis.
 *
 * Pre-flight checks — mate() throws if any fail so you learn at declaration
 * time, not after a silent interference:
 *
 *   - "male" must pair with "female" (and vice versa). "face" pairs with "face".
 *   - Matching diameters must agree (within 0.01 mm).
 *
 * Roles and diameters are optional — omit them to skip the checks.
 */
export function mate(
  a: AttachedJoint,
  b: AttachedJoint,
  opts: MateOptions = {}
): Mate {
  // Role check.
  if (a.role && b.role) {
    const valid =
      (a.role === "male" && b.role === "female") ||
      (a.role === "female" && b.role === "male") ||
      (a.role === "face" && b.role === "face");
    if (!valid) {
      throw new Error(
        `mate: incompatible roles — "${a.part.name ?? "?"}:${a.name}" is "${a.role}", ` +
          `"${b.part.name ?? "?"}:${b.name}" is "${b.role}". ` +
          `Valid pairings: male↔female, face↔face.`
      );
    }
  }
  // Diameter check.
  if (
    a.diameter !== undefined &&
    b.diameter !== undefined &&
    Math.abs(a.diameter - b.diameter) > 0.01
  ) {
    throw new Error(
      `mate: diameter mismatch — "${a.part.name ?? "?"}:${a.name}" = ${a.diameter}mm, ` +
        `"${b.part.name ?? "?"}:${b.name}" = ${b.diameter}mm.`
    );
  }
  return { a, b, gap: opts.gap ?? 0 };
}

// ── Rigid-transform math for a single mate ─────────────────────────────────

const DOT = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const CROSS = (u: Vec3, v: Vec3): Vec3 => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];
const SUB = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const SCALE = (s: number, v: Vec3): Vec3 => [s * v[0], s * v[1], s * v[2]];
const LEN = (v: Vec3) => Math.sqrt(DOT(v, v));
const NORM = (v: Vec3): Vec3 => {
  const l = LEN(v);
  if (l === 0) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Given joint `fixed` (already positioned in world) and joint `moving` (on
 * a part that starts at the origin / initial world transform), compute the
 * additional transform that should be composed onto `moving.part` so that:
 *   - moving.axis_world becomes -fixed.axis_world  (opposing outward directions)
 *   - moving.position_world becomes fixed.position_world + gap * fixed.axis_world
 *
 * Returns `{ rotation, translation }` to apply in that order. Either may be
 * null/zero when not needed.
 */
function alignmentFor(
  fixed: AttachedJoint,
  moving: AttachedJoint,
  gap: number
): { rotateAngleDeg: number; rotateAxis: Vec3 | null; translate: Vec3 } {
  const targetAxis = NORM(SCALE(-1, fixed.axis));
  const currentAxis = NORM(moving.axis);

  const d = Math.max(-1, Math.min(1, DOT(currentAxis, targetAxis)));
  const angleRad = Math.acos(d);
  let rotateAngleDeg = 0;
  let rotateAxis: Vec3 | null = null;

  if (Math.abs(angleRad) > 1e-9 && Math.abs(angleRad - Math.PI) > 1e-9) {
    // General rotation.
    rotateAngleDeg = (angleRad * 180) / Math.PI;
    rotateAxis = NORM(CROSS(currentAxis, targetAxis));
  } else if (Math.abs(angleRad - Math.PI) <= 1e-9) {
    // 180° flip: pick any perpendicular axis. For our +Z-dominant use case
    // this rarely triggers, but we cover it for correctness.
    const perp: Vec3 =
      Math.abs(currentAxis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    rotateAxis = NORM(CROSS(currentAxis, perp));
    rotateAngleDeg = 180;
  }

  // Rotate the moving joint's current position around origin by the chosen rotation.
  let rotatedMovingPos: Vec3 = moving.position;
  if (rotateAxis) {
    const r = rotateTransform(rotateAngleDeg, rotateAxis);
    rotatedMovingPos = r.point(moving.position);
  }

  // Target world position for moving joint.
  const targetPos: Vec3 = [
    fixed.position[0] + gap * fixed.axis[0],
    fixed.position[1] + gap * fixed.axis[1],
    fixed.position[2] + gap * fixed.axis[2],
  ];

  const translate = SUB(targetPos, rotatedMovingPos);
  return { rotateAngleDeg, rotateAxis, translate };
}

// ── assemble() — BFS graph resolver ────────────────────────────────────────

export interface AssembleOptions {
  /** Which part is fixed at its current transform. Defaults to parts[0]. */
  root?: Part;
}

/**
 * Resolve a mate graph and return parts in their final world positions.
 *
 * The first part in `parts` (or `opts.root`) is treated as FIXED — its
 * existing transform is preserved. Every other part must be reachable
 * from the root through the mate graph; unreachable parts are returned
 * unchanged with a console.warn.
 *
 * Over-constrained graphs (a part with multiple mates) resolve using the
 * FIRST mate encountered in the BFS; subsequent mates are ignored with a
 * console.warn.
 */
export function assemble(
  parts: Part[],
  mates: Mate[],
  opts: AssembleOptions = {}
): Part[] {
  if (parts.length === 0) return [];
  const root = opts.root ?? parts[0];
  if (!parts.includes(root)) {
    throw new Error("assemble: root part must be in the parts list");
  }

  // Map identity (by reference) → Part — mutates as we position parts.
  const positioned = new Map<Part, Part>();
  positioned.set(root, root);

  // Adjacency list: part → [{ partner: Part, ourJoint: AttachedJoint, theirJoint: AttachedJoint, gap }]
  type Edge = {
    partner: Part;
    ourJoint: AttachedJoint;
    theirJoint: AttachedJoint;
    gap: number;
  };
  const adj = new Map<Part, Edge[]>();
  const ensure = (p: Part) => {
    if (!adj.has(p)) adj.set(p, []);
    return adj.get(p)!;
  };
  for (const m of mates) {
    ensure(m.a.part).push({
      partner: m.b.part,
      ourJoint: m.a,
      theirJoint: m.b,
      gap: m.gap,
    });
    ensure(m.b.part).push({
      partner: m.a.part,
      ourJoint: m.b,
      theirJoint: m.a,
      gap: m.gap,
    });
  }

  // BFS from root. For each edge from a positioned part to an unpositioned
  // partner, compute the partner's world transform and position it.
  const queue: Part[] = [root];
  while (queue.length > 0) {
    const from = queue.shift()!;
    const fromPositioned = positioned.get(from)!;
    const edges = adj.get(from) ?? [];
    for (const e of edges) {
      if (positioned.has(e.partner)) continue;

      // Fixed joint: take the positioned Part's version of the joint.
      const fixedJoint = fromPositioned.joints[e.ourJoint.name];
      // Moving joint: comes from the partner part at its CURRENT transform
      // (typically identity — partners are built at the origin).
      const movingJoint = e.partner.joints[e.theirJoint.name];

      const { rotateAngleDeg, rotateAxis, translate } = alignmentFor(
        fixedJoint,
        movingJoint,
        e.gap
      );

      let placed = e.partner;
      if (rotateAxis && rotateAngleDeg !== 0) {
        placed = placed.rotate(rotateAngleDeg, rotateAxis);
      }
      placed = placed.translate(translate[0], translate[1], translate[2]);
      positioned.set(e.partner, placed);
      queue.push(e.partner);
    }
  }

  // Return parts in input order, substituting positioned versions where found.
  return parts.map((p) => {
    const pos = positioned.get(p);
    if (!pos) {
      console.warn(
        `assemble: part "${p.name ?? "?"}" is not connected to the root via any mate — returning unchanged.`
      );
      return p;
    }
    return pos;
  });
}

// ── stack / stackOnZ — no-joints shortcut for coaxial stacks ───────────────

export interface StackOptions {
  /** Axial gap between stacked parts (mm). Default 0. */
  gap?: number;
}

/** Stacking axis shorthand — any of the six principal directions. */
export type StackAxis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z";

/** Transverse-alignment mode for `stack()`. */
export type StackAlign = "center" | "min" | "max";

export interface StackGeneralOptions {
  /** Stacking direction. Default `"+Z"`. */
  axis?: StackAxis;
  /**
   * Axial gap between consecutive parts (mm). A scalar applies uniformly;
   * an array of length `parts.length - 1` gives per-gap control (index `i`
   * is the gap between `parts[i]` and `parts[i+1]`). Default `0`.
   */
  gap?: number | number[];
  /**
   * Alignment on the two transverse axes:
   * - `"center"` — match the first part's bbox centre (default).
   * - `"min"`    — align min-face on each transverse axis.
   * - `"max"`    — align max-face on each transverse axis.
   */
  align?: StackAlign;
}

/**
 * Stack parts along a principal axis using bounding-box math — no joint
 * declarations required. The first part stays at its original transform;
 * every subsequent part is translated so its leading face meets the previous
 * part's trailing face plus `gap`, and on the two transverse axes aligned
 * according to `align`.
 *
 * ```typescript
 * // Vertical column, 2 mm gap between layers, centred on the first part.
 * stack([base, plate, cap], { axis: "+Z", gap: 2 });
 * ```
 *
 * For anything that needs rotation or diameter-checked mates, use
 * `mate()` + `assemble()` instead.
 *
 * @throws when `gap` is an array of the wrong length (must equal
 *   `parts.length - 1`).
 */
export function stack(parts: Part[], opts: StackGeneralOptions = {}): Part[] {
  if (parts.length === 0) return [];

  const axisSpec = opts.axis ?? "+Z";
  const align = opts.align ?? "center";
  const gapOpt = opts.gap ?? 0;

  // Resolve axis into an index (0=X, 1=Y, 2=Z) and sign (+1 / -1).
  const axisIndex = axisSpec[1] === "X" ? 0 : axisSpec[1] === "Y" ? 1 : 2;
  const axisSign = axisSpec[0] === "+" ? 1 : -1;
  const transverseAxes = [0, 1, 2].filter((i) => i !== axisIndex) as [number, number];

  // Resolve gap into a per-pair array of length `parts.length - 1`.
  const gaps: number[] = (() => {
    const n = parts.length - 1;
    if (Array.isArray(gapOpt)) {
      if (gapOpt.length !== n) {
        throw new Error(
          `stack: gap array length ${gapOpt.length} does not match parts.length - 1 = ${n}. ` +
            `Pass a scalar for a uniform gap, or exactly ${n} values for per-pair gaps.`,
        );
      }
      return gapOpt.slice();
    }
    return new Array(n).fill(gapOpt);
  })();

  // Reference bbox (first part) — used to lock the transverse alignment so
  // every later part lines up with the same frame rather than drifting as
  // per-part bbox-centre differences compound.
  const firstBounds = parts[0].worldShape().boundingBox.bounds;
  const refMin = firstBounds[0];
  const refMax = firstBounds[1];

  // Trailing face of the currently-last-placed part along the stack axis.
  // For "+Z", this is the max-Z face; for "-Z" it's the min-Z face.
  let trailing =
    axisSign > 0 ? refMax[axisIndex] : refMin[axisIndex];

  const out: Part[] = [parts[0]];

  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const bb = p.worldShape().boundingBox.bounds;
    const pMin = bb[0];
    const pMax = bb[1];

    // Axial translation: move the leading face to `trailing + sign*gap`.
    // For "+Z", leading face is min-Z; target = trailing + gap. dAxis = target - pMin[axis].
    // For "-Z", leading face is max-Z; target = trailing - gap. dAxis = target - pMax[axis].
    const gap = gaps[i - 1];
    let dAxis: number;
    if (axisSign > 0) {
      const target = trailing + gap;
      dAxis = target - pMin[axisIndex];
    } else {
      const target = trailing - gap;
      dAxis = target - pMax[axisIndex];
    }

    // Transverse translation: align on each non-stacking axis.
    const translate: [number, number, number] = [0, 0, 0];
    translate[axisIndex] = dAxis;
    for (const t of transverseAxes) {
      if (align === "min") {
        translate[t] = refMin[t] - pMin[t];
      } else if (align === "max") {
        translate[t] = refMax[t] - pMax[t];
      } else {
        // center
        const refCenter = (refMin[t] + refMax[t]) / 2;
        const pCenter = (pMin[t] + pMax[t]) / 2;
        translate[t] = refCenter - pCenter;
      }
    }

    const placed = p.translate(translate[0], translate[1], translate[2]);
    out.push(placed);

    // Advance the trailing face along the stack axis.
    const extent = pMax[axisIndex] - pMin[axisIndex];
    if (axisSign > 0) {
      trailing = trailing + gap + extent;
    } else {
      trailing = trailing - gap - extent;
    }
  }
  return out;
}

/**
 * Stack parts along +Z — thin wrapper around `stack()` with `axis: "+Z"`.
 *
 * Retained for backwards compatibility. Prefer `stack()` directly when you
 * need any axis other than +Z, per-pair gaps, or min/max transverse
 * alignment.
 */
export function stackOnZ(parts: Part[], opts: StackOptions = {}): Part[] {
  return stack(parts, { axis: "+Z", gap: opts.gap });
}

/**
 * Convenience: map an array of Parts to viewer-entry format in one call.
 *
 * Flattens subassemblies — a Part with `isSubassembly === true` expands
 * into its positioned children rather than appearing as a single compound.
 */
export function entries(
  parts: Part[]
): Array<{ shape: Shape3D; name?: string; color?: string }> {
  return parts.flatMap((p) => p.toEntries());
}

// ── Symmetric pairs ─────────────────────────────────────────────────────────

export interface SymmetricPairOptions {
  /**
   * Point on the mirror plane. Defaults to `[0, 0, 0]`. Only the component
   * perpendicular to `plane` matters (e.g. for `"YZ"`, the mirror is
   * through `x = origin[0]`).
   */
  origin?: Point3;
  /**
   * If provided, every joint on the LEFT (original) part is renamed to
   * `<original><leftSuffix>`. Handy when the pair participates in a larger
   * assembly and callers want unambiguous names per side. Default: no
   * suffix (the original names are kept).
   */
  leftSuffix?: string;
  /**
   * If provided, every joint on the RIGHT (mirrored) part is renamed to
   * `<original><rightSuffix>`. Default: no suffix.
   */
  rightSuffix?: string;
}

/**
 * Build a symmetric pair `[left, right]` by mirroring `part` across the
 * named plane. The LEFT element is the original `part` (unchanged); the
 * RIGHT is `part.mirror(plane, origin)`.
 *
 * ```typescript
 * const bracket = part({
 *   shape: bracketShape,
 *   name: "bracket",
 *   joints: {
 *     wallFace:  faceAt(0, { axis: "-Y" }),
 *     shelfFace: faceAt(BRACKET_DEPTH, { axis: "+Y" }),
 *   },
 * });
 *
 * const [left, right] = symmetricPair(bracket, "YZ", {
 *   leftSuffix: "L",
 *   rightSuffix: "R",
 * });
 * // left.joints.wallFaceL   right.joints.wallFaceR
 * // left.joints.shelfFaceL  right.joints.shelfFaceR
 * ```
 *
 * ### Behavior
 *
 * - Joint roles are preserved on both sides — a male shaft on the left is
 *   still a male shaft on the right. See `Part.mirror` for the rationale
 *   (mirroring produces mirror-image geometry, not role inversion).
 * - Joint positions + axes are reflected correctly on the right part via
 *   `Part.mirror`; the left part is returned unchanged.
 * - Suffixes are applied AFTER mirroring via `Part.renameJoints`. Omit
 *   both to keep the original joint names on both parts (callers may
 *   prefer this when each part is passed individually to `mate()`).
 *
 * @param part The Part to pair. Should be built at its local origin so the
 *   mirrored partner lands symmetrically across the plane.
 * @param plane Coordinate plane: `"YZ"` (mirror across x=0), `"XZ"`
 *   (across y=0), or `"XY"` (across z=0). Pick the plane whose normal is
 *   the symmetry axis of the pair (typically `"YZ"` for left/right pairs
 *   along X).
 * @param opts Optional `{ origin, leftSuffix, rightSuffix }`.
 * @returns `[left, right]` — two Parts ready to drop into `assemble()`.
 */
export function symmetricPair(
  part: Part,
  plane: MirrorPlane,
  opts: SymmetricPairOptions = {}
): [Part, Part] {
  let left = part;
  let right = part.mirror(plane, opts.origin);
  const { leftSuffix, rightSuffix } = opts;
  if (leftSuffix || rightSuffix) {
    const jointNames = Object.keys(left.joints);
    if (leftSuffix) {
      const renames: Record<string, string> = {};
      for (const n of jointNames) renames[n] = `${n}${leftSuffix}`;
      left = left.renameJoints(renames);
    }
    if (rightSuffix) {
      const renames: Record<string, string> = {};
      for (const n of jointNames) renames[n] = `${n}${rightSuffix}`;
      right = right.renameJoints(renames);
    }
  }
  return [left, right];
}

// ── Subassemblies ───────────────────────────────────────────────────────────

export interface SubassemblyOptions {
  /** Parts to compose. Same semantics as `assemble()`. */
  parts: Part[];
  /** Mates that position the parts within the subassembly. */
  mates: Mate[];
  /** Name for the subassembly. Applied as a group label if useful downstream. */
  name?: string;
  /** Default color for children that don't have their own. */
  color?: string;
  /** Root part (default: parts[0]). */
  root?: Part;
  /**
   * Joints to expose on the subassembly's boundary — these become the
   * interface other parts mate against. Map from the new joint name
   * (on the subassembly) to the child's attached joint to promote.
   *
   *   promote: { mount: plate.joints.couplerFace }
   *   // → subassembly.joints.mount now reflects plate.couplerFace
   */
  promote?: Record<string, AttachedJoint>;
}

/**
 * Build a subassembly — resolve internal mates, promote selected joints,
 * and return the whole thing as a single Part that can be mated into a
 * higher-level assembly.
 *
 * ```typescript
 * const motorModule = subassembly({
 *   parts: [motor, plate],
 *   mates: [mate(motor.joints.mountFace, plate.joints.motorFace)],
 *   name: "motor-module",
 *   color: "#777788",
 *   promote: { mount: plate.joints.couplerFace },
 * });
 *
 * // Use like any other Part
 * const positioned = assemble([motorModule, coupler, leadscrew], [
 *   mate(motorModule.joints.mount, coupler.joints.motorEnd),
 *   ...
 * ]);
 * return entries(positioned);  // children are flattened automatically
 * ```
 *
 * Subassemblies compose — a subassembly can be a child of another
 * subassembly, with transforms composing correctly at each level.
 */
export function subassembly(opts: SubassemblyOptions): Part {
  if (opts.parts.length === 0) {
    throw new Error("subassembly: parts array is empty");
  }
  const positioned = assemble(opts.parts, opts.mates, { root: opts.root });

  // Capture promoted joints' current world-space state (which is the
  // subassembly's LOCAL frame because its xform starts as identity).
  const localJoints: Record<string, JointSpec> = {};
  if (opts.promote) {
    for (const [name, attachedJoint] of Object.entries(opts.promote)) {
      localJoints[name] = {
        position: attachedJoint.position,
        axis: attachedJoint.axis,
        role: attachedJoint.role,
        diameter: attachedJoint.diameter,
      };
    }
  }

  // Give the Part a compound of all children's worldShapes so boundingBox
  // queries work. Rendering goes through `.toEntries()` which iterates the
  // children directly — the compound is just for bbox / debug paths.
  const childShapes = positioned.map((p) => p.worldShape());
  // compoundShapes types as AnyShape in the stub; runtime always returns a
  // Compound which satisfies Shape3D for our purposes (boundingBox etc).
  const compound = compoundShapes(childShapes) as Shape3D;

  return new Part(compound, {
    name: opts.name,
    color: opts.color,
    joints: localJoints,
    children: positioned,
  });
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Return a text summary of every joint on every part, with world-space
 * positions and axes. Use when a mate isn't positioning where you expect
 * and you want to see where joints actually landed.
 *
 *   console.log(debugJoints(positioned));
 *
 * Output format (one joint per line):
 *   motor.shaftTip       pos (0.0, 0.0, 64.0)  axis (0.0, 0.0, 1.0)
 *   plate.motorFace      pos (0.0, 0.0, 40.0)  axis (0.0, 0.0, -1.0)
 *
 * Unnamed parts are referred to as `?` in the output.
 */
export function debugJoints(parts: Part[]): string {
  const lines: string[] = [];
  const fmt = (n: number) => n.toFixed(2);
  for (const p of parts) {
    const partName = p.name ?? "?";
    const jointEntries = Object.entries(p.joints);
    if (jointEntries.length === 0) {
      lines.push(`${partName}  (no joints)`);
      continue;
    }
    const longestJointName = jointEntries.reduce(
      (m, [n]) => Math.max(m, n.length),
      0
    );
    for (const [jname, j] of jointEntries) {
      const jp = `${partName}.${jname}`.padEnd(partName.length + longestJointName + 2);
      lines.push(
        `${jp}  pos (${fmt(j.position[0])}, ${fmt(j.position[1])}, ${fmt(j.position[2])})  axis (${fmt(j.axis[0])}, ${fmt(j.axis[1])}, ${fmt(j.axis[2])})`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Return a viewer-entry array that includes every part's shape AND a small
 * pink sphere at each joint's world-space position. Use as the return value
 * of `main()` to visually verify joint positions after `assemble()`.
 *
 *   const positioned = assemble([motor, plate, coupler], [...mates]);
 *   return highlightJoints(positioned);   // renders parts + joint spheres
 *
 * The sphere radius auto-scales to the assembly's bounding box (2% of the
 * largest dimension). Override via `opts.radius`. The sphere color defaults
 * to a hot pink that contrasts with both AI-mode white and dark-mode bg.
 */
export function highlightJoints(
  parts: Part[],
  opts: { radius?: number; color?: string } = {}
): Array<{ shape: Shape3D; name?: string; color?: string }> {
  // Gather all entries first so we can size the markers to the scene.
  const partEntries = parts.map((p) => p.toEntry());
  const color = opts.color ?? "#ff3366";

  let radius = opts.radius;
  if (radius === undefined) {
    // Walk every part's bounding box to compute a sane marker size.
    let maxDim = 0;
    for (const e of partEntries) {
      try {
        const bb = (e.shape as any).boundingBox?.bounds;
        if (bb) {
          const dx = bb[1][0] - bb[0][0];
          const dy = bb[1][1] - bb[0][1];
          const dz = bb[1][2] - bb[0][2];
          maxDim = Math.max(maxDim, dx, dy, dz);
        }
      } catch {}
    }
    radius = Math.max(maxDim * 0.02, 0.5);
  }

  const markers: Array<{ shape: Shape3D; name?: string; color?: string }> = [];
  for (const p of parts) {
    const partName = p.name ?? "part";
    for (const [jname, j] of Object.entries(p.joints)) {
      const sphere = makeSphere(radius).translate(
        j.position[0],
        j.position[1],
        j.position[2]
      );
      markers.push({ shape: sphere, name: `${partName}.${jname}`, color });
    }
  }
  return [...partEntries, ...markers];
}

// ── composeAssembly — merge parametric main() exports into one top-level ────

/** A single entry in the assembly's returned part list. Shape-3D + metadata. */
export interface ComposedAssemblyPart {
  shape: Shape3D;
  name?: string;
  color?: string;
  qty?: number;
  material?: { density: number; name?: string };
  analyze?: boolean;
  [key: string]: unknown;
}

/**
 * One file contributes its `main()` export plus its own `params` dict. The
 * optional `transform` runs on every part the `main` produces, AFTER the
 * shape is cloned (Replicad's translate/rotate consume their input — a
 * transform that consumed the caller's shape would invalidate any cached
 * handle upstream).
 */
export interface ComposedPart {
  main: (params?: Record<string, number>) => unknown;
  params?: Record<string, number>;
  transform?: (part: ComposedAssemblyPart) => ComposedAssemblyPart;
}

export interface ComposeAssemblyOptions {
  parts: ComposedPart[];
}

export interface ComposedAssembly {
  main: (allParams?: Record<string, number>) => ComposedAssemblyPart[];
  params: Record<string, number>;
}

/**
 * Normalize whatever `main()` handed back into a uniform array of
 * `{ shape, ... }` records. Accepts the full shape-entry polymorphism:
 *
 *   - a single Shape3D                     → `[{ shape }]`
 *   - a single `{ shape, name, color }`    → `[that]`
 *   - an array of either                   → flattened into records
 *
 * Anything else throws — the composer cannot silently drop parts the caller
 * produced because of a return-type mistake.
 */
function normalizeMainResult(
  result: unknown,
  partLabel: string,
): ComposedAssemblyPart[] {
  if (result == null) {
    throw new Error(`composeAssembly: part "${partLabel}" main() returned ${result}`);
  }
  const asEntry = (item: unknown, index: number): ComposedAssemblyPart => {
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (obj.shape && typeof (obj.shape as any).clone === "function") {
        return { ...(obj as ComposedAssemblyPart) };
      }
      if (typeof (obj as any).clone === "function") {
        return { shape: obj as unknown as Shape3D };
      }
    }
    throw new Error(
      `composeAssembly: part "${partLabel}" main() returned item #${index} ` +
        `that is not a Shape3D or { shape, ... } object`,
    );
  };
  if (Array.isArray(result)) {
    return result.map((it, i) => asEntry(it, i));
  }
  return [asEntry(result, 0)];
}

/**
 * Compose several parametric `.shape.ts` files' `main()` exports into a
 * single top-level assembly. Each child contributes its own `params` dict;
 * `composeAssembly` merges them into one flat object and returns a new
 * `main` that dispatches overrides to the right child by key.
 *
 * Duplicate param keys are rejected up front with a message naming both
 * contributing parts — silent overwriting would make the tune_params slider
 * behaviour depend on part order, which is exactly the bug this helper
 * exists to prevent.
 *
 * ```typescript
 * // assembly.shape.ts
 * import * as body from "./body.shape";
 * import * as cam  from "./cam.shape";
 * const assembly = composeAssembly({
 *   parts: [
 *     { main: body.default, params: body.params },
 *     { main: cam.default,  params: cam.params,
 *       transform: (p) => ({ ...p, shape: p.shape.translate(0, 0, 20) }) },
 *   ],
 * });
 * export const params = assembly.params;
 * export default assembly.main;
 * ```
 */
export function composeAssembly(opts: ComposeAssemblyOptions): ComposedAssembly {
  if (!opts || !Array.isArray(opts.parts) || opts.parts.length === 0) {
    throw new Error("composeAssembly: `parts` must be a non-empty array");
  }
  // Validate each entry and build a per-part label up-front. Labels prefer
  // the function's `.name` (so errors read like "part 'makeBody'" instead of
  // "part #0"); fall back to the index when the caller passed an anonymous
  // arrow.
  const labels: string[] = [];
  for (let i = 0; i < opts.parts.length; i++) {
    const p = opts.parts[i];
    if (!p || typeof p.main !== "function") {
      throw new Error(
        `composeAssembly: parts[${i}].main must be a function (got ${typeof p?.main})`,
      );
    }
    if (p.transform !== undefined && typeof p.transform !== "function") {
      throw new Error(
        `composeAssembly: parts[${i}].transform must be a function when provided`,
      );
    }
    if (p.params !== undefined && (typeof p.params !== "object" || p.params === null || Array.isArray(p.params))) {
      throw new Error(
        `composeAssembly: parts[${i}].params must be a plain object when provided`,
      );
    }
    const label = (p.main as { name?: string }).name?.trim() || `part[${i}]`;
    labels.push(label);
  }

  // Merge params. Track which part contributed each key so a collision
  // names both sides.
  const mergedParams: Record<string, number> = {};
  const owners: Record<string, string> = {};
  for (let i = 0; i < opts.parts.length; i++) {
    const partParams = opts.parts[i].params;
    if (!partParams) continue;
    for (const key of Object.keys(partParams)) {
      if (Object.prototype.hasOwnProperty.call(owners, key)) {
        throw new Error(
          `composeAssembly: param "${key}" is declared by both "${owners[key]}" and "${labels[i]}". ` +
            `Rename one side — merged params must be unambiguous so slider overrides dispatch correctly.`,
        );
      }
      mergedParams[key] = partParams[key];
      owners[key] = labels[i];
    }
  }

  const main = (allParams?: Record<string, number>): ComposedAssemblyPart[] => {
    const overrides = allParams ?? {};
    const out: ComposedAssemblyPart[] = [];
    for (let i = 0; i < opts.parts.length; i++) {
      const part = opts.parts[i];
      const label = labels[i];
      // Pass only keys this part declared. A child that doesn't declare
      // `params` at all receives `undefined` — matching the pattern in
      // SKILL.md where a factory's default-argument pulls from its own
      // module-level params.
      let subset: Record<string, number> | undefined;
      if (part.params) {
        subset = {};
        for (const key of Object.keys(part.params)) {
          subset[key] =
            Object.prototype.hasOwnProperty.call(overrides, key)
              ? overrides[key]
              : part.params[key];
        }
      }
      const raw = part.main(subset);
      const entries = normalizeMainResult(raw, label);
      for (const entry of entries) {
        if (part.transform) {
          // Replicad's translate/rotate DELETE the input — clone before
          // handing the shape to user code that's about to transform it.
          const cloned: ComposedAssemblyPart = {
            ...entry,
            shape: entry.shape.clone(),
          };
          const transformed = part.transform(cloned);
          if (!transformed || !transformed.shape) {
            throw new Error(
              `composeAssembly: part "${label}" transform returned ${transformed} ` +
                `(expected a { shape, ... } object)`,
            );
          }
          out.push(transformed);
        } else {
          out.push(entry);
        }
      }
    }
    return out;
  };

  return { main, params: mergedParams };
}
