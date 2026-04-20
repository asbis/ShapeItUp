/**
 * Fastener gallery — showcases both stdlib namespaces side-by-side:
 *
 *   screws.*  (top row, +Y 15) — cosmetic: plain cylinder shafts, B-Rep
 *   bolts.*   (bottom row, −Y 15) — threaded: real helical geometry
 *
 * The pairing is 1:1 — every screws.socket has a corresponding bolts.socket,
 * etc. Swap one namespace for the other and your geometry gets/loses threads
 * with no other code change.
 */

import { screws, bolts, washers, inserts } from "shapeitup";

export default function main() {
  const spacing = 15;

  // Each entry is a pair: [cosmetic shape, threaded shape (or null)]. `null`
  // = no threaded equivalent (washers, inserts).
  const row: Array<{ cosmetic: any; threaded: any; name: string; color: string }> = [
    { cosmetic: screws.socket("M3x10"), threaded: bolts.socket("M3x10"), name: "socket M3x10", color: "#7a8b99" },
    { cosmetic: screws.button("M4x8"),  threaded: bolts.button("M4x8"),  name: "button M4x8",  color: "#5f8fb0" },
    { cosmetic: screws.flat("M5x12"),   threaded: bolts.flat("M5x12"),   name: "flat M5x12",   color: "#4a7ca1" },
    { cosmetic: screws.hex("M6x20"),    threaded: bolts.hex("M6x20"),    name: "hex M6x20",    color: "#3d6f93" },
    { cosmetic: screws.nut("M3"),       threaded: bolts.nut("M3"),       name: "nut M3",       color: "#c7b56a" },
    { cosmetic: washers.flat("M3"),     threaded: null,                  name: "washer M3",    color: "#aaaaaa" },
    { cosmetic: inserts.heatSet("M3"),  threaded: null,                  name: "heatset M3",   color: "#c9a94a" },
  ];

  const parts: Array<{ shape: any; name: string; color: string }> = [];
  row.forEach((entry, i) => {
    const x = (i - (row.length - 1) / 2) * spacing;
    parts.push({
      shape: entry.cosmetic.translate(x, 15, 0),
      name: `screws.${entry.name}`,
      color: entry.color,
    });
    if (entry.threaded) {
      parts.push({
        shape: entry.threaded.translate(x, -15, 0),
        name: `bolts.${entry.name}`,
        color: entry.color,
      });
    }
  });
  return parts;
}
