/**
 * The live preview: applying a face operation to the executed parts without
 * it being in the source.
 *
 * The claim under test is FAITHFULNESS. The generated source wraps the part's
 * shape expression, so the operation is the outermost call there too — which
 * means previewing it here must produce exactly the geometry the committed
 * edit would. If those ever diverge, the preview becomes a promise the file
 * does not keep.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "./index.js";
import { loadOCCTForTest } from "./testing/occt.js";
import { synthesizeFaceSelector } from "@shapeitup/shared";

let core: Awaited<ReturnType<typeof initCore>>;

beforeAll(async () => {
  core = await initCore(loadOCCTForTest);
}, 120_000);

const PLATE = `
  const { drawRectangle, drawCircle } = __replicad__;
  const params = { width: 80, depth: 60, thickness: 8 };
  function main({ width, depth, thickness }) {
    const bore = drawCircle(6).sketchOnPlane("XY", -1).extrude(thickness + 2);
    return drawRectangle(width, depth).sketchOnPlane().extrude(thickness).cut(bore);
  }
`;

/** Two named parts, so the preview has to pick the right one. */
const TWO_PARTS = `
  const { drawRectangle, drawCircle } = __replicad__;
  const params = { width: 80, depth: 60, thickness: 8 };
  function main({ width, depth, thickness }) {
    const a = drawRectangle(width, depth).sketchOnPlane().extrude(thickness);
    const b = drawRectangle(width, depth).sketchOnPlane().extrude(thickness).translate(200, 0, 0);
    return [{ shape: a, name: "left" }, { shape: b, name: "right" }];
  }
`;

const TOP_FACE = { kind: "face" as const, plane: "XY", offset: 8 };
const vol = (parts: any[], i = 0) => parts[i].volume ?? 0;

async function run(js: string, previewOp?: any) {
  const r = await core.execute(js, undefined, { partStats: "full", previewOp });
  return r.parts;
}

async function runFull(js: string, previewOp?: any) {
  return core.execute(js, undefined, { partStats: "full", previewOp });
}

/** Volume of a closed triangle mesh, by tetrahedron integration about origin. */
function meshVolume(v: Float32Array, t: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 3, b = t[i + 1]! * 3, c = t[i + 2]! * 3;
    total +=
      (v[a]! * (v[b + 1]! * v[c + 2]! - v[b + 2]! * v[c + 1]!) -
        v[a + 1]! * (v[b]! * v[c + 2]! - v[b + 2]! * v[c]!) +
        v[a + 2]! * (v[b]! * v[c + 1]! - v[b + 1]! * v[c]!)) / 6;
  }
  return Math.abs(total);
}

