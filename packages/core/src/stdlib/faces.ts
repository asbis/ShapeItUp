/**
 * Face-level modelling operations — the code half of the viewer's direct
 * manipulation.
 *
 * When you push or pull a face in the viewer, what gets written into your
 * `.shape.ts` is a call from this module. That is the whole point: the model
 * stays a program, and the GUI is a way of writing it rather than a separate
 * source of truth that has to be reconciled later.
 *
 * The face is named by a FINDER, not by an index or an id, because those do
 * not survive editing. replicad's `faceId` is a WASM heap pointer that differs
 * between two identical rebuilds; the position of a face in OCCT's enumeration
 * survives a parameter change but not a topology change. A geometric predicate
 * — "the face lying in XY at Z = thickness" — survives both, which is why
 * every generated call takes one.
 */

import { EdgeFinder, FaceFinder, Sketch, type Edge, type Shape3D, type Face } from "replicad";
import { pushRuntimeWarning } from "./warnings";

export interface FaceOpOptions {
  /** Suppress the runtime warning when the operation cannot be applied. */
  silent?: boolean;
  /**
   * Receives the material the operation adds or removes, when that solid
   * happens to exist as a by-product.
   *
   * Only {@link extrudeFace} calls it, and only because the prism it builds IS
   * the delta — handing it over costs nothing. The rounding helpers do not:
   * their delta is a thin sliver along the edges, and recovering it would mean
   * a `base.cut(result)` boolean measured at ~690 ms on an 80x60 plate, which
   * is not a price a live preview can pay.
   */
  onDelta?: (delta: Shape3D) => void;
}

/** @deprecated Use {@link FaceOpOptions}. Kept so existing scripts still type. */
export type ExtrudeFaceOptions = FaceOpOptions;

/**
 * Resolve a face finder to exactly one face, or explain why not.
 *
 * "Exactly one" is the contract for every operation here. Acting on one of
 * several matches would be a coin flip that silently changes which face it
 * touches as the model evolves — the failure mode these helpers exist to
 * avoid.
 */
function resolveFace(
  label: string,
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  warn: (msg: string) => void,
): Face | null {
  let matches: Face[];
  try {
    matches = finder(new FaceFinder()).find(shape);
  } catch (err) {
    warn(`could not evaluate the selector — ${errText(err)}.`);
    return null;
  }
  if (matches.length === 0) {
    warn("no face matched the selector.");
    return null;
  }
  if (matches.length > 1) {
    warn(`the selector matched ${matches.length} faces, but it must match exactly one.`);
    for (const m of matches) tryDelete(m);
    return null;
  }
  return matches[0]!;
}

/**
 * The edges bounding a face: its outer wire plus the wire of every hole in it.
 *
 * This is what "the edges around this face" means, and it is worth getting
 * from the face itself rather than from a plane predicate. On a plate whose
 * top has already been filleted, `EdgeFinder.inPlane("XY", 6)` returns 16
 * edges — the 12 that bound the face, plus 4 fillet arcs that merely START in
 * that plane and curve away to z = 2. Filleting those is meaningless, and OCCT
 * rejects the whole operation because of them.
 *
 * `outerWire()` and `innerWires()` each CONSUME the Face they are called on,
 * so the outer wire is taken from a clone. See extrudeFace for the same dance.
 */
function boundaryEdgesOf(face: Face): Edge[] {
  const outer = face.clone().outerWire();
  const inners = face.innerWires();
  const edges: Edge[] = [...outer.edges];
  for (const wire of inners) edges.push(...wire.edges);
  return edges;
}

/**
 * Push or pull one planar face along its own normal.
 *
 * Positive `distance` adds material (the face moves outward), negative removes
 * it. Holes in the face are preserved: the prism is built from the outer wire
 * with each inner wire cut back out of it, so pulling a drilled plate keeps
 * its holes instead of paving over them.
 *
 * Returns the shape unchanged, with a runtime warning, when the finder does
 * not resolve to exactly one planar face. A model that renders with a warning
 * is more useful than a render that throws — the warning surfaces in the
 * viewer, and the user still has something on screen to correct.
 *
 * @example
 *   extrudeFace(plate, (f) => f.inPlane("XY", thickness), 5)
 */
