/**
 * Simulation spec — the declarative description a `.shape.ts` file exports as
 * `export const sim = {...}`, plus the runtime event/state types the stepper
 * produces. All geometry is in the CAD frame (mm, Z-up).
 */

import type { Vec3 } from "./transform";

/**
 * How a body participates in the sim:
 *   - "static"    — never moves (the machine bed / frame).
 *   - "kinematic" — motion is *scripted* by an actuator profile, not derived
 *                   from forces. This is the whole Phase-1 vocabulary.
 *   - "dynamic"   — force-driven (gravity/contacts). Phase-3, needs a physics
 *                   engine + convex decomposition; declared here for forward
 *                   compat but the kinematic stepper treats it as static.
 */
export type BodyKind = "static" | "kinematic" | "dynamic";

/** Axis-aligned bounding box in the rest (t=0) world frame. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export interface SimBody {
  /** Stable id — matches a rendered part name (glob-expanded before it gets here). */
  id: string;
  kind: BodyKind;
  /** Rest-pose world AABB (from tessellation). Used for collision sweeps. */
  aabb: Aabb;
  /**
   * Optional parent body id. The body's world transform is composed onto its
   * parent's, so a needle riding a moving carriage tracks it automatically.
   */
  parent?: string;
}

/** A 1-DOF joint the actuator drives. Anchor + axis are world-space (mm). */
export interface SimJoint {
  id: string;
  /** Which body this joint moves. */
  body: string;
  type: "prismatic" | "revolute";
  /** World-space point the axis passes through (revolute) / direction origin. */
  anchor: Vec3;
  /** Unit-ish axis of translation (prismatic, mm) or rotation (revolute). */
  axis: Vec3;
  /**
   * Angle unit for a REVOLUTE joint's coordinate q: "rad" (default) or "deg".
   * Prismatic joints are always mm and ignore this. Set `"deg"` if your
   * profile targets/velocities are in degrees (avoids the "target: 90 actually
   * means 90 radians ≈ 14 turns" trap). Ignored for prismatic.
   */
  unit?: "rad" | "deg";
  /**
   * DYNAMICS only: when this joint is on a `dynamic` body it becomes a real
   * Rapier constraint (to its parent body, else grounded at `anchor`). If it
   * also has an actuator, a PD motor drives it toward the profile — `motor`
   * tunes that (stiffness/damping bound the force; no separate max-force in the
   * JS binding). Without an actuator the joint is a free constraint the body
   * swings/slides on (e.g. a cam pushing a pinned follower).
   */
  motor?: { stiffness?: number; damping?: number; mode?: "position" | "velocity" };
}

/** DYNAMICS engine tuning (Rapier). All optional. */
export interface DynamicsOptions {
  /** Continuous collision detection on dynamic bodies (default true) — stops thin/fast parts tunneling. */
  ccd?: boolean;
  /** Rapier solver iterations — raise for stiff/constrained mechanisms (default engine value). */
  solverIterations?: number;
  /**
   * Per-dynamic-body collider type by glob: "hull" (convex hull, default —
   * safe/stable), "trimesh" (exact concave surface, but no interior: only for
   * kinematic-driven or lightly-loaded parts), or "cuboid" (AABB box).
   */
  colliders?: Record<string, "hull" | "trimesh" | "cuboid">;
}

/**
 * One keyframe of a pose track: a full rigid transform of a body at time `t`
 * (seconds). Orientation is optional — give a `quaternion` [x,y,z,w] OR the
 * ergonomic `axisAngle` (degrees); omit both for no rotation.
 */
export interface PoseSample {
  t: number;
  /** Local translation (mm), composed onto the body's parent. */
  position: Vec3;
  quaternion?: [number, number, number, number];
  axisAngle?: { axis: Vec3; deg: number };
}

/**
 * Drive a body directly with an arbitrary time-varying rigid transform, in ONE
 * entry — instead of stacking 3 joints to fake a linkage. This is the P0
 * escape hatch for closed-loop mechanisms (four-bar couplers, slider-cranks):
 * solve the loop closure however you like and hand the resulting pose track
 * here. A body with a pose track ignores any joints targeting it.
 */
export interface PoseTrack {
  body: string;
  samples: PoseSample[];
}

