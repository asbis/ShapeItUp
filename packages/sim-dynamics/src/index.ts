/**
 * @shapeitup/sim-dynamics — force-based (Rapier) simulation, headless.
 *
 * Kept separate from @shapeitup/sim so the Rapier WASM only loads on the Node/MCP
 * side; the browser viewer imports the Rapier-free kinematic core. Both engines
 * emit the same SimResult, so downstream consumers are engine-agnostic.
 */
export { runDynamics, type MeshData } from "./dynamics";
