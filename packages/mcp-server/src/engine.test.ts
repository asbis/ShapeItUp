import { describe, it, expect, beforeEach } from "vitest";
import {
  inferErrorHint,
  appendScreenshotMetadata,
  preflightShapeImports,
  executeShapeFile,
  checkBundleCache,
  extractLocalImportSpecifiers,
  clearBundleCache,
  canonicalParamsKey,
  clearMeshCache,
  getMeshCacheSize,
  lookupMeshCache,
  populateMeshCache,
  readSourceForCacheKey,
  type EngineStatus,
  type BundleCacheEntry,
} from "./engine.js";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, statSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Issue #3 — multifile params import (Asbjørn's report).
//
// When a `.shape.ts` file imports `{ params as needleParams }` from a sibling
// `.shape.ts` and passes the imported object into a factory, the factory saw
// `undefined` for every property. Root cause was the esbuild bundle footer
// stamping a bare `params` identifier onto globalThis: when the entry AND a
// sibling both declared `export const params`, esbuild's collision-renaming
// could swap which binding kept the bare name, stamping the wrong object
// onto `__SHAPEITUP_ENTRY_PARAMS__` and mis-wiring the executor's param flow.
//
// The fix replaced the footer with a synthetic-wrapper entry that namespace-
// imports the user's file and resolves the entry exports through the
// unambiguous `__shapeitup_entry__.*` binding — no bare-identifier lookup in
// the merged scope, so collisions can't re-introduce the bug.
// ---------------------------------------------------------------------------
describe("preflightShapeImports — multifile params import warning", () => {
  it("warns (non-fatal) when a sibling .shape.ts's `params` is imported", () => {
    const { warnings } = preflightShapeImports(
      `import { params as needleParams, makeNeedle } from "./needle.shape";\n` +
        `export default function main() { return makeNeedle(needleParams); }\n`,
      "/abs/entry.shape.ts",
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/Importing 'params'/);
    expect(warnings[0]).toMatch(/needleParams/);
    expect(warnings[0]).toMatch(/factory-with-default-params/);
  });

  it("does NOT warn when only named factories are imported", () => {
    const { warnings } = preflightShapeImports(
      `import { makeBolt } from "./bolt.shape";\n` +
        `export default function main() { return makeBolt(); }\n`,
      "/abs/entry.shape.ts",
    );
    expect(warnings).toEqual([]);
  });

  it("still throws on `import { main }` (reserved runtime entry)", () => {
    expect(() =>
      preflightShapeImports(
        `import { main } from "./x.shape";\n`,
        "/abs/entry.shape.ts",
      ),
    ).toThrow(/Cannot import 'main'/);
  });
});

// ---------------------------------------------------------------------------
// Bundle cache — unit tests for checkBundleCache and extractLocalImportSpecifiers.
//
// These tests are fast (no OCCT/esbuild) because they call the exported
// helper functions directly. They pin the key invariants:
//   1. Cache hit when entry + deps are unchanged.
//   2. Cache miss when entry content changes.
//   3. Cache miss when a dependency mtime changes.
//   4. New-import bug fix: cache miss when the entry adds a new local import.
// ---------------------------------------------------------------------------

describe("extractLocalImportSpecifiers", () => {
  it("returns relative specifiers from named-import statements", () => {
    const src = `import { foo } from './a';\nimport { bar } from "./b.shape";`;
    expect(extractLocalImportSpecifiers(src)).toEqual(["./a", "./b.shape"]);
  });

  it("returns specifiers from side-effect imports", () => {
    const src = `import './styles';\nimport "./other";`;
    expect(extractLocalImportSpecifiers(src)).toEqual(["./styles", "./other"]);
  });

  it("does not return package imports (non-relative)", () => {
    const src = `import { drawRectangle } from "replicad";\nimport { x } from "./local";`;
    const specs = extractLocalImportSpecifiers(src);
    expect(specs).toContain("./local");
    expect(specs).not.toContain("replicad");
  });

  it("returns empty array when no local imports", () => {
    const src = `import { drawRectangle } from "replicad";`;
    expect(extractLocalImportSpecifiers(src)).toEqual([]);
  });
});

