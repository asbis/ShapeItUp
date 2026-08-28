/**
 * Face picking: turn a click on the canvas into "which face of which part",
 * and draw that answer.
 *
 * ## Why this can work at all
 *
 * replicad's `mesh()` returns, alongside the triangle buffer, a list of spans
 * saying which triangles belong to which face of the underlying B-Rep. Core
 * carries those spans through as `faceGroups`, plus a `faceInfo` descriptor per
 * span. So a raycast hit gives a triangle number, the spans give a face, and
 * the descriptor says what that face IS — planar or cylindrical, how big, which
 * way it points.
 *
 * ## Why the span index is not an identity
 *
 * It is tempting to treat the face index as a name and write it somewhere. It
 * is not one. OCCT enumerates faces deterministically for a given construction
 * sequence, so the index survives a parameter change — but add a hole and every
 * index after it shifts. replicad's own `faceId` is worse: it is a WASM heap
 * pointer that differs between two identical rebuilds, which is why core drops
 * it rather than passing it here.
 *
 * The index is therefore valid for exactly as long as the mesh it came from.
 * That is enough to highlight and to describe. Anything durable — a selector
 * written into a `.shape.ts` — has to be built from the GEOMETRY in `faceInfo`,
 * not from the index.
 */
import * as THREE from "three";
import type { FaceInfo } from "@shapeitup/shared";
import { buildEdgeHighlight, buildFaceHighlight } from "./mesh-builder";

/** Everything the picker needs about one rendered part. */
export interface PickablePart {
  name: string;
  /** The part's model mesh — the raycast target for faces. */
  mesh: THREE.Mesh;
  /** The part's edge lines, if drawn — the raycast target for edges. */
  edgeLines?: THREE.LineSegments;
  vertices: Float32Array;
  triangles: Uint32Array;
  faceGroups?: Uint32Array;
  faceInfo?: FaceInfo[];
  /** Edge line points, and the `[start, count]` spans that divide them. */
  edgeVertices?: Float32Array;
  edgeGroups?: Uint32Array;
  /** Mirrors the parts panel's eye toggle; hidden parts are not pickable. */
  visible: boolean;
}

export interface FaceSelection {
  kind: "face";
  partIndex: number;
  partName: string;
  /** Index into `faceGroups` pairs and `faceInfo` — see the note above. */
  faceIndex: number;
  info: FaceInfo;
  /** The triangle span, in index units into `triangles`. */
  start: number;
  count: number;
}

/**
 * Which face owns `triangleIndex`?
 *
 * `faceGroups` holds `[start, count]` pairs in INDEX units, and core's tests
 * assert the spans tile the whole triangle buffer with no gaps and no overlaps
 * — so a plain binary search on the sorted starts is exact, and every triangle
 * belongs to exactly one face. Returns -1 if the spans somehow do not cover the
 * hit, which is a "highlight nothing" outcome rather than a wrong highlight.
 */
