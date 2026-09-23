/**
 * Is the face selector the viewer is about to write actually unique?
 *
 * The viewer names a picked face by its plane — `inPlane("XY", thickness)` —
 * because a plane follows the parameters. But a plane is not always a name.
 * Fuse two gussets onto a bracket's base and the base's top is split into
 * three coplanar faces; the plane matches all three, and every stdlib face
 * helper refuses a selector that does not match exactly one. The line gets
 * written, the model re-runs, and nothing happens.
 *
 * Only the worker holds the B-Rep, so only it can count. When the plane is
 * ambiguous it looks for a point that narrows it — `.containsPoint(p)` — and
 * VERIFIES the narrowed finder matches the picked face and nothing else
 * before offering it. An unverified pin would just move the failure.
 */
import { FaceFinder, type Face, type Shape3D } from "replicad";
import type { PreviewTargetReport } from "@shapeitup/shared";

type Vec3 = [number, number, number];

/**
 * How far a face's reported centre may drift from the descriptor the viewer
 * holds. That descriptor made a Float32 round trip; genuinely different faces
 * have centres millimetres apart, not thousandths.
 */
const CENTER_TOLERANCE = 1e-2;

export function planeAxis(plane: string): 0 | 1 | 2 {
  return plane === "XY" ? 2 : plane === "XZ" ? 1 : 0;
}

/**
 * Count the faces a plane predicate matches and, when it is more than one,
 * find a pin that isolates the picked face.
 *
 * `center` identifies the picked face among the matches. The candidates for
 * the pin are tried in order of how well they read in source: the centre
 * rounded to 0.1 mm, then more finely, then the same for `interior`. The
 * centre comes first because it is a property of the face, not of where the
 * user happened to click; `interior` exists because the centre of an L-shaped
 * or ring face lies outside it.
 */
export function resolveFaceTarget(
  shape: Shape3D,
  plane: string,
  offset: number,
  center?: Vec3,
  interior?: Vec3,
): PreviewTargetReport {
  let matches: Face[];
  try {
    matches = new FaceFinder().inPlane(plane as any, offset).find(shape);
  } catch {
    return { planeMatches: 0 };
  }
  const report: PreviewTargetReport = { planeMatches: matches.length };
  try {
    if (matches.length <= 1 || !center) return report;

    const picked = closestByCenter(matches, center);
    if (!picked) return report;

    const axis = planeAxis(plane);
    // The pin's normal coordinate is the face's own plane, read from the face
    // at full precision. `containsPoint` allows 1e-6, and an offset that came
    // back through a Float32 mesh can be further out than that.
    const onPlane = readCenter(picked)?.[axis] ?? offset;

    for (const candidate of pinCandidates([center, interior], axis, onPlane)) {
      if (isolates(shape, plane, offset, candidate, picked)) {
        report.pin = candidate;
        break;
      }
    }
    return report;
  } finally {
    for (const m of matches) tryDelete(m);
  }
}

/** The finder a pinned or unpinned target resolves to. */
export function faceTargetFinder(
  plane: string,
  offset: number,
  pin?: Vec3,
): (f: FaceFinder) => FaceFinder {
  return (f) => {
    const planar = f.inPlane(plane as any, offset);
    return pin ? planar.containsPoint(pin) : planar;
  };
}

function closestByCenter(faces: Face[], center: Vec3): Face | null {
  let best: Face | null = null;
  let bestD = CENTER_TOLERANCE;
  for (const f of faces) {
    const c = readCenter(f);
    if (!c) continue;
    const d = Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function readCenter(face: Face): Vec3 | null {
  try {
    const c = face.center;
    return [c.x, c.y, c.z];
  } catch {
    return null;
  }
}

/**
 * Points to try, most readable first, with duplicates dropped. Each is the
 * source point snapped onto the face's plane and rounded in its other two
 * coordinates — a rounded point can land on a boundary or off the face
 * entirely, which is exactly why every candidate is verified rather than
 * trusted.
 */
function pinCandidates(sources: (Vec3 | undefined)[], axis: number, onPlane: number): Vec3[] {
  const out: Vec3[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    if (!src) continue;
    for (const digits of [1, 2, 3, null]) {
      const p = src.map((v, k) => {
        if (k === axis) return onPlane;
        if (digits === null) return v;
        const r = Number(v.toFixed(digits));
        // `-0` would be written as `0` anyway; keep the numbers equal to it.
        return r === 0 ? 0 : r;
      }) as Vec3;
      const key = p.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function isolates(
  shape: Shape3D,
  plane: string,
  offset: number,
  pin: Vec3,
  picked: Face,
): boolean {
  let found: Face[] = [];
  try {
    found = faceTargetFinder(plane, offset, pin)(new FaceFinder()).find(shape);
    return found.length === 1 && found[0]!.isSame(picked);
  } catch {
    return false;
  } finally {
    for (const f of found) tryDelete(f);
  }
}

function tryDelete(o: { delete?: () => void }): void {
  try {
    o.delete?.();
  } catch {
    /* freeing is best effort */
  }
}
