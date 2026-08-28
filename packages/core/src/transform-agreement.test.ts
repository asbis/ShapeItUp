/**
 * The viewer moves a body by setting a Three.js group's position and
 * quaternion; the file moves it with `.rotate(angle, pivot, axis).translate(t)`.
 * Those are two different pieces of arithmetic, and the manipulator is only
 * honest if they land in the same place.
 *
 * So this computes the transform the VIEWER would apply — the same formula,
 * written out here independently — and checks it against the centre of mass
 * OCCT reports after actually running the committed edit.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initCore } from "./index.js";
import { loadOCCTForTest } from "./testing/occt.js";
import { applyEdits, computeTransformEdit, type Triple, type TransformPivot } from "@shapeitup/shared";

let core: Awaited<ReturnType<typeof initCore>>;

beforeAll(async () => {
  core = await initCore(loadOCCTForTest);
}, 120_000);

/** A 20 x 10 x 6 block whose centre sits at (30, 5, 3). */
const SOURCE = `
import { drawRectangle } from "replicad";
const params = { w: 20, d: 10, t: 6 };
function main({ w, d, t }) {
  const block = drawRectangle(w, d).sketchOnPlane("XY").extrude(t).translate(30, 5, 0);
  return [{ shape: block, name: "block" }];
}
`;

const START: Triple = [30, 5, 3];

/**
 * Rotate `p` about `pivot` by `angle` degrees around `axis`, then translate.
 *
 * This is the viewer's formula — world = translate(T) ∘ rotateAbout(P, q) —
 * spelled out with plain trigonometry rather than borrowed from Three.js, so
 * agreement below is a check on the maths and not on a shared implementation.
 */
function predict(
  p: Triple,
  rot: { angle: number; axis: Triple; pivot: Triple } | undefined,
  t: Triple,
): Triple {
  let v: Triple = [...p];
  if (rot) {
    const [ax, ay, az] = normalise(rot.axis);
    const th = (rot.angle * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const d: Triple = [p[0] - rot.pivot[0], p[1] - rot.pivot[1], p[2] - rot.pivot[2]];
    // Rodrigues' rotation formula.
    const dot = ax * d[0] + ay * d[1] + az * d[2];
    const cross: Triple = [
      ay * d[2] - az * d[1],
      az * d[0] - ax * d[2],
      ax * d[1] - ay * d[0],
    ];
    v = [
      d[0] * c + cross[0] * s + ax * dot * (1 - c) + rot.pivot[0],
      d[1] * c + cross[1] * s + ay * dot * (1 - c) + rot.pivot[1],
      d[2] * c + cross[2] * s + az * dot * (1 - c) + rot.pivot[2],
    ];
  }
  return [v[0] + t[0], v[1] + t[1], v[2] + t[2]];
}

function normalise(v: Triple): Triple {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

async function centreAfter(req: Parameters<typeof computeTransformEdit>[1]): Promise<Triple> {
  const edit = computeTransformEdit(SOURCE, req);
  expect(edit.ok).toBe(true);
  if (!edit.ok) throw new Error(edit.reason);
  const r = await core.execute(applyEdits(SOURCE, edit.edits), undefined, {
    partStats: "full",
  });
  const com = r.parts[0]!.centerOfMass;
  expect(com).toBeDefined();
  return com as Triple;
}

const close = (got: Triple, want: Triple) => {
  for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i], 3);
};

