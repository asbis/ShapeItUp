/**
 * The drag arrow — the manipulator a CAD user expects once something is
 * selected and an operation is armed.
 *
 * It points the way the operation acts and you drag along it to size that
 * operation. Nothing is written until Apply: dragging edits the NUMBER, the
 * same number the preview line shows, so the contract that you see the code
 * before it is committed survives the addition of a direct-manipulation
 * gesture.
 *
 * ## Why the value only, and not the geometry
 *
 * Fusion re-solves the model continuously while you drag. We cannot: the
 * operation does not exist in the source yet, so previewing it for real would
 * mean re-executing a modified script through OCCT on every pointer move.
 * Instead the arrow's length tracks the value, and for an extrude a ghost of
 * the face is drawn at the offset position — enough to judge the size, honest
 * about being a proxy, and free.
 */
import * as THREE from "three";
import { THEME } from "./theme";

/** Where the arrow sits and which way it points. */
export interface HandleAnchor {
  origin: [number, number, number];
  /** Unit vector. Positive drag runs this way. */
  axis: [number, number, number];
}

/**
 * Length of the arrow when the value is zero, and the floor below which it
 * stops shrinking. Without a floor the handle vanishes exactly when the user
 * most needs to grab it — at 0, or on the way through 0 to a negative push.
 */
// Sized so the arrow reads as a manipulator rather than as another axis line.
// At 44 px it was easy to mistake for the Z axis of the gnomon behind it.
const MIN_LENGTH_PX = 76;
const HEAD_FRACTION = 0.3;
const SHAFT_RADIUS_PX = 2.4;
const GRAB_RADIUS_PX = 11;

/**
 * The arrow, built in a unit space and scaled per frame.
 *
 * Its size is held constant in SCREEN space rather than world space: a handle
 * measured in millimetres is a speck on a 300 mm part and swallows a 3 mm one.
 * `update` rescales it against the camera distance every frame.
 */
export class DragHandle {
  readonly group = new THREE.Group();
  private shaft: THREE.Mesh;
  private head: THREE.Mesh;
  /** Invisible, fatter than the shaft: the thing the pointer actually hits. */
  private grab: THREE.Mesh;
  private anchor: HandleAnchor | null = null;
  private material: THREE.MeshBasicMaterial;
  /**
   * False when the axis points nearly at the camera. Dragging is refused there
   * — the closest-approach projection is unstable — and an arrow seen end-on
   * is an unreadable dot, so it is faded to say so rather than sitting there
   * looking grabbable.
   */
  private usable = true;

  constructor() {
    const material = new THREE.MeshBasicMaterial({
      color: THEME.edgeSelectColor,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.material = material;
    // Built pointing +Y so it can be aimed with a single quaternion from (0,1,0).
    this.shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 12), material);
    this.head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 16), material);
    this.grab = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.shaft.renderOrder = 3;
    this.head.renderOrder = 3;
    this.shaft.raycast = () => {};
    this.head.raycast = () => {};
    this.group.add(this.shaft, this.head, this.grab);
    this.group.visible = false;
    this.group.frustumCulled = false;
  }

  /** The mesh a raycaster should test to decide whether the arrow was grabbed. */
  get hitTarget(): THREE.Object3D {
    return this.grab;
  }

  show(anchor: HandleAnchor): void {
    this.anchor = anchor;
    this.group.visible = true;
  }

  hide(): void {
    this.anchor = null;
    this.group.visible = false;
  }

  get visible(): boolean {
    return this.group.visible;
  }

  getAnchor(): HandleAnchor | null {
    return this.anchor;
  }

  /**
   * Re-place and re-scale the arrow.
   *
   * `value` is the operation's current number. Its SIGN flips the arrow, so a
   * negative extrude visibly points into the material rather than silently
   * meaning the opposite of what is drawn.
   */
  update(value: number, worldPerPixel: number, viewDirection?: THREE.Vector3): void {
    if (!this.anchor) return;
    const [ox, oy, oz] = this.anchor.origin;
    const dir = new THREE.Vector3(...this.anchor.axis).normalize();
    if (value < 0) dir.negate();

    if (viewDirection) {
      // Within ~18 degrees of the view direction the arrow is seen end-on.
      this.usable = Math.abs(dir.dot(viewDirection)) < 0.95;
      this.material.opacity = this.usable ? 0.95 : 0.25;
    }

    const minLength = MIN_LENGTH_PX * worldPerPixel;
    const length = Math.max(Math.abs(value), minLength);

    const headLength = length * HEAD_FRACTION;
    const shaftLength = length - headLength;
    const shaftRadius = SHAFT_RADIUS_PX * worldPerPixel;

    this.group.position.set(ox, oy, oz);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    this.shaft.scale.set(shaftRadius, shaftLength, shaftRadius);
    this.shaft.position.set(0, shaftLength / 2, 0);

    this.head.scale.set(shaftRadius * 3.2, headLength, shaftRadius * 3.2);
    this.head.position.set(0, shaftLength + headLength / 2, 0);

    // One grab cylinder over the whole arrow, generously wide — the shaft is
    // a couple of pixels across and would otherwise be nearly unclickable.
    const grabRadius = GRAB_RADIUS_PX * worldPerPixel;
    this.grab.scale.set(grabRadius, length, grabRadius);
    this.grab.position.set(0, length / 2, 0);
  }

  /** False while the axis points nearly at the camera; dragging is refused. */
  get isUsable(): boolean {
    return this.usable;
  }

  /** The arrow's axis in world space, sign included. */
  worldAxis(value: number): THREE.Vector3 {
    const dir = new THREE.Vector3(...(this.anchor?.axis ?? [0, 0, 1])).normalize();
    return value < 0 ? dir.negate() : dir;
  }

  dispose(): void {
    this.material.dispose();
    for (const m of [this.shaft, this.head, this.grab]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

/**
 * How far along `axis` the pointer ray has travelled, relative to a drag that
 * started at `startPoint` on that axis.
 *
 * The pointer moves in a plane and the value moves on a line, so the two have
 * to be related somehow. This takes the point on the axis closest to the
 * pointer ray — the standard closest-approach between two skew lines — which
 * is what makes the arrow feel like it is being pulled rather than merely
 * tracking vertical mouse motion.
 *
 * Returns null when the ray is nearly parallel to the axis: the closest point
 * is then unstable and a tiny mouse move would jump the value by metres.
 */
export function projectRayOntoAxis(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  axis: THREE.Vector3,
): number | null {
  const w0 = new THREE.Vector3().subVectors(origin, ray.origin);
  const a = axis.dot(axis);
  const b = axis.dot(ray.direction);
  const c = ray.direction.dot(ray.direction);
  const d = axis.dot(w0);
  const e = ray.direction.dot(w0);

  const denominator = a * c - b * b;
  // sin^2 of the angle between the lines, near zero when they are parallel.
  if (Math.abs(denominator) < 1e-6 * a * c) return null;

  return (b * e - c * d) / denominator;
}