export function faceIndexForTriangle(
  faceGroups: Uint32Array,
  triangleIndex: number,
): number {
  const target = triangleIndex * 3; // triangle number -> index into `triangles`
  let lo = 0;
  let hi = faceGroups.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = faceGroups[mid * 2];
    const count = faceGroups[mid * 2 + 1];
    if (target < start) hi = mid - 1;
    else if (target >= start + count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** OCCT surface-type tags, in words a person reading a CAD UI expects. */
const KIND_LABEL: Record<string, string> = {
  PLANE: "Planar face",
  CYLINDRE: "Cylindrical face",
  CONE: "Conical face",
  SPHERE: "Spherical face",
  TORUS: "Toroidal face",
  BEZIER_SURFACE: "Bézier face",
  BSPLINE_SURFACE: "Freeform face",
  REVOLUTION_SURFACE: "Revolved face",
  EXTRUSION_SURFACE: "Swept face",
  OFFSET_SURFACE: "Offset face",
  OTHER_SURFACE: "Face",
};

export function describeKind(kind: string): string {
  return KIND_LABEL[kind] ?? "Face";
}

/** mm² below 100 reads better as mm²; above that, cm². */
export function formatFaceArea(mm2: number): string {
  if (!Number.isFinite(mm2)) return "—";
  if (mm2 >= 100) return `${(mm2 / 100).toFixed(2)} cm²`;
  return `${mm2.toFixed(2)} mm²`;
}

export function formatTriple(v: [number, number, number], digits = 1): string {
  // -0 renders as "-0.0", which reads like a measurement rather than a zero.
  return v.map((n) => (Object.is(n, -0) ? 0 : n).toFixed(digits)).join(", ");
}

/**
 * Say where a planar face sits, in the vocabulary the source file uses.
 *
 * A plane whose normal is an axis is exactly the case replicad's
 * `inPlane("XY", offset)` describes, and saying so out loud is the honest
 * amount of help to give at this stage: it tells the user how their model is
 * actually structured without pretending we can yet write that selector into
 * the file for them.
 *
 * Returns null for anything that is not an axis-aligned plane — an oblique
 * face has no such shorthand, and inventing one would be worse than silence.
 */
export function describePlacement(info: FaceInfo): string | null {
  if (info.kind !== "PLANE" || !info.normal) return null;
  const [nx, ny, nz] = info.normal;
  // 0.999 is within ~2.6 degrees of the axis. Tighter than that and float
  // noise in the normal costs real faces their label; looser and a visibly
  // tilted face gets described as axis-aligned.
  const AXIS = 0.999;
  if (Math.abs(nz) > AXIS) return `Lies in XY at Z = ${fmtOffset(info.center[2])}`;
  if (Math.abs(ny) > AXIS) return `Lies in XZ at Y = ${fmtOffset(info.center[1])}`;
  if (Math.abs(nx) > AXIS) return `Lies in YZ at X = ${fmtOffset(info.center[0])}`;
  return null;
}

function fmtOffset(n: number): string {
  const v = Object.is(n, -0) ? 0 : n;
  // A trailing ".00" on a whole millimetre is noise in a one-line hint.
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

/**
 * Owns hover and selection state plus the two overlay meshes.
 *
 * Deliberately does NOT own the event listeners: the canvas already has a click
 * handler with a priority order (gnomon first, then the measure tool), and a
 * second listener racing it would make that order depend on registration
 * sequence. index.ts calls in.
 */
export class FacePicker {
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private hoverObj: THREE.Object3D | null = null;
  private selectObj: THREE.Object3D | null = null;
  private hovered: Selection | null = null;
  private selected: Selection | null = null;

  constructor(
    private overlayGroup: THREE.Group,
    private camera: THREE.Camera,
    private getParts: () => PickablePart[],
  ) {}

  /** Resolve a canvas-relative pointer position to a face, or null. */
  pick(clientX: number, clientY: number, canvas: HTMLElement): FaceSelection | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const parts = this.getParts();
    const targets: THREE.Mesh[] = [];
    for (const p of parts) {
      if (p.visible && p.faceGroups && p.faceInfo) targets.push(p.mesh);
    }
    if (targets.length === 0) return null;

    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    if (hit.faceIndex === undefined || hit.faceIndex === null) return null;

    const partIndex = parts.findIndex((p) => p.mesh === hit.object);
    if (partIndex < 0) return null;
    const part = parts[partIndex];
    const faceIndex = faceIndexForTriangle(part.faceGroups!, hit.faceIndex);
    if (faceIndex < 0) return null;
    const info = part.faceInfo![faceIndex];
    if (!info) return null;

    return {
      kind: "face",
      partIndex,
      partName: part.name,
      faceIndex,
      info,
      start: part.faceGroups![faceIndex * 2],
      count: part.faceGroups![faceIndex * 2 + 1],
    };
  }

  getSelection(): Selection | null {
    return this.selected;
  }

  getHover(): Selection | null {
    return this.hovered;
  }

  /**
   * Resolve a pointer position to the edge under it, or null.
   *
   * Edges win over faces near a border, the way they do in a CAD app: an edge
   * is a one-pixel-wide target, so it needs a grab radius, and inside that
   * radius it is almost certainly what the user is aiming at.
   *
   * `thresholdWorld` must be computed per frame from the camera distance — a
   * fixed world radius is a huge grab area when zoomed in and an unhittable
   * one when zoomed out.
   */
  pickEdge(
    clientX: number,
    clientY: number,
    canvas: HTMLElement,
    thresholdWorld: number,
  ): EdgeSelection | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, this.camera);

    const previous = this.raycaster.params.Line?.threshold;
    this.raycaster.params.Line = { threshold: thresholdWorld };

    try {
      const parts = this.getParts();
      const targets: THREE.LineSegments[] = [];
      for (const p of parts) {
        if (p.visible && p.edgeLines?.visible && p.edgeGroups && p.edgeVertices) {
          targets.push(p.edgeLines);
        }
      }
      if (targets.length === 0) return null;

      const hits = this.raycaster.intersectObjects(targets, false);
      if (hits.length === 0) return null;
      const hit = hits[0]!;
      if (hit.index === undefined || hit.index === null) return null;

      const partIndex = parts.findIndex((p) => p.edgeLines === hit.object);
      if (partIndex < 0) return null;
      const part = parts[partIndex]!;
      const edgeIndex = edgeIndexForPoint(part.edgeGroups!, hit.index);
      if (edgeIndex < 0) return null;

      const start = part.edgeGroups![edgeIndex * 2]!;
      const count = part.edgeGroups![edgeIndex * 2 + 1]!;
      const { point, length } = edgePointAndLength(part.edgeVertices!, start, count);
      return {
        kind: "edge",
        partIndex,
        partName: part.name,
        edgeIndex,
        start,
        count,
        point,
        length,
        straight: count <= 2,
      };
    } finally {
      this.raycaster.params.Line = { threshold: previous ?? 1 };
    }
  }

  setHover(sel: Selection | null): void {
    if (same(sel, this.hovered)) return;
    // Never draw a hover over what is already selected — two stacked
    // translucent overlays read as a third, brighter state that means nothing.
    const suppress = sel !== null && same(sel, this.selected);
    this.hovered = sel;
    this.hoverObj = this.swap(this.hoverObj, suppress ? null : sel, "hover");
  }

  setSelection(sel: Selection | null): void {
    this.selected = sel;
    this.selectObj = this.swap(this.selectObj, sel, "select");
    // What just became selected must drop its hover overlay, or the two stack;
    // what just became deselected may legitimately regain one.
    if (sel && same(sel, this.hovered)) {
      this.hoverObj = this.swap(this.hoverObj, null, "hover");
    }
  }

  /** Drop all state — call when the model is replaced. */
  clear(): void {
    this.setHover(null);
    this.setSelection(null);
  }

  private swap(
    current: THREE.Object3D | null,
    sel: Selection | null,
    mode: "hover" | "select",
  ): THREE.Object3D | null {
    if (current) {
      this.overlayGroup.remove(current);
      disposeOverlay(current);
    }
    if (!sel) return null;
    const part = this.getParts()[sel.partIndex];
    if (!part) return null;

    const obj =
      sel.kind === "face"
        ? buildFaceHighlight(part.vertices, part.triangles, sel.start, sel.count, mode)
        : buildEdgesHighlight(part, [sel.edgeIndex], mode);
    if (!obj) return null;

    // The overlay group is a sibling of the part groups, so the part's own
    // transform (if any) has to be carried across for the copy to land on top.
    obj.applyMatrix4(part.mesh.matrixWorld);
    this.overlayGroup.add(obj);
    return obj;
  }
}

