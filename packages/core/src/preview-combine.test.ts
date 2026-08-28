/**
 * The live preview of a Combine: applying it to the executed parts without it
 * being in the source.
 *
 * The claim under test is FAITHFULNESS, as for the face operations. The
 * committed edit puts the call at the outermost position of the target's
 * `shape:` expression, so applying it to the finished parts list must produce
 * exactly the geometry the file would — including the part that is no longer
 * there. If those diverge, the preview becomes a promise the file does not
 * keep.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "./index.js";
import { loadOCCTForTest } from "./testing/occt.js";
import { applyEdits, computeCombineEdit } from "@shapeitup/shared";

let core: Awaited<ReturnType<typeof initCore>>;

beforeAll(async () => {
  core = await initCore(loadOCCTForTest);
}, 120_000);

/**
 * Two 20 mm cubes overlapping in a 20 x 20 x 10 slab, plus a third that is
 * nowhere near either — so a preview can be checked for acting on the bodies
 * it was told to and no others.
 */
const THREE_BODIES = `
  const { drawRectangle } = __replicad__;
  const params = { size: 20 };
  function main({ size }) {
    const cube = (z) => drawRectangle(size, size).sketchOnPlane("XY", z).extrude(size);
    return [
      { shape: cube(0), name: "base" },
      { shape: cube(10), name: "boss" },
      { shape: cube(0).translate(200, 0, 0), name: "far" },
    ];
  }
`;

const CUBE = 20 * 20 * 20;
const OVERLAP = 20 * 20 * 10;

const byName = (parts: any[], name: string) => parts.find((p: any) => p.name === name);

async function run(previewCombine?: any) {
  return core.execute(THREE_BODIES, undefined, { partStats: "full", previewCombine });
}

