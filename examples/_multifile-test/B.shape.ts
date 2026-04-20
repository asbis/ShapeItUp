// Library module B — sibling to A, same pattern.
import { makeCylinder } from "replicad";

export const params = {
  bRadius: 8,
  bHeight: 15,
};

export function makePartB() {
  return makeCylinder(8, 15, [40, 0, 0]);
}

export default function main() {
  // Decoy default — see A.shape.ts for the rationale.
  return makeCylinder(1, 1);
}
