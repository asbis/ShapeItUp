// The assembly imports the other two files like any TypeScript module.
// Change a component, and every assembly that uses it follows.
import { drawRoundedRectangle } from "replicad";
import { patterns } from "shapeitup";
import { makePlate } from "./plate.shape";
import { makeStandoff } from "./standoff.shape";

export const params = {
  plateThickness: 4,
  standoffHeight: 10,
  holesX: 58, // Raspberry Pi hole pattern
  holesY: 49,
};

export default function main({ plateThickness, standoffHeight, holesX, holesY }: typeof params) {
  const plate = makePlate(100, 80, plateThickness, holesX, holesY);

  const standoffs = patterns.grid(2, 2, holesX, holesY).map((p, i) => ({
    shape: makeStandoff(standoffHeight).translate(p.translate[0], p.translate[1], plateThickness),
    name: `standoff ${i + 1}`,
    color: "#c9a24a",
  }));

  // A stand-in for the board, so you can see what sits where.
  const board = drawRoundedRectangle(85, 56, 3)
    .sketchOnPlane("XY")
    .extrude(1.6)
    .translate(0, 0, plateThickness + standoffHeight);

  return [
    { shape: plate, name: "plate", color: "#5b6b7c" },
    ...standoffs,
    { shape: board, name: "board", color: "#2f8f5b" },
  ];
}
