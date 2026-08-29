import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { createScene, setAxesVisible } from "./scene";
import {
  createCamera,
  createControls,
  createOrthoCamera,
  fitCameraToObject,
  frameOrthographicToBounds,
  isAxisAligned,
} from "./camera";
import { buildMesh, buildEdges } from "./mesh-builder";
import { createDeltaMaterial, syncEdgeHighlightWidths } from "./theme";
import { DragHandle, projectRayOntoAxis } from "./drag-handle";
import { ViewCube } from "./view-cube";
import {
  FacePicker,
  buildEdgesHighlight,
  describeKind,
  describePlacement,
  edgesInPlane,
  faceBounds,
  findMatchingEdge,
  findMatchingFace,
  operationAxis,
  operationOrigin,
  tangentChain,
  formatFaceArea,
  formatTriple,
  type FaceSelection,
  type PickablePart,
} from "./selection";
import { initMessageHandler, onMessage, postToExtension } from "./message-handler";
import type { WorkerToWebview, TessellatedPart, DetectedApp } from "@shapeitup/shared";
import { synthesizeEdgeSelector, synthesizeFaceSelector } from "@shapeitup/shared";
import type {
  CombineStatsMessage,
  PreviewArrange,
  PreviewCombine,
  PreviewDelta,
  PreviewFaceOp,
} from "@shapeitup/shared";
import { PART_COLORS } from "./theme";
import { setupSim, updateSim, clearSim, initSimPanel, toggleSimPanel } from "./sim-panel";

// --- Locale-invariant numeric formatting ---------------------------------
// Screenshots are an agent-facing output channel, so dimension labels must
// render identically regardless of the user's OS locale. A European locale
// (e.g. nb-NO) would otherwise render "80,0mm" via the implicit locale path
// in template literals / `toLocaleString()` defaults. We pin every visible
// numeric label to en-US and add the "mm" suffix here.
function formatMm(n: number, digits = 1): string {
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
  return `${s}mm`;
}

// Same as formatMm but without the "mm" suffix — for places like the
// parameter-slider readout where the unit is implicit from the label.
function formatNum(n: number, digits = 1): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

// DOM elements
const container = document.getElementById("canvas-container")!;
const loadingEl = document.getElementById("loading")!;
const statusEl = document.getElementById("status")!;
const filenameEl = document.getElementById("filename")!;
const partsPanel = document.getElementById("parts-panel")!;
const partsList = document.getElementById("parts-list")!;
const partsCount = document.getElementById("parts-count")!;

// Three.js setup
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const scene = createScene();
const camera = createCamera(container);
const controls = createControls(camera, renderer.domElement);

// Secondary orthographic camera used only by the screenshot pipeline when a
// true side-view preset is selected (top/bottom/front/back/left/right). The
// interactive perspective `camera` above stays the live viewport camera so
// OrbitControls and the render loop behave as before.
const orthoCamera = createOrthoCamera();

const modelGroup = new THREE.Group();
scene.add(modelGroup);

// Highlight overlays live in their own group, not inside the part groups.
// Keeping them out means hiding a part via the Components tree cannot leave a
// stranded highlight behind, and clearModelGroup's dispose walk does not have
// to know about them.
const overlayGroup = new THREE.Group();
scene.add(overlayGroup);

/** Scratch vector for reading the drawing-buffer size each frame. */
const renderSize = new THREE.Vector2();
/** Scratch vector for the camera's forward direction, read each frame. */
const cameraForward = new THREE.Vector3();

/**
 * The drag arrow. It sits in the overlay group so it is disposed and hidden
 * with everything else when the model is replaced.
 */
const dragHandle = new DragHandle();
overlayGroup.add(dragHandle.group);

// --- Compass / gnomon overlay --------------------------------------------
// A small RGB axis indicator pinned to the lower-right corner so agents can
// read orientation directly from a screenshot. The overlay lives in its own
// scene + orthographic camera; the main render loop disables autoClear and
// draws this last with clearDepth() so it composites on top of the model.
//
// The overlay camera sits at a fixed offset from origin and always points
// AT origin; each frame we copy the main camera's quaternion onto it so the
// gnomon rotates in lockstep with the viewport. (Copying position instead
// of quaternion would keep the axes fixed relative to the world rather than
// the view — the opposite of what you want.)
let showCompass = true;
const gnomonScene = new THREE.Scene();
const gnomonCamera = new THREE.OrthographicCamera(-1.2, 1.2, 1.2, -1.2, 0.1, 10);
gnomonCamera.position.set(0, 0, 3);
gnomonCamera.lookAt(0, 0, 0);
const gnomonAxes = new THREE.AxesHelper(0.8);
// Boost axis colors so they stay readable on both the dark and AI backgrounds.
// AxesHelper.setColors wasn't added until r152; guard for older typings.
if (typeof (gnomonAxes as any).setColors === "function") {
  (gnomonAxes as any).setColors(
    new THREE.Color(0xff3333),
    new THREE.Color(0x33cc33),
    new THREE.Color(0x3388ff),
  );
}
gnomonScene.add(gnomonAxes);

// Letter sprites at the tip of each axis. Canvas-based so we don't need an
// external font asset. Same sizeAttenuation:false trick keeps the letters
// screen-space-constant inside the gnomon viewport.
function makeGnomonLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.font = "bold 48px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false });
  const s = new THREE.Sprite(mat);
  s.scale.set(0.2, 0.2, 1);
  return s;
}
const gnomonLabelX = makeGnomonLabel("X", "#ff3333");
gnomonLabelX.position.set(0.95, 0, 0);
const gnomonLabelY = makeGnomonLabel("Y", "#33cc33");
gnomonLabelY.position.set(0, 0.95, 0);
const gnomonLabelZ = makeGnomonLabel("Z", "#3388ff");
gnomonLabelZ.position.set(0, 0, 0.95);
gnomonScene.add(gnomonLabelX, gnomonLabelY, gnomonLabelZ);

// The gnomon is also a 6-way navigator: the three +axis labels plus three
// invisible hit spheres on the -axis ends. The spheres are opacity:0 but still
// raycastable, so -X/-Y/-Z are reachable without visual clutter, and each hit
// proxy carries the camera preset on `userData.preset`.
//
// The ViewCube below has since taken over as the primary navigator — it offers
// all 26 directions rather than 6, and it reads as an orientation rather than
// as three lines. This stays because it is the thing that survives into a
// SCREENSHOT, where an agent needs axis colours and directions rather than
// something to click.
gnomonLabelX.userData.preset = [1, 0, 0];   // click +X → right view
gnomonLabelY.userData.preset = [0, 1, 0];   // click +Y → back view
gnomonLabelZ.userData.preset = [0, 0, 1];   // click +Z → top view
function makeGnomonHitProxy(position: THREE.Vector3, preset: [number, number, number]): THREE.Mesh {
  const geo = new THREE.SphereGeometry(0.15, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(position);
  mesh.userData.preset = preset;
  return mesh;
}
const gnomonHitNegX = makeGnomonHitProxy(new THREE.Vector3(-0.95, 0, 0), [-1, 0, 0]);
const gnomonHitNegY = makeGnomonHitProxy(new THREE.Vector3(0, -0.95, 0), [0, -1, 0]);
const gnomonHitNegZ = makeGnomonHitProxy(new THREE.Vector3(0, 0, -0.95), [0, 0, -1]);
gnomonScene.add(gnomonHitNegX, gnomonHitNegY, gnomonHitNegZ);

const GNOMON_SIZE = 80;
const GNOMON_MARGIN = 10;
const gnomonRaycaster = new THREE.Raycaster();
const gnomonMouse = new THREE.Vector2();

function tryGnomonClick(event: MouseEvent): boolean {
  if (!showCompass) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;

  // Gnomon viewport spans the bottom-right square of the canvas, in CSS
  // (top-left origin) coords:
  //   x ∈ [rect.width - MARGIN - SIZE, rect.width - MARGIN]
  //   y ∈ [rect.height - MARGIN - SIZE, rect.height - MARGIN]
  const gnomonLeft = rect.width - GNOMON_MARGIN - GNOMON_SIZE;
  const gnomonTop = rect.height - GNOMON_MARGIN - GNOMON_SIZE;
  const u = (localX - gnomonLeft) / GNOMON_SIZE;   // 0 = left edge, 1 = right edge
  const v = (localY - gnomonTop) / GNOMON_SIZE;    // 0 = top edge, 1 = bottom edge
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;

  // Convert the local (u, v) to NDC for the gnomon's own camera. NDC y is
  // flipped because the gnomon viewport, like the main canvas, uses
  // bottom-left origin in GL but we measured v from the top.
  gnomonMouse.x = u * 2 - 1;
  gnomonMouse.y = 1 - v * 2;

  gnomonRaycaster.setFromCamera(gnomonMouse, gnomonCamera);
  const targets = [gnomonLabelX, gnomonLabelY, gnomonLabelZ, gnomonHitNegX, gnomonHitNegY, gnomonHitNegZ];
  const hits = gnomonRaycaster.intersectObjects(targets, false);
  if (hits.length === 0) return false;
  const preset = hits[0].object.userData.preset as [number, number, number] | undefined;
  if (!preset) return false;
  setCameraAngle(preset);
  return true;
}

// Draw the gnomon on top of whatever was just rendered into `renderer`.
// Caller must have already rendered the main scene; we only add the overlay.
// Invariants on exit: viewport restored to full target size, autoClear left
// enabled (we disable it only for the duration of the main animate() render).
function renderGnomon(targetW: number, targetH: number) {
  if (!showCompass) return;
  // Mirror the main camera's orientation so the axes rotate with the view.
  // Position stays fixed on the +Z axis so the camera always "looks back"
  // toward origin; only the rotation is taken from the main camera.
  gnomonCamera.quaternion.copy(camera.quaternion);
  // The main camera is oriented such that its default forward is -Z. We
  // want the gnomon camera to inherit that, placed out on the inherited
  // -forward axis so (world origin) is centered in its view. Compute the
  // gnomon position by pushing out along the camera's local +Z in world
  // space (i.e. the direction away from where it's looking).
  const backward = new THREE.Vector3(0, 0, 1).applyQuaternion(gnomonCamera.quaternion);
  gnomonCamera.position.copy(backward.multiplyScalar(3));
  gnomonCamera.updateMatrixWorld();

  // GNOMON_SIZE × GNOMON_SIZE viewport in the lower-right with GNOMON_MARGIN
  // padding. In screenshot mode the caller resizes the renderer to
  // targetW/H first, so using those values (not container.clientWidth) pins
  // the gnomon to the correct corner of the captured frame rather than the
  // live viewport. `tryGnomonClick` reuses the same constants to hit-test.
  const size = GNOMON_SIZE;
  const margin = GNOMON_MARGIN;
  const prevViewport = new THREE.Vector4();
  renderer.getViewport(prevViewport);
  const prevScissorTest = renderer.getScissorTest();

  renderer.setViewport(targetW - size - margin, margin, size, size);
  renderer.setScissor(targetW - size - margin, margin, size, size);
  renderer.setScissorTest(true);
  renderer.clearDepth();
  renderer.render(gnomonScene, gnomonCamera);

  // Restore viewport/scissor so the next frame's main render isn't clipped
  // to the gnomon rectangle.
  renderer.setViewport(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
  renderer.setScissor(prevViewport.x, prevViewport.y, prevViewport.z, prevViewport.w);
  renderer.setScissorTest(prevScissorTest);
}

// autoClear:false lets us composite the gnomon on top of the main scene
// without it wiping the color buffer. We clear manually in animate().
renderer.autoClear = false;

// State
let edgesVisible = true;
let wireframe = false;
let partsPanelOpen = false;
// Axes start visible (matches legacy behavior where they were always drawn).
let axesVisible = true;

// Track part info for the browser panel
interface PartInfo {
  name: string;
  color: string;
  visible: boolean;
  group: THREE.Group;
  /**
   * Picking surface. `mesh` is the raycast target; `vertices` / `triangles`
   * are kept so a highlight overlay can be cut from the same buffers the
   * renderer is already using, and `faceGroups` / `faceInfo` say which
   * triangles are which face. The last two are absent for Manifold parts,
   * which have no B-Rep faces — those render but do not pick.
   */
  mesh: THREE.Mesh;
  vertices: Float32Array;
  triangles: Uint32Array;
  faceGroups?: Uint32Array;
  faceInfo?: TessellatedPart["faceInfo"];
  /** Edge lines and their spans — the raycast target and preview source. */
  edgeLines?: THREE.LineSegments;
  edgeVertices?: Float32Array;
  edgeGroups?: Uint32Array;
  /**
   * Centre of the OCCT bounding box — what `shape.boundingBox.center` returns
   * in the file. The Rotate command's pivot, and it has to be OCCT's number
   * rather than the mesh's own bounds so the live preview turns about exactly
   * the point the written expression will.
   */
  boundsCenter?: [number, number, number];
  /** Measured on the OCCT shape, not the mesh. Absent on degenerate geometry. */
  volume?: number;
  surfaceArea?: number;
  centerOfMass?: [number, number, number];
  /** Tree disclosure state, kept across re-renders of the list. */
  expanded?: boolean;
}
let currentParts: PartInfo[] = [];

// --- Error handlers ---
window.onerror = (msg, source, line, col, error) => {
  const text = `${msg} (${source}:${line}:${col})`;
  postToExtension({ type: "error", message: text });
  statusEl.textContent = `Error: ${msg}`;
  console.error("[ShapeItUp]", text, error);
};

window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message || String(e.reason);
  postToExtension({ type: "error", message: `Unhandled promise: ${msg}` });
  statusEl.textContent = `Error: ${msg}`;
  console.error("[ShapeItUp] Unhandled rejection:", e.reason);
});

// --- Face picking ---------------------------------------------------------
// Hover previews what a click would select; a click commits to it. The panel
// under the view toolbar reports what OCCT actually says about that face,
// which is more than the mesh alone could tell you — a cylinder's mesh is
// triangles, but its FACE is a cylinder, and that distinction is what a later
// step needs in order to write a durable selector into the source file.
const facePicker = new FacePicker(
  overlayGroup,
  camera,
  () => currentParts as PickablePart[],
);

/**
 * What the FILE declares, which is what the host synthesises a selector
 * against. Distinct from the effective values driving the render: drag a
 * parameter without committing it and the two diverge, and previewing the
 * effective one would promise a binding the host will not make.
 */
let declaredParamValues: Record<string, number> = {};

const faceInfoEl = document.getElementById("face-info")!;
const fiKindEl = document.getElementById("fi-kind")!;
const fiMetaEl = document.getElementById("fi-meta")!;
const fiCodeEl = document.getElementById("fi-code")!;
const fiNotesEl = document.getElementById("fi-notes")!;
const fiToolsEl = document.getElementById("fi-tools") as HTMLElement;
const fiFormEl = document.getElementById("fi-form") as HTMLElement;
const fiDistEl = document.getElementById("fi-dist") as HTMLInputElement;
const fiExtrudeEl = document.getElementById("fi-extrude") as HTMLButtonElement;
const fiFilletEl = document.getElementById("fi-fillet") as HTMLButtonElement;
const fiChamferEl = document.getElementById("fi-chamfer") as HTMLButtonElement;
const fiShellEl = document.getElementById("fi-shell") as HTMLButtonElement;
const fiOpEl = document.getElementById("fi-op")!;
const fiApplyEl = document.getElementById("fi-apply") as HTMLButtonElement;
const fiBackEl = document.getElementById("fi-back") as HTMLButtonElement;
const fiLookAtEl = document.getElementById("fi-lookat") as HTMLButtonElement;
const fiClearEl = document.getElementById("fi-clear") as HTMLButtonElement;

type FaceOpKind = "extrude" | "fillet" | "chamfer" | "shell";

/**
 * Picking an operation swaps the bar's tools for a distance field and shows
 * the line that will be written. A mode rather than three always-visible
 * fields, so the resting state stays one short line.
 */
let activeOp: FaceOpKind | null = null;

/**
 * The target an armed operation acts on, captured when it is armed.
 *
 * Held separately from the picker's live selection because a PREVIEW rebuilds
 * the model, and a rebuilt model has no idea which face you had picked — the
 * geometry it describes has just changed, which was the point. Freezing the
 * descriptor here lets the preview redraw underneath an operation that stays
 * open, sized, and committable.
 */
type ArmedTarget =
  | { kind: "face"; partName: string; info: NonNullable<TessellatedPart["faceInfo"]>[number] }
  | { kind: "edge"; partName: string; point: [number, number, number] };

let armedTarget: ArmedTarget | null = null;

/** The script last executed WITHOUT a preview, so a cancel can restore it. */
let previewBaseJs: string | null = null;
let previewShowing = false;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const OP_DEFAULTS: Record<FaceOpKind, string> = {
  extrude: "5",
  // A wall you would actually print: three perimeters at 0.4mm, which is what
  // most enclosures want and what a slicer will not thin out.
  shell: "1.6",
  // A fillet or chamfer big enough to see, small enough to rarely fail on a
  // first try — an over-large radius is the usual reason OCCT refuses one.
  fillet: "2",
  chamfer: "1",
};

const OP_LABEL: Record<FaceOpKind, string> = {
  extrude: "Extrude",
  shell: "Shell",
  fillet: "Fillet",
  chamfer: "Chamfer",
};

function setActiveOp(op: FaceOpKind | null): void {
  activeOp = op;
  faceInfoEl.classList.toggle("extruding", op !== null);
  fiToolsEl.hidden = op !== null;
  fiFormEl.hidden = op === null;
  clearEdgePreview();
  if (!op) {
    dragHandle.hide();
    clearDeltaGhost();
    const wasArmed = armedTarget;
    armedTarget = null;
    // A revert restores identical geometry, so the picked face is genuinely
    // there again — just under a new mesh. Re-find it rather than making the
    // user hunt for it because they changed their mind.
    if (revertPreview()) pendingReselect = wasArmed;
    return;
  }

  // Freeze what the operation acts on. Everything downstream reads this rather
  // than the live selection, which a preview rebuild will wipe.
  const sel = facePicker.getSelection();
  opMaxRadius = null;
  opMaxKey = "";
  armedTarget = !sel
    ? null
    : sel.kind === "face"
      ? { kind: "face", partName: sel.partName, info: sel.info }
      : { kind: "edge", partName: sel.partName, point: sel.point };

  fiOpEl.textContent = OP_LABEL[op];
  fiDistEl.value = OP_DEFAULTS[op];
  fiDistEl.title =
    op === "extrude"
      ? "Positive pulls the face out, negative pushes it in"
      : op === "shell"
        ? "Wall thickness, in millimetres — the body is hollowed inward"
        : "Radius, in millimetres";
  // Render before focusing: the preview IS the feature, and leaving it blank
  // until the user types means the first thing they see is an empty promise.
  renderOpPreview();
  placeDragHandle();
  schedulePreview();
  fiDistEl.focus();
  fiDistEl.select();
}

/**
 * Aim the drag arrow at the current selection, or hide it when there is
 * nothing to aim at.
 *
 * The anchor is transformed by the part's world matrix for the same reason the
 * highlight overlays are: the overlay group is a sibling of the part groups,
 * so a part the motion sim has moved would otherwise leave its handle behind.
 */
function armedPart(): PickablePart | undefined {
  if (!armedTarget) return undefined;
  // By NAME, not index: a preview rebuild replaces every part object, and an
  // index that happened to survive would be luck rather than correctness.
  const byName = currentParts.find((p) => p.name === armedTarget!.partName);
  return (byName ?? currentParts[0]) as PickablePart | undefined;
}

/**
 * Aim the drag arrow at the armed operation.
 *
 * The anchor stays where the drag started even as a preview moves the geometry
 * under it — it marks the face you picked, not the face's current position,
 * which is what keeps the handle from running away from the cursor.
 */
function placeDragHandle(): void {
  const sel = facePicker.getSelection();
  const part = armedPart();
  if (!armedTarget || !part || !activeOp) {
    dragHandle.hide();
    return;
  }
  const m = part.mesh.matrixWorld;
  const origin = new THREE.Vector3(
    ...(armedTarget.kind === "face" ? armedTarget.info.center : armedTarget.point),
  ).applyMatrix4(m);

  // The axis needs the live selection's edge data; for a face the normal is
  // already in the frozen descriptor.
  const axisLocal =
    armedTarget.kind === "face"
      ? (armedTarget.info.normal ?? [0, 0, 1])
      : sel && sel.kind === "edge"
        ? operationAxis(part, sel)
        : lastArmedAxis;
  lastArmedAxis = axisLocal;

  const axis = new THREE.Vector3(...axisLocal).transformDirection(m).normalize();
  dragHandle.show({
    origin: [origin.x, origin.y, origin.z],
    axis: [axis.x, axis.y, axis.z],
  });
}

/** Remembered so an edge's handle keeps its aim once the picker is cleared. */
let lastArmedAxis: [number, number, number] = [0, 0, 1];

function updateFaceInfoPanel(): void {
  // Combine owns the model while it is armed. Falling through here would
  // reach `setActiveOp(null)` below, whose job is to put a face operation's
  // preview back — and it would put the COMBINE preview back too, one frame
  // after it rendered. That is exactly what happened: the measurements
  // arrived and were correct, the bodies merged, and the revert undid it
  // before anyone saw it.
  if (combineOp || moveMode || arrangeMode) return;
  const sel = facePicker.getSelection();
  if (!sel) {
    // A preview rebuilds the model and so clears the picker. An armed
    // operation outlives that: it holds its own frozen target, and closing the
    // panel underneath the user mid-drag would be the opposite of a preview.
    if (activeOp && armedTarget) return;
    faceInfoEl.classList.remove("visible");
    setActiveOp(null);
    return;
  }

  const bits: string[] = [];
  let writable: boolean;
  let why: string | null = null;

  if (sel.kind === "face") {
    const { info } = sel;
    fiKindEl.textContent = describeKind(info.kind);
    const placement = describePlacement(info);
    if (placement) bits.push(placement);
    if (currentParts.length > 1) bits.push(sel.partName);
    if (typeof info.area === "number") bits.push(`<b>${formatFaceArea(info.area)}</b>`);
    faceInfoEl.title =
      `Center ${formatTriple(info.center)}` +
      (info.normal ? `\nNormal ${formatTriple(info.normal, 2)}` : "");
    fiLookAtEl.disabled = !info.normal;
    writable = buildSelectorPreview(sel) !== null;
    if (!writable) {
      why = "This face is not parallel to a standard plane, so there is no stable way to name it in code yet";
    }
  } else {
    fiKindEl.textContent = sel.straight ? "Edge" : "Curved edge";
    bits.push(`<b>${sel.length.toFixed(1)} mm</b>`);
    if (currentParts.length > 1) bits.push(sel.partName);
    faceInfoEl.title = `On the edge at ${formatTriple(sel.point)}`;
    // Nothing to look down: an edge has no normal.
    fiLookAtEl.disabled = true;
    writable = true;
  }

  fiMetaEl.innerHTML = bits.join(" · ");

  // An edge can be rounded but neither extruded nor shelled — pushing a line
  // along "its normal" and hollowing a body "through a line" are both
  // meaningless, so both buttons go grey rather than failing on click.
  for (const [btn, edgeTip, faceTip] of [
    [fiExtrudeEl, "An edge cannot be extruded — pick a face", "Push or pull this face along its normal"],
    [fiShellEl, "An edge cannot be shelled — pick the face to open", "Hollow the body, leaving this face open"],
  ] as const) {
    btn.disabled = !writable || sel.kind === "edge";
    btn.title = sel.kind === "edge" ? edgeTip : (why ?? faceTip);
  }
  for (const [btn, tip] of [
    [fiFilletEl, sel.kind === "edge" ? "Round this edge" : "Round the edges around this face"],
    [fiChamferEl, sel.kind === "edge" ? "Bevel this edge" : "Bevel the edges around this face"],
  ] as const) {
    btn.disabled = !writable;
    btn.title = why ?? tip;
  }

  if (activeOp) {
    renderOpPreview();
    placeDragHandle();
  }
  faceInfoEl.classList.add("visible");
}

