/**
 * @shapeitup/sim-mujoco — force-based simulation via MuJoCo (WASM), headless.
 *
 * A second dynamics backend alongside @shapeitup/sim-dynamics (Rapier). Both
 * emit the same SimResult, so the MCP `run_simulation` tool and the viewer
 * consume either engine identically — the choice is per-run (see the engine
 * selector in the MCP tool). Kept in its own package so the ~10 MB MuJoCo WASM
 * only loads when actually selected.
 */
export { runMujoco } from "./mujoco";
export { buildMjcf, type MjcfBuild, type ActuatorBinding } from "./mjcf";
export { loadMujocoModule, type MujocoModule } from "./loader";
export type { MeshData } from "./mesh";
