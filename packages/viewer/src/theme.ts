import * as THREE from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

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

  // Selection. Two strengths, the way a CAD app distinguishes "the cursor is
  // over this" from "this is what your next command will act on": hover is a
  // hint you can ignore, selection is a commitment you can act on.
  hoverColor: 0x6fb3ff,
  hoverOpacity: 0.32,
  selectColor: 0x2f9bff,
  selectOpacity: 0.55,
  // Edge overlays need their own hue. Part colours are user-chosen, and the
  // selection blue above disappears entirely against the default blue-grey
  // part — a highlighted edge you cannot see is not a highlight. Cyan is
  // high-luminance and rare in the muted part palette, so it reads on top of
  // anything, including the dark background.
  edgeSelectColor: 0x00e5ff,
  edgeHoverColor: 0x7fe9ff,
  // Widths in PIXELS, not world units — see createEdgeHighlightMaterial for
  // why these cannot be plain THREE.Line widths.
  edgeSelectWidth: 4,
  edgeHoverWidth: 3,

  // The added / removed ghost. Blue for material appearing, red for material
  // going away — the pairing a CAD user reads without being told, and the one
  // Fusion uses for join versus cut.
  // Saturated on purpose. The part palette is deliberately muted, so a ghost
  // in the same register vanishes against it — a blue delta on the default
  // blue-grey part was invisible the first time this was tried.
  deltaAddedColor: 0x1e90ff,
  deltaRemovedColor: 0xff3b30,
  deltaAddedEmissive: 0x0b3a66,
  deltaRemovedEmissive: 0x5a1512,
  deltaOpacity: 0.55,

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

// Palette for multi-part assemblies.
// ColorBrewer Set2 (pastel) + Dark2 (saturated) — 16 perceptually distinguishable
// hues. Chosen to remain legible on the dark viewer background while keeping the
// muted, non-neon tone of the prior palette. Cycled when parts don't specify a
// color; large assemblies (12+ parts) get unique colors per part.
export const PART_COLORS = [
  0x66c2a5, // Set2 teal
  0xfc8d62, // Set2 orange
  0x8da0cb, // Set2 blue-violet
  0xe78ac3, // Set2 pink
  0xa6d854, // Set2 lime
  0xffd92f, // Set2 yellow
  0xe5c494, // Set2 tan
  0xb3b3b3, // Set2 grey
  0x1b9e77, // Dark2 deep teal
  0xd95f02, // Dark2 burnt orange
  0x7570b3, // Dark2 indigo
  0xe7298a, // Dark2 magenta
  0x66a61e, // Dark2 olive-green
  0xe6ab02, // Dark2 mustard
  0xa6761d, // Dark2 bronze
  0x666666, // Dark2 charcoal
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

/**
 * Material for the overlay drawn on top of a hovered or selected face.
 *
 * Drawn as a separate mesh sitting exactly on the model's own triangles, so
 * it needs `polygonOffset` to win the depth fight — without it the two
 * coplanar surfaces z-fight and the highlight stipples. The offset is
 * NEGATIVE (toward the camera) where the model material's is positive, which
 * is what pushes the highlight in front rather than behind.
 *
 * `depthWrite: false` keeps the translucent overlay from occluding anything
 * drawn after it, and `side: DoubleSide` means a face still highlights when
 * the camera is inside the solid or looking at a shell from behind.
 */
export function createHighlightMaterial(mode: "hover" | "select"): THREE.MeshBasicMaterial {
  const selected = mode === "select";
  return new THREE.MeshBasicMaterial({
    color: selected ? THEME.selectColor : THEME.hoverColor,
    transparent: true,
    opacity: selected ? THEME.selectOpacity : THEME.hoverOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * Material for a highlighted edge.
 *
 * A `THREE.LineBasicMaterial` cannot do this: its `linewidth` is WebGL's
 * `lineWidth`, which nearly every implementation clamps to 1 px, so the
 * property is silently ignored and every highlight comes out hairline. Three's
 * `LineMaterial` sidesteps the clamp by expanding each segment into a
 * camera-facing quad in the vertex shader, where `linewidth` is a real uniform
 * measured in pixels.
 *
 * The cost is `resolution`: the shader converts pixels to clip space itself,
 * so it has to be told the drawing-buffer size, and a stale value makes lines
 * the wrong thickness. The render loop syncs it — see syncEdgeHighlightWidths.
 */
export function createEdgeHighlightMaterial(mode: "hover" | "select"): LineMaterial {
  const selected = mode === "select";
  return new LineMaterial({
    color: selected ? THEME.edgeSelectColor : THEME.edgeHoverColor,
    linewidth: selected ? THEME.edgeSelectWidth : THEME.edgeHoverWidth,
    // Pixels, not millimetres: a highlight should stay legible at any zoom,
    // where a world-unit width would vanish as you pull back.
    worldUnits: false,
    transparent: true,
    opacity: selected ? 0.95 : 0.8,
    // The point of a highlight is to be seen, including where the edge is
    // behind the surface it belongs to.
    depthTest: false,
  });
}

/**
 * Push the current drawing-buffer size into every edge-highlight material in
 * `group`.
 *
 * Called once per frame rather than hooked to a resize event, because the
 * renderer is resized from several places — the window handler, and the
 * screenshot path that swaps in a fixed resolution and back. One sync in the
 * render loop is correct for all of them, and the group holds at most a
 * handful of objects.
 */
export function syncEdgeHighlightWidths(group: THREE.Object3D, width: number, height: number): void {
  group.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (material instanceof LineMaterial) material.resolution.set(width, height);
  });
}

/**
 * Material for the ghost of what an operation adds or removes.
 *
 * Drawn double-sided because a delta is often a thin shell you end up looking
 * into, and with `depthWrite` off so it tints the model behind it rather than
 * punching a hole in it.
 */
export function createDeltaMaterial(mode: "added" | "removed"): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: mode === "added" ? THEME.deltaAddedColor : THEME.deltaRemovedColor,
    // Emissive so the ghost keeps its identity in shadow: an unlit face of a
    // translucent overlay would otherwise go the same near-black as the model.
    emissive: mode === "added" ? THEME.deltaAddedEmissive : THEME.deltaRemovedEmissive,
    transparent: true,
    opacity: THEME.deltaOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    shininess: 20,
  });
}
