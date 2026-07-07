/**
 * DynamicsSim — force-based simulation via Rapier (WASM).
 *
 * Where the Phase-1 KinematicSim moves parts along scripted profiles, this runs
 * a real rigid-body solver: dynamic bodies fall under gravity and rest/tumble on
 * contact, while kinematic bodies (carriage, solenoid needles) are still driven
 * by their actuator profiles — and can now SHOVE dynamic bodies. It produces the
 * exact same SimResult (frames + collisions) the kinematic engine does, so the
 * viewer and MCP consume both identically.
 *
 * Batch-4 additions for constrained mechanisms: CCD (no tunneling), tunable
 * solver iterations, per-body collider choice, and REAL joints + motors on
 * dynamic bodies — so a cam can physically drive a pinned follower, or a servo
 * motor can drive a joint toward a target.
 *
 * Units: CAD is millimetres; Rapier is tuned for SI metres, so we scale mm→m in
 * and m→mm out (the SimFrame bridge, applied at the physics boundary). Axes
 * unchanged (CAD Z-up → gravity along −Z). Rapier JS is NOT deterministic, so we
 * RECORD the trajectory and treat that as the artifact.
 */

import RAPIER from "@dimforge/rapier3d-compat";
import {
  KinematicSim,
  evaluateProfile,
  globToRegex,
  isAcceptedPair,
  rotate,
  type CollisionEvent,
  type Profile,
  type Quat,
  type SimResult,
  type SimSpec,
  type Vec3,
} from "@shapeitup/sim";

const MM_TO_M = 0.001;
const M_TO_MM = 1000;
const DEG = Math.PI / 180;

export interface MeshData {
  /** Flattened world-space vertices (mm): [x,y,z, x,y,z, ...]. */
  vertices: Float32Array;
  /** Triangle indices into `vertices`. */
  indices: Uint32Array;
}

let rapierReady: Promise<void> | null = null;
function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const centreOf = (b: { aabb: { min: Vec3; max: Vec3 } }): Vec3 => [
  (b.aabb.min[0] + b.aabb.max[0]) / 2,
  (b.aabb.min[1] + b.aabb.max[1]) / 2,
  (b.aabb.min[2] + b.aabb.max[2]) / 2,
];

const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Run a force-based simulation and return recorded frames + first-contact
 * collision events (same shape as KinematicSim.run()).
 */
