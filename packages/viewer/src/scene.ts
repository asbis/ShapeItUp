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

  // X axis (red)
  addAxisLine(scene, [0, 0, 0], [len, 0, 0], THEME.axisX);
  addAxisCone(scene, [len, 0, 0], [1, 0, 0], THEME.axisX);

  // Y axis (green)
  addAxisLine(scene, [0, 0, 0], [0, len, 0], THEME.axisY);
  addAxisCone(scene, [0, len, 0], [0, 1, 0], THEME.axisY);

  // Z axis (blue)
  addAxisLine(scene, [0, 0, 0], [0, 0, len], THEME.axisZ);
  addAxisCone(scene, [0, 0, len], [0, 0, 1], THEME.axisZ);
}

function addAxisLine(
  scene: THREE.Scene,
  from: [number, number, number],
  to: [number, number, number],
  color: number
) {
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...from),
    new THREE.Vector3(...to),
  ]);
  const mat = new THREE.LineBasicMaterial({ color });
  scene.add(new THREE.Line(geom, mat));
}

function addAxisCone(
  scene: THREE.Scene,
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

  scene.add(cone);
}