// ── Edge preview ──────────────────────────────────────────────────────────
// A fillet radius typed into a box is a guess about which edges you meant.
// Highlighting them turns it into something you can count before committing.
let edgePreview: THREE.Object3D | null = null;

function clearEdgePreview(): void {
  if (!edgePreview) return;
  overlayGroup.remove(edgePreview);
  const mesh = edgePreview as THREE.Mesh;
  mesh.geometry?.dispose?.();
  if (mesh.material instanceof THREE.Material) mesh.material.dispose();
  edgePreview = null;
}

/** Draw the given edges of a part as the pending-operation overlay. */
function showEdgeSet(partIndex: number, indices: number[]): void {
  clearEdgePreview();
  const part = currentParts[partIndex] as PickablePart | undefined;
  if (!part) return;
  const lines = buildEdgesHighlight(part, indices);
  if (!lines) return;
  lines.applyMatrix4(part.mesh.matrixWorld);
  overlayGroup.add(lines);
  edgePreview = lines;
}

/** Highlight the edges a face-driven fillet/chamfer would touch; returns how many. */
function showEdgePreview(sel: FaceSelection, plane: string, offset: number): number {
  const part = currentParts[sel.partIndex] as PickablePart | undefined;
  if (!part) {
    clearEdgePreview();
    return 0;
  }
  const indices = edgesInPlane(part, plane, offset, faceBounds(part, sel));
  showEdgeSet(sel.partIndex, indices);
  return indices.length;
}

/**
 * The selector the host would synthesise for a picked face. All three
 * operations name the FACE — fillet and chamfer resolve its boundary at build
 * time — so there is one selector, not one per operation.
 */
function buildSelectorPreview(sel: FaceSelection) {
  return buildSelectorPreviewFor(sel.info);
}

function buildSelectorPreviewFor(info: FaceSelection["info"]) {
  const r = synthesizeFaceSelector(info, declaredParamValues);
  return r.ok ? r.selector : null;
}

function renderOpPreview(): void {
  const sel = armedTarget;
  if (!sel || !activeOp) {
    fiCodeEl.textContent = "";
    fiNotesEl.textContent = "";
    clearEdgePreview();
    return;
  }
  fiNotesEl.textContent = "";
  const d = parseDistance();
  const dist = d === null ? "…" : String(d);
  const target = currentParts.length > 1 ? sel.partName : "shape";

  let durable: boolean;
  let derived = false;
  const notes: { text: string; warn: boolean }[] = [];

  if (sel.kind === "edge") {
    const selector = synthesizeEdgeSelector(sel.point, declaredParamValues);
    const fn = activeOp === "fillet" ? "filletEdge" : "chamferEdge";
    fiCodeEl.textContent = `${fn}(${target}, ${selector.code}, ${dist})`;
    durable = selector.durable;
    derived = selector.derived;

    // OCCT carries a fillet along edges that meet smoothly, so on a rounded
    // outline one click rounds the whole loop. Show the chain, not the click.
    // Only while the live selection still exists — a preview rebuild replaces
    // the mesh those indices refer to, and the geometry itself now shows the
    // result anyway.
    const live = facePicker.getSelection();
    const part = armedPart();
    const chain =
      live && live.kind === "edge" && part ? tangentChain(part, live.edgeIndex) : [];
    if (part && chain.length > 0) showEdgeSet(currentParts.indexOf(part as any), chain);
    if (chain.length > 1) {
      notes.push({
        text: `→ ${chain.length} edges — they meet smoothly, so the round carries across`,
        warn: false,
      });
    }
  } else {
    const selector = buildSelectorPreviewFor(sel.info);
    if (!selector) {
      fiCodeEl.textContent = "";
      clearEdgePreview();
      return;
    }
    const fn =
      activeOp === "extrude"
        ? "extrudeFace"
        : activeOp === "shell"
          ? "shellFace"
          : activeOp === "fillet"
            ? "filletFace"
            : "chamferFace";
    fiCodeEl.textContent = `${fn}(${target}, ${selector.code}, ${dist})`;
    durable = selector.durable;
    derived = selector.derived === true;

    if (activeOp === "extrude") {
      clearEdgePreview();
    } else {
      // The offset the VIEWER matches on is the raw number, not the parameter
      // name — the name is what gets written, the number is what it evaluates to.
      const live = facePicker.getSelection();
      const n =
        live && live.kind === "face"
          ? showEdgePreview(live, selector.plane, selector.offset)
          : -1;
      if (n === 0) {
        notes.push({ text: "⚠ this face has no boundary edges to round", warn: true });
      } else if (n > 0) {
        notes.push({ text: `→ ${n} edge${n === 1 ? "" : "s"}`, warn: false });
      }
    }
  }

  if (activeOp !== "extrude" && opMaxRadius !== null) {
    const ceiling = safeMaxRadius()!;
    if (ceiling <= 0) {
      notes.push({ text: "⚠ nothing here can be rounded at any radius", warn: true });
    } else {
      const over = (parseDistance() ?? 0) > ceiling + 1e-9;
      notes.push({
        text: over
          ? `⚠ over the limit — OCCT refuses more than ${ceiling.toFixed(1)} mm here`
          : `max ${ceiling.toFixed(1)} mm`,
        warn: over,
      });
    }
  }

  if (!durable) {
    notes.push({
      // A literal is correct now and silently stops matching the moment the
      // model moves. The user is about to write it; they should know which
      // kind of line they are getting.
      text: "⚠ fixed numbers — no parameter matched, so this breaks if the model moves",
      warn: true,
    });
  } else if (derived) {
    notes.push({
      // Half-dimension bindings are a reading of intent, not an equality.
      text: "⚠ read as half a parameter — check that is what you meant",
      warn: true,
    });
  }

  for (const n of notes) {
    const el = document.createElement("span");
    if (n.warn) el.className = "warn";
    el.textContent = n.text;
    fiNotesEl.appendChild(el);
  }
}

// ── The added / removed ghost ─────────────────────────────────────────────
// Blue for material appearing, red for material going away. Only extrude gets
// one: its prism IS the delta, so showing it costs nothing. A fillet's delta
// is a thin sliver whose `base.cut(result)` boolean measured ~690 ms on an
// 80x60 plate — too slow to compute while someone is dragging, and the cyan
// edge highlight already says which edges are affected.

let deltaGhost: THREE.Mesh | null = null;

function clearDeltaGhost(): void {
  if (!deltaGhost) return;
  overlayGroup.remove(deltaGhost);
  deltaGhost.geometry.dispose();
  (deltaGhost.material as THREE.Material).dispose();
  deltaGhost = null;
}

/**
 * Build the ghost for a delta the worker just produced.
 *
 * Dispatched from the WORKER switch, not `onMessage` — that one carries
 * host→viewer traffic, and a handler registered there for a worker message is
 * simply never called. Which is exactly what happened the first time.
 */
function showDeltaGhost(delta: PreviewDelta): void {
  clearDeltaGhost();
  // A ghost with no operation behind it belongs to a render since superseded.
  if (!combineOp && (!activeOp || !armedTarget)) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(delta.vertices, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(delta.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(delta.triangles, 1));
  const mesh = new THREE.Mesh(geometry, createDeltaMaterial(delta.mode));
  mesh.raycast = () => {};
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  overlayGroup.add(mesh);
  deltaGhost = mesh;
}


// ── Live preview of the pending operation ─────────────────────────────────
// The arrow tells you how far; this tells you what it does. It costs one OCCT
// run, so it is debounced and only fires when the number actually changed.
//
// Nothing is written. The operation is applied to the parts AFTER `main()`
// returns, which is faithful rather than approximate: the generated source
// wraps the part's shape expression, so the operation is the outermost call
// there too.

// Short, because the run itself is now ~100 ms at preview tessellation. Long
// enough that a continuous drag does not queue a run per pointer event.
const PREVIEW_DEBOUNCE_MS = 110;
let lastPreviewKey = "";
/**
 * The worker DROPS an execute that arrives while it is busy — it does not
 * queue. Without tracking that, a drag whose last move landed mid-run would
 * leave the model showing a value the user has already dragged past.
 */
let previewInFlight = false;
/**
 * What a preview run asks the worker for.
 *
 * Two shapes, because there are two kinds of pending operation and they are
 * genuinely different requests — but ONE runner, so the debounce, the
 * latest-wins queue, the coarse-mesh-while-dragging rule and the "remember
 * what to go back to" bookkeeping are shared rather than reimplemented.
 */
type PreviewRequest =
  | { kind: "face"; op: PreviewFaceOp }
  | { kind: "combine"; combine: PreviewCombine }
  | { kind: "arrange"; arrange: PreviewArrange };

let queuedPreview: { request: PreviewRequest; key: string } | null = null;

/**
 * The largest radius the armed rounding operation can take, measured against
 * OCCT rather than guessed.
 *
 * Both cheap heuristics were checked and neither is usable: the minimum-edge
 * rule does not track the answer at all, and the wall-thickness rule is right
 * in shape but 55% too conservative. So the worker probes for the real one,
 * once, when the operation is armed.
 *
 * `null` means not measured yet; 0 means nothing can be rounded here.
 */
let opMaxRadius: number | null = null;

/**
 * The ceiling rounded DOWN to a displayable step.
 *
 * The probe returns a radius it has verified works — 8.994, say. Showing that
 * as "9.0" and letting the drag snap to 9.0 walks straight back into the
 * failure the ceiling exists to prevent: measured on a 10 mm plate, 8.9 filleted
 * and 9.0 did not. Rounding toward zero is the only direction that stays true.
 */
function safeMaxRadius(step = 0.1): number | null {
  if (opMaxRadius === null) return null;
  if (opMaxRadius <= 0) return 0;
  return Math.floor(opMaxRadius / step) * step;
}
/** Which (target, op) the measured ceiling belongs to. */
let opMaxKey = "";

/** What the worker needs to reproduce the pending operation. */
/** Identifies the armed operation, so a measured ceiling is not reused across a
 *  different face or a different operation. */
function opIdentity(): string {
  if (!armedTarget || !activeOp) return "";
  return JSON.stringify([
    activeOp,
    armedTarget.kind,
    armedTarget.partName,
    armedTarget.kind === "face" ? armedTarget.info.center : armedTarget.point,
  ]);
}

function previewPayload(): PreviewFaceOp | null {
  const d = parseDistance();
  if (!armedTarget || !activeOp || d === null) return null;
  if (activeOp === "extrude" && armedTarget.kind === "edge") return null;
  // Ask for the ceiling only while it is still unknown for THIS operation.
  const wantLimit = activeOp !== "extrude" && opMaxKey !== opIdentity();

  if (armedTarget.kind === "edge") {
    return {
      op: activeOp,
      partName: currentParts.length > 1 ? armedTarget.partName : null,
      target: { kind: "edge", point: armedTarget.point },
      distance: d,
      ...(wantLimit ? { probeLimit: true } : {}),
    };
  }
  // The plane and offset the host would write, resolved to numbers — at
  // preview time the parameters already hold what the names evaluate to.
  const selector = synthesizeFaceSelector(armedTarget.info, declaredParamValues);
  if (!selector.ok) return null;
  return {
    op: activeOp,
    partName: currentParts.length > 1 ? armedTarget.partName : null,
    target: { kind: "face", plane: selector.selector.plane, offset: selector.selector.offset },
    distance: d,
    ...(wantLimit ? { probeLimit: true } : {}),
  };
}

function schedulePreview(): void {
  clearTimeout(previewTimer);
  // The modal commands clear each other when armed, so at most one of these
  // can be live. Asking in a fixed order keeps that invariant in one place
  // instead of at every call site.
  const arrange = arrangePayload();
  const combine = combinePayload();
  const request: PreviewRequest | null = arrange
    ? { kind: "arrange", arrange }
    : combine
      ? { kind: "combine", combine }
      : (() => {
          const op = previewPayload();
          return op ? ({ kind: "face", op } as const) : null;
        })();
  if (!request) return;
  const key = JSON.stringify(request);
  if (key === lastPreviewKey) return;
  previewTimer = setTimeout(() => runPreview(request, key), PREVIEW_DEBOUNCE_MS);
}

function runPreview(request: PreviewRequest, key: string): void {
  if (!worker || !lastScriptJs) return;
  if (previewInFlight) {
    // Latest wins: an intermediate value the user has already dragged past is
    // not worth rendering.
    queuedPreview = { request, key };
    return;
  }
  previewInFlight = true;
  // Remember what to go back to. Captured on the FIRST preview only, so a
  // second one does not adopt the first preview as its baseline.
  if (!previewShowing) previewBaseJs = lastScriptJs;
  previewShowing = true;
  lastPreviewKey = key;
  statusEl.textContent = "Previewing…";
  fitOnThisRender = false;
  worker.postMessage({
    type: "execute",
    js: lastScriptJs,
    paramOverrides: { ...currentParamValues },
    // Coarse while the handle is actually held — meshing cost scales with
    // roughly the square of the tolerance, and nobody judges a fillet's
    // smoothness mid-drag. Released or typed, it re-renders at full quality,
    // so what you settle on is what you see.
    meshQuality: handleDrag ? "preview" : "final",
    ...(request.kind === "face"
      ? { previewOp: request.op }
      : request.kind === "combine"
        ? { previewCombine: request.combine }
        : { previewArrange: request.arrange }),
  });
}

/**
 * Put the model back the way the file describes it.
 * Returns true when a rebuild was actually kicked off.
 */
function revertPreview(): boolean {
  clearTimeout(previewTimer);
  lastPreviewKey = "";
  queuedPreview = null;
  if (!previewShowing) return false;
  previewShowing = false;
  const js = previewBaseJs;
  previewBaseJs = null;
  if (!worker || !js) return false;
  fitOnThisRender = false;
  worker.postMessage({
    type: "execute",
    js,
    paramOverrides: { ...currentParamValues },
  });
  return true;
}

/** A target to re-find once the revert's rebuild lands. */
let pendingReselect: ArmedTarget | null = null;

/** Re-select what was armed before a cancelled preview, if it is still there. */
function applyPendingReselect(): void {
  const target = pendingReselect;
  pendingReselect = null;
  if (!target) return;
  const index = currentParts.findIndex((p) => p.name === target.partName);
  const part = currentParts[index < 0 ? 0 : index] as PickablePart | undefined;
  if (!part) return;

  const found =
    target.kind === "face"
      ? findMatchingFace(part, index < 0 ? 0 : index, target.info.center, target.info.normal)
      : findMatchingEdge(part, index < 0 ? 0 : index, target.point);
  if (!found) return;
  facePicker.setSelection(found);
  updateFaceInfoPanel();
}

/** The distance field, or null when it does not hold a usable number. */
function parseDistance(): number | null {
  const raw = fiDistEl.value.trim().replace(",", ".");
  if (raw === "" || raw === "-") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return null;
  // A negative radius is not a thing; only extrude reads a sign.
  if (activeOp !== "extrude" && n < 0) return null;
  return n;
}

let faceOpRequestId = 0;
let pendingFaceOp: number | null = null;
/**
 * Set when a face operation has been written and we are waiting for the
 * rebuild it triggers.
 *
 * The write succeeding is not the same as the operation doing anything. A
 * fillet radius OCCT cannot apply is caught by the stdlib helper, which warns
 * and returns the shape unchanged — so without this, pressing Apply would add
 * a line to the file and visibly change nothing, which is the silent no-op
 * this whole feature exists to avoid.
 */
let awaitingFaceOpRebuild: FaceOpKind | null = null;

/** Prefixes the stdlib helpers put on their runtime warnings. */
const FACE_OP_WARNING = /^(extrudeFace|filletFace|chamferFace|filletEdge|chamferEdge):\s*/;

/**
 * Report a warning raised by the operation the user just applied.
 * Returns true when one was found, so the caller can leave the success
 * message alone otherwise.
 */
function reportFaceOpWarnings(warnings: string[] | undefined): boolean {
  if (!awaitingFaceOpRebuild) return false;
  awaitingFaceOpRebuild = null;
  const mine = (warnings ?? []).filter((w) => FACE_OP_WARNING.test(w));
  if (mine.length === 0) return false;
  // The helper's message ends with "Returning shape unchanged." — true, but
  // the status line is short and the reason is the useful half.
  const text = mine[0]!.replace(FACE_OP_WARNING, "").replace(/\s*Returning shape unchanged\.$/, "");
  setParamsStatus(`Nothing changed — ${text}`, true);
  return true;
}

function applyOp(): void {
  const sel = armedTarget;
  const d = parseDistance();
  if (!sel || !activeOp || d === null) {
    setParamsStatus(
      activeOp === "extrude" ? "Enter a non-zero distance." : "Enter a positive radius.",
      true,
    );
    return;
  }
  if (pendingFaceOp !== null) return;

  faceOpRequestId += 1;
  pendingFaceOp = faceOpRequestId;
  fiApplyEl.disabled = true;
  setParamsStatus(`${OP_LABEL[activeOp]}…`);
  awaitingFaceOpRebuild = activeOp;
  postToExtension({
    type: "face-op",
    requestId: faceOpRequestId,
    op: activeOp,
    // A single-part script returns a bare shape and has no name to match on.
    partName: currentParts.length > 1 ? sel.partName : null,
    target:
      sel.kind === "edge"
        ? { kind: "edge", point: sel.point }
        : {
            kind: "face",
            face: {
              kind: sel.info.kind,
              center: sel.info.center,
              ...(sel.info.normal ? { normal: sel.info.normal } : {}),
            },
          },
    distance: d,
  });
  // The commit rebuilds from the file, which supersedes any preview.
  clearDeltaGhost();
  clearTimeout(previewTimer);
  previewShowing = false;
  previewBaseJs = null;
  lastPreviewKey = "";
}

fiExtrudeEl.addEventListener("click", () => setActiveOp("extrude"));
fiFilletEl.addEventListener("click", () => setActiveOp("fillet"));
fiChamferEl.addEventListener("click", () => setActiveOp("chamfer"));
fiShellEl.addEventListener("click", () => setActiveOp("shell"));
fiBackEl.addEventListener("click", () => setActiveOp(null));
fiApplyEl.addEventListener("click", applyOp);
fiDistEl.addEventListener("input", () => {
  if (!activeOp) return;
  renderOpPreview();
  schedulePreview();
});
fiDistEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    applyOp();
    e.preventDefault();
  } else if (e.key === "Escape") {
    setActiveOp(null);
    e.preventDefault();
    e.stopPropagation();
  }
});

fiLookAtEl.addEventListener("click", () => {
  const sel = facePicker.getSelection();
  // Only a face has a normal to look down.
  if (sel?.kind !== "face" || !sel.info.normal) return;
  // Look ALONG the inward normal, i.e. place the camera out on the outward
  // one — setCameraAngle takes the direction from the model to the camera.
  setCameraAngle(sel.info.normal);
});

fiClearEl.addEventListener("click", () => {
  setActiveOp(null);
  facePicker.setSelection(null);
  faceInfoEl.classList.remove("visible");
});

// ── Combine: joining, cutting and intersecting whole bodies ───────────────
//
// Fusion 360's Modify → Combine, with the same three operations and the same
// "Keep Tools" option. What is different is where the result lives: Fusion
// records a feature in a hidden timeline, and this writes a call into your
// `.shape.ts`, so the file stays the only description of the model.
//
// Bodies are chosen by NAME, which is the one handle in this whole feature
// that needs no synthesis and cannot go stale — the file already names them,
// and the committed edit looks them up the same way the preview does.
//
// Why a dropdown as well as clicking in the view: a combine REMOVES the tool
// from the model, so the moment the preview lands the body you would click to
// add a second tool is no longer on screen. The list is captured when the
// command is armed and stays put, so picking three bodies works the same as
// picking two.

const combineInfoEl = document.getElementById("combine-info")!;
const ciOpEl = document.getElementById("ci-op")!;
const ciTargetEl = document.getElementById("ci-target") as HTMLSelectElement;
const ciChipsEl = document.getElementById("ci-chips")!;
const ciAddEl = document.getElementById("ci-add") as HTMLSelectElement;
const ciKeepEl = document.getElementById("ci-keep-toggle") as HTMLInputElement;
const ciApplyEl = document.getElementById("ci-apply") as HTMLButtonElement;
const ciCancelEl = document.getElementById("ci-cancel") as HTMLButtonElement;
const ciCodeEl = document.getElementById("ci-code")!;
const ciNotesEl = document.getElementById("ci-notes")!;

type CombineKind = "join" | "cut" | "intersect";

const COMBINE_LABEL: Record<CombineKind, string> = {
  join: "Join",
  cut: "Cut",
  intersect: "Intersect",
};

const COMBINE_HELPER: Record<CombineKind, string> = {
  join: "joinBodies",
  cut: "cutBodies",
  intersect: "intersectBodies",
};

let combineOp: CombineKind | null = null;
/**
 * The bodies that existed when the command was armed.
 *
 * Frozen for the reason in the section note: the preview deletes bodies, and a
 * menu rebuilt from the previewed model would lose the very entries the user
 * still needs to pick from.
 */
let combineBodies: string[] = [];
let combineTarget: string | null = null;
let combineTools: string[] = [];
/** The last measurement the worker sent back for the armed combine. */
let combineStats: CombineStatsMessage | null = null;

/**
 * Selected bodies are tinted rather than outlined.
 *
 * An outline would have to be built per body and rebuilt on every preview;
 * `emissive` is one assignment on a material that already exists, and it
 * survives nothing — which is the point, since every preview replaces the
 * meshes and the tint is simply reapplied by name.
 *
 * Two hues because the two roles are not interchangeable: cutting A with B is
 * a different model from cutting B with A, and a single "selected" colour
 * would leave that decision invisible.
 */
const TARGET_TINT = 0x1d3f66;
const TOOL_TINT = 0x5a3c0a;

function applyCombineTint(): void {
  for (const part of currentParts) {
    const mat = part.mesh.material as THREE.MeshPhongMaterial;
    if (!mat.emissive) continue;
    // Arrange owns the tint when it is armed. The two commands clear each
    // other on arming, so this only matters for the incidental repaints —
    // a rebuild, a body toggled — which can otherwise land in either order.
    if (combineOp === null && arrangeMode !== null) continue;
    const tint =
      combineOp === null
        ? 0x000000
        : part.name === combineTarget
          ? TARGET_TINT
          : combineTools.includes(part.name)
            ? TOOL_TINT
            : 0x000000;
    mat.emissive.setHex(tint);
  }
  updatePartsList();
}

