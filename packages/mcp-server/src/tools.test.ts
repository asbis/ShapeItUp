import { describe, it, expect } from "vitest";
import { validateSyntaxPure, detectPathDoubling, detectPathDoublingInfo, extractSignatures, safeHandler, computePartsLine, computeEffectiveMeshQuality, formatCollisionPairs, formatSweepCollisions, formatLastScreenshotLine, registerTools, getVersionTag, getViewerStatus, formatViewerBlock, type CollisionEntry, type SweepCollisionEntry } from "./tools.js";
import type { EngineStatus } from "./engine.js";

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
      region: {
        min: [0, 0, 0],
        max: [5, 3, 2],
        depths: { x: 5, y: 3, z: 2 },
      },
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

  it("renders per-axis overlap depths on the worst pair in summary mode", () => {
    const withDepth: CollisionEntry = {
      a: "cam",
      b: "lifter",
      volume: 42.1,
      region: {
        min: [-6.71, 5.0, 0.5],
        max: [6.71, 9.5, 7.5],
        depths: { x: 13.42, y: 4.5, z: 7.0 },
      },
      center: [0, 7.25, 4.0],
    };
    const out = formatCollisionPairs([withDepth], [], [], 0.5, "summary", accounting);
    expect(out).toContain("Overlap depth: X=13.42mm, Y=4.50mm, Z=7.00mm");
    // Depth line must sit between Region and Center for readability.
    const lines = out.split("\n").map((l) => l.trim());
    const regionIdx = lines.findIndex((l) => l.startsWith("Region:"));
    const depthIdx = lines.findIndex((l) => l.startsWith("Overlap depth:"));
    const centerIdx = lines.findIndex((l) => l.startsWith("Center:"));
    expect(regionIdx).toBeGreaterThan(-1);
    expect(depthIdx).toBeGreaterThan(regionIdx);
    expect(centerIdx).toBeGreaterThan(depthIdx);
  });

  it("check_collisions schema exposes a params override field", () => {
    // Capture every tool registration. registerTools is strict (asserts
    // McpServer shape), so we satisfy just the `.tool()` surface it uses.
    type Registered = { name: string; description: string; schema: Record<string, any>; handler: any };
    const registered: Registered[] = [];
    const fake = {
      tool: (name: string, description: string, schema: Record<string, any>, handler: any) => {
        registered.push({ name, description, schema, handler });
      },
    };
    registerTools(fake as unknown as Parameters<typeof registerTools>[0]);

    const tool = registered.find((t) => t.name === "check_collisions");
    expect(tool).toBeDefined();
    // `params` must exist on the check_collisions schema. verify_shape already
    // has it; this is the regression guard for the parity fix.
    expect(Object.keys(tool!.schema)).toContain("params");
    // Description should mention the new field so agents see it from tool
    // listings without drilling into the schema.
    expect(tool!.description).toMatch(/params/i);
  });

  it("renders per-axis overlap depths for every pair in full mode", () => {
    const pairs: CollisionEntry[] = [
      {
        a: "a", b: "b", volume: 10,
        region: { min: [0, 0, 0], max: [2, 4, 6], depths: { x: 2, y: 4, z: 6 } },
      },
      {
        a: "c", b: "d", volume: 5,
        region: { min: [0, 0, 0], max: [1, 1, 1], depths: { x: 1, y: 1, z: 1 } },
      },
    ];
    const out = formatCollisionPairs(pairs, [], [], 0.5, "full", accounting);
    const depthLines = out.split("\n").filter((l) => l.trim().startsWith("Overlap depth:"));
    expect(depthLines).toHaveLength(2);
    expect(depthLines[0]).toContain("X=2.00mm");
    expect(depthLines[0]).toContain("Y=4.00mm");
    expect(depthLines[0]).toContain("Z=6.00mm");
    expect(depthLines[1]).toContain("X=1.00mm");
  });
});

// ---------------------------------------------------------------------------
// formatSweepCollisions — unit tests for sweep_check format param
// ---------------------------------------------------------------------------

/** Build sweep collision fixtures. */
function makeSweepCollisions(stepVolumes: Array<[number, number, string, string]>): SweepCollisionEntry[] {
  return stepVolumes.map(([step, volume, pairA, pairB]) => ({
    step,
    angle: step * 10,
    pairA,
    pairB,
    volume,
  }));
}

