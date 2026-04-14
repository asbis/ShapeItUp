import * as THREE from "three";

export const THEME = {
  background: 0x2d2d30,
  backgroundTop: 0x3a3a3d,

  // Grid
  gridMajor: 0x404045,
  gridMinor: 0x353538,
  gridSize: 200,
  gridDivisions: 20,

  // Axes
  axisX: 0xe04040,
  axisY: 0x40b040,
  axisZ: 0x4080e0,
  axisLength: 50,

  // Model
  modelColor: 0x8899aa,
  modelSpecular: 0xffffff,
  modelShininess: 60,

  // Edges
  edgeColor: 0x1a1a1a,
  edgeWidth: 1,

  // Lighting
  ambientColor: 0x404050,
  ambientIntensity: 0.5,
  keyLightColor: 0xffffff,
  keyLightIntensity: 0.8,
  fillLightColor: 0x8888aa,
  fillLightIntensity: 0.3,
  hemiSkyColor: 0x606070,
  hemiGroundColor: 0x303035,
  hemiIntensity: 0.4,
};

// Palette for multi-part assemblies
export const PART_COLORS = [
  0x8899aa, // steel blue (default)
  0xaa6644, // copper
  0x669966, // sage green
  0x886699, // purple
  0xaa8855, // gold
  0x668899, // teal
  0x996666, // dusty rose
  0x777777, // grey
];

export function createModelMaterial(color?: number | string): THREE.MeshPhongMaterial {
  let c = THEME.modelColor;
  if (typeof color === "number") c = color;
  else if (typeof color === "string") c = new THREE.Color(color).getHex();

  return new THREE.MeshPhongMaterial({
    color: c,
    specular: THEME.modelSpecular,
    shininess: THEME.modelShininess,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export function createEdgeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: THEME.edgeColor,
    linewidth: THEME.edgeWidth,
  });
}
