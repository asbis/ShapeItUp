/**
 * Actuator profile evaluation: profile + time → joint coordinate q(t).
 *
 * The "position" profile is the one that answers the solenoid-slowness
 * question: a coil doesn't move instantly, it has a response lag (`delayMs`)
 * before the plunger breaks free and a finite pull-in time (`rampMs`) to seat.
 * Model a weak/slow solenoid with a longer ramp; a laggy driver with a bigger
 * delay. The pattern-testing question — "did the needle seat before the cam
 * arrived?" — falls straight out of comparing this q(t) against the carriage's.
 */

import type { Profile } from "./types";

const smoothstep = (x: number): number => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

type KeyPoint = { t: number; q: number };

/** Interpolate sorted keyframes at time `t` with the chosen mode. */
function interpKeyframes(pts: KeyPoint[], t: number, mode: "linear" | "smoothstep" | "cubic"): number {
  if (pts.length === 0) return 0;
  if (t <= pts[0].t) return pts[0].q;
  const last = pts[pts.length - 1];
  if (t >= last.t) return last.q;
  let i = 0;
  for (; i < pts.length - 1; i++) if (t >= pts[i].t && t <= pts[i + 1].t) break;
  const a = pts[i];
  const b = pts[i + 1];
  const span = b.t - a.t;
  const u = span === 0 ? 0 : (t - a.t) / span;
  if (mode === "linear") return a.q + (b.q - a.q) * u;
  if (mode === "smoothstep") return a.q + (b.q - a.q) * smoothstep(u);
  // Cubic: Catmull-Rom via Hermite with finite-difference tangents (clamped at
  // the ends) so velocity is continuous through the interior points.
  const p0 = pts[i - 1] ?? a;
  const p3 = pts[i + 2] ?? b;
  const m1 = span === 0 ? 0 : ((b.q - p0.q) / (b.t - p0.t)) * span;
  const m2 = span === 0 ? 0 : ((p3.q - a.q) / (p3.t - a.t)) * span;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * a.q + h10 * m1 + h01 * b.q + h11 * m2;
}

/** Evaluate a profile at time `t` (seconds). Returns q in the joint's unit. */
export function evaluateProfile(profile: Profile, t: number): number {
  switch (profile.kind) {
    case "velocity": {
      const delay = (profile.delayMs ?? 0) / 1000;
      return profile.v * Math.max(0, t - delay);
    }
    case "position": {
      const from = profile.from ?? 0;
      const delay = (profile.delayMs ?? 0) / 1000;
      const ramp = Math.max(0, profile.rampMs) / 1000;
      if (t <= delay) return from;
      if (ramp === 0 || t >= delay + ramp) return profile.target;
      const frac = (t - delay) / ramp;
      const eased = profile.easing === "smooth" ? smoothstep(frac) : frac;
      return from + (profile.target - from) * eased;
    }
    case "keyframes": {
      const pts = [...profile.points].sort((p, q) => p.t - q.t);
      return interpKeyframes(pts, t, profile.interp ?? "linear");
    }
    case "sine": {
      const phase = profile.phase ?? 0;
      const offset = profile.offset ?? 0;
      return offset + profile.amplitude * Math.sin(2 * Math.PI * profile.freq * t + phase);
    }
    case "firstOrder": {
      const from = profile.from ?? 0;
      const dead = (profile.deadMs ?? 0) / 1000;
      const tau = Math.max(1e-6, profile.tauMs / 1000);
      if (t <= dead) return from;
      return profile.target - (profile.target - from) * Math.exp(-(t - dead) / tau);
    }
    case "slew":
    case "servo": {
      const from = profile.from ?? 0;
      const rate = profile.kind === "slew" ? profile.rate : profile.slewDegPerS;
      const delay = (profile.delayMs ?? 0) / 1000;
      if (t <= delay) return from;
      const need = profile.target - from;
      const maxDelta = Math.abs(rate) * (t - delay);
      return from + Math.sign(need) * Math.min(Math.abs(need), maxDelta);
    }
  }
}
