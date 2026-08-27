import { pushRuntimeWarning } from "./stdlib/warnings";

/**
 * Named material presets — density in g/cm³, mapped to the same units the
 * rest of the mass pipeline uses (`mass = density * volume / 1000` with
 * volume in mm³). Lets users write `material: "PLA"` instead of looking up
 * densities manually. Case-sensitive — "PLA", "ABS", etc. must match
 * exactly; unknown strings are dropped at resolve time so the caller can
 * warn instead of silently losing mass data.
 *
 * Lives here (not in executor.ts) so per-part materials in `normalizeParts`
 * and script-level materials in the executor share the same source of truth.
 */
export const MATERIAL_PRESETS: Record<string, number> = {
  PLA: 1.24,
  ABS: 1.04,
  PETG: 1.27,
  Nylon: 1.15,
  Aluminum: 2.7,
  Steel: 7.85,
  Stainless: 8.0,
  Brass: 8.47,
  Titanium: 4.5,
  Copper: 8.96,
  Wood: 0.6,
  // Engineering-grade alloy variants — generic names above stay as back-compat
  // defaults; prefer these when alloy-grade precision matters for mass budgets.
  "Aluminum 6061": 2.7,
  "Aluminum 7075": 2.81,
  "Steel 304": 7.93,
  "Steel 4140": 7.85,
  "Brass 360": 8.5,
  "Titanium Grade 5": 4.43,
};

/**
 * Resolve a raw material value (string preset name or `{density, name?}`
 * object) into a normalized `{density, name?}` shape. Returns a tagged
 * union so callers can warn on unknown presets vs. silently drop invalid
 * inputs.
 *
 *   - `string` matching a preset → `{ok: true, material: {density, name}}`
 *   - `string` NOT matching any preset → `{ok: false, reason: "unknown-preset", given}`
 *   - `{density: number > 0, name?: string}` → `{ok: true, material: {...}}`
 *   - `null` / `undefined` → `{ok: true, material: undefined}` (caller treats as absent)
 *   - anything else (malformed object, NaN density, etc.) → `{ok: false, reason: "invalid"}`
 */
export type MaterialResolution =
  | { ok: true; material: { density: number; name?: string } | undefined }
  | { ok: false; reason: "unknown-preset"; given: string }
  | { ok: false; reason: "invalid" };

export function resolveMaterial(raw: unknown): MaterialResolution {
  if (raw === undefined || raw === null) {
    return { ok: true, material: undefined };
  }
  if (typeof raw === "string") {
    const preset = MATERIAL_PRESETS[raw];
    if (preset !== undefined) {
      return { ok: true, material: { density: preset, name: raw } };
    }
    return { ok: false, reason: "unknown-preset", given: raw };
  }
  if (typeof raw === "object") {
    const r = raw as { density?: unknown; name?: unknown };
    if (typeof r.density === "number" && Number.isFinite(r.density) && r.density > 0) {
      const out: { density: number; name?: string } = { density: r.density };
      if (typeof r.name === "string" && r.name.length > 0) out.name = r.name;
      return { ok: true, material: out };
    }
  }
  return { ok: false, reason: "invalid" };
}

