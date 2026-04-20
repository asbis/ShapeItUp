/**
 * Parts + joints — declarative assembly API.
 *
 * A `Part` wraps a Shape3D plus a dictionary of named joints. Joints are
 * frames (position + outward axis) in the part's LOCAL coordinates; they
 * describe "where this part connects to other parts." A Part is immutable:
 * every `.addJoint()` / `.translate()` / `.rotate()` returns a NEW Part.
 *
 * Joints alone do nothing — they become useful when paired with `mate()`
 * and `assemble()` in `./assembly.ts`.
 *
 * Convention: a joint's `axis` points OUTWARD from the part along the
 * direction the mating partner approaches from. For a motor's output shaft
 * joint at the top face, axis = "+Z" (shaft exits upward). For a coupler's
 * bottom-end joint, axis = "-Z" (mating face points downward, toward the
 * motor below).
 */

import type { Shape3D } from "replicad";
import type { Point3 } from "./standards";

/** Direction vector (not necessarily unit length until normalized). */
export type Vec3 = [number, number, number];

/** Axis shorthand accepted by joint declarations. */
export type Axis = "+X" | "-X" | "+Y" | "-Y" | "+Z" | "-Z" | Vec3;

/** Normalize an Axis (string shorthand or raw vector) to a unit Vec3. */
export function normalizeAxis(a: Axis): Vec3 {
  if (a === "+X") return [1, 0, 0];
  if (a === "-X") return [-1, 0, 0];
  if (a === "+Y") return [0, 1, 0];
  if (a === "-Y") return [0, -1, 0];
  if (a === "+Z") return [0, 0, 1];
  if (a === "-Z") return [0, 0, -1];
  const [x, y, z] = a;
  const mag = Math.sqrt(x * x + y * y + z * z);
  if (mag === 0) throw new Error("Axis vector cannot be zero");
  return [x / mag, y / mag, z / mag];
}

/** Semantic role for a joint — used by `mate()` for pre-flight compatibility checks. */
export type JointRole = "male" | "female" | "face";

/** Joint data in a part's local frame. */
export interface JointSpec {
  position: Point3;
  /** Always a unit vector after construction. */
  axis: Vec3;
  role?: JointRole;
  /** Nominal mating diameter (mm). Used by mate() to flag mismatches. */
  diameter?: number;
}

/** User-facing options for `addJoint` — `axis` accepts string shorthand. */
export interface JointOpts {
  axis: Axis;
  role?: JointRole;
  diameter?: number;
}

/**
 * A joint surfaced via `part.joints.name` — identical to JointSpec but
 * with a back-reference to the owning Part (so `mate()` knows which part
 * to move) and its name (for diagnostic messages). Position and axis are
 * reported in WORLD coordinates (after the part's accumulated transform).
 */
export interface AttachedJoint extends JointSpec {
  readonly part: Part;
  readonly name: string;
}

// ── Internal rigid-transform primitive ──────────────────────────────────────
//
// We track each part's accumulated world transform as three parallel
// functions: one for shapes, one for points, one for vectors. Translation
// affects shapes+points but not vectors; rotation affects all three.
// Composition is plain function composition — correctness over performance.

/** @internal */
export interface Transform {
  shape: (s: Shape3D) => Shape3D;
  point: (p: Point3) => Point3;
  vector: (v: Vec3) => Vec3;
}

const IDENTITY: Transform = {
  shape: (s) => s,
  point: (p) => p,
  vector: (v) => v,
};

/** @internal */
export function translateTransform(t: Vec3): Transform {
  return {
    shape: (s) => s.translate(t[0], t[1], t[2]),
    point: (p) => [p[0] + t[0], p[1] + t[1], p[2] + t[2]],
    vector: (v) => v,
  };
}

/** @internal Rotation about the world origin (Rodrigues' formula for points/vectors). */
export function rotateTransform(angleDeg: number, axis: Axis): Transform {
  const [ax, ay, az] = normalizeAxis(axis);
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const rotVec = (v: Vec3): Vec3 => {
    const dot = ax * v[0] + ay * v[1] + az * v[2];
    return [
      v[0] * c + (ay * v[2] - az * v[1]) * s + ax * dot * (1 - c),
      v[1] * c + (az * v[0] - ax * v[2]) * s + ay * dot * (1 - c),
      v[2] * c + (ax * v[1] - ay * v[0]) * s + az * dot * (1 - c),
    ];
  };
  return {
    shape: (shp) => shp.rotate(angleDeg, [0, 0, 0], [ax, ay, az]),
    point: rotVec,
    vector: rotVec,
  };
}

