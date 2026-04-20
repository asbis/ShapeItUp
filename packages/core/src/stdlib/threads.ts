/**
 * Thread builders — production-grade helical threads via the build123d
 * algorithm: one small loft per turn, clone for subsequent turns, return
 * as a Compound (no fuse).
 *
 * Why this layout:
 *   - OCCT's `BRepOffsetAPI_ThruSections` with smoothing (`ruled: false`)
 *     does a global variational B-spline fit whose cost is super-linear
 *     in section count. One 12-section loft is fast; one 145-section loft
 *     times out (>15s).
 *   - Fusing N turns pairwise is also super-linear (each fuse grows the
 *     operand). build123d sidesteps this by building ONE turn solid and
 *     cloning it; turns remain separate Solids in a Compound.
 *   - A small radial `interference` overlap between thread turns and the
 *     root cylinder makes the un-fused compound render as one continuous
 *     piece and guarantees clean booleans when users eventually fuse.
 *
 * References: build123d `bd_warehouse/thread.py` `_make_thread_loop`, OCCT
 * ThruSections complexity docs, replicad issue #223.
 */

import {
  draw,
  getManifold,
  loft,
  makeCompound,
  makeCylinder,
  MeshShape,
  Plane,
  type Point,
  type Shape3D,
  type Sketch,
  type Wire,
} from "replicad";
import {
  METRIC_COARSE_PITCH,
  METRIC_FINE_PITCH,
  TRAPEZOIDAL_LEADSCREW,
  assertSupportedSize,
  type MetricSize,
} from "./standards";

// ── Profiles ───────────────────────────────────────────────────────────────

export interface ThreadProfile {
  /** Peak-to-valley depth of the thread (radial). */
  depth: number;
  /** Axial distance the profile occupies at the base (≤ pitch). */
  baseWidth: number;
  /** Axial distance the profile occupies at the crest (for trapezoidal
   *  profiles; 0 = V-thread, ~0.366 × pitch = ISO metric). */
  crestWidth: number;
}

/** ISO 68 metric V-thread (60° included). Depth = 5H/8 where H = P·√3/2. */
export function metricProfile(pitch: number): ThreadProfile {
  return {
    depth: 0.5413 * pitch,
    baseWidth: pitch,
    crestWidth: pitch / 8,
  };
}

/** ACME / trapezoidal (30° flank angle). Deeper; used for leadscrews. */
export function trapezoidalProfile(pitch: number): ThreadProfile {
  return {
    depth: 0.5 * pitch,
    baseWidth: pitch,
    crestWidth: pitch * 0.366,
  };
}

// ── Thread mesh cache (N2 perf optimization) ───────────────────────────────

/**
 * Cache of fused externally-threaded rod MeshShapes, keyed by geometric
 * parameters. Populated by {@link buildExternalRodMesh} (the bottleneck in
 * `threads.fuseThreaded` during `tune_params` sweeps).
 *
 * Why this is safe:
 *   - Replicad's MeshShape transforms (`fuse`, `translate`, `cut`, …) CONSUME
 *     their input (see Manifold WASM semantics). Handing the same cached
 *     handle to two callers would cause a use-after-free the moment either
 *     of them transforms or deletes it.
 *   - We therefore always `.clone()` before handoff AND clone before storing.
 *     The cache owns a canonical copy; callers own independent copies they
 *     can freely transform or delete.
 *   - Cache lifetime is the worker/process lifetime. OCCT/Manifold state
 *     survives across `core.execute()` calls (cleanup() only deletes the
 *     previous run's top-level parts; the Manifold kernel itself stays
 *     warm). The cache is a module-level Map that dies with the worker,
 *     which is the correct reset boundary.
 *
 * Win: a tune_params sweep over a knob with `threads.fuseThreaded(head, "M8",
 * 30, …)` spends ~3.2s per iteration in `buildExternalRodMesh` (OCCT cylinder
 * meshing + per-start Manifold fuses). With this cache, only the first
 * iteration pays that cost; subsequent iterations pay a single .clone().
 */
const threadMeshCache = new Map<string, MeshShape>();

function makeThreadCacheKey(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  starts: number,
  threadType: "metric" | "trapezoidal",
): string {
  const profileKey = `${profile.depth.toFixed(6)}_${profile.baseWidth.toFixed(6)}_${profile.crestWidth.toFixed(6)}`;
  return `${profileKey}|${pitch.toFixed(6)}|${length.toFixed(6)}|${starts}|${threadType}`;
}