export interface PartInput {
  shape: any;
  name: string;
  color: string | null;
  /**
   * Optional per-part print-quantity hint. When the user writes
   * `{ shape, name: "tower", qty: 2 }` they're telling downstream tooling
   * (BOM, slicer handoff) to produce 2 copies. Defaults to 1 when absent —
   * every existing script keeps its current semantics.
   */
  qty?: number;
  /**
   * Optional per-part material override. Takes precedence over the
   * script-level `export const material = {...}` for this single part so
   * multi-material assemblies (e.g. a PLA shell with a TPU gasket) can carry
   * density + name through the pipeline. Absent → inherit the script-level
   * material (if any).
   *
   * Normalized form is `{density, name?}` — that's what every consumer
   * after `normalizeParts` sees. Scripts can pass a string preset name at
   * the array boundary (`{ material: "Aluminum" }`); `normalizeParts`
   * resolves it via {@link resolveMaterial}, warns on unknown presets,
   * and stores the resolved object here. The string form is most useful
   * when re-using `export const material = "Foo"` from an imported part-
   * factory file without writing density lookups by hand:
   *
   *   import partMain, { material as partMaterial } from "./part.shape";
   *   return [{ shape: partMain(...), name: "part", material: partMaterial }];
   */
  material?: { density: number; name?: string };
  /**
   * Opt out of printability / minFeature / geometry-quality analysis for
   * this part. When the script marks a part `analyze: false` (e.g. a servo
   * mockup, a reference tube included only for collision checks) downstream
   * consumers should skip issuing warnings that only make sense for parts
   * the user will actually fabricate. Undefined / true = analyze as normal;
   * false = mockup, skip analysis. Defaulting to "analyze" preserves every
   * existing script's behaviour.
   */
  analyze?: boolean;
  /**
   * Optional named joints in WORLD coordinates. Used by `validate_joints`
   * to verify each joint sits on the owning part's surface, and by future
   * tooling (mate inspection, joint-based picking). The stdlib `Part`
   * factory + `entries()` populate this automatically; users returning
   * raw `{shape, name}` objects can supply it directly when they want
   * post-render joint validation.
   *
   * `position` is the joint origin in world coords, `axis` is the
   * normalized outward direction. `role` / `diameter` are optional
   * metadata that mate() uses for pre-flight checks.
   */
  joints?: Record<
    string,
    {
      position: [number, number, number];
      axis: [number, number, number];
      role?: "male" | "female" | "face";
      diameter?: number;
    }
  >;
}

export interface TessellatedPart {
  name: string;
  color: string | null;
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  edgeVertices: Float32Array;
  /**
   * Which span of `triangles` belongs to which face of the B-Rep, as flat
   * `[start, count, start, count, …]` pairs — both in **index units**, so
   * face `i` covers `triangles[start .. start + count)` and therefore
   * triangle numbers `start / 3 .. (start + count) / 3`.
   *
   * replicad also hands out a `faceId` per group. We deliberately drop it:
   * it is a WASM heap pointer, not an identity. Building the *same* geometry
   * twice in one process yields 8489761 then 9050681 — it rises with every
   * allocation. It is meaningful only inside the single `mesh()` result that
   * produced it, so persisting or transmitting it would invite exactly the
   * bug it looks like it prevents.
   *
   * Omitted when the shape is not an OCCT B-Rep (MeshShape / Manifold parts
   * have no faces to pick).
   */
  faceGroups?: Uint32Array;
  /**
   * Geometry of each face, index-aligned with `faceGroups`. Populated by the
   * orchestration loop in `index.ts` (which owns the replicad handle), not by
   * `tessellatePart`. See {@link FaceInfo}.
   */
  faceInfo?: FaceInfo[];
  /**
   * Which span of `edgeVertices` belongs to which edge, as flat
   * `[start, count, …]` pairs in **point units** — edge `i` covers points
   * `start .. start + count`, i.e. floats `start * 3 .. (start + count) * 3`.
   * Note the different unit from `faceGroups`; that asymmetry is replicad's,
   * and normalising it here would only hide it from whoever reads the spec.
   */
  edgeGroups?: Uint32Array;
  volume?: number;
  surfaceArea?: number;
  centerOfMass?: [number, number, number];
  /**
   * Derived mass in grams. Only populated when the script exports a
   * `material` with a positive `density` (g/cm³). Computed as
   * `density * volume / 1000` to convert mm³ → cm³.
   */
  mass?: number;
  /** Propagated from PartInput — see {@link PartInput.qty}. */
  qty?: number;
  /** Propagated from PartInput — see {@link PartInput.material}. */
  material?: { density: number; name?: string };
  /** Propagated from PartInput — see {@link PartInput.analyze}. */
  analyze?: boolean;
  /** Propagated from PartInput — see {@link PartInput.joints}. */
  joints?: Record<
    string,
    {
      position: [number, number, number];
      axis: [number, number, number];
      role?: "male" | "female" | "face";
      diameter?: number;
    }
  >;
}

