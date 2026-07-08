# MuJoCo Backend — Design & Integration Notes

**Status:** Landed (Phase 0/1) · **Date:** 2026-07-08 · **Package:** `@shapeitup/sim-mujoco`

Companion to [`simulation-design.md`](./simulation-design.md). That doc chose Rapier
as the first dynamics engine. This one adds **MuJoCo** as a second, opt-in
force-based backend — better suited to the articulated, contact-rich mechanism
work ShapeItUp is aimed at (knitting carriage/needles, linkages, selection).

Both engines satisfy the **same contract** — `run(spec, meshes) → SimResult` — so
the viewer and the MCP `run_simulation` tool consume either identically. Choosing
one is a per-run decision (`engine` in the `sim` block).

---

## 1. Why MuJoCo alongside Rapier

Rapier is a solid game-physics rigid-body solver. MuJoCo is the robotics/RL
standard, and our roadmap is squarely its home turf.

| | **Rapier (existing)** | **MuJoCo (new)** |
|---|---|---|
| Actuators | revolute/prismatic PD motor | motors, **position/velocity servos, tendons, muscles, gears** |
| Closed loops (four-bar) | solved analytically in `linkages.ts` | native `<equality connect/weld>` — solved dynamically |
| Contact data | onset only (`overlapVolume:0`) | **peak force (N) + penetration depth (mm)** per pair, from `data.contact` (§4b) |
| Authoring format | imperative JS | **MJCF XML** — declarative, documented, the robotics lingua franca |
| Determinism | non-deterministic → record frames | deterministic per-platform (record-frames still applies) |
| Frame | Y-up internally, mm↔m bridge | **Z-up like CAD** — no axis remap |

Feasibility was the first risk and it cleared immediately: DeepMind's official
**`@mujoco/mujoco`** (v3.10.0, zero deps, Apache-2.0) ships TS bindings + WASM and
**loads and steps in Node**, matching how the worker already hosts OCCT WASM.

---

## 2. The translation problem — SimSpec → MJCF

`SimSpec` is a **flat** body list + a `parent` map + joints. MJCF wants a **nested
kinematic tree** of `<body>` elements. `packages/sim-mujoco/src/mjcf.ts` bridges
them:

| ShapeItUp | MJCF |
|---|---|
| body `static` | `<body>` with no joint (welded to parent/world) |
| body `dynamic` | `<body>` + `<freejoint/>` (or its explicit `SimJoint`s) |
| body `kinematic` | mocap **target** + weld-driven **dynamic** body — see §4 |
| tessellated part | `<asset><mesh vertex=…>` (inline, deduped) → `<geom type="mesh">` — MuJoCo convex-hulls it (§4a) |
| body without mesh | `<geom type="box">` (AABB fallback) centred on the body origin |
| `SimJoint` revolute/prismatic | `<joint type="hinge"\|"slide" pos axis>` |
| `SimActuator` (dynamic joints) | `<position>`/`<velocity>` actuator, `ctrl` driven per-step from the profile |
| `acceptedPairs` | `<contact><exclude>` — physically, not just in the report (see §4) |
| gravity (mm/s²) | `<option gravity>` (m/s²) |

**Units & frame.** All positions/sizes scale mm→m (`MM_TO_M = 0.001`); the engine
scales m→mm on read-back. MuJoCo is Z-up, so no axis remap (unlike Rapier).

**Frame convention (the subtle one).** `SimFrame` poses are **deltas from rest**
applied to rest-**world** coordinates (frame 0 must be identity). Geoms are centred
on the body origin and the body is placed at its rest AABB centre, so MuJoCo's
`xpos` tracks the centre; the engine outputs `t_out = xpos − q·centre` — the same
per-body offset trick the Rapier engine uses. **MuJoCo quaternions are `[w,x,y,z]`**;
`SimFrame` is `[x,y,z, qx,qy,qz,qw]` → reordered on the boundary.

---

## 3. Numerical stability — the stiff-servo recipe

A stiff position servo on a near-massless CAD part explodes the explicit solver;
`mj_step`'s NaN-guard then silently resets state to zero, so the actuator *looks*
inert. The fix that works and generalizes (verified across a 4 mm bar and a larger
body):

- `<option integrator="implicitfast">` — implicit-in-velocity, stable with stiff
  actuators/damping at ~explicit cost.
