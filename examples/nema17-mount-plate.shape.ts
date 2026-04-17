import { drawRoundedRectangle, sketchCircle } from "replicad";
import { holes, inserts, bearings, fromBack, shape3d } from "shapeitup";

export const params = {
  thickness: 6,
  extrusionSize: 20,
  motorOffsetY: -25,
};

export const material = { density: 1.24, name: "PLA" };

export default function main({ thickness, extrusionSize, motorOffsetY }: typeof params) {
  const width = 70;
  const height = 160;
  const cornerRadius = 5;

  const slotY = -height / 2 + extrusionSize / 2 + 5;
  const motorY = motorOffsetY;
  const bearingY = motorY + 45;
  const insertRowY1 = bearingY + 22;
  const insertRowY2 = bearingY + 42;
  const insertX = 22;

  let plate = shape3d(
    drawRoundedRectangle(width, height, cornerRadius).sketchOnPlane("XY").extrude(thickness)
  );

  const extrusionSlot = holes
    .slot({ length: 40, width: 5.5, depth: thickness })
    .translate(0, slotY, thickness);
  plate = plate.cut(extrusionSlot);

  const shaftBossHole = shape3d(sketchCircle(11).extrude(thickness + 2))
    .translate(0, motorY, -1);
  plate = plate.cut(shaftBossHole);

  const motorBolt = 31 / 2;
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
    const cb = holes
      .counterbore("M3", { plateThickness: thickness })
      .translate(dx * motorBolt, motorY + dy * motorBolt, thickness);
    plate = plate.cut(cb);
  }

  const idlerSeat = bearings
    .seat("608", { throughHole: true })
    .translate(0, bearingY, thickness);
  plate = plate.cut(idlerSeat);

  const insertPositions: [number, number][] = [
    [-insertX, insertRowY1], [insertX, insertRowY1],
    [-insertX, insertRowY2], [insertX, insertRowY2],
  ];
  for (const [x, y] of insertPositions) {
    const pocket = fromBack(inserts.pocket("M3")).translate(x, y, 0);
    plate = plate.cut(pocket);
  }

  return plate;
}
