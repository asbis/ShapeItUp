/**
 * SimSpec → MJCF translator.
 *
 * This is the core of the MuJoCo integration. ShapeItUp describes a scene as a
 * FLAT list of bodies plus a `parent` map and a list of joints; MuJoCo wants a
 * NESTED kinematic tree of `<body>` elements (MJCF XML). This module bridges the
 * two, mapping each ShapeItUp concept onto its MJCF equivalent:
 *
 *   ShapeItUp                    MJCF
 *   ─────────────────────────    ────────────────────────────────────────────
 *   body kind "static"        →  <body> with no joint (welded to parent/world)
 *   body kind "dynamic"       →  <body> with a <freejoint/> (or its SimJoints)
 *   body kind "kinematic"     →  top-level mocap <body mocap="true"> — scripted
 *                                infinite-mass motion, driven each step from the
 *                                KinematicSim's poseAt() (see runMujoco).
 *   AABB                       →  <geom type="box"> at the body centre
 *   SimJoint revolute/prism.   →  <joint type="hinge"|"slide" pos axis>
 *   SimActuator (dynamic only) →  <position>/<velocity> actuator, ctrl driven
 *                                 per-step from the profile.
 *
 * Units: CAD is millimetres; MuJoCo is tuned for SI metres (default densities,
 * solver tolerances). We scale mm→m here and the engine scales m→mm on the way
 * out — the same boundary the Rapier engine uses. MuJoCo is Z-up like the CAD
 * frame, so — unlike many engines — NO axis remap is needed.
 */
import type { MeshData } from "./mesh";
import {
  compose,
  globToRegex,
  linkageTransforms,
  mulQuat,
  rotate,
  sub,
  type FourBarLinkage,
  type Profile,
  type Quat,
  type SimSpec,
  type Transform,
  type Vec3,
} from "@shapeitup/sim";

const MM_TO_M = 0.001;

/** Weld solref for the crank of a DYNAMIC linkage (prescribed crank, tight track). */
const LINK_WELD_SOLREF = "0.002 1";
/** Connect solref closing a dynamic linkage loop — stiff enough to hold the pin. */
const CONNECT_SOLREF = "0.002 1";

/** Rotor-inertia floor (kg·m²) added to ACTUATED joints for numerical stability
 *  of stiff servos on light CAD parts. Negligible for realistically massive
 *  parts; essential for thin/small ones. See mujoco.ts / the servo test. */
const ARMATURE = 1e-5;

/** Weld constraint solref (timeconst dampratio) binding a scripted dynamic body
 *  to its mocap target. Short time-constant → tight tracking of the script while
 *  still yielding contacts. */
const WELD_SOLREF = "0.002 1";

/** Vertex rounding (per metre) for mesh dedup + compact XML — micron precision,
 *  far finer than any mm-scale CAD feature. */
const MESH_QUANT = 1e6;

/** What the engine needs to know about the model it just built. */
export interface MjcfBuild {
  xml: string;
  /** MuJoCo body id → ShapeItUp body id. Filled in by the engine after load
   *  (ids aren't known until the compiler assigns them); we expose the reverse
   *  sanitised-name map so the engine can resolve them. */
  simIdByMjName: Map<string, string>;
  /** MuJoCo body name (sanitised) for each ShapeItUp body id, in spec order. */
  mjNameBySimId: Map<string, string>;
  /** Kinematic (mocap) bodies in declaration order — index === MuJoCo mocap id. */
  mocapOrder: string[];
  /** Actuators in declaration order — index === ctrl index. */
  actuators: ActuatorBinding[];
  /** Physics-solved four-bar linkages (see FourBarLinkage.dynamic). */
  dynamicLinkages: DynamicLinkageBinding[];
}

/**
 * A physics-solved four-bar. The crank is a mocap-weld body prescribed to the
 * driver angle; the coupler/rocker are dynamic bars closed by a `<connect>`. The
 * engine drives the crank mocap, reads coupler/rocker from physics, and reports
 * the connect (pin) force.
 */
