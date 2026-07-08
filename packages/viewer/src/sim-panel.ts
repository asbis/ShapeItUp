/**
 * Motion-simulation UI + playback for the viewer (Phases 1, 3b, and the Batch-5
 * UI integration).
 *
 * The timeline is now a first-class part of the extension's UI: a "Sim" toolbar
 * button (enabled only when the current render declares `export const sim`)
 * toggles a themed bottom-docked panel — play/pause, a scrubber, a speed
 * selector, and a collision + assertion log — instead of a floating overlay.
 * The panel markup + styling live in the webview template (viewer-provider.ts);
 * this module wires those elements to the engines.
 *
 * A PlaybackSource abstracts both engines: KINEMATIC (analytic KinematicSim) and
 * DYNAMICS (Rapier runs headless here, then we play back its recorded frames).
 */

import * as THREE from "three";
import {
  KinematicSim,
  validateSimSpecInput,
  resolveSimSpec,
  evaluateAssertions,
  sampleFrames,
  type Aabb,
  type AssertionResult,
  type CollisionEvent,
  type SimResult,
  type Transform,
} from "@shapeitup/sim";
import { runDynamics, type MeshData } from "@shapeitup/sim-dynamics";
import { runMujoco } from "@shapeitup/sim-mujoco";

interface SimPart {
  name: string;
  group: THREE.Group;
}

