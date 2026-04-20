/**
 * Smoke-test example — exercises all six mechanism primitives added in the
 * pins/cradles/SPORTS_BALLS stdlib pass. The scene is a small "catapult arm"
 * tableau:
 *
 *   - A base plate with a pivot bore (uses `pins.pivot` to size the hole).
 *   - A hinge pin going through the pivot (`pins.pin` with a shoulder).
 *   - A tennis-ball cradle on top (`cradles.cradle` + `standards.SPORTS_BALLS`).
 *   - Two rubber-band posts (`cradles.band_post`) flanking the cradle.
 *   - A cross-pin / T-handle on the side (`pins.teeBar`).
 *
 * The point is to verify that the exports compile, the imports chain, and the
 * resulting shapes fuse without OCCT fireworks — not to render a usable part.
 */

import { drawRoundedRectangle, type Shape3D } from "replicad";
import { pins, cradles, standards } from "shapeitup";

export const params = {
  plateW: 80,
  plateD: 60,
  plateT: 6,
};

export default function main({ plateW, plateD, plateT }: typeof params) {
  // Base plate.
  const plate = drawRoundedRectangle(plateW, plateD, 4)
    .sketchOnPlane("XY")
    .extrude(plateT)
    .asShape3D() as Shape3D;

  // Pivot: matched M4 pin + bore. Slip-fit for rotation.
  const pivot = pins.pivot({ size: "M4", length: plateT + 10, fit: "slip" });

  // Cut the bore through the plate at (-plateW/4, 0). The bore Shape3D is a
  // plain +Z cylinder, length = pin length, so translate its base down by a
  // small amount to guarantee full penetration.
  const plateWithBore = plate.cut(
    pivot.hole.translate(-plateW / 4, 0, -1),
  );

  // Place the pin through the bore, head sitting just above the plate.
  const hingePin = pins
    .pin({
      diameter: 4,
      length: plateT + 4,
      headDia: 7,
      headThk: 2,
    })
    .translate(-plateW / 4, 0, 0);

  // Tennis-ball cradle on top of the plate at the other end.
  const tennis = standards.SPORTS_BALLS.tennis;
  const cup = cradles
    .cradle({
      ballDiameter: tennis.diameter,
      wall: 3,
      capturePercent: 0.45,
      axis: "+Z",
    })
    .translate(plateW / 4, 0, plateT + tennis.diameter / 2 + 3);

  // Two rubber-band posts flanking the cradle on the Y edges of the plate.
  const postY = plateD / 2 - 6;
  const leftBand = cradles
    .band_post({ postR: 2, hookR: 4, height: 12 })
    .translate(plateW / 4, postY, plateT);
  const rightBand = cradles
    .band_post({ postR: 2, hookR: 4, height: 12 })
    .translate(plateW / 4, -postY, plateT);

  // T-handle cross-pin on the side for a manual release lever.
  const handle = pins
    .teeBar({
      mainDia: 6,
      mainLen: 35,
      crossDia: 5,
      crossLen: 30,
      crossAt: 1,
    })
    .rotate(90, [0, 0, 0], [0, 1, 0])
    .translate(plateW / 2, 0, plateT / 2);

  return [
    { shape: plateWithBore, name: "base", color: "#8899aa" },
    { shape: hingePin, name: "hingePin", color: "#aaaaaa" },
    { shape: cup, name: "ballCradle", color: "#c07844" },
    { shape: leftBand, name: "bandPost.left", color: "#cccc44" },
    { shape: rightBand, name: "bandPost.right", color: "#cccc44" },
    { shape: handle, name: "teeHandle", color: "#555555" },
  ];
}