describe("formatSweepCollisions — sweep_check format param", () => {
  // 5 collisions across 3 steps: step 0 (1 pair), step 2 (2 pairs), step 4 (2 pairs)
  const collisions = makeSweepCollisions([
    [0, 3.0, "arm", "wall"],
    [2, 8.5, "arm", "wall"],
    [2, 6.2, "arm", "floor"],
    [4, 5.0, "arm", "wall"],
    [4, 4.1, "arm", "ceiling"],
  ]);
  // angles array: step index → angle in degrees (0,10,20,30,40)
  const angles = [0, 10, 20, 30, 40];

  it("default (no format → summary): emits per-step counts, not per-pair lines", () => {
    const out = formatSweepCollisions(collisions, angles, "summary");
    // Should show count per step.
    expect(out).toMatch(/Step 0.*1 collision/);
    expect(out).toMatch(/Step 2.*2 collision/);
    expect(out).toMatch(/Step 4.*2 collision/);
    // Must NOT list individual pair lines for each collision.
    const pairLines = out.split("\n").filter((l) => l.includes(" \u2194 ") && !l.includes("Worst"));
    // Only worst step detail — worst is step 2 (volume 8.5+6.2=14.7), its pairs are listed.
    // But they're indented under "Worst step:" not as top-level ✗ lines.
    expect(pairLines.length).toBeLessThanOrEqual(2);
  });

  it("default summary: includes worst step with pair detail", () => {
    const out = formatSweepCollisions(collisions, angles, "summary");
    // Worst step = step 2 (14.7 total vol vs step 4's 9.1 and step 0's 3.0).
    expect(out).toContain("Worst step: 2");
    expect(out).toContain("arm \u2194 wall");
    expect(out).toContain("arm \u2194 floor");
  });

  it("format=full: emits one \u2717 line per collision pair", () => {
    const out = formatSweepCollisions(collisions, angles, "full");
    // Each collision gets its own ✗ line.
    const crossLines = out.split("\n").filter((l) => l.includes("\u2717"));
    expect(crossLines).toHaveLength(5);
    // Must contain per-pair detail.
    expect(out).toContain("arm \u2194 wall");
  });

  it("summary is shorter than full when there are 5+ collisions", () => {
    const summaryOut = formatSweepCollisions(collisions, angles, "summary");
    const fullOut = formatSweepCollisions(collisions, angles, "full");
    expect(summaryOut.length).toBeLessThan(fullOut.length);
  });

  it("format=ids: returns [step, pairs] tuples as JSON, no prose", () => {
    const out = formatSweepCollisions(collisions, angles, "ids");
    expect(() => JSON.parse(out)).not.toThrow();
    const tuples = JSON.parse(out) as Array<[number, Array<[string, string, number]>]>;
    expect(Array.isArray(tuples)).toBe(true);
    // 3 unique steps.
    expect(tuples).toHaveLength(3);
    // Step 2 has 2 pairs.
    const step2 = tuples.find(([s]) => s === 2);
    expect(step2).toBeDefined();
    expect(step2![1]).toHaveLength(2);
    // No prose in ids output.
    expect(out).not.toContain("Sweep check");
    expect(out).not.toContain("Clear");
  });

  it("ids: empty collisions returns empty array", () => {
    const out = formatSweepCollisions([], [0, 10, 20], "ids");
    expect(JSON.parse(out)).toEqual([]);
  });

  it("summary with no collisions: reports clear through all steps", () => {
    const out = formatSweepCollisions([], [0, 10, 20, 30, 40], "summary");
    expect(out).toContain("\u2713 Clear through all 5 steps");
  });

  it("full with no collisions: reports clear through all steps", () => {
    const out = formatSweepCollisions([], [0, 10, 20, 30, 40], "full");
    expect(out).toContain("\u2713 Clear through all 5 steps");
  });
});

