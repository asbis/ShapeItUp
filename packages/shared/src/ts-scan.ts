/**
 * A minimal TypeScript/JavaScript source scanner.
 *
 * Shared by every feature that has to EDIT a `.shape.ts` in place —
 * `param-edit.ts` (change a number) and `face-edit.ts` (wrap an expression in
 * a call). Both need to walk source without being fooled by a brace inside a
 * string, a comma inside a regex, or a keyword inside a comment, and neither
 * can justify pulling a real parser into a browser bundle.
 *
 * It is a scanner, not a parser: it knows how to SKIP things correctly, and
 * nothing about what they mean. Every consumer is expected to give up and
 * report a typed failure rather than guess when the shape it wants is not
 * where it expected — an edit that lands in the wrong place is much worse
 * than an edit that does not happen.
 */

/**
 * Advance past whatever non-code token starts at `i`: whitespace, a line
 * comment, or a block comment. Returns the new index, or `i` unchanged when a
 * real token starts there.
 */
export function skipTrivia(src: string, i: number): number {
  for (;;) {
    const c = src[i];
    if (c === undefined) return i;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, src.length);
      continue;
    }
    return i;
  }
}

/**
 * Advance past the string starting at `i` (which must be a quote character).
 * Handles escapes, and `${ ... }` substitutions in template literals — those
 * nest arbitrarily (`` `${ `${x}` }` ``) so the interpolation is walked with
 * the generic value scanner rather than a brace counter.
 *
 * Returns the index just past the closing quote, or -1 if unterminated.
 */
export function skipString(src: string, i: number): number {
  const quote = src[i];
  const template = quote === "`";
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (template && c === "$" && src[i + 1] === "{") {
      const end = skipBalanced(src, i + 1, "{", "}");
      if (end === -1) return -1;
      i = end;
      continue;
    }
    // A non-template string never spans a raw newline; treat that as malformed
    // rather than swallowing the rest of the file looking for a close quote.
    if (!template && (c === "\n" || c === "\r")) return -1;
    i++;
  }
  return -1;
}

export const IDENT_START = /[A-Za-z_$]/;
export const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Advance past a regex literal starting at `i`.
 *
 * Only ever called from a VALUE position — right after a `:` — where a `/`
 * cannot be division, because division would need a left operand. That removes
 * the usual regex-vs-divide lexing ambiguity without tracking token context.
 *
 * The character class matters: `/[/}]/` contains delimiters that must not
 * terminate the literal. Returns -1 if unterminated.
 */
export function skipRegex(src: string, i: number): number {
  if (src[i] !== "/") return -1;
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "\n" || c === "\r" || c === undefined) return -1;
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      i++;
      while (i < src.length && IDENT_PART.test(src[i]!)) i++; // flags
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Walk from an opening bracket at `i` to just past its match, skipping trivia
 * and strings so a `}` inside a comment or string can't close the group.
 * Returns -1 when unbalanced.
 */
export function skipBalanced(src: string, i: number, open: string, close: string): number {
  if (src[i] !== open) return -1;
  let depth = 0;
  // Last significant character seen, for the regex-vs-division call below.
  let prev = "";
  while (i < src.length) {
    const before = i;
    i = skipTrivia(src, i);
    if (i !== before) continue;
    const c = src[i];
    if (c === undefined) return -1;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      if (end === -1) return -1;
      i = end;
      prev = "'";
      continue;
    }
    if (c === "/" && startsRegex(prev)) {
      // A regex body can hold `,` `}` `{` that must not be read as structure.
      const end = skipRegex(src, i);
      if (end === -1) return -1;
      i = end;
      prev = "/";
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    } else if (c === "{" || c === "[" || c === "(") {
      // A different bracket kind nested inside — walk it as a unit so its
      // contents can't be mistaken for ours.
      const end = skipBalanced(src, i, c, c === "{" ? "}" : c === "[" ? "]" : ")");
      if (end === -1) return -1;
      i = end;
      prev = ")";
      continue;
    }
    prev = c;
    i++;
  }
  return -1;
}

