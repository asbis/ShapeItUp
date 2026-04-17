import * as THREE from "three";
import { THEME } from "./theme";

export function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(THEME.background);

  addLighting(scene);
  addGrid(scene);
  addAxes(scene);

  return scene;
}

export function getAxesGroup(scene: THREE.Scene): THREE.Group | undefined {
  return scene.userData.axesGroup as THREE.Group | undefined;
}

/**
 * Toggle axis visibility; optional targetLength rescales the group so the
 * axes read roughly as long as the model (avoids being invisible or dominant).
 */
export function setAxesVisible(
  scene: THREE.Scene,
  visible: boolean,
  targetLength?: number
) {
  const group = getAxesGroup(scene);
  if (!group) return;
  group.visible = visible;
  if (!visible) return;
  if (targetLength && targetLength > 0) {
    group.scale.setScalar(targetLength / THEME.axisLength);
  } else {
    group.scale.setScalar(1);
  }
}

function addLighting(scene: THREE.Scene) {
  // Ambient fill
  scene.add(new THREE.AmbientLight(THEME.ambientColor, THEME.ambientIntensity));

  // Key light (upper-right-front)
  const keyLight = new THREE.DirectionalLight(
    THEME.keyLightColor,
    THEME.keyLightIntensity
  );
  keyLight.position.set(100, 150, 100);
  scene.add(keyLight);

  // Fill light (lower-left-back)
  const fillLight = new THREE.DirectionalLight(
    THEME.fillLightColor,
    THEME.fillLightIntensity
  );
  fillLight.position.set(-80, -50, -60);
  scene.add(fillLight);

  // Hemisphere (sky/ground)
  scene.add(
    new THREE.HemisphereLight(
      THEME.hemiSkyColor,
      THEME.hemiGroundColor,
      THEME.hemiIntensity
    )
  );
}

function addGrid(scene: THREE.Scene) {
  const grid = new THREE.GridHelper(
    THEME.gridSize,
    THEME.gridDivisions,
    THEME.gridMajor,
    THEME.gridMinor
  );
  // Rotate so grid is on XY plane (Z up) — CAD convention
  grid.rotation.x = Math.PI / 2;
  grid.position.y = 0;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.4;
  scene.add(grid);
}

function addAxes(scene: THREE.Scene) {
  const len = THEME.axisLength;
  const group = new THREE.Group();
  group.name = "axes";

  // X axis (red)
  addAxisLine(group, [0, 0, 0], [len, 0, 0], THEME.axisX);
  addAxisCone(group, [len, 0, 0], [1, 0, 0], THEME.axisX);

  // Y axis (green)
  addAxisLine(group, [0, 0, 0], [0, len, 0], THEME.axisY);
  addAxisCone(group, [0, len, 0], [0, 1, 0], THEME.axisY);

  // Z axis (blue)
  addAxisLine(group, [0, 0, 0], [0, 0, len], THEME.axisZ);
  addAxisCone(group, [0, 0, len], [0, 0, 1], THEME.axisZ);

  scene.add(group);
  scene.userData.axesGroup = group;
}

function addAxisLine(
  parent: THREE.Object3D,
  from: [number, number, number],
  to: [number, number, number],
  color: number
) {
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...from),
    new THREE.Vector3(...to),
  ]);
  const mat = new THREE.LineBasicMaterial({ color });
  parent.add(new THREE.Line(geom, mat));
}

function addAxisCone(
  parent: THREE.Object3D,
  position: [number, number, number],
  direction: [number, number, number],
  color: number
) {
  const coneGeom = new THREE.ConeGeometry(1.5, 5, 12);
  const coneMat = new THREE.MeshBasicMaterial({ color });
  const cone = new THREE.Mesh(coneGeom, coneMat);
  cone.position.set(...position);

  // Orient cone along direction
  const dir = new THREE.Vector3(...direction).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, dir);
  cone.quaternion.copy(quat);

  parent.add(cone);
}
