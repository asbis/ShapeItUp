/**
 * Turning a body dragged in the viewer into a durable edit of the `.shape.ts` —
 * the source half of Fusion 360's Modify → Move/Copy.
 *
 * ## Why this one writes plain replicad, and Combine did not
 *
 * The boolean operations got stdlib wrappers because there was something worth
 * saying about their results: a union that merged nothing looks identical to
 * one that worked. A translate has no such failure. It always does exactly
 * what it says, so the honest thing to write is the call a replicad user would
 * have typed:
 *
 *     { shape: plate.translate(12, 0, 5), name: "plate" }
 *
 * rather than a helper that adds a name to remember and nothing else.
 *
 * ## Why the call is a SUFFIX, and when it needs parentheses
 *
 * Every face operation wraps — `op($SHAPE, …)` — specifically to sidestep
 * precedence. A suffix cannot do that: `.translate(…)` appended to
 * `cond ? a : b` binds to `b` alone and silently moves the wrong body. So the
 * expression is parenthesised whenever it is not already a plain identifier or
 * member/call chain. Common expressions stay clean; the dangerous ones get
 * their parentheses.
 *
 * ## Rotation needs a pivot, and a pivot must not be a frozen coordinate
 *
 * A translate is a delta and stays true however the model moves. A rotation
 * does not: it turns about a point, and that point has to be written down.
 * Writing the coordinates the manipulator measured would be the same trap the
 * face selectors exist to avoid — correct today, silently wrong the moment a
 * parameter moves the body.
 *
 * So neither offered pivot is a literal. The world origin is a constant.
 * "The body's own centre" is written as the EXPRESSION that computes it:
 *
 *     block.rotate(90, block.boundingBox.center, [0, 0, 1])
 *
 * which stays the body's centre no matter what the body becomes. That names
 * the expression twice, so a `shape:` that is not already an identifier is
 * hoisted to a const first — the same move, for the same reason, as a kept
 * tool in a combine.
 */
import { findPartSpan, type FaceOpEdit } from "./face-edit.js";
import { IDENTIFIER, freshName, hoistPoint } from "./hoist.js";
import { formatNumber } from "./param-edit.js";
import { skipString, skipTrivia } from "./ts-scan.js";

export type Triple = [number, number, number];

/**
 * Where a rotation turns.
 *
 * Both choices are written as something that keeps meaning what it says as the
 * model changes — see the note at the top of this module.
 */
export type TransformPivot =
  /** `[0, 0, 0]`. replicad's own default, and a constant. */
  | "origin"
  /** The body's own bounding-box centre, written as the expression for it. */
  | "self";

export interface TransformRotation {
  /** Degrees, the unit replicad's `rotate` takes. */
  angle: number;
  /** Unit vector to turn about. */
  axis: Triple;
  pivot: TransformPivot;
}

export interface TransformRequest {
  partName: string;
  /**
   * Applied FIRST, before the translation.
   *
   * Not an arbitrary choice: the manipulator turns the body about a pivot
   * fixed in the model's own coordinates and then slides the result, so
   * rotate-then-translate is what the user actually did. The other order would
   * turn the translation into part of the radius.
   */
  rotate?: TransformRotation;
  translate?: Triple;
}

export type TransformFailure =
  | "part-not-found"
  | "part-has-no-shape"
  | "unparseable"
  /** Nothing to write: no rotation and no translation. */
  | "no-change";

export interface TransformOk {
  ok: true;
  /** Non-overlapping, sorted by start — apply back-to-front. */
  edits: FaceOpEdit[];
  /** The expression as it will read after the edit. */
  applied: string;
  /** True when the expression had to be wrapped to keep the suffix safe. */
  parenthesised: boolean;
  /** Set when the shape expression was lifted to a `const` to be named twice. */
  hoistedAs?: string;
}

export type TransformResult = TransformOk | { ok: false; reason: TransformFailure };

/** Below this, a drag is a wobble rather than an intent. */
const EPSILON = 1e-6;

function isZero(v: Triple): boolean {
  return Math.abs(v[0]) < EPSILON && Math.abs(v[1]) < EPSILON && Math.abs(v[2]) < EPSILON;
}

function triple(v: Triple): string {
  return `[${v.map(formatNumber).join(", ")}]`;
}

/**
 * Produce the edit that moves and/or turns `partName`.
 *
 * Pure: it computes spans and text and never touches the file.
 */
