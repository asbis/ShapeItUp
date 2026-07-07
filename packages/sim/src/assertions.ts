/**
 * Assertion evaluation — turn a shape's colocated `sim.assertions` into
 * pass/fail verdicts against a recorded run, so a design can self-test
 * headlessly ("the linkage never stretches", "the selector never jams", "the
 * pusher reaches the needle in time"). Pure and framework-agnostic.
 */

import { globToRegex } from "./collision";
import { apply, type Transform, type Vec3 } from "./transform";
import type { AssertionResult, SimFrame, SimResult, SimSpec } from "./types";

function frameTransform(frame: SimFrame, bodyId: string): Transform | null {
  const p = frame.poses[bodyId];
  if (!p) return null;
  return { t: [p[0], p[1], p[2]], q: [p[3], p[4], p[5], p[6]] };
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Evaluate every assertion in `spec` against `result`. */
export function evaluateAssertions(spec: SimSpec, result: SimResult): AssertionResult[] {
  const markers = new Map((spec.markers ?? []).map((m) => [m.name, m]));
  const markerWorld = (frame: SimFrame, name: string): Vec3 | null => {
    const m = markers.get(name);
    if (!m) return null;
    const tf = frameTransform(frame, m.body);
    return tf ? apply(tf, m.point) : null;
  };

  const out: AssertionResult[] = [];
  for (const a of spec.assertions ?? []) {
    if (a.kind === "noCollision") {
      const ra = globToRegex(a.a);
      const rb = globToRegex(a.b);
      const hit = result.collisions.find(
        (c) => (ra.test(c.a) && rb.test(c.b)) || (ra.test(c.b) && rb.test(c.a)),
      );
      out.push({
        name: a.name,
        kind: a.kind,
        pass: !hit,
        detail: hit ? `collided at ${(hit.tStart * 1000).toFixed(0)}ms (${hit.a}↔${hit.b})` : "no collision",
      });
    } else if (a.kind === "markerDistance") {
      if (!markers.has(a.markerA) || !markers.has(a.markerB)) {
        out.push({ name: a.name, kind: a.kind, pass: false, detail: `unknown marker ${!markers.has(a.markerA) ? a.markerA : a.markerB}` });
        continue;
      }
      let min = Infinity;
      let max = -Infinity;
      for (const f of result.frames) {
        const pa = markerWorld(f, a.markerA);
        const pb = markerWorld(f, a.markerB);
        if (!pa || !pb) continue;
        const d = dist(pa, pb);
        if (d < min) min = d;
        if (d > max) max = d;
      }
      const tol = a.tol ?? 0.5;
      let pass = true;
      const want: string[] = [];
      if (a.equals !== undefined) {
        pass = pass && min >= a.equals - tol && max <= a.equals + tol;
        want.push(`equals ${a.equals}±${tol}`);
      }
      if (a.min !== undefined) {
        pass = pass && min >= a.min - tol;
        want.push(`min ${a.min}`);
      }
      if (a.max !== undefined) {
        pass = pass && max <= a.max + tol;
        want.push(`max ${a.max}`);
      }
      out.push({
        name: a.name,
        kind: a.kind,
        pass,
        detail: `observed ${min.toFixed(2)}..${max.toFixed(2)}mm${want.length ? ` (want ${want.join(", ")})` : ""}`,
      });
    } else {
      // markerReaches
      if (!markers.has(a.marker)) {
        out.push({ name: a.name, kind: a.kind, pass: false, detail: `unknown marker ${a.marker}` });
        continue;
      }
      const tol = a.tol ?? 1;
      const byT = a.byMs !== undefined ? a.byMs / 1000 : Infinity;
      let closest = Infinity;
      let reachedAt: number | null = null;
      for (const f of result.frames) {
        if (f.t > byT) break;
        const p = markerWorld(f, a.marker);
        if (!p) continue;
        const d = dist(p, a.point);
        if (d < closest) closest = d;
        if (d <= tol && reachedAt === null) reachedAt = f.t;
      }
      out.push({
        name: a.name,
        kind: a.kind,
        pass: reachedAt !== null,
        detail: reachedAt !== null ? `reached at ${(reachedAt * 1000).toFixed(0)}ms` : `closest ${closest.toFixed(2)}mm (tol ${tol})`,
      });
    }
  }
  return out;
}
