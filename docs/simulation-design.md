# ShapeItUp Simulation Layer — Design & Research

**Status:** Draft / proposal · **Date:** 2026-07-06 · **Owner:** TBD

Goal: let users **simulate a design before they print or build it** — watch a
mechanism move, fire actuators with realistic timing (e.g. a solenoid's ramp-up
delay), test motion patterns, and catch collisions-during-motion — and later
answer "will this part break?" (FEA). The layer must be **general** (knitting
machine today, cars/robots/hardware tomorrow) and drive **both** the visual
viewer and the headless MCP server from one core.

---

## 1. The core finding: two solver worlds, opposite feasibility

Pre-manufacture simulation splits into two families that share almost no code:

| | **Motion / rigid-body** | **FEA (stress / thermal)** |
|---|---|---|
| Answers | "Do parts move right and collide?" | "Will a part bend / break / overheat?" |
| Runs in-browser? | **Yes, today** (mature WASM engines) | **No** — industry runs it cloud/native |
| MVP effort | Days–weeks | Weeks–months + a native helper |
| Our driving use-case | ✅ carriage, needles, solenoid timing | ❌ tells us nothing about the carriage |

**Evidence FEA does not run locally:** Autodesk moved *all* Fusion 360 solves —
even linear-static — to **cloud-only in Sept 2022**, citing that solvers are
"very computationally intensive," OS/hardware-sensitive, block the app, and run
serially. Research surfaced **zero** verified in-browser FEA solvers.

**Decision: motion-first.** Build the browser-native motion layer now; design the
sim-core so FEA slots in later as an out-of-process (native/cloud) module.

---

## 2. Motion simulation — the toolbox

Three production-grade, permissively-licensed WASM physics engines drop into a
TS/Three.js stack:

| Engine | License | Notes |
|---|---|---|
| **Rapier.js** | MIT | Rust→WASM, full TS, ~2M weekly npm downloads, most-maintained. Joints: fixed/revolute/prismatic/spherical + generic 6-DOF (Cartesian/planar/cylindrical/pin-slot/universal). |
| **JoltPhysics.js** | MIT | Emscripten port, 7 npm build flavors. Adds **gear, rack-and-pinion, pulley, path** constraints — useful for cam tracks / geared drives. |
| **ammo.js / enable3d** | zlib/MIT | Bullet. Ships a **headless Node physics module** (no browser/electron/jsdom) — proves the same core runs headless for MCP. |

**Recommendation: Rapier** as the dynamics engine (maintenance + TS + npm reach),
Jolt kept in mind if we need its specialized cam/gear constraints.

### Actuators (the "solenoid slowness" question)

Joint motors in Rapier and Jolt are **PD controllers**:
`configureMotorPosition(target, stiffness, damping)` /
`configureMotorVelocity(target, damping)` with a **max-force/impulse cap**.

A solenoid's ramp-up + response delay = a **velocity-target ramp + a force
limit**. Weak coil → low max-force; slow pull-in → gentler ramp; response delay →
a start-time offset. This is exactly the pattern-testing loop we want: tune "this
solenoid seats in 8 ms" and check whether the needle clears the cam in time.

### Feeding CAD geometry into physics — and a shortcut

Colliders are built from vertex+index buffers — *exactly* the
`Float32Array`/`Uint32Array` in our `TessellatedPart`. Caveat: raw triangle
meshes have "no interior," so **dynamic non-convex parts get stuck** and must be
convex-decomposed. Use **CoACD** (SIGGRAPH 2022) — **V-HACD is deprecated** as of
its own README (2025-07).

**Shortcut for our machine:** convex decomposition is only needed for *dynamic*
bodies. In a knitting machine the bed is **static** and the carriage/needles are
**kinematic** (motion is *scripted*, not force-derived). Static + kinematic
bodies use the trimesh collider **directly** — so Phase 1 needs no CoACD at all.

### Reproducibility caveat

Rapier's JS/WASM is **not** cross-platform deterministic (verified — its own
determinism promise doesn't hold across machines/browsers). For shareable pattern
tests, **record the trajectory** (fixed timestep → store per-frame poses + events)
and replay, rather than relying on re-running.

---

## 3. FEA — module #2, a cloud/native helper

Well-trodden pipeline; our geometry bridge already exists (OCCT explicitly
documents handing shapes "to a finite element algorithm"):

```
Replicad/OCCT B-rep → Gmsh (tetrahedral FEA mesh; itself uses OpenCASCADE)
                    → CalculiX / Elmer solver → stress field → color map
```

Note OCCT's `BRepMesh` gives **surface** triangulation (fine for physics/collision,
**invalid** for volumetric FEA) — FEA needs a real tet mesher (Gmsh/Netgen/TetGen),
none confirmed as browser-WASM. So the **solve is a native sidecar or cloud call**.

**AI-driven precedent:** *FeaGPT* (arXiv, Oct 2025) chains FreeCAD + Gmsh +
CalculiX and specifies loads **semantically** — "fix the left edge, load the hole
boundary" — mapped to real faces by a geometry analyzer. This maps directly onto
our existing `describe_geometry` (already enumerates faces + normals + centroids)
and the MCP layer. Existence proof, not yet an industry standard.

---

## 4. Architecture — one headless core, two frontends

