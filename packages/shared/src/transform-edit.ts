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
 * ## replicad's transforms CONSUME the shape they are called on
 *
 * `.translate`, `.rotate`, `.mirror` and `.scale` all end with `this.delete()`
 * — unlike the booleans, which leave both operands alive. So the moment a
 * transformed shape is named anywhere else, the other use is reading a deleted
 * object, and the render dies with "This object has been deleted" pointing at
 * a line that looks fine.
 *
 * A copy hits this by construction: the original entry and the moved one name
 * the same shape. So the copy's chain starts from `.clone()`. So does a move
 * whose subject is referenced elsewhere in the file — checked rather than
 * assumed, because a clone in the 95% case where nothing else refers to it is
 * noise in the reader's file.
 *
 * ## Copying leaves the original alone
 *
 * Fusion's "Create Copy" checkbox. Ticked, the transform does not touch the
 * body it was dragged from: a SECOND entry is written into the parts list,
 * carrying the moved expression and a new name. Everything else about the
 * entry — colour, quantity, material — comes across, because the copy is
 * built by splicing the original's own text rather than by reconstructing an
 * object literal from the two fields this module happens to know about.
 *
 * The shape expression then appears twice, so the same rule as a self-pivot
 * applies: anything that is not already a name is hoisted to a const first.
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
import { findPartSpan, listPartNames, type FaceOpEdit } from "./face-edit.js";
import { IDENTIFIER, freshName, hoistPoint } from "./hoist.js";
import { formatNumber } from "./param-edit.js";
import { readIdentifier, skipString, skipTrivia } from "./ts-scan.js";

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
  /**
   * Fusion's "Create Copy": leave the body where it is and write the moved
   * result as a NEW entry under this name.
   *
   * The name comes from the caller because the viewer is the side that knows
   * what is already on screen; the editor still refuses one the file already
   * uses, rather than writing two bodies that answer to the same name.
   */
  copyAs?: string;
}

export type TransformFailure =
  | "part-not-found"
  | "part-has-no-shape"
  | "unparseable"
  /** Nothing to write: no rotation and no translation. */
  | "no-change"
  /** A copy was asked for under a name the file already gives to a body. */
  | "name-taken";

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
  /** The name the copy was written under, when one was made. */
  copiedAs?: string;
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

  const copying = !!req.copyAs;
  if (copying && listPartNames(source).includes(req.copyAs!)) {
    return { ok: false, reason: "name-taken" };
  }

  const original = source.slice(span.span.start, span.span.end).trim();
  const edits: FaceOpEdit[] = [];
  let hoistedAs: string | undefined;

  // The shape expression is named twice by a self-pivot, and twice again by a
  // copy — once in the entry that stays and once in the entry that moves. In
  // either case a name is needed, because building the same OCCT chain twice
  // is a cost the file should not silently take on.
  let subject = original;
  let parenthesised = false;
  if ((copying || (rotating && req.rotate!.pivot === "self")) && !IDENTIFIER.test(original)) {
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

  // The chain has to start from a clone whenever the shape it transforms is
  // still needed afterwards — see the note about `this.delete()` above.
  const cloning =
    copying ||
    (hoistedAs === undefined &&
      IDENTIFIER.test(subject) &&
      referencedElsewhere(source, subject, span.span.start, span.span.end));
  let text = cloning ? `${subject}.clone()` : subject;
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

  if (copying) {
    // The original entry keeps its shape — except where hoisting replaced the
    // expression with the const's name, which is the same solid either way.
    if (hoistedAs) {
      edits.push({ start: span.span.start, end: span.span.end, text: hoistedAs });
    }
    edits.push(copyEntryEdit(source, span.span, text, req.copyAs!));
  } else {
    edits.push({ start: span.span.start, end: span.span.end, text });
  }
  edits.sort((a, b) => a.start - b.start);

  return {
    ok: true,
    edits,
    applied: text,
    parenthesised,
    ...(hoistedAs ? { hoistedAs } : {}),
    ...(copying ? { copiedAs: req.copyAs } : {}),
  };
}