export async function runDynamics(
  spec: SimSpec,
  meshes: Map<string, MeshData>,
): Promise<SimResult> {
  await initRapier();

  const opts = spec.dynamics ?? {};
  const ccd = opts.ccd ?? true;

  const g = spec.gravity ?? [0, 0, -9810];
  const world = new RAPIER.World({ x: g[0] * MM_TO_M, y: g[1] * MM_TO_M, z: g[2] * MM_TO_M });
  world.timestep = spec.timestep;
  if (opts.solverIterations && opts.solverIterations > 0) {
    world.numSolverIterations = Math.round(opts.solverIterations);
  }

  const kin = new KinematicSim(spec);

  interface Handle {
    id: string;
    body: RAPIER.RigidBody;
    /** Body-origin offset (mm): centroid for dynamic, [0,0,0] for static/kinematic. */
    offset: Vec3;
    kind: SimSpec["bodies"][number]["kind"];
  }
  const handles: Handle[] = [];
  const byId = new Map<string, Handle>();
  const colliderToName = new Map<number, string>();

  /** Which collider type to use for a dynamic body (glob rules → default hull). */
  const dynColliderType = (id: string): "hull" | "trimesh" | "cuboid" => {
    const rules = opts.colliders;
    if (rules) {
      for (const [glob, type] of Object.entries(rules)) {
        if (globToRegex(glob).test(id)) return type;
      }
    }
    return "hull";
  };

  for (const b of spec.bodies) {
    const mesh = meshes.get(b.id);
    let offset: Vec3 = [0, 0, 0];
    let desc: RAPIER.RigidBodyDesc;

    if (b.kind === "dynamic") {
      offset = centreOf(b);
      desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(offset[0] * MM_TO_M, offset[1] * MM_TO_M, offset[2] * MM_TO_M)
        .setCcdEnabled(ccd);
    } else if (b.kind === "kinematic") {
      desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    } else {
      desc = RAPIER.RigidBodyDesc.fixed();
    }
    const body = world.createRigidBody(desc);

    // ── Collider ──────────────────────────────────────────────────────────
    const half: Vec3 = [
      ((b.aabb.max[0] - b.aabb.min[0]) / 2) * MM_TO_M,
      ((b.aabb.max[1] - b.aabb.min[1]) / 2) * MM_TO_M,
      ((b.aabb.max[2] - b.aabb.min[2]) / 2) * MM_TO_M,
    ];
    const cuboidLocal = () =>
      RAPIER.ColliderDesc.cuboid(Math.max(half[0], 1e-4), Math.max(half[1], 1e-4), Math.max(half[2], 1e-4));
    const relVerts = (): Float32Array => {
      const out = new Float32Array(mesh!.vertices.length);
      for (let i = 0; i < mesh!.vertices.length; i += 3) {
        out[i] = (mesh!.vertices[i] - offset[0]) * MM_TO_M;
        out[i + 1] = (mesh!.vertices[i + 1] - offset[1]) * MM_TO_M;
        out[i + 2] = (mesh!.vertices[i + 2] - offset[2]) * MM_TO_M;
      }
      return out;
    };

    let collDesc: RAPIER.ColliderDesc | null = null;
    if (b.kind === "dynamic") {
      const type = dynColliderType(b.id);
      if (type === "cuboid") {
        collDesc = cuboidLocal().setDensity(1000);
      } else if (type === "trimesh" && mesh && mesh.vertices.length >= 9 && mesh.indices.length >= 3) {
        collDesc = RAPIER.ColliderDesc.trimesh(relVerts(), mesh.indices);
        // A trimesh has no interior → no computed mass. Give it a sane mass from
        // the AABB so it doesn't behave as massless.
        const massKg = Math.max(8 * half[0] * half[1] * half[2] * 1000, 1e-4);
        collDesc.setMass(massKg);
      } else {
        // hull (default), or trimesh fallback when geometry is missing.
        if (mesh && mesh.vertices.length >= 9) collDesc = RAPIER.ColliderDesc.convexHull(relVerts());
        if (!collDesc) collDesc = cuboidLocal();
        // A realistic density (≈ plastic/metal, kg/m³) so a small mm-scale part
        // has sane mass — the default (1 ≈ air) makes contact response explode.
        collDesc.setDensity(1000);
      }
    } else if (mesh && mesh.vertices.length >= 9 && mesh.indices.length >= 3) {
      const verts = new Float32Array(mesh.vertices.length);
      for (let i = 0; i < mesh.vertices.length; i++) verts[i] = mesh.vertices[i] * MM_TO_M;
      collDesc = RAPIER.ColliderDesc.trimesh(verts, mesh.indices);
    } else {
      const c = centreOf(b);
      collDesc = cuboidLocal().setTranslation(c[0] * MM_TO_M, c[1] * MM_TO_M, c[2] * MM_TO_M);
    }

    collDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = world.createCollider(collDesc, body);
    colliderToName.set(collider.handle, b.id);
    const handle: Handle = { id: b.id, body, offset, kind: b.kind };
    handles.push(handle);
    byId.set(b.id, handle);
  }

  // ── Joints on dynamic bodies (real Rapier constraints + optional motors) ──
  const parentOf = new Map(spec.bodies.map((b) => [b.id, b.parent]));
  const actuatorByJoint = new Map(spec.actuators.map((a) => [a.joint, a]));
  interface MotorRef {
    joint: RAPIER.ImpulseJoint;
    revolute: boolean;
    unit: "rad" | "deg" | undefined;
    profile: Profile;
    mode: "position" | "velocity";
    stiffness: number;
    damping: number;
  }
  const motors: MotorRef[] = [];
  const vec = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });

  for (const j of spec.joints) {
    const dyn = byId.get(j.body);
    if (!dyn || dyn.kind !== "dynamic") continue; // only dynamic joints become constraints

    // The other side: the parent body if present, else a fresh grounded anchor.
    const parentId = parentOf.get(j.body);
    let other = parentId ? byId.get(parentId) : undefined;
    if (!other) {
      const ground = world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(j.anchor[0] * MM_TO_M, j.anchor[1] * MM_TO_M, j.anchor[2] * MM_TO_M),
      );
      other = { id: `${j.id}#ground`, body: ground, offset: [...j.anchor] as Vec3, kind: "static" };
    }
    const a1: Vec3 = [
      (j.anchor[0] - other.offset[0]) * MM_TO_M,
      (j.anchor[1] - other.offset[1]) * MM_TO_M,
      (j.anchor[2] - other.offset[2]) * MM_TO_M,
    ];
    const a2: Vec3 = [
      (j.anchor[0] - dyn.offset[0]) * MM_TO_M,
      (j.anchor[1] - dyn.offset[1]) * MM_TO_M,
      (j.anchor[2] - dyn.offset[2]) * MM_TO_M,
    ];
    const axis = norm3(j.axis);
    const revolute = j.type === "revolute";
    const params = revolute
      ? RAPIER.JointData.revolute(vec(a1), vec(a2), vec(axis))
      : RAPIER.JointData.prismatic(vec(a1), vec(a2), vec(axis));
    const joint = world.createImpulseJoint(params, other.body, dyn.body, true);

    const act = actuatorByJoint.get(j.id);
    if (act) {
      motors.push({
        joint,
        revolute,
        unit: j.unit,
        profile: act.profile,
        mode: j.motor?.mode ?? "position",
        stiffness: j.motor?.stiffness ?? 1e4,
        damping: j.motor?.damping ?? 1e3,
      });
    }
  }

  // ── Output frame ──────────────────────────────────────────────────────────
  // worldPoint(mm) = Q·restPoint + t_out, with t_out = T·1000 − Q·offset.
  const recordFrame = (t: number): SimResult["frames"][number] => {
    const poses: SimResult["frames"][number]["poses"] = {};
    for (const h of handles) {
      const T = h.body.translation();
      const R = h.body.rotation();
      const q: Quat = [R.x, R.y, R.z, R.w];
      const qo = rotate(q, h.offset);
      poses[h.id] = [T.x * M_TO_MM - qo[0], T.y * M_TO_MM - qo[1], T.z * M_TO_MM - qo[2], q[0], q[1], q[2], q[3]];
    }
    return { t, poses };
  };

  const driveKinematics = (t: number) => {
    const poses = kin.poseAt(t);
    for (const h of handles) {
      if (h.body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
      const tf = poses.get(h.id);
      if (!tf) continue;
      h.body.setNextKinematicRotation({ x: tf.q[0], y: tf.q[1], z: tf.q[2], w: tf.q[3] });
      h.body.setNextKinematicTranslation({ x: tf.t[0] * MM_TO_M, y: tf.t[1] * MM_TO_M, z: tf.t[2] * MM_TO_M });
    }
  };

  const driveMotors = (t: number) => {
    for (const m of motors) {
      const raw = evaluateProfile(m.profile, t);
      // Revolute target: rad (deg→rad if declared). Prismatic target: mm→m.
      const target = m.revolute ? (m.unit === "deg" ? raw * DEG : raw) : raw * MM_TO_M;
      // Motor methods live on the Revolute/Prismatic (Unit) joint subtype.
      const uj = m.joint as unknown as RAPIER.UnitImpulseJoint;
      if (m.mode === "velocity") uj.configureMotorVelocity(target, m.damping);
      else uj.configureMotorPosition(target, m.stiffness, m.damping);
    }
  };

  const steps = Math.max(1, Math.round(spec.duration / spec.timestep));
  const eventQueue = new RAPIER.EventQueue(true);
  const frames: SimResult["frames"] = [recordFrame(0)];
  const firstContact = new Map<string, CollisionEvent>();

  for (let s = 1; s <= steps; s++) {
    const t = Math.min(spec.duration, s * spec.timestep);
    driveKinematics(t);
    driveMotors(t);
    world.step(eventQueue);

    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = colliderToName.get(h1);
      const b = colliderToName.get(h2);
      if (!a || !b || a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (firstContact.has(key)) return;
      if (isAcceptedPair(spec.acceptedPairs, a, b)) return;
      firstContact.set(key, { a, b, tStart: t, overlapVolume: 0 });
    });

    frames.push(recordFrame(t));
  }

  const collisions = [...firstContact.values()].sort((x, y) => x.tStart - y.tStart);
  eventQueue.free();
  world.free();

  return { frames, collisions, duration: spec.duration, timestep: spec.timestep };
}
