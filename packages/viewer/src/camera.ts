import * as THREE from "three";
import { ArcballControls } from "three/examples/jsm/controls/ArcballControls.js";

// `@types/three` omits the `target` property on ArcballControls even though
// the runtime implementation exposes one (line 86 of ArcballControls.js:
// `this.target = new Vector3()`). Augment the declared module so callers can
// read/write the orbit pivot directly without `as any` casts.
declare module "three/examples/jsm/controls/ArcballControls.js" {
  interface ArcballControls {
    target: THREE.Vector3;
  }
}

export function createCamera(container: HTMLElement): THREE.PerspectiveCamera {
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
  camera.position.set(80, 80, 80);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  return camera;
}

/**
 * Standalone orthographic camera used for the axis-aligned side-view presets
 * (top/bottom/front/back/left/right). The perspective camera remains the
 * interactive one; this ortho camera is only swapped in when the screenshot
 * pipeline requests a true orthographic projection.
 *
 * Frustum extents are recomputed per capture from the object's bbox (see
 * `frameOrthographicToBounds`), so the initial left/right/top/bottom values
 * are placeholders.
 */
export function createOrthoCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20000);
  cam.up.set(0, 0, 1); // Z-up for CAD
  return cam;
}

/**
 * Position an orthographic camera to capture `object` from `direction`, with
 * the frustum sized to exactly contain the object's bounding sphere plus a
 * small margin. Aspect is respected by widening the shorter frustum axis so
 * the object isn't stretched. `extraBounds` (e.g. the dimension overlay)
 * participates in the framing the same way the perspective path does.
 */
export function frameOrthographicToBounds(
  camera: THREE.OrthographicCamera,
  direction: [number, number, number],
  object: THREE.Object3D,
  aspect: number,
  extraBounds?: THREE.Object3D,
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (extraBounds) {
    const extra = new THREE.Box3().setFromObject(extraBounds);
    if (!extra.isEmpty()) box.union(extra);
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const radius = sphere.radius > 0 ? sphere.radius : 1;

  // 10% margin so labels/edges aren't flush with the frame.
  const extent = radius * 1.1;

  let halfW: number;
  let halfH: number;
  if (aspect >= 1) {
    halfH = extent;
    halfW = extent * aspect;
  } else {
    halfW = extent;
    halfH = extent / aspect;
  }

  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;

  // Position along the requested direction, far enough that the near/far
  // planes always straddle the sphere. An ortho camera's "distance" doesn't
  // affect scale, but it must still bracket the object.
  const dir = new THREE.Vector3(...direction).normalize();
  const dist = radius * 5 + 100;
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.near = 0.1;
  camera.far = dist + radius * 5 + 100;
  camera.lookAt(center);
  camera.up.set(0, 0, 1);
  camera.updateProjectionMatrix();
}

/**
 * True iff `position` points along a principal axis (exactly one component
 * non-zero). Used to decide whether a preset is a "true side view" and
 * should be rendered orthographically.
 */
export function isAxisAligned(position: [number, number, number]): boolean {
  const nonZero = position.filter((c) => c !== 0).length;
  return nonZero === 1;
}

/**
 * ArcballControls gives Fusion-360-style free rotation: no gimbal lock at the
 * poles, zoom-to-cursor, and trackball-style drag. `scene` is passed as null
 * so the built-in gizmo and the built-in double-click-focus behavior are
 * disabled — we render our own compass gnomon and bind our own dblclick
 * handler in index.ts.
 */
export function createControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
): ArcballControls {
  const controls = new ArcballControls(camera, domElement, null);
  controls.cursorZoom = true;
  controls.enableAnimations = true;
  controls.rotateSpeed = 1;
  controls.scaleFactor = 1.1;
  // Placeholders — fitCameraToObject recomputes these from the model's
  // bounding sphere on every frame so tiny parts can be zoomed close and
  // large assemblies can be pulled back.
  controls.minDistance = 0.01;
  controls.maxDistance = 50000;
  return controls;
}

export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: ArcballControls,
  object: THREE.Object3D,
  extraBounds?: THREE.Object3D,
) {
  // `extraBounds` lets callers include auxiliary overlays (e.g. the dimension
  // labels, which are sprites anchored outside the model's bbox). Without it,
  // a tight fit on `object` alone clips those labels on narrow aspect ratios.
  const box = new THREE.Box3().setFromObject(object);
  if (extraBounds) {
    const extra = new THREE.Box3().setFromObject(extraBounds);
    if (!extra.isEmpty()) box.union(extra);
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  const center = sphere.center;
  const radius = sphere.radius;

  if (radius === 0) return;

  const fov = camera.fov * (Math.PI / 180);
  const distance = (radius / Math.sin(fov / 2)) * 1.5;

  const direction = camera.position
    .clone()
    .sub(controls.target)
    .normalize();

  camera.position.copy(center.clone().add(direction.multiplyScalar(distance)));
  controls.target.copy(center);

  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();

  // Derive zoom limits from the fitted radius so a 0.5 mm part stays
  // approachable and a 500 mm assembly can be pulled fully clear.
  controls.minDistance = Math.max(radius / 100, 0.001);
  controls.maxDistance = radius * 200;

  controls.update();
}
