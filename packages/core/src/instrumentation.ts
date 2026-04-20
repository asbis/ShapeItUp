import { assertPositiveFinite } from "./stdlib/standards";
import {
  claimNonXYPlaneHint,
  emitExtrudePlaneHint,
  pushRuntimeWarning,
} from "./stdlib/warnings";

/**
 * WeakMap threading the plane-name from `Drawing.sketchOnPlane(plane)` to the
 * returned Sketch instance, so `Sketch.extrude` can emit the plane-aware
 * bounding-box hint (Issue #1 — silent Y ∈ [-20,0] on XZ sketches). Using a
 * WeakMap keeps the association per-sketch, per-run without polluting the
 * sketch object with enumerable properties that the user might observe. The
 * entry is populated in the `sketchOnPlane` post-hook below and consumed
 * lazily in `validateSketchExtrude`.
 */
const SKETCH_PLANE: WeakMap<object, string> = new WeakMap();

interface TimingEntry {
  count: number;
  totalMs: number;
}

let timings: Record<string, TimingEntry> = {};
let stack: string[] = [];

/**
 * Module-level handle to the replicad exports most recently passed through
 * `instrumentReplicadExports`. The fillet/chamfer validators need access to
 * `EdgeFinder` so they can evaluate a user-supplied filter callback against
 * the shape's edges BEFORE deferring to OCCT.
 *
 * The wrapper closure could, in principle, close over the exports directly,
 * but that would mean a PROTO_VALIDATORS entry owns a reference to the
 * exports object — awkward because the map is built once at module load,
 * while exports only arrive at initCore() time. A module-level slot is the
 * pragmatic compromise: one singleton core per process, one singleton
 * replicad module, one instrumented exports record — they all line up.
 */
let replicadExportsRef: Record<string, any> | null = null;

export function beginInstrumentation() {
  timings = {};
  stack = [];
}

export function getTimings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(timings)) {
    out[name] = Math.round(entry.totalMs * 100) / 100;
  }
  return out;
}

/**
 * Pre-OCCT argument validators for free replicad functions. Each validator
 * throws a readable TypeError before the underlying OCCT call runs, turning
 * opaque WASM-pointer exceptions into actionable errors the agent can
 * self-correct from (Bug #7 — zero-width rectangles silently producing
 * volume-0 solids, NaN parameters propagating into OCCT, etc.).
 *
 * Keyed by the replicad export name the user writes. Any function name not
 * in this map passes through unchanged.
 */
