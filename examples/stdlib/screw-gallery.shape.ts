/**
 * Screw gallery — a catalogue row of every fastener in the stdlib. Useful as
 * a visual reference and as a smoke-test for the fastener factories.
 *
 * Parts (left to right along +X, 15 mm apart): socket-head M3x10, button-head
 * M4x8, flat-head M5x12, hex nut M3, flat washer M3, heat-set insert M3.
 */
import { screws, nuts, washers, inserts } from "shapeitup";

export default function main() {
  const spacing = 15;

  const pieces = [
    {
      shape: screws.socketHead("M3x10"),
      name: "socket-head M3x10",
      color: "#7a8b99",
    },
    {
      shape: screws.buttonHead("M4x8"),
      name: "button-head M4x8",
      color: "#5f8fb0",
    },
    {
      shape: screws.flatHead("M5x12"),
      name: "flat-head M5x12",
      color: "#4a7ca1",
    },
    {
      shape: nuts.hex("M3"),
      name: "hex nut M3",
      color: "#c7b56a",
    },
    {
      shape: washers.flat("M3"),
      name: "flat washer M3",
      color: "#aaaaaa",
    },
    {
      shape: inserts.heatSet("M3"),
      name: "heatset insert M3",
      color: "#c9a94a",
    },
  ];

  return pieces.map((p, i) => ({
    shape: p.shape.translate((i - (pieces.length - 1) / 2) * spacing, 0, 0),
    name: p.name,
    color: p.color,
  }));
}
