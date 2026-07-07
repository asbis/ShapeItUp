/**
 * Motion-simulation UI + playback for the viewer (Phases 1 & 3b).
 *
 * A shape file can `export const sim = {...}`. On every render the viewer hands
 * that raw block here; we resolve it against the rendered parts and build a
 * PlaybackSource — a uniform `(t) → poses / contacts` interface that abstracts
 * over BOTH engines:
 *   - KINEMATIC: scripted motion evaluated analytically (KinematicSim.poseAt).
 *   - DYNAMICS:  the Rapier force solver (gravity/contacts) runs headless RIGHT
 *     HERE in the viewer (it already holds every part's mesh), records frames,
 *     and we play them back via sampleFrames (lerp + slerp).
 *
 * Either way the panel drives each part's THREE.Group transform per frame,
 * flashes interfering parts, and exposes play/pause + a scrubber + a
 * collision/contact log. All maths lives in @shapeitup/sim(-dynamics); this file
 * wires THREE.Groups + DOM to those engines.
 */

import * as THREE from "three";
import {
  KinematicSim,
  isSimSpecInput,
  resolveSimSpec,
  sampleFrames,
  type Aabb,
  type CollisionEvent,
  type Transform,
} from "@shapeitup/sim";
import { runDynamics, type MeshData } from "@shapeitup/sim-dynamics";

interface SimPart {
  name: string;
  group: THREE.Group;
}

/** Uniform playback interface both engines satisfy. */
interface PlaybackSource {
  engine: "kinematic" | "dynamics";
  duration: number;
  collisions: CollisionEvent[];
  poseAt(t: number): Map<string, Transform>;
  contactsAt(t: number): Array<[string, string]>;
}

let source: PlaybackSource | null = null;
let parts: SimPart[] = [];
let playing = false;
let time = 0; // sim seconds
let speed = 1;
let lastWall = 0; // performance.now() ms
// Bumped on every clearSim so a slow async dynamics build from a superseded
// render can't apply its result over a newer one.
let generation = 0;

// DOM
let panel: HTMLDivElement | null = null;
let playBtn: HTMLButtonElement | null = null;
let scrubber: HTMLInputElement | null = null;
let timeLabel: HTMLSpanElement | null = null;
let titleEl: HTMLDivElement | null = null;
let collisionList: HTMLDivElement | null = null;

const RED = new THREE.Color("#ff3b30");

function aabbOf(group: THREE.Group): Aabb {
  const box = new THREE.Box3().setFromObject(group);
  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
  };
}

/** Extract a world-space triangle mesh (mm) from a part's THREE geometry. */
function meshOf(group: THREE.Group): MeshData | null {
  let mesh: THREE.Mesh | null = null;
  group.traverse((c) => {
    if (!mesh && c instanceof THREE.Mesh) mesh = c;
  });
  if (!mesh) return null;
  const pos = (mesh as THREE.Mesh).geometry.attributes.position;
  if (!pos) return null;
  const vertices = pos.array instanceof Float32Array ? pos.array : new Float32Array(pos.array);
  const idx = (mesh as THREE.Mesh).geometry.index;
  let indices: Uint32Array;
  if (idx) {
    indices = idx.array instanceof Uint32Array ? idx.array : new Uint32Array(idx.array);
  } else {
    // Non-indexed geometry → sequential triangle list.
    indices = new Uint32Array(vertices.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  return { vertices, indices };
}

function resetPoses() {
  for (const p of parts) {
    p.group.position.set(0, 0, 0);
    p.group.quaternion.set(0, 0, 0, 1);
    tint(p, false);
  }
}

function tint(p: SimPart, on: boolean) {
  p.group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mat = child.material as THREE.MeshStandardMaterial & {
      emissive?: THREE.Color;
      emissiveIntensity?: number;
    };
    if (!mat || !mat.emissive) return;
    if (child.userData.simBaseEmissive === undefined) {
      child.userData.simBaseEmissive = mat.emissive.getHex();
    }
    if (on) {
      mat.emissive.copy(RED);
      mat.emissiveIntensity = 0.9;
    } else {
      mat.emissive.setHex(child.userData.simBaseEmissive as number);
      mat.emissiveIntensity = 1;
    }
  });
}