/** @internal Compose: first, then second. Result(x) = second(first(x)). */
export function composeTransforms(first: Transform, second: Transform): Transform {
  return {
    shape: (s) => second.shape(first.shape(s)),
    point: (p) => second.point(first.point(p)),
    vector: (v) => second.vector(first.vector(v)),
  };
}

// ── Part class ─────────────────────────────────────────────────────────────

export interface PartOptions {
  name?: string;
  color?: string;
  /** @internal Used by `assemble()` to return positioned parts without rebuilding shapes. */
  joints?: Record<string, JointSpec>;
  /** @internal Accumulated world transform. */
  xform?: Transform;
  /**
   * @internal Non-empty for SUBASSEMBLIES — Parts composed of other Parts.
   * Each child carries its own `_xform` (from the subassembly's internal
   * mates); the subassembly's own `_xform` is composed on top at render time.
   */
  children?: ReadonlyArray<Part>;
}

/**
 * Immutable wrapper around a Shape3D with named joints. Every mutating
 * method returns a new Part.
 *
 * A Part can also be a SUBASSEMBLY — a composed Part built from other Parts
 * via `subassembly()`. Subassemblies expose promoted joints on their own
 * boundary and can be mated into higher-level assemblies like any other Part.
 */
export class Part {
  /**
   * The LOCAL shape — before the accumulated world transform is applied.
   * For subassemblies, this is a Compound of all children at their internal
   * positions (useful for bounding-box queries). Rendering always goes
   * through `toEntries()` which unpacks the children.
   */
  readonly shape: Shape3D;
  readonly name?: string;
  readonly color?: string;
  private readonly _localJoints: Record<string, JointSpec>;
  private readonly _xform: Transform;
  private readonly _children: ReadonlyArray<Part>;

  constructor(shape: Shape3D, opts: PartOptions = {}) {
    this.shape = shape;
    this.name = opts.name;
    this.color = opts.color;
    this._localJoints = opts.joints ?? {};
    this._xform = opts.xform ?? IDENTITY;
    this._children = opts.children ?? [];
  }

  /**
   * Add a named joint in LOCAL coordinates. Returns a new Part.
   *
   * @param name Unique name within this part.
   * @param position Joint origin in the part's local frame.
   * @param opts.axis Outward direction (see module comment for convention).
   * @param opts.role Optional semantic role for mate pre-flight checks.
   * @param opts.diameter Optional nominal diameter — mate() warns on mismatch.
   */
  addJoint(name: string, position: Point3, opts: JointOpts): Part {
    if (name in this._localJoints) {
      throw new Error(`Part.addJoint: duplicate joint name "${name}"`);
    }
    const joint: JointSpec = {
      position,
      axis: normalizeAxis(opts.axis),
      role: opts.role,
      diameter: opts.diameter,
    };
    return new Part(this.shape, {
      name: this.name,
      color: this.color,
      joints: { ...this._localJoints, [name]: joint },
      xform: this._xform,
      children: this._children,
    });
  }

  /**
   * Access joints by name, reported in WORLD coordinates (after any
   * accumulated transform).
   *
   * `part.joints.shaftTop` yields an `AttachedJoint` carrying a reference
   * back to this Part — `mate()` uses that reference to know which part
   * to position during assembly.
   */
  get joints(): Readonly<Record<string, AttachedJoint>> {
    const out: Record<string, AttachedJoint> = {};
    for (const [name, j] of Object.entries(this._localJoints)) {
      out[name] = {
        position: this._xform.point(j.position),
        axis: this._xform.vector(j.axis),
        role: j.role,
        diameter: j.diameter,
        part: this,
        name,
      };
    }
    return out;
  }

  /** Translate the part. Returns a new Part with an updated transform. */
  translate(x: number, y: number, z: number): Part {
    return this.withTransform(
      composeTransforms(this._xform, translateTransform([x, y, z]))
    );
  }

  /** Rotate the part about the world origin. Returns a new Part. */
  rotate(angleDeg: number, axis: Axis): Part {
    return this.withTransform(
      composeTransforms(this._xform, rotateTransform(angleDeg, axis))
    );
  }

