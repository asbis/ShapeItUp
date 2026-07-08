/**
 * MujocoSim — force-based simulation via MuJoCo (WASM).
 *
 * A drop-in sibling of `@shapeitup/sim-dynamics`'s `runDynamics`: same signature
 * `(spec, meshes) → SimResult`, same units bridge (mm↔m), same "record the
 * trajectory as the artifact" philosophy. It builds an MJCF document from the
 * SimSpec (see mjcf.ts), steps MuJoCo, drives kinematic bodies from the scripted
 * KinematicSim and dynamic-joint actuators from their profiles, and reads body
 * world poses back each frame.
 *
 * Why MuJoCo alongside Rapier: a far richer actuator/contact model and native
 * closed-loop constraints — the things ShapeItUp's mechanism work (knitting
 * carriage, linkages, selection) actually needs. This is the Phase-0/1 vertical
 * slice: AABB-box geoms, hinge/slide joints, position/velocity actuators.
 *
 * MuJoCo quaternions are [w,x,y,z]; SimFrame poses are [x,y,z, qx,qy,qz,qw], so
 * we reorder on the way out.
 */
import {
  KinematicSim,
  apply,
  evaluateProfile,
  isAcceptedPair,
  rotate,
  type CollisionEvent,
  type Quat,
  type SimResult,
  type SimSpec,
  type Vec3,
} from "@shapeitup/sim";
import { loadMujocoModule } from "./loader";
import { buildMjcf } from "./mjcf";
import type { MeshData } from "./mesh";

const M_TO_MM = 1000;
const MM_TO_M = 0.001;
const DEG = Math.PI / 180;