const VALIDATORS: Record<string, (...args: any[]) => void> = {
  drawRectangle: (w: unknown, h: unknown) => {
    assertPositiveFinite("drawRectangle", "width", w);
    assertPositiveFinite("drawRectangle", "height", h);
  },
  drawRoundedRectangle: (w: unknown, h: unknown, r: unknown) => {
    assertPositiveFinite("drawRoundedRectangle", "width", w);
    assertPositiveFinite("drawRoundedRectangle", "height", h);
    // Corner radius is allowed to be 0 (degrades to drawRectangle), but must
    // be finite and non-negative AND not exceed half the shorter side.
    if (r !== undefined) {
      if (typeof r !== "number" || !Number.isFinite(r) || r < 0) {
        throw new TypeError(
          `drawRoundedRectangle: radius must be a finite non-negative number, got ${String(r)} (${typeof r}).`,
        );
      }
      const wNum = w as number;
      const hNum = h as number;
      const limit = Math.min(wNum, hNum) / 2;
      if (r === limit) {
        if (wNum === hNum) {
          // Square case: r = w/2 = h/2 — shape degenerates to a circle.
          throw new TypeError(
            `drawRoundedRectangle: with width=${wNum} height=${hNum} radius=${r}, radius equals half the side — this degenerates to a circle. Use drawCircle(${r}) instead.`,
          );
        } else {
          // Rectangle case: r = min(w,h)/2 — shape degenerates to a "stadium"
          // (rectangle with fully-rounded semicircular ends), which
          // drawRoundedRectangle does not support.
          const [shorter, longer] = wNum < hNum ? [wNum, hNum] : [hNum, wNum];
          const halfSlot = (longer - shorter) / 2;
          throw new TypeError(
            `drawRoundedRectangle: with width=${wNum} height=${hNum} radius=${r}, radius equals half the shorter side — this degenerates to a stadium shape. ` +
              `Use the composition pattern instead: drawRectangle(${longer - shorter}, ${shorter}).fuse(drawCircle(${r}).translate(${halfSlot}, 0)).fuse(drawCircle(${r}).translate(-${halfSlot}, 0))`,
          );
        }
      }
      if (r > limit) {
        throw new TypeError(
          `drawRoundedRectangle: radius ${r} exceeds half the shorter side (${limit}). A rounded rectangle can't have corners larger than its own half-width.`,
        );
      }
    }
  },
  drawCircle: (r: unknown) => {
    assertPositiveFinite("drawCircle", "radius", r);
  },
  drawEllipse: (rx: unknown, ry: unknown) => {
    assertPositiveFinite("drawEllipse", "rx", rx);
    assertPositiveFinite("drawEllipse", "ry", ry);
  },
  drawPolysides: (radius: unknown, sides: unknown) => {
    // Note: replicad's signature is (radius, sides) — validate both.
    assertPositiveFinite("drawPolysides", "radius", radius);
    if (typeof sides !== "number" || !Number.isInteger(sides) || sides < 3) {
      throw new TypeError(
        `drawPolysides: sides must be an integer >= 3, got ${String(sides)} (${typeof sides}).`,
      );
    }
  },
  makeCylinder: (r: unknown, h: unknown) => {
    assertPositiveFinite("makeCylinder", "radius", r);
    assertPositiveFinite("makeCylinder", "height", h);
  },
  makeBox: (a: unknown, b: unknown, c: unknown) => {
    // makeBox has two overloads: (w, h, d) numbers or (corner1, corner2) points.
    // Only validate when it's clearly the three-number form.
    if (typeof a === "number" || typeof b === "number" || typeof c === "number") {
      assertPositiveFinite("makeBox", "width", a);
      assertPositiveFinite("makeBox", "height", b);
      assertPositiveFinite("makeBox", "depth", c);
    }
  },
  makeSphere: (r: unknown) => {
    assertPositiveFinite("makeSphere", "radius", r);
  },
  makeCone: (r1: unknown, r2: unknown, h: unknown) => {
    // A cone may have r1=0 OR r2=0 (degenerates to a sphere-cap-free cone),
    // but not both. Height must be positive.
    if (typeof r1 !== "number" || !Number.isFinite(r1) || r1 < 0) {
      throw new TypeError(`makeCone: r1 must be a finite non-negative number, got ${String(r1)}.`);
    }
    if (typeof r2 !== "number" || !Number.isFinite(r2) || r2 < 0) {
      throw new TypeError(`makeCone: r2 must be a finite non-negative number, got ${String(r2)}.`);
    }
    if (r1 === 0 && r2 === 0) {
      throw new TypeError(`makeCone: r1 and r2 cannot both be zero — the cone would have no surface.`);
    }
    assertPositiveFinite("makeCone", "height", h);
  },
  makeHelix: (pitch: unknown, height: unknown, radius: unknown) => {
    assertPositiveFinite("makeHelix", "pitch", pitch);
    assertPositiveFinite("makeHelix", "height", height);
    assertPositiveFinite("makeHelix", "radius", radius);
  },
  sketchHelix: (pitch: unknown, height: unknown, radius: unknown) => {
    assertPositiveFinite("sketchHelix", "pitch", pitch);
    assertPositiveFinite("sketchHelix", "height", height);
    assertPositiveFinite("sketchHelix", "radius", radius);
  },
};

/**
 * Pre-OCCT argument validators for shape/sketch methods.
 *
 * Keyed by `${className}.${methodName}` — matches the name instrumentation
 * uses in its timing stack. `_3DShape` is the base class of `Solid`,
 * `CompSolid`, and `Compound`, so hooking there covers all three.
 *
 * Validators receive the receiver as the first argument so they can inspect
 * `self.edges`, `self.blueprint`, etc. before the OCCT call runs.
 */