/**
 * Light up the body Mirror / Pattern is acting on.
 *
 * Without this the command is invisible: the preview replaces the body with
 * its own copies, and with several bodies on screen there is nothing to say
 * which one they came from — or which one a change to the fields would affect.
 * The dropdown knows, but the dropdown is not where anyone is looking.
 */
function applyArrangeTint(): void {
  for (const part of currentParts) {
    const mat = part.mesh.material as THREE.MeshPhongMaterial;
    if (!mat.emissive) continue;
    // Only touch what this command owns. Combine has its own tint and the two
    // are mutually exclusive, but clearing indiscriminately here would still
    // stomp on whatever set it last.
    if (arrangeMode === null) {
      if (combineOp === null) mat.emissive.setHex(0x000000);
      continue;
    }
    mat.emissive.setHex(part.name === arrangePartName ? TARGET_TINT : 0x000000);
  }
  // The panel marks the same body. Done here because this runs on every path
  // that changes which one is armed — the dropdown, a viewport click, a tree
  // click, arming and disarming.
  updatePartsList();
}

/** Body names to choose from: frozen while armed, live otherwise. */
function combineCandidates(): string[] {
  return combineOp ? combineBodies : currentParts.map((p) => p.name);
}

function setCombineOp(op: CombineKind | null): void {
  if (op !== null && currentParts.length < 2 && combineBodies.length < 2) {
    setParamsStatus("Combine needs at least two bodies.", true);
    return;
  }

  if (op === null) {
    combineOp = null;
    combineTarget = null;
    combineTools = [];
    combineBodies = [];
    combineStats = null;
    combineInfoEl.classList.remove("visible");
    dragHandle.hide();
    clearDeltaGhost();
    // Put the model back the way the file describes it, exactly as cancelling
    // a face operation does.
    revertPreview();
    applyCombineTint();
    updateCombineButtons();
    return;
  }

  // Re-arming while a preview is showing would capture the PREVIEWED body
  // list — one short — as the frozen menu. Go back to the file's model first.
  if (combineOp === null && previewShowing) revertPreview();

  // A face selection, a body selection and a gizmo drag would all be reading
  // the same click. One at a time.
  setArrangeMode(null);
  setMoveMode(null);
  setActiveOp(null);
  facePicker.setSelection(null);
  faceInfoEl.classList.remove("visible");

  const wasArmed = combineOp !== null;
  combineOp = op;
  if (!wasArmed) {
    combineBodies = currentParts.map((p) => p.name);
    combineStats = null;
    const picked = facePicker.getSelection()?.partName;
    combineTarget =
      picked && combineBodies.includes(picked) ? picked : (combineBodies[0] ?? null);
    // With exactly two bodies the second one is the only thing the tool could
    // be, so choosing it saves a click and takes nothing away — any other
    // count is a real decision and stays the user's.
    combineTools =
      combineBodies.length === 2
        ? combineBodies.filter((n) => n !== combineTarget)
        : [];
  }

  combineInfoEl.classList.add("visible");
  renderCombineBar();
  applyCombineTint();
  updateCombineButtons();
  schedulePreview();
}

/** Reflect which of the three commands is armed, and whether any can be. */
function updateCombineButtons(): void {
  const enough = currentParts.length >= 2 || combineBodies.length >= 2;
  for (const kind of ["join", "cut", "intersect"] as const) {
    const btn = document.getElementById(`btn-${kind}`) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.disabled = !enough;
    btn.classList.toggle("active", combineOp === kind);
    btn.title = enough
      ? btn.dataset.baseTitle ?? btn.title
      : "Needs at least two bodies";
  }
}

function renderCombineBar(): void {
  if (!combineOp) return;
  ciOpEl.textContent = COMBINE_LABEL[combineOp];

  const names = combineCandidates();
  ciTargetEl.innerHTML = "";
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === combineTarget;
    ciTargetEl.appendChild(opt);
  }

  ciChipsEl.innerHTML = "";
  for (const name of combineTools) {
    const chip = document.createElement("span");
    chip.className = "ci-chip";
    const label = document.createElement("span");
    label.textContent = name;
    const drop = document.createElement("button");
    drop.textContent = "×";
    drop.title = `Remove ${name}`;
    drop.addEventListener("click", () => {
      combineTools = combineTools.filter((n) => n !== name);
      renderCombineBar();
      applyCombineTint();
      schedulePreview();
    });
    chip.append(label, drop);
    ciChipsEl.appendChild(chip);
  }
  if (combineTools.length === 0) {
    const hint = document.createElement("span");
    hint.className = "ci-label";
    hint.textContent = "click a body";
    ciChipsEl.appendChild(hint);
  }

  const available = names.filter(
    (n) => n !== combineTarget && !combineTools.includes(n),
  );
  ciAddEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "+ body…";
  ciAddEl.appendChild(placeholder);
  for (const name of available) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    ciAddEl.appendChild(opt);
  }
  ciAddEl.value = "";
  ciAddEl.disabled = available.length === 0;

  ciKeepEl.checked = combineKeepTools();
  ciApplyEl.disabled = !combineTarget || combineTools.length === 0 || pendingCombine !== null;
  renderCombinePreview();
}

function combineKeepTools(): boolean {
  return ciKeepEl.checked;
}

/**
 * The line that will be written, shown before it is written.
 *
 * Same contract as the face operations' preview: you see the code you are
 * about to commit. The tool argument is rendered as its NAME here even where
 * the committed edit will inline or hoist an expression — the file decides
 * that, and guessing at it in the bar would show a line the host may not
 * write.
 */
function renderCombinePreview(): void {
  if (!combineOp) return;
  ciCodeEl.textContent = "";
  ciNotesEl.innerHTML = "";
  if (!combineTarget || combineTools.length === 0) {
    ciCodeEl.textContent = "…";
    return;
  }
  const arg =
    combineTools.length === 1 ? combineTools[0]! : `[${combineTools.join(", ")}]`;
  ciCodeEl.textContent = `${COMBINE_HELPER[combineOp]}(${combineTarget}, ${arg})`;

  const notes: Array<{ text: string; warn?: boolean }> = [];
  if (!combineKeepTools()) {
    notes.push({
      text:
        combineTools.length === 1
          ? `removes the "${combineTools[0]}" body`
          : `removes ${combineTools.length} bodies`,
    });
  }

  const stats = combineStats;
  if (stats) {
    if (stats.disjoint) {
      // Named, not numbered. The worker reports positions because it never
      // sees names, but "island" is what the user picked and what they have to
      // go and move.
      const missed = (stats.disjointTools ?? [])
        .map((i) => combineTools[i])
        .filter((n): n is string => !!n);
      notes.push({
        text:
          missed.length === 0 || missed.length === combineTools.length
            ? "⚠ the bodies do not touch — nothing would be merged"
            : `⚠ ${missed.join(", ")} ${missed.length === 1 ? "does" : "do"} not touch — that part would not merge`,
        warn: true,
      });
    } else if (stats.empty) {
      notes.push({
        text:
          combineOp === "intersect"
            ? "⚠ the bodies do not overlap — there is nothing to keep"
            : "⚠ this removes the whole body",
        warn: true,
      });
    } else if (stats.deltaVolume !== undefined) {
      // Measured on the actual result, not estimated from bounding boxes —
      // the one number that says whether the operation did what was meant.
      //
      // Zero is the case worth being loudest about: the operation succeeds,
      // the file gets a line, and the model is unchanged. It is the silent
      // no-op this whole module exists to make impossible to miss, and it
      // used to leave the note line simply blank.
      const moved =
        stats.deltaVolume > (stats.targetVolume ?? 1) * 1e-6 && stats.deltaVolume > 0;
      notes.push(
        moved
          ? {
              text: `${combineOp === "join" ? "adds" : "removes"} ${formatVolume(stats.deltaVolume)}`,
            }
          : {
              text:
                combineOp === "join"
                  ? "⚠ nothing would be added — the tool is already inside the target"
                  : "⚠ nothing would be removed — the bodies do not overlap",
              warn: true,
            },
      );
    }
  }

  for (const n of notes) {
    const el = document.createElement("span");
    if (n.warn) el.className = "warn";
    el.textContent = n.text;
    ciNotesEl.appendChild(el);
  }
}

function combinePayload(): PreviewCombine | null {
  if (!combineOp || !combineTarget || combineTools.length === 0) return null;
  return {
    op: combineOp,
    targetName: combineTarget,
    toolNames: [...combineTools],
    keepTools: combineKeepTools(),
  };
}

/**
 * Toggle a body's membership in the tool set from a click in the 3D view.
 *
 * Arming always settles a target, so a click in the view can only ever mean
 * "also this one" — and clicking the target is a no-op rather than a removal,
 * because a combine without a target is not a state worth reaching by
 * accident. Changing the target is the dropdown's job, where it is an explicit
 * choice rather than a side effect of aiming.
 */
function combineClickBody(name: string): void {
  if (!combineOp) return;
  if (!combineBodies.includes(name)) return;
  if (name === combineTarget) return;
  combineTools = combineTools.includes(name)
    ? combineTools.filter((n) => n !== name)
    : [...combineTools, name];
  renderCombineBar();
  applyCombineTint();
  schedulePreview();
}

let combineRequestId = 0;
let pendingCombine: number | null = null;
/**
 * Set when a combine has been written and we are waiting for the rebuild.
 *
 * The write succeeding is not the same as the operation doing anything: the
 * stdlib helpers warn and return the target unchanged when the bodies do not
 * overlap, so without this a successful Apply could add a line and visibly
 * change nothing.
 */
let awaitingCombineRebuild = false;

/** Prefixes the stdlib boolean helpers put on their runtime warnings. */
const COMBINE_WARNING = /^(joinBodies|cutBodies|intersectBodies):\s*/;

function reportCombineWarnings(warnings: string[] | undefined): boolean {
  if (!awaitingCombineRebuild) return false;
  awaitingCombineRebuild = false;
  const mine = (warnings ?? []).filter((w) => COMBINE_WARNING.test(w));
  if (mine.length === 0) return false;
  setParamsStatus(`Nothing changed — ${mine[0]!.replace(COMBINE_WARNING, "")}`, true);
  return true;
}

function applyCombine(): void {
  const payload = combinePayload();
  if (!payload) {
    setParamsStatus("Pick a target body and at least one tool.", true);
    return;
  }
  if (pendingCombine !== null) return;

  combineRequestId += 1;
  pendingCombine = combineRequestId;
  ciApplyEl.disabled = true;
  setParamsStatus(`${COMBINE_LABEL[payload.op]}…`);
  awaitingCombineRebuild = true;
  postToExtension({
    type: "combine",
    requestId: combineRequestId,
    op: payload.op,
    targetName: payload.targetName,
    toolNames: payload.toolNames,
    keepTools: payload.keepTools,
  });
  // The commit rebuilds from the file, which supersedes any preview.
  clearDeltaGhost();
  clearTimeout(previewTimer);
  previewShowing = false;
  previewBaseJs = null;
  lastPreviewKey = "";
}

for (const kind of ["join", "cut", "intersect"] as const) {
  const btn = document.getElementById(`btn-${kind}`) as HTMLButtonElement | null;
  if (!btn) continue;
  btn.dataset.baseTitle = btn.title;
  btn.addEventListener("click", () => setCombineOp(combineOp === kind ? null : kind));
}

ciTargetEl.addEventListener("change", () => {
  combineTarget = ciTargetEl.value || null;
  // A body cannot be its own tool, and the host refuses the request outright
  // rather than guessing which role was meant.
  combineTools = combineTools.filter((n) => n !== combineTarget);
  renderCombineBar();
  applyCombineTint();
  schedulePreview();
});

ciAddEl.addEventListener("change", () => {
  const name = ciAddEl.value;
  if (!name) return;
  if (!combineTools.includes(name)) combineTools.push(name);
  renderCombineBar();
  applyCombineTint();
  schedulePreview();
});

ciKeepEl.addEventListener("change", () => {
  renderCombineBar();
  schedulePreview();
});

ciApplyEl.addEventListener("click", applyCombine);
ciCancelEl.addEventListener("click", () => setCombineOp(null));

// ── Move and Rotate: positioning whole bodies ─────────────────────────────
//
// Fusion 360's Modify → Move/Copy: a triad you drag to slide a body along an
// axis or in a plane, and arcs you drag to turn it. What gets written is the
// call a replicad user would have typed —
//
//     { shape: plate.rotate(90, plate.boundingBox.center, [0, 0, 1]), … }
//
// so the file keeps describing the model rather than acquiring a hidden
// transform the way a CAD feature tree does.
//
// ## The preview needs no kernel
//
// Extrude, fillet and combine all change topology, so previewing them means a
// round trip through OCCT. A rigid transform does not: sliding a body is a
// matrix, and Three.js already applies one to every part group — it is how the
// motion simulation moves things. So this preview runs at frame rate, costs
// nothing, and is EXACT rather than approximate. The only round trip is the
// commit.
//
// ## Which is why the pivot is measured by OCCT and not by the mesh
//
// The one number the viewer cannot make up is where "the body's centre" is.
// The file will say `boundingBox.center`, and the mesh's own bounds are close
// to that but not equal — a tessellated cylinder is inscribed in its true
// surface. So the core sends OCCT's bounding-box centre along with the mesh,
// and the drag turns about exactly the point the written expression resolves
// to.

const moveInfoEl = document.getElementById("move-info")!;
const miOpEl = document.getElementById("mi-op")!;
const miBodyEl = document.getElementById("mi-body") as HTMLSelectElement;
const miTranslateEl = document.getElementById("mi-translate") as HTMLElement;
const miRotateEl = document.getElementById("mi-rotate") as HTMLElement;
const miXEl = document.getElementById("mi-x") as HTMLInputElement;
const miYEl = document.getElementById("mi-y") as HTMLInputElement;
const miZEl = document.getElementById("mi-z") as HTMLInputElement;
const miAngleEl = document.getElementById("mi-angle") as HTMLInputElement;
const miAxisEl = document.getElementById("mi-axis") as HTMLSelectElement;
const miPivotEl = document.getElementById("mi-pivot") as HTMLSelectElement;
const miCopyEl = document.getElementById("mi-copy-toggle") as HTMLInputElement;
const miResetEl = document.getElementById("mi-reset") as HTMLButtonElement;
const miApplyEl = document.getElementById("mi-apply") as HTMLButtonElement;
const miCancelEl = document.getElementById("mi-cancel") as HTMLButtonElement;
const miCodeEl = document.getElementById("mi-code")!;
const miNotesEl = document.getElementById("mi-notes")!;

type MoveMode = "translate" | "rotate";

const MOVE_LABEL: Record<MoveMode, string> = {
  translate: "Move",
  rotate: "Rotate",
};

/**
 * Drag increments.
 *
 * Round enough that a drag lands on a number a person would have typed, fine
 * enough to reach anything worth reaching. Holding Shift turns them off for
 * the rare case that wants a raw value; typing is always exact.
 */
const MOVE_SNAP_MM = 0.5;
const ROTATE_SNAP_DEG = 5;

let moveMode: MoveMode | null = null;
let movePartName: string | null = null;
/** The gizmo's home: the body's centre when the command was armed. */
const moveAnchor = new THREE.Vector3();
/** Accumulated translation, in model units. */
const moveDelta = new THREE.Vector3();
/** Accumulated rotation, about the resolved pivot. */
const moveQuat = new THREE.Quaternion();

const AXIS_VECTORS: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/**
 * The object the gizmo actually drags.
 *
 * Not the part group itself: the gizmo rotates whatever it is attached to
 * about that object's own origin, and the pivot this command writes is a
 * choice — the body's centre or the world origin. Reading the gizmo's
 * transform off a proxy and applying it to the part with the chosen pivot
 * keeps those two things separate, which is what lets "turn about the world
 * origin" mean what it says.
 */
const moveProxy = new THREE.Object3D();
scene.add(moveProxy);

const transformControls = new TransformControls(camera, renderer.domElement);
const transformHelper = transformControls.getHelper();
transformHelper.visible = false;
transformControls.enabled = false;
scene.add(transformHelper);

// The gizmo and the orbit controls both want the drag. The gizmo wins while it
// has one, exactly as it does for the extrude arrow.
transformControls.addEventListener("dragging-changed", (e: any) => {
  controls.enabled = !e.value;
  if (!e.value) {
    // A drag ends with a click on the canvas; without this the release
    // re-picks a face, or clears the selection, the instant you let go.
    suppressNextClick = true;
    syncMoveGizmo();
  }
});

transformControls.addEventListener("objectChange", () => {
  if (!moveMode) return;
  if (moveMode === "translate") {
    moveDelta.copy(moveProxy.position).sub(moveAnchor);
  } else {
    moveQuat.copy(moveProxy.quaternion);
  }
  applyMoveTransform();
  renderMoveFields();
  renderMovePreview();
});

/** The body being moved, if it is still in the scene. */
function movePart(): PartInfo | undefined {
  return currentParts.find((p) => p.name === movePartName);
}

/**
 * The second body a copy will produce, shown while the drag is still open.
 *
 * A clone of the part's meshes rather than a translucent hint, because that is
 * literally what the commit writes — the same solid, somewhere else. Geometry
 * and materials are SHARED with the original, so tearing this down must remove
 * it without disposing anything: disposing here would take the real body's
 * buffers with it.
 */
let moveCopyGhost: THREE.Group | null = null;

function clearMoveCopyGhost(): void {
  if (!moveCopyGhost) return;
  overlayGroup.remove(moveCopyGhost);
  moveCopyGhost = null;
}

function updateMoveCopyGhost(): void {
  const part = movePart();
  if (!moveMode || !miCopyEl.checked || !part) {
    clearMoveCopyGhost();
    return;
  }
  if (!moveCopyGhost) {
    const group = new THREE.Group();
    const mesh = part.mesh.clone();
    // The picker raycasts the real parts; a ghost that answered would let you
    // select a face of a body that does not exist yet.
    mesh.raycast = () => {};
    group.add(mesh);
    if (part.edgeLines) {
      const edges = part.edgeLines.clone();
      edges.raycast = () => {};
      group.add(edges);
    }
    overlayGroup.add(group);
    moveCopyGhost = group;
  }
  moveCopyGhost.position.copy(part.group.position);
  moveCopyGhost.quaternion.copy(part.group.quaternion);
}

