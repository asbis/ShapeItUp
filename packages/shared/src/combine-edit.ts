/**
 * Turning two bodies picked in the viewer into a durable edit of the
 * `.shape.ts` — the source half of Fusion 360's Modify → Combine.
 *
 * ## What the edit has to do
 *
 * A combine is not a wrap around one expression, which is all a face operation
 * ever is. It moves geometry BETWEEN two entries of the parts list:
 *
 *     return [
 *       { shape: base,   name: "base" },
 *       { shape: bracket, name: "bracket" },
 *     ];
 *
 * becomes
 *
 *     return [
 *       { shape: joinBodies(base, bracket), name: "base" },
 *     ];
 *
 * The target keeps its name and colour — Fusion names the result after the
 * target too — and the tool's entry goes away, because a body that has been
 * absorbed is no longer a body. That deletion IS Fusion's "Keep Tools"
 * checkbox, unticked. Ticked, the entry stays and the two coexist.
 *
 * ## Why the tool's expression is moved rather than referenced
 *
 * When the tool's `shape:` is already a plain identifier there is nothing to
 * decide: the call names it, and the const it came from is still there. When
 * it is an expression, the choice matters.
 *
 * Dropping the entry and INLINING the expression is right, because nothing
 * else refers to it any more — the text moves, and the model is unchanged.
 *
 * Keeping the entry and inlining would be wrong: the expression would then be
 * evaluated twice, and an OCCT chain is not cheap. So a kept tool is HOISTED
 * to a `const` first, and both the call and the surviving entry refer to that.
 * One evaluation, one name, and a file that reads the way someone would have
 * written it by hand.
 */
import {
  ensureStdlibImport,
  findPartSpan,
  type FaceOpEdit,
} from "./face-edit.js";
import { readIdentifier, skipBalanced, skipString, skipTrivia } from "./ts-scan.js";

/** The three operations Fusion's Combine dialog offers. */
export type CombineOpKind = "join" | "cut" | "intersect";

export interface CombineRequest {
  op: CombineOpKind;
  /** The body that survives, keeping its name and colour. */
  targetName: string;
  /** The bodies merged into, subtracted from, or intersected with it. */
  toolNames: string[];
  /** Fusion's "Keep Tools": leave the tool bodies in the parts list. */
  keepTools?: boolean;
}

export type CombineFailure =
  | "part-not-found"
  | "part-has-no-shape"
  | "unparseable"
  | "no-tools"
  /** The same body was named as both target and tool. */
  | "self-combine";

export type CombineResult =
  | {
      ok: true;
      /** Non-overlapping, sorted by start — apply back-to-front. */
      edits: FaceOpEdit[];
      /** The call written over the target's `shape:` value. */
      applied: string;
      /** True when an `import { … } from "shapeitup"` was added or extended. */
      addedImport: boolean;
      /** Tool bodies whose entries were removed from the parts list. */
      removed: string[];
      /** Tool bodies lifted to a `const` so a kept entry need not re-evaluate. */
      hoisted: string[];
    }
  | { ok: false; reason: CombineFailure; detail?: string };