const PROTO_VALIDATORS_RAW: Record<string, (self: any, ...args: any[]) => void> = {
  // Bug #8: fillet/chamfer radius >= smallest edge length triggers an opaque
  // OCCT pointer exception. Compute minEdgeLength cheaply in JS and throw a
  // readable error before reaching WASM. Accept only the simple number form;
  // filtered/callback radii can legitimately skip short edges so we bail.
  fillet: (self: any, radiusConfig: unknown, filter?: unknown) => {
    guardRadiusAgainstEdges(self, radiusConfig, filter, "fillet");
  },
  chamfer: (self: any, radiusConfig: unknown, filter?: unknown) => {
    guardRadiusAgainstEdges(self, radiusConfig, filter, "chamfer");
  },
  // shell(thickness, finderFn, tolerance?) — positional form only. Config-
  // object form (first arg is a FaceFinder config) is skipped (thickness
  // arrives nested).
  shell: (self: any, thickness: unknown, finder?: unknown) => {
    if (typeof thickness === "number") {
      assertPositiveFinite("shell", "thickness", thickness);
    }
    // W2 empty-finder guard: if the user passed a face-filter callback and
    // it evaluates to zero faces, the shell will silently no-op (or throw
    // an opaque WASM error). Running the selector here in JS lets us emit
    // a readable message that names the likely fix.
    if (typeof finder === "function") {
      guardShellFaceFilter(self, finder);
    }
  },
  scale: (_self: any, factor: unknown) => {
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor === 0) {
      throw new TypeError(
        `scale: factor must be a finite non-zero number, got ${String(factor)} (${typeof factor}).`,
      );
    }
  },
  translate: (_self: any, x: unknown, y?: unknown, z?: unknown) => {
    validateTranslateArgs(x, y, z);
  },
  translateX: (_self: any, d: unknown) => {
    if (typeof d !== "number" || !Number.isFinite(d)) {
      throw new TypeError(`translateX: distance must be a finite number, got ${String(d)}.`);
    }
  },
  translateY: (_self: any, d: unknown) => {
    if (typeof d !== "number" || !Number.isFinite(d)) {
      throw new TypeError(`translateY: distance must be a finite number, got ${String(d)}.`);
    }
  },
  translateZ: (_self: any, d: unknown) => {
    if (typeof d !== "number" || !Number.isFinite(d)) {
      throw new TypeError(`translateZ: distance must be a finite number, got ${String(d)}.`);
    }
  },
  extrude: (self: any, distance: unknown) => {
    // Guards Sketch.extrude and Sketches.extrude — drawRectangle(0, 10)
    // yields a collapsed sketch whose extrude silently produces volume-0.
    validateSketchExtrude(self, distance);
  },
  revolve: (_self: any, _axis?: unknown, config?: unknown) => {
    validateRevolveConfig(config);
  },
  // Fix C: Replicad's `sketchOnPlane` accepts "XY"/"XZ"/"YZ" (front views) and
  // "YX"/"ZX"/"ZY" (back views). Users intuitively reach for "-XY"/"-XZ"/"-YZ"
  // to flip a sketch to the back side of a plane; those names LOOK right but
  // Replicad doesn't recognize them and the resulting error is an opaque
  // "Invalid plane name" from deep inside OCCT. Catch the negated form up
  // front and point the user at the right incantation.
  sketchOnPlane: (self: any, planeName: unknown) => {
    validateSketchOnPlane(self, planeName);
  },
};

/**
 * Keyed by `${className}.${methodName}` where className is whichever tag
 * `instrumentPrototype` used when wrapping the method. Because inheritance
 * means a method may be wrapped under the CHILD class name (not the defining
 * parent), we auto-expand `PROTO_VALIDATORS_RAW` to every plausible class
 * name that replicad uses — cheaper than reflecting on the runtime class
 * hierarchy.
 */
const SHAPE3D_CLASSES = [
  "_3DShape",
  "Solid",
  "Compound",
  "CompSolid",
  "Shape",
  "Shape3D",
];
const SKETCH_CLASSES = ["Sketch", "Sketches", "CompoundSketch"];
// Fix C: `sketchOnPlane` is a Drawing/Blueprint/CompoundBlueprint method. All
// three classes expose it in replicad; guard on each so the error fires
// regardless of which drawing helper the user started with.
const DRAWING_CLASSES = ["Drawing", "Blueprint", "CompoundBlueprint", "Blueprints"];

const PROTO_VALIDATORS: Record<string, (self: any, ...args: any[]) => void> = (() => {
  const out: Record<string, (self: any, ...args: any[]) => void> = {};
  for (const method of Object.keys(PROTO_VALIDATORS_RAW)) {
    const fn = PROTO_VALIDATORS_RAW[method];
    let classes: string[];
    if (method === "extrude" || method === "revolve") {
      classes = SKETCH_CLASSES;
    } else if (method === "sketchOnPlane") {
      classes = DRAWING_CLASSES;
    } else {
      classes = SHAPE3D_CLASSES;
    }
    // extrude/revolve live on Sketch/Sketches only; sketchOnPlane lives on the
    // Drawing family. All other validators apply to every 3D class that
    // inherits _3DShape.
    for (const cls of classes) {
      out[`${cls}.${method}`] = fn;
    }
  }
  return out;
})();

/**
 * Post-call hooks, invoked after the wrapped OCCT method returns successfully.
 * The hook receives the receiver, the returned value, and the original args so
 * it can carry state forward — used to thread the sketch-plane name from
 * `Drawing.sketchOnPlane(plane)` into the returned Sketch via WeakMap. Kept
 * deliberately minimal (one hook today) to avoid growing a parallel
 * validator pipeline; introduce a richer API only if a second use case
 * appears.
 */
const PROTO_POST_HOOKS_RAW: Record<
  string,
  (self: any, result: any, ...args: any[]) => void