/** The name a copy would take: the body's, plus enough to make it unique. */
function copyName(): string {
  const base = `${movePartName ?? "body"} copy`;
  const taken = new Set(currentParts.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Where the rotation turns, in model coordinates.
 *
 * "self" resolves to OCCT's bounding-box centre — the value the written
 * `boundingBox.center` will evaluate to — and falls back to the origin for a
 * part the core could not measure, because an unmeasured body is better turned
 * about a known point than about a guess.
 */
function movePivotPoint(): THREE.Vector3 {
  if (miPivotEl.value === "origin") return new THREE.Vector3(0, 0, 0);
  const c = movePart()?.boundsCenter;
  return c ? new THREE.Vector3(c[0], c[1], c[2]) : new THREE.Vector3(0, 0, 0);
}

/**
 * Put the body where the accumulated transform says.
 *
 * world = translate(T) ∘ rotateAbout(P, q), which for a group whose geometry
 * is already in world coordinates means quaternion = q and
 * position = T + P − qP. The same arithmetic the committed
 * `.rotate(a, P, axis).translate(T)` performs, checked against OCCT in
 * transform-agreement.test.ts.
 */
function applyMoveTransform(): void {
  const part = movePart();
  if (!part) return;
  const p = movePivotPoint();
  const rotated = p.clone().applyQuaternion(moveQuat);
  part.group.quaternion.copy(moveQuat);
  part.group.position.copy(p).sub(rotated).add(moveDelta);

  if (miCopyEl.checked) {
    // Copying does not move the body it was dragged from. Show the transform
    // on the ghost and put the original back, so what is on screen is what the
    // two entries in the file will be.
    updateMoveCopyGhost();
    part.group.position.set(0, 0, 0);
    part.group.quaternion.set(0, 0, 0, 1);
  } else {
    clearMoveCopyGhost();
  }
}

/** Put every body back where the file has it. */
function clearMoveTransforms(): void {
  for (const p of currentParts) {
    p.group.position.set(0, 0, 0);
    p.group.quaternion.set(0, 0, 0, 1);
  }
}

/** The signed turn a quaternion represents about a known axis, in degrees. */
function angleAboutAxis(q: THREE.Quaternion, axis: THREE.Vector3): number {
  const along = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const deg = (2 * Math.atan2(along, q.w) * 180) / Math.PI;
  // atan2 already gives (-180, 180]; normalise the wrap so a drag past half a
  // turn reads as -170 rather than 190.
  return Number(((deg + 540) % 360 - 180).toFixed(4));
}

/** Aim the gizmo at the body's current position, without disturbing a drag. */
function syncMoveGizmo(): void {
  const part = movePart();
  if (!moveMode || !part) {
    transformHelper.visible = false;
    transformControls.enabled = false;
    transformControls.detach();
    return;
  }
  if (transformControls.dragging) return;

  transformControls.mode = moveMode;
  if (moveMode === "translate") {
    // The handle tracks the thing being moved, which when copying is the
    // ghost, not the body it came from.
    moveProxy.position.copy(moveAnchor).add(moveDelta);
    moveProxy.quaternion.set(0, 0, 0, 1);
    transformControls.showX = true;
    transformControls.showY = true;
    transformControls.showZ = true;
  } else {
    // The gizmo follows the body so the arcs stay on the thing they turn, but
    // its position is read by nothing — only the quaternion is.
    const p = movePivotPoint();
    const rotated = p.clone().applyQuaternion(moveQuat);
    moveProxy.position
      .copy(moveAnchor)
      .applyQuaternion(moveQuat)
      .add(p)
      .sub(rotated)
      .add(moveDelta)
      .sub(moveAnchor.clone().applyQuaternion(moveQuat))
      .add(moveAnchor.clone().applyQuaternion(moveQuat));
    moveProxy.quaternion.copy(moveQuat);
    // One axis at a time. Three arcs at once compose into a rotation with no
    // principal axis, which cannot be written as one `rotate(angle, …)` call —
    // and the file is the point.
    const axis = miAxisEl.value;
    transformControls.showX = axis === "x";
    transformControls.showY = axis === "y";
    transformControls.showZ = axis === "z";
  }
  transformControls.attach(moveProxy);
  transformControls.enabled = true;
  transformHelper.visible = true;
}

function setMoveMode(mode: MoveMode | null): void {
  if (mode !== null && currentParts.length === 0) return;

  if (mode === null) {
    moveMode = null;
    movePartName = null;
    moveDelta.set(0, 0, 0);
    moveQuat.set(0, 0, 0, 1);
    clearMoveTransforms();
    clearMoveCopyGhost();
    transformControls.detach();
    transformControls.enabled = false;
    transformHelper.visible = false;
    moveInfoEl.classList.remove("visible");
    updateMoveButtons();
    return;
  }

  // One modal command at a time: Combine reads clicks as body selection and
  // this one hands them to a gizmo.
  setArrangeMode(null);
  setCombineOp(null);
  setActiveOp(null);
  facePicker.setSelection(null);
  faceInfoEl.classList.remove("visible");

  const rearming = moveMode !== null;
  moveMode = mode;
  if (!rearming) {
    const picked = facePicker.getSelection()?.partName;
    movePartName =
      picked && currentParts.some((p) => p.name === picked)
        ? picked
        : (currentParts[0]?.name ?? null);
    moveDelta.set(0, 0, 0);
    moveQuat.set(0, 0, 0, 1);
    captureMoveAnchor();
  }

  updatePartsList();
  miOpEl.textContent = MOVE_LABEL[mode];
  miTranslateEl.hidden = mode !== "translate";
  miRotateEl.hidden = mode !== "rotate";
  moveInfoEl.classList.add("visible");
  renderMoveBar();
  syncMoveGizmo();
  updateMoveButtons();
}

/** The gizmo's home, taken from the body as the file currently builds it. */
function captureMoveAnchor(): void {
  const part = movePart();
  if (!part) {
    moveAnchor.set(0, 0, 0);
    return;
  }
  const c = part.boundsCenter;
  if (c) {
    moveAnchor.set(c[0], c[1], c[2]);
    return;
  }
  // No OCCT bounds — a mesh part. Its own geometry is the next best thing.
  part.mesh.geometry.computeBoundingBox();
  part.mesh.geometry.boundingBox?.getCenter(moveAnchor);
}

function updateMoveButtons(): void {
  const enough = currentParts.length >= 1;
  for (const mode of ["move", "rotate"] as const) {
    const btn = document.getElementById(`btn-${mode}`) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.disabled = !enough;
    const armed = moveMode === (mode === "move" ? "translate" : "rotate");
    btn.classList.toggle("active", armed);
  }
}

function renderMoveBar(): void {
  if (!moveMode) return;
  miBodyEl.innerHTML = "";
  for (const part of currentParts) {
    const opt = document.createElement("option");
    opt.value = part.name;
    opt.textContent = part.name;
    opt.selected = part.name === movePartName;
    miBodyEl.appendChild(opt);
  }
  renderMoveFields();
  renderMovePreview();
}

/** State → the numeric fields. Skipped for whichever field has focus. */
function renderMoveFields(): void {
  const set = (el: HTMLInputElement, v: number) => {
    if (document.activeElement === el) return;
    el.value = String(Number(v.toFixed(3)));
  };
  set(miXEl, moveDelta.x);
  set(miYEl, moveDelta.y);
  set(miZEl, moveDelta.z);
  set(miAngleEl, angleAboutAxis(moveQuat, AXIS_VECTORS[miAxisEl.value] ?? AXIS_VECTORS.z!));
  miApplyEl.disabled = !moveHasChange() || pendingTransform !== null;
}

function moveHasChange(): boolean {
  if (moveDelta.lengthSq() > 1e-12) return true;
  return Math.abs(angleAboutAxis(moveQuat, AXIS_VECTORS[miAxisEl.value] ?? AXIS_VECTORS.z!)) > 1e-6;
}

/**
 * The suffix that will be appended to the body's shape expression.
 *
 * Written against the body's NAME, which is what the file usually holds there.
 * Where it holds an expression instead, the host writes the same chain onto
 * that expression — and hoists it to a const first when a self-pivot needs to
 * name it twice. The note says so rather than the line pretending otherwise.
 */
function renderMovePreview(): void {
  if (!moveMode) return;
  miCodeEl.textContent = "";
  miNotesEl.innerHTML = "";
  const name = movePartName ?? "shape";
  const axisName = miAxisEl.value;
  const angle = angleAboutAxis(moveQuat, AXIS_VECTORS[axisName] ?? AXIS_VECTORS.z!);
  const selfPivot = miPivotEl.value === "self";

  const copying = miCopyEl.checked;
  let code = copying ? `${name}.clone()` : name;
  let wrote = false;
  const turning = Math.abs(angle) > 1e-6;
  if (turning) {
    const axis = AXIS_VECTORS[axisName]!;
    const axisLit = `[${axis.x}, ${axis.y}, ${axis.z}]`;
    if (!selfPivot && axisName === "z") {
      code += `.rotate(${trimNum(angle)})`;
    } else {
      code += `.rotate(${trimNum(angle)}, ${selfPivot ? `${name}.boundingBox.center` : "[0, 0, 0]"}, ${axisLit})`;
    }
    wrote = true;
  }
  if (moveDelta.lengthSq() > 1e-12) {
    code += `.translate(${trimNum(moveDelta.x)}, ${trimNum(moveDelta.y)}, ${trimNum(moveDelta.z)})`;
    wrote = true;
  }
  miCodeEl.textContent = wrote ? code : "…";

  const notes: Array<{ text: string; warn?: boolean }> = [];
  // Only when there IS a turn. A pure translate has no pivot, and saying where
  // it would have turned describes something that is not happening.
  if (turning) {
    // Both pivots are durable BY CONSTRUCTION — one is a constant, the other
    // is the expression that recomputes the centre — so unlike the face
    // selectors there is nothing to warn about. Say which, so the choice is
    // understood rather than merely made.
    notes.push({
      text: selfPivot
        ? "turns about the body's own centre, recomputed as the model changes"
        : "turns about the world origin",
    });
    if (!movePart()?.boundsCenter && selfPivot) {
      notes.push({
        text: "⚠ this body has no measured bounds — turning about the origin instead",
        warn: true,
      });
    }
  }
  if (wrote && copying) {
    notes.push({ text: `adds a second body named "${copyName()}" — the original stays put` });
  }
  for (const n of notes) {
    const el = document.createElement("span");
    if (n.warn) el.className = "warn";
    el.textContent = n.text;
    miNotesEl.appendChild(el);
  }
}

function trimNum(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** A numeric field, or null when it does not hold a usable number. */
function readField(el: HTMLInputElement): number | null {
  const raw = el.value.trim().replace(",", ".");
  if (raw === "" || raw === "-") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function onMoveFieldInput(): void {
  if (!moveMode) return;
  if (moveMode === "translate") {
    moveDelta.set(
      readField(miXEl) ?? moveDelta.x,
      readField(miYEl) ?? moveDelta.y,
      readField(miZEl) ?? moveDelta.z,
    );
  } else {
    const deg = readField(miAngleEl);
    if (deg !== null) {
      const axis = AXIS_VECTORS[miAxisEl.value] ?? AXIS_VECTORS.z!;
      moveQuat.setFromAxisAngle(axis, (deg * Math.PI) / 180);
    }
  }
  applyMoveTransform();
  syncMoveGizmo();
  renderMovePreview();
  miApplyEl.disabled = !moveHasChange() || pendingTransform !== null;
}

let transformRequestId = 0;
let pendingTransform: number | null = null;

function applyMove(): void {
  if (!moveMode || !movePartName || !moveHasChange()) {
    setParamsStatus("Move the body first — nothing to write.", true);
    return;
  }
  if (pendingTransform !== null) return;

  const axisName = miAxisEl.value;
  const axis = AXIS_VECTORS[axisName] ?? AXIS_VECTORS.z!;
  const angle = angleAboutAxis(moveQuat, axis);

  transformRequestId += 1;
  pendingTransform = transformRequestId;
  miApplyEl.disabled = true;
  setParamsStatus(`${MOVE_LABEL[moveMode]}…`);
  postToExtension({
    type: "transform",
    requestId: transformRequestId,
    partName: movePartName,
    ...(Math.abs(angle) > 1e-6
      ? {
          rotate: {
            angle,
            axis: [axis.x, axis.y, axis.z] as [number, number, number],
            // A name, not a coordinate: the host writes the expression that
            // recomputes it, so the edit stays true as the model changes.
            pivot: (miPivotEl.value === "origin" ? "origin" : "self") as "origin" | "self",
          },
        }
      : {}),
    ...(moveDelta.lengthSq() > 1e-12
      ? { translate: [moveDelta.x, moveDelta.y, moveDelta.z] as [number, number, number] }
      : {}),
    ...(miCopyEl.checked ? { copyAs: copyName() } : {}),
  });
}

for (const [id, mode] of [
  ["btn-move", "translate"],
  ["btn-rotate", "rotate"],
] as const) {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) continue;
  btn.addEventListener("click", () => setMoveMode(moveMode === mode ? null : mode));
}

miBodyEl.addEventListener("change", () => {
  movePartName = miBodyEl.value || null;
  updatePartsList();
  clearMoveTransforms();
  clearMoveCopyGhost();
  moveDelta.set(0, 0, 0);
  moveQuat.set(0, 0, 0, 1);
  captureMoveAnchor();
  applyMoveTransform();
  syncMoveGizmo();
  renderMoveBar();
});

miAxisEl.addEventListener("change", () => {
  // The angle was measured about the OLD axis; carrying the number over would
  // silently turn the body somewhere else. Start the new axis at zero.
  moveQuat.set(0, 0, 0, 1);
  applyMoveTransform();
  syncMoveGizmo();
  renderMoveFields();
  renderMovePreview();
});

miPivotEl.addEventListener("change", () => {
  applyMoveTransform();
  syncMoveGizmo();
  renderMovePreview();
});

for (const el of [miXEl, miYEl, miZEl, miAngleEl]) {
  el.addEventListener("input", onMoveFieldInput);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyMove();
      e.preventDefault();
    } else if (e.key === "Escape") {
      setMoveMode(null);
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

miCopyEl.addEventListener("change", () => {
  // Switching sides moves the transform between the body and the ghost, so
  // both have to be put back before it is re-applied.
  clearMoveTransforms();
  clearMoveCopyGhost();
  applyMoveTransform();
  syncMoveGizmo();
  renderMovePreview();
});

miResetEl.addEventListener("click", () => {
  moveDelta.set(0, 0, 0);
  moveQuat.set(0, 0, 0, 1);
  applyMoveTransform();
  syncMoveGizmo();
  renderMoveFields();
  renderMovePreview();
});

miApplyEl.addEventListener("click", applyMove);
miCancelEl.addEventListener("click", () => setMoveMode(null));

// Snapping is on by default so a drag lands on a round number; Shift lifts it
// for the occasional value that is not round.
function setMoveSnapping(on: boolean): void {
  transformControls.translationSnap = on ? MOVE_SNAP_MM : null;
  transformControls.rotationSnap = on ? (ROTATE_SNAP_DEG * Math.PI) / 180 : null;
}
setMoveSnapping(true);
window.addEventListener("keydown", (e) => {
  if (e.key === "Shift") setMoveSnapping(false);
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Shift") setMoveSnapping(true);
});

// ── Mirror and Pattern ────────────────────────────────────────────────────
//
// Fusion's Create → Mirror and Create → Pattern. Both make copies of a body,
// which is why they share a bar: the only real difference is how many and
// where.
//
// Mirror is the one operation in the whole viewport with nothing in it that
// can go stale. `shape.mirror("XZ")` names a standard plane through the
// origin — not a pivot, not an offset, not a measured coordinate — so it means
// the same thing whatever the model becomes. Everything else we write has to
// argue for its durability; this one has nothing to argue about.
//
// The preview goes through the kernel, unlike Move's. A mirror fuses two
// solids and a pattern fuses N, so the topology genuinely changes and there is
// nothing a matrix on the part group could stand in for.

const arrangeInfoEl = document.getElementById("arrange-info")!;
const aiOpEl = document.getElementById("ai-op")!;
const aiBodyEl = document.getElementById("ai-body") as HTMLSelectElement;
const aiMirrorEl = document.getElementById("ai-mirror") as HTMLElement;
const aiPatternEl = document.getElementById("ai-pattern") as HTMLElement;
const aiPlaneEl = document.getElementById("ai-plane") as HTMLSelectElement;
const aiNewBodyEl = document.getElementById("ai-newbody-toggle") as HTMLInputElement;
const aiKindEl = document.getElementById("ai-kind") as HTMLSelectElement;
const aiGridEl = document.getElementById("ai-grid") as HTMLElement;
const aiPolarEl = document.getElementById("ai-polar") as HTMLElement;
const aiNxEl = document.getElementById("ai-nx") as HTMLInputElement;
const aiNyEl = document.getElementById("ai-ny") as HTMLInputElement;
const aiDxEl = document.getElementById("ai-dx") as HTMLInputElement;
const aiDyEl = document.getElementById("ai-dy") as HTMLInputElement;
const aiGPlaneEl = document.getElementById("ai-gplane") as HTMLSelectElement;
const aiCountEl = document.getElementById("ai-count") as HTMLInputElement;
const aiRadiusEl = document.getElementById("ai-radius") as HTMLInputElement;
const aiAxisEl = document.getElementById("ai-axis") as HTMLSelectElement;
const aiApplyEl = document.getElementById("ai-apply") as HTMLButtonElement;
const aiCancelEl = document.getElementById("ai-cancel") as HTMLButtonElement;
const aiCodeEl = document.getElementById("ai-code")!;
const aiNotesEl = document.getElementById("ai-notes")!;

type ArrangeMode = "mirror" | "pattern";

let arrangeMode: ArrangeMode | null = null;
let arrangePartName: string | null = null;
/**
 * The body list frozen when the command was armed.
 *
 * Same reason the combine bar freezes one: a preview REBUILDS the model, and a
 * mirror previewed as a new body puts an extra entry in `currentParts`. Read
 * live, the menu would grow an option for a body that does not exist in the
 * file yet.
 */
let arrangeBodies: string[] = [];

let arrangeRequestId = 0;
let pendingArrange: number | null = null;

/** A numeric field, or null when it does not hold a usable number. */
function readArrangeField(el: HTMLInputElement, whole: boolean): number | null {
  const raw = el.value.trim().replace(",", ".");
  if (raw === "" || raw === "-") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (whole && (!Number.isInteger(n) || n < 1)) return null;
  return n;
}

/** What the bar currently describes, or null when the fields do not add up. */
function arrangeSpec(): PreviewArrange["spec"] | null {
  if (arrangeMode === "mirror") {
    return { kind: "mirror", plane: aiPlaneEl.value as "XY" | "XZ" | "YZ" };
  }
  if (aiKindEl.value === "polar") {
    const count = readArrangeField(aiCountEl, true);
    const radius = readArrangeField(aiRadiusEl, false);
    if (count === null || radius === null || count < 2 || radius <= 0) return null;
    return { kind: "polar", count, radius, axis: aiAxisEl.value as "X" | "Y" | "Z" };
  }
  const nx = readArrangeField(aiNxEl, true);
  const ny = readArrangeField(aiNyEl, true);
  const dx = readArrangeField(aiDxEl, false);
  const dy = readArrangeField(aiDyEl, false);
  if (nx === null || ny === null || dx === null || dy === null) return null;
  // 1 x 1 is a no-op wearing a pattern's clothes.
  if (nx * ny < 2) return null;
  return { kind: "grid", nx, ny, dx, dy, plane: aiGPlaneEl.value as "XY" | "XZ" | "YZ" };
}

/** The name a mirrored new body would take, made unique against what exists. */
function arrangeNewBodyName(): string {
  const base = `${arrangePartName ?? "body"} mirrored`;
  const taken = new Set(arrangeBodies);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${arrangeRequestId}`;
}

function arrangeAsNewBody(): string | undefined {
  // Only a mirror offers it: a pattern's copies are already fused into one
  // solid, so "as a new body" would mean a body containing the original.
  return arrangeMode === "mirror" && aiNewBodyEl.checked ? arrangeNewBodyName() : undefined;
}

function setArrangeMode(mode: ArrangeMode | null): void {
  if (mode !== null && currentParts.length === 0) return;

  if (mode === null) {
    arrangeMode = null;
    arrangePartName = null;
    arrangeBodies = [];
    arrangeInfoEl.classList.remove("visible");
    revertPreview();
    applyArrangeTint();
    updateArrangeButtons();
    return;
  }

  // Re-arming while a preview is showing would freeze the PREVIEWED body list.
  if (arrangeMode === null && previewShowing) revertPreview();

  // One modal command at a time.
  setMoveMode(null);
  setCombineOp(null);
  setActiveOp(null);
  facePicker.setSelection(null);
  faceInfoEl.classList.remove("visible");

  const rearming = arrangeMode !== null;
  arrangeMode = mode;
  if (!rearming) {
    arrangeBodies = currentParts.map((p) => p.name);
    const picked = facePicker.getSelection()?.partName;
    arrangePartName =
      picked && arrangeBodies.includes(picked) ? picked : (arrangeBodies[0] ?? null);
  }

  aiOpEl.textContent = mode === "mirror" ? "Mirror" : "Pattern";
  aiMirrorEl.hidden = mode !== "mirror";
  aiPatternEl.hidden = mode !== "pattern";
  arrangeInfoEl.classList.add("visible");
  renderArrangeBar();
  applyArrangeTint();
  updateArrangeButtons();
  scheduleArrangePreview();
}

function updateArrangeButtons(): void {
  for (const [id, mode] of [
    ["btn-mirror", "mirror"],
    ["btn-pattern", "pattern"],
  ] as const) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.disabled = currentParts.length === 0;
    btn.classList.toggle("active", arrangeMode === mode);
  }
}

function renderArrangeBar(): void {
  if (!arrangeMode) return;
  aiBodyEl.innerHTML = "";
  for (const name of arrangeBodies) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === arrangePartName;
    aiBodyEl.appendChild(opt);
  }
  aiGridEl.hidden = aiKindEl.value !== "grid";
  aiPolarEl.hidden = aiKindEl.value !== "polar";
  renderArrangePreview();
}

/**
 * The line that will be written.
 *
 * Against the body's NAME, which is what the file usually holds in the entry.
 * Where it holds an expression instead, the host writes the same call onto
 * that expression, hoisting it to a const first — every form here names the
 * shape at least twice.
 */
function renderArrangePreview(): void {
  if (!arrangeMode) return;
  aiCodeEl.textContent = "";
  aiNotesEl.innerHTML = "";
  const name = arrangePartName ?? "shape";
  const spec = arrangeSpec();
  const notes: Array<{ text: string; warn?: boolean }> = [];

  if (!spec) {
    aiCodeEl.textContent = "…";
    notes.push({
      text: "⚠ counts must be whole numbers, and at least one copy has to move",
      warn: true,
    });
  } else if (spec.kind === "mirror") {
    const reflected = `${name}.clone().mirror("${spec.plane}")`;
    aiCodeEl.textContent = aiNewBodyEl.checked
      ? reflected
      : `joinBodies(${name}, ${reflected})`;
    notes.push({
      text: aiNewBodyEl.checked
        ? `adds a second body named "${arrangeNewBodyName()}" — the original stays put`
        : "fuses the reflection into the original, making one symmetric body",
    });
    // Worth saying out loud, because every other command in this viewport has
    // to qualify its durability and this one does not.
    notes.push({ text: "a standard plane through the origin — nothing here to go stale" });
  } else {
    const args =
      spec.kind === "grid"
        ? `patterns.grid(${spec.nx}, ${spec.ny}, ${trimNum(spec.dx)}, ${trimNum(spec.dy)}` +
          (spec.plane === "XY" ? ")" : `, { plane: "${spec.plane}" })`)
        : `patterns.polar(${spec.count}, ${trimNum(spec.radius)}` +
          (spec.axis === "Z" ? ")" : `, { axis: "${spec.axis}" })`);
    aiCodeEl.textContent = `patterns.repeat(${name}, ${args})`;
    const n = spec.kind === "grid" ? spec.nx * spec.ny : spec.count;
    notes.push({ text: `${n} copies, fused into one body` });
    if (n > 60) {
      // Every copy is an OCCT fuse. Say so before the render stalls rather
      // than after.
      notes.push({ text: "⚠ that many fuses will be slow to build", warn: true });
    }
  }

  for (const nt of notes) {
    const el = document.createElement("span");
    if (nt.warn) el.className = "warn";
    el.textContent = nt.text;
    aiNotesEl.appendChild(el);
  }
  aiApplyEl.disabled = !spec || pendingArrange !== null;
}

/** What the armed Mirror / Pattern would preview, or null when nothing is. */
function arrangePayload(): PreviewArrange | null {
  if (!arrangeMode || !arrangePartName) return null;
  const spec = arrangeSpec();
  if (!spec) return null;
  const asNewBody = arrangeAsNewBody();
  return {
    partName: arrangePartName,
    spec,
    ...(asNewBody ? { asNewBody } : {}),
  };
}

function scheduleArrangePreview(): void {
  if (arrangePayload()) schedulePreview();
}

function applyArrange(): void {
  if (!arrangeMode || !arrangePartName) return;
  const spec = arrangeSpec();
  if (!spec) {
    setParamsStatus("Those numbers do not describe a pattern.", true);
    return;
  }
  if (pendingArrange !== null) return;

  arrangeRequestId += 1;
  pendingArrange = arrangeRequestId;
  aiApplyEl.disabled = true;
  setParamsStatus(`${arrangeMode === "mirror" ? "Mirror" : "Pattern"}…`);
  const asNewBody = arrangeAsNewBody();
  postToExtension({
    type: "arrange",
    requestId: arrangeRequestId,
    partName: arrangePartName,
    spec,
    ...(asNewBody ? { asNewBody } : {}),
  });
}

for (const [id, mode] of [
  ["btn-mirror", "mirror"],
  ["btn-pattern", "pattern"],
] as const) {
  const btn = document.getElementById(id) as HTMLButtonElement | null;
  if (!btn) continue;
  btn.addEventListener("click", () => setArrangeMode(arrangeMode === mode ? null : mode));
}

aiBodyEl.addEventListener("change", () => {
  arrangePartName = aiBodyEl.value || null;
  applyArrangeTint();
  renderArrangePreview();
  scheduleArrangePreview();
});

for (const el of [aiPlaneEl, aiKindEl, aiGPlaneEl, aiAxisEl, aiNewBodyEl]) {
  el.addEventListener("change", () => {
    renderArrangeBar();
    scheduleArrangePreview();
  });
}

for (const el of [aiNxEl, aiNyEl, aiDxEl, aiDyEl, aiCountEl, aiRadiusEl]) {
  el.addEventListener("input", () => {
    renderArrangePreview();
    scheduleArrangePreview();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      applyArrange();
      e.preventDefault();
    } else if (e.key === "Escape") {
      setArrangeMode(null);
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

aiApplyEl.addEventListener("click", applyArrange);
aiCancelEl.addEventListener("click", () => setArrangeMode(null));

// Hover is advisory, so it is the first thing to give up: skip it entirely
// while the user is orbiting (a raycast per pointermove during a drag is both
// wasted work and visually noisy), and while the measure tool owns the cursor.
let orbiting = false;
controls.addEventListener("start", () => {
  orbiting = true;
  facePicker.setHover(null);
});
controls.addEventListener("end", () => {
  orbiting = false;
});
// Belt and braces: a drag that ends without OrbitControls seeing it — a
// cancelled touch, a pointer that leaves the window — would otherwise leave
// `orbiting` stuck true and hover silently dead for the rest of the session.
for (const ev of ["pointerup", "pointercancel", "pointerleave"] as const) {
  renderer.domElement.addEventListener(ev, () => {
    orbiting = false;
  });
}

/**
 * The grab radius for edge picking, in world units, sized so it is roughly
 * constant on screen.
 *
 * An edge is a one-pixel target; without a radius it is essentially
 * unclickable. But the radius has to be in world units for the raycaster,
 * and a fixed one is a huge grab area zoomed in and an unhittable one zoomed
 * out. So it is derived from how much world one pixel covers at the model's
 * distance.
 */
const EDGE_GRAB_PX = 7;

/**
 * How much world space one screen pixel covers at the model's distance.
 *
 * The unit that lets screen-sized things — an edge grab radius, the drag
 * arrow — keep a constant apparent size while the camera moves.
 */
function worldPerPixel(): number {
  const h = renderer.domElement.clientHeight || 1;
  if (camera instanceof THREE.PerspectiveCamera) {
    const dist = camera.position.distanceTo(controls.target);
    return (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / h;
  }
  // Orthographic: the view height IS the world height, no distance term.
  const ortho = camera as THREE.OrthographicCamera;
  return (ortho.top - ortho.bottom) / ortho.zoom / h;
}

function edgeGrabRadius(): number {
  return EDGE_GRAB_PX * worldPerPixel();
}

/**
 * Resolve a pointer position to an edge if one is within the grab radius,
 * otherwise to the face under it.
 *
 * Edges win near a border because that is where the user is aiming when they
 * put the cursor there — the same precedence a CAD app uses. The cost is that
 * a face is slightly harder to select within 7 px of its own boundary, which
 * is a much smaller annoyance than an unselectable edge.
 */
function pickAt(clientX: number, clientY: number) {
  const edge = facePicker.pickEdge(clientX, clientY, renderer.domElement, edgeGrabRadius());
  if (edge) return edge;
  return facePicker.pick(clientX, clientY, renderer.domElement);
}

/**
 * Which body is under the pointer.
 *
 * A plain raycast against the part meshes rather than a reuse of `pickAt`,
 * because Combine works on bodies that have no B-Rep faces at all — a mesh
 * part imported or produced by Manifold renders and combines perfectly well,
 * and it would be invisible to the face picker.
 */
function pickBodyAt(clientX: number, clientY: number): string | null {
  if (!aimRaycaster(clientX, clientY)) return null;
  const meshes = currentParts.filter((p) => p.visible).map((p) => p.mesh);
  const hit = handleRaycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  return currentParts.find((p) => p.mesh === hit.object)?.name ?? null;
}

// ── Dragging the arrow ────────────────────────────────────────────────────
// The gesture a CAD user reaches for once something is selected: grab the
// handle and pull. It edits the NUMBER, not the file — Apply still commits,
// so what you see in the preview line is still what gets written.

interface HandleDrag {
  /** Distance the operation had when the drag started. */
  startValue: number;
  /** Where along the axis the pointer ray first landed. */
  startAlong: number;
  origin: THREE.Vector3;
  axis: THREE.Vector3;
  pointerId: number;
}

let handleDrag: HandleDrag | null = null;
/**
 * A drag ends with a `click` on the canvas, and a short one passes the
 * click-vs-drag slop test — which would re-pick, or clear the selection, the
 * instant the user let go of the arrow.
 */
let suppressNextClick = false;
const handleRaycaster = new THREE.Raycaster();
const handleNdc = new THREE.Vector2();

/** Set the raycaster from a pointer position, and return true if it worked. */
function aimRaycaster(clientX: number, clientY: number): boolean {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  handleNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  handleNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  handleRaycaster.setFromCamera(handleNdc, camera);
  return true;
}

/** Begin a drag if the pointer is on the arrow. Returns true if it started. */
function tryStartHandleDrag(event: PointerEvent): boolean {
  // An arrow pointing at the camera cannot be dragged meaningfully — it is
  // faded for exactly that reason, and letting the press through means the
  // user can orbit away instead of fighting a dead handle.
  if (!dragHandle.visible || !dragHandle.isUsable || !activeOp) return false;
  if (!aimRaycaster(event.clientX, event.clientY)) return false;
  if (handleRaycaster.intersectObject(dragHandle.hitTarget, false).length === 0) return false;

  const anchor = dragHandle.getAnchor();
  if (!anchor) return false;
  const value = parseDistance() ?? 0;
  const origin = new THREE.Vector3(...anchor.origin);
  const axis = dragHandle.worldAxis(value);
  const startAlong = projectRayOntoAxis(handleRaycaster.ray, origin, axis);
  if (startAlong === null) return false;

  handleDrag = { startValue: value, startAlong, origin, axis, pointerId: event.pointerId };
  suppressNextClick = true;
  // The orbit controls would otherwise spin the camera under the drag.
  controls.enabled = false;
  try {
    // Keeps the drag alive when the pointer leaves the canvas. Not essential —
    // and it throws for a pointer the browser does not consider active — so a
    // failure here must not take the drag down with it.
    renderer.domElement.setPointerCapture(event.pointerId);
  } catch {
    /* capture is a convenience, not a requirement */
  }
  renderer.domElement.style.cursor = "ns-resize";
  return true;
}

/**
 * Round to something a person would have typed.
 *
 * A raw projection produces 4.7382913 mm, which is both unusable as a
 * dimension and unreadable in the preview line. The step follows the
 * magnitude so a 0.5 mm fillet stays adjustable while a 40 mm extrude does not
 * crawl.
 */
function snapDragValue(v: number): number {
  const step = Math.abs(v) >= 20 ? 0.5 : Math.abs(v) >= 2 ? 0.1 : 0.05;
  return Math.round(v / step) * step;
}

function updateHandleDrag(event: PointerEvent): void {
  if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
  if (!aimRaycaster(event.clientX, event.clientY)) return;

  const along = projectRayOntoAxis(handleRaycaster.ray, handleDrag.origin, handleDrag.axis);
  // Null means the view has swung nearly parallel to the axis, where the
  // closest-approach point is unstable — hold the last value rather than
  // letting a pixel of mouse movement throw the dimension across the room.
  if (along === null) return;

  const raw = handleDrag.startValue + (along - handleDrag.startAlong);
  // Fillet and chamfer have no negative side; extrude does, and crossing zero
  // is how you turn a pull into a push.
  //
  // The upper clamp is the measured ceiling: dragging is a gesture that should
  // not be able to reach a value OCCT will refuse. Typing is not clamped — a
  // number someone deliberately entered is theirs, and it gets a warning
  // instead of being silently rewritten.
  const floored = activeOp === "extrude" ? raw : Math.max(0, raw);
  // Snap FIRST, then clamp — clamping first lets the snap round back up over
  // the ceiling, which is exactly how 8.994 became an unusable 9.0.
  let snapped = snapDragValue(floored);
  const ceiling = activeOp === "extrude" ? null : safeMaxRadius();
  if (ceiling !== null && ceiling > 0) snapped = Math.min(snapped, ceiling);
  fiDistEl.value = String(Number(snapped.toFixed(2)));
  renderOpPreview();
  // Debounced inside, so a drag costs one OCCT run per pause rather than one
  // per pointer event.
  schedulePreview();
}

function endHandleDrag(event: PointerEvent): void {
  if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
  handleDrag = null;
  // Re-render the settled value at full quality: the coarse mesh used during
  // the drag is not what the user should be judging the result by.
  lastPreviewKey = "";
  schedulePreview();
  controls.enabled = true;
  renderer.domElement.style.cursor = "";
  try {
    renderer.domElement.releasePointerCapture(event.pointerId);
  } catch {
    // The capture may already be gone if the pointer was cancelled.
  }
}

renderer.domElement.addEventListener("pointerdown", (event) => {
  tryStartHandleDrag(event);
}, true);
renderer.domElement.addEventListener("pointermove", updateHandleDrag);
renderer.domElement.addEventListener("pointerup", endHandleDrag);
renderer.domElement.addEventListener("pointercancel", endHandleDrag);

renderer.domElement.addEventListener("pointermove", (event) => {
  if (orbiting || measureMode || handleDrag) return;
  // Combine picks bodies, so highlighting a FACE under the cursor would
  // advertise a selection the click is not going to make.
  if (combineOp || moveMode || arrangeMode) {
    facePicker.setHover(null);
    // The gizmo sets its own cursor while it is hovered; do not fight it.
    if (!transformControls.axis) {
      renderer.domElement.style.cursor = pickBodyAt(event.clientX, event.clientY)
        ? "pointer"
        : "";
    }
    return;
  }
  const sel = pickAt(event.clientX, event.clientY);
  facePicker.setHover(sel);
  renderer.domElement.style.cursor = sel ? "pointer" : "";
});

renderer.domElement.addEventListener("pointerleave", () => {
  facePicker.setHover(null);
});

// --- Model management ---
function clearModelGroup() {
  modelGroup.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      if (child.material instanceof THREE.Material) child.material.dispose();
    }
  });
  modelGroup.clear();
  currentParts = [];
  // The selection indexed into buffers that no longer exist. Re-selecting the
  // "same" face after a rebuild would need geometry matching, not an index —
  // see the note at the top of selection.ts.
  facePicker.clear();
  updateFaceInfoPanel();
}

// ── Streaming render state ────────────────────────────────────────────────
// Parts arrive one at a time from the worker. We add each to the scene as
// it arrives so the user sees progress rather than a frozen spinner.
let streamingAccum: TessellatedPart[] = [];
let streamingExpected = 0;
// Visibility intents may arrive (via prepare-screenshot / set-part-visibility)
// before all parts have streamed in. We stash them here and re-apply as parts
// arrive and once more on mesh-done, so a delegating snippet whose resolved
// runtime result is an assembly still gets focusPart/hideParts honored.
let pendingVisibility: { focusPart?: string; hideParts?: string[] } | null = null;

/**
 * Whether the render now arriving should reframe the view.
 *
 * True for a new script, false for a re-execution of the one already on
 * screen. A re-execution is always something the user is actively adjusting,
 * and moving the camera under them mid-adjustment reads as lag.
 */
let fitOnThisRender = true;

function beginStreaming(totalParts: number) {
  clearModelGroup();
  // Tear down any prior motion sim — its parts were just disposed, and if this
  // render declares no `sim` the panel must not linger.
  clearSim();
  streamingAccum = [];
  streamingExpected = totalParts;
  pendingVisibility = null;
  statusEl.textContent = totalParts > 1 ? `0/${totalParts} parts…` : "rendering…";
}

function addPart(part: TessellatedPart) {
  const i = currentParts.length;
  const partGroup = new THREE.Group();
  partGroup.name = part.name;

  const colorValue = part.color || PART_COLORS[i % PART_COLORS.length];
  const colorHex =
    typeof colorValue === "string"
      ? colorValue
      : `#${colorValue.toString(16).padStart(6, "0")}`;

  const mesh = buildMesh(part.vertices, part.normals, part.triangles, colorValue);
  partGroup.add(mesh);

  let edgeLines: THREE.LineSegments | undefined;
  if (part.edgeVertices.length > 0) {
    edgeLines = buildEdges(part.edgeVertices);
    edgeLines.visible = edgesVisible;
    partGroup.add(edgeLines);
  }

  modelGroup.add(partGroup);
  currentParts.push({
    name: part.name,
    color: colorHex,
    visible: true,
    group: partGroup,
    mesh,
    vertices: part.vertices,
    triangles: part.triangles,
    faceGroups: part.faceGroups,
    faceInfo: part.faceInfo,
    edgeLines,
    edgeVertices: part.edgeVertices,
    edgeGroups: part.edgeGroups,
    boundsCenter: part.boundsCenter,
    volume: part.volume,
    surfaceArea: part.surfaceArea,
    centerOfMass: part.centerOfMass,
    expanded: false,
  });
  streamingAccum.push(part);
  updatePartsList();

  // Fit on the first part so the user immediately sees something instead
  // of waiting for the full gallery to finish — but ONLY for a script that
  // just arrived. Re-executions of the SAME script (a dragged parameter, a
  // face-operation preview) used to refit too, which yanked the camera every
  // time the value moved. That is most of what "laggy" was.
  if (currentParts.length === 1 && fitOnThisRender) {
    fitCameraToObject(camera, controls, modelGroup, dimensionsVisible ? dimensionGroup : undefined);
  }
  // Auto-open parts panel as soon as we know we're multi-part — once, for a
  // new model. Re-opening it under a user who closed it, on every preview
  // frame, is the same intrusion as reframing the camera.
  if (fitOnThisRender && currentParts.length === 2 && streamingExpected > 1 && !partsPanelOpen) {
    togglePartsPanel();
  }

  const tVerts = streamingAccum.reduce((s, p) => s + p.vertices.length / 3, 0);
  const tTris = streamingAccum.reduce((s, p) => s + p.triangles.length / 3, 0);
  if (streamingExpected > 1) {
    statusEl.textContent = `${tVerts} verts, ${tTris} tris | ${streamingAccum.length}/${streamingExpected} parts…`;
  } else {
    statusEl.textContent = `${tVerts} verts, ${tTris} tris`;
  }

  // Replay any deferred visibility intent so this freshly-arrived part honors
  // focusPart/hideParts immediately, instead of flashing visible first.
  if (pendingVisibility) {
    applyPartVisibility(pendingVisibility.focusPart, pendingVisibility.hideParts);
  }
}

// --- Parts browser panel ---
/** mm3 gets unreadable fast; switch to cm3 once it would need five digits. */
function formatVolume(mm3: number): string {
  return mm3 >= 1000
    ? `${formatNum(mm3 / 1000, 2)} cm\u00B3`
    : `${formatNum(mm3, 1)} mm\u00B3`;
}

function formatArea(mm2: number): string {
  return mm2 >= 1000
    ? `${formatNum(mm2 / 100, 2)} cm\u00B2`
    : `${formatNum(mm2, 1)} mm\u00B2`;
}

/**
 * Hand a body from the tree to whatever modal command is open.
 *
 * The Components panel is where a CAD user reaches to pick a body, and until
 * now it did nothing but expand a row — so with a pattern's copies covering
 * the viewport there was no way left to choose a different one at all.
 *
 * Returns true when the click was consumed, so the row's own expand/collapse
 * does not also fire.
 */
function selectBodyForArmedCommand(name: string): boolean {
  if (arrangeMode) {
    if (arrangeBodies.includes(name) && name !== arrangePartName) {
      arrangePartName = name;
      aiBodyEl.value = name;
      applyArrangeTint();
      renderArrangePreview();
      scheduleArrangePreview();
    }
    return true;
  }
  if (moveMode) {
    if (name !== movePartName) {
      miBodyEl.value = name;
      miBodyEl.dispatchEvent(new Event("change"));
    }
    return true;
  }
  if (combineOp) {
    if (combineCandidates().includes(name)) combineClickBody(name);
    return true;
  }
  return false;
}

/**
 * The browser tree.
 *
 * A flat list said only which parts exist. Every CAD browser is a tree because
 * a part has properties worth reading in place — and these were already being
 * measured on the OCCT shape and thrown away before they reached the panel.
 * Now each body expands to its own volume, surface area and centre of mass,
 * which until now you could only get by asking the MCP server.
 */
function updatePartsList() {
  partsList.innerHTML = "";
  partsCount.textContent = currentParts.length > 1 ? `(${currentParts.length})` : "";

  const bodies = document.createElement("div");
  bodies.className = "tree-group";

  const groupRow = document.createElement("div");
  groupRow.className = "tree-row tree-branch";
  groupRow.innerHTML =
    `<span class="tree-twisty open">\u25BE</span>` +
    `<span class="tree-label">Bodies</span>` +
    `<span class="tree-count">${currentParts.length}</span>`;
  const bodyList = document.createElement("div");
  bodyList.className = "tree-children";

  groupRow.addEventListener("click", () => {
    const open = bodyList.style.display !== "none";
    bodyList.style.display = open ? "none" : "";
    groupRow.querySelector(".tree-twisty")!.classList.toggle("open", !open);
    groupRow.querySelector(".tree-twisty")!.textContent = open ? "\u25B8" : "\u25BE";
  });

  currentParts.forEach((part) => {
    const hasStats =
      part.volume !== undefined ||
      part.surfaceArea !== undefined ||
      part.centerOfMass !== undefined;

    const row = document.createElement("div");
    const armed =
      (arrangeMode && part.name === arrangePartName) ||
      (moveMode && part.name === movePartName) ||
      (combineOp && part.name === combineTarget);
    row.className =
      `tree-row tree-leaf part-item${part.visible ? "" : " hidden"}` +
      (armed ? " armed" : "");

    const twisty = document.createElement("span");
    twisty.className = "tree-twisty";
    twisty.textContent = hasStats ? (part.expanded ? "\u25BE" : "\u25B8") : "";
    twisty.classList.toggle("open", !!part.expanded);

    const swatch = document.createElement("div");
    swatch.className = "part-swatch";
    swatch.style.background = part.color;

    const nameEl = document.createElement("span");
    nameEl.className = "part-name";
    nameEl.textContent = part.name;
    nameEl.title = part.name;

    const eyeEl = document.createElement("span");
    eyeEl.className = "part-eye";
    eyeEl.textContent = part.visible ? "\u25C9" : "\u25CB";
    eyeEl.title = part.visible ? "Hide this body" : "Show this body";

    row.append(twisty, swatch, nameEl, eyeEl);

    const props = document.createElement("div");
    props.className = "tree-props";
    props.style.display = part.expanded ? "" : "none";
    // A coordinate triple plus a long label will not fit a narrow panel on one
    // line, and truncating the NUMBERS is the worst of the options — so those
    // rows stack instead.
    const addProp = (label: string, value: string, stacked = false) => {
      const r = document.createElement("div");
      r.className = stacked ? "tree-prop stacked" : "tree-prop";
      r.innerHTML = `<span></span><span class="tree-prop-val"></span>`;
      r.querySelector("span")!.textContent = label;
      r.querySelector(".tree-prop-val")!.textContent = value;
      props.appendChild(r);
    };
    if (part.volume !== undefined) addProp("Volume", formatVolume(part.volume));
    if (part.surfaceArea !== undefined) addProp("Surface", formatArea(part.surfaceArea));
    if (part.centerOfMass) {
      // Which centre this is depends on how the part was measured. Without
      // volume the core took the cheap path and this is the bounding-box
      // centre, which is NOT the centre of mass for anything asymmetric.
      // Labelling both "Center" would quietly overstate one of them.
      addProp(
        part.volume === undefined ? "Bounds center" : "Center of mass",
        part.centerOfMass.map((n) => formatNum(n, 1)).join(", "),
        true,
      );
    }
    if (part.volume === undefined) {
      // Measuring volume and area costs roughly 200ms per part, so the core
      // only does it when a material is declared — at which point you get mass
      // too. Say so, rather than leaving the reader wondering what is missing.
      const hint = document.createElement("div");
      hint.className = "tree-hint";
      hint.textContent = "Add export const material for volume and mass";
      props.appendChild(hint);
    }

    // The eye owns visibility; the row owns expansion. Previously the whole row
    // toggled visibility, which meant there was nowhere left to click to read a
    // body's properties.
    eyeEl.addEventListener("click", (e) => {
      e.stopPropagation();
      part.visible = !part.visible;
      part.group.visible = part.visible;
      row.classList.toggle("hidden", !part.visible);
      eyeEl.textContent = part.visible ? "\u25C9" : "\u25CB";
      eyeEl.title = part.visible ? "Hide this body" : "Show this body";
    });

    // The row is a body first and a disclosure second. With a command open it
    // hands the body over; otherwise it expands, as before.
    row.addEventListener("click", () => {
      if (selectBodyForArmedCommand(part.name)) return;
      if (!hasStats) return;
      part.expanded = !part.expanded;
      props.style.display = part.expanded ? "" : "none";
      twisty.textContent = part.expanded ? "\u25BE" : "\u25B8";
      twisty.classList.toggle("open", !!part.expanded);
    });

    bodyList.append(row, props);
  });

  bodies.append(groupRow, bodyList);
  partsList.appendChild(bodies);
}

function togglePartsPanel() {
  partsPanelOpen = !partsPanelOpen;
  partsPanel.classList.toggle("open", partsPanelOpen);
  document.getElementById("btn-parts")!.classList.toggle("active", partsPanelOpen);
  // Trigger resize so Three.js recalculates
  setTimeout(() => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w > 0 && h > 0) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
  }, 160);
}

// --- ViewCube (preset camera angles) ---
function setCameraAngle(position: [number, number, number]) {
  // Include the dimension overlay in the bounds when it's visible — otherwise
  // the camera fits tight around the model and the Y/Z dimension labels
  // (anchored `0.2 * maxDim` outside the bbox on +X) fall off the right edge
  // of narrow aspect ratios (e.g. the 800×600 top-view render that clipped
  // the "Y: 20.0mm" label on the spacer). Sprites are world-positioned, so
  // setFromObject picks up their extent correctly.
  const box = new THREE.Box3().setFromObject(modelGroup);
  if (dimensionsVisible && dimensionGroup.children.length > 0) {
    box.union(new THREE.Box3().setFromObject(dimensionGroup));
  }
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const center = sphere.center;
  const dist = sphere.radius > 0 ? (sphere.radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.5 : 100;

  const dir = new THREE.Vector3(...position).normalize();
  camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  camera.up.set(0, 0, 1); // Z-up for CAD
  controls.target.copy(center);
  controls.update();
}

// --- Worker setup ---
const config = (globalThis as any).__SHAPEITUP_CONFIG__;
let worker: Worker | null = null;
let workerCrashed = false;
let workerResponseTimer: ReturnType<typeof setTimeout> | undefined;

function clearWorkerResponseTimer() {
  if (workerResponseTimer) {
    clearTimeout(workerResponseTimer);
    workerResponseTimer = undefined;
  }
}

let lastRespawnTime = 0;

function respawnWorker() {
  // Prevent rapid respawn loops — at most once every 5 seconds
  const now = Date.now();
  if (now - lastRespawnTime < 5000) {
    statusEl.textContent = "Renderer crashed — waiting before retry...";
    return;
  }
  lastRespawnTime = now;

  clearWorkerResponseTimer();
  statusEl.textContent = "Restarting renderer...";
  if (worker) {
    try { worker.terminate(); } catch {}
  }
  worker = null;
  workerCrashed = false;
  initWorker();
}

/**
 * Ask the extension host for cached WASM bytes (read once on activation by
 * `getCachedWasmAssets`). Resolves with the assets, or with `undefined` if
 * the extension didn't reply within `timeoutMs` — in which case the worker
 * falls back to URL fetch (the pre-cache behavior).
 *
 * Wired separately from the regular `onMessage` handler because we want to
 * scope the listener to a single request/response cycle without polluting
 * the global map. Using `window.addEventListener("message", ...)` directly
 * is fine here: the message-handler module just routes by type, it doesn't
 * own the message channel.
 */
function requestWasmAssetsFromExtension(
  timeoutMs = 2000,
): Promise<{ occt?: { loaderJs: string; wasmBytes: Uint8Array }; manifold?: { loaderJs: string; wasmBytes: Uint8Array } } | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const onMsg = (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.type !== "wasm-assets") return;
      settled = true;
      window.removeEventListener("message", onMsg);
      resolve({ occt: msg.occt, manifold: msg.manifold });
    };
    window.addEventListener("message", onMsg);
    postToExtension({ type: "request-wasm-assets" });
    setTimeout(() => {
      if (settled) return;
      window.removeEventListener("message", onMsg);
      // Falls through to URL-fetch path inside the worker.
      // eslint-disable-next-line no-console
      console.warn("[shapeitup viewer] wasm-assets request timed out — using URL fallback");
      resolve(undefined);
    }, timeoutMs);
  });
}

