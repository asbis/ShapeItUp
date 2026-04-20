import { describe, it, expect } from "vitest";
import { validateSyntaxPure, detectPathDoubling, extractSignatures, safeHandler, computePartsLine } from "./tools.js";

// ---------------------------------------------------------------------------
// Bug #6 — validate_syntax must trust .method() calls whose receiver was
// imported from the "shapeitup" stdlib. Before this fix, `bearings.body("608")`
// produced "Warning: unknown method(s) found: .body()" because the whitelist
// only covered Replicad surface methods. The import-aware approach is
// drift-proof: adding a new stdlib helper doesn't require updating the
// whitelist in tools.ts.
//
// NOTE ON FIXTURES: the strip-then-parse pipeline in validateSyntaxPure uses
// multi-line-mode `^import` anchors, so every fixture import line must start
// at column 0. Using .join("\n") on a plain array keeps that contract
// obvious and avoids the hidden-whitespace gotcha of a template literal.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — stdlib whitelisting", () => {
  it("does not warn on named stdlib imports (bearings.body, holes.through)", () => {
    const code = [
      `import { bearings, holes } from "shapeitup";`,
      `export default function main() {`,
      `  const b = bearings.body("608");`,
      `  const h = holes.through("M3");`,
      `  return b;`,
      `}`,
    ].join("\n");
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    // No unknown-method warning at all — stdlib calls must be trusted.
    expect(text).not.toMatch(/unknown method/i);
    expect(text).not.toContain(".body()");
    expect(text).not.toContain(".through()");
  });

  it("does not warn on star-imported stdlib (lib.patterns.grid, lib.holes.through)", () => {
    // Namespace imports must be recognized too, and the trust has to
    // extend through the full dotted chain (lib.patterns.grid) — not just
    // the immediate `.patterns` off `lib`.
    const code = [
      `import * as lib from "shapeitup";`,
      `export default function main() {`,
      `  const pts = lib.patterns.grid({ rows: 2, cols: 2, spacing: 10 });`,
      `  const h = lib.holes.through("M3");`,
      `  return pts;`,
      `}`,
    ].join("\n");
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).not.toMatch(/unknown method/i);
    expect(text).not.toContain(".grid()");
    expect(text).not.toContain(".through()");
    expect(text).not.toContain(".patterns()");
  });

  it("still flags genuine typos on non-stdlib receivers", () => {
    // `bracket.extrud(5)` — the receiver isn't a stdlib import, and
    // `extrud` isn't in the Replicad whitelist (it's a typo of `extrude`).
    // The fix must NOT silently accept every unknown method — only those
    // on stdlib receivers.
    const code = [
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      `  const bracket = makeBox(10, 10, 10);`,
      `  return bracket.extrud(5);`,
      `}`,
    ].join("\n");
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/unknown method/i);
    expect(text).toContain(".extrud()");
  });

  it("handles `as` alias in named stdlib imports (import { holes as h })", () => {
    // The local binding is `h`, not `holes`. We must trust `h.through(` —
    // trusting `holes.through(` is irrelevant here because `holes` never
    // appears as a receiver in the file.
    const code = [
      `import { holes as h } from "shapeitup";`,
      `export default function main() {`,
      `  return h.through("M3");`,
      `}`,
    ].join("\n");
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).not.toMatch(/unknown method/i);
  });

  it("flags real syntax errors as isError:true (regression guard)", () => {
    // Unchanged behavior: a legitimate JS syntax error still produces
    // isError:true with "Syntax error:" prefix. We verify the refactor
    // didn't break this path.
    const code = `export default function main() { return ; `;
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(true);
    expect(text).toMatch(/^Syntax error:/);
  });
});

// ---------------------------------------------------------------------------
// Fix #6 — create_shape must warn when the resolved directory contains the
// same path segment twice at the tail (e.g. `.../examples/examples`). This
// happens when the MCP shell cwd is already `.../examples` and the caller
// passes `directory: "examples"` — the probe falls through to cwd join and
// doubles the segment. Don't refuse; emit a leading-newline soft warning.
// ---------------------------------------------------------------------------

