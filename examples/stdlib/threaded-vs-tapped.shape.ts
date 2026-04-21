// Side-by-side: modeled threads (threads.tapInto) vs self-tap hole (holes.tapped).
//
// Purpose: print BOTH plates side-by-side and try to install an M5 screw into each.
//
// What you should see on a typical 0.4 mm nozzle FDM printer:
//  - Red plate (modeled threads): slicer may warn or skip thread features.
//    The "thread" prints as a smudge; the screw bores through plastic anyway.
//  - Green plate (self-tap hole): slices clean; the M5 screw self-taps into
//    the pilot hole, leaving a solid usable thread in the plastic.
//
// Rule of thumb for FDM: threads.tapInto is right for STEP-to-CNC and for
// M6+ on large nozzles. For M2–M5 on FDM, holes.tapped is the correct call.
//
// For STEP export to CNC or injection molding: use threads.tapInto on both
// — modeled threads are what downstream tooling expects.

import { makeBox } from "replicad";
import { holes, threads } from "shapeitup";

export const params = {
  plateSize: 20,
  plateHeight: 10,
  holeDepth: 8,
  spacing: 30,
};

export default function main({
  plateSize,
  plateHeight,
  holeDepth,
  spacing,
}: typeof params) {
  const half = plateSize / 2;

  // --- Red plate: modeled helical threads via threads.tapInto ---
  // Plate sits centred on the X=-spacing/2 column, spanning Z ∈ [0, plateHeight].
  const redCx = -spacing / 2;
  const redBase = makeBox(
    [redCx - half, -half, 0],
    [redCx + half, half, plateHeight]
  );
  // tapInto takes (plate, size, depth, openingPosition). Opening is on the top
  // face at Z=plateHeight. It cuts the tap-drill hole AND models helical threads.
  const modeledPlate = threads.tapInto(redBase, "M5", holeDepth, [
    redCx,
    0,
    plateHeight,
  ]);

  // --- Green plate: self-tap pilot hole via holes.tapped ---
  // Same overall geometry, placed at X=+spacing/2. holes.tapped returns a
  // cut-tool whose mouth is at local Z=0 — translate up to the plate's top
  // face and subtract.
  const greenCx = spacing / 2;
  const greenBase = makeBox(
    [greenCx - half, -half, 0],
    [greenCx + half, half, plateHeight]
  );
  const tappedPlate = greenBase.cut(
    holes.tapped("M5", { depth: holeDepth }).translate(greenCx, 0, plateHeight)
  );

  return [
    {
      shape: modeledPlate,
      name: "M5 tapInto (modeled threads — hard to FDM)",
      color: "#ffb3b3",
    },
    {
      shape: tappedPlate,
      name: "M5 tapped (self-tap hole — FDM-friendly)",
      color: "#b3ffb3",
    },
  ];
}