async function initWorker() {
  try {
    // Pull cached bytes from the extension host BEFORE creating the worker.
    // The extension preloaded these on activation (see wasm-cache.ts). If
    // the cache is cold (race on first activation, missing dist/ files),
    // assets is undefined and the worker falls back to URL fetch.
    const assets = await requestWasmAssetsFromExtension();

    const code = await fetch(config.workerUrl).then((res) => res.text());
    const blob = new Blob([code], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    worker.onmessage = (e) => handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      postToExtension({ type: "error", message: `Worker crashed: ${e.message}` });
      respawnWorker();
    };
    worker.postMessage({
      type: "init",
      // URL fallback (always populated — the worker prefers cached bytes
      // when present and uses these only if the extension didn't ship any).
      wasmLoaderUrl: config.wasmLoaderUrl,
      wasmUrl: config.wasmUrl,
      manifoldLoaderUrl: config.manifoldLoaderUrl,
      manifoldWasmUrl: config.manifoldWasmUrl,
      // Cached-bytes fast path. Either may be undefined (missing manifold
      // is fine; missing occt makes the worker fall back to URL fetch).
      occt: assets?.occt,
      manifold: assets?.manifold,
    });
  } catch (err) {
    postToExtension({ type: "error", message: `Failed to load worker: ${err}` });
  }
}

