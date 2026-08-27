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
import { buildFaceHighlight } from "./mesh-builder";

/** Everything the picker needs about one rendered part. */
export interface PickablePart {
  name: string;
  /** The part's model mesh — the raycast target. */
  mesh: THREE.Mesh;
  vertices: Float32Array;
  triangles: Uint32Array;
  faceGroups?: Uint32Array;
  faceInfo?: FaceInfo[];
  /** Mirrors the parts panel's eye toggle; hidden parts are not pickable. */
  visible: boolean;
}

export interface FaceSelection {
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
  private hoverMesh: THREE.Mesh | null = null;
  private selectMesh: THREE.Mesh | null = null;
  private hovered: FaceSelection | null = null;
  private selected: FaceSelection | null = null;

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
      partIndex,
      partName: part.name,
      faceIndex,
      info,
      start: part.faceGroups![faceIndex * 2],
      count: part.faceGroups![faceIndex * 2 + 1],
    };
  }

  getSelection(): FaceSelection | null {
    return this.selected;
  }

  getHover(): FaceSelection | null {
    return this.hovered;
  }

  setHover(sel: FaceSelection | null): void {
    if (sameFace(sel, this.hovered)) return;
    // Never draw a hover over the face that is already selected — two stacked
    // translucent overlays read as a third, brighter state that means nothing.
    const suppress = sel !== null && sameFace(sel, this.selected);
    this.hovered = sel;
    this.hoverMesh = this.swap(this.hoverMesh, suppress ? null : sel, "hover");
  }

  setSelection(sel: FaceSelection | null): void {
    this.selected = sel;
    this.selectMesh = this.swap(this.selectMesh, sel, "select");
    // A face that just became selected must drop its hover overlay, or the two
    // stack; a face that just became deselected may legitimately regain one.
    if (sel && sameFace(sel, this.hovered)) {
      this.hoverMesh = this.swap(this.hoverMesh, null, "hover");
    }
  }

  /** Drop all state — call when the model is replaced. */
  clear(): void {
    this.setHover(null);
    this.setSelection(null);
  }

  private swap(
    current: THREE.Mesh | null,
    sel: FaceSelection | null,
    mode: "hover" | "select",
  ): THREE.Mesh | null {
    if (current) {
      this.overlayGroup.remove(current);
      current.geometry.dispose();
      (current.material as THREE.Material).dispose();
    }
    if (!sel) return null;
    const part = this.getParts()[sel.partIndex];
    if (!part) return null;
    const mesh = buildFaceHighlight(
      part.vertices,
      part.triangles,
      sel.start,
      sel.count,
      mode,
    );
    // The overlay group is a sibling of the part groups, so the part's own
    // transform (if any) has to be carried across for the copy to land on top.
    mesh.applyMatrix4(part.mesh.matrixWorld);
    this.overlayGroup.add(mesh);
    return mesh;
  }
}

function sameFace(a: FaceSelection | null, b: FaceSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.partIndex === b.partIndex && a.faceIndex === b.faceIndex;
}