describe("the manipulator's maths and the written call agree", () => {
  it("on a plain translate", async () => {
    const t: Triple = [12, -4, 7];
    close(await centreAfter({ partName: "block", translate: t }), predict(START, undefined, t));
  });

  it("on a turn about the origin", async () => {
    const rot = { angle: 90, axis: [0, 0, 1] as Triple, pivot: "origin" as TransformPivot };
    close(
      await centreAfter({ partName: "block", rotate: rot }),
      predict(START, { ...rot, pivot: [0, 0, 0] }, [0, 0, 0]),
    );
  });

  it("on a turn about the body's own centre", async () => {
    // The pivot a manipulator naturally offers: the gizmo sits on the body.
    // The file gets `block.boundingBox.center`, not these coordinates — so
    // this also checks that the expression evaluates to what the viewer used.
    const rot = { angle: 37, axis: [0, 0, 1] as Triple, pivot: "self" as TransformPivot };
    const got = await centreAfter({ partName: "block", rotate: rot });
    // Turning about its own centre must leave the centre exactly where it was.
    close(got, START);
    close(got, predict(START, { ...rot, pivot: START }, [0, 0, 0]));
  });

  it("on an off-axis turn about the body's centre", async () => {
    const rot = { angle: 55, axis: normalise([1, 1, 0]), pivot: "self" as TransformPivot };
    close(
      await centreAfter({ partName: "block", rotate: rot }),
      predict(START, { ...rot, pivot: START }, [0, 0, 0]),
    );
  });

  it("on a turn AND a move, in that order", async () => {
    // The order is the claim: rotate first, then translate. Swapping them
    // moves the block somewhere else entirely, so this test fails loudly if
    // the generated call is ever reordered.
    const rot = { angle: 90, axis: [0, 0, 1] as Triple, pivot: "origin" as TransformPivot };
    const t: Triple = [5, 5, 2];
    close(
      await centreAfter({ partName: "block", rotate: rot, translate: t }),
      predict(START, { ...rot, pivot: [0, 0, 0] }, t),
    );
  });

  it("and rotate-then-translate is NOT the same as translate-then-rotate", async () => {
    // Guards the test above from passing by coincidence on a symmetric case.
    const rot = { angle: 90, axis: [0, 0, 1] as Triple, pivot: [0, 0, 0] as Triple };
    const t: Triple = [5, 5, 2];
    const rotateFirst = predict(START, rot, t);
    const translateFirst = predict(
      [START[0] + t[0], START[1] + t[1], START[2] + t[2]],
      rot,
      [0, 0, 0],
    );
    expect(Math.hypot(...(rotateFirst.map((v, i) => v - translateFirst[i]!) as Triple)))
      .toBeGreaterThan(1);
  });
});

/**
 * The reason the pivot is an expression and not the coordinates the
 * manipulator measured.
 *
 * A frozen pivot is correct the day it is written and silently wrong the next
 * time a parameter moves the body — the same failure the face selectors exist
 * to avoid, and the one that is hardest to notice, because the file still
 * renders and the feature is still there, just in the wrong place.
 */
describe("a self-pivot survives the model changing", () => {
  /** The block's centre tracks `w`, so changing it moves the body. */
  const MOVING = `
import { drawRectangle } from "replicad";
const params = { w: 20, d: 10, t: 6 };
function main({ w, d, t }) {
  const block = drawRectangle(w, d).sketchOnPlane("XY").extrude(t).translate(w, 5, 0);
  return [{ shape: block, name: "block" }];
}
`;

  const centreOf = async (src: string, w: number): Promise<Triple> => {
    const r = await core.execute(src, { w }, { partStats: "full" });
    return r.parts[0]!.centerOfMass as Triple;
  };

  it("keeps turning about the body's own centre after a parameter moves it", async () => {
    const edit = computeTransformEdit(MOVING, {
      partName: "block",
      rotate: { angle: 90, axis: [0, 0, 1], pivot: "self" },
    });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const written = applyEdits(MOVING, edit.edits);
    expect(written).toContain("block.boundingBox.center");

    // Turning a body about its own centre never moves that centre — at the
    // width it was written for, and at one it was not.
    close(await centreOf(written, 20), [20, 5, 3]);
    close(await centreOf(written, 40), [40, 5, 3]);
  });

  it("whereas the coordinates the manipulator measured would drift", async () => {
    // The same rotation with the pivot frozen at the w = 20 centre. Correct at
    // w = 20 by construction; the point of the test is the second width.
    const frozen = MOVING.replace(
      "{ shape: block, name: \"block\" }",
      "{ shape: block.rotate(90, [20, 5, 3], [0, 0, 1]), name: \"block\" }",
    );
    close(await centreOf(frozen, 20), [20, 5, 3]);

    const drifted = await centreOf(frozen, 40);
    const away = Math.hypot(drifted[0] - 40, drifted[1] - 5, drifted[2] - 3);
    // 20 mm off, and nothing about the render would say so.
    expect(away).toBeGreaterThan(15);
  });
});
