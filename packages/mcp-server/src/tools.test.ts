import { describe, it, expect } from "vitest";
import { validateSyntaxPure, detectPathDoubling, detectPathDoublingInfo, extractSignatures, safeHandler, computePartsLine, computeEffectiveMeshQuality, formatCollisionPairs, type CollisionEntry } from "./tools.js";

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
// Pitfall detector — hand-rolled boolean loops
// Covers all four new patterns plus regression-guards for the existing
// `for` loop detection and false-positive suppression.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — boolean-loop pitfall detector", () => {
  // Helper: build a minimal valid script body around a given snippet.
  const wrap = (body: string) =>
    [
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  // --- Existing for-loop detection (regression guard) ---
  it("flags for-loop with .cut (existing detection — no regression)", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  for (let i=0; i<5; i++) { s = s.cut(makeBox(1,1,1)); }`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`for` loop/);
    expect(text).toMatch(/patterns\.cutAt/);
  });

  it("flags for-loop with .fuse (existing detection)", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  for (let i=0; i<5; i++) { s = s.fuse(makeBox(1,1,1)); }`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/patterns\.cutAt/);
  });

  // --- NEW: for-loop with .intersect ---
  it("flags for-loop with .intersect", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  for (const p of pts) { s = s.intersect(p); }`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`for` loop/);
  });

  // --- NEW: while loop ---
  it("flags while-loop with .cut", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  while (pts.length > 0) { s = s.cut(pts.pop()); }`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`while` loop/);
    expect(text).toMatch(/patterns\.cutAt/);
  });

  it("flags while-loop with .fuse", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  while (pts.length) { s = s.fuse(pts.shift()); }`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`while` loop/);
  });

  // --- NEW: .forEach ---
  it("flags .forEach with .cut", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  pts.forEach(p => { s = s.cut(p); });`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.forEach` loop/);
    expect(text).toMatch(/patterns\.cutAt/);
  });

  it("flags .forEach with .fuse (inline arrow, no braces)", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  pts.forEach(p => s = s.fuse(p));`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.forEach` loop/);
  });

  it("flags .forEach with .intersect", () => {
    const code = wrap([
      `  let s = makeBox(10,10,10);`,
      `  pts.forEach(p => s = s.intersect(p));`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.forEach` loop/);
  });

  // --- NEW: .reduce ---
  it("flags .reduce with .cut", () => {
    const code = wrap([
      `  const s = pts.reduce((acc, p) => acc.cut(p), makeBox(10,10,10));`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.reduce` accumulator/);
    expect(text).toMatch(/patterns\.cutAt/);
  });

  it("flags .reduce with .fuse", () => {
    const code = wrap([
      `  const s = pts.reduce((acc, p) => acc.fuse(p), makeBox(10,10,10));`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.reduce` accumulator/);
  });

  it("flags .reduce with .intersect", () => {
    const code = wrap([
      `  const s = pts.reduce((acc, p) => acc.intersect(p), makeBox(10,10,10));`,
      `  return s;`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/slow pattern/);
    expect(text).toMatch(/`\.reduce` accumulator/);
  });

  // --- Negative cases: must NOT trigger ---
  it("does NOT flag a for-loop without .cut/.fuse/.intersect in the body", () => {
    const code = wrap([
      `  let total = 0;`,
      `  for (let i=0; i<5; i++) { total += i; }`,
      `  return makeBox(total, 10, 10);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/slow pattern/);
  });

  it("does NOT flag a standalone .cut call outside any loop", () => {
    const code = wrap([
      `  const a = makeBox(10,10,10);`,
      `  const b = makeBox(5,5,5);`,
      `  return a.cut(b);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/slow pattern/);
  });

  it("does NOT flag .forEach without a boolean method in the callback", () => {
    const code = wrap([
      `  const results: unknown[] = [];`,
      `  pts.forEach(p => results.push(p));`,
      `  return makeBox(10,10,10);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/slow pattern/);
  });

  it("does NOT flag .reduce without a boolean method in the accumulator", () => {
    const code = wrap([
      `  const total = pts.reduce((acc, p) => acc + p.x, 0);`,
      `  return makeBox(total, 10, 10);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/slow pattern/);
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
// detectPathDoublingInfo — structured companion used by create_shape to
// build a refusal message when the caller would otherwise accidentally
// write into a doubled-segment directory.
// ---------------------------------------------------------------------------

describe("detectPathDoublingInfo", () => {
  it("returns the duplicated segment and resolved path on doubling", () => {
    const info = detectPathDoublingInfo("/home/u/code/ShapeItUp/examples/examples");
    expect(info).not.toBeNull();
    expect(info!.duplicatedSegment.toLowerCase()).toBe("examples");
    expect(info!.absoluteDir).toMatch(/examples[\\/]examples$/i);
  });

  it("returns null when there is no doubling", () => {
    expect(detectPathDoublingInfo("/a/b/c")).toBeNull();
    expect(detectPathDoublingInfo("/home/u/code/ShapeItUp/examples")).toBeNull();
  });

  it("is case-insensitive", () => {
    const info = detectPathDoublingInfo("/tmp/Examples/examples");
    expect(info).not.toBeNull();
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

// ---------------------------------------------------------------------------
// computeEffectiveMeshQuality — AI render mode auto-upgrade
//
// When renderMode is "ai" (or unset, which defaults to "ai") and the caller
// did NOT explicitly pass meshQuality, the effective quality must be "final"
// so the AI agent analyses accurate geometry. Explicit caller overrides
// (including "preview") are always respected.
// ---------------------------------------------------------------------------

describe("computeEffectiveMeshQuality — AI render mode auto-upgrade", () => {
  it("auto-upgrades to 'final' when renderMode=ai and meshQuality is not set", () => {
    expect(computeEffectiveMeshQuality("ai", undefined)).toBe("final");
  });

  it("auto-upgrades to 'final' when renderMode is undefined (default 'ai') and meshQuality is not set", () => {
    expect(computeEffectiveMeshQuality(undefined, undefined)).toBe("final");
  });

  it("respects explicit meshQuality:'preview' even with renderMode=ai", () => {
    expect(computeEffectiveMeshQuality("ai", "preview")).toBe("preview");
  });

  it("respects explicit meshQuality:'final' with renderMode=ai (no-op upgrade)", () => {
    expect(computeEffectiveMeshQuality("ai", "final")).toBe("final");
  });

  it("does NOT auto-upgrade when renderMode='dark' and meshQuality is not set", () => {
    expect(computeEffectiveMeshQuality("dark", undefined)).toBeUndefined();
  });

  it("respects explicit meshQuality:'preview' with renderMode=dark", () => {
    expect(computeEffectiveMeshQuality("dark", "preview")).toBe("preview");
  });

  it("respects explicit meshQuality:'final' with renderMode=dark", () => {
    expect(computeEffectiveMeshQuality("dark", "final")).toBe("final");
  });
});

// ---------------------------------------------------------------------------
// formatCollisionPairs — unit tests for check_collisions format param
//
// These tests exercise the pure formatting helper that the tool delegates to.
// No WASM required — just collision data fixtures.
// ---------------------------------------------------------------------------

/** Build a minimal collision entry fixture. */
function makeCollision(a: string, b: string, volume: number, withGeometry = false): CollisionEntry {
  if (withGeometry) {
    return {
      a, b, volume,
      region: { min: [0, 0, 0], max: [5, 3, 2] },
      center: [2.5, 1.5, 1.0],
    };
  }
  return { a, b, volume };
}

describe("formatCollisionPairs — check_collisions format param", () => {
  // A fixture with 5 real collisions so we can check summary < full in length.
  const realC: CollisionEntry[] = [
    makeCollision("bodyA", "bodyB", 12.5, true),
    makeCollision("bodyC", "bodyD", 8.3),
    makeCollision("bodyE", "bodyF", 5.1),
    makeCollision("bodyG", "bodyH", 3.7),
    makeCollision("bodyI", "bodyJ", 1.9),
  ];
  const accounting = "Checked 10 parts → 45 pairs total.\n  - 45 pairs tested for 3D intersection.";

  it("default (no format → summary): includes worst-pair detail, compact lines for rest", () => {
    const out = formatCollisionPairs(realC, [], [], 0.5, "summary", accounting);
    // Worst pair has region+center.
    expect(out).toContain("bodyA ↔ bodyB");
    expect(out).toContain("Region:");
    expect(out).toContain("Center:");
    // Other pairs are one-line compact.
    expect(out).toContain("bodyC vs bodyD");
    expect(out).toContain("bodyE vs bodyF");
    // Compact lines must NOT include Region/Center for non-worst pairs.
    const lines = out.split("\n");
    const regionLines = lines.filter((l) => l.trim().startsWith("Region:") || l.trim().startsWith("Center:"));
    // Only the worst pair (one Region + one Center line).
    expect(regionLines).toHaveLength(2);
  });

  it("format=full: every pair gets Region and Center when available", () => {
    // Give all pairs geometry so we can count.
    const allWithGeo: CollisionEntry[] = [
      makeCollision("a", "b", 10, true),
      makeCollision("c", "d", 8, true),
      makeCollision("e", "f", 5, true),
      makeCollision("g", "h", 3, true),
      makeCollision("i", "j", 1, true),
    ];
    const out = formatCollisionPairs(allWithGeo, [], [], 0.5, "full", accounting);
    const lines = out.split("\n");
    const regionLines = lines.filter((l) => l.trim().startsWith("Region:"));
    // Every one of the 5 pairs should have a Region line.
    expect(regionLines).toHaveLength(5);
    const centerLines = lines.filter((l) => l.trim().startsWith("Center:"));
    expect(centerLines).toHaveLength(5);
  });

  it("format=ids: returns compact JSON array, no prose", () => {
    const out = formatCollisionPairs(realC, [], [], 0.5, "ids", accounting);
    // Must be valid JSON.
    expect(() => JSON.parse(out)).not.toThrow();
    const tuples = JSON.parse(out) as unknown[];
    expect(Array.isArray(tuples)).toBe(true);
    expect(tuples).toHaveLength(5);
    // Each tuple is [a, b, vol].
    const first = tuples[0] as [string, string, number];
    expect(first[0]).toBe("bodyA");
    expect(first[1]).toBe("bodyB");
    expect(typeof first[2]).toBe("number");
    // No accounting prose in the ids output.
    expect(out).not.toContain("Checked");
    expect(out).not.toContain("Collisions");
  });

  it("summary is shorter than full for an assembly with 5+ collisions", () => {
    const allWithGeo: CollisionEntry[] = Array.from({ length: 6 }, (_, i) =>
      makeCollision(`part${i}a`, `part${i}b`, (6 - i) * 3, true),
    );
    const summaryOut = formatCollisionPairs(allWithGeo, [], [], 0.5, "summary", accounting);
    const fullOut = formatCollisionPairs(allWithGeo, [], [], 0.5, "full", accounting);
    expect(summaryOut.length).toBeLessThan(fullOut.length);
  });

  it("format=full is regression-guarded: same output as old behavior for single pair", () => {
    const single: CollisionEntry[] = [makeCollision("cap", "body", 7.5, true)];
    const out = formatCollisionPairs(single, [], [], 0.5, "full", accounting);
    expect(out).toContain("cap \u2194 body: 7.50 mm\u00b3 overlap");
    expect(out).toContain("Region: x[0.00, 5.00] y[0.00, 3.00] z[0.00, 2.00] mm");
    expect(out).toContain("Center: (2.50, 1.50, 1.00) mm");
  });

  it("ids format: empty collisions returns empty array", () => {
    const out = formatCollisionPairs([], [], [], 0.5, "ids", accounting);
    expect(JSON.parse(out)).toEqual([]);
  });
});