export function normalizeParts(
  result: any,
  opts?: { scriptHasMaterial?: boolean },
): PartInput[] {
  if (!result) throw new Error("Script returned nothing");

  if (!Array.isArray(result)) {
    // Sugar: allow returning a single {shape, name, color} object without
    // wrapping it in an array. Reuse the array branch by wrapping it.
    if (result && result.shape && typeof result.shape.mesh === "function") {
      return normalizeParts([result], opts);
    }
    if (typeof result.mesh === "function") {
      return [{ shape: result, name: "shape", color: null }];
    }
    const keys =
      typeof result === "object" ? ` Keys: [${Object.keys(result).join(", ")}]` : "";
    throw new Error(
      `main() must return one of: (a) a Shape3D, (b) a {shape, name, color} object, (c) an array of either. Got: ${typeof result}.${keys}`,
    );
  }

  const parts: PartInput[] = result.map((item: any, i: number) => {
    if (item && item.shape && typeof item.shape.mesh === "function") {
      const out: PartInput = {
        shape: item.shape,
        name: item.name || `part-${i + 1}`,
        color: item.color || null,
      };
      // Preserve optional BOM metadata when the script sets it. We validate
      // minimally here (qty must be a positive finite number; material must
      // have a positive density) so downstream consumers never have to
      // re-sanitize.
      if (typeof item.qty === "number" && Number.isFinite(item.qty) && item.qty > 0) {
        out.qty = item.qty;
      }
      // Per-part material: accepts string preset OR {density, name?} object.
      // Unknown presets push a runtime warning so a typo is visible; invalid
      // objects (NaN density etc.) are dropped silently to match prior
      // permissive behaviour.
      const matRes = resolveMaterial(item.material);
      if (matRes.ok) {
        if (matRes.material) out.material = matRes.material;
      } else if (matRes.reason === "unknown-preset") {
        pushRuntimeWarning(
          `Unknown material preset '${matRes.given}' on part '${out.name}'. ` +
            `Known presets: ${Object.keys(MATERIAL_PRESETS).join(", ")}. ` +
            `Use { density: number } for custom densities. ` +
            `Part will appear with no mass in the BOM.`,
        );
      }
      // Preserve the analyze opt-out flag. Only `false` is meaningful (opt
      // out of printability / minFeature warnings); `true` is the default
      // so we only materialize the field when the script explicitly set it
      // — keeps downstream serializers noise-free.
      if (item.analyze === false) {
        out.analyze = false;
      }
      // Preserve joints when present. Validate shape minimally — every value
      // needs at least { position: [n,n,n], axis: [n,n,n] }; malformed entries
      // are skipped silently rather than crashing the render. validate_joints
      // is the consumer; if it sees nothing, it reports "no introspectable
      // joints" rather than rejecting the part.
      if (item.joints && typeof item.joints === "object" && !Array.isArray(item.joints)) {
        const sanitized: NonNullable<PartInput["joints"]> = {};
        for (const [name, spec] of Object.entries(item.joints)) {
          const s = spec as any;
          const pos = s?.position;
          const ax = s?.axis;
          if (
            Array.isArray(pos) && pos.length >= 3 && pos.every((n: any) => typeof n === "number" && Number.isFinite(n)) &&
            Array.isArray(ax) && ax.length >= 3 && ax.every((n: any) => typeof n === "number" && Number.isFinite(n))
          ) {
            sanitized[name] = {
              position: [pos[0], pos[1], pos[2]],
              axis: [ax[0], ax[1], ax[2]],
              ...(s.role === "male" || s.role === "female" || s.role === "face" ? { role: s.role } : {}),
              ...(typeof s.diameter === "number" && Number.isFinite(s.diameter) ? { diameter: s.diameter } : {}),
            };
          }
        }
        if (Object.keys(sanitized).length > 0) out.joints = sanitized;
      }
      return out;
    }
    if (item && typeof item.mesh === "function") {
      return { shape: item, name: `part-${i + 1}`, color: null };
    }
    throw new Error(`Item ${i} is not a valid Shape3D`);
  });

  // Mixed-material warning. If SOME parts in a multi-part assembly carry a
  // per-part material but OTHERS don't, the material-less ones show no mass in
  // the BOM. That's the tell-tale of importing part factories and re-exporting
  // the material for only some of them — a bundled child's `export const
  // material` is deliberately gated out of the assembly (see executor.ts), so
  // it only reaches the BOM when the author attaches it per-part.
  //
  // CRUCIAL GATE: suppress entirely when the script declares a top-level
  // `export const material` (scriptHasMaterial). In that case a part WITHOUT a
  // per-part material simply INHERITS the script default downstream — it is not
  // material-less — so the "some have, some don't" shape is the legitimate
  // multi-material override pattern (e.g. PLA shell + TPU gasket), not a bug.
  // Only the no-script-default case leaves the bare parts genuinely mass-less.
  if (!opts?.scriptHasMaterial && parts.length > 1) {
    const withoutMat = parts.filter((p) => !p.material);
    if (withoutMat.length > 0 && withoutMat.length < parts.length) {
      const names = withoutMat.map((p) => p.name).slice(0, 6).join(", ");
      const more = withoutMat.length > 6 ? ` (+${withoutMat.length - 6} more)` : "";
      pushRuntimeWarning(
        `${withoutMat.length} of ${parts.length} parts carry no material, so they show no mass in the BOM: ${names}${more}. ` +
          `A bundled part file's \`export const material\` does NOT propagate to the assembly automatically — attach it per part: ` +
          `\`import partMain, { material as m } from "./part.shape"\` then \`return [{ shape: partMain(...), name, material: m }]\`.`,
      );
    }
  }

  return parts;
}