export function extrudeFace(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  distance: number,
  opts: FaceOpOptions = {},
): Shape3D {
  // A zero push is a no-op, not an error — it is what a slider passes through
  // on its way somewhere else.
  if (!Number.isFinite(distance) || distance === 0) return shape;

  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`extrudeFace: ${msg} Returning shape unchanged.`);
  };

  const face = resolveFace("extrudeFace", shape, finder, warn);
  if (!face) return shape;

  try {
    if (face.geomType !== "PLANE") {
      warn(`the face is ${face.geomType}, and only planar faces can be pushed along a normal.`);
      return shape;
    }
    const n = face.normalAt();
    const len = Math.hypot(n.x, n.y, n.z);
    if (!(len > 0)) {
      warn("the face has no usable normal.");
      return shape;
    }
    const dir: [number, number, number] = [n.x / len, n.y / len, n.z / len];

    // `outerWire()` and `innerWires()` each consume the Face they are called
    // on — call one and the other throws "This object has been deleted". So
    // the outer wire is taken from a clone and the inner wires from the
    // original. This is not defensive coding; it is the only way to get both.
    const outerWire = face.clone().outerWire();
    const innerWires = face.innerWires();

    let prism: Shape3D = new Sketch(outerWire).extrude(distance, {
      extrusionDirection: dir,
    }) as Shape3D;
    for (const wire of innerWires) {
      prism = prism.cut(
        new Sketch(wire).extrude(distance, { extrusionDirection: dir }) as Shape3D,
      );
    }

    // The prism IS the material this operation adds or removes, so a preview
    // can colour it without recomputing anything.
    opts.onDelta?.(prism);

    // A negative distance builds the prism back INTO the solid, so the same
    // geometry is subtracted rather than added.
    return distance > 0 ? shape.fuse(prism) : shape.cut(prism);
  } catch (err) {
    warn(`the extrusion failed — ${errText(err)}.`);
    return shape;
  }
}

function errText(err: unknown): string {
  // OCCT throws raw pointers through Emscripten, which stringify as bare
  // numbers; label them so the message does not read as a stray integer.
  if (typeof err === "number") return `OCCT error ${err}`;
  return err instanceof Error ? err.message : String(err);
}

function tryDelete(o: { delete?: () => void }): void {
  try {
    o.delete?.();
  } catch {
    /* freeing is best effort */
  }
}

/**
 * Round the edges around a picked face.
 *
 * Driven by the same FaceFinder as {@link extrudeFace}: the user picks one
 * face, and the operation resolves its boundary at build time. That keeps the
 * written line durable — `(f) => f.inPlane("XY", thickness)` follows the
 * parameter — while the exact set of edges is recomputed from the geometry it
 * actually finds, rather than frozen into the source.
 *
 * @example
 *   filletFace(plate, (f) => f.inPlane("XY", thickness), 2)
 */
export function filletFace(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  radius: number,
  opts: FaceOpOptions = {},
): Shape3D {
  return roundBoundary("filletFace", shape, finder, radius, opts);
}

/**
 * Bevel the edges around a picked face. The counterpart of {@link filletFace};
 * `distance` is the setback from the edge, not a radius.
 *
 * @example
 *   chamferFace(plate, (f) => f.inPlane("XY", thickness), 1)
 */
export function chamferFace(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  distance: number,
  opts: FaceOpOptions = {},
): Shape3D {
  return roundBoundary("chamferFace", shape, finder, distance, opts);
}

function roundBoundary(
  label: "filletFace" | "chamferFace",
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  size: number,
  opts: FaceOpOptions,
): Shape3D {
  if (!Number.isFinite(size) || size === 0) return shape;
  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`${label}: ${msg} Returning shape unchanged.`);
  };
  if (size < 0) {
    warn(`a negative ${label === "filletFace" ? "radius" : "setback"} is not meaningful.`);
    return shape;
  }

  const face = resolveFace(label, shape, finder, warn);
  if (!face) return shape;

  let edges: Edge[];
  try {
    edges = boundaryEdgesOf(face);
  } catch (err) {
    warn(`could not read the face's boundary — ${errText(err)}.`);
    return shape;
  }
  if (edges.length === 0) {
    warn("the face has no boundary edges.");
    return shape;
  }

  try {
    // `inList` is exact: these are the edge objects themselves, so there is no
    // predicate to be over- or under-inclusive about.
    return label === "filletFace"
      ? shape.fillet(size, (e) => e.inList(edges))
      : shape.chamfer(size, (e) => e.inList(edges));
  } catch (err) {
    // Some of these arrive already explained — core's own fillet guard says
    // things like "radius 40mm exceeds minimum filtered edge length 9.42mm.
    // Reduce radius (try 4.24)". Appending a vaguer sentence to a message
    // that good makes it worse, so the generic hint is added only when OCCT
    // gave us nothing but a pointer.
    const detail = errText(err);
    const opaque = /^OCCT error \d+$/.test(detail);
    warn(
      opaque
        ? `${detail}. The size is probably too large for the surrounding ` +
            `material, or those edges have already been rounded.`
        : detail,
    );
    return shape;
  }
}

