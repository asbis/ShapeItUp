/**
 * Lifting an inline expression to a named `const`.
 *
 * Shared by the two editors that need it. Combining bodies needs it when a
 * kept tool's `shape:` is an expression rather than a name — inlining would
 * build the same OCCT chain twice. Rotating about a body's own centre needs it
 * for the same reason: the durable pivot is `<expr>.boundingBox.center`, which
 * mentions the expression a second time.
 */
import { readIdentifier, skipBalanced, skipString, skipTrivia } from "./ts-scan.js";

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

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
export function hoistPoint(source: string, pos: number): { at: number; indent: string } {
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
export function topLevelStatementStarts(source: string): number[] {
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
export function freshName(source: string, partName: string, claimed: Set<string>): string {
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