describe("preview op", () => {
  it("does nothing when none is given", async () => {
    const base = await run(PLATE);
    expect(vol(base)).toBeGreaterThan(0);
  });

  it("extrudes the previewed face", async () => {
    const base = await run(PLATE);
    const previewed = await run(PLATE, {
      op: "extrude",
      partName: null,
      target: TOP_FACE,
      distance: 5,
    });
    // 80 x 60 less the bore, times 5 mm.
    const area = 80 * 60 - Math.PI * 36;
    expect(vol(previewed) - vol(base)).toBeCloseTo(area * 5, 0);
  });

  it("fillets and chamfers the previewed face's boundary", async () => {
    const base = await run(PLATE);
    for (const op of ["fillet", "chamfer"] as const) {
      const previewed = await run(PLATE, {
        op,
        partName: null,
        target: TOP_FACE,
        distance: 2,
      });
      expect(vol(previewed)).toBeLessThan(vol(base));
    }
  });

  it("rounds a single previewed edge", async () => {
    const base = await run(PLATE);
    const previewed = await run(PLATE, {
      op: "fillet",
      partName: null,
      // Midpoint of the top-front edge of an 80 x 60 x 8 plate.
      target: { kind: "edge", point: [0, -30, 8] },
      distance: 2,
    });
    // One 80 mm edge; a sharp outline means no tangent neighbours to carry to.
    expect(vol(base) - vol(previewed)).toBeCloseTo((1 - Math.PI / 4) * 4 * 80, 0);
  });

  it("acts on the named part and leaves its sibling alone", async () => {
    const base = await run(TWO_PARTS);
    const previewed = await run(TWO_PARTS, {
      op: "extrude",
      partName: "right",
      target: TOP_FACE,
      distance: 5,
    });
    expect(vol(previewed, 0)).toBeCloseTo(vol(base, 0), 1);
    expect(vol(previewed, 1)).toBeGreaterThan(vol(base, 1) + 1);
  });

  it("declines quietly when the part name is not there", async () => {
    // A stale name must not take the render down — the user is mid-drag.
    const base = await run(TWO_PARTS);
    const previewed = await run(TWO_PARTS, {
      op: "extrude",
      partName: "missing",
      target: TOP_FACE,
      distance: 5,
    });
    expect(vol(previewed, 0)).toBeCloseTo(vol(base, 0), 1);
    expect(vol(previewed, 1)).toBeCloseTo(vol(base, 1), 1);
  });

  it("declines to extrude an edge, which has no meaning", async () => {
    const base = await run(PLATE);
    const previewed = await run(PLATE, {
      op: "extrude",
      partName: null,
      target: { kind: "edge", point: [0, -30, 8] },
      distance: 5,
    });
    expect(vol(previewed)).toBeCloseTo(vol(base), 1);
  });

  it("survives a selector that matches nothing", async () => {
    const base = await run(PLATE);
    const previewed = await run(PLATE, {
      op: "fillet",
      partName: null,
      target: { kind: "face", plane: "XY", offset: 999 },
      distance: 2,
    });
    expect(vol(previewed)).toBeCloseTo(vol(base), 1);
  });

  it("leaves no trace on the next execution", async () => {
    // The preview is not state. Running again without one must give the file's
    // own geometry back, or a cancelled drag would leave the model altered.
    const base = await run(PLATE);
    await run(PLATE, { op: "extrude", partName: null, target: TOP_FACE, distance: 20 });
    const after = await run(PLATE);
    expect(vol(after)).toBeCloseTo(vol(base), 1);
  });

  describe("the added / removed ghost", () => {
    // 80 x 60 plate less a r=6 bore.
    const AREA = 80 * 60 - Math.PI * 36;

    it("reports a pull as added, and its volume is the material gained", () => {
      // Checked against the model's own volume change, so the ghost cannot
      // drift from what the operation actually did.
      return (async () => {
        const base = await run(PLATE);
        const r = await runFull(PLATE, {
          op: "extrude", partName: null, target: TOP_FACE, distance: 6,
        });
        expect(r.previewDelta?.mode).toBe("added");
        const ghost = meshVolume(r.previewDelta!.vertices, r.previewDelta!.triangles);
        const gained = (r.parts[0]!.volume ?? 0) - (base[0]!.volume ?? 0);
        // Coarse tessellation, so a percent of slack on the round bore.
        expect(ghost).toBeGreaterThan(gained * 0.97);
        expect(ghost).toBeLessThan(gained * 1.03);
        expect(gained).toBeCloseTo(AREA * 6, 0);
      })();
    });

    it("reports a push as removed", () => {
      return (async () => {
        const base = await run(PLATE);
        const r = await runFull(PLATE, {
          op: "extrude", partName: null, target: TOP_FACE, distance: -3,
        });
        expect(r.previewDelta?.mode).toBe("removed");
        const ghost = meshVolume(r.previewDelta!.vertices, r.previewDelta!.triangles);
        const lost = (base[0]!.volume ?? 0) - (r.parts[0]!.volume ?? 0);
        expect(ghost).toBeGreaterThan(lost * 0.97);
        expect(ghost).toBeLessThan(lost * 1.03);
      })();
    });

    it("produces none for fillet or chamfer, deliberately", () => {
      // Their delta is a thin sliver, recoverable only through a
      // `base.cut(result)` boolean measured at ~690 ms on this plate — too
      // slow to compute while someone is dragging. The edge highlight carries
      // that information instead.
      return (async () => {
        for (const op of ["fillet", "chamfer"] as const) {
          const r = await runFull(PLATE, {
            op, partName: null, target: TOP_FACE, distance: 2,
          });
          expect(r.previewDelta).toBeUndefined();
          // The operation itself still happened.
          expect(r.parts[0]!.volume).toBeLessThan(AREA * 8);
        }
      })();
    });

    it("produces none when the operation declined", () => {
      return (async () => {
        const r = await runFull(PLATE, {
          op: "extrude",
          partName: null,
          target: { kind: "face", plane: "XY", offset: 999 },
          distance: 5,
        });
        expect(r.previewDelta).toBeUndefined();
      })();
    });

    it("produces none without a preview op at all", () => {
      return (async () => {
        expect((await runFull(PLATE)).previewDelta).toBeUndefined();
      })();
    });
  });
});

/**
 * A plane is not always a name.
 *
 * Two ribs fused across a base plate split the plate's top into three
 * coplanar faces — the shape of the website's L-bracket with its gussets.
 * `inPlane("XY", thickness)` then matches all three, and every stdlib face
 * helper refuses it. Before this was caught the viewer wrote exactly that
 * line: the preview looked right, the file did nothing.
 */