// ---------------------------------------------------------------------------
// P11 — getVersionTag must never emit the literal word "unknown". When the
// extension half of the stack is disconnected we say so explicitly. Whole-env
// tests run against the real GLOBAL_STORAGE filesystem — in the test runner
// there's no live VSCode extension, so "extension-disconnected" is the
// expected shape. The MCP server's own version is always resolvable because
// the test runs from the monorepo (package.json sits next to the source).
// ---------------------------------------------------------------------------
describe("getVersionTag — P11 version footer", () => {
  it("never contains the literal word 'unknown'", () => {
    const tag = getVersionTag();
    expect(tag).not.toContain("vunknown");
    // The whole word 'unknown' should not appear either — "disconnected"
    // replaces it for the extension half.
    expect(tag).not.toMatch(/\bunknown\b/);
  });

  it("begins with a newline + [shapeitup mcp v… prefix", () => {
    const tag = getVersionTag();
    expect(tag.startsWith("\n[shapeitup mcp v")).toBe(true);
    expect(tag.endsWith("]")).toBe(true);
  });

  it("reports extension-disconnected when no heartbeat is present OR heartbeat lacks extensionVersion", () => {
    // Two branches are valid in a test environment:
    //   (a) No heartbeat at all (clean CI) → "extension-disconnected"
    //   (b) Heartbeat exists but was written by an old extension build that
    //       didn't include extensionVersion → also "extension-disconnected"
    //       (getVersionTag requires BOTH alive and version).
    // The contract is "never emit unknown" — we verify the actual happy-path
    // literal only in a live-extension env, which this test runner isn't.
    const status = getViewerStatus();
    const tag = getVersionTag();
    if (status.alive && status.extensionVersion) {
      expect(tag).toContain(`ext v${status.extensionVersion}`);
    } else {
      expect(tag).toContain("extension-disconnected");
    }
  });
});

describe("formatViewerBlock — P11 get_render_status viewer reporting", () => {
  it("reports one of the three states and always starts with \\nViewer:", () => {
    const block = formatViewerBlock();
    expect(block.startsWith("\nViewer: ")).toBe(true);
    expect(block).toMatch(/disconnected|connected \(ready\)|connected \(loading\)/);
  });

  it("omits Extension version line when extension is disconnected", () => {
    const status = getViewerStatus();
    const block = formatViewerBlock();
    if (!status.alive || !status.extensionVersion) {
      expect(block).not.toContain("Extension version:");
    }
  });
});

// ---------------------------------------------------------------------------
// Pitfall detector — negative fillet/chamfer radii
// OCCT rejects negative radii with a low-level exception; the old code
// silently skipped them via `r <= 0`. We now warn explicitly and cite the
// method that will throw, so the user doesn't have to decipher the OCCT
// trace.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — negative fillet/chamfer radii", () => {
  const wrap = (body: string) =>
    [
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  it("flags a negative fillet radius", () => {
    const code = wrap([
      `  const b = makeBox(20, 20, 20);`,
      `  return b.fillet(-2);`,
    ].join("\n"));
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/radius must be positive/);
    expect(text).toContain(".fillet(-2)");
  });

  it("flags a negative chamfer radius", () => {
    const code = wrap([
      `  const b = makeBox(20, 20, 20);`,
      `  return b.chamfer(-0.5);`,
    ].join("\n"));
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/radius must be positive/);
    expect(text).toContain(".chamfer(-0.5)");
  });

  it("does NOT flag a zero radius (no-op, not a bug)", () => {
    const code = wrap([
      `  const b = makeBox(20, 20, 20);`,
      `  return b.fillet(0);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/radius must be positive/);
  });

  it("does NOT flag a normal positive radius", () => {
    const code = wrap([
      `  const b = makeBox(20, 20, 20);`,
      `  return b.fillet(2);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/radius must be positive/);
  });
});

// ---------------------------------------------------------------------------
// Pitfall detector — patterns.cutAt must receive a factory function
// The stdlib throws a TypeError (see packages/core/src/stdlib/patterns.ts
// cutAt) when the second argument is not a function, because Replicad's
// translate/rotate consume OCCT handles. Mirror that at validate time.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — patterns.cutAt factory guard", () => {
  it("flags patterns.cutAt called with a bare Shape argument", () => {
    const code = [
      `import { patterns, holes } from "shapeitup";`,
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      `  const plate = makeBox(40, 40, 4);`,
      `  const tool = holes.through("M4");`,
      `  return patterns.cutAt(plate, tool, []);`,
      `}`,
    ].join("\n");
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/patterns\.cutAt/);
    expect(text).toMatch(/must be a factory function/);
  });

  it("flags lib.patterns.cutAt (namespace import) with a bare Shape", () => {
    const code = [
      `import * as lib from "shapeitup";`,
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      `  const plate = makeBox(40, 40, 4);`,
      `  const tool = lib.holes.through("M4");`,
      `  return lib.patterns.cutAt(plate, tool, []);`,
      `}`,
    ].join("\n");
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/must be a factory function/);
  });

  it("does NOT flag patterns.cutAt with an arrow-function factory", () => {
    const code = [
      `import { patterns, holes } from "shapeitup";`,
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      `  const plate = makeBox(40, 40, 4);`,
      `  return patterns.cutAt(plate, () => holes.through("M4"), []);`,
      `}`,
    ].join("\n");
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/must be a factory function/);
  });

  it("does NOT flag patterns.cutAt with a function-expression factory", () => {
    const code = [
      `import { patterns, holes } from "shapeitup";`,
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      `  const plate = makeBox(40, 40, 4);`,
      `  return patterns.cutAt(plate, function () { return holes.through("M4"); }, []);`,
      `}`,
    ].join("\n");
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/must be a factory function/);
  });
});