export interface DynamicLinkageBinding {
  linkage: FourBarLinkage;
  /** Mocap index of the crank target (drive it to linkageTransforms(lk,t).crank). */
  crankMocapIndex: number;
  crankBody: string;
  couplerBody: string;
  rockerBody: string;
  /** Equality index of the `<connect>` — its 3 efc rows are the pin force. */
  connectName: string;
}

/** One MuJoCo actuator, with everything needed to compute its ctrl each step. */
export interface ActuatorBinding {
  simBodyId: string;
  profile: Profile;
  /** true → target is an angle (rad, or deg-scaled); false → prismatic (mm→m). */
  revolute: boolean;
  unit?: "rad" | "deg";
}

const centreOf = (aabb: { min: Vec3; max: Vec3 }): Vec3 => [
  (aabb.min[0] + aabb.max[0]) / 2,
  (aabb.min[1] + aabb.max[1]) / 2,
  (aabb.min[2] + aabb.max[2]) / 2,
];

const halfOf = (aabb: { min: Vec3; max: Vec3 }): Vec3 => [
  Math.max((aabb.max[0] - aabb.min[0]) / 2, 1e-4),
  Math.max((aabb.max[1] - aabb.min[1]) / 2, 1e-4),
  Math.max((aabb.max[2] - aabb.min[2]) / 2, 1e-4),
];

const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** MJCF names must be identifier-ish; make them unique and XML-safe. */
function makeSanitizer() {
  const seen = new Map<string, number>();
  return (id: string): string => {
    let s = id.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!s || /^[0-9-]/.test(s)) s = `b_${s}`;
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n === 0 ? s : `${s}__${n}`;
  };
}

/** Format a number for XML with enough precision, no exponent surprises. */
const num = (n: number): string => (Number.isFinite(n) ? String(n) : "0");
const m3 = (v: Vec3): string => `${num(v[0] * MM_TO_M)} ${num(v[1] * MM_TO_M)} ${num(v[2] * MM_TO_M)}`;
const vec = (v: Vec3): string => `${num(v[0])} ${num(v[1])} ${num(v[2])}`;

/**
 * Build an MJCF document from a resolved SimSpec.
 *
 * When a body has tessellated geometry in `meshes`, its collider is a real MESH
 * geom (inline vertices → MuJoCo convex hull — exact for convex parts, a tight
 * over-approx for concave, matching Rapier's default hull collider). Bodies
 * without mesh data fall back to an AABB box.
 */
