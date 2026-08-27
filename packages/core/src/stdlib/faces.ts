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

import { FaceFinder, Sketch, type Shape3D, type Face } from "replicad";
import { pushRuntimeWarning } from "./warnings";

export interface ExtrudeFaceOptions {
  /** Suppress the runtime warning when the face cannot be resolved. */
  silent?: boolean;
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
  opts: ExtrudeFaceOptions = {},
): Shape3D {
  // A zero push is a no-op, not an error — it is what a slider passes through
  // on its way somewhere else.
  if (!Number.isFinite(distance) || distance === 0) return shape;

  const warn = (msg: string) => {
    if (!opts.silent) pushRuntimeWarning(`extrudeFace: ${msg} Returning shape unchanged.`);
  };

  let face: Face;
  try {
    const matches = finder(new FaceFinder()).find(shape);
    if (matches.length === 0) {
      warn("no face matched the selector.");
      return shape;
    }
    if (matches.length > 1) {
      // Extruding "one of" several matches would be a coin flip that silently
      // changes which face it acts on as the model evolves.
      warn(`the selector matched ${matches.length} faces, but it must match exactly one.`);
      for (const m of matches) tryDelete(m);
      return shape;
    }
    face = matches[0];
  } catch (err) {
    warn(`could not evaluate the selector — ${errText(err)}.`);
    return shape;
  }

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
