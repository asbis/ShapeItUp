/**
 * Minimal rigid-transform math for the kinematic sim core.
 *
 * Deliberately dependency-free (no Three.js, no gl-matrix) so this package
 * runs unchanged in the browser viewer AND headless in Node/MCP. A rigid
 * transform is stored as a unit quaternion + translation:
 *
 *     worldPoint = quat.rotate(localPoint) + translation
 *
 * All coordinates are in the CAD frame (millimetres, Z-up) — the same frame
 * Replicad/OCCT and the viewer already use. Conversion to a physics engine's
 * SI/…-up frame is the job of `units.ts` (the SimFrame bridge), applied only
 * at the Phase-3 dynamics boundary.
 */

export type Vec3 = [number, number, number];
/** Unit quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

export interface Transform {
  q: Quat;
  t: Vec3;
}

export const IDENTITY: Transform = { q: [0, 0, 0, 1], t: [0, 0, 0] };

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (s: number, v: Vec3): Vec3 => [s * v[0], s * v[1], s * v[2]];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (v: Vec3): number => Math.sqrt(dot(v, v));

export function normalize(v: Vec3): Vec3 {
  const l = length(v);
  if (l < 1e-12) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Quaternion for a rotation of `angleRad` about a (not-necessarily-unit) axis. */
export function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const [x, y, z] = normalize(axis);
  const h = angleRad / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}

/** Rotate a point by a unit quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  // v + qw * t + cross(q.xyz, t)
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Hamilton product `a * b` (apply b first, then a). */
export function mulQuat(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Apply a transform to a point. */
export function apply(tf: Transform, v: Vec3): Vec3 {
  return add(rotate(tf.q, v), tf.t);
}

/** Compose two transforms: `compose(a, b)` applies b first, then a. */
export function compose(a: Transform, b: Transform): Transform {
  return { q: mulQuat(a.q, b.q), t: add(rotate(a.q, b.t), a.t) };
}

/** Linear interpolation of two points. */
export function lerp(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
}

/** Spherical-linear interpolation of two unit quaternions (shortest path). */
export function slerp(a: Quat, b: Quat, s: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  // Take the shorter arc.
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  // Near-parallel → normalized lerp avoids a divide-by-~0.
  if (cos > 0.9995) {
    const q: Quat = [
      a[0] + (bx - a[0]) * s,
      a[1] + (by - a[1]) * s,
      a[2] + (bz - a[2]) * s,
      a[3] + (bw - a[3]) * s,
    ];
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  }
  const theta = Math.acos(cos);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - s) * theta) / sinTheta;
  const wb = Math.sin(s * theta) / sinTheta;
  return [
    wa * a[0] + wb * bx,
    wa * a[1] + wb * by,
    wa * a[2] + wb * bz,
    wa * a[3] + wb * bw,
  ];
}

/** Pure translation transform. */
export function translation(v: Vec3): Transform {
  return { q: [0, 0, 0, 1], t: [...v] as Vec3 };
}

/**
 * Rotation of `angleRad` about an axis passing through `anchor`.
 * worldPoint = R·(p − anchor) + anchor = R·p + (anchor − R·anchor).
 */
export function rotationAbout(anchor: Vec3, axis: Vec3, angleRad: number): Transform {
  const q = quatFromAxisAngle(axis, angleRad);
  return { q, t: sub(anchor, rotate(q, anchor)) };
}