const HELPER: Record<CombineOpKind, string> = {
  join: "joinBodies",
  cut: "cutBodies",
  intersect: "intersectBodies",
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Produce the edits that combine `toolNames` into `targetName`.
 *
 * Pure: it computes spans and text and never touches the file. The caller
 * applies the edits back-to-front, which is safe because they are guaranteed
 * not to overlap — see the ordering note at the end of this function.
 */
export function computeCombineEdit(source: string, req: CombineRequest): CombineResult {
  const tools = req.toolNames.filter((n) => n !== req.targetName);
  if (req.toolNames.length === 0) return { ok: false, reason: "no-tools" };
  if (tools.length !== req.toolNames.length) {
    return { ok: false, reason: "self-combine", detail: req.targetName };
  }

  const targetSpan = findPartSpan(source, req.targetName);
  if (!targetSpan.ok) return { ok: false, reason: targetSpan.reason, detail: req.targetName };

  const toolSpans: Array<{ name: string; span: ReturnType<typeof findPartSpan> }> = [];
  for (const name of tools) {
    const span = findPartSpan(source, name);
    if (!span.ok) return { ok: false, reason: span.reason, detail: name };
    toolSpans.push({ name, span });
  }

  const edits: FaceOpEdit[] = [];
  const removed: string[] = [];
  const hoisted: string[] = [];
  // Names claimed by hoists earlier in this same call, so two tools that would
  // both sanitise to `plate` do not collide with each other.
  const claimed = new Set<string>();
  const args: string[] = [];

  for (const { name, span } of toolSpans) {
    if (!span.ok) continue; // unreachable — narrowing only
    const expr = source.slice(span.span.start, span.span.end).trim();

    if (IDENTIFIER.test(expr)) {
      // Already a name. Nothing to move, nothing to duplicate.
      args.push(expr);
    } else if (req.keepTools) {
      const varName = freshName(source, name, claimed);
      claimed.add(varName);
      const at = hoistPoint(source, span.span.objStart);
      // The indent goes on the LINE WE ADD, not after its newline: the
      // statement we are inserting above still carries its own indentation in
      // the source, so appending one here would double it and leave the new
      // const flush against the margin.
      edits.push({
        start: at.at,
        end: at.at,
        text: `${at.indent}const ${varName} = ${expr};\n`,
      });
      // The surviving entry refers to the const too, so the expression is
      // built once and both uses are demonstrably the same solid.
      edits.push({ start: span.span.start, end: span.span.end, text: varName });
      args.push(varName);
      hoisted.push(name);
    } else {
      args.push(expr);
    }

    if (!req.keepTools) {
      const del = entryDeletionSpan(source, span.span.objStart, span.span.objEnd);
      edits.push({ start: del.start, end: del.end, text: "" });
      removed.push(name);
    }
  }

  const toolArg = args.length === 1 ? args[0]! : `[${args.join(", ")}]`;
  const helper = HELPER[req.op];
  const original = source.slice(targetSpan.span.start, targetSpan.span.end);
  const applied = `${helper}(${original}, ${toolArg})`;
  edits.push({ start: targetSpan.span.start, end: targetSpan.span.end, text: applied });

  const importEdit = ensureStdlibImport(source, helper);
  if (importEdit) edits.push(importEdit);

  // Sorted, and asserted non-overlapping. The spans come from different object
  // literals and from the import line, so they cannot legitimately overlap —
  // but "cannot" is exactly the kind of claim that turns into a corrupted file
  // when a script does something this module did not anticipate. Refusing is
  // cheap; a mangled `.shape.ts` is not.
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < edits.length; i++) {
    const prev = edits[i - 1]!;
    const cur = edits[i]!;
    if (cur.start < prev.end) return { ok: false, reason: "unparseable" };
  }

  return { ok: true, edits, applied, addedImport: importEdit !== null, removed, hoisted };
}

