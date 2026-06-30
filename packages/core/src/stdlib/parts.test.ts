import { describe, it, expect, vi } from "vitest";

// Same mock-shape strategy as motors.test.ts: stand in for replicad's
// Shape3D so Part's transform calls can be driven without WASM.
function mockShape(): any {
  const self: any = {
    __mock: true,
    translate(_x: number, _y: number, _z: number) {
      return self;
    },
    rotate(_angle: number, _pos: any, _dir: any) {
      return self;
    },
    clone() {
      return self;
    },
  };
  return self;
}

vi.mock("replicad", async () => {
  const actual = await vi.importActual<any>("replicad");
  return {
    ...actual,
    makeCylinder: () => mockShape(),
    makeCompound: (_a: any[]) => mockShape(),
  };
});

import { Part, part, faceAt, shaftAt, boreAt } from "./parts";
import { entries } from "./assembly";

describe("Part.rotate signatures", () => {
  it("accepts the canonical 2-arg form (angle, axis)", () => {
    const p = part({
      shape: mockShape(),
      name: "p",
      joints: { top: faceAt(10) },
    });
    // 90deg around world Z — the joint at local [0,0,10] ends up at
    // world [0,0,10] still (Z rotation doesn't move Z).
    const r = p.rotate(90, "+Z");
    expect(r).toBeInstanceOf(Part);
    const top = r.joints.top;
    expect(top.position[2]).toBeCloseTo(10, 5);
    // Axis "+Z" joint rotated 90 around Z → still [0,0,1].
    expect(top.axis).toEqual([0, 0, 1]);
  });

  it("accepts the Shape3D-style 3-arg form (angle, position, direction)", () => {
    // Before this fix the following call crashed:
    //   Error: Axis vector cannot be [0, 0, 0] …
    // Because the 2-arg overload interpreted the origin point as the axis.
    const p = part({
      shape: mockShape(),
      name: "p",
      joints: { pin: shaftAt(0, 5, { xy: [10, 0] }) },
    });
    // Rotate 90deg around a Z axis through the world origin.
    const r = p.rotate(90, [0, 0, 0], [0, 0, 1]);
    expect(r).toBeInstanceOf(Part);
    const pin = r.joints.pin;
    // (10, 0) rotated 90° about Z through origin → (0, 10).
    expect(pin.position[0]).toBeCloseTo(0, 5);
    expect(pin.position[1]).toBeCloseTo(10, 5);
  });

  it("rotates around a non-origin point in the 3-arg form", () => {
    const p = part({
      shape: mockShape(),
      name: "p",
      joints: { tip: faceAt(0, { xy: [20, 0] }) },
    });
    // 180° around Z through (10, 0, 0): the tip at (20, 0, 0) reflects
    // through x=10 to end up at (0, 0, 0).
    const r = p.rotate(180, [10, 0, 0], [0, 0, 1]);
    const tip = r.joints.tip;
    expect(tip.position[0]).toBeCloseTo(0, 5);
    expect(tip.position[1]).toBeCloseTo(0, 5);
  });

  it("the error on a bad 2-arg call names the 3-arg Shape3D form", () => {
    // Users reaching for `.rotate(angle, [0,0,0], [0,0,1])` sometimes
    // drop the third arg; normalizeAxis then sees the zero position and
    // must give them a pointer to the fix. The updated error message
    // names the 3-arg form explicitly.
    const p = part({ shape: mockShape(), name: "p", joints: {} });
    expect(() => p.rotate(90, [0, 0, 0])).toThrow(
      /3-arg form|'\(angle, position, direction\)'|position.*direction/,
    );
  });
});

describe("Part.toEntry / toEntries — joints survive entries()", () => {
  it("toEntry includes joints in WORLD coordinates", () => {
    const p = part({
      shape: mockShape(),
      name: "plate",
      joints: {
        mount: faceAt(5),
        pin: shaftAt(0, 6, { xy: [10, 0] }),
      },
    });
    const e = p.toEntry();
    expect(e.joints).toBeDefined();
    expect(Object.keys(e.joints!)).toEqual(["mount", "pin"]);
    // No transform applied — world = local.
    expect(e.joints!.mount.position).toEqual([0, 0, 5]);
    expect(e.joints!.pin.position).toEqual([10, 0, 0]);
  });

  it("toEntry applies the accumulated transform to joint positions", () => {
    const p = part({
      shape: mockShape(),
      name: "moved",
      joints: { mount: faceAt(5) },
    }).translate(100, 0, 0);
    const e = p.toEntry();
    // After translating +100 on X, the mount joint is at (100, 0, 5).
    expect(e.joints!.mount.position[0]).toBeCloseTo(100, 5);
    expect(e.joints!.mount.position[2]).toBeCloseTo(5, 5);
  });

  it("toEntry omits joints field when none declared", () => {
    const p = part({ shape: mockShape(), name: "p", joints: {} });
    const e = p.toEntry();
    expect(e.joints).toBeUndefined();
  });

  it("toEntry preserves role and diameter when present", () => {
    const p = part({
      shape: mockShape(),
      name: "p",
      joints: { bore: boreAt(0, 5) },
    });
    const e = p.toEntry();
    expect(e.joints!.bore.role).toBe("female");
    expect(e.joints!.bore.diameter).toBe(5);
  });

  it("entries() carries joints through for every part", () => {
    const a = part({
      shape: mockShape(),
      name: "a",
      joints: { top: faceAt(10) },
    });
    const b = part({
      shape: mockShape(),
      name: "b",
      joints: { bot: faceAt(0, { axis: "-Z" }) },
    });
    const out = entries([a, b]);
    expect(out).toHaveLength(2);
    expect(out[0].joints!.top.position).toEqual([0, 0, 10]);
    expect(out[1].joints!.bot.position).toEqual([0, 0, 0]);
  });
});