  /** @internal Replace the accumulated transform wholesale (used by assemble). */
  withTransform(xform: Transform): Part {
    return new Part(this.shape, {
      name: this.name,
      color: this.color,
      joints: this._localJoints,
      xform,
      children: this._children,
    });
  }

  /** Return the part's accumulated world transform. @internal */
  transform(): Transform {
    return this._xform;
  }

  /**
   * Produce the positioned Shape3D with the accumulated transform applied.
   *
   * Returns a NEW shape handle each call — `this.shape` is never consumed.
   * This is load-bearing: Replicad's `translate`/`rotate` delete their input
   * (see replicad.js Solid.translate — `this.delete()` after cast), so
   * without the clone, the Transform's `shape(s) => s.translate(...)` would
   * invalidate `this.shape`. Callers like `subassembly()` and `toEntries()`
   * iterate children and call `worldShape()` multiple times on the same
   * Part; they would observe "This object has been deleted" on the second
   * access if this method consumed its input.
   *
   * The IDENTITY case also clones — callers may mutate the result, and we
   * don't want those mutations aliased back onto `this.shape`.
   */
  worldShape(): Shape3D {
    return this._xform.shape(this.shape.clone());
  }

  /**
   * Convert to the `{ shape, name, color }` entry format used in `main()`'s
   * multi-part return. Applies the accumulated transform.
   *
   * For SUBASSEMBLIES, this returns the compound shape as a single entry —
   * use `toEntries()` instead if you want each child rendered as its own
   * part in the viewer (typical case).
   */
  toEntry(): { shape: Shape3D; name?: string; color?: string } {
    return {
      shape: this.worldShape(),
      name: this.name,
      color: this.color,
    };
  }

  /** True when this Part is a subassembly (composed of child Parts). */
  get isSubassembly(): boolean {
    return this._children.length > 0;
  }

  /**
   * Expand this Part into one or more viewer entries.
   *
   * - Regular parts: returns a single-element array of `{ shape, name, color }`.
   * - Subassemblies: flattens all children recursively, composing the
   *   subassembly's accumulated transform onto each child's own transform.
   *   Each child keeps its own name and color (fall back to the
   *   subassembly's color if a child has none).
   */
  toEntries(): Array<{ shape: Shape3D; name?: string; color?: string }> {
    if (this._children.length === 0) {
      return [this.toEntry()];
    }
    const outerXform = this._xform;
    const inheritColor = this.color;
    const out: Array<{ shape: Shape3D; name?: string; color?: string }> = [];
    for (const child of this._children) {
      // Child's `_xform` is its position within THIS subassembly (local frame).
      // Compose with the subassembly's outer xform to get the child's world pose.
      const composed = new Part(child.shape, {
        name: child.name,
        color: child.color ?? inheritColor,
        joints: child._localJoints,
        xform: composeTransforms(child._xform, outerXform),
        children: child._children,
      });
      out.push(...composed.toEntries());
    }
    return out;
  }
}

/**
 * Standalone factory for declaring a joint spec without a Part yet — handy
 * when building up joint data before wrapping it in a Part.
 */
export function joint(position: Point3, opts: JointOpts): JointSpec {
  return {
    position,
    axis: normalizeAxis(opts.axis),
    role: opts.role,
    diameter: opts.diameter,
  };
}

// ── Declarative factory + joint shortcuts ───────────────────────────────────
//
// The `part({...})` factory collapses `new Part(...).addJoint().addJoint()`
// chains into a single object expression. `faceAt`, `shaftAt`, `boreAt`
// encode the "axis points outward from the part" convention so callers
// don't have to reason about +Z vs -Z for each joint.

/** Inline joint spec accepted by `part({ joints: {...} })`. */
export interface InlineJointSpec {
  /** Joint origin in the part's local frame. */
  at: Point3;
  axis: Axis;
  role?: JointRole;
  diameter?: number;
}

export interface PartFactoryOpts {
  shape: Shape3D;
  name?: string;
  color?: string;
  joints?: Record<string, InlineJointSpec>;
}