// ---------------------------------------------------------------------------
// Pitfall detector — shape reuse after a boolean op
// Replicad's cut/fuse/intersect invalidate the receiver's OCCT handle;
// translate/rotate consume theirs too, so `x.cut(x.translate(...))` crashes
// with a deleted-handle fault. Warn on the plain-Identifier case.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — shape reuse after boolean", () => {
  const wrap = (body: string) =>
    [
      `import { makeBox } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  it("flags x.cut(x.translate(...))", () => {
    const code = wrap([
      `  const x = makeBox(10, 10, 10);`,
      `  return x.cut(x.translate(5, 0, 0));`,
    ].join("\n"));
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/Shape reuse after boolean/);
    expect(text).toContain("x.cut/fuse/intersect(x.*)");
  });

  it("flags x.fuse(x.rotate(...))", () => {
    const code = wrap([
      `  const x = makeBox(10, 10, 10);`,
      `  return x.fuse(x.rotate(45, [0, 0, 0], [0, 0, 1]));`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/Shape reuse after boolean/);
  });

  it("flags x.intersect(x)", () => {
    const code = wrap([
      `  const x = makeBox(10, 10, 10);`,
      `  return x.intersect(x);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/Shape reuse after boolean/);
  });

  it("does NOT flag a.cut(b.translate(...)) (distinct roots)", () => {
    const code = wrap([
      `  const a = makeBox(10, 10, 10);`,
      `  const b = makeBox(5, 5, 5);`,
      `  return a.cut(b.translate(2, 0, 0));`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/Shape reuse after boolean/);
  });

  it("does NOT flag shapes[i].cut(...) (computed receiver, conservative skip)", () => {
    const code = wrap([
      `  const shapes = [makeBox(10, 10, 10), makeBox(5, 5, 5)];`,
      `  return shapes[0].cut(shapes[1]);`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/Shape reuse after boolean/);
  });
});

// ---------------------------------------------------------------------------
// Pitfall detector — unanchored draw() footguns (Rules A, B, C)
// A: `draw()` followed by a far-from-origin absolute *To move silently
//    inserts a segment from [0,0] that commonly causes self-intersection.
// B: `draw([x, y]).lineTo([x, y])` — zero-length first segment typo.
// C: Literal-only draw chains whose polyline self-intersects.
// ---------------------------------------------------------------------------