/**
 * Clear the thread mesh cache. Intended to be called when the underlying
 * WASM kernel is reset (worker restart) so we don't hand out stale FFI
 * handles that point into freed Manifold memory. Called opportunistically;
 * not wired into `core.execute()`'s cleanup because that would defeat the
 * cache's main win (survival across `tune_params` sweep iterations).
 */
export function clearThreadMeshCache(): void {
  for (const shape of threadMeshCache.values()) {
    try {
      shape.delete?.();
    } catch {
      /* best-effort: stale handles are already gone after WASM reset */
    }
  }
  threadMeshCache.clear();
}

// ── Core geometry ──────────────────────────────────────────────────────────

/**
 * Samples per full turn in each loft. build123d uses 11; 12 is our default
 * (one section every 30°). Increasing past 16 slows the per-turn loft
 * super-linearly with no visible gain.
 */
const SAMPLES_PER_TURN = 12;

/**
 * Radial interference (mm) between the thread profile base and the root
 * cylinder. Chosen empirically to (a) eliminate visible gaps when the
 * unfused compound is rendered and (b) guarantee robust booleans if users
 * later fuse the thread with their own geometry.
 */
const INTERFERENCE = 0.1;

/**
 * Build one cross-section wire at (θ, z) on a helix of radius `rootRadius`.
 *
 * Plane:
 *   origin = point on helix
 *   normal = helix tangent (unit)
 *   xDir   = global +Z projected into the plane (stable axial-ish axis)
 *
 * Profile (2D on plane):
 *   local X = axial along screw axis
 *   local Y = radial (outward for external, inward for internal)
 *   base at Y = -INTERFERENCE (slightly inside root)
 *   crest at Y = ±depth
 */
function crossSectionWire(
  profile: ThreadProfile,
  pitch: number,
  rootRadius: number,
  theta: number,
  z: number,
  external: boolean,
): Wire {
  const axialRate = pitch / (2 * Math.PI);

  const origin: Point = [
    rootRadius * Math.cos(theta),
    rootRadius * Math.sin(theta),
    z,
  ];

  const tx = -rootRadius * Math.sin(theta);
  const ty = rootRadius * Math.cos(theta);
  const tz = axialRate;
  const tMag = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const nx = tx / tMag;
  const ny = ty / tMag;
  const nz = tz / tMag;
  const normal: Point = [nx, ny, nz];

  const px = -nz * nx;
  const py = -nz * ny;
  const pz = 1 - nz * nz;
  const pMag = Math.sqrt(px * px + py * py + pz * pz);
  const xDir: Point = [px / pMag, py / pMag, pz / pMag];

  const plane = new Plane(origin, xDir, normal);

  const { depth, baseWidth, crestWidth } = profile;
  const sign = external ? 1 : -1;
  const baseY = -INTERFERENCE * sign;
  const crestY = depth * sign;

  const sketch = draw([-baseWidth / 2, baseY])
    .hLine(baseWidth)
    .lineTo([crestWidth / 2, crestY])
    .hLine(-crestWidth)
    .lineTo([-baseWidth / 2, baseY])
    .close()
    .sketchOnPlane(plane) as Sketch;

  return sketch.wire;
}

/** Build ONE turn (or fractional turn) as a single small loft. */
function makeThreadLoop(
  profile: ThreadProfile,
  pitch: number,
  rootRadius: number,
  sweepAngle: number,
  startZ: number,
  external: boolean,
  samplesPerTurn: number,
  ruled: boolean,
): Shape3D {
  const samples = Math.max(
    3,
    Math.ceil((samplesPerTurn * sweepAngle) / (2 * Math.PI)) + 1,
  );
  const axialRate = pitch / (2 * Math.PI);

  const wires: Wire[] = [];
  for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const theta = u * sweepAngle;
    const z = startZ + u * sweepAngle * axialRate;
    wires.push(crossSectionWire(profile, pitch, rootRadius, theta, z, external));
  }
  return loft(wires, { ruled });
}

/**
 * Build the full thread as a list of turn Solids. The first turn is lofted;
 * remaining full turns are `clone()`d + translated (no re-lofting). A
 * fractional final turn is lofted fresh if the length isn't a pitch multiple.
 */
