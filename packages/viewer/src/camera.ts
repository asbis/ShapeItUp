import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function createCamera(container: HTMLElement): THREE.PerspectiveCamera {
  const aspect = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 10000);
  camera.position.set(80, 80, 80);
  camera.lookAt(0, 0, 0);
  return camera;
}

export function createControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement
): OrbitControls {
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  controls.rotateSpeed = 0.8;
  controls.panSpeed = 0.8;
  controls.zoomSpeed = 1.2;
  controls.minDistance = 1;
  controls.maxDistance = 5000;
  return controls;
}

export function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D
) {
  const box = new THREE.Box3().setFromObject(object);
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
  controls.update();

  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
}