describe("a face whose plane is shared", () => {
  // Ribs at x = ±15, 5 wide, running the full depth: the top at z = 5 is
  // three faces, and the middle one spans x in [-12.5, 12.5].
  const RIBBED = (extra = "") => `
    const { drawRectangle, drawCircle } = __replicad__;
    const { extrudeFace } = __shapeitup__;
    const params = { width: 80, depth: 40, thickness: 5, rib: 20 };
    function main({ width, depth, thickness, rib }) {
      let shape = drawRectangle(width, depth).sketchOnPlane().extrude(thickness);
      for (const x of [-15, 15]) {
        shape = shape.fuse(
          drawRectangle(5, depth).sketchOnPlane("XY", thickness).extrude(rib).translate(x, 0, 0),
        );
      }
      ${extra}
      return shape;
    }
  `;
  const PARAMS = { width: 80, depth: 40, thickness: 5, rib: 20 };
  const MIDDLE = { kind: "face" as const, plane: "XY", offset: 5, center: [0, 0, 5] as [number, number, number] };
  const MIDDLE_AREA = 25 * 40;

  it("reports a unique plane as unique, and asks for no pin", async () => {
    const r = await runFull(PLATE, {
      op: "extrude",
      partName: null,
      target: { ...TOP_FACE, center: [0, 0, 8] },
      distance: 5,
    });
    expect(r.previewTarget).toEqual({ planeMatches: 1 });
  });

  it("counts the coplanar faces and pins the picked one", async () => {
    const r = await runFull(RIBBED(), { op: "extrude", partName: null, target: MIDDLE, distance: 3 });
    expect(r.previewTarget?.planeMatches).toBe(3);
    // The centre is inside the middle face, so it is the pin — rounded, and
    // snapped onto the plane.
    expect(r.previewTarget?.pin).toEqual([0, 0, 5]);
  });

  it("previews the pinned face, and only it", async () => {
    const base = await run(RIBBED());
    const previewed = await run(RIBBED(), { op: "extrude", partName: null, target: MIDDLE, distance: 3 });
    expect(vol(previewed) - vol(base)).toBeCloseTo(MIDDLE_AREA * 3, 0);
  });

  it("writes a line that does what the preview showed", async () => {
    // The faithfulness claim, end to end: the report's pin goes through the
    // same synthesiser the hosts use, the line goes into the script, and the
    // re-run must match the preview to the cubic millimetre.
    const report = (await runFull(RIBBED(), {
      op: "extrude",
      partName: null,
      target: MIDDLE,
      distance: 3,
    })).previewTarget!;
    const sel = synthesizeFaceSelector(
      { kind: "PLANE", center: MIDDLE.center, normal: [0, 0, 1], pin: report.pin },
      PARAMS,
    );
    if (!sel.ok) throw new Error("no selector");
    expect(sel.selector.code).toBe('(f) => f.inPlane("XY", thickness).containsPoint([0, 0, thickness])');
    expect(sel.selector.durable).toBe(true);

    const committed = await runFull(RIBBED(`shape = extrudeFace(shape, ${sel.selector.code}, 3);`));
    const previewed = await run(RIBBED(), { op: "extrude", partName: null, target: MIDDLE, distance: 3 });
    expect(committed.warnings.some((w) => /extrudeFace/.test(w))).toBe(false);
    expect(vol(committed.parts)).toBeCloseTo(vol(previewed), 1);
  });

  it("the unpinned line is the one that silently did nothing", async () => {
    // Documents the bug this guards against, so a regression reads plainly.
    const base = await run(RIBBED());
    const r = await runFull(RIBBED('shape = extrudeFace(shape, (f) => f.inPlane("XY", thickness), 3);'));
    expect(r.warnings.some((w) => /matched 3 faces/.test(w))).toBe(true);
    expect(vol(r.parts)).toBeCloseTo(vol(base), 1);
  });

  it("falls back to an interior point when the centre is not on the face", async () => {
    // A boss through the middle face puts its centre of mass in the hole.
    const BOSSED = RIBBED(
      "shape = shape.fuse(drawCircle(4).sketchOnPlane('XY', thickness).extrude(10));",
    );
    const target = { ...MIDDLE, interior: [-10.03, 15.07, 5] as [number, number, number] };
    const r = await runFull(BOSSED, { op: "extrude", partName: null, target, distance: 3 });
    expect(r.previewTarget?.planeMatches).toBe(3);
    expect(r.previewTarget?.pin).toEqual([-10, 15.1, 5]);

    const base = await run(BOSSED);
    const previewed = await run(BOSSED, { op: "extrude", partName: null, target, distance: 3 });
    expect(vol(previewed) - vol(base)).toBeCloseTo((MIDDLE_AREA - Math.PI * 16) * 3, 0);
  });

  it("offers no pin when nothing identifies the picked face", async () => {
    // No centre means no way to tell which of the three was meant. Guessing
    // would pin SOME face; the viewer must instead refuse to write.
    const r = await runFull(RIBBED(), {
      op: "extrude",
      partName: null,
      target: { kind: "face", plane: "XY", offset: 5 },
      distance: 3,
    });
    expect(r.previewTarget).toEqual({ planeMatches: 3 });
  });

  it("rounds the pinned face's boundary too", async () => {
    const base = await run(RIBBED());
    const r = await runFull(RIBBED(), { op: "chamfer", partName: null, target: MIDDLE, distance: 1 });
    expect(r.previewTarget?.pin).toBeDefined();
    // Two of its edges meet the ribs in a concave corner, where a chamfer
    // ADDS material — so the claim is only that it acted, not which way.
    expect(Math.abs(vol(r.parts) - vol(base))).toBeGreaterThan(1);
  });
});
