import { makeBolt } from "./bolt.shape";
import { makePlate } from "./plate.shape";

/**
 * Assembly example: a plate with bolts in the mounting holes.
 * Demonstrates multi-file imports and multi-part rendering.
 */
export default function main() {
  const plate = makePlate(80, 50, 5, 5, 3);

  // Place bolts in each mounting hole
  const hx = 80 / 2 - 12;
  const hy = 50 / 2 - 10;

  const bolt1 = makeBolt(8, 20, 4).translate(hx, hy, 5);
  const bolt2 = makeBolt(8, 20, 4).translate(-hx, hy, 5);
  const bolt3 = makeBolt(8, 20, 4).translate(-hx, -hy, 5);
  const bolt4 = makeBolt(8, 20, 4).translate(hx, -hy, 5);

  return [
    { shape: plate, name: "plate", color: "#8899aa" },
    { shape: bolt1, name: "bolt-1", color: "#aa8855" },
    { shape: bolt2, name: "bolt-2", color: "#aa8855" },
    { shape: bolt3, name: "bolt-3", color: "#aa8855" },
    { shape: bolt4, name: "bolt-4", color: "#aa8855" },
  ];
}