describe("validateSyntaxPure — unanchored draw() + far literal move (Rule A)", () => {
  const wrap = (body: string) =>
    [
      `import { draw } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  it("flags draw().lineTo([-40, -5]) — big absolute jump from origin", () => {
    const code = wrap(`  return draw().lineTo([-40, -5]).lineTo([0, 0]).close();`);
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/defaults to origin/);
    expect(text).toContain(".lineTo([-40, -5])");
    expect(text).toContain("draw([-40, -5])");
  });

  it("flags draw().hLineTo(30) — big absolute X jump", () => {
    const code = wrap(`  return draw().hLineTo(30).vLine(10).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/defaults to origin/);
    expect(text).toContain(".hLineTo(30)");
  });

  it("flags draw().vLineTo(-20) — big absolute Y jump", () => {
    const code = wrap(`  return draw().vLineTo(-20).hLine(5).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/defaults to origin/);
    expect(text).toContain(".vLineTo(-20)");
  });

  it("flags draw().polarLineTo([50, 0.5]) — r > 5", () => {
    const code = wrap(`  return draw().polarLineTo([50, 0.5]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/defaults to origin/);
    expect(text).toContain(".polarLineTo([50, 0.5])");
  });

  it("does NOT flag draw([-40, -5]).lineTo(...) — already anchored", () => {
    const code = wrap(`  return draw([-40, -5]).lineTo([0, 0]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/defaults to origin/);
  });

  it("does NOT flag draw().line(30, 0) — relative move starts at origin intentionally", () => {
    const code = wrap(`  return draw().line(30, 0).vLine(20).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/defaults to origin/);
  });

  it("does NOT flag draw().lineTo([3, 2]) — within 5mm threshold", () => {
    const code = wrap(`  return draw().lineTo([3, 2]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/defaults to origin/);
  });

  it("does NOT flag draw().movePointerTo(...).lineTo(...) — explicit pointer move first", () => {
    // movePointerTo isn't a *To we scan for (it's not in the regex list);
    // the first chained method must be one of lineTo/hLineTo/vLineTo/polarLineTo.
    const code = wrap(`  return draw().movePointerTo([-40, -5]).lineTo([-30, -5]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/defaults to origin/);
  });

  it("does NOT flag draw().lineTo([varX, 0]) — non-literal arg is skipped", () => {
    const code = wrap([
      `  const varX = 40;`,
      `  return draw().lineTo([varX, 0]).close();`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/defaults to origin/);
  });
});

describe("validateSyntaxPure — zero-length first segment (Rule B)", () => {
  const wrap = (body: string) =>
    [
      `import { draw } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  it("flags draw([10, 5]).lineTo([10, 5]) — identical coords", () => {
    const code = wrap(`  return draw([10, 5]).lineTo([10, 5]).lineTo([20, 5]).close();`);
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/zero-length first segment/);
  });

  it("flags draw([0, 0]).lineTo([0, 0])", () => {
    const code = wrap(`  return draw([0, 0]).lineTo([0, 0]).lineTo([10, 0]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).toMatch(/zero-length first segment/);
  });

  it("does NOT flag draw([10, 5]).lineTo([10, 6]) — differ by 1mm", () => {
    const code = wrap(`  return draw([10, 5]).lineTo([10, 6]).close();`);
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/zero-length first segment/);
  });

  it("does NOT flag when start is a variable (non-literal bail)", () => {
    const code = wrap([
      `  const p = [10, 5];`,
      `  return draw(p).lineTo([10, 5]).close();`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/zero-length first segment/);
  });
});