export async function runMujoco(spec: SimSpec, meshes: Map<string, MeshData>): Promise<SimResult> {
  const mj = await loadMujocoModule();
  const build = buildMjcf(spec, meshes);

  const model = mj.MjModel.from_xml_string(build.xml);
  const data = new mj.MjData(model);

  try {
    // ── Resolve MuJoCo ids we need for read-back and contact mapping ────────
    // MuJoCo body id → ShapeItUp body id (0 is "world", skip).
    const simIdByBodyId = new Map<number, string>();
    const bodyIdBySimId = new Map<string, number>();
    for (const [mjName, simId] of build.simIdByMjName) {
      const acc = data.body(mjName);
      const bid: number = acc.id;
      acc.delete?.();
      simIdByBodyId.set(bid, simId);
      bodyIdBySimId.set(simId, bid);
    }
    // geom id → owning MuJoCo body id (flat array on the model).
    const geomBodyId: ArrayLike<number> = model.geom_bodyid;

    // Rest-pose world centre (mm) of each body. In the MJCF each geom is centred
    // on its body origin and the body is placed at this centre, so MuJoCo's xpos
    // tracks the centre. SimFrame poses, however, are DELTAS from rest applied to
    // rest-WORLD coordinates (frame 0 must be identity) — so we output
    //   t_out = xpos − q·centre,  q = xquat
    // exactly as the Rapier engine does with its per-body offset.
    const centreOf = (b: SimSpec["bodies"][number]): Vec3 => [
      (b.aabb.min[0] + b.aabb.max[0]) / 2,
      (b.aabb.min[1] + b.aabb.max[1]) / 2,
      (b.aabb.min[2] + b.aabb.max[2]) / 2,
    ];
    const centreById = new Map(spec.bodies.map((b) => [b.id, centreOf(b)]));

    const kin = new KinematicSim(spec);
    const kinematicIds = new Set(spec.bodies.filter((b) => b.kind === "kinematic").map((b) => b.id));
    type Pose = { t: Vec3; q: Quat };

    // ── Read one frame ──────────────────────────────────────────────────────
    // Kinematic bodies are weld-driven dynamic bodies (so they generate
    // contacts), but their INTENDED motion is the exact script — so we output
    // the KinematicSim delta directly for them (pixel-exact, no weld lag), and
    // read the live xpos/xquat views for genuinely dynamic/static bodies.
    const recordFrame = (t: number, kinPoses: Map<string, Pose> | null): SimResult["frames"][number] => {
      const xpos: ArrayLike<number> = data.xpos; // [nbody*3], metres
      const xquat: ArrayLike<number> = data.xquat; // [nbody*4], (w,x,y,z)
      const poses: SimResult["frames"][number]["poses"] = {};
      for (const b of spec.bodies) {
        if (kinematicIds.has(b.id)) {
          const tf = kinPoses?.get(b.id);
          if (tf) {
            poses[b.id] = [tf.t[0], tf.t[1], tf.t[2], tf.q[0], tf.q[1], tf.q[2], tf.q[3]];
            continue;
          }
        }
        const bid = bodyIdBySimId.get(b.id);
        if (bid == null) continue;
        const p = bid * 3;
        const w = bid * 4;
        const q: Quat = [xquat[w + 1], xquat[w + 2], xquat[w + 3], xquat[w]]; // (x,y,z,w)
        const centre = centreById.get(b.id)!;
        const qo = rotate(q, centre); // q·centre (mm)
        poses[b.id] = [
          xpos[p] * M_TO_MM - qo[0],
          xpos[p + 1] * M_TO_MM - qo[1],
          xpos[p + 2] * M_TO_MM - qo[2],
          q[0],
          q[1],
          q[2],
          q[3],
        ];
      }
      return { t, poses };
    };

    // ── Drive scripted kinematic mocap TARGETS from the KinematicSim ────────
    // (the welded dynamic bodies then track these targets — see mjcf.ts).
    const driveMocap = (poses: Map<string, Pose>) => {
      if (build.mocapOrder.length === 0) return;
      const mpos = data.mocap_pos; // [nmocap*3]
      const mquat = data.mocap_quat; // [nmocap*4], (w,x,y,z)
      for (let i = 0; i < build.mocapOrder.length; i++) {
        const id = build.mocapOrder[i];
        const tf = poses.get(id);
        if (!tf) continue;
        // poseAt gives a DELTA from rest; the mocap geom is centred at its origin
        // placed at the rest centre, so the absolute origin pose is apply(tf, centre).
        const centre = centreById.get(id)!;
        const world = apply(tf, centre); // absolute world centre (mm)
        mpos[i * 3] = world[0] * MM_TO_M;
        mpos[i * 3 + 1] = world[1] * MM_TO_M;
        mpos[i * 3 + 2] = world[2] * MM_TO_M;
        mquat[i * 4] = tf.q[3]; // w
        mquat[i * 4 + 1] = tf.q[0]; // x
        mquat[i * 4 + 2] = tf.q[1]; // y
        mquat[i * 4 + 3] = tf.q[2]; // z
      }
    };

    // ── Drive dynamic-joint actuators from their profiles ───────────────────
    const driveCtrl = (t: number) => {
      if (build.actuators.length === 0) return;
      const ctrl = data.ctrl; // [nu]
      for (let i = 0; i < build.actuators.length; i++) {
        const a = build.actuators[i];
        const raw = evaluateProfile(a.profile, t);
        ctrl[i] = a.revolute ? (a.unit === "deg" ? raw * DEG : raw) : raw * MM_TO_M;
      }
    };

    // ── Step loop ───────────────────────────────────────────────────────────
    const anyKin = kinematicIds.size > 0;
    const posesAt = (t: number): Map<string, Pose> | null => (anyKin ? kin.poseAt(t) : null);

    mj.mj_forward(model, data); // populate xpos/xquat before frame 0
    const kp0 = posesAt(0);
    if (kp0) driveMocap(kp0);
    const steps = Math.max(1, Math.round(spec.duration / spec.timestep));
    const frames: SimResult["frames"] = [recordFrame(0, kp0)];

    // Per-pair record: first-onset time + PEAK contact force/penetration over the
    // whole run (the worst instant, not just first touch — a light graze and a
    // hard slam both start at ~0). A reusable 6-vec buffer holds the contact
    // wrench mj_contactForce writes; index 0 is the normal force.
    interface Rec extends CollisionEvent { peakForceN: number; peakPenetrationMm: number }
    const recs = new Map<string, Rec>();
    const forceBuf = new mj.DoubleBuffer(6);

    for (let s = 1; s <= steps; s++) {
      const t = Math.min(spec.duration, s * spec.timestep);
      const kp = posesAt(t);
      if (kp) driveMocap(kp);
      driveCtrl(t);
      mj.mj_step(model, data);

      const ncon: number = data.ncon;
      if (ncon > 0) {
        const contacts = data.contact;
        const size = contacts.size();
        // Sum normal force / take max penetration across a pair's contact points
        // THIS step, then fold into the pair's running peak.
        const stepForce = new Map<string, number>();
        const stepPen = new Map<string, number>();
        const stepName = new Map<string, [string, string]>();
        for (let i = 0; i < size; i++) {
          const c = contacts.get(i);
          if (!c) continue;
          const a = simIdByBodyId.get(geomBodyId[c.geom1]);
          const b = simIdByBodyId.get(geomBodyId[c.geom2]);
          const dist: number = c.dist;
          c.delete?.();
          if (!a || !b || a === b) continue;
          if (isAcceptedPair(spec.acceptedPairs, a, b)) continue;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          mj.mj_contactForce(model, data, i, forceBuf);
          const fn = Math.abs((forceBuf.GetView() as ArrayLike<number>)[0]);
          const penMm = dist < 0 ? -dist * M_TO_MM : 0;
          stepForce.set(key, (stepForce.get(key) ?? 0) + fn);
          stepPen.set(key, Math.max(stepPen.get(key) ?? 0, penMm));
          if (!stepName.has(key)) stepName.set(key, [a, b]);
        }
        contacts.delete?.();

        for (const [key, [a, b]] of stepName) {
          let rec = recs.get(key);
          if (!rec) {
            rec = { a, b, tStart: t, overlapVolume: 0, peakForceN: 0, peakPenetrationMm: 0 };
            recs.set(key, rec);
          }
          rec.peakForceN = Math.max(rec.peakForceN, stepForce.get(key) ?? 0);
          rec.peakPenetrationMm = Math.max(rec.peakPenetrationMm, stepPen.get(key) ?? 0);
        }
      }

      frames.push(recordFrame(t, kp));
    }
    forceBuf.delete();

    const collisions = [...recs.values()].sort((x, y) => x.tStart - y.tStart);
    return { frames, collisions, duration: spec.duration, timestep: spec.timestep };
  } finally {
    data.delete();
    model.delete();
  }
}