/**
 * Pick a tessellation tolerance from the shape's bounding-box diagonal. A
 * fixed 0.1 mm tolerance makes 2 mm parts look faceted and makes 2 m parts
 * waste millions of triangles. Scaling by the diagonal keeps surface
 * smoothness roughly constant to the eye regardless of part size.
 *
 * Factor 0.0005 ≈ 0.05% of diagonal — e.g. a 100 mm diagonal yields 0.05 mm
 * tolerance (smoother than the old default), a 2 m diagonal yields 1 mm (far
 * coarser, fewer triangles). Clamped to [0.005, 1.0] so pathological inputs
 * (zero-size or astronomically large shapes) stay in a sensible range.
 */
function chooseTolerance(shape: any): number {
  try {
    const bb = shape.boundingBox;
    if (bb) {
      const w = bb.width ?? 0;
      const h = bb.height ?? 0;
      const d = bb.depth ?? 0;
      const diag = Math.sqrt(w * w + h * h + d * d);
      if (diag > 0) return Math.max(0.005, Math.min(1.0, diag * 0.0005));
    }
  } catch {}
  return 0.1;
}

/** Tessellation-quality preset. */
export type MeshQuality = "preview" | "final";

/**
 * A picked-face descriptor: what the viewer needs to name one face of a part
 * back to the user, and what a later step needs to synthesise a replicad
 * finder for it.
 *
 * Index-aligned with the `[start, count]` pairs in
 * {@link TessellatedPart.faceGroups}, which is safe because OCCT enumerates
 * faces in the same order for `mesh()` and for `new FaceFinder().find(shape)`.
 * That is an observed property of the library, not a documented guarantee, so
 * {@link TessellatedPart.faceGroups} carries the mesh spans and this carries
 * the geometry — a caller that distrusts the pairing can always fall back to
 * matching a group's centroid against `center`.
 */
export interface FaceInfo {
  /** OCCT surface type: "PLANE", "CYLINDRE", "SPHERE", "BSPLINE_SURFACE", … */
  kind: string;
  /** Face centre in world mm — the centre of mass of the surface, not of its AABB. */
  center: [number, number, number];
  /**
   * Outward unit normal. Meaningful for planar faces; for curved ones it is
   * the normal at the surface's parametric midpoint, which is why the viewer
   * only offers plane-based actions when `kind === "PLANE"`.
   * Omitted when OCCT could not evaluate one.
   */
  normal?: [number, number, number];
  /** Surface area in mm². Omitted when measurement failed. */
  area?: number;
}

/**
 * How much per-part measurement work to do on the tessellation hot path.
 *
 * `"none"` — skip both `measureShapeVolumeProperties` and
 * `measureShapeSurfaceProperties`; omit volume / surfaceArea / centerOfMass
 * from the emitted part. Cheapest; use when the caller only needs geometry
 * for rendering.
 *
 * `"bbox"` (default) — still skip the two OCCT measurement calls, but derive
 * a centerOfMass from the shape's bounding-box centre so assemblies get a
 * usable aggregate CoM without paying the ~200 ms/part B-Rep cost. volume /
 * surfaceArea stay omitted.
 *
 * `"full"` — pre-partStats behaviour: call both measurement functions and
 * populate volume / surfaceArea / centerOfMass (plus mass if a material is
 * declared). Slowest; issue #6 measured ~2.5 s on a 14-part assembly.
 */
