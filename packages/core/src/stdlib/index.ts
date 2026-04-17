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
import { screws, nuts, washers, inserts } from "./fasteners";

export * as standards from "./standards";

// Top-level named re-exports — user scripts type
// `import { holes, screws } from "shapeitup"` and the TypeScript service
// needs these to resolve. The runtime executor separately rewrites that
// import to destructure from `shapeitupStdlib` below.
export { holes, printHints, bearings, extrusions, screws, nuts, washers, inserts };

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
};

export type ShapeitupStdlib = typeof shapeitupStdlib;
