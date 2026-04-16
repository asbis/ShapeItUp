import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
// Note: no esbuild dependency — this server must be fully self-contained
import { homedir } from "os";

// Path where the extension stores command files for IPC
const GLOBAL_STORAGE = join(
  homedir(),
  process.platform === "win32"
    ? "AppData/Roaming/Code/User/globalStorage/shapeitup.shapeitup-vscode"
    : ".config/Code/User/globalStorage/shapeitup.shapeitup-vscode"
);

let commandCounter = 0;

function sendExtensionCommand(command: string, params: Record<string, any> = {}): boolean {
  try {
    mkdirSync(GLOBAL_STORAGE, { recursive: true });
    const cmdFile = join(GLOBAL_STORAGE, "mcp-command.json");
    // Include unique ID so the extension can dedup file watcher double-fires
    writeFileSync(cmdFile, JSON.stringify({ command, _id: ++commandCounter, ...params }));
    return true;
  } catch {
    return false;
  }
}

function readExtensionResult(): any {
  try {
    const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
    if (existsSync(resultFile)) {
      const data = readFileSync(resultFile, "utf-8");
      return JSON.parse(data);
    }
  } catch {}
  return null;
}

export function registerTools(server: McpServer) {
  server.tool(
    "create_shape",
    "Create a new .shape.ts CAD script file. Fails if file already exists — use modify_shape to update existing files.",
    {
      name: z.string().describe("File name without extension (e.g., 'bracket')"),
      code: z.string().describe("TypeScript source code using Replicad API"),
      directory: z
        .string()
        .optional()
        .describe("Directory to create the file in (defaults to cwd)"),
      overwrite: z.boolean().optional().describe("Set to true to overwrite an existing file (default: false)"),
    },
    async ({ name, code, directory, overwrite }) => {
      const dir = directory || process.cwd();
      const filePath = join(dir, `${name}.shape.ts`);

      if (!code.trim() || !code.includes("function")) {
        return {
          content: [{ type: "text" as const, text: `Invalid code: must contain at least a function definition. Example:\nimport { drawRectangle } from "replicad";\nexport default function main() { return drawRectangle(50,30).sketchOnPlane("XY").extrude(10); }` }],
          isError: true,
        };
      }

      if (existsSync(filePath) && !overwrite) {
        return {
          content: [{ type: "text" as const, text: `File already exists: ${filePath}\nUse modify_shape to update it, or pass overwrite: true to replace it.` }],
          isError: true,
        };
      }

      writeFileSync(filePath, code, "utf-8");

      // Tell VS Code to open and render the file
      sendExtensionCommand("open-shape", { filePath });

      return {
        content: [{ type: "text" as const, text: `${overwrite ? "Overwrote" : "Created"} ${filePath}\nFile is rendering in the viewer. Call get_render_status to check the result.` }],
      };
    }
  );

  server.tool(
    "open_shape",
    "Open an existing .shape.ts file in VS Code and render it in the 3D viewer. Use this to switch the viewer to a different file. Not needed after create_shape or modify_shape (they auto-render).",
    {
      filePath: z.string().describe("Path to the .shape.ts file to open and render"),
    },
    async ({ filePath }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }

      // Clear previous result
      const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
      try { writeFileSync(resultFile, "{}"); } catch {}

      // Send command to extension (it will wait for render and write result)
      sendExtensionCommand("open-shape", { filePath: resolved });

      // Wait for the extension to complete (it blocks up to 8s for render)
      await new Promise((r) => setTimeout(r, 10000));

      // Read back the result
      const result = readExtensionResult();
      const status = result?.renderStatus;

      if (status?.success) {
        const parts = status.partNames?.length ? `\nParts: ${status.partNames.join(", ")}` : "";
        return {
          content: [{ type: "text" as const, text: `Opened in editor and rendered.\nRender SUCCESS\nFile: ${resolved}\nStats: ${status.stats}${parts}${status.boundingBox ? `\nBounding box: ${status.boundingBox.x} x ${status.boundingBox.y} x ${status.boundingBox.z} mm` : ""}` }],
        };
      } else if (status?.error) {
        return {
          content: [{ type: "text" as const, text: `Render FAILED\nFile: ${resolved}\nError: ${status.error}` }],
          isError: true,
        };
      } else {
        return {
          content: [{ type: "text" as const, text: `File opened: ${resolved}\nRender status unknown — the viewer may still be loading. Use get_render_status to check.` }],
        };
      }
    }
  );

  server.tool(
    "modify_shape",
    "Overwrite an existing .shape.ts file with new code",
    {
      filePath: z.string().describe("Path to the .shape.ts file"),
      code: z.string().describe("New TypeScript source code"),
    },
    async ({ filePath, code }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }
      writeFileSync(resolved, code, "utf-8");

      // Tell VS Code to re-render the file
      sendExtensionCommand("open-shape", { filePath: resolved });

      return {
        content: [{ type: "text" as const, text: `Updated ${resolved}\nFile is rendering in the viewer. Call get_render_status to check the result.` }],
      };
    }
  );

  server.tool(
    "read_shape",
    "Read the contents of a .shape.ts file",
    {
      filePath: z.string().describe("Path to the .shape.ts file"),
    },
    async ({ filePath }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }
      const content = readFileSync(resolved, "utf-8");
      return {
        content: [{ type: "text" as const, text: content }],
      };
    }
  );

  server.tool(
    "delete_shape",
    "Delete a .shape.ts file",
    {
      filePath: z.string().describe("Path to the .shape.ts file to delete"),
    },
    async ({ filePath }) => {
      const resolved = resolve(filePath);
      if (!existsSync(resolved)) {
        return {
          content: [{ type: "text" as const, text: `File not found: ${resolved}` }],
          isError: true,
        };
      }
      if (!resolved.endsWith(".shape.ts")) {
        return {
          content: [{ type: "text" as const, text: `Refusing to delete non-.shape.ts file: ${resolved}` }],
          isError: true,
        };
      }
      const { unlinkSync } = require("fs");
      unlinkSync(resolved);
      return {
        content: [{ type: "text" as const, text: `Deleted ${resolved}` }],
      };
    }
  );

  server.tool(
    "export_shape",
    "Export the currently rendered shape to STEP or STL file. Provide outputPath to save directly (no dialog). The shape must be rendered in the viewer first.",
    {
      format: z.enum(["step", "stl"]).describe("Export format: 'step' for CNC/manufacturing, 'stl' for 3D printing"),
      outputPath: z.string().optional().describe("Output file path. If provided, saves directly without a dialog. If omitted, generates a default path next to the shape file."),
    },
    async ({ format, outputPath }) => {
      // If no outputPath, generate one based on the last rendered file
      let savePath = outputPath;
      if (!savePath) {
        const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
        try {
          const status = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (status.fileName) {
            savePath = status.fileName.replace(/\.shape\.ts$/, `.${format}`);
          }
        } catch {}
      }
      if (!savePath) {
        savePath = join(process.cwd(), `export.${format}`);
      }

      // Clear old result
      const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
      try { writeFileSync(resultFile, "{}"); } catch {}

      sendExtensionCommand("export-shape", { format, outputPath: savePath });

      // Wait for export
      await new Promise((r) => setTimeout(r, 5000));

      const result = readExtensionResult();
      if (result?.exportPath && existsSync(result.exportPath)) {
        const fileSize = statSync(result.exportPath).size;
        const sizeStr = fileSize > 1024*1024 ? `${(fileSize/1024/1024).toFixed(1)}MB` : `${Math.round(fileSize/1024)}KB`;
        let sourceInfo = "";
        try {
          const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
          const s = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (s.fileName) sourceInfo = `\nSource: ${s.fileName}`;
        } catch {}
        return {
          content: [{ type: "text" as const, text: `Exported to: ${result.exportPath}\nFormat: ${format.toUpperCase()}\nSize: ${sizeStr}${sourceInfo}` }],
        };
      }
      if (result?.error) {
        return {
          content: [{ type: "text" as const, text: `Export failed: ${result.error}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Export may still be in progress. Check: ${savePath}` }],
      };
    }
  );

  server.tool(
    "list_shapes",
    "Find all .shape.ts files in a directory",
    {
      directory: z
        .string()
        .optional()
        .describe("Directory to search (defaults to cwd)"),
      recursive: z
        .boolean()
        .optional()
        .describe("Search subdirectories recursively (default: true). Set to false for top-level only."),
    },
    async ({ directory, recursive }) => {
      const dir = resolve(directory || process.cwd());
      const depth = recursive === false ? 1 : 3;
      const files = findShapeFiles(dir, depth);
      return {
        content: [
          {
            type: "text" as const,
            text:
              files.length > 0
                ? files.join("\n")
                : "No .shape.ts files found",
          },
        ],
      };
    }
  );

  server.tool(
    "validate_script",
    "Check syntax of a .shape.ts script (syntax only — does not verify imports or runtime behavior). Use get_render_status after create/modify to catch runtime errors.",
    {
      code: z.string().describe("TypeScript source code to validate"),
    },
    async ({ code }) => {
      try {
        // Strip TypeScript and ESM syntax to validate as plain JS
        let stripped = code;
        // Remove import statements entirely
        stripped = stripped.replace(/^import\s+.*$/gm, "");
        // Remove export keywords
        stripped = stripped.replace(/^export\s+(default\s+)?/gm, "");
        // Remove `: typeof X` type annotations (common params pattern)
        stripped = stripped.replace(/:\s*typeof\s+\w+/g, "");
        // Remove `: Type` annotations but not ternary colons or object keys
        stripped = stripped.replace(/(\w|\)|\])\s*:\s*[\w.<>,\s|&\[\]{}]+(?=\s*[,)\n={])/g, "$1");
        // Remove `as Type` casts
        stripped = stripped.replace(/\bas\s+\w+/g, "");
        // Remove interface/type declarations (whole line)
        stripped = stripped.replace(/^(interface|type)\s+\w+[^=].*$/gm, "");
        // Try parsing
        new Function(stripped);
        return {
          content: [{ type: "text" as const, text: "Script syntax looks valid" }],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Syntax error: ${e.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_api_reference",
    "Get Replicad API reference. Call without category to list available categories, or with a category name for detailed docs.",
    {
      category: z
        .enum([
          "overview",
          "drawing",
          "sketching",
          "solids",
          "booleans",
          "modifications",
          "transforms",
          "finders",
          "export",
          "examples",
        ])
        .optional()
        .describe("API category. Omit to see the list of available categories."),
    },
    async ({ category }) => {
      if (!category) {
        return {
          content: [{
            type: "text" as const,
            text: "Available API reference categories:\n- overview (start here)\n- drawing (2D shapes)\n- sketching (2D → 3D)\n- solids (3D operations)\n- booleans (cut, fuse, intersect)\n- modifications (fillet, chamfer, shell)\n- transforms (translate, rotate, mirror)\n- finders (edge/face selection)\n- export (STEP, STL)\n- examples (complete worked examples)\n\nCall get_api_reference with a category name for detailed docs.",
          }],
        };
      }
      const ref = getApiReference(category);
      return {
        content: [{ type: "text" as const, text: ref }],
      };
    }
  );

  // --- AI Review Tools ---

  server.tool(
    "render_preview",
    "Capture a screenshot of the current 3D preview. Returns the file path to a PNG image you can read to verify the shape looks correct. Switches to high-contrast AI render mode with dimensions automatically.",
    {
      showDimensions: z.boolean().optional().describe("Show dimension overlay (default: true)"),
      renderMode: z.enum(["ai", "dark"]).optional().describe("Render mode: 'ai' for high-contrast light background (default), 'dark' for user's dark mode"),
      cameraAngle: z.enum(["isometric", "top", "front", "right", "back", "left"]).optional().describe("Camera angle preset (default: 'isometric')"),
    },
    async ({ showDimensions, renderMode, cameraAngle }) => {
      // Clear old result
      const resultFile = join(GLOBAL_STORAGE, "mcp-result.json");
      try { writeFileSync(resultFile, "{}"); } catch {}

      // Send a single combined command
      sendExtensionCommand("render-preview", {
        renderMode: renderMode || "ai",
        showDimensions: showDimensions !== false,
        cameraAngle: cameraAngle || "isometric",
      });

      // Retry: poll for the screenshot file with increasing delays
      let screenshotPath: string | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 1500));
        const result = readExtensionResult();
        if (result?.screenshotPath && existsSync(result.screenshotPath)) {
          screenshotPath = result.screenshotPath;
          break;
        }
        // Re-send command on retry in case file watcher missed it
        if (attempt > 0) {
          sendExtensionCommand("render-preview", {
            renderMode: renderMode || "ai",
            showDimensions: showDimensions !== false,
            cameraAngle: cameraAngle || "isometric",
          });
        }
      }

      if (screenshotPath) {
        // Read render status to include file info
        const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
        let fileInfo = "";
        try {
          const status = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (status.fileName) fileInfo = `\nFile: ${status.fileName}`;
          if (status.stats) fileInfo += `\nStats: ${status.stats}`;
        } catch {}

        return {
          content: [
            {
              type: "text" as const,
              text: `Screenshot saved to: ${screenshotPath}\nRender mode: ${renderMode || "ai"}, Dimensions: ${showDimensions !== false ? "ON" : "OFF"}, Camera: ${cameraAngle || "isometric"}${fileInfo}\nUse the Read tool to view this image and verify the shape is correct.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: "Could not capture screenshot. Make sure the ShapeItUp viewer is open in VSCode and a shape is loaded.",
          },
        ],
        isError: true,
      };
    }
  );

  server.tool(
    "set_render_mode",
    "Switch the 3D viewer between dark mode (user) and AI mode (high-contrast light background with vivid colors, better for AI analysis)",
    {
      mode: z.enum(["ai", "dark"]).describe("'ai' for high-contrast light mode, 'dark' for normal dark mode"),
    },
    async ({ mode }) => {
      const ok = sendExtensionCommand("set-render-mode", { mode });
      return {
        content: [{ type: "text" as const, text: ok ? `Render mode set to: ${mode}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "toggle_dimensions",
    "Show or hide dimension measurements (bounding box X/Y/Z) on the 3D preview. Useful for verifying sizes are correct.",
    {
      show: z.boolean().describe("true to show dimensions, false to hide"),
    },
    async ({ show }) => {
      const ok = sendExtensionCommand("toggle-dimensions", { show });
      return {
        content: [{ type: "text" as const, text: ok ? `Dimensions: ${show ? "visible" : "hidden"}` : "Failed to send command" }],
        isError: !ok,
      };
    }
  );

  server.tool(
    "get_render_status",
    "Get the result of the last shape render — shows whether it succeeded or failed, with error messages and render stats. Call this after creating or modifying a .shape.ts file to check if it rendered correctly.",
    {},
    async () => {
      const statusFile = join(GLOBAL_STORAGE, "shapeitup-status.json");
      if (!existsSync(statusFile)) {
        return {
          content: [{ type: "text" as const, text: "No render status available. Make sure a .shape.ts file is open in VS Code and the ShapeItUp viewer is active." }],
        };
      }

      try {
        const status = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (status.success) {
          const parts = status.partNames?.length
            ? `\nParts: ${status.partNames.join(", ")}`
            : "";
          return {
            content: [{
              type: "text" as const,
              text: `Render SUCCESS\nFile: ${status.fileName || "unknown"}\nStats: ${status.stats}${parts}${status.boundingBox ? `\nBounding box: ${status.boundingBox.x} x ${status.boundingBox.y} x ${status.boundingBox.z} mm` : ""}\nTime: ${status.timestamp}`,
            }],
          };
        } else {
          return {
            content: [{
              type: "text" as const,
              text: `Render FAILED\nError: ${status.error}\nFile: ${status.fileName || "unknown"}\nTime: ${status.timestamp}`,
            }],
            // Not isError — render failure is an expected state, not a tool error
          };
        }
      } catch {
        return {
          content: [{ type: "text" as const, text: "Could not read render status." }],
          isError: true,
        };
      }
    }
  );
}

function findShapeFiles(dir: string, depth = 3): string[] {
  if (depth <= 0) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isFile() && entry.endsWith(".shape.ts")) {
        results.push(full);
      } else if (stat.isDirectory()) {
        results.push(...findShapeFiles(full, depth - 1));
      }
    }
  } catch {
    // Permission errors etc
  }
  return results;
}

function getApiReference(category: string): string {
  const refs: Record<string, string> = {
    overview: `# ShapeItUp / Replicad API Overview

Files: *.shape.ts — export a default main() returning Shape3D.

PREFERRED pattern (with params for live sliders):
\`\`\`typescript
import { drawRoundedRectangle } from "replicad";

export const params = { width: 80, height: 50, depth: 30 };

export default function main({ width, height, depth }: typeof params) {
  return drawRoundedRectangle(width, height, 5).sketchOnPlane("XY").extrude(depth);
}
\`\`\`

Simple pattern (no sliders):
\`\`\`typescript
import { drawRectangle } from "replicad";
export default function main() {
  return drawRectangle(50, 30).sketchOnPlane("XY").extrude(10);
}
\`\`\`

Multi-part assemblies:
\`\`\`typescript
return [
  { shape: base, name: "base", color: "#8899aa" },
  { shape: bolt, name: "bolt", color: "#aa8855" },
];
\`\`\`

Multi-file imports:
\`\`\`typescript
import { makeBolt } from "./bolt.shape";
\`\`\`

Flow: Drawing (2D) → Sketch (on plane) → Shape3D (extrude/revolve/loft/sweep)
Coordinates: millimeters, X=right, Y=forward, Z=up
Planes: "XY" (top), "XZ" (front), "YZ" (right)

AI workflow: create_shape → render_preview → Read PNG → verify → modify if needed
Use render_preview to self-check your work. It shows dimensions automatically.

Categories: drawing, sketching, solids, booleans, modifications, transforms, finders, export, examples`,

    drawing: `# Drawing API (2D Shapes)

## Factory Functions
- draw(origin?) → DrawingPen (freeform builder)
- drawRectangle(width, height) → Drawing
- drawRoundedRectangle(width, height, radius) → Drawing
- drawCircle(radius) → Drawing
- drawEllipse(majorR, minorR) → Drawing
- drawPolysides(radius, numSides) → Drawing
- drawText(text, { fontSize?, fontFamily? }) → Drawing

## DrawingPen Methods (chainable)
Lines: .lineTo([x,y]), .line(dx,dy), .vLine(d), .hLine(d), .polarLine(d, angle)
Arcs: .sagittaArcTo([x,y], sagitta), .tangentArcTo([x,y]), .threePointsArcTo([x,y], [mx,my])
Curves: .cubicBezierCurveTo([x,y], [cp1x,cp1y], [cp2x,cp2y]), .smoothSplineTo([x,y])
Close: .close() (closed shape), .closeWithMirror(), .done() (open wire)

## 2D Operations
.fuse(other), .cut(other), .intersect(other)
.offset(distance), .translate(dx,dy), .rotate(angle), .mirror(axis)`,

    sketching: `# Sketching (2D → 3D-ready)

## Place a Drawing on a Plane
drawing.sketchOnPlane(plane?, origin?) → Sketch
drawing.sketchOnFace(face, scaleMode?) → Sketch

## Convenience Sketchers
sketchRectangle(w, h, config?) → Sketch
sketchCircle(r, config?) → Sketch

## Sketcher Class (3D pen)
new Sketcher(plane?, origin?) → (same methods as DrawingPen, but in 3D)
  .lineTo([x,y,z]), .line(dx,dy,dz), etc.
  .close() → Sketch ready for extrude/revolve

## Plane Config
{ plane: "XY"|"XZ"|"YZ", origin: [x,y,z] }
Or: "XY", "XZ", "YZ", "-XY", "-XZ", "-YZ"`,

    solids: `# 3D Solid Operations

## From Sketch
sketch.extrude(distance, config?) → Shape3D
  config: { extrusionDirection?, twistAngle? }
sketch.revolve(axis?, config?) → Shape3D
  config: { origin?, angle? } (default 360°)
sketch.loftWith(otherSketch, config?) → Shape3D
  config: { ruled? }
sketch.sweepSketch(profileFn, config?) → Shape3D

## Primitive Solids
makeCylinder(radius, height, location?, direction?) → Shape3D
makeSphere(radius) → Shape3D
makeBox(corner1, corner2) → Shape3D
  e.g. makeBox([0,0,0], [10,20,30])`,

    booleans: `# Boolean Operations

shape.fuse(other) → Shape3D          (union)
shape.cut(tool) → Shape3D            (subtraction)
shape.intersect(other) → Shape3D     (intersection)

Works on both 2D (Drawing) and 3D (Shape3D).
For 2D: fuse2D, cut2D, intersect2D`,

    modifications: `# Shape Modifications

## Fillet (round edges)
shape.fillet(radius, finder?) → Shape3D
  finder: (edge) => edge.inDirection("Z")  (filter which edges)
  Or: number applies to all edges

## Chamfer
shape.chamfer(distance, finder?) → Shape3D

## Shell (hollow out)
shape.shell({ thickness, filter }) → Shape3D
  filter: face finder to remove (e.g., top face)
  e.g. shape.shell({ thickness: 2, filter: f => f.inPlane("XY", 10) })

## Draft (taper walls)
shape.draft(angle, faceFinder, neutralPlane?)

## IMPORTANT: Fillet/Chamfer Best Practices
- Apply fillets BEFORE boolean cuts when possible
- Avoid .fillet(r, e => e.inPlane("XY", z)) after many boolean cuts — tiny edges from cutouts crash OpenCascade
- Prefer .fillet(r, e => e.inDirection("Z")) to select outer vertical edges only
- Use small radii (0.3-0.5mm) on complex geometry, larger (1-3mm) only on simple shapes
- Wrap fillets in try/catch — if it fails, skip or reduce the radius
- If fillet crashes, try: reduce radius, fillet fewer edges, or fillet before cutting holes`,

    transforms: `# Transformations

shape.translate(x, y, z) → Shape3D
shape.translateX(d), .translateY(d), .translateZ(d)
shape.rotate(angleDeg, position?, direction?) → Shape3D
shape.mirror(plane?, origin?) → Shape3D
shape.scale(factor, center?) → Shape3D

All return new shapes (immutable).`,

    finders: `# Finders (selecting faces/edges)

## EdgeFinder
shape.fillet(2, e => e.inDirection("Z"))
  .inDirection(dir)         edges along a direction
  .ofLength(l)              edges of specific length
  .ofCurveType("CIRCLE")    circular edges
  .parallelTo(plane)
  .inPlane(plane, origin?)
  .atDistance(d, point?)
  .containsPoint(pt)

## FaceFinder
shape.shell({ thickness: 2, filter: f => f.inPlane("XY", 10) })
  .inPlane(plane, origin?)
  .parallelTo(plane)
  .ofSurfaceType("PLANE"|"CYLINDER"|"CONE"|"SPHERE")
  .containsPoint(pt)
  .atDistance(d, pt?)

## Combinators
.and(finder), .or(finder), .not(finder)`,

    export: `# Export

Shapes are exported via the VSCode extension:
- Ctrl+Shift+P → "ShapeItUp: Export as STEP"
- Ctrl+Shift+P → "ShapeItUp: Export as STL"

In scripts, just return the shape from main().
The extension handles STEP/STL export from the rendered shape.

Supported formats: STEP (.step), STL (.stl)
STEP preserves exact B-Rep geometry (best for CNC/manufacturing).
STL is mesh-based (best for 3D printing).`,

    examples: `# Example Shape Scripts

## Box with Hole and Fillets
\`\`\`typescript
import { drawRectangle, sketchCircle } from "replicad";

export default function main() {
  let shape = drawRectangle(60, 40).sketchOnPlane("XY").extrude(20);
  shape = shape.fillet(2); // Fillet BEFORE cutting holes
  const hole = sketchCircle(8, { plane: "XY" }).extrude(20);
  return shape.cut(hole);
}
\`\`\`

## L-Bracket with Mounting Holes
\`\`\`typescript
import { draw, makeCylinder } from "replicad";

export default function main() {
  const profile = draw()
    .hLine(60).vLine(5).hLine(-55)
    .vLine(35).hLine(-5).close();

  let bracket = profile.sketchOnPlane("XZ").extrude(30);

  // Mounting holes
  const hole1 = makeCylinder(3, 30, [45, 0, 2.5], [0, 1, 0]);
  const hole2 = makeCylinder(3, 30, [15, 0, 2.5], [0, 1, 0]);
  const hole3 = makeCylinder(3, 30, [2.5, 0, 25], [0, 1, 0]);

  bracket = bracket.cut(hole1).cut(hole2).cut(hole3);
  try { bracket = bracket.fillet(2, e => e.inDirection("Y")); } catch { /* skip fillet if geometry too complex */ }
  return bracket;
}
\`\`\`

## Cylinder with Flange
\`\`\`typescript
import { sketchCircle, drawCircle } from "replicad";

export default function main() {
  const base = sketchCircle(30).extrude(5);
  const tube = sketchCircle(15).extrude(40).translateZ(5);
  let shape = base.fuse(tube).fillet(3); // Fillet BEFORE cutting interior
  const innerHole = sketchCircle(12).extrude(45);
  return shape.cut(innerHole);
}
\`\`\`

## Enclosure with Lid
\`\`\`typescript
import { drawRoundedRectangle } from "replicad";

export default function main() {
  const outer = drawRoundedRectangle(80, 50, 5).sketchOnPlane("XY").extrude(30);
  const inner = drawRoundedRectangle(76, 46, 3)
    .sketchOnPlane("XY", [0, 0, 2])
    .extrude(30);
  return outer.cut(inner);
}
\`\`\``,
  };

  return refs[category] || refs.overview;
}
