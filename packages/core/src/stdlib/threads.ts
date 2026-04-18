/**
 * Thread builders — helical-swept triangular or trapezoidal profiles fused
 * onto (external) or cut from (internal) a base cylinder.
 *
 * Scope: VISUAL fidelity for STEP export + rendering. The profiles are
 * geometrically accurate (60° metric V, 30° trapezoidal) but the helical
 * sweep in OCCT is expensive — a 20mm M3 bolt with 0.5mm pitch adds ~3000
 * triangles. For parts that only need to LOOK threaded, the cylinder-based
 * `cylinder()` factory without threads is far cheaper.
 *
 * For FDM 3D printing, small threads (M2–M5) generally don't survive a
 * nozzle pass reliably — use `inserts.pocket` + heat-set inserts instead.
 * Threads are most useful for M8+, leadscrews, jar lids, and STEP export
 * to machine-shop workflows.
 */

import {
  draw,
  makeCylinder,
  sketchHelix,
  type Plane,
  type Point,
  type Shape3D,
  type Sketch,
} from "replicad";
import {
  METRIC_COARSE_PITCH,
  METRIC_FINE_PITCH,
  TRAPEZOIDAL_LEADSCREW,
  type MetricSize,
} from "./standards";

// ── Low-level primitives ────────────────────────────────────────────────────

export interface ThreadProfile {
  /** Peak-to-valley depth of the thread (radial). */
  depth: number;
  /** Axial distance the profile occupies at the base (≤ pitch). */
  baseWidth: number;
  /** Axial distance the profile occupies at the crest (for trapezoidal
   *  profiles; 0 = V-thread, ~0.366 × pitch = ISO metric). */
  crestWidth: number;
}

/**
 * ISO metric V-thread profile (60° included). Depth ≈ 0.541 × pitch, crest
 * is slightly flattened per ISO 68.
 */
export function metricProfile(pitch: number): ThreadProfile {
  // ISO 68 metric: H = pitch × √3/2; depth = 5/8 × H ≈ 0.5413 × pitch.
  return {
    depth: 0.5413 * pitch,
    baseWidth: pitch,
    crestWidth: pitch / 8,
  };
}

/**
 * ACME/trapezoidal profile (30° flank angle). Deeper and more tolerant of
 * wear than ISO metric; used for leadscrews.
 */
export function trapezoidalProfile(pitch: number): ThreadProfile {
  // Trapezoidal depth = 0.5 × pitch; crest width ≈ 0.366 × pitch.
  return {
    depth: 0.5 * pitch,
    baseWidth: pitch,
    crestWidth: pitch * 0.366,
  };
}

export interface ExternalThreadOpts {
  /** Nominal major diameter (outermost thread crest). */
  diameter: number;
  /** Thread pitch (mm). */
  pitch: number;
  /** Thread length along +Z. */
  length: number;
  /** Profile selector. Default: metric V. */
  profile?: ThreadProfile;
  /** Number of thread starts (2+ for multi-start leadscrews). Default 1. */
  starts?: number;
}

/**
 * Build an externally-threaded rod. Returns a Shape3D along +Z with the
 * base cylinder's axis on the Z axis. Z ∈ [0, length].
 *
 * Implementation: sweep the axial cross-section of the thread peak along a
 * helical spine, then fuse onto a base cylinder sized to the thread's ROOT.
 */
export function external(opts: ExternalThreadOpts): Shape3D {
  const profile = opts.profile ?? metricProfile(opts.pitch);
  const starts = opts.starts ?? 1;
  const majorR = opts.diameter / 2;
  const minorR = majorR - profile.depth;

  // Base cylinder sized to minor (root) diameter.
  const root = makeCylinder(minorR, opts.length, [0, 0, 0], [0, 0, 1]);

  // Helical sweep — one helix per start. The helix radius is at the MEAN
  // thread diameter so the swept profile straddles the root cylinder on
  // both sides. For multi-start threads we rotate the RESULTING sweep
  // (Sketches don't have .rotate, but Shape3Ds do).
  const meanR = (majorR + minorR) / 2;
  const basePass = sweepThreadPass(profile, opts.pitch, opts.length, meanR);
  let threaded: Shape3D = root.fuse(basePass);
  for (let start = 1; start < starts; start++) {
    const angleDeg = (start * 360) / starts;
    const rotated = basePass.rotate(angleDeg, [0, 0, 0], [0, 0, 1]);
    threaded = threaded.fuse(rotated);
  }
  return threaded;
}

/** Build one swept thread pass (single start) along +Z. */
function sweepThreadPass(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  meanRadius: number
): Shape3D {
  const spine = sketchHelix(pitch, length, meanRadius);
  return spine.sweepSketch(
    (plane, origin) => profileSketchAtHelix(profile, plane, origin),
    { frenet: true }
  );
}

export interface InternalThreadOpts {
  /** Minor (inner) diameter — the bore the shaft passes through. */
  diameter: number;
  pitch: number;
  length: number;
  profile?: ThreadProfile;
  starts?: number;
}

/**
 * Build an internally-threaded hole as a cut-tool. Returns a Shape3D that
 * you cut from your part: `plate.cut(threads.internal({...}).translate(x, y, plateTop))`.
 *
 * Matches the stdlib cut-tool convention: top at Z=0, extends into -Z.
 */