function handleWorkerMessage(msg: WorkerToWebview) {
  switch (msg.type) {
    case "ready":
      clearWorkerResponseTimer();
      loadingEl.style.display = "none";
      postToExtension({ type: "ready" });
      statusEl.textContent = "Ready";
      break;

    case "preview-delta":
      showDeltaGhost(msg.delta);
      break;
    case "preview-combine":
      // Belongs to whatever is armed NOW; a reply for a superseded selection
      // would report on bodies the user has already changed.
      if (combineOp) {
        combineStats = msg.stats;
        renderCombinePreview();
      }
      break;
    case "preview-limit":
      // Belongs to whatever is armed NOW; a reply for a superseded operation
      // would silently cap the wrong thing.
      if (activeOp && armedTarget) {
        opMaxRadius = msg.max;
        opMaxKey = opIdentity();
        renderOpPreview();
      }
      break;
    case "mesh-start":
      clearWorkerResponseTimer();
      try {
        beginStreaming(msg.totalParts);
      } catch (err: any) {
        postToExtension({ type: "error", message: `Render error: ${err.message}` });
      }
      break;

    case "mesh-part":
      try {
        addPart(msg.part);
      } catch (err: any) {
        postToExtension({ type: "error", message: `Render error: ${err.message}` });
      }
      break;

    case "mesh-done":
      try {
        // Final replay of any deferred visibility intent now that every part
        // has landed. Any genuinely-missing names will now produce their
        // warning (streaming is complete, so the "streaming" guard lifts).
        if (pendingVisibility) {
          const intent = pendingVisibility;
          pendingVisibility = null;
          applyPartVisibility(intent.focusPart, intent.hideParts);
        }
        // A face operation the user just applied may have declined at build
        // time — surface that before anything else overwrites the status line.
        reportFaceOpWarnings(msg.warnings);
        reportCombineWarnings(msg.warnings);
        // A cancelled preview leaves a selection to restore.
        applyPendingReselect();
        // The worker is free again; send whatever the drag moved on to.
        previewInFlight = false;
        const queued = queuedPreview;
        queuedPreview = null;
        if (queued) runPreview(queued.request, queued.key);

        // Track what the file declares, for the selection bar's selector
        // preview. `declared` is only present when an override is in force.
        declaredParamValues = {};
        for (const p of msg.params || []) declaredParamValues[p.name] = p.declared ?? p.value;
        updateParamsUI(msg.params || []);
        // A rebuild replaced every face; the bar is showing a stale one.
        updateFaceInfoPanel();
        // Every mesh is new, so the selection tint has to be put back — and
        // the ribbon has to re-decide whether Combine is even possible, since
        // a model that just became single-body cannot be combined.
        applyCombineTint();
        updateCombineButtons();
        // A parameter dragged under an open Move bar re-executes the script,
        // which replaces every group and with it the transform standing in for
        // the un-committed move. Put it back rather than have the body snap
        // home mid-edit.
        if (moveMode) {
          // The ghost holds clones of meshes this render has just replaced.
          clearMoveCopyGhost();
          applyMoveTransform();
          syncMoveGizmo();
          renderMoveBar();
        }
        updateMoveButtons();
        // A rebuild replaces every mesh and so every material the tint was
        // written onto. Re-apply, or the armed body goes dark mid-command.
        applyArrangeTint();
        updateArrangeButtons();
        // Motion sim: if the script exported a `sim` block, resolve it against
        // the parts we just rendered and show the timeline. No-op otherwise.
        // Async (the dynamics engine awaits Rapier's WASM); fire-and-forget with
        // its own error handling so a sim failure never breaks the render.
        void setupSim(msg.sim, currentParts).catch((e) =>
          console.warn("[ShapeItUp sim] setup failed:", e),
        );
        if (sectionActive) updateSectionPlane();
        if (dimensionsVisible) updateDimensions();
        // Re-fit with the final model (first-part fit may have been too tight).
        fitCameraToObject(camera, controls, modelGroup, dimensionsVisible ? dimensionGroup : undefined);

        const parts = streamingAccum;
        const totalVerts = parts.reduce((s, p) => s + p.vertices.length / 3, 0);
        const totalTris = parts.reduce((s, p) => s + p.triangles.length / 3, 0);
        const partLabel = parts.length > 1 ? ` | ${parts.length} parts` : "";
        const statusText = `${totalVerts} verts, ${totalTris} tris${partLabel} — ${msg.execTimeMs}ms + ${msg.tessTimeMs}ms`;
        statusEl.textContent = statusText;

        const bbox = new THREE.Box3().setFromObject(modelGroup);
        const bboxSize = bbox.getSize(new THREE.Vector3());

        const currentParams: Record<string, number> = {};
        for (const p of msg.params || []) currentParams[p.name] = p.value;

        const partProperties = parts.map((p) => ({
          name: p.name,
          volume: p.volume,
          surfaceArea: p.surfaceArea,
          centerOfMass: p.centerOfMass,
        }));
        let totalVolume = 0;
        let totalSurfaceArea = 0;
        let hasAnyVolume = false;
        let hasAnySurface = false;
        // Track the denominator for the CoM average SEPARATELY from totalVolume.
        // If any part with volume is missing a centerOfMass (e.g. BRepCheck
        // failed the part, or a MeshShape whose tet-integration produced
        // zero signed volume), dividing weightedCoM by totalVolume would
        // drag the result toward (0,0,0) in proportion to that part's
        // volume share — a silently wrong answer. Bail out to undefined
        // in that case instead.
        const weightedCoM: [number, number, number] = [0, 0, 0];
        let comDenominator = 0;
        let anyVolumetricPartMissingCoM = false;
        for (const p of parts) {
          if (typeof p.volume === "number") {
            totalVolume += p.volume;
            hasAnyVolume = true;
            if (p.centerOfMass) {
              weightedCoM[0] += p.centerOfMass[0] * p.volume;
              weightedCoM[1] += p.centerOfMass[1] * p.volume;
              weightedCoM[2] += p.centerOfMass[2] * p.volume;
              comDenominator += p.volume;
            } else if (p.volume > 0) {
              anyVolumetricPartMissingCoM = true;
            }
          }
          if (typeof p.surfaceArea === "number") {
            totalSurfaceArea += p.surfaceArea;
            hasAnySurface = true;
          }
        }
        const aggregateCoM: [number, number, number] | undefined =
          !anyVolumetricPartMissingCoM && comDenominator > 0
            ? [weightedCoM[0] / comDenominator, weightedCoM[1] / comDenominator, weightedCoM[2] / comDenominator]
            : undefined;

        postToExtension({
          type: "render-success",
          stats: statusText,
          partCount: parts.length,
          partNames: parts.map((p) => p.name),
          boundingBox: {
            x: parseFloat(bboxSize.x.toFixed(1)),
            y: parseFloat(bboxSize.y.toFixed(1)),
            z: parseFloat(bboxSize.z.toFixed(1)),
          },
          currentParams,
          timings: msg.timings,
          warnings: msg.warnings,
          properties: {
            parts: partProperties,
            totalVolume: hasAnyVolume ? totalVolume : undefined,
            totalSurfaceArea: hasAnySurface ? totalSurfaceArea : undefined,
            centerOfMass: aggregateCoM,
          },
        });
      } catch (err: any) {
        const errMsg = `Render error: ${err.message}`;
        postToExtension({ type: "error", message: errMsg });
        statusEl.textContent = errMsg;
        console.error("[ShapeItUp]", errMsg, err);
      }
      break;

    case "export-result":
      clearWorkerResponseTimer();
      postToExtension({ type: "export-data", format: msg.format, data: msg.data });
      statusEl.textContent = `Exported ${msg.format.toUpperCase()}`;
      break;

    case "export-split-result":
      clearWorkerResponseTimer();
      // Each item is { name, data: ArrayBuffer } — one file per part. The
      // extension writes them into a user-chosen folder.
      postToExtension({ type: "export-split-data", format: msg.format, items: msg.items });
      statusEl.textContent = `Exported ${msg.items.length} parts (${msg.format.toUpperCase()})`;
      break;

    case "error":
      clearWorkerResponseTimer();
      // Only respawn on actual WASM memory crashes — NOT on script errors like "X is not a function"
      if (
        msg.message.includes("memory access out of bounds") ||
        msg.message.includes("RuntimeError:") ||
        /^(\d{6,})$/.test(msg.message.trim()) // bare WASM pointer (6+ digits only)
      ) {
        if (!workerCrashed) { // prevent respawn loop
          workerCrashed = true;
          postToExtension({ type: "error", message: `WASM crash — restarting renderer. Cause: ${msg.message}` });
          // Delay respawn to let any in-flight fetches settle
          setTimeout(() => respawnWorker(), 2000);
        }
        return;
      }
      postToExtension({
        type: "error",
        message: msg.message,
        operation: (msg as any).operation,
        stack: (msg as any).stack,
      });
      statusEl.textContent = `Error: ${msg.message}`;
      break;

    case "needs-worker-restart":
      // Explicit restart signal from the worker (sent after an OOB crash).
      // The "error" case above already triggers respawnWorker() for the same
      // condition via substring match — this branch is the clean,
      // non-substring path and forwards the reason up to the extension host
      // (viewer-provider) so it can log the restart visibly to the user.
      clearWorkerResponseTimer();
      postToExtension({
        type: "status",
        message: `Worker restart requested: ${msg.reason}`,
      });
      if (!workerCrashed) {
        workerCrashed = true;
        setTimeout(() => respawnWorker(), 2000);
      }
      break;
  }
}

// --- Extension host messages ---
initMessageHandler();

onMessage("execute-script", (msg) => {
  if (worker) {
    statusEl.textContent = "Executing...";
    // A script arriving from the host is a new model to frame.
    fitOnThisRender = true;
    lastScriptJs = msg.js;
    // Reset slider state unless the caller supplied explicit overrides (e.g.
    // MCP tune_params rendering an ephemeral configuration). Seeding
    // currentParamValues from the overrides keeps the slider UI in sync with
    // what the worker is about to render.
    currentParamValues = msg.paramOverrides ? { ...msg.paramOverrides } : {};
    const name = msg.fileName.replace(/.*[\/\\]/, "");
    filenameEl.textContent = name;
    const workerMsg: {
      type: "execute";
      js: string;
      paramOverrides?: Record<string, number>;
      meshQuality?: "preview" | "final";
    } = {
      type: "execute",
      js: msg.js,
    };
    if (msg.paramOverrides && Object.keys(msg.paramOverrides).length > 0) {
      workerMsg.paramOverrides = msg.paramOverrides;
    }
    // P3-10: forward MCP-supplied meshQuality verbatim. Historically the
    // viewer filtered its worker-bound execute message to {js, paramOverrides}
    // and silently dropped meshQuality — meaning an MCP caller asking for
    // "preview" quality would get the auto-degrade default instead. Threaded
    // through here so the contract survives the last hop.
    if (msg.meshQuality) {
      workerMsg.meshQuality = msg.meshQuality;
    }
    worker.postMessage(workerMsg);

    // If the worker doesn't respond within 15s, assume it's dead and respawn
    clearWorkerResponseTimer();
    workerResponseTimer = setTimeout(() => {
      postToExtension({
        type: "error",
        message: "Script execution exceeded 15s — likely an infinite loop or runaway computation. Restarting renderer.",
      });
      respawnWorker();
    }, 15_000);
  }
});

onMessage("request-export", (msg) => {
  if (worker) {
    statusEl.textContent = `Exporting ${msg.format.toUpperCase()}...`;
    worker.postMessage({ type: "export", format: msg.format });
  }
});

onMessage("request-export-split", (msg) => {
  if (worker) {
    statusEl.textContent = `Exporting parts (${msg.format.toUpperCase()})...`;
    worker.postMessage({ type: "export-split", format: msg.format });
  }
});

// Track if a custom camera angle was set (by set-camera-angle command)
let customCameraAngleSet = false;
// Bug D: remember the preset requested by the most recent prepare-screenshot
// so request-screenshot can re-apply it against the CURRENT modelGroup bounds.
// Without this the camera was framed during prepare-screenshot (before the
// worker had tessellated the new shape), so preview_finder's pink spheres —
// added by the re-render after prepare-screenshot — could land outside the
// frustum or too small to see.
let pendingScreenshotCameraPreset: [number, number, number] | null = null;

onMessage("request-screenshot", (msg: any) => {
  // Bug D: if prepare-screenshot stashed a camera preset, re-apply it HERE
  // using the current modelGroup (which by now includes any highlight spheres
  // or multi-part output). This replaces the prior behavior where a stale
  // bounding box was used during prepare-screenshot.
  //
  // `presetForCapture` tracks the active preset for the ortho-swap decision
  // below. It mirrors whatever setCameraAngle was last called with in this
  // request path, falling back to isometric for the default/uncustomized
  // case. Only the screenshot path consults ortho; live interaction stays
  // on the perspective camera regardless of preset.
  let presetForCapture: [number, number, number] = [1, -1, 0.7];
  if (pendingScreenshotCameraPreset && modelGroup.children.length > 0) {
    presetForCapture = pendingScreenshotCameraPreset;
    setCameraAngle(pendingScreenshotCameraPreset);
    customCameraAngleSet = true;
    pendingScreenshotCameraPreset = null;
  }
  // Only set default isometric if no custom angle was explicitly set
  if (!customCameraAngleSet && modelGroup.children.length > 0) {
    setCameraAngle([1, -1, 0.7]);
  }
  customCameraAngleSet = false; // reset for next screenshot

  // Width/height override: renders at a fixed resolution regardless of the
  // user's window size. The WebGL backbuffer and camera aspect are resized
  // just for this screenshot, then restored so the live viewer is unaffected.
  // This is what makes the AI screenshot independent of how the user has
  // sized their VSCode window.
  const targetW = typeof msg?.width === "number" ? msg.width : 0;
  const targetH = typeof msg?.height === "number" ? msg.height : 0;
  const needsResize = targetW > 0 && targetH > 0;

  let origSize: { w: number; h: number; pr: number } | null = null;
  if (needsResize) {
    origSize = {
      w: container.clientWidth,
      h: container.clientHeight,
      pr: renderer.getPixelRatio(),
    };
    renderer.setPixelRatio(1);
    renderer.setSize(targetW, targetH, false);
    camera.aspect = targetW / targetH;
    camera.updateProjectionMatrix();
  }

  // Axis-aligned presets (top/bottom/front/back/left/right) render through
  // the orthographic camera so there's no vanishing-point skew — the
  // expected default for engineering side views. Isometric and custom
  // angles keep perspective, because iso is specifically an oblique
  // projection and custom angles don't have a natural ortho framing.
  const useOrtho = isAxisAligned(presetForCapture) && modelGroup.children.length > 0;
  const captureCamera: THREE.Camera = useOrtho ? orthoCamera : camera;
  if (useOrtho) {
    const w = needsResize ? targetW : container.clientWidth;
    const h = needsResize ? targetH : container.clientHeight;
    const aspect = h > 0 ? w / h : 1;
    frameOrthographicToBounds(
      orthoCamera,
      presetForCapture,
      modelGroup,
      aspect,
      dimensionsVisible ? dimensionGroup : undefined,
    );
  }

  try {
    controls.update();
    // The screenshot path may have just resized the backbuffer, and fat-line
    // widths are computed against it — sync before rendering, not only in the
    // animation loop, which does not run for this render.
    renderer.getSize(renderSize);
    syncEdgeHighlightWidths(overlayGroup, renderSize.x, renderSize.y);
    // autoClear is off (see setup), so clear before compositing main + gnomon.
    renderer.clear();
    renderer.render(scene, captureCamera);
    // Draw gnomon at the captured resolution, not the live container size —
    // otherwise the compass lands in the wrong corner of the screenshot when
    // the screenshot pipeline resizes the backbuffer (targetW/H != viewport).
    const gW = needsResize ? targetW : container.clientWidth;
    const gH = needsResize ? targetH : container.clientHeight;
    renderGnomon(gW, gH);
    const dataUrl = renderer.domElement.toDataURL("image/png");
    postToExtension({ type: "screenshot-data", dataUrl });
  } finally {
    if (origSize) {
      renderer.setPixelRatio(origSize.pr);
      renderer.setSize(origSize.w, origSize.h, false);
      camera.aspect = origSize.w / origSize.h;
      camera.updateProjectionMatrix();
    }
  }
});

// Camera angle presets: name → [x, y, z] direction vector.
//
// The six orthogonal names (top/bottom/front/back/left/right) are exactly
// axis-aligned so `isAxisAligned()` recognizes them and the screenshot
// pipeline renders them through `orthoCamera`. Engineers expect side views
// to be "true ortho" — no vanishing-point skew along the projection axis —
// so the 3/4-iso tilt that used to live on `front`/`right`/`back`/`left`
// (e.g. `[0, -1, 0.3]`) was removed. `isometric` keeps its tilt because
// isometric IS supposed to be a 3D oblique projection.
const CAMERA_ANGLE_PRESETS: Record<string, [number, number, number]> = {
  isometric: [1, -1, 0.7],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
};

// --- Per-part visibility control (used by render_preview focusPart/hideParts) ---
function applyPartVisibility(focusPart?: string, hideParts?: string[]) {
  // Honor the worker-announced total so a delegating snippet (whose resolved
  // runtime result is an assembly) isn't misdiagnosed as single-part just
  // because the first part landed before the visibility command did.
  const isAssembly = currentParts.length > 1 || streamingExpected > 1;
  // True while more parts are still expected. While streaming, we defer the
  // "name didn't match" and "not a multi-part assembly" warnings because the
  // missing parts may simply not have streamed in yet. The intent is stashed
  // in pendingVisibility and replayed from addPart + mesh-done.
  const streaming = streamingExpected > 0 && currentParts.length < streamingExpected;

  if (focusPart) {
    if (!isAssembly) {
      postToExtension({
        type: "part-warning",
        message: `focusPart "${focusPart}" ignored: this shape is not a multi-part assembly.`,
      });
    } else {
      const match = currentParts.find((p) => p.name === focusPart);
      if (!match) {
        if (streaming) {
          pendingVisibility = { focusPart, hideParts };
        } else {
          postToExtension({
            type: "part-warning",
            message: `focusPart "${focusPart}" did not match any loaded part. Available: ${currentParts.map((p) => p.name).join(", ")}`,
          });
        }
        // Fall through — nothing to focus yet; leave everything visible.
      } else {
        for (const p of currentParts) {
          const visible = p.name === focusPart;
          p.visible = visible;
          p.group.visible = visible;
        }
        updatePartsList();
        // Re-compute the dim-label overlay so it reflects the focused part's
        // bbox instead of the full assembly's extents.
        updateDimensions();
        // Keep the intent pending while more parts may still arrive so late
        // parts are also hidden on landing.
        if (streaming) pendingVisibility = { focusPart, hideParts };
        else pendingVisibility = null;
        return;
      }
    }
  }

  if (hideParts && hideParts.length > 0) {
    if (!isAssembly) {
      postToExtension({
        type: "part-warning",
        message: `hideParts ${JSON.stringify(hideParts)} ignored: this shape is not a multi-part assembly.`,
      });
      return;
    }
    const loadedNames = new Set(currentParts.map((p) => p.name));
    const missing = hideParts.filter((n) => !loadedNames.has(n));
    if (missing.length > 0 && !streaming) {
      postToExtension({
        type: "part-warning",
        message: `hideParts name(s) did not match any loaded part: ${missing.join(", ")}. Available: ${currentParts.map((p) => p.name).join(", ")}`,
      });
    }
    const hideSet = new Set(hideParts);
    for (const p of currentParts) {
      const visible = !hideSet.has(p.name);
      p.visible = visible;
      p.group.visible = visible;
    }
    updatePartsList();
    updateDimensions();
    if (streaming) pendingVisibility = { focusPart, hideParts };
    else pendingVisibility = null;
  }
}

function restorePartVisibility() {
  pendingVisibility = null;
  for (const p of currentParts) {
    p.visible = true;
    p.group.visible = true;
  }
  updatePartsList();
  updateDimensions();
}

/**
 * A commit can decline for reasons the viewer cannot know in advance — the file
 * changed underneath, the value stopped being a plain literal, the disk said no.
 * Say so. A slider that silently fails to save is worse than one that never
 * offered to, because the user walks away believing the change is on disk.
 */
onMessage("param-commit-result", (msg) => {
  if (msg.ok) {
    setParamsStatus(
      msg.clearedSidecar
        ? `Saved ${msg.name} — and dropped a pinned override for it`
        : `Saved ${msg.name} = ${msg.value}`,
    );
    return;
  }
  const explain: Record<string, string> = {
    "not-a-numeric-literal": "its value in the file is an expression, not a plain number",
    "param-not-found": "it is no longer declared in the file",
    "no-params-declaration": "the file has no `export const params`",
  };
  const why = explain[msg.reason] ?? msg.reason;
  setParamsStatus(`Not saved — ${msg.name}: ${why}`, true);
});