export function clearSim() {
  resetPoses();
  source = null;
  parts = [];
  playing = false;
  time = 0;
  generation++;
  if (panel) panel.style.display = "none";
}

/**
 * Called on mesh-done with the raw `sim` block and the freshly-rendered parts.
 * Async because the dynamics engine awaits Rapier's WASM init. No-op (and hides
 * the panel) when the script declared no valid sim.
 */
export async function setupSim(raw: unknown, currentParts: SimPart[]) {
  clearSim();
  if (!isSimSpecInput(raw)) return;
  const myGen = generation;

  parts = currentParts.map((p) => ({ name: p.name, group: p.group }));
  const partAabbs = parts.map((p) => ({ name: p.name, aabb: aabbOf(p.group) }));
  const { spec, warnings } = resolveSimSpec(raw, partAabbs);
  for (const w of warnings) console.warn(`[ShapeItUp sim] ${w}`);

  const wantsDynamics = raw.mode === "dynamic" || spec.bodies.some((b) => b.kind === "dynamic");

  try {
    if (wantsDynamics) {
      ensurePanel();
      if (titleEl) titleEl.textContent = "◷ Simulating physics…";
      panel!.style.display = "flex";
      const meshes = new Map<string, MeshData>();
      for (const p of parts) {
        const m = meshOf(p.group);
        if (m && m.vertices.length >= 9) meshes.set(p.name, m);
      }
      const result = await runDynamics(spec, meshes);
      if (generation !== myGen) return; // superseded by a newer render
      const cols = result.collisions;
      source = {
        engine: "dynamics",
        duration: result.duration,
        collisions: cols,
        poseAt: (t) => sampleFrames(result, t),
        contactsAt: (t) =>
          cols.filter((c) => c.tStart <= t).map((c) => [c.a, c.b] as [string, string]),
      };
    } else {
      const ksim = new KinematicSim(spec);
      const result = ksim.run();
      source = {
        engine: "kinematic",
        duration: spec.duration,
        collisions: result.collisions,
        poseAt: (t) => ksim.poseAt(t),
        contactsAt: (t) => ksim.contactsAt(t),
      };
    }
  } catch (err) {
    console.warn("[ShapeItUp sim] simulation failed:", err);
    clearSim();
    return;
  }

  time = 0;
  playing = false;
  lastWall = performance.now();
  ensurePanel();
  if (titleEl) titleEl.textContent = source.engine === "dynamics" ? "◷ Physics simulation" : "◷ Motion simulation";
  panel!.style.display = "flex";
  renderCollisionList();
  applyPose(0);
  updateScrubber();
  setPlaying(false);
}

/** Per-frame hook: advance time when playing and update poses. */
export function updateSim() {
  if (!source) return;
  const now = performance.now();
  if (playing) {
    const dt = ((now - lastWall) / 1000) * speed;
    time += dt;
    if (time >= source.duration) time = 0; // loop
    applyPose(time);
    updateScrubber();
  }
  lastWall = now;
}

function applyPose(t: number) {
  if (!source) return;
  const poses = source.poseAt(t);
  for (const p of parts) {
    const tf = poses.get(p.name);
    if (!tf) continue;
    p.group.position.set(tf.t[0], tf.t[1], tf.t[2]);
    p.group.quaternion.set(tf.q[0], tf.q[1], tf.q[2], tf.q[3]);
  }
  const hot = new Set<string>();
  for (const [a, b] of source.contactsAt(t)) {
    hot.add(a);
    hot.add(b);
  }
  for (const p of parts) tint(p, hot.has(p.name));
  markActiveCollisions(t);
}

// ── UI ──────────────────────────────────────────────────────────────────────

function setPlaying(next: boolean) {
  playing = next;
  lastWall = performance.now();
  if (playBtn) playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
}

function updateScrubber() {
  const duration = source?.duration ?? 0;
  if (scrubber) scrubber.value = String(duration > 0 ? (time / duration) * 1000 : 0);
  if (timeLabel) timeLabel.textContent = `${(time * 1000).toFixed(0)} ms / ${(duration * 1000).toFixed(0)} ms`;
}

