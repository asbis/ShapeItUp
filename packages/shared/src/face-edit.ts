/**
 * Turning a face picked in the viewer into a durable edit of the `.shape.ts`.
 *
 * Two halves, both pure:
 *
 *   1. {@link synthesizeFaceSelector} — a FaceInfo becomes a replicad finder,
 *      bound to a parameter NAME wherever the geometry lets us prove which
 *      parameter it is.
 *   2. {@link computeFaceOpEdit} — that call is wrapped around the right shape
 *      expression in the source.
 *
 * ## Why the selector must be parameterised
 *
 * The naive selector is the one whose numbers came straight off the click:
 *
 *     inPlane("XY", 8)      picked at height 8, re-run at height 12 -> 0 hits
 *     inPlane("XY", height) picked at height 8, re-run at height 12 -> 1 hit
 *
 * Both look right the moment they are written. The first breaks the next time
 * the user touches a slider, and breaks silently — the operation stops
 * applying and the model quietly loses a feature. So when the offset matches a
 * declared parameter we emit the NAME, and when it does not we say so out loud
 * rather than shipping a selector we know to be brittle.
 *
 * ## Why binding is deliberately conservative
 *
 * Only exact matches bind — `6` to `thickness = 6`, and `-6` to `-thickness`.
 * Derived forms like `plateD / 2` are not inferred even though that idiom is
 * everywhere, because a half-relation is a guess about intent: `30` equals
 * `plateD / 2` and also `gussetH - 15` and any number of other things that
 * happen to be true right now. A wrong guess writes a plausible-looking line
 * that silently moves the operation to a different face later. An honest
 * literal, flagged as not durable, leaves the user in a position to fix it.
 */
import {
  readIdentifier,
  scanObjectPairs,
  skipBalanced,
  skipString,
  skipTrivia,
} from "./ts-scan.js";
import { findParamSlots, formatNumber } from "./param-edit.js";

/** The subset of a face descriptor a selector can be built from. */
export interface SelectableFace {
  kind: string;
  center: [number, number, number];
  normal?: [number, number, number];
}

export interface FaceSelector {
  /** e.g. `(f) => f.inPlane("XY", thickness)` — ready to paste as an argument. */
  code: string;
  /** The parameter the offset was bound to, when one matched exactly. */
  boundTo?: string;
  /**
   * False when the offset had to be written as a literal. Such a selector is
   * correct today and will stop matching as soon as the geometry moves — the
   * UI is expected to say so before the user commits.
   */
  durable: boolean;
}

export type SelectorFailure =
  | "not-planar"
  | "not-axis-aligned"
  | "no-normal";

export type FaceSelectorResult =
  | { ok: true; selector: FaceSelector }
  | { ok: false; reason: SelectorFailure };

/** Within ~2.6 degrees of an axis. */
const AXIS = 0.999;
/**
 * How close an offset must be to a parameter to be considered the same number.
 * Loose enough to absorb the Float32 round trip the mesh takes to the viewer
 * and back, tight enough that two genuinely different parameters 0.01 apart
 * are not confused.
 */
const BIND_EPSILON = 1e-4;

/**
 * Build a finder for a picked face, binding its offset to a declared
 * parameter where the numbers prove which one it is.
 */
export function synthesizeFaceSelector(
  face: SelectableFace,
  params: Record<string, number> = {},
): FaceSelectorResult {
  if (face.kind !== "PLANE") return { ok: false, reason: "not-planar" };
  if (!face.normal) return { ok: false, reason: "no-normal" };

  const [nx, ny, nz] = face.normal;
  let plane: string;
  let offset: number;
  if (Math.abs(nz) > AXIS) {
    plane = "XY";
    offset = face.center[2];
  } else if (Math.abs(ny) > AXIS) {
    plane = "XZ";
    offset = face.center[1];
  } else if (Math.abs(nx) > AXIS) {
    plane = "YZ";
    offset = face.center[0];
  } else {
    return { ok: false, reason: "not-axis-aligned" };
  }

  const bound = bindOffset(offset, params);
  return {
    ok: true,
    selector: {
      code: `(f) => f.inPlane("${plane}", ${bound?.expr ?? formatNumber(offset)})`,
      ...(bound ? { boundTo: bound.name } : {}),
      durable: bound !== null,
    },
  };
}