- **`armature`** (rotor inertia, default `1e-5`) on **actuated** joints — an inertia
  floor for the DOF. Instability comes from *too little* inertia, so a floor is
  exactly right; it's negligible for realistically massive parts. Un-actuated joints
  stay armature-free so free swings remain physical.
- position actuator **`kv`** (default `2·√kp`, near-critical) — damps the servo.

Maps onto the existing `SimJoint.motor`: `stiffness → kp`, `damping → kv`.

---

## 4. Scripted bodies that still collide — the crux for carriage-needles

The knitting demo is **all-kinematic** (carriage + needles scripted). The naive
mapping (kinematic → MuJoCo mocap body) fails: **MuJoCo culls contacts between two
DOF-less bodies** (verified: `ncon=0` for fully-overlapping mocap boxes), so nothing
collides.

**Solution — weld-driven dynamic bodies.** Each kinematic body becomes a geom-less
**mocap target** plus a **dynamic body** carrying the geometry, bound by a stiff
`<weld solref="0.002 1">`. The weld drags the body along the scripted trajectory
each step, but because it now has DOF it generates real contacts — with other
scripted bodies *and* with free dynamic parts (which it can shove). Verified: tracks
tightly (0.195 vs 0.199 m while pressing a wall) and reports contacts at face-touch.

Two more pieces were needed to make the demo correct:

- **`gravcomp="1"`** on the weld-driven bodies — cancels gravity so a scripted part
  doesn't *sag* off its target and dip into a neighbour (a sagging carriage would
  clip a lowered needle). It stays dynamic for contacts.
- **`<contact><exclude>` for `acceptedPairs`** — a needle resting *inside* its bed
  slot is a designed overlap. MuJoCo would otherwise resolve that penetration with
  real forces, popping the needle up into the carriage's path (phantom collisions).
  So accepted pairs are physically excluded, not merely filtered from the report.

Output for kinematic bodies is still the **exact scripted pose** (from
`KinematicSim.poseAt`), pixel-exact like Rapier — the weld is a means to
contacts/forces, not a source of visible lag.

Result: the carriage strikes exactly the two **raised** needles and glides over the
three lowered ones — matching the kinematic and Rapier engines.

### 4a. Mesh geoms (Phase 2)

Bodies with tessellation get a real **mesh** collider instead of an AABB box: the
part's vertices are emitted inline (`<mesh vertex="…">`, body-local metres, deduped
at micron precision since CAD tessellation duplicates heavily), and MuJoCo builds
the **convex hull** for collision + inertia. This is exact for convex parts and a
tight over-approximation for concave ones — the same fidelity as Rapier's default
`convexHull` dynamic collider, and far tighter than an AABB. Verified: two
octahedra whose AABBs overlap but hulls don't are reported as colliding with box
colliders and **not** with mesh colliders. Bodies without mesh data still fall back
to a box.

**Limitation — concave collision.** MuJoCo *always* convex-hulls a mesh geom, so a
genuinely concave part (a slotted bed, a C-bracket) collides as its filled hull. In
practice the concave parts of these mechanisms are **static** (bed/frame) and their
designed interpenetrations are handled by `acceptedPairs` excludes (§4). True
concave collision needs convex **decomposition** into multiple hulls (Phase 2b) —
deferred: the only browser/Node option is the unmaintained `vhacd-js` (V-HACD is
deprecated; CoACD has no JS/WASM binding), and single-hull already matches Rapier.

### 4b. Contact force + penetration reporting

MuJoCo's `data.contact` carries what both other engines discard. Each step the
engine sums the per-contact **normal force** (`mj_contactForce` → wrench index 0)
across a pair's contact points and takes the max **penetration** (`−contact.dist`),
then folds those into a per-pair running **peak** over the whole run. `CollisionEvent`
gains optional `peakForceN` / `peakPenetrationMm`, and `run_simulation` prints
`(peak 12.4 N, 0.83 mm deep)` — telling the AI/user not just *that* parts collided
but **how hard** and **how deep**. For scripted (weld-driven) parts that pass
through each other, penetration depth is the useful interference signal; for genuine
dynamic contacts, force reflects the real load (a resting part reports its weight).
Absent on the kinematic (overlap volume instead) and Rapier (neither) engines.

Note: the WASM binding method is `DoubleBuffer.GetView()` (capitalised), not the
`getView()` the package README shows.

---

## 5. Selecting the engine

`sim` block gains an optional `engine`:

```typescript
export const sim = {
  engine: "mujoco",           // "kinematic" | "rapier" | "mujoco"; omit for auto
  bodies: { carriage: "kinematic", "needle-*": "kinematic" },
  joints: [ /* … */ ],
  actuators: [ /* … */ ],
  acceptedPairs: [["needle-*", "bed"]],
  duration: 1.5,
};
```

Dispatch in `run_simulation` (`tools.ts`): `engine` wins if set (`"kinematic"`
forces the analytic engine; `"rapier"`/`"mujoco"` force that backend). With no
`engine`, auto — force-based when a `dynamic` body / `mode:"dynamic"` is present,
else kinematic. The report header shows `[DYNAMICS (MuJoCo)]`.

---

## 6. Packaging

`@mujoco/mujoco` is a **separate 10 MB `.wasm`** (unlike Rapier's base64-inlined
compat build), so it can't be bundled the way `sim-dynamics` is. It follows the
`replicad-opencascadejs`/`resvg-wasm` pattern:

- **esbuild `external`** — the Emscripten loader locates `mujoco.wasm` next to its
  own `.js`, so it must resolve from `node_modules`, not the bundle.
- **`optionalDependency` + dynamic `import()`** in `loader.ts` — the package is
  resolved and its WASM loaded **only when a run selects MuJoCo**, never at
  MCP-server startup. A missing install yields an actionable error, not a crash.
- `@shapeitup/sim-mujoco` itself is a bundled dev-dependency of `mcp-server` (like
  `sim-dynamics`); only the MuJoCo WASM stays external.

Per the release rule, `mcp-server` **and** `extension` were bumped in lockstep
(→ 1.22.0).

---

## 7. Status & next work

**Done (Phase 0/1/2).** Package + translator + engine; static/dynamic/kinematic
bodies, hinge/slide joints, position/velocity actuators, gravity, accepted-pair
excludes, **real mesh-geom colliders** (inline vertices → convex hull, box fallback),
and **contact force + penetration reporting**. `carriage-needles` (on real OCCT
tessellation), `gravity-drop`, and **four-bar linkages** reproduce on MuJoCo;
dynamic bodies can **ride a scripted kinematic parent** while articulating. Wired
into `run_simulation` behind `engine:"mujoco"`, and into the **viewer** (in-webview
playback via the runtime-loaded glue — see below). 14 unit + 2 end-to-end tests; full
suite green.

**Closed loops — two modes.** *Kinematic* (default): linkage bodies are kinematic, the
analytic `linkages.ts` solver drives them (`poseAt` → weld-mocap), and the four-bar
loop stays closed on MuJoCo. *Force-driven* (`dynamic: true` on a `FourBarLinkage`,
MuJoCo only): the crank is prescribed to the driver angle via a mocap-weld body while
the coupler/rocker are real dynamic bars, closed by a `<connect>` constraint — so the
run **reports the pin force** at the coupler↔rocker joint (`SimResult.pinForces`) and
the links respond to gravity/contacts. Implementation notes in §7a.

### 7a. Force-driven four-bar (`dynamic: true`)

The robust recipe (after finding a position servo on the crank is unstable):

- **Seed the closed t=0 config** from `linkageTransforms(lk, 0)`; nest the coupler in
  the crank frame via `{q: q̄crank·qcoupler, t: R(q̄crank)·(Bcoupler−Acrank)}`. The
  loop closes to ~0 mm at reference, which is what `<connect>` needs.
- **Crank = mocap-weld** kinematic body (`gravcomp="1"`), prescribed each step to
  `linkageTransforms(lk, t).crank` — no servo, so no runaway.
- **Coupler** (dynamic, hinged at B, nested in the crank) + **rocker** (dynamic,
  hinged to world at D), closed by `<connect body1=coupler body2=rocker>`.
- **Bar-frame convention:** each linkage bar's MJCF body frame IS its rest bar frame
  (origin at the bar start, +X along the bar, matching the tessellated part drawn +X
  from origin), so the engine reads the coupler/rocker pose straight from `xpos/xquat`
  with no centre offset (unlike a normal AABB-centred dynamic body). The crank outputs
  its exact analytic pose.
- **Pin force:** a `<connect>` is 3 equality rows; the engine finds them by
  `eq_type == mjEQ_CONNECT` and reads `efc_force`, tracking the peak per linkage.
- Bars are `<contact><exclude>`'d pairwise (they overlap at shared pins).

