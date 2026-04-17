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

import type { Shape3D } from "replicad";
import {
  Part,
  type AttachedJoint,
  type Vec3,
  translateTransform,
  rotateTransform,
  composeTransforms,
} from "./parts";

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

// ── stackOnZ — no-joints shortcut for coaxial +Z stacks ────────────────────

export interface StackOptions {
  /** Axial gap between stacked parts (mm). Default 0. */
  gap?: number;
}

/**
 * Stack parts along +Z using bounding-box math: each part is translated so
 * its bottom (min Z) sits on the previous part's top (max Z), plus `gap`.
 * The first part stays at its original transform.
 *
 * No joint declarations required — this is the simplest way to build
 * coaxial assemblies. For anything that needs rotation, non-Z axes, or
 * diameter-checked mates, use `mate()` + `assemble()` instead.
 */
export function stackOnZ(parts: Part[], opts: StackOptions = {}): Part[] {
  const gap = opts.gap ?? 0;
  if (parts.length === 0) return [];
  const out: Part[] = [parts[0]];
  let previousTop = out[0].worldShape().boundingBox.bounds[1][2];
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const bb = p.worldShape().boundingBox.bounds;
    const bottom = bb[0][2];
    const height = bb[1][2] - bb[0][2];
    const dz = previousTop + gap - bottom;
    const placed = p.translate(0, 0, dz);
    out.push(placed);
    previousTop = previousTop + gap + height;
  }
  return out;
}

/**
 * Convenience: map an array of Parts to viewer-entry format in one call.
 */
export function entries(
  parts: Part[]
): Array<{ shape: Shape3D; name?: string; color?: string }> {
  return parts.map((p) => p.toEntry());
}