/**
 * The standard regex-vs-division heuristic: `/` opens a regex unless the
 * previous significant token could END an expression. After a value —
 * `x`, `2`, `)`, `]`, `}`, a string — it is division.
 *
 * Imperfect for keywords that read as identifiers (`return /re/`), which is a
 * known limitation of the heuristic and cannot occur inside an object literal's
 * value position, the only place this runs.
 */
export function startsRegex(prev: string): boolean {
  if (prev === "") return true;
  return !(IDENT_PART.test(prev) || prev === ")" || prev === "]" || prev === "}" || prev === "'");
}

/** Read the identifier at `i`, or null if one doesn't start there. */
export function readIdentifier(src: string, i: number): { text: string; end: number } | null {
  if (!IDENT_START.test(src[i] ?? "")) return null;
  let j = i + 1;
  while (j < src.length && IDENT_PART.test(src[j]!)) j++;
  return { text: src.slice(i, j), end: j };
}

/** Advance to just past the next top-level comma (or to `limit`). */
export function skipToNextEntry(src: string, i: number, limit: number): number {
  const end = skipValue(src, i, limit);
  if (end === -1) return limit;
  return end < limit && src[end] === "," ? end + 1 : end;
}

/**
 * Walk one value, stopping at the comma or closing brace that ends it.
 * Nested objects, arrays, calls and strings are traversed as units.
 */
export function skipValue(src: string, i: number, limit: number): number {
  const first = skipTrivia(src, i);
  while (i < limit) {
    const before = i;
    i = skipTrivia(src, i);
    if (i !== before) continue;
    if (i >= limit) break;

    const c = src[i]!;
    if (c === "," || c === "}") return i;
    if (c === "/" && i === first) {
      // Trivia was already skipped, so this `/` is neither `//` nor `/*`.
      // At the head of a value it can only open a regex literal — and its body
      // may contain `,` or `}` that would otherwise look like our terminator.
      const end = skipRegex(src, i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      const end = skipBalanced(src, i, c, c === "{" ? "}" : c === "[" ? "]" : ")");
      if (end === -1) return -1;
      i = end;
      continue;
    }
    i++;
  }
  return Math.min(i, limit);
}

export function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** One `key: value` entry of an object literal, with the value's source span. */
export interface ObjectPair {
  name: string;
  valueStart: number;
  valueEnd: number;
  /** The value's source text, trimmed. */
  raw: string;
}

/**
 * Read the `key: value` entries at the TOP level of an object-literal body —
 * the range strictly inside its braces.
 *
 * Entries this scanner does not model (spreads, computed keys, shorthand,
 * methods) are skipped rather than guessed at, so one unfamiliar entry cannot
 * poison the reading of its neighbours. Nested objects, arrays, calls, strings
 * and regexes are traversed as units, so a `,` or `}` inside any of them is
 * not mistaken for structure.
 */
export function scanObjectPairs(src: string, bodyStart: number, bodyEnd: number): ObjectPair[] {
  const pairs: ObjectPair[] = [];
  let i = bodyStart;

  while (i < bodyEnd) {
    const before = i;
    i = skipTrivia(src, i);
    if (i !== before) continue;
    if (i >= bodyEnd) break;

    const c = src[i]!;
    if (c === "," || c === ";") {
      i++;
      continue;
    }

    // --- key ---
    let name: string | null = null;
    let afterKey = i;
    if (c === '"' || c === "'") {
      const end = skipString(src, i);
      if (end === -1) break;
      name = unquote(src.slice(i, end));
      afterKey = end;
    } else {
      const ident = readIdentifier(src, i);
      if (ident) {
        name = ident.text;
        afterKey = ident.end;
      }
    }

    if (name === null) {
      i = skipToNextEntry(src, i, bodyEnd);
      continue;
    }

    const j = skipTrivia(src, afterKey);
    if (src[j] !== ":") {
      // Shorthand (`{ width }`) or a method — no value span to point at.
      i = skipToNextEntry(src, afterKey, bodyEnd);
      continue;
    }

    // --- value ---
    const valueStart = skipTrivia(src, j + 1);
    const valueEnd = skipValue(src, valueStart, bodyEnd);
    if (valueEnd === -1) break;

    const raw = src.slice(valueStart, valueEnd).trim();
    pairs.push({ name, valueStart, valueEnd: valueStart + raw.length, raw });
    i = valueEnd;
  }

  return pairs;
}
