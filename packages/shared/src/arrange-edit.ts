/**
 * Mirror and Pattern — Fusion 360's Create → Mirror and Create → Pattern,
 * written into the `.shape.ts`.
 *
 * Both make copies of a body, which is why they live together and next door to
 * {@link computeTransformEdit}: the same three problems recur — replicad's
 * transforms consume their input, a shape named twice must be a `const`, and
 * "new body" means splicing a second entry rather than rewriting the first.
 *
 * ## Mirror is the durable one
 *
 * `shape.mirror("XZ")` carries no coordinates at all. Not a pivot, not an
 * offset — a standard plane through the origin, which means the same thing
 * whatever the model becomes. Of everything the viewport can write, this is
 * the only operation with nothing in it to go stale.
 *
 * ## Pattern is a wrap, mirror can be either
 *
 * A pattern's copies are one body by construction — `patterns.repeat` fuses
 * them — so it replaces the shape expression. A mirror can go either way, and
 * the choice is real: joined gives you a symmetric part, separate gives you a
 * left hand and a right hand.
 */
import { findPartSpan, listPartNames, type FaceOpEdit } from "./face-edit.js";
import { IDENTIFIER, freshName, hoistPoint } from "./hoist.js";
import { formatNumber } from "./param-edit.js";
import { copyEntryEdit } from "./transform-edit.js";

/** The three standard planes, which are also the only mirror planes offered. */
export type MirrorPlane = "XY" | "XZ" | "YZ";

export type ArrangeSpec =
  | { kind: "mirror"; plane: MirrorPlane }
  /** Fusion's Rectangular Pattern: counts and spacings on two axes. */
  | { kind: "grid"; nx: number; ny: number; dx: number; dy: number; plane: MirrorPlane }
  /** Fusion's Circular Pattern. */
  | { kind: "polar"; count: number; radius: number; axis: "X" | "Y" | "Z" };

export interface ArrangeRequest {
  partName: string;
  spec: ArrangeSpec;
  /**
   * Write the result as a NEW body under this name instead of replacing the
   * original's shape.
   *
   * Only meaningful for a mirror. A pattern's copies are already fused into
   * one solid, so "as a new body" would mean a second body that contains the
   * original — which is not a thing anyone wants.
   */
  asNewBody?: string;
}

export type ArrangeFailure =
  | "part-not-found"
  | "part-has-no-shape"
  | "unparseable"
  | "name-taken"
  | "bad-spec";

export interface ArrangeOk {
  ok: true;
  edits: FaceOpEdit[];
  /** The expression as it will read after the edit. */
  applied: string;
  /** Set when the shape expression was lifted to a `const` to be named twice. */
  hoistedAs?: string;
  /** The name a new body was written under, when one was made. */
  copiedAs?: string;
  /** The stdlib helper the call needs in scope, if any. */
  needsImport?: string;
}

export type ArrangeResult = ArrangeOk | { ok: false; reason: ArrangeFailure };

/** Counts are whole and positive; spacings and radii are finite. */
function specIsSane(spec: ArrangeSpec): boolean {
  const whole = (n: number) => Number.isInteger(n) && n >= 1;
  const num = (n: number) => Number.isFinite(n);
  switch (spec.kind) {
    case "mirror":
      return true;
    case "grid":
      // 1x1 is a no-op dressed as a pattern.
      return whole(spec.nx) && whole(spec.ny) && spec.nx * spec.ny > 1 && num(spec.dx) && num(spec.dy);
    case "polar":
      return whole(spec.count) && spec.count > 1 && num(spec.radius) && spec.radius > 0;
  }
}

/**
 * Produce the edit that mirrors or patterns `partName`.
 *
 * Pure: it computes spans and text and never touches the file.
 */
export function computeArrangeEdit(source: string, req: ArrangeRequest): ArrangeResult {
  if (!specIsSane(req.spec)) return { ok: false, reason: "bad-spec" };

  const span = findPartSpan(source, req.partName);
  if (!span.ok) return { ok: false, reason: span.reason };

  const copying = !!req.asNewBody;
  if (copying && listPartNames(source).includes(req.asNewBody!)) {
    return { ok: false, reason: "name-taken" };
  }

  const original = source.slice(span.span.start, span.span.end).trim();
  const edits: FaceOpEdit[] = [];
  let hoistedAs: string | undefined;

  // Every form here names the shape at least twice — a joined mirror fuses it
  // with its own reflection, a pattern's entry keeps naming it, a new body
  // sits beside it. So it needs a name, or the OCCT chain gets built twice.
  let subject = original;
  if (!IDENTIFIER.test(original)) {
    hoistedAs = freshName(source, req.partName, new Set());
    const at = hoistPoint(source, span.span.objStart);
    edits.push({
      start: at.at,
      end: at.at,
      text: `${at.indent}const ${hoistedAs} = ${original};\n`,
    });
    subject = hoistedAs;
  }

  let text: string;
  let needsImport: string | undefined;

  if (req.spec.kind === "mirror") {
    // `.mirror` consumes its receiver, and the original is still needed —
    // either by the entry that stays, or by the fuse on the same line.
    const reflected = `${subject}.clone().mirror("${req.spec.plane}")`;
    if (copying) {
      text = reflected;
    } else {
      text = `joinBodies(${subject}, ${reflected})`;
      needsImport = "joinBodies";
    }
  } else {
    const placements =
      req.spec.kind === "grid"
        ? `patterns.grid(${req.spec.nx}, ${req.spec.ny}, ${formatNumber(req.spec.dx)}, ${formatNumber(req.spec.dy)}` +
          (req.spec.plane === "XY" ? ")" : `, { plane: "${req.spec.plane}" })`)
        : `patterns.polar(${req.spec.count}, ${formatNumber(req.spec.radius)}` +
          (req.spec.axis === "Z" ? ")" : `, { axis: "${req.spec.axis}" })`);
    // `repeat`, not `spread`: the factory form makes `() => body` — the
    // obvious call — free the body on the first placement.
    text = `patterns.repeat(${subject}, ${placements})`;
    needsImport = "patterns";
  }

  if (copying) {
    if (hoistedAs) {
      edits.push({ start: span.span.start, end: span.span.end, text: hoistedAs });
    }
    edits.push(copyEntryEdit(source, span.span, text, req.asNewBody!));
  } else {
    edits.push({ start: span.span.start, end: span.span.end, text });
  }
  edits.sort((a, b) => a.start - b.start);

  return {
    ok: true,
    edits,
    applied: text,
    ...(hoistedAs ? { hoistedAs } : {}),
    ...(copying ? { copiedAs: req.asNewBody } : {}),
    ...(needsImport ? { needsImport } : {}),
  };
}

/** Turn a refusal into prose, for the status line. */
export function describeArrangeFailure(reason: ArrangeFailure, detail?: string): string {
  switch (reason) {
    case "part-not-found":
      return `no body named "${detail}" in the file — it may be built somewhere this editor cannot follow`;
    case "part-has-no-shape":
      return `the entry for "${detail}" has no shape: property`;
    case "name-taken":
      return `the file already has a body named "${detail}"`;
    case "bad-spec":
      return "those numbers do not describe a pattern — counts must be whole and at least one copy has to move";
    case "unparseable":
      return "the file is shaped in a way this edit cannot make safely";
  }
}