function buildThreadLoops(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  rootRadius: number,
  external: boolean,
  samplesPerTurn = SAMPLES_PER_TURN,
  ruled = false,
): Shape3D[] {
  const turns = length / pitch;
  const fullTurns = Math.floor(turns);
  const fracTurn = turns - fullTurns;

  const loops: Shape3D[] = [];
  if (fullTurns >= 1) {
    const base = makeThreadLoop(
      profile, pitch, rootRadius, 2 * Math.PI, 0, external, samplesPerTurn, ruled,
    );
    loops.push(base);
    for (let k = 1; k < fullTurns; k++) {
      loops.push(base.clone().translate(0, 0, k * pitch));
    }
  }
  if (fracTurn > 0.01) {
    const partial = makeThreadLoop(
      profile, pitch, rootRadius, fracTurn * 2 * Math.PI, fullTurns * pitch,
      external, samplesPerTurn, ruled,
    );
    loops.push(partial);
  }
  return loops;
}

// ── External threads (bolts, leadscrews) ───────────────────────────────────

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
 * Build an externally-threaded rod. Z ∈ [0, length], axis on +Z.
 *
 * Returns a Compound of the root cylinder + each thread turn as separate
 * Solids. They overlap by INTERFERENCE mm so the compound looks continuous;
 * nothing is fused (fusing is the slow path).
 *
 * **Returns a Compound. Not fuse-safe.** OCCT's boolean fuse cannot cleanly
 * merge the per-turn loops with another solid — the result will fail
 * BRepCheck with non-manifold seams. For `head.fuse(thread)` workflows, use
 * the Manifold-based {@link metricMesh} / {@link fuseThreaded} (which
 * return a fuse-safe `MeshShape`). The Compound form is appropriate for
 * multi-part STEP export where threads render as a distinct named part.
 */
export function external(opts: ExternalThreadOpts): Shape3D {
  const profile = opts.profile ?? metricProfile(opts.pitch);
  const starts = opts.starts ?? 1;
  const majorR = opts.diameter / 2;
  const minorR = majorR - profile.depth;

  const root = makeCylinder(minorR, opts.length, [0, 0, 0], [0, 0, 1]);
  const loops = buildThreadLoops(profile, opts.pitch, opts.length, minorR, true);

  const parts: Shape3D[] = [root, ...loops];
  for (let s = 1; s < starts; s++) {
    const angle = (s * 360) / starts;
    for (const loop of loops) {
      parts.push(loop.clone().rotate(angle, [0, 0, 0], [0, 0, 1]));
    }
  }
  return makeCompound(parts) as Shape3D;
}

// ── Internal threads (tapped holes) ────────────────────────────────────────

export interface InternalThreadOpts {
  /** Minor (inner) diameter — the tapped hole's bore size. */
  diameter: number;
  pitch: number;
  length: number;
  profile?: ThreadProfile;
  starts?: number;
}

/**
 * Internally-threaded cut-tool — returns a clearance bore cylinder. Subtract
 * from your part:
 *   plate.cut(threads.internal({...}).translate(x, y, plateTop))
 *
 * Convention: top at Z=0, extends into -Z.
 *
 * This is a **cosmetic** clean bore (no ridge geometry). Matches Fusion 360
 * and SolidWorks defaults — internal threads are rarely needed for 3D-printed
 * parts (you tap post-print). For real helical ridges cut into the bore, use
 * `threads.tapInto(plate, ...)` which runs the boolean via the Manifold mesh
 * kernel and returns a MeshShape in ~100 ms.
 */
export function internal(opts: InternalThreadOpts): Shape3D {
  const profile = opts.profile ?? metricProfile(opts.pitch);
  const minorR = opts.diameter / 2;
  const majorR = minorR + profile.depth;
  return makeCylinder(
    majorR,
    opts.length + 0.2,
    [0, 0, -opts.length - 0.1],
    [0, 0, 1],
  );
}

// ── Convenience factories ──────────────────────────────────────────────────

export interface MetricThreadOpts {
  /** "coarse" (default) or "fine" ISO pitch, or a custom pitch in mm. */
  pitch?: "coarse" | "fine" | number;
  /** Number of thread starts. Default 1. */
  starts?: number;
}

/**
 * Externally-threaded metric rod for standard M-sizes.
 *
 *   threads.metric("M5", 20);                     // M5 × 20, coarse (0.8mm)
 *   threads.metric("M5", 20, { pitch: "fine" });  // M5 × 20, fine (0.5mm)
 *   threads.metric("M6", 30, { pitch: 1.5 });     // custom pitch
 *
 * **Returns a Compound. Not fuse-safe.** OCCT's boolean fuse cannot cleanly
 * merge the per-turn loops with another solid — any `head.fuse(thread)` will
 * fail BRepCheck with non-manifold seams. For `head.fuse(thread)` workflows,
 * use {@link metricMesh} or {@link fuseThreaded} (same signatures; returns
 * `MeshShape`). The Compound form returned here is appropriate for
 * multi-part STEP export where threads render as a distinct named part.
 */