/**
 * Declarative factory for a Part — one expression replaces the
 * `new Part(...).addJoint().addJoint()` chain.
 *
 *   const motor = part({
 *     shape: motorBody.fuse(shaft),
 *     name: "motor", color: "#2b2b2b",
 *     joints: {
 *       mountFace: faceAt(MOTOR_HEIGHT),
 *       shaftTip:  shaftAt(MOTOR_HEIGHT + SHAFT_LENGTH, 5),
 *     },
 *   });
 *
 * The returned value is a regular Part — `motor.joints.shaftTip`, `.translate()`,
 * etc. all work the same. Reach for `new Part(...)` only when you need the
 * fluent `.addJoint()` chain form (e.g., conditionally adding joints).
 */
export function part(opts: PartFactoryOpts): Part {
  let p = new Part(opts.shape, { name: opts.name, color: opts.color });
  if (opts.joints) {
    for (const [name, j] of Object.entries(opts.joints)) {
      p = p.addJoint(name, j.at, {
        axis: j.axis,
        role: j.role,
        diameter: j.diameter,
      });
    }
  }
  return p;
}

/**
 * Joint shorthand for a FLAT MOUNTING FACE (role = "face"). Axis defaults
 * to "+Z" (the common case — a top face pointing up). Pass `{ axis: "-Z" }`
 * for a bottom face or any other direction.
 *
 *   joints: {
 *     mountFace: faceAt(PLATE_THICKNESS),              // top face, +Z outward
 *     motorFace: faceAt(0, { axis: "-Z" }),            // bottom face, -Z outward
 *   }
 */
export function faceAt(
  z: number,
  opts: { axis?: Axis; xy?: [number, number] } = {}
): InlineJointSpec {
  const [x, y] = opts.xy ?? [0, 0];
  return {
    at: [x, y, z],
    axis: opts.axis ?? "+Z",
    role: "face",
  };
}

/**
 * Joint shorthand for a MALE SHAFT END (role = "male"). The joint sits at
 * the TIP of the shaft with its axis pointing outward along the shaft. Axis
 * defaults to "+Z" (shaft exits upward). Pass `diameter` so mate() can
 * check against the mating bore.
 *
 *   joints: {
 *     shaftTip: shaftAt(MOTOR_HEIGHT + 24, 5),         // shaft exits at z=64, Ø5
 *   }
 */
export function shaftAt(
  z: number,
  diameter: number,
  opts: { axis?: Axis; xy?: [number, number] } = {}
): InlineJointSpec {
  const [x, y] = opts.xy ?? [0, 0];
  return {
    at: [x, y, z],
    axis: opts.axis ?? "+Z",
    role: "male",
    diameter,
  };
}

/**
 * Joint shorthand for a FEMALE BORE (role = "female"). Axis points OUTWARD
 * from the part along the bore's direction — default "-Z" for a bore that
 * opens on the part's bottom face and accepts a shaft coming up from below.
 *
 * ### Picking `z` — mouth vs bottom
 *
 * This helper is agnostic about which end of the bore the `z` parameter
 * names — the caller decides based on how they want the mating shaft to
 * sit. Two common patterns:
 *
 * **Anchor at the MOUTH** — the mating shaft sits AGAINST the rim; the
 * bore may be deeper but the shaft doesn't penetrate farther than the mouth.
 * Use when you want to butt two coaxial parts together at a face.
 *
 *   boreAt(0, 5)                   // mouth at local z=0, axis -Z (opens down)
 *
 * **Anchor at the BOTTOM** — the mating shaft FILLS the bore; the shaft
 * tip lands against the back wall. Use when the shaft insertion depth IS
 * the bore depth (a press-fit bearing pocket behaves this way).
 *
 *   boreAt(BORE_DEPTH, 5)          // bottom of bore at local z=BORE_DEPTH
 *
 * In either case `mate(shaftTip, bore, { gap })` positions the SHAFT TIP at
 * the joint's anchor point (± gap). So bottom-anchoring gives a fully-
 * inserted shaft; mouth-anchoring gives a shaft that just touches the rim.
 *
 *   joints: {
 *     motorEnd:     boreAt(COUPLER_BORE_DEPTH, 5),             // shaft fills bore
 *     leadscrewEnd: boreAt(COUPLER_LENGTH, 8, { axis: "+Z" }), // top bore
 *   }
 */
export function boreAt(
  z: number,
  diameter: number,
  opts: { axis?: Axis; xy?: [number, number] } = {}
): InlineJointSpec {
  const [x, y] = opts.xy ?? [0, 0];
  return {
    at: [x, y, z],
    axis: opts.axis ?? "-Z",
    role: "female",
    diameter,
  };
}
