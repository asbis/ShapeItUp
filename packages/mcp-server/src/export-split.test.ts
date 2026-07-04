import { describe, it, expect } from "vitest";
import { executeShapeFile, exportLastSplitToDir } from "./engine.js";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end check for the split-export path: each part of a multi-part
// assembly must land in its OWN file inside the target folder (the layout
// that makes 3D printing "one part = one file" convenient).
describe("split export — one file per part", () => {
  const makeDirs = () => ({
    workdir: mkdtempSync(join(tmpdir(), "siu-split-")),
    storage: mkdtempSync(join(tmpdir(), "siu-split-storage-")),
  });

  const writeDuo = (entryPath: string) =>
    writeFileSync(
      entryPath,
      [
        `import { drawRectangle } from "replicad";`,
        `export default function main() {`,
        `  const a = drawRectangle(10, 10).sketchOnPlane("XY").extrude(5);`,
        `  const b = drawRectangle(6, 6).sketchOnPlane("XY").extrude(20);`,
        `  return [`,
        `    { shape: a, name: "base", color: "#8899aa" },`,
        `    { shape: b, name: "post", color: "#aa8855" },`,
        `  ];`,
        `}`,
      ].join("\n"),
    );

  it("writes one STL per part named after each part", async () => {
    const { workdir, storage } = makeDirs();
    try {
      const entryPath = join(workdir, "duo.shape.ts");
      writeDuo(entryPath);

      const exec = await executeShapeFile(entryPath, storage);
      expect(exec.status.success).toBe(true);

      const outDir = join(workdir, "parts");
      const written = await exportLastSplitToDir("stl", outDir);

      expect(written.length).toBe(2);
      const names = readdirSync(outDir).sort();
      expect(names).toEqual(["base.stl", "post.stl"]);

      // Each single-part STL is binary → starts with the 80-byte header +
      // a triangle count, NOT the ASCII "solid" multi-solid marker.
      for (const f of written) {
        const buf = readFileSync(f);
        expect(buf.byteLength).toBeGreaterThan(84);
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("writes one STEP per part", async () => {
    const { workdir, storage } = makeDirs();
    try {
      const entryPath = join(workdir, "duo.shape.ts");
      writeDuo(entryPath);
      await executeShapeFile(entryPath, storage);

      const outDir = join(workdir, "step-parts");
      const written = await exportLastSplitToDir("step", outDir);
      expect(written.length).toBe(2);
      const names = readdirSync(outDir).sort();
      expect(names).toEqual(["base.step", "post.step"]);
      for (const f of written) {
        expect(readFileSync(f, "utf-8")).toContain("ISO-10303-21");
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });

  it("dedupes colliding part names with a numeric suffix", async () => {
    const { workdir, storage } = makeDirs();
    try {
      const entryPath = join(workdir, "dup.shape.ts");
      writeFileSync(
        entryPath,
        [
          `import { drawRectangle } from "replicad";`,
          `export default function main() {`,
          `  const a = drawRectangle(10, 10).sketchOnPlane("XY").extrude(5);`,
          `  const b = drawRectangle(6, 6).sketchOnPlane("XY").extrude(8);`,
          `  return [`,
          `    { shape: a, name: "clip" },`,
          `    { shape: b, name: "clip" },`,
          `  ];`,
          `}`,
        ].join("\n"),
      );
      await executeShapeFile(entryPath, storage);

      const outDir = join(workdir, "dup-parts");
      await exportLastSplitToDir("stl", outDir);
      const names = readdirSync(outDir).sort();
      expect(names).toEqual(["clip.stl", "clip_2.stl"]);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