export function metric(
  size: MetricSize,
  length: number,
  opts: MetricThreadOpts = {},
): Shape3D {
  assertSupportedSize(size, METRIC_COARSE_PITCH, "metric-threads");
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
 * Externally-threaded metric rod as a **Manifold `MeshShape`**. Same
 * signature as {@link metric}, but the minor-diameter cylinder and helical
 * ridges are fused inside the Manifold kernel. The returned mesh is
 * watertight and can be cleanly `.fuse()`d, `.cut()` from, etc.
 *
 * Use this when you need `head.fuse(thread)` — e.g. building a bolt from a
 * custom head shape. The B-Rep {@link metric} form is **not** fuse-safe.
 *
 *   const head = ...;
 *   const bolt = head.meshShape({ tolerance: 0.01 })
 *                    .fuse(threads.metricMesh("M8", 30).translateZ(-30));
 *
 * Cost: sub-second for typical bolts on WASM (O(n log n) mesh CSG vs. OCCT's
 * super-linear pairwise fuse).
 */
export function metricMesh(
  size: MetricSize,
  length: number,
  opts: MetricThreadOpts = {},
): MeshShape {
  assertSupportedSize(size, METRIC_COARSE_PITCH, "metric-threads");
  const pitch = resolveMetricPitch(size, opts.pitch);
  const profile = metricProfile(pitch);
  const starts = opts.starts ?? 1;
  const majorR = asMetricDiameter(size) / 2;
  const minorR = majorR - profile.depth;
  return buildExternalRodMesh(profile, pitch, length, minorR, majorR, starts);
}

/**
 * Ergonomic wrapper for the "build a hex bolt" workflow. Converts `into`
 * (a `Shape3D` head or an already-meshed `MeshShape`) to a MeshShape if
 * needed, builds a metric thread via {@link metricMesh}, translates the
 * thread to `position`, and returns the fused result.
 *
 *   const head = drawPolysides(6.5, 6).sketchOnPlane("XY").extrude(5);
 *   const bolt = threads.fuseThreaded(head, "M8", 30, [0, 0, -30]);
 */
export function fuseThreaded(
  into: Shape3D | MeshShape,
  size: MetricSize,
  length: number,
  position: Point,
  opts: MetricThreadOpts = {},
): MeshShape {
  assertSupportedSize(size, METRIC_COARSE_PITCH, "metric-threads");
  const meshedInto: MeshShape =
    typeof (into as any).meshShape === "function"
      ? (into as Shape3D).meshShape({ tolerance: 0.01 })
      : (into as MeshShape);
  const pos: [number, number, number] = Array.isArray(position)
    ? [position[0] as number, position[1] as number, position[2] as number]
    : [(position as any).x, (position as any).y, (position as any).z];
  const thread = metricMesh(size, length, opts).translate(pos[0], pos[1], pos[2]);
  return meshedInto.fuse(thread);
}

/**
 * Shortcut for `threads.internal(...)` with standard metric dimensions.
 * Returns a cosmetic clean bore cut-tool. For real helical ridges into the
 * bore, use `threads.tapInto(plate, size, depth, position)`.
 */
export function tapHole(
  size: MetricSize,
  depth: number,
  opts: MetricThreadOpts = {},
): Shape3D {
  assertSupportedSize(size, METRIC_COARSE_PITCH, "metric-threads");
  const pitch = resolveMetricPitch(size, opts.pitch);
  return internal({
    diameter: asMetricDiameter(size) - 0.1,
    pitch,
    length: depth,
    profile: metricProfile(pitch),
    starts: opts.starts ?? 1,
  });
}

/**
 * Trapezoidal leadscrew (TR8x2, TR8x8, TR10x2, TR12x2, TR12x4).
 *
 * **Returns a Compound. Not fuse-safe.** OCCT's boolean fuse cannot cleanly
 * merge the per-turn loops with another solid — any `head.fuse(thread)`
 * will fail BRepCheck with non-manifold seams. For fuse workflows, use
 * {@link leadscrewMesh} (same signature; returns `MeshShape`). The Compound
 * form here is appropriate for multi-part STEP export where the leadscrew
 * renders as a distinct named part.
 */
export function leadscrew(designation: string, length: number): Shape3D {
  const spec = resolveLeadscrewSpec(designation);
  return external({
    diameter: spec.majorDia,
    pitch: spec.pitch,
    length,
    profile: trapezoidalProfile(spec.pitch),
    starts: spec.starts,
  });
}

/**
 * Trapezoidal leadscrew as a Manifold `MeshShape`. Same signature as
 * {@link leadscrew} but fuse-safe — routes through the same mesh path as
 * {@link metricMesh}.
 */
export function leadscrewMesh(designation: string, length: number): MeshShape {
  const spec = resolveLeadscrewSpec(designation);
  const profile = trapezoidalProfile(spec.pitch);
  const majorR = spec.majorDia / 2;
  const minorR = majorR - profile.depth;
  return buildExternalRodMesh(
    profile,
    spec.pitch,
    length,
    minorR,
    majorR,
    spec.starts,
    "trapezoidal",
  );
}

function resolveLeadscrewSpec(designation: string) {
  const spec = TRAPEZOIDAL_LEADSCREW[designation];
  if (!spec) {
    const avail = Object.keys(TRAPEZOIDAL_LEADSCREW).join(", ");
    throw new Error(
      `Unknown trapezoidal leadscrew "${designation}". Available: ${avail}`,
    );
  }
  return spec;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveMetricPitch(
  size: MetricSize,
  pitch: MetricThreadOpts["pitch"],
): number {
  if (typeof pitch === "number") return pitch;
  if (pitch === "fine") return METRIC_FINE_PITCH[size];
  return METRIC_COARSE_PITCH[size];
}

function asMetricDiameter(size: MetricSize): number {
  return parseFloat(size.slice(1));
}

// ── Mesh-native thread path (for modeled tapped holes) ─────────────────────
// OCCT's B-spline helical-tool booleans are too slow on WASM to use in a
// real-time renderer (15s+ for a simple M5 tap). We bypass OCCT entirely
// for the thread geometry, generate the helical ridge directly as triangles,
// and use Manifold's mesh CSG (already 10–100× faster) to fuse the ridges
// into a plate that's been converted to a MeshShape.

const MESH_SAMPLES_PER_TURN = 24; // 15° facets — invisible inside a bore

/**
 * Generate raw triangles for one helical thread ridge. The ridge is a
 * twisted trapezoidal tube centered on a helix of radius `rootRadius`.
 *
 * Returns raw vertex/triangle arrays suitable for Manifold's Mesh constructor.
 * Vertices are laid out as 4-per-sample (profile p0..p3 in order); triangles
 * wind CCW when viewed from outside so Manifold accepts the mesh as manifold.
 *
 * For internal threads (`external=false`), profile Y is mirrored so the crest
 * points radially inward (into the bore) and the base slightly outward (into
 * the plate material by INTERFERENCE mm) for a welded fuse.
 */
function buildRidgeMesh(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  rootRadius: number,
  external: boolean,
  startAngle: number,
): { vertProperties: Float32Array; triVerts: Uint32Array } {
  const totalTurns = length / pitch;
  const totalSamples = Math.max(4, Math.ceil(totalTurns * MESH_SAMPLES_PER_TURN) + 1);
  const axialRate = pitch / (2 * Math.PI);

  const sign = external ? 1 : -1;
  const baseY = -INTERFERENCE * sign;
  const crestY = profile.depth * sign;
  // Profile corners in local (axial, radial) coords, CCW when viewed along
  // the helix tangent (so extrude in +tangent gives outward-facing side quads).
  const profilePts: Array<[number, number]> = [
    [-profile.baseWidth / 2, baseY],     // p0: base left (axially behind)
    [+profile.baseWidth / 2, baseY],     // p1: base right
    [+profile.crestWidth / 2, crestY],   // p2: crest right
    [-profile.crestWidth / 2, crestY],   // p3: crest left
  ];

  const vertProperties = new Float32Array(totalSamples * 4 * 3);

  for (let i = 0; i < totalSamples; i++) {
    const u = i / (totalSamples - 1);
    const theta = startAngle + u * totalTurns * 2 * Math.PI;
    const z = u * length;

    // Helix tangent + Frenet frame (same logic as crossSectionWire above).
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const tx = -rootRadius * sinT;
    const ty = rootRadius * cosT;
    const tz = axialRate;
    const tMag = Math.sqrt(tx * tx + ty * ty + tz * tz);
    const nx = tx / tMag, ny = ty / tMag, nz = tz / tMag;

    // xDir = global +Z projected onto plane ⊥ tangent.
    const pxRaw = -nz * nx;
    const pyRaw = -nz * ny;
    const pzRaw = 1 - nz * nz;
    const pMag = Math.sqrt(pxRaw * pxRaw + pyRaw * pyRaw + pzRaw * pzRaw);
    const xDx = pxRaw / pMag, xDy = pyRaw / pMag, xDz = pzRaw / pMag;

    // yDir = normal × xDir.
    const yDx = ny * xDz - nz * xDy;
    const yDy = nz * xDx - nx * xDz;
    const yDz = nx * xDy - ny * xDx;

    const ox = rootRadius * cosT;
    const oy = rootRadius * sinT;
    const oz = z;

    for (let c = 0; c < 4; c++) {
      const [lx, ly] = profilePts[c];
      const vx = ox + lx * xDx + ly * yDx;
      const vy = oy + lx * xDy + ly * yDy;
      const vz = oz + lx * xDz + ly * yDz;
      const idx = (i * 4 + c) * 3;
      vertProperties[idx] = vx;
      vertProperties[idx + 1] = vy;
      vertProperties[idx + 2] = vz;
    }
  }

  // Triangles: 4 side strips + 2 end caps. Strip[a→b] for each profile edge.
  const nStrips = 4;
  const sideTris = (totalSamples - 1) * nStrips * 2;
  const capTris = 4;
  const triVerts = new Uint32Array((sideTris + capTris) * 3);
  let t = 0;

  for (let i = 0; i < totalSamples - 1; i++) {
    for (let a = 0; a < 4; a++) {
      const b = (a + 1) % 4;
      const ai = i * 4 + a;
      const bi = i * 4 + b;
      const aj = (i + 1) * 4 + a;
      const bj = (i + 1) * 4 + b;
      // CCW-from-outside winding for a CCW profile extruded along +tangent.
      triVerts[t++] = ai; triVerts[t++] = bi; triVerts[t++] = bj;
      triVerts[t++] = ai; triVerts[t++] = bj; triVerts[t++] = aj;
    }
  }

  // Start cap (i=0): face points in −tangent direction → reverse winding.
  const s0 = 0, s1 = 1, s2 = 2, s3 = 3;
  triVerts[t++] = s0; triVerts[t++] = s3; triVerts[t++] = s2;
  triVerts[t++] = s0; triVerts[t++] = s2; triVerts[t++] = s1;

  // End cap (i=last): face points in +tangent direction → normal winding.
  const e0 = (totalSamples - 1) * 4;
  const e1 = e0 + 1, e2 = e0 + 2, e3 = e0 + 3;
  triVerts[t++] = e0; triVerts[t++] = e1; triVerts[t++] = e2;
  triVerts[t++] = e0; triVerts[t++] = e2; triVerts[t++] = e3;

  return { vertProperties, triVerts };
}

/** Wrap raw triangles in a Manifold → MeshShape. */
function meshShapeFromTriangles(
  vertProperties: Float32Array,
  triVerts: Uint32Array,
): MeshShape {
  const manifold = getManifold();
  const mesh = new manifold.Mesh({ numProp: 3, vertProperties, triVerts });
  return new MeshShape(new manifold.Manifold(mesh));
}

/**
 * Build the full internal-thread ridge set (all starts) as ONE MeshShape.
 * Multiple starts are built as separate ridge meshes, fused together via
 * Manifold (fast — mesh fuse on disjoint ridges is near-instant).
 */
function buildInternalRidgesMesh(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  majorRadius: number,
  starts: number,
): MeshShape {
  let combined: MeshShape | null = null;
  for (let s = 0; s < starts; s++) {
    const startAngle = (s * 2 * Math.PI) / starts;
    const { vertProperties, triVerts } = buildRidgeMesh(
      profile, pitch, length, majorRadius, false, startAngle,
    );
    const ridge = meshShapeFromTriangles(vertProperties, triVerts);
    combined = combined ? combined.fuse(ridge) : ridge;
  }
  if (!combined) throw new Error("starts must be >= 1");
  return combined;
}

/**
 * Build an externally-threaded rod as a single fused `MeshShape`:
 *   minor-diameter cylinder ∪ (each start's outward helical ridge)
 *
 * Uses the same Manifold pattern as {@link tapInto}: shapes are converted to
 * mesh form once (tolerance 0.01 mm — invisible on screen), then unioned in
 * Manifold, whose O(n log n) volumetric boolean is sub-second on WASM even
 * for an M12 × 80 rod.
 */
function buildExternalRodMesh(
  profile: ThreadProfile,
  pitch: number,
  length: number,
  minorR: number,
  majorR: number,
  starts: number,
  threadType: "metric" | "trapezoidal" = "metric",
): MeshShape {
  // --- Cache lookup (N2) ---------------------------------------------------
  // Key on the inputs that determine the fused rod geometry. minorR/majorR
  // are derived from `profile` + the caller's diameter, and the profile
  // already encodes depth/base/crest, so profile+pitch+length+starts fully
  // determines the shape for a given threadType.
  const cacheKey = makeThreadCacheKey(profile, pitch, length, starts, threadType);
  const cached = threadMeshCache.get(cacheKey);
  if (cached) {
    // Clone before handoff: the caller will almost certainly consume the
    // returned mesh (via `.fuse(head)` / `.translate(...)` / `.delete()`),
    // which would invalidate the cache entry. Clone is cheap relative to
    // the 100-200ms-per-start fuse we're skipping.
    return cached.clone();
  }

  const rootB = makeCylinder(minorR, length, [0, 0, 0], [0, 0, 1]);
  let combined: MeshShape = rootB.meshShape({ tolerance: 0.01 });
  rootB.delete();

  for (let s = 0; s < starts; s++) {
    const startAngle = (s * 2 * Math.PI) / starts;
    const { vertProperties, triVerts } = buildRidgeMesh(
      profile, pitch, length, majorR, true, startAngle,
    );
    const ridge = meshShapeFromTriangles(vertProperties, triVerts);
    combined = combined.fuse(ridge);
  }

  // --- Cache store (N2) ----------------------------------------------------
  // Store a clone so the current caller gets an independent shape they can
  // freely consume/delete. The cache retains the canonical copy for the
  // next hit (which will itself clone on handoff).
  threadMeshCache.set(cacheKey, combined.clone());
  return combined;
}

/**
 * Coerce a plate to a `MeshShape`. Accepts either a Shape3D (B-Rep — we mesh
 * it via OCCT's triangulator) or an already-meshed `MeshShape` (passes
 * through untouched). Required so multi-tap flows chain cleanly:
 *
 *   let p = box;
 *   p = threads.tapInto(p, "M6", 15, p1);   // p is now MeshShape
 *   p = threads.tapInto(p, "M6", 15, p2);   // second call — input is MeshShape
 *
 * Without this, the second call would throw `plate.meshShape is not a
 * function` because MeshShape doesn't expose `meshShape()` — it's already a
 * mesh. Private to this module (not exported) so callers can't build
 * parallel variants that drift from this contract.
 */
function asMeshShape(
  plate: Shape3D | MeshShape,
  opts: { tolerance?: number } = {},
): MeshShape {
  // Shape3D exposes `meshShape()`; MeshShape does not. Duck-type rather than
  // an instanceof check — the worker destructures replicad through a sandbox
  // so class identity isn't always preserved across module boundaries.
  if (typeof (plate as any).meshShape === "function") {
    return (plate as Shape3D).meshShape({ tolerance: opts.tolerance ?? 0.01 });
  }
  return plate as MeshShape;
}

/**
 * Cut a modeled tapped hole into a plate. Returns a MeshShape — any
 * subsequent `.fuse()` / `.cut()` must therefore be Manifold-compatible
 * (MeshShape-to-MeshShape). Chains cleanly for multi-hole plates: the
 * `plate` arg accepts either a Shape3D (first call) or a MeshShape (second
 * and later calls), so the common multi-tap pattern just works:
 *
 *   let plate = makeBox(...);
 *   plate = threads.tapInto(plate, "M6", 15, [-12, 0, 25]);
 *   plate = threads.tapInto(plate, "M6", 15, [ 12, 0, 25]);
 *   return plate;
 *
 * Meets the <1s target for an M5×8 tap on WASM, where the OCCT-native path
 * took 15s+ and timed out.
 *
 * The `position` is where the TOP of the hole sits on the plate (usually
 * the top face). The hole extends down by `depth` into the plate.
 */
export function tapInto(
  plate: Shape3D | MeshShape,
  size: MetricSize,
  depth: number,
  position: Point,
  opts: MetricThreadOpts = {},
): MeshShape {
  assertSupportedSize(size, METRIC_COARSE_PITCH, "metric-threads");
  const pitch = resolveMetricPitch(size, opts.pitch);
  const profile = metricProfile(pitch);
  const starts = opts.starts ?? 1;

  const diameter = asMetricDiameter(size) - 0.1;
  const minorR = diameter / 2;
  const majorR = minorR + profile.depth;

  // Mesh plate and bore. `asMeshShape` passes MeshShape through untouched so
  // double-tap chains don't re-invoke `meshShape()` on a mesh (which would
  // throw `plate.meshShape is not a function` — the bug this helper fixes).
  const plateMesh = asMeshShape(plate, { tolerance: 0.01 });
  const boreB = makeCylinder(majorR, depth + 0.2, [0, 0, -0.1], [0, 0, 1]);
  const boreMesh = boreB.meshShape({ tolerance: 0.01 });
  boreB.delete();

  // Thread ridges as mesh.
  const ridgesBase = buildInternalRidgesMesh(profile, pitch, depth, majorR, starts);
  // Ridges are built with z=0 at start → translate so the hole top sits at
  // z=0 and the ridges extend down into −z. Then translate by position.
  const ridges = ridgesBase.translate(0, 0, -depth);

  // plate − bore + ridges. Position everything relative to the hole.
  const pos: [number, number, number] = Array.isArray(position)
    ? [position[0] as number, position[1] as number, position[2] as number]
    : [(position as any).x, (position as any).y, (position as any).z];
  const boreAtPos = boreMesh.translate(pos[0], pos[1], pos[2] - depth);
  const ridgesAtPos = ridges.translate(pos[0], pos[1], pos[2]);

  return plateMesh.cut(boreAtPos).fuse(ridgesAtPos);
}

/**
 * Cut a modeled **trapezoidal** tapped hole (for leadscrew nuts) into a
 * plate. Mirror of {@link tapInto} but for TR-designated sizes (TR8x2,
 * TR8x8, TR10x2, TR12x2, TR12x4) — gives you a real printable internal
 * thread that mates with a leadscrew rod produced by {@link leadscrew} /
 * {@link leadscrewMesh}.
 *
 * Handles multi-start leadscrews automatically — e.g. TR8x8 has 4 starts,
 * and the returned tap will include all four helical ridges.
 *
 *   // A flanged TR8x8 nut for a NEMA17 linear actuator.
 *   const flange = drawCircle(12).sketchOnPlane("XY").extrude(4);
 *   const body = drawCircle(7).sketchOnPlane("XY").extrude(12).translateZ(4);
 *   const blank = flange.fuse(body);
 *   const nut = threads.tapIntoTrap(blank, "TR8x8", 16, [0, 0, 16]);
 *
 * Like {@link tapInto}, `position` is the TOP of the hole (usually the top
 * face of the plate); the tap extends down by `depth` into `-Z`. Returns a
 * `MeshShape`, and accepts either a Shape3D (first call) or a MeshShape
 * (second and later calls) so multi-tap chains work out of the box — any
 * downstream op must be Manifold-compatible.
 *
 * @param plate Shape3D or MeshShape to tap into.
 * @param designation Trapezoidal leadscrew designation (e.g. `"TR8x8"`).
 * @param depth Hole depth along `-Z` in mm. Must be > 0.
 * @param position `[x, y, z]` of the hole's top.
 * @returns `MeshShape` (fuse-safe) — the plate with the tapped hole cut in.
 */
export function tapIntoTrap(
  plate: Shape3D | MeshShape,
  designation: string,
  depth: number,
  position: Point,
): MeshShape {
  if (!(depth > 0)) {
    throw new Error(
      `threads.tapIntoTrap: depth must be > 0, got ${depth}`,
    );
  }
  const spec = resolveLeadscrewSpec(designation);
  const profile = trapezoidalProfile(spec.pitch);
  const starts = spec.starts;

  // Clearance on the bore (matches tapInto's 0.1mm undersize for a snug fit
  // after the ridges are fused back in). For trap threads the crest is flat
  // so the nominal-minus-clearance bore gives room for ridge crests without
  // interfering with the rod's major diameter.
  const diameter = spec.majorDia - 0.1;
  const minorR = diameter / 2;
  const majorR = minorR + profile.depth;

  const plateMesh = asMeshShape(plate, { tolerance: 0.01 });
  const boreB = makeCylinder(majorR, depth + 0.2, [0, 0, -0.1], [0, 0, 1]);
  const boreMesh = boreB.meshShape({ tolerance: 0.01 });
  boreB.delete();

  const ridgesBase = buildInternalRidgesMesh(profile, spec.pitch, depth, majorR, starts);
  const ridges = ridgesBase.translate(0, 0, -depth);

  const pos: [number, number, number] = Array.isArray(position)
    ? [position[0] as number, position[1] as number, position[2] as number]
    : [(position as any).x, (position as any).y, (position as any).z];
  const boreAtPos = boreMesh.translate(pos[0], pos[1], pos[2] - depth);
  const ridgesAtPos = ridges.translate(pos[0], pos[1], pos[2]);

  return plateMesh.cut(boreAtPos).fuse(ridgesAtPos);
}