/**
 * Round ONE edge, named by a point that lies on it.
 *
 * The single-edge counterpart of {@link filletFace}. It insists on exactly one
 * match, because that is the gesture it exists to serve: the user clicked one
 * edge, and a selector that has quietly come to match three would round two
 * they never picked.
 *
 * Write the point in terms of the model's parameters —
 * `[0, -depth / 2, thickness]`, not `[0, -30, 8]`. A frozen point stops lying
 * on the edge the moment the part changes size, and the operation then
 * disappears. The viewer does this binding automatically and says so when it
 * cannot.
 *
 * @example
 *   filletEdge(plate, (e) => e.containsPoint([0, -depth / 2, thickness]), 2)
 */
export function filletEdge(
  shape: Shape3D,
  finder: (e: EdgeFinder) => EdgeFinder,
  radius: number,
  opts: FaceOpOptions = {},
): Shape3D {
  return roundOneEdge("filletEdge", shape, finder, radius, opts);
}

/** The chamfer counterpart of {@link filletEdge}. */
export function chamferEdge(
  shape: Shape3D,
  finder: (e: EdgeFinder) => EdgeFinder,
  distance: number,
  opts: FaceOpOptions = {},
): Shape3D {
  return roundOneEdge("chamferEdge", shape, finder, distance, opts);
}

function roundOneEdge(
  label: "filletEdge" | "chamferEdge",
  shape: Shape3D,
  finder: (e: EdgeFinder) => EdgeFinder,
  size: number,
  opts: FaceOpOptions,
): Shape3D {
  if (!Number.isFinite(size) || size === 0) return shape;
  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`${label}: ${msg} Returning shape unchanged.`);
  };
  if (size < 0) {
    warn(`a negative ${label === "filletEdge" ? "radius" : "setback"} is not meaningful.`);
    return shape;
  }

  let edges: Edge[];
  try {
    edges = finder(new EdgeFinder()).find(shape);
  } catch (err) {
    warn(`could not evaluate the selector — ${errText(err)}.`);
    return shape;
  }
  if (edges.length === 0) {
    // Overwhelmingly the reason is a point written as fixed numbers that the
    // geometry has since moved away from.
    warn(
      "no edge contains that point. If it was written as fixed coordinates, " +
        "they no longer land on the edge — express them with the model's parameters.",
    );
    return shape;
  }
  if (edges.length > 1) {
    warn(`the point lies on ${edges.length} edges, but it must identify exactly one.`);
    for (const e of edges) tryDelete(e);
    return shape;
  }

  try {
    return label === "filletEdge"
      ? shape.fillet(size, (e) => e.inList(edges))
      : shape.chamfer(size, (e) => e.inList(edges));
  } catch (err) {
    const detail = errText(err);
    const opaque = /^OCCT error \d+$/.test(detail);
    warn(
      opaque
        ? `${detail}. The size is probably too large for this edge, or it has ` +
            `already been rounded.`
        : detail,
    );
    return shape;
  }
}

/**
 * The largest radius OCCT will actually accept here, found by asking it.
 *
 * Both cheap heuristics were measured against the truth on a plate filleted on
 * its top face, at three thicknesses:
 *
 *     thickness   true limit   minEdge x 0.45   wall x 0.45
 *         4          3.98          19.79           1.80
 *        10          9.92          19.79           4.50
 *        25         24.92          19.79          11.25
 *
 * The edge-length rule does not track anything (it is the bore's circumference,
 * constant across all three), and the wall rule is right about the shape of the
 * answer but 55% too conservative. Neither is good enough to bound a slider
 * with: too low and you cannot reach radii that work, too high and the drag
 * walks into failures.
 *
 * So this asks OCCT directly. A single fillet attempt costs 4-9 ms on that
 * plate and the shape survives it, so one shape and one edge list serve every
 * probe — a ten-step bisection lands around 50 ms, paid once when the operation
 * is armed rather than per drag step.
 *
 * Returns 0 when even a hairline radius fails, which is the honest answer for
 * an edge that cannot be rounded at all.
 */
/**
 * Hollow a solid, leaving the picked face(s) open — Fusion 360's Shell.
 *
 * The finder names the faces to REMOVE, not the ones to keep. That reads
 * backwards until you have done it once, and it is replicad's convention as
 * well as Fusion's: you point at the opening.
 *
 * `thickness` is the wall left behind, offset INWARD. There is no outward
 * form here — an outward shell grows the part past the size you designed it
 * to be, which in a printed enclosure means it no longer fits what it was
 * measured against.
 *
 * Returns the shape unchanged, with a runtime warning, when the finder
 * resolves to nothing or OCCT refuses the thickness — same contract as the
 * rest of this module, and for the same reason: a model that renders with a
 * warning beats a render that throws.
 *
 * @example
 *   shellFace(box, (f) => f.inPlane("XY", height), 2)
 */