interface PlaybackSource {
  engine: "kinematic" | "dynamics";
  duration: number;
  collisions: CollisionEvent[];
  assertions: AssertionResult[];
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

// Template elements (owned by viewer-provider.ts). Grabbed once in initSimPanel.
let panel: HTMLElement | null = null;
let btn: HTMLButtonElement | null = null;
let playBtn: HTMLElement | null = null;
let scrub: HTMLInputElement | null = null;
let speedSel: HTMLSelectElement | null = null;
let timeLabel: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let log: HTMLElement | null = null;

const RED = new THREE.Color("#ff3b30");

/** Wire the template's sim panel + transport controls. Call once at startup. */
export function initSimPanel() {
  panel = document.getElementById("sim-panel");
  btn = document.getElementById("btn-sim") as HTMLButtonElement | null;
  playBtn = document.getElementById("sim-play");
  scrub = document.getElementById("sim-scrub") as HTMLInputElement | null;
  speedSel = document.getElementById("sim-speed") as HTMLSelectElement | null;
  timeLabel = document.getElementById("sim-time");
  titleEl = document.getElementById("sim-title");
  log = document.getElementById("sim-log");

  playBtn?.addEventListener("click", () => setPlaying(!playing));
  scrub?.addEventListener("input", () => {
    const duration = source?.duration ?? 0;
    time = (Number(scrub!.value) / 1000) * duration;
    applyPose(time);
    updateScrubber();
    setPlaying(false);
  });
  speedSel?.addEventListener("change", () => {
    speed = Number(speedSel!.value);
  });
}

/** Toolbar-button handler: show/hide the panel (no-op until a sim is loaded). */
export function toggleSimPanel() {
  if (!btn || btn.disabled || !panel) return;
  const open = panel.classList.toggle("open");
  btn.classList.toggle("active", open);
}

function setEnabled(on: boolean) {
  if (btn) btn.disabled = !on;
  if (!on) {
    btn?.classList.remove("active");
    panel?.classList.remove("open");
  }
}

function aabbOf(group: THREE.Group): Aabb {
  const box = new THREE.Box3().setFromObject(group);
  return { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
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
  setEnabled(false);
}

/**
 * Called on mesh-done with the raw `sim` block and the freshly-rendered parts.
 * Async because the dynamics engine awaits Rapier's WASM init. Enables the Sim
 * toolbar button and opens the panel when a valid sim is present.
 */
export async function setupSim(raw: unknown, currentParts: SimPart[]) {
  clearSim();
  if (raw === undefined || raw === null) return;
  const valid = validateSimSpecInput(raw);
  if (!valid.ok) {
    console.warn("[ShapeItUp sim] invalid sim block:\n" + valid.errors.map((e) => "  • " + e).join("\n"));
    return;
  }
  const myGen = generation;

  parts = currentParts.map((p) => ({ name: p.name, group: p.group }));
  const partAabbs = parts.map((p) => ({ name: p.name, aabb: aabbOf(p.group) }));
  const { spec, warnings } = resolveSimSpec(valid.value, partAabbs);
  for (const w of warnings) console.warn(`[ShapeItUp sim] ${w}`);

  // Engine selection. `engine` (if set) wins; otherwise force-based when the block
  // opts into dynamics. MuJoCo runs its WASM in the webview like Rapier does — but
  // if that load fails (e.g. the optional glue wasn't shipped) it degrades to
  // Rapier/kinematic so the viewer never breaks. All three emit a SimResult.
  const engine = valid.value.engine;
  const wantsMujoco = engine === "mujoco";
  const hasDynamics = valid.value.mode === "dynamic" || spec.bodies.some((b) => b.kind === "dynamic");
  const wantsForceBased = wantsMujoco || engine === "rapier" || hasDynamics;

  try {
    let result: SimResult | null = null;
    if (wantsForceBased) {
      const meshes = new Map<string, MeshData>();
      for (const p of parts) {
        const m = meshOf(p.group);
        if (m && m.vertices.length >= 9) meshes.set(p.name, m);
      }
      if (wantsMujoco) {
        try {
          if (titleEl) titleEl.textContent = "Simulating (MuJoCo)…";
          result = await runMujoco(spec, meshes);
        } catch (err) {
          console.warn("[ShapeItUp sim] MuJoCo engine unavailable in the viewer — falling back:", err);
        }
      }
      if (!result && (engine === "rapier" || hasDynamics)) {
        if (titleEl) titleEl.textContent = "Simulating physics…";
        result = await runDynamics(spec, meshes);
      }
    }
    if (generation !== myGen) return; // superseded by a newer render

    if (result) {
      const cols = result.collisions;
      source = {
        engine: "dynamics",
        duration: result.duration,
        collisions: cols,
        assertions: evaluateAssertions(spec, result),
        poseAt: (t) => sampleFrames(result, t),
        contactsAt: (t) => cols.filter((c) => c.tStart <= t).map((c) => [c.a, c.b] as [string, string]),
      };
    } else {
      // Kinematic engine — the default, and the fallback for an all-scripted scene
      // tagged `engine:"mujoco"` when the MuJoCo WASM couldn't load.
      const ksim = new KinematicSim(spec);
      const kres = ksim.run();
      source = {
        engine: "kinematic",
        duration: spec.duration,
        collisions: kres.collisions,
        assertions: evaluateAssertions(spec, kres),
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
  if (titleEl) titleEl.textContent = source.engine === "dynamics" ? "Physics simulation" : "Motion simulation";
  setEnabled(true);
  panel?.classList.add("open");
  btn?.classList.add("active");
  renderLog();
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

function setPlaying(next: boolean) {
  playing = next;
  lastWall = performance.now();
  if (playBtn) playBtn.innerHTML = playing ? "&#9208; Pause" : "&#9654; Play";
}

function updateScrubber() {
  const duration = source?.duration ?? 0;
  if (scrub) scrub.value = String(duration > 0 ? (time / duration) * 1000 : 0);
  if (timeLabel) timeLabel.textContent = `${(time * 1000).toFixed(0)} / ${(duration * 1000).toFixed(0)} ms`;
}

function renderLog() {
  if (!log || !source) return;
  log.innerHTML = "";
  const noun = source.engine === "dynamics" ? "contact" : "collision";

  const head = (text: string, cls = "sim-head") => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    log!.appendChild(d);
  };

  if (source.collisions.length === 0) {
    head(`✓ no ${noun}s`, "sim-pass");
  } else {
    head(`${source.collisions.length} ${noun}${source.collisions.length > 1 ? "s" : ""}:`);
    for (const c of source.collisions) {
      const row = document.createElement("div");
      row.className = "sim-row sim-seek sim-collision-row";
      row.dataset.t = String(c.tStart);
      row.textContent = `${(c.tStart * 1000).toFixed(0)} ms  ${c.a} ↔ ${c.b}`;
      row.addEventListener("click", () => {
        time = c.tStart;
        applyPose(time);
        updateScrubber();
        setPlaying(false);
      });
      log.appendChild(row);
    }
  }

  if (source.assertions.length > 0) {
    const passed = source.assertions.filter((a) => a.pass).length;
    head(`Assertions: ${passed}/${source.assertions.length}`);
    for (const a of source.assertions) {
      const row = document.createElement("div");
      row.className = `sim-row ${a.pass ? "sim-pass" : "sim-fail"}`;
      row.textContent = `${a.pass ? "✓" : "✗"} ${a.name}: ${a.detail}`;
      log.appendChild(row);
    }
  }
}

/** Colour collision rows whose event time has been reached. */
function markActiveCollisions(t: number) {
  if (!log) return;
  log.querySelectorAll<HTMLElement>(".sim-collision-row").forEach((row) => {
    const tStart = Number(row.dataset.t);
    row.style.color = t >= tStart ? "#ff6b6b" : "";
  });
}
