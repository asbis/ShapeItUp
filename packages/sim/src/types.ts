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
  /** Piecewise-linear keyframes. Points need not be sorted. */
  | { kind: "keyframes"; points: Array<{ t: number; q: number }> }
  /** q = offset + amplitude·sin(2π·freq·t + phase). */
  | { kind: "sine"; amplitude: number; freq: number; phase?: number; offset?: number };

export interface SimActuator {
  id: string;
  joint: string;
  profile: Profile;
}

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

/** A single sampled frame: every body's world transform at time t. */
export interface SimFrame {
  t: number;
  /** body id → [px,py,pz, qx,qy,qz,qw] (position + quaternion). */
  poses: Record<string, [number, number, number, number, number, number, number]>;
}

export interface SimResult {
  frames: SimFrame[];
  collisions: CollisionEvent[];
  duration: number;
  timestep: number;
}