export function computeTransformEdit(
  source: string,
  req: TransformRequest,
): TransformResult {
  const rotating = !!req.rotate && Math.abs(req.rotate.angle) > EPSILON;
  const moving = !!req.translate && !isZero(req.translate);
  if (!rotating && !moving) return { ok: false, reason: "no-change" };

  const span = findPartSpan(source, req.partName);
  if (!span.ok) return { ok: false, reason: span.reason };

  const original = source.slice(span.span.start, span.span.end).trim();
  const edits: FaceOpEdit[] = [];
  let hoistedAs: string | undefined;

  // A self-pivot names the shape a second time, inside its own transform
  // chain. That only works if the shape has a name — otherwise the expression
  // would be built twice, and an OCCT chain is not cheap.
  let subject = original;
  let parenthesised = false;
  if (rotating && req.rotate!.pivot === "self" && !IDENTIFIER.test(original)) {
    hoistedAs = freshName(source, req.partName, new Set());
    const at = hoistPoint(source, span.span.objStart);
    edits.push({
      start: at.at,
      end: at.at,
      text: `${at.indent}const ${hoistedAs} = ${original};\n`,
    });
    subject = hoistedAs;
  } else {
    parenthesised = needsParens(original);
    if (parenthesised) subject = `(${original})`;
  }

  let text = subject;
  if (rotating) {
    const r = req.rotate!;
    const onZ =
      Math.abs(r.axis[0]) < EPSILON && Math.abs(r.axis[1]) < EPSILON && r.axis[2] > 0;
    if (r.pivot === "origin" && onZ) {
      // `rotate(angle)` already means "about +Z through the origin" — spelling
      // it out would put three zeroes in the file for no reader's benefit.
      text += `.rotate(${formatNumber(r.angle)})`;
    } else {
      const pivot =
        r.pivot === "origin" ? triple([0, 0, 0]) : `${subject}.boundingBox.center`;
      text += `.rotate(${formatNumber(r.angle)}, ${pivot}, ${triple(r.axis)})`;
    }
  }
  if (moving) {
    const t = req.translate!;
    text += `.translate(${t.map(formatNumber).join(", ")})`;
  }

  edits.push({ start: span.span.start, end: span.span.end, text });
  edits.sort((a, b) => a.start - b.start);

  return {
    ok: true,
    edits,
    applied: text,
    parenthesised,
    ...(hoistedAs ? { hoistedAs } : {}),
  };
}

/**
 * Does appending `.method(…)` to this expression change what it applies to?
 *
 * True for anything with an operator at the top level. The check is
 * deliberately broad — a needless pair of parentheses is a cosmetic cost,
 * while a missing one silently moves a different body — but it is a real scan
 * rather than a regex, so an operator inside a string, a comment or a nested
 * call does not trigger it.
 */
export function needsParens(expr: string): boolean {
  const trimmed = expr.trim();
  if (trimmed.length === 0) return false;
  // `new Foo().bar()` and `new Foo.Bar()` bind differently, and telling them
  // apart is not worth the risk when a bracket costs nothing.
  if (/^(new|await|yield|typeof|void|delete)\b/.test(trimmed)) return true;

  let depth = 0;
  let i = 0;
  while (i < trimmed.length) {
    const before = i;
    i = skipTrivia(trimmed, i);
    if (i !== before) continue;
    const c = trimmed[i];
    if (c === undefined) break;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(trimmed, i);
      if (end === -1) return true; // unterminated: assume the worst
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      i++;
      continue;
    }
    // Only the TOP level matters: `f(a + b)` is a call, and a call takes a
    // suffix perfectly well.
    if (depth === 0 && "?:|&+-*/%=<>,^!~".includes(c)) return true;
    i++;
  }
  return false;
}

/**
 * Turn a refusal into prose. Sibling of describeCombineFailure, and here for
 * the same reason: both hosts need the same words, and the string goes
 * straight into the viewer's status line.
 */
export function describeTransformFailure(reason: TransformFailure, detail?: string): string {
  switch (reason) {
    case "part-not-found":
      return `no body named "${detail}" in the file — it may be built somewhere this editor cannot follow`;
    case "part-has-no-shape":
      return `the entry for "${detail}" has no shape: property`;
    case "no-change":
      return "nothing to write — the body has not moved";
    case "unparseable":
      return "the file is shaped in a way this edit cannot make safely";
  }
}
