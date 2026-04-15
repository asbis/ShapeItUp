import * as THREE from "three";
import { createScene } from "./scene";
import { createCamera, createControls, fitCameraToObject } from "./camera";
import { buildMesh, buildEdges } from "./mesh-builder";
import { initMessageHandler, onMessage, postToExtension } from "./message-handler";
import type { WorkerToWebview, TessellatedPart } from "@shapeitup/shared";
import { PART_COLORS } from "./theme";

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

const modelGroup = new THREE.Group();
scene.add(modelGroup);

// State
let edgesVisible = true;
let wireframe = false;
let partsPanelOpen = false;

// Track part info for the browser panel
interface PartInfo {
  name: string;
  color: string;
  visible: boolean;
  group: THREE.Group;
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
}

function renderParts(parts: TessellatedPart[]) {
  clearModelGroup();

  let totalVerts = 0;
  let totalTris = 0;

  parts.forEach((part, i) => {
    const partGroup = new THREE.Group();
    partGroup.name = part.name;

    const colorValue = part.color || PART_COLORS[i % PART_COLORS.length];
    const colorHex =
      typeof colorValue === "string" ? colorValue : `#${colorValue.toString(16).padStart(6, "0")}`;

    const mesh = buildMesh(part.vertices, part.normals, part.triangles, colorValue);
    partGroup.add(mesh);

    if (part.edgeVertices.length > 0) {
      const edges = buildEdges(part.edgeVertices);
      edges.visible = edgesVisible;
      partGroup.add(edges);
    }

    modelGroup.add(partGroup);

    currentParts.push({
      name: part.name,
      color: colorHex,
      visible: true,
      group: partGroup,
    });

    totalVerts += part.vertices.length / 3;
    totalTris += part.triangles.length / 3;
  });

  fitCameraToObject(camera, controls, modelGroup);
  updatePartsList();
  if (dimensionsVisible) updateDimensions();

  // Auto-open parts panel if there are multiple parts
  if (parts.length > 1 && !partsPanelOpen) {
    togglePartsPanel();
  }

  const partLabel = parts.length > 1 ? ` | ${parts.length} parts` : "";
  statusEl.textContent = `${totalVerts} verts, ${totalTris} tris${partLabel}`;
}

