/**
 * `patterns.repeat` against real OCCT.
 *
 * Separate from patterns.test.ts, which runs against a mocked replicad — the
 * behaviour under test here IS the WASM handle lifetime, so a mock would
 * assert nothing.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadOCCTForTest } from "../testing/occt.js";

let rc: typeof import("replicad");
let patterns: typeof import("./patterns.js");

beforeAll(async () => {
  const oc = await loadOCCTForTest();
  rc = await import("replicad");
  rc.setOC(oc);
  patterns = await import("./patterns.js");
}, 120_000);

const box = () => rc.drawRectangle(10, 10).sketchOnPlane("XY").extrude(5) as any;

describe("repeat", () => {
  it("fuses one shape across placements without consuming it", () => {
    const body = box();
    const out = patterns.repeat(body, patterns.grid(3, 1, 30));
    expect(rc.measureVolume(out)).toBeCloseTo(1500, 3);
    // The body is still usable afterwards, which is the whole point: the
    // entry the pattern replaces usually still names it.
    expect(rc.measureVolume(body)).toBeCloseTo(500, 3);
  });

  it("is the form spread cannot safely be given", () => {
    // `spread(() => body, …)` frees `body` on the first placement and reads a
    // deleted handle on the second. Pinned here because the broken call is the
    // one a reader writes first, and it fails several lines from its cause.
    const body = box();
    expect(() => patterns.spread(() => body, patterns.grid(3, 1, 30))).toThrow(
      /deleted/i,
    );
  });

  it("carries rotation as well as translation", () => {
    expect(rc.measureVolume(patterns.repeat(box(), patterns.polar(4, 40)))).toBeCloseTo(
      2000,
      3,
    );
  });

  it("a single placement is a move, not an error", () => {
    const out = patterns.repeat(box(), patterns.linear(1, [10, 0, 0]));
    expect(rc.measureVolume(out)).toBeCloseTo(500, 3);
  });
});