function disposeOverlay(o: THREE.Object3D): void {
  const g = (o as THREE.Mesh).geometry;
  const m = (o as THREE.Mesh).material;
  g?.dispose?.();
  if (m instanceof THREE.Material) m.dispose();
}

function same(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind || a.partIndex !== b.partIndex) return false;
  return a.kind === "face"
    ? a.faceIndex === (b as FaceSelection).faceIndex
    : a.edgeIndex === (b as EdgeSelection).edgeIndex;
}

// ---------------------------------------------------------------------------
// Which edges will a fillet touch?
// ---------------------------------------------------------------------------

/** Index of the axis a standard plane's offset is measured along. */
const PLANE_AXIS: Record<string, 0 | 1 | 2> = { YZ: 0, XZ: 1, XY: 2 };

/**
 * The edges of `part` that lie in the given standard plane.
 *
 * This is the viewer's own answer to the question `EdgeFinder.inPlane(plane,
 * offset)` will be asked at build time, computed from the mesh alone: an edge
 * lies in the plane exactly when every point of its polyline does. No OCCT
 * call, no extra data over the wire — `edgeGroups` was already being carried.
 *
 * It exists so a fillet can be SHOWN before it is written. A radius typed into
 * a box is a guess about which edges you meant; nine highlighted edges are not.
 *
 * The tolerance is generous (0.01 mm) because these points made a Float32 round
 * trip from OCCT, and an edge missing its own plane by a rounding error would
 * be dropped from the preview while the real fillet still rounded it.
 */