export type PartStatsLevel = "none" | "bbox" | "full";

/**
 * Per-quality multipliers applied to the auto-computed tolerance. `final`
 * is the baseline (1× — behaviour unchanged from before the quality knob
 * existed). `preview` multiplies by 4.5× — tolerance² scaling means this
 * is roughly 3–4× faster than the previous 2.5× factor (meshing cost
 * scales inversely with tolerance²: (4.5/2.5)² ≈ 3.2×). Angular tolerance
 * is also widened so helical surfaces (threads) don't pin the tessellator
 * at preview quality.
 */
const QUALITY_FACTOR: Record<MeshQuality, { linear: number; angular: number }> = {
  final: { linear: 1, angular: 0.1 },
  preview: { linear: 4.5, angular: 0.4 },
};

export interface TessellateOptions {
  /**
   * Mesh quality preset. `"final"` (default) preserves the pre-existing
   * tolerance behaviour. `"preview"` scales the tolerance ~4.5× (roughly
   * 3–4× faster tessellation than "final" on complex geometry, at the cost
   * of visibly coarser facets — triangle count scales inversely with
   * tolerance²). Auto-degrading to preview for large assemblies is the
   * caller's policy decision — tessellatePart itself is neutral.
   */
  meshQuality?: MeshQuality;
  /**
   * How much per-part measurement work core should do AFTER tessellation.
   * See {@link PartStatsLevel} for the full semantics. Consumed by the
   * orchestration loop in `packages/core/src/index.ts`, not by
   * `tessellatePart` itself (which never calls measureShape*Properties) —
   * co-located here so callers configure all tess-time policy in one place.
   * Default is `"bbox"` (issue #6: skip 2.5 s of B-Rep measurement on a
   * 14-part assembly; derive CoM from the AABB centre instead).
   */
  partStats?: PartStatsLevel;
}

/**
 * Upper bound on faces we will describe for picking. Past this the per-face
 * OCCT calls stop being free relative to meshing (~0.45 ms each, so 1000 faces
 * ≈ 450 ms) and the UI value collapses anyway — nobody picks one face out of
 * four thousand by eye. Parts above the cap still render and still highlight
 * nothing; they simply are not pickable.
 */
export const MAX_DESCRIBED_FACES = 1000;

/**
 * Describe every face of an OCCT shape, index-aligned with the `faceGroups`
 * that `tessellatePart` captured from the same shape.
 *
 * Kept out of `tessellatePart` on purpose: that function is documented as
 * never calling into replicad's measurement API, and it has no replicad
 * handle. The orchestration loop in `index.ts` has both, so it calls this.
 *
 * Everything here is best-effort. A shape with no `FaceFinder` (Manifold
 * MeshShape), a face OCCT cannot evaluate a normal for, a failed area
 * measurement — each degrades to a missing field rather than a thrown error,
 * because a part that cannot be picked should still be a part that renders.
 */
export function describeFaces(
  shape: any,
  replicadExports: Record<string, any>,
  expectedCount?: number,
): FaceInfo[] | undefined {
  const FaceFinder = replicadExports.FaceFinder;
  if (typeof FaceFinder !== "function") return undefined;

  let faces: any[];
  try {
    faces = new FaceFinder().find(shape);
  } catch {
    return undefined;
  }
  if (!Array.isArray(faces) || faces.length === 0) return undefined;

  const deleteAll = () => {
    for (const f of faces) {
      try { f.delete?.(); } catch { /* freeing is best effort */ }
    }
  };

  // The pairing with faceGroups is positional, so a length disagreement means
  // the assumption behind it does not hold for this shape. Ship nothing rather
  // than ship descriptors that name the wrong face.
  if (expectedCount !== undefined && faces.length !== expectedCount) {
    deleteAll();
    return undefined;
  }
  if (faces.length > MAX_DESCRIBED_FACES) {
    deleteAll();
    return undefined;
  }

  const measureArea = replicadExports.measureShapeSurfaceProperties;
  const out: FaceInfo[] = faces.map((f) => {
    const info: FaceInfo = { kind: "UNKNOWN", center: [0, 0, 0] };
    try { info.kind = String(f.geomType ?? "UNKNOWN"); } catch { /* keep UNKNOWN */ }
    try {
      const c = f.center;
      info.center = [c.x, c.y, c.z];
    } catch { /* keep origin */ }
    try {
      const n = f.normalAt();
      const len = Math.hypot(n.x, n.y, n.z);
      if (len > 0) info.normal = [n.x / len, n.y / len, n.z / len];
    } catch { /* curved or degenerate — leave normal off */ }
    if (typeof measureArea === "function") {
      try {
        const props = measureArea(f);
        if (props && Number.isFinite(props.area)) info.area = props.area;
        try { props?.delete?.(); } catch { /* best effort */ }
      } catch { /* leave area off */ }
    }
    return info;
  });

  deleteAll();
  return out;
}

