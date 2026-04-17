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