Verified: physics tracks the analytic path within ~1–3 mm, the loop holds to <2 mm,
and the pin force is physically sensible (~fraction of the bars' weight). Only the
four-bar is wired; slider-crank/gear would follow the same pattern.

### Viewer playback (implemented; needs one F5 smoke-test)

The viewer runs its physics engine *in the webview*. Rapier works there because
its WASM is base64-inlined; MuJoCo's 10 MB `.wasm` + Emscripten glue can't be
bundled into the IIFE `viewer.js` (the glue uses `import.meta`/`require`). So MuJoCo
follows the **OCCT loader pattern** — loaded at runtime, not bundled:

- esbuild copies `mujoco.js` + `mujoco.wasm` into `dist` (`copyWasmFiles`).
- `viewer-provider.ts` exposes them as webview URIs in `window.__SHAPEITUP_CONFIG__`
  (`mujocoLoaderUrl` / `mujocoWasmUrl`); the CSP already allows both (script + wasm
  fetch from `cspSource`).
- `loader.ts` imports the glue via a **variable specifier** (`import(specifier)`,
  where `specifier` is the webview URL in the viewer or `"@mujoco/mujoco"` in Node) —
  so esbuild leaves it a runtime import and the un-bundleable glue never enters the
  bundle — then points Emscripten's `locateFile` at the `.wasm` URI. `@mujoco/mujoco`
  is marked external in the viewer build as a safety net.
- `sim-panel.ts` runs `runMujoco` for `engine:"mujoco"`, **falling back** to
  Rapier/kinematic if the load fails — so the viewer never breaks.

Verified: the engine (mjcf/mujoco/loader) bundles into `viewer.js` while the glue
does not; a Node test (`loader-webview.test.ts`) drives the exact config-driven URL
path (import glue by URL + `locateFile`) and runs a sim. **Unverified only:** the
browser runtime itself (does `import(webviewUri)` + Emscripten fetch work inside the
VS Code webview) — needs a one-time F5 check. Cost: the VSIX grows ~10 MB (the
`.wasm`), same as it ships OCCT/manifold WASM today.

**Dynamic child riding a kinematic parent — done.** A static/dynamic body with a
kinematic `parent` now nests inside that parent's weld-driven body, so its own
joint anchors to the (scripted) parent frame — it rides the carriage while
articulating, matching Rapier's parent-anchored joints. `gravcomp` is per-body, so
a nested dynamic child still feels gravity. Verified (a pendulum pinned to a
sweeping carriage rides +X while hanging under gravity).

**Force-driven four-bar (`dynamic: true`) — done.** See §7a. Physics-solves the loop
and reports pin forces; verified end-to-end on real OCCT geometry.

**Next.**

1. **Extend force-driven loops to slider-crank / gear.** Same recipe as §7a (seed
   from `linkageTransforms`, prescribe the driver, close with `<connect>` / a slider
   guide). Only `fourBar` is wired today.
2. **Concave decomposition (Phase 2b).** Multi-hull colliders for concave *dynamic*
   parts via `vhacd-js` (only JS/WASM option; unmaintained — pull in only on a
   concrete need). Static concave parts are handled by `acceptedPairs` today.

---

## 8. Key files

| File | Purpose |
|---|---|
| `packages/sim-mujoco/src/mjcf.ts` | SimSpec → MJCF translator (the core) |
| `packages/sim-mujoco/src/mujoco.ts` | Engine: build → step → read back frames + contacts |
| `packages/sim-mujoco/src/loader.ts` | Cached WASM factory — Node package OR webview URL (variable-specifier import + locateFile) |
| `packages/sim-mujoco/src/mujoco.test.ts` | Unit tests (gravity-drop, servo, carriage-needles, mesh, four-bar) |
| `packages/sim-mujoco/src/loader-webview.test.ts` | Verifies the config-driven URL loader path |
| `packages/mcp-server/src/tools.ts` (~5644) | `run_simulation` engine dispatch |
| `packages/sim/src/schema.ts`, `resolve.ts` | `engine` field on the authoring block |
| `packages/viewer/src/sim-panel.ts` | Viewer engine dispatch + graceful fallback |
| `packages/extension/src/viewer-provider.ts`, `esbuild.config.mjs` | Copy glue/wasm to dist + inject webview URIs |

## 9. Sources

`@mujoco/mujoco` npm (DeepMind, v3.10.0) · MuJoCo XML reference (MJCF: joints,
actuators, equality/weld, gravcomp, integrator) · MuJoCo contact model (DOF-less
contact culling) · `vhacd-js` · CoACD (SIGGRAPH 2022).