/** Apply non-overlapping edits back-to-front. Exported for tests and hosts. */
export function applyEdits(source: string, edits: FaceOpEdit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * The span to delete so that removing one array element leaves valid syntax.
 *
 * An element carries a comma on one side or the other, and which side depends
 * on whether it is the last one. Deleting the literal alone leaves `[, ]` or
 * `[a, ]`; the first is a syntax error and the second is a hole in the array
 * that TypeScript reads as `undefined`.
 *
 * Leading indentation is eaten too when the element had a line to itself, so
 * the removal does not leave a blank line behind.
 */
function entryDeletionSpan(
  source: string,
  objStart: number,
  objEnd: number,
): { start: number; end: number } {
  let start = objStart;
  let end = objEnd;

  // Prefer the trailing comma: it belongs to this element in the common
  // multi-line, trailing-comma style these files are written in.
  let after = end;
  while (after < source.length && (source[after] === " " || source[after] === "\t")) after++;
  if (source[after] === ",") {
    end = after + 1;
  } else {
    // Last element — take the comma in front of it instead.
    let before = start;
    while (before > 0 && /[ \t\r\n]/.test(source[before - 1]!)) before--;
    if (source[before - 1] === ",") start = before - 1;
  }

  // Swallow the rest of the line, so a one-element-per-line list closes up
  // rather than growing a blank row.
  let lineStart = start;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  const isOwnLine = source.slice(lineStart, start).trim() === "";
  if (isOwnLine) {
    let tail = end;
    while (tail < source.length && (source[tail] === " " || source[tail] === "\t")) tail++;
    if (source[tail] === "\r") tail++;
    if (source[tail] === "\n") {
      return { start: lineStart, end: tail + 1 };
    }
  }
  return { start, end };
}

/**
 * Where a hoisted `const` can go: the start of the line holding the statement
 * that contains `pos`.
 *
 * "The statement that contains it" rather than "just before the return"
 * because the parts list is not always returned directly — it is just as often
 * built into a `const parts = [...]` and returned on the next line, and
 * inserting after that array would put the const below its own use.
 *
 * Correct without a containment test: statement starts are enumerated in order
 * and everything nested inside brackets is skipped whole, so the last one at
 * or before `pos` is necessarily the statement `pos` sits inside.
 */
function hoistPoint(source: string, pos: number): { at: number; indent: string } {
  const starts = topLevelStatementStarts(source);
  let chosen = 0;
  for (const s of starts) {
    if (s <= pos) chosen = s;
    else break;
  }
  let lineStart = chosen;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart--;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, chosen))?.[0] ?? "";
  return { at: lineStart, indent };
}

/**
 * The offsets at which statements begin one level inside a brace block —
 * which, for a `.shape.ts`, is the body of `main`.
 *
 * Brackets and parens are skipped WHOLE. Without that, every line of a
 * multi-line `return [ … ]` would look like a statement start, because an
 * array's elements sit at the same brace depth as the `return` itself — and a
 * const hoisted to one of those lands inside the array literal.
 */
function topLevelStatementStarts(source: string): number[] {
  const starts: number[] = [];
  let depth = 0;
  let atStart = false;
  let i = 0;
  while (i < source.length) {
    const before = i;
    i = skipTrivia(source, i);
    if (i !== before) continue;
    const c = source[i];
    if (c === undefined) break;

    if (c === "{") {
      depth++;
      if (depth === 1) atStart = true;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 1) atStart = true;
      i++;
      continue;
    }
    if (depth === 1 && atStart) {
      starts.push(i);
      atStart = false;
    }
    if (c === ";") {
      if (depth === 1) atStart = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (c === "[" || c === "(") {
      const end = skipBalanced(source, i, c, c === "[" ? "]" : ")");
      if (end === -1) {
        i++;
        continue;
      }
      i = end;
      continue;
    }
    const ident = readIdentifier(source, i);
    i = ident ? ident.end : i + 1;
  }
  return starts;
}

/**
 * An identifier derived from a part name that nothing in the file already
 * uses.
 *
 * Shadowing an existing binding would compile and then silently build the
 * wrong solid, so the check is a word-boundary search over the whole source
 * rather than a scope analysis — broader than necessary, and wrong only in the
 * direction of picking a slightly uglier name.
 */
function freshName(source: string, partName: string, claimed: Set<string>): string {
  let base = partName.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[0-9]/, "_$&");
  if (!base || !IDENTIFIER.test(base)) base = "tool";
  const taken = (n: string) =>
    claimed.has(n) || new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\b`).test(source);
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}_body`;
}

/**
 * Turn a refusal into prose.
 *
 * Lives here rather than in either host because both hosts need the same
 * words, and because the string goes straight into the viewer's status line —
 * where an enum name would tell the user nothing about what to do next.
 */
export function describeCombineFailure(reason: CombineFailure, detail?: string): string {
  switch (reason) {
    case "part-not-found":
      return `no body named "${detail}" in the file — it may be built somewhere this editor cannot follow`;
    case "part-has-no-shape":
      return `the entry for "${detail}" has no shape: property`;
    case "self-combine":
      return "a body cannot be combined with itself";
    case "no-tools":
      return "pick a second body to combine with";
    case "unparseable":
      return "the file is shaped in a way this edit cannot make safely";
  }
}