> = {
  sketchOnPlane: (_self: any, result: any, planeName?: unknown) => {
    if (typeof planeName !== "string") return;
    if (result && typeof result === "object") {
      SKETCH_PLANE.set(result, planeName);
    }
  },
};

const PROTO_POST_HOOKS: Record<
  string,
  (self: any, result: any, ...args: any[]) => void
> = (() => {
  const out: Record<string, (self: any, result: any, ...args: any[]) => void> = {};
  for (const method of Object.keys(PROTO_POST_HOOKS_RAW)) {
    const fn = PROTO_POST_HOOKS_RAW[method];
    // Today the only post-hook is on sketchOnPlane — expand only over the
    // Drawing family, matching the pre-validator table above.
    const classes = method === "sketchOnPlane" ? DRAWING_CLASSES : SHAPE3D_CLASSES;
    for (const cls of classes) {
      out[`${cls}.${method}`] = fn;
    }
  }
  return out;
})();

/**
 * Bug #8 core: reject fillet/chamfer with a plain-number radius that's >=
 * the shortest edge on the shape. Returns early for non-number radii,
 * for filtered calls (filter may legitimately exclude short edges), and
 * for shapes with too many edges (inspection gets expensive — let OCCT
 * handle those). The error message names the exact smallest-edge length
 * and suggests a safe alternative so agents can self-correct in one step.
 */
function guardRadiusAgainstEdges(
  self: any,
  radiusConfig: unknown,
  filter: unknown,
  opName: "fillet" | "chamfer",
): void {
  if (typeof radiusConfig !== "number") return;
  if (!Number.isFinite(radiusConfig) || radiusConfig <= 0) {
    throw new TypeError(
      `${opName}: radius must be a positive finite number, got ${String(radiusConfig)}.`,
    );
  }

  // Determine which edges the operation will actually touch.
  //  - No filter → all of `self.edges`.
  //  - Filter    → run `filter(new EdgeFinder()).find(self)` to evaluate the
  //                user's selector against this shape, then guard only the
  //                filtered subset. Without this, a filter like
  //                `e => e.inDirection("Z")` on a 3mm-thick box would fall
  //                into the "filter present → skip" branch and a radius
  //                exceeding the 3mm edges would reach OCCT as a raw pointer
  //                exception (the reported WASM re-init bug).
  const edges = collectEdgesForGuard(self, filter, opName);
  if (edges === "skip") return;
  if (edges === "empty-filter") {
    // Was a throw. Agents routinely wrap .fillet() in try/catch per the skill
    // docs (to survive "radius too large" errors gracefully), which swallowed
    // the zero-match TypeError silently — the resulting shape looked correct
    // from the outside but had no fillets applied, and the agent had no way
    // to know. Emitting a runtime warning instead surfaces through the
    // engine's `warnings[]` channel (not catchable by user code) while still
    // letting the operation proceed; OCCT will return the shape unchanged
    // when the filter subset is empty, which is the intuitive "no-op" outcome
    // the agent was implicitly relying on.
    pushRuntimeWarning(
      `${opName}: filter matched 0 edges — operation had no effect. ` +
        `Check your finder (inDirection('Z'), inPlane('XY', offset), etc.) and ` +
        `use preview_finder to debug the selector.`,
    );
    return;
  }
  if (edges === "empty-unfiltered") {
    // Shape has no edges at all — the fillet/chamfer is a silent no-op.
    // Rare in practice (would require a shape with no topology, e.g. a
    // pre-boolean empty compound) but the warning is cheap insurance.
    pushRuntimeWarning(
      `${opName}(${radiusConfig}) called on a shape with no edges — operation had no effect.`,
    );
    return;
  }

  let minLen = Infinity;
  for (const e of edges) {
    const L = e?.length;
    if (typeof L === "number" && Number.isFinite(L) && L > 0 && L < minLen) {
      minLen = L;
    }
  }
  if (Number.isFinite(minLen) && radiusConfig >= minLen) {
    const suggested = (minLen * 0.45).toFixed(2);
    // Scope the message to "filtered edges" when a filter was in play — the
    // user needs to know the guard considered their subset, not the whole
    // shape (otherwise "minimum edge length 3mm" is confusing when their
    // box has 10mm edges that they deliberately filtered out).
    const scope = filter !== undefined ? "filtered edge" : "edge";
    throw new TypeError(
      `${opName}: radius ${radiusConfig}mm exceeds minimum ${scope} length ${minLen.toFixed(2)}mm. ` +
        `Reduce radius (try ${suggested}), or filter edges with .${opName}(r, (e) => e.inDirection("Z")). ` +
        `Apply ${opName}s BEFORE boolean cuts that may create tiny fragments.`,
    );
  }

  // Wall-thickness check (no-filter case only). An L-bracket with
  // thickness=4 and filletOuter=6 has 50mm-long vertical edges (so the
  // min-edge-length check above passes) but its adjacent faces are only
  // 4mm wide — OCCT can't physically fit a 6mm radius on a 4mm wall and
  // raises an opaque pointer exception. A cheap proxy: the shape's
  // overall bounding box minimum dimension. If the shape is thinner
  // than the radius in ANY direction, the fillet cannot fit. We skip
  // this on filtered calls because a filter may deliberately target
  // edges where the adjacent faces are wider than the shape's overall
  // bounding box minimum (e.g. chamfering the long spine of a thin
  // plate on its long axis).
  if (filter === undefined) {
    const minWall = collectShapeMinDimension(self);
    if (minWall !== null && radiusConfig >= minWall) {
      const suggested = (minWall * 0.45).toFixed(2);
      throw new TypeError(
        `${opName}: radius ${radiusConfig}mm exceeds wall thickness ${minWall.toFixed(2)}mm. ` +
          `The shape is thinner than the requested radius in at least one direction — the ` +
          `${opName} cannot physically fit. Reduce radius (try ${suggested}), or filter edges ` +
          `with .${opName}(r, (e) => e.inDirection("Z")) to target only edges whose adjacent ` +
          `faces are wider than the radius.`,
      );
    }
  }
}

