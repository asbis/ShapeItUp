/**
 * Frame-playback sampling — turn a recorded SimResult back into a continuous
 * pose function of time.
 *
 * The dynamics engine (Rapier) can't be evaluated analytically like the
 * kinematic engine's `poseAt` — it only produces discrete recorded frames. This
 * samples those frames with position lerp + quaternion slerp so the viewer can
 * scrub/play a dynamics run smoothly (and reproducibly — the recording IS the
 * artifact, since Rapier JS isn't deterministic across machines).
 */

import { lerp, slerp, type Transform } from "./transform";
import type { SimResult } from "./types";

/** Interpolated world transform of every body at time `t` (seconds). */
export function sampleFrames(result: SimResult, t: number): Map<string, Transform> {
  const out = new Map<string, Transform>();
  const { frames, timestep, duration } = result;
  if (frames.length === 0) return out;

  const tc = Math.max(0, Math.min(duration, t));
  const step = timestep > 0 ? timestep : 1;
  let i = Math.floor(tc / step);
  if (i >= frames.length - 1) {
    // At/after the last frame — hold the final pose.
    const last = frames[frames.length - 1];
    for (const id of Object.keys(last.poses)) {
      const p = last.poses[id];
      out.set(id, { t: [p[0], p[1], p[2]], q: [p[3], p[4], p[5], p[6]] });
    }
    return out;
  }
  const f0 = frames[i];
  const f1 = frames[i + 1];
  const span = f1.t - f0.t;
  const alpha = span > 0 ? (tc - f0.t) / span : 0;
  for (const id of Object.keys(f0.poses)) {
    const p0 = f0.poses[id];
    const p1 = f1.poses[id] ?? p0;
    out.set(id, {
      t: lerp([p0[0], p0[1], p0[2]], [p1[0], p1[1], p1[2]], alpha),
      q: slerp([p0[3], p0[4], p0[5], p0[6]], [p1[3], p1[4], p1[5], p1[6]], alpha),
    });
  }
  return out;
}
