/**
 * The serve host's wire validator for `face-op`.
 *
 * It rebuilds the target field by field rather than passing it through, which
 * is right for untrusted input — and means a field the viewer adds is DROPPED
 * unless it is named here. That is how a pinned selector once reached the
 * file as the ambiguous plane-only line the viewer had just refused to offer.
 */
import { describe, it, expect } from "vitest";
import { parseFaceOp } from "./host.js";

const base = {
  type: "face-op",
  requestId: 1,
  op: "extrude",
  partName: null,
  distance: 3,
};
const face = { kind: "PLANE", center: [0, 0, 5], normal: [0, 0, 1] };

describe("parseFaceOp", () => {
  it("keeps a face's pin", () => {
    const r = parseFaceOp({ ...base, target: { kind: "face", face: { ...face, pin: [0, -2.5, 5] } } });
    expect(r?.target).toEqual({ kind: "face", face: { ...face, pin: [0, -2.5, 5] } });
  });

  it("accepts a face with no pin, and adds none", () => {
    const r = parseFaceOp({ ...base, target: { kind: "face", face } });
    expect(r?.target).toEqual({ kind: "face", face });
  });

  it("rejects a pin that is not three finite numbers", () => {
    for (const pin of [[0, 0], [0, NaN, 5], "0,0,5", [0, 0, Infinity]]) {
      expect(parseFaceOp({ ...base, target: { kind: "face", face: { ...face, pin } } })).toBeNull();
    }
  });

  it("drops fields it does not know", () => {
    const r = parseFaceOp({ ...base, target: { kind: "face", face: { ...face, extra: 1 } } });
    expect(r?.target).toEqual({ kind: "face", face });
  });
});