// --- Parts browser panel ---
function updatePartsList() {
  partsList.innerHTML = "";
  partsCount.textContent = currentParts.length > 1 ? `(${currentParts.length})` : "";

  currentParts.forEach((part, i) => {
    const item = document.createElement("div");
    item.className = `part-item${part.visible ? "" : " hidden"}`;

    item.innerHTML = `
      <div class="part-swatch" style="background:${part.color}"></div>
      <span class="part-name">${part.name}</span>
      <span class="part-eye">${part.visible ? "&#9673;" : "&#9675;"}</span>
    `;

    item.addEventListener("click", () => {
      part.visible = !part.visible;
      part.group.visible = part.visible;
      item.className = `part-item${part.visible ? "" : " hidden"}`;
      item.querySelector(".part-eye")!.innerHTML = part.visible ? "&#9673;" : "&#9675;";
    });

    partsList.appendChild(item);
  });
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
  const box = new THREE.Box3().setFromObject(modelGroup);
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

function initWorker() {
  fetch(config.workerUrl)
    .then((res) => res.text())
    .then((code) => {
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      worker.onmessage = (e) => handleWorkerMessage(e.data);
      worker.onerror = (e) => {
        postToExtension({ type: "error", message: `Worker error: ${e.message}` });
      };
      worker.postMessage({
        type: "init",
        wasmLoaderUrl: config.wasmLoaderUrl,
        wasmUrl: config.wasmUrl,
      });
    })
    .catch((err) => {
      postToExtension({ type: "error", message: `Failed to load worker: ${err}` });
    });
}

function handleWorkerMessage(msg: WorkerToWebview) {
  switch (msg.type) {
    case "ready":
      loadingEl.style.display = "none";
      postToExtension({ type: "ready" });
      statusEl.textContent = "Ready";
      break;

    case "mesh-result":
      try {
        renderParts(msg.parts);
        updateParamsUI(msg.params || []);
        if (sectionActive) updateSectionPlane();
        const totalVerts = msg.parts.reduce((s: number, p: TessellatedPart) => s + p.vertices.length / 3, 0);
        const totalTris = msg.parts.reduce((s: number, p: TessellatedPart) => s + p.triangles.length / 3, 0);
        const partLabel = msg.parts.length > 1 ? ` | ${msg.parts.length} parts` : "";
        const statusText = `${totalVerts} verts, ${totalTris} tris${partLabel} — ${msg.execTimeMs}ms + ${msg.tessTimeMs}ms`;
        statusEl.textContent = statusText;
        // Compute bounding box for AI dimension verification
        const bbox = new THREE.Box3().setFromObject(modelGroup);
        const bboxSize = bbox.getSize(new THREE.Vector3());

        postToExtension({
          type: "render-success",
          stats: statusText,
          partCount: msg.parts.length,
          partNames: msg.parts.map((p: TessellatedPart) => p.name),
          boundingBox: {
            x: parseFloat(bboxSize.x.toFixed(1)),
            y: parseFloat(bboxSize.y.toFixed(1)),
            z: parseFloat(bboxSize.z.toFixed(1)),
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
      postToExtension({ type: "export-data", format: msg.format, data: msg.data });
      statusEl.textContent = `Exported ${msg.format.toUpperCase()}`;
      break;

    case "error":
      postToExtension({ type: "error", message: msg.message });
      statusEl.textContent = `Error: ${msg.message}`;
      break;
  }
}

// --- Extension host messages ---
initMessageHandler();

onMessage("execute-script", (msg) => {
  if (worker) {
    statusEl.textContent = "Executing...";
    lastScriptJs = msg.js;
    currentParamValues = {};
    const name = msg.fileName.replace(/.*[\/\\]/, "");
    filenameEl.textContent = name;
    worker.postMessage({ type: "execute", js: msg.js });
  }
});

onMessage("request-export", (msg) => {
  if (worker) {
    statusEl.textContent = `Exporting ${msg.format.toUpperCase()}...`;
    worker.postMessage({ type: "export", format: msg.format });
  }
});

onMessage("request-screenshot", () => {
  // Set camera to isometric angle that shows all 3 dimensions clearly
  if (modelGroup.children.length > 0) {
    setCameraAngle([1, -0.8, 0.7]);
  }
  // Wait one frame for the render to complete
  controls.update();
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  postToExtension({ type: "screenshot-data", dataUrl });
});

onMessage("viewer-command", (msg) => {
  switch (msg.command) {
    case "set-render-mode":
      setRenderMode(msg.mode);
      break;
    case "toggle-dimensions":
      toggleDimensions(msg.show);
      break;
  }
});

// --- Toolbar buttons ---
document.getElementById("btn-parts")!.addEventListener("click", togglePartsPanel);

document.getElementById("btn-fit")!.addEventListener("click", () => {
  if (modelGroup.children.length > 0) fitCameraToObject(camera, controls, modelGroup);
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

document.getElementById("btn-measure")!.addEventListener("click", () => {
  measureMode = !measureMode;
  document.getElementById("btn-measure")!.classList.toggle("active", measureMode);
  renderer.domElement.style.cursor = measureMode ? "crosshair" : "default";
  if (!measureMode) {
    clearMeasurement();
  }
});

document.getElementById("btn-step")!.addEventListener("click", () => {
  postToExtension({ type: "toolbar-export", format: "step" });
});

document.getElementById("btn-stl")!.addEventListener("click", () => {
  postToExtension({ type: "toolbar-export", format: "stl" });
});

// --- ViewCube ---
document.getElementById("vc-top")!.addEventListener("click", () => setCameraAngle([0, 0, 1]));
document.getElementById("vc-front")!.addEventListener("click", () => setCameraAngle([0, -1, 0.3]));
document.getElementById("vc-right")!.addEventListener("click", () => setCameraAngle([1, 0, 0.3]));
document.getElementById("vc-iso")!.addEventListener("click", () => setCameraAngle([1, -1, 0.8]));

// --- Parameter Sliders ---
import type { ParamDef } from "@shapeitup/shared";

const paramsPanel = document.getElementById("params-panel")!;
const paramsList = document.getElementById("params-list")!;
const paramsHeader = document.getElementById("params-header")!;
let currentParamDefs: ParamDef[] = [];
let currentParamValues: Record<string, number> = {};
let lastScriptJs: string = "";
let paramDebounceTimer: ReturnType<typeof setTimeout> | undefined;

function updateParamsUI(params: ParamDef[]) {
  currentParamDefs = params;
  paramsList.innerHTML = "";

  if (params.length === 0) {
    paramsPanel.classList.remove("open");
    return;
  }

  paramsPanel.classList.add("open");

  for (const p of params) {
    currentParamValues[p.name] = p.value;

    const row = document.createElement("div");
    row.className = "param-row";

    const label = document.createElement("div");
    label.className = "param-label";
    label.innerHTML = `<span>${p.name}</span><span class="param-value" id="pv-${p.name}">${p.value}</span>`;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "param-slider";
    slider.min = String(p.min ?? 0);
    slider.max = String(p.max ?? p.value * 3);
    slider.step = String(p.step ?? (Math.abs(p.value) >= 10 ? 1 : 0.1));
    slider.value = String(p.value);

    slider.addEventListener("input", () => {
      const val = parseFloat(slider.value);
      currentParamValues[p.name] = val;
      document.getElementById(`pv-${p.name}`)!.textContent = String(
        Number.isInteger(val) ? val : val.toFixed(1)
      );

      // Debounce re-execution
      if (paramDebounceTimer) clearTimeout(paramDebounceTimer);
      paramDebounceTimer = setTimeout(() => {
        if (worker && lastScriptJs) {
          statusEl.textContent = "Updating...";
          worker.postMessage({
            type: "execute",
            js: lastScriptJs,
            paramOverrides: { ...currentParamValues },
          });
        }
      }, 150);
    });

    row.appendChild(label);
    row.appendChild(slider);
    paramsList.appendChild(row);
  }
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
  sectionValueEl.textContent = `${(dimLabel * pct).toFixed(1)}mm`;
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
      `Distance: ${dist.toFixed(2)}mm  |  \u0394X: ${dx.toFixed(1)}  \u0394Y: ${dy.toFixed(1)}  \u0394Z: ${dz.toFixed(1)}`;
    measureInfoEl.style.display = "block";

    // Reset for next measurement after a delay
    setTimeout(() => {
      measurePoints.length = 0;
    }, 100);
  }
}

renderer.domElement.addEventListener("click", (event) => {
  if (!measureMode) return;

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

    // Re-color parts: use custom colors if set (brightened), or AI palette
    let i = 0;
    modelGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const mat = child.material as THREE.MeshPhongMaterial;
        const partInfo = currentParts[i];
        if (partInfo?.color && partInfo.color !== "#8899aa") {
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

  const box = new THREE.Box3().setFromObject(modelGroup);
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

  // Dimension lines with labels using sprites
  const offset = Math.max(size.x, size.y, size.z) * 0.2;

  // X dimension (along bottom front)
  addDimensionLine(
    [min.x, min.y - offset, min.z],
    [max.x, min.y - offset, min.z],
    `X: ${size.x.toFixed(1)}mm`,
    dimColor, textColor
  );

  // Y dimension (along bottom left — separated from Z)
  addDimensionLine(
    [min.x - offset, min.y, min.z],
    [min.x - offset, max.y, min.z],
    `Y: ${size.y.toFixed(1)}mm`,
    dimColor, textColor
  );

  // Z dimension (along right front — separated from Y)
  addDimensionLine(
    [max.x + offset, min.y, min.z],
    [max.x + offset, min.y, max.z],
    `Z: ${size.z.toFixed(1)}mm`,
    dimColor, textColor
  );
}

function addDimensionLine(
  from: [number, number, number],
  to: [number, number, number],
  label: string,
  lineColor: number,
  textColor: string
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

  // Text label as a sprite
  const midX = (from[0] + to[0]) / 2;
  const midY = (from[1] + to[1]) / 2;
  const midZ = (from[2] + to[2]) / 2;

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
  const scale = Math.max(
    new THREE.Vector3(...from).distanceTo(new THREE.Vector3(...to)) * 0.3,
    8
  );
  sprite.scale.set(scale, scale * 0.25, 1);
  dimensionGroup.add(sprite);
}

// --- Render loop ---
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
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
