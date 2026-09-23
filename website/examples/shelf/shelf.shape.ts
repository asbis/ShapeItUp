/**
 * Wall-mounted shelf — demo for `symmetricPair` and `Part.mirror`.
 *
 * Four parts:
 *   - wall plate  (flat panel against the wall at y=0, extending into -Y)
 *   - bracket L   (built at origin with a triangular gusset on +X)
 *   - bracket R   (mirror of L across the YZ plane — gusset lands on -X)
 *   - shelf       (flat top resting on both brackets)
 *
 * The asymmetric gusset is the key: `symmetricPair(bracket, "YZ")` returns
 * `[left, right]` where the right bracket is the LEFT-HANDED mirror twin,
 * not just a duplicate. Joint positions, joint axes, and the shape itself
 * are all reflected across the YZ plane.
 */

import { draw, drawRectangle } from "replicad";
import {
  assemble,
  entries,
  faceAt,
  mate,
  part,
  placeOn,
  shape3d,
  symmetricPair,
} from "shapeitup";

export const params = {
  wallWidth: 300,
  wallHeight: 100,
  wallThickness: 6,
  bracketDepth: 100,       // +Y extent of the horizontal leg
  bracketHeight: 100,      // Z extent of the vertical leg
  bracketThickness: 6,     // thickness of each L leg (along +Y and along +Z)
  bracketWidth: 10,        // X thickness of the whole bracket slab
  bracketOffset: 110,      // |X| of each bracket's wall-face centre
  shelfDepth: 110,         // Y extent of the shelf top
  shelfThickness: 10,
  shelfOverhang: 30,       // extra X on each side of the brackets
};

export default function main({
  wallWidth,
  wallHeight,
  wallThickness,
  bracketDepth,
  bracketHeight,
  bracketThickness,
  bracketWidth,
  bracketOffset,
  shelfDepth,
  shelfThickness,
  shelfOverhang,
}: typeof params) {
  // ── Wall plate ──────────────────────────────────────────────────────────
  // Occupies X ∈ [-W/2, W/2], Y ∈ [-T, 0], Z ∈ [0, H]. The +Y face is
  // what the brackets mate against.
  const wallShape = placeOn(
    drawRectangle(wallWidth, wallHeight),
    "XZ",
    { into: "-Y", distance: wallThickness },
  ).translate(0, 0, wallHeight / 2);

  const wall = part({
    shape: wallShape,
    name: "wall",
    color: "#7a8a9a",
    joints: {
      mountLeft:  faceAt(wallHeight / 2, { axis: "+Y", xy: [-bracketOffset, 0] }),
      mountRight: faceAt(wallHeight / 2, { axis: "+Y", xy: [ bracketOffset, 0] }),
    },
  });

  // ── Bracket (built at origin) ───────────────────────────────────────────
  // L-profile in YZ: vertical leg at Y ∈ [0, t], horizontal leg at
  // Z ∈ [H-t, H] across Y ∈ [0, D], fused with a diagonal gusset running
  // from the base (Y=D, Z=0) up to the inside corner (Y=t, Z=H-t). This
  // gives a handed, visually asymmetric profile that reads clearly as
  // "left" vs "right" after mirroring.
  //
  //   Z=H ┌──┬───────────┐   ← top of horizontal leg
  //       │  │           │
  //   Z=H-t│  └───────────┘   ← bottom of horizontal leg
  //       │  ╲
  //       │   ╲ gusset
  //       │    ╲
  //       │     ╲
  //   Z=0 │______╲_________
  //       Y=0    Y=t      Y=D
  const t = bracketThickness;
  const H = bracketHeight;
  const D = bracketDepth;
  const bracketProfile = draw([0, 0])
    .hLine(D)                  // bottom edge to gusset tip at (D, 0)
    .lineTo([t, H - t])        // diagonal up-and-back to inside corner
    .lineTo([D, H - t])        // under the horizontal leg, out to its tip
    .vLine(t)                  // right edge of horizontal-leg tip
    .lineTo([0, H])            // top of horizontal leg, ending at wall side
    .close();                  // wall-side edge down to start
  // Extrude along X by `bracketWidth`, offset so the slab sits on +X
  // (X ∈ [0, bracketWidth]). The bracket's wall-side JOINT plane sits at
  // X=0 (the slab's inside face). Mirroring across YZ flips the slab to
  // -X — the mirrored bracket is the left-handed twin.
  const bracketSolid = shape3d(
    bracketProfile.sketchOnPlane("YZ", [0, 0, 0]).extrude(bracketWidth),
  );

  const bracket = part({
    shape: bracketSolid,
    name: "bracket",
    color: "#b58b4a",
    joints: {
      // Wall-side face at mid-height of the vertical leg. Axis -Y mates
      // against the wall's +Y mount faces. xy picked so the joint lies on
      // the slab mid-plane along X (the bracket's geometric centre).
      wallFace: faceAt(H / 2, {
        axis: "-Y",
        xy: [bracketWidth / 2, 0],
      }),
      // Top face mid-way along the horizontal leg; axis +Z mates against
      // the shelf's -Z underside.
      shelfFace: faceAt(H, {
        axis: "+Z",
        xy: [bracketWidth / 2, D / 2],
      }),
    },
  });

  // ── Symmetric pair: left (original) + right (mirrored across YZ) ────────
  // `leftSuffix`/`rightSuffix` disambiguate joint names so the four mates
  // below never alias across parts.
  const [bracketL, bracketR] = symmetricPair(bracket, "YZ", {
    leftSuffix: "L",
    rightSuffix: "R",
  });

  // ── Shelf ───────────────────────────────────────────────────────────────
  // Built at origin: X ∈ [-Wshelf/2, Wshelf/2], Y ∈ [0, shelfDepth],
  // Z ∈ [0, shelfThickness]. Bottom face (axis -Z) hosts both bracket tops.
  const shelfWidth = 2 * (bracketOffset + bracketWidth / 2 + shelfOverhang);
  const shelfShape = shape3d(
    drawRectangle(shelfWidth, shelfDepth)
      .sketchOnPlane("XY", [0, shelfDepth / 2, 0])
      .extrude(shelfThickness),
  );
  const shelf = part({
    shape: shelfShape,
    name: "shelf",
    color: "#d0c08a",
    joints: {
      onBracketL: faceAt(0, { axis: "-Z", xy: [-bracketOffset, D / 2] }),
      onBracketR: faceAt(0, { axis: "-Z", xy: [ bracketOffset, D / 2] }),
    },
  });

  // ── Assembly ────────────────────────────────────────────────────────────
  // Wall is the fixed root. Each bracket mates to the wall; the shelf mates
  // to each bracket. The second shelf-to-bracket mate is geometrically
  // redundant (brackets are already positioned by the wall mates) but left
  // in so the graph is declarative — `assemble()` uses the first and
  // silently ignores over-constraints.
  const positioned = assemble(
    [wall, bracketL, bracketR, shelf],
    [
      mate(wall.joints.mountLeft,       bracketL.joints.wallFaceL),
      mate(wall.joints.mountRight,      bracketR.joints.wallFaceR),
      mate(bracketL.joints.shelfFaceL,  shelf.joints.onBracketL),
      mate(bracketR.joints.shelfFaceR,  shelf.joints.onBracketR),
    ],
  );

  return entries(positioned);
}