function renderCollisionList() {
  if (!collisionList || !source) return;
  const noun = source.engine === "dynamics" ? "contact" : "collision";
  collisionList.innerHTML = "";
  if (source.collisions.length === 0) {
    const ok = document.createElement("div");
    ok.textContent = `✓ no ${noun}s`;
    ok.style.color = "#4caf50";
    collisionList.appendChild(ok);
    return;
  }
  const header = document.createElement("div");
  header.textContent = `${source.collisions.length} ${noun}${source.collisions.length > 1 ? "s" : ""}:`;
  header.style.opacity = "0.7";
  header.style.marginBottom = "2px";
  collisionList.appendChild(header);
  for (const c of source.collisions) {
    const row = document.createElement("div");
    row.className = "sim-collision-row";
    row.dataset.t = String(c.tStart);
    row.textContent = `${(c.tStart * 1000).toFixed(0)} ms  ${c.a} ↔ ${c.b}`;
    row.style.cursor = "pointer";
    row.style.padding = "1px 0";
    row.addEventListener("click", () => {
      time = c.tStart;
      applyPose(time);
      updateScrubber();
      setPlaying(false);
    });
    collisionList.appendChild(row);
  }
}

/** Colour collision rows whose event time has been reached. */
function markActiveCollisions(t: number) {
  if (!collisionList) return;
  collisionList.querySelectorAll<HTMLElement>(".sim-collision-row").forEach((row) => {
    const tStart = Number(row.dataset.t);
    row.style.color = t >= tStart ? "#ff3b30" : "#e0e0e0";
  });
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed",
    left: "50%",
    bottom: "16px",
    transform: "translateX(-50%)",
    display: "none",
    flexDirection: "column",
    gap: "8px",
    padding: "12px 16px",
    background: "rgba(28,28,32,0.94)",
    border: "1px solid #3a3a42",
    borderRadius: "10px",
    color: "#e0e0e0",
    font: "12px system-ui, sans-serif",
    boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
    zIndex: "50",
    minWidth: "460px",
    maxWidth: "70vw",
  } as Partial<CSSStyleDeclaration>);

  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", alignItems: "center", gap: "10px" });

  playBtn = document.createElement("button");
  playBtn.textContent = "▶ Play";
  Object.assign(playBtn.style, {
    background: "#2d6cdf",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "5px 12px",
    cursor: "pointer",
    fontWeight: "600",
    whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  playBtn.addEventListener("click", () => setPlaying(!playing));

  scrubber = document.createElement("input");
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.max = "1000";
  scrubber.value = "0";
  scrubber.style.flex = "1";
  scrubber.addEventListener("input", () => {
    const duration = source?.duration ?? 0;
    time = (Number(scrubber!.value) / 1000) * duration;
    applyPose(time);
    updateScrubber();
    setPlaying(false);
  });

  timeLabel = document.createElement("span");
  timeLabel.style.whiteSpace = "nowrap";
  timeLabel.style.opacity = "0.85";
  timeLabel.style.minWidth = "120px";
  timeLabel.style.textAlign = "right";

  const speedSel = document.createElement("select");
  for (const s of [0.1, 0.25, 0.5, 1]) {
    const opt = document.createElement("option");
    opt.value = String(s);
    opt.textContent = `${s}×`;
    if (s === speed) opt.selected = true;
    speedSel.appendChild(opt);
  }
  Object.assign(speedSel.style, {
    background: "#1c1c20",
    color: "#e0e0e0",
    border: "1px solid #3a3a42",
    borderRadius: "6px",
    padding: "4px",
  } as Partial<CSSStyleDeclaration>);
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value);
  });

  row.append(playBtn, scrubber, speedSel, timeLabel);

  titleEl = document.createElement("div");
  titleEl.textContent = "◷ Motion simulation";
  titleEl.style.fontWeight = "600";
  titleEl.style.opacity = "0.6";
  titleEl.style.letterSpacing = "0.04em";

  collisionList = document.createElement("div");
  Object.assign(collisionList.style, {
    maxHeight: "96px",
    overflowY: "auto",
    borderTop: "1px solid #3a3a42",
    paddingTop: "6px",
    lineHeight: "1.5",
  } as Partial<CSSStyleDeclaration>);

  panel.append(titleEl, row, collisionList);
  document.body.appendChild(panel);
}