export function shellFace(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  thickness: number,
  opts: FaceOpOptions = {},
): Shape3D {
  if (!Number.isFinite(thickness) || thickness <= 0) return shape;

  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`shellFace: ${msg}`);
  };

  // Unlike the other operations here, MORE than one match is legitimate: an
  // enclosure open at both ends is a real part, and Fusion lets you pick
  // several faces too. Zero is still an error — it is the silent no-op the
  // whole module exists to prevent.
  let matched: number;
  try {
    const faces = finder(new FaceFinder()).find(shape);
    matched = faces.length;
    for (const f of faces) tryDelete(f);
  } catch (err) {
    warn(`could not evaluate the selector — ${errText(err)}.`);
    return shape;
  }
  if (matched === 0) {
    warn("no face matched the selector, so nothing would be opened.");
    return shape;
  }

  try {
    return shape.shell(thickness, finder);
  } catch (err) {
    warn(
      `OpenCascade refused a ${thickness}mm wall — ${errText(err)}. ` +
        "The limit is the thinnest region the offset passes through.",
    );
    return shape;
  }
}

export function probeMaxRadius(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  kind: "face",
  upperBound: number,
  iterations?: number,
): number;
export function probeMaxRadius(
  shape: Shape3D,
  finder: (e: EdgeFinder) => EdgeFinder,
  kind: "edge",
  upperBound: number,
  iterations?: number,
): number;
export function probeMaxRadius(
  shape: Shape3D,
  finder: any,
  kind: "face" | "edge",
  upperBound: number,
  iterations = 10,
): number {
  if (!Number.isFinite(upperBound) || upperBound <= 0) return 0;

  let edges: Edge[];
  try {
    edges =
      kind === "face"
        ? boundaryEdgesOf(resolveFaceOrThrow(shape, finder))
        : finder(new EdgeFinder()).find(shape);
  } catch {
    return 0;
  }
  if (edges.length === 0) return 0;

  const fits = (r: number): boolean => {
    try {
      shape.fillet(r, (e) => e.inList(edges));
      return true;
    } catch {
      return false;
    }
  };

  // A hairline that already fails means nothing here can be rounded.
  const floor = Math.min(0.01, upperBound / 1000);
  if (!fits(floor)) return 0;

  let lo = floor;
  let hi = upperBound;
  // Only bisect if the upper bracket actually fails; otherwise the bound is
  // the answer and there is nothing to search for.
  if (fits(hi)) return hi;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** resolveFace without the warning plumbing — the probe reports by returning 0. */
function resolveFaceOrThrow(shape: Shape3D, finder: (f: FaceFinder) => FaceFinder): Face {
  const matches = finder(new FaceFinder()).find(shape);
  if (matches.length !== 1) {
    for (const m of matches) tryDelete(m);
    throw new Error(`expected exactly one face, got ${matches.length}`);
  }
  return matches[0]!;
}

/**
 * The thickest wall this shell can actually take, found by asking OCCT.
 *
 * Same bisection as {@link probeMaxRadius} and for the same reason: every
 * closed-form rule for this is wrong. The obvious one — half the smallest
 * bounding-box dimension — describes a CLOSED shell, and shelling always
 * removes a face. On a 40 x 30 x 10 box open at the top it predicts 5.0 where
 * the truth is just under 10.
 *
 * A shell attempt is the expensive one of these probes, so the bracket starts
 * at the smallest bounding-box dimension rather than at half the diagonal:
 * no wall can exceed the part's own thinnest extent, and starting there saves
 * several failing steps on every call.
 */
export function probeMaxShell(
  shape: Shape3D,
  finder: (f: FaceFinder) => FaceFinder,
  upperBound: number,
  iterations = 8,
): number {
  if (!Number.isFinite(upperBound) || upperBound <= 0) return 0;

  // A finder that matches nothing does not fail — it builds a CLOSED shell,
  // which is a different operation with a different (much lower) limit.
  // Reporting that number as this operation's ceiling would be measuring the
  // wrong thing, so agree with shellFace and refuse.
  try {
    const faces = finder(new FaceFinder()).find(shape);
    const n = faces.length;
    for (const f of faces) tryDelete(f);
    if (n === 0) return 0;
  } catch {
    return 0;
  }

  const fits = (t: number): boolean => {
    try {
      shape.shell(t, finder);
      return true;
    } catch {
      return false;
    }
  };

  const floor = Math.min(0.05, upperBound / 500);
  if (!fits(floor)) return 0;
  if (fits(upperBound)) return upperBound;

  let lo = floor;
  let hi = upperBound;
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
