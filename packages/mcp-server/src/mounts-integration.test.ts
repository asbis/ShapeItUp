/**
 * Integration test for the new `mounts` stdlib namespace — proves
 * mounts.keyhole / mounts.peg build real OCCT geometry AND that the executor's
 * `import { mounts } from "shapeitup"` rewrite resolves the new namespace.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeShapeFile } from "./engine.js";

describe("mounts stdlib namespace — end-to-end geometry", () => {
  it("builds a backplate with a keyhole stud + anti-rotation peg", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "siu-mounts-"));
    const shapePath = join(workDir, "mount.shape.ts");
    writeFileSync(
      shapePath,
      [
        `import { drawRoundedRectangle } from "replicad";`,
        `import { mounts } from "shapeitup";`,
        `export default function main() {`,
        `  let plate = drawRoundedRectangle(24, 60, 5).sketchOnPlane("XZ").extrude(6);`,
        `  plate = plate.fuse(mounts.keyhole({ largeD: 9, smallD: 4, plateThickness: 2, axis: "+Y" }));`,
        `  plate = plate.fuse(mounts.peg({ holeD: 4, plateThickness: 2, axis: "+Y" }).translate(0, 0, 15));`,
        `  return plate;`,
        `}`,
      ].join("\n"),
      "utf-8",
    );

    const { status, parts } = await executeShapeFile(shapePath, workDir);
    expect(status.success).toBe(true);
    expect(parts && parts.length).toBeGreaterThan(0);
    // Real geometry: the part must have tessellated vertices.
    expect(parts![0].vertices.length).toBeGreaterThan(0);
    // The stud pokes into +Y past the 6 mm plate, so the assembly's Y extent
    // must exceed the bare plate thickness — confirms the stud actually fused.
    const ys: number[] = [];
    const v = parts![0].vertices;
    for (let i = 1; i < v.length; i += 3) ys.push(v[i]);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    expect(ySpan).toBeGreaterThan(6);
  }, 120_000);
});