/**
 * Return the smallest of width/height/depth on the shape's bounding box,
 * or null if we can't read it. Used as a cheap wall-thickness proxy for
 * the fillet/chamfer guard: if the shape is 4mm thin anywhere, a 6mm
 * fillet radius is physically impossible regardless of individual edge
 * lengths. We deliberately DO NOT walk the faces topology (expensive and
 * requires OCCT queries) — bounding-box min is a conservative lower
 * bound that catches the reported L-bracket class of failures.
 */
function collectShapeMinDimension(self: any): number | null {
  try {
    const bb = self?.boundingBox;
    if (!bb) return null;
    const w = bb.width;
    const h = bb.height;
    const d = bb.depth;
    const candidates: number[] = [];
    for (const v of [w, h, d]) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) candidates.push(v);
    }
    if (candidates.length === 0) return null;
    return Math.min(...candidates);
  } catch {
    return null;
  }
}

/**
 * W2 empty-finder guard for `shape.shell(thickness, faces_filter)`. If
 * the user's selector matches zero faces, the shell silently no-ops (or
 * raises an opaque WASM error). We evaluate the filter here with
 * replicad's FaceFinder and throw a readable error pointing to the
 * likely cause: a plane/direction that doesn't intersect the geometry.
 */
function guardShellFaceFilter(self: any, filter: Function): void {
  const FaceFinder = replicadExportsRef?.FaceFinder;
  if (typeof FaceFinder !== "function") return;
  // Bail if we can't cheaply inspect the shape's faces — e.g. a test
  // stub or an unusual compound whose `.faces` getter throws.
  let rawFaces: any[];
  try {
    const faces = self?.faces ?? [];
    if (!Array.isArray(faces) || faces.length === 0 || faces.length > 2000) return;
    rawFaces = faces;
  } catch {
    return;
  }
  let matched: any[];
  try {
    const finder = new FaceFinder();
    const configured = filter(finder);
    if (!configured || typeof configured.find !== "function") return;
    const result = configured.find(self);
    if (!Array.isArray(result)) return;
    matched = result;
  } catch {
    // Filter evaluation failed — defer to OCCT rather than masking the
    // real error with a spurious guard failure.
    return;
  }
  void rawFaces;
  if (matched.length === 0) {
    // Converted from throw → warning to match the fillet/chamfer empty-filter
    // path above. An agent that wrapped `.shell()` in try/catch would have
    // swallowed the throw and produced a "solid" output with no cavity —
    // visually convincing but wrong. Warning surfaces via engine.warnings[]
    // regardless of user try/catch. The original `shape.shell(...)` call
    // still runs; OCCT either no-ops on an empty face set or throws its own
    // error, which reaches the engine through the normal error path.
    pushRuntimeWarning(
      `shell: face-filter matched 0 faces — operation had no effect. Pass faces to remove via ` +
        "`shape.shell(thickness, f => f.inPlane('XY', top))` — an empty match " +
        `means the filter's plane/direction doesn't intersect the actual geometry. ` +
        `Use preview_finder to debug the selector before shelling.`,
    );
  }
}

/**
 * Resolve the set of edges a fillet/chamfer will actually touch. Returns
 * either the concrete array or a sentinel:
 *   - "skip"         → don't guard (edge inspection failed, too many edges,
 *                      or the filter couldn't be evaluated — defer to OCCT).
 *   - "empty-filter" → filter evaluated but matched zero edges; caller emits
 *                      a distinct error so the user knows the selector is
 *                      wrong, not the radius.
 *   - Edge[]         → proceed with min-length guarding.
 */