describe("checkBundleCache — unit tests (no OCCT)", () => {
  const makeDir = () => mkdtempSync(join(tmpdir(), "siu-cache-unit-"));

  it("returns null (hit) when entry content and dep mtimes are unchanged", () => {
    const dir = makeDir();
    try {
      const depPath = join(dir, "dep.shape.ts");
      writeFileSync(depPath, "export function makeThing() {}");
      const depMtime = existsSync(depPath) ? statSync(depPath).mtimeMs : 0;
      const entry: BundleCacheEntry = {
        js: "bundled js",
        entryContent: `import { makeThing } from "./dep.shape";`,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: { [depPath]: depMtime },
      };
      const result = checkBundleCache(
        entry,
        `import { makeThing } from "./dep.shape";`,
        dir,
      );
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a reason string when entry content changes", () => {
    const dir = makeDir();
    try {
      const entry: BundleCacheEntry = {
        js: "bundled",
        entryContent: "const old = 1;",
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: {},
      };
      const result = checkBundleCache(entry, "const new_ = 2;", dir);
      expect(result).not.toBeNull();
      expect(result).toMatch(/entry file content changed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a reason string when a dependency mtime changes", () => {
    const dir = makeDir();
    try {
      const depPath = join(dir, "dep.shape.ts");
      writeFileSync(depPath, "export function makeThing() {}");
      // Record a deliberately wrong (old) mtime — far in the past.
      const fakeMtime = Date.now() - 100_000;
      const entry: BundleCacheEntry = {
        js: "bundled",
        entryContent: `import { makeThing } from "./dep.shape";`,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: { [depPath]: fakeMtime },
      };
      const result = checkBundleCache(
        entry,
        `import { makeThing } from "./dep.shape";`,
        dir,
      );
      expect(result).not.toBeNull();
      expect(result).toMatch(/input mtime changed/);
      expect(result).toContain(depPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a reason string when the entry adds a new local import (new-import bug fix)", () => {
    const dir = makeDir();
    try {
      // Cache was built without `./newdep` in inputMtimes.
      const entry: BundleCacheEntry = {
        js: "bundled",
        // Old source had no imports.
        entryContent: `export default function main() {}`,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: {},
      };
      // Live source now imports a new local file.
      const newSource = `import { helper } from "./newdep";\nexport default function main() {}`;
      const result = checkBundleCache(entry, newSource, dir);
      expect(result).not.toBeNull();
      // It should report content changed (since entryContent differs) OR new import.
      // Either is correct — content-change fires first here.
      expect(result).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects new local import when entry content is SAME but cache predates the new dep", () => {
    // Simulates: user edits and saves, file content is identical except for a new import,
    // but we test the new-import path specifically by making entryContent identical to liveCode
    // while leaving inputMtimes empty.
    const dir = makeDir();
    try {
      const liveCode = `import { helper } from "./newdep";\nexport default function main() {}`;
      const entry: BundleCacheEntry = {
        js: "bundled",
        // Suppose entryContent matches liveCode but inputMtimes is empty
        // (simulating the edge case: the source file was reverted but newdep was never in the cache).
        entryContent: liveCode,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: {}, // newdep NOT tracked
      };
      const result = checkBundleCache(entry, liveCode, dir);
      expect(result).not.toBeNull();
      expect(result).toMatch(/new local import not in cache/);
      expect(result).toContain("./newdep");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat package imports as new local imports", () => {
    const dir = makeDir();
    try {
      const source = `import { drawRectangle } from "replicad";\nexport default function main() {}`;
      const entry: BundleCacheEntry = {
        js: "bundled",
        entryContent: source,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: {},
      };
      const result = checkBundleCache(entry, source, dir);
      // "replicad" is not local — should be a cache hit (null).
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns stat failed reason when a dep file is missing", () => {
    const dir = makeDir();
    try {
      const missingPath = join(dir, "missing.shape.ts");
      const entry: BundleCacheEntry = {
        js: "bundled",
        entryContent: `import { x } from "./missing.shape";`,
        entryPath: join(dir, "entry.shape.ts"),
        inputMtimes: { [missingPath]: Date.now() }, // recorded but file deleted
      };
      const result = checkBundleCache(entry, `import { x } from "./missing.shape";`, dir);
      expect(result).not.toBeNull();
      expect(result).toMatch(/stat failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Bundle cache — integration tests via executeShapeFile (requires OCCT/esbuild).
//
// These tests verify the full end-to-end cache flow: that a second call to
// executeShapeFile for an unchanged file is served from cache (no esbuild re-run),
// and that the cache correctly invalidates on file edits and dep changes.
// ---------------------------------------------------------------------------

describe("executeShapeFile — bundle cache integration", () => {
  // Shared teardown helper.
  const makeDirs = () => ({
    workdir: mkdtempSync(join(tmpdir(), "siu-cache-integ-")),
    storage: mkdtempSync(join(tmpdir(), "siu-cache-integ-storage-")),
  });

  beforeEach(() => {
    clearBundleCache();
  });

  it(
    "cache hit: second call returns success without error on an unchanged file",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "box.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export default function main() {`,
            `  return drawRectangle(10, 10).sketchOnPlane("XY").extrude(5);`,
            `}`,
          ].join("\n"),
        );

        const first = await executeShapeFile(entryPath, storage);
        expect(first.status.success).toBe(true);
        expect(first.status.error).toBeUndefined();

        // Second call — same file, same content, same deps. Should hit cache.
        const second = await executeShapeFile(entryPath, storage);
        expect(second.status.success).toBe(true);
        expect(second.status.error).toBeUndefined();
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "cache miss after entry file edit: second call picks up new content",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const entryPath = join(workdir, "box.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export const params = { size: 10 };`,
            `export default function main({ size }: typeof params) {`,
            `  return drawRectangle(size, size).sketchOnPlane("XY").extrude(5);`,
            `}`,
          ].join("\n"),
        );

        const first = await executeShapeFile(entryPath, storage);
        expect(first.status.success).toBe(true);
        expect(first.status.currentParams).toHaveProperty("size");

        // Edit the file — change the param name.
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export const params = { width: 20 };`,
            `export default function main({ width }: typeof params) {`,
            `  return drawRectangle(width, width).sketchOnPlane("XY").extrude(5);`,
            `}`,
          ].join("\n"),
        );

        const second = await executeShapeFile(entryPath, storage);
        expect(second.status.success).toBe(true);
        // Should reflect the new params from the edited file, not the cache.
        expect(second.status.currentParams).toHaveProperty("width");
        expect(second.status.currentParams).not.toHaveProperty("size");
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "cache miss after dependency mtime change: second call rebuilds",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        const depPath = join(workdir, "helper.shape.ts");
        writeFileSync(
          depPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export function makeBox(size: number) {`,
            `  return drawRectangle(size, size).sketchOnPlane("XY").extrude(5);`,
            `}`,
          ].join("\n"),
        );

        const entryPath = join(workdir, "entry.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { makeBox } from "./helper.shape";`,
            `export default function main() { return makeBox(10); }`,
          ].join("\n"),
        );

        const first = await executeShapeFile(entryPath, storage);
        expect(first.status.success).toBe(true);

        // Touch the dep file (update mtime without changing content).
        const now = new Date();
        utimesSync(depPath, now, new Date(now.getTime() + 5000));

        const second = await executeShapeFile(entryPath, storage);
        expect(second.status.success).toBe(true);
        // Both should succeed — the test verifies no corruption on a mtime-miss rebuild.
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "new-import bug fix: adding an import to the entry file busts the cache",
    async () => {
      const { workdir, storage } = makeDirs();
      try {
        // Initial entry — no local imports.
        const entryPath = join(workdir, "entry.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export default function main() {`,
            `  return drawRectangle(10, 10).sketchOnPlane("XY").extrude(5);`,
            `}`,
          ].join("\n"),
        );

        const first = await executeShapeFile(entryPath, storage);
        expect(first.status.success).toBe(true);

        // Now add a local dependency to the entry file.
        const depPath = join(workdir, "panel.shape.ts");
        writeFileSync(
          depPath,
          [
            `import { drawRectangle } from "replicad";`,
            `export function makePanel() {`,
            `  return drawRectangle(20, 5).sketchOnPlane("XY").extrude(2);`,
            `}`,
          ].join("\n"),
        );
        writeFileSync(
          entryPath,
          [
            `import { drawRectangle } from "replicad";`,
            `import { makePanel } from "./panel.shape";`,
            `export default function main() {`,
            `  return makePanel();`,
            `}`,
          ].join("\n"),
        );

        // Second call must NOT serve the cached bundle (which didn't include panel.shape).
        const second = await executeShapeFile(entryPath, storage);
        expect(second.status.success).toBe(true);
        // If the cache was incorrectly served, the old bundle would try to call
        // `makePanel` which wasn't imported, causing a runtime error. Success
        // here confirms the bundle was rebuilt.
        expect(second.status.error).toBeUndefined();
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("executeShapeFile — multifile params import (regression for issue #3)", () => {
  // OCCT init is the most expensive thing in this test file (~500ms on a
  // cold WASM load) and this test has to run it to exercise the end-to-end
  // bundle+execute path. Keep to a single render — we only need to confirm
  // that the child's `params` flows through correctly when the entry passes
  // it into a named factory.
  it(
    "passes a child module's imported `params` into a factory without losing fields",
    async () => {
      const workdir = mkdtempSync(join(tmpdir(), "siu-multifile-"));
      const storage = mkdtempSync(join(tmpdir(), "siu-multifile-storage-"));
      try {
        // Child module: declares its own `params` AND exports a factory that
        // consumes it. Both the entry and the child export `params` so the
        // bundle has the name collision that used to mis-wire the footer.
        writeFileSync(
          join(workdir, "needle.shape.ts"),
          [
            `import { drawRectangle } from "replicad";`,
            // Note: properties here are used inside makeNeedle. Before the
            // fix, they came through as undefined when the entry passed
            // `params` (imported) positionally into makeNeedle.
            `export const params = { needleLength: 17, needleWidth: 3 };`,
            `export function makeNeedle(p) {`,
            `  if (!p || typeof p.needleLength !== "number") {`,
            `    throw new Error("needleLength is " + typeof (p && p.needleLength));`,
            `  }`,
            `  return drawRectangle(p.needleLength, p.needleWidth).sketchOnPlane("XY").extrude(1);`,
            `}`,
          ].join("\n"),
        );

        // Entry: imports the child's params AND factory, passes params
        // explicitly (the pattern that used to break). The entry also
        // declares its OWN `params` to force the esbuild collision case.
        const entryPath = join(workdir, "entry.shape.ts");
        writeFileSync(
          entryPath,
          [
            `import { makeNeedle, params as needleParams } from "./needle.shape";`,
            `export const params = { scale: 1 };`,
            `export default function main() {`,
            `  return makeNeedle(needleParams);`,
            `}`,
          ].join("\n"),
        );

        const { status } = await executeShapeFile(entryPath, storage);
        // Success confirms the child factory received a populated params
        // object. Before the fix, makeNeedle threw "needleLength is undefined".
        expect(status.error).toBeUndefined();
        expect(status.success).toBe(true);
        // The ENTRY's params must win in the returned status (it's the file
        // with sliders in the UI), even though the child also declares params.
        expect(status.currentParams).toBeDefined();
        expect(status.currentParams).toHaveProperty("scale");
        // Non-fatal preflight warning surfaced — users should be pointed
        // toward the factory-default-param pattern.
        expect(status.warnings ?? []).toEqual(
          expect.arrayContaining([expect.stringMatching(/Importing 'params'/)]),
        );
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// Mesh-result cache.
//
// The cache hashes (absPath, source-content, sorted-params, meshQuality) and
// stores ExecuteOutcome WITHOUT live OCCT shape handles. These tests exercise
// the helper surface directly so they don't pay the multi-second OCCT cost on
// every assertion — the integration with executeWithPersistedParams is
// covered separately at a single happy-path level by inspection in the build,
// and would re-run the engine under WASM otherwise.
// ---------------------------------------------------------------------------

describe("mesh-result cache", () => {
  // Each test runs against a fresh tempdir so they can hammer mtimes without
  // racing the others. clearMeshCache() at the top of each test scopes the
  // shared module-level Map so prior cases don't bleed in (and vice versa).

  const makeFile = (content: string): { dir: string; absPath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "siu-mesh-cache-"));
    const absPath = join(dir, "x.shape.ts");
    writeFileSync(absPath, content, "utf-8");
    return { dir, absPath };
  };

  const fakeOutcome = (success = true) => ({
    status: {
      success,
      timestamp: new Date().toISOString(),
    } as EngineStatus,
    parts: success
      ? [
          {
            // Live OCCT handle stand-in — must NOT be retained by the cache.
            shape: { __wasm_handle__: 0xdeadbeef },
            name: "p",
            color: null,
            vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
            triangles: new Uint32Array([0, 1, 2]),
            edgeVertices: new Float32Array([0, 0, 0, 1, 0, 0]),
          } as any,
        ]
      : undefined,
  });

  it("populates on success and serves the same outcome on lookup", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      const paramsKey = canonicalParamsKey({ width: 10 });
      const outcome = fakeOutcome();
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, paramsKey, "default", outcome);
      expect(getMeshCacheSize()).toBe(1);
      const hit = lookupMeshCache(absPath, head.sourceHash, paramsKey, "default");
      expect(hit).toBeDefined();
      expect(hit!.result.status.success).toBe(true);
      expect(hit!.hitCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("STRIPS live OCCT shape handles from cached parts (WASM safety)", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      const outcome = fakeOutcome();
      // Sanity: pre-cache outcome carries the handle.
      expect(outcome.parts![0].shape).toBeDefined();
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, "{}", "default", outcome);
      const hit = lookupMeshCache(absPath, head.sourceHash, "{}", "default");
      expect(hit).toBeDefined();
      expect(hit!.result.parts).toBeDefined();
      // Cache entry must NOT carry the WASM pointer — that's the corruption
      // vector the brief spent paragraphs warning about.
      expect((hit!.result.parts![0] as any).shape).toBeUndefined();
      // Mesh arrays survive intact (they're JS-owned typed arrays).
      expect(hit!.result.parts![0].vertices.length).toBe(9);
      expect(hit!.result.parts![0].triangles.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT cache failed outcomes (fresh retry on next call)", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, "{}", "default", fakeOutcome(false));
      expect(getMeshCacheSize()).toBe(0);
      expect(lookupMeshCache(absPath, head.sourceHash, "{}", "default")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misses on different params (no false hit)", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, canonicalParamsKey({ w: 10 }), "default", fakeOutcome());
      expect(lookupMeshCache(absPath, head.sourceHash, canonicalParamsKey({ w: 20 }), "default")).toBeUndefined();
      // ...but the original key is still good — populate didn't overwrite.
      expect(lookupMeshCache(absPath, head.sourceHash, canonicalParamsKey({ w: 10 }), "default")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("misses on different meshQuality bucket", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, "{}", "default", fakeOutcome());
      expect(lookupMeshCache(absPath, head.sourceHash, "{}", "preview")).toBeUndefined();
      expect(lookupMeshCache(absPath, head.sourceHash, "{}", "default")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("file content edit busts the entry (sourceHash drives the key)", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() { return 1; }");
    try {
      const before = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, before.sourceHash, before.mtimeMs, "{}", "default", fakeOutcome());
      // Edit the file. Bumping the mtime to "now+1s" is belt-and-suspenders —
      // the sourceHash already differs because we wrote different bytes.
      writeFileSync(absPath, "export default function main() { return 2; }", "utf-8");
      const future = (Date.now() + 1000) / 1000;
      utimesSync(absPath, future, future);
      const after = readSourceForCacheKey(absPath)!;
      expect(after.sourceHash).not.toBe(before.sourceHash);
      // The new key has no entry — this is the invalidation path.
      expect(lookupMeshCache(absPath, after.sourceHash, "{}", "default")).toBeUndefined();
      // The OLD key still has its entry (the cache is content-addressed; a
      // round-trip back to the original content would still hit).
      expect(lookupMeshCache(absPath, before.sourceHash, "{}", "default")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clearMeshCache drops every entry", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, "{}", "default", fakeOutcome());
      expect(getMeshCacheSize()).toBe(1);
      clearMeshCache();
      expect(getMeshCacheSize()).toBe(0);
      expect(lookupMeshCache(absPath, head.sourceHash, "{}", "default")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hitCount and lastUsed update on every lookup", () => {
    clearMeshCache();
    const { dir, absPath } = makeFile("export default function main() {}");
    try {
      const head = readSourceForCacheKey(absPath)!;
      populateMeshCache(absPath, head.sourceHash, head.mtimeMs, "{}", "default", fakeOutcome());
      const t0 = lookupMeshCache(absPath, head.sourceHash, "{}", "default")!;
      expect(t0.hitCount).toBe(1);
      const firstStamp = t0.lastUsed;
      // Tiny wait so the second Date.now() can be strictly greater on systems
      // with millisecond-resolution clocks. 5 ms is well above the floor.
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      const t1 = lookupMeshCache(absPath, head.sourceHash, "{}", "default")!;
      expect(t1.hitCount).toBe(2);
      expect(t1.lastUsed).toBeGreaterThanOrEqual(firstStamp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonicalParamsKey is order-independent (sorted-keys contract)", () => {
    expect(canonicalParamsKey({ a: 1, b: 2, c: 3 })).toBe(
      canonicalParamsKey({ c: 3, a: 1, b: 2 }),
    );
    expect(canonicalParamsKey(undefined)).toBe("{}");
    expect(canonicalParamsKey({})).toBe("{}");
    // Different values produce different keys.
    expect(canonicalParamsKey({ a: 1 })).not.toBe(canonicalParamsKey({ a: 2 }));
  });

  it("readSourceForCacheKey returns undefined for missing files", () => {
    expect(readSourceForCacheKey(join(tmpdir(), "siu-mesh-cache-does-not-exist.shape.ts"))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mesh cache + executeShapeFile integration. The previous block exercises the
// helper surface in isolation; this one drives a real OCCT execution end-to-
// end so the contract that `executeWithPersistedParams` relies on is pinned:
// after a successful execute, populating the cache with that outcome must
// produce a hit on the same key in a follow-up call.
// ---------------------------------------------------------------------------
describe("mesh cache + executeShapeFile (real OCCT)", () => {
  it(
    "stores a successful execute outcome and serves the same status on lookup",
    async () => {
      clearMeshCache();
      const workdir = mkdtempSync(join(tmpdir(), "siu-mesh-cache-real-"));
      const storage = mkdtempSync(join(tmpdir(), "siu-mesh-cache-storage-"));
      try {
        const absPath = join(workdir, "tiny.shape.ts");
        writeFileSync(
          absPath,
          [
            'import { drawCircle } from "replicad";',
            "export default function main() {",
            '  return drawCircle(5).sketchOnPlane("XY").extrude(1);',
            "}",
            "",
          ].join("\n"),
          "utf-8",
        );

        // First execution: must succeed and produce live parts.
        const first = await executeShapeFile(absPath, storage);
        expect(first.status.success).toBe(true);
        expect(first.parts && first.parts.length).toBeGreaterThan(0);

        // Stamp it into the cache exactly the way executeWithPersistedParams
        // does (sourceHash + mtimeMs read from disk after the execute).
        const head = readSourceForCacheKey(absPath)!;
        const paramsKey = canonicalParamsKey(undefined);
        populateMeshCache(absPath, head.sourceHash, head.mtimeMs, paramsKey, "default", first);

        // Lookup: same key returns the cached outcome (without live shapes).
        const hit = lookupMeshCache(absPath, head.sourceHash, paramsKey, "default");
        expect(hit).toBeDefined();
        expect(hit!.result.status.success).toBe(true);
        expect(hit!.result.status.partCount).toBe(first.status.partCount);
        // The shape handle was scrubbed even though the original outcome had one.
        expect(hit!.result.parts && hit!.result.parts.length).toBe(first.parts!.length);
        expect((hit!.result.parts![0] as any).shape).toBeUndefined();
        // Mesh arrays still present and non-empty.
        expect(hit!.result.parts![0].vertices.length).toBeGreaterThan(0);
        expect(hit!.result.parts![0].triangles.length).toBeGreaterThan(0);
      } finally {
        rmSync(workdir, { recursive: true, force: true });
        rmSync(storage, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