describe("detectPathDoubling", () => {
  it("warns when the final two segments are identical (forward slashes)", () => {
    const warn = detectPathDoubling("/home/user/code/shapeitup/examples/examples");
    expect(warn).toContain("path segment");
    expect(warn).toContain('"examples"');
    expect(warn).toContain("appears twice");
    // Starts with a newline so callers can concatenate directly.
    expect(warn.startsWith("\n")).toBe(true);
  });

  it("warns on Windows-style paths (backslash separators)", () => {
    const warn = detectPathDoubling("C:\\Users\\me\\code\\ShapeItUp\\examples\\examples");
    expect(warn).toContain('"examples"');
    expect(warn).toContain("appears twice");
  });

  it("treats case-insensitively (examples vs Examples)", () => {
    const warn = detectPathDoubling("/tmp/Examples/examples");
    expect(warn).not.toBe("");
    expect(warn).toMatch(/appears twice/);
  });

  it("returns empty string when segments do not double", () => {
    expect(detectPathDoubling("/home/user/code/shapeitup/examples")).toBe("");
    expect(detectPathDoubling("C:\\Users\\me\\code\\ShapeItUp")).toBe("");
    expect(detectPathDoubling("/a/b/c")).toBe("");
  });

  it("ignores single-segment paths", () => {
    expect(detectPathDoubling("/")).toBe("");
    expect(detectPathDoubling("/root")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Fix #9 — extractSignatures (signaturesOnly) must be honest: only
// signature-shaped lines survive. Recipe prose (with lambdas) and empty
// categories get a clear "no signatures" note rather than a dump of prose.
// ---------------------------------------------------------------------------

describe("extractSignatures", () => {
  it("keeps arrow-signature lines (name(args) → ReturnType)", () => {
    const body = [
      "# Modifications",
      "",
      "shape.fillet(radius, finder?) → Shape3D",
      "shape.chamfer(distance, finder?) → Shape3D",
      "",
      "Apply fillets BEFORE boolean cuts.", // prose — must drop
    ].join("\n");
    const out = extractSignatures(body, "modifications");
    expect(out).toContain("shape.fillet(radius, finder?) → Shape3D");
    expect(out).toContain("shape.chamfer(distance, finder?) → Shape3D");
    expect(out).not.toMatch(/Apply fillets/);
  });

  it("keeps leading-dot method signatures (e.g. .inDirection(dir))", () => {
    const body = [
      "## Method reference",
      ".inDirection(dir)                  — \"X\" | \"Y\" | \"Z\"",
      ".inPlane(plane, origin?)           — plane name + offset",
      ".and(fn), .or(fn), .not(fn)        — compose predicates",
    ].join("\n");
    const out = extractSignatures(body, "finders");
    expect(out).toContain(".inDirection(dir)");
    expect(out).toContain(".inPlane(plane, origin?)");
  });

  it("drops recipe lines with lambda bodies (e.g. e => e.foo())", () => {
    const body = [
      "# Recipes",
      "",
      "Vertical edges:",
      "`shape.fillet(2, e => e.inDirection(\"Z\"))`",
      "",
      "shape.fillet(radius, finder?) → Shape3D",
    ].join("\n");
    const out = extractSignatures(body, "modifications");
    expect(out).not.toMatch(/e => e\.inDirection/);
    // The clean arrow-form signature is still kept.
    expect(out).toContain("shape.fillet(radius, finder?) → Shape3D");
  });

  it("returns the 'no signatures' note when a category is prose/recipes only", () => {
    // Finders' recipe-heavy top section, stripped to the prose+recipe
    // shape that should yield zero clean signatures.
    const body = [
      "# Finders",
      "",
      "EdgeFinder picks edges; FaceFinder picks faces.",
      "Pass a lambda `e => e.method()` to the modification call.",
      "",
      "## Common recipes",
      "",
      "Top face of a part of height h:",
      "`shape.shell(1, f => f.inPlane(\"XY\", h))` — callback works here",
    ].join("\n");
    const out = extractSignatures(body, "finders");
    expect(out).toMatch(/No signature-shaped lines found/);
  });

  it("strips trailing headings that have no signatures under them", () => {
    const body = [
      "# Empty",
      "",
      "Just prose here, nothing callable.",
      "",
      "## Also empty",
    ].join("\n");
    const out = extractSignatures(body, "overview");
    expect(out).toMatch(/No signature-shaped lines found/);
  });

  it("keeps TS/JS declaration forms inside code fences", () => {
    const body = [
      "# API",
      "",
      "```typescript",
      "export function drawCircle(r: number): Drawing",
      "export const params = { x: 10 };",
      "const sketch = drawCircle(5).sketchOnPlane(\"XY\");", // assignment, not decl — drop
      "```",
    ].join("\n");
    const out = extractSignatures(body, "drawing");
    expect(out).toContain("export function drawCircle(r: number): Drawing");
    expect(out).toContain("export const params");
    // Assignment expressions are recipes, not declarations.
    expect(out).not.toMatch(/const sketch = drawCircle/);
  });
});

// ---------------------------------------------------------------------------
// Fix A — safeHandler must convert ANY thrown exception inside a tool handler
// into a structured `{ content, isError: true }` response instead of letting
// it propagate up and kill the MCP stdio transport (Bug #6). Before this fix,
// a plain JS exception — e.g. `plate.meshShape is not a function` — inside
// ANY handler poisoned the entire connection; subsequent calls returned
// "MCP error -32000: Connection closed".
// ---------------------------------------------------------------------------

describe("safeHandler — Bug #6 exception boundary", () => {
  it("converts a thrown Error into an isError response with tool name + message", async () => {
    const wrapped = safeHandler("my_tool", async () => {
      throw new TypeError("plate.meshShape is not a function");
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    const text = (res.content[0] as any).text as string;
    expect(text).toContain('Tool "my_tool" failed');
    expect(text).toContain("plate.meshShape is not a function");
  });

  it("does not throw — the wrapper's own caller never sees an exception", async () => {
    // Regression guard: the whole point of the fix is that the MCP SDK never
    // sees a rejection, so the stdio transport stays alive.
    const wrapped = safeHandler("any_tool", async () => {
      throw new Error("boom");
    });
    // If the wrapper ever re-throws, this await would reject and the test would fail.
    await expect(wrapped({})).resolves.toMatchObject({ isError: true });
  });

  it("passes through successful responses unchanged", async () => {
    const wrapped = safeHandler("happy_tool", async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));
    const res = await wrapped({});
    expect(res.isError).toBeUndefined();
    expect((res.content[0] as any).text).toBe("ok");
  });

  it("includes a truncated stack (first 5 frames) in the error message", async () => {
    const wrapped = safeHandler("stack_tool", async () => {
      throw new Error("trace me");
    });
    const res = await wrapped({});
    const text = (res.content[0] as any).text as string;
    // Stack frames start with whitespace + "at ". At least one frame must be present.
    expect(text).toMatch(/\s+at /);
    // Truncation rule is 5 lines of stack after the "failed:" header — verify
    // we don't flood the response with dozens of frames (would push out real
    // signal in the MCP UI). 20 is a comfortably generous upper bound.
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it("handles non-Error throws (thrown string) without crashing", async () => {
    const wrapped = safeHandler("stringy", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "a bare string";
    });
    const res = await wrapped({});
    expect(res.isError).toBe(true);
    expect((res.content[0] as any).text).toContain("a bare string");
  });
});

// ---------------------------------------------------------------------------
// Fix B — render_preview must not emit BOTH "Parts: lid (focused — other
// parts hidden)" AND "Part warnings: focusPart 'lid' ignored: not a
// multi-part assembly" for the same response (Bug #5). computePartsLine is
// the single source of truth: it returns "" whenever the engine's actual
// rendered parts list disagrees with the caller's focusPart/hideParts,
// leaving the viewer-supplied warning alone to speak for itself.
// ---------------------------------------------------------------------------

describe("computePartsLine — Bug #5 focusPart unification", () => {
  it("prints (focused) ONLY when the requested focusPart is in the rendered parts AND it's a multi-part assembly", () => {
    const line = computePartsLine("lid", undefined, ["base", "lid", "bolt"], "focused");
    expect(line).toBe("\nParts: lid (focused)");
  });

  it("suppresses the focused line when the script rendered a single part (not-multi-part case)", () => {
    // This is the exact Bug #5 scenario, inverted — user asked for focusPart
    // on a single-part shape, we must NOT claim the focus was honored.
    const line = computePartsLine("lid", undefined, ["only"], "focused");
    expect(line).toBe("");
  });

  it("suppresses the focused line when focusPart name is not among rendered parts", () => {
    const line = computePartsLine("lid", undefined, ["base", "bolt", "washer"], "focused");
    expect(line).toBe("");
  });

  it("suppresses the focused line when the script rendered zero parts (engine failure edge case)", () => {
    // status.partNames can be empty/missing on a bad render — we get passed
    // []. Must not claim focus was honored.
    const line = computePartsLine("lid", undefined, [], "focused");
    expect(line).toBe("");
  });

  it("prints Parts hidden ONLY when at least one hide name matches a rendered part", () => {
    const line = computePartsLine(undefined, ["bolt", "washer"], ["base", "lid", "bolt"], "focused");
    expect(line).toBe("\nParts hidden: bolt");
  });

  it("suppresses hidden line entirely when none of the hide names match", () => {
    const line = computePartsLine(undefined, ["ghost"], ["base", "lid"], "focused");
    expect(line).toBe("");
  });

  it("suppresses hidden line on a single-part assembly (hide is a no-op)", () => {
    const line = computePartsLine(undefined, ["only"], ["only"], "focused");
    expect(line).toBe("");
  });

  it("focus takes precedence over hide when both are honored", () => {
    const line = computePartsLine("lid", ["bolt"], ["base", "lid", "bolt"], "focused");
    expect(line).toBe("\nParts: lid (focused)");
  });

  it("uses the caller-supplied label (render_preview uses a longer form)", () => {
    const line = computePartsLine(
      "lid",
      undefined,
      ["base", "lid", "bolt"],
      "focused — other parts hidden in screenshot",
    );
    expect(line).toBe("\nParts: lid (focused — other parts hidden in screenshot)");
  });
});
