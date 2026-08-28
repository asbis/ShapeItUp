/**
 * Tests for the drag arrow's maths.
 *
 * The interesting part is `projectRayOntoAxis`: it turns a pointer moving in a
 * plane into a distance along a line, and getting it wrong produces a handle
 * that drifts, jumps, or runs backwards — all of which feel like a broken
 * gizmo rather than a wrong number.
 */
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { DragHandle, projectRayOntoAxis } from "./drag-handle";

const ray = (origin: number[], dir: number[]) =>
  new THREE.Ray(
    new THREE.Vector3(...(origin as [number, number, number])),
    new THREE.Vector3(...(dir as [number, number, number])).normalize(),
  );

describe("projectRayOntoAxis", () => {
  const origin = new THREE.Vector3(0, 0, 0);
  const up = new THREE.Vector3(0, 0, 1);

  it("finds where a ray crosses the axis", () => {
    // Looking horizontally at the point 5 units up the Z axis.
    expect(projectRayOntoAxis(ray([10, 0, 5], [-1, 0, 0]), origin, up)).toBeCloseTo(5);
    expect(projectRayOntoAxis(ray([10, 0, -3], [-1, 0, 0]), origin, up)).toBeCloseTo(-3);
  });

  it("uses closest approach when the ray misses the axis", () => {
    // Offset in Y so the ray never touches the Z axis; the nearest point on
    // the axis is still at z = 5.
    expect(projectRayOntoAxis(ray([10, 7, 5], [-1, 0, 0]), origin, up)).toBeCloseTo(5);
  });

  it("is measured from the axis origin, not the world origin", () => {
    const shifted = new THREE.Vector3(0, 0, 100);
    expect(projectRayOntoAxis(ray([10, 0, 105], [-1, 0, 0]), shifted, up)).toBeCloseTo(5);
  });

  it("refuses when the view is nearly along the axis", () => {
    // Here the closest point is wildly sensitive to a pixel of movement, and
    // returning a number would let a twitch throw the dimension across the room.
    expect(projectRayOntoAxis(ray([0, 0, -50], [0, 0, 1]), origin, up)).toBeNull();
    expect(projectRayOntoAxis(ray([0.001, 0, -50], [0.00001, 0, 1]), origin, up)).toBeNull();
  });

  it("tracks a moving pointer monotonically", () => {
    // Dragging the pointer up the screen must move the value one way only.
    const values = [0, 2, 4, 6, 8].map(
      (z) => projectRayOntoAxis(ray([10, 0, z], [-1, 0, 0]), origin, up)!,
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });
});

describe("DragHandle", () => {
  it("starts hidden and shows only once aimed", () => {
    const h = new DragHandle();
    expect(h.visible).toBe(false);
    h.show({ origin: [1, 2, 3], axis: [0, 0, 1] });
    expect(h.visible).toBe(true);
    expect(h.getAnchor()?.origin).toEqual([1, 2, 3]);
    h.hide();
    expect(h.visible).toBe(false);
    expect(h.getAnchor()).toBeNull();
    h.dispose();
  });

  it("flips with the sign, so a push points into the material", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 0, 1] });
    expect(h.worldAxis(5).z).toBeCloseTo(1);
    expect(h.worldAxis(-5).z).toBeCloseTo(-1);
    h.dispose();
  });

  it("keeps a grabbable length at zero", () => {
    // The handle must not vanish exactly when the value passes through 0 —
    // that is the moment the user is most likely to still be holding it.
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 1, 0] });
    h.update(0, 0.1);
    const grab = h.hitTarget as THREE.Mesh;
    expect(grab.scale.y).toBeGreaterThan(0);
    h.dispose();
  });

  it("scales with the camera, not the model", () => {
    // Twice as much world per pixel means twice the world size, so the arrow
    // stays the same size on screen.
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 1, 0] });
    h.update(0, 0.1);
    const near = (h.hitTarget as THREE.Mesh).scale.y;
    h.update(0, 0.2);
    const far = (h.hitTarget as THREE.Mesh).scale.y;
    expect(far).toBeCloseTo(near * 2);
    h.dispose();
  });

  it("lets a large value outgrow the screen-space minimum", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 1, 0] });
    h.update(0, 0.01);
    const atZero = (h.hitTarget as THREE.Mesh).scale.y;
    h.update(50, 0.01);
    expect((h.hitTarget as THREE.Mesh).scale.y).toBeGreaterThan(atZero);
    expect((h.hitTarget as THREE.Mesh).scale.y).toBeCloseTo(50);
    h.dispose();
  });

  it("points where it was aimed", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [1, 0, 0] });
    h.update(10, 0.05);
    const tip = new THREE.Vector3(0, 1, 0).applyQuaternion(h.group.quaternion);
    expect(tip.x).toBeCloseTo(1);
    h.dispose();
  });
});

describe("DragHandle — when the arrow points at the camera", () => {
  /**
   * Looking down the operation axis makes the arrow an unreadable dot, and the
   * closest-approach projection that drives the drag becomes unstable — a
   * pixel of mouse movement would throw the dimension across the room. The
   * handle says so by fading, and refuses the grab.
   */
  it("stays usable at a normal viewing angle", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 0, 1] });
    // Camera looking horizontally at a vertical arrow.
    h.update(5, 0.1, new THREE.Vector3(1, 0, 0));
    expect(h.isUsable).toBe(true);
    h.dispose();
  });

  it("goes unusable once the axis is within ~18 degrees of the view", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 0, 1] });
    h.update(5, 0.1, new THREE.Vector3(0, 0, 1));
    expect(h.isUsable).toBe(false);
    // And recovers when the view swings away again.
    h.update(5, 0.1, new THREE.Vector3(0, 1, 0));
    expect(h.isUsable).toBe(true);
    h.dispose();
  });

  it("judges the angle on the FLIPPED axis for a negative value", () => {
    // A push points the other way; what matters is where the drawn arrow
    // points, not where the face normal does.
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 0, 1] });
    h.update(-5, 0.1, new THREE.Vector3(0, 0, -1));
    expect(h.isUsable).toBe(false);
    h.dispose();
  });

  it("leaves usability alone when no view direction is supplied", () => {
    const h = new DragHandle();
    h.show({ origin: [0, 0, 0], axis: [0, 0, 1] });
    h.update(5, 0.1);
    expect(h.isUsable).toBe(true);
    h.dispose();
  });
});
