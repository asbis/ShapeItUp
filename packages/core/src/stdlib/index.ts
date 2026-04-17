/**
 * @shapeitup/core stdlib — user-facing helpers importable from .shape.ts
 * files via `import { holes, screws, ... } from "shapeitup"`.
 *
 * The executor rewrites that import to destructure from the object exported
 * here (`shapeitupStdlib`).
 */

import * as holes from "./holes";
import * as printHints from "./printHints";
import * as bearings from "./bearings";
import * as extrusions from "./extrusions";
import * as patterns from "./patterns";
import { screws, nuts, washers, inserts } from "./fasteners";
import { fromBack, shape3d } from "./placement";
import { Part, joint, part, faceAt, shaftAt, boreAt } from "./parts";
import { mate, assemble, stackOnZ, entries, debugJoints, highlightJoints } from "./assembly";
import { cylinder } from "./cylinder";
import * as motors from "./motors";
import * as couplers from "./couplers";

export * as standards from "./standards";

// Top-level named re-exports — user scripts type
// `import { holes, screws } from "shapeitup"` and the TypeScript service
// needs these to resolve. The runtime executor separately rewrites that
// import to destructure from `shapeitupStdlib` below.
export {
  holes,
  printHints,
  bearings,
  extrusions,
  patterns,
  screws,
  nuts,
  washers,
  inserts,
  fromBack,
  shape3d,
  Part,
  joint,
  part,
  faceAt,
  shaftAt,
  boreAt,
  mate,
  assemble,
  stackOnZ,
  entries,
  debugJoints,
  highlightJoints,
  cylinder,
  motors,
  couplers,
};

/**
 * The single runtime object that user scripts destructure from. Keep keys
 * stable — they become the namespace the user types (`holes.through(...)`).
 */
export const shapeitupStdlib = {
  holes,
  screws,
  nuts,
  washers,
  inserts,
  printHints,
  bearings,
  extrusions,
  patterns,
  fromBack,
  shape3d,
  Part,
  joint,
  part,
  faceAt,
  shaftAt,
  boreAt,
  mate,
  assemble,
  stackOnZ,
  entries,
  debugJoints,
  highlightJoints,
  cylinder,
  motors,
  couplers,
};

export type ShapeitupStdlib = typeof shapeitupStdlib;
