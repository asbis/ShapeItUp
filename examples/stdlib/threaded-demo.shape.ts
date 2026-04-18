/**
 * Threaded-bolt + leadscrew demo — validates Phase 3's helical sweep.
 *
 * Shows three threaded shapes side by side:
 *   1. M5×20 metric bolt (ISO coarse pitch — 0.8mm).
 *   2. M8×30 metric bolt (coarse pitch — 1.25mm).
 *   3. TR8×8 4-start trapezoidal leadscrew, 60mm — the common 3D-printer
 *      Z-axis leadscrew (4 starts give 8mm lead per revolution).
 */

import { threads } from "shapeitup";

export default function main() {
  const m5 = threads.metric("M5", 20);
  const m8 = threads.metric("M8", 30);
  const leadscrew = threads.leadscrew("TR8x8", 60);

  return [
    { shape: m5,         name: "M5x20 bolt",   color: "#c0c4c8" },
    { shape: m8.translate(20, 0, 0),       name: "M8x30 bolt",  color: "#c0c4c8" },
    { shape: leadscrew.translate(40, 0, 0), name: "TR8x8 leadscrew", color: "#d4a017" },
  ];
}
