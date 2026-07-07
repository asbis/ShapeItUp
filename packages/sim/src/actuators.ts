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

/** Evaluate a profile at time `t` (seconds). Returns q in mm (prismatic) or rad (revolute). */
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
      if (pts.length === 0) return 0;
      if (t <= pts[0].t) return pts[0].q;
      const last = pts[pts.length - 1];
      if (t >= last.t) return last.q;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (t >= a.t && t <= b.t) {
          const span = b.t - a.t;
          const frac = span === 0 ? 0 : (t - a.t) / span;
          return a.q + (b.q - a.q) * frac;
        }
      }
      return last.q;
    }
    case "sine": {
      const phase = profile.phase ?? 0;
      const offset = profile.offset ?? 0;
      return offset + profile.amplitude * Math.sin(2 * Math.PI * profile.freq * t + phase);
    }
  }
}
