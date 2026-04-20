/**
 * Thread gallery — full production test including modeled internal threads.
 *
 * External threads: build123d-style per-turn loft + compound (B-Rep, <1s each).
 * Internal threads: `threads.tapInto(plate, ...)` — generates helix geometry
 * as raw triangles and uses Manifold (mesh CSG) to cut the plate. Bypasses
 * OCCT's slow B-spline helical boolean.
 */

import { makeBox } from "replicad";
import { threads } from "shapeitup";

export default function main() {
  const m6 = threads.metric("M6", 12);
  const m8 = threads.metric("M8", 25).translate(20, 0, 0);
  const leadscrew = threads.leadscrew("TR8x8", 30).translate(45, 0, 0);

  // Modeled internal thread via mesh-native tapInto. Plate top at z=8.
  const plate = makeBox([-15, -10, 0], [5, 10, 8]).translate(-30, 0, 0);
  const tapped = threads.tapInto(plate, "M5", 8, [-35, 0, 8]);

  
  return [
    { shape: tapped, name: "M5 tapped plate (modeled mesh)", color: "#aa8855" },
    { shape: m6, name: "M6×12", color: "#c0c4c8" },
    { shape: m8, name: "M8×25", color: "#c0c4c8" },
    { shape: leadscrew, name: "TR8x8×30 (4-start)", color: "#d4a017" },
  ];
}