function collectEdgesForGuard(
  self: any,
  filter: unknown,
  opName: "fillet" | "chamfer",
): any[] | "skip" | "empty-filter" | "empty-unfiltered" {
  let rawEdges: any[];
  try {
    const edges = self?.edges ?? [];
    if (!Array.isArray(edges) || edges.length > 2000) return "skip";
    if (edges.length === 0) {
      // An unfiltered fillet on a zero-edge shape is a silent no-op. The
      // caller gets a distinct sentinel so it can warn (rather than "skip",
      // which was indistinguishable from "too many edges to inspect"). A
      // filtered call against zero edges is also degenerate, but filter
      // evaluation below is skipped — a zero-length `rawEdges` short-circuits
      // to `empty-unfiltered` regardless of whether the filter path was
      // reachable, because the outcome (no fillet applied) is identical.
      return "empty-unfiltered";
    }
    rawEdges = edges;
  } catch {
    return "skip";
  }

  if (filter === undefined) return rawEdges;
  if (typeof filter !== "function") return "skip";

  // We need access to `EdgeFinder` to evaluate the callback. If the replicad
  // module hasn't been instrumented yet (or doesn't expose EdgeFinder — e.g.
  // a unit-test mock that never set it), we can't safely evaluate the
  // filter, so defer to OCCT. This mirrors the prior behaviour for filtered
  // calls (no guard) only when evaluation is impossible — not when the
  // filter simply targets a subset.
  const EdgeFinder = replicadExportsRef?.EdgeFinder;
  if (typeof EdgeFinder !== "function") return "skip";

  let filtered: any[];
  try {
    // Replicad's Finder API: the callback receives an EdgeFinder, adds
    // filters to it, and returns the same finder. `.find(shape)` then
    // returns the concrete Edge[] that pass the filter.
    const finder = new EdgeFinder();
    const configured = filter(finder);
    if (!configured || typeof configured.find !== "function") return "skip";
    const result = configured.find(self);
    if (!Array.isArray(result)) return "skip";
    filtered = result;
  } catch {
    // The filter threw, or EdgeFinder rejected the shape — bail to OCCT,
    // which will produce its own (less friendly) error. Masking a real
    // filter bug with a spurious pre-check failure is worse than no guard.
    return "skip";
  }

  if (filtered.length === 0) return "empty-filter";
  // Cross-check: if the filter returned more edges than the shape has, the
  // evaluation is suspect (likely a misbehaving mock or a shared-edge
  // quirk); fall back to the raw edge set rather than an inflated count.
  if (filtered.length > rawEdges.length) return rawEdges;
  // `opName` is part of the signature for symmetry with the outer call; not
  // used here, but keeps the edge-collection helper generic for future use
  // (e.g. a shell guard that needs the same evaluator).
  void opName;
  return filtered;
}

/**
 * Bug #7 core: a Sketch built from drawRectangle(0, 10) / drawCircle(0) has
 * a degenerate 2D blueprint and extrudes into a volume-0 solid. OCCT doesn't
 * flag the result — it's "valid" topology, just useless. Check the
 * blueprint's 2D bounding box on the sketch before extruding to catch this
 * cheaply.
 */
