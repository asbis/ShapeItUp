/**
 * Planar linkage solver — closed-loop mechanisms whose pose can't be reached by
 * driving one independent joint (four-bar couplers, slider-cranks, gear pairs).
 *
 * Rather than an iterative constraint solver, these have closed-form 2D
 * solutions (circle–circle / circle–line intersection), so the result is exact
 * and deterministic. The convention: each link BODY is modelled as a bar from
 * its local origin along +X of the declared length; the solver rotates it about
 * the plane normal and translates it so the loop stays closed. That's the P0 fix
 * — a four-bar coupler is now ONE `linkages` entry instead of three stacked
 * joints with hand-solved loop closure.
 */

import { evaluateProfile } from "./actuators";
import {
  add,
  dot,
  normalize,
  quatFromAxisAngle,
  rotationAbout,
  scale,
  sub,
  type Transform,
  type Vec3,
} from "./transform";
import type {
  FourBarLinkage,
  GearLinkage,
  Linkage,
  LinkagePlane,
  Profile,
  SliderCrankLinkage,
} from "./types";

const DEG = Math.PI / 180;
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const planeNormal = (p: LinkagePlane): Vec3 => (p === "XZ" ? [0, 1, 0] : [0, 0, 1]);
const planeAxes = (p: LinkagePlane): [Vec3, Vec3] =>
  p === "XZ" ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];

const to2D = (p: Vec3, o: Vec3, u: Vec3, v: Vec3): [number, number] => {
  const d = sub(p, o);
  return [dot(d, u), dot(d, v)];
};
const from2D = (a: number, b: number, o: Vec3, u: Vec3, v: Vec3): Vec3 =>
  add(o, add(scale(a, u), scale(b, v)));

/** Rigid transform mapping local +X (from the origin) onto the world segment P→Q. */
function segmentTransform(P: Vec3, Q: Vec3, n: Vec3): Transform {
  const dir = normalize(sub(Q, P));
  const X: Vec3 = [1, 0, 0];
  const angle = Math.atan2(dot(n, cross(X, dir)), dot(X, dir));
  return { q: quatFromAxisAngle(n, angle), t: [P[0], P[1], P[2]] };
}

/**
 * Intersection of two circles (2D). Clamps to the reachable limit rather than
 * returning NaN when the linkage can't close (a bad length combo just pins at
 * full extension instead of exploding).
 */
function circleCircle(
  c1: [number, number],
  r1: number,
  c2: [number, number],
  r2: number,
  config: "open" | "crossed",
): [number, number] {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy) || 1e-9;
  const a = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  let h2 = r1 * r1 - a * a;
  if (h2 < 0) h2 = 0;
  const h = Math.sqrt(h2);
  const xm = c1[0] + (a * dx) / d;
  const ym = c1[1] + (a * dy) / d;
  const s = config === "crossed" ? -1 : 1;
  return [xm - (s * h * dy) / d, ym + (s * h * dx) / d];
}

const driverAngle = (profile: Profile, unit: "rad" | "deg" | undefined, t: number): number => {
  const raw = evaluateProfile(profile, t);
  return unit === "deg" ? raw * DEG : raw;
};

function solveFourBar(lk: FourBarLinkage, t: number): Map<string, Transform> {
  const plane = lk.plane ?? "XY";
  const n = planeNormal(plane);
  const [u, v] = planeAxes(plane);
  const A = lk.ground[0];
  const D = lk.ground[1];
  const D2 = to2D(D, A, u, v);
  const th = driverAngle(lk.driver, lk.unit, t);
  const B2: [number, number] = [lk.crank.length * Math.cos(th), lk.crank.length * Math.sin(th)];
  const C2 = circleCircle(B2, lk.coupler.length, D2, lk.rocker.length, lk.config ?? "open");
  const B = from2D(B2[0], B2[1], A, u, v);
  const C = from2D(C2[0], C2[1], A, u, v);
  const m = new Map<string, Transform>();
  m.set(lk.crank.body, segmentTransform(A, B, n));
  m.set(lk.coupler.body, segmentTransform(B, C, n));
  m.set(lk.rocker.body, segmentTransform(D, C, n));
  return m;
}

function solveSliderCrank(lk: SliderCrankLinkage, t: number): Map<string, Transform> {
  const plane = lk.plane ?? "XY";
  const n = planeNormal(plane);
  const [u, v] = planeAxes(plane);
  const A = lk.ground;
  const axisRaw: [number, number] = [dot(lk.slider.axis, u), dot(lk.slider.axis, v)];
  const al = Math.hypot(axisRaw[0], axisRaw[1]) || 1e-9;
  const a2: [number, number] = [axisRaw[0] / al, axisRaw[1] / al];

  // C is where the coupler circle meets the slider line s·a2 (line through A).
  const solve = (tt: number): { B2: [number, number]; C2: [number, number] } => {
    const th = driverAngle(lk.driver, lk.unit, tt);
    const B2: [number, number] = [lk.crank.length * Math.cos(th), lk.crank.length * Math.sin(th)];
    const adotB = a2[0] * B2[0] + a2[1] * B2[1];
    const bSq = B2[0] * B2[0] + B2[1] * B2[1];
    let disc = adotB * adotB - (bSq - lk.coupler.length * lk.coupler.length);
    if (disc < 0) disc = 0;
    const s = adotB + (lk.config === "crossed" ? -1 : 1) * Math.sqrt(disc);
    return { B2, C2: [s * a2[0], s * a2[1]] };
  };

  const now = solve(t);
  const zero = solve(0);
  const B = from2D(now.B2[0], now.B2[1], A, u, v);
  const C = from2D(now.C2[0], now.C2[1], A, u, v);
  const C0 = from2D(zero.C2[0], zero.C2[1], A, u, v);
  const m = new Map<string, Transform>();
  m.set(lk.crank.body, segmentTransform(A, B, n));
  m.set(lk.coupler.body, segmentTransform(B, C, n));
  // The slider translates along its axis from its rest position (C at t=0).
  m.set(lk.slider.body, { q: [0, 0, 0, 1], t: sub(C, C0) });
  return m;
}

function solveGear(lk: GearLinkage, t: number): Map<string, Transform> {
  const n = planeNormal(lk.plane ?? "XY");
  const th = driverAngle(lk.driver.profile, lk.driver.unit, t);
  const m = new Map<string, Transform>();
  m.set(lk.driver.body, rotationAbout(lk.driver.center, n, th));
  m.set(lk.follower.body, rotationAbout(lk.follower.center, n, -lk.ratio * th));
  return m;
}

/** Solve one linkage at time `t` → each moving body's world transform. */
export function linkageTransforms(lk: Linkage, t: number): Map<string, Transform> {
  if (lk.kind === "fourBar") return solveFourBar(lk, t);
  if (lk.kind === "sliderCrank") return solveSliderCrank(lk, t);
  return solveGear(lk, t);
}

/** Body ids a linkage drives (for wiring + validation). */
export function linkageBodies(lk: Linkage): string[] {
  if (lk.kind === "fourBar") return [lk.crank.body, lk.coupler.body, lk.rocker.body];
  if (lk.kind === "sliderCrank") return [lk.crank.body, lk.coupler.body, lk.slider.body];
  return [lk.driver.body, lk.follower.body];
}