export function buildMjcf(spec: SimSpec, meshes: Map<string, MeshData>): MjcfBuild {
  const sanitize = makeSanitizer();
  const mjNameBySimId = new Map<string, string>();
  const simIdByMjName = new Map<string, string>();
  for (const b of spec.bodies) {
    const mj = sanitize(b.id);
    mjNameBySimId.set(b.id, mj);
    simIdByMjName.set(mj, b.id);
  }

  const byId = new Map(spec.bodies.map((b) => [b.id, b]));
  const jointsByBody = new Map<string, SimSpec["joints"]>();
  for (const j of spec.joints) {
    const arr = jointsByBody.get(j.body) ?? [];
    arr.push(j);
    jointsByBody.set(j.body, arr);
  }
  const actuatorByJoint = new Map(spec.actuators.map((a) => [a.joint, a]));

  // Physics-solved four-bar linkages own their bars entirely (crank/coupler/rocker
  // become a mocap-weld + connect subtree), so those bodies are pulled out of the
  // normal body/joint emission below.
  const dynFourBars = (spec.linkages ?? []).filter(
    (l): l is FourBarLinkage => l.kind === "fourBar" && !!l.dynamic,
  );
  const linkageBodyIds = new Set<string>();
  for (const l of dynFourBars) {
    linkageBodyIds.add(l.crank.body);
    linkageBodyIds.add(l.coupler.body);
    linkageBodyIds.add(l.rocker.body);
  }

  // Parent→children map for the tree. Kinematic bodies are themselves emitted as
  // top-level mocap+weld bodies (not tree children), but a static/dynamic child
  // CAN nest under a kinematic parent — so it rides the scripted parent while its
  // own joint articulates against it (matches Rapier, where a joint anchors to the
  // parent body). Kinematic children are skipped (they're mocap-driven directly).
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const b of spec.bodies) {
    if (b.kind === "kinematic" || linkageBodyIds.has(b.id)) continue;
    const parent = b.parent && byId.has(b.parent) ? b.parent : undefined;
    if (parent) {
      const arr = children.get(parent) ?? [];
      arr.push(b.id);
      children.set(parent, arr);
    } else {
      roots.push(b.id);
    }
  }

  const mocapOrder: string[] = [];
  const actuators: ActuatorBinding[] = [];
  const actuatorXml: string[] = [];
  const meshAssets: string[] = [];

  /**
   * The collider `<geom>` for a body: a MESH (inline body-local vertices, which
   * MuJoCo convex-hulls for collision + inertia) when tessellation is available,
   * else an AABB box. Vertices are deduped at micron precision — CAD tessellation
   * duplicates them heavily, and duplicates don't change a hull — which keeps the
   * XML compact. Returns the geom element (no leading indent); may push an asset.
   */
  const geomFor = (id: string, mj: string, centre: Vec3, half: Vec3): string => {
    const mesh = meshes.get(id);
    if (mesh && mesh.vertices.length >= 12) {
      const seen = new Set<string>();
      const coords: string[] = [];
      for (let i = 0; i < mesh.vertices.length; i += 3) {
        const x = Math.round((mesh.vertices[i] - centre[0]) * MM_TO_M * MESH_QUANT) / MESH_QUANT;
        const y = Math.round((mesh.vertices[i + 1] - centre[1]) * MM_TO_M * MESH_QUANT) / MESH_QUANT;
        const z = Math.round((mesh.vertices[i + 2] - centre[2]) * MM_TO_M * MESH_QUANT) / MESH_QUANT;
        const key = `${x}|${y}|${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        coords.push(`${x} ${y} ${z}`);
      }
      if (seen.size >= 4) {
        meshAssets.push(`    <mesh name="${mj}_mesh" vertex="${coords.join(" ")}"/>`);
        return `<geom name="${mj}_g" type="mesh" mesh="${mj}_mesh" density="1000"/>`;
      }
    }
    return `<geom name="${mj}_g" type="box" size="${num(half[0] * MM_TO_M)} ${num(half[1] * MM_TO_M)} ${num(half[2] * MM_TO_M)}" density="1000"/>`;
  };

  /** Emit one rigid body element and recurse into its children. */
  const emitBody = (id: string, parentCentre: Vec3, indent: string): string => {
    const b = byId.get(id)!;
    const centre = centreOf(b.aabb);
    const half = halfOf(b.aabb);
    const pos: Vec3 = [centre[0] - parentCentre[0], centre[1] - parentCentre[1], centre[2] - parentCentre[2]];
    const mj = mjNameBySimId.get(id)!;

    const lines: string[] = [];
    lines.push(`${indent}<body name="${mj}" pos="${m3(pos)}">`);

    // Joints: a dynamic body with explicit SimJoints uses them; a dynamic body
    // with none gets a freejoint (6-DOF float). Static bodies get no joint.
    const joints = jointsByBody.get(id) ?? [];
    if (b.kind === "dynamic") {
      if (joints.length === 0) {
        lines.push(`${indent}  <freejoint/>`);
      } else {
        for (const j of joints) {
          const type = j.type === "revolute" ? "hinge" : "slide";
          // MuJoCo joint pos is body-local; anchor is world → subtract centre.
          const anchorLocal: Vec3 = [j.anchor[0] - centre[0], j.anchor[1] - centre[1], j.anchor[2] - centre[2]];
          const axis = norm3(j.axis);
          const jn = sanitize(j.id);

          // Only dynamic-body joints become real MuJoCo actuators. Actuators on
          // kinematic bodies feed the scripted KinematicSim instead (mocap).
          const act = actuatorByJoint.get(j.id);
          // A stiff position servo on a near-massless CAD part would explode the
          // explicit solver, so an actuated joint gets a small ARMATURE (rotor
          // inertia — an inertia floor for the DOF) and its actuator gets a `kv`
          // damping term. Combined with the implicitfast integrator (set on
          // <option>) this makes stiff servos stable regardless of part mass.
          // Un-actuated joints stay armature-free so free swings are physical.
          const armature = act ? ` armature="${num(ARMATURE)}"` : "";
          lines.push(
            `${indent}  <joint name="${jn}" type="${type}" pos="${m3(anchorLocal)}" axis="${vec(axis)}"${armature}/>`,
          );
          if (act) {
            const idx = actuators.length;
            const revolute = j.type === "revolute";
            actuators.push({ simBodyId: id, profile: act.profile, revolute, unit: j.unit });
            const mode = j.motor?.mode ?? "position";
            if (mode === "velocity") {
              const kv = j.motor?.damping ?? 1e3;
              actuatorXml.push(`    <velocity name="act_${idx}" joint="${jn}" kv="${num(kv)}"/>`);
            } else {
              const kp = j.motor?.stiffness ?? 1e4;
              // Near-critical damping (2·√kp for unit effective inertia) unless
              // the author pinned it via motor.damping.
              const kv = j.motor?.damping ?? 2 * Math.sqrt(kp);
              actuatorXml.push(`    <position name="act_${idx}" joint="${jn}" kp="${num(kp)}" kv="${num(kv)}"/>`);
            }
          }
        }
      }
    }

    lines.push(`${indent}  ${geomFor(id, mj, centre, half)}`);

    for (const child of children.get(id) ?? []) {
      lines.push(emitBody(child, centre, indent + "  "));
    }
    lines.push(`${indent}</body>`);
    return lines.join("\n");
  };

  const worldChildren: string[] = [];
  const equalityXml: string[] = [];

  // Kinematic bodies first → their declaration order fixes the mocap index.
  //
  // A scripted body can't just be a mocap body: MuJoCo CULLS contacts between
  // two DOF-less bodies (mocap/static), so an all-kinematic scene (carriage +
  // needles) would report zero collisions. Instead each kinematic body becomes a
  // geom-less MOCAP TARGET plus a weld-constrained DYNAMIC body that carries the
  // geometry. The weld (stiff solref) drags the dynamic body along the scripted
  // trajectory each step, but because it now has DOF it generates real contacts —
  // with other scripted bodies AND with free dynamic parts (which it can shove).
  // The engine still outputs the exact scripted pose for these bodies (the weld
  // is a means to contacts/forces, not a source of visible lag).
  for (const b of spec.bodies) {
    if (b.kind !== "kinematic" || linkageBodyIds.has(b.id)) continue;
    mocapOrder.push(b.id);
    const centre = centreOf(b.aabb);
    const half = halfOf(b.aabb);
    const mj = mjNameBySimId.get(b.id)!;
    const mt = `${mj}__mt`;
    worldChildren.push(`    <body name="${mt}" mocap="true" pos="${m3(centre)}"/>`);
    // Static/dynamic children nest INSIDE the weld body so their joints anchor to
    // this (scripted) frame — they ride the parent. gravcomp is per-body, so a
    // nested dynamic child still feels gravity.
    const kids = (children.get(b.id) ?? []).map((c) => emitBody(c, centre, "      ")).join("\n");
    worldChildren.push(
      // gravcomp="1": cancel gravity on the scripted body so it doesn't SAG off
      // its weld target (a sagging carriage would dip into a lowered needle's
      // clearance and report a false collision). It stays dynamic for contacts.
      `    <body name="${mj}" pos="${m3(centre)}" gravcomp="1">\n` +
        `      <freejoint/>\n` +
        `      ${geomFor(b.id, mj, centre, half)}\n` +
        (kids ? kids + "\n" : "") +
        `    </body>`,
    );
    equalityXml.push(`    <weld name="weld_${mj}" body1="${mj}" body2="${mt}" solref="${WELD_SOLREF}"/>`);
  }

  // ── Physics-solved four-bar linkages ────────────────────────────────────────
  // Declared AFTER the kinematic mocaps so each linkage crank's mocap index just
  // continues the mocap numbering. Each bar body frame = its rest bar frame
  // (origin at the bar start, +X along the bar), matching the tessellated part
  // (drawn +X from origin) — so the engine reads its pose straight out with no
  // centre offset. The crank is a mocap-weld body prescribed to the driver angle;
  // the coupler (nested, hinged at B) and rocker (hinged to world at D) are
  // dynamic, closed by a <connect> at C.
  const dynamicLinkages: DynamicLinkageBinding[] = [];
  const excludeXml: string[] = [];
  const conjQ = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
  const mjQuat = (q: Quat): string => `${num(q[3])} ${num(q[0])} ${num(q[1])} ${num(q[2])}`;
  const posQ = (tf: Transform): string => `pos="${m3(tf.t)}" quat="${mjQuat(tf.q)}"`;
  /** Bar geom in its own frame (origin at bar start). Mesh if present (already in
   *  that frame), else a thin capsule of the declared length. */
  const barGeom = (id: string, mj: string, len: number): string => {
    const g = geomFor(id, mj, [0, 0, 0], [len / 2, 2, 2]);
    // geomFor with centre [0,0,0] emits mesh verts as-is (bar frame). Its BOX
    // fallback would be centred on the origin (wrong for a bar), so swap that for
    // a +X capsule.
    if (g.includes('type="mesh"')) return g;
    return `<geom name="${mj}_g" type="capsule" fromto="0 0 0 ${num(len * MM_TO_M)} 0 0" size="0.003" density="1000"/>`;
  };

  for (const lk of dynFourBars) {
    const T0 = linkageTransforms(lk, 0);
    const Tc = T0.get(lk.crank.body)!;
    const Tco = T0.get(lk.coupler.body)!;
    const Tr = T0.get(lk.rocker.body)!;
    const crankMj = mjNameBySimId.get(lk.crank.body)!;
    const couplerMj = mjNameBySimId.get(lk.coupler.body)!;
    const rockerMj = mjNameBySimId.get(lk.rocker.body)!;
    const mt = `${crankMj}__mt`;
    // Coupler frame relative to the (moving) crank frame.
    const relCoupler: Transform = { q: mulQuat(conjQ(Tc.q), Tco.q), t: rotate(conjQ(Tc.q), sub(Tco.t, Tc.t)) };

    worldChildren.push(`    <body name="${mt}" mocap="true" ${posQ(Tc)}/>`);
    worldChildren.push(
      `    <body name="${crankMj}" ${posQ(Tc)} gravcomp="1">\n` +
        `      <freejoint/>\n` +
        `      ${barGeom(lk.crank.body, crankMj, lk.crank.length)}\n` +
        `      <body name="${couplerMj}" ${posQ(relCoupler)}>\n` +
        `        <joint name="${couplerMj}_j" type="hinge" axis="0 0 1" pos="0 0 0" armature="${num(ARMATURE)}"/>\n` +
        `        ${barGeom(lk.coupler.body, couplerMj, lk.coupler.length)}\n` +
        `        <site name="${couplerMj}_C" pos="${num(lk.coupler.length * MM_TO_M)} 0 0"/>\n` +
        `      </body>\n` +
        `    </body>`,
    );
    worldChildren.push(
      `    <body name="${rockerMj}" ${posQ(Tr)}>\n` +
        `      <joint name="${rockerMj}_j" type="hinge" axis="0 0 1" pos="0 0 0" armature="${num(ARMATURE)}"/>\n` +
        `      ${barGeom(lk.rocker.body, rockerMj, lk.rocker.length)}\n` +
        `      <site name="${rockerMj}_C" pos="${num(lk.rocker.length * MM_TO_M)} 0 0"/>\n` +
        `    </body>`,
    );
    const connectName = `connect_${crankMj}`;
    equalityXml.push(`    <weld name="weld_${crankMj}" body1="${crankMj}" body2="${mt}" solref="${LINK_WELD_SOLREF}"/>`);
    equalityXml.push(
      `    <connect name="${connectName}" body1="${couplerMj}" body2="${rockerMj}" anchor="${num(lk.coupler.length * MM_TO_M)} 0 0" solref="${CONNECT_SOLREF}"/>`,
    );
    // The bars overlap at their shared pins — expected, so don't collide them.
    for (const [a, b] of [[crankMj, couplerMj], [couplerMj, rockerMj], [crankMj, rockerMj]]) {
      excludeXml.push(`    <exclude name="lex_${a}_${b}" body1="${a}" body2="${b}"/>`);
    }
    dynamicLinkages.push({
      linkage: lk,
      crankMocapIndex: mocapOrder.length + dynamicLinkages.length,
      crankBody: lk.crank.body,
      couplerBody: lk.coupler.body,
      rockerBody: lk.rocker.body,
      connectName,
    });
  }

  for (const id of roots) worldChildren.push(emitBody(id, [0, 0, 0], "    "));

  // acceptedPairs are DESIGNED overlaps (a needle resting in its bed slot, a
  // press-fit). MuJoCo would otherwise resolve that interpenetration with real
  // contact forces — shoving a weld-driven part off its scripted path (a needle
  // popping up into the carriage → phantom collisions). So we don't just filter
  // the REPORT (the engine does that too); we physically EXCLUDE the contact.
  // (excludeXml already holds the linkage pin-overlap excludes.)
  if (spec.acceptedPairs?.length) {
    const seen = new Set<string>();
    for (const [ga, gb] of spec.acceptedPairs) {
      const ra = globToRegex(ga);
      const rb = globToRegex(gb);
      for (let i = 0; i < spec.bodies.length; i++) {
        for (let j = i + 1; j < spec.bodies.length; j++) {
          const a = spec.bodies[i].id;
          const b = spec.bodies[j].id;
          if (!((ra.test(a) && rb.test(b)) || (ra.test(b) && rb.test(a)))) continue;
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          excludeXml.push(
            `    <exclude name="ex_${seen.size}" body1="${mjNameBySimId.get(a)}" body2="${mjNameBySimId.get(b)}"/>`,
          );
        }
      }
    }
  }

  const g = spec.gravity ?? [0, 0, -9810];
  const xml =
    `<mujoco model="shapeitup">\n` +
    `  <compiler angle="radian" inertiafromgeom="true"/>\n` +
    // implicitfast: implicit-in-velocity integrator — stable with the stiff
    // position/velocity servos and joint damping this translator emits, at
    // barely more cost than explicit Euler. The Rapier engine gets stability
    // from its impulse solver; MuJoCo gets it here.
    `  <option timestep="${num(spec.timestep)}" gravity="${m3(g as Vec3)}" integrator="implicitfast"/>\n` +
    (meshAssets.length ? `  <asset>\n${meshAssets.join("\n")}\n  </asset>\n` : "") +
    `  <worldbody>\n` +
    worldChildren.join("\n") +
    `\n  </worldbody>\n` +
    (excludeXml.length ? `  <contact>\n${excludeXml.join("\n")}\n  </contact>\n` : "") +
    (equalityXml.length ? `  <equality>\n${equalityXml.join("\n")}\n  </equality>\n` : "") +
    (actuatorXml.length ? `  <actuator>\n${actuatorXml.join("\n")}\n  </actuator>\n` : "") +
    `</mujoco>\n`;

  return { xml, simIdByMjName, mjNameBySimId, mocapOrder, actuators, dynamicLinkages };
}
