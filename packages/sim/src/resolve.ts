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
import type { Vec3 } from "./transform";
import type {
  Aabb,
  BodyKind,
  SimActuator,
  SimBody,
  SimJoint,
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
  const bodyRules = Object.entries(input.bodies);
  const parentRules = Object.entries(input.parents ?? {});
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
  const joints: SimJoint[] = (input.joints ?? []).filter((j) => {
    if (!bodyIds.has(j.body)) {
      warnings.push(`sim: joint "${j.id}" targets unknown body "${j.body}" — dropped.`);
      return false;
    }
    return true;
  });

  const jointIds = new Set(joints.map((j) => j.id));
  const actuators: SimActuator[] = (input.actuators ?? []).filter((a) => {
    if (!jointIds.has(a.joint)) {
      warnings.push(`sim: actuator "${a.id}" targets unknown joint "${a.joint}" — dropped.`);
      return false;
    }
    return true;
  });

  const spec: SimSpec = {
    bodies,
    joints,
    actuators,
    gravity: input.gravity,
    duration: input.duration && input.duration > 0 ? input.duration : 2,
    timestep: input.timestep && input.timestep > 0 ? input.timestep : 1 / 240,
    acceptedPairs: input.acceptedPairs,
  };
  return { spec, warnings };
}
