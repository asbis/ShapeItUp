/**
 * Collision detection for the kinematic sim.
 *
 * Phase 1 uses transformed axis-aligned bounding boxes — the same AABB
 * approach the existing `check_collisions` MCP tool uses as its prefilter.
 * It's cheap, headless (no OCCT), and good enough to answer the Phase-1
 * question: "as this mechanism moves, do two parts ever occupy the same
 * space — and when?" Mesh-accurate narrow-phase is a later refinement.
 */

import type { Aabb } from "./types";
import { apply, type Transform, type Vec3 } from "./transform";

/** Transform the 8 corners of a rest AABB and return the enclosing world AABB. */
export function transformAabb(box: Aabb, tf: Transform): Aabb {
  const { min, max } = box;
  const corners: Vec3[] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];
  const lo: Vec3 = [Infinity, Infinity, Infinity];
  const hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) {
    const w = apply(tf, c);
    for (let i = 0; i < 3; i++) {
      if (w[i] < lo[i]) lo[i] = w[i];
      if (w[i] > hi[i]) hi[i] = w[i];
    }
  }
  return { min: lo, max: hi };
}

/**
 * Signed overlap volume of two AABBs (mm³). `tol` shrinks each box slightly so
 * bodies that merely touch (coincident faces, a resting fit) don't register —
 * matching how mechanical clearances work. Returns 0 when they don't overlap.
 */
export function overlapVolume(a: Aabb, b: Aabb, tol = 0): number {
  let vol = 1;
  for (let i = 0; i < 3; i++) {
    const lo = Math.max(a.min[i], b.min[i]);
    const hi = Math.min(a.max[i], b.max[i]);
    const d = hi - lo - tol;
    if (d <= 0) return 0;
    vol *= d;
  }
  return vol;
}

/** Compile a `*`-glob into a whole-string regex. */
export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * True when the unordered pair (a, b) matches any accepted-pair glob rule.
 * A rule `[p, q]` matches if a~p & b~q, OR a~q & b~p.
 */
export function isAcceptedPair(
  acceptedPairs: Array<[string, string]> | undefined,
  a: string,
  b: string,
): boolean {
  if (!acceptedPairs) return false;
  for (const [p, q] of acceptedPairs) {
    const rp = globToRegex(p);
    const rq = globToRegex(q);
    if ((rp.test(a) && rq.test(b)) || (rp.test(b) && rq.test(a))) return true;
  }
  return false;
}
