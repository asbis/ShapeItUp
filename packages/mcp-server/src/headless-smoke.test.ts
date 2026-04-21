/**
 * Manual / adhoc smoke test for the headless SVG+resvg render path.
 *
 * Runs a real shape (`examples/stdlib/bearing-block.shape.ts`) end-to-end
 * through executeShapeFile, hands the resulting parts to renderPartsToSvg,
 * rasterizes with svgToPng, and writes the PNG to the OS tmp dir so the
 * caller can `Read` it and eyeball shading quality.
 *
 * Not included in the default vitest run — it's a visual spot-check, not
 * an assertion-based test. Invoke explicitly with:
 *
 *   cd packages/mcp-server && pnpm exec vitest run src/headless-smoke.manual.ts
 *
 * Named `*.manual.ts` so the default vitest glob skips it; then opted back
 * in via the explicit path above.
 */
import { it } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeShapeFile } from "./engine.js";
import { renderPartsToSvg } from "./svg-renderer.js";
import { svgToPng } from "./svg-to-png.js";

it("bearing-block renders a shaded headless PNG", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "siu-smoke-"));
  const shape = resolve(
    __dirname,
    "..",
    "..",
    "..",
    "examples",
    "stdlib",
    "bearing-block.shape.ts",
  );

  const { status, parts } = await executeShapeFile(shape, workDir);
  if (!status.success) {
    throw new Error(`Shape execution failed: ${status.error}`);
  }
  if (!parts || parts.length === 0) {
    throw new Error("Shape returned no parts");
  }

  const { svg, summary } = renderPartsToSvg(parts);
  const svgPath = join(workDir, "bearing-block.svg");
  writeFileSync(svgPath, svg, "utf-8");

  const png = await svgToPng(svg, 1280);
  const pngPath = join(workDir, "bearing-block.png");
  writeFileSync(pngPath, png);

  // eslint-disable-next-line no-console
  console.log(
    `[smoke] parts=${parts.length} summary=${summary}\n[smoke] svg=${svgPath}\n[smoke] png=${pngPath}`,
  );
}, 120_000);
