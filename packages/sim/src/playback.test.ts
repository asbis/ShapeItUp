import { describe, it, expect } from "vitest";
import { sampleFrames } from "./playback";
import { slerp, quatFromAxisAngle, rotate, type Vec3 } from "./transform";
import type { SimResult } from "./types";

describe("slerp", () => {
  it("endpoints and midpoint of a 90° Z-rotation", () => {
    const a = quatFromAxisAngle([0, 0, 1], 0);
    const b = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    expect(slerp(a, b, 0)).toEqual(a);
    // Midpoint should be a 45° rotation: applying it to +X lands at (√2/2, √2/2).
    const mid = slerp(a, b, 0.5);
    const p = rotate(mid, [1, 0, 0] as Vec3);
    expect(p[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(p[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

describe("sampleFrames", () => {
  const result: SimResult = {
    duration: 1,
    timestep: 0.5,
    collisions: [],
    frames: [
      { t: 0, poses: { box: [0, 0, 0, 0, 0, 0, 1] } },
      { t: 0.5, poses: { box: [10, 0, 0, 0, 0, 0, 1] } },
      { t: 1, poses: { box: [10, 0, 20, 0, 0, 0, 1] } },
    ],
  };

  it("interpolates position linearly between frames", () => {
    expect(sampleFrames(result, 0).get("box")!.t[0]).toBeCloseTo(0);
    expect(sampleFrames(result, 0.25).get("box")!.t[0]).toBeCloseTo(5); // halfway 0→10
    expect(sampleFrames(result, 0.5).get("box")!.t[0]).toBeCloseTo(10);
    expect(sampleFrames(result, 0.75).get("box")!.t[2]).toBeCloseTo(10); // halfway 0→20 in z
  });

  it("clamps and holds the final frame past the end", () => {
    const p = sampleFrames(result, 5).get("box")!;
    expect(p.t).toEqual([10, 0, 20]);
  });

  it("returns an empty map for an empty recording", () => {
    expect(sampleFrames({ duration: 1, timestep: 0.1, collisions: [], frames: [] }, 0.5).size).toBe(0);
  });
});