export function edgesInPlane(
  part: PickablePart,
  plane: string,
  offset: number,
  /**
   * Optional: keep only edges within the picked face's extent. Two separate
   * bosses at the same height share a plane but not a boundary, and rounding
   * one should not light up the other.
   */
  bounds?: FaceBounds,
  tolerance = 0.01,
): number[] {
  const axis = PLANE_AXIS[plane];
  const { edgeVertices: v, edgeGroups: g } = part;
  if (axis === undefined || !v || !g) return [];

  const found: number[] = [];
  for (let i = 0; i < g.length; i += 2) {
    const start = g[i]!;
    const count = g[i + 1]!;
    if (count === 0) continue;
    let keep = true;
    for (let p = start; p < start + count; p++) {
      const x = v[p * 3]!;
      const y = v[p * 3 + 1]!;
      const z = v[p * 3 + 2]!;
      const along = axis === 0 ? x : axis === 1 ? y : z;
      if (Math.abs(along - offset) > tolerance) {
        keep = false;
        break;
      }
      if (bounds && !withinBounds(bounds, x, y, z)) {
        keep = false;
        break;
      }
    }
    if (keep) found.push(i / 2);
  }
  return found;
}

/** An axis-aligned box, in world mm, with a little slack. */
export interface FaceBounds {
  min: [number, number, number];
  max: [number, number, number];
}

function withinBounds(b: FaceBounds, x: number, y: number, z: number): boolean {
  return (
    x >= b.min[0] && x <= b.max[0] &&
    y >= b.min[1] && y <= b.max[1] &&
    z >= b.min[2] && z <= b.max[2]
  );
}

/**
 * The bounding box of one face's triangles, padded so an edge that grazes the
 * boundary is not excluded by float noise.
 *
 * Used to scope the fillet preview to the face the user actually picked. It is
 * an approximation of "the boundary of this face" — the authoritative answer
 * comes from the face's own wires at build time — but it is the right
 * approximation: it can only ever be too generous for a concave face, never
 * wrong about which face is meant.
 */
export function faceBounds(part: PickablePart, sel: FaceSelection, pad = 0.05): FaceBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = sel.start; t < sel.start + sel.count; t++) {
    const v = part.triangles[t]! * 3;
    for (let k = 0; k < 3; k++) {
      const c = part.vertices[v + k]!;
      if (c < min[k]!) min[k] = c;
      if (c > max[k]!) max[k] = c;
    }
  }
  for (let k = 0; k < 3; k++) {
    min[k] -= pad;
    max[k] += pad;
  }
  return { min, max };
}

/**
 * Build one LineSegments covering the given edges of a part, for the fillet
 * preview. Returns null when there is nothing to draw.
 */
export function buildEdgesHighlight(
  part: PickablePart,
  edgeIndices: number[],
  mode: "hover" | "select" = "select",
): THREE.LineSegments | null {
  const { edgeVertices: v, edgeGroups: g } = part;
  if (!v || !g || edgeIndices.length === 0) return null;

  // `edgeVertices` is ALREADY in LineSegments pair layout — replicad emits
  // `p0,p1, p1,p2, …` with interior vertices duplicated — so each span can be
  // copied verbatim. Re-pairing it as a polyline, as an earlier version did,
  // draws every segment twice plus a degenerate one between the duplicates.
  let points = 0;
  for (const e of edgeIndices) points += g[e * 2 + 1]!;
  if (points === 0) return null;

  const out = new Float32Array(points * 3);
  let w = 0;
  for (const e of edgeIndices) {
    const start = g[e * 2]!;
    const count = g[e * 2 + 1]!;
    out.set(v.subarray(start * 3, (start + count) * 3), w);
    w += count * 3;
  }
  return buildEdgeHighlight(out, mode);
}

// ---------------------------------------------------------------------------
// Picking ONE edge
// ---------------------------------------------------------------------------

export interface EdgeSelection {
  kind: "edge";
  partIndex: number;
  partName: string;
  /** Index into `edgeGroups` pairs. Valid only for the mesh it came from. */
  edgeIndex: number;
  /** Span of `edgeVertices`, in POINT units. */
  start: number;
  count: number;
  /** A point that lies exactly on the edge — what names it in generated code. */
  point: [number, number, number];
  /** Summed segment length, mm. */
  length: number;
  /** A single segment is a straight edge; more means it was tessellated. */
  straight: boolean;
}

export type Selection = FaceSelection | EdgeSelection;

/**
 * Which edge owns the segment starting at point index `pointIndex`?
 *
 * `edgeGroups` tiles the point buffer, so a binary search is exact. Returns -1
 * when the spans do not cover the hit, which highlights nothing rather than
 * highlighting the wrong edge.
 */