/**
 * Flatten replicad's group records into a transferable `[start, count, …]`
 * pair array. Returns undefined for a missing or empty list so the field can
 * simply be omitted rather than shipping a zero-length buffer that every
 * consumer then has to distinguish from "not computed".
 */
function packGroups(
  groups: { start: number; count: number }[] | undefined,
): Uint32Array | undefined {
  if (!Array.isArray(groups) || groups.length === 0) return undefined;
  const out = new Uint32Array(groups.length * 2);
  for (let i = 0; i < groups.length; i++) {
    out[i * 2] = groups[i].start;
    out[i * 2 + 1] = groups[i].count;
  }
  return out;
}

export function tessellatePart(part: PartInput, opts: TessellateOptions = {}): TessellatedPart {
  const quality: MeshQuality = opts.meshQuality ?? "final";
  const factor = QUALITY_FACTOR[quality] ?? QUALITY_FACTOR.final;
  // Apply the preset's linear multiplier to the auto-computed tolerance.
  // Clamp upper bound so pathologically-large shapes on `preview` don't
  // produce nearly-zero-triangle meshes that break the viewer. The cap is
  // 5.0 mm — raised from 2.5 so the new preview linear factor of 4.5 can
  // fully take effect on large shapes (chooseTolerance caps at 1.0 mm
  // internally, so 1.0 * 4.5 = 4.5 would otherwise be pinned at 2.5).
  const tolerance = Math.min(5.0, chooseTolerance(part.shape) * factor.linear);
  // angularTolerance (radians) caps the angle between consecutive facet normals.
  // 0.1 rad ≈ 5.7° matches replicad's default and is tight enough that helical
  // surfaces (threads) tessellate smoothly. 0.3 rad — OCCT's coarse end —
  // produced visibly faceted threads on M3–M8.
  const meshData = part.shape.mesh({ tolerance, angularTolerance: factor.angular });

  const vertices = new Float32Array(meshData.vertices);
  const normals = new Float32Array(meshData.normals);
  const triangles = new Uint32Array(meshData.triangles);

  // Flatten replicad's `{start, count, faceId}[]` into `[start, count, …]`.
  // See TessellatedPart.faceGroups for why faceId is dropped rather than kept.
  const faceGroups = packGroups(meshData.faceGroups);

  let edgeVertices: Float32Array;
  let edgeGroups: Uint32Array | undefined;
  try {
    // Called AFTER mesh() on purpose. OCCT builds the triangulation lazily and
    // meshEdges reads it; calling it on an un-meshed shape returns lines that
    // do not line up with the mesh we are about to draw them over.
    const edgeData = part.shape.meshEdges({ tolerance });
    edgeVertices = new Float32Array(edgeData.lines);
    edgeGroups = packGroups(edgeData.edgeGroups);
  } catch {
    edgeVertices = new Float32Array(0);
  }

  return {
    name: part.name,
    color: part.color,
    vertices,
    normals,
    triangles,
    edgeVertices,
    ...(faceGroups ? { faceGroups } : {}),
    ...(edgeGroups ? { edgeGroups } : {}),
    // Propagate optional BOM metadata. Omit when absent so downstream
    // serializers don't render noise (`qty: undefined` / `material: undefined`).
    ...(typeof part.qty === "number" ? { qty: part.qty } : {}),
    ...(part.material ? { material: part.material } : {}),
    ...(part.analyze === false ? { analyze: false as const } : {}),
    ...(part.joints ? { joints: part.joints } : {}),
  };
}
