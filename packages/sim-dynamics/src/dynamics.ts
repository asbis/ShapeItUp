/**
 * DynamicsSim — Phase-3 force-based simulation via Rapier (WASM).
 *
 * Where the Phase-1 KinematicSim moves parts along scripted profiles, this runs
 * a real rigid-body solver: dynamic bodies fall under gravity and rest/tumble on
 * contact, while kinematic bodies (carriage, solenoid needles) are still driven
 * by their actuator profiles — and can now SHOVE dynamic bodies. It produces the
 * exact same SimResult (frames + collisions) the kinematic engine does, so the
 * viewer and MCP consume both identically.
 *
 * Lives in its own package so the heavy Rapier WASM only loads on the headless
 * (MCP/Node) side — the browser viewer's `@shapeitup/sim` import stays lean.
 *
 * Reproducibility: Rapier's JS/WASM is NOT cross-platform deterministic, so we
 * RECORD the trajectory (fixed timestep → frames) and treat that recording as
 * the artifact, rather than trusting a re-run to match.
 *
 * Units: the CAD frame is millimetres; Rapier is tuned for SI metres (its
 * sleeping/contact thresholds assume ~metre scales), so we scale mm→m on the way
 * in and m→mm on the way out. This is the SimFrame bridge, applied here at the
 * physics boundary. Axes are unchanged (CAD Z-up → gravity along −Z).
 */

import RAPIER from "@dimforge/rapier3d-compat";
import {
  KinematicSim,
  isAcceptedPair,
  rotate,
  type CollisionEvent,
  type Quat,
  type SimResult,
  type SimSpec,
  type Vec3,
} from "@shapeitup/sim";

const MM_TO_M = 0.001;
const M_TO_MM = 1000;

export interface MeshData {
  /** Flattened world-space vertices (mm): [x,y,z, x,y,z, ...]. */
  vertices: Float32Array;
  /** Triangle indices into `vertices`. */
  indices: Uint32Array;
}

let rapierReady: Promise<void> | null = null;
/** Init Rapier's WASM exactly once per process. */
function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

const centreOf = (b: { aabb: { min: Vec3; max: Vec3 } }): Vec3 => [
  (b.aabb.min[0] + b.aabb.max[0]) / 2,
  (b.aabb.min[1] + b.aabb.max[1]) / 2,
  (b.aabb.min[2] + b.aabb.max[2]) / 2,
];

/**
 * Run a force-based simulation and return recorded frames + first-contact
 * collision events (same shape as KinematicSim.run()).
 *
 * @param spec    Resolved sim spec (bodies carry rest-pose AABBs).
 * @param meshes  Per-body world-space triangle mesh (mm). Bodies without a mesh
 *                fall back to a cuboid collider derived from their AABB.
 */
