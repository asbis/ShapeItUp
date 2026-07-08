/**
 * Resolve the authoring-format `sim` block a shape file exports into the full
 * runtime SimSpec the stepper consumes.
 *
 * The authoring format (`SimSpecInput`) is deliberately terse: the user names
 * which parts are static/kinematic/dynamic by glob and declares joints +
 * actuators. It does NOT carry geometry — the viewer/MCP supply each rendered
 * part's rest-pose AABB (from tessellation) at resolve time. This keeps the
 * `.shape.ts` author writing intent ("needle-* is kinematic") while the runtime
 * fills in the bounding boxes.
 */

import { globToRegex } from "./collision";
import { linkageBodies } from "./linkages";
import type { Vec3 } from "./transform";
import type {
  Aabb,
  BodyKind,
  DynamicsOptions,
  Linkage,
  PoseTrack,
  SimActuator,
  SimAssertion,
  SimBody,
  SimJoint,
  SimMarker,
  SimSpec,
} from "./types";

/** The terse shape a `.shape.ts` file exports as `export const sim = {...}`. */
export interface SimSpecInput {
  /**
   * Engine selector. "kinematic" (default) plays scripted motion analytically.
   * "dynamic" runs the Rapier force solver (gravity/contacts) — also selected
   * automatically when any body is declared "dynamic".
   */
  mode?: "kinematic" | "dynamic";
  /**
   * Which solver runs the study. Omit for auto: the kinematic engine, or Rapier
   * when a `dynamic` body / `mode:"dynamic"` is present. "kinematic" forces the
   * analytic engine; "rapier" and "mujoco" force that force-based backend even
   * for all-scripted scenes (MuJoCo brings native contacts between scripted
   * bodies + a richer actuator/contact model). See @shapeitup/sim-mujoco.
   */
  engine?: "kinematic" | "rapier" | "mujoco";
  /** Glob → kind. First matching rule (in declaration order) wins; unmatched parts default to "static". */
  bodies: Record<string, BodyKind>;
  joints?: SimJoint[];
  actuators?: SimActuator[];
  /** Glob → parent body id, so a needle can ride a moving carriage. */
  parents?: Record<string, string>;
  gravity?: Vec3;
  /** Seconds (default 2). */
  duration?: number;
  /** Seconds (default 1/240 ≈ 4.2 ms — fine enough for ms-scale solenoid ramps). */
  timestep?: number;
  acceptedPairs?: Array<[string, string]>;
  /** Bodies driven directly by a time-varying transform (closed-loop linkages). */
  poses?: PoseTrack[];
  /** Named local points whose world position the sim reports over time. */
  markers?: SimMarker[];
  /** Pass/fail self-test checks evaluated against the run. */
  assertions?: SimAssertion[];
  /** Closed-loop planar mechanisms (four-bar / slider-crank / gear). */
  linkages?: Linkage[];
  /** DYNAMICS engine tuning (CCD, solver iterations, collider types). */
  dynamics?: DynamicsOptions;
}

export interface ResolvedSim {
  spec: SimSpec;
  warnings: string[];
}

/** True if `value` looks like a usable sim authoring block. */
export function isSimSpecInput(value: unknown): value is SimSpecInput {
  return (
    !!value &&
    typeof value === "object" &&
    "bodies" in value &&
    typeof (value as SimSpecInput).bodies === "object" &&
    (value as SimSpecInput).bodies !== null
  );
}

const KINDS: BodyKind[] = ["static", "kinematic", "dynamic"];

/**
 * Expand `input` against the actual rendered parts. Every rendered part becomes
 * a body (so static frame parts still participate in collisions); joints and
 * actuators referencing unknown ids are dropped with a warning rather than
 * throwing, so a stale name in the sim block degrades gracefully.
 */