Validated pattern (Project Chrono ships as embeddable middleware; enable3d runs
its physics core headless in Node): **a framework-agnostic `@shapeitup/sim` core**
with no Three.js/DOM dependency, consumed by both the viewer and the MCP server.

```
                 ┌─────────────────────────────┐
                 │  @shapeitup/sim (headless)  │
                 │  bodies · joints · actuators │
                 │  stepper · event log · units │
                 └───────┬──────────────┬───────┘
        drives viewer ↙                  ↘ drives MCP
   Three.js: per-frame poses,        run_simulation(): returns
   timeline scrubber, collision      {collisions:[{t,a,b}], maxForce,
   flash, live actuator sliders       sweptVolumes} — headless, for AI
```

### Declaring a simulation in a shape file

Reuse the existing `mate` joints (they already carry position + axis + role):

```typescript
export const sim = {
  bodies: { bed: "static", carriage: "kinematic", "needle-*": "kinematic" },
  actuators: [
    { name: "carriage-drive", joint: "carriage/rail", type: "velocity",
      profile: { v: 40 /* mm/s */ } },
    { name: "sol-3", joint: "needle-3/bed", type: "position",
      profile: { target: 6, rampMs: 8, maxForce: 2.0 } }, // ← solenoid slowness
  ],
  gravity: [0, 0, -9810], // mm/s², bridged to SI internally
};
```

### Units bridge (a genuine footgun)

Replicad is **millimeters**; physics engines expect **SI meters**; Three.js is
**Y-up** while CAD is typically **Z-up**. One wrong scale/axis conversion → gravity
points sideways or parts are 1000× too big. Isolate this in **one tested
`SimFrame` conversion layer**; never sprinkle `*0.001` around.

---

## 5. Existing seams in the codebase (we're close)

| Already have | Gives the sim layer | Ref |
|---|---|---|
| Live `requestAnimationFrame` loop; parts are mutable `THREE.Group`s | A place to step physics and push per-frame poses — no render rearchitecture | `packages/viewer/src/index.ts` (animate loop; `modelGroup`/`partGroup` at ~294–313) |
| `mate()` / `Part.joints` with axes + semantic roles | The constraint graph a physics engine needs — mates → physics joints ~1:1 | `packages/core/src/stdlib/assembly.ts`, `parts.ts` |
| `sweep_check` — rotates a part through steps, reports per-step collisions + swept AABB | A **primitive kinematic sim already** — generalize to a full timeline | `packages/mcp-server/src/tools.ts` (~6272) |
| `check_collisions` — AABB-prefiltered live-OCCT intersection | The collision-event reporter for motion studies | `packages/mcp-server/src/tools.ts` (~5544) |
| MCP tools use live OCCT B-rep in Node (cache-bypass) | A home for the headless sim core + FEA meshing | `packages/mcp-server/src/tools.ts` |
| `TessellatedPart.centerOfMass` / `volume`; `ComposedAssemblyPart.material.density` / `analyze` | Mass properties for dynamics; a density hook already exists | `packages/shared/src/messages.ts:129`, `assembly.ts:701` |

Gaps: no timeline, no constraint/dynamics solver wired in, no per-part material by
default, no units bridge. All bounded.

---

## 6. Phased plan

**Phase 1 — Kinematic motion + collision-during-motion (the knitting win).**
Viewer-side stepping of static/kinematic bodies along scripted actuator profiles;
timeline scrubber + play; red flash + logged event on collision. No dynamics
engine, no CoACD. Lets us watch the carriage sweep the bed, fire solenoids with
realistic ramp, and catch "needle didn't clear the cam in time." Demo target:
`examples/knitting-machine-fase1/`.

**Phase 2 — Headless MCP `run_simulation`.** Same core in Node; returns
`{collisions:[{t, partA, partB, depth}], sweptVolumes, timeline}`. Enables
automated pattern testing by the AI without a human watching.

**Phase 3 — True dynamics** (Rapier): gravity, contact forces, PD-motor
actuators, CoACD for dynamic parts. Unlocks yarn-weight tension, dropped parts,
vehicle constraints ("cars and stuff"). Record-and-replay for reproducibility.

**Phase 4 — FEA sidecar.** MCP tool → Gmsh tet-mesh → CalculiX solve → stress
color map, FeaGPT-style semantic loads off `describe_geometry`. Native/cloud,
opt-in.

---

## 7. Open questions

- CoACD exact license + JS/WASM binding maturity vs V-HACD (only needed at Phase 3).
- Are there production WASM builds of any FEA solver/tet-mesher, or is cloud/native
  mandatory? (Research found none — assume native/cloud for Phase 4.)
- Timeline/keyframe format for reproducible, shareable motion studies given
  Rapier non-determinism.
- Units/axis convention: confirm every engine boundary (Replicad mm/Z-up →
  physics SI/… → Three.js Y-up).

## 8. Sources (verified, deep-research 2026-07-06)

Rapier joints/colliders/determinism docs · JoltPhysics.js (GitHub) · enable3d
headless module · V-HACD README (deprecation) · CoACD (SIGGRAPH 2022) · OCCT mesh
user guide · Gmsh · Autodesk "moving all simulation solves to the cloud" (2022) ·
FeaGPT arXiv:2510.21993 · Project Chrono.