export async function runDynamics(
  spec: SimSpec,
  meshes: Map<string, MeshData>,
): Promise<SimResult> {
  await initRapier();

  const g = spec.gravity ?? [0, 0, -9810];
  const world = new RAPIER.World({
    x: g[0] * MM_TO_M,
    y: g[1] * MM_TO_M,
    z: g[2] * MM_TO_M,
  });
  world.timestep = spec.timestep;

  // Drives kinematic bodies along their actuator profiles (reuses all the
  // joint/parent/actuator logic from the kinematic engine).
  const kin = new KinematicSim(spec);

  interface Handle {
    id: string;
    body: RAPIER.RigidBody;
    /** Centroid offset (mm) used to un-bake the collider frame on output. */
    offset: Vec3;
  }
  const handles: Handle[] = [];
  const colliderToName = new Map<number, string>();

  for (const b of spec.bodies) {
    const mesh = meshes.get(b.id);
    let desc: RAPIER.RigidBodyDesc;
    let offset: Vec3 = [0, 0, 0];

    if (b.kind === "dynamic") {
      // Dynamic bodies rotate about their geometry centroid, so create the body
      // there and express the collider RELATIVE to it.
      offset = centreOf(b);
      desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(
        offset[0] * MM_TO_M,
        offset[1] * MM_TO_M,
        offset[2] * MM_TO_M,
      );
    } else if (b.kind === "kinematic") {
      desc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    } else {
      desc = RAPIER.RigidBodyDesc.fixed();
    }
    const body = world.createRigidBody(desc);

    // Collider. Static/kinematic → trimesh (exact, but no interior → invalid for
    // dynamic bodies). Dynamic → convex hull of the geometry (research: raw
    // trimesh has no interior and things fall through / stick).
    let collDesc: RAPIER.ColliderDesc | null = null;
    if (b.kind === "dynamic") {
      if (mesh && mesh.vertices.length >= 9) {
        const pts = new Float32Array(mesh.vertices.length);
        for (let i = 0; i < mesh.vertices.length; i += 3) {
          pts[i] = (mesh.vertices[i] - offset[0]) * MM_TO_M;
          pts[i + 1] = (mesh.vertices[i + 1] - offset[1]) * MM_TO_M;
          pts[i + 2] = (mesh.vertices[i + 2] - offset[2]) * MM_TO_M;
        }
        collDesc = RAPIER.ColliderDesc.convexHull(pts);
      }
      if (!collDesc) {
        // Degenerate hull (or no mesh) → cuboid from AABB half-extents.
        const hx = ((b.aabb.max[0] - b.aabb.min[0]) / 2) * MM_TO_M;
        const hy = ((b.aabb.max[1] - b.aabb.min[1]) / 2) * MM_TO_M;
        const hz = ((b.aabb.max[2] - b.aabb.min[2]) / 2) * MM_TO_M;
        collDesc = RAPIER.ColliderDesc.cuboid(
          Math.max(hx, 1e-4),
          Math.max(hy, 1e-4),
          Math.max(hz, 1e-4),
        );
      }
    } else if (mesh && mesh.vertices.length >= 9 && mesh.indices.length >= 3) {
      const verts = new Float32Array(mesh.vertices.length);
      for (let i = 0; i < mesh.vertices.length; i++) verts[i] = mesh.vertices[i] * MM_TO_M;
      collDesc = RAPIER.ColliderDesc.trimesh(verts, mesh.indices);
    } else {
      // No mesh for a static/kinematic body → AABB cuboid placed at its centre.
      const c = centreOf(b);
      const hx = ((b.aabb.max[0] - b.aabb.min[0]) / 2) * MM_TO_M;
      const hy = ((b.aabb.max[1] - b.aabb.min[1]) / 2) * MM_TO_M;
      const hz = ((b.aabb.max[2] - b.aabb.min[2]) / 2) * MM_TO_M;
      collDesc = RAPIER.ColliderDesc.cuboid(
        Math.max(hx, 1e-4),
        Math.max(hy, 1e-4),
        Math.max(hz, 1e-4),
      ).setTranslation(c[0] * MM_TO_M, c[1] * MM_TO_M, c[2] * MM_TO_M);
    }

    collDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = world.createCollider(collDesc, body);
    colliderToName.set(collider.handle, b.id);
    handles.push({ id: b.id, body, offset });
  }

  // Output transform for a body: worldPoint(mm) = Q·restPoint + t_out.
  // Rapier gives T (m) + Q for a body whose collider was built at `offset`, so
  //   t_out = T·1000 − Q·offset.  (offset = 0 for static/kinematic ⇒ t_out = T·1000)
  const recordFrame = (t: number): SimResult["frames"][number] => {
    const poses: SimResult["frames"][number]["poses"] = {};
    for (const h of handles) {
      const T = h.body.translation();
      const R = h.body.rotation();
      const q: Quat = [R.x, R.y, R.z, R.w];
      const qo = rotate(q, h.offset);
      poses[h.id] = [
        T.x * M_TO_MM - qo[0],
        T.y * M_TO_MM - qo[1],
        T.z * M_TO_MM - qo[2],
        q[0],
        q[1],
        q[2],
        q[3],
      ];
    }
    return { t, poses };
  };

  // Drive kinematic bodies to their pose at time `t` (set as the NEXT kinematic
  // target so Rapier derives the right velocity for pushing dynamic bodies).
  const driveKinematics = (t: number) => {
    const poses = kin.poseAt(t);
    for (const h of handles) {
      const bt = h.body.bodyType();
      if (bt !== RAPIER.RigidBodyType.KinematicPositionBased) continue;
      const tf = poses.get(h.id);
      if (!tf) continue;
      h.body.setNextKinematicRotation({ x: tf.q[0], y: tf.q[1], z: tf.q[2], w: tf.q[3] });
      h.body.setNextKinematicTranslation({
        x: tf.t[0] * MM_TO_M,
        y: tf.t[1] * MM_TO_M,
        z: tf.t[2] * MM_TO_M,
      });
    }
  };

  const steps = Math.max(1, Math.round(spec.duration / spec.timestep));
  const eventQueue = new RAPIER.EventQueue(true);
  const frames: SimResult["frames"] = [recordFrame(0)];
  const firstContact = new Map<string, CollisionEvent>();

  for (let s = 1; s <= steps; s++) {
    const t = Math.min(spec.duration, s * spec.timestep);
    driveKinematics(t);
    world.step(eventQueue);

    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const a = colliderToName.get(h1);
      const b = colliderToName.get(h2);
      if (!a || !b || a === b) return;
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      if (firstContact.has(key)) return;
      if (isAcceptedPair(spec.acceptedPairs, a, b)) return;
      // overlapVolume isn't cheaply available from a contact event; report 0 as
      // a marker — dynamics collisions are contact-onset events, not overlap
      // volumes (the kinematic engine reports true AABB overlap volume).
      firstContact.set(key, { a, b, tStart: t, overlapVolume: 0 });
    });

    frames.push(recordFrame(t));
  }

  const collisions = [...firstContact.values()].sort((x, y) => x.tStart - y.tStart);
  eventQueue.free();
  world.free();

  return { frames, collisions, duration: spec.duration, timestep: spec.timestep };
}