onMessage("face-op-result", (msg) => {
  // The host answers all three commands on this channel — the outcome really
  // is the same shape — so route by `kind` before anything else.
  if (msg.kind === "arrange") {
    if (msg.requestId !== pendingArrange) return;
    pendingArrange = null;
    aiApplyEl.disabled = false;
    if (!msg.ok) {
      setParamsStatus(`Not applied — ${msg.reason ?? "unknown reason"}`, true);
      return;
    }
    setParamsStatus(`Written — ${msg.applied ?? "arranged"}`);
    // The rebuild from the file carries it now, so the preview standing in for
    // it has to go or the geometry would be applied twice.
    setArrangeMode(null);
    return;
  }
  if (msg.kind === "transform") {
    if (msg.requestId !== pendingTransform) return;
    pendingTransform = null;
    miApplyEl.disabled = false;
    if (!msg.ok) {
      setParamsStatus(`Not applied — ${msg.reason ?? "unknown reason"}`, true);
      return;
    }
    setParamsStatus(`Written — ${msg.applied ?? "moved"}`);
    // The rebuild from the file carries the move, so the group transform that
    // was standing in for it has to go — otherwise it would be applied twice.
    setMoveMode(null);
    return;
  }
  if (msg.kind === "combine") {
    if (msg.requestId !== pendingCombine) return;
    pendingCombine = null;
    ciApplyEl.disabled = false;
    if (!msg.ok) {
      awaitingCombineRebuild = false;
      setParamsStatus(`Not applied — ${msg.reason ?? "unknown reason"}`, true);
      return;
    }
    setParamsStatus(msg.addedImport ? "Written — and added the shapeitup import" : "Written");
    // The file changed, so the watcher's rebuild is on its way. Close the bar
    // rather than leave it holding a body list the new model may not have.
    combineOp = null;
    combineTarget = null;
    combineTools = [];
    combineBodies = [];
    combineStats = null;
    combineInfoEl.classList.remove("visible");
    updateCombineButtons();
    return;
  }
  // A reply to a superseded request would report on work the user has already
  // moved past, so only the outstanding one is allowed to speak.
  if (msg.requestId !== pendingFaceOp) return;
  pendingFaceOp = null;
  fiApplyEl.disabled = false;

  if (!msg.ok) {
    setParamsStatus(`Not applied — ${msg.reason ?? "unknown reason"}`, true);
    return;
  }
  // The file is written; whether the operation actually changed the geometry
  // is only knowable after the rebuild. reportFaceOpWarnings has the last word.
  setParamsStatus(msg.addedImport ? "Written — and added the shapeitup import" : "Written");
  // The file changed, so a re-render is on its way from the watcher. The
  // selection indexes into buffers that render is about to replace, and there
  // is no honest way to re-find "the same face" across a topology change.
  setActiveOp(null);
  facePicker.setSelection(null);
  updateFaceInfoPanel();
});

onMessage("viewer-command", (msg) => {
  switch (msg.command) {
    case "set-render-mode":
      setRenderMode(msg.mode);
      break;
    case "toggle-dimensions":
      toggleDimensions(msg.show);
      break;
    case "toggle-axes":
      setAxes(msg.show, msg.scaleToModel);
      break;
    case "set-part-visibility":
      applyPartVisibility(msg.focusPart, msg.hideParts);
      break;
    case "restore-part-visibility":
      restorePartVisibility();
      break;
    case "set-camera-angle": {
      const preset = CAMERA_ANGLE_PRESETS[msg.angle];
      if (preset && modelGroup.children.length > 0) {
        setCameraAngle(preset);
        customCameraAngleSet = true;
      }
      break;
    }
    case "prepare-screenshot": {
      // Atomic: apply render mode + dimensions + axes + camera angle all at once
      setRenderMode(msg.renderMode || "ai");
      if (msg.showDimensions) toggleDimensions(true);
      else toggleDimensions(false);
      // showAxes is opt-in; when present, scale axes to the model so they're
      // legible without dominating the frame.
      setAxes(!!msg.showAxes, !!msg.showAxes);
      // showCompass defaults to true; callers can explicitly pass false to
      // suppress the corner gnomon for e.g. overhead PCB-style renders.
      showCompass = msg.showCompass === undefined ? true : !!msg.showCompass;
      // focusPart wins over hideParts when both are supplied.
      if (msg.focusPart || (msg.hideParts && msg.hideParts.length > 0)) {
        applyPartVisibility(msg.focusPart, msg.hideParts);
      }
      const camPreset = CAMERA_ANGLE_PRESETS[msg.cameraAngle || "isometric"];
      // Bug D: stash the preset so request-screenshot can re-frame against
      // the current modelGroup right before capture — prepare-screenshot's
      // modelGroup may be stale (pre-tessellation of a render that was
      // dispatched concurrently, especially for preview_finder where
      // highlightFinder adds pink spheres). We still apply it once here for
      // the visible-viewer feedback loop, but the authoritative framing
      // happens in request-screenshot.
      if (camPreset) {
        pendingScreenshotCameraPreset = camPreset;
        if (modelGroup.children.length > 0) {
          setCameraAngle(camPreset);
          customCameraAngleSet = true;
        }
      }
      // Force render two frames to ensure everything is updated
      controls.update();
      renderer.clear();
      renderer.render(scene, camera);
      renderGnomon(container.clientWidth, container.clientHeight);
      // T6.A: signal extension that prepare-screenshot has completed so it can
      // proceed without the unconditional 500ms sleep.
      postToExtension({ type: "screenshot-ready" });
      break;
    }
  }
});

// --- Toolbar buttons ---
document.getElementById("btn-parts")!.addEventListener("click", togglePartsPanel);

document.getElementById("btn-fit")!.addEventListener("click", () => {
  if (modelGroup.children.length > 0) fitCameraToObject(camera, controls, modelGroup, dimensionsVisible ? dimensionGroup : undefined);
});

document.getElementById("btn-edges")!.addEventListener("click", () => {
  edgesVisible = !edgesVisible;
  document.getElementById("btn-edges")!.classList.toggle("active", edgesVisible);
  modelGroup.traverse((child) => {
    if (child instanceof THREE.LineSegments) child.visible = edgesVisible;
  });
});

document.getElementById("btn-wire")!.addEventListener("click", () => {
  wireframe = !wireframe;
  document.getElementById("btn-wire")!.classList.toggle("active", wireframe);
  modelGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      (child.material as THREE.MeshPhongMaterial).wireframe = wireframe;
    }
  });
});

document.getElementById("btn-dims")!.addEventListener("click", () => {
  toggleDimensions();
  document.getElementById("btn-dims")!.classList.toggle("active", dimensionsVisible);
});

document.getElementById("btn-section")!.addEventListener("click", () => {
  sectionActive = !sectionActive;
  document.getElementById("btn-section")!.classList.toggle("active", sectionActive);
  document.getElementById("section-controls")!.classList.toggle("open", sectionActive);
  updateSectionPlane();
});

// Motion-simulation panel: wire its transport controls, then the toolbar toggle.
// The button stays disabled until a render declares an `export const sim` block.
initSimPanel();
document.getElementById("btn-sim")!.addEventListener("click", toggleSimPanel);

document.getElementById("btn-measure")!.addEventListener("click", () => {
  measureMode = !measureMode;
  if (measureMode) {
    // The selection bar and the measurement readout occupy the same slot at
    // the top of the viewport, and picking is suppressed in measure mode
    // anyway — so a live selection here could only sit there stale, under the
    // measurement it is overlapping.
    facePicker.setSelection(null);
    facePicker.setHover(null);
    updateFaceInfoPanel();
  }
  document.getElementById("btn-measure")!.classList.toggle("active", measureMode);
  renderer.domElement.style.cursor = measureMode ? "crosshair" : "default";
  if (!measureMode) {
    clearMeasurement();
  }
});

// --- Export dropdown ---
// Use the shared DetectedApp rather than a local re-declaration: the duplicate
// had drifted to `id: string`, which quietly widened the id the viewer sends
// back in `toolbar-open-in-app`.
type InstalledApp = Pick<DetectedApp, "id" | "name" | "preferredFormat">;

const exportWrapper = document.getElementById("export-menu-wrapper")!;
const exportMenu = document.getElementById("export-menu")!;
const exportBtn = document.getElementById("btn-export")!;
const appsContainer = document.getElementById("export-menu-apps")!;
let installedApps: InstalledApp[] = [];

function renderAppsMenu() {
  appsContainer.innerHTML = "";
  if (installedApps.length === 0) return;

  const sep = document.createElement("div");
  sep.className = "menu-sep";
  appsContainer.appendChild(sep);

  const heading = document.createElement("div");
  heading.className = "menu-heading";
  heading.textContent = "Open in";
  appsContainer.appendChild(heading);

  for (const app of installedApps) {
    const btn = document.createElement("button");
    btn.textContent = `${app.name} (${app.preferredFormat.toUpperCase()})`;
    btn.dataset.appId = app.id;
    btn.addEventListener("click", () => {
      exportWrapper.classList.remove("open");
      postToExtension({ type: "toolbar-open-in-app", appId: app.id });
    });
    appsContainer.appendChild(btn);
  }
}

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  exportWrapper.classList.toggle("open");
});

exportMenu.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const action = target.dataset.action;
  if (action === "export-step") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "step" });
  } else if (action === "export-stl") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "stl" });
  } else if (action === "export-3mf") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "3mf" });
  } else if (action === "export-split-step") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "step", split: true });
  } else if (action === "export-split-stl") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "stl", split: true });
  } else if (action === "export-split-3mf") {
    exportWrapper.classList.remove("open");
    postToExtension({ type: "toolbar-export", format: "3mf", split: true });
  }
});

document.addEventListener("click", (e) => {
  if (!exportWrapper.contains(e.target as Node)) {
    exportWrapper.classList.remove("open");
  }
});

onMessage("installed-apps", (msg) => {
  installedApps = msg.apps || [];
  renderAppsMenu();
});

// ── The ViewCube ──────────────────────────────────────────────────────────
//
// Replaces the grid of seven text buttons that used to sit here. Those gave
// you the six faces and an iso, and nothing else: no diagonal, no reading of
// where you already were. A cube gives all twenty-six directions, and — the
// part a button grid can never do — it TELLS you which way the model is
// facing, because it is turning as you orbit.
//
// The directions it hands back are axis-aligned (no tilt), so they still match
// CAMERA_ANGLE_PRESETS and trigger the orthographic capture path when the
// screenshot pipeline uses one. The interactive viewport keeps rendering
// through the perspective camera either way.

/** Kept in sync with #viewcube / #vc-home in viewer-html.ts. */
const VIEW_CUBE_SIZE = 108;
const VIEW_CUBE_MARGIN_RIGHT = 10;
const VIEW_CUBE_MARGIN_BOTTOM = 96;

/** Home. The same view `1` gives, and the one the model first loads in. */
const HOME_VIEW: [number, number, number] = [1, -1, 0.7];

/**
 * Spin the camera about the orbit target, in the same units OrbitControls
 * uses for a drag on the model — so dragging the cube feels like dragging the
 * view, because it is the same gesture at the same speed.
 */
function orbitCameraBy(dxPx: number, dyPx: number): void {
  const h = renderer.domElement.clientHeight || 1;
  const offset = camera.position.clone().sub(controls.target);

  // Spherical coordinates are Y-up and this application is Z-up, so the
  // offset is rotated into a Y-up frame for the maths and back out again.
  // Skipping this is how a Z-up orbit ends up tumbling about the wrong pole.
  const toYUp = new THREE.Quaternion().setFromUnitVectors(
    camera.up.clone().normalize(),
    new THREE.Vector3(0, 1, 0),
  );
  const fromYUp = toYUp.clone().invert();

  const spherical = new THREE.Spherical().setFromVector3(offset.applyQuaternion(toYUp));
  const speed = (2 * Math.PI) / h;
  spherical.theta -= dxPx * speed;
  spherical.phi -= dyPx * speed;
  // Stop just short of the poles: at exactly 0 or PI the azimuth is undefined
  // and the view snaps to an arbitrary roll.
  const EPS = 1e-4;
  spherical.phi = Math.max(EPS, Math.min(Math.PI - EPS, spherical.phi));

  camera.position
    .copy(controls.target)
    .add(offset.setFromSpherical(spherical).applyQuaternion(fromYUp));
  camera.lookAt(controls.target);
  controls.update();
}

const viewCube = new ViewCube(document.getElementById("viewcube")!, {
  onPick: (dir) => setCameraAngle(dir),
  onOrbit: orbitCameraBy,
});

document.getElementById("vc-home")!.addEventListener("click", () => setCameraAngle(HOME_VIEW));

// --- Parameter Sliders ---
import type { ParamDef } from "@shapeitup/shared";

const paramsPanel = document.getElementById("params-panel")!;
const paramsList = document.getElementById("params-list")!;
const paramsHeader = document.getElementById("params-header")!;
let currentParamDefs: ParamDef[] = [];

/**
 * Writeback is OFF by default, and deliberately so.
 *
 * A viewer that shows a model and a viewer that edits your source are different
 * promises. Nobody opening a preview expects a stray drag to modify a file, so
 * the destructive behaviour is the one you opt into. Turning it on later is a
 * click; taking it away from people who came to rely on it is not.
 *
 * The choice is per-viewer and remembered locally, since it is a habit rather
 * than a property of the model. Storage is wrapped because a webview or a
 * private window can refuse it outright, and a thrown SecurityError here would
 * take the whole panel down with it.
 */
const SAVE_PREF_KEY = "shapeitup.paramWriteback";
const paramsSaveToggle = document.getElementById("params-save-toggle") as HTMLInputElement;
const paramsSaveLabel = document.getElementById("params-save")!;
const paramsStatus = document.getElementById("params-status")!;

function readSavePref(): boolean {
  try {
    return localStorage.getItem(SAVE_PREF_KEY) === "on";
  } catch {
    return false;
  }
}

function writeSavePref(on: boolean): void {
  try {
    localStorage.setItem(SAVE_PREF_KEY, on ? "on" : "off");
  } catch {
    // Not worth telling the user about: the switch still works for this session.
  }
}

let writebackEnabled = readSavePref();
paramsSaveToggle.checked = writebackEnabled;
paramsSaveLabel.classList.toggle("on", writebackEnabled);

paramsSaveToggle.addEventListener("change", () => {
  writebackEnabled = paramsSaveToggle.checked;
  paramsSaveLabel.classList.toggle("on", writebackEnabled);
  writeSavePref(writebackEnabled);
  setParamsStatus(
    writebackEnabled
      ? "Releasing a slider now writes its value to the file."
      : "Sliders preview only — the file is not touched.",
  );
});

// The switch lives inside the header that expands and collapses the panel.
// Without this, flipping it also folds the panel away.
paramsSaveLabel.addEventListener("click", (e) => e.stopPropagation());

let paramsStatusTimer: ReturnType<typeof setTimeout> | undefined;
function setParamsStatus(text: string, warn = false): void {
  paramsStatus.textContent = text;
  paramsStatus.classList.toggle("warn", warn);
  paramsStatus.classList.toggle("show", text.length > 0);
  clearTimeout(paramsStatusTimer);
  if (text) {
    // A decline needs to sit long enough to read; a confirmation does not.
    paramsStatusTimer = setTimeout(() => setParamsStatus(""), warn ? 8000 : 3000);
  }
}
let currentParamValues: Record<string, number> = {};
let lastScriptJs: string = "";
let paramDebounceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Re-run the last bundle with the current slider values. The bundle is reused
 * as-is — parameters are applied as overrides inside the worker, so no
 * re-bundle and no round trip to the host is needed.
 */
function executeWithCurrentParams() {
  if (!worker || !lastScriptJs) return;
  statusEl.textContent = "Updating...";
  // Same model, new numbers — reframing here would fight the user's own view.
  fitOnThisRender = false;
  worker.postMessage({
    type: "execute",
    js: lastScriptJs,
    paramOverrides: { ...currentParamValues },
  });
}

/**
 * Rebuilding this panel is destructive, and it runs on EVERY mesh-done —
 * including the debounced re-execute 150 ms into a drag. That replaced the very
 * element the user had hold of: the browser keeps delivering pointer events to
 * the detached node, so the drag appeared to work while the visible handle
 * stopped tracking the mouse. It also dropped keyboard focus mid-interaction.
 *
 * So: only rebuild when the SET of parameters changes (a different file, or an
 * edit that added or removed a key). When the names match, update the existing
 * controls in place and leave the DOM — and the drag — alone.
 */
function paramNamesMatch(a: ParamDef[], b: ParamDef[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.name === b[i]!.name);
}

function updateParamsUI(params: ParamDef[]) {
  const previous = currentParamDefs;
  currentParamDefs = params;

  if (params.length === 0) {
    paramsList.innerHTML = "";
    paramsPanel.classList.remove("open");
    return;
  }

  if (previous && paramNamesMatch(previous, params)) {
    for (const p of params) {
      currentParamValues[p.name] = p.value;
      const input = document.getElementById(`pv-${p.name}`) as HTMLInputElement | null;
      if (!input) continue;
      input.dataset.step = String(p.step ?? (Math.abs(p.value) >= 10 ? 1 : 0.1));
      // Protect a field with edits in it, not merely one that holds focus.
      // Guarding on focus alone left a stale number on screen whenever the file
      // changed while the cursor happened to be resting in that field.
      const beingEdited = document.activeElement === input && input.dataset.dirty === "1";
      if (!beingEdited) {
        input.value = formatParamValue(p.value);
        input.classList.remove("invalid");
        delete input.dataset.dirty;
      }
    }
    return;
  }

  paramsList.innerHTML = "";
  paramsPanel.classList.add("open");

  for (const p of params) {
    currentParamValues[p.name] = p.value;

    const row = document.createElement("div");
    row.className = "param-row";

    const nameEl = document.createElement("div");
    nameEl.className = "param-name";
    nameEl.textContent = p.name;
    nameEl.title = p.name;

    const input = document.createElement("input");
    input.type = "text";
    // `text` rather than `number`: number inputs bring spinners we would only
    // hide, reject intermediate states like "1." while typing, and hand the
    // wheel to the browser on terms we cannot control.
    input.inputMode = "decimal";
    input.className = "param-input";
    input.id = `pv-${p.name}`;
    input.value = formatParamValue(p.value);
    input.spellcheck = false;
    input.autocomplete = "off";
    input.dataset.step = String(p.step ?? (Math.abs(p.value) >= 10 ? 1 : 0.1));
    input.title =
      "Scroll over this field to change it, or click to type. Shift = x10, Alt = x0.1.";

    /** Last value we know is good, for Escape and for rejecting bad input. */
    let lastGood = p.value;

    const preview = (val: number) => {
      currentParamValues[p.name] = val;
      if (paramDebounceTimer) clearTimeout(paramDebounceTimer);
      paramDebounceTimer = setTimeout(executeWithCurrentParams, 150);
    };

    const commit = (val: number) => {
      lastGood = val;
      delete input.dataset.dirty;
      currentParamValues[p.name] = val;
      // Flush any pending preview so what is on screen matches what is written.
      if (paramDebounceTimer) {
        clearTimeout(paramDebounceTimer);
        paramDebounceTimer = undefined;
      }
      executeWithCurrentParams();
      if (writebackEnabled) {
        postToExtension({ type: "param-changed", params: { [p.name]: val } });
      }
    };

    /** Parse what is typed. Rejects blanks, words, and half-typed signs. */
    const parse = (): number | null => {
      const raw = input.value.trim().replace(",", ".");
      if (!raw || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };

    // Typing previews but never commits: a value is not finished until you say
    // it is, and committing every keystroke would write "1", "12", "127" on the
    // way to 1270.
    input.addEventListener("input", () => {
      input.dataset.dirty = "1";
      const val = parse();
      input.classList.toggle("invalid", val === null && input.value.trim() !== "");
      if (val !== null) preview(val);
    });

    // Enter and blur are the two ways a typed value is finished.
    const finish = () => {
      const val = parse();
      if (val === null) {
        input.value = formatParamValue(lastGood);
        input.classList.remove("invalid");
        delete input.dataset.dirty;
        preview(lastGood);
        return;
      }
      input.value = formatParamValue(val);
      commit(val);
    };
    input.addEventListener("blur", finish);

    /** Nudge by one step, scaled by the modifier held. */
    const nudge = (direction: 1 | -1, e: { shiftKey: boolean; altKey: boolean }) => {
      const base = Number(input.dataset.step) || 1;
      const step = e.shiftKey ? base * 10 : e.altKey ? base / 10 : base;
      input.dataset.dirty = "1";
      const from = parse() ?? lastGood;
      // Re-round to the step's precision, or 0.1 steps accumulate float dust.
      const next = Number((from + direction * step).toFixed(6));
      input.value = formatParamValue(next);
      input.classList.remove("invalid");
      preview(next);
      scheduleNudgeCommit(next);
    };

    // A wheel or an arrow key has no natural "release", so a commit follows
    // once the nudging stops. Long enough to spin freely, short enough that
    // you do not wonder whether it saved.
    let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleNudgeCommit = (val: number) => {
      clearTimeout(nudgeTimer);
      nudgeTimer = setTimeout(() => commit(val), 400);
    };

    // Hover is enough — no click first. The listener is on the INPUT, not the
    // row, so the label half of every row still scrolls the panel normally.
    // That is the whole reason the field is only 58px wide.
    //
    // Two guards, both about not changing a dimension by accident:
    //
    //   deltaX — a sideways trackpad swipe is never an adjustment, and letting
    //   it through would make horizontal flicks nudge values.
    //
    //   dwell — scrolling the panel drags the cursor across these fields on the
    //   way past. Without a short settle, a scroll gesture would rewrite every
    //   parameter it swept over, and with writeback on it would save them too.
    //   Adjusting deliberately always means coming to rest on the field first.
    let hoverSince = 0;
    const DWELL_MS = 140;
    input.addEventListener("mouseenter", () => {
      hoverSince = performance.now();
    });
    input.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const settled = document.activeElement === input || performance.now() - hoverSince > DWELL_MS;
      if (!settled) return;
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1, e);
    }, { passive: false });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        nudge(e.key === "ArrowUp" ? 1 : -1, e);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        clearTimeout(nudgeTimer);
        finish();
        input.blur();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearTimeout(nudgeTimer);
        input.value = formatParamValue(lastGood);
        input.classList.remove("invalid");
        delete input.dataset.dirty;
        preview(lastGood);
        input.blur();
      }
    });

    // Selecting on focus makes replacing a value one gesture rather than three.
    input.addEventListener("focus", () => input.select());

    row.append(nameEl, input);
    paramsList.appendChild(row);
  }
}

/** Compact, and never scientific notation — nobody wants `1e-7` in a dimension. */
function formatParamValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(4)));
}

paramsHeader.addEventListener("click", () => {
  paramsPanel.classList.toggle("open");
});

// --- Section / Cross-Section Plane ---
let sectionActive = false;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

const sectionAxisSelect = document.getElementById("section-axis") as HTMLSelectElement;
const sectionPosSlider = document.getElementById("section-pos") as HTMLInputElement;
const sectionValueEl = document.getElementById("section-value")!;