/**
 * Find a parameter whose value IS this offset, or whose negation is.
 *
 * Declaration order breaks ties. Two parameters holding the same number are
 * genuinely ambiguous and nothing in the geometry can distinguish them — the
 * generated line names the one it chose, which is the only way the user gets
 * to disagree.
 */
function bindOffset(
  offset: number,
  params: Record<string, number>,
): { name: string; expr: string } | null {
  // Zero is every parameter that happens to be zero, and none of them
  // meaningfully. A plane through the origin stays at the origin.
  if (Math.abs(offset) < BIND_EPSILON) return null;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (Math.abs(value - offset) < BIND_EPSILON) return { name, expr: name };
    if (Math.abs(value + offset) < BIND_EPSILON) return { name, expr: `-${name}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Writing the call into the source
// ---------------------------------------------------------------------------

export interface FaceOpEdit {
  start: number;
  end: number;
  text: string;
}

export type FaceOpFailure =
  | "no-return"
  | "part-not-found"
  | "part-has-no-shape"
  | "unparseable";

export type FaceOpResult =
  | {
      ok: true;
      /**
       * Ascending by `start`. Apply them in DESCENDING order so that each
       * edit's offsets still refer to the text it was computed against.
       */
      edits: FaceOpEdit[];
      /** The expression that was wrapped — shown in the preview. */
      wrapped: string;
      /** True when an `import { extrudeFace } from "shapeitup"` had to be added. */
      addedImport: boolean;
    }
  | { ok: false; reason: FaceOpFailure };

/**
 * Wrap the shape expression for `partName` in a call.
 *
 * `call` is a template naming the wrapped expression `$SHAPE`, e.g.
 * `extrudeFace($SHAPE, (f) => f.inPlane("XY", thickness), 5)`.
 *
 * With a part name, the target is the `shape:` value of the object literal
 * that also carries `name: "<partName>"`. Without one — a script that returns
 * a bare shape — the target is the expression of the last top-level `return`.
 *
 * Every failure is typed and nothing is edited on failure. This function is
 * the one place in the codebase that rewrites a user's model by machine, and
 * an edit that lands one expression to the left is far worse than a refusal.
 */
export function computeFaceOpEdit(
  source: string,
  partName: string | null,
  call: string,
): FaceOpResult {
  const span = partName
    ? findPartShapeSpan(source, partName)
    : findReturnExpressionSpan(source);
  if (!span.ok) return span;

  const original = source.slice(span.start, span.end);
  const wrap: FaceOpEdit = {
    start: span.start,
    end: span.end,
    text: call.replace("$SHAPE", original),
  };

  // The generated call is useless — worse, it is a ReferenceError — unless the
  // helper it names is in scope. Writing the operation without the import
  // would replace a working model with a broken one.
  const helper = leadingCallee(call);
  const importEdit = helper ? ensureStdlibImport(source, helper) : null;

  const edits = importEdit ? [importEdit, wrap].sort((a, b) => a.start - b.start) : [wrap];
  return { ok: true, edits, wrapped: original, addedImport: importEdit !== null };
}

/** The function name a `$SHAPE` call template invokes, e.g. `extrudeFace`. */
function leadingCallee(call: string): string | null {
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(call.trim());
  return m ? m[1]! : null;
}

/**
 * Produce the edit that brings `name` into scope from the `shapeitup` stdlib,
 * or null when it is already there.
 *
 * Three cases, in the order they are checked: the name is already imported
 * (nothing to do), a `shapeitup` import exists and the name joins its braces,
 * or no such import exists and a fresh line goes after the last import.
 */
export function ensureStdlibImport(source: string, name: string): FaceOpEdit | null {
  const existing = findStdlibImport(source);
  if (existing) {
    const names = source
      .slice(existing.namesStart, existing.namesEnd)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    // `x as y` binds y; compare against the local binding, which is what the
    // generated call will actually reference.
    if (names.some((n) => localBinding(n) === name)) return null;
    return {
      start: existing.namesEnd,
      end: existing.namesEnd,
      text: `, ${name}`,
    };
  }

  const at = endOfLastImport(source);
  return { start: at, end: at, text: `import { ${name} } from "shapeitup";\n` };
}

function localBinding(spec: string): string {
  const parts = spec.split(/\s+as\s+/);
  return (parts[parts.length - 1] ?? "").trim();
}

/** Locate the brace contents of a top-level `import { … } from "shapeitup"`. */
function findStdlibImport(
  source: string,
): { namesStart: number; namesEnd: number } | null {
  const re = /import\s*\{([^}]*)\}\s*from\s*["']shapeitup["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // Reject a match that is inside a string or comment by re-scanning to it.
    if (!isCodePosition(source, m.index)) continue;
    const open = source.indexOf("{", m.index) + 1;
    const close = source.indexOf("}", open);
    // Trim trailing whitespace so the inserted `, name` lands snugly rather
    // than after the padding of `{ holes  }`.
    let end = close;
    while (end > open && /\s/.test(source[end - 1]!)) end--;
    return { namesStart: open, namesEnd: end };
  }
  return null;
}

/** Index just past the last top-level import statement, or 0. */
function endOfLastImport(source: string): number {
  const re = /^[ \t]*import\b[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(source)) !== null) {
    if (!isCodePosition(source, m.index)) continue;
    end = m.index + m[0].length;
  }
  return end;
}

/**
 * Is `target` a position in real code, rather than inside a string or comment?
 *
 * Used to keep the two import regexes honest — they are regexes because import
 * statements are genuinely regular, but a regex cannot tell code from a
 * doc-comment example, and this module's whole contract is that it does not
 * edit text that merely looks like code.
 */
function isCodePosition(source: string, target: number): boolean {
  let i = 0;
  while (i < source.length && i <= target) {
    const before = i;
    i = skipTrivia(source, i);
    if (i !== before) {
      if (i > target) return false; // target sat inside the trivia we just skipped
      continue;
    }
    if (i === target) return true;
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      if (end === -1) return false;
      if (target < end) return false; // inside the string
      i = end;
      continue;
    }
    i++;
  }
  return i === target;
}

type SpanResult =
  | { ok: true; start: number; end: number }
  | { ok: false; reason: FaceOpFailure };

/**
 * Locate the `shape:` value of the object literal that declares
 * `name: "<partName>"`.
 *
 * Scans every object literal in the file rather than trying to find the
 * `return` first: a part can be built in a helper, spread in from a factory,
 * or listed in a const above the return, and the `{ shape, name }` pairing is
 * the thing that is actually invariant.
 */
function findPartShapeSpan(source: string, partName: string): SpanResult {
  let found: { start: number; end: number } | null = null;
  let matches = 0;
  let noShape = false;

  // Walk with the scanner rather than indexOf: a `{` inside a comment or a
  // string is not an object literal, and treating one as an object is how an
  // edit ends up landing on text that only LOOKS like the user's model.
  let i = 0;
  while (i < source.length) {
    const before = i;
    i = skipTrivia(source, i);
    if (i !== before) continue;
    const c = source[i];
    if (c === undefined) break;
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (c !== "{") {
      i++;
      continue;
    }

    const end = skipBalanced(source, i, "{", "}");
    if (end === -1) {
      i++;
      continue;
    }
    const pairs = scanObjectPairs(source, i + 1, end - 1);
    const nameEntry = pairs.find((p) => p.name === "name");
    if (nameEntry && stringLiteralValue(nameEntry.raw) === partName) {
      const shapeEntry = pairs.find((p) => p.name === "shape");
      if (shapeEntry) {
        matches++;
        found = { start: shapeEntry.valueStart, end: shapeEntry.valueEnd };
      } else {
        noShape = true;
      }
    }
    // Step INTO the object rather than over it: parts are routinely nested
    // one level down inside an assembly literal.
    i++;
  }

  if (!found && noShape) return { ok: false, reason: "part-has-no-shape" };

  if (!found) return { ok: false, reason: "part-not-found" };
  // Two objects claiming the same part name means the file does something we
  // do not model; picking either is a coin flip on the user's geometry.
  if (matches > 1) return { ok: false, reason: "unparseable" };
  return { ok: true, ...found };
}

/**
 * Locate the expression of the LAST top-level `return` in the file.
 *
 * "Top level" here means nesting depth 1 — inside `main`'s body but not inside
 * anything nested in it — so a `return` from a callback or an inner helper is
 * not mistaken for the model's result. Last rather than first because an early
 * `return` is usually a guard clause.
 */
function findReturnExpressionSpan(source: string): SpanResult {
  let depth = 0;
  let last: { start: number; end: number } | null = null;

  let i = 0;
  while (i < source.length) {
    const before = i;
    i = skipTrivia(source, i);
    if (i !== before) continue;
    const c = source[i];
    if (c === undefined) break;

    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(source, i);
      if (end === -1) return { ok: false, reason: "unparseable" };
      i = end;
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 1 && c === "r") {
      const ident = readIdentifier(source, i);
      if (ident?.text === "return" && !isIdentContinuation(source, i - 1)) {
        const start = skipTrivia(source, ident.end);
        const end = findStatementEnd(source, start);
        if (end === -1) return { ok: false, reason: "unparseable" };
        const raw = source.slice(start, end).trimEnd();
        if (raw.length > 0) last = { start, end: start + raw.length };
        i = end;
        continue;
      }
      i = ident ? ident.end : i + 1;
      continue;
    }
    const ident = readIdentifier(source, i);
    i = ident ? ident.end : i + 1;
  }

  if (!last) return { ok: false, reason: "no-return" };
  return { ok: true, ...last };
}

/** Walk a statement to its terminating `;` or newline, treating groups as units. */
function findStatementEnd(src: string, i: number): number {
  while (i < src.length) {
    const before = i;
    // Trivia is skipped EXCEPT a newline, which can end a statement under ASI.
    if (src[i] === "\n") return i;
    i = skipTrivia(src, i);
    if (i !== before) continue;
    const c = src[i];
    if (c === undefined) return src.length;
    if (c === ";") return i;
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
    if (c === "}") return i;
    i++;
  }
  return src.length;
}

function isIdentContinuation(src: string, i: number): boolean {
  const c = src[i];
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

/** The text of a string literal, or null if `raw` is not one. */
function stringLiteralValue(raw: string): string | null {
  const q = raw[0];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  if (raw[raw.length - 1] !== q) return null;
  return raw.slice(1, -1);
}

// ---------------------------------------------------------------------------
// The whole commit, in one call
// ---------------------------------------------------------------------------

export interface FaceOpRequest {
  op: "extrude";
  partName: string | null;
  face: SelectableFace;
  distance: number;
}

export type BuiltFaceOp =
  | { ok: true; edits: FaceOpEdit[]; applied: string; addedImport: boolean }
  | { ok: false; reason: string };

/**
 * Everything between "the user pushed a face" and "here are the edits":
 * read the file's declared parameters, synthesise a selector bound to one of
 * them where possible, and wrap the right expression.
 *
 * Lives here rather than in either host because both hosts must reach exactly
 * the same decision about a given file. The two of them already differ on HOW
 * they write (atomic write vs. WorkspaceEdit); they must not also differ on
 * WHAT they write.
 *
 * Failures come back as prose because the string is shown to the user, and
 * "part-not-found" is not a sentence.
 */
export function buildFaceOpCall(source: string, req: FaceOpRequest): BuiltFaceOp {
  const selector = synthesizeFaceSelector(req.face, declaredParams(source));
  if (!selector.ok) {
    return { ok: false, reason: SELECTOR_PROSE[selector.reason] };
  }

  if (!Number.isFinite(req.distance) || req.distance === 0) {
    return { ok: false, reason: "distance must be a non-zero number" };
  }

  const call = `extrudeFace($SHAPE, ${selector.selector.code}, ${formatNumber(req.distance)})`;
  const edit = computeFaceOpEdit(source, req.partName, call);
  if (!edit.ok) return { ok: false, reason: EDIT_PROSE[edit.reason] };

  return {
    ok: true,
    edits: edit.edits,
    applied: call.replace("$SHAPE", edit.wrapped),
    addedImport: edit.addedImport,
  };
}

const SELECTOR_PROSE: Record<SelectorFailure, string> = {
  "not-planar": "only planar faces can be pushed along a normal",
  "not-axis-aligned": "this face is not parallel to a standard plane, so there is no stable way to name it yet",
  "no-normal": "this face has no usable normal",
};

const EDIT_PROSE: Record<FaceOpFailure, string> = {
  "no-return": "could not find the shape your script returns",
  "part-not-found": "could not find this part in the source",
  "part-has-no-shape": "that part declares no `shape:` to modify",
  unparseable: "the source is shaped in a way this edit cannot safely change",
};

/** The file's declared parameters, as a name → number map. */
function declaredParams(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const slot of findParamSlots(source) ?? []) {
    if (typeof slot.numeric === "number") out[slot.name] = slot.numeric;
  }
  return out;
}