function validateSketchExtrude(self: any, distance: unknown): void {
  if (typeof distance !== "number" || !Number.isFinite(distance) || distance === 0) {
    throw new TypeError(
      `extrude: distance must be a finite non-zero number, got ${String(distance)} (${typeof distance}).`,
    );
  }
  // Issue #1: if this Sketch came from a non-XY `sketchOnPlane`, the extrude
  // will grow into the plane's signed normal — "XZ" produces a slab with
  // Y ∈ [-L, 0], not the centered Y ∈ [-L/2, L/2] most users expect. Emit a
  // one-shot bbox-interval hint BEFORE deferring to OCCT. The latch inside
  // `emitExtrudePlaneHint` ensures we fire at most once per run, and the
  // helper returns null for "XY" so the conventional case stays silent.
  const plane = typeof self === "object" && self !== null ? SKETCH_PLANE.get(self) : undefined;
  if (typeof plane === "string") {
    const hint = emitExtrudePlaneHint(plane, distance);
    if (hint) pushRuntimeWarning(hint);
  }
  try {
    const bp = self?.blueprint;
    if (!bp) return;
    const bb = bp.boundingBox;
    if (!bb) return;
    const w = typeof bb.width === "number" ? bb.width : undefined;
    const h = typeof bb.height === "number" ? bb.height : undefined;
    if ((w !== undefined && w <= 0) || (h !== undefined && h <= 0)) {
      throw new TypeError(
        `Sketch has zero dimension (width=${w}, height=${h}); check for a parametric value that collapsed to 0 — e.g. drawRectangle(0, 10) or drawCircle(0).`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) throw err;
    // Any other inspection failure (unexpected blueprint shape, etc.) —
    // silently fall through; OCCT will report whatever it reports.
  }
}

/**
 * Fix C core: reject negated plane names ("-XY", "-XZ", "-YZ") with a
 * message that maps each to its valid Replicad-accepted swap ("YX", "ZX",
 * "ZY"). Without this guard, users hit an opaque "Invalid plane name" error
 * from deep inside OCCT.
 *
 * Note we DON'T reject every unknown plane name — Replicad may grow new ones
 * (custom planes, Plane objects). We only flag the specific negated-axis
 * form because it's a well-known user footgun with a known translation.
 */
function validateSketchOnPlane(self: any, planeName: unknown): void {
  if (typeof planeName !== "string") return;
  const match = /^-(XY|XZ|YZ)$/.exec(planeName);
  if (match) {
    const swapMap: Record<string, string> = { XY: "YX", XZ: "ZX", YZ: "ZY" };
    const swapped = swapMap[match[1]];
    throw new TypeError(
      `sketchOnPlane does not accept negated plane names ("${planeName}"). ` +
        `Use "${swapped}" for the same plane viewed from the other side, or ` +
        `pass a negative extrude length. Valid planes: XY, XZ, YZ, YX, ZX, ZY.`,
    );
  }
  // One-shot advisory: sketching on any plane other than "XY" means the pen's
  // hLine/vLine map to non-obvious world axes (e.g. on "ZX", hLine → world Z,
  // not X). The full mapping table lives in skill/SKILL.md "Pen axis
  // mapping". Fire at most once per run so a script with 50 sketches on XZ
  // doesn't spam 50 identical warnings.
  //
  // P-1 polish: suppress the hint when the drawing's 2D bounding box is
  // already centered on the origin (|cx| and |cy| each within 1 % of the
  // larger of width/height). A centered bbox means the user almost certainly
  // used coordinate-form primitives (drawRectangle, drawCircle — both
  // centered by construction) rather than the pen's hLine/vLine, so the
  // axis-mapping warning would just be noise. If the blueprint or its bbox
  // can't be read (e.g. a unit-test stub without `.blueprint`), we fall back
  // to firing the hint — preserving the prior behaviour for non-replicad
  // receivers.
  if (planeName !== "XY" && !isDrawingCenteredOnOrigin(self) && claimNonXYPlaneHint()) {
    pushRuntimeWarning(
      `sketchOnPlane("${planeName}"): pen hLine/vLine map to different world ` +
        `axes on each plane (e.g. on "ZX", hLine → world Z, vLine → world X). ` +
        `See skill/SKILL.md "Pen axis mapping" table before sketching.`,
    );
  }
}

/**
 * Heuristic for P-1: "does this drawing look like it was built with
 * coordinate-centered primitives (drawRectangle/drawCircle) rather than the
 * pen's hLine/vLine?". A centered 2D bounding box is a strong indicator
 * because the coordinate primitives place their geometry on origin while the
 * pen draws relative to wherever `startAt` left off.
 *
 * Returns `false` when we can't cheaply inspect the bbox (missing blueprint,
 * non-numeric center, inspection threw, etc.) so the caller defaults to
 * firing the warning — preserving the pre-polish behaviour in ambiguous
 * cases and keeping existing tests (which stub sketchOnPlane without a
 * blueprint) unaffected.
 */
function isDrawingCenteredOnOrigin(self: any): boolean {
  try {
    // Drawings expose `.boundingBox` directly; Blueprints / CompoundBlueprints
    // do too. The types share the BoundingBox2d shape (center: [cx, cy],
    // width, height).
    const bb = self?.boundingBox;
    if (!bb) return false;
    const center = bb.center;
    const w = typeof bb.width === "number" ? bb.width : NaN;
    const h = typeof bb.height === "number" ? bb.height : NaN;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
    // `center` is a 2D point — replicad returns a tuple [cx, cy], but some
    // wrappers return {x, y}. Tolerate both.
    let cx: number;
    let cy: number;
    if (Array.isArray(center)) {
      cx = Number(center[0]);
      cy = Number(center[1]);
    } else if (center && typeof center === "object") {
      cx = Number((center as any).x);
      cy = Number((center as any).y);
    } else {
      return false;
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
    // 1 % of the bigger dimension — generous enough to absorb float noise
    // from compound fuses, tight enough that a pen-drawn path starting
    // anywhere off-origin will fail the test.
    const scale = Math.max(Math.abs(w), Math.abs(h));
    if (scale === 0) return false;
    const eps = scale * 0.01;
    return Math.abs(cx) < eps && Math.abs(cy) < eps;
  } catch {
    return false;
  }
}

function validateRevolveConfig(config: unknown): void {
  if (!config || typeof config !== "object") return;
  const angle = (config as any).angle;
  if (angle === undefined) return;
  if (typeof angle !== "number" || !Number.isFinite(angle)) {
    throw new TypeError(
      `revolve: angle must be a finite number (in degrees), got ${String(angle)} (${typeof angle}).`,
    );
  }
  if (Math.abs(angle) > 1000) {
    throw new TypeError(
      `revolve: angle ${angle} is implausibly large — did you mean radians? Replicad expects DEGREES (0-360).`,
    );
  }
}

function validateTranslateArgs(x: unknown, y?: unknown, z?: unknown): void {
  // Two forms: translate(x, y, z) numbers or translate([x, y, z]) / translate({...}).
  // Only validate the three-number form here; array/point forms use their own
  // type checks downstream in replicad.
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new TypeError(`translate: x must be finite, got ${x}.`);
    if (y !== undefined && (typeof y !== "number" || !Number.isFinite(y))) {
      throw new TypeError(`translate: y must be a finite number, got ${String(y)}.`);
    }
    if (z !== undefined && (typeof z !== "number" || !Number.isFinite(z))) {
      throw new TypeError(`translate: z must be a finite number, got ${String(z)}.`);
    }
  }
}

export function instrumentReplicadExports(exports: Record<string, any>) {
  // Cache the exports so validators (specifically the fillet/chamfer guard)
  // can look up EdgeFinder when evaluating a user-supplied filter callback.
  replicadExportsRef = exports;
  const seenProtos = new WeakSet<object>();
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== "function") continue;
    const proto = value.prototype;
    const isClass =
      proto &&
      typeof proto === "object" &&
      Object.getOwnPropertyNames(proto).some((k) => k !== "constructor");
    if (isClass) {
      instrumentPrototype(name, proto, seenProtos);
    } else {
      exports[name] = wrap(name, value);
    }
  }
}

