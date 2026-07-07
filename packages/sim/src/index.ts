/**
 * @shapeitup/sim — headless, framework-agnostic simulation core.
 *
 * No Three.js, no OCCT, no DOM: the same code runs in the browser viewer (to
 * drive per-frame poses) and in Node/MCP (to run headless motion studies and
 * return collision events to an AI). Phase 1 is kinematic (scripted motion +
 * AABB collision); dynamics (Rapier) and FEA (Gmsh/CalculiX sidecar) are later
 * modules that consume the same SimSpec. See docs/simulation-design.md.
 */

export * from "./transform";
export * from "./types";
export * from "./actuators";
export * from "./collision";
export * from "./units";
export * from "./resolve";
export * from "./playback";
export * from "./schema";
export * from "./assertions";
export * from "./linkages";
export { KinematicSim } from "./kinematics";
