import { makeCylinder, drawPolysides } from "replicad";

export default function main() {
  const head = drawPolysides(8, 6).sketchOnPlane("XY").extrude(5);
  const shaft = makeCylinder(4, 20, [0, 0, 5]);
  const bolt = head.fuse(shaft);

  const nutHead = drawPolysides(10, 6).sketchOnPlane("XY", [20, 0, 0]).extrude(5);
  const nutHole = makeCylinder(4, 5, [20, 0, 0]);
  const nut = nutHead.cut(nutHole);

  return [
    { shape: bolt, name: "bolt", color: "#cccccc" },
    { shape: nut, name: "nut", color: "#aaaaaa" }
  ];
}
