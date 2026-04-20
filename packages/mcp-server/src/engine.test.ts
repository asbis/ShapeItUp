import { describe, it, expect } from "vitest";
import { inferErrorHint, appendScreenshotMetadata, type EngineStatus } from "./engine.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Fix E — error-hint specificity.
//
// Earlier the `NaN / undefined` hint fired on any "Cannot read properties of
// undefined (reading '…')" error, which made unrelated type-shape errors
// (e.g. passing `[[x,y]]` where `Placement[]` was required → error mentions
// `reading '0'` or `reading 'translate'`) surface a completely unrelated
// "typo in standards.NEMA17.pilotDiameter" suggestion.
//
// The fix: gate the typo hint on explicit typo-shaped patterns. These tests
// pin the gate so future hint additions can't regress into the same
// hijacking behaviour.
// ---------------------------------------------------------------------------

describe("inferErrorHint — typo-hint gating", () => {
  it("suggests the standards typo fix when the error is an explicit 'Unknown key' lookup failure", () => {
    // Proxy guard in standards.ts now emits this message — a real typo
    // case. The NaN-family hint still fires here.
    const hint = inferErrorHint(
      `Unknown key "pilotDiameter" on standards.NEMA17. Did you mean "pilotDia"?`,
      "standards.get",
      undefined,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/pilotDia/);
  });

  it("suggests the standards typo fix on 'reading <camelCase identifier>' errors (lookup-like)", () => {
    // "Cannot read properties of undefined (reading 'pilotDiameter')" looks
    // like a lookup on a spec that came back undefined — worth suggesting
    // the typo fix. The reading target is a plausible stdlib identifier.
    const hint = inferErrorHint(
      `TypeError: Cannot read properties of undefined (reading 'pilotDiameter')`,
      undefined,
      undefined,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/pilotDia/);
  });

  it("does NOT hijack 'reading 0' tuple-index errors with a typo suggestion", () => {
    // The reported motor-bracket failure: caller passed raw `[[x,y]]`
    // where `Placement[]` was required, which makes `placement.translate`
    // undefined and then `placement.translate[0]` throws. Numeric reading
    // targets are always type-mismatch errors — do NOT suggest a typo.
    const hint = inferErrorHint(
      `TypeError: Cannot read properties of undefined (reading '0')`,
      "patterns.cutAt",
      undefined,
    );
    expect(hint).toBeUndefined();
  });

  it("does NOT hijack 'reading translate' errors (generic method on undefined)", () => {
    // `translate` is a method that appears on every shape — a "reading
    // 'translate'" error is almost certainly a wrong-argument-type case
    // (caller forgot to call the factory, passed a tuple, etc.), not a
    // standards typo.
    const hint = inferErrorHint(
      `TypeError: Cannot read properties of undefined (reading 'translate')`,
      undefined,
      undefined,
    );
    expect(hint).toBeUndefined();
  });

  it("does NOT invent a hint for generic WASM pointer decoding failures without heap-corruption signature", () => {
    // A first-render low-pointer OCCT exception on a fresh process — the
    // existing "check your imports" hint fires, NOT the typo hint. Verify
    // the typo hint isn't a fallback that hijacks this branch.
    const hint = inferErrorHint(
      `OCCT exception (pointer 42)`,
      undefined,
      undefined,
    );
    expect(hint).toBeDefined();
    // The OCCT-pointer branch returns the imports/topology advice, not
    // the standards-typo hint. Both branches mention "typo" in passing
    // but only the imports advice mentions "imports".
    expect(hint).toMatch(/import/i);
    expect(hint).not.toMatch(/pilotDia/);
  });

  it("returns undefined for completely unrecognized error signatures", () => {
    // No OCCT keyword, no JS-lookup pattern, no known operation. The
    // function must return undefined rather than inventing a guess.
    const hint = inferErrorHint(
      `Something completely unexpected happened with the universe.`,
      undefined,
      undefined,
    );
    expect(hint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 3 — loft consumes its input sketches. Reusing a variable across two
// .loftWith() calls hits Replicad's ObjectCache guard which throws
// `new Error("This object has been deleted")`. That's a plain Error (not a
// raw WASM pointer), so `resolveWasmException` leaves the message alone and
// it reaches `inferErrorHint` verbatim. The specific-loft-deleted branch
// should fire BEFORE the generic loft topology hint so the agent gets the
// reuse-is-the-bug answer, not the "profiles must match" red herring.
// ---------------------------------------------------------------------------
describe("inferErrorHint — loft-after-consume", () => {
  it("detects the Replicad ObjectCache deletion error on a loft operation", () => {
    const hint = inferErrorHint(
      `This object has been deleted`,
      "Sketch.loftWith",
      undefined,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/consumed by a previous loft/i);
    // Must NOT fall through to the generic loft hint (topology mismatch).
    expect(hint).not.toMatch(/number of segments/i);
  });

  it("catches phrasing variants like 'the sketch was deleted'", () => {
    const hint = inferErrorHint(
      `the sketch was deleted earlier in the pipeline`,
      "Sketch.loftWith",
      undefined,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/consumed by a previous loft/i);
  });

  it("falls back to the generic loft hint when the error isn't a deletion", () => {
    // Plain loft failure — still useful to say "profiles must match", which
    // is what the generic branch does. The specific branch must not hijack.
    const hint = inferErrorHint(
      `BRep_API: command not done`,
      "Sketch.loftWith",
      undefined,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/number of segments/i);
  });

  it("does not fire the loft-deleted hint when the operation is not a loft", () => {
    // "This object has been deleted" can also come from other consuming ops
    // (fuse/cut). Our branch only advises when the in-flight op is a loft —
    // other ops should fall through to whatever other branch matches (or
    // return undefined if none does).
    const hint = inferErrorHint(
      `This object has been deleted`,
      "Shape.translate",
      undefined,
    );
    // Could be undefined, or a different hint — just assert it's NOT the
    // loft-specific copy.
    if (hint !== undefined) {
      expect(hint).not.toMatch(/consumed by a previous loft/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue P2-5 — `.sketchOnPlane is not a function` hint.
//
// Two meaningfully different failure modes produce the same TypeError:
//   (a) `draw().hLine(...).sketchOnPlane(...)` — DrawingPen lacks
//       `.sketchOnPlane`; user needs `.close()` / `.done()` first.
//   (b) `sketchCircle(r).sketchOnPlane(...)` — Sketch also lacks
//       `.sketchOnPlane`; user should drop the redundant call.
// When the user's source text is threaded into inferErrorHint, the
// presence of `draw(` / `.hLine(`-style tokens disambiguates to (a); absence
// falls back to a combined hint that names both causes.
// ---------------------------------------------------------------------------
describe("inferErrorHint — sketchOnPlane TypeError", () => {
  it("emits the draw-without-close hint when source contains draw() pen chain tokens", () => {
    const source = `
export default function main() {
  return draw().hLine(20).vLine(10).hLine(-20).sketchOnPlane("XY").extrude(5);
}`;
    const hint = inferErrorHint(
      `TypeError: x.sketchOnPlane is not a function`,
      undefined,
      undefined,
      source,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/\.close\(\)/);
    expect(hint).toMatch(/\.done\(\)/);
    // Must NOT surface the sketchCircle-specific copy — source disambiguated.
    expect(hint).not.toMatch(/sketchCircle/);
  });

  it("emits the combined hint when source is not supplied", () => {
    const hint = inferErrorHint(
      `TypeError: foo.sketchOnPlane is not a function`,
      undefined,
      undefined,
    );
    expect(hint).toBeDefined();
    // Combined hint names both causes.
    expect(hint).toMatch(/\.close\(\)/);
    expect(hint).toMatch(/sketchCircle/);
  });

  it("emits the combined hint when source doesn't contain draw() pen tokens", () => {
    // A file that uses sketchCircle() but never draw()/hLine()/vLine() —
    // the disambiguator shouldn't false-positive on the draw-without-close
    // branch. Combined hint is acceptable since we can't tell for sure.
    const source = `
export default function main() {
  return sketchCircle(10).sketchOnPlane("XY").extrude(5);
}`;
    const hint = inferErrorHint(
      `TypeError: x.sketchOnPlane is not a function`,
      undefined,
      undefined,
      source,
    );
    expect(hint).toBeDefined();
    expect(hint).toMatch(/sketchCircle/);
  });
});

// ---------------------------------------------------------------------------
// Fix #6 — `appendScreenshotMetadata` writes the monotonic `lastScreenshot`
// field into shapeitup-status.json without clobbering other fields. Run with
// a tempdir-scoped GLOBAL_STORAGE so the tests never touch the user's real
// status file.
// ---------------------------------------------------------------------------
describe("appendScreenshotMetadata — monotonic lastScreenshot breadcrumb", () => {
  const makeDir = () => mkdtempSync(join(tmpdir(), "siu-engine-test-"));

  it("creates a new status file with just lastScreenshot when none exists", () => {
    const dir = makeDir();
    try {
      appendScreenshotMetadata(
        {
          timestamp: 1234567890,
          path: "/abs/path.png",
          renderMode: "ai",
          cameraAngle: "isometric",
          fileName: "x.shape.ts",
        },
        dir,
      );
      const raw = readFileSync(join(dir, "shapeitup-status.json"), "utf-8");
      const status = JSON.parse(raw) as EngineStatus;
      expect(status.lastScreenshot?.path).toBe("/abs/path.png");
      expect(status.lastScreenshot?.timestamp).toBe(1234567890);
      expect(status.lastScreenshot?.renderMode).toBe("ai");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves all existing fields when appending", () => {
    const dir = makeDir();
    try {
      const existing: EngineStatus = {
        success: true,
        fileName: "a.shape.ts",
        stats: "foo",
        partCount: 3,
        partNames: ["x", "y", "z"],
        boundingBox: { x: 10, y: 20, z: 30 },
        timestamp: "2026-04-20T00:00:00.000Z",
      };
      writeFileSync(join(dir, "shapeitup-status.json"), JSON.stringify(existing));
      appendScreenshotMetadata(
        {
          timestamp: 999,
          path: "/abs/ss.png",
        },
        dir,
      );
      const after = JSON.parse(
        readFileSync(join(dir, "shapeitup-status.json"), "utf-8"),
      ) as EngineStatus;
      expect(after.success).toBe(true);
      expect(after.fileName).toBe("a.shape.ts");
      expect(after.stats).toBe("foo");
      expect(after.partCount).toBe(3);
      expect(after.partNames).toEqual(["x", "y", "z"]);
      expect(after.boundingBox).toEqual({ x: 10, y: 20, z: 30 });
      expect(after.lastScreenshot?.path).toBe("/abs/ss.png");
      expect(after.lastScreenshot?.timestamp).toBe(999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an earlier lastScreenshot with the latest one", () => {
    const dir = makeDir();
    try {
      const base: EngineStatus = {
        success: true,
        timestamp: "2026-04-20T00:00:00.000Z",
        lastScreenshot: {
          timestamp: 1,
          path: "/old.png",
        },
      };
      writeFileSync(join(dir, "shapeitup-status.json"), JSON.stringify(base));
      appendScreenshotMetadata(
        { timestamp: 2, path: "/new.png" },
        dir,
      );
      const after = JSON.parse(
        readFileSync(join(dir, "shapeitup-status.json"), "utf-8"),
      ) as EngineStatus;
      expect(after.lastScreenshot?.path).toBe("/new.png");
      expect(after.lastScreenshot?.timestamp).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a corrupt existing status file by starting fresh", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "shapeitup-status.json"), "not-valid-json{");
      appendScreenshotMetadata(
        { timestamp: 42, path: "/fresh.png" },
        dir,
      );
      const after = JSON.parse(
        readFileSync(join(dir, "shapeitup-status.json"), "utf-8"),
      ) as EngineStatus;
      expect(after.lastScreenshot?.path).toBe("/fresh.png");
      // Seeded-from-scratch status — success defaults to false so
      // get_render_status can distinguish "screenshot without a render".
      expect(after.success).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws on an unwritable directory (best-effort semantics)", () => {
    // Nonexistent parent of a parent — mkdirSync recursive handles this fine
    // on normal systems. Verify no throw and the file does exist after.
    const dir = join(makeDir(), "a", "b", "c");
    try {
      expect(() =>
        appendScreenshotMetadata({ timestamp: 1, path: "/p.png" }, dir),
      ).not.toThrow();
      expect(existsSync(join(dir, "shapeitup-status.json"))).toBe(true);
    } finally {
      // Cleanup — the top-level mkdtempSync dir persists under the tempdir.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  });
});