export function internal(opts: InternalThreadOpts): Shape3D {
  const profile = opts.profile ?? metricProfile(opts.pitch);
  const starts = opts.starts ?? 1;
  const minorR = opts.diameter / 2;
  const majorR = minorR + profile.depth;

  // Through-hole sized to MAJOR (outer) diameter — the thread's CREST is
  // where the shaft's outer diameter will run.
  // Extended slightly below Z=0 so the cut is clean.
  const clearance = makeCylinder(
    majorR,
    opts.length + 0.2,
    [0, 0, -opts.length - 0.1],
    [0, 0, 1]
  );

  // For internal threads, the profile is the same but it gets FUSED into the
  // shaft (NOT cut) because we want the cut tool's final shape to be the
  // UNION of the bore and the thread ridges — the ridges are where material
  // REMAINS AFTER cutting, so they must be INSIDE the cut tool.
  // Hmm actually simpler: the cut tool just needs to be the OUTER envelope
  // of the tapped hole. Use the clearance cylinder alone for a clean bore.
  // For the threaded LOOK, also add the spiral groove ridges.
  const meanR = (majorR + minorR) / 2;
  let tool: Shape3D = clearance;
  const basePass = sweepThreadPass(profile, opts.pitch, opts.length, meanR).translate(
    0,
    0,
    -opts.length
  );
  // Subtract ridges so cut(tool) leaves thread ridges INSIDE the bore.
  tool = tool.cut(basePass);
  for (let start = 1; start < starts; start++) {
    const angleDeg = (start * 360) / starts;
    const rotated = basePass.rotate(angleDeg, [0, 0, 0], [0, 0, 1]);
    tool = tool.cut(rotated);
  }
  return tool;
}

/**
 * Build the thread cross-section on the plane normal to the helix tangent.
 * The profile is a triangle (V-thread) or trapezoid, with its base along
 * the local X axis (parallel to the helix radius) and apex pointing +X
 * (radially outward — into crest territory for external threads).
 */
function profileSketchAtHelix(
  profile: ThreadProfile,
  plane: Plane,
  origin: Point
): Sketch {
  const { depth, baseWidth, crestWidth } = profile;
  // Sketch in local 2D. Local X ≈ axial direction (along helix tangent
  // projected), local Y ≈ radial direction. Actually after the Frenet
  // frame is applied: the profile's axes are relative to the plane replicad
  // supplies. Draw a trapezoid whose base sits on local X from -baseWidth/2
  // to +baseWidth/2 at Y=0, and whose crest sits at Y=depth from
  // -crestWidth/2 to +crestWidth/2.
  const d = draw([-baseWidth / 2, 0])
    .hLine(baseWidth)                          // base
    .lineTo([crestWidth / 2, depth])           // right flank
    .hLine(-crestWidth)                         // crest
    .lineTo([-baseWidth / 2, 0])               // left flank
    .close();
  // Drawing.sketchOnPlane types as `SketchInterface | Sketches`; runtime
  // always returns a Sketch for a single closed profile.
  return d.sketchOnPlane(plane as any, origin) as unknown as Sketch;
}

// ── High-level convenience factories ───────────────────────────────────────

export interface MetricThreadOpts {
  /** "coarse" (default) or "fine" ISO pitch, or a custom pitch in mm. */
  pitch?: "coarse" | "fine" | number;
  /** Number of thread starts. Default 1. */
  starts?: number;
}

/**
 * Build an externally-threaded metric rod for standard M-sizes.
 *
 *   const bolt = threads.metric("M5", 20);         // M5 × 20mm, coarse pitch
 *   const fine = threads.metric("M5", 20, { pitch: "fine" });
 *   const custom = threads.metric("M6", 30, { pitch: 1.5 });
 */
export function metric(
  size: MetricSize,
  length: number,
  opts: MetricThreadOpts = {}
): Shape3D {
  const pitch = resolveMetricPitch(size, opts.pitch);
  return external({
    diameter: asMetricDiameter(size),
    pitch,
    length,
    profile: metricProfile(pitch),
    starts: opts.starts ?? 1,
  });
}

/**
 * Build an internally-threaded hole cut-tool for a standard M-size.
 * Use to create a tapped hole in a plate.
 */
export function tapHole(
  size: MetricSize,
  depth: number,
  opts: MetricThreadOpts = {}
): Shape3D {
  const pitch = resolveMetricPitch(size, opts.pitch);
  return internal({
    diameter: asMetricDiameter(size) - 0.1, // slight undersize for a press-tap feel
    pitch,
    length: depth,
    profile: metricProfile(pitch),
    starts: opts.starts ?? 1,
  });
}

/**
 * Build a trapezoidal leadscrew (TR8x2, TR8x8, TR10x2, TR12x2, TR12x4).
 *
 *   const leadscrew = threads.leadscrew("TR8x8", 150);
 */
export function leadscrew(designation: string, length: number): Shape3D {
  const spec = TRAPEZOIDAL_LEADSCREW[designation];
  if (!spec) {
    const avail = Object.keys(TRAPEZOIDAL_LEADSCREW).join(", ");
    throw new Error(`Unknown trapezoidal leadscrew "${designation}". Available: ${avail}`);
  }
  return external({
    diameter: spec.majorDia,
    pitch: spec.pitch,
    length,
    profile: trapezoidalProfile(spec.pitch),
    starts: spec.starts,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveMetricPitch(size: MetricSize, pitch: MetricThreadOpts["pitch"]): number {
  if (typeof pitch === "number") return pitch;
  if (pitch === "fine") return METRIC_FINE_PITCH[size];
  return METRIC_COARSE_PITCH[size];
}

function asMetricDiameter(size: MetricSize): number {
  // M3 → 3mm, M4 → 4mm etc. "M2.5" → 2.5.
  return parseFloat(size.slice(1));
}