describe("preview combine", () => {
  it("leaves the model alone when none is given", async () => {
    const r = await run();
    expect(r.parts.map((p: any) => p.name)).toEqual(["base", "boss", "far"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(CUBE, 1);
  });

  it("joins into the target and removes the tool's body", async () => {
    const r = await run({ op: "join", targetName: "base", toolNames: ["boss"] });
    // The tool is gone from the model, exactly as its entry would be gone
    // from the file.
    expect(r.parts.map((p: any) => p.name)).toEqual(["base", "far"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(2 * CUBE - OVERLAP, 1);
    // And the body that was named in neither role is untouched.
    expect(byName(r.parts, "far").volume).toBeCloseTo(CUBE, 1);
  });

  it("cuts the tool out of the target", async () => {
    const r = await run({ op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(byName(r.parts, "base").volume).toBeCloseTo(CUBE - OVERLAP, 1);
  });

  it("keeps only the shared volume on intersect", async () => {
    const r = await run({ op: "intersect", targetName: "base", toolNames: ["boss"] });
    expect(byName(r.parts, "base").volume).toBeCloseTo(OVERLAP, 1);
  });

  it("keeps the tool body when asked to", async () => {
    const r = await run({
      op: "join",
      targetName: "base",
      toolNames: ["boss"],
      keepTools: true,
    });
    expect(r.parts.map((p: any) => p.name)).toEqual(["base", "boss", "far"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(2 * CUBE - OVERLAP, 1);
    // Kept means kept whole — the tool is not consumed by having been used.
    expect(byName(r.parts, "boss").volume).toBeCloseTo(CUBE, 1);
  });

  it("takes several tools and removes all of them", async () => {
    const r = await run({ op: "join", targetName: "base", toolNames: ["boss", "far"] });
    expect(r.parts.map((p: any) => p.name)).toEqual(["base"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(3 * CUBE - OVERLAP, 1);
  });

  it("reports what it measured, so the bar need not measure again", async () => {
    const r = await run({ op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(r.combineStats?.op).toBe("cut");
    expect(r.combineStats?.targetVolume).toBeCloseTo(CUBE, 1);
    expect(r.combineStats?.deltaVolume).toBeCloseTo(OVERLAP, 1);
  });

  it("flags bodies that do not touch instead of silently making two lumps", async () => {
    const r = await run({ op: "join", targetName: "base", toolNames: ["far"] });
    expect(r.combineStats?.disjoint).toBe(true);
    expect(r.combineStats?.disjointTools).toEqual([0]);
  });

  it("flags the ONE tool that missed among tools that landed", async () => {
    const r = await run({ op: "join", targetName: "base", toolNames: ["boss", "far"] });
    expect(r.combineStats?.disjointTools).toEqual([1]);
  });

  it("stays out of the render's warning list — the bar reports it instead", async () => {
    // A preview the user has not committed to must not push warnings into the
    // render on every keystroke.
    const r = await run({ op: "join", targetName: "base", toolNames: ["far"] });
    expect((r.warnings ?? []).some((w: string) => w.startsWith("joinBodies"))).toBe(false);
  });

  it("hands over the material it moves, coloured for the direction", async () => {
    const joined = await run({ op: "join", targetName: "base", toolNames: ["boss"] });
    expect(joined.previewDelta?.mode).toBe("added");
    expect(joined.previewDelta!.triangles.length).toBeGreaterThan(0);

    const cut = await run({ op: "cut", targetName: "base", toolNames: ["boss"] });
    expect(cut.previewDelta?.mode).toBe("removed");
  });

  it("declines quietly when a named body is not there", async () => {
    // A stale name must not take the render down — the user is mid-selection.
    const r = await run({ op: "join", targetName: "base", toolNames: ["ghost"] });
    expect(r.parts.map((p: any) => p.name)).toEqual(["base", "boss", "far"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(CUBE, 1);
  });

  it("declines a body combined with itself rather than guessing", async () => {
    const r = await run({ op: "cut", targetName: "base", toolNames: ["base"] });
    expect(r.parts.map((p: any) => p.name)).toEqual(["base", "boss", "far"]);
    expect(byName(r.parts, "base").volume).toBeCloseTo(CUBE, 1);
  });

  it("leaves no trace on the next execution", async () => {
    await run({ op: "join", targetName: "base", toolNames: ["boss"] });
    const after = await run();
    expect(after.parts.map((p: any) => p.name)).toEqual(["base", "boss", "far"]);
    expect(byName(after.parts, "base").volume).toBeCloseTo(CUBE, 1);
  });
});

/**
 * The claim, tested directly: previewing a combine and COMMITTING it produce
 * the same model.
 *
 * The two paths share nothing but the intent — one applies the operation to
 * the parts after `main()` returns, the other rewrites the file and runs the
 * result through the executor's import rewriting — so agreement here is
 * evidence rather than tautology.
 */
describe("the preview and the committed edit agree", () => {
  const SOURCE = `
import { drawRectangle } from "replicad";

// No export keywords: the executor runs POST-bundle JavaScript, which is
// what it is handed in production too. The rewrite under test does not read
// them either -- it looks for shape/name pairs and a return.
const params = { size: 20 };

function main({ size }) {
  const base = drawRectangle(size, size).sketchOnPlane("XY").extrude(size);
  const boss = drawRectangle(size, size).sketchOnPlane("XY", 10).extrude(size);
  return [
    { shape: base, name: "base" },
    { shape: boss, name: "boss" },
  ];
}
`;

  const shot = (parts: any[]) =>
    parts.map((p: any) => [p.name, Number((p.volume ?? 0).toFixed(4))]);

  for (const op of ["join", "cut", "intersect"] as const) {
    for (const keepTools of [false, true]) {
      it(`${op}${keepTools ? " keeping the tool" : ""}`, async () => {
        const req = { op, targetName: "base", toolNames: ["boss"], keepTools };

        const previewed = await core.execute(SOURCE, undefined, {
          partStats: "full",
          previewCombine: req,
        });

        const edit = computeCombineEdit(SOURCE, req);
        expect(edit.ok).toBe(true);
        if (!edit.ok) return;
        const committed = await core.execute(applyEdits(SOURCE, edit.edits), undefined, {
          partStats: "full",
        });

        expect(shot(committed.parts)).toEqual(shot(previewed.parts));
      });
    }
  }
});