function updateSectionPlane() {
  if (!sectionActive) {
    // Remove clipping
    renderer.clippingPlanes = [];
    return;
  }

  const box = new THREE.Box3().setFromObject(modelGroup);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const min = box.min;
  const pct = parseInt(sectionPosSlider.value) / 100;

  const axis = sectionAxisSelect.value;
  let normal: THREE.Vector3;
  let dist: number;

  if (axis === "x") {
    normal = new THREE.Vector3(-1, 0, 0);
    dist = min.x + size.x * pct;
  } else if (axis === "y") {
    normal = new THREE.Vector3(0, -1, 0);
    dist = min.y + size.y * pct;
  } else {
    normal = new THREE.Vector3(0, 0, -1);
    dist = min.z + size.z * pct;
  }

  clipPlane.normal.copy(normal);
  clipPlane.constant = dist;
  renderer.clippingPlanes = [clipPlane];

  const dimLabel = axis === "x" ? size.x : axis === "y" ? size.y : size.z;
  sectionValueEl.textContent = formatMm(dimLabel * pct, 1);
}

sectionAxisSelect.addEventListener("change", updateSectionPlane);
sectionPosSlider.addEventListener("input", updateSectionPlane);

// Enable local clipping on the renderer
renderer.localClippingEnabled = true;

// --- Click-to-Measure ---
let measureMode = false;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const measurePoints: THREE.Vector3[] = [];
const measureGroup = new THREE.Group();
scene.add(measureGroup);
const measureInfoEl = document.getElementById("measure-info")!;

function clearMeasurement() {
  measurePoints.length = 0;
  measureGroup.traverse((child) => {
    if ((child as any).geometry) (child as any).geometry.dispose();
    if ((child as any).material) (child as any).material.dispose();
  });
  measureGroup.clear();
  measureInfoEl.style.display = "none";
}

function addMeasurePoint(point: THREE.Vector3) {
  // Visual marker (small sphere)
  const geom = new THREE.SphereGeometry(
    Math.max(1, new THREE.Box3().setFromObject(modelGroup).getSize(new THREE.Vector3()).length() * 0.008),
    12, 12
  );
  const mat = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
  const marker = new THREE.Mesh(geom, mat);
  marker.position.copy(point);
  measureGroup.add(marker);

  measurePoints.push(point.clone());

  if (measurePoints.length === 2) {
    // Draw line between points
    const lineGeom = new THREE.BufferGeometry().setFromPoints(measurePoints);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
    measureGroup.add(new THREE.Line(lineGeom, lineMat));

    // Calculate distance
    const dist = measurePoints[0].distanceTo(measurePoints[1]);
    const dx = Math.abs(measurePoints[1].x - measurePoints[0].x);
    const dy = Math.abs(measurePoints[1].y - measurePoints[0].y);
    const dz = Math.abs(measurePoints[1].z - measurePoints[0].z);

    measureInfoEl.textContent =
      `Distance: ${formatMm(dist, 2)}  |  \u0394X: ${formatNum(dx, 1)}  \u0394Y: ${formatNum(dy, 1)}  \u0394Z: ${formatNum(dz, 1)}`;
    measureInfoEl.style.display = "block";

    // Reset for next measurement after a delay
    setTimeout(() => {
      measurePoints.length = 0;
    }, 100);
  }
}

// A `click` also fires at the end of an orbit drag, and selecting whatever
// happened to be under the cursor when the user finished rotating is the kind
// of thing that makes a viewer feel like it is fighting you. Compare against
// where the press started and treat anything that moved as a drag.
let pressX = 0;
let pressY = 0;
const CLICK_SLOP_PX = 4;
renderer.domElement.addEventListener("pointerdown", (event) => {
  pressX = event.clientX;
  pressY = event.clientY;
});

renderer.domElement.addEventListener("click", (event) => {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  // Gnomon click wins over everything else (including measure mode) so the
  // bottom-right nav widget is always responsive.
  if (tryGnomonClick(event)) return;
  if (!measureMode) {
    if (Math.hypot(event.clientX - pressX, event.clientY - pressY) > CLICK_SLOP_PX) return;
    // While Combine is armed a click means "this body", not "this face".
    // Empty space does NOT clear here: the command is a multi-step selection,
    // and losing it to a stray click on the background would be the single
    // most irritating way to lose work in this bar.
    if (combineOp) {
      const body = pickBodyAt(event.clientX, event.clientY);
      if (body) combineClickBody(body);
      return;
    }
    // Mirror and Pattern pick their body the same way — by clicking it. The
    // dropdown alone left no way to tell WHICH body was armed, or to change
    // it without hunting through a menu of names.
    if (arrangeMode) {
      const body = pickBodyAt(event.clientX, event.clientY);
      // Only bodies the FILE has. A mirror previewed as a new body puts an
      // extra one on screen, and arming the command on something that does not
      // exist yet would fail at commit for a reason nothing on screen explains.
      if (body && body !== arrangePartName && arrangeBodies.includes(body)) {
        arrangePartName = body;
        aiBodyEl.value = body;
        applyArrangeTint();
        renderArrangePreview();
        scheduleArrangePreview();
      }
      return;
    }
    // With the gizmo up, a click on another body retargets it — the same
    // gesture Fusion uses to change which body a Move applies to. A click on
    // nothing is left alone: losing the command to a stray background click
    // would be the most irritating way to lose an un-applied move.
    if (moveMode) {
      const body = pickBodyAt(event.clientX, event.clientY);
      if (body && body !== movePartName) {
        miBodyEl.value = body;
        miBodyEl.dispatchEvent(new Event("change"));
      }
      return;
    }
    // Clicking empty space clears — the standard CAD gesture, and the only
    // way to deselect without reaching for the keyboard.
    facePicker.setSelection(pickAt(event.clientX, event.clientY));
    updateFaceInfoPanel();
    return;
  }

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  const meshes: THREE.Mesh[] = [];
  modelGroup.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });

  const intersects = raycaster.intersectObjects(meshes);
  if (intersects.length > 0) {
    addMeasurePoint(intersects[0].point);
  }
});

// Numpad-inspired preset map for keyboard view shortcuts. 1 = iso is the
// most common starting view; the rest trace a (front/right/top, then
// back/left/bottom) layout that reads naturally left-to-right.
const KEY_TO_PRESET: Record<string, [number, number, number]> = {
  "1": [1, -1, 0.7],   // iso
  "2": [0, -1, 0],     // front
  "3": [1, 0, 0],      // right
  "4": [0, 0, 1],      // top
  "5": [0, 1, 0],      // back
  "6": [-1, 0, 0],     // left
  "7": [0, 0, -1],     // bottom
};

// Keyboard view shortcuts — only fire when the user isn't typing into a
// parameter slider's number input. Guarding on `document.activeElement` is
// enough because all our text inputs live in the params panel; the canvas
// itself isn't focusable.
window.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const active = document.activeElement;
  const typing =
    !!active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      (active as HTMLElement).isContentEditable);
  // Escape is the exception to "keys belong to the field you are typing in".
  // It means "not this", and the thing it is refusing is the COMMAND, not the
  // character. Returning early here left Escape dead in exactly the situation
  // where it is reached for most — a bar open with the cursor in one of its
  // fields — and every command below had to wire its own copy to compensate.
  if (typing && event.key !== "Escape") return;
  // Escape clears the selection. Checked before the lowercase fold because
  // "Escape".toLowerCase() is "escape", which would collide with nothing today
  // but is a needless thing to depend on.
  //
  // Combine goes first: it is the more modal of the two, and an Escape pressed
  // with it open plainly means "not this", not "clear my face selection".
  if (event.key === "Escape" && arrangeMode) {
    setArrangeMode(null);
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && moveMode) {
    setMoveMode(null);
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && combineOp) {
    setCombineOp(null);
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && facePicker.getSelection()) {
    facePicker.setSelection(null);
    updateFaceInfoPanel();
    event.preventDefault();
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "f") {
    if (modelGroup.children.length > 0) {
      fitCameraToObject(camera, controls, modelGroup, dimensionsVisible ? dimensionGroup : undefined);
    }
    event.preventDefault();
    return;
  }
  const preset = KEY_TO_PRESET[key];
  if (preset) {
    setCameraAngle(preset);
    event.preventDefault();
  }
});

// Fusion-style double-click to re-pivot: picking a feature makes it the new
// orbit center. Without this, the pivot stays at the model-bbox center from
// the last fit, so users can't inspect detail on one side of a large
// assembly without the camera swinging wildly around the far side.
renderer.domElement.addEventListener("dblclick", (event) => {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);

  const meshes: THREE.Mesh[] = [];
  modelGroup.traverse((child) => {
    if (child instanceof THREE.Mesh && child.visible) meshes.push(child);
  });

  const intersects = raycaster.intersectObjects(meshes);
  if (intersects.length > 0) {
    controls.target.copy(intersects[0].point);
    controls.update();
  }
});

// --- AI Render Mode ---
// High-contrast light background with vivid colors for AI screenshot analysis
const AI_COLORS = [
  0x4499dd, // bright blue (default — lighter for visibility)
  0xff6633, // orange
  0x44bb66, // green
  0xbb55dd, // purple
  0xffaa22, // golden
  0x22ccdd, // cyan
  0xff5588, // pink
  0x88cc44, // lime
];

let currentRenderMode: "dark" | "ai" = "dark";

function setRenderMode(mode: string) {
  currentRenderMode = mode as "dark" | "ai";

  if (mode === "ai") {
    scene.background = new THREE.Color(0xf0f0f0);

    // Boost lighting for AI mode — much brighter, more diffuse
    scene.traverse((child) => {
      if (child instanceof THREE.AmbientLight) {
        child.intensity = 0.8;
        child.color.setHex(0xffffff);
      }
      if (child instanceof THREE.DirectionalLight) {
        child.intensity = 1.0;
      }
      if (child instanceof THREE.HemisphereLight) {
        child.intensity = 0.6;
      }
    });

    // Re-color parts: use custom colors if set (brightened), or AI palette.
    // Any user-specified color is authoritative — do not second-guess even
    // if it matches a common default value. If the user wants vivid AI
    // palette colors, they should omit `color` from their parts.
    let i = 0;
    modelGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshPhongMaterial;
        const partInfo = currentParts[i];
        if (partInfo?.color) {
          // User set a custom color — brighten significantly for white bg
          const c = new THREE.Color(partInfo.color);
          c.offsetHSL(0, 0.15, 0.25);
          mat.color.copy(c);
        } else {
          mat.color.setHex(AI_COLORS[i % AI_COLORS.length]);
        }
        mat.specular.setHex(0x222222);
        mat.shininess = 30;
        i++;
      }
      if (child instanceof THREE.LineSegments) {
        (child.material as THREE.LineBasicMaterial).color.setHex(0x333333);
      }
    });
  } else {
    scene.background = new THREE.Color(0x1e1e1e);

    // Restore dark mode lighting
    scene.traverse((child) => {
      if (child instanceof THREE.AmbientLight) {
        child.intensity = 0.5;
        child.color.setHex(0x404050);
      }
      if (child instanceof THREE.DirectionalLight) {
        child.intensity = (child as any)._originalIntensity || 0.8;
      }
      if (child instanceof THREE.HemisphereLight) {
        child.intensity = 0.4;
      }
    });

    let i = 0;
    modelGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshPhongMaterial;
        const partColor = currentParts[i]?.color;
        mat.color.set(partColor || PART_COLORS[i % PART_COLORS.length]);
        mat.specular.setHex(0xffffff);
        mat.shininess = 60;
        i++;
      }
      if (child instanceof THREE.LineSegments) {
        (child.material as THREE.LineBasicMaterial).color.setHex(0x1a1a1a);
      }
    });
  }
}

// --- Dimension Overlay ---
const dimensionGroup = new THREE.Group();
dimensionGroup.visible = false;
scene.add(dimensionGroup);

let dimensionsVisible = false;

function toggleDimensions(show?: boolean) {
  dimensionsVisible = show !== undefined ? show : !dimensionsVisible;
  updateDimensions();
}

function setAxes(show?: boolean, scaleToModel?: boolean) {
  axesVisible = show !== undefined ? show : !axesVisible;
  let target: number | undefined;
  if (axesVisible && scaleToModel && modelGroup.children.length > 0) {
    const box = new THREE.Box3().setFromObject(modelGroup);
    const size = box.getSize(new THREE.Vector3());
    const largest = Math.max(size.x, size.y, size.z);
    // Axes slightly longer than the model half-extent reads well in screenshots.
    if (largest > 0) target = largest * 0.6;
  }
  setAxesVisible(scene, axesVisible, target);
}

// Compute a bbox that ignores hidden parts. `setFromObject` walks the scene
// graph regardless of `.visible`, so on a focusPart preview it would return
// the full-assembly extents even though we've hidden two out of three parts —
// and the resulting dim labels would lie about what the pink outline wraps.
// This helper only includes leaves whose own visibility flag is true.
function getBboxOfVisibleParts(group: THREE.Group): THREE.Box3 {
  const box = new THREE.Box3();
  let hasVisible = false;
  group.traverse((obj) => {
    if (obj.visible && (obj as any).isMesh) {
      // Also require every ancestor up to `group` to be visible, since
      // `traverse` visits descendants of hidden ancestors too.
      let node: THREE.Object3D | null = obj;
      let ancestorsVisible = true;
      while (node && node !== group) {
        if (!node.visible) { ancestorsVisible = false; break; }
        node = node.parent;
      }
      if (ancestorsVisible) {
        box.expandByObject(obj);
        hasVisible = true;
      }
    }
  });
  if (!hasVisible) return new THREE.Box3().setFromObject(group);
  return box;
}

function updateDimensions() {
  // Clear old
  dimensionGroup.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      (child as any).geometry?.dispose();
      (child as any).material?.dispose();
    }
  });
  dimensionGroup.clear();
  dimensionGroup.visible = dimensionsVisible;

  if (!dimensionsVisible || modelGroup.children.length === 0) return;

  const box = getBboxOfVisibleParts(modelGroup);
  const size = box.getSize(new THREE.Vector3());
  const min = box.min;
  const max = box.max;

  const dimColor = currentRenderMode === "ai" ? 0xe91e63 : 0xff6644;
  const textColor = currentRenderMode === "ai" ? "#e91e63" : "#ff6644";

  // Draw bounding box wireframe
  const boxHelper = new THREE.Box3Helper(box, new THREE.Color(dimColor));
  (boxHelper.material as THREE.Material).transparent = true;
  (boxHelper.material as THREE.Material).opacity = 0.5;
  dimensionGroup.add(boxHelper);

  // Dimension-line offsets. Formerly a bare `0.2 * maxDim` — on tiny parts
  // (e.g. a 4mm peg) that collapsed to ~0.8mm, which stuffed each dim label
  // on top of the 5mm origin-axis arrowheads and made the overlay look like
  // one blob. Clamp with a 15mm floor so labels always stand clear of the
  // origin indicator regardless of part scale; the proportional term still
  // keeps labels tight on 100mm+ parts.
  const maxDim = Math.max(size.x, size.y, size.z);
  const minDim = Math.max(Math.min(size.x, size.y, size.z), 0.001); // avoid div-by-zero
  const axisRatio = maxDim / minDim;

  // For highly asymmetric parts (e.g. an M6 bolt: X≈10, Y≈10, Z≈80) a single
  // uniform `0.18 * maxDim` offset (~14.4mm) is larger than the narrow
  // footprint itself, so X and Y dim labels end up stacked on each other and
  // become unreadable. Switch to per-axis offsets when asymmetry is sharp,
  // keeping the uniform-offset look for cubes / iso-proportioned parts where
  // it already reads well. Threshold of 3 is conservative — a 2:1 part still
  // gets the consistent uniform treatment.
  let offsetX: number, offsetY: number, offsetZ: number;
  if (axisRatio > 3) {
    offsetX = Math.max(0.18 * size.x, 5);
    offsetY = Math.max(0.18 * size.y, 5);
    offsetZ = Math.max(0.18 * size.z, 5);
  } else {
    const uniform = Math.max(0.18 * maxDim, 20);
    offsetX = offsetY = offsetZ = uniform;
  }

  // Each dim line is anchored to the midpoint of the matching bbox edge
  // (rather than a translated model-origin ray) and then shoved
  // perpendicularly outward by the appropriate per-axis offset. This keeps
  // the label glued to the feature it measures even for shapes whose min
  // corner sits far from the origin — e.g. a part built at (100, 100, 0)
  // used to render its X label down at the world X axis because
  // `min.y - offset` happened to straddle the axes indicator; anchoring at
  // the edge midpoint + outward offset makes placement translation-invariant.
  const midX = (min.x + max.x) / 2;
  const midY = (min.y + max.y) / 2;
  const midZ = (min.z + max.z) / 2;

  // X dim sits along the -Y side of the bbox, so its outward offset is in Y.
  addDimensionLine(
    [min.x, min.y - offsetY, min.z],
    [max.x, min.y - offsetY, min.z],
    `X: ${formatMm(size.x, 1)}`,
    dimColor, textColor,
    [midX, min.y - offsetY, min.z]
  );

  // Y dim sits along the +X side of the bbox, so its outward offset is in X.
  addDimensionLine(
    [max.x + offsetX, min.y, min.z],
    [max.x + offsetX, max.y, min.z],
    `Y: ${formatMm(size.y, 1)}`,
    dimColor, textColor,
    [max.x + offsetX, midY, min.z]
  );

  // Z dim sits at the +X / +Y corner so its sprite doesn't share a column
  // with the Y label (which also sits at max.x + offsetX). Pulling it to the
  // far corner puts its anchor on a different face of the bbox — readable
  // from the default iso camera angle.
  addDimensionLine(
    [max.x + offsetX, max.y + offsetY, min.z],
    [max.x + offsetX, max.y + offsetY, max.z],
    `Z: ${formatMm(size.z, 1)}`,
    dimColor, textColor,
    [max.x + offsetX, max.y + offsetY, midZ]
  );
}

function addDimensionLine(
  from: [number, number, number],
  to: [number, number, number],
  label: string,
  lineColor: number,
  textColor: string,
  labelAnchor?: [number, number, number]
) {
  // Line
  const geom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...from),
    new THREE.Vector3(...to),
  ]);
  const mat = new THREE.LineBasicMaterial({ color: lineColor, linewidth: 2 });
  dimensionGroup.add(new THREE.Line(geom, mat));

  // End caps (small perpendicular lines)
  const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]).normalize();
  const capLen = dir.length() * 2 || 2;
  // (skip caps for simplicity — the label is the important part)

  // Text label as a sprite. Callers may supply an explicit anchor (the
  // dimension-layout code anchors at bbox-edge midpoints so labels stay
  // glued to their measurement); fall back to the line midpoint otherwise.
  let midX = labelAnchor ? labelAnchor[0] : (from[0] + to[0]) / 2;
  let midY = labelAnchor ? labelAnchor[1] : (from[1] + to[1]) / 2;
  let midZ = labelAnchor ? labelAnchor[2] : (from[2] + to[2]) / 2;

  // Near-origin nudge: on a part anchored at the world origin, a dim label
  // whose anchor lands within a small neighborhood of (0,0,0) visually
  // collides with the axes indicator. When that happens, shove the label
  // along the unit vector from origin to the label position by another
  // ~5% of maxDim so there's a clean gap. 0.05 * maxDim is conservative —
  // enough to clear the axis cone (which is ~0.6 * maxDim long but
  // tapered) without dislodging labels on large parts where the anchor
  // is already far from origin.
  if (modelGroup.children.length > 0) {
    const box = getBboxOfVisibleParts(modelGroup);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const dist = Math.hypot(midX, midY, midZ);
    const threshold = 0.05 * maxDim;
    if (dist > 0 && dist < threshold) {
      const scale = threshold / dist;
      midX *= scale;
      midY *= scale;
      midZ *= scale;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = currentRenderMode === "ai" ? "rgba(255,255,255,0.9)" : "rgba(30,30,30,0.85)";
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = textColor;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, 254, 62);
  ctx.font = "bold 28px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = textColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 128, 32);

  const texture = new THREE.CanvasTexture(canvas);
  const spriteMat = new THREE.SpriteMaterial({ map: texture, sizeAttenuation: true });
  const sprite = new THREE.Sprite(spriteMat);
  sprite.position.set(midX, midY, midZ);
  // Scale the label proportionally to its dimension line, but clamp on both
  // ends. The floor (8) keeps labels legible for tiny models (1-2mm); the
  // ceiling keeps them from growing large enough to overlap other labels or
  // obscure the model itself on mid-sized parts. Using the largest model
  // dimension as the ceiling anchor means a 20mm bbox caps labels at ~8mm
  // long, preserving a visible gap between the X/Y/Z columns.
  const lineLength = new THREE.Vector3(...from).distanceTo(new THREE.Vector3(...to));
  const modelSize = (() => {
    if (modelGroup.children.length === 0) return lineLength;
    const box = new THREE.Box3().setFromObject(modelGroup);
    const s = box.getSize(new THREE.Vector3());
    return Math.max(s.x, s.y, s.z, 1);
  })();
  const maxScale = modelSize * 0.4;
  let scale = Math.min(maxScale, Math.max(lineLength * 0.3, 8));
  // Z-label parity: the Z dim label is anchored at the far corner of the
  // bbox (max X + offset, max Y + offset, midZ). From the default iso
  // camera that corner sits noticeably further away than the X/Y label
  // anchors, so with sizeAttenuation:true on the sprite material the Z
  // sprite rendered ~50% the size of X/Y in screenshots. Bumping by 1.5x
  // for Z restores visual parity without breaking the proportional-scale
  // logic above.
  if (label.startsWith("Z:")) {
    scale *= 1.5;
  }
  sprite.scale.set(scale, scale * 0.25, 1);
  dimensionGroup.add(sprite);
}

// --- Render loop ---
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  // Drive kinematic motion-sim playback (no-op unless a `sim` block is active).
  updateSim();
  // Fat lines convert their pixel width to clip space in the shader, so they
  // have to be told the drawing-buffer size. Synced here rather than on a
  // resize event because the renderer is resized from several places — the
  // window handler, and the screenshot path that swaps in a fixed resolution
  // and back — and one sync per frame is correct for all of them.
  renderer.getSize(renderSize);
  syncEdgeHighlightWidths(overlayGroup, renderSize.x, renderSize.y);
  // The arrow is sized in screen space, so it has to be rescaled whenever the
  // camera moves — which is any frame at all.
  if (dragHandle.visible) {
    camera.getWorldDirection(cameraForward);
    dragHandle.update(parseDistance() ?? 0, worldPerPixel(), cameraForward);
  }
  // autoClear was flipped to false so the gnomon can composite on top. We
  // now have to clear the color + depth manually before the main render.
  renderer.clear();
  renderer.render(scene, camera);
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderGnomon(w, h);
  // Live view only. The screenshot paths render the gnomon deliberately — it
  // is how an agent reads orientation out of a still — but a navigation
  // control in a captured frame is just something covering the model.
  viewCube.syncTo(camera, controls.target);
  viewCube.render(renderer, w, VIEW_CUBE_SIZE, VIEW_CUBE_MARGIN_RIGHT, VIEW_CUBE_MARGIN_BOTTOM);
}

// --- Handle resize ---
const resizeObserver = new ResizeObserver(() => {
  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});
resizeObserver.observe(container);

// --- Start ---
initWorker();
animate();
