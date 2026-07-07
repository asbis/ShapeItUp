/**
 * SimFrame — the ONE place unit/axis conversion happens.
 *
 * Getting this wrong is the classic silent physics bug: Replicad is in
 * millimetres and Z-up; JS physics engines (Rapier/Jolt) expect SI metres, and
 * Three.js is Y-up. A stray `*0.001` or a swapped axis makes gravity point
 * sideways or parts render 1000× too big. So conversion lives here, is unit
 * tested, and is applied only at the physics-engine boundary (Phase 3).
 *
 * The Phase-1 kinematic core stays entirely in the CAD frame (mm, Z-up) — the
 * viewer already renders CAD coordinates — so these helpers are a no-op-free
 * boundary you opt into when you hand state to a dynamics engine.
 */

import type { Vec3 } from "./transform";

/** Millimetres per metre. Replicad(mm) → SI(m) is `*MM_TO_M`. */
export const MM_TO_M = 0.001;
export const M_TO_MM = 1000;

export interface SimFrameOptions {
  /**
   * Up-axis of the target frame. CAD/Replicad is "Z"; Three.js scenes are
   * often authored "Y". "Z" (default) means no axis remap — the ShapeItUp
   * viewer keeps CAD's Z-up, so the common case is a pure scale.
   */
  targetUp?: "Y" | "Z";
}

/**
 * Convert a length/position from CAD millimetres to physics SI metres,
 * optionally remapping Z-up → Y-up.
 */
export function mmToSi(v: Vec3, opts: SimFrameOptions = {}): Vec3 {
  const s: Vec3 = [v[0] * MM_TO_M, v[1] * MM_TO_M, v[2] * MM_TO_M];
  if (opts.targetUp === "Y") return [s[0], s[2], -s[1]]; // Z-up → Y-up
  return s;
}

/** Inverse of {@link mmToSi}. */
export function siToMm(v: Vec3, opts: SimFrameOptions = {}): Vec3 {
  const u: Vec3 = opts.targetUp === "Y" ? [v[0], -v[2], v[1]] : v; // Y-up → Z-up
  return [u[0] * M_TO_MM, u[1] * M_TO_MM, u[2] * M_TO_MM];
}

/** Default gravity as a CAD-frame vector (mm/s², pointing −Z). */
export const GRAVITY_MM: Vec3 = [0, 0, -9810];
