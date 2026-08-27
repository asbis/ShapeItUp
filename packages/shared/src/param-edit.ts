/**
 * Locates the numeric literal behind a single `export const params` key so a
 * host can splice a new value into the source without touching anything else.
 *
 * This is the write half of the parameter round-trip: the viewer's sliders
 * already re-execute with `paramOverrides` (ephemeral, in-worker), and this is
 * what lets a committed slider value land back in the user's `.shape.ts`.
 *
 * ## Why not the TypeScript compiler API
 *
 * It was the obvious choice and it is the wrong one here. `ts.createSourceFile`
 * alone bundles to ~3.4 MB minified — against an `extension.js` that is
 * currently 0.2 MB, and an npm tarball that is 3.9 MB. Seventeen-fold growth in
 * the extension bundle to find one number inside one object literal is not a
 * trade worth making, in two bundles, for every user, including the ones who
 * never move a slider.
 *
 * ## Why not a regex either
 *
 * `extractParamsStatic` gets away with brace-counting plus a comment strip
 * because it only reports NAMES. Editing needs the exact offsets of the VALUE,
 * and a regex cannot tell `width: 80` from `// width: 80` or from
 * `{ label: "width: 80" }` without tracking comment and string state. Getting
 * that wrong writes into a comment.
 *
 * So: a small hand-written scanner that tracks exactly the states that can hide
 * a false match — line comments, block comments, the three string flavours,
 * and brace/bracket/paren nesting. Everything it does not confidently
 * understand it declines, and every caller must handle the decline anyway.
 *
 * ## The contract
 *
 * Returns a single `{ start, end, text }` splice, or a typed reason it can't.
 * It never rewrites, reformats, or reprints — the returned range covers the
 * value literal and nothing else, so comments, spacing, trailing commas and
 * key order all survive byte-for-byte.
 *
 * Callers MUST re-read the file and re-run this immediately before writing:
 * offsets computed against a stale read address a different file. See
 * `listNumericParams` for the up-front "which sliders are even writable"
 * question.
 */

/** A single splice: replace `[start, end)` with `text`. */
import {
  IDENT_PART,
  IDENT_START,
  readIdentifier,
  scanObjectPairs,
  skipBalanced,
  skipString,
  skipTrivia,
} from "./ts-scan.js";

export interface ParamEdit {
  start: number;
  end: number;
  text: string;
}

export type ParamEditFailure =
  /** No top-level `export const params = { ... }` in this source. */
  | "no-params-declaration"
  /** The declaration exists but has no top-level key by that name. */
  | "param-not-found"
  /**
   * The key exists but its value isn't a plain number — `width: base * 2`,
   * `depth: SOME_CONST`, a string, a boolean. Driving those from a slider would
   * mean rewriting an expression, which this deliberately refuses to do.
   */
  | "not-a-numeric-literal"
  /** The literal already reads as the requested value; writing would be a no-op. */
  | "unchanged";

export type ParamEditResult =
  | { ok: true; edit: ParamEdit }
  | { ok: false; reason: ParamEditFailure };

