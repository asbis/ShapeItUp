import { sketchCircle, drawCircle } from "replicad";

export default function main() {
  // Simple bottle shape: flange base + cylindrical body + hollow interior
  const base = sketchCircle(30).extrude(5);
  const body = sketchCircle(15).extrude(50).translateZ(5);
  const interior = sketchCircle(12).extrude(52);

  return base.fuse(body).cut(interior).fillet(3);
}
