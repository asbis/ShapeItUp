/**
 * Tests for the sidecar helpers the viewer hosts use to retire a persisted
 * override once the user commits that parameter to the file.
 *
 * The behaviour that matters is narrowness: a commit says something about ONE
 * parameter, so exactly one pin may disappear.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SIDECAR_FILENAME,
  readSidecar,
  readSidecarParam,
  clearSidecarParam,
  writeSidecar,
} from "./sidecar.js";

let dir: string;
let shape: string;
const sidecarPath = () => join(dir, SIDECAR_FILENAME);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sidecar-"));
  shape = join(dir, "bracket.shape.ts");
  writeFileSync(shape, "export const params = { gussetH: 45 };\n");
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("readSidecar / readSidecarParam", () => {
  it("reads a missing sidecar as empty rather than throwing", () => {
    expect(readSidecar(dir)).toEqual({});
    expect(readSidecarParam(shape, "gussetH")).toBeUndefined();
  });

  it("reads malformed JSON as empty", () => {
    writeFileSync(sidecarPath(), "{ not json");
    expect(readSidecar(dir)).toEqual({});
  });

  it("namespaces by basename so files in one directory coexist", () => {
    writeSidecar(dir, {
      "bracket.shape.ts": { gussetH: 120 },
      "plate.shape.ts": { gussetH: 7 },
    });
    expect(readSidecarParam(shape, "gussetH")).toBe(120);
    expect(readSidecarParam(join(dir, "plate.shape.ts"), "gussetH")).toBe(7);
  });
});

describe("clearSidecarParam", () => {
  it("drops only the named parameter", () => {
    writeSidecar(dir, { "bracket.shape.ts": { gussetH: 120, boltD: 8 } });

    expect(clearSidecarParam(shape, "gussetH")).toBe(true);

    expect(readSidecarParam(shape, "gussetH")).toBeUndefined();
    expect(readSidecarParam(shape, "boltD")).toBe(8);
  });

  it("leaves other files' pins alone", () => {
    writeSidecar(dir, {
      "bracket.shape.ts": { gussetH: 120 },
      "plate.shape.ts": { gussetH: 7 },
    });

    clearSidecarParam(shape, "gussetH");

    expect(readSidecar(dir)).toEqual({ "plate.shape.ts": { gussetH: 7 } });
  });

  it("reports false when there was nothing pinned", () => {
    expect(clearSidecarParam(shape, "gussetH")).toBe(false);
    writeSidecar(dir, { "bracket.shape.ts": { boltD: 8 } });
    expect(clearSidecarParam(shape, "gussetH")).toBe(false);
    expect(readSidecarParam(shape, "boltD")).toBe(8);
  });

  it("removes the file's entry once its last pin goes", () => {
    writeSidecar(dir, {
      "bracket.shape.ts": { gussetH: 120 },
      "plate.shape.ts": { boltD: 3 },
    });

    clearSidecarParam(shape, "gussetH");

    expect(readSidecar(dir)).toEqual({ "plate.shape.ts": { boltD: 3 } });
    expect(existsSync(sidecarPath())).toBe(true);
  });

  it("deletes the sidecar entirely rather than leaving an empty file", () => {
    // An empty `{}` on disk is something a reader has to stop and interpret.
    writeSidecar(dir, { "bracket.shape.ts": { gussetH: 120 } });

    expect(clearSidecarParam(shape, "gussetH")).toBe(true);

    expect(existsSync(sidecarPath())).toBe(false);
  });

  it("survives a sidecar holding unexpected shapes", () => {
    writeFileSync(
      sidecarPath(),
      JSON.stringify({ "bracket.shape.ts": { gussetH: 120, note: "hand-edited" } }, null, 2),
    );

    expect(clearSidecarParam(shape, "gussetH")).toBe(true);
    expect(JSON.parse(readFileSync(sidecarPath(), "utf-8"))).toEqual({
      "bracket.shape.ts": { note: "hand-edited" },
    });
  });
});
