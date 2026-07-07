/**
 * Zod schema + validator for the authoring-format `sim` block.
 *
 * The point is discoverable, actionable errors: passing an object where a
 * `joints` array is expected used to blow up deep inside resolve with
 * `(input.joints ?? []).filter is not a function`. `validateSimSpecInput`
 * turns that into `sim.joints: Expected array, received object` up front.
 */

import { z } from "zod";
import type { SimSpecInput } from "./resolve";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const bodyKind = z.enum(["static", "kinematic", "dynamic"]);

const profile = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("velocity"), v: z.number(), delayMs: z.number().optional() }),
  z.object({
    kind: z.literal("position"),
    target: z.number(),
    rampMs: z.number(),
    delayMs: z.number().optional(),
    from: z.number().optional(),
    easing: z.enum(["linear", "smooth"]).optional(),
  }),
  z.object({
    kind: z.literal("keyframes"),
    points: z.array(z.object({ t: z.number(), q: z.number() })),
    interp: z.enum(["linear", "smoothstep", "cubic"]).optional(),
  }),
  z.object({ kind: z.literal("sine"), amplitude: z.number(), freq: z.number(), phase: z.number().optional(), offset: z.number().optional() }),
  z.object({ kind: z.literal("firstOrder"), target: z.number(), tauMs: z.number(), deadMs: z.number().optional(), from: z.number().optional() }),
  z.object({ kind: z.literal("slew"), target: z.number(), rate: z.number(), from: z.number().optional(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("servo"), target: z.number(), slewDegPerS: z.number(), from: z.number().optional(), delayMs: z.number().optional() }),
]);

const joint = z.object({
  id: z.string(),
  body: z.string(),
  type: z.enum(["prismatic", "revolute"]),
  anchor: vec3,
  axis: vec3,
  unit: z.enum(["rad", "deg"]).optional(),
  motor: z
    .object({
      stiffness: z.number().optional(),
      damping: z.number().optional(),
      mode: z.enum(["position", "velocity"]).optional(),
    })
    .optional(),
});

const actuator = z.object({ id: z.string(), joint: z.string(), profile });

const poseSample = z.object({
  t: z.number(),
  position: vec3,
  quaternion: quat.optional(),
  axisAngle: z.object({ axis: vec3, deg: z.number() }).optional(),
});
const poseTrack = z.object({ body: z.string(), samples: z.array(poseSample) });
const marker = z.object({ name: z.string(), body: z.string(), point: vec3 });

const assertion = z.discriminatedUnion("kind", [
  z.object({ name: z.string(), kind: z.literal("noCollision"), a: z.string(), b: z.string() }),
  z.object({
    name: z.string(),
    kind: z.literal("markerDistance"),
    markerA: z.string(),
    markerB: z.string(),
    equals: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    tol: z.number().optional(),
  }),
  z.object({ name: z.string(), kind: z.literal("markerReaches"), marker: z.string(), point: vec3, tol: z.number().optional(), byMs: z.number().optional() }),
]);

const linkPlane = z.enum(["XY", "XZ"]).optional();
const linkUnit = z.enum(["rad", "deg"]).optional();
const linkConfig = z.enum(["open", "crossed"]).optional();
const link = z.object({ body: z.string(), length: z.number() });
const linkage = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fourBar"),
    plane: linkPlane,
    ground: z.tuple([vec3, vec3]),
    crank: link,
    coupler: link,
    rocker: link,
    driver: profile,
    unit: linkUnit,
    config: linkConfig,
  }),
  z.object({
    kind: z.literal("sliderCrank"),
    plane: linkPlane,
    ground: vec3,
    crank: link,
    coupler: link,
    slider: z.object({ body: z.string(), axis: vec3 }),
    driver: profile,
    unit: linkUnit,
    config: linkConfig,
  }),
  z.object({
    kind: z.literal("gear"),
    plane: linkPlane,
    driver: z.object({ body: z.string(), center: vec3, profile, unit: linkUnit }),
    follower: z.object({ body: z.string(), center: vec3 }),
    ratio: z.number(),
  }),
]);

export const simSpecInputSchema = z.object({
  mode: z.enum(["kinematic", "dynamic"]).optional(),
  bodies: z.record(z.string(), bodyKind),
  joints: z.array(joint).optional(),
  actuators: z.array(actuator).optional(),
  parents: z.record(z.string(), z.string()).optional(),
  gravity: vec3.optional(),
  duration: z.number().positive().optional(),
  timestep: z.number().positive().optional(),
  acceptedPairs: z.array(z.tuple([z.string(), z.string()])).optional(),
  poses: z.array(poseTrack).optional(),
  markers: z.array(marker).optional(),
  assertions: z.array(assertion).optional(),
  linkages: z.array(linkage).optional(),
  dynamics: z
    .object({
      ccd: z.boolean().optional(),
      solverIterations: z.number().optional(),
      colliders: z.record(z.string(), z.enum(["hull", "trimesh", "cuboid"])).optional(),
    })
    .optional(),
});

export type ValidateResult =
  | { ok: true; value: SimSpecInput }
  | { ok: false; errors: string[] };

/**
 * Validate a raw `sim` export. On failure returns human-readable, path-anchored
 * messages (e.g. `sim.joints.0.axis: Expected array, received number`).
 */
export function validateSimSpecInput(raw: unknown): ValidateResult {
  const r = simSpecInputSchema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data as unknown as SimSpecInput };
  const errors = r.error.issues.map((i) => {
    const path = i.path.length ? `.${i.path.join(".")}` : "";
    return `sim${path}: ${i.message}`;
  });
  return { ok: false, errors };
}
