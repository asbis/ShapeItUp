/**
 * Phase-3 DYNAMICS demo — force-based simulation via Rapier (headless).
 *
 * Run it with the MCP tool: `run_simulation({ filePath: ".../gravity-drop.shape.ts" })`.
 * Because a body is declared `dynamic` (and gravity is set), run_simulation
 * switches from the analytic kinematic engine to the Rapier physics solver.
 *
 * Three cubes start stacked in the air above a static plate. Under gravity they
 * fall, hit the plate, and settle — the report shows each cube's net
 * displacement and whether it came to rest. Unlike the kinematic carriage demo
 * (scripted motion), nothing here is scripted: the motion is SOLVED from gravity
 * + contacts.
 *
 * Note: this is a headless/MCP feature for now — the viewer plays back the
 * kinematic engine; dynamics-frame playback in the viewer is a later step.
 */

import { drawRectangle } from "replicad";

function box(w: number, d: number, h: number, cx: number, cy: number, z0: number) {
  return drawRectangle(w, d).sketchOnPlane("XY").extrude(h).translate(cx, cy, z0);
}

export default function main() {
  const plate = box(200, 200, 10, 0, 0, -10); // static, top face at z = 0
  const cubes = [0, 1, 2].map((i) => ({
    shape: box(20, 20, 20, i * 6 - 6, 0, 60 + i * 40), // stagger x + height
    name: `cube-${i + 1}`,
    color: ["#d64545", "#45a0d6", "#d6b845"][i],
  }));
  return [{ shape: plate, name: "plate", color: "#5a6270" }, ...cubes];
}

export const sim = {
  mode: "dynamic", // → Rapier physics engine
  bodies: {
    plate: "static",
    "cube-*": "dynamic", // fall under gravity, collide with the plate + each other
  },
  gravity: [0, 0, -9810], // mm/s²
  duration: 2.5,
};
