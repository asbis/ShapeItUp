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
import { screws, bolts, washers, inserts, seatedOnPlate } from "./fasteners";
import { fromBack, shape3d, placeOn, extrudeCentered } from "./placement";
import { Part, joint, part, faceAt, shaftAt, boreAt } from "./parts";
import { mate, assemble, subassembly, stackOnZ, entries, symmetricPair, debugJoints, highlightJoints, composeAssembly } from "./assembly";
import { cylinder, rod } from "./cylinder";
import { box, prism, plate } from "./shapes";
// `plates` is a small namespace containing the plate-shaped helper(s). Kept
// separate from the top-level `plate` export so user scripts can reach either
// (`plates.plate({...})` mirrors `holes.through(...)` / `motors.nema17()`).
const plates = { plate };
import * as motors from "./motors";
import * as couplers from "./couplers";
import * as threads from "./threads";
import * as gears from "./gears";
import * as pins from "./pins";
import * as cradles from "./cradles";
import * as standardsRaw from "./standards";
import { guardUnknownKeys } from "./standards";
import { ensureFinderAndPatched } from "./finder-patch";
import { ensureThreadGuardPatched } from "./threads-patch";

// Patch Replicad's EdgeFinder/FaceFinder `.and()` to accept a single callback
// in addition to the documented array form. Idempotent, safe to call before
// OCCT is loaded (the patch only mutates class prototypes on the replicad
// module). See finder-patch.ts for the full rationale.
ensureFinderAndPatched();

// Patch `_3DShape.prototype.fuse` / `.cut` to throw at call time (with a clear
// message naming the fuse-safe alternatives) when either operand is a
// non-fuse-safe thread Compound. Idempotent; sibling of the finder patch.
// See threads-patch.ts for the full rationale.
ensureThreadGuardPatched();

// Re-export the MetricSize union so user scripts can write
// `import type { MetricSize } from "shapeitup"` instead of digging into the
// standards namespace. Supported sizes: "M2" | "M2.5" | "M3" | "M4" | "M5" |
// "M6" | "M8" | "M10" | "M12" — see standards.ts for the source tables.
export type { MetricSize, FitStyle } from "./standards";

// User-facing view of the standards namespace. Unknown-key reads throw with
// a did-you-mean suggestion so `standards.NEMA17.pilotDiameter` (typo for
// `pilotDia`) fails fast instead of returning undefined and propagating as
// NaN into the next OCCT call. Internal stdlib code imports directly from
// `./standards` and bypasses this guard.
//
// Note: we copy the module-namespace object into a plain object before
// wrapping. Proxy over a Module Namespace Object fails the [[Get]]
// invariant (the spec requires returning the exact property value for
// frozen exports), so the wrap has to operate on a mutable copy.
const standards = guardUnknownKeys({ ...standardsRaw }, "standards");

export { standards };

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
  bolts,
  washers,
  inserts,
  fromBack,
  shape3d,
  placeOn,
  extrudeCentered,
  seatedOnPlate,
  Part,
  joint,
  part,
  faceAt,
  shaftAt,
  boreAt,
  mate,
  assemble,
  subassembly,
  stackOnZ,
  entries,
  symmetricPair,
  debugJoints,
  highlightJoints,
  composeAssembly,
  cylinder,
  rod,
  box,
  prism,
  plate,
  plates,
  motors,
  couplers,
  threads,
  gears,
  pins,
  cradles,
};

/**
 * The single runtime object that user scripts destructure from. Keep keys
 * stable — they become the namespace the user types (`holes.through(...)`).
 */
export const shapeitupStdlib = {
  holes,
  screws,
  bolts,
  washers,
  inserts,
  printHints,
  bearings,
  extrusions,
  patterns,
  fromBack,
  shape3d,
  placeOn,
  extrudeCentered,
  seatedOnPlate,
  Part,
  joint,
  part,
  faceAt,
  shaftAt,
  boreAt,
  mate,
  assemble,
  subassembly,
  stackOnZ,
  entries,
  symmetricPair,
  debugJoints,
  highlightJoints,
  composeAssembly,
  cylinder,
  rod,
  box,
  prism,
  plate,
  plates,
  motors,
  couplers,
  threads,
  gears,
  pins,
  cradles,
  standards,
};

export type ShapeitupStdlib = typeof shapeitupStdlib;
