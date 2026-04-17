/**
 * T-slot aluminum extrusion profiles — 2020, 3030, 4040.
 *
 * `extrusions.tSlot("2020", length)` returns a length of extrusion as a
 * Shape3D (for visualization + mounting reference).
 * `extrusions.tSlotProfile("2020")` returns the 2D Drawing for users who
 * want to sketch against it.
 *
 * The profile is a **simplified quad-slot square with a center hole**: four
 * rectangular slot openings (one centered on each side, `slotWidth` wide and
 * `slotDepth` deep) plus the axial center-hole. The real internal T-cavity
 * (where roll-in nuts seat) is *not* modelled — good enough for visualization,
 * mounting-reference, and print-in-place spacer work. Use a parametric model
 * if you need true nut-slot geometry.
 */

import {
  drawRectangle,
  drawRoundedRectangle,
  drawCircle,
  type Drawing,
  type Shape3D,
} from "replicad";
import { T_SLOT_EXTRUSION } from "./standards";

/** Clearance (mm) per side for {@link tSlotChannel}. Tuned for FDM — brackets
 *  slide cleanly over the profile without jamming. */
const CHANNEL_CLEARANCE_PER_SIDE = 0.2;
/** Outer-corner radius (mm). Real 20-series extrusions chamfer their edges
 *  with ~1mm radius; this keeps the viewer render clean and avoids sharp
 *  corner artifacts in downstream booleans. */
const OUTER_CORNER_RADIUS = 1.0;

function extrusionSpec(designation: string) {
  const spec = T_SLOT_EXTRUSION[designation];
  if (!spec) {
    const avail = Object.keys(T_SLOT_EXTRUSION).join(", ");
    throw new Error(
      `Unknown T-slot extrusion "${designation}". Available: ${avail}`
    );
  }
  return spec;
}

/**
 * 2D cross-section profile as a Drawing — for users who want to sketch
 * features aligned with the extrusion cross-section. Centered on the origin
 * in XY, ready for `.sketchOnPlane(...)`.
 *
 * v1 simplification: four rectangular slot cut-outs + axial center hole. No
 * internal T-cavity. Suitable for mounting-reference and visualization.
 *
 * @param designation Profile code from T_SLOT_EXTRUSION (e.g. `"2020"`).
 * @returns Drawing centered at the origin, axis-aligned with X/Y.
 */
export function tSlotProfile(designation: string): Drawing {
  const spec = extrusionSpec(designation);
  const { size, slotWidth, slotDepth, centerHole } = spec;

  // Outer square with a small corner radius (more robust than a hard square
  // when users later fuse features to the profile).
  let profile = drawRoundedRectangle(size, size, OUTER_CORNER_RADIUS);

  // Four slot openings: rectangle slotWidth × slotDepth, centered on each
  // side of the square. "Centered on the side" means one edge sits flush
  // with the outer edge; we position the rectangle so slotDepth extends
  // inward from the edge.
  const halfSize = size / 2;
  const slotOffset = halfSize - slotDepth / 2;

  // Top (+Y) and bottom (-Y) — rectangle is slotWidth (x) × slotDepth (y).
  const topSlot = drawRectangle(slotWidth, slotDepth).translate(0, slotOffset);
  const bottomSlot = drawRectangle(slotWidth, slotDepth).translate(
    0,
    -slotOffset
  );
  // Right (+X) and left (-X) — swap dimensions.
  const rightSlot = drawRectangle(slotDepth, slotWidth).translate(
    slotOffset,
    0
  );
  const leftSlot = drawRectangle(slotDepth, slotWidth).translate(
    -slotOffset,
    0
  );

  profile = profile.cut(topSlot);
  profile = profile.cut(bottomSlot);
  profile = profile.cut(rightSlot);
  profile = profile.cut(leftSlot);

  // Central axial hole.
  profile = profile.cut(drawCircle(centerHole / 2));

  return profile;
}

/**
 * T-slot aluminum extrusion body as a Shape3D. Cross-section is the
 * {@link tSlotProfile} for `designation`; extrudes along +Z for `length` mm
 * starting at Z=0. Users translate/rotate as needed.
 *
 * @param designation Profile code (e.g. `"2020"`, `"3030"`, `"4040"`).
 * @param length Axial length in mm (extrusion along +Z).
 * @returns Shape3D of the extrusion profile extruded to `length`.
 */
export function tSlot(designation: string, length: number): Shape3D {
  if (!(length > 0)) {
    throw new Error(
      `extrusions.tSlot: length must be positive, got ${length}`
    );
  }
  return tSlotProfile(designation)
    .sketchOnPlane("XY")
    .extrude(length) as Shape3D;
}

/**
 * Cut-tool matching the extrusion's outer envelope — a rectangular box
 * sized `(size + 2·clearance) × (size + 2·clearance) × length`. Useful for
 * carving a sliding channel into a bracket so it fits over a profile.
 *
 * Placed at the origin extending into +Z. 0.2mm clearance per side (0.4mm
 * total) so brackets slide over the profile without jamming on typical FDM
 * tolerances.
 *
 * @param designation Profile code (e.g. `"2020"`).
 * @param length Channel length in mm (extrudes along +Z).
 * @returns Shape3D cut-tool.
 */
export function tSlotChannel(designation: string, length: number): Shape3D {
  if (!(length > 0)) {
    throw new Error(
      `extrusions.tSlotChannel: length must be positive, got ${length}`
    );
  }
  const spec = extrusionSpec(designation);
  const side = spec.size + CHANNEL_CLEARANCE_PER_SIDE * 2;
  return drawRectangle(side, side).sketchOnPlane("XY").extrude(length) as Shape3D;
}