/**
 * A named point rigidly attached to a body (local coordinates, mm). The sim can
 * report its world position over time — the trivial way to check "does the
 * linkage stay connected?" (two markers whose distance must stay constant) or
 * "where did the pin end up?".
 */
export interface SimMarker {
  name: string;
  body: string;
  point: Vec3;
}

/**
 * Actuator profile → joint coordinate q(t). q is millimetres (prismatic) or
 * radians (revolute). `t` is seconds.
 */
export type Profile =
  /** Constant velocity: q = v·max(0, t − delay). v in units/sec. */
  | { kind: "velocity"; v: number; delayMs?: number }
  /**
   * Solenoid-style move to a target: holds `from` until `delayMs` (the coil's
   * response lag), then ramps to `target` over `rampMs` (the pull-in time),
   * then holds. `easing: "smooth"` uses smoothstep for a soft seat.
   */
  | {
      kind: "position";
      target: number;
      rampMs: number;
      delayMs?: number;
      from?: number;
      easing?: "linear" | "smooth";
    }
  /**
   * Keyframes. Points need not be sorted. `interp` picks the interpolation
   * between them: "linear" (default), "smoothstep" (eased ends per segment), or
   * "cubic" (Catmull-Rom — smooth velocity through the points).
   */
  | { kind: "keyframes"; points: Array<{ t: number; q: number }>; interp?: "linear" | "smoothstep" | "cubic" }
  /** q = offset + amplitude·sin(2π·freq·t + phase). */
  | { kind: "sine"; amplitude: number; freq: number; phase?: number; offset?: number }
  /**
   * First-order lag with dead time — models an actuator's inertia (e.g. a
   * solenoid's coil rise): holds `from` until `deadMs`, then approaches `target`
   * exponentially with time constant `tauMs` (reaches ~63% after one tau, ~95%
   * after three). The physically-honest version of `position`.
   */
  | { kind: "firstOrder"; target: number; tauMs: number; deadMs?: number; from?: number }
  /**
   * Rate-limited move: leaves `from` after `delayMs`, then travels toward
   * `target` at a constant `rate` (units/sec) and holds on arrival. Models a
   * max-speed drive / slew limit.
   */
  | { kind: "slew"; target: number; rate: number; from?: number; delayMs?: number }
  /**
   * Servo move — rate-limited at `slewDegPerS` (interpreted in the joint's unit
   * per second; name a revolute joint `unit: "deg"` to make this literal deg/s).
   * Same math as `slew`, clearer intent for a positioning servo.
   */
  | { kind: "servo"; target: number; slewDegPerS: number; from?: number; delayMs?: number };

export interface SimActuator {
  id: string;
  joint: string;
  profile: Profile;
}

/**
 * Which plane a planar linkage is solved in. Bodies must be modelled as bars
 * along their LOCAL +X of the declared length; the solver rotates them about the
 * plane normal (Z for "XY", Y for "XZ") and translates them into place.
 */
export type LinkagePlane = "XY" | "XZ";

/**
 * A four-bar linkage: two ground pivots A,D; a driven `crank` (A→B), a `coupler`
 * (B→C), and a `rocker` (D→C). The solver computes B from the crank angle and C
 * from the circle–circle intersection, so the loop stays closed automatically —
 * no manual pose-track. `config` picks the assembly branch.
 */
export interface FourBarLinkage {
  kind: "fourBar";
  plane?: LinkagePlane;
  /** World positions of the two fixed pivots [A, D]. */
  ground: [Vec3, Vec3];
  crank: { body: string; length: number };
  coupler: { body: string; length: number };
  rocker: { body: string; length: number };
  /** Drives the crank angle q(t) (radians, or degrees if `unit: "deg"`). */
  driver: Profile;
  unit?: "rad" | "deg";
  config?: "open" | "crossed";
}

/**
 * A slider-crank: ground pivot A, driven `crank` (A→B), `coupler` (B→C), and a
 * `slider` translating along `axis` (in-plane, line through A). C is the
 * circle–line intersection.
 */