/** One top-level `key: value` pair, with the value's source range. */
export interface ParamSlot {
  name: string;
  /** Offset of the first character of the value literal. */
  valueStart: number;
  /** Offset one past the last character of the value literal. */
  valueEnd: number;
  /** The value's source text, verbatim. */
  raw: string;
  /** Parsed value when `raw` is a plain numeric literal, else undefined. */
  numeric?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the splice that sets `name` to `value`.
 *
 * `value` is written in the shortest form that round-trips: integers stay
 * integers, and floats are rounded to 6 decimals before trailing zeros are
 * stripped, so a slider step of 0.1 can't write `7.300000000000001`.
 */
export function computeParamEdit(
  source: string,
  name: string,
  value: number,
): ParamEditResult {
  if (!Number.isFinite(value)) return { ok: false, reason: "not-a-numeric-literal" };

  const slots = findParamSlots(source);
  if (slots === null) return { ok: false, reason: "no-params-declaration" };

  const slot = slots.find((s) => s.name === name);
  if (!slot) return { ok: false, reason: "param-not-found" };
  if (slot.numeric === undefined) return { ok: false, reason: "not-a-numeric-literal" };

  const text = formatNumber(value);
  // Compare the rendered text, not the numbers: `80` -> `80.0` is a no-op to a
  // reader but a real diff, and we'd rather not dirty the file for it.
  if (text === slot.raw) return { ok: false, reason: "unchanged" };

  return { ok: true, edit: { start: slot.valueStart, end: slot.valueEnd, text } };
}

/**
 * Every top-level key in `export const params`, with its value range.
 *
 * The viewer uses this to mark a slider read-only BEFORE the user drags it —
 * a control that silently declines on release is worse than one that never
 * looked draggable. Returns null when there is no declaration to read.
 */
export function findParamSlots(source: string): ParamSlot[] | null {
  const body = locateParamsBody(source);
  if (!body) return null;
  return scanTopLevelPairs(source, body.start, body.end);
}

/** Names whose values are plain numeric literals, i.e. safe to write. */
export function listNumericParams(source: string): string[] {
  return (findParamSlots(source) ?? [])
    .filter((s) => s.numeric !== undefined)
    .map((s) => s.name);
}


/**
 * Find the body of the top-level `export const params = { ... }`.
 *
 * Scanned rather than matched so `// export const params = {` and
 * `"export const params = {"` are correctly ignored, and so a nested
 * `params` inside a function body can't win — only depth 0 counts.
 *
 * Returns the range strictly INSIDE the braces.
 */
function locateParamsBody(src: string): { start: number; end: number } | null {
  let i = 0;
  let depth = 0;

  while (i < src.length) {
    const before = i;
    i = skipTrivia(src, i);
    if (i !== before) continue;

    const c = src[i];
    if (c === undefined) break;

    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(src, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      i++;
      continue;
    }

    const ident = readIdentifier(src, i);
    if (!ident) {
      i++;
      continue;
    }

    if (depth === 0 && ident.text === "export") {
      const found = matchParamsHead(src, ident.end);
      if (found !== null) {
        const bodyEnd = skipBalanced(src, found, "{", "}");
        if (bodyEnd === -1) return null;
        return { start: found + 1, end: bodyEnd - 1 };
      }
    }
    i = ident.end;
  }
  return null;
}

/**
 * From just after `export`, match `const params =` and return the offset of the
 * opening `{`, or null if this isn't the declaration we're after.
 */
function matchParamsHead(src: string, afterExport: number): number | null {
  let i = skipTrivia(src, afterExport);
  const kw = readIdentifier(src, i);
  if (!kw || (kw.text !== "const" && kw.text !== "let" && kw.text !== "var")) return null;

  i = skipTrivia(src, kw.end);
  const name = readIdentifier(src, i);
  if (!name || name.text !== "params") return null;

  i = skipTrivia(src, name.end);
  // A type annotation (`params: Params = {...}`) is legal but means the object
  // may be typed elsewhere; the value literal is still right here, so skip to
  // the `=`. Anything other than `:` or `=` isn't a declaration we handle.
  if (src[i] === ":") {
    while (i < src.length && src[i] !== "=" && src[i] !== ";" && src[i] !== "\n") i++;
  }
  i = skipTrivia(src, i);
  if (src[i] !== "=") return null;
  // Guard against `==` / `===` — an assignment is a single `=`.
  if (src[i + 1] === "=") return null;

  i = skipTrivia(src, i + 1);
  return src[i] === "{" ? i : null;
}

/**
 * Collect the top-level `key: value` pairs inside an object literal body.
 *
 * Anything that isn't a plain `identifier:` or `"quoted":` key at depth 0 —
 * a spread, a computed `[expr]:` key, a method — is skipped rather than
 * guessed at, which is why the result is "the pairs we're sure about" and not
 * "every pair".
 */
function scanTopLevelPairs(src: string, bodyStart: number, bodyEnd: number): ParamSlot[] {
  return scanObjectPairs(src, bodyStart, bodyEnd).map((pair) => {
    const slot: ParamSlot = {
      name: pair.name,
      valueStart: pair.valueStart,
      valueEnd: pair.valueEnd,
      raw: pair.raw,
    };
    const num = parseNumericLiteral(pair.raw);
    if (num !== null) slot.numeric = num;
    return slot;
  });
}




/**
 * Parse a plain numeric literal, or null.
 *
 * Deliberately narrow. A leading `-` or `+` counts (a negative default is
 * ordinary), and `_` separators are allowed because TypeScript permits them.
 * Hex, octal, binary and bigint do not: writing a slider value back would
 * silently change the literal's base, and no parameter that drives geometry is
 * written in hex.
 */
export function parseNumericLiteral(raw: string): number | null {
  const text = raw.trim();
  if (!/^[+-]?(\d[\d_]*)?(\.\d[\d_]*|\.)?([eE][+-]?\d+)?$/.test(text)) return null;
  if (!/\d/.test(text)) return null;
  const n = Number(text.replace(/_/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Render a number for insertion.
 *
 * Rounded to 6 decimals first: a slider stepping by 0.1 accumulates binary
 * float error (`7.300000000000001`), and that landing in a user's source once
 * is one time too many. Trailing zeros go, so `7.50` writes as `7.5` and an
 * integral value writes without a decimal point at all.
 */
export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const rounded = Number(value.toFixed(6));
  if (Number.isInteger(rounded)) return String(rounded);
  // toFixed avoids exponent notation for the magnitudes a CAD parameter takes;
  // String() would emit `1e-7` for very small values, which is valid TS but a
  // jarring thing to find in your source.
  return String(rounded);
}
