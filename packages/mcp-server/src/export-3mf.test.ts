import { describe, it, expect } from "vitest";
import { executeShapeFile, exportLastToFile } from "./engine.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end check that `format: "3mf"` produces a structurally valid 3MF
// (an OPC/ZIP package) carrying one object per part plus per-part colors —
// the fidelity STL can't express and the reason 3MF is the Bambu/Orca handoff.
describe("3MF export — end-to-end", () => {
  const makeDirs = () => ({
    workdir: mkdtempSync(join(tmpdir(), "siu-3mf-")),
    storage: mkdtempSync(join(tmpdir(), "siu-3mf-storage-")),
  });

  it("writes a valid ZIP package with per-part objects and colors", async () => {
    const { workdir, storage } = makeDirs();
    try {
      const entryPath = join(workdir, "duo.shape.ts");
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

      const exec = await executeShapeFile(entryPath, storage);
      expect(exec.status.success).toBe(true);

      const outPath = join(workdir, "duo.3mf");
      await exportLastToFile("3mf", outPath);

      const buf = readFileSync(outPath);
      // ZIP structural markers: local-file, central-directory, end-of-central.
      expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      expect(buf.includes(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBe(true); // central dir
      const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      expect(eocd).toBeGreaterThan(-1);
      // EOCD total-entries field (offset +10) == 3 package parts.
      expect(buf.readUInt16LE(eocd + 10)).toBe(3);

      // STORE (uncompressed) → the part bytes appear verbatim in the archive.
      const raw = buf.toString("latin1");
      expect(raw).toContain("[Content_Types].xml");
      expect(raw).toContain("3D/3dmodel.model");
      expect(raw).toContain("3dmanufacturing/core/2015/02");
      // Two objects, two build items, two colored base materials.
      expect((raw.match(/<object /g) || []).length).toBe(2);
      expect((raw.match(/<item /g) || []).length).toBe(2);
      expect(raw).toContain('displaycolor="#8899AAFF"');
      expect(raw).toContain('displaycolor="#AA8855FF"');
      expect(raw).toContain("<vertex ");
      expect(raw).toContain("<triangle ");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(storage, { recursive: true, force: true });
    }
  });
});