export interface SliderCrankLinkage {
  kind: "sliderCrank";
  plane?: LinkagePlane;
  ground: Vec3;
  crank: { body: string; length: number };
  coupler: { body: string; length: number };
  slider: { body: string; axis: Vec3 };
  driver: Profile;
  unit?: "rad" | "deg";
  config?: "open" | "crossed";
}

/** A gear pair: `follower` rotates about its centre at −ratio × the driver angle. */
export interface GearLinkage {
  kind: "gear";
  plane?: LinkagePlane;
  driver: { body: string; center: Vec3; profile: Profile; unit?: "rad" | "deg" };
  follower: { body: string; center: Vec3 };
  ratio: number;
}

export type Linkage = FourBarLinkage | SliderCrankLinkage | GearLinkage;

export interface SimSpec {
  bodies: SimBody[];
  joints: SimJoint[];
  actuators: SimActuator[];
  /** Gravity (mm/s²). Only used at Phase-3 dynamics; ignored by kinematics. */
  gravity?: Vec3;
  /** Total sim length (seconds). */
  duration: number;
  /** Fixed timestep (seconds). Fixed for reproducible, replayable studies. */
  timestep: number;
  /**
   * Body-id glob pairs whose overlap is expected (press-fits, a needle
   * resting in its slot) and must NOT be reported as a collision. Mirrors the
   * existing `expectedContacts` convention.
   */
  acceptedPairs?: Array<[string, string]>;
  /** Bodies driven directly by a time-varying transform (closed-loop linkages). */
  poses?: PoseTrack[];
  /** Named local points whose world position the sim can report over time. */
  markers?: SimMarker[];
  /** Pass/fail checks the tool evaluates against the run and prints. */
  assertions?: SimAssertion[];
  /** Closed-loop planar mechanisms solved automatically (four-bar / slider-crank / gear). */
  linkages?: Linkage[];
  /** DYNAMICS engine tuning (CCD, solver iterations, per-body collider type). */
  dynamics?: DynamicsOptions;
}

/**
 * A pass/fail check a shape can colocate in its `sim` block to self-test a
 * design headlessly (the tool prints the verdicts). All are evaluated against
 * the recorded run.
 */
export type SimAssertion =
  /** Passes when NO collision occurs between the two bodies (glob names). */
  | { name: string; kind: "noCollision"; a: string; b: string }
  /**
   * Checks the distance between two markers across the whole run — use to
   * verify a rigid link never stretches (`equals` + `tol`) or stays within a
   * range (`min`/`max`).
   */
  | {
      name: string;
      kind: "markerDistance";
      markerA: string;
      markerB: string;
      equals?: number;
      min?: number;
      max?: number;
      tol?: number;
    }
  /** Passes when `marker` comes within `tol` mm of `point` (optionally by `byMs`). */
  | { name: string; kind: "markerReaches"; marker: string; point: Vec3; tol?: number; byMs?: number };

/** Outcome of one assertion after evaluating a run. */
export interface AssertionResult {
  name: string;
  kind: SimAssertion["kind"];
  pass: boolean;
  detail: string;
}

/** One detected collision between two bodies, with the time it began. */
export interface CollisionEvent {
  a: string;
  b: string;
  /** Sim time (seconds) of first detected overlap. */
  tStart: number;
  /** Overlap volume (mm³) at tStart — a rough severity proxy. */
  overlapVolume: number;
}

/**
 * A window during which two bodies were in contact. A pair that separates and
 * re-collides (e.g. an end-stop hit on the return stroke) yields several — unlike
 * `collisions`, which records only the first onset.
 */
export interface ContactInterval {
  a: string;
  b: string;
  /** Sim time (seconds) contact began. */
  start: number;
  /** Sim time (seconds) contact ended (= duration if still in contact at the end). */
  end: number;
}

/** A single sampled frame: every body's world transform at time t. */
export interface SimFrame {
  t: number;
  /** body id → [px,py,pz, qx,qy,qz,qw] (position + quaternion). */
  poses: Record<string, [number, number, number, number, number, number, number]>;
}

export interface SimResult {
  frames: SimFrame[];
  collisions: CollisionEvent[];
  /** Contact windows per pair (a pair may appear more than once). Kinematic engine only. */
  contactIntervals?: ContactInterval[];
  duration: number;
  timestep: number;
}