/**
 * Is this identifier READ anywhere in the file other than the span we are
 * about to transform?
 *
 * A scan rather than a regex, because the two things that look most like a
 * reference are not one. `name: "base"` is a string — and part names routinely
 * match the const they were built from, so a regex says "referenced" for
 * essentially every file. `const base = …` is where the shape comes from, not
 * somewhere it is read afterwards. Both would force a `.clone()` into every
 * generated line.
 *
 * Still deliberately broad on the remaining cases: over-cloning costs one OCCT
 * copy and a word the reader can see, while under-cloning deletes a solid out
 * from under a later line.
 */
function referencedElsewhere(
  source: string,
  name: string,
  excludeStart: number,
  excludeEnd: number,
): boolean {
  let i = 0;
  let prev: string | null = null;
  while (i < source.length) {
    const before = i;
    i = skipTrivia(source, i);
    // `prev` deliberately survives whitespace and comments: it tracks the last
    // significant TOKEN, and `const /* x */ base` is still a declaration.
    // Clearing it here was why every generated line came out cloned.
    if (i !== before) continue;
    const c = source[i];
    if (c === undefined) break;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      if (end === -1) break;
      i = end;
      prev = null;
      continue;
    }
    const ident = readIdentifier(source, i);
    if (!ident) {
      prev = c;
      i++;
      continue;
    }
    if (ident.text === name) {
      const declaring = prev === "const" || prev === "let" || prev === "var";
      const property = prev === ".";
      const inside = i >= excludeStart && i < excludeEnd;
      if (!declaring && !property && !inside) return true;
    }
    prev = ident.text;
    i = ident.end;
  }
  return false;
}

/**
 * The edit that writes a second entry just below the original.
 *
 * Built by SPLICING the original's own text rather than by composing a fresh
 * object literal: an entry can carry a colour, a quantity, a material and a
 * `qty` this module has no business knowing about, and a copy that silently
 * dropped them would be a different body wearing the same shape.
 */
function copyEntryEdit(
  source: string,
  span: { objStart: number; objEnd: number; start: number; end: number; nameStart: number; nameEnd: number },
  shapeText: string,
  name: string,
): FaceOpEdit {
  const obj = source.slice(span.objStart, span.objEnd);
  const rel = (n: number) => n - span.objStart;
  // Descending, so the first splice does not move the second's offsets.
  const first = span.start < span.nameStart
    ? { at: [rel(span.nameStart), rel(span.nameEnd)], text: JSON.stringify(name) }
    : { at: [rel(span.start), rel(span.end)], text: shapeText };
  const second = span.start < span.nameStart
    ? { at: [rel(span.start), rel(span.end)], text: shapeText }
    : { at: [rel(span.nameStart), rel(span.nameEnd)], text: JSON.stringify(name) };
  let copy = obj.slice(0, first.at[0]!) + first.text + obj.slice(first.at[1]!);
  copy = copy.slice(0, second.at[0]!) + second.text + copy.slice(second.at[1]!);

  // The indentation of the line the original sits on, so the two entries line
  // up the way a hand-written list does.
  let lineStart = span.objStart;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, span.objStart))?.[0] ?? "";

  // Insert AFTER the original's trailing comma when it has one; otherwise add
  // the comma the original was missing and put the copy last.
  let after = span.objEnd;
  while (after < source.length && (source[after] === " " || source[after] === "\t")) after++;
  if (source[after] === ",") {
    return { start: after + 1, end: after + 1, text: `\n${indent}${copy},` };
  }
  return { start: span.objEnd, end: span.objEnd, text: `,\n${indent}${copy}` };
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
    case "name-taken":
      return `the file already has a body named "${detail}"`;
    case "unparseable":
      return "the file is shaped in a way this edit cannot make safely";
  }
}