function instrumentPrototype(
  className: string,
  proto: any,
  seen: WeakSet<object>
) {
  if (!proto || seen.has(proto) || proto === Object.prototype) return;
  seen.add(proto);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor") continue;
    const desc = Object.getOwnPropertyDescriptor(proto, key);
    if (!desc) continue;
    if (typeof desc.value === "function" && desc.writable) {
      const opName = `${className}.${key}`;
      desc.value = wrap(opName, desc.value);
      Object.defineProperty(proto, key, desc);
    }
  }
  const parent = Object.getPrototypeOf(proto);
  if (parent && parent !== Object.prototype) {
    instrumentPrototype(className, parent, seen);
  }
}

function wrap(name: string, original: Function): Function {
  const validator = VALIDATORS[name];
  const protoValidator = PROTO_VALIDATORS[name];
  const postHook = PROTO_POST_HOOKS[name];
  return function wrapped(this: any, ...args: any[]) {
    // Pre-call validation — throws BEFORE the WASM call and before timing.
    // Validator throws are user errors, not performance events, so keep them
    // out of the timings record.
    if (validator) validator(...args);
    if (protoValidator) protoValidator(this, ...args);
    stack.push(name);
    const start = performance.now();
    try {
      const result = original.apply(this, args);
      if (result && typeof (result as any).then === "function") {
        const self = this;
        return (result as Promise<any>).then(
          (v) => {
            record(name, start);
            stack.pop();
            // Post-hook only runs on successful resolve — a rejected promise
            // has no meaningful return value to thread forward.
            if (postHook) {
              try {
                postHook(self, v, ...args);
              } catch {
                // Post-hooks are advisory; never let a bookkeeping error
                // corrupt the user's successful OCCT call.
              }
            }
            return v;
          },
          (err) => {
            record(name, start);
            stack.pop();
            tagError(err);
            throw err;
          }
        );
      }
      record(name, start);
      stack.pop();
      if (postHook) {
        try {
          postHook(this, result, ...args);
        } catch {
          // See async branch above — post-hook failures must not propagate.
        }
      }
      return result;
    } catch (err) {
      record(name, start);
      stack.pop();
      tagError(err);
      throw err;
    }
  };
}

function record(name: string, start: number) {
  const delta = performance.now() - start;
  const entry = timings[name] || { count: 0, totalMs: 0 };
  entry.count += 1;
  entry.totalMs += delta;
  timings[name] = entry;
}

function tagError(err: any) {
  if (!err || typeof err !== "object") return;
  const outermost = stack[0];
  if (outermost && !err.operation) {
    err.operation = outermost;
  }
}