export function edgeIndexForPoint(edgeGroups: Uint32Array, pointIndex: number): number {
  let lo = 0;
  let hi = edgeGroups.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = edgeGroups[mid * 2]!;
    const count = edgeGroups[mid * 2 + 1]!;
    if (pointIndex < start) hi = mid - 1;
    else if (pointIndex >= start + count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * A point lying exactly on an edge, and the edge's length.
 *
 * `edgeVertices` is in THREE's LineSegments pair layout — `p0,p1, p1,p2, …` —
 * so a straight edge is two points and a curve is many, with every interior
 * vertex duplicated.
 *
 * For a straight edge the midpoint of the two endpoints is used: it is exactly
 * on the edge AND it is the value most likely to be a clean multiple of a
 * parameter, which is what makes the generated selector durable. For a curve
 * an actual tessellation VERTEX is used instead — vertices lie on the true
 * curve, while a midpoint between them would sit slightly inside the chord and
 * `containsPoint` would miss.
 */
export function edgePointAndLength(
  v: Float32Array,
  start: number,
  count: number,
): { point: [number, number, number]; length: number } {
  const at = (i: number): [number, number, number] => [v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!];

  let length = 0;
  for (let i = start; i + 1 < start + count; i += 2) {
    const a = at(i);
    const b = at(i + 1);
    length += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  if (count <= 2) {
    const a = at(start);
    const b = at(start + 1);
    return { point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], length };
  }
  // Round down to an even offset so the index lands on a segment START, which
  // is always a real vertex of the tessellation.
  const mid = start + 2 * Math.floor(count / 4);
  return { point: at(mid), length };
}

/**
 * The tangent-continuous chain of edges containing `edgeIndex`.
 *
 * OCCT propagates a fillet along edges that meet smoothly, which is standard
 * CAD behaviour and not optional. Measured on a plate with a rounded outline:
 * filleting ONE 68 mm edge with r=2 removed 229.1 mm³, where that edge alone
 * accounts for 58.4 and the whole outline for 231.5 — the fillet ran all the
 * way around. On the same plate with a SHARP outline, the same pick removed
 * 68.7 mm³, exactly the one edge.
 *
 * So a preview that highlights only the clicked edge is honest on a boxy part
 * and wrong on a rounded one. This walks the chain so it can be honest on both.
 *
 * Tangency is judged from the tessellated ends: two edges continue each other
 * when they share an endpoint and their directions there are parallel. `|dot|`
 * rather than `dot` because edge orientation is arbitrary — either end of
 * either edge may be the shared one.
 */
export function tangentChain(
  part: PickablePart,
  edgeIndex: number,
  angleToleranceDeg = 5,
  pointTolerance = 1e-3,
): number[] {
  const { edgeVertices: v, edgeGroups: g } = part;
  if (!v || !g) return [edgeIndex];

  const n = g.length / 2;
  const cosLimit = Math.cos((angleToleranceDeg * Math.PI) / 180);
  const at = (i: number): [number, number, number] => [v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!];
  const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const norm = (a: number[]) => {
    const L = Math.hypot(a[0]!, a[1]!, a[2]!) || 1;
    return [a[0]! / L, a[1]! / L, a[2]! / L];
  };
  const near = (a: number[], b: number[]) =>
    Math.abs(a[0]! - b[0]!) < pointTolerance &&
    Math.abs(a[1]! - b[1]!) < pointTolerance &&
    Math.abs(a[2]! - b[2]!) < pointTolerance;

  /** Both endpoints of an edge, with the direction pointing OUT of each. */
  const ends = (e: number) => {
    const s = g[e * 2]!;
    const c = g[e * 2 + 1]!;
    if (c < 2) return null;
    const first = at(s);
    const last = at(s + c - 1);
    return [
      { point: first, dir: norm(sub(at(s + 1), first)) },
      { point: last, dir: norm(sub(at(s + c - 2), last)) },
    ];
  };

  const cache = new Map<number, ReturnType<typeof ends>>();
  const endsOf = (e: number) => {
    if (!cache.has(e)) cache.set(e, ends(e));
    return cache.get(e)!;
  };

  const chain = new Set<number>([edgeIndex]);
  const queue = [edgeIndex];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const a = endsOf(cur);
    if (!a) continue;
    for (let other = 0; other < n; other++) {
      if (chain.has(other)) continue;
      const b = endsOf(other);
      if (!b) continue;
      for (const ea of a) {
        for (const eb of b) {
          if (!near(ea.point, eb.point)) continue;
          const dot = ea.dir[0]! * eb.dir[0]! + ea.dir[1]! * eb.dir[1]! + ea.dir[2]! * eb.dir[2]!;
          if (Math.abs(dot) >= cosLimit) {
            chain.add(other);
            queue.push(other);
          }
        }
      }
    }
  }
  return [...chain].sort((x, y) => x - y);
}