export function resolveSimSpec(
  input: SimSpecInput,
  parts: Array<{ name: string; aabb: Aabb }>,
): ResolvedSim {
  const warnings: string[] = [];
  // Defensive: tolerate a malformed block (non-array joints, etc.) without a
  // cryptic `.filter is not a function` — validateSimSpecInput is the real gate,
  // but resolve must degrade gracefully if called directly.
  const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
  const bodyRules = input.bodies && typeof input.bodies === "object" ? Object.entries(input.bodies) : [];
  const parentRules = input.parents && typeof input.parents === "object" ? Object.entries(input.parents) : [];
  const names = new Set(parts.map((p) => p.name));

  const bodies: SimBody[] = parts.map((p) => {
    let kind: BodyKind = "static";
    for (const [glob, k] of bodyRules) {
      if (globToRegex(glob).test(p.name)) {
        kind = KINDS.includes(k) ? k : "static";
        break;
      }
    }
    let parent: string | undefined;
    for (const [glob, pid] of parentRules) {
      if (globToRegex(glob).test(p.name)) {
        if (names.has(pid) && pid !== p.name) parent = pid;
        else if (!names.has(pid)) warnings.push(`sim: parent "${pid}" for "${p.name}" is not a rendered part — ignored.`);
        break;
      }
    }
    return { id: p.name, kind, aabb: p.aabb, parent };
  });

  const bodyIds = new Set(bodies.map((b) => b.id));
  const joints: SimJoint[] = arr<SimJoint>(input.joints).filter((j) => {
    if (!bodyIds.has(j.body)) {
      warnings.push(`sim: joint "${j.id}" targets unknown body "${j.body}" — dropped.`);
      return false;
    }
    return true;
  });

  const jointIds = new Set(joints.map((j) => j.id));
  const actuators: SimActuator[] = arr<SimActuator>(input.actuators).filter((a) => {
    if (!jointIds.has(a.joint)) {
      warnings.push(`sim: actuator "${a.id}" targets unknown joint "${a.joint}" — dropped.`);
      return false;
    }
    return true;
  });

  const poses: PoseTrack[] = arr<PoseTrack>(input.poses).filter((p) => {
    if (!bodyIds.has(p.body)) {
      warnings.push(`sim: pose track targets unknown body "${p.body}" — dropped.`);
      return false;
    }
    return true;
  });
  // A body driven by BOTH a pose track and joints: the track wins (poseAt uses
  // it); warn so the redundant joints aren't a silent surprise.
  const posedBodies = new Set(poses.map((p) => p.body));
  for (const j of joints) {
    if (posedBodies.has(j.body)) {
      warnings.push(`sim: body "${j.body}" has a pose track AND joint "${j.id}" — the pose track wins; the joint is ignored.`);
    }
  }
  // A pose track means the body moves — promote a default-static body to
  // kinematic so BOTH engines drive it (dynamics only drives kinematic bodies).
  for (const b of bodies) {
    if (posedBodies.has(b.id) && b.kind === "static") b.kind = "kinematic";
  }

  const markers: SimMarker[] = arr<SimMarker>(input.markers).filter((m) => {
    if (!bodyIds.has(m.body)) {
      warnings.push(`sim: marker "${m.name}" targets unknown body "${m.body}" — dropped.`);
      return false;
    }
    return true;
  });

  // Linkages: keep those whose bodies all exist; promote linkage bodies to
  // kinematic so the solver's poses actually drive them.
  const linkages: Linkage[] = arr<Linkage>(input.linkages).filter((lk) => {
    const missing = linkageBodies(lk).filter((id) => !bodyIds.has(id));
    if (missing.length > 0) {
      warnings.push(`sim: ${lk.kind} linkage references unknown bodies [${missing.join(", ")}] — dropped.`);
      return false;
    }
    return true;
  });
  const linkedBodies = new Set(linkages.flatMap((lk) => linkageBodies(lk)));
  for (const b of bodies) {
    if (linkedBodies.has(b.id) && b.kind === "static") b.kind = "kinematic";
  }

  const spec: SimSpec = {
    bodies,
    joints,
    actuators,
    gravity: input.gravity,
    duration: input.duration && input.duration > 0 ? input.duration : 2,
    timestep: input.timestep && input.timestep > 0 ? input.timestep : 1 / 240,
    acceptedPairs: input.acceptedPairs,
    poses: poses.length > 0 ? poses : undefined,
    markers: markers.length > 0 ? markers : undefined,
    assertions: input.assertions && input.assertions.length > 0 ? input.assertions : undefined,
    linkages: linkages.length > 0 ? linkages : undefined,
    dynamics: input.dynamics,
  };
  return { spec, warnings };
}