describe("validateSyntaxPure — literal polyline self-intersection (Rule C)", () => {
  const wrap = (body: string) =>
    [
      `import { draw } from "replicad";`,
      `export default function main() {`,
      body,
      `}`,
    ].join("\n");

  it("flags a literal bowtie quadrilateral (figure-8 self-cross)", () => {
    // Four points forming a crossing bowtie: (0,0) -> (10,10) -> (10,0) -> (0,10) -> close
    // segment 0 [(0,0)-(10,10)] crosses segment 2 [(10,0)-(0,10)] at (5,5).
    const code = wrap([
      `  return draw([0, 0])`,
      `    .lineTo([10, 10])`,
      `    .lineTo([10, 0])`,
      `    .lineTo([0, 10])`,
      `    .close();`,
    ].join("\n"));
    const { text, isError } = validateSyntaxPure(code);
    expect(isError).toBe(false);
    expect(text).toMatch(/self-intersects at approximately/);
  });

  it("does NOT flag a simple clean rectangle", () => {
    const code = wrap([
      `  return draw([0, 0])`,
      `    .lineTo([10, 0])`,
      `    .lineTo([10, 10])`,
      `    .lineTo([0, 10])`,
      `    .close();`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/self-intersects/);
  });

  it("does NOT flag a chain with a non-literal coord (conservative skip)", () => {
    const code = wrap([
      `  const w = 10;`,
      `  return draw([0, 0]).lineTo([w, w]).lineTo([w, 0]).lineTo([0, w]).close();`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/self-intersects/);
  });

  it("does NOT flag a chain that uses movePointerTo (bail on unsupported pen op)", () => {
    // movePointerTo jumps the cursor without drawing — we can't cheaply
    // model that and stay conservative.
    const code = wrap([
      `  return draw([0, 0])`,
      `    .lineTo([10, 10])`,
      `    .movePointerTo([10, 0])`,
      `    .lineTo([0, 10])`,
      `    .close();`,
    ].join("\n"));
    const { text } = validateSyntaxPure(code);
    expect(text).not.toMatch(/self-intersects/);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — `formatLastScreenshotLine` must scrub stale paths from OTHER
// workspaces. The global `shapeitup-status.json` is shared across every
// VSCode window and every MCP shell on the machine; when a screenshot taken
// in workspace A leaks into responses while an agent is working in
// workspace B, the agent will Read the wrong PNG and reason about the wrong
// assembly. Hotfix: emit the line only when the stored path sits under one
// of the plausible current-workspace roots (heartbeat / default / cwd).
// ---------------------------------------------------------------------------

describe("formatLastScreenshotLine — cross-workspace leak guard", () => {
  const baseStatus = (path: string): EngineStatus => ({
    success: true,
    timestamp: new Date().toISOString(),
    fileName: "whatever.shape.ts",
    stats: "",
    lastScreenshot: {
      path,
      timestamp: Date.now(),
      renderMode: "ai",
      cameraAngle: "iso",
    },
  });

  it("emits the Last screenshot line when the stored path is under process.cwd()", () => {
    // process.cwd() is always a candidate; a path inside it passes the guard.
    const cwd = process.cwd();
    const pathUnderCwd = `${cwd}/shapeitup-previews/foo.png`.replace(/\\/g, "/");
    const out = formatLastScreenshotLine(baseStatus(pathUnderCwd));
    expect(out).toContain("Last screenshot:");
    expect(out).toContain(pathUnderCwd);
  });

  it("scrubs the line when the path is under an unrelated workspace (cross-workspace leak)", () => {
    // Pick a definitely-unrelated absolute path that cannot be under cwd
    // or any workspace candidate — a sibling that shares no prefix.
    // On Windows `C:\not-a-real-shapeitup-ws-\...`, on POSIX `/not-a-real-ws/...`.
    const stray = process.platform === "win32"
      ? "C:/definitely-not-current-ws-9f2e/shapeitup-previews/leak.png"
      : "/definitely-not-current-ws-9f2e/shapeitup-previews/leak.png";
    const out = formatLastScreenshotLine(baseStatus(stray));
    expect(out).toBe("");
  });

  it("returns empty string when lastScreenshot is missing", () => {
    const status: EngineStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      fileName: "x.shape.ts",
      stats: "",
    };
    expect(formatLastScreenshotLine(status)).toBe("");
  });

  it("scrubs the line when the current response's shape differs from the screenshot's shape", () => {
    // Cross-shape leak: last render was on shape_A, current tool response
    // is for shape_B. Emitting the shape_A PNG footer on the shape_B reply
    // points the agent at the wrong picture. Guard fires even when the
    // path is under cwd and still within the 5-min TTL.
    const cwd = process.cwd();
    const pathUnderCwd = `${cwd}/shapeitup-previews/shape_A.png`.replace(/\\/g, "/");
    const status: EngineStatus = {
      success: true,
      timestamp: new Date().toISOString(),
      fileName: "shape_B.shape.ts",
      stats: "",
      lastScreenshot: {
        path: pathUnderCwd,
        timestamp: Date.now(),
        renderMode: "ai",
        cameraAngle: "iso",
        fileName: "shape_A.shape.ts",
      },
    };
    expect(formatLastScreenshotLine(status)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 + Fix 3 — API-reference docs surface `raw?` on holes.through and the
// Placement shape on patterns. Before: `raw?` was only discoverable via the
// runtime advisory warning; users had to reverse-engineer the Placement
// object by reading the source. These doc bumps are terse but they land the
// parameter in the first-line signature and the Placement shape right after
// the cutAt/spread examples.
// ---------------------------------------------------------------------------

describe("getApiReference — stdlib surface area bumps", () => {
  it("advertises holes.through(size, { …, raw? }) in the signature line", async () => {
    const { getApiReference } = await import("./tools.js");
    const ref = getApiReference("stdlib");
    expect(ref).toMatch(/holes\.through\(size,\s*\{\s*depth\?,\s*fit\?,\s*axis\?,\s*raw\?\s*\}\)/);
    // And the one-line example so agents see the literal-diameter escape hatch.
    expect(ref).toMatch(/holes\.through\(10,\s*\{\s*raw:\s*true\s*\}\)/);
  });

  it("documents the Placement shape after the patterns examples", async () => {
    const { getApiReference } = await import("./tools.js");
    const ref = getApiReference("stdlib");
    expect(ref).toContain("Placement shape");
    // The block names both the required field and the optional rotate/axis.
    expect(ref).toMatch(/translate:\s*\[x,\s*y,\s*z\]/);
    expect(ref).toMatch(/rotate\?/);
    expect(ref).toMatch(/axis\?/);
    // And reminds callers that the factory is nullary.
    expect(ref).toMatch(/factory\s*`?\(\)\s*=>\s*Shape3D`?\s*takes\s*NO\s*args/);
  });
});
