// Library module A — used by the multifile-test assembly.
//
// Exports its own `export default function main` and `export const params`
// on purpose: this is the shape that used to silently win the ambient-lookup
// race against the assembly's own main. The assembly now imports
// `makePartA` (a named factory) AND this default, so we can verify the
// canonical-entry-marker fix even when the library also keeps its default.
import { drawRectangle } from "replicad";

export const params = {
  aWidth: 20,
  aHeight: 20,
  aDepth: 5,
};

export function makePartA() {
  return drawRectangle(20, 20).sketchOnPlane("XY").extrude(5);
}

export default function main() {
  // Kept just to reproduce the silent-collision bug: if this default "wins",
  // only ONE part renders and the assembly's 2-part return disappears.
  return drawRectangle(5, 5).sketchOnPlane("XY").extrude(1);
}
